// `qcr open pr <n> [--round r] [--lens id]` - the pulling half: a bot PR session
// from the box that hosts the bot, as a local, read-only copy that `qcr open`
// (src/opencli.ts) then forks in interactive pi on the operator's machine.
//
// Where the session is, today and tomorrow:
//   live      `<root>/<session_dir>/pr-<n>/*.jsonl` on the VM (the tmux-hosted
//             bot keeps ONE session per PR, every round in it; a worker-hosted
//             bot resumes the same file). The newest one is the PR's session.
//   archived  a PR closed for 14 days is in `<root>/archive/pr-<n>/`:
//             the transcript's gzip and the manifest are read off the box, and the
//             bytes are decompressed and sha256-verified by `extractPr` - the very
//             code behind `qcr archive extract` - on a mirror of just those files.
//   lenses    a worker keeps them in `<root>/state/lens/pr-<n>/r<k>/lens-sessions/
//             <lens run id>/*.jsonl` (src/botworker.ts, D10); `<pr dir>/lens-sessions/`
//             is also read. A tmux-hosted lens pass is a child of the PR's session and
//             keeps no file of its own. The archive keeps the worker trees (P8.16;
//             `qcr archive extract`, then `qcr open <dir>`).
//
// Nothing is written on the box and nothing runs there but reads: the commands
// are `ls`/`stat`/`cat`/`head`/`base64` and `qcr why --json`, through the TUI's
// one runner (src/tui/remote.ts), so the same ssh alias and the same container
// serve it, and `[tui] target = "local"` serves it without ssh. The copy lands in
// `<state home>/open/pr-<n>/`, the way a run dir keeps a session, so a fork of it
// costs the box nothing. `--round r` keeps the session as it stood when round r
// finished (the entries stamped up to that round's `finished_at`).
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import type { ExtractResult } from "./archive/extract.js";
import {
  archivedRole,
  isShellSafePath,
  parseArchiveManifest,
  readWhyRounds,
} from "./tui/evidence.js";
import type { TuiConfig } from "./config.js";
import {
  LENS_SESSIONS_DIR,
  MAIN_SESSION_DIR,
} from "@quickchatai/pi-quickreview/src/engine/openable.js";
import { dockerShArgv, whyArgv, type RemoteResult, type SshRunner } from "./tui/remote.js";
import { remoteSandboxRoot, resolveLayout } from "./tui/layout.js";

/** A session bigger than this is refused rather than pulled whole over ssh. */
export const OPEN_PR_MAX_BYTES = 128 * 1024 * 1024;

/** Under the sandbox root: where a worker keeps a round's lens passes
 * (`<this>/pr-<n>/r<k>/lens-sessions/`, `lensDirOf` in src/botworker.ts). */
const WORKER_LENS_DIR = "state/lens";

/** What the local copy records of where it came from. */
export const OPEN_PR_RECORD = "open-pr.json";

export interface OpenPrOptions {
  pr: number;
  round?: number;
  lens?: string;
}

export type OpenPrArgs = { ok: true; value: OpenPrOptions } | { ok: false; error: string };

/** `<n> [--round r]` already split from their flags: the numbers a person types. */
export function openPrOptions(
  pr: string | undefined,
  round: string | undefined,
  lens: string | undefined,
): OpenPrArgs {
  const whole = (v: string): number | null => (/^[1-9]\d{0,8}$/.test(v) ? Number(v) : null);
  const n = pr === undefined ? null : whole(pr);
  if (n === null) return { ok: false, error: "qcr open pr needs a PR number" };
  const value: OpenPrOptions = { pr: n };
  if (round !== undefined) {
    const r = whole(round);
    if (r === null) return { ok: false, error: "--round needs a round number" };
    value.round = r;
  }
  if (lens !== undefined) value.lens = lens;
  if (value.round !== undefined && value.lens !== undefined)
    return {
      ok: false,
      error:
        "--round and --lens cannot be combined: --round cuts the PR's main session " +
        "at a round's finish, and a lens pass is opened by its run id alone",
    };
  return { ok: true, value };
}

