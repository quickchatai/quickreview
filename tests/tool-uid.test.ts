// [P7.12a] The separate tool uid (src/engine/tooluid.ts), without root: the gate,
// the argv, and the SDK bash tool's execution against a stand-in `setpriv` that
// records what it was asked and then runs the command as this user. The real
// switch of uid, in a container, is tests/tool-uid-container.test.ts.
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import {
  TOOL_UID_ENVS,
  checkToolUid,
  isolatedBashOperations,
  setidHelperOf,
  setprivSwitches,
  shareWithToolGroup,
  toolIdsOf,
  toolIsolation,
  toolUidEnv,
  trustedSetpriv,
} from "../src/engine/tooluid.js";
import { type HostRig, createHostRig, useOfflineGuard } from "./pi-canary/harness.js";

useOfflineGuard();

const SPLIT = { QCR_TOOL_UID: "65534", QCR_TOOL_GID: "1000" };
const SWITCHES = [
  "--reuid=65534",
  "--regid=1000",
  "--clear-groups",
  "--inh-caps=-all",
  "--ambient-caps=-all",
  "--no-new-privs",
];

describe("toolIdsOf", () => {
  it("names the ids, or nothing, or why not", () => {
    expect(toolIdsOf({})).toBeNull();
    expect(toolIdsOf(SPLIT)).toEqual({ uid: "65534", gid: "1000" });
    expect(toolIdsOf({ ...SPLIT, QCR_TOOL_UID_REQUIRED: "1" })).toEqual({
      uid: "65534",
      gid: "1000",
    });
    // the ids win over the accepted shared uid
    expect(toolIdsOf({ ...SPLIT, QCR_ALLOW_SHARED_TOOL_UID: "1" })).toEqual({
      uid: "65534",
      gid: "1000",
    });
    expect(toolIdsOf({ QCR_TOOL_UID_REQUIRED: "1" })).toHaveProperty("refused");
    expect(toolIdsOf({ QCR_TOOL_UID_REQUIRED: "1", QCR_ALLOW_SHARED_TOOL_UID: "1" })).toBeNull();
    for (const bad of [
      { QCR_TOOL_UID: "0", QCR_TOOL_GID: "1000" },
      { QCR_TOOL_UID: "1000", QCR_TOOL_GID: "0" },
      { QCR_TOOL_UID: "x", QCR_TOOL_GID: "1" },
      { QCR_TOOL_UID: "5" },
      { QCR_TOOL_GID: "5" },
      { QCR_TOOL_UID: "1 2", QCR_TOOL_GID: "1" },
      { QCR_TOOL_UID: "$(id)", QCR_TOOL_GID: "1" },
    ])
      expect(toolIdsOf(bad), JSON.stringify(bad)).toHaveProperty("refused");
  });
});

describe("checkToolUid", () => {
  const sdk = { what: "the SDK runtime", instead: "", isolated: true };

  it("a host that isolates passes with numeric, non-zero ids, and with nothing asked", () => {
    expect(() => checkToolUid(SPLIT, sdk)).not.toThrow();
    expect(() => checkToolUid({}, sdk)).not.toThrow();
    expect(() => checkToolUid({ ...SPLIT, QCR_TOOL_UID_REQUIRED: "1" }, sdk)).not.toThrow();
  });

  it("a host that isolates is still refused where the entrypoint could not arrange the split", () => {
    expect(() => checkToolUid({ QCR_TOOL_UID_REQUIRED: "1" }, sdk)).toThrow(
      /the SDK runtime: .*--cap-add SETUID/,
    );
    expect(() => checkToolUid({ QCR_TOOL_UID: "0", QCR_TOOL_GID: "1" }, sdk)).toThrow(
      /non-zero numeric ids/,
    );
    // only the explicit opt-out lets it run on the shared uid
    expect(() =>
      checkToolUid({ QCR_TOOL_UID_REQUIRED: "1", QCR_ALLOW_SHARED_TOOL_UID: "1" }, sdk),
    ).not.toThrow();
  });

  it("a host that cannot isolate is refused wherever the image asks, unless the shared uid is accepted", () => {
    for (const name of TOOL_UID_ENVS)
      expect(() => checkToolUid({ [name]: "1" })).toThrow(/another uid/);
    expect(() => checkToolUid({ ...SPLIT, QCR_ALLOW_SHARED_TOOL_UID: "1" })).not.toThrow();
    expect(() => checkToolUid({})).not.toThrow();
  });
});

