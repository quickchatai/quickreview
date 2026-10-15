// The TUI startup contract, enforced.
//
// The PRIMARY assertion is structural and cannot go flaky: driving the REAL
// `runTui` against fake terminal streams, no network call, no docker call and
// no filesystem walk happens before the first frame is painted. A wall-clock
// budget rides alongside as a WARNING only — a
// timing assertion would eventually be skipped, and then the structural
// property would go unguarded too.
//
// The rest of the file pins the honest half: unknown reads as unknown (never a
// zero and never a DRY-RUN badge), each ssh failure class carries its own cause
// and its own remedy command, `s` re-evaluates, and a bring-up step that never
// completes looks different from one that is still working.
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { stripAnsi } from "../src/tui/paint.js";

// ---- the instrumentation -----------------------------------------------------
//
// Hoisted mocks cannot close over module scope, so the ordered log lives on
// globalThis. Every entry is either an external call or the first paint.

interface ExternalLog {
  entries: string[];
  paintedAt: number | undefined;
}

/** Resolved on every call, never captured: a `vi.mock` factory runs at the
 * first import of the module it replaces, which can be before this file's own
 * body has run. */
function startupLog(): ExternalLog {
  const g = globalThis as Record<string, unknown>;
  if (!g.__qcrStartupLog)
    g.__qcrStartupLog = { entries: [], paintedAt: undefined } satisfies ExternalLog;
  return g.__qcrStartupLog as ExternalLog;
}

/**
 * Give the next harness a FRESH recorder, and leave the old one behind a dead
 * sink.
 *
 * The recorder is process-global (the mocks are), so two live TUIs would write
 * into the same list — and a call from a TUI the previous test finished with,
 * landing after this test reset the log, reads as "something external happened
 * before the first frame". That is a shared-mutable-state flake, and this
 * file carries the startup contract's central assertion, so it is closed at
 * the root (`runTui` leaves no work running past quit — checked by the
 * harness's `stop()`) AND here, where a stray write can only reach a discarded
 * object.
 */
function freshLog(): ExternalLog {
  const log: ExternalLog = { entries: [], paintedAt: undefined };
  (globalThis as Record<string, unknown>).__qcrStartupLog = log;
  return log;
}

/** How long after quit we watch for stragglers. Not a timing assertion about
 * SPEED — the property is "zero, ever", and this is how long we look. */
const QUIESCE_WATCH_MS = 250;

function note(entry: string): void {
  startupLog().entries.push(entry);
}

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const record = (entry: string): void => {
    const g = globalThis as Record<string, unknown>;
    if (!g.__qcrStartupLog) g.__qcrStartupLog = { entries: [], paintedAt: undefined };
    (g.__qcrStartupLog as { entries: string[] }).entries.push(entry);
  };
  const argsOf = (rest: unknown[]): string =>
    Array.isArray(rest[0]) ? (rest[0] as string[]).join(" ") : "";
  const fakeChild = (): EventEmitter & Record<string, unknown> => {
    const child = new EventEmitter() as EventEmitter & Record<string, unknown>;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.kill = () => true;
    child.unref = () => child;
    child.exitCode = 1;
    child.killed = false;
    setTimeout(() => {
      (child.stdout as PassThrough).end();
      (child.stderr as PassThrough).end();
      child.emit("close", 1);
      child.emit("exit", 1);
    }, 0);
    return child;
  };
  return {
    ...actual,
    default: actual,
    spawn: (bin: string, ...rest: unknown[]) => {
      record(`spawn ${bin} ${argsOf(rest)}`.trim());
      return fakeChild();
    },
    spawnSync: (bin: string, ...rest: unknown[]) => {
      record(`spawnSync ${bin} ${argsOf(rest)}`.trim());
      return {
        status: 1,
        stdout: "",
        stderr: "",
        signal: null,
        pid: 0,
        output: [],
        error: undefined,
      };
    },
    execFile: (bin: string, ...rest: unknown[]) => {
      record(`execFile ${bin} ${argsOf(rest)}`.trim());
      const cb = rest.find((r) => typeof r === "function") as
        ((e: Error | null, o: string, s: string) => void) | undefined;
      const child = fakeChild();
      if (cb) setTimeout(() => cb(new Error("mocked"), "", ""), 0);
      return child;
    },
  };
});

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const record = (entry: string): void => {
    const g = globalThis as Record<string, unknown>;
    if (!g.__qcrStartupLog) g.__qcrStartupLog = { entries: [], paintedAt: undefined };
    (g.__qcrStartupLog as { entries: string[] }).entries.push(entry);
  };
  return {
    ...actual,
    default: actual,
    readdirSync: (...args: Parameters<typeof actual.readdirSync>) => {
      record("readdirSync");
      return actual.readdirSync(...args) as ReturnType<typeof actual.readdirSync>;
    },
    opendirSync: (...args: Parameters<typeof actual.opendirSync>) => {
      record("opendirSync");
      return actual.opendirSync(...args);
    },
    watch: (...args: Parameters<typeof actual.watch>) => {
      record("fs.watch");
      return actual.watch(...args);
    },
  };
});

// ---- the fake terminal -------------------------------------------------------

function fakeTerminal(): {
  out: NodeJS.WriteStream;
  input: NodeJS.ReadStream;
  written: string[];
  painted: Promise<void>;
} {
  const written: string[] = [];
  // An EVENT, not a poll budget: a fixed number of ticks would make the
  // centerpiece assertion depend on machine load (`runTui`'s ~25 dynamic
  // imports transform slowly on a busy box). The only bound is vitest's own
  // test timeout.
  let resolvePainted: () => void;
  const painted = new Promise<void>((r) => (resolvePainted = r));
  const out = new EventEmitter() as unknown as NodeJS.WriteStream & {
    write: (s: string) => boolean;
  };
  Object.assign(out, {
    isTTY: true,
    columns: 160,
    rows: 48,
    write: (s: string) => {
      written.push(s);
      // The first frame is the first write that carries the LAYOUT (its top
      // bar), not the alt-screen switch alone: a cleared screen with nothing
      // on it is not a frame, and everything external must be behind the
      // real one.
      const log = startupLog();
      if (log.paintedAt === undefined && stripAnsi(s).includes("quickreview")) {
        log.paintedAt = log.entries.length;
        log.entries.push("FIRST PAINT");
        resolvePainted();
      }
      return true;
    },
  });
  const input = new EventEmitter() as unknown as NodeJS.ReadStream;
  Object.assign(input, {
    isTTY: true,
    setRawMode: () => input,
    resume: () => input,
    pause: () => input,
  });
  return { out: out as NodeJS.WriteStream, input, written, painted };
}

// ---- the harness: a real runTui against a fake terminal ----------------------

interface Harness {
  out: NodeJS.WriteStream;
  input: NodeJS.ReadStream;
  written: string[];
  running: Promise<void>;
  log: ExternalLog;
  paintMs: number;
  frame: () => string;
  press: (bytes: string | Buffer) => Promise<void>;
  stop: () => Promise<void>;
}

