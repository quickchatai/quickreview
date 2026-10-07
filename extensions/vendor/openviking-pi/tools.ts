import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import type { OVClient } from "./client.js";
import type { SyncManager } from "./sync.js";
// [QCR PATCH 4] (the batch builder and its router are [QCR PATCH 6])
import { buildBatchWriteRequest, routeWrite } from "./qcr-write.js";
// [QCR PATCH 6]
import { failureText, isNotFound, isPreconditionConflict } from "./qcr-honest.js";
// [QCR PATCH 5]
import { namespaceNote, ownNamespaceName, routeNamespace } from "./qcr-namespaces.js";
// [QCR PATCH 10]
import { LESSON_KINDS } from "./qcr-lesson.js";
// [QCR PATCH 9]
import {
  browsableInScope,
  DEFAULT_ROUND_AREAS,
  readableInScope,
  scopeRefusal,
} from "./qcr-hint.js";
// [QCR PATCH 11]
import { scopedFindTargets, scopedWriteRefusal } from "./qcr-hint.js";

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
  /** [QCR PATCH 9] The memory areas the tools may reach, asked per call (a
   * PR session: the round's areas — qcr-hint.ts `toolScopeAreas`); null or
   * omitted = unscoped, as upstream (the overseer, the companion). */
  areas?: () => readonly string[] | null;
}

