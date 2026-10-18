// The scan sandbox's pi login (src/scanauth.ts over src/piauthcopy.ts): the
// companion's pi home is the only login and the only refresher. A scan reads
// it read-only and, before every case, takes a fresh private copy of its
// auth.json with every refresh token neutralised — the copy the benchmark
// takes (src/bench/auth.ts) — so a scan never refreshes and never writes
// anything the companion reads, and a case is refused before it starts when
// the access token would not outlive it.
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { benchAuthFrom, DISABLED_REFRESH as BENCH_DISABLED } from "../src/bench/auth.js";
import { AuthExpiring, DISABLED_REFRESH, loginSummary } from "../src/piauthcopy.js";
import {
  scanAuthCases,
  scanCasesForEnv,
  SCAN_AUTH_SRC_ENV,
  SCAN_CASE_AUTH_BUDGET_MS,
  syncScanAuth,
} from "../src/scanauth.js";
import { LOGIN_SUMMARY_SCRIPT, SCAN_AUTH_COPY_SCRIPT, SCANBOX } from "../src/scanbox.js";
import type { CaseOutcome, CaseRunner, CaseSpec } from "../src/setup/engine.js";

let dir: string;
let src: string;
let dst: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "qcr-scanauth-"));
  src = join(dir, "src");
  dst = join(dir, "dst");
  mkdirSync(src);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const HOUR = 3_600_000;
function login(access: string, expires: number): string {
  return JSON.stringify({
    "openai-codex": { type: "oauth", access, refresh: "real-refresh", expires, accountId: "acct" },
  });
}

