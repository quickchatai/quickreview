// `qcr tui [pr|overseer]` entry point. Wires the real ssh runner; the
// optional target becomes the deep link.
import { loadConfig } from "../config.js";
import { App } from "./app.js";
import { realSshRunner } from "./remote.js";

export function parseTarget(arg: string | undefined): { kind: "none" } | { kind: "pr"; pr: number } | { kind: "session"; session: string } | { kind: "bad"; reason: string } {
  if (arg === undefined || arg === "") return { kind: "none" };
  if (/^\d+$/.test(arg)) return { kind: "pr", pr: Number(arg) };
  if (arg === "overseer" || arg === "main") return { kind: "session", session: arg };
  return { kind: "bad", reason: `unknown target '${arg}' — expected a PR number, 'overseer', or 'main'` };
}

export async function runTui(targetArg?: string): Promise<void> {
  const target = parseTarget(targetArg);
  if (target.kind === "bad") {
    console.error(`qcr tui: ${target.reason}`);
    process.exitCode = 2;
    return;
  }
  if (!process.stdout.isTTY || !process.stdin.isTTY) {
    console.error("qcr tui needs an interactive terminal");
    process.exitCode = 2;
    return;
  }
  const cfg = loadConfig().tui;
  const app = new App(cfg, realSshRunner);
  await app.run(target.kind === "pr" ? target.pr : undefined);
}
