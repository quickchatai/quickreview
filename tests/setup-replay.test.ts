// The PR replay: one or two recent PRs reviewed with the OLD and
// the NEW repo profile, the cost stated before anything runs, the two
// reviews shown side by side.
//
// Asserted at the seams the spec names: the profiles the setup tools WROTE
// (and the baseline each write records) resolved through the real loaders
// into each side's `buildPassPlan` and `buildAgents` — the sides are the
// production `replaySides`, over a temp config home and this checkout's
// lens sources — and what the runner does with them, driven through a fake
// PR source and a fake case runner. The source's real git half is proven
// against a scratch repo at the end (git is the thing under test there).
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  renderComparison,
  renderPlans,
  renderReplayPreview,
  renderReplayStatus,
  replayToolDefinitions,
} from "../extensions/setup-replay.js";
import { renderApply } from "../extensions/setup.js";
import { SCAN_LEAF_TOOLS, VALIDATE_PASS } from "../src/include.js";
import { configHome, type InstallEnv } from "../src/install.js";
import { notYetTrackerSink, stateHomeFs } from "../src/setup/adapters.js";
import { PROFILE_BASELINES_FILE, readBaselines } from "../src/setup/baselines.js";
import type { CaseOutcome, CaseRunner, CaseSpec, Refusal } from "../src/setup/engine.js";
import { SetupEngine } from "../src/setup/engine.js";
import { CONCERN_NAMES, type Priority } from "../src/setup/interview.js";
import {
  compareFindings,
  parseUnifiedDiff,
  REFERENCE_BASIS,
  REPLAY_CAP_FACTOR,
  type ReplayFinding,
  type ReplayPr,
  type ReplayTree,
} from "../src/setup/replay.js";
import { REPLAY_AGENTS_DIR, REPLAY_HOME_DIR, replaySides } from "../src/setup/replaybuild.js";
import {
  compareRun,
  ReplayRunner,
  validated,
  type ReplayPreview,
  type ReplayRun,
} from "../src/setup/replayrun.js";
import { gitReplaySource, parsePull, REPLAY_TREES_DIR } from "../src/setup/replaysource.js";
import type { ApplyResult } from "../src/setup/tuning.js";

const sandbox = join(import.meta.dirname, "..");
const fixtureToml = readFileSync(join(sandbox, "tests/fixtures/config.toml"), "utf8");

