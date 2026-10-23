import { parsePrIdentity as parseOwnPr } from "../src/pr-identity.js";
// ledger-pin — keeps the review ledger alive across pi's native compaction.
//
// The PR session maintains a fenced block that starts with "LEDGER PR #<n> @
// <sha>" (see prompts/conversation-system.md). Compaction is token-driven and
// would happily summarise it away, so this extension hooks
// session_before_compact, finds the most recent ledger block in the entries
// the hook hands it, and returns a REAL compaction: pi's own
// default summary, produced by calling the package's exported `compact()`
// (the function pi would have called itself), with the pinned ledger block
// appended to it VERBATIM. That summary is what pi puts back in front of the
// model after compaction, so the ledger survives word for word. Any failure
// on that path (no model, no auth, the summariser threw, a shape we do not
// recognise) returns nothing, and pi runs its default compaction unchanged:
// never a cancelled compaction, never a wedged session. The ledger then still
// comes back through the daemon, because every round order re-hands the
// mirrored snapshot (packages/pi-plugin/src/ledgercarry.ts).
//
// pi 1.0.0 reads only `cancel` and `compaction` from the handler's result, so
// returning a whole compaction is the only way to pin anything.
//
// It also mirrors the newest ledger block to state/ledgers/<session>.md after
// every turn — that snapshot is what archiveAndClose() copies into
// archive/pr-<n>/ (the session JSONL alone would need parsing).
//
// Only a block whose PR number equals the session's OWN PR (QCR_PR, riding
// the pi command line per session) is ever mirrored or pinned. Sessions quote
// sibling PRs' ledger headers when reading their posted reviews for format
// reference; without the filter a sibling's ledger would be persisted over
// the session's own. A session with no / garbage
// QCR_PR (the overseer) mirrors NO PR ledger, ever — fail safe is no mirror.
//
// pi is a dependency of this repo, so the pi API is typechecked against its own
// declarations; what a live session does with it stays VERIFY-ON-PIN.
// The compaction contract was read out of pi 1.0.0's shipped dist (the
// `qcr-bench:fast1` image, docker create + docker cp, no container run); each
// tag below names the file and symbol it was checked against.
import { backtickFence } from "../src/codespan.js";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionFactory,
  SessionBeforeCompactEvent,
  SessionBeforeCompactResult,
} from "@earendil-works/pi-coding-agent";

/** What `compact()` summarises: the preparation pi hands `session_before_compact`. */
type CompactionPreparation = SessionBeforeCompactEvent["preparation"];

// A block runs from its "LEDGER PR #<n>" header to the next fence / blank
// line + heading / NEXT ledger header / end — the last terminator keeps a
// quoted sibling header from being swallowed into the preceding block's body.
const LEDGER_RE =
  /(^|\n)\s*LEDGER\s+PR\s+#(\d+)[^\n]*\n[\s\S]*?(?=\n```|\n\s*\n\s*#|\n\s*LEDGER\s+PR\s+#|$)/g;

/** The session's own PR number from QCR_PR — undefined for the overseer (no
 * QCR_PR) and for anything that is not a plain digit string (fail safe). */
export { parsePrIdentity as parseOwnPr } from "../src/pr-identity.js";

/** Deep-walk an unknown payload collecting every string that could be message
 * text. // VERIFY-ON-PIN: the event payload shape is undocumented, so this is
 * deliberately shape-agnostic rather than assuming `event.messages`. */
export function collectText(value: unknown, out: string[] = [], depth = 0): string[] {
  if (depth > 8 || value == null) return out;
  if (typeof value === "string") {
    out.push(value);
    return out;
  }
  if (Array.isArray(value)) {
    for (const v of value) collectText(v, out, depth + 1);
    return out;
  }
  if (typeof value === "object") {
    for (const v of Object.values(value as Record<string, unknown>)) collectText(v, out, depth + 1);
  }
  return out;
}

// The format's own example in the system prompt (prompts/conversation-system.md
// renders `LEDGER PR #<n> @ <head-sha>` with the PR's number filled in) names a
// placeholder where a ledger names its head. A worker that wrote no ledger in a
// recheck mirrored that example over #6114's real ledger (2026-10-22).
const PLACEHOLDER_HEAD_RE = /^\s*LEDGER\s+PR\s+#\d+\s*@\s*</;

/** A block opened right after a fence of four or more backticks runs to that
 * fence's close, so a three-backtick quote inside it stays part of the ledger.
 * undefined when no such fence encloses the header. */
