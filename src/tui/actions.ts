// Companion → TUI action channel.
//
// The companion (a local pi in a docker container, no VM credentials, no
// keyboard) drives the operator's TUI by dropping request files into
// `<alerts_dir>/tui-actions/<iso-ts>-<slug>.json`. The TUI sweeps the
// directory on its poll cadence, validates each request against a strict
// schema, and executes it against the `TuiDriver` the wiring supplies.
//
// Actions execute instantly — there is no confirm gate, by design: everything
// a request can do is something the operator's own keyboard can do on the TUI
// (tab switches, selections, filters, quick-messages, the deploy-tab buttons),
// the request files are on the operator's own machine, and the executed trace
// lands on the notice line, so a surprising action is visible the moment it
// happens. Do not add a confirmation step here.
//
// One memory verb, and only one (`memory_pin`, root CLAUDE.md rule 8): the
// companion may pin or unpin an EXISTING entry, and the TUI performs it
// through its one `MemoryStore` — the same copy-then-stub move as the memory
// tab's `p`, against the entry as a fresh read finds it, and the result file
// carries the store's answer. Nothing else about memory rides this channel:
// the companion writes its own entries with its own keys, and no other
// memory write may be requested through a file.
//
// Idempotency (archive before execute): a request is archived to `.done/`
// BEFORE it is executed — a crash mid-execute must not re-run it on the next
// sweep (msg_session/overseer_inject would double-send, deploy_tab would
// double-arm). A crash after archive but before execute
// loses one request; the companion sees the missing result and re-requests —
// the safer failure. Results are written to `<name>.result.json` beside the
// request; malformed/unknown requests produce a refused result, never a
// crash.
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { BoardFilter } from "./filters.js";
import { STATE_GLYPHS } from "./model.js";
import { isValidSessionName } from "./msg.js";
import { TABS, isTab, type Tab } from "./tabs.js";

// ---- the executor seam ------------------------------------------------------

/** What the TUI exposes to the action channel — supplied at wiring time
 * (see docs/tui-actions-wiring.md for the ~30-line production impl). */
export interface TuiDriver {
  switchTab(tab: Tab): void;
  selectPr(pr: number): void;
  metricsWindow(w: "7d" | "30d" | "all"): void;
  metricsPr(pr: number): void;
  /** The digest tab, paged to that day. */
  digestDay(date: string): void;
  /** The memory tab: `tag` filters the timeline, `day` jumps to that day's entries. */
  memoryView(opts: { day?: string; tag?: string }): void;
  /** Pin or unpin one EXISTING memory entry through the TUI's ONE
   * `MemoryStore` — the same verb as the memory tab's `p`: the entry MOVES
   * into `preferences/pinned/` (the round's guaranteed head) or back out.
   * `entry` is the TUI's id (`reviewer:experiences/x.md`) or the entry's
   * `viking://user/<user>/memories/…` URI. Resolves with the store's message;
   * REJECTS on a refusal, so the result file says it failed. Pin and unpin
   * ONLY — the driver has no other memory method. */
  memoryPin(entry: string, pin: boolean): Promise<string>;
  setBoardFilter(f: BoardFilter | null): void;
  setMemoryFilter(tag: string | null): void;
  /** A quick-message to `session` (`overseerInject`: to the overseer).
   * Resolves with the delivered label once the inject bridge consumed it;
   * REJECTS when it went undelivered, so the result file says it failed. */
  msgSession(session: string, text: string): Promise<string>;
  overseerInject(text: string): Promise<string>;
  deployTab(action: "deploy" | "stop" | "start" | "abort"): void;
}

// ---- the schema -------------------------------------------------------------

export type TuiAction =
  | { verb: "switch_tab"; tab: Tab }
  | { verb: "select_pr"; pr: number }
  | { verb: "metrics"; window: "7d" | "30d" | "all" }
  | { verb: "metrics"; pr: number }
  | { verb: "digest_day"; date: string }
  | { verb: "memory_view"; day?: string; tag?: string }
  | { verb: "board_filter"; filter: BoardFilter | null }
  | { verb: "memory_filter"; tag: string | null }
  | { verb: "memory_pin"; entry: string; pin: boolean }
  | { verb: "msg_session"; session: string; text: string }
  | { verb: "overseer_inject"; text: string }
  | { verb: "deploy_tab"; action: "deploy" | "stop" | "start" | "abort" };

