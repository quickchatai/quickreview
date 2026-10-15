// The setup interview's tuning: the priority→settings table
// (src/setup/interview.ts), the profile write/validate tools over it
// (src/setup/tuning.ts + profile.ts, driven through SetupEngine), the commit
// hand-off (src/setup/configcommit.ts) and the pin proposals.
//
// What is asserted is external behaviour at the seams the spec names: what a
// profile the tools WROTE makes the plan (`buildPassPlan`) and the built
// agents (`buildAgents`) do — the same resolution wire.ts runs at boot — and
// what the engine writes and returns. The config home is a temp dir; the one
// git repo (`processProfileCommits`) is a scratch repo, git being the thing
// under test there.
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseConfig, type Config } from "../src/config.js";
import { ALL_PASSES, buildPassPlan } from "../src/dispatch.js";
import { NONE_ECOSYSTEM } from "../src/ecosystem.js";
import type { PrFileEntry } from "../src/github.js";
import { PASS_ADDENDA, buildAgents } from "../src/include.js";
import { configHome, type InstallEnv } from "../src/install.js";
import { applyProfileTuning, lensModelOverrides, lensTuningAddenda } from "../src/lenstuning.js";
import type { MemoryEntry, MemoryOp, MemoryStore } from "../src/memory/store.js";
import { loadProfileAddenda, loadProfileLensTuning } from "../src/profiles.js";
import { notYetTrackerSink, stateHomeFs } from "../src/setup/adapters.js";
import { processProfileCommits, refusePath, type GitRun } from "../src/setup/configcommit.js";
import { SetupEngine, type Refusal } from "../src/setup/engine.js";
import {
  CONCERNS,
  CONCERN_NAMES,
  lensDecisions,
  parsePriorities,
  PRIORITY_SETTINGS,
  type Priority,
} from "../src/setup/interview.js";
import { editLensTables } from "../src/setup/profile.js";
import { PIN_PROPOSALS_FILE, parsePinProposals } from "../src/setup/pins.js";
import { INTERVIEW_FILE, type ApplyResult } from "../src/setup/tuning.js";

const sandbox = join(import.meta.dirname, "..");
const fixture: Config = parseConfig(
  readFileSync(resolve(sandbox, "tests/fixtures/config.toml"), "utf8"),
);

let dir: string;
let env: InstallEnv;
let now = new Date("2026-09-29T10:00:00Z");

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "qcr-interview-"));
  env = {
    HOME: join(dir, "home"),
    XDG_CONFIG_HOME: join(dir, "xdg-config"),
    QCR_STATE_HOME: join(dir, "state"),
  };
  now = new Date("2026-09-29T10:00:00Z");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const home = (): string => configHome(env);
const profileDir = (name: string): string => join(home(), "profiles", name);

