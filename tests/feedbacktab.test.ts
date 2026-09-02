// `[7] feedback`: the loop on one surface — the inbox and
// its cards, the proposals, the change register and its confirmed revert, the
// filed-ticket summary — and the honest empties of each. The register half
// carries over the tab tests; the inbox half carries over the
// presentation tests.
import { describe, expect, it, vi } from "vitest";
import type { MemoryEntry } from "../src/memory/store.js";
import { decodeKey } from "../src/tui/keys.js";
import { FEEDBACK_FOCUS_ORDER, feedbackEntryLine, feedbackInbox, feedbackKeys, feedbackPresentation } from "../src/tui/feedbacktab.js";
import { displayWidth, stripAnsi } from "../src/tui/paint.js";
import { FakeChanges, FakeMemory, changeEntry, learningRig, settle, type Rig } from "./helpers/tui-rig.js";

const memoryEntry = (text: string, ts = "2026-08-25 08:48:09"): MemoryEntry => ({
  id: `entry-${ts}`,
  ts,
  day: ts.slice(0, 10),
  block: 0,
  text,
  tags: text.split(/\s+/).filter((token) => token.startsWith("#")).map((token) => token.slice(1)),
  links: [],
  pinned: false,
  hash: `hash-${ts}`,
});

const raw = memoryEntry(
  '#feedback kind=feedback pr=5372 day=2026-08-25 signal=feedback_comment human [feedback] by pmercier on PR #5372 (reply to bot comment 3000000101, comment 3000000202): "This edge case is too unlikely to matter in production." — a review comment judged wrong',
);
const adjudication = memoryEntry(
  "#adjudication #feedback pr=5372 episode=comment-3000000202 attribution=review-defect changed=no adjudicated=2026-08-25\nAttribution: review-defect — severity exceeded reachability\nChanged: nothing",
  "2026-08-25 12:00:00",
);
const needsAttention = memoryEntry(
  "#feedback-review #feedback pr=5372 episode=comment-3000000202 status=needs-attention reviewed=2026-08-25\nReason: Exact finding cannot be mapped from the archived evidence; the owner must decide whether rarity makes it non-actionable.",
  "2026-08-25 11:00:00",
);
const actedOn = memoryEntry(
  "#feedback-action #feedback pr=5372 episode=comment-3000000202 action=landed acted=2026-08-25\nResult: commit abc123 adds reachability evidence to the finding record.",
  "2026-08-25 13:00:00",
);

/** A memory store holding exactly these entries. */
function memoryOf(entries: MemoryEntry[]): FakeMemory {
  const mem = new FakeMemory("");
  mem.read = () => Promise.resolve(entries);
  return mem;
}

const screenOf = (rig: Rig, cols = 140, rows = 44): string => stripAnsi(rig.app.hooks.tabs.feedback!.screen(rig.app, cols, rows).render());
const key = (rig: Rig, k: Parameters<NonNullable<typeof rig.app.hooks.tabs.feedback>["key"]>[1]): boolean => rig.app.hooks.tabs.feedback!.key(rig.app, k);
const bar = (rig: Rig): string[] => feedbackKeys(rig.learning.store, rig.learning.feedback, rig.changes).bar.map((b) => b.key);

async function loaded(over: Parameters<typeof learningRig>[0] = {}): Promise<Rig> {
  const rig = learningRig({ mem: memoryOf([raw, adjudication]), ...over });
  rig.app.tab = "feedback";
  rig.app.hooks.tabs.feedback!.screen(rig.app, 140, 44);
  await settle();
  return rig;
}

