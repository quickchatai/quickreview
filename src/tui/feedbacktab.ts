// `[7] feedback` — the tuning loop on one surface, end to end:
//
//   signal        the inbox: every `#feedback` memory entry, newest first,
//                 acted-on ones archived (`a` shows them)
//   adjudication  the selected signal's card, and what the record says about it
//   proposal      PROPOSED: the companion's rubric proposals, `A` accept / `x` reject
//   change        CHANGED: the register of feedback-derived commits, newest first
//   revert        `R` arms a revert of the focused change, `y` runs it
//   filed         a summary of the tracker tickets adjudication opened ([4] is the list)
//
// The whole loop lives here so that adjudicating a signal and learning what
// it changed happen in one place, not across tabs.
//
// The revert confirmation is deliberate. The board is read-only over
// ssh with a short list of user-initiated exceptions and this revert is one:
// it writes a commit into the checkout the companion is live in, and the rows
// in the register look alike by construction (same author, same prefix,
// one-line subjects), so the realistic failure is reverting the row NEXT to
// the one you meant. `R` arms and paints exactly what will happen — the sha,
// the subject, the literal git command, and the fact that nothing is pushed —
// and `y` runs it. Any other key cancels, the same grammar the quit prompt
// uses. The register itself (what counts as one, how reverts are read back)
// lives in `changelog-store.ts`.
import { FEEDBACK_FULL_TEXT_LABEL, readFencedData } from "../memory/datafence.js";
import { parseEventTags, parseHashTags } from "../memory/eventtags.js";
import { lessonHeadline, lessonTierLine } from "../memory/shadowstatus.js";
import type { StatusSnapshot } from "../state.js";
import type { App } from "./app.js";
import {
  revertArgv,
  type ChangeEntry,
  type ChangeLogProblem,
  type ChangeRegister,
  type RevertResult,
} from "./changelog-store.js";
import { barHeight, paintCmdBar, type BarButton, type LiveKeys } from "./cmdbar.js";
import {
  ACCENT,
  BAD,
  HEADING,
  MUTED,
  OK,
  RESET,
  SEP,
  STRONG,
  WARN,
  button,
  modeBadge,
  sectionTitle,
  selected as selectedLine,
} from "./design.js";
import { emptyLine } from "./emptystate.js";
import { keyChar, type BoardKey } from "./keys.js";
import type { LearningStore } from "./learning.js";
import { timelineOrder, type MemoryEntry } from "./memory.js";
import { moveSelection } from "./model.js";
import { hitTest, type Zone } from "./mouse.js";
import { Frame, fit, rule, sanitizeText, truncate, wrap } from "./paint.js";
import {
  paintSplit,
  splitWidths,
  windowStart,
  zonedRow,
  type RowChunk,
  type ZonedRow,
} from "./panes.js";
import { tabDigit } from "./tabs.js";
import { FG, fmtAge } from "./theme.js";
import { isActionableTicket } from "./trackertickets.js";

// ---- the signal, as a card ----------------------------------------------------

export type FeedbackStatus = "unprocessed" | "settled" | "needs-attention" | "acted-on";

export interface FeedbackPresentation {
  pr?: string;
  episode: string;
  /** Looked-at is independent of whether the episode reached a verdict. */
  processed: boolean;
  status: FeedbackStatus;
  listTitle: string;
  title: string;
  summary: string;
  raw: string;
  learning: string;
}

/** Header-only (`parseHashTags`), not `e.tags`: the store's tag list is a
 * full-text scan, and a feedback entry quotes a human comment verbatim — a
 * comment mentioning `#adjudication` must not turn its own signal into a
 * disposition record and drop it from the inbox. */
const hasTag = (e: MemoryEntry, tag: string): boolean => parseHashTags(e.text).includes(tag);

const isDisposition = (e: MemoryEntry): boolean =>
  hasTag(e, "adjudication") || hasTag(e, "feedback-review") || hasTag(e, "feedback-action");

/**
 * The inbox: every `#feedback` signal, newest first. Disposition records
 * describe the processing of a signal and are not themselves another signal
 * row — they stay in `all` so the selected card can prove its badge. An
 * action receipt is the archive transition: the original signal remains
 * durable in memory but leaves the active inbox unless `showArchived`.
 */
export function feedbackInbox(entries: MemoryEntry[], showArchived = false): MemoryEntry[] {
  return timelineOrder(entries).filter((e) => {
    if (!hasTag(e, "feedback") || isDisposition(e)) return false;
    return showArchived || feedbackPresentation(e, entries)?.status !== "acted-on";
  });
}

