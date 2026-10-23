// `[3] digest` — the document the EOD sweep writes, `digest/<date>.md`,
// rendered full width and read top to bottom. Its own tab because
// the operator reads it as a document rather than looking things up in it; `[`
// and `]` page to older / newer days, j/k scroll. Before the day's sweep the
// newest digest is yesterday's — it renders with a "(yesterday)" tag rather
// than pretending. "Yesterday" is a day in the `[eod]` timezone, the zone the
// sweep names its file in.
//
// The digest is a file on the VM, so "there is none" and "I could not look"
// are different facts: the fetcher's `list` is undefined when the
// listing itself failed, and the tab says so instead of showing an empty day.
import type { TuiConfig } from "../config.js";
import { DIGEST_DIR_NAME, digestFiles, zoneDateString } from "../eod.js";
import type { App } from "./app.js";
import { barHeight, paintCmdBar, type LiveKeys } from "./cmdbar.js";
import { HEADING, MUTED, RESET, modeBadge } from "./design.js";
import { emptyLine } from "./emptystate.js";
import type { BoardKey } from "./keys.js";
import type { LearningStore } from "./learning.js";
import { Frame, rule, sanitizeText } from "./paint.js";
import { dockerShArgv, type SshRunner } from "./remote.js";
import { remoteSandboxRoot, resolveLayout } from "./layout.js";

export function digestListArgv(cfg: TuiConfig): string[] {
  // A directory that does not exist yet is an EMPTY digest, not a failed
  // read — the sweep creates it with the first file. One that exists but
  // cannot be listed fails the exec, like a failed ssh, and the fetcher
  // reports both as undefined.
  const dir = `${remoteSandboxRoot(cfg)}/${DIGEST_DIR_NAME}`;
  return dockerShArgv(cfg, `if [ -e '${dir}' ]; then ls '${dir}'; fi`);
}

export function digestCatArgv(cfg: TuiConfig, file: string): string[] {
  return dockerShArgv(cfg, `cat '${remoteSandboxRoot(cfg)}/${DIGEST_DIR_NAME}/${file}'`);
}

/** Digest file names are `<YYYY-MM-DD>.md`; anything else is ignored. */
export function parseDigestList(stdout: string): string[] {
  return digestFiles(stdout.split("\n").map((l) => l.trim()));
}

/** Light markdown styling: headings accent, bullets kept, everything else raw. */
export function styleDigestLine(line: string): string {
  const heading = /^#{1,3} (.*)$/.exec(line);
  return heading ? `${HEADING}${heading[1]}${RESET}` : line;
}

/** When the EOD sweep runs (`[eod] time` / `timezone`) — the zone its digest
 * files are named in. */
export interface EodSchedule {
  time: string;
  timezone: string;
}

/** Today's digest date: the calendar day in the sweep's zone, or the UTC day
 * when the schedule was not handed in. */
export function digestToday(now: Date, eod?: EodSchedule): string {
  return eod ? zoneDateString(now, eod.timezone) : now.toISOString().slice(0, 10);
}

export interface DigestFetcher {
  /** The digest files, oldest first — or undefined when the listing FAILED
   * (an empty array is a real answer: nothing written yet). */
  list(): Promise<string[] | undefined>;
  read(file: string): Promise<string | undefined>;
}

export class SshDigestFetcher implements DigestFetcher {
  constructor(
    private readonly cfg: TuiConfig,
    private readonly ssh: SshRunner,
  ) {}

  async list(): Promise<string[] | undefined> {
    await resolveLayout(this.cfg, this.ssh);
    const res = await this.ssh(this.cfg.ssh_host, digestListArgv(this.cfg));
    return res.ok ? parseDigestList(res.stdout) : undefined;
  }

  async read(file: string): Promise<string | undefined> {
    const res = await this.ssh(this.cfg.ssh_host, digestCatArgv(this.cfg, file));
    return res.ok ? res.stdout : undefined;
  }
}

export interface DigestState {
  /** Undefined until listed; stays undefined when the listing failed. */
  files?: string[];
  /** Why `files` is undefined after a load — the read failed, not "none". */
  listError?: string;
  /** Offset back from the newest file: 0 = latest, 1 = one older, … */
  back: number;
  content?: string;
  /** Why `content` is undefined after a read of the current file — the cat
   * failed, which is not "still loading". */
  contentError?: string;
  scroll: number;
}

