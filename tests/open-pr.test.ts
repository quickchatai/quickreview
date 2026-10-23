// `qcr open pr <n> [--round r] [--lens id]`. A bot PR session from the box
// that hosts the bot, copied read-only into the state home and forked in pi on this
// machine. The ssh runner here is real shell: each remote script runs under `sh -c`
// against a fixture sandbox root, so what the box would be asked is what is run, and
// the tests assert that none of it writes. The archive leg uses the real archiver's
// output and the real `extractPr`. The pty smoke runs the REAL pi CLI on a local
// OpenAI-compatible endpoint: no model, nothing leaves loopback.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { extractPr } from "../src/archive/extract.js";
import { TUI_DEFAULTS, type TuiConfig } from "../src/config.js";
import { PiHost } from "@quickchatai/pi-quickreview/src/engine/pisdk.js";
import { sdkRuntime } from "@quickchatai/pi-quickreview/src/engine/sdkruntime.js";
import { HOST_CONTEXT_STUB, REVIEWER_STUB } from "../src/hostroute.js";
import { BOT_OPEN_EXTENSIONS, runOpen, type OpenDeps } from "../src/opencli.js";
import {
  OPEN_PR_RECORD,
  cutAtTime,
  listArgv,
  openPrOptions,
  parseListing,
  pullPrSession,
  sessionIdOf,
  wholeLines,
  type PrPull,
  type PrPullDeps,
} from "../src/openpr.js";
import type { RemoteResult, SshRunner } from "../src/tui/remote.js";
import {
  FAKE_MODEL,
  startFakeOpenAI,
  writeFakeProvider,
  type FakeOpenAI,
} from "./helpers/fake-openai.js";
import { filesUnder, onArchiver, prFixture, put, type PrFixture } from "./helpers/archive-pr.js";
import { HEAVY_TIMEOUT_MS } from "./helpers/suite-timeouts.js";

