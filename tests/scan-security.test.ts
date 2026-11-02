// The scan's security mechanisms (packages/pi-plugin/src/scan/): what a
// security-only scan runs, keeps and stores, at the seams that decide it.
//
//   * `[scan] lenses` bounds stage 1's suggestions and stage 2's rows, the
//     floor's included (stage2.ts `stage2Lenses`, scanrun.ts);
//   * `[scan] kinds` drops a candidate of another kind after parsing,
//     counted (scan.ts `kindKept`) — a security-family lens's findings are
//     kept under a security `kinds` whatever kind they were written as;
//   * `[security] fold` stores a security candidate the skeptic could not
//     settle `needs-review`, its doubt kept as the proof gap — and only a
//     security candidate, and only with fold on (scanrun.ts `doubtTier`);
//   * the chain lens runs per strategy in a scan, and a security floor adds
//     infra and the chain only where the tree has network or IAM resources;
//   * stage 0 drafts a threat model when none exists, into the state home
//     only, and every plan key carries the model's hash.
//
// Engine cases drive a real ScanRunner over a fake case runner and the real
// rooted state port on a temp dir; the trees are maps, except where the test
// is that nothing lands in the scanned tree, which is a real directory.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseConfig, SCAN_DEFAULTS, type Config, type ScanConfig } from "../src/config.js";
import { homeProfileLookup, type InstallEnv } from "../src/install.js";
import { scanFacts } from "../src/setup/scanfacts.js";
import { findingTicket } from "../src/setup/triage.js";
import { matchesFilter } from "../src/tui/scantab.js";
import type { CaseOutcome, CaseSpec } from "@quickchatai/pi-quickreview/src/scan/scanports.js";
import {
  FindingsStore,
  type ReportedFinding,
  type ScanFinding,
} from "@quickchatai/pi-quickreview/src/scan/findings.js";
import {
  kindAllowed,
  kindKept,
  normalizeKind,
  readingCovers,
  stage1LensKey,
  scanCasePrompt,
  type TreeFile,
} from "@quickchatai/pi-quickreview/src/scan/scan.js";
import { scanConfigOf, scanSettings } from "@quickchatai/pi-quickreview/src/scan/scanagents.js";
import { stateHomeFs } from "@quickchatai/pi-quickreview/src/scan/scanfs.js";
import { renderPreview, renderStatus } from "@quickchatai/pi-quickreview/src/scan/scanrender.js";
import {
  findingJson,
  parseScanArgs,
  runScanVerb,
  type ScanVerbDeps,
} from "@quickchatai/pi-quickreview/src/scan/scanverbs.js";
import { isSecurityFinding } from "@quickchatai/pi-quickreview/src/severity.js";
import {
  doubtTier,
  parseThreatModelAnswer,
  ScanRunner,
  THREAT_MODEL_DRAFT_FILE,
  THREAT_MODEL_PASS,
  THREAT_MODEL_RECORD_FILE,
  UNMENTIONED_REASON,
  type ScanPorts,
  type ScanSettings,
  type ScanTree,
} from "@quickchatai/pi-quickreview/src/scan/scanrun.js";
import { treeAt } from "@quickchatai/pi-quickreview/src/scan/scantree.js";
import {
  networkIamInventory,
  planStage2,
  priceStage2Row,
  stage2CasePrompt,
  stage2Lenses,
  type Stage2PlanInput,
  type Stage2RowRequest,
} from "@quickchatai/pi-quickreview/src/scan/stage2.js";
import type { LensTuningMap } from "@quickchatai/pi-quickreview/src/lenstuning.js";
import { CHAIN_PASS, SECURITY_FAMILY } from "@quickchatai/pi-quickreview/src/passes.js";
import { parseThreatModel } from "@quickchatai/pi-quickreview/src/threatmodel.js";

const sandbox = join(import.meta.dirname, "..");
const fixture: Config = parseConfig(
  readFileSync(join(sandbox, "tests/fixtures/config.toml"), "utf8"),
);
const SHA = "a".repeat(40);

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "qcr-scan-security-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

// ---- the rig -------------------------------------------------------------------------

/** Ten numbered lines, so every candidate below anchors. */
const BODY = Array.from({ length: 10 }, (_, i) => `line_${i + 1} = compute(${i + 1})`).join("\n");

const FILES: Record<string, string> = {
  "app/a.py": `${BODY}\n`,
  "api/routes.py": '@app.get("/users/{id}")\ndef user(id):\n    return load(id)\n',
};

const THREAT_MODEL = [
  "## Entry points",
  "",
  "- `api/**` — the public API; every route needs a session.",
  "",
  "## Controls",
  "",
  "- `app/a.py` — the tenant filter on every query.",
  "",
  "## Sinks",
  "",
  "- `lib/**` — raw SQL.",
  "",
].join("\n");

/** A map-backed tree. Each file's blob is fixed by its path, so a test that
 * edits a file's text changes nothing a plan reads but that text. */
function mapTree(files: Record<string, string>): ScanTree {
  return {
    sha: SHA,
    root: "/tree",
    files: Object.keys(files).map((path) => ({ path, blob: `b-${path}` })),
    read: (q) => files[q] ?? null,
    lines: (q) => (files[q] === undefined ? null : files[q]!.split("\n").length - 1),
  };
}

interface Rig {
  ports: ScanPorts;
  specs: CaseSpec[];
  logs: string[];
  state: ReturnType<typeof stateHomeFs>;
  settings: ScanSettings;
}

function rig(
  opts: {
    scan?: Partial<ScanConfig>;
    fold?: boolean;
    lenses?: LensTuningMap;
    profileThreatModel?: string | null;
    files?: Record<string, string>;
    tree?: () => ScanTree;
    lens?: (spec: CaseSpec) => string;
    validator?: (spec: CaseSpec) => string;
    threatModel?: (spec: CaseSpec) => CaseOutcome;
  } = {},
): Rig {
  const files = opts.files ?? FILES;
  const specs: CaseSpec[] = [];
  const logs: string[] = [];
  let tick = 0;
  const state = stateHomeFs(join(dir, "state"));
  const settings: ScanSettings = {
    scan: { ...SCAN_DEFAULTS, calibration_units: 5, ...opts.scan },
    ...(opts.lenses ? { lenses: opts.lenses } : {}),
    riskPasses: [...SECURITY_FAMILY],
    ...(opts.fold !== undefined ? { fold: opts.fold } : {}),
    ...(opts.profileThreatModel !== undefined
      ? { profileThreatModel: opts.profileThreatModel }
      : {}),
  };
  const tree = opts.tree ?? (() => mapTree(files));
  const ports: ScanPorts = {
    state,
    clock: () => new Date(Date.parse("2026-11-02T10:00:00Z") + 1000 * tick++),
    cases: {
      run: async (spec) => {
        specs.push(spec);
        if (spec.agent.startsWith(`${THREAT_MODEL_PASS}--`))
          return (
            opts.threatModel?.(spec) ?? {
              ok: true,
              output: `THREAT MODEL ${spec.id} @${SHA}\n\n${THREAT_MODEL}`,
              cost_usd: 0.2,
            }
          );
        if (spec.agent.startsWith("pass-validate--"))
          return { ok: true, output: opts.validator?.(spec) ?? "NONE", cost_usd: 0.01 };
        return { ok: true, output: opts.lens?.(spec) ?? "NONE\n\nSUGGEST NONE\n", cost_usd: 0.01 };
      },
    },
    source: {
      location: "/reviewed",
      resolve: (ref) => (ref === "HEAD" || ref === SHA ? SHA : null),
      open: () => ({ ok: true, tree: tree() }),
      list: () => tree().files,
    },
    savedCut: () => ({
      ok: true,
      cut: {
        units: ["app", "api", "lib"].map((u) => ({
          name: u,
          roots: [u],
          kind: "directory" as const,
          note: "",
        })),
        ignored: [],
      },
    }),
    settings: () => ({ ok: true, settings }),
    buildAgents: () => ({ ok: true }),
    log: (l) => logs.push(l),
  };
  return { ports, specs, logs, state, settings };
}

