// The post-scan re-tune and portrait refresh (setup & scan spec
// "Re-tuning" and "Portrait", user stories 23–24 and 86–87).
//
// External behaviour at the seams the spec names:
//   * the PORTRAIT, through SetupEngine with a temp state home: facts
//     assembled after a scan carry what it found (the last scan, findings by
//     unit and state, the hotspots from scan memory), the pre-scan version is
//     kept as `previous`, the narrative reads STALE, and a portrait that never
//     saw a scan keeps the key it always had;
//   * the RE-TUNE, through SetupEngine.retune: what a re-tune WROTE makes the
//     plan (`buildPassPlan`) do — the same resolution wire.ts runs at boot —
//     and what it refuses, logs and reports (every change with its reason and
//     what it moved in the resolved profile);
//   * the DEPLOY TAB (`pendingRetunes` / `deployLines`): the re-tune shows as
//     not deployed exactly while the config home's profiles are behind.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseConfig, type Config } from "../src/config.js";
import { buildPassPlan } from "../src/dispatch.js";
import { NONE_ECOSYSTEM } from "../src/ecosystem.js";
import type { PrFileEntry } from "../src/github.js";
import { configHome, type InstallEnv } from "../src/install.js";
import { applyProfileTuning } from "../src/lenstuning.js";
import { loadProfileLensTuning } from "../src/profiles.js";
import { configHomeFs, notYetTrackerSink, stateHomeFs } from "../src/setup/adapters.js";
import { SetupEngine, type Refusal, type RepoReader } from "../src/setup/engine.js";
import { FindingsStore, type ReportedFinding } from "../src/setup/findings.js";
import { CONCERN_NAMES, type Priority } from "../src/setup/interview.js";
import { factsKey, PORTRAIT_FACTS_FILE, shapeLines, type PortraitFacts, type PortraitFactsFile } from "../src/setup/portrait.js";
import type { RetuneResult } from "../src/setup/retune.js";
import { parseRetunes, RETUNES_FILE, type RetuneRecord } from "../src/setup/retunelog.js";
import { RUN_FILE } from "../src/setup/scanrun.js";
import { SCAN_MEMORY_FILE } from "../src/setup/triage.js";
import { INTERVIEW_FILE } from "../src/setup/tuning.js";
import { requestFile } from "../src/setup/configcommit.js";
import { configDrift, pendingRetunes, type ConfigRead } from "../src/tui/confighome.js";
import { deployLines, RealDeployFetcher, type DeployState } from "../src/tui/deploytab.js";
import { stripAnsi } from "../src/tui/paint.js";
import { TUI_DEFAULTS } from "../src/config.js";
import { renderPortrait, renderRetune } from "../extensions/setup.js";

const sandbox = join(import.meta.dirname, "..");
const fixture: Config = parseConfig(readFileSync(resolve(sandbox, "tests/fixtures/config.toml"), "utf8"));

let dir: string;
let env: InstallEnv;
let now: Date;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "qcr-retune-"));
  env = { HOME: join(dir, "home"), XDG_CONFIG_HOME: join(dir, "xdg-config"), QCR_STATE_HOME: join(dir, "state") };
  now = new Date("2026-09-29T10:00:00Z");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const stateDir = (): string => join(dir, "state");
const home = (): string => configHome(env);