const ROOT = resolve(import.meta.dirname, "..");
const PI_BIN = join(ROOT, "node_modules", ".bin", "pi");
const tmp = mkdtempSync(join(tmpdir(), "open-pr-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const sha = (b: Buffer | string): string => createHash("sha256").update(b).digest("hex");
const SESSION_DIR = "state/pi-sessions";

/** A pi v3 session: header and a user/assistant pair per turn, stamped at `ats`. */
function session(id: string, cwd: string, turns: Array<{ at: string; text: string }>): string {
  const out = [JSON.stringify({ type: "session", version: 3, id, timestamp: turns[0]!.at, cwd })];
  let parent: string | null = null;
  turns.forEach((t, i) => {
    const ms = Date.parse(t.at);
    const u = `u${i}`.padEnd(8, "0");
    const a = `a${i}`.padEnd(8, "0");
    out.push(
      JSON.stringify({
        type: "message",
        id: u,
        parentId: parent,
        timestamp: t.at,
        message: { role: "user", content: [{ type: "text", text: t.text }], timestamp: ms },
      }),
      JSON.stringify({
        type: "message",
        id: a,
        parentId: u,
        timestamp: new Date(ms + 1000).toISOString(),
        message: {
          role: "assistant",
          content: [{ type: "text", text: `answer to ${t.text}` }],
          api: "openai-completions",
          provider: "local",
          model: "m",
          usage: {
            input: 10,
            output: 2,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 12,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "stop",
          timestamp: ms + 1000,
        },
      }),
    );
    parent = a;
  });
  return out.join("\n") + "\n";
}

const TURNS = [
  { at: "2026-10-01T10:00:00.000Z", text: "round one order" },
  { at: "2026-10-02T10:00:00.000Z", text: "round two order" },
  { at: "2026-10-03T10:00:00.000Z", text: "round three order" },
];
const VM_CWD = "/opt/quickreview/sandbox/worktrees/pr-7";

const remoteCfg = (root: string): TuiConfig => ({
  ...TUI_DEFAULTS,
  ssh_host: "my-vm",
  container: "quickreview-sandbox",
  sudo_docker: true,
  remote_sandbox_root: root,
});

/** Every file under `dir` with its sha and mtime: what "nothing was written" compares. */
function snapshot(dir: string): Map<string, string> {
  return new Map(
    filesUnder(dir).map((p) => [
      p,
      `${sha(readFileSync(join(dir, p)))}@${statSync(join(dir, p)).mtimeMs}`,
    ]),
  );
}

interface Rig {
  deps: PrPullDeps;
  /** Every argv the runner was handed. */
  argvs: string[][];
  /** The scripts those argvs carried (`sh -c <script>`). */
  scripts: string[];
  home: string;
}

let n = 0;
/** The runner executes `docker exec <c> sh -c <script>` as `sh -c <script>` here; the
 * in-container `qcr why --json` answers from `why`. */
function rig(root: string, why: unknown = { rounds: [] }): Rig {
  const home = join(tmp, `home${n++}`);
  mkdirSync(home, { recursive: true });
  const argvs: string[][] = [];
  const scripts: string[] = [];
  const ssh: SshRunner = async (_host, argv): Promise<RemoteResult> => {
    argvs.push(argv);
    const i = argv.indexOf("sh");
    if (i >= 0 && argv[i + 1] === "-c") {
      scripts.push(argv[i + 2]!);
      const r = spawnSync("sh", ["-c", argv[i + 2]!], { encoding: "utf8", maxBuffer: 1 << 28 });
      return { ok: r.status === 0, stdout: r.stdout, stderr: r.stderr, code: r.status };
    }
    if (argv.includes("why")) return { ok: true, stdout: JSON.stringify(why), stderr: "", code: 0 };
    return { ok: false, stdout: "", stderr: `unexpected argv ${argv.join(" ")}`, code: 1 };
  };
  return {
    deps: {
      cfg: remoteCfg(root),
      sessionDir: SESSION_DIR,
      ssh,
      home,
      extract: (x) => extractPr({ ...x, bytesPerS: 200 * 1024 * 1024 }),
    },
    argvs,
    scripts,
    home,
  };
}

/** A sandbox root with one live PR session. */
function liveRoot(text: string, pr = 7, name = "2026-10-03T10-00-00-000Z_sess-live.jsonl"): string {
  const root = mkdtempSync(join(tmp, "root-"));
  put(root, `${SESSION_DIR}/pr-${pr}/${name}`, text);
  return root;
}

/** Writes need a verb or a redirection; the reads here use neither. */
const WRITES =
  /(^|[\s;|&(])(rm|mv|cp|tee|touch|mkdir|rmdir|chmod|chown|ln|dd|truncate|install|kill|docker\s+(run|rm|cp|stop|kill)|tmux)\b|>|sed\s+-i/;

describe("[open-pr] arguments", () => {
  it("wants a whole PR number and a whole round number", () => {
    expect(openPrOptions("7", undefined, undefined)).toEqual({ ok: true, value: { pr: 7 } });
    expect(openPrOptions("7", "3", undefined)).toEqual({ ok: true, value: { pr: 7, round: 3 } });
    expect(openPrOptions("7", undefined, "pass-a")).toEqual({
      ok: true,
      value: { pr: 7, lens: "pass-a" },
    });
    for (const bad of [undefined, "0", "-1", "7;rm", "7.5", "x", ""])
      expect(openPrOptions(bad, undefined, undefined).ok).toBe(false);
    expect(openPrOptions("7", "0", undefined).ok).toBe(false);
    expect(openPrOptions("7", "r1", undefined).ok).toBe(false);
  });

  it("refuses --round with --lens: nothing records which round a lens pass belonged to", () => {
    const r = openPrOptions("7", "1", "pass-a");
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).not.toContain("workers will");
  });
});

describe("[open-pr] the box's answer is data, never script", () => {
  const root = "/opt/quickreview/sandbox";
  const dir = `${root}/${SESSION_DIR}/pr-7`;

  it("keeps the PR's own sessions and archive manifest, and drops anything else", () => {
    const listing = [
      `live 100 1700 ${dir}/a.jsonl`,
      `live 100 1700 ${dir}/nested/b.jsonl`, // not directly in the dir
      `live 100 1700 ${root}/${SESSION_DIR}/pr-8/c.jsonl`, // another PR
      `live 100 1700 ${dir}/../pr-8/c.jsonl`, // a traversal
      `live 100 1700 ${dir}/has space.jsonl`,
      `live 100 1700 ${dir}/$(id).jsonl`,
      `lens 50 1700 ${dir}/lens-sessions/L1/x.jsonl`,
      `lens 50 1700 ${dir}/lens-sessions/x.jsonl`, // one level short
      `archive-manifest 0 0 ${root}/archive/pr-7/manifest.json`,
      `archive-manifest 0 0 ${root}/archive/pr-8/manifest.json`,
      `live abc 1700 ${dir}/d.jsonl`,
      `garbage`,
    ].join("\n");
    expect(parseListing(listing, root, SESSION_DIR, 7)).toEqual([
      { kind: "live", bytes: 100, mtimeS: 1700, path: `${dir}/a.jsonl` },
      { kind: "lens", bytes: 50, mtimeS: 1700, path: `${dir}/lens-sessions/L1/x.jsonl` },
      {
        kind: "archive-manifest",
        bytes: 0,
        mtimeS: 0,
        path: `${root}/archive/pr-7/manifest.json`,
      },
    ]);
  });

  it("the listing script is reads only, ends exit 0, and names the PR's directory", () => {
    const argv = listArgv(remoteCfg(root), SESSION_DIR, 7);
    expect(argv.slice(0, 5)).toEqual(["sudo", "docker", "exec", "quickreview-sandbox", "sh"]);
    const script = argv.at(-1)!;
    expect(script).toContain(`${SESSION_DIR}/pr-7`);
    expect(script.trim().endsWith("exit 0")).toBe(true);
    expect(script).not.toMatch(WRITES);
  });
});

describe("[open-pr] session text", () => {
  it("keeps whole lines only, so a session still being written never ends on a torn entry", () => {
    expect(wholeLines('{"a":1}\n{"b":')).toBe('{"a":1}\n');
    expect(wholeLines('{"a":1}\n')).toBe('{"a":1}\n');
    expect(wholeLines("no newline")).toBeNull();
  });

  it("reads the id off the header", () => {
    expect(sessionIdOf(session("abc", "/x", TURNS))).toBe("abc");
    expect(sessionIdOf('{"type":"message"}\n')).toBeNull();
    expect(sessionIdOf("not json\n")).toBeNull();
  });

  it("cuts a session at a time: the header and every entry stamped up to it", () => {
    const text = session("abc", "/x", TURNS);
    const cut = cutAtTime(text, Date.parse("2026-10-02T12:00:00.000Z"))!;
    expect(cut.kept).toBe(4);
    expect(cut.dropped).toBe(2);
    expect(cut.text).toContain("round two order");
    expect(cut.text).not.toContain("round three order");
    expect(sessionIdOf(cut.text)).toBe("abc");
    // the cut is a byte prefix of the session: same entries, same ids, nothing rewritten
    expect(text.startsWith(cut.text)).toBe(true);
  });

  it("drops a turn cut off at a tool call, whose result falls after the cut", () => {
    const base = session("abc", "/x", TURNS.slice(0, 1)).split("\n").filter(Boolean);
    const call = JSON.stringify({
      type: "message",
      id: "c1c1c1c1",
      parentId: "a0000000",
      timestamp: "2026-10-01T10:05:00.000Z",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: "t", name: "bash", arguments: { command: "ls" } }],
        stopReason: "toolUse",
        timestamp: Date.parse("2026-10-01T10:05:00.000Z"),
      },
    });
    const result = JSON.stringify({
      type: "message",
      id: "d1d1d1d1",
      parentId: "c1c1c1c1",
      timestamp: "2026-10-01T10:07:00.000Z",
      message: {
        role: "toolResult",
        toolCallId: "t",
        toolName: "bash",
        content: [],
        isError: false,
      },
    });
    const text = [...base, call, result].join("\n") + "\n";
    const cut = cutAtTime(text, Date.parse("2026-10-01T10:06:00.000Z"))!;
    expect(cut.text).not.toContain("toolCall");
    expect(cut.kept).toBe(2);
  });

  it("drops a batch of two tool calls when the cut falls between their results", () => {
    const base = session("abc", "/x", TURNS.slice(0, 1)).split("\n").filter(Boolean);
    const call = JSON.stringify({
      type: "message",
      id: "c1c1c1c1",
      parentId: "a0000000",
      timestamp: "2026-10-01T10:05:00.000Z",
      message: {
        role: "assistant",
        content: [
          { type: "toolCall", id: "t1", name: "bash", arguments: { command: "ls" } },
          { type: "toolCall", id: "t2", name: "bash", arguments: { command: "pwd" } },
        ],
        stopReason: "toolUse",
      },
    });
    const result = (id: string, at: string): string =>
      JSON.stringify({
        type: "message",
        id: `r-${id}`,
        parentId: "c1c1c1c1",
        timestamp: at,
        message: { role: "toolResult", toolCallId: id, toolName: "bash", content: [] },
      });
    const text =
      [
        ...base,
        call,
        result("t1", "2026-10-01T10:07:00.000Z"),
        result("t2", "2026-10-01T10:09:00.000Z"),
      ].join("\n") + "\n";
    const cut = cutAtTime(text, Date.parse("2026-10-01T10:08:00.000Z"))!;
    expect(cut.text).not.toContain("toolCall");
    expect(cut.text).not.toContain("toolResult");
    expect(cut.kept).toBe(2);
    // both results kept: the whole batch stays
    const whole = cutAtTime(text, Date.parse("2026-10-01T10:10:00.000Z"))!;
    expect(whole.kept).toBe(5);
  });

  it("refuses a cut before anything was recorded", () => {
    expect(
      cutAtTime(session("abc", "/x", TURNS), Date.parse("2026-09-01T00:00:00.000Z")),
    ).toBeNull();
  });
});

