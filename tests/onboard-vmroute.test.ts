// the VM-over-ssh route end to end: the inventory filled from the
// interview, the deploy composed from the real script, and
// verification / proof / flip machinery running over ssh instead of being
// written twice.
//
// The properties this file exists to pin:
//   * the inventory is the file scripts/deploy.sh already reads, in the shape
//     inventory.example.ini documents, and the ingress answer rides it as a
//     host var (never an edit to the tracked group_vars, which would dirty the
//     tree the deploy refuses on);
//   * the deploy invocation is `scripts/deploy.sh <mode>` and NOTHING else —
//     no flag, no environment override — so every refusal it has lands
//     unchanged, and a refusal is surfaced in the script's own words;
//   * the plan (`--dry-run`) always runs first, and a refusal there means the
//     real deploy never starts;
//   * verification, the proof round and the go-live restart run over the ssh
//     transport, chosen at the ONE decision point, with BatchMode on every hop.
//
// Everything faked: a routed fake ProcessRunner for ssh, a fake StreamRunner
// for the deploy, a fake fetch for GitHub, temp dirs for the checkout. No test
// touches a VM, ansible, docker or the network.
import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { OnboardingEngine, type OnboardAdapters, type ProcessResult, type StepContext } from "../src/onboard/engine.js";
import type { StreamRunner } from "../src/onboard/steps/compose.js";
import { deployArgv, deployCommandLine, deployScriptPath } from "../src/onboard/steps/deploysh.js";
import { GO_LIVE_CONFIRMATION, GO_LIVE_STEP_ID, goLiveStep } from "../src/onboard/steps/golive.js";
import { SECRET_FILES } from "../src/onboard/steps/githubapp.js";
import { INGRESS_CHOICE_KEY, setTomlKey } from "../src/onboard/steps/ingress.js";
import {
  DEFAULT_PYTHON_INTERPRETER,
  VM_INVENTORY_STEP_ID,
  cloudflaredEnabledFor,
  ingressNoteFor,
  inventoryPath,
  parseInventoryHost,
  parseInventoryHostVars,
  renderInventory,
  vmInventoryStep,
} from "../src/onboard/steps/inventory.js";
import { PROOF_CHOICE_KEY, type ProofRecord } from "../src/onboard/steps/proof.js";
import { SSH_USER_CHOICE_KEY } from "../src/onboard/steps/ssh.js";
import { SSH_ALIAS_CHOICE_KEY, TOPOLOGY_CHOICE_KEY } from "../src/onboard/steps/topology.js";
import { remoteFactsFor, stackTransportFor } from "../src/onboard/steps/transport.js";
import { VERIFY_STACK_STEP_ID, verifyStackStep } from "../src/onboard/steps/verifyup.js";
import { DEPLOY_BUILD_WARNING, VM_DEPLOY_CHOICE_KEY, VM_DEPLOY_STEP_ID, vmDeployStep } from "../src/onboard/steps/vmdeploy.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const exampleConfig = readFileSync(join(repoRoot, "config.example.toml"), "utf8");
const exampleInventory = readFileSync(join(repoRoot, "deploy", "ansible", "inventory.example.ini"), "utf8");
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const API = "https://api.test";
const ALIAS = "review-box";

let root: string;
let secretsDir: string;

/** A checkout-shaped temp dir: config, the ansible template, the deploy script. */
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "qcr-vmroute-"));
  secretsDir = join(root, "secrets");
  mkdirSync(join(root, "state", "onboarding"), { recursive: true });
  mkdirSync(join(root, "deploy", "ansible"), { recursive: true });
  mkdirSync(join(root, "scripts"), { recursive: true });
  mkdirSync(secretsDir, { recursive: true });
  writeFileSync(join(root, "config.toml"), setTomlKey(exampleConfig, "github", "secrets_dir", secretsDir)!);
  writeFileSync(join(root, "deploy", "ansible", "inventory.example.ini"), exampleInventory);
  writeFileSync(join(root, "scripts", "deploy.sh"), "#!/usr/bin/env bash\n# a stand-in; the real one is never executed in tests\n");
  writeFileSync(join(secretsDir, SECRET_FILES.appId), "4242\n");
  writeFileSync(join(secretsDir, SECRET_FILES.pem), PEM);
  writeFileSync(join(secretsDir, SECRET_FILES.webhookSecret), "s".repeat(40));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const VM_CHOICES = { [TOPOLOGY_CHOICE_KEY]: "vm", [SSH_ALIAS_CHOICE_KEY]: ALIAS };

