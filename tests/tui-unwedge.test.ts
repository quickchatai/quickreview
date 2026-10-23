// The board's `u` key — the one write action the board has beyond
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
  commandFileName,
  commandPayload,
  commandResultArgv,
  commandWriteArgv,
  type UnwedgeState,
} from "../src/tui/unwedge.js";
import type { RemoteResult, SshRunner } from "../src/tui/remote.js";
import { CommandDrainSender } from "../src/tui/deploy-drain.js";
import { controlPayload, liveControlArgv } from "../src/tui/livecontrol.js";
import { COMMAND_WHITELIST, OPERATOR_COMMANDS, validateCommand } from "../src/commands.js";

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
function runner(results: string[]): {
  ssh: SshRunner;
  calls: Array<{ argv: string[]; stdin?: string }>;
} {
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
  return new CommandFileSender(
    cfg,
    ssh,
    () => NOW,
    async () => {},
  );
}

function track(): {
  states: Array<[UnwedgeState, string]>;
  on: (s: UnwedgeState, l: string) => void;
} {
  const states: Array<[UnwedgeState, string]> = [];
  return { states, on: (s, l) => states.push([s, l]) };
}

describe("the unwedge command channel", () => {
  it("writes ONE fixed-shape command the daemon whitelist already accepts", () => {
    // The payload is built here, never taken from a caller, so this module
    // cannot produce a command the whitelist does not know.
    expect(JSON.parse(commandPayload("rerun-round", 5362))).toEqual({
      command: "rerun-round",
      pr: 5362,
    });
    expect(JSON.parse(commandPayload("restart-session", 42))).toEqual({
      command: "restart-session",
      pr: 42,
    });
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
    // operator directory, never the session dir beside it.
    const script = write.argv[write.argv.length - 1]!;
    expect(script).toContain("cd -P '/opt/quickreview/sandbox/commands/operator'");
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

  it("strips terminal control bytes from the daemon's reason before it reaches the notice line", async () => {
    // The result file sits in the session-writable results dir, so its
    // reason is untrusted text: an ESC/CSI/OSC sequence must never reach the
    // operator's terminal as live control output, nor a newline split the
    // one-line notice.
    const hostile = JSON.stringify({
      ok: false,
      reason: "tier\u001b[2J\u001b[H\u001b]0;pwned\u0007\nrefused\u009b",
    });
    const { ssh } = runner([hostile]);
    const t = track();
    await sender(ssh).send("rerun-round", 77, t.on);

    const label = t.states[1]![1];
    expect(label).not.toMatch(/[\x00-\x1f\x7f-\x9f]/);
    expect(label).toContain("refused (tier[2J[H]0;pwned refused)");
  });

  it("the deploy drain reads the same results dir, so its refusal reason is stripped too", async () => {
    const { ssh } = runner([
      JSON.stringify({ ok: false, reason: "nope\u001b[2J\u001b[H\nagain\u0085" }),
    ]);
    const out = await new CommandDrainSender(
      cfg,
      ssh,
      () => NOW,
      async () => {},
    ).set(true);
    expect(out).toEqual({ ok: false, reason: "nope[2J[H again" });
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
    const s = new CommandFileSender(
      cfg,
      silent.ssh,
      () => new Date((clock += 5_000)),
      async () => {},
    );
    await s.send("rerun-round", 1, t2.on);
    expect(t2.states[t2.states.length - 1]![0]).toBe("failed");
    expect(t2.states[t2.states.length - 1]![1]).toContain("no result");
  });

  it("a failed write names its cause — the write script's refusal or the transport's — sanitized to one line", async () => {
    const ssh: SshRunner = async () => ({
      ok: false,
      stdout: "",
      stderr:
        "Warning: something\n/opt/quickreview/sandbox/commands/operator is a symlink - refusing\x1b[2J\n",
      code: 1,
    });
    const t = track();
    await sender(ssh).send("rerun-round", 5, t.on);
    expect(t.states.at(-1)).toEqual([
      "failed",
      "✖ rerun-round #5 failed (write failed: /opt/quickreview/sandbox/commands/operator is a symlink - refusing[2J)",
    ]);
    const refused: SshRunner = async () => ({ ok: false, stdout: "", stderr: "", code: 1 });
    const t2 = track();
    await sender(refused).send("rerun-round", 5, t2.on);
    expect(t2.states.at(-1)![1]).toBe("✖ rerun-round #5 failed (write failed: exit 1)");
  });

  it("a transport failure on the write is not proof of non-delivery: the result is still read", async () => {
    // ssh can drop after the remote rename published the file.
    const dropped = (code: number | null): SshRunner => {
      let probes = 0;
      return async (_h, argv) => {
        if (!argv.some((a) => a.includes("result.json")))
          return { ok: false, stdout: "", stderr: "", code };
        probes++;
        return { ok: true, stdout: probes < 2 ? "pending" : '{"ok":true}', stderr: "", code: 0 };
      };
    };
    for (const code of [255, null]) {
      const t = track();
      await sender(dropped(code)).send("rerun-round", 5, t.on);
      expect(t.states.at(-1)).toEqual(["done", "✓ rerun-round #5"]);
    }
    // No result either: the outcome is unknown, not a definite failure.
    const down: SshRunner = async () => ({ ok: false, stdout: "", stderr: "", code: 255 });
    let clock = NOW.getTime();
    const s = new CommandFileSender(
      cfg,
      down,
      () => new Date((clock += 5_000)),
      async () => {},
    );
    const t2 = track();
    await s.send("rerun-round", 5, t2.on);
    expect(t2.states.at(-1)).toEqual([
      "failed",
      "✖ rerun-round #5 outcome unknown (write failed: exit 255; no result found)",
    ]);
  });

  it("a result read mid-write is read again — the completed answer is what the operator sees", async () => {
    const { ssh } = runner(['{"ok":tr', '{"ok":true,"cancelled_rounds":[3]}']);
    const t = track();
    await sender(ssh).send("rerun-round", 9, t.on);
    expect(t.states.at(-1)).toEqual(["done", "✓ rerun-round #9 — 1 round(s) cancelled"]);
  });

  it("a result that never reads as an object fails as unreadable at the deadline, never a throw", async () => {
    const { ssh } = runner(Array(100).fill("null") as string[]);
    const t = track();
    let clock = NOW.getTime();
    const s = new CommandFileSender(
      cfg,
      ssh,
      () => new Date((clock += 5_000)),
      async () => {},
    );
    await expect(s.send("rerun-round", 9, t.on)).resolves.toBeUndefined();
    expect(t.states.at(-1)).toEqual(["failed", "✖ rerun-round #9 failed (unreadable result)"]);
  });

  it("names its command files with its own id — never the path another sender's command takes", async () => {
    const a = runner(['{"ok":true}']);
    const b = runner(['{"ok":true}']);
    await sender(a.ssh).send("rerun-round", 1, track().on);
    await sender(b.ssh).send("rerun-round", 1, track().on);
    const script = (c: { argv: string[] }): string => c.argv[c.argv.length - 1]!;
    const nameA = /mv '[^']+' '([^']+)'/.exec(script(a.calls[0]!))![1]!;
    const nameB = /mv '[^']+' '([^']+)'/.exec(script(b.calls[0]!))![1]!;
    expect(nameA).toMatch(/^2026-08-21T15-00-00-000Z-tui-unwedge-[0-9a-f]{8}-0000\.json$/);
    expect(nameA).not.toBe(nameB);
    expect(commandFileName(NOW, 0)).toBe("2026-08-21T15-00-00-000Z-tui-0000.json");
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
    expect(commandWriteArgv(cfg, name).slice(0, 7)).toEqual([
      "sudo",
      "docker",
      "exec",
      "-i",
      "-u",
      "0",
      "quickreview-sandbox",
    ]);
    // The result probe is a read: no `-i`, and it never mutates.
    const probe = commandResultArgv(cfg, name);
    expect(probe).not.toContain("-i");
    expect(probe[probe.length - 1]).toContain(
      "results/2026-08-21T15-00-00-000Z-tui-0000.result.json",
    );
  });
});

describe("the operator's round controls ride the same root operator directory", () => {
  const name = "2026-08-21T15-00-00-000Z-tui-0000.json";

  it("the control write is the unwedge write: root, into commands/operator/, nothing else accepted", () => {
    expect(liveControlArgv(cfg, name)).toEqual(commandWriteArgv(cfg, name));
    const script = liveControlArgv(cfg, name).at(-1)!;
    // the one directory, proven physical before anything is written into it
    expect(script).toContain("/opt/quickreview/sandbox/commands/operator");
    expect(script).toContain('[ "$(pwd -P)" = "$R/operator" ]');
    expect(script).not.toContain("commands/slack");
  });

  it("unwedge still produces only the two session-whitelisted verbs; the controls are operator-only", () => {
    for (const verb of ["rerun-round", "restart-session"] as const) {
      const raw = JSON.parse(commandPayload(verb, 7)) as unknown;
      expect(validateCommand(raw, { issuer: "session" }).ok).toBe(true);
      expect(COMMAND_WHITELIST).toContain(verb);
    }
    for (const kind of [
      "steer",
      "follow-up",
      "abort-round",
      "message",
      "takeover",
      "release",
      "debug-round",
    ] as const) {
      const raw = JSON.parse(controlPayload({ kind, pr: 7, text: "x" })) as unknown;
      expect(OPERATOR_COMMANDS).toContain(kind);
      expect(validateCommand(raw, { issuer: "session" }).ok, kind).toBe(false);
      expect(validateCommand(raw, { issuer: "operator" }).ok, kind).toBe(true);
    }
  });
});