describe("where setpriv is looked for", () => {
  it("is a system dir by absolute path, never the PATH", () => {
    expect(trustedSetpriv((p) => p === "/usr/bin/setpriv")).toBe("/usr/bin/setpriv");
    expect(trustedSetpriv((p) => p === "/sbin/setpriv")).toBe("/sbin/setpriv");
    expect(trustedSetpriv(() => false)).toBeNull();
  });
});

describe("toolIsolation and the switches", () => {
  it("is setpriv to the tool uid with no capability and no way to gain one", () => {
    expect(setprivSwitches({ uid: "65534", gid: "1000" })).toEqual(SWITCHES);
    expect(toolIsolation("pi", ["-p"], SPLIT)).toEqual({
      bin: "setpriv",
      argv: [...SWITCHES, "--", "pi", "-p"],
      isolated: true,
    });
  });
});

// The bot reaches the tool uid through the image's setid helper
// (docker/Dockerfile), which QCR_SETPRIV_BIN names; a helper the run uid could
// swap is refused, never run.
describe("the bot's setid helper", () => {
  const st = (uid: number, mode: number, kind: "file" | "dir") => ({
    uid,
    mode,
    isFile: () => kind === "file",
    isDirectory: () => kind === "dir",
  });
  const fs =
    (file: ReturnType<typeof st> | undefined, dir: ReturnType<typeof st> | undefined) =>
    (p: string) =>
      p === "/usr/local/libexec/qcr/setpriv"
        ? file
        : p === "/usr/local/libexec/qcr"
          ? dir
          : undefined;
  const HELPER = { QCR_SETPRIV_BIN: "/usr/local/libexec/qcr/setpriv" };

  it("is trusted as a root-owned file in a root-owned dir, neither writable by group or others", () => {
    expect(setidHelperOf({}, fs(undefined, undefined))).toBeNull();
    expect(setidHelperOf(HELPER, fs(st(0, 0o100750, "file"), st(0, 0o40755, "dir")))).toEqual({
      path: "/usr/local/libexec/qcr/setpriv",
    });
    // MUTATION: drop the owner check in setidHelperOf — the first two pass
    for (const [file, dir] of [
      [st(1001, 0o100750, "file"), st(0, 0o40755, "dir")],
      [st(0, 0o100750, "file"), st(1001, 0o40755, "dir")],
      [st(0, 0o100770, "file"), st(0, 0o40755, "dir")],
      [st(0, 0o100750, "file"), st(0, 0o40757, "dir")],
      [st(0, 0o40750, "dir"), st(0, 0o40755, "dir")],
      [undefined, st(0, 0o40755, "dir")],
    ] as const)
      expect(setidHelperOf(HELPER, fs(file, dir))).toHaveProperty("refused");
    expect(setidHelperOf({ QCR_SETPRIV_BIN: "setpriv" })).toHaveProperty("refused");
  });

  it("is what a pane's pi and a worker's bash run through, and a bad one is a refusal", () => {
    // a real root-owned regular file in a root-owned dir stands in for the helper
    const env = { ...SPLIT, QCR_SETPRIV_BIN: "/usr/bin/env" };
    expect(toolIsolation("pi", ["-p"], env)).toEqual({
      bin: "/usr/bin/env",
      argv: [...SWITCHES, "--", "pi", "-p"],
      isolated: true,
    });
    expect(trustedSetpriv(() => true, env)).toBe("/usr/bin/env");
    const bad = { ...SPLIT, QCR_SETPRIV_BIN: tmpdir() };
    expect(toolIsolation("pi", [], bad)).toHaveProperty("refused");
    expect(trustedSetpriv(() => true, bad)).toBeNull();
  });
});

describe("what a tool-uid command runs with", () => {
  it("git's safe.directory in the command scope, after whatever the env already carries", () => {
    expect(toolUidEnv({ PATH: "/bin" })).toEqual({
      PATH: "/bin",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "safe.directory",
      GIT_CONFIG_VALUE_0: "*",
    });
    expect(
      toolUidEnv({ GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "a.b", GIT_CONFIG_VALUE_0: "c" }),
    ).toEqual({
      GIT_CONFIG_COUNT: "2",
      GIT_CONFIG_KEY_0: "a.b",
      GIT_CONFIG_VALUE_0: "c",
      GIT_CONFIG_KEY_1: "safe.directory",
      GIT_CONFIG_VALUE_1: "*",
    });
  });
});

