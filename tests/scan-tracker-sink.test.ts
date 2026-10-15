// The tracker sink (setup & scan spec "Findings"): a promoted scan
// finding filed on a TEMP issue tracker exactly as the tracker's protocol
// says (id by exclusive create of `.ids/`, the header grammar, the edit lock
// around every rewrite), never twice (the fingerprint stamp), and closed only
// when the companion filed it and nobody has claimed it — plus the markdown
// fallback for an install without a tracker.
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stateHomeFs } from "../src/setup/adapters.js";
import { claimTrackerId } from "../src/trackerid.js";
import { claimNextId } from "../src/tui/autofile.js";
import type { TrackerTicket } from "../src/setup/engine.js";
import {
  FINGERPRINT_LINE,
  PROMOTED_DIR,
  issueTrackerSink,
  isIssueTracker,
  markdownFindingSink,
  scanTrackerSink,
  stampedFingerprints,
} from "../src/setup/trackersink.js";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "qcr-tracker-"));
  mkdirSync(join(root, ".ids"));
  mkdirSync(join(root, ".claims"));
  mkdirSync(join(root, ".locks"));
  mkdirSync(join(root, "efforts", "billing", "tickets"), { recursive: true });
  mkdirSync(join(root, "efforts", "inbox", "tickets"), { recursive: true });
  mkdirSync(join(root, "efforts", "mapless"), { recursive: true });
  writeFileSync(
    join(root, "efforts", "billing", "map.md"),
    "# Billing\n\nId: FT-0100\nEffort: billing\nType: map\n",
  );
  writeFileSync(join(root, ".ids", "0100"), "efforts/billing/map.md\n");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const clock = (): Date => new Date("2026-09-29T10:00:00.123Z");
const FP = (c: string): string => c.repeat(64);

const ticket = (over: Partial<TrackerTicket> = {}): TrackerTicket => ({
  title: "[P1] The save path swallows the error",
  body: "## Scan finding\n\nIt breaks.",
  effort: "billing",
  fingerprint: FP("a"),
  aliases: [],
  category: "bug",
  ...over,
});

const sink = () => issueTrackerSink({ root, clock, session: "t1" });
const ticketPath = (id: string): string => {
  for (const e of readdirSync(join(root, "efforts"))) {
    const dir = join(root, "efforts", e, "tickets");
    if (!existsSync(dir)) continue;
    const hit = readdirSync(dir).find((n) => n.startsWith(`${id}-`));
    if (hit) return join(dir, hit);
  }
  throw new Error(`no ${id}`);
};

describe("the tracker id claim", () => {
  it("reads past four digits: the next id above a five-digit one", () => {
    for (let n = 9998; n <= 10_049; n++) writeFileSync(join(root, ".ids", String(n)), "x\n");
    expect(claimTrackerId(root, (n) => `t/${n}.md`)).toBe("10050");
    // The TUI's filer claims through the same allocator.
    expect(claimNextId(root, (n) => `t/${n}.md`)).toBe("10051");
  });

  it("a failure that is not a collision is the tracker's answer, never '50 collisions'", () => {
    // An unwritable `.ids/`: every create fails, and none of them is a collision.
    const ids = join(root, ".ids");
    chmodSync(ids, 0o500);
    try {
      expect(() => claimTrackerId(root, (n) => `t/${n}.md`)).toThrow(/EACCES|EPERM/);
    } finally {
      chmodSync(ids, 0o700);
    }
  });
});