async function startTui(
  tmp: string,
  argv: string[] = ["--no-reload"],
  companionEnabled = true,
): Promise<Harness> {
  const { loadConfig } = await import("../src/config.js");
  const base = loadConfig(join(process.cwd(), "tests/fixtures/config.toml"));
  // A REAL ticket projection, so `readEffortTickets` actually walks a
  // directory: without it `ticketProjection` returns undefined, no readdir ever
  // runs, and the "no filesystem walk before the first frame" assertion is
  // vacuous for the ticket scan, a walk that must run behind the first frame.
  const trackerRoot = join(tmp, "tracker");
  mkdirSync(join(trackerRoot, "efforts", "probe", "tickets"), { recursive: true });
  writeFileSync(
    join(trackerRoot, "efforts", "probe", "tickets", "-probe.md"),
    "# probe\n\nId: \nEffort: probe\nType: impl\nStatus: open\nRole: ready-for-agent\n",
  );
  const config = {
    ...base,
    sink: {
      ...base.sink,
      kind: "wayfinder" as const,
      root: trackerRoot,
      effort: "probe",
      tickets_effort: "probe",
    },
    companion: {
      ...base.companion,
      enabled: companionEnabled,
      tracker_dir: trackerRoot,
      evidence_dir: join(tmp, "evidence"),
      feed_dir: join(tmp, "feed"),
      alerts_dir: join(tmp, "alerts"),
    },
  };
  // The forward must never bind the real memory port during a test run, and
  // nothing here may reach a real OpenViking: the probe is refused outright.
  process.env.QCR_MEMORY_PORT = "0";
  process.env.QCR_MEMORY_GATEWAY = "127.0.0.1";
  globalThis.fetch = ((...args: Parameters<typeof fetch>) => {
    note(`fetch ${String(args[0])}`);
    return Promise.reject(new Error("no network in tests"));
  }) as typeof fetch;

  const log = freshLog();

  const { out, input, written, painted } = fakeTerminal();
  const startedAt = Date.now();
  const { runTui } = await import("../src/tui/index.js");
  const running = runTui(argv, { out, input, config, exit: () => {} });
  // Wait for the FRAME as an event. `running` only settles on quit, so if it
  // settles here the TUI exited without ever painting — a real failure, and
  // one worth naming rather than timing out over.
  await Promise.race([
    painted,
    running.then(() => {
      throw new Error("runTui exited before it painted a first frame");
    }),
  ]);
  const paintMs = Date.now() - startedAt;
  const press = async (bytes: string | Buffer): Promise<void> => {
    input.emit("data", typeof bytes === "string" ? Buffer.from(bytes, "utf8") : bytes);
    await new Promise((r) => setTimeout(r, 20));
  };
  return {
    out,
    input,
    written,
    running,
    log,
    paintMs,
    frame: () => written.join(""),
    press,
    stop: async () => {
      input.emit("data", Buffer.from([0x03]));
      input.emit("data", Buffer.from([0x03]));
      const quit = await Promise.race([
        running.then(() => true),
        new Promise<boolean>((r) => setTimeout(() => r(false), 30_000)),
      ]);
      // Quit is bounded in `runTui` (a short grace for the in-flight bring-up),
      // so not finishing inside 30s is a defect, not slowness — and asserting
      // quiescence below without it would be asserting over a live TUI.
      expect(quit, "runTui did not finish quitting within 30s").toBe(true);
      // When `runTui` resolves, its bring-up, its `s` chain and its poll are
      // DONE — quit waits for them. Enforced here rather than assumed: a call
      // escaping quit would land in the NEXT test's log as phantom pre-paint
      // external work, so a regression fails right here instead of flaking.
      const settledAt = log.entries.length;
      await new Promise((r) => setTimeout(r, QUIESCE_WATCH_MS));
      const late = log.entries.slice(settledAt);
      expect(late, `runTui resolved but kept working: ${late.join(", ")}`).toEqual([]);
      // Anything that still escapes lands in a discarded object, never in the
      // next harness's log.
      freshLog();
    },
  };
}

/** Poll `step` every 20ms until it returns true or WAIT_MS pass. A deadline,
 * not a count of ticks: a tick count is a fixed budget in disguise, which a
 * loaded machine exhausts while the TUI is merely slow. WAIT_MS
 * sits inside the file's test timeout, so a real miss still reaches the
 * assertion after the loop and fails with its message. */
