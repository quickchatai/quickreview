// tests/state-profile.test.ts — the `[state_machines]` table, the shipped
// `state-machines` profile (profiles/state-machines/) and the `state`
// posting scope.
//
// The profile cases resolve it the way the daemon does — `applyProfileOverlays`
// over the parsed config, then the plan with the profile's ecosystem and
// heuristics, and the built agents with the registry plus the profile's pack
// — and assert on what the resolved profile makes the plan, the scan table,
// the posting cut and the built bodies do, never on the loaders' internals.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig, type Config } from "../src/config.js";
import { buildPassPlan } from "../src/dispatch.js";
import type { PrFileEntry } from "../src/github.js";
import {
  configHome,
  EXAMPLE_PROFILES,
  homeProfileLookup,
  locateProfile,
  type InstallEnv,
} from "../src/install.js";
import { ecosystemFor } from "@quickchatai/pi-quickreview/src/ecosystem.js";
import {
  addendaForPass,
  buildAgents,
  PASS_ADDENDA,
  SCAN_PASS,
  VALIDATE_PASS,
} from "@quickchatai/pi-quickreview/src/include.js";
import { isKnownVocabularyWord } from "@quickchatai/pi-quickreview/src/findingsrecord.js";
import { alwaysPlannedLenses } from "@quickchatai/pi-quickreview/src/lenstuning.js";
import { ALL_PASSES, STATE_FAMILY } from "@quickchatai/pi-quickreview/src/passes.js";
import {
  parsePostingTable,
  postingPolicyAddenda,
  postingScope,
  selectPosted,
  withholdWordsFor,
  DEFAULT_POSTING_POLICY,
  type PolicyView,
} from "@quickchatai/pi-quickreview/src/postingpolicy.js";
import {
  applyProfileOverlays,
  applyProfileSecurity,
  applyProfileStateMachines,
  loadProfileAddenda,
  loadProfileEcosystem,
  loadProfileHeuristics,
  loadProfileScan,
  loadProfileStateMachines,
} from "@quickchatai/pi-quickreview/src/profiles.js";
import {
  DEFAULT_PASS_TIERS,
  parseStateMachines,
  parseStateMachinesTable,
  STATE_MACHINES_DEFAULTS,
  STATE_MACHINES_PROFILE_KEYS,
} from "@quickchatai/pi-quickreview/src/reviewconfig.js";
import { kindKept } from "@quickchatai/pi-quickreview/src/scan/scan.js";
import { HEAVY_TIMEOUT_MS } from "./helpers/suite-timeouts.js";

const sandbox = join(import.meta.dirname, "..");
const root = sandbox;
const PROFILE = "state-machines";
const PROFILE_DIR = join(sandbox, "profiles", PROFILE);
const fixture: Config = parseConfig(
  readFileSync(join(sandbox, "tests/fixtures/config.toml"), "utf8"),
);

let dir: string;
let env: InstallEnv;
const lookup = () => homeProfileLookup(env);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "qcr-state-profile-"));
  env = { HOME: join(dir, "home"), XDG_CONFIG_HOME: join(dir, "xdg-config") };
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function resolved(profile: string, base: Config = fixture): Config {
  return applyProfileOverlays(root, { ...base, review: { ...base.review, profile } }, lookup());
}

function plan(profile: string, files: PrFileEntry[], base: Config = fixture) {
  return buildPassPlan(
    resolved(profile, base),
    files,
    { title: "Rework checkout", body: "" },
    ecosystemFor(loadProfileEcosystem(root, profile, lookup())),
    loadProfileHeuristics(root, profile, lookup()),
  );
}

const file = (filename: string, patch: string, additions = 40): PrFileEntry =>
  ({
    filename,
    additions,
    deletions: 0,
    changes: additions,
    status: "modified",
    patch,
  }) as PrFileEntry;

/** A change wide enough to plan most of the default review, with a state
 * write (a weak transitions signal) and a webhook handler (a weak events
 * signal) in it. */
