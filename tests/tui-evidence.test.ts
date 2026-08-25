// finished-round evidence copied down to a local store the companion
// reads. The invariants under test are the ones the ticket is made of: copy on
// completion (not on demand), never copy the same round twice, never let a
// wedged ssh become the TUI's problem, and grant the companion nothing.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TUI_DEFAULTS, type TuiConfig } from "../src/config.js";
import type { StatusSnapshot } from "../src/state.js";
import {
  EvidenceCopier,
  EvidenceStore,
  MANIFEST_NAME,
  fetchArgv,
  finishedRounds,
  manifestArgv,
  parseManifest,
  prSignature,
  type WhyRound,
} from "../src/tui/evidence.js";
import type { RemoteResult, SshRunner } from "../src/tui/remote.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const CFG: TuiConfig = { ...TUI_DEFAULTS, ssh_host: "my-vm", container: "quickreview-sandbox", sudo_docker: true };
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
function fakeVm(rounds: WhyRound[], opts: { fail?: (script: string) => boolean } = {}): {
  ssh: SshRunner;
  scripts: string[];
} {
  const scripts: string[] = [];
  const ssh: SshRunner = async (_host, argv) => {
    const script = argv.join(" ");
    scripts.push(script);
    if (opts.fail?.(script)) return FAIL;
    if (script.includes("cli.js") && script.includes("why")) return OK(JSON.stringify({ pr: 5306, rounds }));
    if (script.includes("head -c")) return OK(`body of ${/head -c \d+ '([^']+)'/.exec(script)![1]}`);
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
  const copier = (ssh: SshRunner, notices: string[] = [], now = () => new Date("2026-08-25T08:00:00Z")): EvidenceCopier =>
    new EvidenceCopier(CFG, store, ssh, { sessionDir: "state/pi-sessions", timeoutMs: 1000, onNotice: (t) => notices.push(t), now });

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
    expect(notices).toEqual(["evidence: pr-5306 round 1 — transcript fetch failed"]);

    // Still down: the failure is not announced again (a 3-second poll would
    // otherwise bury the notice line).
    await c.sweep(snap);
    expect(notices.length).toBe(1);

    flaky.down = false;
    await c.sweep(snap);
    expect(store.has(5306, 1)).toBe(true);
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

  it("a permanently failing PR does not starve the others", async () => {
    // Adversarial finding (P1): the old sweep broke unconditionally after the
    // first changed PR even when its reconcile FAILED — and a failure does not
    // retire the signature, so that PR was picked first every tick, forever.
    const { ssh } = fakeVm([round(1)], { fail: (s) => s.includes("head -c") && s.includes("pr-1/") });
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
    // Adversarial finding (P2): ledger, prompt and the newest transcript are
    // the PR's CURRENT files. A backlog sweep that stamped them into an old
    // round's dir would fabricate that round's adjudication evidence.
    const { ssh } = fakeVm([round(1)]); // finished 09:00…
    const c = copier(ssh, [], () => new Date("2026-08-25T10:00:00Z")); // …first seen 10:00
    await c.sweep(snapshot([{ number: 5306, rounds: 1 }]));

    const rd = store.roundDir(5306, 1);
    expect(existsSync(join(rd, "verdict.json"))).toBe(true);
    for (const f of ["session.jsonl", "ledger.md", "prompt.md"]) expect(existsSync(join(rd, f))).toBe(false);
    const manifest = JSON.parse(readFileSync(join(rd, MANIFEST_NAME), "utf8"));
    expect(manifest.skipped_stale.sort()).toEqual(["ledger", "prompt", "transcript"]);
    expect(manifest.missing).toEqual([]); // skipped is deliberate, not absent
    expect(manifest.files).toEqual([expect.objectContaining({ role: "verdict", scope: "round" })]);
  });

  it("a fresh round is copied whole, with every file's scope recorded", async () => {
    const { ssh } = fakeVm([round(1)]);
    await copier(ssh).sweep(snapshot([{ number: 5306, rounds: 1 }]));
    const manifest = JSON.parse(readFileSync(join(store.roundDir(5306, 1), MANIFEST_NAME), "utf8"));
    expect(manifest.roles_note).toContain("pr-current");
    expect(manifest.skipped_stale).toEqual([]);
    const scopes = Object.fromEntries(manifest.files.map((f: { role: string; scope: string }) => [f.role, f.scope]));
    expect(scopes).toEqual({ transcript: "pr-current", ledger: "pr-current", prompt: "pr-current", verdict: "round" });
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
    // Root-anchored: the bare `evidence/` spelling also ignored
    // skills/companion/evidence/ and silently dropped that skill from a commit.
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
    expect(companion).toContain("${this.cfg.evidence_dir}:${CONTAINER.evidence}:ro");
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
      const body = "├─ pass-intent ✅ 🎉\n{\"a\":1}\n";
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
