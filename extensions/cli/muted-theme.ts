// The shim pi loads for the fleet muted theme (extensions/muted-theme.ts). It
// reads nothing from the process; it exists so every extension pi loads by
// path lives under extensions/cli/.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createMutedTheme } from "../muted-theme.js";

export default function activate(pi: ExtensionAPI): void {
  void createMutedTheme()(pi);
}