// ---- what is asked of the box: reads only ------------------------------------------

/**
 * Everything the box has for a PR, in ONE call: `live <bytes> <mtime> <path>` per
 * session JSONL, `lens ...` per kept lens pass, `archive-manifest <path>` when
 * the PR has an archive. Ends `exit 0`: a `[ -f … ] &&` that finds nothing must
 * not make an answer look failed.
 */
export function listArgv(cfg: TuiConfig, sessionDir: string, pr: number): string[] {
  const root = remoteSandboxRoot(cfg);
  const dir = `$r/${sessionDir}/pr-${pr}`;
  return dockerShArgv(
    cfg,
    [
      `r="${root}"`,
      `for f in "${dir}"/*.jsonl; do [ -f "$f" ] && echo "live $(stat -c '%s %Y' "$f") $f"; done`,
      `for f in "${dir}/${LENS_SESSIONS_DIR}"/*/*.jsonl "$r/${WORKER_LENS_DIR}/pr-${pr}"/r*/${LENS_SESSIONS_DIR}/*/*.jsonl; do [ -f "$f" ] && echo "lens $(stat -c '%s %Y' "$f") $f"; done`,
      `[ -f "$r/archive/pr-${pr}/manifest.json" ] && echo "archive-manifest 0 0 $r/archive/pr-${pr}/manifest.json"`,
      `exit 0`,
    ].join("\n"),
  );
}

/** The first `bytes` bytes of one file: what the listing measured, so a session
 * the bot is still writing is read to a fixed point and never to a moving one. */
export function readArgv(cfg: TuiConfig, path: string, bytes: number): string[] {
  return dockerShArgv(cfg, `head -c ${bytes} '${path}'`);
}

/** A binary file as one base64 line (the runner decodes stdout as text). */
export function readBase64Argv(cfg: TuiConfig, path: string): string[] {
  return dockerShArgv(cfg, `base64 -w0 '${path}'`);
}

export interface Listed {
  kind: "live" | "lens" | "archive-manifest";
  bytes: number;
  mtimeS: number;
  path: string;
}

const escapeRe = (t: string): string => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The listing, refusing any path that is not plainly inside the PR's own
 * directory and plainly shell-safe: the box's answer becomes the next command's
 * argument, so a path is data and never a fragment of script.
 */
export function parseListing(
  stdout: string,
  root: string,
  sessionDir: string,
  pr: number,
): Listed[] {
  const prDir = `${root}/${sessionDir}/pr-${pr}/`;
  const manifest = `${root}/archive/pr-${pr}/manifest.json`;
  const workerLens = new RegExp(
    `^${escapeRe(root)}/${WORKER_LENS_DIR}/pr-${pr}/r\\d+/${LENS_SESSIONS_DIR}/[^/]+/[^/]+\\.jsonl$`,
  );
  const out: Listed[] = [];
  for (const line of stdout.split("\n")) {
    const m = /^(live|lens|archive-manifest) (\d+) (\d+) (\S+)$/.exec(line.trim());
    if (!m) continue;
    const path = m[4]!;
    if (!isShellSafePath(path) || path.includes("..")) continue;
    const kind = m[1] as Listed["kind"];
    if (kind === "lens" && workerLens.test(path)) {
      out.push({ kind, bytes: Number(m[2]), mtimeS: Number(m[3]), path });
      continue;
    }
    const placed = kind === "archive-manifest" ? path === manifest : path.startsWith(prDir);
    if (!placed) continue;
    // A live session sits directly in the PR's dir, a lens pass one level down.
    const rest = path.slice(prDir.length);
    if (kind === "live" && rest.includes("/")) continue;
    if (kind === "lens" && !new RegExp(`^${LENS_SESSIONS_DIR}/[^/]+/[^/]+\\.jsonl$`).test(rest))
      continue;
    out.push({ kind, bytes: Number(m[2]), mtimeS: Number(m[3]), path });
  }
  return out;
}

// ---- pure session text -------------------------------------------------------------

/** Whole lines only: a session still being written may end mid-line, and pi would
 * read that tail as a corrupt entry. null when no whole line is left. */
