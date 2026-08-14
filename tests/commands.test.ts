import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CommandWatcher, COMMAND_WHITELIST, executeCommand, validateCommand } from "../src/commands.js";
import { StateStore } from "../src/state.js";

function makeDeps() {
  return {
    rerunRound: vi.fn(async () => ({ ok: true, redispatched: true })),
    restartSession: vi.fn(async () => undefined),
    markEscalationWorthy: vi.fn(async () => undefined),
    pausePr: vi.fn(async () => undefined),
    resumePr: vi.fn(async () => undefined),
    flagOwnerLegacy: vi.fn(async () => undefined),
    fileImprovementPr: vi.fn(async () => ({ ok: true, branch: "bot/improve-x" })),
    fileIssue: vi.fn(async () => ({ ok: true, issue: 7 })),
  };
}

describe("validateCommand — whitelist", () => {
  it("accepts every whitelisted command with a valid payload", () => {
    const valid: unknown[] = [
      { command: "rerun-round", pr: 12 },
      { command: "restart-session", pr: 12 },
      { command: "restart-session", pr: "overseer" },
      { command: "mark-escalation-worthy", pr: 12, reason: "touches billing" },
      { command: "pause-pr", pr: 12, reason: "same-head staleness churn" },
      { command: "resume-pr", pr: 12 },
      { command: "flag-owner-legacy", message: "webhook signature failures spiking" },
      { command: "file-improvement-pr", branch: "wip/fix-docs", title: "t", body: "b", slug: "fix-docs" },
      { command: "file-issue", title: "t", body: "b" },
    ];
    for (const v of valid) {
      const res = validateCommand(v);
      expect(res.ok, JSON.stringify(v)).toBe(true);
    }
    expect(COMMAND_WHITELIST).toHaveLength(8);
  });

  it("rejects a command that is not whitelisted — no escape hatch", () => {
    for (const name of ["run-shell", "post-review", "merge-pr", "drop-review", ""]) {
      const res = validateCommand({ command: name, pr: 1 });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.reason).toMatch(/not whitelisted|missing/);
    }
  });

  it("rejects unknown fields (strict schemas)", () => {
    const res = validateCommand({ command: "rerun-round", pr: 12, force: true });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain("unknown field");
    const res2 = validateCommand({ command: "file-issue", title: "t", body: "b", labels: ["x"] });
    expect(res2.ok).toBe(false);
  });

  it("rejects bad field types and missing fields", () => {
    expect(validateCommand({ command: "rerun-round" }).ok).toBe(false);
    expect(validateCommand({ command: "rerun-round", pr: "12" }).ok).toBe(false);
    expect(validateCommand({ command: "rerun-round", pr: -3 }).ok).toBe(false);
    expect(validateCommand({ command: "restart-session", pr: "everything" }).ok).toBe(false);
    expect(validateCommand({ command: "mark-escalation-worthy", pr: 1, reason: "  " }).ok).toBe(false);
    expect(validateCommand({ command: "pause-pr", pr: 1 }).ok).toBe(false); // reason required
    expect(validateCommand({ command: "resume-pr", pr: 1, reason: "x" }).ok).toBe(false); // unknown field
    expect(validateCommand({ command: "flag-owner-legacy", reason: "wrong field name" }).ok).toBe(false);
    expect(validateCommand({ command: "file-improvement-pr", branch: "b", title: "t", body: "y", slug: "Bad Slug" }).ok).toBe(false);
    expect(validateCommand("nope").ok).toBe(false);
    expect(validateCommand([{ command: "rerun-round", pr: 1 }]).ok).toBe(false);
    expect(validateCommand(null).ok).toBe(false);
  });
});

describe("executeCommand", () => {
  it("invokes handlers with parsed payloads", async () => {
    const deps = makeDeps();
    await executeCommand({ command: "rerun-round", pr: 41 }, deps);
    expect(deps.rerunRound).toHaveBeenCalledWith(41);
    await executeCommand({ command: "restart-session", pr: "overseer" }, deps);
    expect(deps.restartSession).toHaveBeenCalledWith("overseer");
    await executeCommand({ command: "mark-escalation-worthy", pr: 9, reason: "schema" }, deps);
    expect(deps.markEscalationWorthy).toHaveBeenCalledWith(9, "schema");
    await executeCommand({ command: "pause-pr", pr: 5266, reason: "same-head churn" }, deps);
    expect(deps.pausePr).toHaveBeenCalledWith(5266, "same-head churn");
    await executeCommand({ command: "resume-pr", pr: 5266 }, deps);
    expect(deps.resumePr).toHaveBeenCalledWith(5266);
    await executeCommand({ command: "flag-owner-legacy", message: "look" }, deps);
    expect(deps.flagOwnerLegacy).toHaveBeenCalledWith("look");
    await executeCommand(
      { command: "file-improvement-pr", branch: "wip/x", title: "t", body: "b", slug: "x" },
      deps,
    );
    expect(deps.fileImprovementPr).toHaveBeenCalledWith({ branch: "wip/x", title: "t", body: "b", slug: "x" });
    await executeCommand({ command: "file-issue", title: "t", body: "b" }, deps);
    expect(deps.fileIssue).toHaveBeenCalledWith({ title: "t", body: "b" });
  });

  it("treats a void return as success", async () => {
    const deps = makeDeps();
    expect(await executeCommand({ command: "flag-owner-legacy", message: "m" }, deps)).toEqual({ ok: true });
  });
});

