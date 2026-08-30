// obligation ①: the App's REAL slug reconciled into config.toml.
//
// config_fill runs before the App exists, asks for a slug, and DERIVES
// [github] bot_login from it. GitHub then makes the name globally unique (and
// lets the operator rename it), so the recorded slug can be wrong — and a
// wrong bot_login is the defect nothing else in the system catches: the daemon
// uses it to recognise its OWN reviews and comments.
//
// Everything faked: a routed fake fetch for GET /app, a fake ProcessRunner for
// `docker compose ps`, a fake StreamRunner for the restart, temp dirs for the
// root and the secrets. No network, no docker.
import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OnboardingEngine, type OnboardAdapters, type ProcessResult } from "../src/onboard/engine.js";
import { APP_SLUG_STEP_ID, appSlugStep, botLoginFor, slugEdits } from "../src/onboard/steps/appslug.js";
import type { StreamRunner } from "../src/onboard/steps/compose.js";
import { APP_SLUG_CHOICE_KEY, BOT_LOGIN_CHOICE_KEY, SECRET_FILES } from "../src/onboard/steps/githubapp.js";
import { readTomlKey, setTomlKey } from "../src/onboard/steps/ingress.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const exampleConfig = readFileSync(join(repoRoot, "config.example.toml"), "utf8");
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const API = "https://api.test";

let root: string;
let secretsDir: string;

/** A config as config_fill would have left it: the operator's GUESSED slug. */
function writeConfig(slug: string, botLogin = `${slug}[bot]`): void {
  let text = setTomlKey(exampleConfig, "github", "app_slug", slug)!;
  text = setTomlKey(text, "github", "bot_login", botLogin)!;
  text = setTomlKey(text, "github", "secrets_dir", secretsDir)!;
  writeFileSync(join(root, "config.toml"), text);
}

function configText(): string {
  return readFileSync(join(root, "config.toml"), "utf8");
}

