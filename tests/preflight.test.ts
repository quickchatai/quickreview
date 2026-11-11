// `daemon --preflight`: each named failure, the clean pass, and that the
// live inputs are only read (hash and mtime compare, mounted-read-only shape).
//
// The `login` check is "a model route resolves": the real pi is asked, over a
// temp agent dir, which model a review would run on. The default fixture's
// credential is a key in that dir's models.json (a provider of its own); the
// login cases give a built-in provider a key file, an environment key or a
// stored login. Nothing is sent anywhere (the offline guard fails the file on
// any attempt), and the developer's own keys never count: the environment is
// the one each case gives.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
// Loaded here so the check's pi SDK is not on a test's clock.
import "@quickchatai/pi-quickreview/src/engine/pisdk.js";
import "@quickchatai/pi-quickreview/src/reviewhost.js";
import { DISABLED_REFRESH } from "@quickchatai/pi-quickreview/src/engine/auth.js";
import { MODEL_ENV_DIR } from "../src/modelenv.js";
import {
  DEFAULT_WORK_WINDOW_MIN,
  runPreflight,
  type PreflightOptions,
  type PreflightReport,
} from "../src/preflight.js";
import { StateStore } from "../src/state.js";
import { FAKE_ROUTE_MODEL, writeFakeProvider } from "./helpers/fake-openai.js";
import { HEAVY_TIMEOUT_MS } from "./helpers/suite-timeouts.js";
import { useOfflineGuard } from "./pi-canary/harness.js";

useOfflineGuard();

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const GOOD_CONFIG = readFileSync(join(root, "config.example.toml"), "utf8");
const NOW = Date.parse("2026-10-20T12:00:00Z");
/** A built-in provider no case has a credential for unless it gives one. */
const BUILTIN = "deepseek";
const BUILTIN_NAME = builtinProviders().find((p) => p.id === BUILTIN)!.name;
const BUILTIN_ENV = "DEEPSEEK_API_KEY";
/** Never listened on: no case sends a request. */
const NOWHERE = "http://127.0.0.1:9/v1";

let dir: string;
let opts: PreflightOptions;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "qcr-preflight-test-"));
  const state = join(dir, "state");
  const cfg = join(dir, "config-home");
  const agent = join(dir, "pihome", "agent");
  for (const d of [state, cfg, agent, join(state, "pi-sessions", "pr-7")])
    mkdirSync(d, { recursive: true });
  const store = new StateStore(join(state, "state.db"));
  store.upsertPr({
    number: 7,
    state: "awaiting_author",
    head_sha: "abc",
    title: "t",
    author: "a",
    trigger_ts: null,
    stale_recheck: 0,
    migration_gate: 0,
  });
  store.upsertPr({
    number: 8,
    state: "closed",
    head_sha: "abc",
    title: "t",
    author: "a",
    trigger_ts: null,
    stale_recheck: 0,
    migration_gate: 0,
  });
  store.db.pragma("wal_checkpoint(TRUNCATE)");
  store.db.close();
  const lines = [
    {
      type: "session",
      version: 3,
      id: "sess-7",
      timestamp: "2026-10-01T00:00:00Z",
      cwd: "/opt/quickreview/sandbox/wt/pr-7",
    },
    {
      type: "message",
      id: "m1",
      parentId: null,
      timestamp: "2026-10-01T00:00:01Z",
      message: { role: "user", content: [{ type: "text", text: "hello" }], timestamp: 1 },
    },
  ];
  writeFileSync(
    join(state, "pi-sessions", "pr-7", "s.jsonl"),
    lines.map((l) => JSON.stringify(l)).join("\n") + "\n",
  );
  writeFileSync(join(cfg, "config.toml"), GOOD_CONFIG);
  // The credential: a key in pi's models.json, for a provider of its own with
  // a model a review can run on. No login file.
  writeFakeProvider(agent, NOWHERE, { routable: true });
  opts = { stateDir: state, configHome: cfg, agentDir: agent, root, now: () => NOW };
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const failed = (r: PreflightReport): string[] => r.checks.filter((c) => !c.ok).map((c) => c.name);
const reason = (r: PreflightReport, n: string): string =>
  r.checks.find((c) => c.name === n)?.reason ?? "";
const detail = (r: PreflightReport, n: string): string =>
  r.checks.find((c) => c.name === n)?.detail ?? "";
