// The operator's round controls: steer, follow-up, abort-round, message
// (with an optional may_post), takeover, release and debug-round. They are
// OPERATOR commands, valid only from the root-sealed commands/operator/ channel;
// and the owner and the companion share one verb set (the tier table).
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  authorizeCommand,
  authorizeCompanionCommand,
  COMMAND_WHITELIST,
  CommandWatcher,
  CONTROL_COMMANDS,
  CONTROL_TEXT_MAX,
  executeCommand,
  OPERATOR_COMMANDS,
  tierAllows,
  tierVerbs,
  validateCommand,
  type CommandDeps,
  type ControlCommand,
  type OperatorSeal,
} from "../src/commands.js";
import { StateStore } from "../src/state.js";

const op = { issuer: "operator" as const };

const GOOD: Record<(typeof CONTROL_COMMANDS)[number], Record<string, unknown>> = {
  steer: { command: "steer", pr: 5049, text: "look at the lock order" },
  "follow-up": { command: "follow-up", pr: 5049, text: "then the migration" },
  "abort-round": { command: "abort-round", pr: 5049 },
  message: { command: "message", pr: 5050, text: "why did you block this?" },
  takeover: { command: "takeover", pr: 5050 },
  release: { command: "release", pr: 5050 },
  "debug-round": { command: "debug-round", pr: 5050 },
};

describe("the round controls are operator commands", () => {
  it("are the seven kinds, in the operator vocabulary and never in a session's", () => {
    expect([...CONTROL_COMMANDS]).toEqual([
      "steer",
      "follow-up",
      "abort-round",
      "message",
      "takeover",
      "release",
      "debug-round",
    ]);
    for (const c of CONTROL_COMMANDS) {
      expect(OPERATOR_COMMANDS).toContain(c);
      expect(COMMAND_WHITELIST).not.toContain(c);
    }
  });

  it.each(CONTROL_COMMANDS)(
    "%s: a session's file, or an unspecified issuer, cannot spell it",
    (name) => {
      for (const v of [
        validateCommand(GOOD[name]),
        validateCommand(GOOD[name], { issuer: "session" }),
      ]) {
        expect(v.ok).toBe(false);
        if (!v.ok) expect(v.reason).toMatch(/OPERATOR's alone/);
      }
      expect(validateCommand(GOOD[name], op)).toMatchObject({ ok: true });
    },
  );

  it("strict schemas from the operator channel", () => {
    expect(validateCommand({ command: "steer", pr: 1 }, op).ok).toBe(false);
    expect(validateCommand({ command: "steer", pr: 1, text: "   " }, op).ok).toBe(false);
    expect(validateCommand({ command: "steer", pr: 1, text: "x", may_post: true }, op)).toEqual({
      ok: false,
      reason: "unknown field(s): may_post",
    });
    expect(
      validateCommand({ command: "follow-up", pr: 1, text: "x".repeat(CONTROL_TEXT_MAX + 1) }, op)
        .ok,
    ).toBe(false);
    expect(
      validateCommand({ command: "follow-up", pr: 1, text: "x".repeat(CONTROL_TEXT_MAX) }, op).ok,
    ).toBe(true);
    for (const pr of [0, -1, 1.5, "7", null, undefined]) {
      expect(validateCommand({ command: "abort-round", pr }, op).ok, String(pr)).toBe(false);
      expect(validateCommand({ command: "message", pr, text: "x" }, op).ok, String(pr)).toBe(false);
    }
    for (const c of ["abort-round", "takeover", "release", "debug-round"])
      expect(validateCommand({ command: c, pr: 3, text: "x" }, op)).toEqual({
        ok: false,
        reason: "unknown field(s): text",
      });
  });

  it("message carries may_post only as a boolean, and only when given", () => {
    expect(validateCommand({ command: "message", pr: 4, text: "hi" }, op)).toEqual({
      ok: true,
      command: { command: "message", pr: 4, text: "hi" },
    });
    expect(validateCommand({ command: "message", pr: 4, text: "hi", may_post: true }, op)).toEqual({
      ok: true,
      command: { command: "message", pr: 4, text: "hi", may_post: true },
    });
    expect(validateCommand({ command: "message", pr: 4, text: "hi", may_post: false }, op)).toEqual(
      { ok: true, command: { command: "message", pr: 4, text: "hi", may_post: false } },
    );
    for (const bad of ["true", 1, null])
      expect(validateCommand({ command: "message", pr: 4, text: "hi", may_post: bad }, op).ok).toBe(
        false,
      );
  });

  it("executeCommand refuses any issuer but the operator, and a daemon without a host says so", async () => {
    const seen: Array<[ControlCommand, string]> = [];
    const deps = {
      operatorControl: (c: ControlCommand, file: string) => (seen.push([c, file]), { ok: true }),
    } as unknown as CommandDeps;
    const steer = validateCommand(GOOD["steer"], op);
    if (!steer.ok) throw new Error("fixture");
    expect(await executeCommand(steer.command, deps)).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/operator's alone/),
    });
    expect(seen).toEqual([]);
    expect(await executeCommand(steer.command, deps, { file: "k1", issuer: "operator" })).toEqual({
      ok: true,
    });
    expect(seen).toEqual([[steer.command, "k1"]]);
    expect(
      await executeCommand(steer.command, {} as CommandDeps, { file: "k1", issuer: "operator" }),
    ).toEqual({ ok: false, reason: "steer is not wired on this daemon" });
  });

  it("Slack can never authorize one, even at owner tier or with no origin", () => {
    const owner = { tier: "owner", source: "slack", slack_user: "U1", authorized_prs: [] } as never;
    for (const c of CONTROL_COMMANDS) {
      const v = validateCommand(GOOD[c], op);
      if (!v.ok) throw new Error("fixture");
      expect(authorizeCommand(v.command, owner), c).toMatchObject({ ok: false });
      expect(authorizeCommand(v.command, null), c).toMatchObject({ ok: false });
    }
  });
});

