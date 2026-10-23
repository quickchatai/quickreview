// A detached review driver on the SDK runtime, as a stand-alone node process, for
// the tests that must see a real process end (src/reviewdetach.ts): the stop
// path (`qcr review stop` while a session is mid-turn) and the frozen loop the
// watchdog covers. It is the driver cmdReview starts, less everything that needs
// a model or a repository: runDetachedChild around an sdkRuntime session on
// pi-ai's faux provider, with the route marked as SDK. Zero LLM, no network.
//
// It imports the BUILT modules (the app's dist/src, the review core's
// packages/pi-plugin/dist/src), like the stub of the process-route orphan
// test, so a build comes first.
//
// Modes, by what the faux model does in its one turn:
//   ok      answers at once; the stub's process must then end by itself
//   hang    calls bash to run a long `sleep` (its pid in <dir>/bash-pid), then
//           waits for an abort
//   freeze  spins in a synchronous loop: nothing in the process runs again
//
// <dir>/exit-code holds the code the process exits with.
import { writeFileSync } from "node:fs";
import { join } from "node:path";

export type SdkStubMode = "ok" | "hang" | "freeze";

export function writeSdkDriverStub(dir: string): string {
  const stub = join(dir, "sdk-driver-stub.mjs");
  writeFileSync(
    stub,
    `import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
const [dir, key, mode, root, timeoutMs] = process.argv.slice(2);
process.on("exit", (c) => appendFileSync(join(dir, "exit-code"), String(c)));
const dist = join(root, "dist", "src");
const core = join(root, "packages", "pi-plugin", "dist", "src");
const load = (...p) => import(pathToFileURL(join(...p)).href);
const ai = await load(root, "node_modules", "@earendil-works", "pi-ai", "dist", "index.js");
const { runDetachedChild } = await load(dist, "reviewdetach.js");
const { PiHost } = await load(core, "engine", "pisdk.js");
const { sdkRuntime } = await load(core, "engine", "sdkruntime.js");
const { markSdkRoute } = await load(core, "engine", "livesessions.js");
markSdkRoute();
await runDetachedChild({
  dir,
  key,
  run: async () => {
    const faux = ai.fauxProvider({ provider: "faux", models: [{ id: "m" }] });
    faux.appendResponses([
      async (_context, options) => {
        if (mode === "freeze") for (;;) {}
        if (mode === "hang")
          return ai.fauxAssistantMessage(
            [ai.fauxToolCall("bash", { command: "echo $$ > " + join(dir, "bash-pid") + "; exec sleep 300" })],
            { stopReason: "toolUse" },
          );
        return ai.fauxAssistantMessage("done");
      },
    ]);
    const host = await PiHost.create({
      agentDir: join(dir, "agent"),
      ownsProcess: true,
      configureModels: (r) => {
        r.registerNativeProvider(faux.provider);
      },
    });
    const session = await sdkRuntime(host).create({
      cwd: dir,
      env: { PATH: process.env.PATH },
      model: "faux/m",
      eventsFile: join(dir, "events.jsonl"),
      stderrFile: join(dir, "stderr.log"),
      limits: { timeoutMs: Number(timeoutMs) },
    });
    const r = await session.prompt("go");
    await session.dispose();
    return r.code === 0 ? 0 : 1;
  },
});
`,
  );
  return stub;
}

/** The argv of the stub after its path. */
export const sdkStubArgs = (
  l: { dir: string; key: string },
  mode: SdkStubMode,
  root: string,
  timeoutMs = 600_000,
): string[] => [l.dir, l.key, mode, root, String(timeoutMs)];
