// review() and preview() (packages/pi-plugin/src/reviewapi.ts): the local review as a typed call,
// driven directly over pi-ai's faux provider on the real SDK runtime. The
// caller hands in every path, the config and the ports, so the call needs no
// $HOME, no cwd and no config file, returns the versioned JSON and the
// rendered markdown, and a stop ends it with a result, never the process.
//
// The price (the last block): what a review's price is known from decides
// the preview's line, the stop and the one question, on routes a case hands
// in as data; and what a caller on contract 1 is told where version 1 cannot
// state the price.
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
  type ReviewRouted,
  type ReviewRuntime,
  type ReviewStarted,
} from "@quickchatai/pi-quickreview/src/reviewapi.js";
import { AuthUnreadable } from "@quickchatai/pi-quickreview/src/engine/auth.js";
import {
  refusalText,
  type CatalogModel,
  type ModelRoute,
  type ProviderInventory,
} from "@quickchatai/pi-quickreview/src/modelroute.js";
import {
  hardStopFor,
  loadReviewSettings,
  priceReview,
} from "@quickchatai/pi-quickreview/src/localreview.js";
import { MEASURED } from "@quickchatai/pi-quickreview/src/measured.js";
import { readModelChoice } from "@quickchatai/pi-quickreview/src/modelchoice.js";
import { parseCoreConfig } from "@quickchatai/pi-quickreview/src/reviewconfig.js";
import { contextFrom } from "@quickchatai/pi-quickreview/src/engine/context.js";
import { reviewSdkRuntime } from "@quickchatai/pi-quickreview/src/engine/reviewsdk.js";
import { PiHost } from "@quickchatai/pi-quickreview/src/engine/pisdk.js";
import type { Runtime } from "@quickchatai/pi-quickreview/src/engine/port.js";
import { pricedFaux } from "./helpers/priced-faux.js";
import { validate } from "./helpers/json-schema-lite.js";
import { SECURITY_FAMILY } from "@quickchatai/pi-quickreview/src/passes.js";
import { workTreeFactsIo } from "@quickchatai/pi-quickreview/src/secfactsgit.js";
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
const config = { ...ctx.cfg, models: { ...ctx.cfg.models, model: "faux/m" } };

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

const schemaOf = (version: number): Record<string, unknown> =>
  JSON.parse(
    readFileSync(join(ROOT, "schemas", `review-result.v${version}.json`), "utf8"),
  ) as Record<string, unknown>;
