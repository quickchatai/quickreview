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
//   * declining memory is legal, loud, and writes nothing.
//
// The provisioning and matrix modules under test are the REAL scripts — this
// suite drives them through a fake server rather than reimplementing them.
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OnboardingEngine, type OnboardAdapters, type StepReport } from "../src/onboard/engine.js";
import {
  COMPANION_VARS,
  DECLINED_CHECKS,
  MEMORY_CHOICE_KEY,
  MEMORY_STEP_ID,
  REVIEWER_KEY_FILE,
  REVIEWER_VAR,
  ROOT_KEY_FILE,
  documentedKeysFile,
  filesContaining,
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
      run: async () => ({ code: 127, stdout: "", stderr: "no subprocesses in this suite" }),
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
      // The old dir is never the answer now, even when it holds a key file.
      const old = join(home, ".config", "quickreview-bot");
      mkdirSync(old, { recursive: true });
      writeFileSync(join(old, "openviking-keys.env"), "K=1\n");
      expect(resolveSecretsDir({}, home)).toBe(join(home, ".config", "qcr", "default", "secrets"));
      const documented = documentedKeysFile({}, home);
      expect(documented).toBe(join(home, ".config", "qcr-operator", "default", "openviking-keys.env"));
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
  it("declining writes nothing, stays green, and says what memory-less means", async () => {
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

    // And it stays green through resume — a declined operator is never wedged.
    const reconciled = await engine.reconcile();
    expect(reconciled.demoted).toEqual([]);
    expect(DECLINED_CHECKS.every((c) => c.ok)).toBe(true);
  });

  it("normalizes the decline answers a human actually types", () => {
    for (const yes of ["", "y", "yes", "sure", "ok"])
      expect(normalizeMemoryChoice(yes)).toBe("configure");
    for (const no of ["n", "No", "skip", "later", "decline", "without memory"])
      expect(normalizeMemoryChoice(no)).toBe("declined");
    expect(normalizeMemoryChoice(undefined)).toBe("configure");
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
    const server = fakeServer({ ready: false });
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