describe("the signal, as a card", () => {
  it("generates a concrete title, summary, raw text and cautious candidate lesson", () => {
    const card = feedbackPresentation(raw, [raw]);
    expect(card).toMatchObject({
      episode: "comment-3000000202",
      processed: false,
      title: "Narrow edge case judged non-actionable",
      raw: "This edge case is too unlikely to matter in production.",
    });
    expect(card!.summary).toContain("too rare or narrow");
    expect(card!.learning).toContain("reachability and impact separately");
  });

  it("marks only an exact episode as processed and reads the recorded outcome", () => {
    const card = feedbackPresentation(raw, [raw, adjudication]);
    expect(card).toMatchObject({ processed: true, status: "settled" });
    expect(card!.learning).toContain("review-defect — severity exceeded reachability");
    expect(card!.learning).toContain("Changed: nothing");
  });

  it("distinguishes reviewed-but-inconclusive feedback from both unprocessed and settled", () => {
    const card = feedbackPresentation(raw, [raw, needsAttention]);
    expect(card).toMatchObject({ processed: true, status: "needs-attention" });
    expect(card!.learning).toContain("the owner must decide");
  });

  it("the inbox hides disposition records and archives acted-on signals without deleting them", () => {
    expect(feedbackInbox([raw, adjudication, needsAttention])).toEqual([raw]);
    expect(feedbackPresentation(adjudication, [raw, adjudication])).toBeUndefined();
    expect(feedbackPresentation(needsAttention, [raw, needsAttention])).toBeUndefined();
    expect(feedbackPresentation(actedOn, [raw, actedOn])).toBeUndefined();
    expect(feedbackPresentation(raw, [raw, adjudication, actedOn])).toMatchObject({ processed: true, status: "acted-on" });
    expect(feedbackInbox([raw, adjudication, actedOn])).toEqual([]);
    expect(feedbackInbox([raw, adjudication, actedOn], true)).toEqual([raw]);
  });

  it("the list line carries the day, the status mark and the generated title", () => {
    expect(feedbackEntryLine(raw, feedbackPresentation(raw, [raw])!, 80)).toBe("  2026-08-25 ○ #5372 · Narrow edge case judged non-actionable");
    expect(feedbackEntryLine(raw, feedbackPresentation(raw, [raw, needsAttention])!, 80)).toContain("2026-08-25 ! #5372");
  });
});

describe("the surface", () => {
  it("paints the whole loop: inbox, card, proposed, changed, filed and bot PRs", async () => {
    const rig = await loaded({ changes: new FakeChanges([changeEntry("a".repeat(40), "newest change"), changeEntry("b".repeat(40), "older change", { by: "ddddddd", at: "x" })]), readTickets: () => [] });
    rig.learning.store.reloadTickets();
    const screen = screenOf(rig);
    expect(screen).toContain("feedback ── signal ▸ adjudication ▸ proposal ▸ change ▸ revert");
    expect(screen).toContain("INBOX (1)");
    expect(screen).toContain("2026-08-25 ✓ #5372 · Narrow edge case judged n…"); // the 38% list column truncates
    expect(screenOf(rig, 220)).toContain("2026-08-25 ✓ #5372 · Narrow edge case judged non-actionable");
    expect(screen).toContain("PROCESSED · SETTLED");
    expect(screen).toContain("WHAT WE CAN LEARN");
    expect(screen).toContain("PROPOSED (1)");
    expect(screen).toContain("baseline-mergebase-2026-08-20");
    expect(screen).toContain("[A accept]");
    expect(screen).toContain("[x reject]");
    expect(screen).toContain("CHANGED (2)");
    expect(screen.indexOf("newest change")).toBeLessThan(screen.indexOf("older change"));
    expect(screen).toContain("feedback #5270");
    expect(screen).toContain("");
    expect(screen).toContain("reverted by ddddddd");
    expect(screen).toContain("FILED (0 actionable / 0 total)");
    expect(screen).toContain("[4 tickets]");
    expect(screen).toContain("BOT PRs / ISSUES (1)");
    expect(screen).toContain("PR #12 [open]");
    expect(screen).toContain("[7 feedback]");
  });

  it("every empty is one of the three grammars, never a bare count of nothing", async () => {
    const rig = learningRig({
      mem: memoryOf([]),
      changes: new FakeChanges(),
      readTickets: undefined,
      fetchProposals: () => Promise.resolve({ proposals: [], improvements: undefined }),
    });
    // Before anything loaded: every count is unknown.
    let screen = screenOf(rig);
    expect(screen).toContain("INBOX (—)");
    expect(screen).toContain("PROPOSED (—)");
    expect(screen).toContain("CHANGED (—)");
    expect(screen).toContain("FILED (—)");
    expect(screen).toContain("BOT PRs / ISSUES (—)");
    expect(screen).not.toMatch(/\(0\)/);
    await settle();
    screen = screenOf(rig);
    expect(screen).toContain("INBOX (0)");
    expect(screen).toContain("none matching — a shows archived");
    expect(screen).toContain("PROPOSED (0)");
    expect(screen).toContain("none yet — the companion authors proposals");
    expect(screen).toContain("CHANGED (—)"); // the fake register answers undefined: never scanned
    expect(screen).toContain("not read yet — the register is scanned from git log");
    expect(screen).toContain("could not read — no tracker configured");
    expect(screen).toContain("BOT PRs / ISSUES (—)");
    expect(screen).toContain("the gh query was skipped or failed");
  });

  it("an unreachable store says so in the inbox and never renders a count", async () => {
    const dead = memoryOf([]);
    (dead as unknown as { health: () => unknown }).health = () => ({ ok: false, namespaces: [], error: "no answer from 127.0.0.1:1933" });
    const rig = await loaded({ mem: dead });
    const screen = screenOf(rig);
    expect(screen).toContain("MEMORY UNREACHABLE");
    expect(screen).toContain("INBOX (—)");
    expect(screen).not.toContain("INBOX (0)");
  });

  it("renders every line at exactly cols cells", async () => {
    const rig = await loaded({ changes: new FakeChanges([changeEntry("a".repeat(40), "c")]) });
    for (const cols of [100, 141]) {
      for (const line of rig.app.hooks.tabs.feedback!.screen(rig.app, cols, 40).lines) expect(displayWidth(line)).toBe(cols);
    }
  });
});

