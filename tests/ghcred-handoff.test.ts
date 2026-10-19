// The GitHub token handoff without env [P6.5b, D39]. The caller writes the
// token to a 0600 file in a fresh 0700 dir; src/ghcred.ts reads it once at
// startup, unlinks it and keeps it in Node memory only. Pinned here:
//   - the read: once, unlinked before the content is in memory, the variable
//     gone from env, a refusal (not a fallback) when the file cannot go;
//   - the caller's half: a 0600 file in a 0700 dir, under $XDG_RUNTIME_DIR on
//     Linux and $TMPDIR elsewhere;
//   - the model's bash in a real pi session (pi-ai's faux provider, no model):
//     with bash-guard OFF the lower layers hold (the token is in no env, no
//     file; the mount dir is empty; /proc/<ppid>/mem fails wherever Yama's
//     ptrace_scope is >= 1), with bash-guard ON the same commands are denied
//     whatever the kernel says.
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import {
  HANDOFF_FILE_ENV,
  HANDOFF_MOUNT,
  dropHandedToken,
  handedToken,
  resolveGithubCredential,
  stageHandoffToken,
  takeHandoffToken,
} from "../src/ghcred.js";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import bashGuard from "../extensions/bash-guard.js";
import { type HostRig, createHostRig, useOfflineGuard } from "./pi-canary/harness.js";

useOfflineGuard();

const TOKEN = "ghs_HANDOFF_SECRET_0123456789";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "qcr-handoff-"));
  dropHandedToken();
});
afterEach(() => {
  dropHandedToken();
  // a test may have made the dir unwritable
  try {
    chmodSync(join(dir, "in"), 0o700);
  } catch {
    /* never made */
  }
  rmSync(dir, { recursive: true, force: true });
});

/** A 0700 dir holding a 0600 token file, as the caller leaves it. */
function stageIn(text = TOKEN): { indir: string; file: string } {
  const indir = join(dir, "in");
  mkdirSync(indir, { mode: 0o700 });
  const file = join(indir, "gh-token");
  writeFileSync(file, text, { mode: 0o600 });
  return { indir, file };
}

describe("takeHandoffToken", () => {
  it("reads the token once, unlinks the file and drops the variable", () => {
    const { indir, file } = stageIn(`${TOKEN}\n`);
    const env: Record<string, string | undefined> = { [HANDOFF_FILE_ENV]: file, KEEP: "1" };
    expect(takeHandoffToken(env)).toBe(TOKEN);
    expect(existsSync(file)).toBe(false);
    expect(readdirSync(indir)).toEqual([]);
    expect(env).toEqual({ KEEP: "1" });
    expect(handedToken()).toBe(TOKEN);
  });

  it("reads process.env by default, and leaves no variable for a child to inherit", () => {
    const { file } = stageIn();
    process.env[HANDOFF_FILE_ENV] = file;
    try {
      expect(takeHandoffToken()).toBe(TOKEN);
      expect(process.env[HANDOFF_FILE_ENV]).toBeUndefined();
      const child = spawnSync("sh", ["-c", `printf %s "\${${HANDOFF_FILE_ENV}-unset}"`], {
        env: process.env,
        encoding: "utf8",
      });
      expect(child.stdout).toBe("unset");
    } finally {
      delete process.env[HANDOFF_FILE_ENV];
    }
  });

  it("names no file: nothing happens", () => {
    expect(takeHandoffToken({})).toBeNull();
    expect(takeHandoffToken({ [HANDOFF_FILE_ENV]: "" })).toBeNull();
    expect(handedToken()).toBeNull();
  });

  it("a second call has nothing left to read, and keeps the token it already holds", () => {
    const { file } = stageIn();
    takeHandoffToken({ [HANDOFF_FILE_ENV]: file });
    expect(takeHandoffToken({})).toBe(TOKEN);
  });

  it("a missing file is an error, never a fallback", () => {
    expect(() => takeHandoffToken({ [HANDOFF_FILE_ENV]: join(dir, "nope") })).toThrow(/ENOENT/);
    expect(handedToken()).toBeNull();
  });

  it("an empty file is refused, and is still removed", () => {
    const { file } = stageIn("  \n");
    expect(() => takeHandoffToken({ [HANDOFF_FILE_ENV]: file })).toThrow(/empty/);
    expect(existsSync(file)).toBe(false);
    expect(handedToken()).toBeNull();
  });

  it.skipIf(process.getuid?.() === 0)(
    "a file that cannot be unlinked is refused: the token is never used while it stays on disk",
    () => {
      const { indir, file } = stageIn();
      chmodSync(indir, 0o500);
      expect(() => takeHandoffToken({ [HANDOFF_FILE_ENV]: file })).toThrow();
      expect(handedToken()).toBeNull();
      chmodSync(indir, 0o700);
      expect(readFileSync(file, "utf8")).toBe(TOKEN);
    },
  );
});

