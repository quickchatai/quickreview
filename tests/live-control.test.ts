// The operator control route (src/tui/livecontrol.ts), against a FAUX ECHO
// WORKER: the write and the result probe are the real shell scripts the TUI
// ships, run under sh in a temp state dir (chown shimmed: this test is not
// root), and the "worker" is a function that answers each command file the way
// the daemon will once it forwards it over IPC (P8.12): ack queued or handled,
// or a refusal. Nothing here touches a box, a model or the network.
//
// What the tests pin:
//   1. the control file lands ONLY in the root operator directory
//      (`commands/operator/`), byte for byte what the sender built, and the
//      script's refusals (a symlinked operator dir, no daemon dir) surface;
//   2. the operator sees the daemon's word: queued, handled, refused, or no
//      answer by the deadline (never a silent success);
//   3. the payload is a fixed shape `validateCommand` accepts from the sealed
//      channel and rejects from any other.
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { validateCommand } from "../src/commands.js";
import type { TuiConfig } from "../src/config.js";
import {
  controlPayload,
  installLiveControlHooks,
  LiveControlSender,
  liveControlArgv,
  type ControlRequest,
  type ControlState,
} from "../src/tui/livecontrol.js";
import type { RemoteResult, SshRunner } from "../src/tui/remote.js";
import { commandWriteArgv, operatorCommandDirFor } from "../src/tui/unwedge.js";

let tmp: string;
let root: string;
let cfg: TuiConfig;
let elapsedMs = 0;

const BASE = Date.parse("2026-10-19T12:00:00.000Z");
const now = (): Date => new Date(BASE + elapsedMs);

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "qcr-livecontrol-")));
  root = join(tmp, "sandbox");
  mkdirSync(join(root, "commands"), { recursive: true });
  const bin = join(tmp, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "chown"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(bin, "chown"), 0o755);
  elapsedMs = 0;
  cfg = {
    ssh_host: "vm",
    container: "quickreview-sandbox",
    sudo_docker: true,
    remote_sandbox_root: root,
    remote_state_dir: join(root, "state"),
    msg_timeout_s: 2,
  } as unknown as TuiConfig;
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

/** Runs an argv's trailing `sh -c <script>` for real, with chown shimmed. */
function runSh(argv: string[], stdin?: string): RemoteResult {
  const i = argv.lastIndexOf("-c");
  const res = spawnSync("sh", ["-c", argv[i + 1]!], {
    input: stdin ?? "",
    encoding: "utf8",
    env: { ...process.env, PATH: `${join(tmp, "bin")}:${process.env["PATH"] ?? ""}` },
  });
  return { ok: res.status === 0, stdout: res.stdout, stderr: res.stderr, code: res.status };
}

/** How the faux worker answers a command it is handed. */
type Answer = (command: Record<string, unknown>) => Record<string, unknown> | undefined;

/** The faux echo worker: on each tick it answers every operator file that has
 * no result yet, exactly where the daemon writes results. */
function worker(answer: Answer): { tick: () => void; seen: Array<Record<string, unknown>> } {
  const seen: Array<Record<string, unknown>> = [];
  const done = new Set<string>();
  return {
    seen,
    tick: () => {
      const dir = join(root, "commands", "operator");
      if (!existsSync(dir)) return;
      for (const f of readdirSync(dir).filter((n) => n.endsWith(".json"))) {
        if (done.has(f)) continue;
        done.add(f);
        const body = JSON.parse(readFileSync(join(dir, f), "utf8")) as Record<string, unknown>;
        seen.push(body);
        const result = answer(body);
        if (result === undefined) continue; // the worker never answers
        mkdirSync(join(root, "commands", "results"), { recursive: true });
        writeFileSync(
          join(root, "commands", "results", `${f.replace(/\.json$/, "")}.result.json`),
          JSON.stringify(result),
        );
      }
    },
  };
}

function rig(answer: Answer) {
  const w = worker(answer);
  const calls: Array<{ argv: string[]; stdin?: string }> = [];
  const ssh: SshRunner = async (_host, argv, opts) => {
    calls.push({ argv, ...(opts?.stdin !== undefined ? { stdin: opts.stdin } : {}) });
    return runSh(argv, opts?.stdin);
  };
  const sender = new LiveControlSender(cfg, ssh, now, async (ms) => {
    elapsedMs += ms;
    w.tick(); // the worker answers between two probes
  });
  const states: Array<[ControlState, string]> = [];
  return { sender, w, calls, states, on: (s: ControlState, l: string) => states.push([s, l]) };
}

