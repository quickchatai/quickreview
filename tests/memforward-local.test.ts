// the memory forward's local mode. The ONE relay implementation
// (scripts/companion-memory-forward.mjs) gains a `--local` transport: a plain
// local `docker exec` into the daemon container's netns instead of the ssh
// hop. Everything around the transport — the listener contract, adopt-or-bind
// from the TUI, stop-only-what-we-started, the confinement verify — must be
// byte-identical between the two modes, and the ssh route unchanged.
import { connect, type Socket } from "node:net";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { MemoryForward, type ForwardModule, type ForwarderHandle } from "../src/tui/memforward.js";

const forward = await import("../scripts/companion-memory-forward.mjs");

describe("parseArgs — the local transport is explicit, both entrypoints share it", () => {
  it("defaults to the ssh route — the live production path", () => {
    const { cfg } = forward.parseArgs(["run"], {} as NodeJS.ProcessEnv);
    expect(cfg.local).toBe(false);
    expect(cfg.sshHost).toBe(forward.DEFAULTS.sshHost);
  });

  it("selects local via --local, keeping sudo by default and dropping it on --no-sudo", () => {
    expect(forward.parseArgs(["run", "--local"], {} as NodeJS.ProcessEnv).cfg).toMatchObject({
      local: true,
      sudo: true,
    });
    expect(
      forward.parseArgs(["run", "--local", "--no-sudo"], {} as NodeJS.ProcessEnv).cfg,
    ).toMatchObject({ local: true, sudo: false });
  });

  it("selects local via QCR_MEMORY_LOCAL and via an EXPLICIT empty --ssh-host", () => {
    expect(
      forward.parseArgs(["run"], { QCR_MEMORY_LOCAL: "1" } as NodeJS.ProcessEnv).cfg.local,
    ).toBe(true);
    expect(forward.parseArgs(["run", "--ssh-host="], {} as NodeJS.ProcessEnv).cfg.local).toBe(true);
    // A named host is never local — the mode does not flip by accident.
    expect(
      forward.parseArgs(["run", "--ssh-host", forward.DEFAULTS.sshHost], {} as NodeJS.ProcessEnv)
        .cfg.local,
    ).toBe(false);
  });
});

describe("relaySpawnCommand — the transport decision in one place", () => {
  it("ssh mode wraps the unchanged relayArgv behind the ssh binary", () => {
    const { cfg } = forward.parseArgs(["run"], {} as NodeJS.ProcessEnv);
    expect(forward.relaySpawnCommand(cfg)).toEqual([
      "ssh",
      ...(forward.relayArgv(cfg) as string[]),
    ]);
  });

  it("local mode is a plain docker exec into the same container netns — no ssh anywhere", () => {
    const { cfg } = forward.parseArgs(["run", "--local"], {} as NodeJS.ProcessEnv);
    const cmd = forward.relaySpawnCommand(cfg) as string[];
    expect(cmd.slice(0, 7)).toEqual([
      "sudo",
      "docker",
      "exec",
      "-i",
      "quickreview-sandbox",
      "node",
      "-e",
    ]);
    // The same bridge program, as a real argv element (no shell re-parse).
    expect(cmd[cmd.length - 1]).toBe(forward.remoteBridgeJs("127.0.0.1", 1933));
    expect(cmd).not.toContain("ssh");
    expect(cmd.some((w: string) => w.includes("VM"))).toBe(false);
  });

  it("honours --no-sudo locally", () => {
    const { cfg } = forward.parseArgs(["run", "--local", "--no-sudo"], {} as NodeJS.ProcessEnv);
    expect((forward.relaySpawnCommand(cfg) as string[])[0]).toBe("docker");
  });
});

