// Interview → config fill. Everything faked: a scripted prompter
// stands in for the operator, the sandbox root is a temp dir, and the ONLY
// real thing in the file is the shipped `config.example.toml` template and the
// strict loader — because the claim under test is precisely "the produced file
// parses under the real loader on the first try".
//
// The properties pinned here:
//   * the full interview produces a loader-clean config from the template;
//   * DERIVABLES is a closed enumeration — the list cannot silently shrink
//     back into the interview, and no question/derivable touches dry_run;
//   * patching preserves every comment and re-runs as targeted edits (a
//     keep-everything re-run is byte-identical and rewrites nothing);
//   * malformed answers fail AT THE STEP with plain guidance;
//   * rule 1: however the answers are shaped, this step cannot produce a
//     config with dry_run false — nor flip an owner's false back to true.
import { locateSecrets } from "../src/install.js";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseToml } from "smol-toml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig, type Config } from "../src/config.js";
import { OnboardingEngine, type OnboardAdapters, type StepContext } from "../src/onboard/engine.js";
import {
  CHOICE_KEYS,
  CONFIG_FILL_STEP_ID,
  DERIVABLES,
  assertNoDryRunEdit,
  MAX_ATTEMPTS,
  QUESTIONS,
  buildEdits,
  changedEdits,
  configFillStep,
  patchToml,
  rewriteFillMarker,
  splitTail,
  tomlString,
  type AnswerKey,
  type FillFacts,
} from "../src/onboard/steps/configfill.js";
import { defaultSteps } from "../src/onboard/steps/index.js";
import { HEAVY_TIMEOUT_MS } from "./helpers/suite-timeouts.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TEMPLATE = readFileSync(join(REPO_ROOT, "config.example.toml"), "utf8");