function wrappedBlock(text: string, match: RegExpMatchArray): string | undefined {
  const start = (match.index ?? 0) + (match[1] ?? "").length;
  const open = /(?:^|\n)(`{4,})[^\n`]*\n\s*$/.exec(text.slice(0, start));
  if (!open) return undefined;
  const rest = text.slice(start);
  const close = new RegExp(`\\n\\s*${open[1]}\`*[ \\t]*(?:\\n|$)`).exec(rest);
  const end = close ? close.index : rest.length;
  return rest.slice(0, end);
}

/** The last (most recent) LEDGER block for the session's OWN PR, trimmed.
 * Blocks naming any other PR are ignored (reported via onIgnore) — even when
 * they appear after the own-PR block. With no own PR (overseer / garbage
 * QCR_PR) every block is ignored and nothing is returned. A block whose head is
 * a `<placeholder>` is the format's example, never a ledger, and is skipped. */
export function extractLedger(
  texts: string[],
  ownPr: number | undefined,
  onIgnore: (pr: number) => void = () => {},
): string | undefined {
  let found: string | undefined;
  for (const text of texts) {
    for (const match of text.matchAll(LEDGER_RE)) {
      const pr = Number(match[2]);
      const block = wrappedBlock(text, match) ?? match[0];
      if (PLACEHOLDER_HEAD_RE.test(block.trim())) continue;
      if (ownPr !== undefined && pr === ownPr) found = block.trim();
      else onIgnore(pr);
    }
  }
  return found;
}

export function ledgerSnapshotPath(env: NodeJS.ProcessEnv, session: string, cwd: string): string {
  const explicit = env.QCR_LEDGER_FILE?.trim();
  if (explicit) return explicit;
  const root = env.QCR_SANDBOX_ROOT?.trim() || cwd;
  return join(root, "state", "ledgers", `${session}.md`);
}

function writeSnapshot(path: string, body: string): void {
  mkdirSync(dirname(path), { recursive: true });
  let previous = "";
  try {
    previous = readFileSync(path, "utf8");
  } catch {
    /* first snapshot */
  }
  if (previous.trim() === body.trim()) return;
  const tmp = `${path}.tmp-${process.pid}-${randomUUID()}`;
  try {
    writeFileSync(tmp, `${body}\n`);
    renameSync(tmp, path);
  } finally {
    rmSync(tmp, { force: true });
  }
}

/** Sentinels around the pinned block, so the next compaction can strip the
 * previous copy out of `previousSummary` before pi's summariser sees it (it
 * would otherwise paraphrase a stale ledger into the new summary). */
export const PIN_OPEN = "<!-- qcr:ledger-pin -->";
export const PIN_CLOSE = "<!-- /qcr:ledger-pin -->";

/** A fence longer than any backtick run in `body`, so a ledger that quotes
 * code can never close its own fence early. */
export const fenceFor = backtickFence;

/** The block appended to the compaction summary: PR meta + the ledger,
 * verbatim, between the sentinels. */
export function pinnedBlock(meta: string, ledger: string): string {
  const fence = fenceFor(ledger);
  return [
    PIN_OPEN,
    "PINNED LEDGER — your review ledger exactly as you last wrote it, appended",
    "verbatim to this compaction summary by the ledger-pin extension. It is the",
    "checklist the next round starts from; the summary above is a paraphrase.",
    ...(meta ? ["", meta] : []),
    "",
    fence,
    ledger,
    fence,
    PIN_CLOSE,
  ].join("\n");
}

/** `summary` with every pinned block (sentinels inclusive) removed. */
export function stripPinned(summary: string): string {
  let out = summary;
  for (;;) {
    const open = out.indexOf(PIN_OPEN);
    if (open < 0) return out.trimEnd();
    const close = out.indexOf(PIN_CLOSE, open);
    if (close < 0) return out.slice(0, open).trimEnd();
    out = out.slice(0, open).trimEnd() + out.slice(close + PIN_CLOSE.length);
  }
}

/** pi's exported default summariser, as ledger-pin calls it. */
export type CompactFn = typeof import("@earendil-works/pi-coding-agent").compact;

/** Load `compact` from the installed (= pinned) pi package, resolved inside
 * the pi process, so it lands on the running instance
 * (tests/pi-resolution.test.ts). VERIFY-ON-PIN: pi 1.0.0 `dist/index.js` exports `compact`
 * (re-exported from `dist/core/compaction/index.js`). Undefined when the
 * import fails or the export is missing. */