describe("the systemd unit carries the transport", () => {
  it("writes --local (and no --ssh-host) for a local install, --ssh-host otherwise", () => {
    const base = {
      ...forward.parseArgs(["run"], {} as NodeJS.ProcessEnv).cfg,
      unit: "qcr-memory-forward",
    };
    const sshUnit = forward.unitText(base, {}) as string;
    expect(sshUnit).toContain(`--ssh-host ${forward.DEFAULTS.sshHost}`);
    expect(sshUnit).not.toContain("--local");
    const localUnit = forward.unitText({ ...base, local: true }, {}) as string;
    expect(localUnit).toContain(" --local");
    expect(localUnit).not.toContain("--ssh-host");
  });

  it("names the transport truthfully in the Description an operator reads", () => {
    const base = {
      ...forward.parseArgs(["run"], {} as NodeJS.ProcessEnv).cfg,
      unit: "qcr-memory-forward",
    };
    expect(forward.unitText(base, {}) as string).toContain(
      `OpenViking on ${forward.DEFAULTS.sshHost} ->`,
    );
    const local = forward.unitText({ ...base, local: true }, {}) as string;
    expect(local).toContain("OpenViking on local docker ->");
    expect(local).not.toContain(forward.DEFAULTS.sshHost);
  });
});

describe("the listener contract is transport-independent", () => {
  it("moves bytes both ways and tears the pair down in local mode too", async () => {
    // Identical to the ssh-mode plumbing test (companion-memory.test.ts):
    // only the relay spawner differs, and it is injected here — nothing is
    // ever spawned. Same binds, same adopt-or-bind surface above it.
    const { cfg } = forward.parseArgs(["run", "--local"], {} as NodeJS.ProcessEnv);
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

  it("the confinement verify probes the local listener — no ssh knowledge in the matrix", () => {
    const { cmd, cfg } = forward.parseArgs(["verify", "--local"], {} as NodeJS.ProcessEnv);
    expect(cmd).toBe("verify");
    expect(cfg.base).toBe("http://127.0.0.1:1933");
  });
});

describe("MemoryForward hands the transport to the ONE script (argv-level)", () => {
  function fakeModule(): {
    mod: ForwardModule;
    argvSeen: () => string[] | undefined;
    created: () => number;
  } {
    let argvSeen: string[] | undefined;
    let created = 0;
    const handle: ForwarderHandle = { listen: () => Promise.resolve(2), close: () => {} };
    const mod: ForwardModule = {
      parseArgs: (argv) => {
        argvSeen = argv;
        return {
          cfg: {
            binds: ["127.0.0.1"],
            port: 1933,
            sshHost: "VM",
            container: "quickreview-sandbox",
          },
        };
      },
      createForwarder: () => {
        created += 1;
        return handle;
      },
    };
    return { mod, argvSeen: () => argvSeen, created: () => created };
  }

  const build = (
    deps: { local?: boolean; sudoDocker?: boolean },
    probe = false,
  ): { fwd: MemoryForward; f: ReturnType<typeof fakeModule> } => {
    const f = fakeModule();
    const fwd = new MemoryForward({
      baseUrl: "http://127.0.0.1:1933",
      repoRoot: "/does/not/matter",
      probe: () => Promise.resolve(probe),
      load: () => Promise.resolve(f.mod),
      ...deps,
    });
    return { fwd, f };
  };

  it("passes --local (and --no-sudo per sudo_docker) through the script's own flags", async () => {
    const { fwd, f } = build({ local: true, sudoDocker: false });
    await fwd.ensure();
    expect(f.argvSeen()).toEqual(["run", "--local", "--no-sudo"]);
  });

  it("keeps sudo in local mode when sudo_docker is on", async () => {
    const { fwd, f } = build({ local: true, sudoDocker: true });
    await fwd.ensure();
    expect(f.argvSeen()).toEqual(["run", "--local"]);
  });

  it("leaves the ssh route byte-identical when local is off", async () => {
    const { fwd, f } = build({});
    await fwd.ensure();
    expect(f.argvSeen()).toEqual(["run"]);
  });

  it("adopt-or-bind is transport-independent: an answering forward is adopted, nothing parsed or bound", async () => {
    const { fwd, f } = build({ local: true }, true);
    const st = await fwd.ensure();
    expect(st.state).toBe("adopted");
    expect(f.created()).toBe(0);
    expect(f.argvSeen()).toBeUndefined();
    fwd.stop(); // not ours — stop() must have nothing to close
  });
});