const WAIT_MS = 45_000;
async function pollUntil(step: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + WAIT_MS;
  while (!(await step()) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
}

/** The first launch on a machine opens the key map over the board; any key
 * closes it, and the board is what is underneath. */
async function board(h: Harness): Promise<string> {
  h.written.length = 0;
  await h.press("\x1b");
  return h.frame();
}

describe("the first frame (structural, not timed)", () => {
  const tmp = mkdtempSync(join(tmpdir(), "qcr-startup-"));
  const savedPort = process.env.QCR_MEMORY_PORT;
  const savedGateway = process.env.QCR_MEMORY_GATEWAY;
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
    if (savedPort === undefined) delete process.env.QCR_MEMORY_PORT;
    else process.env.QCR_MEMORY_PORT = savedPort;
    if (savedGateway === undefined) delete process.env.QCR_MEMORY_GATEWAY;
    else process.env.QCR_MEMORY_GATEWAY = savedGateway;
  });
  afterAll(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("paints before ANY network call, docker call or filesystem walk", async () => {
    const h = await startTui(tmp);
    expect(h.log.paintedAt, "the TUI never painted a first frame").not.toBeUndefined();

    const before = h.log.entries.slice(0, h.log.paintedAt);
    expect(before, `these ran before the first frame: ${before.join(", ")}`).toEqual([]);

    // Nor was anything written to the NORMAL screen first: startup chatter
    // scrolled there and then wiped by the alt screen's clear IS the flicker.
    // The alt screen is the very first byte the TUI writes.
    expect(h.written.findIndex((w) => w.includes("\x1b[?1049h"))).toBe(0);

    // The soft budget: a WARNING beside the structural assertion, never a
    // failure (vitest's own transform cost dwarfs the startup under test).
    if (h.paintMs > 2_000) {
      console.warn(
        `[tui-startup] first frame took ${h.paintMs}ms under vitest — over the 2000ms soft budget`,
      );
    }

    // …and it really is a frame: the REAL layout, with the unknowns marked.
    const frame = await board(h);
    expect(frame).toContain("quickreview");
    expect(frame).toContain("PRS (?)");
    expect(frame).toContain("MODE UNKNOWN");
    expect(frame).not.toContain("DRY-RUN");
    expect(frame).not.toContain(" LIVE ");
    // The companion column is there at its config width from the very first
    // frame — the container has not been asked about, and the bring-up reports
    // into it.
    expect(frame).toMatch(/VM ssh|memory forward|companion container/);
    await h.stop();
  });

  it("holds with the hot reload ON — the recursive dist watch comes after the frame too", async () => {
    // The default harness runs `--no-reload`, which makes `reloader` undefined
    // and never exercises `fs.watch` — a filesystem walk that must run behind
    // the first frame. This is the configuration `npm run dev` actually uses.
    const h = await startTui(tmp, []);
    expect(h.log.paintedAt, "the TUI never painted a first frame").not.toBeUndefined();
    const before = h.log.entries.slice(0, h.log.paintedAt);
    expect(before, `these ran before the first frame: ${before.join(", ")}`).toEqual([]);
    // …and the watcher really did start, so the assertion above is about a
    // watch that exists rather than one that was skipped.
    expect(h.log.entries).toContain("fs.watch");
    await h.stop();
  });

  it("with the companion OFF the column is STILL there, carries the bring-up, and says why it is off", async () => {
    // `--no-companion` (and `[companion] enabled = false`) never removes the
    // column. The layout is fixed — tab left, companion right — so the
    // bring-up's progress surface always exists and always reports there; the
    // board's unknown block does not double as one.
    const h = await startTui(tmp, ["--no-reload", "--no-companion"], false);
    await board(h);
    // Wait for a step to actually TRANSITION: the initial checklist is painted
    // once at wiring time, so only a non-`waiting` step proves the live
    // updates reach this surface.
    let frame = "";
    await pollUntil(async () => {
      h.written.length = 0;
      await h.press("\x00"); // a byte nothing is bound to — forces a repaint pass
      // An empty read is a repaint that has not landed yet, never a frame.
      frame = h.frame() || frame;
      return /[✗✓–] VM ssh/.test(frame);
    });
    const plain = frame.replace(/\x1b\[[0-9;?<]*[a-zA-Z]/g, "");
    expect(plain).toContain("PRS (?)");
    expect(plain, "the bring-up's live state never reached the column").toMatch(/[✗✓–] VM ssh/);
    // The column is on the frame (its junction glyph joins the top rule) and
    // names the reason it is empty rather than claiming to be starting.
    expect(plain).toContain("┬");
    expect(plain).toContain("companion off — --no-companion");
    expect(plain).not.toContain("starting up — progress above");
    // …and the board did not grow into the space: the unknown block is the
    // connection triage only, not a second copy of the checklist.
    expect(plain).not.toContain("starting up\n");
    await h.stop();
  });

  it("triages the connection behind that frame, and `s` re-runs the check", async () => {
    const h = await startTui(tmp);
    await board(h);
    // The bring-up's triage has run by now: every probe is refused by the
    // mocked child_process, so the diagnosis lands on the missing-key class and
    // the board carries the exact command to run.
    await pollUntil(() => h.frame().includes("ssh-add"));
    expect(h.frame()).toContain("ssh-add");
    // The ssh step must have ENTERED `running` on the startup path, not sat at
    // `waiting` until it failed: it is the slowest step in the bring-up and
    // therefore the one most likely to need the overdue warning, which is
    // unreachable from `pending`. Only a `begin` produces a ✓/✗/⚠ here.
    // A duration is printed only when the step actually STARTED, so this
    // distinguishes "ran, then failed" from "was failed from `pending`".
    expect(stripAnsi(h.frame()), "the ssh step never entered running on the startup path").toMatch(
      /[✗✓⚠] VM ssh · \d+m?s/,
    );

    // `s` re-runs it and reports the new outcome — no restart, and nothing
    // self-healing: the TUI ran the CHECK again, never the remedy.
    const probesBefore = h.log.entries.filter((e) => e.startsWith("execFile ssh")).length;
    expect(probesBefore).toBeGreaterThan(0);
    h.written.length = 0;
    await h.press("s");
    await pollUntil(
      () =>
        h.log.entries.filter((e) => e.startsWith("execFile ssh")).length > probesBefore &&
        h.frame().includes("ssh-add"),
    );
    expect(h.log.entries.filter((e) => e.startsWith("execFile ssh")).length).toBeGreaterThan(
      probesBefore,
    );
    expect(h.frame()).toContain("ssh-add");
    // The remedy is never RUN for the operator: the TUI does no self-healing.
    // `ssh-add -l` is a read-only probe; `ssh-add <key>` and
    // `ssh -O exit` are the operator's to type.
    const ran = h.log.entries.filter(
      (e) => /ssh-add\s+(?!-l\b)/.test(e) || /ssh\s+-O\s+exit/.test(e),
    );
    expect(ran, `the TUI ran a remedy itself: ${ran.join(", ")}`).toEqual([]);
    await h.stop();
  });
});

// ---- ssh triage: three classes, three causes, three remedies ----------------

describe("connection triage", () => {
  const base = {
    host: "example-vm",
    masterAlive: false,
    controlSocketExists: false,
    identityFiles: ["/home/x/.ssh/google_compute_engine"],
    identity: "/home/x/.ssh/google_compute_engine",
    agent: { reachable: true, identities: ["256 SHA256:abc /home/x/.ssh/other (ED25519)"] },
  };

  it("names the KEY and prints the ssh-add line when the agent cannot offer it", async () => {
    const { classifyConnection } = await import("../src/tui/sshtriage.js");
    const d = classifyConnection({
      ...base,
      agent: { reachable: true, identities: [] },
      connect: {
        ok: false,
        stderr: "example-vm: Permission denied (publickey).",
        timedOut: false,
      },
    });
    expect(d.kind).toBe("no-agent-key");
    expect(d.cause).toContain("google_compute_engine");
    expect(d.cause).toContain("holds no identities");
    expect(d.remedy).toBe("ssh-add /home/x/.ssh/google_compute_engine");
  });

  it("starts an agent first when there is none", async () => {
    const { classifyConnection } = await import("../src/tui/sshtriage.js");
    const d = classifyConnection({
      ...base,
      agent: { reachable: false, identities: [] },
      connect: { ok: false, stderr: "Permission denied (publickey).", timedOut: false },
    });
    expect(d.kind).toBe("no-agent-key");
    expect(d.cause).toContain("no ssh agent is reachable");
    expect(d.remedy).toContain("ssh-agent -s");
    expect(d.remedy).toContain("ssh-add /home/x/.ssh/google_compute_engine");
  });

  it("calls a wedged ControlMaster by its name and gives `ssh -O exit`", async () => {
    const { classifyConnection } = await import("../src/tui/sshtriage.js");
    const d = classifyConnection({
      ...base,
      controlPath: "/home/x/.ssh/cm-alice@my-vm:22",
      controlSocketExists: true,
      connect: { ok: false, stderr: "", timedOut: true },
    });
    expect(d.kind).toBe("wedged-master");
    expect(d.cause).toContain("/home/x/.ssh/cm-alice@my-vm:22");
    expect(d.remedy).toBe("ssh -O exit example-vm");
  });

  it("separates a genuinely unreachable host from both of those", async () => {
    const { classifyConnection } = await import("../src/tui/sshtriage.js");
    const d = classifyConnection({
      ...base,
      connect: {
        ok: false,
        stderr: "ssh: Could not resolve hostname example-vm: Name or service not known",
        timedOut: false,
      },
    });
    expect(d.kind).toBe("host-unreachable");
    expect(d.cause).toContain("did not answer");
    expect(d.remedy).toBe("ssh -v example-vm true");
  });

  it("reads an empty agent as the key case even when ssh says nothing useful", async () => {
    const { classifyConnection } = await import("../src/tui/sshtriage.js");
    const d = classifyConnection({
      ...base,
      agent: { reachable: true, identities: [] },
      connect: { ok: false, stderr: "", timedOut: false },
    });
    expect(d.kind).toBe("no-agent-key");
  });

  it("does not answer an interactive/2FA refusal with an ssh-add that cannot help", async () => {
    const { classifyConnection } = await import("../src/tui/sshtriage.js");
    // BatchMode turns a second factor into a bare "Permission denied", and the
    // method list is the only thing that says a key was never the issue.
    const d = classifyConnection({
      ...base,
      connect: {
        ok: false,
        stderr: "example-vm: Permission denied (keyboard-interactive).",
        timedOut: false,
      },
    });
    expect(d.kind).not.toBe("no-agent-key");
    expect(d.remedy).not.toContain("ssh-add");
    expect(d.cause).toContain("a key cannot fix");
    // publickey among the offered methods keeps the key diagnosis, even beside
    // an interactive method.
    const withKey = classifyConnection({
      ...base,
      agent: { reachable: true, identities: [] },
      connect: {
        ok: false,
        stderr: "Permission denied (publickey,keyboard-interactive,password).",
        timedOut: false,
      },
    });
    expect(withKey.kind).toBe("no-agent-key");
    expect(withKey.remedy).toContain("ssh-add");
  });

  it("never claims the agent holds the right key on the strength of a different one", async () => {
    const { agentHoldsIdentity, classifyConnection } = await import("../src/tui/sshtriage.js");
    // An agent with one UNRELATED key, and no readable .pub to fingerprint
    // against: the honest answer is "cannot tell", not "yes".
    const probes = {
      ...base,
      agent: { reachable: true, identities: ["256 SHA256:zzz /home/x/.ssh/github (ED25519)"] },
      connect: { ok: false, stderr: "Permission denied (publickey).", timedOut: false },
    };
    expect(agentHoldsIdentity(probes)).toBe("unknown");
    expect(classifyConnection(probes).cause).toContain("cannot tell");
    // With a fingerprint it is a fact either way.
    expect(agentHoldsIdentity({ ...probes, identityFingerprint: "SHA256:abc" })).toBe("no");
    expect(agentHoldsIdentity({ ...probes, identityFingerprint: "SHA256:zzz" })).toBe("yes");
  });

  it("keeps the diagnostic probe read-only AND verifying — behaviourally", async () => {
    const { TUI_DEFAULTS } = await import("../src/config.js");
    const { classifyConnection, triageConnection } = await import("../src/tui/sshtriage.js");
    // Asserted through the CALLER, over the ssh option semantics that actually
    // decide the behaviour — not by reading back the builder's own literals,
    // which would let `StrictHostKeyChecking=no` (accept an unverified key)
    // sit here looking pinned and correct.
    const seen: string[][] = [];
    await triageConnection(TUI_DEFAULTS, {
      home: "/home/x",
      exists: () => false,
      run: async (cmd, argv) => {
        seen.push([cmd, ...argv]);
        return { status: 255, stdout: "", stderr: "", timedOut: false };
      },
    });
    const probe = seen.find((a) => a.includes("true"))!;
    const opt = (name: string): string | undefined =>
      probe
        .map((t) => (t.startsWith(`${name}=`) ? t.slice(name.length + 1) : undefined))
        .find((v) => v !== undefined);
    // WRITE: only these two values ever persist a host key. Neither may appear.
    expect(["accept-new", "no"]).not.toContain(opt("StrictHostKeyChecking"));
    // VERIFY: and it must not be pointed at a throwaway file either, which
    // would make the probe succeed against a host whose key changed.
    expect(probe.join(" ")).not.toContain("UserKnownHostsFile");
    expect(probe).toContain("BatchMode=yes"); // never prompts behind the alt screen
    // …and the failure that strictness produces is DIAGNOSED, not misread as a
    // missing agent key (which would hand over an `ssh-add` that cannot help).
    const d = classifyConnection({
      ...base,
      agent: { reachable: true, identities: [] },
      connect: { ok: false, stderr: "Host key verification failed.", timedOut: false },
    });
    expect(d.kind).not.toBe("no-agent-key");
    expect(d.remedy).not.toContain("ssh-add");
    expect(d.cause).toContain("host key");
  });

  it("quotes ssh's message, not the banner rule it draws around it", async () => {
    const { classifyConnection } = await import("../src/tui/sshtriage.js");
    // OpenSSH frames its loudest warnings in `@` rules, so the first non-empty
    // line of a changed-host-key failure is decoration. The cause the operator
    // reads must be the sentence.
    const d = classifyConnection({
      ...base,
      connect: {
        ok: false,
        stderr:
          "@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@\nWARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!\n@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@\n",
        timedOut: false,
      },
    });
    expect(d.cause).toContain("REMOTE HOST IDENTIFICATION HAS CHANGED");
    expect(d.cause).not.toContain("@@@");
    expect(d.detail).not.toContain("@@@");
  });

  it("still classifies a wedged master when ControlPath carries a %C it cannot expand", async () => {
    const { classifyConnection, controlSocketPresent, expandControlPath } =
      await import("../src/tui/sshtriage.js");
    const raw = "~/.ssh/cm-%C";
    const path = expandControlPath(raw, {}, "/home/x");
    expect(path).toBe("/home/x/.ssh/cm-%C");
    // The socket itself cannot be stat'd, but its DIRECTORY answers the only
    // question that matters — is multiplexing configured here at all. Bailing
    // to "" would demote a wedged master to `unknown` and lose the remedy.
    expect(controlSocketPresent(path, (p) => p === "/home/x/.ssh")).toBe(true);
    const d = classifyConnection({
      ...base,
      controlPath: path,
      controlSocketExists: true,
      connect: {
        ok: false,
        stderr: "mux_client_hello_exchange: read from master failed",
        timedOut: false,
      },
    });
    expect(d.kind).toBe("wedged-master");
    expect(d.remedy).toBe("ssh -O exit example-vm");
  });

  it("shares ONE spelling of the master check with connect.ts", async () => {
    const { TUI_DEFAULTS } = await import("../src/config.js");
    const { masterCheckArgv } = await import("../src/tui/connect.js");
    const { triageConnection } = await import("../src/tui/sshtriage.js");
    const seen: string[][] = [];
    await triageConnection(TUI_DEFAULTS, {
      home: "/home/x",
      exists: () => false,
      run: async (cmd, argv) => {
        seen.push([cmd, ...argv]);
        return { status: 0, stdout: "", stderr: "", timedOut: false };
      },
    });
    expect(
      seen.some(
        (a) => a[0] === "ssh" && a.slice(1).join(" ") === masterCheckArgv(TUI_DEFAULTS).join(" "),
      ),
    ).toBe(true);
  });

  // The `.mjs` forward cannot import this module (it is dependency-free ESM
  // that systemd runs from a bare checkout), so the two classifiers are pinned
  // to AGREE instead. Drift between them hands a remote failure a local
  // remedy.
  it("agrees with the memory forward's classifier on the same stderr", async () => {
    const { classifyConnection } = await import("../src/tui/sshtriage.js");
    const forward = (await import("../scripts/companion-memory-forward.mjs")) as unknown as {
      relayFailureCause(
        cfg: Record<string, unknown>,
        text: string,
        deps?: Record<string, unknown>,
      ): { key: string; remedy: string };
    };
    const cfg = {
      sshHost: "example-vm",
      container: "c",
      sudo: true,
      identity: "/home/x/.ssh/k",
    };
    const corpus: Array<[string, string]> = [
      ["Permission denied (publickey).", "auth"],
      ["ssh: Could not resolve hostname example-vm: Name or service not known", "host"],
      ["ssh: connect to host example-vm port 22: Connection timed out", "host"],
      ["Control socket connect(/home/x/.ssh/cm): Connection refused", "mux"],
      ["mux_client_hello_exchange: read from master failed", "mux"],
    ];
    const toForwardKey: Record<string, string> = {
      "no-agent-key": "auth",
      "host-unreachable": "host",
      "wedged-master": "mux",
      unknown: "unknown",
    };
    for (const [stderr, expected] of corpus) {
      const fwd = forward.relayFailureCause(cfg, stderr, { run: () => ({ stdout: "" }) });
      expect(fwd.key, `forward classed ${JSON.stringify(stderr)} as ${fwd.key}`).toBe(expected);
      const tui = classifyConnection({
        ...base,
        agent: { reachable: true, identities: [] },
        controlPath: "/home/x/.ssh/cm",
        controlSocketExists: true,
        connect: { ok: false, stderr, timedOut: false },
      });
      expect(toForwardKey[tui.kind], `TUI classed ${JSON.stringify(stderr)} as ${tui.kind}`).toBe(
        expected,
      );
    }
  });

  it("sends a REMOTE docker refusal to the remote docker, and derives the key from ssh -G", async () => {
    const forward = (await import("../scripts/companion-memory-forward.mjs")) as unknown as {
      relayFailureCause(
        cfg: Record<string, unknown>,
        text: string,
        deps?: Record<string, unknown>,
      ): { key: string; remedy: string; cause: string };
      sshIdentityFor(cfg: Record<string, unknown>, deps?: Record<string, unknown>): string;
    };
    const cfg = { sshHost: "example-vm", container: "qc", sudo: true, local: false };
    // The relay is `ssh <host> sudo docker exec …`, so a docker refusal is the
    // VM's; `systemctl status docker` would point the operator at their laptop.
    const d = forward.relayFailureCause(
      cfg,
      "permission denied while trying to connect to the Docker daemon socket",
      {
        run: () => ({ stdout: "" }),
      },
    );
    expect(d.key).toBe("docker");
    expect(d.cause).toContain("example-vm");
    expect(d.remedy).toBe("ssh example-vm sudo docker ps");
    expect(d.remedy).not.toContain("systemctl");
    // …and the ssh-add path is DERIVED, exactly as sshtriage derives it.
    const key = forward.sshIdentityFor(cfg, {
      home: "/home/x",
      exists: (p: string) => p === "/home/x/.ssh/derived_key",
      run: () => ({ stdout: "identityfile ~/.ssh/other\nidentityfile ~/.ssh/derived_key\n" }),
    });
    expect(key).toBe("/home/x/.ssh/derived_key");
    const auth = forward.relayFailureCause(
      { ...cfg, identity: undefined },
      "Permission denied (publickey).",
      {
        home: "/home/x",
        exists: (p: string) => p === "/home/x/.ssh/derived_key",
        run: () => ({ stdout: "identityfile ~/.ssh/derived_key\n" }),
      },
    );
    expect(auth.remedy).toBe("ssh-add /home/x/.ssh/derived_key");
  });

  it("is silent when the master is alive, and never spawns anything in local mode", async () => {
    const { TUI_DEFAULTS } = await import("../src/config.js");
    const { classifyConnection, triageConnection } = await import("../src/tui/sshtriage.js");
    expect(classifyConnection({ ...base, masterAlive: true }).kind).toBe("ok");
    const ran: string[] = [];
    const d = await triageConnection(
      { ...TUI_DEFAULTS, target: "local" },
      {
        run: async (cmd) => {
          ran.push(cmd);
          return { status: 0, stdout: "", stderr: "", timedOut: false };
        },
      },
    );
    expect(d.kind).toBe("local");
    expect(ran).toEqual([]);
  });

  it("collects the probes ssh itself answers with — key, control path, agent", async () => {
    const { TUI_DEFAULTS } = await import("../src/config.js");
    const { triageConnection } = await import("../src/tui/sshtriage.js");
    const seen: string[][] = [];
    const d = await triageConnection(TUI_DEFAULTS, {
      home: "/home/x",
      exists: (p) => p === "/home/x/.ssh/google_compute_engine",
      run: async (cmd, argv) => {
        seen.push([cmd, ...argv]);
        if (cmd === "ssh" && argv[0] === "-G") {
          return {
            status: 0,
            stdout:
              "hostname 10.0.0.5\nuser alice\nport 22\nidentityfile ~/.ssh/google_compute_engine\ncontrolpath /home/x/.ssh/cm-%r@%h:%p\n",
            stderr: "",
            timedOut: false,
          };
        }
        if (cmd === "ssh" && argv[0] === "-O")
          return { status: 255, stdout: "", stderr: "no such file", timedOut: false };
        if (cmd === "ssh-add")
          return {
            status: 1,
            stdout: "The agent has no identities.\n",
            stderr: "",
            timedOut: false,
          };
        return {
          status: 255,
          stdout: "",
          stderr: "Permission denied (publickey).",
          timedOut: false,
        };
      },
    });
    expect(seen[0]).toEqual(["ssh", "-G", TUI_DEFAULTS.ssh_host]);
    expect(seen.some((a) => a[0] === "ssh-add")).toBe(true);
    // The BatchMode connect is the only probe that touches the network, and it
    // can never prompt — this runs behind the alt screen.
    const connect = seen.find((a) => a.includes("true"));
    expect(connect).toContain("BatchMode=yes");
    expect(d.kind).toBe("no-agent-key");
    expect(d.remedy).toBe("ssh-add /home/x/.ssh/google_compute_engine");
  });
});

// ---- progress in the column, and a stalled step that says so ----------------

describe("startup progress", () => {
  it("the tickets panes read UNKNOWN until the tracker is scanned", async () => {
    const { installLearningTabs } = await import("../src/tui/learning.js");
    const { renderTicketsTab } = await import("../src/tui/ticketstab.js");
    const { renderFeedbackTab } = await import("../src/tui/feedbacktab.js");
    const { TUI_DEFAULTS } = await import("../src/config.js");
    const changes = {
      register: undefined,
      refresh: async () => undefined,
      revert: async () => ({ ok: false, message: "no" }),
    };
    const app = {
      cfg: TUI_DEFAULTS,
      hooks: { tabs: {} },
      view: {},
      notice: () => {},
      repaint: () => {},
    } as never;
    const tabs = installLearningTabs(app, {
      memory: { read: async () => [], apply: async () => ({ ok: true }) } as never,
      digestFetcher: { list: async () => [], read: async () => "" },
      readTickets: () => [],
      changes,
    });
    const st = tabs.store;
    const now = new Date("2026-08-31T10:00:00Z");
    // The scan is a filesystem walk and now runs BEHIND the first frame, so
    // there is a window in which an empty list is "not read", not "none".
    expect(st.tickets).toEqual({ kind: "unread" });
    const before = stripAnsi(
      renderTicketsTab(st, tabs.tickets, undefined, 160, 30).lines.join("\n"),
    );
    expect(before).toContain("TICKETS (—)");
    expect(before).not.toContain("TICKETS (0");
    expect(
      stripAnsi(
        renderFeedbackTab(
          st,
          tabs.feedback,
          changes,
          undefined,
          160,
          40,
          undefined,
          now,
        ).lines.join("\n"),
      ),
    ).toContain("FILED (—)");
    // A THROWING read is not an empty tracker: it must not latch, so the pane
    // keeps saying unknown and a later `r` can still succeed.
    const broken = installLearningTabs(app, {
      memory: { read: async () => [], apply: async () => ({ ok: true }) } as never,
      digestFetcher: { list: async () => [], read: async () => "" },
      readTickets: () => {
        throw new Error("ENOENT");
      },
      changes,
    });
    broken.store.reloadTickets();
    expect(broken.store.tickets, "a failed tracker read latched as 'read'").toMatchObject({
      kind: "unreadable",
    });
    expect(
      stripAnsi(
        renderTicketsTab(broken.store, broken.tickets, undefined, 160, 30).lines.join("\n"),
      ),
    ).toContain("TICKETS (—)");

    st.reloadTickets();
    expect(st.tickets).toEqual({ kind: "read", tickets: [] });
    const after = stripAnsi(
      renderTicketsTab(st, tabs.tickets, undefined, 160, 30).lines.join("\n"),
    );
    expect(after).toContain("TICKETS (0 actionable / 0 total)");
    // A gh read that was skipped for want of a repo is not "no bot PRs".
    expect(st.improvements).toBeUndefined();
    expect(
      stripAnsi(
        renderFeedbackTab(
          st,
          tabs.feedback,
          changes,
          undefined,
          160,
          40,
          undefined,
          now,
        ).lines.join("\n"),
      ),
    ).toContain("BOT PRs / ISSUES (—)");
  });

  it("re-attempts the bot-PR read once the repo arrives with the first snapshot", async () => {
    const { installLearningTabs } = await import("../src/tui/learning.js");
    const { TUI_DEFAULTS } = await import("../src/config.js");
    let calls = 0;
    const app = {
      cfg: TUI_DEFAULTS,
      hooks: { tabs: {} } as Record<string, unknown>,
      view: {} as { repo?: string },
      notice: () => {},
      repaint: () => {},
    } as never;
    const { store: st } = installLearningTabs(app, {
      memory: { read: async () => [], apply: async () => ({ ok: true }) } as never,
      digestFetcher: { list: async () => [], read: async () => "" },
      fetchProposals: async () => {
        calls += 1;
        const repo = (app as unknown as { view: { repo?: string } }).view.repo;
        return {
          proposals: [],
          improvements: repo
            ? [{ kind: "pr" as const, number: 1, title: "t", state: "open" }]
            : undefined,
        };
      },
      changes: {
        register: undefined,
        refresh: async () => undefined,
        revert: async () => ({ ok: false, message: "no" }),
      },
    });
    const feedback = (
      app as unknown as {
        hooks: { tabs: { feedback: { screen: (a: unknown, c: number, r: number) => unknown } } };
      }
    ).hooks.tabs.feedback;
    const screen = (a: unknown, c: number, r: number): unknown => feedback.screen(a, c, r);
    // First visit with no snapshot yet — the instant first frame makes this the
    // NORMAL case, and it must not park the pane for the whole session.
    screen(app, 160, 40);
    await new Promise((r) => setTimeout(r, 10));
    expect(calls).toBe(1);
    expect(st.improvements).toBeUndefined();
    // The snapshot lands, `view.repo` with it: exactly one more attempt.
    (app as unknown as { view: { repo?: string } }).view.repo = "o/r";
    screen(app, 160, 40);
    await new Promise((r) => setTimeout(r, 10));
    expect(calls).toBe(2);
    expect(st.improvements).toHaveLength(1);
    // …and it does not keep re-fetching on every repaint after that.
    screen(app, 160, 40);
    screen(app, 160, 40);
    await new Promise((r) => setTimeout(r, 10));
    expect(calls).toBe(2);
  });

  it("shows pending, running, done, failed and skipped as different things", async () => {
    const { StartupProgress, startupLines } = await import("../src/tui/startup.js");
    let now = 1_000;
    const p = new StartupProgress(
      [
        { key: "a", label: "alpha" },
        { key: "b", label: "beta" },
        { key: "c", label: "gamma" },
        { key: "d", label: "delta" },
      ],
      { now: () => now },
    );
    p.begin("a");
    now += 400;
    p.done("a", "adopted");
    p.begin("b");
    p.fail("c", "docker is not running");
    p.skip("d", "--no-companion");
    const lines = startupLines(p.steps(), now).map((l) => l.replace(/\x1b\[[0-9;]*m/g, ""));
    expect(lines[0]).toBe("✓ alpha · 400ms · adopted");
    expect(lines[1]).toContain("⟳ beta");
    expect(lines[2]).toBe("✗ gamma · docker is not running");
    expect(lines[3]).toBe("– delta · --no-companion");
  });

  it("a retried step drops the failure it had — a success never paints beside the old error", async () => {
    const { StartupProgress, startupLines } = await import("../src/tui/startup.js");
    let now = 0;
    const p = new StartupProgress([{ key: "pi", label: "companion pi" }], {
      now: () => now,
      tickMs: 0,
    });
    p.begin("pi");
    now = 300;
    p.fail("pi", "spawn failed: no such session");
    now = 5_000;
    p.begin("pi");
    expect(p.steps()[0]).toMatchObject({ state: "running", startedAt: 5_000 });
    expect(p.steps()[0]!.detail).toBeUndefined();
    expect(p.steps()[0]!.endedAt).toBeUndefined();
    now = 5_200;
    p.done("pi");
    const line = startupLines(p.steps(), now)[0]!.replace(/\x1b\[[0-9;]*m/g, "");
    expect(line).toBe("✓ companion pi · 200ms");
  });

  it("distinguishes a step that never completes from one still working", async () => {
    const { STALL_AFTER_MS, StartupProgress, startupLines } = await import("../src/tui/startup.js");
    let now = 0;
    const p = new StartupProgress([{ key: "a", label: "companion container" }], { now: () => now });
    p.begin("a");
    now = STALL_AFTER_MS - 1;
    const working = startupLines(p.steps(), now)[0]!.replace(/\x1b\[[0-9;]*m/g, "");
    now = 45_000;
    const stalled = startupLines(p.steps(), now)[0]!.replace(/\x1b\[[0-9;]*m/g, "");
    expect(working).toContain("⟳");
    expect(working).not.toContain("still running");
    expect(stalled).toContain("⚠");
    expect(stalled).toContain("still running, no result yet");
    expect(stalled).toContain("45s");
  });

  it("a progress note never restarts the stall clock", async () => {
    const { STALL_AFTER_MS, StartupProgress, startupLines } = await import("../src/tui/startup.js");
    let now = 0;
    const p = new StartupProgress([{ key: "a", label: "companion container" }], { now: () => now });
    p.begin("a");
    now = STALL_AFTER_MS + 5_000;
    // docker chattering is not progress towards finishing: a step that has been
    // running past the threshold still says so.
    p.note("a", "pulling the image");
    const line = startupLines(p.steps(), now)[0]!.replace(/\x1b\[[0-9;]*m/g, "");
    expect(line).toContain("⚠");
    expect(line).toContain("still running");
    // …and a note on a finished step is ignored rather than reviving it.
    p.done("a");
    p.note("a", "late");
    expect(p.steps()[0]).toMatchObject({ state: "done" });
  });

  it("never lets a reporting failure break the bring-up it reports on", async () => {
    const { StartupProgress } = await import("../src/tui/startup.js");
    // Widened to `string` deliberately: the whole point of this case is the
    // key TypeScript forbids, reaching the runtime anyway (a computed key, a
    // stale caller after a rename). The behaviour under test only exists off
    // the typed path, so the cast is the test, not a suppression of it.
    const p = new StartupProgress<string>([{ key: "a", label: "alpha" }], { tickMs: 0 });
    expect(() => p.done("does-not-exist")).not.toThrow();
    expect(() => p.fail("does-not-exist", "boom")).not.toThrow();
    p.fail("a", "boom");
    expect(p.steps()[0]).toMatchObject({ state: "failed", detail: "boom" });
    expect(p.settled()).toBe(true);
  });

  // THE ONE THAT MATTERS. The stall warning is computed from elapsed time, and
  // a step that hangs emits no transition — so without a ticker nothing calls
  // `onUpdate`, the column keeps painting the elapsed time from the last
  // transition, and the warning is unreachable on screen however correct the
  // pure function is. This drives the REAL sidebar render off the REAL timer.
  it("re-renders a hung step on its own, so the overdue warning reaches the screen", async () => {
    vi.useFakeTimers();
    try {
      const { DEFAULT_TICK_MS, STALL_AFTER_MS, StartupProgress } =
        await import("../src/tui/startup.js");
      const { paintSidebar } = await import("../src/tui/sidebar.js");
      let now = 0;
      const frames: string[] = [];
      const p = new StartupProgress([{ key: "container", label: "companion container" }], {
        now: () => now,
        onUpdate: (prog) =>
          frames.push(
            paintSidebar(
              {
                header: { up: false, piUp: false, day: "2026-08-31", lastWake: "—", memory: "off" },
                lines: [],
                focused: false,
                available: false,
                offset: 0,
                alerts: [],
                startup: prog.lines(),
              },
              80,
              14,
            ).join("\n"),
          ),
      });
      p.begin("container");
      const afterBegin = frames.length;
      expect(frames[afterBegin - 1]).toContain("⟳");

      // docker never answers: from here there is NO further state change.
      now = STALL_AFTER_MS + 25_000;
      vi.advanceTimersByTime(DEFAULT_TICK_MS * 2);
      expect(frames.length, "nothing re-rendered — the warning can never appear").toBeGreaterThan(
        afterBegin,
      );
      const painted = frames[frames.length - 1]!.replace(/\x1b\[[0-9;]*m/g, "");
      expect(painted).toContain("⚠");
      expect(painted).toContain("still running, no result yet");
      expect(painted).toContain("45s");

      // …and it stops itself the moment nothing is running any more, so it
      // cannot spin behind a finished bring-up or hold the loop at quit.
      p.fail("container", "docker is not running");
      const settledAt = frames.length;
      vi.advanceTimersByTime(DEFAULT_TICK_MS * 10);
      expect(frames.length).toBe(settledAt);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("the companion column during startup", () => {
  const view = (over: Record<string, unknown> = {}) => ({
    header: { up: false, piUp: false, day: "2026-08-31", lastWake: "—", memory: "off" as const },
    lines: [] as string[],
    focused: false,
    available: false,
    offset: 0,
    alerts: [],
    startup: ["⟳ memory forward · 2s", "○ companion container · waiting"],
    ...over,
  });

  it("paints the bring-up in the mirror's space, and hands it back when pi speaks", async () => {
    const { paintSidebar } = await import("../src/tui/sidebar.js");
    const starting = paintSidebar(view(), 40, 14).join("\n");
    expect(starting).toContain("memory forward");
    expect(starting).toContain("starting");
    expect(starting).toContain("starting up — progress above");
    const mirroring = paintSidebar(view({ lines: ["pi> hello"], available: true }), 40, 14).join(
      "\n",
    );
    expect(mirroring).toContain("pi> hello");
    expect(mirroring).not.toContain("memory forward");
  });

  it("never rewinds to a stale checklist when the mirror blanks (the day-rollover case)", async () => {
    const { CompanionSidebar, paintSidebar } = await import("../src/tui/sidebar.js");
    const { COMPANION_DEFAULTS } = await import("../src/config.js");
    let capture = "";
    const docker = async () => ({ ok: true, stdout: capture, stderr: "", code: 0 });
    const sb = new CompanionSidebar(COMPANION_DEFAULTS, docker, { available: () => true });
    sb.setStartup(["✓ memory forward · adopted", "✓ companion container"]);
    expect(paintSidebar(sb.view(), 60, 14).join("\n")).toContain("memory forward");

    capture = "pi> hello";
    await sb.refresh();
    expect(paintSidebar(sb.view(), 60, 14).join("\n")).toContain("pi> hello");

    // The day-rollover kills and respawns pi ON PURPOSE, so an empty capture is
    // a NORMAL mid-session event. The latch keeps it from flipping the column
    // back to the boot checklist ("starting up") hours later.
    capture = "";
    await sb.refresh();
    const blank = paintSidebar(sb.view(), 60, 14).join("\n");
    expect(blank).not.toContain("memory forward");
    expect(blank).not.toContain("starting up — progress above");
  });

  it("takes its width from nothing but the terminal — not config, not docker", async () => {
    const { CompanionSidebar, sidebarWidth } = await import("../src/tui/sidebar.js");
    const { COMPANION_DEFAULTS } = await import("../src/config.js");
    const docker = vi.fn(async () => ({ ok: false, stdout: "", stderr: "", code: 1 }));
    // Container not up yet: the column is at its real width while
    // `available()` is still false, so nothing jumps when the container
    // arrives — and asking docker plays no part in knowing the width.
    const sb = new CompanionSidebar(COMPANION_DEFAULTS, docker, { available: () => false });
    expect(sb.available()).toBe(false);
    await sb.refresh();
    expect(
      docker,
      "the column must not ask docker anything to know its width",
    ).not.toHaveBeenCalled();
    expect(sidebarWidth(160)).toBeGreaterThan(20);
    // There is no config-driven "no column". The class has no `shown()` and
    // takes no `enabled` — `--no-companion` changes what the column SAYS (`setOff`), never whether it is there.
    expect("shown" in sb).toBe(false);
    sb.setOff("--no-companion");
    expect(sb.view().off).toBe("--no-companion");
    expect(sidebarWidth(160)).toBe(sidebarWidth(160, {}));
  });
});

// ---- honest unknowns beyond the board ---------------------------------------
//
// Any surface that can lose its source follows the same rule: no confident
// value stands in for an answer nobody had.

describe("honest unknowns on the other surfaces", () => {
  it("a failed `git status` is UNKNOWN on the deploy tab, never a green clean tree", async () => {
    const { RealDeployFetcher, deployLines } = await import("../src/tui/deploytab.js");
    const { TUI_DEFAULTS } = await import("../src/config.js");
    const fail = async () => ({
      ok: false,
      stdout: "",
      stderr: "fatal: not a git repository",
      code: 128,
    });
    const st = await new RealDeployFetcher(TUI_DEFAULTS, fail, fail).load();
    expect(st.dirty, "an unreadable working tree must not read as clean").toBeUndefined();
    const text = stripAnsi(
      deployLines({ ...st, loaded: true, loading: false, scroll: 0 }, 120).join("\n"),
    );
    expect(text).toContain("unknown — git status could not be read");
    expect(text).not.toContain("clean");
    // …and "up to date, nothing to deploy" is a claim that needs all three
    // facts, so it must not fire off an unread tree.
    expect(text).not.toContain("up to date");
  });

  it("an unfetched container state does not offer STOP as if the VM were up", async () => {
    const { renderDeployTab } = await import("../src/tui/deploytab.js");
    const base = { loaded: true, loading: false, dirty: [], plan: [], scroll: 0 };
    const unknown = stripAnsi(renderDeployTab({ ...base }, false, 120, 20).lines.join("\n"));
    expect(unknown).toContain("VM APP STATE UNKNOWN");
    expect(unknown).toContain("VM: state unknown");
    expect(unknown).not.toContain("STOP VM APP");
    const up = stripAnsi(
      renderDeployTab({ ...base, containerStatus: "Up 3 hours" }, false, 120, 20).lines.join("\n"),
    );
    expect(up).toContain("STOP VM APP");
  });

  it("the ambient feed reports an unread working tree as null, not 0 files", async () => {
    const { buildTuiView } = await import("../src/tui/feed.js");
    const view = buildTuiView({
      now: new Date("2026-08-31T10:00:00Z"),
      tab: "deploy",
      deploy: { loaded: true, dirty: undefined, plan: [], scroll: 0 } as never,
    } as never);
    expect(view.deploy?.dirty_files).toBeNull();
  });

  // There is no AWAITING YOU panel to test here: its count could only ever be
  // zero. `tests/tui-msg-digest.test.ts` pins the full-width replacement.

  it("metrics say a field an older daemon omits is UNKNOWN, not zero", async () => {
    const { cancellationLines, statStrip } = await import("../src/tui/metricstab.js");
    const win = {
      header: {
        prs_triggered: 1,
        prs_reviewed: 1,
        approvals: 1,
        request_changes: 0,
        rounds: 1,
        spend_usd: 1,
        overruns: 0,
      },
    } as never;
    expect(stripAnsi(statStrip(win, 200))).toContain("stopped ?");
    expect(stripAnsi(cancellationLines(win, 60).join("\n"))).toContain(
      "not reported by the daemon build",
    );
  });
});

// ---- what the system DOES with an unfetched value ---------------------------
//
// The rendering sweep has a twin: an ACTION or a PUBLISHED FACT derived from a
// value nobody read is the same defect with worse consequences. These pin the
// action and the published number, never the label.

describe("actions are never taken on unfetched values", () => {
  it("the power button cannot stop a container whose state was never read", async () => {
    const { installDeployHooks, renderDeployTab } = await import("../src/tui/deploytab.js");
    const { TUI_DEFAULTS } = await import("../src/config.js");
    const runs: string[] = [];
    const app = {
      cfg: TUI_DEFAULTS,
      hooks: { tabs: {} } as Record<string, unknown>,
      view: {},
      notice: () => {},
      repaint: () => {},
      ssh: async () => ({ ok: false, stdout: "", stderr: "", code: 1 }),
    } as never;
    const st = installDeployHooks(
      app,
      { load: async () => ({ dirty: undefined, plan: [] }) } as never,
      () => Date.now(),
      undefined,
      { read: () => undefined, write: () => {}, clear: () => {} } as never,
    );
    (app as unknown as { hooks: Record<string, unknown> }).hooks.powerRun = (
      _a: unknown,
      action: string,
      _d: unknown,
      onExit: (c: number) => void,
    ) => {
      runs.push(action);
      onExit(0);
      return { kill: () => {} };
    };
    st.loaded = true;
    st.containerStatus = undefined; // docker ps never answered

    // Paint first: the button must claim NO click zone while the state is
    // unknown, so a click cannot even reach the arming path.
    renderDeployTab(st, false, 120, 20);
    expect(
      st.powerZone,
      "an unknown state must not offer a clickable power button",
    ).toBeUndefined();

    // …and the key does not arm it either. Two presses is the full ceremony:
    // if it armed, the second would fire. (`S` is not even a registered key
    // while the state is unread — the tab hands it back.)
    const key = { kind: "char", ch: "S" } as never;
    const deployKey = (a: unknown, k: unknown): boolean =>
      (
        app as unknown as {
          hooks: { tabs: { deploy: { key: (a: unknown, k: unknown) => boolean } } };
        }
      ).hooks.tabs.deploy.key(a, k);
    expect(deployKey(app, key), "S must be refused, not consumed, on an unread state").toBe(false);
    deployKey(app, key);
    deployKey(app, key);
    expect(st.armedKind, "S armed a power action from a state nobody read").toBeUndefined();
    expect(runs, "the TUI stopped/started the container on unfetched data").toEqual([]);

    // With the state actually READ, the same two presses do act — so the guard
    // is about the unknown, not about breaking the button.
    st.containerStatus = "Up 3 hours";
    renderDeployTab(st, false, 120, 20);
    expect(st.powerZone).not.toBeUndefined();
    deployKey(app, key);
    deployKey(app, key);
    expect(runs).toEqual(["stop"]);
  });

  it("the companion's deploy_tab action is refused on an unread container state", async () => {
    const { buildTuiDriver } = await import("../src/tui/index.js");
    const { TUI_DEFAULTS } = await import("../src/config.js");
    const { App } = await import("../src/tui/app.js");
    const app = new App(TUI_DEFAULTS, async () => ({ ok: false, stdout: "", stderr: "", code: 1 }));
    const deployState = {
      loaded: true,
      loading: false,
      dirty: undefined,
      plan: [],
      scroll: 0,
    } as never;
    const driver = buildTuiDriver(app, {} as never, {} as never, deployState);
    // The same unknown ⇒ "stop" fold must not live here either, or a companion
    // asking for a stop could stop a live reviewer on data nobody fetched.
    expect(() => driver.deployTab("stop")).toThrow(/has not been read/);
    expect(() => driver.deployTab("start")).toThrow(/has not been read/);
  });
});

describe("published facts are never invented either", () => {
  it("the companion-facing view never claims a mode, a PR count or a clean tree it has not read", async () => {
    const { buildTuiView } = await import("../src/tui/feed.js");
    const v = buildTuiView({ now: new Date("2026-08-31T10:00:00Z"), tab: "board" } as never);
    // The dry-run claim matters most: the companion reads this file and
    // repeats it in words.
    expect(v.board.dry_run, "the feed published a dry-run claim with no heartbeat").toBeNull();
    expect(v.board.total).toBeNull();
    expect(v.board.by_state).toBeNull();
    expect(v.deploy.dirty_files).toBeNull();
    expect(v.deploy.pending_commit_count).toBeNull();
  });

  it("the companion's own reader says UNKNOWN for those nulls instead of dropping the line", async () => {
    const { boardAnswer, deployAnswer } = await import("../extensions/tui-view.js");
    const { buildTuiView } = await import("../src/tui/feed.js");
    const dir = mkdtempSync(join(tmpdir(), "qcr-view-"));
    const v = buildTuiView({
      now: new Date("2026-08-31T10:00:00Z"),
      tab: "deploy",
      deploy: { loaded: true, dirty: undefined, plan: [], scroll: 0 } as never,
    } as never);
    writeFileSync(join(dir, "view.json"), JSON.stringify(v));
    const now = new Date("2026-08-31T10:00:01Z");
    // A dropped line reads as "nothing worth mentioning": a companion asked
    // "anything to deploy?" would give a quiet all-clear built from unread data.
    const deploy = deployAnswer(dir, now);
    expect(deploy).toContain("dirty files in the local checkout: UNKNOWN");
    expect(deploy).toContain("commits waiting to ship: UNKNOWN");
    const board = boardAnswer(dir, now);
    expect(board).toContain("dry run: UNKNOWN");
    expect(board).toContain("open PRs: UNKNOWN");
    rmSync(dir, { recursive: true, force: true });
  });
});
