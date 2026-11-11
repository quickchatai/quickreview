// The engine's credentials: the owner's pi login, borrowed read-only
//. The in-process route builds a CredentialStore from a refresh-blanked
// copy: no file is written anywhere, and nothing here ever refreshes.
//
// `borrowedCredentials` is a filter: a login that cannot last the run on this
// surface is left out and named, never a refusal of the run; a store that is
// there and cannot be read is refused, never taken for an empty one; and where
// pi asks for a refresh, the store takes the owner's newer token from the
// owner's file instead of making one.
//
// Nothing here refuses a run for a login that is too short, and nothing hands
// a key to pi's runtime: the refusal is the route's (a host is told what was
// left out), and a key in the environment is found by pi itself. Only the
// process route (`copyPiAuth`, a file for a pi child) still refuses up front.
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { lineHasAuthError } from "@quickchatai/pi-quickreview/src/authwatch.js";
import {
  AuthError,
  AuthExpiring,
  AuthRefreshRefused,
  AuthRejected,
  AuthUnreadable,
  authCopyFrom,
  BENCH_AUTH_WORDS,
  borrowedCredentials,
  checkAuth,
  classifyAuthFailure,
  copyPiAuth,
  DISABLED_REFRESH,
  ENGINE_AUTH_WORDS,
  expiryText,
  keyOnlyCredentials,
  PI_REFRESH_MARGIN_MS,
  scanAuthExpiring,
} from "@quickchatai/pi-quickreview/src/engine/auth.js";
import { prepareReviewHost } from "@quickchatai/pi-quickreview/src/reviewhost.js";
import {
  interactiveHostFor,
  type LensHostRoute,
} from "@quickchatai/pi-quickreview/extensions/lens.js";
import { loadConfig } from "../src/config.js";
import * as piauthcopy from "../src/piauthcopy.js";
import * as scanauth from "../src/scanauth.js";
import * as engineAuth from "@quickchatai/pi-quickreview/src/engine/auth.js";
import { FIXTURE_CONFIG, REPO_ROOT } from "./helpers/round-rig.js";
import { HEAVY_TIMEOUT_MS } from "./helpers/suite-timeouts.js";
import { createHostRig, useOfflineGuard, type HostRig } from "./pi-canary/harness.js";

useOfflineGuard();

const MIN = 60_000;
const HOUR = 60 * MIN;

let dir: string;
let src: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "qcr-engine-auth-"));
  src = join(dir, "owner-agent");
  mkdirSync(src);
});
afterEach(() => {
  chmodSync(src, 0o700);
  rmSync(dir, { recursive: true, force: true });
});

function login(expiresInMs: number): string {
  return JSON.stringify({
    anthropic: {
      type: "oauth",
      access: "sk-ant-oat-ACCESS",
      refresh: "REAL-REFRESH",
      expires: Date.now() + expiresInMs,
    },
    openai: { type: "api_key", key: "sk-stored" },
  });
}

/** Every file under `root`, relative, sorted. */
function tree(root: string): string[] {
  return readdirSync(root, { recursive: true }).map(String).sort();
}

