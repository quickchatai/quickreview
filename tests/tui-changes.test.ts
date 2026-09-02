// The change register (FT-0234): what counts as a feedback-derived change, how
// reverts are read back out of git, that the list survives a restart, that the
// revert is bounded (dirty tree, unknown sha, conflict) and confirmed, and —
// the one that bites — that `5` and `y` are REGISTERED keys, so neither falls
// through to the companion strip.
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TUI_DEFAULTS } from "../src/config.js";
import { App, type Tab } from "../src/tui/app.js";
import { registeredKeys, TAB_COMMANDS } from "../src/tui/cmdbar.js";
import { decodeKey } from "../src/tui/keys.js";
import { Frame, stripAnsi } from "../src/tui/paint.js";
import {
  CHANGE_LOG_FORMAT,
  ChangeLog,
  ChangeRegisterStore,
  DIRTY_ARGV,
  REVERT_ABORT_ARGV,
  TRAILER_RATIFIED,
  buildEntries,
  changeLogArgv,
  mergeRegister,
  messageTrailers,
  parseGitLog,
  revertArgv,
  revertedSha,
  type ChangeEntry,
} from "../src/tui/changelog-store.js";
import { installChangesHooks, renderChanges, type ChangesView } from "../src/tui/changestab.js";
import type { RemoteResult } from "../src/tui/remote.js";

const FS = "\x1f";
const RS = "\x1e";

function record(sha: string, at: string, author: string, subject: string, body: string): string {
  return [sha, at, author, subject, body].join(FS) + RS;
}

/** A landed change exactly as `land` tells the companion to write it. */
function landed(sha: string, at: string, subject: string, opts: { pr?: string; ticket?: string } = {}): string {
  const trailers = [
    ...(opts.pr ? [`Feedback-PR: ${opts.pr}`] : []),
    ...(opts.ticket ? [`Adjudication: ${opts.ticket}`] : []),
    `${TRAILER_RATIFIED}: 2026-08-25 companion — "yes, land it"`,
  ].join("\n");
  return record(sha, at, "QCR Companion", subject, `${subject}\n\nA sentence of body.\n\n${trailers}\n`);
}

describe("the trailer convention", () => {
  it("reads the trailer block, and only the last paragraph of it", () => {
    const t = messageTrailers('subject\n\nbody line\n\nFeedback-PR: 5270\nAdjudication: FT-0231\nRatified-in-session: he said "yes"\n');
    expect(t[TRAILER_RATIFIED]).toBe('he said "yes"');
    expect(t["Feedback-PR"]).toBe("5270");
    expect(t["Adjudication"]).toBe("FT-0231");
  });

  it("a prose line inside the last paragraph voids the block — a body sentence can never mint a register entry", () => {
    const t = messageTrailers("subject\n\nRatified-in-session: yes\nand then some prose about it\n");
    expect(t).toEqual({});
  });

  it("a `Ratified-in-session:` mentioned mid-body is not a trailer", () => {
    const t = messageTrailers("subject\n\nSomeone wrote Ratified-in-session: nope in the body\n\nthe end.\n");
    expect(t[TRAILER_RATIFIED]).toBeUndefined();
  });

  it("git's own revert message is how a revert is identified", () => {
    expect(revertedSha('Revert "thing"\n\nThis reverts commit 1111111111111111111111111111111111111111.\n')).toBe(
      "1111111111111111111111111111111111111111",
    );
    expect(revertedSha("ordinary commit\n")).toBeUndefined();
  });

  it("the log argv asks for exactly the fields the parser splits on", () => {
    expect(changeLogArgv(9)).toEqual(["git", "log", "-9", `--format=${CHANGE_LOG_FORMAT}`]);
    expect(CHANGE_LOG_FORMAT).toContain("%B");
  });
});

