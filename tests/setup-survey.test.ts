// The setup survey: src/setup/survey.ts (what is read, what it
// costs, the lens's grammar, the memory spelling) and the run behind the
// engine's survey verbs (src/setup/surveyrun.ts), driven through SetupEngine
// with every port faked — an in-memory repo, a FAKE CASE RUNNER that answers
// (or holds) each case, an in-memory MemoryStore, a temp state home. What is
// asserted is what the engine RETURNS and what it WRITES: the plan and its
// price, the refusals, the `#survey` entries and their supersession, the
// persisted run.
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  SetupEngine,
  type CaseOutcome,
  type CaseRunner,
  type CaseSpec,
  type RepoReader,
  type SetupPorts,
} from "../src/setup/engine.js";
import { notYetTrackerSink, stateHomeFs } from "../src/setup/adapters.js";
import { parseEventTags, parseHashTags } from "../src/memory/eventtags.js";
import type { MemoryEntry, MemoryOp, MemoryStore, MemoryWriteResult } from "../src/memory/store.js";
import {
  MAX_NOTES_PER_CASE,
  MAX_NOTE_CHARS,
  REFERENCE_RATE,
  REPO_SCOPE,
  SURVEY_AGENT,
  measuredRate,
  parseSurveyNotes,
  pickSample,
  planKey,
  planSurvey,
  surveyEntryTags,
  surveyMemoryText,
} from "../src/setup/survey.js";
import { SURVEY_FILE, type SurveyFile } from "../src/setup/surveyrun.js";
import { renderSurveyPreview } from "../extensions/setup.js";

// ---- fakes -------------------------------------------------------------------

/** Memory with real tag semantics: header `#tags`, retire = `#retired`. */
class FakeMemory implements MemoryStore {
  entries: MemoryEntry[] = [];
  refuseNotes = false;
  refuseRetires = false;
  private n = 0;
  constructor(texts: string[] = []) {
    for (const t of texts) this.add(t);
  }
  private add(text: string): void {
    const i = this.n++;
    this.entries.push({
      id: `e${i}`,
      ts: "2026-09-01 10:00:00",
      day: "2026-09-01",
      block: 0,
      text,
      tags: parseHashTags(text),
      links: [],
      pinned: parseHashTags(text).includes("pinned"),
      hash: `h${i}-${text.length}`,
    });
  }
  live(tag = "survey"): MemoryEntry[] {
    return this.entries.filter((e) => e.tags.includes(tag) && !e.tags.includes("retired"));
  }
  async read(): Promise<MemoryEntry[]> {
    return [...this.entries];
  }
  async search(_q: string, opts?: { tag?: string | null }): Promise<MemoryEntry[]> {
    return this.entries.filter((e) => !opts?.tag || e.tags.includes(opts.tag));
  }
  async apply(op: MemoryOp): Promise<MemoryWriteResult> {
    if (op.op === "note") {
      if (this.refuseNotes) return { ok: false, message: "refused: server down" };
      this.add(op.text);
      return { ok: true, message: "wrote" };
    }
    if (op.op === "retire") {
      if (this.refuseRetires) return { ok: false, message: "refused: server down" };
      const e = this.entries.find((x) => x.id === op.id && x.hash === op.expect);
      if (!e) return { ok: false, message: "stale" };
      e.text = `#retired ${e.text}`;
      e.tags = parseHashTags(e.text);
      e.hash = `${e.hash}r`;
      return { ok: true, message: "retired" };
    }
    return { ok: false, message: `unexpected ${op.op}` };
  }
}

/** A case runner the test drives: every case waits until the test answers it
 * (or answers at once with `auto`). */
class FakeCases implements CaseRunner {
  specs: CaseSpec[] = [];
  inFlight = 0;
  maxInFlight = 0;
  private waiting = new Map<string, (o: CaseOutcome) => void>();
  constructor(public auto: ((spec: CaseSpec) => CaseOutcome) | null = null) {}
  run(spec: CaseSpec, signal: AbortSignal): Promise<CaseOutcome> {
    this.specs.push(spec);
    this.inFlight++;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    return new Promise<CaseOutcome>((resolve) => {
      const done = (o: CaseOutcome): void => {
        this.inFlight--;
        this.waiting.delete(spec.id);
        resolve(o);
      };
      signal.addEventListener("abort", () => done({ ok: false, reason: "stopped" }), {
        once: true,
      });
      if (this.auto) {
        const o = this.auto(spec);
        queueMicrotask(() => done(o));
      } else this.waiting.set(spec.id, done);
    });
  }
  pending(): string[] {
    return [...this.waiting.keys()];
  }
  answer(idSuffix: string, o: CaseOutcome): void {
    const key = [...this.waiting.keys()].find((k) => k.endsWith(`/${idSuffix}`));
    if (!key)
      throw new Error(`no pending case ${idSuffix} (pending: ${this.pending().join(", ")})`);
    this.waiting.get(key)!(o);
  }
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
async function until(pred: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !pred(); i++) await tick();
  expect(pred()).toBe(true);
}