async function runStage1(s: ScanRunner): Promise<void> {
  const p = await s.preview();
  if (!p.ok) throw new Error(p.errors.join("; "));
  const r = await s.start({ key: p.preview.key });
  if (!r.ok) throw new Error(r.errors.join("; "));
  await s.idle();
}

/** One finding item of the findings grammar. */
const item = (line: number, kind: string, claim: string): string =>
  [
    "- path: app/a.py",
    `  line: ${line}`,
    `  kind: ${kind}`,
    "  severity: P1",
    "  confidence: 0.8",
    `  claim: ${claim}`,
    `  evidence: \`line_${line} = compute(${line})\``,
  ].join("\n");

const findingsOn = (spec: CaseSpec, items: string[]): string =>
  spec.files.includes("app/a.py")
    ? `FINDINGS pass-scan SCAN ${spec.id} @${SHA}\n${items.join("\n")}\n\nSUGGEST NONE\n`
    : "NONE\n\nSUGGEST NONE\n";

/** A stage-2 plan input over a small tree, every lens priced alike. */
function planInput(over: Partial<Stage2PlanInput> = {}): Stage2PlanInput {
  const paths = ["api/routes.py", "app/a.py", "lib/x.py"];
  return {
    rows: [],
    cut: {
      units: ["api", "app", "lib"].map((u) => ({
        name: u,
        roots: [u],
        kind: "directory" as const,
        note: "",
      })),
      ignored: [],
    },
    files: paths.map((path) => ({ path, blob: `b-${path}` })),
    linesOf: () => 10,
    exclude: [],
    budget: { maxFiles: 30, maxLines: 3000 },
    riskPasses: [...SECURITY_FAMILY],
    defaultTier: "sol-med",
    covered: () => new Set(),
    price: () => ({
      rate: { usd_per_kline: 1, cases: 1, lines: 1000, cost_usd: 1 },
      basis: "measured",
      from: "x",
    }),
    budgetUsd: null,
    ...over,
  };
}

// ---- [scan] lenses ---------------------------------------------------------------------

describe("[scan] lenses is an allowlist for stage 1 and stage 2", () => {
  // MUTATION: drop the `allow` filter from stage2Lenses — this fails.
  it("stage2Lenses keeps only the named lenses the profile leaves on; empty keeps every one", () => {
    expect(stage2Lenses(undefined, ["pass-sec-access", "pass-sec-injection"])).toEqual([
      "pass-sec-access",
      "pass-sec-injection",
    ]);
    expect(
      stage2Lenses({ "pass-sec-access": { enabled: false } }, [
        "pass-sec-access",
        "pass-sec-injection",
      ]),
    ).toEqual(["pass-sec-injection"]);
    expect(stage2Lenses(undefined, [])).toContain("pass-consistency");
  });

  it("stage 1 is offered only the allowed lenses, and a suggestion naming another is dropped", async () => {
    const r = rig({
      scan: { lenses: ["pass-sec-access", "pass-sec-injection"] },
      lens: (spec) =>
        spec.files.includes("app/a.py")
          ? [
              "NONE",
              "",
              "SUGGEST",
              "- lens: pass-sec-access",
              "  files: app/a.py",
              "  reason: the handler reads a record by id with no owner check",
              "- lens: pass-consistency",
              "  files: app/a.py",
              "  reason: compare with its siblings",
            ].join("\n")
          : "NONE\n\nSUGGEST NONE\n",
    });
    const s = new ScanRunner(r.ports);
    await runStage1(s);
    const stage1 = r.specs.filter((x) => x.agent.startsWith("pass-scan--"));
    expect(stage1.length).toBeGreaterThan(0);
    for (const spec of stage1)
      expect(spec.prompt).toContain(
        "Deep lenses you may name in SUGGEST: pass-sec-access, pass-sec-injection.",
      );
    expect(s.suggestions().suggestions.map((x) => x.lens)).toEqual(["pass-sec-access"]);
  });

  it("a scan with no lens left says so to stage 1, never an empty list", () => {
    const prompt = scanCasePrompt(
      { unit: "app", id: "app", part: 1, parts: 1, files: [], lines: 0 },
      { root: "/tree", sha: SHA, caseId: "c" },
      [],
    );
    expect(prompt).toContain("none — this scan runs no deep lens, so write SUGGEST NONE");
  });

  it("stage 2 refuses a row outside the allowlist and floors only allowed lenses", () => {
    const refused = planStage2(
      planInput({
        rows: [{ lens: "pass-consistency", files: ["app/a.py"], reason: "siblings" }],
        allow: ["pass-sec-access"],
      }),
    );
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.errors.join()).toContain("is not in [scan] lenses");
    const floored = planStage2(
      planInput({ floor: ["pass-consistency", "pass-sec-access"], allow: ["pass-sec-access"] }),
    );
    if (!floored.ok) throw new Error(floored.errors.join("; "));
    expect(floored.floor?.lenses).toEqual(["pass-sec-access"]);
    expect(floored.floor?.skipped).toEqual(["pass-consistency"]);
    expect(new Set(floored.rows.map((x) => x.lens))).toEqual(new Set(["pass-sec-access"]));
  });
});

// ---- [scan] kinds ----------------------------------------------------------------------

