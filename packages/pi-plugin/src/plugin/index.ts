// The pi plugin's entry, the file the package's `pi.extensions` names: the
// one place the process's environment, home and standard output become the
// plugin's config (extensions/quickreview.ts takes them as data).
import { homedir } from "node:os";
import { createQuickReview } from "../../extensions/quickreview.js";
import { nodeRunner } from "./runner.js";

const env = process.env;

export default createQuickReview({
  env,
  home: (env["HOME"] ?? "").trim() || homedir(),
  runner: nodeRunner(env),
  print: (text) => void process.stdout.write(text.endsWith("\n") ? text : `${text}\n`),
});
