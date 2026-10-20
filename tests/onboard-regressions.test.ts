import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "smol-toml";
import { type StepContext, OnboardingEngine, checklistComplete } from "../src/onboard/engine.js";
import { configFillStep, patchToml } from "../src/onboard/steps/configfill.js";
import { escalationStep } from "../src/onboard/steps/escalation.js";
import { llmAuthStep } from "../src/onboard/steps/llmauth.js";
import { normalizeHostname } from "../src/onboard/steps/ingress.js";
import { preflightStep } from "../src/onboard/steps/preflight.js";
import { inventoryPath } from "../src/onboard/steps/inventory.js";
import { api } from "../src/onboard/steps/githubapp.js";
import { embeddingsStep } from "../src/onboard/steps/embeddings.js";
import { bringUpStep } from "../src/onboard/steps/bringup.js";

let root: string;
const template = readFileSync(new URL("../config.example.toml", import.meta.url), "utf8");
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "qcr-onboard-regressions-"));
  mkdirSync(join(root, "state"));
  writeFileSync(join(root, "config.toml"), template);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});
function ctx(): StepContext {
  return {
    adapters: {
      runner: {
        run: async () => ({
          code: 0,
          stdout: JSON.stringify([{ Service: "daemon", State: "running" }]),
          stderr: "",
        }),
      },
      fetch: vi.fn() as unknown as typeof fetch,
      clock: () => new Date("2026-10-18T12:00:00Z"),
      host: { nodeVersion: "v22.0.0", uid: 1000 },
      paths: { stateDir: join(root, "state"), configPath: join(root, "config.toml") },
    },
    choices: { stack_brought_up_at: "2026-10-17T12:00:00Z" },
    data: {},
    input: {},
    recordChoice: vi.fn(),
  };
}