describe("the SDK bash tool as the tool uid", () => {
  let dir: string;
  let bin: string;
  let log: string;
  let env: NodeJS.ProcessEnv;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tool-uid-"));
    bin = join(dir, "bin");
    log = join(dir, "setpriv.log");
    mkdirSync(bin);
    // The stand-in: records its argv, drops setpriv's switches, runs the rest here.
    writeFileSync(
      join(bin, "setpriv"),
      `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(log)}\nwhile [ "$1" != -- ]; do shift; done\nshift\nexec "$@"\n`,
    );
    chmodSync(join(bin, "setpriv"), 0o755);
    env = { PATH: `${bin}:${process.env["PATH"]}` };
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const ops = () => isolatedBashOperations({ uid: "65534", gid: "1000" }, join(bin, "setpriv"));
  const run = async (
    command: string,
    o: { signal?: AbortSignal; timeout?: number } = {},
  ): Promise<{ exitCode: number | null; out: string }> => {
    let out = "";
    const r = await ops().exec(command, dir, {
      onData: (d) => (out += d.toString()),
      env,
      ...o,
    });
    return { ...r, out };
  };

  it("runs the command through setpriv to the tool uid, in the cwd, with the env it was given", async () => {
    const r = await run('echo "hello $FOO"; pwd', {});
    expect(r.exitCode).toBe(0);
    expect(r.out).toContain(dir);
    const first = readFileSync(log, "utf8").split("\n")[0]!;
    expect(first).toBe(
      `${SWITCHES.join(" ")} -- /bin/bash -c umask 002 && exec "$0" -c "$1" /bin/bash echo "hello $FOO"; pwd`,
    );
  });

  it("runs it under the group-writable umask, with git's safe.directory in its env", async () => {
    // MUTATION: drop the umask from UMASK_THEN_RUN in tooluid.ts — this fails
    const r = await run("umask; touch f; stat -c %a f; git config --get safe.directory");
    expect(r.exitCode).toBe(0);
    expect(r.out.split("\n").slice(0, 3)).toEqual(["0002", "664", "*"]);
  });

  it("hands the command over as one argument, never through another shell's parsing", async () => {
    const evil = `echo 'a b'; echo "$(echo c)" \\; $HOME`;
    const r = await run(evil);
    expect(r.out.split("\n").slice(0, 2)).toEqual(["a b", "c ;"]);
  });

  it("returns the command's exit code, and its output from both streams", async () => {
    const r = await run("echo out; echo err >&2; exit 7");
    expect(r.exitCode).toBe(7);
    expect(r.out).toContain("out");
    expect(r.out).toContain("err");
  });

  it("ends a command that outlives its timeout, and says it timed out", async () => {
    const t0 = Date.now();
    await expect(run("sleep 30", { timeout: 0.3 })).rejects.toThrow("timeout:0.3");
    expect(Date.now() - t0).toBeLessThan(5000);
    // the group's end went through setpriv too, as the tool uid
    const calls = readFileSync(log, "utf8").trim().split("\n");
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(calls[1]).toContain("kill -KILL");
  });

  it("ends a command on abort, and says it was aborted", async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 200);
    const t0 = Date.now();
    await expect(run("sleep 30", { signal: ac.signal })).rejects.toThrow("aborted");
    expect(Date.now() - t0).toBeLessThan(5000);
    await expect(run("echo hi", { signal: ac.signal })).rejects.toThrow("aborted");
  });

  it("takes the descendants of the command down with it", async () => {
    const pidFile = join(dir, "child.pid");
    await expect(run(`sleep 30 & echo $! > ${pidFile}; wait`, { timeout: 0.4 })).rejects.toThrow(
      "timeout",
    );
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    await new Promise((r) => setTimeout(r, 300));
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it("never resolves setpriv through the PATH it was handed (a planted one is not run)", async () => {
    const planted = join(dir, "planted");
    mkdirSync(planted);
    const mark = join(dir, "planted.ran");
    writeFileSync(join(planted, "setpriv"), `#!/bin/sh\ntouch ${JSON.stringify(mark)}\nexit 3\n`);
    chmodSync(join(planted, "setpriv"), 0o755);
    // the stand-in is given by its absolute path; the model's PATH has the plant first
    const r = await isolatedBashOperations(
      { uid: "65534", gid: "1000" },
      join(bin, "setpriv"),
    ).exec("echo ok", dir, { onData: () => {}, env: { PATH: `${planted}:${bin}:/usr/bin:/bin` } });
    expect(r.exitCode).toBe(0);
    // and ending a group does not look through it either
    await expect(
      isolatedBashOperations({ uid: "65534", gid: "1000" }, join(bin, "setpriv")).exec(
        "sleep 30",
        dir,
        { onData: () => {}, env: { PATH: `${planted}:${bin}:/usr/bin:/bin` }, timeout: 0.3 },
      ),
    ).rejects.toThrow("timeout");
    expect(() => statSync(mark)).toThrow();
  });

  it("refuses a missing working directory and a bad timeout", async () => {
    await expect(ops().exec("true", join(dir, "nope"), { onData: () => {}, env })).rejects.toThrow(
      /Working directory does not exist/,
    );
    await expect(run("true", { timeout: -1 })).rejects.toThrow(/Invalid timeout/);
  });
});

