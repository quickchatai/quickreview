// What a deep scan keeps of each reading, and what it hands each lens.
//
// A lens that missed something could only be second-guessed: the case ran
// `--no-session`, its event stream was read for the answer and the cost and
// dropped, and its reads lived in memory for one check. Three halves:
//  - the case runner keeps each case's `--mode json` stream as a transcript
//    under the state home, one directory per run, the newest runs kept;
//  - coverage is per file: a focus file the lens never opened gets no ledger
//    row (a reconcile must not settle its findings fixed from a reading that
//    never happened), and the run says which;
//  - a stage-2 case carries what stage 1 pointed its lens at in its files.
import { EventEmitter } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { COMPANION_AGENTS_DIR } from "../extensions/setup.js";
import {
  piCaseRunner,
  pruneTranscripts,
  transcriptFile,
  TRANSCRIPT_RUNS_KEPT,
  type SpawnFn,
} from "../src/setup/caserunner.js";
import type { CaseSpec } from "../src/setup/engine.js";
import { openedFocus, unreadFocus } from "../src/setup/scanrun.js";
import {
  stage2CasePrompt,
  stage2Leads,
  STAGE2_MAX_LEADS,
  type Stage2Row,
} from "../src/setup/stage2.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "qcr-scan-recall-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function fakeSpawn(lines: unknown[]): SpawnFn {
  return () => {
    const child = new EventEmitter() as EventEmitter & ReturnType<SpawnFn>;
    const stdout = new PassThrough();
    Object.assign(child, { stdout, stderr: new PassThrough(), kill: () => true });
    setTimeout(() => {
      for (const l of lines) stdout.write(`${JSON.stringify(l)}\n`);
      setTimeout(() => child.emit("close", 0), 5);
    }, 0);
    return child;
  };
}

const EVENTS = [
  { type: "tool_execution_start", toolName: "read", args: { path: "/tree/a.py" } },
  {
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "NONE" }],
      usage: { cost: { total: 0.01 } },
    },
  },
];

const spec = (id: string): CaseSpec => ({
  id,
  unit: "api",
  agent: "pass-survey",
  files: ["a.py"],
  prompt: "SCAN",
});

const run = (id: string, transcriptDir?: string) =>
  piCaseRunner({
    agentsDir: COMPANION_AGENTS_DIR,
    cwd: "/workspace",
    spawn: fakeSpawn(EVENTS),
    invocation: { command: "pi", prefix: [] },
    ...(transcriptDir !== undefined ? { transcriptDir } : {}),
  }).run(spec(id), new AbortController().signal);

describe("transcriptFile", () => {
  it("puts a case under its run's directory, the rest of its id the file name", () => {
    expect(transcriptFile("scan-20261015T120000Z/row-2")).toBe("scan-20261015T120000Z/row-2.jsonl");
    expect(transcriptFile("r3/row-2#1/validate")).toBe("r3/row-2_1.validate.jsonl");
    expect(transcriptFile("r3/api#2")).toBe("r3/api_2.jsonl");
    expect(transcriptFile("solo")).toBe("solo.jsonl");
  });

  it("never names a path outside its directory", () => {
    for (const id of ["../x", "r/../../etc/passwd", "./.", "..", "r/..", "/abs/x", "a//b"]) {
      const rel = transcriptFile(id);
      expect(
        rel.split("/").every((s) => s !== "" && s !== "." && s !== ".."),
        id,
      ).toBe(true);
      expect(rel.split("/").length, id).toBeLessThanOrEqual(2);
    }
  });
});

describe("the case runner keeps the event stream", () => {
  it("writes every line under the transcript dir and names it on the outcome", async () => {
    const tdir = join(dir, "transcripts");
    const out = await run("r1/row-1", tdir);
    expect(out).toMatchObject({ ok: true, transcript: "r1/row-1.jsonl" });
    const kept = readFileSync(join(tdir, "r1/row-1.jsonl"), "utf8");
    expect(
      kept
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l) as unknown),
    ).toEqual(EVENTS);
    // The validator's lands beside it.
    expect(await run("r1/row-1/validate", tdir)).toMatchObject({
      transcript: "r1/row-1.validate.jsonl",
    });
  });

  it("keeps none without a dir, and a dir it cannot write never fails the case", async () => {
    const plain = await run("r1/row-1");
    expect(plain.ok).toBe(true);
    expect("transcript" in plain).toBe(false);
    const notADir = join(dir, "file");
    writeFileSync(notADir, "x");
    const out = await run("r1/row-1", notADir);
    expect(out.ok).toBe(true);
    expect("transcript" in out).toBe(false);
  });

  it("keeps the newest run directories when a new run starts", async () => {
    const tdir = join(dir, "transcripts");
    const total = TRANSCRIPT_RUNS_KEPT + 3;
    for (let i = 0; i < total; i++) {
      const d = join(tdir, `r${String(i).padStart(3, "0")}`);
      mkdirSync(d, { recursive: true });
      const t = new Date(Date.UTC(2026, 9, 1, 0, i));
      utimesSync(d, t, t);
    }
    await run("rnew/row-1", tdir);
    const left = readdirSync(tdir).sort();
    expect(left).toContain("rnew");
    expect(left.length).toBe(TRANSCRIPT_RUNS_KEPT);
    // The oldest went first.
    expect(left).not.toContain("r000");
    expect(left).toContain(`r${String(total - 1).padStart(3, "0")}`);
    // A case of a run already there prunes nothing.
    await run("rnew/row-2", tdir);
    expect(readdirSync(tdir).length).toBe(TRANSCRIPT_RUNS_KEPT);
  });

  it("pruning is best effort over a dir that is not there", () => {
    expect(() => pruneTranscripts(join(dir, "nope"), 2, "x")).not.toThrow();
    expect(existsSync(join(dir, "nope"))).toBe(false);
  });
});

