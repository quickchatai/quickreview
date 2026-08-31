// qcr tui — the app loop: terminal setup/teardown, poller wiring, key
// routing, repaint. Screens and logic are pure modules; this file owns the
// side effects. Slice: board + detail + events (attach and
// quick-message land in and plug in via AppHooks).
import type { WhyPayload } from "../cli.js";
import type { TuiConfig } from "../config.js";
import type { AlertBadge } from "./alerts.js";
import { piPaneSize, renderBoard, type BoardAction, type BoardView } from "./board.js";
import { barHitKey, registeredKeys } from "./cmdbar.js";
import { decodeInputKey, decodeKey } from "./keys.js";
import { visiblePrs } from "./filters.js";
import { formatEvent, moveSelection, reselect, type EventLine } from "./model.js";
import { TripleCtrlC } from "./chord.js";
import { MOUSE_OFF, MOUSE_ON, extractMouseEvents, hitTest, type MouseEvent, type Zone } from "./mouse.js";
import { ALT_SCREEN_OFF, ALT_SCREEN_ON, CLEAR, Frame, accentFrameRect, composeColumn, fit, sliceDisplay, spliceDisplay, stripAnsi } from "./paint.js";
import { ACCENT, RESET, SELECTION } from "./design.js";
import { ClipboardSink } from "./clipboard.js";
import { PANE_ESCAPE, PiMirror, keysToTmux } from "./pipane.js";
import { Poller } from "./poll.js";
import { parseRoundProgress } from "../round-progress.js";
import { prUrl } from "./theme.js";
import { CompanionSidebar, paintSidebar, SIDEBAR_SPINE, sidebarHit, sidebarResizeHit, sidebarWidth } from "./sidebar.js";
import { eventsArgv, progressArgv, sendKeysArgv, whyArgv, type SshRunner } from "./remote.js";

export interface AppHooks {
  /**: attach the given tmux session full-screen; resolves on detach. */
  attach?: (session: string, app: App) => Promise<void>;
  /**: open the quick-message box for the given session. */
  message?: (session: string, app: App) => void;
  /**: deliver a submitted quick-message (inject write + confirmation). */
  sendMessage?: (session: string, text: string, app: App) => void;
  /** #5362: cancel the PR's running round and re-queue it, via the daemon's
   * `commands/` dir. The board's one write action beyond wakes — see
   * src/tui/unwedge.ts for why it exists and what bounds it. */
  unwedge?: (pr: number, app: App) => void;
  /**: render the digest tab; undefined = placeholder.
   * Returning a Frame lets the companion sidebar be composed beside it
   *; a bare string is painted as-is, sidebar-less. */
  digestScreen?: (app: App, cols: number, rows: number) => string | Frame;
  /**: digest tab key handling; returns true when it consumed the key. */
  digestKey?: (app: App, key: ReturnType<typeof decodeKey>) => boolean;
  /**: mouse click on the Memory & learning tab (1-based coords) —
   * rows select, [buttons] fire verbs. */
  digestClick?: (app: App, x: number, y: number) => void;
  /** Open a URL in the user's browser (default: xdg-open, detached). */
  openUrl?: (url: string) => void;
  /** First-launch marker (read, write). Default: state/tui-help-shown. */
  helpSeen?: { get(): boolean; set(): void };
  /**: called after every poll and every events refresh — the ambient
   * feed writer hangs off this (daemon-owned cadence). */
  onPoll?: (app: App) => void;
  /**: attach the local companion container's tmux session
   * full-screen. retired it: the companion is a permanent column and
   * is never opened full-screen. Replaced by `companionEnsure`. */
  companionAttach?: (app: App) => Promise<void>;
  /**: the companion was asked for while its startup is down — re-run
   * that startup (build/up/rollover/spawn) and focus the column on success. */
  companionEnsure?: (app: App) => Promise<void>;
  /** Deploy tab: what would a deploy ship (read-only — never deploys). */
  deployScreen?: (app: App, cols: number, rows: number) => string | Frame;
  /** Deploy tab key handling; returns true when it consumed the key. */
  deployKey?: (app: App, key: ReturnType<typeof decodeKey>) => boolean;
  /**: metrics dashboard / per-PR timeline screen. */
  metricsScreen?: (app: App, cols: number, rows: number) => string | Frame;
  /** Metrics tab key handling; returns true when it consumed the key. */
  metricsKey?: (app: App, key: ReturnType<typeof decodeKey>) => boolean;
  /** Metrics tab click routing (window switcher zones); true = consumed. */
  metricsClick?: (app: App, x: number, y: number) => boolean;
  /**: the change register — feedback-derived commits, newest first. */
  changesScreen?: (app: App, cols: number, rows: number) => string | Frame;
  /** Change-register key handling; returns true when it consumed the key. */
  changesKey?: (app: App, key: ReturnType<typeof decodeKey>) => boolean;
  /** Change-register click routing (row selection); true = consumed. */
  changesClick?: (app: App, x: number, y: number) => boolean;
  /** Start ./scripts/deploy.sh sync after the deploy tab has engaged the
   * daemon drain and observed a fresh zero-running-round snapshot. Streams
   * output back into the tab; the handle aborts a stuck sync. */
  deployRun?: (
    app: App,
    runId: string,
    onData: (chunk: string) => void,
    onExit: (code: number | null) => void,
  ) => { kill(): void };
  /** Mouse click on the deploy tab (1-based terminal coords) — the buttons. */
  deployClick?: (app: App, x: number, y: number) => void;
  /** Stop/start the VM app container, streamed like deployRun (S S or the
   * power button on the deploy tab). */
  powerRun?: (
    app: App,
    action: "stop" | "start",
    onData: (chunk: string) => void,
    onExit: (code: number | null) => void,
  ) => { kill(): void };
  /** Re-establish the VM ssh master on the operator's terminal (key s) —
   * the one native GCP-passphrase prompt. */
  reconnect?: (app: App) => void;
}

export type Tab = "board" | "digest" | "deploy" | "metrics" | "changes";

/** Every encoding of the End key we might see — the pi pane's "back to live". */
const END_KEYS = new Set(["\x1b[F", "\x1bOF", "\x1b[4~", "\x1b[8~"]);