export function wholeLines(text: string): string | null {
  const end = text.lastIndexOf("\n");
  return end < 0 ? null : text.slice(0, end + 1);
}

/** The id in a session's header line, or null. */
export function sessionIdOf(text: string): string | null {
  try {
    const head = JSON.parse(text.slice(0, text.indexOf("\n") < 0 ? undefined : text.indexOf("\n")));
    return head?.type === "session" && typeof head.id === "string" ? head.id : null;
  } catch {
    return null;
  }
}

const hasToolCall = (entry: unknown): boolean => {
  const msg = (entry as { type?: string; message?: { role?: string; content?: unknown } })?.message;
  return (
    (entry as { type?: string })?.type === "message" &&
    msg?.role === "assistant" &&
    Array.isArray(msg.content) &&
    msg.content.some((c: { type?: string }) => c?.type === "toolCall")
  );
};

const toolCallIds = (entry: unknown): string[] =>
  (
    (entry as { message?: { content?: Array<{ type?: string; id?: unknown }> } }).message
      ?.content ?? []
  )
    .filter((c) => c?.type === "toolCall" && typeof c.id === "string")
    .map((c) => c.id as string);

/** Pops the trailing assistant message that asks for tools, with the results
 * after it, while any of its calls has no kept result. */
function dropUnansweredCalls(kept: string[]): void {
  for (;;) {
    let at = -1;
    for (let i = kept.length - 1; i > 0; i--)
      if (hasToolCall(JSON.parse(kept[i]!))) {
        at = i;
        break;
      }
    if (at < 1) return;
    const answered = new Set<string>();
    for (const l of kept.slice(at + 1)) {
      const m = (JSON.parse(l) as { message?: { role?: string; toolCallId?: unknown } }).message;
      if (m?.role === "toolResult" && typeof m.toolCallId === "string") answered.add(m.toolCallId);
    }
    if (toolCallIds(JSON.parse(kept[at]!)).every((id) => answered.has(id))) return;
    kept.length = at;
  }
}

/**
 * The session as it stood at `untilMs`: the header and every entry stamped up to
 * then, the entries being appended in time order. A turn cut off mid-way (an
 * assistant message asking for a tool whose result falls after the cut) is
 * dropped, so the fork's next request is one a provider accepts. null when
 * nothing but the header would be left.
 */
export function cutAtTime(
  text: string,
  untilMs: number,
): { text: string; kept: number; dropped: number } | null {
  const lines = text.split("\n").filter((l) => l.trim() !== "");
  const kept: string[] = [];
  for (const [i, l] of lines.entries()) {
    let entry: { timestamp?: unknown };
    try {
      entry = JSON.parse(l) as { timestamp?: unknown };
    } catch {
      break; // a torn line ends the session
    }
    const at = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : NaN;
    if (i > 0 && Number.isFinite(at) && at > untilMs) break;
    kept.push(l);
  }
  dropUnansweredCalls(kept);
  if (kept.length <= 1) return null;
  return {
    text: kept.join("\n") + "\n",
    kept: kept.length - 1,
    dropped: lines.length - kept.length,
  };
}

// ---- the pull ----------------------------------------------------------------------

export interface PrPullDeps {
  cfg: TuiConfig;
  /** `[pi] session_dir`, relative to the box's sandbox root. */
  sessionDir: string;
  ssh: SshRunner;
  /** `<state home>`: the copy lands in `<home>/open/pr-<n>/`. */
  home: string;
  /** `extractPr` over a mirror root (the archive pull). */
  extract: (o: {
    root: string;
    sessionsRoot: string;
    to: string;
    pr: number;
  }) => Promise<ExtractResult>;
  now?: () => Date;
}

export type PrPull =
  | {
      ok: true;
      /** The run dir `qcr open` opens: holds `session/` or `lens-sessions/`. */
      dir: string;
      file: string;
      source: "live" | "archive";
      kind: "main" | "lens";
      bytes: number;
      /** One line for the person: what was pulled and from where. */
      note: string;
    }
  | { ok: false; error: string };

