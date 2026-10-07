// The vendored OpenViking pi extension — provenance + the ten
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
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { parse as parseToml } from "smol-toml";
import { isLeafProcess, LEAF_ARGV_FLAGS } from "../extensions/vendor/openviking-pi/qcr-leaf.js";
import { loadConfig, withoutRootKey } from "../extensions/vendor/openviking-pi/config.js";
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
import {
  buildBatchWriteRequest,
  commonParentUri,
  MAX_BATCH_ENTRIES,
  routeWrite,
} from "../extensions/vendor/openviking-pi/qcr-write.js";
import {
  BUSY_RETRY,
  failureText,
  isAuthFailure,
  isBusy,
  isNotFound,
  isPreconditionConflict,
  shouldRekey,
  withBusyRetry,
} from "../extensions/vendor/openviking-pi/qcr-honest.js";
import { BUSY_RETRY_DEFAULTS } from "../src/openviking/client.js";
import { SyncManager } from "../extensions/vendor/openviking-pi/sync.js";
import { RecallManager } from "../extensions/vendor/openviking-pi/recall.js";
import {
  budgetedFetch,
  COMMIT_REFUSED,
  hasRetiredHeader,
  isCommitPath,
  MAX_RECALL_EXCLUSIONS,
  raceBudget,
  RECALL_WAIT_MS,
  RecallBudgetSpent,
  readRetiredUris,
  refuseCommits,
  renderContextEntry,
  RETIRED_FILE_ENV,
  retiredGuard,
} from "../extensions/vendor/openviking-pi/qcr-recall.js";
import { parseHashTags } from "../src/memory/eventtags.js";
import { OVClient } from "../extensions/vendor/openviking-pi/client.js";
import {
  DEFAULT_AREA_QUOTA,
  DEFAULT_ROUND_AREAS,
  MAX_HINT_QUERY_CHARS,
  RECALL_HINT_FILE_ENV,
  browsableInScope,
  inAreas,
  memoryAreaOf,
  readRecallHint,
  readableInScope,
  scopeGuard,
  scopeRefusal,
  toolScopeAreas,
  toolScopeNote,
} from "../extensions/vendor/openviking-pi/qcr-hint.js";
import { ROUND_SEARCH_AREAS } from "../src/memory/layout.js";
import {
  buildLessonHeader,
  LESSON_KINDS as FORK_LESSON_KINDS,
  LESSON_LENS_IDS as FORK_LESSON_LENS_IDS,
  withLessonHeader,
} from "../extensions/vendor/openviking-pi/qcr-lesson.js";
import {
  LESSON_KINDS,
  LESSON_LENS_IDS,
  parseLesson,
  validateLessonFields,
} from "../src/memory/lessons.js";
import { ALL_PASSES } from "../src/passes.js";

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
    expect(upstream.patches.length).toBe(11); // 0000 scaffolding + ten numbered
    for (const name of upstream.patches) {
      const patch = read(join("patches", name));
      expect(patch.length).toBeGreaterThan(0);
      expect(patch).toContain("diff --git a/extensions/vendor/openviking-pi/");
    }
  });
});

