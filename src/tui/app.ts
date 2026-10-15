// qcr tui — the app loop: terminal setup/teardown, poller wiring, key
// routing, repaint. Screens and logic are pure modules; this file owns the
// side effects. The board, detail and events live here; quick-message and
// the tabs plug in via AppHooks.
//
// ONE LAYOUT (root CLAUDE.md): the tab on the left, the companion
// column on the right, on every frame. Nothing here may take the whole
// terminal, fold the column away or paint without it — see `sidebarWidth`
// and `repaint`, and tests/tui-fixed-layout.test.ts.
import type { WhyPayload } from "../cli.js";
import type { TuiConfig } from "../config.js";
import type { AlertBadge } from "./alerts.js";
import type { MessageOutcome } from "./msg.js";
import {
  boardBarHeight,
  boardKeys,
  overlayInputBox,
  piPaneSize,
  renderBoard,
  type BoardAction,
  type BoardView,
} from "./board.js";
import { barHitKey, NO_LIVE_KEYS, registeredKeys, type LiveKeys } from "./cmdbar.js";
import { decodeInputKey, decodeKey, type BoardKey } from "./keys.js";
import type { Tab } from "./tabs.js";
import { visiblePrs, type BoardFilter } from "./filters.js";
import { formatEvent, moveSelection, reselect, type EventLine } from "./model.js";
import { TripleCtrlC } from "./chord.js";
import { MOUSE_OFF, MOUSE_ON, MouseDecoder, hitTest, type MouseEvent, type Zone } from "./mouse.js";
import {
  ALT_SCREEN_OFF,
  ALT_SCREEN_ON,
  CLEAR,
  Frame,
  accentFrameRect,
  cleanCopiedBlock,
  cloneFrame,
  composeColumn,
  fit,
  sliceDisplay,
  spliceDisplay,
  stripAnsi,
} from "./paint.js";
import { ACCENT, RESET, SELECTION } from "./design.js";
import { ClipboardSink } from "./clipboard.js";
import { PANE_ESCAPE, PiMirror, isEndKey, keysToTmux } from "./pipane.js";
import { Poller } from "./poll.js";
import { parseRoundProgress } from "../round-progress.js";
import { prUrl } from "./theme.js";
import {
  type CompanionSidebar,
  paintSidebar,
  sidebarHit,
  sidebarResizeHit,
  sidebarWidth,
} from "./sidebar.js";
import { eventsArgv, progressArgv, sendKeysArgv, whyArgv, type SshRunner } from "./remote.js";

export type { Tab } from "./tabs.js";

/**
 * One installed surface (every tab but the board, which the App renders
 * itself). The install functions in memtab / digesttab / ticketstab /
 * deploytab / metricstab / feedbacktab / scantab each build one of these over their own
 * state and register it under `AppHooks.tabs`.
 */
export interface TabHooks {
  /** The tab's frame at the INNER width — the companion column composes
   * beside it; a bare, sidebar-less string is not a type a tab can return. */
  screen: (app: App, cols: number, rows: number) => Frame;
  /** Key handling; true when the tab consumed the key. */
  key: (app: App, key: BoardKey) => boolean;
  /** Mouse click (1-based terminal coords) — rows select, [buttons] fire
   * verbs; true when consumed. */
  click?: (app: App, x: number, y: number) => boolean;
  /**
   * What the tab answers to RIGHT NOW: the bar it paints and the
   * keys it paints beside their objects. The App registers exactly this set —
   * a key outside it reaches the companion column — so a tab that paints a
   * button it will not answer is lying to the operator AND stealing the
   * keystroke. Derived from the tab's state, never a constant.
   */
  keys: (app: App) => LiveKeys;
}