function feedbackRaw(text: string): string {
  // The comment's full text, when the entry carries it — what
  // the human wrote, not the sentence's 280-character cut.
  const full = readFencedData(text, FEEDBACK_FULL_TEXT_LABEL);
  if (full !== null && full.trim() !== "") return full.trim();
  const quoted = /\):\s*"([\s\S]*)"\s+—\s+/.exec(text);
  if (quoted?.[1]) return quoted[1].trim();
  return text.replace(/^(?:#[^\s]+\s+)*(?:[a-z][a-z0-9_-]*=[^\s]+\s+)*/, "").trim();
}

function feedbackEpisode(e: MemoryEntry, signal: string): string {
  if (signal === "feedback_comment") {
    const id = /\bcomment\s+(\d+)\)/.exec(e.text)?.[1];
    if (id) return `comment-${id}`;
  }
  if (signal === "review_set_aside") {
    const id = /\bbot review\s+(\d+)\b/.exec(e.text)?.[1];
    if (id) return `review-${id}`;
  }
  if (signal === "bot_comment_deleted") {
    const id = /\bbot comment\s+(\d+)\b/.exec(e.text)?.[1];
    if (id) return `deleted-comment-${id}`;
  }
  return `${signal || "feedback"}-${e.day}`;
}

function dispositionFor(
  all: MemoryEntry[],
  pr: string | undefined,
  episode: string,
): { status: Exclude<FeedbackStatus, "unprocessed">; entry: MemoryEntry } | undefined {
  if (!pr) return undefined;
  const exact = (candidate: MemoryEntry): boolean => {
    const tags = parseEventTags(candidate.text);
    return tags["pr"] === pr && tags["episode"] === episode;
  };
  // An action receipt supersedes every intermediate disposition. A reached
  // verdict supersedes an earlier needs-attention marker.
  const action = all.find((candidate) => hasTag(candidate, "feedback-action") && exact(candidate));
  if (action) return { status: "acted-on", entry: action };
  const adjudication = all.find(
    (candidate) => hasTag(candidate, "adjudication") && exact(candidate),
  );
  if (adjudication) return { status: "settled", entry: adjudication };
  const reviewed = all.find(
    (candidate) => hasTag(candidate, "feedback-review") && exact(candidate),
  );
  if (reviewed) return { status: "needs-attention", entry: reviewed };
  return undefined;
}

/** A deterministic, inspectable presentation over the raw memory signal. It
 * does not adjudicate: unprocessed cards name a question to investigate, while
 * processed cards quote the attribution and Changed fields from the actual
 * #adjudication entry. */
export function feedbackPresentation(
  e: MemoryEntry,
  all: MemoryEntry[],
): FeedbackPresentation | undefined {
  if (!hasTag(e, "feedback") || isDisposition(e)) return undefined;
  const tags = parseEventTags(e.text);
  const pr = tags["pr"] ?? /\bPR\s+#?(\d+)\b/i.exec(e.text)?.[1];
  const signal =
    tags["signal"] ?? (e.text.includes("merged while") ? "merged_over_block" : "feedback");
  const raw = feedbackRaw(e.text);
  const lower = raw.toLowerCase();
  const episode = feedbackEpisode(e, signal);
  const disposition = dispositionFor(all, pr, episode);
  const status: FeedbackStatus = disposition?.status ?? "unprocessed";
  const actor = /human \[feedback\] by ([^\s]+) on PR/i.exec(e.text)?.[1];

  let title: string;
  let summary: string;
  let learning: string;
  if (signal === "review_set_aside") {
    title = "Bot review was dismissed";
    summary = `A bot review${pr ? ` on #${pr}` : ""} was set aside; GitHub may also auto-dismiss stale reviews, so this is a strong investigation prompt but not proof of a bad finding.`;
    learning =
      "Check whether the dismissed review was stale, superseded, or disposable on its merits before changing reviewer behaviour.";
  } else if (signal === "merged_over_block") {
    title = "PR merged over a standing bot block";
    summary = `The PR${pr ? ` #${pr}` : ""} merged while REQUEST_CHANGES stood. That is a low-weight disagreement signal because repository policy may allow advisory overrides.`;
    learning =
      "Reconstruct the standing blockers and test each against the merged code; the merge alone does not refute them.";
  } else if (signal === "bot_comment_deleted") {
    title = "Bot comment was deleted";
    summary = `A bot comment${pr ? ` on #${pr}` : ""} was deleted by a human. A deletion carries no stated reason: it may reject the finding, or tidy a thread that was already settled.`;
    learning =
      "Find the deleted comment's finding in the review record and check it against the code before reading the deletion as disagreement.";
  } else if (signal === "trigger_withdrawn") {
    title = "Review trigger was withdrawn";
    summary = `The review trigger${pr ? ` on #${pr}` : ""} was removed before completion, which may indicate cost, delay, irrelevance, or an ordinary workflow change.`;
    learning =
      "Inspect timing and work already produced before attributing this to review quality.";
  } else if (lower.includes("prompt injection")) {
    title = "Prompt-injection blocker disputed";
    summary = `${actor ?? "A human reviewer"} says the prompt-injection finding${pr ? ` on #${pr}` : ""} should be ignored as a false positive.`;
    learning =
      "Test the claimed execution boundary against the code and the standing injection bright line; do not infer safety merely from prior testing.";
  } else if (/\brare\b|\bnarrow\b|\bunlikely\b|\bimprobabl/.test(lower)) {
    title = "Narrow edge case judged non-actionable";
    summary = `${actor ?? "A human reviewer"} says the finding${pr ? ` on #${pr}` : ""} concerns a production path too rare or narrow to belong in this feature PR.`;
    learning =
      "Re-derive reachability and impact separately: the bug may be real while its severity or delivery is wrong.";
  } else if (lower.includes("small impact")) {
    title = "Low-impact finding judged non-actionable";
    summary = `${actor ?? "A human reviewer"} says the finding${pr ? ` on #${pr}` : ""} has too little impact to justify action.`;
    learning =
      "Check whether the evidence supports a present defect, then whether its delivery exceeded the practical maintenance bar.";
  } else {
    title = "Human disputes a review finding";
    summary = `${actor ?? "A human reviewer"} challenged a finding${pr ? ` on #${pr}` : ""}; the complaint still needs contact with the review evidence and code.`;
    learning =
      "Compare the human claim, the posted finding, and the reviewed code before assigning fault or changing the rubric.";
  }

  if (status === "settled" && disposition) {
    const attribution =
      /^Attribution:\s*(.+)$/im.exec(disposition.entry.text)?.[1]?.trim() ??
      "recorded in adjudication";
    const changed =
      /^Changed:\s*(.+)$/im.exec(disposition.entry.text)?.[1]?.trim() ?? "see adjudication";
    learning = `Adjudicated as ${attribution}. Changed: ${changed}.`;
  } else if (status === "needs-attention" && disposition) {
    const reason =
      /^Reason:\s*(.+)$/im.exec(disposition.entry.text)?.[1]?.trim() ??
      "The review was inconclusive and needs the owner.";
    learning = `Reviewed; needs attention. ${reason}`;
  } else if (status === "acted-on" && disposition) {
    const result =
      /^Result:\s*(.+)$/im.exec(disposition.entry.text)?.[1]?.trim() ??
      "The resulting action is recorded in memory.";
    learning = `Acted on. ${result}`;
  }

  return {
    pr,
    episode,
    processed: status !== "unprocessed",
    status,
    listTitle: `${pr ? `#${pr} · ` : ""}${title}`,
    title,
    summary,
    raw,
    learning,
  };
}

