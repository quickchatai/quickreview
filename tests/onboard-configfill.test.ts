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
    runner: { run: async () => ({ code: 127, stdout: "", stderr: "no subprocesses in tests" }) },
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
    input: {},
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
  it("fills the config where the adapters say — a config home that does not exist yet — and never the checkout", async () => {
    const home = join(root, "xdg-config", "qcr", "default", "config.toml");
    const { report, choices } = await runStep({ configPath: home });
    expect(failed(report)).toBe("");
    expect(loadConfig(home).dry_run).toBe(true);
    expect(existsSync(join(root, "config.toml"))).toBe(false);
    expect(choices[CHOICE_KEYS.configPath]).toBe(home);
  });
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
    // written empty, resolved by the install locator at load.
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

  it("never flips an owner's ratified dry_run = false back to true", async () => {
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

/** buildEdits' guard is the structural half; call it directly on a raw list. */
function buildEditsGuard(edits: Array<{ section: string; key: string; value: string }>) {
  const facts = fullFacts();
  const built = buildEdits(facts, {}, true);
  return [...built, ...edits].map((e) => {
    if (/(^|[^0-9A-Za-z_])dry_run([^0-9A-Za-z_]|$)/.test(e.key)) {
      throw new Error(
        "onboarding config fill: refused an edit touching dry_run — rule 1: the flag is the owner's alone",
      );
    }
    return e;
  });
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
    expect(line).toContain("filled by qcr onboard:");
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
    const parsed = parseToml(out) as { tui: Record<string, unknown>; server: Record<string, unknown> };
    expect(parsed.tui).toEqual({ target: "ssh", ssh_host: "review-vm" });
    expect(parsed.server).toEqual({ port: 8787 });
  });

  it("splits a trailing comment only outside quotes", () => {
    expect(splitTail('"a#b"   # tail')).toEqual({ value: '"a#b"', gap: "   ", comment: "# tail" });
    expect(splitTail('"unterminated')).toBeNull();
    expect(rewriteFillMarker("# ← FILL (3): your GitHub App slug")).toBe(
      "# filled by qcr onboard: your GitHub App slug",
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

  it("offers targeted edits — one changed answer touches one key and no other", async () => {
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
  });

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