describe("[open-pr] a live session", () => {
  it("copies the newest JSONL byte for byte, read-only, under the same id, and writes nothing on the box", async () => {
    const text = session("sess-live", VM_CWD, TURNS);
    const root = liveRoot(text);
    // an older spawn of the same PR, which must not be picked
    put(
      root,
      `${SESSION_DIR}/pr-7/2026-09-01T10-00-00-000Z_old.jsonl`,
      session("old", VM_CWD, TURNS.slice(0, 1)),
      Date.parse("2026-09-01T10:00:00Z"),
    );
    const before = snapshot(root);
    const r = rig(root);
    const got = await pullPrSession({ pr: 7 }, r.deps);
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(got.source).toBe("live");
    expect(got.kind).toBe("main");
    expect(got.dir).toBe(join(r.home, "open", "pr-7"));
    expect(readFileSync(got.file, "utf8")).toBe(text);
    expect(sessionIdOf(readFileSync(got.file, "utf8"))).toBe("sess-live");
    // the copy is read-only, and says where it came from
    expect(statSync(got.file).mode & 0o222).toBe(0);
    const rec = JSON.parse(readFileSync(join(got.dir, OPEN_PR_RECORD), "utf8"));
    expect(rec).toMatchObject({
      pr: 7,
      source: "live",
      session_id: "sess-live",
      sha256: sha(text),
      from: "my-vm",
    });
    // nothing is written remotely: the box's tree is as it was
    expect(snapshot(root)).toEqual(before);
    // and the argv never carries a write
    expect(r.scripts.length).toBeGreaterThan(0);
    for (const s of r.scripts) expect(s, s).not.toMatch(WRITES);
    for (const argv of r.argvs)
      expect(argv.slice(0, 4)).toEqual(["sudo", "docker", "exec", "quickreview-sandbox"]);
  });

  it("a second pull replaces the copy (a read-only file is not in the way)", async () => {
    const root = liveRoot(session("sess-live", VM_CWD, TURNS.slice(0, 2)));
    const r = rig(root);
    const first = await pullPrSession({ pr: 7 }, r.deps);
    expect(first.ok).toBe(true);
    put(
      root,
      `${SESSION_DIR}/pr-7/2026-10-03T10-00-00-000Z_sess-live.jsonl`,
      session("sess-live", VM_CWD, TURNS),
    );
    const second = await pullPrSession({ pr: 7 }, r.deps);
    expect(second.ok && readFileSync(second.file, "utf8")).toContain("round three order");
    expect(readdirSync(join(r.home, "open", "pr-7", "session"))).toHaveLength(1);
  });

  it("drops a tail the bot was still writing", async () => {
    const whole = session("sess-live", VM_CWD, TURNS);
    const root = liveRoot(whole + '{"type":"message","id":"zz');
    const got = await pullPrSession({ pr: 7 }, rig(root).deps);
    expect(got.ok && readFileSync(got.file, "utf8")).toBe(whole);
  });

  it("--round keeps the session as it stood when that round finished", async () => {
    const text = session("sess-live", VM_CWD, TURNS);
    const root = liveRoot(text);
    const why = {
      rounds: [
        {
          round_no: 1,
          status: "done",
          verdict: "COMMENT",
          finished_at: "2026-10-01T11:00:00.000Z",
        },
        {
          round_no: 2,
          status: "done",
          verdict: "COMMENT",
          finished_at: "2026-10-02T11:00:00.000Z",
        },
        { round_no: 3, status: "running", verdict: null, finished_at: null },
      ],
    };
    const r = rig(root, why);
    const got = await pullPrSession({ pr: 7, round: 2 }, r.deps);
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(got.dir).toBe(join(r.home, "open", "pr-7", "round-2"));
    const copy = readFileSync(got.file, "utf8");
    expect(copy).toContain("round two order");
    expect(copy).not.toContain("round three order");
    expect(text.startsWith(copy)).toBe(true);
    expect(got.note).toContain("round 2");
    // the whole-session copy beside it is not touched by a round copy
    expect(existsSync(join(r.home, "open", "pr-7", "session"))).toBe(false);
    // a running round, and one that does not exist, are named
    const running = await pullPrSession({ pr: 7, round: 3 }, r.deps);
    expect(!running.ok && running.error).toContain("no finished round 3 (finished: 1, 2)");
    const absent = await pullPrSession({ pr: 7, round: 9 }, r.deps);
    expect(absent.ok).toBe(false);
    for (const s of r.scripts) expect(s).not.toMatch(WRITES);
  });

  it("names the failure when the box cannot be reached", async () => {
    const r = rig(liveRoot("x\n"));
    r.deps.ssh = async () => ({
      ok: false,
      stdout: "",
      stderr: "ssh: connect to host my-vm port 22: Connection timed out\n",
      code: 255,
    });
    const got = await pullPrSession({ pr: 7 }, r.deps);
    expect(got).toEqual({
      ok: false,
      error:
        "could not list pr-7 on my-vm: ssh: connect to host my-vm port 22: Connection timed out",
    });
  });

  it("says so when a PR has no session at all, and when the file is not a pi session", async () => {
    const empty = mkdtempSync(join(tmp, "root-"));
    const none = await pullPrSession({ pr: 7 }, rig(empty).deps);
    expect(!none.ok && none.error).toBe("pr-7 has no session on my-vm, live or archived");
    const junk = await pullPrSession({ pr: 7 }, rig(liveRoot("this is not a session\n")).deps);
    expect(!junk.ok && junk.error).toContain("is not a pi session");
  });

  it("the local topology says 'this machine', and reads the same way", async () => {
    const r = rig(liveRoot(session("sess-live", VM_CWD, TURNS)));
    r.deps.cfg = { ...r.deps.cfg, target: "local" };
    const got = await pullPrSession({ pr: 7 }, r.deps);
    expect(got.ok && got.note).toContain("from this machine");
  });
});