function write(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

/** The live config, naming `profile` ("" = none). */
function liveConfig(profile: string): void {
  write(
    join(home(), "config.toml"),
    `dry_run = true\n\n[review]\nprofile = ${JSON.stringify(profile)}\n`,
  );
}

function fakeMemory(entries: MemoryEntry[]): MemoryStore {
  return {
    read: async () => entries,
    search: async () => entries,
    apply: async (_op: MemoryOp) => ({
      ok: false,
      message: "the tools under test never write memory",
    }),
  };
}

function engine(memory: MemoryStore | null = null): SetupEngine {
  return new SetupEngine({
    repo: {
      location: "/r",
      listFiles: () => [],
      read: () => null,
      lines: () => null,
      head: () => null,
    },
    state: stateHomeFs(join(dir, "state")),
    profiles: { root: sandbox, env },
    clock: () => now,
    memory,
    cases: { run: async () => ({ ok: false, reason: "no cases here" }) },
    tracker: notYetTrackerSink(""),
    github: { get: async () => ({ ok: false, reason: "no network" }) },
  });
}

/** Every concern at `normal`, then the overrides. */
function answers(over: Record<string, Priority> = {}): Record<string, Priority> {
  return { ...Object.fromEntries(CONCERN_NAMES.map((c) => [c, "normal" as Priority])), ...over };
}

function applied(r: ApplyResult | Refusal): ApplyResult {
  if (!r.ok) throw new Error(`refused: ${r.errors.join("; ")}`);
  return r;
}

/** The config a daemon naming `name` reviews with — wire.ts's overlay. */
function tuned(name: string): Config {
  const cfg = structuredClone(fixture);
  cfg.review.profile = name;
  return applyProfileTuning(cfg, loadProfileLensTuning(sandbox, name, { env }));
}

function agents(cfg: Config): Map<string, string> {
  const out = mkdtempSync(join(tmpdir(), "qcr-interview-build-"));
  try {
    const built = buildAgents(join(sandbox, "agents"), out, {
      root: sandbox,
      tiers: cfg.models.tiers,
      riskPasses: cfg.models.risk_passes,
      validateTier: cfg.models.validate_tier,
      models: lensModelOverrides(cfg.models, cfg.lenses),
      addenda: [
        ...PASS_ADDENDA,
        ...loadProfileAddenda(sandbox, cfg.review.profile, { env }),
        ...lensTuningAddenda(cfg.lenses),
      ],
    });
    return new Map(built.map((b) => [b.name, readFileSync(b.output, "utf8")]));
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

const file = (filename: string, patch = "+x = 1\n"): PrFileEntry => ({
  filename,
  additions: 5,
  deletions: 0,
  status: "modified",
  patch,
});
const AUTH = [file("svc/auth/token.py", "+def check(t): return t\n")];
const plan = (cfg: Config, files: PrFileEntry[]) =>
  buildPassPlan(cfg, files, undefined, NONE_ECOSYSTEM);
const row = (cfg: Config, files: PrFileEntry[], lens: string) =>
  plan(cfg, files).pass_plan.find((p) => p.lens === lens);
const modelOf = (bytes: string | undefined): string | undefined =>
  /^model:\s*(.+)$/m.exec(bytes ?? "")?.[1];

// ---- the table ------------------------------------------------------------------

describe("the priority → settings table", () => {
  it("is the one table: critical blocks at full strength, ignore switches off, normal is the shipped behaviour", () => {
    expect(PRIORITY_SETTINGS).toEqual({
      critical: { enabled: true, min_tier: "sol-high", effort: "high", max_severity: "P0" },
      important: { enabled: true, min_tier: "sol-med", effort: "medium" },
      normal: {},
      ignore: { enabled: false },
    });
  });

  it("names only real lenses, and never the validator, pass-intent or pass-ask-human", () => {
    const named = CONCERNS.flatMap((c) => c.lenses);
    for (const lens of named) expect(ALL_PASSES, lens).toContain(lens);
    for (const lens of ["pass-validate", "pass-intent", "pass-ask-human"])
      expect(named).not.toContain(lens);
    // every risk area the spec names is its own concern
    for (const risk of ["security", "data", "money", "compliance"]) {
      expect(CONCERNS.find((c) => c.name === risk)?.point).toBe("risk");
    }
    expect(CONCERNS.filter((c) => c.point === "style-tests").map((c) => c.name)).toEqual([
      "style",
      "tests",
    ]);
  });

  it("a lens two concerns share takes the higher priority — ignoring one never switches off what the other wants", () => {
    const d = lensDecisions(answers({ money: "ignore", integrations: "important" }));
    expect(d.find((x) => x.lens === "pass-contracts")).toMatchObject({
      priority: "important",
      because: ["integrations"],
      settings: PRIORITY_SETTINGS.important,
    });
    // delivery and concurrency belong to money alone → off
    expect(d.find((x) => x.lens === "pass-delivery")?.settings).toEqual({ enabled: false });
    const both = lensDecisions(answers({ security: "critical", compliance: "critical" }));
    expect(both.find((x) => x.lens === "pass-security")?.because).toEqual([
      "security",
      "compliance",
    ]);
  });

  it("refuses an unknown concern or priority by name", () => {
    const r = parsePriorities({ secruity: "critical", style: "maybe" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.join("\n")).toMatch(/unknown concern "secruity"/);
      expect(r.errors.join("\n")).toMatch(
        /style: priority must be one of critical, important, normal, ignore/,
      );
    }
  });
});

// ---- what a written profile makes the reviewer do --------------------------------------

describe("a profile the interview wrote, resolved the way the daemon resolves it", () => {
  beforeEach(() => liveConfig("acme"));

  it("security critical: the security lens at sol-high, at the model's ceiling, able to block; nothing else moves", () => {
    applied(
      engine().profileApply({
        priorities: answers({ security: "critical" }),
        goals: "a payments API",
        write: true,
      }),
    );
    const cfg = tuned("acme");
    expect(cfg.lenses?.["pass-security"]).toEqual({
      enabled: true,
      min_tier: "sol-high",
      effort: "high",
      max_severity: "P0",
    });
    expect(row(cfg, AUTH, "pass-security")).toMatchObject({ tier: "sol-high" });
    const before = agents(tuned(""));
    const after = agents(cfg);
    const sec = "pass-security--sol-high";
    expect(modelOf(after.get(sec))).toContain(fixture.models.effort_max);
    expect(after.get(sec)).toContain("Severity ceiling for `pass-security`: `P0`");
    // only the security concern's lenses changed their bytes
    for (const [name, bytes] of before) {
      if (
        name.startsWith("pass-security--") ||
        name.startsWith("pass-bounds--") ||
        name.startsWith("pass-validate")
      )
        continue;
      expect(after.get(name), name).toBe(bytes);
    }
  });

  it("ignore: the lens is not planned and not addable", () => {
    applied(
      engine().profileApply({
        priorities: answers({ correctness: "ignore", tests: "ignore" }),
        goals: "g",
        write: true,
      }),
    );
    const cfg = tuned("acme");
    const p = plan(cfg, [file("app/views.py")]);
    expect(p.pass_plan.map((r) => r.lens)).not.toContain("pass-baseline");
    expect(p.pass_plan.map((r) => r.lens)).not.toContain("pass-tests");
  });

  it("the companion's emphasis reaches that lens's built body, and only it", () => {
    applied(
      engine().profileApply({
        priorities: answers(),
        goals: "g",
        emphasis: { "pass-data-safety": "Tenant data never crosses accounts." },
        write: true,
      }),
    );
    const built = agents(tuned("acme"));
    expect(built.get("pass-data-safety--sol-high")).toContain(
      "Tenant data never crosses accounts.",
    );
    expect(built.get("pass-security--sol-high")).not.toContain(
      "Tenant data never crosses accounts.",
    );
  });

  it("a drafted style guide lands in the profile and the style lens is pointed at it", () => {
    applied(
      engine().profileApply({
        priorities: answers({ style: "important" }),
        goals: "g",
        style_guide: "# Style\n- Use snake_case.\n",
        write: true,
      }),
    );
    expect(readFileSync(join(profileDir("acme"), "style-guide.md"), "utf8")).toBe(
      "# Style\n- Use snake_case.\n",
    );
    const cfg = tuned("acme");
    expect(cfg.lenses?.["pass-style"]?.guide?.file).toBe("style-guide.md");
    expect(cfg.lenses?.["pass-style"]).toMatchObject({
      enabled: true,
      min_tier: "sol-med",
      effort: "medium",
    });
    applied(engine().profileApply({ drop_style_guide: true, write: true }));
    expect(tuned("acme").lenses?.["pass-style"]?.guide).toBeUndefined();
  });

  it("re-tuning back to normal clears what the table wrote and keeps every other byte", () => {
    write(
      join(profileDir("acme"), "profile.toml"),
      '# our profile\nextends = "default"\necosystem = "none"\n\n[lenses.pass-ui]\n# hand-tuned\nemphasis = "Mobile first."\n\n[scan]\neffort = "low"\n',
    );
    applied(
      engine().profileApply({
        priorities: answers({ security: "critical" }),
        goals: "g",
        write: true,
      }),
    );
    applied(engine().profileApply({ priorities: { security: "normal" }, write: true }));
    const text = readFileSync(join(profileDir("acme"), "profile.toml"), "utf8");
    expect(text).toBe(
      '# our profile\nextends = "default"\necosystem = "none"\n\n[lenses.pass-ui]\n# hand-tuned\nemphasis = "Mobile first."\n\n[scan]\neffort = "low"\n',
    );
    expect(tuned("acme").lenses).toEqual({ "pass-ui": { emphasis: "Mobile first." } });
  });
});

// ---- the write tools -----------------------------------------------------------------------

describe("profile write tools: validate, diff, commit", () => {
  it("a preview shows the diff and writes nothing", () => {
    liveConfig("acme");
    const r = applied(engine().profileApply({ priorities: { security: "critical" } }));
    expect(r.written).toBe(false);
    expect(r.created).toBe(true);
    expect(r.unanswered.length).toBe(CONCERN_NAMES.length - 1);
    expect(r.diff[0]?.lines).toContain("+ [lenses.pass-security]");
    expect(r.diff[0]?.lines).toContain('+ min_tier = "sol-high"');
    expect(existsSync(profileDir("acme"))).toBe(false);
    expect(existsSync(join(dir, "state", INTERVIEW_FILE))).toBe(false);
  });

  it("a write is refused until the four points are covered: every concern and the goals", () => {
    liveConfig("acme");
    const r = engine().profileApply({ priorities: { security: "critical" }, write: true });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors[0]).toMatch(/goals/);
      expect(r.errors[0]).toMatch(/correctness/);
    }
    expect(existsSync(profileDir("acme"))).toBe(false);
  });

  it("answers accumulate across calls — a later call only adds what it asks", () => {
    liveConfig("acme");
    applied(
      engine().profileApply({
        priorities: answers({ security: "critical" }),
        goals: "g",
        write: true,
      }),
    );
    const r = applied(engine().profileApply({ priorities: { tests: "important" }, write: true }));
    expect(r.unanswered).toEqual([]);
    expect(tuned("acme").lenses?.["pass-security"]?.min_tier).toBe("sol-high");
    expect(tuned("acme").lenses?.["pass-tests"]?.min_tier).toBe("sol-med");
    const rec = JSON.parse(readFileSync(join(dir, "state", INTERVIEW_FILE), "utf8"));
    expect(rec).toMatchObject({
      profile: "acme",
      goals: "g",
      priorities: { security: "critical", tests: "important" },
    });
  });

  it("a profile that would not load is refused before anything is written", () => {
    liveConfig("acme");
    write(
      join(profileDir("acme"), "profile.toml"),
      'extends = "default"\n\n[lenses.pass-ui]\ncolour = "red"\n',
    );
    const r = engine().profileApply({ priorities: answers(), goals: "g", write: true });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join("\n")).toMatch(/would not load[\s\S]*unknown key "colour"/);
    expect(readFileSync(join(profileDir("acme"), "profile.toml"), "utf8")).toContain(
      'colour = "red"',
    );
    expect(existsSync(join(dir, "state", "setup", "commits"))).toBe(false);
  });

  it("a commit-request lookup that cannot be read refuses the write — never a hang", () => {
    liveConfig("acme");
    // `setup/commits` is a file: every lookup under it fails, not just one.
    write(join(dir, "state", "setup", "commits"), "not a directory\n");
    const r = engine().profileApply({
      priorities: answers({ security: "critical" }),
      goals: "g",
      write: true,
    });
    expect(r.ok).toBe(false);
    if (!r.ok)
      expect(r.errors[0]).toMatch(/commit requests .* cannot be read .* nothing was written/);
    expect(existsSync(join(profileDir("acme"), "profile.toml"))).toBe(false);
  });

  it("never writes a generic example; with no profile named, one must be given", () => {
    liveConfig("default");
    const r = engine().profileApply({ priorities: answers(), goals: "g", write: true });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]).toMatch(/generic example/);
    liveConfig("");
    const none = engine().profileApply({ priorities: answers(), goals: "g", write: true });
    expect(none.ok).toBe(false);
    if (!none.ok) expect(none.errors[0]).toMatch(/pass `profile`/);
    const named = applied(
      engine().profileApply({ profile: "acme", priorities: answers(), goals: "g", write: true }),
    );
    expect(named.config_names).toBe("");
    expect(readFileSync(join(profileDir("acme"), "profile.toml"), "utf8")).toMatch(
      /^extends = "default"$/m,
    );
    expect(engine().profileApply({ profile: "../x", priorities: answers() }).ok).toBe(false);
  });

  it("the validate tool catches a direct edit the daemon would refuse at boot", () => {
    liveConfig("acme");
    write(
      join(profileDir("acme"), "profile.toml"),
      'extends = "default"\n[lenses.pass-securty]\neffort = "high"\n',
    );
    const bad = engine().profileValidate();
    if (!("check" in bad)) throw new Error("expected a check");
    expect(bad.check.ok).toBe(false);
    if (!bad.check.ok) expect(bad.check.errors[0]).toMatch(/pass-securty\] is not a known lens/);
    write(
      join(profileDir("acme"), "profile.toml"),
      'extends = "default"\n[lenses.pass-security]\neffort = "high"\n',
    );
    const good = engine().profileValidate();
    if (!("check" in good) || !good.check.ok) throw new Error("expected a passing check");
    expect(good.check.summary.chain.map((l) => l.name)).toEqual(["default", "acme"]);
    expect(good.check.summary.lenses).toEqual({ "pass-security": { effort: "high" } });
  });

  it("status says setup is owed while no profile of the install's own is in use", () => {
    liveConfig("");
    const none = engine().profileStatus();
    if (!("target" in none)) throw new Error("refused");
    expect(none.needs_setup).toBe(true);
    liveConfig("minimal");
    const ex = engine().profileStatus();
    if (!("target" in ex)) throw new Error("refused");
    expect(ex.why_setup).toMatch(/generic example/);
    liveConfig("acme");
    applied(engine().profileApply({ priorities: answers(), goals: "g", write: true }));
    const done = engine().profileStatus();
    if (!("target" in done)) throw new Error("refused");
    expect(done.needs_setup).toBe(false);
    expect(done.unanswered).toEqual([]);
    expect(done.commits).toHaveLength(1);
    expect(done.commits[0]?.result).toBeNull();
  });

  it("status never guesses: an unreadable live config or interview record reads UNKNOWN, not owed or all-unanswered", () => {
    // no live config at all: whether setup is owed is unknown
    const noConfig = engine().profileStatus();
    if (!("target" in noConfig)) throw new Error("refused");
    expect(noConfig.needs_setup).toBeNull();
    expect(noConfig.why_setup).toMatch(/cannot be read/);
    liveConfig("acme");
    write(join(dir, "state", INTERVIEW_FILE), "{ torn");
    const torn = engine().profileStatus();
    if (!("target" in torn)) throw new Error("refused");
    expect(torn.interview.state).toBe("unreadable");
    expect(torn.unanswered).toBeNull();
  });

  it("a preview never writes through a symlinked profile file or profile directory into the live target", () => {
    liveConfig("acme");
    const original = 'extends = "default"\n';
    // profile.toml is a link into the operator's dotfiles
    write(join(dir, "dotfiles", "profile.toml"), original);
    mkdirSync(profileDir("acme"), { recursive: true });
    symlinkSync(join(dir, "dotfiles", "profile.toml"), join(profileDir("acme"), "profile.toml"));
    const r = applied(engine().profileApply({ priorities: { security: "critical" } }));
    expect(r.written).toBe(false);
    expect(readFileSync(join(dir, "dotfiles", "profile.toml"), "utf8")).toBe(original);
    // the whole profile directory is a link (a relative one)
    rmSync(profileDir("acme"), { recursive: true, force: true });
    write(join(dir, "dotfiles", "acme", "profile.toml"), original);
    symlinkSync(
      relative(dirname(profileDir("acme")), join(dir, "dotfiles", "acme")),
      profileDir("acme"),
    );
    expect(readFileSync(join(profileDir("acme"), "profile.toml"), "utf8")).toBe(original);
    applied(engine().profileApply({ priorities: { security: "critical" } }));
    expect(readFileSync(join(dir, "dotfiles", "acme", "profile.toml"), "utf8")).toBe(original);
  });

  it("a dangling link or a link loop elsewhere under profiles/ does not break a preview", () => {
    liveConfig("acme");
    mkdirSync(profileDir("other"), { recursive: true });
    symlinkSync(join(dir, "nowhere"), join(profileDir("other"), ".#profile.toml")); // an editor lock file
    symlinkSync("..", join(profileDir("other"), "loop"));
    const r = applied(engine().profileApply({ priorities: { security: "critical" } }));
    expect(r.written).toBe(false);
  });

  it("two changing writes in the same instant ask for two commits, never one reused id", () => {
    liveConfig("acme");
    const a = applied(
      engine().profileApply({
        priorities: answers({ security: "critical" }),
        goals: "g",
        write: true,
      }),
    );
    const b = applied(
      engine().profileApply({ priorities: { security: "important" }, write: true }),
    );
    expect(a.commit).not.toBeNull();
    expect(b.commit).not.toBeNull();
    expect(b.commit!.id).not.toBe(a.commit!.id);
    const names = readdirSync(join(dir, "state", "setup", "commits"))
      .filter((n) => n.endsWith(".request.json"))
      .sort();
    expect(names).toEqual([`${a.commit!.id}.request.json`, `${b.commit!.id}.request.json`]);
    const s = engine().profileStatus();
    if (!("commits" in s)) throw new Error("refused");
    expect(s.commits.map((c) => c.id)).toEqual([a.commit!.id, b.commit!.id]);
  });

  it("a write asks for a commit of exactly the profile's files; the operator's machine carries it out", () => {
    liveConfig("acme");
    const r = applied(
      engine().profileApply({
        priorities: answers({ security: "critical" }),
        goals: "g",
        style_guide: "# s\n",
        write: true,
      }),
    );
    expect(r.commit).not.toBeNull();
    const req = JSON.parse(
      readFileSync(join(dir, "state", "setup", "commits", `${r.commit!.id}.request.json`), "utf8"),
    );
    expect(req.paths.sort()).toEqual([
      "profiles/acme/profile.toml",
      "profiles/acme/style-guide.md",
    ]);
    expect(req.message).toBe("qcr setup: tune profile acme (security critical)");
    // the same answers again change nothing, so no second commit is asked for
    const again = applied(engine().profileApply({ write: true }));
    expect(again.unchanged).toBe(true);
    expect(again.commit).toBeNull();
  });
});