describe("building the register", () => {
  const now = "2026-08-25T10:00:00.000Z";

  it("lists only commits carrying the never-omitted trailer, newest first", () => {
    const log =
      landed("a".repeat(40), "2026-08-25T09:00:00Z", "severity: stop blocking on contrived paths", { pr: "5270", ticket: "FT-0231" }) +
      record("b".repeat(40), "2026-08-25T08:00:00Z", "dev-session", "tests: tidy", "tests: tidy\n") +
      landed("c".repeat(40), "2026-08-24T08:00:00Z", "round template: nit scope wording");
    const entries = buildEntries(parseGitLog(log), now);
    expect(entries.map((e) => e.subject)).toEqual([
      "severity: stop blocking on contrived paths",
      "round template: nit scope wording",
    ]);
    expect(entries[0]!.feedback_pr).toBe("5270");
    expect(entries[0]!.adjudication).toBe("FT-0231");
    expect(entries[1]!.feedback_pr).toBeUndefined(); // no episode ⇒ omitted, never invented
    expect(entries[0]!.first_seen).toBe(now);
  });

  it("marks an entry reverted from git's own message — even when the revert is an untrailered commit", () => {
    const target = "a".repeat(40);
    const log =
      record("d".repeat(40), "2026-08-25T12:00:00Z", "mat", 'Revert "severity"', `Revert "severity"\n\nThis reverts commit ${target}.\n`) +
      landed(target, "2026-08-25T09:00:00Z", "severity");
    const entries = buildEntries(parseGitLog(log), now);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.reverted?.by).toBe("d".repeat(7));
  });

  it("an abbreviated revert reference still matches", () => {
    const target = "a".repeat(40);
    const log =
      record("d".repeat(40), "2026-08-25T12:00:00Z", "mat", "Revert", `Revert\n\nThis reverts commit ${target.slice(0, 12)}.\n`) +
      landed(target, "2026-08-25T09:00:00Z", "severity");
    expect(buildEntries(parseGitLog(log), now)[0]!.reverted).toBeDefined();
  });
});

describe("merging: a record, not a mirror", () => {
  const entry = (sha: string, at: string, first: string): ChangeEntry => ({
    sha,
    short: sha.slice(0, 7),
    at,
    author: "QCR Companion",
    subject: `change ${sha.slice(0, 3)}`,
    ratified: "yes",
    first_seen: first,
  });

  it("keeps first_seen from the stored row", () => {
    const merged = mergeRegister([entry("a".repeat(40), "2026-08-20T00:00:00Z", "2026-08-20T01:00:00Z")], [
      entry("a".repeat(40), "2026-08-20T00:00:00Z", "2026-08-25T00:00:00Z"),
    ]);
    expect(merged[0]!.first_seen).toBe("2026-08-20T01:00:00Z");
  });

  it("never drops a row the fresh scan no longer reaches", () => {
    const merged = mergeRegister([entry("a".repeat(40), "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z")], [
      entry("b".repeat(40), "2026-08-25T00:00:00Z", "2026-08-25T00:00:00Z"),
    ]);
    expect(merged.map((e) => e.short)).toEqual(["bbbbbbb", "aaaaaaa"]); // newest first, nothing lost
  });
});

describe("durability across a restart", () => {
  let dir = "";
  beforeEach(() => (dir = mkdtempSync(join(tmpdir(), "qcr-changes-"))));
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("the file is written atomically and re-read by a fresh store", async () => {
    const log = landed("a".repeat(40), "2026-08-25T09:00:00Z", "severity change", { pr: "5270" });
    const runner = async (argv: string[]): Promise<RemoteResult> =>
      argv[1] === "log" ? { ok: true, stdout: log, stderr: "", code: 0 } : { ok: true, stdout: "", stderr: "", code: 0 };
    const first = new ChangeLog(new ChangeRegisterStore(dir), runner);
    await first.refresh();
    expect(readFileSync(join(dir, "change-register.json"), "utf8")).toContain("severity change");

    // A new process: nothing in memory, git not asked yet.
    const second = new ChangeLog(new ChangeRegisterStore(dir), async () => ({ ok: false, stdout: "", stderr: "no git", code: 1 }));
    expect(second.register?.entries[0]!.subject).toBe("severity change");
    await second.refresh(); // a failed scan must not empty the list
    expect(second.register?.entries).toHaveLength(1);
  });

  it("a corrupt register is not a crash and not an empty list — and not the same answer as no register", () => {
    writeFileSync(join(dir, "change-register.json"), "{not json");
    expect(new ChangeRegisterStore(dir).read()).toMatchObject({ state: "unreadable" });
    writeFileSync(join(dir, "change-register.json"), JSON.stringify({ version: 1, entries: "nope" }));
    expect(new ChangeRegisterStore(dir).read()).toEqual({ state: "unreadable", reason: "no entries array" });
    rmSync(join(dir, "change-register.json"));
    expect(new ChangeRegisterStore(dir).read()).toEqual({ state: "absent" });
  });
});