describe("CommandWatcher", () => {
  let dir: string;
  let store: StateStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "qcr-commands-"));
    mkdirSync(join(dir, "commands"), { recursive: true });
    store = new StateStore(":memory:");
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const cmdDir = (): string => join(dir, "commands");
  const result = (name: string): any => JSON.parse(readFileSync(join(cmdDir(), "results", `${name}.result.json`), "utf8"));

  function watcher(deps: ReturnType<typeof makeDeps>, log: string[] = []): CommandWatcher {
    return new CommandWatcher({ dir: cmdDir(), deps, store, log: (l) => log.push(l), parseAttempts: 2, parseRetryMs: 1 });
  }

  it("startup sweep executes a valid command, writes an ok result and archives the file", async () => {
    writeFileSync(join(cmdDir(), "c1.json"), JSON.stringify({ command: "rerun-round", pr: 5 }));
    const deps = makeDeps();
    await watcher(deps).sweep();
    expect(deps.rerunRound).toHaveBeenCalledWith(5);
    expect(result("c1")).toMatchObject({ ok: true, redispatched: true, command: "rerun-round", file: "c1.json" });
    expect(existsSync(join(cmdDir(), "c1.json"))).toBe(false);
    expect(existsSync(join(cmdDir(), "processed", "c1.json"))).toBe(true);
    expect(store.eventsOn(new Date().toISOString().slice(0, 10)).some((e) => e.kind === "command_executed")).toBe(true);
  });

  it("rejects a non-whitelisted command loudly with a result file and event", async () => {
    writeFileSync(join(cmdDir(), "bad.json"), JSON.stringify({ command: "merge-pr", pr: 5 }));
    const deps = makeDeps();
    const log: string[] = [];
    await watcher(deps, log).sweep();
    const r = result("bad");
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("not whitelisted");
    expect(r.command).toBe("merge-pr");
    expect(log.join("\n")).toContain("REJECTED");
    const rejected = store.eventsOn(new Date().toISOString().slice(0, 10)).filter((e) => e.kind === "command_rejected");
    expect(rejected).toHaveLength(1);
    expect(Object.values(deps).every((fn) => fn.mock.calls.length === 0)).toBe(true);
  });

  it("rejects unknown fields", async () => {
    writeFileSync(join(cmdDir(), "extra.json"), JSON.stringify({ command: "file-issue", title: "t", body: "b", assignee: "x" }));
    const deps = makeDeps();
    await watcher(deps).sweep();
    expect(result("extra")).toMatchObject({ ok: false });
    expect(result("extra").reason).toContain("unknown field");
    expect(deps.fileIssue).not.toHaveBeenCalled();
  });

  it("tolerates a partial write (retries) then rejects genuinely malformed JSON", async () => {
    const path = join(cmdDir(), "half.json");
    writeFileSync(path, '{"command": "rerun-rou');
    const deps = makeDeps();
    const log: string[] = [];
    const w = new CommandWatcher({ dir: cmdDir(), deps, store, log: (l) => log.push(l), parseAttempts: 3, parseRetryMs: 5 });
    // Complete the write while the watcher is retrying.
    setTimeout(() => writeFileSync(path, JSON.stringify({ command: "rerun-round", pr: 8 })), 6);
    await w.handleFile(path);
    expect(deps.rerunRound).toHaveBeenCalledWith(8);
    expect(result("half")).toMatchObject({ ok: true });

    writeFileSync(join(cmdDir(), "junk.json"), "{ this is not json");
    await watcher(deps).sweep();
    const r = result("junk");
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("malformed JSON");
    expect(r.command).toBe(null);
  });

  it("surfaces a handler rejection reason in the result file", async () => {
    writeFileSync(
      join(cmdDir(), "cap.json"),
      JSON.stringify({ command: "file-improvement-pr", branch: "wip/x", title: "t", body: "b", slug: "x" }),
    );
    const deps = makeDeps();
    deps.fileImprovementPr = vi.fn(async () => ({ ok: false, reason: "51 changed lines > cap 50" })) as any;
    await watcher(deps).sweep();
    expect(result("cap")).toMatchObject({ ok: false, reason: "51 changed lines > cap 50", command: "file-improvement-pr" });
  });

  it("catches a throwing handler", async () => {
    writeFileSync(join(cmdDir(), "boom.json"), JSON.stringify({ command: "flag-owner-legacy", message: "m" }));
    const deps = makeDeps();
    deps.flagOwnerLegacy = vi.fn(async () => {
      throw new Error("tmux gone");
    }) as any;
    await watcher(deps).sweep();
    expect(result("boom").reason).toContain("tmux gone");
  });

  it("picks up a file written after start() via fs.watch", async () => {
    const deps = makeDeps();
    const w = watcher(deps);
    await w.start();
    writeFileSync(join(cmdDir(), "live.json"), JSON.stringify({ command: "flag-owner-legacy", message: "hello" }));
    for (let i = 0; i < 50 && deps.flagOwnerLegacy.mock.calls.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    w.stop();
    expect(deps.flagOwnerLegacy).toHaveBeenCalledWith("hello");
  });
});