describe("the commit hand-off (processProfileCommits)", () => {
  const git = (cwd: string, ...args: string[]): string =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      // A config home in a temp dir must never find this checkout's repo above it.
      env: { ...process.env, GIT_CEILING_DIRECTORIES: dir },
    });
  const identityGit: GitRun = (args, cwd) => {
    try {
      return { code: 0, stdout: git(cwd, ...args), stderr: "" };
    } catch (err) {
      const e = err as { status?: number; stdout?: string; stderr?: string };
      return { code: e.status ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
    }
  };

  function requestOne(): string {
    liveConfig("acme");
    return applied(
      engine().profileApply({
        priorities: answers({ security: "critical" }),
        goals: "g",
        write: true,
      }),
    ).commit!.id;
  }

  it("commits the profile's paths alone in a config home that is its own repo — never a staged secret", () => {
    const id = requestOne();
    git(home(), "init", "-q");
    write(join(home(), "secrets", "app.pem"), "KEY\n");
    git(home(), "add", "secrets/app.pem");
    const [res] = processProfileCommits({
      stateHome: join(dir, "state"),
      configHome: home(),
      git: identityGit,
      clock: () => now,
    });
    expect(res).toMatchObject({ id, state: "committed" });
    expect(git(home(), "show", "--name-only", "--format=%s", "HEAD").trim().split("\n")).toEqual([
      "qcr setup: tune profile acme (security critical)",
      "",
      "profiles/acme/profile.toml",
    ]);
    expect(git(home(), "diff", "--cached", "--name-only").trim()).toBe("secrets/app.pem");
    // answered once: the status reads the result, a second pass does nothing
    expect(
      processProfileCommits({
        stateHome: join(dir, "state"),
        configHome: home(),
        git: identityGit,
      }),
    ).toEqual([]);
    const s = engine().profileStatus();
    if (!("commits" in s)) throw new Error("refused");
    expect(s.commits[0]?.result).toMatchObject({ state: "committed" });
  });

  it("a config home that is no repo, or only sits inside one, is reported and not committed into", () => {
    requestOne();
    const [plain] = processProfileCommits({
      stateHome: join(dir, "state"),
      configHome: home(),
      git: identityGit,
    });
    expect(plain?.state).toBe("not-a-repo");
    rmSync(join(dir, "state", "setup", "commits"), { recursive: true, force: true });
    requestOne2();
    git(join(dir, "xdg-config"), "init", "-q");
    const [inner] = processProfileCommits({
      stateHome: join(dir, "state"),
      configHome: home(),
      git: identityGit,
    });
    expect(inner?.state).toBe("not-a-repo");
    expect(inner?.detail).toMatch(/not in a repository of its own/);
  });

  function requestOne2(): void {
    now = new Date("2026-09-29T11:00:00Z");
    applied(engine().profileApply({ priorities: { security: "important" }, write: true }));
  }

  it("two host processors never both answer one request: a pass that holds the lock is left alone, a result another wrote is kept", () => {
    const stateHome = join(dir, "state");
    const commits = join(stateHome, "setup", "commits");
    write(
      join(commits, "a.request.json"),
      JSON.stringify({ id: "a", message: "m", paths: ["profiles/acme/profile.toml"] }),
    );
    write(
      join(commits, "b.request.json"),
      JSON.stringify({ id: "b", message: "m", paths: ["profiles/acme/profile.toml"] }),
    );
    const theirs = { id: "b", at: "t", state: "committed", sha: "abc", detail: "theirs" };
    // while A is being processed, another processor answers B
    const racing: GitRun = (args) => {
      if (args[0] === "add" && !existsSync(join(commits, "b.result.json")))
        write(join(commits, "b.result.json"), JSON.stringify(theirs));
      if (args[0] === "rev-parse" && args[1] === "--show-toplevel")
        return { code: 0, stdout: home(), stderr: "" };
      if (args[0] === "diff") return { code: 1, stdout: "", stderr: "" };
      return { code: 0, stdout: "sha1\n", stderr: "" };
    };
    mkdirSync(home(), { recursive: true });
    const done = processProfileCommits({ stateHome, configHome: home(), git: racing });
    expect(done.map((r) => r.id)).toEqual(["a"]);
    expect(JSON.parse(readFileSync(join(commits, "b.result.json"), "utf8"))).toEqual(theirs);

    // a live lock held by another pass: this one does nothing
    write(
      join(commits, "c.request.json"),
      JSON.stringify({ id: "c", message: "m", paths: ["profiles/acme/profile.toml"] }),
    );
    write(join(commits, ".processing.lock"), "other\n");
    const calls: string[][] = [];
    const counting: GitRun = (args, cwd) => (calls.push(args), racing(args, cwd));
    expect(processProfileCommits({ stateHome, configHome: home(), git: counting })).toEqual([]);
    expect(calls).toEqual([]);
    // a stale lock (its holder died) is taken over
    const old = new Date(Date.now() - 60 * 60 * 1000);
    utimesSync(join(commits, ".processing.lock"), old, old);
    expect(
      processProfileCommits({ stateHome, configHome: home(), git: counting }).map((r) => r.id),
    ).toEqual(["c"]);
    expect(existsSync(join(commits, ".processing.lock"))).toBe(false);
  });

  it("a commit whose git step failed is not re-run by the timer, and is by the operator's retry", () => {
    const stateHome = join(dir, "state");
    const commits = join(stateHome, "setup", "commits");
    write(
      join(commits, "a.request.json"),
      JSON.stringify({ id: "a", message: "m", paths: ["profiles/acme/profile.toml"] }),
    );
    mkdirSync(home(), { recursive: true });
    let locked = true;
    const flaky: GitRun = (args) => {
      if (args[0] === "rev-parse" && args[1] === "--show-toplevel")
        return { code: 0, stdout: home(), stderr: "" };
      if (args[0] === "add" && locked)
        return {
          code: 128,
          stdout: "",
          stderr: "fatal: Unable to create 'index.lock': File exists.",
        };
      if (args[0] === "diff") return { code: 1, stdout: "", stderr: "" };
      return { code: 0, stdout: "sha1\n", stderr: "" };
    };
    expect(processProfileCommits({ stateHome, configHome: home(), git: flaky })).toEqual([
      expect.objectContaining({ id: "a", state: "failed" }),
    ]);
    locked = false;
    // The timer's pass leaves a standing failure alone.
    expect(processProfileCommits({ stateHome, configHome: home(), git: flaky })).toEqual([]);
    // The operator's pass, once the lock is gone, completes it — and only it.
    expect(
      processProfileCommits({ stateHome, configHome: home(), git: flaky, retryFailed: true }),
    ).toEqual([expect.objectContaining({ id: "a", state: "committed" })]);
    expect(JSON.parse(readFileSync(join(commits, "a.result.json"), "utf8")).state).toBe(
      "committed",
    );
    expect(
      processProfileCommits({ stateHome, configHome: home(), git: flaky, retryFailed: true }),
    ).toEqual([]);
  });

  it("a request naming anything outside profiles/ is refused before git sees it", () => {
    expect(refusePath("profiles/acme/profile.toml")).toBeNull();
    expect(refusePath("secrets/app.pem")).toMatch(/outside profiles/);
    expect(refusePath("profiles/../secrets/app.pem")).toMatch(/plain relative/);
    expect(refusePath("/etc/passwd")).toMatch(/plain relative/);
    write(
      join(dir, "state", "setup", "commits", "x.request.json"),
      JSON.stringify({ id: "x", message: "m", paths: ["secrets/app.pem"] }),
    );
    const calls: string[][] = [];
    const [r] = processProfileCommits({
      stateHome: join(dir, "state"),
      configHome: home(),
      git: (a) => (calls.push(a), { code: 0, stdout: "", stderr: "" }),
    });
    expect(r).toMatchObject({ id: "x", state: "refused" });
    expect(calls).toEqual([]);
  });
});