function fakeRepo(
  files: Record<string, string>,
  changes: Record<string, number> | null = null,
): RepoReader & { files: Record<string, string> } {
  const r = {
    files,
    location: "/reviewed-repo",
    listFiles: () => Object.keys(r.files),
    read: (p: string) => r.files[p] ?? null,
    lines: (p: string) => {
      const t = r.files[p];
      return t === undefined ? null : t.split("\n").length - (t.endsWith("\n") ? 1 : 0);
    },
    head: () => "abc123def4567890",
    changeCounts: () => changes,
  };
  return r;
}

const lines = (n: number): string => "x\n".repeat(n);

const REPO: Record<string, string> = {
  "AGENTS.md": lines(40),
  "README.md": lines(20),
  "docs/ARCHITECTURE.md": lines(30),
  "backend/CLAUDE.md": lines(10),
  "backend/manage.py": lines(20),
  "backend/payments/models.py": lines(120),
  "backend/payments/views.py": lines(300),
  "backend/payments/urls.py": lines(15),
  "backend/payments/tests/test_views.py": lines(900),
  "backend/payments/migrations/0001_initial.py": lines(800),
  "web/package.json": "{}\n",
  "web/src/index.tsx": lines(30),
  "web/src/api.ts": lines(60),
  "web/src/big.ts": lines(700),
  "web/node_modules/react/index.js": lines(5),
};

const CUT = {
  units: [
    { name: "payments", roots: ["backend/payments"] },
    { name: "backend", roots: ["backend"] },
    { name: "web", roots: ["web"] },
    { name: "docs", roots: ["docs", "README.md", "AGENTS.md"] },
  ],
  ignored: ["web/node_modules"],
};

let stateDir: string;
let now: Date;

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "qcr-survey-"));
  now = new Date("2026-09-29T10:00:00Z");
});

afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true });
});

function setup(
  opts: {
    repo?: ReturnType<typeof fakeRepo>;
    memory?: MemoryStore | null;
    cases?: CaseRunner;
    concurrency?: number;
    save?: boolean;
  } = {},
) {
  const repo =
    opts.repo ?? fakeRepo({ ...REPO }, { "web/src/big.ts": 9, "backend/payments/views.py": 4 });
  const memory = opts.memory === undefined ? new FakeMemory() : opts.memory;
  const cases = opts.cases ?? new FakeCases();
  const ports: SetupPorts = {
    repo,
    state: stateHomeFs(stateDir),
    clock: () => now,
    memory,
    cases,
    tracker: notYetTrackerSink(""),
    github: { get: async () => ({ ok: false, reason: "no network in tests" }) },
  };
  const engine = new SetupEngine(ports, { surveyConcurrency: opts.concurrency ?? 4 });
  if (opts.save !== false) {
    expect(engine.propose(CUT).ok).toBe(true);
    expect(engine.save().ok).toBe(true);
  }
  return { engine, repo, memory, cases };
}

function onDisk(): SurveyFile {
  return JSON.parse(readFileSync(join(stateDir, SURVEY_FILE), "utf8")) as SurveyFile;
}

const answer = (text: string, cost: number | null = 0.03): CaseOutcome => ({
  ok: true,
  output: text,
  cost_usd: cost,
});

// ---- the rules (survey.ts) ---------------------------------------------------

