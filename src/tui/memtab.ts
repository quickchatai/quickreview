// The Memory & learning tab — the renamed [2] tab. Two views:
//
//   * digest view — the digest screen, unchanged in substance
//     (digest left, awaiting-you right), still paged by [ / ].
//   * memory view (`v` toggles) — the full memory timeline newest-first on
//     the left (pinned floated, the digest-selected day highlighted), the
//     proposals + defects stack on the right.
//
// Management verbs (memory view): x retire (press twice), p pin/unpin,
// e edit, n new #manual entry, t switch pane focus, A accept / R reject a
// rubric proposal. Every memory mutation goes through scripts/memedit.mjs
// (see src/tui/memory.ts for the addressing/optimistic-concurrency
// contract); accept/reject follow src/tui/proposals.ts (accept = merge +
// auto-ratify — the ratified decision).
//
// Real-time honesty: pi-memory injects a SNAPSHOT of memory taken
// at session checkpoints, so an edit made here reaches already-running
// sessions' ambient context only at their next checkpoint; memory_search
// sees it as soon as the qmd re-index lands (memedit triggers one).
import type { App } from "./app.js";
import { decodeKey, type BoardKey } from "./keys.js";
import { hitTest, type Zone } from "./mouse.js";
import { autofileDefects, type TrackerPaths } from "./autofile.js";
import { paintCmdBar } from "./cmdbar.js";
import { currentFile, renderDigestTab, SshDigestFetcher, type DigestAction, type DigestFetcher, type DigestState } from "./digesttab.js";
import { awaitingRows, sortPrs } from "./model.js";
import { blockHash, defectEntries, timelineOrder, SshMemoryStore, type MemoryEntry, type MemoryStore } from "./memory.js";
import { Frame, SGR, displayWidth, rule, sanitizeText, stripAnsi, truncate, wrap } from "./paint.js";
import {
  acceptProposal,
  improvementsArgv,
  parseImprovements,
  parseRubricList,
  rubricListArgv,
  rubricReadArgv,
  rubricRemoveArgv,
  type AcceptDeps,
  type ImprovementItem,
  type RubricProposal,
} from "./proposals.js";

export interface MemTabState {
  view: "digest" | "memory";
  digest: DigestState;
  entries: MemoryEntry[];
  memLoaded: boolean;
  focus: "timeline" | "proposals";
  sel: number;
  propSel: number;
  scroll: number;
  proposals: RubricProposal[];
  improvements: ImprovementItem[];
  propLoaded: boolean;
  /** Two-keystroke retire confirmation: the entry key armed by the first x. */
  confirmRetire?: string;
  /** One-line status of the last verb (also mirrored to app.notice). */
  status?: string;
  filedTotal: number;
}

export function entryKey(e: MemoryEntry): string {
  return `${e.ts}|${e.id}#${e.block}`;
}

/** The visible one-line form of a timeline entry. The text already leads
 * with its #tags — never re-print them as a prefix (they doubled before). */
export function entryLine(e: MemoryEntry, width: number, highlightDay: string | undefined): string {
  const pin = e.pinned ? "● " : "  ";
  const text = sanitizeText(e.text).replace(/\s+/g, " ");
  const line = truncate(`${pin}${e.ts.slice(5, 16)} ${text}`, width);
  if (highlightDay && e.day === highlightDay) return `${SGR.bold}${line}${SGR.reset}`;
  return line;
}

/** Every click target on the Memory & learning tab's memory view. */
export type MemAction =
  | { t: "key"; key: string }
  | { t: "mem"; i: number }
  | { t: "prop"; i: number }
  | { t: "prop-accept"; i: number }
  | { t: "prop-reject"; i: number }
  | { t: "url"; url: string };

interface RowChunk {
  text: string;
  action?: MemAction;
  dim?: boolean;
}

interface ZonedRow {
  text: string;
  zones: Array<{ x1: number; x2: number; action: MemAction }>;
}

