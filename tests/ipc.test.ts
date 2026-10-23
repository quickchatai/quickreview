// The worker-daemon IPC: framing, the version gate, capabilities and
// how they reach a process, the server's per-request checks, launch files.
import { spawn, execFileSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readSync,
  rmSync,
  statSync,
  fstatSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IpcClient, connectFromEnv, hasIpcEnv } from "../src/ipc/client.js";
import {
  CAP_FD_INDEX,
  CapabilityStore,
  LAUNCH_FILE_TTL_MS,
  LaunchFiles,
  capsDirOf,
  claimLaunchFile,
  createCapabilityFd,
  ensurePrivateDir,
  ipcEnv,
  readCapabilityFd,
  runDirOf,
  socketPathOf,
  stdioWithCapability,
} from "../src/ipc/capability.js";
import { runLauncher } from "../src/ipc/launcher.js";
import {
  type CommandState,
  IPC_EVENT_KINDS,
  IPC_VERSION,
  type IpcError,
  LineDecoder,
  MAX_LINE_BYTES,
  decodeMessage,
  encodeMessage,
} from "../src/ipc/protocol.js";
import { type RequestContext, IpcServer } from "../src/ipc/server.js";
import { waitFor } from "./helpers/wait-for.js";

const mode = (p: string): number => statSync(p).mode & 0o777;

describe("framing", () => {
  it("splits lines across chunk boundaries, including a multibyte character", () => {
    const d = new LineDecoder();
    const line = JSON.stringify({ s: "zażółć" }) + "\n";
    const buf = Buffer.from(line + line);
    const cut = buf.indexOf(Buffer.from("ż")) + 1; // inside the 2-byte character
    expect(d.push(buf.subarray(0, cut))).toEqual([]);
    expect(d.push(buf.subarray(cut))).toEqual([line.trim(), line.trim()]);
  });

  it("skips blank lines and keeps a partial line pending", () => {
    const d = new LineDecoder();
    expect(d.push(Buffer.from('\n\n{"a":1}\n{"b"'))).toEqual(['{"a":1}']);
    expect(d.push(Buffer.from(":2}\n"))).toEqual(['{"b":2}']);
  });

  it("refuses an oversize line, with or without its newline", () => {
    const withNl = new LineDecoder(16);
    expect(() => withNl.push(Buffer.from("x".repeat(17) + "\n"))).toThrow(/over 16 bytes/);
    // No newline yet: the bound is enforced as the bytes arrive.
    const noNl = new LineDecoder(16);
    noNl.push(Buffer.from("x".repeat(10)));
    expect(() => noNl.push(Buffer.from("x".repeat(10)))).toThrowError(
      expect.objectContaining({ code: "line_too_long" }),
    );
    // A line exactly at the bound is fine.
    expect(new LineDecoder(16).push(Buffer.from("x".repeat(16) + "\n"))).toHaveLength(1);
  });

  it("refuses to send an oversize message", () => {
    const big = { v: IPC_VERSION, type: "control", kind: "steer", body: "x".repeat(100) } as const;
    expect(() => encodeMessage(big, 50)).toThrowError(
      expect.objectContaining({ code: "line_too_long" }),
    );
    expect(encodeMessage(big)).toMatch(/\n$/);
    expect(MAX_LINE_BYTES).toBeGreaterThan(1000);
  });
});

