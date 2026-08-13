// qcr tui — the app loop: terminal setup/teardown, poller wiring, key
// routing, repaint. Screens and logic are pure modules; this file owns the
// side effects. Slice: board + detail + events (attach and
// quick-message land in and plug in via AppHooks).
import type { WhyPayload } from "../cli.js";
import type { TuiConfig } from "../config.js";
import { renderBoard, type BoardView } from "./board.js";
import { decodeKey } from "./keys.js";
import { formatEvent, moveSelection, reselect, sortPrs, type EventLine } from "./model.js";
import { ALT_SCREEN_OFF, ALT_SCREEN_ON, CLEAR } from "./paint.js";
import { Poller } from "./poll.js";
import { eventsArgv, whyArgv, type SshRunner } from "./remote.js";

export interface AppHooks {
  /**: attach the given tmux session full-screen; resolves on detach. */
  attach?: (session: string, app: App) => Promise<void>;
  /**: open the quick-message box for the given session. */
  message?: (session: string, app: App) => void;
  /**: render the digest tab into a frame string; undefined = placeholder. */
  digestScreen?: (app: App, cols: number, rows: number) => string;
  /**: digest tab key handling; returns true when it consumed the key. */
  digestKey?: (app: App, key: ReturnType<typeof decodeKey>) => boolean;
}

export type Tab = "board" | "digest";

export class App {
  readonly view: BoardView = {
    health: { kind: "unreachable", sinceS: Number.POSITIVE_INFINITY },
    dryRun: true,
    events: [],
    selected: 0,
    detailFull: false,
    eventsFocus: false,
    eventsScroll: 0,
    help: false,
  };
  tab: Tab = "board";
  readonly poller: Poller;
  private selectedPr: number | undefined;
  private detailSeq = 0;
  private quitResolve: (() => void) | undefined;
  private suspended = false;
  private readonly onData = (buf: Buffer): void => this.handleInput(buf);
  private readonly onResize = (): void => this.repaint();

  constructor(
    readonly cfg: TuiConfig,
    readonly ssh: SshRunner,
    private readonly out: NodeJS.WriteStream = process.stdout,
    private readonly input: NodeJS.ReadStream = process.stdin,
    readonly hooks: AppHooks = {},
    private readonly now: () => Date = () => new Date(),
  ) {
    this.poller = new Poller(cfg, ssh, () => this.onPoll(), now);
  }

  // ---- lifecycle ---------------------------------------------------------

  async run(initialSelection?: number): Promise<void> {
    if (initialSelection !== undefined) this.selectedPr = initialSelection;
    this.out.write(ALT_SCREEN_ON + CLEAR);
    if (this.input.isTTY) this.input.setRawMode(true);
    this.input.resume();
    this.input.on("data", this.onData);
    this.out.on("resize", this.onResize);
    this.poller.start();
    await new Promise<void>((resolve) => (this.quitResolve = resolve));
    this.teardown();
  }

  private teardown(): void {
    this.poller.stop();
    this.input.off("data", this.onData);
    this.out.off("resize", this.onResize);
    if (this.input.isTTY) this.input.setRawMode(false);
    this.input.pause();
    this.out.write(ALT_SCREEN_OFF);
  }

  quit(): void {
    this.quitResolve?.();
  }

  /** Attach mode owns the terminal: stop painting and swallow board keys. */
  suspend(): void {
    this.suspended = true;
    this.input.off("data", this.onData);
  }

  resume(): void {
    this.suspended = false;
    this.input.on("data", this.onData);
    this.out.write(CLEAR);
    void this.refreshDetail();
    this.repaint();
  }

  // ---- data --------------------------------------------------------------

  private onPoll(): void {
    const snap = this.poller.state.snapshot;
    if (snap) {
      this.view.snapshot = snap;
      this.view.dryRun = snap.dry_run;
      const sorted = sortPrs(snap.prs);
      this.view.selected = reselect(sorted, this.selectedPr, this.view.selected);
      this.selectedPr = sorted[this.view.selected]?.number;
    }
    this.view.health = this.poller.health();
    void this.refreshEvents();
    if (this.view.detail?.pr !== this.selectedPr) void this.refreshDetail();
    this.repaint();
  }

