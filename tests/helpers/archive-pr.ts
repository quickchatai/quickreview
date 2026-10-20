// A sandbox root with one closed PR carrying one file of every artifact class
// (docs/archiving.md §7.2), three transcripts, the legacy archive record and
// a ledger, and an Archiver in mode `on` over it with every outside fact injected.
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { gunzipSync } from "node:zlib";
import { Archiver, type ArchiverDeps } from "../../src/archive/archiver.js";
import { ARCHIVE_DEFAULTS, type ArchiveConfig, type Config } from "../../src/config.js";
import type { DaemonLoadStatus } from "../../src/eventloop.js";
import { writeSessionBridgeState } from "../../src/overseer-bridge.js";
import { PiSessionManager } from "../../src/sessions.js";
import {
  PrSessionLifecycle,
  prSessionName,
  type PrSessionHost,
} from "../../src/pr-session-lifecycle.js";
import { StateStore } from "../../src/state.js";
import { Tmux, type ExecFn } from "../../src/tmux.js";
import { WorktreeManager } from "../../src/worktrees.js";

export const T0 = Date.parse("2026-10-21T12:00:00.000Z");
export const DAY = 86_400_000;

export const sha = (b: Buffer | string): string => createHash("sha256").update(b).digest("hex");

export function put(root: string, rel: string, content: string | Buffer, mtimeMs?: number): string {
  const p = join(root, rel);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, content);
  if (mtimeMs !== undefined) utimesSync(p, mtimeMs / 1000, mtimeMs / 1000);
  return p;
}

/** A healthy, measured load reading (the file phase runs at full rate). */
export function okLoad(): DaemonLoadStatus {
  return {
    event_loop: { state: "ok" } as DaemonLoadStatus["event_loop"],
    cpu: {
      state: "measured",
      source: "/sys/fs/cgroup/cpu.stat",
      at: new Date(T0).toISOString(),
      window_s: 300,
      periods: 3000,
      throttled_periods: 0,
      throttled_ratio: 0,
      throttled_s: 0,
      usage_s: 1,
    },
  };
}

export interface PrFixture {
  root: string;
  store: StateStore;
  pr: number;
  clock: { ms: number };
  /** Live paths relative to the root that leave (the transcripts first). */
  transcripts: string[];
  small: string[];
  /** Bytes of every live file at fixture time, by relative path. */
  bytes: Map<string, Buffer>;
  /** mtime of every transcript, by relative path. */
  mtimes: Map<string, number>;
  /** Files that must never be touched: the live ledger, archive ledger, meta. */
  untouched: string[];
  close(): void;
}

/** A receipt-token line the way pi writes an accepted user message. */
export const line = (text: string): string => `${JSON.stringify({ type: "message", text })}\n`;

/**
 * PR `pr` closed `closedDaysAgo` days ago, with three transcripts (one
 * nested), one file of every §7.2 class, a session-command payload
 * byte-identical to its round prompt (same_as), a binary pass output
 * (base64), the live ledger and the legacy archive record.
 */