let root: string;
let checkout: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "qcr-configfill-"));
  mkdirSync(join(root, "state"), { recursive: true });
  checkout = join(root, "checkout");
  mkdirSync(checkout, { recursive: true });
  copyFileSync(join(REPO_ROOT, "config.example.toml"), join(root, "config.example.toml"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** The whole interview, in question order, as a scripted operator would type it. */
function fullAnswers(): Record<AnswerKey, string> {
  return {
    repo: "acme/web-app",
    reviewed_repo_dir: checkout,
    app_slug: "acme-reviewer",
    timezone: "Europe/Warsaw",
    base_branch: "main",
    owner_name: "Dana Operator",
    owner_github_login: "dana-op",
    owner_slack_id: "U01ABCD2EFG",
    escalation_mention: "",
    ssh_host: "review-vm",
    webhook_hostname: "review.example.com",
  };
}

interface Prompted {
  questions: string[];
}

/** A prompter that answers by question ORDER, mapping each asked question to
 * the scripted answer. `overrides` may replace one answer with a bad value (or
 * a sequence of values, tried in order — the re-ask path). */
function scriptedPrompter(
  answers: Partial<Record<AnswerKey, string | string[]>>,
  asked: AnswerKey[],
  log: Prompted,
): (q: string) => Promise<string> {
  const counters = new Map<AnswerKey, number>();
  let i = 0;
  return async (question: string) => {
    log.questions.push(question);
    const id = asked[i]!;
    const n = counters.get(id) ?? 0;
    const scripted = answers[id];
    const value = Array.isArray(scripted)
      ? (scripted[n] ?? scripted.at(-1) ?? "")
      : (scripted ?? "");
    counters.set(id, n + 1);
    // Advance to the next question only once this one has a valid answer; the
    // step re-asks in place, so the prompter must too.
    const q = QUESTIONS.find((x) => x.id === id)!;
    const settled = value === "" ? q.optional : q.validate(value) === null;
    if (settled || n + 1 >= MAX_ATTEMPTS) i++;
    return value;
  };
}

function adapters(
  prompter?: (q: string) => Promise<string>,
  configPath = join(root, "config.toml"),
): OnboardAdapters {
  return {
    fetch: (() => {
      throw new Error("no network in tests");
    }) as unknown as typeof fetch,
    runner: {
      run: async (cmd, args) =>
        cmd === "docker" && args.includes("ps")
          ? { code: 0, stdout: "[]", stderr: "" }
          : { code: 127, stdout: "", stderr: "no subprocesses in tests" },
    },
    clock: () => new Date("2026-08-30T12:00:00Z"),
    host: { nodeVersion: "v22.5.1", uid: 1000 },
    paths: { stateDir: join(root, "state"), configPath },
    prompter,
  };
}

interface RunOpts {
  answers?: Partial<Record<AnswerKey, string | string[]>>;
  choices?: Record<string, unknown>;
  data?: Record<string, unknown>;
  /** Omit the prompter entirely (the no-interactive-entry path). */
  noPrompter?: boolean;
  /** The install locator's answer handed to the adapters. */
  configPath?: string;
  /** The tool call's arguments (the pi-driven route). */
  input?: Record<string, unknown>;
}

function askedIds(choices: Record<string, unknown>): AnswerKey[] {
  return QUESTIONS.filter((q) => (q.asked ? q.asked(choices) : true)).map((q) => q.id);
}

async function runStep(opts: RunOpts = {}) {
  const choices: Record<string, unknown> = { ...(opts.choices ?? {}) };
  const answers = { ...fullAnswers(), ...(opts.answers ?? {}) } as Partial<
    Record<AnswerKey, string | string[]>
  >;
  const log: Prompted = { questions: [] };
  const prompter = opts.noPrompter ? undefined : scriptedPrompter(answers, askedIds(choices), log);
  const ctx: StepContext = {
    adapters: adapters(prompter, opts.configPath),
    input: opts.input ?? {},
    choices,
    data: opts.data ?? {},
    recordChoice: (k, v) => {
      choices[k] = v;
    },
  };
  const report = await configFillStep().run(ctx);
  return { report, choices, log, ctx };
}

function producedConfig(): Config {
  return loadConfig(join(root, "config.toml"));
}

function failed(report: { checks: Array<{ ok: boolean; name: string; detail: string }> }): string {
  return report.checks
    .filter((c) => !c.ok)
    .map((c) => `${c.name}: ${c.detail}`)
    .join(" | ");
}

// ---- the full interview -----------------------------------------------------

describe("the config file is the install locator's", () => {
  it(
    "fills the config where the adapters say — a config home that does not exist yet — and never the checkout",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      const home = join(root, "xdg-config", "qcr", "default", "config.toml");
      const { report, choices } = await runStep({ configPath: home });
      expect(failed(report)).toBe("");
      expect(loadConfig(home).dry_run).toBe(true);
      expect(existsSync(join(root, "config.toml"))).toBe(false);
      expect(choices[CHOICE_KEYS.configPath]).toBe(home);
    },
  );
});

describe("the full interview", () => {
  it("produces a config the STRICT LOADER parses on the first try", async () => {
    const { report } = await runStep({
      choices: { [CHOICE_KEYS.topology]: "vm", [CHOICE_KEYS.ingress]: "named" },
    });
    expect(failed(report)).toBe("");
    expect(report.ok).toBe(true);

    const cfg = producedConfig(); // the REAL loader, over the REAL produced file
    expect(cfg.github.repo).toBe("acme/web-app");
    expect(cfg.github.app_slug).toBe("acme-reviewer");
    expect(cfg.github.base_branch).toBe("main");
    expect(cfg.ops.timezone).toBe("Europe/Warsaw");
    expect(cfg.owner.name).toBe("Dana Operator");
    expect(cfg.owner.github_login).toBe("dana-op");
    expect(cfg.owner.slack_id).toBe("U01ABCD2EFG");
    expect(cfg.companion.reviewed_repo_dir).toBe(checkout);
    expect(cfg.tui.ssh_host).toBe("review-vm");
    expect(cfg.server.hostname).toBe("review.example.com");
  });

  it("teaches the concept at each question rather than only prompting", async () => {
    const { log } = await runStep();
    // Every question carries its teach text on the first ask.
    for (const q of QUESTIONS.filter((x) => !x.asked)) {
      expect(log.questions.some((asked) => asked.includes(q.teach))).toBe(true);
    }
    expect(QUESTIONS.every((q) => q.teach.length > 60)).toBe(true);
  });

  it("asks only what a human must answer — no secret is ever an interview question", () => {
    const ids = QUESTIONS.map((q) => q.id);
    expect(ids).toEqual([
      "repo",
      "reviewed_repo_dir",
      "app_slug",
      "timezone",
      "base_branch",
      "owner_name",
      "owner_github_login",
      "owner_slack_id",
      "escalation_mention",
      "ssh_host",
      "webhook_hostname",
    ]);
    const secretish = /token|secret|key|password|pem/i;
    for (const q of QUESTIONS) {
      expect(secretish.test(q.id)).toBe(false);
      expect(secretish.test(q.key)).toBe(false);
    }
  });

  it("skips the topology/ingress-conditional questions on the laptop default", async () => {
    const { report, log } = await runStep();
    expect(failed(report)).toBe("");
    expect(log.questions.some((q) => q.includes("ssh alias"))).toBe(false);
    expect(log.questions.some((q) => q.includes("public hostname"))).toBe(false);
    const cfg = producedConfig();
    expect(cfg.tui.ssh_host).toBe("");
    expect(cfg.server.hostname).toBe("");
  });

  it("points the TUI at the recorded topology: local Docker on this machine, ssh on the VM", async () => {
    const local = await runStep({ choices: { [CHOICE_KEYS.topology]: "local" } });
    expect(failed(local.report)).toBe("");
    expect(producedConfig().tui.target).toBe("local");

    const vm = await runStep({
      choices: { [CHOICE_KEYS.topology]: "vm", [CHOICE_KEYS.ingress]: "named" },
    });
    expect(failed(vm.report)).toBe("");
    expect(producedConfig().tui.target).toBe("ssh");
  });

  it("treats an UNRECORDED topology as local, as every other step does", async () => {
    // The TUI opened before onboarding recorded a topology must not keep the
    // template's ssh route with an empty host: unrecorded means local.
    const { report } = await runStep();
    expect(failed(report)).toBe("");
    const cfg = producedConfig();
    expect(cfg.tui.target).toBe("local");
    expect(cfg.tui.container).toBe("quickreview-daemon-1");
    expect(cfg.tui.memory_container).toBe("quickreview-memory-1");
  });

  it("verify is red when [tui] target disagrees with the recorded topology", async () => {
    await runStep({ choices: { [CHOICE_KEYS.topology]: "local" } });
    const path = join(root, "config.toml");
    writeFileSync(path, readFileSync(path, "utf8").replace('target = "local"', 'target = "ssh"'));
    const ctx: StepContext = {
      adapters: adapters(),
      input: {},
      choices: { [CHOICE_KEYS.topology]: "local" },
      data: {},
      recordChoice: () => {},
    };
    const report = await configFillStep().verify(ctx);
    expect(report.ok).toBe(false);
    expect(failed(report)).toMatch(/\[tui\] target/);
  });

  it("takes an answer a sibling step already recorded instead of asking again", async () => {
    const { log, report } = await runStep({
      choices: { [CHOICE_KEYS.appSlug]: "from-manifest-step" },
    });
    expect(failed(report)).toBe("");
    expect(log.questions.some((q) => q.includes("GitHub App's slug"))).toBe(false);
    expect(producedConfig().github.app_slug).toBe("from-manifest-step");
  });

  it("records the operator's choices into the checklist for later steps", async () => {
    const { choices } = await runStep();
    expect(choices[CHOICE_KEYS.repo]).toBe("acme/web-app");
    expect(choices[CHOICE_KEYS.repoDir]).toBe(checkout);
    expect(choices[CHOICE_KEYS.appSlug]).toBe("acme-reviewer");
    expect(choices[CHOICE_KEYS.baseBranch]).toBe("main");
    expect(choices[CHOICE_KEYS.timezone]).toBe("Europe/Warsaw");
    expect(choices[CHOICE_KEYS.ownerLogin]).toBe("dana-op");
    expect(choices[CHOICE_KEYS.configPath]).toBe(join(root, "config.toml"));
    expect(choices[CHOICE_KEYS.dryRun]).toBe(true);
  });
});

// ---- derivables: computed, never asked --------------------------------------

describe("derivables", () => {
  it("points a local fill at the bundled Compose daemon instead of the VM container", async () => {
    await runStep({ choices: { [CHOICE_KEYS.topology]: "local" } });
    const compose = readFileSync(join(REPO_ROOT, "docker-compose.yml"), "utf8");
    const project = /^name:\s*(\S+)/m.exec(compose)?.[1];
    expect(compose).toMatch(/^ {2}daemon:/m);
    expect(producedConfig().tui.container).toBe(`${project}-daemon-1`);
    // A previously filled VM default must also recover when rerun locally.
    const path = join(root, "config.toml");
    writeFileSync(
      path,
      readFileSync(path, "utf8").replace(`${project}-daemon-1`, "quickreview-sandbox"),
    );
    await runStep({ choices: { [CHOICE_KEYS.topology]: "local" } });
    expect(producedConfig().tui.container).toBe(`${project}-daemon-1`);
    writeFileSync(
      path,
      readFileSync(path, "utf8").replace(`${project}-daemon-1`, "operator-daemon"),
    );
    await runStep({ choices: { [CHOICE_KEYS.topology]: "local" } });
    expect(producedConfig().tui.container).toBe("operator-daemon");
  });
  it("reads the local stack's state where the release image keeps it, with plain docker", async () => {
    await runStep({ choices: { [CHOICE_KEYS.topology]: "local" } });
    const compose = readFileSync(join(REPO_ROOT, "docker-compose.yml"), "utf8");
    // The compose state volume's mount point is the dir the TUI must read.
    expect(compose).toMatch(/qcr-state:\/opt\/qcr\/state/);
    expect(producedConfig().tui.remote_state_dir).toBe("/opt/qcr/state");
    expect(producedConfig().tui.sudo_docker).toBe(false);
    // An operator's own values survive a re-run.
    const path = join(root, "config.toml");
    writeFileSync(
      path,
      readFileSync(path, "utf8")
        .replace('remote_state_dir = "/opt/qcr/state"', 'remote_state_dir = "/srv/state"')
        .replace("sudo_docker = false", "sudo_docker = true"),
    );
    await runStep({ choices: { [CHOICE_KEYS.topology]: "local" } });
    expect(producedConfig().tui.remote_state_dir).toBe("/srv/state");
    // true is the shipped default, so it reads as unset and is derived again.
    expect(producedConfig().tui.sudo_docker).toBe(false);
    // The VM route keeps the VM-shaped defaults.
    rmSync(path);
    await runStep({
      choices: { [CHOICE_KEYS.topology]: "vm", [CHOICE_KEYS.ingress]: "named" },
    });
    expect(producedConfig().tui.remote_state_dir).toBe("/opt/quickreview/state");
    expect(producedConfig().tui.sudo_docker).toBe(true);
  });

  it("points a local fill's memory forward at the bundled Compose memory sidecar", async () => {
    await runStep({ choices: { [CHOICE_KEYS.topology]: "local" } });
    const compose = readFileSync(join(REPO_ROOT, "docker-compose.yml"), "utf8");
    const project = /^name:\s*(\S+)/m.exec(compose)?.[1];
    expect(compose).toMatch(/^ {2}memory:/m);
    expect(producedConfig().tui.memory_container).toBe(`${project}-memory-1`);
    const path = join(root, "config.toml");
    writeFileSync(
      path,
      readFileSync(path, "utf8").replace(`${project}-memory-1`, "operator-memory"),
    );
    await runStep({ choices: { [CHOICE_KEYS.topology]: "local" } });
    expect(producedConfig().tui.memory_container).toBe("operator-memory");
  });
  it("enumerates every value computed instead of asked — the list cannot silently shrink", () => {
    expect(DERIVABLES.map((d) => d.id)).toEqual([
      "bot_login",
      "clone_dir",
      "secrets_dir",
      "review_team",
      "eod_timezone",
      "slack_policy_timezone",
      "backfill_identity",
      "sink_kind",
      "tui_target",
      "tui_container",
      "tui_memory_container",
      "tui_remote_state_dir",
      "tui_sudo_docker",
      "tui_ssh_host",
      "server_hostname",
      "companion_repo_dir",
      "escalation_mention_fallback",
      "dry_run",
    ]);
    // A derivable is never also an interview question.
    const questionTargets = new Set(QUESTIONS.map((q) => `${q.section}.${q.key}`));
    for (const d of DERIVABLES) {
      if (["tui_ssh_host", "server_hostname", "escalation_mention_fallback"].includes(d.id))
        continue;
      const w = d.write({} as FillFacts, true);
      if (w) expect(questionTargets.has(`${w.section}.${w.key}`)).toBe(false);
    }
  });

  it("every derivation holds on the produced config", async () => {
    const { report } = await runStep();
    expect(failed(report)).toBe("");
    const cfg = producedConfig();

    // bot login from the app slug — never asked
    expect(cfg.github.bot_login).toBe("acme-reviewer[bot]");
    // clone dir derives from the repo slug's basename
    expect(cfg.github.clone_dir).toBe("");
    // the timezone cascade
    expect(cfg.eod.timezone).toBe("Europe/Warsaw");
    expect(cfg.slack.policy.timezone).toBe("Europe/Warsaw");
    // the [backfill] cascade off [github]
    expect(cfg.backfill.bot_login).toBe("acme-reviewer[bot]");
    expect(cfg.backfill.bot_actor).toBe("acme-reviewer");
    expect(cfg.backfill.trigger_label).toBe(cfg.github.trigger_label);
    // the sink default
    expect(cfg.sink.kind).toBe("github");
    // directory defaults
    // Written empty, resolved by the install locator at load.
    expect(cfg.github.secrets_dir).toBe(locateSecrets().path);
    expect(cfg.companion.repo_dir).not.toBe("");
    // escalation mention falls back to the owner's login
    expect(cfg.review.escalation_mention_default).toBe("dana-op");

    for (const d of DERIVABLES) {
      expect([d.id, d.holds(cfg, {} as FillFacts)]).toEqual([d.id, null]);
    }
  });

  it("reports each derivation as its own check, so the operator sees what was computed", async () => {
    const { report } = await runStep();
    for (const d of DERIVABLES) {
      expect(report.checks.some((c) => c.name === `derived:${d.id}` && c.ok)).toBe(true);
    }
  });
});

// ---- rule 1: dry_run ---------------------------------------------------------

describe("dry_run (rule 1)", () => {
  it("ships TRUE however the answers are shaped", async () => {
    const hostile: Partial<Record<AnswerKey, string>> = {
      // An answer that tries to close the string and open a key of its own.
      owner_name: 'Dana " # dry_run = false',
      repo: "acme/web-app",
    };
    const { report } = await runStep({ answers: hostile });
    expect(failed(report)).toBe("");
    const cfg = producedConfig();
    expect(cfg.dry_run).toBe(true);
    // and the injection landed as DATA, not as structure
    expect(cfg.owner.name).toBe('Dana " # dry_run = false');
  });

  it("rejects a multi-line answer rather than letting it reach the document", async () => {
    const { report } = await runStep({ answers: { owner_name: "Dana\ndry_run = false" } });
    expect(report.ok).toBe(false);
    expect(failed(report)).toMatch(/single line/);
    expect(existsSync(join(root, "config.toml"))).toBe(false);
  });

  it("has no question and no derivable that writes the flag", () => {
    expect(QUESTIONS.some((q) => q.key === "dry_run" || q.section === "dry_run")).toBe(false);
    for (const d of DERIVABLES) {
      const w = d.write(fullFacts(), true);
      expect(w?.key).not.toBe("dry_run");
    }
    expect(DERIVABLES.find((d) => d.id === "dry_run")!.write(fullFacts(), true)).toBeNull();
  });

  it("refuses an edit list that names dry_run, however it is spelled", () => {
    expect(() => patchAll([{ section: "", key: "dry_run", value: "false" }])).toThrow(/rule 1/);
    expect(() => patchAll([{ section: "x", key: '"dry_run"', value: "false" }])).toThrow(/rule 1/);
    expect(() => patchAll([{ section: "dry_run", key: "x", value: "false" }])).toThrow(/rule 1/);
  });

  it.skipIf(process.getuid?.() === 0)(
    "refuses — writing nothing — when a config exists but cannot be read, never re-seeding it from the template",
    async () => {
      const live = TEMPLATE.replace("dry_run = true", "dry_run = false");
      const path = join(root, "config.toml");
      writeFileSync(path, live);
      chmodSync(path, 0o000);
      try {
        const { report } = await runStep();
        expect(report.ok).toBe(false);
        expect(failed(report)).toMatch(/cannot be read/);
        chmodSync(path, 0o600);
        expect(readFileSync(path, "utf8")).toBe(live);
      } finally {
        chmodSync(path, 0o600);
      }
    },
  );

  it("never flips an owner's dry_run = false back to true", async () => {
    const live = TEMPLATE.replace("dry_run = true", "dry_run = false");
    writeFileSync(join(root, "config.toml"), live);
    const { report } = await runStep();
    expect(failed(report)).toBe("");
    expect(producedConfig().dry_run).toBe(false);
    expect(readFileSync(join(root, "config.toml"), "utf8")).toContain("dry_run = false");
  });
});

function fullFacts(): FillFacts {
  return {
    repo: "acme/web-app",
    app_slug: "acme-reviewer",
    reviewed_repo_dir: "/tmp/checkout",
    owner_name: "Dana",
    owner_github_login: "dana-op",
    owner_slack_id: "",
    timezone: "Europe/Warsaw",
    base_branch: "main",
    escalation_mention: "",
    ssh_host: "",
    webhook_hostname: "",
    secrets_dir: "~/.config/quickreview-bot",
    topology: "local",
    ingress: "quick-tunnel",
  };
}

function patchAll(edits: Array<{ section: string; key: string; value: string }>): string {
  return patchToml(TEMPLATE, buildEditsGuard(edits));
}

/** The production guard over buildEdits' own list plus the injected edits. */
function buildEditsGuard(edits: Array<{ section: string; key: string; value: string }>) {
  const all = [...buildEdits(fullFacts(), {}, true), ...edits];
  assertNoDryRunEdit(all);
  return all;
}

// ---- comment preservation ----------------------------------------------------

describe("comment-preserving patch", () => {
  it("keeps every comment-only line of the template byte-identical", async () => {
    const { report } = await runStep();
    expect(failed(report)).toBe("");
    const out = readFileSync(join(root, "config.toml"), "utf8");
    const commentsOf = (t: string) => t.split("\n").filter((l) => l.trimStart().startsWith("#"));
    // Filling UNCOMMENTS the commented-out companion checkout line, so the
    // produced file has exactly one fewer comment line — every other one is
    // byte-identical and in the same order.
    const before = commentsOf(TEMPLATE).filter((l) => !l.includes("reviewed_repo_dir"));
    const after = commentsOf(out);
    for (const line of before) expect(after).toContain(line);
    expect(out.split("\n").filter((l) => l.includes("[openviking]")).length).toBe(1);
  });

  it("keeps a value's own trailing comment, rewriting only the spent FILL marker", () => {
    const out = patchToml(TEMPLATE, [
      { section: "github", key: "repo", value: tomlString("acme/web-app") },
    ]);
    const line = out.split("\n").find((l) => l.startsWith("repo ="))!;
    expect(line).toContain('repo = "acme/web-app"');
    expect(line).toContain("the repo to review");
    expect(line).not.toContain("← FILL");
    expect(line).toContain("filled by qcr:");
  });

  it("leaves no ← FILL marker on any line it filled", async () => {
    await runStep({ choices: { [CHOICE_KEYS.topology]: "vm", [CHOICE_KEYS.ingress]: "named" } });
    const out = readFileSync(join(root, "config.toml"), "utf8");
    const valueOf = (text: string, key: string) =>
      text.split("\n").find((l) => new RegExp(`^\\s*${key}\\s*=`).test(l));
    let checked = 0;
    for (const q of QUESTIONS) {
      const line = valueOf(out, q.key);
      // A key whose answer equalled the template's own value was never
      // rewritten (targeted edits) — its marker legitimately stands.
      if (!line || line === valueOf(TEMPLATE, q.key)) continue;
      expect(line).not.toContain("← FILL");
      checked++;
    }
    expect(checked).toBeGreaterThan(4);
  });

  it("uncomments a commented-out key in place", () => {
    const out = patchToml(TEMPLATE, [
      { section: "companion", key: "reviewed_repo_dir", value: tomlString("/home/dana/web-app") },
    ]);
    expect(out).toContain('reviewed_repo_dir = "/home/dana/web-app"');
    expect(out).not.toContain('# reviewed_repo_dir = "~/projects/your-reviewed-repo"');
  });

  it("appends a key its section does not carry, and a whole missing section", () => {
    const out = patchToml('[github]\nrepo = "a/b"\n', [
      { section: "github", key: "app_slug", value: tomlString("s") },
      { section: "owner", key: "name", value: tomlString("Dana") },
    ]);
    expect(out).toContain('app_slug = "s"');
    expect(out).toContain("[owner]");
    expect(out).toContain('name = "Dana"');
  });

  it("recognises a table header carrying a trailing comment — never appends a duplicate table", () => {
    // `[tui] # mine` is legal TOML and the ingress reader already accepts it;
    // a second [tui] would make the whole file unloadable.
    const out = patchToml('[tui] # mine\ntarget = "local"\n\n[server] # port\nport = 8787\n', [
      { section: "tui", key: "target", value: tomlString("ssh") },
      { section: "tui", key: "ssh_host", value: tomlString("review-vm") },
    ]);
    expect(out.split("\n").filter((l) => l.includes("[tui]"))).toEqual(["[tui] # mine"]);
    const parsed = parseToml(out) as {
      tui: Record<string, unknown>;
      server: Record<string, unknown>;
    };
    expect(parsed.tui).toEqual({ target: "ssh", ssh_host: "review-vm" });
    expect(parsed.server).toEqual({ port: 8787 });
  });

  it("splits a trailing comment only outside quotes", () => {
    expect(splitTail('"a#b"   # tail')).toEqual({ value: '"a#b"', gap: "   ", comment: "# tail" });
    expect(splitTail('"unterminated')).toBeNull();
    // A multi-line string may end with up to two extra quote characters.
    expect(splitTail('"""hello"""" # c')).toEqual({
      value: '"""hello""""',
      gap: " ",
      comment: "# c",
    });
    expect(splitTail("'''hi''''' # c")).toEqual({ value: "'''hi'''''", gap: " ", comment: "# c" });
    expect(rewriteFillMarker("# ← FILL (3): your GitHub App slug")).toBe(
      "# filled by qcr: your GitHub App slug",
    );
    expect(rewriteFillMarker("# nothing to rewrite")).toBe("# nothing to rewrite");
  });
});

// ---- idempotent re-run -------------------------------------------------------

describe("re-run", () => {
  it("is byte-identical and rewrites nothing when every answer is kept", async () => {
    const first = await runStep();
    expect(failed(first.report)).toBe("");
    const afterFirst = readFileSync(join(root, "config.toml"), "utf8");

    // Second run: the operator presses Enter on every question (empty answers
    // keep the current values) — targeted edits, so nothing changes.
    const choices: Record<string, unknown> = {};
    const ctx: StepContext = {
      adapters: adapters(async () => ""),
      input: {},
      choices,
      data: (first.report.data ?? {}) as Record<string, unknown>,
      recordChoice: (k, v) => {
        choices[k] = v;
      },
    };
    const second = await configFillStep().run(ctx);
    expect(failed(second)).toBe("");
    expect(readFileSync(join(root, "config.toml"), "utf8")).toBe(afterFirst);
    expect(
      second.checks.some((c) => c.name === "config" && /nothing rewritten/.test(c.detail)),
    ).toBe(true);
  });

  it(
    "offers targeted edits — one changed answer touches one key and no other",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      await runStep();
      const before = readFileSync(join(root, "config.toml"), "utf8");

      const choices: Record<string, unknown> = {};
      const answers = new Map<string, string>([["default branch", "release"]]);
      const ctx: StepContext = {
        adapters: adapters(async (q) => {
          for (const [needle, value] of answers) if (q.includes(needle)) return value;
          return "";
        }),
        input: {},
        choices,
        data: {},
        recordChoice: (k, v) => {
          choices[k] = v;
        },
      };
      const report = await configFillStep().run(ctx);
      expect(failed(report)).toBe("");
      const after = readFileSync(join(root, "config.toml"), "utf8");
      const diff = after.split("\n").filter((l, i) => l !== before.split("\n")[i]);
      expect(diff.length).toBe(1);
      expect(diff[0]).toContain('base_branch = "release"');
      expect(producedConfig().github.repo).toBe("acme/web-app");
    },
  );

  it("preserves the operator's OWN comments and hand edits on re-run", async () => {
    await runStep();
    const path = join(root, "config.toml");
    writeFileSync(path, `${readFileSync(path, "utf8")}\n# my own note about this install\n`);
    const choices: Record<string, unknown> = {};
    const ctx: StepContext = {
      adapters: adapters(async () => ""),
      input: {},
      choices,
      data: {},
      recordChoice: (k, v) => {
        choices[k] = v;
      },
    };
    await configFillStep().run(ctx);
    expect(readFileSync(path, "utf8")).toContain("# my own note about this install");
  });

  it("verify re-checks the produced config instead of rewriting it", async () => {
    const first = await runStep();
    const ctx: StepContext = {
      adapters: adapters(),
      input: {},
      choices: {},
      data: (first.report.data ?? {}) as Record<string, unknown>,
      recordChoice: () => {},
    };
    const verified = await configFillStep().verify(ctx);
    expect(failed(verified)).toBe("");
    expect(verified.ok).toBe(true);
    expect(verified.checks.some((c) => c.name === "loader" && c.ok)).toBe(true);
  });

  it("verify is red when there is no config, and when a required key is empty", async () => {
    const bare: StepContext = {
      adapters: adapters(),
      input: {},
      choices: {},
      data: {},
      recordChoice: () => {},
    };
    const none = await configFillStep().verify(bare);
    expect(none.ok).toBe(false);
    expect(failed(none)).toMatch(/does not exist/);

    await runStep();
    const path = join(root, "config.toml");
    writeFileSync(path, readFileSync(path, "utf8").replace('repo = "acme/web-app"', 'repo = ""'));
    const emptied = await configFillStep().verify(bare);
    expect(emptied.ok).toBe(false);
    expect(failed(emptied)).toMatch(/repository to review is still empty/i);
  });

  it("verify goes red when a derived invariant stopped holding", async () => {
    await runStep();
    const path = join(root, "config.toml");
    writeFileSync(
      path,
      readFileSync(path, "utf8").replace(
        'bot_login = "acme-reviewer[bot]"',
        'bot_login = "someone-else[bot]"',
      ),
    );
    const ctx: StepContext = {
      adapters: adapters(),
      input: {},
      choices: {},
      data: {},
      recordChoice: () => {},
    };
    const report = await configFillStep().verify(ctx);
    expect(report.ok).toBe(false);
    expect(failed(report)).toMatch(/bot_login/);
  });
});