describe("the scan's copy of the companion's login", () => {
  it("is the companion's auth.json with every refresh token neutralised, private to the sandbox", () => {
    const raw = login("tok-A", 10 * HOUR);
    writeFileSync(join(src, "auth.json"), raw);
    const r = syncScanAuth({ srcDir: src, dstDir: dst, needMs: HOUR, now: () => 0 });
    expect(r.expiresAt).toBe(10 * HOUR);
    const copy = JSON.parse(readFileSync(join(dst, "auth.json"), "utf8"));
    expect(copy["openai-codex"]).toEqual({
      type: "oauth",
      access: "tok-A",
      refresh: DISABLED_REFRESH,
      expires: 10 * HOUR,
      accountId: "acct",
    });
    expect(statSync(join(dst, "auth.json")).mode & 0o777).toBe(0o600);
    // The source is never written.
    expect(readFileSync(join(src, "auth.json"), "utf8")).toBe(raw);
  });

  it("is the benchmark's copy, byte for byte", () => {
    writeFileSync(join(src, "auth.json"), login("tok-A", 10 * HOUR));
    syncScanAuth({ srcDir: src, dstDir: dst, needMs: HOUR, now: () => 0 });
    expect(readFileSync(join(dst, "auth.json"), "utf8")).toBe(
      benchAuthFrom(login("tok-A", 10 * HOUR)).json,
    );
    expect(BENCH_DISABLED).toBe(DISABLED_REFRESH);
  });

  it("is refused when the access token would expire inside the case budget — nothing written", () => {
    writeFileSync(join(src, "auth.json"), login("tok-A", HOUR));
    let err: unknown;
    try {
      syncScanAuth({ srcDir: src, dstDir: dst, needMs: 2 * HOUR, now: () => 0 });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(AuthExpiring);
    const msg = (err as Error).message;
    expect(msg).toMatch(/openai-codex/);
    expect(msg).toMatch(/never refreshes/);
    expect(msg).toMatch(/open the companion/i);
    expect(msg).toMatch(/qcr scan login/);
    expect(() => statSync(join(dst, "auth.json"))).toThrow();
  });

  it("is refused when the companion has no login at all", () => {
    expect(() => syncScanAuth({ srcDir: src, dstDir: dst, needMs: HOUR })).toThrow(
      /no pi login.*qcr scan login/,
    );
  });

  it("the login summary names each provider and its expiry, never a token", () => {
    const s = loginSummary(
      JSON.stringify({
        "openai-codex": { type: "oauth", access: "SECRET", refresh: "R", expires: 5 },
        anthropic: { type: "api_key", key: "SECRET2" },
      }),
    );
    expect(s).toEqual({
      "openai-codex": { type: "oauth", expires: 5 },
      anthropic: { type: "api_key", expires: null },
    });
    expect(JSON.stringify(s)).not.toMatch(/SECRET|"R"/);
  });
});

describe("the scan's case runner over the copy", () => {
  const spec = (id: string): CaseSpec => ({ id, agent: "pass-scan", prompt: "p" }) as CaseSpec;
  function inner(seen: string[]): CaseRunner {
    return {
      run: async (): Promise<CaseOutcome> => {
        seen.push(JSON.parse(readFileSync(join(dst, "auth.json"), "utf8"))["openai-codex"].access);
        return { ok: true, output: "done", cost_usd: 0 };
      },
    };
  }

  it("re-takes the copy from the live source before every case, so a companion refresh is picked up", async () => {
    const seen: string[] = [];
    const cases = scanAuthCases(inner(seen), {
      srcDir: src,
      dstDir: dst,
      needMs: HOUR,
      now: () => 0,
      onExpired: () => {},
    });
    writeFileSync(join(src, "auth.json"), login("tok-A", 10 * HOUR));
    await cases.run(spec("c1"), new AbortController().signal);
    writeFileSync(join(src, "auth.json"), login("tok-B", 20 * HOUR));
    await cases.run(spec("c2"), new AbortController().signal);
    expect(seen).toEqual(["tok-A", "tok-B"]);
  });

  it("a token that would not outlive the case: the case never starts, and the run is told to stop", async () => {
    const seen: string[] = [];
    const expired: string[] = [];
    const cases = scanAuthCases(inner(seen), {
      srcDir: src,
      dstDir: dst,
      needMs: SCAN_CASE_AUTH_BUDGET_MS,
      now: () => 0,
      onExpired: (m) => expired.push(m),
    });
    writeFileSync(join(src, "auth.json"), login("tok-A", SCAN_CASE_AUTH_BUDGET_MS - 1));
    const o = await cases.run(spec("c1"), new AbortController().signal);
    expect(seen).toEqual([]);
    expect(o).toMatchObject({ ok: false, cost_usd: 0 });
    expect((o as { reason: string }).reason).toMatch(/qcr scan login/);
    expect(expired).toHaveLength(1);
  });
});

describe("the sandbox's one-shot scripts, run against the built app", () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const built = existsSync(join(root, "dist/src/scanauth.js"));
  const here = (script: string): string => script.split(SCANBOX.app).join(root);

  it.skipIf(!built)("the copy script writes the refresh-disabled copy where the env says", () => {
    writeFileSync(join(src, "auth.json"), login("tok-A", Date.now() + 10 * HOUR));
    execFileSync(process.execPath, ["--input-type=module", "-e", here(SCAN_AUTH_COPY_SCRIPT)], {
      env: { PATH: process.env.PATH ?? "", [SCAN_AUTH_SRC_ENV]: src, PI_CODING_AGENT_DIR: dst },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const copy = JSON.parse(readFileSync(join(dst, "auth.json"), "utf8"));
    expect(copy["openai-codex"].refresh).toBe(DISABLED_REFRESH);
    expect(copy["openai-codex"].access).toBe("tok-A");
  });

  it.skipIf(!built)(
    "the copy script refuses an expiring token, exiting non-zero with the reason",
    () => {
      writeFileSync(join(src, "auth.json"), login("tok-A", Date.now() + 1000));
      let stderr = "";
      try {
        execFileSync(process.execPath, ["--input-type=module", "-e", here(SCAN_AUTH_COPY_SCRIPT)], {
          env: { PATH: process.env.PATH ?? "", [SCAN_AUTH_SRC_ENV]: src, PI_CODING_AGENT_DIR: dst },
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (err) {
        stderr = String((err as { stderr?: Buffer }).stderr ?? "");
      }
      expect(stderr).toMatch(/never refreshes/);
      expect(existsSync(join(dst, "auth.json"))).toBe(false);
    },
  );

  it.skipIf(!built)("the summary script prints providers and expiries, never a token", () => {
    writeFileSync(join(src, "auth.json"), login("SECRET-TOKEN", 42));
    const out = execFileSync(
      process.execPath,
      ["--input-type=module", "-e", here(LOGIN_SUMMARY_SCRIPT), src],
      { env: { PATH: process.env.PATH ?? "" }, encoding: "utf8" },
    );
    expect(JSON.parse(out.trim())).toEqual({ "openai-codex": { type: "oauth", expires: 42 } });
    expect(out).not.toMatch(/SECRET|real-refresh/);
  });
});

describe("which case runner the driver uses", () => {
  const plain: CaseRunner = { run: async () => ({ ok: true, output: "x", cost_usd: 0 }) };

  it("on the host (no source in the env): the plain runner, on the host pi's own login", () => {
    expect(scanCasesForEnv(plain, {}, () => {})).toBe(plain);
  });

  it("in the scan container: the runner over the copy, into the env's agent dir", async () => {
    writeFileSync(join(src, "auth.json"), login("tok-A", Date.now() + 10 * HOUR));
    const cases = scanCasesForEnv(
      plain,
      { [SCAN_AUTH_SRC_ENV]: src, PI_CODING_AGENT_DIR: dst },
      () => {},
    );
    expect(cases).not.toBe(plain);
    await cases.run({ id: "c1" } as CaseSpec, new AbortController().signal);
    expect(JSON.parse(readFileSync(join(dst, "auth.json"), "utf8"))["openai-codex"].refresh).toBe(
      DISABLED_REFRESH,
    );
  });
});

it("stops a borrowed-login case before its admission budget ends and retains spent cost", async () => {
  vi.useFakeTimers();
  try {
    writeFileSync(join(src, "auth.json"), login("tok-A", 10 * HOUR));
    let observed: AbortSignal | undefined;
    const cases = scanAuthCases({ run: async (_spec: string, signal: AbortSignal) => {
      observed = signal;
      return new Promise<CaseOutcome>((resolve) => signal.addEventListener("abort", () =>
        resolve({ ok: false, reason: "stopped", cost_usd: 0.25 }), { once: true }));
    } }, { srcDir: src, dstDir: dst, needMs: 60_000, now: () => 0, onExpired: () => {} });
    const result = cases.run("fixture", new AbortController().signal);
    await vi.advanceTimersByTimeAsync(55_000);
    expect(observed?.aborted).toBe(true);
    expect(await result).toMatchObject({ ok: false, cost_usd: 0.25 });
  } finally { vi.useRealTimers(); }
});
