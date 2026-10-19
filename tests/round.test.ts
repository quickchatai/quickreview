// The review round (src/engine/round.ts runRound) on both runtimes: the process
// runtime over a fake `pi` shell script, and the SDK runtime over pi-ai's faux
// provider (the real SDK, no network, no model). The same scenarios run on each:
// the round neither knows nor cares which hosts the session.
//
// What differs by construction is how the follow-up travels: the process
// runtime respawns pi with `--continue`, the SDK runtime sends a second turn on
// the live session. The tests that count sessions say so.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { AuthExpiring } from "../src/engine/auth.js";
import { LIVE_MAIN_FILE, liveRoundDir, readLiveEvents } from "../src/live/events.js";
import { projectRoundProgress } from "../src/live/projection.js";
import { PiHost } from "../src/engine/pisdk.js";
import type { Runtime } from "../src/engine/port.js";
import { procRuntime } from "../src/engine/procruntime.js";
import { runRound, type RoundSpec } from "../src/engine/round.js";
import { roundSdkExtras } from "../src/engine/roundsdk.js";
import { sdkRuntime } from "../src/engine/sdkruntime.js";
import { pricedFaux } from "./helpers/priced-faux.js";
import {
  FILES,
  FIXTURE_CONFIG,
  OUTCOME,
  RECORD,
  TARGET,
  mkRoot,
  mkTree,
} from "./helpers/round-rig.js";
import { useOfflineGuard } from "./pi-canary/harness.js";

vi.stubEnv("QCR_CONFIG", FIXTURE_CONFIG);
const { benchConfig } = await import("../src/bench/runner.js");
const { ecosystemFor } = await import("../src/ecosystem.js");

useOfflineGuard();

const tmp = mkdtempSync(join(tmpdir(), "round-"));
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

/** What the model does in one turn: the files it writes into the round's out dir
 * (name -> text), the price pi reports for the turn, and whether it then hangs
 * (a tool call that outlasts the test unless something stops it). */
interface Turn {
  write?: Record<string, string>;
  cost?: number;
  hang?: boolean;
  /** A line pi prints to stderr during the turn (a process runtime only). */
  stderr?: string;
  /** The provider fails the turn's message with this text. */
  errorMessage?: string;
}

interface Built {
  runtime: Runtime;
  /** Sessions the round asked the runtime for. */
  created: () => number;
  /** Turns the model was asked for, whatever hosted them. */
  turns: () => number;
  /** Frees what the runtime held. */
  close: () => void;
}

interface Harness {
  name: "proc" | "sdk";
  model: string;
  build(outDir: string, turns: Turn[]): Promise<Built>;
}

// ---- the process runtime over a fake pi ------------------------------------------