const BROAD: PrFileEntry[] = [
  file(
    "src/auth/login.ts",
    "@@ -1,2 +1,8 @@\n" +
      "+export async function syncAll(url: string) {\n" +
      "+  let page = 1;\n" +
      "+  while (page) {\n" +
      "+    const r = await fetch(`${url}?page=${page}`);\n" +
      "+    page = (await r.json()).next_page;\n" +
      "+  }\n" +
      "+  return process.env.LOGIN_HOST;\n" +
      "+}\n",
    300,
  ),
  file("src/orders/ship.ts", "@@ -1 +1,2 @@\n+  order.status = 'shipped';\n", 120),
  file("src/webhooks/stripe.ts", "@@ -1 +1,2 @@\n+emitter.on('invoice.paid', credit);\n"),
  file("db/queries.sql", "@@ -1 +1,2 @@\n+SELECT * FROM users WHERE id = $1;\n"),
  file("tests/login.test.ts", "@@ -1 +1,2 @@\n+it('signs in', () => {});\n"),
];

const KEPT = new Set([...STATE_FAMILY, VALIDATE_PASS]);
/** Every lens the profile plans on every change to code or config: the
 * whole family. */
const ALWAYS = [...STATE_FAMILY].sort();

describe("[state_machines] in config.toml", () => {
  // MUTATION: set `triggers: "all"` in STATE_MACHINES_DEFAULTS — this fails.
  it("defaults to strong triggers, not only, its own label, the command on", () => {
    expect(parseStateMachines(undefined)).toEqual(STATE_MACHINES_DEFAULTS);
    expect(STATE_MACHINES_DEFAULTS).toEqual({
      triggers: "strong",
      only: false,
      label: "qcr:state-machines",
      command: true,
    });
  });

  it("reads every key, trims the label, and takes an empty label as none", () => {
    expect(
      parseStateMachines({ triggers: "all", only: true, label: " sm ", command: false }),
    ).toEqual({ triggers: "all", only: true, label: "sm", command: false });
    expect(parseStateMachines({ label: "" }).label).toBe("");
  });

  // MUTATION: drop the unknown-key refusal — this stops throwing.
  it("refuses an unknown key, a bad mode, a non-boolean and an over-long label, naming the table", () => {
    expect(() => parseStateMachines({ fold: true })).toThrow(
      /\[state_machines\] unknown key "fold"/,
    );
    expect(() => parseStateMachines({ triggers: "weak" })).toThrow(
      /triggers must be "off", "strong", "all"/,
    );
    expect(() => parseStateMachines({ only: "yes" })).toThrow(/only must be true or false/);
    expect(() => parseStateMachines({ label: "x".repeat(51) })).toThrow(
      /label must be a label name/,
    );
    expect(() => parseStateMachines([])).toThrow(/must be a table/);
  });

  // Who may ask for a review is the install's to say, never a profile's.
  // MUTATION: add "label" to STATE_MACHINES_PROFILE_KEYS — this fails.
  it("a profile sets triggers and only, and is refused label and command", () => {
    expect([...STATE_MACHINES_PROFILE_KEYS]).toEqual(["triggers", "only"]);
    expect(
      parseStateMachinesTable("p", { triggers: "off", only: true }, STATE_MACHINES_PROFILE_KEYS),
    ).toEqual({ triggers: "off", only: true });
    for (const key of ["label", "command"])
      expect(() =>
        parseStateMachinesTable(
          "p",
          { [key]: key === "label" ? "x" : true },
          STATE_MACHINES_PROFILE_KEYS,
        ),
      ).toThrow(/is config.toml only/);
  });

  it("the parsed config carries the table", () => {
    expect(fixture.state_machines).toEqual(STATE_MACHINES_DEFAULTS);
  });
});