/** Assemble one row from chunks, tracking each clickable chunk's x-range
 * relative to the row start (styling excluded from the measure). */
function zonedRow(chunks: RowChunk[], gap = "  "): ZonedRow {
  let text = "";
  let plainW = 0;
  const zones: ZonedRow["zones"] = [];
  for (const c of chunks) {
    if (text.length > 0) {
      text += gap;
      plainW += gap.length;
    }
    const w = displayWidth(stripAnsi(c.text));
    if (c.action) zones.push({ x1: plainW, x2: plainW + w - 1, action: c.action });
    text += c.dim ? `${SGR.dim}${c.text}${SGR.reset}` : c.text;
    plainW += w;
  }
  return { text, zones };
}

/** Pinned-region budget: only the first ~1,991 chars / 75 lines of
 * MEMORY.md survive injection truncation — warn when pins outgrow it. */
export function pinnedBudget(entries: MemoryEntry[]): { chars: number; over: boolean } {
  const chars = entries.filter((e) => e.pinned).reduce((n, e) => n + e.text.length + 2, 0);
  return { chars, over: chars > 1900 };
}

export function renderMemoryView(
  st: MemTabState,
  dryRun: boolean,
  highlightDay: string | undefined,
  cols: number,
  rows: number,
  repo?: string,
): Frame {
  const frame = new Frame(cols, rows);
  frame.set(
    0,
    rule(cols, "┌", "┐", [
      "quickreview",
      dryRun ? "DRY-RUN" : `${SGR.bgRed}${SGR.bold} LIVE ${SGR.reset}`,
      `memory & learning${highlightDay ? ` · ${highlightDay}` : ""}`,
    ]),
  );
  // List left (38%), reading pane right: the full selected entry WRAPPED —
  // the one-line list is for picking, never the only way to read a lesson.
  const leftW = Math.floor((cols - 3) * 0.38);
  const rightW = cols - 3 - leftW;
  const bodyRows = rows - 4; // top bar + command bar (2 rows) + bottom border

  const ordered = timelineOrder(st.entries);
  const left: string[] = [];
  const leftActions: Array<MemAction | undefined> = [];
  if (!st.memLoaded) left.push(`${SGR.dim}loading memory…${SGR.reset}`);
  else if (ordered.length === 0) left.push(`${SGR.dim}MEMORY.md is empty${SGR.reset}`);
  else {
    const budget = pinnedBudget(ordered);
    const budgetNote = budget.over ? ` ${SGR.bold}⚠ pinned ${budget.chars}ch${SGR.reset}` : "";
    left.push(`${SGR.bold}MEMORY (${ordered.length})${SGR.reset}${budgetNote}`);
    leftActions.push(undefined);
    // The window follows the selection — verbs act on the inverse row, so it
    // must never sit off-screen.
    const visible = bodyRows - 1;
    const start = Math.max(0, Math.min(st.sel - (visible - 1), ordered.length - visible));
    ordered.slice(Math.max(0, start), Math.max(0, start) + visible).forEach((e, i) => {
      const abs = Math.max(0, start) + i;
      const line = entryLine(e, leftW - 3, highlightDay);
      const selected = st.focus === "timeline" && abs === st.sel;
      left.push(selected ? `${SGR.inverse}${line}${SGR.reset}` : line);
      leftActions.push({ t: "mem", i: abs });
    });
  }

  const right: ZonedRow[] = [];
  const row = (chunks: RowChunk[], gap?: string): void => {
    right.push(zonedRow(chunks, gap));
  };
  const selected = ordered[st.sel];
  if (selected) {
    row([
      { text: `${SGR.bold}ENTRY${SGR.reset} ${selected.ts} [${selected.id}]${selected.pinned ? " ●pinned" : ""}` },
    ]);
    row([
      { text: "[e edit]", action: { t: "key", key: "e" } },
      { text: selected.pinned ? "[p unpin]" : "[p pin]", action: { t: "key", key: "p" } },
      { text: st.confirmRetire === entryKey(selected) ? `${SGR.bold}[x CONFIRM retire]${SGR.reset}` : "[x retire]", action: { t: "key", key: "x" } },
      { text: "[n new]", action: { t: "key", key: "n" } },
      { text: "[r refresh]", action: { t: "key", key: "r" } },
    ]);
    const detailCap = Math.max(5, bodyRows - 10 - st.proposals.length * 2 - Math.min(4, st.improvements.length));
    const wrapped = wrap(sanitizeText(selected.text), rightW - 3);
    for (const l of wrapped.slice(0, detailCap)) row([{ text: l }]);
    if (wrapped.length > detailCap) row([{ text: `… ${wrapped.length - detailCap} more lines`, dim: true }]);
  }
  row([{ text: "" }]);
  row([{ text: `${SGR.bold}RUBRIC PROPOSALS (${st.proposals.length})${SGR.reset}` }]);
  if (!st.propLoaded) row([{ text: "loading…", dim: true }]);
  else if (st.proposals.length === 0) row([{ text: "none pending", dim: true }]);
  st.proposals.forEach((p, i) => {
    const isSel = st.focus === "proposals" && i === st.propSel;
    row([
      { text: isSel ? `${SGR.inverse}▸ ${truncate(p.slug, rightW - 26)}${SGR.reset}` : `▸ ${truncate(p.slug, rightW - 26)}`, action: { t: "prop", i } },
      { text: "[accept]", action: { t: "prop-accept", i } },
      { text: "[reject]", action: { t: "prop-reject", i } },
    ]);
    if (p.head[0]) row([{ text: truncate(`  ${p.head[0]}`, rightW - 2), dim: true }]);
  });
  row([{ text: "" }]);
  row([{ text: `${SGR.bold}BOT PRs / ISSUES${SGR.reset}` }]);
  if (st.improvements.length === 0) row([{ text: "none", dim: true }]);
  for (const it of st.improvements.slice(0, 6)) {
    const url = repo ? `https://github.com/${repo}/${it.kind === "pr" ? "pull" : "issues"}/${it.number}` : undefined;
    row([
      {
        text: truncate(`${it.kind === "pr" ? "PR" : "IS"} #${it.number} [${it.state}] ${it.title}`, rightW - 2),
        action: url ? { t: "url", url } : undefined,
      },
    ]);
  }
  row([{ text: "" }]);
  const defects = defectEntries(st.entries);
  row([{ text: `${SGR.bold}DEFECT FLAGS (${defects.length})${SGR.reset}${st.filedTotal > 0 ? ` ${SGR.dim}${st.filedTotal} auto-filed${SGR.reset}` : ""}` }]);
  for (const d of defects.slice(0, 5)) {
    const i = ordered.findIndex((e) => entryKey(e) === entryKey(d));
    row([{ text: truncate(`⚑ ${d.ts.slice(5, 10)} ${d.links[0] ?? d.text.slice(0, 30)}`, rightW - 2), action: i >= 0 ? { t: "mem", i } : undefined }]);
  }
  if (st.status) {
    row([{ text: "" }]);
    row([{ text: truncate(st.status, rightW - 2) }]);
  }

  const rightX0 = leftW + 4; // │ + left cell (leftW+1) + │ + leading space
  for (let r = 0; r < bodyRows; r++) {
    const rr = right[r];
    frame.boxRow(1 + r, [
      { text: ` ${left[r] ?? ""}`, width: leftW + 1 },
      { text: ` ${rr?.text ?? ""}`, width: rightW },
    ]);
    const la = leftActions[r];
    if (la) frame.zones.push({ x1: 2, y1: r + 2, x2: leftW + 1, y2: r + 2, action: la });
    if (rr) for (const z of rr.zones) frame.zones.push({ x1: rightX0 + z.x1, y1: r + 2, x2: rightX0 + z.x2, y2: r + 2, action: z.action });
  }
  paintCmdBar(frame, "digest", cols, rows);
  frame.set(rows - 1, rule(cols, "└", "┘", []));
  return frame;
}