describe("the preflight refuses what the run window would outlive", () => {
  it("checkAuth: the window plus pi's refresh margin must fit inside the token's life", () => {
    const now = () => 1_000_000;
    const copy = (expiresAt: number | null) => ({ expiresAt, provider: "anthropic" });
    const fits = 1_000_000 + HOUR + PI_REFRESH_MARGIN_MS;
    expect(() => checkAuth(copy(fits), { needMs: HOUR, now })).not.toThrow();
    expect(() => checkAuth(copy(fits - 1), { needMs: HOUR, now })).toThrow(AuthExpiring);
    expect(() => checkAuth(copy(null), { needMs: HOUR, now })).not.toThrow();
    // The sandboxes' original admission rule (margin 0) is still expressible.
    expect(() =>
      checkAuth(copy(1_000_000 + HOUR), { needMs: HOUR, now, marginMs: 0 }),
    ).not.toThrow();
  });

  /** The process route's copy into a sandbox dir: the one borrow that still
   * refuses up front, since a pi child cannot be told what was left out. */
  const copyLogin = (needMs: number, words = ENGINE_AUTH_WORDS) =>
    copyPiAuth({ srcDir: src, dstDir: join(dir, "sandbox"), needMs, words });

  it("the process route: an expiring token is refused with the owner's fix, before anything is written", () => {
    writeFileSync(join(src, "auth.json"), login(20 * MIN));
    let err: unknown;
    try {
      copyLogin(30 * MIN);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(AuthExpiring);
    expect(err).toBeInstanceOf(AuthError);
    expect(err).toMatchObject({ code: "expiring", provider: "anthropic" });
    expect((err as Error).message).toContain("never refreshes");
    expect((err as Error).message).toContain("/login");
    expect((err as AuthExpiring).expiresAt).toBeGreaterThan(Date.now());
    expect(existsSync(join(dir, "sandbox"))).toBe(false);
  });

  it("the process route: no login at all is a typed refusal with code missing", () => {
    expect(() => copyLogin(MIN)).toThrow(AuthExpiring);
    try {
      copyLogin(MIN);
    } catch (e) {
      expect(e).toMatchObject({ code: "missing" });
      expect((e as Error).message).toContain(join(src, "auth.json"));
    }
  });

  it("the process route: a route may use its own words", () => {
    writeFileSync(join(src, "auth.json"), login(MIN));
    expect(() => copyLogin(HOUR, { ...ENGINE_AUTH_WORDS, expiring: () => "custom words" })).toThrow(
      "custom words",
    );
  });

  // The same three situations on the in-process route are not refusals any
  // more: `borrowedCredentials` below leaves the login out, or borrows nothing.
  // MUTATION: check the whole file's earliest expiry in borrowedCredentials and
  // throw (the retired refusing borrow) - a shared pi home's expired login for a
  // provider the run never uses refuses a healthy review, and this fails.
  it("the in-process route refuses none of them: a shared home's expired login costs only itself", async () => {
    const shared = JSON.stringify({
      anthropic: { type: "oauth", access: "OLD", refresh: "R", expires: Date.now() - HOUR },
      openai: { type: "oauth", access: "A", refresh: "R", expires: Date.now() + 10 * HOUR },
    });
    writeFileSync(join(src, "auth.json"), shared);
    const b = borrowedCredentials({ srcDir: src, needMs: 30 * MIN, owner: false });
    expect(b.skipped.map((l) => l.provider)).toEqual(["anthropic"]);
    expect((await b.credentials.list()).map((c) => c.providerId)).toEqual(["openai"]);
  });
});

describe("borrowedCredentials: a filter over the owner's login", () => {
  const NOW = 1_700_000_000_000;
  const now = () => NOW;
  const NEED = HOUR;
  /** The first moment a login lasts the run: its window plus pi's margin. */
  const LASTS = NOW + NEED + PI_REFRESH_MARGIN_MS;
  /** The first moment a login is outside pi's refresh margin now. */
  const OUTSIDE = NOW + PI_REFRESH_MARGIN_MS;

  const oauth = (expires: number) => ({
    type: "oauth",
    access: "ACCESS",
    refresh: "REAL-REFRESH",
    expires,
  });
  /** One login per row of the table, and a stored key. */
  const rows = {
    key: { type: "api_key", key: "sk-stored" },
    lasts: oauth(LASTS),
    short: oauth(LASTS - 1),
    edge: oauth(OUTSIDE),
    dying: oauth(OUTSIDE - 1),
    forever: oauth(Number.MAX_SAFE_INTEGER),
  };
  const write = (data: unknown): void =>
    writeFileSync(join(src, "auth.json"), typeof data === "string" ? data : JSON.stringify(data));
  const borrow = (owner: boolean) =>
    borrowedCredentials({ srcDir: src, needMs: NEED, now, owner, retry: { tries: 1 } });
  const kept = async (b: ReturnType<typeof borrow>): Promise<string[]> =>
    (await b.credentials.list()).map((c) => c.providerId).sort();

  // MUTATION: throw AuthExpiring for a login that cannot last in
  // borrowedCredentials (the older refusal) — this throws instead of skipping.
  // MUTATION: drop `o.owner &&` from the renewed test — the short logins are
  // kept with no owner and this fails.
  it("with no owner, a login shorter than the run is left out and named; nothing is refused", async () => {
    write(rows);
    const b = borrow(false);
    expect(await kept(b)).toEqual(["forever", "key", "lasts"]);
    expect(b.skipped).toEqual([
      { provider: "short", name: "short", expiresAt: LASTS - 1 },
      { provider: "edge", name: "edge", expiresAt: OUTSIDE },
      { provider: "dying", name: "dying", expiresAt: OUTSIDE - 1 },
    ]);
    expect(await b.credentials.read("short")).toBeUndefined();
  });

  // MUTATION: skip every login shorter than the run whatever `owner` says —
  // "short" and "edge" are left out and this fails.
  it("with an owner, a login shorter than the run is kept unless it is inside pi's margin already", async () => {
    write(rows);
    const b = borrow(true);
    expect(await kept(b)).toEqual(["edge", "forever", "key", "lasts", "short"]);
    expect(b.skipped).toEqual([{ provider: "dying", name: "dying", expiresAt: OUTSIDE - 1 }]);
  });

  it("the margin is the caller's when it names one", async () => {
    write({ a: oauth(NOW + NEED) });
    const at = (marginMs: number) =>
      borrowedCredentials({ srcDir: src, needMs: NEED, now, owner: false, marginMs });
    expect(at(0).skipped).toEqual([]);
    expect(at(1).skipped).toHaveLength(1);
  });

  it("serves every kept login with its refresh token blanked, as copies, and writes nothing", async () => {
    const raw = JSON.stringify(rows);
    write(raw);
    chmodSync(src, 0o500); // read-only for the whole run: a write would throw
    chmodSync(join(src, "auth.json"), 0o400);
    const before = { tree: tree(src), mtime: statSync(join(src, "auth.json")).mtimeMs };

    const { credentials } = borrow(true);

    for (const name of ["lasts", "short", "edge", "forever"])
      expect(await credentials.read(name), name).toMatchObject({
        type: "oauth",
        access: "ACCESS",
        refresh: DISABLED_REFRESH,
      });
    expect(await credentials.read("key")).toEqual(rows.key);
    ((await credentials.read("key")) as { key: string }).key = "tampered";
    expect(await credentials.read("key")).toEqual(rows.key);

    expect(tree(src)).toEqual(before.tree);
    expect(statSync(join(src, "auth.json")).mtimeMs).toBe(before.mtime);
    expect(readFileSync(join(src, "auth.json"), "utf8")).toBe(raw);
  });

  it("the summary names every entry of the file, kept or skipped, and never a token", () => {
    write(rows);
    const { summary } = borrow(false);
    expect(summary).toEqual({
      key: { type: "api_key", expires: null },
      lasts: { type: "oauth", expires: LASTS },
      short: { type: "oauth", expires: LASTS - 1 },
      edge: { type: "oauth", expires: OUTSIDE },
      dying: { type: "oauth", expires: OUTSIDE - 1 },
      forever: { type: "oauth", expires: Number.MAX_SAFE_INTEGER },
    });
    expect(JSON.stringify(summary)).not.toMatch(/ACCESS|REFRESH|sk-stored/);
  });

  it("no auth.json is an empty store, not an error: a key in the environment is then the route", async () => {
    for (const srcDir of [src, join(dir, "never-made")]) {
      const b = borrowedCredentials({ srcDir, needMs: NEED, owner: false });
      expect(await b.credentials.list()).toEqual([]);
      expect(b.skipped).toEqual([]);
      expect(b.summary).toEqual({});
    }
  });

  // MUTATION: return the empty store for any failed read in borrowedCredentials
  // (not only a missing file) — every row here borrows nothing and this fails.
  it("a store that is there and cannot be read is refused, never taken for an empty one", () => {
    const path = join(src, "auth.json");
    const refusal = (): unknown => {
      try {
        borrow(false);
      } catch (e) {
        return e;
      }
      return undefined;
    };
    for (const malformed of ["{ not json", "", "[]", "null", '"a string"']) {
      write(malformed);
      const err = refusal();
      expect(err, malformed).toBeInstanceOf(AuthUnreadable);
      expect(err, malformed).toBeInstanceOf(AuthError);
      expect(err, malformed).toMatchObject({ code: "unreadable", path });
      expect((err as Error).message, malformed).toContain(
        `could not read pi's credentials at ${path}: `,
      );
    }
    // Something that is not a readable file at all (a broken mount looks so).
    rmSync(path);
    mkdirSync(path);
    expect(refusal()).toMatchObject({ code: "unreadable", path });
  });

  it("an entry that is no credential object is neither kept nor skipped", async () => {
    write({ key: rows.key, junk: "text", none: null });
    const b = borrow(false);
    expect(await kept(b)).toEqual(["key"]);
    expect(b.skipped).toEqual([]);
  });
});

describe("an expiry that is no date reads `never`", () => {
  // MUTATION: format with `new Date(expiresAt).toISOString()` alone in
  // expiryText — the largest safe integer throws a RangeError and this fails.
  it("expiryText: the ISO time, or `never` for what pi writes for a login that does not expire", () => {
    expect(expiryText(1_700_000_000_000)).toBe("2023-11-14T22:13:20.000Z");
    for (const none of [Number.MAX_SAFE_INTEGER, Infinity, -Infinity, NaN, 8.64e15 + 1, null])
      expect(expiryText(none), String(none)).toBe("never");
  });

  it("no refusal text throws on such an expiry", () => {
    const at = { provider: "p", expiresAt: Number.MAX_SAFE_INTEGER, needMs: HOUR };
    expect(ENGINE_AUTH_WORDS.expiring(at)).toContain("expires at never");
    expect(BENCH_AUTH_WORDS.expiring(at)).toContain("expires at never");
    expect(scanAuthExpiring(at)).toContain("expires at never");
  });
});

describe("the re-borrow: a refresh pi asks for is answered from the owner's file", () => {
  const file = (): string => join(src, "auth.json");
  const entry = (access: string, expires: number) => ({
    type: "oauth",
    access,
    refresh: "REAL-REFRESH",
    expires,
    account: "acct-1",
  });
  const write = (data: Record<string, unknown>): void =>
    writeFileSync(file(), JSON.stringify(data));
  /** pi's updater: the refresh a borrower must never run. */
  const updater = () => vi.fn(async () => undefined);

  let t0: number;
  beforeEach(() => {
    t0 = Date.now();
    write({
      anthropic: entry("OLD", t0 + 10 * MIN),
      openai: { type: "api_key", key: "sk-stored" },
      dying: entry("DYING", t0 + MIN),
    });
  });
  const borrow = (renew?: (provider: string) => Promise<void>) =>
    borrowedCredentials({
      srcDir: src,
      needMs: HOUR,
      owner: true,
      retry: { tries: 1 },
      ...(renew ? { renew } : {}),
    });

  // MUTATION: call the updater in ReadOnlyCredentials.modify — the spy is
  // called (a borrower would spend the owner's refresh token) and this fails.
  it("adopts the owner's later token, refresh blanked, without running pi's updater", async () => {
    const { credentials } = borrow();
    write({ anthropic: entry("NEW", t0 + 2 * HOUR) });
    const raw = readFileSync(file(), "utf8");
    const update = updater();

    const post = await credentials.modify("anthropic", update);

    const adopted = {
      type: "oauth",
      access: "NEW",
      refresh: DISABLED_REFRESH,
      expires: t0 + 2 * HOUR,
      account: "acct-1",
    };
    expect(post).toEqual(adopted);
    expect(await credentials.read("anthropic")).toEqual(adopted);
    expect(update).not.toHaveBeenCalled();
    expect(readFileSync(file(), "utf8")).toBe(raw);
  });

  it("asks the owner to renew first, when the host can ask", async () => {
    const asked: string[] = [];
    const { credentials } = borrow(async (provider) => {
      asked.push(provider);
      write({ anthropic: entry("RENEWED", t0 + 3 * HOUR) });
    });
    expect(await credentials.modify("anthropic", updater())).toMatchObject({ access: "RENEWED" });
    expect(asked).toEqual(["anthropic"]);
  });

  // MUTATION: adopt whatever the owner's file holds (drop the later-expiry
  // test) — pi gets the same dying token back as if it were renewed, and
  // this fails.
  it("refuses, typed, when the owner's file holds nothing later, and keeps what it held", async () => {
    const { credentials } = borrow();
    const update = updater();
    await expect(credentials.modify("anthropic", update)).rejects.toBeInstanceOf(
      AuthRefreshRefused,
    );
    expect(update).not.toHaveBeenCalled();
    expect(await credentials.read("anthropic")).toMatchObject({ access: "OLD" });

    // The owner logged out, or the file went away: the same refusal.
    write({});
    await expect(credentials.modify("anthropic", update)).rejects.toMatchObject({
      code: "refresh-refused",
    });
    rmSync(file());
    const gone = await credentials.modify("anthropic", update).catch((e: unknown) => e);
    expect(gone).toBeInstanceOf(AuthRefreshRefused);
    expect((gone as Error).cause).toMatchObject({ code: "ENOENT" });
  });

  it("a renewal that fails is the refusal's cause, unless the owner's file is newer anyway", async () => {
    const failed = new Error("the owner could not renew");
    const { credentials } = borrow(async () => {
      throw failed;
    });
    const refused = await credentials.modify("anthropic", updater()).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(AuthRefreshRefused);
    expect((refused as Error).cause).toBe(failed);

    write({ anthropic: entry("NEW", t0 + 2 * HOUR) });
    expect(await credentials.modify("anthropic", updater())).toMatchObject({ access: "NEW" });
  });

  // MUTATION: adopt the owner's entry for a provider the store does not hold
  // — a login the route was chosen without comes back mid-run, and this fails.
  it("never brings back a login the borrow left out, and never touches a stored key", async () => {
    const b = borrow();
    expect(b.skipped.map((s) => s.provider)).toEqual(["dying"]);
    write({
      dying: entry("BACK", t0 + 2 * HOUR),
      openai: entry("NOT-A-KEY", t0 + 2 * HOUR),
    });
    for (const provider of ["dying", "openai", "nobody"])
      await expect(b.credentials.modify(provider, updater()), provider).rejects.toBeInstanceOf(
        AuthRefreshRefused,
      );
    expect(await b.credentials.read("dying")).toBeUndefined();
    expect(await b.credentials.read("openai")).toEqual({ type: "api_key", key: "sk-stored" });
  });

  it("delete is refused as before", async () => {
    const { credentials } = borrow();
    await expect(credentials.delete("anthropic")).rejects.toMatchObject({
      code: "refresh-refused",
    });
    expect(await credentials.read("anthropic")).toMatchObject({ access: "OLD" });
  });

  it("sessions that ask together share one renewal", async () => {
    let asked = 0;
    const { credentials } = borrow(async () => {
      asked++;
      await new Promise((r) => setTimeout(r, 5));
      write({ anthropic: entry("NEW", t0 + 2 * HOUR) });
    });
    const posts = await Promise.all(
      [1, 2, 3].map(() => credentials.modify("anthropic", updater())),
    );
    expect(posts.map((p) => (p as { access: string }).access)).toEqual(["NEW", "NEW", "NEW"]);
    expect(asked).toBe(1);
    // Each caller gets its own copy.
    (posts[0] as { access: string }).access = "tampered";
    expect(await credentials.read("anthropic")).toMatchObject({ access: "NEW" });
  });
});

describe("prepareReviewHost: the login is copied, or left to the host's memory", () => {
  const prepare = (auth?: "copy" | "injected") =>
    prepareReviewHost({
      root: REPO_ROOT,
      srcAgentDir: src,
      agentDir: join(dir, "run", "agent"),
      cwd: join(dir, "run", "out"),
      cfg: loadConfig(FIXTURE_CONFIG),
      needMs: HOUR,
      checkouts: [],
      profile: { lookup: {} },
      ...(auth ? { auth } : {}),
    });

  // MUTATION: copy the login whatever `auth` says in prepareReviewHost — the
  // short login refuses the injected run, and this fails.
  it(
    "injected: no auth.json is written and the owner's login is not checked here",
    { timeout: HEAVY_TIMEOUT_MS },
    () => {
      // A login the copy would refuse: with an injected store it is the
      // borrow's to skip, not this step's to refuse.
      writeFileSync(join(src, "auth.json"), login(MIN));
      writeFileSync(join(src, "models.json"), "{}\n");
      const run = prepare("injected");
      expect(existsSync(join(run.agentDir, "auth.json"))).toBe(false);
      // The rest of the private agent dir is as ever.
      expect(existsSync(join(run.agentDir, "settings.json"))).toBe(true);
      expect(existsSync(join(run.agentDir, "models.json"))).toBe(true);
      expect(readdirSync(join(run.agentDir, "agents")).length).toBeGreaterThan(0);
    },
  );

  it("copy is the default: the same login refuses the run before anything is built", () => {
    writeFileSync(join(src, "auth.json"), login(MIN));
    expect(() => prepare()).toThrow(AuthExpiring);
    expect(() => prepare("copy")).toThrow(AuthExpiring);
    expect(existsSync(join(dir, "run", "agent", "auth.json"))).toBe(false);
  });
});

describe("through a real PiHost on the faux provider", () => {
  let rig: HostRig | undefined;
  afterEach(() => {
    rig?.close();
    rig = undefined;
  });

  it("resolves the stored login, writes no auth file, and never calls modify", async () => {
    writeFileSync(join(src, "auth.json"), login(10 * HOUR));
    const { credentials } = borrowedCredentials({ srcDir: src, needMs: HOUR, owner: false });
    const modify = vi.spyOn(credentials, "modify");
    const del = vi.spyOn(credentials, "delete");
    rig = await createHostRig({ credentials });

    const runtime = rig.host.modelRuntime;
    expect(await runtime.getAuth("anthropic")).toMatchObject({
      auth: { apiKey: "sk-ant-oat-ACCESS" },
      source: "OAuth",
    });
    expect(await runtime.getAuth("openai")).toMatchObject({ auth: { apiKey: "sk-stored" } });

    expect(modify).not.toHaveBeenCalled();
    expect(del).not.toHaveBeenCalled();
    expect(existsSync(join(rig.host.agentDir, "auth.json"))).toBe(false);
    expect(readdirSync(rig.host.agentDir)).toEqual([]);
  });

  it("a refresh attempted anyway fails typed and offline, and nothing is persisted", async () => {
    // Admitted (as the sandboxes' rule would), then the clock moved on: pi sees
    // less than five minutes left and tries to refresh.
    writeFileSync(join(src, "auth.json"), login(2 * MIN));
    const { credentials, skipped } = borrowedCredentials({
      srcDir: src,
      needMs: MIN,
      owner: false,
      now: () => Date.now() - 2 * HOUR,
    });
    expect(skipped).toEqual([]);
    const modify = vi.spyOn(credentials, "modify");
    rig = await createHostRig({ credentials });

    const failure = await rig.host.modelRuntime.getAuth("anthropic").then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(failure).toBeDefined();
    expect(modify).toHaveBeenCalledTimes(1);
    await expect(modify.mock.results[0]!.value).rejects.toBeInstanceOf(AuthRefreshRefused);
    expect(existsSync(join(rig.host.agentDir, "auth.json"))).toBe(false);
  });

  // MUTATION: throw AuthRefreshRefused from ReadOnlyCredentials.modify whatever
  // the owner's file holds — pi's request fails instead of running on the
  // newer token, and this fails.
  it("a borrowed login outlives its token: pi's refresh is answered with the owner's newer one, offline", async () => {
    // Borrowed while the token had time; then the clock moved on, and the
    // owner renewed its own login.
    writeFileSync(join(src, "auth.json"), login(2 * MIN));
    const { credentials, skipped } = borrowedCredentials({
      srcDir: src,
      needMs: MIN,
      owner: true,
      now: () => Date.now() - 2 * HOUR,
    });
    expect(skipped).toEqual([]);
    const renewed = JSON.stringify({
      anthropic: {
        type: "oauth",
        access: "sk-ant-oat-RENEWED",
        refresh: "REAL-REFRESH-2",
        expires: Date.now() + 10 * HOUR,
      },
    });
    writeFileSync(join(src, "auth.json"), renewed);
    const modify = vi.spyOn(credentials, "modify");
    rig = await createHostRig({ credentials, authEnv: {} });
    const runtime = rig.host.modelRuntime;

    expect(await runtime.getAuth("anthropic")).toMatchObject({
      auth: { apiKey: "sk-ant-oat-RENEWED" },
      source: "OAuth",
    });
    expect(modify).toHaveBeenCalledTimes(1);
    // The store kept it: the next request does not ask again.
    expect(await runtime.getAuth("anthropic")).toMatchObject({
      auth: { apiKey: "sk-ant-oat-RENEWED" },
    });
    expect(modify).toHaveBeenCalledTimes(1);
    // Nothing was refreshed (the offline guard), and nothing was written.
    expect(readFileSync(join(src, "auth.json"), "utf8")).toBe(renewed);
    expect(existsSync(join(rig.host.agentDir, "auth.json"))).toBe(false);
  });

  // MUTATION: keep a skipped login in the store in borrowedCredentials — pi
  // resolves the stored login, the env key never gets its turn, and this fails.
  it("a login left out gives its provider to a key in the environment; one that lasts keeps it", async () => {
    const authEnv = { ANTHROPIC_API_KEY: "sk-ant-ENV" };
    writeFileSync(join(src, "auth.json"), login(20 * MIN));
    const short = borrowedCredentials({ srcDir: src, needMs: 30 * MIN, owner: false });
    expect(short.skipped.map((s) => s.provider)).toEqual(["anthropic"]);
    rig = await createHostRig({ credentials: short.credentials, authEnv });
    expect(await rig.host.modelRuntime.getAuth("anthropic")).toMatchObject({
      auth: { apiKey: "sk-ant-ENV" },
    });
    expect(
      (await rig.host.inventory()).find((e) => e.provider === "anthropic")?.credential,
    ).toMatchObject({ kind: "api_key", origin: "env-key", label: "ANTHROPIC_API_KEY" });
    rig.close();

    // pi's own order: a stored login owns its provider while it can be used.
    writeFileSync(join(src, "auth.json"), login(10 * HOUR));
    const lasting = borrowedCredentials({ srcDir: src, needMs: 30 * MIN, owner: false });
    expect(lasting.skipped).toEqual([]);
    rig = await createHostRig({ credentials: lasting.credentials, authEnv });
    expect(await rig.host.modelRuntime.getAuth("anthropic")).toMatchObject({
      auth: { apiKey: "sk-ant-oat-ACCESS" },
      source: "OAuth",
    });
  });

  // MUTATION: drop `authEnv: env` from interactiveHost (extensions/lens.ts) —
  // pi looks in the test process's env, finds no key, and this fails.
  it("the interactive lens host looks for a provider key in the env it was handed", async () => {
    writeFileSync(join(src, "auth.json"), "{}\n");
    const before = tree(src);
    const host = await interactiveHostFor({ GROQ_API_KEY: "not-a-key" })(src);
    try {
      expect(
        Object.fromEntries((await host.inventory()).map((e) => [e.provider, e.credential])),
      ).toEqual({
        groq: { kind: "api_key", origin: "env-key", label: "GROQ_API_KEY", subscription: false },
      });
    } finally {
      host.dispose();
    }
    expect(tree(src)).toEqual(before);
  });

  // MUTATION: refuse in interactiveHost when the borrow left a login out, or
  // when there is no login file (the retired refusing borrow) - no host is
  // built and this throws.
  // MUTATION: drop `skipped` from the route interactiveHost hands the host
  // (lensHostRoute) - the second refusal reads `no-credential` and this fails.
  it("the interactive lens host is built whatever the login: the refusal is the route's", async () => {
    // No login file: an empty store, and nothing else to run on.
    const none = await interactiveHostFor({})(src);
    try {
      expect(await none.route()).toEqual({ ok: false, refusal: { code: "no-credential" } });
    } finally {
      none.dispose();
    }

    // A login shorter than a round, with nothing here to renew it.
    const expires = Date.now() + 20 * MIN;
    writeFileSync(
      join(src, "auth.json"),
      JSON.stringify({ anthropic: { type: "oauth", access: "A", refresh: "R", expires } }),
    );
    const short = await interactiveHostFor({})(src);
    try {
      expect(await short.route()).toEqual({
        ok: false,
        refusal: {
          code: "login-too-short",
          logins: [{ provider: "anthropic", name: "anthropic", expiresAt: expires }],
        },
      });
      expect(await short.inventory()).toEqual([]);
    } finally {
      short.dispose();
    }
    expect(tree(src)).toEqual(["auth.json"]);
  });

  // A file that does not parse is waited out first (a login being rewritten),
  // so this one takes the borrow's whole retry.
  it(
    "the interactive lens host refuses a login it cannot read, typed, and builds nothing",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      writeFileSync(join(src, "auth.json"), "{ not json");
      await expect(interactiveHostFor({})(src)).rejects.toMatchObject({
        code: "unreadable",
        path: join(src, "auth.json"),
      });
    },
  );

  // MUTATION: hand the host `{ skipped }` alone when the session's own login
  // was left out (lensHostRoute) - the host resolves a route on the stored key
  // of another provider, the lenses leave the session's model, and this fails.
  it("a session on a login left out is not moved to another provider: its lenses are refused as that", async () => {
    // The session's login is too short for a round; another provider has a key.
    writeFileSync(join(src, "auth.json"), login(20 * MIN));
    // pi's own model for the session's provider, from the host's catalog.
    const probe = await interactiveHostFor({})(src);
    const model = probe.modelRuntime.getModels("anthropic")[0]!;
    probe.dispose();
    const route: LensHostRoute = {
      model,
      fixed: {
        provider: model.provider,
        modelId: model.id,
        providerName: model.provider,
        spec: `${model.provider}/${model.id}`,
        thinking: null,
        source: "pi-provider",
        pick: "pinned",
        piDefaultId: null,
        custom: false,
        movedFrom: null,
        credential: { kind: "oauth", origin: "stored", subscription: true },
        priced: true,
        ask: false,
        alternatives: [],
        notices: [],
      },
    };

    const host = await interactiveHostFor({})(src, route);
    try {
      expect((await host.inventory()).map((e) => e.provider)).toEqual(["openai"]);
      expect(await host.route()).toMatchObject({
        ok: false,
        refusal: { code: "login-too-short", logins: [{ provider: "anthropic" }] },
      });
    } finally {
      host.dispose();
    }

    // A key in the environment for the session's provider takes over, by pi's
    // own rule, and the session's model is the route.
    const keyed = await interactiveHostFor({ ANTHROPIC_API_KEY: "sk-ant-ENV" })(src, route);
    try {
      expect(await keyed.route()).toMatchObject({
        ok: true,
        route: {
          provider: "anthropic",
          modelId: model.id,
          source: "choice",
          credential: { origin: "env-key" },
        },
      });
    } finally {
      keyed.dispose();
    }

    // A login that lasts the round keeps the session's route as it was handed.
    writeFileSync(join(src, "auth.json"), login(10 * HOUR));
    const lasting = await interactiveHostFor({})(src, route);
    try {
      expect(await lasting.route()).toEqual({ ok: true, route: route.fixed });
    } finally {
      lasting.dispose();
    }
  });

  it("a host that holds no login: the empty store refuses every change and no auth file appears", async () => {
    const store = keyOnlyCredentials();
    expect(await store.list()).toEqual([]);
    await expect(store.modify("anthropic", async () => undefined)).rejects.toBeInstanceOf(
      AuthRefreshRefused,
    );
    rig = await createHostRig({ credentials: store, authEnv: { ANTHROPIC_API_KEY: "sk-ant-ENV" } });
    // The key is pi's to find in the environment the host was handed.
    expect(await rig.host.modelRuntime.getAuth("anthropic")).toMatchObject({
      auth: { apiKey: "sk-ant-ENV" },
    });
    expect(existsSync(join(rig.host.agentDir, "auth.json"))).toBe(false);
  });
});