describe("messages and the version gate", () => {
  const cap = "a".repeat(32);

  it("refuses an unknown major version before reading anything else", () => {
    expect(() => decodeMessage(JSON.stringify({ v: "2.0", type: "nonsense" }))).toThrowError(
      expect.objectContaining({ code: "unsupported_version" }),
    );
    expect(() => decodeMessage(JSON.stringify({ v: "0.9", type: "request" }))).toThrowError(
      expect.objectContaining({ code: "unsupported_version" }),
    );
  });

  it("accepts a newer minor of the same major", () => {
    const m = decodeMessage(
      JSON.stringify({ v: "1.7", type: "control", kind: "steer", extra: true }),
    );
    expect(m).toMatchObject({ type: "control", kind: "steer" });
  });

  it("types the malformed", () => {
    const code = (line: string): string => {
      try {
        decodeMessage(line);
      } catch (e) {
        return (e as IpcError).code;
      }
      return "none";
    };
    expect(code("not json")).toBe("bad_frame");
    expect(code("[1]")).toBe("bad_frame");
    expect(code(JSON.stringify({ type: "hello" }))).toBe("bad_request"); // no v
    expect(code(JSON.stringify({ v: 1, type: "hello" }))).toBe("bad_request"); // v not a string
    expect(code(JSON.stringify({ v: IPC_VERSION, type: "who" }))).toBe("bad_request");
    expect(
      code(
        JSON.stringify({
          v: IPC_VERSION,
          type: "hello",
          role: "root",
          command_id: "c1",
          capability: cap,
        }),
      ),
    ).toBe("bad_request");
    expect(
      code(
        JSON.stringify({
          v: IPC_VERSION,
          type: "hello",
          role: "worker",
          command_id: "c1",
          capability: "short",
        }),
      ),
    ).toBe("unauthorized");
    expect(
      code(JSON.stringify({ v: IPC_VERSION, type: "event", kind: "lunch", generation: 1 })),
    ).toBe("bad_request");
    expect(
      code(JSON.stringify({ v: IPC_VERSION, type: "request", id: "1", op: "x", generation: -1 })),
    ).toBe("bad_request");
  });

  it("carries every event kind the worker reports", () => {
    expect([...IPC_EVENT_KINDS]).toEqual([
      "ready",
      "accepted",
      "progress",
      "usage",
      "posted",
      "verdict_written",
      "compacted",
      "done",
      "failed",
    ]);
  });
});

describe("capability handoff", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ipc-cap-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("makes a 128-bit capability per command and verifies it", () => {
    const store = new CapabilityStore();
    const a = store.mint("a");
    const b = store.mint("b");
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(a).not.toBe(b);
    expect(store.verify("a", a)).toBe(true);
    expect(store.verify("a", b)).toBe(false);
    expect(store.verify("nope", a)).toBe(false);
    expect(store.verify("a", "zz")).toBe(false);
    const seen: string[] = [];
    store.onRevoke((id) => seen.push(id));
    store.revoke("a");
    store.revoke("a");
    expect(store.verify("a", a)).toBe(false);
    expect(seen).toEqual(["a"]);
  });

  it("holds the capability in a nameless 0600 file, readable many times by pread", () => {
    const run = join(dir, "run");
    const cap = new CapabilityStore().mint("c");
    const fd = createCapabilityFd(run, cap);
    try {
      expect(mode(run)).toBe(0o700);
      expect(readdirSync(run)).toEqual([]); // nothing left by name
      expect(fstatSync(fd).mode & 0o777).toBe(0o600);
      expect(fstatSync(fd).nlink).toBe(0);
      expect(readCapabilityFd(fd)).toBe(cap);
      // Reading moves no offset: a second reader, and a third, see it too.
      expect(readCapabilityFd(fd)).toBe(cap);
      readSync(fd, Buffer.alloc(8)); // a plain read moves the shared offset
      expect(readCapabilityFd(fd)).toBe(cap);
    } finally {
      closeSync(fd);
    }
  });

  it("never puts the capability in the child's environ or cmdline; env holds only the fd number", async () => {
    const cap = new CapabilityStore().mint("c");
    const fd = createCapabilityFd(join(dir, "run"), cap);
    const sock = socketPathOf(dir);
    const child = spawn(
      process.execPath,
      ["-e", "process.stdin.resume(); setTimeout(() => {}, 60000)"],
      {
        stdio: stdioWithCapability(["pipe", "ignore", "ignore"], fd) as never,
        env: {
          PATH: process.env.PATH,
          ...ipcEnv({ socketPath: sock, commandId: "c", generation: 1 }),
        },
      },
    );
    try {
      // the child has exec'd once its environ carries the fd number, and the fd is the file
      const readable = (): boolean => {
        try {
          return (
            readFileSync(`/proc/${child.pid}/environ`, "utf8").includes("QCR_IPC_CAP_FD") &&
            readFileSync(`/proc/${child.pid}/fd/${CAP_FD_INDEX}`, "utf8") === cap
          );
        } catch {
          return false;
        }
      };
      await waitFor(readable, "the child to start with its capability fd");
      const environ = readFileSync(`/proc/${child.pid}/environ`, "utf8");
      const cmdline = readFileSync(`/proc/${child.pid}/cmdline`, "utf8");
      expect(environ).not.toContain(cap);
      expect(cmdline).not.toContain(cap);
      const vars = Object.fromEntries(
        environ
          .split("\0")
          .filter(Boolean)
          .map((kv) => [kv.slice(0, kv.indexOf("=")), kv.slice(kv.indexOf("=") + 1)]),
      );
      expect(vars.QCR_IPC_CAP_FD).toBe(String(CAP_FD_INDEX));
      expect(vars.QCR_IPC_CAP_FD).toMatch(/^\d+$/);
      // The child's fd really is the file.
      expect(readFileSync(`/proc/${child.pid}/fd/${CAP_FD_INDEX}`, "utf8")).toBe(cap);
    } finally {
      child.kill("SIGKILL");
      closeSync(fd);
    }
  });

  it("lets two shim runs of one round both read the capability through the inherited fd", () => {
    const cap = new CapabilityStore().mint("c");
    const fd = createCapabilityFd(join(dir, "run"), cap);
    // The shim: what a post script's Node client does. It runs as a child of
    // the model's bash (here: sh), which is a child of the host.
    const shim =
      "const fs=require('fs');const b=Buffer.alloc(64);" +
      "const n=fs.readSync(Number(process.env.QCR_IPC_CAP_FD),b,0,64,0);" +
      "process.stdout.write(b.subarray(0,n).toString()+'\\n')";
    try {
      const out = execFileSync("sh", ["-c", `node -e "$SHIM"; node -e "$SHIM"`], {
        stdio: stdioWithCapability(["ignore", "pipe", "inherit"], fd) as never,
        env: {
          PATH: process.env.PATH,
          SHIM: shim,
          ...ipcEnv({ socketPath: "/x", commandId: "c", generation: 1 }),
        },
        encoding: "utf8",
      });
      expect(out.trim().split("\n")).toEqual([cap, cap]);
    } finally {
      closeSync(fd);
    }
  });
});