describe("[scan] kinds drops a candidate of another kind, counted", () => {
  it("kindAllowed: a kind keeps itself and what it prefixes, as stored; empty keeps all", () => {
    expect(kindAllowed("security-sqli", ["security"])).toBe(true);
    expect(kindAllowed("security:sqli", ["security"])).toBe(true);
    expect(kindAllowed("security-sqli", ["security:sqli"])).toBe(true);
    expect(kindAllowed("securityish", ["security"])).toBe(false);
    expect(kindAllowed("bug", ["security", "exploit-chain"])).toBe(false);
    expect(kindAllowed("bug", [])).toBe(true);
  });

  // MUTATION: filter on answer.candidates no more (keep every kind) — this fails.
  it("the engine stores only the kept kind and counts the rest on the case and in the log", async () => {
    const r = rig({
      scan: { kinds: ["security"], validator: false },
      lens: (spec) =>
        findingsOn(spec, [
          item(1, "security:sqli", "Interpolated SQL"),
          item(3, "bug", "Off by one"),
        ]),
    });
    const s = new ScanRunner(r.ports);
    await runStage1(s);
    const { findings } = new FindingsStore(r.state).list();
    expect(findings.map((f) => f.kind)).toEqual(["security-sqli"]);
    const app = s.status().run!.cases.find((c) => c.unit === "app")!;
    expect(app).toMatchObject({ status: "done", findings: 1, off_kind: 1 });
    expect(r.logs.join("\n")).toMatch(/1 candidate\(s\) of a kind outside \[scan\] kinds/);
    expect(renderStatus(s.status())).toContain("Dropped as outside [scan] kinds: 1 candidate(s)");
  });

  // MUTATION: drop the `isSecurityFinding` branch from kindKept — this fails.
  it("kindKept: under a security `kinds`, a security-family lens's finding is kept whatever kind it wrote; a general lens's by its kind", () => {
    const SEC = ["security", "exploit-chain", "partial-chain"];
    for (const kind of ["sqli", "idor", "ssrf", "sec-idor", "vuln-xss", "unclassified"]) {
      expect(kindKept(normalizeKind(kind), "pass-sec-injection", SEC)).toBe(true);
      expect(kindKept(normalizeKind(kind), "pass-security", SEC)).toBe(true);
      expect(kindKept(normalizeKind(kind), "pass-scan", SEC)).toBe(false);
    }
    expect(kindKept("security-sqli", "pass-scan", SEC)).toBe(true);
    // A kinds list that names no security kind keeps by kind alone.
    expect(kindKept("sqli", "pass-sec-injection", ["bug"])).toBe(false);
    expect(kindKept("bug", "pass-scan", ["bug"])).toBe(true);
  });

  // MUTATION: call kindAllowed(cand.kind, kinds) in scanrun's keepKind
  // (no lens) — this fails.
  it("a stage-2 security-family case's findings are stored under a security `kinds`, an off-format or missing kind included", async () => {
    const r = rig({
      scan: { kinds: ["security", "exploit-chain", "partial-chain"], validator: false },
      lens: (spec) =>
        spec.agent.startsWith("pass-sec-injection--")
          ? findingsOn(spec, [
              item(1, "sqli", "Interpolated SQL"),
              item(3, "", "Command built from input"),
            ])
          : findingsOn(spec, [item(5, "bug", "Off by one")]),
    });
    const s = new ScanRunner(r.ports);
    await runStage1(s);
    // Stage 1 is a general lens: its `bug` is dropped, counted.
    expect(new FindingsStore(r.state).list().findings).toEqual([]);
    const p = await s.proposeStage2({
      rows: [{ lens: "pass-sec-injection", files: ["app/a.py"], reason: "raw SQL" }],
    });
    if (!p.ok) throw new Error(p.errors.join("; "));
    const started = await s.startStage2({ key: p.proposal.key });
    if (!started.ok) throw new Error(started.errors.join("; "));
    await s.idle();
    const stored = new FindingsStore(r.state).list({ lens: "pass-sec-injection" }).findings;
    expect(stored.map((f) => f.kind).sort()).toEqual(["sqli", "unclassified"]);
    const run = s.status().run!;
    expect(run.mode).toBe("stage2");
    expect(run.cases[0]).toMatchObject({ status: "done", findings: 2 });
    expect(run.cases[0]!.off_kind ?? 0).toBe(0);
  });
});

// ---- a kinds-filtered stage 1 is its own reading ---------------------------------------

describe("a [scan] kinds-filtered stage 1 is its own coverage and reconcile reading", () => {
  const SEC_KINDS = ["security", "exploit-chain", "partial-chain"];

  it("stage1LensKey/readingCovers: a filtered reading is keyed by its kinds and covers only what it keeps", () => {
    expect(stage1LensKey([])).toBe("pass-scan");
    const key = stage1LensKey(["partial-chain", "Security", "exploit-chain"]);
    expect(key).toBe("pass-scan:kinds=exploit-chain,partial-chain,security");
    expect(stage1LensKey(SEC_KINDS)).toBe(key);
    expect(readingCovers(key, "pass-scan", "security-sqli")).toBe(true);
    expect(readingCovers(key, "pass-scan", "bug")).toBe(false);
    expect(readingCovers("pass-scan", "pass-scan", "bug")).toBe(true);
    expect(readingCovers(key, "pass-sec-access", "security-idor")).toBe(false);
  });

  // MUTATION: drop the stage-1 key mapping from priceStage2Row — this fails.
  it("a filtered stage-1 reading still prices a stage-2 row (extrapolated from stage 1)", () => {
    const row = {
      path: "app/a.py",
      blob: "b",
      lens: stage1LensKey(SEC_KINDS),
      tier: "sol-med",
      effort: "medium",
      validator: false,
      sha: SHA,
      lines: 1000,
      cost_usd: 2,
      run: "r",
      case: "app",
      at: "2026-11-02T10:00:00Z",
    };
    const cfg = { tier: "sol-med", effort: "medium", validator: false, unmeasured_rate_factor: 3 };
    const price = priceStage2Row([row], cfg, "pass-sec-access", "sol-med", "medium");
    expect(price).toMatchObject({ basis: "extrapolated", from: "pass-scan" });
    expect(price!.rate.usd_per_kline).toBeCloseTo(6);
  });

  /** A tree whose app/a.py blob is the version the test sets. */
  function versioned(): { tree: () => ScanTree; bump: () => void } {
    let v = 1;
    return {
      bump: () => v++,
      tree: () => ({
        ...mapTree(FILES),
        files: Object.keys(FILES).map((path) => ({
          path,
          blob: path === "app/a.py" ? `b-${path}-v${v}` : `b-${path}`,
        })),
      }),
    };
  }

  // MUTATION: write stage 1's ledger rows under `pass-scan` whatever
  // `[scan] kinds` (drop `ledgerLens` from the stage-1 jobs) — this fails;
  // so does matching rows to findings by lens alone in findings.reconcile.
  it("a security reading of changed content never settles a general finding it would have dropped; it does settle a security one", async () => {
    const t = versioned();
    let answer = (spec: CaseSpec): string =>
      findingsOn(spec, [
        item(1, "security:sqli", "Interpolated SQL"),
        item(3, "bug", "Off by one"),
      ]);
    const r = rig({ scan: { validator: false }, tree: t.tree, lens: (spec) => answer(spec) });
    const s = new ScanRunner(r.ports);
    await runStage1(s);
    const stateOf = (kind: string) =>
      new FindingsStore(r.state).list().findings.find((f) => f.kind === kind)?.state;
    expect(stateOf("bug")).toBe("new");
    expect(stateOf("security-sqli")).toBe("new");

    t.bump();
    answer = () => "NONE\n\nSUGGEST NONE\n";
    r.settings.scan = { ...r.settings.scan, kinds: SEC_KINDS };
    await runStage1(s);
    expect(stateOf("bug")).toBe("new");
    expect(stateOf("security-sqli")).toBe("fixed");

    // A general reading of the same content does settle it.
    r.settings.scan = { ...r.settings.scan, kinds: [] };
    await runStage1(s);
    expect(stateOf("bug")).toBe("fixed");
  });

  // MUTATION: key stage 1's coverage on `pass-scan` whatever `[scan] kinds`
  // (`s1 = SCAN_PASS` in plan) — this fails.
  it("a security preview after a whole general scan still reads every file, and the reverse", async () => {
    const r = rig({ scan: { validator: false } });
    const s = new ScanRunner(r.ports);
    await runStage1(s);
    const general = await s.preview();
    if (!general.ok) throw new Error(general.errors.join("; "));
    expect(general.preview.cases).toHaveLength(0);

    r.settings.scan = { ...r.settings.scan, kinds: SEC_KINDS };
    const sec = await s.preview();
    if (!sec.ok) throw new Error(sec.errors.join("; "));
    expect(sec.preview.blockers).toEqual([]);
    expect(sec.preview.cases.flatMap((c) => c.files.map((f) => f.path)).sort()).toEqual(
      Object.keys(FILES).sort(),
    );
    await runStage1(s);
    const secAgain = await s.preview();
    if (!secAgain.ok) throw new Error(secAgain.errors.join("; "));
    expect(secAgain.preview.cases).toHaveLength(0);

    // Back to general, after only the security reading moved: still covered.
    r.settings.scan = { ...r.settings.scan, kinds: [] };
    const back = await s.preview();
    if (!back.ok) throw new Error(back.errors.join("; "));
    expect(back.preview.cases).toHaveLength(0);
    const rows = JSON.parse(r.state.read("scan/ledger.json")!) as {
      entries: Array<{ lens: string }>;
    };
    expect(new Set(rows.entries.map((e) => e.lens))).toEqual(
      new Set(["pass-scan", stage1LensKey(SEC_KINDS)]),
    );
  });

  it("a security scan first, then a general one: the general one still reads every file", async () => {
    const r = rig({ scan: { validator: false, kinds: SEC_KINDS } });
    const s = new ScanRunner(r.ports);
    await runStage1(s);
    r.settings.scan = { ...r.settings.scan, kinds: [] };
    const p = await s.preview();
    if (!p.ok) throw new Error(p.errors.join("; "));
    expect(p.preview.blockers).toEqual([]);
    expect(p.preview.cases.flatMap((c) => c.files.map((f) => f.path)).sort()).toEqual(
      Object.keys(FILES).sort(),
    );
  });
});

