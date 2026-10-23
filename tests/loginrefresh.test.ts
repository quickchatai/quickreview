// The bot login's single refresher (P8.22, the VM-only exception to D5), against
// a fake OAuth endpoint: no pi, no model, no network beyond loopback. What is
// pinned:
//   - it refreshes a token inside pi's window plus the margin, and leaves one
//     outside alone; the write is atomic, 0660, in the login group;
//   - the single-instance lock is a separate file: a second refresher is
//     refused at start, and still refused AFTER a refresh replaced auth.json;
//   - borrowers copy without a lock while the refresher holds it, their copies
//     carry the disabled refresh token, and a reader racing a refresh always
//     parses a whole file;
//   - a failure raises exactly one `login_refresh_failed` anomaly per episode;
//   - a pause keeps the lock and stops the refresh; a stale pause file lifts
//     after 15 minutes (fake clock);
//   - only src/loginrefresh and the entrypoint's login mode write the pihome's
//     auth.json, and the daemon imports neither pi nor src/engine/.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DISABLED_REFRESH,
  copyPiAuth,
  engineCredentials,
  readOwnerAuth,
} from "@quickchatai/pi-quickreview/src/engine/auth.js";
import { LoginLockHeld, acquireLoginLock } from "../src/loginrefresh/lock.js";
import {
  AUTH_FILE,
  LOCK_FILE,
  LoginRefresher,
  PAUSE_FILE,
  PAUSE_STALE_MS,
  PI_REFRESH_WINDOW_MS,
  STATUS_FILE,
  redactError,
  type RefresherDeps,
} from "../src/loginrefresh/refresher.js";
import { OAUTH_LOADERS, piOAuthRefresh } from "../src/loginrefresh/pirefresh.js";
import {
  LOGIN_STATUS_POLL_MS,
  LoginRefreshSupervisor,
  loginRefreshMain,
} from "../src/loginrefresh/supervisor.js";
import type { LoginRefreshFileStatus } from "../src/loginrefresh/types.js";
import { parseConfig } from "../src/config.js";
import { StateStore } from "../src/state.js";
import {
  DAEMON_ROOTS,
  daemonReachesEngine,
  tsFilesUnder,
  stripComments,
} from "./helpers/engine-fences.js";
import {
  SANDBOX_AUTH_WRITERS,
  isSandboxAuthWriter,
  authJsonWriters,
  daemonReachedLoginRefresh,
} from "./helpers/loginrefresh-fence.js";
import { fakeOAuth, type FakeOAuth } from "./helpers/fake-oauth.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MARGIN_MS = 90 * 60_000;
const HOUR = 3_600_000;

let dirs: string[] = [];
const cleanups: Array<() => Promise<void>> = [];
beforeEach(() => {
  dirs = [];
});
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function agentDir(): string {
  const d = mkdtempSync(join(tmpdir(), "qcr-loginrefresh-"));
  dirs.push(d);
  return d;
}

/** A fake clock the refresher and the fake endpoint share. */
function clock(start = Date.parse("2026-10-20T08:00:00Z")): {
  now: () => number;
  advance: (ms: number) => void;
} {
  let t = start;
  return { now: () => t, advance: (ms) => (t += ms) };
}

/** The pause file a login writes, stamped with the fake clock's time. */
function writePause(r: { dir: string; clk: { now: () => number } }): string {
  const pause = join(r.dir, PAUSE_FILE);
  writeFileSync(pause, "");
  const stamp = new Date(r.clk.now());
  utimesSync(pause, stamp, stamp);
  return pause;
}

function writeLogin(dir: string, o: { expires: number; refresh?: string; access?: string }): void {
  writeFileSync(
    join(dir, AUTH_FILE),
    JSON.stringify({
      "openai-codex": {
        type: "oauth",
        access: o.access ?? "access-1",
        refresh: o.refresh ?? "refresh-1",
        expires: o.expires,
        accountId: "acct-1",
      },
      other: { type: "api_key", key: "k" },
    }) + "\n",
    { mode: 0o600 },
  );
}

const readLogin = (
  dir: string,
): { "openai-codex": { access: string; refresh: string; expires: number; accountId: string } } =>
  JSON.parse(readFileSync(join(dir, AUTH_FILE), "utf8"));
const readStatus = (dir: string): LoginRefreshFileStatus =>
  JSON.parse(readFileSync(join(dir, STATUS_FILE), "utf8"));

interface Rig {
  dir: string;
  clk: ReturnType<typeof clock>;
  oauth: FakeOAuth;
  failures: string[];
  logs: string[];
  deps: RefresherDeps;
}

async function rig(o: { gid?: number } = {}): Promise<Rig> {
  const dir = agentDir();
  const clk = clock();
  const oauth = await fakeOAuth();
  cleanups.push(() => oauth.close());
  const failures: string[] = [];
  const logs: string[] = [];
  const deps: RefresherDeps = {
    agentDir: dir,
    refresh: oauth.refresh(clk.now),
    marginMs: MARGIN_MS,
    now: clk.now,
    log: (m) => logs.push(m),
    onFailure: (m) => failures.push(m),
    gid: o.gid,
  };
  return { dir, clk, oauth, failures, logs, deps };
}

async function start(r: Rig, deps: Partial<RefresherDeps> = {}): Promise<LoginRefresher> {
  const refresher = await LoginRefresher.start({ ...r.deps, ...deps }, { autoRun: false });
  cleanups.push(() => refresher.stop());
  return refresher;
}

