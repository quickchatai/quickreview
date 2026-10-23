import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  watch,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  authorizeCommand,
  CommandWatcher,
  COMMAND_WHITELIST,
  executeCommand,
  validateCommand,
  type Command,
} from "../src/commands.js";
import type { OriginRecord } from "../src/slack/origin.js";
import { StateStore } from "../src/state.js";
import { waitFor } from "./helpers/wait-for.js";

function makeDeps() {
  return {
    slackReply: vi.fn(async () => ({ ok: true, ts: "1712345678.000100" })),
    rerunRound: vi.fn(async () => ({ ok: true, redispatched: true })),
    restartSession: vi.fn(async () => undefined),
    resolveTerminalFailure: vi.fn(async () => ({ ok: true, disposition: "closed" })),
    pausePr: vi.fn(async () => undefined),
    resumePr: vi.fn(async () => undefined),
    flagOwner: vi.fn(async () => undefined),
    fileImprovementPr: vi.fn(async () => ({ ok: true, branch: "bot/improve-x" })),
    fileIssue: vi.fn(async () => ({ ok: true, issue: 7 })),
    retryThreadDecision: vi.fn(async () => ({ ok: true, file: "x.json" })),
    curationReceipt: vi.fn(async () => ({ ok: true })),
  };
}

/** Until the watcher's own work queue is empty — every command it queued has
 * run — rather than a count of ticks. */
async function drained(w: CommandWatcher): Promise<void> {
  const q = () => (w as unknown as { queue: Promise<void> }).queue;
  for (let p = q(); ; p = q()) {
    await p;
    if (p === q()) return;
  }
}