// ---- needs-review ----------------------------------------------------------------------

describe("[security] fold: a security candidate the skeptic could not settle is needs-review", () => {
  it("a scan candidate is a security candidate by the PR rule (severity.ts isSecurityFinding), its kind normalized", () => {
    // A scan stores kinds through normalizeKind (`security:idor` → `security-idor`).
    expect(isSecurityFinding(normalizeKind("bug"), "pass-sec-access")).toBe(true);
    expect(isSecurityFinding(normalizeKind("bug"), "pass-security")).toBe(true);
    expect(isSecurityFinding(normalizeKind("security:idor"), "pass-scan")).toBe(true);
    expect(isSecurityFinding(normalizeKind("exploit-chain"), "pass-scan")).toBe(true);
    expect(isSecurityFinding(normalizeKind("partial-chain"), "pass-scan")).toBe(true);
    expect(isSecurityFinding(normalizeKind("bug"), "pass-scan")).toBe(false);
    expect(isSecurityFinding(normalizeKind("securityish"), "pass-scan")).toBe(false);
  });

  it("doubtTier: unverifiable, unmentioned or an uncited principal class — only for security, only with fold", () => {
    const sec = { kind: "security-sqli" };
    const unverifiable = { word: "unverifiable", reason: "is the id an int?", class: null };
    const uncited = {
      word: "refuted",
      reason: "only the operator writes it",
      class: "same-principal",
    };
    const cited = {
      word: "refuted",
      reason: "the writer is the deploy script at deploy/seed.py:4",
      class: "same-principal",
    };
    const refuted = {
      word: "refuted",
      reason: "guarded at app/b.py:3",
      class: "guarded-elsewhere",
    };
    expect(doubtTier(sec, "pass-scan", unverifiable, true)).toBe("needs-review");
    expect(doubtTier(sec, "pass-scan", null, true)).toBe("needs-review");
    expect(doubtTier(sec, "pass-scan", uncited, true)).toBe("needs-review");
    expect(doubtTier(sec, "pass-scan", { ...uncited, class: "contrived-concurrency" }, true)).toBe(
      "needs-review",
    );
    expect(doubtTier(sec, "pass-scan", cited, true)).toBe("doubtful");
    expect(doubtTier(sec, "pass-scan", refuted, true)).toBe("doubtful");
    expect(doubtTier({ kind: "bug" }, "pass-scan", unverifiable, true)).toBe("doubtful");
    expect(doubtTier(sec, "pass-scan", unverifiable, false)).toBe("doubtful");
  });

  const LENS = (spec: CaseSpec): string =>
    findingsOn(spec, [
      item(1, "security:sqli", "Interpolated SQL"),
      item(3, "security:idor", "No owner check"),
      item(5, "security:ssrf", "Outbound URL from input"),
      item(7, "security:xss", "Unescaped output"),
      item(9, "bug", "Off by one"),
    ]);
  const SKEPTIC = (spec: CaseSpec): string =>
    [
      `FINDINGS pass-validate SCAN ${spec.id} @${SHA}`,
      "NONE",
      "",
      "DOUBTED",
      "- pass-scan app/a.py:1 — unverifiable: is the id always an integer by this line?",
      "- pass-scan app/a.py:3 — refuted: [same-principal] only the operator writes this record",
      "- pass-scan app/a.py:5 — refuted: [same-principal] the only writer is the seed script at deploy/seed.py:4",
      "- pass-scan app/a.py:9 — unverifiable: cannot tell which callers pass zero",
    ].join("\n");

  async function stored(fold: boolean) {
    const r = rig({ fold, lens: LENS, validator: SKEPTIC });
    const s = new ScanRunner(r.ports);
    await runStage1(s);
    const { findings } = new FindingsStore(r.state).list();
    const at = (line: number) => findings.find((f) => f.start === line)!;
    return { at, findings, s };
  }

  it("fold on: unverifiable, an uncited same-principal and an unmentioned security candidate are needs-review, the doubt kept; a cited class and a non-security one stay doubtful", async () => {
    const { at, findings, s } = await stored(true);
    expect(findings).toHaveLength(5);
    expect(at(1)).toMatchObject({
      validity: "needs-review",
      doubt: { word: "unverifiable", reason: "is the id always an integer by this line?" },
    });
    expect(at(3)).toMatchObject({
      validity: "needs-review",
      doubt: { class: "same-principal" },
    });
    expect(at(5)).toMatchObject({ validity: "doubtful", doubt: { class: "same-principal" } });
    expect(at(7)).toMatchObject({
      validity: "needs-review",
      doubt: { word: "not-upheld", reason: UNMENTIONED_REASON },
    });
    expect(at(9)).toMatchObject({ validity: "doubtful", doubt: { word: "unverifiable" } });
    const app = s.status().run!.cases.find((c) => c.unit === "app")!;
    expect([app.findings, app.needs_review, app.doubted]).toEqual([5, 3, 2]);
    expect(renderStatus(s.status())).toContain("3 needs-review, 2 doubtful");
  });

  // MUTATION: test `f.doubt !== null` in place of `isDoubted(f)` in any one
  // of the store's filter, matchesFilter, findingJson, scanFacts or the
  // ticket's Validated line — this fails.
  it("a needs-review finding is never doubted: not under --doubted, kept by --not-doubted and `valid`, not counted by the portrait, no MAY NOT BE VALID ticket", async () => {
    const r = rig({ fold: true, lens: LENS, validator: SKEPTIC });
    await runStage1(new ScanRunner(r.ports));
    const store = new FindingsStore(r.state);
    const all = store.list().findings;
    const review = all.filter((f) => f.validity === "needs-review");
    const doubtful = all.filter((f) => f.validity === "doubtful");
    expect([review.length, doubtful.length]).toEqual([3, 2]);
    expect(review.every((f) => f.doubt !== null)).toBe(true);
    const lines = (fs: ScanFinding[]) => fs.map((f) => f.start).sort();
    expect(lines(store.list({ doubted: true }).findings)).toEqual(lines(doubtful));
    expect(lines(store.list({ doubted: false }).findings)).toEqual(lines(review));
    expect(review.every((f) => matchesFilter({ doubted: false }, f))).toBe(true);
    expect(review.some((f) => matchesFilter({ doubted: true }, f))).toBe(false);
    expect(review.map((f) => findingJson(f).doubted)).toEqual([false, false, false]);
    expect(doubtful.map((f) => findingJson(f).doubted)).toEqual([true, true]);
    expect(scanFacts(r.state).scan?.findings.doubted).toBe(2);
    for (const f of review) {
      const body = findingTicket(f, "S").body;
      expect(body).not.toContain("MAY NOT BE VALID");
      expect(body).toContain("**Validated:** needs review — a person checks");
    }
    expect(findingTicket(doubtful[0]!, "S").body).toContain("MAY NOT BE VALID");
  });

  // MUTATION: map needs-review regardless of fold (drop `!fold ||` in
  // doubtTier) — this fails.
  it("fold off: every one of them is doubtful, as before", async () => {
    const { findings, s } = await stored(false);
    expect(findings.map((f) => f.validity)).toEqual(Array(5).fill("doubtful"));
    const app = s.status().run!.cases.find((c) => c.unit === "app")!;
    expect(app.needs_review).toBeUndefined();
    expect(app.doubted).toBe(5);
  });

  it("a near-duplicate fold keeps the needs-review sighting's doubt — the proof gap is never cleared", () => {
    const st = new FindingsStore(stateHomeFs(join(dir, "dedup")));
    const base = (fp: string, over: Partial<ReportedFinding>): ReportedFinding => ({
      fingerprint: fp,
      unit: "src",
      path: "src/commands.ts",
      blob: "b1",
      start: 932,
      end: 932,
      lens: "pass-security",
      kind: "security",
      severity: "P2",
      confidence: null,
      claim:
        "Operator authorization is checked on a pathname rather than bound to the command bytes actually read.",
      evidence: null,
      fix: null,
      detail: null,
      validated: true,
      doubt: null,
      ...over,
    });
    const gap = {
      word: "unverifiable",
      reason: "is the directory writable by a tenant?",
      class: null,
    };
    st.report([base("aa".repeat(32), { validity: "needs-review", doubt: gap })], {
      run: "r1",
      sha: "sha-r1",
      at: "2026-11-02T10:00:00Z",
    });
    st.report(
      [
        base("ab".repeat(32), {
          start: 986,
          end: 987,
          lens: "pass-data-safety",
          claim:
            "Operator authority is checked against a pathname rather than the command bytes subsequently read, allowing directory replacement to escalate session commands.",
          validity: "doubtful",
          doubt: { word: "refuted", reason: "only root writes it", class: "same-principal" },
        }),
      ],
      { run: "r1", sha: "sha-r1", at: "2026-11-02T10:00:05Z" },
    );
    const { findings } = st.load();
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ validity: "needs-review", doubt: gap });
  });
});

