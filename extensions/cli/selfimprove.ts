// The env shim for the app's /selfimprove (extensions/selfimprove.ts): the
// one place the process's env, home and standard output become its config.
// `qcr pi` loads this file beside the plugin.
import { homedir } from "node:os";
import { VERSION, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { nodeRunner } from "@quickchatai/pi-quickreview/src/plugin/runner.js";
import { createSelfImprove } from "../selfimprove.js";

export default function activate(pi: ExtensionAPI): void {
  const env = process.env;
  createSelfImprove({
    env,
    home: (env["HOME"] ?? "").trim() || homedir(),
    runner: nodeRunner(env),
    print: (text) => void process.stdout.write(text.endsWith("\n") ? text : `${text}\n`),
    piVersion: VERSION,
  })(pi);
}