describe("validateCommand — whitelist", () => {
  it("passes the watcher delivery identity to both filing handlers", async () => {
    const deps = makeDeps();
    const context = {
      file: "owner/fix",
      delivery_key: "exact-file-version",
      issuer: "operator" as const,
    };
    await executeCommand({ command: "file-issue", title: "t", body: "b" }, deps, context);
    expect(deps.fileIssue).toHaveBeenCalledWith({ title: "t", body: "b" }, "exact-file-version");
    await executeCommand(
      { command: "file-improvement-pr", title: "t", body: "b", branch: "wip/fix", slug: "fix" },
      deps,
      context,
    );
    expect(deps.fileImprovementPr).toHaveBeenCalledWith(
      { title: "t", body: "b", branch: "wip/fix", slug: "fix" },
      "exact-file-version",
    );
  });

  it("uses trusted delivery identity for Slack reply and operator lesson keys", async () => {
    const deps = {
      ...makeDeps(),
      lessonSwitch: vi.fn(async () => ({ ok: true })),
      archiveRun: vi.fn(async () => ({ ok: true })),
      archiveRestore: vi.fn(async () => ({ ok: true })),
    };
    const ctx = { file: "same-name", delivery_key: "fresh-version", issuer: "operator" as const };
    await executeCommand({ command: "slack_reply", thread: "C:1", text: "hi" }, deps, ctx);
    expect(deps.slackReply).toHaveBeenCalledWith({
      thread: "C:1",
      text: "hi",
      file: "fresh-version",
    });
    await executeCommand({ command: "lessons-off" }, deps, ctx);
    expect(deps.lessonSwitch).toHaveBeenCalledWith({ action: "off" }, "fresh-version");
    await executeCommand({ command: "archive-run" }, deps, ctx);
    expect(deps.archiveRun).toHaveBeenCalledWith("fresh-version");
    await executeCommand({ command: "archive-restore", pr: 5 }, deps, ctx);
    expect(deps.archiveRestore).toHaveBeenCalledWith(5, "fresh-version");
  });

  it("accepts every whitelisted command with a valid payload", () => {
    const valid: unknown[] = [
      { command: "rerun-round", pr: 12 },
      { command: "restart-session", pr: 12 },
      {
        command: "resolve-terminal-failure",
        pr: 5408,
        incident_id: "review-failure:cmd-5408",
        command_id: "cmd-5408",
        head_sha: "abc123",
      },
      {
        command: "resolve-terminal-failure",
        pr: 999902,
        incident_id: "review-failure:synthetic",
        command_id: "synthetic",
        head_sha: "",
      },
      { command: "pause-pr", pr: 12, reason: "same-head staleness churn" },
      { command: "resume-pr", pr: 12 },
      { command: "flag-owner", message: "webhook signature failures spiking" },
      {
        command: "file-improvement-pr",
        branch: "wip/fix-docs",
        title: "t",
        body: "b",
        slug: "fix-docs",
      },
      { command: "file-issue", title: "t", body: "b" },
      { command: "slack_reply", thread: "1712345678.123456", text: "on it" },
      { command: "drain", on: true },
      { command: "drain", on: false },
      { command: "retry-thread-decision", comment_id: 3000000303 },
      {
        command: "eod-curation-receipt",
        day: "2026-10-07",
        decisions: [{ candidates: ["c1"], decision: "declined", reason: "one-off" }],
      },
    ];
    for (const v of valid) {
      const res = validateCommand(v);
      expect(res.ok, JSON.stringify(v)).toBe(true);
    }
    // + drain, bounded thread replay, terminal-debt resolution, the EOD curation receipt
    expect(COMMAND_WHITELIST).toHaveLength(12);
  });

  // The EOD curator's receipt — strict like every command, with
  // the schema of src/learner/receipt.ts (pinned there in tests/learner.test.ts).
  it("eod-curation-receipt: strict at the top level and inside every decision", () => {
    expect(
      validateCommand({ command: "eod-curation-receipt", day: "2026-10-07", decisions: [] }),
    ).toEqual({
      ok: true,
      command: { command: "eod-curation-receipt", day: "2026-10-07", decisions: [] },
    });
    expect(
      validateCommand({ command: "eod-curation-receipt", day: "2026-10-07", decisions: [], pr: 1 }),
    ).toEqual({ ok: false, reason: "unknown field(s): pr" });
    expect(
      validateCommand({
        command: "eod-curation-receipt",
        day: "2026-10-07",
        decisions: [{ candidates: ["c2"], decision: "declined" }],
      }),
    ).toMatchObject({ ok: false, reason: expect.stringContaining("needs a 'reason'") });
  });

  it("slack_reply: strict shape, ts format, and no channel field", () => {
    expect(validateCommand({ command: "slack_reply", thread: "1712345678.123456" }).ok).toBe(false);
    expect(
      validateCommand({ command: "slack_reply", thread: "1712345678.123456", text: "  " }).ok,
    ).toBe(false);
    expect(validateCommand({ command: "slack_reply", thread: "nope", text: "hi" }).ok).toBe(false);
    expect(
      validateCommand({ command: "slack_reply", thread: "1712345678.12345", text: "hi" }).ok,
    ).toBe(false);
    // A channel can never be named by the overseer — the daemon binds it.
    const withChannel = validateCommand({
      command: "slack_reply",
      thread: "1712345678.123456",
      text: "hi",
      channel: "C0EVIL",
    });
    expect(withChannel.ok).toBe(false);
    if (!withChannel.ok) expect(withChannel.reason).toContain("unknown field");
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
    expect(
      validateCommand({
        command: "resolve-terminal-failure",
        pr: 1,
        incident_id: "wrong",
        command_id: "cmd",
        head_sha: "abc",
      }).ok,
    ).toBe(false);
    expect(
      validateCommand({
        command: "resolve-terminal-failure",
        pr: 1,
        incident_id: "review-failure:cmd",
        command_id: "cmd",
        head_sha: 42,
      }).ok,
    ).toBe(false);
    expect(
      validateCommand({
        command: "resolve-terminal-failure",
        pr: 1,
        incident_id: "review-failure:cmd",
        command_id: "cmd",
        head_sha: "abc",
        force: true,
      }).ok,
    ).toBe(false);
    expect(validateCommand({ command: "mark-escalation-worthy", pr: 1, reason: "x" }).ok).toBe(
      false,
    ); // retired
    expect(validateCommand({ command: "pause-pr", pr: 1 }).ok).toBe(false); // reason required
    expect(validateCommand({ command: "resume-pr", pr: 1, reason: "x" }).ok).toBe(false); // unknown field
    expect(validateCommand({ command: "flag-owner", reason: "wrong field name" }).ok).toBe(false);
    expect(
      validateCommand({
        command: "file-improvement-pr",
        branch: "b",
        title: "t",
        body: "y",
        slug: "Bad Slug",
      }).ok,
    ).toBe(false);
    // `branch` is written by the overseer session and handed to git: only a
    // plain local branch name passes — an option, a force refspec, a refspec
    // or a revision expression is refused at the boundary, before git.
    for (const branch of [
      "--quiet",
      "+wip/x",
      "wip/x:refs/heads/main",
      "a..b",
      "wip docs",
      "a~1",
      "@{-1}",
      ".x",
    ]) {
      const bad = validateCommand({
        command: "file-improvement-pr",
        branch,
        title: "t",
        body: "y",
        slug: "ok",
      });
      if (bad.ok) throw new Error(`branch ${JSON.stringify(branch)} must be refused`);
      expect(bad.reason, branch).toMatch(/'branch' must be a plain local branch name/);
    }
    expect(validateCommand({ command: "retry-thread-decision", comment_id: "5001" }).ok).toBe(
      false,
    );
    expect(
      validateCommand({ command: "retry-thread-decision", comment_id: 5001, force: true }).ok,
    ).toBe(false);
    expect(validateCommand("nope").ok).toBe(false);
    // A session on an older prompt can still emit the retired command, so
    // the rejection must say WHY, not just "unknown".
    const retired = validateCommand({ command: "mark-escalation-worthy", pr: 1, reason: "x" });
    // Narrow before reading `reason` — it lives only on the refusal arm, and
    // reading it off the union would assert against `undefined`.
    if (retired.ok) throw new Error("mark-escalation-worthy must be refused");
    expect(retired.reason).toMatch(/RETIRED on 2026-08-18/);
    // The hint is read by a model, so it must not describe the retired park
    // (a PR stopping for a person on NEEDS_HUMAN). MUTATION: put that
    // sentence back — both fail.
    expect(retired.reason).not.toMatch(/NEEDS_HUMAN|\bpark/);
    expect(retired.reason).toMatch(/decides APPROVE or REQUEST_CHANGES on the merits/);
    expect(validateCommand([{ command: "rerun-round", pr: 1 }]).ok).toBe(false);
    expect(validateCommand(null).ok).toBe(false);
  });
});

