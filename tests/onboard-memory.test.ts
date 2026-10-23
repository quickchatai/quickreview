import { memoryUserKeysStep, MEMORY_KEYS_STEP_ID } from "../src/onboard/steps/memorykeys.js";
// The onboarding memory step — mint, place, prove.
//
// Everything is faked: a fake OpenViking (admin user routes + the confined
// read route) behind the adapters' fetch, temp dirs for the daemon-side
// secrets and the operator key file. No network, no server, no docker.
//
// The properties that matter, and why:
//   * a fresh install mints all three keys; a re-run rotates NOTHING;
//   * placement is the security boundary — root + reviewer daemon-side, both
//     USER keys operator-side, and the companion key NEVER anywhere under the
//     secrets dir (review sessions run in that container and can read it);
//   * the four-cell confinement matrix is the verification, and an
//     INCONCLUSIVE cell is not a pass;
//   * declining memory is legal, loud, mints nothing, and writes exactly one
//     thing: `[openviking] enabled = false`, the daemon's word for "off"
//     (without it, memory health pages about a choice).
//
// The provisioning and matrix modules under test are the REAL scripts — this
// suite drives them through a fake server rather than reimplementing them.
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { parseConfig } from "../src/config.js";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  OnboardingEngine,
  type OnboardAdapters,
  type ProcessResult,
  type StepReport,
} from "../src/onboard/engine.js";
import {
  COMPANION_VARS,
  DECLINED_CHECKS,
  MEMORY_CHOICE_KEY,
  MEMORY_STEP_ID,
  MEMORY_SWITCH_CHECK,
  REVIEWER_KEY_FILE,
  REVIEWER_VAR,
  ROOT_KEY_FILE,
  documentedKeysFile,
  filesContaining,
  forwardFlags,
  isInside,
  memoryStep,
  normalizeMemoryChoice,
  parseKeysFile,
  placeKeys,
  readKeysFile,
  renderKeysFile,
  resolveKeysFile,
  resolveSecretsDir,
  type MatrixModule,
  type MemoryStepOptions,
  type ProvisionModule,
} from "../src/onboard/steps/memory.js";
import { defaultSteps } from "../src/onboard/steps/index.js";

const provisionModule =
  (await import("../scripts/openviking-provision.mjs")) as unknown as ProvisionModule & {
    userKeysFromListing(body: unknown): Record<string, string>;
    keyFromCreate(body: unknown): string;
    mintRootKey(rand?: (n: number) => Buffer): string;
    listUsers(
      opts: Record<string, unknown>,
    ): Promise<{ users: string[] | null; keys: Record<string, string> }>;
  };
const matrixModule =
  (await import("../scripts/companion-memory-forward.mjs")) as unknown as MatrixModule;

let root: string;
let stateDir: string;
let secretsDir: string;
let keysFile: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "qcr-mem-step-"));
  // The checkout (and the config.toml beside it) under its own dir: both are
  // mounted into the daemon container, so the operator key file lives apart.
  stateDir = join(root, "checkout", "state");
  secretsDir = join(root, "secrets");
  keysFile = join(root, "operator", "openviking-keys.env");
  mkdirSync(stateDir, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

// ---- a fake OpenViking ------------------------------------------------------

interface FakeServerOptions {
  /** Users that already exist, user → key. */
  users?: Record<string, string>;
  ready?: boolean;
  unreachable?: boolean;
  /** Break one matrix cell: this (key-owner, namespace) pair answers 200 with
   * an unrecognised error envelope — i.e. INCONCLUSIVE. */
  murky?: { owner: string; ns: string };
  /** Let this (key-owner, namespace) pair through — a confinement FAILURE. */
  leaky?: { owner: string; ns: string };
}

function fakeServer(opts: FakeServerOptions = {}) {
  const users = new Map<string, string>(Object.entries(opts.users ?? {}));
  const calls: string[] = [];
  let minted = 0;

  const json = (status: number, body: unknown) =>
    ({ status, json: async () => body }) as unknown as Response;

  const ownerOf = (auth: string): string | null => {
    const key = auth.replace(/^Bearer\s+/, "");
    for (const [user, k] of users) if (k === key) return user;
    return null;
  };

  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push(`${method} ${url.pathname}`);
    if (url.pathname === "/ready" && opts.unreachable) throw new Error("connect ECONNREFUSED");
    if (url.pathname === "/ready") return json(opts.ready === false ? 503 : 200, { status: "ok" });
    if (url.pathname === "/api/v1/admin/accounts/default/users") {
      if (method === "GET") {
        return json(200, {
          status: "ok",
          result: [...users].map(([user_id, api_key]) => ({ user_id, role: "user", api_key })),
        });
      }
      const body = JSON.parse(String(init?.body ?? "{}")) as { user_id?: string };
      const user = String(body.user_id ?? "");
      if (users.has(user)) return json(409, { status: "error", error: { message: "exists" } });
      const key = `qcr.${user}.minted-${++minted}`;
      users.set(user, key);
      return json(200, {
        status: "ok",
        result: { account_id: "default", user_id: user, user_key: key },
      });
    }
    if (url.pathname === "/api/v1/fs/ls") {
      const ns = /viking:\/\/user\/([^/]*)\//.exec(url.searchParams.get("uri") ?? "")?.[1] ?? "";
      const owner = ownerOf(headers.Authorization ?? "");
      if (owner === null) return json(401, { status: "error", error: { message: "unauthorized" } });
      if (opts.murky && opts.murky.owner === owner && opts.murky.ns === ns) {
        return json(200, { status: "error", error: { message: "index not built" } });
      }
      if (owner === ns || (opts.leaky && opts.leaky.owner === owner && opts.leaky.ns === ns)) {
        return json(200, { status: "ok", result: [] });
      }
      return json(403, { status: "error", error: { message: "permission denied" } });
    }
    return json(404, { status: "error", error: { message: "no route" } });
  }) as unknown as typeof fetch;

  return { fetchFn, users, calls };
}

// ---- harness ----------------------------------------------------------------

function adapters(
  fetchFn: typeof fetch,
  prompter?: (q: string) => Promise<string>,
): OnboardAdapters {
  return {
    fetch: fetchFn,
    runner: {
      run: async () => ({ code: 0, stdout: "[]", stderr: "" }),
    },
    clock: () => new Date("2026-08-30T12:00:00Z"),
    host: { nodeVersion: "v22.5.1", uid: 1000 },
    paths: { stateDir, configPath: join(dirname(stateDir), "config.toml") },
    ...(prompter ? { prompter } : {}),
  };
}

function stepOptions(over: Partial<MemoryStepOptions> = {}): MemoryStepOptions {
  return {
    secretsDir,
    keysFile,
    base: "http://memory.test",
    account: "default",
    env: {},
    home: join(root, "home"),
    loadProvision: async () => provisionModule,
    loadMatrix: async () => matrixModule,
    ...over,
  };
}

function engineWith(
  fetchFn: typeof fetch,
  over: Partial<MemoryStepOptions> = {},
  prompter?: (q: string) => Promise<string>,
) {
  return new OnboardingEngine([memoryStep(stepOptions(over))], adapters(fetchFn, prompter));
}

