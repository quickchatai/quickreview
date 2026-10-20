// [P8.4] The offline resume rehearsal (docs/worker-resume-rehearsal.md).
//
// Two halves in one file:
//
//   - the checks, on synthetic PR JSONLs shaped like the live bot's (pi 1.3's
//     stored system message, the native lens tools it advertised, the
//     session-command and inject-bridge markers, custom and compaction entries,
//     a legacy cwd header): the real bot worker resumes each on pi-ai's faux
//     provider and nothing the ticket asks about is allowed to go wrong;
//   - the run over real files, only when QCR_RESUME_REHEARSAL names them (the
//     owner's read-only snapshot of the live PR JSONLs, the transcript mirror,
//     an `archive extract` tree). scripts/worker-resume-rehearsal.sh sets it up
//     and writes the report. The real files are only ever read.
//
// No model and no network anywhere: the faux provider answers, and the offline
// guard fails the file on any connection attempt.
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { extractPr } from "../src/archive/extract.js";
import { REVIEWER_STUB } from "../src/reviewerstub.js";
import {
  LEGACY_SANDBOX_ROOT,
  inspectSessionJsonl,
  legacyCwdResolution,
  legacyMountDirs,
  legacyPathsResolving,
} from "../src/resumecheck.js";
import { onArchiver, prFixture, put } from "./helpers/archive-pr.js";
import { useOfflineGuard } from "./pi-canary/harness.js";
import {
  bornReference,
  rehearseFile,
  type RehearsalRow,
  type RequestShape,
} from "./helpers/resume-rehearsal.js";
import { renderReport, type RunMeta } from "./helpers/resume-rehearsal-report.js";
import { HEAVY_TIMEOUT_MS } from "./helpers/suite-timeouts.js";

useOfflineGuard();

const REPO = resolve(import.meta.dirname, "..");
const STUB = readFileSync(join(REPO, REVIEWER_STUB), "utf8");
const UPDATER = readFileSync(join(REPO, "deploy", "qcr-update.sh"), "utf8");

// ---- synthetic JSONLs --------------------------------------------------------

const ID = "01a15387-d717-75c7-8ddb-f8e0b6866aac";
const NATIVE_TOOLS = [
  "read",
  "bash",
  "edit",
  "write",
  "subagent",
  "launch_plan",
  "cluster_findings",
  "coverage_gaps",
  "viking_search",
];

interface BuildOptions {
  id?: string;
  cwd?: string;
  /** Leave the system message out (a file from before pi stored it). */
  noSystem?: boolean;
  /** Stub text the old session was shown; undefined: the current one. */
  stub?: string;
  compaction?: boolean;
}

