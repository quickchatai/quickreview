// The vendored OpenViking pi extension — provenance + the five
// patches. Two kinds of assertion live here on purpose:
//
//   * BEHAVIOUR, wherever the fork's own code can be imported. `qcr-leaf.ts`,
//     `qcr-write.ts`, `qcr-namespaces.ts`, `config.ts`, `sync.ts` and
//     `client.ts` are all reachable from vitest
//     (they import only node builtins and plain .mjs siblings), so those
//     patches are tested, not just grepped. `tools.ts` and `index.ts` are NOT
//     importable — they pull `typebox`, `@earendil-works/pi-ai` and
//     `@earendil-works/pi-coding-agent`, none of which is installed in this
//     repo (pi lives only in the container).
//   * STRUCTURE, for the two unimportable files and for every deletion. A
//     deletion cannot be tested by calling it; the test is that the thing is
//     absent. These are the assertions a careless rebase trips over — which is
//     exactly their job.
//
// A failure here means the fork drifted, not that the test is stale. Read
// extensions/vendor/openviking-pi/README.md before "fixing" anything.
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse as parseToml } from "smol-toml";
import { isLeafProcess, LEAF_ARGV_FLAGS } from "../extensions/vendor/openviking-pi/qcr-leaf.js";
import { withoutRootKey } from "../extensions/vendor/openviking-pi/config.js";
import {
  namespaceNote,
  namespaceOfUri,
  ownNamespaceName,
  resolveExtraNamespaces,
  routeNamespace,
  REVIEWER_KEY_ENV,
  REVIEWER_USER_ENV,
} from "../extensions/vendor/openviking-pi/qcr-namespaces.js";
import {
  buildWriteRequest,
  normalizeHash,
  normalizeTags,
  parentUri,
  renderMemoryBody,
  sha256Prefixed,
} from "../extensions/vendor/openviking-pi/qcr-write.js";
import { SyncManager } from "../extensions/vendor/openviking-pi/sync.js";
import { OVClient } from "../extensions/vendor/openviking-pi/client.js";

const ROOT = join(import.meta.dirname, "..");
const FORK = join(ROOT, "extensions", "vendor", "openviking-pi");
const read = (p: string) => readFileSync(join(FORK, p), "utf8");
/** Source with comments stripped. Every patch leaves a tombstone comment that
 * QUOTES what it removed — grepping the raw file for the removed code would
 * always hit the explanation of its removal. */
const code = (p: string) =>
  read(p)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
const upstream = JSON.parse(read("upstream.json")) as {
  commit: string;
  tag: string;
  patches: string[];
};

