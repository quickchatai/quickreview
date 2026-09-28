// bring-up, and memory's second phase.
//
// Bring-up is the one step in the wizard that takes a long time, so two of its
// properties are behavioural rather than incidental and are pinned here: the
// slow-first-build warning is emitted BEFORE the build starts, and build
// output is streamed line by line rather than swallowed.
//
// Everything faked: a fake StreamRunner stands in for `docker compose up`, a
// fake ProcessRunner for `docker compose ps`, temp dirs for the root. No test
// starts a container and no test waits on wall-clock time.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  OnboardingEngine,
  type CheckResult,
  type OnboardAdapters,
  type OnboardingStep,
  type ProcessResult,
  type StepReport,
} from "../src/onboard/engine.js";
import {
  BRINGUP_STEP_ID,
  BROUGHT_UP_CHOICE_KEY,
  FIRST_BUILD_WARNING,
  bringUpArgs,
  bringUpStep,
} from "../src/onboard/steps/bringup.js";
import type { StreamRunner } from "../src/onboard/steps/compose.js";
import { CHOICE_KEYS } from "../src/onboard/steps/configfill.js";
import { INGRESS_CHOICE_KEY, readEnvKey, setTomlKey } from "../src/onboard/steps/ingress.js";
import { MEMORY_CHOICE_KEY } from "../src/onboard/steps/memory.js";
import { MEMORY_KEYS_STEP_ID, memoryUserKeysStep } from "../src/onboard/steps/memorykeys.js";
import { UID_CHOICE_KEY } from "../src/onboard/steps/preflight.js";
import { defaultSteps } from "../src/onboard/steps/index.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const exampleConfig = readFileSync(join(repoRoot, "config.example.toml"), "utf8");

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "qcr-bringup-"));
  mkdirSync(join(root, "state"), { recursive: true });
  writeFileSync(join(root, "docker-compose.yml"), "name: quickreview\n");
  writeFileSync(
    join(root, "config.toml"),
    setTomlKey(exampleConfig, "github", "repo", "acme/web")!,
  );
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** Pre-record the choices sibling steps would have made, through the file the
 * engine resumes from — which is also how a real resume reaches this step. */
function seedChoices(choices: Record<string, unknown>): void {
  mkdirSync(join(root, "state", "onboarding"), { recursive: true });
  writeFileSync(
    join(root, "state", "onboarding", "checklist.json"),
    JSON.stringify({
      version: 1,
      created_at: "2026-08-30T10:00:00Z",
      updated_at: "2026-08-30T10:00:00Z",
      completed_at: null,
      choices,
      steps: {},
    }),
  );
}

interface Harness {
  engine: OnboardingEngine;
  streamed: string[][];
  events: string[];
  psCalls: number;
}

function harness(
  o: {
    streamCode?: number;
    lines?: string[];
    services?: Array<{ Service: string; State: string }>;
    psCode?: number;
    uid?: number | null;
    step?: OnboardingStep;
    configPath?: string;
  } = {},
): Harness {
  const streamed: string[][] = [];
  const events: string[] = [];
  const state = { psCalls: 0 };
  const stream: StreamRunner = {
    run: async (cmd, args, onLine) => {
      streamed.push([cmd, ...args]);
      events.push(`stream:${args.join(" ")}`);
      for (const line of o.lines ?? []) onLine(line);
      return {
        code: o.streamCode ?? 0,
        stdout: (o.lines ?? []).join("\n"),
        stderr: o.streamCode ? "build failed: no space left on device" : "",
      };
    },
  };
  const runner = {
    run: async (_cmd: string, args: string[]): Promise<ProcessResult> => {
      if (args.includes("ps")) {
        state.psCalls += 1;
        if (o.psCode)
          return { code: o.psCode, stdout: "", stderr: "cannot connect to the Docker daemon" };
        return {
          code: 0,
          stdout: JSON.stringify(o.services ?? [{ Service: "daemon", State: "running" }]),
          stderr: "",
        };
      }
      return { code: 1, stdout: "", stderr: "unexpected command" };
    },
  };
  const adapters: OnboardAdapters = {
    fetch: (() => {
      throw new Error("no network in tests");
    }) as unknown as typeof fetch,
    runner,
    clock: () => new Date("2026-08-30T12:00:00Z"),
    host: { nodeVersion: "v22.5.1", uid: o.uid === undefined ? 1000 : o.uid },
    paths: { stateDir: join(root, "state"), configPath: o.configPath ?? join(root, "config.toml") },
    log: (line) => events.push(`log:${line}`),
  };
  return {
    engine: new OnboardingEngine([o.step ?? bringUpStep({ stream, progressEvery: 2 })], adapters),
    streamed,
    events,
    get psCalls() {
      return state.psCalls;
    },
  };
}