function seedChoices(choices: Record<string, unknown>): void {
  writeFileSync(
    join(root, "state", "onboarding", "checklist.json"),
    JSON.stringify({ version: 1, created_at: "2026-08-30T10:00:00Z", updated_at: "2026-08-30T10:00:00Z", completed_at: null, choices, steps: {} }),
  );
}

function baseAdapters(runner: OnboardAdapters["runner"], fetchFake?: typeof fetch): OnboardAdapters {
  return {
    fetch:
      fetchFake ??
      ((() => {
        throw new Error("no network in this test");
      }) as unknown as typeof fetch),
    runner,
    clock: () => new Date("2026-08-30T12:00:00Z"),
    host: { nodeVersion: "v22.5.1", uid: 1000 },
    paths: { stateDir: join(root, "state") },
  };
}

// ---- the inventory -----------------------------------------------------------

describe("the inventory is filled from the interview", () => {
  function inventoryEngine(choices: Record<string, unknown>): OnboardingEngine {
    seedChoices(choices);
    return new OnboardingEngine(
      [vmInventoryStep()],
      baseAdapters({ run: async () => ({ code: 127, stdout: "", stderr: "no process expected" }) }),
    );
  }

  it("renders the example's shape: the group, the host, the group vars", () => {
    const text = renderInventory({ host: ALIAS, ansibleUser: "deploy", pythonInterpreter: DEFAULT_PYTHON_INTERPRETER, cloudflaredEnabled: true });
    // The same group and the same two group vars the tracked example documents.
    expect(text).toMatch(/^\[quickreview\]$/m);
    expect(text).toMatch(/^\[quickreview:vars\]$/m);
    expect(exampleInventory).toMatch(/^\[quickreview\]$/m);
    expect(text).toMatch(/^ansible_user=deploy$/m);
    expect(text).toMatch(/^ansible_python_interpreter=\/usr\/bin\/python3$/m);
    // deploy.sh's own awk reads the first non-comment, non-header line's first field.
    expect(parseInventoryHost(text)).toBe(ALIAS);
    expect(parseInventoryHostVars(text)).toEqual({ cloudflared_enabled: "true" });
  });

  it("leaves ansible_user out when the ssh config already answers it", () => {
    const text = renderInventory({ host: ALIAS, ansibleUser: "", pythonInterpreter: DEFAULT_PYTHON_INTERPRETER, cloudflaredEnabled: false });
    expect(text).not.toMatch(/^ansible_user=/m);
    expect(text).toMatch(/your ~\/\.ssh\/config already decides the login user/);
  });

  it("writes the file scripts/deploy.sh reads by default, using the alias and the resolved login user", async () => {
    const e = inventoryEngine({ ...VM_CHOICES, [SSH_USER_CHOICE_KEY]: "deploy", [INGRESS_CHOICE_KEY]: "named" });
    const result = await e.runStep(VM_INVENTORY_STEP_ID);
    expect(result.ok).toBe(true);
    const written = readFileSync(inventoryPath(root), "utf8");
    expect(parseInventoryHost(written)).toBe(ALIAS);
    expect(written).toMatch(/^ansible_user=deploy$/m);
    // Exactly where the manual path looks — no env override, no second copy.
    expect(inventoryPath(root)).toBe(join(root, "deploy", "ansible", "inventory.ini"));
  });

  it("the ingress answer rides the host line — the tracked group_vars is never edited", async () => {
    const e = inventoryEngine({ ...VM_CHOICES, [INGRESS_CHOICE_KEY]: "named" });
    await e.runStep(VM_INVENTORY_STEP_ID);
    expect(parseInventoryHostVars(readFileSync(inventoryPath(root), "utf8"))).toEqual({ cloudflared_enabled: "true" });

    const polling = inventoryEngine({ ...VM_CHOICES, [INGRESS_CHOICE_KEY]: "polling" });
    const result = await polling.runStep(VM_INVENTORY_STEP_ID);
    expect(parseInventoryHostVars(readFileSync(inventoryPath(root), "utf8"))).toEqual({ cloudflared_enabled: "false" });
    expect(result.checks.find((c) => c.name === "ingress")!.detail).toMatch(/nothing is exposed and nothing needs to be/);
  });

  it("only the named tunnel means cloudflared on the server; the others stay selectable and say what they mean", () => {
    expect(cloudflaredEnabledFor("named")).toBe(true);
    for (const other of ["quick", "ngrok", "polling", null]) expect(cloudflaredEnabledFor(other)).toBe(false);
    expect(ingressNoteFor("quick", 8787)).toMatch(/YOU run that tunnel on the server yourself, pointing it at 127\.0\.0\.1:8787/);
    expect(ingressNoteFor(null, 8787)).toMatch(/named Cloudflare tunnel is the recommended answer/);
  });

  it("points the TUI at the server in its native ssh mode", async () => {
    const e = inventoryEngine({ ...VM_CHOICES, [INGRESS_CHOICE_KEY]: "named" });
    await e.runStep(VM_INVENTORY_STEP_ID);
    const cfg = loadConfig(join(root, "config.toml"));
    expect(cfg.tui.target).toBe("ssh");
    expect(cfg.tui.ssh_host).toBe(ALIAS);
  });

  it("verify is red before the file exists and green after — and never writes", async () => {
    const e = inventoryEngine({ ...VM_CHOICES, [INGRESS_CHOICE_KEY]: "named" });
    const before = await e.verifyAll();
    expect(before.ok).toBe(false);
    expect(before.results[0]!.failures.join(" ")).toMatch(/does not exist yet/);
    expect(existsSync(inventoryPath(root))).toBe(false);
    await e.runStep(VM_INVENTORY_STEP_ID);
    expect((await e.verifyAll()).ok).toBe(true);
  });

  it("an inventory pointing somewhere else is reported, not silently overwritten by verify", async () => {
    const e = inventoryEngine({ ...VM_CHOICES, [INGRESS_CHOICE_KEY]: "named" });
    writeFileSync(inventoryPath(root), "[quickreview]\nsome-other-box\n");
    const report = await e.verifyAll();
    expect(report.ok).toBe(false);
    expect(report.results[0]!.failures.join(" ")).toMatch(/targets "some-other-box", not the recorded alias "review-box"/);
    expect(readFileSync(inventoryPath(root), "utf8")).toMatch(/some-other-box/);
  });
});