function writeCreds(): void {
  writeFileSync(join(secretsDir, SECRET_FILES.appId), "4242\n");
  writeFileSync(join(secretsDir, SECRET_FILES.pem), PEM);
  writeFileSync(join(secretsDir, SECRET_FILES.webhookSecret), "s".repeat(40));
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "qcr-appslug-"));
  secretsDir = join(root, "secrets");
  mkdirSync(secretsDir, { recursive: true });
  mkdirSync(join(root, "state"), { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

interface Harness {
  engine: OnboardingEngine;
  runs: string[][];
  streamed: string[][];
  logs: string[];
}

function harness(o: { slug?: string; appStatus?: number; daemonRunning?: boolean; streamCode?: number } = {}): Harness {
  const runs: string[][] = [];
  const streamed: string[][] = [];
  const logs: string[] = [];
  const fetchFake = (async (input: unknown) => {
    const url = String(input);
    if (url === `${API}/app`) {
      const status = o.appStatus ?? 200;
      return new Response(status === 200 ? JSON.stringify({ id: 4242, slug: o.slug ?? "quick-review-9f2" }) : JSON.stringify({ message: "nope" }), {
        status,
      });
    }
    throw new Error(`unexpected fetch ${url}`);
  }) as unknown as typeof fetch;
  const runner = {
    run: async (cmd: string, args: string[]): Promise<ProcessResult> => {
      runs.push([cmd, ...args]);
      if (args.includes("ps")) {
        const rows = o.daemonRunning ? [{ Service: "daemon", State: "running" }] : [];
        return { code: 0, stdout: JSON.stringify(rows), stderr: "" };
      }
      return { code: 1, stdout: "", stderr: "unexpected command in test" };
    },
  };
  const stream: StreamRunner = {
    run: async (cmd, args) => {
      streamed.push([cmd, ...args]);
      return { code: o.streamCode ?? 0, stdout: "", stderr: "" };
    },
  };
  const adapters: OnboardAdapters = {
    fetch: fetchFake,
    runner,
    clock: () => new Date("2026-08-30T12:00:00Z"),
    host: { nodeVersion: "v22.5.1", uid: 1000 },
    paths: { stateDir: join(root, "state") },
    log: (line) => logs.push(line),
  };
  return { engine: new OnboardingEngine([appSlugStep({ apiBase: API, secretsDir, stream })], adapters), runs, streamed, logs };
}

describe("slugEdits — the pure reconciliation", () => {
  it("corrects BOTH keys when the App's real slug differs from the recorded guess", () => {
    writeConfig("quick-review");
    const edits = slugEdits(configText(), "quick-review-9f2");
    expect(edits.map((e) => `${e.section}.${e.key}`)).toEqual(["github.app_slug", "github.bot_login"]);
    expect(edits[1]!.value).toBe('"quick-review-9f2[bot]"');
  });

  it("is empty when the file already agrees — a re-run is a no-op, not a rewrite", () => {
    writeConfig("quick-review-9f2");
    expect(slugEdits(configText(), "quick-review-9f2")).toEqual([]);
  });

  it("catches the wrong bot login even when the slug itself is right", () => {
    // The case nothing else notices: a hand-edited or mis-derived bot_login.
    writeConfig("quick-review-9f2", "quick-review[bot]");
    const edits = slugEdits(configText(), "quick-review-9f2");
    expect(edits.map((e) => e.key)).toEqual(["bot_login"]);
  });

  it("derives the bot login by the one rule", () => {
    expect(botLoginFor("acme-reviewer")).toBe("acme-reviewer[bot]");
  });
});

describe("the step", () => {
  it("corrects a uniqueness-suffixed slug and records both choices", async () => {
    writeConfig("quick-review");
    writeCreds();
    const h = harness({ slug: "quick-review-9f2" });
    const result = await h.engine.runStep(APP_SLUG_STEP_ID);
    expect(result.ok).toBe(true);
    expect(readTomlKey(configText(), "github", "app_slug")).toBe("quick-review-9f2");
    expect(readTomlKey(configText(), "github", "bot_login")).toBe("quick-review-9f2[bot]");
    expect(h.engine.choices()[APP_SLUG_CHOICE_KEY]).toBe("quick-review-9f2");
    expect(h.engine.choices()[BOT_LOGIN_CHOICE_KEY]).toBe("quick-review-9f2[bot]");
    // The reason it matters is said out loud, not left implicit.
    expect(result.checks.find((c) => c.name === "config")!.detail).toMatch(/recognises its OWN reviews/);
  });

  it("THE DEFECT NOTHING ELSE CATCHES: a wrong bot login is corrected on its own", async () => {
    writeConfig("quick-review-9f2", "quick-review[bot]");
    writeCreds();
    const h = harness({ slug: "quick-review-9f2" });
    expect((await h.engine.runStep(APP_SLUG_STEP_ID)).ok).toBe(true);
    expect(readTomlKey(configText(), "github", "bot_login")).toBe("quick-review-9f2[bot]");
  });

  it("leaves dry_run exactly as it found it (rule 1 — this step may never move it)", async () => {
    writeConfig("quick-review");
    writeCreds();
    expect(configText()).toMatch(/^dry_run = true/m);
    const h = harness({ slug: "quick-review-9f2" });
    await h.engine.runStep(APP_SLUG_STEP_ID);
    expect(configText()).toMatch(/^dry_run = true/m);
  });

  it("a second run changes nothing and rewrites nothing", async () => {
    writeConfig("quick-review");
    writeCreds();
    const h = harness({ slug: "quick-review-9f2" });
    await h.engine.runStep(APP_SLUG_STEP_ID);
    const after = configText();
    const second = await h.engine.runStep(APP_SLUG_STEP_ID);
    expect(second.ok).toBe(true);
    expect(configText()).toBe(after);
    expect(second.checks.find((c) => c.name === "config")!.detail).toMatch(/already match/);
  });

  it("restarts a RUNNING daemon after a correction — the config is read once, at boot", async () => {
    writeConfig("quick-review");
    writeCreds();
    const h = harness({ slug: "quick-review-9f2", daemonRunning: true });
    const result = await h.engine.runStep(APP_SLUG_STEP_ID);
    expect(result.ok).toBe(true);
    expect(h.streamed[0]).toEqual(["docker", "compose", "--project-directory", root, "restart", "daemon"]);
    expect(result.checks.find((c) => c.name === "daemon-restart")!.ok).toBe(true);
  });

  it("does not try to restart a daemon that is not running", async () => {
    writeConfig("quick-review");
    writeCreds();
    const h = harness({ slug: "quick-review-9f2", daemonRunning: false });
    const result = await h.engine.runStep(APP_SLUG_STEP_ID);
    expect(h.streamed).toEqual([]);
    expect(result.checks.find((c) => c.name === "daemon-restart")!.detail).toMatch(/nothing to restart/);
  });

  it("a failed restart is red and says the file on disk is already correct", async () => {
    writeConfig("quick-review");
    writeCreds();
    const h = harness({ slug: "quick-review-9f2", daemonRunning: true, streamCode: 1 });
    const result = await h.engine.runStep(APP_SLUG_STEP_ID);
    expect(result.ok).toBe(false);
    expect(result.failures.join(" ")).toMatch(/docker compose restart daemon/);
  });

  it("missing App credentials are red and name the step that writes them", async () => {
    writeConfig("quick-review");
    const h = harness({});
    const result = await h.engine.runStep(APP_SLUG_STEP_ID);
    expect(result.ok).toBe(false);
    expect(result.failures.join(" ")).toMatch(/run the github_app step/);
  });

  it("a GitHub that will not answer is red, and nothing is written", async () => {
    writeConfig("quick-review");
    writeCreds();
    const before = configText();
    const h = harness({ appStatus: 401 });
    const result = await h.engine.runStep(APP_SLUG_STEP_ID);
    expect(result.ok).toBe(false);
    expect(result.failures.join(" ")).toMatch(/HTTP 401/);
    expect(configText()).toBe(before);
  });

  it("a missing config.toml is red and names config_fill", async () => {
    writeCreds();
    const h = harness({ slug: "quick-review-9f2" });
    const result = await h.engine.runStep(APP_SLUG_STEP_ID);
    expect(result.ok).toBe(false);
    expect(result.failures.join(" ")).toMatch(/config_fill/);
  });
});

describe("verify", () => {
  it("NEVER writes: a disagreement is red and the file is left alone", async () => {
    writeConfig("quick-review");
    writeCreds();
    const before = configText();
    const h = harness({ slug: "quick-review-9f2" });
    const all = await h.engine.verifyAll();
    expect(all.ok).toBe(false);
    expect(all.results[0]!.failures.join(" ")).toMatch(/app_slug_reconcile/);
    expect(configText()).toBe(before);
  });

  it("is green once the file agrees with the App", async () => {
    writeConfig("quick-review-9f2");
    writeCreds();
    const h = harness({ slug: "quick-review-9f2" });
    expect((await h.engine.verifyAll()).ok).toBe(true);
  });

  it("resume DEMOTES the step when the App was renamed after it went green", async () => {
    writeConfig("quick-review");
    writeCreds();
    const first = harness({ slug: "quick-review-9f2" });
    expect((await first.engine.runStep(APP_SLUG_STEP_ID)).ok).toBe(true);
    // A new session, and GitHub now reports a different slug (a rename).
    const second = harness({ slug: "quick-review-renamed" });
    const reconciled = await second.engine.reconcile();
    expect(reconciled.demoted.map((d) => d.id)).toEqual([APP_SLUG_STEP_ID]);
    // …and running it again corrects the file to the new name.
    expect((await second.engine.runStep(APP_SLUG_STEP_ID)).ok).toBe(true);
    expect(readTomlKey(configText(), "github", "bot_login")).toBe("quick-review-renamed[bot]");
  });
});