export interface MemTabDeps {
  memory?: MemoryStore;
  digestFetcher?: DigestFetcher;
  /** Fetch rubric slugs + heads and gh improvements; injectable for tests. */
  fetchProposals?: (app: App) => Promise<{ proposals: RubricProposal[]; improvements: ImprovementItem[] }>;
  accept?: (app: App, slug: string) => Promise<{ ok: boolean; message: string }>;
  reject?: (app: App, slug: string, reason: string) => Promise<{ ok: boolean; message: string }>;
  tracker?: TrackerPaths;
  gitRun?: AcceptDeps["git"]["run"];
  /** The canonical repo root the accept path applies/ratifies/commits in —
   * NOT process.cwd(): `qcr` runs from anywhere. */
  repoRoot?: string;
  now?: () => Date;
}

export function installMemoryLearningHooks(app: App, deps: MemTabDeps = {}): MemTabState {
  const memory = deps.memory ?? new SshMemoryStore(app.cfg, app.ssh);
  const digestFetcher = deps.digestFetcher ?? new SshDigestFetcher(app.cfg, app.ssh);
  const now = deps.now ?? (() => new Date());
  const st: MemTabState = {
    view: "digest",
    digest: { files: [], back: 0, scroll: 0, awaitingSelected: 0, loaded: false },
    entries: [],
    memLoaded: false,
    focus: "timeline",
    sel: 0,
    propSel: 0,
    scroll: 0,
    proposals: [],
    improvements: [],
    propLoaded: false,
    filedTotal: 0,
  };

  const loadDigest = async (): Promise<void> => {
    st.digest.files = await digestFetcher.list();
    st.digest.loaded = true;
    const file = currentFile(st.digest);
    st.digest.content = file ? await digestFetcher.read(file) : undefined;
    app.repaint();
  };

  const loadMemory = async (): Promise<void> => {
    const prevKey = timelineOrder(st.entries)[st.sel] ? entryKey(timelineOrder(st.entries)[st.sel]!) : undefined;
    st.entries = await memory.read();
    st.memLoaded = true;
    // Re-bind the selection to the same ENTRY, not the same ordinal — a
    // refresh that reorders the timeline must not silently redirect the
    // next verb keystroke to a different entry.
    const ordered = timelineOrder(st.entries);
    const rebound = prevKey ? ordered.findIndex((e) => entryKey(e) === prevKey) : -1;
    st.sel = rebound >= 0 ? rebound : Math.min(st.sel, Math.max(0, ordered.length - 1));
    if (deps.tracker) {
      const filed = autofileDefects(deps.tracker, defectEntries(st.entries), now().toISOString());
      if (filed.length > 0) {
        st.status = `auto-filed ${filed.map((f) => f.ticketId).join(", ")}`;
        app.notice(`memory: auto-filed ${filed.length} defect ticket(s): ${filed.map((f) => f.ticketId).join(", ")}`);
      }
      st.filedTotal += filed.length;
    }
    app.repaint();
  };

  const defaultFetchProposals = async (theApp: App): Promise<{ proposals: RubricProposal[]; improvements: ImprovementItem[] }> => {
    const listRes = await theApp.ssh(theApp.cfg.ssh_host, rubricListArgv(theApp.cfg));
    const slugs = listRes.ok ? parseRubricList(listRes.stdout) : [];
    const proposals: RubricProposal[] = [];
    for (const slug of slugs) {
      const head = await theApp.ssh(theApp.cfg.ssh_host, rubricReadArgv(theApp.cfg, slug, "PROPOSAL.md"));
      proposals.push({
        slug,
        head: head.ok
          ? head.stdout
              .split("\n")
              .filter((l) => l.trim().length > 0)
              .slice(0, 3)
          : [],
      });
    }
    const repo = theApp.view.repo ?? "";
    let improvements: ImprovementItem[] = [];
    if (repo) {
      const res = await theApp.ssh(theApp.cfg.ssh_host, improvementsArgv(theApp.cfg, repo), { timeoutMs: 20_000 });
      if (res.ok) improvements = parseImprovements(res.stdout);
    }
    return { proposals, improvements };
  };

  const loadProposals = async (): Promise<void> => {
    const { proposals, improvements } = await (deps.fetchProposals ?? defaultFetchProposals)(app);
    st.proposals = proposals;
    st.improvements = improvements;
    st.propLoaded = true;
    st.propSel = Math.min(st.propSel, Math.max(0, proposals.length - 1));
    app.repaint();
  };

  const loadAll = (): void => {
    guard("digest", loadDigest);
    guard("memory", loadMemory);
    guard("proposals", loadProposals);
  };

  const doAccept =
    deps.accept ??
    (async (theApp: App, slug: string) =>
      acceptProposal(
        {
          cfg: theApp.cfg,
          ssh: theApp.ssh,
          git: { run: deps.gitRun ?? failingGit },
          repoRoot: deps.repoRoot ?? process.cwd(),
          today: () => now().toISOString().slice(0, 10),
        },
        slug,
      ));

  const doReject =
    deps.reject ??
    (async (theApp: App, slug: string, reason: string) => {
      const rm = await theApp.ssh(theApp.cfg.ssh_host, rubricRemoveArgv(theApp.cfg, slug));
      if (!rm.ok) return { ok: false, message: `could not remove state/rubric/${slug}` };
      // The sweep's never-re-propose contract rides this memory entry.
      const mem = await memory.apply({ op: "add", text: `#rejected-proposal ${slug} — ${reason}` });
      return { ok: mem.ok, message: mem.ok ? `rejected '${slug}' — recorded` : `rejected '${slug}' but the memory record failed: ${mem.message}` };
    });

  const verb = (p: Promise<{ ok: boolean; message: string }>): void => {
    void p.then((res) => {
      st.status = `${res.ok ? "✓" : "✖"} ${res.message}`;
      app.notice(st.status);
      void loadMemory();
      void loadProposals();
    });
  };

  // Per-part lazy reload with in-flight guards: an invalidation of one part
  // (e.g. a companion memedit flips memLoaded) re-fetches exactly that part
  // on the next paint, and a paint during a load never stacks a second one.
  const busy = { digest: false, memory: false, proposals: false };
  const guard = (key: keyof typeof busy, run: () => Promise<void>): void => {
    if (busy[key]) return;
    busy[key] = true;
    void run().finally(() => {
      busy[key] = false;
    });
  };

  /** The last painted frame's click zones — hitTest target for digestClick. */
  let lastZones: Array<{ x1: number; y1: number; x2: number; y2: number; action: unknown }> = [];

  app.hooks.digestScreen = (theApp, cols, rows) => {
    if (!st.digest.loaded) guard("digest", loadDigest);
    if (!st.memLoaded) guard("memory", loadMemory);
    if (!st.propLoaded) guard("proposals", loadProposals);
    const today = now().toISOString().slice(0, 10);
    if (st.view === "digest") {
      const prs = theApp.view.snapshot ? sortPrs(theApp.view.snapshot.prs) : [];
      const frame = renderDigestTab(st.digest, prs, theApp.view.dryRun, today, cols, rows);
      lastZones = frame.zones;
      return frame.render();
    }
    const day = currentFile(st.digest)?.slice(0, 10);
    const frame = renderMemoryView(st, theApp.view.dryRun, day, cols, rows, theApp.view.repo);
    lastZones = frame.zones;
    return frame.render();
  };

  // Mouse: every row and [button] on the tab is a zone; a click either
  // selects (rows) or synthesizes the verb's keystroke (buttons), so the
  // keyboard and the mouse share one state machine (retire keeps its
  // two-step confirm either way).
  app.hooks.digestClick = (theApp, x, y): void => {
    const action = hitTest(lastZones as Zone<MemAction | DigestAction>[], x, y);
    if (!action) return;
    switch (action.t) {
      case "key":
        // Through the app's input path, so bar-style keys AND globals work
        // uniformly (the tab handler still gets first crack).
        theApp.pressKey(action.key);
        return;
      case "mem":
        st.view = "memory";
        st.focus = "timeline";
        st.sel = action.i;
        theApp.repaint();
        return;
      case "prop":
        st.focus = "proposals";
        st.propSel = action.i;
        theApp.repaint();
        return;
      case "prop-accept":
      case "prop-reject":
        st.focus = "proposals";
        st.propSel = action.i;
        theApp.hooks.digestKey?.(theApp, decodeKey(Buffer.from(action.t === "prop-accept" ? "A" : "R", "utf8")));
        return;
      case "url":
        theApp.hooks.openUrl?.(action.url);
        theApp.notice(`opened ${action.url}`);
        return;
      case "await": {
        // Like the board: first click selects the row, a second attaches.
        if (st.digest.awaitingSelected === action.i) {
          void theApp.hooks.attach?.(`pr-${action.pr}`, theApp);
        } else {
          st.digest.awaitingSelected = action.i;
          theApp.repaint();
        }
        return;
      }
    }
  };

  app.hooks.digestKey = (theApp, key: BoardKey): boolean => {
    if (key.kind === "char" && key.ch === "v") {
      st.view = st.view === "digest" ? "memory" : "digest";
      st.confirmRetire = undefined;
      theApp.repaint();
      return true;
    }
    if (st.view === "digest") return digestViewKey(theApp, key);
    return memoryViewKey(theApp, key);
  };

  const digestViewKey = (theApp: App, key: BoardKey): boolean => {
    const awaiting = theApp.view.snapshot ? awaitingRows(sortPrs(theApp.view.snapshot.prs), now()) : [];
    switch (key.kind) {
      case "down":
      case "up": {
        if (key.arrow) {
          const delta = key.kind === "down" ? 1 : -1;
          st.digest.awaitingSelected = Math.max(0, Math.min(st.digest.awaitingSelected + delta, Math.max(0, awaiting.length - 1)));
        } else if (key.kind === "down") st.digest.scroll += 1;
        else st.digest.scroll = Math.max(0, st.digest.scroll - 1);
        theApp.repaint();
        return true;
      }
      case "digest-older":
      case "digest-newer":
        return pageDigest(theApp, key.kind === "digest-older" ? 1 : -1);
      case "enter": {
        const row = awaiting[st.digest.awaitingSelected];
        if (row) void theApp.hooks.attach?.(`pr-${row.pr.number}`, theApp);
        return true;
      }
      case "detail": {
        const row = awaiting[st.digest.awaitingSelected];
        if (row) {
          theApp.tab = "board";
          theApp.selectPr(row.pr.number);
          theApp.view.detailFull = true;
          theApp.repaint();
        }
        return true;
      }
      case "message": {
        const row = awaiting[st.digest.awaitingSelected];
        if (row) theApp.hooks.message?.(`pr-${row.pr.number}`, theApp);
        return true;
      }
      case "refresh":
        st.digest.loaded = false;
        st.memLoaded = false;
        st.propLoaded = false;
        loadAll();
        return true;
      default:
        return false;
    }
  };

  const pageDigest = (theApp: App, dir: 1 | -1): boolean => {
    const next = st.digest.back + dir;
    if (next >= 0 && next < st.digest.files.length) {
      st.digest.back = next;
      st.digest.scroll = 0;
      st.digest.content = undefined;
      void (async () => {
        const file = currentFile(st.digest);
        st.digest.content = file ? await digestFetcher.read(file) : undefined;
        theApp.repaint();
      })();
    }
    theApp.repaint();
    return true;
  };

  const memoryViewKey = (theApp: App, key: BoardKey): boolean => {
    const ordered = timelineOrder(st.entries);
    const selected = ordered[st.sel];
    const proposal = st.proposals[st.propSel];
    if (!(key.kind === "char" && key.ch === "x")) st.confirmRetire = undefined;
    switch (key.kind) {
      case "down":
      case "up": {
        // j/k and arrows both move the selection; the render window follows
        // it, so there is no separate scroll to desynchronize from.
        const delta = key.kind === "down" ? 1 : -1;
        if (st.focus === "timeline") st.sel = Math.max(0, Math.min(st.sel + delta, Math.max(0, ordered.length - 1)));
        else st.propSel = Math.max(0, Math.min(st.propSel + delta, Math.max(0, st.proposals.length - 1)));
        theApp.repaint();
        return true;
      }
      case "digest-older":
      case "digest-newer":
        return pageDigest(theApp, key.kind === "digest-older" ? 1 : -1);
      case "refresh":
        st.memLoaded = false;
        st.propLoaded = false;
        loadAll();
        return true;
      case "events": {
        // `e` = edit (the board's events overlay has no meaning on this tab).
        if (st.focus !== "timeline" || !selected) return true;
        theApp.promptInput(`edit memory ${selected.id}@${selected.ts.slice(11)}`, selected.text, (text) => {
          verb(memory.apply({ op: "edit", id: selected.id, ts: selected.ts, block: selected.block, expect: blockHash(selected.text), text }));
        });
        return true;
      }
      case "char":
        switch (key.ch) {
          case "t":
            st.focus = st.focus === "timeline" ? "proposals" : "timeline";
            theApp.repaint();
            return true;
          case "x": {
            if (st.focus !== "timeline" || !selected) return true;
            const k = entryKey(selected);
            if (st.confirmRetire === k) {
              st.confirmRetire = undefined;
              verb(memory.apply({ op: "retire", id: selected.id, ts: selected.ts, block: selected.block, expect: blockHash(selected.text) }));
            } else {
              st.confirmRetire = k;
              st.status = `x again to retire: ${selected.text.slice(0, 40)}…`;
              theApp.repaint();
            }
            return true;
          }
          case "p": {
            if (st.focus !== "timeline" || !selected) return true;
            verb(
              memory.apply({
                op: selected.pinned ? "unpin" : "pin",
                id: selected.id,
                ts: selected.ts,
                block: selected.block,
                expect: blockHash(selected.text),
              }),
            );
            return true;
          }
          case "n":
            theApp.promptInput("new memory entry (#manual)", "", (text) => {
              verb(memory.apply({ op: "add", text }));
            });
            return true;
          case "A": {
            if (!proposal) return true;
            st.status = `accepting '${proposal.slug}'…`;
            theApp.repaint();
            verb(doAccept(theApp, proposal.slug));
            return true;
          }
          case "R": {
            if (!proposal) return true;
            theApp.promptInput(`reject '${proposal.slug}' — reason`, "", (reason) => {
              verb(doReject(theApp, proposal.slug, reason));
            });
            return true;
          }
          default:
            return true; // memory view swallows stray chars — nothing falls to the board
        }
      case "enter":
      // Decoded board verbs must not leak through to the board while the
      // memory view is up (`a` attaching an invisible board selection is one
      // shift-miss from `A` accept). Tabs, quit, and help still fall through.
      case "attach":
      case "message":
      case "detail":
      case "github":
      case "overseer":
      case "main-session":
      case "reconnect":
        return true;
      default:
        return false; // tabs/quit/help stay with the app
    }
  };

  return st;
}

const failingGit = (): Promise<string> => Promise.reject(new Error("local git runner not wired"));