export interface AppHooks {
  /** The seven installed surfaces, by tab. The board is not here: the App owns
   * its render, its keys and its `boardKeys` (src/tui/board.ts). */
  tabs: Partial<Record<Exclude<Tab, "board">, TabHooks>>;
  // There is deliberately NO `attach` hook: the TUI has ONE layout — tab on
  // the left, companion column on the right — and nothing may take the whole
  // terminal (root CLAUDE.md). The board's pi
  // pane and the companion column are the only terminals, both embedded.
  /** Open the quick-message box for the given session. */
  message?: (session: string, app: App) => void;
  /** Deliver a submitted quick-message (inject write + confirmation);
   * resolves with how the delivery ended. */
  sendMessage?: (session: string, text: string, app: App) => void | Promise<MessageOutcome>;
  /** Cancel the PR's running round and re-queue it, via the daemon's
   * `commands/` dir. The board's one write action beyond wakes — see
   * src/tui/unwedge.ts for why it exists and what bounds it. */
  unwedge?: (pr: number, app: App) => void;
  /** The board's `I` — ask the companion to run its setup skill
   * (an inject into its own column, src/tui/setupentry.ts) and focus it. */
  setup?: (app: App) => void;
  /** Open a URL in the user's browser (default: xdg-open, detached). */
  openUrl?: (url: string) => void;
  /** First-launch marker (read, write). Default: state/tui-help-shown. */
  helpSeen?: { get(): boolean; set(): void };
  /** Called after every poll and every events refresh — the ambient
   * feed writer hangs off this (daemon-owned cadence). */
  onPoll?: (app: App) => void;
  /** The companion was asked for while its startup is down — re-run
   * that startup (build/up/rollover/spawn) and focus the column on success. */
  companionEnsure?: (app: App) => Promise<void>;
  /** Start ./scripts/deploy.sh sync after the deploy tab has engaged the
   * daemon drain and observed a fresh zero-running-round snapshot. Streams
   * output back into the tab; the handle aborts a stuck sync. */
  deployRun?: (
    app: App,
    runId: string,
    onData: (chunk: string) => void,
    onExit: (code: number | null) => void,
  ) => { kill(): void };
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

/**
 * Decoded verbs the BOARD owns. `handleInput` refuses them off the board —
 * see the comment at the guard.
 *
 * The membership test is "is this key advertised by the board's command bar"
 * (`boardKeys`, src/tui/board.ts), NOT "does it read the selection". Most
 * members happen to read it, but the reason they are here is that they are
 * the board's bar, they are unregistered elsewhere, and the board is where an
 * operator looks for them. Getting that reason wrong is how the next verb
 * ends up in or out by accident — a missing `unwedge` would let `u` from
 * another tab unwedge a PR nobody was looking at.
 */
const BOARD_ONLY_VERBS: ReadonlySet<string> = new Set([
  "attach",
  "enter",
  "message",
  "github",
  "events",
  "unwedge",
]);

/** The frame an UNWIRED tab paints: its notice on the first body row, at the
 * inner width, so the companion column still composes beside it. */
function placeholderFrame(cols: number, rows: number, notice: string): Frame {
  const frame = new Frame(cols, rows);
  frame.set(Math.min(1, Math.max(0, rows - 1)), fit(notice, cols));
  return frame;
}

export class App {
  readonly view: BoardView = {
    health: { kind: "unreachable", sinceS: Number.POSITIVE_INFINITY },
    // UNKNOWN until a heartbeat proves one: a default of `true` would paint a
    // DRY-RUN badge on a live installation.
    dryRun: undefined,
    events: [],
    selected: 0,
    eventsFocus: false,
    eventsScroll: 0,
    help: false,
  };
  tab: Tab = "board";
  readonly hooks: AppHooks;
  /** The companion sidebar — a right-hand column on every tab.
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
  /** The newest `why` read started per PR (its detailSeq), until it settles.
   * Only that read may write the PR's cache entry — an older one resolving
   * late must not stamp its older payload fresh — and while it is pending a
   * poll does not stack another. Invalidation drops it, so a read begun
   * before the invalidation cannot repopulate the cache either. */
  private readonly detailPending = new Map<number, number>();
  /** When a PR's last `why` read failed: a poll does not retry it sooner than
   * DETAIL_RETRY_MS (the read reaches GitHub; a 3s retry loop against a rate
   * limit is the wrong answer). Selection and `r` are not held by it. */
  private readonly detailFailedAt = new Map<number, number>();
  private static readonly DETAIL_RETRY_MS = 15_000;
  private quitResolve: (() => void) | undefined;
  private suspended = false;
  private readonly onData = (buf: Buffer): void => this.handleInput(buf);
  private readonly onResize = (): void => this.repaint();