let dir: string;
let env: InstallEnv;
let now: Date;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "qcr-replay-"));
  env = {
    HOME: join(dir, "home"),
    XDG_CONFIG_HOME: join(dir, "xdg-config"),
    QCR_STATE_HOME: join(dir, "state"),
  };
  now = new Date("2026-09-29T10:00:00Z");
  liveConfig("");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function write(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

/** The live config (the full fixture), naming `profile` ("" = none). */
function liveConfig(profile: string): void {
  write(
    join(configHome(env), "config.toml"),
    fixtureToml.replace(/^profile = "".*$/m, `profile = ${JSON.stringify(profile)}`),
  );
}

const stateRoot = (): string => join(dir, "state");

function engine(): SetupEngine {
  return new SetupEngine({
    repo: {
      location: "/r",
      listFiles: () => [],
      read: () => null,
      lines: () => null,
      head: () => null,
    },
    state: stateHomeFs(stateRoot()),
    profiles: { root: sandbox, env },
    clock: () => now,
    memory: null,
    cases: { run: async () => ({ ok: false, reason: "no cases here" }) },
    tracker: notYetTrackerSink(""),
    github: { get: async () => ({ ok: false, reason: "no network" }) },
  });
}

function answers(over: Record<string, Priority> = {}): Record<string, Priority> {
  return { ...Object.fromEntries(CONCERN_NAMES.map((c) => [c, "normal" as Priority])), ...over };
}

/** The interview's write, a minute after the last. */
function tune(over: Record<string, Priority>): ApplyResult {
  now = new Date(now.getTime() + 60_000);
  const r = engine().profileApply({
    profile: "acme",
    priorities: answers(over),
    goals: "a payments API",
    write: true,
  });
  if (!r.ok) throw new Error(`refused: ${(r as Refusal).errors.join("; ")}`);
  return r;
}

// ---- a fake PR, a fake runner ------------------------------------------------

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const PATCH =
  "@@ -1,2 +1,4 @@\n def check(t):\n-    return t\n+    if not t:\n+        raise ValueError\n+    return t\n";

function pr(n = 7): ReplayPr {
  return {
    number: n,
    title: "Harden token check",
    body: "Fixes the empty token path.",
    state: "closed",
    merged: true,
    head_sha: HEAD,
    base_sha: BASE,
    merge_commit_sha: null,
  };
}

/** The PR's tree in the temp dir: one auth file, its diff beside it. */
function tree(): ReplayTree {
  const root = join(dir, "tree");
  write(
    join(root, "svc/auth/token.py"),
    "def check(t):\n    if not t:\n        raise ValueError\n    return t\n",
  );
  const diffPath = join(dir, "pr.diff");
  const diff = `diff --git a/svc/auth/token.py b/svc/auth/token.py\n--- a/svc/auth/token.py\n+++ b/svc/auth/token.py\n${PATCH}`;
  write(diffPath, diff);
  return {
    sha: HEAD,
    base: BASE,
    root,
    diffPath,
    diffLines: diff.split("\n").length,
    files: parseUnifiedDiff(diff),
    lines: (p) => (p === "svc/auth/token.py" ? 4 : null),
  };
}

const FILE = "svc/auth/token.py";

function block(
  lens: string,
  items: Array<{ line: number; kind: string; severity: string; claim: string }>,
): string {
  if (items.length === 0) return `FINDINGS ${lens} PR#7 @${HEAD}\nNONE`;
  return [
    `FINDINGS ${lens} PR#7 @${HEAD}`,
    ...items.map(
      (i) =>
        `- path: ${FILE}\n  line: ${i.line}\n  kind: ${i.kind}\n  severity: ${i.severity}\n  claim: ${i.claim}`,
    ),
  ].join("\n");
}

interface Call {
  agentsDir: string;
  spec: CaseSpec;
}

/** Each lens answers by its name — the security lens says more when its
 * built body carries the profile's P0 ceiling (the tuning, as the leaf would
 * read it); the validator keeps every candidate but doubts the tests lens's. */
function fakeRunner(calls: Call[], cost: (spec: CaseSpec) => number | null = () => 0.0001) {
  return (agentsDir: string): CaseRunner => ({
    run: async (
      spec: CaseSpec,
      _signal: AbortSignal,
      onCost?: (spent: number) => void,
    ): Promise<CaseOutcome> => {
      calls.push({ agentsDir, spec });
      const c = cost(spec);
      if (c !== null) onCost?.(c);
      const lens = spec.agent.replace(/--.*$/, "");
      let output: string;
      if (lens === VALIDATE_PASS) {
        const part = spec.prompt
          .split("candidate finding(s):\n")[1]!
          .split("\n\nValidate every")[0]!;
        const items = part.split(/\n(?=- path:)|\n\n/).filter((x) => x.startsWith("- path:"));
        const kept = items.filter((x) => !/kind: tests/.test(x));
        const doubted = items.filter((x) => /kind: tests/.test(x));
        output = [
          `FINDINGS ${VALIDATE_PASS} PR#7 @${HEAD}`,
          ...kept,
          "DOUBTED",
          ...doubted.map(() => `- pass-tests ${FILE}:2 — refuted: the test already covers it`),
          "KILLED",
          "NONE",
        ].join("\n");
      } else if (lens === "pass-baseline") {
        output = block(lens, [
          {
            line: 2,
            kind: "correctness",
            severity: "P2",
            claim: "An empty token raises instead of returning a 401.",
          },
        ]);
      } else if (lens === "pass-security") {
        output = block(lens, [
          {
            line: 1,
            kind: "authz",
            severity: "P1",
            claim: "The check accepts any non-empty token.",
          },
          ...(readFileSync(join(agentsDir, `${spec.agent}.md`), "utf8").includes(
            "Severity ceiling for `pass-security`: `P0`",
          )
            ? [
                {
                  line: 4,
                  kind: "timing",
                  severity: "P2",
                  claim: "The comparison is not constant-time.",
                },
              ]
            : []),
        ]);
      } else if (lens === "pass-tests") {
        output = block(lens, [
          { line: 2, kind: "tests", severity: "P3", claim: "No test covers the empty token." },
        ]);
      } else output = block(lens, []);
      return { ok: true, output, cost_usd: c };
    },
  });
}

function runner(
  calls: Call[],
  cost?: (spec: CaseSpec) => number | null,
  transform?: (spec: CaseSpec, outcome: CaseOutcome) => CaseOutcome,
): ReplayRunner {
  const state = stateHomeFs(stateRoot());
  return new ReplayRunner({
    state,
    clock: () => now,
    source: {
      pr: async (n) =>
        n === 404 ? { ok: false, reason: "GitHub answered 404" } : { ok: true, pr: pr(n) },
      open: () => ({ ok: true, tree: tree() }),
    },
    sides: (req) =>
      replaySides({ root: sandbox, env, stateRoot: stateRoot(), state, clock: () => now }, req),
    cases: (agentsDir) => {
      const inner = fakeRunner(calls, cost)(agentsDir);
      return {
        run: async (spec, signal, onCost) => {
          const result = await inner.run(spec, signal, onCost);
          return transform ? transform(spec, result) : result;
        },
      };
    },
    styleGuide: () => [],
    concurrency: 2,
  });
}

function previewOf(r: { ok: true; preview: ReplayPreview } | Refusal): ReplayPreview {
  if (!r.ok) throw new Error(`refused: ${r.errors.join("; ")}`);
  return r.preview;
}

async function ran(rr: ReplayRunner, key: string): Promise<ReplayRun> {
  const s = await rr.start({ key });
  if (!s.ok) throw new Error(`refused: ${s.errors.join("; ")}`);
  await rr.idle();
  return rr.status().run!;
}

// ---- baselines ------------------------------------------------------------------

describe("every profile write records the profile it replaces", () => {
  it("a write that creates the profile records that it did not exist and what the config named", () => {
    const r = tune({ security: "critical" });
    expect(r.baseline).toEqual({ id: r.commit!.id });
    const b = readBaselines(stateHomeFs(stateRoot()));
    if (b.state !== "ok") throw new Error(b.error);
    expect(b.baselines).toEqual([
      {
        id: r.commit!.id,
        taken_at: now.toISOString(),
        profile: "acme",
        existed: false,
        files: { "profile.toml": null },
        config_named: "",
      },
    ]);
  });

  it("a later write records the file as it was — and an unchanged write records nothing", () => {
    tune({ security: "critical" });
    const before = readFileSync(join(configHome(env), "profiles/acme/profile.toml"), "utf8");
    const second = tune({ security: "critical", tests: "ignore" });
    tune({ security: "critical", tests: "ignore" }); // nothing changes
    const b = readBaselines(stateHomeFs(stateRoot()));
    if (b.state !== "ok") throw new Error(b.error);
    expect(b.baselines).toHaveLength(2);
    expect(b.baselines[1]).toMatchObject({
      id: second.commit!.id,
      existed: true,
      files: { "profile.toml": before },
    });
  });

  it("a profile directory with no profile.toml yet exists: the write records it, and the old side is that profile", () => {
    const acme = join(configHome(env), "profiles", "acme");
    write(join(acme, "NOTES.md"), "an addenda-only profile\n");
    mkdirSync(join(acme, "addenda"), { recursive: true });
    liveConfig("acme");
    const r = tune({ security: "critical" });
    const b = readBaselines(stateHomeFs(stateRoot()));
    if (b.state !== "ok") throw new Error(b.error);
    expect(b.baselines[0]).toMatchObject({ id: r.commit!.id, existed: true });
    const sides = replaySides(
      {
        root: sandbox,
        env,
        stateRoot: stateRoot(),
        state: stateHomeFs(stateRoot()),
        clock: () => now,
      },
      { old: null, new_profile: null },
    );
    if (!sides.ok) throw new Error(sides.errors.join("; "));
    expect(sides.sides.old).toMatchObject({ profile: "acme", baseline: r.commit!.id });
    expect(sides.sides.old.cfg.lenses?.["pass-security"]).toBeUndefined();
  });

  it("an unreadable baselines file is never overwritten, and the write still lands", () => {
    write(join(stateRoot(), PROFILE_BASELINES_FILE), "{not json");
    const r = tune({ security: "critical" });
    expect(r.written).toBe(true);
    expect(r.baseline).toMatchObject({ error: expect.stringContaining("not recorded") });
    // …and the companion is TOLD, not left to find out at the replay's preview.
    expect(renderApply(r)).toContain("pass old explicitly");
    expect(renderApply(tune({ security: "critical", tests: "ignore" }))).not.toContain(
      "kept for a replay",
    );
    expect(readFileSync(join(stateRoot(), PROFILE_BASELINES_FILE), "utf8")).toBe("{not json");
  });
});

// ---- the sides -------------------------------------------------------------------

describe("the two sides resolve the way the daemon resolves a profile", () => {
  const state = () => stateHomeFs(stateRoot());
  const sides = (old: string | null = null, newProfile: string | null = null) =>
    replaySides(
      { root: sandbox, env, stateRoot: stateRoot(), state: state(), clock: () => now },
      { old, new_profile: newProfile },
    );

  it("by default: new = the profile setup wrote, old = what reviewed before its last write", () => {
    tune({ security: "critical" });
    const second = tune({ security: "critical", tests: "ignore" });
    const r = sides();
    if (!r.ok) throw new Error(r.errors.join("; "));
    expect(r.sides.new).toMatchObject({ profile: "acme", baseline: null });
    expect(r.sides.old).toMatchObject({ profile: "acme", baseline: second.commit!.id });
    // The old side is the profile BEFORE the second write: security still
    // critical, tests not yet ignored.
    expect(r.sides.old.cfg.lenses?.["pass-security"]).toMatchObject({ min_tier: "sol-high" });
    expect(r.sides.old.cfg.lenses?.["pass-tests"]).toBeUndefined();
    expect(r.sides.new.cfg.lenses?.["pass-tests"]).toEqual({ enabled: false });
    // The real profile is untouched by putting the old one back together.
    expect(readFileSync(join(configHome(env), "profiles/acme/profile.toml"), "utf8")).toContain(
      "[lenses.pass-tests]",
    );
  });

  it("putting the old profile back never writes through a linked profile directory into the live target", () => {
    // profiles/acme is a link into the operator's dotfiles (supported — see
    // setup-interview.test.ts); the writes land in dotfiles/acme.
    const linked = join(dir, "dotfiles", "acme");
    mkdirSync(linked, { recursive: true });
    mkdirSync(join(configHome(env), "profiles"), { recursive: true });
    symlinkSync(linked, join(configHome(env), "profiles", "acme"));
    tune({ security: "critical" });
    tune({ security: "critical", tests: "ignore" });
    const live = readFileSync(join(linked, "profile.toml"), "utf8");
    expect(live).toContain("[lenses.pass-tests]");
    const r = sides();
    if (!r.ok) throw new Error(r.errors.join("; "));
    expect(r.sides.old.cfg.lenses?.["pass-tests"]).toBeUndefined();
    // The live profile is untouched, and the new side still reads it.
    expect(readFileSync(join(linked, "profile.toml"), "utf8")).toBe(live);
    expect(r.sides.new.cfg.lenses?.["pass-tests"]).toEqual({ enabled: false });
  });

  it("…nor through a linked profiles/ directory as a whole", () => {
    const linked = join(dir, "dotfiles", "profiles");
    mkdirSync(linked, { recursive: true });
    mkdirSync(configHome(env), { recursive: true });
    symlinkSync(linked, join(configHome(env), "profiles"));
    tune({ security: "critical" });
    tune({ security: "critical", tests: "ignore" });
    const live = readFileSync(join(linked, "acme", "profile.toml"), "utf8");
    expect(live).toContain("[lenses.pass-tests]");
    const r = sides();
    if (!r.ok) throw new Error(r.errors.join("; "));
    expect(r.sides.old.cfg.lenses?.["pass-tests"]).toBeUndefined();
    expect(readFileSync(join(linked, "acme", "profile.toml"), "utf8")).toBe(live);
    expect(r.sides.new.cfg.lenses?.["pass-tests"]).toEqual({ enabled: false });
  });

  it("a write that created the profile compares against what the config named then — here, none", () => {
    const first = tune({ security: "critical" });
    const r = sides();
    if (!r.ok) throw new Error(r.errors.join("; "));
    expect(r.sides.old).toMatchObject({ profile: "", baseline: first.commit!.id });
    expect(r.sides.old.cfg.lenses).toEqual({});
  });

  it("each side is its own read-only PR build: the profile's tuning in the new one alone, no scan-mode rule in either", () => {
    tune({ security: "critical" });
    const r = sides();
    if (!r.ok) throw new Error(r.errors.join("; "));
    const newSec = r.sides.new.agentText("pass-security--sol-high")!;
    expect(newSec).toContain("Severity ceiling for `pass-security`: `P0`");
    expect(r.sides.old.agentText("pass-security--sol-high")).not.toContain(
      "Severity ceiling for `pass-security`",
    );
    for (const side of ["old", "new"] as const) {
      const out = join(stateRoot(), REPLAY_AGENTS_DIR, side);
      for (const f of readdirSync(out)) {
        const text = readFileSync(join(out, f), "utf8");
        expect(/^tools:\s*(.*)$/m.exec(text)?.[1], f).toBe(SCAN_LEAF_TOOLS.join(", "));
        expect(text, f).not.toContain("Scan mode — there is no pull request");
      }
    }
    // A lens the profile does not touch builds to the same bytes on both sides.
    expect(r.sides.old.agentText("pass-baseline--sol-med")).toBe(
      r.sides.new.agentText("pass-baseline--sol-med"),
    );
  });

  it("each side builds its models the way the daemon does: a [models.pass_models] move included", () => {
    tune({ security: "critical" });
    const path = join(configHome(env), "config.toml");
    write(
      path,
      `${readFileSync(path, "utf8")}\n[models.pass_models]\n"pass-baseline" = "openai-codex/moved-model"\n`,
    );
    const r = sides();
    if (!r.ok) throw new Error(r.errors.join("; "));
    for (const side of ["old", "new"] as const)
      expect(
        /^model:\s*(.*)$/m.exec(r.sides[side].agentText("pass-baseline--sol-med")!)?.[1],
      ).toMatch(/^openai-codex\/moved-model/);
  });

  it("old may name a write, another profile, or none; anything else is refused with the choices", () => {
    const first = tune({ security: "critical" });
    tune({ security: "critical", tests: "ignore" });
    const byId = sides(first.commit!.id);
    expect(byId.ok && byId.sides.old.profile).toBe("");
    const other = sides("profile:minimal");
    expect(other.ok && other.sides.old).toMatchObject({ profile: "minimal", baseline: null });
    const none = sides("none");
    expect(none.ok && none.sides.old.profile).toBe("");
    const bad = sides("no-such-write");
    expect(bad.ok).toBe(false);
    expect(!bad.ok && bad.errors.join("\n")).toContain(first.commit!.id);
    const missing = sides("profile:nope");
    expect(!missing.ok && missing.errors.join("\n")).toContain("would not load");
    expect(sides("profile:../x").ok).toBe(false);
  });

  it("an earlier write by id unwinds every LATER write too — a file only a later write changed reads as before", () => {
    // Restoring only the named write's files would leave a style guide a
    // LATER write redrafted at its current text on the "old" side.
    now = new Date(now.getTime() + 60_000);
    const w = (over: Record<string, Priority>, guide?: string): ApplyResult => {
      now = new Date(now.getTime() + 60_000);
      const r = engine().profileApply({
        profile: "acme",
        priorities: answers(over),
        goals: "a payments API",
        write: true,
        ...(guide ? { style_guide: guide } : {}),
      });
      if (!r.ok) throw new Error((r as Refusal).errors.join("; "));
      return r;
    };
    w({ security: "critical" }, "# Guide v1\n");
    const second = w({ security: "critical", tests: "ignore" });
    w({ security: "critical", tests: "ignore" }, "# Guide v2\n");
    expect(readFileSync(join(configHome(env), "profiles/acme/style-guide.md"), "utf8")).toBe(
      "# Guide v2\n",
    );
    const r = sides(second.commit!.id);
    if (!r.ok) throw new Error(r.errors.join("; "));
    const home = join(stateRoot(), REPLAY_HOME_DIR, "profiles/acme");
    expect(readFileSync(join(home, "style-guide.md"), "utf8")).toBe("# Guide v1\n");
    expect(readFileSync(join(home, "profile.toml"), "utf8")).not.toContain("[lenses.pass-tests]");
  });

  it("with no write recorded and no profile, there is nothing to compare", () => {
    const r = sides();
    expect(!r.ok && r.errors[0]).toContain("no profile to replay");
    liveConfig("minimal");
    const r2 = sides();
    expect(!r2.ok && r2.errors.join("\n")).toContain('no write to profile "minimal" was recorded');
    const r3 = sides("none");
    expect(r3.ok && r3.sides.new.profile).toBe("minimal");
  });
});

// ---- the replay ------------------------------------------------------------------

describe("replay: cost first, subagents, side by side", () => {
  beforeEach(() => {
    tune({ security: "critical" });
    tune({ security: "critical", tests: "ignore" });
  });

  it("the preview plans each side as a round would, prices it, runs nothing — shared cases once", async () => {
    const calls: Call[] = [];
    const p = previewOf(await runner(calls).preview({ prs: [7], old: "none" }));
    expect(calls).toEqual([]);
    const plans = p.prs[0]!.plans;
    const row = (side: "old" | "new", lens: string) => plans[side].find((r) => r.lens === lens);
    // The profile's effect on the plan: the tests lens off; the security lens
    // (a risk pass, sol-high on both) built differently — its own case.
    expect(row("old", "pass-tests")).toBeDefined();
    expect(row("new", "pass-tests")).toBeUndefined();
    expect(row("new", "pass-security")!.tier).toBe("sol-high");
    expect(row("old", "pass-security")!.case).not.toBe(row("new", "pass-security")!.case);
    // A lens the profile does not touch is ONE case, planned on both sides.
    const base = p.cases.find((c) => c.lens === "pass-baseline")!;
    expect(base.sides.sort()).toEqual(["new", "old"]);
    expect(plans.old.find((r) => r.lens === "pass-baseline")!.case).toBe(
      plans.new.find((r) => r.lens === "pass-baseline")!.case,
    );
    expect(p.shared).toBeGreaterThan(0);
    // The cost: every case priced, the total and the hard cap stated.
    expect(p.cases.every((c) => c.estimate_usd > 0)).toBe(true);
    expect(p.estimate_usd).toBeCloseTo(
      p.cases.reduce((t, c) => t + c.estimate_usd, 0),
      3,
    );
    expect(p.cap_usd).toBeCloseTo(p.estimate_usd * REPLAY_CAP_FACTOR, 3);
    expect(p.rate_bases).toEqual([REFERENCE_BASIS]);
    const shown = renderReplayPreview(p);
    expect(shown).toContain(`Estimate $${p.estimate_usd.toFixed(2)}`);
    expect(shown).toContain(`key ${p.key}`);
    expect(shown).toContain("the same on both, run once");
  });

  it("start needs the preview's key, and refuses once anything moved since", async () => {
    const calls: Call[] = [];
    const rr = runner(calls);
    expect(await rr.start({})).toMatchObject({ ok: false });
    const p = previewOf(await rr.preview({ prs: [7], old: "none" }));
    expect(await rr.start({ key: "nope" })).toMatchObject({ ok: false });
    tune({ security: "important", tests: "ignore" }); // the profile moved
    const moved = await rr.start({ key: p.key });
    expect(!moved.ok && moved.errors[0]).toContain("changed since that preview");
    expect(calls).toEqual([]);
  });

  it("runs every case as a subagent from its side's build, then shows the two reviews side by side", async () => {
    const calls: Call[] = [];
    const rr = runner(calls);
    const p = previewOf(await rr.preview({ prs: [7], old: "none" }));
    const run = await ran(rr, p.key);
    expect(run.state).toBe("complete");
    // One call per case — the shared ones once — each from a side's build.
    expect(calls).toHaveLength(p.cases.length);
    const oldDir = join(stateRoot(), REPLAY_AGENTS_DIR, "old");
    const newDir = join(stateRoot(), REPLAY_AGENTS_DIR, "new");
    // The security lens differs by side, so each side's build runs its own.
    expect(
      calls
        .filter((c) => c.spec.agent === "pass-security--sol-high")
        .map((c) => c.agentsDir)
        .sort(),
    ).toEqual([newDir, oldDir]);
    expect(calls.find((c) => c.spec.agent.startsWith("pass-tests--"))!.agentsDir).toBe(oldDir);
    // The lens reads the tree and the diff file; the task never says which side.
    const task = calls.find((c) => c.spec.agent.startsWith("pass-baseline--"))!.spec.prompt;
    expect(task).toContain(join(dir, "tree"));
    expect(task).toContain(join(dir, "pr.diff"));
    expect(task).not.toMatch(/\bold\b|\bnew\b.*profile/);

    const [c] = compareRun(run);
    // Both found: the baseline finding (one shared case) and the auth finding.
    expect(c!.both.map((b) => [b.old!.lens, b.old!.severity, b.new!.severity])).toEqual([
      ["pass-security", "P1", "P1"],
      ["pass-baseline", "P2", "P2"],
    ]);
    // Only the old profile ran the tests lens — and its validator doubted it.
    expect(c!.old_only).toHaveLength(1);
    expect(c!.old_only[0]).toMatchObject({
      lens: "pass-tests",
      doubt: { word: "refuted" },
      validated: true,
    });
    // Only the new profile's sol-high security lens saw the timing problem.
    expect(c!.new_only.map((f) => [f.lens, f.kind])).toEqual([["pass-security", "timing"]]);
    expect(c!.cost.shared).toBeGreaterThan(0);

    const shown = renderReplayStatus(rr.status());
    expect(shown).toContain("COMPLETE");
    expect(shown).toContain("Both found (2)");
    expect(shown).toContain("Only the OLD profile (1)");
    expect(shown).toContain("MAY NOT BE VALID (refuted)");
    expect(shown).toContain("Only the NEW profile (1)");
  });

  it("keeps candidates unvalidated when the replay validator opened no PR code", async () => {
    const rr = runner([], undefined, (spec, outcome) =>
      spec.agent.startsWith(`${VALIDATE_PASS}--`)
        ? { ok: true, output: "FINDINGS pass-validate PR#7 @sha\nNONE", cost_usd: 0.001, reads: [] }
        : outcome,
    );
    const p = previewOf(await rr.preview({ prs: [7], old: "none" }));
    const run = await ran(rr, p.key);
    expect(run.cases.filter((c) => c.kind === "validate").every((c) => c.status === "failed")).toBe(
      true,
    );
    const compared = compareRun(run)[0]!;
    expect(compared.findings.new.length).toBeGreaterThan(0);
    expect(compared.findings.new.every((f) => !f.validated)).toBe(true);
  });

  it("a validator that judges nothing fails its case — the side keeps its lenses' candidates, never an empty review", async () => {
    const calls: Call[] = [];
    const inner = fakeRunner(calls);
    const rr = new ReplayRunner({
      state: stateHomeFs(stateRoot()),
      clock: () => now,
      source: {
        pr: async (n) => ({ ok: true, pr: pr(n) }),
        open: () => ({ ok: true, tree: tree() }),
      },
      sides: (req) =>
        replaySides(
          {
            root: sandbox,
            env,
            stateRoot: stateRoot(),
            state: stateHomeFs(stateRoot()),
            clock: () => now,
          },
          req,
        ),
      cases: (agentsDir) => ({
        run: async (spec, signal, onCost) =>
          spec.agent.startsWith(`${VALIDATE_PASS}--`)
            ? { ok: true, output: "I could not finish the validation.", cost_usd: 0.0001 }
            : inner(agentsDir).run(spec, signal, onCost),
      }),
      styleGuide: () => [],
      concurrency: 2,
    });
    const p = previewOf(await rr.preview({ prs: [7], old: "none" }));
    const run = await ran(rr, p.key);
    const validations = run.cases.filter((c) => c.kind === "validate");
    expect(validations.length).toBeGreaterThan(0);
    for (const v of validations) {
      expect(v.status).toBe("failed");
      expect(v.error).toContain("no survivor, NONE, DOUBTED or KILLED");
      expect(v.killed ?? 0).toBe(0);
    }
    const [c] = compareRun(run);
    expect(c!.complete).toEqual({ old: false, new: false });
    expect(c!.findings.new.length).toBeGreaterThan(0);
    expect(c!.findings.new.every((f) => !f.validated)).toBe(true);
  });

  it("a lens answering with neither findings nor NONE fails its case — the side is incomplete, never a clean review", async () => {
    const calls: Call[] = [];
    const inner = fakeRunner(calls);
    const rr = new ReplayRunner({
      state: stateHomeFs(stateRoot()),
      clock: () => now,
      source: {
        pr: async (n) => ({ ok: true, pr: pr(n) }),
        open: () => ({ ok: true, tree: tree() }),
      },
      sides: (req) =>
        replaySides(
          {
            root: sandbox,
            env,
            stateRoot: stateRoot(),
            state: stateHomeFs(stateRoot()),
            clock: () => now,
          },
          req,
        ),
      cases: (agentsDir) => ({
        run: async (spec, signal, onCost) =>
          spec.agent.startsWith("pass-baseline--")
            ? { ok: true, output: "I could not finish.", cost_usd: 0.0001 }
            : inner(agentsDir).run(spec, signal, onCost),
      }),
      styleGuide: () => [],
      concurrency: 2,
    });
    const p = previewOf(await rr.preview({ prs: [7], old: "none" }));
    const run = await ran(rr, p.key);
    const baseline = run.cases.filter((c) => c.kind === "lens" && c.lens === "pass-baseline");
    expect(baseline.length).toBeGreaterThan(0);
    for (const b of baseline) {
      expect(b.status).toBe("failed");
      expect(b.error).toContain("no finding and no NONE line");
    }
    expect(run.state).not.toBe("complete");
    const [c] = compareRun(run);
    expect(c!.complete).toEqual({ old: false, new: false });
  });

  it("a case refused only while another's reservation is in flight is run once it settles — and the validators still run", async () => {
    // Cap $0.06; each lens and validator is estimated at ~$0.0056. The first
    // case costs $0.05 while the second is still in flight: the third does not
    // fit beside the second's reservation, but fits once it settles cheaply.
    const calls: Call[] = [];
    const base = fakeRunner(calls, () => 0.0001);
    let n = 0;
    const rr = new ReplayRunner({
      state: stateHomeFs(stateRoot()),
      clock: () => now,
      source: {
        pr: async (k) => ({ ok: true, pr: pr(k) }),
        open: () => ({ ok: true, tree: tree() }),
      },
      sides: (req) =>
        replaySides(
          {
            root: sandbox,
            env,
            stateRoot: stateRoot(),
            state: stateHomeFs(stateRoot()),
            clock: () => now,
          },
          req,
        ),
      cases: (agentsDir) => ({
        run: async (spec, signal, onCost) => {
          const k = ++n;
          if (k === 2) await new Promise((r) => setTimeout(r, 30));
          const out = await base(agentsDir).run(spec, signal, onCost);
          return k === 1 ? { ...out, cost_usd: 0.05 } : out;
        },
      }),
      styleGuide: () => [],
      concurrency: 2,
    });
    const p = previewOf(await rr.preview({ prs: [7], old: "none" }));
    expect(p.cap_usd).toBeCloseTo(0.06, 6);
    const run = await ran(rr, p.key);
    expect(run.cases.filter((c) => c.kind === "validate").map((c) => c.status)).toEqual([
      "done",
      "done",
    ]);
    expect(run.state).toBe("complete");
  });

  it("stops HARD at the cap: what is in flight is aborted, the rest never starts", async () => {
    const calls: Call[] = [];
    const rr = runner(calls, () => 100); // every case costs far past any estimate
    const p = previewOf(await rr.preview({ prs: [7], old: "none" }));
    const run = await ran(rr, p.key);
    expect(run.state).toBe("capped");
    expect(calls.length).toBeLessThan(p.cases.length);
    expect(run.cases.some((c) => c.status === "skipped")).toBe(true);
  });

  it("a background failure aborts every case still in flight — none goes on spending past the run", async () => {
    // One lane's store failure rejects the drive; the other lane's case must
    // not keep running, unaborted, after the run has settled.
    const real = stateHomeFs(stateRoot());
    let failing = false;
    const state = {
      ...real,
      location: real.location,
      write: (rel: string, text: string) => {
        if (failing) throw new Error("disk full");
        real.write(rel, text);
      },
    } as typeof real;
    let first = true;
    const aborted: boolean[] = [];
    const rr = new ReplayRunner({
      state,
      clock: () => now,
      source: {
        pr: async (n) => ({ ok: true, pr: pr(n) }),
        open: () => ({ ok: true, tree: tree() }),
      },
      sides: (req) =>
        replaySides(
          { root: sandbox, env, stateRoot: stateRoot(), state: real, clock: () => now },
          req,
        ),
      cases: () => ({
        run: async (spec: CaseSpec, signal: AbortSignal): Promise<CaseOutcome> => {
          if (first) {
            first = false;
            await new Promise((r) => setTimeout(r, 10));
            failing = true;
            return {
              ok: true,
              output: block(spec.agent.replace(/--.*$/, ""), []),
              cost_usd: 0.0001,
            };
          }
          await new Promise<void>((r) =>
            signal.aborted ? r() : signal.addEventListener("abort", () => r(), { once: true }),
          );
          aborted.push(signal.aborted);
          return { ok: false, reason: "stopped", cost_usd: 0 };
        },
      }),
      styleGuide: () => [],
      concurrency: 2,
    });
    const p = previewOf(await rr.preview({ prs: [7], old: "none" }));
    const s = await rr.start({ key: p.key });
    expect(s.ok).toBe(true);
    await rr.idle();
    await new Promise((r) => setTimeout(r, 0));
    expect(aborted).toEqual([true]);
  });

  it("a lens's relative read that opened the APP's file is not credited as reading the PR — and is said", async () => {
    const calls: Call[] = [];
    const base = fakeRunner(calls);
    const rr = new ReplayRunner({
      state: stateHomeFs(stateRoot()),
      clock: () => now,
      source: {
        pr: async (n) => ({ ok: true, pr: pr(n) }),
        open: () => ({ ok: true, tree: tree() }),
      },
      sides: (req) =>
        replaySides(
          {
            root: sandbox,
            env,
            stateRoot: stateRoot(),
            state: stateHomeFs(stateRoot()),
            clock: () => now,
          },
          req,
        ),
      cases: (agentsDir) => ({
        run: async (spec, signal, onCost) => {
          const out = await base(agentsDir).run(spec, signal, onCost);
          if (!out.ok) return out;
          // The runner reports reads RESOLVED against its cwd (the app root):
          // the baseline lens named `svc/auth/token.py` relatively, so it
          // opened the app's copy; every other lens opened the worktree's.
          const reads = spec.agent.startsWith("pass-baseline--")
            ? ["/workspace/svc/auth/token.py"]
            : [join(dir, "tree", FILE), join(dir, "pr.diff")];
          return { ...out, reads };
        },
      }),
      styleGuide: () => [],
      concurrency: 2,
    });
    const run = await ran(rr, previewOf(await rr.preview({ prs: [7], old: "none" })).key);
    const baseline = run.cases.find((c) => c.agent.startsWith("pass-baseline--"))!;
    expect(baseline.reads).toEqual({ pr: 0, elsewhere: 1 });
    // It read none of the PR: not a finished review, whatever it answered.
    expect(baseline).toMatchObject({
      status: "failed",
      error: expect.stringMatching(/opened none of PR #7's files/),
    });
    const other = run.cases.find(
      (c) => c.kind === "lens" && !c.agent.startsWith("pass-baseline--"),
    )!;
    expect(other.reads).toEqual({ pr: 2, elsewhere: 0 });
    expect(run.problems.filter((p) => p.includes("outside PR #7's worktree"))).toEqual([
      expect.stringMatching(
        /pass-baseline — read none of PR #7's files: 1 file read opened outside PR #7's worktree \(\/workspace\/svc\/auth\/token\.py\)/,
      ),
    ]);
  });

  it("a lens that made no file read at all is no finished review: its side reads incomplete", async () => {
    const calls: Call[] = [];
    const base = fakeRunner(calls);
    const rr = new ReplayRunner({
      state: stateHomeFs(stateRoot()),
      clock: () => now,
      source: {
        pr: async (n) => ({ ok: true, pr: pr(n) }),
        open: () => ({ ok: true, tree: tree() }),
      },
      sides: (req) =>
        replaySides(
          {
            root: sandbox,
            env,
            stateRoot: stateRoot(),
            state: stateHomeFs(stateRoot()),
            clock: () => now,
          },
          req,
        ),
      cases: (agentsDir) => ({
        run: async (spec, signal, onCost) => {
          const out = await base(agentsDir).run(spec, signal, onCost);
          if (!out.ok) return out;
          return {
            ...out,
            reads: spec.agent.startsWith("pass-baseline--") ? [] : [join(dir, "tree", FILE)],
          };
        },
      }),
      styleGuide: () => [],
      concurrency: 2,
    });
    const run = await ran(rr, previewOf(await rr.preview({ prs: [7], old: "none" })).key);
    const baseline = run.cases.filter((c) => c.agent.startsWith("pass-baseline--"));
    expect(baseline.length).toBeGreaterThan(0);
    for (const c of baseline)
      expect(c).toMatchObject({
        status: "failed",
        error: expect.stringMatching(/opened none of PR #7's files \(0 file-read calls/),
      });
    expect(compareRun(run)[0]!.complete).toEqual({ old: false, new: false });
  });

  it("a finished replay prices the next preview from what it measured", async () => {
    const rr = runner([], () => 0.5);
    const p = previewOf(await rr.preview({ prs: [7], old: "none" }));
    await ran(rr, previewOf(await rr.preview({ prs: [7], old: "none" })).key);
    const again = previewOf(await rr.preview({ prs: [7], old: "none" }));
    expect(
      again.rate_bases.some((b) => b.startsWith("measured on this install's last replay")),
    ).toBe(true);
    expect(again.key).not.toBe(p.key);
  });

  it("refuses more than two PRs, a PR GitHub will not give, and a second start while one runs", async () => {
    const rr = runner([]);
    expect(await rr.preview({ prs: [1, 2, 3] })).toMatchObject({ ok: false });
    expect(await rr.preview({ prs: [] })).toMatchObject({ ok: false });
    expect(await rr.preview({ prs: [7, 7] })).toMatchObject({ ok: false });
    const gone = await rr.preview({ prs: [404], old: "none" });
    expect(!gone.ok && gone.errors[0]).toContain("PR #404");
    const p = previewOf(await rr.preview({ prs: [7], old: "none" }));
    const s = await rr.start({ key: p.key });
    expect(s.ok).toBe(true);
    expect(await rr.start({ key: p.key })).toMatchObject({ ok: false });
    expect(await rr.preview({ prs: [7], old: "none" })).toMatchObject({ ok: false });
    await rr.idle();
  });

  it("refuses a preview while a start is planning shared trees and agents", async () => {
    const rr = runner([]);
    const p = previewOf(await rr.preview({ prs: [7], old: "none" }));
    const starting = rr.start({ key: p.key });
    const competing = await rr.preview({ prs: [8], old: "none" });
    expect(competing.ok).toBe(false);
    expect((await starting).ok).toBe(true);
    await rr.idle();
  });

  it("two starts issued together launch one run: the second is refused while the first plans", async () => {
    const rr = runner([]);
    const p = previewOf(await rr.preview({ prs: [7], old: "none" }));
    const [a, b] = await Promise.all([rr.start({ key: p.key }), rr.start({ key: p.key })]);
    expect([a.ok, b.ok]).toEqual([true, false]);
    expect(!b.ok && b.errors[0]).toMatch(/already starting/);
    await rr.idle();
  });

  it("the companion's tools: preview states the cost, start takes its key, status shows the comparison", async () => {
    const rr = runner([]);
    const tools = new Map(replayToolDefinitions(rr).map((t) => [t.name, t]));
    expect([...tools.keys()]).toEqual([
      "setup_replay_preview",
      "setup_replay_start",
      "setup_replay_status",
      "setup_replay_stop",
    ]);
    const text = (r: { content: Array<{ text?: string }> }): string =>
      r.content.map((c) => c.text ?? "").join("");
    const pv = await tools.get("setup_replay_preview")!.execute("1", { prs: [7], old: "none" });
    const key = (pv.details as { preview: { key: string } }).preview.key;
    expect(text(pv)).toContain("It stops HARD at");
    const started = await tools.get("setup_replay_start")!.execute("2", { key });
    expect(text(started)).toContain("started");
    await rr.idle();
    expect(text(await tools.get("setup_replay_status")!.execute("3", {}))).toContain(
      "Only the NEW profile",
    );
    expect(text(await tools.get("setup_replay_stop")!.execute("4", {}))).toContain("refused");
  });
});

// ---- the rules -------------------------------------------------------------------

describe("replay rules", () => {
  const f = (over: Partial<ReplayFinding>): ReplayFinding => ({
    path: "a.py",
    start: 10,
    end: 10,
    kind: "bug",
    severity: "P2",
    confidence: null,
    reachability: null,
    capped_from: null,
    claim: "c",
    evidence: null,
    fix: null,
    detail: null,
    lens: "pass-baseline",
    doubt: null,
    validated: false,
    ...over,
  });

  it("a shared cost the runner could not price reads UNKNOWN, never vanishes", () => {
    const c = {
      pr: 7,
      title: "t",
      findings: { old: [], new: [] },
      complete: { old: true, new: true },
      both: [],
      old_only: [],
      new_only: [],
    };
    const sides = {
      old: { profile: "", basis: "b", baseline: null },
      new: { profile: "acme", basis: "b", baseline: null },
    };
    expect(renderComparison({ ...c, cost: { old: 1, new: 2, shared: null } }, sides)).toContain(
      "+ unknown shared",
    );
    expect(renderComparison({ ...c, cost: { old: 1, new: 2, shared: 0 } }, sides)).not.toContain(
      "shared",
    );
  });

  it("pairs the same finding across sides within a few lines; never one finding twice", () => {
    const r = compareFindings(
      [f({ start: 10, end: 10 }), f({ path: "b.py" })],
      [f({ start: 12, end: 12, severity: "P1" }), f({ start: 11, end: 11 }), f({ path: "c.py" })],
    );
    expect(r.both).toHaveLength(1);
    expect(r.both[0]!.new!.severity).toBe("P1");
    expect(r.old_only.map((x) => x.path)).toEqual(["b.py"]);
    expect(r.new_only.map((x) => x.path).sort()).toEqual(["a.py", "c.py"]);
  });

  it("a validator's answer keeps survivors under their lens, marks doubts, and counts the killed", () => {
    const cands = [
      f({ lens: "pass-security", kind: "authz", start: 3, end: 3 }),
      f({ start: 20, end: 20 }),
      f({ path: "b.py", start: 5, end: 5 }),
    ];
    const v = validated(
      "FINDINGS pass-validate PR#1 @x\n- path: a.py\n  line: 3\n  kind: authz\n  severity: P1\n  claim: kept\nDOUBTED\n- pass-baseline a.py:20 — unverifiable: cannot see the caller\nKILLED\n- b.py:5 duplicate",
      "/t",
      cands,
    );
    expect(v.findings.map((x) => [x.lens, x.severity, x.doubt?.word ?? null])).toEqual([
      ["pass-security", "P1", null],
      ["pass-baseline", "P2", "unverifiable"],
    ]);
    expect([v.kept, v.doubted, v.killed]).toEqual([1, 1, 1]);
  });

  it("a validity veto written under KILLED is a doubt, kept — only other kills drop", () => {
    const cands = [f({ start: 20, end: 20 }), f({ path: "b.py", start: 5, end: 5 })];
    const v = validated(
      "FINDINGS pass-validate PR#1 @x\nNONE\nKILLED\n- pass-baseline a.py:20 — refuted: the caller checks it\n- b.py:5 duplicate",
      "/t",
      cands,
    );
    expect(v.findings.map((x) => [x.path, x.doubt?.word ?? null])).toEqual([["a.py", "refuted"]]);
    expect([v.kept, v.doubted, v.killed]).toEqual([0, 1, 1]);
  });

  it("a validator's prose that judges nothing kills nothing", () => {
    const v = validated("I could not finish the validation.", "/t", [f({}), f({ path: "b.py" })]);
    expect(v).toMatchObject({ answered: false, findings: [], killed: 0 });
  });

  it("reads a unified diff into the files API's shape", () => {
    const diff = [
      "diff --git a/x.py b/x.py",
      "index 1..2 100644",
      "--- a/x.py",
      "+++ b/x.py",
      "@@ -1 +1,2 @@",
      "-a",
      "+b",
      "+c",
      "diff --git a/new.py b/new.py",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/new.py",
      "@@ -0,0 +1 @@",
      "+n",
      "diff --git a/old.py b/moved.py",
      "similarity index 100%",
      "rename from old.py",
      "rename to moved.py",
      "diff --git a/img.png b/img.png",
      "deleted file mode 100644",
      "Binary files a/img.png and /dev/null differ",
      "",
    ].join("\n");
    expect(parseUnifiedDiff(diff)).toEqual([
      {
        filename: "x.py",
        additions: 2,
        deletions: 1,
        status: "modified",
        patch: "@@ -1 +1,2 @@\n-a\n+b\n+c",
      },
      {
        filename: "new.py",
        additions: 1,
        deletions: 0,
        status: "added",
        patch: "@@ -0,0 +1 @@\n+n",
      },
      {
        filename: "moved.py",
        additions: 0,
        deletions: 0,
        status: "renamed",
        previous_filename: "old.py",
      },
      { filename: "img.png", additions: 0, deletions: 0, status: "removed" },
    ]);
  });

  it("a path's own trailing space survives; only git's tab after it goes", () => {
    const diff = [
      "diff --git a/notes  b/notes ",
      "--- a/notes \t",
      "+++ b/notes \t",
      "@@ -1 +1 @@",
      "-a",
      "+b",
      "",
    ].join("\n");
    expect(parseUnifiedDiff(diff).map((f) => f.filename)).toEqual(["notes "]);
  });

  it("reads GitHub's pull answer, and refuses one without a head or base", () => {
    const ok = parsePull(3, {
      number: 3,
      title: "t",
      body: null,
      state: "closed",
      merged_at: "2026-09-01T00:00:00Z",
      merge_commit_sha: "c".repeat(40),
      head: { sha: HEAD },
      base: { sha: BASE },
    });
    expect(ok).toEqual({
      ok: true,
      pr: {
        number: 3,
        title: "t",
        body: "",
        state: "closed",
        merged: true,
        head_sha: HEAD,
        base_sha: BASE,
        merge_commit_sha: "c".repeat(40),
      },
    });
    expect(parsePull(3, { number: 3, head: {}, base: { sha: BASE } }).ok).toBe(false);
    expect(parsePull(3, { number: 4, head: { sha: HEAD }, base: { sha: BASE } }).ok).toBe(false);
  });
});

// ---- the real source, on git -----------------------------------------------------

describe("gitReplaySource (a scratch git repo — git is the thing under test)", () => {
  let repo: string;
  const git = (...args: string[]): string =>
    execFileSync(
      "git",
      [
        "-C",
        repo,
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@t",
        "-c",
        "commit.gpgsign=false",
        ...args,
      ],
      { encoding: "utf8" },
    ).trim();

  beforeEach(() => {
    repo = join(dir, "repo");
    mkdirSync(repo, { recursive: true });
    git("init", "-q");
    write(join(repo, "app/a.py"), "one\ntwo\n");
    git("add", "-A");
    git("commit", "-qm", "base");
  });

  const github = (data: Record<string, unknown>) => ({
    get: async (path: string) => ({ ok: true as const, data: { ...data, path } }),
  });

  it("asks GitHub for the PR on the configured repo only, GET-only through the reader", async () => {
    const seen: string[] = [];
    const src = gitReplaySource({
      github: { get: async (p) => (seen.push(p), { ok: false, reason: "404" }) },
      repo: () => "acme/app",
      repoRoot: repo,
      stateRoot: stateRoot(),
    });
    expect(await src.pr(5)).toEqual({ ok: false, reason: "404" });
    expect(seen).toEqual(["/repos/acme/app/pulls/5"]);
    const bad = gitReplaySource({
      github: github({}),
      repo: "",
      repoRoot: repo,
      stateRoot: stateRoot(),
    });
    expect((await bad.pr(5)).ok).toBe(false);
  });

  it("materialises the head's tree and writes the diff against the merge base", () => {
    const base = git("rev-parse", "HEAD");
    git("checkout", "-qb", "feature");
    write(join(repo, "app/a.py"), "one\ntwo\nthree\n");
    write(join(repo, "app/b.py"), "b\n");
    git("add", "-A");
    git("commit", "-qm", "feature");
    const head = git("rev-parse", "HEAD");
    git("checkout", "-q", "-");
    write(join(repo, "app/c.py"), "base moved\n");
    git("add", "-A");
    git("commit", "-qm", "base moves on");
    const src = gitReplaySource({
      github: github({}),
      repo: "acme/app",
      repoRoot: repo,
      stateRoot: stateRoot(),
    });
    const opened = src.open({ ...pr(), head_sha: head, base_sha: git("rev-parse", "HEAD") }, []);
    if (!opened.ok) throw new Error(opened.reason);
    const t = opened.tree;
    expect(t.base).toBe(base);
    expect(t.root).toBe(join(stateRoot(), REPLAY_TREES_DIR, head));
    expect(readFileSync(join(t.root, "app/a.py"), "utf8")).toBe("one\ntwo\nthree\n");
    expect(existsSync(join(t.root, "app/c.py"))).toBe(false);
    expect(t.files.map((x) => [x.filename, x.status, x.additions])).toEqual([
      ["app/a.py", "modified", 1],
      ["app/b.py", "added", 1],
    ]);
    expect(readFileSync(t.diffPath, "utf8")).toContain("+three");
    expect(t.lines("app/a.py")).toBe(3);
  });

  it("a non-ASCII or quoted path in the diff is the tree's own filename", () => {
    git("checkout", "-qb", "feature");
    write(join(repo, "app/café.py"), "x\n");
    write(join(repo, 'app/say "hi".py'), "y\n");
    git("add", "-A");
    git("commit", "-qm", "names");
    const head = git("rev-parse", "HEAD");
    git("checkout", "-q", "-");
    const src = gitReplaySource({
      github: github({}),
      repo: "acme/app",
      repoRoot: repo,
      stateRoot: stateRoot(),
    });
    const opened = src.open({ ...pr(), head_sha: head, base_sha: git("rev-parse", "HEAD") }, []);
    if (!opened.ok) throw new Error(opened.reason);
    const names = opened.tree.files.map((f) => f.filename).sort();
    expect(names).toEqual(["app/café.py", 'app/say "hi".py'].sort());
    for (const n of names) expect(opened.tree.lines(n)).toBe(1);
  });

  it("two PRs from one head into different bases each keep their own diff", () => {
    const main = git("rev-parse", "HEAD");
    git("checkout", "-qb", "feature");
    write(join(repo, "app/a.py"), "one\ntwo\nfirst\n");
    git("commit", "-qam", "feature 1");
    const f1 = git("rev-parse", "HEAD");
    write(join(repo, "app/a.py"), "one\ntwo\nfirst\nsecond\n");
    git("commit", "-qam", "feature 2");
    const head = git("rev-parse", "HEAD");
    // A second base that already holds the first feature commit.
    git("checkout", "-qb", "release", f1);
    write(join(repo, "app/r.py"), "release\n");
    git("add", "-A");
    git("commit", "-qm", "release");
    const release = git("rev-parse", "HEAD");
    const src = gitReplaySource({
      github: github({}),
      repo: "acme/app",
      repoRoot: repo,
      stateRoot: stateRoot(),
    });
    const a = src.open({ ...pr(), number: 1, head_sha: head, base_sha: main }, [head]);
    const b = src.open({ ...pr(), number: 2, head_sha: head, base_sha: release }, [head]);
    if (!a.ok || !b.ok) throw new Error("not opened");
    expect(a.tree.diffPath).not.toBe(b.tree.diffPath);
    expect(readFileSync(a.tree.diffPath, "utf8")).toContain("+first");
    expect(readFileSync(b.tree.diffPath, "utf8")).not.toContain("+first");
    expect(readFileSync(b.tree.diffPath, "utf8")).toContain("+second");
  });

  it("falls back to the merge commit when the head is gone, and refuses when neither is here", () => {
    write(join(repo, "app/a.py"), "squashed\n");
    git("commit", "-qam", "squash-merged PR");
    const merge = git("rev-parse", "HEAD");
    const src = gitReplaySource({
      github: github({}),
      repo: "acme/app",
      repoRoot: repo,
      stateRoot: stateRoot(),
    });
    const gone = "d".repeat(40);
    const opened = src.open(
      { ...pr(), head_sha: gone, base_sha: gone, merge_commit_sha: merge },
      [],
    );
    if (!opened.ok) throw new Error(opened.reason);
    expect(opened.tree.sha).toBe(merge);
    expect(opened.tree.base).toBe(git("rev-parse", "HEAD^"));
    const missing = src.open(
      { ...pr(), head_sha: gone, base_sha: gone, merge_commit_sha: null },
      [],
    );
    expect(!missing.ok && missing.reason).toContain("pull it on the host");
  });

  it("a base that already contains the head diffs the merge commit, never the head against itself", () => {
    git("checkout", "-qb", "feature");
    write(join(repo, "app/a.py"), "one\ntwo\nthree\n");
    git("commit", "-qam", "feature");
    const head = git("rev-parse", "HEAD");
    git("checkout", "-q", "-");
    git("merge", "-q", "--no-ff", "-m", "merge feature", "feature");
    const merge = git("rev-parse", "HEAD");
    const src = gitReplaySource({
      github: github({}),
      repo: "acme/app",
      repoRoot: repo,
      stateRoot: stateRoot(),
    });
    const opened = src.open(
      { ...pr(), head_sha: head, base_sha: merge, merge_commit_sha: merge },
      [],
    );
    if (!opened.ok) throw new Error(opened.reason);
    expect(opened.tree.sha).toBe(merge);
    expect(opened.tree.base).toBe(git("rev-parse", "HEAD^1"));
    expect(opened.tree.files.map((x) => x.filename)).toEqual(["app/a.py"]);
    const noMerge = src.open(
      { ...pr(), head_sha: head, base_sha: merge, merge_commit_sha: null },
      [],
    );
    expect(noMerge.ok).toBe(false);
    expect(!noMerge.ok && noMerge.reason).toContain("already contains the head");
  });
});

describe("plan row prices", () => {
  it("counts distinct cases even when their displayed prices are equal", async () => {
    tune({ security: "critical" });
    const pr = previewOf(await runner([]).preview({ prs: [7], old: "none" })).prs[0]!;
    const row = pr.plans.old[0]!;
    const distinct = {
      ...pr,
      plans: { old: [{ ...row, case: "old-case" }], new: [{ ...row, case: "new-case" }] },
    };
    expect(renderPlans(distinct, () => "$0.10")).toContain("$0.10 + $0.10");
    expect(
      renderPlans({ ...distinct, plans: { old: [row], new: [row] } }, () => "$0.10"),
    ).not.toContain("$0.10 + $0.10");
  });
});
