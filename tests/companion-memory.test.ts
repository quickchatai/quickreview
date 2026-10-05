// the companion reaches memory without holding a VM credential.
//
// Three properties are pinned here, and each one is a rule-8 invariant rather
// than an implementation detail:
//
//   1. the container gets an OpenViking endpoint + both USER keys, and NO ssh
//      credential of any kind;
//   2. the forward is a host-owned systemd unit relaying into the VM
//      container's own netns — nothing is published anywhere;
//   3. an unreachable memory engine alerts through the existing alert policy
//      and never wedges anything.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { PassThrough } from "node:stream";
import { connect, type Socket } from "node:net";
import { describe, expect, it } from "vitest";
import { COMPANION_DEFAULTS, resolveCompanionPaths, type CompanionConfig } from "../src/config.js";
import {
  CompanionLifecycle,
  CONTAINER,
  KEY_NAMES,
  MEMORY,
  envFileProblems,
  keyNamesIn,
  keysFilePath,
  memoryEndpoint,
  parseGateway,
  type CompanionFs,
  type DockerResult,
  type DockerRunner,
} from "../src/tui/companion.js";
import { parseAlert } from "../src/tui/alerts.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const CFG: CompanionConfig = resolveCompanionPaths(
  {
    ...COMPANION_DEFAULTS,
    repo_dir: "/host/review-sandbox",
    tracker_dir: "/host/tracker",
    feed_dir: "/host/feed",
    alerts_dir: "/host/alerts",
  },
  root,
);

const OK: DockerResult = { ok: true, stdout: "", stderr: "", code: 0 };
const FAIL: DockerResult = { ok: false, stdout: "", stderr: "no such object", code: 1 };

function fakeFs(files: Record<string, string>, mode = 0o600): CompanionFs {
  return {
    exists: (p) => p in files,
    read: (p) => files[p],
    mode: (p) => (p in files ? mode : undefined),
  };
}

/** A docker seam that answers the network inspect and records every call. */
function docker(answers: Array<(argv: string[]) => DockerResult | undefined>): {
  runner: DockerRunner;
  calls: string[][];
} {
  const calls: string[][] = [];
  return {
    calls,
    runner: async (argv) => {
      calls.push(argv);
      for (const a of answers) {
        const r = a(argv);
        if (r) return r;
      }
      return FAIL;
    },
  };
}

const networkUp =
  (gw = MEMORY.gateway) =>
  (argv: string[]) =>
    argv[0] === "network" && argv[1] === "inspect" ? { ...OK, stdout: `${gw}\n` } : undefined;
const verb = (v: string, second?: string) => (argv: string[]) =>
  argv[0] === v && (second === undefined || argv[1] === second) ? OK : undefined;