describe("no key is handed to pi's runtime from here", () => {
  // What the env table protected is kept by the borrow: a login that cannot
  // last is left out, so pi falls through to the environment's key on its own
  // ("a login left out gives its provider to a key in the environment", above).
  // What the module must not grow back is fenced by the shape of a name: a
  // table of key variables, something that sets a runtime key, a borrow of the
  // engine's own that refuses.
  const RETIRED_SHAPE = /_ENVS$|^applyEnv|RuntimeApiKey|^engine[A-Z]/;

  // MUTATION: export a `..._KEY_ENVS` table, an `applyEnv...` or a
  // `set...RuntimeApiKey` function from engine/auth.ts again - this fails.
  it("the module exports no env table, no runtime-key setter and no refusing borrow", () => {
    const names = Object.keys(engineAuth);
    expect(names.filter((n) => RETIRED_SHAPE.test(n))).toEqual([]);
    // The check reads the module: what replaced them is there.
    expect(names).toEqual(expect.arrayContaining(["borrowedCredentials", "keyOnlyCredentials"]));
    // And the shape bites on each kind of name it is for.
    for (const name of ["SOME_KEY_ENVS", "applyEnvKeys", "setRuntimeApiKey", "engineLogin"])
      expect(RETIRED_SHAPE.test(name), name).toBe(true);
  });
});

