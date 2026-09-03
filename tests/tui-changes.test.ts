// The change register (FT-0234): what counts as a feedback-derived change, how
// reverts are read back out of git, that the list survives a restart, and that
// the revert is bounded (dirty tree, unknown sha, conflict). The SURFACE that
// paints it and confirms the revert is the feedback tab since FT-0398 —
// tests/feedbacktab.test.ts.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
import type { RemoteResult } from "../src/tui/remote.js";

const FS = "\x1f";
const RS = "\x1e";

function record(sha: string, at: string, author: string, subject: string, body: string): string {
  return [sha, at, author, subject, body].join(FS) + RS;
}

/** A landed change exactly as `land` tells the companion to write it. */
function landed(
  sha: string,
  at: string,
  subject: string,
  opts: { pr?: string; ticket?: string } = {},
): string {
  const trailers = [
    ...(opts.pr ? [`Feedback-PR: ${opts.pr}`] : []),
    ...(opts.ticket ? [`Adjudication: ${opts.ticket}`] : []),
    `${TRAILER_RATIFIED}: 2026-08-25 companion — "yes, land it"`,
  ].join("\n");
  return record(
    sha,
    at,
    "QCR Companion",
    subject,
    `${subject}\n\nA sentence of body.\n\n${trailers}\n`,
  );
}

describe("the trailer convention", () => {
  it("reads the trailer block, and only the last paragraph of it", () => {
    const t = messageTrailers(
      'subject\n\nbody line\n\nFeedback-PR: 5270\nAdjudication: FT-0231\nRatified-in-session: he said "yes"\n',
    );
    expect(t[TRAILER_RATIFIED]).toBe('he said "yes"');
    expect(t["Feedback-PR"]).toBe("5270");
    expect(t["Adjudication"]).toBe("FT-0231");
  });

  it("a prose line inside the last paragraph voids the block — a body sentence can never mint a register entry", () => {
    const t = messageTrailers(
      "subject\n\nRatified-in-session: yes\nand then some prose about it\n",
    );
    expect(t).toEqual({});
  });

  it("a `Ratified-in-session:` mentioned mid-body is not a trailer", () => {
    const t = messageTrailers(
      "subject\n\nSomeone wrote Ratified-in-session: nope in the body\n\nthe end.\n",
    );
    expect(t[TRAILER_RATIFIED]).toBeUndefined();
  });

  it("git's own revert message is how a revert is identified", () => {
    expect(
      revertedSha(
        'Revert "thing"\n\nThis reverts commit 1111111111111111111111111111111111111111.\n',
      ),
    ).toBe("1111111111111111111111111111111111111111");
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
      landed("a".repeat(40), "2026-08-25T09:00:00Z", "severity: stop blocking on contrived paths", {
        pr: "5270",
        ticket: "FT-0231",
      }) +
      record(
        "b".repeat(40),
        "2026-08-25T08:00:00Z",
        "dev-session",
        "tests: tidy",
        "tests: tidy\n",
      ) +
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
      record(
        "d".repeat(40),
        "2026-08-25T12:00:00Z",
        "mat",
        'Revert "severity"',
        `Revert "severity"\n\nThis reverts commit ${target}.\n`,
      ) + landed(target, "2026-08-25T09:00:00Z", "severity");
    const entries = buildEntries(parseGitLog(log), now);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.reverted?.by).toBe("d".repeat(7));
  });

  it("an abbreviated revert reference still matches", () => {
    const target = "a".repeat(40);
    const log =
      record(
        "d".repeat(40),
        "2026-08-25T12:00:00Z",
        "mat",
        "Revert",
        `Revert\n\nThis reverts commit ${target.slice(0, 12)}.\n`,
      ) + landed(target, "2026-08-25T09:00:00Z", "severity");
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
    const merged = mergeRegister(
      [entry("a".repeat(40), "2026-08-20T00:00:00Z", "2026-08-20T01:00:00Z")],
      [entry("a".repeat(40), "2026-08-20T00:00:00Z", "2026-08-25T00:00:00Z")],
    );
    expect(merged[0]!.first_seen).toBe("2026-08-20T01:00:00Z");
  });

  it("never drops a row the fresh scan no longer reaches", () => {
    const merged = mergeRegister(
      [entry("a".repeat(40), "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z")],
      [entry("b".repeat(40), "2026-08-25T00:00:00Z", "2026-08-25T00:00:00Z")],
    );
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
      argv[1] === "log"
        ? { ok: true, stdout: log, stderr: "", code: 0 }
        : { ok: true, stdout: "", stderr: "", code: 0 };
    const first = new ChangeLog(new ChangeRegisterStore(dir), runner);
    await first.refresh();
    expect(readFileSync(join(dir, "change-register.json"), "utf8")).toContain("severity change");

    // A new process: nothing in memory, git not asked yet.
    const second = new ChangeLog(new ChangeRegisterStore(dir), async () => ({
      ok: false,
      stdout: "",
      stderr: "no git",
      code: 1,
    }));
    expect(second.register?.entries[0]!.subject).toBe("severity change");
    await second.refresh(); // a failed scan must not empty the list
    expect(second.register?.entries).toHaveLength(1);
  });

  it("a corrupt register is not a crash and not an empty list — and not the same answer as no register", () => {
    writeFileSync(join(dir, "change-register.json"), "{not json");
    expect(new ChangeRegisterStore(dir).read()).toMatchObject({ state: "unreadable" });
    writeFileSync(
      join(dir, "change-register.json"),
      JSON.stringify({ version: 1, entries: "nope" }),
    );
    expect(new ChangeRegisterStore(dir).read()).toEqual({
      state: "unreadable",
      reason: "no entries array",
    });
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
    const h = harness((argv) =>
      argv[1] === "status"
        ? { ok: true, stdout: " M src/tui/app.ts\n M src/tui/sidebar.ts\n", stderr: "", code: 0 }
        : undefined,
    );
    await h.log.refresh();
    const res = await h.log.revert("a".repeat(40));
    expect(res.ok).toBe(false);
    expect(res.message).toContain("companion");
    expect(h.calls.some((a) => a[1] === "revert")).toBe(false);
    expect(
      h.calls.some((a) => a.includes("stash") || a.includes("reset") || a.includes("checkout")),
    ).toBe(false);
  });

  it("aborts a conflicted revert rather than leaving the shared tree half-applied", async () => {
    const h = harness((argv) =>
      argv[1] === "revert" && argv[3]
        ? { ok: false, stdout: "", stderr: "error: could not revert\n", code: 1 }
        : undefined,
    );
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
      record(
        "d".repeat(40),
        "2026-08-25T12:00:00Z",
        "mat",
        "Revert",
        `Revert\n\nThis reverts commit ${target}.\n`,
      ) + landed(target, "2026-08-25T09:00:00Z", "severity change");
    const calls: string[][] = [];
    const cl = new ChangeLog(new ChangeRegisterStore(dir), async (argv) => {
      calls.push(argv);
      return argv[1] === "log"
        ? { ok: true, stdout: withRevert, stderr: "", code: 0 }
        : { ok: true, stdout: "", stderr: "", code: 0 };
    });
    await cl.refresh();
    const res = await cl.revert(target);
    expect(res.ok).toBe(false);
    expect(calls.some((a) => a[1] === "revert")).toBe(false);
  });
});