/** Each status's glyph and its card line — the list row shows the glyph. */
const STATUS: Record<FeedbackStatus, { mark: string; line: string }> = {
  unprocessed: { mark: "○", line: "UNPROCESSED — needs review" },
  settled: { mark: "✓", line: "PROCESSED · SETTLED" },
  "needs-attention": { mark: "!", line: "PROCESSED · NEEDS ATTENTION" },
  "acted-on": { mark: "◆", line: "ACTED ON · ARCHIVED" },
};

const statusLine = (status: FeedbackStatus): string =>
  `${STATUS[status].mark} ${STATUS[status].line}`;

export function feedbackEntryLine(
  e: MemoryEntry,
  presentation: FeedbackPresentation,
  width: number,
): string {
  return truncate(
    `  ${e.day} ${STATUS[presentation.status].mark} ${presentation.listTitle}`,
    width,
  );
}

// ---- the change register, as rows -----------------------------------------------

/** The register the CHANGED section reads and reverts through — what
 * `ChangeLog` (changelog-store.ts) exposes, named structurally so tests can
 * hand in a fake without a git checkout. */
export interface ChangeRegisterSource {
  readonly register: ChangeRegister | undefined;
  /** Why `register` may not be the whole story: an unreadable file or a
   * failed scan is said in the section header, never painted as "no
   * changes yet" — and rows already in memory stay on screen under it. */
  readonly problem?: ChangeLogProblem | undefined;
  /** Re-scan; the outcome is read back off `register`/`problem`. */
  refresh(): Promise<unknown>;
  revert(sha: string): Promise<RevertResult>;
}

/** `feedback #<pr> · <adjudication> · ratified <words>` — the provenance line. */
export function provenance(entry: ChangeEntry, width: number): string {
  const bits: string[] = [];
  bits.push(
    entry.feedback_pr
      ? `${FG.dim}feedback${RESET} #${sanitizeText(entry.feedback_pr)}`
      : `${FG.dim}no episode${RESET}`,
  );
  if (entry.adjudication) bits.push(`${ACCENT}${sanitizeText(entry.adjudication)}${RESET}`);
  bits.push(`${FG.dim}ratified ${sanitizeText(entry.ratified)}${RESET}`);
  if (entry.reverted) bits.push(`${WARN}reverted by ${entry.reverted.by}${RESET}`);
  return truncate(bits.join(SEP), width);
}

export function headline(entry: ChangeEntry, now: Date, width: number): string {
  const mark = entry.reverted ? `${WARN}⤺${RESET}` : `${OK}●${RESET}`;
  const age = `${FG.dim}${fit(fmtAge(entry.at, now), 4)}${RESET}`;
  const subject = entry.reverted
    ? `${MUTED}${sanitizeText(entry.subject)}${RESET}`
    : `${STRONG}${sanitizeText(entry.subject)}${RESET}`;
  return truncate(`${mark} ${ACCENT}${entry.short}${RESET} ${age} ${subject}`, width);
}

