import { judgeSessionSpec } from "../../src/bench/runner.js";
import { piCliArgv } from "./pi-cli-runtime.js";

/** The pi argv the defect judge's session would run as a CLI process (`-p`
 * last, the prompt on stdin): the judge spec rendered as pi flags, for the
 * tests that hold its context exposure to account. */
export function judgePiArgv(root: string, model: string): string[] {
  return [
    ...piCliArgv(
      judgeSessionSpec(root, model, {
        cwd: "",
        env: {},
        eventsFile: "",
        stderrFile: "",
        limits: { timeoutMs: 0 },
      }),
    ),
    "-p",
  ];
}
