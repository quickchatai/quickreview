// The in-process file tools' fence (packages/pi-plugin/src/engine/toolfence.ts), on real
// symlinks, and through a real SDK session over pi-ai's faux provider: the model
// cannot read, search, list, edit or write /proc, /run/qcr-in or the run's agent
// dir, not even through a link its own bash planted in the worktree.
import { spawnSync } from "node:child_process";
import {
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { loadImageSniffer } from "@quickchatai/pi-quickreview/src/engine/pisdk.js";
import {
  ToolFenceError,
  createToolFence,
  credentialPaths,
  loginSourceDirs,
  toolPath,
} from "@quickchatai/pi-quickreview/src/engine/toolfence.js";
import { type HostRig, createHostRig, useOfflineGuard } from "./pi-canary/harness.js";

useOfflineGuard();

describe("the fence on paths", () => {
  let dir: string;
  let agent: string;
  let work: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "fence-"));
    agent = join(dir, "agent");
    work = join(dir, "work");
    mkdirSync(agent);
    mkdirSync(work);
    writeFileSync(join(agent, "auth.json"), "{}");
    writeFileSync(join(work, "a.txt"), "a");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const refused = (fence: ReturnType<typeof createToolFence>, p: string): boolean => {
    try {
      fence.check(p);
      return false;
    } catch (e) {
      expect(e).toBeInstanceOf(ToolFenceError);
      return true;
    }
  };

  it("checkTree refuses a root with a fenced path below it, and clears one without", () => {
    const fence = createToolFence({ dirs: [agent] });
    expect(() => fence.checkTree(dir)).toThrow(ToolFenceError);
    expect(() => fence.checkTree("/")).toThrow(ToolFenceError);
    expect(() => fence.checkTree(agent)).toThrow(ToolFenceError);
    expect(() => fence.checkTree(work)).not.toThrow();
  });

  it("refuses /proc, /run/qcr-in and the agent dir, as given", () => {
    const fence = createToolFence({ dirs: [agent] });
    for (const p of [
      "/proc/self/environ",
      `/proc/${process.pid}/mem`,
      "/proc",
      "/proc/self/fd/0",
      "/dev/fd/0",
      "/run/qcr-in",
      "/run/qcr-in/gh-token",
      "/run/qcr-in/not-yet-there",
      agent,
      join(agent, "auth.json"),
      join(agent, "sub", "new-file"),
    ])
      expect(refused(fence, p), p).toBe(true);
  });

  it("lets the worktree through, files that exist and files that do not", () => {
    const fence = createToolFence({ dirs: [agent] });
    for (const p of [work, join(work, "a.txt"), join(work, "new", "deeper", "b.txt"), dir])
      expect(refused(fence, p), p).toBe(false);
    // a name that merely starts like a fenced one
    expect(refused(fence, "/process-notes/x")).toBe(false);
    expect(refused(fence, `${agent}-copy/x`)).toBe(false);
  });

  it("follows a symlink the model's bash planted: file, directory, relative, chained, dangling", () => {
    const fence = createToolFence({ dirs: [agent] });
    symlinkSync("/proc/self/environ", join(work, "env"));
    symlinkSync(join(agent, "auth.json"), join(work, "auth"));
    symlinkSync(agent, join(work, "agentdir"));
    symlinkSync("../agent/auth.json", join(work, "rel"));
    symlinkSync("env", join(work, "chain"));
    symlinkSync("/run/qcr-in/gh-token", join(work, "dangling"));
    symlinkSync("/run/qcr-in", join(work, "intodir"));
    symlinkSync("/proc/self", join(work, "self"));
    for (const p of [
      "env",
      "auth",
      "agentdir",
      "agentdir/auth.json",
      "rel",
      "chain",
      "dangling",
      "intodir",
      "intodir/new",
      "self/environ",
      "self/fd/0",
    ])
      expect(refused(fence, join(work, p)), p).toBe(true);
  });

  it("a symlink to somewhere harmless is no problem, and a loop is refused", () => {
    const fence = createToolFence({ dirs: [agent] });
    symlinkSync(join(work, "a.txt"), join(work, "ok"));
    symlinkSync("loop2", join(work, "loop1"));
    symlinkSync("loop1", join(work, "loop2"));
    expect(refused(fence, join(work, "ok"))).toBe(false);
    expect(refused(fence, join(work, "loop1"))).toBe(true);
  });

  it("follows the agent dir when it is itself reached through a link", () => {
    const via = join(dir, "via");
    symlinkSync(agent, via);
    // the fence was told the link; the real dir is fenced too
    const fence = createToolFence({ dirs: [via] });
    expect(refused(fence, join(agent, "auth.json"))).toBe(true);
    expect(refused(fence, join(via, "auth.json"))).toBe(true);
  });

  it("a descriptor of a fenced file is refused whatever path opened it", async () => {
    const { openSync, closeSync } = await import("node:fs");
    const fence = createToolFence({ dirs: [agent] });
    const fd = openSync(join(agent, "auth.json"), "r");
    try {
      expect(() => fence.checkOpened(fd, "x")).toThrow(ToolFenceError);
    } finally {
      closeSync(fd);
    }
    const ok = openSync(join(work, "a.txt"), "r");
    try {
      expect(() => fence.checkOpened(ok, "x")).not.toThrow();
    } finally {
      closeSync(ok);
    }
  });

  it("reads a tool's path argument the way pi does", () => {
    expect(toolPath("a.txt", "/w")).toBe("/w/a.txt");
    expect(toolPath("@a.txt", "/w")).toBe("/w/a.txt");
    expect(toolPath("/abs/x", "/w")).toBe("/abs/x");
    expect(toolPath("../x", "/w/y")).toBe("/w/x");
    expect(toolPath("file:///proc/self/environ", "/w")).toBe("/proc/self/environ");
    expect(toolPath(`a${String.fromCharCode(0xa0)}b`, "/w")).toBe("/w/a b");
  });
});

