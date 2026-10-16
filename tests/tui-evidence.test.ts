// Finished-round evidence copied down to a local store the companion reads.
// The invariants under test: copy on completion (not on demand), never copy
// the same round twice, never let a wedged ssh become the TUI's problem, and
// grant the companion nothing.
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
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TUI_DEFAULTS, type TuiConfig } from "../src/config.js";
import type { StatusSnapshot } from "../src/state.js";
import {
  EVIDENCE_WHY_INTERVAL_DEFAULT_S,
  EVIDENCE_WHY_INTERVAL_MAX_S,
  EVIDENCE_WHY_INTERVAL_MIN_S,
  EvidenceCopier,
  EvidenceStore,
  MANIFEST_NAME,
  MAX_FILE_BYTES,
  SWEEP_PROGRESS_FILE,
  SweepProgressFile,
  archivedRole,
  evidenceWhyIntervalMs,
  fetchArgv,
  finishedRounds,
  manifestArgv,
  parseArchiveManifest,
  parseArchiveManifestLine,
  parseManifest,
  parseSweepProgress,
  prSignature,
  readWhyRounds,
  sweepHold,
  type SweepProgressStore,
  type WhyRound,
} from "../src/tui/evidence.js";
import type { RemoteResult, SshRunner } from "../src/tui/remote.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const CFG: TuiConfig = {
  ...TUI_DEFAULTS,
  ssh_host: "my-vm",
  container: "quickreview-sandbox",
  sudo_docker: true,
};
const ROOT = CFG.remote_sandbox_root;

const OK = (stdout: string): RemoteResult => ({ ok: true, stdout, stderr: "", code: 0 });
const FAIL: RemoteResult = { ok: false, stdout: "", stderr: "ssh: connect timed out", code: null };

function snapshot(prs: Array<Partial<StatusSnapshot["prs"][number]>>): StatusSnapshot {
  return {
    written_at: "2026-08-25T10:00:00Z",
    dry_run: false,
    prs: prs.map((p) => ({
      number: 5306,
      state: "reviewing",
      title: "t",
      head_sha: "abc",
      stale_recheck: false,
      rounds: 1,
      last_verdict: null,
      ...p,
    })) as StatusSnapshot["prs"],
    running_rounds: 0,
    total_spend_usd: 0,
    heartbeat: "2026-08-25T10:00:00Z",
  };
}

const round = (n: number, status = "done"): WhyRound => ({
  round_no: n,
  status,
  verdict: "APPROVE",
  finished_at: "2026-08-25T09:00:00Z",
});

/** A VM that answers everything: why → rounds, manifest → paths, cat → body. */
function fakeVm(
  rounds: WhyRound[],
  opts: { fail?: (script: string) => boolean } = {},
): {
  ssh: SshRunner;
  scripts: string[];
} {
  const scripts: string[] = [];
  const ssh: SshRunner = async (_host, argv) => {
    const script = argv.join(" ");
    scripts.push(script);
    if (opts.fail?.(script)) return FAIL;
    if (script.includes("cli.js") && script.includes("why"))
      return OK(JSON.stringify({ pr: 5306, rounds }));
    if (script.includes("head -c"))
      return OK(`body of ${/head -c \d+ '([^']+)'/.exec(script)![1]}`);
    if (script.includes("state/ledgers")) {
      // The manifest listing: report every artefact as present.
      const pr = /pr-(\d+)\.md/.exec(script)![1];
      const k = /round-(\d+)\.json/.exec(script)![1];
      return OK(
        [
          `transcript ${ROOT}/state/pi-sessions/pr-${pr}/2026-08-25.jsonl`,
          `ledger ${ROOT}/state/ledgers/pr-${pr}.md`,
          `prompt ${ROOT}/state/session-prompts/pr-${pr}.md`,
          `verdict ${ROOT}/verdict/processed/2026-08-25-pr-${pr}-round-${k}.json`,
        ].join("\n"),
      );
    }
    return FAIL;
  };
  return { ssh, scripts };
}

describe("evidence argv", () => {
  it("resolves the transcript and the verdict ON THE VM, never client-side", () => {
    const argv = manifestArgv(CFG, "state/pi-sessions", 5306, 2);
    expect(argv.slice(0, 5)).toEqual(["sudo", "docker", "exec", "quickreview-sandbox", "sh"]);
    const script = argv[argv.length - 1]!;
    // "newest JSONL in the session dir" and "verdict/ OR verdict/processed/"
    // are facts only the VM has; guessing either one client-side produces a
    // copier that works until the watcher moves a file.
    expect(script).toContain(`ls -1t "$r/state/pi-sessions/pr-5306"/*.jsonl`);
    expect(script).toContain(`$r/verdict/pr-5306-round-2.json`);
    expect(script).toContain(`verdict/processed/*pr-5306-round-2.json`);
    // A trailing `[ -f … ] && echo` that finds nothing exits non-zero and would
    // make a perfectly successful listing look like a transport failure.
    expect(script.trimEnd().endsWith("exit 0")).toBe(true);
  });

  it("caps every fetch remotely, so one runaway transcript cannot fill the disk", () => {
    const script = fetchArgv(CFG, `${ROOT}/state/ledgers/pr-1.md`, 1234).join(" ");
    expect(script).toContain(`head -c 1234 '${ROOT}/state/ledgers/pr-1.md'`);
  });

  it("refuses a listed path that is not plainly inside the sandbox root", () => {
    const files = parseManifest(
      [
        `transcript ${ROOT}/state/pi-sessions/pr-1/a.jsonl`,
        `ledger /etc/shadow`,
        `prompt ${ROOT}/x.md; rm -rf /`,
        `bogus ${ROOT}/y`,
        `verdict ${ROOT}/verdict/processed/2026-pr-1-round-1.json`,
      ].join("\n"),
      ROOT,
    );
    // The VM's answer becomes the next command's argument: a path is data,
    // never a fragment of script.
    expect(files.map((f) => f.role)).toEqual(["transcript", "verdict"]);
  });

  // `[]` is reserved for a payload that said there are no rounds.
  it("readWhyRounds: a payload without a round list is undefined — never []", () => {
    expect(readWhyRounds(JSON.stringify({ rounds: [] }))).toEqual([]);
    expect(readWhyRounds(JSON.stringify({ rounds: [round(2), round(1, "running")] }))).toEqual([
      round(2),
    ]);
    expect(readWhyRounds(JSON.stringify({ pr: 1, known: false }))).toBeUndefined();
    expect(readWhyRounds(JSON.stringify({ rounds: "none" }))).toBeUndefined();
    expect(readWhyRounds("null")).toBeUndefined();
    expect(readWhyRounds("{torn")).toBeUndefined();
  });

  it("copies dead rounds too — a round that died is the episode worth having", () => {
    const got = finishedRounds([round(3, "running"), round(1, "expired"), round(2, "cancelled")]);
    expect(got.map((r) => r.round_no)).toEqual([1, 2]); // sorted, running excluded
  });
});