async function runStep(engine: OnboardingEngine) {
  return engine.runStep(MEMORY_STEP_ID);
}

function detailOf(
  result: { checks: Array<{ name: string; detail: string; ok: boolean }> },
  name: string,
) {
  return result.checks.find((c) => c.name === name);
}

// ---- the mint machinery (the real script) -----------------------------------

describe("mint helpers on the existing provisioning machinery", () => {
  it("mints a cryptographically strong, separator-free root key", () => {
    const a = provisionModule.mintRootKey();
    const b = provisionModule.mintRootKey();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(40);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
    // 32 bytes of entropy, taken from the injected source.
    const fixed = provisionModule.mintRootKey(((n: number) => Buffer.alloc(n, 7)) as never);
    expect(Buffer.from(fixed, "base64url")).toHaveLength(32);
  });

  it("reads existing user keys out of the admin listing (that is what makes it no-rotate)", () => {
    const body = {
      status: "ok",
      result: [
        { user_id: "reviewer", role: "user", api_key: "K1" },
        { user_id: "companion", api_key: "K2" },
      ],
    };
    expect(provisionModule.userKeysFromListing(body)).toEqual({ reviewer: "K1", companion: "K2" });
    // Tolerant of shape; silent about users whose key is not there (never guessed).
    expect(provisionModule.userKeysFromListing({ users: [{ user: "reviewer" }] })).toEqual({});
    expect(provisionModule.userKeysFromListing("nonsense")).toEqual({});
    expect(provisionModule.keyFromCreate({ status: "ok", result: { user_key: "NEW" } })).toBe(
      "NEW",
    );
    expect(provisionModule.keyFromCreate({ status: "ok" })).toBe("");
  });

  it("mints missing users and keeps existing ones — a second run creates nothing", async () => {
    const server = fakeServer({ users: { reviewer: "EXISTING-REVIEWER" } });
    const first = await provisionModule.mintUserKeys({
      base: "http://memory.test",
      account: "default",
      users: ["reviewer", "companion"],
      rootKey: "ROOT",
      fetchFn: server.fetchFn,
    });
    expect(first.ok).toBe(true);
    expect(first.kept).toEqual(["reviewer"]);
    expect(first.created).toEqual(["companion"]);
    expect(first.keys.reviewer).toBe("EXISTING-REVIEWER");
    const companionKey = first.keys.companion;

    const second = await provisionModule.mintUserKeys({
      base: "http://memory.test",
      account: "default",
      users: ["reviewer", "companion"],
      rootKey: "ROOT",
      fetchFn: server.fetchFn,
    });
    expect(second.created).toEqual([]);
    expect(second.kept.sort()).toEqual(["companion", "reviewer"]);
    expect(second.keys).toEqual({ reviewer: "EXISTING-REVIEWER", companion: companionKey });
    expect(server.calls.filter((c) => c.startsWith("POST"))).toHaveLength(1);
  });

  it("creates NOTHING when the listing cannot be read (a wrong guess mints a duplicate identity)", async () => {
    const dead = (async () =>
      ({ status: 500, json: async () => ({}) }) as unknown as Response) as unknown as typeof fetch;
    const report = await provisionModule.mintUserKeys({
      base: "http://memory.test",
      account: "default",
      users: ["reviewer", "companion"],
      rootKey: "ROOT",
      fetchFn: dead,
    });
    expect(report.ok).toBe(false);
    expect(report.created).toEqual([]);
    expect(report.missing.sort()).toEqual(["companion", "reviewer"]);
  });

  it("refuses to mint without a root key", async () => {
    const report = await provisionModule.mintUserKeys({
      base: "http://memory.test",
      account: "default",
      users: ["reviewer"],
      rootKey: "",
      fetchFn: (() => {
        throw new Error("must not call the server");
      }) as unknown as typeof fetch,
    });
    expect(report.ok).toBe(false);
    expect(report.detail).toMatch(/no root key/);
  });
});

// ---- fresh mint -------------------------------------------------------------

describe("fresh install", () => {
  it("mints all three keys, places each by the confinement rules, and proves the matrix", async () => {
    const server = fakeServer();
    const engine = engineWith(server.fetchFn);
    const result = await runStep(engine);

    expect(result.failures).toEqual([]);
    expect(result.ok).toBe(true);

    const rootKey = readFileSync(join(secretsDir, ROOT_KEY_FILE), "utf8").trim();
    const reviewerSecret = readFileSync(join(secretsDir, REVIEWER_KEY_FILE), "utf8").trim();
    const fileKeys = readKeysFile(keysFile);

    expect(rootKey).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(reviewerSecret).toBe(server.users.get("reviewer"));
    expect(fileKeys[REVIEWER_VAR]).toBe(reviewerSecret);
    for (const v of COMPANION_VARS) expect(fileKeys[v]).toBe(server.users.get("companion"));

    // Every matrix cell is a green check, and the summary says 4/0/0.
    expect(detailOf(result, "confinement-matrix")?.detail).toContain(
      "4 pass, 0 fail, 0 inconclusive",
    );
    expect(result.checks.filter((c) => c.name.startsWith("matrix:"))).toHaveLength(4);
  });

  it("NEVER puts the companion key on the daemon side — the negative assertion", async () => {
    const server = fakeServer();
    await runStep(engineWith(server.fetchFn));

    const companionKey = server.users.get("companion") as string;
    expect(companionKey).toBeTruthy();
    // Nothing under the secrets dir contains it, by name or by value.
    expect(filesContaining(secretsDir, companionKey)).toEqual([]);
    for (const name of readdirSync(secretsDir)) {
      expect(name).not.toMatch(/companion/);
      expect(readFileSync(join(secretsDir, name), "utf8")).not.toContain(companionKey);
    }
    // And the root key never leaves the daemon side either.
    const rootKey = readFileSync(join(secretsDir, ROOT_KEY_FILE), "utf8").trim();
    expect(readFileSync(keysFile, "utf8")).not.toContain(rootKey);
    // 0600 on everything this step writes.
    for (const path of [
      join(secretsDir, ROOT_KEY_FILE),
      join(secretsDir, REVIEWER_KEY_FILE),
      keysFile,
    ]) {
      expect(statSync(path).mode & 0o077).toBe(0);
    }
  });
});

// ---- idempotence ------------------------------------------------------------