const fail = (error: string): PrPull => ({ ok: false, error });

const lastLine = (r: RemoteResult): string =>
  (r.stderr.trim().split("\n").pop() ?? "").trim() || `exit ${r.code ?? "?"}`;

const sha256 = (data: string | Buffer): string => createHash("sha256").update(data).digest("hex");

const mib = (n: number): string => `${(n / (1024 * 1024)).toFixed(1)} MiB`;

/** The time budget of one read: the TUI's evidence budget, longer for a big file. */
const budgetMs = (cfg: TuiConfig, bytes: number): number =>
  Math.max(cfg.evidence_timeout_s * 1000, 30_000 + Math.ceil(bytes / (1024 * 1024)) * 2_000);

/** Replace `<dir>/<sub>` with one read-only file. Written beside, then renamed,
 * so a copy that dies half-way leaves no file `qcr open` could pick up. */
function placeCopy(dir: string, sub: string, name: string, data: string | Buffer): string {
  const target = join(dir, sub);
  try {
    chmodSync(target, 0o755);
  } catch {
    // not there yet
  }
  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  const file = join(target, name);
  const partial = join(dir, `.${name}.partial`);
  writeFileSync(partial, data, { mode: 0o444 });
  renameSync(partial, file);
  return file;
}

function record(dir: string, body: Record<string, unknown>): void {
  writeFileSync(join(dir, OPEN_PR_RECORD), `${JSON.stringify(body, null, 2)}\n`);
}

/** Pull what `o` names; see the file header. A refusal or a failed read of the box is a
 * PrPull; a failure writing the local copy rejects. */
