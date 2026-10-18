// Scan triage and scan memory (setup & scan spec "Findings" and
// "Scan memory", seam 3) driven the engine way: an in-memory MemoryStore, a
// FAKE tracker sink recording what it was asked, the findings store over a
// temp state home through the real rooted state port — and, end to end, a
// ScanRunner whose re-scan fixes a promoted finding and closes its ticket.
// What is asserted is what triage WRITES and RETURNS: the memory note and its
// header, the ticket filed once, the close with the scan's sha, the caps.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SCAN_DEFAULTS } from "../src/config.js";
import { parseEventTags, parseHashTags } from "../src/memory/eventtags.js";
import {
  matchesQuery,
  type MemoryEntry,
  type MemoryOp,
  type MemoryStore,
  type MemoryWriteResult,
} from "../src/memory/store.js";
import { stateHomeFs } from "../src/setup/adapters.js";
import type { SinkResult, TrackerSink, TrackerTicket } from "../src/setup/engine.js";
import {
  FINDINGS_FILE,
  FindingsStore,
  type FindingsFile,
  type ReportedFinding,
  type ScanFinding,
} from "../src/setup/findings.js";
import { ScanRunner } from "../src/setup/scanrun.js";
import { markdownFindingSink } from "../src/setup/trackersink.js";
import {
  MAX_PATTERNS_PER_SCAN,
  SCAN_MEMORY_FILE,
  ScanTriage,
  type ScanRunRef,
} from "../src/setup/triage.js";
import { scanRuns } from "../extensions/setup-scan.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "qcr-triage-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

class MemFake implements MemoryStore {
  entries: MemoryEntry[] = [];
  ops: MemoryOp[] = [];
  refuse: string | null = null;
  private n = 0;
  async read(): Promise<MemoryEntry[]> {
    return [...this.entries];
  }
  async search(q: string, opts?: { tag?: string | null }): Promise<MemoryEntry[]> {
    return this.entries.filter((e) => matchesQuery(e, q, opts));
  }
  async apply(op: MemoryOp): Promise<MemoryWriteResult> {
    this.ops.push(op);
    if (this.refuse !== null) return { ok: false, message: this.refuse };
    if (op.op !== "note") return { ok: false, message: "unsupported" };
    this.n++;
    this.entries.push({
      id: `e${this.n}`,
      ts: "2026-09-29 12:00:00",
      day: "2026-09-29",
      block: 0,
      text: op.text,
      tags: parseHashTags(op.text),
      links: [],
      pinned: false,
      hash: `h${this.n}`,
    });
    return { ok: true, message: "ok: note" };
  }
}

class FakeSink implements TrackerSink {
  readonly kind = "tracker";
  filed: TrackerTicket[] = [];
  closes: Array<{ ref: string; note: string }> = [];
  refuseClose: string | null = null;
  refuseFile: string | null = null;
  async file(t: TrackerTicket): Promise<SinkResult> {
    if (this.refuseFile) return { ok: false, reason: this.refuseFile };
    this.filed.push(t);
    return { ok: true, ref: `FT-${9000 + this.filed.length}` };
  }
  async close(ref: string, note: string): Promise<SinkResult> {
    if (this.refuseClose) return { ok: false, reason: this.refuseClose };
    this.closes.push({ ref, note });
    return { ok: true, ref };
  }
}

const FP = (c: string): string => c.repeat(64);
const SHA1 = "1".repeat(40);
const SHA2 = "2".repeat(40);

function reported(fp: string, over: Partial<ReportedFinding> = {}): ReportedFinding {
  return {
    fingerprint: fp,
    unit: "app",
    path: "app/models.py",
    blob: "blob1",
    start: 2,
    end: 3,
    lens: "pass-scan",
    kind: "bug",
    severity: "P1",
    confidence: 0.8,
    claim: "the save path swallows the integrity error and returns success",
    evidence: "except IntegrityError: pass",
    fix: "re-raise",
    detail: null,
    validated: true,
    doubt: null,
    validity: "confirmed",
    scenario: "a save with a duplicate key reaches the swallowed IntegrityError",
    ...over,
  };
}

let tick = 0;
const clock = (): Date => new Date(Date.parse("2026-09-29T10:00:00Z") + 1000 * tick++);

function setup(
  opts: {
    memory?: MemFake | null;
    sink?: TrackerSink;
    runs?: ScanRunRef[];
    units?: string[] | null;
  } = {},
) {
  const state = stateHomeFs(join(dir, "state"));
  const findings = new FindingsStore(state);
  const memory = opts.memory === undefined ? new MemFake() : opts.memory;
  const sink = opts.sink ?? new FakeSink();
  const triage = new ScanTriage({
    findings,
    state,
    memory,
    tracker: sink,
    clock,
    units: () => (opts.units === undefined ? ["app", "lib"] : opts.units),
    runs: () =>
      opts.runs ?? [
        { id: "scan-2", sha: SHA2, state: "complete" },
        { id: "scan-1", sha: SHA1, state: "complete" },
      ],
  });
  return { state, findings, memory, sink, triage };
}

const one = (s: FindingsStore, fp: string): ScanFinding =>
  s.load().findings.find((f) => f.fingerprint === fp)!;