// ---- malformed answers -------------------------------------------------------

describe("malformed answers", () => {
  it("re-asks with plain guidance and accepts the corrected value", async () => {
    const { report, log } = await runStep({
      answers: { repo: ["https://github.com/acme/web-app", "acme/web-app"] },
    });
    expect(failed(report)).toBe("");
    expect(log.questions.some((q) => q.includes('a repository is "owner/name"'))).toBe(true);
    expect(producedConfig().github.repo).toBe("acme/web-app");
  });

  it("fails at the step, with the validator's guidance, when the answer stays malformed", async () => {
    const { report } = await runStep({ answers: { timezone: "CEST" } });
    expect(report.ok).toBe(false);
    expect(failed(report)).toMatch(/answer:timezone/);
    expect(failed(report)).toMatch(/IANA name/);
    expect(existsSync(join(root, "config.toml"))).toBe(false);
  });

  it("rejects a checkout path that does not exist, naming the path", async () => {
    const { report } = await runStep({ answers: { reviewed_repo_dir: join(root, "not-here") } });
    expect(report.ok).toBe(false);
    expect(failed(report)).toMatch(/nothing exists at/);
  });

  it("reports an unanswered required question when there is no prompter at all", async () => {
    const { report } = await runStep({ noPrompter: true });
    expect(report.ok).toBe(false);
    expect(failed(report)).toMatch(/answer:repo/);
    expect(failed(report)).toMatch(/Which repository/);
  });

  it("does not duplicate the secrets wizard — it reports what that wizard still owes", async () => {
    const secrets = join(root, "secrets");
    mkdirSync(secrets, { recursive: true });
    writeFileSync(join(secrets, "deploy_shape"), "tunnel");
    writeFileSync(join(secrets, "app_id"), "12345");
    const { report } = await runStep({ choices: { [CHOICE_KEYS.secretsDir]: secrets } });
    const check = report.checks.find((c) => c.name === "secrets")!;
    expect(check.ok).toBe(true);
    expect(check.detail).toContain("app.pem");
    expect(check.detail).toContain("tunnel_token");
    expect(check.detail).toContain("collect-secrets.sh");
  });
});

