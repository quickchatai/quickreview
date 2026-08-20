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
import type { BoardKey } from "./keys.js";
import { autofileDefects, type TrackerPaths } from "./autofile.js";
import { currentFile, renderDigestTab, SshDigestFetcher, type DigestFetcher, type DigestState } from "./digesttab.js";
import { awaitingRows, sortPrs } from "./model.js";
import { blockHash, defectEntries, timelineOrder, SshMemoryStore, type MemoryEntry, type MemoryStore } from "./memory.js";
import { Frame, SGR, rule, truncate } from "./paint.js";
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

/** The visible one-line form of a timeline entry. */
export function entryLine(e: MemoryEntry, width: number, highlightDay: string | undefined): string {
  const pin = e.pinned ? "● " : "  ";
  const tags = e.tags
    .filter((t) => t !== "pinned")
    .slice(0, 2)
    .map((t) => `#${t}`)
    .join(" ");
  const text = e.text.replace(/\s+/g, " ");
  const line = truncate(`${pin}${e.ts.slice(5, 16)} ${tags ? `${tags} ` : ""}${text}`, width);
  if (highlightDay && e.day === highlightDay) return `${SGR.bold}${line}${SGR.reset}`;
  return line;
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
  const leftW = Math.floor((cols - 3) * 0.6);
  const rightW = cols - 3 - leftW;
  const bodyRows = rows - 3;

  const ordered = timelineOrder(st.entries);
  const left: string[] = [];
  if (!st.memLoaded) left.push(`${SGR.dim}loading memory…${SGR.reset}`);
  else if (ordered.length === 0) left.push(`${SGR.dim}MEMORY.md is empty${SGR.reset}`);
  else {
    const budget = pinnedBudget(ordered);
    const budgetNote = budget.over ? ` ${SGR.bold}⚠ pinned ${budget.chars}ch > ~1900ch injection head${SGR.reset}` : "";
    left.push(`${SGR.bold}MEMORY (${ordered.length})${SGR.reset}${budgetNote}`);
    ordered.forEach((e, i) => {
      const line = entryLine(e, leftW - 3, highlightDay);
      const selected = st.focus === "timeline" && i === st.sel;
      left.push(selected ? `${SGR.inverse}${line}${SGR.reset}` : line);
    });
  }

  const right: string[] = [];
  right.push(`${SGR.bold}RUBRIC PROPOSALS (${st.proposals.length})${SGR.reset}`);
  if (!st.propLoaded) right.push(`${SGR.dim}loading…${SGR.reset}`);
  else if (st.proposals.length === 0) right.push(`${SGR.dim}none pending${SGR.reset}`);
  st.proposals.forEach((p, i) => {
    const selected = st.focus === "proposals" && i === st.propSel;
    const line = truncate(`▸ ${p.slug}`, rightW - 2);
    right.push(selected ? `${SGR.inverse}${line}${SGR.reset}` : line);
    for (const h of p.head.slice(0, 2)) right.push(`${SGR.dim}${truncate(`  ${h}`, rightW - 2)}${SGR.reset}`);
  });
  right.push("");
  right.push(`${SGR.bold}BOT PRs / ISSUES${SGR.reset}`);
  if (st.improvements.length === 0) right.push(`${SGR.dim}none${SGR.reset}`);
  for (const it of st.improvements.slice(0, 8)) {
    right.push(truncate(`${it.kind === "pr" ? "PR" : "IS"} #${it.number} [${it.state}] ${it.title}`, rightW - 2));
  }
  right.push("");
  const defects = defectEntries(st.entries);
  right.push(`${SGR.bold}DEFECT FLAGS (${defects.length})${SGR.reset}${st.filedTotal > 0 ? ` ${SGR.dim}${st.filedTotal} auto-filed${SGR.reset}` : ""}`);
  for (const d of defects.slice(0, 6)) right.push(truncate(`⚑ ${d.ts.slice(5, 10)} ${d.links[0] ?? d.text.slice(0, 30)}`, rightW - 2));
  if (st.status) {
    right.push("");
    right.push(truncate(st.status, rightW - 2));
  }

  for (let r = 0; r < bodyRows; r++) {
    frame.boxRow(1 + r, [
      { text: ` ${left[r === 0 ? 0 : r + st.scroll] ?? ""}`, width: leftW + 1 },
      { text: ` ${right[r] ?? ""}`, width: rightW },
    ]);
  }
  frame.boxRow(rows - 2, [
    {
      text: ` ${SGR.dim}v digest view · t focus · ↓/↑ pick · x× retire · p pin · e edit · n new · A accept R reject · [ ] day · r refresh${SGR.reset}`,
      width: cols - 2,
    },
  ]);
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
    st.entries = await memory.read();
    st.memLoaded = true;
    st.sel = Math.min(st.sel, Math.max(0, timelineOrder(st.entries).length - 1));
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
    void loadDigest();
    void loadMemory();
    void loadProposals();
  };

  const doAccept =
    deps.accept ??
    (async (theApp: App, slug: string) =>
      acceptProposal(
        {
          cfg: theApp.cfg,
          ssh: theApp.ssh,
          git: { run: deps.gitRun ?? failingGit },
          repoRoot: process.cwd(),
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

  app.hooks.digestScreen = (theApp, cols, rows) => {
    if (!st.digest.loaded && !st.memLoaded) loadAll();
    const today = now().toISOString().slice(0, 10);
    if (st.view === "digest") {
      const prs = theApp.view.snapshot ? sortPrs(theApp.view.snapshot.prs) : [];
      return renderDigestTab(st.digest, prs, theApp.view.dryRun, today, cols, rows).render();
    }
    const day = currentFile(st.digest)?.slice(0, 10);
    return renderMemoryView(st, theApp.view.dryRun, day, cols, rows).render();
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
        const delta = key.kind === "down" ? 1 : -1;
        if (st.focus === "timeline" && key.arrow) {
          st.sel = Math.max(0, Math.min(st.sel + delta, Math.max(0, ordered.length - 1)));
        } else if (st.focus === "proposals" && key.arrow) {
          st.propSel = Math.max(0, Math.min(st.propSel + delta, Math.max(0, st.proposals.length - 1)));
        } else {
          st.scroll = Math.max(0, st.scroll + delta);
        }
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
        return true;
      default:
        return false; // tabs/quit/help stay with the app
    }
  };

  return st;
}

const failingGit = (): Promise<string> => Promise.reject(new Error("local git runner not wired"));