// ---- the surgical edit -------------------------------------------------------------------------

describe("editLensTables", () => {
  it("refuses a [lenses] it cannot edit without losing something", () => {
    const inline = 'extends = "default"\nlenses = { "pass-ui" = { enabled = false } }\n';
    const r = editLensTables(inline, { "pass-ui": { enabled: true } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/edit|shape/);
  });

  it("appends a new lens and removes an emptied one", () => {
    const r = editLensTables('extends = "default"\n\n[lenses.pass-ui]\nenabled = false\n', {
      "pass-ui": { enabled: null },
      "pass-security": { effort: "high" },
    });
    expect(r.ok && r.text).toBe('extends = "default"\n\n[lenses.pass-security]\neffort = "high"\n');
  });
});

// ---- pin proposals -----------------------------------------------------------------------------

describe("pin proposals go to the operator", () => {
  const entry = (id: string, text: string, pinned = false): MemoryEntry => ({
    id,
    ts: "2026-09-29 09:00:00",
    day: "2026-09-29",
    block: 0,
    text,
    tags: ["survey"],
    links: [],
    pinned,
    hash: `h-${id}`,
  });

  it("records live, unpinned entries with a reason — and pins nothing", async () => {
    const applied: MemoryOp[] = [];
    const mem = fakeMemory([
      entry("a", "#survey Views are thin."),
      entry("b", "#survey Money in cents.", false),
      entry("c", "pinned one", true),
    ]);
    mem.apply = async (op) => (applied.push(op), { ok: true, message: "" });
    const r = await engine(mem).proposePins([
      { id: "a", ts: "2026-09-29 09:00:00", block: 0, why: "every view PR trips on this" },
      { id: "b", ts: "2026-09-29 09:00:00", block: "0", why: "the money rule" },
    ]);
    if (!r.ok) throw new Error(r.errors.join("; "));
    expect(r.proposed.map((p) => p.id)).toEqual(["a", "b"]);
    expect(r.pinned_chars).toBe("pinned one".length + 2);
    expect(r.projected_chars).toBeGreaterThan(r.pinned_chars);
    expect(applied).toEqual([]);
    const file = JSON.parse(readFileSync(join(dir, "state", PIN_PROPOSALS_FILE), "utf8"));
    expect(file.entries[0]).toMatchObject({
      id: "a",
      hash: "h-a",
      why: "every view PR trips on this",
    });
    // What it wrote reads back whole; one proposal short of a field makes the
    // file unreadable, never a shorter list.
    const text = readFileSync(join(dir, "state", PIN_PROPOSALS_FILE), "utf8");
    expect(parsePinProposals(text)).toMatchObject({ state: "ok", file: { entries: file.entries } });
    const { hash: _dropped, ...hashless } = file.entries[1];
    expect(
      parsePinProposals(JSON.stringify({ ...file, entries: [file.entries[0], hashless] })),
    ).toMatchObject({ state: "unreadable", error: expect.stringMatching(/entries\[1\]/) });
  });

  it("refuses an unknown or already-pinned entry, a missing reason, and more than a handful", async () => {
    const mem = fakeMemory([entry("a", "x"), entry("c", "y", true)]);
    const r = await engine(mem).proposePins([
      { id: "zz", ts: "2026-09-29 09:00:00", block: 0, why: "w" },
      { id: "c", ts: "2026-09-29 09:00:00", block: 0, why: "w" },
      { id: "a", ts: "2026-09-29 09:00:00", block: 0, why: "" },
    ]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors).toHaveLength(3);
    const twoLines = await engine(mem).proposePins([
      { id: "a", ts: "2026-09-29 09:00:00", block: 0, why: "one\ntwo" },
    ]);
    expect(twoLines.ok).toBe(false);
    const many = Array.from({ length: 9 }, () => ({
      id: "a",
      ts: "2026-09-29 09:00:00",
      block: 0,
      why: "w",
    }));
    const capped = await engine(mem).proposePins(many);
    expect(capped.ok).toBe(false);
    expect(readdirSync(dir)).not.toContain("state");
    expect((await engine(null).proposePins([{ id: "a" }])).ok).toBe(false);
  });
});
