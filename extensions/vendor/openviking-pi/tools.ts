import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import type { OVClient } from "./client.js";
import type { SyncManager } from "./sync.js";
// [QCR PATCH 4]
import { buildWriteRequest } from "./qcr-write.js";
// [QCR PATCH 5]
import { namespaceNote, ownNamespaceName, routeNamespace } from "./qcr-namespaces.js";

/** [QCR PATCH 5] One memory namespace the tools can address: a name the model
 * uses and the client holding that namespace's USER key. */
export interface ToolNamespace {
  name: string;
  client: OVClient;
}

export interface RegisterToolsOptions {
  /** [QCR PATCH 2] A pi-subagents leaf gets the READ tools only. A lens pass
   * evaluates a diff; authoring memory is the shepherd session's job, and a
   * leaf has no session identity to author under. */
  leaf?: boolean;
  /** [QCR PATCH 5] Every namespace this pi can reach, INDEX 0 = its own
   * identity (the default, and the client `_sync`/recall use). Omitted — the
   * single-key case, i.e. every review session — is the pre-patch behaviour:
   * one namespace, no `namespace` parameter in any schema, unprefixed answers. */
  namespaces?: ToolNamespace[];
}

export function registerTools(
  pi: any,
  client: OVClient,
  _sync?: SyncManager,
  opts: RegisterToolsOptions = {},
): void {
  const leaf = opts.leaf === true;

  // [QCR PATCH 5] A LEAF IS SINGLE-NAMESPACE, STRUCTURALLY. PATCH 2 stops all
  // ambient work in a leaf and PATCH 4 withholds the write tool there; a second
  // client must not become a way around either, so namespaces handed to a leaf
  // are discarded here rather than trusted. (index.ts does not build them for a
  // leaf in the first place — this is the second layer, same discipline as
  // qcr-leaf.ts.)
  const own: ToolNamespace = { name: ownNamespaceName(client.cfg.user), client };
  const spaces: ToolNamespace[] =
    leaf || !opts.namespaces || opts.namespaces.length === 0 ? [own] : opts.namespaces;
  const names = spaces.map((s) => s.name);
  const multi = spaces.length > 1;
  /** Appended to every namespace-aware description; empty when single. */
  const nsNote = namespaceNote(names);
  /** The `namespace` parameter exists ONLY when there is a choice to make. */
  const nsParam: Record<string, unknown> = multi
    ? { namespace: Type.Optional(StringEnum(names)) }
    : {};
  const nsGuidelines: string[] = multi
    ? [`Memory lives in ${names.length} separate trees (${names.join(", ")}); say which one you mean and read the prefix on the answer.`]
    : [];
  /** Every answer names the tree it came from — the model must never have to
   * infer which memory it just touched. */
  const scoped = (ns: ToolNamespace, text: string) => (multi ? `[${ns.name}] ${text}` : text);
  /** Route one call, or explain why it cannot be routed. */
  const pick = (params: any): { ok: true; ns: ToolNamespace } | { ok: false; error: string } => {
    const routed = routeNamespace(params ?? {}, names);
    if (!routed.ok) return { ok: false, error: routed.error };
    return { ok: true, ns: spaces.find((s) => s.name.toLowerCase() === routed.namespace) ?? own };
  };

  // --- viking_search ---
  pi.registerTool({
    name: "viking_search",
    label: "Viking Search",
    description: "Semantic search over the OpenViking knowledge base. Returns ranked results with viking:// URIs and abstracts. Use to recall past decisions, user preferences, or project-specific knowledge not in current context." + nsNote,
    promptSnippet: "Search OpenViking for past decisions, preferences, and project knowledge",
    promptGuidelines: [
      "Use viking_search when you need information from previous sessions not in MEMORY.md.",
      "Use viking_search before making decisions that might conflict with past decisions.",
      ...nsGuidelines,
    ],
    parameters: Type.Object({
      query: Type.String({ description: "Search query" }),
      scope: Type.Optional(Type.String({ description: "Viking URI prefix to scope search (e.g., 'viking://user/memories/')" })),
      limit: Type.Optional(Type.Number({ description: "Max results (default: 10)" })),
      ...nsParam,
    }),
    async execute(
      _id: string, params: any, _signal: AbortSignal,
      _onUpdate: any, _ctx: any,
    ) {
      // [QCR PATCH 5] `scope` carries the URI here, so it routes too.
      const routed = pick(params);
      if (!routed.ok) return { content: [{ type: "text", text: routed.error }] };
      const ns = routed.ns;
      if (!ns.client.connected) {
        return { content: [{ type: "text", text: scoped(ns, "OpenViking server is not reachable.") }] };
      }
      const results = await ns.client.find(params.query, {
        targetUri: params.scope,
        topK: params.limit ?? 10,
      });
      if (results.length === 0) {
        return { content: [{ type: "text", text: scoped(ns, "No results found.") }] };
      }
      const maxChars = ns.client.cfg.recallMaxContentChars;
      const lines = results.map(r => {
        const abs = r.abstract.length > maxChars
          ? r.abstract.slice(0, maxChars) + "..."
          : r.abstract;
        return `[${r.score.toFixed(2)}] ${r.uri}\n  ${abs}`; }
      );
      return {
        content: [{ type: "text", text: scoped(ns, lines.join("\n\n")) }],
        details: multi ? { namespace: ns.name, results } : { results },
      };
    },
  });

  // --- viking_read ---
  pi.registerTool({
    name: "viking_read",
    label: "Viking Read",
    description: "Read content at a viking:// URI. Three detail levels: 'abstract' (~100 tokens), 'overview' (~2k tokens), 'full' (complete). Start with abstract, escalate when needed." + nsNote,
    promptSnippet: "Read OpenViking content at a viking:// URI with tiered detail levels",
    ...(multi ? { promptGuidelines: nsGuidelines } : {}),
    parameters: Type.Object({
      uri: Type.String({ description: "viking:// URI to read" }),
      level: StringEnum(["abstract", "overview", "full"] as const),
      ...nsParam,
    }),
    async execute(
      _id: string, params: any, _signal: AbortSignal,
      _onUpdate: any, _ctx: any,
    ) {
      const routed = pick(params);
      if (!routed.ok) return { content: [{ type: "text", text: routed.error }] };
      const ns = routed.ns;
      if (!ns.client.connected) {
        return { content: [{ type: "text", text: scoped(ns, "OpenViking server is not reachable.") }] };
      }
      let content: string | null = null;
      switch (params.level) {
        case "abstract": content = await ns.client.abstract(params.uri); break;
        case "overview": content = await ns.client.overview(params.uri); break;
        case "full":     content = await ns.client.readContent(params.uri); break;
      }
      if (!content) {
        return { content: [{ type: "text", text: scoped(ns, `No content at ${params.uri}`) }] };
      }
      return {
        content: [{ type: "text", text: scoped(ns, content) }],
        ...(multi ? { details: { namespace: ns.name } } : {}),
      };
    },
  });

  // --- viking_browse ---
  pi.registerTool({
    name: "viking_browse",
    label: "Viking Browse",
    description: "Browse the OpenViking knowledge store like a filesystem. List directory contents or get metadata." + nsNote,
    promptSnippet: "Browse the viking:// directory tree in OpenViking",
    ...(multi ? { promptGuidelines: nsGuidelines } : {}),
    parameters: Type.Object({
      action: StringEnum(["list", "stat"] as const),
      uri: Type.Optional(Type.String({ description: "viking:// URI (default: 'viking://')" })),
      ...nsParam,
    }),
    async execute(
      _id: string, params: any, _signal: AbortSignal,
      _onUpdate: any, _ctx: any,
    ) {
      const routed = pick(params);
      if (!routed.ok) return { content: [{ type: "text", text: routed.error }] };
      const ns = routed.ns;
      if (!ns.client.connected) {
        return { content: [{ type: "text", text: scoped(ns, "OpenViking server is not reachable.") }] };
      }
      const uri = params.uri ?? "viking://";
      if (params.action === "stat") {
        const info = await ns.client.stat(uri);
        if (!info) return { content: [{ type: "text", text: scoped(ns, `Not found: ${uri}`) }] };
        return { content: [{ type: "text", text: scoped(ns, JSON.stringify(info, null, 2)) }] };
      }
      // list
      const entries = await ns.client.ls(uri);
      if (entries.length === 0) {
        return { content: [{ type: "text", text: scoped(ns, `Empty directory: ${uri}`) }] };
      }
      const lines = entries.map(e => `${e.isDir ? "📁" : "📄"} ${e.name}`);
      return { content: [{ type: "text", text: scoped(ns, lines.join("\n")) }] };
    },
  });

  // [QCR PATCH 4] THREE UPSTREAM WRITE TOOLS ARE DELETED HERE.
  //
  // `viking_remember` — NOT a write. It appended `[Remember — <category>] …`
  //   as a session message and relied on commit-time extraction to promote it,
  //   i.e. on a `vlm` we deliberately do not configure. Verified on a running
  //   v0.4.15: nothing durable is produced (findings §3.2). It is replaced by
  //   `viking_write` below, not merely removed.
  // `viking_forget` — deleted a memory by URI, or by a >0.8 search match.
  //   Curation belongs to the EOD sweep and the TUI; retire is a tag+directory
  //   convention, not an rm. A fuzzy-matched delete from a review session is a
  //   silent data-loss path.
  // `viking_add_resource` — fetched an arbitrary URL into the store. The
  //   reviewer READS code and CI results; it does not ingest the web
  //   (scoping rule 2), and this would be an unreviewed egress path.
  //
  // `viking_write` is therefore the ONLY write tool a session can reach.
  if (!leaf) {
    pi.registerTool({
      name: "viking_write",
      label: "Viking Write",
      description:
        "Durably write a memory file to OpenViking (content/batch-write). Use this — not a session message — for anything that must survive the session: review lessons, project gotchas, decisions. mode 'create' fails if the file exists; mode 'replace' requires expect_hash and fails if the file changed since you read it. Returns the hash of what it wrote." + nsNote,
      promptSnippet: "Durably write a memory file to OpenViking",
      promptGuidelines: [
        "Write one self-contained fact or lesson per file; a memory read months later has no conversation around it.",
        "Prefer mode 'create' with a fresh filename. Only 'replace' an entry you just read, passing its hash as expect_hash.",
        "A 409 means someone else edited the file — re-read it and decide, never retry blindly.",
        ...nsGuidelines,
      ],
      parameters: Type.Object({
        uri: Type.String({ description: "Target viking:// URI, ending in .md (e.g. 'viking://user/reviewer/memories/experiences/pr-5312-migration.md')" }),
        content: Type.String({ description: "Markdown body of the memory" }),
        tags: Type.Optional(Type.Array(Type.String(), { description: "Convention tags without '#', e.g. ['pinned','review-ops']" })),
        mode: Type.Optional(StringEnum(["create", "replace"] as const)),
        expect_hash: Type.Optional(Type.String({ description: "Required for mode 'replace': sha256 of the CURRENT stored bytes" })),
        wait: Type.Optional(Type.Boolean({ description: "Block until the search index is refreshed (slow — costs ~1.6 core-seconds). Default false; the bytes are durable either way." })),
        ...nsParam,
      }),
      async execute(
        _id: string, params: any, _signal: AbortSignal,
        _onUpdate: any, _ctx: any,
      ) {
        // [QCR PATCH 5] Route BEFORE building the request: a write under the
        // wrong key is the one mistake here that is both silent and durable.
        const routed = pick(params);
        if (!routed.ok) {
          return { content: [{ type: "text", text: `${routed.error} Nothing was written.` }], details: { written: false } };
        }
        const ns = routed.ns;
        if (!ns.client.connected) {
          return { content: [{ type: "text", text: scoped(ns, "OpenViking server is not reachable — nothing was written.") }] };
        }
        const built = buildWriteRequest(params ?? {});
        if (!built.ok) {
          return { content: [{ type: "text", text: built.error }], details: { written: false } };
        }

        const res = await ns.client.batchWrite(built.request);
        if (!res.ok) {
          const message = res.error?.message || `HTTP ${res.status ?? 0}`;
          const conflict = res.status === 409;
          return {
            content: [{
              type: "text",
              text: scoped(ns, conflict
                ? `Write REFUSED (409): ${message} Nothing was written. Re-read ${built.request.operations[0]?.uri} and decide on the current content.`
                : `Write failed: ${message} Nothing was written.`),
            }],
            details: multi
              ? { namespace: ns.name, written: false, status: res.status, conflict }
              : { written: false, status: res.status, conflict },
          };
        }

        const result = res.result;
        const uri = built.request.operations[0]?.uri ?? "";
        const outcome = (result?.created ?? []).includes(uri)
          ? "created"
          : (result?.updated ?? []).includes(uri)
            ? "updated"
            : (result?.unchanged ?? []).includes(uri)
              ? "unchanged (byte-identical)"
              : "written";
        // Best effort, deliberately after the durable write and never fatal:
        // the tags are already in the body text.
        const tagged = built.tags.length > 0 ? await ns.client.setTags(uri, built.tags) : true;
        const details = { written: true, uri, outcome, hash: built.hash, tags: built.tags, tagged, result };
        return {
          content: [{
            type: "text",
            text: scoped(ns,
              `${uri} ${outcome}. hash=${built.hash}` +
              (built.tags.length > 0
                ? ` tags=${built.tags.map((t) => `#${t}`).join(" ")}${tagged ? "" : " (body only — the retrieval tag list was not updated)"}`
                : "") +
              " Pass that hash as expect_hash to replace this entry later."),
          }],
          details: multi ? { namespace: ns.name, ...details } : details,
        };
      },
    });
  }

  // --- viking_archive_expand ---
  // [QCR PATCH 5] Deliberately NOT namespace-aware: it expands a SESSION
  // archive (`viking://session/<id>`), and sessions belong to the identity this
  // pi authenticates as. Another user's sessions are not memory this fork
  // offers to browse, and PATCH 3 already says the daemon owns session
  // lifecycle. It keeps the primary client, unchanged.
  pi.registerTool({
    name: "viking_archive_expand",
    label: "Viking Archive Expand",
    description: "Expand an archived session back into raw messages. Use when the archive summary is too coarse and you need detailed conversation history.",
    promptSnippet: "Expand an archived session to see raw conversation messages",
    parameters: Type.Object({
      archive_id: Type.Optional(Type.String({ description: "Archive ID to expand" })),
      session_id: Type.Optional(Type.String({ description: "OV session ID to expand" })),
    }),
    async execute(
      _id: string, params: any, _signal: AbortSignal,
      _onUpdate: any, _ctx: any,
    ) {
      if (!client.connected) {
        return { content: [{ type: "text", text: "OpenViking server is not reachable." }] };
      }
      const sid = params.session_id ?? params.archive_id;
      if (!sid) {
        return { content: [{ type: "text", text: "Provide session_id or archive_id." }] };
      }
      // Read the session's overview — sessions are at viking://session/{sid}
      const uri = `viking://session/${sid}`;
      const content = await client.overview(uri);
      if (!content) {
        // Try reading the history subdirectory
        const history = await client.overview(`${uri}/history`);
        if (!history) {
          return { content: [{ type: "text", text: `Archive not found: ${sid}` }] };
        }
        return { content: [{ type: "text", text: history }] };
      }
      return { content: [{ type: "text", text: content }] };
    },
  });
}