describe("the refresh", () => {
  it("leaves a token that is outside the window plus the margin alone", async () => {
    const r = await rig();
    writeLogin(r.dir, { expires: r.clk.now() + PI_REFRESH_WINDOW_MS + MARGIN_MS + 60_000 });
    await start(r);
    expect(r.oauth.grants()).toBe(0);
    expect(readLogin(r.dir)["openai-codex"].refresh).toBe("refresh-1");
    expect(readStatus(r.dir).last_refresh).toBeNull();
  });

  it("refreshes a token before it reaches pi's window plus the margin, keeping every other field", async () => {
    const r = await rig();
    // 95 minutes of life left: inside 5 min + 90 min
    writeLogin(r.dir, { expires: r.clk.now() + PI_REFRESH_WINDOW_MS + MARGIN_MS - 60_000 });
    await start(r);
    expect(r.oauth.grants()).toBe(1);
    const cred = readLogin(r.dir)["openai-codex"];
    expect(cred).toMatchObject({ access: "access-2", refresh: "refresh-2", accountId: "acct-1" });
    expect(cred.expires).toBe(r.clk.now() + 36_000_000);
    expect(JSON.parse(readFileSync(join(r.dir, AUTH_FILE), "utf8")).other).toEqual({
      type: "api_key",
      key: "k",
    });
    const st = readStatus(r.dir);
    expect(st.last_refresh).toBe(new Date(r.clk.now()).toISOString());
    expect(st.expires_at).toBe(new Date(cred.expires).toISOString());
    expect(st.last_error).toBeNull();
    expect(st.paused).toBe(false);
  });

  it("checks every 10 minutes: a token that crosses the line between checks is refreshed at the next one", async () => {
    const r = await rig();
    writeLogin(r.dir, { expires: r.clk.now() + PI_REFRESH_WINDOW_MS + MARGIN_MS + 5 * 60_000 });
    const refresher = await start(r);
    expect(r.oauth.grants()).toBe(0);
    r.clk.advance(9 * 60_000);
    await refresher.tick();
    expect(r.oauth.grants()).toBe(0); // not due: the 10-minute check has not come round
    r.clk.advance(60_000);
    await refresher.tick();
    expect(r.oauth.grants()).toBe(1);
  });

  it("publishes expires_at, last_refresh, last_error and paused into its status file", async () => {
    const r = await rig();
    writeLogin(r.dir, { expires: r.clk.now() + 24 * HOUR });
    await start(r);
    expect(Object.keys(readStatus(r.dir)).sort()).toEqual(
      [
        "checked_at",
        "error_since",
        "expires_at",
        "last_error",
        "last_refresh",
        "paused",
        "pid",
        "provider",
        "started_at",
      ].sort(),
    );
    expect(readStatus(r.dir).provider).toBe("openai-codex");
  });

  it("writes atomically: a new inode, mode 0660, the login group", async () => {
    // a group other than the primary one, when this uid has one
    const primary = process.getegid?.();
    const gid = (process.getgroups?.() ?? []).find((g) => g !== primary) ?? primary;
    const r = await rig({ gid });
    writeLogin(r.dir, { expires: r.clk.now() + HOUR });
    const before = statSync(join(r.dir, AUTH_FILE));
    expect(before.mode & 0o777).toBe(0o600); // pi's own earlier mode
    await start(r);
    const after = statSync(join(r.dir, AUTH_FILE));
    expect(after.ino).not.toBe(before.ino);
    expect(after.mode & 0o777).toBe(0o660);
    expect(after.gid).toBe(gid);
    expect(statSync(join(r.dir, STATUS_FILE)).mode & 0o777).toBe(0o660);
    // no tmp file is left beside it
    expect(spawnSync("ls", ["-A", r.dir], { encoding: "utf8" }).stdout).not.toContain(".tmp");
  });

  it("a rotated refresh token is the one the next refresh uses (the fake endpoint refuses a stale one)", async () => {
    const r = await rig();
    writeLogin(r.dir, { expires: r.clk.now() + HOUR });
    const refresher = await start(r);
    expect(readLogin(r.dir)["openai-codex"].refresh).toBe("refresh-2");
    // 11 h later the 10 h token is due again
    r.clk.advance(11 * HOUR);
    writeLogin(r.dir, { expires: r.clk.now() + HOUR, refresh: r.oauth.current() });
    await refresher.tick();
    expect(r.oauth.grants()).toBe(2);
    expect(r.failures).toEqual([]);
  });

  it("stops publishing an expiry once auth.json is gone", async () => {
    const r = await rig();
    writeLogin(r.dir, { expires: r.clk.now() + 24 * HOUR });
    const refresher = await start(r);
    expect(readStatus(r.dir).expires_at).not.toBeNull();
    rmSync(join(r.dir, AUTH_FILE));
    r.clk.advance(10 * 60_000);
    await refresher.tick();
    expect(readStatus(r.dir)).toMatchObject({ expires_at: null, provider: null });
  });

  it("does nothing, and says nothing wrong, before the first login", async () => {
    const r = await rig();
    await start(r);
    expect(existsSync(join(r.dir, AUTH_FILE))).toBe(false);
    expect(readStatus(r.dir)).toMatchObject({ expires_at: null, last_error: null });
    expect(r.failures).toEqual([]);
  });
});

