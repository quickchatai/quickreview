// `npm run smoke:session` — the scripted manual smoke for the daemon↔pi
// boundary (brief B3 step 7). It spawns a REAL tmux + pi session, injects a
// hello prompt through the inject-bridge, and greps the session JSONL for the
// agreed marker in the reply.
//
// pi is not installed on the build machine: this script is expected to bail
// with a clear message here and to be run inside the VM container, where the
// pinned pi lives. It is the only place in B3 that touches real processes.
import { existsSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, sandboxRoot } from "./config.js";
import { nodeExec } from "./tmux.js";
import { PiSessionManager } from "./sessions.js";

const MARKER = "QCR-SMOKE-OK";
const TIMEOUT_MS = 180_000;
const POLL_MS = 2_000;

const SYSTEM_PROMPT = [
  "# Smoke session",
  "",
  "You are a throwaway smoke-test session for the review sandbox.",
  "Do not read, write, or modify any files. Do not run any commands.",
  `When you receive any message, reply with exactly one line: ${MARKER}`,
  "",
].join("\n");

async function have(bin: string, args: string[]): Promise<string | undefined> {
  try {
    const res = await nodeExec(bin, args, { timeoutMs: 15_000 });
    return res.code === 0 ? res.stdout.trim() : undefined;
  } catch {
    return undefined;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function main(): Promise<number> {
  const cfg = loadConfig();
  const root = sandboxRoot();

  const piVersion = await have("pi", ["--version"]);
  if (piVersion === undefined) {
    console.error(
      "pi not installed — smoke requires the VM container.\n" +
        `Run it there: docker exec -it quickreview npm run smoke:session (pinned ${cfg.pi.package}@${cfg.pi.version}).`,
    );
    return 2;
  }
  if (!piVersion.includes(cfg.pi.version)) {
    console.error(
      `pi version drift: found "${piVersion}", config pins ${cfg.pi.version}. The image never floats — aborting.`,
    );
    return 3;
  }
  if ((await have("tmux", ["-V"])) === undefined) {
    console.error("tmux not installed — smoke requires the VM container.");
    return 2;
  }

  const session = `smoke-${Date.now()}`;
  const mgr = new PiSessionManager({ cfg, root });
  console.log(`[smoke] spawning tmux session ${session} (model ${cfg.models.conversation})`);
  await mgr.spawnSession(session, SYSTEM_PROMPT, cfg.models.conversation);
  const injected = mgr.injectFile(session, `Hello from the smoke test. Reply with the marker.\n`);
  console.log(`[smoke] injected ${injected}`);

  const deadline = Date.now() + TIMEOUT_MS;
  let found = false;
  let jsonl: string | undefined;
  while (Date.now() < deadline && !found) {
    await sleep(POLL_MS);
    jsonl = mgr.newestSessionFile(session);
    if (jsonl && existsSync(jsonl)) found = readFileSync(jsonl, "utf8").includes(MARKER);
  }

  console.log(`[smoke] session file: ${jsonl ?? "(none found)"}`);
  await mgr.tmux.killSession(session);
  rmSync(mgr.sessionDir(session), { recursive: true, force: true });
  rmSync(mgr.injectDir(session), { recursive: true, force: true });
  rmSync(mgr.promptPath(session), { force: true });

  if (!found) {
    console.error(`[smoke] FAIL — ${MARKER} not found in the session JSONL within ${TIMEOUT_MS / 1000}s`);
    return 1;
  }
  console.log("[smoke] PASS — injection reached pi and the reply landed in the session JSONL");
  return 0;
}

const entry = process.argv[1] ? resolve(process.argv[1]) : "";
if (entry && fileURLToPath(import.meta.url) === entry) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error(`[smoke] error: ${String(err)}`);
      process.exit(1);
    },
  );
}