describe("focus and the state-derived bar", () => {
  it("t cycles inbox → proposed → changed, and A/x/R appear only for the focused pane", async () => {
    const rig = await loaded({ changes: new FakeChanges([changeEntry("a".repeat(40), "c")]) });
    expect(rig.learning.feedback.focus).toBe("inbox");
    expect(bar(rig)).toEqual(["a", "t"]);
    key(rig, { kind: "char", ch: "t" });
    expect(rig.learning.feedback.focus).toBe("proposed");
    expect(bar(rig)).toEqual(["a", "t", "A", "x"]);
    key(rig, { kind: "char", ch: "t" });
    expect(rig.learning.feedback.focus).toBe("changed");
    expect(bar(rig)).toEqual(["a", "t", "R"]);
    key(rig, { kind: "char", ch: "t" });
    expect(rig.learning.feedback.focus).toBe(FEEDBACK_FOCUS_ORDER[0]);
  });

  it("A/x/R off their pane are neither offered nor consumed — the companion gets them", async () => {
    const rig = await loaded({ changes: new FakeChanges([changeEntry("a".repeat(40), "c")]) });
    expect(key(rig, { kind: "char", ch: "A" })).toBe(false);
    expect(key(rig, { kind: "char", ch: "x" })).toBe(false);
    expect(key(rig, { kind: "char", ch: "R" })).toBe(false);
    expect(rig.learning.feedback.armed).toBeUndefined();
  });

  it("a shows the archived signals and says which way the toggle is pointing", async () => {
    const rig = await loaded({ mem: memoryOf([raw, adjudication, actedOn]) });
    expect(screenOf(rig)).toContain("INBOX (0)");
    expect(bar(rig)).toContain("a");
    expect(key(rig, decodeKey(Buffer.from("a")))).toBe(true);
    expect(rig.learning.feedback.showArchived).toBe(true);
    const screen = screenOf(rig);
    expect(screen).toContain("INBOX (1)");
    expect(screen).toContain("ACTED ON · ARCHIVED");
    expect(feedbackKeys(rig.learning.store, rig.learning.feedback, rig.changes).bar.map((b) => b.label)).toContain("a hide archived");
  });
});