export function prFixture(
  opts: { pr?: number; closedDaysAgo?: number; legacy?: string | null } = {},
): PrFixture {
  const pr = opts.pr ?? 5406;
  const root = mkdtempSync(join(tmpdir(), "qcr-archive-pr-"));
  mkdirSync(join(root, "state"), { recursive: true });
  const clock = { ms: T0 };
  const store = new StateStore(join(root, "state", "state.db"), () => new Date(clock.ms));
  const closed = T0 - (opts.closedDaysAgo ?? 15) * DAY;
  clock.ms = closed - 60_000;
  store.upsertPr({
    number: pr,
    state: "closed",
    head_sha: "abc",
    title: `pr ${pr}`,
    author: "a",
    trigger_ts: null,
    stale_recheck: 0,
    migration_gate: 0,
  });
  clock.ms = closed;
  store.logEvent("pr_closed", pr, { merged: true });
  clock.ms = T0;

  const bytes = new Map<string, Buffer>();
  const mtimes = new Map<string, number>();
  const add = (rel: string, content: string | Buffer, mtime?: number): string => {
    const p = put(root, rel, content, mtime);
    bytes.set(rel, readFileSync(p));
    return p;
  };
  const sdir = `state/pi-sessions/pr-${pr}`;
  const transcripts = [
    `${sdir}/2026-10-01T10-00-00_a.jsonl`,
    `${sdir}/2026-10-02T10-00-00_b.jsonl`,
    `${sdir}/nested/2026-10-03T10-00-00_c.jsonl`,
  ];
  transcripts.forEach((rel, i) => {
    const m = closed - (5 - i) * DAY;
    add(rel, line(`<!-- qcr-transcript-${i} -->`).repeat(200 + i * 50), m);
    mtimes.set(rel, statSync(join(root, rel)).mtimeMs);
  });
  const prompt = `round 1 prompt for #${pr}\n<!-- qcr-round-${pr}-1 -->\n`;
  const small = [
    `state/round-prompts/pr-${pr}-round-1.md`,
    `state/session-commands/cmd-${pr}-1.md`,
    `state/findings/pr-${pr}-round-1.json`,
    `state/posting-receipts/pr-${pr}-round-1.json`,
    `state/pr-${pr}-round-1-passes/tasks/pass-baseline.md`,
    `state/pr-${pr}-round-1-passes/out.bin`,
    `state/pr-${pr}-round-1-review.md`,
    `state/pr-${pr}-round-1-comments.json`,
    `state/session-prompts/pr-${pr}.md`,
    `state/sessions/pr-${pr}.json`,
    `state/sessions/pr-${pr}.bridge-g1.json`,
    `state/round-progress/pr-${pr}.json`,
    `state/round-progress/pr-${pr}.jsonl`,
    `state/round-progress/pr-${pr}.jsonl.1`,
    `inject/pr-${pr}/.done/w1.md`,
    `inject/pr-${pr}/.terminal/w2.md`,
    `inject/pr-${pr}/w3.md.operator-recovery-1`,
    `inject/pr-${pr}/stale.md`,
    `verdict/processed/20261001T000000Z-pr-${pr}-round-1.json`,
    `verdict/failed/20261001T000000Z-pr-${pr}-thread-1-comment-2.json`,
  ];
  for (const rel of small) {
    if (rel.endsWith("round-1.md") || rel.endsWith(`cmd-${pr}-1.md`)) add(rel, prompt);
    else if (rel.endsWith(".bin")) add(rel, Buffer.from([0xff, 0xfe, 0x00, 0x81, 0x80, 0x7f]));
    else add(rel, `{"file":"${rel}"}\n`);
  }
  // The payload row (acked) and the stale inject's row (a failed round command).
  const cmd = (
    id: string,
    payload: string,
    inject: string,
    status: string,
    kind = "round",
  ): void => {
    store.createSessionCommand({
      id,
      pr,
      session: `pr-${pr}`,
      kind: kind as "round",
      round_no: 1,
      payload_sha256: sha(readFileSync(payload)),
      payload_path: payload,
      inject_path: inject,
      next_check_at: new Date(T0).toISOString(),
    });
    store.db.prepare("UPDATE session_commands SET status = ? WHERE id = ?").run(status, id);
  };
  cmd(
    `cmd-${pr}-1`,
    join(root, `state/session-commands/cmd-${pr}-1.md`),
    join(root, `inject/pr-${pr}/.done/w1.md`),
    "acked",
  );
  cmd(
    `cmd-${pr}-2`,
    join(root, `state/session-commands/cmd-${pr}-1.md`),
    join(root, `inject/pr-${pr}/stale.md`),
    "failed",
  );
  // Kept: the live ledger, and the archive record qcr why reads.
  const untouched = [
    `state/ledgers/pr-${pr}.md`,
    `archive/pr-${pr}/ledger.md`,
    `archive/pr-${pr}/meta.json`,
  ];
  put(root, untouched[0]!, "## Ledger\nSETTLED: nothing\n");
  put(root, untouched[1]!, "## Ledger\nSETTLED: nothing\n");
  put(
    root,
    untouched[2]!,
    JSON.stringify({
      session: `pr-${pr}`,
      archived_at: new Date(closed).toISOString(),
      session_file: join(root, transcripts[1]!),
    }),
  );
  if (opts.legacy !== null && opts.legacy !== undefined)
    put(root, `archive/pr-${pr}/session.jsonl`, opts.legacy);
  return {
    root,
    store,
    pr,
    clock,
    transcripts,
    small,
    bytes,
    mtimes,
    untouched,
    close: () => {
      try {
        store.close();
      } catch {
        /* closed already */
      }
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** An Archiver in mode `on` over the fixture, every outside fact injected. */
export function onArchiver(
  f: PrFixture,
  cfg: Partial<ArchiveConfig> = {},
  extra: Partial<ArchiverDeps> = {},
): Archiver {
  return new Archiver({
    store: f.store,
    cfg: { ...ARCHIVE_DEFAULTS, mode: "on", max_mb_per_s: 200, tick_budget_s: 300, ...cfg },
    root: f.root,
    sessionsRoot: join(f.root, "state", "pi-sessions"),
    firstHealthyReconcileAt: () => new Date(T0 - 3_600_000),
    load: () => okLoad(),
    liveSessions: async () => [],
    birthInFlight: () => false,
    statfs: async () => ({ bavail: 1e12, bsize: 1 }),
    now: () => new Date(f.clock.ms),
    sleep: async () => {},
    schedule: () => () => {},
    ...extra,
  });
}

/** Every regular file under `dir`, relative to `root`, sorted. */
export function filesUnder(root: string, dir = root): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    if (!existsSync(d)) return;
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(relative(root, p));
    }
  };
  walk(dir);
  return out.sort();
}

