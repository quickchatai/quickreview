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
// pi is not installed here — everything touching the pi API is VERIFY-ON-PIN.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { CompactHandlerResult, Pi, PiEventPayload } from "@earendil-works/pi-coding-agent";

const LEDGER_RE = /(^|\n)\s*LEDGER\s+PR\s+#\d+[^\n]*\n[\s\S]*?(?=\n```|\n\s*\n\s*#|$)/g;

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

/** The last (most recent) LEDGER block found in the given texts, trimmed. */
export function extractLedger(texts: string[]): string | undefined {
  let found: string | undefined;
  for (const text of texts) {
    const matches = text.match(LEDGER_RE);
    if (matches && matches.length > 0) found = matches[matches.length - 1]?.trim();
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
  const snapshotPath = ledgerSnapshotPath(env, session);
  let lastLedger = "";

  const capture = (event: PiEventPayload): string => {
    const ledger = extractLedger(collectText(event)) ?? lastLedger;
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