describe("provenance and licence", () => {
  it("pins one upstream commit, spelled the same everywhere", () => {
    expect(upstream.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(read("NOTICE")).toContain(upstream.commit);
    expect(read("README.md")).toContain(upstream.commit);
  });

  it("agrees with config.toml [openviking]", () => {
    // Deliberately the LIVE config.toml (rule 7): this is one leg of the
    // extension-commit double mirror, so it must read what deploys — a pin
    // check, not an identity check; operator identity edits stay green.
    // LIVE config where present; config.example.toml (identical pin block by
    // construction) stands in inside the assembled public snapshot.
    const configPath = existsSync(join(ROOT, "config.toml"))
      ? join(ROOT, "config.toml")
      : join(ROOT, "config.example.toml");
    const cfg = parseToml(readFileSync(configPath, "utf8")) as any;
    const ov = cfg.openviking ?? {};
    // The server version and the fork's base commit move together — the
    // extension is part of the same pinned artefact.
    expect(`v${ov.version}`).toBe(upstream.tag);
    // `extension_commit` is the second mirror of the base commit. It is
    // OPTIONAL only until the [openviking] block carries it; once present it
    // must match, and a mismatch is a real pin drift.
    if (ov.extension_commit !== undefined) {
      expect(ov.extension_commit).toBe(upstream.commit);
    }
  });

  it("keeps the Apache-2.0 notice and states that the files were modified", () => {
    expect(read("LICENSE")).toContain("Apache License");
    expect(read("LICENSE")).toContain("Version 2.0, January 2004");
    const notice = read("NOTICE");
    expect(notice).toContain("MODIFICATIONS");
    expect(notice).toContain("github.com/volcengine/OpenViking");
  });

  it("ships the patch series it claims to", () => {
    expect(upstream.patches.length).toBe(6); // 0000 scaffolding + five numbered
    for (const name of upstream.patches) {
      const patch = read(join("patches", name));
      expect(patch.length).toBeGreaterThan(0);
      expect(patch).toContain("diff --git a/extensions/vendor/openviking-pi/");
    }
  });
});

describe("PATCH 1 — ledger-pin is the sole owner of compaction", () => {
  it("registers no session_before_compact handler anywhere in the fork", () => {
    for (const file of ["index.ts", "config.ts", "client.ts", "sync.ts", "tools.ts", "takeover.ts"]) {
      // The identifier still appears in index.ts's tombstone comment; a
      // REGISTRATION is what must not.
      expect(code(file)).not.toMatch(/pi\.on\(\s*["'`]session_before_compact/);
    }
  });

  it("keeps ledger-pin's own handler — the invariant is that exactly one exists", () => {
    const ledgerPin = readFileSync(join(ROOT, "extensions", "ledger-pin.ts"), "utf8");
    expect(ledgerPin).toMatch(/session_before_compact/);
  });

  it("forces takeover off in code, not only in config.json", () => {
    // takeover REPLACES compaction; upstream defaults it ON
    // (`config.takeoverEnabled !== false`) and the knob is flippable.
    expect(code("config.ts")).toContain("config.takeoverEnabled = false;");
    expect(code("config.ts")).not.toContain("config.takeoverEnabled !== false");
    expect(JSON.parse(read("config.json")).takeover.enabled).toBe(false);
  });
});

describe("PATCH 2 — no ambient work in a subagent leaf", () => {
  const PI_SUBAGENT_ARGV = [
    "/usr/bin/node", "/opt/pi/index.js",
    "--mode", "json", "-p", "--no-session", "--no-skills", "--no-extensions",
  ];
  const SHEPHERD_ARGV = [
    "/usr/bin/node", "/opt/pi/index.js",
    "--approve", "--model", "openai-codex/gpt-5.6-sol",
    "--session-dir", "/opt/quickreview/state/pi-sessions/pr-42",
    "--system-prompt", "/opt/quickreview/state/session-prompts/pr-42.md",
    "--theme", "/opt/quickreview/extensions/muted-theme.json",
    "--extension", "/opt/quickreview/extensions/ledger-pin.ts",
    "--name", "pr-42",
  ];

  it("reads a pi-subagents child argv as a leaf", () => {
    expect(isLeafProcess(PI_SUBAGENT_ARGV, {})).toBe(true);
    // Any one of the flags is enough — pi-subagents may reorder or drop some.
    for (const flag of LEAF_ARGV_FLAGS) {
      expect(isLeafProcess(["node", "pi", flag], {})).toBe(true);
    }
    expect(isLeafProcess(["node", "pi", "--mode=json"], {})).toBe(true);
  });

  it("reads the shepherd's own argv as main", () => {
    expect(isLeafProcess(SHEPHERD_ARGV, {})).toBe(false);
    // ...even with the OpenViking env a leaf would have inherited. This is
    // the whole reason detection is argv-based.
    expect(isLeafProcess(SHEPHERD_ARGV, {
      OPENVIKING_SESSION_ID: "pr-42",
      OPENVIKING_PEER_ID: "pr-42",
      OPENVIKING_API_KEY: "k",
    })).toBe(false);
  });

  it("can be forced to leaf by env, but never forced to main", () => {
    expect(isLeafProcess(SHEPHERD_ARGV, { QCR_OV_LEAF: "1" })).toBe(true);
    const forcedMain = Object.keys({ QCR_OV_MAIN: 1 });
    expect(read("qcr-leaf.ts")).not.toContain(forcedMain[0]!);
  });

  it("guards every ambient hook in index.ts", () => {
    const src = read("index.ts");
    // before_agent_start (recall queue + profile), context (injection),
    // turn_end (sync + threshold commit), session_shutdown (commit), and the
    // start() path that would open a session.
    expect(src.match(/if \(leaf\)/g)?.length ?? 0).toBeGreaterThanOrEqual(5);
    expect(src).toContain("registerTools(pi, client, sync, { leaf: true })");
    expect(src).toContain("registerTools(pi, client, sync, { leaf: false, namespaces })");
  });

  it("registers no write tool in a leaf", () => {
    const tools = read("tools.ts");
    expect(tools).toContain("const leaf = opts.leaf === true;");
    // The write tool sits inside `if (!leaf) {`; the read tools do not.
    const writeAt = tools.indexOf('name: "viking_write"');
    const gateAt = tools.lastIndexOf("if (!leaf) {", writeAt);
    expect(gateAt).toBeGreaterThan(-1);
    expect(tools.indexOf('name: "viking_search"')).toBeLessThan(gateAt);
  });
});

describe("PATCH 3 — the daemon owns session lifecycle", () => {
  const clientStub = (existing: string[]) =>
    ({
      connected: true,
      async getSession(id: string) {
        return existing.includes(id) ? ({ session_id: id } as any) : null;
      },
    }) as any;

  it("has no session-creating route left in the client", () => {
    const src = code("client.ts");
    expect(src).not.toContain("async createSession(");
    expect(src).not.toContain("auto_create");
    expect(src).not.toMatch(/fetchJSON<any>\("\/api\/v1\/sessions",/);
  });

  it("never derives an OV session id from pi's", () => {
    expect(code("sync.ts")).not.toMatch(/deriveHarnessSessionId\(/);
  });

  it("attaches to a daemon-provided id that exists", async () => {
    const sync = new SyncManager(clientStub(["pr-42"]), {} as any);
    expect(await sync.ensureSession({ OPENVIKING_SESSION_ID: "pr-42" })).toBe(true);
    expect(sync.sessionId).toBe("pr-42");
  });

  it("also accepts QCR_OV_SESSION_ID — the name that survives the QCR_ argv prefix", async () => {
    const sync = new SyncManager(clientStub(["pr-7"]), {} as any);
    expect(await sync.ensureSession({ QCR_OV_SESSION_ID: "pr-7" })).toBe(true);
    expect(sync.sessionId).toBe("pr-7");
  });

  it("declines — non-fatally — with no id, and creates nothing", async () => {
    const sync = new SyncManager(clientStub(["pr-42"]), {} as any);
    expect(await sync.ensureSession({})).toBe(false);
    expect(sync.sessionId).toBeNull();
  });

  it("declines when the named session does not exist server-side", async () => {
    const sync = new SyncManager(clientStub([]), {} as any);
    expect(await sync.ensureSession({ OPENVIKING_SESSION_ID: "pr-42" })).toBe(false);
    expect(sync.sessionId).toBeNull();
  });
});

describe("PATCH 4 — viking_write is the one durable write", () => {
  const URI = "viking://user/reviewer/memories/experiences/pr-5312-migration.md";

  it("removed every other write tool", () => {
    const tools = code("tools.ts");
    for (const gone of ["viking_remember", "viking_forget", "viking_add_resource"]) {
      expect(tools).not.toContain(`name: "${gone}"`);
    }
    expect(tools).toContain('name: "viking_write"');
    // The advertised list in the system prompt has to agree with reality.
    const advertised = read("index.ts").match(/OpenViking tools: ([^"]+)\./)?.[1] ?? "";
    expect(advertised).toContain("viking_write");
    expect(advertised).not.toContain("viking_remember");
  });

  it("writes through content/batch-write, never content/write", () => {
    expect(read("client.ts")).toContain("/api/v1/content/batch-write");
    // The MEMORY_FIELDS footer makes content/write unusable with expect-hash.
    expect(code("client.ts")).not.toContain("/api/v1/content/write");
  });

  it("creates with create_if_absent and returns the hash of what it wrote", () => {
    const built = buildWriteRequest({ uri: URI, content: "The renumber lands as a comment." });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.request.root_uri).toBe("viking://user/reviewer/memories/experiences");
    expect(built.request.operations).toHaveLength(1);
    expect(built.request.operations[0]!.precondition).toEqual({ kind: "create_if_absent" });
    expect(built.hash).toBe(sha256Prefixed(built.request.operations[0]!.content));
    // wait blocks on a ~1.6 core-second index refresh; never by default.
    expect(built.request.wait).toBe(false);
    expect(buildWriteRequest({ uri: URI, content: "x", wait: true }).ok && true).toBe(true);
  });

  it("refuses to replace without a precondition — there is no blind overwrite", () => {
    const built = buildWriteRequest({ uri: URI, content: "x", mode: "replace" });
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.error).toContain("expect_hash");
  });

  it("sends replace_if_hash when given one, in the sha256: form the server wants", () => {
    const hex = "a".repeat(64);
    for (const given of [hex, `sha256:${hex}`, `SHA256:${hex.toUpperCase()}`]) {
      const built = buildWriteRequest({ uri: URI, content: "x", mode: "replace", expect_hash: given });
      expect(built.ok).toBe(true);
      if (!built.ok) return;
      expect(built.request.operations[0]!.precondition).toEqual({
        kind: "replace_if_hash",
        base_hash: `sha256:${hex}`,
      });
    }
    expect(normalizeHash("not-a-hash")).toBeNull();
  });

  it("renders tags into the body and normalizes them", () => {
    const built = buildWriteRequest({ uri: URI, content: "A lesson.", tags: ["#Pinned", "review-ops", "pinned"] });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.tags).toEqual(["pinned", "review-ops"]);
    expect(built.request.operations[0]!.content).toBe("A lesson.\n\nTags: #pinned #review-ops\n");
    // An author who wrote their own Tags line is not double-tagged.
    expect(renderMemoryBody("Body\n\nTags: #manual", ["manual"])).toBe("Body\n\nTags: #manual\n");
    expect(normalizeTags(["NOT A TAG"]).ok).toBe(false);
  });

  it("refuses targets that are not memory files", () => {
    for (const bad of [
      "",
      "/etc/passwd",
      "https://example.com/x.md",
      "viking://user/reviewer/memories/../../companion/secret.md",
      "viking://user/reviewer/memories/experiences/notes.sh",
      "viking://notes.md",
    ]) {
      expect(buildWriteRequest({ uri: bad, content: "x" }).ok).toBe(false);
    }
    expect(parentUri("viking://a/b.md")).toBe("viking://a");
  });

  it("refuses empty content rather than writing a blank memory", () => {
    expect(buildWriteRequest({ uri: URI, content: "   \n" }).ok).toBe(false);
  });

  it("keeps the write tool's leaf gate — a second namespace is not a way in", () => {
    // PATCH 5 must not have moved viking_write out of `if (!leaf) {`.
    const tools = read("tools.ts");
    const writeAt = tools.indexOf('name: "viking_write"');
    expect(tools.lastIndexOf("if (!leaf) {", writeAt)).toBeGreaterThan(-1);
  });

  it("surfaces a 409 as a distinct, non-destructive outcome", async () => {
    const seen: { url: string; body: any }[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (url: any, init: any) => {
      seen.push({ url: String(url), body: JSON.parse(init.body) });
      return {
        ok: false,
        status: 409,
        json: async () => ({
          status: "error",
          error: { code: "CONFLICT", message: "Batch write replace precondition failed; content hash changed." },
        }),
      } as any;
    }) as any;
    try {
      const client = new OVClient({ endpoint: "http://127.0.0.1:1933", apiKey: "", account: "", user: "", peerId: "", userAgent: "" } as any);
      const built = buildWriteRequest({ uri: URI, content: "x", mode: "replace", expect_hash: "b".repeat(64) });
      expect(built.ok).toBe(true);
      if (!built.ok) return;
      const res = await client.batchWrite(built.request);
      expect(res.ok).toBe(false);
      expect(res.status).toBe(409);
      expect(res.error?.code).toBe("CONFLICT");
      expect(seen[0]!.url).toBe("http://127.0.0.1:1933/api/v1/content/batch-write");
      expect(seen[0]!.body.operations[0].precondition.kind).toBe("replace_if_hash");
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe("PATCH 5 — a second memory namespace, and only where it belongs", () => {
  const COMPANION = { user: "companion" };
  const ovConfWith = (rootKey: string): string => {
    const dir = mkdtempSync(join(tmpdir(), "qcr-ov-"));
    const path = join(dir, "ov.conf");
    writeFileSync(path, JSON.stringify({ server: { root_api_key: rootKey } }));
    return path;
  };

  describe("resolution", () => {
    it("is a no-op without the second key — the normal single-namespace state", () => {
      expect(resolveExtraNamespaces(COMPANION, {})).toEqual([]);
      expect(resolveExtraNamespaces(COMPANION, { [REVIEWER_KEY_ENV]: "   " })).toEqual([]);
    });

    it("builds the reviewer namespace when the companion's second key is present", () => {
      expect(resolveExtraNamespaces(COMPANION, { [REVIEWER_KEY_ENV]: "rk" })).toEqual([
        { name: "reviewer", user: "reviewer", apiKey: "rk" },
      ]);
      // The user name is a deployment fact, so it is overridable.
      expect(
        resolveExtraNamespaces(COMPANION, { [REVIEWER_KEY_ENV]: "rk", [REVIEWER_USER_ENV]: "Reviewer2" })[0]!.user,
      ).toBe("reviewer2");
    });

    it("gives a LEAF nothing — PATCH 2/4 are not routed around", () => {
      expect(resolveExtraNamespaces(COMPANION, { [REVIEWER_KEY_ENV]: "rk" }, { leaf: true })).toEqual([]);
    });

    it("gives a REVIEW SESSION nothing — its own identity already is reviewer", () => {
      // src/sessions.ts launches every pi with OPENVIKING_USER=reviewer and
      // never puts OPENVIKING_REVIEWER_KEY in the env; even if it did, a
      // namespace equal to our own is not a second namespace.
      expect(resolveExtraNamespaces({ user: "reviewer" }, { [REVIEWER_KEY_ENV]: "rk" })).toEqual([]);
    });

    it("puts the SECOND key through the same root-key guard as the first", () => {
      const path = ovConfWith("ROOT-KEY");
      const env = { OPENVIKING_CONFIG_FILE: path, [REVIEWER_KEY_ENV]: "ROOT-KEY" };
      // The whole reason withoutRootKey exists: the container's ~/.openviking
      // is a symlink onto the state volume holding the SERVER's ov.conf.
      expect(resolveExtraNamespaces(COMPANION, env)).toEqual([]);
      expect(resolveExtraNamespaces(COMPANION, { ...env, [REVIEWER_KEY_ENV]: "user-key" })).toHaveLength(1);
      // …and directly, since a caller could hold a credential of any shape.
      expect(withoutRootKey({ apiKey: "ROOT-KEY", hasApiKey: true }, { OPENVIKING_CONFIG_FILE: path }))
        .toEqual({ apiKey: "", hasApiKey: false });
      expect(withoutRootKey({ apiKey: "user-key", hasApiKey: true }, { OPENVIKING_CONFIG_FILE: path }).apiKey)
        .toBe("user-key");
    });

    it("resolves the guard through config.ts rather than re-implementing it", () => {
      expect(read("qcr-namespaces.ts")).toContain('import { withoutRootKey } from "./config.js"');
    });
  });

  describe("routing", () => {
    const TWO = ["companion", "reviewer"];

    it("is a constant with one namespace — every review session is unchanged", () => {
      for (const params of [
        {},
        { uri: "viking://user/memories/notes.md" },       // reserved-word form
        { uri: "viking://user/companion/memories/x.md" }, // a tree we cannot reach
        { namespace: "nonsense" },
      ]) {
        expect(routeNamespace(params, ["reviewer"])).toEqual({ ok: true, namespace: "reviewer" });
      }
      expect(namespaceNote(["reviewer"])).toBe("");
    });

    it("defaults to our own namespace, which is names[0]", () => {
      expect(routeNamespace({}, TWO)).toEqual({ ok: true, namespace: "companion" });
      expect(routeNamespace({ uri: "viking://user/memories/x.md" }, TWO)).toEqual({ ok: true, namespace: "companion" });
    });

    it("takes the namespace from the parameter or from the URI", () => {
      expect(routeNamespace({ namespace: "reviewer" }, TWO)).toEqual({ ok: true, namespace: "reviewer" });
      expect(routeNamespace({ uri: "viking://user/reviewer/memories/x.md" }, TWO)).toEqual({ ok: true, namespace: "reviewer" });
      // viking_search carries its URI in `scope`.
      expect(routeNamespace({ scope: "viking://user/reviewer/memories/" }, TWO)).toEqual({ ok: true, namespace: "reviewer" });
      expect(namespaceOfUri("viking://user/Reviewer/memories/x.md")).toBe("reviewer");
      expect(namespaceOfUri("viking://session/pr-42")).toBeNull();
    });

    it("REFUSES a call that names two different trees", () => {
      const routed = routeNamespace(
        { namespace: "companion", uri: "viking://user/reviewer/memories/x.md" },
        TWO,
      );
      expect(routed.ok).toBe(false);
      if (routed.ok) return;
      expect(routed.error).toContain("reviewer");
      expect(routed.error).toContain("companion");
    });

    it("names the missing env var when an unreachable namespace is asked for", () => {
      const routed = routeNamespace({ namespace: "reviewer" }, ["companion", "other"]);
      expect(routed.ok).toBe(false);
      if (routed.ok) return;
      expect(routed.error).toContain(REVIEWER_KEY_ENV);
    });

    it("names the tree in every multi-namespace answer, and offers the parameter only then", () => {
      expect(namespaceNote(TWO)).toContain("companion and reviewer");
      const tools = read("tools.ts");
      // The prefix and the parameter are both keyed off `multi`, so a
      // single-namespace pi (every review session) sees neither.
      expect(tools).toContain("multi ? `[${ns.name}] ${text}` : text");
      expect(tools).toContain("multi\n    ? { namespace: Type.Optional(StringEnum(names)) }\n    : {}");
      // Every namespace-aware tool takes it, and every one appends the note.
      expect(tools.match(/\.\.\.nsParam,/g)?.length ?? 0).toBe(4);
      expect(tools.match(/\+ nsNote,/g)?.length ?? 0).toBe(4);
    });

    it("gives the own-namespace name a sane default", () => {
      expect(ownNamespaceName("Companion")).toBe("companion");
      expect(ownNamespaceName(undefined)).toBe("own");
    });
  });

  describe("structure — the parts no test can call", () => {
    it("builds the extra clients only outside a leaf, from the same config", () => {
      const src = read("index.ts");
      expect(src).toContain("leaf ? [] : resolveExtraNamespaces(config)");
      expect(src).toContain("new OVClient({ ...config, apiKey: ns.apiKey, user: ns.user })");
      // The leaf path registers tools with no namespaces at all.
      expect(src).toContain("registerTools(pi, client, sync, { leaf: true })");
    });

    it("discards namespaces handed to a leaf, in tools.ts too", () => {
      expect(code("tools.ts")).toContain(
        "leaf || !opts.namespaces || opts.namespaces.length === 0 ? [own] : opts.namespaces",
      );
    });

    it("keeps ambient work single-namespace: sync and recall hold the primary client", () => {
      const src = code("index.ts");
      expect(src).toContain("new SyncManager(client, config)");
      expect(src).toContain("new RecallManager(client, config,");
      // No extra client is ever handed to the session/recall machinery.
      expect(src).not.toMatch(/new (SyncManager|RecallManager)\(\s*ns\./);
    });

    it("advertises the namespaces in the system prompt only when there are two", () => {
      const src = read("index.ts");
      expect(src).toContain("if (extraNamespaces.length > 0) {");
      const advertised = src.match(/OpenViking tools: ([^"]+)\./)?.[1] ?? "";
      expect(advertised).toContain("viking_write");
    });

    it("leaves viking_archive_expand on the primary client", () => {
      const tools = read("tools.ts");
      const at = tools.indexOf('name: "viking_archive_expand"');
      expect(at).toBeGreaterThan(-1);
      expect(tools.slice(at)).toContain("await client.overview(uri)");
    });
  });
});