export async function loadPiCompact(): Promise<CompactFn | undefined> {
  try {
    const pkg = (await import("@earendil-works/pi-coding-agent")) as unknown as {
      compact?: unknown;
    };
    return typeof pkg.compact === "function" ? (pkg.compact as CompactFn) : undefined;
  } catch {
    return undefined;
  }
}

function isPreparation(value: unknown): value is CompactionPreparation {
  if (!value || typeof value !== "object") return false;
  const p = value as Record<string, unknown>;
  return typeof p.firstKeptEntryId === "string" && typeof p.tokensBefore === "number";
}

/**
 * The pinned compaction: pi's own default summary with the pinned block
 * appended. It mirrors pi 1.0.0's `AgentSession._runDefaultCompaction`
 * (dist/core/agent-session.js): resolve request auth for the session model,
 * then `compact(preparation, model, apiKey, headers, customInstructions,
 * signal, thinkingLevel, streamFn, env)`. The stream function is the model
 * registry's `streamSimple`, which is what pi's own agent streamFn delegates
 * to (dist/core/sdk.js, `modelRuntime.streamSimple`; ModelRegistry.streamSimple
 * is that same runtime call). Returns undefined on ANY failure, so pi falls
 * back to its default compaction rather than cancelling one.
 * VERIFY-ON-PIN, whole function: every name here is from pi 1.0.0's dist and
 * has not yet run in a live session.
 */
