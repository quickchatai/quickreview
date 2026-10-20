// The env shim for the companion's inbox bridge: the one place the process's
// env and cwd become its config (extensions/inject-bridge.ts).
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createInjectBridge, injectBridgeConfigFromEnv } from "../inject-bridge.js";

export default function activate(pi: ExtensionAPI): void {
  void createInjectBridge(injectBridgeConfigFromEnv(pi, process.env, process.cwd()))(pi);
}