describe("launch files", () => {
  let state: string;
  let store: CapabilityStore;
  beforeEach(() => {
    state = mkdtempSync(join(tmpdir(), "ipc-launch-"));
    store = new CapabilityStore();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    rmSync(state, { recursive: true, force: true });
  });

  it("writes a 0600 file in a 0700 dir; claiming it unlinks it and yields the fd", () => {
    const cap = store.mint("c");
    const files = new LaunchFiles({ capsDir: capsDirOf(state), store });
    const lf = files.create("c");
    expect(mode(capsDirOf(state))).toBe(0o700);
    expect(mode(lf.path)).toBe(0o600);
    expect(readFileSync(lf.path, "utf8")).toBe(cap);
    const fd = claimLaunchFile(lf.path);
    try {
      expect(existsSync(lf.path)).toBe(false);
      expect(readCapabilityFd(fd)).toBe(cap);
      expect(readCapabilityFd(fd)).toBe(cap);
    } finally {
      closeSync(fd);
    }
    // A second claim finds nothing.
    expect(() => claimLaunchFile(lf.path)).toThrow();
    // Claimed in time: the deadline revokes nothing.
    vi.advanceTimersByTime(LAUNCH_FILE_TTL_MS + 5_000);
    expect(store.verify("c", cap)).toBe(true);
    expect(files.outstanding()).toBe(0);
  });

  it("deletes an unclaimed file after 30 s and revokes its capability (fake clock)", () => {
    const cap = store.mint("c");
    const keep = store.mint("other");
    const files = new LaunchFiles({ capsDir: capsDirOf(state), store });
    const revoked: string[] = [];
    store.onRevoke((id) => revoked.push(id));
    const lf = files.create("c");
    vi.advanceTimersByTime(LAUNCH_FILE_TTL_MS - 1_000);
    expect(existsSync(lf.path)).toBe(true);
    expect(store.verify("c", cap)).toBe(true);
    vi.advanceTimersByTime(2_000);
    expect(existsSync(lf.path)).toBe(false);
    expect(store.verify("c", cap)).toBe(false);
    expect(revoked).toEqual(["c"]);
    expect(store.verify("other", keep)).toBe(true);
  });

  it("refuses a launch file that is not private, not ours or a symlink", () => {
    const cap = store.mint("c");
    const files = new LaunchFiles({ capsDir: capsDirOf(state), store });
    const lf = files.create("c");
    const loose = join(state, "loose");
    writeFileSync(loose, cap, { mode: 0o644 });
    expect(() => claimLaunchFile(loose)).toThrow(/private/);
    expect(existsSync(loose)).toBe(true); // not unlinked: it was never ours to claim
    const link = join(state, "link");
    execFileSync("ln", ["-s", lf.path, link]);
    expect(() => claimLaunchFile(link)).toThrow();
    expect(existsSync(lf.path)).toBe(true);
  });

  it("clears files a previous daemon left behind", () => {
    store.mint("c");
    const first = new LaunchFiles({ capsDir: capsDirOf(state), store });
    const lf = first.create("c");
    first.dispose();
    new LaunchFiles({ capsDir: capsDirOf(state), store });
    expect(existsSync(lf.path)).toBe(false);
  });

  it("runs the launcher: claims the file, then the command reads the capability from the fd", async () => {
    vi.useRealTimers();
    const cap = store.mint("c");
    const lf = new LaunchFiles({ capsDir: capsDirOf(state), store }).create("c");
    const out = join(state, "out.txt");
    const script =
      "const fs=require('fs');const b=Buffer.alloc(64);" +
      "const fd=Number(process.env.QCR_IPC_CAP_FD);" +
      "fs.writeFileSync(process.argv[1], fd+':'+b.subarray(0,fs.readSync(fd,b,0,64,0)).toString())";
    const code = await runLauncher([lf.path, "--", process.execPath, "-e", script, out], {
      PATH: process.env.PATH,
    });
    expect(code).toBe(0);
    expect(readFileSync(out, "utf8")).toBe(`${CAP_FD_INDEX}:${cap}`);
    expect(existsSync(lf.path)).toBe(false);
    // Nothing left to claim: a second launcher fails without running pi.
    const quiet = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(await runLauncher([lf.path, "--", process.execPath, "-e", "0"], {})).toBe(3);
    expect(await runLauncher([lf.path], {})).toBe(2);
    quiet.mockRestore();
  });
});

