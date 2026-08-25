// The `[5] changes` tab — every feedback-derived change this loop has
// produced, newest first, with a one-key revert.
//
// The register itself (what counts as one, how reverts are read back) lives in
// `changelog-store.ts`. This file is the surface: how it paints, which keys it
// answers to, and the confirmation the revert goes through.
//
// THE CONFIRMATION IS DELIBERATE. The board is read-only over ssh with a short
// list of user-initiated exceptions — `msg.ts`'s inject file, `unwedge.ts`'s
// command file — and this revert is the third. `u` acts instantly and that is
// right for it: an unwedge re-dispatches through the normal pump, posts
// nothing, and is recoverable by doing nothing. A revert is not that. It writes
// a commit into the checkout the companion is live in, and the rows in this
// list look alike by construction (same author, same prefix, one-line
// subjects), so the realistic failure is reverting the row NEXT to the one you
// meant. So `R` arms and paints exactly what will happen — the sha, the
// subject, the literal git command, and the fact that nothing is pushed — and
// `y` runs it. Any other key cancels, the same grammar the quit prompt uses.
// It is still one key to start and one to confirm; what the second press buys
// is that the thing named on screen is the thing that happens.
import type { App } from "./app.js";
import { ACCENT, BAD, HEADING, MUTED, OK, RESET as DRESET, SEP, STRONG, WARN, button, modeBadge, sectionTitle, selected as selectedLine } from "./design.js";
import { Frame, fit, rule, sanitizeText, truncate } from "./paint.js";
import { paintCmdBar } from "./cmdbar.js";
import type { BoardKey } from "./keys.js";
import type { ChangeEntry, ChangeLog, ChangeRegister } from "./changelog-store.js";
import { FG, RESET, fmtAge } from "./theme.js";

/** Clickable things the tab declares. */
export type ChangesAction = { t: "select"; index: number };

export interface ChangesView {
  register?: ChangeRegister;
  sel: number;
  scroll: number;
  /** The sha `R` armed; `y` runs it, anything else cancels. */
  armed?: string;
  /** Result of the last revert (or refusal), shown until the next action. */
  result?: string;
  loading: boolean;
  dryRun: boolean;
  now?: Date;
}

/** Rows a listed change occupies: the headline plus its provenance line. */
export const ROWS_PER_ENTRY = 2;

export function entriesOf(view: ChangesView): ChangeEntry[] {
  return view.register?.entries ?? [];
}

/** Clamp the selection and slide the window so the selected pair is visible. */
export function reflow(view: ChangesView, bodyRows: number): void {
  const n = entriesOf(view).length;
  view.sel = n === 0 ? 0 : Math.max(0, Math.min(view.sel, n - 1));
  const perPage = Math.max(1, Math.floor(bodyRows / ROWS_PER_ENTRY));
  if (view.sel < view.scroll) view.scroll = view.sel;
  if (view.sel >= view.scroll + perPage) view.scroll = view.sel - perPage + 1;
  view.scroll = Math.max(0, Math.min(view.scroll, Math.max(0, n - 1)));
}

/** `#5270 · · ratified "yes, all three"` — the provenance line. */
export function provenance(entry: ChangeEntry, width: number): string {
  const bits: string[] = [];
  bits.push(entry.feedback_pr ? `${FG.dim}feedback${RESET} #${sanitizeText(entry.feedback_pr)}` : `${FG.dim}no episode${RESET}`);
  if (entry.adjudication) bits.push(`${ACCENT}${sanitizeText(entry.adjudication)}${DRESET}`);
  bits.push(`${FG.dim}ratified ${sanitizeText(entry.ratified)}${RESET}`);
  if (entry.reverted) bits.push(`${WARN}reverted by ${entry.reverted.by}${DRESET}`);
  return truncate(bits.join(SEP), width);
}

export function headline(entry: ChangeEntry, now: Date, width: number): string {
  const mark = entry.reverted ? `${WARN}⤺${DRESET}` : `${OK}●${DRESET}`;
  const age = `${FG.dim}${fit(fmtAge(entry.at, now), 4)}${RESET}`;
  const subject = entry.reverted ? `${MUTED}${sanitizeText(entry.subject)}${DRESET}` : `${STRONG}${sanitizeText(entry.subject)}${DRESET}`;
  return truncate(`${mark} ${ACCENT}${entry.short}${DRESET} ${age} ${subject}`, width);
}

/** The armed banner: what will run, in the words git will run it in. */
export function armedLines(entry: ChangeEntry, width: number): string[] {
  return [
    truncate(`${WARN}${STRONG}REVERT${DRESET} ${ACCENT}${entry.short}${DRESET} ${STRONG}${sanitizeText(entry.subject)}${DRESET}`, width),
    truncate(`${FG.dim}runs${RESET} git revert --no-edit ${entry.short} ${FG.dim}in this checkout — no push, no GitHub, nothing near the mutation gate${RESET}`, width),
    truncate(`${button("y do it")}  ${button("any other key cancels")}`, width),
  ];
}