describe("the companion is told to stamp it", () => {
  it("prompts/companion.md documents the trailer block, the never-omitted key, and the surface that reads it", () => {
    const prompt = readFileSync(join(process.cwd(), "prompts/companion.md"), "utf8");
    // The same three trailers the `land` skill promises — no competing set.
    for (const t of ["Feedback-PR:", "Adjudication:", "Ratified-in-session:"])
      expect(prompt).toContain(t);
    expect(prompt).toMatch(/`Ratified-in-session:` is never omitted/);
    expect(prompt).toMatch(/last paragraph only/);
    // FT-0398: the register is the CHANGED pane of the feedback tab; the old
    // `[5] changes` tab is gone and the prompt must not send the companion there.
    expect(prompt.replace(/\s+/g, " ")).toContain("`[7] feedback` tab");
    expect(prompt).not.toMatch(/\[5\] changes/);
  });

  it("the land skill and the register agree on the identifying trailer", () => {
    const skill = readFileSync(join(process.cwd(), "skills/companion/land/SKILL.md"), "utf8");
    expect(skill).toContain(`${TRAILER_RATIFIED}:`);
    expect(skill).toMatch(/`Ratified-in-session:` is never omitted/);
  });
});

// FT-0397 — the register's docstrings promise two things `refresh` cannot keep
// from a baseline it could not read: rows the scan no longer reaches are kept,
// and `first_seen` is never rewritten. A torn file merged as "no previous
// entries" and saved falsifies both at once. And the fix has to land BOTH
// halves: the first attempt at it stood the save down but left the tab's
// loader re-arming on "still no register", which the review measured at 502
// `git log` spawns and 502 paints in 200 ms. The SURFACE half (what is said
// on screen, and that the loader arms once) is tests/feedbacktab.test.ts.
describe("an unreadable register is neither saved over nor merged onto", () => {
  let dir = "";
  beforeEach(() => (dir = mkdtempSync(join(tmpdir(), "qcr-changes-"))));
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const TORN = '{"version":1,"updated_at":"2026-08-25T09:00:00Z","entries":[{"sha":"a';

  it("refresh stands down on a torn file: no git, no merge, no save — and says why", async () => {
    writeFileSync(join(dir, "change-register.json"), TORN);
    const calls: string[][] = [];
    const cl = new ChangeLog(new ChangeRegisterStore(dir), async (argv) => {
      calls.push(argv);
      return {
        ok: true,
        stdout: landed("b".repeat(40), "2026-08-25T10:00:00Z", "a later change"),
        stderr: "",
        code: 0,
      };
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
    const cl = new ChangeLog(new ChangeRegisterStore(dir), async () => ({
      ok: true,
      stdout: good,
      stderr: "",
      code: 0,
    }));
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
});
