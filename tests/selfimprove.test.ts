// The app's /selfimprove (src/selfimprove.ts, extensions/selfimprove.ts): the
// guided scan, then the findings and the fix loop to this session's agent.
// It is the app's, loaded by the app's own pi beside the plugin (`qcr pi`,
// tests/qcr-bin.test.ts); the plugin no longer has it (ADR 0001,
// tests/pi-plugin.test.ts). Every program is a scripted fake runner: nothing
// here spawns a process.
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createQuickReview } from "@quickchatai/pi-quickreview/extensions/quickreview.js";
import type {
  PluginHost,
  Runner,
  RunResult,
  SessionUi,
} from "@quickchatai/pi-quickreview/src/plugin/session.js";
import { createSelfImprove } from "../extensions/selfimprove.js";
import { runSelfImproveCommand, selfImproveBrief } from "../src/selfimprove.js";

const tmp = mkdtempSync(join(tmpdir(), "selfimprove-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const ok = (o: unknown): RunResult => ({ code: 0, stdout: JSON.stringify(o) + "\n", stderr: "" });
const FINDING = {
  fingerprint: "fp1",
  file: "src/a.ts",
  range: { start: 3, end: 3 },
  lens: "pass-baseline",
  severity: "P1",
  claim: "a subtracts",
};
const scanAnswers: Record<string, RunResult> = {
  "qcr scan preview": ok({
    ok: true,
    preview: { files: 4, mode: "full", estimate_usd: 1.5, cap_usd: 3 },
    start: ["--key", "k1", "--sha", "abc"],
  }),
  "qcr scan start": ok({ ok: true, run: { id: "r1" } }),
  "qcr scan status": ok({ ok: true, run: { sha: "abcdef1234567890", display: "complete" } }),
  "qcr scan findings": ok({ ok: true, total: 1, findings: [FINDING] }),
};

/** A runner that answers `qcr scan` calls from a script and logs them. */
function scriptedRunner(answers: Record<string, RunResult>): Runner & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    which: (cmd) => (cmd === "qcr" ? "/bin/qcr" : null),
    run: async (cmd, args) => {
      calls.push([cmd, ...args]);
      const key = [cmd.replace("/bin/", ""), ...args.filter((a) => !a.startsWith("--"))]
        .slice(0, 3)
        .join(" ");
      return answers[key] ?? { code: 0, stdout: "", stderr: "" };
    },
  };
}

function fakeUi(): SessionUi & { notes: string[]; shown: string[]; told: string[] } {
  const notes: string[] = [];
  const shown: string[] = [];
  const told: string[] = [];
  return {
    mode: "tui",
    interactive: true,
    select: async () => undefined,
    confirm: async () => true,
    notify: (m) => notes.push(m),
    status: () => {},
    onEscape: () => () => {},
    show: (m) => shown.push(m),
    tellAgent: (t) => told.push(t),
    print: () => {},
    notes,
    shown,
    told,
  };
}

let n = 0;
function fakeHost(runner: Runner): PluginHost {
  const dir = join(tmp, `host-${++n}`);
  mkdirSync(join(dir, "repo"), { recursive: true });
  return {
    cwd: join(dir, "repo"),
    env: { XDG_STATE_HOME: join(dir, "state"), XDG_CONFIG_HOME: join(dir, "config") },
    home: dir,
    piVersion: "1.4.0",
    agentDir: join(dir, "agent"),
    auth: { logins: () => ({}), configured: () => true, refresh: async () => {} },
    runner,
    shutdown: new AbortController().signal,
  };
}

/** A pi that records the commands an extension registers. */
function fakePi(): { api: ExtensionAPI; commands: Map<string, unknown> } {
  const commands = new Map<string, unknown>();
  const api = {
    registerCommand: (name: string, o: unknown) => commands.set(name, o),
    registerTool: () => {},
    on: () => () => {},
    sendMessage: () => {},
    sendUserMessage: () => {},
    getSettings: () => ({}),
  };
  return { api: api as unknown as ExtensionAPI, commands };
}

describe("/selfimprove, the app's", () => {
  // The engine scans; the person's own agent fixes.
  it("hands this session's agent the findings and the fix loop", async () => {
    const runner = scriptedRunner(scanAnswers);
    const host = fakeHost(runner);
    const ui = fakeUi();
    await runSelfImproveCommand("", host, ui);
    expect(runner.calls.map((c) => c.slice(1, 3).join(" "))).toEqual([
      "scan preview",
      "scan start",
      "scan status",
      "scan findings",
    ]);
    expect(ui.told).toHaveLength(1);
    const brief = ui.told[0]!;
    expect(brief).toMatch(/qcr scan dismiss/);
    expect(brief).toMatch(/needs-owner/);
    expect(brief).toMatch(/\/selfimprove --delta --sha/);
    expect(brief).toMatch(/"fingerprint": "fp1"/);
    expect(brief).toContain(host.cwd);
  });

  it("tells nobody anything when the scan finds nothing", async () => {
    const runner = scriptedRunner({
      ...scanAnswers,
      "qcr scan findings": ok({ ok: true, total: 0, findings: [] }),
    });
    const ui = fakeUi();
    await runSelfImproveCommand("", fakeHost(runner), ui);
    expect(ui.told).toHaveLength(0);
    expect(ui.shown[0]).toMatch(/nothing new/);
    expect(selfImproveBrief({ cwd: "/r", sha: null, findings: [], total: 3 })).toMatch(/0 of 3/);
  });

  it("takes the scan's flags only, and names itself in a usage error", async () => {
    const ui = fakeUi();
    await runSelfImproveCommand("findings", fakeHost(scriptedRunner({})), ui);
    expect(ui.notes[0]).toMatch(/takes the scan's flags only/);
    const bad = fakeUi();
    await runSelfImproveCommand("--wat", fakeHost(scriptedRunner({})), bad);
    expect(bad.notes[0]).toMatch(/usage: \/selfimprove/);
    expect(bad.notes[0]).not.toMatch(/qcr-scan/);
  });

  // MUTATION: drop the registerCommand from createSelfImprove — the app's pi
  // has no /selfimprove, and this fails.
  it("is registered by the app's extension, and by no part of the plugin", () => {
    const app = fakePi();
    createSelfImprove({ env: {}, home: tmp, runner: scriptedRunner({}), print: () => {} })(app.api);
    expect([...app.commands.keys()]).toEqual(["selfimprove"]);
    const plugin = fakePi();
    createQuickReview({
      env: {},
      home: tmp,
      runner: scriptedRunner({}),
      print: () => {},
      piVersion: "1.4.0",
      range: "^1.4.0",
    })(plugin.api);
    expect(plugin.commands.has("selfimprove")).toBe(false);
  });
});
