// The board's `u` key (#5362) — the one write action the board has beyond
// wakes. Every ssh call is faked; nothing spawns.
//
// What the tests pin, in order of what would hurt most if it regressed:
//   1. the payload is a fixed shape the daemon's whitelist already accepts,
//      and the request never reaches a shell command line;
//   2. the operator sees the DAEMON's answer, not the write's — a refusal is
//      a real outcome and must not read as success;
//   3. the channel cannot produce anything but the two whitelisted commands.
import { describe, expect, it } from "vitest";
import type { TuiConfig } from "../src/config.js";
import {
  CommandFileSender,
  commandPayload,
  commandResultArgv,
  commandWriteArgv,
  type UnwedgeState,
} from "../src/tui/unwedge.js";
import type { RemoteResult, SshRunner } from "../src/tui/remote.js";

const cfg = {
  ssh_host: "my-vm",
  container: "quickreview-sandbox",
  sudo_docker: true,
  remote_sandbox_root: "/opt/quickreview/sandbox",
  remote_state_dir: "/opt/quickreview/state",
  msg_timeout_s: 30,
} as unknown as TuiConfig;

const NOW = new Date("2026-08-21T15:00:00.000Z");

/** An ssh runner that records calls and answers the result probe from a queue. */
function runner(results: string[]): { ssh: SshRunner; calls: Array<{ argv: string[]; stdin?: string }> } {
  const calls: Array<{ argv: string[]; stdin?: string }> = [];
  const ssh: SshRunner = async (_host, argv, opts) => {
    calls.push({ argv, ...(opts?.stdin !== undefined ? { stdin: opts.stdin } : {}) });
    const isProbe = argv.some((a) => a.includes("result.json"));
    const stdout = isProbe ? (results.shift() ?? "pending") : "";
    return { ok: true, stdout, stderr: "", code: 0 } satisfies RemoteResult;
  };
  return { ssh, calls };
}

function sender(ssh: SshRunner): CommandFileSender {
  return new CommandFileSender(cfg, ssh, () => NOW, async () => {});
}

function track(): { states: Array<[UnwedgeState, string]>; on: (s: UnwedgeState, l: string) => void } {
  const states: Array<[UnwedgeState, string]> = [];
  return { states, on: (s, l) => states.push([s, l]) };
}

describe("the unwedge command channel", () => {
  it("writes ONE fixed-shape command the daemon whitelist already accepts", () => {
    // The payload is built here, never taken from a caller, so this module
    // cannot produce a command the whitelist does not know.
    expect(JSON.parse(commandPayload("rerun-round", 5362))).toEqual({ command: "rerun-round", pr: 5362 });
    expect(JSON.parse(commandPayload("restart-session", 42))).toEqual({ command: "restart-session", pr: 42 });
  });

  it("sends the payload on STDIN and writes atomically — nothing reaches the command line", async () => {
    const { ssh, calls } = runner(['{"ok":true}']);
    const t = track();
    await sender(ssh).send("rerun-round", 5362, t.on);

    const write = calls[0]!;
    // The request rides stdin; the argv carries only the path shape.
    expect(write.stdin).toBe(commandPayload("rerun-round", 5362));
    expect(write.argv.join(" ")).not.toContain("5362");
    // tmp+mv, so the watcher never sees a half-written file — into the
    // OPERATOR directory, never the session dir beside it.
    const script = write.argv[write.argv.length - 1]!;
    expect(script).toContain("/opt/quickreview/sandbox/commands/operator/.");
    expect(script).not.toContain("/opt/quickreview/sandbox/commands/.");
    expect(script).toContain(".tmp' && mv ");
  });

  it("reports the DAEMON's answer, not the write's — a refusal is not a success", async () => {
    const { ssh } = runner(['{"ok":false,"reason":"tier: refused"}']);
    const t = track();
    await sender(ssh).send("rerun-round", 77, t.on);

    expect(t.states.map(([s]) => s)).toEqual(["pending", "failed"]);
    expect(t.states[1]![1]).toContain("refused");
    expect(t.states[1]![1]).toContain("tier: refused");
  });

  it("surfaces how many rounds the daemon actually cancelled", async () => {
    const { ssh } = runner(['{"ok":true,"requeued":5362,"cancelled_rounds":[851]}']);
    const t = track();
    await sender(ssh).send("rerun-round", 5362, t.on);

    expect(t.states[1]![0]).toBe("done");
    expect(t.states[1]![1]).toContain("1 round(s) cancelled");
  });

  it("waits through `pending` results and gives up honestly when none arrives", async () => {
    // The daemon writes its result asynchronously; "pending" is not an answer.
    const { ssh } = runner(["pending", "pending", '{"ok":true}']);
    const t = track();
    await sender(ssh).send("rerun-round", 1, t.on);
    expect(t.states[1]![0]).toBe("done");

    // A daemon that never answers must not read as success.
    const silent = runner(Array(100).fill("pending") as string[]);
    const t2 = track();
    let clock = NOW.getTime();
    const s = new CommandFileSender(cfg, silent.ssh, () => new Date((clock += 5_000)), async () => {});
    await s.send("rerun-round", 1, t2.on);
    expect(t2.states[t2.states.length - 1]![0]).toBe("failed");
    expect(t2.states[t2.states.length - 1]![1]).toContain("no result");
  });

  it("refuses a bad PR number without touching the box at all", async () => {
    const { ssh, calls } = runner([]);
    const t = track();
    await sender(ssh).send("rerun-round", 0, t.on);
    expect(calls).toHaveLength(0);
    expect(t.states).toEqual([["failed", "✖ rerun-round refused (bad PR number)"]]);
  });

  it("builds argv against the configured container and sudo setting", () => {
    const name = "2026-08-21T15-00-00-000Z-tui-0000.json";
    // `-u 0` is the operator seal: the file arrives root-owned in a
    // root-owned directory the daemon's uid cannot write. MUTATION: drop the
    // `-u 0` pair from commandWriteArgv — this fails.
    expect(commandWriteArgv(cfg, name).slice(0, 7)).toEqual(["sudo", "docker", "exec", "-i", "-u", "0", "quickreview-sandbox"]);
    // The result probe is a read: no `-i`, and it never mutates.
    const probe = commandResultArgv(cfg, name);
    expect(probe).not.toContain("-i");
    expect(probe[probe.length - 1]).toContain("results/2026-08-21T15-00-00-000Z-tui-0000.result.json");
  });
});