describe("the control write", () => {
  it("is the operator write: root, into commands/operator/, the payload on stdin", () => {
    const argv = liveControlArgv(cfg, "a.json");
    expect(argv).toEqual(commandWriteArgv(cfg, "a.json"));
    expect(argv.slice(0, 7)).toEqual([
      "sudo",
      "docker",
      "exec",
      "-i",
      "-u",
      "0",
      "quickreview-sandbox",
    ]);
    expect(argv.at(-1)).toContain(operatorCommandDirFor(cfg));
    expect(argv.at(-1)).toContain("chown -h 0:0 .");
    expect(argv).not.toContain("steer"); // nothing about the request is on the command line
  });

  it("lands the file only in the operator directory, byte for byte", async () => {
    const r = rig(() => ({ ok: true, ack: "handled" }));
    await r.sender.send(
      { kind: "steer", pr: 5049, text: "mind the lock order; `rm -rf /` $(x)" },
      r.on,
    );
    const files = readdirSync(join(root, "commands")).filter((n) => n.endsWith(".json"));
    expect(files).toEqual([]); // never the session-writable directory
    const [name] = readdirSync(join(root, "commands", "operator"));
    expect(readFileSync(join(root, "commands", "operator", name!), "utf8")).toBe(
      controlPayload({ kind: "steer", pr: 5049, text: "mind the lock order; `rm -rf /` $(x)" }),
    );
    expect(JSON.stringify(r.calls[0]!.argv)).not.toContain("lock order");
  });

  it("surfaces the script's refusals: a symlinked operator dir, a missing daemon dir", async () => {
    const outside = join(tmp, "elsewhere");
    mkdirSync(outside);
    symlinkSync(outside, join(root, "commands", "operator"));
    const r = rig(() => ({ ok: true }));
    const out = await r.sender.send({ kind: "abort-round", pr: 7 }, r.on);
    expect(out.state).toBe("failed");
    expect(out.label).toContain("symlink");
    expect(readdirSync(outside)).toEqual([]);

    rmSync(root, { recursive: true });
    const r2 = rig(() => ({ ok: true }));
    const out2 = await r2.sender.send({ kind: "abort-round", pr: 7 }, r2.on);
    expect(out2.state).toBe("failed");
    expect(out2.label).toContain("is the daemon running?");
  });
});