describe("EvidenceCopier", () => {
  let dir: string;
  let store: EvidenceStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "qcr-evidence-"));
    store = new EvidenceStore(dir);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  // The default clock sits BEFORE the fixture rounds' finished_at (09:00), so
  // every round in these tests counts as finishing under the copier's watch —
  // the backfill rules get their own tests below.
  const copier = (
    ssh: SshRunner,
    notices: string[] = [],
    now = () => new Date("2026-08-25T08:00:00Z"),
  ): EvidenceCopier =>
    new EvidenceCopier(CFG, store, ssh, {
      sessionDir: "state/pi-sessions",
      timeoutMs: 1000,
      onNotice: (t) => notices.push(t),
      now,
    });

  it("copies a finished round's artefacts on the poll that notices it", async () => {
    const { ssh } = fakeVm([round(1)]);
    const notices: string[] = [];
    const report = await copier(ssh, notices).sweep(snapshot([{ number: 5306, rounds: 1 }]));

    expect(report.copied).toEqual(["evidence: pr-5306 round 1 copied (4 files)"]);
    const rd = store.roundDir(5306, 1);
    for (const f of ["session.jsonl", "ledger.md", "prompt.md", "verdict.json", MANIFEST_NAME]) {
      expect(existsSync(join(rd, f))).toBe(true);
    }
    const manifest = JSON.parse(readFileSync(join(rd, MANIFEST_NAME), "utf8"));
    expect(manifest.pr).toBe(5306);
    expect(manifest.missing).toEqual([]);
    // The round row rides along: verdict, status and timings, so the companion
    // never has to ask the VM what the transcript it is reading concluded.
    expect(manifest.round.verdict).toBe("APPROVE");
    expect(notices[0]).toContain("copied");
  });

  it("never copies the same round twice, and never re-fetches it", async () => {
    const { ssh, scripts } = fakeVm([round(1)]);
    const c = copier(ssh);
    const snap = snapshot([{ number: 5306, rounds: 1 }]);
    await c.sweep(snap);
    const afterFirst = scripts.length;
    await c.sweep(snap);
    // Unchanged snapshot signature ⇒ not even a `why` call: the steady state
    // costs the copier ZERO extra ssh.
    expect(scripts.length).toBe(afterFirst);

    // …and a FRESH copier (i.e. a TUI restart, which forgets everything
    // in-memory) still skips it, because the manifest on disk is the record.
    const restarted = copier(ssh);
    await restarted.sweep(snap);
    expect(scripts.length).toBe(afterFirst + 1); // one `why`, no fetches
    expect(scripts.slice(afterFirst).some((s) => s.includes("head -c"))).toBe(false);
  });

  it("picks up rounds finished while the TUI was down", async () => {
    const { ssh } = fakeVm([round(1), round(2)]);
    await copier(ssh).sweep(snapshot([{ number: 5306, rounds: 2 }]));
    expect(store.copiedRounds(5306)).toEqual([1, 2]);
  });

  it("degrades on a wedged ssh: no manifest, one notice, retried next poll", async () => {
    const notices: string[] = [];
    const flaky = { down: true };
    const { ssh } = fakeVm([round(1)], { fail: (s) => flaky.down && s.includes("head -c") });
    const c = copier(ssh, notices);
    const snap = snapshot([{ number: 5306, rounds: 1 }]);

    await c.sweep(snap);
    // A half-copy leaves NO manifest — that is the whole of the idempotence
    // story, and it is what makes the retry safe.
    expect(store.has(5306, 1)).toBe(false);
    // The notice carries the remote's own cause (status + last stderr line).
    expect(notices).toEqual([
      "evidence: pr-5306 round 1 — transcript fetch failed: no exit status — ssh: connect timed out",
    ]);

    // Still down: the failure is not announced again (a 3-second poll would
    // otherwise bury the notice line).
    await c.sweep(snap);
    expect(notices.length).toBe(1);

    flaky.down = false;
    await c.sweep(snap);
    expect(store.has(5306, 1)).toBe(true);
  });

  it("a round-list outage after a recovery is announced again", async () => {
    const notices: string[] = [];
    const vm = { down: true, rounds: [round(1)] };
    const ssh: SshRunner = async (h, a, o) =>
      vm.down && a.join(" ").includes("cli.js") ? FAIL : fakeVm(vm.rounds).ssh(h, a, o);
    const c = copier(ssh, notices);
    await c.sweep(snapshot([{ number: 5306, rounds: 1 }]));
    expect(notices.filter((n) => n.includes("round list"))).toHaveLength(1);
    vm.down = false;
    await c.sweep(snapshot([{ number: 5306, rounds: 1 }]));
    expect(store.has(5306, 1)).toBe(true);
    // A second round finishes; the VM goes away again while it is read.
    vm.down = true;
    vm.rounds = [round(1), round(2)];
    await c.sweep(snapshot([{ number: 5306, rounds: 2 }]));
    expect(notices.filter((n) => n.includes("round list"))).toHaveLength(2);
  });

  it("a PR whose rounds all expired is asked once — `why` still lists them", async () => {
    // The snapshot's count leaves expired rounds out: 1 while running, 0 once
    // the round expired.
    const vm = { rounds: [round(1, "running")] };
    const scripts: string[] = [];
    const ssh: SshRunner = async (h, a, o) => {
      scripts.push(a.join(" "));
      return fakeVm(vm.rounds).ssh(h, a, o);
    };
    const c = copier(ssh);
    await c.sweep(snapshot([{ number: 5306, rounds: 1 }]));
    expect(store.has(5306, 1)).toBe(false); // still running: nothing to copy
    vm.rounds = [round(1, "expired")];
    await c.sweep(snapshot([{ number: 5306, rounds: 0 }]));
    expect(store.has(5306, 1)).toBe(true);
    const whys = scripts.filter((x) => x.includes("cli.js")).length;
    await c.sweep(snapshot([{ number: 5306, rounds: 0 }]));
    expect(scripts.filter((x) => x.includes("cli.js")).length).toBe(whys); // asked once
  });

  it("a failed round leaves the PR unreconciled, so it is retried unchanged", async () => {
    const { ssh } = fakeVm([round(1)], { fail: (s) => s.includes("cli.js") });
    const c = copier(ssh);
    const snap = snapshot([{ number: 5306, rounds: 1 }]);
    await c.sweep(snap);
    await c.sweep(snap);
    expect(store.has(5306, 1)).toBe(false);
    // No throw, no rejection: the poll loop never learns anything went wrong.
  });

  // A degraded answer (valid JSON, no round list) is not "nothing to copy":
  // reading it so would retire the PR's signature, turning a transient failure
  // into a round that is never copied and never retried.
  it("a `why` answer with no round list is unreadable, not empty — the PR is retried, not retired", async () => {
    const inner = fakeVm([round(1)]);
    const degraded = { on: true };
    let whys = 0;
    const ssh: SshRunner = async (host, argv, opts) => {
      const script = argv.join(" ");
      if (script.includes("cli.js") && script.includes("why")) {
        whys += 1;
        if (degraded.on) return OK(JSON.stringify({ pr: 5306, error: "state.db is locked" }));
      }
      return inner.ssh(host, argv, opts);
    };
    const notices: string[] = [];
    const c = copier(ssh, notices);
    const snap = snapshot([{ number: 5306, rounds: 1 }]);

    await c.sweep(snap);
    await c.sweep(snap);
    // Two sweeps, two `why` calls: the signature was NOT retired on the
    // degraded answer, and the failure was announced once.
    expect(whys).toBe(2);
    expect(store.has(5306, 1)).toBe(false);
    expect(notices).toEqual(["evidence: #5306 — unreadable round list"]);

    degraded.on = false;
    await c.sweep(snap);
    expect(store.has(5306, 1)).toBe(true);
    await c.sweep(snap);
    expect(whys).toBe(3); // reconciled now — the steady state costs nothing
  });

  it("a permanently failing PR does not starve the others", async () => {
    // A failure does not retire the signature, so a sweep that stopped after
    // the first changed PR even when its reconcile failed would pick that PR
    // first every tick, forever.
    const { ssh } = fakeVm([round(1)], {
      fail: (s) => s.includes("head -c") && s.includes("pr-1/"),
    });
    const c = copier(ssh);
    const snap = snapshot([
      { number: 1, rounds: 1 },
      { number: 2, rounds: 1 },
    ]);
    await c.sweep(snap);
    expect(store.has(1, 1)).toBe(false); // still failing, retried next poll
    expect(store.has(2, 1)).toBe(true); // …but it no longer blocks the queue
  });

  it("bounds successful work to one PR per sweep", async () => {
    const { ssh } = fakeVm([round(1)]);
    const c = copier(ssh);
    await c.sweep(
      snapshot([
        { number: 1, rounds: 1 },
        { number: 2, rounds: 1 },
      ]),
    );
    // The healthy path is unchanged: one PR's copy per tick, the rest drain
    // on the following polls.
    expect(store.has(1, 1)).toBe(true);
    expect(store.has(2, 1)).toBe(false);
  });

  it("a backfilled round gets its verdict only — never today's ledger/prompt/transcript", async () => {
    // Ledger, prompt and the newest transcript are the PR's CURRENT files. A
    // backlog sweep that stamped them into an old round's dir would fabricate
    // that round's adjudication evidence.
    const { ssh } = fakeVm([round(1)]); // finished 09:00…
    const c = copier(ssh, [], () => new Date("2026-08-25T10:00:00Z")); // …first seen 10:00
    await c.sweep(snapshot([{ number: 5306, rounds: 1 }]));

    const rd = store.roundDir(5306, 1);
    expect(existsSync(join(rd, "verdict.json"))).toBe(true);
    for (const f of ["session.jsonl", "ledger.md", "prompt.md"])
      expect(existsSync(join(rd, f))).toBe(false);
    const manifest = JSON.parse(readFileSync(join(rd, MANIFEST_NAME), "utf8"));
    expect(manifest.skipped_stale.sort()).toEqual(["ledger", "prompt", "transcript"]);
    expect(manifest.missing).toEqual([]); // skipped is deliberate, not absent
    expect(manifest.files).toEqual([expect.objectContaining({ role: "verdict", scope: "round" })]);
  });

  it("a byte-capped multibyte transcript is recorded truncated — the cap is BYTES, not code units", async () => {
    // `head -c` cuts at MAX_FILE_BYTES bytes; the ssh runner hands back that
    // many bytes DECODED, which for two-byte UTF-8 is half as many code units.
    const capped = "é".repeat(MAX_FILE_BYTES / 2);
    const vm = fakeVm([round(1)]);
    const ssh: SshRunner = async (host, argv, opts) =>
      argv.join(" ").includes("head -c") && argv.join(" ").includes(".jsonl")
        ? OK(capped)
        : vm.ssh(host, argv, opts);
    await copier(ssh).sweep(snapshot([{ number: 5306, rounds: 1 }]));
    const manifest = JSON.parse(readFileSync(join(store.roundDir(5306, 1), MANIFEST_NAME), "utf8"));
    const byRole = Object.fromEntries(
      manifest.files.map((f: { role: string; truncated: boolean }) => [f.role, f.truncated]),
    );
    expect(byRole.transcript).toBe(true);
    expect(byRole.ledger).toBe(false);
  });

  it("a fresh round is copied whole, with every file's scope recorded", async () => {
    const { ssh } = fakeVm([round(1)]);
    await copier(ssh).sweep(snapshot([{ number: 5306, rounds: 1 }]));
    const manifest = JSON.parse(readFileSync(join(store.roundDir(5306, 1), MANIFEST_NAME), "utf8"));
    expect(manifest.roles_note).toContain("pr-current");
    expect(manifest.skipped_stale).toEqual([]);
    const scopes = Object.fromEntries(
      manifest.files.map((f: { role: string; scope: string }) => [f.role, f.scope]),
    );
    expect(scopes).toEqual({
      transcript: "pr-current",
      ledger: "pr-current",
      prompt: "pr-current",
      verdict: "round",
    });
  });

  it("a sweep already in flight makes the next call a no-op", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => (release = r));
    const inner = fakeVm([round(1)]).ssh;
    const slow: SshRunner = async (h, a, o) => {
      await gate;
      return inner(h, a, o);
    };
    const c = copier(slow);
    const snap = snapshot([{ number: 5306, rounds: 1 }]);
    const first = c.sweep(snap);
    expect(c.running).toBe(true);
    expect(await c.sweep(snap)).toEqual({ copied: [], failures: [] }); // no stacking
    release!();
    await first;
    expect(store.has(5306, 1)).toBe(true);
  });

  it("a PR with no rounds costs nothing at all", async () => {
    const { ssh, scripts } = fakeVm([]);
    await copier(ssh).sweep(snapshot([{ number: 1, rounds: 0 }]));
    expect(scripts).toEqual([]);
  });

  it("re-reads a PR only when its snapshot signature moves", () => {
    const a = snapshot([{ number: 5306, rounds: 1, last_verdict: null }]).prs[0]!;
    const b = snapshot([{ number: 5306, rounds: 2, last_verdict: null }]).prs[0]!;
    const c = snapshot([{ number: 5306, rounds: 1, last_verdict: "APPROVE" }]).prs[0]!;
    expect(prSignature(a)).toBe(prSignature({ ...a }));
    expect(prSignature(a)).not.toBe(prSignature(b));
    expect(prSignature(a)).not.toBe(prSignature(c));
  });
});