describe("the revert, and everything it refuses", () => {
  let dir = "";
  const log = landed("a".repeat(40), "2026-08-25T09:00:00Z", "severity change", { pr: "5270" });

  function harness(over: (argv: string[]) => RemoteResult | undefined = () => undefined) {
    const calls: string[][] = [];
    const runner = async (argv: string[]): Promise<RemoteResult> => {
      calls.push(argv);
      const custom = over(argv);
      if (custom) return custom;
      if (argv[1] === "log") return { ok: true, stdout: log, stderr: "", code: 0 };
      return { ok: true, stdout: "", stderr: "", code: 0 };
    };
    return { calls, log: new ChangeLog(new ChangeRegisterStore(dir), runner) };
  }

  beforeEach(() => (dir = mkdtempSync(join(tmpdir(), "qcr-changes-"))));
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("reverts a listed change with git revert --no-edit, and nothing else", async () => {
    const h = harness();
    await h.log.refresh();
    const res = await h.log.revert("a".repeat(40));
    expect(res.ok).toBe(true);
    expect(h.calls).toContainEqual(DIRTY_ARGV);
    expect(h.calls).toContainEqual(revertArgv("a".repeat(40)));
    // Never a push, never a remote, never anything but git in this checkout.
    for (const argv of h.calls) {
      expect(argv[0]).toBe("git");
      expect(argv).not.toContain("push");
    }
  });

  it("REFUSES on a dirty tree — the companion's in-flight work is never touched (rule 11)", async () => {
    const h = harness((argv) => (argv[1] === "status" ? { ok: true, stdout: " M src/tui/app.ts\n M src/tui/sidebar.ts\n", stderr: "", code: 0 } : undefined));
    await h.log.refresh();
    const res = await h.log.revert("a".repeat(40));
    expect(res.ok).toBe(false);
    expect(res.message).toContain("companion");
    expect(h.calls.some((a) => a[1] === "revert")).toBe(false);
    expect(h.calls.some((a) => a.includes("stash") || a.includes("reset") || a.includes("checkout"))).toBe(false);
  });

  it("aborts a conflicted revert rather than leaving the shared tree half-applied", async () => {
    const h = harness((argv) => (argv[1] === "revert" && argv[3] ? { ok: false, stdout: "", stderr: "error: could not revert\n", code: 1 } : undefined));
    await h.log.refresh();
    const res = await h.log.revert("a".repeat(40));
    expect(res.ok).toBe(false);
    expect(h.calls).toContainEqual(REVERT_ABORT_ARGV);
  });

  it("refuses a sha the register does not list — this is not a run-git-for-me surface", async () => {
    const h = harness();
    await h.log.refresh();
    const res = await h.log.revert("f".repeat(40));
    expect(res.ok).toBe(false);
    expect(h.calls.some((a) => a[1] === "revert")).toBe(false);
  });

  it("refuses a change already reverted", async () => {
    const target = "a".repeat(40);
    const withRevert =
      record("d".repeat(40), "2026-08-25T12:00:00Z", "mat", "Revert", `Revert\n\nThis reverts commit ${target}.\n`) +
      landed(target, "2026-08-25T09:00:00Z", "severity change");
    const calls: string[][] = [];
    const cl = new ChangeLog(new ChangeRegisterStore(dir), async (argv) => {
      calls.push(argv);
      return argv[1] === "log" ? { ok: true, stdout: withRevert, stderr: "", code: 0 } : { ok: true, stdout: "", stderr: "", code: 0 };
    });
    await cl.refresh();
    const res = await cl.revert(target);
    expect(res.ok).toBe(false);
    expect(calls.some((a) => a[1] === "revert")).toBe(false);
  });
});

