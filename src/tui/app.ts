// qcr tui — the app loop: terminal setup/teardown, poller wiring, key
// routing, repaint. Screens and logic are pure modules; this file owns the
// side effects. Slice: board + detail + events (attach and
// quick-message land in and plug in via AppHooks).
import type { WhyPayload } from "../cli.js";
import type { TuiConfig } from "../config.js";
import type { AlertBadge } from "./alerts.js";
import { renderBoard, type BoardAction, type BoardView } from "./board.js";
import { barHitKey, registeredKeys } from "./cmdbar.js";
import { decodeInputKey, decodeKey } from "./keys.js";
import { formatEvent, moveSelection, reselect, sortPrs, type EventLine } from "./model.js";
import { TripleCtrlC } from "./chord.js";
import { MOUSE_OFF, MOUSE_ON, extractMouseEvents, hitTest, type MouseEvent, type Zone } from "./mouse.js";
import { ALT_SCREEN_OFF, ALT_SCREEN_ON, CLEAR, Frame } from "./paint.js";
import { PANE_ESCAPE, PiMirror, keysToTmux } from "./pipane.js";
import { Poller } from "./poll.js";
import { prUrl } from "./theme.js";
import { CompanionStrip, stripHeight, stripHit } from "./strip.js";
import { eventsArgv, sendKeysArgv, whyArgv, type SshRunner } from "./remote.js";

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
  /**: mouse click on the Memory & learning tab (1-based coords) —
   * rows select, [buttons] fire verbs. */
  digestClick?: (app: App, x: number, y: number) => void;
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
  /**: attach the local companion container's tmux session
   * full-screen (reached from the strip's mirror rows + alerts). */
  companionAttach?: (app: App) => Promise<void>;
  /** Deploy tab: what would a deploy ship (read-only — never deploys). */
  deployScreen?: (app: App, cols: number, rows: number) => string;
  /** Deploy tab key handling; returns true when it consumed the key. */
  deployKey?: (app: App, key: ReturnType<typeof decodeKey>) => boolean;
  /**: metrics dashboard / per-PR timeline screen. */
  metricsScreen?: (app: App, cols: number, rows: number) => string;
  /** Metrics tab key handling; returns true when it consumed the key. */
  metricsKey?: (app: App, key: ReturnType<typeof decodeKey>) => boolean;
  /** Metrics tab click routing (window switcher zones); true = consumed. */
  metricsClick?: (app: App, x: number, y: number) => boolean;
  /** Start ./scripts/deploy.sh sync, streaming its output back into the
   * deploy tab (the TUI stays up). onData receives raw chunks, onExit the
   * exit code; the handle aborts a stuck run. The script's own guardrails
   * (clean tree, pin agreement) are the only gate. */
  deployRun?: (
    app: App,
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

export type Tab = "board" | "digest" | "deploy" | "metrics";

/** Every encoding of the End key we might see — the pi pane's "back to live". */
const END_KEYS = new Set(["\x1b[F", "\x1bOF", "\x1b[4~", "\x1b[8~"]);

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
  /**: the companion strip above the command bar, on every tab.
   * Wired by index.ts; absent in bare test harnesses (no strip painted). */
  strip?: CompanionStrip;
  readonly poller: Poller;
  /** Live mirror of the selected PR's pi session (board's lower region). */
  readonly pi: PiMirror;
  /** Raw event rows behind view.events — the ambient feed writes these
   * verbatim, so the companion sees what the daemon logged, not our prose. */
  rawEvents: Array<{ ts: string; kind: string; pr: number | null; payload: string | null }> = [];
  private selectedPr: number | undefined;
  private detailSeq = 0;
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
    this.strip?.blur(); // one keyboard owner at a time
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
    this.strip?.stop();
    if (this.piTimer) clearInterval(this.piTimer);
    this.piTimer = undefined;
    this.input.off("data", this.onData);
    this.out.off("resize", this.onResize);
    if (this.input.isTTY) this.input.setRawMode(false);
    this.input.pause();
    this.out.write(MOUSE_OFF + ALT_SCREEN_OFF);
  }

  quit(): void {
    this.quitResolve?.();
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
    void this.pi.refresh(this.panePr()); // the mirror caught up while attached
    this.repaint();
    this.hooks.onResume?.();
  }

  /** True while something other than the board owns the terminal or holds
   * unsaved user input — hot-reload defers on it. */
  isBusy(): boolean {
    return this.suspended || this.view.inputBox !== undefined || this.view.piFocus === true || this.strip?.focused === true;
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
      const sorted = sortPrs(snap.prs);
      this.view.selected = reselect(sorted, this.selectedPr, this.view.selected);
      this.selectedPr = sorted[this.view.selected]?.number;
    }
    this.view.health = this.poller.health();
    void this.refreshEvents();
    if (this.view.detail?.pr !== this.selectedPr) void this.refreshDetail();
    // The mirror only costs an ssh while the board is the visible tab.
    this.syncPiPane();
    if (this.tab === "board" && !this.suspended) void this.pi.refresh(this.panePr());
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

  /** Drop a PR's cached detail (a new verdict/round event makes it stale). */
  invalidateDetail(pr: number): void {
    this.detailCache.delete(pr);
  }

  // ---- input -------------------------------------------------------------

  /** Point the board selection at a PR (digest-tab actions jump here). */
  selectPr(pr: number): void {
    this.selectedPr = pr;
    const sorted = this.view.snapshot ? sortPrs(this.view.snapshot.prs) : [];
    this.view.selected = reselect(sorted, pr, this.view.selected);
    void this.refreshDetail();
    this.followSelection();
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

  /** Synthesize a keypress through the normal input path — the command bar's
   * buttons and any tab code that wants "exactly what the key would do". */
  pressKey(key: string): void {
    this.handleInput(Buffer.from(key, "utf8"));
  }

  private handleMouse(ev: MouseEvent): void {
    // The command bar answers first, on every tab: a click on one of its
    // buttons IS that keypress, wherever it lands. EXCEPT while an input box
    // is open — a synthesized key would be typed into the box, and [⏎]
    // would SUBMIT the draft (a live memory edit or quick-message).
    if (ev.kind === "click" && !this.view.inputBox) {
      const cols = this.out.columns ?? 80;
      const rows = this.out.rows ?? 24;
      const k = barHitKey(this.tab, ev.x, ev.y, cols, rows);
      if (k !== undefined) {
        // A focused pi pane would swallow the synthesized key as text.
        if (this.view.piFocus) {
          this.blurPiPane();
          this.repaint();
        }
        this.pressKey(k);
        return;
      }
      // The companion strip is fixed chrome too: the input row focuses it,
      // the mirror rows open the full-screen companion attach.
      if (this.strip) {
        const avail = this.strip.available();
        const hit = stripHit(ev.x, ev.y, cols, rows, stripHeight(rows, avail));
        if (hit === "input") {
          if (avail) {
            if (this.view.piFocus) this.blurPiPane();
            this.strip.focus();
            this.repaint();
          }
          return;
        }
        if (hit === "mirror") {
          this.openCompanion();
          return;
        }
      }
    }
    if (this.tab === "digest") {
      // Memory & learning tab: clicks hit the tab's own zones (rows select,
      // buttons act); the wheel moves the selection / scrolls.
      if (ev.kind === "click") this.hooks.digestClick?.(this, ev.x, ev.y);
      else this.hooks.digestKey?.(this, { kind: ev.kind === "wheel-down" ? "down" : "up" });
      return;
    }
    if (this.tab === "deploy") {
      if (ev.kind === "click") this.hooks.deployClick?.(this, ev.x, ev.y);
      else this.hooks.deployKey?.(this, { kind: ev.kind === "wheel-down" ? "down" : "up" });
      return;
    }
    if (this.tab === "metrics") {
      if (ev.kind === "click") this.hooks.metricsClick?.(this, ev.x, ev.y);
      else this.hooks.metricsKey?.(this, { kind: ev.kind === "wheel-down" ? "down" : "up" });
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
        const sorted = this.view.snapshot ? sortPrs(this.view.snapshot.prs) : [];
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
    // smart routing: a focused strip input owns every printable.
    if (this.strip?.focused) {
      this.handleStripKey(buf);
      return;
    }
    // `/` always focuses the strip input, on every tab.
    const raw = buf.toString("utf8");
    if (raw === "/" && this.strip?.available()) {
      this.strip.focus();
      this.repaint();
      return;
    }
    if (this.tab === "digest" && this.hooks.digestKey?.(this, key)) return;
    if (this.tab === "deploy" && this.hooks.deployKey?.(this, key)) return;
    if (this.tab === "metrics" && this.hooks.metricsKey?.(this, key)) return;
    // An unregistered printable is a message to the companion, not a dead
    // key: focus the strip input seeded with it (paste seeds whole).
    if (
      this.strip?.available() &&
      raw.length > 0 &&
      !raw.includes("\x1b") &&
      raw >= " " &&
      !(raw.length === 1 && registeredKeys(this.tab).has(raw))
    ) {
      this.strip.focus(raw);
      this.repaint();
      return;
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
      case "tab-deploy":
        this.tab = "deploy";
        break;
      case "tab-metrics":
        this.tab = "metrics";
        break;
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

  /** Open the companion full-screen (the strip's mirror rows, the
   * alert badge, an alert-armed ⏎). Following an alert clears its focus —
   * it has been acted on. */
  openCompanion(): void {
    this.view.alertFocus = false;
    if (!this.hooks.companionAttach) {
      this.notice("companion unavailable (started with --no-companion?)");
      return;
    }
    void this.hooks.companionAttach(this);
  }

  /** Strip input mode: printables + backspace edit, ⏎ sends+clears+blurs,
   * Esc clears+blurs. Everything routes through decodeInputKey, so verb
   * chars are text while the input owns the keyboard. */
  private handleStripKey(buf: Buffer): void {
    const strip = this.strip!;
    const key = decodeInputKey(buf);
    switch (key.kind) {
      case "char":
        strip.input += key.ch;
        break;
      case "backspace":
        strip.input = strip.input.slice(0, -1);
        break;
      case "escape":
        strip.blur();
        break;
      case "enter": {
        const text = strip.input.trim();
        strip.blur();
        if (text.length > 0) {
          void strip.send(text).catch((err: unknown) => this.notice(`✖ ${String(err instanceof Error ? err.message : err)}`));
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
    if (this.suspended || this.stopped) return;
    const cols = this.out.columns ?? 80;
    const rows = this.out.rows ?? 24;
    if (this.tab === "digest") {
      const screen = this.hooks.digestScreen?.(this, cols, rows);
      this.lastFrame = undefined;
      this.out.write(screen ?? `${CLEAR}digest tab lands in — [1] back to board`);
      return;
    }
    if (this.tab === "deploy") {
      const screen = this.hooks.deployScreen?.(this, cols, rows);
      this.lastFrame = undefined;
      this.out.write(screen ?? `${CLEAR}deploy tab not wired — [1] back to board`);
      return;
    }
    if (this.tab === "metrics") {
      const screen = this.hooks.metricsScreen?.(this, cols, rows);
      this.lastFrame = undefined;
      this.out.write(screen ?? `${CLEAR}metrics tab not wired — [1] back to board`);
      return;
    }
    this.view.now = this.now();
    const frame = renderBoard(this.view, cols, rows, this.strip?.view());
    this.lastFrame = frame;
    this.out.write(frame.render());
  }
}
