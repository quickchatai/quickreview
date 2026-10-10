// The evidence copier's archive fallback, run for real
// (acceptance 5): the listing and fetch scripts the copier sends to the VM run
// under `sh` here, against a PR the real archiver archived — so `ls -1t` on
// the archived gzips (their mtimes kept at the originals'), the `grep -v` that
// skips a legacy session-at-close copy, and `zcat -t && zcat | head -c` are
// all exercised, not just their argv. Only the `qcr why` answer is faked (it
// would need the container's node and state.db).
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TUI_DEFAULTS, type TuiConfig } from "../src/config.js";
import type { StatusSnapshot } from "../src/state.js";
import {
  EvidenceCopier,
  EvidenceStore,
  MANIFEST_NAME,
  fetchArgv,
  type WhyRound,
} from "../src/tui/evidence.js";
import type { RemoteResult, SshRunner } from "../src/tui/remote.js";
import { onArchiver, prFixture, type PrFixture } from "./helpers/archive-pr.js";

const open: PrFixture[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const f of open.splice(0)) f.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Run the script the copier would send through docker exec, here, under sh. */
function localShell(): { ssh: SshRunner; scripts: string[] } {
  const scripts: string[] = [];
  const ssh: SshRunner = (_host, argv) => {
    const script = argv.at(-1)!;
    scripts.push(script);
    if (argv.includes("dist/src/cli.js"))
      return Promise.resolve({ ok: false, stdout: "", stderr: "not here", code: 1 });
    return new Promise<RemoteResult>((resolve) =>
      execFile("sh", ["-c", script], { maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) =>
        resolve({
          ok: !err,
          stdout,
          stderr,
          code: err ? (typeof err.code === "number" ? err.code : 1) : 0,
        }),
      ),
    );
  };
  return { ssh, scripts };
}

describe("the archive fallback, run under a real shell", () => {
  it("the archived transcript is read back whole, a legacy copy skipped, bundle-only roles pointed at", async () => {
    // The legacy archive copy matches nothing, so it is kept as a
    // session-at-close gzip — with an mtime NEWER than every transcript.
    const f = prFixture({ legacy: "a copy of nothing\n" });
    open.push(f);
    const legacy = join(f.root, "archive", `pr-${f.pr}`, "session.jsonl");
    utimesSync(legacy, f.clock.ms / 1000, f.clock.ms / 1000); // newer than every transcript
    const a = onArchiver(f);
    await a.tick();
    a.stop();
    const cfg: TuiConfig = {
      ...TUI_DEFAULTS,
      ssh_host: "local",
      container: "c",
      sudo_docker: false,
      remote_sandbox_root: f.root,
    };
    const dir = mkdtempSync(join(tmpdir(), "qcr-evidence-shell-"));
    dirs.push(dir);
    const store = new EvidenceStore(dir);
    const inner = localShell();
    const round: WhyRound = {
      round_no: 1,
      status: "done",
      verdict: "APPROVE",
      finished_at: new Date(f.clock.ms + 3_600_000).toISOString(),
    };
    const ssh: SshRunner = (host, argv, o) =>
      argv.includes("dist/src/cli.js")
        ? Promise.resolve({
            ok: true,
            stdout: JSON.stringify({ pr: f.pr, rounds: [round] }),
            stderr: "",
            code: 0,
          })
        : inner.ssh(host, argv, o);
    const copier = new EvidenceCopier(cfg, store, ssh, {
      sessionDir: "state/pi-sessions",
      timeoutMs: 30_000,
      now: () => new Date(f.clock.ms),
    });
    const snap = {
      written_at: new Date(f.clock.ms).toISOString(),
      dry_run: false,
      prs: [
        {
          number: f.pr,
          state: "closed",
          title: "t",
          head_sha: "abc",
          stale_recheck: false,
          rounds: 1,
          last_verdict: "APPROVE",
        },
      ],
      running_rounds: 0,
      total_spend_usd: 0,
      heartbeat: new Date(f.clock.ms).toISOString(),
    } as unknown as StatusSnapshot;
    const report = await copier.sweep(snap);
    expect(report.failures).toEqual([]);
    expect(report.copied).toEqual([`evidence: pr-${f.pr} round 1 copied (2 files, 2 archived)`]);
    const rd = store.roundDir(f.pr, 1);
    // The newest top-level transcript (b), decompressed byte for byte — not
    // the newer-dated legacy copy, and not the nested one the live glob would
    // not have read either.
    const b = f.transcripts[1]!;
    expect(readFileSync(join(rd, "session.jsonl")).equals(f.bytes.get(b)!)).toBe(true);
    const m = JSON.parse(readFileSync(join(rd, MANIFEST_NAME), "utf8"));
    expect(m.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "transcript",
          from: "archive",
          remote_path: join(
            f.root,
            "archive",
            `pr-${f.pr}`,
            "transcripts",
            `${b.split("/").pop()}.gz`,
          ),
        }),
        expect.objectContaining({ role: "ledger", from: "live" }),
      ]),
    );
    expect(m.archived.map((x: { role: string }) => x.role).sort()).toEqual(["prompt", "verdict"]);
    for (const x of m.archived)
      expect(x.pointer).toMatch(new RegExp(`^archive/pr-${f.pr}/state-.+\\.jsonl\\.gz$`));
    expect(m.missing).toEqual([]);
    expect(inner.scripts.some((s) => s.startsWith("zcat -t "))).toBe(true);
  });

  it("a corrupt archived gzip fails the fetch (zcat -t) — never a short transcript recorded as whole", async () => {
    const f = prFixture();
    open.push(f);
    const a = onArchiver(f);
    await a.tick();
    a.stop();
    const gz = join(
      f.root,
      "archive",
      `pr-${f.pr}`,
      "transcripts",
      `${f.transcripts[1]!.split("/").pop()}.gz`,
    );
    const good = readFileSync(gz);
    // Keep the gzip header and the first block, cut the rest: zcat would print
    // a prefix and exit non-zero, and `| head` alone would hide that.
    writeFileSync(gz, good.subarray(0, Math.max(20, Math.floor(good.length / 2))));
    const { ssh } = localShell();
    const cfg: TuiConfig = {
      ...TUI_DEFAULTS,
      sudo_docker: false,
      container: "c",
      remote_sandbox_root: f.root,
    };
    const r = await ssh("local", fetchArgv(cfg, gz));
    expect(r.ok).toBe(false);
  });
});