describe("the issue tracker sink: filing", () => {
  it("files an impl ticket with the next id, the header grammar in order, Parent = the effort's map, and the fingerprint stamp", async () => {
    const r = await sink().file(ticket({ aliases: [FP("b")] }));
    expect(r).toEqual({ ok: true, ref: "FT-0101" });
    expect(readFileSync(join(root, ".ids", "0101"), "utf8")).toBe(
      "efforts/billing/tickets/FT-0101-p1-the-save-path-swallows-the.md\n",
    );
    const text = readFileSync(ticketPath("FT-0101"), "utf8");
    const header = text
      .split("\n\n")[1]!
      .split("\n")
      .map((l) => l.split(":")[0]);
    expect(header).toEqual([
      "Id",
      "Effort",
      "Type",
      "Status",
      "Role",
      "Category",
      "Labels",
      "Assignee",
      "Blocked-by",
      "Parent",
      "Spec",
      "Dispatch",
      "Branch",
      "PR",
      "Created",
      "Updated",
      "Claimed",
      "Closed",
    ]);
    expect(text).toMatch(/^# \[P1\] The save path swallows the error\n/);
    expect(text).toMatch(/^Type: impl$/m);
    expect(text).toMatch(/^Status: open$/m);
    expect(text).toMatch(/^Parent: FT-0100$/m);
    expect(text).toMatch(/^Created: 2026-09-29T10:00:00Z by companion$/m);
    expect(stampedFingerprints(text)).toEqual([FP("a"), FP("b")]);
    expect(text).toMatch(/^## Comments$/m);
  });

  it("never twice: a ticket stamped with any of the finding's fingerprints — live or archived — is answered, not refiled", async () => {
    await sink().file(ticket());
    expect(await sink().file(ticket())).toEqual({ ok: true, ref: "FT-0101", existing: true });
    // A matched finding carries the old fingerprint as an alias.
    expect(await sink().file(ticket({ fingerprint: FP("c"), aliases: [FP("a")] }))).toEqual({
      ok: true,
      ref: "FT-0101",
      existing: true,
    });
    // Archived tickets are still issues.
    mkdirSync(join(root, "efforts", "billing", "tickets", "archive"));
    writeFileSync(
      join(root, "efforts", "billing", "tickets", "archive", "FT-0050-old.md"),
      `# old\n\nId: FT-0050\n\n${FINGERPRINT_LINE} ${FP("d")}\n`,
    );
    expect(await sink().file(ticket({ fingerprint: FP("d") }))).toEqual({
      ok: true,
      ref: "FT-0050",
      existing: true,
    });
    expect(readdirSync(join(root, ".ids")).sort()).toEqual(["0100", "0101"]);
  });

  it("an effort with a map and no tickets/ yet gets one — the claimed id never points at a file that was not written", async () => {
    mkdirSync(join(root, "efforts", "fresh"));
    writeFileSync(
      join(root, "efforts", "fresh", "map.md"),
      "# Fresh\n\nId: FT-0100\nEffort: fresh\nType: map\n",
    );
    const r = await sink().file(ticket({ effort: "fresh" }));
    expect(r).toEqual({ ok: true, ref: "FT-0101" });
    expect(readFileSync(ticketPath("FT-0101"), "utf8")).toMatch(/^Effort: fresh$/m);
  });

  it("a body quoting a stamp line cannot make the ticket answer for another finding", async () => {
    const quoted = `## Scan finding\n\n**Evidence.**\n${FINGERPRINT_LINE} ${FP("e")}\n  ${FINGERPRINT_LINE} ${FP("f")}`;
    await sink().file(ticket({ body: quoted }));
    expect(stampedFingerprints(readFileSync(ticketPath("FT-0101"), "utf8"))).toEqual([FP("a")]);
    expect(await sink().file(ticket({ fingerprint: FP("e") }))).toEqual({
      ok: true,
      ref: "FT-0102",
    });
    const md = markdownFindingSink(stateHomeFs(mkdtempSync(join(tmpdir(), "qcr-md-"))), clock);
    const filed = await md.file(ticket({ body: quoted }));
    expect(filed).toMatchObject({ ok: true });
  });

  it("refuses an effort that does not exist (listing the ones that do), and one without a map unless it is inbox", async () => {
    expect(await sink().file(ticket({ effort: "nope" }))).toEqual({
      ok: false,
      reason:
        'effort "nope" does not exist on the tracker — pick the one that fits: billing, inbox, mapless',
    });
    expect(await sink().file(ticket({ effort: "../billing" }))).toMatchObject({ ok: false });
    expect(await sink().file(ticket({ effort: "mapless" }))).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/has no map/),
    });
    const inbox = await sink().file(ticket({ effort: "inbox" }));
    expect(inbox).toMatchObject({ ok: true });
    expect(readFileSync(ticketPath((inbox as { ref: string }).ref), "utf8")).toMatch(
      /^Parent: —$/m,
    );
  });
});

