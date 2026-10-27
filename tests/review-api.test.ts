// review() and preview() (packages/pi-plugin/src/reviewapi.ts): the local review as a typed call,
// driven directly over pi-ai's faux provider on the real SDK runtime. The
// caller hands in every path, the config and the ports, so the call needs no
// $HOME, no cwd and no config file, returns the versioned JSON and the
// rendered markdown, and a stop ends it with a result, never the process.
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import {
  preview,
  review,
  type ReviewOptions,
  type ReviewRuntime,
  type ReviewStarted,
} from "@quickchatai/pi-quickreview/src/reviewapi.js";
import { parseCoreConfig } from "@quickchatai/pi-quickreview/src/reviewconfig.js";
import { contextFrom } from "@quickchatai/pi-quickreview/src/engine/context.js";
import { reviewSdkRuntime } from "@quickchatai/pi-quickreview/src/engine/reviewsdk.js";
import { PiHost } from "@quickchatai/pi-quickreview/src/engine/pisdk.js";
import type { Runtime } from "@quickchatai/pi-quickreview/src/engine/port.js";
import { pricedFaux } from "./helpers/priced-faux.js";
import { validate } from "./helpers/json-schema-lite.js";
import { useOfflineGuard } from "./pi-canary/harness.js";

useOfflineGuard();

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tmp = mkdtempSync(join(tmpdir(), "review-api-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const git = (cwd: string, ...args: string[]): string =>
  execFileSync(
    "git",
    ["-c", "user.name=T", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args],
    { cwd, encoding: "utf8" },
  ).trim();

/** main with one file, `feature` adding two lines to it. */
function mkRepo(name: string): string {
  const repo = join(tmp, name);
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
  return repo;
}

// The asset tree, without the checkout's git dir and state.
const root = join(tmp, "root");
mkdirSync(root);
for (const e of readdirSync(ROOT))
  if (!["wt", ".git", "state"].includes(e)) symlinkSync(join(ROOT, e), join(root, e));

// The config as data: the shipped defaults' text, parsed here. No config file
// is looked up by the call.
const toml = readFileSync(join(ROOT, "config.example.toml"), "utf8");
const parsed = parseCoreConfig(toml);
const ctx = contextFrom(root, { cfg: parsed, toml }, parsed.review.profile, "", {});
const config = { ...ctx.cfg, models: { ...ctx.cfg.models, conversation: "faux/m" } };

const record = JSON.stringify({
  findings: [
    {
      path: "src/a.ts",
      line: 2,
      severity: "P2",
      title: "b is a magic number",
      disposition: "posted",
    },
    {
      path: "src/a.ts",
      line: 3,
      severity: "P0",
      title: "c breaks the build",
      disposition: "posted",
    },
  ],
  verdict: "REQUEST_CHANGES",
});
const outcome = JSON.stringify({ verdict: "REQUEST_CHANGES", passes: [] });

const resultSchema = JSON.parse(
  readFileSync(join(ROOT, "schemas", "review-result.v1.json"), "utf8"),
) as Record<string, unknown>;
/** The result object breaks no rule of the versioned schema. */
const schemaErrors = (data: unknown): unknown[] => validate(resultSchema, data);

/** The faux-hosted runtime; `created` counts the sessions it started. */
function fauxRuntime(faux: ReturnType<typeof pricedFaux>): {
  runtime: ReviewRuntime;
  created: () => number;
} {
  let n = 0;
  const inner = reviewSdkRuntime({
    lens: () => ({ factories: [], toolNames: [] }),
    homeDir: join(tmp, "no-home"),
    makeHost: async (o) =>
      PiHost.create({
        ...o,
        ownsProcess: false,
        configureModels: (r) => {
          r.registerNativeProvider(faux.provider);
        },
      }),
  });
  return {
    runtime: {
      create: (spec) => (n++, inner.create(spec)),
      resume: (file, spec) => inner.resume(file, spec),
    },
    created: () => n,
  };
}

function options(name: string, runtime: Runtime): ReviewOptions {
  return optionsOver(name, () => runtime);
}

function optionsOver(name: string, runtime: ReviewOptions["runtime"]): ReviewOptions {
  return {
    repoDir: mkRepo(name),
    root,
    agentDir: join(tmp, `${name}-agent`),
    runsDir: join(tmp, `${name}-runs`),
    dryrunDir: join(tmp, `${name}-dryrun`),
    storeDir: join(tmp, `${name}-store`),
    config,
    ecosystem: ctx.ecosystem,
    runtime,
    // no prepareHost: core's own isolation of the run, as a plugin gets it
    limits: { limitUsd: 1000, timeoutMs: 60_000 },
  };
}

/** The out dir of the round in flight under `runsDir`, found by its round order. */
function outDirOf(runsDir: string): string {
  for (const d of readdirSync(runsDir))
    for (const e of readdirSync(join(runsDir, d), { recursive: true }))
      if (String(e).endsWith("round-order.md")) return dirname(join(runsDir, d, String(e)));
  throw new Error("no round started");
}

// Nothing of the caller's process is there to lean on: a home, a config, a
// state home and a cwd that do not exist. pi's own path helper evaluates
// `process.cwd()` as a default argument it does not use for an absolute path;
// every other ask is the review's own, and there must be none.
const nowhere = join(tmp, "nowhere");
let cwdAsks: string[] = [];
function withoutCallerContext(): void {
  vi.stubEnv("HOME", join(nowhere, "home"));
  vi.stubEnv("QCR_CONFIG", join(nowhere, "config.toml"));
  vi.stubEnv("XDG_CONFIG_HOME", join(nowhere, "config"));
  vi.stubEnv("XDG_STATE_HOME", join(nowhere, "state"));
  vi.stubEnv("PI_CODING_AGENT_DIR", join(nowhere, "pi"));
  cwdAsks = [];
  vi.spyOn(process, "cwd").mockImplementation(() => {
    const caller = (new Error().stack ?? "").split("\n")[3] ?? "";
    if (!/pi-coding-agent\/dist\/utils\/paths\.js/.test(caller)) cwdAsks.push(caller.trim());
    return join(nowhere, "cwd");
  });
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("review(): the local review as a call", () => {
  it(
    "runs on explicit paths, config and ports alone, and returns the JSON and the markdown",
    { timeout: 60_000 },
    async () => {
      const faux = pricedFaux(() => 0.25, { provider: "faux", models: [{ id: "m" }] });
      const { runtime, created } = fauxRuntime(faux);
      const opts = options("whole", runtime);
      faux.appendResponses([
        async () => {
          const out = outDirOf(opts.runsDir);
          writeFileSync(join(out, "findings-record.json"), record);
          writeFileSync(join(out, "outcome.json"), outcome);
          return fauxAssistantMessage("done");
        },
      ]);
      const progress: string[] = [];
      const started: ReviewStarted[] = [];
      withoutCallerContext();
      const r = await review({ kind: "branch" }, opts, {
        progress: (l) => progress.push(l),
        started: (s) => started.push(s),
      });
      vi.restoreAllMocks();
      expect(r.exitCode, r.text).toBe(0);
      expect(created()).toBe(1);
      expect(schemaErrors(r.data)).toEqual([]);
      expect(r.data.schema_version).toBe(1);
      expect(Object.keys(r.data)[0]).toBe("schema_version");
      expect(r.data.ok).toBe(true);
      expect(r.data["verdict"]).toBe("REQUEST_CHANGES");
      const findings = r.data["findings"] as Record<string, Array<{ title: string }>>;
      expect(Object.keys(findings)).toEqual(["P0", "P2"]);
      expect(findings["P0"]![0]!.title).toBe("c breaks the build");
      expect(r.markdown).toMatch(/^# Review of feature against main/);
      expect(r.markdown).toMatch(/c breaks the build/);
      expect(r.markdown).toMatch(/b is a magic number/);
      // the preview and the memory notice went through the progress port
      expect(progress.join("\n")).toMatch(/price: \$\d+\.\d{2}/);
      expect(progress.join("\n")).toMatch(/memory: not set up/);
      // the round's start reached the caller: where it runs, before it ran
      expect(started).toHaveLength(1);
      expect(started[0]!.outDir).toBe(r.data["out_dir"]);
      expect(dirname(started[0]!.outDir)).toBe(started[0]!.runDir);
      expect(started[0]!.lenses.length).toBeGreaterThan(0);
      expect(started[0]!.estimateUsd).toBeGreaterThan(0);
      // the round was remembered in the store it was given, and nothing went
      // anywhere the caller's process would have named
      expect(readdirSync(opts.storeDir!)).toHaveLength(1);
      expect(cwdAsks).toEqual([]);
      expect(existsSync(nowhere)).toBe(false);
    },
  );

  it("preview() shows the plan and the price and starts nothing", { timeout: 30_000 }, async () => {
    const faux = pricedFaux(() => 0.25, { provider: "faux", models: [{ id: "m" }] });
    const { runtime, created } = fauxRuntime(faux);
    const opts = options("preview", runtime);
    withoutCallerContext();
    const r = await preview({ kind: "branch" }, opts);
    vi.restoreAllMocks();
    expect(r.exitCode, r.text).toBe(0);
    expect(created()).toBe(0);
    expect(schemaErrors(r.data)).toEqual([]);
    const p = r.data["preview"] as { lenses: string[]; estimate_usd: number; key: string };
    expect(p.lenses.length).toBeGreaterThan(0);
    expect(p.estimate_usd).toBeGreaterThan(0);
    expect(p.key).toMatch(/^[0-9a-f]{16}$/);
    expect(r.markdown).toBeNull();
    expect(cwdAsks).toEqual([]);
    expect(existsSync(nowhere)).toBe(false);
  });

  // The bare /qcr-review: the branch's commits and the working tree's edits,
  // reviewed as one. MUTATION: drop the uncommitted option from the branch's
  // resolution — the edit is missing from the plan, and this fails.
  it(
    "a branch with its uncommitted changes plans both as one review, and keeps no state",
    { timeout: 30_000 },
    async () => {
      const faux = pricedFaux(() => 0.25, { provider: "faux", models: [{ id: "m" }] });
      const { runtime, created } = fauxRuntime(faux);
      const opts = options("with-edits", runtime);
      // an edit to the committed file, and a file git has never seen
      writeFileSync(
        join(opts.repoDir, "src", "a.ts"),
        "export const a = 1;\nexport const b = 2;\nexport const c = 4;\n",
      );
      writeFileSync(join(opts.repoDir, "src", "new.ts"), "export const n = 0;\n");
      const both = await preview({ kind: "branch", uncommitted: true }, opts);
      expect(both.exitCode, both.text).toBe(0);
      expect(schemaErrors(both.data)).toEqual([]);
      const p = both.data["preview"] as {
        target: { kind: string; uncommitted?: boolean };
        files: number;
        key: string;
      };
      expect(p.target).toEqual({ kind: "branch", uncommitted: true });
      expect(p.files).toBe(2);
      expect(both.text).toMatch(/Review feature against main, with its uncommitted changes/);
      // the committed branch alone is the one file, and keys apart
      const committed = await preview({ kind: "branch" }, opts);
      const c = committed.data["preview"] as { target: object; files: number; key: string };
      expect(c.target).toEqual({ kind: "branch" });
      expect(c.files).toBe(1);
      expect(c.key).not.toBe(p.key);
      // the person's index and files are as they were
      expect(git(opts.repoDir, "status", "--porcelain")).toBe("M src/a.ts\n?? src/new.ts".trim());
      expect(created()).toBe(0);
    },
  );

  it(
    "a clean tree with uncommitted asked for is the branch review itself",
    { timeout: 30_000 },
    async () => {
      const faux = pricedFaux(() => 0.25, { provider: "faux", models: [{ id: "m" }] });
      const { runtime } = fauxRuntime(faux);
      const opts = options("clean-edits", runtime);
      const r = await preview({ kind: "branch", uncommitted: true }, opts);
      expect(r.exitCode, r.text).toBe(0);
      const p = r.data["preview"] as { target: object; files: number };
      expect(p.target).toEqual({ kind: "branch" });
      expect(p.files).toBe(1);
    },
  );

  it(
    "a named branch is that branch's commits, whatever is checked out",
    { timeout: 30_000 },
    async () => {
      const faux = pricedFaux(() => 0.25, { provider: "faux", models: [{ id: "m" }] });
      const { runtime } = fauxRuntime(faux);
      const opts = options("named", runtime);
      git(opts.repoDir, "checkout", "-q", "main");
      const r = await preview({ kind: "branch", head: "feature" }, opts);
      expect(r.exitCode, r.text).toBe(0);
      expect((r.data["preview"] as { branch: string; files: number }).branch).toBe("feature");
      expect((r.data["preview"] as { files: number }).files).toBe(1);
      const missing = await preview({ kind: "branch", head: "nope" }, opts);
      expect(missing.exitCode).toBe(1);
      expect(missing.text).toMatch(/nope is not a branch or commit/);
    },
  );

  it("a signal aborted before the run starts no session", { timeout: 30_000 }, async () => {
    const faux = pricedFaux(() => 0.25, { provider: "faux", models: [{ id: "m" }] });
    const { runtime, created } = fauxRuntime(faux);
    const opts = options("pre-abort", runtime);
    const stop = new AbortController();
    stop.abort();
    const exit = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("review() exited the process");
    });
    const r = await review({ kind: "branch" }, opts, { signal: stop.signal });
    expect(exit).not.toHaveBeenCalled();
    expect(created()).toBe(0);
    expect(r.exitCode).toBe(1);
    expect(r.data).toMatchObject({ ok: false, stopped: true, errors: ["the review was stopped"] });
    expect(schemaErrors(r.data)).toEqual([]);
  });

  it("a stop closes a question the port never answers", { timeout: 30_000 }, async () => {
    const faux = pricedFaux(() => 0.25, { provider: "faux", models: [{ id: "m" }] });
    const { runtime, created } = fauxRuntime(faux);
    // a limit under any price: the run asks before it starts
    const opts = { ...options("ask-abort", runtime), limits: { limitUsd: 0, timeoutMs: 60_000 } };
    const stop = new AbortController();
    let heard: AbortSignal | undefined;
    const r = await review({ kind: "branch" }, opts, {
      signal: stop.signal,
      confirm: (_q, o) => {
        heard = o?.signal;
        setTimeout(() => stop.abort(), 10);
        return new Promise<boolean>(() => {});
      },
    });
    expect(heard).toBe(stop.signal);
    expect(created()).toBe(0);
    expect(r.data).toMatchObject({ ok: false, stopped: true });
  });

  it(
    "one runtime hosts one run: a second review on it while the first runs is refused, and the runtime is disposed after",
    { timeout: 60_000 },
    async () => {
      const faux = pricedFaux(() => 0.25, { provider: "faux", models: [{ id: "m" }] });
      const built = fauxRuntime(faux);
      let disposed = 0;
      const shared: ReviewRuntime = { ...built.runtime, dispose: () => void disposed++ };
      const asked: string[] = [];
      const first = optionsOver("shared-a", ({ runDir }) => (asked.push(runDir), shared));
      const second = optionsOver("shared-b", ({ runDir }) => (asked.push(runDir), shared));
      let during: Awaited<ReturnType<typeof review>> | undefined;
      faux.appendResponses([
        async () => {
          // the first run's round is in flight: the second asks for the same runtime
          during = await review({ kind: "branch" }, second);
          const out = outDirOf(first.runsDir);
          writeFileSync(join(out, "findings-record.json"), record);
          writeFileSync(join(out, "outcome.json"), outcome);
          return fauxAssistantMessage("done");
        },
      ]);
      const r = await review({ kind: "branch" }, first);
      expect(r.exitCode, r.text).toBe(0);
      expect(during?.exitCode).toBe(1);
      expect(during?.text).toMatch(/already hosting another review/);
      expect(built.created()).toBe(1);
      // each run asked for its own runtime once, under its own run dir
      expect(asked).toHaveLength(2);
      expect(asked[0]!.startsWith(first.runsDir)).toBe(true);
      expect(asked[1]!.startsWith(second.runsDir)).toBe(true);
      expect(disposed).toBe(1);
      // released: the next run may use it again
      faux.appendResponses([
        async () => {
          const out = outDirOf(second.runsDir);
          writeFileSync(join(out, "findings-record.json"), record);
          writeFileSync(join(out, "outcome.json"), outcome);
          return fauxAssistantMessage("done");
        },
      ]);
      const again = await review({ kind: "branch" }, second);
      expect(again.exitCode, again.text).toBe(0);
      expect(disposed).toBe(2);
    },
  );

  it(
    "a signal aborted mid-round stops the turn and returns, recording nothing",
    { timeout: 60_000 },
    async () => {
      const faux = pricedFaux(() => 0.25, { provider: "faux", models: [{ id: "m" }] });
      const { runtime, created } = fauxRuntime(faux);
      // A round's budget long enough for its one continuation (which a round
      // that stopped short gets when it has two minutes left): the stop must
      // be what skips it.
      const opts = {
        ...options("mid-abort", runtime),
        limits: { limitUsd: 1000, timeoutMs: 10 * 60_000 },
      };
      const stop = new AbortController();
      let turnHeardStop = false;
      let continued = false;
      faux.appendResponses([
        async (_context, streamOptions) => {
          // the findings are written, then the person stops the review
          const out = outDirOf(opts.runsDir);
          writeFileSync(join(out, "findings-record.json"), record);
          stop.abort();
          const signal = streamOptions?.signal;
          await new Promise<void>((done) => {
            if (!signal || signal.aborted) return done();
            const timer = setTimeout(done, 10_000);
            signal.addEventListener("abort", () => (clearTimeout(timer), done()), { once: true });
          });
          turnHeardStop = signal?.aborted === true;
          return fauxAssistantMessage("stopped", { stopReason: "aborted" });
        },
        // the continuation a round that stopped short would get, were it not stopped
        async () => {
          continued = true;
          return fauxAssistantMessage("continued");
        },
      ]);
      const exit = vi.spyOn(process, "exit").mockImplementation(() => {
        throw new Error("review() exited the process");
      });
      const r = await review({ kind: "branch" }, opts, { signal: stop.signal });
      expect(exit).not.toHaveBeenCalled();
      expect(created()).toBe(1);
      expect(turnHeardStop).toBe(true);
      expect(continued).toBe(false);
      expect(r.exitCode).toBe(1);
      expect(r.data).toMatchObject({
        ok: false,
        stopped: true,
        errors: ["the review was stopped"],
      });
      expect(r.markdown).toBeNull();
      // a stopped round leaves no history: the next run is a full review again
      const store = opts.storeDir!;
      const states = existsSync(store)
        ? readdirSync(store, { recursive: true }).filter((f) => String(f).endsWith(".json"))
        : [];
      expect(states.filter((f) => String(f).includes("state"))).toEqual([]);
    },
  );
});