/** A PR JSONL as the tmux bot's interactive pi wrote it. */
function botJsonl(o: BuildOptions = {}): string {
  const lines: unknown[] = [];
  let parent: string | null = null;
  let n = 0;
  const push = (entry: Record<string, unknown>): string => {
    const id = `e${String(++n).padStart(7, "0")}`;
    lines.push({
      ...entry,
      id,
      parentId: parent,
      timestamp: `2026-10-12T09:00:${String(n).padStart(2, "0")}.000Z`,
    });
    parent = id;
    return id;
  };
  lines.push({
    type: "session",
    version: 3,
    id: o.id ?? ID,
    timestamp: "2026-10-12T09:00:00.000Z",
    cwd: o.cwd ?? LEGACY_SANDBOX_ROOT,
  });
  push({ type: "session_info", name: "pr-7" });
  push({ type: "model_change", provider: "openai-codex", modelId: "gpt-6.1-sol" });
  push({ type: "thinking_level_change", thinkingLevel: "medium" });
  const ts = 1_760_259_600_000;
  if (!o.noSystem)
    push({
      type: "message",
      message: {
        role: "system",
        content: "",
        sections: {
          preamble:
            "# PR conversation\n\nYou are the review shepherd for PR #7. Dispatch lens passes with the subagent tool.\n",
          project_context: `<project_context>\nProject-specific instructions and guidelines:\n\n<project_instructions path="${LEGACY_SANDBOX_ROOT}/AGENTS.override.md">\n${o.stub ?? STUB}\n</project_instructions>\n</project_context>`,
          cwd: `<cwd>\n${LEGACY_SANDBOX_ROOT}\n</cwd>`,
        },
        toolsAdded: NATIVE_TOOLS.map((name) => ({
          name,
          description: `the ${name} tool`,
          parameters: { type: "object", properties: {} },
        })),
        timestamp: ts,
      },
    });
  const text = (t: string): unknown[] => [{ type: "text", text: t }];
  const assistant = (content: unknown[], stopReason: string): Record<string, unknown> => ({
    type: "message",
    message: {
      role: "assistant",
      content,
      api: "openai-codex-responses",
      provider: "openai-codex",
      model: "gpt-6.1-sol",
      usage: {
        input: 10,
        output: 5,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 15,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason,
      timestamp: ts,
    },
  });
  // Round 1: the session-command ledger's turn and the inject bridge's.
  push({
    type: "message",
    message: {
      role: "user",
      content: text(
        "ROUND ORDER, round 1.\n\n<!-- qcr-command:0fbcf5ac-5c79-4643-9e8a-994e987bfa75:2fbfdbf6 -->",
      ),
      timestamp: ts,
    },
  });
  push(
    assistant(
      [
        {
          type: "toolCall",
          id: "call_1",
          name: "bash",
          arguments: {
            command: `${LEGACY_SANDBOX_ROOT}/scripts/pr-context.sh 7 && ls ${LEGACY_SANDBOX_ROOT}/wt/pr-7`,
          },
        },
      ],
      "toolUse",
    ),
  );
  push({
    type: "message",
    message: {
      role: "toolResult",
      toolCallId: "call_1",
      toolName: "bash",
      content: text("ok"),
      isError: false,
      timestamp: ts,
    },
  });
  push(
    assistant(
      text("Round 1 done.\nLEDGER PR #7 @ abc1234\nF1 [P1/0.9][delivery] a.py:3 - null deref"),
      "stop",
    ),
  );
  push({
    type: "custom",
    customType: "qcr-review-ledger",
    data: {
      pr: 7,
      ledger: "LEDGER PR #7 @ abc1234\nF1 [P1/0.9][delivery] a.py:3 - null deref",
      meta: "PR #7",
    },
  });
  // A ledger entry in the older spelling.
  push({
    type: "custom",
    subtype: "quickreview-ledger",
    ledger: "LEDGER PR #7 @ abc1234",
    meta: "PR #7",
  });
  // And the older pi's, which wrote the entry object itself as the type.
  push({
    type: "custom",
    customType: { type: "custom", subtype: "quickreview-ledger", ledger: "LEDGER PR #7 @ abc1234" },
  });
  const kept = push({
    type: "message",
    message: {
      role: "user",
      content: text("New commits pushed.\n\n<!-- qcr-inject:2026-10-12T10-00-00-000Z-0001.md -->"),
      timestamp: ts,
    },
  });
  push(assistant(text("Round 2 done."), "stop"));
  push({ type: "context_edit", targetId: kept, replacement: null });
  if (o.compaction)
    push({
      type: "compaction",
      summary: "## Goal\nReview PR 7.",
      firstKeptEntryId: kept,
      tokensBefore: 5000,
      fromHook: true,
    });
  return lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
}

let dir: string;
let born: RequestShape;
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "resume-rehearsal-"));
  born = await bornReference();
}, HEAVY_TIMEOUT_MS);
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const written = (name: string, text: string): string => {
  const file = join(dir, name);
  writeFileSync(file, text);
  return file;
};