describe("a session's bash under the host's tool uid", () => {
  let rig: HostRig;
  let bin: string;
  let log: string;
  let standIn: string;
  beforeEach(async () => {
    standIn = mkdtempSync(join(tmpdir(), "tool-uid-bin-"));
    rig = await createHostRig({
      toolUid: { uid: "65534", gid: "1000" },
      setprivBin: join(standIn, "setpriv"),
    });
    bin = standIn;
    log = join(rig.dir, "setpriv.log");
    writeFileSync(
      join(bin, "setpriv"),
      `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(log)}\nwhile [ "$1" != -- ]; do shift; done\nshift\nexec "$@"\n`,
    );
    chmodSync(join(bin, "setpriv"), 0o755);
  });
  afterEach(() => {
    rig.close();
    rmSync(standIn, { recursive: true, force: true });
  });

  async function bash(command: string, toolUid = true): Promise<string> {
    const other = toolUid ? undefined : await createHostRig();
    const { host, faux } = other ?? rig;
    const session = await host.makeSession({
      cwd: rig.dir,
      env: { PATH: `${bin}:${process.env["PATH"]}`, HOME: rig.dir },
      model: faux.getModel(),
      tools: ["bash"],
    });
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("bash", { command })], { stopReason: "toolUse" }),
      fauxAssistantMessage("done"),
    ]);
    await session.prompt("go");
    const result = session.messages.find((m) => m.role === "toolResult") as unknown as {
      content: { text: string }[];
    };
    other?.close();
    return result.content.map((c) => c.text).join("\n");
  }

  it("goes through setpriv, with the environment the allowlist built and no token", async () => {
    process.env["GITHUB_TOKEN"] = "ghs_in_the_process";
    try {
      const out = await bash("env");
      expect(out).not.toContain("ghs_in_the_process");
      expect(out).toContain(`HOME=${rig.dir}`);
    } finally {
      delete process.env["GITHUB_TOKEN"];
    }
    expect(readFileSync(log, "utf8")).toContain(
      `${SWITCHES.join(" ")} -- /bin/bash -c umask 002 && exec "$0" -c "$1" /bin/bash env`,
    );
  });

  it("a host with no tool uid runs the command itself", async () => {
    await bash("true", false);
    expect(() => readFileSync(log)).toThrow();
  });
});

describe("the shared uid is an explicit opt-out only", () => {
  it("no script, workflow, compose file or deploy file sets QCR_ALLOW_SHARED_TOOL_UID", () => {
    const root = join(import.meta.dirname, "..");
    const files = execFileSync(
      "git",
      ["ls-files", "scripts", ".github", "docker", "deploy", "action.yml", "docker-compose.yml"],
      { cwd: root, encoding: "utf8" },
    )
      .split("\n")
      .filter(Boolean);
    expect(files.length).toBeGreaterThan(10);
    const setters = files.filter((f) =>
      readFileSync(join(root, f), "utf8")
        .split("\n")
        .some((l) => !/^\s*(#|\/\/)/.test(l) && /QCR_ALLOW_SHARED_TOOL_UID\s*[=:]/.test(l)),
    );
    expect(setters).toEqual([]);
  });
});

describe("shareWithToolGroup", () => {
  it("opens a private tree to the run gid, keeps the owner's bits, and leaves links and absences alone", () => {
    const dir = mkdtempSync(join(tmpdir(), "share-"));
    try {
      mkdirSync(join(dir, "agent", "agents"), { recursive: true, mode: 0o700 });
      writeFileSync(join(dir, "agent", "auth.json"), "{}", { mode: 0o600 });
      writeFileSync(join(dir, "agent", "agents", "a.md"), "x", { mode: 0o600 });
      symlinkSync("/etc/passwd", join(dir, "agent", "link"));
      shareWithToolGroup(join(dir, "agent"));
      const mode = (p: string): number => statSync(join(dir, p)).mode & 0o777;
      expect(mode("agent")).toBe(0o770);
      expect(mode("agent/agents")).toBe(0o770);
      expect(mode("agent/auth.json")).toBe(0o660);
      expect(mode("agent/agents/a.md")).toBe(0o660);
      // the link's target was not touched
      expect(statSync("/etc/passwd").mode & 0o777).not.toBe(0o660);
      expect(() => shareWithToolGroup(join(dir, "nowhere"))).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
