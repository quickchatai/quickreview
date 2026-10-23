// `qcr open`. Finished sessions open in pi's own UI: which file a run, a
// case dir or a scan names, the argv pi gets (the round's extension set minus
// anything that posts, a fork by default), the environment (no GitHub token), and
// that the kept JSONL resumes under the same id. Pure over temp dirs and
// injected pi/agent-dir seams: no pi, no model, no network.
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { piCliPath } from "../src/picli.js";
import {
  LENS_OPEN_EXTENSIONS,
  MAIN_OPEN_EXTENSIONS,
  findSession,
  openArgv,
  openScratchDirs,
  openEnv,
  runOpen,
  type OpenDeps,
} from "../src/opencli.js";
import {
  LENS_SESSIONS_DIR,
  MAIN_SESSION_DIR,
  OPEN_META_FILE,
  lensSessionsOf,
  mainSessionOf,
  openEnvOf,
  readOpenMeta,
  writeOpenMeta,
} from "@quickchatai/pi-quickreview/src/engine/openable.js";
import { sourcePath } from "./helpers/source-trees.js";

const ROOT = resolve(import.meta.dirname, "..");
const tmp = mkdtempSync(join(tmpdir(), "open-session-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

let home: string;
let n = 0;
beforeEach(() => {
  home = join(tmp, `h${n++}`);
  mkdirSync(home, { recursive: true });
});

const jsonl = (file: string, id: string): void => {
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(
    file,
    JSON.stringify({
      type: "session",
      version: 3,
      id,
      timestamp: "2026-10-19T00:00:00Z",
      cwd: "/x",
    }) + "\n",
  );
};

/** A round dir the way runRound leaves it. */
function round(
  dir: string,
  o: { main?: string; lenses?: Array<{ id: string; agent: string }> } = {},
): string {
  mkdirSync(dir, { recursive: true });
  if (o.main)
    jsonl(join(dir, MAIN_SESSION_DIR, `2026-10-19T00-00-00-000Z_${o.main}.jsonl`), o.main);
  for (const l of o.lenses ?? [])
    jsonl(join(dir, LENS_SESSIONS_DIR, l.id, `2026-10-19T00-00-01-000Z_x.jsonl`), "x");
  if (o.lenses?.length)
    writeFileSync(
      join(dir, "lens-ledger.jsonl"),
      o.lenses
        .map((l) => JSON.stringify({ v: 1, kind: "lens", id: l.id, agent: l.agent }))
        .join("\n") + "\n",
    );
  return dir;
}

interface Calls {
  out: string[];
  spawned: Array<{ bin: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv }>;
  prepared: string[];
  /** Whether each prepare was asked to copy the round's ledger. */
  copied: boolean[];
  cleaned: number;
}

function deps(over: Partial<OpenDeps> = {}): { d: OpenDeps; calls: Calls } {
  const calls: Calls = { out: [], spawned: [], prepared: [], copied: [], cleaned: 0 };
  const d: OpenDeps = {
    detachedHome: join(home, "detached"),
    runsDir: join(home, "runs"),
    scanDir: join(home, "scan"),
    root: ROOT,
    cwd: home,
    env: { PATH: "/usr/bin", GITHUB_TOKEN: "ghp_secret", GH_TOKEN: "ghp_other", TERM: "xterm" },
    out: (l) => calls.out.push(l),
    prepare: ({ roundDir, copyRound }) => {
      calls.prepared.push(roundDir);
      calls.copied.push(copyRound);
      return {
        agentDir: join(roundDir, "open-agent"),
        cwd: join(roundDir, "open-cwd"),
        cleanup: () => {
          calls.cleaned++;
        },
      };
    },
    spawn: (cmd) => {
      calls.spawned.push(cmd);
      return 0;
    },
    ...over,
  };
  return { d, calls };
}

describe("[open] the argv", () => {
  const main = MAIN_OPEN_EXTENSIONS.map((e) => join(ROOT, e));

  it("forks by default, so the finished session is look-only", () => {
    const argv = openArgv({ file: "/s/a.jsonl", mode: "fork", extensions: main });
    expect(argv.slice(-2)).toEqual(["--fork", "/s/a.jsonl"]);
    expect(argv).not.toContain("--session");
  });

  it("--write opens the session itself", () => {
    const argv = openArgv({ file: "/s/a.jsonl", mode: "write", extensions: main });
    expect(argv.slice(-2)).toEqual(["--session", "/s/a.jsonl"]);
    expect(argv).not.toContain("--fork");
  });

  it("loads exactly the round's extensions, bash-guard among them, and discovers none", () => {
    const argv = openArgv({ file: "/s/a.jsonl", mode: "fork", extensions: main });
    const loaded = argv.flatMap((a, i) =>
      argv[i - 1] === "--extension"
        ? [a.slice(a.indexOf("/extensions/") + "/extensions/".length)]
        : [],
    );
    expect(loaded).toEqual([
      "cli/bash-guard.ts",
      "cli/ledger-pin.ts",
      "cli/lens.ts",
      "finding-clusters.ts",
    ]);
    expect(argv).toEqual(expect.arrayContaining(["-ne", "-ns", "--approve"]));
    // `-nc` is absent on purpose: the cwd's context file is the reviewer stub.
    expect(argv).not.toContain("-nc");
  });

  it("carries no posting tool: no extension named for posting, and none of them registers one", () => {
    for (const name of [...MAIN_OPEN_EXTENSIONS, ...LENS_OPEN_EXTENSIONS]) {
      expect(name).not.toMatch(/post|inject|review-submit/i);
      // The shim names nothing; the tools are registered by the module behind
      // it, the app's (extensions/) or the review core's (packages/pi-plugin/extensions/).
      const code = readFileSync(
        join(ROOT, sourcePath(ROOT, name.replace(/^extensions\/cli\//, "extensions/"))),
        "utf8",
      );
      const tools = [...code.matchAll(/\bname:\s*"([a-z_]+)"/g)].map((m) => m[1]!);
      for (const t of tools) expect(t).not.toMatch(/post|submit|comment|review_pr/i);
    }
    const argv = openArgv({ file: "/s/a.jsonl", mode: "fork", extensions: main });
    expect(argv.join(" ")).not.toMatch(/post/i);
  });

  it("a lens pass is a leaf: bash-guard alone, never a lens tool", async () => {
    const found = findSession(
      round(join(home, "r1"), { lenses: [{ id: "L1", agent: "pass-a" }] }),
      "L1",
      deps().d,
    );
    expect(found.ok && found.kind).toBe("lens");
    expect([...LENS_OPEN_EXTENSIONS]).toEqual(["extensions/cli/bash-guard.ts"]);
    const { d, calls } = deps();
    const dir = round(join(home, "r2"), { lenses: [{ id: "L1", agent: "pass-a" }] });
    expect(await runOpen([dir, "--lens", "L1"], false, d)).toBe(0);
    const args = calls.spawned[0]!.args;
    const loaded = args.flatMap((a, i) =>
      args[i - 1] === "--extension"
        ? [a.slice(a.indexOf("/extensions/") + "/extensions/".length)]
        : [],
    );
    expect(loaded).toEqual(["cli/bash-guard.ts"]);
  });
});

describe("[open] the environment", () => {
  it("drops every GitHub token, roots the round at this tree and names the private agent dir", () => {
    const env = openEnv({
      base: {
        PATH: "/bin",
        GITHUB_TOKEN: "t",
        GH_TOKEN: "t",
        GH_ENTERPRISE_TOKEN: "t",
        TERM: "xterm",
      },
      meta: {
        version: 1,
        sessionName: "review-x",
        cwd: "/old/out",
        model: "m",
        env: { QCR_PR: "7", QCR_SANDBOX_ROOT: "/old/root", QCR_LEDGER_FILE: "/old/out/ledger.md" },
      },
      root: "/new/root",
      ledgerDir: "/old/out/open-cwd",
      agentDir: "/old/out/open-agent",
    });
    expect(env["GITHUB_TOKEN"]).toBeUndefined();
    expect(env["GH_TOKEN"]).toBeUndefined();
    expect(env["GH_ENTERPRISE_TOKEN"]).toBeUndefined();
    expect(env["TERM"]).toBe("xterm");
    expect(env["PI_CODING_AGENT_DIR"]).toBe("/old/out/open-agent");
    expect(env["QCR_SANDBOX_ROOT"]).toBe("/new/root");
    expect(env["QCR_PR"]).toBe("7");
    // the ledger the session works on is the one it is told, not the round's
    expect(env["QCR_LEDGER_FILE"]).toBe("/old/out/open-cwd/ledger.md");
    expect(env["QCR_SUBAGENT_SCOPE"]).toBe("user");
    expect(env["GIT_CONFIG_GLOBAL"]).toBe("/dev/null");
  });

  it("keeps only QCR_* names in the open record, and nothing that looks like a secret", () => {
    expect(
      openEnvOf({
        QCR_PR: "7",
        QCR_API_KEY: "k",
        QCR_X_TOKEN: "t",
        OPENAI_API_KEY: "k",
        PATH: "/bin",
        QCR_NOTHING: undefined,
      }),
    ).toEqual({ QCR_PR: "7" });
  });

  it("round-trips the record, and reads a missing or malformed one as none", () => {
    const dir = join(home, "meta");
    expect(readOpenMeta(dir)).toBeNull();
    writeOpenMeta(dir, {
      version: 1,
      sessionName: "s",
      cwd: "/c",
      model: "m",
      env: { QCR_PR: "1" },
    });
    expect(readOpenMeta(dir)).toMatchObject({ sessionName: "s", env: { QCR_PR: "1" } });
    writeFileSync(join(dir, OPEN_META_FILE), "{not json");
    expect(readOpenMeta(dir)).toBeNull();
  });
});

describe("[open] scratch dirs", () => {
  it("each invocation owns its agent dir and cwd", async () => {
    expect(openScratchDirs("/r")).toEqual({ agentDir: "/r/open-agent", cwd: "/r/open-cwd" });
    expect(openScratchDirs("/r", "42")).toEqual({
      agentDir: "/r/open-agent-42",
      cwd: "/r/open-cwd-42",
    });
    const out = round(join(home, "runs", "s1", "out"), { main: "M" });
    const seen: Array<string | undefined> = [];
    const base = deps();
    const d: OpenDeps = {
      ...base.d,
      instance: "7",
      prepare: (o) => {
        seen.push(o.instance);
        return base.d.prepare(o);
      },
    };
    expect(await runOpen(["s1", "--print"], false, d)).toBe(0);
    expect(base.calls.out.join("\n")).toContain(join(out, "open-agent-7"));
    expect(await runOpen(["s1"], false, d)).toBe(0);
    expect(seen).toEqual(["7"]);
  });
});

describe("[open] finding the session", () => {
  it("names a `qcr review` run dir, its out/ and a bare run name", () => {
    const run = join(home, "runs", "20261019-abc1234");
    const out = round(join(run, "out"), { main: "MAIN1" });
    const { d } = deps();
    for (const arg of [run, out, "20261019-abc1234"]) {
      const f = findSession(arg, undefined, d);
      expect(f.ok && f.file, arg).toBe(mainSessionOf(out));
      expect(f.ok && f.roundDir, arg).toBe(out);
    }
  });

  it("names a detached run by its id, through work/<run>/out", () => {
    const out = round(
      join(home, "detached", "runs", "20261019-aaaa", "work", "20261019-pr7", "out"),
      {
        main: "MAIN2",
      },
    );
    const f = findSession("20261019-aaaa", undefined, deps().d);
    expect(f.ok && f.file).toBe(mainSessionOf(out));
  });

  it("with no argument, the newest run that kept a session", () => {
    round(join(home, "runs", "old", "out"), { main: "OLD" });
    const newer = round(join(home, "runs", "new", "out"), { main: "NEW" });
    const t = Date.now() / 1000;
    // make `new` the newer by mtime
    for (const [r, at] of [
      ["old", t - 1000],
      ["new", t],
    ] as const)
      for (const p of [join(home, "runs", r), join(home, "runs", r, "out")]) utimesSync(p, at, at);
    const f = findSession(undefined, undefined, deps().d);
    expect(f.ok && f.roundDir).toBe(newer);
  });

  it("an extracted archive with a main transcript and no worker rounds opens its main session", () => {
    const arch = join(home, "extracted-pr");
    const t = join(arch, "transcripts", "2026-10-03T10-00-00_c.jsonl");
    jsonl(t, "MAINX");
    const f = findSession(arch, undefined, deps().d);
    expect(f.ok && f.file).toBe(t);
    expect(f.ok && f.kind).toBe("main");
    // a lens still needs a retained lens session
    expect(findSession(arch, "pass-x", deps().d).ok).toBe(false);
  });

  it("a bench case dir holds session/ and lens-sessions/ directly", () => {
    const caseDir = round(join(home, "bench", "case-1"), {
      main: "BENCHMAIN",
      lenses: [{ id: "lens-id-1", agent: "pass-security" }],
    });
    const main = findSession(caseDir, undefined, deps().d);
    expect(main.ok && main.kind).toBe("main");
    const lens = findSession(caseDir, "pass-security", deps().d);
    expect(lens.ok && lens.kind).toBe("lens");
    expect(lens.ok && lens.id).toBe("lens-id-1");
  });

  it("a scan run keeps one session per case: opened by --lens, never by default", () => {
    const run = round(join(home, "scan", "scan-20261019"), {
      lenses: [
        { id: "row-1", agent: "x" },
        { id: "row-2_1.validate", agent: "x" },
      ],
    });
    const { d } = deps();
    const bare = findSession("scan:scan-20261019", undefined, d);
    expect(bare.ok).toBe(false);
    expect(!bare.ok && bare.error).toMatch(/--lens row-1/);
    const one = findSession("scan:scan-20261019", "row-2_1.validate", d);
    expect(one.ok && one.roundDir).toBe(run);
    expect(findSession("scan", "row-1", d).ok).toBe(true);
  });

  it("a session file opens as it is, and not with --lens", () => {
    const f = join(home, "x.jsonl");
    jsonl(f, "FILE");
    const { d } = deps();
    expect(findSession(f, undefined, d)).toMatchObject({ ok: true, file: f, kind: "main" });
    expect(findSession(f, "L", d).ok).toBe(false);
    expect(findSession(join(home, "missing.jsonl"), undefined, d).ok).toBe(false);
  });

  it("--lens takes an id, an agent name or a unique id prefix, and says what it can", () => {
    const dir = round(join(home, "r"), {
      lenses: [
        { id: "aaaa1111", agent: "pass-a" },
        { id: "aaaa2222", agent: "pass-b" },
        { id: "bbbb3333", agent: "pass-b" },
      ],
    });
    const { d } = deps();
    expect(findSession(dir, "aaaa1111", d)).toMatchObject({ ok: true, id: "aaaa1111" });
    expect(findSession(dir, "pass-a", d)).toMatchObject({ ok: true, id: "aaaa1111" });
    expect(findSession(dir, "bbbb", d)).toMatchObject({ ok: true, id: "bbbb3333" });
    const twice = findSession(dir, "pass-b", d);
    expect(!twice.ok && twice.error).toMatch(/aaaa2222, bbbb3333/);
    const prefixTwice = findSession(dir, "aaaa", d);
    expect(!prefixTwice.ok && prefixTwice.error).toMatch(/more than one id starts with it/);
    const none = findSession(dir, "nope", d);
    expect(!none.ok && none.error).toMatch(/aaaa1111 \(pass-a\)/);
  });

  it("refuses a run that kept nothing, and a --lens that is not a name", () => {
    mkdirSync(join(home, "runs", "empty", "out"), { recursive: true });
    const { d } = deps();
    expect(findSession("empty", undefined, d)).toMatchObject({ ok: false });
    expect(findSession(undefined, undefined, d)).toMatchObject({ ok: false });
    expect(findSession(join(home, "runs", "empty"), "../x", d)).toMatchObject({ ok: false });
  });
});

describe("[open] the verb", () => {
  it("prepares a private agent dir, starts pi on a fork, and removes the copy of the login afterwards", async () => {
    const out = round(join(home, "runs", "r1", "out"), { main: "M" });
    writeOpenMeta(out, {
      version: 1,
      sessionName: "review-x",
      cwd: out,
      model: "m",
      env: { QCR_PR: "7", QCR_LEDGER_FILE: join(out, "ledger.md") },
    });
    const { d, calls } = deps();
    expect(await runOpen(["r1"], false, d)).toBe(0);
    expect(calls.prepared).toEqual([out]);
    const cmd = calls.spawned[0]!;
    // the pinned pi's own CLI, never a pi on the PATH
    expect(cmd.bin).toBe(piCliPath());
    expect(cmd.args.slice(-2)).toEqual(["--fork", mainSessionOf(out)]);
    expect(cmd.cwd).toBe(join(out, "open-cwd"));
    expect(cmd.env["GITHUB_TOKEN"]).toBeUndefined();
    expect(cmd.env["GH_TOKEN"]).toBeUndefined();
    expect(cmd.env["PI_CODING_AGENT_DIR"]).toBe(join(out, "open-agent"));
    expect(cmd.env["QCR_PR"]).toBe("7");
    // a fork works on a copy: what its lens passes write goes with the open
    expect(calls.copied).toEqual([true]);
    expect(cmd.env["QCR_LEDGER_FILE"]).toBe(join(out, "open-cwd", "ledger.md"));
    expect(calls.cleaned).toBe(1);
    expect(calls.out.join("\n")).toMatch(/finished session is not touched/);
  });

  it("--write works in the round itself when the round recorded how it ran, and on a copy when it did not", async () => {
    const out = round(join(home, "runs", "w1", "out"), { main: "M" });
    writeOpenMeta(out, { version: 1, sessionName: "s", cwd: out, model: "m", env: {} });
    const { d, calls } = deps();
    expect(await runOpen(["w1", "--write"], false, d)).toBe(0);
    expect(calls.copied).toEqual([false]);
    expect(calls.spawned[0]!.env["QCR_LEDGER_FILE"]).toBe(join(out, "ledger.md"));
    const bare = round(join(home, "runs", "w2", "out"), { main: "M" });
    expect(await runOpen(["w2", "--write"], false, d)).toBe(0);
    expect(calls.copied).toEqual([false, true]);
    expect(calls.spawned[1]!.env["QCR_LEDGER_FILE"]).toBe(join(bare, "open-cwd", "ledger.md"));
  });

  it("--write says so, and still cleans up when pi fails", async () => {
    round(join(home, "runs", "r2", "out"), { main: "M" });
    const { d, calls } = deps({
      spawn: () => {
        throw new Error("pi vanished");
      },
    });
    await expect(runOpen(["r2", "--write"], false, d)).rejects.toThrow("pi vanished");
    expect(calls.cleaned).toBe(1);
    expect(calls.out.join("\n")).toMatch(/appended to the session/);
  });

  it("--print starts nothing and prepares nothing", async () => {
    round(join(home, "runs", "r3", "out"), { main: "M", lenses: [{ id: "L", agent: "pass-a" }] });
    const { d, calls } = deps();
    expect(await runOpen(["r3", "--print"], false, d)).toBe(0);
    expect(calls.spawned).toEqual([]);
    expect(calls.prepared).toEqual([]);
    expect(calls.out.join("\n")).toContain(`${piCliPath()} `);
    expect(calls.out.join("\n")).toMatch(/--fork .*\.jsonl/);
    calls.out.length = 0;
    expect(await runOpen(["r3", "--lens", "L", "--print", "--json"], false, d)).toBe(0);
    expect(JSON.parse(calls.out[0]!)).toMatchObject({
      ok: true,
      kind: "lens",
      mode: "fork",
      command: piCliPath(),
    });
  });

  it("an agent dir that cannot be prepared (a login about to expire) is an error line, not a crash", async () => {
    round(join(home, "runs", "r4", "out"), { main: "M" });
    const { d, calls } = deps({
      prepare: () => {
        throw new Error("your pi login expires at 2026-10-19T00:10:00.000Z");
      },
    });
    expect(await runOpen(["r4"], false, d)).toBe(1);
    expect(calls.out.join("\n")).toMatch(/login expires/);
    expect(calls.spawned).toEqual([]);
  });

  it("usage errors are exit 2, a run with nothing to open exit 1, and --help prints the usage", async () => {
    const { d, calls } = deps();
    expect(await runOpen(["--bogus"], false, d)).toBe(2);
    expect(await runOpen(["--lens"], false, d)).toBe(2);
    expect(await runOpen(["a", "b"], false, d)).toBe(2);
    expect(await runOpen(["nothing-here"], false, d)).toBe(1);
    calls.out.length = 0;
    expect(await runOpen(["--help"], false, d)).toBe(0);
    expect(calls.out.join("\n")).toMatch(/usage: qcr open/);
  });

  it("the kept files the verb reads are the ones the round writes", () => {
    // the layout names are the contract between the writers and `qcr open`
    expect(MAIN_SESSION_DIR).toBe("session");
    expect(LENS_SESSIONS_DIR).toBe("lens-sessions");
    const dir = round(join(home, "layout"), { main: "A", lenses: [{ id: "L1", agent: "a" }] });
    expect(readdirSync(dir).sort()).toEqual(["lens-ledger.jsonl", "lens-sessions", "session"]);
    expect(lensSessionsOf(dir).map((r) => r.id)).toEqual(["L1"]);
  });
});
