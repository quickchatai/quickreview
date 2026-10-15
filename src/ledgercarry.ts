// Ledger carry: every round order re-hands the PR's ledger.
//
// The session keeps its review ledger in its conversation; ledger-pin mirrors
// the newest own-PR block to `state/ledgers/pr-<n>.md` after every turn. This
// module gives that file BACK, so a session reborn after a kill, a restart or
// a compaction that lost the block does not start its next round blind. The
// compaction half is ledger-pin's (it pins the block into pi's summary); this
// module is the daemon half, which needs no model and no pi API at all:
//
//   - `ledger_carry` on the order: the mirrored block, verbatim, bounded to
//     LEDGER_CARRY_MAX_CHARS, with the path it came from, rendered by the
//     round templates as `{{ledger_note}}`;
//   - `settled_digest`: the ledger's `SETTLED:` items, one per line, bounded
//     to SETTLED_DIGEST_MAX_CHARS, which the round prompt and every lens task
//     file already hand the passes as "do not re-raise".
//
// Total by construction: an absent, unreadable, empty or foreign (another
// PR's header) file is NO carry and an empty digest — never an error, never a
// delayed round. Only the header's PR number is checked; a header at an older
// head is still this PR's last ledger and is exactly what a re-review needs.
import { readFileSync } from "node:fs";
import type { LedgerCarry } from "./types.js";

export type { LedgerCarry };

/** A ledger header naming its PR. Looser than ledgercheck's LEDGER_HEADER_RE
 * (which also wants the head sha, because it judges freshness): a block whose
 * header lost its sha is still this PR's ledger and still worth handing back. */
const CARRY_HEADER_RE = /LEDGER\s+PR\s+#(\d+)/;

/** The most of the ledger one order carries. Ledgers are meant to be lean
 * (conversation-system.md: "prose lives in GitHub, not the ledger"); a larger
 * file is cut at a line boundary and the order says so, naming the path. */
export const LEDGER_CARRY_MAX_CHARS = 8000;
/** The most of the SETTLED list the digest carries (it rides every lens task
 * file too, so it stays smaller than the ledger). */
export const SETTLED_DIGEST_MAX_CHARS = 2000;

/** Cut `text` to at most `max` characters, at the last line break inside the
 * cap when there is one. */
function cutAtLine(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = text.slice(0, max);
  const nl = head.lastIndexOf("\n");
  return (nl > 0 ? head.slice(0, nl) : head).trimEnd();
}

/** The carry for PR `pr` from a ledger file's content, or undefined when the
 * content is empty or its header names no PR / another PR. */
export function parseLedgerCarry(
  content: string,
  pr: number,
  source: string,
  max: number = LEDGER_CARRY_MAX_CHARS,
): LedgerCarry | undefined {
  const text = content.trim();
  if (!text) return undefined;
  const match = CARRY_HEADER_RE.exec(text);
  if (!match || Number(match[1]) !== pr) return undefined;
  const headerStart = text.lastIndexOf("\n", match.index) + 1;
  const headerEnd = text.indexOf("\n", match.index);
  const header = text.slice(headerStart, headerEnd < 0 ? undefined : headerEnd).trim();
  const kept = cutAtLine(text, max);
  return {
    source,
    header,
    text: kept,
    truncated: kept.length < text.length,
    total_chars: text.length,
  };
}

const EMPTY_ITEM = /^(?:-+|—|–|none|\(none\)|n\/a|nothing(?: yet)?)$/i;

/** The ledger's `SETTLED:` items, one `- item` line each: the items within
 * `max` characters, then — when some did not fit — one short line counting
 * the rest (that line is beyond `max`); "" when the ledger settles nothing.
 * Items are split on the ledger format's ` | ` separator
 * (conversation-system.md). */
export function settledFromLedger(text: string, max: number = SETTLED_DIGEST_MAX_CHARS): string {
  const items: string[] = [];
  for (const line of text.split("\n")) {
    const m = /^\s*SETTLED\s*:\s*(.*)$/i.exec(line);
    if (!m) continue;
    for (const raw of (m[1] ?? "").split(/\s+\|\s+/)) {
      const item = raw.trim();
      if (item && !EMPTY_ITEM.test(item)) items.push(item);
    }
  }
  const out: string[] = [];
  let used = 0;
  for (let i = 0; i < items.length; i++) {
    const line = `- ${items[i]}`;
    const more = items.length - i;
    if (used + line.length + 1 > max) {
      out.push(`- … ${more} more settled item(s) in the ledger`);
      break;
    }
    out.push(line);
    used += line.length + 1;
  }
  return out.join("\n");
}

/** Both halves for one PR, read from `path`. Never throws. */
export function readLedgerCarry(
  path: string,
  pr: number,
  read: (p: string) => string = (p) => readFileSync(p, "utf8"),
): { carry?: LedgerCarry; settled: string } {
  let content: string;
  try {
    content = read(path);
  } catch {
    return { settled: "" };
  }
  const carry = parseLedgerCarry(content, pr, path);
  if (!carry) return { settled: "" };
  return { carry, settled: settledFromLedger(content.trim()) };
}