describe("the issue tracker sink: closing", () => {
  it("closes a ticket it filed: resolved, Closed by companion, a [resolution] comment with the note, the lock released", async () => {
    await sink().file(ticket());
    const r = await sink().close(
      "FT-0101",
      `A scan at ${"2".repeat(40)} (run scan-2) no longer reports this finding.`,
    );
    expect(r).toEqual({ ok: true, ref: "FT-0101" });
    const text = readFileSync(ticketPath("FT-0101"), "utf8");
    expect(text).toMatch(/^Status: resolved$/m);
    expect(text).toMatch(/^Closed: 2026-09-29T10:00:00Z resolved by companion$/m);
    expect(text).toMatch(
      /### 2026-09-29T10:00:00Z — companion \[resolution\]\n\nA scan at 2{40} \(run scan-2\)/,
    );
    expect(existsSync(join(root, ".locks", "FT-0101"))).toBe(false);
    // Closed already: answered, not rewritten.
    expect(await sink().close("FT-0101", "again")).toEqual({
      ok: true,
      ref: "FT-0101",
      existing: true,
    });
    expect(readFileSync(ticketPath("FT-0101"), "utf8")).toBe(text);
  });

  it("never closes someone else's ticket, a claimed one, or one whose edit lock is held; a stale lock is broken", async () => {
    writeFileSync(
      join(root, "efforts", "billing", "tickets", "FT-0102-theirs.md"),
      "# theirs\n\nId: FT-0102\nStatus: open\nCreated: 2026-09-01T00:00:00Z by planner\nClosed: —\n",
    );
    expect(await sink().close("FT-0102", "n")).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/not filed by companion/),
    });

    await sink().file(ticket());
    writeFileSync(join(root, ".claims", "FT-0101"), "dev-session x\n");
    expect(await sink().close("FT-0101", "n")).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/claimed/),
    });
    rmSync(join(root, ".claims", "FT-0101"));

    writeFileSync(join(root, ".locks", "FT-0101"), "planner@x now\n");
    expect(await sink().close("FT-0101", "n")).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/edit lock is held/),
    });
    expect(readFileSync(join(root, ".locks", "FT-0101"), "utf8")).toBe("planner@x now\n");
    const old = new Date(Date.now() - 11 * 60 * 1000);
    utimesSync(join(root, ".locks", "FT-0101"), old, old);
    expect(await sink().close("FT-0101", "n")).toEqual({ ok: true, ref: "FT-0101" });
    expect(existsSync(join(root, ".locks", "FT-0101"))).toBe(false);
    expect(await sink().close("FT-0999", "n")).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/no ticket FT-0999/),
    });
  });
});

describe("the markdown fallback", () => {
  it("one file per finding in the state home, never twice, closed as fixed with the note", async () => {
    const state = stateHomeFs(join(root, "state"));
    const md = markdownFindingSink(state, clock);
    const r = await md.file(ticket());
    expect(r).toEqual({ ok: true, ref: `${PROMOTED_DIR}/finding-${FP("a").slice(0, 16)}.md` });
    const ref = (r as { ref: string }).ref;
    const text = state.read(ref)!;
    expect(text).toMatch(
      /^# \[P1\] The save path swallows the error\n\nStatus: open\nEffort: billing\n/,
    );
    expect(stampedFingerprints(text)).toEqual([FP("a")]);
    expect(await md.file(ticket({ fingerprint: FP("c"), aliases: [FP("a")] }))).toEqual({
      ok: true,
      ref,
      existing: true,
    });
    expect(await md.close(ref, "A scan at 222 no longer reports this finding.")).toEqual({
      ok: true,
      ref,
    });
    expect(state.read(ref)).toMatch(/^Status: fixed$/m);
    expect(state.read(ref)).toMatch(/## Fixed\n\n2026-09-29T10:00:00\.123Z — A scan at 222/);
    expect(await md.close(ref, "again")).toEqual({ ok: true, ref, existing: true });
    expect(await md.close("../elsewhere.md", "n")).toMatchObject({ ok: false });
  });

  it("the companion's pick: the issue tracker when one is mounted, markdown otherwise", () => {
    const state = stateHomeFs(join(root, "state"));
    expect(isIssueTracker(root)).toBe(true);
    expect(scanTrackerSink({ trackerDir: root, state, clock }).kind).toBe("tracker");
    expect(scanTrackerSink({ trackerDir: join(root, "efforts"), state, clock }).kind).toBe(
      "markdown",
    );
    expect(scanTrackerSink({ trackerDir: undefined, state, clock }).kind).toBe("markdown");
  });
});