describe("executeCommand", () => {
  it("invokes handlers with parsed payloads", async () => {
    const deps = makeDeps();
    await executeCommand({ command: "rerun-round", pr: 41 }, deps);
    expect(deps.rerunRound).toHaveBeenCalledWith(41);
    await executeCommand({ command: "restart-session", pr: 41 }, deps);
    expect(deps.restartSession).toHaveBeenCalledWith(41);
    const terminal = {
      pr: 5408,
      incident_id: "review-failure:cmd-5408",
      command_id: "cmd-5408",
      head_sha: "abc123",
    };
    await executeCommand({ command: "resolve-terminal-failure", ...terminal }, deps);
    expect(deps.resolveTerminalFailure).toHaveBeenCalledWith(terminal);
    await executeCommand({ command: "pause-pr", pr: 5266, reason: "same-head churn" }, deps);
    expect(deps.pausePr).toHaveBeenCalledWith(5266, "same-head churn", "session", undefined);
    await executeCommand({ command: "resume-pr", pr: 5266 }, deps);
    expect(deps.resumePr).toHaveBeenCalledWith(5266, "session");
    await executeCommand({ command: "flag-owner", message: "look" }, deps);
    expect(deps.flagOwner).toHaveBeenCalledWith("look");
    await executeCommand(
      { command: "file-improvement-pr", branch: "wip/x", title: "t", body: "b", slug: "x" },
      deps,
    );
    expect(deps.fileImprovementPr).toHaveBeenCalledWith({
      branch: "wip/x",
      title: "t",
      body: "b",
      slug: "x",
    });
    await executeCommand({ command: "file-issue", title: "t", body: "b" }, deps);
    expect(deps.fileIssue).toHaveBeenCalledWith({ title: "t", body: "b" });
    await executeCommand(
      { command: "slack_reply", thread: "1712345678.123456", text: "on it" },
      deps,
      { file: "c9", issuer: "session" },
    );
    expect(deps.slackReply).toHaveBeenCalledWith({
      thread: "1712345678.123456",
      text: "on it",
      file: "c9",
    });
    await executeCommand({ command: "retry-thread-decision", comment_id: 5001 }, deps);
    expect(deps.retryThreadDecision).toHaveBeenCalledWith(5001);
    const decisions = [{ candidates: [3], decision: "adopted" as const }];
    await executeCommand({ command: "eod-curation-receipt", day: "2026-10-07", decisions }, deps);
    expect(deps.curationReceipt).toHaveBeenCalledWith({ day: "2026-10-07", decisions });
  });

  it("rejects eod-curation-receipt on a daemon wired without the learner", async () => {
    const { curationReceipt: _drop, ...deps } = makeDeps();
    const out = await executeCommand(
      { command: "eod-curation-receipt", day: "2026-10-07", decisions: [] },
      deps,
    );
    expect(out).toMatchObject({ ok: false, reason: expect.stringContaining("not wired") });
  });

  it("rejects slack_reply when Slack is not wired", async () => {
    const { slackReply: _drop, ...deps } = makeDeps();
    const out = await executeCommand(
      { command: "slack_reply", thread: "1712345678.123456", text: "x" },
      deps,
    );
    expect(out).toMatchObject({ ok: false });
    expect(out.reason).toContain("not wired");
  });

  it("treats a void return as success", async () => {
    const deps = makeDeps();
    expect(await executeCommand({ command: "flag-owner", message: "m" }, deps)).toEqual({
      ok: true,
    });
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
  const slackDir = (): string => join(dir, "commands", "slack");
  const result = (name: string): any =>
    JSON.parse(readFileSync(join(cmdDir(), "results", `${name}.result.json`), "utf8"));

  function watcher(deps: ReturnType<typeof makeDeps>, log: string[] = []): CommandWatcher {
    return new CommandWatcher({
      dir: cmdDir(),
      deps,
      store,
      log: (l) => log.push(l),
      parseAttempts: 2,
      parseRetryMs: 1,
    });
  }

  it("a scoped session watcher names its directory while an unscoped one passes the bare name", async () => {
    const thread = "1712345678.123456";
    mkdirSync(slackDir(), { recursive: true });
    writeFileSync(
      join(cmdDir(), "r1.json"),
      JSON.stringify({ command: "slack_reply", thread, text: "a" }),
    );
    writeFileSync(
      join(slackDir(), "r1.json"),
      JSON.stringify({ command: "slack_reply", thread, text: "b" }),
    );
    const deps = makeDeps();
    await watcher(deps).sweep();
    await new CommandWatcher({ dir: slackDir(), scope: "slack", deps, store }).sweep();
    expect(deps.slackReply.mock.calls.map((c) => (c as unknown[])[0])).toEqual([
      { thread, text: "a", file: "r1" },
      { thread, text: "b", file: "slack/r1" },
    ]);
  });

  it("startup sweep executes a valid command, writes an ok result and archives the file", async () => {
    writeFileSync(join(cmdDir(), "c1.json"), JSON.stringify({ command: "rerun-round", pr: 5 }));
    const deps = makeDeps();
    await watcher(deps).sweep();
    expect(deps.rerunRound).toHaveBeenCalledWith(5);
    expect(result("c1")).toMatchObject({
      ok: true,
      redispatched: true,
      command: "rerun-round",
      file: "c1.json",
    });
    expect(existsSync(join(cmdDir(), "c1.json"))).toBe(false);
    expect(existsSync(join(cmdDir(), "processed", "c1.json"))).toBe(true);
    expect(
      store
        .eventsOn(new Date().toISOString().slice(0, 10))
        .some((e) => e.kind === "command_executed"),
    ).toBe(true);
  });

  it("a command that replaced its file while the first one ran is run next, never archived unrun", async () => {
    writeFileSync(join(cmdDir(), "c9.json"), JSON.stringify({ command: "rerun-round", pr: 5 }));
    const deps = makeDeps();
    deps.rerunRound.mockImplementationOnce(async () => {
      // The session writes its next command under the same name meanwhile —
      // in place, as a plain write does.
      writeFileSync(join(cmdDir(), "c9.json"), JSON.stringify({ command: "rerun-round", pr: 6 }));
      return { ok: true, redispatched: true };
    });
    const w = watcher(deps);
    await w.sweep();
    await drained(w);
    expect(deps.rerunRound.mock.calls.map((c) => (c as unknown[])[0])).toEqual([5, 6]);
    expect(JSON.parse(readFileSync(join(cmdDir(), "processed", "c9.json"), "utf8"))).toEqual({
      command: "rerun-round",
      pr: 6,
    });
    w.stop();
  });

  it("retains unfinished JSON for a later write after eager retries expire", async () => {
    const path = join(cmdDir(), "unfinished.json");
    writeFileSync(path, '{"command":"rerun-rou');
    const deps = makeDeps();
    const w = new CommandWatcher({ dir: cmdDir(), deps, store, parseAttempts: 1 });
    await w.handleFile(path);
    expect(existsSync(path)).toBe(true);
    expect(result("unfinished")).toMatchObject({ ok: false });
    writeFileSync(path, JSON.stringify({ command: "rerun-round", pr: 12 }));
    await w.sweep();
    await drained(w);
    expect(deps.rerunRound).toHaveBeenCalledWith(12);
    expect(result("unfinished")).toMatchObject({ ok: true });
    w.stop();
  });

  it("reports an unchanged unfinished write once while still noticing its completed bytes", async () => {
    const path = join(cmdDir(), "slow.json");
    writeFileSync(path, '{"command":"rerun-rou');
    const deps = makeDeps();
    const w = new CommandWatcher({ dir: cmdDir(), deps, store, parseAttempts: 1 });
    await w.sweep();
    await w.sweep();
    await w.sweep();
    expect(
      store.db.prepare("SELECT COUNT(*) AS n FROM events WHERE kind='command_rejected'").get(),
    ).toEqual({ n: 1 });
    expect(existsSync(path)).toBe(true);
    writeFileSync(path, JSON.stringify({ command: "rerun-round", pr: 12 }));
    await w.sweep();
    await w.sweep();
    expect(deps.rerunRound).toHaveBeenCalledTimes(1);
    expect(result("slow")).toMatchObject({ ok: true });
    w.stop();
  });

  it("does not repeat a completed destructive command if result publication fails before archival", async () => {
    const path = join(cmdDir(), "crash.json");
    writeFileSync(path, JSON.stringify({ command: "rerun-round", pr: 12 }));
    const deps = makeDeps();
    const blocked = join(cmdDir(), "results", "crash.result.json");
    deps.rerunRound.mockImplementationOnce(async () => {
      mkdirSync(blocked);
      return { ok: true, redispatched: true };
    });
    await expect(watcher(deps).handleFile(path)).rejects.toThrow();
    rmSync(blocked, { recursive: true });
    await watcher(deps).handleFile(path);
    expect(deps.rerunRound).toHaveBeenCalledTimes(1);
    expect(result("crash")).toMatchObject({ ok: true });
  });

  it.each(["archive-run", "archive-restore"] as const)(
    "does not repeat %s after result publication fails",
    async (kind) => {
      const dir = join(cmdDir(), "operator");
      mkdirSync(dir, { recursive: true });
      const path = join(dir, "archive.json");
      writeFileSync(
        path,
        JSON.stringify(kind === "archive-run" ? { command: kind } : { command: kind, pr: 12 }),
      );
      const blocked = join(cmdDir(), "results", "archive.result.json");
      const run = vi.fn(async () => ({ ok: true }));
      run.mockImplementationOnce(async () => {
        mkdirSync(blocked);
        return { ok: true };
      });
      const deps = { ...makeDeps(), archiveRun: run, archiveRestore: run };
      const create = () =>
        new CommandWatcher({
          dir,
          deps,
          store,
          operator: {
            euid: 1001,
            gids: [1001],
            stat: (p) =>
              p.endsWith(".json")
                ? { uid: 0, gid: 0, mode: 0o644, kind: "file" }
                : { uid: 0, gid: 0, mode: 0o755, kind: "dir" },
          },
        });
      await expect(create().handleFile(path)).rejects.toThrow();
      rmSync(blocked, { recursive: true });
      await create().handleFile(path);
      expect(run).toHaveBeenCalledTimes(1);
      expect(result("archive")).toMatchObject({ ok: true });
    },
  );

  it("withholds an interrupted effect rather than repeating it on replay", async () => {
    const path = join(cmdDir(), "uncertain.json");
    writeFileSync(path, JSON.stringify({ command: "rerun-round", pr: 12 }));
    const deps = makeDeps();
    const blocked = join(cmdDir(), "results", "uncertain.result.json");
    deps.rerunRound.mockImplementationOnce(async () => {
      mkdirSync(blocked);
      throw new Error("reset response lost");
    });
    await expect(watcher(deps).handleFile(path)).rejects.toThrow();
    rmSync(blocked, { recursive: true });
    await watcher(deps).handleFile(path);
    expect(deps.rerunRound).toHaveBeenCalledTimes(1);
    expect(result("uncertain")).toMatchObject({
      ok: false,
      reason: expect.stringContaining("outcome unknown"),
    });
  });

  it("lets a filing handler reconcile its own pending receipt on replay", async () => {
    const path = join(cmdDir(), "filing.json");
    writeFileSync(path, JSON.stringify({ command: "file-issue", title: "t", body: "b" }));
    const deps = makeDeps();
    const blocked = join(cmdDir(), "results", "filing.result.json");
    deps.fileIssue.mockImplementationOnce(async () => {
      mkdirSync(blocked);
      return { ok: true, issue: 7 };
    });
    await expect(watcher(deps).handleFile(path)).rejects.toThrow();
    rmSync(blocked, { recursive: true });
    await watcher(deps).handleFile(path);
    expect(deps.fileIssue).toHaveBeenCalledTimes(2);
    expect(deps.fileIssue.mock.calls[0]).toEqual(deps.fileIssue.mock.calls[1]);
    expect(result("filing")).toMatchObject({ ok: true, issue: 7 });
  });

  it("the same command written again while it ran is the same command — run once, archived", async () => {
    const body = JSON.stringify({ command: "rerun-round", pr: 8 });
    writeFileSync(join(cmdDir(), "c10.json"), body);
    const deps = makeDeps();
    deps.rerunRound.mockImplementationOnce(async () => {
      writeFileSync(join(cmdDir(), "c10.json"), body); // an impatient re-write
      return { ok: true, redispatched: true };
    });
    const w = watcher(deps);
    await w.sweep();
    await drained(w);
    w.stop();
    expect(deps.rerunRound).toHaveBeenCalledTimes(1);
    expect(existsSync(join(cmdDir(), "processed", "c10.json"))).toBe(true);
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
    const rejected = store
      .eventsOn(new Date().toISOString().slice(0, 10))
      .filter((e) => e.kind === "command_rejected");
    expect(rejected).toHaveLength(1);
    expect(Object.values(deps).every((fn) => fn.mock.calls.length === 0)).toBe(true);
  });

  it("logs the cause when a finished command cannot be archived", async () => {
    writeFileSync(join(cmdDir(), "stuck.json"), JSON.stringify({ command: "merge-pr", pr: 5 }));
    const log: string[] = [];
    const w = watcher(makeDeps(), log);
    mkdirSync(join(cmdDir(), "processed"), { recursive: true });
    chmodSync(join(cmdDir(), "processed"), 0o555);
    try {
      await w.sweep();
    } finally {
      chmodSync(join(cmdDir(), "processed"), 0o755);
    }
    expect(log.join("\n")).toMatch(/could not archive .*stuck\.json.*EACCES/);
  });

  it("rejects unknown fields", async () => {
    writeFileSync(
      join(cmdDir(), "extra.json"),
      JSON.stringify({ command: "file-issue", title: "t", body: "b", assignee: "x" }),
    );
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
    const w = new CommandWatcher({
      dir: cmdDir(),
      deps,
      store,
      log: (l) => log.push(l),
      parseAttempts: 3,
      parseRetryMs: 5,
    });
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
      JSON.stringify({
        command: "file-improvement-pr",
        branch: "wip/x",
        title: "t",
        body: "b",
        slug: "x",
      }),
    );
    const deps = makeDeps();
    deps.fileImprovementPr = vi.fn(async () => ({
      ok: false,
      reason: "51 changed lines > cap 50",
    })) as any;
    await watcher(deps).sweep();
    expect(result("cap")).toMatchObject({
      ok: false,
      reason: "51 changed lines > cap 50",
      command: "file-improvement-pr",
    });
  });

  it("catches a throwing handler", async () => {
    writeFileSync(
      join(cmdDir(), "boom.json"),
      JSON.stringify({ command: "flag-owner", message: "m" }),
    );
    const deps = makeDeps();
    deps.flagOwner = vi.fn(async () => {
      throw new Error("tmux gone");
    }) as any;
    await watcher(deps).sweep();
    expect(result("boom").reason).toContain("tmux gone");
  });

  it("picks up a file written after start() via fs.watch", async () => {
    const deps = makeDeps();
    const w = watcher(deps);
    await w.start();
    writeFileSync(
      join(cmdDir(), "live.json"),
      JSON.stringify({ command: "flag-owner", message: "hello" }),
    );
    await waitFor(() => deps.flagOwner.mock.calls.length > 0, "flag-owner to be served");
    w.stop();
    expect(deps.flagOwner).toHaveBeenCalledWith("hello");
  });

  it("a file written WHILE the startup sweep's handler is in flight is still served", async () => {
    writeFileSync(join(cmdDir(), "a-slow.json"), JSON.stringify({ command: "rerun-round", pr: 5 }));
    const deps = makeDeps();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let entered!: () => void;
    const inHandler = new Promise<void>((r) => (entered = r));
    deps.rerunRound = vi.fn(async () => {
      entered();
      await gate;
      return true;
    }) as any;
    const w = watcher(deps);
    const started = w.start();
    await inHandler; // the sweep has snapshotted the directory and is awaiting
    // A second watcher on the same directory is the observable for "the watch event
    // landed": inotify hands one event to both watchers in the same loop turn, and the
    // daemon's watcher was registered first, so it has been told when this one is.
    let landed = false;
    const probe = watch(cmdDir(), (_event, filename) => {
      if (String(filename) === "b-live.json") landed = true;
    });
    try {
      writeFileSync(
        join(cmdDir(), "b-live.json"),
        JSON.stringify({ command: "flag-owner", message: "mid-sweep" }),
      );
      await waitFor(() => landed, "the watch event for the mid-sweep file");
    } finally {
      probe.close();
    }
    release();
    await started;
    await waitFor(() => deps.flagOwner.mock.calls.length > 0, "flag-owner to be served");
    w.stop();
    expect(deps.flagOwner).toHaveBeenCalledWith("mid-sweep");
    expect(deps.rerunRound).toHaveBeenCalledTimes(1);
  });

  // ---- tier enforcement ----------------------------------------------------

  const origin = (over: Partial<OriginRecord> = {}): OriginRecord => ({
    source: "slack",
    event_id: "Ev1",
    slack_user: "U0ALICE",
    tier: "author",
    authorized_prs: [1234],
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    ...over,
  });

  function tierWatcher(
    deps: ReturnType<typeof makeDeps>,
    dirKind: "local" | "slack",
    current: () => OriginRecord | null,
  ): CommandWatcher {
    const target = dirKind === "slack" ? slackDir() : cmdDir();
    mkdirSync(target, { recursive: true });
    return new CommandWatcher({
      dir: target,
      deps,
      store,
      parseAttempts: 2,
      parseRetryMs: 1,
      log: () => {},
      tier: { dir: dirKind, currentOrigin: current },
    });
  }

  const slackResult = (name: string): any =>
    JSON.parse(readFileSync(join(slackDir(), "results", `${name}.result.json`), "utf8"));

  async function runSlack(
    deps: ReturnType<typeof makeDeps>,
    cmd: unknown,
    o: OriginRecord | null,
  ): Promise<any> {
    mkdirSync(slackDir(), { recursive: true });
    writeFileSync(join(slackDir(), "t.json"), JSON.stringify(cmd));
    await tierWatcher(deps, "slack", () => o).sweep();
    return slackResult("t");
  }

  it("commands/slack/ denies every tier-restricted command at tier anyone", async () => {
    const anyone = origin({ tier: "anyone", authorized_prs: [] });
    for (const cmd of [
      { command: "rerun-round", pr: 1234 },
      { command: "pause-pr", pr: 1234, reason: "r" },
      { command: "resume-pr", pr: 1234 },
      { command: "restart-session", pr: 12 },
      {
        command: "resolve-terminal-failure",
        pr: 1234,
        incident_id: "review-failure:cmd",
        command_id: "cmd",
        head_sha: "abc",
      },
      { command: "file-improvement-pr", branch: "wip/x", title: "t", body: "b", slug: "x" },
      { command: "file-issue", title: "t", body: "b" },
    ]) {
      const deps = makeDeps();
      const r = await runSlack(deps, cmd, anyone);
      expect(r.ok, JSON.stringify(cmd)).toBe(false);
      expect(r.reason).toMatch(/^tier: /);
      expect(Object.values(deps).every((fn) => fn.mock.calls.length === 0)).toBe(true);
    }
  });

  it("the safety valve and slack_reply are tier-free", async () => {
    const anyone = origin({ tier: "anyone", authorized_prs: [] });
    const d1 = makeDeps();
    expect((await runSlack(d1, { command: "flag-owner", message: "help" }, anyone)).ok).toBe(true);
    const d2 = makeDeps();
    expect(
      (
        await runSlack(
          d2,
          { command: "slack_reply", thread: "1712345678.123456", text: "hi" },
          anyone,
        )
      ).ok,
    ).toBe(true);
  });

  it("tier author acts on an own PR and is refused on someone else's", async () => {
    const alice = origin({ tier: "author", authorized_prs: [1234] });
    const ok = makeDeps();
    expect((await runSlack(ok, { command: "rerun-round", pr: 1234 }, alice)).ok).toBe(true);
    expect(ok.rerunRound).toHaveBeenCalledWith(1234);
    const nope = makeDeps();
    const r = await runSlack(nope, { command: "pause-pr", pr: 9999, reason: "r" }, alice);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/^tier: PR #9999 is not authored/);
    expect(nope.pausePr).not.toHaveBeenCalled();
  });

  it("tier author cannot restart sessions, resolve debt, or file improvement PRs", async () => {
    const alice = origin({ tier: "author", authorized_prs: [1234] });
    for (const cmd of [
      { command: "restart-session", pr: 1234 },
      {
        command: "resolve-terminal-failure",
        pr: 1234,
        incident_id: "review-failure:cmd",
        command_id: "cmd",
        head_sha: "abc",
      },
      { command: "file-improvement-pr", branch: "wip/x", title: "t", body: "b", slug: "x" },
    ]) {
      const r = await runSlack(makeDeps(), cmd, alice);
      expect(r.ok, JSON.stringify(cmd)).toBe(false);
      expect(r.reason).toContain("requires tier owner");
    }
  });

  // A deferral's ticket is filed by the review session itself, in the round
  // that deferred — through the legacy commands/ dir, where a daemon-side turn
  // already runs at full autonomy (the "legacy commands/ keeps full autonomy"
  // test below is that path). So on Slack `file-issue` stays owner-only, and
  // naming your own PR buys nothing — `pr` is provenance, never a right.
  it("tier author cannot file an issue — not even naming their own PR", async () => {
    const alice = origin({ tier: "author", authorized_prs: [1234] });
    for (const cmd of [
      { command: "file-issue", pr: 1234, title: "t", body: "b" },
      { command: "file-issue", title: "t", body: "b" },
    ]) {
      const deps = makeDeps();
      const r = await runSlack(deps, cmd, alice);
      expect(r.ok, JSON.stringify(cmd)).toBe(false);
      expect(r.reason).toContain("requires tier owner");
      expect(deps.fileIssue).not.toHaveBeenCalled();
    }
  });

  it("the pr provenance field rides through to fileIssue when the owner files", async () => {
    const m = origin({ tier: "owner", slack_user: "U0MAT", authorized_prs: [] });
    const deps = makeDeps();
    const r = await runSlack(deps, { command: "file-issue", pr: 1234, title: "t", body: "b" }, m);
    expect(r.ok).toBe(true);
    expect(deps.fileIssue).toHaveBeenCalledWith(
      { title: "t", body: "b", pr: 1234 },
      expect.any(String),
    );
  });

  it("tier owner runs every command on any PR", async () => {
    const m = origin({ tier: "owner", slack_user: "U0MAT", authorized_prs: [] });
    for (const cmd of [
      { command: "rerun-round", pr: 42 },
      { command: "restart-session", pr: 12 },
      {
        command: "resolve-terminal-failure",
        pr: 5408,
        incident_id: "review-failure:cmd",
        command_id: "cmd",
        head_sha: "abc",
      },
      { command: "file-issue", title: "t", body: "b" },
    ]) {
      const r = await runSlack(makeDeps(), cmd, m);
      expect(r.ok, JSON.stringify(cmd)).toBe(true);
    }
  });

  it("commands/slack/ with no live origin denies (fail closed)", async () => {
    const deps = makeDeps();
    const r = await runSlack(deps, { command: "rerun-round", pr: 1 }, null);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/^tier: no live Slack origin/);
    expect(deps.rerunRound).not.toHaveBeenCalled();
    const rejected = store
      .eventsOn(new Date().toISOString().slice(0, 10))
      .filter((e) => e.kind === "command_rejected");
    expect(rejected).toHaveLength(1);
  });

  it("legacy commands/ keeps full autonomy when no Slack turn is live", async () => {
    const deps = makeDeps();
    writeFileSync(
      join(cmdDir(), "eod.json"),
      JSON.stringify({ command: "file-issue", title: "t", body: "b" }),
    );
    await tierWatcher(deps, "local", () => null).sweep();
    expect(result("eod")).toMatchObject({ ok: true });
    expect(deps.fileIssue).toHaveBeenCalled();
  });

  it("a review session's deferral ticket files through legacy commands/ with pr provenance", async () => {
    // This IS the deferral path: the session that deferred writes the command
    // file itself, no Slack turn is live, and the tier table needs no widening
    // because a local turn already has full autonomy.
    const deps = makeDeps();
    writeFileSync(
      join(cmdDir(), "deferral-pr-5314-retry-jitter.json"),
      JSON.stringify({ command: "file-issue", pr: 5314, title: "t", body: "b" }),
    );
    await tierWatcher(deps, "local", () => null).sweep();
    expect(result("deferral-pr-5314-retry-jitter")).toMatchObject({ ok: true });
    expect(deps.fileIssue).toHaveBeenCalledWith(
      { title: "t", body: "b", pr: 5314 },
      expect.any(String),
    );
  });

  it("legacy commands/ refuses mid-turn for a non-owner Slack origin (the belt)", async () => {
    const deps = makeDeps();
    writeFileSync(
      join(cmdDir(), "sneak.json"),
      JSON.stringify({ command: "file-issue", title: "t", body: "b" }),
    );
    await tierWatcher(deps, "local", () => origin({ tier: "author" })).sweep();
    const r = result("sneak");
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/^tier: this turn was caused by a Slack message from U0ALICE/);
    expect(r.reason).toContain("commands/slack/");
    expect(deps.fileIssue).not.toHaveBeenCalled();
  });

  it("the belt does NOT lift when the Slack origin expires — patience is not an escalation", async () => {
    const deps = makeDeps();
    // The gate for the legacy dir reads `latestAny()`: age is irrelevant, cause
    // is everything. A turn that simply ran past the 15-minute TTL (channel text
    // can ask for exactly that) must not gain owner rights.
    const expired = origin({
      tier: "anyone",
      expires_at: new Date(Date.now() - 60 * 60_000).toISOString(),
    });
    writeFileSync(
      join(cmdDir(), "patient.json"),
      JSON.stringify({ command: "file-issue", title: "t", body: "b" }),
    );
    await tierWatcher(deps, "local", () => expired).sweep();
    const r = result("patient");
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/^tier: this turn was caused by a Slack message/);
    expect(deps.fileIssue).not.toHaveBeenCalled();
  });

  it("a daemon wake (source: local) clears the belt — the EOD pipeline cannot be DoSed", async () => {
    const deps = makeDeps();
    const local = origin({
      source: "local",
      event_id: "local:eod-sweep",
      slack_user: "",
      tier: "system",
    });
    writeFileSync(
      join(cmdDir(), "eod-issue.json"),
      JSON.stringify({ command: "file-issue", title: "t", body: "b" }),
    );
    await tierWatcher(deps, "local", () => local).sweep();
    expect(result("eod-issue")).toMatchObject({ ok: true });
    expect(deps.fileIssue).toHaveBeenCalled();
  });

  it("legacy commands/ still runs during an owner Slack turn", async () => {
    const deps = makeDeps();
    writeFileSync(join(cmdDir(), "alice.json"), JSON.stringify({ command: "rerun-round", pr: 7 }));
    await tierWatcher(deps, "local", () => origin({ tier: "owner" })).sweep();
    expect(result("alice")).toMatchObject({ ok: true });
    expect(deps.rerunRound).toHaveBeenCalledWith(7);
  });

  it("session slack_reply retains its scoped filename as its idempotence scope", async () => {
    const deps = makeDeps();
    mkdirSync(slackDir(), { recursive: true });
    writeFileSync(
      join(slackDir(), "reply-01.json"),
      JSON.stringify({ command: "slack_reply", thread: "1712345678.123456", text: "hi" }),
    );
    await tierWatcher(deps, "slack", () => origin()).sweep();
    expect(deps.slackReply).toHaveBeenCalledWith({
      thread: "1712345678.123456",
      text: "hi",
      file: "reply-01",
    });
  });
});

