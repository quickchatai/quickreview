// reviewSdkRuntime (packages/pi-plugin/src/engine/reviewsdk.ts): the runtime `qcr review` hosts its
// main session on under `[engine] runtime = "sdk"`, here over pi-ai's faux
// provider (the real SDK, no network, no model). What it builds its host from,
// what it refuses before any host exists, what it leaves to the host's route
// to refuse (a login too short for the turn), and what the process env carries
// while a session lives.
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import {
  DISABLED_REFRESH,
  keyOnlyCredentials,
} from "@quickchatai/pi-quickreview/src/engine/auth.js";
import { RouteRefused, type ModelRoute } from "@quickchatai/pi-quickreview/src/modelroute.js";
import { PiHost, type PiHostOptions } from "@quickchatai/pi-quickreview/src/engine/pisdk.js";
import type { SessionSpec } from "@quickchatai/pi-quickreview/src/engine/port.js";
import {
  reviewHostOptions,
  reviewSdkRuntime,
} from "@quickchatai/pi-quickreview/src/engine/reviewsdk.js";
import { REPO_ROOT } from "./helpers/round-rig.js";
import { pricedFaux, ROUTABLE_FAUX_MODEL, routableFaux } from "./helpers/priced-faux.js";
import { HEAVY_TIMEOUT_MS } from "./helpers/suite-timeouts.js";
import { useOfflineGuard } from "./pi-canary/harness.js";

useOfflineGuard();