export const ACTION_TEXT_MAX = 2000;

const WINDOWS = new Set(["7d", "30d", "all"]);
const DEPLOY_ACTIONS = new Set(["deploy", "stop", "start", "abort"]);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** The only params `memory_pin` takes. Anything else is REFUSED, not
 * ignored: a request that reads like an edit (`text`, `op`, `content`) must
 * fail loudly rather than quietly pin (pin and unpin only). */
const MEMORY_PIN_PARAMS = new Set(["entry", "pin"]);
/** The daemon's lifecycle state strings — the only values a board state
 * filter can name (a typo would silently filter the board to nothing). */
const STATES = new Set(Object.keys(STATE_GLYPHS));

/** Positive-integer PR number; digit strings are coerced (the companion is an
 * LLM — the same courtesy verdicts.ts extends to pr/round_no). */
function prNumber(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isInteger(v) && v > 0) return v;
  if (typeof v === "string" && /^\d+$/.test(v)) return Number(v);
  return undefined;
}

function boundedText(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  if (t.length === 0 || t.length > ACTION_TEXT_MAX) return undefined;
  return t;
}

function tagText(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim().replace(/^#+/, "");
  if (t.length === 0 || t.length > 100) return undefined;
  return t;
}

/** Strict parse of one request file's text. Unknown verbs, malformed params,
 * oversized text → a refusal (recorded in the result file), never a throw. */
export function parseTuiAction(
  text: string,
): { ok: true; action: TuiAction } | { ok: false; error: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: "not JSON" };
  }
  if (typeof raw !== "object" || raw === null) return { ok: false, error: "not an object" };
  const r = raw as Record<string, unknown>;
  const verb = r["verb"];
  if (typeof verb !== "string") return { ok: false, error: "missing verb" };
  const pRaw = r["params"] ?? {};
  if (typeof pRaw !== "object" || pRaw === null || Array.isArray(pRaw))
    return { ok: false, error: "params must be an object" };
  const p = pRaw as Record<string, unknown>;

  switch (verb) {
    case "switch_tab": {
      const tab = p["tab"];
      // The eight surfaces, by the one name each has everywhere (src/tui/tabs.ts).
      if (!isTab(tab)) return { ok: false, error: `switch_tab needs tab: ${TABS.join("|")}` };
      return { ok: true, action: { verb, tab } };
    }
    case "select_pr": {
      const pr = prNumber(p["pr"]);
      if (pr === undefined) return { ok: false, error: "select_pr needs a positive integer pr" };
      return { ok: true, action: { verb, pr } };
    }
    case "metrics": {
      const hasWindow = p["window"] !== undefined;
      const hasPr = p["pr"] !== undefined;
      if (hasWindow === hasPr)
        return { ok: false, error: "metrics needs exactly one of window|pr" };
      if (hasWindow) {
        const w = p["window"];
        if (typeof w !== "string" || !WINDOWS.has(w))
          return { ok: false, error: "metrics window must be 7d|30d|all" };
        return { ok: true, action: { verb, window: w as "7d" | "30d" | "all" } };
      }
      const pr = prNumber(p["pr"]);
      if (pr === undefined) return { ok: false, error: "metrics pr must be a positive integer" };
      return { ok: true, action: { verb, pr } };
    }
    case "digest_day": {
      const date = p["date"];
      if (typeof date !== "string" || !DATE_RE.test(date))
        return { ok: false, error: "digest_day needs date: YYYY-MM-DD" };
      return { ok: true, action: { verb, date } };
    }
    case "memory_view": {
      const out: { verb: "memory_view"; day?: string; tag?: string } = { verb };
      if (p["day"] !== undefined) {
        if (typeof p["day"] !== "string" || !DATE_RE.test(p["day"]))
          return { ok: false, error: "memory_view day must be YYYY-MM-DD" };
        out.day = p["day"];
      }
      if (p["tag"] !== undefined) {
        const tag = tagText(p["tag"]);
        if (tag === undefined)
          return { ok: false, error: "memory_view tag must be a short non-empty string" };
        out.tag = tag;
      }
      return { ok: true, action: out };
    }
    case "board_filter": {
      if (p["clear"] === true) return { ok: true, action: { verb, filter: null } };
      const filter: BoardFilter = {};
      if (p["author"] !== undefined) {
        if (
          typeof p["author"] !== "string" ||
          p["author"].trim().length === 0 ||
          p["author"].length > 100
        )
          return { ok: false, error: "board_filter author must be a short non-empty string" };
        filter.author = p["author"].trim();
      }
      if (p["state"] !== undefined) {
        if (typeof p["state"] !== "string" || !STATES.has(p["state"]))
          return { ok: false, error: `board_filter state must be one of ${[...STATES].join("|")}` };
        filter.state = p["state"];
      }
      if (filter.author === undefined && filter.state === undefined)
        return { ok: false, error: "board_filter needs author and/or state, or clear: true" };
      return { ok: true, action: { verb, filter } };
    }
    case "memory_filter": {
      if (p["clear"] === true) return { ok: true, action: { verb, tag: null } };
      const tag = tagText(p["tag"]);
      if (tag === undefined)
        return { ok: false, error: "memory_filter needs tag (or clear: true)" };
      return { ok: true, action: { verb, tag } };
    }
    case "memory_pin": {
      const extra = Object.keys(p).filter((k) => !MEMORY_PIN_PARAMS.has(k));
      if (extra.length > 0)
        return {
          ok: false,
          error: `memory_pin takes only entry and pin — it pins or unpins an existing entry and writes nothing else (refused: ${extra.join(", ")})`,
        };
      const entry = p["entry"];
      if (
        typeof entry !== "string" ||
        entry.trim() === "" ||
        entry.length > 300 ||
        /\s|\.\./.test(entry.trim())
      )
        return {
          ok: false,
          error:
            "memory_pin needs entry: the TUI's id (reviewer:experiences/<file>.md) or its viking:// URI",
        };
      if (p["pin"] !== true && p["pin"] !== false)
        return { ok: false, error: "memory_pin needs pin: true (pin) or false (unpin)" };
      return { ok: true, action: { verb, entry: entry.trim(), pin: p["pin"] } };
    }
    case "msg_session": {
      const session = p["session"];
      if (typeof session !== "string" || !isValidSessionName(session))
        return { ok: false, error: "msg_session session must be pr-<n>, overseer, or main" };
      const text = boundedText(p["text"]);
      if (text === undefined)
        return { ok: false, error: `msg_session text must be 1..${ACTION_TEXT_MAX} chars` };
      return { ok: true, action: { verb, session, text } };
    }
    case "overseer_inject": {
      const text = boundedText(p["text"]);
      if (text === undefined)
        return { ok: false, error: `overseer_inject text must be 1..${ACTION_TEXT_MAX} chars` };
      return { ok: true, action: { verb, text } };
    }
    case "deploy_tab": {
      const action = p["action"];
      if (typeof action !== "string" || !DEPLOY_ACTIONS.has(action))
        return { ok: false, error: "deploy_tab needs action: deploy|stop|start|abort" };
      return {
        ok: true,
        action: { verb, action: action as "deploy" | "stop" | "start" | "abort" },
      };
    }
    default:
      return { ok: false, error: `unknown verb '${verb}'` };
  }
}