describe("onboarding regression seams", () => {
  it.each(['name = """Da\\\nna""" # keep\n', '"name" = "Dana"\n', "'name' = 'Dana'\n"])(
    "patches existing semantic assignment %s",
    (assignment) => {
      const patched = patchToml("[owner]\n" + assignment, [
        { section: "owner", key: "name", value: '"New"' },
      ]);
      expect(parse(patched)).toEqual({ owner: { name: "New" } });
      expect(patchToml(patched, [{ section: "owner", key: "name", value: '"New"' }])).toBe(patched);
    },
  );
  it("ignores apparent assignments and table headers inside multiline string bodies", () => {
    const text =
      '[owner]\nname = """Dana\n[owner]\ngithub_login = "quoted-body"\n"""\ngithub_login = "old"\n';
    const patched = patchToml(text, [{ section: "owner", key: "github_login", value: '"new"' }]);
    expect(parse(patched)).toEqual({
      owner: { name: 'Dana\n[owner]\ngithub_login = "quoted-body"\n', github_login: "new" },
    });
  });
  it.each(["review-.example.com", "review.example-.com"])("rejects invalid hostname %s", (name) => {
    expect(normalizeHostname(name)).toBeNull();
  });
  it("fails uid verification when the current host uid is unavailable", async () => {
    const c = ctx();
    c.adapters.host.uid = null;
    const report = await preflightStep().verify({ ...c, data: { uid: 1000 } });
    expect(report.checks.find((check) => check.name === "uid")?.ok).toBe(false);
  });
  it("uses the inherited deployment inventory override", () => {
    vi.stubEnv("QC_INVENTORY", join(root, "custom.ini"));
    expect(inventoryPath(root)).toBe(join(root, "custom.ini"));
  });
  it("bounds GitHub response-body consumption", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn(async () => ({
      status: 200,
      text: () => new Promise<string>(() => {}),
    })) as unknown as typeof fetch;
    const result = api(fetcher, "https://api.github.test/app");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await Promise.race([result, Promise.resolve("pending")])).not.toBe("pending");
  });
  it("detects stale local embedder environment before claiming bring-up verified", async () => {
    writeFileSync(join(root, ".env"), "QCR_OPENVIKING_EMBEDDING_PROVIDER=openai\n");
    const report = await bringUpStep().verify(ctx());
    expect(report.ok).toBe(false);
    expect(report.checks.some((check) => check.name === "embedder" && !check.ok)).toBe(true);
  });
  it("reports unknown embedder inputs when the config source cannot be read", async () => {
    rmSync(join(root, "config.toml"));
    const report = await bringUpStep().verify(ctx());
    expect(report.ok).toBe(false);
    expect(report.checks.find((check) => check.name === "embedder")?.detail).toContain(
      "unreadable",
    );
  });
  it("withdraws current completion before a long rerun starts changing the installation", async () => {
    let release: (() => void) | undefined;
    let wait = false;
    const step = {
      id: "slow",
      title: "slow",
      explain: "slow",
      order: 1,
      run: async () => {
        if (wait)
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        return { ok: true, checks: [] };
      },
      verify: async () => ({ ok: true, checks: [] }),
    };
    const engine = new OnboardingEngine([step], ctx().adapters);
    await engine.runStep("slow");
    await engine.finish();
    expect(checklistComplete(join(root, "state"))).toBe(true);
    wait = true;
    const running = engine.runStep("slow");
    try {
      expect(checklistComplete(join(root, "state"))).toBe(false);
    } finally {
      release?.();
      await running;
    }
  });
  it("does not verify local embeddings while the running stack retains hosted inputs", async () => {
    writeFileSync(join(root, ".env"), "QCR_OPENVIKING_EMBEDDING_PROVIDER=openai\n");
    const report = await embeddingsStep().verify(ctx());
    expect(report.ok).toBe(false);
    expect(report.checks.some((check) => !check.ok && check.name === "embedder-inputs")).toBe(true);
  });
  it("checks the active embedder even when the next-boot environment already matches local", async () => {
    const c = ctx();
    c.adapters.runner = {
      run: async (_cmd, args) => ({
        code: 0,
        stdout: args.includes("exec")
          ? JSON.stringify({ provider: "openai", model: "text-embedding-3-small", dimension: 1536 })
          : JSON.stringify([{ Service: "daemon", State: "running" }]),
        stderr: "",
      }),
    };
    const report = await embeddingsStep().verify(c);
    expect(report.ok).toBe(false);
    expect(report.checks.some((check) => !check.ok && check.name === "embedder-runtime")).toBe(
      true,
    );
  });
  it("verifies a running local embedder whose active identity and boot inputs both match", async () => {
    const c = ctx();
    c.adapters.runner = {
      run: async (_cmd, args) => ({
        code: 0,
        stdout: args.includes("exec")
          ? JSON.stringify({
              provider: "openai",
              model: "bge-small-en-v1.5-f16",
              dimension: 384,
              api_base: "http://127.0.0.1:1934/v1",
            })
          : JSON.stringify([{ Service: "daemon", State: "running" }]),
        stderr: "",
      }),
    };
    const report = await embeddingsStep().verify(c);
    expect(
      report.ok,
      report.checks
        .filter((check) => !check.ok)
        .map((check) => check.detail)
        .join(" "),
    ).toBe(true);
  });
  it("delivers changed interview settings and persists a failed restart", async () => {
    const c = ctx();
    c.input = {
      repo: "acme/web",
      reviewed_repo_dir: root,
      app_slug: "acme-reviewer",
      owner_name: "Dana",
      owner_github_login: "dana",
      owner_slack_id: "",
      timezone: "UTC",
      base_branch: "main",
      escalation_mention: "",
    };
    const stream = { run: vi.fn(async () => ({ code: 1, stdout: "", stderr: "restart failed" })) };
    const report = await configFillStep({ transport: { stream } }).run(c);
    expect(stream.run).toHaveBeenCalledOnce();
    expect(report.ok).toBe(false);
    expect(report.data?.restart_owed).toBe(true);
  });
  it("ships a precollected API key when switching a running VM to the API route", async () => {
    const c = ctx();
    c.choices = {
      topology: "vm",
      vm_ssh_alias: "review-vm",
      vm_deployed: {
        mode: "release",
        version: "1.2.0",
        provisioned: true,
        at: "2026-10-17T12:00:00Z",
        host: "review-vm",
      },
    };
    const secrets = join(root, "secrets");
    mkdirSync(secrets);
    writeFileSync(join(secrets, "openai_api_key"), "sk-proj-test0000000000000000000000000");
    writeFileSync(
      join(root, "config.toml"),
      template.replace(/^secrets_dir = .*$/m, `secrets_dir = "${secrets}"`),
    );
    mkdirSync(join(root, "deploy", "ansible"), { recursive: true });
    writeFileSync(join(root, "deploy", "ansible", "inventory.ini"), "[quickreview]\nreview-vm\n");
    c.adapters.runner = {
      run: async (cmd) =>
        cmd === "ssh"
          ? { code: 0, stdout: "quickreview-sandbox Up", stderr: "" }
          : { code: 1, stdout: "", stderr: "No such object" },
    };
    const stream = {
      run: vi.fn(async (_cmd: string, _args: string[], _line: (line: string) => void) => ({
        code: 0,
        stdout: "",
        stderr: "",
      })),
    };
    const report = await llmAuthStep({ transport: { stream } }).run(c);
    expect(
      report.ok,
      report.checks
        .filter((check) => !check.ok)
        .map((check) => check.detail)
        .join(" "),
    ).toBe(true);
    // New secrets need the host provisioning a release skips: provision, then
    // a re-release of the version on record.
    expect(stream.run.mock.calls.map((call) => call[1]?.slice(1))).toEqual([
      ["provision"],
      ["release", "1.2.0"],
    ]);
  });
  it("delivers changed model routing and persists a failed restart", async () => {
    const c = ctx();
    c.input = { route: "api" };
    const secrets = join(root, "secrets");
    mkdirSync(secrets);
    writeFileSync(join(secrets, "openai_api_key"), "sk-proj-test0000000000000000000000000");
    writeFileSync(
      join(root, "config.toml"),
      template.replace(/^secrets_dir = .*$/m, `secrets_dir = "${secrets}"`),
    );
    const stream = { run: vi.fn(async () => ({ code: 1, stdout: "", stderr: "restart failed" })) };
    const report = await llmAuthStep({ transport: { stream } }).run(c);
    expect(stream.run).toHaveBeenCalledOnce();
    expect(report.data?.restart_owed).toBe(true);
    expect(report.ok).toBe(false);
  });
  it("delivers changed escalation config and keeps a failed restart owed", async () => {
    const c = ctx();
    c.input = { enable: "yes", targets: "alice", why: "owns schema", paths: "db/**" };
    const stream = { run: vi.fn(async () => ({ code: 1, stdout: "", stderr: "restart failed" })) };
    const step = escalationStep({ transport: { stream } });
    const result = await step.run(c);
    expect(stream.run).toHaveBeenCalledOnce();
    expect(result.ok).toBe(false);
    expect(result.data?.restart_owed).toBe(true);
    expect((await step.verify({ ...c, data: result.data ?? {} })).ok).toBe(false);
  });
});