describe("authorizeCommand (pure)", () => {
  const rec = (tier: OriginRecord["tier"], prs: number[] = []): OriginRecord => ({
    source: "slack",
    event_id: "Ev",
    slack_user: "U",
    tier,
    authorized_prs: prs,
    expires_at: new Date(Date.now() + 60_000).toISOString(),
  });

  it("a null origin is a local turn — full (system-grade) autonomy", () => {
    const cmds: Command[] = [
      { command: "restart-session", pr: 12 },
      {
        command: "resolve-terminal-failure",
        pr: 999902,
        incident_id: "review-failure:cmd",
        command_id: "cmd",
        head_sha: "",
      },
      { command: "file-issue", title: "t", body: "b" },
    ];
    for (const c of cmds) expect(authorizeCommand(c, null)).toEqual({ ok: true });
  });

  it("every rejection reason starts with 'tier: '", () => {
    const denials = [
      authorizeCommand({ command: "rerun-round", pr: 1 }, rec("anyone")),
      authorizeCommand({ command: "file-issue", title: "t", body: "b" }, rec("author", [1])),
      authorizeCommand({ command: "pause-pr", pr: 2, reason: "r" }, rec("author", [1])),
      authorizeCommand({ command: "restart-session", pr: 1 }, rec("anyone")),
    ];
    for (const d of denials) {
      expect(d.ok).toBe(false);
      if (!d.ok) expect(d.reason.startsWith("tier: ")).toBe(true);
    }
  });

  it("tier 'ignored' is treated as read-only, like 'anyone'", () => {
    expect(authorizeCommand({ command: "flag-owner", message: "m" }, rec("ignored")).ok).toBe(true);
    expect(authorizeCommand({ command: "rerun-round", pr: 1 }, rec("ignored")).ok).toBe(false);
  });

  it("terminal cleanup accepts only stamped owner/system tiers", () => {
    const command: Command = {
      command: "resolve-terminal-failure",
      pr: 5408,
      incident_id: "review-failure:cmd",
      command_id: "cmd",
      head_sha: "abc",
    };
    expect(authorizeCommand(command, rec("owner"))).toEqual({ ok: true });
    expect(authorizeCommand(command, rec("system"))).toEqual({ ok: true });
    expect(authorizeCommand(command, rec("author", [5408])).ok).toBe(false);
    expect(authorizeCommand(command, rec("anyone")).ok).toBe(false);
  });

  it("eod-curation-receipt is the daemon's or the owner's — never a Slack author's", () => {
    const c: Command = { command: "eod-curation-receipt", day: "2026-10-07", decisions: [] };
    expect(authorizeCommand(c, null)).toEqual({ ok: true });
    expect(authorizeCommand(c, rec("system"))).toEqual({ ok: true });
    expect(authorizeCommand(c, rec("owner"))).toEqual({ ok: true });
    expect(authorizeCommand(c, rec("author", [1])).ok).toBe(false);
    expect(authorizeCommand(c, rec("anyone")).ok).toBe(false);
  });

  it("restart-session is owner-only, and the retired 'overseer' target is refused", () => {
    expect(validateCommand({ command: "restart-session", pr: "overseer" }).ok).toBe(false);
    expect(authorizeCommand({ command: "restart-session", pr: 12 }, rec("owner")).ok).toBe(true);
    expect(authorizeCommand({ command: "restart-session", pr: 12 }, rec("author", [1])).ok).toBe(
      false,
    );
  });
});

it("passes trusted delivery identity to timed levers and restart without reading it from payload", async () => {
  const deps = { ...makeDeps(), drain: vi.fn(async () => ({ ok: true })) };
  const context = {
    file: "slack/request",
    issuer: "session" as const,
    delivery_key: "parsed/version",
  };
  await executeCommand({ command: "restart-session", pr: 12 }, deps, context);
  expect(deps.restartSession).toHaveBeenCalledWith(12, "parsed/version");
  await executeCommand(
    { command: "pause-pr", pr: 12, reason: "fixture", for_min: 5 },
    deps,
    context,
  );
  expect(deps.pausePr).toHaveBeenCalledWith(12, "fixture", "session", 5, "parsed/version");
  await executeCommand({ command: "drain", on: true, for_min: 5 }, deps, context);
  expect(deps.drain).toHaveBeenCalledWith(true, "session", 5, "parsed/version");
});
