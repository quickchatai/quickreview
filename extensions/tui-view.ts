// tui-view — the companion's read-only window onto the operator's
// view: what is on the owner's screen right now, and the derived state behind it.
//
// THE ONE RULE, AND IT IS STRUCTURAL: these tools READ STATE THE TUI HAS
// ALREADY FETCHED. They are never a fetcher.
//
// Every value they return was produced by the TUI, on the owner's machine, with
// the owner's ssh credential, for the owner's own screen, and written to a file on
// a bind mount. Nothing here opens a socket, spawns a process, or asks the TUI
// to go and get anything. That is not a matter of taste: the TUI's reach is
// real (`src/tui/remote.ts` runs `ssh <host> …`, and the deploy tab can run
// `deploy.sh sync`), and root CLAUDE.md rule 8 says the companion holds NO VM
// credential. A `tui_*` tool that could trigger a fetch would let the companion
// make the TUI act on the VM on its behalf — laundering the operator's access
// through a read verb. So:
//
//   * the only imports are `node:fs` (read) and `node:path` — no
//     `node:child_process`, no `node:net/http/https`, no `fetch`, no import of
//     anything under `src/`, above all not `remote.ts`;
//   * no tool takes a parameter. There is no host to name, no command to pass,
//     no path to traverse — the tools read three fixed filenames under
//     `$QCR_FEED_DIR` and nothing else;
//   * a missing or stale file is ANSWERED AS SUCH ("the TUI is closed"), never
//     refreshed. Staleness is information; a refresh would be reach.
//
// `tests/tui-view-extension.test.ts` pins all three.
//
// The companion writing to the TUI is a different, already-ratified channel
// (`/alerts/tui-actions/`) with its own validation and its own
// whitelist. Nothing here is a second one: no tool writes anything, anywhere.
//
// pi is not installed here — everything touching the pi API is VERIFY-ON-PIN.
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Pi, PiToolDefinition, PiToolResult } from "@earendil-works/pi-coding-agent";

/** The three files the TUI publishes. Fixed names — never a tool parameter. */
export const VIEW_FILE = "view.json";
export const SCREEN_FILE = "screen.txt";

/** Past this, an answer says STALE before it says anything else. The TUI
 * republishes on every repaint and every 3 s poll, so anything older than this
 * means it is closed, suspended or wedged. */
export const STALE_AFTER_MS = 30_000;

/** The tools this extension registers. Exported so the test can assert the
 * surface is exactly these, all reads. */
export const TOOL_NAMES = ["tui_screen", "tui_deploy", "tui_board"] as const;

export function resolveFeedDir(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.QCR_FEED_DIR?.trim();
  if (explicit) return explicit;
  const root = env.QCR_ROOT?.trim() || process.cwd();
  return join(root, "state", "companion", "feed");
}

export interface ReadResult {
  ok: boolean;
  body?: string;
  /** Modification time of the file, ms — the fallback freshness stamp. */
  mtimeMs?: number;
  error?: string;
}

/** Read one published file. The ONLY I/O in this module, and it is a read. */
export function readFeedFile(dir: string, name: string): ReadResult {
  try {
    const path = join(dir, name);
    const body = readFileSync(path, "utf8");
    return { ok: true, body, mtimeMs: statSync(path).mtimeMs };
  } catch {
    return {
      ok: false,
      error:
        `The TUI has published no ${name}. It is probably not running — and I cannot fetch it: ` +
        `these tools only read what the TUI already wrote. Ask the owner whether their TUI is up.`,
    };
  }
}

/** One line stamping how old the answer is. Unknown age is reported as
 * unknown; it is never quietly treated as fresh. */
export function freshness(writtenAt: string | undefined, now: Date, mtimeMs?: number): string {
  const t = writtenAt ? Date.parse(writtenAt) : mtimeMs !== undefined ? mtimeMs : Number.NaN;
  if (!Number.isFinite(t)) return "Age unknown — treat as possibly stale.";
  const ageMs = now.getTime() - t;
  const stamp = new Date(t).toISOString();
  const ageS = Math.max(0, Math.round(ageMs / 1000));
  if (ageMs > STALE_AFTER_MS) {
    return (
      `STALE — written ${stamp}, ${ageS}s ago. The TUI is closed, suspended or wedged. ` +
      `This is what WAS on screen, not what is. Say so rather than presenting it as current.`
    );
  }
  return `Live — as of ${stamp} (${ageS}s ago).`;
}

