// The digest view of tab [2] — the latest `digest/<date>.md`
// rendered full width ([ / ] page older/newer). Pre-18:00 the newest digest is
// yesterday's — it renders with a "(yesterday)" tag rather than pretending.
//
// the right-hand "AWAITING YOU" list is GONE, with the verb hint that
// advertised ⏎/w/m over it and the click zone under it. It could only ever be
// empty — its filter was `state === "awaiting_human"`, and that state was
// retired. The digest is a document you read top to bottom
//, so what it wanted was the width, not a neighbour.
import type { TuiConfig } from "../config.js";
import { paintCmdBar } from "./cmdbar.js";
import { HEADING, MUTED, RESET, modeBadge } from "./design.js";
import { Frame, rule } from "./paint.js";
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

/** Light markdown styling: headings accent, bullets kept, everything else raw. */
export function styleDigestLine(line: string): string {
  if (/^#{1,3} /.test(line)) return `${HEADING}${line.replace(/^#{1,3} /, "")}${RESET}`;
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

/** Click targets on the digest view: hint-bar keys. */
export type DigestAction = { t: "key"; key: string };

export interface DigestState {
  files: string[];
  /** Offset back from the newest file: 0 = latest, 1 = one older, … */
  back: number;
  content?: string;
  scroll: number;
  loaded: boolean;
}

export function currentFile(st: DigestState): string | undefined {
  return st.files[st.files.length - 1 - st.back];
}

export function renderDigestTab(st: DigestState, dryRun: boolean | undefined, today: string, cols: number, rows: number): Frame {
  const frame = new Frame(cols, rows);
  const file = currentFile(st);
  const date = file?.slice(0, 10);
  const tag = date && date < today ? " (yesterday)" : "";
  frame.set(0, rule(cols, "┌", "┐", [`${HEADING}quickreview${RESET}`, modeBadge(dryRun), `memory & learning · digest ${date ?? "—"}${tag}`]));

  const bodyRows = rows - 4; // top bar + command bar (2 rows) + bottom border

  const body: string[] = [];
  if (!st.loaded) body.push(`${MUTED}loading…${RESET}`);
  else if (!file) body.push(`${MUTED}none yet — the EOD sweep writes digest/<date>.md at 18:00${RESET}`);
  else if (st.content === undefined) body.push(`${MUTED}loading ${file}…${RESET}`);
  else for (const line of st.content.split("\n")) body.push(styleDigestLine(line));

  for (let r = 0; r < bodyRows; r++) {
    frame.boxRow(1 + r, [{ text: ` ${body[st.scroll + r] ?? ""}`, width: cols - 2 }]);
  }
  paintCmdBar(frame, "digest", cols, rows);
  frame.set(rows - 1, rule(cols, "└", "┘", []));
  return frame;
}