describe("the login's source", () => {
  let dir: string;
  let login: string;
  let work: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "fence-login-"));
    login = join(dir, "qcr-login");
    work = join(dir, "work");
    mkdirSync(login);
    mkdirSync(work);
    writeFileSync(join(login, "auth.json"), '{"refresh":"long-lived"}');
    symlinkSync(join(login, "auth.json"), join(work, "to-login-auth"));
    symlinkSync(login, join(work, "to-login"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("names the process's pi agent dir and the scan's source, when absolute", () => {
    expect(loginSourceDirs({ PI_CODING_AGENT_DIR: "/qcr-login" })).toEqual(["/qcr-login"]);
    expect(
      loginSourceDirs({ PI_CODING_AGENT_DIR: " /a ", QCR_SCAN_AUTH_SRC: "/b", HOME: "/h" }),
    ).toEqual(["/a", "/b"]);
    expect(loginSourceDirs({ PI_CODING_AGENT_DIR: "relative", QCR_SCAN_AUTH_SRC: "" })).toEqual([]);
    expect(loginSourceDirs({})).toEqual([]);
  });

  const refuses = (fence: ReturnType<typeof createToolFence>, p: string): boolean => {
    try {
      fence.check(p);
      return false;
    } catch (e) {
      return e instanceof ToolFenceError;
    }
  };

  it("refuses /qcr-login without being told, and any dir the env names, with its links", () => {
    expect(refuses(createToolFence(), "/qcr-login/auth.json")).toBe(true);
    expect(refuses(createToolFence(), "/qcr-login")).toBe(true);
    const fence = createToolFence({ dirs: loginSourceDirs({ PI_CODING_AGENT_DIR: login }) });
    for (const p of [
      login,
      join(login, "auth.json"),
      join(work, "to-login-auth"),
      join(work, "to-login", "auth.json"),
    ])
      expect(refuses(fence, p), p).toBe(true);
    expect(refuses(fence, join(work, "x.txt"))).toBe(false);
  });
});

