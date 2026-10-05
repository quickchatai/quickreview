// extensions/setup-triage.ts — the triage tools of the companion's scan belt
// (FT-0463), over a ScanTriage with an in-memory memory, a fake tracker sink
// and a temp state home: what each tool SAYS for a dismissal, a promotion
// (filed, and back onto an existing ticket), a close, the scan memory and a
// refusal — and scan_match closing the ticket of the promoted finding its
// answer fixed. The rules themselves are tests/scan-triage.test.ts's.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PiToolDefinition } from "@earendil-works/pi-coding-agent";
import { scanToolDefinitions } from "../extensions/setup-scan.js";
import { triageToolDefinitions } from "../extensions/setup-triage.js";
import { SCAN_DEFAULTS } from "../src/config.js";
import { parseHashTags } from "../src/memory/eventtags.js";
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
} from "../src/setup/findings.js";
import { ScanRunner } from "../src/setup/scanrun.js";
import { ScanTriage } from "../src/setup/triage.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "qcr-triage-ext-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

class Notes implements MemoryStore {
  entries: MemoryEntry[] = [];
  async read(): Promise<MemoryEntry[]> {
    return this.entries;
  }
  async search(q: string, opts?: { tag?: string | null }): Promise<MemoryEntry[]> {
    return this.entries.filter((e) => matchesQuery(e, q, opts));
  }
  async apply(op: MemoryOp): Promise<MemoryWriteResult> {
    if (op.op !== "note") return { ok: false, message: "unsupported" };
    const n = this.entries.length + 1;
    this.entries.push({
      id: `e${n}`,
      ts: "t",
      day: "d",
      block: 0,
      text: op.text,
      tags: parseHashTags(op.text),
      links: [],
      pinned: false,
      hash: `h${n}`,
    });
    return { ok: true, message: "ok" };
  }
}

class Sink implements TrackerSink {
  readonly kind = "tracker";
  filed: TrackerTicket[] = [];
  closed: string[] = [];
  async file(t: TrackerTicket): Promise<SinkResult> {
    this.filed.push(t);
    return { ok: true, ref: `FT-${700 + this.filed.length}` };
  }
  async close(ref: string): Promise<SinkResult> {
    this.closed.push(ref);
    return { ok: true, ref };
  }
}

const SHA = "a".repeat(40);
const FP = (c: string): string => c.repeat(64);
const finding = (fp: string, path = "app/a.py"): ReportedFinding => ({
  fingerprint: fp,
  unit: "app",
  path,
  blob: "b",
  start: 1,
  end: 2,
  lens: "pass-scan",
  kind: "bug",
  severity: "P2",
  confidence: null,
  claim: "it breaks when the list is empty",
  evidence: null,
  fix: null,
  detail: null,
  validated: true,
  doubt: null,
  validity: "confirmed",
  scenario: "an empty list from the API reaches it",
});

function belt() {
  const state = stateHomeFs(join(dir, "state"));
  const findings = new FindingsStore(state);
  const sink = new Sink();
  const memory = new Notes();
  const triage = new ScanTriage({
    findings,
    state,
    memory,
    tracker: sink,
    clock: () => new Date("2026-09-29T10:00:00Z"),
    units: () => ["app", "lib"],
    runs: () => [{ id: "scan-1", sha: SHA, state: "complete" }],
  });
  const scan = new ScanRunner({
    state,
    clock: () => new Date(),
    cases: { run: async () => ({ ok: false, reason: "unused" }) },
    source: {
      location: "/r",
      resolve: () => null,
      open: () => ({ ok: false, reason: "unused" }),
      list: () => null,
    },
    savedCut: () => ({ ok: false, errors: ["unused"] }),
    settings: () => ({ ok: true, settings: { scan: { ...SCAN_DEFAULTS, validator: false } } }),
    buildAgents: () => ({ ok: true }),
  });
  const defs = [
    ...scanToolDefinitions(
      scan,
      findings,
      () => null,
      () => triage.closeFixed(),
    ),
    ...triageToolDefinitions(triage),
  ];
  return { defs, findings, sink, memory, state };
}