const envText = (): string => readFileSync(join(root, ".env"), "utf8");

describe("the registered sequence (tail)", () => {
  it("runs after memory, in one order, with tool-name-safe ids", () => {
    const steps = defaultSteps();
    const ids = steps.map((s) => s.id);
    expect(ids).toEqual([
      "preflight",
      // the topology question, then the VM route's ssh preflight —
      // first among that route's steps, before anything is minted or written.
      "topology",
      "ssh_preflight",
      "llm_auth",
      "config_fill",
      // the escalation question sits right after the interview — it
      // patches the config the interview just wrote, and "no" (the default,
      // and the right answer for most teams) leaves everything unchanged.
      "escalation",
      // the embedder — local by default, so calling it with no answer
      // confirms the default; a hosted opt-in is the only thing it asks about.
      "embeddings",
      "github_app",
      "ingress",
      "memory",
      "app_slug_reconcile",
      "vm_inventory",
      "bringup",
      "vm_deploy",
      "memory_user_keys",
      "verify_stack",
      "proof_round",
      "go_live",
    ]);
    const orders = steps.map((s) => s.order);
    expect(orders).toEqual([...orders].sort((a, b) => a - b));
    expect(new Set(orders).size).toBe(orders.length);
    const memoryOrder = steps.find((s) => s.id === "memory")!.order;
    for (const id of [
      "app_slug_reconcile",
      "bringup",
      "memory_user_keys",
      "verify_stack",
      "proof_round",
      "go_live",
    ]) {
      expect(steps.find((s) => s.id === id)!.order).toBeGreaterThan(memoryOrder);
    }
    for (const id of ids) expect(`onboard_${id}`).toMatch(/^[a-z][a-z0-9_]*$/);
  });

  it("the flip is the LAST thing the wizard does", () => {
    expect(defaultSteps().at(-1)!.id).toBe("go_live");
  });
});

describe("bringUpArgs", () => {
  it("passes the chosen profile explicitly, and omits it entirely for the polling shape", () => {
    expect(bringUpArgs("/repo", "quick-tunnel")).toEqual([
      "compose",
      "--project-directory",
      "/repo",
      "--profile",
      "quick-tunnel",
      "up",
      "-d",
      "--build",
    ]);
    expect(bringUpArgs("/repo", "")).toEqual([
      "compose",
      "--project-directory",
      "/repo",
      "up",
      "-d",
      "--build",
    ]);
  });
});