export function renderChanges(view: ChangesView, cols: number, rows: number): Frame {
  const frame = new Frame(cols, rows);
  const now = view.now ?? new Date();
  const entries = entriesOf(view);
  const reverted = entries.filter((e) => e.reverted).length;
  frame.set(
    0,
    rule(cols, "┌", "┐", [
      `${HEADING}quickreview${DRESET}`,
      modeBadge(view.dryRun),
      "changes",
      `${FG.dim}feedback-derived commits, newest first${RESET}`,
    ]),
  );

  const summary =
    entries.length === 0
      ? `${FG.dim}no feedback-derived commits yet — a change joins this list when it carries a ${RESET}Ratified-in-session:${FG.dim} trailer${RESET}`
      : `${STRONG}${entries.length}${DRESET} ${FG.dim}changes${RESET}${SEP}${reverted > 0 ? WARN : FG.dim}${reverted} reverted${reverted > 0 ? DRESET : RESET}${SEP}${FG.dim}scanned ${view.register?.scanned ?? 0} commits${view.register ? ` · ${fmtAge(view.register.updated_at, now)} ago` : ""}${RESET}`;
  frame.boxRow(1, [{ text: ` ${truncate(summary, cols - 3)}`, width: cols - 2 }]);
  frame.boxRow(2, [{ text: ` ${truncate(view.result ?? sectionTitle("CHANGES", "R reverts the selected one"), cols - 3)}`, width: cols - 2 }]);

  const bodyTop = 3;
  const bodyRows = rows - 5; // top bar + summary + result + command bar (2) + bottom
  reflow(view, bodyRows);

  const lines: Array<{ text: string; index?: number }> = [];
  const armedEntry = view.armed ? entries.find((e) => e.sha === view.armed) : undefined;
  if (armedEntry) {
    for (const l of armedLines(armedEntry, cols - 4)) lines.push({ text: ` ${l}` });
    lines.push({ text: "" });
  }
  for (let i = view.scroll; i < entries.length; i++) {
    const e = entries[i]!;
    const head = headline(e, now, cols - 4);
    lines.push({ text: ` ${i === view.sel ? selectedLine(head) : head}`, index: i });
    lines.push({ text: `   ${provenance(e, cols - 6)}`, index: i });
    if (lines.length > bodyRows) break;
  }

  for (let r = 0; r < bodyRows; r++) {
    const line = lines[r];
    frame.boxRow(bodyTop + r, [{ text: line?.text ?? "", width: cols - 2 }]);
    if (line?.index !== undefined) {
      frame.zones.push({ x1: 1, y1: bodyTop + r + 1, x2: cols, y2: bodyTop + r + 1, action: { t: "select", index: line.index } satisfies ChangesAction });
    }
  }
  paintCmdBar(frame, "changes", cols, rows);
  frame.set(rows - 1, rule(cols, "└", "┘", []));
  return frame;
}

// ---- hooks --------------------------------------------------------------------

/** Printable of a key, seen through the tab-key mapping (digits decode as tab
 * switches before they ever reach a tab handler). */
function keyChar(key: BoardKey): string | undefined {
  if (key.kind === "char") return key.ch;
  if (key.kind === "attach") return "a";
  return undefined;
}

export function installChangesHooks(app: App, log: ChangeLog): ChangesView {
  const view: ChangesView = { register: log.register, sel: 0, scroll: 0, loading: false, dryRun: app.view.dryRun };
  // The tab's own last frame, exactly as metricstab keeps one: hit-testing must
  // read the zones THIS tab painted, not the composed frame the App holds.
  let lastFrame: Frame | undefined;

  const reload = (): void => {
    if (view.loading) return;
    view.loading = true;
    void log
      .refresh()
      .then((reg) => {
        if (reg) view.register = reg;
      })
      .catch(() => {
        /* a failed scan keeps the persisted register — never an empty list */
      })
      .finally(() => {
        view.loading = false;
        app.repaint();
      });
  };

  const runRevert = (sha: string): void => {
    view.armed = undefined;
    view.result = `${FG.dim}reverting ${sha.slice(0, 7)}…${RESET}`;
    app.repaint();
    void log.revert(sha).then((res) => {
      view.result = res.ok ? `${OK}${res.message}${DRESET}` : `${BAD}${res.message}${DRESET}`;
      app.notice(res.message);
      if (res.ok) view.register = log.register;
      app.repaint();
    });
  };

  app.hooks.changesScreen = (theApp, cols, rows) => {
    view.dryRun = theApp.view.dryRun;
    view.now = new Date();
    if (!view.register && !view.loading) reload();
    const frame = renderChanges(view, cols, rows);
    lastFrame = frame;
    return frame;
  };

  app.hooks.changesClick = (theApp, x, y) => {
    if (!lastFrame) return false;
    for (const z of lastFrame.zones) {
      if (x >= z.x1 && x <= z.x2 && y >= z.y1 && y <= z.y2) {
        const action = z.action as ChangesAction;
        if (action.t === "select") {
          view.sel = action.index;
          view.armed = undefined; // any pointer move away from the armed row disarms
          theApp.repaint();
          return true;
        }
      }
    }
    return false;
  };

  app.hooks.changesKey = (theApp, key) => {
    // Armed is MODAL: every key is either the confirmation or a cancel, so a
    // stray keystroke can never both cancel and do something else.
    if (view.armed !== undefined) {
      const ch = keyChar(key);
      const sha = view.armed;
      if (ch === "y" || ch === "Y") {
        runRevert(sha);
        return true;
      }
      view.armed = undefined;
      view.result = `${FG.dim}revert cancelled${RESET}`;
      theApp.repaint();
      return true;
    }
    switch (key.kind) {
      case "up":
      case "down": {
        view.sel += key.kind === "down" ? 1 : -1;
        theApp.repaint();
        return true;
      }
      case "refresh":
        reload();
        return true;
      case "escape":
        view.result = undefined;
        theApp.repaint();
        return true;
      case "char": {
        if (key.ch !== "R") return false;
        const entry = entriesOf(view)[view.sel];
        if (!entry) return false;
        if (entry.reverted) {
          view.result = `${WARN}${entry.short} was already reverted by ${entry.reverted.by}${DRESET}`;
          theApp.repaint();
          return true;
        }
        view.armed = entry.sha;
        view.result = undefined;
        theApp.repaint();
        return true;
      }
      default:
        return false; // tabs/quit/help fall through to the app
    }
  };

  return view;
}