/** pi's agent dir with no credential in it at all. */
const noCredential = (): void => writeFileSync(join(opts.agentDir, "models.json"), "{}");
/** Write the login file with one stored login for the built-in provider. */
const storedLogin = (entry: Record<string, unknown>, at = opts.agentDir): void =>
  writeFileSync(join(at, "auth.json"), JSON.stringify({ [BUILTIN]: { type: "oauth", ...entry } }));
/** A secrets dir holding `files` under its model env. */
const secretsWith = (files: Record<string, string>): string => {
  const secrets = join(dir, "secrets");
  mkdirSync(join(secrets, MODEL_ENV_DIR), { recursive: true });
  for (const [name, value] of Object.entries(files))
    writeFileSync(join(secrets, MODEL_ENV_DIR, name), value);
  return secrets;
};

function snapshot(d: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (p: string): void => {
    for (const e of readdirSync(p, { withFileTypes: true })) {
      const f = join(p, e.name);
      if (e.isDirectory()) walk(f);
      else
        out[f] = createHash("sha256").update(readFileSync(f)).digest("hex") + statSync(f).mtimeMs;
    }
  };
  walk(d);
  return out;
}

describe("daemon --preflight", () => {
  it(
    "passes a clean legacy-shaped copy and changes nothing it was given",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      const before = snapshot(dir);
      const r = await runPreflight(opts);
      expect(failed(r), JSON.stringify(r)).toEqual([]);
      expect(r.ok).toBe(true);
      expect(r.checks.find((c) => c.name === "resume")?.detail).toContain(
        "1 open PR(s), 1 session file(s)",
      );
      expect(snapshot(dir)).toEqual(before);
      expect(readdirSync(join(dir, "state")).sort()).toEqual(["pi-sessions", "state.db"]);
    },
  );

  it(
    "passes with the live state read-only, so it cannot have written there",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      const state = opts.stateDir;
      const before = snapshot(dir);
      const dirs = [state, join(state, "pi-sessions"), join(state, "pi-sessions", "pr-7")];
      for (const d of dirs) chmodSync(d, 0o500);
      try {
        const r = await runPreflight(opts);
        expect(failed(r), JSON.stringify(r)).toEqual([]);
      } finally {
        for (const d of dirs.reverse()) chmodSync(d, 0o700);
      }
      expect(snapshot(dir)).toEqual(before);
    },
  );

  it(
    "inspects a transcript nested under a cwd-named subdirectory, as runtime discovery does",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      const sess = join(opts.stateDir, "pi-sessions", "pr-7");
      mkdirSync(join(sess, "--cwd--"));
      writeFileSync(join(sess, "--cwd--", "n.jsonl"), "{not json\n");
      const r = await runPreflight(opts);
      expect(failed(r)).toEqual(["resume"]);
      expect(reason(r, "resume")).toContain("pr-7/--cwd--/n.jsonl");
    },
  );

  it(
    "a session directory that cannot be listed fails the check; an absent one is no session",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      const sess = join(opts.stateDir, "pi-sessions", "pr-7");
      chmodSync(sess, 0o000);
      try {
        if (process.getuid?.() === 0) return; // root lists anything
        const r = await runPreflight(opts);
        expect(failed(r)).toEqual(["resume"]);
        expect(reason(r, "resume")).toContain("cannot list the session directory");
      } finally {
        chmodSync(sess, 0o700);
      }
      rmSync(sess, { recursive: true });
      expect(failed(await runPreflight(opts))).toEqual([]);
    },
  );

  it("fails a corrupt JSONL by name", { timeout: HEAVY_TIMEOUT_MS }, async () => {
    writeFileSync(join(opts.stateDir, "pi-sessions", "pr-7", "s.jsonl"), "{not json\n");
    const r = await runPreflight(opts);
    expect(failed(r)).toEqual(["resume"]);
    expect(reason(r, "resume")).toContain("pr-7/s.jsonl");
  });

  it("fails a migration error", { timeout: HEAVY_TIMEOUT_MS }, async () => {
    writeFileSync(
      join(opts.stateDir, "state.db"),
      "this is not a database, and it is long enough to be read as one".repeat(5),
    );
    const r = await runPreflight(opts);
    expect(failed(r)).toContain("migrations");
    expect(reason(r, "migrations")).toContain("migrating the scratch copy");
  });

  it("fails an unparsable models.json", { timeout: HEAVY_TIMEOUT_MS }, async () => {
    writeFileSync(join(opts.agentDir, "models.json"), "{oops");
    const r = await runPreflight(opts);
    expect(failed(r)).toEqual(["models"]);
  });

  it(
    "fails a socket path that cannot fit a unix socket",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      const deep = join(dir, "x".repeat(120), "state");
      mkdirSync(deep, { recursive: true });
      const r = await runPreflight({ ...opts, stateDir: deep });
      expect(reason(r, "socket")).toContain("bytes");
    },
  );

  it(
    "fails when the scratch parent cannot hold a private dir",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      const ro = join(dir, "ro");
      mkdirSync(ro);
      chmodSync(ro, 0o500);
      if (process.getuid?.() === 0) return;
      await expect(runPreflight({ ...opts, scratchParent: ro })).rejects.toThrow();
      chmodSync(ro, 0o700);
    },
  );

  it("fails a config the new image would refuse", { timeout: HEAVY_TIMEOUT_MS }, async () => {
    writeFileSync(join(opts.configHome, "config.toml"), "this is = not [valid");
    const r = await runPreflight(opts);
    expect(failed(r)).toEqual(["config"]);
  });

  it("reaches no network: the module imports no http client", () => {
    const src = readFileSync(join(root, "src", "preflight.ts"), "utf8");
    expect(src).not.toMatch(/node:(http|https|net|dns)|fetch\(/);
  });
});