const tmp = mkdtempSync(join(tmpdir(), "review-sdk-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

let dir: string;
let agentDir: string;
let hosts: PiHost[];
beforeEach(() => {
  dir = mkdtempSync(join(tmp, "t-"));
  agentDir = join(dir, "agent");
  mkdirSync(agentDir);
  hosts = [];
});
afterEach(() => {
  for (const h of hosts) h.dispose();
});

const login = (expires: number): void => {
  writeFileSync(
    join(agentDir, "auth.json"),
    JSON.stringify({
      "openai-codex": { type: "oauth", access: "a", refresh: "real-refresh", expires },
    }),
  );
  chmodSync(join(agentDir, "auth.json"), 0o600);
};

const spec = (over: Partial<SessionSpec> = {}, env: Record<string, string> = {}): SessionSpec => ({
  cwd: dir,
  env: {
    PATH: process.env["PATH"],
    PI_CODING_AGENT_DIR: agentDir,
    QCR_SANDBOX_ROOT: REPO_ROOT,
    QCR_PR: "7",
    ...env,
  },
  model: "faux/m",
  eventsFile: join(dir, "events.jsonl"),
  stderrFile: join(dir, "stderr.log"),
  limits: { timeoutMs: 20_000 },
  ...over,
});

/** A host builder over a faux provider; records the options it was given. */
function fauxHost(seen: PiHostOptions[], onTurn: (context: unknown) => void = () => {}) {
  const faux = pricedFaux(() => 0.1, { provider: "faux", models: [{ id: "m" }] });
  faux.appendResponses(
    Array.from({ length: 4 }, () => async (context: unknown) => {
      onTurn(context);
      return fauxAssistantMessage("done");
    }),
  );
  return async (o: PiHostOptions): Promise<PiHost> => {
    seen.push(o);
    const host = await PiHost.create({
      ...o,
      // no network, no dispatcher: the test process is not the review's
      ownsProcess: false,
      settings: { ...o.settings, compaction: { enabled: false } },
      configureModels: async (r) => {
        await o.configureModels?.(r);
        r.registerNativeProvider(faux.provider);
      },
    });
    hosts.push(host);
    return host;
  };
}

const noLens = () => ({ factories: [], toolNames: [] });

describe("reviewSdkRuntime", () => {
  it("builds its host on the run's agent dir, read-only, with the dir's settings", async () => {
    login(Date.now() + 3 * 3_600_000);
    writeFileSync(
      join(agentDir, "settings.json"),
      JSON.stringify({
        extensions: ["/x/bash-guard.ts"],
        retry: { enabled: true, maxRetries: 9 },
        httpIdleTimeoutMs: 120_000,
      }),
    );
    const seen: PiHostOptions[] = [];
    const rt = reviewSdkRuntime({ makeHost: fauxHost(seen), lens: noLens });
    const s = await rt.create(spec());
    expect((await s.prompt("go")).code).toBe(0);
    await s.dispose();

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      agentDir,
      ownsProcess: true,
      settings: { retry: { enabled: true, maxRetries: 9 }, httpIdleTimeoutMs: 120_000 },
    });
    // the extension list is the process route's business; an SDK host loads factories only
    expect(seen[0]!.settings).not.toHaveProperty("extensions");
    // a read-only copy: refresh is blanked and nothing can change it
    const cred = (await seen[0]!.credentials!.read("openai-codex")) as { refresh: string };
    expect(cred.refresh).toBe(DISABLED_REFRESH);
    await expect(
      seen[0]!.credentials!.modify("openai-codex", async () => undefined),
    ).rejects.toThrow(/read-only copy/);
  });

  it("builds one host per agent dir, however many sessions", async () => {
    login(Date.now() + 3 * 3_600_000);
    const seen: PiHostOptions[] = [];
    const rt = reviewSdkRuntime({ makeHost: fauxHost(seen), lens: noLens });
    const a = await rt.create(spec());
    const b = await rt.create(
      spec({ eventsFile: join(dir, "e2.jsonl"), stderrFile: join(dir, "s2") }),
    );
    await a.dispose();
    await b.dispose();
    expect(seen).toHaveLength(1);
  });

  // The agent dir's own login is borrowed with nothing to renew it. The three
  // situations the runtime once refused by itself, at the same seam:

  // MUTATION: refuse in reviewHostOptions when the agent dir's login would
  // expire inside the turn (the retired refusing borrow) - no host is built and
  // the first session throws.
  // MUTATION: drop the borrow's `skipped` from the route reviewHostOptions
  // hands the host - the session on that provider is refused as a pin with no
  // credential instead, and this fails.
  it("a login that would expire inside the turn is left out and named to the route: only a session on it is refused", async () => {
    const expires = Date.now() + 60_000;
    login(expires);
    const skipped = [{ provider: "openai-codex", name: "openai-codex", expiresAt: expires }];
    const seen: PiHostOptions[] = [];
    const rt = reviewSdkRuntime({ makeHost: fauxHost(seen), lens: noLens, processEnv: {} });

    // A session on another provider runs: the login left out is not its.
    const s = await rt.create(spec());
    expect((await s.prompt("go")).code).toBe(0);
    await s.dispose();
    expect(seen).toHaveLength(1);
    expect(await seen[0]!.credentials!.list()).toEqual([]);
    expect(seen[0]!.route).toEqual({ skipped });

    // A session on the provider of the login left out is refused, in the
    // route's own words, and never moved.
    const refused = await rt
      .create(
        spec({
          model: "openai-codex/any-model",
          eventsFile: join(dir, "e2.jsonl"),
          stderrFile: join(dir, "s2"),
        }),
      )
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(refused).toBeInstanceOf(RouteRefused);
    expect((refused as RouteRefused).refusal).toEqual({ code: "login-too-short", logins: skipped });
  });

  // MUTATION: throw for a missing auth.json in reviewHostOptions (the retired
  // `missing` refusal) - a run whose only credential is a key in the
  // environment never starts, and this fails.
  it("no login file is an empty store, not a refusal: the host is built and nothing is written", async () => {
    const seen: PiHostOptions[] = [];
    const rt = reviewSdkRuntime({ makeHost: fauxHost(seen), lens: noLens, processEnv: {} });
    const s = await rt.create(spec());
    expect((await s.prompt("go")).code).toBe(0);
    await s.dispose();
    expect(await seen[0]!.credentials!.list()).toEqual([]);
    expect(seen[0]).not.toHaveProperty("route");
    expect(existsSync(join(agentDir, "auth.json"))).toBe(false);
  });

  // A file that does not parse is waited out first (a login being rewritten),
  // so this one takes the borrow's whole retry.
  it(
    "a login file that cannot be read is refused, typed, before any host exists",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      writeFileSync(join(agentDir, "auth.json"), "{ not json");
      const seen: PiHostOptions[] = [];
      const rt = reviewSdkRuntime({ makeHost: fauxHost(seen), lens: noLens, processEnv: {} });
      await expect(rt.create(spec())).rejects.toMatchObject({
        code: "unreadable",
        path: join(agentDir, "auth.json"),
      });
      expect(seen).toEqual([]);
    },
  );

  it("the logins left out join the route's own inputs; a route resolved before the run is used as it is", () => {
    const expires = Date.now() + 60_000;
    login(expires);
    const skipped = [{ provider: "openai-codex", name: "openai-codex", expiresAt: expires }];
    const at = { agentDir, needMs: 20_000 };
    const pin = { text: "faux/m", from: "flag" as const };
    expect(reviewHostOptions({ processEnv: {}, route: { pin } }, at).route).toEqual({
      pin,
      skipped,
    });
    const earlier = [{ provider: "other", name: "Other", expiresAt: 1 }];
    expect(reviewHostOptions({ processEnv: {}, route: { skipped: earlier } }, at).route).toEqual({
      skipped: [...earlier, ...skipped],
    });
    // A fixed route came with the login its own step borrowed: nothing is added.
    const fixed = { fixed: { spec: "faux/m" } as ModelRoute };
    expect(reviewHostOptions({ processEnv: {}, route: fixed }, at).route).toBe(fixed);
    // A login that lasts the turn leaves the route as it was handed, or absent.
    login(Date.now() + 3 * 3_600_000);
    expect(reviewHostOptions({ processEnv: {}, route: { pin } }, at).route).toEqual({ pin });
    expect(reviewHostOptions({ processEnv: {} }, at)).not.toHaveProperty("route");
  });

  it("refuses a spec with no agent dir, or a relative one", async () => {
    const rt = reviewSdkRuntime({ makeHost: fauxHost([]), lens: noLens });
    await expect(rt.create(spec({ env: {} }))).rejects.toThrow(/PI_CODING_AGENT_DIR/);
    await expect(rt.create(spec({ env: { PI_CODING_AGENT_DIR: "rel/agent" } }))).rejects.toThrow(
      /absolute/,
    );
  });

  /** The credential the host's inventory names for `provider`. */
  const credentialOf = async (provider: string) =>
    (await hosts.at(-1)!.inventory()).find((e) => e.provider === provider)?.credential;

  // MUTATION: drop `authEnv` from the host options in reviewSdkRuntime — pi
  // looks in the test process's env, finds neither key, and this fails.
  it("pi finds a provider key by its own lookup, in the spec's env over the process's (the key route)", async () => {
    writeFileSync(join(agentDir, "auth.json"), "{}\n");
    const seen: PiHostOptions[] = [];
    const rt = reviewSdkRuntime({
      makeHost: fauxHost(seen),
      lens: noLens,
      processEnv: { GROQ_API_KEY: "not-a-key" },
    });
    const s = await rt.create(spec({}, { OPENAI_API_KEY: "sk-test" }));
    expect(await credentialOf("openai")).toEqual({
      kind: "api_key",
      origin: "env-key",
      label: "OPENAI_API_KEY",
      subscription: false,
    });
    expect(await credentialOf("groq")).toMatchObject({ origin: "env-key", label: "GROQ_API_KEY" });
    // No key is handed to the runtime: nothing outranks what pi has stored.
    expect(seen[0]!.configureModels).toBeUndefined();
    await s.dispose();
  });

  // MUTATION: hand the env key to the runtime again (setRuntimeApiKey in a
  // configureModels) — the env key wins and this fails.
  it("a stored credential owns its provider: a key in the env for it does not outrank it", async () => {
    writeFileSync(
      join(agentDir, "auth.json"),
      JSON.stringify({ openai: { type: "api_key", key: "stored-key" } }),
    );
    const rt = reviewSdkRuntime({ makeHost: fauxHost([]), lens: noLens, processEnv: {} });
    const s = await rt.create(spec({}, { OPENAI_API_KEY: "sk-test" }));
    expect(await credentialOf("openai")).toMatchObject({ origin: "stored" });
    expect(await hosts.at(-1)!.modelRuntime.getAuth("openai")).toMatchObject({
      auth: { apiKey: "stored-key" },
    });
    await s.dispose();
  });

  // MUTATION: borrow the agent dir's auth.json whatever `credentials` says
  // (reviewHostOptions) — the host holds a store of its own, not the one the
  // route handed over, and this fails.
  it("a login the route borrowed is the host's: the agent dir holds no login file and none is read", async () => {
    const seen: PiHostOptions[] = [];
    const borrowed = keyOnlyCredentials();
    const rt = reviewSdkRuntime({ makeHost: fauxHost(seen), lens: noLens, credentials: borrowed });
    const s = await rt.create(spec());
    expect((await s.prompt("go")).code).toBe(0);
    await s.dispose();
    expect(seen).toHaveLength(1);
    expect(seen[0]!.credentials).toBe(borrowed);
    expect(existsSync(join(agentDir, "auth.json"))).toBe(false);
  });

  // MUTATION: drop `route` from the host options in reviewHostOptions — the
  // host resolves a route of its own, the pin is lost, and this fails.
  it("the route's inputs reach the host: a session whose spec names no model runs on the pin", async () => {
    const seen: PiHostOptions[] = [];
    const pin = { text: "faux/m", from: "flag" as const };
    const rt = reviewSdkRuntime({
      makeHost: fauxHost(seen),
      lens: noLens,
      credentials: keyOnlyCredentials(),
      route: { pin },
    });
    const s = await rt.create(spec({ model: "" }));
    expect(seen[0]!.route).toEqual({ pin });
    expect(await hosts[0]!.route()).toMatchObject({
      ok: true,
      route: { spec: "faux/m", source: "flag" },
    });
    expect((await s.prompt("go")).code).toBe(0);
    await s.dispose();
  });

  // MUTATION: build a host whatever `prebuilt` answers (runtimeFor) — a second
  // host is made, `seen` holds its options, and this fails.
  it("a host built before the run hosts its agent dir's sessions, and no other is built", async () => {
    const faux = routableFaux();
    faux.appendResponses([() => fauxAssistantMessage("done")]);
    // What the route does first: the host, from the options the runtime
    // itself would build it with, over a dir that holds no login.
    const options = reviewHostOptions(
      { processEnv: {}, ownsProcess: false, credentials: keyOnlyCredentials() },
      { agentDir, needMs: 60_000 },
    );
    expect(options).toMatchObject({ agentDir, ownsProcess: false, authEnv: {} });
    const prebuilt = await PiHost.create({
      ...options,
      configureModels: (r) => {
        r.registerNativeProvider(faux.provider);
      },
    });
    hosts.push(prebuilt);
    const route = await prebuilt.route();
    expect(route).toMatchObject({ ok: true, route: { spec: `faux/${ROUTABLE_FAUX_MODEL.id}` } });

    const seen: PiHostOptions[] = [];
    const asked: string[] = [];
    const rt = reviewSdkRuntime({
      makeHost: fauxHost(seen),
      lens: noLens,
      prebuilt: (dir) => {
        asked.push(dir);
        return dir === agentDir ? prebuilt : undefined;
      },
    });
    const s = await rt.create(spec({ model: "" }));
    expect((await s.prompt("go")).code).toBe(0);
    await s.dispose();
    expect(asked).toEqual([agentDir]);
    expect(seen).toEqual([]);
    // the turn was the prebuilt host's provider's
    expect(faux.state.callCount).toBe(1);

    // a dir it has no host for is built as always
    const other = join(dir, "other-agent");
    mkdirSync(other);
    writeFileSync(join(other, "auth.json"), "{}\n");
    const t = await rt.create(
      spec(
        { eventsFile: join(dir, "e2.jsonl"), stderrFile: join(dir, "s2") },
        { PI_CODING_AGENT_DIR: other },
      ),
    );
    await t.dispose();
    expect(seen.map((o) => o.agentDir)).toEqual([other]);
  });

  describe("the tool uid", () => {
    const split = { QCR_TOOL_UID: "65534", QCR_TOOL_GID: "1000" };

    it("runs the host's sessions' bash as the tool uid where the image names one", async () => {
      login(Date.now() + 3 * 3_600_000);
      const seen: PiHostOptions[] = [];
      const rt = reviewSdkRuntime({ makeHost: fauxHost(seen), lens: noLens, processEnv: split });
      await (await rt.create(spec())).dispose();
      expect(seen[0]!.toolUid).toEqual({ uid: "65534", gid: "1000" });
    });

    it("gives no tool uid where nothing asks for one, or where the shared uid was accepted", async () => {
      login(Date.now() + 3 * 3_600_000);
      for (const processEnv of [
        {},
        { QCR_TOOL_UID_REQUIRED: "1", QCR_ALLOW_SHARED_TOOL_UID: "1" },
      ]) {
        const seen: PiHostOptions[] = [];
        const rt = reviewSdkRuntime({ makeHost: fauxHost(seen), lens: noLens, processEnv });
        await (await rt.create(spec())).dispose();
        expect(seen[0]).not.toHaveProperty("toolUid");
      }
    });

    it("refuses where the entrypoint could not arrange the split, or named bad ids, before any host exists", async () => {
      login(Date.now() + 3 * 3_600_000);
      const seen: PiHostOptions[] = [];
      for (const processEnv of [
        { QCR_TOOL_UID_REQUIRED: "1" },
        { QCR_TOOL_UID: "0", QCR_TOOL_GID: "1000" },
        { QCR_TOOL_UID: "1" },
      ]) {
        const rt = reviewSdkRuntime({ makeHost: fauxHost(seen), lens: noLens, processEnv });
        await expect(rt.create(spec()), JSON.stringify(processEnv)).rejects.toThrow(
          /SDK runtime: .*(--cap-add SETUID|non-zero numeric ids)/,
        );
      }
      expect(seen).toEqual([]);
    });

    it("builds no session where no lens tool was given: there is no native tool to fall back on", async () => {
      login(Date.now() + 3 * 3_600_000);
      const rt = reviewSdkRuntime({ makeHost: fauxHost([]), processEnv: split });
      await expect(rt.create(spec())).rejects.toThrow(/no lens tool.*`engine`, `lens` or `extras`/);
    });

    it("fences the login the round's agent dir was copied from (the wrapper's /qcr-login)", async () => {
      login(Date.now() + 3 * 3_600_000);
      const seen: PiHostOptions[] = [];
      const rt = reviewSdkRuntime({
        makeHost: fauxHost(seen),
        lens: noLens,
        processEnv: {
          ...split,
          PI_CODING_AGENT_DIR: "/qcr-login",
          QCR_SCAN_AUTH_SRC: "/src/login",
        },
      });
      await (await rt.create(spec())).dispose();
      // the login sources first, then the credentials the envs point at
      expect(seen[0]!.fenceDirs!.slice(0, 2)).toEqual(["/qcr-login", "/src/login"]);
      expect(seen[0]!.fenceDirs).toContain("/opt/quickreview/secrets");
    });

    it("the engine lens route takes the split", async () => {
      login(Date.now() + 3 * 3_600_000);
      const seen: PiHostOptions[] = [];
      const rt = reviewSdkRuntime({
        makeHost: fauxHost(seen),
        processEnv: split,
        engine: { plannedWave: false },
      });
      await (await rt.create(spec())).dispose();
      expect(seen[0]!.toolUid).toEqual({ uid: "65534", gid: "1000" });
    });
  });
});