const text = (body: string): PiToolResult => ({ content: [{ type: "text", text: body }] });

/** No parameters, by design (see the header). VERIFY-ON-PIN: a plain JSON
 * Schema object where the vendored fork passes a TypeBox schema. */
const NO_PARAMS = { type: "object", properties: {}, additionalProperties: false, required: [] as string[] };

interface ViewJson {
  written_at?: string;
  deploy?: Record<string, unknown>;
  board?: Record<string, unknown>;
  selected?: Record<string, unknown>;
  pane?: Record<string, unknown>;
  screen?: Record<string, unknown>;
  notice?: string;
}

function loadView(dir: string): { view?: ViewJson; mtimeMs?: number; error?: string } {
  const raw = readFeedFile(dir, VIEW_FILE);
  if (!raw.ok) return { error: raw.error };
  try {
    return { view: JSON.parse(raw.body ?? "{}") as ViewJson, mtimeMs: raw.mtimeMs };
  } catch {
    return { error: `${VIEW_FILE} is unreadable (torn or malformed JSON). Nothing about the TUI's view can be said from here.` };
  }
}

/**
 * One `label: value` line, or nothing when the field is genuinely ABSENT.
 *
 * `null` is not absent — it is the producer saying "I could not read this"
 *. Dropping the line made an unread working tree and an unproven
 * dry-run flag look like nothing worth mentioning, so a companion asked
 * "anything to deploy?" answered with a quiet all-clear built from data the
 * TUI never had. An explicit unknown is the whole point of the null.
 */
function fmt(label: string, value: unknown): string | undefined {
  if (value === null) return `${label}: UNKNOWN (the TUI has not been able to read this)`;
  if (value === undefined || value === "") return undefined;
  return `${label}: ${typeof value === "object" ? JSON.stringify(value) : String(value)}`;
}

/** The VM's BUILD_SHA marker as `view.json` carries it: its fields, the
 * string `"absent"` for a VM this system has never deployed to, the string
 * `"unparseable"` for a marker the TUI read but could not parse, or `null`
 * for a read that failed. Four different sentences — a VM that was never
 * deployed to, a VM whose marker is corrupt and a VM that could not be asked
 * must not read alike. */
function deployedLines(value: unknown): Array<string | undefined> {
  if (value === "absent") {
    return ["VM is running: no BUILD_SHA marker on the VM — this system has never deployed to it (the first deploy writes one)"];
  }
  if (value === "unparseable") {
    return ["VM is running: UNKNOWN — the VM's BUILD_SHA marker was read but is not a <sha> <iso> <mode> line (corrupt marker; the next deploy rewrites it)"];
  }
  if (typeof value !== "object" || value === null) return [fmt("VM is running", null)];
  const marker = value as { sha?: unknown; at?: unknown; mode?: unknown };
  return [fmt("VM is running", marker.sha), fmt("deployed at", marker.at), fmt("deploy mode", marker.mode)];
}

/** `""` is docker's own answer — it listed no container by that name — and
 * is said as such rather than dropped like a blank field. */
function containerLine(status: unknown): string | undefined {
  if (status === "") return "container: docker lists no container by that name (never created, or removed)";
  return fmt("container", status);
}

// ---- the three answers ------------------------------------------------------

export function screenAnswer(dir: string, now: Date): string {
  const meta = loadView(dir);
  const raw = readFeedFile(dir, SCREEN_FILE);
  if (!raw.ok) return raw.error ?? "no screen";
  const head = freshness(meta.view?.written_at, now, raw.mtimeMs);
  const body = raw.body ?? "";
  if (body.trim() === "") {
    return `${head}\nThe TUI painted no composed frame (a tab that renders as plain text, or it is suspended).`;
  }
  return `${head}\nThis is the owner's screen, exactly as painted (ANSI stripped).\n\n${body}`;
}