/** The armed banner: what will run, in the words git will run it in. */
export function armedLines(entry: ChangeEntry, width: number): string[] {
  return [
    truncate(
      `${WARN}${STRONG}REVERT${RESET} ${ACCENT}${entry.short}${RESET} ${STRONG}${sanitizeText(entry.subject)}${RESET}`,
      width,
    ),
    truncate(
      `${FG.dim}runs${RESET} ${revertArgv(entry.short).join(" ")} ${FG.dim}in this checkout — no push, no GitHub, nothing near the mutation gate${RESET}`,
      width,
    ),
    truncate(`${button("y do it")}  ${button("any other key cancels")}`, width),
  ];
}

// ---- the surface ------------------------------------------------------------------

export type FeedbackFocus = "inbox" | "proposed" | "changed";

export const FEEDBACK_FOCUS_ORDER: readonly FeedbackFocus[] = ["inbox", "proposed", "changed"];

export interface FeedbackTabState {
  focus: FeedbackFocus;
  /** Ordinal into the inbox; `selKey` its identity across reloads. */
  sel: number;
  selKey?: string;
  propSel: number;
  changeSel: number;
  showArchived: boolean;
  /** The sha `R` armed; `y` runs it, anything else cancels. */
  armed?: string;
  /** Result of the last revert (or refusal), shown until the next action. */
  result?: string;
  /** A register refresh is in flight. */
  changesLoading: boolean;
}

export type FeedbackAction =
  | { t: "key"; key: string }
  | { t: "signal"; i: number }
  | { t: "prop"; i: number }
  | { t: "prop-accept"; i: number }
  | { t: "prop-reject"; i: number }
  | { t: "change"; i: number }
  | { t: "url"; url: string };

function entryKey(e: MemoryEntry): string {
  return `${e.ts}|${e.id}#${e.block}`;
}

/** What the feedback tab answers to on this frame: the verbs of the FOCUSED
 * pane, plus the archive toggle and the focus cycle. */
export function feedbackKeys(
  store: LearningStore,
  st: FeedbackTabState,
  changes: ChangeRegisterSource,
): LiveKeys {
  const bar: BarButton[] = [
    { key: "a", label: st.showArchived ? "a hide archived" : "a show archived" },
    { key: "t", label: "t focus" },
  ];
  if (st.focus === "proposed" && store.proposals[st.propSel] !== undefined) {
    bar.push({ key: "A", label: "A accept" }, { key: "x", label: "x reject" });
  }
  if (st.focus === "changed" && (changes.register?.entries ?? [])[st.changeSel] !== undefined)
    bar.push({ key: "R", label: "R revert" });
  return { bar, inline: st.armed !== undefined ? ["y", "Y"] : [] };
}

