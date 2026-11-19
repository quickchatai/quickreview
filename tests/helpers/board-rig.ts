// Fixture state for the board (src/boardfile.ts, src/boardexport.ts): a real
// in-memory store on a scripted clock, the status snapshot the daemon would
// build from it, and the export's ports as fakes. No Docker, no files.
import type { BoardPorts } from "../../src/boardexport.js";
import { buildBoardFile, type BoardFile } from "../../src/boardfile.js";
import { known } from "../../src/home/ports.js";
import {
  StateStore,
  buildStatusSnapshot,
  type OpenPrSummary,
  type StatusSnapshot,
} from "../../src/state.js";

/** When the fixture daemon writes its board. */
export const T0 = new Date("2026-11-19T12:00:00.000Z");
/** When the export is read: twenty seconds later. */
export const NOW = T0.getTime() + 20_000;
/** An instant `s` seconds from the board's write, ISO. */
export const at = (s: number): string => new Date(T0.getTime() + s * 1000).toISOString();

export const HEAD = "abc1234567";

type PrInput = Parameters<StateStore["upsertPr"]>[0];

export const prRow = (number: number, over: Partial<PrInput> = {}): PrInput => ({
  number,
  state: "tracked",
  head_sha: HEAD,
  title: `PR ${number}`,
  author: "alice",
  trigger_ts: null,
  stale_recheck: 0,
  migration_gate: 0,
  ...over,
});

export interface FinishedRound {
  verdict: string;
  /** The head the round reviewed. */
  head?: string;
  /** What the round's posting confirmed. `id` null: a dry-run round, which
   * confirms its intended event and holds no review. */
  posted?: { event: string; id: number | null; at: string };
  /** The inline comments its findings record counts. */
  comments?: number;
}

/** A fixture world: the store, its clock, and the board the daemon would write. */
export class BoardWorld {
  clock = T0;
  readonly store = new StateStore(":memory:", () => this.clock);
  /** What the last reconcile pass listed; undefined: no pass has listed. */
  open: OpenPrSummary[] | undefined;
  dryRun = true;

  /** Move the clock `s` seconds from the board's write time. */
  tick(s: number): void {
    this.clock = new Date(T0.getTime() + s * 1000);
  }

  pr(number: number, over: Partial<PrInput> = {}): void {
    this.store.upsertPr(prRow(number, over));
  }

  /** One finished round on `pr`, as the daemon leaves it. */
  finished(pr: number, o: FinishedRound): number {
    const head = o.head ?? HEAD;
    const id = this.store.startRound(pr, "first", ["pass-baseline"], 45, { head_sha: head });
    this.store.finishRound(id, o.verdict, 0.25);
    if (o.posted)
      this.store.db
        .prepare(
          "UPDATE rounds SET posted_event = ?, posted_at = ?, gh_review_id = ?, gh_commit_id = ? WHERE id = ?",
        )
        .run(o.posted.event, o.posted.at, o.posted.id, head, id);
    if (o.comments !== undefined) this.store.recordRoundComments(id, o.comments);
    return id;
  }

  /** The snapshot the daemon builds at the clock, with its poll record and
   * the open list, as its status writer adds them. */
  snapshot(): StatusSnapshot {
    const snapshot = buildStatusSnapshot(this.store, this.dryRun, undefined, () => this.clock);
    snapshot.poll = {
      last_at: new Date(this.clock.getTime() - 60_000).toISOString(),
      ok: true,
      interval_s: 300,
    };
    if (this.open)
      snapshot.open_prs = {
        listed_at: new Date(this.clock.getTime() - 60_000).toISOString(),
        prs: this.open,
      };
    return snapshot;
  }

  board(snapshot: StatusSnapshot = this.snapshot()): BoardFile {
    return buildBoardFile(snapshot, (pr) => this.store.roundsFor(pr));
  }

  /** board.json's text, as the daemon writes it. */
  boardText(snapshot?: StatusSnapshot): string {
    return JSON.stringify(this.board(snapshot));
  }

  close(): void {
    this.store.close();
  }
}

export const openPr = (number: number, over: Partial<OpenPrSummary> = {}): OpenPrSummary => ({
  number,
  title: `PR ${number}`,
  author: "alice",
  draft: false,
  updated_at: at(-3600),
  ...over,
});

/** A config.toml a finished setup leaves: one repository, a person's identity. */
export const CONFIG = [
  "dry_run = true",
  "",
  "[github]",
  'repo = "acme/webapp"',
  'auth = "user"',
  'bot_login = "octo-dev"',
  'trigger_label = "AI review requested"',
  "",
].join("\n");

export const AGENT_DIR = "/pi/agent";
export const AUTH_FILE = `${AGENT_DIR}/auth.json`;
export const REFRESHER_FILE = `${AGENT_DIR}/loginrefresh.status.json`;
/** pi's auth file with one stored login (its type and expiry; no token). */
export const AUTH = JSON.stringify({ "openai-codex": { type: "oauth", expires: NOW + 3_600_000 } });

/** A read that fails as the filesystem does. */
export const fsError = (code: string, path: string): Error =>
  Object.assign(new Error(`${code}: ${path}`), { code });

/**
 * The export's ports as fakes: the daemon runs and has written no board, the
 * config is `CONFIG`, pi stores one login, and nothing says more. `files` is
 * what `read` finds (an Error is thrown; a path not listed is ENOENT).
 */
export function fakeBoardPorts(
  over: Partial<BoardPorts> & { files?: Record<string, string | Error> } = {},
): BoardPorts {
  const { files = { [AUTH_FILE]: AUTH }, ...ports } = over;
  return {
    now: () => NOW,
    daemon: async () => known("running" as const),
    boardFile: async () => known(null),
    config: () => known(CONFIG),
    agentDir: () => AGENT_DIR,
    read: (path) => {
      const found = files[path];
      if (found === undefined) throw fsError("ENOENT", path);
      if (found instanceof Error) throw found;
      return found;
    },
    // no token file says anything of itself here: the field is absent
    github: () => undefined,
    progress: () => ({}),
    ...ports,
  };
}