describe("PATCH 1 — ledger-pin is the sole owner of compaction", () => {
  it("registers no session_before_compact handler anywhere in the fork", () => {
    for (const file of [
      "index.ts",
      "config.ts",
      "client.ts",
      "sync.ts",
      "tools.ts",
      "takeover.ts",
    ]) {
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
  // The retired third-party extension's child argv (kept: an older container
  // may still run it, and the detector must keep reading it as a leaf).
  const LEGACY_SUBAGENT_ARGV = [
    "/usr/bin/node",
    "/opt/pi/index.js",
    "--mode",
    "json",
    "-p",
    "--no-session",
    "--no-skills",
    "--no-extensions",
  ];
  // pi's NATIVE subagent extension's child argv (read statically
  // from the pinned 0.84.4 tarball's examples/extensions/subagent/index.ts:
  // no --no-skills, no --no-extensions — but -p / --no-session / --mode json
  // are all present, and any one of them is enough).
  const NATIVE_SUBAGENT_ARGV = [
    "/usr/bin/node",
    "/opt/pi/index.js",
    "--mode",
    "json",
    "-p",
    "--no-session",
    "--model",
    "openai-codex/gpt-5.6-sol:high",
    "--tools",
    "read,grep,find,ls,viking_search,viking_read",
  ];
  const SHEPHERD_ARGV = [
    "/usr/bin/node",
    "/opt/pi/index.js",
    "--approve",
    "--model",
    "openai-codex/gpt-5.6-sol",
    "--session-dir",
    "/opt/quickreview/state/pi-sessions/pr-42",
    "--system-prompt",
    "/opt/quickreview/state/session-prompts/pr-42.md",
    "--theme",
    "/opt/quickreview/extensions/muted-theme.json",
    "--extension",
    "/opt/quickreview/extensions/ledger-pin.ts",
    "--name",
    "pr-42",
  ];

  it("reads a subagent child argv as a leaf — native and legacy shapes both", () => {
    expect(isLeafProcess(NATIVE_SUBAGENT_ARGV, {})).toBe(true);
    expect(isLeafProcess(LEGACY_SUBAGENT_ARGV, {})).toBe(true);
    // Any one of the flags is enough — an extension may reorder or drop some.
    for (const flag of LEAF_ARGV_FLAGS) {
      expect(isLeafProcess(["node", "pi", flag], {})).toBe(true);
    }
    expect(isLeafProcess(["node", "pi", "--mode=json"], {})).toBe(true);
  });

  it("reads the shepherd's own argv as main", () => {
    expect(isLeafProcess(SHEPHERD_ARGV, {})).toBe(false);
    // ...even with the OpenViking env a leaf would have inherited. This is
    // the whole reason detection is argv-based.
    expect(
      isLeafProcess(SHEPHERD_ARGV, {
        OPENVIKING_SESSION_ID: "pr-42",
        OPENVIKING_PEER_ID: "pr-42",
        OPENVIKING_API_KEY: "k",
      }),
    ).toBe(false);
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
    // (PATCH 9 adds the area scope to both, nothing else.)
    expect(src).toContain("registerTools(pi, client, sync, { leaf: true, areas: toolAreas })");
    expect(src).toContain(
      "registerTools(pi, client, sync, { leaf: false, namespaces, areas: toolAreas })",
    );
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
      const built = buildWriteRequest({
        uri: URI,
        content: "x",
        mode: "replace",
        expect_hash: given,
      });
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
    const built = buildWriteRequest({
      uri: URI,
      content: "A lesson.",
      tags: ["#Pinned", "review-ops", "pinned"],
    });
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
          error: {
            code: "CONFLICT",
            message: "Batch write replace precondition failed; content hash changed.",
          },
        }),
      } as any;
    }) as any;
    try {
      const client = new OVClient({
        endpoint: "http://127.0.0.1:1933",
        apiKey: "",
        account: "",
        user: "",
        peerId: "",
        userAgent: "",
      } as any);
      const built = buildWriteRequest({
        uri: URI,
        content: "x",
        mode: "replace",
        expect_hash: "b".repeat(64),
      });
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
        resolveExtraNamespaces(COMPANION, {
          [REVIEWER_KEY_ENV]: "rk",
          [REVIEWER_USER_ENV]: "Reviewer2",
        })[0]!.user,
      ).toBe("reviewer2");
    });

    it("gives a LEAF nothing — PATCH 2/4 are not routed around", () => {
      expect(
        resolveExtraNamespaces(COMPANION, { [REVIEWER_KEY_ENV]: "rk" }, { leaf: true }),
      ).toEqual([]);
    });

    it("gives a REVIEW SESSION nothing — its own identity already is reviewer", () => {
      // src/sessions.ts launches every pi with OPENVIKING_USER=reviewer and
      // never puts OPENVIKING_REVIEWER_KEY in the env; even if it did, a
      // namespace equal to our own is not a second namespace.
      expect(resolveExtraNamespaces({ user: "reviewer" }, { [REVIEWER_KEY_ENV]: "rk" })).toEqual(
        [],
      );
    });

    it("puts the SECOND key through the same root-key guard as the first", () => {
      const path = ovConfWith("ROOT-KEY");
      const env = { OPENVIKING_CONFIG_FILE: path, [REVIEWER_KEY_ENV]: "ROOT-KEY" };
      // The whole reason withoutRootKey exists: the container's ~/.openviking
      // is a symlink onto the state volume holding the SERVER's ov.conf.
      expect(resolveExtraNamespaces(COMPANION, env)).toEqual([]);
      expect(
        resolveExtraNamespaces(COMPANION, { ...env, [REVIEWER_KEY_ENV]: "user-key" }),
      ).toHaveLength(1);
      // …and directly, since a caller could hold a credential of any shape.
      expect(
        withoutRootKey({ apiKey: "ROOT-KEY", hasApiKey: true }, { OPENVIKING_CONFIG_FILE: path }),
      ).toEqual({ apiKey: "", hasApiKey: false });
      expect(
        withoutRootKey({ apiKey: "user-key", hasApiKey: true }, { OPENVIKING_CONFIG_FILE: path })
          .apiKey,
      ).toBe("user-key");
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
        { uri: "viking://user/memories/notes.md" }, // reserved-word form
        { uri: "viking://user/companion/memories/x.md" }, // a tree we cannot reach
        { namespace: "nonsense" },
      ]) {
        expect(routeNamespace(params, ["reviewer"])).toEqual({ ok: true, namespace: "reviewer" });
      }
      expect(namespaceNote(["reviewer"])).toBe("");
    });

    it("defaults to our own namespace, which is names[0]", () => {
      expect(routeNamespace({}, TWO)).toEqual({ ok: true, namespace: "companion" });
      expect(routeNamespace({ uri: "viking://user/memories/x.md" }, TWO)).toEqual({
        ok: true,
        namespace: "companion",
      });
    });

    it("takes the namespace from the parameter or from the URI", () => {
      expect(routeNamespace({ namespace: "reviewer" }, TWO)).toEqual({
        ok: true,
        namespace: "reviewer",
      });
      expect(routeNamespace({ uri: "viking://user/reviewer/memories/x.md" }, TWO)).toEqual({
        ok: true,
        namespace: "reviewer",
      });
      // viking_search carries its URI in `scope`.
      expect(routeNamespace({ scope: "viking://user/reviewer/memories/" }, TWO)).toEqual({
        ok: true,
        namespace: "reviewer",
      });
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
      expect(tools).toContain(
        "multi\n    ? { namespace: Type.Optional(StringEnum(names)) }\n    : {}",
      );
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
      expect(src).toContain("registerTools(pi, client, sync, { leaf: true, areas: toolAreas })");
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

// ---- PATCH 6 (S2) ----------------------------------------------------

describe("PATCH 6 — writes that stick, errors that say so", () => {
  const BUSY_409 = {
    ok: false,
    status: 409,
    error: {
      code: "CONFLICT",
      message: "resource is busy and cannot be written now",
      details: { conflict_type: "path_busy", retryable: true },
    },
  };
  const PRECONDITION_409 = {
    ok: false,
    status: 409,
    error: {
      code: "CONFLICT",
      message: "Batch write replace precondition failed; content hash changed.",
    },
  };
  const ROOT = "viking://user/reviewer/memories";

  it("tells a busy 409 from a precondition 409 by details.conflict_type alone", () => {
    expect(isBusy(BUSY_409)).toBe(true);
    expect(isPreconditionConflict(BUSY_409)).toBe(false);
    expect(isBusy(PRECONDITION_409)).toBe(false);
    expect(isPreconditionConflict(PRECONDITION_409)).toBe(true);
    expect(isBusy({ ok: false, status: 409, error: { message: "resource is busy" } })).toBe(false);
    expect(isBusy({ ok: true, status: 200 })).toBe(false);
  });

  it("retries ONLY a busy answer, jittered and bounded — the daemon client's rule", async () => {
    expect(BUSY_RETRY).toEqual({ ...BUSY_RETRY_DEFAULTS });
    let calls = 0;
    const sleeps: number[] = [];
    let clock = 0;
    const hooks = {
      sleep: async (ms: number) => {
        sleeps.push(ms);
        clock += ms;
      },
      now: () => clock,
      random: () => 0.5,
    };
    const ok = await withBusyRetry(
      async () => (++calls <= 2 ? BUSY_409 : { ok: true, status: 200 }),
      hooks,
    );
    expect(ok).toMatchObject({ ok: true, busyRetries: 2, stillBusy: false });
    expect(sleeps).toHaveLength(2);

    calls = 0;
    const refused = await withBusyRetry(async () => (++calls, PRECONDITION_409), hooks);
    expect(calls).toBe(1);
    expect(refused).toMatchObject({ ok: false, status: 409, busyRetries: 0, stillBusy: false });

    sleeps.length = 0;
    clock = 0;
    const stuck = await withBusyRetry(async () => BUSY_409, hooks);
    expect(stuck.stillBusy).toBe(true);
    expect(stuck.busyRetries).toBeLessThanOrEqual(BUSY_RETRY.retries);
    expect(sleeps.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(BUSY_RETRY.budgetMs);
  });

  it("never renders a failure as an empty answer", () => {
    const auth = failureText(
      { ok: false, status: 401, error: { code: "UNAUTHENTICATED", message: "Invalid API Key" } },
      "searched",
    );
    expect(auth).toContain("REFUSED this session's key");
    expect(auth).toContain("Invalid API Key");
    expect(auth).toContain("not an empty result");
    // The 0.4.15 server has wrapped a bad key in a non-401 envelope.
    expect(isAuthFailure({ ok: false, status: 500, error: { message: "Invalid API Key" } })).toBe(
      true,
    );
    const dead = failureText({ ok: false, status: 0, error: { message: "fetch failed" } }, "read");
    expect(dead).toContain("did not answer");
    expect(dead).toContain("not an empty result");
    expect(failureText({ ...BUSY_409, stillBusy: true }, "written")).toContain("path_busy");
    expect(failureText({ ...BUSY_409, stillBusy: true }, "written")).toContain(
      "Nobody's edit was refused",
    );
    for (const t of [auth, dead]) {
      expect(t).not.toContain("No results");
      expect(t).not.toContain("No content");
    }
    expect(isNotFound({ ok: false, status: 404, error: { code: "NOT_FOUND" } })).toBe(true);
    expect(isNotFound({ ok: false, status: 401 })).toBe(false);
  });

  it("re-keys only on an auth failure, and only to a DIFFERENT key", () => {
    const refused = { ok: false, status: 401, error: { code: "UNAUTHENTICATED" } };
    expect(shouldRekey(refused, "old", "new")).toBe(true);
    expect(shouldRekey(refused, "old", "old")).toBe(false);
    expect(shouldRekey(refused, "old", "")).toBe(false);
    expect(shouldRekey(PRECONDITION_409, "old", "new")).toBe(false);
  });

  it("writes several entries as ONE batch-write under their common directory", () => {
    const built = buildBatchWriteRequest({
      entries: [
        { uri: `${ROOT}/experiences/a.md`, content: "lesson a", tags: ["lesson"] },
        { uri: `${ROOT}/experiences/b.md`, content: "lesson b" },
      ],
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.request.root_uri).toBe(`${ROOT}/experiences`);
    expect(built.request.operations.map((o) => o.uri)).toEqual([
      `${ROOT}/experiences/a.md`,
      `${ROOT}/experiences/b.md`,
    ]);
    expect(built.request.operations.every((o) => o.precondition.kind === "create_if_absent")).toBe(
      true,
    );
    expect(built.entries.map((e) => e.hash)).toEqual(
      built.request.operations.map((o) => sha256Prefixed(o.content)),
    );
    expect(built.request.wait).toBe(false);
    // One entry the old way is the same request PATCH 4 built.
    const one = buildBatchWriteRequest({ uri: `${ROOT}/experiences/a.md`, content: "x" });
    expect(one.ok && one.request.operations).toEqual(
      (() => {
        const b = buildWriteRequest({ uri: `${ROOT}/experiences/a.md`, content: "x" });
        return b.ok && b.request.operations;
      })(),
    );
    expect(commonParentUri([`${ROOT}/a/x.md`, `${ROOT}/a/b/y.md`])).toBe(`${ROOT}/a`);
  });

  it("routes a batch by its ENTRIES — a reviewer-only batch is never refused as two trees", () => {
    // The companion: its own tree first, the reviewer's second. A batch has
    // no top-level uri, so routing the bare params fell back to `companion`
    // and then refused every reviewer entry as "more than one memory tree".
    const TWO = ["companion", "reviewer"];
    const R = "viking://user/reviewer/memories/experiences";
    const C = "viking://user/companion/memories/experiences";
    const reviewerOnly = {
      entries: [
        { uri: `${R}/a.md`, content: "x" },
        { uri: `${R}/b.md`, content: "y" },
      ],
    };
    expect(routeWrite(reviewerOnly, TWO)).toEqual({ ok: true, namespace: "reviewer" });
    expect(routeWrite({ ...reviewerOnly, namespace: "reviewer" }, TWO)).toEqual({
      ok: true,
      namespace: "reviewer",
    });
    // An explicit namespace that disagrees with the entries is refused.
    const clash = routeWrite({ ...reviewerOnly, namespace: "companion" }, TWO);
    expect(clash.ok).toBe(false);
    // A batch that really does straddle the two trees is refused, naming both.
    const straddle = routeWrite(
      {
        entries: [
          { uri: `${R}/a.md`, content: "x" },
          { uri: `${C}/b.md`, content: "y" },
        ],
      },
      TWO,
    );
    expect(straddle.ok).toBe(false);
    expect(!straddle.ok && straddle.error).toMatch(
      /more than one memory tree \(reviewer and companion\)/,
    );
    // The reserved-word form names no tree: with no namespace it is our own.
    expect(
      routeWrite({ entries: [{ uri: "viking://user/memories/x.md", content: "x" }] }, TWO),
    ).toEqual({ ok: true, namespace: "companion" });
    // One entry the old way routes exactly as routeNamespace does.
    expect(routeWrite({ uri: `${R}/a.md`, content: "x" }, TWO)).toEqual(
      routeNamespace({ uri: `${R}/a.md` }, TWO),
    );
    // A single-namespace process (every review session) is a constant.
    expect(routeWrite(reviewerOnly, ["reviewer"])).toEqual({ ok: true, namespace: "reviewer" });
  });

  it("refuses a batch it cannot send whole", () => {
    const bad: unknown[] = [
      { entries: [] },
      { entries: "nope" },
      {
        uri: `${ROOT}/experiences/a.md`,
        content: "x",
        entries: [{ uri: `${ROOT}/experiences/b.md`, content: "y" }],
      },
      {
        entries: [
          { uri: `${ROOT}/experiences/a.md`, content: "x" },
          { uri: `${ROOT}/experiences/a.md`, content: "y" },
        ],
      },
      {
        entries: [
          { uri: `${ROOT}/experiences/a.md`, content: "x" },
          { uri: `${ROOT}/experiences/b.md`, content: "  " },
        ],
      },
      { entries: [{ uri: `${ROOT}/experiences/a.md`, content: "x", mode: "replace" }] },
      {
        entries: Array.from({ length: MAX_BATCH_ENTRIES + 1 }, (_, i) => ({
          uri: `${ROOT}/experiences/${i}.md`,
          content: "x",
        })),
      },
    ];
    for (const input of bad) expect(buildBatchWriteRequest(input as never).ok).toBe(false);
  });

  describe("the client", () => {
    const realFetch = globalThis.fetch;
    const cfg = {
      endpoint: "http://127.0.0.1:1933",
      apiKey: "old",
      account: "",
      user: "reviewer",
      peerId: "",
      userAgent: "",
    };
    const reply = (status: number, body: unknown) =>
      ({ ok: status >= 200 && status < 300, status, json: async () => body }) as never;
    const restore = () => {
      globalThis.fetch = realFetch;
    };

    it("find() surfaces a refused key instead of an empty list", async () => {
      globalThis.fetch = (async () =>
        reply(401, {
          status: "error",
          error: { code: "UNAUTHENTICATED", message: "Invalid API Key" },
        })) as never;
      try {
        const res = await new OVClient(cfg as never).find("migrations");
        expect(res.ok).toBe(false);
        expect(res.status).toBe(401);
        expect(failureText(res, "searched")).toContain("Invalid API Key");
      } finally {
        restore();
      }
    });

    it("find() still answers an empty list for an empty store", async () => {
      globalThis.fetch = (async () =>
        reply(200, { status: "ok", result: { memories: [], total: 0 } })) as never;
      try {
        expect(await new OVClient(cfg as never).find("x")).toMatchObject({ ok: true, result: [] });
      } finally {
        restore();
      }
    });

    it("batchWrite retries a busy directory and lands", async () => {
      let n = 0;
      globalThis.fetch = (async () =>
        ++n === 1
          ? reply(409, { status: "error", error: BUSY_409.error })
          : reply(200, {
              status: "ok",
              result: { root_uri: "r", created: ["u"], updated: [], unchanged: [] },
            })) as never;
      try {
        const c = new OVClient(cfg as never);
        c.retryHooks = { sleep: async () => {}, random: () => 0 };
        const res = await c.batchWrite({ root_uri: "r", operations: [], wait: false });
        expect(res.ok).toBe(true);
        expect(res.busyRetries).toBe(1);
        expect(n).toBe(2);
      } finally {
        restore();
      }
    });

    it("re-reads a refused key ONCE and retries with the new one", async () => {
      const seen: string[] = [];
      globalThis.fetch = (async (_url: unknown, init: { headers: Record<string, string> }) => {
        const auth = init.headers["Authorization"] ?? "";
        seen.push(auth);
        return auth === "Bearer new"
          ? reply(200, { status: "ok", result: "content" })
          : reply(401, {
              status: "error",
              error: { code: "UNAUTHENTICATED", message: "Invalid API Key" },
            });
      }) as never;
      try {
        const c = new OVClient(cfg as never);
        c.rekey = () => "new";
        expect(await c.readLevel(`${ROOT}/experiences/a.md`, "full")).toMatchObject({
          ok: true,
          result: "content",
        });
        expect(seen).toEqual(["Bearer old", "Bearer new"]);
        // The same key twice is not retried: a second refusal would be all it buys.
        seen.length = 0;
        const stuck = new OVClient(cfg as never);
        stuck.rekey = () => "old";
        expect((await stuck.readLevel(`${ROOT}/experiences/a.md`, "full")).ok).toBe(false);
        expect(seen).toEqual(["Bearer old"]);
      } finally {
        restore();
      }
    });
  });

  describe("structure — the parts no test can call", () => {
    it("no tool turns a failure into 'No results' / 'No content' / 'Empty directory'", () => {
      const tools = code("tools.ts");
      const search = tools.slice(
        tools.indexOf('name: "viking_search"'),
        tools.indexOf('name: "viking_read"'),
      );
      expect(search).toContain('failureText(res, "searched")');
      expect(search.indexOf("if (!res.ok)")).toBeLessThan(search.indexOf("No results found."));
      const readTool = tools.slice(
        tools.indexOf('name: "viking_read"'),
        tools.indexOf('name: "viking_browse"'),
      );
      expect(readTool).toContain('failureText(res, "read")');
      expect(readTool).toContain("isNotFound(res)");
      const browse = tools.slice(
        tools.indexOf('name: "viking_browse"'),
        tools.indexOf('name: "viking_write"'),
      );
      expect(browse).toContain("failureText(listed");
      expect(browse).toContain("failureText(st");
      // The old collapsing calls are gone from the tools.
      expect(tools).not.toMatch(/ns\.client\.(abstract|overview|readContent|ls|stat)\(/);
    });

    it("viking_write builds ONE batch and calls only a precondition 409 a refusal", () => {
      const tools = code("tools.ts");
      const write = tools.slice(
        tools.indexOf('name: "viking_write"'),
        tools.indexOf("viking_archive_expand"),
      );
      expect(write).toContain("buildBatchWriteRequest(params");
      // A batch is routed by its entries, never by the bare top-level params.
      expect(write).toContain("pick(params, routeWrite)");
      expect(write).toContain("entries: Type.Optional(Type.Array(");
      expect(write).toContain("isPreconditionConflict(res)");
      expect(write).not.toContain("res.status === 409");
      expect(write.match(/ns\.client\.batchWrite\(/g)).toHaveLength(1);
    });

    it("re-keys through the root-key guard, on the primary client only", () => {
      expect(code("config.ts")).toMatch(
        /export function rereadApiKey[\s\S]*?withoutRootKey\(resolveOpenVikingCredentials\(env\), env\)/,
      );
      expect(code("index.ts")).toContain("client.rekey = () => rereadApiKey()");
      expect(code("index.ts").match(/\.rekey =/g)).toHaveLength(1);
    });

    it("ships the patch, recorded in the series, with its markers", () => {
      expect(upstream.patches).toContain("0006-writes-that-stick-and-honest-errors.patch");
      const patch = read(join("patches", "0006-writes-that-stick-and-honest-errors.patch"));
      expect(patch).toContain("QCR PATCH 6");
      for (const f of [
        "qcr-honest.ts",
        "qcr-write.ts",
        "client.ts",
        "config.ts",
        "tools.ts",
        "index.ts",
      ]) {
        expect(patch).toContain(`b/extensions/vendor/openviking-pi/${f}`);
      }
      expect(read("NOTICE")).toContain('6. A "directory busy" 409 is retried');
      expect(read("README.md")).toContain("### 0006 — writes that stick");
    });
  });
});

// ---- PATCH 7 (S3) ----------------------------------------------------

describe("PATCH 7 — bounded recall, no commit (owner ruling R3)", () => {
  const ROOT = "viking://user/reviewer/memories";
  const SEARCH_OK = (entries: Array<Record<string, unknown>>) => ({
    ok: true,
    status: 200,
    result: {
      entries,
      rendered: entries.map((e) => renderContextEntry(e)).join("\n"),
      digest: "",
      stats: {},
    },
  });
  const entry = (name: string, text: string) => ({
    uri: `${ROOT}/experiences/${name}`,
    category: "experiences",
    score: 0.6,
    detail: "full",
    text,
  });
  /** The real loadConfig over the vendored config.json, with no credential. */
  const loaded = () => loadConfig(FORK);
  /** A stub OVClient: `fetchJSON(path, init, timeoutMs)` answers through `answer`. */
  type Seen = Array<{ path: string; body: Record<string, unknown> | undefined; timeoutMs: number }>;
  type Init = { body?: string } | undefined;
  const clientOf = (
    answer: (path: string, init: Init, timeoutMs: number) => Promise<unknown>,
    seen: Seen = [],
  ) =>
    ({
      async fetchJSON(path: string, init?: Init, timeoutMs = 10000) {
        seen.push({
          path,
          body: init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : undefined,
          timeoutMs,
        });
        return answer(path, init, timeoutMs);
      },
    }) as unknown as ConstructorParameters<typeof RecallManager>[0];

  it("the recall wait is capped at 500 ms — a caller can ask for less, never more", () => {
    expect(RECALL_WAIT_MS).toBe(500);
  });

  it("returns on time from a recall that never answers, and keeps no late result", async () => {
    let settle: (v: unknown) => void = () => {};
    const never = new Promise((r) => (settle = r));
    const seen: Seen = [];
    const recall = new RecallManager(
      clientOf(() => never, seen),
      loaded(),
      () => "pr-42",
    );
    recall.queueSearch("does the retry loop cap its backoff?");
    const t0 = Date.now();
    const block = await recall.searchPending(40);
    expect(Date.now() - t0).toBeLessThan(400);
    expect(block).toBeNull();
    // The only request carried the time left on the deadline as its timeout.
    expect(seen.map((s) => s.path)).toEqual(["/api/v1/search/search"]);
    expect(seen[0]!.timeoutMs).toBeLessThanOrEqual(40);
    // A late answer is dropped: the next context event of this run injects nothing.
    settle(SEARCH_OK([entry("a.md", "late")]));
    await new Promise((r) => setTimeout(r, 5));
    expect(await recall.searchPending()).toBeNull();
  });

  it("asking for MORE than the cap gets the cap — the request's timeout and the wait both", async () => {
    // A server that never answers: without the clamp the request would carry
    // a 60 s timeout and the hook would wait the whole of it.
    const seen: Seen = [];
    const recall = new RecallManager(
      clientOf(() => new Promise(() => {}), seen),
      loaded(),
      () => "pr-42",
    );
    recall.queueSearch("does the retry loop cap its backoff?");
    const t0 = Date.now();
    expect(await recall.searchPending(60_000)).toBeNull();
    expect(Date.now() - t0).toBeLessThan(RECALL_WAIT_MS + 200);
    expect(seen.map((s) => s.path)).toEqual(["/api/v1/search/search"]);
    expect(seen[0]!.timeoutMs).toBeGreaterThan(0);
    expect(seen[0]!.timeoutMs).toBeLessThanOrEqual(RECALL_WAIT_MS);
  });

  it("sends nothing past the deadline — no /search/recall, no raw-find fallback", async () => {
    const seen: Seen = [];
    // The context face 'aborts' at its timeout (what the real client does).
    const recall = new RecallManager(
      clientOf(
        (_p, _i, timeoutMs) =>
          new Promise((r) =>
            setTimeout(() => r({ ok: false, status: 0, error: { message: "aborted" } }), timeoutMs),
          ),
        seen,
      ),
      loaded(),
      () => "pr-42",
    );
    recall.queueSearch("does the retry loop cap its backoff?");
    expect(await recall.searchPending(30)).toBeNull();
    await new Promise((r) => setTimeout(r, 60));
    expect(seen.map((s) => s.path)).toEqual(["/api/v1/search/search"]);
  });

  it("a fast answer is injected; inside the budget a failure may still fall back", async () => {
    const recall = new RecallManager(
      clientOf(async () => SEARCH_OK([entry("a.md", "cap the backoff at 30 s")])),
      loaded(),
      () => "pr-42",
    );
    recall.queueSearch("does the retry loop cap its backoff?");
    const block = await recall.searchPending();
    expect(block).toContain("cap the backoff at 30 s");
    expect(recall.injectRecall([{ role: "user", content: "q" }])[0].content).toContain(
      "<openviking-context>",
    );
    // A context face that fails FAST leaves budget for the /search/recall
    // preset — the fallback is bounded, not banned.
    const seen: Seen = [];
    const fallback = new RecallManager(
      clientOf(
        async (path) =>
          path === "/api/v1/search/search"
            ? { ok: false, status: 500, error: { message: "boom" } }
            : { ok: true, status: 200, result: { rendered: "<memory>from the preset</memory>" } },
        seen,
      ),
      loaded(),
      () => "pr-42",
    );
    fallback.queueSearch("does the retry loop cap its backoff?");
    expect(await fallback.searchPending()).toContain("from the preset");
    expect(seen.map((x) => x.path)).toEqual(["/api/v1/search/search", "/api/v1/search/recall"]);
  });

  it("query expansion is OFF in code — config.json, the env override and the request body", async () => {
    expect(JSON.parse(read("config.json")).recallQueryExpansion).toBe("off");
    const prior = process.env.OPENVIKING_RECALL_QUERY_EXPANSION;
    process.env.OPENVIKING_RECALL_QUERY_EXPANSION = "auto";
    try {
      const cfg = loaded();
      expect(cfg.recallQueryExpansion).toBe("off");
      expect(cfg.recallQueryExpansionConfigured).toBe(true);
      const seen: Seen = [];
      const recall = new RecallManager(
        clientOf(async () => SEARCH_OK([]), seen),
        cfg,
        () => "pr-42",
      );
      recall.queueSearch("does the retry loop cap its backoff?");
      await recall.searchPending();
      expect(seen[0]!.body).toMatchObject({
        mode: "context",
        session_id: "pr-42",
        query_expansion: "off",
      });
    } finally {
      if (prior === undefined) delete process.env.OPENVIKING_RECALL_QUERY_EXPANSION;
      else process.env.OPENVIKING_RECALL_QUERY_EXPANSION = prior;
    }
    expect(code("config.ts")).toMatch(
      /config\.recallQueryExpansion = "off";\s*config\.recallQueryExpansionConfigured = true;/,
    );
  });

  it("a retired entry is never recalled: excluded by the daemon's list, dropped by its own header", async () => {
    const seen: Seen = [];
    const retiredUri = `${ROOT}/experiences/old.md`;
    const recall = new RecallManager(
      clientOf(
        async () =>
          SEARCH_OK([
            entry("live.md", "cap the backoff at 30 s"),
            // Retired since the daemon last published — its header says so.
            entry("fresh-retire.md", "#retired #feedback the backoff is uncapped"),
            // Retire quoted in prose is NOT a retirement (header-only rule).
            entry("quote.md", 'the author said "mark it #retired" — still live'),
          ]),
        seen,
      ),
      loaded(),
      () => "pr-42",
      { retiredUris: () => [retiredUri] },
    );
    recall.queueSearch("does the retry loop cap its backoff?");
    const block = (await recall.searchPending())!;
    expect(seen[0]!.body?.["exclude_uris"]).toEqual([retiredUri]);
    expect(block).toContain("cap the backoff at 30 s");
    expect(block).toContain("still live");
    expect(block).not.toContain("uncapped");
    // The re-rendered block keeps the server's envelope.
    expect(block).toContain(`<memory uri="${ROOT}/experiences/live.md" type="experiences"`);
  });

  it("the header rule is the store's own — pinned against parseHashTags", () => {
    for (const text of [
      "#retired x",
      "#feedback #retired kind=bug pr=1 x",
      "#RETIRED x",
      "#feedback kind=bug #retired x",
      "x #retired",
      'quote "#retired"',
      "",
      "   #retired",
      "#retired-ish x",
    ]) {
      expect(hasRetiredHeader(text), text).toBe(parseHashTags(text).includes("retired"));
    }
  });

  it("reads the daemon's published list totally, capped at the server's 200", () => {
    const dir = mkdtempSync(join(tmpdir(), "qcr-retired-"));
    const file = join(dir, "retired-uris.json");
    expect(readRetiredUris(undefined)).toEqual([]);
    expect(readRetiredUris(join(dir, "missing.json"))).toEqual([]);
    writeFileSync(file, "{not json");
    expect(readRetiredUris(file)).toEqual([]);
    writeFileSync(
      file,
      JSON.stringify({
        uris: [
          ...Array.from({ length: 250 }, (_, i) => `${ROOT}/experiences/${i}.md`),
          "https://elsewhere",
          42,
        ],
      }),
    );
    const uris = readRetiredUris(file);
    expect(uris).toHaveLength(MAX_RECALL_EXCLUSIONS);
    expect(uris.every((u) => u.startsWith("viking://"))).toBe(true);
  });

  it("the fallbacks inside the budget are filtered too — /search/recall's entries and the raw find's memories", async () => {
    const retiredUri = `${ROOT}/experiences/old.md`;
    const live = entry("live.md", "cap the backoff at 30 s");
    const byList = { ...entry("old.md", "the backoff is uncapped") };
    const byHeader = entry("fresh-retire.md", "#retired #feedback the backoff is uncapped");
    type Answer = { ok: boolean; result: Record<string, unknown> };
    const guarded = retiredGuard(
      async (path): Promise<Answer> =>
        path === "/api/v1/search/recall"
          ? {
              ok: true,
              result: {
                entries: [live, byList, byHeader],
                rendered: "<memory>all three, as the server rendered them</memory>",
                digest: "written from all three",
              },
            }
          : {
              ok: true,
              result: {
                memories: [
                  { uri: retiredUri, abstract: "the backoff is uncapped" },
                  { uri: byHeader.uri, abstract: "#retired the backoff is uncapped" },
                  { uri: live.uri, abstract: "cap the backoff at 30 s" },
                ],
              },
            },
      () => [retiredUri],
    );
    const body = { method: "POST", body: JSON.stringify({ query: "q" }) };
    const preset = (await guarded("/api/v1/search/recall", body)) as Answer;
    expect((preset.result["entries"] as Array<{ uri: string }>).map((e) => e.uri)).toEqual([
      live.uri,
    ]);
    expect(preset.result["rendered"]).toBe(renderContextEntry(live));
    expect(preset.result["digest"]).toBe("");
    const find = (await guarded("/api/v1/search/find", body)) as Answer;
    expect((find.result["memories"] as Array<{ uri: string }>).map((m) => m.uri)).toEqual([
      live.uri,
    ]);
  });

  it("merges the published list after the request's own exclusions, capped at the server's 200", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const guarded = retiredGuard(
      async (_path, init: { body: string }) => (
        seen.push(JSON.parse(init.body) as Record<string, unknown>),
        { ok: true, result: {} }
      ),
      () => Array.from({ length: 150 }, (_, i) => `${ROOT}/experiences/r${i}.md`),
    );
    const have = Array.from({ length: 100 }, (_, i) => `${ROOT}/experiences/h${i}.md`);
    await guarded("/api/v1/search/search", {
      method: "POST",
      body: JSON.stringify({ query: "q", mode: "context", exclude_uris: have }),
    });
    const sent = seen[0]!["exclude_uris"] as string[];
    expect(sent).toHaveLength(MAX_RECALL_EXCLUSIONS);
    expect(sent.slice(0, 100)).toEqual(have);
    expect(sent[100]).toBe(`${ROOT}/experiences/r0.md`);
  });

  it("a list-mode search never gets exclude_uris (the server rejects it there)", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const guarded = retiredGuard(
      async (_path, init: { body: string }) => (
        seen.push(JSON.parse(init.body) as Record<string, unknown>),
        { ok: true, result: {} }
      ),
      () => [`${ROOT}/experiences/old.md`],
    );
    await guarded("/api/v1/search/search", {
      method: "POST",
      body: JSON.stringify({ query: "q" }),
    });
    await guarded("/api/v1/search/recall", {
      method: "POST",
      body: JSON.stringify({ query: "q" }),
    });
    expect(seen[0]!["exclude_uris"]).toBeUndefined();
    expect(seen[1]!["exclude_uris"]).toEqual([`${ROOT}/experiences/old.md`]);
  });

  it("the budget throws once spent — the chain ends before it sends anything", async () => {
    let clock = 1000;
    const sent: string[] = [];
    const f = budgetedFetch(
      async (path, _i, o) => (sent.push(`${path}@${o.timeoutMs}`), { ok: true }),
      1500,
      () => clock,
    );
    await f("/a", undefined, { timeoutMs: 10_000 });
    clock = 1400;
    await f("/b");
    clock = 1500;
    await expect(f("/c")).rejects.toBeInstanceOf(RecallBudgetSpent);
    expect(sent).toEqual(["/a@500", "/b@100"]);
    expect((await raceBudget(Promise.reject(new Error("x")), 50, "fallback")).value).toBe(
      "fallback",
    );
    expect(await raceBudget(Promise.resolve("v"), 0, "fallback")).toEqual({
      value: "fallback",
      timedOut: true,
    });
  });

  describe("nothing commits", () => {
    const stub = () => {
      const calls: string[] = [];
      return {
        calls,
        client: {
          connected: true,
          async getSession(id: string) {
            calls.push(`get ${id}`);
            return { session_id: id, pending_tokens: 999_999 };
          },
          async addMessagePayload() {
            calls.push("add");
            return true;
          },
          async commitSessionResponse() {
            calls.push("commit");
            return { result: { trace_id: "t" } };
          },
          async fetchJSON(path: string) {
            calls.push(`fetch ${path}`);
            return { ok: true, result: {} };
          },
        } as unknown as ConstructorParameters<typeof SyncManager>[0],
      };
    };

    it("a synced turn past any token count neither reads the session nor commits", async () => {
      const { client, calls } = stub();
      const sync = new SyncManager(client, loaded());
      expect(await sync.ensureSession({ OPENVIKING_SESSION_ID: "pr-42" })).toBe(true);
      calls.length = 0;
      const branch = [
        { type: "message", message: { role: "user", content: "hello there, reviewer" } },
        {
          type: "message",
          message: { role: "assistant", content: [{ type: "text", text: "hi" }] },
        },
      ];
      const synced = await sync.syncBranch(branch);
      // The turn WAS synced (per-turn sync stays, R3) — the old code would
      // have read the session here and committed at its 999,999 pending tokens.
      expect(synced.added).toBeGreaterThan(0);
      expect(calls).toContain("add");
      expect(calls.filter((c) => c === "commit" || c.startsWith("get "))).toEqual([]);
      expect(await sync.commit()).toBeNull();
      expect(calls).not.toContain("commit");
    });

    it("a commit an older build queued on disk is dropped on replay, never sent", async () => {
      const dir = mkdtempSync(join(tmpdir(), "qcr-pending-"));
      const prior = process.env.OPENVIKING_PENDING_DIR;
      process.env.OPENVIKING_PENDING_DIR = dir;
      try {
        const { enqueue, listPending } =
          (await import("../extensions/vendor/openviking-pi/shared/pending-queue.mjs")) as unknown as {
            enqueue: (type: string, sessionId: string, payload: unknown) => Promise<unknown>;
            listPending: () => Promise<unknown[]>;
          };
        await enqueue("commitSession", "pr-42", { keep_recent_count: 10 });
        const { client, calls } = stub();
        const sync = new SyncManager(client, loaded());
        await sync.replayPending();
        expect(calls.filter((c) => c.includes("/commit"))).toEqual([]);
        expect(await listPending()).toEqual([]);
      } finally {
        if (prior === undefined) delete process.env.OPENVIKING_PENDING_DIR;
        else process.env.OPENVIKING_PENDING_DIR = prior;
      }
      expect(isCommitPath("/api/v1/sessions/pr-42/commit")).toBe(true);
      expect(isCommitPath("/api/v1/sessions/pr-42/messages")).toBe(false);
      expect(await refuseCommits(async () => ({ ok: true }))("/api/v1/sessions/x/commit")).toEqual(
        COMMIT_REFUSED,
      );
    });

    it("no hook and no command commits — structure", () => {
      const index = code("index.ts");
      const shutdown = index.slice(
        index.indexOf('pi.on("session_shutdown"'),
        index.indexOf('pi.on("agent_end"'),
      );
      expect(shutdown).not.toMatch(/commit/i);
      expect(index).not.toMatch(/sync\.commit\(|takeover\.commitAndAdvance\(|takeover\.shutdown\(/);
      expect(code("sync.ts")).not.toMatch(
        /commitIfNeeded|commitSessionResponse|enqueue\("commitSession"/,
      );
      expect(JSON.parse(read("config.json"))).not.toHaveProperty("commitTokenThreshold");
    });
  });

  it("the context hook awaits recall on the capped budget, and only there", () => {
    const index = code("index.ts");
    const hook = index.slice(index.indexOf('pi.on("context"'), index.indexOf('pi.on("tool_call"'));
    expect(hook).toContain("await recall.searchPending(RECALL_WAIT_MS);");
    expect(index.match(/searchPending\(/g)).toHaveLength(1);
    // The retired list comes from the file the daemon publishes.
    expect(index).toContain("readRetiredUris(process.env[RETIRED_FILE_ENV])");
    expect(RETIRED_FILE_ENV).toBe("QCR_OV_RETIRED_FILE");
  });

  it("ships the patch, recorded in the series, with its markers", () => {
    expect(upstream.patches).toContain("0007-bounded-recall-no-commit.patch");
    const patch = read(join("patches", "0007-bounded-recall-no-commit.patch"));
    expect(patch).toContain("QCR PATCH 7");
    for (const f of [
      "qcr-recall.ts",
      "recall.ts",
      "sync.ts",
      "index.ts",
      "config.ts",
      "config.json",
    ]) {
      expect(patch).toContain(`b/extensions/vendor/openviking-pi/${f}`);
    }
    expect(read("NOTICE")).toContain("7. The context hook waits at most 500 ms for recall");
    expect(read("README.md")).toContain("### 0007 — bounded recall, no commit");
  });
});

// ---- PATCH 8 (S5) ----------------------------------------------------

describe("PATCH 8 — a PR session recalls for its PR, inside the round's areas", () => {
  const ROOT = "viking://user/reviewer/memories";
  const hintDirs: string[] = [];
  afterAll(() => {
    for (const d of hintDirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const hintFile = (body: unknown) => {
    const d = mkdtempSync(join(tmpdir(), "qcr-hint-"));
    hintDirs.push(d);
    const p = join(d, "pr-42.json");
    writeFileSync(p, typeof body === "string" ? body : JSON.stringify(body));
    return p;
  };
  const contextBody = (extra: Record<string, unknown> = {}) => ({
    method: "POST",
    body: JSON.stringify({ query: "q", mode: "context", purpose: "coding", ...extra }),
  });
  const seenBodies: Array<Record<string, unknown>> = [];
  const answering =
    (result: Record<string, unknown>) => async (_path: string, init?: { body?: string }) => {
      if (init?.body) seenBodies.push(JSON.parse(init.body) as Record<string, unknown>);
      return { ok: true, status: 200, result };
    };

  it("reads the daemon's hint, and fails closed to the old behaviour on anything less", () => {
    expect(RECALL_HINT_FILE_ENV).toBe("QCR_OV_RECALL_HINT_FILE");
    expect(
      readRecallHint(hintFile({ query: "  fix auth  — backend .py ", areas: ["experiences"] })),
    ).toEqual({
      query: "fix auth — backend .py",
      areas: ["experiences"],
    });
    // The daemon's areas are the extension's: one constant, two readers.
    expect(readRecallHint(hintFile({ query: "q", areas: ROUND_SEARCH_AREAS }))?.areas).toEqual([
      ...ROUND_SEARCH_AREAS,
    ]);
    expect(readRecallHint(undefined)).toBeNull();
    expect(readRecallHint("")).toBeNull();
    expect(readRecallHint("/nonexistent/qcr-hint.json")).toBeNull();
    expect(readRecallHint(hintFile("{ not json"))).toBeNull();
    expect(readRecallHint(hintFile({ query: "", areas: ["experiences"] }))).toBeNull();
    expect(readRecallHint(hintFile({ query: "q" }))).toBeNull();
    expect(readRecallHint(hintFile({ query: "q", areas: ["../x", 7, "Events"] }))).toBeNull();
    const long = readRecallHint(hintFile({ query: "x".repeat(5000), areas: ["experiences"] }));
    expect(long?.query.length).toBe(MAX_HINT_QUERY_CHARS);
  });

  it("scopes a context search to the hint's areas and drops what comes back from elsewhere", async () => {
    seenBodies.length = 0;
    const guarded = scopeGuard(
      answering({
        entries: [
          {
            uri: `${ROOT}/experiences/l.md`,
            category: "experiences",
            score: 0.7,
            detail: "full",
            text: "a lesson",
          },
          {
            uri: `${ROOT}/events/e.md`,
            category: "events",
            score: 0.7,
            detail: "full",
            text: "an ops note",
          },
          {
            uri: "viking://resources",
            category: "resources",
            score: 0.6,
            detail: "overview",
            text: "blurb",
          },
        ],
        rendered: "server block",
        digest: "d",
      }),
      () => ["experiences"],
    );
    const res = await guarded("/api/v1/search/search", contextBody({ limit: 7 }));
    expect(seenBodies[0]!["quotas"]).toEqual({ experiences: 7 });
    expect(res.result.entries.map((e: { uri: string }) => e.uri)).toEqual([
      `${ROOT}/experiences/l.md`,
    ]);
    expect(res.result.rendered).toContain("a lesson");
    expect(res.result.rendered).not.toContain("ops note");
    expect(res.result.digest).toBe("");
    // The /search/recall preset is scoped the same way, default count.
    seenBodies.length = 0;
    await guarded("/api/v1/search/recall", {
      method: "POST",
      body: JSON.stringify({ query: "q", quotas: { events: 5 } }),
    });
    expect(seenBodies[0]!["quotas"]).toEqual({ experiences: DEFAULT_AREA_QUOTA });
  });

  it("leaves list-mode search alone, filters the raw find, and does nothing without a scope", async () => {
    seenBodies.length = 0;
    const list = scopeGuard(answering({ entries: [] }), () => ["experiences"]);
    await list("/api/v1/search/search", {
      method: "POST",
      body: JSON.stringify({ query: "q", mode: "list" }),
    });
    expect(seenBodies[0]!["quotas"]).toBeUndefined();
    const find = scopeGuard(
      answering({
        memories: [{ uri: `${ROOT}/experiences/a.md` }, { uri: `${ROOT}/preferences/b.md` }],
        resources: [{ uri: "viking://resources/x" }],
        skills: [{ uri: "viking://agent/skills/y" }],
      }),
      () => ["experiences"],
    );
    const found = await find("/api/v1/search/find", { method: "POST", body: "{}" });
    expect(found.result.memories).toEqual([{ uri: `${ROOT}/experiences/a.md` }]);
    expect(found.result.resources).toEqual([]);
    expect(found.result.skills).toEqual([]);
    seenBodies.length = 0;
    const open = scopeGuard(
      answering({ entries: [{ uri: `${ROOT}/events/e.md`, text: "x" }] }),
      () => null,
    );
    const res = await open("/api/v1/search/search", contextBody());
    expect(seenBodies[0]!["quotas"]).toBeUndefined();
    expect(res.result.entries).toHaveLength(1);
    expect(inAreas(`${ROOT}/experiences/x.md`, ["experiences"])).toBe(true);
    expect(inAreas("viking://resources", ["experiences"])).toBe(false);
  });

  it("the recall manager asks with the hint's query, inside its areas, on PATCH 7's budget", async () => {
    const seen: Array<{ path: string; body: Record<string, unknown> | undefined }> = [];
    const client = {
      async fetchJSON(path: string, init?: { body?: string }) {
        seen.push({
          path,
          body: init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : undefined,
        });
        return {
          ok: true,
          status: 200,
          result: {
            entries: [
              {
                uri: `${ROOT}/experiences/l.md`,
                category: "experiences",
                score: 0.7,
                detail: "full",
                text: "lesson for this PR",
              },
              {
                uri: `${ROOT}/events/e.md`,
                category: "events",
                score: 0.7,
                detail: "full",
                text: "ops noise",
              },
            ],
            rendered: "server rendering",
            digest: "",
            stats: {},
          },
        };
      },
    } as unknown as ConstructorParameters<typeof RecallManager>[0];
    const recall = new RecallManager(client, loadConfig(FORK), () => "pr-42");
    recall.queueSearch("fix auth redirect — backend/app .py", ["experiences"]);
    const block = await recall.searchPending(RECALL_WAIT_MS);
    expect(seen[0]!.path).toBe("/api/v1/search/search");
    expect(seen[0]!.body!["query"]).toBe("fix auth redirect — backend/app .py");
    expect(Object.keys(seen[0]!.body!["quotas"] as object)).toEqual(["experiences"]);
    expect(block).toContain("lesson for this PR");
    expect(block).not.toContain("ops noise");
    // Without a scope, the next recall is upstream's, unscoped.
    seen.length = 0;
    recall.queueSearch("an overseer prompt");
    await recall.searchPending(RECALL_WAIT_MS);
    expect(seen[0]!.body!["quotas"]).toBeUndefined();
  });

  it("index.ts reads the hint for every prompt and queues ITS query and areas", () => {
    const index = code("index.ts");
    expect(index).toContain("readRecallHint(process.env[RECALL_HINT_FILE_ENV])");
    expect(index).toContain(
      "recall.queueSearch(hint ? hint.query : event.prompt, hint ? hint.areas : null);",
    );
    expect(index.match(/queueSearch\(/g)).toHaveLength(1);
    // PATCH 7's budget is untouched.
    expect(index).toContain("await recall.searchPending(RECALL_WAIT_MS);");
    expect(code("recall.ts")).toContain("scopeGuard(");
  });

  it("ships the patch, recorded in the series, with its markers", () => {
    expect(upstream.patches).toContain("0008-pr-derived-recall.patch");
    const patch = read(join("patches", "0008-pr-derived-recall.patch"));
    expect(patch).toContain("QCR PATCH 8");
    for (const f of ["qcr-hint.ts", "recall.ts", "index.ts", "NOTICE", "README.md"]) {
      expect(patch).toContain(`b/extensions/vendor/openviking-pi/${f}`);
    }
    expect(read("NOTICE")).toContain("8. A review session's per-prompt recall searches");
    expect(read("README.md")).toContain("### 0008 — PR-derived recall");
  });
});

// ---- PATCH 9 (S7) ----------------------------------------------------

describe("PATCH 9 — a PR session's memory tools stay inside the round's areas", () => {
  const ROOT = "viking://user/reviewer/memories";
  const areas = ["experiences"];
  const files = new Map<string, string>();
  const reader = (p: string) => {
    const v = files.get(p);
    if (v === undefined) throw new Error(`ENOENT ${p}`);
    return v;
  };

  it("scopes a PR session (the hint variable is set) and leaves every other session alone", () => {
    // No hint variable: the overseer, the companion — upstream's tools.
    expect(toolScopeAreas(undefined, reader)).toBeNull();
    expect(toolScopeAreas("  ", reader)).toBeNull();
    // A PR session: the hint's areas.
    files.set("/h/pr-1.json", JSON.stringify({ query: "q", areas: ["experiences", "x-y"] }));
    expect(toolScopeAreas("/h/pr-1.json", reader)).toEqual(["experiences", "x-y"]);
    // A PR session whose hint is not there yet, garbled, or names no usable
    // area FAILS CLOSED to the round's areas — never to "everything".
    expect(toolScopeAreas("/h/absent.json", reader)).toEqual(DEFAULT_ROUND_AREAS);
    files.set("/h/garbled.json", "{ nope");
    expect(toolScopeAreas("/h/garbled.json", reader)).toEqual(DEFAULT_ROUND_AREAS);
    files.set("/h/bad.json", JSON.stringify({ query: "q", areas: ["../cases", 7] }));
    expect(toolScopeAreas("/h/bad.json", reader)).toEqual(DEFAULT_ROUND_AREAS);
    // The fallback is the daemon's own round scope: one list, two readers.
    expect([...DEFAULT_ROUND_AREAS]).toEqual([...ROUND_SEARCH_AREAS]);
  });

  it("reads and search hits stay inside the areas — never a case, an event or a preference", () => {
    expect(memoryAreaOf(`${ROOT}/experiences/a.md`)).toBe("experiences");
    expect(memoryAreaOf(ROOT)).toBe("");
    expect(memoryAreaOf(`${ROOT}/`)).toBe("");
    expect(memoryAreaOf("viking://resources/x")).toBeNull();
    expect(memoryAreaOf("viking://user/reviewer/memories-old/x")).toBeNull();
    expect(readableInScope(`${ROOT}/experiences/a.md`, areas)).toBe(true);
    expect(readableInScope(`${ROOT}/experiences`, areas)).toBe(true);
    for (const uri of [
      `${ROOT}/cases/case-1-r1-0000000000000000.md`,
      `${ROOT}/events/20261007-fb-feedback_comment-1-9.md`,
      `${ROOT}/preferences/pinned/p.md`,
      ROOT,
      `${ROOT}/experiences/../cases/c.md`,
      `${ROOT}/experiences/%2e%2e/cases/c.md`,
      "viking://resources/x",
      "viking://session/pr-1",
      42,
    ])
      expect(readableInScope(uri, areas)).toBe(false);
  });

  it("browsing lists the areas' names and the round's own area — never inside another", () => {
    expect(browsableInScope("viking://", areas)).toBe(true);
    expect(browsableInScope(ROOT, areas)).toBe(true);
    expect(browsableInScope(`${ROOT}/experiences/`, areas)).toBe(true);
    expect(browsableInScope(`${ROOT}/cases`, areas)).toBe(false);
    expect(browsableInScope(`${ROOT}/cases/`, areas)).toBe(false);
    expect(browsableInScope(`${ROOT}/events/x.md`, areas)).toBe(false);
    expect(browsableInScope(`${ROOT}/experiences/../cases`, areas)).toBe(false);
    expect(scopeRefusal(`${ROOT}/cases/c.md`, areas)).toContain(
      "is outside this review session's memory (experiences/)",
    );
    expect(toolScopeNote(areas)).toBe(
      "In this review session the memory tools reach experiences/ only.",
    );
  });

  it("tools.ts applies the scope in all three read tools, asked per call", () => {
    const tools = code("tools.ts");
    expect(tools).toContain("areas?: () => readonly string[] | null;");
    // search: a foreign scope is refused, and the hits are filtered.
    expect(tools).toMatch(
      /if \(areas && typeof params\.scope === "string" && params\.scope\.trim\(\) !== "" && !browsableInScope\(params\.scope, areas\)\)/,
    );
    expect(tools).toMatch(/\.filter\(\(r\) => readableInScope\(r\.uri, areas\)\)/);
    // read and browse refuse before the server is asked.
    const read = tools.slice(
      tools.indexOf('name: "viking_read"'),
      tools.indexOf('name: "viking_browse"'),
    );
    expect(read.indexOf("!readableInScope(params.uri, areas)")).toBeGreaterThan(-1);
    expect(read.indexOf("!readableInScope(params.uri, areas)")).toBeLessThan(
      read.indexOf("readLevel("),
    );
    const browse = tools.slice(tools.indexOf('name: "viking_browse"'));
    expect(browse.indexOf("!browsableInScope(uri, areas)")).toBeGreaterThan(-1);
    expect(browse.indexOf("!browsableInScope(uri, areas)")).toBeLessThan(
      browse.indexOf("statResponse("),
    );
    // Each tool asks for the scope itself — three calls, no cached copy.
    expect(tools.match(/const areas = scopeAreas\(\);/g)).toHaveLength(3);
  });

  it("index.ts hands both registrations the provider, and says the scope in the prompt", () => {
    const index = code("index.ts");
    expect(index).toContain(
      "const toolAreas = () => toolScopeAreas(process.env[RECALL_HINT_FILE_ENV]);",
    );
    expect(index).toContain("registerTools(pi, client, sync, { leaf: true, areas: toolAreas });");
    expect(index).toContain(
      "registerTools(pi, client, sync, { leaf: false, namespaces, areas: toolAreas });",
    );
    expect(index.match(/registerTools\(/g)).toHaveLength(2);
    expect(index).toContain("if (scopedAreas) parts.push(toolScopeNote(scopedAreas));");
  });

  it("the daemon sets the hint variable on PR sessions only", () => {
    const sessions = readFileSync(join(import.meta.dirname, "..", "src", "sessions.ts"), "utf8");
    expect(sessions).toMatch(
      /\.\.\.\(pr === undefined\s*\? \{\}\s*: \{\s*ovSessionId: ovSessionIdForPr\(pr\),\s*recallHintFile: this\.ovRecallHintPath\(session\),\s*\}\)/,
    );
  });

  it("ships the patch, recorded in the series, with its markers", () => {
    expect(upstream.patches).toContain("0009-pr-session-tools-in-round-areas.patch");
    const patch = read(join("patches", "0009-pr-session-tools-in-round-areas.patch"));
    expect(patch).toContain("QCR PATCH 9");
    for (const f of ["qcr-hint.ts", "tools.ts", "index.ts", "NOTICE", "README.md"]) {
      expect(patch).toContain(`b/extensions/vendor/openviking-pi/${f}`);
    }
    expect(read("NOTICE")).toContain("9. A review session's memory search, read and browse tools");
    expect(read("README.md")).toContain(
      "### 0009 — a PR session's memory tools stay in the round's areas",
    );
  });
});

// ---- PATCH 10 (S8) ---------------------------------------------------

describe("PATCH 10 — viking_write writes a typed lesson's header", () => {
  const LESSON_URI = "viking://user/reviewer/memories/experiences/20261007-lesson.md";
  const lesson = {
    kind: "dont-raise",
    lens: ["pass-baseline", "validate"],
    class: "baseline.pre-existing-scope",
    paths: ["backend/**", "**/*.py"],
    evidence: ["pr:5208", "cand:c42", "comment:3853760547"],
  };

  it("names the daemon's built passes and lesson kinds — one list, two readers", () => {
    expect([...FORK_LESSON_LENS_IDS]).toEqual([...ALL_PASSES]);
    expect([...FORK_LESSON_LENS_IDS]).toEqual([...LESSON_LENS_IDS]);
    expect([...FORK_LESSON_KINDS]).toEqual([...LESSON_KINDS]);
  });

  it("renders the header on the first line, and the daemon's reader reads every field back", () => {
    const built = buildWriteRequest({
      uri: LESSON_URI,
      content: "Do not hold a focused PR on X.",
      lesson,
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const first = built.body.split("\n")[0];
    expect(first).toBe(
      "#lesson kind=dont-raise lens=pass-baseline,pass-validate class=baseline.pre-existing-scope paths=backend/**,**/*.py evidence=pr:5208,cand:c42,comment:3853760547",
    );
    expect(built.body).toContain("\n\nDo not hold a focused PR on X.");
    expect(built.tags).toContain("lesson");
    const parsed = parseLesson(built.body);
    expect(parsed).toMatchObject({
      format: "typed",
      kind: "dont-raise",
      lens: ["pass-baseline", "pass-validate"],
      class: "baseline.pre-existing-scope",
      paths: ["backend/**", "**/*.py"],
      evidence: ["pr:5208", "cand:c42", "comment:3853760547"],
      candidates: [42],
      fieldsSource: "header",
    });
  });

  it("refuses an unknown lens id and every malformed field — nothing is built to send", () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ ...lesson, lens: ["pass-baseline", "pass-nope"] }, "Unknown lens id(s): pass-nope"],
      [{ ...lesson, lens: [] }, "lesson.lens must name at least one lens id"],
      [{ ...lesson, kind: "lookfor" }, "lesson.kind must be one of"],
      [{ ...lesson, class: "Not A Slug" }, "lesson.class must be a slug"],
      [{ ...lesson, paths: [] }, "lesson.paths must name at least one path glob"],
      [{ ...lesson, paths: ["src/{a,b}.ts"] }, "may not contain whitespace or a comma"],
      [{ ...lesson, evidence: [] }, "lesson.evidence must cite at least one ref"],
      [{ ...lesson, evidence: ["PR 5208"] }, "must be <kind>:<id>"],
      [{ ...lesson, extra: 1 }, "Unknown lesson field(s): extra"],
    ];
    for (const [bad, why] of cases) {
      const built = buildWriteRequest({ uri: LESSON_URI, content: "x", lesson: bad });
      expect(built.ok, why).toBe(false);
      if (!built.ok) expect(built.error).toContain(why);
    }
  });

  it("agrees with the daemon's validator, case for case", () => {
    const inputs: unknown[] = [
      lesson,
      { ...lesson, lens: "pass-baseline,pass-ui" },
      { ...lesson, lens: ["ui"] },
      { ...lesson, lens: ["pass-nope"] },
      { ...lesson, kind: "convention" },
      { ...lesson, kind: "nope" },
      { ...lesson, class: "x" },
      { ...lesson, class: "" },
      { ...lesson, paths: ["**"] },
      { ...lesson, evidence: ["cand:c1"] },
      { ...lesson, evidence: ["bad ref"] },
      null,
      [],
      "lesson",
    ];
    for (const input of inputs) {
      const fork = buildLessonHeader(input);
      const daemon = validateLessonFields(input);
      expect(fork.ok, JSON.stringify(input)).toBe(daemon.ok);
      if (!fork.ok && !daemon.ok) expect(fork.error).toBe(daemon.error);
    }
  });

  it("writes a lesson only into experiences/, and never over a hand-typed header", () => {
    for (const uri of [
      "viking://user/reviewer/memories/events/x.md",
      "viking://user/reviewer/memories/preferences/pinned/x.md",
      "viking://user/reviewer/memories/experiences/sub/x.md",
      "viking://resources/x.md",
    ]) {
      const built = buildWriteRequest({ uri, content: "x", lesson });
      expect(built.ok, uri).toBe(false);
      if (!built.ok) expect(built.error).toContain("A lesson is written into experiences/");
    }
    for (const content of ["#lesson kind=look-for oops", "#refuted kind=x prose", ""]) {
      const res = withLessonHeader(LESSON_URI, content, lesson);
      expect(res.ok, content).toBe(false);
    }
    // An entry without `lesson` is unchanged by the patch.
    const plain = buildWriteRequest({ uri: LESSON_URI, content: "plain prose" });
    expect(plain.ok && plain.body).toBe("plain prose\n");
  });

  it("rides a batch per entry, beside plain entries, and refuses a top-level lesson beside entries", () => {
    const batch = buildBatchWriteRequest({
      entries: [
        { uri: LESSON_URI, content: "a lesson", lesson },
        { uri: "viking://user/reviewer/memories/experiences/b.md", content: "plain" },
      ],
    });
    expect(batch.ok).toBe(true);
    if (!batch.ok) return;
    expect(batch.entries[0]!.body.startsWith("#lesson kind=dont-raise")).toBe(true);
    expect(batch.entries[1]!.body).toBe("plain\n");
    const badEntry = buildBatchWriteRequest({
      entries: [{ uri: LESSON_URI, content: "a", lesson: { ...lesson, lens: ["nope"] } }],
    });
    expect(badEntry.ok).toBe(false);
    if (!badEntry.ok) expect(badEntry.error).toContain("Entry 1: Unknown lens id(s): nope");
    const both = buildBatchWriteRequest({ lesson, entries: [{ uri: LESSON_URI, content: "a" }] });
    expect(both.ok).toBe(false);
    // The single form carries `lesson` through.
    const single = buildBatchWriteRequest({ uri: LESSON_URI, content: "one", lesson });
    expect(single.ok && single.entries[0]!.body.startsWith("#lesson ")).toBe(true);
  });

  it("tools.ts takes `lesson` at the top level and per entry, and says how to cite a candidate", () => {
    const tools = code("tools.ts");
    expect(tools.match(/lesson: Type\.Optional\(lessonParam\)/g)).toHaveLength(2);
    expect(tools).toContain("kind: StringEnum(LESSON_KINDS)");
    expect(read("tools.ts")).toContain(
      "Cite the learner candidate a lesson adopts as `cand:c<id>`",
    );
  });

  it("ships the patch, recorded LAST in the series, with its markers", () => {
    expect(upstream.patches.at(-1)).toBe("0010-typed-lessons.patch");
    const patch = read(join("patches", "0010-typed-lessons.patch"));
    expect(patch).toContain("QCR PATCH 10");
    for (const f of ["qcr-lesson.ts", "qcr-write.ts", "tools.ts", "NOTICE", "README.md"]) {
      expect(patch).toContain(`b/extensions/vendor/openviking-pi/${f}`);
    }
    expect(read("NOTICE")).toContain("10. `viking_write` takes a structured `lesson`");
    expect(read("README.md")).toContain(
      "### 0010 — typed lessons: `viking_write` writes the header",
    );
  });
});
