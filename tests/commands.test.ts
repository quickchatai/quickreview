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
    pausePr: vi.fn(async () => undefined),
    resumePr: vi.fn(async () => undefined),
    flagOwner: vi.fn(async () => undefined),
    fileImprovementPr: vi.fn(async () => ({ ok: true, branch: "bot/improve-x" })),
    fileIssue: vi.fn(async () => ({ ok: true, issue: 7 })),
    retryThreadDecision: vi.fn(async () => ({ ok: true, file: "x.json" })),
  };
}

describe("validateCommand — whitelist", () => {
  it("accepts every whitelisted command with a valid payload", () => {
    const valid: unknown[] = [
      { command: "rerun-round", pr: 12 },
      { command: "restart-session", pr: 12 },
      { command: "restart-session", pr: "overseer" },
      { command: "pause-pr", pr: 12, reason: "same-head staleness churn" },
      { command: "resume-pr", pr: 12 },
      { command: "flag-owner", message: "webhook signature failures spiking" },
      { command: "file-improvement-pr", branch: "wip/fix-docs", title: "t", body: "b", slug: "fix-docs" },
      { command: "file-issue", title: "t", body: "b" },
      { command: "slack_reply", thread: "1712345678.123456", text: "on it" },
      { command: "drain", on: true },
      { command: "drain", on: false },
      { command: "retry-thread-decision", comment_id: 3856996601 },
    ];
    for (const v of valid) {
      const res = validateCommand(v);
      expect(res.ok, JSON.stringify(v)).toBe(true);
    }
    expect(COMMAND_WHITELIST).toHaveLength(10); // + drain and bounded thread-decision replay
  });

  it("flag-owner is the role-worded alias for flag-owner-legacy (reseed) — internal kind unchanged", () => {
    const res = validateCommand({ command: "flag-owner", message: "webhook signature failures spiking" });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.command).toEqual({ command: "flag-owner-legacy", message: "webhook signature failures spiking" });
    // The alias inherits flag-owner-legacy's strict schema, not a looser one.
    expect(validateCommand({ command: "flag-owner", reason: "wrong field name" }).ok).toBe(false);
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
    expect(validateCommand({ command: "mark-escalation-worthy", pr: 1, reason: "x" }).ok).toBe(false); // retired
    expect(validateCommand({ command: "pause-pr", pr: 1 }).ok).toBe(false); // reason required
    expect(validateCommand({ command: "resume-pr", pr: 1, reason: "x" }).ok).toBe(false); // unknown field
    expect(validateCommand({ command: "flag-owner", reason: "wrong field name" }).ok).toBe(false);
    expect(validateCommand({ command: "file-improvement-pr", branch: "b", title: "t", body: "y", slug: "Bad Slug" }).ok).toBe(false);
    expect(validateCommand({ command: "retry-thread-decision", comment_id: "5001" }).ok).toBe(false);
    expect(validateCommand({ command: "retry-thread-decision", comment_id: 5001, force: true }).ok).toBe(false);
    expect(validateCommand("nope").ok).toBe(false);
    // The overseer's frozen system prompt still advertises the retired
    // command, so the rejection must say WHY, not just "unknown".
    const retired = validateCommand({ command: "mark-escalation-worthy", pr: 1, reason: "x" });
    expect(retired.ok).toBe(false);
    expect(retired.reason).toMatch(/RETIRED on 2026-08-18/);
    expect(retired.reason).toMatch(/NEEDS_HUMAN/);
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
    await executeCommand({ command: "pause-pr", pr: 5266, reason: "same-head churn" }, deps);
    expect(deps.pausePr).toHaveBeenCalledWith(5266, "same-head churn");
    await executeCommand({ command: "resume-pr", pr: 5266 }, deps);
    expect(deps.resumePr).toHaveBeenCalledWith(5266);
    await executeCommand({ command: "flag-owner", message: "look" }, deps);
    expect(deps.flagOwner).toHaveBeenCalledWith("look");
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
    await executeCommand({ command: "retry-thread-decision", comment_id: 5001 }, deps);
    expect(deps.retryThreadDecision).toHaveBeenCalledWith(5001);
  });

  it("rejects slack_reply when Slack is not wired", async () => {
    const { slackReply: _drop, ...deps } = makeDeps();
    const out = await executeCommand({ command: "slack_reply", thread: "1712345678.123456", text: "x" }, deps);
    expect(out).toMatchObject({ ok: false });
    expect(out.reason).toContain("not wired");
  });

  it("treats a void return as success", async () => {
    const deps = makeDeps();
    expect(await executeCommand({ command: "flag-owner", message: "m" }, deps)).toEqual({ ok: true });
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
    writeFileSync(join(cmdDir(), "boom.json"), JSON.stringify({ command: "flag-owner", message: "m" }));
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
    writeFileSync(join(cmdDir(), "live.json"), JSON.stringify({ command: "flag-owner", message: "hello" }));
    for (let i = 0; i < 50 && deps.flagOwner.mock.calls.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    w.stop();
    expect(deps.flagOwner).toHaveBeenCalledWith("hello");
  });

  // ---- tier enforcement (S3) --------------------------------------

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
    expect((await runSlack(d1, { command: "flag-owner", message: "help" }, anyone)).ok).toBe(true);
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

  it("tier author cannot restart sessions or file improvement PRs", async () => {
    const alice = origin({ tier: "author", authorized_prs: [1234] });
    for (const cmd of [
      { command: "restart-session", pr: 1234 },
      { command: "file-improvement-pr", branch: "wip/x", title: "t", body: "b", slug: "x" },
    ]) {
      const r = await runSlack(makeDeps(), cmd, alice);
      expect(r.ok, JSON.stringify(cmd)).toBe(false);
      expect(r.reason).toContain("requires tier owner");
    }
  });

  // (corrected by the owner): a deferral's ticket is filed by the REVIEW
  // SESSION itself, in the round that deferred — through the legacy commands/
  // dir, where a daemon-side turn already runs at full autonomy (the
  // "legacy commands/ keeps full autonomy" test below is that path). So the
  // brief `author: "own"` widening is reverted: on Slack, `file-issue` stays
  // owner-only, and naming your own PR buys nothing — `pr` is provenance,
  // never a right.
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
    expect(deps.fileIssue).toHaveBeenCalledWith({ title: "t", body: "b", pr: 1234 });
  });

  it("tier owner runs every command on any PR", async () => {
    const m = origin({ tier: "owner", slack_user: "U0MAT", authorized_prs: [] });
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
    expect(deps.fileIssue).toHaveBeenCalledWith({ title: "t", body: "b", pr: 5314 });
  });

  it("legacy commands/ refuses mid-turn for a non-owner Slack origin (the belt)", async () => {
    const deps = makeDeps();
    writeFileSync(join(cmdDir(), "sneak.json"), JSON.stringify({ command: "file-issue", title: "t", body: "b" }));
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
    const expired = origin({ tier: "anyone", expires_at: new Date(Date.now() - 60 * 60_000).toISOString() });
    writeFileSync(join(cmdDir(), "patient.json"), JSON.stringify({ command: "file-issue", title: "t", body: "b" }));
    await tierWatcher(deps, "local", () => expired).sweep();
    const r = result("patient");
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/^tier: this turn was caused by a Slack message/);
    expect(deps.fileIssue).not.toHaveBeenCalled();
  });

  it("a daemon wake (source: local) clears the belt — the EOD pipeline cannot be DoSed", async () => {
    const deps = makeDeps();
    const local = origin({ source: "local", event_id: "local:eod-sweep", slack_user: "", tier: "system" });
    writeFileSync(join(cmdDir(), "eod-issue.json"), JSON.stringify({ command: "file-issue", title: "t", body: "b" }));
    await tierWatcher(deps, "local", () => local).sweep();
    expect(result("eod-issue")).toMatchObject({ ok: true });
    expect(deps.fileIssue).toHaveBeenCalled();
  });

  it("legacy commands/ still runs during an owner Slack turn", async () => {
    const deps = makeDeps();
    writeFileSync(join(cmdDir(), "mat.json"), JSON.stringify({ command: "rerun-round", pr: 7 }));
    await tierWatcher(deps, "local", () => origin({ tier: "owner" })).sweep();
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
    source: "slack",
    event_id: "Ev",
    slack_user: "U",
    tier,
    authorized_prs: prs,
    expires_at: new Date(Date.now() + 60_000).toISOString(),
  });

  it("a null origin is a local turn — full (system-grade) autonomy", () => {
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
    expect(authorizeCommand({ command: "flag-owner", message: "m" }, rec("ignored")).ok).toBe(true);
    expect(authorizeCommand({ command: "rerun-round", pr: 1 }, rec("ignored")).ok).toBe(false);
  });

  it("restart-session on 'overseer' is owner-only and needs no PR", () => {
    expect(authorizeCommand({ command: "restart-session", pr: "overseer" }, rec("owner")).ok).toBe(true);
    expect(authorizeCommand({ command: "restart-session", pr: "overseer" }, rec("author", [1])).ok).toBe(false);
  });
});
