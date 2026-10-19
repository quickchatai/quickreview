// P2.5: the runtime port's contract suite, run on procRuntime over a fake pi
// script (no model, no real pi). The cases live in tests/helpers/port-contract.ts
// and are written against a PortHarness, so the in-process SDK runtime joins by
// adding a harness here and one portContract() call. What only a pi child has
// (respawn on follow-up, the process group, the argv) is tested after the
// shared cases, under the process runtime's own name.
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RuntimeUnsupportedError } from "../src/engine/port.js";
import { procRuntime } from "../src/engine/procruntime.js";
import {
  pollUntil,
  portContract,
  type Behaviour,
  type PortHarness,
} from "./helpers/port-contract.js";

const STREAM = resolve(import.meta.dirname, "fixtures", "engine-proc", "pi-stdout.jsonl");
const BIN = (dir: string): string => join(dir, "fake-pi");
const DELIVERED = (dir: string): string => join(dir, "delivered.log");
const CALLS = (dir: string): string => join(dir, "calls.log");
const CHILD_PID = (dir: string): string => join(dir, "child.pid");

const MESSAGE_END = (usd: number): string =>
  JSON.stringify({
    type: "message_end",
    message: { role: "assistant", usage: { cost: { total: usd } } },
  });

/** What the fake pi does after it has logged its turn. */
const BODIES: Record<Behaviour, (dir: string) => string> = {
  stream: () => `cat ${JSON.stringify(STREAM)}\necho "pi: warning fixture" >&2`,
  echo: () => `echo '{"type":"agent_end"}'`,
  slow: () => `sleep 0.5\necho '{"type":"agent_end"}'`,
  hang: (dir) => `sleep 60 &\necho $! > ${JSON.stringify(CHILD_PID(dir))}\nwait`,
  spendy: () => `for i in 1 2 3; do echo '${MESSAGE_END(0.4)}'; sleep 0.3; done\nsleep 60 &\nwait`,
  separators: () => `printf '{"type":"sep","t":"a\\342\\200\\250b\\342\\200\\251c"}\\n'`,
};

/** A pi that logs its argv and the turn's message (stdin on the first turn, the
 * last argument on a `--continue` respawn), then plays the behaviour. */
function writeFakePi(dir: string, behaviour: Behaviour): string {
  const bin = BIN(dir);
  writeFileSync(
    bin,
    [
      "#!/bin/sh",
      `echo "$*" >> ${JSON.stringify(CALLS(dir))}`,
      `case " $* " in *" --continue "*) for a; do msg="$a"; done;; *) msg="$(cat)";; esac`,
      `printf '%s\\n' "$msg" >> ${JSON.stringify(DELIVERED(dir))}`,
      BODIES[behaviour](dir),
      "",
    ].join("\n"),
  );
  chmodSync(bin, 0o755);
  return bin;
}

const proc: PortHarness = {
  name: "procRuntime",
  steer: "unsupported",
  resume: "unsupported",
  agentsFiles: "unsupported",
  runtime: (dir, behaviour) => procRuntime({ bin: writeFakePi(dir, behaviour) }),
  delivered: (dir) =>
    existsSync(DELIVERED(dir)) ? readFileSync(DELIVERED(dir), "utf8").split("\n").slice(0, -1) : [],
};

portContract(proc);

describe("[procRuntime] what is its own", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "port-contract-proc-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const spec = (over = {}) => ({
    cwd: dir,
    env: { PATH: process.env["PATH"] },
    model: "m",
    eventsFile: join(dir, "events.jsonl"),
    stderrFile: join(dir, "stderr.log"),
    limits: { timeoutMs: 20_000 },
    ...over,
  });
  const open = async (b: Behaviour, over = {}) => proc.runtime(dir, b).create(spec(over));

  it("respawns pi with --continue for a follow-up: the prompt rides stdin, the follow-up's text rides argv", async () => {
    const s = await open("echo", { sessionDir: join(dir, "session") });
    await s.prompt("the order");
    await s.followUp("finish up");
    await s.dispose();
    const [first, second] = readFileSync(CALLS(dir), "utf8").trim().split("\n");
    expect(first).toMatch(/ -p$/);
    expect(first).not.toContain("--continue");
    expect(second).toMatch(/ --continue -p finish up$/);
    expect(proc.delivered(dir)).toEqual(["the order", "finish up"]);
  });

  it("takes one prompt per session: the next message is a follow-up", async () => {
    const s = await open("echo");
    await s.prompt("one");
    await expect(s.prompt("two")).rejects.toBeInstanceOf(RuntimeUnsupportedError);
    await s.dispose();
  });

  it("takes the process group with it on abort, so no lens child is orphaned", async () => {
    const s = await open("hang");
    const turn = s.prompt("p");
    await pollUntil(
      () => existsSync(CHILD_PID(dir)) && readFileSync(CHILD_PID(dir), "utf8").trim() !== "",
      "the child",
    );
    const child = Number(readFileSync(CHILD_PID(dir), "utf8"));
    expect(() => process.kill(child, 0)).not.toThrow();
    await s.abort();
    await turn;
    await pollUntil(() => {
      try {
        process.kill(child, 0);
        return false;
      } catch {
        return true;
      }
    }, "the child to be gone");
    await s.dispose();
  });
});