/** The manifest of the fixture PR, parsed. */
export function manifestOf(f: PrFixture): {
  passes: Array<Record<string, unknown>>;
  entries: Array<Record<string, unknown> & { kind: string }>;
} {
  return JSON.parse(readFileSync(join(f.root, "archive", `pr-${f.pr}`, "manifest.json"), "utf8"));
}

/** Every bundle record of the fixture PR's archive, by path (same_as kept). */
export function bundleRecords(f: PrFixture): Map<string, Record<string, unknown>> {
  const out = new Map<string, Record<string, unknown>>();
  const dir = join(f.root, "archive", `pr-${f.pr}`);
  for (const name of readdirSync(dir)
    .filter((n) => /^state-.+\.jsonl\.gz$/.test(n))
    .sort())
    for (const l of gunzipSync(readFileSync(join(dir, name)))
      .toString("utf8")
      .split("\n"))
      if (l.trim()) {
        const r = JSON.parse(l) as Record<string, unknown>;
        out.set(r.path as string, r);
      }
  return out;
}

/** The bytes a bundle record holds (same_as resolved within its bundle). */
export function recordBytes(records: Map<string, Record<string, unknown>>, path: string): Buffer {
  let r = records.get(path)!;
  while (r.same_as !== undefined) r = records.get(r.same_as as string)!;
  return r.enc === "base64"
    ? Buffer.from(r.content as string, "base64")
    : Buffer.from(r.content as string, "utf8");
}

/** Every original byte is somewhere: live with the same bytes, or in the
 * archive (a transcript gzip, or a bundle record). Returns the losses. */
export function lostBytes(f: PrFixture): string[] {
  const lost: string[] = [];
  const dir = join(f.root, "archive", `pr-${f.pr}`);
  const records = existsSync(dir) ? bundleRecords(f) : new Map();
  for (const [rel, buf] of f.bytes) {
    const live = join(f.root, rel);
    if (existsSync(live) && readFileSync(live).equals(buf)) continue;
    const name = rel.slice(`state/pi-sessions/pr-${f.pr}/`.length);
    const gz = join(dir, "transcripts", `${name}.gz`);
    if (existsSync(gz) && gunzipSync(readFileSync(gz)).equals(buf)) continue;
    if (records.has(rel) && recordBytes(records, rel).equals(buf)) continue;
    lost.push(rel);
  }
  return lost;
}

// ---- a session manager over the fixture root (no tmux, no pi) ---------------

export interface SessionRig {
  m: PiSessionManager;
  /** Live tmux session names (the fake answers from this). */
  live: Set<string>;
  /** Every `new-session` the manager asked for, in order. */
  births: string[];
  /** Called on each new-session, before the bridge reports ready. */
  onBirth?: (session: string) => void;
}

/** A PiSessionManager whose tmux is a fake that records births and makes the
 * new generation's bridge ready at once (tests/sessions.test.ts's shape). */
