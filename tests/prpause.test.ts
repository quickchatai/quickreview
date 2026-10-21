// `qcr pause-pr` / `qcr resume-pr` (src/tui/prpause.ts): the operator's per-PR
// pause, written AS ROOT into the sealed commands/operator/ with the payload on
// stdin, and read back from the daemon's own result file. A pause the daemon
// bounded like a session's (the directory unsealed) is a failure, never success:
// the cutover wizard's stage 9 lifts the drain only over pauses that stand until
// resumed.
import { describe, expect, it } from "vitest";
import type { TuiConfig } from "../src/config.js";
import type { RemoteResult, SshRunner } from "../src/tui/remote.js";
import { PrLeverSender, prLeverPayload, renderPrLever } from "../src/tui/prpause.js";

const tui = {
  ssh_host: "my-vm",
  container: "quickreview-sandbox",
  sudo_docker: true,
  remote_sandbox_root: "/opt/quickreview/sandbox",
  remote_state_dir: "/opt/quickreview/state",
  msg_timeout_s: 30,
} as unknown as TuiConfig;

function runner(results: string[]): {
  ssh: SshRunner;
  calls: Array<{ argv: string[]; stdin?: string }>;
} {
  const calls: Array<{ argv: string[]; stdin?: string }> = [];
  const ssh: SshRunner = async (_host, argv, opts) => {
    calls.push({ argv, ...(opts?.stdin !== undefined ? { stdin: opts.stdin } : {}) });
    const probe = argv.some((a) => a.includes("result.json"));
    return {
      ok: true,
      stdout: probe ? (results.shift() ?? "pending") : "",
      stderr: "",
      code: 0,
    } satisfies RemoteResult;
  };
  return { ssh, calls };
}

const sender = (ssh: SshRunner) =>
  new PrLeverSender(
    tui,
    ssh,
    () => new Date("2026-10-21T10:00:00Z"),
    async () => {},
  );

describe("qcr pause-pr / resume-pr (the operator's per-PR pause)", () => {
  it("writes AS ROOT into commands/operator/, the payload on stdin, and reports the daemon's answer", async () => {
    const { ssh, calls } = runner([
      "pending",
      JSON.stringify({
        ok: true,
        paused: 12,
        outcome: "new",
        issuer: "operator",
        expires_at: null,
      }),
    ]);
    const cmd = { command: "pause-pr", pr: 12, reason: "cutover" } as const;
    const out = await sender(ssh).send(cmd);
    expect(out).toEqual({ ok: true, issuer: "operator", outcome: "new" });
    const write = calls[0]!;
    expect(write.argv.slice(0, 7)).toEqual([
      "sudo",
      "docker",
      "exec",
      "-i",
      "-u",
      "0",
      "quickreview-sandbox",
    ]);
    expect(write.argv.join(" ")).toContain("commands/operator");
    expect(write.argv.join(" ")).not.toContain("cutover");
    // no expiry: an operator pause stands until resumed
    expect(JSON.parse(write.stdin!)).toEqual({ command: "pause-pr", pr: 12, reason: "cutover" });
    expect(calls.slice(1).every((c) => c.argv.some((a) => a.includes("result.json")))).toBe(true);
    expect(renderPrLever(cmd, out)).toEqual({
      lines: ["✓ #12 paused by the operator until resumed (qcr resume-pr 12)"],
      code: 0,
    });
    expect(renderPrLever(cmd, { ...out, outcome: "unchanged" }).lines[0]).toContain(
      "already paused",
    );
  });

  it("a pause the daemon bounded like a session's is a failure", async () => {
    const { ssh } = runner([
      JSON.stringify({
        ok: true,
        paused: 12,
        outcome: "new",
        issuer: "session",
        expires_at: "2026-10-21T14:00:00Z",
      }),
    ]);
    const cmd = { command: "pause-pr", pr: 12, reason: "r" } as const;
    const out = await sender(ssh).send(cmd);
    const r = renderPrLever(cmd, out);
    expect(r.code).toBe(1);
    expect(r.lines[0]).toContain("NOT as the operator's");
    expect(r.lines[0]).toContain("2026-10-21T14:00:00Z");
  });

  it("a refusal and a timeout are failures; resume reports the daemon's word", async () => {
    const refused = await sender(
      runner([JSON.stringify({ ok: false, reason: "unknown PR #9" })]).ssh,
    ).send({
      command: "resume-pr",
      pr: 9,
    });
    expect(refused).toEqual({ ok: false, reason: "unknown PR #9" });
    expect(renderPrLever({ command: "resume-pr", pr: 9 }, refused)).toEqual({
      lines: ["✖ resume-pr #9 refused: unknown PR #9"],
      code: 1,
    });
    const resumed = await sender(runner([JSON.stringify({ ok: true, resumed: 9 })]).ssh).send({
      command: "resume-pr",
      pr: 9,
    });
    expect(renderPrLever({ command: "resume-pr", pr: 9 }, resumed)).toEqual({
      lines: ["✓ #9 resumed"],
      code: 0,
    });

    let t = 0;
    const slow = new PrLeverSender(
      tui,
      runner([]).ssh,
      () => new Date(Date.parse("2026-10-21T10:00:00Z") + (t += 10_000)),
      async () => {},
    );
    expect(await slow.send({ command: "resume-pr", pr: 9 })).toEqual({
      ok: false,
      reason: "no result before timeout (daemon down?)",
    });
  });

  it("builds only payloads the daemon's own validator admits from the operator channel", () => {
    expect(() => prLeverPayload({ command: "pause-pr", pr: 0, reason: "r" })).toThrow();
    expect(() => prLeverPayload({ command: "pause-pr", pr: 3, reason: "" })).toThrow();
    expect(JSON.parse(prLeverPayload({ command: "resume-pr", pr: 3 }))).toEqual({
      command: "resume-pr",
      pr: 3,
    });
  });
});
