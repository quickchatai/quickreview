// P5.1: the runtime selection keys. `[engine] runtime = sdk` (`proc` is retired
// and refused) and `[pi] lens_runtime = native|engine` parse with sdk/engine
// defaults (X2), the shipped example config still validates, and a route that
// has no SDK host refuses `sdk`.
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
  it("default to sdk, engine and the engine wave when the file says nothing", () => {
    for (const text of [FIXTURE, EXAMPLE]) {
      const cfg = parseConfig(text);
      expect(cfg.engine.runtime).toBe("sdk");
      expect(cfg.pi.lens_runtime).toBe("engine");
      expect(cfg.pi.engine_wave).toBe(true);
    }
  });

  it("runtime = proc is refused with a retirement message", () => {
    expect(() => parseConfig(`${FIXTURE}\n[engine]\nruntime = "proc"\n`)).toThrow(
      /"proc" is retired/,
    );
  });

  it('lens_runtime = "native" is refused as retired (pi\'s subagent glue is gone)', () => {
    expect(() => parseConfig(underPi(FIXTURE, 'lens_runtime = "native"'))).toThrow(
      /lens_runtime = "native" is retired/,
    );
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
      /\[engine\] runtime must be one of sdk/,
    );
    expect(() => parseConfig(underPi(FIXTURE, 'lens_runtime = "wave"'))).toThrow(
      /\[pi\] lens_runtime must be one of engine/,
    );
  });

  it("[pi] engine_wave defaults on with the engine lens runtime, reads true only with it, and is a boolean", () => {
    for (const text of [FIXTURE, EXAMPLE]) expect(parseConfig(text).pi.engine_wave).toBe(true);
    expect(parseConfig(underPi(FIXTURE, "engine_wave = false")).pi.engine_wave).toBe(false);
    const on = underPi(FIXTURE, 'lens_runtime = "engine"\nengine_wave = true');
    expect(parseConfig(on).pi.engine_wave).toBe(true);
    expect(() => parseConfig(underPi(FIXTURE, 'engine_wave = "yes"'))).toThrow(
      /\[pi\] engine_wave must be true or false/,
    );
  });
});

describe("selectRuntime", () => {
  const sdk = {} as Runtime;

  it("sdk builds the route's host, and is refused where the route has none", () => {
    expect(selectRuntime("sdk", "review", () => sdk)).toBe(sdk);
    expect(() => selectRuntime("sdk", "scan")).toThrow(/not available on the scan route/);
  });

  it("lens_runtime = engine is refused where the route has no lens tool yet", () => {
    expect(() => checkLensRuntime("engine", "review", true)).not.toThrow();
    expect(() => checkLensRuntime("engine", "bench")).toThrow(/not available on the bench route/);
  });

  it("a runtime kind accepts sdk only", () => {
    expect(parseRuntimeKind("sdk")).toBe("sdk");
    expect(() => parseRuntimeKind("proc")).toThrow(/must be sdk/);
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

  it("passes straight through on a config that does not load (the retired proc included)", async () => {
    for (const env of [
      envWith(`${FIXTURE}\n[engine]\nruntime = "proc"\n`),
      { QCR_CONFIG: join(dir, "missing.toml") },
    ]) {
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

  it("runs on the driver's SDK leaves on sdk, built once and never on the process runner", async () => {
    const i = inner();
    const built: number[] = [];
    const sdk: CaseRunner = { run: async () => ({ ok: true, output: "sdk", cost_usd: null }) };
    const env = envWith(`${FIXTURE}\n[engine]\nruntime = "sdk"\n`);
    const runner = scanLeafRunner(i.runner, ROOT, env, () => {
      built.push(1);
      return sdk;
    });
    const signal = new AbortController().signal;
    expect(await runner.run(spec, signal)).toMatchObject({ ok: true, output: "sdk" });
    expect(await runner.run(spec, signal)).toMatchObject({ ok: true, output: "sdk" });
    expect(built).toHaveLength(1);
    expect(i.calls()).toBe(0);
  });

  it("a config that does not load never builds the SDK leaves", async () => {
    const i = inner();
    const env = envWith(`${FIXTURE}\n[engine]\nruntime = "proc"\n`);
    const runner = scanLeafRunner(i.runner, ROOT, env, () => {
      throw new Error("built");
    });
    expect(await runner.run(spec, new AbortController().signal)).toEqual({
      ok: false,
      reason: "inner",
    });
  });

  it("refuses the case when the SDK leaves cannot be built, and tries again at the next", async () => {
    const i = inner();
    let attempts = 0;
    const env = envWith(`${FIXTURE}\n[engine]\nruntime = "sdk"\n`);
    const runner = scanLeafRunner(i.runner, ROOT, env, () => {
      attempts++;
      throw new Error("no host");
    });
    const signal = new AbortController().signal;
    for (let n = 1; n <= 2; n++)
      expect(await runner.run(spec, signal)).toMatchObject({
        ok: false,
        reason: expect.stringMatching(/could not be built: no host/),
        cost_usd: 0,
      });
    expect(attempts).toBe(2);
    expect(i.calls()).toBe(0);
  });

  it("lens_runtime is not read on scan: a leaf never gets a lens tool", async () => {
    const i = inner();
    for (const lens of ["engine"]) {
      const env = envWith(
        underPi(`${FIXTURE}\n[engine]\nruntime = "sdk"\n`, `lens_runtime = "${lens}"`),
      );
      const runner = scanLeafRunner(i.runner, ROOT, env, () => ({
        run: async () => ({ ok: true, output: "sdk", cost_usd: null }),
      }));
      expect(await runner.run(spec, new AbortController().signal)).toMatchObject({
        ok: true,
        output: "sdk",
      });
    }
    expect(i.calls()).toBe(0);
  });
});