describe("typed errors for authwatch", () => {
  it("classifyAuthFailure recognises authwatch's own signature, and only that", () => {
    const text = "Provided authentication token is expired.";
    const e = classifyAuthFailure(text);
    expect(e).toBeInstanceOf(AuthRejected);
    expect(e).toMatchObject({ code: "rejected", message: text });
    expect(classifyAuthFailure("invalid_grant")).toBeInstanceOf(AuthRejected);
    expect(classifyAuthFailure("rate limited, retry later")).toBeUndefined();
  });

  it("what classifyAuthFailure accepts, authwatch's line scan accepts", () => {
    for (const msg of [
      "Provided authentication token is expired.",
      "401 Unauthorized",
      "invalid_grant",
    ]) {
      expect(classifyAuthFailure(msg)).toBeDefined();
      expect(lineHasAuthError(JSON.stringify({ errorMessage: msg }))).toBe(true);
    }
  });

  // MUTATION: give classifyAuthFailure a pattern of its own again (anything
  // but the one classifier's `auth` kind) - a refused model or a rate limit
  // that carries "401 errors" is typed as a refused login; this fails.
  it("is the one classifier's auth kind: a refused model, a rate limit and a spent account are not a refused login", () => {
    for (const msg of [
      "authentication_error: invalid x-api-key",
      "API key not valid. Please pass a valid API key.",
      "OAuth refresh failed for anthropic",
      "Credential store modify failed for github-copilot",
      // A borrowed login that was asked to refresh says so in its own words.
      new AuthRefreshRefused("modify", "p").message,
    ]) {
      expect(classifyAuthFailure(msg), msg).toBeInstanceOf(AuthRejected);
      expect(lineHasAuthError(JSON.stringify({ errorMessage: msg })), msg).toBe(true);
    }
    for (const msg of [
      "403 Forbidden: model not available in your region",
      "AccessDeniedException: You don't have access to the model",
      "429 Too Many Requests: rate limit reached after 401 errors",
      "402 Payment Required: account blocked",
      "529 Platform overloaded",
    ]) {
      expect(classifyAuthFailure(msg), msg).toBeUndefined();
      expect(lineHasAuthError(JSON.stringify({ errorMessage: msg })), msg).toBe(false);
    }
  });

  it("each error carries its own code and name", () => {
    expect(new AuthExpiring("x").code).toBe("expiring");
    expect(new AuthExpiring("x", { code: "missing" }).code).toBe("missing");
    expect(new AuthRefreshRefused("modify", "p")).toMatchObject({
      code: "refresh-refused",
      name: "AuthRefreshRefused",
    });
    expect(new AuthRejected("x").name).toBe("AuthRejected");
  });
});

