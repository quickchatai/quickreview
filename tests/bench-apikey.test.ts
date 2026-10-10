// The benchmark's API-KEY route: an outsider re-runs the benchmark
// with their own OpenAI / Anthropic key instead of a pi ChatGPT login volume.
// Proven by construction — no review, judge or model call runs here:
//
//   1. the route is one switch (QCR_BENCH_AUTH), unknown values refused;
//   2. on it every `openai-codex/` spec becomes `openai/` (the same model on
//      the public API), from the config a fresh clone has (config.example.toml)
//      through the levers, into the fingerprint and the BUILT lens agents;
//   3. no login is read, the keys reach pi by name, and nothing changes on the
//      login route (every published fingerprint and judge label is stable);
//   4. a keyed run can never mix with the published login runs: its
//      fingerprint carries `auth`, its judge label keeps the provider;
//   5. the host side mounts no login volume on the route and keeps the key
//      file off every argv; the third-party arms' bridges and the Codex
//      driver have a keyed path.
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import {
  apiKeyEnv,
  authFingerprint,
  benchAuthMode,
  modelForAuth,
  syncBenchAuth,
} from "../src/bench/auth.js";
import { codexDriverArgv, codexDriverEnv } from "../src/bench/codex.js";
import { judgeLabel } from "../src/bench/defectjudge.js";
import { contextFor, runFingerprint, withAuthModels } from "../src/bench/runner.js";
import { buildAgents, identityVars, PASS_ADDENDA } from "../src/include.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EXAMPLE = join(ROOT, "config.example.toml");