async function call(
  defs: PiToolDefinition[],
  name: string,
  params: Record<string, unknown> = {},
): Promise<string> {
  return (await defs.find((d) => d.name === name)!.execute("id", params)).content
    .map((c) => c.text)
    .join("\n");
}

describe("the triage tools", () => {
  it("dismiss, promote (filed once, then back onto its ticket), and their refusals", async () => {
    const { defs, findings, sink, memory } = belt();
    findings.report([finding(FP("a")), finding(FP("b"), "app/b.py")], {
      run: "scan-1",
      sha: SHA,
      at: "t",
    });

    expect(
      await call(defs, "scan_dismiss", {
        fingerprint: FP("a").slice(0, 12),
        reason: "empty lists never reach it",
      }),
    ).toBe("aaaaaaaaaaaa dismissed: the memory note is written.");
    expect(memory.entries[0]!.text).toMatch(/^#scan kind=dismissal /);
    expect(await call(defs, "scan_dismiss", { fingerprint: FP("b") })).toMatch(
      /^Dismiss refused:\n✗ a dismissal needs the operator's reason/,
    );

    expect(await call(defs, "scan_promote", { fingerprint: FP("b"), effort: "billing" })).toBe(
      "bbbbbbbbbbbb promoted: filed as FT-701.",
    );
    expect(await call(defs, "scan_promote", { fingerprint: FP("b"), effort: "billing" })).toBe(
      "bbbbbbbbbbbb is promoted onto its existing ticket FT-701 — nothing new was filed",
    );
    expect(sink.filed).toHaveLength(1);
    expect(await call(defs, "scan_promote", { fingerprint: FP("b") })).toBe(
      "bbbbbbbbbbbb is promoted onto its existing ticket FT-701 — nothing new was filed",
    );
    expect(await call(defs, "scan_promote", { fingerprint: FP("c"), effort: "x" })).toMatch(
      /^Promote refused:\n✗ no stored finding/,
    );
    expect(await call(defs, "scan_close_fixed")).toBe(
      "Nothing to close: no promoted finding is fixed with its ticket still open.",
    );
  });

  it("scan_match closes the ticket of the promoted finding its answer fixed", async () => {
    const { defs, findings, sink, state } = belt();
    findings.report([finding(FP("a"))], { run: "scan-1", sha: SHA, at: "t1" });
    await call(defs, "scan_promote", { fingerprint: FP("a"), effort: "billing" });
    findings.report([finding(FP("d"), "app/d.py")], {
      run: "scan-2",
      sha: "b".repeat(40),
      at: "t2",
    });
    const file = JSON.parse(state.read(FINDINGS_FILE)!) as FindingsFile;
    file.question = {
      key: "k1",
      run: "scan-2",
      sha: "b".repeat(40),
      at: "t2",
      unreported: [FP("a")],
      fresh: [FP("d")],
    };
    writeFileSync(join(dir, "state", FINDINGS_FILE), JSON.stringify(file));
    expect(await call(defs, "scan_match", { key: "k1", pairs: [] })).toBe(
      "Settled: 0 matched (state kept), 1 fixed, 1 new.\nClosed as fixed: FT-701.",
    );
    expect(sink.closed).toEqual(["FT-701"]);
    expect(await call(defs, "scan_close_fixed")).toMatch(/^Nothing to close/);
  });

  it("scan_memory writes within the caps and says what is left; a finding-shaped pattern is refused", async () => {
    const { defs } = belt();
    expect(
      await call(defs, "scan_memory", {
        patterns: [
          { text: "Serializers re-validate what the model already enforces", occurrences: 5 },
        ],
        hotspots: [{ unit: "lib", text: "the retry helpers" }],
      }),
    ).toBe(
      "Written for the scan at aaaaaaaaaaaa (run scan-1): 1 pattern(s), 1 hotspot(s).\nLeft for this scan: 19 pattern(s); units without a hotspot: app.",
    );
    expect(
      await call(defs, "scan_memory", { patterns: [{ text: "see lib/x.py:4", occurrences: 2 }] }),
    ).toMatch(/^Scan memory refused:\n✗ patterns\[0\]\.text anchors to one line/);
  });
});
