// Attach screen — the full-takeover embedded pi session per the
// attach-pane mockup: one status row on top, the session rendered
// verbatim below it, Ctrl-q the only intercepted input. The pty runs
// `ssh -tt … docker exec -it … tmux attach -t <session>`.
//
// node-pty is imported lazily by installAttachHooks so tests (and the plain
// CLI paths) never load the native module; AttachScreen itself takes an
// injectable spawner.
import type { App } from "./app.js";
import { CHORD_GRACE_MS, ChordScanner, TripleCtrlC } from "./chord.js";
import { BAD, OK, RESET, STRONG } from "./design.js";
import { rule, CLEAR } from "./paint.js";
import { attachArgv } from "./remote.js";
import { TermPane } from "./term.js";

/** pi 0.84.1's built-in dark theme paints tool panels green (#283228 success)
 * and blue (pending). Through the nested tmux the truecolor gets downgraded to
 * 256-color (48;5;22 green / 48;5;17 blue — observed live on the VM,
 * 2026-08-14), and on the operator's screen that reads as full-width color
 * flashes. Neutralize both encodings to the muted panel for already-running
 * sessions; fresh sessions (VM and companion alike) select the fleet muted
 * theme at source. Matches the codes standalone or inside compound SGRs. */
export function muteCompanionToolFlash(data: string): string {
  return data
    .replaceAll("\x1b[48;2;40;50;40m", "\x1b[48;2;32;35;42m")
    .replace(/48;5;(?:17|22)m/g, "48;5;235m");
}

/** pi's /copy emits OSC 52 (clipboard write). The embedded terminal emulator
 * swallows it, so /copy silently did nothing through the TUI. Extract every
 * complete OSC 52 sequence from the pty stream so the attach screen can replay
 * it on the REAL terminal. Sequences can split across pty chunks — a bounded
 * carry holds an unterminated candidate between feeds. */
export class Osc52Relay {
  private carry = "";

  feed(data: string): string[] {
    const s = this.carry + data;
    const out: string[] = [];
    const re = /\x1b\]52;[^\x07\x1b]*(?:\x07|\x1b\\)/g;
    let lastEnd = 0;
    for (let m = re.exec(s); m; m = re.exec(s)) {
      out.push(m[0]);
      lastEnd = m.index + m[0].length;
    }
    const tail = s.slice(lastEnd);
    const open = tail.lastIndexOf("\x1b]52;");
    if (open >= 0) {
      this.carry = tail.slice(open);
    } else {
      // The chunk may end mid-introducer ("\x1b", "\x1b]", …).
      this.carry = "";
      for (let k = 4; k > 0; k--) {
        if (tail.endsWith("\x1b]52;".slice(0, k))) {
          this.carry = tail.slice(tail.length - k);
          break;
        }
      }
    }
    if (this.carry.length > 262144) this.carry = ""; // runaway payload — drop
    return out;
  }
}

export interface PtyLike {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  onData(cb: (data: string) => void): void;
  onExit(cb: (ev: { exitCode: number }) => void): void;
}

/** argv is everything after `ssh`; the spawner owns the binary name. */
export type PtySpawner = (argv: string[], cols: number, rows: number) => PtyLike;

export type ConnState = "live" | "lost";

export function statusRow(session: string, prState: string | undefined, conn: ConnState, cols: number): string {
  const state = prState ? ` · ${prState}` : "";
  const connSeg = conn === "live" ? `${OK}▶ live${RESET}` : `${BAD}✖ lost — ⏎ retry · Ctrl-q/Ctrl-c board${RESET}`;
  return rule(cols, "┌", "┐", [`${STRONG}${session}${RESET}${state}`, connSeg, "Ctrl-q detach · Ctrl-c×3 kill tui"]);
}

const PAINT_INTERVAL_MS = 16;

