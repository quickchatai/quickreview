// The app's /selfimprove (src/selfimprove.ts, extensions/selfimprove.ts): the
// guided scan, then the findings and the fix loop to this session's agent.
// It is the app's, loaded by the app's own pi beside the plugin (`qcr pi`,
// tests/qcr-bin.test.ts); the plugin no longer has it (ADR 0001,
// tests/pi-plugin.test.ts). The scan is the plugin's own engine over a
// scratch git repo, with a fake case runner: nothing here runs a model, and
// no program but git.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createQuickReview } from "@quickchatai/pi-quickreview/extensions/quickreview.js";
import { ScanSessions, type ScanCommandDeps } from "@quickchatai/pi-quickreview/src/plugin/scan.js";
import type {
  PluginHost,
  Runner,
  SessionUi,
} from "@quickchatai/pi-quickreview/src/plugin/session.js";
import { createSelfImprove } from "../extensions/selfimprove.js";
import { runSelfImproveCommand, selfImproveBrief } from "../src/selfimprove.js";

const ROOT = join(import.meta.dirname, "..");
const tmp = mkdtempSync(join(tmpdir(), "selfimprove-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/** A runner that records every program asked for: the scan asks for none. */
function scriptedRunner(): Runner & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    which: (cmd) => (calls.push(cmd), null),
    run: async (cmd) => (calls.push(cmd), { code: 127, stdout: "", stderr: "" }),
  };
}

/** The scan's seams with a fake case runner: one finding per stage-1 case (or
 * none), the skeptic upholding nothing. */
function fakeScan(
  head: string,
  o: { none?: boolean } = {},
): ScanCommandDeps & { agents: string[] } {
  const agents: string[] = [];
  return {
    agents,
    root: () => ROOT,
    cases: () => ({
      run: async (spec) => {
        agents.push(spec.agent);
        if (spec.agent.startsWith("pass-validate") || o.none)
          return { ok: true, output: "NONE\n\nSUGGEST NONE\n", cost_usd: 0.01 };
        return {
          ok: true,
          cost_usd: 0.02,
          output: `FINDINGS pass-scan SCAN ${spec.id} @${head}\n- path: ${spec.files[0]}\n  line: 1\n  kind: bug\n  severity: P1\n  claim: it subtracts\n\nSUGGEST NONE\n`,
        };
      },
    }),
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
/** A host on a scratch git repo with code in two units and the rest. */
function fakeHost(runner: Runner): PluginHost & { head: string } {
  const dir = join(tmp, `host-${++n}`);
  const repo = join(dir, "repo");
  mkdirSync(join(repo, "app"), { recursive: true });
  writeFileSync(join(repo, "app", "a.py"), "def add(a, b):\n    return a - b\n");
  writeFileSync(join(repo, "main.py"), "import app\n");
  const git = (...args: string[]): string =>
    execFileSync(
      "git",
      [
        "-c",
        "user.name=T",
        "-c",
        "user.email=t@example.com",
        "-c",
        "commit.gpgsign=false",
        ...args,
      ],
      { cwd: repo, encoding: "utf8" },
    );
  git("init", "-q", "-b", "main");
  git("add", "-A");
  git("commit", "-q", "-m", "code");
  return {
    cwd: repo,
    env: { XDG_STATE_HOME: join(dir, "state"), XDG_CONFIG_HOME: join(dir, "config") },
    home: dir,
    piVersion: "1.4.0",
    agentDir: join(dir, "agent"),
    auth: {
      logins: () => ({ "openai-codex": { type: "oauth", expires: Date.now() + 10 * 3600_000 } }),
      configured: () => true,
      refresh: async () => {},
    },
    runner,
    shutdown: new AbortController().signal,
    head: git("rev-parse", "HEAD").trim(),
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
    const runner = scriptedRunner();
    const host = fakeHost(runner);
    const ui = fakeUi();
    const deps = fakeScan(host.head);
    await runSelfImproveCommand("", host, ui, { sessions: new ScanSessions(), deps });
    // the plugin's own scan engine ran it: no qcr, no other program
    expect(runner.calls).toEqual([]);
    expect(deps.agents.some((a) => a.startsWith("pass-scan"))).toBe(true);
    expect(ui.shown[0]).toMatch(/new findings?:/);
    expect(ui.told).toHaveLength(1);
    const brief = ui.told[0]!;
    expect(brief).toMatch(/qcr scan dismiss/);
    expect(brief).toMatch(/needs-owner/);
    expect(brief).toMatch(/\/selfimprove --delta --sha/);
    expect(brief).toMatch(/"fingerprint": "[0-9a-f]+"/);
    expect(brief).toMatch(/"claim": "it subtracts"/);
    expect(brief).toContain(host.cwd);
  });

  it("tells nobody anything when the scan finds nothing", async () => {
    const host = fakeHost(scriptedRunner());
    const ui = fakeUi();
    await runSelfImproveCommand("", host, ui, {
      sessions: new ScanSessions(),
      deps: fakeScan(host.head, { none: true }),
    });
    expect(ui.told).toHaveLength(0);
    expect(ui.shown[0]).toMatch(/nothing new/);
    expect(selfImproveBrief({ cwd: "/r", sha: null, findings: [], total: 3 })).toMatch(/0 of 3/);
  });

  it("takes the scan's flags only, and names itself in a usage error", async () => {
    const ui = fakeUi();
    await runSelfImproveCommand("findings", fakeHost(scriptedRunner()), ui);
    expect(ui.notes[0]).toMatch(/takes the scan's flags only/);
    const bad = fakeUi();
    await runSelfImproveCommand("--wat", fakeHost(scriptedRunner()), bad);
    expect(bad.notes[0]).toMatch(/usage: \/selfimprove/);
    expect(bad.notes[0]).not.toMatch(/qcr-scan/);
  });

  // MUTATION: drop the registerCommand from createSelfImprove — the app's pi
  // has no /selfimprove, and this fails.
  it("is registered by the app's extension, and by no part of the plugin", () => {
    const app = fakePi();
    createSelfImprove({ env: {}, home: tmp, runner: scriptedRunner(), print: () => {} })(app.api);
    expect([...app.commands.keys()]).toEqual(["selfimprove"]);
    const plugin = fakePi();
    createQuickReview({
      env: {},
      home: tmp,
      runner: scriptedRunner(),
      print: () => {},
      piVersion: "1.4.0",
      range: "^1.4.0",
    })(plugin.api);
    expect(plugin.commands.has("selfimprove")).toBe(false);
  });
});
