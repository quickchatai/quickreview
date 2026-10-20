// The env shim for the debug round: the one place the process's env and cwd
// become its config (extensions/debug-round.ts).
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { activateDebugRound } from "../debug-round.js";

export default function activate(pi: ExtensionAPI): void {
  activateDebugRound(pi, process.env, process.cwd());
}