// ---- the chain lens and the security floor ----------------------------------------------

describe("the exploit-chain lens runs per strategy in a scan", () => {
  const chain = (strategy?: string): Stage2RowRequest => ({
    lens: CHAIN_PASS,
    files: ["api/routes.py"],
    reason: "a session to an admin grant",
    ...(strategy !== undefined ? { strategy } : {}),
  });

  it("a chain row needs forward or backward; no other lens takes a strategy", () => {
    for (const [req, why] of [
      [chain(), "needs a strategy"],
      [chain("delta"), "needs a strategy"],
      [{ ...chain("forward"), lens: "pass-sec-access" }, "takes none"],
    ] as const) {
      const p = planStage2(planInput({ rows: [req] }));
      expect(p.ok).toBe(false);
      if (!p.ok) expect(p.errors.join()).toContain(why);
    }
  });

  // MUTATION: key coverage by the bare lens in planStage2's build — this fails.
  it("each strategy is its own row, covered and priced under its own key", () => {
    const priced: string[] = [];
    const p = planStage2(
      planInput({
        rows: [chain("forward"), chain("backward")],
        covered: (lens) =>
          lens === `${CHAIN_PASS}:forward`
            ? new Set(["api/routes.py\0b-api/routes.py"])
            : new Set(),
        price: (lens) => {
          priced.push(lens);
          return {
            rate: { usd_per_kline: 1, cases: 1, lines: 1000, cost_usd: 1 },
            basis: "measured",
            from: "x",
          };
        },
      }),
    );
    if (!p.ok) throw new Error(p.errors.join("; "));
    expect(p.rows.map((r) => [r.strategy, r.status, r.tier])).toEqual([
      ["forward", "covered", "sol-high"],
      ["backward", "run", "sol-high"],
    ]);
    expect(priced).toEqual([`${CHAIN_PASS}:forward`, `${CHAIN_PASS}:backward`]);
    const prompt = stage2CasePrompt(p.rows[1]!, { root: "/tree", sha: SHA, caseId: "c" });
    expect(prompt).toContain("Strategy: backward — ");
  });
});

describe("a security floor knows its tree", () => {
  it("networkIamInventory reads infrastructure files for network and IAM resources", () => {
    const files: Record<string, string> = {
      "infra/main.tf": 'resource "aws_security_group" "web" {\n  name = "web"\n}\n',
      "k8s/policy.yaml": "apiVersion: networking.k8s.io/v1\nkind: NetworkPolicy\n",
      "docker-compose.yml": 'services:\n  web:\n    ports:\n      - "80:80"\n',
      "config/app.yaml": "debug: false\n",
      "app/a.py": "x = 1\n",
    };
    const inv = networkIamInventory(Object.keys(files), (p) => files[p] ?? null);
    expect(inv.found).toEqual([
      "docker-compose.yml: a compose service publishing a port",
      "infra/main.tf: Terraform aws_security_group",
      "k8s/policy.yaml: Kubernetes NetworkPolicy",
    ]);
    expect(inv.capped).toBe(false);
    expect(networkIamInventory(Object.keys(files), (p) => files[p] ?? null, 1).capped).toBe(true);
  });

  // MUTATION: add SECURITY_FLOOR_ADDS without checking `because` — this fails.
  it("infra and the chain's forward and backward rows join a security floor only with network or IAM resources", () => {
    const bare = planStage2(planInput({ floor: ["pass-sec-access"] }));
    if (!bare.ok) throw new Error(bare.errors.join("; "));
    expect(bare.floor?.lenses).toEqual(["pass-sec-access"]);
    expect(bare.floor?.added).toBeUndefined();
    const infra = planStage2(
      planInput({ floor: ["pass-sec-access"], networkIam: ["infra/main.tf: Terraform aws_vpc"] }),
    );
    if (!infra.ok) throw new Error(infra.errors.join("; "));
    expect(infra.floor?.lenses).toEqual([
      "pass-sec-access",
      "pass-sec-infra",
      `${CHAIN_PASS}:forward`,
      `${CHAIN_PASS}:backward`,
    ]);
    expect(infra.floor?.added?.lenses).toEqual(["pass-sec-infra", CHAIN_PASS]);
    expect(infra.rows.filter((r) => r.lens === CHAIN_PASS).map((r) => r.strategy)).toContain(
      "backward",
    );
    // A floor with no family lens is no security floor.
    const quality = planStage2(
      planInput({ floor: ["pass-consistency"], networkIam: ["infra/main.tf: Terraform aws_vpc"] }),
    );
    if (!quality.ok) throw new Error(quality.errors.join("; "));
    expect(quality.floor?.lenses).toEqual(["pass-consistency"]);
  });

  it("a threat model's entry-point files run first within a floor lens", () => {
    const plain = planStage2(planInput({ floor: ["pass-sec-access"] }));
    const ranked = planStage2(
      planInput({ floor: ["pass-sec-access"], entryPoint: (p) => p.startsWith("lib/") }),
    );
    if (!plain.ok || !ranked.ok) throw new Error("plan refused");
    expect(plain.rows[0]!.files[0]!.path).toBe("api/routes.py");
    expect(ranked.rows.map((r) => [r.id, r.files[0]!.path])).toEqual([
      ["floor-1", "lib/x.py"],
      ["floor-2", "api/routes.py"],
      ["floor-3", "app/a.py"],
    ]);
  });

  it("a family row quotes the threat model's controls; another lens's row and no model quote nothing", () => {
    const p = planStage2(
      planInput({
        rows: [
          { lens: "pass-sec-access", files: ["app/a.py"], reason: "owner check" },
          { lens: "pass-consistency", files: ["app/a.py"], reason: "siblings" },
        ],
      }),
    );
    if (!p.ok) throw new Error(p.errors.join("; "));
    const tm = parseThreatModel(THREAT_MODEL, "profile");
    const ctx = { root: "/tree", sha: SHA, caseId: "c" };
    const sec = stage2CasePrompt(p.rows[0]!, ctx, undefined, [], tm);
    expect(sec).toContain("## Threat model");
    expect(sec).toContain("the tenant filter on every query");
    expect(sec).not.toContain("the public API");
    expect(stage2CasePrompt(p.rows[1]!, ctx, undefined, [], tm)).not.toContain("## Threat model");
    expect(stage2CasePrompt(p.rows[0]!, ctx)).not.toContain("## Threat model");
  });
});

