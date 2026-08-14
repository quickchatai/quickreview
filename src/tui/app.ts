// qcr tui — the app loop: terminal setup/teardown, poller wiring, key
// routing, repaint. Screens and logic are pure modules; this file owns the
// side effects. Slice: board + detail + events (attach and
// quick-message land in and plug in via AppHooks).
import type { WhyPayload } from "../cli.js";
import type { TuiConfig } from "../config.js";
import type { AlertBadge } from "./alerts.js";
import { renderBoard, type BoardAction, type BoardView } from "./board.js";
import { decodeInputKey, decodeKey } from "./keys.js";
import { formatEvent, moveSelection, reselect, sortPrs, type EventLine } from "./model.js";
import { MOUSE_OFF, MOUSE_ON, extractMouseEvents, hitTest, type MouseEvent, type Zone } from "./mouse.js";
import { ALT_SCREEN_OFF, ALT_SCREEN_ON, CLEAR, Frame } from "./paint.js";
import { Poller } from "./poll.js";
import { prUrl } from "./theme.js";
import { eventsArgv, whyArgv, type SshRunner } from "./remote.js";

export interface AppHooks {
  /**: attach the given tmux session full-screen; resolves on detach. */
  attach?: (session: string, app: App) => Promise<void>;
  /**: open the quick-message box for the given session. */
  message?: (session: string, app: App) => void;
  /**: deliver a submitted quick-message (inject write + confirmation). */
  sendMessage?: (session: string, text: string, app: App) => void;
  /**: render the digest tab into a frame string; undefined = placeholder. */
  digestScreen?: (app: App, cols: number, rows: number) => string;
  /**: digest tab key handling; returns true when it consumed the key. */
  digestKey?: (app: App, key: ReturnType<typeof decodeKey>) => boolean;
  /** Open a URL in the user's browser (default: xdg-open, detached). */
  openUrl?: (url: string) => void;
  /** First-launch marker (read, write). Default: state/tui-help-shown. */
  helpSeen?: { get(): boolean; set(): void };
  /**: the board is back in charge (attach closed) — a hot-reload that
   * was deferred while attached can go through now. */
  onResume?: () => void;
  /**: called after every poll and every events refresh — the ambient
   * feed writer hangs off this (daemon-owned cadence). */
  onPoll?: (app: App) => void;
  /**: attach the local companion container's tmux session. */
  companionAttach?: (app: App) => Promise<void>;
  /**: what the companion tab shows when nothing is attached. */
  companionScreen?: (app: App, cols: number, rows: number) => string;
}

