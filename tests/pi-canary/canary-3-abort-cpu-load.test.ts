// Canary 3 : abort under CPU load kills the bash children too.
//
// A budget or deadline abort is the last line of defence against a runaway
// lens. pi's bash tool must take the shell AND its background descendants down
// with it, even when every core is busy and the event loop is slow. The shell
// below leaves a background `sleep` and a backgrounded subshell with its own
// sleep, the shapes that survive a naive kill of the top shell only.
//
// The test spawns real processes through pi's bash tool, so it is listed in
// PROCESS_SUITES (tests/helpers/suite-timeouts.ts).
import { readFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { type Rig, createRig, useOfflineGuard, waitFor } from "./harness.js";

useOfflineGuard();

let rig: Rig;
let burners: Worker[] = [];

beforeEach(async () => {
  rig = await createRig();
});

afterEach(async () => {
  await Promise.all(burners.map((w) => w.terminate()));
  burners = [];
  rig.close();
});

/** One busy-loop thread per core, bounded so a crashed test cannot leave them spinning. */
function burnAllCores(): void {
  const spin = "const end = Date.now() + 30000; while (Date.now() < end) {}";
  burners = Array.from({ length: availableParallelism() }, () => new Worker(spin, { eval: true }));
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  // A zombie still answers signal 0; its state letter is the truth.
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3) !== "Z";
  } catch {
    return false;
  }
}

describe("[canary 3] abort under CPU load", () => {
  it("settles the prompt and leaves no bash descendant alive", async () => {
    const pidFile = join(rig.dir, "pids");
    const command = [
      `echo $$ > ${pidFile}`,
      `sleep 300 & echo $! >> ${pidFile}`,
      `(sleep 301 & echo $! >> ${pidFile}; wait) &`,
      `wait`,
    ].join("\n");
    rig.faux.setResponses([
      fauxAssistantMessage([fauxToolCall("bash", { command })], { stopReason: "toolUse" }),
      fauxAssistantMessage("unreachable after abort"),
    ]);
    const session = await rig.open({ tools: ["bash"] });
    let toolRunning = false;
    session.subscribe((e) => {
      if (e.type === "tool_execution_start") toolRunning = true;
    });

    burnAllCores();
    const prompt = session.prompt("run the long command").then(
      () => "settled",
      () => "rejected",
    );
    await waitFor(() => toolRunning, 10_000, "the bash tool to start");
    // The tool is "running" a beat before the shell has written its pids.
    const pids = (): number[] => {
      try {
        return readFileSync(pidFile, "utf8").split("\n").filter(Boolean).map(Number);
      } catch {
        return [];
      }
    };
    await waitFor(() => pids().length === 3, 10_000, "the shell to record its three pids");
    const spawned = pids();
    expect(spawned.every(alive), "all three are running before the abort").toBe(true);

    const t0 = Date.now();
    await session.abort();
    expect(Date.now() - t0, "abort returned promptly even with every core busy").toBeLessThan(
      10_000,
    );
    await prompt;
    expect(session.isStreaming).toBe(false);

    await waitFor(() => spawned.every((p) => !alive(p)), 10_000, "every bash descendant to exit");
    // The second scripted response was never requested: the run ended at abort.
    expect(rig.faux.state.callCount).toBe(1);
  });
});