describe("the overlay", () => {
  // MUTATION: make familyOnlyLenses keep "pass-baseline" — this fails.
  it("`only` switches off every lens outside the family and the validator, and keeps a written `enabled`", () => {
    const cfg = applyProfileStateMachines(
      { ...fixture, lenses: { "pass-tests": { enabled: true } } } as Config,
      { only: true },
    );
    for (const lens of ALL_PASSES) {
      if (KEPT.has(lens) || lens === "pass-tests")
        expect(cfg.lenses?.[lens]?.enabled, lens).not.toBe(false);
      else expect(cfg.lenses?.[lens]?.enabled, lens).toBe(false);
    }
  });

  it("without `only` it moves no lens", () => {
    const cfg = applyProfileStateMachines(fixture, { triggers: "all" });
    expect(cfg.lenses).toBe(fixture.lenses);
    expect(cfg.state_machines?.triggers).toBe("all");
  });

  // One family alone, never two: each `only` would switch the other family
  // off, and the validator would be handed nothing.
  // MUTATION: drop the both-only refusal — this stops throwing.
  it("refuses a security-only review that is also state-machine-only", () => {
    const secured = applyProfileSecurity(fixture, { only: true });
    expect(() => applyProfileStateMachines(secured, { only: true })).toThrow(
      /\[security\] only and \[state_machines\] only are both true/,
    );
  });

  it("a profile in the config home sets the table, and its chain merges per key", () => {
    const home = join(configHome(env), "profiles");
    mkdirSync(join(home, "base"), { recursive: true });
    mkdirSync(join(home, "child"), { recursive: true });
    writeFileSync(
      join(home, "base", "profile.toml"),
      'extends = "default"\n[state_machines]\ntriggers = "all"\nonly = true\n',
    );
    writeFileSync(
      join(home, "child", "profile.toml"),
      'extends = "base"\n[state_machines]\nonly = false\n',
    );
    expect(loadProfileStateMachines(root, "child", lookup())).toEqual({
      triggers: "all",
      only: false,
    });
    // The resolved config: the child's `only = false` wins, so no lens moves.
    const cfg = resolved("child");
    expect(cfg.state_machines).toMatchObject({ triggers: "all", only: false });
    expect(cfg.lenses?.["pass-baseline"]?.enabled).not.toBe(false);
  });
});

describe("the state posting scope", () => {
  const item = (
    id: string,
    cls: PolicyView["cls"],
    stateMachine: boolean,
  ): PolicyView & { id: string } => ({ id, cls, severity: "P1", key: id, stateMachine });

  it("parses, and is refused a spelling that is not a scope", () => {
    expect(parsePostingTable("x", { scope: "state" }).scope).toBe("state");
    expect(() => parsePostingTable("x", { scope: "states" })).toThrow();
  });

  // MUTATION: drop the `scope === "state"` branch from selectPosted — every
  // item posts and this fails.
  it("withholds everything that is not a state-machine finding, a blocker included", () => {
    const items = [
      item("sm-blocker", "blocker", true),
      item("other-blocker", "blocker", false),
      item("sm-question", "question", true),
      item("other-nit", "nit", false),
    ];
    const out = selectPosted(items, (x) => x, { ...DEFAULT_POSTING_POLICY, scope: "state" });
    expect(out.kept.map((x) => x.id)).toEqual(["sm-blocker", "sm-question"]);
    expect(out.withheld.map((w) => [w.item.id, w.word])).toEqual([
      ["other-blocker", "state-scope"],
      ["other-nit", "state-scope"],
    ]);
  });

  it("a security finding does not post under it, nor a state-machine one under the security scope", () => {
    const sec = { ...item("sec", "blocker", false), security: true };
    const sm = item("sm", "blocker", true);
    const state = selectPosted([sec, sm], (x) => x, { ...DEFAULT_POSTING_POLICY, scope: "state" });
    expect(state.kept.map((x) => x.id)).toEqual(["sm"]);
    const security = selectPosted([sec, sm], (x) => x, {
      ...DEFAULT_POSTING_POLICY,
      scope: "security",
    });
    expect(security.kept.map((x) => x.id)).toEqual(["sec"]);
  });

  it("tells the validator the rule and its word, and no other policy mentions it", () => {
    const scoped = { ...DEFAULT_POSTING_POLICY, scope: "state" as const };
    expect(withholdWordsFor(scoped)).toContain("state-scope");
    expect(withholdWordsFor(scoped)).not.toContain("security-scope");
    const text = postingPolicyAddenda(scoped)[0]!.text;
    expect(text).toContain("**State-machine findings only.**");
    expect(text).toContain("`state-scope`");
    const security = postingPolicyAddenda({ ...DEFAULT_POSTING_POLICY, scope: "security" })[0]!
      .text;
    expect(security).not.toContain("state-scope");
  });
});