describe("the credential chain", () => {
  const base = {
    secretsDir: "",
    env: { GITHUB_TOKEN: "env-token" },
    mintApp: async () => "app-token",
    ghAuthToken: () => "gh-token",
  };

  it("the handed token comes after the App and before env and gh", async () => {
    expect(await resolveGithubCredential({ ...base, handoff: TOKEN })).toEqual({
      ok: true,
      source: "handoff",
      token: TOKEN,
    });
    expect(await resolveGithubCredential({ ...base, handoff: null })).toMatchObject({
      source: "env:GITHUB_TOKEN",
    });
    expect(await resolveGithubCredential({ ...base, handoff: "  " })).toMatchObject({
      source: "env:GITHUB_TOKEN",
    });
  });
});

describe("stageHandoffToken (the caller's half)", () => {
  it("a 0600 file in a fresh 0700 dir under $XDG_RUNTIME_DIR on Linux", () => {
    const runtime = join(dir, "run");
    mkdirSync(runtime);
    const staged = stageHandoffToken(TOKEN, { XDG_RUNTIME_DIR: runtime }, "linux");
    expect(staged.dir.startsWith(`${runtime}/`)).toBe(true);
    expect(statSync(staged.dir).mode & 0o777).toBe(0o700);
    expect(statSync(join(staged.dir, "gh-token")).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(staged.dir, "gh-token"), "utf8")).toBe(TOKEN);
    expect(staged.containerFile).toBe(`${HANDOFF_MOUNT}/gh-token`);
    // two runs never share a dir
    const other = stageHandoffToken(TOKEN, { XDG_RUNTIME_DIR: runtime }, "linux");
    expect(other.dir).not.toBe(staged.dir);
    staged.remove();
    other.remove();
    expect(existsSync(staged.dir)).toBe(false);
  });

  it("elsewhere (macOS) it is a mkdtemp dir under $TMPDIR, whatever XDG_RUNTIME_DIR says", () => {
    const tmp = process.env["TMPDIR"];
    process.env["TMPDIR"] = dir;
    try {
      const staged = stageHandoffToken(TOKEN, { XDG_RUNTIME_DIR: "/run/user/1" }, "darwin");
      expect(staged.dir.startsWith(`${dir}/`)).toBe(true);
      expect(statSync(staged.dir).mode & 0o777).toBe(0o700);
      staged.remove();
    } finally {
      if (tmp === undefined) delete process.env["TMPDIR"];
      else process.env["TMPDIR"] = tmp;
    }
  });

  it("the container reads what the caller wrote, once", () => {
    const staged = stageHandoffToken(TOKEN, { XDG_RUNTIME_DIR: dir }, "linux");
    const file = join(staged.dir, "gh-token");
    expect(takeHandoffToken({ [HANDOFF_FILE_ENV]: file })).toBe(TOKEN);
    expect(readdirSync(staged.dir)).toEqual([]);
    staged.remove();
  });
});