export function registerTools(
  pi: any,
  client: OVClient,
  _sync?: SyncManager,
  opts: RegisterToolsOptions = {},
): void {
  const leaf = opts.leaf === true;
  // [QCR PATCH 9] Asked per call, so a hint published after the tools were
  // registered binds the next call. A failing provider holds the tools to the
  // round's areas rather than letting them loose.
  const scopeAreas = (): readonly string[] | null => {
    if (!opts.areas) return null;
    try {
      return opts.areas();
    } catch {
      return DEFAULT_ROUND_AREAS;
    }
  };

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
  /** Route one call, or explain why it cannot be routed. [QCR PATCH 6] The
   * write tool passes its own router: a batch routes by its entries. */
  const pick = (
    params: any,
    route: (p: any, n: readonly string[]) => ReturnType<typeof routeNamespace> = routeNamespace,
  ): { ok: true; ns: ToolNamespace } | { ok: false; error: string } => {
    const routed = route(params ?? {}, names);
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
      // [QCR PATCH 9] A PR session searches inside the round's areas only.
      const areas = scopeAreas();
      if (areas && typeof params.scope === "string" && params.scope.trim() !== "" && !browsableInScope(params.scope, areas)) {
        return {
          content: [{ type: "text", text: scoped(ns, `Search refused: ${scopeRefusal(params.scope, areas)}`) }],
          details: { error: true, refused: true },
        };
      }
      // [QCR PATCH 11] …and asks the server for the top K INSIDE them (a
      // `target_uri` list), never a global top K filtered afterwards — the
      // finding cases outnumber the lessons ten to one.
      const res = await ns.client.find(params.query, {
        targetUri: areas ? scopedFindTargets(areas, params.scope) : params.scope,
        topK: params.limit ?? 10,
      });
      // [QCR PATCH 6] A failure is said as one — never "No results found".
      if (!res.ok) {
        return {
          content: [{ type: "text", text: scoped(ns, failureText(res, "searched")) }],
          details: multi
            ? { namespace: ns.name, error: true, status: res.status }
            : { error: true, status: res.status },
        };
      }
      // [QCR PATCH 9] …and keeps only the hits inside them.
      const results = areas
        ? (res.result ?? []).filter((r) => readableInScope(r.uri, areas))
        : (res.result ?? []);
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
      // [QCR PATCH 9] A PR session reads inside the round's areas only.
      const areas = scopeAreas();
      if (areas && !readableInScope(params.uri, areas)) {
        return {
          content: [{ type: "text", text: scoped(ns, `Read refused: ${scopeRefusal(String(params.uri), areas)}`) }],
          details: { error: true, refused: true },
        };
      }
      // [QCR PATCH 6] One envelope-returning read: "No content" only when the
      // server said the path is not there (or holds nothing) — a refused key
      // or a dead server is named as such.
      const level = params.level === "abstract" || params.level === "overview" ? params.level : "full";
      const res = await ns.client.readLevel(params.uri, level);
      if (!res.ok && !isNotFound(res)) {
        return {
          content: [{ type: "text", text: scoped(ns, failureText(res, "read")) }],
          details: multi
            ? { namespace: ns.name, error: true, status: res.status }
            : { error: true, status: res.status },
        };
      }
      const content = res.ok && typeof res.result === "string" ? res.result : "";
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
      // [QCR PATCH 9] …and lists nothing inside another area.
      const areas = scopeAreas();
      if (areas && !browsableInScope(uri, areas)) {
        return {
          content: [{ type: "text", text: scoped(ns, `Browse refused: ${scopeRefusal(String(uri), areas)}`) }],
        };
      }
      if (params.action === "stat") {
        // [QCR PATCH 6] "Not found" only when it is not found.
        const st = await ns.client.statResponse(uri);
        if (!st.ok && !isNotFound(st)) {
          return { content: [{ type: "text", text: scoped(ns, failureText(st, "listed")) }] };
        }
        const info = st.ok ? st.result : null;
        if (!info) return { content: [{ type: "text", text: scoped(ns, `Not found: ${uri}`) }] };
        return { content: [{ type: "text", text: scoped(ns, JSON.stringify(info, null, 2)) }] };
      }
      // list
      // [QCR PATCH 6] "Empty directory" only when it IS empty (or absent).
      const listed = await ns.client.lsResponse(uri);
      if (!listed.ok && !isNotFound(listed)) {
        return { content: [{ type: "text", text: scoped(ns, failureText(listed, "listed")) }] };
      }
      const entries = listed.ok ? (listed.result ?? []) : [];
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
    // [QCR PATCH 10] A curated lesson's header, as structured fields: the
    // tool renders `#lesson kind=… lens=… class=… paths=… evidence=…` from
    // them (qcr-lesson.ts) and refuses an unknown lens id.
    const lessonParam = Type.Object({
      kind: StringEnum(LESSON_KINDS),
      lens: Type.Array(Type.String(), { description: "Built lens ids the lesson is for, e.g. ['pass-baseline','pass-validate']" }),
      class: Type.String({ description: "Class slug the lesson covers, e.g. 'baseline.pre-existing-scope' — reuse a candidate's class" }),
      paths: Type.Array(Type.String(), { description: "Path globs it applies to; ['**'] for the whole repo" }),
      evidence: Type.Array(Type.String(), { description: "Refs: pr:<n>, comment:<id>, case:<name>, commit:<sha>, cand:c<id>" }),
    }, { description: "A typed lesson (experiences/ only): the tool writes the header line from these fields" });
    pi.registerTool({
      name: "viking_write",
      label: "Viking Write",
      description:
        "Durably write memory files to OpenViking (content/batch-write). Use this — not a session message — for anything that must survive the session: review lessons, project gotchas, decisions. One entry: `uri` + `content`. Several (a day's lessons): `entries`, written as ONE batch that lands whole or not at all. mode 'create' fails if the file exists; mode 'replace' requires expect_hash and fails if the file changed since you read it. Returns the hash of what it wrote." + nsNote,
      promptSnippet: "Durably write memory files to OpenViking",
      promptGuidelines: [
        "Write one self-contained fact or lesson per file; a memory read months later has no conversation around it.",
        "Several entries at once go in ONE call as `entries` — never as parallel calls into the same directory.",
        "Prefer mode 'create' with a fresh filename. Only 'replace' an entry you just read, passing its hash as expect_hash.",
        "A 409 REFUSED means the file changed (or already exists) — re-read it and decide, never retry blindly. A busy directory is retried for you; if it stays busy, try again in a minute.",
        // [QCR PATCH 10]
        "A curated lesson (experiences/) goes with `lesson: {kind, lens, class, paths, evidence}` — the tool writes its header line; `content` is the lesson's prose only. Cite the learner candidate a lesson adopts as `cand:c<id>` in evidence.",
        ...nsGuidelines,
      ],
      parameters: Type.Object({
        uri: Type.Optional(Type.String({ description: "Target viking:// URI, ending in .md (e.g. 'viking://user/reviewer/memories/experiences/pr-5312-migration.md'). With `content`, for ONE entry." })),
        content: Type.Optional(Type.String({ description: "Markdown body of the memory (one entry)" })),
        tags: Type.Optional(Type.Array(Type.String(), { description: "Convention tags without '#', e.g. ['pinned','review-ops']" })),
        mode: Type.Optional(StringEnum(["create", "replace"] as const)),
        expect_hash: Type.Optional(Type.String({ description: "Required for mode 'replace': sha256 of the CURRENT stored bytes" })),
        // [QCR PATCH 10] a typed lesson — the header is rendered from this.
        lesson: Type.Optional(lessonParam),
        // [QCR PATCH 6] several entries, one batch-write under one root.
        entries: Type.Optional(Type.Array(
          Type.Object({
            uri: Type.String({ description: "Target viking:// URI, ending in .md" }),
            content: Type.String({ description: "Markdown body of the memory" }),
            tags: Type.Optional(Type.Array(Type.String())),
            mode: Type.Optional(StringEnum(["create", "replace"] as const)),
            expect_hash: Type.Optional(Type.String()),
            // [QCR PATCH 10]
            lesson: Type.Optional(lessonParam),
          }),
          { description: "Several entries written as ONE batch (instead of uri + content). They must share a directory; the batch lands whole or not at all." },
        )),
        wait: Type.Optional(Type.Boolean({ description: "Block until the search index is refreshed (slow — costs ~1.6 core-seconds). Default false; the bytes are durable either way." })),
        ...nsParam,
      }),
      async execute(
        _id: string, params: any, _signal: AbortSignal,
        _onUpdate: any, _ctx: any,
      ) {
        // [QCR PATCH 5] Route BEFORE building the request: a write under the
        // wrong key is the one mistake here that is both silent and durable.
        // [QCR PATCH 6] A batch routes by its entries' own addresses, every
        // one by the single-write rule, and may not straddle trees.
        const routed = pick(params, routeWrite);
        if (!routed.ok) {
          return { content: [{ type: "text", text: `${routed.error} Nothing was written.` }], details: { written: false } };
        }
        const ns = routed.ns;
        if (!ns.client.connected) {
          return { content: [{ type: "text", text: scoped(ns, "OpenViking server is not reachable — nothing was written.") }] };
        }
        const built = buildBatchWriteRequest(params ?? {});
        if (!built.ok) {
          return { content: [{ type: "text", text: built.error }], details: { written: false } };
        }
        // [QCR PATCH 11] A review session (scoped) writes no lesson, no
        // pinned or owner entry, and no case.
        const writeAreas = scopeAreas();
        const writeRefused = writeAreas ? scopedWriteRefusal(built.entries.map((e) => e.uri)) : null;
        if (writeRefused) {
          return {
            content: [{ type: "text", text: scoped(ns, writeRefused) }],
            details: { written: false, refused: true },
          };
        }

        const res = await ns.client.batchWrite(built.request);
        if (!res.ok) {
          // [QCR PATCH 6] Only a PRECONDITION 409 is "someone edited this";
          // a busy directory was retried (and named as busy if it stayed so),
          // and a refused key is named as the outage it is.
          const conflict = isPreconditionConflict(res);
          const message = res.error?.message || `HTTP ${res.status ?? 0}`;
          return {
            content: [{
              type: "text",
              text: scoped(ns, conflict
                ? `Write REFUSED (409): ${message} Nothing was written. Re-read ${built.entries.map((e) => e.uri).join(", ")} and decide on the current content.`
                : failureText(res, "written")),
            }],
            details: multi
              ? { namespace: ns.name, written: false, status: res.status, conflict, busy: res.stillBusy }
              : { written: false, status: res.status, conflict, busy: res.stillBusy },
          };
        }

        const result = res.result;
        const lines: string[] = [];
        const written: Array<Record<string, unknown>> = [];
        for (const entry of built.entries) {
          const outcome = (result?.created ?? []).includes(entry.uri)
            ? "created"
            : (result?.updated ?? []).includes(entry.uri)
              ? "updated"
              : (result?.unchanged ?? []).includes(entry.uri)
                ? "unchanged (byte-identical)"
                : "written";
          // Best effort, deliberately after the durable write and never fatal:
          // the tags are already in the body text.
          const tagged = entry.tags.length > 0 ? await ns.client.setTags(entry.uri, entry.tags) : true;
          written.push({ uri: entry.uri, outcome, hash: entry.hash, tags: entry.tags, tagged });
          lines.push(
            `${entry.uri} ${outcome}. hash=${entry.hash}` +
              (entry.tags.length > 0
                ? ` tags=${entry.tags.map((t) => `#${t}`).join(" ")}${tagged ? "" : " (body only — the retrieval tag list was not updated)"}`
                : ""),
          );
        }
        const single = built.entries.length === 1 ? written[0]! : null;
        const details = single
          ? { written: true, ...single, result, busyRetries: res.busyRetries }
          : { written: true, entries: written, result, busyRetries: res.busyRetries };
        return {
          content: [{
            type: "text",
            text: scoped(ns,
              lines.join("\n") +
              (built.entries.length === 1
                ? " Pass that hash as expect_hash to replace this entry later."
                : "\nPass an entry's hash as expect_hash to replace it later.")),
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
