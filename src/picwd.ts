// The entry of the two panes that run pi's interactive CLI on a PR's real JSONL (a
// takeover, src/takeoverpi.ts, and a bot debug round, src/debugroundpi.ts), so that
// pi runs in ITS OWN cwd whatever session it opens:
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
// cwd; src/engine/pisdk.ts `runPiCliInCwd` gives the CLI the same.
import { runPiCliInCwd } from "./engine/pisdk.js";

// Run only as the entry point, not when a test imports this file.
if (process.argv[1]?.endsWith("picwd.js")) {
  runPiCliInCwd(process.argv.slice(2), () => process.cwd()).catch((e: unknown) => {
    console.error(e instanceof Error ? (e.stack ?? e.message) : String(e));
    process.exit(1);
  });
}