// ---- the threat model in the plan ------------------------------------------------------

describe("the threat model's hash is part of every plan key", () => {
  const withModel = (text: string | null): Record<string, string> =>
    text === null ? FILES : { ...FILES, ".qcr/threat-model.md": text };

  // MUTATION: drop `...modelKey(threatModel)` from the stage-1 planKey — this fails.
  it("editing the repository's model, or the profile's, re-keys stage 1", async () => {
    const keyOf = async (files: Record<string, string>, profile: string | null = null) => {
      const r = rig({ files, profileThreatModel: profile });
      const p = await new ScanRunner(r.ports).preview();
      if (!p.ok) throw new Error(p.errors.join("; "));
      return p.preview;
    };
    const none = await keyOf(withModel(null));
    const a = await keyOf(withModel(THREAT_MODEL));
    const b = await keyOf(withModel(`${THREAT_MODEL}\n- \`lib/db.py\` — more raw SQL.\n`));
    expect(none.threat_model).toBeUndefined();
    expect(a.threat_model?.source).toBe("repo");
    expect(new Set([none.key, a.key, b.key]).size).toBe(3);
    // The repository's model wins over the profile's.
    const both = await keyOf(withModel(THREAT_MODEL), "## Controls\n\n- `x` — y\n");
    expect(both.key).toBe(a.key);
    const profileOnly = await keyOf(withModel(null), THREAT_MODEL);
    expect(profileOnly.threat_model?.source).toBe("profile");
    expect(profileOnly.key).not.toBe(none.key);
  });

  it("a stage-1 case quotes only the model's entries that name its files", async () => {
    const r = rig({ files: withModel(THREAT_MODEL) });
    await runStage1(new ScanRunner(r.ports));
    const app = r.specs.find(
      (x) => x.agent.startsWith("pass-scan--") && x.files.includes("app/a.py"),
    )!;
    expect(app.prompt).toContain("the tenant filter on every query");
    expect(app.prompt).not.toContain("raw SQL");
    expect(app.prompt).toContain("never proof that a control is in force");
  });
});

// ---- stage 0 ------------------------------------------------------------------------------

const AUTO = { threat_model: "auto" } as const;

describe("stage 0 drafts the threat model when none exists", () => {
  it("is refused when the repository's or the profile's model exists (auto), and when off", async () => {
    for (const r of [
      rig({ scan: AUTO, files: { ...FILES, ".qcr/threat-model.md": THREAT_MODEL } }),
      rig({ scan: AUTO, profileThreatModel: THREAT_MODEL }),
      rig({ scan: { threat_model: "off" } }),
      // off is the default
      rig(),
    ]) {
      const s = new ScanRunner(r.ports);
      const p = await s.proposeThreatModel();
      if (!p.ok) throw new Error(p.errors.join("; "));
      expect(p.preview.blockers).toHaveLength(1);
      const started = await s.startThreatModel({ key: p.preview.key });
      expect(started.ok).toBe(false);
      expect(r.specs).toHaveLength(0);
    }
  });

  // MUTATION: write the draft through `tree` (or under tree.root) instead of
  // the state port — this fails.
  it("runs when absent: one case of its lens over the route inventory; the draft lands in the state home and never in the scanned tree", async () => {
    const root = join(dir, "tree");
    for (const [p, text] of Object.entries(FILES)) {
      mkdirSync(join(root, dirname(p)), { recursive: true });
      writeFileSync(join(root, p), text);
    }
    const listed: TreeFile[] = Object.keys(FILES).map((path) => ({ path, blob: `b-${path}` }));
    const walk = (d: string): string[] =>
      readdirSync(d, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? walk(join(d, e.name)) : [relative(root, join(d, e.name))],
      );
    const before = walk(root).sort();
    const r = rig({ scan: AUTO, tree: () => treeAt(SHA, root, listed) });
    const s = new ScanRunner(r.ports);
    const p = await s.proposeThreatModel();
    if (!p.ok) throw new Error(p.errors.join("; "));
    expect(p.preview).toMatchObject({ mode: "threat-model", blockers: [], existing: null });
    expect(p.preview.estimate_usd).toBeNull();
    expect(p.preview.cap_usd).toBe(SCAN_DEFAULTS.calibration_max_usd);
    expect(p.preview.inventory).toContain("api/routes.py");
    const started = await s.startThreatModel({ key: p.preview.key });
    if (!started.ok) throw new Error(started.errors.join("; "));
    await s.idle();
    expect(r.specs.map((x) => x.agent)).toEqual([`${THREAT_MODEL_PASS}--${SCAN_DEFAULTS.tier}`]);
    expect(r.specs[0]!.prompt).toContain("/users/{id}");
    // A scan has no PR: the inventory is worded for the tree.
    expect(r.specs[0]!.prompt).toContain("route-like file(s) read from the tree");
    expect(r.specs[0]!.prompt).not.toContain("A route the PR adds");
    const draft = r.state.read(THREAT_MODEL_DRAFT_FILE)!;
    expect(draft).toContain("DRAFT threat model");
    expect(draft).toContain("the tenant filter on every query");
    const record = JSON.parse(r.state.read(THREAT_MODEL_RECORD_FILE)!) as Record<string, unknown>;
    expect(record).toMatchObject({
      sha: SHA,
      source: "draft",
      hash: parseThreatModel(draft, "draft").hash,
    });
    expect(walk(root).sort()).toEqual(before);
    const status = s.status();
    expect(status.run).toMatchObject({ mode: "threat-model", state: "complete" });
    expect(renderStatus(status)).toContain(`DRAFT written to ${THREAT_MODEL_DRAFT_FILE}`);
    // A threat-model run owes no reconcile: the next empty plan is not one.
    expect(status.run!.matching).toBeNull();
  });

  it("the draft then feeds the next stage-1 run, labelled DRAFT, and re-keys it", async () => {
    const r = rig({ scan: AUTO });
    const s = new ScanRunner(r.ports);
    const before = await s.preview();
    if (!before.ok) throw new Error(before.errors.join("; "));
    const p = await s.proposeThreatModel();
    if (!p.ok) throw new Error(p.errors.join("; "));
    await s.startThreatModel({ key: p.preview.key });
    await s.idle();
    const after = await s.preview();
    if (!after.ok) throw new Error(after.errors.join("; "));
    expect(after.preview.threat_model?.source).toBe("draft");
    expect(after.preview.key).not.toBe(before.preview.key);
    const r2 = await s.start({ key: after.preview.key });
    if (!r2.ok) throw new Error(r2.errors.join("; "));
    await s.idle();
    const app = r.specs.find(
      (x) => x.agent.startsWith("pass-scan--") && x.files.includes("app/a.py"),
    )!;
    expect(app.prompt).toContain("DRAFT threat model");
    expect(app.prompt).toContain("the tenant filter on every query");
  });

  it("always: revises an existing model, which its task quotes", async () => {
    const r = rig({ scan: { threat_model: "always" }, profileThreatModel: THREAT_MODEL });
    const s = new ScanRunner(r.ports);
    const p = await s.proposeThreatModel();
    if (!p.ok) throw new Error(p.errors.join("; "));
    expect(p.preview.blockers).toEqual([]);
    expect(p.preview.existing?.source).toBe("profile");
    await s.startThreatModel({ key: p.preview.key });
    await s.idle();
    expect(r.specs[0]!.prompt).toContain("The current model, to revise");
  });

  it("an answer with no model writes no draft and fails the case", async () => {
    const r = rig({
      scan: AUTO,
      threatModel: () => ({ ok: true, output: "I could not read the tree.", cost_usd: 0.1 }),
    });
    const s = new ScanRunner(r.ports);
    const p = await s.proposeThreatModel();
    if (!p.ok) throw new Error(p.errors.join("; "));
    await s.startThreatModel({ key: p.preview.key });
    await s.idle();
    expect(r.state.read(THREAT_MODEL_DRAFT_FILE)).toBeNull();
    expect(s.status().run!.cases[0]).toMatchObject({ status: "failed" });
    expect(parseThreatModelAnswer("THREAT MODEL x\n\n## Notes\n- nothing\n").ok).toBe(false);
    expect(
      parseThreatModelAnswer("THREAT MODEL x\n```markdown\n## Sinks\n- `lib/**` — SQL\n```\n"),
    ).toEqual({ ok: true, text: "## Sinks\n- `lib/**` — SQL\n" });
  });
});