describe("re-running the step", () => {
  it("rotates nothing: same keys, no user created, still green", async () => {
    const server = fakeServer();
    const engine = engineWith(server.fetchFn);
    await runStep(engine);
    const before = {
      root: readFileSync(join(secretsDir, ROOT_KEY_FILE), "utf8"),
      reviewer: readFileSync(join(secretsDir, REVIEWER_KEY_FILE), "utf8"),
      file: readFileSync(keysFile, "utf8"),
    };
    const posts = server.calls.filter((c) => c.startsWith("POST")).length;

    const again = await runStep(engineWith(server.fetchFn));
    expect(again.ok).toBe(true);
    expect(readFileSync(join(secretsDir, ROOT_KEY_FILE), "utf8")).toBe(before.root);
    expect(readFileSync(join(secretsDir, REVIEWER_KEY_FILE), "utf8")).toBe(before.reviewer);
    expect(readFileSync(keysFile, "utf8")).toBe(before.file);
    expect(server.calls.filter((c) => c.startsWith("POST")).length).toBe(posts);
    expect(detailOf(again, "root-key")?.detail).toMatch(/left untouched/);
  });

  it("verify() re-runs the matrix against reality and holds", async () => {
    const server = fakeServer();
    const engine = engineWith(server.fetchFn);
    await runStep(engine);
    const reconciled = await engine.reconcile();
    expect(reconciled.verified).toEqual([MEMORY_STEP_ID]);
    expect(reconciled.demoted).toEqual([]);
  });

  it("reports a local key that disagrees with the server instead of rotating either", async () => {
    const server = fakeServer({
      users: { reviewer: "SERVER-REVIEWER", companion: "SERVER-COMPANION" },
    });
    mkdirSync(secretsDir, { recursive: true });
    writeFileSync(join(secretsDir, REVIEWER_KEY_FILE), "STALE-REVIEWER\n", { mode: 0o600 });

    const result = await runStep(engineWith(server.fetchFn));
    expect(result.ok).toBe(false);
    const check = detailOf(result, "reviewer-key-placed");
    expect(check?.ok).toBe(false);
    expect(check?.detail).toMatch(/Nothing was rotated/);
    // The file is left exactly as it was — we never overwrite a distributed key.
    expect(readFileSync(join(secretsDir, REVIEWER_KEY_FILE), "utf8").trim()).toBe("STALE-REVIEWER");
    expect(server.users.get("reviewer")).toBe("SERVER-REVIEWER");
  });

  it("verify() stays red while the daemon's reviewer copy disagrees with the proven operator copy", async () => {
    const server = fakeServer({
      users: { reviewer: "SERVER-REVIEWER", companion: "SERVER-COMPANION" },
    });
    mkdirSync(secretsDir, { recursive: true });
    writeFileSync(join(secretsDir, REVIEWER_KEY_FILE), "STALE-REVIEWER\n", { mode: 0o600 });
    const engine = engineWith(server.fetchFn);
    await runStep(engine);
    // The operator file got the server's key and the matrix passes on it.
    expect(readKeysFile(keysFile)[REVIEWER_VAR]).toBe("SERVER-REVIEWER");

    const report = await engine.verifyAll();
    const memory = report.results.find((r) => r.id === MEMORY_STEP_ID);
    expect(memory?.ok).toBe(false);
    expect(memory?.failures.join(" ")).toMatch(/DIFFERENT reviewer key/);
    expect(readFileSync(join(secretsDir, REVIEWER_KEY_FILE), "utf8").trim()).toBe("STALE-REVIEWER");

    // Restoring the right value turns it green again.
    writeFileSync(join(secretsDir, REVIEWER_KEY_FILE), "SERVER-REVIEWER\n", { mode: 0o600 });
    const healed = await engine.verifyAll();
    expect(healed.results.find((r) => r.id === MEMORY_STEP_ID)?.ok).toBe(true);
  });
});

// ---- placement rules --------------------------------------------------------