describe("[open-pr] lens passes", () => {
  it("a tmux-era PR has none: the error says why, and what to do", async () => {
    const root = liveRoot(session("sess-live", VM_CWD, TURNS));
    const got = await pullPrSession({ pr: 7, lens: "pass-a" }, rig(root).deps);
    expect(got.ok).toBe(false);
    expect(!got.ok && got.error).toContain("kept no lens sessions");
    expect(!got.ok && got.error).toContain("workers persist them");
  });

  it("opens a kept lens pass by id or unambiguous prefix, as its own leaf copy", async () => {
    const root = liveRoot(session("sess-live", VM_CWD, TURNS));
    const lens = session("lens-1", VM_CWD, TURNS.slice(0, 1));
    put(root, `${SESSION_DIR}/pr-7/lens-sessions/abc123/2026_x.jsonl`, lens);
    put(root, `${SESSION_DIR}/pr-7/lens-sessions/abd456/2026_y.jsonl`, lens);
    const r = rig(root);
    const got = await pullPrSession({ pr: 7, lens: "abc" }, r.deps);
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(got.kind).toBe("lens");
    expect(got.file).toBe(join(r.home, "open", "pr-7", "lens-sessions", "abc123", "2026_x.jsonl"));
    expect(readFileSync(got.file, "utf8")).toBe(lens);
    const ambiguous = await pullPrSession({ pr: 7, lens: "ab" }, r.deps);
    expect(!ambiguous.ok && ambiguous.error).toContain("more than one");
    const unknown = await pullPrSession({ pr: 7, lens: "zzz" }, r.deps);
    expect(!unknown.ok && unknown.error).toContain("abc123, abd456");
  });

  it("finds the lens passes a worker keeps under state/lens/pr-<n>/r<k>/", async () => {
    const root = liveRoot(session("sess-live", VM_CWD, TURNS));
    const lens = session("lens-w", VM_CWD, TURNS.slice(0, 1));
    put(root, "state/lens/pr-7/r2/lens-sessions/wrk789/2026_w.jsonl", lens);
    put(root, "state/lens/pr-8/r1/lens-sessions/other/2026_o.jsonl", lens);
    const r = rig(root);
    const got = await pullPrSession({ pr: 7, lens: "wrk" }, r.deps);
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(got.kind).toBe("lens");
    expect(readFileSync(got.file, "utf8")).toBe(lens);
    const other = await pullPrSession({ pr: 7, lens: "other" }, r.deps);
    expect(!other.ok && other.error).toContain("it kept: wrk789");
  });

  it("copies a lens pass to whole lines only, and refuses one with no header", async () => {
    const root = liveRoot(session("sess-live", VM_CWD, TURNS));
    const lens = session("lens-t", VM_CWD, TURNS.slice(0, 1));
    put(root, `${SESSION_DIR}/pr-7/lens-sessions/torn01/a.jsonl`, lens + '{"type":"mess');
    put(root, `${SESSION_DIR}/pr-7/lens-sessions/nohead/a.jsonl`, '{"type":"mess');
    const r = rig(root);
    const got = await pullPrSession({ pr: 7, lens: "torn" }, r.deps);
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(readFileSync(got.file, "utf8")).toBe(lens);
    const bad = await pullPrSession({ pr: 7, lens: "nohead" }, r.deps);
    expect(!bad.ok && bad.error).toContain("not a pi session");
  });

  it("parses a worker-layout lens path of the PR itself and no other", () => {
    const root = "/opt/qcr";
    const mine = `${root}/state/lens/pr-7/r2/lens-sessions/L1/x.jsonl`;
    const got = parseListing(
      [
        `lens 5 1 ${mine}`,
        `lens 5 1 ${root}/state/lens/pr-8/r2/lens-sessions/L1/x.jsonl`,
        `lens 5 1 ${root}/state/lens/pr-7/rx/lens-sessions/L1/x.jsonl`,
        `lens 5 1 ${root}/state/lens/pr-7/r2/lens-sessions/x.jsonl`,
      ].join("\n"),
      root,
      SESSION_DIR,
      7,
    );
    expect(got.map((l) => l.path)).toEqual([mine]);
  });
});

