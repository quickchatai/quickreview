// The env shim for the interactive pi's lens tools: the one place the process's
// env and cwd become their config (extensions/lens.ts).
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { interactiveHostFor, interactiveLens } from "../lens.js";

export default function activate(pi: ExtensionAPI): void {
  if (typeof pi.registerTool !== "function") {
    console.error("lens: pi.registerTool unavailable — lens and lens_wave not registered.");
    return;
  }
  const env = process.env;
  void interactiveLens(env, () => process.cwd(), interactiveHostFor(env))(pi);
}