describe("dismissal writes an unpinned memory note", () => {
  it("dismisses with the reason and writes a #scan kind=dismissal note the header of which the engine owns", async () => {
    const { findings, memory, triage } = setup();
    findings.report([reported(FP("a"), { claim: "a #pinned claim about models" })], {
      run: "scan-1",
      sha: SHA1,
      at: "t",
    });
    const r = await triage.dismiss({
      fingerprint: FP("a").slice(0, 12),
      reason: "Intentional: #retired  the caller retries",
    });
    expect(r).toMatchObject({ ok: true, memory: "written", again: false });
    expect(one(findings, FP("a"))).toMatchObject({
      state: "dismissed",
      dismissal: { reason: "Intentional: #retired the caller retries", memory: "written" },
    });
    expect(memory!.entries).toHaveLength(1);
    const e = memory!.entries[0]!;
    expect(e.pinned).toBe(false);
    expect(parseHashTags(e.text)).toEqual(["scan"]);
    expect(parseEventTags(e.text)).toEqual({
      kind: "dismissal",
      lens: "pass-scan",
      finding: "bug",
      unit: "app",
    });
    // The model's and the operator's words are de-hashed: they cannot mint a tag or a pin.
    expect(e.text).not.toMatch(/#pinned|#retired/);
    expect(e.text).toMatch(/app\/models\.py:2-3/);
    expect(e.text).toMatch(/Reason: Intentional: retired the caller retries$/);
  });

  it("a dismissed finding stays dismissed when a re-scan reports it again", async () => {
    const { findings, triage } = setup();
    findings.report([reported(FP("a"))], { run: "scan-1", sha: SHA1, at: "t1" });
    await triage.dismiss({ fingerprint: FP("a"), reason: "by design" });
    findings.report([reported(FP("a"))], { run: "scan-2", sha: SHA2, at: "t2" });
    expect(one(findings, FP("a"))).toMatchObject({
      state: "dismissed",
      seen: 2,
      dismissal: { reason: "by design" },
    });
  });

  it("memory that refuses: the dismissal holds, the failure is recorded, and dismissing again retries the note", async () => {
    const memory = new MemFake();
    memory.refuse = "server down";
    const { findings, triage } = setup({ memory });
    findings.report([reported(FP("a"))], { run: "scan-1", sha: SHA1, at: "t" });
    const r = await triage.dismiss({ fingerprint: FP("a"), reason: "by design" });
    expect(r).toMatchObject({ ok: true, memory: { problem: "server down" } });
    expect(one(findings, FP("a"))).toMatchObject({
      state: "dismissed",
      dismissal: { memory: { problem: "server down" } },
    });
    memory.refuse = null;
    expect(await triage.dismiss({ fingerprint: FP("a"), reason: "by design" })).toMatchObject({
      ok: true,
      memory: "written",
      again: true,
    });
    expect(memory.entries).toHaveLength(1);
    // A repeat with the same reason once written writes nothing more.
    await triage.dismiss({ fingerprint: FP("a"), reason: "by design" });
    expect(memory.entries).toHaveLength(1);
  });

  it("no memory in the assembly: dismissed, and the note's absence said", async () => {
    const { findings, triage } = setup({ memory: null });
    findings.report([reported(FP("a"))], { run: "scan-1", sha: SHA1, at: "t" });
    expect(await triage.dismiss({ fingerprint: FP("a"), reason: "x" })).toMatchObject({
      ok: true,
      memory: { problem: expect.stringMatching(/no reviewer memory/) },
    });
  });

  it("refuses without a reason, an unknown or ambiguous fingerprint, a promoted and a fixed finding", async () => {
    const { findings, triage } = setup();
    // Three different defects (identical claims would collapse into one finding).
    findings.report(
      [
        reported(FP("a")),
        reported(`${"b".repeat(12)}${"0".repeat(52)}`, {
          claim: "the refund total is rounded twice",
        }),
        reported(`${"b".repeat(12)}${"1".repeat(52)}`, {
          claim: "a cancelled order keeps its stock reservation",
        }),
      ],
      {
        run: "scan-1",
        sha: SHA1,
        at: "t",
      },
    );
    expect(await triage.dismiss({ fingerprint: FP("a"), reason: "  " })).toMatchObject({
      ok: false,
      errors: [expect.stringMatching(/reason/)],
    });
    expect(await triage.dismiss({ fingerprint: FP("c"), reason: "x" })).toMatchObject({
      ok: false,
      errors: [expect.stringMatching(/no stored finding/)],
    });
    expect(await triage.dismiss({ fingerprint: "b".repeat(12), reason: "x" })).toMatchObject({
      ok: false,
      errors: [expect.stringMatching(/matches 2 findings/)],
    });
    await triage.promote({ fingerprint: FP("a"), effort: "e" });
    expect(await triage.dismiss({ fingerprint: FP("a"), reason: "x" })).toMatchObject({
      ok: false,
      errors: [expect.stringMatching(/promoted \(FT-9001\)/)],
    });
  });
});

describe("promotion files one ticket, never twice", () => {
  it("files the ticket rendered from the finding, stamped with its fingerprint, in the companion's effort", async () => {
    const { findings, sink, triage } = setup();
    findings.report([reported(FP("a"))], { run: "scan-1", sha: SHA1, at: "t" });
    const r = await triage.promote({
      fingerprint: FP("a"),
      effort: "billing",
      note: "Seen in the refund flow too.",
    });
    expect(r).toMatchObject({ ok: true, ref: "FT-9001", sink: "tracker", existing: false });
    const s = sink as FakeSink;
    expect(s.filed).toHaveLength(1);
    const t = s.filed[0]!;
    expect(t).toMatchObject({ effort: "billing", fingerprint: FP("a"), category: "bug" });
    expect(t.title).toBe("[P1] the save path swallows the integrity error and returns success");
    expect(t.body).toMatch(/`app\/models\.py:2-3`/);
    expect(t.body).toMatch(/\*\*Evidence\.\*\* except IntegrityError: pass/);
    expect(t.body).toMatch(/## Companion's note\n\nSeen in the refund flow too\./);
    expect(one(findings, FP("a"))).toMatchObject({
      state: "promoted",
      ticket: { sink: "tracker", ref: "FT-9001", effort: "billing", closed: null },
    });
  });

  it("a second promote — and one after a dismissal in between — goes back onto the same ticket", async () => {
    const { findings, sink, triage } = setup();
    findings.report([reported(FP("a"))], { run: "scan-1", sha: SHA1, at: "t" });
    await triage.promote({ fingerprint: FP("a"), effort: "billing" });
    expect(await triage.promote({ fingerprint: FP("a"), effort: "other" })).toMatchObject({
      ok: true,
      ref: "FT-9001",
      existing: true,
    });
    expect((sink as FakeSink).filed).toHaveLength(1);
  });

  it("a dismissed finding may be promoted; a fixed one may not; a refused filing leaves it as it was", async () => {
    const sink = new FakeSink();
    const { findings, triage } = setup({ sink });
    findings.report([reported(FP("a")), reported(FP("b"), { path: "lib/x.py", unit: "lib" })], {
      run: "scan-1",
      sha: SHA1,
      at: "t",
    });
    await triage.dismiss({ fingerprint: FP("a"), reason: "hm" });
    expect(await triage.promote({ fingerprint: FP("a"), effort: "e" })).toMatchObject({ ok: true });
    expect(one(findings, FP("a"))).toMatchObject({
      state: "promoted",
      dismissal: { reason: "hm" },
    });

    sink.refuseFile = 'effort "nope" does not exist on the tracker';
    expect(await triage.promote({ fingerprint: FP("b"), effort: "nope" })).toMatchObject({
      ok: false,
      errors: [expect.stringMatching(/does not exist/)],
    });
    expect(one(findings, FP("b"))).toMatchObject({ state: "new" });
    expect(one(findings, FP("b")).ticket ?? null).toBeNull();

    findings.reconcile({
      rows: [],
      tree: new Set(["app/models.py"]),
      run: { run: "scan-2", sha: SHA2, at: "t2" },
    });
    expect(one(findings, FP("b")).state).toBe("fixed");
    expect(await triage.promote({ fingerprint: FP("b"), effort: "e" })).toMatchObject({
      ok: false,
      errors: [expect.stringMatching(/fixed/)],
    });
    expect(await triage.promote({ fingerprint: FP("a") })).toMatchObject({
      ok: true,
      existing: true,
    });
  });

  it("a dismissal a re-scan no longer reports is not promoted; a re-sighting puts it back in play", async () => {
    const sink = new FakeSink();
    const { findings, triage } = setup({ sink });
    findings.report([reported(FP("a"))], { run: "scan-1", sha: SHA1, at: "t" });
    await triage.dismiss({ fingerprint: FP("a"), reason: "by design" });
    findings.reconcile({ rows: [], tree: new Set(), run: { run: "scan-2", sha: SHA2, at: "t2" } });
    expect(one(findings, FP("a"))).toMatchObject({ state: "dismissed", unreported: { sha: SHA2 } });
    expect(await triage.promote({ fingerprint: FP("a"), effort: "e" })).toMatchObject({
      ok: false,
      errors: [expect.stringMatching(/no longer reported/)],
    });
    expect(sink.filed).toHaveLength(0);
    expect(one(findings, FP("a")).state).toBe("dismissed");
    findings.report([reported(FP("a"))], { run: "scan-3", sha: "3".repeat(40), at: "t3" });
    expect(await triage.promote({ fingerprint: FP("a"), effort: "e" })).toMatchObject({
      ok: true,
      ref: "FT-9001",
    });
  });

  it("a finding the companion matched to a moved sighting keeps its ticket: promoting the new one files nothing", async () => {
    const { state, findings, sink, triage } = setup();
    findings.report([reported(FP("a"))], { run: "scan-1", sha: SHA1, at: "t1" });
    await triage.promote({ fingerprint: FP("a"), effort: "billing" });
    findings.report([reported(FP("d"), { start: 9, end: 10 })], {
      run: "scan-2",
      sha: SHA2,
      at: "t2",
    });
    // The pending question the re-scan's reconcile would leave.
    const file = JSON.parse(state.read(FINDINGS_FILE)!) as FindingsFile;
    file.question = {
      key: "k1",
      run: "scan-2",
      sha: SHA2,
      at: "t2",
      unreported: [FP("a")],
      fresh: [FP("d")],
    };
    writeFileSync(join(dir, "state", FINDINGS_FILE), JSON.stringify(file));
    expect(findings.match({ key: "k1", pairs: [{ old: FP("a"), new: FP("d") }] })).toMatchObject({
      ok: true,
      matched: 1,
    });
    expect(one(findings, FP("d"))).toMatchObject({
      state: "promoted",
      ticket: { ref: "FT-9001" },
      aliases: [FP("a")],
    });
    expect(await triage.promote({ fingerprint: FP("a"), effort: "billing" })).toMatchObject({
      ok: true,
      ref: "FT-9001",
      existing: true,
    });
    expect((sink as FakeSink).filed).toHaveLength(1);
  });
});

describe("a match never drops a ticket the fresh side already carries (selfscan 94faac13)", () => {
  const ask = (state: ReturnType<typeof setup>["state"], old: string, fresh: string): void => {
    const file = JSON.parse(state.read(FINDINGS_FILE)!) as FindingsFile;
    file.question = {
      key: "k1",
      run: "scan-2",
      sha: SHA2,
      at: "t2",
      unreported: [old],
      fresh: [fresh],
    };
    writeFileSync(join(dir, "state", FINDINGS_FILE), JSON.stringify(file));
  };

  it("a fresh finding promoted while the question waits keeps its ticket and state when paired with an unticketed old one", async () => {
    const { state, findings, sink, triage } = setup();
    findings.report([reported(FP("a"))], { run: "scan-1", sha: SHA1, at: "t1" });
    findings.report([reported(FP("d"), { start: 9, end: 10 })], {
      run: "scan-2",
      sha: SHA2,
      at: "t2",
    });
    ask(state, FP("a"), FP("d"));
    await triage.promote({ fingerprint: FP("d"), effort: "billing" });
    expect(findings.match({ key: "k1", pairs: [{ old: FP("a"), new: FP("d") }] })).toMatchObject({
      ok: true,
      matched: 1,
    });
    expect(one(findings, FP("d"))).toMatchObject({
      state: "promoted",
      ticket: { ref: "FT-9001" },
      aliases: [FP("a")],
    });
    expect((sink as FakeSink).filed).toHaveLength(1);
  });

  it("a fresh finding dismissed while the question waits keeps its dismissal when paired with an untriaged old one", async () => {
    const { state, findings, triage } = setup();
    findings.report([reported(FP("a"))], { run: "scan-1", sha: SHA1, at: "t1" });
    findings.report([reported(FP("d"), { start: 9, end: 10 })], {
      run: "scan-2",
      sha: SHA2,
      at: "t2",
    });
    ask(state, FP("a"), FP("d"));
    expect(await triage.dismiss({ fingerprint: FP("d"), reason: "intended" })).toMatchObject({
      ok: true,
    });
    expect(findings.match({ key: "k1", pairs: [{ old: FP("a"), new: FP("d") }] })).toMatchObject({
      ok: true,
      matched: 1,
    });
    expect(one(findings, FP("d"))).toMatchObject({
      state: "dismissed",
      dismissal: { reason: "intended" },
      ticket: null,
    });
  });

  it("a pair whose both sides carry different tickets is refused, never silently dropping one", async () => {
    const { state, findings, sink, triage } = setup();
    findings.report([reported(FP("a"))], { run: "scan-1", sha: SHA1, at: "t1" });
    await triage.promote({ fingerprint: FP("a"), effort: "billing" });
    findings.report([reported(FP("d"), { start: 9, end: 10 })], {
      run: "scan-2",
      sha: SHA2,
      at: "t2",
    });
    ask(state, FP("a"), FP("d"));
    await triage.promote({ fingerprint: FP("d"), effort: "billing" });
    expect((sink as FakeSink).filed).toHaveLength(2);
    expect(findings.match({ key: "k1", pairs: [{ old: FP("a"), new: FP("d") }] })).toMatchObject({
      ok: false,
      errors: [expect.stringMatching(/FT-9001.*FT-9002.*unpaired/)],
    });
    expect(one(findings, FP("a"))).toMatchObject({ ticket: { ref: "FT-9001" } });
    expect(one(findings, FP("d"))).toMatchObject({ ticket: { ref: "FT-9002" } });
  });
});

describe("a fixed finding's ticket closes with the scan sha", () => {
  it("closes it once, with the sha and run in the note; a second pass closes nothing", async () => {
    const { findings, sink, triage } = setup();
    findings.report([reported(FP("a"))], { run: "scan-1", sha: SHA1, at: "t1" });
    await triage.promote({ fingerprint: FP("a"), effort: "billing" });
    findings.reconcile({ rows: [], tree: new Set(), run: { run: "scan-2", sha: SHA2, at: "t2" } });
    const r = await triage.closeFixed();
    expect(r).toEqual({
      closed: [{ fingerprint: FP("a"), ref: "FT-9001", sha: SHA2 }],
      problems: [],
    });
    const s = sink as FakeSink;
    expect(s.closes).toHaveLength(1);
    expect(s.closes[0]!.note).toMatch(
      new RegExp(`A scan at ${SHA2} \\(run scan-2\\) no longer reports this finding`),
    );
    expect(one(findings, FP("a")).ticket).toMatchObject({ closed: { sha: SHA2, run: "scan-2" } });
    expect(await triage.closeFixed()).toEqual({ closed: [], problems: [] });
    expect(s.closes).toHaveLength(1);
  });

  it("a refused close stays pending and the next attempt closes it; a new or dismissed fixed finding has no ticket to close", async () => {
    const sink = new FakeSink();
    const { findings, triage } = setup({ sink });
    findings.report([reported(FP("a")), reported(FP("b"), { path: "lib/x.py", unit: "lib" })], {
      run: "scan-1",
      sha: SHA1,
      at: "t1",
    });
    await triage.promote({ fingerprint: FP("a"), effort: "billing" });
    await triage.dismiss({ fingerprint: FP("b"), reason: "no" });
    findings.reconcile({ rows: [], tree: new Set(), run: { run: "scan-2", sha: SHA2, at: "t2" } });
    sink.refuseClose = "FT-9001 is claimed — someone is working on it";
    expect(await triage.closeFixed()).toEqual({
      closed: [],
      problems: ["FT-9001: FT-9001 is claimed — someone is working on it"],
    });
    sink.refuseClose = null;
    expect((await triage.closeFixed()).closed).toHaveLength(1);
    expect(sink.closes.map((c) => c.ref)).toEqual(["FT-9001"]);
  });

  it("a findings store unreadable at a re-check is reported, never read as nothing to close", async () => {
    const sink = new FakeSink();
    const { findings, triage } = setup({ sink });
    findings.report([reported(FP("a")), reported(FP("b"), { path: "app/y.py" })], {
      run: "scan-1",
      sha: SHA1,
      at: "t1",
    });
    await triage.promote({ fingerprint: FP("a"), effort: "billing" });
    await triage.promote({ fingerprint: FP("b"), effort: "billing" });
    findings.reconcile({ rows: [], tree: new Set(), run: { run: "scan-2", sha: SHA2, at: "t2" } });
    const close = sink.close.bind(sink);
    sink.close = async (ref, note) => {
      const r = await close(ref, note);
      findings.load = () => ({ findings: [], error: "findings.json: unreadable" });
      return r;
    };
    const r = await triage.closeFixed();
    expect(r.closed.map((c) => c.ref)).toEqual(["FT-9001"]);
    expect(r.problems).toContainEqual(
      expect.stringMatching(/^FT-9002 not closed: the findings store could not be re-read/),
    );
  });

  it("a promoted finding reported again before its ticket closed stays promoted; after the close it is new, on the same ticket", async () => {
    const { findings, sink, triage } = setup();
    findings.report([reported(FP("a"))], { run: "scan-1", sha: SHA1, at: "t1" });
    await triage.promote({ fingerprint: FP("a"), effort: "billing" });
    findings.reconcile({ rows: [], tree: new Set(), run: { run: "scan-2", sha: SHA2, at: "t2" } });
    findings.report([reported(FP("a"))], { run: "scan-3", sha: SHA1, at: "t3" });
    expect(one(findings, FP("a")).state).toBe("promoted");
    expect(await triage.closeFixed()).toEqual({ closed: [], problems: [] });

    findings.reconcile({ rows: [], tree: new Set(), run: { run: "scan-4", sha: SHA2, at: "t4" } });
    await triage.closeFixed();
    findings.report([reported(FP("a"))], { run: "scan-5", sha: SHA1, at: "t5" });
    expect(one(findings, FP("a"))).toMatchObject({
      state: "new",
      ticket: { ref: "FT-9001", closed: { sha: SHA2 } },
    });
    const again = await triage.promote({ fingerprint: FP("a"), effort: "billing" });
    expect(again).toMatchObject({
      ok: true,
      ref: "FT-9001",
      existing: true,
      closed: { sha: SHA2 },
    });
    expect((sink as FakeSink).filed).toHaveLength(1);
  });

  it("a re-promotion after a closed ticket reopens its record: the next fix closes it again (selfscan d5ade550)", async () => {
    const { findings, sink, triage } = setup();
    findings.report([reported(FP("a"))], { run: "scan-1", sha: SHA1, at: "t1" });
    await triage.promote({ fingerprint: FP("a"), effort: "billing" });
    findings.reconcile({ rows: [], tree: new Set(), run: { run: "scan-2", sha: SHA2, at: "t2" } });
    await triage.closeFixed();
    findings.report([reported(FP("a"))], { run: "scan-3", sha: SHA1, at: "t3" });
    // The operator re-promotes (and reopens the ticket by hand).
    await triage.promote({ fingerprint: FP("a"), effort: "billing" });
    expect(one(findings, FP("a"))).toMatchObject({
      state: "promoted",
      ticket: { ref: "FT-9001", closed: null },
    });
    findings.reconcile({ rows: [], tree: new Set(), run: { run: "scan-4", sha: SHA2, at: "t4" } });
    expect((await triage.closeFixed()).closed).toEqual([
      { fingerprint: FP("a"), ref: "FT-9001", sha: SHA2 },
    ]);
    expect((sink as FakeSink).closes).toHaveLength(2);
  });

  it("a finding reported again while an earlier ticket's close is awaited is never closed on the stale snapshot (selfscan 43b64cf3)", async () => {
    const sink = new (class extends FakeSink {
      onClose: (() => void) | null = null;
      override async close(ref: string, note: string): Promise<SinkResult> {
        const hook = this.onClose;
        this.onClose = null;
        hook?.();
        return super.close(ref, note);
      }
    })();
    const { findings, triage: t } = setup({ sink });
    const b = reported(FP("b"), { path: "lib/x.py", unit: "lib" });
    findings.report([reported(FP("a")), b], { run: "scan-1", sha: SHA1, at: "t1" });
    await t.promote({ fingerprint: FP("a"), effort: "billing" });
    await t.promote({ fingerprint: FP("b"), effort: "billing" });
    findings.reconcile({ rows: [], tree: new Set(), run: { run: "scan-2", sha: SHA2, at: "t2" } });
    // While a's close is awaited, a background scan reports b again.
    sink.onClose = () => void findings.report([b], { run: "scan-3", sha: SHA1, at: "t3" });
    const r = await t.closeFixed();
    expect(r.closed.map((c) => c.fingerprint)).toEqual([FP("a")]);
    expect(sink.closes.map((c) => c.ref)).toEqual(["FT-9001"]);
    expect(one(findings, FP("b"))).toMatchObject({
      state: "promoted",
      ticket: { ref: "FT-9002", closed: null },
    });
  });

  it("a ticket filed on a sink this companion lacks is reported, never closed elsewhere", async () => {
    const { findings, triage } = setup({
      sink: markdownFindingSink(stateHomeFs(join(dir, "state")), clock),
    });
    findings.report([reported(FP("a"))], { run: "scan-1", sha: SHA1, at: "t1" });
    findings.update(FP("a"), (f) => ({
      ...f,
      state: "promoted",
      ticket: { sink: "tracker", ref: "FT-0042", effort: "e", filed_at: "t" },
    }));
    findings.reconcile({ rows: [], tree: new Set(), run: { run: "scan-2", sha: SHA2, at: "t2" } });
    expect(await triage.closeFixed()).toEqual({
      closed: [],
      problems: [expect.stringMatching(/FT-0042 was filed on the tracker sink/)],
    });
  });
});

describe("#scan memory: patterns and hotspots, capped per scan; findings never", () => {
  const pattern = (i: number) => ({
    text: `raw SQL assembled by string formatting, variant ${i}`,
    occurrences: 3,
  });

  it("writes unpinned #scan pattern and hotspot entries with engine-owned headers, for the latest finished run by default", async () => {
    const { memory, triage, state } = setup();
    const r = await triage.writeMemory({
      patterns: [{ text: "Views catch #pinned broad exceptions and return 200", occurrences: 4 }],
      hotspots: [{ unit: "app", text: "the order state machine: most bug findings cluster there" }],
    });
    expect(r).toMatchObject({
      ok: true,
      sha: SHA2,
      run: "scan-2",
      written: { patterns: 1, hotspots: 1 },
      problems: [],
      left: { patterns: MAX_PATTERNS_PER_SCAN - 1, units_without_hotspot: ["lib"] },
    });
    const [p, h] = memory!.entries;
    expect(parseHashTags(p!.text)).toEqual(["scan"]);
    expect(parseEventTags(p!.text)).toEqual({
      kind: "pattern",
      occurrences: "4",
      sha: SHA2.slice(0, 12),
    });
    expect(p!.text).not.toMatch(/#pinned/);
    expect(parseEventTags(h!.text)).toEqual({
      kind: "hotspot",
      unit: "app",
      sha: SHA2.slice(0, 12),
    });
    expect(memory!.entries.every((e) => !e.pinned)).toBe(true);
    // Appended: nothing retired.
    expect(memory!.ops.every((o) => o.op === "note")).toBe(true);
    expect(JSON.parse(state.read(SCAN_MEMORY_FILE)!).scans[SHA2].patterns).toHaveLength(1);
  });

  it("a unit named like an object member gets its hotspot like any other", async () => {
    const { triage } = setup({ units: ["constructor", "toString"] });
    expect(
      await triage.writeMemory({
        hotspots: [{ unit: "constructor", text: "the scheduler: every lens found something here" }],
      }),
    ).toMatchObject({
      ok: true,
      written: { hotspots: 1 },
      left: { units_without_hotspot: ["toString"] },
    });
  });

  it("each note memory took is counted before the next is awaited", async () => {
    const { memory, triage, state } = setup();
    const seen: number[] = [];
    const apply = memory!.apply.bind(memory!);
    memory!.apply = async (op) => {
      const raw = state.read(SCAN_MEMORY_FILE);
      seen.push(raw === null ? 0 : JSON.parse(raw).scans[SHA2].patterns.length);
      return apply(op);
    };
    await triage.writeMemory({ patterns: [pattern(1), pattern(2), pattern(3)] });
    // By the time the third note is sent, the first two are on disk.
    expect(seen).toEqual([0, 1, 2]);
  });

  it("two concurrent calls share one cap record: the second is judged after the first is counted (selfscan 3ec87ec3)", async () => {
    const { memory, triage, state } = setup();
    const [a, b] = await Promise.all([
      triage.writeMemory({
        patterns: Array.from({ length: 15 }, (_, i) => pattern(i)),
        hotspots: [{ unit: "app", text: "fragile a" }],
      }),
      triage.writeMemory({
        patterns: Array.from({ length: 15 }, (_, i) => pattern(100 + i)),
        hotspots: [{ unit: "app", text: "fragile b" }],
      }),
    ]);
    expect(a).toMatchObject({ ok: true, written: { patterns: 15, hotspots: 1 } });
    expect(b).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([
        expect.stringMatching(/app already has its one hotspot/),
        expect.stringMatching(/15 written .* already, 5 left \(got 15\)/),
      ]),
    });
    expect(memory!.entries).toHaveLength(16);
    const rec = JSON.parse(state.read(SCAN_MEMORY_FILE)!).scans[SHA2];
    expect(rec.patterns).toHaveLength(15);
    expect(rec.hotspots.app.text).toBe("fragile a");
  });

  it("caps: 20 patterns per scan across calls, one hotspot per unit; refused whole, nothing written", async () => {
    const { memory, triage } = setup();
    expect(
      await triage.writeMemory({ patterns: Array.from({ length: 21 }, (_, i) => pattern(i)) }),
    ).toMatchObject({
      ok: false,
      errors: [expect.stringMatching(/at most 20 patterns per scan/)],
    });
    expect(memory!.entries).toHaveLength(0);
    expect(
      await triage.writeMemory({ patterns: Array.from({ length: 15 }, (_, i) => pattern(i)) }),
    ).toMatchObject({ ok: true });
    expect(
      await triage.writeMemory({ patterns: Array.from({ length: 6 }, (_, i) => pattern(100 + i)) }),
    ).toMatchObject({
      ok: false,
      errors: [expect.stringMatching(/15 written .* already, 5 left \(got 6\)/)],
    });
    expect(
      await triage.writeMemory({ patterns: Array.from({ length: 5 }, (_, i) => pattern(100 + i)) }),
    ).toMatchObject({ ok: true, left: { patterns: 0 } });

    expect(
      await triage.writeMemory({
        hotspots: [
          { unit: "app", text: "fragile a" },
          { unit: "app", text: "fragile b" },
        ],
      }),
    ).toMatchObject({
      ok: false,
      errors: [expect.stringMatching(/app already has its one hotspot/)],
    });
    expect(
      await triage.writeMemory({ hotspots: [{ unit: "app", text: "fragile a" }] }),
    ).toMatchObject({ ok: true });
    expect(
      await triage.writeMemory({ hotspots: [{ unit: "app", text: "fragile again" }] }),
    ).toMatchObject({ ok: false });
    // Another scan (another sha) has its own cap.
    expect(
      await triage.writeMemory({
        run: "scan-1",
        hotspots: [{ unit: "app", text: "fragile then" }],
        patterns: [pattern(1)],
      }),
    ).toMatchObject({
      ok: true,
      sha: SHA1,
    });
    expect(memory!.entries).toHaveLength(23); // 15 + 5 patterns, a hotspot, and scan-1's two
  });

  it("individual findings never become memory: one-line anchors, fingerprints, quoted claims and single occurrences are refused", async () => {
    const { findings, memory, triage } = setup();
    findings.report([reported(FP("a"))], { run: "scan-1", sha: SHA1, at: "t" });
    const refused = async (p: { text: string; occurrences: number }, why: RegExp) =>
      expect(await triage.writeMemory({ patterns: [p] })).toMatchObject({
        ok: false,
        errors: [expect.stringMatching(why)],
      });
    await refused(
      { text: "see app/models.py:12 for the swallowed error", occurrences: 3 },
      /anchors to one line/,
    );
    await refused(
      { text: `the finding ${FP("a").slice(0, 16)} again`, occurrences: 3 },
      /fingerprint/,
    );
    await refused(
      {
        text: "Across views: The save path swallows the integrity error and returns success.",
        occurrences: 3,
      },
      /quotes a stored finding's claim/,
    );
    await refused({ text: "a thing seen once", occurrences: 1 }, /≥ 2/);
    expect(await triage.writeMemory({ hotspots: [{ unit: "billing", text: "x" }] })).toMatchObject({
      ok: false,
      errors: [expect.stringMatching(/not a unit of the saved cut/)],
    });
    expect(memory!.entries).toHaveLength(0);
  });

  it("refuses with no memory, no finished run or an unknown run; a note memory refuses is not counted", async () => {
    expect(
      await setup({ memory: null }).triage.writeMemory({ patterns: [pattern(1)] }),
    ).toMatchObject({ ok: false, errors: [expect.stringMatching(/no reviewer memory/)] });
    expect(
      await setup({ runs: [{ id: "scan-9", sha: SHA1, state: "running" }] }).triage.writeMemory({
        patterns: [pattern(1)],
      }),
    ).toMatchObject({
      ok: false,
      errors: [expect.stringMatching(/no finished scan run/)],
    });
    // A run a restarted companion left behind is no finished scan either.
    expect(
      await setup({
        runs: [{ id: "scan-9", sha: SHA1, state: "interrupted" }],
      }).triage.writeMemory({ patterns: [pattern(1)] }),
    ).toMatchObject({
      ok: false,
      errors: [expect.stringMatching(/no finished scan run/)],
    });
    expect(
      await setup().triage.writeMemory({ run: "scan-7", patterns: [pattern(1)] }),
    ).toMatchObject({ ok: false, errors: [expect.stringMatching(/not a finished scan run/)] });

    const memory = new MemFake();
    memory.refuse = "server down";
    const { triage } = setup({ memory });
    expect(await triage.writeMemory({ patterns: [pattern(1)] })).toMatchObject({
      ok: true,
      written: { patterns: 0 },
      problems: [expect.stringMatching(/server down/)],
      left: { patterns: 20 },
    });
  });
});

describe("end to end: a re-scan fixes a promoted finding and its ticket closes with the scan sha", () => {
  const SHA_A = "a".repeat(40);
  const SHA_B = "b".repeat(40);
  const TREES: Record<string, Record<string, string>> = {
    [SHA_A]: { "app/a.py": "one\ntwo\nthree\n", "lib/b.py": "x\ny\n" },
    // app/a.py deleted (fixed by removal); app/c.py new and clean.
    [SHA_B]: { "lib/b.py": "x\ny\n", "app/c.py": "fine\n" },
  };

  it("promote → re-scan at the next sha → the markdown ticket reads fixed, with that sha", async () => {
    const state = stateHomeFs(join(dir, "state"));
    const listOf = (sha: string) =>
      Object.keys(TREES[sha] ?? {}).map((path) => ({
        path,
        blob: `b-${path}-${TREES[sha]![path]}`,
      }));
    let triage: ScanTriage | null = null;
    const scan = new ScanRunner({
      state,
      clock,
      cases: {
        run: async (spec) => ({
          ok: true,
          cost_usd: 0.02,
          output: spec.files.includes("app/c.py")
            ? "NONE\n\nSUGGEST NONE\n"
            : `FINDINGS pass-scan SCAN ${spec.id} @sha\n- path: ${spec.files[0]}\n  line: 1-2\n  kind: bug\n  severity: P2\n  claim: it breaks badly here\n\nSUGGEST NONE\n`,
        }),
      },
      source: {
        location: "/reviewed-repo",
        resolve: (ref) => (ref in TREES ? ref : null),
        open: (sha) => ({
          ok: true,
          tree: {
            sha,
            root: "/tree",
            files: listOf(sha),
            read: (p) => TREES[sha]?.[p] ?? null,
            lines: (p) =>
              TREES[sha]?.[p] === undefined ? null : TREES[sha]![p]!.split("\n").length - 1,
          },
        }),
        list: (sha) => (TREES[sha] ? listOf(sha) : null),
      },
      savedCut: () => ({
        ok: true,
        cut: {
          units: ["app", "lib"].map((u) => ({ name: u, roots: [u], kind: "directory", note: "" })),
          ignored: [],
        },
      }),
      settings: () => ({ ok: true, settings: { scan: { ...SCAN_DEFAULTS, validator: false } } }),
      buildAgents: () => ({ ok: true }),
      closeFixedTickets: async () => (triage ? triage.closeFixed() : { closed: [], problems: [] }),
    });
    const findings = new FindingsStore(state);
    triage = new ScanTriage({
      findings,
      state,
      memory: new MemFake(),
      tracker: markdownFindingSink(state, clock),
      clock,
      units: () => ["app", "lib"],
      runs: () => scanRuns(scan),
    });
    const runAt = async (sha: string): Promise<void> => {
      for (let i = 0; i < 3; i++) {
        const p = await scan.preview({ sha });
        if (!p.ok) throw new Error(p.errors.join("; "));
        if (p.preview.cases.length === 0) return;
        const r = await scan.start({ key: p.preview.key, sha });
        if (!r.ok) throw new Error(r.errors.join("; "));
        await scan.idle();
      }
    };
    await runAt(SHA_A);
    const appFinding = findings.load().findings.find((f) => f.path === "app/a.py")!;
    // Validator off in this run: the finding is unjudged, promoted explicitly.
    const promoted = await triage.promote({
      fingerprint: appFinding.fingerprint,
      effort: "whatever",
      unconfirmed: true,
    });
    expect(promoted).toMatchObject({ ok: true, sink: "markdown" });
    const ref = (promoted as { ref: string }).ref;
    expect(readFileSync(join(dir, "state", ref), "utf8")).toMatch(/^Status: open$/m);

    await runAt(SHA_B);
    expect(one(findings, appFinding.fingerprint)).toMatchObject({
      state: "fixed",
      fixed: { sha: SHA_B, from: "promoted" },
      ticket: { closed: { sha: SHA_B } },
    });
    const md = readFileSync(join(dir, "state", ref), "utf8");
    expect(md).toMatch(/^Status: fixed$/m);
    expect(md).toContain(`A scan at ${SHA_B}`);
    expect(scan.status().run).toMatchObject({ sha: SHA_B, tickets_closed: 1 });
    // The run's own memory: the latest finished run is the one at SHA_B.
    expect(
      await triage.writeMemory({ hotspots: [{ unit: "lib", text: "b.py keeps breaking" }] }),
    ).toMatchObject({ ok: true, sha: SHA_B });
  });
});

it("uses one durable note identity when a memory acknowledgement is lost", async () => {
  const memory = new MemFake();
  const landed = new Map<string, string>();
  let attempts = 0;
  memory.apply = async (op) => {
    if (op.op !== "note") return { ok: false, message: "unsupported" };
    attempts++;
    landed.set(op.name ?? `unnamed-${attempts}`, op.text);
    return attempts === 1
      ? { ok: false, message: "transport timed out after server write" }
      : { ok: true, message: "present" };
  };
  const { findings, triage } = setup({ memory });
  findings.report([reported(FP("a"))], { run: "scan-1", sha: SHA1, at: "t" });
  await triage.dismiss({ fingerprint: FP("a"), reason: "by design" });
  await triage.dismiss({ fingerprint: FP("a"), reason: "by design" });
  expect(attempts).toBe(2);
  expect(landed.size).toBe(1);
});