describe("the sample", () => {
  const files = Object.keys(REPO);
  const linesOf = (p: string): number => (REPO[p] ?? "").split("\n").length - 1;

  it("takes entry points, models, the most-changed and the largest — never tests, migrations, prose or vendored code", () => {
    const own = files.filter((f) => f.startsWith("backend/"));
    const s = pickSample(own, linesOf, { "backend/payments/views.py": 7 });
    expect(s.map((f) => [f.path, f.reason])).toEqual([
      ["backend/manage.py", "entry point"],
      ["backend/payments/urls.py", "entry point"],
      ["backend/payments/models.py", "model / schema"],
      ["backend/payments/views.py", "most-changed (7 commits)"],
    ]);
    const all = pickSample(files, linesOf, null).map((f) => f.path);
    for (const p of all) expect(p).not.toMatch(/tests\/|migrations\/|\.md$|node_modules/);
  });

  it("stays inside the line cap unless one file is all there is", () => {
    const s = pickSample(["web/src/big.ts", "web/src/api.ts"], linesOf, null, {
      perCategory: 2,
      maxFiles: 8,
      maxLines: 500,
    });
    // big.ts (700) would break the cap once api.ts is in; api.ts is the entry point.
    expect(s.map((f) => f.path)).toEqual(["web/src/api.ts"]);
    const alone = pickSample(["web/src/big.ts"], linesOf, null, {
      perCategory: 2,
      maxFiles: 8,
      maxLines: 500,
    });
    expect(alone.map((f) => f.path)).toEqual(["web/src/big.ts"]);
  });

  it("an oversized file leading its category never crowds out one that fits", () => {
    const sizes: Record<string, number> = { "web/src/a.ts": 3000, "web/src/b.ts": 100 };
    const s = pickSample(Object.keys(sizes), (p) => sizes[p] ?? 0, null);
    // Only "largest" has candidates, and a.ts leads it: the cap still holds,
    // because b.ts fits — the oversized exception is for a unit with nothing that does.
    expect(s.map((f) => f.path)).toEqual(["web/src/b.ts"]);
    const lines: Record<string, number> = { "web/src/api.ts": 900, "web/src/util.ts": 40 };
    const e = pickSample(Object.keys(lines), (p) => lines[p] ?? 0, null, {
      perCategory: 2,
      maxFiles: 8,
      maxLines: 500,
    });
    expect(e.map((f) => f.path)).toEqual(["web/src/util.ts"]);
  });

  it("an unreadable history only empties the most-changed reason", () => {
    const s = pickSample(["web/src/api.ts", "web/src/big.ts"], linesOf, null);
    expect(s.map((f) => f.reason)).toEqual(["entry point", "largest (700 lines)"]);
  });
});

describe("the plan", () => {
  const linesOf = (p: string): number => (REPO[p] ?? "").split("\n").length - 1;
  const input = {
    cut: {
      units: CUT.units.map((u) => ({ ...u, kind: "custom" as const, note: "" })),
      ignored: CUT.ignored,
    },
    files: Object.keys(REPO),
    agentFiles: ["AGENTS.md", "backend/CLAUDE.md", "web/node_modules/react/CLAUDE.md"],
    guides: ["README.md", "docs/ARCHITECTURE.md"],
    linesOf,
    changes: null,
    budget: { maxFiles: 30, maxLines: 3000 },
  };

  it("reads directive files then design docs in full first, under @repo; then one sample case per unit", () => {
    const plan = planSurvey(input);
    expect(plan.cases[0]).toMatchObject({ id: REPO_SCOPE, unit: REPO_SCOPE, stage: "repo" });
    expect(plan.cases[0]!.files.map((f) => [f.path, f.reason])).toEqual([
      ["AGENTS.md", "agent-directive file"],
      ["backend/CLAUDE.md", "agent-directive file"],
      ["README.md", "design doc"],
      ["docs/ARCHITECTURE.md", "design doc"],
    ]);
    expect(plan.cases.slice(1).map((c) => [c.id, c.stage])).toEqual([
      ["payments", "unit"],
      ["backend", "unit"],
      ["web", "unit"],
    ]);
    // docs owns only prose: reported, never silently dropped.
    expect(plan.unsampled).toEqual(["docs"]);
  });

  it("splits a repo-wide read too big for one case, every part under @repo", () => {
    const plan = planSurvey({ ...input, budget: { maxFiles: 2, maxLines: 3000 } });
    expect(plan.cases.filter((c) => c.stage === "repo").map((c) => c.id)).toEqual([
      "@repo#1",
      "@repo#2",
    ]);
    expect(plan.cases.filter((c) => c.stage === "repo").every((c) => c.unit === REPO_SCOPE)).toBe(
      true,
    );
  });

  it("the preview key names the plan, the head AND the price", () => {
    const plan = planSurvey(input);
    const R = REFERENCE_RATE;
    expect(planKey(plan, "a", R)).toBe(planKey(planSurvey(input), "a", R));
    expect(planKey(plan, "a", R)).not.toBe(planKey(plan, "b", R));
    expect(planKey(plan, "a", R)).not.toBe(
      planKey(planSurvey({ ...input, guides: ["README.md"] }), "a", R),
    );
    expect(planKey(plan, "a", R)).not.toBe(
      planKey(plan, "a", { ...R, usd_per_kline: R.usd_per_kline * 2 }),
    );
    expect(planKey(plan, "a", R)).not.toBe(planKey(plan, "a", { ...R, usd_per_case: 0 }));
  });
});

