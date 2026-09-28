// tests/optional-validator.test.ts — the optional validator; a veto becomes a
// mark (amending).
//
// Three halves, each asserted where production meets it:
//   * the PLAN — a profile may switch `pass-validate` off (`buildPassPlan` /
//     `buildRoundOrder` + the rendered round prompt), and the validator runs at
//     its own tier, never raised to match a lens;
//   * the RECORD — a validity veto is `doubted`: kept, never posted
//     (`parseFindingsRecord` / `enforceFindingsRecord`), and the validator's
//     built body says so (`buildAgents`);
//   * the TUI — the doubted findings of a round reach the detail pane
//     (`whyJson` → `detailLines`).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { whyJson } from "../src/cli.js";
import { parseConfig, type Config } from "../src/config.js";
import { buildPassPlan, buildRoundOrder, validatorTier } from "../src/dispatch.js";
import { NONE_ECOSYSTEM } from "../src/ecosystem.js";
import {
  DOUBT_WORDS,
  enforceFindingsRecord,
  findingsRecordFile,
  isConformant,
  normalizeDisposition,
  parseFindingsRecord,
} from "../src/findingsrecord.js";
import type { PrFileEntry } from "../src/github.js";
import { PASS_ADDENDA, buildAgents } from "../src/include.js";
import { configHome, type InstallEnv } from "../src/install.js";
import { applyProfileTuning, lensModelOverrides } from "../src/lenstuning.js";
import { loadProfileLensTuning } from "../src/profiles.js";
import { StateStore, type PrStateRow } from "../src/state.js";
import { renderRoundPrompt } from "../src/templates.js";
import { detailLines } from "../src/tui/board.js";
import { stripAnsi } from "../src/tui/paint.js";

const sandbox = join(import.meta.dirname, "..");
const fixture: Config = parseConfig(
  readFileSync(resolve(sandbox, "tests/fixtures/config.toml"), "utf8"),
);

let dir: string;
let env: InstallEnv;
const lookup = () => ({ env, log: () => {} });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "qcr-optional-validator-"));
  env = { HOME: join(dir, "home"), XDG_CONFIG_HOME: join(dir, "xdg-config") };
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function profile(name: string, toml: string): void {
  const p = join(configHome(env), "profiles", name);
  mkdirSync(join(p, "addenda"), { recursive: true });
  writeFileSync(join(p, "profile.toml"), toml);
}

function tuned(name: string, base: Config = fixture): Config {
  const cfg = structuredClone(base);
  cfg.review.profile = name;
  return applyProfileTuning(cfg, loadProfileLensTuning(sandbox, name, lookup()));
}

const file = (filename: string, extra: Partial<PrFileEntry> = {}): PrFileEntry => ({
  filename,
  additions: 5,
  deletions: 0,
  status: "modified",
  ...extra,
});
const SMALL = [file("app/views.py")];
const AUTH = [file("svc/auth/token.py", { patch: "+def check(t): return t\n" })];

const plan = (cfg: Config, files: PrFileEntry[]) =>
  buildPassPlan(cfg, files, undefined, NONE_ECOSYSTEM);
const validateRow = (cfg: Config, files: PrFileEntry[]) =>
  plan(cfg, files).pass_plan.find((p) => p.lens === "pass-validate");

const order = (cfg: Config) =>
  buildRoundOrder({
    cfg,
    row: { number: 7, title: "t", head_sha: "abc" } as unknown as PrStateRow,
    files: SMALL,
    roundId: 1,
    roundNo: 1,
    roundType: "first",
    worktree: "/wt",
    settledDigest: "",
    issuedAt: "2026-09-29T00:00:00Z",
    ecosystem: NONE_ECOSYSTEM,
  });

const TEMPLATES = ["round-first.md", "round-re-review.md", "round-staleness.md"];
const template = (t: string) => readFileSync(join(sandbox, "prompts", t), "utf8");

// ---- the plan ------------------------------------------------------------------