// ---- execution --------------------------------------------------------------

/** Run one parsed action against the driver; returns the one-line human trace
 * for the notice line. The driver's methods are the whole side-effect surface.
 * The one memory write (`memory_pin` — pin/unpin of an existing entry) is
 * asynchronous and resolves once the store has answered; every other verb is
 * synchronous. */
export function executeTuiAction(a: TuiAction, driver: TuiDriver): string | Promise<string> {
  switch (a.verb) {
    case "switch_tab":
      driver.switchTab(a.tab);
      return `companion ▸ tab → ${a.tab}`;
    case "select_pr":
      driver.selectPr(a.pr);
      return `companion ▸ board → #${a.pr}`;
    case "metrics":
      if ("window" in a) {
        driver.metricsWindow(a.window);
        return `companion ▸ metrics window → ${a.window}`;
      }
      driver.metricsPr(a.pr);
      return `companion ▸ metrics → #${a.pr} timeline`;
    case "digest_day":
      driver.digestDay(a.date);
      return `companion ▸ digest → ${a.date}`;
    case "memory_view": {
      const opts: { day?: string; tag?: string } = {};
      if (a.day !== undefined) opts.day = a.day;
      if (a.tag !== undefined) opts.tag = a.tag;
      driver.memoryView(opts);
      const bits = [a.day, a.tag ? `#${a.tag}` : undefined].filter((b) => b !== undefined);
      return `companion ▸ memory view${bits.length > 0 ? ` · ${bits.join(" · ")}` : ""}`;
    }
    case "board_filter":
      driver.setBoardFilter(a.filter);
      return a.filter === null
        ? "companion ▸ board filter cleared"
        : `companion ▸ board filter → ${[a.filter.author ? `author:${a.filter.author}` : undefined, a.filter.state ? `state:${a.filter.state}` : undefined].filter(Boolean).join(" · ")}`;
    case "memory_filter":
      driver.setMemoryFilter(a.tag);
      return a.tag === null
        ? "companion ▸ memory filter cleared"
        : `companion ▸ memory filter → #${a.tag}`;
    case "memory_pin":
      return driver
        .memoryPin(a.entry, a.pin)
        .then((message) => `companion ▸ memory ${a.pin ? "pin" : "unpin"} → ${message}`);
    case "msg_session":
      return driver
        .msgSession(a.session, a.text)
        .then((label) => `companion ▸ msg ${a.session} (${a.text.length} chars) → ${label}`);
    case "overseer_inject":
      return driver
        .overseerInject(a.text)
        .then((label) => `companion ▸ overseer inject (${a.text.length} chars) → ${label}`);
    case "deploy_tab":
      driver.deployTab(a.action);
      return `companion ▸ deploy tab → ${a.action}`;
  }
}

