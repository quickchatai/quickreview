// The env shim for bash-guard: the one place the process's env and cwd become
// its config (extensions/bash-guard.ts). The env is read here, once, at
// activation.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { bashGuardConfigFromEnv, createBashGuard } from "../bash-guard.js";

export default function activate(pi: ExtensionAPI): void {
  void createBashGuard(bashGuardConfigFromEnv(process.env, process.cwd()))(pi);
}