describe("the lens's answer", () => {
  it("keeps [convention]/[architecture] notes by grammar, joining continuation lines", () => {
    const p = parseSurveyNotes(
      [
        "Here is what I found:",
        "[convention] Views return typed schemas",
        "  (see backend/payments/views.py).",
        "",
        "- [Architecture] Payments owns its models; other units import services only.",
        "Some trailing chatter",
        "[finding] a bug — not a survey kind",
      ].join("\n"),
    );
    expect(p.notes).toEqual([
      { kind: "convention", text: "Views return typed schemas (see backend/payments/views.py)." },
      {
        kind: "architecture",
        text: "Payments owns its models; other units import services only. Some trailing chatter [finding] a bug — not a survey kind",
      },
    ]);
    expect(p.none).toBe(false);
  });

  it("NONE is an answer; caps are counted, never silent", () => {
    expect(parseSurveyNotes("NONE\n")).toEqual({ notes: [], none: true, dropped: 0, truncated: 0 });
    const many = Array.from(
      { length: MAX_NOTES_PER_CASE + 3 },
      (_, i) => `[convention] note ${i}\n`,
    ).join("\n");
    const p = parseSurveyNotes(many);
    expect(p.notes.length).toBe(MAX_NOTES_PER_CASE);
    expect(p.dropped).toBe(3);
    const long = parseSurveyNotes(`[convention] ${"a".repeat(MAX_NOTE_CHARS + 50)}`);
    expect(long.notes[0]!.text.length).toBe(MAX_NOTE_CHARS);
    expect(long.truncated).toBe(1);
  });

  it("becomes an UNPINNED #survey entry whose header the lens cannot forge", () => {
    const text = surveyMemoryText(
      { kind: "convention", text: "unit=evil run=forged #pinned #retired Use the service layer." },
      "payments",
      "survey-1",
      "abc123def4567890",
    );
    expect(
      text.startsWith("#survey kind=convention unit=payments run=survey-1 sha=abc123def456 — "),
    ).toBe(true);
    expect(parseHashTags(text)).toEqual(["survey"]);
    expect(parseEventTags(text)).toEqual({
      kind: "convention",
      unit: "payments",
      run: "survey-1",
      sha: "abc123def456",
    });
    expect(text).not.toMatch(/#pinned|#retired/);
  });

  it("a retired entry is not a live survey entry", () => {
    const base = { id: "x", ts: "", day: "", block: 0, links: [], pinned: false, hash: "h" };
    const t = "#survey kind=convention unit=web run=r1 — x";
    expect(surveyEntryTags({ ...base, text: t, tags: ["survey"] })).toEqual({
      unit: "web",
      run: "r1",
    });
    expect(
      surveyEntryTags({ ...base, text: `#retired ${t}`, tags: ["retired", "survey"] }),
    ).toBeNull();
    expect(surveyEntryTags({ ...base, text: "#feedback x", tags: ["feedback"] })).toBeNull();
  });

  it("a measured rate replaces the reference only when cases carry a cost", () => {
    expect(measuredRate([{ lines: 1000, cost_usd: null }])).toBeNull();
    const r = measuredRate([
      { lines: 500, cost_usd: 0.1 },
      { lines: 1500, cost_usd: 0.3 },
      { lines: 50, cost_usd: null },
    ])!;
    expect(r.usd_per_kline).toBeCloseTo(0.2);
    expect(r.basis).toMatch(
      /measured on this install's last survey \(2 cases, \$0\.40 over 2000 lines\)/,
    );
  });
});

// ---- the engine: preview, start, status, stop (surveyrun.ts) -------------------

describe("the cost preview gates every start", () => {
  it("needs a saved cut", async () => {
    const { engine } = setup({ save: false });
    const r = await engine.surveyPreview();
    expect(r).toEqual({ ok: false, errors: [expect.stringMatching(/no saved unit cut/)] });
  });

  it("prices the plan and hands out a key; a start without it, or with a stale one, is refused", async () => {
    const { engine, repo, cases } = setup();
    const r = await engine.surveyPreview();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const p = r.preview;
    expect(p.cases.map((c) => c.id)).toEqual([REPO_SCOPE, "payments", "backend", "web"]);
    expect(p.rate).toEqual(REFERENCE_RATE);
    expect(p.estimate_usd).toBeCloseTo(
      p.cases.length * REFERENCE_RATE.usd_per_case +
        (p.lines / 1000) * REFERENCE_RATE.usd_per_kline,
    );
    expect(p.cases.find((c) => c.id === "web")!.files.map((f) => f.reason)).toContain(
      "most-changed (9 commits)",
    );
    expect(p).toMatchObject({
      existing_entries: 0,
      needs_resurvey: false,
      blockers: [],
      concurrency: 4,
    });

    expect(await engine.surveyStart({})).toEqual({
      ok: false,
      errors: [expect.stringMatching(/no preview key/)],
    });
    repo.files = { ...repo.files, "web/src/routes.ts": lines(10) };
    const stale = await engine.surveyStart({ key: p.key });
    expect(stale).toEqual({
      ok: false,
      errors: [expect.stringMatching(/the plan changed since that preview/)],
    });
    expect((cases as FakeCases).specs).toEqual([]);
  });

  it("the key binds the price: a rate measured by a partial run invalidates the preview taken at the old one", async () => {
    // One unit fails, so the run settles partial (no re-survey flag needed),
    // but the finished cases carry a cost and settle replaces the rate.
    const fake = new FakeCases((spec) =>
      spec.unit === "web" ? answer("the tool errored") : answer("NONE", 0.5),
    );
    const { engine } = setup({ cases: fake });
    const r = await engine.surveyPreview();
    if (!r.ok) throw new Error(r.errors.join("; "));
    expect(r.preview.rate).toEqual(REFERENCE_RATE);
    expect((await engine.surveyStart({ key: r.preview.key })).ok).toBe(true);
    await engine.surveyIdle();
    expect(engine.surveyStatus().run!.state).toBe("partial");
    expect(onDisk().rate).not.toBeNull();
    const again = await engine.surveyStart({ key: r.preview.key });
    expect(again).toEqual({
      ok: false,
      errors: [expect.stringMatching(/the plan changed since that preview/)],
    });
    const fresh = await engine.surveyPreview();
    if (!fresh.ok) throw new Error(fresh.errors.join("; "));
    expect(fresh.preview.key).not.toBe(r.preview.key);
    expect((await engine.surveyStart({ key: fresh.preview.key })).ok).toBe(true);
    await engine.surveyIdle();
  });

  it("files the saved cut no longer covers are listed in the preview and the run, never silently skipped", async () => {
    const { engine, repo } = setup();
    repo.files = { ...repo.files, "services/api.ts": lines(40) };
    const r = await engine.surveyPreview();
    if (!r.ok) throw new Error(r.errors.join("; "));
    expect(r.preview.unassigned).toEqual(["services/api.ts"]);
    expect(renderSurveyPreview(r.preview)).toMatch(/belong to no unit.*services\/api\.ts/);
    const st = await engine.surveyStart({ key: r.preview.key });
    if (!st.ok) throw new Error(st.errors.join("; "));
    expect(st.run.unassigned).toEqual(["services/api.ts"]);
    engine.surveyStop();
    await engine.surveyIdle();
  });

  it("with no memory the preview says so and a start is refused — the survey exists to write memory", async () => {
    const { engine } = setup({ memory: null });
    const r = await engine.surveyPreview();
    expect(r.ok && r.preview.blockers.join("\n")).toMatch(/no memory store/);
    expect(r.ok && r.preview.existing_entries).toBeNull();
    const key = r.ok ? r.preview.key : "";
    expect(await engine.surveyStart({ key })).toEqual({
      ok: false,
      errors: [expect.stringMatching(/no memory store/)],
    });
  });
});

describe("two overlapping starts", () => {
  it("admit ONE survey: the second is refused even while the first still awaits memory readiness", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const mem = new FakeMemory();
    let readies = 0;
    (mem as MemoryStore).ensureWritable = async () => {
      readies++;
      await gate;
      return { ok: true, message: "ready" };
    };
    const fake = new FakeCases();
    const { engine } = setup({ memory: mem, cases: fake });
    const r = await engine.surveyPreview();
    if (!r.ok) throw new Error(r.errors.join("; "));
    const a = engine.surveyStart({ key: r.preview.key });
    const b = engine.surveyStart({ key: r.preview.key });
    release();
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra.ok).toBe(true);
    expect(rb).toEqual({
      ok: false,
      errors: [expect.stringMatching(/already (starting|running)/)],
    });
    expect(readies).toBe(1);
    await until(() => fake.pending().length === 1);
    expect(fake.specs.length).toBe(1);
    engine.surveyStop();
    await engine.surveyIdle();
  });

  it("a start refused at memory readiness frees the slot for the next one", async () => {
    const mem = new FakeMemory();
    let ok = false;
    (mem as MemoryStore).ensureWritable = async () =>
      ok ? { ok: true, message: "ready" } : { ok: false, message: "down" };
    const fake = new FakeCases(() => answer("NONE"));
    const { engine } = setup({ memory: mem, cases: fake });
    const r = await engine.surveyPreview();
    if (!r.ok) throw new Error(r.errors.join("; "));
    expect(await engine.surveyStart({ key: r.preview.key })).toEqual({
      ok: false,
      errors: [expect.stringMatching(/not writable: down/)],
    });
    ok = true;
    expect((await engine.surveyStart({ key: r.preview.key })).ok).toBe(true);
    await engine.surveyIdle();
  });
});