export function currentDigestFile(st: DigestState): string | undefined {
  const files = st.files ?? [];
  return files[files.length - 1 - st.back];
}

/** What the digest answers to: a page key only when there is a page that way. */
export function digestKeys(st: DigestState): LiveKeys {
  const files = st.files ?? [];
  const bar = [];
  if (st.back < files.length - 1) bar.push({ key: "[", label: "[ older" });
  if (st.back > 0) bar.push({ key: "]", label: "] newer" });
  return { bar, inline: [] };
}

/** The calendar day before a `YYYY-MM-DD` date, or undefined when it is not one. */
function previousDay(day: string): string | undefined {
  const t = Date.parse(`${day}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || Number.isNaN(t)) return undefined;
  return new Date(t - 86_400_000).toISOString().slice(0, 10);
}

export function renderDigestTab(
  st: DigestState,
  dryRun: boolean | undefined,
  today: string,
  cols: number,
  rows: number,
  eod?: EodSchedule,
): Frame {
  const frame = new Frame(cols, rows);
  const file = currentDigestFile(st);
  const date = file?.slice(0, 10);
  const tag = date && date === previousDay(today) ? " (yesterday)" : "";
  const files = st.files;
  const count = files === undefined ? "—" : String(files.length);
  frame.set(
    0,
    rule(cols, "┌", "┐", [
      `${HEADING}quickreview${RESET}`,
      modeBadge(dryRun),
      `digest ${date ?? "—"}${tag}`,
      `${MUTED}${count} days${RESET}`,
    ]),
  );

  const live = digestKeys(st);
  const bodyRows = rows - 2 - barHeight("digest", cols, live.bar); // top bar + command bar + bottom border

  const body: string[] = [];
  if (st.listError !== undefined)
    body.push(emptyLine({ kind: "unreadable", why: `${st.listError} · r retries` }));
  else if (files === undefined)
    body.push(emptyLine({ kind: "unread", how: "listing digest/ on the VM" }));
  else if (!file)
    body.push(
      emptyLine({
        kind: "none",
        what: eod
          ? `the EOD sweep writes digest/<date>.md at ${eod.time} ${eod.timezone}`
          : "the EOD sweep writes digest/<date>.md once a day, at [eod] time",
      }),
    );
  else if (st.contentError !== undefined)
    body.push(emptyLine({ kind: "unreadable", why: `${st.contentError} · r retries` }));
  else if (st.content === undefined) body.push(`${MUTED}loading ${file}…${RESET}`);
  else for (const line of sanitizeText(st.content).split("\n")) body.push(styleDigestLine(line));

  const from = Math.max(0, Math.min(st.scroll, body.length - bodyRows));
  for (let r = 0; r < bodyRows; r++) {
    frame.boxRow(1 + r, [{ text: ` ${body[from + r] ?? ""}`, width: cols - 2 }]);
  }
  paintCmdBar(frame, "digest", cols, rows, live.bar);
  frame.set(rows - 1, rule(cols, "└", "┘", []));
  return frame;
}

/** Install the digest surface over the shared learning store. */
export function installDigestTab(app: App, store: LearningStore, eod?: EodSchedule): void {
  app.hooks.tabs.digest = {
    keys: () => digestKeys(store.digest),
    screen: (theApp, cols, rows) => {
      store.ensureDigest();
      return renderDigestTab(
        store.digest,
        theApp.view.dryRun,
        digestToday(store.now(), eod),
        cols,
        rows,
        eod,
      );
    },
    key: (theApp, key: BoardKey): boolean => {
      switch (key.kind) {
        // j/k AND the arrows scroll the document — there is nothing on this
        // surface to select.
        case "down":
        case "up":
          if (key.kind === "down") store.digest.scroll += 1;
          else store.digest.scroll = Math.max(0, store.digest.scroll - 1);
          theApp.repaint();
          return true;
        case "older":
        case "newer":
          if (!store.pageDigest(key.kind === "older" ? 1 : -1)) return false;
          theApp.repaint();
          return true;
        case "refresh":
          store.reloadDigest();
          return true;
        default:
          return false;
      }
    },
  };
}