// ---- the deploy --------------------------------------------------------------

interface DeployHarness {
  engine: OnboardingEngine;
  runs: string[][];
  logs: string[];
}

function deployHarness(
  o: { choices?: Record<string, unknown>; results?: ProcessResult[]; containerState?: string } = {},
): DeployHarness {
  seedChoices(o.choices ?? VM_CHOICES);
  const runs: string[][] = [];
  const logs: string[] = [];
  const queue = [...(o.results ?? [])];
  const stream: StreamRunner = {
    run: async (cmd, args, onLine) => {
      runs.push([cmd, ...args]);
      // Distinguishable per invocation, so a test can pin what came before what.
      onLine(args.includes("--dry-run") ? "plan — deploy.sh rebuild" : "PLAY [quickreview] ****");
      return queue.shift() ?? { code: 0, stdout: "ok\n", stderr: "" };
    },
  };
  const runner = {
    run: async (cmd: string, args: string[]): Promise<ProcessResult> => {
      if (cmd === "ssh" && args.join(" ").includes("docker ps")) {
        return { code: 0, stdout: `quickreview-sandbox ${o.containerState ?? "running"}\n`, stderr: "" };
      }
      return { code: 1, stdout: "", stderr: `unexpected ${cmd} ${args.join(" ")}` };
    },
  };
  const adapters = { ...baseAdapters(runner), log: (line: string) => logs.push(line) };
  return { engine: new OnboardingEngine([vmDeployStep({ stream })], adapters), runs, logs };
}