describe("selectReviewRuntime ([engine] runtime for qcr review)", () => {
  it("selects the SDK runtime and marks the route; the retired proc is refused at config load", async () => {
    const { selectReviewRuntime } = await import("../src/reviewcli.js");
    const { onSdkRoute, resetLiveSessions } =
      await import("@quickchatai/pi-quickreview/src/engine/livesessions.js");
    const { parseConfig } = await import("../src/config.js");
    const base = readFileSync(join(REPO_ROOT, "tests", "fixtures", "config.toml"), "utf8");
    resetLiveSessions();
    try {
      expect(() => parseConfig(`${base}\n[engine]\nruntime = "proc"\n`)).toThrow(/is retired/);
      expect(onSdkRoute()).toBe(false);
      // sdk is the default: no [engine] keys selects the SDK runtime
      const rt = selectReviewRuntime(parseConfig(base));
      expect(rt).toBeDefined();
      expect(onSdkRoute()).toBe(true);
    } finally {
      resetLiveSessions();
    }
  });

  it("lens_runtime = engine carries the engine route with it", async () => {
    const { selectReviewRuntime } = await import("../src/reviewcli.js");
    const { resetLiveSessions } =
      await import("@quickchatai/pi-quickreview/src/engine/livesessions.js");
    const { parseConfig } = await import("../src/config.js");
    const base = readFileSync(join(REPO_ROOT, "tests", "fixtures", "config.toml"), "utf8");
    const withPi = (lines: string, extra = ""): ReturnType<typeof parseConfig> =>
      parseConfig(`${base}\n${extra}`.replace(/^\[pi\]\s*$/m, `[pi]\n${lines}`));
    try {
      // the default: engine lenses and the planned wave on the SDK
      expect(selectReviewRuntime(parseConfig(base))?.engineLens).toMatchObject({
        plannedWave: true,
      });
      expect(selectReviewRuntime(withPi("engine_wave = false"))?.engineLens).toMatchObject({
        plannedWave: false,
      });
      // "native" is no longer a lens runtime: the config refuses it
      expect(() => withPi('lens_runtime = "native"')).toThrow(/retired/);
    } finally {
      resetLiveSessions();
    }
  });
});