export async function pinnedCompaction(
  event: Partial<Pick<SessionBeforeCompactEvent, "preparation" | "customInstructions" | "signal">>,
  ctx: Partial<Pick<ExtensionContext, "modelRegistry" | "model" | "thinkingLevel">> | undefined,
  pinned: string,
  compactFn: CompactFn | undefined,
  log: (msg: string) => void = () => {},
): Promise<SessionBeforeCompactResult | undefined> {
  const fail = (why: string): undefined => {
    log(
      `[ledger-pin] pinned compaction unavailable (${why}); pi runs its default compaction and the ledger returns with the next round order`,
    );
    return undefined;
  };
  if (!compactFn) return fail("pi's compact() is not exported by the installed package");
  const preparation = event.preparation;
  if (!isPreparation(preparation))
    return fail("event.preparation has no firstKeptEntryId/tokensBefore");
  const registry = ctx?.modelRegistry;
  const model = ctx?.model;
  if (!registry || typeof registry.getApiKeyAndHeaders !== "function")
    return fail("no model registry");
  if (!model || typeof model !== "object") return fail("no session model");
  try {
    const auth = await registry.getApiKeyAndHeaders(model);
    if (!auth.ok) return fail(`auth: ${auth.error}`);
    const requestModel = auth.baseUrl ? { ...model, baseUrl: auth.baseUrl } : model;
    const forSummary: CompactionPreparation =
      typeof preparation.previousSummary === "string"
        ? { ...preparation, previousSummary: stripPinned(preparation.previousSummary) }
        : preparation;
    const custom =
      typeof event.customInstructions === "string" ? event.customInstructions : undefined;
    const signal = event.signal instanceof AbortSignal ? event.signal : undefined;
    const result = await compactFn(
      forSummary,
      requestModel,
      auth.apiKey,
      // ProviderHeaders allows null values (a header to drop); compact() types
      // them as strings, and pi hands its own summariser the same object.
      auth.headers as Record<string, string> | undefined,
      custom,
      signal,
      ctx?.thinkingLevel,
      (m, c, o) => registry.streamSimple(m, c, o),
      auth.env,
    );
    if (
      !result ||
      typeof result.summary !== "string" ||
      typeof result.firstKeptEntryId !== "string" ||
      typeof result.tokensBefore !== "number"
    )
      return fail("compact() returned no usable result");
    return {
      compaction: {
        ...result,
        summary: `${stripPinned(result.summary)}\n\n${pinned}`,
      },
    };
  } catch (err) {
    return fail(`summariser threw: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** The custom entry type ledger-pin writes into the session file. */
export const LEDGER_ENTRY_TYPE = "qcr-review-ledger";

export interface LedgerPinDeps {
  /** Where pi's `compact()` comes from; tests inject a fake. */
  loadCompact?: () => Promise<CompactFn | undefined>;
  /** Where the extension's diagnostics go, one line each (the host's: the env
   * shim passes stderr). Omitted: nowhere. */
  log?: (msg: string) => void;
}

/** What one ledger-pin extension needs, resolved: no env is read past here. */
export interface LedgerPinConfig extends LedgerPinDeps {
  /** PR meta line appended above the pinned ledger ("" for none). */
  prMeta: string;
  /** The session's own PR; undefined (the overseer) mirrors and pins nothing. */
  ownPr: number | undefined;
  /** Where the newest own ledger block is mirrored after every turn. */
  snapshotPath: string;
}

/** The config the env describes (QCR_SESSION_NAME, QCR_PR_META, QCR_PR, and
 * the snapshot path from ledgerSnapshotPath, `cwd` standing in for an absent
 * sandbox root). */
export function ledgerPinConfigFromEnv(
  env: NodeJS.ProcessEnv,
  cwd: string,
  deps: LedgerPinDeps = {},
): LedgerPinConfig {
  const session = env.QCR_SESSION_NAME?.trim() || "session";
  return {
    prMeta: env.QCR_PR_META?.trim() ?? "",
    ownPr: parseOwnPr(env.QCR_PR),
    snapshotPath: ledgerSnapshotPath(env, session, cwd),
    ...deps,
  };
}

/** The factory an SDK session loads. Its env shim is extensions/cli/ledger-pin.ts. */
export function createLedgerPin(config: LedgerPinConfig): ExtensionFactory {
  return (pi: ExtensionAPI): void => {
    registerLedgerPin(pi, config);
  };
}

function registerLedgerPin(pi: ExtensionAPI, config: LedgerPinConfig): void {
  const loadCompact = config.loadCompact ?? loadPiCompact;
  const log = config.log ?? ((): void => {});
  const { prMeta: meta, ownPr, snapshotPath } = config;
  let lastLedger = "";
  let persistedLedger = "";

  const capture = (source: unknown): string => {
    const onIgnore = (pr: number): void => {
      const who = ownPr === undefined ? "session has no QCR_PR" : `own PR is #${ownPr}`;
      log(`[ledger-pin] debug: ignoring LEDGER PR #${pr} (${who})`);
    };
    const ledger = extractLedger(collectText(source), ownPr, onIgnore) ?? lastLedger;
    if (ledger) lastLedger = ledger;
    if (ledger && ledger !== persistedLedger) {
      try {
        writeSnapshot(snapshotPath, ledger);
        persistedLedger = ledger;
      } catch (err) {
        log(`[ledger-pin] snapshot write failed: ${String(err)}`);
      }
    }
    return ledger;
  };

  // VERIFY-ON-PIN: "turn_end". pi 1.0.0 `TurnEndEvent` (dist/core/extensions/
  // types.d.ts) carries the turn's `message` and `toolResults`; the walk stays
  // shape-agnostic.
  pi.on("turn_end", (event) => {
    capture(event);
  });

  // VERIFY-ON-PIN: pi 1.0.0 `SessionBeforeCompactEvent` (dist/core/extensions/
  // types.d.ts) is { preparation, branchEntries, customInstructions?, reason,
  // willRetry, signal }. The handler gets (event, ctx: ExtensionContext) and
  // may return `SessionBeforeCompactResult` = { cancel?, compaction? }, the
  // only two keys `dist/core/agent-session.js` reads (both `compact()` and
  // `_runAutoCompaction()`). The ledger is looked for in `branchEntries`
  // (oldest first, so the newest own block wins), falling back to the whole
  // event if that field is ever missing.
  pi.on(
    "session_before_compact",
    async (event, ctx): Promise<SessionBeforeCompactResult | void> => {
      const ledger = capture(Array.isArray(event.branchEntries) ? event.branchEntries : event);
      if (!ledger) return;
      // Persist it into the session file too, so archival never depends on the
      // summariser. VERIFY-ON-PIN: pi 1.0.0 `ExtensionAPI.appendEntry<T>(
      // customType: string, data?: T): void` (dist/core/extensions/types.d.ts),
      // implemented in dist/core/agent-session.js as
      // `sessionManager.appendCustomEntry(customType, data)`: a `custom` entry,
      // never sent to the model.
      try {
        pi.appendEntry?.(LEDGER_ENTRY_TYPE, { pr: ownPr, ledger, meta });
      } catch (err) {
        log(`[ledger-pin] appendEntry failed: ${String(err)}`);
      }
      return pinnedCompaction(event, ctx, pinnedBlock(meta, ledger), await loadCompact(), log);
    },
  );
}