// The login check is "a model route resolves" over the credentials a worker
// will have: the login dir's stored logins and keys, and the model env of the
// secrets dir. Unknown is never ok.
describe("daemon --preflight: a model route resolves", () => {
  const login = async (over: Partial<PreflightOptions> = {}): Promise<PreflightReport> =>
    runPreflight({ ...opts, ...over });

  it(
    "says which model runs, on which provider and credential",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      const r = await login();
      expect(failed(r), JSON.stringify(r)).toEqual([]);
      expect(detail(r, "login")).toBe(
        `runs ${FAKE_ROUTE_MODEL} (local, a key in pi's models.json)`,
      );
    },
  );

  // MUTATION: return ok from the login check when no route resolves — this fails.
  it(
    "fails with the refusal's own words when pi has no credential at all",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      noCredential();
      const r = await login();
      expect(failed(r)).toEqual(["login"]);
      expect(detail(r, "login")).toBe("no model route");
      expect(reason(r, "login")).toContain("pi has no model credential");
      expect(reason(r, "login")).toContain("qcr login");
    },
  );

  // A daemon whose credential is a key file has no login to show: the file
  // under <secrets>/model-env is the credential, read by the daemon's loader.
  // MUTATION: leave the secrets dir's model env out of the route host's
  // authEnv in src/preflight.ts — this fails, and so would every release of a
  // key-file install.
  it(
    "no login file is fine when the credential is a key under the secrets dir's model env",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      noCredential();
      const secretsDir = secretsWith({ [BUILTIN_ENV]: "value-from-the-secrets-dir\n" });
      const r = await login({ secretsDir });
      expect(failed(r), JSON.stringify(r)).toEqual([]);
      expect(detail(r, "login")).toMatch(
        new RegExp(`^runs ${BUILTIN}/\\S+ \\(${BUILTIN_NAME}, ${BUILTIN_ENV}\\)$`),
      );
      // never a key in the report
      expect(JSON.stringify(r)).not.toContain("value-from-the-secrets-dir");
      // and without the secrets dir the same home has nothing
      expect(failed(await login())).toEqual(["login"]);
    },
  );

  it(
    "the older openai_api_key file is a credential too",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      noCredential();
      const secretsDir = secretsWith({});
      writeFileSync(join(secretsDir, "openai_api_key"), "value-from-the-older-file\n");
      const r = await login({ secretsDir });
      expect(failed(r), JSON.stringify(r)).toEqual([]);
      expect(detail(r, "login")).toContain("OPENAI_API_KEY");
      expect(JSON.stringify(r)).not.toContain("value-from-the-older-file");
    },
  );

  it(
    "a key in the environment the check is given counts, and one it is not given does not",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      noCredential();
      const r = await login({ env: { [BUILTIN_ENV]: "not-a-key" } });
      expect(failed(r), JSON.stringify(r)).toEqual([]);
      expect(detail(r, "login")).toContain(`(${BUILTIN_NAME}, ${BUILTIN_ENV})`);
      // this process's own environment is never read: only what the options name
      const prior = process.env[BUILTIN_ENV];
      process.env[BUILTIN_ENV] = "not-a-key";
      try {
        expect(failed(await login())).toEqual(["login"]);
      } finally {
        if (prior === undefined) delete process.env[BUILTIN_ENV];
        else process.env[BUILTIN_ENV] = prior;
      }
    },
  );

  // The existing rule, narrowed to the providers a route can use: a stored
  // login counts when it has a refresh token (the refresher renews it) or is
  // good for the work window.
  // MUTATION: count every stored login in shortLogins as lasting — the
  // ten-minute login with no refresh token passes and this fails.
  it(
    "a stored login must be refreshable or good for the work window",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      noCredential();
      // refreshable, and its access token already ran out: the refresher's to renew
      storedLogin({ access: "a", refresh: "r", expires: NOW - 3600_000 });
      const renewable = await login();
      expect(failed(renewable), JSON.stringify(renewable)).toEqual([]);
      expect(detail(renewable, "login")).toMatch(
        new RegExp(`^runs ${BUILTIN}/\\S+ \\(${BUILTIN_NAME}, signed in with pi`),
      );
      // no refresh token, and it runs out inside the window
      storedLogin({ access: "a", refresh: DISABLED_REFRESH, expires: NOW + 600_000 });
      const short = await login();
      expect(failed(short)).toEqual(["login"]);
      expect(reason(short, "login")).toBe(
        `the ${BUILTIN_NAME} login has no refresh token and expires inside the ${DEFAULT_WORK_WINDOW_MIN}-minute work window`,
      );
      // no refresh token, and it outlasts the window
      storedLogin({ access: "a", refresh: DISABLED_REFRESH, expires: NOW + 24 * 3600_000 });
      expect(failed(await login())).toEqual([]);
    },
  );

  it(
    "a login that cannot last is left out, and another credential still runs the bot",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      storedLogin({ access: "a", refresh: DISABLED_REFRESH, expires: NOW + 600_000 });
      const r = await login();
      expect(failed(r), JSON.stringify(r)).toEqual([]);
      expect(detail(r, "login")).toBe(
        `runs ${FAKE_ROUTE_MODEL} (local, a key in pi's models.json); left out: the ${BUILTIN_NAME} login (no refresh token)`,
      );
    },
  );

  // MUTATION: treat a login file that does not parse as no login — the check
  // passes on the models.json key and this fails.
  it(
    "a login file that cannot be read fails the check: unknown is never ok",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      const file = join(opts.agentDir, "auth.json");
      writeFileSync(file, "{ not json");
      const broken = await login();
      expect(failed(broken)).toEqual(["login"]);
      expect(reason(broken, "login")).toContain("could not read pi's credentials");
      expect(reason(broken, "login")).toContain(file);
      writeFileSync(file, "[]");
      const list = await login();
      expect(failed(list)).toEqual(["login"]);
      expect(reason(list, "login")).toContain("is not a JSON object");
    },
  );

  // MUTATION: read the login from agentDir whatever loginDir says — the
  // shared login is not seen and this fails.
  it(
    "reads the login where the daemon was handed one, and the catalog in pi's own agent dir",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      noCredential();
      const shared = join(dir, "shared-login");
      mkdirSync(shared);
      storedLogin({ access: "a", refresh: "r", expires: NOW + 24 * 3600_000 }, shared);
      expect(failed(await login())).toEqual(["login"]);
      const r = await login({ loginDir: shared });
      expect(failed(r), JSON.stringify(r)).toEqual([]);
      expect(detail(r, "login")).toContain(`runs ${BUILTIN}/`);
    },
  );

  it(
    "a level with no model in [models] model is no pin, and a pinned model is the one named",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      expect(detail(await login({ model: ":high" }), "login")).toContain(
        `runs ${FAKE_ROUTE_MODEL} `,
      );
      const pinned = await login({ model: "local/m:high" });
      expect(failed(pinned), JSON.stringify(pinned)).toEqual([]);
      expect(detail(pinned, "login")).toContain("runs local/m");
    },
  );

  // MUTATION: build the path from the config home instead of taking the
  // located one — a config read through $QCR_CONFIG is named wrongly and this fails.
  it(
    "a pin with no credential names the config file that was located",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      const located = join(dir, "elsewhere", "custom.toml");
      const r = await login({ model: `${BUILTIN}/some-model`, configPath: located });
      expect(failed(r)).toEqual(["login"]);
      expect(reason(r, "login")).toContain(`[models] model in ${located}`);
    },
  );
});

describe("the image carries the preflight", () => {
  it("labels qcr.preflight and dispatches the flag without starting the bot", () => {
    expect(readFileSync(join(root, "docker/Dockerfile"), "utf8")).toMatch(/qcr\.preflight="true"/);
    const ep = readFileSync(join(root, "docker/entrypoint.sh"), "utf8");
    expect(ep).toMatch(/--preflight[\s\S]{0,120}preflight\.js/);
  });
});