const resultSchema = schemaOf(2);
const resultSchemaV1 = schemaOf(1);
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
      expect(r.data.schema_version).toBe(2);
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
      // the result line sets the spend against the stop the run was held by
      const stop = started[0]!.capUsd!;
      expect(stop).toBeGreaterThan(0);
      const usd = (n: number): string => "$" + n.toFixed(2);
      expect(r.text).toContain(`(${usd(r.data["cost_usd"] as number)} of ${usd(stop)})`);
      // the round was remembered in the store it was given, and nothing went
      // anywhere the caller's process would have named
      expect(readdirSync(opts.storeDir!)).toHaveLength(1);
      expect(cwdAsks).toEqual([]);
      expect(existsSync(nowhere)).toBe(false);
    },
  );

  it("preview() shows the plan and the price and starts nothing", { timeout: 30_000 }, async () => {
  // A priced route with one lens on a model pi has no price for: the lens
  // child's tokens come at a cost of exactly 0, so the round's cost is
  // unknown. The part pi did price is not the spend, and neither is $0.
  // MUTATION: fall back to `shot.piRun.spentUsd` when `shot.costUsd` is null
  // (reviewapi.ts) — the priced part is reported as the spend under a stop,
  // $0.00 with none, and this fails.
  for (const [name, limits] of [
    ["under a stop", { limitUsd: 1000, timeoutMs: 60_000 }],
    ["with no stop", { timeoutMs: 60_000, route: "action" }],
  ] as const)
    it(
      `a round with one unpriced lens child has no spend, ${name}: unknown, never the priced part`,
      { timeout: 60_000 },
      async () => {
        const faux = pricedFaux(() => 0.25, { provider: "faux", models: [{ id: "m" }] });
        const { runtime } = fauxRuntime(faux);
        const opts: ReviewOptions = {
          ...options(`mixed-${name.replace(/ /g, "-")}`, runtime),
          limits,
        };
        faux.appendResponses([
          async () => {
            const out = outDirOf(opts.runsDir);
            writeFileSync(join(out, "findings-record.json"), record);
            writeFileSync(join(out, "outcome.json"), outcome);
            writeFileSync(
              join(out, "lens-ledger.jsonl"),
              JSON.stringify({
                v: 1,
                kind: "lens",
                id: "unpriced-lens",
                agent: "pass-correctness",
                model: "local/no-price",
                usage: { input: 900, output: 90, cacheRead: 0, cost: 0 },
              }) + "\n",
            );
            return fauxAssistantMessage("done");
          },
        ]);
        const started: ReviewStarted[] = [];
        const r = await review({ kind: "branch" }, opts, { started: (s) => started.push(s) });
        expect(r.exitCode, r.text).toBe(0);
        expect(schemaErrors(r.data)).toEqual([]);
        expect(started[0]!.capUsd === null).toBe(name === "with no stop");
        expect(r.data["cost_usd"]).toBeNull();
        expect(r.text).toMatch(/Review done: REQUEST_CHANGES \(spend unknown: /);
        expect(r.text).not.toMatch(/\$\d+\.\d{2}\)/);
        // the round the store remembers carries no figure either
        const stored = readdirSync(opts.storeDir!, { recursive: true })
          .map((f) => join(opts.storeDir!, String(f)))
          .filter((f) => f.endsWith(".json"))
          .map((f) => readFileSync(f, "utf8"));
        expect(stored.join("\n")).toMatch(/"cost_usd":\s*null/);
      },
    );

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

  // MUTATION: drop the securityRequest spread from planRound's inputs
  // (packages/pi-plugin/src/reviewapi.ts) — the request plans nothing, and
  // this fails.
  it(
    "a security request plans the whole security family into the plan the person sees",
    { timeout: 30_000 },
    async () => {
      const faux = pricedFaux(() => 0.25, { provider: "faux", models: [{ id: "m" }] });
      const { runtime } = fauxRuntime(faux);
      const plain = await preview({ kind: "branch" }, options("sec-plain", runtime));
      const asked = await preview(
        { kind: "branch" },
        { ...options("sec-asked", runtime), securityRequest: { by: "", source: "operator" } },
      );
      expect(asked.exitCode, asked.text).toBe(0);
      const lensesOf = (r: typeof plain): string[] =>
        // the plan's agents, `<lens>--<tier>`
        (r.data["preview"] as { lenses: string[] }).lenses.map((a) => a.replace(/--[^-].*$/, ""));
      for (const lens of SECURITY_FAMILY) expect(lensesOf(asked), lens).toContain(lens);
      expect(lensesOf(plain).filter((l) => SECURITY_FAMILY.includes(l))).toEqual([]);
    },
  );

  // Owner rule: the repository's `.qcr/threat-model.md` (at the base commit)
  // wins over the profile's copy, on the one-shot routes as on the daemon's,
  // and the security lenses get the deterministic facts.
  // MUTATION: drop `readRepoThreatModel` from planRound's inputs
  // (packages/pi-plugin/src/reviewapi.ts `securityArgs`) — the round reads no
  // threat model, and this fails; drop `securityFacts`/`securityInventory`
  // and the facts section is missing.
  it(
    "a security round reads the repository's threat model at the base, and the facts",
    { timeout: 60_000 },
    async () => {
      const faux = pricedFaux(() => 0.25, { provider: "faux", models: [{ id: "m" }] });
      const { runtime } = fauxRuntime(faux);
      const opts = {
        ...options("sec-threat-model", runtime),
        securityRequest: { by: "", source: "operator" as const },
      };
      // The model on main (the base); the branch changes it, and the base's wins.
      const repo = opts.repoDir;
      git(repo, "checkout", "-q", "main");
      mkdirSync(join(repo, ".qcr"), { recursive: true });
      writeFileSync(join(repo, ".qcr", "threat-model.md"), "## Controls\n- BASE-CONTROL-MARK\n");
      git(repo, "add", "-A");
      git(repo, "commit", "-q", "-m", "threat model");
      git(repo, "checkout", "-q", "feature");
      git(repo, "rebase", "-q", "main");
      writeFileSync(join(repo, ".qcr", "threat-model.md"), "## Controls\n- HEAD-CONTROL-MARK\n");
      git(repo, "commit", "-q", "-am", "edit the threat model");
      let tasks = "";
      faux.appendResponses([
        async () => {
          const out = outDirOf(opts.runsDir);
          const dir = join(out, "tasks");
          tasks = readdirSync(dir)
            .filter((f) => f.includes("pass-sec-access"))
            .map((f) => readFileSync(join(dir, f), "utf8"))
            .join("\n");
          writeFileSync(join(out, "findings-record.json"), record);
          writeFileSync(join(out, "outcome.json"), outcome);
          return fauxAssistantMessage("done");
        },
      ]);
      const r = await review({ kind: "branch" }, opts, {});
      expect(r.exitCode, r.text).toBe(0);
      expect(tasks).toContain("the repository's `.qcr/threat-model.md` on the base branch");
      expect(tasks).toContain("BASE-CONTROL-MARK");
      expect(tasks).not.toContain("HEAD-CONTROL-MARK");
      expect(tasks).toContain("Security facts (computed from the repository, not by a model)");
      expect(tasks).toContain("`route-inventory`");
    },
  );

  // MUTATION: drop `opts.securityRequest !== undefined` from the `prev`
  // condition in review() — the request is answered "Nothing new" off the
  // ordinary review's state, and this fails.
  it(
    "a security request at a head an ordinary review already saw is reviewed, not answered from its state",
    { timeout: 60_000 },
    async () => {
      const faux = pricedFaux(() => 0.25, { provider: "faux", models: [{ id: "m" }] });
      const { runtime } = fauxRuntime(faux);
      const opts = options("sec-after-plain", runtime);
      faux.appendResponses([
        async () => {
          const out = outDirOf(opts.runsDir);
          writeFileSync(join(out, "findings-record.json"), record);
          writeFileSync(join(out, "outcome.json"), outcome);
          return fauxAssistantMessage("done");
        },
      ]);
      const first = await review({ kind: "branch" }, opts, {});
      expect(first.exitCode, first.text).toBe(0);
      // The control: the same head again is nothing new.
      const again = await preview({ kind: "branch" }, opts);
      expect(again.data["unchanged"]).toBe(true);
      const asked = await preview(
        { kind: "branch" },
        { ...opts, securityRequest: { by: "", source: "operator" } },
      );
      expect(asked.exitCode, asked.text).toBe(0);
      expect(asked.data["unchanged"]).toBeUndefined();
      const lenses = (asked.data["preview"] as { lenses: string[] }).lenses;
      for (const lens of SECURITY_FAMILY)
        expect(
          lenses.some((a) => a.startsWith(`${lens}--`)),
          lens,
        ).toBe(true);
    },
  );

  // An uncommitted target's snapshot tree lives in an object store gone by
  // the time the facts are read; its head is read off the working tree.
  // MUTATION: read the facts with `localGitFactsIo` at `t.uncommitted.treeSha`
  // (packages/pi-plugin/src/reviewapi.ts `factsIo`) — the listing fails, the
  // inventory reads unknown, and this fails.
  it(
    "an uncommitted review's facts read the working tree, a file git has never seen included",
    { timeout: 60_000 },
    async () => {
      const faux = pricedFaux(() => 0.25, { provider: "faux", models: [{ id: "m" }] });
      const { runtime } = fauxRuntime(faux);
      const opts = {
        ...options("sec-uncommitted", runtime),
        securityRequest: { by: "", source: "operator" as const },
      };
      writeFileSync(
        join(opts.repoDir, "src", "routes.py"),
        '@app.route("/admin-uncommitted")\ndef admin():\n    return 1\n',
      );
      let tasks = "";
      faux.appendResponses([
        async () => {
          const out = outDirOf(opts.runsDir);
          const dir = join(out, "tasks");
          tasks = readdirSync(dir)
            .filter((f) => f.includes("pass-sec-access"))
            .map((f) => readFileSync(join(dir, f), "utf8"))
            .join("\n");
          writeFileSync(join(out, "findings-record.json"), record);
          writeFileSync(join(out, "outcome.json"), outcome);
          return fauxAssistantMessage("done");
        },
      ]);
      const r = await review({ kind: "uncommitted" }, opts, {});
      expect(r.exitCode, r.text).toBe(0);
      expect(tasks).toContain("`route-inventory`");
      expect(tasks).toContain("/admin-uncommitted");
      // the person's files are as they were
      expect(git(opts.repoDir, "status", "--porcelain")).toBe("?? src/routes.py");
    },
  );

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

describe("review(): the model is the host's to resolve", () => {
  const ROUTE: ModelRoute = {
    provider: "faux",
    modelId: "m",
    providerName: "Faux",
    spec: "faux/m",
    thinking: null,
    source: "pi-provider",
    pick: "newest",
    piDefaultId: null,
    custom: false,
    movedFrom: null,
    credential: { kind: "api_key", origin: "env-key", label: "FAUX_KEY", subscription: false },
    priced: true,
    ask: true,
    alternatives: [
      {
        provider: "other",
        providerName: "Other",
        modelId: "o",
        spec: "other/o",
        credential: { kind: "oauth", origin: "stored", subscription: true },
        priced: false,
      },
    ],
    notices: ["skipped Short: its login expires at 12:08 and nothing here renews it"],
  };
  const routedTo = (over: Partial<ReviewRouted> = {}): ReviewRouted => ({
    result: { ok: true, route: ROUTE },
    inventory: [],
    surface: "app",
    ...over,
  });
  /** A runtime that must never be asked for a session. */
  const noRuntime = (): ReviewRuntime => {
    throw new Error("no runtime is built");
  };
  const modelLinesOf = (text: string): string[] =>
    text.split("\n").filter((l) => l.trimStart().startsWith("model:"));

  // MUTATION: write `model: null` into previewData whatever the route
  // (packages/pi-plugin/src/reviewapi.ts) — the preview carries no model, and this fails.
  it(
    "the preview names the model in one line under the lenses and carries model, alternatives and tiers",
    { timeout: 30_000 },
    async () => {
      let asks = 0;
      const opts: ReviewOptions = {
        ...optionsOver("route-preview", noRuntime),
        route: async () => {
          asks++;
          return routedTo({
            notes: ["--model replaces 2 pinned tier and lens models for this run"],
          });
        },
      };
      const r = await preview({ kind: "branch" }, opts);
      expect(r.exitCode, r.text).toBe(0);
      expect(asks).toBe(1);
      expect(schemaErrors(r.data)).toEqual([]);
      const p = r.data["preview"] as Record<string, unknown>;
      expect(p["model"]).toEqual({
        spec: "faux/m",
        provider: "faux",
        id: "m",
        provider_name: "Faux",
        source: "pi-provider",
        pick: "newest",
        pi_default: null,
        custom: false,
        moved_from: null,
        priced: true,
        ask: true,
        // what kind of credential and where pi found it: never its label
        credential: { kind: "api_key", origin: "env-key", subscription: false },
      });
      expect(p["alternatives"]).toEqual([
        {
          spec: "other/o",
          provider: "other",
          provider_name: "Other",
          priced: false,
          credential: { kind: "oauth", origin: "stored", subscription: true },
        },
      ]);
      // the shipped config pins no tier: each runs on the route, at its own level
      expect(p["tiers"]).toEqual({
        light: "faux/m:medium",
        standard: "faux/m:medium",
        deep: "faux/m:high",
      });
      // nothing was fitted to this model, and the run names its own stop
      expect(p).toMatchObject({
        price_basis: "unmeasured",
        estimate_usd: null,
        cap_usd: 1000,
        limit_usd: 1000,
        auto: true,
      });
      const lines = r.text.split("\n");
      const at = lines.findIndex((l) => l.startsWith("  lenses:"));
      expect(lines.slice(at + 1, at + 4)).toEqual([
        "  model: faux/m (picked among 2 providers pi has credentials for: pi itself starts on Faux). " +
          "Change it: qcr model use <provider[/model]>, or --model for one run",
        "  skipped Short: its login expires at 12:08 and nothing here renews it",
        "  --model replaces 2 pinned tier and lens models for this run",
      ]);
      expect(modelLinesOf(r.text)).toHaveLength(1);
    },
  );

  it(
    "a caller that resolves no route gets a preview that names no model and keeps the fitted estimate",
    { timeout: 30_000 },
    async () => {
      const r = await preview({ kind: "branch" }, optionsOver("route-none", noRuntime));
      expect(r.exitCode, r.text).toBe(0);
      expect(schemaErrors(r.data)).toEqual([]);
      const p = r.data["preview"] as Record<string, unknown>;
      expect(p["model"]).toBeNull();
      expect(p["alternatives"]).toEqual([]);
      // the tiers as the config writes them: there is no route to run them on
      expect(p["tiers"]).toEqual({ light: ":medium", standard: ":medium", deep: ":high" });
      expect(p["price_basis"]).toBe("measured");
      expect(p["estimate_usd"]).toBeGreaterThan(0);
      expect(modelLinesOf(r.text)).toEqual([]);
    },
  );

  // MUTATION: drop the `!routed.result.ok && !isPreview` refusal (reviewapi.ts) —
  // the review goes on to build its runtime, and this fails.
  it(
    "with no route a preview still shows the plan, and a start is refused in the route's words before any runtime",
    { timeout: 30_000 },
    async () => {
      const none = routedTo({
        result: { ok: false, refusal: { code: "no-credential" } },
        facts: { agentDir: "/pi/home" },
      });
      const pre = await preview(
        { kind: "branch" },
        { ...optionsOver("route-refused-preview", noRuntime), route: async () => none },
      );
      expect(pre.exitCode, pre.text).toBe(0);
      const p = pre.data["preview"] as Record<string, unknown>;
      expect(p["model"]).toBeNull();
      expect(p["alternatives"]).toEqual([]);
      expect(p["tiers"]).toEqual({ light: ":medium", standard: ":medium", deep: ":high" });
      expect((p["lenses"] as string[]).length).toBeGreaterThan(0);
      expect(modelLinesOf(pre.text)).toEqual(["  model: none (no model credential: qcr login)"]);
      // nothing is known of a price with no model: never a number, never a stop
      expect(schemaErrors(pre.data)).toEqual([]);
      expect(p).toMatchObject({
        price_basis: "unknown",
        estimate_usd: null,
        cap_usd: null,
        limit_usd: null,
        auto: false,
      });
      expect(pre.text.split("\n")).toContain("  price: unknown until a model credential exists");

      const started = await review(
        { kind: "branch" },
        { ...optionsOver("route-refused-start", noRuntime), route: async () => none },
      );
      expect(started.exitCode).toBe(1);
      expect(started.data).toMatchObject({ ok: false });
      expect((started.data["errors"] as string[])[0]).toBe(
        "pi has no model credential (agent dir /pi/home). Run `qcr login` and sign in to any provider, " +
          "or set a provider's API key in the environment, then run this again.",
      );

      // the plugin's words, inside pi
      const inPi = await preview(
        { kind: "branch" },
        {
          ...optionsOver("route-refused-plugin", noRuntime),
          route: async () => ({ ...none, surface: "plugin" }),
        },
      );
      expect(modelLinesOf(inPi.text)).toEqual(["  model: none (no model credential: /login)"]);
      // any other refusal says itself
      const pinned = await preview(
        { kind: "branch" },
        {
          ...optionsOver("route-refused-pin", noRuntime),
          route: async () =>
            routedTo({ result: { ok: false, refusal: { code: "no-model", providers: ["p"] } } }),
        },
      );
      expect(modelLinesOf(pinned.text)).toEqual([
        "  model: none (pi has a credential for p, but none of their models passes the review's filter)",
      ]);
    },
  );

  it(
    "a login that cannot be read is said as it is, and a target with nothing to review never asks",
    { timeout: 30_000 },
    async () => {
      const unreadable = await review(
        { kind: "branch" },
        {
          ...optionsOver("route-unreadable", noRuntime),
          route: async () => {
            throw new AuthUnreadable("/pi/home/auth.json", new Error("it is not a JSON object"));
          },
        },
      );
      expect(unreadable.exitCode).toBe(1);
      expect((unreadable.data["errors"] as string[])[0]).toBe(
        "could not read pi's credentials at /pi/home/auth.json: it is not a JSON object",
      );

      let asks = 0;
      const opts: ReviewOptions = {
        ...optionsOver("route-nothing", noRuntime),
        route: async () => {
          asks++;
          return routedTo();
        },
      };
      git(opts.repoDir, "checkout", "-q", "main");
      const nothing = await review({ kind: "branch" }, opts);
      expect(nothing.exitCode).toBe(1);
      expect(asks).toBe(0);
    },
  );

  // MUTATION: pass the lenses' specs as written to reviewKey, without the
  // route (runModels(cfg, lenses, null) in reviewapi.ts) — the key is the
  // same on either route, and this fails.
  it("the key moves with the route the run is on", { timeout: 30_000 }, async () => {
    const keyOn = async (name: string, routed: ReviewRouted | null): Promise<string> => {
      const base = optionsOver(name, noRuntime);
      const r = await preview(
        { kind: "branch" },
        // one repository, so only the route differs
        { ...base, repoDir: shared, ...(routed ? { route: async () => routed } : {}) },
      );
      expect(r.exitCode, r.text).toBe(0);
      return (r.data["preview"] as { key: string }).key;
    };
    const shared = mkRepo("route-key-shared");
    const a = await keyOn("route-key-a", routedTo());
    const again = await keyOn("route-key-a2", routedTo());
    const b = await keyOn(
      "route-key-b",
      routedTo({ result: { ok: true, route: { ...ROUTE, spec: "other/o" } } }),
    );
    expect(again).toBe(a);
    expect(b).not.toBe(a);
    expect(await keyOn("route-key-none", null)).not.toBe(a);
  });
});

describe("review(): what the price is known from", () => {
  const ID = MEASURED.model_id;
  /** The shipped config: it pins no model, so the whole run is on the route. */
  const unpinned = ctx.cfg;
  const KEY_CREDENTIAL = { kind: "api_key", origin: "env-key", subscription: false } as const;

  const routeTo = (
    provider: string,
    modelId: string,
    over: Partial<ModelRoute> = {},
  ): ModelRoute => ({
    provider,
    modelId,
    providerName: provider.toUpperCase(),
    spec: `${provider}/${modelId}`,
    thinking: null,
    source: "only-credential",
    pick: "newest",
    piDefaultId: null,
    custom: false,
    movedFrom: null,
    credential: KEY_CREDENTIAL,
    priced: true,
    ask: false,
    alternatives: [],
    notices: [],
    ...over,
  });
  const entry = (provider: string, models: CatalogModel[]): ProviderInventory => ({
    provider,
    name: provider.toUpperCase(),
    credential: KEY_CREDENTIAL,
    models,
  });
  /** The measured model as a provider's catalog lists it. */
  const MEASURED_ROW: CatalogModel = {
    provider: "alpha",
    id: ID,
    api: MEASURED.apis[0],
    cost: { ...MEASURED.rates },
  };
  /** A model pi prices that no estimate was fitted to. */
  const OTHER_ROW: CatalogModel = {
    provider: "beta",
    id: "other-model",
    api: "some-other-api",
    cost: { input: 4, cacheRead: 0.2, output: 20 },
  };
  /** A model pi has no price for. */
  const FREE_ROW: CatalogModel = {
    provider: "gamma",
    id: "local-model",
    api: "some-other-api",
    cost: { input: 0, cacheRead: 0, output: 0 },
  };
  const ALPHA = entry("alpha", [MEASURED_ROW]);
  const BETA = entry("beta", [OTHER_ROW]);
  const GAMMA = entry("gamma", [FREE_ROW]);

  const routed = (
    route: ModelRoute,
    inventory: ProviderInventory[],
    over: Partial<ReviewRouted> = {},
  ): ReviewRouted => ({ result: { ok: true, route }, inventory, surface: "app", ...over });
  const onMeasured = (over: Partial<ModelRoute> = {}): ReviewRouted =>
    routed(routeTo("alpha", ID, over), [ALPHA, BETA]);
  const onUnmeasured = (inventory: ProviderInventory[] = [BETA]): ReviewRouted =>
    routed(routeTo("beta", "other-model"), inventory);
  const onUnpriced = (): ReviewRouted =>
    routed(routeTo("gamma", "local-model", { priced: false }), [GAMMA]);

  /** A runtime that must never be asked for a session: asking for one is
   * said in the result, so a case that reaches it shows. */
  const noRuntime = (): ReviewRuntime => {
    throw new Error("no runtime is built");
  };
  const RUNTIME_ASKED = /the review's runtime could not be built/;

  /** Options on the shipped config with no limit of the run's own: ten
   * minutes of wall clock, and the route the case hands in. */
  const priced = (
    name: string,
    on: ReviewRouted,
    limits: Partial<ReviewOptions["limits"]> = {},
  ): ReviewOptions => ({
    ...optionsOver(name, noRuntime),
    config: unpinned,
    route: async () => on,
    limits: { timeoutMs: 10 * 60_000, ...limits },
  });
  const previewOf = (r: { data: Record<string, unknown> }): Record<string, unknown> =>
    r.data["preview"] as Record<string, unknown>;
  const priceLinesOf = (text: string): string[] => {
    const lines = text.split("\n");
    const at = lines.findIndex((l) => l.startsWith("  price:"));
    const end = lines.findIndex((l) => l.startsWith("  key:"));
    return lines.slice(at, end);
  };
  const money = (n: number): string => `$${n.toFixed(2)}`;
  const errorsOf = (r: { data: Record<string, unknown> }): string[] => r.data["errors"] as string[];

  // MUTATION: drop the `specsMeasured` test from priceBasis
  // (packages/pi-plugin/src/measured.ts) — the measured model has no
  // estimate, and this fails.
  it(
    "measured: the fitted estimate, a hard stop at twice it, and the person's limit",
    { timeout: 30_000 },
    async () => {
      const r = await preview({ kind: "branch" }, priced("price-measured", onMeasured()));
      expect(r.exitCode, r.text).toBe(0);
      expect(schemaErrors(r.data)).toEqual([]);
      const p = previewOf(r);
      const lenses = p["lenses"] as string[];
      const estimate = priceReview(lenses.length, p["lines"] as number, MEASURED);
      expect(p).toMatchObject({
        price_basis: "measured",
        estimate_usd: estimate,
        cap_usd: hardStopFor(estimate),
        limit_usd: 2,
        auto: estimate <= 2,
      });
      expect((p["model"] as { spec: string }).spec).toBe(`alpha/${ID}`);
      expect(priceLinesOf(r.text)).toEqual([
        `  price: ${money(estimate)} (estimate, measured on ${ID}) — the run stops hard at ${money(hardStopFor(estimate))} (limit without asking: $2.00)`,
      ]);
    },
  );

  it("a subscription login is told its dollars are list prices", { timeout: 30_000 }, async () => {
    const r = await preview(
      { kind: "branch" },
      priced(
        "price-subscription",
        onMeasured({ credential: { kind: "oauth", origin: "stored", subscription: true } }),
      ),
    );
    expect(r.exitCode, r.text).toBe(0);
    const lines = priceLinesOf(r.text);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^ {2}price: \$\d+\.\d{2} \(estimate, measured on /);
    expect(lines[1]).toBe("  list prices: your ALPHA plan is not billed per review");
  });

  // MUTATION: test `specsMeasured` before `repoRates` in priceBasis — the
  // repo's rates lose on the measured model, and this fails.
  it("repo: the repo's own rates give an estimate on any model", { timeout: 30_000 }, async () => {
    for (const [name, on] of [
      ["price-repo-other", onUnmeasured()],
      ["price-repo-measured", onMeasured()],
    ] as const) {
      const opts = priced(name, on);
      writeFileSync(
        join(opts.repoDir, ".git", "qcr-review.json"),
        JSON.stringify({ usd_base: 3, usd_per_lens: 0.01 }),
      );
      expect(loadReviewSettings(opts.repoDir)).toEqual({
        auto_limit_usd: 2,
        unmeasured_limit_usd: 15,
        usd_base: 3,
        usd_per_lens: 0.01,
      });
      const r = await preview({ kind: "branch" }, opts);
      expect(r.exitCode, r.text).toBe(0);
      expect(schemaErrors(r.data)).toEqual([]);
      const p = previewOf(r);
      const estimate = priceReview((p["lenses"] as string[]).length, p["lines"] as number, {
        usd_base: 3,
        usd_per_lens: 0.01,
        // a rate the repo leaves out is the measured one
        usd_per_kline: MEASURED.usd_per_kline,
      });
      expect(p, name).toMatchObject({
        price_basis: "repo",
        estimate_usd: estimate,
        cap_usd: hardStopFor(estimate),
        limit_usd: 2,
        auto: false,
      });
      expect(priceLinesOf(r.text), name).toEqual([
        `  price: ${money(estimate)} (estimate, this repo's rates) — the run stops hard at ${money(hardStopFor(estimate))} (limit without asking: $2.00)`,
      ]);
    }
  });

  // MUTATION: price an unmeasured run with `priceReview(…, MEASURED)`
  // (reviewapi.ts) — a model nothing was fitted to gets a number, and this fails.
  it(
    "unmeasured: no estimate, and the run stops at the spend limit or at --limit",
    { timeout: 30_000 },
    async () => {
      const plain = await preview({ kind: "branch" }, priced("price-unmeasured", onUnmeasured()));
      expect(plain.exitCode, plain.text).toBe(0);
      expect(schemaErrors(plain.data)).toEqual([]);
      expect(previewOf(plain)).toMatchObject({
        price_basis: "unmeasured",
        estimate_usd: null,
        cap_usd: 15,
        limit_usd: 15,
        // nobody has said this model may run with no estimate
        auto: false,
      });
      expect(priceLinesOf(plain.text)).toEqual([
        "  price: no estimate for beta/other-model (not measured) — the run stops at $15.00",
      ]);
      // one tier elsewhere is enough: the measured route with a tier on beta
      const mixed = await preview(
        { kind: "branch" },
        {
          ...priced("price-mixed", onMeasured()),
          config: {
            ...unpinned,
            models: {
              ...unpinned.models,
              tiers: {
                light: "beta/other-model:medium",
                standard: "beta/other-model:medium",
                deep: "beta/other-model:high",
              },
            },
          },
        },
      );
      expect(previewOf(mixed)).toMatchObject({ price_basis: "unmeasured", estimate_usd: null });

      // --limit names the stop, and naming it is the person's word
      const limited = await preview(
        { kind: "branch" },
        priced("price-unmeasured-limit", onUnmeasured(), { limitUsd: 4 }),
      );
      expect(previewOf(limited)).toMatchObject({
        estimate_usd: null,
        cap_usd: 4,
        limit_usd: 4,
        auto: true,
      });
      expect(priceLinesOf(limited.text)).toEqual([
        "  price: no estimate for beta/other-model (not measured) — the run stops at $4.00",
      ]);

      // the repo's own spend limit
      const own = priced("price-unmeasured-repo", onUnmeasured());
      writeFileSync(
        join(own.repoDir, ".git", "qcr-review.json"),
        JSON.stringify({ unmeasured_limit_usd: 7 }),
      );
      expect(previewOf(await preview({ kind: "branch" }, own))).toMatchObject({
        price_basis: "unmeasured",
        cap_usd: 7,
        limit_usd: 7,
      });
    },
  );

  // MUTATION: make `auto` true for an unmeasured run with no word
  // (reviewapi.ts) — the run starts with nobody asked (the runtime is asked
  // for), and this fails.
  it(
    "an unmeasured model needs the person's word: with nobody to ask and no key the start is refused",
    { timeout: 30_000 },
    async () => {
      const opts = priced("price-word-none", onUnmeasured());
      const key = previewOf(await preview({ kind: "branch" }, opts))["key"] as string;
      const r = await review({ kind: "branch" }, opts);
      expect(r.exitCode).toBe(1);
      expect(errorsOf(r)).toEqual([
        `no estimate for beta/other-model and no terminal to ask: qcr review --key ${key}, or name the stop with --limit`,
      ]);
      expect(readModelChoice(opts.agentDir).noEstimateOk).toEqual([]);

      // a key from another plan is not the person's word
      const stale = await review(
        { kind: "branch" },
        { ...opts, limits: { ...opts.limits, key: "0000000000000000" } },
      );
      expect(stale.exitCode).toBe(1);
      expect(errorsOf(stale)[0]).toMatch(/^--key 0000000000000000 does not match this review/);
      expect(readModelChoice(opts.agentDir).noEstimateOk).toEqual([]);
    },
  );

  // MUTATION: drop the `remember()` call after the terminal's yes
  // (reviewapi.ts) — the next review on the model asks again, and this fails.
  it(
    "a terminal is asked once: a no refuses, a yes is remembered for the model",
    { timeout: 30_000 },
    async () => {
      const opts = priced("price-word-ask", onUnmeasured());
      const asked: string[] = [];
      const no = await review({ kind: "branch" }, opts, {
        confirm: async (q) => {
          asked.push(q);
          return false;
        },
      });
      expect(asked).toEqual([
        "Run on beta/other-model with no estimate? It stops at $15.00. (Reviews on this model will not ask again.)",
      ]);
      expect(no.exitCode).toBe(1);
      expect(errorsOf(no)).toEqual(["declined: no estimate for beta/other-model"]);
      expect(readModelChoice(opts.agentDir).noEstimateOk).toEqual([]);

      // a yes: the run goes on to its runtime, which this case does not have
      const yes = await review({ kind: "branch" }, opts, {
        confirm: async (q) => {
          asked.push(q);
          return true;
        },
      });
      expect(asked).toHaveLength(2);
      expect(errorsOf(yes)[0]).toMatch(RUNTIME_ASKED);
      expect(readModelChoice(opts.agentDir).noEstimateOk).toEqual(["beta/other-model"]);

      // the next review on the model is not asked, and its preview says so
      expect(previewOf(await preview({ kind: "branch" }, opts))["auto"]).toBe(true);
      const again = await review({ kind: "branch" }, opts, {
        confirm: async (q) => {
          asked.push(q);
          return false;
        },
      });
      expect(asked).toHaveLength(2);
      expect(errorsOf(again)[0]).toMatch(RUNTIME_ASKED);
      // the answer is for that model alone
      const other = { ...opts, route: async () => routed(routeTo("beta", "third-model"), [BETA]) };
      expect(previewOf(await preview({ kind: "branch" }, other))["auto"]).toBe(false);
    },
  );

  // MUTATION: drop the `remember()` call after the key matches (reviewapi.ts)
  // — a host skill's go is asked for again on the next review, and this fails.
  it(
    "a start with the preview's key runs, and is remembered the same way",
    { timeout: 30_000 },
    async () => {
      const opts = priced("price-word-key", onUnmeasured());
      const key = previewOf(await preview({ kind: "branch" }, opts))["key"] as string;
      const r = await review(
        { kind: "branch" },
        { ...opts, limits: { ...opts.limits, key } },
        // nobody to ask: the key is the word
      );
      expect(errorsOf(r)[0]).toMatch(RUNTIME_ASKED);
      expect(readModelChoice(opts.agentDir).noEstimateOk).toEqual(["beta/other-model"]);
    },
  );

  it(
    "the key moves with the stop: a preview under another --limit does not start this one",
    { timeout: 30_000 },
    async () => {
      const opts = priced("price-key-limit", onUnmeasured());
      const key = previewOf(await preview({ kind: "branch" }, opts))["key"] as string;
      const limited = { ...opts, limits: { ...opts.limits, limitUsd: 40 } };
      expect(previewOf(await preview({ kind: "branch" }, limited))["key"]).not.toBe(key);
    },
  );

  // MUTATION: give an unpriced run `cap = settings.unmeasured_limit_usd`
  // (reviewapi.ts) — a stop is shown that no counted cost can ever reach, and
  // this fails.
  it(
    "unpriced: no estimate and no dollar stop, the time limit is named, and --limit is said to be ignored",
    { timeout: 30_000 },
    async () => {
      const r = await preview({ kind: "branch" }, priced("price-unpriced", onUnpriced()));
      expect(r.exitCode, r.text).toBe(0);
      expect(schemaErrors(r.data)).toEqual([]);
      expect(previewOf(r)).toMatchObject({
        price_basis: "unpriced",
        estimate_usd: null,
        cap_usd: null,
        limit_usd: null,
        auto: true,
      });
      expect(priceLinesOf(r.text)).toEqual([
        "  price: pi has no price for gamma/local-model — no dollar stop; the 10-minute limit still holds",
      ]);

      const limited = await preview(
        { kind: "branch" },
        priced("price-unpriced-limit", onUnpriced(), { limitUsd: 5 }),
      );
      expect(previewOf(limited)).toMatchObject({ cap_usd: null, limit_usd: null, auto: true });
      expect(priceLinesOf(limited.text)).toEqual([
        "  price: pi has no price for gamma/local-model — no dollar stop; the 10-minute limit still holds",
        "  --limit ignored: pi has no price for gamma/local-model",
      ]);

      // nothing is asked: the start goes straight to its runtime
      const started = await review(
        { kind: "branch" },
        priced("price-unpriced-start", onUnpriced()),
      );
      expect(errorsOf(started)[0]).toMatch(RUNTIME_ASKED);
    },
  );

  it(
    "the repo's rates on an unpriced model give an estimate and no stop",
    { timeout: 30_000 },
    async () => {
      const opts = priced("price-repo-unpriced", onUnpriced());
      writeFileSync(join(opts.repoDir, ".git", "qcr-review.json"), JSON.stringify({ usd_base: 1 }));
      const r = await preview({ kind: "branch" }, opts);
      const p = previewOf(r);
      expect(p).toMatchObject({ price_basis: "repo", cap_usd: null });
      expect(p["estimate_usd"]).toBeGreaterThanOrEqual(1);
      expect(priceLinesOf(r.text)[0]).toMatch(
        /\(estimate, this repo's rates\) — pi has no price for gamma\/local-model, so no dollar stop; the 10-minute limit still holds/,
      );
    },
  );

  // MUTATION: drop the `tooShort` refusal before the price (reviewapi.ts) —
  // the review starts and its pinned lenses fail one by one when their
  // sessions are opened, and this fails.
  it(
    "a tier pinned to a provider whose login is too short is refused before anything runs, and the preview says so",
    { timeout: 30_000 },
    async () => {
      const logins = [{ provider: "short", name: "Short", expiresAt: 2_000 }];
      const facts = { now: () => 1_000, needMs: 10 * 60_000 };
      const on = routed(routeTo("alpha", ID), [ALPHA], { skipped: logins, facts });
      const opts: ReviewOptions = {
        ...priced("price-pin-short", on, { limitUsd: 1000 }),
        config: {
          ...unpinned,
          models: {
            ...unpinned.models,
            tiers: { light: "short/x:low", standard: "short/x:medium", deep: "short/x:high" },
          },
        },
      };
      const words = refusalText({ code: "login-too-short", logins }, "app", facts);
      const pre = await preview({ kind: "branch" }, opts);
      expect(pre.exitCode, pre.text).toBe(0);
      const p = previewOf(pre);
      expect(p["refusal"]).toEqual({ code: "login-too-short", text: words });
      expect(p["auto"]).toBe(false);
      expect(pre.text.split("\n")).toContain(`  ✗ ${words}`);

      const started = await review({ kind: "branch" }, opts);
      expect(started.exitCode).toBe(1);
      expect(errorsOf(started)).toEqual([words]);
    },
  );

  describe("for a caller on contract 1", () => {
    it(
      "the measured model reads as it always did: version 1, with its estimate",
      { timeout: 30_000 },
      async () => {
        const r = await preview(
          { kind: "branch" },
          { ...priced("c1-measured", onMeasured()), contract: 1 },
        );
        expect(r.exitCode, r.text).toBe(0);
        expect(r.data.schema_version).toBe(1);
        expect(validate(resultSchemaV1, r.data)).toEqual([]);
        expect(previewOf(r)["estimate_usd"]).toBeGreaterThan(0);
        // contract 2 reads the same review under version 2
        const two = await preview(
          { kind: "branch" },
          { ...priced("c1-measured-two", onMeasured()), contract: 2 },
        );
        expect(two.data.schema_version).toBe(2);
      },
    );

    // MUTATION: return the v1 projection for an unmeasured preview (drop the
    // `needsEstimate && price === null` refusal in reviewapi.ts and restamp
    // the payload in reviewForContract) — this fails.
    it(
      "a review with no estimate is refused before anything runs, in contract 1's own shape",
      { timeout: 30_000 },
      async () => {
        const noPrice = (spec: string, tail: string): string =>
          `this review would run on ${spec}, which has no measured price, and contract 1 cannot say so. ` +
          `Update the QuickReview skills (qcr plugin install)${tail}.`;
        // a credentialed provider serves the measured model: the refusal names it
        const both = await preview(
          { kind: "branch" },
          { ...priced("c1-unmeasured", onUnmeasured([BETA, ALPHA])), contract: 1 },
        );
        expect(both.exitCode).toBe(1);
        expect(both.data).toEqual({
          schema_version: 1,
          ok: false,
          errors: [
            noPrice("beta/other-model", `, or run on a measured model: --model alpha/${ID}`),
          ],
        });
        expect(validate(resultSchemaV1, both.data)).toEqual([]);
        expect(JSON.stringify(both.data)).not.toMatch(/estimate_usd|cap_usd/);

        // none does: the clause is left out
        const alone = await preview(
          { kind: "branch" },
          { ...priced("c1-unmeasured-alone", onUnmeasured()), contract: 1 },
        );
        expect(alone.data).toEqual({
          schema_version: 1,
          ok: false,
          errors: [noPrice("beta/other-model", "")],
        });

        const unpriced = await preview(
          { kind: "branch" },
          { ...priced("c1-unpriced", onUnpriced()), contract: 1 },
        );
        expect(unpriced.exitCode).toBe(1);
        expect(unpriced.data).toEqual({
          schema_version: 1,
          ok: false,
          errors: [noPrice("gamma/local-model", "")],
        });

        // a start, with the stop named and the key's place taken: still refused,
        // and no runtime is asked for
        const started = await review(
          { kind: "branch" },
          { ...priced("c1-unmeasured-start", onUnmeasured(), { limitUsd: 50 }), contract: 1 },
        );
        expect(started.exitCode).toBe(1);
        expect(started.data).toEqual({
          schema_version: 1,
          ok: false,
          errors: [noPrice("beta/other-model", "")],
        });
      },
    );

    // MUTATION: drop `|| needsEstimate` from the no-route refusal
    // (reviewapi.ts) — the preview goes on to the price refusal (or prints a
    // null estimate), and this fails.
    it("with no route the login refusal wins, on a preview too", { timeout: 30_000 }, async () => {
      const none: ReviewRouted = {
        result: { ok: false, refusal: { code: "no-credential" } },
        inventory: [],
        surface: "app",
        facts: { agentDir: "/pi/home" },
      };
      const r = await preview({ kind: "branch" }, { ...priced("c1-no-route", none), contract: 1 });
      expect(r.exitCode).toBe(1);
      expect(r.data).toEqual({
        schema_version: 1,
        ok: false,
        errors: [
          "pi has no model credential (agent dir /pi/home). Run `qcr login` and sign in to any provider, " +
            "or set a provider's API key in the environment, then run this again.",
        ],
      });
    });
  });
});

describe("workTreeFactsIo: an uncommitted head read off the working tree", () => {
  // MUTATION: read the head with no path check (drop both the realpath
  // comparison and `st.isFile()` in workTreeFactsIo's readHead; either alone
  // refuses the symlink) — it is followed out of the tree, and this fails. MUTATION: drop the
  // `--deleted` filter — the deleted file is listed, and this fails.
  it("lists what `git add -A` takes, reads regular files only, and the base from git", () => {
    const repo = mkRepo("worktree-io");
    writeFileSync(join(repo, ".gitignore"), "ignored.ts\n");
    writeFileSync(join(repo, "ignored.ts"), "secret\n");
    writeFileSync(join(repo, "src", "new.ts"), "export const n = 0;\n");
    writeFileSync(join(tmp, "outside.txt"), "outside\n");
    symlinkSync(join(tmp, "outside.txt"), join(repo, "src", "link.ts"));
    const base = git(repo, "rev-parse", "main");
    const io = workTreeFactsIo(join(repo, "src"), base);
    const listed = io.listHead();
    expect(listed).toContain("src/a.ts");
    expect(listed).toContain("src/new.ts");
    expect(listed).toContain("src/link.ts");
    expect(listed).not.toContain("ignored.ts");
    expect(io.readHead("src/new.ts")).toBe("export const n = 0;\n");
    expect(io.readHead("src/a.ts")).toMatch(/export const c = 3;/);
    expect(io.readHead("src/link.ts")).toBeNull();
    expect(io.readHead("ignored.ts")).toBeNull();
    expect(io.readHead("../outside.txt")).toBeNull();
    expect(io.readBase("src/a.ts")).toBe("export const a = 1;\n");
    // a tracked file deleted from the tree is not in the head
    rmSync(join(repo, "src", "a.ts"));
    expect(workTreeFactsIo(repo, base).listHead()).not.toContain("src/a.ts");
  });
});
