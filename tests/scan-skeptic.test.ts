// The scan SKEPTIC (owner ruling 2026-09-30: "the scan validator is the skeptic,
// on by default"). The self-scan loop put every finding in front of an
// adversarial skeptic before anyone read it; this builds that skeptic INTO the
// scan: the scan's validator, in scan mode, sorts every finding into a
// validity tier — confirmed / likely / doubtful — and never kills one.
//
// Pinned here, at the seams: the `scan-skeptic-validate` addendum (scan mode,
// pass-validate only, the ONE class list, a PR build byte-identical without
// it); the answer's parsing; the engine's assignment of tiers from a fake
// validator (refuted kept doubtful with its class, every kill path — KILLED,
// a low confidence, a candidate never mentioned — doubtful, nothing dropped;
// a failed validator leaves the tier UNKNOWN); the default (on, at the lens's
// tier, its cost in the measured price); the store (the tier survives an exact
// match and a near-duplicate fold; old findings read unknown); promotion
// (confirmed by default, the rest only explicitly); and the extension tools.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PiToolDefinition } from "@earendil-works/pi-coding-agent";
import { scanToolDefinitions } from "../extensions/setup-scan.js";
import { triageToolDefinitions } from "../extensions/setup-triage.js";
import { parseConfig, SCAN_DEFAULTS, type Config, type ScanConfig } from "../src/config.js";
import {
  PASS_ADDENDA,
  SCAN_FALSE_POSITIVE_CLASSES,
  SCAN_MODE_ANCHOR_ADDENDUM,
  SCAN_PRECISION_ADDENDUM,
  SCAN_SKEPTIC_ADDENDUM,
  VALIDATE_PASS,
  addendaForPass,
  buildAgents,
  type PassAddendum,
} from "../src/include.js";
import { configHome, type InstallEnv } from "../src/install.js";
import type { MemoryEntry, MemoryOp, MemoryStore, MemoryWriteResult } from "../src/memory/store.js";
import { stateHomeFs } from "../src/setup/adapters.js";
import type { CaseOutcome, SinkResult, TrackerSink, TrackerTicket } from "../src/setup/engine.js";
import { FindingsStore, type ReportedFinding } from "../src/setup/findings.js";
import { LEDGER_FILE } from "../src/setup/ledger.js";
import { parseValidatorAnswer, SCAN_FALSE_POSITIVE_SLUGS } from "../src/setup/scan.js";
import { buildScanAgents, scanConfig } from "../src/setup/scanbuild.js";
import { validityOf } from "../src/setup/scanreport.js";
import { ScanRunner, UNMENTIONED_REASON, type ScanPorts } from "../src/setup/scanrun.js";
import { ScanTriage } from "../src/setup/triage.js";
import { HEAVY_TIMEOUT_MS } from "./helpers/suite-timeouts.js";

const sandbox = join(import.meta.dirname, "..");
const fixtureToml = readFileSync(resolve(sandbox, "tests/fixtures/config.toml"), "utf8");
const fixture: Config = parseConfig(fixtureToml);

let dir: string;
let env: InstallEnv;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "qcr-scan-skeptic-"));
  env = { HOME: join(dir, "home"), XDG_CONFIG_HOME: join(dir, "xdg-config") };
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function built(out: string): Map<string, string> {
  return new Map(
    readdirSync(out).map((f) => [f.replace(/\.md$/, ""), readFileSync(join(out, f), "utf8")]),
  );
}

// ---- the addendum ------------------------------------------------------------------

