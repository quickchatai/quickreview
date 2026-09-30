// The third-party arms on gpt-6.1-sol (the operator's order, 2026-09-30: every
// compared tool on gpt-6.1): one model knob per arm, default unchanged (gpt-6-sol,
// the published runs), and each arm able to actually serve the new id.
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { caseCostUsd, ratesFor } from "../src/bench/cost.js";
import { nativeModelEntry, opencodeConfig, opencodeModels } from "../src/bench/opencode.js";
import { piHasBuiltins, pireviewPiSettings, PIREVIEW_PI_SETTINGS } from "../src/bench/pireview.js";
import { PI_DISABLED_BUILTINS } from "../src/pibuiltins.js";

const B = join(import.meta.dirname, "..", "bench", "aacr");
const tmps: string[] = [];
afterEach(() => {
  for (const t of tmps.splice(0)) rmSync(t, { recursive: true, force: true });
});

function benchTree(): { here: string; bin: string; log: string } {
  const tmp = mkdtempSync(join(tmpdir(), "g61-sh-"));
  tmps.push(tmp);
  const here = join(tmp, "repo", "bench", "aacr");
  mkdirSync(here, { recursive: true });
  cpSync(join(B, "bench.sh"), join(here, "bench.sh"));
  const bin = join(tmp, "bin");
  mkdirSync(bin);
  const log = join(tmp, "docker.log");
  writeFileSync(join(bin, "docker"), `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "${log}"\n`);
  chmodSync(join(bin, "docker"), 0o755);
  return { here, bin, log };
}

function review(arm: string, env: Record<string, string>) {
  const t = benchTree();
  const r = spawnSync("bash", [join(t.here, "bench.sh"), "review", "--arm", arm, "--run", "r1"], {
    env: {
      ...process.env,
      PATH: `${t.bin}:${process.env.PATH}`,
      QCR_BENCH_RUNS_DIR: join(t.here, "runs"),
      ...env,
    },
    encoding: "utf8",
  });
  let calls = "";
  try {
    calls = readFileSync(t.log, "utf8");
  } catch {
    // no docker call at all
  }
  const run = calls.split("\n").filter((l) => l.startsWith("run ") && l.includes("-review"));
  return { status: r.status, stderr: r.stderr, run: run.join("\n") };
}

describe("bench.sh: QCR_BENCH_<ARM>_MODEL", () => {
  const cases: [string, string, string[]][] = [
    ["ocr", "QCR_BENCH_OCR_MODEL", ["OCR_BRIDGE_MODEL=gpt-6.1-sol"]],
    ["opencode", "QCR_BENCH_OPENCODE_MODEL", ["OPENCODE_BRIDGE_MODEL=gpt-6.1-sol", "QCR_OPENCODE_MODEL=gpt-6.1-sol"]],
    ["codex", "QCR_BENCH_CODEX_MODEL", ["QCR_CODEX_MODEL=gpt-6.1-sol"]],
    ["pireview", "QCR_BENCH_PIREVIEW_MODEL", ["QCR_PIREVIEW_MODEL=openai-codex/gpt-6.1-sol"]],
  ];
  for (const [arm, knob, envs] of cases) {
    it(`${arm}: ${knob} reaches the container; unset passes nothing`, () => {
      const set = review(arm, { [knob]: "gpt-6.1-sol" });
      expect(set.status).toBe(0);
      for (const e of envs) expect(set.run).toContain(`-e ${e}`);
      const unset = review(arm, {});
      expect(unset.status).toBe(0);
      expect(unset.run).not.toMatch(/MODEL=/);
    });
  }

  it("codex: QCR_BENCH_CODEX_VERSION builds another Codex CLI, only with its sha256", () => {
    const sh = readFileSync(join(B, "bench.sh"), "utf8");
    expect(sh).toContain('--build-arg "CODEX_VERSION=$QCR_BENCH_CODEX_VERSION"');
    expect(sh).toContain(
      '--build-arg "CODEX_SHA256_LINUX_X64=${QCR_BENCH_CODEX_SHA256:?set QCR_BENCH_CODEX_SHA256 with QCR_BENCH_CODEX_VERSION}"',
    );
  });

  it("refuses a value that is not a Codex model id", () => {
    const r = review("codex", { QCR_BENCH_CODEX_MODEL: "gpt-6.1-sol; rm -rf /" });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/QCR_BENCH_CODEX_MODEL must be a Codex model id/);
    expect(r.run).toBe("");
  });
});

