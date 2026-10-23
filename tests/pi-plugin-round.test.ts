// One whole review round through the pi plugin's /review, in this process, on
// pi-ai's faux provider: the production pipeline (the core's review()), the
// SDK host built the way the plugin builds it inside a user's pi (hostPi: pi's
// dispatcher reused, never installed; no turn owns the process), the
// borrowed login's refresh-disabled copy, and the result shown in the session
// and kept under the state home. No network, no cost; git runs for the
// scratch repo.
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
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { reviewSdkRuntime } from "@quickchatai/pi-quickreview/src/engine/reviewsdk.js";
import { PiHost, type PiHostOptions } from "@quickchatai/pi-quickreview/src/engine/pisdk.js";
import {
  REVIEW_DEPS,
  REVIEW_MESSAGE,
  runReviewCommand,
} from "@quickchatai/pi-quickreview/src/plugin/review.js";
import type { PluginHost, SessionUi } from "@quickchatai/pi-quickreview/src/plugin/session.js";
import { pricedFaux } from "./helpers/priced-faux.js";

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
      piVersion: "1.3.0",
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
