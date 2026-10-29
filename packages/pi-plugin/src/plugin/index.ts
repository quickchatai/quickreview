// The pi plugin's entry, the file the package's `pi.extensions` names: the
// one place the process's environment, home and standard output become the
// plugin's config (extensions/quickreview.ts takes them as data), and where
// the process-wide resolve hook for pi's own packages is registered
// (src/plugin/peers.ts).
import { homedir } from "node:os";
import { createQuickReview } from "../../extensions/quickreview.js";
import { resolvePeersFrom } from "./peers.js";
import { nodeRunner } from "./runner.js";

const env = process.env;

export default createQuickReview({
  env,
  home: (env["HOME"] ?? "").trim() || homedir(),
  runner: nodeRunner(env),
  print: (text) => void process.stdout.write(text.endsWith("\n") ? text : `${text}\n`),
  peers: (piDir) => void resolvePeersFrom(piDir),
});