describe("the tier table: the companion's verbs are the owner's", () => {
  it("the companion tier's verb set equals the owner tier's", () => {
    const owner = tierVerbs("owner");
    expect(tierVerbs("companion")).toEqual(owner);
    // everything the owner can: the plan's list, plus the session verbs the owner has
    for (const v of [
      "steer",
      "abort-round",
      "takeover",
      "debug-round",
      "release",
      "message",
      "drain",
    ])
      expect(owner, v).toContain(v);
    for (const v of CONTROL_COMMANDS) expect(owner).toContain(v);
    for (const v of COMMAND_WHITELIST) expect(owner, v).toContain(v);
  });

  it("the system tier stays as it was and never steers or takes over a PR", () => {
    for (const v of ["rerun-round", "pause-pr", "drain", "eod-curation-receipt", "slack_reply"])
      expect(tierAllows("system", v), v).toBe(true);
    for (const v of CONTROL_COMMANDS) expect(tierAllows("system", v), v).toBe(false);
  });

  it("a verb outside the table is nobody's", () => {
    for (const t of ["owner", "companion", "system"] as const) {
      expect(tierAllows(t, "lessons-off")).toBe(false);
      expect(tierAllows(t, "no-such-verb")).toBe(false);
    }
    expect(authorizeCompanionCommand({ command: "steer", pr: 1, text: "x" })).toEqual({ ok: true });
    expect(authorizeCompanionCommand({ command: "archive-run" })).toMatchObject({ ok: false });
  });
});

describe("only the root-sealed operator directory serves them", () => {
  let dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    dirs = [];
  });
  const sealed: OperatorSeal = {
    euid: 1001,
    gids: [1001],
    stat: (p) =>
      p.endsWith(".json")
        ? { uid: 0, gid: 0, mode: 0o644, kind: "file" }
        : { uid: 0, gid: 0, mode: 0o755, kind: "dir" },
  };
  const root = (): string => {
    const d = mkdtempSync(join(tmpdir(), "qcr-control-"));
    dirs.push(d);
    mkdirSync(join(d, "commands"), { recursive: true });
    return join(d, "commands");
  };
  const resultOf = (dir: string, name: string): Record<string, unknown> =>
    JSON.parse(readFileSync(join(dir, "results", `${name}.result.json`), "utf8")) as Record<
      string,
      unknown
    >;

  it("a session's commands/ dir and an unsealed operator dir are refused; the sealed one reaches the handler", async () => {
    const store = new StateStore(":memory:");
    const control = vi.fn(async (_c: ControlCommand, _file: string) => ({
      ok: true,
      ack: "queued",
    }));
    const deps = { operatorControl: control } as unknown as CommandDeps;
    const dir = root();
    writeFileSync(join(dir, "s1.json"), JSON.stringify(GOOD["steer"]));
    const session = new CommandWatcher({ dir, deps, store, log: () => {} });
    await session.sweep();
    session.stop();
    expect(resultOf(dir, "s1")).toMatchObject({
      ok: false,
      issuer: "session",
      reason: expect.stringMatching(/OPERATOR's alone/),
    });

    const opDir = join(dir, "operator");
    mkdirSync(opDir);
    writeFileSync(join(opDir, "u1.json"), JSON.stringify(GOOD["abort-round"]));
    const unsealed = new CommandWatcher({
      dir: opDir,
      // a real seal: this process is not root, and the dir is ours, so it is unsealed
      operator: {
        euid: 1001,
        gids: [1001],
        stat: () => ({ uid: 1001, gid: 1001, mode: 0o755, kind: "dir" }),
      },
      deps,
      store,
      sweepIntervalMs: 0,
      log: () => {},
    });
    await unsealed.sweep();
    unsealed.stop();
    expect(resultOf(dir, "u1")).toMatchObject({ ok: false, issuer: "session" });
    expect(control).not.toHaveBeenCalled();

    writeFileSync(join(opDir, "k1.json"), JSON.stringify(GOOD["message"]));
    const sealedW = new CommandWatcher({
      dir: opDir,
      operator: sealed,
      deps,
      store,
      sweepIntervalMs: 0,
      log: () => {},
    });
    await sealedW.sweep();
    sealedW.stop();
    expect(control).toHaveBeenCalledTimes(1);
    expect(control.mock.calls[0]![0]).toMatchObject({ command: "message", pr: 5050 });
    expect(resultOf(dir, "k1")).toMatchObject({ ok: true, issuer: "operator", ack: "queued" });
    store.close();
  });
});