export class AttachScreen {
  private pty: PtyLike | undefined;
  private pane: TermPane | undefined;
  private conn: ConnState = "live";
  private sawData = false;
  private done = false;
  private finish: (() => void) | undefined;
  private paintTimer: NodeJS.Timeout | undefined;
  private paintDirty = false;
  private chord = new ChordScanner();
  private chordTimer: NodeJS.Timeout | undefined;
  private killChord = new TripleCtrlC();
  private clip = new Osc52Relay();
  private readonly onKey = (buf: Buffer): void => this.handleKey(buf);
  private readonly onResize = (): void => this.propagateResize();

  constructor(
    private readonly session: string,
    private readonly app: App,
    private readonly spawn: PtySpawner,
    private readonly out: NodeJS.WriteStream = process.stdout,
    private readonly input: NodeJS.ReadStream = process.stdin,
    /**: the companion tab attaches a LOCAL container (`docker exec -it
     * … tmux attach`), so it supplies its own argv; the ssh path stays the
     * default. The spawner owns the binary either way. */
    private readonly argvOverride?: string[],
  ) {}

  /** Resolves when the user is back on the board. */
  run(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.finish = resolve;
      this.app.suspend();
      this.input.on("data", this.onKey);
      this.out.on("resize", this.onResize);
      this.out.write(CLEAR);
      this.connect();
    });
  }

  private size(): { cols: number; rows: number } {
    return { cols: this.out.columns ?? 80, rows: (this.out.rows ?? 24) - 1 }; // row 0 = status
  }

  private connect(): void {
    const { cols, rows } = this.size();
    this.conn = "live";
    this.sawData = false;
    this.pane = new TermPane(cols, rows);
    let stderrTail = "";
    try {
      this.pty = this.spawn(this.argvOverride ?? attachArgv(this.app.cfg, this.session), cols, rows);
    } catch (err) {
      this.bailToBoard(`attach ${this.session}: ${String(err)}`);
      return;
    }
    this.pty.onData((data) => {
      this.sawData = true;
      stderrTail = (stderrTail + data).slice(-200);
      for (const seq of this.clip.feed(data)) this.out.write(seq); // /copy → real clipboard
      this.pane?.write(muteCompanionToolFlash(data), () => this.schedulePaint());
    });
    this.pty.onExit(({ exitCode }) => {
      if (this.done) return;
      if (!this.sawData && exitCode !== 0) {
        // Died before showing anything: unknown/dead session or ssh failure —
        // one clear line and back to the board.
        this.bailToBoard(`attach ${this.session} failed: ${lastLine(stderrTail) || `exit ${exitCode}`}`);
        return;
      }
      this.conn = "lost";
      this.paintStatus();
    });
    this.paintStatus();
  }

  private schedulePaint(): void {
    this.paintDirty = true;
    if (this.paintTimer) return;
    this.paintTimer = setTimeout(() => {
      this.paintTimer = undefined;
      if (!this.paintDirty || this.done) return;
      this.paintDirty = false;
      this.paint();
    }, PAINT_INTERVAL_MS);
  }

  private mouseOn = false;

  private paint(): void {
    if (!this.pane) return;
    // Mouse passthrough: mirror the inner app's tracking mode onto the real
    // terminal — the emulator absorbs the enable/disable sequences, so we
    // re-issue them; the resulting reports are raw stdin bytes the chord
    // scanner forwards verbatim.
    const wants = this.pane.wantsMouse();
    if (wants !== this.mouseOn) {
      this.mouseOn = wants;
      this.out.write(wants ? "\x1b[?1000h\x1b[?1002h\x1b[?1006h" : "\x1b[?1006l\x1b[?1002l\x1b[?1000l");
    }
    this.out.write(this.pane.renderFrame(1));
    this.paintStatus(false);
  }

  private paintStatus(repositionCursor = true): void {
    const cols = this.out.columns ?? 80;
    const prState = this.prState();
    const save = repositionCursor ? "" : "\x1b7";
    const restore = repositionCursor ? "" : "\x1b8";
    this.out.write(`${save}\x1b[1;1H${statusRow(this.session, prState, this.conn, cols)}\x1b[0m${restore}`);
  }

  private prState(): string | undefined {
    const m = /^pr-(\d+)$/.exec(this.session);
    if (!m) return undefined;
    const pr = this.app.view.snapshot?.prs.find((p) => p.number === Number(m[1]));
    if (!pr) return undefined;
    const round = this.app.view.detail?.pr === pr.number ? this.app.view.detail.rounds.length : undefined;
    return `${pr.state}${round ? ` r${round}` : ""}`;
  }

  private handleKey(buf: Buffer): void {
    if (this.done) return;
    // The escape hatch outranks everything: a pty hung on a dead ssh (or an
    // interactive passphrase prompt gone wrong) must never trap the user.
    if (this.killChord.feed(buf)) {
      this.teardown();
      this.app.die();
      return;
    }
    if (this.conn === "lost") {
      const s = buf.toString("utf8");
      if (s === "\r" || s === "\n") {
        this.pty?.kill();
        this.pane?.dispose();
        this.out.write(CLEAR);
        this.connect();
      } else if (buf.length === 1 && (buf[0] === 0x11 || buf[0] === 0x03)) {
        this.detach(); // Ctrl-q or Ctrl-c: a dead session needs no chord
      }
      return;
    }
    const action = this.chord.feed(buf);
    if (action.disarm && this.chordTimer) {
      clearTimeout(this.chordTimer);
      this.chordTimer = undefined;
    }
    for (const chunk of action.forward) this.pty?.write(chunk.toString("binary"));
    if (action.detach) {
      this.detach();
      return;
    }
    if (action.arm) {
      this.chordTimer = setTimeout(() => {
        this.chordTimer = undefined;
        if (this.chord.armTimeout().detach) this.detach();
      }, CHORD_GRACE_MS);
    }
  }

  private propagateResize(): void {
    if (this.done) return;
    const { cols, rows } = this.size();
    this.pane?.resize(cols, rows);
    this.pty?.resize(cols, rows);
    this.schedulePaint();
  }

  private teardown(): void {
    this.done = true;
    if (this.mouseOn) {
      this.out.write("\x1b[?1006l\x1b[?1002l\x1b[?1000l");
      this.mouseOn = false;
    }
    if (this.paintTimer) clearTimeout(this.paintTimer);
    if (this.chordTimer) clearTimeout(this.chordTimer);
    this.input.off("data", this.onKey);
    this.out.off("resize", this.onResize);
    this.pty?.kill(); // clean pty teardown — no orphaned ssh children
    this.pty = undefined;
    this.pane?.dispose();
    this.pane = undefined;
  }

  detach(): void {
    if (this.done) return;
    this.teardown();
    this.app.resume();
    this.finish?.();
  }

  private bailToBoard(message: string): void {
    if (this.done) return;
    this.teardown();
    this.app.resume();
    this.app.notice(message);
    this.finish?.();
  }
}

function lastLine(s: string): string {
  const lines = s
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  return lines[lines.length - 1] ?? "";
}

/** Production wiring: node-pty behind the PtyLike seam. */
export async function installAttachHooks(app: App): Promise<void> {
  const { spawn } = await import("node-pty");
  const spawner: PtySpawner = (argv, cols, rows) => {
    const p = spawn("ssh", argv, { name: "xterm-256color", cols, rows, env: process.env as Record<string, string> });
    return {
      write: (data) => p.write(data),
      resize: (cols2, rows2) => p.resize(cols2, rows2),
      kill: () => {
        try {
          p.kill();
        } catch {
          /* already dead */
        }
      },
      onData: (cb) => p.onData(cb),
      onExit: (cb) => p.onExit(cb),
    };
  };
  app.hooks.attach = (session, theApp) => new AttachScreen(session, theApp, spawner, process.stdout, process.stdin).run();
}