describe("memory wiring on the container", () => {
  it("attaches the container to the forward's bridge and passes the endpoint + peer id", async () => {
    const keys = keysFilePath({ QCR_OPENVIKING_KEYS: "/host/keys.env" });
    const { runner } = docker([networkUp()]);
    const lc = new CompanionLifecycle(
      CFG,
      runner,
      { QCR_OPENVIKING_KEYS: keys },
      () => {},
      fakeFs({ [keys]: KEY_NAMES.map((n) => `${n}=x`).join("\n") }),
    );
    await lc.resolveMemoryWiring();
    const argv = lc.runArgv();
    expect(argv).toContain("--network");
    expect(argv[argv.indexOf("--network") + 1]).toBe(MEMORY.network);
    // The names the vendored extension's credential resolver actually reads.
    expect(argv).toContain(`OPENVIKING_URL=${memoryEndpoint(MEMORY.gateway)}`);
    expect(argv).toContain(`OPENVIKING_BASE_URL=${memoryEndpoint(MEMORY.gateway)}`);
    expect(argv).toContain(`OPENVIKING_USER=${MEMORY.user}`);
    expect(argv).toContain(`OPENVIKING_PEER_ID=${MEMORY.peerId}`);
    expect(argv).toContain(`QCR_MEMORY_ENDPOINT=${memoryEndpoint(MEMORY.gateway)}`);
    expect(argv).toContain(`QCR_MEMORY_ALERTS_DIR=${CONTAINER.alerts}`);
  });

  it("passes both USER keys by --env-file — never as argv values a `ps` could read", async () => {
    const keys = "/host/keys.env";
    const { runner } = docker([networkUp()]);
    const lc = new CompanionLifecycle(
      CFG,
      runner,
      { QCR_OPENVIKING_KEYS: keys },
      () => {},
      fakeFs({
        [keys]:
          "OPENVIKING_API_KEY=s3cret\nOPENVIKING_COMPANION_KEY=s3cret\nOPENVIKING_REVIEWER_KEY=r3viewer\n",
      }),
    );
    await lc.resolveMemoryWiring();
    const argv = lc.runArgv();
    expect(argv).toContain("--env-file");
    expect(argv[argv.indexOf("--env-file") + 1]).toBe(keys);
    expect(argv.join(" ")).not.toContain("s3cret");
    expect(argv.join(" ")).not.toContain("r3viewer");
  });

  it("never reads the old key file — the column names it and migrate when it is the reason", async () => {
    const home = mkdtempSync(join(tmpdir(), "qcr-keys-note-"));
    const saved = process.env.HOME;
    process.env.HOME = home;
    try {
      const env = { XDG_CONFIG_HOME: join(home, "xdg") };
      const legacy = join(home, ".config", "quickreview-bot", "openviking-keys.env");
      mkdirSync(dirname(legacy), { recursive: true });
      writeFileSync(legacy, "K=1\n");
      const body = KEY_NAMES.map((n) => `${n}=x`).join("\n");
      const primary = join(home, "xdg", "qcr-operator", "default", "openviking-keys.env");
      const lc = new CompanionLifecycle(
        CFG,
        docker([networkUp()]).runner,
        env,
        () => {},
        fakeFs({ [legacy]: body }),
      );
      const w = await lc.resolveMemoryWiring();
      expect(w.keysFile).toBeUndefined(); // no usable key file: memory refuses, the old one is not a stand-in
      const notes = w.notes.join(" ");
      expect(notes).toContain(`no OpenViking keys at ${primary}`);
      expect(notes).toMatch(
        /quickreview-bot\/openviking-keys\.env is no longer read .*qcr install migrate/,
      );
      const lc2 = new CompanionLifecycle(
        CFG,
        docker([networkUp()]).runner,
        env,
        () => {},
        fakeFs({ [primary]: body }),
      );
      expect((await lc2.resolveMemoryWiring()).notes.join(" ")).not.toMatch(/no longer read/);
    } finally {
      if (saved === undefined) delete process.env.HOME;
      else process.env.HOME = saved;
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("holds NO ssh credential: no key mount, no agent socket, even with SSH_AUTH_SOCK set", async () => {
    const { runner } = docker([networkUp()]);
    const lc = new CompanionLifecycle(
      CFG,
      runner,
      { SSH_AUTH_SOCK: "/tmp/agent.sock" },
      () => {},
      fakeFs({}),
    );
    await lc.resolveMemoryWiring();
    const argv = lc.runArgv().join(" ");
    expect(argv).not.toContain("SSH_AUTH_SOCK");
    expect(argv).not.toContain("agent.sock");
    expect(argv).not.toContain(".ssh");
    expect(argv).not.toContain("/ssh-agent");
  });

  it("notes a missing / world-readable keys file instead of failing", async () => {
    const { runner } = docker([networkUp()]);
    const missing = new CompanionLifecycle(
      CFG,
      runner,
      { QCR_OPENVIKING_KEYS: "/host/keys.env" },
      () => {},
      fakeFs({}),
    );
    const w1 = await missing.resolveMemoryWiring();
    expect(w1.keysFile).toBeUndefined();
    expect(w1.notes.join(" ")).toMatch(/no OpenViking keys/);
    // …and the container still starts, memory-less but alive.
    expect(missing.runArgv()).toContain("--network");

    const loose = new CompanionLifecycle(
      CFG,
      docker([networkUp()]).runner,
      { QCR_OPENVIKING_KEYS: "/host/keys.env" },
      () => {},
      fakeFs({ "/host/keys.env": "OPENVIKING_API_KEY=x\n" }, 0o644),
    );
    const w2 = await loose.resolveMemoryWiring();
    expect(w2.notes.join(" ")).toMatch(/chmod 600/);
    expect(w2.notes.join(" ")).toMatch(/OPENVIKING_REVIEWER_KEY/); // missing key named
  });

  it("degrades to memory-less — never wedges — when the bridge cannot be had", async () => {
    const { runner, calls } = docker([verb("network", "create")]); // inspect always fails
    const lc = new CompanionLifecycle(CFG, runner, {}, () => {}, fakeFs({}));
    const wiring = await lc.resolveMemoryWiring();
    expect(wiring.network).toBe("");
    expect(wiring.endpoint).toBe("");
    const argv = lc.runArgv();
    expect(argv).not.toContain("--network");
    expect(argv.join(" ")).not.toContain("OPENVIKING_URL");
    expect(argv[argv.length - 1]).toBe(CFG.image); // still a runnable container
    expect(calls.some((c) => c[1] === "create")).toBe(true);
  });

  it("creates the bridge when absent, then reads its real gateway", async () => {
    let created = false;
    const { runner } = docker([
      (argv) => {
        if (argv[0] !== "network") return undefined;
        if (argv[1] === "create") {
          created = true;
          return OK;
        }
        return created ? { ...OK, stdout: "198.51.100.1\n" } : FAIL;
      },
    ]);
    const lc = new CompanionLifecycle(CFG, runner, {}, () => {}, fakeFs({}));
    const wiring = await lc.resolveMemoryWiring();
    expect(wiring.endpoint).toBe(memoryEndpoint("198.51.100.1"));
    expect(wiring.notes.join(" ")).toMatch(/created docker network/);
  });

  it("connects an already-running container to the bridge (no recreate needed)", async () => {
    const { runner, calls } = docker([
      networkUp(),
      (argv) => (argv[0] === "inspect" ? { ...OK, stdout: "true\n" } : undefined),
      verb("network", "connect"),
    ]);
    const lc = new CompanionLifecycle(CFG, runner, {}, () => {}, fakeFs({}));
    expect(await lc.ensureUp()).toBe("adopted");
    expect(
      calls.some(
        (c) =>
          c[0] === "network" &&
          c[1] === "connect" &&
          c[2] === MEMORY.network &&
          c[3] === CFG.container_name,
      ),
    ).toBe(true);
  });

  it("loads the vendored patched extension when it is present, and shrugs when it is not", async () => {
    const { runner } = docker([networkUp()]);
    const without = new CompanionLifecycle(CFG, runner, {}, () => {}, fakeFs({}));
    expect(without.piArgv().join(" ")).not.toContain("openviking-pi");
    const withExt = new CompanionLifecycle(
      CFG,
      runner,
      {},
      () => {},
      fakeFs({ [`${CFG.repo_dir}/extensions/vendor/openviking-pi/index.ts`]: "" }),
    );
    const argv = withExt.piArgv();
    expect(argv).toContain(MEMORY.extension);
    expect(argv[argv.indexOf(MEMORY.extension) - 1]).toBe("--extension");
  });

  it("refuses to hand docker a file its --env-file parser would reject", async () => {
    // `export FOO=…` is valid shell and invalid to docker; passing it would make
    // `docker run` fail and the companion never start.
    const { runner } = docker([networkUp()]);
    const lc = new CompanionLifecycle(
      CFG,
      runner,
      { QCR_OPENVIKING_KEYS: "/host/keys.env" },
      () => {},
      fakeFs({ "/host/keys.env": "export OPENVIKING_API_KEY=x\nOPENVIKING_REVIEWER_KEY=y\n" }),
    );
    const wiring = await lc.resolveMemoryWiring();
    expect(wiring.keysFile).toBeUndefined();
    expect(wiring.notes.join(" ")).toMatch(/not a docker env-file/);
    expect(lc.runArgv()).not.toContain("--env-file");
    expect(envFileProblems("# c\n\nFOO=bar\n")).toEqual([]);
    expect(envFileProblems("FOO = bar\n")).toHaveLength(1);
  });

  it("reads key NAMES out of an env file without carrying values around", () => {
    const names = keyNamesIn(
      "# comment\nexport OPENVIKING_API_KEY=abc\nOPENVIKING_REVIEWER_KEY = def\nOTHER=1\n",
    );
    expect(names.sort()).toEqual(["OPENVIKING_API_KEY", "OPENVIKING_REVIEWER_KEY"]);
  });

  it("parses a docker gateway and rejects anything that is not one", () => {
    expect(parseGateway("198.51.100.1\n")).toBe("198.51.100.1");
    expect(parseGateway("")).toBe("");
    expect(parseGateway("<no value>\n")).toBe("");
  });

  it("defaults the keys file to the operator home and honours the override", () => {
    expect(keysFilePath({}, "/home/x")).toBe(
      "/home/x/.config/qcr-operator/default/openviking-keys.env",
    );
    expect(keysFilePath({ QCR_OPENVIKING_KEYS: "/elsewhere/k.env" }, "/home/x")).toBe(
      "/elsewhere/k.env",
    );
  });

  it("the TUI and the forward resolve the SAME keys file — neither reads the old copy", async () => {
    const { keysFilePath: forwardKeysFilePath } =
      await import("../scripts/companion-memory-forward.mjs");
    const home = mkdtempSync(join(tmpdir(), "qcr-keys-"));
    const legacy = join(home, ".config", "quickreview-bot", "openviking-keys.env");
    const primary = join(home, "xdg", "qcr-operator", "default", "openviking-keys.env");
    const env = { XDG_CONFIG_HOME: join(home, "xdg") };
    const both = () => [keysFilePath(env, home), forwardKeysFilePath(env, home)];
    expect(both()).toEqual([primary, primary]);
    mkdirSync(dirname(legacy), { recursive: true });
    writeFileSync(legacy, "K=1\n");
    expect(both()).toEqual([primary, primary]);
    mkdirSync(dirname(primary), { recursive: true });
    writeFileSync(primary, "K=1\n");
    expect(both()).toEqual([primary, primary]);
    const named = { ...env, QCR_INSTALL: "second" };
    expect(keysFilePath(named, home)).toBe(forwardKeysFilePath(named, home));
    rmSync(home, { recursive: true, force: true });
  });
});

// ---- the host-owned forward -------------------------------------------------

const forward = await import("../scripts/companion-memory-forward.mjs");

describe("the memory forward", () => {
  const cfg = {
    ...forward.DEFAULTS,
    binds: [forward.DEFAULTS.gateway, "127.0.0.1"],
    controlPath: "/home/x/.ssh/cm-%r@%h:%p",
    identity: undefined,
  };

  it("agrees with the container half on network, subnet and port", () => {
    expect(forward.DEFAULTS.network).toBe(MEMORY.network);
    expect(forward.DEFAULTS.subnet).toBe(MEMORY.subnet);
    expect(forward.DEFAULTS.gateway).toBe(MEMORY.gateway);
    expect(forward.DEFAULTS.port).toBe(MEMORY.port);
  });

  it("relays into the VM container's own netns — nothing is published on the VM", () => {
    const argv = forward.relayArgv(cfg) as string[];
    const remote = argv[argv.length - 1]!;
    expect(argv[argv.length - 2]).toBe("my-vm");
    expect(remote).toContain("sudo docker exec -i quickreview-sandbox node -e");
    // The last hop is loopback INSIDE that container: no VM port, no bridge IP.
    expect(remote).toContain('connect(1933,"127.0.0.1")');
    // A shared control connection, or every HTTP request pays an ssh login.
    expect(argv).toContain("ControlMaster=auto");
    expect(argv).toContain("ControlPersist=4h");
    expect(argv).toContain("BatchMode=yes");
  });

  it("keeps the remote bridge free of single quotes (it is single-quoted for the remote shell)", () => {
    expect(forward.remoteBridgeJs("127.0.0.1", 1933)).not.toContain("'");
  });

  it("writes a systemd --user unit that outlives the TUI and restarts itself", () => {
    const unit = forward.unitText(
      { ...cfg, unit: "qcr-memory-forward" },
      { XDG_RUNTIME_DIR: "/run/user/1000", SSH_AUTH_SOCK: "/run/user/1000/keyring/ssh" },
    ) as string;
    expect(unit).toContain("Restart=always");
    expect(unit).toContain("WantedBy=default.target");
    expect(unit).toContain("ExecStartPre=");
    expect(unit).toContain("ensure-network");
    // $XDG_RUNTIME_DIR is rewritten to %t so the unit survives a reboot.
    expect(unit).toContain("Environment=SSH_AUTH_SOCK=%t/keyring/ssh");
    expect(unit).not.toContain("qcr tui"); // nothing about it depends on the TUI
  });

  it("flags a per-session agent socket rather than baking a path that dies at reboot", () => {
    expect(
      forward.unitAuthSock({
        XDG_RUNTIME_DIR: "/run/user/1000",
        SSH_AUTH_SOCK: "/run/user/1000/keyring/ssh",
      }),
    ).toMatchObject({ stable: true });
    expect(forward.unitAuthSock({ SSH_AUTH_SOCK: "/tmp/ssh-AbC/agent.4242" })).toMatchObject({
      stable: false,
    });
    expect(forward.unitAuthSock({})).toMatchObject({ value: "", stable: false });
  });

  it("moves bytes both ways and tears the pair down when the client goes", async () => {
    // A fake relay: two PassThroughs standing in for ssh's stdio. Proves the
    // socket↔child plumbing without spawning anything.
    const relay = {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      killed: false,
      kill(): void {
        this.killed = true;
      },
      on(): void {},
      stderr: undefined,
    };
    const fwd = forward.createForwarder(
      { ...cfg, binds: ["127.0.0.1"], port: 0 },
      { spawnRelay: () => relay, log: () => {} },
    );
    await fwd.listen();
    const port = (fwd.addresses() as Array<{ port: number }>)[0]!.port;
    const client: Socket = connect(port, "127.0.0.1");
    await new Promise((r) => client.once("connect", r));
    client.write("GET /health\n");
    const upstream = await new Promise<string>((r) =>
      relay.stdin.once("data", (d: Buffer) => r(d.toString())),
    );
    expect(upstream).toBe("GET /health\n");
    relay.stdout.write("HTTP/1.1 200 OK\n");
    const back = await new Promise<string>((r) =>
      client.once("data", (d: Buffer) => r(d.toString())),
    );
    expect(back).toBe("HTTP/1.1 200 OK\n");
    client.destroy();
    // Until the teardown lands, by deadline: a fixed 20ms sleep lost the race
    // to the socket close on a loaded machine.
    const deadline = Date.now() + 4_000;
    while (!relay.killed && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
    expect(relay.killed).toBe(true);
    fwd.close();
  });

  it("close() kills relays still in flight — a live caller must not strand ssh children", async () => {
    // `server.close()` only stops accepting. The TUI now owns a forward while
    // it runs, so a close that left the pairs alive would leak one
    // ssh + remote docker exec per open connection on every quit.
    const relay = {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      killed: false,
      kill(): void {
        this.killed = true;
      },
      on(): void {},
      stderr: undefined,
    };
    const fwd = forward.createForwarder(
      { ...cfg, binds: ["127.0.0.1"], port: 0 },
      { spawnRelay: () => relay, log: () => {} },
    );
    await fwd.listen();
    const port = (fwd.addresses() as Array<{ port: number }>)[0]!.port;
    const client: Socket = connect(port, "127.0.0.1");
    await new Promise((r) => client.once("connect", r));
    expect(fwd.liveRelays()).toBe(1);
    // The client is still connected — exactly the case that used to leak.
    fwd.close();
    expect(relay.killed).toBe(true);
    expect(fwd.liveRelays()).toBe(0);
    client.destroy();
  });

  // ----: the flood, collapsed ---------------------------------------
  //
  // A missing agent key used to fill the journal with thousands of
  // `relay #N exited 255` lines — a symptom, repeated, naming neither a cause
  // nor a remedy, because every HTTP connection spawns its own relay.

  it("names the likely cause and the exact command for each failure shape", () => {
    const cause = (text: string) =>
      forward.relayFailureCause({ ...cfg, identity: "/home/x/.ssh/gce" }, text) as {
        key: string;
        cause: string;
        remedy: string;
      };
    expect(cause("my-vm: Permission denied (publickey).")).toMatchObject({
      key: "auth",
      remedy: "ssh-add /home/x/.ssh/gce",
    });
    expect(cause("ssh: Could not resolve hostname my-vm")).toMatchObject({
      key: "host",
      remedy: "ssh -v my-vm true",
    });
    expect(cause("Control socket connect(/home/x/.ssh/cm): Connection refused")).toMatchObject({
      key: "mux",
      remedy: "ssh -O exit my-vm",
    });
    // The docker daemon's own refusal also says "permission denied" — it must
    // not be mistaken for an ssh key problem and send the operator to ssh-add.
    expect(
      cause("permission denied while trying to connect to the Docker daemon socket"),
    ).toMatchObject({ key: "docker" });
    expect(cause("").key).toBe("unknown");
  });

  it("collapses a repeating failure into ONE line, rate-limited, and says when it recovers", () => {
    const lines: string[] = [];
    let now = 0;
    const c = forward.createFailureCollapser({
      log: (l: string) => lines.push(l),
      now: () => now,
      windowMs: 60_000,
    });
    const auth = { key: "auth", cause: "no usable key", remedy: "ssh-add k" };
    for (let i = 0; i < 500; i++) {
      now += 10;
      c.fail(auth);
    }
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("no usable key");
    expect(lines[0]).toContain("fix: ssh-add k");
    // Past the window it is worth saying again — with how many it swallowed.
    now += 61_000;
    c.fail(auth);
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain("499 similar failures suppressed");
    // A different cause is never suppressed behind the first one.
    c.fail({ key: "host", cause: "my-vm did not answer", remedy: "ssh -v my-vm true" });
    expect(lines).toHaveLength(3);
    // …and recovery is its own line, with no restart involved.
    c.ok();
    expect(lines[3]).toContain("relay recovered");
    expect(lines[3]).toContain("502 failures"); // 500 auth + 1 auth after the window + 1 host
    expect(lines[3]).toContain("499 suppressed");
    c.ok();
    expect(lines).toHaveLength(4); // nothing to say the second time
  });

  it("counts what it hid ACROSS a change of cause — the honest-repeat feature must not itself lie", () => {
    // The exact shape the review found: five auth failures (four
    // suppressed), then one host failure. The old counter reset on the cause
    // change, so the recovery line claimed "0 suppressed" after hiding four.
    const lines: string[] = [];
    let now = 0;
    const c = forward.createFailureCollapser({
      log: (l: string) => lines.push(l),
      now: () => now,
      windowMs: 60_000,
    });
    const auth = { key: "auth", cause: "no usable key", remedy: "ssh-add k" };
    for (let i = 0; i < 5; i++) {
      now += 10;
      c.fail(auth);
    }
    c.fail({ key: "host", cause: "host did not answer", remedy: "ssh -v h true" });
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain("4 similar failures suppressed");
    c.ok();
    expect(lines[2]).toContain("6 failures");
    expect(lines[2]).toContain("4 suppressed");
  });

  it("recovers on its own once the key is back — the next working relay clears it", async () => {
    const lines: string[] = [];
    let mode: "fail" | "ok" = "fail";
    const spawnRelay = () => {
      const child = {
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        kill(): void {},
        on(event: string, cb: (arg: unknown) => void): void {
          if (event === "exit" && mode === "fail") setTimeout(() => cb(255), 5);
        },
      };
      if (mode === "fail")
        setTimeout(() => child.stderr.write("Permission denied (publickey).\n"), 1);
      else setTimeout(() => child.stdout.write("HTTP/1.1 200 OK\n"), 5);
      return child;
    };
    const fwd = forward.createForwarder(
      { ...cfg, binds: ["127.0.0.1"], port: 0 },
      { spawnRelay, log: (l: string) => lines.push(l) },
    );
    await fwd.listen();
    const port = (fwd.addresses() as Array<{ port: number }>)[0]!.port;
    const hit = async (): Promise<void> => {
      const client: Socket = connect(port, "127.0.0.1");
      await new Promise((r) => client.once("connect", r));
      await new Promise((r) => setTimeout(r, 30));
      client.destroy();
    };
    await hit();
    await hit();
    await hit();
    const failures = lines.filter((l) => l.startsWith("relay failing:"));
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("ssh-add");
    // The key is added; nothing restarts, and the next relay proves it works.
    mode = "ok";
    await hit();
    expect(lines.some((l) => l.startsWith("relay recovered"))).toBe(true);
    fwd.close();
  });
});

// ---- the two-key confinement proof -----------------------------------------

describe("reverse direction: the reviewer key cannot reach companion memory", () => {
  it("expects reach for the companion's own pair and REFUSAL for the reviewer key on companion memory", () => {
    const rows = forward.expectations() as Array<{ who: string; ns: string; want: string }>;
    expect(rows.find((r) => r.who === "companion" && r.ns === "companion")!.want).toBe("reach");
    expect(rows.find((r) => r.who === "reviewer" && r.ns === "reviewer")!.want).toBe("reach");
    expect(rows.find((r) => r.who === "reviewer" && r.ns === "companion")!.want).toBe("refused");
    expect(rows.find((r) => r.who === "companion" && r.ns === "reviewer")!.want).toBe("refused");
  });

  it("classifies 2xx as reach, 401/403 as refusal, and anything else as inconclusive", () => {
    expect(forward.classify(200, {})).toBe("reach");
    expect(forward.classify(204, {})).toBe("reach");
    expect(forward.classify(403, {})).toBe("refused");
    expect(forward.classify(401, {})).toBe("refused");
    expect(forward.classify(404, {})).toBe("inconclusive");
    expect(forward.classify(500, {})).toBe("inconclusive");
  });

  it("reads OpenViking's 200-with-error envelope rather than trusting the status line", () => {
    // The server answers some errors HTTP 200 with {status:"error"} in the body.
    expect(
      forward.classify(200, {
        status: "error",
        error: { message: "permission denied for user companion" },
      }),
    ).toBe("refused");
    // An error that is not about permissions proves nothing either way.
    expect(forward.classify(200, { status: "error", error: { message: "no such uri" } })).toBe(
      "inconclusive",
    );
  });

  it("never scores an inconclusive probe as a pass", () => {
    expect(forward.verdictFor("refused", "inconclusive")).toBe("INCONCLUSIVE");
    expect(forward.verdictFor("refused", "reach")).toBe("FAIL");
    expect(forward.verdictFor("refused", "refused")).toBe("PASS");
  });

  it("passes on a server that confines both keys, and FAILS the moment the reviewer key can read companion memory", async () => {
    // The confinement the server actually enforces: the Bearer key owns one
    // user, and X-OpenViking-User names the user being addressed.
    const confined = async (_url: string, init?: { headers?: Record<string, string> }) => {
      const owner =
        init?.headers?.Authorization === "Bearer companion-key" ? "companion" : "reviewer";
      const addressed = init?.headers?.["X-OpenViking-User"];
      return { status: owner === addressed ? 200 : 403, json: async () => ({}) };
    };
    const lines: string[] = [];
    const good = await forward.runVerify({
      base: "http://127.0.0.1:1933",
      keys: { companion: "companion-key", reviewer: "reviewer-key" },
      fetchFn: confined,
      log: (l: string) => lines.push(l),
    });
    expect(good.failed).toBe(0);
    expect(good.unclear).toBe(0);
    expect(lines.join("\n")).toContain("4 pass");

    const leaky = await forward.runVerify({
      base: "http://127.0.0.1:1933",
      keys: { companion: "companion-key", reviewer: "reviewer-key" },
      fetchFn: async () => ({ status: 200, json: async () => ({}) }),
      log: () => {},
    });
    expect(leaky.failed).toBe(2); // both "must be refused" rows
  });

  it("reports a missing key as inconclusive rather than quietly passing", async () => {
    const report = await forward.runVerify({
      base: "http://127.0.0.1:1933",
      keys: { companion: "companion-key" },
      fetchFn: async () => ({ status: 200, json: async () => ({}) }),
      log: () => {},
    });
    expect(report.unclear).toBeGreaterThan(0);
  });
});

// ---- degradation: unreachable memory alerts, and nothing wedges -------------

const health = await import("../docker/companion/memory-health.mjs");

describe("memory health watcher", () => {
  it("only believes an outage after consecutive failures, and announces each transition once", () => {
    let state = health.initialState();
    const emits: Array<string | null> = [];
    for (const ok of [false, false, false, false, false]) {
      const step = health.decide(state, { ok, reason: "ECONNREFUSED" });
      state = step.state;
      emits.push(step.emit);
    }
    expect(emits).toEqual([null, null, "down", null, null]); // one alert, not five
    const back = health.decide(state, { ok: true, reason: "ready" });
    expect(back.emit).toBe("up");
    expect(health.decide(back.state, { ok: true, reason: "ready" }).emit).toBe(null);
  });

  it("a single blip never alerts", () => {
    const state = health.initialState();
    const blip = health.decide(state, { ok: false, reason: "timeout" });
    expect(blip.emit).toBe(null);
    expect(health.decide(blip.state, { ok: true, reason: "ready" }).emit).toBe(null);
  });

  it("a deploy-grace window holds the alert; an outage that outlives it alerts on the NEXT failed probe", () => {
    // The deploy window: five failed probes, all in grace — silence.
    let state = health.initialState();
    for (let i = 0; i < 5; i++) {
      const step = health.decide(state, { ok: false, reason: "timeout" }, true);
      expect(step.emit).toBe(null);
      state = step.state;
    }
    // Grace lapses with the chain still dead: the very next probe announces —
    // the count kept climbing under the hold, nothing restarts from zero.
    const after = health.decide(state, { ok: false, reason: "timeout" }, false);
    expect(after.emit).toBe("down");
    // And recovery still announces exactly once.
    expect(health.decide(after.state, { ok: true, reason: "ready" }).emit).toBe("up");
  });

  it("a deploy that recovers inside the grace announces NOTHING — no down, so no up notice either", () => {
    let state = health.initialState();
    for (let i = 0; i < 4; i++)
      state = health.decide(state, { ok: false, reason: "timeout" }, true).state;
    const back = health.decide(state, { ok: true, reason: "ready" });
    expect(back.emit).toBe(null);
    expect(back.state.fails).toBe(0);
  });

  it("deployGraceActive: fresh marker opens it, stale or missing or future-dated does not", () => {
    const now = 1_000_000_000;
    const statAt = (mtimeMs: number) => () => ({ mtimeMs });
    expect(health.deployGraceActive("/a", now, health.DEPLOY_GRACE_MS, statAt(now - 60_000))).toBe(
      true,
    );
    expect(
      health.deployGraceActive(
        "/a",
        now,
        health.DEPLOY_GRACE_MS,
        statAt(now - health.DEPLOY_GRACE_MS),
      ),
    ).toBe(false);
    // A future mtime is corruption, and corruption must fail toward alerting
    // (noisy), never toward an open-ended mute (silent).
    expect(health.deployGraceActive("/a", now, health.DEPLOY_GRACE_MS, statAt(now + 60_000))).toBe(
      false,
    );
    const missing = () => {
      throw new Error("ENOENT");
    };
    expect(health.deployGraceActive("/a", now, health.DEPLOY_GRACE_MS, missing)).toBe(false);
    // Dotfile — AlertConsumer skips dotfiles, so the marker can never be
    // parsed as an alert.
    expect(health.DEPLOY_MARKER.startsWith(".")).toBe(true);
  });

  it("deploy.sh opens and closes the SAME marker the watcher reads (name parity is the contract)", () => {
    const deploysh = readFileSync(resolve(root, "scripts/deploy.sh"), "utf8");
    expect(deploysh).toContain(health.DEPLOY_MARKER);
    // Stamped before the disruptive phase, removed once the chain answers.
    expect(deploysh.indexOf(health.DEPLOY_MARKER)).toBeLessThan(
      deploysh.indexOf('"${ANSIBLE_CMD[@]}"'),
    );
    expect(deploysh).toContain('rm -f "$DEPLOY_MARKER_FILE"');
  });

  it("writes an alert file the EXISTING alert policy can parse and route", async () => {
    const dir = mkdtempSync(join(tmpdir(), "qcr-memalert-"));
    const endpoint = "http://198.51.100.1:1933";
    const body = health.alertBody("down", {
      endpoint,
      reason: "connect ECONNREFUSED",
      at: new Date().toISOString(),
      fails: 3,
    });
    const name = health.writeAlertFile(dir, body);
    const parsed = parseAlert(readFileSync(join(dir, name), "utf8"), name);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.alert.tier).toBe("alert");
      expect(parsed.alert.cause).toBe(health.CAUSE_DOWN);
      expect(parsed.alert.body).toContain("systemctl --user status qcr-memory-forward");
    }
    // Recovery is a notice, not a second emergency.
    const up = health.alertBody("up", {
      endpoint,
      reason: "ready",
      at: new Date().toISOString(),
      fails: 0,
    });
    expect(up.tier).toBe("notice");
    expect(up.cause).toBe(health.CAUSE_UP);
    // Nothing half-written is ever visible to the consumer.
    expect(readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("probes /health then /ready and never throws", async () => {
    const seen: string[] = [];
    const ok = await health.probe("http://x", 10, async (url: string) => {
      seen.push(url);
      return { ok: true, status: 200 };
    });
    expect(seen).toEqual(["http://x/health", "http://x/ready"]);
    expect(ok).toEqual({ ok: true, reason: "ready" });
    // 503 from /ready is "up but not serving memory" — degraded, not a crash.
    const notReady = await health.probe("http://x", 10, async (url: string) => ({
      ok: !url.endsWith("/ready"),
      status: url.endsWith("/ready") ? 503 : 200,
    }));
    expect(notReady).toEqual({ ok: false, reason: "ready 503" });
    const dead = await health.probe("http://x", 10, async () => {
      throw new Error("ECONNREFUSED");
    });
    expect(dead.ok).toBe(false);
  });

  it("stays silent when no endpoint is wired (memory-less is a legal mode)", () => {
    expect(health.watcherConfig({}).endpoint).toBe("");
    expect(health.watcherConfig({ OPENVIKING_URL: "http://a:1933/" }).endpoint).toBe(
      "http://a:1933",
    );
    expect(
      health.watcherConfig({
        QCR_MEMORY_ENDPOINT: "http://b:1933",
        QCR_MEMORY_PROBE_INTERVAL_S: "5",
      }).intervalMs,
    ).toBe(5000);
  });
});

// ---- the container image ----------------------------------------------------

describe("companion image carries the memory path, not a credential", () => {
  const dockerfile = readFileSync(resolve(root, "docker/companion/Dockerfile"), "utf8");
  const entrypoint = readFileSync(resolve(root, "docker/companion/entrypoint.sh"), "utf8");

  it("bakes the health watcher in (it must start with the container, not with a build)", () => {
    expect(dockerfile).toContain("COPY memory-health.mjs /usr/local/lib/qcr/memory-health.mjs");
    expect(entrypoint).toContain("node /usr/local/lib/qcr/memory-health.mjs &");
    // Backgrounded and guarded: the watcher can never keep the container down.
    // PID 1 parks on `wait` rather than exec'ing sleep, so SIGTERM
    // is actually handled — but it still parks, which is what this asserts.
    expect(entrypoint).toMatch(/wait "\$child" \|\| true/);
  });

  it("keeps the alert dir as the watcher's only output surface", () => {
    expect(entrypoint).toContain("QCR_MEMORY_ENDPOINT");
    expect(entrypoint).not.toContain("ssh-agent");
  });
});

// ---- documentation ----------------------------------------------------------

// The ops doc is private-deployment topology and is excluded from the
// assembled public snapshot — the block self-skips where it is absent.
const opsDocPath = resolve(root, "docs/companion-memory-access.md");
describe.skipIf(!existsSync(opsDocPath))("provisioning is documented, not folklore", () => {
  const doc = existsSync(opsDocPath) ? readFileSync(opsDocPath, "utf8") : "";

  it("documents the systemd install, the keys file and the confinement check", () => {
    expect(doc).toContain("companion-memory-forward.mjs install");
    expect(doc).toContain("loginctl enable-linger");
    expect(doc).toContain("openviking-keys.env");
    expect(doc).toContain("companion-memory-forward.mjs verify");
  });

  it("states the boundary the slice must not widen", () => {
    for (const forbidden of ["never GitHub", "never the gate", "deploy.sh"])
      expect(doc).toContain(forbidden);
    expect(doc).toMatch(/ADMIN|ROOT/); // the never-provision-an-admin-key rule
  });
});