describe("a profile can switch the validator off", () => {
  it("untuned: the validator is planned last, and step 4 carries no no-validator note", () => {
    expect(plan(fixture, SMALL).pass_plan.at(-1)?.lens).toBe("pass-validate");
    for (const t of TEMPLATES) {
      const prompt = renderRoundPrompt(template(t), order(fixture));
      expect(prompt, t).not.toContain("No validator this round");
      expect(prompt, t).toContain("Dispatch the planned `pass-validate` variant");
    }
  });

  it("enabled = false: no validator row, not addable, and the prompt says so", () => {
    profile("novalidate", "[lenses.pass-validate]\nenabled = false\n");
    const cfg = tuned("novalidate");
    for (const files of [SMALL, AUTH]) {
      const p = plan(cfg, files);
      expect(p.pass_plan.map((r) => r.lens)).not.toContain("pass-validate");
      expect(p.addable_lenses).not.toContain("pass-validate");
      expect(p.pass_plan.length).toBeGreaterThan(0);
    }
    for (const t of TEMPLATES) {
      const prompt = renderRoundPrompt(template(t), order(cfg));
      expect(prompt, t).toContain("No validator this round");
      expect(prompt, t).not.toMatch(/\{\{\w+\}\}/);
    }
  });

  it("with the validator off the sweep rows go last — no lens is displaced behind them", () => {
    const swept = structuredClone(fixture);
    swept.review.sweep = true;
    const withValidator = plan(swept, SMALL).pass_plan.map((r) => r.lens);
    expect(withValidator.slice(-2)).toEqual(["pass-sweep", "pass-validate"]);
    profile("novalidate", "[lenses.pass-validate]\nenabled = false\n");
    const without = plan(tuned("novalidate", swept), SMALL).pass_plan.map((r) => r.lens);
    // MUTATION: splice at `length - 1` unconditionally and the sweep lands
    // before the last lens instead of after it.
    expect(without).toEqual(withValidator.filter((l) => l !== "pass-validate"));
  });
});

describe("the validator runs at its own tier, never raised (amended)", () => {
  const lowFloor = structuredClone(fixture);
  lowFloor.models.validate_tier = "terra-med";

  it("a sol-high risk lens does not raise it", () => {
    const p = plan(lowFloor, AUTH).pass_plan;
    expect(p.find((r) => r.lens === "pass-security")?.tier).toBe("sol-high");
    expect(validateRow(lowFloor, AUTH)).toEqual({
      lens: "pass-validate",
      agent: "pass-validate--terra-med",
      tier: "terra-med",
      raisable_to: [],
    });
  });

  it("a lens floored by the profile does not raise it; its own min_tier still does", () => {
    profile("lfloor", '[lenses.pass-baseline]\nmin_tier = "sol-high"\n');
    expect(validateRow(tuned("lfloor", lowFloor), SMALL)?.tier).toBe("terra-med");
    profile("vfloor", '[lenses.pass-validate]\nmin_tier = "sol-med"\n');
    expect(validateRow(tuned("vfloor", lowFloor), SMALL)?.tier).toBe("sol-med");
    expect(validatorTier(tuned("vfloor", lowFloor))).toBe("sol-med");
  });

  it("a lens's effort never reaches the validator's built model", () => {
    profile("hot", '[lenses.pass-baseline]\neffort = "high"\n');
    const cfg = tuned("hot");
    const overrides = lensModelOverrides(cfg.models, cfg.lenses);
    expect(Object.keys(overrides).some((k) => k.startsWith("pass-validate--"))).toBe(false);
  });

  it("untuned installs are unchanged: the shipped tier is the top one", () => {
    expect(fixture.models.validate_tier).toBe("sol-high");
    for (const files of [SMALL, AUTH]) expect(validateRow(fixture, files)?.tier).toBe("sol-high");
  });
});

// ---- the record ----------------------------------------------------------------

const entry = (over: Record<string, unknown>) => ({
  lens: "pass-security",
  path: "app/x.py",
  line: 12,
  severity: "P1",
  reason: "the guard at :8 already rejects it",
  ...over,
});

describe("a validity veto is `doubted` in the findings record", () => {
  it("is a disposition of its own, with its spellings", () => {
    expect(normalizeDisposition("doubted")).toBe("doubted");
    expect(normalizeDisposition("doubt")).toBe("doubted");
    expect(normalizeDisposition("may not be valid")).toBe("doubted");
  });

  it("a kill for the claim's validity is folded onto doubted; any other kill stays a kill", () => {
    const parsed = parseFindingsRecord(
      {
        findings: [
          ...DOUBT_WORDS.map((word, i) => entry({ id: `d${i}`, disposition: "killed", word })),
          entry({ id: "k1", disposition: "killed", word: "duplicate" }),
          entry({ id: "k2", disposition: "killed", word: "out-of-scope" }),
          entry({ id: "d9", disposition: "doubted", word: "refuted" }),
        ],
      },
      7,
      1,
    );
    const by = new Map(parsed.record!.findings.map((f) => [f.key, f.disposition]));
    for (const i of DOUBT_WORDS.keys()) expect(by.get(`d${i}`)).toBe("doubted");
    expect(by.get("d9")).toBe("doubted");
    expect(by.get("k1")).toBe("killed");
    expect(by.get("k2")).toBe("killed");
    expect(parsed.note).toBeUndefined();
    expect(isConformant(parsed.conformance!)).toBe(true);
  });

  it("a doubted finding marked as posted breaks the record's conformance", () => {
    const parsed = parseFindingsRecord(
      {
        findings: [
          entry({ id: "d1", disposition: "doubted", word: "refuted", posted_as: "blocker" }),
        ],
      },
      7,
      1,
    );
    expect(parsed.conformance?.doubted_posted).toEqual(["d1"]);
    expect(isConformant(parsed.conformance!)).toBe(false);
  });

  it("is stored, readable per PR, and a posted doubt earns an anomaly", async () => {
    const store = new StateStore(":memory:");
    const findingsDir = join(dir, "findings");
    mkdirSync(findingsDir, { recursive: true });
    writeFileSync(
      join(findingsDir, findingsRecordFile(7, 2)),
      JSON.stringify({
        pr: 7,
        round_no: 2,
        findings: [
          entry({ id: "d1", disposition: "killed", word: "unverifiable" }),
          entry({ id: "d2", disposition: "doubted", word: "refuted", posted_as: "blocker" }),
          entry({ id: "p1", disposition: "posted", posted_as: "blocker" }),
        ],
      }),
    );
    const result = await enforceFindingsRecord(
      { store, findingsDir, inject: async () => {} },
      { pr: 7, roundNo: 2, roundId: null, headSha: "abc", planned: ["pass-security"] },
    );
    expect(result).toBe("recorded");
    expect(store.doubtedFindings(7).map((f) => f.finding_key)).toEqual(["d1", "d2"]);
    const anomalies = store.anomalies();
    expect(anomalies.map((a) => a.kind)).toEqual(["review_output_unreasoned"]);
    expect(JSON.stringify(anomalies[0])).toContain("1 doubted finding(s) posted (d2)");
    store.close();
  });
});