describe("bring-up, happy path", () => {
  it("writes the captured uid and the chosen profile into .env, and brings the stack up", async () => {
    seedChoices({ [UID_CHOICE_KEY]: 1234, [INGRESS_CHOICE_KEY]: "quick" });
    const h = harness({
      services: [
        { Service: "daemon", State: "running" },
        { Service: "tunnel-quick", State: "running" },
      ],
    });
    const result = await h.engine.runStep(BRINGUP_STEP_ID);
    expect(result.ok).toBe(true);
    expect(readEnvKey(envText(), "QCR_UID")).toBe("1234");
    expect(readEnvKey(envText(), "COMPOSE_PROFILES")).toBe("quick-tunnel");
    expect(h.streamed[0]).toEqual(["docker", ...bringUpArgs(root, "quick-tunnel")]);
    expect(h.engine.choices()[BROUGHT_UP_CHOICE_KEY]).toBe("2026-08-30T12:00:00.000Z");
    expect(result.checks.find((c) => c.name === "ingress-sidecar")!.ok).toBe(true);
  });

  // the container reads the config the install locator found on the
  // host. The compose file mounts QCR_CONFIG_HOME read-only and the entrypoint
  // names QCR_CONFIG_NAME inside it — so a config in the install's config home
  // reaches the daemon, and a legacy checkout config still does (the home is
  // mounted empty, the in-container locator falls back to the sandbox).
  it("mounts the directory of the config the locator found", async () => {
    const home = join(root, "..", `${root.split("/").pop()}-cfghome`);
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "config.toml"), readFileSync(join(root, "config.toml"), "utf8"));
    rmSync(join(root, "config.toml"));
    try {
      const h = harness({ configPath: join(home, "config.toml") });
      expect((await h.engine.runStep(BRINGUP_STEP_ID)).ok).toBe(true);
      expect(readEnvKey(envText(), "QCR_CONFIG_HOME")).toBe(home);
      expect(readEnvKey(envText(), "QCR_CONFIG_NAME")).toBe("config.toml");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("a legacy checkout config mounts the (created, empty) config home instead", async () => {
    const { configHome } = await import("../src/install.js");
    const h = harness();
    expect((await h.engine.runStep(BRINGUP_STEP_ID)).ok).toBe(true);
    expect(readEnvKey(envText(), "QCR_CONFIG_HOME")).toBe(configHome());
    expect(existsSync(configHome())).toBe(true);
  });

  // the compose file mounts QCR_SECRETS_DIR read-only as the
  // container's secrets — the install locator's answer, created before Docker
  // could create it as root.
  it("writes the located secrets dir into .env and creates it", async () => {
    const { locateSecrets } = await import("../src/install.js");
    // The example config leaves secrets_dir empty: the locator's answer (the
    // temp config home — or a developer's own legacy dir while it exists).
    const located = locateSecrets().path;
    let h = harness();
    expect((await h.engine.runStep(BRINGUP_STEP_ID)).ok).toBe(true);
    expect(readEnvKey(envText(), "QCR_SECRETS_DIR")).toBe(located);
    expect(existsSync(located)).toBe(true);
    const chosen = join(root, "..", `${root.split("/").pop()}-secrets`);
    const cfg = join(root, "config.toml");
    writeFileSync(cfg, setTomlKey(readFileSync(cfg, "utf8"), "github", "secrets_dir", chosen)!);
    try {
      h = harness();
      expect((await h.engine.runStep(BRINGUP_STEP_ID)).ok).toBe(true);
      expect(readEnvKey(envText(), "QCR_SECRETS_DIR")).toBe(chosen);
      expect(existsSync(chosen)).toBe(true);
    } finally {
      rmSync(chosen, { recursive: true, force: true });
    }
  });

  it("falls back to the live host uid when preflight recorded none", async () => {
    const h = harness({ uid: 501 });
    expect((await h.engine.runStep(BRINGUP_STEP_ID)).ok).toBe(true);
    expect(readEnvKey(envText(), "QCR_UID")).toBe("501");
  });

  it("brings the daemon up alone when the polling shape was chosen", async () => {
    seedChoices({ [INGRESS_CHOICE_KEY]: "polling" });
    const h = harness();
    const result = await h.engine.runStep(BRINGUP_STEP_ID);
    expect(result.ok).toBe(true);
    expect(h.streamed[0]).not.toContain("--profile");
    expect(readEnvKey(envText(), "COMPOSE_PROFILES")).toBe("");
    expect(result.checks.some((c) => c.name === "ingress-sidecar")).toBe(false);
  });
});

describe("the honest warning and the progress", () => {
  it("warns about the slow first build BEFORE the build starts, never after", async () => {
    const h = harness({ lines: ["#1 building"] });
    await h.engine.runStep(BRINGUP_STEP_ID);
    const firstWarning = h.events.findIndex((e) =>
      e.includes("compiles the memory engine's local embedder"),
    );
    const firstStream = h.events.findIndex((e) => e.startsWith("stream:"));
    expect(firstWarning).toBeGreaterThanOrEqual(0);
    expect(firstWarning).toBeLessThan(firstStream);
  });

  it("says what it says: source compile, how long, and that it is expected", () => {
    expect(FIRST_BUILD_WARNING).toMatch(/llama-cpp-python/);
    expect(FIRST_BUILD_WARNING).toMatch(/ten minutes to an hour/);
    expect(FIRST_BUILD_WARNING).toMatch(/expected, not a hang/);
  });

  it("streams every build line and marks elapsed time so a long wait looks alive", async () => {
    const h = harness({
      lines: [
        "#1 [internal] load build definition",
        "#2 resolve image",
        "#3 compiling llama",
        "#4 done",
      ],
    });
    const result = await h.engine.runStep(BRINGUP_STEP_ID);
    expect(result.ok).toBe(true);
    for (const line of ["#1 [internal] load build definition", "#4 done"]) {
      expect(h.events).toContain(`log:${BRINGUP_STEP_ID}: ${line}`);
    }
    // progressEvery: 2 in this harness ⇒ a marker after lines 2 and 4.
    expect(h.events.filter((e) => e.includes("still working"))).toHaveLength(2);
  });
});

describe("bring-up failures — every one of them plain and re-runnable", () => {
  it("a failed build reports Docker's own tail and the three usual causes", async () => {
    const h = harness({ streamCode: 1, lines: ["#12 ERROR: process did not complete"] });
    const result = await h.engine.runStep(BRINGUP_STEP_ID);
    expect(result.ok).toBe(false);
    const detail = result.failures.join("\n");
    expect(detail).toMatch(/no space left on device/);
    expect(detail).toMatch(/docker system prune/);
    expect(detail).toMatch(/safe to retry/);
    expect(h.engine.choices()[BROUGHT_UP_CHOICE_KEY]).toBeUndefined();
  });

  it("a build that succeeds but leaves the daemon dead is red, with the log command", async () => {
    const h = harness({ services: [{ Service: "daemon", State: "exited (1)" }] });
    const result = await h.engine.runStep(BRINGUP_STEP_ID);
    expect(result.ok).toBe(false);
    expect(result.failures.join(" ")).toMatch(/docker compose logs --tail 200 daemon/);
  });

  it("a missing tunnel sidecar names the profile that starts it", async () => {
    seedChoices({ [INGRESS_CHOICE_KEY]: "ngrok" });
    const h = harness({ services: [{ Service: "daemon", State: "running" }] });
    const result = await h.engine.runStep(BRINGUP_STEP_ID);
    expect(result.ok).toBe(false);
    expect(result.failures.join(" ")).toMatch(/COMPOSE_PROFILES=ngrok docker compose up -d/);
  });

  it("an unreachable Docker is red and says so, rather than claiming the stack is down", async () => {
    const h = harness({ psCode: 1 });
    const result = await h.engine.runStep(BRINGUP_STEP_ID);
    expect(result.ok).toBe(false);
    expect(result.failures.join(" ")).toMatch(/could not ask Docker what is running/);
  });

  it("no uid anywhere is red and names preflight (and WSL2 on Windows)", async () => {
    const h = harness({ uid: null });
    const result = await h.engine.runStep(BRINGUP_STEP_ID);
    expect(result.ok).toBe(false);
    expect(result.failures.join(" ")).toMatch(/run the preflight step/);
    expect(result.failures.join(" ")).toMatch(/WSL2/);
    expect(h.streamed).toEqual([]);
  });

  it("no config.toml is red and names config_fill — nothing is built", async () => {
    rmSync(join(root, "config.toml"));
    const h = harness();
    const result = await h.engine.runStep(BRINGUP_STEP_ID);
    expect(result.ok).toBe(false);
    expect(result.failures.join(" ")).toMatch(/config_fill/);
    expect(h.streamed).toEqual([]);
  });

  it("a checkout without the compose file is refused before anything else", async () => {
    rmSync(join(root, "docker-compose.yml"));
    const h = harness();
    const result = await h.engine.runStep(BRINGUP_STEP_ID);
    expect(result.ok).toBe(false);
    expect(result.failures.join(" ")).toMatch(/docker-compose\.yml is missing/);
  });
});

describe("verify-only and resumability", () => {
  it("verify NEVER builds — it asks Docker what is running", async () => {
    const h = harness();
    const all = await h.engine.verifyAll();
    expect(all.ok).toBe(true);
    expect(h.streamed).toEqual([]);
  });

  it("a done step is DEMOTED on resume when the stack has since stopped", async () => {
    const up = harness();
    expect((await up.engine.runStep(BRINGUP_STEP_ID)).ok).toBe(true);
    const down = harness({ services: [] });
    const reconciled = await down.engine.reconcile();
    expect(reconciled.demoted.map((d) => d.id)).toEqual([BRINGUP_STEP_ID]);
  });

  it("is disabled on the VM topology — that route brings the system up through Ansible", async () => {
    seedChoices({ [CHOICE_KEYS.topology]: "vm" });
    const h = harness();
    expect(h.engine.list()[0]!.status).toBe("disabled");
    const result = await h.engine.runStep(BRINGUP_STEP_ID);
    expect(result.ok).toBe(false);
    expect(result.failures.join(" ")).toMatch(/disabled by the recorded choices/);
  });
});

describe("memory phase B — driven, never duplicated", () => {
  /** A stand-in for the real memory step, so the delegation is observable. */
  function spyStep(report: StepReport, calls: string[]): OnboardingStep {
    return {
      id: "memory",
      title: "memory",
      explain: "",
      order: 60,
      run: async () => {
        calls.push("run");
        return report;
      },
      verify: async () => {
        calls.push("verify");
        return report;
      },
    };
  }

  it("run() delegates to the memory step itself — no second minting path exists here", async () => {
    const calls: string[] = [];
    const checks: CheckResult[] = [
      { name: "user-keys", ok: true, detail: "minted reviewer, companion" },
    ];
    const h = harness({
      step: memoryUserKeysStep({ inner: spyStep({ ok: true, checks }, calls) }),
    });
    const result = await h.engine.runStep(MEMORY_KEYS_STEP_ID);
    expect(calls).toEqual(["run"]);
    expect(result.ok).toBe(true);
    expect(result.checks.map((c) => c.name)).toEqual(["phase", "user-keys"]);
    expect(result.checks[0]!.detail).toMatch(/phase B/);
  });

  it("verify() delegates too, so the two checklist rows can never disagree about reality", async () => {
    const calls: string[] = [];
    const h = harness({
      step: memoryUserKeysStep({
        inner: spyStep(
          { ok: false, checks: [{ name: "memory-server", ok: false, detail: "no server" }] },
          calls,
        ),
      }),
    });
    const all = await h.engine.verifyAll();
    expect(calls).toEqual(["verify"]);
    expect(all.ok).toBe(false);
  });

  it("a declined memory setup stays declined here — nothing is asked or minted twice", async () => {
    seedChoices({ [MEMORY_CHOICE_KEY]: "declined" });
    const calls: string[] = [];
    const h = harness({
      step: memoryUserKeysStep({
        inner: spyStep(
          { ok: true, checks: [{ name: "memory", ok: true, detail: "declined" }] },
          calls,
        ),
      }),
    });
    const result = await h.engine.runStep(MEMORY_KEYS_STEP_ID);
    expect(result.ok).toBe(true);
    expect(result.checks[0]!.detail).toMatch(/declined earlier/);
  });

  it("the real step is the memory step: it lands the root key offline and says phase B waits", async () => {
    // No fake inner: the genuine memory step, with no server answering.
    const step = memoryUserKeysStep({
      secretsDir: join(root, "secrets"),
      keysFile: join(root, "keys.env"),
      base: "http://127.0.0.1:1",
      loadProvision: async () => ({
        mintRootKey: () => "root-key-value",
        mintUserKeys: async () => ({
          keys: {},
          created: [],
          kept: [],
          missing: ["reviewer"],
          ok: false,
          detail: "no server",
        }),
      }),
      loadMatrix: async () => ({ runVerify: async () => ({ rows: [], failed: 0, unclear: 0 }) }),
    });
    const adapters: OnboardAdapters = {
      fetch: (async () => {
        throw new Error("connect ECONNREFUSED");
      }) as unknown as typeof fetch,
      runner: { run: async () => ({ code: 1, stdout: "", stderr: "" }) },
      clock: () => new Date("2026-08-30T12:00:00Z"),
      host: { nodeVersion: "v22.5.1", uid: 1000 },
      paths: { stateDir: join(root, "state"), configPath: join(root, "config.toml") },
    };
    const engine = new OnboardingEngine([step], adapters);
    const result = await engine.runStep(MEMORY_KEYS_STEP_ID);
    expect(result.ok).toBe(false);
    expect(result.failures.join(" ")).toMatch(/bring the stack up, then run this step again/);
    expect(existsSync(join(root, "secrets", "openviking_root_key"))).toBe(true);
  });
});