// ---- engine registration -----------------------------------------------------

describe("engine registration", () => {
  it("is registered in the default step set, after preflight", () => {
    const ids = defaultSteps().map((s) => s.id);
    expect(ids).toContain(CONFIG_FILL_STEP_ID);
    const steps = defaultSteps();
    expect(steps.find((s) => s.id === CONFIG_FILL_STEP_ID)!.order).toBeGreaterThan(
      steps.find((s) => s.id === "preflight")!.order,
    );
    expect(/^[a-z][a-z0-9_]*$/.test(CONFIG_FILL_STEP_ID)).toBe(true);
  });

  it("runs through the engine, persists, and resumes as verify-only", async () => {
    const engine = new OnboardingEngine(
      [configFillStep()],
      adapters(scriptedPrompter(fullAnswers(), askedIds({}), { questions: [] })),
    );
    const first = await engine.runStep(CONFIG_FILL_STEP_ID);
    expect(first.failures).toEqual([]);
    expect(first.ok).toBe(true);

    // A fresh engine over the same state dir re-verifies against reality.
    const resumed = new OnboardingEngine([configFillStep()], adapters());
    const reconciled = await resumed.reconcile();
    expect(reconciled.verified).toEqual([CONFIG_FILL_STEP_ID]);
    expect(reconciled.demoted).toEqual([]);

    // Reality disagreeing demotes the claim.
    rmSync(join(root, "config.toml"));
    const again = new OnboardingEngine([configFillStep()], adapters());
    const second = await again.reconcile();
    expect(second.demoted.map((d) => d.id)).toEqual([CONFIG_FILL_STEP_ID]);
  });

  it("refuses to write a config the loader would reject", async () => {
    writeFileSync(join(root, "config.example.toml"), '[github]\nrepo = ""\n');
    const { report } = await runStep();
    expect(report.ok).toBe(false);
    expect(failed(report)).toMatch(/would not load/);
    expect(existsSync(join(root, "config.toml"))).toBe(false);
  });

  it("says so plainly when the template is missing", async () => {
    rmSync(join(root, "config.example.toml"));
    const { report } = await runStep();
    expect(report.ok).toBe(false);
    expect(failed(report)).toMatch(/complete checkout/);
  });
});