describe("[open-pr] an archived session", () => {
  const open: PrFixture[] = [];
  afterEach(() => {
    for (const f of open.splice(0)) f.close();
  });

  /** A closed PR whose three spawns are real pi sessions, archived and gone from the
   * live tree by the real archiver. */
  async function archived(): Promise<{ f: PrFixture; texts: string[] }> {
    const f = prFixture({ pr: 7 });
    open.push(f);
    const texts = f.transcripts.map((rel, i) => {
      const t = session(`spawn-${i}`, VM_CWD, TURNS.slice(0, i + 1));
      put(f.root, rel, t, f.mtimes.get(rel));
      return t;
    });
    const a = onArchiver(f);
    await a.tick();
    a.stop();
    expect(existsSync(join(f.root, f.transcripts[0]!))).toBe(false);
    return { f, texts };
  }

  it(
    "comes through the archive extract: the newest archived spawn, sha-verified, nothing written on the box",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      const { f, texts } = await archived();
      const before = snapshot(f.root);
      const r = rig(f.root);
      const got = await pullPrSession({ pr: 7 }, r.deps);
      expect(got.ok).toBe(true);
      if (!got.ok) return;
      expect(got.source).toBe("archive");
      expect(readFileSync(got.file, "utf8")).toBe(texts[2]);
      expect(got.file.endsWith(".jsonl")).toBe(true);
      expect(sessionIdOf(readFileSync(got.file, "utf8"))).toBe("spawn-2");
      expect(JSON.parse(readFileSync(join(got.dir, OPEN_PR_RECORD), "utf8")).source).toBe(
        "archive",
      );
      // the box's archive is exactly as the archiver left it
      expect(snapshot(f.root)).toEqual(before);
      for (const s of r.scripts) expect(s, s).not.toMatch(WRITES);
      // the scratch mirror went with the pull
      expect(readdirSync(join(r.home, "open")).filter((n) => n.startsWith("pull-"))).toEqual([]);
    },
  );

  it(
    "a gzip changed in transit does not verify, and opens nothing",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      const { f } = await archived();
      const gz = join(
        f.root,
        "archive",
        "pr-7",
        "transcripts",
        "nested",
        basename(f.transcripts[2]!) + ".gz",
      );
      const bytes = readFileSync(gz);
      // flip a bit in the middle, keeping the length the manifest records
      bytes[Math.floor(bytes.length / 2)]! ^= 0xff;
      chmodSync(gz, 0o644);
      writeFileSync(gz, bytes);
      utimesSync(gz, 1, 1);
      const r = rig(f.root);
      const got = await pullPrSession({ pr: 7 }, r.deps);
      expect(got.ok).toBe(false);
      expect(!got.ok && got.error).toContain("the archive extract failed");
      expect(existsSync(join(r.home, "open", "pr-7", "session"))).toBe(false);
      expect(readdirSync(join(r.home, "open")).filter((n) => n.startsWith("pull-"))).toEqual([]);
    },
  );
});

