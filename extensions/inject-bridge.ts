// inject-bridge — the daemon→session wake channel (spec §4, brief B3 step 3).
//
// Modelled on pi's shipped examples/extensions/file-trigger.ts (findings §3
// option 2): fs.watch a directory, and on every new *.md file read it and
// hand the content to pi.sendUserMessage(), then move the file into .done/ so
// it can never fire twice. The daemon writes those files atomically
// (tmp + rename), so a watch event always sees a complete file.
//
// pi is not installed here — everything touching the pi API is VERIFY-ON-PIN.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, watch } from "node:fs";
import { basename, join } from "node:path";
import type { Pi } from "@earendil-works/pi-coding-agent";

/**
 * Session name resolution, in order:
 *   1. QCR_SESSION_NAME — set by the daemon in the env it constructs for the
 *      tmux/pi process. Deterministic, so the bridge never has to guess.
 *   2. pi.session?.name — // VERIFY-ON-PIN: accessor name and availability at
 *      session_start.
 *   3. "overseer" as the last resort (the only unnumbered session).
 */
export function resolveSessionName(pi: Pi, env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.QCR_SESSION_NAME?.trim();
  if (fromEnv) return fromEnv;
  const fromPi = typeof pi.session?.name === "string" ? pi.session.name.trim() : "";
  if (fromPi) return fromPi;
  return "overseer";
}

export function resolveInjectDir(pi: Pi, env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.QCR_INJECT_DIR?.trim();
  if (explicit) return explicit;
  const root = env.QCR_SANDBOX_ROOT?.trim() || process.cwd();
  return join(root, "inject", resolveSessionName(pi, env));
}

/** Pending *.md files, oldest name first (names are ISO timestamps). */
export function pendingFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .filter((f) => {
      try {
        return statSync(join(dir, f)).isFile();
      } catch {
        return false;
      }
    })
    .sort();
}

export const activate: (pi: Pi) => void = (pi) => {
  const dir = resolveInjectDir(pi);
  const doneDir = join(dir, ".done");
  const inFlight = new Set<string>();
  let watcher: ReturnType<typeof watch> | undefined;

  const deliver = async (file: string): Promise<void> => {
    const full = join(dir, file);
    if (inFlight.has(full) || !existsSync(full)) return;
    inFlight.add(full);
    try {
      const content = readFileSync(full, "utf8").trim();
      // Archive first: a crash mid-turn must not re-fire the same wake.
      mkdirSync(doneDir, { recursive: true });
      renameSync(full, join(doneDir, basename(full)));
      if (content.length === 0) return;
      // VERIFY-ON-PIN: sendUserMessage(content) — findings §3 option 2; it
      // always triggers a turn, which is exactly the wake semantics we want.
      await pi.sendUserMessage(content);
    } catch (err) {
      console.error(`[inject-bridge] failed to deliver ${file}: ${String(err)}`);
    } finally {
      inFlight.delete(full);
    }
  };

  const drain = async (): Promise<void> => {
    for (const file of pendingFiles(dir)) await deliver(file);
  };

  const start = (): void => {
    mkdirSync(dir, { recursive: true });
    mkdirSync(doneDir, { recursive: true });
    void drain(); // anything dropped while the session was down
    watcher = watch(dir, (_event, filename) => {
      if (!filename) {
        void drain();
        return;
      }
      const name = String(filename);
      if (name.endsWith(".md")) void deliver(name);
    });
    console.error(`[inject-bridge] watching ${dir}`);
  };

  // VERIFY-ON-PIN: "session_start" / "session_shutdown" event names (findings §5).
  pi.on("session_start", () => start());
  pi.on("session_shutdown", () => {
    watcher?.close();
    watcher = undefined;
  });
};

export default activate;