export type Tab = "board" | "digest" | "companion";

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
  /** Raw event rows behind view.events — the ambient feed writes these
   * verbatim, so the companion sees what the daemon logged, not our prose. */
  rawEvents: Array<{ ts: string; kind: string; pr: number | null; payload: string | null }> = [];
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
    this.out.write(ALT_SCREEN_ON + CLEAR + MOUSE_ON);
    if (this.input.isTTY) this.input.setRawMode(true);
    this.input.resume();
    this.input.on("data", this.onData);
    this.out.on("resize", this.onResize);
    if (this.hooks.helpSeen && !this.hooks.helpSeen.get()) {
      this.view.help = true;
      this.hooks.helpSeen.set();
    }
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
    this.out.write(MOUSE_OFF + ALT_SCREEN_OFF);
  }

  quit(): void {
    this.quitResolve?.();
  }

  /** Attach mode owns the terminal: stop painting, swallow board keys, and
   * drop our mouse reporting (the attach screen manages passthrough). */
  suspend(): void {
    this.suspended = true;
    this.input.off("data", this.onData);
    this.out.write(MOUSE_OFF);
  }

  resume(): void {
    this.suspended = false;
    this.input.on("data", this.onData);
    this.out.write(CLEAR + MOUSE_ON);
    void this.refreshDetail();
    this.repaint();
    this.hooks.onResume?.();
  }

  /** True while something other than the board owns the terminal or holds
   * unsaved user input — hot-reload defers on it. */
  isBusy(): boolean {
    return this.suspended || this.view.inputBox !== undefined;
  }

  /** The PR the board is pointing at (survives a hot-reload). */
  currentPr(): number | undefined {
    return this.selectedPr;
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
    this.hooks.onPoll?.(this);
    this.repaint();
  }

  private async refreshEvents(): Promise<void> {
    const res = await this.ssh(this.cfg.ssh_host, eventsArgv(this.cfg, 50));
    if (!res.ok) return;
    try {
      const parsed = JSON.parse(res.stdout) as { events: Array<{ ts: string; kind: string; pr: number | null; payload: string | null }> };
      this.rawEvents = parsed.events;
      const lines = parsed.events.map(formatEvent).reverse(); // newest first
      this.view.events = this.mergeNotices(lines);
      this.hooks.onPoll?.(this); // feed the companion the fresh tail too
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

  /** Point the board selection at a PR (digest-tab actions jump here). */
  selectPr(pr: number): void {
    this.selectedPr = pr;
    const sorted = this.view.snapshot ? sortPrs(this.view.snapshot.prs) : [];
    this.view.selected = reselect(sorted, pr, this.view.selected);
    void this.refreshDetail();
  }

  selectedSession(): string | undefined {
    const sorted = this.view.snapshot ? sortPrs(this.view.snapshot.prs) : [];
    const pr = sorted[this.view.selected];
    return pr ? `pr-${pr.number}` : undefined;
  }

  notice(text: string): void {
    this.view.noticeLine = text;
    this.repaint();
  }

  /** The session the open input box targets; draft survives Esc. */
  private msgSession: string | undefined;
  private msgDraft = "";

  openMessageBox(session: string): void {
    this.msgSession = session;
    const pr = /^pr-(\d+)$/.exec(session)?.[1];
    this.view.inputBox = { target: pr ? `#${pr} (pi session ${session})` : session, text: this.msgDraft };
    this.repaint();
  }

  private handleMessageBoxKey(buf: Buffer): void {
    const box = this.view.inputBox!;
    const key = decodeInputKey(buf);
    switch (key.kind) {
      case "char":
        box.text += key.ch;
        break;
      case "backspace":
        box.text = box.text.slice(0, -1);
        break;
      case "alt-enter":
        box.text += "\n";
        break;
      case "escape":
        this.msgDraft = box.text; // preserved until board navigation
        this.view.inputBox = undefined;
        break;
      case "enter": {
        const text = box.text.trim();
        const session = this.msgSession;
        this.view.inputBox = undefined;
        this.msgDraft = "";
        if (text.length > 0 && session) {
          if (this.hooks.sendMessage) this.hooks.sendMessage(session, text, this);
          else this.notice(`✖ msg ${session} undelivered (sender not wired)`);
        }
        break;
      }
      case "quit":
        this.quit();
        return;
      default:
        return;
    }
    this.repaint();
  }

  private openGithub(pr?: number): void {
    const n = pr ?? this.selectedPrNumber();
    if (n === undefined || !this.view.repo) return;
    this.hooks.openUrl?.(prUrl(this.view.repo, n));
    this.notice(`opened #${n} on GitHub`);
  }

  private selectedPrNumber(): number | undefined {
    const sorted = this.view.snapshot ? sortPrs(this.view.snapshot.prs) : [];
    return sorted[this.view.selected]?.number;
  }

  private handleMouse(ev: MouseEvent): void {
    if (this.tab === "companion") return; // the attach (or its placeholder) owns it
    if (this.tab === "digest") {
      // Digest tab: wheel scrolls; row-level actions stay on the keyboard.
      if (ev.kind !== "click") this.hooks.digestKey?.(this, { kind: ev.kind === "wheel-down" ? "down" : "up" });
      return;
    }
    if (ev.kind === "wheel-up" || ev.kind === "wheel-down") {
      const delta = ev.kind === "wheel-down" ? 1 : -1;
      const stripTop = (this.lastFrame?.meta["stripTop"] ?? Number.MAX_SAFE_INTEGER) + 1;
      if (ev.y >= stripTop) {
        this.view.eventsScroll = Math.max(0, Math.min(this.view.eventsScroll + delta, Math.max(0, this.view.events.length - 1)));
      } else {
        const sorted = this.view.snapshot ? sortPrs(this.view.snapshot.prs) : [];
        this.view.selected = moveSelection(this.view.selected, delta, sorted.length);
        this.selectedPr = sorted[this.view.selected]?.number;
        void this.refreshDetail();
      }
      this.repaint();
      return;
    }
    const action = this.lastFrame ? hitTest(this.lastFrame.zones as Zone<BoardAction>[], ev.x, ev.y) : undefined;
    if (!action) return;
    switch (action.t) {
      case "select-pr": {
        if (this.selectedPr === action.pr) {
          // Second click on the selected row = attach (grill decision).
          this.startAttach(`pr-${action.pr}`);
          return;
        }
        this.selectPr(action.pr);
        break;
      }
      case "open-github":
        this.openGithub(action.pr);
        return;
      case "event-jump":
        this.selectPr(action.pr);
        break;
      case "tab":
        if (action.tab === "companion") {
          this.openCompanion();
          return;
        }
        this.tab = action.tab;
        break;
      case "key":
        this.handleInput(Buffer.from(action.key, "utf8"));
        return;
    }
    this.repaint();
  }

  private handleInput(buf: Buffer): void {
    if (this.suspended) return;
    const { events, rest } = extractMouseEvents(buf);
    for (const ev of events) this.handleMouse(ev);
    if (rest.length === 0) return;
    buf = rest;
    if (this.view.inputBox) {
      this.handleMessageBoxKey(buf);
      return;
    }
    const key = decodeKey(buf);

    if (this.view.help) {
      this.view.help = false;
      this.repaint();
      return;
    }
    if (this.tab === "digest" && this.hooks.digestKey?.(this, key)) return;
    if (this.tab === "companion") {
      // The tab is the conversation: ⏎ re-attaches, tab/quit keys still work,
      // everything else would silently act on the board — so it doesn't.
      switch (key.kind) {
        case "enter":
        case "tab-companion":
          this.openCompanion();
          return;
        case "tab-board":
        case "tab-digest":
        case "quit":
        case "help":
          break;
        default:
          return;
      }
    }

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
      case "tab-companion":
        this.openCompanion();
        return;
      case "up":
      case "down": {
        if (this.view.eventsFocus) {
          const delta = key.kind === "down" ? 1 : -1;
          this.view.eventsScroll = Math.max(0, Math.min(this.view.eventsScroll + delta, Math.max(0, this.view.events.length - 1)));
          break;
        }
        const sorted = this.view.snapshot ? sortPrs(this.view.snapshot.prs) : [];
        this.view.selected = moveSelection(this.view.selected, key.kind === "down" ? 1 : -1, sorted.length);
        this.selectedPr = sorted[this.view.selected]?.number;
        this.msgDraft = ""; // board navigation drops a cancelled draft
        void this.refreshDetail();
        break;
      }
      case "escape":
        this.view.eventsFocus = false;
        this.view.alertFocus = false; // acknowledged: ⏎ goes back to attach
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
        // A live alert owns ⏎ until it is followed or dismissed — the point of
        // an alert is that the next thing you do is talk to the companion.
        if (this.view.alertFocus) {
          this.openCompanion();
          return;
        }
        const session = this.selectedSession();
        if (!session) break;
        this.startAttach(session);
        return;
      }
      case "github":
        this.openGithub();
        return;
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
        else this.openMessageBox(session);
        break;
      }
      default:
        return; // unknown keys repaint nothing
    }
    this.repaint();
  }

  /** The companion tab: switching to it *is* attaching to the local container's
   * pi session (there is nothing else to show). Following an alert clears its
   * focus — it has been acted on. */
  openCompanion(): void {
    this.tab = "companion";
    this.view.alertFocus = false;
    if (!this.hooks.companionAttach) {
      this.repaint();
      return;
    }
    void this.hooks.companionAttach(this);
  }

  /** Alert consumer → top bar. `alert` tier also grabs ⏎ (see handleInput). */
  setAlertBadge(badge: AlertBadge): void {
    this.view.alerts = badge;
    if (badge.latest?.tier === "alert") this.view.alertFocus = true;
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

  private lastFrame: Frame | undefined;

  repaint(): void {
    if (this.suspended) return;
    const cols = this.out.columns ?? 80;
    const rows = this.out.rows ?? 24;
    if (this.tab === "digest") {
      const screen = this.hooks.digestScreen?.(this, cols, rows);
      this.lastFrame = undefined;
      this.out.write(screen ?? `${CLEAR}digest tab lands in — [1] back to board`);
      return;
    }
    if (this.tab === "companion") {
      const screen = this.hooks.companionScreen?.(this, cols, rows);
      this.lastFrame = undefined;
      this.out.write(screen ?? `${CLEAR}companion unavailable (started with --no-companion?) — [1] back to board`);
      return;
    }
    this.view.now = this.now();
    const frame = renderBoard(this.view, cols, rows);
    this.lastFrame = frame;
    this.out.write(frame.render());
  }
}