  constructor(
    readonly cfg: TuiConfig,
    readonly ssh: SshRunner,
    private readonly out: NodeJS.WriteStream = process.stdout,
    private readonly input: NodeJS.ReadStream = process.stdin,
    hooks: Partial<AppHooks> = {},
    private readonly now: () => Date = () => new Date(),
  ) {
    this.hooks = { ...hooks, tabs: hooks.tabs ?? {} };
    this.poller = new Poller(cfg, ssh, () => this.onPoll(), now);
    this.pi = new PiMirror(cfg, ssh, () => {
      this.syncPiPane();
      // The session we were typing into went away — say so and hand the
      // keyboard back rather than swallowing keystrokes into nothing.
      if (this.view.piFocus && this.view.pi?.missing)
        this.blurPiPane(`pi session pr-${this.piFocusPr} is gone — keyboard back on the board`);
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
    // One queue for every keystroke into a pane: each chunk is its own ssh
    // round trip, and unqueued a slow "a" lets the Enter typed after it reach
    // tmux first and submit pi's input without it. For the same reason a
    // chunk that did not arrive drops everything queued behind it — an Enter
    // must never submit input with a hole in it — and says so; the next
    // keystroke typed once the queue has drained starts afresh.
    if (this.paneSendsQueued === 0) this.paneSendDropped = false;
    this.paneSendsQueued++;
    this.paneSendTail = this.paneSendTail
      .then(async () => {
        for (const parts of groups) {
          if (this.paneSendDropped) return;
          const res = await this.ssh(this.cfg.ssh_host, sendKeysArgv(this.cfg, `pr-${pr}`, parts), {
            timeoutMs: 5_000,
          });
          if (!res.ok) {
            this.paneSendDropped = true;
            this.notice(
              `✖ pr-${pr}: keys not delivered (${res.stderr.trim() || `exit ${res.code}`}) — input after them dropped`,
            );
            return;
          }
        }
      })
      .catch(() => {
        this.paneSendDropped = true;
      })
      .finally(() => {
        this.paneSendsQueued--;
        void this.pi.refresh(pr);
      });
  }
  private paneSendTail: Promise<void> = Promise.resolve();
  /** Sends queued and not yet finished. */
  private paneSendsQueued = 0;
  /** A send in the current queue failed: the rest of it is not sent. */
  private paneSendDropped = false;

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
    // From here the TUI owns the screen, and this is the FIRST thing that
    // happens: nothing external — no docker call, no network call, no
    // filesystem walk — runs before this paint.
    //
    // The first frame is already the final layout: the column's width is a
    // function of the terminal alone (`sidebarWidth`), the sidebar is wired
    // before this call, and the container merely fills a column that is
    // already the right size. Everything slow streams in behind
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
    this.repaint();
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

  /** The terminal has been restored and nothing may write to it again. Public
   * so the orchestrator's real-terminal escape hatch can check it: re-entering
   * the alt screen after teardown leaves the operator staring at a blank
   * alternate screen with no TUI behind it — the trap this file exists to
   * avoid, arrived at from the other end. */
  isStopped(): boolean {
    return this.stopped;
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
      this.suspended = false; // teardown must run even while the terminal is lent out
      this.teardown();
    } catch {
      /* a half-restored terminal still beats a trapped one */
    }
    this.exiter(130);
  }

  /** Lend the terminal out: stop painting, swallow board keys, drop our mouse
   * reporting. The ONE remaining borrower is `s` (index.ts `onRealTerminal`):
   * the GCP key-passphrase prompt has to run on the real terminal, outside the
   * alt screen. It is not a TUI surface and paints no layout of its own; the
   * board comes back exactly as it was the moment ssh returns. */
  suspend(): void {
    this.suspended = true;
    this.input.off("data", this.onData);
    this.out.write(MOUSE_OFF);
  }

  resume(): void {
    if (this.stopped) return; // a borrower returning after quit must not repaint
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
    return (
      this.suspended ||
      this.view.inputBox !== undefined ||
      this.view.piFocus === true ||
      this.sidebar?.focused === true
    );
  }

  /** The PR the board is pointing at (survives a hot-reload). */
  currentPr(): number | undefined {
    return this.selectedPr;
  }

  // ---- data --------------------------------------------------------------

  private onPoll(): void {
    // A tick already in flight when the operator quits resolves AFTER
    // teardown, and this method kicks off four more remote reads. They would
    // spawn ssh against a TUI that no longer exists — the same family as the
    // `stopped` guard on `repaint` (an async load resolving after quit must
    // not touch the restored terminal), one level earlier: it must not start
    // new work either.
    if (this.stopped) return;
    const snap = this.poller.state.snapshot;
    if (snap) {
      // Invalidate cached details the snapshot proves stale (state/head moved).
      for (const pr of snap.prs) {
        const c = this.detailCache.get(pr.number);
        if (c && (c.payload.head_sha !== pr.head_sha || c.payload.state !== pr.state))
          this.invalidateDetail(pr.number);
      }
      this.view.snapshot = snap;
      this.view.dryRun = snap.dry_run;
      const sorted = visiblePrs(this.view);
      this.view.selected = reselect(sorted, this.selectedPr, this.view.selected);
      this.selectedPr = sorted[this.view.selected]?.number;
    }
    this.view.health = this.poller.health();
    void this.refreshEvents();
    if (this.detailWanted()) void this.refreshDetail();
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
      const parsed = JSON.parse(res.stdout) as {
        events: Array<{ ts: string; kind: string; pr: number | null; payload: string | null }>;
      };
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

  /** Override point to splice extra rows (e.g. quick-message pending/delivered)
   * into the events strip; the base passes lines through. */
  protected mergeNotices(lines: EventLine[]): EventLine[] {
    return lines;
  }

  /** A poll refreshes the detail when the selection moved, or when the
   * selected PR's cache entry is gone (invalidated) or past its TTL and no
   * read for it is already in flight — a PR that stays selected must follow
   * its new rounds without the operator moving away or pressing `r`. */
  private detailWanted(): boolean {
    const pr = this.selectedPr;
    if (pr === undefined) return false;
    // A read already in flight for it answers the question — stacking another
    // each tick would bump detailSeq and starve a read slower than the poll.
    if (this.detailPending.has(pr)) return false;
    const failed = this.detailFailedAt.get(pr);
    if (failed !== undefined && Date.now() - failed < App.DETAIL_RETRY_MS) return false;
    if (this.view.detail?.pr !== pr) return true;
    const c = this.detailCache.get(pr);
    return !c || Date.now() - c.fetched_at >= App.DETAIL_TTL_MS;
  }

  /** Read the selected PR's detail. Served from cache at once; the fetch is
   * skipped while the cache is fresh, unless `force` (the operator's `r`). */
  async refreshDetail(opts: { force?: boolean } = {}): Promise<void> {
    const pr = this.selectedPr;
    if (pr === undefined) return;
    const cached = this.detailCache.get(pr);
    const now = Date.now();
    if (cached) {
      this.view.detail = cached.payload;
      this.repaint();
      if (!opts.force && now - cached.fetched_at < App.DETAIL_TTL_MS) return;
    }
    const seq = ++this.detailSeq;
    this.detailPending.set(pr, seq);
    const res = await this.ssh(this.cfg.ssh_host, whyArgv(this.cfg, pr));
    // Superseded (a newer read for this PR started) or invalidated meanwhile:
    // this payload may be older than what the cache should hold.
    const newest = this.detailPending.get(pr) === seq;
    if (newest) this.detailPending.delete(pr);
    if (!res.ok) {
      if (newest) this.detailFailedAt.set(pr, Date.now());
      return;
    }
    try {
      const payload = JSON.parse(res.stdout) as WhyPayload;
      if (newest) this.detailFailedAt.delete(pr);
      if (newest && payload.pr === pr)
        this.detailCache.set(payload.pr, { payload, fetched_at: Date.now() });
      if (seq !== this.detailSeq || payload.pr !== this.selectedPr) return;
      this.view.detail = payload;
      this.repaint();
    } catch {
      if (newest) this.detailFailedAt.set(pr, Date.now());
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
    this.detailPending.delete(pr);
  }

  // ---- input -------------------------------------------------------------

  /**
   * Point the board at `pr` (the companion's `select_pr` action, a row click
   * and the events overlay land here). Once the board has loaded, a PR it does not list
   * (closed, or outside the filter) is refused with a notice and the
   * selection stays where it is — the highlighted row, the detail and the
   * mirrored session never point at different PRs. Before the first snapshot
   * the request is kept (a `qcr tui <pr>` deep link), and the first poll
   * settles it. False when refused.
   */
  selectPr(pr: number): boolean {
    const sorted = visiblePrs(this.view);
    if (this.view.snapshot !== undefined && !sorted.some((p) => p.number === pr)) {
      this.notice(`#${pr} is not on the board (closed, or outside the filter)`);
      return false;
    }
    this.view.selected = reselect(sorted, pr, this.view.selected);
    this.selectionMoved(pr);
    return true;
  }

  /** The selection now points at `pr`: everything that shows the selected PR
   * follows it — the progress panel (another PR's is never shown), the
   * detail, and the mirrored session. */
  private selectionMoved(pr: number | undefined): void {
    this.selectedPr = pr;
    if (this.view.progress?.pr !== pr) this.view.progress = undefined;
    void this.refreshDetail();
    void this.refreshProgress();
    this.followSelection();
  }

  /** Move the events overlay's scroll, clamped to its lines. */
  private scrollEvents(delta: number): void {
    this.view.eventsScroll = moveSelection(this.view.eventsScroll, delta, this.view.events.length);
  }

  /** Narrow (or, with null, clear) the board. The selection stays on the
   * same PR while it is still listed; otherwise it lands on the nearest row
   * of the new list — and the row, the detail and the mirrored session move
   * together, so the next key addresses the highlighted PR. */
  setBoardFilter(filter: BoardFilter | null): void {
    this.view.boardFilter = filter;
    const sorted = visiblePrs(this.view);
    this.view.selected = reselect(sorted, this.selectedPr, this.view.selected);
    const pr = sorted[this.view.selected]?.number;
    if (pr === this.selectedPr) return;
    this.selectionMoved(pr);
  }

  selectedSession(): string | undefined {
    const pr = this.selectedPrNumber();
    return pr === undefined ? undefined : `pr-${pr}`;
  }

  notice(text: string): void {
    this.view.noticeLine = text;
    // Before the TUI owns the screen, a notice is startup progress and prints
    // as a plain line — the companion can take minutes to build, and silence
    // there looks like a hang, and painting a frame this early would flash.
    // The alt screen hides these the
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
    this.view.inputBox = {
      target: pr ? `#${pr} (pi session ${session})` : session,
      text: this.msgDraft,
    };
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
        if (this.inputSubmit)
          this.inputSubmit = undefined; // tab prompts keep no draft
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
          if (this.hooks.sendMessage) void this.hooks.sendMessage(session, text, this);
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

  /** The installed surface under the current tab, if any (never the board). */
  private tabHooks(): TabHooks | undefined {
    return this.tab === "board" ? undefined : this.hooks.tabs[this.tab];
  }

  /**
   * What the current frame answers to: the bar the tab paints plus
   * its inline keys. ONE computation feeds the bar's hit-test, the companion
   * routing (`registeredKeys`) and the paint, so the three cannot disagree.
   * An unwired tab answers to nothing but the globals.
   */
  liveKeys(): LiveKeys {
    if (this.tab === "board") return boardKeys(this.view);
    return this.tabHooks()?.keys(this) ?? NO_LIVE_KEYS;
  }

  /** Every printable the current frame claims — the companion column gets
   * the rest. Public for the fences: a registered key must answer. */
  registeredKeys(): Set<string> {
    return registeredKeys(this.liveKeys());
  }

  private handleMouse(ev: MouseEvent): void {
    // The quit prompt is modal for the mouse as it is for the keyboard: a
    // click is its "any other key" (cancel), and nothing under the prompt —
    // a PR row, a GitHub link, the pi pane, the companion column, a tab's
    // zones — ever sees it. Wheel, drag and release are swallowed.
    if (this.view.confirmQuit) {
      if (ev.kind === "click") {
        this.view.confirmQuit = false;
        this.repaint();
      }
      // A release swallowed here still ends any gesture begun before the
      // prompt opened — never leave a seam resize armed behind it.
      if (ev.kind === "release") {
        this.sidebarResizeActive = false;
        this.selAnchor = undefined;
      }
      return;
    }
    const cols = this.out.columns ?? 80;
    // The sidebar's left seam is the ONE drag surface that is chrome rather
    // than selectable content. Everywhere else drag and release belong to the
    // rectangular copy.
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
      // The first motion freezes the screen and fixes the pane the drag
      // belongs to; every later motion only moves the far corner.
      if (!this.selFrame) {
        this.selFrame = this.baseFrame;
        this.selPane = this.paneRectAt(anchor.x, anchor.y);
      }
      const p = this.selPane ?? { x1: 1, y1: 1, x2: cols, y2: this.out.rows ?? 24 };
      const cx = (x: number): number => Math.max(p.x1, Math.min(p.x2, x));
      const cy = (y: number): number => Math.max(p.y1, Math.min(p.y2, y));
      this.selection = {
        x1: cx(Math.min(anchor.x, ev.x)),
        y1: cy(Math.min(anchor.y, ev.y)),
        x2: cx(Math.max(anchor.x, ev.x)),
        y2: cy(Math.max(anchor.y, ev.y)),
      };
      this.repaint();
      return;
    }
    if (ev.kind === "release") {
      // A press with no drag is a plain click and has already been handled;
      // there is nothing to copy and the anchor just goes away.
      if (this.selection) this.copySelection();
      else this.selAnchor = undefined;
      this.selFrame = undefined;
      this.selPane = undefined;
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
      // Hit-test at the width the bar was PAINTED at — the tab's inner width
      // beside the companion column, not the terminal's. The bar wraps, so its
      // row count depends on the width: tested at the full width, a click on
      // the painted [r refresh] decoded as a nav slot one row up, and the
      // phantom slots extended into the column (terminal x is inner-frame x
      // because the tab is on the left).
      const k = barHitKey(this.tab, ev.x, ev.y, this.innerWidth(cols), rows, this.liveKeys().bar);
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
      // in it takes the keyboard (its mirror IS the companion — there is no
      // full-screen view to open, and no collapsed state to toggle).
      if (this.sidebar) {
        const width = this.sidebarWidth(cols);
        const hit = width === 0 ? undefined : sidebarHit(ev.x, ev.y, cols, rows, width);
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
    // actually reading: scrolling the conversation while the column has focus
    // must never walk the board's selection (and drag the pi mirror away from
    // the PR being read).
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
    // The KEYS overlay covers the tab, the board included (see repaint): what
    // it hides is not on screen, so a click must not reach it (a hidden [url]
    // or row would fire unseen) and the wheel must not move a hidden
    // selection. A click dismisses help, as any key does; the wheel is
    // swallowed.
    if (this.view.help) {
      if (ev.kind === "click") {
        this.view.help = false;
        this.repaint();
      }
      return;
    }
    const tab = this.tabHooks();
    if (this.tab !== "board") {
      // An installed surface: clicks hit its own zones (rows select, buttons
      // act); the wheel is handed over as a key that says it was a wheel.
      if (ev.kind === "click") tab?.click?.(this, ev.x, ev.y);
      else tab?.key(this, { kind: ev.kind === "wheel-down" ? "down" : "up", wheel: true });
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
        this.scrollEvents(delta);
      } else {
        const sorted = visiblePrs(this.view);
        this.view.selected = moveSelection(this.view.selected, delta, sorted.length);
        this.selectionMoved(sorted[this.view.selected]?.number);
      }
      this.repaint();
      return;
    }
    const action = zoneAt(ev.x, ev.y);
    // Any click outside the pane hands the keyboard back to the board — that
    // includes clicks on nothing in particular in the list/detail region.
    const paneWasFocused = this.view.piFocus;
    if (action?.t !== "pi-focus" && paneWasFocused) {
      this.blurPiPane();
      this.repaint();
    }
    if (!action) return;
    switch (action.t) {
      case "select-pr": {
        if (this.selectedPr === action.pr) {
          // Second click on the selected row = go to its pi, the same thing
          // ⏎ does. If the pane WAS focused, the click above already handed the
          // keyboard back, and that is the whole meaning of it.
          if (paneWasFocused) return;
          this.focusPiPane();
          this.repaint();
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
      case "companion":
        // The top-bar alert badge: hand the keyboard to the companion column.
        this.openCompanion();
        return;
    }
    this.repaint();
  }

  private readonly killChord = new TripleCtrlC();
  private readonly mouse = new MouseDecoder();

  private handleInput(buf: Buffer): void {
    if (this.killChord.feed(buf)) {
      this.die();
      return;
    }
    if (this.suspended) return;
    const { events, rest } = this.mouse.feed(buf);
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
    // The pi pane owns the keyboard while it is focused: j/k/q/1-8/? and every
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
      if (isEndKey(buf.toString("utf8")) && this.pi.offsetFor(this.piFocusPr) > 0) {
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
    // the companion is a live terminal, so j/k/1-8/? are just text to it.
    // Ctrl-q releases — the same chord, so there is ONE way out of every
    // embedded surface; Esc belongs to pi.
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
    // `\` is plain text for pi like any other unclaimed printable: the column
    // is always at its full width and the layout never changes shape.
    // The installed surface gets first crack at every key — including the
    // nav digits, which the metrics tab reads as TEXT inside its `# <pr> ⏎`
    // box (`keyChar` maps a tab kind back to its digit). Outside that box no
    // tab answers to a digit, so the hook returns false and the key falls
    // through to the switch below.
    if (this.tabHooks()?.key(this, key)) return;
    // An unregistered printable is a message to the companion, not a dead
    // key: focus the sidebar seeded with it (paste seeds whole). Registered
    // means "this frame answers to it" — the set is derived from
    // the bar the tab is painting right now, never from a table.
    if (
      this.sidebar?.available() &&
      raw.length > 0 &&
      !raw.includes("\x1b") &&
      raw >= " " &&
      raw !== "\x7f" && // backspace (DEL) is an edit, never draft text
      raw !== "\b" &&
      !(raw.length === 1 && this.registeredKeys().has(raw))
    ) {
      this.sidebar.focus(raw);
      this.repaint();
      return;
    }

    // The verbs below belong to the BOARD's command bar, so they only answer
    // on the board: off it, `a` would focus the board's pi pane behind your
    // back, and `u` would unwedge a PR nobody was looking at. A verb with no
    // meaning on the current surface must do nothing; the printable
    // spellings are unregistered off the board, so they reach the companion
    // column instead of dying here. The one exception is a live
    // alert, which owns ⏎ from wherever you are.
    if (
      this.tab !== "board" &&
      BOARD_ONLY_VERBS.has(key.kind) &&
      !(key.kind === "enter" && this.view.alertFocus)
    )
      return;

    switch (key.kind) {
      case "quit":
        this.requestQuit(buf.toString("utf8") === "\x03" ? "ctrl-c" : "key");
        return;
      case "help":
        this.view.help = true;
        break;
      case "tab":
        this.tab = key.tab;
        break;
      case "up":
      case "down": {
        const delta = key.kind === "down" ? 1 : -1;
        if (this.view.eventsFocus) {
          this.scrollEvents(delta);
          break;
        }
        const sorted = visiblePrs(this.view);
        this.view.selected = moveSelection(this.view.selected, delta, sorted.length);
        this.msgDraft = ""; // board navigation drops a cancelled draft
        this.selectionMoved(sorted[this.view.selected]?.number);
        break;
      }
      case "escape":
        this.view.eventsFocus = false;
        this.view.alertFocus = false; // acknowledged: ⏎ goes back to the pi pane
        break;
      case "events":
        this.view.eventsFocus = !this.view.eventsFocus;
        this.view.eventsScroll = 0;
        break;
      case "refresh":
        void this.poller.tick();
        void this.refreshDetail({ force: true });
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
        // ⏎ on a PR row focuses the board's EMBEDDED pane. Nothing may take
        // the whole TUI (root CLAUDE.md, the fixed layout). With no PR
        // selected there is nothing to focus, and nothing else to open.
        if (this.selectedPr !== undefined) {
          this.focusPiPane();
          this.repaint();
        }
        return;
      }
      case "github":
        this.openGithub();
        return;
      case "message": {
        const session = this.selectedSession();
        if (!session) break;
        if (this.hooks.message) this.hooks.message(session, this);
        else this.openMessageBox(session);
        break;
      }
      case "unwedge": {
        // Cancel the selected PR's running round and re-queue it. Safe
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
          this.setBoardFilter(null);
          break;
        }
        // I starts setup — the companion takes it from there.
        if (key.ch === "I" && this.tab === "board") {
          if (this.hooks.setup) this.hooks.setup(this);
          else this.notice("setup: not wired (no companion in this TUI)");
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
   * The companion is always on screen, at full width, so "open" means take
   * the keyboard. Nothing in the TUI covers the whole terminal, and the
   * column never collapses.
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

  /** Give the column the keyboard. */
  /** Give the companion column the keyboard — taking it from the PR pane
   * first: one keyboard owner, whoever asked (a retry that heals can land
   * here after the operator focused a pane). */
  focusCompanion(): void {
    if (!this.sidebar) return;
    if (this.view.piFocus) this.blurPiPane();
    this.sidebar.focus();
    this.repaint();
  }

  /**
   * Keys while the companion column has focus: RAW PASSTHROUGH to pi.
   *
   * The column is an embedded terminal, exactly like the board's pi pane, and
   * that is the whole point of running pi in tmux — `/` commands, the
   * completion menu, history, multi-line editing, Ctrl-C to interrupt a turn
   * are all pi's, and they only work if pi actually receives the bytes.
   *
   * DO NOT reintroduce a TUI-side draft line here: it would be a second, worse
   * input box in front of the real one, with no `/` commands and nothing
   * clickable. The rule is in
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
    void sidebar
      .sendKeys(buf)
      .catch((err: unknown) =>
        this.notice(`✖ ${String(err instanceof Error ? err.message : err)}`),
      );
  }

  /** The alert that last armed `alertFocus`. A folded repeat keeps the
   * consumer's `latest` object, so it updates the counters without re-arming
   * an alert the operator already acknowledged. */
  private armedAlert: AlertBadge["latest"];

  /** Alert consumer → top bar. A NEW `alert`-tier alert also grabs ⏎ (see
   * handleInput); a folded repeat of it does not. */
  setAlertBadge(badge: AlertBadge): void {
    this.view.alerts = badge;
    if (badge.latest?.tier === "alert" && badge.latest !== this.armedAlert) {
      this.armedAlert = badge.latest;
      this.view.alertFocus = true;
    }
    this.repaint();
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
   * True when the pointer is inside the column, or when the column holds the
   * keyboard and the pointer is elsewhere.
   */
  private wheelBelongsToSidebar(x: number, cols: number): boolean {
    const sb = this.sidebar;
    if (!sb) return false;
    const width = this.sidebarWidth(cols);
    if (width === 0) return false;
    if (x > cols - width && x <= cols) return true;
    return sb.focused;
  }

  /**
   * Width the companion column takes on THIS paint.
   *
   * A pure function of the terminal width and the operator's seam drag —
   * never of config, docker or the container's state: the column is part of
   * the layout whenever a sidebar exists at all, so the first frame is the final shape and nothing that
   * happens later can move it. `0` only for a harness that built no sidebar.
   */
  sidebarWidth(cols: number): number {
    if (!this.sidebar) return 0;
    return sidebarWidth(cols, { preferredWidth: this.sidebar.preferredWidth });
  }

  /** The tab's own width: everything left of the companion column, the
   * shared border cell included — the width every tab renders and lays its
   * command bar out at. */
  innerWidth(cols: number): number {
    const sw = this.sidebarWidth(cols);
    return sw === 0 ? cols : cols - sw + 1;
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

  // ---- mouse selection → clipboard -----------------------------------------
  //
  // Turning mouse reporting on takes the terminal's own selection away, so the
  // TUI owes one back. A selection is almost always made to copy it, so there
  // is no copy key and no copy mode: release IS the copy.
  //
  // RECTANGULAR, not linear. The screen is columns side by side — list next to
  // detail next to the companion — and a linear selection across a row would
  // splice text from panes the user never pointed at. A block keeps a drag
  // inside the pane it started in, which is what "select this bit of pi's
  // output" means beside the companion conversation.
  private sidebarResizeActive = false;
  private selAnchor: { x: number; y: number } | undefined;
  private selection: { x1: number; y1: number; x2: number; y2: number } | undefined;
  /** The last composed frame WITHOUT the highlight — what a drag freezes. */
  private baseFrame: Frame | undefined;
  /**
   * The screen as it was when the drag began, held until release.
   *
   * The mirrors refresh under the pointer several times a second while pi
   * streams: without the freeze the text would scroll out from under a
   * half-finished drag, and release would copy whatever had arrived in its
   * place rather than what the operator had highlighted.
   */
  private selFrame: Frame | undefined;
  /** The pane the drag started in (1-based, inclusive); the block never leaves it. */
  private selPane: { x1: number; y1: number; x2: number; y2: number } | undefined;
  /** Injectable so tests never touch the real clipboard. */
  clipboard: { write(text: string): Promise<boolean> } = new ClipboardSink();

  /** The selected block as plain text, exactly as it appears on screen. */
  selectedText(): string {
    const sel = this.selection;
    const frame = this.selFrame ?? this.baseFrame ?? this.lastFrame;
    if (!sel || !frame) return "";
    const rows: string[] = [];
    for (let y = sel.y1; y <= sel.y2; y++) {
      const line = frame.lines[y - 1];
      if (line === undefined) continue;
      // BY DISPLAY CELL, not code unit: what is copied must be what was
      // highlighted, and a single wide glyph earlier in the row would put
      // those two out of step.
      rows.push(sliceDisplay(line, sel.x1 - 1, sel.x2));
    }
    return cleanCopiedBlock(rows);
  }

  /**
   * The pane under a point, as the content rectangle a selection may cover
   * (1-based, inclusive, borders excluded).
   *
   * A rectangular block already keeps a drag in its COLUMN band, but a drag
   * that wandered a cell too far picked up the neighbour's border and first
   * letters — the board's list beside its detail, the companion column beside
   * the tab. Each pane is known from the layout, not guessed from glyphs: the
   * companion column, and on the board the list, the detail and the pi pane
   * (`frame.meta`, written by renderBoard). Any other tab is one pane.
   */
  private paneRectAt(
    x: number,
    y: number,
  ): { x1: number; y1: number; x2: number; y2: number } | undefined {
    const frame = this.baseFrame;
    if (!frame) return undefined;
    const cols = frame.cols;
    const rows = frame.rows;
    const sw = this.sidebarWidth(cols);
    // The seam: with a column, the tab's right border IS the column's left one.
    const seam = sw === 0 ? cols : this.innerWidth(cols);
    if (sw > 0 && x > seam) return { x1: seam + 1, y1: 2, x2: cols - 1, y2: rows - 1 };
    const half = { x1: 2, y1: 1, x2: seam - 1, y2: rows };
    const m = frame.meta;
    if (this.tab !== "board" || this.view.help || m["listW"] === undefined) return half;
    const listW = m["listW"];
    const bodyRows = m["bodyRows"] ?? 0;
    const piTop = m["piTop"] ?? rows; // 0-based divider row
    const piRows = m["piRows"] ?? 0;
    // Body rows are 0-based 1..bodyRows: 1-based 2..bodyRows+1.
    if (y >= 2 && y <= bodyRows + 1) {
      return x <= listW + 1
        ? { x1: 2, y1: 2, x2: listW + 1, y2: bodyRows + 1 }
        : { x1: listW + 3, y1: 2, x2: half.x2, y2: bodyRows + 1 };
    }
    // The pi pane: its header row and mirror lines, below the divider.
    if (piRows > 0 && y >= piTop + 2 && y <= piTop + piRows) {
      return { x1: 2, y1: piTop + 2, x2: half.x2, y2: piTop + piRows };
    }
    return half;
  }

  /**
   * The WHOLE last painted frame as plain text: exactly what is on
   * screen, ANSI stripped, trailing blank rows dropped. Same source as
   * `selectedText()` (the last painted frame), for the same reason: what the
   * companion is shown must be what the operator is looking at, not a re-render of
   * the model behind it.
   *
   * `undefined` before the first frame is painted. Never a fetch: this is a
   * getter over state already painted.
   */
  screenText(): string | undefined {
    const frame = this.lastFrame;
    if (!frame) return undefined;
    const rows = frame.lines.map((line) => stripAnsi(line).replace(/\s+$/, ""));
    while (rows.length > 0 && rows[rows.length - 1] === "") rows.pop();
    return rows.join("\n");
  }

  /**
   * Called at the end of every repaint, so the published view tracks
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
    this.copyText(text);
    // The highlight stays until the next click, so it is visible at the moment
    // the confirmation appears — proof of WHAT was copied, not just that
    // something was.
    this.repaint();
  }

  /**
   * Put `text` on the system clipboard and say so on the notice line — the
   * ONE route for every copy the TUI makes: a released drag, and a copy made
   * inside the companion's container (`from`, e.g. pi's `/copy`), which the
   * column hands over because nothing else could deliver it (sidebar.ts
   * `onCopy`).
   */
  copyText(text: string, from?: string): void {
    if (text.length === 0) return;
    const lines = text.split("\n").length;
    const what = `${text.length} chars${lines > 1 ? ` · ${lines} lines` : ""}`;
    void this.clipboard
      .write(text)
      .then((ok) =>
        this.notice(
          ok
            ? `✓ copied ${what}${from ? ` from ${from}` : ""}`
            : "✖ no clipboard tool (wl-copy / xclip / klipper)",
        ),
      )
      .catch(() => this.notice("✖ clipboard write failed"));
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
    const inner = this.innerWidth(cols);
    const paint = (screen: Frame | undefined, fallback: string): void => {
      // An unwired tab (a harness, or a hook that failed to install) paints
      // its one-line notice INSIDE the layout, never as a bare full-width
      // string: the column is part of every frame, wired tab or not.
      // Mid-drag the screen holds still (see selFrame): repaint the frozen
      // frame with the moving highlight, and nothing new underneath it.
      const frozen = this.selFrame;
      const frame = frozen
        ? cloneFrame(frozen)
        : this.withSidebar(screen ?? placeholderFrame(inner, rows, fallback), cols, rows);
      // Zellij-style spatial focus: exactly one pane owns the accent square.
      // The sidebar and board pi are terminals; otherwise the main TUI pane
      // owns focus. Colour existing frame glyphs only, never the content.
      const mainRight = sw === 0 ? frame.cols - 1 : inner - 1;
      if (frozen) {
        // already composed and accented
      } else if (sw > 0 && this.sidebar?.focused) {
        accentFrameRect(frame, inner - 1, 0, frame.cols - 1, rows - 1, ACCENT, RESET);
      } else if (this.tab === "board" && this.view.piFocus && frame.meta["piTop"] !== undefined) {
        accentFrameRect(frame, 0, frame.meta["piTop"], mainRight, rows - 1, ACCENT, RESET);
      } else {
        accentFrameRect(frame, 0, 0, mainRight, rows - 1, ACCENT, RESET);
      }
      if (!frozen) this.baseFrame = cloneFrame(frame);
      // Selection first, prompt second: the modal must sit ON TOP of a
      // highlight, never under it.
      this.paintSelection(frame, cols, rows);
      this.paintQuitPrompt(frame, cols, rows);
      this.lastFrame = frame;
      this.out.write(frame.render());
      this.notifyRepaint();
    };
    // `?` is a global key advertised on every tab's bar, and the KEYS overlay
    // (renderBoard's help branch) is the only thing that paints it — so while
    // help is up, every tab shows it. A tab screen here would leave the flag
    // set with nothing on screen, and the next keystroke silently eaten.
    if (this.tab !== "board" && !this.view.help) {
      const screen = this.tabHooks()?.screen(this, inner, rows);
      // A prompt the tab opened types into the input box: show it there.
      if (screen && this.view.inputBox) overlayInputBox(screen, this.view.inputBox);
      paint(screen, `${this.tab} tab not wired — [1] back to board`);
      return;
    }
    this.view.now = this.now();
    // Same reason as the sidebar above: the PR's pi runs in a detached tmux
    // window stuck at 80×24, so without this it wraps at 80 columns however
    // wide we paint the mirror. Fed here, applied by the next capture — and
    // sized against the bar rows THIS frame's board actually paints.
    this.pi.setViewport(piPaneSize(inner, rows, boardBarHeight(this.view, inner)));
    paint(renderBoard(this.view, inner, rows), "");
  }
}
