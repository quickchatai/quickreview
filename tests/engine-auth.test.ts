// The engine's credentials: the owner's pi login, borrowed read-only
//. The in-process route builds a CredentialStore from a refresh-blanked
// copy: no file is written anywhere, `modify` is never reached on a good run,
// a token that would expire inside the run window is refused before a session
// exists, and a refresh that is attempted anyway fails typed, offline.
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
  applyEnvApiKeys,
  AuthError,
  AuthExpiring,
  AuthRefreshRefused,
  AuthRejected,
  authCopyFrom,
  checkAuth,
  classifyAuthFailure,
  copyPiAuth,
  DISABLED_REFRESH,
  engineCredentials,
  ENGINE_AUTH_WORDS,
  keyOnlyCredentials,
  PI_REFRESH_MARGIN_MS,
  setRuntimeApiKey,
} from "@quickchatai/pi-quickreview/src/engine/auth.js";
import * as piauthcopy from "../src/piauthcopy.js";
import * as scanauth from "../src/scanauth.js";
import * as engineAuth from "@quickchatai/pi-quickreview/src/engine/auth.js";
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

describe("engineCredentials: the blanked copy, in memory", () => {
  it("serves the owner's login with every refresh token blanked, and writes nothing", async () => {
    const raw = login(10 * HOUR);
    writeFileSync(join(src, "auth.json"), raw);
    chmodSync(src, 0o500); // read-only for the whole run: a write would throw
    chmodSync(join(src, "auth.json"), 0o400);
    const before = { tree: tree(src), mtime: statSync(join(src, "auth.json")).mtimeMs };

    const a = engineCredentials({ srcDir: src, needMs: HOUR });

    const oauth = await a.credentials.read("anthropic");
    expect(oauth).toMatchObject({ type: "oauth", access: "sk-ant-oat-ACCESS" });
    expect((oauth as { refresh: string }).refresh).toBe(DISABLED_REFRESH);
    expect(await a.credentials.read("openai")).toEqual({ type: "api_key", key: "sk-stored" });
    expect(await a.credentials.read("nobody")).toBeUndefined();
    expect(await a.credentials.list()).toEqual([
      { providerId: "anthropic", type: "oauth" },
      { providerId: "openai", type: "api_key" },
    ]);
    expect(a.provider).toBe("anthropic");
    expect(a.expiresAt).toBeGreaterThan(Date.now() + 9 * HOUR);

    expect(tree(src)).toEqual(before.tree);
    expect(statSync(join(src, "auth.json")).mtimeMs).toBe(before.mtime);
    expect(readFileSync(join(src, "auth.json"), "utf8")).toBe(raw);
  });

  it("hands out copies: a caller cannot change what the next read sees", async () => {
    writeFileSync(join(src, "auth.json"), login(10 * HOUR));
    const { credentials } = engineCredentials({ srcDir: src, needMs: HOUR });
    ((await credentials.read("openai")) as { key: string }).key = "tampered";
    expect(await credentials.read("openai")).toEqual({ type: "api_key", key: "sk-stored" });
  });

  it("refuses every change, typed: modify and delete throw AuthRefreshRefused", async () => {
    writeFileSync(join(src, "auth.json"), login(10 * HOUR));
    const { credentials } = engineCredentials({ srcDir: src, needMs: HOUR });
    await expect(credentials.modify("anthropic", async () => undefined)).rejects.toBeInstanceOf(
      AuthRefreshRefused,
    );
    await expect(credentials.delete("anthropic")).rejects.toMatchObject({
      code: "refresh-refused",
    });
    expect(await credentials.read("anthropic")).toMatchObject({ access: "sk-ant-oat-ACCESS" });
  });

  it("a login with no OAuth entry never expires", () => {
    writeFileSync(
      join(src, "auth.json"),
      JSON.stringify({ openai: { type: "api_key", key: "k" } }),
    );
    expect(engineCredentials({ srcDir: src, needMs: 100 * HOUR }).expiresAt).toBeNull();
  });
});

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

  it("an expiring token is refused with the owner's fix, before anything is built", () => {
    writeFileSync(join(src, "auth.json"), login(20 * MIN));
    let err: unknown;
    try {
      engineCredentials({ srcDir: src, needMs: 30 * MIN });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(AuthExpiring);
    expect(err).toBeInstanceOf(AuthError);
    expect(err).toMatchObject({ code: "expiring", provider: "anthropic" });
    expect((err as Error).message).toContain("never refreshes");
    expect((err as Error).message).toContain("/login");
    expect((err as AuthExpiring).expiresAt).toBeGreaterThan(Date.now());
  });

  it("a token inside pi's refresh margin of the window's end is refused too", () => {
    writeFileSync(join(src, "auth.json"), login(30 * MIN + 2 * MIN));
    expect(() => engineCredentials({ srcDir: src, needMs: 30 * MIN })).toThrow(AuthExpiring);
    writeFileSync(join(src, "auth.json"), login(30 * MIN + 6 * MIN));
    expect(() => engineCredentials({ srcDir: src, needMs: 30 * MIN })).not.toThrow();
  });

  it("no login at all is a typed refusal with code missing", () => {
    expect(() => engineCredentials({ srcDir: src, needMs: MIN })).toThrow(AuthExpiring);
    try {
      engineCredentials({ srcDir: src, needMs: MIN });
    } catch (e) {
      expect(e).toMatchObject({ code: "missing" });
      expect((e as Error).message).toContain(join(src, "auth.json"));
    }
  });

  it("a route may use its own words", () => {
    writeFileSync(join(src, "auth.json"), login(MIN));
    expect(() =>
      engineCredentials({
        srcDir: src,
        needMs: HOUR,
        words: { ...ENGINE_AUTH_WORDS, expiring: () => "custom words" },
      }),
    ).toThrow("custom words");
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
    const { credentials } = engineCredentials({ srcDir: src, needMs: HOUR });
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
    const { credentials } = engineCredentials({
      srcDir: src,
      needMs: MIN,
      now: () => Date.now() - 2 * HOUR,
    });
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

  it("the headless key route: setRuntimeApiKey keys the runtime in memory only", async () => {
    rig = await createHostRig({ credentials: keyOnlyCredentials() });
    const runtime = rig.host.modelRuntime;
    await setRuntimeApiKey(runtime, "openai", "sk-headless");
    expect(await runtime.getAuth("openai")).toMatchObject({ auth: { apiKey: "sk-headless" } });
    expect(existsSync(join(rig.host.agentDir, "auth.json"))).toBe(false);
  });
});

describe("the headless key route", () => {
  function target() {
    const calls: Array<[string, string]> = [];
    return {
      calls,
      setRuntimeApiKey: async (p: string, k: string) => void calls.push([p, k]),
    };
  }

  it("setRuntimeApiKey refuses an empty key", async () => {
    const t = target();
    await expect(setRuntimeApiKey(t, "openai", "  ")).rejects.toThrow("empty API key");
    expect(t.calls).toEqual([]);
  });

  it("applyEnvApiKeys keys only the providers whose variable is set", async () => {
    const t = target();
    const keyed = await applyEnvApiKeys(t, {
      OPENAI_API_KEY: "sk-o",
      ANTHROPIC_API_KEY: "",
      GEMINI_API_KEY: "g-1",
      UNRELATED: "x",
    });
    expect(keyed).toEqual(["openai", "google"]);
    expect(t.calls).toEqual([
      ["openai", "sk-o"],
      ["google", "g-1"],
    ]);
  });

  it("applyEnvApiKeys can be narrowed to the run's provider", async () => {
    const t = target();
    await applyEnvApiKeys(t, { OPENAI_API_KEY: "sk-o", DIGITALOCEAN_API_KEY: "do" }, [
      "digitalocean",
    ]);
    expect(t.calls).toEqual([["digitalocean", "do"]]);
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