// ---- edit plumbing -----------------------------------------------------------

describe("edit plumbing", () => {
  it("drops edits the document already carries", () => {
    const edits = buildEdits(fullFacts(), {}, true);
    const once = patchToml(TEMPLATE, changedEdits(TEMPLATE, edits));
    expect(changedEdits(once, edits)).toEqual([]);
    expect(patchToml(once, changedEdits(once, edits))).toBe(once);
  });

  it("renders a hostile answer as data, never as TOML structure", () => {
    expect(tomlString('a"\nb = 1')).toBe('"a\\"\\nb = 1"');
  });
});

// ---- the pi-driven route: answers as tool arguments ---------------------------

describe("answers given as the tool's arguments (no prompter)", () => {
  it("declares one string argument per interview question", () => {
    const params = configFillStep().parameters as {
      properties: Record<string, { type: string }>;
    };
    expect(Object.keys(params.properties).sort()).toEqual(QUESTIONS.map((q) => q.id).sort());
    for (const p of Object.values(params.properties)) expect(p.type).toBe("string");
  });

  it("fills a fresh config from the arguments alone", async () => {
    const { report } = await runStep({ noPrompter: true, input: fullAnswers() });
    expect(failed(report)).toBe("");
    const cfg = producedConfig();
    expect(cfg.github.repo).toBe("acme/web-app");
    expect(cfg.ops.timezone).toBe("Europe/Warsaw");
    expect(cfg.dry_run).toBe(true);
  });

  it("names the argument a required question still needs", async () => {
    const { report } = await runStep({
      noPrompter: true,
      input: { ...fullAnswers(), timezone: "" },
    });
    expect(report.ok).toBe(false);
    expect(failed(report)).toMatch(/answer:timezone.*`timezone` argument/);
    expect(existsSync(join(root, "config.toml"))).toBe(false);
  });

  it("refuses a malformed argument with the validator's guidance", async () => {
    const { report } = await runStep({
      noPrompter: true,
      input: { ...fullAnswers(), timezone: "CEST" },
    });
    expect(report.ok).toBe(false);
    expect(failed(report)).toMatch(/answer:timezone.*IANA name/);
    expect(existsSync(join(root, "config.toml"))).toBe(false);
  });

  it("keeps a value a sibling step recorded, and says the argument was not used", async () => {
    const { report } = await runStep({
      noPrompter: true,
      input: { ...fullAnswers(), app_slug: "other-app" },
      choices: { [CHOICE_KEYS.appSlug]: "acme-reviewer" },
    });
    expect(failed(report)).toBe("");
    expect(producedConfig().github.app_slug).toBe("acme-reviewer");
    const note = report.checks.find((c) => c.name === "answer:app_slug")!;
    expect(note.ok).toBe(true);
    expect(note.detail).toContain('"other-app" was not used');
  });

  it("changes a kept value when the argument names a new one", async () => {
    await runStep({ noPrompter: true, input: fullAnswers() });
    const { report } = await runStep({
      noPrompter: true,
      input: { timezone: "America/New_York" },
    });
    expect(failed(report)).toBe("");
    expect(producedConfig().ops.timezone).toBe("America/New_York");
  });
});

