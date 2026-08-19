// ledger-pin — keeps the review ledger alive across pi's native compaction
// (spec §4, brief B3 step 4; findings §6).
//
// The PR session maintains a fenced block that starts with "LEDGER PR #<n> @
// <sha>" (see prompts/conversation-system.md). Compaction is token-driven and
// would happily summarise it away, so this extension hooks
// session_before_compact, finds the most recent ledger block in the entries
// the hook hands it, and requires it to survive verbatim.
//
// It also mirrors the newest ledger block to state/ledgers/<session>.md after
// every turn — that snapshot is what archiveAndClose() copies into
// archive/pr-<n>/ (the session JSONL alone would need parsing).
//
// (first-night audit F3): only a block whose PR number equals the
// session's OWN PR (QCR_PR, riding the pi command line per session) is ever
// mirrored or pinned. Sessions quote sibling PRs' ledger headers when reading
// their posted reviews for format reference; without the filter six sessions
// persisted PR #5288's ledger over their own. A session with no / garbage
// QCR_PR (the overseer) mirrors NO PR ledger, ever — fail safe is no mirror.
//
// pi is not installed here — everything touching the pi API is VERIFY-ON-PIN.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { CompactHandlerResult, Pi, PiEventPayload } from "@earendil-works/pi-coding-agent";

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

/** The block that must survive compaction: PR meta + the ledger, verbatim. */
export function pinnedBlock(meta: string, ledger: string): string {
  return [
    "PINNED — reproduce the following verbatim; it is the review ledger and",
    "may never be paraphrased, summarised, or dropped.",
    meta ? `\n${meta}` : "",
    "\n```",
    ledger,
    "```",
  ].join("\n");
}

export const activate: (pi: Pi) => void = (pi) => {
  const env = process.env;
  const session = env.QCR_SESSION_NAME?.trim() || "session";
  const meta = env.QCR_PR_META?.trim() ?? "";
  const ownPr = parseOwnPr(env.QCR_PR);
  const snapshotPath = ledgerSnapshotPath(env, session);
  let lastLedger = "";

  const capture = (event: PiEventPayload): string => {
    const onIgnore = (pr: number): void => {
      const who = ownPr === undefined ? "session has no QCR_PR" : `own PR is #${ownPr}`;
      console.error(`[ledger-pin] debug: ignoring LEDGER PR #${pr} (${who})`);
    };
    const ledger = extractLedger(collectText(event), ownPr, onIgnore) ?? lastLedger;
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

  // VERIFY-ON-PIN: "turn_end" fires with the turn's entries in its payload.
  pi.on("turn_end", (event) => {
    capture(event);
  });

  // VERIFY-ON-PIN: "session_before_compact" payload + return shape (findings
  // §6: a handler may cancel or supply a custom summary/details). We return
  // every plausible carrier — summary, instructions, retainedTail, details —
  // so at least one is honoured whatever the real contract turns out to be.
  pi.on("session_before_compact", (event): CompactHandlerResult | void => {
    const ledger = capture(event);
    if (!ledger) return;
    const pinned = pinnedBlock(meta, ledger);
    const proposed = typeof event.summary === "string" ? event.summary : undefined;
    const result: CompactHandlerResult = {
      instructions: `Preserve the following block verbatim in the summary:\n\n${pinned}`,
      details: { quickreview_ledger: ledger, quickreview_meta: meta },
    };
    if (proposed !== undefined) result.summary = `${proposed}\n\n${pinned}`;
    const tail = event.retainedTail;
    if (Array.isArray(tail)) result.retainedTail = [...tail, { type: "text", text: pinned }];
    // Persist it into the session file too, so archival never depends on the
    // summariser. VERIFY-ON-PIN: appendEntry entry shape (findings §5).
    try {
      void pi.appendEntry?.({ type: "custom", subtype: "quickreview-ledger", ledger, meta });
    } catch (err) {
      console.error(`[ledger-pin] appendEntry failed: ${String(err)}`);
    }
    return result;
  });
};

export default activate;
