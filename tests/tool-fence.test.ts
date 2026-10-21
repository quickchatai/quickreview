// [P7.12a] The in-process file tools' fence (src/engine/toolfence.ts), on real
// symlinks, and through a real SDK session over pi-ai's faux provider: the model
// cannot read, search, list, edit or write /proc, /run/qcr-in or the run's agent
// dir, not even through a link its own bash planted in the worktree.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { loadImageSniffer } from "../src/engine/pisdk.js";
import {
  ToolFenceError,
  createToolFence,
  loginSourceDirs,
  toolPath,
} from "../src/engine/toolfence.js";
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