describe("re-runs that carry the checklist forward", () => {
  it("an argument changes an answer this step recorded itself on an earlier run", async () => {
    const first = await runStep({
      noPrompter: true,
      input: { ...fullAnswers(), base_branch: "mian" },
    });
    expect(failed(first.report)).toBe("");
    expect(first.choices[CHOICE_KEYS.baseBranch]).toBe("mian");
    const second = await runStep({
      noPrompter: true,
      input: { base_branch: "main", repo: "acme/other" },
      choices: first.choices,
      data: first.report.data,
    });
    expect(failed(second.report)).toBe("");
    const cfg = producedConfig();
    expect(cfg.github.base_branch).toBe("main");
    expect(cfg.github.repo).toBe("acme/other");
    expect(second.choices[CHOICE_KEYS.baseBranch]).toBe("main");
    expect(second.report.checks.some((c) => /was not used/.test(c.detail))).toBe(false);
  });

  it("a hand edit of config.toml survives a re-run with no argument for it", async () => {
    const first = await runStep({ noPrompter: true, input: fullAnswers() });
    const path = join(root, "config.toml");
    writeFileSync(
      path,
      readFileSync(path, "utf8").replace(/^base_branch = "main"/m, 'base_branch = "develop"'),
    );
    const second = await runStep({
      noPrompter: true,
      choices: first.choices,
      data: first.report.data,
    });
    expect(failed(second.report)).toBe("");
    expect(producedConfig().github.base_branch).toBe("develop");
  });

  it("a portable ~/ checkout path stays ~/ — a keep-everything re-run is byte-identical", async () => {
    const home = process.env.HOME;
    process.env.HOME = root;
    try {
      const first = await runStep({
        noPrompter: true,
        input: { ...fullAnswers(), reviewed_repo_dir: "~/checkout" },
      });
      expect(failed(first.report)).toBe("");
      const path = join(root, "config.toml");
      const before = readFileSync(path, "utf8");
      expect(before).toMatch(/^reviewed_repo_dir = "~\/checkout"/m);
      const second = await runStep({
        noPrompter: true,
        choices: first.choices,
        data: first.report.data,
      });
      expect(failed(second.report)).toBe("");
      expect(readFileSync(path, "utf8")).toBe(before);
    } finally {
      if (home === undefined) delete process.env.HOME;
      else process.env.HOME = home;
    }
  });

  it("says so when an argument answers a question the recorded shape does not ask", async () => {
    const { report } = await runStep({ noPrompter: true, input: fullAnswers() });
    expect(failed(report)).toBe("");
    const note = report.checks.find((c) => c.name === "answer:ssh_host")!;
    expect(note.ok).toBe(true);
    expect(note.detail).toMatch(
      /"review-vm" was not used — the recorded topology\/ingress does not ask/,
    );
  });
});

