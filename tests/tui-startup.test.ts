// the startup contract, enforced.
//
// The PRIMARY assertion is structural and cannot go flaky: driving the REAL
// `runTui` against fake terminal streams, no network call, no docker call and
// no filesystem walk happens before the first frame is painted. A wall-clock
// budget rides alongside as a WARNING only, exactly as ruling 6 requires — a
// timing assertion would eventually be skipped, and then the structural
// property would go unguarded too.
//
// The rest of the file pins the honest half: unknown reads as unknown (never a
// zero and never a DRY-RUN badge), each ssh failure class carries its own cause
// and its own remedy command, `s` re-evaluates, and a bring-up step that never
// completes looks different from one that is still working.
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

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
  if (!g.__qcrStartupLog) g.__qcrStartupLog = { entries: [], paintedAt: undefined } satisfies ExternalLog;
  return g.__qcrStartupLog as ExternalLog;
}

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
  const argsOf = (rest: unknown[]): string => (Array.isArray(rest[0]) ? (rest[0] as string[]).join(" ") : "");
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
      return { status: 1, stdout: "", stderr: "", signal: null, pid: 0, output: [], error: undefined };
    },
    execFile: (bin: string, ...rest: unknown[]) => {
      record(`execFile ${bin} ${argsOf(rest)}`.trim());
      const cb = rest.find((r) => typeof r === "function") as ((e: Error | null, o: string, s: string) => void) | undefined;
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

function fakeTerminal(): { out: NodeJS.WriteStream; input: NodeJS.ReadStream; written: string[] } {
  const written: string[] = [];
  const out = new EventEmitter() as unknown as NodeJS.WriteStream & { write: (s: string) => boolean };
  Object.assign(out, {
    isTTY: true,
    columns: 160,
    rows: 48,
    write: (s: string) => {
      written.push(s);
      // ALT_SCREEN_ON is the first byte of the first frame: from here the TUI
      // owns the screen, and everything external must already be behind it.
      const log = startupLog();
      if (log.paintedAt === undefined && s.includes("\x1b[?1049h")) {
        log.paintedAt = log.entries.length;
        log.entries.push("FIRST PAINT");
      }
      return true;
    },
  });
  const input = new EventEmitter() as unknown as NodeJS.ReadStream;
  Object.assign(input, { isTTY: true, setRawMode: () => input, resume: () => input, pause: () => input });
  return { out: out as NodeJS.WriteStream, input, written };
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

async function startTui(tmp: string, argv: string[] = ["--no-reload"]): Promise<Harness> {
  const { loadConfig } = await import("../src/config.js");
  const base = loadConfig(join(process.cwd(), "tests/fixtures/config.toml"));
  const config = {
    ...base,
    companion: {
      ...base.companion,
      enabled: true,
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

  const log = startupLog();
  log.entries.length = 0;
  log.paintedAt = undefined;

  const { out, input, written } = fakeTerminal();
  const startedAt = Date.now();
  const { runTui } = await import("../src/tui/index.js");
  const running = runTui(argv, { out, input, config, exit: () => {} });
  // Wait for the FRAME, not for a duration: the assertion is about ORDER. The
  // hard stop only keeps a regression from hanging the suite.
  for (let i = 0; i < 400 && log.paintedAt === undefined; i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
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
      await Promise.race([running, new Promise((r) => setTimeout(r, 15_000))]);
    },
  };
}

/** The first launch on a machine opens the key map over the board; any key
 * closes it, and the board is what is underneath. */
async function board(h: Harness): Promise<string> {
  h.written.length = 0;
  await h.press("\x1b");
  return h.frame();
}

describe("the first frame (ruling 6 — structural, not timed)", () => {
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
      console.warn(`first frame took ${h.paintMs}ms under vitest — over the 2000ms soft budget`);
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
    // into it (rulings 2 and 3).
    expect(frame).toMatch(/VM ssh|memory forward|companion container/);
    await h.stop();
  }, 40_000);

  it("triages the connection behind that frame, and `s` re-runs the check", async () => {
    const h = await startTui(tmp);
    await board(h);
    // The bring-up's triage has run by now: every probe is refused by the
    // mocked child_process, so the diagnosis lands on the missing-key class and
    // the board carries the exact command to run.
    for (let i = 0; i < 100; i++) {
      if (h.frame().includes("ssh-add")) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(h.frame()).toContain("ssh-add");

    // `s` re-runs it and reports the new outcome — no restart, and nothing
    // self-healing: the TUI ran the CHECK again, never the remedy.
    const probesBefore = h.log.entries.filter((e) => e.startsWith("execFile ssh")).length;
    expect(probesBefore).toBeGreaterThan(0);
    h.written.length = 0;
    await h.press("s");
    for (let i = 0; i < 100; i++) {
      if (h.log.entries.filter((e) => e.startsWith("execFile ssh")).length > probesBefore && h.frame().includes("ssh-add")) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(h.log.entries.filter((e) => e.startsWith("execFile ssh")).length).toBeGreaterThan(probesBefore);
    expect(h.frame()).toContain("ssh-add");
    // The remedy is never RUN for the operator: ruling 4 declined self-healing
    // explicitly. `ssh-add -l` is a read-only probe; `ssh-add <key>` and
    // `ssh -O exit` are the operator's to type.
    const ran = h.log.entries.filter((e) => /ssh-add\s+(?!-l\b)/.test(e) || /ssh\s+-O\s+exit/.test(e));
    expect(ran, `the TUI ran a remedy itself: ${ran.join(", ")}`).toEqual([]);
    await h.stop();
  }, 40_000);
});

// ---- ruling 4: three classes, three causes, three remedies -------------------

describe("connection triage", () => {
  const base = {
    host: "my-vm",
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
      connect: { ok: false, stderr: "my-vm: Permission denied (publickey).", timedOut: false },
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
    expect(d.remedy).toBe("ssh -O exit my-vm");
  });

  it("separates a genuinely unreachable host from both of those", async () => {
    const { classifyConnection } = await import("../src/tui/sshtriage.js");
    const d = classifyConnection({
      ...base,
      connect: { ok: false, stderr: "ssh: Could not resolve hostname my-vm: Name or service not known", timedOut: false },
    });
    expect(d.kind).toBe("host-unreachable");
    expect(d.cause).toContain("did not answer");
    expect(d.remedy).toBe("ssh -v my-vm true");
  });

  it("reads an empty agent as the key case even when ssh says nothing useful", async () => {
    const { classifyConnection } = await import("../src/tui/sshtriage.js");
    const d = classifyConnection({ ...base, agent: { reachable: true, identities: [] }, connect: { ok: false, stderr: "", timedOut: false } });
    expect(d.kind).toBe("no-agent-key");
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
            stdout: "hostname 10.0.0.5\nuser alice\nport 22\nidentityfile ~/.ssh/google_compute_engine\ncontrolpath /home/x/.ssh/cm-%r@%h:%p\n",
            stderr: "",
            timedOut: false,
          };
        }
        if (cmd === "ssh" && argv[0] === "-O") return { status: 255, stdout: "", stderr: "no such file", timedOut: false };
        if (cmd === "ssh-add") return { status: 1, stdout: "The agent has no identities.\n", stderr: "", timedOut: false };
        return { status: 255, stdout: "", stderr: "Permission denied (publickey).", timedOut: false };
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

// ---- ruling 3: progress in the column, and a stalled step that says so -------

describe("startup progress", () => {
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

  it("never lets a reporting failure break the bring-up it reports on", async () => {
    const { StartupProgress } = await import("../src/tui/startup.js");
    const p = new StartupProgress([{ key: "a", label: "alpha" }]);
    expect(() => p.done("does-not-exist")).not.toThrow();
    await expect(p.step("a", () => Promise.reject(new Error("boom")))).resolves.toBeUndefined();
    expect(p.steps()[0]).toMatchObject({ state: "failed", detail: "boom" });
    expect(p.settled()).toBe(true);
  });
});

describe("the companion column during startup", () => {
  const view = (over: Record<string, unknown> = {}) => ({
    header: { up: false, piUp: false, day: "2026-08-31", lastWake: "—", memory: "off" as const },
    lines: [] as string[],
    focused: false,
    collapsed: false,
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
    const mirroring = paintSidebar(view({ lines: ["pi> hello"], available: true }), 40, 14).join("\n");
    expect(mirroring).toContain("pi> hello");
    expect(mirroring).not.toContain("memory forward");
  });

  it("takes its width from config, not from docker (the answer)", async () => {
    const { CompanionSidebar, sidebarWidth } = await import("../src/tui/sidebar.js");
    const { COMPANION_DEFAULTS } = await import("../src/config.js");
    const docker = vi.fn(async () => ({ ok: false, stdout: "", stderr: "", code: 1 }));
    // Enabled by config, container not up yet: the column is SHOWN at its real
    // width while `available()` is still false, so nothing jumps when the
    // container arrives.
    const sb = new CompanionSidebar(COMPANION_DEFAULTS, docker, { enabled: () => true, available: () => false });
    expect(sb.shown()).toBe(true);
    expect(sb.available()).toBe(false);
    await sb.refresh();
    expect(docker, "the column must not ask docker anything to know its width").not.toHaveBeenCalled();
    expect(sidebarWidth(160, { collapsed: false, available: sb.shown() })).toBeGreaterThan(20);
    // --no-companion: no column at all, exactly as before.
    const off = new CompanionSidebar(COMPANION_DEFAULTS, docker, { enabled: () => false, available: () => false });
    expect(sidebarWidth(160, { collapsed: false, available: off.shown() })).toBe(0);
  });
});