describe("the single-instance lock", () => {
  it("lives on a separate file that is created once and never replaced", async () => {
    const r = await rig();
    writeLogin(r.dir, { expires: r.clk.now() + HOUR });
    await start(r);
    const lock = join(r.dir, LOCK_FILE);
    expect(statSync(lock).mode & 0o777).toBe(0o660);
    const ino = statSync(lock).ino;
    // a refresh replaces auth.json, never the lock file
    r.clk.advance(11 * HOUR);
    expect(statSync(lock).ino).toBe(ino);
  });

  it("refuses a second refresher at start", async () => {
    const r = await rig();
    writeLogin(r.dir, { expires: r.clk.now() + 24 * HOUR });
    await start(r);
    await expect(LoginRefresher.start(r.deps, { autoRun: false })).rejects.toBeInstanceOf(
      LoginLockHeld,
    );
  });

  it("still refuses a second refresher started AFTER a refresh made auth.json a new inode", async () => {
    const r = await rig();
    writeLogin(r.dir, { expires: r.clk.now() + HOUR });
    const inoBefore = statSync(join(r.dir, AUTH_FILE)).ino;
    await start(r);
    expect(r.oauth.grants()).toBe(1);
    expect(statSync(join(r.dir, AUTH_FILE)).ino).not.toBe(inoBefore);
    await expect(LoginRefresher.start(r.deps, { autoRun: false })).rejects.toBeInstanceOf(
      LoginLockHeld,
    );
    // and the first one was not disturbed: nothing was rotated underneath it
    expect(r.oauth.grants()).toBe(1);
    expect(r.failures).toEqual([]);
  });

  it("is free again once the refresher stops, and when it is killed", async () => {
    const dir = agentDir();
    const lock = await acquireLoginLock(join(dir, LOCK_FILE));
    await expect(acquireLoginLock(join(dir, LOCK_FILE))).rejects.toBeInstanceOf(LoginLockHeld);
    await lock.release();
    const again = await acquireLoginLock(join(dir, LOCK_FILE));
    await again.release();
  });

  it("is dropped by the kernel when the holder process is killed without a release", async () => {
    const dir = agentDir();
    const path = join(dir, LOCK_FILE);
    const holder = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `const { acquireLoginLock } = await import(${JSON.stringify(join(root, "src/loginrefresh/lock.ts"))});` +
          `await acquireLoginLock(${JSON.stringify(path)}); console.log("held"); setInterval(() => {}, 1e6);`,
      ],
      { stdio: ["ignore", "pipe", "inherit"] },
    );
    await new Promise<void>((res, rej) => {
      holder.stdout.once("data", () => res());
      holder.once("exit", (c) => rej(new Error(`holder exited ${c}`)));
    });
    await expect(acquireLoginLock(path)).rejects.toBeInstanceOf(LoginLockHeld);
    holder.kill("SIGKILL");
    await new Promise((r) => holder.once("exit", r));
    // the helper's pipe closed with it: the lock is free within a moment
    let again: Awaited<ReturnType<typeof acquireLoginLock>> | undefined;
    const deadline = Date.now() + 10_000;
    while (!again) {
      try {
        again = await acquireLoginLock(path);
      } catch (e) {
        if (Date.now() > deadline)
          throw new Error("timed out waiting for the lock to be free again", { cause: e });
        await new Promise((r) => setTimeout(r, 50));
      }
    }
    expect(again).toBeDefined();
    await again!.release();
  });
});

describe("borrowers", () => {
  it("copy auth.json while the refresher holds its lock, without blocking, with the refresh token disabled", async () => {
    const r = await rig();
    writeLogin(r.dir, { expires: r.clk.now() + 24 * HOUR });
    await start(r);
    // the lock is held right now
    await expect(acquireLoginLock(join(r.dir, LOCK_FILE))).rejects.toBeInstanceOf(LoginLockHeld);
    const t0 = Date.now();
    const dst = agentDir();
    const copy = copyPiAuth({
      srcDir: r.dir,
      dstDir: dst,
      needMs: HOUR,
      now: r.clk.now,
      words: { missing: () => "missing", expiring: () => "expiring" },
    });
    const creds = engineCredentials({ srcDir: r.dir, needMs: HOUR, now: r.clk.now });
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(copy.expiresAt).toBe(r.clk.now() + 24 * HOUR);
    const copied = JSON.parse(readFileSync(join(dst, AUTH_FILE), "utf8"));
    expect(copied["openai-codex"].refresh).toBe(DISABLED_REFRESH);
    expect(copied["openai-codex"].access).toBe("access-1");
    expect((await creds.credentials.read("openai-codex")) as { refresh: string }).toMatchObject({
      refresh: DISABLED_REFRESH,
    });
    // the owner's file keeps the real one
    expect(readLogin(r.dir)["openai-codex"].refresh).toBe("refresh-1");
  });

  it("a reader racing a refresh always parses a whole file", async () => {
    const dir = agentDir();
    const target = join(dir, AUTH_FILE);
    const big = (n: number): string =>
      JSON.stringify({
        "openai-codex": {
          type: "oauth",
          access: `a${n}`.padEnd(8000, "x"),
          refresh: `r${n}`,
          expires: n,
        },
      }) + "\n";
    writeFileSync(target, big(0));
    // a separate process replaces the file 400 times through atomic.ts itself
    const writer = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `const { writeFileAtomic } = await import(${JSON.stringify(join(root, "src/loginrefresh/atomic.ts"))});` +
          `const big = (n) => JSON.stringify({ "openai-codex": { type: "oauth", access: ("a" + n).padEnd(8000, "x"), refresh: "r" + n, expires: n } }) + "\\n";` +
          `for (let n = 1; n <= 400; n++) writeFileAtomic(${JSON.stringify(target)}, big(n));`,
      ],
      { stdio: ["ignore", "inherit", "inherit"] },
    );
    let done = false;
    writer.once("exit", () => (done = true));
    let reads = 0;
    let lastN = 0;
    while (!done || reads < 50) {
      const parsed = JSON.parse(readFileSync(target, "utf8")) as Record<
        string,
        { expires: number }
      >;
      const n = parsed["openai-codex"]!.expires;
      expect(n).toBeGreaterThanOrEqual(lastN); // never an older whole file after a newer one
      lastN = n;
      reads++;
      if (reads % 20 === 0) await new Promise((r) => setImmediate(r));
    }
    expect(lastN).toBeGreaterThan(0);
  });

  it("retries a copy that does not parse (a login rewriting the file) until it does", async () => {
    const dir = agentDir();
    const target = join(dir, AUTH_FILE);
    writeFileSync(target, '{"openai-codex": {"type": "oau');
    const fixer = spawn(
      process.execPath,
      [
        "-e",
        `setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(target)}, '{"x":{"type":"api_key"}}'), 350);`,
      ],
      { stdio: "ignore" },
    );
    cleanups.push(async () => void fixer.kill());
    const raw = readOwnerAuth(target);
    expect(JSON.parse(raw)).toEqual({ x: { type: "api_key" } });
  });

  it("gives up on a file that stays unparseable, with the parse error", () => {
    const dir = agentDir();
    const target = join(dir, AUTH_FILE);
    writeFileSync(target, "{ not json");
    expect(() => readOwnerAuth(target, { tries: 2, delayMs: 5 })).toThrow(SyntaxError);
  });
});