describe("the ack, against a faux echo worker", () => {
  it("queued: the worker has it and acts when its turn allows", async () => {
    const r = rig(() => ({ ok: true, ack: "queued" }));
    const out = await r.sender.send(
      { kind: "follow-up", pr: 5049, text: "then the migration" },
      r.on,
    );
    expect(out).toEqual({
      state: "queued",
      label: "⧗ follow-up #5049 queued — the session has it",
    });
    expect(r.states.map(([s]) => s)).toEqual(["pending", "queued"]);
    expect(r.w.seen).toEqual([{ command: "follow-up", pr: 5049, text: "then the migration" }]);
  });

  it("handled: the worker acted", async () => {
    const r = rig((c) => ({ ok: true, ack: "handled", echo: c["text"] }));
    const out = await r.sender.send({ kind: "steer", pr: 5049, text: "go left" }, r.on);
    expect(out).toEqual({ state: "handled", label: "✓ steer #5049 delivered" });
  });

  it("refused: the daemon's reason reaches the operator, sanitised to one line", async () => {
    const r = rig(() => ({ ok: false, reason: "no round is running\x1b[31m\nfor #5049" }));
    const out = await r.sender.send({ kind: "steer", pr: 5049, text: "x" }, r.on);
    expect(out.state).toBe("refused");
    expect(out.label).toBe("✖ steer #5049 refused (no round is running[31m for #5049)");
    expect(out.label).not.toContain("\x1b");
    expect(out.label).not.toContain("\n");
  });

  it("times out honestly when the worker never answers: unconfirmed, not a success", async () => {
    const r = rig(() => undefined);
    const out = await r.sender.send({ kind: "abort-round", pr: 5049 }, r.on);
    expect(out.state).toBe("unacked");
    expect(out.label).toMatch(/^\? abort-round #5049 unconfirmed/);
    expect(out.label).toContain("before re-sending");
    expect(elapsedMs).toBeGreaterThanOrEqual(cfg.msg_timeout_s * 1000);
  });

  it("a result read mid-write is read again; one that never parses is unreadable at the deadline", async () => {
    let calls = 0;
    const r = rig(() => undefined);
    const probeOnce: SshRunner = async (_h, argv, opts) => {
      if (argv.join(" ").includes("result.json")) {
        calls++;
        if (calls === 1) return { ok: true, stdout: '{"ok": tr', stderr: "", code: 0 };
        if (calls === 2)
          return { ok: true, stdout: '{"ok":true,"ack":"handled"}', stderr: "", code: 0 };
      }
      return runSh(argv, opts?.stdin);
    };
    const s = new LiveControlSender(cfg, probeOnce, now, async (ms) => void (elapsedMs += ms));
    expect((await s.send({ kind: "release", pr: 3 }, r.on)).state).toBe("handled");

    const garbage: SshRunner = async (_h, argv, opts) =>
      argv.join(" ").includes("result.json")
        ? { ok: true, stdout: "not json", stderr: "", code: 0 }
        : runSh(argv, opts?.stdin);
    const s2 = new LiveControlSender(cfg, garbage, now, async (ms) => void (elapsedMs += ms));
    const out = await s2.send({ kind: "release", pr: 3 }, r.on);
    expect(out.state).toBe("unacked");
    expect(out.label).toContain("unreadable result");
  });

  it("refuses a bad PR number or an empty text without touching the box", async () => {
    const r = rig(() => ({ ok: true }));
    expect((await r.sender.send({ kind: "abort-round", pr: 0 }, r.on)).state).toBe("failed");
    expect((await r.sender.send({ kind: "steer", pr: 4, text: "  " }, r.on)).state).toBe("failed");
    expect(r.calls).toEqual([]);
  });
});

describe("the payload is a fixed shape the sealed channel accepts and a session's refuses", () => {
  const cases = [
    { kind: "steer", pr: 1, text: "a" },
    { kind: "follow-up", pr: 1, text: "a" },
    { kind: "abort-round", pr: 1 },
    { kind: "message", pr: 1, text: "a" },
    { kind: "message", pr: 1, text: "a", may_post: true },
    { kind: "takeover", pr: 1 },
    { kind: "release", pr: 1 },
    { kind: "debug-round", pr: 1 },
  ] as const;
  it.each(cases)("$kind", (req) => {
    const raw = JSON.parse(controlPayload(req)) as unknown;
    expect(validateCommand(raw, { issuer: "operator" }).ok).toBe(true);
    expect(validateCommand(raw, { issuer: "session" }).ok).toBe(false);
  });

  it("may_post rides a message only, and only when true; a steer never carries it", () => {
    expect(
      JSON.parse(controlPayload({ kind: "message", pr: 1, text: "a", may_post: false })),
    ).toEqual({
      command: "message",
      pr: 1,
      text: "a",
    });
    expect(JSON.parse(controlPayload({ kind: "steer", pr: 1, text: "a", may_post: true }))).toEqual(
      {
        command: "steer",
        pr: 1,
        text: "a",
      },
    );
  });
});

describe("the hook", () => {
  it("reports each state on the notice line and returns the outcome", async () => {
    const notices: string[] = [];
    const app = { cfg, ssh: undefined, hooks: {}, notice: (t: string) => notices.push(t) } as never;
    const sender = {
      async send(_r: unknown, onState: (s: ControlState, l: string) => void) {
        onState("pending", "→ steer #1 pending…");
        onState("handled", "✓ steer #1 delivered");
        return { state: "handled" as const, label: "✓ steer #1 delivered" };
      },
    };
    installLiveControlHooks(app, sender);
    const hooks = (
      app as unknown as {
        hooks: {
          liveControl: (r: ControlRequest, a: unknown) => Promise<{ state: string; label: string }>;
        };
      }
    ).hooks;
    const out = await hooks.liveControl({ kind: "steer", pr: 1, text: "x" }, app);
    expect(out.state).toBe("handled");
    expect(notices).toEqual(["→ steer #1 pending…", "✓ steer #1 delivered"]);

    const boom = {
      async send(): Promise<never> {
        throw new Error("ssh died");
      },
    };
    installLiveControlHooks(app, boom);
    const lost = await hooks.liveControl({ kind: "steer", pr: 1, text: "x" }, app);
    expect(lost.state).toBe("unacked");
    expect(lost.label).toContain("ssh died");
  });
});