/** Run `fn` with env vars set, restoring them after. */
function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) saved[k] = process.env[k];
  try {
    for (const [k, v] of Object.entries(vars)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

describe("the switch", () => {
  it("QCR_BENCH_AUTH: unset/login = the login route, api-key = the key route, anything else refused", () => {
    expect(benchAuthMode({})).toBe("login");
    expect(benchAuthMode({ QCR_BENCH_AUTH: "login" })).toBe("login");
    expect(benchAuthMode({ QCR_BENCH_AUTH: " api-key " })).toBe("api-key");
    expect(() => benchAuthMode({ QCR_BENCH_AUTH: "apikey" })).toThrow(/login \| api-key/);
  });

  it("only openai-codex/ moves, and only on the key route", () => {
    expect(modelForAuth("openai-codex/gpt-6.1-sol:high", "api-key")).toBe(
      "openai/gpt-6.1-sol:high",
    );
    expect(modelForAuth("openai-codex/gpt-6.1-sol:high", "login")).toBe(
      "openai-codex/gpt-6.1-sol:high",
    );
    expect(modelForAuth("anthropic/claude-opus-5-5", "api-key")).toBe("anthropic/claude-opus-5-5");
    expect(modelForAuth("openai/gpt-6-sol", "api-key")).toBe("openai/gpt-6-sol");
  });

  it("the keys pass by name on the key route, and not at all on the login route", () => {
    const env = { OPENAI_API_KEY: "sk-o", ANTHROPIC_API_KEY: "sk-a", OTHER: "x" };
    expect(apiKeyEnv("login", env)).toEqual({});
    expect(apiKeyEnv("api-key", env)).toEqual({
      OPENAI_API_KEY: "sk-o",
      ANTHROPIC_API_KEY: "sk-a",
    });
    expect(authFingerprint("login")).toEqual({});
    expect(authFingerprint("api-key")).toEqual({ auth: "api-key" });
  });
});

describe("no login is read on the key route", () => {
  it("syncBenchAuth writes an EMPTY auth.json and the sandbox settings, reading nothing", () => {
    const tmp = mkdtempSync(join(tmpdir(), "bench-apikey-"));
    try {
      const dst = join(tmp, "agent");
      const r = syncBenchAuth({
        srcDir: join(tmp, "no-such-volume"),
        dstDir: dst,
        root: "/r",
        needMs: 10 ** 9,
        mode: "api-key",
      });
      expect(r.expiresAt).toBeNull();
      expect(JSON.parse(readFileSync(join(dst, "auth.json"), "utf8"))).toEqual({});
      expect(statSync(join(dst, "auth.json")).mode & 0o777).toBe(0o600);
      expect(readdirSync(dst).sort()).toEqual(["auth.json", "settings.json", "trust.json"]);
      // …while the login route still refuses a missing login, and says how to avoid it.
      expect(() =>
        syncBenchAuth({
          srcDir: join(tmp, "none"),
          dstDir: dst,
          root: "/r",
          needMs: 0,
          mode: "login",
        }),
      ).toThrow(/QCR_BENCH_AUTH=api-key/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("dry config check: a fresh clone's config on the key route", () => {
  const saved = process.env.QCR_CONFIG;
  process.env.QCR_CONFIG = EXAMPLE;
  afterAll(() => {
    if (saved === undefined) delete process.env.QCR_CONFIG;
    else process.env.QCR_CONFIG = saved;
  });

  it("every model spec of config.example.toml (and of a --config lever) runs as openai/", () => {
    const login = contextFor(ROOT, "").cfg;
    const keyed = withEnv(
      { QCR_BENCH_AUTH: "api-key" },
      () => contextFor(ROOT, "", "models.tiers.sol-med=openai-codex/gpt-6-sol:medium").cfg,
    );
    const specs = (c: typeof login) => [
      c.models.default,
      c.models.conversation,
      c.models.overseer,
      ...Object.values(c.models.tiers),
    ];
    // The published route is untouched: the example's own provider.
    expect(specs(login).every((s) => s.startsWith("openai-codex/"))).toBe(true);
    expect(specs(keyed).every((s) => s.startsWith("openai/"))).toBe(true);
    expect(keyed.models.tiers["sol-med"]).toBe("openai/gpt-6-sol:medium");
    // Same model ids and levels — only the provider moved.
    const plain = withEnv({ QCR_BENCH_AUTH: "api-key" }, () => contextFor(ROOT, "").cfg);
    expect(specs(plain).map((s) => s.replace(/^openai\//, ""))).toEqual(
      specs(login).map((s) => s.replace(/^openai-codex\//, "")),
    );
    // withAuthModels is the identity on the login route.
    expect(withAuthModels(login, "login")).toBe(login);
  });

  it("a per-pass model override (models.pass_models) runs as openai/ too", () => {
    const keyed = withEnv(
      { QCR_BENCH_AUTH: "api-key" },
      () => contextFor(ROOT, "", "models.pass_models.pass-baseline=openai-codex/gpt-6-sol").cfg,
    );
    expect(keyed.models.pass_models["pass-baseline"]).toBe("openai/gpt-6-sol");
    const login = contextFor(ROOT, "", "models.pass_models.pass-baseline=openai-codex/gpt-6-sol").cfg;
    expect(login.models.pass_models["pass-baseline"]).toBe("openai-codex/gpt-6-sol");
  });

  it("the BUILT lens agents carry openai/ specs — what pi's subagents actually run", () => {
    const cfg = withEnv({ QCR_BENCH_AUTH: "api-key" }, () => contextFor(ROOT, "").cfg);
    const out = mkdtempSync(join(tmpdir(), "bench-apikey-agents-"));
    try {
      buildAgents(join(ROOT, "agents"), out, {
        root: ROOT,
        tiers: cfg.models.tiers,
        riskPasses: cfg.models.risk_passes,
        validateTier: cfg.models.validate_tier,
        vars: identityVars(cfg),
        addenda: [...PASS_ADDENDA],
      });
      const models = readdirSync(out)
        .filter((f) => f.endsWith(".md"))
        .map((f) => /^model:\s*(\S+)/m.exec(readFileSync(join(out, f), "utf8"))?.[1] ?? "");
      expect(models.length).toBeGreaterThan(10);
      for (const m of models) expect(m, m).toMatch(/^openai\//);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });

  it("a keyed run's fingerprint differs from the login run's, so --resume never mixes them", () => {
    const login = contextFor(ROOT, "").cfg;
    const keyedFp = withEnv({ QCR_BENCH_AUTH: "api-key" }, () =>
      runFingerprint(contextFor(ROOT, "").cfg, ""),
    );
    const loginFp = runFingerprint(login, "");
    expect(loginFp).not.toHaveProperty("auth");
    expect(keyedFp.auth).toBe("api-key");
    expect(keyedFp.conversation).toMatch(/^openai\//);
  });
});

describe("judge verdicts stay apart", () => {
  it("published labels are unchanged; any other provider stays in the label", () => {
    expect(judgeLabel("2", "openai-codex/gpt-6-sol:high")).toBe("v2-gpt-6-sol-high");
    expect(judgeLabel("2", "anthropic/claude-opus-5-5")).toBe("v2-claude-opus-5-5");
    expect(judgeLabel("2", modelForAuth("openai-codex/gpt-6-sol:high", "api-key"))).toBe(
      "v2-openai-gpt-6-sol-high",
    );
  });
});

describe("the Codex CLI arm: the harness's own CODEX_API_KEY route", () => {
  const paths = {
    python: "/py",
    driver: "/d.py",
    dataset: "/ds.jsonl",
    tree: "/wt/x",
    results: "/out/r",
    caseDir: "/out/c",
    homeBase: "/wt/x.codex",
  };
  const c = {
    instance_id: "o__r@1234567",
    repo: "o/r",
    pr: 1,
    base_commit: "b".repeat(40),
    head_commit: "h".repeat(40),
  } as Parameters<typeof codexDriverArgv>[0];

  it("no --auth-json on the key route, the key under the driver's own name", () => {
    const argv = codexDriverArgv(
      c,
      { ...paths, authJson: null },
      {
        timeoutMin: 30,
        model: "gpt-6-sol",
        effort: "medium",
      },
    );
    expect(argv).toContain("--api-key");
    expect(argv).not.toContain("--auth-json");
    expect(argv.join(" ")).not.toContain("sk-");
    const env = codexDriverEnv({ path: "/bin", home: "/h", tmpDir: "/t", apiKey: "sk-x" });
    expect(env["QCR_CODEX_API_KEY"]).toBe("sk-x");
    // The variables Codex and the driver read on their own stay unset (the driver refuses them).
    for (const k of ["OPENAI_API_KEY", "CODEX_API_KEY"]) expect(env[k]).toBeUndefined();
    expect(codexDriverEnv({ path: "/bin", home: "/h", tmpDir: "/t" })).not.toHaveProperty(
      "QCR_CODEX_API_KEY",
    );
  });

  it("the driver's prelude switches the login method and its CLI takes exactly one route", () => {
    const py = readFileSync(join(ROOT, "bench", "aacr", "codex_arm.py"), "utf8");
    expect(py).toContain('API_KEY_VAR = "QCR_CODEX_API_KEY"');
    expect(py).toContain("codex_env[config.CODEX_API_KEY_VAR] = api_key");
    expect(py).toMatch(/exactly one of --auth-json .* and --api-key/);
  });
});

describe("the host side (bench.sh, ext.sh)", () => {
  const sh = readFileSync(join(ROOT, "bench", "aacr", "bench.sh"), "utf8");
  const ext = readFileSync(join(ROOT, "bench", "aacr", "ext", "ext.sh"), "utf8");

  it("on the key route auth_mounts returns before any login volume is touched", () => {
    const fn = sh.slice(
      sh.indexOf("auth_mounts() {"),
      sh.indexOf("\n}\n", sh.indexOf("auth_mounts() {")),
    );
    const keyed = fn.indexOf('if [[ "$AUTH_MODE" == api-key ]]');
    expect(keyed).toBeGreaterThan(0);
    expect(fn.indexOf("return 0", keyed)).toBeLessThan(fn.indexOf("docker volume inspect"));
    expect(fn).toContain("-e QCR_BENCH_AUTH=api-key");
  });

  it("the key file goes by --env-file, is validated by NAME only, and is gitignored", () => {
    const fn = sh.slice(sh.indexOf("openai_env_args() {"), sh.indexOf("auth_mounts() {"));
    expect(fn).toContain('OENV=(--env-file "$OPENAI_ENV")');
    expect(fn).not.toMatch(/\bcat\b|source |\. "\$OPENAI_ENV"/);
    expect(readFileSync(join(ROOT, "bench", "aacr", ".gitignore"), "utf8")).toMatch(
      /^openai\.env$/m,
    );
    expect(ext).toContain('--env-file "$OPENAI_ENV"');
  });

  it("the login-only AACR judge shim is refused on the key route (--judge openai is the keyed path)", () => {
    expect(sh).toMatch(/--judge codex reads the pi login; on the API-key route use --judge openai/);
  });
});

describe("the bridges (OCR, OpenCode, PR-Agent arms and the external judge)", () => {
  it("codex_bridge.py self-tests its keyed route: public API, Bearer key, no ChatGPT headers", () => {
    const r = spawnSync(
      "python3",
      [join(ROOT, "bench", "aacr", "codex_bridge.py"), "--self-test"],
      {
        encoding: "utf8",
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
      },
    );
    expect(r.status, r.stderr).toBe(0);
    const py = readFileSync(join(ROOT, "bench", "aacr", "codex_bridge.py"), "utf8");
    expect(py).toContain('API_UPSTREAM = "https://api.openai.com/v1/responses"');
    const judge = readFileSync(join(ROOT, "bench", "aacr", "ext", "ext_judge.py"), "utf8");
    expect(judge).toContain("cb.api_key_route()");
  });
});
