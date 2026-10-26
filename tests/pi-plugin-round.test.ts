// One whole review round through the pi plugin's /review, in this process, on
// pi-ai's faux provider: the production pipeline (the core's review()), the
// SDK host built the way the plugin builds it inside a user's pi (hostPi: pi's
// dispatcher reused, never installed; no turn owns the process), the
// borrowed login's refresh-disabled copy, and the result shown in the session
// and kept under the state home. No network, no cost; git runs for the
// scratch repo. A second round runs one lens on the engine route and watches
// the round's LiveEvent log while the lens is still working: its current tool,
// the file that tool is on and its tool count reach the round-progress
// projection as they happen, not only when the lens ends.
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import {
  engineLensConfig,
  reviewSdkRuntime,
} from "@quickchatai/pi-quickreview/src/engine/reviewsdk.js";
import { loadBuiltAgents } from "@quickchatai/pi-quickreview/src/engine/lens/registry.js";
import { LIVE_MAIN_FILE, readLiveEvents } from "@quickchatai/pi-quickreview/src/live/events.js";
import { projectRoundProgress } from "@quickchatai/pi-quickreview/src/live/projection.js";
import { lensActivityLine } from "@quickchatai/pi-quickreview/src/live/lensline.js";
import type { LiveAgentProgress } from "@quickchatai/pi-quickreview/src/round-progress.js";
import { PiHost, type PiHostOptions } from "@quickchatai/pi-quickreview/src/engine/pisdk.js";
import {
  REVIEW_DEPS,
  REVIEW_MESSAGE,
  runReviewCommand,
} from "@quickchatai/pi-quickreview/src/plugin/review.js";
import type { PluginHost, SessionUi } from "@quickchatai/pi-quickreview/src/plugin/session.js";
import { pricedFaux } from "./helpers/priced-faux.js";
import { waitFor } from "./helpers/wait-for.js";

