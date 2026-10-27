// The env shim for the home's extension: the one place the process's env
// becomes its options (extensions/home.ts). A bare `qcr` loads it by path
// (src/home/launch.ts), with the model and tool set it launched on in the env.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { homeOptionsFromEnv } from "../../src/home/adapters.js";
import { homeSetupFromEnv } from "../../src/home/setupadapters.js";
import { createHome } from "../home.js";

export default function activate(pi: ExtensionAPI): void {
  void createHome({ ...homeOptionsFromEnv(process.env), setup: homeSetupFromEnv(process.env) })(pi);
}