export async function pullPrSession(o: OpenPrOptions, deps: PrPullDeps): Promise<PrPull> {
  const { cfg, ssh } = deps;
  const root = await resolveLayout(cfg, ssh);
  const where = `${cfg.target === "local" ? "this machine" : cfg.ssh_host}`;
  const base = join(deps.home, "open", `pr-${o.pr}`);
  const listed = await ssh(cfg.ssh_host, listArgv(cfg, deps.sessionDir, o.pr), {
    timeoutMs: cfg.evidence_timeout_s * 1000,
  });
  if (!listed.ok) return fail(`could not list pr-${o.pr} on ${where}: ${lastLine(listed)}`);
  const all = parseListing(listed.stdout, root, deps.sessionDir, o.pr);

  // A lens pass.
  if (o.lens !== undefined) {
    const lenses = all.filter((l) => l.kind === "lens");
    if (lenses.length === 0)
      return fail(
        `pr-${o.pr} kept no lens sessions on ${where}: a tmux-hosted lens pass is a child of the PR's ` +
          "session and has no file of its own; workers persist them (P8.3). Open the PR's session without --lens.",
      );
    const idOf = (l: Listed): string => basename(dirname(l.path));
    const ids = [...new Set(lenses.map(idOf))];
    const hit = ids.includes(o.lens) ? [o.lens] : ids.filter((i) => i.startsWith(o.lens!));
    if (hit.length !== 1)
      return fail(
        hit.length === 0
          ? `no lens session ${o.lens} on pr-${o.pr}; it kept: ${ids.join(", ")}`
          : `more than one lens session starts with ${o.lens}: ${hit.join(", ")}`,
      );
    const pick = lenses
      .filter((l) => idOf(l) === hit[0])
      .sort((a, b) => b.mtimeS - a.mtimeS || b.path.localeCompare(a.path))[0]!;
    const read = await readLive(pick, deps);
    if ("error" in read) return fail(read.error);
    const got = wholeLines(read.text);
    if (got === null || sessionIdOf(got) === null)
      return fail(`${pick.path} on ${where} is not a pi session (no header line)`);
    const file = placeCopy(base, join(LENS_SESSIONS_DIR, hit[0]!), basename(pick.path), got);
    record(base, {
      version: 1,
      pr: o.pr,
      source: "live",
      from: where,
      remote_path: pick.path,
      bytes: Buffer.byteLength(got),
      sha256: sha256(got),
      lens: hit[0],
      session_id: sessionIdOf(got),
      fetched_at: (deps.now?.() ?? new Date()).toISOString(),
    });
    return {
      ok: true,
      dir: base,
      file,
      source: "live",
      kind: "lens",
      bytes: Buffer.byteLength(got),
      note: `Copied lens ${hit[0]} of pr-${o.pr} from ${where} (${mib(Buffer.byteLength(got))}) to ${file}`,
    };
  }

  // The PR's session: live first, the archive when nothing is live.
  const live = all
    .filter((l) => l.kind === "live")
    .sort((a, b) => b.mtimeS - a.mtimeS || b.path.localeCompare(a.path))[0];
  let text: string;
  let source: "live" | "archive";
  let remotePath: string;
  if (live !== undefined) {
    const read = await readLive(live, deps);
    if ("error" in read) return fail(read.error);
    text = read.text;
    source = "live";
    remotePath = live.path;
  } else {
    const manifest = all.find((l) => l.kind === "archive-manifest");
    if (manifest === undefined)
      return fail(`pr-${o.pr} has no session on ${where}, live or archived`);
    const got = await pullArchived(o.pr, manifest.path, deps);
    if (typeof got === "string") return fail(got);
    ({ text, remotePath } = got);
    source = "archive";
  }

  const whole = wholeLines(text);
  if (whole === null || sessionIdOf(whole) === null)
    return fail(`${remotePath} on ${where} is not a pi session (no header line)`);
  text = whole;
  let cut: { round: number; until: string; kept: number; dropped: number } | null = null;
  if (o.round !== undefined) {
    const why = await ssh(cfg.ssh_host, whyArgv(cfg, o.pr), {
      timeoutMs: cfg.evidence_timeout_s * 1000,
    });
    if (!why.ok) return fail(`could not read pr-${o.pr}'s rounds on ${where}: ${lastLine(why)}`);
    const rounds = readWhyRounds(why.stdout);
    const round = rounds?.find((r) => r.round_no === o.round);
    if (rounds === undefined || round === undefined || round.finished_at === null)
      return fail(
        `pr-${o.pr} has no finished round ${o.round}` +
          (rounds && rounds.length > 0
            ? ` (finished: ${rounds.map((r) => r.round_no).join(", ")})`
            : ""),
      );
    const until = Date.parse(round.finished_at);
    if (!Number.isFinite(until)) return fail(`round ${o.round} has no usable finish time`);
    const cutText = cutAtTime(text, until);
    if (cutText === null)
      return fail(
        `round ${o.round} finished before the session recorded anything (${round.finished_at})`,
      );
    text = cutText.text;
    cut = {
      round: o.round,
      until: round.finished_at,
      kept: cutText.kept,
      dropped: cutText.dropped,
    };
  }

  const dir = cut ? join(base, `round-${cut.round}`) : base;
  mkdirSync(dir, { recursive: true });
  const file = placeCopy(dir, MAIN_SESSION_DIR, basename(remotePath).replace(/\.gz$/, ""), text);
  record(dir, {
    version: 1,
    pr: o.pr,
    source,
    from: where,
    remote_path: remotePath,
    bytes: Buffer.byteLength(text),
    sha256: sha256(text),
    session_id: sessionIdOf(text),
    round: cut,
    fetched_at: (deps.now?.() ?? new Date()).toISOString(),
  });
  return {
    ok: true,
    dir,
    file,
    source,
    kind: "main",
    bytes: Buffer.byteLength(text),
    note:
      `Copied pr-${o.pr}'s ${source === "live" ? "live" : "archived"} session from ${where} ` +
      `(${mib(Buffer.byteLength(text))}${cut ? `, as it stood when round ${cut.round} finished: ${cut.kept} entries, ${cut.dropped} later ones left out` : ""}) to ${file}`,
  };
}