describe("[P8.4] inspecting a PR JSONL", () => {
  it("counts entries, custom entries, markers and legacy paths; keeps no text", () => {
    const facts = inspectSessionJsonl(written("inspect.jsonl", botJsonl({ compaction: true })), {
      stub: STUB,
    });
    expect(facts.header).toEqual({ id: ID, version: 3, cwd: LEGACY_SANDBOX_ROOT });
    expect(facts.badLines).toBe(0);
    expect(facts.entryTypes).toMatchObject({
      session: 1,
      compaction: 1,
      context_edit: 1,
      custom: 3,
    });
    expect(facts.customTypes).toEqual({ "qcr-review-ledger": 1, "quickreview-ledger": 2 });
    expect(facts.roles).toMatchObject({ system: 1, user: 2, assistant: 3, toolResult: 1 });
    expect(facts.markers).toEqual({ "qcr-command": 1, "qcr-inject": 1 });
    expect(facts.legacyPaths).toEqual({ "AGENTS.override.md": 1, scripts: 1, wt: 1 });
    expect(facts.system).toMatchObject({
      sections: ["preamble", "project_context", "cwd"],
      cwd: LEGACY_SANDBOX_ROOT,
      stub: "current",
    });
    expect(facts.system?.tools).toEqual(NATIVE_TOOLS);
    expect(facts.system?.preambleTools).toEqual(["subagent"]);
    expect(JSON.stringify(facts)).not.toContain("null deref");
  });

  it("tells a drifted or absent context file from the current stub", () => {
    const drifted = inspectSessionJsonl(
      written("drift.jsonl", botJsonl({ stub: "an older guide" })),
      {
        stub: STUB,
      },
    );
    expect(drifted.system?.stub).toBe("drifted");
    const none = inspectSessionJsonl(written("none.jsonl", botJsonl({ noSystem: true })), {
      stub: STUB,
    });
    expect(none.system).toBeNull();
    expect(inspectSessionJsonl(written("un.jsonl", botJsonl())).system?.stub).toBe("unchecked");
  });

  it("counts a line that is not JSON and a file with no session header", () => {
    const facts = inspectSessionJsonl(written("bad.jsonl", `{"type":"message"}\nnot json\n[1]\n`));
    expect(facts.badLines).toBe(2);
    expect(facts.header).toBeNull();
  });
});

describe("[P8.4] legacy cwd headers under the release image's mounts", () => {
  const mounts = legacyMountDirs(UPDATER, "clone");

  it("reads the updater's legacy mounts: the worktrees and the base clone", () => {
    expect(mounts).toEqual(["clone", "wt"]);
  });

  it("resolves the three header shapes, and nothing else", () => {
    expect(legacyCwdResolution(LEGACY_SANDBOX_ROOT, mounts)).toBe("mount-parent");
    expect(legacyCwdResolution(`${LEGACY_SANDBOX_ROOT}/`, mounts)).toBe("mount-parent");
    expect(legacyCwdResolution(`${LEGACY_SANDBOX_ROOT}/wt`, mounts)).toBe("mount");
    expect(legacyCwdResolution(`${LEGACY_SANDBOX_ROOT}/wt/pr-5841`, mounts)).toBe("under-mount");
    expect(legacyCwdResolution(`${LEGACY_SANDBOX_ROOT}/clone/src`, mounts)).toBe("under-mount");
    expect(legacyCwdResolution(`${LEGACY_SANDBOX_ROOT}/scripts`, mounts)).toBe("unmounted");
    expect(legacyCwdResolution(`${LEGACY_SANDBOX_ROOT}/wtx/pr-1`, mounts)).toBe("unmounted");
    expect(legacyCwdResolution("/srv/elsewhere", mounts)).toBe("unmounted");
  });

  it("splits a history's legacy path references by whether the image mounts them", () => {
    expect(legacyPathsResolving({ wt: 3, scripts: 2, state: 1 }, mounts)).toEqual({
      resolving: { wt: 3 },
      gone: { scripts: 2, state: 1 },
    });
  });
});