describe("stage 0 is part of the scan: a preview offers it first, a stage-1 start waits for it", () => {
  // MUTATION: drop `preview.threat_model_stage = stage0` from plan() — the
  // stage-1 start goes ahead with no threat model, and this fails.
  // MUTATION: drop the isThreatModelKey route from start() — stage 0's key
  // is refused as a changed plan, and this fails.
  it("auto, nothing to read from: the preview carries stage 0, its key starts it, then stage 1 reads the DRAFT", async () => {
    const r = rig({ scan: AUTO });
    const s = new ScanRunner(r.ports);
    const p = await s.preview();
    if (!p.ok) throw new Error(p.errors.join("; "));
    const stage0 = p.preview.threat_model_stage;
    expect(stage0).toMatchObject({ mode: "threat-model", blockers: [], sha: SHA });
    expect(p.preview.blockers).toEqual([]);
    const text = renderPreview(p.preview);
    expect(text).toContain("FIRST, before this scan reads anything: the threat model");
    expect(text).toContain(`scan_start with key ${stage0!.key} and sha ${SHA}`);
    expect(text).not.toContain(`scan_start with key ${p.preview.key}`);
    // The stage-1 key is refused while stage 0 is due, naming it.
    const early = await s.start({ key: p.preview.key });
    expect(early.ok).toBe(false);
    expect(!early.ok && early.errors.join(" ")).toContain(`start it with key ${stage0!.key}`);
    expect(r.specs).toHaveLength(0);
    // Stage 0's key, through the ordinary start.
    const s0 = await s.start({ key: stage0!.key });
    if (!s0.ok) throw new Error(s0.errors.join("; "));
    expect(s0.run.mode).toBe("threat-model");
    await s.idle();
    expect(r.specs.map((x) => x.agent)).toEqual([`${THREAT_MODEL_PASS}--${SCAN_DEFAULTS.tier}`]);
    expect(r.state.read(THREAT_MODEL_DRAFT_FILE)).toContain("DRAFT threat model");
    // MUTATION: drop `draft` from the stage-0 planKey — this fails. Its key
    // is spent: a retried start never pays for stage 0 again.
    for (const retry of [
      () => s.start({ key: stage0!.key }),
      () => s.startThreatModel({ key: stage0!.key }),
    ]) {
      const twice = await retry();
      expect(twice.ok).toBe(false);
      expect(!twice.ok && twice.errors.join(" ")).toMatch(/changed/);
    }
    expect(r.specs).toHaveLength(1);
    // Then the scan itself, over the draft.
    const again = await s.preview();
    if (!again.ok) throw new Error(again.errors.join("; "));
    expect(again.preview.threat_model_stage).toBeUndefined();
    expect(again.preview.threat_model?.source).toBe("draft");
    const s1 = await s.start({ key: again.preview.key });
    if (!s1.ok) throw new Error(s1.errors.join("; "));
    await s.idle();
    const app = r.specs.find(
      (x) => x.agent.startsWith("pass-scan--") && x.files.includes("app/a.py"),
    )!;
    expect(app.prompt).toContain("DRAFT threat model");
  });

  it("off (the default), or a model in the repository or the profile under auto: no stage 0, the scan starts as before", async () => {
    for (const make of [
      () => rig(),
      () => rig({ scan: AUTO, files: { ...FILES, ".qcr/threat-model.md": THREAT_MODEL } }),
      () => rig({ scan: AUTO, profileThreatModel: THREAT_MODEL }),
    ]) {
      // each from an empty state home: the last one's ledger covers every file
      rmSync(join(dir, "state"), { recursive: true, force: true });
      const r = make();
      const s = new ScanRunner(r.ports);
      const p = await s.preview();
      if (!p.ok) throw new Error(p.errors.join("; "));
      expect(p.preview.threat_model_stage).toBeUndefined();
      expect(renderPreview(p.preview)).not.toContain("FIRST, before this scan");
      await runStage1(s);
      expect(r.specs.some((x) => x.agent.startsWith(`${THREAT_MODEL_PASS}--`))).toBe(false);
      expect(r.state.read(THREAT_MODEL_DRAFT_FILE)).toBeNull();
    }
  });

  it("always: due once per scanned sha — a draft written at this sha satisfies it, one from another does not", async () => {
    const r = rig({ scan: { threat_model: "always" }, profileThreatModel: THREAT_MODEL });
    const s = new ScanRunner(r.ports);
    const p = await s.preview();
    if (!p.ok) throw new Error(p.errors.join("; "));
    expect(p.preview.threat_model_stage?.existing?.source).toBe("profile");
    r.state.write(THREAT_MODEL_RECORD_FILE, JSON.stringify({ version: 1, sha: "b".repeat(40) }));
    const other = await s.preview();
    if (!other.ok) throw new Error(other.errors.join("; "));
    expect(other.preview.threat_model_stage).toBeDefined();
    await s.start({ key: other.preview.threat_model_stage!.key });
    await s.idle();
    const after = await s.preview();
    if (!after.ok) throw new Error(after.errors.join("; "));
    expect(after.preview.threat_model_stage).toBeUndefined();
    // Under always the profile's model is still the one the cases read.
    expect(after.preview.threat_model?.source).toBe("profile");
  });

  // MUTATION: render the "it then reads the DRAFT" sentence whatever
  // `stage0.existing` — this fails.
  it("always, with the repository's model: the preview never says the scan reads the DRAFT, and stage 1 keeps reading the repository's", async () => {
    const r = rig({
      scan: { threat_model: "always" },
      files: { ...FILES, ".qcr/threat-model.md": THREAT_MODEL },
    });
    const s = new ScanRunner(r.ports);
    const p = await s.preview();
    if (!p.ok) throw new Error(p.errors.join("; "));
    expect(p.preview.threat_model?.source).toBe("repo");
    expect(p.preview.threat_model_stage?.existing?.source).toBe("repo");
    const text = renderPreview(p.preview);
    expect(text).not.toContain("reads the DRAFT");
    expect(text).not.toContain("Later scans read it");
    expect(text).toContain(
      "its draft is a revision for a person to read and adopt: this scan, like every scan while the repository's .qcr/threat-model.md exists, keeps reading that model",
    );
    expect(text).toContain("scans keep reading that model");
    await s.start({ key: p.preview.threat_model_stage!.key });
    await s.idle();
    const after = await s.preview();
    if (!after.ok) throw new Error(after.errors.join("; "));
    expect(after.preview.threat_model_stage).toBeUndefined();
    expect(after.preview.threat_model?.source).toBe("repo");
  });

  // MUTATION: drop the `problem !== null` blocker from planThreatModelFrom —
  // this fails (stage 0 becomes due and says the model does not exist).
  it("auto, the repository's model present but unreadable: a blocker names the reason, no stage 0, no draft read in its place", async () => {
    const files: Record<string, string> = { ...FILES, ".qcr/threat-model.md": "x" };
    const tree = (): ScanTree => ({
      ...mapTree(files),
      read: (q) => (q === ".qcr/threat-model.md" ? null : (files[q] ?? null)),
      whyUnreadable: (q) => (q === ".qcr/threat-model.md" ? "too-big" : null),
    });
    const r = rig({ scan: AUTO, tree });
    // A stale draft from before the repository had a model is never read.
    r.state.write(THREAT_MODEL_DRAFT_FILE, `${THREAT_MODEL}`);
    const s = new ScanRunner(r.ports);
    const p = await s.preview();
    if (!p.ok) throw new Error(p.errors.join("; "));
    expect(p.preview.threat_model_stage).toBeUndefined();
    expect(p.preview.threat_model).toBeUndefined();
    expect(p.preview.threat_model_problem).toBe("too-big");
    const text = renderPreview(p.preview);
    expect(text).toContain(
      "The repository's .qcr/threat-model.md is present but cannot be read (too-big)",
    );
    expect(text).not.toContain("neither the repository's");
    const tm = await s.proposeThreatModel();
    if (!tm.ok) throw new Error(tm.errors.join("; "));
    expect(tm.preview.blockers).toEqual([
      'the repository\'s .qcr/threat-model.md is present but cannot be read (too-big) — fix it, or set threat_model = "always" to draft one anyway',
    ]);
    expect(r.logs.join("\n")).toContain("present but cannot be read (too-big)");
  });

  it("a stage 0 that wrote no draft leaves it due: the scan still does not start without it", async () => {
    const r = rig({
      scan: AUTO,
      threatModel: () => ({ ok: true, output: "nothing", cost_usd: 0.1 }),
    });
    const s = new ScanRunner(r.ports);
    const p = await s.preview();
    if (!p.ok) throw new Error(p.errors.join("; "));
    await s.start({ key: p.preview.threat_model_stage!.key });
    await s.idle();
    const again = await s.preview();
    if (!again.ok) throw new Error(again.errors.join("; "));
    expect(again.preview.threat_model_stage).toBeDefined();
    expect((await s.start({ key: again.preview.key })).ok).toBe(false);
  });

  it("qcr scan: preview's start is stage 0's key; threat-model propose and start --foreground run it", async () => {
    const r = rig({ scan: AUTO });
    const s = new ScanRunner(r.ports);
    const out: string[] = [];
    const deps: ScanVerbDeps = {
      scan: s,
      findings: new FindingsStore(r.state),
      settingsOf: () => r.settings,
      triage: null,
      afterMatch: null,
      home: join(dir, "state"),
      driverLog: join(dir, "driver.log"),
      out: (l) => out.push(l),
      detach: async () => ({ ok: false, errors: ["no detach here"] }),
      sleep: async () => {},
      now: () => 0,
    };
    expect(parseScanArgs(["threat-model", "propose", "--sha", "HEAD"])).toEqual({
      verb: "threat-model-propose",
      sha: "HEAD",
    });
    expect(() => parseScanArgs(["threat-model", "start"])).toThrow(/needs --key/);
    expect(await runScanVerb(["preview"], true, deps)).toBe(0);
    const pv = JSON.parse(out.pop()!) as {
      start: string[];
      preview: { threat_model_stage: { key: string } };
    };
    expect(pv.start).toEqual(["--key", pv.preview.threat_model_stage.key, "--sha", SHA]);
    expect(await runScanVerb(["threat-model", "propose"], false, deps)).toBe(0);
    const human = out.pop()!;
    expect(human).toContain("THREAT MODEL (stage 0)");
    expect(human).toContain(
      `qcr scan threat-model start --key ${pv.preview.threat_model_stage.key} --sha ${SHA}`,
    );
    expect(await runScanVerb(["threat-model", "propose"], true, deps)).toBe(0);
    const proposal = JSON.parse(out.pop()!) as { start: string[] };
    expect(proposal.start).toEqual(["--key", pv.preview.threat_model_stage.key, "--sha", SHA]);
    expect(
      await runScanVerb(
        ["threat-model", "start", "--key", pv.preview.threat_model_stage.key, "--foreground"],
        true,
        deps,
      ),
    ).toBe(0);
    expect(r.state.read(THREAT_MODEL_DRAFT_FILE)).toContain("DRAFT threat model");
    expect(JSON.parse(out.pop()!)).toMatchObject({ ok: true, run: { mode: "threat-model" } });
  });
});

// ---- the security profile's scan settings -----------------------------------------------

describe("the security profile reaches the scan", () => {
  it("its fold, its family-only lenses and its kinds are the scan's settings", () => {
    const env: InstallEnv = { HOME: join(dir, "home"), XDG_CONFIG_HOME: join(dir, "xdg") };
    const cfg = scanConfigOf(
      { ...fixture, review: { ...fixture.review, profile: "security" } },
      sandbox,
      homeProfileLookup(env),
    );
    const settings = scanSettings(cfg, "## Controls\n");
    expect(settings.fold).toBe(true);
    expect(settings.profileThreatModel).toBe("## Controls\n");
    expect(settings.scan.kinds).toEqual(["security", "exploit-chain", "partial-chain"]);
    const deep = stage2Lenses(settings.lenses, settings.scan.lenses);
    expect(deep.length).toBeGreaterThan(0);
    for (const l of deep) expect(SECURITY_FAMILY).toContain(l);
  });
});