export function sessionRig(f: PrFixture): SessionRig {
  const secrets = join(f.root, "secrets");
  mkdirSync(secrets, { recursive: true });
  writeFileSync(join(secrets, "openai_api_key"), "sk-app-key\n");
  mkdirSync(join(f.root, "prompts"), { recursive: true });
  writeFileSync(
    join(f.root, "prompts", "conversation-system.md"),
    "Shepherd of PR #{{n}} ({{title}}) at {{worktree}}.\n",
  );
  const rig = { live: new Set<string>(), births: [] as string[] } as SessionRig;
  const exec: ExecFn = async (cmd, args) => {
    if (cmd === "tmux") {
      if (args[0] === "list-sessions")
        return { code: 0, stdout: [...rig.live].join("\n"), stderr: "" };
      if (args[0] === "has-session") {
        const name = String(args[2]).replace(/^=/, "");
        return { code: rig.live.has(name) ? 0 : 1, stdout: "", stderr: "" };
      }
      if (args[0] === "new-session") {
        const session = String(args[3]);
        rig.births.push(session);
        rig.onBirth?.(session);
        rig.live.add(session);
        const generation = args
          .find((v) => v.startsWith("QCR_SESSION_BRIDGE_GENERATION="))
          ?.split("=", 2)[1];
        const stateFile = args
          .find((v) => v.startsWith("QCR_SESSION_BRIDGE_STATE_FILE="))
          ?.slice("QCR_SESSION_BRIDGE_STATE_FILE=".length);
        if (generation && stateFile)
          writeSessionBridgeState(stateFile, {
            version: 1,
            session,
            generation,
            stage: "ready",
            updated_at: new Date(f.clock.ms).toISOString(),
          });
      }
      if (args[0] === "kill-session") rig.live.delete(String(args[2]).replace(/^=/, ""));
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  const config = {
    dry_run: true,
    github: {
      repo: "exampleorg/example-app",
      app_slug: "example-review",
      bot_login: "example-review[bot]",
      secrets_dir: secrets,
    },
    daemon: { poll_interval_s: 300, overseer_rotation_days: 7 },
    models: {
      default: "openai/x",
      conversation: "openai/conv",
      overseer: "openai/over",
      passes: {},
    },
    pi: {
      package: "p",
      version: "1.0.0",
      session_dir: "state/pi-sessions",
    },
    engine: {
      runtime: "sdk",
      lens_max_concurrency: 6,
      lens_cache_group: 5,
      lens_cache_stagger_ms: 2500,
      lens_pass_deadline_min: 8,
    },
    openviking: { host: "127.0.0.1", port: 1933, config_file: join(f.root, "ovhome", "ov.conf") },
  } as unknown as Config;
  rig.m = new PiSessionManager({
    cfg: config,
    root: f.root,
    tmux: new Tmux({ exec }),
    worktrees: new WorktreeManager({
      root: f.root,
      repo: "o/n",
      cloneDir: "example-app",
      cloneUrl: "/dev/null",
      run: exec,
    }),
    piHome: join(f.root, "pihome"),
    now: () => new Date(f.clock.ms),
    commandStore: f.store,
  });
  return rig;
}

// ---- a PR session lifecycle over the fixture root (no host at all) ----------

export interface LifecycleRig {
  m: {
    setBeforeBirth(fn: (pr: number) => Promise<void>): void;
    ensurePrSession(pr: number, title: string, worktree: string): Promise<string>;
  };
  /** Live session names (the fake host answers from this). */
  live: Set<string>;
  /** Every session the host was asked to start, in order. */
  births: string[];
  /** Called on each start, before the session counts as live. */
  onBirth?: (session: string) => void;
}

/** The host-neutral lifecycle over a fake host that records births: what the
 * restore-before-birth cases need, with no transcript-hosting machinery. */
export function lifecycleRig(f: PrFixture): LifecycleRig {
  const rig = { live: new Set<string>(), births: [] as string[] } as LifecycleRig;
  const host: PrSessionHost = {
    liveSessions: async () => [...rig.live],
    provenGone: async (pr) => !rig.live.has(prSessionName(pr)),
    killConfirmed: async (pr) => {
      rig.live.delete(prSessionName(pr));
      return true;
    },
    stop: async (pr) => void rig.live.delete(prSessionName(pr)),
    reuseLive: async (pr) => (rig.live.has(prSessionName(pr)) ? prSessionName(pr) : undefined),
    spawn: async (pr) => {
      const session = prSessionName(pr);
      rig.births.push(session);
      rig.onBirth?.(session);
      rig.live.add(session);
      return session;
    },
  };
  const exec: ExecFn = async () => ({ code: 0, stdout: "", stderr: "" });
  const lifecycle = new PrSessionLifecycle({
    cfg: {
      github: { repo: "exampleorg/example-app" },
      pi: { session_dir: "state/pi-sessions" },
    } as unknown as Config,
    root: f.root,
    worktrees: new WorktreeManager({
      root: f.root,
      repo: "o/n",
      cloneDir: "example-app",
      cloneUrl: "/dev/null",
      run: exec,
    }),
    host,
    now: () => new Date(f.clock.ms),
    commandStore: f.store,
  });
  rig.m = {
    setBeforeBirth: (fn) => lifecycle.setBeforeBirth(fn),
    ensurePrSession: (pr, title, worktree) => lifecycle.ensureSession(pr, title, worktree),
  };
  return rig;
}

/** Reopen the PR the way reconcile's `reopened` correction does. */
export function reopen(f: PrFixture): void {
  f.store.db
    .prepare("UPDATE pr_state SET state = 'tracked', updated_at = ? WHERE number = ?")
    .run(new Date(f.clock.ms).toISOString(), f.pr);
}
