// [P8.3] The model's bash commands inherit the descriptors a host names, and
// only those. Node closes every fd a child is not listed with, so the bot
// worker's IPC capability (the fd the post scripts read) reaches `bash -c` and
// the scripts under it only when the spawn names it: packages/pi-plugin/src/engine/tooluid.ts
// `commandStdio`, `inheritingBashOperations` and the third argument of
// `isolatedBashOperations`, and src/engine/botsdk.ts for where the number comes from.
import {
  chmodSync,
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { botSdkExtras } from "../src/engine/botsdk.js";
import type { SessionSpec } from "@quickchatai/pi-quickreview/src/engine/port.js";
import {
  commandStdio,
  inheritingBashOperations,
  isolatedBashOperations,
} from "@quickchatai/pi-quickreview/src/engine/tooluid.js";
import { sessionGitConfigPins } from "../src/sessions.js";

let dir: string;
let fd: number;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "inherit-fds-"));
  writeFileSync(join(dir, "cap"), "0123456789abcdef0123456789abcdef");
  fd = openSync(join(dir, "cap"), "r");
});
afterEach(() => {
  closeSync(fd);
  rmSync(dir, { recursive: true, force: true });
});

describe("[P8.3] commandStdio", () => {
  it("is stdin, stdout and stderr, and each named fd at its own number", () => {
    expect(commandStdio([])).toEqual(["ignore", "pipe", "pipe"]);
    expect(commandStdio([3])).toEqual(["ignore", "pipe", "pipe", 3]);
    expect(commandStdio([5])).toEqual(["ignore", "pipe", "pipe", "ignore", "ignore", 5]);
    expect(commandStdio([3, 4])).toEqual(["ignore", "pipe", "pipe", 3, 4]);
  });

  it("refuses an fd that is not a descriptor above stderr", () => {
    for (const bad of [0, 1, 2, -1, 1.5, Number.NaN]) expect(() => commandStdio([bad])).toThrow();
  });
});

describe("[P8.3] a command reads the capability only where the host hands it over", () => {
  const read = (ops: ReturnType<typeof inheritingBashOperations>, command: string) => {
    let out = "";
    return ops
      .exec(command, dir, {
        onData: (d) => (out += d.toString()),
        env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin" },
      })
      .then((r) => ({ ...r, out }));
  };

  it("inheritingBashOperations: the fd is open in the command, at the same number, readable with pread", async () => {
    const r = await read(inheritingBashOperations([fd]), `head -c 32 /proc/self/fd/${fd}`);
    expect(r.exitCode).toBe(0);
    expect(r.out).toBe("0123456789abcdef0123456789abcdef");
  });

  it("a script under the command inherits it too", async () => {
    const script = join(dir, "reader.sh");
    writeFileSync(script, `#!/bin/sh\nhead -c 8 /proc/self/fd/${fd}\n`);
    chmodSync(script, 0o755);
    const r = await read(inheritingBashOperations([fd]), `sh ${script}`);
    expect(r.out).toBe("01234567");
  });

  it("without it, the fd is closed in the command (what a plain Node spawn does)", async () => {
    const r = await read(inheritingBashOperations([]), `head -c 32 /proc/self/fd/${fd}`);
    expect(r.exitCode).not.toBe(0);
    expect(r.out).not.toContain("0123456789");
  });

  it("isolatedBashOperations hands it through setpriv", async () => {
    const bin = join(dir, "bin");
    mkdirSync(bin);
    writeFileSync(
      join(bin, "setpriv"),
      `#!/bin/sh\nwhile [ "$1" != -- ]; do shift; done\nshift\nexec "$@"\n`,
    );
    chmodSync(join(bin, "setpriv"), 0o755);
    const ops = isolatedBashOperations({ uid: "65534", gid: "1000" }, join(bin, "setpriv"), [fd]);
    const r = await read(ops, `head -c 4 /proc/self/fd/${fd}`);
    expect(r.out).toBe("0123");
    const plain = await read(
      isolatedBashOperations({ uid: "65534", gid: "1000" }, join(bin, "setpriv")),
      `head -c 4 /proc/self/fd/${fd}`,
    );
    expect(plain.exitCode).not.toBe(0);
  });

  it("an abort or a timeout still ends the command's group", async () => {
    const ops = inheritingBashOperations([fd]);
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 150);
    const t0 = Date.now();
    await expect(
      ops.exec("sleep 30", dir, {
        onData: () => {},
        env: { PATH: "/usr/bin:/bin" },
        signal: ac.signal,
      }),
    ).rejects.toThrow("aborted");
    await expect(
      ops.exec("sleep 30", dir, { onData: () => {}, env: { PATH: "/usr/bin:/bin" }, timeout: 0.3 }),
    ).rejects.toThrow("timeout:0.3");
    expect(Date.now() - t0).toBeLessThan(5000);
  });

  it("refuses a missing working directory and a bad timeout, as the tool uid's does", async () => {
    const ops = inheritingBashOperations([fd]);
    await expect(
      ops.exec("true", join(dir, "nope"), { onData: () => {}, env: {} }),
    ).rejects.toThrow(/Working directory does not exist/);
    await expect(ops.exec("true", dir, { onData: () => {}, env: {}, timeout: -1 })).rejects.toThrow(
      /Invalid timeout/,
    );
  });
});

describe("[P8.3] the bot session names the fd from QCR_IPC_CAP_FD", () => {
  const spec = (over: Record<string, string | undefined>): SessionSpec => ({
    cwd: dir,
    env: {
      PATH: process.env["PATH"],
      HOME: join(dir, "home"),
      QCR_SANDBOX_ROOT: dir,
      QCR_SESSION_NAME: "pr-7",
      QCR_PR: "7",
      QCR_LEDGER_FILE: join(dir, "pr-7.md"),
      OPENVIKING_USER: "reviewer",
      OPENVIKING_PEER_ID: "pr-7",
      ...sessionGitConfigPins(join(dir, "home")),
      ...over,
    },
    model: "faux/m",
    systemPromptFile: join(dir, "system.md"),
    eventsFile: join(dir, "e.jsonl"),
    stderrFile: join(dir, "e.log"),
    limits: { timeoutMs: 1000 },
  });
  const extras = (s: SessionSpec) =>
    botSdkExtras({
      lens: { factories: [], toolNames: [] },
      processEnv: {},
      openViking: (c) => ({ ...c, config: { ...c.config, enabled: false } }),
    })(s);

  beforeEach(() => {
    mkdirSync(join(dir, "deploy", "reviewer"), { recursive: true });
    writeFileSync(join(dir, "system.md"), "x");
    writeFileSync(join(dir, "AGENTS.override.md"), "stub");
  });

  it("an open fd is inherited; no variable means none", () => {
    expect(extras(spec({ QCR_IPC_CAP_FD: String(fd) })).inheritFds).toEqual([fd]);
    expect(extras(spec({})).inheritFds).toBeUndefined();
    expect(extras(spec({ QCR_IPC_CAP_FD: "" })).inheritFds).toBeUndefined();
  });

  it("a fd that is not open, or not a number, stops the session before it exists", () => {
    expect(() => extras(spec({ QCR_IPC_CAP_FD: "987" }))).toThrow(/fd 987, which is not open/);
    for (const bad of ["abc", "2", "-1", "3x"])
      expect(() => extras(spec({ QCR_IPC_CAP_FD: bad })), bad).toThrow(/not an fd number/);
  });
});
