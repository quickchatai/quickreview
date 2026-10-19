// reviewSdkRuntime (src/engine/reviewsdk.ts): the runtime `qcr review` hosts its
// main session on under `[engine] runtime = "sdk"`, here over pi-ai's faux
// provider (the real SDK, no network, no model). What it builds its host from,
// what it refuses before any host exists, and what the process env carries while
// a session lives.
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { AuthExpiring, DISABLED_REFRESH } from "../src/engine/auth.js";
import { PiHost, type PiHostOptions } from "../src/engine/pisdk.js";
import type { SessionSpec } from "../src/engine/port.js";
import { reviewSdkRuntime } from "../src/engine/reviewsdk.js";
import { REPO_ROOT } from "./helpers/round-rig.js";
import { pricedFaux } from "./helpers/priced-faux.js";
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

  it("refuses a login that would expire inside the turn, before any host exists", async () => {
    login(Date.now() + 60_000);
    const seen: PiHostOptions[] = [];
    const rt = reviewSdkRuntime({ makeHost: fauxHost(seen), lens: noLens });
    await expect(rt.create(spec())).rejects.toBeInstanceOf(AuthExpiring);
    expect(seen).toEqual([]);
  });

  it("refuses a spec with no agent dir, or a relative one", async () => {
    const rt = reviewSdkRuntime({ makeHost: fauxHost([]), lens: noLens });
    await expect(rt.create(spec({ env: {} }))).rejects.toThrow(/PI_CODING_AGENT_DIR/);
    await expect(rt.create(spec({ env: { PI_CODING_AGENT_DIR: "rel/agent" } }))).rejects.toThrow(
      /absolute/,
    );
  });

  it("gives an API key in the spec's env to the runtime, in memory (the key route)", async () => {
    writeFileSync(join(agentDir, "auth.json"), "{}\n");
    let keyed: Array<[string, string]> = [];
    const seen: PiHostOptions[] = [];
    const rt = reviewSdkRuntime({ makeHost: fauxHost(seen), lens: noLens });
    const s = await rt.create(spec({}, { OPENAI_API_KEY: "sk-test" }));
    await s.dispose();
    await seen[0]!.configureModels!({
      setRuntimeApiKey: async (p: string, k: string) => void keyed.push([p, k]),
    } as never);
    expect(keyed).toEqual([["openai", "sk-test"]]);
    keyed = [];
  });

  describe("the tool uid (D32)", () => {
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

    it("refuses the native lens tool under the split: its pi children would run the model's bash as this uid", async () => {
      login(Date.now() + 3 * 3_600_000);
      const seen: PiHostOptions[] = [];
      const rt = reviewSdkRuntime({ makeHost: fauxHost(seen), processEnv: split });
      await expect(rt.create(spec())).rejects.toThrow(/native lens tool.*lens_runtime = engine/);
      expect(seen).toEqual([]);
      // accepted explicitly, it runs
      const shared = reviewSdkRuntime({
        makeHost: fauxHost(seen),
        processEnv: { QCR_TOOL_UID_REQUIRED: "1", QCR_ALLOW_SHARED_TOOL_UID: "1" },
      });
      await (await shared.create(spec())).dispose();
      expect(seen).toHaveLength(1);
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

  describe("the native lens tool", () => {
    const saved: Record<string, string | undefined> = {};
    const keep = (n: string): void => {
      saved[n] = process.env[n];
    };
    afterEach(() => {
      for (const [n, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[n];
        else process.env[n] = v;
      }
    });

    it("sees the round's env and no GitHub token while the session lives, and the process gets its env back", async () => {
      login(Date.now() + 3 * 3_600_000);
      for (const n of ["GH_TOKEN", "GITHUB_TOKEN", "QCR_PR", "PI_CODING_AGENT_DIR"]) keep(n);
      process.env["GH_TOKEN"] = "ghp_secret";
      process.env["GITHUB_TOKEN"] = "ghp_secret2";
      process.env["QCR_PR"] = "before";
      const during: Record<string, string | undefined> = {};
      let tools = "";
      const rt = reviewSdkRuntime({
        makeHost: fauxHost([], (context) => {
          tools = JSON.stringify(context);
          for (const n of ["GH_TOKEN", "GITHUB_TOKEN", "QCR_PR", "PI_CODING_AGENT_DIR"])
            during[n] = process.env[n];
        }),
      });
      const s = await rt.create(spec());
      expect((await s.prompt("go")).code).toBe(0);
      await s.dispose();
      expect(tools).toContain("launch_plan");
      // the lens tool loaded without an extension error
      expect(readFileSync(join(dir, "stderr.log"), "utf8")).not.toMatch(/Extension error/);
      expect(during).toEqual({
        GH_TOKEN: undefined,
        GITHUB_TOKEN: undefined,
        QCR_PR: "7",
        PI_CODING_AGENT_DIR: agentDir,
      });
      expect(process.env["GH_TOKEN"]).toBe("ghp_secret");
      expect(process.env["GITHUB_TOKEN"]).toBe("ghp_secret2");
      expect(process.env["QCR_PR"]).toBe("before");
    });

    it("puts the env back when the session cannot be made", async () => {
      login(Date.now() + 3 * 3_600_000);
      keep("QCR_PR");
      process.env["QCR_PR"] = "before";
      const rt = reviewSdkRuntime({
        makeHost: fauxHost([]),
        lens: undefined,
      });
      await expect(rt.create(spec({ model: "faux/nope" }))).rejects.toThrow(/not known/);
      expect(process.env["QCR_PR"]).toBe("before");
    });
  });
});

describe("selectReviewRuntime ([engine] runtime for qcr review)", () => {
  it("proc keeps the review's own process runtime; sdk selects the SDK one and marks the route", async () => {
    const { selectReviewRuntime } = await import("../src/reviewcli.js");
    const { onSdkRoute, resetLiveSessions } = await import("../src/engine/livesessions.js");
    const { parseConfig } = await import("../src/config.js");
    const base = readFileSync(join(REPO_ROOT, "tests", "fixtures", "config.toml"), "utf8");
    resetLiveSessions();
    try {
      expect(selectReviewRuntime(parseConfig(base))).toBeUndefined();
      expect(onSdkRoute()).toBe(false);
      const rt = selectReviewRuntime(parseConfig(`${base}\n[engine]\nruntime = "sdk"\n`));
      expect(rt).toBeDefined();
      expect(onSdkRoute()).toBe(true);
    } finally {
      resetLiveSessions();
    }
  });

  it("lens_runtime = engine needs the SDK runtime, and carries the engine route with it", async () => {
    const { selectReviewRuntime } = await import("../src/reviewcli.js");
    const { resetLiveSessions } = await import("../src/engine/livesessions.js");
    const { parseConfig } = await import("../src/config.js");
    const base = readFileSync(join(REPO_ROOT, "tests", "fixtures", "config.toml"), "utf8");
    const engine = (extra: string) =>
      parseConfig(`${base}\n${extra}`.replace(/^\[pi\]\s*$/m, '[pi]\nlens_runtime = "engine"'));
    expect(() => selectReviewRuntime(engine(""))).toThrow(/set \[engine\] runtime = sdk/);
    try {
      const rt = selectReviewRuntime(engine('[engine]\nruntime = "sdk"\n'));
      expect(rt?.engineLens).toMatchObject({ plannedWave: false });
      // the native default has no engine route
      expect(
        selectReviewRuntime(parseConfig(`${base}\n[engine]\nruntime = "sdk"\n`))?.engineLens,
      ).toBeUndefined();
    } finally {
      resetLiveSessions();
    }
  });
});
