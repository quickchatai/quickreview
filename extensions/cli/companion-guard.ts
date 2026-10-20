// The env shim for companion-guard: the one place the process's env and cwd
// become its config (extensions/companion-guard.ts).
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { companionGuardConfigFromEnv, createCompanionGuard } from "../companion-guard.js";

export default function activate(pi: ExtensionAPI): void {
  void createCompanionGuard(companionGuardConfigFromEnv(process.env, process.cwd()))(pi);
}