export function deployAnswer(dir: string, now: Date): string {
  const { view, mtimeMs, error } = loadView(dir);
  if (error !== undefined || !view) return error ?? "no view";
  const head = freshness(view.written_at, now, mtimeMs);
  const d = view.deploy ?? {};
  if (d.loaded !== true) {
    return `${head}\nThe deploy tab has not loaded its state yet (nobody has opened it this run), so the deployed commit is unknown.`;
  }
  const commits = Array.isArray(d.pending_commits) ? (d.pending_commits as string[]) : [];
  const lines = [
    ...deployedLines(d.deployed),
    // A key the producer did not write at all is read as unread, never as
    // absent: once the tab has loaded, every one of these is a fact the TUI
    // either fetched or failed to fetch.
    fmt("local HEAD", d.head ?? null),
    fmt("dirty files in the local checkout", d.dirty_files),
    fmt("commits waiting to ship", d.pending_commit_count),
    fmt("diffstat", d.diffstat_summary),
    containerLine(d.container_status ?? null),
    fmt("run in flight", d.run),
  ].filter((l): l is string => l !== undefined);
  const tail = commits.length > 0 ? `\n\nPending commits (newest first):\n${commits.join("\n")}` : "";
  return `${head}\n${lines.join("\n")}${tail}`;
}

export function boardAnswer(dir: string, now: Date): string {
  const { view, mtimeMs, error } = loadView(dir);
  if (error !== undefined || !view) return error ?? "no view";
  const head = freshness(view.written_at, now, mtimeMs);
  const b = view.board ?? {};
  const lines = [
    fmt("tab on screen", (view.screen ?? {}).tab),
    fmt("daemon health", b.health),
    fmt("dry run", b.dry_run),
    fmt("open PRs", b.total),
    fmt("by state", b.by_state),
    fmt("rounds running", b.running_rounds),
    fmt("max concurrent rounds", b.max_concurrent_rounds),
    fmt("spend today (USD)", b.today_spend_usd),
    fmt("snapshot written at", b.snapshot_written_at),
    fmt("selected PR", view.selected),
    fmt("pi pane", view.pane),
    fmt("notice line", view.notice),
  ].filter((l): l is string => l !== undefined);
  return (
    `${head}\n${lines.join("\n")}\n\n` +
    `This is a projection, not the whole board — /feed/snapshot.json has every PR row.`
  );
}

// ---- registration -----------------------------------------------------------

export function toolDefinitions(dir: string, now: () => Date = () => new Date()): PiToolDefinition[] {
  const READ_ONLY = "Read-only: it reads a file the TUI already wrote; it cannot fetch anything, and it changes nothing.";
  return [
    {
      name: "tui_screen",
      label: "TUI screen",
      description:
        "What is on the owner's qcr TUI screen right now — the last painted frame as plain text, including the companion column. " +
        "Use it when he says 'this one' / 'what I'm looking at', or to read pi output he can see. " +
        READ_ONLY,
      promptSnippet: "Read the operator's TUI screen as plain text",
      parameters: NO_PARAMS,
      execute: () => text(screenAnswer(dir, now())),
    },
    {
      name: "tui_deploy",
      label: "TUI deploy state",
      description:
        "What commit the VM is actually running (its BUILD_SHA), local HEAD, whether the checkout is dirty, and the commits waiting to ship. " +
        READ_ONLY,
      promptSnippet: "Read the deployed commit and what is waiting to ship",
      parameters: NO_PARAMS,
      execute: () => text(deployAnswer(dir, now())),
    },
    {
      name: "tui_board",
      label: "TUI board state",
      description:
        "A small projection of the board behind the screen: tab, daemon health, PR counts by state, rounds running, today's spend, and the PR the owner has selected. " +
        READ_ONLY,
      promptSnippet: "Read the board summary and the selected PR",
      parameters: NO_PARAMS,
      execute: () => text(boardAnswer(dir, now())),
    },
  ];
}

export const activate = (pi: Pi, env: NodeJS.ProcessEnv = process.env): void => {
  // A pi without registerTool registers nothing and says nothing — the
  // companion must still start (rule: it never wedges).
  if (typeof pi.registerTool !== "function") return;
  const dir = resolveFeedDir(env);
  for (const def of toolDefinitions(dir)) pi.registerTool(def);
};

export default activate;