describe("a survey run", () => {
  async function started(opts: Parameters<typeof setup>[0] = {}) {
    const s = setup(opts);
    const r = await s.engine.surveyPreview();
    if (!r.ok) throw new Error(r.errors.join("; "));
    const st = await s.engine.surveyStart({ key: r.preview.key });
    if (!st.ok) throw new Error(st.errors.join("; "));
    return { ...s, run: st.run, fake: s.cases as FakeCases, mem: s.memory as FakeMemory };
  }

  it("returns at once and runs in the background: the repo-wide read first, then the units carrying its notes", async () => {
    const { engine, fake, mem, run } = await started();
    // start() came back with the run recorded and nothing answered yet.
    expect(run.state).toBe("running");
    expect(engine.surveyStatus()).toMatchObject({ active: true, run: { display: "running" } });
    await until(() => fake.pending().length === 1);
    expect(fake.specs.map((s) => s.id)).toEqual([`${run.id}/@repo`]);
    expect(fake.specs[0]).toMatchObject({ agent: SURVEY_AGENT, unit: REPO_SCOPE });
    expect(fake.specs[0]!.prompt).toMatch(/Read EVERY file below IN FULL/);
    expect(fake.specs[0]!.prompt).toMatch(/\/reviewed-repo\/AGENTS\.md — agent-directive file/);

    fake.answer(
      "@repo",
      answer(
        "[convention] Every view is typed (AGENTS.md).\n\n[architecture] Backend is Django, web is React.",
      ),
    );
    await until(() => fake.pending().length === 3);
    const unitSpec = fake.specs.find((s) => s.unit === "payments")!;
    expect(unitSpec.prompt).toMatch(/do NOT restate these/);
    expect(unitSpec.prompt).toContain("- [convention] Every view is typed (AGENTS.md).");
    expect(unitSpec.prompt).toMatch(/backend\/payments\/models\.py — model \/ schema/);

    fake.answer("payments", answer("[convention] Money is Decimal (backend/payments/models.py)."));
    fake.answer("backend", answer("NONE"));
    fake.answer("web", answer("[architecture] api.ts is the one HTTP client."));
    await engine.surveyIdle();

    const live = mem.live();
    expect(live.map((e) => parseEventTags(e.text).unit)).toEqual([
      REPO_SCOPE,
      REPO_SCOPE,
      "payments",
      "web",
    ]);
    for (const e of live) {
      expect(e.pinned).toBe(false);
      expect(parseEventTags(e.text).run).toBe(run.id);
    }
    const s = engine.surveyStatus();
    expect(s.active).toBe(false);
    expect(s.run).toMatchObject({ state: "complete", display: "complete", superseded: 0 });
    expect(s.run!.cases.find((c) => c.id === "backend")).toMatchObject({
      status: "done",
      none: true,
      notes_written: 0,
    });
    expect(onDisk().last_complete).toMatchObject({
      id: run.id,
      notes: 4,
      cost_usd: expect.closeTo(0.12),
    });
  });

  it("never runs more cases at once than its concurrency", async () => {
    const fake = new FakeCases((spec) => answer(`[convention] ${spec.unit} note`));
    const { engine } = await started({ cases: fake, concurrency: 2 });
    await engine.surveyIdle();
    expect(fake.specs.length).toBe(4);
    expect(fake.maxInFlight).toBe(2);
  });

  it("a completed survey refuses a second start unless it is a re-survey, which supersedes the old entries", async () => {
    const fake = new FakeCases((spec) => answer(`[convention] ${spec.unit} v1`));
    const { engine, mem } = await started({ cases: fake });
    await engine.surveyIdle();
    expect(mem.live().length).toBe(4);

    const p = await engine.surveyPreview();
    if (!p.ok) throw new Error("preview");
    expect(p.preview).toMatchObject({ needs_resurvey: true, existing_entries: 4 });
    expect(await engine.surveyStart({ key: p.preview.key })).toEqual({
      ok: false,
      errors: [expect.stringMatching(/a survey already completed .* resurvey: true/)],
    });

    now = new Date("2026-09-30T10:00:00Z");
    fake.auto = (spec) => answer(`[convention] ${spec.unit} v2`);
    const again = await engine.surveyStart({ key: p.preview.key, resurvey: true });
    expect(again.ok).toBe(true);
    await engine.surveyIdle();
    expect(mem.live().map((e) => e.text.split(" — ")[1])).toEqual([
      "@repo v2",
      "payments v2",
      "backend v2",
      "web v2",
    ]);
    expect(mem.entries.filter((e) => e.tags.includes("retired")).length).toBe(4);
    expect(engine.surveyStatus().run).toMatchObject({
      state: "complete",
      superseded: 4,
      resurvey: true,
    });
  });

  it("a unit whose read failed keeps its earlier entries; the run is partial", async () => {
    const mem = new FakeMemory([
      "#survey kind=convention unit=web run=survey-old — web v1",
      "#survey kind=convention unit=payments run=survey-old — payments v1",
      "#survey kind=convention unit=gone run=survey-old — a unit since removed",
    ]);
    const fake = new FakeCases((spec) =>
      spec.unit === "web"
        ? { ok: false, reason: "pi exited 1" }
        : answer(`[convention] ${spec.unit} v2`),
    );
    const { engine } = await started({ cases: fake, memory: mem });
    await engine.surveyIdle();
    const live = mem.live().map((e) => e.text.split(" — ")[1]);
    expect(live).toContain("web v1"); // the failed unit keeps its notes
    expect(live).not.toContain("payments v1"); // superseded
    expect(live).toContain("a unit since removed"); // only a COMPLETE run clears the rest
    const s = engine.surveyStatus();
    expect(s.run).toMatchObject({ state: "partial", superseded: 1 });
    expect(s.run!.cases.find((c) => c.id === "web")).toMatchObject({
      status: "failed",
      error: "pi exited 1",
    });
    expect(onDisk().last_complete).toBeNull(); // not completed: a plain start may run again
  });

  it("notes memory refused are counted, and that unit is not superseded", async () => {
    const mem = new FakeMemory(["#survey kind=convention unit=web run=survey-old — web v1"]);
    mem.refuseNotes = true;
    const fake = new FakeCases((spec) => answer(`[convention] ${spec.unit} v2`));
    const { engine } = await started({ cases: fake, memory: mem });
    await engine.surveyIdle();
    expect(mem.live().map((e) => e.text.split(" — ")[1])).toEqual(["web v1"]);
    const s = engine.surveyStatus().run!;
    expect(s.state).toBe("partial");
    expect(s.cases.find((c) => c.id === "web")).toMatchObject({
      notes_failed: 1,
      error: expect.stringMatching(/memory refused/),
    });
  });

  it("an answer with no notes and no NONE line is not a read: the unit keeps its earlier entries; the run is partial", async () => {
    const mem = new FakeMemory([
      "#survey kind=convention unit=web run=survey-old — web v1",
      "#survey kind=convention unit=gone run=survey-old — a unit since removed",
    ]);
    const fake = new FakeCases((spec) =>
      spec.unit === "web"
        ? answer("I could not read the files; the tool errored.")
        : answer(`[convention] ${spec.unit} v2`),
    );
    const { engine } = await started({ cases: fake, memory: mem });
    await engine.surveyIdle();
    const live = mem.live().map((e) => e.text.split(" — ")[1]);
    expect(live).toContain("web v1");
    expect(live).toContain("a unit since removed");
    const s = engine.surveyStatus().run!;
    expect(s.state).toBe("partial");
    expect(s.cases.find((c) => c.id === "web")).toMatchObject({
      status: "failed",
      none: false,
      notes_written: 0,
      error: expect.stringMatching(/no \[convention\]\/\[architecture\] note and no NONE/),
    });
    expect(onDisk().last_complete).toBeNull();
  });

  it("a retire memory refused leaves the run partial, never complete beside two live generations", async () => {
    const mem = new FakeMemory(["#survey kind=convention unit=web run=survey-old — web v1"]);
    mem.refuseRetires = true;
    const fake = new FakeCases((spec) => answer(`[convention] ${spec.unit} v2`));
    const { engine } = await started({ cases: fake, memory: mem });
    await engine.surveyIdle();
    expect(mem.live().map((e) => e.text.split(" — ")[1])).toContain("web v1");
    const s = engine.surveyStatus().run!;
    expect(s.state).toBe("partial");
    expect(s.problems).toEqual([expect.stringMatching(/could not retire an earlier survey entry/)]);
    expect(onDisk().last_complete).toBeNull(); // a plain start may run it again
  });

  it("stop aborts what runs and never starts what waits; written notes stay", async () => {
    const { engine, fake, mem } = await started({ concurrency: 1 });
    await until(() => fake.pending().length === 1);
    fake.answer("@repo", answer("[convention] kept"));
    await until(() => fake.pending().length === 1);
    expect(engine.surveyStop().ok).toBe(true);
    await engine.surveyIdle();
    const run = engine.surveyStatus().run!;
    expect(run.state).toBe("stopped");
    expect(run.cases.map((c) => c.status)).toEqual(["done", "stopped", "stopped", "stopped"]);
    expect(mem.live().length).toBe(1);
    expect(engine.surveyStop()).toEqual({
      ok: false,
      errors: ["no survey is running in this companion"],
    });
  });

  it("a run left 'running' by a restarted companion reads as interrupted and may be started again", async () => {
    const { run } = await started();
    const fresh = setup({ save: false }).engine; // same state home, new process
    const s = fresh.surveyStatus();
    expect(s.run).toMatchObject({ id: run.id, state: "running", display: "interrupted" });
    expect(s.active).toBe(false);
    const p = await fresh.surveyPreview();
    if (!p.ok) throw new Error("preview");
    expect(p.preview.needs_resurvey).toBe(false);
    expect((await fresh.surveyStart({ key: p.preview.key })).ok).toBe(true);
  });

  it("the first run's measured cost prices the next preview", async () => {
    const fake = new FakeCases(() => answer("NONE", 0.5));
    const { engine } = await started({ cases: fake });
    await engine.surveyIdle();
    const p = await engine.surveyPreview();
    if (!p.ok) throw new Error("preview");
    expect(p.preview.rate.basis).toMatch(
      /measured on this install's last survey \(4 cases, \$2\.00/,
    );
    expect(p.preview.estimate_usd).toBeCloseTo(2.0);
  });

  it("an unreadable survey record is reported and never overwritten", async () => {
    const { engine } = setup();
    mkdirSync(join(stateDir, "setup"), { recursive: true });
    writeFileSync(join(stateDir, SURVEY_FILE), "{ nope");
    expect(engine.surveyStatus()).toMatchObject({
      ok: false,
      run: null,
      problems: [expect.stringMatching(/nothing will overwrite it/)],
    });
    const p = await engine.surveyPreview();
    expect(p.ok).toBe(false);
    expect(readFileSync(join(stateDir, SURVEY_FILE), "utf8")).toBe("{ nope");
  });

  it("memory that did not answer is UNKNOWN, never 0 entries — and the run is not complete", async () => {
    // OpenViking's search() is total and answers [] for an outage; its sweep()
    // keeps the difference, and the survey asks that way.
    class SweepMemory extends FakeMemory {
      unread: string[] = ["ls viking://user/reviewer/memories: connection refused"];
      async sweep(): Promise<{ entries: MemoryEntry[]; unread: string[] }> {
        return {
          entries: this.entries.filter((e) => !e.tags.includes("retired")),
          unread: this.unread,
        };
      }
      override async search(): Promise<MemoryEntry[]> {
        return []; // what the real store answers when the server is down
      }
    }
    const mem = new SweepMemory(["#survey kind=convention unit=web run=survey-old — web v1"]);
    const fake = new FakeCases((spec) => answer(`[convention] ${spec.unit} v2`));
    const s = setup({ cases: fake, memory: mem });
    const p = await s.engine.surveyPreview();
    if (!p.ok) throw new Error("preview");
    expect(p.preview.existing_entries).toBeNull();
    expect((await s.engine.surveyStart({ key: p.preview.key })).ok).toBe(true);
    await s.engine.surveyIdle();
    const run = s.engine.surveyStatus().run!;
    expect(run.state).toBe("partial");
    expect(run.problems).toContain(
      "could not read memory to supersede earlier survey entries — they stay live",
    );
    expect(mem.live().map((e) => e.text.split(" — ")[1])).toContain("web v1");
    expect(onDisk().last_complete).toBeNull();

    // Once memory answers, a sweep with nothing unread counts for real.
    mem.unread = [];
    const again = await s.engine.surveyPreview();
    if (!again.ok) throw new Error("preview");
    expect(again.preview.existing_entries).toBe(5);
  });

  it("a re-survey supersedes only what a survey run wrote — never a pinned, #manual or run-less entry", async () => {
    const mem = new FakeMemory([
      "#survey kind=convention unit=web run=survey-old — web v1",
      "#survey #pinned kind=convention unit=web run=survey-old — pinned by the owner",
      "#manual #survey — the owner's own survey note",
      "#survey — hand-tagged, no run",
    ]);
    const fake = new FakeCases((spec) => answer(`[convention] ${spec.unit} v2`));
    const { engine } = await started({ cases: fake, memory: mem });
    await engine.surveyIdle();
    const live = mem.live().map((e) => e.text.split(" — ")[1]);
    expect(live).not.toContain("web v1");
    expect(live).toEqual(
      expect.arrayContaining([
        "pinned by the owner",
        "the owner's own survey note",
        "hand-tagged, no run",
      ]),
    );
    expect(engine.surveyStatus().run).toMatchObject({ state: "complete", superseded: 1 });
  });

  it("a case runner that throws fails that case, never the companion", async () => {
    const throwing: CaseRunner = {
      run: async () => {
        throw new Error("boom");
      },
    };
    const { engine } = await started({ cases: throwing });
    await engine.surveyIdle();
    const run = engine.surveyStatus().run!;
    expect(run.state).toBe("partial");
    expect(
      run.cases.every(
        (c) => c.status === "failed" && /the case runner threw: boom/.test(c.error ?? ""),
      ),
    ).toBe(true);
  });
});
