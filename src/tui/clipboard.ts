// Host-side clipboard sink for OSC 52 payloads. Forwarding the escape to the
// real terminal only works where the emulator implements OSC 52 — Konsole and
// stock VTE ignore it, so a tmux mouse-drag copy (set-clipboard on) or pi's
// /copy would reach the operator's screen and evaporate. The sink decodes the
// payload and writes it into the system clipboard through the first CLI that
// works; on a bare KDE box that is klipper's D-Bus method (no extra package).
import { spawn } from "node:child_process";

/** Run `cmd argv…`, optionally piping `stdin`; true = exit 0. Never throws —
 * a missing binary (ENOENT) is just `false`, the probe moves on. */
export type CmdRunner = (cmd: string, argv: string[], stdin?: string) => Promise<boolean>;

export const defaultRunner: CmdRunner = (cmd, argv, stdin) =>
  new Promise((resolve) => {
    let p;
    try {
      p = spawn(cmd, argv, {
        stdio: [stdin === undefined ? "ignore" : "pipe", "ignore", "ignore"],
      });
    } catch {
      resolve(false);
      return;
    }
    p.on("error", () => resolve(false));
    p.on("close", (code) => resolve(code === 0));
    if (stdin !== undefined && p.stdin) {
      p.stdin.on("error", () => {});
      p.stdin.end(stdin);
    }
  });

interface Writer {
  cmd: string;
  argv: string[];
  /** stdin: text piped in; arg: text appended as the final argument. */
  mode: "stdin" | "arg";
}

/** Probe order: the dedicated tools first, klipper's D-Bus method as the
 * KDE fallback (qdbus6 is the Arch/Qt6 name, qdbus the compat shim). */
const WRITERS: Writer[] = [
  { cmd: "wl-copy", argv: [], mode: "stdin" },
  { cmd: "xclip", argv: ["-selection", "clipboard"], mode: "stdin" },
  { cmd: "xsel", argv: ["--input", "--clipboard"], mode: "stdin" },
  { cmd: "pbcopy", argv: [], mode: "stdin" },
  { cmd: "qdbus6", argv: ["org.kde.klipper", "/klipper", "setClipboardContents"], mode: "arg" },
  { cmd: "qdbus", argv: ["org.kde.klipper", "/klipper", "setClipboardContents"], mode: "arg" },
];

/** Decode the text carried by one complete OSC 52 sequence; undefined for
 * queries (`?` payload), empty payloads, and non-52 sequences. */
export function osc52Text(seq: string): string | undefined {
  const m = /^\x1b\]52;[^;]*;([\s\S]*?)(?:\x07|\x1b\\)$/.exec(seq);
  if (!m) return undefined;
  const payload = m[1]!;
  if (payload === "" || payload === "?") return undefined;
  const text = Buffer.from(payload, "base64").toString("utf8");
  return text.length > 0 ? text : undefined;
}

export class ClipboardSink {
  /** Index of the writer that last worked; probed lazily on first write. */
  private cached: number | undefined;

  constructor(private readonly run: CmdRunner = defaultRunner) {}

  /** Write `text` to the system clipboard; false = no writer available. */
  async write(text: string): Promise<boolean> {
    if (text.length === 0) return false;
    if (this.cached !== undefined) {
      if (await this.attempt(WRITERS[this.cached]!, text)) return true;
      this.cached = undefined; // tool went away — full re-probe below
    }
    for (let i = 0; i < WRITERS.length; i++) {
      if (await this.attempt(WRITERS[i]!, text)) {
        this.cached = i;
        return true;
      }
    }
    return false;
  }

  private attempt(w: Writer, text: string): Promise<boolean> {
    return w.mode === "stdin" ? this.run(w.cmd, w.argv, text) : this.run(w.cmd, [...w.argv, text]);
  }
}