describe("the file tools of a real session", () => {
  let rig: HostRig;
  let work: string;
  beforeEach(async () => {
    rig = await createHostRig();
    work = join(rig.dir, "work");
    mkdirSync(work);
    writeFileSync(join(rig.host.agentDir, "auth.json"), '{"secret":"token-in-the-login"}');
    writeFileSync(join(work, "a.txt"), "hello from the worktree\n");
    // what a bash running as the tool uid could plant
    symlinkSync("/proc/self/environ", join(work, "to-environ"));
    symlinkSync(rig.host.agentDir, join(work, "to-agent"));
    symlinkSync("/run/qcr-in", join(work, "to-mount"));
    symlinkSync(join(rig.host.agentDir, "auth.json"), join(work, "to-auth"));
  });
  afterEach(() => rig.close());

  /** One tool call, as the model would make it; the result's text. */
  async function call(
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ isError: boolean; text: string }> {
    const session = await rig.host.makeSession({
      cwd: work,
      env: { PATH: process.env["PATH"], HOME: join(rig.dir, "home") },
      model: rig.faux.getModel(),
      tools: ["read", "bash", "edit", "write", "grep", "find", "ls"],
    });
    rig.faux.setResponses([
      fauxAssistantMessage([fauxToolCall(name, args as Parameters<typeof fauxToolCall>[1])], {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("done"),
    ]);
    await session.prompt("go");
    const result = session.messages.find((m) => m.role === "toolResult") as unknown as {
      isError: boolean;
      content: { text: string }[];
    };
    return { isError: result.isError, text: result.content.map((c) => c.text).join("\n") };
  }

  it("works on the worktree: read, grep, find, ls, edit, write", async () => {
    expect(await call("read", { path: "a.txt" })).toMatchObject({
      isError: false,
      text: expect.stringContaining("hello from the worktree"),
    });
    // rg and fd are the image's; a machine without one has nothing to grep or
    // find with (pi would try to download it)
    if (spawnSync("rg", ["--version"]).status === 0)
      expect(await call("grep", { pattern: "hello", path: "." })).toMatchObject({
        isError: false,
        text: expect.stringContaining("a.txt"),
      });
    if (spawnSync("fd", ["--version"]).status === 0)
      expect(await call("find", { pattern: "*.txt" })).toMatchObject({
        isError: false,
        text: expect.stringContaining("a.txt"),
      });
    expect(await call("ls", { path: "." })).toMatchObject({
      isError: false,
      text: expect.stringContaining("a.txt"),
    });
    expect(
      (await call("edit", { path: "a.txt", edits: [{ oldText: "hello", newText: "bye" }] }))
        .isError,
    ).toBe(false);
    expect(readFileSync(join(work, "a.txt"), "utf8")).toBe("bye from the worktree\n");
    expect((await call("write", { path: "sub/new.txt", content: "fresh" })).isError).toBe(false);
    expect(readFileSync(join(work, "sub", "new.txt"), "utf8")).toBe("fresh");
  });

  it("read refuses /proc/self/environ and /run/qcr-in, as given and through planted links", async () => {
    for (const path of [
      "/proc/self/environ",
      `/proc/${process.pid}/environ`,
      "/run/qcr-in/gh-token",
      "to-environ",
      "to-mount/gh-token",
      "to-auth",
      "to-agent/auth.json",
      join(rig.host.agentDir, "auth.json"),
    ]) {
      const r = await call("read", { path });
      expect(r.isError, path).toBe(true);
      expect(r.text, path).toContain("access refused");
      expect(r.text, path).not.toContain("token-in-the-login");
    }
  });

  it("grep, find, ls, edit and write refuse the same targets", async () => {
    const targets = ["to-environ", "to-agent", "to-mount", "to-auth", "/proc", "/run/qcr-in"];
    for (const path of targets) {
      for (const [tool, args] of [
        ["grep", { pattern: "secret", path }],
        ["find", { pattern: "*", path }],
        ["ls", { path }],
        ["edit", { path, edits: [{ oldText: "a", newText: "b" }] }],
        ["write", { path, content: "x" }],
        ["write", { path: `${path}/new.txt`, content: "x" }],
      ] as const) {
        const r = await call(tool, args as Record<string, unknown>);
        expect(r.isError, `${tool} ${path}`).toBe(true);
        expect(r.text, `${tool} ${path}`).toContain("access refused");
      }
    }
    // nothing was written through the links
    expect(readFileSync(join(rig.host.agentDir, "auth.json"), "utf8")).toBe(
      '{"secret":"token-in-the-login"}',
    );
  });

  it("grep and find refuse a search root that holds a fenced directory below it", async () => {
    // rig.dir is the parent of both the worktree and the agent dir
    for (const tool of ["grep", "find"] as const) {
      const r = await call(tool, { pattern: tool === "grep" ? "secret" : "*", path: rig.dir });
      expect(r.isError, tool).toBe(true);
      expect(r.text, tool).toContain("access refused");
    }
  });

  it("a write through a dangling planted link does not create the file it points at", async () => {
    const outside = join(rig.dir, "agent", "created-by-write");
    symlinkSync(outside, join(work, "dangling"));
    const r = await call("write", { path: "dangling", content: "x" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("access refused");
    expect(() => readFileSync(outside)).toThrow();
  });

  it("the fence can be turned off for a host that has nothing to protect", async () => {
    const open = await createHostRig({ fence: false });
    try {
      mkdirSync(join(open.dir, "w"));
      writeFileSync(join(open.dir, "agent", "x.txt"), "visible");
      const session = await open.host.makeSession({
        cwd: join(open.dir, "w"),
        env: {},
        model: open.faux.getModel(),
        tools: ["read"],
      });
      open.faux.setResponses([
        fauxAssistantMessage([fauxToolCall("read", { path: join(open.dir, "agent", "x.txt") })], {
          stopReason: "toolUse",
        }),
        fauxAssistantMessage("done"),
      ]);
      await session.prompt("go");
      const result = session.messages.find((m) => m.role === "toolResult") as unknown as {
        isError: boolean;
        content: { text: string }[];
      };
      expect(result.isError).toBe(false);
      expect(result.content[0]!.text).toContain("visible");
    } finally {
      open.close();
    }
  });

  it("builds only the file tools of the allowlist", async () => {
    const session = await rig.host.makeSession({
      cwd: work,
      env: {},
      model: rig.faux.getModel(),
      tools: ["read"],
    });
    expect(session.getAllTools().map((t) => t.name)).toEqual(["read"]);
  });
});

describe("the file tools and the login source, through a real session", () => {
  let rig: HostRig;
  let work: string;
  let login: string;
  const MARK = "long-lived-refresh-token";
  beforeEach(async () => {
    rig = await createHostRig({ fenceDirs: [] });
    work = join(rig.dir, "work");
    login = join(rig.dir, "login-src");
    mkdirSync(work);
    mkdirSync(login);
    writeFileSync(join(login, "auth.json"), `{"refresh":"${MARK}"}`);
    symlinkSync(login, join(work, "to-login"));
    symlinkSync(join(login, "auth.json"), join(work, "to-login-auth"));
  });
  afterEach(() => rig.close());

  /** A host whose fence is told the login source the way reviewsdk tells it. */
  async function fenced(): Promise<HostRig> {
    const r = await createHostRig({ fenceDirs: [login] });
    return r;
  }

  async function call(
    r: HostRig,
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ isError: boolean; text: string }> {
    const session = await r.host.makeSession({
      cwd: work,
      env: { PATH: process.env["PATH"], HOME: join(r.dir, "home") },
      model: r.faux.getModel(),
      tools: ["read", "edit", "write", "grep", "find", "ls"],
    });
    r.faux.setResponses([
      fauxAssistantMessage([fauxToolCall(name, args as Parameters<typeof fauxToolCall>[1])], {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("done"),
    ]);
    await session.prompt("go");
    const result = session.messages.find((m) => m.role === "toolResult") as unknown as {
      isError: boolean;
      content: { text: string }[];
    };
    return { isError: result.isError, text: result.content.map((c) => c.text).join("\n") };
  }

  it("a host not told of the source can read it (why the caller passes fenceDirs)", async () => {
    const r = await call(rig, "read", { path: join(login, "auth.json") });
    expect(r.text).toContain(MARK);
  });

  it("read, grep, find, ls, edit and write refuse the source and links to it", async () => {
    const f = await fenced();
    try {
      for (const path of [login, join(login, "auth.json"), "to-login", "to-login-auth"]) {
        for (const [tool, args] of [
          ["read", { path }],
          ["grep", { pattern: "refresh", path }],
          ["find", { pattern: "*", path }],
          ["ls", { path }],
          ["edit", { path, edits: [{ oldText: "refresh", newText: "x" }] }],
          ["write", { path, content: "x" }],
          ["write", { path: `${path}/new.json`, content: "x" }],
        ] as const) {
          const r = await call(f, tool, args as Record<string, unknown>);
          expect(r.isError, `${tool} ${path}`).toBe(true);
          expect(r.text, `${tool} ${path}`).toContain("access refused");
          expect(r.text, `${tool} ${path}`).not.toContain(MARK);
        }
      }
      expect(readFileSync(join(login, "auth.json"), "utf8")).toBe(`{"refresh":"${MARK}"}`);
    } finally {
      f.close();
    }
  });

  it("takes the source from the process env, as a host made without fenceDirs", async () => {
    const before = process.env["PI_CODING_AGENT_DIR"];
    process.env["PI_CODING_AGENT_DIR"] = login;
    let f: HostRig | undefined;
    try {
      f = await createHostRig();
      const r = await call(f, "read", { path: join(login, "auth.json") });
      expect(r.isError).toBe(true);
      expect(r.text).toContain("access refused");
    } finally {
      f?.close();
      if (before === undefined) delete process.env["PI_CODING_AGENT_DIR"];
      else process.env["PI_CODING_AGENT_DIR"] = before;
    }
  });
});

// The credentials: the bot's model ran its file tools as the uid that
// owns /opt/quickreview/secrets, so a PR could commit a symlink to app.pem and the
// read tool would follow it. The fence names every secrets dir the install
// could use, the IPC run dir and the sessions' ovcli.conf.
describe("the credentials the env points at", () => {
  let dir: string;
  let secrets: string;
  let work: string;
  let ovcli: string;
  let run: string;
  const PEM = "-----BEGIN RSA PRIVATE KEY----- app-key-material";
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "fence-creds-"));
    secrets = join(dir, "secrets");
    work = join(dir, "wt", "pr-1");
    run = join(dir, "state", "run");
    ovcli = join(dir, "pihome", ".openviking", "ovcli.conf");
    for (const d of [secrets, work, run, join(dir, "pihome", ".openviking")])
      mkdirSync(d, { recursive: true });
    writeFileSync(join(secrets, "app.pem"), PEM);
    writeFileSync(join(secrets, "openviking_reviewer_key"), "reviewer-key");
    writeFileSync(join(secrets, "webhook_secret"), "hook");
    writeFileSync(ovcli, '{"api_key":"reviewer-key"}');
    writeFileSync(join(work, "a.txt"), "ok");
    // what a PR can commit: links into the secrets, the key file, the socket dir
    symlinkSync(join(secrets, "app.pem"), join(work, "innocent.md"));
    symlinkSync("../../secrets", join(work, "docs"));
    symlinkSync(ovcli, join(work, "ov.json"));
    symlinkSync(run, join(work, "run"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const env = (): NodeJS.ProcessEnv => ({
    HOME: join(dir, "home"),
    QCR_SECRETS_MOUNT: secrets,
    QCR_IPC_SOCKET: join(run, "qcr.sock"),
    OPENVIKING_CLI_CONFIG_FILE: ovcli,
  });

  it("names the secrets mount, the container mount, the config home's, the run dir and ovcli.conf", () => {
    const paths = credentialPaths(env());
    for (const p of [
      secrets,
      "/opt/quickreview/secrets",
      join(dir, "home", ".config", "qcr", "default", "secrets"),
      join(dir, "home", ".config", "quickreview-bot"),
      run,
      ovcli,
    ])
      expect(paths, p).toContain(p);
    // a relative ovcli path is no path; nothing is duplicated across envs
    expect(credentialPaths({ OPENVIKING_CLI_CONFIG_FILE: "rel/ovcli.conf" })).not.toContain(
      "rel/ovcli.conf",
    );
    const twice = credentialPaths(env(), env());
    expect(new Set(twice).size).toBe(twice.length);
  });

  it("refuses the files and every link a worktree can carry to them", () => {
    const fence = createToolFence({ dirs: credentialPaths(env()) });
    const refused = (p: string): boolean => {
      try {
        fence.check(p);
        return false;
      } catch (e) {
        return e instanceof ToolFenceError;
      }
    };
    for (const p of [
      join(secrets, "app.pem"),
      join(secrets, "webhook_secret"),
      join(secrets, "openviking_reviewer_key"),
      secrets,
      ovcli,
      join(run, "qcr.sock"),
      join(work, "innocent.md"),
      join(work, "docs", "app.pem"),
      join(work, "docs"),
      join(work, "ov.json"),
      join(work, "run", "caps"),
    ])
      expect(refused(p), p).toBe(true);
    expect(refused(join(work, "a.txt"))).toBe(false);
  });

  it("a real session's read tool gets a refusal for the committed link, never the key", async () => {
    // MUTATION: drop `...credentialPaths(process.env)` from PiHost's default
    // fence and the env-only case below reads the key.
    const before = process.env["QCR_SECRETS_MOUNT"];
    process.env["QCR_SECRETS_MOUNT"] = secrets;
    const rigs: HostRig[] = [];
    try {
      // the process env alone (a host built without fenceDirs), and a worker's
      // session env handed as fenceDirs
      rigs.push(await createHostRig());
      delete process.env["QCR_SECRETS_MOUNT"];
      rigs.push(await createHostRig({ fenceDirs: credentialPaths({}, env()) }));
      for (const [i, r] of rigs.entries()) {
        // the process env names no ovcli.conf; the session env does
        const paths = ["innocent.md", "docs/app.pem", join(secrets, "app.pem")];
        for (const path of i === 1 ? [...paths, "ov.json"] : paths) {
          const session = await r.host.makeSession({
            cwd: work,
            env: { PATH: process.env["PATH"] },
            model: r.faux.getModel(),
            tools: ["read"],
          });
          r.faux.setResponses([
            fauxAssistantMessage([fauxToolCall("read", { path })], { stopReason: "toolUse" }),
            fauxAssistantMessage("done"),
          ]);
          await session.prompt("go");
          const result = session.messages.find((m) => m.role === "toolResult") as unknown as {
            isError: boolean;
            content: { text: string }[];
          };
          const text = result.content.map((c) => c.text).join("\n");
          expect(result.isError, path).toBe(true);
          expect(text, path).toContain("access refused");
          expect(text, path).not.toContain("app-key-material");
          expect(text, path).not.toContain("reviewer-key");
        }
      }
    } finally {
      for (const r of rigs) r.close();
      if (before === undefined) delete process.env["QCR_SECRETS_MOUNT"];
      else process.env["QCR_SECRETS_MOUNT"] = before;
    }
  });
});

describe("a write a symlink carries onto the protected surface", () => {
  // The in-process write tools run as the daemon's uid, the one that runs git in
  // the base clone and reads the policy surface. A link committed in a PR, or one
  // the tool uid planted in a directory it shares, must not carry a write onto
  // git's config or hooks, or the system's own scripts: that would be code
  // execution as the daemon's uid.
  let rig: HostRig;
  let work: string;
  let clone: string;
  let scripts: string;
  beforeEach(async () => {
    rig = await createHostRig();
    work = join(rig.dir, "work");
    clone = join(rig.dir, "base-clone");
    scripts = join(rig.dir, "app", "scripts");
    mkdirSync(work);
    mkdirSync(join(clone, ".git", "hooks"), { recursive: true });
    mkdirSync(scripts, { recursive: true });
    writeFileSync(join(clone, ".git", "config"), "[core]\n\tbare = false\n");
    writeFileSync(join(scripts, "post-review.sh"), "#!/bin/sh\nexit 0\n");
    writeFileSync(join(rig.dir, "plain.txt"), "plain\n");
    symlinkSync(join(clone, ".git", "config"), join(work, "to-git-config"));
    symlinkSync(join(clone, ".git", "hooks"), join(work, "to-hooks"));
    symlinkSync(join(scripts, "post-review.sh"), join(work, "to-script"));
    symlinkSync(join(rig.dir, "plain.txt"), join(work, "to-plain"));
  });
  afterEach(() => rig.close());

  async function call(name: string, args: Record<string, unknown>): Promise<boolean> {
    const session = await rig.host.makeSession({
      cwd: work,
      env: { PATH: process.env["PATH"], HOME: join(rig.dir, "home") },
      model: rig.faux.getModel(),
      tools: ["read", "edit", "write"],
    });
    rig.faux.setResponses([
      fauxAssistantMessage([fauxToolCall(name, args as Parameters<typeof fauxToolCall>[1])], {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("done"),
    ]);
    await session.prompt("go");
    const result = session.messages.find((m) => m.role === "toolResult") as unknown as {
      isError: boolean;
    };
    return result.isError;
  }

  it("refuses write and edit through a link into .git/ or onto the policy surface, and leaves the files as they were", async () => {
    expect(
      await call("write", { path: "to-git-config", content: "[core]\n\tfsmonitor = sh -c x\n" }),
    ).toBe(true);
    expect(
      await call("write", { path: "to-hooks/post-checkout", content: "#!/bin/sh\nid\n" }),
    ).toBe(true);
    expect(
      await call("edit", { path: "to-script", edits: [{ oldText: "exit 0", newText: "id" }] }),
    ).toBe(true);
    expect(readFileSync(join(clone, ".git", "config"), "utf-8")).toBe("[core]\n\tbare = false\n");
    expect(readFileSync(join(scripts, "post-review.sh"), "utf-8")).toBe("#!/bin/sh\nexit 0\n");
    expect(spawnSync("ls", [join(clone, ".git", "hooks")]).stdout.toString()).toBe("");
  });

  it("still writes through a link that lands nowhere protected", async () => {
    expect(await call("write", { path: "to-plain", content: "changed\n" })).toBe(false);
    expect(readFileSync(join(rig.dir, "plain.txt"), "utf-8")).toBe("changed\n");
  });

  it("refuses the descriptor when a link is swapped in after the path check", () => {
    const fence = createToolFence({ protectedWrite: (p) => p.includes("/.git/") });
    const target = join(work, "late");
    writeFileSync(target, "x");
    expect(() => fence.checkWrite(target)).not.toThrow();
    rmSync(target);
    symlinkSync(join(clone, ".git", "config"), target);
    const fd = openSync(target, "r");
    try {
      expect(() => fence.checkWriteOpened(fd, target)).toThrow(ToolFenceError);
    } finally {
      closeSync(fd);
    }
  });
});

describe("pi's image sniffer", () => {
  it("is where the fenced read tool looks for it", async () => {
    const sniff = await loadImageSniffer();
    expect(sniff).not.toBeNull();
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
      "base64",
    );
    expect(sniff!(png)).toBe("image/png");
    expect(sniff!(Buffer.from("plain text"))).toBeNull();
  });
});