export function renderFeedbackTab(
  store: LearningStore,
  st: FeedbackTabState,
  changes: ChangeRegisterSource,
  dryRun: boolean | undefined,
  cols: number,
  rows: number,
  repo: string | undefined,
  now: Date,
  /** The daemon's last status.json — the lesson headline's only source;
   * undefined until the first heartbeat is read. */
  snapshot?: StatusSnapshot,
): Frame {
  const frame = new Frame(cols, rows);
  const inbox = feedbackInbox(store.entries, st.showArchived);
  const unprocessed = inbox.filter(
    (e) => feedbackPresentation(e, store.entries)?.status === "unprocessed",
  ).length;
  frame.set(
    0,
    rule(cols, "┌", "┐", [
      `${HEADING}quickreview${RESET}`,
      modeBadge(dryRun),
      "feedback",
      `${MUTED}signal ▸ adjudication ▸ proposal ▸ change ▸ revert${RESET}`,
      ...(store.memError ? [`${WARN}${STRONG}✖ MEMORY UNREACHABLE${RESET}`] : []),
    ]),
  );
  const live = feedbackKeys(store, st, changes);
  const bodyRows = rows - 2 - barHeight("feedback", cols, live.bar);
  const { leftW, rightW } = splitWidths(cols);
  const focusTitle = (title: string, focus: FeedbackFocus): string =>
    st.focus === focus ? `${sectionTitle(title)} ${ACCENT}◂${RESET}` : sectionTitle(title);

  // ---- left: the inbox --------------------------------------------------------
  const left: string[] = [];
  const leftActions: Array<FeedbackAction | undefined> = [];
  if (!store.memLoaded) {
    left.push(sectionTitle("INBOX (—)"));
    left.push(emptyLine({ kind: "unread", how: "reading the store" }));
  } else if (store.memError) {
    left.push(sectionTitle("INBOX (—)"));
    left.push(`${WARN}${STRONG}✖ MEMORY UNREACHABLE${RESET}`);
    for (const l of wrap(sanitizeText(store.memError), leftW - 3)) left.push(`${WARN}${l}${RESET}`);
    left.push(`${MUTED}the signals live in memory — r retries.${RESET}`);
  } else {
    // Part of memory answered and part did not: the counts are of what was
    // read, and the inbox says so rather than passing for complete.
    const partial = store.memWarn !== undefined;
    left.push(
      `${focusTitle(`INBOX (${inbox.length}${partial ? "+?" : ""})`, "inbox")} ${MUTED}${unprocessed}${partial ? "+?" : ""} unprocessed${RESET}`,
    );
    if (partial)
      left.push(
        `${WARN}⚠ ${truncate(sanitizeText(`partial read — ${store.memWarn}`), leftW - 5)}${RESET}`,
      );
    if (inbox.length === 0 && !partial) {
      left.push(
        st.showArchived
          ? emptyLine({
              kind: "none",
              what: "[feedback] comments, dismissed reviews, merges over a block and withdrawn triggers land here",
            })
          : emptyLine({ kind: "filtered", what: "a shows archived (acted-on) signals" }),
      );
    }
  }
  while (leftActions.length < left.length) leftActions.push(undefined);
  const sel = Math.min(st.sel, Math.max(0, inbox.length - 1));
  const visible = Math.max(1, bodyRows - left.length);
  const start = windowStart(sel, inbox.length, visible);
  inbox.slice(start, start + visible).forEach((e, offset) => {
    const i = start + offset;
    const card = feedbackPresentation(e, store.entries)!;
    const line = feedbackEntryLine(e, card, leftW - 3);
    left.push(st.focus === "inbox" && i === sel ? selectedLine(line) : line);
    leftActions.push({ t: "signal", i });
  });

  // ---- right: the card, then the rest of the loop -----------------------------
  const right: Array<ZonedRow<FeedbackAction>> = [];
  const row = (chunks: Array<RowChunk<FeedbackAction>>, gap?: string): void => {
    right.push(zonedRow(chunks, gap));
  };
  // The rows the focused verb acts on — the selected proposal, or the armed
  // confirmation and the selected change — which the pane scrolls to keep on
  // screen: a verb must never act on a row the operator cannot see.
  let focusFrom: number | undefined;
  let focusTo = 0;
  const markFocus = (from: number): void => {
    focusFrom = from;
    focusTo = right.length - 1;
  };
  const selected = inbox[sel];
  const card = selected ? feedbackPresentation(selected, store.entries) : undefined;
  if (selected && card) {
    row([
      { text: `${sectionTitle("SIGNAL")} ${selected.ts} ${MUTED}episode=${card.episode}${RESET}` },
    ]);
    row([{ text: statusLine(card.status) }]);
    const cardCap = Math.max(6, bodyRows - 18);
    const text = [
      `TITLE\n${card.title}`,
      "",
      `SUMMARY\n${card.summary}`,
      "",
      `RAW FEEDBACK\n${card.raw}`,
      "",
      `WHAT WE CAN LEARN\n${card.learning}`,
    ].join("\n");
    const wrapped = wrap(sanitizeText(text), rightW - 3);
    for (const l of wrapped.slice(0, cardCap)) row([{ text: l }]);
    if (wrapped.length > cardCap)
      row([{ text: `… ${wrapped.length - cardCap} more lines`, dim: true }]);
    row([{ text: "" }]);
  }

  row([
    {
      text: focusTitle(
        store.propLoaded ? `PROPOSED (${store.proposals.length})` : "PROPOSED (—)",
        "proposed",
      ),
    },
    { text: "the companion's rubric changes, waiting on you", dim: true },
  ]);
  if (st.focus === "proposed") markFocus(right.length - 1);
  if (!store.propLoaded)
    row([{ text: emptyLine({ kind: "unread", how: "listing state/rubric/" }) }]);
  else if (store.proposals.length === 0)
    row([
      {
        text: emptyLine({
          kind: "none",
          what: "the companion authors proposals into state/rubric/",
        }),
      },
    ]);
  store.proposals.forEach((p, i) => {
    const isSel = st.focus === "proposed" && i === st.propSel;
    const from = right.length;
    row([
      {
        text: isSel
          ? selectedLine(`▸ ${truncate(p.slug, rightW - 26)}`)
          : `▸ ${truncate(p.slug, rightW - 26)}`,
        action: { t: "prop", i },
      },
      { text: button("A accept"), action: { t: "prop-accept", i } },
      { text: button("x reject"), action: { t: "prop-reject", i } },
    ]);
    if (p.head[0]) row([{ text: truncate(`  ${p.head[0]}`, rightW - 2), dim: true }]);
    if (isSel) markFocus(from);
  });
  row([{ text: "" }]);

  const register = changes.register;
  const problem = changes.problem;
  const entries = register?.entries ?? [];
  const reverted = entries.filter((e) => e.reverted).length;
  row([
    { text: focusTitle(register ? `CHANGED (${entries.length})` : "CHANGED (—)", "changed") },
    {
      text: register
        ? `landed and revertible · ${reverted} reverted · scanned ${register.scanned} commits ${fmtAge(register.updated_at, now)} ago${st.changesLoading ? " · refreshing…" : ""}`
        : st.changesLoading
          ? "scanning git log…"
          : "",
      dim: true,
    },
  ]);
  if (st.focus === "changed") markFocus(right.length - 1);
  // "none yet" is a claim, made only when a scan succeeded and found none.
  // The two ways of not knowing each get their own sentence, and
  // neither hides the rows already in memory.
  if (problem?.kind === "register_unreadable") {
    row([
      {
        text: emptyLine({
          kind: "unreadable",
          why: `change register unreadable (${sanitizeText(problem.reason)}) — nothing is scanned or saved over it; fix the file, then r`,
        }),
      },
    ]);
  } else if (problem) {
    row([
      {
        text: emptyLine({
          kind: "unreadable",
          why: register
            ? `last git log scan failed (${sanitizeText(problem.reason)}) — list may be behind; r retries`
            : `git log failed (${sanitizeText(problem.reason)}) — whether there are feedback-derived commits is unknown; r retries`,
        }),
      },
    ]);
  }
  if (!register) {
    if (!problem)
      row([
        {
          text: emptyLine({
            kind: "unread",
            how: "the register is scanned from git log · r retries",
          }),
        },
      ]);
  } else if (entries.length === 0 && !problem) {
    row([
      {
        text: emptyLine({
          kind: "none",
          what: "a change joins this list when it carries a Ratified-in-session: trailer",
        }),
      },
    ]);
  }
  const armedEntry = st.armed ? entries.find((e) => e.sha === st.armed) : undefined;
  const armedFrom = right.length;
  if (armedEntry) for (const l of armedLines(armedEntry, rightW - 3)) row([{ text: l }]);
  const changeSel = Math.min(st.changeSel, Math.max(0, entries.length - 1));
  const changeStart = windowStart(changeSel, entries.length, 4);
  entries.slice(changeStart, changeStart + 4).forEach((e, offset) => {
    const i = changeStart + offset;
    const head = headline(e, now, rightW - 3);
    const from = armedEntry ? armedFrom : right.length;
    row([
      {
        text: st.focus === "changed" && i === changeSel ? selectedLine(head) : head,
        action: { t: "change", i },
      },
    ]);
    row([{ text: `  ${provenance(e, rightW - 5)}`, action: { t: "change", i } }]);
    if (st.focus === "changed" && i === changeSel) markFocus(from);
  });
  if (st.result) {
    row([{ text: truncate(st.result, rightW - 2) }]);
    if (st.focus === "changed") focusTo = right.length - 1;
  }
  row([{ text: "" }]);

  // The lesson shadow ledger's headline — the evidence the
  // operator reads before switching `[memory] delivery` on.
  const lessons = lessonsHeadline(snapshot);
  row([
    { text: sectionTitle(lessons.title) },
    { text: "qcr lessons shadow-report has it per lesson, per lens and per tier", dim: true },
  ]);
  for (const l of lessons.lines) row([{ text: truncate(l, rightW - 2) }]);
  row([{ text: "" }]);

  const read = store.tickets;
  const filed = read.kind === "read" ? read.tickets : undefined;
  const actionable = filed?.filter(isActionableTicket) ?? [];
  row([
    {
      text: sectionTitle(
        filed ? `FILED (${actionable.length} actionable / ${filed.length} total)` : "FILED (—)",
      ),
    },
    {
      text: button(`${tabDigit("tickets")} tickets`),
      action: { t: "key", key: tabDigit("tickets") },
    },
  ]);
  if (read.kind === "unread")
    row([
      { text: emptyLine({ kind: "unread", how: "the tracker is scanned behind the first frame" }) },
    ]);
  else if (read.kind === "unconfigured")
    row([{ text: emptyLine({ kind: "unreadable", why: "no tracker configured" }) }]);
  else if (read.kind === "unreadable")
    row([{ text: emptyLine({ kind: "unreadable", why: read.reason }) }]);
  else if (actionable.length === 0)
    row([
      {
        text: emptyLine({
          kind: "none",
          what: "adjudication files a ticket only when something changes",
        }),
      },
    ]);
  for (const ticket of actionable.slice(0, 3))
    row([
      {
        text: truncate(`${ticket.id} [${ticket.status}] ${ticket.title}`, rightW - 3),
        action: { t: "key", key: tabDigit("tickets") },
      },
    ]);
  row([{ text: "" }]);

  row([
    {
      text: sectionTitle(
        store.improvements === undefined
          ? "BOT PRs / ISSUES (—)"
          : `BOT PRs / ISSUES (${store.improvements.length})`,
      ),
    },
  ]);
  if (store.improvements === undefined)
    row([
      {
        text: emptyLine({ kind: "unread", how: "the gh query was skipped or failed · r retries" }),
      },
    ]);
  else if (store.improvementsFailed.length > 0)
    row([
      {
        text: emptyLine({
          kind: "unreadable",
          why: `the gh ${store.improvementsFailed.join(" + ")} list failed · r retries`,
        }),
      },
    ]);
  else if (store.improvements.length === 0)
    row([{ text: emptyLine({ kind: "none", what: "the overseer files them" }) }]);
  for (const it of (store.improvements ?? []).slice(0, 4)) {
    const url = repo
      ? `https://github.com/${repo}/${it.kind === "pr" ? "pull" : "issues"}/${it.number}`
      : undefined;
    row([
      {
        text: truncate(
          `${it.kind === "pr" ? "PR" : "IS"} #${it.number} [${it.state}] ${it.title}`,
          rightW - 2,
        ),
        action: url ? { t: "url", url } : undefined,
      },
    ]);
  }
  if (store.status) {
    row([{ text: "" }]);
    row([{ text: truncate(store.status, rightW - 2) }]);
  }

  // Scroll only as far as the focused rows need; when they cannot all fit,
  // their first row (the armed confirmation's head) stays on screen.
  const rightStart =
    focusFrom !== undefined && focusTo >= bodyRows
      ? Math.min(focusFrom, focusTo - bodyRows + 1)
      : 0;
  paintSplit(frame, {
    left,
    leftActions,
    right: right.slice(rightStart),
    leftW,
    rightW,
    top: 1,
    bodyRows,
  });
  paintCmdBar(frame, "feedback", cols, rows, live.bar);
  frame.set(rows - 1, rule(cols, "└", "┘", []));
  return frame;
}