// ---- the verb ---------------------------------------------------------------------

describe("[open-pr] the verb", () => {
  let n2 = 0;
  function verb(over: Partial<OpenDeps> = {}) {
    const home = join(tmp, `verb${n2++}`);
    mkdirSync(home, { recursive: true });
    const calls = {
      out: [] as string[],
      pulled: [] as Array<{ pr: number; round?: number; lens?: string }>,
      spawned: [] as Array<{ bin: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv }>,
      copied: [] as boolean[],
    };
    const copy = join(home, "open", "pr-7");
    const file = join(copy, "session", "2026_s.jsonl");
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, session("sess-live", VM_CWD, TURNS));
    const d: OpenDeps = {
      detachedHome: join(home, "d"),
      runsDir: join(home, "r"),
      scanDir: join(home, "s"),
      root: ROOT,
      cwd: home,
      env: { PATH: "/usr/bin", GITHUB_TOKEN: "ghp_secret", GH_TOKEN: "ghp_other" },
      out: (l) => calls.out.push(l),
      fetchPr: async (o): Promise<PrPull> => {
        calls.pulled.push(o);
        return {
          ok: true,
          dir: copy,
          file,
          source: "live",
          kind: "main",
          bytes: 1,
          note: "copied",
        };
      },
      prepare: ({ roundDir, copyRound }) => {
        calls.copied.push(copyRound);
        return {
          agentDir: join(roundDir, "open-agent"),
          cwd: join(roundDir, "open-cwd"),
          cleanup: () => {},
        };
      },
      spawn: (cmd) => {
        calls.spawned.push(cmd);
        return 0;
      },
      ...over,
    };
    return { d, calls, file };
  }

  it("forks the pulled copy in pi with bash-guard alone and no GitHub token", async () => {
    const { d, calls, file } = verb();
    expect(await runOpen(["pr", "7", "--round", "2"], false, d)).toBe(0);
    expect(calls.pulled).toEqual([{ pr: 7, round: 2 }]);
    const cmd = calls.spawned[0]!;
    expect(cmd.args.slice(-2)).toEqual(["--fork", file]);
    expect(cmd.args).not.toContain("--session");
    const loaded = cmd.args.flatMap((a, i) =>
      cmd.args[i - 1] === "--extension"
        ? [a.slice(a.indexOf("/extensions/") + "/extensions/".length)]
        : [],
    );
    expect(loaded).toEqual(["cli/bash-guard.ts"]);
    expect([...BOT_OPEN_EXTENSIONS]).toEqual(["extensions/cli/bash-guard.ts"]);
    expect(cmd.args.join(" ")).not.toMatch(/post|inject|submit/i);
    expect(cmd.env["GITHUB_TOKEN"]).toBeUndefined();
    expect(cmd.env["GH_TOKEN"]).toBeUndefined();
    expect(calls.out).toContain("copied");
    // a fork works on a copy of what the round kept beside it
    expect(calls.copied).toEqual([true]);
  });

  it("--print shows the fork and starts nothing", async () => {
    const { d, calls, file } = verb();
    expect(await runOpen(["pr", "7", "--print"], false, d)).toBe(0);
    expect(calls.spawned).toEqual([]);
    expect(calls.out.join("\n")).toContain(`--fork ${file}`);
  });

  it("passes --lens through, and opens the lens as a leaf", async () => {
    const home = join(tmp, "lensverb");
    const lensFile = join(home, "open", "pr-7", "lens-sessions", "abc123", "x.jsonl");
    mkdirSync(dirname(lensFile), { recursive: true });
    writeFileSync(lensFile, session("lens-1", VM_CWD, TURNS.slice(0, 1)));
    const { d, calls } = verb({
      fetchPr: async (o) => {
        calls.pulled.push(o);
        return {
          ok: true,
          dir: join(home, "open", "pr-7"),
          file: lensFile,
          source: "live",
          kind: "lens",
          bytes: 1,
          note: "copied",
        };
      },
    });
    expect(await runOpen(["pr", "7", "--lens", "abc"], false, d)).toBe(0);
    expect(calls.pulled).toEqual([{ pr: 7, lens: "abc" }]);
    expect(calls.spawned[0]!.args.slice(-2)).toEqual(["--fork", lensFile]);
  });

  it("refuses --write (a copy has nothing to write back to), a bad number, and a stray --round", async () => {
    for (const argv of [
      ["pr", "7", "--write"],
      ["pr"],
      ["pr", "x"],
      ["pr", "7", "extra"],
      ["pr", "7", "--round", "0"],
      ["pr", "7", "--round", "1", "--lens", "a"],
      ["some-run", "--round", "1"],
    ]) {
      const { d, calls } = verb();
      expect(await runOpen(argv, false, d), argv.join(" ")).toBe(2);
      expect(calls.pulled).toEqual([]);
      expect(calls.spawned).toEqual([]);
    }
  });

  it("reports a pull that failed as exit 1, in JSON too", async () => {
    const { d, calls } = verb({
      fetchPr: async () => ({ ok: false, error: "pr-7 has no session on my-vm, live or archived" }),
    });
    expect(await runOpen(["pr", "7"], false, d)).toBe(1);
    expect(calls.out).toEqual(["✗ pr-7 has no session on my-vm, live or archived"]);
    const j = verb({ fetchPr: async () => ({ ok: false, error: "nope" }) });
    expect(await runOpen(["pr", "7", "--json"], false, j.d)).toBe(1);
    expect(JSON.parse(j.calls.out[0]!)).toEqual({ ok: false, errors: ["nope"] });
  });
});