function appHarness(): App {
  const out = new EventEmitter() as unknown as NodeJS.WriteStream;
  (out as unknown as { columns: number }).columns = 120;
  (out as unknown as { rows: number }).rows = 30;
  out.write = (() => true) as never;
  const input = new EventEmitter() as unknown as NodeJS.ReadStream;
  (input as unknown as { isTTY: boolean }).isTTY = false;
  input.resume = (() => input) as never;
  input.pause = (() => input) as never;
  return new App(TUI_DEFAULTS, async () => ({ ok: true, stdout: "", stderr: "", code: 0 }), out, input);
}

/** Drive the tab's screen hook the way a repaint does, as plain text. */
function paintChanges(app: App): string {
  const frame = app.hooks.changesScreen!(app, 120, 30);
  return typeof frame === "string" ? frame : frame.lines.map(stripAnsi).join("\n");
}

describe("the tab", () => {
  const view = (entries: ChangeEntry[]): ChangesView => ({
    register: { version: 1, updated_at: "2026-08-25T10:00:00Z", entries, scanned: 40 },
    sel: 0,
    scroll: 0,
    loading: false,
    autoScanned: true,
    dryRun: false,
    now: new Date("2026-08-25T11:00:00Z"),
  });

  const entry = (sha: string, subject: string, reverted?: { by: string; at: string }): ChangeEntry => ({
    sha,
    short: sha.slice(0, 7),
    at: "2026-08-25T09:00:00Z",
    author: "QCR Companion",
    subject,
    feedback_pr: "5270",
    adjudication: "FT-0231",
    ratified: 'he said "yes"',
    first_seen: "2026-08-25T09:30:00Z",
    ...(reverted ? { reverted } : {}),
  });

  it("paints the changes newest first, with their provenance and a reverted mark", () => {
    const frame = renderChanges(view([entry("a".repeat(40), "newest change"), entry("b".repeat(40), "older change", { by: "ddddddd", at: "x" })]), 120, 30);
    const text = frame.lines.map(stripAnsi).join("\n");
    expect(text.indexOf("newest change")).toBeLessThan(text.indexOf("older change"));
    expect(text).toContain("feedback #5270");
    expect(text).toContain("FT-0231");
    expect(text).toContain("reverted by ddddddd");
    expect(text).toContain("5 changes"); // the command bar knows which tab it is on
  });

  it("an empty register says what puts a change on the list", () => {
    const text = renderChanges(view([]), 120, 30).lines.map(stripAnsi).join("\n");
    expect(text).toContain("Ratified-in-session:");
  });

  // FT-0397 — "no feedback-derived commits yet" is a CLAIM, made only when a
  // scan succeeded and found none. The two ways of not knowing each get their
  // own sentence, and neither hides the rows already in memory.
  it("an unreadable register or a failed scan is SAID, never painted as 'no changes yet'", () => {
    const unreadable = renderChanges({ ...view([]), problem: { kind: "register_unreadable", reason: "EACCES" } }, 120, 30).lines.map(stripAnsi).join("\n");
    expect(unreadable).toContain("change register unreadable");
    expect(unreadable).toContain("EACCES");
    expect(unreadable).not.toContain("no feedback-derived commits yet");

    const failed = renderChanges({ ...view([]), register: undefined, problem: { kind: "scan_failed", reason: "fatal: not a git repository" } }, 120, 30)
      .lines.map(stripAnsi)
      .join("\n");
    expect(failed).toContain("git log failed");
    expect(failed).toContain("not a git repository");
    expect(failed).not.toContain("no feedback-derived commits yet");

    // Rows already known stay on screen under the caveat.
    const withRows = renderChanges({ ...view([entry("a".repeat(40), "newest change")]), problem: { kind: "register_unreadable", reason: "EIO" } }, 120, 30)
      .lines.map(stripAnsi)
      .join("\n");
    expect(withRows).toContain("change register unreadable");
    expect(withRows).toContain("newest change");
    const behind = renderChanges({ ...view([entry("a".repeat(40), "newest change")]), problem: { kind: "scan_failed", reason: "x" } }, 120, 30)
      .lines.map(stripAnsi)
      .join("\n");
    expect(behind).toContain("last scan failed");
    expect(behind).toContain("1 changes");
  });

  it("R arms and paints exactly what will run; y is what actually reverts", async () => {
    const dir = mkdtempSync(join(tmpdir(), "qcr-changes-"));
    try {
      const calls: string[][] = [];
      const cl = new ChangeLog(new ChangeRegisterStore(dir), async (argv) => {
        calls.push(argv);
        return argv[1] === "log"
          ? { ok: true, stdout: landed("a".repeat(40), "2026-08-25T09:00:00Z", "severity change"), stderr: "", code: 0 }
          : { ok: true, stdout: "", stderr: "", code: 0 };
      });
      await cl.refresh();
      const app = appHarness();
      const v = installChangesHooks(app, cl);
      app.tab = "changes";

      expect(app.hooks.changesKey!(app, decodeKey(Buffer.from("R")))).toBe(true);
      expect(v.armed).toBe("a".repeat(40));
      expect(calls.some((a) => a[1] === "revert")).toBe(false); // armed is not done

      const frame = app.hooks.changesScreen!(app, 120, 30);
      const text = typeof frame === "string" ? frame : frame.lines.map(stripAnsi).join("\n");
      expect(text).toContain("git revert --no-edit aaaaaaa");
      expect(text).toContain("no push, no GitHub");
      expect(text).toContain("y do it");

      app.hooks.changesKey!(app, decodeKey(Buffer.from("y")));
      await new Promise((r) => setTimeout(r, 5));
      expect(calls.some((a) => a[1] === "revert")).toBe(true);
      expect(v.armed).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("any other key cancels an armed revert, and runs nothing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "qcr-changes-"));
    try {
      const calls: string[][] = [];
      const cl = new ChangeLog(new ChangeRegisterStore(dir), async (argv) => {
        calls.push(argv);
        return argv[1] === "log"
          ? { ok: true, stdout: landed("a".repeat(40), "2026-08-25T09:00:00Z", "severity change"), stderr: "", code: 0 }
          : { ok: true, stdout: "", stderr: "", code: 0 };
      });
      await cl.refresh();
      const app = appHarness();
      const v = installChangesHooks(app, cl);
      app.tab = "changes";
      app.hooks.changesKey!(app, decodeKey(Buffer.from("R")));
      expect(app.hooks.changesKey!(app, decodeKey(Buffer.from("n")))).toBe(true);
      expect(v.armed).toBeUndefined();
      await new Promise((r) => setTimeout(r, 5));
      expect(calls.some((a) => a[1] === "revert")).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the companion is told to stamp it", () => {
  it("prompts/companion.md documents the trailer block, the never-omitted key, and the tab that reads it", () => {
    const prompt = readFileSync(join(process.cwd(), "prompts/companion.md"), "utf8");
    // The same three trailers the `land` skill promises — no competing set.
    for (const t of ["Feedback-PR:", "Adjudication:", "Ratified-in-session:"]) expect(prompt).toContain(t);
    expect(prompt).toMatch(/`Ratified-in-session:` is never omitted/);
    expect(prompt).toMatch(/last paragraph only/);
    expect(prompt.replace(/\s+/g, " ")).toContain("`[5] changes` tab");
  });

  it("the land skill and the register agree on the identifying trailer", () => {
    const skill = readFileSync(join(process.cwd(), "skills/companion/land/SKILL.md"), "utf8");
    expect(skill).toContain(`${TRAILER_RATIFIED}:`);
    expect(skill).toMatch(/`Ratified-in-session:` is never omitted/);
  });
});

describe("key routing — the tab's keys must never reach the companion strip", () => {
  const TABS: Tab[] = ["board", "digest", "deploy", "metrics", "changes"];

  it("`5` decodes to the changes tab", () => {
    expect(decodeKey(Buffer.from("5"))).toEqual({ kind: "tab-changes" });
  });

  it("`5` is registered on EVERY tab — an unregistered printable focuses the companion column and is typed into pi", () => {
    for (const tab of TABS) expect(registeredKeys(tab).has("5"), `5 unregistered on ${tab}`).toBe(true);
  });

  it("the changes tab's own keys (R, y) are registered there", () => {
    expect(TAB_COMMANDS.changes.map((b) => b.key)).toContain("R");
    for (const k of ["R", "y", "Y", "j", "k", "r"]) expect(registeredKeys("changes").has(k), `${k} unregistered`).toBe(true);
  });

  it("`5` still reaches the metrics tab's PR box as a DIGIT — #5265 must not lose its 5", async () => {
    const out = new EventEmitter() as unknown as NodeJS.WriteStream;
    (out as unknown as { columns: number }).columns = 120;
    (out as unknown as { rows: number }).rows = 30;
    out.write = (() => true) as never;
    const input = new EventEmitter() as unknown as NodeJS.ReadStream;
    (input as unknown as { isTTY: boolean }).isTTY = false;
    input.resume = (() => input) as never;
    input.pause = (() => input) as never;
    const app = new App(TUI_DEFAULTS, async () => ({ ok: true, stdout: "", stderr: "", code: 0 }), out, input);
    const { installMetricsHooks } = await import("../src/tui/metricstab.js");
    const view = installMetricsHooks(app, { overall: async () => ({ error: "x" }), timeline: async () => ({ error: "x" }) });
    const running = app.run();
    app.tab = "metrics";
    const type = (s: string) => (input as unknown as EventEmitter).emit("data", Buffer.from(s));
    type("#");
    for (const d of "5265") type(d);
    expect(view.prEntry).toBe("5265");
    type("\x1b"); // cancel the entry — outside it, 5 goes back to being the tab key
    type("5");
    expect(app.tab).toBe("changes");
    app.quit();
    await running;
  });

  it("an App keypress switches to the tab and routes into its handler", async () => {
    const out = new EventEmitter() as unknown as NodeJS.WriteStream;
    (out as unknown as { columns: number }).columns = 120;
    (out as unknown as { rows: number }).rows = 30;
    out.write = (() => true) as never;
    const input = new EventEmitter() as unknown as NodeJS.ReadStream;
    (input as unknown as { isTTY: boolean }).isTTY = false;
    input.resume = (() => input) as never;
    input.pause = (() => input) as never;
    const app = new App(TUI_DEFAULTS, async () => ({ ok: true, stdout: "", stderr: "", code: 0 }), out, input);
    const seen: string[] = [];
    app.hooks.changesKey = (_a, key) => {
      seen.push(key.kind);
      return true;
    };
    app.hooks.changesScreen = (_a, cols, rows) => new Frame(cols, rows);
    const running = app.run();
    (input as unknown as EventEmitter).emit("data", Buffer.from("5"));
    expect(app.tab).toBe("changes");
    (input as unknown as EventEmitter).emit("data", Buffer.from("j"));
    expect(seen).toContain("down");
    app.quit();
    await running;
  });
});

// FT-0397 — the register's docstrings promise two things `refresh` cannot keep
// from a baseline it could not read: rows the scan no longer reaches are kept,
// and `first_seen` is never rewritten. A torn file merged as "no previous
// entries" and saved falsifies both at once. And the fix has to land BOTH
// halves: the first attempt at it stood the save down but left the tab's
// loader re-arming on "still no register", which the review measured at 502
// `git log` spawns and 502 paints in 200 ms.
describe("an unreadable register is neither saved over nor painted as 'no changes'", () => {
  let dir = "";
  beforeEach(() => (dir = mkdtempSync(join(tmpdir(), "qcr-changes-"))));
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const TORN = '{"version":1,"updated_at":"2026-08-25T09:00:00Z","entries":[{"sha":"a';
  const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 2));

  it("refresh stands down on a torn file: no git, no merge, no save — and says why", async () => {
    writeFileSync(join(dir, "change-register.json"), TORN);
    const calls: string[][] = [];
    const cl = new ChangeLog(new ChangeRegisterStore(dir), async (argv) => {
      calls.push(argv);
      return { ok: true, stdout: landed("b".repeat(40), "2026-08-25T10:00:00Z", "a later change"), stderr: "", code: 0 };
    });
    expect(cl.register).toBeUndefined();
    expect(cl.problem?.kind).toBe("register_unreadable");

    expect((await cl.refresh())?.kind).toBe("register_unreadable");
    expect(calls).toEqual([]); // git was never asked
    // Byte-for-byte what it was: nothing was merged onto an "empty" baseline
    // and written back over the history.
    expect(readFileSync(join(dir, "change-register.json"), "utf8")).toBe(TORN);
    expect(cl.register).toBeUndefined();
  });

  it("a register that tears mid-run keeps the last true list in memory, flags it, and does not overwrite", async () => {
    const good = landed("a".repeat(40), "2026-08-25T09:00:00Z", "severity change");
    const cl = new ChangeLog(new ChangeRegisterStore(dir), async () => ({ ok: true, stdout: good, stderr: "", code: 0 }));
    expect(await cl.refresh()).toBeUndefined();
    expect(cl.register?.entries).toHaveLength(1);

    writeFileSync(join(dir, "change-register.json"), TORN);
    expect((await cl.refresh())?.kind).toBe("register_unreadable");
    expect(cl.register?.entries).toHaveLength(1);
    expect(readFileSync(join(dir, "change-register.json"), "utf8")).toBe(TORN);

    // Readable again: the scan resumes and the caveat clears.
    rmSync(join(dir, "change-register.json"));
    expect(await cl.refresh()).toBeUndefined();
    expect(cl.problem).toBeUndefined();
    expect(cl.register?.entries).toHaveLength(1);
  });

  it("the tab SAYS the register is unreadable — and the loader does not re-arm on it", async () => {
    writeFileSync(join(dir, "change-register.json"), TORN);
    const store = new ChangeRegisterStore(dir);
    let reads = 0;
    const read = store.read.bind(store);
    store.read = () => (reads += 1, read());
    const gitCalls: string[][] = [];
    const cl = new ChangeLog(store, async (argv) => (gitCalls.push(argv), { ok: true, stdout: "", stderr: "", code: 0 }));
    const app = appHarness();
    const v = installChangesHooks(app, cl);
    app.tab = "changes";

    let text = "";
    for (let i = 0; i < 6; i++) {
      text = paintChanges(app);
      await tick();
    }
    // The constructor's read plus ONE automatic scan (which stood down at its
    // read). Six paints, not six scans: the loader arms once per run.
    expect(reads).toBe(2);
    expect(gitCalls).toEqual([]);
    expect(v.autoScanned).toBe(true);
    expect(text).toContain("change register unreadable");
    expect(text).not.toContain("no feedback-derived commits yet");

    // `r` is the way back in once the file is fixed.
    rmSync(join(dir, "change-register.json"));
    expect(app.hooks.changesKey!(app, decodeKey(Buffer.from("r")))).toBe(true);
    await tick();
    expect(gitCalls).toHaveLength(1);
    expect(v.problem).toBeUndefined();
    expect(paintChanges(app)).toContain("no feedback-derived commits yet");
  });

  it("a failed scan with nothing stored says so, once — not 'no changes yet', and not a scan per repaint", async () => {
    const gitCalls: string[][] = [];
    const cl = new ChangeLog(new ChangeRegisterStore(dir), async (argv) => {
      gitCalls.push(argv);
      return { ok: false, stdout: "", stderr: "fatal: not a git repository", code: 128 };
    });
    const app = appHarness();
    installChangesHooks(app, cl);
    app.tab = "changes";
    let text = "";
    for (let i = 0; i < 6; i++) {
      text = paintChanges(app);
      await tick();
    }
    expect(gitCalls).toHaveLength(1);
    expect(text).toContain("git log failed");
    expect(text).toContain("not a git repository");
    expect(text).not.toContain("no feedback-derived commits yet");
  });
});