describe("the deploy composes the real script, at full strictness", () => {
  it("the argv is the script and the mode — no flag that skips a check, and no env to override", () => {
    expect(deployArgv(root, "rebuild")).toEqual([deployScriptPath(root), "rebuild"]);
    expect(deployArgv(root, "sync", { dryRun: true })).toEqual([deployScriptPath(root), "--dry-run", "sync"]);
    // The StreamRunner interface takes (cmd, args, onLine) and nothing else:
    // there is nowhere for this step to put a QC_* override even if it wanted
    // one, so the defaults the manual path gets are the ones it gets.
    expect(deployCommandLine("sync")).toBe("scripts/deploy.sh sync");
  });

  it("runs the plan first, then the deploy, and records what it did", async () => {
    const h = deployHarness();
    writeFileSync(inventoryPath(root), `[quickreview]\n${ALIAS}\n`);
    const result = await h.engine.runStep(VM_DEPLOY_STEP_ID);
    expect(result.ok).toBe(true);
    expect(h.runs).toEqual([
      ["bash", deployScriptPath(root), "--dry-run", "rebuild"],
      ["bash", deployScriptPath(root), "rebuild"],
    ]);
    expect(h.engine.choices()[VM_DEPLOY_CHOICE_KEY]).toMatchObject({ mode: "rebuild" });
  });

  it("the first deploy is a rebuild; a later one is a sync; the operator can still ask by name", async () => {
    writeFileSync(inventoryPath(root), `[quickreview]\n${ALIAS}\n`);
    const second = deployHarness({ choices: { ...VM_CHOICES, [VM_DEPLOY_CHOICE_KEY]: { mode: "rebuild", at: "2026-08-30T10:00:00Z" } } });
    await second.engine.runStep(VM_DEPLOY_STEP_ID);
    expect(second.runs.map((r) => r.at(-1))).toEqual(["sync", "sync"]);

    const asked = deployHarness({ choices: { ...VM_CHOICES, [VM_DEPLOY_CHOICE_KEY]: { mode: "sync", at: "2026-08-30T10:00:00Z" } } });
    await asked.engine.runStep(VM_DEPLOY_STEP_ID, { mode: "rebuild" });
    expect(asked.runs.map((r) => r.at(-1))).toEqual(["rebuild", "rebuild"]);
  });

  it("a refusal at plan time is quoted verbatim and STOPS — the real deploy never runs", async () => {
    writeFileSync(inventoryPath(root), `[quickreview]\n${ALIAS}\n`);
    const h = deployHarness({
      results: [
        {
          code: 1,
          stdout: "",
          stderr: "deploy.sh: refusing to deploy — the working tree is dirty:\n    M src/daemon.ts\ndeploy.sh: commit (locally) and re-run.",
        },
      ],
    });
    const result = await h.engine.runStep(VM_DEPLOY_STEP_ID);
    expect(result.ok).toBe(false);
    expect(h.runs).toHaveLength(1);
    expect(h.runs[0]!).toContain("--dry-run");
    const said = result.failures.join(" ");
    expect(said).toMatch(/the working tree is dirty/);
    expect(said).toMatch(/the wizard does not have a way to override it/);
    expect(h.engine.choices()[VM_DEPLOY_CHOICE_KEY]).toBeUndefined();
  });

  it("a pin mismatch is the same story — the script's refusal, unsoftened", async () => {
    writeFileSync(inventoryPath(root), `[quickreview]\n${ALIAS}\n`);
    const h = deployHarness({
      results: [{ code: 1, stdout: "", stderr: 'deploy.sh: openviking pin mismatch — refusing to deploy.\n    config.toml = "0.4.15"' }],
    });
    const said = (await h.engine.runStep(VM_DEPLOY_STEP_ID)).failures.join(" ");
    expect(said).toMatch(/openviking pin mismatch/);
    expect(h.runs).toHaveLength(1);
  });

  it("warns about the long first build BEFORE it starts, never after", async () => {
    writeFileSync(inventoryPath(root), `[quickreview]\n${ALIAS}\n`);
    const h = deployHarness();
    await h.engine.runStep(VM_DEPLOY_STEP_ID);
    const warningAt = h.logs.findIndex((l) => l.includes("compiles the memory engine's local embedder"));
    const planAt = h.logs.findIndex((l) => l.includes("plan — deploy.sh rebuild"));
    const deployAt = h.logs.findIndex((l) => l.includes("PLAY [quickreview]"));
    expect(warningAt).toBeGreaterThanOrEqual(0);
    // Plan, then the warning, then the long wait. Never the warning afterwards.
    expect(planAt).toBeLessThan(warningAt);
    expect(warningAt).toBeLessThan(deployAt);
    expect(DEPLOY_BUILD_WARNING).toMatch(/preflights execute at full strength/);
  });

  it("refuses without an inventory, naming the step that writes one", async () => {
    const h = deployHarness();
    const result = await h.engine.runStep(VM_DEPLOY_STEP_ID);
    expect(result.ok).toBe(false);
    expect(result.failures.join(" ")).toMatch(new RegExp(VM_INVENTORY_STEP_ID));
    expect(h.runs).toEqual([]);
  });

  it("verify never deploys — it asks the server what is running", async () => {
    writeFileSync(inventoryPath(root), `[quickreview]\n${ALIAS}\n`);
    const h = deployHarness({ choices: { ...VM_CHOICES, [VM_DEPLOY_CHOICE_KEY]: { mode: "sync", at: "2026-08-30T10:00:00Z" } } });
    const report = await h.engine.verifyAll();
    expect(report.ok).toBe(true);
    expect(h.runs).toEqual([]);

    const down = deployHarness({
      choices: { ...VM_CHOICES, [VM_DEPLOY_CHOICE_KEY]: { mode: "sync", at: "2026-08-30T10:00:00Z" } },
      containerState: "exited",
    });
    const bad = await down.engine.verifyAll();
    expect(bad.ok).toBe(false);
    expect(bad.results[0]!.failures.join(" ")).toMatch(/container on review-box is exited/);
  });

  it("the step does not exist on the laptop route", () => {
    const h = deployHarness({ choices: { [TOPOLOGY_CHOICE_KEY]: "local" } });
    expect(h.engine.list()[0]!.status).toBe("disabled");
  });
});

