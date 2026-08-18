import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MUTATION_KINDS, MutationGate, type MutationIntent } from "../src/gate.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "qcr-gate-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const intent: MutationIntent = {
  kind: "add_label",
  method: "POST",
  path: "/repos/o/r/issues/7/labels",
  body: { labels: ["AI review in progress"] },
  note: 'add label "AI review in progress" to #7',
  pr: 7,
};

describe("MutationGate in dry-run", () => {
  it("writes the intent to a file and never calls the executor", async () => {
    const executor = vi.fn(async () => ({ ok: true }));
    const gate = new MutationGate(true, join(dir, "dryrun"), executor);

    const result = await gate.execute(intent);

    expect(gate.isDryRun).toBe(true);
    expect(executor).not.toHaveBeenCalled();
    expect(result.executed).toBe(false);
    expect(result.response).toBeUndefined();
    expect(result.dryRunFile).toBeTruthy();

    const record = JSON.parse(readFileSync(result.dryRunFile!, "utf8"));
    expect(record).toMatchObject({
      kind: "add_label",
      method: "POST",
      path: "/repos/o/r/issues/7/labels",
      body: { labels: ["AI review in progress"] },
      pr: 7,
    });
    expect(record.note).toContain("#7");
    expect(typeof record.recorded_at).toBe("string");
  });

  it("names files by timestamp + sequence + kind, one per intent", async () => {
    const gate = new MutationGate(true, join(dir, "dryrun"), async () => undefined, () => new Date("2026-08-13T10:00:00.000Z"));
    await gate.execute(intent);
    await gate.execute({ ...intent, kind: "remove_label", method: "DELETE" });

    const files = readdirSync(join(dir, "dryrun")).sort();
    expect(files).toHaveLength(2);
    expect(files.some((f) => f.endsWith("-add_label.json"))).toBe(true);
    expect(files.some((f) => f.endsWith("-remove_label.json"))).toBe(true);
    for (const f of files) expect(f.startsWith("2026-08-13T10-00-00-000Z-")).toBe(true);
  });

  it("creates the dryrun directory on demand", async () => {
    const nested = join(dir, "state", "dryrun");
    expect(existsSync(nested)).toBe(false);
    await new MutationGate(true, nested, async () => undefined).execute(intent);
    expect(existsSync(nested)).toBe(true);
  });
});

describe("MutationGate live", () => {
  it("calls the executor, returns its response, and writes nothing", async () => {
    const executor = vi.fn(async (i: MutationIntent) => ({ echoed: i.path }));
    const dryrunDir = join(dir, "dryrun");
    const gate = new MutationGate(false, dryrunDir, executor);

    const result = await gate.execute(intent);

    expect(gate.isDryRun).toBe(false);
    expect(executor).toHaveBeenCalledOnce();
    expect(executor.mock.calls[0]![0]).toBe(intent);
    expect(result).toEqual({ executed: true, response: { echoed: "/repos/o/r/issues/7/labels" } });
    expect(existsSync(dryrunDir)).toBe(false);
  });

  it("propagates executor failures", async () => {
    const gate = new MutationGate(false, join(dir, "dryrun"), async () => {
      throw new Error("422 unprocessable");
    });
    await expect(gate.execute(intent)).rejects.toThrow(/422/);
  });
});

describe("the closed mutation vocabulary", () => {
  it("enumerates only the intended kinds — no review-retraction kind exists", () => {
    expect([...MUTATION_KINDS].sort()).toEqual(
      [
        "add_label",
        "create_issue",
        "create_pull",
        "create_review",
        "create_review_comment_reply",
        "delete_team_review_request",
        "push_branch",
        "remove_label",
        // Bot-owned inline threads may be resolved after a checked author
        // response; this does not alter or dismiss a review verdict.
        "resolve_own_review_thread",
        // The one review-verdict-mutating kind, ratified by the owner 2026-08-13:
        // the bot superseding ITS OWN stale non-APPROVED review. No kind
        // for dismissing approvals or another identity's review exists.
        "supersede_own_review",
      ].sort(),
    );
    // request_reviewer was retired with the escalation mechanics (2026-08-18).
    expect(MUTATION_KINDS).not.toContain("request_reviewer");
  });

  it("the runtime list matches the compile-time union, so neither can drift", () => {
    const src = readFileSync(new URL("../src/gate.ts", import.meta.url), "utf8");
    const union = src
      .slice(src.indexOf("export type MutationKind"), src.indexOf("/**\n * The same set at RUNTIME"))
      .split("\n")
      .filter((l) => !l.trim().startsWith("//")) // comments name retired kinds
      .join("\n");
    const declared = [...new Set((union.match(/"[a-z_]+"/g) ?? []).map((s) => s.replace(/"/g, "")))];
    expect(declared.sort()).toEqual([...MUTATION_KINDS].sort());
  });

  it("rejects an unknown kind at runtime, recording nothing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "qcr-gate-kind-"));
    const gate = new MutationGate({ dryRun: true, dryrunDir: dir, executor: async () => ({}) });
    await expect(
      gate.execute({ kind: "request_reviewer" as never, method: "POST", path: "/x", note: "smuggled", pr: 1 }),
    ).rejects.toThrow(/unknown mutation kind/);
    expect(readdirSync(dir)).toHaveLength(0);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("forceLive (supersede_own_review only — the owner, 2026-08-13)", () => {
  const supersede: MutationIntent = {
    kind: "supersede_own_review",
    method: "PUT",
    path: "/repos/o/r/pulls/7/reviews/99/dismissals",
    body: { message: "superseded by round 4 review" },
    note: "supersede own stale RC review on #7",
    pr: 7,
    forceLive: true,
  };

  it("executes supersede_own_review for real even in dry-run (no dryrun record)", async () => {
    const executor = vi.fn(async () => ({ ok: true }));
    const gate = new MutationGate(true, join(dir, "dryrun"), executor);
    const result = await gate.execute(supersede);
    expect(executor).toHaveBeenCalledOnce();
    expect(result.executed).toBe(true);
    expect(existsSync(join(dir, "dryrun"))).toBe(false);
  });

  it("refuses forceLive on every other kind — the dry-run bypass cannot widen", async () => {
    const executor = vi.fn(async () => ({ ok: true }));
    const gate = new MutationGate(true, join(dir, "dryrun"), executor);
    for (const kind of ["add_label", "create_review", "push_branch", "create_pull"] as const) {
      await expect(gate.execute({ ...intent, kind, forceLive: true })).rejects.toThrow(/forceLive is not allowed/);
    }
    expect(executor).not.toHaveBeenCalled();
  });

  it("without forceLive, supersede_own_review dry-runs like everything else", async () => {
    const executor = vi.fn(async () => ({ ok: true }));
    const gate = new MutationGate(true, join(dir, "dryrun"), executor);
    const result = await gate.execute({ ...supersede, forceLive: undefined });
    expect(executor).not.toHaveBeenCalled();
    expect(result.executed).toBe(false);
    expect(readdirSync(join(dir, "dryrun"))).toHaveLength(1);
  });
});