describe("failures", () => {
  it("raises exactly one anomaly per failure episode, and another after a recovery", async () => {
    const r = await rig();
    writeLogin(r.dir, { expires: r.clk.now() + HOUR });
    r.oauth.failWith(500);
    const refresher = await start(r);
    expect(r.failures).toHaveLength(1);
    expect(r.failures[0]).toContain("openai-codex");
    for (let i = 0; i < 4; i++) {
      r.clk.advance(10 * 60_000);
      await refresher.tick();
    }
    expect(r.failures).toHaveLength(1); // the same episode: still one
    const st = readStatus(r.dir);
    expect(st.last_error).toContain("500");
    expect(st.error_since).not.toBeNull();
    // the endpoint comes back: the episode ends
    r.oauth.failWith(null);
    r.clk.advance(10 * 60_000);
    await refresher.tick();
    expect(readStatus(r.dir)).toMatchObject({ last_error: null, error_since: null });
    // and a new failure is a new episode
    r.clk.advance(11 * HOUR);
    r.oauth.failWith(502);
    await refresher.tick();
    expect(r.failures).toHaveLength(2);
  });

  it("never publishes a token in an error", () => {
    const secret = "sk-" + "a1B2c3D4".repeat(8);
    expect(
      redactError(new Error(`bad response ${JSON.stringify({ access_token: secret })}`)),
    ).not.toContain(secret);
  });

  it("keeps a rotated refresh token it could not write, and writes it at the next check", async () => {
    const r = await rig();
    writeLogin(r.dir, { expires: r.clk.now() + HOUR });
    // the directory refuses the tmp file for the first write (the lock file exists already)
    writeFileSync(join(r.dir, LOCK_FILE), "", { mode: 0o660 });
    chmodSync(r.dir, 0o500);
    let refresher: LoginRefresher;
    try {
      refresher = await LoginRefresher.start(r.deps, { autoRun: false });
    } finally {
      chmodSync(r.dir, 0o700);
    }
    cleanups.push(() => refresher.stop());
    if (r.failures.length === 0) return; // running as root: the directory mode does not bind
    expect(r.oauth.grants()).toBe(1);
    expect(readLogin(r.dir)["openai-codex"].refresh).toBe("refresh-1"); // not on disk yet
    r.clk.advance(10 * 60_000);
    await refresher.tick();
    expect(readLogin(r.dir)["openai-codex"].refresh).toBe("refresh-2");
    expect(r.oauth.grants()).toBe(1); // written, not refreshed twice
  });
});