const ROOT = resolve(import.meta.dirname, "..");
const tmp = mkdtempSync(join(tmpdir(), "pi-plugin-round-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const git = (cwd: string, ...args: string[]): void =>
  void execFileSync(
    "git",
    ["-c", "user.name=T", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args],
    { cwd, stdio: "ignore" },
  );

const findings = [
  {
    path: "src/a.ts",
    line: 2,
    severity: "P2",
    title: "b is a magic number",
    disposition: "posted",
  },
  { path: "src/a.ts", line: 3, severity: "P0", title: "c breaks the build", disposition: "posted" },
];

describe("/review: one faux round inside the host pi", () => {
  it("reviews the branch, shows the review in the session and keeps its JSON", async () => {
    const repo = join(tmp, "repo");
    mkdirSync(join(repo, "src"), { recursive: true });
    git(repo, "init", "-q", "-b", "main");
    writeFileSync(join(repo, "src", "a.ts"), "export const a = 1;\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "base");
    git(repo, "checkout", "-q", "-b", "feature");
    writeFileSync(
      join(repo, "src", "a.ts"),
      "export const a = 1;\nexport const b = 2;\nexport const c = 3;\n",
    );
    git(repo, "commit", "-q", "-am", "add b and c");
    writeFileSync(join(repo, ".git", "qcr-review.json"), JSON.stringify({ auto_limit_usd: 1000 }));

    const config = join(tmp, "config.toml");
    writeFileSync(
      config,
      readFileSync(join(ROOT, "tests", "fixtures", "config.toml"), "utf8").replace(
        /^conversation = .*$/m,
        'conversation = "faux/m"',
      ),
    );
    const state = join(tmp, "state");
    const runsDir = join(state, "qcr", "default", "review", "runs");
    const faux = pricedFaux(() => 0.25, { provider: "faux", models: [{ id: "m" }] });
    faux.appendResponses([
      async () => {
        // the model writes its files into the run's out dir, beside the order
        for (const d of readdirSync(runsDir))
          for (const e of readdirSync(join(runsDir, d), { recursive: true }))
            if (String(e).endsWith("round-order.md")) {
              const out = dirname(join(runsDir, d, String(e)));
              writeFileSync(
                join(out, "findings-record.json"),
                JSON.stringify({ findings, verdict: "REQUEST_CHANGES" }),
              );
              writeFileSync(
                join(out, "outcome.json"),
                JSON.stringify({ verdict: "REQUEST_CHANGES", passes: [] }),
              );
            }
        return fauxAssistantMessage("done");
      },
    ]);

    let built: PiHostOptions | undefined;
    let host: PiHost | undefined;
    const shown: string[] = [];
    const notes: string[] = [];
    const ui: SessionUi = {
      mode: "tui",
      interactive: true,
      select: async (_t, options) => options[0],
      confirm: async () => true,
      notify: (m) => notes.push(m),
      status: () => {},
      onEscape: () => () => {},
      show: (m) => shown.push(m),
      tellAgent: () => {},
      print: () => {},
    };
    const pluginHost: PluginHost = {
      cwd: repo,
      env: { PATH: process.env.PATH, QCR_CONFIG: config, XDG_STATE_HOME: state },
      home: tmp,
      piVersion: "1.4.0",
      agentDir: join(tmp, "host-agent"),
      auth: { logins: () => ({}), configured: () => true, refresh: async () => {} },
      runner: { which: () => null, run: async () => ({ code: 1, stdout: "", stderr: "" }) },
      shutdown: new AbortController().signal,
    };
    await runReviewCommand("", pluginHost, ui, {
      ...REVIEW_DEPS,
      runtime: (_cfg, o) =>
        reviewSdkRuntime({
          ...o,
          lens: () => ({ factories: [], toolNames: [] }),
          makeHost: async (ho) => {
            built = ho;
            host = await PiHost.create({
              ...ho,
              configureModels: (r) => {
                r.registerNativeProvider(faux.provider);
              },
            });
            return host;
          },
        }),
    });

    // built the way the plugin builds it inside pi
    expect(built?.hostPi).toBe(true);
    expect(built?.ownsProcess).toBe(false);
    expect(host?.dispatcher).toBe("reused");
    // the run's private agent dir, never the host pi's
    expect(built?.agentDir).not.toBe(pluginHost.agentDir);
    expect(built?.agentDir.startsWith(runsDir)).toBe(true);
    // the review, in the session
    const review = shown.join("\n");
    expect(review, notes.join("\n")).toMatch(/c breaks the build/);
    expect(review).toMatch(/b is a magic number/);
    // and its JSON, under the state home
    const run = readdirSync(runsDir).find((d) => existsSync(join(runsDir, d, "review.json")));
    expect(run).toBeDefined();
    const data = JSON.parse(readFileSync(join(runsDir, run!, "review.json"), "utf8")) as {
      schema_version: number;
      ok: boolean;
    };
    expect(data.schema_version).toBe(1);
    expect(data.ok).toBe(true);
    expect(REVIEW_MESSAGE).toBe("qcr-review");
  });
});

/** A scratch repo on a feature branch, its review allowed to spend. */
function scratchRepo(name: string): string {
  const repo = join(tmp, name);
  mkdirSync(join(repo, "src"), { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "src", "a.ts"), "export const a = 1;\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "base");
  git(repo, "checkout", "-q", "-b", "feature");
  writeFileSync(join(repo, "src", "a.ts"), "export const a = 1;\nexport const b = 2;\n");
  git(repo, "commit", "-q", "-am", "add b");
  writeFileSync(join(repo, ".git", "qcr-review.json"), JSON.stringify({ auto_limit_usd: 1000 }));
  return repo;
}

/** Every file under `dir` with this name. */
const filesNamed = (dir: string, name: string): string[] => {
  try {
    return readdirSync(dir, { recursive: true })
      .map(String)
      .filter((e) => e.endsWith(`/${name}`) || e === name)
      .map((e) => join(dir, e));
  } catch {
    return [];
  }
};

/** The lens rows of the round's main log, projected as `qcr review status` does. */
function projectedLenses(runsDir: string): LiveAgentProgress[] {
  const log = filesNamed(runsDir, LIVE_MAIN_FILE)[0];
  if (log === undefined) return [];
  return projectRoundProgress(readLiveEvents(log).events)?.snapshot?.agents ?? [];
}

describe("/review: live lens activity in the projection, while the lens runs", () => {
  it("shows the running lens's current tool, its file and its tool count, then its final count", async () => {
    const repo = scratchRepo("live-repo");
    const config = join(tmp, "live-config.toml");
    writeFileSync(
      config,
      readFileSync(join(ROOT, "tests", "fixtures", "config.toml"), "utf8").replace(
        /^conversation = .*$/m,
        'conversation = "faux/m"',
      ),
    );
    const agents = join(tmp, "live-agents");
    mkdirSync(agents, { recursive: true });
    writeFileSync(
      join(agents, "pass-security.md"),
      "---\nname: pass-security\ndescription: security lens\nmodel: faux/m\ntools: read\n---\nYou are the security lens.\n",
    );
    const state = join(tmp, "live-state");
    const runsDir = join(state, "qcr", "default", "review", "runs");
    const faux = pricedFaux(() => 0.01, { provider: "faux", models: [{ id: "m" }] });
    let whileRunning: LiveAgentProgress[] = [];
    faux.appendResponses([
      // the main session launches one lens
      () =>
        fauxAssistantMessage(
          [fauxToolCall("lens", { agent: "pass-security", task: "Look at src/a.ts." })],
          { stopReason: "toolUse" },
        ),
      // the lens reads a file...
      () =>
        fauxAssistantMessage([fauxToolCall("read", { path: "src/a.ts" })], {
          stopReason: "toolUse",
        }),
      // ...and, before it answers, the round's log already says so
      async () => {
        await waitFor(
          () => projectedLenses(runsDir).some((a) => a.status === "running" && a.tool_count > 0),
          "the running lens's activity in the round's live log",
          10_000,
        );
        whileRunning = projectedLenses(runsDir);
        return fauxAssistantMessage("No findings.");
      },
      // the main session writes the review
      async () => {
        for (const e of filesNamed(runsDir, "round-order.md")) {
          const out = dirname(e);
          writeFileSync(
            join(out, "findings-record.json"),
            JSON.stringify({ findings, verdict: "REQUEST_CHANGES" }),
          );
          writeFileSync(
            join(out, "outcome.json"),
            JSON.stringify({ verdict: "REQUEST_CHANGES", passes: [] }),
          );
        }
        return fauxAssistantMessage("done");
      },
    ]);

    const notes: string[] = [];
    const ui: SessionUi = {
      mode: "tui",
      interactive: true,
      select: async (_t, options) => options[0],
      confirm: async () => true,
      notify: (m) => notes.push(m),
      status: () => {},
      onEscape: () => () => {},
      show: () => {},
      tellAgent: () => {},
      print: () => {},
    };
    const pluginHost: PluginHost = {
      cwd: repo,
      env: { PATH: process.env.PATH, QCR_CONFIG: config, XDG_STATE_HOME: state },
      home: tmp,
      piVersion: "1.4.0",
      agentDir: join(tmp, "live-host-agent"),
      auth: { logins: () => ({}), configured: () => true, refresh: async () => {} },
      runner: { which: () => null, run: async () => ({ code: 1, stdout: "", stderr: "" }) },
      shutdown: new AbortController().signal,
    };
    await runReviewCommand("", pluginHost, ui, {
      ...REVIEW_DEPS,
      runtime: (_cfg, o) =>
        reviewSdkRuntime({
          ...o,
          // The engine route: our lens tools, the passes SDK sessions of this
          // process, over the test's one lens (no cache groups, no warm-up).
          engine: {
            plannedWave: false,
            config: (h, spec) => {
              const { cache: _cache, ...c } = engineLensConfig(h, spec);
              return { ...c, registry: loadBuiltAgents(agents), sessionGapMs: 0 };
            },
          },
          makeHost: (ho) =>
            PiHost.create({
              ...ho,
              configureModels: (r) => {
                r.registerNativeProvider(faux.provider);
              },
            }),
        }),
    });

    // While the lens ran: its tool, the file it was on, a count above zero.
    const running = whileRunning.find((a) => a.agent === "pass-security");
    expect(running, notes.join("\n")).toMatchObject({
      status: "running",
      current_tool: "read: src/a.ts",
      current_target: "src/a.ts",
    });
    expect(running!.tool_count).toBe(1);
    expect(lensActivityLine(running!)).toMatch(/^security · read src\/a\.ts · 1 tool/);

    // Once it is done: completed, the final count kept, a measured duration,
    // no file it is "on" any more.
    const done = projectedLenses(runsDir).find((a) => a.agent === "pass-security");
    expect(done).toMatchObject({ status: "completed", tool_count: 1 });
    expect(done!.duration_ms).toBeGreaterThan(0);
    expect(done!.current_target).toBeUndefined();
  });
});
