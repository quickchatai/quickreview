// The env shim for the companion's setup & scan belt: the one place the
// process's env and cwd become its config (extensions/setup.ts).
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createSetup } from "../setup.js";

export default function activate(pi: ExtensionAPI): void {
  void createSetup({ env: process.env, cwd: process.cwd() })(pi);
}
