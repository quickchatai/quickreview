// Digest + awaiting-you tab — the digest-tab mockup: the
// latest `digest/<date>.md` rendered left ([ / ] page older/newer), the
// awaiting-owner list right (oldest first, age in days), rows actionable
// (⏎ attach · w why · m msg). Pre-18:00 the newest digest is yesterday's —
// it renders with a "(yesterday)" tag rather than pretending.
import type { TuiConfig } from "../config.js";
import type { App } from "./app.js";
import type { BoardKey } from "./keys.js";
import { awaitingRows, sortPrs, type SnapshotPr } from "./model.js";
import { Frame, SGR, rule, truncate } from "./paint.js";
import type { SshRunner } from "./remote.js";

function dockerSh(cfg: TuiConfig, script: string): string[] {
  return [...(cfg.sudo_docker ? ["sudo"] : []), "docker", "exec", cfg.container, "sh", "-c", script];
}

export function digestListArgv(cfg: TuiConfig): string[] {
  return dockerSh(cfg, `ls '${cfg.remote_sandbox_root}/digest' 2>/dev/null || true`);
}

export function digestCatArgv(cfg: TuiConfig, file: string): string[] {
  return dockerSh(cfg, `cat '${cfg.remote_sandbox_root}/digest/${file}'`);
}

/** Digest file names are `<YYYY-MM-DD>.md`; anything else is ignored. */
export function parseDigestList(stdout: string): string[] {
  return stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^\d{4}-\d{2}-\d{2}\.md$/.test(l))
    .sort(); // lexicographic == chronological
}

