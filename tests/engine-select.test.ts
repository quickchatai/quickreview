// P5.1: the runtime selection keys. `[engine] runtime = proc|sdk` and
// `[pi] lens_runtime = native|engine` parse with proc/native defaults, the
// shipped example config still validates, and a route that has no SDK host
// refuses `sdk` instead of running on proc.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.js";
import type { Runtime } from "../src/engine/port.js";
import { checkLensRuntime, parseRuntimeKind, selectRuntime } from "../src/engine/select.js";
import { scanLeafRunner } from "../extensions/setup-scan.js";
import type { CaseRunner, CaseSpec } from "../src/setup/engine.js";

const ROOT = resolve(import.meta.dirname, "..");
const FIXTURE = readFileSync(join(ROOT, "tests", "fixtures", "config.toml"), "utf8");
const EXAMPLE = readFileSync(join(ROOT, "config.example.toml"), "utf8");

/** `text` with `line` placed under the `[pi]` table header. */
const underPi = (text: string, line: string): string =>
  text.replace(/^\[pi\]\s*$/m, `[pi]\n${line}`);

describe("[engine] runtime and [pi] lens_runtime", () => {
  it("default to proc and native when the file says nothing", () => {
    for (const text of [FIXTURE, EXAMPLE]) {
      const cfg = parseConfig(text);
      expect(cfg.engine.runtime).toBe("proc");
      expect(cfg.pi.lens_runtime).toBe("native");
    }
  });

  it("read the file's values", () => {
    const cfg = parseConfig(
      underPi(`${FIXTURE}\n[engine]\nruntime = "sdk"\n`, 'lens_runtime = "engine"'),
    );
    expect(cfg.engine.runtime).toBe("sdk");
    expect(cfg.pi.lens_runtime).toBe("engine");
  });

  it("refuse a value outside the closed set, naming the key", () => {
    expect(() => parseConfig(`${FIXTURE}\n[engine]\nruntime = "docker"\n`)).toThrow(
      /\[engine\] runtime must be one of proc \| sdk/,
    );
    expect(() => parseConfig(underPi(FIXTURE, 'lens_runtime = "wave"'))).toThrow(
      /\[pi\] lens_runtime must be one of native \| engine/,
    );
  });
});

describe("selectRuntime", () => {
  const sdk = {} as Runtime;

  it("proc selects nothing: the route keeps its own process runtime", () => {
    expect(selectRuntime("proc", "review")).toBeUndefined();
    expect(selectRuntime("proc", "review", () => sdk)).toBeUndefined();
  });

  it("sdk builds the route's host, and is refused where the route has none", () => {
    expect(selectRuntime("sdk", "review", () => sdk)).toBe(sdk);
    expect(() => selectRuntime("sdk", "scan")).toThrow(/not available on the scan route/);
  });

  it("lens_runtime = engine is refused where the route has no lens tool yet", () => {
    expect(() => checkLensRuntime("native", "review")).not.toThrow();
    expect(() => checkLensRuntime("engine", "review", true)).not.toThrow();
    expect(() => checkLensRuntime("engine", "bench")).toThrow(/not available on the bench route/);
  });

  it("--runtime accepts proc and sdk only", () => {
    expect(parseRuntimeKind("sdk")).toBe("sdk");
    expect(() => parseRuntimeKind("native")).toThrow(/--runtime must be proc \| sdk/);
  });
});

describe("the scan leaf runner under [engine] runtime", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "engine-select-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const spec = {} as CaseSpec;
  const inner = (): { runner: CaseRunner; calls: () => number } => {
    let n = 0;
    return {
      runner: {
        run: async () => {
          n++;
          return { ok: false, reason: "inner" };
        },
      },
      calls: () => n,
    };
  };
  const envWith = (toml: string): NodeJS.ProcessEnv => {
    const path = join(dir, "config.toml");
    writeFileSync(path, toml);
    return { QCR_CONFIG: path };
  };

  it("passes straight through on proc and on an unreadable config", async () => {
    for (const env of [envWith(FIXTURE), { QCR_CONFIG: join(dir, "missing.toml") }]) {
      const i = inner();
      const out = await scanLeafRunner(i.runner, ROOT, env).run(spec, new AbortController().signal);
      expect(out).toEqual({ ok: false, reason: "inner" });
      expect(i.calls()).toBe(1);
    }
  });

  it("refuses every case on sdk, without starting a leaf", async () => {
    const i = inner();
    const env = envWith(`${FIXTURE}\n[engine]\nruntime = "sdk"\n`);
    const out = await scanLeafRunner(i.runner, ROOT, env).run(spec, new AbortController().signal);
    expect(out).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/not available on the scan route/),
    });
    expect(i.calls()).toBe(0);
  });
});