// ---- the sweep --------------------------------------------------------------

export interface ProcessedAction {
  file: string;
  ok: boolean;
  /** Refusal reason, or the executed trace. */
  message: string;
  /** Set iff executed — the notice-line text. */
  trace?: string;
}

/** Result files older than this are swept; `.done/` keeps the newest N. */
const RESULT_TTL_MS = 24 * 3600 * 1000;
const DONE_KEEP = 200;

/** One sweep of `<alerts_dir>/tui-actions/`. Serialized by the caller's poll
 * cadence (busy flag at the wiring site — see docs/tui-actions-wiring.md).
 * Archive-BEFORE-execute per the module header; a driver throw records a
 * failed result and the sweep moves on. */
export async function processTuiActions(
  dir: string,
  driver: TuiDriver,
): Promise<ProcessedAction[]> {
  const out: ProcessedAction[] = [];
  if (!existsSync(dir)) return out;
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".json") && !f.endsWith(".result.json"))
    .sort();
  const doneDir = join(dir, ".done");
  if (files.length > 0) mkdirSync(doneDir, { recursive: true });
  for (const file of files) {
    let text: string;
    try {
      text = readFileSync(join(dir, file), "utf8");
      renameSync(join(dir, file), join(doneDir, file));
    } catch {
      continue; // vanished mid-sweep (companion rewrote it?) — next sweep sees the survivor
    }
    let ok = false;
    let message: string;
    let trace: string | undefined;
    const parsed = parseTuiAction(text);
    if (!parsed.ok) {
      message = `refused: ${parsed.error}`;
    } else {
      try {
        trace = await executeTuiAction(parsed.action, driver);
        ok = true;
        message = trace;
      } catch (err) {
        message = `execute failed: ${String(err instanceof Error ? err.message : err)}`;
      }
    }
    try {
      writeFileSync(
        join(dir, `${file.replace(/\.json$/, "")}.result.json`),
        JSON.stringify({ ok, message, file }, null, 2) + "\n",
      );
    } catch {
      /* a result we cannot write must not kill the sweep */
    }
    out.push(trace !== undefined ? { file, ok, message, trace } : { file, ok, message });
  }
  cleanup(dir, doneDir);
  return out;
}

/** Bounded housekeeping: results past their TTL, `.done/` past its cap. */
function cleanup(dir: string, doneDir: string): void {
  try {
    const now = Date.now();
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".result.json")) continue;
      if (now - statSync(join(dir, f)).mtimeMs > RESULT_TTL_MS)
        rmSync(join(dir, f), { force: true });
    }
    if (!existsSync(doneDir)) return;
    const done = readdirSync(doneDir).sort(); // iso-ts names: oldest first
    for (const f of done.slice(0, Math.max(0, done.length - DONE_KEEP)))
      rmSync(join(doneDir, f), { force: true });
  } catch {
    /* housekeeping is best-effort */
  }
}