describe("the shipped state-machines profile", () => {
  // MUTATION: drop "state-machines" from EXAMPLE_PROFILES (profilelookup.ts) — this fails.
  it("is a generic example the locator finds in the checkout, and loads", () => {
    expect(EXAMPLE_PROFILES).toContain(PROFILE);
    expect(locateProfile({ root, profile: PROFILE })?.dir).toBe(PROFILE_DIR);
    const pack = loadProfileAddenda(root, PROFILE, lookup());
    expect(pack.map((a) => [a.id, a.scope, a.mode])).toEqual([
      ["scan-stage1-state", [SCAN_PASS], "scan"],
      ["validate-state-only", [VALIDATE_PASS], undefined],
    ]);
  });

  /**
   * MUTATION: set `only = false` in profiles/state-machines/profile.toml —
   * fails. Drop one `plan = "always"` table — the always assertion fails.
   */
  it("resolves state-machine-only, every trigger on, all eight lenses always, and the state scope", () => {
    const cfg = resolved(PROFILE);
    expect(cfg.state_machines).toMatchObject({ only: true, triggers: "all" });
    expect(cfg.security?.only).toBe(false);
    for (const lens of ALL_PASSES) {
      if (KEPT.has(lens)) expect(cfg.lenses?.[lens]?.enabled, lens).not.toBe(false);
      else expect(cfg.lenses?.[lens]?.enabled, lens).toBe(false);
    }
    expect([...alwaysPlannedLenses(cfg.lenses)].sort()).toEqual(ALWAYS);
    expect(postingScope(cfg.posting)).toBe("state");
  });

  /** MUTATION: delete `[posting] scope` from the profile — still "state":
   * `only` sets it. Then set `only = false` too — this fails. */
  it("the default profile keeps posting everything", () => {
    expect(postingScope(resolved("default").posting)).toBe("all");
    expect(resolved("default").state_machines).toEqual(STATE_MACHINES_DEFAULTS);
  });

  it("plans only family rows and the validator on a broad change, and offers nothing else to add", () => {
    const control = plan("default", BROAD).pass_plan.map((p) => p.lens);
    for (const lens of ["pass-baseline", "pass-security", "pass-bounds"])
      expect(control, `control: ${lens}`).toContain(lens);
    // The default profile reads the weak signals of this change as nothing.
    for (const lens of control) expect(STATE_FAMILY, `control: ${lens}`).not.toContain(lens);

    const p = plan(PROFILE, BROAD);
    const lenses = p.pass_plan.map((r) => r.lens);
    expect(lenses.at(-1)).toBe(VALIDATE_PASS);
    for (const lens of lenses) expect(KEPT.has(lens), `planned: ${lens}`).toBe(true);
    for (const lens of ALWAYS) expect(lenses, lens).toContain(lens);
    for (const lens of p.addable_lenses) expect(STATE_FAMILY, `addable: ${lens}`).toContain(lens);
    // The weak signals plan their lenses with the signal as the reason.
    expect(p.pass_plan.find((r) => r.lens === "pass-sm-transitions")!.why).toContain(
      "src/orders/ship.ts",
    );
    expect(p.pass_plan.find((r) => r.lens === "pass-sm-events")!.why).toContain(
      "src/webhooks/stripe.ts",
    );
  });

  // MUTATION: delete `[lenses.pass-sm-derived]` from
  // profiles/state-machines/profile.toml — code with no state signal no
  // longer plans it, and this fails.
  it("plans all eight on code with no state signal, and nothing but the validator on docs", () => {
    const plain = plan(PROFILE, [file("src/math.ts", "@@ -1 +1,2 @@\n+export const two = 2;\n")]);
    expect(
      plain.pass_plan
        .map((r) => r.lens)
        .filter((l) => l !== VALIDATE_PASS)
        .sort(),
    ).toEqual(ALWAYS);
    const docs = plan(PROFILE, [file("README.md", "@@ -1 +1,2 @@\n+words\n")]);
    expect(docs.pass_plan.map((r) => r.lens)).toEqual([VALIDATE_PASS]);
  });

  /** MUTATION: delete `[lenses.pass-validate] min_tier` from the profile —
   * this fails. */
  it("runs the validator at deep whatever the install's validate_tier", () => {
    const low: Config = { ...fixture, models: { ...fixture.models, validate_tier: "standard" } };
    expect(
      plan("default", BROAD, low).pass_plan.find((r) => r.lens === VALIDATE_PASS)?.tier,
      "control",
    ).toBe("standard");
    expect(plan(PROFILE, BROAD, low).pass_plan.find((r) => r.lens === VALIDATE_PASS)?.tier).toBe(
      "deep",
    );
  });

  // Every family row the profile plans runs at deep with nothing to raise to: the
  // shipped pins reach a profile that names no tier.
  // MUTATION: drop the STATE_FAMILY spread from DEFAULT_PASS_TIERS
  // (reviewconfig.ts) — the rows fall back to the round's tier, and this
  // fails.
  it("runs every family row at deep, not raisable, though the profile names no tier", () => {
    const rows = plan(PROFILE, BROAD).pass_plan.filter((r) => STATE_FAMILY.includes(r.lens));
    const planned = rows.map((r) => r.lens);
    for (const lens of ALWAYS) expect(planned, lens).toContain(lens);
    for (const r of rows) {
      expect(r.tier, r.lens).toBe("deep");
      expect(r.agent, r.lens).toBe(`${r.lens}--deep`);
      expect(r.raisable_to, r.lens).toEqual([]);
    }
  });

  /** MUTATION: drop "pass-sm-derived" from `[scan] lenses` — this fails. */
  it("scans deep with the family alone, a four-lens floor, and keeps state-machine findings only", () => {
    const scan = loadProfileScan(root, PROFILE, lookup());
    expect(scan.depth).toBe("deep");
    expect([...(scan.lenses ?? [])]).toEqual([...STATE_FAMILY]);
    expect(scan.deep_lenses).toEqual([
      "pass-sm-transitions",
      "pass-sm-stuck",
      "pass-sm-states",
      "pass-sm-durable",
    ]);
    expect(scan.kinds).toEqual(["state-machine"]);
    for (const lens of STATE_FAMILY)
      expect(kindKept("anything", lens, scan.kinds ?? []), lens).toBe(true);
    expect(kindKept("state-machine:stuck", "pass-scan", scan.kinds ?? [])).toBe(true);
    expect(kindKept("logic", "pass-scan", scan.kinds ?? [])).toBe(false);
  });

  it(
    "composes its rules onto the validator and the scan lens only, on top of the family's own",
    { timeout: HEAVY_TIMEOUT_MS },
    () => {
      const pack = loadProfileAddenda(root, PROFILE, lookup());
      for (const entry of pack) expect(entry.text, entry.id).not.toContain("{{");
      const out = mkdtempSync(join(tmpdir(), "qcr-state-profile-build-"));
      try {
        const built = buildAgents(join(sandbox, "agents"), out, {
          root: sandbox,
          addenda: [...PASS_ADDENDA, ...pack],
          ecosystem: "none",
        });
        const only = "## State-machine findings only (state-machines profile)";
        const replay = "## State-machine evidence — replay the trace, then hunt the guard";
        // MUTATION: drop the `validate-state-keep` entry from PASS_ADDENDA
        // (include.ts) — this fails.
        const keep = "## State-machine candidates — keep what the code proves";
        const own =
          "## Inside the state-machine family, what you report for another lens is a state defect";
        let family = 0;
        for (const b of built) {
          const body = readFileSync(b.output, "utf8");
          expect(body, b.name).not.toContain("{{");
          if (b.pass === VALIDATE_PASS) {
            expect(body, b.name).toContain(only);
            expect(body, b.name).toContain(replay);
            expect(body, b.name).toContain(keep);
            // The validator checks an absence finding's comparison as a step.
            // MUTATION: drop the `compare:` sentence from
            // VALIDATE_STATE_EVIDENCE_ADDENDUM (include.ts) — this fails.
            expect(body, b.name).toContain("may carry a `compare:` line");
          } else {
            expect(body, b.name).not.toContain(only);
            expect(body, b.name).not.toContain(replay);
            expect(body, b.name).not.toContain(keep);
          }
          if (STATE_FAMILY.includes(b.pass)) {
            family++;
            expect(body, b.name).toContain(own);
            // A state defect owned outside the family is still reported, with
            // its owner named, as the shared contract says.
            // MUTATION: narrow SM_FAMILY_OWN_LENS_ADDENDUM back to "another
            // state-machine lens" (include.ts) — this fails.
            expect(body, b.name).toContain("whichever lens owns it");
            expect(body, b.name).toContain("# State-machine lenses — shared contract");
          } else expect(body, b.name).not.toContain(own);
        }
        expect(family).toBe(STATE_FAMILY.length * 3);
      } finally {
        rmSync(out, { recursive: true, force: true });
      }
    },
  );
});

