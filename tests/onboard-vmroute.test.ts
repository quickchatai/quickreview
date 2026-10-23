// The VM-over-ssh route end to end: the inventory filled from the
// interview, the deploy composed from the real script, and the laptop route's
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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import {
  OnboardingEngine,
  type OnboardAdapters,
  type ProcessResult,
  type StepContext,
} from "../src/onboard/engine.js";
import type { StreamRunner } from "../src/onboard/steps/compose.js";
import { deployArgv, deployCommandLine, deployScriptPath } from "../src/onboard/steps/deploysh.js";
import { GO_LIVE_CONFIRMATION, GO_LIVE_STEP_ID, goLiveStep } from "../src/onboard/steps/golive.js";
import { SECRET_FILES } from "../src/onboard/steps/githubapp.js";
import { INGRESS_CHOICE_KEY, setTomlKey } from "../src/onboard/steps/ingress.js";
import {
  DEFAULT_PYTHON_INTERPRETER,
  GROUP_VARS_CLOUDFLARED_ENABLED,
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
import {
  DEPLOY_BUILD_WARNING,
  ONBOARD_DEPLOY_MODES,
  VM_DEPLOY_CHOICE_KEY,
  VM_DEPLOY_STEP_ID,
  vmDeployStep,
} from "../src/onboard/steps/vmdeploy.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const exampleConfig = readFileSync(join(repoRoot, "config.example.toml"), "utf8");
const exampleInventory = readFileSync(
  join(repoRoot, "deploy", "ansible", "inventory.example.ini"),
  "utf8",
);
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
  writeFileSync(
    join(root, "config.toml"),
    setTomlKey(exampleConfig, "github", "secrets_dir", secretsDir)!,
  );
  writeFileSync(join(root, "deploy", "ansible", "inventory.example.ini"), exampleInventory);
  writeFileSync(
    join(root, "scripts", "deploy.sh"),
    "#!/usr/bin/env bash\n# a stand-in; the real one is never executed in tests\n",
  );
  writeFileSync(join(secretsDir, SECRET_FILES.appId), "4242\n");
  writeFileSync(join(secretsDir, SECRET_FILES.pem), PEM);
  writeFileSync(join(secretsDir, SECRET_FILES.webhookSecret), "s".repeat(40));
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

const VM_CHOICES = { [TOPOLOGY_CHOICE_KEY]: "vm", [SSH_ALIAS_CHOICE_KEY]: ALIAS };

function seedChoices(choices: Record<string, unknown>): void {
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

const IDLE_RUNNER: OnboardAdapters["runner"] = {
  run: async () => ({ code: 0, stdout: "", stderr: "" }),
};

function baseAdapters(
  runner: OnboardAdapters["runner"],
  fetchFake?: typeof fetch,
): OnboardAdapters {
  return {
    fetch:
      fetchFake ??
      ((() => {
        throw new Error("no network in this test");
      }) as unknown as typeof fetch),
    runner,
    clock: () => new Date("2026-08-30T12:00:00Z"),
    host: { nodeVersion: "v22.5.1", uid: 1000 },
    paths: { stateDir: join(root, "state"), configPath: join(root, "config.toml") },
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

  const LOCAL_EMBEDDER = {
    provider: "local",
    model: "bge-small-en-v1.5-f16",
    dimension: 384,
    keyFile: "openai_embeddings_api_key",
  };

  it("renders the example's shape: the group, the host, the group vars", () => {
    const text = renderInventory({
      host: ALIAS,
      ansibleUser: "deploy",
      pythonInterpreter: DEFAULT_PYTHON_INTERPRETER,
      cloudflaredEnabled: true,
      embedder: LOCAL_EMBEDDER,
    });
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
    const text = renderInventory({
      host: ALIAS,
      ansibleUser: "",
      pythonInterpreter: DEFAULT_PYTHON_INTERPRETER,
      cloudflaredEnabled: false,
      embedder: LOCAL_EMBEDDER,
    });
    expect(text).not.toMatch(/^ansible_user=/m);
    expect(text).toMatch(/your ~\/\.ssh\/config already decides the login user/);
  });

  it("a hosted-embeddings opt-in rides the host line as host vars; the local default writes none", () => {
    const hosted = renderInventory({
      host: ALIAS,
      ansibleUser: "",
      pythonInterpreter: DEFAULT_PYTHON_INTERPRETER,
      cloudflaredEnabled: false,
      embedder: {
        provider: "openai",
        model: "text-embedding-3-small",
        dimension: 1536,
        keyFile: "openai_embeddings_api_key",
      },
    });
    expect(parseInventoryHostVars(hosted)).toEqual({
      cloudflared_enabled: "false",
      openviking_embedding_provider: "openai",
      openviking_embedding_model: "text-embedding-3-small",
      openviking_embedding_dimension: "1536",
      openviking_embedding_key_file: "openai_embeddings_api_key",
    });
    // deploy.sh's awk reads the same line: host first, host vars after.
    expect(parseInventoryHost(hosted)).toBe(ALIAS);
    const local = renderInventory({
      host: ALIAS,
      ansibleUser: "",
      pythonInterpreter: DEFAULT_PYTHON_INTERPRETER,
      cloudflaredEnabled: false,
      embedder: LOCAL_EMBEDDER,
    });
    expect(parseInventoryHostVars(local)).toEqual({ cloudflared_enabled: "false" });
    expect(local).not.toContain("openviking_embedding");
  });

  it("writes the file scripts/deploy.sh reads by default, using the alias and the resolved login user", async () => {
    const e = inventoryEngine({
      ...VM_CHOICES,
      [SSH_USER_CHOICE_KEY]: "deploy",
      [INGRESS_CHOICE_KEY]: "named",
    });
    const result = await e.runStep(VM_INVENTORY_STEP_ID);
    expect(result.ok).toBe(true);
    const written = readFileSync(inventoryPath(root), "utf8");
    expect(parseInventoryHost(written)).toBe(ALIAS);
    expect(written).toMatch(/^ansible_user=deploy$/m);
    // Exactly where the manual path looks — no env override, no second copy.
    expect(inventoryPath(root)).toBe(join(root, "deploy", "ansible", "inventory.ini"));
  });

  it("keeps prior explicit inventory overrides while repairing unrelated settings", async () => {
    const engine = inventoryEngine(VM_CHOICES);
    expect(
      (
        await engine.runStep(VM_INVENTORY_STEP_ID, {
          ansible_user: "deploy",
          python: "/opt/python/bin/python3",
        })
      ).ok,
    ).toBe(true);
    expect((await engine.runStep(VM_INVENTORY_STEP_ID)).ok).toBe(true);
    const text = readFileSync(inventoryPath(root), "utf8");
    expect(text).toContain("ansible_user=deploy");
    expect(text).toContain("ansible_python_interpreter=/opt/python/bin/python3");
  });

  it("the ingress answer rides the host line — the tracked group_vars is never edited", async () => {
    const e = inventoryEngine({ ...VM_CHOICES, [INGRESS_CHOICE_KEY]: "named" });
    await e.runStep(VM_INVENTORY_STEP_ID);
    expect(parseInventoryHostVars(readFileSync(inventoryPath(root), "utf8"))).toEqual({
      cloudflared_enabled: "true",
    });

    const polling = inventoryEngine({ ...VM_CHOICES, [INGRESS_CHOICE_KEY]: "polling" });
    const result = await polling.runStep(VM_INVENTORY_STEP_ID);
    expect(parseInventoryHostVars(readFileSync(inventoryPath(root), "utf8"))).toEqual({
      cloudflared_enabled: "false",
    });
    const note = result.checks.find((c) => c.name === "ingress")!.detail;
    expect(note).toMatch(/installs no tunnel and nothing needs one/);
    // It describes the configuration, never the server: a cloudflared an
    // earlier deploy installed is still running there.
    expect(note).not.toMatch(/nothing is exposed/);
    expect(note).toMatch(/NOT stopped by this/);
  });

  it("a local embedder port or thread count off the default rides the host line, so deploy.sh renders it", async () => {
    const e = inventoryEngine({ ...VM_CHOICES, [INGRESS_CHOICE_KEY]: "named" });
    writeFileSync(
      join(root, "config.toml"),
      readFileSync(join(root, "config.toml"), "utf8")
        .replace(/^local_embedder_port\s*=.*$/m, "local_embedder_port = 1940")
        .replace(/^local_embedder_threads\s*=.*$/m, "local_embedder_threads = 2"),
    );
    await e.runStep(VM_INVENTORY_STEP_ID);
    expect(parseInventoryHostVars(readFileSync(inventoryPath(root), "utf8"))).toEqual({
      cloudflared_enabled: "true",
      openviking_local_embedder_port: "1940",
      openviking_local_embedder_threads: "2",
    });
  });

  it("verify goes red when config.toml's embedder moved after the inventory was written", async () => {
    const e = inventoryEngine({ ...VM_CHOICES, [INGRESS_CHOICE_KEY]: "named" });
    expect((await e.runStep(VM_INVENTORY_STEP_ID)).ok).toBe(true);
    expect((await e.verifyAll()).ok).toBe(true);
    writeFileSync(
      join(root, "config.toml"),
      readFileSync(join(root, "config.toml"), "utf8").replace(
        /^embedding_provider\s*=.*$/m,
        'embedding_provider = "openai"',
      ),
    );
    const all = await e.verifyAll();
    expect(all.ok).toBe(false);
    expect(all.results[0]!.failures.join(" ")).toMatch(
      /embedder: the inventory renders openviking_embedding_provider=local.*config\.toml declares openviking_embedding_provider=openai/,
    );
  });

  it("verify's fallback for an absent cloudflared host var is the tracked group_vars value", () => {
    const groupVars = readFileSync(
      join(repoRoot, "deploy", "ansible", "group_vars", "all.yml"),
      "utf8",
    );
    const line = /^cloudflared_enabled:\s*(\S+)\s*$/m.exec(groupVars);
    expect(line?.[1]).toBe(String(GROUP_VARS_CLOUDFLARED_ENABLED));
  });

  it("only the named tunnel means cloudflared on the server; the others stay selectable and say what they mean", () => {
    expect(cloudflaredEnabledFor("named")).toBe(true);
    for (const other of ["quick", "ngrok", "polling", null])
      expect(cloudflaredEnabledFor(other)).toBe(false);
    expect(ingressNoteFor("quick", 8787)).toMatch(
      /YOU run that tunnel on the server yourself, pointing it at 127\.0\.0\.1:8787/,
    );
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

  it("an inventory written under another ingress choice is red at verify, not described as the new choice", async () => {
    await inventoryEngine({ ...VM_CHOICES, [INGRESS_CHOICE_KEY]: "named" }).runStep(
      VM_INVENTORY_STEP_ID,
    );
    // The operator re-runs the ingress step and picks polling; the file still
    // says cloudflared_enabled=true, and the deploy consumes the file.
    const e = inventoryEngine({ ...VM_CHOICES, [INGRESS_CHOICE_KEY]: "polling" });
    const report = await e.verifyAll();
    expect(report.ok).toBe(false);
    const said = report.results[0]!.failures.join(" ");
    expect(said).toMatch(/cloudflared_enabled=true/);
    expect(said).toMatch(/run the vm_inventory step/);
    expect(readFileSync(inventoryPath(root), "utf8")).toMatch(/cloudflared_enabled=true/);
    // Re-running the step rewrites it and verify goes green.
    await e.runStep(VM_INVENTORY_STEP_ID);
    expect((await e.verifyAll()).ok).toBe(true);
  });

  it("an inventory with no cloudflared_enabled host var reads as the tracked default (true)", async () => {
    await inventoryEngine({ ...VM_CHOICES, [INGRESS_CHOICE_KEY]: "polling" }).runStep(
      VM_INVENTORY_STEP_ID,
    );
    writeFileSync(inventoryPath(root), `[quickreview]\n${ALIAS}\n`);
    const report = await inventoryEngine({
      ...VM_CHOICES,
      [INGRESS_CHOICE_KEY]: "polling",
    }).verifyAll();
    expect(report.ok).toBe(false);
    expect(report.results[0]!.failures.join(" ")).toMatch(/cloudflared_enabled/);
  });

  it("a hand-edited ansible truthy spelling reads as the deploy's `| bool` does", async () => {
    await inventoryEngine({ ...VM_CHOICES, [INGRESS_CHOICE_KEY]: "named" }).runStep(
      VM_INVENTORY_STEP_ID,
    );
    for (const [value, polling] of [
      ["yes", false],
      ['"True"', false],
      ["on", false],
      ["no", true],
    ] as const) {
      writeFileSync(inventoryPath(root), `[quickreview]\n${ALIAS} cloudflared_enabled=${value}\n`);
      const named = await inventoryEngine({
        ...VM_CHOICES,
        [INGRESS_CHOICE_KEY]: "named",
      }).verifyAll();
      expect(named.ok, `named vs ${value}`).toBe(!polling);
      const poll = await inventoryEngine({
        ...VM_CHOICES,
        [INGRESS_CHOICE_KEY]: "polling",
      }).verifyAll();
      expect(poll.ok, `polling vs ${value}`).toBe(polling);
    }
  });

  it("an inventory pointing somewhere else is reported, not silently overwritten by verify", async () => {
    const e = inventoryEngine({ ...VM_CHOICES, [INGRESS_CHOICE_KEY]: "named" });
    writeFileSync(inventoryPath(root), "[quickreview]\nsome-other-box\n");
    const report = await e.verifyAll();
    expect(report.ok).toBe(false);
    expect(report.results[0]!.failures.join(" ")).toMatch(
      /targets "some-other-box", not the recorded alias "review-box"/,
    );
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
      onLine(args.includes("--dry-run") ? "plan — deploy.sh" : "PLAY [quickreview] ****");
      return queue.shift() ?? { code: 0, stdout: "ok\n", stderr: "" };
    },
  };
  const runner = {
    run: async (cmd: string, args: string[]): Promise<ProcessResult> => {
      if (cmd === "ssh" && args.join(" ").includes("docker ps")) {
        return {
          code: 0,
          stdout: `quickreview-sandbox ${o.containerState ?? "running"}\n`,
          stderr: "",
        };
      }
      return { code: 1, stdout: "", stderr: `unexpected ${cmd} ${args.join(" ")}` };
    },
  };
  const adapters = { ...baseAdapters(runner), log: (line: string) => logs.push(line) };
  return { engine: new OnboardingEngine([vmDeployStep({ stream })], adapters), runs, logs };
}

const V = "1.2.3";
const RECORD = (over: Record<string, unknown> = {}) => ({
  mode: "release",
  version: "1.2.0",
  provisioned: true,
  at: "2026-08-30T10:00:00Z",
  host: ALIAS,
  ...over,
});
const verbs = (runs: string[][]): string[] => runs.map((r) => r.slice(2).join(" "));

describe("the deploy composes the real script, at full strictness", () => {
  it("the argv is the script and the mode — no flag that skips a check, and no env to override", () => {
    expect(deployArgv(root, "provision")).toEqual([deployScriptPath(root), "provision"]);
    expect(deployArgv(root, "release", { version: V })).toEqual([
      deployScriptPath(root),
      "release",
      V,
    ]);
    expect(deployArgv(root, "release", { version: V, dryRun: true })).toEqual([
      deployScriptPath(root),
      "--dry-run",
      "release",
      V,
    ]);
    expect(deployArgv(root, "release", { version: V, manifest: "m.json" }).slice(-2)).toEqual([
      "--manifest",
      "m.json",
    ]);
    // The StreamRunner interface takes (cmd, args, onLine) and nothing else:
    // there is nowhere for this step to put a QC_* override even if it wanted
    // one, so the defaults the manual path gets are the ones it gets.
    expect(deployCommandLine("release", { version: V })).toBe(`scripts/deploy.sh release ${V}`);
    expect(deployCommandLine("provision")).toBe("scripts/deploy.sh provision");
  });

  it("a release without a spelled version, and a version on another mode, cannot be built", () => {
    expect(() => deployArgv(root, "release")).toThrow(/needs a version/);
    for (const bad of ["latest", "1.2", "1.2.3; id", "$(id)", ""])
      expect(() => deployArgv(root, "release", { version: bad }), bad).toThrow(/needs a version/);
    expect(() => deployArgv(root, "provision", { version: V })).toThrow(/takes no version/);
    expect(() => deployArgv(root, "verify", { manifest: "m.json" })).toThrow(/takes no version/);
    // the gone verbs are not modes at all
    expect(ONBOARD_DEPLOY_MODES).toEqual(["provision", "release"]);
  });

  it.each(["QC_INVENTORY", "QC_ANSIBLE_DIR"] as const)(
    "checks the effective inherited %s target before any deploy",
    async (variable) => {
      writeFileSync(inventoryPath(root), `[quickreview]\n${ALIAS}\n`);
      const elsewhere = join(root, "external-ansible");
      mkdirSync(elsewhere);
      const alternate = join(elsewhere, "inventory.ini");
      writeFileSync(alternate, "[quickreview]\nother-box\n");
      vi.stubEnv(variable, variable === "QC_INVENTORY" ? alternate : elsewhere);
      const h = deployHarness();
      const result = await h.engine.runStep(VM_DEPLOY_STEP_ID, { version: V });
      expect(result.ok).toBe(false);
      expect(result.failures.join(" ")).toContain("other-box");
      expect(h.runs).toEqual([]);
    },
  );

  it("needs a version: nothing runs without one, and a bad spelling is refused", async () => {
    writeFileSync(inventoryPath(root), `[quickreview]\n${ALIAS}\n`);
    for (const input of [
      {},
      { version: "latest" },
      { version: "1.2" },
      { version: "1.2.3 && id" },
    ]) {
      const h = deployHarness();
      const result = await h.engine.runStep(VM_DEPLOY_STEP_ID, input);
      expect(result.ok, JSON.stringify(input)).toBe(false);
      expect(result.failures.join(" ")).toMatch(/release version is needed/);
      expect(h.runs).toEqual([]);
    }
  });

  it("the first deploy is provision then release <version>: each planned first, in order, and recorded", async () => {
    const h = deployHarness();
    writeFileSync(inventoryPath(root), `[quickreview]\n${ALIAS}\n`);
    const result = await h.engine.runStep(VM_DEPLOY_STEP_ID, { version: `v${V}` });
    expect(result.ok).toBe(true);
    expect(h.runs).toEqual([
      ["bash", deployScriptPath(root), "--dry-run", "provision"],
      ["bash", deployScriptPath(root), "provision"],
      ["bash", deployScriptPath(root), "--dry-run", "release", V],
      ["bash", deployScriptPath(root), "release", V],
    ]);
    expect(h.engine.choices()[VM_DEPLOY_CHOICE_KEY]).toMatchObject({
      mode: "release",
      version: V,
      provisioned: true,
      host: ALIAS,
    });
  });

  it("names the manifest when one is given", async () => {
    const h = deployHarness({
      choices: { ...VM_CHOICES, [VM_DEPLOY_CHOICE_KEY]: RECORD() },
    });
    writeFileSync(inventoryPath(root), `[quickreview]\n${ALIAS}\n`);
    await h.engine.runStep(VM_DEPLOY_STEP_ID, { version: V, manifest: "/tmp/m.json" });
    expect(h.runs.map((r) => r.slice(-2))).toEqual([
      ["--manifest", "/tmp/m.json"],
      ["--manifest", "/tmp/m.json"],
    ]);
  });

  it("a later deploy is the release alone; the operator can still ask for provision by name", async () => {
    writeFileSync(inventoryPath(root), `[quickreview]\n${ALIAS}\n`);
    const second = deployHarness({ choices: { ...VM_CHOICES, [VM_DEPLOY_CHOICE_KEY]: RECORD() } });
    await second.engine.runStep(VM_DEPLOY_STEP_ID, { version: V });
    expect(verbs(second.runs)).toEqual([`--dry-run release ${V}`, `release ${V}`]);
    expect(second.engine.choices()[VM_DEPLOY_CHOICE_KEY]).toMatchObject({
      version: V,
      provisioned: false,
    });

    const asked = deployHarness({ choices: { ...VM_CHOICES, [VM_DEPLOY_CHOICE_KEY]: RECORD() } });
    await asked.engine.runStep(VM_DEPLOY_STEP_ID, { version: V, mode: "provision" });
    expect(verbs(asked.runs)).toEqual([
      "--dry-run provision",
      "provision",
      `--dry-run release ${V}`,
      `release ${V}`,
    ]);
  });

  it("a record from before the release route (sync / rebuild) is no deploy on record", async () => {
    writeFileSync(inventoryPath(root), `[quickreview]\n${ALIAS}\n`);
    for (const mode of ["sync", "rebuild"]) {
      const h = deployHarness({
        choices: {
          ...VM_CHOICES,
          [VM_DEPLOY_CHOICE_KEY]: { mode, at: "2026-08-30T10:00:00Z", host: ALIAS },
        },
      });
      await h.engine.runStep(VM_DEPLOY_STEP_ID, { version: V });
      expect(verbs(h.runs)[0], mode).toBe("--dry-run provision");
    }
  });

  it("a later deploy provisions first when the inventory's host settings changed since", async () => {
    writeFileSync(inventoryPath(root), `[quickreview]\n${ALIAS} cloudflared_enabled=true\n`);
    const changed = deployHarness({
      choices: {
        ...VM_CHOICES,
        [VM_DEPLOY_CHOICE_KEY]: RECORD({ host_vars: { cloudflared_enabled: "false" } }),
      },
    });
    const result = await changed.engine.runStep(VM_DEPLOY_STEP_ID, { version: V });
    expect(verbs(changed.runs)).toEqual([
      "--dry-run provision",
      "provision",
      `--dry-run release ${V}`,
      `release ${V}`,
    ]);
    expect(result.checks.find((c) => c.name === "mode")!.detail).toMatch(/cloudflared_enabled/);
    // What it provisioned with is recorded, so the next run compares against it.
    expect(changed.engine.choices()[VM_DEPLOY_CHOICE_KEY]).toMatchObject({
      host_vars: { cloudflared_enabled: "true" },
    });

    const same = deployHarness({
      choices: {
        ...VM_CHOICES,
        [VM_DEPLOY_CHOICE_KEY]: RECORD({ host_vars: { cloudflared_enabled: "true" } }),
      },
    });
    await same.engine.runStep(VM_DEPLOY_STEP_ID, { version: V });
    expect(verbs(same.runs)).toEqual([`--dry-run release ${V}`, `release ${V}`]);
  });

  it("a release alone preserves the last provisioned host settings for the next default run", async () => {
    writeFileSync(inventoryPath(root), `[quickreview]\n${ALIAS} cloudflared_enabled=true\n`);
    const h = deployHarness({
      choices: {
        ...VM_CHOICES,
        [VM_DEPLOY_CHOICE_KEY]: RECORD({ host_vars: { cloudflared_enabled: "false" } }),
      },
    });
    // "release" by name is the release alone, even with a changed host setting.
    expect((await h.engine.runStep(VM_DEPLOY_STEP_ID, { version: V, mode: "release" })).ok).toBe(
      true,
    );
    expect(h.engine.choices()[VM_DEPLOY_CHOICE_KEY]).toMatchObject({
      host_vars: { cloudflared_enabled: "false" },
    });
    expect((await h.engine.verifyAll()).ok).toBe(false);
    await h.engine.runStep(VM_DEPLOY_STEP_ID, { version: V });
    expect(verbs(h.runs).filter((v) => v === "provision")).toEqual(["provision"]);
  });

  it("a deploy recorded for another host does not make a fresh host's first deploy a bare release", async () => {
    writeFileSync(inventoryPath(root), `[quickreview]\n${ALIAS}\n`);
    for (const record of [
      RECORD({ host: "old-box" }),
      // A record that names no host is not trusted.
      { mode: "release", version: "1.2.0", at: "2026-08-30T10:00:00Z" },
    ]) {
      const moved = deployHarness({ choices: { ...VM_CHOICES, [VM_DEPLOY_CHOICE_KEY]: record } });
      const result = await moved.engine.runStep(VM_DEPLOY_STEP_ID, { version: V });
      expect(result.ok).toBe(true);
      expect(verbs(moved.runs)[0]).toBe("--dry-run provision");
      expect(moved.engine.choices()[VM_DEPLOY_CHOICE_KEY]).toMatchObject({
        mode: "release",
        host: ALIAS,
      });
    }
  });

  it("refuses when the inventory targets a host other than the recorded alias — nothing runs", async () => {
    writeFileSync(inventoryPath(root), "[quickreview]\nold-box\n");
    const h = deployHarness();
    const result = await h.engine.runStep(VM_DEPLOY_STEP_ID, { version: V });
    expect(result.ok).toBe(false);
    expect(result.failures.join(" ")).toMatch(
      /targets "old-box", not the recorded alias "review-box"/,
    );
    expect(h.runs).toEqual([]);
  });

  it("a refusal at plan time is quoted verbatim and STOPS — the real deploy never runs", async () => {
    writeFileSync(inventoryPath(root), `[quickreview]\n${ALIAS}\n`);
    const h = deployHarness({
      choices: { ...VM_CHOICES, [VM_DEPLOY_CHOICE_KEY]: RECORD() },
      results: [
        {
          code: 1,
          stdout: "",
          stderr:
            "deploy.sh: no deploy manifest at ./deploy-manifest-1.2.3.json — the release workflow emits it\ndeploy.sh: download it, or name it with --manifest",
        },
      ],
    });
    const result = await h.engine.runStep(VM_DEPLOY_STEP_ID, { version: V });
    expect(result.ok).toBe(false);
    expect(h.runs).toHaveLength(1);
    expect(h.runs[0]!).toContain("--dry-run");
    const said = result.failures.join(" ");
    expect(said).toMatch(/no deploy manifest/);
    expect(said).toMatch(/the wizard does not have a way to override it/);
    expect(h.engine.choices()[VM_DEPLOY_CHOICE_KEY]).toMatchObject({ version: "1.2.0" });
  });

  it("a failed provision stops before any release is planned or run", async () => {
    writeFileSync(inventoryPath(root), `[quickreview]\n${ALIAS}\n`);
    const h = deployHarness({
      results: [
        { code: 0, stdout: "plan\n", stderr: "" },
        { code: 3, stdout: "", stderr: "TASK [docker] failed" },
      ],
    });
    const result = await h.engine.runStep(VM_DEPLOY_STEP_ID, { version: V });
    expect(result.ok).toBe(false);
    expect(verbs(h.runs)).toEqual(["--dry-run provision", "provision"]);
    expect(result.failures.join(" ")).toMatch(/scripts\/deploy\.sh provision` exited 3/);
    expect(h.engine.choices()[VM_DEPLOY_CHOICE_KEY]).toBeUndefined();
  });

  it("a release that shipped is recorded even when the container probe afterwards fails", async () => {
    writeFileSync(inventoryPath(root), `[quickreview]\n${ALIAS}\n`);
    const h = deployHarness({
      choices: { ...VM_CHOICES, [VM_DEPLOY_CHOICE_KEY]: RECORD() },
      containerState: "exited",
    });
    const result = await h.engine.runStep(VM_DEPLOY_STEP_ID, { version: V });
    expect(result.ok).toBe(false);
    expect(verbs(h.runs)).toContain(`release ${V}`);
    expect(h.engine.choices()[VM_DEPLOY_CHOICE_KEY]).toMatchObject({ version: V });
  });

  it("a pin mismatch is the same story — the script's refusal, unsoftened", async () => {
    writeFileSync(inventoryPath(root), `[quickreview]\n${ALIAS}\n`);
    const h = deployHarness({
      results: [
        {
          code: 1,
          stdout: "",
          stderr:
            'deploy.sh: openviking pin mismatch — refusing to deploy.\n    config.toml = "0.4.15"',
        },
      ],
    });
    const said = (await h.engine.runStep(VM_DEPLOY_STEP_ID, { version: V })).failures.join(" ");
    expect(said).toMatch(/openviking pin mismatch/);
    expect(h.runs).toHaveLength(1);
  });

  it("warns before the long wait, never after it", async () => {
    writeFileSync(inventoryPath(root), `[quickreview]\n${ALIAS}\n`);
    const h = deployHarness();
    await h.engine.runStep(VM_DEPLOY_STEP_ID, { version: V });
    const warningAt = h.logs.findIndex((l) => l.includes("Nothing is built on the server"));
    const planAt = h.logs.findIndex((l) => l.includes("plan — deploy.sh"));
    const deployAt = h.logs.findIndex((l) => l.includes("PLAY [quickreview]"));
    expect(warningAt).toBeGreaterThanOrEqual(0);
    // Plan, then the warning, then the long wait. Never the warning afterwards.
    expect(planAt).toBeLessThan(warningAt);
    expect(warningAt).toBeLessThan(deployAt);
    expect(DEPLOY_BUILD_WARNING).toMatch(/preflights execute at full strength/);
    expect(DEPLOY_BUILD_WARNING).not.toMatch(/compil|rebuild/i);
  });

  it("refuses without an inventory, naming the step that writes one", async () => {
    const h = deployHarness();
    const result = await h.engine.runStep(VM_DEPLOY_STEP_ID, { version: V });
    expect(result.ok).toBe(false);
    expect(result.failures.join(" ")).toMatch(new RegExp(VM_INVENTORY_STEP_ID));
    expect(h.runs).toEqual([]);
  });

  it("verify never deploys — it asks the server what is running", async () => {
    writeFileSync(inventoryPath(root), `[quickreview]\n${ALIAS}\n`);
    const h = deployHarness({
      choices: { ...VM_CHOICES, [VM_DEPLOY_CHOICE_KEY]: RECORD() },
    });
    const report = await h.engine.verifyAll();
    expect(report.ok).toBe(true);
    expect(h.runs).toEqual([]);

    const down = deployHarness({
      choices: { ...VM_CHOICES, [VM_DEPLOY_CHOICE_KEY]: RECORD() },
      containerState: "exited",
    });
    const bad = await down.engine.verifyAll();
    expect(bad.ok).toBe(false);
    expect(bad.results[0]!.failures.join(" ")).toMatch(/container on review-box is exited/);

    // A deploy on record for another host (or an unscoped one) is not this
    // host's deploy, and says which it was rather than "none yet".
    for (const [record, where] of [
      [RECORD({ host: "old-box" }), /was to "old-box", not review-box/],
      [
        { mode: "release", version: "1.2.0", at: "2026-08-30T10:00:00Z" },
        /was to an unrecorded host, not review-box/,
      ],
    ] as const) {
      const moved = deployHarness({ choices: { ...VM_CHOICES, [VM_DEPLOY_CHOICE_KEY]: record } });
      const r = await moved.engine.verifyAll();
      expect(r.ok).toBe(false);
      expect(r.results[0]!.failures.join(" ")).toMatch(where);
      expect(moved.runs).toEqual([]);
    }
  });

  it("the step does not exist on the laptop route", () => {
    const h = deployHarness({ choices: { [TOPOLOGY_CHOICE_KEY]: "local" } });
    expect(h.engine.list()[0]!.status).toBe("disabled");
  });
});

// ---- verification, proof and go-live, over ssh ------------------------------

describe("the transport is the one decision point", () => {
  function ctxWith(
    choices: Record<string, unknown>,
    runner: OnboardAdapters["runner"],
  ): StepContext {
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
    expect(stackTransportFor(ctxWith({ [TOPOLOGY_CHOICE_KEY]: "local" }, runner)).kind).toBe(
      "compose",
    );
    expect(stackTransportFor(ctxWith(VM_CHOICES, runner)).kind).toBe("ssh");
  });

  it("reads the remote's own coordinates from the [tui] block the operator TUI uses", () => {
    seedChoices(VM_CHOICES);
    expect(remoteFactsFor(baseAdapters(IDLE_RUNNER), VM_CHOICES)).toEqual({
      alias: ALIAS,
      container: "quickreview-sandbox",
      sudo: true,
      port: 8787,
    });
    writeFileSync(
      join(root, "config.toml"),
      setTomlKey(
        setTomlKey(exampleConfig, "tui", "container", "my-reviewer")!,
        "tui",
        "sudo_docker",
        "false",
      )!,
    );
    expect(remoteFactsFor(baseAdapters(IDLE_RUNNER), VM_CHOICES)).toMatchObject({
      container: "my-reviewer",
      sudo: false,
    });
  });

  it("the operator-facing commands it hands out are the ones for THEIR topology", () => {
    const runner = { run: async () => ({ code: 0, stdout: "", stderr: "" }) };
    const compose = stackTransportFor(ctxWith({}, runner));
    expect(compose.logsCommand(200)).toBe("docker compose logs --tail 200 daemon");
    expect(compose.cliCommand("events --tail 40")).toBe(
      "docker compose exec daemon node dist/src/cli.js events --tail 40",
    );

    const ssh = stackTransportFor(ctxWith(VM_CHOICES, runner));
    expect(ssh.logsCommand(200)).toBe(`ssh ${ALIAS} sudo docker logs --tail 200 quickreview-sandbox`);
    expect(ssh.cliCommand("events --tail 40")).toBe(
      `ssh ${ALIAS} sudo docker exec quickreview-sandbox node dist/src/cli.js events --tail 40`,
    );
    // No attach command: the bot runs no `pr-<n>` tmux session (P9.6).
    expect("attachCommand" in ssh).toBe(false);
    expect("attachCommand" in compose).toBe(false);
  });
});

describe("the ssh transport's probes and restart", () => {
  function sshWith(answer: (line: string) => ProcessResult) {
    seedChoices(VM_CHOICES);
    const calls: string[] = [];
    const runner = {
      run: async (_cmd: string, args: string[]): Promise<ProcessResult> => {
        const line = args.join(" ");
        calls.push(line);
        return answer(line);
      },
    };
    const ctx: StepContext = {
      adapters: baseAdapters(runner),
      input: {},
      choices: VM_CHOICES,
      data: {},
      recordChoice: () => undefined,
    };
    return { calls, ctx };
  }
  const ok = (stdout: string): ProcessResult => ({ code: 0, stdout, stderr: "" });

  it("picks its container out of docker's substring filter by EXACT name", async () => {
    // Only a sibling whose name merely starts with ours is running.
    const { ctx } = sshWith(() => ok("quickreview-sandbox-backup running\n"));
    const t = stackTransportFor(ctx);
    expect((await t.daemonState()).state).toBe("stopped");
    const [check] = await t.containerChecks(null);
    expect(check).toMatchObject({ ok: false });
    expect(check!.detail).toMatch(/is not there at all/);
    // The real one among siblings is found whatever the row order.
    const both = sshWith(() => ok("quickreview-sandbox-old exited\nquickreview-sandbox running\n")).ctx;
    expect((await stackTransportFor(both).containerChecks(null))[0]).toMatchObject({ ok: true });
  });

  it("checks a separately deployed memory sidecar, and says when it is stopped", async () => {
    writeFileSync(
      join(root, "config.toml"),
      setTomlKey(
        setTomlKey(exampleConfig, "github", "secrets_dir", secretsDir)!,
        "tui",
        "memory_container",
        "quickreview-memory",
      )!,
    );
    const { ctx } = sshWith((line) =>
      line.includes("name=quickreview-memory")
        ? ok("quickreview-memory exited\n")
        : ok("quickreview-sandbox running\n"),
    );
    const checks = await stackTransportFor(ctx).containerChecks(null);
    expect(checks[0]).toMatchObject({ name: "containers", ok: true });
    expect(checks.find((c) => c.name === "memory-sidecar")).toMatchObject({ ok: false });
  });

  it("the health probe honours the step's health budget", async () => {
    const { ctx, calls } = sshWith(() => ok('{"ok":true}\n200'));
    await stackTransportFor(ctx, { healthTimeoutMs: 30_000 }).health();
    expect(calls.find((c) => c.includes("curl"))).toMatch(/curl -sS -m 30 /);
  });

  it("a STOPPED deployed container keeps the change owed — never 'nothing to restart'", async () => {
    const { ctx } = sshWith((line) =>
      line.includes("ps --all") ? ok("quickreview-sandbox\n") : ok(""),
    );
    const r = await stackTransportFor(ctx).restart(() => undefined, false);
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/exists but is not running/);
    expect(r.detail).toMatch(/deploy\.sh release <version>/);
  });

  it("a server never deployed to has nothing to restart; one Docker cannot answer for is not 'done'", async () => {
    const never = sshWith(() => ok("quickreview-sandbox-other\n")).ctx;
    const r = await stackTransportFor(never).restart(() => undefined, false);
    expect(r).toMatchObject({ ok: true });
    expect(r.detail).toMatch(/nothing is deployed on the server yet/);
    const down = sshWith(() => ({ code: 255, stdout: "", stderr: "ssh: connect refused" })).ctx;
    const u = await stackTransportFor(down).restart(() => undefined, false);
    expect(u.ok).toBe(false);
    expect(u.detail).toMatch(/NOT known to be on the server/);
  });
});

describe("the layered verification runs over ssh, unchanged", () => {
  interface Layered {
    engine: OnboardingEngine;
    calls: string[][];
  }

  function layered(
    o: {
      containerState?: string;
      cloudflared?: string;
      health?: ProcessResult;
      ingress?: string;
      pingStatus?: number;
    } = {},
  ): Layered {
    seedChoices({
      ...VM_CHOICES,
      [INGRESS_CHOICE_KEY]: o.ingress ?? "named",
      webhook_url: "https://review.example.com/webhook",
    });
    const calls: string[][] = [];
    const runner = {
      run: async (cmd: string, args: string[]): Promise<ProcessResult> => {
        calls.push([cmd, ...args]);
        const line = args.join(" ");
        if (line.includes("docker ps"))
          return {
            code: 0,
            stdout: `quickreview-sandbox ${o.containerState ?? "running"}\n`,
            stderr: "",
          };
        if (line.includes("systemctl is-active"))
          return { code: 0, stdout: `${o.cloudflared ?? "active"}\n`, stderr: "" };
        if (line.includes("curl"))
          return o.health ?? { code: 0, stdout: '{"ok":true}\n200', stderr: "" };
        return { code: 1, stdout: "", stderr: "unexpected" };
      },
    };
    const fetchFake = (async (input: unknown) => {
      const url = String(input);
      if (url === `${API}/app/hook/config`)
        return new Response(JSON.stringify({ url: "https://review.example.com/webhook" }), {
          status: 200,
        });
      if (url.startsWith(`${API}/app/hook/deliveries?`)) {
        return new Response(
          JSON.stringify([
            {
              id: 1,
              event: "ping",
              status: "OK",
              status_code: o.pingStatus ?? 200,
              delivered_at: "2026-08-30T11:59:00Z",
              redelivery: false,
            },
          ]),
          { status: 200 },
        );
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as unknown as typeof fetch;
    const step = verifyStackStep({
      apiBase: API,
      secretsDir,
      sleep: async () => undefined,
      redeliver: false,
    });
    return { engine: new OnboardingEngine([step], baseAdapters(runner, fetchFake)), calls };
  }

  it("all three layers green: docker over ssh, health by curl ON the box, and GitHub's own delivery log", async () => {
    const h = layered();
    const result = await h.engine.runStep(VERIFY_STACK_STEP_ID);
    expect(result.ok).toBe(true);
    // The SAME check names as the laptop route: one implementation, not a copy.
    expect(result.checks.map((c) => c.name)).toEqual([
      "containers",
      "ingress-sidecar",
      "health",
      "webhook-url",
      "ping-delivery",
    ]);
    expect(result.checks.find((c) => c.name === "ping-delivery")!.detail).toMatch(
      /proven end to end/,
    );
    // Every hop carries BatchMode, and the health probe runs on the VM's
    // loopback (the daemon's port is deliberately not exposed off the box).
    for (const call of h.calls) expect(call.join(" ")).toMatch(/-o BatchMode=yes/);
    expect(h.calls.some((c) => c.join(" ").includes("curl -sS -m 10 -o - -w"))).toBe(true);
    expect(h.calls.find((c) => c.join(" ").includes("curl"))!.join(" ")).toMatch(
      /http:\/\/127\.0\.0\.1:8787\/health/,
    );
  });

  it("a dead container over ssh stops the step, with the ssh fix — and no later layer is attempted", async () => {
    const h = layered({ containerState: "exited" });
    const result = await h.engine.runStep(VERIFY_STACK_STEP_ID);
    expect(result.ok).toBe(false);
    expect(result.failures.join(" ")).toMatch(
      new RegExp(`ssh ${ALIAS} sudo docker logs --tail 200 quickreview-sandbox`),
    );
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

  it("polling over a cloudflared service that is still active says so — the downgrade never stops it", async () => {
    // A server that ran the named tunnel, re-onboarded to polling: the playbook
    // skips every cloudflared task when disabled and has no stop task, so the
    // service keeps forwarding the old hostname. "Nothing exposed" must not be
    // reported over it. It is a warning, not a failure: the service may be a
    // foreign tunnel on a shared box, which this wizard must never touch.
    const h = layered({ ingress: "polling", cloudflared: "active" });
    const result = await h.engine.runStep(VERIFY_STACK_STEP_ID);
    const said = result.checks.find((c) => c.name === "ingress-sidecar");
    expect(said, "polling reported nothing about a live cloudflared").toBeDefined();
    expect(said!.detail).toMatch(/cloudflared on review-box is active/);
    expect(said!.detail).toMatch(/systemctl disable --now cloudflared/);
    expect(result.checks.find((c) => c.name === "ping-delivery")!.detail).toMatch(/polling/);
  });

  it("polling with no cloudflared service running reports that nothing is exposed", async () => {
    const h = layered({ ingress: "polling", cloudflared: "inactive" });
    const result = await h.engine.runStep(VERIFY_STACK_STEP_ID);
    expect(result.ok).toBe(true);
    expect(result.checks.find((c) => c.name === "ingress-sidecar")!.detail).toMatch(
      /no cloudflared service is active on review-box/,
    );
  });

  it("a failed ping on this route points at the cloudflared service's journal, not a compose sidecar", async () => {
    const h = layered({ pingStatus: 502 });
    const result = await h.engine.runStep(VERIFY_STACK_STEP_ID);
    expect(result.ok).toBe(false);
    const said = result.checks.find((c) => c.name === "ping-delivery")!.detail;
    expect(said).toMatch(/ssh review-box journalctl -u cloudflared/);
    expect(said).not.toMatch(/docker compose logs/);
  });

  it("a health endpoint that answers nothing says where to look, over ssh", async () => {
    const h = layered({ health: { code: 7, stdout: "", stderr: "curl: (7) Failed to connect" } });
    const result = await h.engine.runStep(VERIFY_STACK_STEP_ID);
    expect(result.ok).toBe(false);
    expect(result.checks.find((c) => c.name === "health")!.detail).toMatch(
      /nothing answered http:\/\/127\.0\.0\.1:8787\/health on review-box/,
    );
  });
});

describe("the go-live flip on the server route", () => {
  const PROOF: ProofRecord = {
    pr: 17,
    round_no: 1,
    verdict: "REQUEST_CHANGES",
    completed_at: "2026-08-30T11:59:00Z",
    review_shown: true,
  };

  function golive(
    inventoryHost = ALIAS,
    deployed: unknown = RECORD(),
  ): { engine: OnboardingEngine; deploys: string[][] } {
    seedChoices({
      ...VM_CHOICES,
      [PROOF_CHOICE_KEY]: PROOF,
      ...(deployed === null ? {} : { [VM_DEPLOY_CHOICE_KEY]: deployed }),
    });
    writeFileSync(inventoryPath(root), `[quickreview]\n${inventoryHost}\n`);
    const deploys: string[][] = [];
    const runner = {
      run: async (cmd: string, args: string[]): Promise<ProcessResult> => {
        const line = args.join(" ");
        if (line.includes("docker ps"))
          return { code: 0, stdout: "quickreview-sandbox running\n", stderr: "" };
        if (line.includes("why")) {
          return {
            code: 0,
            stdout: JSON.stringify({
              pr: 17,
              known: true,
              state: "awaiting_author",
              rounds: [{ round_no: 1, status: "done", verdict: "REQUEST_CHANGES" }],
            }),
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
    return {
      engine: new OnboardingEngine([goLiveStep({ stream })], baseAdapters(runner)),
      deploys,
    };
  }

  it("re-verifies the proof through the SAME ssh exec, then ships the flipped config with the real deploy", async () => {
    const h = golive();
    const result = await h.engine.runStep(GO_LIVE_STEP_ID, {
      decision: "go_live",
      confirm: GO_LIVE_CONFIRMATION,
    });
    expect(result.ok).toBe(true);
    expect(loadConfig(join(root, "config.toml")).dry_run).toBe(false);
    // On this route the deploy IS the restart: the daemon reads the config the
    // deploy ships, so a hand-rolled `docker restart` would leave it stale.
    // — re-releasing the version that is deployed, which ships the config home.
    expect(h.deploys).toEqual([["bash", deployScriptPath(root), "release", "1.2.0"]]);
    expect(result.checks.find((c) => c.name === "daemon-restart")!.detail).toMatch(
      /scripts\/deploy\.sh release 1\.2\.0/,
    );
  });

  it("with no release version on record it ships nothing and says how to record one", async () => {
    const h = golive(ALIAS, null);
    const result = await h.engine.runStep(GO_LIVE_STEP_ID, {
      decision: "go_live",
      confirm: GO_LIVE_CONFIRMATION,
    });
    expect(h.deploys).toEqual([]);
    const restart = result.checks.find((c) => c.name === "daemon-restart")!;
    expect(restart.ok).toBe(false);
    expect(restart.detail).toMatch(/no release version is recorded/);
    expect(restart.detail).toMatch(/release <version>/);
  });

  it("never ships through an inventory that targets another host than the one it checked", async () => {
    const h = golive("old-box");
    const result = await h.engine.runStep(GO_LIVE_STEP_ID, {
      decision: "go_live",
      confirm: GO_LIVE_CONFIRMATION,
    });
    expect(h.deploys).toEqual([]);
    const restart = result.checks.find((c) => c.name === "daemon-restart")!;
    expect(restart.ok).toBe(false);
    expect(restart.detail).toMatch(/targets "old-box", not the recorded alias "review-box"/);
  });

  it("declining is still a first-class outcome, and ships nothing", async () => {
    const h = golive();
    const result = await h.engine.runStep(GO_LIVE_STEP_ID, { decision: "stay_dry_run" });
    expect(result.ok).toBe(true);
    expect(loadConfig(join(root, "config.toml")).dry_run).toBe(true);
    expect(h.deploys).toEqual([]);
  });
});