describe("the skeptic addendum is a scan-mode registry entry for the validator alone", () => {
  it("binds pass-validate in scan mode, and nothing else, in no PR build", () => {
    const entry = PASS_ADDENDA.find((a) => a.id === "scan-skeptic-validate");
    expect(entry).toMatchObject({
      mode: "scan",
      scope: [VALIDATE_PASS],
      text: SCAN_SKEPTIC_ADDENDUM,
    });
    expect(addendaForPass(VALIDATE_PASS).map((a) => a.id)).not.toContain("scan-skeptic-validate");
    expect(
      addendaForPass(VALIDATE_PASS, PASS_ADDENDA, "django", "scan").map((a) => a.id),
    ).toContain("scan-skeptic-validate");
    for (const lens of ["pass-scan", "pass-security", "pass-baseline"]) {
      expect(
        addendaForPass(lens, PASS_ADDENDA, "django", "scan").map((a) => a.id),
        lens,
      ).not.toContain("scan-skeptic-validate");
    }
  });

  for (const ecosystem of ["django", "none"] as const) {
    it(
      `leaves a PR build byte-identical with and without it (${ecosystem})`,
      { timeout: HEAVY_TIMEOUT_MS },
      () => {
        const pr = (out: string, addenda: readonly PassAddendum[]): Map<string, string> => {
          buildAgents(join(sandbox, "agents"), join(dir, out), {
            root: sandbox,
            tiers: fixture.models.tiers,
            riskPasses: fixture.models.risk_passes,
            validateTier: fixture.models.validate_tier,
            addenda,
            ecosystem,
          });
          return built(join(dir, out));
        };
        const withEntry = pr("with", PASS_ADDENDA);
        const without = pr(
          "without",
          PASS_ADDENDA.filter((a) => a.id !== "scan-skeptic-validate"),
        );
        expect(withEntry.size).toBeGreaterThan(20);
        expect([...withEntry.keys()].sort()).toEqual([...without.keys()].sort());
        for (const [name, body] of withEntry) expect(body, name).toBe(without.get(name));
        for (const [name, body] of withEntry) expect(body, name).not.toContain("Scan skeptic");
      },
    );
  }

  it("the scan build composes it into EVERY tier's validator (the skeptic runs at the lens's tier), before the anchor rule", () => {
    const out = join(dir, "scan-agents");
    buildScanAgents(sandbox, out, fixture, { env });
    const agents = built(out);
    const validators = [...agents.keys()].filter((n) => n.startsWith(`${VALIDATE_PASS}--`)).sort();
    expect(validators).toEqual([
      "pass-validate--sol-high",
      "pass-validate--sol-med",
      "pass-validate--terra-med",
    ]);
    for (const name of validators) {
      const body = agents.get(name)!;
      expect(body, name).toContain(SCAN_SKEPTIC_ADDENDUM);
      expect(body.indexOf(SCAN_SKEPTIC_ADDENDUM), name).toBeLessThan(
        body.indexOf(SCAN_MODE_ANCHOR_ADDENDUM),
      );
    }
    for (const [name, body] of agents)
      if (!name.startsWith(VALIDATE_PASS)) expect(body, name).not.toContain("Scan skeptic");
  });

  it("carries the ONE class list — every class of the lenses' checklist, with its slug", () => {
    expect(SCAN_FALSE_POSITIVE_CLASSES).toHaveLength(10);
    expect(SCAN_FALSE_POSITIVE_SLUGS).toEqual(SCAN_FALSE_POSITIVE_CLASSES.map((c) => c.slug));
    for (const c of SCAN_FALSE_POSITIVE_CLASSES) {
      expect(SCAN_SKEPTIC_ADDENDUM, c.slug).toContain(`\`${c.slug}\` — **${c.name}** — ${c.text}`);
      expect(SCAN_PRECISION_ADDENDUM, c.slug).toContain(`**${c.name}** — ${c.text}`);
    }
  });

  it("demands the refutation reads, the three tiers, and no KILLED block", () => {
    expect(SCAN_SKEPTIC_ADDENDUM).toMatch(/REFUTE/);
    expect(SCAN_SKEPTIC_ADDENDUM).toMatch(/entry point/);
    expect(SCAN_SKEPTIC_ADDENDUM).toMatch(/callers/);
    expect(SCAN_SKEPTIC_ADDENDUM).toContain("`CLAUDE.md`");
    expect(SCAN_SKEPTIC_ADDENDUM).toMatch(/ratified decisions/);
    for (const t of ["confirmed", "likely", "doubtful"])
      expect(SCAN_SKEPTIC_ADDENDUM).toContain(`**${t}**`);
    expect(SCAN_SKEPTIC_ADDENDUM).toContain("validity: confirmed");
    expect(SCAN_SKEPTIC_ADDENDUM).toContain("scenario:");
    expect(SCAN_SKEPTIC_ADDENDUM).toContain("Write no KILLED block");
    // Each frozen kill path is named as a doubt.
    for (const k of ["below the bar", "a duplicate", "a restatement", "a confidence under 0.5"])
      expect(SCAN_SKEPTIC_ADDENDUM).toContain(k);
  });

  // scan-loop: the skeptic vs an outside adversarial check on the 30 findings
  // of self-scan rounds 6–7 — confirmed held 86%, likely 50%. The seven misses
  // each skipped one link; these are the rules that would have failed them
  // (recorded in the scan-and-setup effort's improvement-loop notes).
  it("tightened from its disagreements: confirmed names every link with file:line; likely names its untraced link; the misses' shapes are doubtful", () => {
    const t = SCAN_SKEPTIC_ADDENDUM;
    // confirmed: every link, anchored, and "at most likely" when one is missing.
    for (const link of [
      "the entry point",
      "the concrete input or state",
      "one `path:line` per hop",
      "who observes it",
      "not intended:",
    ])
      expect(t, link).toContain(link);
    expect(t).toContain("If any link is missing, it is at most **likely**");
    expect(t).toContain("a `confirmed` scenario with no `path:line` reference is read as `likely`");
    // the three refutation questions the confirmed misses skipped
    expect(t).toMatch(/same synchronous tick/);
    expect(t).toMatch(/at-least-once/);
    expect(t).toMatch(/every other candidate on the same path/);
    // likely: says which link, and the untraced links that make it doubtful instead.
    expect(t).toContain("untraced: <the link>");
    for (const cls of ["no-consequence", "unreachable", "contrived-concurrency", "same-principal"])
      expect(t, cls).toContain(`\`[${cls}]\``);
    expect(t).toMatch(/operator or by this system's own first-party code/);
    // and still: nothing is dropped.
    expect(t).toContain("It is NOT deleted");
  });

  it("the scan build's validator body carries the tightened rules", () => {
    const out = join(dir, "scan-agents-tight");
    buildScanAgents(sandbox, out, fixture, { env });
    const body = built(out).get(`${VALIDATE_PASS}--${SCAN_DEFAULTS.tier}`)!;
    expect(body).toContain("If any link is missing, it is at most **likely**");
    expect(body).toContain("untraced: <the link>");
  });
});

// ---- reading the answer ----------------------------------------------------------------

describe("parseValidatorAnswer reads tiers, classes and kills", () => {
  const answer = [
    "FINDINGS pass-validate SCAN x @y",
    "- path: app/a.py",
    "  line: 1",
    "  kind: bug",
    "  severity: P1",
    "  validity: confirmed",
    "  scenario: POST /refund at app/views.py:40 with an empty cart → app/a.py:1",
    "  claim: one",
    "- path: app/a.py",
    "  line: 3",
    "  kind: data",
    "  severity: P2",
    "  validity: confirmed",
    "  claim: a confirmed with no scenario written down",
    "- path: app/a.py",
    "  line: 5",
    "  kind: io",
    "  severity: P2",
    "  claim: no validity line at all",
    "",
    "DOUBTED",
    "- pass-scan app/a.py:7 — refuted: [guarded-elsewhere] the gate at src/gate.ts:40 refuses it",
    "- pass-scan app/a.py:8 — unverifiable: [not-a-class] could not open it",
    "KILLED",
    "- pass-scan app/a.py:9 — below-bar",
    "- pass-scan app/a.py:11 — duplicate: merged into app/a.py:1",
  ].join("\n");

  it("a confirmed survivor needs its scenario; anything else that survived is likely", () => {
    const r = parseValidatorAnswer(answer, null);
    expect(r.survivors.map((s) => [s.start, s.validity, s.scenario])).toEqual([
      [1, "confirmed", "POST /refund at app/views.py:40 with an empty cart → app/a.py:1"],
      [3, "likely", null],
      [5, "likely", null],
    ]);
  });

  it("a confirmed scenario with no path:line reference is demoted to likely — the scenario is kept", () => {
    const one = (scenario: string) =>
      parseValidatorAnswer(
        [
          "FINDINGS pass-validate SCAN x @y",
          "- path: app/a.py",
          "  line: 1",
          "  kind: bug",
          "  severity: P2",
          "  validity: confirmed",
          `  scenario: ${scenario}`,
          "  claim: c",
        ].join("\n"),
        null,
      ).survivors[0]!;
    // The shape of the three refuted confirmeds: prose arrows, no anchor.
    const bare =
      "runTui() → app.run(initial) → poller.start() → tick() → SSH starts before the layout is painted";
    expect(one(bare)).toMatchObject({ validity: "likely", scenario: bare });
    expect(one("a request reaches line 250 and it breaks").validity).toBe("likely");
    // Anchored, in any of the usual spellings.
    expect(one("runTui src/tui/index.ts:1177 → app.run src/tui/app.ts:369").validity).toBe(
      "confirmed",
    );
    expect(one("dispatch (`src/dispatch.ts:1470-1472`) → spawnSession").validity).toBe("confirmed");
    expect(one("the webhook in webhook.ts:88 passes the header").validity).toBe("confirmed");
    // Extensionless files are anchored too: a scan reviews any repo.
    expect(one("the build at Dockerfile:12 copies the secret → image layer").validity).toBe(
      "confirmed",
    );
    expect(one("the wrapper scripts/qcr:40 passes argv unquoted").validity).toBe("confirmed");
    // Neither a time, a ratio nor a bare host:port is a path:line.
    expect(one("at 12:30 the job runs; ratio 1.5:1; localhost:8787 answers").validity).toBe(
      "likely",
    );
  });

  it("a doubt names its class only when it is one of the ten; KILLED lines are read in the same shape", () => {
    const r = parseValidatorAnswer(answer, null);
    expect(r.doubted).toEqual([
      {
        path: "app/a.py",
        line: 7,
        word: "refuted",
        reason: "the gate at src/gate.ts:40 refuses it",
        class: "guarded-elsewhere",
      },
      {
        path: "app/a.py",
        line: 8,
        word: "unverifiable",
        reason: "[not-a-class] could not open it",
        class: null,
      },
    ]);
    expect(r.killed).toEqual([
      { path: "app/a.py", line: 9, word: "below-bar", reason: "", class: null },
      {
        path: "app/a.py",
        line: 11,
        word: "duplicate",
        reason: "merged into app/a.py:1",
        class: null,
      },
    ]);
    expect(r.answered).toBe(true);
  });
});

// ---- the engine --------------------------------------------------------------------------

const SHA = "a".repeat(40);
const FILE_A =
  Array.from({ length: 14 }, (_, i) => `line_${i + 1} = compute(${i + 1})`).join("\n") + "\n";
const FILES: Record<string, string> = { "app/a.py": FILE_A, "lib/b.py": "x = 1\ny = 2\n" };

/** Six candidates on app/a.py — distinct kinds and claims, so none folds. */
const LENS_LINES = [1, 3, 5, 7, 9, 11];
const KINDS = ["bug", "data", "io", "security", "contract", "performance"];
const CLAIMS = [
  "refund total goes negative on an empty cart",
  "the export writes a truncated row",
  "a socket stays open after the timeout",
  "the token header is trusted unsigned",
  "the parser accepts a missing version field",
  "the loop re-reads every invoice per item",
];

function lensAnswer(id: string, path: string): string {
  if (path !== "app/a.py") return "NONE\n\nSUGGEST NONE\n";
  const items = LENS_LINES.map((l, i) =>
    [
      `- path: app/a.py`,
      `  line: ${l}`,
      `  kind: ${KINDS[i]}`,
      "  severity: P1",
      "  confidence: 0.8",
      `  claim: ${CLAIMS[i]}`,
      `  evidence: \`line_${l} = compute(${l})\``,
    ].join("\n"),
  );
  return `FINDINGS pass-scan SCAN ${id} @${SHA}\n${items.join("\n")}\n\nSUGGEST NONE\n`;
}

/** The skeptic: 1 confirmed, 3 likely-or-doubted paths, 2 kills, 1 unmentioned. */
function skepticAnswer(id: string): string {
  return [
    `FINDINGS pass-validate SCAN ${id} @${SHA}`,
    "- path: app/a.py",
    "  line: 1",
    "  kind: bug",
    "  severity: P1",
    "  validity: confirmed",
    "  scenario: POST /refund (app/views.py:40) with an empty cart → refund_total() app/b.py:7 → app/a.py:1 goes negative",
    `  claim: ${CLAIMS[0]}`,
    "  evidence: `line_1 = compute(1)`",
    "- path: app/a.py",
    "  line: 3",
    "  kind: data",
    "  severity: P2",
    "  validity: likely",
    "  scenario: the truncation is real; no caller that passes a long row was found",
    `  claim: ${CLAIMS[1]}`,
    "  evidence: `line_3 = compute(3)`",
    "",
    "DOUBTED",
    "- pass-scan app/a.py:5 — refuted: [guarded-elsewhere] the supervisor at src/sup.ts:12 closes it",
    "KILLED",
    "- pass-scan app/a.py:7 — below-bar",
    "- pass-scan app/a.py:9 — unverifiable: confidence 0.3 after audit",
  ].join("\n");
}

interface Call {
  agent: string;
  id: string;
}

function ports(
  opts: {
    scan?: Partial<ScanConfig>;
    validator?: (id: string) => CaseOutcome;
    files?: Record<string, string>;
    lens?: (id: string, path: string) => string;
  } = {},
) {
  const files = opts.files ?? FILES;
  const calls: Call[] = [];
  let tick = 0;
  const state = stateHomeFs(join(dir, "state"));
  const p: ScanPorts = {
    state,
    clock: () => new Date(Date.parse("2026-09-30T10:00:00Z") + 1000 * tick++),
    cases: {
      run: async (spec) => {
        calls.push({ agent: spec.agent, id: spec.id });
        if (spec.agent.startsWith("pass-validate"))
          return (
            opts.validator?.(spec.id) ?? {
              ok: true,
              output: skepticAnswer(spec.id),
              cost_usd: 0.03,
            }
          );
        return {
          ok: true,
          output: (opts.lens ?? lensAnswer)(spec.id, spec.files[0]!),
          cost_usd: 0.01,
        };
      },
    },
    source: {
      location: "/reviewed",
      resolve: (ref) => (ref === "HEAD" ? SHA : null),
      open: (sha) => ({
        ok: true,
        tree: {
          sha,
          root: "/tree",
          files: Object.keys(files).map((path) => ({ path, blob: `b-${path}` })),
          read: (q) => files[q] ?? null,
          lines: (q) => (files[q] === undefined ? null : files[q]!.split("\n").length - 1),
        },
      }),
      list: () => Object.keys(files).map((path) => ({ path, blob: `b-${path}` })),
    },
    savedCut: () => ({
      ok: true,
      cut: {
        units: ["app", "lib"].map((u) => ({ name: u, roots: [u], kind: "directory", note: "" })),
        ignored: [],
      },
    }),
    // The shipped defaults: the skeptic is ON unless a test says otherwise.
    settings: () => ({
      ok: true,
      settings: { scan: { ...SCAN_DEFAULTS, calibration_units: 1, ...opts.scan } },
    }),
    buildAgents: () => ({ ok: true }),
  };
  return { ports: p, calls, state };
}

async function runOnce(s: ScanRunner): Promise<void> {
  const p = await s.preview();
  if (!p.ok) throw new Error(p.errors.join("; "));
  const r = await s.start({ key: p.preview.key });
  if (!r.ok) throw new Error(r.errors.join("; "));
  await s.idle();
}

describe("the engine sorts every finding into a tier and drops none", () => {
  it("default ON: the skeptic runs over each case at the LENS's tier, never raised", async () => {
    expect(SCAN_DEFAULTS.validator).toBe(true);
    const { ports: p, calls } = ports();
    await runOnce(new ScanRunner(p));
    const validatorCalls = calls.filter((c) => c.agent.startsWith("pass-validate"));
    expect(validatorCalls.length).toBeGreaterThan(0);
    expect(new Set(validatorCalls.map((c) => c.agent))).toEqual(
      new Set([`pass-validate--${SCAN_DEFAULTS.tier}`]),
    );
  });

  it("confirmed / likely / doubtful from the answer; refuted kept with its class; KILLED and unmentioned kept doubtful", async () => {
    const { ports: p, state } = ports();
    const s = new ScanRunner(p);
    await runOnce(s);
    const { findings } = new FindingsStore(state).list();
    // All six candidates stored — none killed.
    expect(findings).toHaveLength(6);
    const at = (line: number) => findings.find((f) => f.start === line)!;
    expect(at(1)).toMatchObject({
      validity: "confirmed",
      scenario: expect.stringContaining("POST /refund"),
      doubt: null,
      validated: true,
    });
    expect(at(3)).toMatchObject({
      validity: "likely",
      scenario: expect.stringContaining("no caller"),
      doubt: null,
    });
    expect(at(5)).toMatchObject({
      validity: "doubtful",
      doubt: {
        word: "refuted",
        reason: "the supervisor at src/sup.ts:12 closes it",
        class: "guarded-elsewhere",
      },
    });
    // The frozen validator's kill paths — below the bar, a low confidence — are marks.
    expect(at(7)).toMatchObject({
      validity: "doubtful",
      doubt: { word: "below-bar", class: null },
    });
    expect(at(9)).toMatchObject({
      validity: "doubtful",
      doubt: { word: "unverifiable", reason: "confidence 0.3 after audit" },
    });
    // Never mentioned at all: still kept, doubtful, and says why.
    expect(at(11)).toMatchObject({
      validity: "doubtful",
      doubt: { word: "not-upheld", reason: UNMENTIONED_REASON },
    });
    const app = s.status().run!.cases.find((c) => c.unit === "app")!;
    expect([app.findings, app.confirmed, app.likely, app.doubted]).toEqual([6, 1, 1, 4]);
  });

  it("review fix: one survivor stands for ONE candidate — a duplicate on the same lines is kept doubtful, never dropped, and the upheld one stays confirmed", async () => {
    // Two candidates on line 1 (different kinds → two fingerprints) and one on
    // lines 2-4 of a third kind. The skeptic upholds the bug, doubts a
    // duplicate at line 1, and names a single survivor at line 3 for the io
    // candidate only — so an overlapping survivor must not swallow the rest.
    const item = (line: number, kind: string, claim: string, end?: number) =>
      [
        `- path: app/a.py`,
        `  line: ${line}${end ? `-${end}` : ""}`,
        `  kind: ${kind}`,
        "  severity: P1",
        "  confidence: 0.8",
        `  claim: ${claim}`,
      ].join("\n");
    const lens = (id: string, path: string) =>
      path !== "app/a.py"
        ? "NONE\n\nSUGGEST NONE\n"
        : `FINDINGS pass-scan SCAN ${id} @${SHA}\n${[item(1, "bug", CLAIMS[0]!), item(1, "data", CLAIMS[1]!), item(2, "io", CLAIMS[2]!, 4)].join("\n")}\n\nSUGGEST NONE\n`;
    const answer = (id: string) =>
      [
        `FINDINGS pass-validate SCAN ${id} @${SHA}`,
        "- path: app/a.py",
        "  line: 1",
        "  kind: bug",
        "  severity: P1",
        "  validity: confirmed",
        "  scenario: POST /refund app/views.py:40 → app/a.py:1",
        `  claim: ${CLAIMS[0]}`,
        "",
        "DOUBTED",
        "- pass-scan app/a.py:1 — duplicate: the same defect as the bug at line 1",
      ].join("\n");
    const { ports: p, state } = ports({
      lens,
      validator: (id) => ({ ok: true, output: answer(id), cost_usd: 0.01 }),
    });
    await runOnce(new ScanRunner(p));
    const { findings } = new FindingsStore(state).list();
    expect(findings).toHaveLength(3);
    const byKind = (k: string) => findings.find((f) => f.kind === k)!;
    expect(byKind("bug")).toMatchObject({ validity: "confirmed", doubt: null });
    expect(byKind("data")).toMatchObject({ validity: "doubtful", doubt: { word: "duplicate" } });
    expect(byKind("io")).toMatchObject({ validity: "doubtful", doubt: { word: "not-upheld" } });
  });

  it("scan-loop: a confirmed whose scenario cites no path:line is stored LIKELY, with its scenario — and nothing is dropped", async () => {
    const unanchored =
      "runTui() → app.run(initial) → poller.start() → SSH starts before the layout is painted";
    const answer = (id: string) =>
      skepticAnswer(id).replace(/ {2}scenario: POST \/refund[^\n]*/, `  scenario: ${unanchored}`);
    const { ports: p, state } = ports({
      validator: (id) => ({ ok: true, output: answer(id), cost_usd: 0.01 }),
    });
    const s = new ScanRunner(p);
    await runOnce(s);
    const { findings } = new FindingsStore(state).list();
    expect(findings).toHaveLength(6);
    expect(findings.find((f) => f.start === 1)).toMatchObject({
      validity: "likely",
      scenario: unanchored,
      doubt: null,
    });
    const app = s.status().run!.cases.find((c) => c.unit === "app")!;
    expect([app.findings, app.confirmed, app.likely, app.doubted]).toEqual([6, 0, 2, 4]);
  });

  it("a validator that answers NONE upholds nothing — every candidate is kept doubtful", async () => {
    const { ports: p, state } = ports({
      validator: () => ({ ok: true, output: "NONE\n", cost_usd: 0.01 }),
    });
    await runOnce(new ScanRunner(p));
    const { findings } = new FindingsStore(state).list();
    expect(findings).toHaveLength(6);
    expect(findings.every((f) => f.validity === "doubtful" && f.doubt?.word === "not-upheld")).toBe(
      true,
    );
  });

  it("a failed validator judges nothing: the findings are kept with NO tier — unknown, never guessed", async () => {
    const { ports: p, state } = ports({
      validator: () => ({ ok: true, output: "I could not read the tree.", cost_usd: 0.01 }),
    });
    const s = new ScanRunner(p);
    await runOnce(s);
    const { findings } = new FindingsStore(state).list();
    expect(findings).toHaveLength(6);
    expect(
      findings.every((f) => f.validity === null && !f.validated && validityOf(f) === "unknown"),
    ).toBe(true);
    expect(s.status().run!.problems.some((x) => x.includes("the validator failed"))).toBe(true);
  });

  it("a profile's `validator = false` switches it off: only pass-scan runs, and nothing gets a tier", async () => {
    const { ports: p, calls, state } = ports({ scan: { validator: false } });
    await runOnce(new ScanRunner(p));
    expect(calls.every((c) => c.agent.startsWith("pass-scan"))).toBe(true);
    expect(new FindingsStore(state).list().findings.every((f) => validityOf(f) === "unknown")).toBe(
      true,
    );
  });

  it("the skeptic's cost is part of the price: the ledger records lens + skeptic, and the next preview is priced from it", async () => {
    const { ports: p, state } = ports();
    const s = new ScanRunner(p);
    const cal = await s.preview();
    if (!cal.ok) throw new Error(cal.errors.join("; "));
    expect(cal.preview.mode).toBe("calibration");
    expect(cal.preview.settings).toMatchObject({
      validator: true,
      validate_tier: SCAN_DEFAULTS.tier,
    });
    await runOnce(s);
    const ledger = JSON.parse(readFileSync(join(dir, "state", LEDGER_FILE), "utf8")) as {
      entries: Array<{ path: string; cost_usd: number; validator: boolean }>;
    };
    const a = ledger.entries.find((e) => e.path === "app/a.py")!;
    expect(a.validator).toBe(true);
    expect(a.cost_usd).toBeCloseTo(0.01 + 0.03, 9);
    const next = await s.preview();
    if (!next.ok) throw new Error(next.errors.join("; "));
    expect(next.preview.mode).toBe("stage1");
    expect(next.preview.rate!.usd_per_kline).toBeCloseTo((0.04 / 14) * 1000, 9);
    void state;
  });
});

// ---- the store -----------------------------------------------------------------------------

const FP = (c: string): string => c.repeat(64);
const reported = (fp: string, over: Partial<ReportedFinding> = {}): ReportedFinding => ({
  fingerprint: fp,
  unit: "app",
  path: "app/a.py",
  blob: "b",
  start: 10,
  end: 12,
  lens: "pass-scan",
  kind: "bug",
  severity: "P2",
  confidence: 0.8,
  claim: "refund total goes negative on an empty cart",
  evidence: null,
  fix: null,
  detail: null,
  validated: true,
  doubt: null,
  validity: "likely",
  scenario: null,
  ...over,
});

describe("the findings store keeps the tier", () => {
  it("an exact match takes the latest judgement; a near-duplicate fold keeps the best-supported one", () => {
    const store = new FindingsStore(stateHomeFs(join(dir, "state")));
    store.report(
      [
        reported(FP("a"), {
          validity: "doubtful",
          doubt: { word: "refuted", reason: "r", class: "unreachable" },
        }),
      ],
      { run: "r1", sha: SHA, at: "t1" },
    );
    store.report([reported(FP("a"), { validity: "confirmed", scenario: "s" })], {
      run: "r2",
      sha: SHA,
      at: "t2",
    });
    expect(store.list().findings[0]).toMatchObject({
      validity: "confirmed",
      scenario: "s",
      doubt: null,
    });
    // A second lens's near-duplicate, doubtful, folds in — the confirmed tier stands.
    store.report(
      [
        reported(FP("b"), {
          lens: "pass-security",
          start: 11,
          validity: "doubtful",
          doubt: { word: "refuted", reason: "x", class: null },
        }),
      ],
      { run: "r2", sha: SHA, at: "t3" },
    );
    const [one] = store.list().findings;
    expect(store.list().findings).toHaveLength(1);
    expect(one).toMatchObject({
      fingerprint: FP("a"),
      validity: "confirmed",
      doubt: null,
      aliases: [FP("b")],
    });
  });

  it("review fix: an UNJUDGED re-sighting of the same code keeps the judgement it has (the skeptic off or failed says nothing)", () => {
    const store = new FindingsStore(stateHomeFs(join(dir, "state")));
    store.report([reported(FP("e"), { validity: "confirmed", scenario: "s" })], {
      run: "r1",
      sha: SHA,
      at: "t1",
    });
    store.report([reported(FP("e"), { validated: false, validity: null, scenario: null })], {
      run: "r2",
      sha: SHA,
      at: "t2",
    });
    expect(store.list().findings[0]).toMatchObject({
      validity: "confirmed",
      scenario: "s",
      validated: true,
      seen: 2,
    });
    // A judged one still replaces it — the latest judgement wins.
    store.report(
      [
        reported(FP("e"), {
          validity: "doubtful",
          doubt: { word: "refuted", reason: "r", class: null },
        }),
      ],
      { run: "r3", sha: SHA, at: "t3" },
    );
    expect(store.list().findings[0]).toMatchObject({
      validity: "doubtful",
      doubt: { word: "refuted" },
    });
  });

  it("review fix: a fold's doubt follows the tier it chose — never doubtful with no reason, never confirmed yet flagged", () => {
    const store = new FindingsStore(stateHomeFs(join(dir, "state")));
    // A pre-tier finding (validated, no doubt, no tier) and a doubtful near-duplicate in the same run.
    const { validity: _v, scenario: _s, ...legacy } = reported(FP("f"));
    store.report([legacy as ReportedFinding], { run: "r1", sha: SHA, at: "t1" });
    store.report(
      [
        reported(FP("g"), {
          lens: "pass-security",
          start: 11,
          validity: "doubtful",
          doubt: { word: "refuted", reason: "x", class: "unreachable" },
        }),
      ],
      { run: "r1", sha: SHA, at: "t2" },
    );
    const [one] = store.list().findings;
    expect(store.list().findings).toHaveLength(1);
    expect(one).toMatchObject({
      validity: "doubtful",
      doubt: { word: "refuted", class: "unreachable" },
    });
  });

  it("a finding stored before the tiers reads UNKNOWN, and the filter finds it as such", () => {
    const store = new FindingsStore(stateHomeFs(join(dir, "state")));
    const { validity: _v, scenario: _s, ...legacy } = reported(FP("c"));
    store.report(
      [
        legacy as ReportedFinding,
        reported(FP("d"), { path: "lib/b.py", validity: "confirmed", scenario: "s" }),
      ],
      { run: "r1", sha: SHA, at: "t1" },
    );
    expect(store.list({ validity: "unknown" }).findings.map((f) => f.fingerprint)).toEqual([
      FP("c"),
    ]);
    expect(store.list({ validity: "confirmed" }).findings.map((f) => f.fingerprint)).toEqual([
      FP("d"),
    ]);
  });
});

// ---- promotion and the tools ------------------------------------------------------------------

class Sink implements TrackerSink {
  readonly kind = "tracker";
  filed: TrackerTicket[] = [];
  async file(t: TrackerTicket): Promise<SinkResult> {
    this.filed.push(t);
    return { ok: true, ref: `FT-${800 + this.filed.length}` };
  }
  async close(ref: string): Promise<SinkResult> {
    return { ok: true, ref };
  }
}

class NoMemory implements MemoryStore {
  async read(): Promise<MemoryEntry[]> {
    return [];
  }
  async search(): Promise<MemoryEntry[]> {
    return [];
  }
  async apply(_op: MemoryOp): Promise<MemoryWriteResult> {
    return { ok: true, message: "ok" };
  }
}

function belt() {
  const { ports: p, state } = ports();
  const scan = new ScanRunner(p);
  const findings = new FindingsStore(state);
  const sink = new Sink();
  const triage = new ScanTriage({
    findings,
    state,
    memory: new NoMemory(),
    tracker: sink,
    clock: () => new Date("2026-09-30T10:00:00Z"),
    units: () => ["app", "lib"],
    runs: () => [{ id: "scan-1", sha: SHA, state: "complete" }],
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
  return { defs, scan, findings, sink, triage };
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

describe("promotion defaults to confirmed findings", () => {
  it("a likely, doubtful or unknown finding is refused unless promoted explicitly", async () => {
    const { findings, triage, sink } = belt();
    findings.report(
      [
        reported(FP("1"), { validity: "confirmed", scenario: "s", path: "app/one.py" }),
        reported(FP("2"), { validity: "likely", path: "app/two.py" }),
        reported(FP("3"), {
          validity: "doubtful",
          doubt: { word: "refuted", reason: "r", class: null },
          path: "app/three.py",
        }),
        reported(FP("4"), { validity: null, validated: false, path: "app/four.py" }),
      ],
      { run: "r1", sha: SHA, at: "t" },
    );
    expect(await triage.promote({ fingerprint: FP("1"), effort: "e" })).toMatchObject({ ok: true });
    expect(sink.filed[0]!.body).toContain("- **Validity:** confirmed — s");
    for (const [fp, word] of [
      [FP("2"), "likely"],
      [FP("3"), "doubtful"],
      [FP("4"), "not judged by the skeptic"],
    ] as const) {
      const r = await triage.promote({ fingerprint: fp, effort: "e" });
      expect(r).toMatchObject({ ok: false, errors: [expect.stringContaining(word)] });
      expect(r).toMatchObject({ errors: [expect.stringContaining("`unconfirmed: true`")] });
      expect(
        await triage.promote({ fingerprint: fp, effort: "e", unconfirmed: true }),
      ).toMatchObject({ ok: true });
    }
    expect(sink.filed).toHaveLength(4);
  });
});

describe("the extension tools surface the tier", () => {
  it("scan_status counts per tier; scan_findings groups confirmed first and filters by validity", async () => {
    const { defs, scan } = belt();
    await runOnce(scan);
    expect(await call(defs, "scan_status")).toMatch(
      /6 finding\(s\) \(1 confirmed, 1 likely, 4 doubtful\)/,
    );
    const listed = (await call(defs, "scan_findings")).split("\n");
    expect(listed[0]).toMatch(/app\/a\.py:1 \(app, bug, new, CONFIRMED\)/);
    expect(listed[1]).toMatch(/app\/a\.py:3 \(app, data, new, LIKELY\)/);
    expect(listed.slice(2).every((l) => /DOUBTFUL — /.test(l))).toBe(true);
    expect(listed.join("\n")).toContain("DOUBTFUL — refuted [guarded-elsewhere]");
    const only = await call(defs, "scan_findings", { validity: "likely" });
    expect(only.split("\n")).toHaveLength(1);
    expect(await call(defs, "scan_findings", { validity: "maybe" })).toMatch(/Unknown validity/);
  });

  it("scan_promote refuses an unconfirmed finding, and files it with `unconfirmed: true`", async () => {
    const { defs, findings } = belt();
    findings.report([reported(FP("5"), { validity: "likely" })], { run: "r1", sha: SHA, at: "t" });
    expect(await call(defs, "scan_promote", { fingerprint: FP("5"), effort: "e" })).toMatch(
      /^Promote refused:\n✗ 555555555555 is likely, not confirmed/,
    );
    expect(
      await call(defs, "scan_promote", { fingerprint: FP("5"), effort: "e", unconfirmed: true }),
    ).toBe("555555555555 promoted: filed as FT-801.");
  });
});

describe("the default is on in config, and a profile may switch it off", () => {
  it("config.toml without [scan] runs the skeptic; a profile's `validator = false` wins", () => {
    expect(fixture.scan.validator).toBe(true);
    const p = join(configHome(env), "profiles", "quiet");
    mkdirSync(join(p, "addenda"), { recursive: true });
    writeFileSync(join(p, "profile.toml"), "[scan]\nvalidator = false\n");
    const toml = `${fixtureToml.replace(/^profile = .*$/m, "")}\n`.replace(
      /^\[review\]$/m,
      '[review]\nprofile = "quiet"',
    );
    expect(scanConfig(sandbox, toml, { env }).scan.validator).toBe(false);
  });
});