/**
 * The LESSONS section: status.json `memory.lessons`, painted
 * honest-unknown — no snapshot yet is "not read yet", a daemon whose status
 * carries no memory block or no lesson block says so, and a ledger the daemon
 * could not read (null) is unknown. None of the four ever reads as zero
 * marks, which would tell the operator a lesson harmed nothing.
 */
export function lessonsHeadline(snapshot: StatusSnapshot | undefined): {
  title: string;
  lines: string[];
} {
  if (!snapshot)
    return {
      title: "LESSONS (—)",
      lines: [emptyLine({ kind: "unread", how: "waiting for the daemon's status.json" })],
    };
  const memory = snapshot.memory;
  if (!memory)
    return {
      title: "LESSONS (—)",
      lines: [
        emptyLine({
          kind: "unreadable",
          why: "this daemon reports no memory block — the lesson ledger is UNKNOWN",
        }),
      ],
    };
  const s = memory.lessons;
  if (s === undefined)
    return {
      title: "LESSONS (—)",
      lines: [
        emptyLine({
          kind: "unreadable",
          why: "this daemon predates the lesson shadow ledger and does not report it — UNKNOWN",
        }),
      ],
    };
  if (s === null)
    return {
      title: "LESSONS (—)",
      lines: [`${WARN}${STRONG}${lessonHeadline(null)}${RESET}`],
    };
  const title =
    s.delivery === "off"
      ? "LESSONS (delivery off)"
      : s.lessons_off
        ? "LESSONS (kill switch OFF)"
        : // `on` is delivering only with a selector built (memory
          // on); `on` without one runs nothing — never "shadow", which runs
          // the selection and its ledger.
          `LESSONS (${s.delivering ? "on" : s.delivery === "on" ? "on — nothing delivered" : "shadow"}, ${s.window_days}d)`;
  const line = lessonHeadline(s);
  // The marked findings by match tier — class the would-demote one, lens
  // evidence only — on a line of its own (the headline already fills the
  // pane); unknown from a daemon that reports no tier split, never an empty
  // split.
  const tiers = lessonTierLine(s);
  return {
    title,
    lines: [
      s.lessons_off ? `${WARN}${STRONG}${line}${RESET}` : line,
      ...(tiers === null ? [] : [tiers]),
    ],
  };
}