// ----'s machinery, over ssh -------------------------------------------

describe("the transport is the one decision point", () => {
  function ctxWith(choices: Record<string, unknown>, runner: OnboardAdapters["runner"]): StepContext {
    return {
      adapters: baseAdapters(runner),
      input: {},
      choices,
      data: {},
      recordChoice: () => undefined,
    } satisfies StepContext;
  }

  it("picks compose on the laptop route and ssh on the server route, from the recorded topology alone", () => {
    const runner = { run: async () => ({ code: 0, stdout: "", stderr: "" }) };
    expect(stackTransportFor(ctxWith({}, runner)).kind).toBe("compose");
    expect(stackTransportFor(ctxWith({ [TOPOLOGY_CHOICE_KEY]: "local" }, runner)).kind).toBe("compose");
    expect(stackTransportFor(ctxWith(VM_CHOICES, runner)).kind).toBe("ssh");
  });

  it("reads the remote's own coordinates from the [tui] block the operator TUI uses", () => {
    seedChoices(VM_CHOICES);
    expect(remoteFactsFor(root, VM_CHOICES)).toEqual({ alias: ALIAS, container: "quickreview-sandbox", sudo: true, port: 8787 });
    writeFileSync(join(root, "config.toml"), setTomlKey(setTomlKey(exampleConfig, "tui", "container", "my-reviewer")!, "tui", "sudo_docker", "false")!);
    expect(remoteFactsFor(root, VM_CHOICES)).toMatchObject({ container: "my-reviewer", sudo: false });
  });

  it("the operator-facing commands it hands out are the ones for THEIR topology", () => {
    const runner = { run: async () => ({ code: 0, stdout: "", stderr: "" }) };
    const compose = stackTransportFor(ctxWith({}, runner));
    expect(compose.logsCommand(200)).toBe("docker compose logs --tail 200 daemon");
    expect(compose.cliCommand("events --tail 40")).toBe("docker compose exec daemon node dist/src/cli.js events --tail 40");

    const ssh = stackTransportFor(ctxWith(VM_CHOICES, runner));
    expect(ssh.logsCommand(200)).toBe(`ssh ${ALIAS} sudo docker logs --tail 200 quickreview-sandbox`);
    expect(ssh.cliCommand("events --tail 40")).toBe(`ssh ${ALIAS} sudo docker exec quickreview-sandbox node dist/src/cli.js events --tail 40`);
    expect(ssh.attachCommand("pr-17")).toBe(`ssh -t ${ALIAS} sudo docker exec -it quickreview-sandbox tmux attach -t pr-17`);
  });
});