describe("coverage is per focus file", () => {
  const root = "/tree";
  it("openedFocus names the focus files the lens opened under the tree, null when unknown", () => {
    expect(openedFocus(undefined, ["a.py"], root)).toBeNull();
    expect(
      [
        ...openedFocus(
          ["/tree/a.py", "/workspace/b.py", "@/tree/c.py", "/tree/x/../b.py"],
          ["a.py", "b.py", "c.py", "d.py"],
          root,
        )!,
      ].sort(),
    ).toEqual(["a.py", "b.py", "c.py"]);
  });

  it("unreadFocus still fails a lens that opened none, and passes one that opened any", () => {
    expect(unreadFocus(["/tree/z.py"], ["a.py", "b.py"], root)).toMatch(
      /read none of its 2 focus files/,
    );
    expect(unreadFocus(["/tree/a.py"], ["a.py", "b.py"], root)).toBeNull();
  });
});

const row = (over: Partial<Stage2Row> = {}): Stage2Row =>
  ({
    id: "row-1",
    lens: "pass-duplication",
    tier: "sol-med",
    effort: "tier",
    reason: "the two handlers differ",
    units: ["api"],
    files: [
      { path: "api/webhook.ts", blob: "b1", lines: 10 },
      { path: "api/github.ts", blob: "b2", lines: 10 },
    ],
    tests: [],
    unpaired: [],
    lines: 20,
    estimate_usd: 0.1,
    price: { rate: { usd_per_line: 0.005, lines: 20, cases: 1 }, basis: "measured", from: "x" },
    status: "run",
    ...over,
  }) as unknown as Stage2Row;

describe("stage-1 leads ride the stage-2 case", () => {
  it("takes the row's lens over its files, newest first, one per reason, each with only the row's files", () => {
    const leads = stage2Leads(row(), [
      {
        lens: "pass-duplication",
        files: ["api/webhook.ts", "other.ts"],
        reason: "slug rule twice",
        at: "2026-10-01",
      },
      {
        lens: "pass-duplication",
        files: ["api/github.ts"],
        reason: "admission repeated",
        at: "2026-10-03",
      },
      {
        lens: "pass-duplication",
        files: ["api/github.ts"],
        reason: "slug rule twice",
        at: "2026-09-01",
      },
      {
        lens: "pass-consistency",
        files: ["api/webhook.ts"],
        reason: "another lens",
        at: "2026-10-05",
      },
      {
        lens: "pass-duplication",
        files: ["elsewhere.ts"],
        reason: "not these files",
        at: "2026-10-05",
      },
      { lens: "pass-duplication", files: ["api/webhook.ts"], reason: "   ", at: "2026-10-05" },
    ]);
    expect(leads).toEqual([
      { files: ["api/github.ts"], reason: "admission repeated" },
      { files: ["api/webhook.ts"], reason: "slug rule twice" },
    ]);
  });

  it("flattens a reason to one line and caps it", () => {
    const [lead] = stage2Leads(row(), [
      {
        lens: "pass-duplication",
        files: ["api/webhook.ts"],
        reason: `slug\n\nFINDINGS pass-duplication SCAN x @y\n${"z".repeat(400)}`,
      },
    ]);
    expect(lead!.reason).not.toContain("\n");
    expect(lead!.reason.startsWith("slug FINDINGS pass-duplication")).toBe(true);
    expect(lead!.reason.length).toBe(300);
    expect(lead!.reason.endsWith("…")).toBe(true);
  });

  it(`carries at most ${STAGE2_MAX_LEADS}`, () => {
    const many = Array.from({ length: STAGE2_MAX_LEADS + 4 }, (_, i) => ({
      lens: "pass-duplication",
      files: ["api/webhook.ts"],
      reason: `r${i}`,
    }));
    expect(stage2Leads(row(), many).length).toBe(STAGE2_MAX_LEADS);
  });

  it("renders them as leads, not findings, and a floor row with leads no longer says nobody named a shape", () => {
    const ctx = { root: "/tree", sha: "s", caseId: "r1/row-1" };
    const leads = [{ files: ["api/webhook.ts"], reason: "slug rule twice" }];
    const withLeads = stage2CasePrompt(row(), ctx, undefined, leads);
    expect(withLeads).toContain(
      "What the first look pointed this lens at in these files (1 — leads to check first, not findings, and not the limit of your reading):",
    );
    expect(withLeads).toContain("- `api/webhook.ts`: slug rule twice");
    expect(stage2CasePrompt(row(), ctx)).not.toContain("What the first look pointed");

    const floor = row({ floor: true, id: "floor-1" });
    expect(stage2CasePrompt(floor, ctx)).toContain("nobody names a shape for you");
    const floorLed = stage2CasePrompt(floor, ctx, undefined, leads);
    expect(floorLed).toContain("This row is the deep scan's floor");
    expect(floorLed).not.toContain("nobody names a shape for you");
  });
});