/** Light markdown styling: headings bold, bullets kept, everything else raw. */
export function styleDigestLine(line: string): string {
  if (/^#{1,3} /.test(line)) return `${SGR.bold}${line.replace(/^#{1,3} /, "")}${SGR.reset}`;
  return line;
}

export interface DigestFetcher {
  list(): Promise<string[]>;
  read(file: string): Promise<string | undefined>;
}

export class SshDigestFetcher implements DigestFetcher {
  constructor(
    private readonly cfg: TuiConfig,
    private readonly ssh: SshRunner,
  ) {}

  async list(): Promise<string[]> {
    const res = await this.ssh(this.cfg.ssh_host, digestListArgv(this.cfg));
    return res.ok ? parseDigestList(res.stdout) : [];
  }

  async read(file: string): Promise<string | undefined> {
    const res = await this.ssh(this.cfg.ssh_host, digestCatArgv(this.cfg, file));
    return res.ok ? res.stdout : undefined;
  }
}

/** Click targets on the digest view: hint-bar keys + awaiting-you rows. */
export type DigestAction = { t: "key"; key: string } | { t: "await"; pr: number; i: number };

export interface DigestState {
  files: string[];
  /** Offset back from the newest file: 0 = latest, 1 = one older, … */
  back: number;
  content?: string;
  scroll: number;
  awaitingSelected: number;
  loaded: boolean;
}

export function currentFile(st: DigestState): string | undefined {
  return st.files[st.files.length - 1 - st.back];
}

export function renderDigestTab(
  st: DigestState,
  snapshotPrs: SnapshotPr[],
  dryRun: boolean,
  today: string,
  cols: number,
  rows: number,
): Frame {
  const frame = new Frame(cols, rows);
  const file = currentFile(st);
  const date = file?.slice(0, 10);
  const tag = date && date < today ? " (yesterday)" : "";
  frame.set(0, rule(cols, "┌", "┐", ["quickreview", dryRun ? "DRY-RUN" : `${SGR.bgRed}${SGR.bold} LIVE ${SGR.reset}`, `memory & learning · digest ${date ?? "—"}${tag}`]));

  const leftW = Math.floor((cols - 3) * 0.55);
  const rightW = cols - 3 - leftW;
  const bodyRows = rows - 3; // top bar + hints + bottom border

  const left: string[] = [];
  if (!st.loaded) left.push(`${SGR.dim}loading…${SGR.reset}`);
  else if (!file) left.push(`${SGR.dim}no digest yet — the EOD sweep writes digest/<date>.md at 18:00${SGR.reset}`);
  else if (st.content === undefined) left.push(`${SGR.dim}loading ${file}…${SGR.reset}`);
  else for (const line of st.content.split("\n")) left.push(styleDigestLine(line));

  const awaiting = awaitingRows(snapshotPrs, new Date(`${today}T12:00:00Z`));
  const right: string[] = [`${SGR.bold}AWAITING YOU (${awaiting.length})${SGR.reset}`];
  awaiting.forEach((row, i) => {
    const label = `${String(row.ageDays).padStart(3)}d ⚑ #${row.pr.number} ${row.pr.title}`;
    right.push(i === st.awaitingSelected ? `${SGR.inverse}${truncate(label, rightW - 2)}${SGR.reset}` : truncate(label, rightW - 2));
    // Clickable: first click selects, second (via the tab's click handler)
    // attaches — same convention as the board's PR rows.
    frame.zones.push({ x1: leftW + 4, y1: 2 + i + 1, x2: cols - 1, y2: 2 + i + 1, action: { t: "await", pr: row.pr.number, i } satisfies DigestAction });
  });
  right.push("");
  right.push(`${SGR.dim}(⏎ attach · w why · m msg)${SGR.reset}`);

  for (let r = 0; r < bodyRows; r++) {
    frame.boxRow(1 + r, [
      { text: ` ${left[st.scroll + r] ?? ""}`, width: leftW + 1 },
      { text: ` ${right[r] ?? ""}`, width: rightW },
    ]);
  }
  const hint = ` [1]board [2]memory  v memory view  j/k scroll  [ older  ] newer  ↓/↑ pick  ⏎ attach  q quit`;
  frame.boxRow(rows - 2, [{ text: `${SGR.dim}${hint}${SGR.reset}`, width: cols - 2 }]);
  // Clickable hint chunks — the mouse path into the same key state machine.
  for (const [chunk, key] of [
    ["[1]board", "1"],
    ["v memory view", "v"],
    ["[ older", "["],
    ["] newer", "]"],
  ] as const) {
    const at = hint.indexOf(chunk);
    if (at >= 0) frame.zones.push({ x1: 2 + at, y1: rows - 1, x2: 2 + at + chunk.length - 1, y2: rows - 1, action: { t: "key", key } satisfies DigestAction });
  }
  frame.set(rows - 1, rule(cols, "└", "┘", []));
  return frame;
}

export function installDigestHooks(app: App, fetcher?: DigestFetcher): DigestState {
  const f = fetcher ?? new SshDigestFetcher(app.cfg, app.ssh);
  const st: DigestState = { files: [], back: 0, scroll: 0, awaitingSelected: 0, loaded: false };

  const load = async (): Promise<void> => {
    st.files = await f.list();
    st.loaded = true;
    const file = currentFile(st);
    st.content = file ? await f.read(file) : undefined;
    app.repaint();
  };

  app.hooks.digestScreen = (theApp, cols, rows) => {
    if (!st.loaded) void load();
    const prs = theApp.view.snapshot ? sortPrs(theApp.view.snapshot.prs) : [];
    const today = new Date().toISOString().slice(0, 10);
    return renderDigestTab(st, prs, theApp.view.dryRun, today, cols, rows).render();
  };

  app.hooks.digestKey = (theApp, key: BoardKey): boolean => {
    const awaiting = theApp.view.snapshot ? awaitingRows(sortPrs(theApp.view.snapshot.prs), new Date()) : [];
    switch (key.kind) {
      // j/k scroll the digest; arrow keys pick an awaiting-you row
      // (keybinding map splits them).
      case "down":
      case "up": {
        if (key.arrow) {
          const delta = key.kind === "down" ? 1 : -1;
          st.awaitingSelected = Math.max(0, Math.min(st.awaitingSelected + delta, Math.max(0, awaiting.length - 1)));
        } else if (key.kind === "down") st.scroll += 1;
        else st.scroll = Math.max(0, st.scroll - 1);
        theApp.repaint();
        return true;
      }
      case "digest-older":
        if (st.back < st.files.length - 1) {
          st.back += 1;
          st.scroll = 0;
          st.content = undefined;
          void (async () => {
            const file = currentFile(st);
            st.content = file ? await f.read(file) : undefined;
            theApp.repaint();
          })();
        }
        theApp.repaint();
        return true;
      case "digest-newer":
        if (st.back > 0) {
          st.back -= 1;
          st.scroll = 0;
          st.content = undefined;
          void (async () => {
            const file = currentFile(st);
            st.content = file ? await f.read(file) : undefined;
            theApp.repaint();
          })();
        }
        theApp.repaint();
        return true;
      case "enter": {
        const row = awaiting[st.awaitingSelected];
        if (row) void theApp.hooks.attach?.(`pr-${row.pr.number}`, theApp);
        return true;
      }
      case "detail": {
        const row = awaiting[st.awaitingSelected];
        if (row) {
          theApp.tab = "board";
          theApp.selectPr(row.pr.number);
          theApp.view.detailFull = true;
          theApp.repaint();
        }
        return true;
      }
      case "message": {
        const row = awaiting[st.awaitingSelected];
        if (row) theApp.hooks.message?.(`pr-${row.pr.number}`, theApp);
        return true;
      }
      case "refresh":
        st.loaded = false;
        void load();
        return true;
      default:
        return false; // 1/2/q/? fall through to the app
    }
  };

  return st;
}