describe("the model's bash after the handoff", () => {
  let rig: HostRig;
  let indir: string;
  const scope = (() => {
    try {
      return Number(readFileSync("/proc/sys/kernel/yama/ptrace_scope", "utf8").trim());
    } catch {
      return null; // no Yama (macOS, or a kernel without it)
    }
  })();

  beforeEach(async () => {
    rig = await createHostRig();
    const staged = stageIn();
    indir = staged.indir;
    takeHandoffToken({ [HANDOFF_FILE_ENV]: staged.file });
    expect(handedToken()).toBe(TOKEN);
  });
  afterEach(() => rig.close());

  // Reads a few bytes of the parent's memory the way a model would with
  // `dd if=/proc/$PPID/mem` or python3.
  const MEM_PROBE = [
    "import sys",
    "pid = sys.argv[1]",
    "try:",
    "    start = None",
    "    for line in open('/proc/%s/maps' % pid):",
    "        parts = line.split()",
    "        if parts[1].startswith('rw'):",
    "            start = int(parts[0].split('-')[0], 16)",
    "            break",
    "    f = open('/proc/%s/mem' % pid, 'rb')",
    "    f.seek(start)",
    "    f.read(16)",
    "    print('MEMREAD_OK')",
    "except Exception as e:",
    "    print('MEMREAD_FAILED ' + type(e).__name__)",
  ].join("\n");

  async function bash(
    command: string,
    guard: boolean,
  ): Promise<{ isError: boolean; text: string }> {
    const session = await rig.host.makeSession({
      cwd: rig.dir,
      env: { PATH: process.env["PATH"], HOME: join(rig.dir, "home") },
      model: rig.faux.getModel(),
      tools: ["bash"],
      extensions: guard ? [bashGuard as unknown as ExtensionFactory] : [],
    });
    rig.faux.setResponses([
      fauxAssistantMessage([fauxToolCall("bash", { command })], { stopReason: "toolUse" }),
      fauxAssistantMessage("done"),
    ]);
    await session.prompt("go");
    const result = session.messages.find((m) => m.role === "toolResult") as unknown as {
      isError: boolean;
      content: { text: string }[];
    };
    return { isError: result.isError, text: result.content.map((c) => c.text).join("\n") };
  }

  it("guard off: the token is in no env, no file and no listing; the memory read fails where Yama is on", async () => {
    writeFileSync(join(dir, "probe.py"), MEM_PROBE);
    const out = await bash(
      [
        `echo "ppid=$PPID"`,
        `cat /proc/1/environ /proc/$PPID/environ 2>&1 | tr "\\0" "\\n"`,
        `echo "--- ls"`,
        `ls -A ${indir}`,
        `echo "--- find"`,
        `grep -rl ${TOKEN} ${dir} 2>/dev/null; echo "grep-rc=$?"`,
        `echo "--- yama"`,
        `cat /proc/sys/kernel/yama/ptrace_scope 2>/dev/null || echo absent`,
        `echo "--- mem"`,
        `python3 ${join(dir, "probe.py")} $PPID`,
        `dd if=/proc/$PPID/mem bs=16 count=1 skip=0 2>&1 | head -c 200; echo`,
      ].join("; "),
      false,
    );
    expect(out.isError).toBe(false);
    // the parent really is this process, which really holds the token
    expect(out.text).toContain(`ppid=${process.pid}`);
    expect(handedToken()).toBe(TOKEN);
    expect(out.text).not.toContain(TOKEN);
    expect(out.text).not.toMatch(/ghs_|GH_TOKEN|GITHUB_TOKEN|QCR_GH_TOKEN_FILE/);
    // the mount dir is empty: the file went at startup
    const afterLs = out.text.split("--- ls")[1]!.split("--- find")[0]!.trim();
    expect(afterLs).toBe("");
    expect(out.text).toContain("grep-rc=1");
    const yama = out.text.split("--- yama")[1]!.split("--- mem")[0]!.trim();
    expect(yama).toBe(scope === null ? "absent" : String(scope));
    if (scope !== null && scope >= 1) {
      // a child cannot attach to its ancestor
      expect(out.text).toContain("MEMREAD_FAILED");
      expect(out.text).not.toContain("MEMREAD_OK");
    }
  });

  it("guard on: the same commands are denied by bash-guard, whatever ptrace_scope is", async () => {
    const commands = [
      `cat /proc/1/environ /proc/$PPID/environ; ls ${indir}`,
      `dd if=/proc/$PPID/mem bs=16 count=1`,
      `python3 -c "f=open('/proc/%d/mem' % 1,'rb'); f.seek(0); f.read(16)"`,
      `cat /proc/$PPID/cmdline`,
    ];
    for (const command of commands) {
      const out = await bash(command, true);
      expect(out.isError, command).toBe(true);
      expect(out.text, command).toMatch(/exec policy/);
      expect(out.text, command).not.toContain(TOKEN);
    }
  });
});