describe("OpenCode native: a model its bundled catalog lacks is declared on the openai provider", () => {
  const cfg = {
    bridgeUrl: "http://127.0.0.1:8766",
    mcpPython: "/py",
    mcpScript: "/mcp.py",
    resultsDir: "/r",
    instanceId: "o__r@1",
    provider: "native" as const,
  };

  it("gpt-6.1-sol: model, small model and a provider.openai.models entry — still provider openai", () => {
    const c = opencodeConfig({ ...cfg, model: "gpt-6.1-sol" });
    expect(c["model"]).toBe("openai/gpt-6.1-sol");
    expect(c["small_model"]).toBe("openai/gpt-6.1-sol");
    expect(c["enabled_providers"]).toEqual(["openai"]);
    const entry = (c["provider"] as Record<string, { models: Record<string, Record<string, unknown>> }>)[
      "openai"
    ]!.models["gpt-6.1-sol"]!;
    expect(entry).toEqual(nativeModelEntry("gpt-6.1-sol"));
    expect(entry["reasoning"]).toBe(true);
    // no npm / baseURL / apiKey: the built-in provider's transport and login
    expect(Object.keys((c["provider"] as Record<string, Record<string, unknown>>)["openai"]!)).toEqual([
      "models",
    ]);
  });

  it("counts the store's assistant messages by provider/model", () => {
    expect(
      opencodeModels(
        JSON.stringify([
          { provider: "openai", model: "gpt-6.1-sol", n: 7 },
          { provider: null, model: null, n: 1 },
        ]),
      ),
    ).toEqual({ "openai/gpt-6.1-sol": 7, "?/?": 1 });
    expect(opencodeModels("not json")).toBeNull();
    expect(opencodeModels("{}")).toBeNull();
  });

  it("gpt-6-sol (the published native runs): no provider block at all", () => {
    expect(nativeModelEntry("gpt-6-sol")).toBeNull();
    expect(opencodeConfig({ ...cfg, model: "gpt-6-sol" })["provider"]).toBeUndefined();
  });
});

describe("pi-review on pi >= 0.99: the built-in extensions are switched off", () => {
  it("0.87.1 (the published arm) keeps exactly the old settings; 0.99.1 adds -builtin:*", () => {
    expect(pireviewPiSettings("0.87.1")).toEqual(PIREVIEW_PI_SETTINGS);
    expect(pireviewPiSettings("0.99.1")).toEqual({
      ...PIREVIEW_PI_SETTINGS,
      extensions: [...PI_DISABLED_BUILTINS],
    });
    expect(piHasBuiltins("0.98.9")).toBe(false);
    expect(piHasBuiltins("0.99.0")).toBe(true);
    expect(piHasBuiltins("1.0.0")).toBe(true);
    expect(piHasBuiltins("unknown")).toBe(true);
  });
});

describe("pricing: gpt-6.1-sol on every priced arm", () => {
  it("rates per model; a bridge-shaped summary naming gpt-6.1-sol is priced at its rates", () => {
    expect(ratesFor("gpt-6.1-sol")).toEqual({ input: 2, cacheRead: 0.1, output: 10 });
    const d = mkdtempSync(join(tmpdir(), "g61-cost-"));
    tmps.push(d);
    writeFileSync(
      join(d, "case-summary.json"),
      JSON.stringify({
        fingerprint: { model: "gpt-6.1-sol" },
        bridge: { input_tokens: 1_000_000, cached_tokens: 500_000, output_tokens: 100_000 },
      }),
    );
    const c = caseCostUsd(d)!;
    expect(c.model).toBe("gpt-6.1-sol");
    expect(c.usd).toBeCloseTo(0.5 * 2 + 0.5 * 0.1 + 0.1 * 10, 9);
  });
});