describe("[P8.4] the worker resumes a bot-shaped JSONL on the faux", () => {
  it(
    "keeps the id, the file and every earlier line; the cache key is the id; no model is called",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      const row = await rehearseFile(written("a.jsonl", botJsonl()), "synthetic", born);
      expect(row.problems).toEqual([]);
      expect(row).toMatchObject({
        exit: 0,
        resumed: true,
        idKept: true,
        fileKept: true,
        appendOnly: true,
        newFiles: [],
        providerRequests: 1,
        cacheKeyIsId: true,
        historyKept: true,
      });
      expect(row.sent?.sessionId).toBe(ID);
    },
  );

  it(
    "sends the stored prompt sections and tools as they were, and announces the engine's tools after the history",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      const row = await rehearseFile(written("b.jsonl", botJsonl()), "synthetic", born);
      // The prefix the old session cached against is replayed verbatim.
      expect(row.sectionsVsStored).toEqual({
        preamble: "same",
        project_context: "same",
        cwd: "same",
      });
      expect(row.sent?.tools).toEqual(NATIVE_TOOLS);
      // The tail: a system message with what the worker adds, then the order.
      expect(row.sent?.tail).toEqual(["system", "user"]);
      expect(row.addedTools).toEqual(expect.arrayContaining(["lens", "lens_wave"]));
      // And what the old file advertises that this worker does not register.
      expect(row.staleTools).toEqual(expect.arrayContaining(["subagent", "launch_plan"]));
      expect(row.staleTools).not.toContain("bash");
      expect(row.systemVsBorn).toBe("differs");
      expect(row.facts.system?.stub).toBe("current");
    },
  );

  it(
    "tolerates the custom, context_edit and compaction entries, the markers and a wt/pr-N cwd",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      const text = botJsonl({ compaction: true, cwd: `${LEGACY_SANDBOX_ROOT}/wt/pr-7` });
      const row = await rehearseFile(written("c.jsonl", text), "synthetic", born);
      expect(row.problems).toEqual([]);
      expect(row.facts.entryTypes).toMatchObject({ compaction: 1, context_edit: 1, custom: 3 });
      expect(row.facts.markers).toMatchObject({ "qcr-command": 1, "qcr-inject": 1 });
      expect(row.facts.header?.cwd).toBe(`${LEGACY_SANDBOX_ROOT}/wt/pr-7`);
    },
  );

  it(
    "resumes a file that carries no stored system message, under its id",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      const row = await rehearseFile(
        written("d.jsonl", botJsonl({ noSystem: true })),
        "synthetic",
        born,
      );
      expect(row.problems).toEqual([]);
      expect(row.facts.system).toBeNull();
      expect(row.idKept).toBe(true);
    },
  );

  it(
    "reports, instead of passing, a file whose header is not a session",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      const broken = botJsonl().replace('"type":"session"', '"type":"session_x"');
      const row = await rehearseFile(written("e.jsonl", broken), "synthetic", born);
      expect(row.problems.length).toBeGreaterThan(0);
      expect(row.problems.join(";")).toMatch(
        /no session header|cannot open|did not resume|not kept/,
      );
    },
  );
});

describe("[P8.4] an archived PR: qcr archive extract, then the resume", () => {
  it(
    "the extracted transcript is byte-identical and the worker resumes it under its id",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      const f = prFixture();
      try {
        const sdir = `state/pi-sessions/pr-${f.pr}`;
        const rel = `${sdir}/2026-10-12T09-00-00-000Z_${ID}.jsonl`;
        const text = botJsonl();
        put(f.root, rel, text, Date.parse("2026-10-12T09:30:00Z"));
        const a = onArchiver(f);
        await a.tick();
        a.stop();
        const to = join(mkdtempSync(join(tmpdir(), "resume-extract-")), "out");
        try {
          const r = await extractPr({
            root: f.root,
            sessionsRoot: join(f.root, "state", "pi-sessions"),
            pr: f.pr,
            to,
            bytesPerS: 200 * 1024 * 1024,
          });
          expect(r.ok).toBe(true);
          const out = join(to, "transcripts", `2026-10-12T09-00-00-000Z_${ID}.jsonl`);
          expect(readFileSync(out, "utf8")).toBe(text);
          const row = await rehearseFile(out, "archive", born);
          expect(row.problems).toEqual([]);
          expect(row.idKept).toBe(true);
        } finally {
          rmSync(join(to, ".."), { recursive: true, force: true });
        }
      } finally {
        f.close();
      }
    },
  );
});