export class App {
  readonly view: BoardView = {
    health: { kind: "unreachable", sinceS: Number.POSITIVE_INFINITY },
    // UNKNOWN until a heartbeat proves one (ruling 1). This field used
    // to initialise to `true`, which is how a LIVE installation painted a
    // DRY-RUN badge on 2026-08-31 while the daemon was healthy the whole time.
    dryRun: undefined,
    events: [],
    selected: 0,
    detailFull: false,
    eventsFocus: false,
    eventsScroll: 0,
    help: false,
  };
  tab: Tab = "board";
  /**: the companion sidebar — a right-hand column on every tab.
   * Wired by index.ts; absent in bare test harnesses (no column painted). */
  sidebar?: CompanionSidebar;
  readonly poller: Poller;
  /** Live mirror of the selected PR's pi session (board's lower region). */
  readonly pi: PiMirror;
  /** Raw event rows behind view.events — the ambient feed writes these
   * verbatim, so the companion sees what the daemon logged, not our prose. */
  rawEvents: Array<{ ts: string; kind: string; pr: number | null; payload: string | null }> = [];
  private selectedPr: number | undefined;
  private detailSeq = 0;
  private progressSeq = 0;
  /** Stale-while-revalidate detail cache: paint the last known payload
   * instantly on selection, refresh over ssh behind it. */
  private readonly detailCache = new Map<number, { payload: WhyPayload; fetched_at: number }>();
  private static readonly DETAIL_TTL_MS = 60_000;
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
    this.pi = new PiMirror(cfg, ssh, () => {
      this.syncPiPane();
      // The session we were typing into went away — say so and hand the
      // keyboard back rather than swallowing keystrokes into nothing.
      if (this.view.piFocus && this.view.pi?.missing) this.blurPiPane(`pi session pr-${this.piFocusPr} is gone — keyboard back on the board`);
      this.repaint();
    });
  }

  // ---- the pi pane as an embedded terminal --------------------------------

  /** The session the pane types into while focused (locked at focus time). */
  private piFocusPr: number | undefined;
  /** While focused the capture runs far faster than the poll tick, so typing
   * echoes back at something close to terminal speed. */
  private piTimer: NodeJS.Timeout | undefined;
  private static readonly PI_FOCUS_POLL_MS = 400;

  /** Hand the keyboard to the pi pane (click, or a wheel-driven focus). */
  focusPiPane(): void {
    const pr = this.panePr();
    if (pr === undefined) return;
    if (this.view.piFocus && this.piFocusPr === pr) return;
    this.piFocusPr = pr;
    this.view.piFocus = true;
    this.sidebar?.blur(); // one keyboard owner at a time
    this.syncPiPane();
    void this.pi.refresh(pr);
    if (!this.piTimer) {
      const t = setInterval(() => {
        if (this.suspended || this.tab !== "board" || !this.view.piFocus) return;
        void this.pi.refresh(this.piFocusPr);
      }, App.PI_FOCUS_POLL_MS);
      t.unref?.();
      this.piTimer = t;
    }
    this.repaint();
  }

  /** Ctrl-q, a click outside the pane, or a dead session: back to the list. */
  blurPiPane(notice?: string): void {
    if (this.piTimer) clearInterval(this.piTimer);
    this.piTimer = undefined;
    if (!this.view.piFocus) return;
    this.view.piFocus = false;
    this.piFocusPr = undefined;
    this.syncPiPane();
    if (notice !== undefined) this.view.noticeLine = notice;
    this.pi.select(this.selectedPr); // follow resumes where the list is
  }

  /** True while the pane owns the keyboard (tests + hot-reload read this). */
  piFocused(): boolean {
    return this.view.piFocus === true;
  }

  /** Forward one raw stdin chunk into the focused session, then re-capture so
   * the echo lands immediately instead of on the next tick. Typing also snaps
   * the pane back to the live tail — you cannot type into history. */
  private sendKeysToPane(buf: Buffer): void {
    const pr = this.piFocusPr;
    if (pr === undefined) return;
    const groups = keysToTmux(buf);
    if (groups.length === 0) return;
    if (this.pi.offsetFor(pr) !== 0) {
      this.pi.setOffset(pr, 0);
      this.syncPiPane();
      this.repaint();
    }
    void (async () => {
      for (const parts of groups) {
        await this.ssh(this.cfg.ssh_host, sendKeysArgv(this.cfg, `pr-${pr}`, parts), { timeoutMs: 5_000 });
      }
      await this.pi.refresh(pr);
    })();
  }

  /** Wheel over the pane: move its scrollback window, re-capture with history.
   * Wheeling back to the bottom returns it to the live tail. */
  private scrollPiPane(notches: number): void {
    const pr = this.panePr();
    if (pr === undefined) return;
    this.pi.scroll(pr, notches);
    this.syncPiPane();
    this.repaint();
    void this.pi.refresh(pr);
  }

  /** The PR whose session the pane is showing. While the pane has the keyboard
   * this is LOCKED — a poll that reorders the list must never redirect the
   * operator's typing to another PR's session. */
  private panePr(): number | undefined {
    return this.view.piFocus ? this.piFocusPr : this.selectedPr;
  }

  /** Point the board's pane at whatever it should be showing right now (cache
   * first, so switching back paints instantly). */
  private syncPiPane(): void {
    const pr = this.panePr();
    this.view.piPr = pr;
    this.view.pi = this.pi.view(pr);
  }

  /** Selection moved: paint the cached mirror at once, capture behind it.
   * A focused pane ignores this — follow is locked until Ctrl-q. */
  private followSelection(): void {
    this.syncPiPane();
    if (this.view.piFocus) return;
    this.pi.select(this.selectedPr);
  }

  // ---- lifecycle ---------------------------------------------------------

  async run(initialSelection?: number): Promise<void> {
    if (initialSelection !== undefined) this.selectedPr = initialSelection;
    // From here the TUI owns the screen, and this is now the FIRST thing that
    // happens (ruling 2): nothing external — no docker call, no
    // network call, no filesystem walk — runs before this paint.
    //
    //'s objection is answered rather than side-stepped. Painting used
    // to be pushed to the end because `app.sidebar` was wired after the
    // companion container started, so an early frame showed a different layout
    // that then jumped. But the objection was about GEOMETRY, not data: the
    // column's width comes from config (`CompanionSidebar.shown()`), the
    // sidebar is wired before this call, and the container merely fills a
    // column that is already the right size. Everything slow streams in behind
    // this frame and reports into that column (src/tui/startup.ts).
    this.started = true;
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

  /** Set once teardown has restored the terminal. From then on nothing may
   * write to the output stream: an async load that resolves after quit
   * (memory/proposals fetches take seconds over ssh) would otherwise paint
   * a full TUI frame onto the user's restored NORMAL screen — a ghost board
   * that looks like the TUI is still running. */
  private stopped = false;

  private teardown(): void {
    this.stopped = true;
    this.poller.stop();
    this.pi.stop();
    this.sidebar?.stop();
    if (this.piTimer) clearInterval(this.piTimer);
    this.piTimer = undefined;
    this.input.off("data", this.onData);
    this.out.off("resize", this.onResize);
    if (this.input.isTTY) this.input.setRawMode(false);
    this.input.pause();
    // MOUSE_OFF, leave the alt screen, THEN clear. The clear lands
    // on the normal screen and is what makes the exit look clean rather than
    // dropping the operator back onto whatever the alt screen was hiding; it
    // also wipes any half-line a crash left behind. Order matters: clearing
    // before ALT_SCREEN_OFF would clear the screen we are about to discard.
    this.out.write(MOUSE_OFF + ALT_SCREEN_OFF + CLEAR);
  }

  quit(): void {
    this.quitResolve?.();
  }

  /** Ctrl-C taps, for the two-tap exit (distinct from the three-tap kill). */
  private ctrlCTaps: number[] = [];
  private static readonly CTRL_C_EXIT_WINDOW_MS = 2_000;

  /**
   * Every route to "I want out", in one place.
   *
   * `q` asks first — quitting is cheap to redo but the confirmation is what
   * stops a stray keystroke from dropping a board you were reading. Ctrl-C
   * confirms by REPETITION instead: the second tap inside the window is the
   * answer, so the reflex still works without a prompt in the way.
   */
  requestQuit(via: "key" | "ctrl-c"): void {
    if (via === "ctrl-c") {
      const t = this.now().getTime();
      this.ctrlCTaps = [...this.ctrlCTaps.filter((x) => t - x <= App.CTRL_C_EXIT_WINDOW_MS), t];
      if (this.ctrlCTaps.length >= 2) {
        this.quit();
        return;
      }
      this.notice("press Ctrl-C again to exit");
      this.repaint();
      return;
    }
    this.view.confirmQuit = true;
    this.repaint();
  }

  /** A key while the quit prompt is up. Returns true when it consumed it. */
  private handleConfirmQuit(buf: Buffer): boolean {
    if (!this.view.confirmQuit) return false;
    const raw = buf.toString("utf8");
    // Only an explicit yes leaves. Anything else — including a second `q`,
    // which is what a repeated keystroke looks like — cancels, because the
    // prompt exists to catch exactly that.
    if (raw === "y" || raw === "Y" || raw === "\r" || raw === "\n") {
      this.view.confirmQuit = false;
      this.quit();
      return true;
    }
    this.view.confirmQuit = false;
    this.repaint();
    return true;
  }

  /** Injectable so tests never kill the runner. */
  exiter: (code: number) => void = (code) => process.exit(code);

  /** Triple-Ctrl-C hard kill: restore the terminal no matter what, then die.
   * A hung ssh/pty must never trap the user in the alt screen — closing the
   * terminal window cannot stay the only way out. */
  die(): void {
    try {
      this.suspended = false; // teardown must run even mid-attach
      this.teardown();
    } catch {
      /* a half-restored terminal still beats a trapped one */
    }
    this.exiter(130);
  }

  /** Attach mode owns the terminal: stop painting, swallow board keys, and
   * drop our mouse reporting (the attach screen manages passthrough). */
  suspend(): void {
    this.suspended = true;
    this.input.off("data", this.onData);
    this.out.write(MOUSE_OFF);
  }

  resume(): void {
    if (this.stopped) return; // an attach resolving after quit must not repaint
    this.suspended = false;
    this.input.on("data", this.onData);
    this.out.write(CLEAR + MOUSE_ON);
    void this.refreshDetail();
    void this.refreshProgress();
    void this.pi.refresh(this.panePr()); // the mirror caught up while attached
    this.repaint();
  }

  /** True while something other than the board owns the terminal or holds
   * unsaved user input. Used to REFUSE a remote-driven action (index.ts), so
   * it never fights the operator for the keyboard. The hot reload deliberately
   * does NOT consult it — every build reloads (see reload.ts). */
  isBusy(): boolean {
    return this.suspended || this.view.inputBox !== undefined || this.view.piFocus === true || this.sidebar?.focused === true;
  }

  /** The PR the board is pointing at (survives a hot-reload). */
  currentPr(): number | undefined {
    return this.selectedPr;
  }

  // ---- data --------------------------------------------------------------

  private onPoll(): void {
    const snap = this.poller.state.snapshot;
    if (snap) {
      // Invalidate cached details the snapshot proves stale (state/head moved).
      for (const pr of snap.prs) {
        const c = this.detailCache.get(pr.number);
        if (c && (c.payload.head_sha !== pr.head_sha || c.payload.state !== pr.state)) this.detailCache.delete(pr.number);
      }
      this.view.snapshot = snap;
      this.view.dryRun = snap.dry_run;
      const sorted = visiblePrs(this.view);
      this.view.selected = reselect(sorted, this.selectedPr, this.view.selected);
      this.selectedPr = sorted[this.view.selected]?.number;
    }
    this.view.health = this.poller.health();
    void this.refreshEvents();
    if (this.view.detail?.pr !== this.selectedPr) void this.refreshDetail();
    // Live progress is a cheap host-volume read, separate from `why` because
    // refreshing the enriched detail would call GitHub on every poll.
    if (this.tab === "board" && !this.suspended) void this.refreshProgress();
    // The mirror only costs an ssh while the board is the visible tab.
    this.syncPiPane();
    if (this.tab === "board" && !this.suspended) void this.pi.refresh(this.panePr());
    try {
      this.hooks.onPoll?.(this);
    } catch {
      /* a throwing wrapper must never kill the poll loop */
    }
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
      try {
        this.hooks.onPoll?.(this); // feed the companion the fresh tail too
      } catch {
        /* a throwing wrapper must never kill the poll loop */
      }
      this.repaint();
    } catch {
      /* keep the previous sidebar on parse failure */
    }
  }

  /** overrides this to splice quick-message pending/delivered rows. */
  protected mergeNotices(lines: EventLine[]): EventLine[] {
    return lines;
  }

  async refreshDetail(): Promise<void> {
    const pr = this.selectedPr;
    if (pr === undefined) return;
    // Serve from cache immediately; skip the fetch entirely while fresh.
    const cached = this.detailCache.get(pr);
    const now = Date.now();
    if (cached) {
      this.view.detail = cached.payload;
      this.repaint();
      if (now - cached.fetched_at < App.DETAIL_TTL_MS) return;
    }
    const seq = ++this.detailSeq;
    const res = await this.ssh(this.cfg.ssh_host, whyArgv(this.cfg, pr));
    if (!res.ok) return;
    try {
      const payload = JSON.parse(res.stdout) as WhyPayload;
      this.detailCache.set(payload.pr, { payload, fetched_at: Date.now() });
      if (seq !== this.detailSeq || payload.pr !== this.selectedPr) return;
      this.view.detail = payload;
      this.repaint();
    } catch {
      /* stale/garbled detail keeps the loading line */
    }
  }

  private async refreshProgress(): Promise<void> {
    const pr = this.selectedPr;
    if (pr === undefined) return;
    const seq = ++this.progressSeq;
    const res = await this.ssh(this.cfg.ssh_host, progressArgv(this.cfg, pr), { timeoutMs: 3_000 });
    if (seq !== this.progressSeq || pr !== this.selectedPr) return;
    if (!res.ok) {
      // Keep a same-PR snapshot: its age becomes the visible SILENT signal.
      // A different PR must never inherit it while its own read is pending.
      if (this.view.progress?.pr !== pr) this.view.progress = undefined;
      this.repaint();
      return;
    }
    const parsed = parseRoundProgress(res.stdout);
    this.view.progress = parsed?.pr === pr ? parsed : undefined;
    this.repaint();
  }

  /** Drop a PR's cached detail (a new verdict/round event makes it stale). */
  invalidateDetail(pr: number): void {
    this.detailCache.delete(pr);
  }

  // ---- input -------------------------------------------------------------

  /** Point the board selection at a PR (digest-tab actions jump here). */
  selectPr(pr: number): void {
    this.selectedPr = pr;
    const sorted = visiblePrs(this.view);
    this.view.selected = reselect(sorted, pr, this.view.selected);
    if (this.view.progress?.pr !== pr) this.view.progress = undefined;
    void this.refreshDetail();
    void this.refreshProgress();
    this.followSelection();
  }

  selectedSession(): string | undefined {
    const pr = this.selectedPrNumber();
    return pr === undefined ? undefined : `pr-${pr}`;
  }

  notice(text: string): void {
    this.view.noticeLine = text;
    // Before the TUI owns the screen, a notice is startup progress and prints
    // as a plain line — the companion can take minutes to build, and silence
    // there looks like a hang. Painting a frame instead (what this used to do)
    // is what produced the startup flash. The alt screen hides these the
    // moment run() begins, so they never linger.
    if (!this.started) {
      this.out.write(`${text}\n`);
      return;
    }
    this.repaint();
  }

  /** The session the open input box targets; draft survives Esc. */
  private msgSession: string | undefined;
  private msgDraft = "";
  /** When set, the input box belongs to a tab prompt (memory edits,
   * proposal-reject reasons) — submit goes here, not to sendMessage. */
  private inputSubmit: ((text: string) => void) | undefined;

  openMessageBox(session: string): void {
    this.msgSession = session;
    this.inputSubmit = undefined;
    const pr = /^pr-(\d+)$/.exec(session)?.[1];
    this.view.inputBox = { target: pr ? `#${pr} (pi session ${session})` : session, text: this.msgDraft };
    this.repaint();
  }

  /** Generic one-line input over the same box UI. Esc cancels (no draft). */
  promptInput(target: string, initial: string, onSubmit: (text: string) => void): void {
    this.inputSubmit = onSubmit;
    this.view.inputBox = { target, text: initial };
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
        if (this.inputSubmit) this.inputSubmit = undefined; // tab prompts keep no draft
        else this.msgDraft = box.text; // preserved until board navigation
        this.view.inputBox = undefined;
        break;
      case "enter": {
        const text = box.text.trim();
        const submit = this.inputSubmit;
        const session = this.msgSession;
        this.view.inputBox = undefined;
        this.inputSubmit = undefined;
        if (submit) {
          if (text.length > 0) submit(text);
          break;
        }
        this.msgDraft = "";
        if (text.length > 0 && session) {
          if (this.hooks.sendMessage) this.hooks.sendMessage(session, text, this);
          else this.notice(`✖ msg ${session} undelivered (sender not wired)`);
        }
        break;
      }
      case "quit":
        this.requestQuit(buf.toString("utf8") === "\x03" ? "ctrl-c" : "key");
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

  /** The selected row's PR number. Public because `selectedSession()` is the
   * session-name view of the same thing and callers want either. */
  selectedPrNumber(): number | undefined {
    const sorted = visiblePrs(this.view);
    return sorted[this.view.selected]?.number;
  }

  /** Synthesize a keypress through the normal input path — the command bar's
   * buttons and any tab code that wants "exactly what the key would do". */
  pressKey(key: string): void {
    this.handleInput(Buffer.from(key, "utf8"));
  }

  private handleMouse(ev: MouseEvent): void {
    const cols = this.out.columns ?? 80;
    // The sidebar's left seam is the ONE drag surface that is chrome rather
    // than selectable content. Everywhere else still owns drag and
    // release for rectangular copy.
    if (this.sidebar && ev.kind === "click") {
      const width = this.sidebarWidth(cols);
      if (sidebarResizeHit(ev.x, cols, width)) {
        this.sidebarResizeActive = true;
        this.selAnchor = undefined;
        this.selection = undefined;
        this.repaint();
        return;
      }
    }
    if (this.sidebarResizeActive && ev.kind === "drag") {
      this.sidebar?.resizeFromPointer(cols, ev.x);
      this.repaint();
      return;
    }
    if (this.sidebarResizeActive && ev.kind === "release") {
      this.sidebarResizeActive = false;
      this.notice(`sidebar ${this.sidebarWidth(cols)} cols`);
      return;
    }

    // Selection owns every other drag and release. A drag is never
    // a click, so nothing below sees it and no row is selected or button fired.
    if (ev.kind === "drag") {
      const anchor = this.selAnchor;
      if (!anchor) return;
      this.selection = {
        x1: Math.min(anchor.x, ev.x),
        y1: Math.min(anchor.y, ev.y),
        x2: Math.max(anchor.x, ev.x),
        y2: Math.max(anchor.y, ev.y),
      };
      this.repaint();
      return;
    }
    if (ev.kind === "release") {
      // A press with no drag is a plain click and has already been handled;
      // there is nothing to copy and the anchor just goes away.
      if (this.selection) this.copySelection();
      else this.selAnchor = undefined;
      return;
    }
    // A new press starts a possible selection and clears the last highlight.
    if (ev.kind === "click") {
      this.selAnchor = { x: ev.x, y: ev.y };
      if (this.selection) {
        this.selection = undefined;
        this.repaint();
      }
    }
    // The command bar answers first, on every tab: a click on one of its
    // buttons IS that keypress, wherever it lands. EXCEPT while an input box
    // is open — a synthesized key would be typed into the box, and [⏎]
    // would SUBMIT the draft (a live memory edit or quick-message).
    if (ev.kind === "click" && !this.view.inputBox) {
      const rows = this.out.rows ?? 24;
      const k = barHitKey(this.tab, ev.x, ev.y, cols, rows);
      if (k !== undefined) {
        // A focused pi pane would swallow the synthesized key as text.
        if (this.view.piFocus) {
          this.blurPiPane();
          this.repaint();
        }
        // So would a focused sidebar — and [⏎] would SUBMIT the draft. Blur
        // first (same rule as the pane): a bar click IS that keypress.
        if (this.sidebar?.focused) {
          this.sidebar.blur();
          this.repaint();
        }
        this.pressKey(k);
        return;
      }
      // The companion column is fixed chrome on every tab: clicking anywhere
      // in it takes the keyboard (its mirror IS the companion now — there is
      // no full-screen view left to open), and the collapsed spine toggles
      // back open.
      if (this.sidebar) {
        const width = this.sidebarWidth(cols);
        const hit = width === 0 ? undefined : sidebarHit(ev.x, ev.y, cols, rows, width);
        if (hit === "collapse") {
          this.sidebar.toggleCollapse();
          this.repaint();
          return;
        }
        if (hit !== undefined) {
          if (this.sidebar.available()) {
            if (this.view.piFocus) this.blurPiPane();
            this.sidebar.focus();
            this.repaint();
          }
          return;
        }
        // Zellij-style spatial focus: clicking a different pane moves focus
        // there. Ctrl-q remains the keyboard-only escape hatch, not a tax on
        // mouse users who already pointed at the main TUI.
        if (this.sidebar.focused) {
          this.sidebar.blur();
          this.repaint();
        }
      }
    }
    // The wheel belongs to the companion column before any tab sees it. The
    // column is chrome on EVERY tab, so a wheel notch that the tab dispatch
    // below answers is a notch stolen from the surface the operator is
    // actually reading: the reported bug was scrolling the conversation while
    // the column had focus and watching the board's selection walk instead —
    // which then dragged the pi mirror away from the PR being read.
    //
    // Two ways it belongs here, and they compose: the pointer is over the
    // column (focused or not — the same rule the pi pane already has), or the
    // column holds the keyboard, wherever the pointer happens to rest. Focus
    // means "this surface is the one I am working in"; the wheel is part of
    // that, not an exception to it.
    if (ev.kind === "wheel-up" || ev.kind === "wheel-down") {
      if (this.sidebar && this.wheelBelongsToSidebar(ev.x, cols)) {
        this.sidebar.scroll(ev.kind === "wheel-up" ? 1 : -1);
        this.repaint();
        return;
      }
    }
    if (this.tab === "digest") {
      // Memory & learning tab: clicks hit the tab's own zones (rows select,
      // buttons act); the wheel moves the selection / scrolls.
      if (ev.kind === "click") this.hooks.digestClick?.(this, ev.x, ev.y);
      else this.hooks.digestKey?.(this, { kind: ev.kind === "wheel-down" ? "down" : "up", wheel: true });
      return;
    }
    if (this.tab === "deploy") {
      if (ev.kind === "click") this.hooks.deployClick?.(this, ev.x, ev.y);
      else this.hooks.deployKey?.(this, { kind: ev.kind === "wheel-down" ? "down" : "up", wheel: true });
      return;
    }
    if (this.tab === "metrics") {
      if (ev.kind === "click") this.hooks.metricsClick?.(this, ev.x, ev.y);
      else this.hooks.metricsKey?.(this, { kind: ev.kind === "wheel-down" ? "down" : "up", wheel: true });
      return;
    }
    if (this.tab === "changes") {
      if (ev.kind === "click") this.hooks.changesClick?.(this, ev.x, ev.y);
      else this.hooks.changesKey?.(this, { kind: ev.kind === "wheel-down" ? "down" : "up", wheel: true });
      return;
    }
    const zoneAt = (x: number, y: number): BoardAction | undefined =>
      this.lastFrame ? hitTest(this.lastFrame.zones as Zone<BoardAction>[], x, y) : undefined;
    if (ev.kind === "wheel-up" || ev.kind === "wheel-down") {
      const delta = ev.kind === "wheel-down" ? 1 : -1;
      // Pointer over the pi pane (focused or not) = that session's scrollback,
      // in place. Everything else keeps the wheel's board meaning.
      if (!this.view.eventsFocus && zoneAt(ev.x, ev.y)?.t === "pi-focus") {
        this.scrollPiPane(-delta);
        return;
      }
      // The events overlay owns the wheel while it is up; otherwise the wheel
      // moves the selection (and the mirror follows it).
      if (this.view.eventsFocus) {
        this.view.eventsScroll = Math.max(0, Math.min(this.view.eventsScroll + delta, Math.max(0, this.view.events.length - 1)));
      } else {
        const sorted = visiblePrs(this.view);
        this.view.selected = moveSelection(this.view.selected, delta, sorted.length);
        this.selectedPr = sorted[this.view.selected]?.number;
        void this.refreshDetail();
        this.followSelection();
      }
      this.repaint();
      return;
    }
    const action = zoneAt(ev.x, ev.y);
    // Any click outside the pane hands the keyboard back to the board — that
    // includes clicks on nothing in particular in the list/detail region.
    if (action?.t !== "pi-focus" && this.view.piFocus) {
      this.blurPiPane();
      this.repaint();
    }
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
      case "pi-focus":
        // Clicking the pane types into it in place — no full-screen takeover.
        this.focusPiPane();
        return;
      case "tab":
        this.tab = action.tab;
        break;
      case "companion":
        // The top-bar alert badge: open the companion attach directly.
        this.openCompanion();
        return;
      case "key":
        this.handleInput(Buffer.from(action.key, "utf8"));
        return;
    }
    this.repaint();
  }

  private readonly killChord = new TripleCtrlC();

  private handleInput(buf: Buffer): void {
    if (this.killChord.feed(buf)) {
      this.die();
      return;
    }
    if (this.suspended) return;
    const { events, rest } = extractMouseEvents(buf);
    for (const ev of events) this.handleMouse(ev);
    if (rest.length === 0) return;
    buf = rest;
    if (this.view.inputBox) {
      this.handleMessageBoxKey(buf);
      return;
    }
    // The quit prompt outranks every surface, focused sidebar included: it is
    // modal, and a keystroke meant for it must never reach a pi session.
    if (this.handleConfirmQuit(buf)) return;
    const key = decodeKey(buf);

    if (this.view.help) {
      this.view.help = false;
      this.repaint();
      return;
    }
    // The pi pane owns the keyboard while it is focused: j/k/q/1-5/? and every
    // other board binding is just text as far as the session is concerned.
    // Ctrl-q — and only Ctrl-q — comes back to the board.
    if (this.tab === "board" && this.view.piFocus) {
      if (buf.length === 1 && buf[0] === PANE_ESCAPE) {
        this.blurPiPane();
        this.repaint();
        return;
      }
      // End, while parked in scrollback, is the "back to live" key the header
      // advertises — it snaps the window to the tail instead of travelling.
      if (END_KEYS.has(buf.toString("utf8")) && this.pi.offsetFor(this.piFocusPr) > 0) {
        this.pi.setOffset(this.piFocusPr!, 0);
        this.syncPiPane();
        this.repaint();
        void this.pi.refresh(this.piFocusPr);
        return;
      }
      this.sendKeysToPane(buf);
      return;
    }
    // A focused sidebar owns the keyboard, exactly as the pi pane does above:
    // the companion is a live terminal, so j/k/1-5/? are just text to it.
    // Ctrl-q releases — the same chord, so there is ONE way out of every
    // embedded surface — and Esc drops the draft.
    if (this.sidebar?.focused) {
      this.handleSidebarKey(buf);
      return;
    }
    const raw = buf.toString("utf8");
    // `/` always focuses the companion, on every tab — and TRAVELS.
    // It is the key that opens pi's command menu, so swallowing it as a pure
    // focus key is the worst possible choice: you press `/`, the column takes
    // the keyboard, and the menu you actually wanted never opens. Seeding it
    // makes `/` behave like every other printable — focus, then reach pi.
    if (raw === "/" && this.sidebar?.available()) {
      this.sidebar.focus(raw);
      this.repaint();
      return;
    }
    // `\` collapses the column to its spine and back — the one key that is
    // about the panel rather than about the companion.
    if (raw === "\\" && this.sidebar) {
      this.sidebar.toggleCollapse();
      this.repaint();
      return;
    }
    if (this.tab === "digest" && this.hooks.digestKey?.(this, key)) return;
    if (this.tab === "deploy" && this.hooks.deployKey?.(this, key)) return;
    // The metrics tab reads nav digits as TEXT inside its `# <pr> ⏎` box, and
    // maps `1`–`4` back from their tab kinds itself (metricstab `keyChar`).
    // `5` is newer than that map, so hand it over as the digit —
    // otherwise `#5265` silently loses its 5. It cannot swallow the tab
    // switch: outside the entry box the tab does not answer to `5`, so the
    // hook returns false and the key falls through to the switch below.
    const forTab = this.tab === "metrics" && key.kind === "tab-changes" ? ({ kind: "char", ch: "5" } as const) : key;
    if (this.tab === "metrics" && this.hooks.metricsKey?.(this, forTab)) return;
    if (this.tab === "changes" && this.hooks.changesKey?.(this, key)) return;
    // An unregistered printable is a message to the companion, not a dead
    // key: focus the sidebar seeded with it (paste seeds whole).
    if (
      this.sidebar?.available() &&
      raw.length > 0 &&
      !raw.includes("\x1b") &&
      raw >= " " &&
      raw !== "\x7f" && // backspace (DEL) is an edit, never draft text
      raw !== "\b" &&
      !(raw.length === 1 && registeredKeys(this.tab).has(raw))
    ) {
      this.sidebar.focus(raw);
      this.repaint();
      return;
    }

    switch (key.kind) {
      case "quit":
        this.requestQuit(buf.toString("utf8") === "\x03" ? "ctrl-c" : "key");
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
      case "tab-deploy":
        this.tab = "deploy";
        break;
      case "tab-metrics":
        this.tab = "metrics";
        break;
      case "tab-changes":
        this.tab = "changes";
        break;
      case "up":
      case "down": {
        if (this.view.eventsFocus) {
          const delta = key.kind === "down" ? 1 : -1;
          this.view.eventsScroll = Math.max(0, Math.min(this.view.eventsScroll + delta, Math.max(0, this.view.events.length - 1)));
          break;
        }
        const sorted = visiblePrs(this.view);
        this.view.selected = moveSelection(this.view.selected, key.kind === "down" ? 1 : -1, sorted.length);
        this.selectedPr = sorted[this.view.selected]?.number;
        this.msgDraft = ""; // board navigation drops a cancelled draft
        void this.refreshDetail();
        this.followSelection();
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
        void this.pi.refresh(this.panePr());
        break;
      case "reconnect":
        if (this.hooks.reconnect) this.hooks.reconnect(this);
        else this.notice("reconnect not wired (test harness?)");
        void this.poller.tick();
        break;
      case "attach":
      case "enter": {
        // A live alert owns ⏎ until it is followed or dismissed — the point of
        // an alert is that the next thing you do is talk to the companion.
        if (key.kind === "enter" && this.view.alertFocus) {
          this.openCompanion();
          return;
        }
        // ⏎ on a PR row focuses the board's EMBEDDED pane — it no
        // longer opens the full-screen attach. Nothing may take the whole TUI
        // (the owner, 2026-08-21: "I dont EVER WANT IT to go into full screen
        // mode … same goes for the PI on the board view"). The pane is the
        // same live terminal the attach was, just bounded.
        if (this.selectedPr !== undefined) {
          this.focusPiPane();
          this.repaint();
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
      case "unwedge": {
        // #5362: cancel the selected PR's running round and re-queue it. Safe
        // and recoverable by construction — the round re-dispatches through
        // the normal pump, nothing is posted and no GitHub state is touched —
        // so it acts immediately and reports through the events strip, the
        // same shape `m` uses. The harsher `restart-session` (which also kills
        // the conversation) is deliberately NOT bound to a key: it stays an
        // overseer command, where the extra deliberation is the point.
        const pr = this.selectedPrNumber();
        if (pr === undefined) break;
        if (this.hooks.unwedge) this.hooks.unwedge(pr, this);
        else this.notice("unwedge: not wired (no remote runner)");
        break;
      }
      case "char":
        // F clears the board filter — the indicator promises it.
        if (key.ch === "F" && this.tab === "board" && this.view.boardFilter != null) {
          this.view.boardFilter = null;
          break;
        }
        return;
      default:
        return; // unknown keys repaint nothing
    }
    this.repaint();
  }

  /**
   * Go to the companion (the sidebar's rows, the alert badge, an alert-armed
   * ⏎). Following an alert clears its focus — it has been acted on.
   *
   * retired the full-screen path this used to take: the companion is
   * always on screen now, so "open" means take the keyboard, and expand the
   * column first if it was collapsed. Nothing in the TUI covers the whole
   * terminal any more (the owner, 2026-08-21: never full-screen, ever).
   */
  openCompanion(): void {
    this.view.alertFocus = false;
    if (this.sidebar?.available()) {
      this.focusCompanion();
      return;
    }
    // Down, but a failed startup can heal: hand it to the ensure hook, which
    // re-runs the startup and focuses on success (companiontab.ts).
    if (this.hooks.companionEnsure) {
      void this.hooks.companionEnsure(this);
      return;
    }
    this.notice("companion unavailable (started with --no-companion?)");
  }

  /** Expand the column if it was collapsed, and give it the keyboard. */
  focusCompanion(): void {
    if (!this.sidebar) return;
    if (this.sidebar.collapsed) this.sidebar.toggleCollapse();
    this.sidebar.focus();
    this.repaint();
  }

  /**
   * Keys while the companion column has focus.
   *
   * Two modes in one surface: the draft line is a quick-send box (type, ⏎
   * sends), but Ctrl-q releases and PgUp/PgDn walk the mirror's scrollback,
   * so reading back through the conversation never means losing the draft.
   */
  /**
   * Keys while the companion column has focus: RAW PASSTHROUGH to pi.
   *
   * The column is an embedded terminal, exactly like the board's pi pane, and
   * that is the whole point of running pi in tmux — `/` commands, the
   * completion menu, history, multi-line editing, Ctrl-C to interrupt a turn
   * are all pi's, and they only work if pi actually receives the bytes.
   *
   * DO NOT reintroduce a TUI-side draft line here. It was built once
   * and it broke exactly this: a second, worse input box in front of
   * the real one, with no `/` commands and nothing clickable. The rule is in
   * root CLAUDE.md; `tests/tui-sidebar.test.ts` pins it.
   *
   * Ctrl-q is the ONE byte that never travels — the same release chord the pi
   * pane uses, so there is one way out of every embedded surface. Everything
   * else, including Esc and Ctrl-C, belongs to pi.
   */
  private handleSidebarKey(buf: Buffer): void {
    const sidebar = this.sidebar!;
    if (buf.length === 1 && buf[0] === PANE_ESCAPE) {
      sidebar.blur();
      this.repaint();
      return;
    }
    // Scrollback is the MIRROR's, not pi's: pi cannot scroll a pane it does
    // not know is being mirrored. Only while parked, so an unparked PgUp still
    // reaches pi (its own pager uses it).
    const raw = buf.toString("utf8");
    if ((raw === "\x1b[5~" || raw === "\x1b[6~") && (raw === "\x1b[5~" || sidebar.offset > 0)) {
      sidebar.scroll(raw === "\x1b[5~" ? 1 : -1);
      this.repaint();
      return;
    }
    void sidebar.sendKeys(buf).catch((err: unknown) => this.notice(`✖ ${String(err instanceof Error ? err.message : err)}`));
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

  /**
   * The quit prompt, painted over the finished frame.
   *
   * Over the COMPOSED frame, not inside a renderer: it must appear on every
   * tab and over the companion column alike, and no tab should have to know
   * it exists. Three rows in the middle, so it cannot be mistaken for the
   * command bar's own `[q quit]` button.
   */
  private paintQuitPrompt(frame: Frame, cols: number, rows: number): void {
    if (!this.view.confirmQuit) return;
    const text = "  Quit qcr tui?  [y] yes   [any other key] no  ";
    const w = Math.min(cols - 4, Math.max(text.length + 2, 24));
    const x = Math.max(0, Math.floor((cols - w) / 2));
    const y = Math.max(0, Math.floor(rows / 2) - 1);
    const box = [`┌${"─".repeat(w - 2)}┐`, `│${fit(text, w - 2)}│`, `└${"─".repeat(w - 2)}┘`];
    for (let i = 0; i < box.length; i++) {
      const row = y + i;
      if (row < 0 || row >= rows) continue;
      const line = frame.lines[row] ?? "";
      // Splice by DISPLAY cells: the underlying row is full of SGR runs, and
      // slicing by code units would cut one in half and bleed colour.
      frame.set(row, spliceDisplay(line, x, box[i]!));
    }
  }

  /**
   * Does this wheel notch belong to the companion column's scrollback?
   *
   * True when the pointer is inside the expanded column, or when the column
   * holds the keyboard and the pointer is elsewhere. A collapsed spine has no
   * mirror on screen, so nothing there can be scrolled — the notch falls
   * through to the tab, as it always did.
   */
  private wheelBelongsToSidebar(x: number, cols: number): boolean {
    const sb = this.sidebar;
    if (!sb || !sb.shown() || sb.collapsed) return false;
    const width = this.sidebarWidth(cols);
    if (width <= SIDEBAR_SPINE) return false;
    if (x > cols - width && x <= cols) return true;
    return sb.focused;
  }

  /**
   * Width the companion column takes on THIS paint (0 = not shown).
   *
   * Keyed on `shown()` — a CONFIG fact — not on `available()`, which is only
   * true after docker has answered. That is what lets the first frame be the
   * real layout (ruling 2): the container fills a column that was
   * already the right width, so nothing jumps when it arrives.
   */
  sidebarWidth(cols: number): number {
    if (!this.sidebar) return 0;
    return sidebarWidth(cols, {
      collapsed: this.sidebar.collapsed,
      available: this.sidebar.shown(),
      preferredWidth: this.sidebar.preferredWidth,
    });
  }

  /** Compose the companion column onto a tab's frame. The tab was rendered at
   * the REDUCED width, so this only ever appends — no coordinate inside the
   * frame moves, and the tab renderers stay ignorant of the sidebar. */
  private withSidebar(inner: Frame, cols: number, rows: number): Frame {
    const width = this.sidebarWidth(cols);
    if (width === 0 || !this.sidebar) return inner;
    // joinSeam: the tab's right border and the column's left border are the
    // same wall, so the inner frame gives up its last cell — which is why the
    // tab is rendered one column WIDER than `cols - width` (see repaint).
    return composeColumn(inner, paintSidebar(this.sidebar.view(), width, rows), width, true);
  }

  /** Set by run(): the TUI owns the screen and may paint. */
  private started = false;

  // ---- mouse selection → clipboard --------------------------------
  //
  // Turning mouse reporting on takes the terminal's own selection away, so the
  // TUI owes one back. The owner, 2026-08-21: "99% I select something to copy
  // it" — so there is no copy key and no copy mode. Release IS the copy.
  //
  // RECTANGULAR, not linear. The screen is columns side by side — list next to
  // detail next to the companion — and a linear selection across a row would
  // splice text from panes the user never pointed at. A block keeps a drag
  // inside the pane it started in, which is what "select this bit of pi's
  // output" means beside the companion conversation.
  private sidebarResizeActive = false;
  private selAnchor: { x: number; y: number } | undefined;
  private selection: { x1: number; y1: number; x2: number; y2: number } | undefined;
  /** Injectable so tests never touch the real clipboard. */
  clipboard: { write(text: string): Promise<boolean> } = new ClipboardSink();

  /** The selected block as plain text, exactly as it appears on screen. */
  selectedText(): string {
    const sel = this.selection;
    const frame = this.lastFrame;
    if (!sel || !frame) return "";
    const rows: string[] = [];
    for (let y = sel.y1; y <= sel.y2; y++) {
      const line = frame.lines[y - 1];
      if (line === undefined) continue;
      // BY DISPLAY CELL, not code unit: what is copied must be what was
      // highlighted, and a single wide glyph earlier in the row would put
      // those two out of step.
      rows.push(sliceDisplay(line, sel.x1 - 1, sel.x2).replace(/\s+$/, ""));
    }
    while (rows.length > 0 && rows[rows.length - 1] === "") rows.pop();
    return rows.join("\n");
  }

  /**
   * the WHOLE last painted frame as plain text: exactly what is on
   * screen, ANSI stripped, trailing blank rows dropped. Same source as
   * `selectedText()` (the last painted frame), for the same reason: what the
   * companion is shown must be what the owner is looking at, not a re-render of
   * the model behind it.
   *
   * `undefined` when there is no composed frame — a string-rendering tab, or
   * the app is suspended/stopped. Never a fetch: this is a getter over state
   * already painted.
   */
  screenText(): string | undefined {
    const frame = this.lastFrame;
    if (!frame) return undefined;
    const rows = frame.lines.map((line) => stripAnsi(line).replace(/\s+$/, ""));
    while (rows.length > 0 && rows[rows.length - 1] === "") rows.pop();
    return rows.join("\n");
  }

  /**
   * called at the end of every repaint, so the published view tracks
   * keystrokes and not just the 3 s poll. Installed by index.ts; the callee
   * throttles. It must never repaint (that would recurse) and never throw.
   */
  afterRepaint?: () => void;

  private copySelection(): void {
    const text = this.selectedText();
    this.selAnchor = undefined;
    if (text.length === 0) {
      this.selection = undefined;
      this.repaint();
      return;
    }
    void this.clipboard
      .write(text)
      .then((ok) => {
        const lines = text.split("\n").length;
        this.notice(ok ? `✓ copied ${text.length} chars${lines > 1 ? ` · ${lines} lines` : ""}` : "✖ no clipboard tool (wl-copy / xclip / klipper)");
      })
      .catch(() => this.notice("✖ clipboard write failed"));
    // The highlight stays until the next click, so it is visible at the moment
    // the confirmation appears — proof of WHAT was copied, not just that
    // something was.
    this.repaint();
  }

  /** Paint the selection highlight over the finished frame. */
  private paintSelection(frame: Frame, cols: number, rows: number): void {
    const sel = this.selection;
    if (!sel) return;
    for (let y = sel.y1; y <= sel.y2; y++) {
      if (y < 1 || y > rows) continue;
      const line = frame.lines[y - 1];
      if (line === undefined) continue;
      const x1 = Math.max(1, Math.min(sel.x1, cols));
      const x2 = Math.max(1, Math.min(sel.x2, cols));
      const span = sliceDisplay(line, x1 - 1, x2);
      if (span.length === 0) continue;
      frame.set(y - 1, spliceDisplay(line, x1 - 1, `${SELECTION}${span}${RESET}`));
    }
  }

  /** Fire `afterRepaint` — never let a publisher's failure reach the paint
   * path. The screen is the product; publishing it is a side effect. */
  private notifyRepaint(): void {
    try {
      this.afterRepaint?.();
    } catch {
      /* a failed publish is never worth a broken frame */
    }
  }

  repaint(): void {
    if (!this.started || this.suspended || this.stopped) return;
    const cols = this.out.columns ?? 80;
    const rows = this.out.rows ?? 24;
    // +1 when a column is shown: the tab and the column share one border, and
    // `withSidebar` drops the tab's last cell to join them (composeColumn's
    // joinSeam). Without the +1 every tab would lose a usable column.
    const sw = this.sidebarWidth(cols);
    // The companion runs in a detached tmux window, whose implicit 80×24 size
    // otherwise survives forever. Feed the exact painted rectangle back to
    // the mirror; its next refresh atomically resizes then captures the pane.
    this.sidebar?.setViewport(sw, rows);
    const inner = sw === 0 ? cols : cols - sw + 1;
    const paint = (screen: string | Frame | undefined, fallback: string): void => {
      if (screen === undefined) {
        this.lastFrame = undefined;
        this.out.write(`${CLEAR}${fallback}`);
        this.notifyRepaint();
        return;
      }
      // A tab still returning a bare string predates the sidebar and simply
      // paints full-width without one, rather than being wrongly composed.
      if (typeof screen === "string") {
        this.lastFrame = undefined;
        this.out.write(screen);
        this.notifyRepaint();
        return;
      }
      const frame = this.withSidebar(screen, cols, rows);
      // Zellij-style spatial focus: exactly one pane owns the accent square.
      // The sidebar and board pi are terminals; otherwise the main TUI pane
      // owns focus. Colour existing frame glyphs only, never the content.
      const mainRight = sw === 0 ? frame.cols - 1 : inner - 1;
      if (sw > 0 && this.sidebar?.focused) {
        accentFrameRect(frame, inner - 1, 0, frame.cols - 1, rows - 1, ACCENT, RESET);
      } else if (this.tab === "board" && this.view.piFocus && frame.meta["piTop"] !== undefined) {
        accentFrameRect(frame, 0, frame.meta["piTop"]!, mainRight, rows - 1, ACCENT, RESET);
      } else {
        accentFrameRect(frame, 0, 0, mainRight, rows - 1, ACCENT, RESET);
      }
      // Selection first, prompt second: the modal must sit ON TOP of a
      // highlight, never under it.
      this.paintSelection(frame, cols, rows);
      this.paintQuitPrompt(frame, cols, rows);
      this.lastFrame = frame;
      this.out.write(frame.render());
      this.notifyRepaint();
    };
    if (this.tab === "digest") {
      paint(this.hooks.digestScreen?.(this, inner, rows), "digest tab lands in — [1] back to board");
      return;
    }
    if (this.tab === "deploy") {
      paint(this.hooks.deployScreen?.(this, inner, rows), "deploy tab not wired — [1] back to board");
      return;
    }
    if (this.tab === "metrics") {
      paint(this.hooks.metricsScreen?.(this, inner, rows), "metrics tab not wired — [1] back to board");
      return;
    }
    if (this.tab === "changes") {
      paint(this.hooks.changesScreen?.(this, inner, rows), "changes tab not wired — [1] back to board");
      return;
    }
    this.view.now = this.now();
    // Same reason as the sidebar above: the PR's pi runs in a detached tmux
    // window stuck at 80×24, so without this it wraps at 80 columns however
    // wide we paint the mirror. Fed here, applied by the next capture.
    this.pi.setViewport(piPaneSize(inner, rows));
    paint(renderBoard(this.view, inner, rows), "");
  }
}
