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
// mirrored snapshot (src/ledgercarry.ts).
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
// pi is not installed here — everything touching the pi API is VERIFY-ON-PIN.
// The compaction contract was read out of pi 1.0.0's shipped dist (the
// `qcr-bench:fast1` image, docker create + docker cp, no container run); each
// tag below names the file and symbol it was checked against.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type {
  CompactHandlerResult,
  Pi,
  PiCompactionPreparation,
  PiCompactionResult,
  PiEventContext,
  PiEventPayload,
} from "@earendil-works/pi-coding-agent";

// A block runs from its "LEDGER PR #<n>" header to the next fence / blank
// line + heading / NEXT ledger header / end — the last terminator keeps a
// quoted sibling header from being swallowed into the preceding block's body.
const LEDGER_RE =
  /(^|\n)\s*LEDGER\s+PR\s+#(\d+)[^\n]*\n[\s\S]*?(?=\n```|\n\s*\n\s*#|\n\s*LEDGER\s+PR\s+#|$)/g;

/** The session's own PR number from QCR_PR — undefined for the overseer (no
 * QCR_PR) and for anything that is not a plain digit string (fail safe). */
export function parseOwnPr(raw: string | undefined): number | undefined {
  const trimmed = raw?.trim();
  if (!trimmed || !/^\d+$/.test(trimmed)) return undefined;
  return Number(trimmed);
}

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

/** The last (most recent) LEDGER block for the session's OWN PR, trimmed.
 * Blocks naming any other PR are ignored (reported via onIgnore) — even when
 * they appear after the own-PR block. With no own PR (overseer / garbage
 * QCR_PR) every block is ignored and nothing is returned. */
export function extractLedger(
  texts: string[],
  ownPr: number | undefined,
  onIgnore: (pr: number) => void = () => {},
): string | undefined {
  let found: string | undefined;
  for (const text of texts) {
    for (const match of text.matchAll(LEDGER_RE)) {
      const pr = Number(match[2]);
      if (ownPr !== undefined && pr === ownPr) found = match[0].trim();
      else onIgnore(pr);
    }
  }
  return found;
}

export function ledgerSnapshotPath(env: NodeJS.ProcessEnv, session: string): string {
  const explicit = env.QCR_LEDGER_FILE?.trim();
  if (explicit) return explicit;
  const root = env.QCR_SANDBOX_ROOT?.trim() || process.cwd();
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
  writeFileSync(path, `${body}\n`);
}

/** Sentinels around the pinned block, so the next compaction can strip the
 * previous copy out of `previousSummary` before pi's summariser sees it (it
 * would otherwise paraphrase a stale ledger into the new summary). */
export const PIN_OPEN = "<!-- qcr:ledger-pin -->";
export const PIN_CLOSE = "<!-- /qcr:ledger-pin -->";

/** A fence longer than any backtick run in `body`, so a ledger that quotes
 * code can never close its own fence early. */
export function fenceFor(body: string): string {
  let longest = 0;
  for (const run of body.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
  return "`".repeat(Math.max(3, longest + 1));
}

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
export type CompactFn = (
  preparation: PiCompactionPreparation,
  model: unknown,
  apiKey: string | undefined,
  headers?: Record<string, string>,
  customInstructions?: string,
  signal?: AbortSignal,
  thinkingLevel?: string,
  streamFn?: (model: unknown, context: unknown, options: unknown) => unknown,
  env?: Record<string, string>,
) => Promise<PiCompactionResult>;

/** Load `compact` from the installed (= pinned) pi package, resolved inside
 * the pi process exactly like extensions/subagents.ts's import of the same
 * package. VERIFY-ON-PIN: pi 1.0.0 `dist/index.js` exports `compact`
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

function isPreparation(value: unknown): value is PiCompactionPreparation {
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
  event: PiEventPayload,
  ctx: PiEventContext | undefined,
  pinned: string,
  compactFn: CompactFn | undefined,
  log: (msg: string) => void = (m) => console.error(m),
): Promise<CompactHandlerResult | undefined> {
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
    const forSummary: PiCompactionPreparation =
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
      auth.headers,
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
}

export function activateWith(pi: Pi, deps: LedgerPinDeps = {}): void {
  const loadCompact = deps.loadCompact ?? loadPiCompact;
  const env = process.env;
  const session = env.QCR_SESSION_NAME?.trim() || "session";
  const meta = env.QCR_PR_META?.trim() ?? "";
  const ownPr = parseOwnPr(env.QCR_PR);
  const snapshotPath = ledgerSnapshotPath(env, session);
  let lastLedger = "";

  const capture = (source: unknown): string => {
    const onIgnore = (pr: number): void => {
      const who = ownPr === undefined ? "session has no QCR_PR" : `own PR is #${ownPr}`;
      console.error(`[ledger-pin] debug: ignoring LEDGER PR #${pr} (${who})`);
    };
    const ledger = extractLedger(collectText(source), ownPr, onIgnore) ?? lastLedger;
    if (ledger && ledger !== lastLedger) {
      lastLedger = ledger;
      try {
        writeSnapshot(snapshotPath, ledger);
      } catch (err) {
        console.error(`[ledger-pin] snapshot write failed: ${String(err)}`);
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
  pi.on("session_before_compact", async (event, ctx): Promise<CompactHandlerResult | void> => {
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
      console.error(`[ledger-pin] appendEntry failed: ${String(err)}`);
    }
    return pinnedCompaction(event, ctx, pinnedBlock(meta, ledger), await loadCompact());
  });
}

export const activate: (pi: Pi) => void = (pi) => activateWith(pi);

export default activate;