describe("the layered verification runs over ssh, unchanged", () => {
  interface Layered {
    engine: OnboardingEngine;
    calls: string[][];
  }

  function layered(o: { containerState?: string; cloudflared?: string; health?: ProcessResult } = {}): Layered {
    seedChoices({ ...VM_CHOICES, [INGRESS_CHOICE_KEY]: "named" });
    const calls: string[][] = [];
    const runner = {
      run: async (cmd: string, args: string[]): Promise<ProcessResult> => {
        calls.push([cmd, ...args]);
        const line = args.join(" ");
        if (line.includes("docker ps")) return { code: 0, stdout: `quickreview-sandbox ${o.containerState ?? "running"}\n`, stderr: "" };
        if (line.includes("systemctl is-active")) return { code: 0, stdout: `${o.cloudflared ?? "active"}\n`, stderr: "" };
        if (line.includes("curl")) return o.health ?? { code: 0, stdout: '{"ok":true}\n200', stderr: "" };
        return { code: 1, stdout: "", stderr: "unexpected" };
      },
    };
    const fetchFake = (async (input: unknown) => {
      const url = String(input);
      if (url === `${API}/app/hook/config`) return new Response(JSON.stringify({ url: "https://review.example.com/webhook" }), { status: 200 });
      if (url.startsWith(`${API}/app/hook/deliveries?`)) {
        return new Response(
          JSON.stringify([{ id: 1, event: "ping", status: "OK", status_code: 200, delivered_at: "2026-08-30T11:59:00Z", redelivery: false }]),
          { status: 200 },
        );
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as unknown as typeof fetch;
    const step = verifyStackStep({ apiBase: API, secretsDir, sleep: async () => undefined });
    return { engine: new OnboardingEngine([step], baseAdapters(runner, fetchFake)), calls };
  }

  it("all three layers green: docker over ssh, health by curl ON the box, and GitHub's own delivery log", async () => {
    const h = layered();
    const result = await h.engine.runStep(VERIFY_STACK_STEP_ID);
    expect(result.ok).toBe(true);
    // The SAME check names as the laptop route: one implementation, not a copy.
    expect(result.checks.map((c) => c.name)).toEqual(["containers", "ingress-sidecar", "health", "webhook-url", "ping-delivery"]);
    expect(result.checks.find((c) => c.name === "ping-delivery")!.detail).toMatch(/proven end to end/);
    // Every hop carries BatchMode, and the health probe runs on the VM's
    // loopback (the daemon's port is deliberately not exposed off the box).
    for (const call of h.calls) expect(call.join(" ")).toMatch(/-o BatchMode=yes/);
    expect(h.calls.some((c) => c.join(" ").includes("curl -sS -m 10 -o - -w"))).toBe(true);
    expect(h.calls.find((c) => c.join(" ").includes("curl"))!.join(" ")).toMatch(/http:\/\/127\.0\.0\.1:8787\/health/);
  });

  it("a dead container over ssh stops the step, with the ssh fix — and no later layer is attempted", async () => {
    const h = layered({ containerState: "exited" });
    const result = await h.engine.runStep(VERIFY_STACK_STEP_ID);
    expect(result.ok).toBe(false);
    expect(result.failures.join(" ")).toMatch(new RegExp(`ssh ${ALIAS} sudo docker logs --tail 200 quickreview-sandbox`));
    expect(result.failures.join(" ")).toMatch(/health and ping-delivery layers were not run/);
    expect(h.calls.some((c) => c.join(" ").includes("curl"))).toBe(false);
  });

  it("the named tunnel's health on this route is the cloudflared SERVICE, not a compose sidecar", async () => {
    const h = layered({ cloudflared: "inactive" });
    const result = await h.engine.runStep(VERIFY_STACK_STEP_ID);
    expect(result.ok).toBe(false);
    const said = result.checks.find((c) => c.name === "ingress-sidecar")!.detail;
    expect(said).toMatch(/cloudflared on review-box is inactive/);
    expect(said).toMatch(/systemctl restart cloudflared/);
  });

  it("a health endpoint that answers nothing says where to look, over ssh", async () => {
    const h = layered({ health: { code: 7, stdout: "", stderr: "curl: (7) Failed to connect" } });
    const result = await h.engine.runStep(VERIFY_STACK_STEP_ID);
    expect(result.ok).toBe(false);
    expect(result.checks.find((c) => c.name === "health")!.detail).toMatch(/nothing answered http:\/\/127\.0\.0\.1:8787\/health on review-box/);
  });
});

describe("the go-live flip on the server route", () => {
  const PROOF: ProofRecord = { pr: 17, round_no: 1, verdict: "REQUEST_CHANGES", completed_at: "2026-08-30T11:59:00Z", review_shown: true };

  function golive(): { engine: OnboardingEngine; deploys: string[][] } {
    seedChoices({ ...VM_CHOICES, [PROOF_CHOICE_KEY]: PROOF });
    const deploys: string[][] = [];
    const runner = {
      run: async (cmd: string, args: string[]): Promise<ProcessResult> => {
        const line = args.join(" ");
        if (line.includes("docker ps")) return { code: 0, stdout: "quickreview-sandbox running\n", stderr: "" };
        if (line.includes("why")) {
          return {
            code: 0,
            stdout: JSON.stringify({ pr: 17, known: true, state: "awaiting_author", rounds: [{ round_no: 1, status: "done", verdict: "REQUEST_CHANGES" }] }),
            stderr: "",
          };
        }
        return { code: 1, stdout: "", stderr: `unexpected ${cmd} ${line}` };
      },
    };
    const stream: StreamRunner = {
      run: async (cmd, args) => {
        deploys.push([cmd, ...args]);
        return { code: 0, stdout: "", stderr: "" };
      },
    };
    return { engine: new OnboardingEngine([goLiveStep({ stream })], baseAdapters(runner)), deploys };
  }

  it("re-verifies the proof through the SAME ssh exec, then ships the flipped config with the real deploy", async () => {
    const h = golive();
    const result = await h.engine.runStep(GO_LIVE_STEP_ID, { decision: "go_live", confirm: GO_LIVE_CONFIRMATION });
    expect(result.ok).toBe(true);
    expect(loadConfig(join(root, "config.toml")).dry_run).toBe(false);
    // On this route the deploy IS the restart: the daemon reads the config the
    // deploy ships, so a hand-rolled `docker restart` would leave it stale.
    expect(h.deploys).toEqual([["bash", deployScriptPath(root), "sync"]]);
    expect(result.checks.find((c) => c.name === "daemon-restart")!.detail).toMatch(/scripts\/deploy\.sh sync/);
  });

  it("declining is still a first-class outcome, and ships nothing", async () => {
    const h = golive();
    const result = await h.engine.runStep(GO_LIVE_STEP_ID, { decision: "stay_dry_run" });
    expect(result.ok).toBe(true);
    expect(loadConfig(join(root, "config.toml")).dry_run).toBe(true);
    expect(h.deploys).toEqual([]);
  });
});