function fakePi(outDir: string, turns: Turn[], dir: string): Built {
  const calls = join(dir, "calls");
  const bin = join(dir, "pi");
  const branch = (t: Turn): string[] => [
    ...Object.entries(t.write ?? {}).map(
      ([f, text]) => `printf '%s' ${JSON.stringify(text)} > ${JSON.stringify(join(outDir, f))}`,
    ),
    ...(t.stderr ? [`echo ${JSON.stringify(t.stderr)} >&2`] : []),
    `echo '${JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        ...(t.errorMessage ? { stopReason: "error", errorMessage: t.errorMessage } : {}),
        usage: { input: 100, output: 10, cacheRead: 5, cost: { total: t.cost ?? 0.25 } },
      },
    })}'`,
    ...(t.hang ? ["sleep 60"] : []),
  ];
  writeFileSync(
    bin,
    [
      "#!/bin/sh",
      "cat > /dev/null",
      `echo "$*" >> ${JSON.stringify(calls)}`,
      'sd=""; prev=""; for a in "$@"; do [ "$prev" = "--session-dir" ] && sd="$a"; prev="$a"; done',
      'mkdir -p "$sd"; echo \'{"type":"session"}\' > "$sd/s.jsonl"',
      'case "$*" in',
      `  *--continue*) ${branch(turns[1] ?? turns[0]!).join("; ")} ;;`,
      `  *) ${branch(turns[0]!).join("; ")} ;;`,
      "esac",
      "",
    ].join("\n"),
  );
  chmodSync(bin, 0o755);
  const inner = procRuntime({ bin });
  let created = 0;
  return {
    runtime: {
      create: (s) => (created++, inner.create(s)),
      resume: (f, s) => inner.resume(f, s),
    },
    created: () => created,
    turns: () => (existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n").length : 0),
    close: () => {},
  };
}

const proc: Harness = {
  name: "proc",
  model: "openai-codex/gpt-6.1-sol",
  async build(outDir, turns) {
    const dir = join(tmp, `proc-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir);
    return fakePi(outDir, turns, dir);
  },
};

// ---- the SDK runtime over the faux provider --------------------------------------

const sdk: Harness = {
  name: "sdk",
  model: "faux/m",
  async build(outDir, turns) {
    let asked = 0;
    // Each message carries the price of the turn it belongs to.
    const faux = pricedFaux(
      () => turns[Math.min(Math.max(asked - 1, 0), turns.length - 1)]!.cost ?? 0.25,
      { provider: "faux", models: [{ id: "m" }] },
    );
    // One response per turn: the model writes its files, then answers (or, on a
    // hanging turn, asks for a tool call that outlasts the test).
    faux.appendResponses(
      turns.map((t) => async () => {
        asked++;
        for (const [f, text] of Object.entries(t.write ?? {})) {
          mkdirSync(dirname(join(outDir, f)), { recursive: true });
          writeFileSync(join(outDir, f), text);
        }
        return t.hang
          ? fauxAssistantMessage([fauxToolCall("bash", { command: "sleep 60" })], {
              stopReason: "toolUse",
            })
          : t.errorMessage
            ? fauxAssistantMessage("", { stopReason: "error", errorMessage: t.errorMessage })
            : fauxAssistantMessage("done");
      }),
    );
    const agentDir = join(tmp, `sdk-agent-${Math.random().toString(36).slice(2)}`);
    const host = await PiHost.create({
      agentDir,
      settings: { compaction: { enabled: false }, retry: { enabled: false } },
      configureModels: (r) => {
        r.registerNativeProvider(faux.provider);
      },
    });
    const inner = sdkRuntime(host, { extras: roundSdkExtras() });
    let created = 0;
    return {
      runtime: {
        create: (s) => (created++, inner.create(s)),
        resume: (f, s) => inner.resume(f, s),
      },
      created: () => created,
      turns: () => asked,
      close: () => host.dispose(),
    };
  },
};

// ---- the scenarios -----------------------------------------------------------------

let n = 0;
const built: Built[] = [];
afterEach(() => {
  for (const b of built.splice(0)) b.close();
});

async function run(
  h: Harness,
  turns: Turn[],
  over: Partial<RoundSpec> = {},
): Promise<{ result: Awaited<ReturnType<typeof runRound>>; outDir: string; b: Built }> {
  const id = `${h.name}-${n++}`;
  const outDir = join(tmp, `out-${id}`);
  const cfg = benchConfig("");
  cfg.models.conversation = h.model;
  const b = await h.build(outDir, turns);
  built.push(b);
  const result = await runRound(
    {
      root: mkRoot(tmp, `root-${id}`),
      agentDir: join(tmp, "agent"),
      tree: mkTree(tmp, `tree-${id}`),
      files: FILES,
      target: TARGET,
      outDir,
      cfg,
      ecosystem: ecosystemFor("none"),
      timeoutMs: 10 * 60_000,
      ...over,
    },
    b.runtime,
  );
  return { result, outDir, b };
}

const FULL = { "findings-record.json": RECORD, "outcome.json": OUTCOME };

describe.each([proc, sdk])("runRound on the $name runtime", (h) => {
  it("runs one session end to end and returns findings, the rendered review and the cost", async () => {
    const { result: r, outDir, b } = await run(h, [{ write: FULL, cost: 0.25 }]);
    expect(b.created()).toBe(1);
    expect(b.turns()).toBe(1);
    expect(r.continued).toBe(false);
    expect(r.error).toBeUndefined();
    expect(r.outcome).toMatchObject({ verdict: "REQUEST_CHANGES" });
    expect((r.findings as { findings: unknown[] }).findings).toHaveLength(1);
    expect(r.review).toBe(readFileSync(join(outDir, "review.md"), "utf8"));
    expect(r.costUsd).toBeCloseTo(0.25);
    expect(r.plannedLenses.length).toBeGreaterThan(0);
    // The round's own artifacts, and the stream and stages a scorer reads.
    for (const f of [
      "system-prompt.md",
      "round-order.md",
      "files.json",
      "pi-events.jsonl",
      "stages.json",
    ])
      expect(existsSync(join(outDir, f)), f).toBe(true);
  });

  it("sends ONE follow-up on the same session when the findings record is missing", async () => {
    const { result: r, b } = await run(h, [
      { write: { "outcome.json": OUTCOME } },
      { write: { "findings-record.json": RECORD } },
    ]);
    expect(r.continued).toBe(true);
    expect(b.turns()).toBe(2);
    // One session for both turns on the SDK; a respawn is a second pi process
    // on the process runtime, but still ONE session object.
    expect(b.created()).toBe(1);
    expect((r.findings as { findings: unknown[] }).findings).toHaveLength(1);
    expect(typeof r.review).toBe("string");
  });

  it("never sends a second follow-up", async () => {
    const { result: r, b } = await run(h, [{}, {}, { write: FULL }]);
    expect(r.continued).toBe(true);
    expect(b.turns()).toBe(2);
    expect(r.outcome).toBeUndefined();
    expect(r.review).toBeNull();
  });

  it("stops hard once the session's spend reaches capUsd, with no follow-up", async () => {
    const t0 = Date.now();
    const { result: r, b } = await run(h, [{ cost: 5, hang: true }, { write: FULL }], {
      capUsd: 1,
    });
    expect(Date.now() - t0).toBeLessThan(60_000);
    expect(r.capped).toBe(true);
    expect(r.continued).toBe(false);
    expect(b.turns()).toBe(1);
    expect(r.costUsd).toBeGreaterThanOrEqual(5);
  }, 90_000);

  it("a run under capUsd is not capped", async () => {
    const { result: r } = await run(h, [{ write: FULL }], { capUsd: 1 });
    expect(r.capped).toBe(false);
  });

  it("leaves the main session's JSONL under the out dir for a reader to open", async () => {
    const { outDir } = await run(h, [{ write: FULL }]);
    const sessions = readdirSync(join(outDir, "session")).filter((f) => f.endsWith(".jsonl"));
    expect(sessions).toHaveLength(1);
  });

  it("names a refused login: typed on the result, and as the error when nothing was written", async () => {
    const { result: r } = await run(h, [
      { errorMessage: "401 Unauthorized: invalid_grant (the token is revoked)" },
      {},
    ]);
    expect(r.authError?.code).toBe("rejected");
    expect(r.authError?.message).toMatch(/invalid_grant/);
    expect(r.outcome).toBeUndefined();
    expect(r.error).toMatch(/refused the login/);
  });

  it("reads a refusal pi printed to stderr (the process runtime's other channel)", async () => {
    if (h.name !== "proc") return;
    const { result: r } = await run(h, [{ stderr: "Error: 401 Unauthorized" }, {}]);
    expect(r.authError?.code).toBe("rejected");
  });

  it("does not take an auth-looking tool output for a refusal", async () => {
    const { result: r } = await run(h, [{ write: FULL }]);
    expect(r.authError).toBeUndefined();
  });

  it("writes the round's LiveEvent log when asked, numbered and in order", async () => {
    const live = { root: join(tmp, `live-${h.name}-${n++}`), key: "review-x", round: 3 };
    const { result: r } = await run(h, [{ write: FULL, cost: 0.25 }], { live });
    expect(r.error).toBeUndefined();
    const events = readLiveEvents(
      join(liveRoundDir(live.root, live.key, live.round), LIVE_MAIN_FILE),
    ).events;
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1));
    expect(events[0]).toMatchObject({
      type: "session_start",
      stream: "main",
      key: "review-x",
      round: 3,
      pr: TARGET.number,
      session: `oneshot-${TARGET.number}`,
    });
    const ends = events.filter((e) => e.type === "message_end");
    expect(ends.length).toBeGreaterThan(0);
    expect(ends.at(-1)).toMatchObject({ role: "assistant", usage: { cost_usd: 0.25 } });
    if (h.name === "sdk") {
      // the SDK session streams the whole lifecycle: the projection settles
      const types = events.map((e) => e.type);
      expect(types).toContain("agent_start");
      expect(types.at(-1)).toBe("agent_settled");
      expect(projectRoundProgress(events)?.snapshot).toMatchObject({
        version: 2,
        pr: TARGET.number,
        parent_status: "settled",
      });
    }
  });

  it("writes no live log unless asked", async () => {
    const { outDir } = await run(h, [{ write: FULL }]);
    expect(existsSync(join(outDir, "state"))).toBe(false);
  });

  it("refuses a login that would expire inside the run, before writing anything", async () => {
    const outDir = join(tmp, `out-auth-${h.name}`);
    const cfg = benchConfig("");
    cfg.models.conversation = h.model;
    const rt: Runtime = {
      create: () => Promise.reject(new Error("no session may start")),
      resume: () => Promise.reject(new Error("no session may start")),
    };
    await expect(
      runRound(
        {
          root: mkRoot(tmp, `root-auth-${h.name}`),
          agentDir: join(tmp, "agent"),
          tree: mkTree(tmp, `tree-auth-${h.name}`),
          files: FILES,
          target: TARGET,
          outDir,
          cfg,
          ecosystem: ecosystemFor("none"),
          timeoutMs: 10 * 60_000,
          auth: { expiresAt: Date.now() + 60_000, provider: "openai-codex" },
        },
        rt,
      ),
    ).rejects.toBeInstanceOf(AuthExpiring);
    expect(existsSync(outDir)).toBe(false);
  });
});