describe("the process route keeps its behaviour", () => {
  it("copyPiAuth writes the blanked copy 0600 and refuses a token inside needMs", () => {
    writeFileSync(join(src, "auth.json"), login(10 * HOUR));
    const dst = join(dir, "sandbox");
    const words = ENGINE_AUTH_WORDS;
    copyPiAuth({ srcDir: src, dstDir: dst, needMs: HOUR, words });
    const copy = JSON.parse(readFileSync(join(dst, "auth.json"), "utf8"));
    expect(copy.anthropic.refresh).toBe(DISABLED_REFRESH);
    expect(statSync(join(dst, "auth.json")).mode & 0o777).toBe(0o600);
    expect(authCopyFrom(login(HOUR)).provider).toBe("anthropic");

    const dst2 = join(dir, "sandbox2");
    expect(() => copyPiAuth({ srcDir: src, dstDir: dst2, needMs: 11 * HOUR, words })).toThrow(
      AuthExpiring,
    );
    expect(existsSync(dst2)).toBe(false);
  });

  it("the old module paths re-export the engine's (the scan container imports them by path)", () => {
    for (const name of Object.keys(piauthcopy)) {
      expect((piauthcopy as Record<string, unknown>)[name], name).toBe(
        (engineAuth as Record<string, unknown>)[name],
      );
    }
    // syncScanAuthFromEnv is scanauth's own: the container's one-shot probe owns
    // its process, which the engine never does.
    for (const name of Object.keys(scanauth).filter((n) => n !== "syncScanAuthFromEnv")) {
      expect((scanauth as Record<string, unknown>)[name], name).toBe(
        (engineAuth as Record<string, unknown>)[name],
      );
    }
    expect(Object.keys(piauthcopy).length).toBeGreaterThan(0);
    expect(Object.keys(scanauth).length).toBeGreaterThan(0);
  });
});