describe("proposals", () => {
  it("A accepts and x (with reason) rejects the focused proposal", async () => {
    const accept = vi.fn().mockResolvedValue({ ok: true, message: "accepted" });
    const reject = vi.fn().mockResolvedValue({ ok: true, message: "rejected" });
    const rig = await loaded({ accept, reject });
    key(rig, { kind: "char", ch: "t" }); // focus proposed
    key(rig, { kind: "char", ch: "A" });
    await settle();
    expect(accept).toHaveBeenCalledWith(rig.app, "baseline-mergebase-2026-08-20");
    key(rig, { kind: "char", ch: "x" });
    const send = (s: string): void => (rig.app as unknown as { handleInput(b: Buffer): void }).handleInput(Buffer.from(s));
    send("not evidence-backed");
    send("\r");
    await settle();
    expect(reject).toHaveBeenCalledWith(rig.app, "baseline-mergebase-2026-08-20", "not evidence-backed");
  });

  it("the [A accept] button fires accept on the clicked proposal, focusing its pane", async () => {
    const accept = vi.fn().mockResolvedValue({ ok: true, message: "accepted" });
    const rig = await loaded({ accept });
    const frame = rig.app.hooks.tabs.feedback!.screen(rig.app, 140, 44);
    const zone = frame.zones.find((z) => (z.action as { t: string }).t === "prop-accept")!;
    expect(rig.app.hooks.tabs.feedback!.click!(rig.app, zone.x1, zone.y1)).toBe(true);
    await settle();
    expect(rig.learning.feedback.focus).toBe("proposed");
    expect(accept).toHaveBeenCalledWith(rig.app, "baseline-mergebase-2026-08-20");
  });
});

