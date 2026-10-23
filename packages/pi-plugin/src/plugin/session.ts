// What the plugin's commands need of the pi session they run in and of the
// machine around it, by shape. The extension (extensions/quickreview.ts)
// builds these from pi's command context; tests hand in fakes. Nothing in
// src/plugin/ imports pi itself.
import type { HostAuth } from "./login.js";

/** The session's ways to reach the person. */
export interface SessionUi {
  /** pi's mode: "tui" (the terminal UI), "rpc" (a client draws the dialogs),
   * "json" or "print" (no dialogs). */
  mode: "tui" | "rpc" | "json" | "print";
  /** Dialogs can be shown (tui and rpc). */
  interactive: boolean;
  /** Pick one of `options`; undefined when dismissed or stopped. */
  select(title: string, options: string[], signal?: AbortSignal): Promise<string | undefined>;
  confirm(title: string, message: string, signal?: AbortSignal): Promise<boolean>;
  notify(message: string, level: "info" | "warning" | "error"): void;
  /** The footer line while a command runs; undefined clears it. */
  status(text: string | undefined): void;
  /** Esc pressed while a command runs (tui only); returns the unsubscribe. */
  onEscape(handler: () => void): () => void;
  /** Show markdown in the session, as a message of the plugin's own. */
  show(markdown: string, details?: unknown): void;
  /** Hand the user's agent a message as the user (it starts a turn). */
  tellAgent(text: string): void;
  /** Write to standard output (print mode's result). */
  print(text: string): void;
}

/** A finished child process. */
export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs a program; `null` from `which` when it is not on PATH. */
export interface Runner {
  which(cmd: string): string | null;
  run(
    cmd: string,
    args: readonly string[],
    o: { cwd: string; env?: Readonly<Record<string, string | undefined>>; signal?: AbortSignal },
  ): Promise<RunResult>;
}

/** The machine and the host pi, as the host entry resolved them. */
export interface PluginHost {
  /** The repo the person is in (pi's cwd). */
  cwd: string;
  /** The process environment, read once by the host entry. */
  env: NodeJS.ProcessEnv;
  /** The user's home. */
  home: string;
  /** The running pi's version. */
  piVersion: string;
  /** The host pi's agent dir: its login, read and never written. */
  agentDir: string;
  auth: HostAuth;
  runner: Runner;
  /** Aborts when the pi session ends. */
  shutdown: AbortSignal;
}