/** One live file, read to the size the listing saw; the text, or why not. */
async function readLive(
  l: Listed,
  deps: PrPullDeps,
): Promise<{ text: string } | { error: string }> {
  const { cfg } = deps;
  if (l.bytes > OPEN_PR_MAX_BYTES)
    return {
      error: `${l.path} is ${mib(l.bytes)}, over the ${mib(OPEN_PR_MAX_BYTES)} a pull takes`,
    };
  const r = await deps.ssh(cfg.ssh_host, readArgv(cfg, l.path, l.bytes), {
    timeoutMs: budgetMs(cfg, l.bytes),
  });
  if (!r.ok) return { error: `could not read ${l.path}: ${lastLine(r)}` };
  if (r.stdout.length === 0) return { error: `${l.path} came back empty` };
  return { text: r.stdout };
}

/**
 * The newest archived transcript, through `extractPr` on a mirror: the manifest and
 * the one gzip are read off the box, laid out as an archive root, and extracted
 * with every byte checked against the sha256 the manifest records.
 */
async function pullArchived(
  pr: number,
  manifestPath: string,
  deps: PrPullDeps,
): Promise<string | { text: string; remotePath: string }> {
  const { cfg, ssh } = deps;
  const root = remoteSandboxRoot(cfg);
  const mtext = await ssh(cfg.ssh_host, readArgv(cfg, manifestPath, 64 * 1024 * 1024), {
    timeoutMs: cfg.evidence_timeout_s * 1000,
  });
  if (!mtext.ok) return `could not read the archive manifest of pr-${pr}: ${lastLine(mtext)}`;
  const manifest = parseArchiveManifest(mtext.stdout);
  if (manifest === null) return `pr-${pr}'s archive manifest does not parse`;
  const role = archivedRole(manifest, "transcript", pr, 0, deps.sessionDir);
  if (role === null) return `pr-${pr}'s archive holds no session transcript`;
  const rel = role.pointer.slice(`archive/pr-${pr}/`.length);
  const entries = manifest.entries.filter(
    (e) => (e.kind === "transcript" || e.kind === "file") && e.archive === rel,
  );
  const gzBytes = entries[0] && "gz_bytes" in entries[0] ? entries[0].gz_bytes : 0;
  if (gzBytes > OPEN_PR_MAX_BYTES)
    return `${rel} is ${mib(gzBytes)} compressed, over the ${mib(OPEN_PR_MAX_BYTES)} a pull takes`;
  const gzPath = `${root}/archive/pr-${pr}/${rel}`;
  if (!isShellSafePath(gzPath) || rel.includes("..")) return `${rel} is not a plain archive name`;
  const gz = await ssh(cfg.ssh_host, readBase64Argv(cfg, gzPath), {
    timeoutMs: budgetMs(cfg, gzBytes * 1.4),
  });
  if (!gz.ok) return `could not read ${gzPath}: ${lastLine(gz)}`;
  const bytes = Buffer.from(gz.stdout.trim(), "base64");
  if (gzBytes > 0 && bytes.length !== gzBytes)
    return `${rel} came back as ${bytes.length} bytes, the manifest records ${gzBytes}`;

  mkdirSync(join(deps.home, "open"), { recursive: true });
  const scratch = mkdtempSync(join(deps.home, "open", "pull-"));
  try {
    const mirror = join(scratch, "root");
    const adir = join(mirror, "archive", `pr-${pr}`);
    mkdirSync(dirname(join(adir, rel)), { recursive: true });
    writeFileSync(join(adir, rel), bytes);
    // Only the chosen gzip is on the mirror, so the manifest says only that.
    writeFileSync(
      join(adir, "manifest.json"),
      JSON.stringify({ ...manifest, entries }, null, 1) + "\n",
    );
    const to = join(scratch, "extracted");
    const res = await deps.extract({
      root: mirror,
      sessionsRoot: join(mirror, deps.sessionDir),
      to,
      pr,
    });
    if (!res.ok) return `the archive extract was refused: ${res.reason}`;
    if (res.errors.length > 0)
      return `the archive extract failed: ${res.errors.map((e) => `${e.path}: ${e.error}`).join("; ")}`;
    const out = res.files.find((f) => f.from === rel);
    if (out === undefined) return `the archive extract produced nothing for ${rel}`;
    return { text: readFileSync(join(to, out.path), "utf8"), remotePath: gzPath };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