describe("the revert, armed and confirmed", () => {
  it("R arms and paints exactly what will run; y is what actually reverts", async () => {
    const changes = new FakeChanges([changeEntry("a".repeat(40), "severity change")]);
    const rig = await loaded({ changes });
    key(rig, { kind: "char", ch: "t" });
    key(rig, { kind: "char", ch: "t" }); // focus changed
    expect(key(rig, { kind: "char", ch: "R" })).toBe(true);
    expect(rig.learning.feedback.armed).toBe("a".repeat(40));
    expect(changes.reverted).toEqual([]); // armed is not done
    expect(rig.app.registeredKeys().has("y")).toBe(true); // the confirmation is claimed only while armed
    const screen = screenOf(rig);
    expect(screen).toContain("git revert --no-edit aaaaaaa");
    expect(screen).toContain("no push, no GitHub");
    expect(screen).toContain("y do it");
    key(rig, decodeKey(Buffer.from("y")));
    await settle();
    expect(changes.reverted).toEqual(["a".repeat(40)]);
    expect(rig.learning.feedback.armed).toBeUndefined();
    expect(rig.app.registeredKeys().has("y")).toBe(false);
  });

  it("any other key cancels an armed revert, and runs nothing", async () => {
    const changes = new FakeChanges([changeEntry("a".repeat(40), "severity change")]);
    const rig = await loaded({ changes });
    key(rig, { kind: "char", ch: "t" });
    key(rig, { kind: "char", ch: "t" });
    key(rig, { kind: "char", ch: "R" });
    expect(key(rig, { kind: "char", ch: "n" })).toBe(true);
    expect(rig.learning.feedback.armed).toBeUndefined();
    expect(rig.learning.feedback.result).toContain("revert cancelled");
    await settle();
    expect(changes.reverted).toEqual([]);
  });

  it("R on an already-reverted change refuses with the reverter's name", async () => {
    const changes = new FakeChanges([changeEntry("a".repeat(40), "c", { by: "ddddddd", at: "x" })]);
    const rig = await loaded({ changes });
    key(rig, { kind: "char", ch: "t" });
    key(rig, { kind: "char", ch: "t" });
    key(rig, { kind: "char", ch: "R" });
    expect(rig.learning.feedback.armed).toBeUndefined();
    expect(stripAnsi(rig.learning.feedback.result ?? "")).toContain("already reverted by ddddddd");
  });

  it("clicking a change row focuses the register and disarms", async () => {
    const changes = new FakeChanges([changeEntry("a".repeat(40), "one"), changeEntry("b".repeat(40), "two")]);
    const rig = await loaded({ changes });
    const frame = rig.app.hooks.tabs.feedback!.screen(rig.app, 140, 44);
    const row = frame.zones.find((z) => (z.action as { t: string; i: number }).t === "change" && (z.action as { i: number }).i === 1)!;
    rig.app.hooks.tabs.feedback!.click!(rig.app, row.x1, row.y1);
    expect(rig.learning.feedback.focus).toBe("changed");
    expect(rig.learning.feedback.changeSel).toBe(1);
  });

  it("the register is scanned once behind the first paint, and again on r", async () => {
    const changes = new FakeChanges([]);
    const rig = await loaded({ changes });
    expect(changes.refreshes).toBe(1);
    rig.app.hooks.tabs.feedback!.screen(rig.app, 140, 44);
    expect(changes.refreshes).toBe(1);
    key(rig, { kind: "refresh" });
    expect(changes.refreshes).toBe(2);
  });

  // "none yet" is a CLAIM, made only when a scan succeeded and found
  // none. The two ways of not knowing each get their own sentence, and neither
  // hides the rows already in memory. The loader arming once per run (above)
  // is the other half: measured at 502 `git log` spawns in 200 ms when it
  // re-armed on "still no register" against an unreadable file.
  it("an unreadable register or a failed scan is SAID, never painted as 'none yet' or 'not read yet'", async () => {
    const unreadable = screenOf(await loaded({ changes: new FakeChanges(undefined, { kind: "register_unreadable", reason: "EACCES" }) }));
    expect(unreadable).toContain("change register unreadable");
    expect(unreadable).toContain("EACCES");
    expect(unreadable).not.toContain("not read yet — the register");
    expect(unreadable).not.toContain("a change joins this list");

    const failed = screenOf(await loaded({ changes: new FakeChanges(undefined, { kind: "scan_failed", reason: "fatal: not a git repository" }) }));
    expect(failed).toContain("git log failed");
    expect(failed).toContain("not a git repository");
    expect(failed).toContain("CHANGED (—)");
    expect(failed).not.toContain("not read yet — the register");
    expect(failed).not.toContain("a change joins this list");

    // Rows already known stay on screen under the caveat.
    const withRows = screenOf(await loaded({ changes: new FakeChanges([changeEntry("a".repeat(40), "newest change")], { kind: "register_unreadable", reason: "EIO" }) }));
    expect(withRows).toContain("change register unreadable");
    expect(withRows).toContain("newest change");
    const behind = screenOf(await loaded({ changes: new FakeChanges([changeEntry("a".repeat(40), "newest change")], { kind: "scan_failed", reason: "x" }) }));
    expect(behind).toContain("last git log scan failed");
    expect(behind).toContain("CHANGED (1)");
    expect(behind).toContain("newest change");
  });

  it("the loader does not re-arm on an unreadable register — six paints, one scan; r is the way back in", async () => {
    const changes = new FakeChanges(undefined, { kind: "register_unreadable", reason: "EACCES" });
    const rig = await loaded({ changes });
    for (let i = 0; i < 5; i++) {
      rig.app.hooks.tabs.feedback!.screen(rig.app, 140, 44);
      await settle();
    }
    expect(changes.refreshes).toBe(1);
    changes.problem = undefined;
    changes.register = { version: 1, updated_at: "2026-08-25T10:00:00Z", entries: [], scanned: 0 };
    key(rig, { kind: "refresh" });
    await settle();
    expect(changes.refreshes).toBe(2);
    expect(screenOf(rig)).toContain("a change joins this list");
  });
});

describe("the loop points at the tickets surface", () => {
  it("[4 tickets] is a button that opens the tickets tab", async () => {
    const rig = await loaded({ readTickets: () => [] });
    rig.learning.store.reloadTickets();
    const running = rig.app.run();
    const frame = rig.app.hooks.tabs.feedback!.screen(rig.app, 140, 44);
    const zone = frame.zones.find((z) => (z.action as { t: string; key?: string }).t === "key" && (z.action as { key: string }).key === "4")!;
    expect(zone).toBeDefined();
    rig.app.hooks.tabs.feedback!.click!(rig.app, zone.x1, zone.y1);
    expect(rig.app.tab).toBe("tickets");
    rig.app.quit();
    await running;
  });
});