function write(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

const REPO: Record<string, string> = {
  "README.md": "# hi\n",
  "app/views.py": "def v(): pass\n",
  "billing/charge.py": "def charge(): pass\n",
};

const repo: RepoReader = {
  location: "/reviewed-repo",
  listFiles: () => Object.keys(REPO),
  read: (p) => REPO[p] ?? null,
  lines: (p) => (REPO[p] === undefined ? null : REPO[p]!.split("\n").length - 1),
  head: () => "abc123def4567890",
};

function engine(): SetupEngine {
  return new SetupEngine({
    repo,
    state: stateHomeFs(stateDir()),
    config: configHomeFs(join(dir, "config-portrait")),
    profiles: { root: sandbox, env },
    clock: () => now,
    memory: null,
    cases: { run: async () => ({ ok: false, reason: "no cases here" }) },
    tracker: notYetTrackerSink(""),
    github: { get: async () => ({ ok: false, reason: "no network" }) },
  });
}

const SHA = "f".repeat(40);

/** A finished scan run in the state home's run record. */
function finishedScan(id = "scan-20260929T090000Z", sha = SHA, finished = "2026-09-29T09:30:00.000Z"): void {
  const prior = existsSync(join(stateDir(), RUN_FILE))
    ? (JSON.parse(readFileSync(join(stateDir(), RUN_FILE), "utf8")) as { history: unknown[] }).history
    : [];
  write(
    join(stateDir(), RUN_FILE),
    JSON.stringify({
      version: 1,
      current: null,
      history: [
        ...prior,
        { id, mode: "stage1", sha, state: "complete", started_at: "2026-09-29T09:00:00.000Z", finished_at: finished, cases_done: 2, cases: 2, findings: 3, spent_usd: 1.2 },
      ],
    }),
  );
}

function finding(over: Partial<ReportedFinding>): ReportedFinding {
  return {
    fingerprint: over.fingerprint ?? "a".repeat(64),
    unit: "billing",
    path: "billing/charge.py",
    start: 1,
    end: 1,
    lens: "pass-security",
    kind: "authz",
    severity: "P1",
    confidence: 0.8,
    claim: "charge() does not check the caller owns the account",
    evidence: null,
    fix: null,
    detail: null,
    validated: true,
    doubt: null,
    ...over,
  };
}

function scanFindings(): void {
  const store = new FindingsStore(stateHomeFs(stateDir()));
  store.report(
    [
      finding({}),
      finding({ fingerprint: "b".repeat(64), severity: "P2", lens: "pass-concurrency", kind: "race", doubt: { word: "unverifiable", reason: "r" } }),
      finding({ fingerprint: "c".repeat(64), unit: "app", path: "app/views.py", severity: "nit", lens: "pass-scan", kind: "style" }),
    ],
    { run: "scan-20260929T090000Z", sha: SHA, at: "2026-09-29T09:10:00.000Z" },
  );
  write(
    join(stateDir(), SCAN_MEMORY_FILE),
    JSON.stringify({
      version: 1,
      scans: { [SHA]: { run: "scan-20260929T090000Z", patterns: [], hotspots: { billing: { text: "money paths skip ownership checks", at: "2026-09-29T09:40:00.000Z" } } } },
    }),
  );
}

const factsOnDisk = (): PortraitFactsFile => JSON.parse(readFileSync(join(stateDir(), PORTRAIT_FACTS_FILE), "utf8")) as PortraitFactsFile;

// ---- the portrait gains what the scan found -------------------------------------------

describe("the portrait, refreshed after a scan", () => {
  it("carries the last scan, findings by unit and state, and the hotspots — the pre-scan version kept", () => {
    const e = engine();
    const before = e.portraitAssemble();
    if (!before.ok) throw new Error(before.errors.join("; "));
    expect(before.current.facts.scan).toBeNull();

    finishedScan();
    scanFindings();
    const after = e.portraitAssemble();
    if (!after.ok) throw new Error(after.errors.join("; "));
    expect(after.unchanged).toBe(false);
    expect(after.current.key).not.toBe(before.current.key);
    // previous kept: the pre-scan version is what the diff is against
    expect(after.previous?.key).toBe(before.current.key);
    expect(factsOnDisk().previous?.facts.scan).toBeNull();

    const scan = after.current.facts.scan!;
    expect(scan.state).toBe("ok");
    expect(scan.last).toMatchObject({ id: "scan-20260929T090000Z", mode: "stage1", state: "complete" });
    expect(scan.findings).toMatchObject({ open: 3, promoted: 0, dismissed: 0, fixed: 0, doubted: 1, by_severity: { P1: 1, P2: 1, nit: 1 } });
    expect(scan.findings.units.find((u) => u.unit === "billing")).toMatchObject({ open: 2, doubted: 1, open_by: ["P1 pass-security", "P2 pass-concurrency"] });
    expect(scan.hotspots).toEqual([{ unit: "billing", text: "money paths skip ownership checks", sha: SHA, at: "2026-09-29T09:40:00.000Z" }]);

    const scanDiff = after.diff.find((d) => d.section === "scan");
    expect(scanDiff?.added).toEqual(
      expect.arrayContaining([
        `scan scan-20260929T090000Z [stage1, complete] at ${SHA.slice(0, 12)}`,
        "open in billing: P1 pass-security, P2 pass-concurrency",
        "hotspot billing — money paths skip ownership checks",
      ]),
    );
    // individual findings never reach the portrait: no claim, no line
    expect(JSON.stringify(after.current.facts)).not.toContain("does not check the caller");
    expect(JSON.stringify(after.current.facts)).not.toContain("charge.py:1");

    const read = renderPortrait(e.portrait({ diff: true }));
    expect(read).toContain("What the scans found");
    expect(read).toContain("hotspot billing — money paths skip ownership checks");
  });

  it("a narrative written before the scan reads STALE once the facts carry it", () => {
    const e = engine();
    const f = e.portraitAssemble();
    if (!f.ok) throw new Error("assemble");
    expect(e.storePortraitNarrative({ facts_key: f.current.key, narrative: "A small Python app." }).ok).toBe(true);
    finishedScan();
    scanFindings();
    e.portraitAssemble();
    expect(e.portrait().stale).toBe(true);
  });

  it("triage moves the shape: a dismissal takes a severity × lens off the unit's open line", () => {
    finishedScan();
    scanFindings();
    const e = engine();
    const first = e.portraitAssemble();
    if (!first.ok) throw new Error("assemble");
    const store = new FindingsStore(stateHomeFs(stateDir()));
    const saved = store.update("b".repeat(64), (f) => ({ ...f, state: "dismissed" }));
    expect(saved.ok).toBe(true);
    const second = e.portraitAssemble();
    if (!second.ok) throw new Error("assemble");
    expect(second.current.facts.scan!.findings.units.find((u) => u.unit === "billing")).toMatchObject({ open: 1, dismissed: 1, open_by: ["P1 pass-security"] });
    expect(second.current.key).not.toBe(first.current.key);
  });

  it("an unreadable scan record makes the section UNKNOWN, never 'no findings'", () => {
    finishedScan();
    write(join(stateDir(), "scan/findings.json"), "{not json");
    const r = engine().portraitAssemble();
    if (!r.ok) throw new Error("assemble");
    expect(r.current.facts.scan?.state).toBe("unreadable");
    expect(r.current.facts.problems.join("\n")).toMatch(/findings\.json/);
    expect(shapeLines(r.current.facts).scan).toEqual(["scan: UNKNOWN (a scan record is unreadable)"]);
  });

  it("a portrait that never saw a scan keeps the key it had before the scan section existed", () => {
    const r = engine().portraitAssemble();
    if (!r.ok) throw new Error("assemble");
    const legacy = { ...r.current.facts } as Partial<PortraitFacts>;
    delete legacy.scan;
    expect(factsKey(legacy as PortraitFacts)).toBe(r.current.key);
    expect(factsKey({ ...r.current.facts, scan: null })).toBe(r.current.key);
  });
});

// ---- the re-tune ------------------------------------------------------------------------

/** Every concern at `normal`, then the overrides. */
function answers(over: Record<string, Priority> = {}): Record<string, Priority> {
  return { ...Object.fromEntries(CONCERN_NAMES.map((c) => [c, "normal" as Priority])), ...over };
}

function done(r: RetuneResult | Refusal): RetuneResult {
  if (!r.ok) throw new Error(`refused: ${r.errors.join("; ")}`);
  return r;
}

function refusal(r: RetuneResult | Refusal): string {
  if (r.ok) throw new Error("expected a refusal");
  return r.errors.join("\n");
}

/** The config a daemon naming `name` reviews with — wire.ts's overlay. */
function tuned(name: string): Config {
  const cfg = structuredClone(fixture);
  cfg.review.profile = name;
  return applyProfileTuning(cfg, loadProfileLensTuning(sandbox, name, { env }));
}

const file = (filename: string): PrFileEntry => ({ filename, additions: 5, deletions: 0, status: "modified", patch: "+def check(t): return t\n" });
const AUTH = [file("svc/auth/token.py")];
const row = (cfg: Config, lens: string) => buildPassPlan(cfg, AUTH, undefined, NONE_ECOSYSTEM).pass_plan.find((p) => p.lens === lens);

function setUp(e: SetupEngine): void {
  write(join(home(), "config.toml"), `dry_run = true\n\n[review]\nprofile = "acme"\n`);
  const r = e.profileApply({ priorities: answers({ security: "important" }), goals: "a payments API", write: true });
  if (!r.ok) throw new Error(r.errors.join("; "));
}

const REASON = "the scan found 2 open P1/P2 ownership findings in billing, a money path";

describe("the post-scan re-tune", () => {
  it("follows a scan: refused with no finished scan run, or before setup's interview", () => {
    const e = engine();
    setUp(e);
    expect(refusal(e.retune({ priorities: { security: "critical" }, reasons: { security: REASON } }))).toMatch(/no finished scan run yet/);
    finishedScan();
    rmSync(join(stateDir(), INTERVIEW_FILE));
    expect(refusal(e.retune({ priorities: { security: "critical" }, reasons: { security: REASON } }))).toMatch(/no finished setup interview/);
  });

  it("a scan still running is not one to re-tune from", () => {
    const e = engine();
    setUp(e);
    write(
      join(stateDir(), RUN_FILE),
      JSON.stringify({ version: 1, current: { id: "scan-live", mode: "stage1", sha: SHA, state: "running", cases: [], started_at: "x", finished_at: null }, history: [] }),
    );
    expect(refusal(e.retune({ priorities: { security: "critical" }, reasons: { security: REASON } }))).toMatch(/no finished scan run yet/);
  });

  it("every change needs its reason, and every reason its change", () => {
    const e = engine();
    setUp(e);
    finishedScan();
    expect(refusal(e.retune({ priorities: { security: "critical" }, reasons: {} }))).toMatch(/no reason for priority security \(important → critical\)/);
    expect(
      refusal(e.retune({ priorities: { security: "critical" }, reasons: { security: REASON, data: "no change here" } })),
    ).toMatch(/a reason for "data", but nothing about it changes/);
    expect(refusal(e.retune({ priorities: { security: "important" }, reasons: { security: REASON } }))).toMatch(/nothing to re-tune/);
    expect(refusal(e.retune({ priorities: { security: "critical" }, reasons: { security: "x".repeat(501) } }))).toMatch(/over 500 characters/);
    expect(refusal(e.retune({ scan: "scan-nope", priorities: { security: "critical" }, reasons: { security: REASON } }))).toMatch(/not a finished scan run/);
  });

  it("a preview reports and writes nothing — no profile change, no log", () => {
    const e = engine();
    setUp(e);
    finishedScan();
    const profile = readFileSync(join(home(), "profiles/acme/profile.toml"), "utf8");
    const r = done(e.retune({ priorities: { security: "critical" }, reasons: { security: REASON } }));
    expect(r.written).toBe(false);
    expect(r.record).toBeNull();
    expect(r.changes[0]).toMatchObject({ input: "priority security", from: "important", to: "critical", why: REASON });
    expect(readFileSync(join(home(), "profiles/acme/profile.toml"), "utf8")).toBe(profile);
    expect(existsSync(join(stateDir(), RETUNES_FILE))).toBe(false);
    expect(renderRetune(r)).toMatch(/PREVIEW/);
  });

  it("a write re-tunes the profile the daemon resolves, reports what moved and why, logs it and refreshes the portrait", () => {
    const e = engine();
    setUp(e);
    expect(tuned("acme").lenses?.["pass-security"]).toMatchObject({ min_tier: "sol-med", effort: "medium" });
    finishedScan();
    scanFindings();

    const r = done(
      e.retune({
        priorities: { security: "critical" },
        emphasis: { "pass-security": "Ownership checks on every billing entry point." },
        reasons: { security: REASON, "pass-security": "the billing hotspot is missing ownership checks" },
        write: true,
      }),
    );
    expect(r.written).toBe(true);
    // what the daemon now resolves
    const cfg = tuned("acme");
    expect(cfg.lenses?.["pass-security"]).toMatchObject({ min_tier: "sol-high", effort: "high", max_severity: "P0" });
    expect(row(cfg, "pass-security")).toMatchObject({ tier: "sol-high" });

    // the report: each change, its reason, and what it moved — computed, not asserted
    const sec = r.changes.find((c) => c.input === "priority security")!;
    expect(sec.why).toBe(REASON);
    expect(sec.effects).toEqual(
      expect.arrayContaining([
        "pass-security: min_tier sol-med → sol-high",
        "pass-security: effort medium → high",
        "pass-security: max_severity (unset) → P0",
        "pass-bounds: min_tier sol-med → sol-high",
      ]),
    );
    const emph = r.changes.find((c) => c.input === "emphasis pass-security")!;
    expect(emph).toMatchObject({ from: "(unset)", to: "Ownership checks on every billing entry point." });
    expect(emph.effects).toEqual(['pass-security: emphasis (unset) → "Ownership checks on every billing entry point."']);

    // the log
    const log = parseRetunes(readFileSync(join(stateDir(), RETUNES_FILE), "utf8"));
    if (log.state !== "ok") throw new Error("log");
    expect(log.retunes).toHaveLength(1);
    const rec = log.retunes[0]!;
    expect(rec).toMatchObject({
      profile: "acme",
      scan: { run: "scan-20260929T090000Z", sha: SHA, mode: "stage1" },
      files: ["profiles/acme/profile.toml"],
      commit: r.commit!.id,
    });
    // the commit asked for names the re-tune and its scan
    const req = JSON.parse(readFileSync(join(stateDir(), requestFile(r.commit!.id)), "utf8")) as { message: string };
    expect(req.message).toMatch(/re-tune profile acme after scan scan-20260929T090000Z/);

    // the interview record follows, so the next re-tune starts from here
    const interview = JSON.parse(readFileSync(join(stateDir(), INTERVIEW_FILE), "utf8")) as { priorities: Record<string, string> };
    expect(interview.priorities.security).toBe("critical");

    // the portrait was refreshed with the scan
    expect("key" in rec.portrait && rec.portrait.key).toBe(factsOnDisk().current.key);
    expect(factsOnDisk().current.facts.scan?.hotspots[0]?.unit).toBe("billing");

    const text = renderRetune(r);
    expect(text).toContain(`why: ${REASON}`);
    expect(text).toContain("profile changed, not deployed");
  });

  it("a priority change a higher concern already holds moves nothing, and says so", () => {
    const e = engine();
    write(join(home(), "config.toml"), `dry_run = true\n\n[review]\nprofile = "acme"\n`);
    e.profileApply({ priorities: answers({ security: "critical", compliance: "normal" }), goals: "g", write: true });
    finishedScan();
    const r = done(e.retune({ priorities: { compliance: "important" }, reasons: { compliance: "audit-trail findings" }, write: true }));
    const c = r.changes[0]!;
    // pass-security stays critical (security holds it); pass-data-safety moves
    expect(c.effects.some((x) => x.startsWith("pass-security:"))).toBe(false);
    expect(c.effects.some((x) => x.startsWith("pass-data-safety: min_tier"))).toBe(true);
  });

  it("refuses to 'remove' an emphasis the profile only inherits — the report never claims what did not happen", () => {
    const e = engine();
    // A base in the config home carrying an emphasis; acme extends it.
    write(join(home(), "profiles/strict/profile.toml"), `extends = "default"\n\n[lenses.pass-security]\nemphasis = "Inherited words."\n`);
    write(join(home(), "config.toml"), `dry_run = true\n\n[review]\nprofile = "acme"\n`);
    write(join(home(), "profiles/acme/profile.toml"), `extends = "strict"\n`);
    const set = e.profileApply({ priorities: answers({ security: "important" }), goals: "g", write: true });
    if (!set.ok) throw new Error(set.errors.join("; "));
    finishedScan();
    expect(tuned("acme").lenses?.["pass-security"]).toMatchObject({ emphasis: "Inherited words." });
    const profile = readFileSync(join(home(), "profiles/acme/profile.toml"), "utf8");
    expect(
      refusal(e.retune({ emphasis: { "pass-security": null }, reasons: { "pass-security": "scan says so" }, write: true })),
    ).toMatch(/inherited from the profile's base/);
    expect(readFileSync(join(home(), "profiles/acme/profile.toml"), "utf8")).toBe(profile);
    expect(existsSync(join(stateDir(), RETUNES_FILE))).toBe(false);
    // replacement text is a real change
    const r = done(e.retune({ emphasis: { "pass-security": "New words." }, reasons: { "pass-security": "scan says so" }, write: true }));
    expect(r.changes[0]!.effects).toEqual(['pass-security: emphasis "Inherited words." → "New words."']);
  });

  it("refuses to 'drop' a drafted guide the profile only inherits — the report never claims a removal that did not happen", () => {
    const e = engine();
    write(join(home(), "profiles/strict/profile.toml"), `extends = "default"\n\n[lenses.pass-style]\nguide = "style-guide.md"\n`);
    write(join(home(), "profiles/strict/style-guide.md"), "- no abbreviations\n");
    write(join(home(), "config.toml"), `dry_run = true\n\n[review]\nprofile = "acme"\n`);
    write(join(home(), "profiles/acme/profile.toml"), `extends = "strict"\n`);
    const set = e.profileApply({ priorities: answers({ security: "important" }), goals: "g", write: true });
    if (!set.ok) throw new Error(set.errors.join("; "));
    finishedScan();
    expect(tuned("acme").lenses?.["pass-style"]?.guide?.text).toBe("- no abbreviations\n");
    const profile = readFileSync(join(home(), "profiles/acme/profile.toml"), "utf8");
    expect(refusal(e.retune({ drop_style_guide: true, reasons: { style_guide: "scan says so" }, write: true }))).toMatch(
      /inherited from the profile's base/,
    );
    expect(readFileSync(join(home(), "profiles/acme/profile.toml"), "utf8")).toBe(profile);
    expect(existsSync(join(stateDir(), RETUNES_FILE))).toBe(false);
    expect(tuned("acme").lenses?.["pass-style"]?.guide?.text).toBe("- no abbreviations\n");
  });

  it("an emphasis-only re-tune leaves the operator's direct edit of a priority setting alone", () => {
    const e = engine();
    setUp(e);
    finishedScan();
    const path = join(home(), "profiles/acme/profile.toml");
    const text = readFileSync(path, "utf8");
    const edited = text.replace(/(\[lenses\.pass-security\][^[]*?effort = )"medium"/, '$1"high"');
    expect(edited).not.toBe(text);
    write(path, edited); // "Direct edits are his right."
    expect(tuned("acme").lenses?.["pass-security"]).toMatchObject({ effort: "high" });
    const r = done(e.retune({ emphasis: { "pass-concurrency": "Watch the ledger locks." }, reasons: { "pass-concurrency": REASON }, write: true }));
    // Only the emphasis moved — in the profile, the report and the log alike.
    expect(tuned("acme").lenses?.["pass-security"]).toMatchObject({ effort: "high" });
    expect(r.changes.map((c) => c.effects)).toEqual([['pass-concurrency: emphasis (unset) → "Watch the ledger locks."']]);
    expect(r.diff.flatMap((d) => d.lines).filter((l) => /^[-+]/.test(l)).some((l) => l.includes("effort"))).toBe(false);
  });

  it("refuses to write over a re-tune log it cannot read", () => {
    const e = engine();
    setUp(e);
    finishedScan();
    write(join(stateDir(), RETUNES_FILE), "garbage");
    const profile = readFileSync(join(home(), "profiles/acme/profile.toml"), "utf8");
    expect(refusal(e.retune({ priorities: { security: "critical" }, reasons: { security: REASON }, write: true }))).toMatch(/not a re-tune log/);
    expect(readFileSync(join(home(), "profiles/acme/profile.toml"), "utf8")).toBe(profile);
  });
});

// ---- the deploy tab ------------------------------------------------------------------------

const FP_A: ConfigRead = { config: "a".repeat(64), profiles: "b".repeat(64) };
const FP_B: ConfigRead = { config: "a".repeat(64), profiles: "c".repeat(64) };
const FP_C: ConfigRead = { config: "d".repeat(64), profiles: "b".repeat(64) };

function record(at: string, files = ["profiles/acme/profile.toml"]): RetuneRecord {
  return {
    id: `retune-${at}`,
    at,
    profile: "acme",
    scan: { run: "scan-1", sha: SHA, mode: "stage1" },
    changes: [{ input: "priority security", from: "important", to: "critical", why: REASON, effects: [] }],
    files,
    commit: null,
    portrait: { key: "k" },
  };
}

const log = (...r: RetuneRecord[]) => ({ state: "ok" as const, retunes: r });
const DEPLOYED = "2026-09-29T08:00:00Z";

describe("the deploy tab shows the pending re-tune", () => {
  it("pending exactly while the profiles are behind, and only the re-tunes since the last deploy", () => {
    const old = record("2026-09-28T10:00:00.000Z");
    const fresh = record("2026-09-29T09:50:00.000Z");
    expect(pendingRetunes(log(old, fresh), configDrift(FP_B, FP_A), DEPLOYED)).toEqual({ state: "pending", retunes: [fresh] });
    // deployed: the drift is the authority, whatever the log says
    expect(pendingRetunes(log(old, fresh), configDrift(FP_A, FP_A), DEPLOYED)).toEqual({ state: "none" });
    // only config.toml differs: the profile — the re-tune — is on the VM
    expect(pendingRetunes(log(fresh), configDrift(FP_C, FP_A), DEPLOYED)).toEqual({ state: "none" });
    // never shipped: every re-tune that wrote a file
    expect(pendingRetunes(log(old, fresh, record("2026-09-29T09:55:00.000Z", [])), configDrift(FP_A, "none"), DEPLOYED)).toEqual({
      state: "pending",
      retunes: [old, fresh],
    });
  });

  it("honest unknowns: an unread VM end, no deploy time, an unreadable log", () => {
    const fresh = record("2026-09-29T09:50:00.000Z");
    expect(pendingRetunes(log(fresh), configDrift(FP_B, undefined), DEPLOYED)).toMatchObject({ state: "unknown", retunes: [fresh] });
    expect(pendingRetunes(log(fresh), configDrift(FP_B, FP_A), undefined)).toMatchObject({
      state: "unknown",
      why: "when the VM was last deployed is unknown",
      retunes: [fresh],
    });
    expect(pendingRetunes({ state: "unreadable", error: "bad log" }, configDrift(FP_B, FP_A), DEPLOYED)).toEqual({
      state: "unknown",
      why: "bad log",
      retunes: [],
    });
    expect(pendingRetunes({ state: "absent" }, configDrift(FP_B, FP_A), DEPLOYED)).toEqual({ state: "none" });
    // neither the VM end nor the deploy time: the latest re-tune, UNKNOWN — never silence
    expect(pendingRetunes(log(fresh), configDrift(FP_B, undefined), undefined)).toMatchObject({ state: "unknown", retunes: [fresh] });
    // an unparseable deploy time is no deploy time
    expect(pendingRetunes(log(fresh), configDrift(FP_B, FP_A), "not-a-time")).toMatchObject({ state: "unknown", retunes: [fresh] });
  });

  it("compares instants, not strings: a re-tune in the deploy's own second is still pending", () => {
    // The marker is written to the second, a re-tune to the millisecond —
    // as strings "…:00.500Z" < "…:00Z", which read it as shipped.
    const sameSecond = record("2026-09-29T08:00:00.500Z");
    expect(pendingRetunes(log(sameSecond), configDrift(FP_B, FP_A), DEPLOYED)).toEqual({ state: "pending", retunes: [sameSecond] });
    const before = record("2026-09-29T07:59:59.999Z");
    expect(pendingRetunes(log(before), configDrift(FP_B, FP_A), DEPLOYED)).toEqual({ state: "none" });
  });

  it("the tab paints the re-tune, its changes and why, under the CONFIG line", async () => {
    const fresh = record("2026-09-29T09:50:00.000Z");
    const ok = (stdout: string) => ({ ok: true, stdout, stderr: "", code: 0 });
    const ssh = async (_h: string, argv: string[]) => {
      const cmd = argv.join(" ");
      if (cmd.includes("config-fingerprint.sh")) return ok(`config=${"a".repeat(64)} profiles=${"b".repeat(64)}\n`);
      if (cmd.includes("BUILD_SHA")) return ok(`aaa1111 ${DEPLOYED} sync\n`);
      return ok("");
    };
    const f = new RealDeployFetcher(
      TUI_DEFAULTS,
      ssh,
      async (argv) => (argv.join(" ").includes("config-fingerprint.sh") ? ok(`config=${"a".repeat(64)} profiles=${"c".repeat(64)}\n`) : ok("")),
      () => log(fresh),
    );
    const st = { loaded: true, loading: false, scroll: 0, ...(await f.load()) } as DeployState;
    const text = stripAnsi(deployLines(st, 200).join("\n"));
    expect(text).toContain("profile changed, not deployed");
    expect(text).toContain("1 post-scan re-tune not deployed — a sync ships it:");
    expect(text).toContain("after scan scan-1 (acme): priority security important → critical");
    expect(text).toContain(`priority security: important → critical — ${REASON}`);

    const shipped = new RealDeployFetcher(TUI_DEFAULTS, ssh, async (argv) => (argv.join(" ").includes("config-fingerprint.sh") ? ok(`config=${"a".repeat(64)} profiles=${"b".repeat(64)}\n`) : ok("")), () => log(fresh));
    const st2 = { loaded: true, loading: false, scroll: 0, ...(await shipped.load()) } as DeployState;
    expect(stripAnsi(deployLines(st2, 200).join("\n"))).not.toContain("re-tune");
  });
});