describe("a kept value passes the same validator as a fresh one", () => {
  it("refuses an existing config's checkout path that no longer exists", async () => {
    await runStep();
    rmSync(checkout, { recursive: true, force: true });
    const { report } = await runStep({ noPrompter: true });
    expect(report.ok).toBe(false);
    expect(failed(report)).toMatch(/answer:reviewed_repo_dir.*nothing exists at/);
  });
});

describe("an explicit clone_dir is the operator's", () => {
  it("run and verify both accept a clone_dir set to a free name", async () => {
    await runStep({ answers: { repo: "acme/state" } });
    const path = join(root, "config.toml");
    writeFileSync(
      path,
      readFileSync(path, "utf8").replace(/^clone_dir = ""/m, 'clone_dir = "reviewed-state"'),
    );
    expect(loadConfig(path).github.clone_dir).toBe("reviewed-state");
    const { report } = await runStep({ noPrompter: true });
    expect(failed(report)).toBe("");
    const ctx: StepContext = {
      adapters: adapters(),
      input: {},
      choices: {},
      data: {},
      recordChoice: () => {},
    };
    const verified = await configFillStep().verify(ctx);
    expect(failed(verified)).toBe("");
  });
});

describe("semantically kept TOML scalar spellings", () => {
  it("keeps a multiline continued scalar whose semantic answer is unchanged", () => {
    const text = '[owner]\nname = """Da\\\nna""" # keep this spelling\n';
    expect(
      changedEdits(text, [{ section: "owner", key: "name", value: tomlString("Dana") }]),
    ).toEqual([]);
  });
  it.each(["'Dana'", '"D\\u0061na"'])(
    "leaves an unchanged string spelling %s intact",
    (spelling) => {
      expect(
        changedEdits(`[owner]\nname = ${spelling} # keep this\n`, [
          { section: "owner", key: "name", value: tomlString("Dana") },
        ]),
      ).toEqual([]);
    },
  );
});

describe("interview validators agree with the sibling steps' predicates", () => {
  it("refuses an ssh alias with a leading dash (ssh reads it as an option)", () => {
    const q = QUESTIONS.find((x) => x.id === "ssh_host")!;
    expect(q.validate("-host")).not.toBeNull();
    expect(q.validate("my-vm-qc")).toBeNull();
  });

  it("refuses a hostname label longer than 63 characters", () => {
    const q = QUESTIONS.find((x) => x.id === "webhook_hostname")!;
    expect(q.validate(`${"a".repeat(64)}.com`)).not.toBeNull();
    expect(q.validate("Review.Example.com")).toBeNull();
  });
});
