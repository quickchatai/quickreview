// Bring-up, and memory's second phase.
//
// Bring-up is the one step in the wizard that takes a long time, so two of its
// properties are behavioural rather than incidental and are pinned here: the
// slow-first-pull note is emitted BEFORE the pull starts, and Docker's output
// is streamed line by line rather than swallowed. The stack is pulled, never
// built; and where there is no Docker (the wizard inside the image, D16) the
// step starts nothing and prints the host's commands.
//
// Everything faked: a fake StreamRunner stands in for `docker compose pull`
// and `up`, a fake ProcessRunner for `docker compose ps`, temp dirs for the
// root. No test starts a container and no test waits on wall-clock time.
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
  FIRST_PULL_NOTICE,
  bringUpArgs,
  bringUpStep,
  memoryEndpointPatch,
} from "../src/onboard/steps/bringup.js";
import {
  extractCommand,
  hostCommands,
  pullArgs,
  type StreamRunner,
} from "../src/onboard/steps/compose.js";
import { CHOICE_KEYS } from "../src/onboard/steps/configfill.js";
import {
  INGRESS_CHOICE_KEY,
  readEnvKey,
  readTomlKey,
  setTomlKey,
} from "../src/onboard/steps/ingress.js";
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
    /** `docker compose version` exits nonzero: no Docker here (the image). */
    noDocker?: boolean;
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
      if (args[0] === "compose" && args[1] === "version") {
        return o.noDocker
          ? { code: 127, stdout: "", stderr: "docker: command not found" }
          : { code: 0, stdout: "Docker Compose version v2.29.0\n", stderr: "" };
      }
      if (args.includes("ps")) {
        state.psCalls += 1;
        if (o.psCode)
          return { code: o.psCode, stdout: "", stderr: "cannot connect to the Docker daemon" };
        return {
          code: 0,
          stdout: JSON.stringify(
            o.services ?? [
              { Service: "daemon", State: "running" },
              { Service: "memory", State: "running" },
            ],
          ),
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

describe("the registered sequence's tail", () => {
  it("runs after memory, in one order, with tool-name-safe ids", () => {
    const steps = defaultSteps();
    const ids = steps.map((s) => s.id);
    expect(ids).toEqual([
      "preflight",
      // The topology question, then the VM route's ssh preflight —
      // first among that route's steps, before anything is minted or written.
      "topology",
      "ssh_preflight",
      "llm_auth",
      "config_fill",
      // The escalation question sits right after the interview — it
      // patches the config the interview just wrote, and "no" (the default,
      // and the right answer for most teams) leaves everything unchanged.
      "escalation",
      // The embedder — local by default, so calling it with no answer
      // confirms the default; a hosted opt-in is the only thing it asks about.
      "embeddings",
      // The ingress step before the App: its fixed hostname goes into the
      // App's manifest, which is read once, at creation.
      "ingress",
      "github_app",
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

describe("bringUpArgs and pullArgs", () => {
  it("passes the chosen profile explicitly, and omits it entirely for the polling shape", () => {
    expect(bringUpArgs("/repo", "quick-tunnel")).toEqual([
      "compose",
      "--project-directory",
      "/repo",
      "--profile",
      "quick-tunnel",
      "up",
      "-d",
    ]);
    expect(bringUpArgs("/repo", "")).toEqual([
      "compose",
      "--project-directory",
      "/repo",
      "up",
      "-d",
    ]);
  });

  it("never builds the app: no --build anywhere, and the pull skips what is built (the tunnels)", () => {
    for (const profile of ["", "quick-tunnel"]) {
      expect(bringUpArgs("/repo", profile)).not.toContain("--build");
      expect(pullArgs("/repo", profile)).toContain("pull");
      expect(pullArgs("/repo", profile)).toContain("--ignore-buildable");
      expect(pullArgs("/repo", profile)).not.toContain("--build");
    }
    expect(pullArgs("/repo", "ngrok").slice(0, 5)).toEqual([
      "compose",
      "--project-directory",
      "/repo",
      "--profile",
      "ngrok",
    ]);
  });
});

describe("bring-up, happy path", () => {
  it("writes the captured uid and the chosen profile into .env, and pulls then brings the stack up", async () => {
    seedChoices({ [UID_CHOICE_KEY]: 1234, [INGRESS_CHOICE_KEY]: "quick" });
    const h = harness({
      services: [
        { Service: "daemon", State: "running" },
        { Service: "memory", State: "running" },
        { Service: "tunnel-quick", State: "running" },
      ],
    });
    const result = await h.engine.runStep(BRINGUP_STEP_ID);
    expect(result.ok).toBe(true);
    expect(readEnvKey(envText(), "QCR_UID")).toBe("1234");
    expect(readEnvKey(envText(), "COMPOSE_PROFILES")).toBe("quick-tunnel");
    // the base clone the compose file mounts a volume at: the repo's name
    expect(readEnvKey(envText(), "QCR_CLONE_DIR")).toBe("web");
    expect(h.streamed).toEqual([
      ["docker", ...pullArgs(root, "quick-tunnel")],
      ["docker", ...bringUpArgs(root, "quick-tunnel")],
    ]);
    expect(h.engine.choices()[BROUGHT_UP_CHOICE_KEY]).toBe("2026-08-30T12:00:00.000Z");
    expect(result.checks.find((c) => c.name === "ingress-sidecar")!.ok).toBe(true);
  });

  // The stack is pinned: the release the images are pulled at is in .env, and
  // a later run keeps the pin an earlier one wrote.
  it("pins QCR_VERSION in .env from the package, and keeps a pin already there", async () => {
    const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
      version: string;
    };
    let h = harness();
    expect((await h.engine.runStep(BRINGUP_STEP_ID)).ok).toBe(true);
    expect(readEnvKey(envText(), "QCR_VERSION")).toBe(pkg.version);
    writeFileSync(join(root, ".env"), "QCR_VERSION=9.9.9\n");
    h = harness();
    expect((await h.engine.runStep(BRINGUP_STEP_ID)).ok).toBe(true);
    expect(readEnvKey(envText(), "QCR_VERSION")).toBe("9.9.9");
  });

  // The container reads the config the install locator found on the
  // host. The compose file mounts QCR_CONFIG_HOME read-only and the entrypoint
  // names QCR_CONFIG_NAME inside it — so a config in the install's config home
  // reaches the daemon. There is no checkout fallback in the container
  // either, so whatever the locator found is what is mounted.
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

  it("a config named inside the checkout mounts its own directory — never an empty home", async () => {
    const h = harness();
    expect((await h.engine.runStep(BRINGUP_STEP_ID)).ok).toBe(true);
    expect(readEnvKey(envText(), "QCR_CONFIG_HOME")).toBe(root);
    expect(readEnvKey(envText(), "QCR_CONFIG_NAME")).toBe("config.toml");
  });

  // The compose file mounts QCR_SECRETS_DIR read-only as the
  // container's secrets — the install locator's answer, created before Docker
  // could create it as root.
  it("writes the located secrets dir into .env and creates it", async () => {
    const { locateSecrets } = await import("../src/install.js");
    // The example config leaves secrets_dir empty: the locator's answer (the
    // temp config home).
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

  // Compose interpolates `$VAR` in an unquoted .env value, so a mount source
  // spelled with a `$` would bind a DIFFERENT host directory than the one the
  // operator chose (`/srv/$TEAM` → `/srv/` with TEAM unset). Refused, before
  // anything is created, written or built.
  it("refuses a secrets dir or config home whose path Compose would interpolate", async () => {
    const chosen = join(root, "..", `${root.split("/").pop()}-$TEAM`);
    const cfg = join(root, "config.toml");
    writeFileSync(cfg, setTomlKey(readFileSync(cfg, "utf8"), "github", "secrets_dir", chosen)!);
    try {
      let h = harness();
      let result = await h.engine.runStep(BRINGUP_STEP_ID);
      expect(result.ok).toBe(false);
      expect(result.checks.find((c) => c.name === "mount-paths")?.detail).toMatch(/\$/);
      expect(existsSync(chosen)).toBe(false);
      expect(existsSync(join(root, ".env"))).toBe(false);
      expect(h.streamed).toEqual([]);

      const home = join(root, "..", `${root.split("/").pop()}-cfg$HOME`);
      mkdirSync(home, { recursive: true });
      try {
        writeFileSync(
          join(home, "config.toml"),
          setTomlKey(exampleConfig, "github", "repo", "acme/web")!,
        );
        h = harness({ configPath: join(home, "config.toml") });
        result = await h.engine.runStep(BRINGUP_STEP_ID);
        expect(result.ok).toBe(false);
        expect(result.checks.find((c) => c.name === "mount-paths")?.detail).toContain(home);
        expect(h.streamed).toEqual([]);
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    } finally {
      rmSync(chosen, { recursive: true, force: true });
    }
  });

  it("refuses a mount path whose whitespace-hash suffix Compose would treat as a comment", async () => {
    const chosen = join(root, "config #team");
    mkdirSync(chosen);
    const configPath = join(chosen, "config.toml");
    writeFileSync(configPath, exampleConfig);
    const h = harness({ configPath });
    const result = await h.engine.runStep(BRINGUP_STEP_ID);
    expect(result.ok).toBe(false);
    expect(result.checks.find((c) => c.name === "mount-paths")?.detail).toMatch(/comment|#/);
    expect(existsSync(join(root, ".env"))).toBe(false);
    expect(h.streamed).toEqual([]);
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

describe("the memory sidecar endpoint", () => {
  it("writes [openviking] endpoint = remote and host = memory into config.toml, parseable, once", async () => {
    const before = readFileSync(join(root, "config.toml"), "utf8");
    expect(readTomlKey(before, "openviking", "endpoint")).toBe("local");
    const h = harness();
    const result = await h.engine.runStep(BRINGUP_STEP_ID);
    expect(result.ok).toBe(true);
    expect(result.checks.find((c) => c.name === "memory-endpoint")?.ok).toBe(true);
    const after = readFileSync(join(root, "config.toml"), "utf8");
    expect(readTomlKey(after, "openviking", "endpoint")).toBe("remote");
    expect(readTomlKey(after, "openviking", "host")).toBe("memory");
    // only those two keys moved, and never dry_run
    expect(readTomlKey(after, "daemon", "dry_run")).toBe(readTomlKey(before, "daemon", "dry_run"));
    expect(memoryEndpointPatch(after)).toBeNull();
    const again = await harness().engine.runStep(BRINGUP_STEP_ID);
    expect(again.checks.some((c) => c.name === "memory-endpoint")).toBe(false);
    expect(readFileSync(join(root, "config.toml"), "utf8")).toBe(after);
  });

  it("leaves a memory-less install alone (a declined memory setup says enabled = false)", async () => {
    const cfg = join(root, "config.toml");
    writeFileSync(cfg, setTomlKey(readFileSync(cfg, "utf8"), "openviking", "enabled", "false")!);
    const before = readFileSync(cfg, "utf8");
    const h = harness({ services: [{ Service: "daemon", State: "running" }] });
    const result = await h.engine.runStep(BRINGUP_STEP_ID);
    expect(result.ok).toBe(true);
    expect(readFileSync(cfg, "utf8")).toBe(before);
    expect(result.checks.some((c) => c.name === "memory-sidecar")).toBe(false);
  });

  it("a stack with the memory sidecar down is red, with its log command", async () => {
    const h = harness({ services: [{ Service: "daemon", State: "running" }] });
    const result = await h.engine.runStep(BRINGUP_STEP_ID);
    expect(result.ok).toBe(false);
    expect(result.failures.join(" ")).toMatch(/docker compose logs --tail 200 memory/);
  });
});

describe("the honest note and the progress", () => {
  it("notes the slow first pull BEFORE the pull starts, never after", async () => {
    const h = harness({ lines: ["#1 pulling"] });
    await h.engine.runStep(BRINGUP_STEP_ID);
    const firstNote = h.events.findIndex((e) => e.includes("The FIRST pull is the slow one"));
    const firstStream = h.events.findIndex((e) => e.startsWith("stream:"));
    expect(firstNote).toBeGreaterThanOrEqual(0);
    expect(firstNote).toBeLessThan(firstStream);
  });

  it("says what it says: two images, the model inside the memory one, and that it is expected", () => {
    expect(FIRST_PULL_NOTICE).toMatch(/daemon image and the memory image/);
    expect(FIRST_PULL_NOTICE).toMatch(/embedding model/);
    expect(FIRST_PULL_NOTICE).toMatch(/expected, not a hang/);
    expect(FIRST_PULL_NOTICE).toMatch(/read:packages/);
    expect(FIRST_PULL_NOTICE).not.toMatch(/compil/i);
  });

  it("streams every Docker line and marks elapsed time so a long wait looks alive", async () => {
    const h = harness({
      lines: ["#1 pulling daemon", "#2 pulling memory", "#3 extracting", "#4 done"],
    });
    const result = await h.engine.runStep(BRINGUP_STEP_ID);
    expect(result.ok).toBe(true);
    for (const line of ["#1 pulling daemon", "#4 done"]) {
      expect(h.events).toContain(`log:${BRINGUP_STEP_ID}: ${line}`);
    }
    // progressEvery: 2 in this harness, and the fake emits 4 lines for the pull
    // and 4 for the up ⇒ a marker after every second line of the eight.
    expect(h.events.filter((e) => e.includes("still working"))).toHaveLength(4);
  });
});

describe("no Docker where the wizard runs (D16)", () => {
  it("starts nothing and prints the exact host commands, in order, red until the stack is seen", async () => {
    seedChoices({ [UID_CHOICE_KEY]: 1234, [INGRESS_CHOICE_KEY]: "quick" });
    const h = harness({ noDocker: true });
    const result = await h.engine.runStep(BRINGUP_STEP_ID);
    expect(result.ok).toBe(false);
    expect(h.streamed).toEqual([]);
    expect(existsSync(join(root, ".env"))).toBe(false);
    const detail = result.checks.find((c) => c.name === "host-commands")!.detail;
    const order = [
      "mkdir -p ~/qcr-bot && cd ~/qcr-bot",
      'mkdir -p "${XDG_CONFIG_HOME:-$HOME/.config}/qcr/',
      "# Put config.toml in ",
      'host = "memory"',
      "docker run --rm --entrypoint tar ghcr.io/quickchatai/quickreview:",
      "cat > .env <<'QCR_ENV'",
      "QCR_UID=1234",
      "COMPOSE_PROFILES=quick-tunnel",
      "docker compose --profile quick-tunnel pull --ignore-buildable",
      "docker compose --profile quick-tunnel up -d",
    ].map((needle) => detail.indexOf(needle));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // the same commands reach the wizard's log, line by line
    expect(h.events.some((e) => e.includes("pull --ignore-buildable"))).toBe(true);
    // no secret and no token in it: only paths, a port knob, a uid and a pin
    expect(detail).not.toMatch(/ghp_|github_pat_|BEGIN .*PRIVATE KEY/);
    expect(detail).toMatch(/QCR_SECRETS_DIR=/);
    expect(detail).toMatch(/XDG_CONFIG_HOME/);
  });

  it("carries the ngrok reserved domain from the project .env into the host .env", async () => {
    seedChoices({ [UID_CHOICE_KEY]: 1234, [INGRESS_CHOICE_KEY]: "ngrok" });
    writeFileSync(
      join(root, ".env"),
      "COMPOSE_PROFILES=ngrok-tunnel\nQCR_NGROK_DOMAIN=bot.ngrok.app\n",
    );
    const h = harness({ noDocker: true });
    const result = await h.engine.runStep(BRINGUP_STEP_ID);
    const detail = result.checks.find((c) => c.name === "host-commands")!.detail;
    expect(detail).toContain("QCR_NGROK_DOMAIN=bot.ngrok.app");
  });

  it("hostCommands creates the directories and says what to place there when given them", () => {
    const cmds = hostCommands({
      version: "1.2.3",
      projectDir: "~/qcr-bot",
      env: ["QCR_VERSION=1.2.3"],
      dirs: ['"$HOME/c"', '"$HOME/c/secrets"'],
      notes: ["# put config.toml there"],
      profile: "",
    });
    expect(cmds.slice(0, 4)).toEqual([
      "mkdir -p ~/qcr-bot && cd ~/qcr-bot",
      'mkdir -p "$HOME/c" "$HOME/c/secrets"',
      "# put config.toml there",
      extractCommand("1.2.3"),
    ]);
  });

  it("hostCommands is pure: image, directory, env and profile in, five commands out", () => {
    const cmds = hostCommands({
      version: "1.2.3",
      projectDir: "~/qcr-bot",
      env: ["QCR_VERSION=1.2.3", "QCR_UID=1000"],
      profile: "",
    });
    expect(cmds).toEqual([
      "mkdir -p ~/qcr-bot && cd ~/qcr-bot",
      extractCommand("1.2.3"),
      "cat > .env <<'QCR_ENV'\nQCR_VERSION=1.2.3\nQCR_UID=1000\nQCR_ENV",
      "docker compose pull --ignore-buildable",
      "docker compose up -d",
    ]);
    expect(extractCommand("1.2.3")).toBe(
      "docker run --rm --entrypoint tar ghcr.io/quickchatai/quickreview:1.2.3 -C /opt/qcr -cf - docker-compose.yml docker/tunnel | tar -xf -",
    );
  });
});

describe("bring-up failures — every one of them plain and re-runnable", () => {
  it("a failed pull reports Docker's own tail and the usual causes, login first", async () => {
    const h = harness({ streamCode: 1, lines: ["#12 ERROR: pull access denied"] });
    const result = await h.engine.runStep(BRINGUP_STEP_ID);
    expect(result.ok).toBe(false);
    const detail = result.failures.join("\n");
    expect(detail).toMatch(/no space left on device/);
    expect(detail).toMatch(/gh auth refresh -s read:packages/);
    expect(detail).toMatch(/docker login ghcr\.io/);
    expect(detail).toMatch(/docker system prune/);
    expect(detail).toMatch(/safe to retry/);
    // the pull failed, so nothing was started
    expect(h.streamed).toHaveLength(1);
    expect(h.engine.choices()[BROUGHT_UP_CHOICE_KEY]).toBeUndefined();
  });

  it("a start that succeeds but leaves the daemon dead is red, with the log command", async () => {
    const h = harness({ services: [{ Service: "daemon", State: "exited (1)" }] });
    const result = await h.engine.runStep(BRINGUP_STEP_ID);
    expect(result.ok).toBe(false);
    expect(result.failures.join(" ")).toMatch(/docker compose logs --tail 200 daemon/);
  });

  it("a missing tunnel sidecar names the profile that starts it", async () => {
    seedChoices({ [INGRESS_CHOICE_KEY]: "ngrok" });
    const h = harness({
      services: [
        { Service: "daemon", State: "running" },
        { Service: "memory", State: "running" },
      ],
    });
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

  it("a project directory without the compose file is refused before anything else", async () => {
    rmSync(join(root, "docker-compose.yml"));
    const h = harness();
    const result = await h.engine.runStep(BRINGUP_STEP_ID);
    expect(result.ok).toBe(false);
    expect(result.failures.join(" ")).toMatch(/docker-compose\.yml is missing/);
    // and says how to get it from the image, not from a clone
    expect(result.failures.join(" ")).toMatch(
      /docker run --rm --entrypoint tar ghcr\.io\/quickchatai\/quickreview:/,
    );
  });
});

describe("verify-only and resumability", () => {
  it("verify NEVER pulls or starts — it asks Docker what is running", async () => {
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
      // Outside the checkout and the config's directory — both are mounted
      // into the container, so the companion key file may live in neither.
      keysFile: `${root}-operator/keys.env`,
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
    const said = result.failures.join(" ");
    expect(said).toMatch(/bring the stack up/);
    // The engine is never published: the guidance names the memory forward.
    expect(said).toMatch(/memory forward/);
    expect(said).toMatch(/run this step again/);
    expect(existsSync(join(root, "secrets", "openviking_root_key"))).toBe(true);
  });
});