/** Install the feedback surface over the shared learning store and the
 * change register. */
export function installFeedbackTab(
  app: App,
  store: LearningStore,
  changes: ChangeRegisterSource,
): FeedbackTabState {
  const st: FeedbackTabState = {
    focus: "inbox",
    sel: 0,
    propSel: 0,
    changeSel: 0,
    showArchived: false,
    changesLoading: false,
  };
  const inbox = (): MemoryEntry[] => feedbackInbox(store.entries, st.showArchived);
  const selectSignal = (i: number): void => {
    const list = inbox();
    st.sel = moveSelection(i, 0, list.length);
    st.selKey = list[st.sel] ? entryKey(list[st.sel]!) : undefined;
  };
  store.onLoaded((part) => {
    if (part === "memory") {
      const list = inbox();
      const rebound = st.selKey ? list.findIndex((e) => entryKey(e) === st.selKey) : -1;
      selectSignal(rebound >= 0 ? rebound : st.sel);
    }
    if (part === "proposals")
      st.propSel = Math.min(st.propSel, Math.max(0, store.proposals.length - 1));
  });

  const reloadChanges = (): void => {
    if (st.changesLoading) return;
    st.changesLoading = true;
    void changes
      .refresh()
      .catch(() => {
        /* a failed scan keeps the persisted register — never an empty list; the
           source's `problem` carries the reason onto the screen */
      })
      .finally(() => {
        st.changesLoading = false;
        st.changeSel = Math.min(
          st.changeSel,
          Math.max(0, (changes.register?.entries.length ?? 1) - 1),
        );
        app.repaint();
      });
  };

  // One revert at a time: two in flight would both pass the clean-tree check
  // and interleave in the one checkout (a failing one runs `revert --abort`).
  let reverting = false;
  const runRevert = (sha: string): void => {
    st.armed = undefined;
    reverting = true;
    st.result = `${FG.dim}reverting ${sha.slice(0, 7)}…${RESET}`;
    app.repaint();
    void changes
      .revert(sha)
      .then(
        (res) => {
          st.result = res.ok ? `${OK}${res.message}${RESET}` : `${BAD}${res.message}${RESET}`;
          app.notice(res.message);
        },
        (err: unknown) => {
          const message = `revert ${sha.slice(0, 7)} failed: ${err instanceof Error ? err.message : String(err)}`;
          st.result = `${BAD}${message}${RESET}`;
          app.notice(message);
        },
      )
      .finally(() => {
        reverting = false;
        app.repaint();
      });
  };

  let lastZones: Zone<FeedbackAction>[] = [];
  let scannedOnce = false;

  app.hooks.tabs.feedback = {
    keys: () => feedbackKeys(store, st, changes),
    screen: (theApp, cols, rows) => {
      store.ensureMemory();
      store.ensureProposals();
      // The persisted register is the first paint; git is asked once per
      // session behind it, and again on `r`.
      if (!scannedOnce) {
        scannedOnce = true;
        reloadChanges();
      }
      const frame = renderFeedbackTab(
        store,
        st,
        changes,
        theApp.view.dryRun,
        cols,
        rows,
        theApp.view.repo,
        store.now(),
        theApp.view.snapshot,
      );
      lastZones = frame.zones as Zone<FeedbackAction>[];
      return frame;
    },
    click: (theApp, x, y): boolean => {
      const action = hitTest(lastZones, x, y);
      if (!action) return false;
      // A click that moves focus off the armed change disarms it: the pane may
      // scroll the confirmation out of view, and `y` must never run a revert
      // the operator can no longer see.
      if (
        action.t === "signal" ||
        action.t === "prop" ||
        action.t === "prop-accept" ||
        action.t === "prop-reject"
      )
        st.armed = undefined;
      switch (action.t) {
        case "key":
          theApp.pressKey(action.key);
          return true;
        case "signal":
          st.focus = "inbox";
          selectSignal(action.i);
          break;
        case "prop":
          st.focus = "proposed";
          st.propSel = action.i;
          break;
        case "prop-accept":
        case "prop-reject":
          st.focus = "proposed";
          st.propSel = action.i;
          theApp.pressKey(action.t === "prop-accept" ? "A" : "x");
          return true;
        case "change":
          st.focus = "changed";
          st.changeSel = action.i;
          st.armed = undefined; // any pointer move away from the armed row disarms
          break;
        case "url":
          theApp.hooks.openUrl?.(action.url);
          theApp.notice(`opened ${action.url}`);
          return true;
      }
      theApp.repaint();
      return true;
    },
    key: (theApp, key: BoardKey): boolean => {
      // Armed is modal: every key is either the confirmation or a cancel, so a
      // stray keystroke can never both cancel and do something else.
      if (st.armed !== undefined) {
        const ch = keyChar(key);
        const sha = st.armed;
        if (ch === "y" || ch === "Y") runRevert(sha);
        else {
          st.armed = undefined;
          st.result = `${FG.dim}revert cancelled${RESET}`;
          theApp.repaint();
        }
        return true;
      }
      const entries = changes.register?.entries ?? [];
      const proposal = store.proposals[st.propSel];
      switch (key.kind) {
        case "down":
        case "up": {
          const delta = key.kind === "down" ? 1 : -1;
          if (st.focus === "inbox") selectSignal(st.sel + delta);
          else if (st.focus === "proposed")
            st.propSel = moveSelection(st.propSel, delta, store.proposals.length);
          else st.changeSel = moveSelection(st.changeSel, delta, entries.length);
          theApp.repaint();
          return true;
        }
        case "refresh":
          store.reloadMemory();
          store.reloadProposals();
          store.reloadTickets();
          reloadChanges();
          return true;
        case "escape":
          if (st.result === undefined) return false;
          st.result = undefined;
          theApp.repaint();
          return true;
        case "attach":
          // `a`: show / hide the acted-on signals — the archive toggle.
          st.showArchived = !st.showArchived;
          selectSignal(0);
          theApp.repaint();
          return true;
        case "char":
          switch (key.ch) {
            case "t": {
              const i = FEEDBACK_FOCUS_ORDER.indexOf(st.focus);
              st.focus = FEEDBACK_FOCUS_ORDER[(i + 1) % FEEDBACK_FOCUS_ORDER.length]!;
              theApp.repaint();
              return true;
            }
            case "A":
              if (st.focus !== "proposed" || !proposal) return false;
              store.status = `accepting '${proposal.slug}'…`;
              theApp.repaint();
              store.verb(store.accept(proposal.slug));
              return true;
            case "x":
              if (st.focus !== "proposed" || !proposal) return false;
              theApp.promptInput(`reject '${proposal.slug}' — reason`, "", (reason) => {
                store.verb(store.reject(proposal.slug, reason));
              });
              return true;
            case "R": {
              if (st.focus !== "changed") return false;
              const entry = entries[st.changeSel];
              if (!entry) return false;
              if (entry.reverted) {
                st.result = `${WARN}${entry.short} was already reverted by ${entry.reverted.by}${RESET}`;
                theApp.repaint();
                return true;
              }
              if (reverting) {
                st.result = `${WARN}a revert is still running — wait for its result${RESET}`;
                theApp.repaint();
                return true;
              }
              st.armed = entry.sha;
              st.result = undefined;
              theApp.repaint();
              return true;
            }
            default:
              return false;
          }
        default:
          return false;
      }
    },
  };

  return st;
}
