// The env shim for the interactive pi's lens tools: the one place the process's
// env, cwd, home and stderr become their config (packages/pi-plugin/extensions/lens.ts).
import { homedir } from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  interactiveHostFor,
  interactiveLens,
} from "@quickchatai/pi-quickreview/extensions/lens.js";

export default function activate(pi: ExtensionAPI): void {
  if (typeof pi.registerTool !== "function") {
    console.error("lens: pi.registerTool unavailable — lens and lens_wave not registered.");
    return;
  }
  const env = process.env;
  void interactiveLens(
    env,
    () => process.cwd(),
    interactiveHostFor(env, homedir()),
    (line) => console.error(line),
  )(pi);
}