describe("[P8.4] the report", () => {
  it("prints counts and hashes, never a PR number, a session id or a path of the machine", async () => {
    const row = await rehearseFile(written("r.jsonl", botJsonl()), "synthetic", born);
    const bad: RehearsalRow = {
      ...row,
      file: "secret-pr-5841.jsonl",
      problems: ["an earlier line changed"],
    };
    const meta: RunMeta = {
      date: "2026-10-19",
      commit: "abc1234",
      sources: [{ label: "synthetic", what: "A synthetic file." }],
      mountDirs: legacyMountDirs(UPDATER, "<clone>"),
      canary10: [{ file: "tests/pi-canary/canary-10-bot-request.test.ts", tests: 4, passed: true }],
    };
    const doc = renderReport(new Map([["synthetic", [row, bad]]]), meta);
    expect(doc).toContain("**1 resumed with every check green, 1 not.**");
    expect(doc).toContain("an earlier line changed");
    expect(doc).not.toContain("secret-pr-5841");
    expect(doc).not.toContain(ID);
    expect(doc).not.toMatch(/\/home\//);
  });
});

// ---- the run over real files -------------------------------------------------

interface Source {
  label: string;
  what: string;
  dir: string;
}

/** A run over hundreds of real transcripts, some tens of MB each. */
const REAL_RUN_TIMEOUT_MS = 3 * 60 * 60_000;

const spec = process.env["QCR_RESUME_REHEARSAL"];
const out = process.env["QCR_RESUME_REHEARSAL_OUT"];

/** Every *.jsonl under `dir`, sorted. Symbolic links are not followed. */
function jsonlUnder(root: string): string[] {
  const found: string[] = [];
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && e.name.endsWith(".jsonl")) found.push(p);
    }
  };
  walk(root);
  return found.sort();
}

describe.skipIf(!spec)("[P8.4] the rehearsal over real PR JSONLs", () => {
  it(
    "resumes every file, and writes the report when QCR_RESUME_REHEARSAL_OUT is set",
    { timeout: REAL_RUN_TIMEOUT_MS },
    async () => {
      const sources = JSON.parse(spec!) as Source[];
      const bySource = new Map<string, RehearsalRow[]>();
      for (const s of sources) {
        expect(statSync(s.dir).isDirectory(), s.dir).toBe(true);
        const rows: RehearsalRow[] = [];
        for (const file of jsonlUnder(s.dir)) rows.push(await rehearseFile(file, s.label, born));
        bySource.set(s.label, rows);
        expect(rows.length, `${s.label} holds JSONL files`).toBeGreaterThan(0);
      }
      const canaryPath = process.env["QCR_RESUME_REHEARSAL_CANARY_JSON"];
      const canary = canaryPath
        ? (
            JSON.parse(readFileSync(canaryPath, "utf8")) as {
              testResults: Array<{ name: string; status: string; assertionResults: unknown[] }>;
            }
          ).testResults.map((t) => ({
            file: t.name.slice(t.name.indexOf("tests/")),
            tests: t.assertionResults.length,
            passed: t.status === "passed",
          }))
        : [];
      const meta: RunMeta = {
        date: new Date().toISOString().slice(0, 10),
        commit: process.env["QCR_RESUME_REHEARSAL_COMMIT"] ?? "unknown",
        sources: sources.map((s) => ({ label: s.label, what: s.what })),
        mountDirs: legacyMountDirs(UPDATER, "<clone>"),
        canary10: canary,
      };
      if (out) {
        mkdirSync(resolve(out, ".."), { recursive: true });
        writeFileSync(out, renderReport(bySource, meta));
      }
      const failed = [...bySource.values()].flat().filter((r) => r.problems.length > 0);
      expect(
        failed.map((r) => r.problems.join("; ")),
        "every JSONL resumed with every check green",
      ).toEqual([]);
    },
  );
});