describe("the validator is told its validity veto is a doubt", () => {
  it("the built validator carries the doubt addendum, naming every doubt word; lenses do not", () => {
    const out = mkdtempSync(join(tmpdir(), "qcr-optional-validator-build-"));
    try {
      const built = buildAgents(join(sandbox, "agents"), out, {
        root: sandbox,
        addenda: PASS_ADDENDA,
      });
      const bytes = (name: string) =>
        readFileSync(built.find((b) => b.name === name)!.output, "utf8");
      const validator = bytes("pass-validate--sol-high");
      expect(validator).toContain("A validity veto is a DOUBT, not a kill");
      expect(validator).toContain("DOUBTED\n- <lens> <path:line>");
      for (const w of DOUBT_WORDS) expect(validator).toContain(`\`${w}\``);
      expect(bytes("pass-baseline--sol-med")).not.toContain("A validity veto is a DOUBT");
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });

  it("every round template records a doubt as `doubted`, never posted", () => {
    for (const t of TEMPLATES) {
      const text = template(t);
      expect(text, t).toMatch(
        /`doubted` \(the validator's\n\s+DOUBTED block: kept here, never posted\)/,
      );
      expect(text, t).toContain("{{validator_note}}");
    }
  });
});

// ---- the TUI -------------------------------------------------------------------

describe("the TUI shows a round's doubted findings", () => {
  function storeWithDoubts(): StateStore {
    const store = new StateStore(":memory:");
    store.upsertPr({
      number: 7,
      state: "awaiting_author",
      head_sha: "abc",
      title: "t",
      author: "alice",
      trigger_ts: null,
      stale_recheck: 0,
      migration_gate: 0,
    });
    store.recordRoundFindings(
      { pr: 7, round_id: null, round_no: 2, head_sha: "abc" },
      parseFindingsRecord(
        {
          findings: [
            entry({ id: "d1", disposition: "killed", word: "refuted" }),
            entry({ id: "p1", disposition: "posted", posted_as: "blocker", path: "app/y.py" }),
          ],
        },
        7,
        2,
      ).record!.findings,
      ["pass-security"],
    );
    return store;
  }

  it("why --json carries only the doubted ones", () => {
    const store = storeWithDoubts();
    expect(whyJson(store, 7, "/nonexistent-archive").doubted).toEqual([
      {
        round_no: 2,
        lens: "pass-security",
        path: "app/x.py",
        line: 12,
        severity: "P1",
        word: "refuted",
        reason: "the guard at :8 already rejects it",
      },
    ]);
    store.close();
  });

  it("the detail pane renders them under DOUBTED; nothing when there are none", () => {
    const store = storeWithDoubts();
    const why = whyJson(store, 7, "/nonexistent-archive");
    store.close();
    const pr = { number: 7, state: "awaiting_author", title: "t" } as never;
    const lines = detailLines(why, pr, 160).map(stripAnsi);
    const at = lines.findIndex((l) => l.startsWith("▍DOUBTED"));
    expect(at).toBeGreaterThan(-1);
    expect(lines[at]).toContain("may not be valid · kept, never posted");
    expect(lines[at + 1]).toBe(
      "  ? r2 pass-security app/x.py:12 · P1 · refuted — the guard at :8 already rejects it",
    );
    const none = detailLines({ ...why, doubted: [] }, pr, 160).map(stripAnsi);
    expect(none.some((l) => l.startsWith("▍DOUBTED"))).toBe(false);
    const older = detailLines({ ...why, doubted: undefined }, pr, 160).map(stripAnsi);
    expect(older.some((l) => l.startsWith("▍DOUBTED"))).toBe(false);
  });
});
