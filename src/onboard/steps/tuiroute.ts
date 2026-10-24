// The TUI's own route, checked by the layered verification.
//
// The containers being up and the daemon answering /health prove the stack;
// they do not prove that `qcr tui`, opened right after the wizard, can READ
// it. The TUI reads status.json its own way — the [tui] block, resolved by
// src/tui/route.ts, through `runnerFor` (local docker, or ssh to the VM) — so
// this check runs exactly that: the same resolution, the same argv
// (`statusArgv`), the same runner, and it needs a status.json that parses.
// A red check here is the board that would open on "✖ unreachable".
import { loadConfig, type TuiConfig } from "../../config.js";
import { runnerFor, statusArgv, transportOf, type SshRunner } from "../../tui/remote.js";
import { readRouteFacts, resolveTuiRoute, type RouteFacts } from "../../tui/route.js";
import { sandboxRoot, type CheckResult, type StepContext } from "../engine.js";

export const TUI_ROUTE_CHECK = "tui-route";

export interface TuiRouteCheckOptions {
  /** The runner for a resolved route; default `runnerFor` (spawns docker/ssh). */
  runner?: (cfg: TuiConfig) => SshRunner;
  /** Route facts that override what is read from the sandbox root. */
  facts?: Partial<RouteFacts>;
  /** Attempts while status.json is not written yet (a daemon just booted). */
  attempts?: number;
  intervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

function firstLine(text: string): string {
  return (
    text
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l !== "") ?? ""
  );
}

/** Total: every outcome is a check, never a throw. */
export async function tuiRouteCheck(
  ctx: StepContext,
  opts: TuiRouteCheckOptions = {},
): Promise<CheckResult> {
  if (ctx.adapters.host.inContainer) {
    return {
      name: TUI_ROUTE_CHECK,
      ok: true,
      detail:
        "not checked here — this wizard runs inside the image, and the TUI runs on the host: open `qcr tui` there",
    };
  }
  let tui: TuiConfig;
  try {
    tui = loadConfig(ctx.adapters.paths.configPath).tui;
  } catch (err) {
    return {
      name: TUI_ROUTE_CHECK,
      ok: false,
      detail: `config.toml does not load, so the TUI could not start either: ${String(err instanceof Error ? err.message : err)}`,
    };
  }
  const route = resolveTuiRoute(tui, {
    ...readRouteFacts(sandboxRoot(ctx.adapters.paths)),
    ...opts.facts,
  });
  if (route.unconfigured !== undefined)
    return {
      name: TUI_ROUTE_CHECK,
      ok: false,
      detail: `${route.unconfigured} — Fix: run the config_fill step again`,
    };
  const cfg = route.cfg;
  const run = (opts.runner ?? runnerFor)(cfg);
  const argv = statusArgv(cfg);
  const where =
    transportOf(cfg) === "local"
      ? `local docker, container ${cfg.container}`
      : `ssh ${cfg.ssh_host}`;
  const attempts = Math.max(1, opts.attempts ?? 4);
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let last = "";
  for (let i = 1; i <= attempts; i++) {
    let res;
    try {
      res = await run(cfg.ssh_host, argv, { timeoutMs: 15_000 });
    } catch (err) {
      res = { ok: false, stdout: "", stderr: String(err), code: null };
    }
    if (res.ok) {
      try {
        const parsed = JSON.parse(res.stdout) as unknown;
        if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
          const prs = (parsed as { prs?: unknown }).prs;
          return {
            name: TUI_ROUTE_CHECK,
            ok: true,
            detail:
              `the TUI's own read works (${where}: \`${argv.join(" ")}\`) — status.json parses` +
              `${Array.isArray(prs) ? `, ${prs.length} PR${prs.length === 1 ? "" : "s"} on the board` : ""}`,
          };
        }
        last = "status.json is not a JSON object";
      } catch {
        last = "status.json is not valid JSON";
      }
    } else {
      last = firstLine(res.stderr) || `exit ${String(res.code)}`;
    }
    if (i < attempts) await sleep(opts.intervalMs ?? 5_000);
  }
  return {
    name: TUI_ROUTE_CHECK,
    ok: false,
    detail:
      `the TUI could not read status.json the way it will (${where}: \`${argv.join(" ")}\`): ${last} — Fix: ` +
      (transportOf(cfg) === "local"
        ? "the [tui] container must be the running daemon container and remote_state_dir its state dir " +
          "(run the config_fill step again to rewrite both)"
        : `\`ssh ${cfg.ssh_host} true\` must work without a prompt, and remote_state_dir must be the VM's state dir`),
  };
}