// ---- the smoke: the real pi in a pty ----------------------------------------------

const hasScript = spawnSync("script", ["--version"], { encoding: "utf8" }).status === 0;
const q = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

describe.skipIf(!hasScript || process.platform !== "linux")(
  "[open-pr] smoke: the real pi CLI forks a pulled bot session in a pty",
  () => {
    let server: FakeOpenAI;
    beforeAll(async () => {
      server = await startFakeOpenAI();
    });
    afterAll(async () => {
      await server.close();
    });

    it("shows the bot's history, leaves the copy byte-for-byte, forks under a new id with the copy as parent, and the copy resumes under its own id", async () => {
      const dir = mkdtempSync(join(tmp, "smoke-"));
      // a bot session whose header cwd is the VM's, which does not exist here
      const text = session("bot-sess-1", VM_CWD, TURNS);
      const root = liveRoot(text);
      const r = rig(root);
      let screen = "";
      let forkDir = "";
      const prepared: Array<{ agentDir: string; cwd: string }> = [];
      const code = await runOpen(["pr", "7"], false, {
        detachedHome: join(dir, "d"),
        runsDir: join(dir, "r"),
        scanDir: join(dir, "s"),
        root: ROOT,
        cwd: dir,
        env: {
          ...process.env,
          PI_OFFLINE: "1",
          PI_TELEMETRY: "0",
          TERM: "xterm-256color",
          GITHUB_TOKEN: "ghp_smoke",
        },
        piBin: PI_BIN,
        out: () => {},
        fetchPr: (o) => pullPrSession(o, r.deps),
        prepare: ({ roundDir }) => {
          const agent = join(roundDir, "open-agent");
          const work = join(roundDir, "open-cwd");
          writeFakeProvider(agent, server.baseUrl);
          writeFileSync(join(agent, "auth.json"), "{}\n", { mode: 0o600 });
          mkdirSync(join(agent, "agents"), { recursive: true });
          mkdirSync(work, { recursive: true });
          writeFileSync(join(work, HOST_CONTEXT_STUB), readFileSync(join(ROOT, REVIEWER_STUB)));
          prepared.push({ agentDir: agent, cwd: work });
          return {
            agentDir: agent,
            cwd: work,
            cleanup: () => {
              // what the fork wrote is read before the private dir goes
              const sessions = join(agent, "sessions");
              if (existsSync(sessions)) forkDir = readFileSync(firstJsonl(sessions), "utf8");
              rmSync(agent, { recursive: true, force: true });
              rmSync(work, { recursive: true, force: true });
            },
          };
        },
        spawn: (cmd) =>
          new Promise<number>((done) => {
            const line = `stty cols 140 rows 50; exec ${[cmd.bin, ...cmd.args].map(q).join(" ")}`;
            const child = spawn("script", ["-qefc", line, "/dev/null"], {
              cwd: cmd.cwd,
              env: cmd.env,
              stdio: ["pipe", "pipe", "pipe"],
            });
            child.stdout.on("data", (b: Buffer) => (screen += b.toString()));
            const t0 = Date.now();
            const poll = setInterval(() => {
              // the fork's history is on screen once the last turn is
              if (screen.includes("answer to round three order") || Date.now() - t0 > 40_000) {
                clearInterval(poll);
                child.stdin.write("\x04");
                setTimeout(() => child.kill("SIGKILL"), 10_000);
              }
            }, 250);
            child.on("close", (c) => {
              clearInterval(poll);
              done(c ?? 1);
            });
          }),
      });
      expect(screen).toContain("answer to round three order");
      expect(screen).not.toMatch(/Extension error|Failed to load extension|does not exist/i);
      expect(code).toBe(0);
      // the copy is as pulled, and so is the box
      const copy = join(
        r.home,
        "open",
        "pr-7",
        "session",
        "2026-10-03T10-00-00-000Z_sess-live.jsonl",
      );
      expect(readFileSync(copy, "utf8")).toBe(text);
      // pi's fork: a session of its own under a new id, the copy as its parent
      const header = JSON.parse(forkDir.split("\n", 1)[0]!) as {
        id: string;
        parentSession?: string;
      };
      expect(header.id).not.toBe("bot-sess-1");
      expect(header.parentSession).toBe(copy);
      // nothing was sent to the model
      expect(server.requests).toHaveLength(0);
      // the copy of the login went with the open
      expect(existsSync(prepared[0]!.agentDir)).toBe(false);

      // the pulled copy resumes under the bot's own session id (the cache key)
      writeFakeProvider(join(dir, "resume-agent"), server.baseUrl);
      const host = await PiHost.create({ agentDir: join(dir, "resume-agent") });
      server.script([{ text: "back again" }]);
      try {
        const copy2 = join(dir, "resume-copy.jsonl");
        writeFileSync(copy2, readFileSync(copy));
        const rt = sdkRuntime(host);
        const resumed = await rt.resume(copy2, {
          cwd: dir,
          env: { PATH: process.env["PATH"] },
          model: FAKE_MODEL,
          eventsFile: join(dir, "resume-events.jsonl"),
          stderrFile: join(dir, "resume-stderr.log"),
          limits: { timeoutMs: 30_000 },
        });
        expect(resumed.id).toBe("bot-sess-1");
        await resumed.dispose();
      } finally {
        host.dispose();
      }
    }, 120_000);
  },
);

/** The first .jsonl under a directory tree. */
function firstJsonl(dir: string): string {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      try {
        return firstJsonl(p);
      } catch {
        // keep looking
      }
    } else if (e.name.endsWith(".jsonl")) return p;
  }
  throw new Error(`no session under ${dir}`);
}