  private async refreshEvents(): Promise<void> {
    const res = await this.ssh(this.cfg.ssh_host, eventsArgv(this.cfg, 20));
    if (!res.ok) return;
    try {
      const parsed = JSON.parse(res.stdout) as { events: Array<{ ts: string; kind: string; pr: number | null; payload: string | null }> };
      const lines = parsed.events.map(formatEvent).reverse(); // newest first
      this.view.events = this.mergeNotices(lines);
      this.repaint();
    } catch {
      /* keep the previous strip on parse failure */
    }
  }

  /** overrides this to splice quick-message pending/delivered rows. */
  protected mergeNotices(lines: EventLine[]): EventLine[] {
    return lines;
  }

  async refreshDetail(): Promise<void> {
    const pr = this.selectedPr;
    if (pr === undefined) return;
    const seq = ++this.detailSeq;
    const res = await this.ssh(this.cfg.ssh_host, whyArgv(this.cfg, pr));
    if (!res.ok || seq !== this.detailSeq) return;
    try {
      this.view.detail = JSON.parse(res.stdout) as WhyPayload;
      this.repaint();
    } catch {
      /* stale/garbled detail keeps the loading line */
    }
  }

  // ---- input -------------------------------------------------------------

  selectedSession(): string | undefined {
    const sorted = this.view.snapshot ? sortPrs(this.view.snapshot.prs) : [];
    const pr = sorted[this.view.selected];
    return pr ? `pr-${pr.number}` : undefined;
  }

  notice(text: string): void {
    this.view.noticeLine = text;
    this.repaint();
  }

  private handleInput(buf: Buffer): void {
    if (this.suspended) return;
    const key = decodeKey(buf);
    if (this.view.inputBox) return; // routes input-box keys itself

    if (this.view.help) {
      this.view.help = false;
      this.repaint();
      return;
    }
    if (this.tab === "digest" && this.hooks.digestKey?.(this, key)) return;

    switch (key.kind) {
      case "quit":
        this.quit();
        return;
      case "help":
        this.view.help = true;
        break;
      case "tab-board":
        this.tab = "board";
        break;
      case "tab-digest":
        this.tab = "digest";
        break;
      case "up":
      case "down": {
        if (this.view.eventsFocus) {
          const delta = key.kind === "down" ? 1 : -1;
          this.view.eventsScroll = Math.max(0, Math.min(this.view.eventsScroll + delta, Math.max(0, this.view.events.length - 3)));
          break;
        }
        const sorted = this.view.snapshot ? sortPrs(this.view.snapshot.prs) : [];
        this.view.selected = moveSelection(this.view.selected, key.kind === "down" ? 1 : -1, sorted.length);
        this.selectedPr = sorted[this.view.selected]?.number;
        void this.refreshDetail();
        break;
      }
      case "escape":
        this.view.eventsFocus = false;
        break;
      case "events":
        this.view.eventsFocus = !this.view.eventsFocus;
        this.view.eventsScroll = 0;
        break;
      case "detail":
        this.view.detailFull = !this.view.detailFull;
        break;
      case "refresh":
        void this.poller.tick();
        void this.refreshDetail();
        break;
      case "enter": {
        const session = this.selectedSession();
        if (!session) break;
        this.startAttach(session);
        return;
      }
      case "overseer":
        this.startAttach("overseer");
        return;
      case "main-session":
        this.startAttach("main");
        return;
      case "message": {
        const session = this.selectedSession();
        if (!session) break;
        if (this.hooks.message) this.hooks.message(session, this);
        else this.notice("quick-message lands in");
        break;
      }
      default:
        return; // unknown keys repaint nothing
    }
    this.repaint();
  }

  private startAttach(session: string): void {
    if (!this.hooks.attach) {
      this.notice(`attach ${session}: lands in`);
      return;
    }
    void this.hooks.attach(session, this);
  }

  // ---- paint -------------------------------------------------------------

  repaint(): void {
    if (this.suspended) return;
    const cols = this.out.columns ?? 80;
    const rows = this.out.rows ?? 24;
    if (this.tab === "digest") {
      const screen = this.hooks.digestScreen?.(this, cols, rows);
      this.out.write(screen ?? `${CLEAR}digest tab lands in — [1] back to board`);
      return;
    }
    this.out.write(renderBoard(this.view, cols, rows).render());
  }
}
