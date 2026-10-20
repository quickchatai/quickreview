// pi's interactive CLI, run in ITS OWN cwd whatever session it opens: the entry of
// the two panes that run interactive pi on a PR's real JSONL (a takeover,
// src/takeoverpi.ts, and a bot debug round, src/debugroundpi.ts).
//
//     node dist/src/picwd.js <pi's own argv>
//
// Why: pi's CLI opens `--session <file>` with the cwd its HEADER records
// (main.js createSessionManager -> SessionManager.open(path, sessionDir), no cwd
// override), and runs every tool there. A PR born by the legacy tmux bot carries
// the legacy tree's cwd (/opt/quickreview/sandbox), which the release container
// still has (the run spec's path-continuity mounts) but which holds no scripts/,
// no state/ and no verdict/. A pane started in the production tree's root then
// ran its bash in the legacy dir, so bash-guard refused every sanctioned script
// (the cwd was not the sandbox root) and a debug round could neither commit its
// verdict nor post. The SDK route already keeps a resumed session in the spec's
// cwd (src/engine/pisdk.ts, `SessionManager.open(file, dir, spec.cwd)`, the header
// on disk not rewritten); this gives the CLI the same: every open without an
// explicit cwd takes the process's own, the launcher's `cwd`.
//
// Everything else is pi's own `pi` binary: setupCli's four steps, then main().
import { main, SessionManager } from "@earendil-works/pi-coding-agent";
import { loadConfigureHttpDispatcher, piCliTitles } from "./engine/pisdk.js";

type Open = typeof SessionManager.open;

const PINNED = Symbol.for("qcr.picwd.pinned");

/** Make `SessionManager.open` default its cwd to `cwd()` instead of the session
 * header's. Idempotent. An explicit override (pi's own missing-cwd recovery)
 * still wins. VERIFY-ON-PIN: pi's CLI reaches the class's static `open` at call
 * time (tests/picwd.test.ts drives the real createSessionManager). */
export function pinSessionCwd(
  manager: { open: Open } = SessionManager,
  cwd: () => string = () => process.cwd(),
): void {
  const holder = manager as { open: Open; [PINNED]?: true };
  if (holder[PINNED]) return;
  const open = manager.open.bind(manager);
  holder.open = (path, sessionDir, cwdOverride) => open(path, sessionDir, cwdOverride ?? cwd());
  holder[PINNED] = true;
}

/** pi's `cli.js`: setupCli, then main, with the cwd pinned. */
export async function runPiInCwd(argv: string[]): Promise<void> {
  // setupCli (pi's cli/setup.js): the same title and flags, so the helpers that ask
  // "am I inside a CLI pi" (src/engine/pisdk.ts insideCliPi) answer as they would
  // in `pi`, and the same dispatcher.
  process.title = piCliTitles()[0]!;
  process.env["PI_CODING_AGENT"] = "true";
  process.env["AI_AGENT"] = "pi";
  process.emitWarning = () => {};
  (await loadConfigureHttpDispatcher())();
  pinSessionCwd();
  await main(argv);
}

// Run only as the entry point, not when a test imports pinSessionCwd.
if (process.argv[1]?.endsWith("picwd.js")) {
  runPiInCwd(process.argv.slice(2)).catch((e: unknown) => {
    console.error(e instanceof Error ? (e.stack ?? e.message) : String(e));
    process.exit(1);
  });
}
