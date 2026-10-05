// Starting setup (setup & scan spec "Setup entry"): `qcr setup` and
// the board's `I` key both focus the companion on its `setup` skill, and both
// carry out the profile commits setup asked for (src/setup/configcommit.ts).
//
// The ask travels as ONE inject file into the companion's own inject dir —
// the channel the rollover's day-open and the first-run interview already
// use, drained by the unmodified inject-bridge (on arrival when the companion
// runs, at its next start when it does not). It is the OPERATOR's act, taken
// with a key or a command, exactly like typing the request into the column:
// never ambient, never a synthetic turn the TUI decides to send on its own
// (the retired companion-wake stays retired).
import { mkdirSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { configHome, stateHome, type InstallEnv } from "../install.js";
import { processProfileCommits, type CommitResult } from "../setup/configcommit.js";

/** What the companion reads when setup is asked for. */
export const SETUP_REQUEST_TEXT = [
  "The owner asked to set up this repo for review (qcr setup).",
  "Load your `setup` skill (/workspace/skills/companion/setup/SKILL.md) and follow it from where setup stands now —",
  "start with `setup_profile`, then tell him in two or three lines what is done, what is next, and what it costs.",
].join("\n");

/** The inject file's name: an ISO stamp (the bridge drains oldest name
 * first, and this sorts after the same day's day-open), never a `.tmp`. */
export function setupRequestName(now: Date): string {
  return `${now.toISOString().replace(/[:.]/g, "-")}-setup.md`;
}

/** Drop the setup request into the companion's host inject dir (tmp+rename:
 * the bridge must never drain a torn file). Returns the file written — or
 * the request already waiting there: a second `I` (or `qcr setup`) before
 * the companion drained the first asks nothing new, so it queues nothing. */
export function requestSetup(opts: { injectDir: string; now?: Date }): string {
  mkdirSync(opts.injectDir, { recursive: true });
  const pending = readdirSync(opts.injectDir)
    .filter((f) => !f.startsWith(".") && f.endsWith("-setup.md"))
    .sort();
  if (pending.length > 0) return join(opts.injectDir, pending[0]!);
  return writeCompanionAsk({
    injectDir: opts.injectDir,
    suffix: "setup",
    text: SETUP_REQUEST_TEXT,
    now: opts.now,
  });
}

/** One operator ask into the companion's host inject dir, named by an ISO
 * stamp and `suffix` (the bridge drains oldest name first), written
 * tmp+rename. The same channel the setup request rides; the `[8] scan` tab's
 * promote, dismiss and delta asks use it too. Returns the file. */
export function writeCompanionAsk(opts: {
  injectDir: string;
  suffix: string;
  text: string;
  now?: Date;
}): string {
  const stamp = (opts.now ?? new Date()).toISOString().replace(/[:.]/g, "-");
  const name = `${stamp}-${opts.suffix}.md`;
  mkdirSync(opts.injectDir, { recursive: true });
  const target = join(opts.injectDir, name);
  const tmp = join(opts.injectDir, `.${name}.tmp`);
  writeFileSync(tmp, `${opts.text}\n`);
  renameSync(tmp, target);
  return target;
}

/** Carry out the commits setup asked for, in THIS machine's homes. Total: a
 * failure is a result, never a throw. */
export function commitRequestedProfiles(env: InstallEnv = process.env): CommitResult[] {
  try {
    return processProfileCommits({ stateHome: stateHome(env), configHome: configHome(env) });
  } catch (err) {
    return [{ id: "(all)", at: new Date().toISOString(), state: "failed", detail: String(err) }];
  }
}

/** One line per result, for a notice or the CLI. */
export function commitLine(r: CommitResult): string {
  return `profile commit ${r.id}: ${r.state}${r.sha ? ` ${r.sha.slice(0, 12)}` : ""} — ${r.detail}`;
}