describe("the registry's state-machine addenda", () => {
  // MUTATION: change validate-state-evidence's scope to "all" — this fails.
  it("bind the family's lenses and the validator, and no other pass", () => {
    const ids = (pass: string): string[] => addendaForPass(pass, PASS_ADDENDA).map((a) => a.id);
    expect(ids(VALIDATE_PASS)).toContain("validate-state-evidence");
    expect(ids(VALIDATE_PASS)).not.toContain("sm-family-own-lens");
    for (const lens of STATE_FAMILY) {
      expect(ids(lens), lens).toContain("sm-family-own-lens");
      expect(ids(lens), lens).not.toContain("validate-state-evidence");
    }
    for (const lens of ["pass-baseline", "pass-sec-access", "pass-concurrency"]) {
      expect(ids(lens), lens).not.toContain("sm-family-own-lens");
      expect(ids(lens), lens).not.toContain("validate-state-evidence");
    }
  });

  // The validator's rules add no word to the closed vocabulary: every
  // backticked disposition-shaped word (kebab-case, not a lens name and not
  // the finding kind `state-machine`) and every outcome they name is one the
  // vocabulary already has.
  // MUTATION: add "label it `trace-broken`" to VALIDATE_STATE_EVIDENCE_ADDENDUM — this fails.
  // MUTATION: add "it is `restored-elsewhere`" to VALIDATE_STATE_KEEP_ADDENDUM — this fails.
  it("the validator's rule names the five refutation questions and only existing kill words", () => {
    const rule = PASS_ADDENDA.find((a) => a.id === "validate-state-evidence")!.text;
    for (const q of [
      "Is the state unrepresentable, or the dispatch proven exhaustive?",
      "Is the guard somewhere else?",
      "Is it the same object or row on every step?",
      "Is each step feasible after the ones before it?",
      "Does something restore the state?",
    ])
      expect(rule, q).toContain(q);
    for (const word of ["`refuted`", "`unverifiable`", "`below-bar`", "`out-of-scope`"])
      expect(rule, word).toContain(word);
    expect(rule).not.toMatch(/adds? (ONE|a) word/i);
    const keep = PASS_ADDENDA.find((a) => a.id === "validate-state-keep")!.text;
    const words = [rule, keep].flatMap((t) =>
      [...t.matchAll(/`([a-z]+(?:-[a-z]+)+)`/g)]
        .map((m) => m[1]!)
        .filter((w) => !w.startsWith("pass-") && w !== "state-machine"),
    );
    expect(words).toEqual(expect.arrayContaining(["below-bar", "external-assumption"]));
    for (const w of [...words, "refuted", "unverifiable"])
      expect(isKnownVocabularyWord(w), w).toBe(true);
  });

  // MUTATION: change validate-state-keep's scope to "lenses" — this fails.
  it("the keep rule binds the validator alone", () => {
    const ids = (pass: string): string[] => addendaForPass(pass, PASS_ADDENDA).map((a) => a.id);
    expect(ids(VALIDATE_PASS)).toContain("validate-state-keep");
    for (const lens of [...STATE_FAMILY, "pass-baseline", "pass-sec-access"])
      expect(ids(lens), lens).not.toContain("validate-state-keep");
  });

  // The keep rule narrows the external-premise downgrade for state-machine
  // candidates, so it must compose after that rule and after the replay it
  // qualifies: a later section is the one a model takes as the last word.
  // MUTATION: move the `validate-state-keep` entry above
  // `validate-external-semantics` in PASS_ADDENDA (include.ts) — this fails.
  it("the keep rule composes after the external-semantics rule and the trace replay, in a PR build", () => {
    const ids = addendaForPass(VALIDATE_PASS, PASS_ADDENDA, "none", "pr").map((a) => a.id);
    const keep = ids.indexOf("validate-state-keep");
    expect(ids.indexOf("validate-external-semantics")).toBeGreaterThanOrEqual(0);
    expect(keep).toBeGreaterThan(ids.indexOf("validate-external-semantics"));
    expect(keep).toBeGreaterThan(ids.indexOf("validate-state-evidence"));
  });

  // Each point names the failure it closes: a locally proven regression cut
  // for an absent dependency source, an absence affirmed without a search,
  // and two transitions merged because one scenario showed both. It binds
  // state-machine candidates only and adds no kill word.
  // The keep rule waits for the guard hunt (a moved guard is a guard found),
  // keeps only a branch whose value comes from outside the repository (a
  // value only this repository could write needs that writer), and reaches
  // the rules composed after it (the opt-in group dedup says "one fix → one
  // finding").
  // MUTATION: delete any one of the three bullets of
  // VALIDATE_STATE_KEEP_ADDENDUM (include.ts), or its "binds" sentence — this
  // fails. MUTATION: drop "a guard the change moved to a caller, wrapper or
  // callee is a guard found" — this fails. MUTATION: restore "the last word
  // over the rules above" — this fails.
  it("the keep rule keeps a proven regression's weight, reads before it restates, and merges by event and write", () => {
    const rule = PASS_ADDENDA.find((a) => a.id === "validate-state-keep")!.text;
    expect(rule).toContain("This section binds a **state-machine candidate**");
    expect(rule).toContain(
      "the last word over every other rule in this prompt, before or after it",
    );
    expect(rule).toContain("**A regression the code proves keeps its weight.**");
    expect(rule).toContain(
      "This applies after the five refutation questions above found no guard: a guard the change moved to a caller, wrapper or callee is a guard found, not a removal.",
    );
    expect(rule).toContain("comes from outside this repository");
    expect(rule).toContain(
      "When the value would have to come from a writer in this repository, find that writer: with none, the never-a-finding shape for a representable combination still holds.",
    );
    expect(rule).toContain("never on the missing source");
    expect(rule).toContain("(`external-assumption`) is only for a consequence");
    expect(rule).toContain("**A fact you restate is a fact you read.**");
    expect(rule).toContain("valid only after you searched for the other writers, readers or exits");
    expect(rule).toContain("**Merge by event, write and fix, not by scenario.**");
    expect(rule).toContain("one fix closes both, however each lens names the state");
    expect(rule).toContain("A race and a halfway failure at the same lines are two events");
    expect(rule).toContain("Audit a `MERGED` line in your task string the same way");
    // Only words the closed vocabulary already has; no kill is licensed.
    expect(rule).not.toMatch(/`(refuted|unverifiable|below-bar|out-of-scope|bad-anchor)`/);
    expect(rule).not.toMatch(/adds? (ONE|a) word/i);
  });
});

describe("the fast profile and the shipped pins", () => {
  // `fast` keeps every lens low: each shipped pin (the family's eight among
  // them) has its own `effort = "low"` entry, or the family would run at
  // high effort in the cheap review.
  // MUTATION: delete `[lenses.pass-sm-durable]` from profiles/fast/profile.toml
  // — this fails.
  it("sets effort = low on every lens DEFAULT_PASS_TIERS pins", () => {
    const lenses = resolved("fast").lenses;
    const pinned = Object.keys(DEFAULT_PASS_TIERS);
    for (const lens of STATE_FAMILY) expect(pinned, lens).toContain(lens);
    for (const lens of pinned) expect(lenses?.[lens]?.effort, lens).toBe("low");
  });
});