describe("the pause", () => {
  it("stops refreshing and writing, keeps the lock, and resumes on whatever file is there after", async () => {
    const r = await rig();
    writeLogin(r.dir, { expires: r.clk.now() + 24 * HOUR });
    const refresher = await start(r);
    const pause = writePause(r);
    // a login is under way: the token is already inside the window, but nothing happens
    writeLogin(r.dir, {
      expires: r.clk.now() + HOUR,
      refresh: "login-refresh",
      access: "login-access",
    });
    const inoDuring = statSync(join(r.dir, AUTH_FILE)).ino;
    r.clk.advance(11 * 60_000); // past the 10-minute check, inside the 15-minute stale bound
    await refresher.tick();
    expect(readStatus(r.dir).paused).toBe(true);
    expect(r.oauth.grants()).toBe(0);
    expect(statSync(join(r.dir, AUTH_FILE)).ino).toBe(inoDuring);
    await expect(acquireLoginLock(join(r.dir, LOCK_FILE))).rejects.toBeInstanceOf(LoginLockHeld);
    // a second refresher cannot start during the login either
    await expect(LoginRefresher.start(r.deps, { autoRun: false })).rejects.toBeInstanceOf(
      LoginLockHeld,
    );
    // the login ends
    rmSync(pause);
    await refresher.tick();
    expect(readStatus(r.dir).paused).toBe(false);
  });

  it("a login made during a pause wins over a refreshed file that could not be written before it", async () => {
    const r = await rig();
    writeLogin(r.dir, { expires: r.clk.now() + HOUR });
    writeFileSync(join(r.dir, LOCK_FILE), "", { mode: 0o660 });
    chmodSync(r.dir, 0o500);
    let refresher: LoginRefresher;
    try {
      refresher = await LoginRefresher.start(r.deps, { autoRun: false });
    } finally {
      chmodSync(r.dir, 0o700);
    }
    cleanups.push(() => refresher.stop());
    if (r.failures.length === 0) return; // running as root: the directory mode does not bind
    const pause = writePause(r);
    await refresher.tick();
    expect(readStatus(r.dir).paused).toBe(true);
    writeLogin(r.dir, {
      expires: r.clk.now() + 24 * HOUR,
      refresh: "login-refresh",
      access: "login-access",
    });
    rmSync(pause);
    r.clk.advance(10 * 60_000);
    await refresher.tick();
    expect(readLogin(r.dir)["openai-codex"].refresh).toBe("login-refresh");
  });

  it("re-reads the new login after the pause and refreshes it with the NEW refresh token", async () => {
    const r = await rig();
    const seen: string[] = [];
    const base = r.oauth.refresh(r.clk.now);
    writeLogin(r.dir, { expires: r.clk.now() + 24 * HOUR });
    const refresher = await start(r, {
      refresh: async (p, c, s) => {
        seen.push(c.refresh);
        return base(p, { ...c, refresh: r.oauth.current() }, s);
      },
    });
    const pause = writePause(r);
    await refresher.tick();
    expect(readStatus(r.dir).paused).toBe(true);
    writeLogin(r.dir, {
      expires: r.clk.now() + HOUR,
      refresh: "login-refresh",
      access: "login-access",
    });
    rmSync(pause);
    await refresher.tick(); // resumes and looks at once
    expect(seen).toEqual(["login-refresh"]);
    expect(readLogin(r.dir)["openai-codex"].access).toBe("access-2");
    expect(readStatus(r.dir).paused).toBe(false);
  });

  it("lifts a pause file left behind after 15 minutes (fake clock)", async () => {
    const r = await rig();
    writeLogin(r.dir, { expires: r.clk.now() + HOUR });
    r.oauth.failWith(500); // keep the start from consuming the grant
    const refresher = await start(r);
    r.oauth.failWith(null);
    const pause = writePause(r);
    r.clk.advance(14 * 60_000);
    await refresher.tick();
    expect(readStatus(r.dir).paused).toBe(true);
    expect(existsSync(pause)).toBe(true);
    r.clk.advance(60_000 + 1);
    expect(PAUSE_STALE_MS).toBe(15 * 60_000);
    await refresher.tick();
    expect(existsSync(pause)).toBe(false);
    expect(readStatus(r.dir).paused).toBe(false);
    expect(r.oauth.grants()).toBe(1); // it resumed and refreshed
    expect(r.logs.some((l) => l.includes("lifted a pause file"))).toBe(true);
  });
});

