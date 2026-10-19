// Entry point of the login refresher: `node dist/src/loginrefresh/main.js`,
// spawned and supervised by the daemon (supervisor.ts) by path. Configured by
// env, so this process reads no config.toml:
//
//   QCR_LOGIN_AGENT_DIR   pi's agent dir (default $PI_CODING_AGENT_DIR, else ~/.pi/agent)
//   QCR_LOGIN_MARGIN_MIN  the refresh margin beyond pi's window, in minutes
//   QCR_LOGIN_GID         the login group a new file is given (default: auth.json's)
//
// Exit 75: another refresher holds the lock (the supervisor backs off).
import { homedir } from "node:os";
import { join } from "node:path";
import { LOCK_HELD_EXIT, LoginLockHeld } from "./lock.js";
import { piOAuthRefresh } from "./pirefresh.js";
import { LoginRefresher } from "./refresher.js";

const log = (msg: string, extra?: unknown): void => {
  const tail =
    extra === undefined ? "" : ` ${extra instanceof Error ? extra.message : JSON.stringify(extra)}`;
  console.log(`${msg}${tail}`);
};

const agentDir =
  process.env["QCR_LOGIN_AGENT_DIR"]?.trim() ||
  process.env["PI_CODING_AGENT_DIR"]?.trim() ||
  join(process.env["HOME"]?.trim() || homedir(), ".pi", "agent");
const marginMin = Number(process.env["QCR_LOGIN_MARGIN_MIN"] ?? "90");
const gid = Number(process.env["QCR_LOGIN_GID"] ?? "");

try {
  const refresher = await LoginRefresher.start({
    agentDir,
    refresh: piOAuthRefresh,
    marginMs: (Number.isFinite(marginMin) && marginMin > 0 ? marginMin : 90) * 60_000,
    gid: Number.isInteger(gid) && gid > 0 ? gid : undefined,
    log,
  });
  log(`login refresh: up — owns ${join(agentDir, "auth.json")}`);
  let stopping = false;
  const shutdown = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    log(`login refresh: ${signal} — stopping`);
    void refresher.stop().finally(() => process.exit(0));
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
  void refresher.lost.then((why) => {
    if (stopping || !why) return;
    log(`login refresh: ${why} — exiting so the supervisor starts a clean one`);
    process.exit(1);
  });
} catch (err) {
  if (err instanceof LoginLockHeld) {
    log(`login refresh: ${err.message} — refusing to start`);
    process.exit(LOCK_HELD_EXIT);
  }
  log("login refresh: could not start", err);
  process.exit(1);
}
