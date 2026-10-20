// The env shim for the companion's tui-view extension: the one place the
// process's env and cwd become its config (extensions/tui-view.ts).
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createTuiView, resolveFeedDir } from "../tui-view.js";

export default function activate(pi: ExtensionAPI): void {
  void createTuiView({ feedDir: resolveFeedDir(process.env, process.cwd()) })(pi);
}