describe("placement rules", () => {
  it("refuses to write the key file inside the daemon-side secrets dir", () => {
    const inside = join(secretsDir, "openviking-keys.env");
    const checks = placeKeys({
      secretsDir,
      keysFile: inside,
      rootKey: "R",
      reviewerKey: "REV",
      companionKey: "COMP",
    });
    const refusal = checks.find((c) => c.name === "companion-key-confinement");
    expect(refusal?.ok).toBe(false);
    expect(refusal?.detail).toMatch(/refusing to write/);
    expect(existsSync(inside)).toBe(false);
    // The daemon-side halves still landed; the companion key did not.
    expect(readFileSync(join(secretsDir, ROOT_KEY_FILE), "utf8").trim()).toBe("R");
    expect(filesContaining(secretsDir, "COMP")).toEqual([]);
  });

  it("the key file's default home is outside the secrets dir AND the config home", () => {
    const home = "/home/op";
    const secrets = resolveSecretsDir({}, home);
    expect(secrets).toBe("/home/op/.config/qcr/default/secrets");
    const keys = documentedKeysFile({}, home);
    expect(keys).toBe("/home/op/.config/qcr-operator/default/openviking-keys.env");
    // Both dirs are mounted read-only into the daemon container on compose.
    expect(isInside(secrets, keys)).toBe(false);
    expect(isInside("/home/op/.config/qcr/default", keys)).toBe(false);
    expect(resolveKeysFile(secrets, {}, home)).toMatchObject({ unsafe: false });
    // A pin inside the config home is refused like one inside the secrets dir.
    const inHome = resolveKeysFile(
      secrets,
      { QCR_OPENVIKING_KEYS: "/home/op/.config/qcr/default/keys.env" },
      home,
    );
    expect(inHome.unsafe).toBe(true);
    expect(inHome.note).toMatch(/config home/);
  });

  it("a secrets dir holding the key file's home is REFUSED — there is nowhere to relocate to", () => {
    const home = mkdtempSync(join(tmpdir(), "qcr-mem-home-"));
    try {
      // The legacy dir is never the answer, even when it holds a key file.
      const old = join(home, ".config", "quickreview-bot");
      mkdirSync(old, { recursive: true });
      writeFileSync(join(old, "openviking-keys.env"), "K=1\n");
      expect(resolveSecretsDir({}, home)).toBe(join(home, ".config", "qcr", "default", "secrets"));
      const documented = documentedKeysFile({}, home);
      expect(documented).toBe(
        join(home, ".config", "qcr-operator", "default", "openviking-keys.env"),
      );
      // A secrets dir that CONTAINS the operator home (here: ~/.config) would
      // hand review sessions the companion key — refused, never moved.
      const colliding = join(home, ".config");
      const choice = resolveKeysFile(colliding, {}, home);
      expect(choice.unsafe).toBe(true);
      expect(choice.note).toMatch(/inside the daemon-side secrets dir/);

      // A secrets dir elsewhere leaves the documented path exactly as documented.
      const apart = resolveKeysFile("/opt/other-secrets", {}, home);
      expect(apart.unsafe).toBe(false);
      expect(apart.path).toBe(documented);

      // An operator who PINS the key file inside the secrets dir is refused, not
      // silently overridden.
      const pinned = resolveKeysFile(
        colliding,
        { QCR_OPENVIKING_KEYS: join(colliding, "keys.env") },
        home,
      );
      expect(pinned.unsafe).toBe(true);
      expect(pinned.note).toMatch(/outside that directory/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("fails the step (writing nothing) when the pinned key file would sit in the secrets dir", async () => {
    const server = fakeServer();
    const home = join(root, "home");
    const result = await runStep(
      engineWith(server.fetchFn, {
        keysFile: undefined,
        secretsDir,
        env: { QCR_OPENVIKING_KEYS: join(secretsDir, "keys.env") },
        home,
      }),
    );
    expect(result.ok).toBe(false);
    expect(detailOf(result, "key-file-location")?.detail).toMatch(
      /review session could read the companion key/,
    );
    expect(existsSync(join(secretsDir, "keys.env"))).toBe(false);
    expect(existsSync(join(secretsDir, ROOT_KEY_FILE))).toBe(false);
  });

  it.skipIf(process.getuid?.() === 0)(
    "an existing key it cannot READ is never treated as missing — nothing is minted or written over it",
    async () => {
      mkdirSync(secretsDir, { recursive: true });
      const rootPath = join(secretsDir, ROOT_KEY_FILE);
      writeFileSync(rootPath, "EXISTING-ROOT\n", { mode: 0o600 });
      chmodSync(rootPath, 0o000);
      try {
        const server = fakeServer();
        const result = await runStep(engineWith(server.fetchFn));
        expect(result.ok).toBe(false);
        expect(detailOf(result, "root-key")?.detail).toMatch(/cannot be read/);
      } finally {
        chmodSync(rootPath, 0o600);
      }
      expect(readFileSync(rootPath, "utf8")).toBe("EXISTING-ROOT\n");

      // The same at placement: an unreadable reviewer key and key file are
      // left exactly as they were, and the step says why.
      const reviewerPath = join(secretsDir, REVIEWER_KEY_FILE);
      writeFileSync(reviewerPath, "OLD-REV\n", { mode: 0o600 });
      mkdirSync(dirname(keysFile), { recursive: true });
      writeFileSync(keysFile, "SOMETHING_ELSE=keep-me\n", { mode: 0o600 });
      chmodSync(reviewerPath, 0o000);
      chmodSync(keysFile, 0o000);
      try {
        const checks = placeKeys({
          secretsDir,
          keysFile,
          rootKey: "",
          reviewerKey: "REV",
          companionKey: "COMP",
        });
        expect(checks.find((c) => c.name === "reviewer-key-placed")?.ok).toBe(false);
        expect(checks.find((c) => c.name === "key-file")?.detail).toMatch(/cannot be read/);
      } finally {
        chmodSync(reviewerPath, 0o600);
        chmodSync(keysFile, 0o600);
      }
      expect(readFileSync(reviewerPath, "utf8")).toBe("OLD-REV\n");
      expect(readFileSync(keysFile, "utf8")).toBe("SOMETHING_ELSE=keep-me\n");
    },
  );

  it("preserves unrelated variables in the key file and never replaces a value", () => {
    const merged = renderKeysFile(
      { SOMETHING_ELSE: "keep-me", [REVIEWER_VAR]: "OLD" },
      { [REVIEWER_VAR]: "NEW", OPENVIKING_API_KEY: "C" },
    );
    const parsed = parseKeysFile(merged);
    expect(parsed.SOMETHING_ELSE).toBe("keep-me");
    expect(parsed[REVIEWER_VAR]).toBe("OLD");
    expect(parsed.OPENVIKING_API_KEY).toBe("C");
    expect(merged).toMatch(/never a root or admin key/);
  });
});

// ---- the matrix as verification --------------------------------------------

describe("the four-cell confinement matrix is the verification", () => {
  it("fails the step when a cell is INCONCLUSIVE — never a pass", async () => {
    const server = fakeServer({ murky: { owner: "reviewer", ns: "companion" } });
    const result = await runStep(engineWith(server.fetchFn));
    expect(result.ok).toBe(false);
    const cell = result.checks.find((c) => c.name === "matrix:reviewer-key→companion");
    expect(cell?.ok).toBe(false);
    expect(cell?.detail).toMatch(/INCONCLUSIVE/);
    expect(cell?.detail).toMatch(/NEVER a pass/);
    expect(detailOf(result, "confinement-matrix")?.detail).toMatch(/1 inconclusive .*not a pass/);
  });

  it("fails the step when the reverse direction actually leaks", async () => {
    const server = fakeServer({ leaky: { owner: "reviewer", ns: "companion" } });
    const result = await runStep(engineWith(server.fetchFn));
    expect(result.ok).toBe(false);
    const cell = result.checks.find((c) => c.name === "matrix:reviewer-key→companion");
    expect(cell?.ok).toBe(false);
    expect(cell?.detail).toMatch(/FAILED: expected refused, got reach/);
  });

  it("fails loudly when the matrix module cannot be loaded", async () => {
    const server = fakeServer();
    const result = await runStep(
      engineWith(server.fetchFn, {
        loadMatrix: async () => {
          throw new Error("module gone");
        },
      }),
    );
    expect(result.ok).toBe(false);
    expect(detailOf(result, "confinement-matrix")?.detail).toMatch(/could not load/);
  });
});

// ---- degraded and deferred paths -------------------------------------------

describe("degraded modes stay legal and loud", () => {
  // The fixture is a whole, loadable config.toml (memory ON), placed where
  // the adapters say the live config is — the step parses what it writes.
  const liveConfig = () => join(dirname(stateDir), "config.toml");
  const placeConfig = (edit: (t: string) => string = (t) => t): string => {
    const text = edit(
      readFileSync(join(process.cwd(), "tests", "fixtures", "config.toml"), "utf8"),
    );
    mkdirSync(dirname(liveConfig()), { recursive: true });
    writeFileSync(liveConfig(), text);
    return text;
  };
  const memoryEnabled = () => parseConfig(readFileSync(liveConfig(), "utf8")).openviking.enabled;

  it("distinguishes an answering but unhealthy server from a broken forward", async () => {
    const fetchFn = (async () => ({
      status: 503,
      json: async () => ({ detail: "embedder is not loaded" }),
    })) as unknown as typeof fetch;
    const result = await runStep(engineWith(fetchFn));
    const detail = detailOf(result, "memory-server")?.detail;
    expect(detail).toContain("embedder is not loaded");
    expect(detail).toContain("answers");
    expect(detail).not.toContain("start the forward");
  });

  it("keeps a failed switch restart owed across a new engine and retries it", async () => {
    placeConfig();
    let restarts = 0;
    let fail = true;
    const a = adapters(fakeServer().fetchFn);
    a.runner = {
      run: async () => ({
        code: 0,
        stdout: JSON.stringify([{ Service: "daemon", State: "running" }]),
        stderr: "",
      }),
    };
    const options = stepOptions({
      transport: {
        stream: {
          run: async () => {
            restarts++;
            return { code: fail ? 1 : 0, stdout: "", stderr: fail ? "restart failed" : "" };
          },
        },
      },
    });
    const first = new OnboardingEngine([memoryStep(options)], a);
    expect((await first.runStep(MEMORY_STEP_ID, { choice: "declined" })).ok).toBe(false);
    expect(memoryEnabled()).toBe(false);
    expect(restarts).toBe(1);
    const resumed = new OnboardingEngine([memoryStep(options)], a);
    expect((await resumed.verifyAll()).ok).toBe(false);
    fail = false;
    expect((await resumed.runStep(MEMORY_STEP_ID, { choice: "declined" })).ok).toBe(true);
    expect(restarts).toBe(2);
    expect((await resumed.verifyAll()).ok).toBe(true);
  });

  it("declining mints nothing, tells the DAEMON memory is off, stays green, and says what memory-less means", async () => {
    placeConfig();
    expect(memoryEnabled()).toBe(true);
    const asked: string[] = [];
    const engine = engineWith(fakeServer().fetchFn, {}, async (q) => {
      asked.push(q);
      return "no thanks";
    });
    const result = await runStep(engine);
    expect(result.ok).toBe(true);
    expect(asked).toHaveLength(1);
    expect(result.checks[0]?.detail).toMatch(/DECLINED/);
    expect(result.checks[0]?.detail).toMatch(/rounds still run/);
    expect(existsSync(secretsDir)).toBe(false);
    expect(existsSync(keysFile)).toBe(false);
    expect(engine.choices()[MEMORY_CHOICE_KEY]).toBe("declined");
    // The one write: the daemon's word for "off", so memory health reports
    // "not monitored" instead of paging about a missing key it was told to
    // expect.
    expect(memoryEnabled()).toBe(false);
    expect(detailOf(result, MEMORY_SWITCH_CHECK)).toMatchObject({ ok: true });
    expect(detailOf(result, MEMORY_SWITCH_CHECK)?.detail).toMatch(/not monitored/);

    // And it stays green through resume — a declined operator is never wedged.
    const reconciled = await engine.reconcile();
    expect(reconciled.demoted).toEqual([]);
    expect(DECLINED_CHECKS.every((c) => c.ok)).toBe(true);
    // A second run is idempotent: already off, nothing rewritten.
    const before = readFileSync(liveConfig(), "utf8");
    const again = await runStep(engine);
    expect(again.ok).toBe(true);
    expect(readFileSync(liveConfig(), "utf8")).toBe(before);
    expect(detailOf(again, MEMORY_SWITCH_CHECK)?.detail).toMatch(/already/);
  });

  it("the pi wizard (no prompter) declines through the tool's choice input, and the step declares it", async () => {
    placeConfig();
    const params = memoryStep().parameters as {
      properties: { choice: { enum: string[] } };
    };
    expect(params.properties.choice.enum).toEqual(["configure", "declined"]);

    const engine = engineWith(fakeServer().fetchFn);
    const result = await engine.runStep(MEMORY_STEP_ID, { choice: "declined" });
    expect(result.ok).toBe(true);
    expect(result.checks[0]?.detail).toMatch(/DECLINED/);
    expect(engine.choices()[MEMORY_CHOICE_KEY]).toBe("declined");
    expect(existsSync(keysFile)).toBe(false);
    expect(memoryEnabled()).toBe(false);

    // An explicit answer overrides the recorded one: configuring later is reachable too.
    const later = await engine.runStep(MEMORY_STEP_ID, { choice: "configure" });
    expect(engine.choices()[MEMORY_CHOICE_KEY]).toBe("configure");
    expect(memoryEnabled()).toBe(true);
    expect(later.checks.some((c) => /DECLINED/.test(c.detail))).toBe(false);

    // Verify follows the CURRENT choice, not the merged-in flag of the
    // earlier decline: memory is configured and on, so verify is green.
    expect(later.ok).toBe(true);
    const verified = await engine.verifyAll();
    const row = verified.results.find((r) => r.id === MEMORY_STEP_ID)!;
    expect(row.failures.join(" ")).not.toMatch(/memory was declined/);
    expect(row.ok).toBe(true);
  });

  it("a declined install whose config says ON again is RED on verify — the daemon would page about it", async () => {
    placeConfig();
    const engine = engineWith(fakeServer().fetchFn, {}, async () => "no");
    expect((await runStep(engine)).ok).toBe(true);
    writeFileSync(
      liveConfig(),
      readFileSync(liveConfig(), "utf8").replace(
        /^(\[openviking\][\s\S]*?^)enabled = false/m,
        "$1enabled = true",
      ),
    );
    expect(memoryEnabled()).toBe(true);
    const verified = await engine.verifyAll();
    const row = verified.results.find((r) => r.id === MEMORY_STEP_ID)!;
    expect(row.ok).toBe(false);
    expect(row.failures.join(" ")).toMatch(/does not say \[openviking\] enabled = false/);
  });

  it("a decline with no config.toml yet is red, and says why — never a silent half", async () => {
    const result = await runStep(engineWith(fakeServer().fetchFn, {}, async () => "skip"));
    expect(result.ok).toBe(false);
    expect(detailOf(result, MEMORY_SWITCH_CHECK)?.detail).toMatch(/config_fill/);
    expect(existsSync(liveConfig())).toBe(false);
    expect(existsSync(secretsDir)).toBe(false);
  });

  it("configuring over an earlier decline switches memory back ON", async () => {
    placeConfig((t) => t.replace(/^(\[openviking\][\s\S]*?^)enabled = true/m, "$1enabled = false"));
    expect(memoryEnabled()).toBe(false);
    const result = await runStep(engineWith(fakeServer().fetchFn));
    expect(result.failures).toEqual([]);
    expect(memoryEnabled()).toBe(true);
    expect(detailOf(result, MEMORY_SWITCH_CHECK)).toMatchObject({ ok: true });
  });

  it("configuring an install that never said off leaves its config byte-for-byte alone", async () => {
    const text = placeConfig();
    const result = await runStep(engineWith(fakeServer().fetchFn));
    expect(result.failures).toEqual([]);
    expect(readFileSync(liveConfig(), "utf8")).toBe(text);
    expect(detailOf(result, MEMORY_SWITCH_CHECK)).toBeUndefined();
  });

  it("normalizes the decline answers a human actually types", () => {
    for (const yes of ["", "y", "yes", "sure", "ok"])
      expect(normalizeMemoryChoice(yes)).toBe("configure");
    for (const no of ["n", "No", "skip", "later", "decline", "without memory"])
      expect(normalizeMemoryChoice(no)).toBe("declined");
    expect(normalizeMemoryChoice(undefined)).toBe("configure");
    for (const unclear of [
      "maybe",
      "configur",
      "turn it off",
      "?",
      "memory",
      "need more information",
      "nothing",
    ])
      expect(normalizeMemoryChoice(unclear)).toBeNull();
  });

  it("an unrecognised answer is a refusal naming the options — never a guessed configure", async () => {
    const text = placeConfig();
    const engine = engineWith(fakeServer().fetchFn);
    const result = await engine.runStep(MEMORY_STEP_ID, { choice: "maybe" });
    expect(result.ok).toBe(false);
    expect(result.checks).toHaveLength(1);
    expect(result.checks[0]).toMatchObject({ name: "choice", ok: false });
    expect(result.checks[0]?.detail).toMatch(/"maybe".*configure \| declined/);
    expect(engine.choices()[MEMORY_CHOICE_KEY]).toBeUndefined();
    expect(existsSync(keysFile)).toBe(false);
    expect(readFileSync(liveConfig(), "utf8")).toBe(text);

    // The same holds for a typed answer at the interactive prompt.
    const prompted = engineWith(fakeServer().fetchFn, {}, async () => "perhaps");
    const fromPrompt = await runStep(prompted);
    expect(fromPrompt.ok).toBe(false);
    expect(fromPrompt.checks[0]?.detail).toMatch(/"perhaps"/);
    expect(prompted.choices()[MEMORY_CHOICE_KEY]).toBeUndefined();
    expect(existsSync(keysFile)).toBe(false);
  });

  it("the decline advice names the answer that sets memory up later", () => {
    expect(DECLINED_CHECKS[0]?.detail).toMatch(/choice "configure"/);
    expect(DECLINED_CHECKS[0]?.detail).not.toMatch(/clearing the recorded choice/);
  });

  it("places the keys in the configured [github] secrets_dir — the dir the daemon and the compose mount read", async () => {
    // No injected secretsDir and no $QC_SECRETS_DIR: the step must resolve the
    // same dir as the loader, where a set `secrets_dir` wins.
    const custom = join(root, "custom-secrets");
    writeFileSync(
      join(dirname(stateDir), "config.toml"),
      `[github]\nrepo = "acme/widgets"\nsecrets_dir = "${custom}"\n`,
    );
    const server = fakeServer();
    const engine = new OnboardingEngine(
      [memoryStep(stepOptions({ secretsDir: undefined }))],
      adapters(server.fetchFn),
    );
    const result = await runStep(engine);
    expect(result.failures).toEqual([]);
    expect(existsSync(join(custom, ROOT_KEY_FILE))).toBe(true);
    expect(existsSync(join(custom, REVIEWER_KEY_FILE))).toBe(true);
    expect(existsSync(join(root, "home", ".config", "qcr", "default", "secrets"))).toBe(false);
    // …and verify reads the same dir back.
    const verified = await engine.verifyAll();
    expect(verified.results.find((r) => r.id === MEMORY_STEP_ID)?.failures).toEqual([]);
  });

  it("lands the root key and waits when the server is not up yet (phase A before bring-up)", async () => {
    const server = fakeServer({ unreachable: true });
    const result = await runStep(engineWith(server.fetchFn));
    expect(result.ok).toBe(false);
    expect(detailOf(result, "root-key")?.ok).toBe(true);
    expect(existsSync(join(secretsDir, ROOT_KEY_FILE))).toBe(true);
    expect(detailOf(result, "memory-server")?.detail).toMatch(/bring the stack up/);
    // No user key was invented while the server was unreachable.
    expect(existsSync(keysFile)).toBe(false);
    expect(existsSync(join(secretsDir, REVIEWER_KEY_FILE))).toBe(false);

    // Then the stack comes up and the SAME root key completes the step.
    const rootKey = readFileSync(join(secretsDir, ROOT_KEY_FILE), "utf8").trim();
    const up = fakeServer();
    const done = await runStep(engineWith(up.fetchFn));
    expect(done.ok).toBe(true);
    expect(readFileSync(join(secretsDir, ROOT_KEY_FILE), "utf8").trim()).toBe(rootKey);
  });

  // Every directory the compose route mounts into the daemon container is
  // readable by a review session: the secrets dir, the config home, the
  // directory of the live config.toml (bring-up mounts THAT, wherever
  // QCR_CONFIG points) and the checkout itself (rw at /opt/quickreview/sandbox).
  // A pinned key file inside any of them is refused before anything is written.
  it("refuses a pinned key file inside the live config's directory or the checkout", async () => {
    const checkout = dirname(stateDir);
    for (const pin of [join(checkout, "keys.env"), join(checkout, "sub", "keys.env")]) {
      const result = await runStep(
        engineWith(fakeServer().fetchFn, {
          keysFile: undefined,
          env: { QCR_OPENVIKING_KEYS: pin },
        }),
      );
      expect([pin, result.ok]).toEqual([pin, false]);
      expect(detailOf(result, "key-file-location")?.detail).toMatch(
        /review session could read the companion key/,
      );
      expect(existsSync(pin)).toBe(false);
      expect(existsSync(join(secretsDir, ROOT_KEY_FILE))).toBe(false);
    }
    const cfgDir = join(root, "custom");
    const unsafe = resolveKeysFile(
      secretsDir,
      { QCR_OPENVIKING_KEYS: join(cfgDir, "keys.env") },
      join(root, "home"),
      [cfgDir],
    );
    expect(unsafe.unsafe).toBe(true);
    expect(unsafe.note).toContain(cfgDir);
  });

  it("verify re-checks confinement against the CURRENT mounts, not only the secrets dir", async () => {
    const done = await runStep(engineWith(fakeServer().fetchFn));
    expect(done.ok).toBe(true);
    // The layout changes after onboarding: the live config now sits beside the
    // operator key file, so bring-up would mount the key file's directory.
    const moved = join(dirname(keysFile), "config.toml");
    writeFileSync(moved, '[github]\nrepo = "acme/widgets"\n');
    const engine = new OnboardingEngine([memoryStep(stepOptions())], {
      ...adapters(fakeServer().fetchFn),
      paths: { stateDir, configPath: moved },
    });
    const verified = await engine.verifyAll();
    const failures = verified.results.find((r) => r.id === MEMORY_STEP_ID)?.failures ?? [];
    expect(failures.join(" ")).toMatch(/companion-key-confinement|review session/);
  });

  it("the negative assertion reaches nested files under the secrets mount", () => {
    mkdirSync(join(secretsDir, "backup", "deeper"), { recursive: true });
    writeFileSync(join(secretsDir, "backup", "deeper", "keys.env"), "OPENVIKING_API_KEY=COMP\n");
    writeFileSync(join(secretsDir, "top"), "COMP\n");
    expect(filesContaining(secretsDir, "COMP").sort()).toEqual(
      [join(secretsDir, "backup", "deeper", "keys.env"), join(secretsDir, "top")].sort(),
    );
  });

  it("never throws when the key file or secrets dir is unreadable garbage", () => {
    mkdirSync(secretsDir, { recursive: true });
    expect(readKeysFile(join(root, "nope.env"))).toEqual({});
    expect(filesContaining(join(root, "nope"), "X")).toEqual([]);
    expect(filesContaining(secretsDir, "")).toEqual([]);
  });
});

// ---- registration and contracts --------------------------------------------

describe("registration", () => {
  it("is registered in the engine's default steps, after preflight", () => {
    const ids = defaultSteps().map((s) => s.id);
    expect(ids).toContain(MEMORY_STEP_ID);
    const memory = defaultSteps().find((s) => s.id === MEMORY_STEP_ID);
    const preflight = defaultSteps().find((s) => s.id === "preflight");
    expect(memory?.order).toBeGreaterThan(preflight?.order ?? 0);
    // Tool-name-safe id (the pi extension registers onboard_<id>).
    expect(MEMORY_STEP_ID).toMatch(/^[a-z][a-z0-9_]*$/);
  });

  it("the real scripts satisfy the structural contracts this step depends on", () => {
    expect(typeof provisionModule.mintRootKey).toBe("function");
    expect(typeof provisionModule.mintUserKeys).toBe("function");
    expect(typeof matrixModule.runVerify).toBe("function");
  });

  it("uses the same secret file names as the config authority", async () => {
    const { OPENVIKING_DEFAULTS } = await import("../src/config.js");
    expect(ROOT_KEY_FILE).toBe(OPENVIKING_DEFAULTS.root_key_file);
    expect(REVIEWER_KEY_FILE).toBe(OPENVIKING_DEFAULTS.reviewer_key_file);
    // There is no companion secret file name, and there must never be one.
    expect(JSON.stringify(OPENVIKING_DEFAULTS)).not.toMatch(/companion_key_file/);
  });

  it("reports rather than throws when the provisioning machinery is missing", async () => {
    const server = fakeServer();
    const result = await runStep(
      engineWith(server.fetchFn, {
        loadProvision: async () => {
          throw new Error("script gone");
        },
      }),
    );
    expect(result.ok).toBe(false);
    expect(detailOf(result, "provisioning-machinery")?.detail).toMatch(/could not load/);
  });
});

// ---- verify() on its own ----------------------------------------------------

describe("verify()", () => {
  it("goes red when the companion key turns up on the daemon side", async () => {
    const server = fakeServer();
    const engine = engineWith(server.fetchFn);
    await runStep(engine);

    // Someone copies the key file into the secrets dir "for convenience".
    writeFileSync(
      join(secretsDir, "openviking_companion_key"),
      `${server.users.get("companion")}\n`,
      { mode: 0o600 },
    );
    const report = await engine.verifyAll();
    const memory = report.results.find((r) => r.id === MEMORY_STEP_ID);
    expect(memory?.ok).toBe(false);
    expect(memory?.failures.join(" ")).toMatch(
      /companion key is reachable from the daemon-side secrets dir/,
    );
  });

  it("goes red when a placed key is missing entirely", async () => {
    const server = fakeServer();
    const step = memoryStep(stepOptions());
    const report: StepReport = await step.verify({
      adapters: adapters(server.fetchFn),
      input: {},
      choices: {},
      data: {},
      recordChoice: () => {},
    });
    expect(report.ok).toBe(false);
    expect(report.checks.find((c) => c.name === "root-key")?.detail).toMatch(/missing or empty/);
    expect(report.checks.find((c) => c.name === "confinement-matrix")?.detail).toMatch(
      /both USER keys are needed/,
    );
  });
});

describe("verify() checks what the consumers read now", () => {
  it("a key file the locator no longer names is not proof: the CURRENT file must hold the keys", async () => {
    const engine = engineWith(fakeServer().fetchFn);
    expect((await runStep(engine)).ok).toBe(true);
    // The operator points the TUI and companion somewhere else, still confined,
    // but empty: verify must not keep certifying the file written earlier.
    const moved = join(root, "operator", "moved.env");
    const step = memoryStep(stepOptions({ keysFile: moved }));
    const report = await step.verify({
      adapters: adapters(fakeServer().fetchFn),
      input: {},
      choices: engine.choices(),
      data: { keys_file: keysFile },
      recordChoice: () => {},
    });
    expect(report.ok).toBe(false);
    expect(report.checks.find((c) => c.name === "key-file")?.detail).toContain(moved);
  });

  it.each(COMPANION_VARS)("repairs a lone companion alias when %s is missing", async (missing) => {
    const engine = engineWith(fakeServer().fetchFn);
    expect((await runStep(engine)).ok).toBe(true);
    writeFileSync(
      keysFile,
      readFileSync(keysFile, "utf8")
        .split("\n")
        .filter((line) => !line.startsWith(`${missing}=`))
        .join("\n"),
    );
    expect((await engine.verifyAll()).ok).toBe(false);
    expect((await runStep(engine)).ok).toBe(true);
    expect((await engine.verifyAll()).ok).toBe(true);
  });

  it("the two companion spellings must agree — proving one while the other is stale is no proof", async () => {
    const server = fakeServer();
    const engine = engineWith(server.fetchFn);
    expect((await runStep(engine)).ok).toBe(true);
    const text = readFileSync(keysFile, "utf8").replace(
      /^OPENVIKING_API_KEY=.*$/m,
      "OPENVIKING_API_KEY=stale-companion-key",
    );
    writeFileSync(keysFile, text, { mode: 0o600 });
    const report = await engine.verifyAll();
    const row = report.results.find((r) => r.id === MEMORY_STEP_ID)!;
    expect(row.ok).toBe(false);
    expect(row.failures.join(" ")).toMatch(/different values/);
  });

  it("a configured install whose config now says enabled = false is red — the daemon runs memory-less", async () => {
    const live = join(dirname(stateDir), "config.toml");
    writeFileSync(
      live,
      readFileSync(join(process.cwd(), "tests", "fixtures", "config.toml"), "utf8"),
    );
    const engine = engineWith(fakeServer().fetchFn);
    expect((await runStep(engine)).ok).toBe(true);
    writeFileSync(
      live,
      readFileSync(live, "utf8").replace(
        /^(\[openviking\][\s\S]*?^)enabled = true/m,
        "$1enabled = false",
      ),
    );
    const row = (await engine.verifyAll()).results.find((r) => r.id === MEMORY_STEP_ID)!;
    expect(row.ok).toBe(false);
    expect(row.failures.join(" ")).toMatch(/says \[openviking\] enabled = false/);
  });
});

describe("reaching the server", () => {
  it("defaults to the endpoint the TUI uses, QCR_MEMORY_PORT included", async () => {
    const urls: string[] = [];
    const server = fakeServer();
    const spy = (async (input: string | URL | Request, init?: RequestInit) => {
      urls.push(String(input));
      return server.fetchFn(input, init);
    }) as unknown as typeof fetch;
    await runStep(engineWith(spy, { base: undefined, env: { QCR_MEMORY_PORT: "2933" } }));
    expect(urls[0]).toBe("http://127.0.0.1:2933/ready");
  });

  it("an unreachable server names the memory forward for this topology, not only the stack", async () => {
    const result = await runStep(engineWith(fakeServer({ unreachable: true }).fetchFn));
    const detail = detailOf(result, "memory-server")?.detail ?? "";
    expect(detail).toMatch(/memory forward/);
    expect(detail).toMatch(/from the repo root/);
    expect(detail).toContain(
      `cd ${dirname(stateDir)} && node scripts/companion-memory-forward.mjs run --local`,
    );
    expect(detail).toContain(`--container "$(sudo docker compose ps --format '{{.Name}}' memory)"`);
  });

  it("on the server route the forward command carries THIS install's alias, container and sudo — never the script's defaults", async () => {
    writeFileSync(
      join(dirname(stateDir), "config.toml"),
      '[tui]\ncontainer = "my-reviewer"\nsudo_docker = false\n',
    );
    const step = memoryStep(stepOptions());
    const report = await step.run({
      adapters: adapters(fakeServer({ unreachable: true }).fetchFn),
      input: {},
      choices: { topology: "vm", vm_ssh_alias: "review-box" },
      data: {},
      recordChoice: () => {},
    });
    const detail = report.checks.find((c) => c.name === "memory-server")?.detail ?? "";
    for (const sub of ["run", "install"])
      expect(detail).toContain(
        `node scripts/companion-memory-forward.mjs ${sub} --ssh-host review-box --container my-reviewer --no-sudo`,
      );
    // No other host is ever named — the script's own default included.
    expect(detail.match(/--ssh-host \S+/g)).toEqual([
      "--ssh-host review-box",
      "--ssh-host review-box",
    ]);
  });
});

describe("the server route's daemon copy of the reviewer key", () => {
  const vmChoices = { topology: "vm", vm_ssh_alias: "review-box" };

  function vmCtx(fetchFn: typeof fetch, remote: (argv: string[]) => ProcessResult) {
    const calls: string[][] = [];
    return {
      calls,
      ctx: {
        adapters: {
          ...adapters(fetchFn),
          runner: {
            run: async (cmd: string, args: string[]): Promise<ProcessResult> => {
              calls.push([cmd, ...args]);
              return remote(args);
            },
          },
        },
        input: {},
        choices: vmChoices,
        data: {},
        recordChoice: () => {},
      },
    };
  }

  it("is red until a provision has shipped the placed key, then green when the hashes match", async () => {
    const server = fakeServer();
    const step = memoryStep(stepOptions());
    const missing = vmCtx(server.fetchFn, () => ({
      code: 1,
      stdout: "",
      stderr:
        "sha256sum: /opt/quickreview/secrets/openviking_reviewer_key: No such file or directory",
    }));
    const first = await step.run(missing.ctx);
    expect(first.ok).toBe(false);
    const check = first.checks.find((c) => c.name === "reviewer-key-on-server");
    expect(check?.ok).toBe(false);
    expect(check?.detail).toMatch(/no reviewer key yet/);
    expect(check?.detail).toMatch(/mode "provision"/);
    // Only a hash crosses ssh — never the key.
    expect(missing.calls.at(-1)?.join(" ")).toContain("sha256sum");

    const placed = readFileSync(join(secretsDir, REVIEWER_KEY_FILE));
    const hash = createHash("sha256").update(placed).digest("hex");
    const shipped = vmCtx(server.fetchFn, () => ({
      code: 0,
      stdout: `${hash}  /opt/quickreview/secrets/openviking_reviewer_key\n`,
      stderr: "",
    }));
    const verified = await step.verify({ ...shipped.ctx, data: { keys_file: keysFile } });
    expect(verified.checks.find((c) => c.name === "reviewer-key-on-server")?.ok).toBe(true);
    expect(verified.ok).toBe(true);

    const stale = vmCtx(server.fetchFn, () => ({
      code: 0,
      stdout: `${"0".repeat(64)}  /opt/quickreview/secrets/openviking_reviewer_key\n`,
      stderr: "",
    }));
    const red = await step.verify({ ...stale.ctx, data: { keys_file: keysFile } });
    expect(red.checks.find((c) => c.name === "reviewer-key-on-server")?.detail).toMatch(
      /DIFFERENT reviewer key/,
    );
  });

  it("an unanswerable server is not proof either way", async () => {
    const server = fakeServer();
    const step = memoryStep(stepOptions());
    await step.run(vmCtx(server.fetchFn, () => ({ code: 0, stdout: "", stderr: "" })).ctx);
    const down = vmCtx(server.fetchFn, () => ({
      code: 255,
      stdout: "",
      stderr: "ssh: connect to host review-box port 22: Connection refused",
    }));
    const report = await step.verify({ ...down.ctx, data: { keys_file: keysFile } });
    const check = report.checks.find((c) => c.name === "reviewer-key-on-server");
    expect(check?.ok).toBe(false);
    expect(check?.detail).toMatch(/not proven either way/);
  });
});

describe("forward command memory container", () => {
  it("on the server route targets [tui] memory_container, else the daemon container", () => {
    const flagsFor = (toml: string): string => {
      writeFileSync(join(dirname(stateDir), "config.toml"), toml);
      return forwardFlags({
        adapters: adapters(fakeServer().fetchFn),
        input: {},
        choices: { topology: "vm", vm_ssh_alias: "review-box" },
        data: {},
        recordChoice: () => {},
      });
    };
    expect(
      flagsFor('[tui]\ncontainer = "my-reviewer"\nmemory_container = "my-memory"\n'),
    ).toContain("--container my-memory");
    expect(flagsFor('[tui]\ncontainer = "my-reviewer"\n')).toContain("--container my-reviewer");
  });
});

describe("forward command privilege parity", () => {
  it.each([true, false])("uses sudo=%s for both compose lookup and relay Docker", (sudo) => {
    writeFileSync(join(dirname(stateDir), "config.toml"), `[tui]\nsudo_docker = ${String(sudo)}\n`);
    const flags = forwardFlags({
      adapters: adapters(fakeServer().fetchFn),
      input: {},
      choices: {},
      data: {},
      recordChoice: () => {},
    });
    expect(flags).toContain(`$(${sudo ? "sudo " : ""}docker compose ps`);
    expect(flags.includes("--no-sudo")).toBe(!sudo);
  });
});

describe("memory phase delivery and provisioning readiness", () => {
  it("provisions users when only the embedder readiness check fails", async () => {
    const server = fakeServer();
    const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
      if (new URL(String(input)).pathname === "/ready")
        return {
          status: 503,
          json: async () => ({
            status: "not_ready",
            checks: { storage: "ok", embedding: "embedder unavailable" },
          }),
        } as Response;
      return server.fetchFn(input, init);
    }) as typeof fetch;
    const result = await runStep(engineWith(fetcher));
    expect(result.ok, result.failures.join(" ")).toBe(true);
    expect(server.users.has("reviewer")).toBe(true);
  });
  it("phase B retries phase A's persisted restart obligation", async () => {
    const path = join(dirname(stateDir), "config.toml");
    writeFileSync(path, readFileSync(join(process.cwd(), "tests/fixtures/config.toml"), "utf8"));
    const a = adapters(fakeServer().fetchFn);
    let restarts = 0;
    a.runner = {
      run: async () => ({
        code: 0,
        stdout: JSON.stringify([{ Service: "daemon", State: "running" }]),
        stderr: "",
      }),
    };
    const options = stepOptions({
      transport: {
        stream: { run: async () => ({ code: ++restarts === 1 ? 1 : 0, stdout: "", stderr: "" }) },
      },
    });
    const engine = new OnboardingEngine([memoryStep(options), memoryUserKeysStep(options)], a);
    expect((await engine.runStep(MEMORY_STEP_ID, { choice: "declined" })).ok).toBe(false);
    expect((await engine.runStep(MEMORY_KEYS_STEP_ID, { choice: "declined" })).ok).toBe(true);
    expect(restarts).toBe(2);
    expect((await engine.verifyAll()).ok).toBe(true);
  });
});