describe("pi-ai's own refresh (the deep import)", () => {
  it("every provider id it maps has a loader pi-ai 1.3.0 exports", async () => {
    const { piAiDir } = await import("../src/loginrefresh/pirefresh.js");
    const mod = (await import(join(piAiDir(), "dist", "auth", "oauth", "load.js"))) as Record<
      string,
      unknown
    >;
    for (const loader of Object.values(OAUTH_LOADERS))
      expect(typeof mod[loader], loader).toBe("function");
  });

  it("refreshes the codex login through pi-ai against a stubbed token endpoint, and nothing leaves the process", async () => {
    const realFetch = globalThis.fetch;
    const calls: Array<{ url: string; body: string }> = [];
    // pi-ai reads the account id out of the access token's claims
    const jwt = [
      "h",
      btoa(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acct-9" } })),
      "s",
    ].join(".");
    globalThis.fetch = (async (url: unknown, init?: { body?: unknown }) => {
      calls.push({ url: String(url), body: String(init?.body) });
      return new Response(
        JSON.stringify({ access_token: jwt, refresh_token: "R2", expires_in: 3600 }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;
    try {
      const fresh = await piOAuthRefresh(
        "openai-codex",
        { type: "oauth", access: "A1", refresh: "R1", expires: 1 },
        AbortSignal.timeout(5_000),
      );
      expect(fresh).toMatchObject({ access: jwt, refresh: "R2", accountId: "acct-9" });
      expect(calls).toHaveLength(1);
      expect(calls[0]!.url).toContain("/oauth/token");
      expect(calls[0]!.body).toContain("refresh_token=R1");
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("an unknown provider is a failure, not a silent skip", async () => {
    await expect(
      piOAuthRefresh(
        "nope",
        { type: "oauth", access: "a", refresh: "r", expires: 1 },
        AbortSignal.timeout(1_000),
      ),
    ).rejects.toThrow(/no pi-ai OAuth flow/);
  });
});

// ---- the daemon's side ---------------------------------------------------------------

describe("the supervisor", () => {
  class FakeChild {
    pid = 4242;
    handlers: Record<string, Array<(...a: never[]) => void>> = {};
    stdout = { on: () => undefined };
    stderr = { on: () => undefined };
    killed: string[] = [];
    on(ev: string, cb: (...a: never[]) => void): this {
      (this.handlers[ev] ??= []).push(cb);
      return this;
    }
    emit(ev: string, ...a: unknown[]): void {
      for (const h of this.handlers[ev] ?? []) (h as (...x: unknown[]) => void)(...a);
    }
    kill(sig?: string): boolean {
      this.killed.push(sig ?? "SIGTERM");
      this.emit("exit", null, sig ?? "SIGTERM");
      return true;
    }
  }

  function supRig(
    over: { exists?: boolean; file?: () => string | null; raise?: (d: string) => void } = {},
  ) {
    const spawned: Array<{ cmd: string; args: string[]; env: NodeJS.ProcessEnv }> = [];
    const children: FakeChild[] = [];
    const timers: Array<{ fn: () => void; ms: number; live: boolean }> = [];
    const anomalies: string[] = [];
    const logs: string[] = [];
    let fileText: string | null = null;
    const sup = new LoginRefreshSupervisor({
      repoRoot: "/opt/qcr",
      agentDir: "/home/qcr/.pi/agent",
      marginMin: 90,
      gid: 4747,
      log: (m) => logs.push(m),
      raiseAnomaly: (d) => {
        over.raise?.(d);
        anomalies.push(d);
      },
      exists: () => over.exists ?? true,
      readStatusFile: over.file ?? (() => fileText),
      spawn: ((cmd: string, args: string[], opts: { env: NodeJS.ProcessEnv }) => {
        spawned.push({ cmd, args, env: opts.env });
        const c = new FakeChild();
        children.push(c);
        return c as never;
      }) as never,
      schedule: (fn, ms) => {
        const t = { fn, ms, live: true };
        timers.push(t);
        return () => {
          t.live = false;
        };
      },
    });
    return {
      sup,
      spawned,
      children,
      timers,
      anomalies,
      logs,
      setFile: (f: Partial<LoginRefreshFileStatus> | null) => {
        fileText =
          f === null
            ? null
            : JSON.stringify({
                pid: 4242,
                paused: false,
                error_since: null,
                last_error: null,
                expires_at: null,
                ...f,
              });
      },
      fire: (ms: number) => {
        const t = timers.find((x) => x.live && x.ms === ms);
        if (!t) throw new Error(`no timer at ${ms}`);
        t.live = false;
        t.fn();
      },
    };
  }

  it("spawns main.js by path under the node that runs the daemon, with its settings in env", () => {
    const s = supRig();
    s.sup.start();
    expect(s.spawned).toHaveLength(1);
    expect(s.spawned[0]!.cmd).toBe(process.execPath);
    expect(s.spawned[0]!.args).toEqual([loginRefreshMain("/opt/qcr")]);
    expect(loginRefreshMain("/opt/qcr")).toBe("/opt/qcr/dist/src/loginrefresh/main.js");
    expect(s.spawned[0]!.env).toMatchObject({
      QCR_LOGIN_AGENT_DIR: "/home/qcr/.pi/agent",
      QCR_LOGIN_MARGIN_MIN: "90",
      QCR_LOGIN_GID: "4747",
    });
    expect(s.sup.status()).toMatchObject({ state: "supervised", running: true, restarts: 0 });
  });

  it("is unavailable, once and without a respawn, when the build has no main.js", () => {
    const s = supRig({ exists: false });
    s.sup.start();
    expect(s.spawned).toHaveLength(0);
    expect(s.sup.status()).toMatchObject({ state: "unavailable", running: false });
    expect(s.sup.status().reason).toContain("main.js");
  });

  it("respawns a crash, and a refused lock (exit 75), on its ladder, forever", () => {
    const s = supRig();
    s.sup.start();
    s.children[0]!.emit("exit", 1, null);
    expect(s.sup.status()).toMatchObject({ running: false, restarts: 1, last_exit: { code: 1 } });
    s.fire(2_000);
    expect(s.spawned).toHaveLength(2);
    s.children[1]!.emit("exit", 75, null);
    expect(s.logs.some((l) => l.includes("holds the lock"))).toBe(true);
    s.fire(10_000);
    s.children[2]!.emit("exit", 75, null);
    s.fire(60_000);
    s.children[3]!.emit("exit", 75, null);
    s.fire(60_000); // the last rung repeats
    expect(s.spawned).toHaveLength(5);
  });

  it("raises one login_refresh_failed per episode from the file the refresher publishes", () => {
    const s = supRig();
    s.sup.start();
    s.setFile({ error_since: "2026-10-20T08:00:00Z", last_error: "openai-codex: 500" });
    for (let i = 0; i < 3; i++) s.fire(LOGIN_STATUS_POLL_MS);
    expect(s.anomalies).toHaveLength(1);
    expect(s.anomalies[0]).toContain("openai-codex: 500");
    expect(s.sup.status().login?.last_error).toBe("openai-codex: 500");
    s.setFile({}); // recovered
    s.fire(LOGIN_STATUS_POLL_MS);
    s.setFile({ error_since: "2026-10-21T08:00:00Z", last_error: "again" });
    s.fire(LOGIN_STATUS_POLL_MS);
    expect(s.anomalies).toHaveLength(2);
  });

  it("a failed anomaly write does not consume the episode: the next poll raises it again", () => {
    let failNext = true;
    const s = supRig({
      raise: () => {
        if (failNext) {
          failNext = false;
          throw new Error("db locked");
        }
      },
    });
    s.sup.start();
    s.setFile({ error_since: "2026-10-20T08:00:00Z", last_error: "boom" });
    s.fire(LOGIN_STATUS_POLL_MS);
    expect(s.anomalies).toHaveLength(0); // the write failed
    s.fire(LOGIN_STATUS_POLL_MS);
    expect(s.anomalies).toHaveLength(1); // raised again, not skipped
    s.fire(LOGIN_STATUS_POLL_MS);
    expect(s.anomalies).toHaveLength(1); // and once raised, not again
  });

  it("the anomaly reaches the store as one login_refresh_failed event, a wake kind", () => {
    const store = new StateStore(":memory:");
    const sup = new LoginRefreshSupervisor({
      repoRoot: "/opt/qcr",
      agentDir: "/x",
      marginMin: 90,
      log: () => undefined,
      raiseAnomaly: (d) => store.logAnomaly("login_refresh_failed", null, null, d),
      spawn: (() => ({
        pid: 4242,
        on: () => undefined,
        stdout: { on: () => undefined },
        stderr: { on: () => undefined },
      })) as never,
      schedule: () => () => undefined,
      exists: () => true,
      readStatusFile: () =>
        JSON.stringify({ pid: 4242, error_since: "t", last_error: "boom", paused: false }),
    });
    sup.start();
    sup.readFile();
    sup.readFile();
    const rows = store.db
      .prepare("SELECT kind, payload FROM events WHERE kind = 'anomaly'")
      .all() as Array<{ payload: string }>;
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]!.payload)).toMatchObject({ kind: "login_refresh_failed" });
  });

  it("holds spawns while the refresher reports paused, and releases them when it resumes", async () => {
    const s = supRig();
    s.sup.start();
    s.setFile({ paused: true });
    s.fire(LOGIN_STATUS_POLL_MS);
    expect(s.sup.paused()).toBe(true);
    const held = s.sup.whenResumed(120_000);
    let settled: boolean | undefined;
    void held.then((v) => (settled = v));
    await Promise.resolve();
    expect(settled).toBeUndefined();
    s.setFile({ paused: false });
    s.fire(LOGIN_STATUS_POLL_MS);
    expect(await held).toBe(true);
    expect(await s.sup.whenResumed(1)).toBe(true); // not paused: at once
  });

  it("gives up the hold after its bound", async () => {
    const s = supRig();
    s.sup.start();
    s.setFile({ paused: true });
    s.fire(LOGIN_STATUS_POLL_MS);
    const held = s.sup.whenResumed(120_000);
    s.fire(120_000);
    expect(await held).toBe(false);
  });

  it("ignores a leftover file while no refresher runs, or one from another pid", async () => {
    const s = supRig();
    s.setFile({ paused: true, error_since: "2026-10-20T08:00:00Z", last_error: "old" });
    s.sup.readFile(); // before start(): no child, so the file is not its own
    expect(s.sup.paused()).toBe(false);
    expect(s.anomalies).toHaveLength(0);
    s.sup.start();
    s.setFile({ pid: 1, paused: true, error_since: "2026-10-20T08:00:00Z", last_error: "old" });
    s.fire(LOGIN_STATUS_POLL_MS);
    expect(s.sup.paused()).toBe(false); // a previous process's file
    expect(s.anomalies).toHaveLength(0);
    s.setFile({ paused: true }); // the running refresher's own
    s.fire(LOGIN_STATUS_POLL_MS);
    expect(s.sup.paused()).toBe(true);
  });

  it("a refresher that dies while paused releases the hold at once", async () => {
    const s = supRig();
    s.sup.start();
    s.setFile({ paused: true });
    s.fire(LOGIN_STATUS_POLL_MS);
    const held = s.sup.whenResumed(120_000);
    s.children[0]!.emit("exit", 1, null);
    expect(await held).toBe(true);
    expect(s.sup.paused()).toBe(false);
  });

  it("stop() ends the child with SIGTERM", async () => {
    const s = supRig();
    s.sup.start();
    await s.sup.stop();
    expect(s.children[0]!.killed).toEqual(["SIGTERM"]);
  });
});

describe("config", () => {
  const base = readFileSync(join(root, "config.example.toml"), "utf8");
  it("is off by default, margin 90 minutes", () => {
    expect(parseConfig(base).login_refresh).toEqual({ enabled: false, margin_min: 90 });
  });
  it("a margin that does not outlast the longest worker cap refuses to load", () => {
    const toml = base
      .replace("enabled = false\nmargin_min", "enabled = true\nmargin_min")
      .replace("margin_min = 90 ", "margin_min = 75 ");
    expect(() => parseConfig(toml)).toThrow(
      /margin_min \(75\) must exceed \[daemon\] round_deadline_min \(75\)/,
    );
  });
  it("a disabled section is not held to the margin rule", () => {
    const toml = base.replace("round_deadline_min = 75", "round_deadline_min = 120");
    expect(toml).not.toBe(base);
    expect(parseConfig(toml).login_refresh.enabled).toBe(false);
    expect(() =>
      parseConfig(toml.replace("enabled = false\nmargin_min", "enabled = true\nmargin_min")),
    ).toThrow(/must exceed \[daemon\] round_deadline_min \(120\)/);
  });
  it("enabled must be a boolean", () => {
    expect(() =>
      parseConfig(base.replace("enabled = false\nmargin_min", 'enabled = "yes"\nmargin_min')),
    ).toThrow(/enabled/);
  });
});

// ---- the fences ------------------------------------------------------------------------

describe("[P8.22] only the refresher and the login mode write the pihome's auth.json", () => {
  it("every auth.json writer in the tree is the refresher or a named sandbox copy", () => {
    const writers = authJsonWriters(root);
    const stray = writers.filter(
      (w) => !w.startsWith("src/loginrefresh/") && !isSandboxAuthWriter(w),
    );
    expect(stray).toEqual([]);
  });

  it("every named sandbox writer is a real file that the scan sees (a move fails loudly)", () => {
    const writers = authJsonWriters(root);
    for (const f of Object.keys(SANDBOX_AUTH_WRITERS)) {
      expect(existsSync(join(root, f)), f).toBe(true);
      expect(writers, f).toContain(f);
    }
  });

  it("the entrypoint's login mode never writes auth.json itself: pi's own /login does", () => {
    const text = readFileSync(join(root, "docker/entrypoint.sh"), "utf8");
    // the pause file and the lock are named; auth.json is only ever read, found, or shared (chmod/chgrp)
    const sh = text.replace(/^\s*#.*$/gm, "");
    expect(sh).not.toMatch(/>>?\s*["']?[^\s"']*auth\.json(?!\.)/);
    expect(sh).toContain(
      'loginInPi(process.argv[2] || undefined, process.argv[1] + "/node_modules/.bin/pi")[2]',
    );
  });

  it("the scan catches a planted writer (a fence that cannot fail is not one)", () => {
    const dir = mkdtempSync(join(tmpdir(), "qcr-fence-"));
    dirs.push(dir);
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(
      join(dir, "src/ok.ts"),
      `import { readFileSync } from "node:fs";\nreadFileSync(join(a, "auth.json"));\n`,
    );
    expect(authJsonWriters(dir)).toEqual([]);
    writeFileSync(
      join(dir, "src/rogue.ts"),
      `import { writeFileSync } from "node:fs";\nwriteFileSync(join(home, ".pi", "agent", "auth.json"), "{}");\n`,
    );
    mkdirSync(join(dir, "scripts"));
    writeFileSync(
      join(dir, "scripts/rogue.sh"),
      `#!/bin/sh\necho '{}' > "$HOME/.pi/agent/auth.json"\n`,
    );
    expect(authJsonWriters(dir)).toEqual(["scripts/rogue.sh", "src/rogue.ts"]);
    // the review core's package is source too
    mkdirSync(join(dir, "packages/pi-plugin/src"), { recursive: true });
    writeFileSync(
      join(dir, "packages/pi-plugin/src/rogue.ts"),
      `import { writeFileSync } from "node:fs";\nwriteFileSync(join(home, ".pi", "agent", "auth.json"), "{}");\n`,
    );
    expect(authJsonWriters(dir)).toEqual([
      "packages/pi-plugin/src/rogue.ts",
      "scripts/rogue.sh",
      "src/rogue.ts",
    ]);
  });
});

describe("[P8.22] the daemon imports neither pi nor src/engine/", () => {
  it("no daemon module's import closure reaches src/engine/", () => {
    expect(daemonReachesEngine(root)).toEqual([]);
  });

  it("the daemon reaches only the supervisor, its types and the lock constant of src/loginrefresh/", () => {
    expect(daemonReachedLoginRefresh(root, DAEMON_ROOTS)).toEqual([
      "src/loginrefresh/lock.ts",
      "src/loginrefresh/supervisor.ts",
      "src/loginrefresh/types.ts",
    ]);
  });

  it("nothing the daemon reaches in src/loginrefresh/ imports a pi package", () => {
    for (const f of daemonReachedLoginRefresh(root, DAEMON_ROOTS)) {
      const code = stripComments(readFileSync(join(root, f), "utf8"));
      expect(code, f).not.toMatch(/@earendil-works|@mariozechner/);
      expect(code, f).not.toMatch(/\/engine\//);
    }
  });

  it("main.ts and pirefresh.ts (the only files that load pi-ai) stay out of the daemon's reach", () => {
    const reached = daemonReachedLoginRefresh(root, DAEMON_ROOTS);
    expect(reached).not.toContain("src/loginrefresh/main.ts");
    expect(reached).not.toContain("src/loginrefresh/pirefresh.ts");
    expect(reached).not.toContain("src/loginrefresh/refresher.ts");
  });

  it("src/loginrefresh/ itself imports nothing from src/engine/ and loads pi-ai in one file", () => {
    const files = tsFilesUnder(join(root, "src", "loginrefresh"));
    expect(files.length).toBeGreaterThan(4);
    const withPi = files.filter((f) =>
      /@earendil-works|pi-ai/.test(stripComments(readFileSync(f, "utf8"))),
    );
    expect(withPi.map((f) => f.slice(root.length + 1))).toEqual(["src/loginrefresh/pirefresh.ts"]);
    for (const f of files)
      expect(stripComments(readFileSync(f, "utf8")), f).not.toMatch(/\/engine\//);
  });
});
