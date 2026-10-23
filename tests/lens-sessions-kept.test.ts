// P5.9 (D10): the lens passes of an engine round keep their session JSONL under
// the round's dir, so a finished lens opens in pi (`qcr open --lens`). The real pi
// SDK on pi-ai's faux provider: no model, no network. Pinned: a file per pass under
// `<sessionsDir>/<run id>/` that pi's SessionManager opens under the id in its
// header; passes of one cache group share a session id and still write files of
// their own; a retried pass opens on its last attempt; no sessionsDir, no files;
// the warm-up keeps none; and the host takes a session id with a session dir.
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createBashGuard } from "@quickchatai/pi-quickreview/extensions/bash-guard.js";
import { loadBuiltAgents } from "@quickchatai/pi-quickreview/src/engine/lens/registry.js";
import {
  createLensRunner,
  type LensRunConfig,
} from "@quickchatai/pi-quickreview/src/engine/lens/runlens.js";
import {
  LENS_SESSIONS_DIR,
  lensAgentsOf,
  lensSessionsOf,
} from "@quickchatai/pi-quickreview/src/engine/openable.js";
import { createHostRig, useOfflineGuard, type HostRig } from "./pi-canary/harness.js";

useOfflineGuard();

let rig: HostRig;
let dir: string;
beforeEach(async () => {
  rig = await createHostRig();
  dir = mkdtempSync(join(tmpdir(), "lens-kept-"));
  mkdirSync(join(dir, "agents"));
  for (const a of ["pass-a", "pass-b", "pass-c"])
    writeFileSync(
      join(dir, "agents", `${a}.md`),
      `---\nname: ${a}\ndescription: ${a} lens\nmodel: faux/faux-1\ntools: read, bash\n---\nYou are ${a}.\n`,
    );
});
afterEach(() => {
  rig.close();
  rmSync(dir, { recursive: true, force: true });
});

const round = (): string => join(dir, "round");

function config(over: Partial<LensRunConfig> = {}): LensRunConfig {
  return {
    host: rig.host,
    permits: 4,
    registry: loadBuiltAgents(join(dir, "agents")),
    cwd: dir,
    env: { PATH: process.env["PATH"], HOME: dir },
    bashGuard: createBashGuard({ sandboxRoot: dir, replay: false, secretDirs: [] }),
    ledgerPath: join(round(), "lens-ledger.jsonl"),
    sessionsDir: join(round(), LENS_SESSIONS_DIR),
    sessionGapMs: 0,
    ...over,
  };
}

const header = (file: string): { type: string; version: number; id: string } =>
  JSON.parse(readFileSync(file, "utf8").split("\n", 1)[0]!) as never;

describe("[runLens] the session is kept (D10)", () => {
  it("writes one JSONL per pass under its run id, which pi opens under the id in its header", async () => {
    rig.faux.setResponses([fauxAssistantMessage("a: nothing"), fauxAssistantMessage("b: nothing")]);
    const runner = createLensRunner(config());
    const runs = await Promise.all([
      runner.run({ agent: "pass-a", task: "look at a" }),
      runner.run({ agent: "pass-b", task: "look at b" }),
    ]);
    const kept = lensSessionsOf(round());
    expect(kept.map((k) => k.id).sort()).toEqual(runs.map((r) => r.result.id!).sort());
    for (const k of kept) {
      const h = header(k.file);
      expect(h).toMatchObject({ type: "session", version: 3 });
      // the file is a session pi can open, and it opens under the same id
      expect(SessionManager.open(k.file).getSessionId()).toBe(h.id);
      expect(readFileSync(k.file, "utf8")).toContain("Task: look at");
    }
    // the ledger names the same ids, so `--lens pass-a` resolves
    const agents = lensAgentsOf(round());
    expect([...agents.values()].sort()).toEqual(["pass-a", "pass-b"]);
  });

  it("keeps nothing when no sessions dir is configured", async () => {
    rig.faux.setResponses([fauxAssistantMessage("ok")]);
    const runner = createLensRunner(config({ sessionsDir: undefined }));
    await runner.run({ agent: "pass-a", task: "x" });
    expect(lensSessionsOf(round())).toEqual([]);
    expect(readdirSync(round())).toEqual(["lens-ledger.jsonl"]);
  });

  it("passes of one cache group share a session id and each keep a file of their own", async () => {
    rig.faux.setResponses(Array.from({ length: 4 }, () => fauxAssistantMessage("ok")));
    const runner = createLensRunner(config({ cache: { size: 3, staggerMs: 0 } }));
    const runs = await Promise.all(
      ["pass-a", "pass-b", "pass-c"].map((agent) => runner.run({ agent, task: "x" })),
    );
    const kept = lensSessionsOf(round());
    expect(kept).toHaveLength(3);
    expect(new Set(kept.map((k) => header(k.file).id)).size).toBe(1);
    expect(new Set(kept.map((k) => k.file)).size).toBe(3);
    expect(kept.map((k) => k.id).sort()).toEqual(runs.map((r) => r.result.id!).sort());
  });

  it("a pass the deadline retried opens on its last attempt", async () => {
    rig.faux.setResponses([
      async (_c, options) => {
        await new Promise<void>((resolve) => {
          const s = options?.signal;
          if (!s || s.aborted) return resolve();
          s.addEventListener("abort", () => resolve(), { once: true });
        });
        return fauxAssistantMessage("late");
      },
      fauxAssistantMessage("second time lucky"),
    ]);
    const runner = createLensRunner(config({ deadlineMs: 150 }));
    const run = await runner.run({ agent: "pass-a", task: "slow" });
    expect(run.result.exitCode).toBe(0);
    const dirOfPass = join(round(), LENS_SESSIONS_DIR, run.result.id!);
    const files = readdirSync(dirOfPass).filter((f) => f.endsWith(".jsonl"));
    expect(files.length).toBeGreaterThanOrEqual(1);
    const [only] = lensSessionsOf(round());
    expect(readFileSync(only!.file, "utf8")).toContain("second time lucky");
  });
});

describe("[pisdk] a session id with a session dir", () => {
  it("names the header's id, and the file is <time>_<id>.jsonl", async () => {
    const sessionDir = join(dir, "sd");
    const s = await rig.host.makeSession({
      cwd: dir,
      env: {},
      model: "faux/faux-1",
      sessionId: "cache-group-1",
      persist: { sessionDir },
    });
    rig.faux.setResponses([fauxAssistantMessage("hi")]);
    await s.prompt("hello");
    const file = s.sessionFile!;
    expect(s.sessionId).toBe("cache-group-1");
    expect(file.endsWith("_cache-group-1.jsonl")).toBe(true);
    expect(header(file).id).toBe("cache-group-1");
    s.dispose();
  });

  it("still refuses a session id with a session file, a resume or a manager", async () => {
    const base = { cwd: dir, env: {}, model: "faux/faux-1", sessionId: "x" };
    await expect(
      rig.host.makeSession({ ...base, persist: { sessionFile: join(dir, "f.jsonl") } }),
    ).rejects.toThrow(/sessionId names a new session/);
    await expect(
      rig.host.makeSession({ ...base, persist: { resumeFile: join(dir, "f.jsonl") } }),
    ).rejects.toThrow(/sessionId names a new session/);
    await expect(
      rig.host.makeSession({ ...base, sessionManager: SessionManager.inMemory(dir) }),
    ).rejects.toThrow(/sessionId names a new session/);
  });
});