describe("the store's home", () => {
  it("is gitignored wherever it is put", () => {
    // Kept indefinitely and unbounded: private-repo transcripts must never be
    // one `git add -A` away from a commit.
    // Root-anchored: a bare `evidence/` would also ignore
    // skills/companion/evidence/ and silently drop that skill from a commit.
    expect(readFileSync(join(repoRoot, ".gitignore"), "utf8")).toMatch(/^\/evidence\/$/m);
  });

  it("the copier is wired to the EXISTING poll, with no scheduler of its own", () => {
    const index = readFileSync(join(repoRoot, "src/tui/index.ts"), "utf8");
    expect(index).toContain("new EvidenceCopier(");
    expect(index).toMatch(/chainOnPoll\(app, \(a\) => \{\s*void evidenceCopier\.sweep/);
    expect(index).not.toMatch(/setInterval\([^)]*evidence/i);
  });

  it("grants the companion no reach — it reads a read-only mount", () => {
    const companion = readFileSync(join(repoRoot, "src/tui/companion.ts"), "utf8");
    // The mount spec runArgv() turns into `--volume <src>:<dest>:<mode>`.
    expect(companion).toContain(
      '{ dest: CONTAINER.evidence, source: this.cfg.evidence_dir, mode: "ro" }',
    );
    // Rule 8 is structural: nothing in the transport hands the container ssh.
    expect(companion).not.toMatch(/evidence[^\n]*ssh/i);
  });
});

describe("large and awkward payloads", () => {
  it("writes exactly what the VM returned, byte for byte", () => {
    // The transcript is UTF-8 with box drawing and emoji; a chunked read that
    // splits a multi-byte sequence would corrupt it (why realSshRunner decodes
    // with a StringDecoder rather than per-chunk toString).
    const remote = readFileSync(join(repoRoot, "src/tui/remote.ts"), "utf8");
    expect(remote).toContain("StringDecoder");
    expect(remote).not.toMatch(/stdout \+= d\.toString\(\)/);

    const dir = mkdtempSync(join(tmpdir(), "qcr-evidence-"));
    try {
      const store = new EvidenceStore(dir);
      const body = '├─ pass-intent ✅ 🎉\n{"a":1}\n';
      store.writeArtifact(7, 1, "transcript", body);
      expect(readFileSync(join(store.roundDir(7, 1), "session.jsonl"), "utf8")).toBe(body);
      // No manifest yet ⇒ not copied. A reader must never mistake a partial
      // copy for a complete one.
      expect(store.has(7, 1)).toBe(false);
      writeFileSync(join(store.roundDir(7, 1), MANIFEST_NAME), "{}");
      expect(store.has(7, 1)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---- the sweep keeps its progress, and its pace -----------------------------
//
// The sweep's signature map is persisted: held only in memory, every TUI
// re-exec (every local `dist/` rebuild, every deploy) would re-run
// `qcr why <n> --json` for every PR, one every few seconds for many minutes —
// a steady CPU cost on the container exactly when drained rounds resume.

/** A clock the test moves by hand, starting BEFORE the fixture rounds'
 * finished_at (09:00) and the snapshot's heartbeat (10:00), as the copier
 * tests above do — so every round is fresh and the heartbeat is not stale. */
function handClock(start = "2026-08-25T08:00:00Z"): {
  now: () => Date;
  advance: (s: number) => void;
  ms: () => number;
} {
  let t = Date.parse(start);
  return { now: () => new Date(t), advance: (s) => void (t += s * 1000), ms: () => t };
}

const isWhy = (script: string): boolean => script.includes("cli.js") && script.includes(" why ");
const whyPr = (script: string): number => Number(/ why (\d+) /.exec(script)![1]);

describe("the sweep's progress survives a re-exec", () => {
  let dir: string;
  let store: EvidenceStore;
  let recordPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "qcr-evidence-l1-"));
    store = new EvidenceStore(join(dir, "evidence"));
    recordPath = join(dir, "state", SWEEP_PROGRESS_FILE);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const copier = (
    ssh: SshRunner,
    opts: {
      notices?: string[];
      progress?: SweepProgressStore;
      whyIntervalMs?: number;
      now?: () => Date;
    } = {},
  ): EvidenceCopier =>
    new EvidenceCopier(CFG, store, ssh, {
      sessionDir: "state/pi-sessions",
      timeoutMs: 1000,
      onNotice: (t) => opts.notices?.push(t),
      now: opts.now ?? (() => new Date("2026-08-25T08:00:00Z")),
      progress: opts.progress ?? new SweepProgressFile(recordPath),
      ...(opts.whyIntervalMs !== undefined ? { whyIntervalMs: opts.whyIntervalMs } : {}),
    });

  const THREE = snapshot([
    { number: 1, rounds: 1 },
    { number: 2, rounds: 1 },
    { number: 3, rounds: 1 },
    { number: 4, rounds: 0 },
  ]);

  async function reconcileAll(c: EvidenceCopier, snap = THREE): Promise<void> {
    for (let i = 0; i < 5; i++) await c.sweep(snap);
  }

  it("a restarted copier resumes: a PR reconciled before the re-exec costs no `why` after it", async () => {
    const { ssh, scripts } = fakeVm([round(1)]);
    await reconcileAll(copier(ssh));
    expect([1, 2, 3].every((pr) => store.has(pr, 1))).toBe(true);

    // The record is on disk, written whole, and names the store it is about.
    const record = JSON.parse(readFileSync(recordPath, "utf8"));
    expect(record.version).toBe(1);
    expect(record.store_dir).toBe(store.dir);
    expect(Object.keys(record.reconciled)).toEqual(["1", "2", "3", "4"]);
    // Each entry says whether the store held the PR's evidence once it was
    // reconciled — the zero-round PR never had any.
    expect(record.reconciled["1"]).toEqual({ sig: prSignature(THREE.prs[0]!), stored: true });
    expect(record.reconciled["4"]).toEqual({ sig: prSignature(THREE.prs[3]!), stored: false });
    expect(readdirSync(join(dir, "state")).filter((f) => f.includes(".tmp"))).toEqual([]);

    // The re-exec: a NEW copier over the same record re-polls nothing at all.
    const before = scripts.length;
    const notices: string[] = [];
    const report = await copier(ssh, { notices }).sweep(THREE);
    expect(scripts.slice(before)).toEqual([]);
    expect(report).toEqual({ copied: [], failures: [] });
    expect(notices).toEqual([]); // a clean resume is not news

    // …and a PR whose signature moved since is re-polled — that one only.
    const moved = snapshot([
      { number: 1, rounds: 1 },
      { number: 2, rounds: 1, last_verdict: "APPROVE" },
      { number: 3, rounds: 1 },
      { number: 4, rounds: 0 },
    ]);
    await copier(ssh).sweep(moved);
    expect(scripts.slice(before).filter(isWhy).map(whyPr)).toEqual([2]);
  });

  it("an unreadable record is treated as EMPTY with a notice — never as all reconciled", async () => {
    const { ssh, scripts } = fakeVm([round(1)]);
    await reconcileAll(copier(ssh)); // the evidence is all on disk…
    writeFileSync(recordPath, "{torn"); // …but the record of it is not readable

    const notices: string[] = [];
    const c = copier(ssh, { notices });
    const before = scripts.length;
    await reconcileAll(c);
    // Every PR with rounds is re-checked (one `why` each — the manifests on
    // disk mean nothing is fetched again)…
    expect(
      scripts
        .slice(before)
        .filter(isWhy)
        .map(whyPr)
        .sort((a, b) => a - b),
    ).toEqual([1, 2, 3]);
    expect(scripts.slice(before).some((s) => s.includes("head -c"))).toBe(false);
    // …the operator is told once, and the record is replaced by a readable one.
    expect(notices.filter((n) => n.includes("unreadable"))).toEqual([
      expect.stringMatching(
        /^evidence: sweep progress record unreadable \(not JSON .*\) — re-checking every PR$/,
      ),
    ]);
    expect(new SweepProgressFile(recordPath).read(store.dir).kind).toBe("read");
  });

  it("a record that is not a file at all (EISDIR) is unreadable, not absent", () => {
    mkdirSync(recordPath, { recursive: true });
    const read = new SweepProgressFile(recordPath).read(store.dir);
    expect(read.kind).toBe("unreadable");
  });

  it("no record (the first start) is quietly empty", async () => {
    expect(new SweepProgressFile(recordPath).read(store.dir)).toEqual({ kind: "absent" });
    const { ssh } = fakeVm([round(1)]);
    const notices: string[] = [];
    await copier(ssh, { notices }).sweep(snapshot([{ number: 1, rounds: 1 }]));
    expect(notices).toEqual(["evidence: pr-1 round 1 copied (4 files)"]);
  });

  it("parseSweepProgress: strict — one bad entry makes the whole record unreadable", () => {
    const ok = (reconciled: unknown, extra: Record<string, unknown> = {}) =>
      JSON.stringify({ version: 1, store_dir: "/s", updated_at: "x", reconciled, ...extra });
    const entry = { sig: "1//tracked/abc", stored: true };
    expect(
      parseSweepProgress(ok({ "5306": entry, "7": { sig: "0//new/x", stored: false } }), "/s"),
    ).toEqual({
      kind: "read",
      reconciled: new Map([
        [5306, entry],
        [7, { sig: "0//new/x", stored: false }],
      ]),
    });
    for (const bad of [
      ok({ abc: entry }),
      ok({ "0": entry }),
      ok({ "12": "1//tracked/abc" }),
      ok({ "12": 7 }),
      ok({ "12": null }),
      ok({ "12": [entry] }),
      ok({ "12": { sig: "", stored: true } }),
      ok({ "12": { sig: 7, stored: true } }),
      ok({ "12": { sig: "1//tracked/abc" } }),
      ok({ "12": { sig: "1//tracked/abc", stored: "yes" } }),
      ok({ "12": entry, "13": { stored: false } }),
      ok([entry]),
      ok({}, { version: 2 }),
      ok({}, { store_dir: 7 }),
      JSON.stringify([]),
      "null",
      "{torn",
    ])
      expect(parseSweepProgress(bad, "/s").kind, bad).toBe("unreadable");
  });

  it("a record about ANOTHER store is not believed (evidence_dir moved)", async () => {
    new SweepProgressFile(recordPath).write(
      join(dir, "elsewhere"),
      new Map([
        [1, { sig: prSignature(snapshot([{ number: 1, rounds: 1 }]).prs[0]!), stored: true }],
      ]),
      new Date(),
    );
    const { ssh, scripts } = fakeVm([round(1)]);
    const notices: string[] = [];
    await copier(ssh, { notices }).sweep(snapshot([{ number: 1, rounds: 1 }]));
    expect(scripts.filter(isWhy).map(whyPr)).toEqual([1]);
    expect(store.has(1, 1)).toBe(true);
    expect(notices[0]).toMatch(
      /^evidence: sweep progress record is for another store \(.*elsewhere\)/,
    );
  });

  it("a record cannot vouch for evidence that is no longer on disk", async () => {
    const { ssh, scripts } = fakeVm([round(1)]);
    await reconcileAll(copier(ssh));
    rmSync(join(store.dir, "pr-2"), { recursive: true, force: true });

    const notices: string[] = [];
    const before = scripts.length;
    await reconcileAll(copier(ssh, { notices }));
    // Only the PR whose evidence vanished is re-checked; the zero-round PR
    // (its entry says the store held nothing, so it never had a dir) is still
    // believed.
    expect(scripts.slice(before).filter(isWhy).map(whyPr)).toEqual([2]);
    expect(store.has(2, 1)).toBe(true);
    expect(notices[0]).toBe(
      "evidence: 1 PR in the sweep record has no evidence on disk — re-checking it",
    );
  });

  it("a record that cannot be saved costs one notice, never the sweep", async () => {
    let writes = 0;
    const broken: SweepProgressStore = {
      read: () => ({ kind: "absent" }),
      write: () => {
        writes += 1;
        throw new Error("EROFS: read-only file system");
      },
    };
    const { ssh } = fakeVm([round(1)]);
    const notices: string[] = [];
    const c = copier(ssh, { notices, progress: broken });
    await reconcileAll(c);
    expect([1, 2, 3].every((pr) => store.has(pr, 1))).toBe(true);
    expect(writes).toBeGreaterThan(1); // retried at the next sweep…
    expect(notices.filter((n) => n.includes("not saved"))).toEqual([
      "evidence: sweep progress not saved (EROFS: read-only file system) — a restart re-checks every PR",
    ]); // …announced once
  });

  it("only a clean reconcile is recorded — a failed PR is not in the record", async () => {
    const { ssh } = fakeVm([round(1)], {
      fail: (s) => s.includes("head -c") && s.includes("pr-2/"),
    });
    await reconcileAll(copier(ssh));
    const record = JSON.parse(readFileSync(recordPath, "utf8"));
    expect(Object.keys(record.reconciled)).toEqual(["1", "3", "4"]);
  });

  it("a PR whose rounds were all still RUNNING is believed after a re-exec: no `why`, no false alarm", async () => {
    // A clean reconcile that copied nothing leaves no `pr-<n>` dir — and a
    // missing dir is then not lost evidence, so every re-exec while a first
    // round is in flight must not re-check the PR and say evidence is gone.
    const rounds = [round(1, "running")];
    const { ssh, scripts } = fakeVm(rounds);
    const snap = snapshot([{ number: 1, rounds: 1 }]);
    await copier(ssh).sweep(snap);
    expect(store.hasPr(1)).toBe(false);
    expect(JSON.parse(readFileSync(recordPath, "utf8")).reconciled["1"]).toEqual({
      sig: prSignature(snap.prs[0]!),
      stored: false,
    });

    const before = scripts.length;
    const notices: string[] = [];
    for (let i = 0; i < 3; i++) await copier(ssh, { notices }).sweep(snap); // three re-execs
    expect(scripts.slice(before)).toEqual([]);
    expect(notices).toEqual([]);

    // The round finishes: the signature moves and the PR is read again.
    rounds[0] = round(1);
    await copier(ssh).sweep(snapshot([{ number: 1, rounds: 1, last_verdict: "APPROVE" }]));
    expect(store.has(1, 1)).toBe(true);
  });

  it("the record is replaced atomically: a write that fails leaves the previous record whole", () => {
    const file = new SweepProgressFile(recordPath);
    const first = new Map([[1, { sig: "1//tracked/a", stored: true }]]);
    file.write(store.dir, first, new Date());
    // The temp name is taken (a directory sits there), so the write fails
    // before the rename — and a direct write over the record would not have.
    mkdirSync(`${recordPath}.tmp-${process.pid}`);
    expect(() =>
      file.write(store.dir, new Map([[2, { sig: "1//tracked/b", stored: true }]]), new Date()),
    ).toThrow();
    expect(file.read(store.dir)).toEqual({ kind: "read", reconciled: first });
  });

  it("an unchanged record is not rewritten — the steady state costs no disk write", async () => {
    const file = new SweepProgressFile(recordPath);
    let writes = 0;
    const counting: SweepProgressStore = {
      read: (s) => file.read(s),
      write: (s, r, at) => {
        writes += 1;
        file.write(s, r, at);
      },
    };
    const { ssh } = fakeVm([round(1)]);
    const c = copier(ssh, { progress: counting });
    await reconcileAll(c);
    const settled = writes;
    expect(settled).toBeGreaterThan(0);
    await c.sweep(THREE);
    await c.sweep(THREE);
    expect(writes).toBe(settled);
  });

  it("a save that fails, then succeeds, then fails again is announced again", async () => {
    const state = { broken: true };
    const flaky: SweepProgressStore = {
      read: () => ({ kind: "absent" }),
      write: () => {
        if (state.broken) throw new Error("ENOSPC: no space left on device");
      },
    };
    const { ssh } = fakeVm([]);
    const notices: string[] = [];
    const c = copier(ssh, { notices, progress: flaky });
    // Zero-round PRs whose signature moves each sweep: every sweep has a
    // change to save, and none needs a `why`.
    const at = (sha: string) => snapshot([{ number: 1, rounds: 0, head_sha: sha }]);
    await c.sweep(at("a")); // fails — announced
    await c.sweep(at("b")); // fails — quiet
    state.broken = false;
    await c.sweep(at("c")); // saved — the announcement is reset
    state.broken = true;
    await c.sweep(at("d")); // fails — announced again
    expect(notices.filter((n) => n.includes("not saved"))).toHaveLength(2);
  });

  describe("a record the copier does not believe is replaced even when nothing is retired", () => {
    // The first sweep after loading it is HELD (a drain), so no PR is
    // reconciled and nothing else makes the record dirty.
    const held = { ...THREE, draining: true };

    it("an unreadable record", async () => {
      mkdirSync(dirname(recordPath), { recursive: true });
      writeFileSync(recordPath, "{torn");
      const report = await copier(fakeVm([]).ssh).sweep(held);
      expect(report.held).toBe("draining");
      expect(new SweepProgressFile(recordPath).read(store.dir)).toEqual({
        kind: "read",
        reconciled: new Map(),
      });
    });

    it("another store's record", async () => {
      new SweepProgressFile(recordPath).write(
        join(dir, "elsewhere"),
        new Map([[1, { sig: "1//tracked/abc", stored: true }]]),
        new Date(),
      );
      await copier(fakeVm([]).ssh).sweep(held);
      expect(new SweepProgressFile(recordPath).read(store.dir)).toEqual({
        kind: "read",
        reconciled: new Map(),
      });
    });

    it("a record vouching for evidence that is gone", async () => {
      const { ssh } = fakeVm([round(1)]);
      await reconcileAll(copier(ssh));
      rmSync(join(store.dir, "pr-2"), { recursive: true, force: true });
      await copier(ssh).sweep(held);
      const read = new SweepProgressFile(recordPath).read(store.dir);
      expect(read.kind === "read" && [...read.reconciled.keys()]).toEqual([1, 3, 4]);
    });
  });
});

describe("the sweep is paced, and held while the daemon is busy", () => {
  let dir: string;
  let store: EvidenceStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "qcr-evidence-pace-"));
    store = new EvidenceStore(dir);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const build = (
    ssh: SshRunner,
    clock: ReturnType<typeof handClock>,
    extra: { progress?: SweepProgressStore } = {},
  ): EvidenceCopier =>
    new EvidenceCopier(CFG, store, ssh, {
      sessionDir: "state/pi-sessions",
      timeoutMs: 1000,
      now: clock.now,
      whyIntervalMs: 10_000,
      ...extra,
    });

  /** A paced copier built one interval ago: its pace starts at construction
   * (tested on its own below), so the clock is moved past that first wait and
   * the test starts where a `why` is due. */
  const paced = (ssh: SshRunner, clock: ReturnType<typeof handClock>): EvidenceCopier => {
    const c = build(ssh, clock);
    clock.advance(10);
    return c;
  };

  /** The VM, with each `why` taking `whyS` seconds of the hand clock. */
  function slowWhyVm(
    clock: ReturnType<typeof handClock>,
    whyS: number,
    rounds: WhyRound[] = [round(1)],
    fail?: (script: string) => boolean,
  ): { ssh: SshRunner; whys: number[]; scripts: string[] } {
    const inner = fakeVm(rounds, fail ? { fail } : {});
    const whys: number[] = [];
    const ssh: SshRunner = async (host, argv, opts) => {
      const script = argv.join(" ");
      if (isWhy(script)) {
        whys.push(whyPr(script));
        clock.advance(whyS);
      }
      return inner.ssh(host, argv, opts);
    };
    return { ssh, whys, scripts: inner.scripts };
  }

  const PRS = snapshot([
    { number: 1, rounds: 1 },
    { number: 2, rounds: 1 },
    { number: 3, rounds: 1 },
  ]);

  it("at most one `why` per interval, measured from the END of the last — whatever the poll cadence", async () => {
    const clock = handClock();
    const { ssh, whys } = slowWhyVm(clock, 4); // a starved container: 4 s a `why`
    const c = paced(ssh, clock);

    await c.sweep(PRS); // t=0: one `why` (ends at t=4)
    expect(whys).toEqual([1]);

    // The 3-second poll keeps calling; nothing runs until 10 s after t=4.
    for (const t of [3, 3, 3]) {
      clock.advance(t); // t=7, 10, 13
      const report = await c.sweep(PRS);
      expect(report.paced).toBe(true);
    }
    expect(whys).toEqual([1]);
    clock.advance(1); // t=14 = 4 + 10
    await c.sweep(PRS);
    expect(whys).toEqual([1, 2]);
  });

  it("a `why` that FAILS at the ssh is paced too, measured from its end — a wedged ssh cannot burst", async () => {
    const clock = handClock();
    // PR 1's `why` itself fails, after 4 s (a starved container timing out).
    const { ssh, whys } = slowWhyVm(clock, 4, [round(1)], (s) => isWhy(s) && whyPr(s) === 1);
    const c = paced(ssh, clock);
    await c.sweep(PRS); // t=0: PR 1's `why` fails at t=4 — and the sweep stops there
    expect(whys).toEqual([1]);
    clock.advance(9); // t=13
    expect((await c.sweep(PRS)).paced).toBe(true);
    expect(whys).toEqual([1]);
    clock.advance(1); // t=14 = 4 + 10: the rotation has moved past PR 1
    await c.sweep(PRS);
    expect(whys).toEqual([1, 2]);
  });

  it("a PR failing at the FETCH waits its turn in the rotation under pacing", async () => {
    const clock = handClock();
    // PR 1 fails at the fetch every time; 2 and 3 are healthy.
    const { ssh, whys } = slowWhyVm(
      clock,
      0,
      [round(1)],
      (s) => s.includes("head -c") && s.includes("pr-1/"),
    );
    const c = paced(ssh, clock);
    for (let i = 0; i < 4; i++) {
      const before = whys.length;
      await c.sweep(PRS);
      expect(whys.length - before).toBeLessThanOrEqual(1); // never two in one sweep
      clock.advance(10);
    }
    // 1 failed → the rotation moved on to 2, then 3, and only THEN back to 1.
    expect(whys).toEqual([1, 2, 3, 1]);
    expect(store.has(2, 1)).toBe(true);
    expect(store.has(3, 1)).toBe(true);
    expect(store.has(1, 1)).toBe(false); // still failing, still retried
  });

  it("a PR with a backlog keeps its turn until it drains (one PR's work per sweep)", async () => {
    const clock = handClock();
    const five = [1, 2, 3, 4, 5].map((n) => round(n));
    const { ssh, whys } = slowWhyVm(clock, 0, five);
    const c = paced(ssh, clock);
    const snap = snapshot([
      { number: 1, rounds: 5 },
      { number: 2, rounds: 5 },
    ]);
    await c.sweep(snap); // PR 1 rounds 1–3
    clock.advance(10);
    await c.sweep(snap); // PR 1 rounds 4–5, reconciled
    expect(store.copiedRounds(1)).toEqual([1, 2, 3, 4, 5]);
    expect(store.copiedRounds(2)).toEqual([]);
    clock.advance(10);
    await c.sweep(snap);
    expect(whys).toEqual([1, 1, 2]);
  });

  it("zero-round PRs are retired without a `why`, whatever the pace says", async () => {
    const clock = handClock();
    const { ssh, whys } = slowWhyVm(clock, 0);
    const c = paced(ssh, clock);
    await c.sweep(snapshot([{ number: 1, rounds: 1 }]));
    // Inside the interval: the new zero-round PRs cost nothing and wait for nothing.
    await c.sweep(
      snapshot([
        { number: 1, rounds: 1 },
        { number: 7, rounds: 0 },
        { number: 8, rounds: 0 },
      ]),
    );
    expect(whys).toEqual([1]);
  });

  it("no `why` at all while the board's last status shows the daemon DRAINING", async () => {
    const clock = handClock();
    const { ssh, scripts } = slowWhyVm(clock, 0);
    const c = paced(ssh, clock);
    const draining = { ...PRS, draining: true };
    const report = await c.sweep(draining);
    expect(report.held).toBe("draining");
    expect(scripts).toEqual([]);
    // The drain lifts: the sweep resumes on the next poll.
    clock.advance(3);
    await c.sweep(PRS);
    expect(scripts.filter(isWhy).map(whyPr)).toEqual([1]);
  });

  it("no `why` at all while the heartbeat is stale (older than [tui] stale_after_s)", async () => {
    // The snapshot's heartbeat is 10:00:00; stale_after_s is 90. `paced`
    // moves each clock 10 s on, so these sweep at 10:01:31 and 10:01:30.
    const at = (iso: string) => handClock(iso);
    const stale = at("2026-08-25T10:01:21Z");
    const vm = slowWhyVm(stale, 0);
    expect((await paced(vm.ssh, stale).sweep(PRS)).held).toBe("heartbeat-stale");
    expect(vm.scripts).toEqual([]);

    const edge = at("2026-08-25T10:01:20Z");
    const vm2 = slowWhyVm(edge, 0);
    expect((await paced(vm2.ssh, edge).sweep(PRS)).held).toBeUndefined();
    expect(vm2.scripts.filter(isWhy)).toHaveLength(1);
  });

  it("the pace holds across a re-exec: a new copier waits one interval from its construction", async () => {
    // Every local build re-execs the TUI and builds a new copier. A PR that
    // always fails stays pending in every generation — a generation that
    // could fire at once would send its `why` on every build.
    const clock = handClock();
    const recordPath = join(dir, "state", SWEEP_PROGRESS_FILE);
    const progress = new SweepProgressFile(recordPath);
    const { ssh, whys } = slowWhyVm(clock, 0, [round(1)], (s) => isWhy(s) && whyPr(s) === 1);
    const one = snapshot([{ number: 1, rounds: 1 }]);

    const first = build(ssh, clock, { progress });
    expect((await first.sweep(one)).paced).toBe(true); // not even the first at once
    clock.advance(10);
    await first.sweep(one);
    expect(whys).toEqual([1]);

    // Builds every 3 s, each a fresh generation over the same record: none of
    // them sends a `why` inside its first interval.
    for (let i = 0; i < 3; i++) {
      const next = build(ssh, clock, { progress });
      expect((await next.sweep(one)).paced).toBe(true);
      clock.advance(3);
    }
    expect(whys).toEqual([1]);

    const settled = build(ssh, clock, { progress });
    clock.advance(10);
    await settled.sweep(one);
    expect(whys).toEqual([1, 1]);
  });

  it("an UNPACED copier (the unit harness) asks at once — only a paced one waits at construction", async () => {
    const clock = handClock();
    const { ssh, whys } = slowWhyVm(clock, 0);
    const c = new EvidenceCopier(CFG, store, ssh, {
      sessionDir: "state/pi-sessions",
      timeoutMs: 1000,
      now: clock.now,
    });
    await c.sweep(snapshot([{ number: 1, rounds: 1 }]));
    expect(whys).toEqual([1]);
  });

  it("sweepHold: a heartbeat that cannot be read is not fresh; one AHEAD of this clock is skew, not staleness", () => {
    const now = Date.parse("2026-08-25T10:00:00Z");
    const snap = (patch: Partial<StatusSnapshot>) => ({ ...PRS, ...patch }) as StatusSnapshot;
    expect(sweepHold(snap({ heartbeat: "2026-08-25T10:00:00Z" }), now, 90)).toBeUndefined();
    expect(sweepHold(snap({ heartbeat: "2026-08-25T10:05:00Z" }), now, 90)).toBeUndefined();
    expect(sweepHold(snap({ heartbeat: "not a date" }), now, 90)).toBe("heartbeat-stale");
    expect(sweepHold({ ...PRS, heartbeat: undefined } as unknown as StatusSnapshot, now, 90)).toBe(
      "heartbeat-stale",
    );
    expect(sweepHold(snap({ draining: false }), now, 90)).toBeUndefined();
    expect(sweepHold(snap({ draining: true }), now, 90)).toBe("draining");
  });

  it("the interval knob is bounded: default ≥ 10 s, clamped, and pacing cannot be switched off", () => {
    expect(EVIDENCE_WHY_INTERVAL_DEFAULT_S).toBeGreaterThanOrEqual(10);
    expect(TUI_DEFAULTS.evidence_why_interval_s).toBe(EVIDENCE_WHY_INTERVAL_DEFAULT_S);
    expect(evidenceWhyIntervalMs(TUI_DEFAULTS)).toBe(10_000);
    expect(evidenceWhyIntervalMs({ evidence_why_interval_s: 30 })).toBe(30_000);
    expect(evidenceWhyIntervalMs({ evidence_why_interval_s: 0 })).toBe(
      EVIDENCE_WHY_INTERVAL_MIN_S * 1000,
    );
    expect(evidenceWhyIntervalMs({ evidence_why_interval_s: -5 })).toBe(
      EVIDENCE_WHY_INTERVAL_MIN_S * 1000,
    );
    expect(evidenceWhyIntervalMs({ evidence_why_interval_s: 1e9 })).toBe(
      EVIDENCE_WHY_INTERVAL_MAX_S * 1000,
    );
    // A TOML typo ("10") or a missing key in an older config is the default.
    for (const bad of ["10", undefined, Number.NaN])
      expect(evidenceWhyIntervalMs({ evidence_why_interval_s: bad as unknown as number })).toBe(
        EVIDENCE_WHY_INTERVAL_DEFAULT_S * 1000,
      );
  });

  it("the TUI wires both: the paced interval from config and the record beside its state files", () => {
    const index = readFileSync(join(repoRoot, "src/tui/index.ts"), "utf8");
    const wiring = /new EvidenceCopier\(cfg, evidence, runner, \{([\s\S]*?)\n {2}\}\);/.exec(
      index,
    )?.[1];
    expect(wiring).toBeDefined();
    expect(wiring).toContain("whyIntervalMs: evidenceWhyIntervalMs(cfg)");
    expect(wiring).toContain(
      'progress: new SweepProgressFile(join(sandboxRoot(), "state", SWEEP_PROGRESS_FILE))',
    );
  });
});

describe("a round that finished during a hold is a backfill", () => {
  let dir: string;
  let store: EvidenceStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "qcr-evidence-hold-"));
    store = new EvidenceStore(dir);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const done = (n: number, finishedAt: string): WhyRound => ({
    round_no: n,
    status: "done",
    verdict: "APPROVE",
    finished_at: finishedAt,
  });

  it("copies its verdict only once the hold lifts; a round finishing after that is copied whole", async () => {
    // Rounds finish during a drain, and the moment it lifts new rounds
    // start — so the PR's ledger, prompt and transcript are
    // already the next round's by the time the held rounds are copied.
    const clock = handClock("2026-08-25T10:00:00Z");
    const rounds: WhyRound[] = [];
    const { ssh } = fakeVm(rounds);
    const c = new EvidenceCopier(CFG, store, ssh, {
      sessionDir: "state/pi-sessions",
      timeoutMs: 1000,
      now: clock.now,
    });
    const at = (
      prs: Array<Partial<StatusSnapshot["prs"][number]>>,
      extra = {},
    ): StatusSnapshot => ({
      ...snapshot(prs),
      heartbeat: clock.now().toISOString(),
      ...extra,
    });

    // 10:00 — the copier first sees the PR, during a drain.
    expect((await c.sweep(at([{ number: 5306, rounds: 0 }], { draining: true }))).held).toBe(
      "draining",
    );
    // 10:05 — round 1 finishes while the sweep is held. 12:00 — the drain lifts.
    rounds.push(done(1, "2026-08-25T10:05:00Z"));
    clock.advance(2 * 3600);
    await c.sweep(at([{ number: 5306, rounds: 1, last_verdict: "APPROVE" }]));
    const rd1 = store.roundDir(5306, 1);
    expect(readdirSync(rd1).sort()).toEqual([MANIFEST_NAME, "verdict.json"]);
    const m1 = JSON.parse(readFileSync(join(rd1, MANIFEST_NAME), "utf8"));
    expect(m1.skipped_stale.sort()).toEqual(["ledger", "prompt", "transcript"]);

    // 12:01 — round 2 finishes with the copier watching: copied whole.
    rounds.push(done(2, "2026-08-25T12:01:00Z"));
    clock.advance(120);
    await c.sweep(at([{ number: 5306, rounds: 2, last_verdict: "REQUEST_CHANGES" }]));
    const m2 = JSON.parse(readFileSync(join(store.roundDir(5306, 2), MANIFEST_NAME), "utf8"));
    expect(m2.skipped_stale).toEqual([]);
    expect(m2.files.map((f: { role: string }) => f.role).sort()).toEqual([
      "ledger",
      "prompt",
      "transcript",
      "verdict",
    ]);
  });

  it("a stale heartbeat is a hold too: a round that finished behind it is a backfill", async () => {
    const clock = handClock("2026-08-25T10:00:00Z");
    const rounds: WhyRound[] = [];
    const { ssh } = fakeVm(rounds);
    const c = new EvidenceCopier(CFG, store, ssh, {
      sessionDir: "state/pi-sessions",
      timeoutMs: 1000,
      now: clock.now,
    });
    const beat = "2026-08-25T10:00:00Z";
    await c.sweep({ ...snapshot([{ number: 9, rounds: 0 }]), heartbeat: beat }); // watching
    clock.advance(600); // 10:10 — the board's data is stale (the VM unreachable)
    expect((await c.sweep({ ...snapshot([{ number: 9, rounds: 0 }]), heartbeat: beat })).held).toBe(
      "heartbeat-stale",
    );
    rounds.push(done(1, "2026-08-25T10:12:00Z"));
    clock.advance(600); // 10:20 — fresh data again
    await c.sweep({
      ...snapshot([{ number: 9, rounds: 1, last_verdict: "APPROVE" }]),
      heartbeat: clock.now().toISOString(),
    });
    expect(readdirSync(store.roundDir(9, 1)).sort()).toEqual([MANIFEST_NAME, "verdict.json"]);
  });
});

// The archive fallback (docs/archiving.md §4, §14). A round copied after its
// PR's files were archived finds them in archive/pr-<n>/:
//   (5) with the live transcript missing and the archive .gz present, the
//       transcript role resolves to the archive and the manifest records it;
//       a role found only inside a bundle is recorded as `archived` with its
//       pointer — never `missing`.
describe("the archive fallback", () => {
  let dir: string;
  let store: EvidenceStore;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "qcr-evidence-archive-"));
    store = new EvidenceStore(dir);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const PR = 5406;
  const GZ = `${ROOT}/archive/pr-${PR}/transcripts/2026-10-02T10-00-00_b.jsonl.gz`;
  const MANIFEST = `${ROOT}/archive/pr-${PR}/manifest.json`;
  const archiveManifest = {
    format: 1,
    subject: `pr-${PR}`,
    passes: [{ id: "20261021T120000Z", kind: "archive", started_at: "2026-10-21T12:00:00Z" }],
    entries: [
      {
        pass: "20261021T120000Z",
        kind: "transcript",
        source: `state/pi-sessions/pr-${PR}/2026-10-02T10-00-00_b.jsonl`,
        archive: "transcripts/2026-10-02T10-00-00_b.jsonl.gz",
        bytes: 10,
        mtime_ms: 2,
        dev: 1,
        ino: 1,
        sha256: "a".repeat(64),
        gz_bytes: 5,
        verified_at: "2026-10-21T12:00:00Z",
      },
      {
        pass: "20261021T120000Z",
        kind: "bundle",
        archive: "state-20261021T120000Z.jsonl.gz",
        records: 2,
        bytes: 20,
        gz_bytes: 10,
        verified_at: "2026-10-21T12:00:00Z",
        files: [
          {
            path: `state/session-prompts/pr-${PR}.md`,
            bytes: 10,
            mtime_ms: 1,
            dev: 1,
            ino: 2,
            sha256: "b".repeat(64),
            class: "session_files",
          },
          {
            path: `verdict/processed/20261001T000000Z-pr-${PR}-round-1.json`,
            bytes: 10,
            mtime_ms: 1,
            dev: 1,
            ino: 3,
            sha256: "c".repeat(64),
            class: "verdicts",
          },
        ],
      },
    ],
  };

  /** A VM whose PR was archived: no live transcript, prompt or verdict. */
  function archivedVm(
    opts: { manifest?: string | null; failManifest?: boolean; listing?: string[] } = {},
  ): { ssh: SshRunner; scripts: string[] } {
    const scripts: string[] = [];
    const ssh: SshRunner = async (_host, argv) => {
      const script = argv.join(" ");
      scripts.push(script);
      if (script.includes("cli.js") && script.includes("why"))
        return OK(JSON.stringify({ pr: PR, rounds: [round(1)] }));
      if (script.includes("state/ledgers"))
        return OK(
          (
            opts.listing ?? [
              `transcript ${GZ}`,
              `ledger ${ROOT}/state/ledgers/pr-${PR}.md`,
              `archive-manifest ${MANIFEST}`,
            ]
          ).join("\n"),
        );
      if (script.includes(`'${MANIFEST}'`)) {
        if (opts.failManifest) return FAIL;
        return OK(opts.manifest ?? JSON.stringify(archiveManifest));
      }
      if (script.startsWith(`sudo docker exec quickreview-sandbox sh -c zcat -t '${GZ}'`))
        return OK('{"type":"message","from":"the archive"}\n');
      const m = /head -c \d+ '([^']+)'/.exec(script);
      if (m) return OK(`body of ${m[1]}`);
      return FAIL;
    };
    return { ssh, scripts };
  }

  const copier = (ssh: SshRunner, notices: string[] = [], now = "2026-08-25T08:00:00Z") =>
    new EvidenceCopier(CFG, store, ssh, {
      sessionDir: "state/pi-sessions",
      timeoutMs: 1000,
      onNotice: (t) => notices.push(t),
      now: () => new Date(now),
    });
  const manifestFor = () =>
    JSON.parse(readFileSync(join(store.roundDir(PR, 1), MANIFEST_NAME), "utf8"));

  it("the listing falls back to the newest archived transcript, never a legacy copy, and names the manifest", () => {
    const script = manifestArgv(CFG, "state/pi-sessions", PR, 1).at(-1)!;
    // Live first; only with no live JSONL, the archive.
    expect(script).toContain(`t=$(ls -1t "$r/state/pi-sessions/pr-${PR}"/*.jsonl`);
    expect(script).toContain(
      `[ -z "$t" ] && t=$(ls -1t "$r/archive/pr-${PR}/transcripts"/*.gz 2>/dev/null | grep -v '/session-at-close-' | head -1)`,
    );
    expect(script).toContain(
      `[ -f "$r/archive/pr-${PR}/manifest.json" ] && echo "archive-manifest $r/archive/pr-${PR}/manifest.json"`,
    );
    expect(script.trimEnd().endsWith("exit 0")).toBe(true);
    // The manifest line is not an artefact role…
    expect(parseManifest(`archive-manifest ${MANIFEST}`, ROOT)).toEqual([]);
    // …and only THIS PR's manifest is believed.
    expect(parseArchiveManifestLine(`archive-manifest ${MANIFEST}`, ROOT, PR)).toBe(MANIFEST);
    expect(parseArchiveManifestLine(`archive-manifest ${MANIFEST}`, ROOT, 1)).toBeNull();
    expect(
      parseArchiveManifestLine(
        `archive-manifest ${ROOT}/archive/pr-${PR}/../x/manifest.json`,
        ROOT,
        PR,
      ),
    ).toBeNull();
  });

  it("an archived gzip is decompressed on the VM — whole first (`zcat -t`), then capped", () => {
    const script = fetchArgv(CFG, GZ, 1234).at(-1)!;
    expect(script).toBe(`zcat -t '${GZ}' && zcat '${GZ}' | head -c 1234`);
    // Only a gzip under archive/: anything else is read as it is.
    expect(fetchArgv(CFG, `${ROOT}/state/x.jsonl.gz`, 9).at(-1)).toBe(
      `head -c 9 '${ROOT}/state/x.jsonl.gz'`,
    );
  });

  it("the transcript resolves to the archive and the manifest records it; bundle-only roles are `archived`, never `missing`", async () => {
    const { ssh } = archivedVm();
    const notices: string[] = [];
    const report = await copier(ssh, notices).sweep(snapshot([{ number: PR, rounds: 1 }]));
    expect(report.copied).toEqual([`evidence: pr-${PR} round 1 copied (2 files, 2 archived)`]);
    const rd = store.roundDir(PR, 1);
    expect(readFileSync(join(rd, "session.jsonl"), "utf8")).toBe(
      '{"type":"message","from":"the archive"}\n',
    );
    const m = manifestFor();
    expect(m.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "transcript",
          remote_path: GZ,
          from: "archive",
          scope: "pr-current",
        }),
        expect.objectContaining({ role: "ledger", from: "live" }),
      ]),
    );
    expect(m.archived).toEqual([
      {
        role: "prompt",
        pointer: `archive/pr-${PR}/state-20261021T120000Z.jsonl.gz`,
        path: `state/session-prompts/pr-${PR}.md`,
      },
      {
        role: "verdict",
        pointer: `archive/pr-${PR}/state-20261021T120000Z.jsonl.gz`,
        path: `verdict/processed/20261001T000000Z-pr-${PR}-round-1.json`,
      },
    ]);
    expect(m.missing).toEqual([]);
    expect(existsSync(join(rd, "prompt.md"))).toBe(false);
    expect(existsSync(join(rd, "verdict.json"))).toBe(false);
  });

  it("in a backfill an archived pr-current role is skipped as stale, its round-scoped verdict pointed at", async () => {
    const { ssh } = archivedVm();
    await copier(ssh, [], "2026-08-25T10:00:00Z").sweep(snapshot([{ number: PR, rounds: 1 }]));
    const m = manifestFor();
    expect(m.files).toEqual([]);
    expect(m.skipped_stale.sort()).toEqual(["ledger", "prompt", "transcript"]);
    expect(m.archived).toEqual([expect.objectContaining({ role: "verdict" })]);
    expect(m.missing).toEqual([]);
  });

  it("a role neither live nor in the archive is missing — and no manifest is fetched when nothing is absent", async () => {
    const thin = { ...archiveManifest, entries: [archiveManifest.entries[0]] };
    const { ssh } = archivedVm({ manifest: JSON.stringify(thin) });
    await copier(ssh).sweep(snapshot([{ number: PR, rounds: 1 }]));
    const m = manifestFor();
    expect(m.archived).toEqual([]);
    expect(m.missing.sort()).toEqual(["prompt", "verdict"]);

    rmSync(store.roundDir(PR, 1), { recursive: true });
    const live = archivedVm({
      listing: [
        `transcript ${ROOT}/state/pi-sessions/pr-${PR}/x.jsonl`,
        `ledger ${ROOT}/state/ledgers/pr-${PR}.md`,
        `prompt ${ROOT}/state/session-prompts/pr-${PR}.md`,
        `verdict ${ROOT}/verdict/processed/2026-pr-${PR}-round-1.json`,
        `archive-manifest ${MANIFEST}`,
      ],
    });
    await copier(live.ssh).sweep(snapshot([{ number: PR, rounds: 1 }]));
    expect(live.scripts.some((s) => s.includes(`'${MANIFEST}'`))).toBe(false);
    expect(manifestFor().files.every((f: { from: string }) => f.from === "live")).toBe(true);
  });

  it("a manifest that cannot be fetched or read fails the copy (retried) — never a manifest that says missing", async () => {
    for (const vm of [archivedVm({ failManifest: true }), archivedVm({ manifest: "{torn" })]) {
      const notices: string[] = [];
      await copier(vm.ssh, notices).sweep(snapshot([{ number: PR, rounds: 1 }]));
      expect(store.has(PR, 1)).toBe(false);
      expect(notices).toEqual([
        expect.stringMatching(/archive manifest fetch failed|unreadable archive manifest/),
      ]);
    }
  });

  it("archivedRole: the latest record of the path the live listing would have found", () => {
    const m = parseArchiveManifest(JSON.stringify(archiveManifest))!;
    expect(archivedRole(m, "transcript", PR, 1, "state/pi-sessions")).toEqual({
      pointer: `archive/pr-${PR}/transcripts/2026-10-02T10-00-00_b.jsonl.gz`,
      path: `state/pi-sessions/pr-${PR}/2026-10-02T10-00-00_b.jsonl`,
    });
    // Another round's verdict, or another PR's, is not this round's.
    expect(archivedRole(m, "verdict", PR, 2, "state/pi-sessions")).toBeNull();
    expect(archivedRole(m, "verdict", 54, 1, "state/pi-sessions")).toBeNull();
    expect(archivedRole(m, "ledger", PR, 1, "state/pi-sessions")).toBeNull();
    expect(parseArchiveManifest('{"format":2,"passes":[],"entries":[]}')).toBeNull();
  });

  it("archivedRole: a legacy session-at-close copy is never the round's transcript — even the newest, wherever its source says it was", () => {
    const transcript = archiveManifest.entries[0]!;
    const legacy = {
      ...transcript,
      // A source the transcript rule would otherwise accept: only the legacy
      // mark keeps it out.
      source: `state/pi-sessions/pr-${PR}/session.jsonl`,
      archive: "transcripts/session-at-close-20261021T120000Z.jsonl.gz",
      mtime_ms: 99,
      legacy: true,
    };
    const only = parseArchiveManifest(
      JSON.stringify({ ...archiveManifest, entries: [legacy, archiveManifest.entries[1]] }),
    )!;
    expect(archivedRole(only, "transcript", PR, 1, "state/pi-sessions")).toBeNull();
    // Beside an older real transcript, the real one is the pointer.
    const both = parseArchiveManifest(
      JSON.stringify({ ...archiveManifest, entries: [transcript, legacy] }),
    )!;
    expect(archivedRole(both, "transcript", PR, 1, "state/pi-sessions")).toEqual({
      pointer: `archive/pr-${PR}/transcripts/2026-10-02T10-00-00_b.jsonl.gz`,
      path: `state/pi-sessions/pr-${PR}/2026-10-02T10-00-00_b.jsonl`,
    });
  });
});
