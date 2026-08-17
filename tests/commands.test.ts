import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

function makeDeps() {
  return {
    slackReply: vi.fn(async () => ({ ok: true, ts: "1712345678.000100" })),
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
      { command: "slack_reply", thread: "1712345678.123456", text: "on it" },
    ];
    for (const v of valid) {
      const res = validateCommand(v);
      expect(res.ok, JSON.stringify(v)).toBe(true);
    }
    expect(COMMAND_WHITELIST).toHaveLength(9);
  });

  it("slack_reply: strict shape, ts format, and no channel field", () => {
    expect(validateCommand({ command: "slack_reply", thread: "1712345678.123456" }).ok).toBe(false);
    expect(validateCommand({ command: "slack_reply", thread: "1712345678.123456", text: "  " }).ok).toBe(false);
    expect(validateCommand({ command: "slack_reply", thread: "nope", text: "hi" }).ok).toBe(false);
    expect(validateCommand({ command: "slack_reply", thread: "1712345678.12345", text: "hi" }).ok).toBe(false);
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
    await executeCommand(
      { command: "slack_reply", thread: "1712345678.123456", text: "on it" },
      deps,
      { file: "c9" },
    );
    expect(deps.slackReply).toHaveBeenCalledWith({ thread: "1712345678.123456", text: "on it", file: "c9" });
  });

  it("rejects slack_reply when Slack is not wired", async () => {
    const { slackReply: _drop, ...deps } = makeDeps();
    const out = await executeCommand({ command: "slack_reply", thread: "1712345678.123456", text: "x" }, deps);
    expect(out).toMatchObject({ ok: false });
    expect(out.reason).toContain("not wired");
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
  const slackDir = (): string => join(dir, "commands", "slack");
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

  // ---- tier enforcement (S3) --------------------------------------

  const origin = (over: Partial<OriginRecord> = {}): OriginRecord => ({
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

  async function runSlack(deps: ReturnType<typeof makeDeps>, cmd: unknown, o: OriginRecord | null): Promise<any> {
    mkdirSync(slackDir(), { recursive: true });
    writeFileSync(join(slackDir(), "t.json"), JSON.stringify(cmd));
    await tierWatcher(deps, "slack", () => o).sweep();
    return slackResult("t");
  }

  it("commands/slack/ denies every tier-restricted command at tier anyone", async () => {
    const anyone = origin({ tier: "anyone", authorized_prs: [] });
    for (const cmd of [
      { command: "rerun-round", pr: 1234 },
      { command: "mark-escalation-worthy", pr: 1234, reason: "r" },
      { command: "pause-pr", pr: 1234, reason: "r" },
      { command: "resume-pr", pr: 1234 },
      { command: "restart-session", pr: "overseer" },
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
    expect((await runSlack(d1, { command: "flag-owner-legacy", message: "help" }, anyone)).ok).toBe(true);
    const d2 = makeDeps();
    expect((await runSlack(d2, { command: "slack_reply", thread: "1712345678.123456", text: "hi" }, anyone)).ok).toBe(true);
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

  it("tier author cannot restart sessions or file improvement PRs/issues", async () => {
    const alice = origin({ tier: "author", authorized_prs: [1234] });
    for (const cmd of [
      { command: "restart-session", pr: 1234 },
      { command: "file-issue", title: "t", body: "b" },
      { command: "file-improvement-pr", branch: "wip/x", title: "t", body: "b", slug: "x" },
    ]) {
      const r = await runSlack(makeDeps(), cmd, alice);
      expect(r.ok, JSON.stringify(cmd)).toBe(false);
      expect(r.reason).toContain("requires tier owner_legacy");
    }
  });

  it("tier owner_legacy runs every command on any PR", async () => {
    const m = origin({ tier: "owner_legacy", slack_user: "U0MAT", authorized_prs: [] });
    for (const cmd of [
      { command: "rerun-round", pr: 42 },
      { command: "restart-session", pr: "overseer" },
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
    const rejected = store.eventsOn(new Date().toISOString().slice(0, 10)).filter((e) => e.kind === "command_rejected");
    expect(rejected).toHaveLength(1);
  });

  it("legacy commands/ keeps full autonomy when no Slack turn is live", async () => {
    const deps = makeDeps();
    writeFileSync(join(cmdDir(), "eod.json"), JSON.stringify({ command: "file-issue", title: "t", body: "b" }));
    await tierWatcher(deps, "local", () => null).sweep();
    expect(result("eod")).toMatchObject({ ok: true });
    expect(deps.fileIssue).toHaveBeenCalled();
  });

  it("legacy commands/ refuses mid-turn for a non-owner Slack origin (the belt)", async () => {
    const deps = makeDeps();
    writeFileSync(join(cmdDir(), "sneak.json"), JSON.stringify({ command: "file-issue", title: "t", body: "b" }));
    await tierWatcher(deps, "local", () => origin({ tier: "author" })).sweep();
    const r = result("sneak");
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/^tier: a Slack turn from U0ALICE/);
    expect(r.reason).toContain("commands/slack/");
    expect(deps.fileIssue).not.toHaveBeenCalled();
  });

  it("legacy commands/ still runs during a the owner Slack turn", async () => {
    const deps = makeDeps();
    writeFileSync(join(cmdDir(), "mat.json"), JSON.stringify({ command: "rerun-round", pr: 7 }));
    await tierWatcher(deps, "local", () => origin({ tier: "owner_legacy" })).sweep();
    expect(result("mat")).toMatchObject({ ok: true });
    expect(deps.rerunRound).toHaveBeenCalledWith(7);
  });

  it("slack_reply gets the command file basename as its idempotence scope", async () => {
    const deps = makeDeps();
    mkdirSync(slackDir(), { recursive: true });
    writeFileSync(
      join(slackDir(), "reply-01.json"),
      JSON.stringify({ command: "slack_reply", thread: "1712345678.123456", text: "hi" }),
    );
    await tierWatcher(deps, "slack", () => origin()).sweep();
    expect(deps.slackReply).toHaveBeenCalledWith({ thread: "1712345678.123456", text: "hi", file: "reply-01" });
  });
});

describe("authorizeCommand (pure)", () => {
  const rec = (tier: OriginRecord["tier"], prs: number[] = []): OriginRecord => ({
    event_id: "Ev",
    slack_user: "U",
    tier,
    authorized_prs: prs,
    expires_at: new Date(Date.now() + 60_000).toISOString(),
  });

  it("a null origin is a local turn — full tier-M autonomy", () => {
    const cmds: Command[] = [
      { command: "restart-session", pr: "overseer" },
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
    expect(authorizeCommand({ command: "flag-owner-legacy", message: "m" }, rec("ignored")).ok).toBe(true);
    expect(authorizeCommand({ command: "rerun-round", pr: 1 }, rec("ignored")).ok).toBe(false);
  });

  it("restart-session on 'overseer' is owner_legacy-only and needs no PR", () => {
    expect(authorizeCommand({ command: "restart-session", pr: "overseer" }, rec("owner_legacy")).ok).toBe(true);
    expect(authorizeCommand({ command: "restart-session", pr: "overseer" }, rec("author", [1])).ok).toBe(false);
  });
});