/** The daemon's view of its commands, as a test double. */
function fakeCommands() {
  const rows = new Map<string, CommandState>();
  return {
    rows,
    lookup: (id: string): CommandState | null => rows.get(id) ?? null,
    set(id: string, pr: number, over: Partial<CommandState> = {}) {
      rows.set(id, { pr, generation: 1, active: true, may_post: false, lease: "none", ...over });
    },
  };
}

describe("the server", () => {
  let state: string;
  let store: CapabilityStore;
  let cmds: ReturnType<typeof fakeCommands>;
  let server: IpcServer;
  let events: Array<{ id: string; kind: string; body: unknown }>;
  const clients: IpcClient[] = [];
  const sockets: net.Socket[] = [];

  beforeEach(async () => {
    state = mkdtempSync(join(tmpdir(), "ipc-srv-"));
    store = new CapabilityStore();
    cmds = fakeCommands();
    events = [];
    server = new IpcServer({
      socketPath: socketPathOf(state),
      capabilities: store,
      commands: cmds.lookup,
      onEvent: (ctx, kind, body) => events.push({ id: ctx.commandId, kind, body }),
      helloTimeoutMs: 300,
      maxLineBytes: 4096,
    });
    server.register("echo", {
      roles: ["worker", "shim"],
      handle: (ctx: RequestContext, body: unknown) => ({ pr: ctx.pr, role: ctx.role, body }),
    });
    server.register("pr.echo", {
      roles: ["worker"],
      handle: (ctx: RequestContext, body: unknown) => {
        ctx.requirePr((body as { pr: number }).pr);
        return { ok: true, mayPost: ctx.mayPost, lease: ctx.lease };
      },
    });
    server.register("boom", {
      roles: ["worker"],
      handle: () => {
        throw new Error("secret detail /etc/shadow");
      },
    });
    await server.start();
  });

  afterEach(async () => {
    for (const c of clients.splice(0)) c.close();
    for (const s of sockets.splice(0)) s.destroy();
    await server.stop();
    rmSync(state, { recursive: true, force: true });
  });

  async function connect(
    commandId: string,
    capability: string,
    over: { role?: "worker" | "shim"; generation?: number } = {},
  ): Promise<IpcClient> {
    const c = await IpcClient.connect({
      socketPath: socketPathOf(state),
      role: over.role ?? "worker",
      commandId,
      capability,
      generation: over.generation ?? 1,
      timeoutMs: 2000,
      maxLineBytes: 4096,
    });
    clients.push(c);
    return c;
  }

  /** A raw socket: the lines the server sends, and a way to send bytes. */
  function raw() {
    const s = net.connect(socketPathOf(state));
    sockets.push(s);
    const lines: string[] = [];
    const dec = new LineDecoder();
    let closed = false;
    let seen = 0;
    s.on("data", (b) => lines.push(...dec.push(b)));
    s.on("close", () => (closed = true));
    s.on("error", () => {});
    const ready = new Promise<void>((r) => s.once("connect", () => r()));
    return {
      send: async (text: string) => {
        await ready;
        s.write(text);
      },
      lines,
      isClosed: () => closed,
      /** Wait for the next line the server sends (or the hang-up). */
      settle: async () => {
        await waitFor(() => closed || lines.length > seen, "the server's next line");
        seen = lines.length;
      },
      /** Wait for the server to hang up; every line it sent first has arrived by then. */
      hangUp: () => waitFor(() => closed, "the server to hang up", 5000),
    };
  }

  const hello = (command_id: string, capability: string, v = IPC_VERSION) =>
    JSON.stringify({ v, type: "hello", role: "worker", command_id, capability }) + "\n";

  it("listens on <state>/run/qcr.sock with the socket 0600 and the directory 0700", () => {
    expect(socketPathOf(state)).toBe(join(runDirOf(state), "qcr.sock"));
    expect(mode(runDirOf(state))).toBe(0o700);
    expect(mode(socketPathOf(state))).toBe(0o600);
    expect(statSync(socketPathOf(state)).isSocket()).toBe(true);
    expect(statSync(socketPathOf(state)).uid).toBe(process.getuid!());
  });

  it("with group access the tool uid's shims can dial in: the dir 0710, the socket 0660", async () => {
    // MUTATION: keep 0o600 on the socket under groupAccess — this fails
    const dir = mkdtempSync(join(tmpdir(), "ipc-grp-"));
    const shared = new IpcServer({
      socketPath: socketPathOf(dir),
      capabilities: new CapabilityStore(),
      commands: () => null,
      groupAccess: true,
    });
    try {
      await shared.start();
      expect(mode(runDirOf(dir))).toBe(0o710);
      expect(mode(socketPathOf(dir))).toBe(0o660);
      // what else lives in the run dir stays the daemon's alone
      ensurePrivateDir(capsDirOf(dir));
      expect(mode(capsDirOf(dir))).toBe(0o700);
    } finally {
      await shared.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("serves a request from an authenticated command and tells the handler who asked", async () => {
    cmds.set("c1", 7);
    const c = await connect("c1", store.mint("c1"));
    expect(c.pr).toBe(7);
    expect(await c.request("echo", { n: 1 })).toEqual({ pr: 7, role: "worker", body: { n: 1 } });
  });

  it("refuses a wrong, missing or foreign capability, all alike", async () => {
    cmds.set("c1", 7);
    cmds.set("c2", 8);
    const cap1 = store.mint("c1");
    const cap2 = store.mint("c2");
    const code = async (id: string, cap: string): Promise<string> => {
      try {
        await connect(id, cap);
        return "connected";
      } catch (e) {
        return (e as IpcError).code;
      }
    };
    expect(await code("c1", "f".repeat(32))).toBe("unauthorized");
    expect(await code("c1", cap2)).toBe("unauthorized"); // another command's capability
    expect(await code("nobody", cap1)).toBe("unauthorized");
    // Missing: no capability field at all.
    const r = raw();
    await r.send(
      JSON.stringify({ v: IPC_VERSION, type: "hello", role: "worker", command_id: "c1" }) + "\n",
    );
    await r.hangUp();
    expect(JSON.parse(r.lines[0]!).error.code).toBe("bad_request");
    expect(r.isClosed()).toBe(true);
    expect(await code("c1", cap1)).toBe("connected");
  });

  it("refuses a request before any hello, and closes a silent connection", async () => {
    const r = raw();
    await r.send(
      JSON.stringify({ v: IPC_VERSION, type: "request", id: "1", op: "echo", generation: 1 }) +
        "\n",
    );
    await r.hangUp();
    expect(JSON.parse(r.lines[0]!)).toMatchObject({ type: "error", error: { code: "no_hello" } });
    expect(r.isClosed()).toBe(true);
    const silent = raw();
    await silent.hangUp();
    expect(silent.isClosed()).toBe(true);
  });

  it("refuses an unknown major version on the wire", async () => {
    cmds.set("c1", 7);
    const cap = store.mint("c1");
    const r = raw();
    await r.send(hello("c1", cap, "2.0"));
    await r.hangUp();
    expect(JSON.parse(r.lines[0]!).error.code).toBe("unsupported_version");
    expect(r.isClosed()).toBe(true);
  });

  it("refuses an oversize line and hangs up", async () => {
    cmds.set("c1", 7);
    const cap = store.mint("c1");
    const c = await connect("c1", cap);
    const errors: IpcError[] = [];
    c.onError((e) => errors.push(e));
    const r = raw();
    await r.send(hello("c1", cap));
    await r.settle();
    await r.send("x".repeat(5000)); // over the 4096 bound, no newline
    await r.hangUp();
    expect(r.lines.map((l) => JSON.parse(l).error?.code)).toContain("line_too_long");
    expect(r.isClosed()).toBe(true);
    // The other connection is untouched.
    expect(await c.request("echo", 1)).toMatchObject({ pr: 7 });
    // And the client refuses to send one in the first place.
    await expect(c.request("echo", "y".repeat(5000))).rejects.toMatchObject({
      code: "line_too_long",
    });
  });

  it("refuses a stale generation even with the still-valid old capability", async () => {
    cmds.set("c1", 7);
    const cap = store.mint("c1");
    const c = await connect("c1", cap, { generation: 1 });
    expect(await c.request("echo")).toBeDefined();
    cmds.set("c1", 7, { generation: 2 }); // the lease was released, the session moved on
    expect(store.verify("c1", cap)).toBe(true); // the capability itself is still good
    await expect(c.request("echo")).rejects.toMatchObject({ code: "stale_generation" });
    // A guessed or replayed generation authenticates nothing: ahead of the live one is refused too.
    const ahead = await connect("c1", cap, { generation: 5 });
    await expect(ahead.request("echo")).rejects.toMatchObject({ code: "stale_generation" });
    // The current generation works.
    const fresh = await connect("c1", cap, { generation: 2 });
    expect(await fresh.request("echo")).toMatchObject({ pr: 7 });
  });

  it("refuses a request once the command has no active row", async () => {
    cmds.set("c1", 7);
    const c = await connect("c1", store.mint("c1"));
    cmds.set("c1", 7, { active: false });
    await expect(c.request("echo")).rejects.toMatchObject({ code: "command_inactive" });
    cmds.rows.delete("c1");
    await expect(c.request("echo")).rejects.toMatchObject({ code: "command_inactive" });
    await expect(connect("c1", store.get("c1")!)).rejects.toMatchObject({
      code: "command_inactive",
    });
  });

  it("refuses a request for another PR than the command's, even with a good capability", async () => {
    cmds.set("c1", 7);
    cmds.set("c2", 8);
    const c1 = await connect("c1", store.mint("c1"));
    await expect(c1.request("echo", {}, { pr: 8 })).rejects.toMatchObject({ code: "wrong_pr" });
    expect(await c1.request("echo", {}, { pr: 7 })).toBeDefined();
    await expect(c1.request("pr.echo", { pr: 8 })).rejects.toMatchObject({ code: "wrong_pr" });
    expect(await c1.request("pr.echo", { pr: 7 })).toMatchObject({ ok: true });
    // Another command's capability, used for this command's id, is just unauthorized.
    const cap2 = store.mint("c2");
    await expect(connect("c1", cap2)).rejects.toMatchObject({ code: "unauthorized" });
  });

  it("hands the handler the command's lease and may_post", async () => {
    cmds.set("c1", 7, { may_post: true, lease: "debug" });
    const c = await connect("c1", store.mint("c1"));
    expect(await c.request("pr.echo", { pr: 7 })).toEqual({
      ok: true,
      mayPost: true,
      lease: "debug",
    });
  });

  it("enforces the op's roles, rejects unknown ops and hides handler internals", async () => {
    cmds.set("c1", 7);
    const cap = store.mint("c1");
    const shim = await connect("c1", cap, { role: "shim" });
    expect(await shim.request("echo")).toMatchObject({ role: "shim" });
    await expect(shim.request("pr.echo", { pr: 7 })).rejects.toMatchObject({ code: "forbidden" });
    await expect(shim.request("nope")).rejects.toMatchObject({ code: "unknown_op" });
    await expect(shim.request("__proto__")).rejects.toMatchObject({ code: "unknown_op" });
    await expect(shim.request("constructor")).rejects.toMatchObject({ code: "unknown_op" });
    const w = await connect("c1", cap);
    const err = await w.request("boom").catch((e: IpcError) => e);
    expect(err).toMatchObject({ code: "internal", message: "internal error" });
  });

  it("serves two concurrent clients, each with its own command", async () => {
    cmds.set("c1", 7);
    cmds.set("c2", 8);
    const [a, b] = await Promise.all([
      connect("c1", store.mint("c1")),
      connect("c2", store.mint("c2")),
    ]);
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => [
        a.request<{ pr: number; body: number }>("echo", i),
        b.request<{ pr: number; body: number }>("echo", i),
      ]).flat(),
    );
    results.forEach((r, i) => {
      expect(r.body).toBe(Math.floor(i / 2));
      expect(r.pr).toBe(i % 2 === 0 ? 7 : 8);
    });
    expect(server.connections()).toBe(2);
  });

  it("delivers a worker's events, drops a stale one with an unsolicited error, and bars a shim", async () => {
    cmds.set("c1", 7);
    const cap = store.mint("c1");
    const w = await connect("c1", cap);
    const errors: IpcError[] = [];
    w.onError((e) => errors.push(e));
    w.event("ready", { session_id: "s-1" });
    w.event("progress", { stage: "wave" });
    await waitFor(() => events.length === 2, "the worker's two events");
    expect(events).toEqual([
      { id: "c1", kind: "ready", body: { session_id: "s-1" } },
      { id: "c1", kind: "progress", body: { stage: "wave" } },
    ]);
    cmds.set("c1", 7, { generation: 2 });
    w.event("done");
    // the server answers in order: the error is the proof the event was handled (and dropped)
    await waitFor(() => errors.length > 0, "the stale-generation error");
    expect(events).toHaveLength(2);
    expect(errors.map((e) => e.code)).toEqual(["stale_generation"]);
    const shim = await connect("c1", cap, { role: "shim", generation: 2 });
    const shimErrors: IpcError[] = [];
    shim.onError((e) => shimErrors.push(e));
    shim.event("posted");
    await waitFor(() => shimErrors.length > 0, "the forbidden error");
    expect(shimErrors.map((e) => e.code)).toEqual(["forbidden"]);
    expect(events).toHaveLength(2);
  });

  it("closes a command's connections when its capability is revoked", async () => {
    cmds.set("c1", 7);
    cmds.set("c2", 8);
    const c1 = await connect("c1", store.mint("c1"));
    const c2 = await connect("c2", store.mint("c2"));
    let c1Closed = false;
    c1.onClose(() => (c1Closed = true));
    store.revoke("c1");
    await waitFor(() => c1Closed, "the revoked command's connection to close");
    await expect(c1.request("echo")).rejects.toMatchObject({ code: "closed" });
    expect(await c2.request("echo")).toMatchObject({ pr: 8 });
  });

  it("pushes control messages to a command's worker", async () => {
    cmds.set("c1", 7);
    const w = await connect("c1", store.mint("c1"));
    const got: Array<[string, unknown]> = [];
    w.onControl((k, b) => got.push([k, b]));
    expect(server.push("c1", "steer", { text: "look at x" })).toBe(1);
    expect(server.push("nobody", "abort")).toBe(0);
    await waitFor(() => got.length > 0, "the control message");
    expect(got).toEqual([["steer", { text: "look at x" }]]);
  });

  it("connects a host and a shim from env, reading the capability from the fd each time", async () => {
    cmds.set("c1", 7);
    const cap = store.mint("c1");
    const fd = createCapabilityFd(runDirOf(state), cap);
    try {
      const env = {
        ...ipcEnv({ socketPath: socketPathOf(state), commandId: "c1", generation: 1 }),
        QCR_IPC_CAP_FD: String(fd), // in-process: the fd number here is the real one
      };
      expect(hasIpcEnv(env)).toBe(true);
      expect(hasIpcEnv({})).toBe(false);
      for (let i = 0; i < 3; i++) {
        const c = await connectFromEnv("shim", env, { timeoutMs: 2000 });
        expect(await c.request("echo", i)).toMatchObject({ role: "shim", body: i });
        c.close();
      }
      await expect(connectFromEnv("shim", { ...env, QCR_IPC_CAP_FD: "x" })).rejects.toMatchObject({
        code: "bad_request",
      });
      await expect(connectFromEnv("shim", { QCR_IPC_SOCKET: "/x" })).rejects.toMatchObject({
        code: "bad_request",
      });
    } finally {
      closeSync(fd);
    }
  });

  it("replaces a stale socket file but not a live daemon's", async () => {
    const other = new IpcServer({
      socketPath: socketPathOf(state),
      capabilities: store,
      commands: cmds.lookup,
    });
    await expect(other.start()).rejects.toThrow(/already listening/);
    await server.stop();
    expect(existsSync(socketPathOf(state))).toBe(false);
    // A dead daemon's leftover socket file is cleared.
    const dead = net.createServer().listen(socketPathOf(state));
    await new Promise((r) => dead.once("listening", r));
    dead.close();
    await new Promise((r) => dead.once("close", r));
    writeFileSync(join(state, "keep"), "x");
    await other.start();
    await other.stop();
    await server.start(); // afterEach stops it
  });
});

describe("[selfimprove] frames that share a chunk with hello_ok, and big answers", () => {
  it("delivers a control frame that arrives in the same chunk as hello_ok", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ipc-hello-"));
    const sock = join(dir, "s.sock");
    const srv = net.createServer((s) => {
      s.once("data", () => {
        const ok = { v: IPC_VERSION, type: "hello_ok", command_id: "c1", pr: 7, generation: 1 };
        const ctl = { v: IPC_VERSION, type: "control", kind: "abort", body: { n: 1 } };
        s.write(`${JSON.stringify(ok)}\n${JSON.stringify(ctl)}\n`);
      });
    });
    await new Promise<void>((r) => srv.listen(sock, r));
    try {
      const c = await IpcClient.connect({
        socketPath: sock,
        role: "worker",
        commandId: "c1",
        capability: "x",
        generation: 1,
        timeoutMs: 2000,
      });
      const got = new Promise<[string, unknown]>((resolve) =>
        c.onControl((k, b) => resolve([k, b])),
      );
      expect(await got).toEqual(["abort", { n: 1 }]);
      c.close();
    } finally {
      srv.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sends a response over the request limit when maxResponseBytes allows it", async () => {
    const state = mkdtempSync(join(tmpdir(), "ipc-big-"));
    const store = new CapabilityStore();
    const cmds = fakeCommands();
    const server = new IpcServer({
      socketPath: socketPathOf(state),
      capabilities: store,
      commands: cmds.lookup,
      maxLineBytes: 4096,
      maxResponseBytes: 200_000,
    });
    server.register("big", {
      roles: ["shim"],
      handle: () => "z".repeat(100_000),
    });
    await server.start();
    try {
      const cap = store.mint("c1");
      cmds.set("c1", 5);
      const c = await IpcClient.connect({
        socketPath: socketPathOf(state),
        role: "shim",
        commandId: "c1",
        capability: cap,
        generation: 1,
        timeoutMs: 2000,
        maxLineBytes: 200_000,
      });
      expect(await c.request<string>("big")).toHaveLength(100_000);
      c.close();
    } finally {
      await server.stop();
      rmSync(state, { recursive: true, force: true });
    }
  });
});
