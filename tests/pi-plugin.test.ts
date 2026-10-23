// The pi plugin (packages/pi-plugin), in process: its manifest, the version
// gate, what the extension registers, the /review flow over fake ports, the
// destination rule, the borrowed login, and /scan, /selfimprove and
// /qcr-setup over a fake runner. Nothing here spawns a process or touches the
// network: the faux-provider round is tests/pi-plugin-round.test.ts, the
// packed install tests/pi-plugin-install.test.ts. git runs: each fake host's
// repo is a scratch git repo (the review store keys a repo's saved
// destination by its root commit).
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createQuickReview } from "@quickchatai/pi-quickreview/extensions/quickreview.js";
import {
  declaredPiRange,
  parseSemver,
  piGate,
  satisfiesRange,
} from "@quickchatai/pi-quickreview/src/plugin/versiongate.js";
import { parseReviewCommand, splitArgs } from "@quickchatai/pi-quickreview/src/plugin/args.js";
import {
  destinationMenu,
  planDestinations,
  printDestinations,
} from "@quickchatai/pi-quickreview/src/reviewdest.js";
import {
  borrowLogin,
  reviewProviders,
  type HostAuth,
} from "@quickchatai/pi-quickreview/src/plugin/login.js";
import {
  REVIEW_TIMEOUT_MS,
  runReviewCommand,
  type ReviewCommandDeps,
} from "@quickchatai/pi-quickreview/src/plugin/review.js";
import type {
  ReviewIo,
  ReviewOptions,
  ReviewResult,
  ReviewTarget,
} from "@quickchatai/pi-quickreview/src/reviewapi.js";
import {
  parseScanCommand,
  runScanCommand,
  runSelfImproveCommand,
  selfImproveBrief,
} from "@quickchatai/pi-quickreview/src/plugin/scan.js";
import { runSetupChecks } from "@quickchatai/pi-quickreview/src/plugin/setup.js";
import type {
  PluginHost,
  Runner,
  RunResult,
  SessionUi,
} from "@quickchatai/pi-quickreview/src/plugin/session.js";
import { coreExtensionFile } from "@quickchatai/pi-quickreview/src/engine/extfiles.js";
import { ROUND_EXTENSIONS } from "@quickchatai/pi-quickreview/src/engine/round.js";

const ROOT = resolve(import.meta.dirname, "..");
const PLUGIN = join(ROOT, "packages", "pi-plugin");
const tmp = mkdtempSync(join(tmpdir(), "pi-plugin-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const pluginPkg = (): Record<string, unknown> & {
  pi: { extensions: string[] };
  peerDependencies: Record<string, string>;
  dependencies: Record<string, string>;
  files: string[];
  keywords: string[];
} => JSON.parse(readFileSync(join(PLUGIN, "package.json"), "utf8"));

describe("the plugin's manifest", () => {
  it("is a pi package of exactly one extension, the host entry", () => {
    const pkg = pluginPkg();
    expect(pkg.keywords).toContain("pi-package");
    expect(pkg.pi).toEqual({ extensions: ["./dist/src/plugin/index.js"] });
    expect(pkg.files).toEqual(["dist", "assets", "README.md", "LICENSE"]);
  });

  // pi supplies these; a copy beside it would be a second instance of pi's
  // modules. MUTATION: move pi-ai into dependencies — this fails.
  it("takes pi's packages as peers, never as dependencies", () => {
    const pkg = pluginPkg();
    for (const p of [
      "@earendil-works/pi-coding-agent",
      "@earendil-works/pi-ai",
      "@earendil-works/pi-agent-core",
      "@earendil-works/pi-tui",
      "typebox",
    ]) {
      expect(pkg.peerDependencies[p], p).toBeDefined();
      expect(pkg.dependencies[p], p).toBeUndefined();
    }
    expect(pkg.peerDependencies["@earendil-works/pi-coding-agent"]).toBe("^1.3.0");
  });

  // pi reads a package.json `pi` key as a manifest: the app's root must never
  // look like a pi package. MUTATION: rename qcrPi back to pi — this fails.
  it("leaves the app's root without a `pi` key; its pin mirror is qcrPi", () => {
    const root = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as Record<
      string,
      unknown
    >;
    expect(root).not.toHaveProperty("pi");
    expect(root["qcrPi"]).toMatchObject({ package: "@earendil-works/pi-coding-agent" });
  });

  // The core resolves its own extensions beside itself, never under the
  // caller's checkout. MUTATION: point extfiles at extensions/cli — this fails.
  it("names the round's extensions inside its own package", () => {
    for (const name of ROUND_EXTENSIONS) {
      const file = coreExtensionFile(name);
      expect(file.startsWith(join(PLUGIN, "extensions") + "/"), file).toBe(true);
      expect(readFileSync(file, "utf8").length).toBeGreaterThan(0);
    }
    expect(coreExtensionFile("bash-guard", "file:///x/pkg/dist/src/engine/extfiles.js")).toBe(
      "/x/pkg/dist/extensions/bash-guard.js",
    );
  });
});

describe("the version gate", () => {
  it("reads versions", () => {
    expect(parseSemver("1.3.0")).toEqual({ major: 1, minor: 3, patch: 0, pre: null });
    expect(parseSemver("v1.4.2-rc.1+b")).toEqual({ major: 1, minor: 4, patch: 2, pre: "rc.1" });
    expect(parseSemver("1.3")).toBeNull();
  });

  // MUTATION: let a caret cross a major, or admit a prerelease — this fails.
  it("holds a caret to its major (a 0.x to its minor) and refuses prereleases", () => {
    const yes: Array<[string, string]> = [
      ["1.3.0", "^1.3.0"],
      ["1.3.7", "^1.3.0"],
      ["1.9.0", "^1.3.0"],
      ["0.3.5", "^0.3.1"],
      ["1.3.0", "1.3.0"],
      ["1.4.9", ">=1.3.0 <1.5.0"],
    ];
    const no: Array<[string, string]> = [
      ["1.2.9", "^1.3.0"],
      ["2.0.0", "^1.3.0"],
      ["1.4.0-rc.1", "^1.3.0"],
      ["0.4.0", "^0.3.1"],
      ["1.5.0", ">=1.3.0 <1.5.0"],
      ["garbage", "^1.3.0"],
      ["1.3.0", "~1.3.0"],
      ["1.3.0", ""],
    ];
    for (const [v, r] of yes) expect(satisfiesRange(v, r), `${v} in ${r}`).toBe(true);
    for (const [v, r] of no) expect(satisfiesRange(v, r), `${v} in ${r}`).toBe(false);
  });

  it("is the range the package declares, and names both versions when it refuses", () => {
    expect(declaredPiRange()).toBe("^1.3.0");
    expect(piGate("1.3.0", "^1.3.0")).toBeNull();
    const msg = piGate("2.0.0", "^1.3.0")!;
    expect(msg).toMatch(/\^1\.3\.0/);
    expect(msg).toMatch(/2\.0\.0/);
  });
});

/** A pi ExtensionAPI that records what an extension registers. */
function fakePi(): {
  api: ExtensionAPI;
  commands: Map<
    string,
    { description?: string; handler: (a: string, ctx: unknown) => Promise<void> }
  >;
  tools: unknown[];
  handlers: Map<string, Array<(e: unknown, ctx: unknown) => unknown>>;
  sent: unknown[];
  userMessages: string[];
} {
  const commands = new Map();
  const tools: unknown[] = [];
  const handlers = new Map<string, Array<(e: unknown, ctx: unknown) => unknown>>();
  const sent: unknown[] = [];
  const userMessages: string[] = [];
  const api = {
    registerCommand: (name: string, o: unknown) => commands.set(name, o),
    registerTool: (t: unknown) => tools.push(t),
    on: (event: string, h: (e: unknown, ctx: unknown) => unknown) => {
      handlers.set(event, [...(handlers.get(event) ?? []), h]);
      return () => {};
    },
    sendMessage: (m: unknown) => sent.push(m),
    sendUserMessage: (t: string) => userMessages.push(t),
  };
  return { api: api as unknown as ExtensionAPI, commands, tools, handlers, sent, userMessages };
}

const noRunner: Runner = {
  which: () => null,
  run: async () => ({ code: 127, stdout: "", stderr: "" }),
};

describe("the extension", () => {
  const config = { env: {}, home: tmp, runner: noRunner, print: () => {} };

  // Passes are leaves: the person's session gets commands, never a tool.
  // MUTATION: register the lens tool here — this fails.
  it("registers exactly its four commands, and no tool, on a pi inside the range", () => {
    const pi = fakePi();
    createQuickReview({ ...config, piVersion: "1.3.0", range: "^1.3.0" })(pi.api);
    expect([...pi.commands.keys()].sort()).toEqual(["qcr-setup", "review", "scan", "selfimprove"]);
    expect(pi.tools).toEqual([]);
  });

  // MUTATION: drop the gate — this fails.
  it("registers nothing on a pi outside the range, and says why once", () => {
    const pi = fakePi();
    createQuickReview({ ...config, piVersion: "1.2.0", range: "^1.3.0" })(pi.api);
    expect(pi.commands.size).toBe(0);
    expect(pi.tools).toEqual([]);
    const notes: string[] = [];
    const ctx = { ui: { notify: (m: string) => notes.push(m) } };
    for (const h of pi.handlers.get("session_start") ?? []) h({}, ctx);
    for (const h of pi.handlers.get("session_start") ?? []) h({}, ctx);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatch(/\^1\.3\.0.*1\.2\.0/);
  });
});

describe("/review's arguments", () => {
  it("split on spaces, with quotes grouping", () => {
    expect(splitArgs(' 12  --profile "my p" ')).toEqual(["12", "--profile", "my p"]);
  });

  it("name one target, the branch by default", () => {
    expect(parseReviewCommand("")).toMatchObject({ target: { kind: "branch" }, preview: false });
    expect(parseReviewCommand("--branch --base dev")).toMatchObject({
      target: { kind: "branch", base: "dev" },
    });
    expect(parseReviewCommand("#12 --repo o/r --to pr --limit 3 --profile p --json")).toEqual({
      target: { kind: "pr", pr: "#12", repo: "o/r" },
      preview: false,
      json: true,
      full: false,
      to: ["pr"],
      limitUsd: 3,
      profile: "p",
    });
    expect(parseReviewCommand("--uncommitted --preview")).toMatchObject({
      target: { kind: "uncommitted" },
      preview: true,
    });
    for (const bad of [
      "12 13",
      "12 --uncommitted",
      "--to nowhere",
      "--limit -1",
      "--repo o/r",
      "--uncommitted --base x",
      "--wat",
      "--profile",
    ])
      expect(parseReviewCommand(bad), bad).toHaveProperty("error");
  });
});

describe("where a result goes (the rule /review and qcr review share)", () => {
  const base = { explicit: [], json: false, saved: null, target: { pr: true } } as const;

  it("flags win, then the saved default, then asking, then printing", () => {
    expect(
      planDestinations({ ...base, explicit: ["file"], interactive: true, surface: "session" }),
    ).toEqual({ kind: "fixed", destinations: ["file"], source: "flags" });
    expect(
      planDestinations({ ...base, json: true, interactive: true, surface: "session" }),
    ).toEqual({ kind: "fixed", destinations: ["json"], source: "flags" });
    expect(
      planDestinations({ ...base, saved: ["pr"], interactive: true, surface: "session" }),
    ).toEqual({ kind: "fixed", destinations: ["pr"], source: "saved" });
    expect(planDestinations({ ...base, interactive: true, surface: "session" }).kind).toBe("ask");
    expect(planDestinations({ ...base, interactive: false, surface: "session" })).toEqual({
      kind: "fixed",
      destinations: ["terminal"],
      source: "print",
    });
    expect(printDestinations("terminal", false)).toEqual(["terminal", "json"]);
  });

  it("drops a saved post on a target without a PR, and never offers one there", () => {
    expect(
      planDestinations({
        ...base,
        saved: ["pr"],
        target: { pr: false },
        interactive: true,
        surface: "session",
      }).kind,
    ).toBe("ask");
    const menu = destinationMenu({ pr: false }, "session");
    expect(menu.flatMap((m) => m.pick.destinations)).not.toContain("pr");
  });

  it("asks each time, with each answer once more as the repo's default", () => {
    const menu = destinationMenu({ pr: true }, "session");
    expect(menu).toHaveLength(6);
    expect(menu.filter((m) => m.pick.remember)).toHaveLength(3);
    // a post is shown where the person is, too
    expect(menu.find((m) => m.pick.destinations.includes("pr"))!.pick.destinations).toEqual([
      "pr",
      "terminal",
    ]);
  });
});

/** A host auth over a fixed login file and a refresh that extends it. */
function fakeAuth(
  logins: Record<string, { type: string; expires: number | null }>,
  o: { configured?: string[]; refreshTo?: number; refuse?: boolean } = {},
): HostAuth & { refreshed: Array<[string, number]> } {
  const refreshed: Array<[string, number]> = [];
  return {
    refreshed,
    logins: () => structuredClone(logins),
    configured: (p) => logins[p] !== undefined || (o.configured ?? []).includes(p),
    refresh: async (p, ms) => {
      refreshed.push([p, ms]);
      if (o.refuse) throw new Error("token endpoint said no");
      logins[p] = { type: "oauth", expires: o.refreshTo ?? Date.now() + 10 * 3600_000 };
    },
  };
}

describe("the borrowed login", () => {
  const cfg = {
    models: {
      conversation: "openai-codex/gpt-6.1-sol",
      default: "openai-codex/gpt-6.1-sol",
      tiers: { "sol-high": "openai-codex/gpt-6.1-sol:high", "terra-med": "anthropic/x:medium" },
      pass_models: { "pass-x": "google/g" },
    },
  } as unknown as Parameters<typeof reviewProviders>[0];

  it("collects every provider the review's models name", () => {
    expect(reviewProviders(cfg)).toEqual(["openai-codex", "anthropic", "google"]);
  });

  it("leaves a long login alone and has the host refresh a short one", async () => {
    const now = Date.now();
    const long = fakeAuth({ "openai-codex": { type: "oauth", expires: now + 5 * 3600_000 } });
    expect(
      await borrowLogin({ providers: ["openai-codex"], host: long, needMs: 3600_000, marginMs: 0 }),
    ).toEqual({ ok: true, refreshed: [] });
    expect(long.refreshed).toEqual([]);
    // MUTATION: refuse a short login instead of asking the host — this fails.
    const short = fakeAuth({ "openai-codex": { type: "oauth", expires: now + 600_000 } });
    expect(
      await borrowLogin({
        providers: ["openai-codex"],
        host: short,
        needMs: 3600_000,
        marginMs: 300_000,
      }),
    ).toEqual({ ok: true, refreshed: ["openai-codex"] });
    expect(short.refreshed).toEqual([["openai-codex", 3900_000]]);
  });

  it("fails with pi's /login when the host cannot refresh, or the refresh is still short", async () => {
    const now = Date.now();
    const refused = fakeAuth(
      { "openai-codex": { type: "oauth", expires: now + 1000 } },
      { refuse: true },
    );
    const r1 = await borrowLogin({
      providers: ["openai-codex"],
      host: refused,
      needMs: 3600_000,
      marginMs: 0,
    });
    expect(r1.ok).toBe(false);
    expect(!r1.ok && r1.error).toMatch(/\/login openai-codex/);
    const stillShort = fakeAuth(
      { "openai-codex": { type: "oauth", expires: now + 1000 } },
      { refreshTo: now + 60_000 },
    );
    const r2 = await borrowLogin({
      providers: ["openai-codex"],
      host: stillShort,
      needMs: 3600_000,
      marginMs: 0,
    });
    expect(!r2.ok && r2.error).toMatch(/does not last/);
  });

  // Only a key and no login fails with a hint; the review never
  // switches models. MUTATION: accept any configured provider — this fails.
  it("fails a provider pi has no login for, naming /login, even with a key for another", async () => {
    const keyOnly = fakeAuth({ openai: { type: "api_key", expires: null } });
    const r = await borrowLogin({
      providers: ["openai-codex"],
      host: keyOnly,
      needMs: 1,
      marginMs: 0,
    });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/Run \/login openai-codex in pi/);
    expect(!r.ok && r.error).toMatch(/does not switch models/);
    // a key for the provider the review runs on is that provider's route
    const keyed = fakeAuth({}, { configured: ["anthropic"] });
    expect(
      await borrowLogin({ providers: ["anthropic"], host: keyed, needMs: 1, marginMs: 0 }),
    ).toEqual({ ok: true, refreshed: [] });
  });
});

/** A session UI that records what reaches the person. */
function fakeUi(o: Partial<SessionUi> & { picks?: string[]; yes?: boolean } = {}): SessionUi & {
  notes: Array<[string, string]>;
  shown: string[];
  printed: string[];
  asked: string[][];
  told: string[];
  escape: () => void;
} {
  const notes: Array<[string, string]> = [];
  const shown: string[] = [];
  const printed: string[] = [];
  const asked: string[][] = [];
  const told: string[] = [];
  let esc: (() => void) | null = null;
  const picks = [...(o.picks ?? [])];
  return {
    mode: "tui",
    interactive: true,
    select: async (_t, options) => {
      asked.push(options);
      const want = picks.shift();
      return options.find((x) => x === want);
    },
    confirm: async () => o.yes ?? true,
    notify: (m, level) => notes.push([level, m]),
    status: () => {},
    onEscape: (h) => {
      esc = h;
      return () => {
        esc = null;
      };
    },
    show: (m) => shown.push(m),
    tellAgent: (t) => told.push(t),
    print: (t) => printed.push(t),
    ...o,
    notes,
    shown,
    printed,
    asked,
    told,
    escape: () => esc?.(),
  };
}

let hostN = 0;
function fakeHost(o: Partial<PluginHost> = {}): PluginHost {
  const dir = join(tmp, `host-${++hostN}`);
  mkdirSync(join(dir, "repo"), { recursive: true });
  const git = (...args: string[]): void =>
    void execFileSync(
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
      { cwd: join(dir, "repo"), stdio: "ignore" },
    );
  git("init", "-q", "-b", "main");
  git("commit", "-q", "--allow-empty", "-m", "root");
  return {
    cwd: join(dir, "repo"),
    env: {
      XDG_STATE_HOME: join(dir, "state"),
      XDG_CONFIG_HOME: join(dir, "config"),
      PATH: process.env.PATH,
    },
    home: dir,
    piVersion: "1.3.0",
    agentDir: join(dir, "agent"),
    auth: fakeAuth({ "openai-codex": { type: "oauth", expires: Date.now() + 10 * 3600_000 } }),
    runner: noRunner,
    shutdown: new AbortController().signal,
    ...o,
  };
}

/** Review deps whose review() records its call and returns `result`. */
function fakeReview(result: Partial<ReviewResult> = {}): ReviewCommandDeps & {
  calls: Array<{ target: ReviewTarget; opts: ReviewOptions; io: ReviewIo; mode: string }>;
} {
  const calls: Array<{ target: ReviewTarget; opts: ReviewOptions; io: ReviewIo; mode: string }> =
    [];
  const done =
    (mode: string) =>
    async (target: ReviewTarget, opts: ReviewOptions, io: ReviewIo = {}) => {
      calls.push({ target, opts, io, mode });
      return {
        data: { schema_version: 1, ok: true },
        markdown: "# Review\n\nNo findings.\n",
        text: "No findings.",
        exitCode: 0 as const,
        destinations: opts.destinations ?? null,
        ...result,
      };
    };
  return {
    calls,
    review: done("review"),
    preview: done("preview"),
    root: () => ROOT,
    runtime: () => {
      throw new Error("no runtime in a fake review");
    },
  };
}

describe("/review over fake ports", () => {
  // MUTATION: skip the question when nothing is saved — this fails.
  it("asks where the result goes, each time, until an answer is kept for the repo", async () => {
    const host = fakeHost();
    const deps = fakeReview();
    const ui = fakeUi({ picks: ["show it in this session"] });
    await runReviewCommand("", host, ui, deps);
    expect(ui.asked).toHaveLength(1);
    expect(deps.calls[0]!.opts.destinations).toEqual(["terminal"]);
    expect(ui.shown.join("\n")).toMatch(/# Review/);
    // asked again: nothing was kept
    const ui2 = fakeUi({
      picks: ["save it as markdown and JSON, and always do this in this repo"],
    });
    await runReviewCommand("", host, ui2, deps);
    expect(ui2.asked).toHaveLength(1);
    expect(deps.calls[1]!.opts.destinations).toEqual(["file"]);
    // kept: the next run asks nothing
    const ui3 = fakeUi();
    await runReviewCommand("", host, ui3, deps);
    expect(ui3.asked).toHaveLength(0);
    expect(deps.calls[2]!.opts.destinations).toEqual(["file"]);
  });

  it("runs as a host inside pi: its login, its cwd, the state home's runs, no memory", async () => {
    const host = fakeHost();
    const deps = fakeReview();
    // The shipped defaults keep dry_run on: posting is refused before the
    // review is paid for, and nothing flips the flag on the person's behalf.
    const refused = fakeUi();
    await runReviewCommand("12 --to pr --profile generic", host, refused, deps);
    expect(deps.calls).toHaveLength(0);
    expect(refused.notes.find(([l]) => l === "error")?.[1]).toMatch(
      /posting needs a qcr config with dry_run = false/,
    );
    // The person's own config, with dry_run off, lets it post.
    const configDir = join(host.env["XDG_CONFIG_HOME"]!, "qcr", "default");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, "config.toml"),
      readFileSync(join(ROOT, "config.example.toml"), "utf8").replace(
        /^dry_run = true$/m,
        "dry_run = false",
      ),
    );
    await runReviewCommand("12 --to pr --profile generic", host, fakeUi(), deps);
    const { target, opts } = deps.calls[0]!;
    expect(opts.config.dry_run).toBe(false);
    expect(target).toEqual({ kind: "pr", pr: "12" });
    expect(opts.repoDir).toBe(host.cwd);
    expect(opts.agentDir).toBe(host.agentDir);
    expect(opts.runsDir).toBe(
      join(host.env["XDG_STATE_HOME"]!, "qcr", "default", "review", "runs"),
    );
    expect(opts.memory).toBeNull();
    expect(opts.destinations).toEqual(["pr"]);
    expect(opts.limits.timeoutMs).toBe(REVIEW_TIMEOUT_MS);
  });

  it("prints in pi's print mode, the JSON with --json, and asks nothing", async () => {
    const deps = fakeReview();
    const ui = fakeUi({ mode: "print", interactive: false });
    await runReviewCommand("", fakeHost(), ui, deps);
    expect(ui.asked).toHaveLength(0);
    expect(ui.printed).toEqual(["# Review\n\nNo findings.\n"]);
    const uj = fakeUi({ mode: "print", interactive: false });
    await runReviewCommand("--json", fakeHost(), uj, deps);
    expect(JSON.parse(uj.printed[0]!)).toEqual({ schema_version: 1, ok: true });
  });

  it("refuses with pi's /login when only a key is there, before anything runs", async () => {
    const deps = fakeReview();
    const ui = fakeUi({ picks: ["show it in this session"] });
    const host = fakeHost({ auth: fakeAuth({ openai: { type: "api_key", expires: null } }) });
    await runReviewCommand("", host, ui, deps);
    expect(deps.calls).toHaveLength(0);
    expect(ui.notes.find(([l]) => l === "error")?.[1]).toMatch(/\/login openai-codex/);
  });

  it("a preview needs no login and asks nothing", async () => {
    const deps = fakeReview({ markdown: null, text: "price: $0.61" });
    const ui = fakeUi();
    const host = fakeHost({ auth: fakeAuth({}) });
    await runReviewCommand("--preview", host, ui, deps);
    expect(deps.calls[0]!.mode).toBe("preview");
    expect(ui.asked).toHaveLength(0);
    expect(ui.shown[0]).toMatch(/price: \$0\.61/);
  });

  // MUTATION: drop the Esc hook — this fails.
  it("Esc and the session's end stop the run", async () => {
    let seen: AbortSignal | undefined;
    const deps: ReviewCommandDeps = {
      ...fakeReview(),
      review: async (_t, opts, io = {}) => {
        seen = io.signal;
        ui.escape();
        return {
          data: { schema_version: 1, ok: false, stopped: true },
          markdown: null,
          text: "✗ the review was stopped",
          exitCode: 1,
          destinations: opts.destinations ?? null,
        };
      },
    };
    const ui = fakeUi({ picks: ["show it in this session"] });
    await runReviewCommand("", fakeHost(), ui, deps);
    expect(seen?.aborted).toBe(true);
    const ended = new AbortController();
    let seen2: AbortSignal | undefined;
    const ui2 = fakeUi({ picks: ["show it in this session"] });
    await runReviewCommand("", fakeHost({ shutdown: ended.signal }), ui2, {
      ...deps,
      review: async (_t, opts, io = {}) => {
        seen2 = io.signal;
        ended.abort();
        return {
          data: { schema_version: 1, ok: false },
          markdown: null,
          text: "✗ stopped",
          exitCode: 1,
          destinations: opts.destinations ?? null,
        };
      },
    });
    expect(seen2?.aborted).toBe(true);
  });

  it("says a usage error and runs nothing", async () => {
    const deps = fakeReview();
    const ui = fakeUi();
    await runReviewCommand("--to mars", fakeHost(), ui, deps);
    expect(deps.calls).toHaveLength(0);
    expect(ui.notes[0]).toEqual(["error", expect.stringMatching(/unknown destination mars/)]);
  });
});

/** A runner that answers `qcr` calls from a script and logs them. */
function scriptedRunner(
  answers: Record<string, RunResult | ((args: readonly string[]) => RunResult)>,
  on: string[] = ["qcr", "git", "gh", "npm"],
): Runner & {
  calls: string[][];
  envs: Array<Readonly<Record<string, string | undefined>> | undefined>;
} {
  const calls: string[][] = [];
  const envs: Array<Readonly<Record<string, string | undefined>> | undefined> = [];
  return {
    calls,
    envs,
    which: (cmd) => (on.includes(cmd) ? `/bin/${cmd}` : null),
    run: async (cmd, args, o) => {
      calls.push([cmd, ...args]);
      envs.push(o.env);
      const key = [cmd.replace("/bin/", ""), ...args.filter((a) => !a.startsWith("--"))]
        .slice(0, 3)
        .join(" ");
      const a = answers[key] ?? answers[key.split(" ").slice(0, 2).join(" ")];
      if (a === undefined) return { code: 0, stdout: "", stderr: "" };
      return typeof a === "function" ? a(args) : a;
    },
  };
}

const ok = (o: unknown): RunResult => ({ code: 0, stdout: JSON.stringify(o) + "\n", stderr: "" });
const FINDING = {
  fingerprint: "fp1",
  file: "src/a.ts",
  range: { start: 3, end: 3 },
  lens: "pass-baseline",
  severity: "P1",
  claim: "a subtracts",
};
const scanAnswers = {
  "qcr scan preview": ok({
    ok: true,
    preview: { files: 4, mode: "full", estimate_usd: 1.5, cap_usd: 3 },
    start: ["--key", "k1", "--sha", "abc"],
  }),
  "qcr scan start": ok({ ok: true, run: { id: "r1" } }),
  "qcr scan status": ok({ ok: true, run: { sha: "abcdef1234567890", display: "complete" } }),
  "qcr scan findings": ok({ ok: true, total: 1, findings: [FINDING] }),
};

describe("/scan and /selfimprove (the qcr on PATH)", () => {
  it("prices, asks, starts, waits and lists the new findings, on the repo pi is in", async () => {
    const runner = scriptedRunner(scanAnswers);
    const host = fakeHost({ runner });
    const ui = fakeUi();
    await runScanCommand("", host, ui);
    expect(runner.calls.map((c) => c.slice(1, 3).join(" "))).toEqual([
      "scan preview",
      "scan start",
      "scan status",
      "scan findings",
    ]);
    expect(runner.calls[1]).toEqual([
      "/bin/qcr",
      "scan",
      "start",
      "--key",
      "k1",
      "--sha",
      "abc",
      "--sandbox",
      "host",
      "--json",
    ]);
    expect(runner.envs.every((e) => e?.["QCR_REVIEWED_REPO"] === host.cwd)).toBe(true);
    // qcr's own default is the docker sandbox: natively on this machine is
    // the plugin's default, so every call says so
    for (const c of runner.calls) {
      const at = c.indexOf("--sandbox");
      expect(at, c.join(" ")).toBeGreaterThan(0);
      expect(c[at + 1]).toBe("host");
      expect(c.lastIndexOf("--sandbox")).toBe(at);
    }
    expect(ui.shown[0]).toMatch(/src\/a\.ts:3.*a subtracts.*fp1/);
  });

  it("passes --sandbox docker through, and starts nothing on a no", async () => {
    const runner = scriptedRunner(scanAnswers);
    const ui = fakeUi({ yes: false });
    await runScanCommand("--sandbox docker", fakeHost({ runner }), ui);
    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]).toContain("--sandbox");
    expect(runner.calls[0]).toContain("docker");
    expect(ui.notes.at(-1)?.[1]).toMatch(/not started/);
    expect(parseScanCommand("--sandbox vm")).toHaveProperty("error");
  });

  it("with nobody to confirm a price, starts nothing", async () => {
    const runner = scriptedRunner(scanAnswers);
    const ui = fakeUi({ interactive: false, mode: "print" });
    await runScanCommand("", fakeHost({ runner }), ui);
    expect(runner.calls).toHaveLength(1);
    expect(ui.printed[0]).toMatch(/nobody here can confirm/);
  });

  it("passes a subcommand through as typed", async () => {
    const runner = scriptedRunner({
      "qcr scan findings": { code: 0, stdout: "1 finding\n", stderr: "" },
    });
    const ui = fakeUi();
    await runScanCommand("findings --state new", fakeHost({ runner }), ui);
    expect(runner.calls[0]).toEqual([
      "/bin/qcr",
      "scan",
      "findings",
      "--state",
      "new",
      "--sandbox",
      "host",
    ]);
    // a sandbox the person typed is theirs: none is added beside it
    const typed = scriptedRunner({});
    await runScanCommand("findings --sandbox docker", fakeHost({ runner: typed }), fakeUi());
    expect(typed.calls[0]).toEqual(["/bin/qcr", "scan", "findings", "--sandbox", "docker"]);
    expect(ui.shown[0]).toMatch(/1 finding/);
  });

  it("points at /qcr-setup when qcr is not on PATH", async () => {
    const ui = fakeUi();
    await runScanCommand("", fakeHost(), ui);
    expect(ui.notes[0]?.[1]).toMatch(/\/qcr-setup/);
    expect(ui.notes[0]?.[1]).toContain("npm i -g @quickchatai/quickreview");
  });

  // The engine scans; the person's own agent fixes.
  it("/selfimprove hands this session's agent the findings and the fix loop", async () => {
    const runner = scriptedRunner(scanAnswers);
    const host = fakeHost({ runner });
    const ui = fakeUi();
    await runSelfImproveCommand("", host, ui);
    expect(ui.told).toHaveLength(1);
    const brief = ui.told[0]!;
    expect(brief).toMatch(/qcr scan dismiss/);
    expect(brief).toMatch(/needs-owner/);
    expect(brief).toMatch(/\/selfimprove --delta --sha/);
    expect(brief).toMatch(/"fingerprint": "fp1"/);
    expect(brief).toContain(host.cwd);
  });

  it("/selfimprove tells nobody anything when the scan finds nothing", async () => {
    const runner = scriptedRunner({
      ...scanAnswers,
      "qcr scan findings": ok({ ok: true, total: 0, findings: [] }),
    });
    const ui = fakeUi();
    await runSelfImproveCommand("", fakeHost({ runner }), ui);
    expect(ui.told).toHaveLength(0);
    expect(ui.shown[0]).toMatch(/nothing new/);
    expect(selfImproveBrief({ cwd: "/r", sha: null, findings: [], total: 3 })).toMatch(/0 of 3/);
  });
});

describe("/qcr-setup", () => {
  const range = "^1.3.0";

  it("checks pi, the login, git, GitHub and qcr", async () => {
    const runner = scriptedRunner({ "gh auth status": { code: 0, stdout: "", stderr: "" } });
    const checks = await runSetupChecks(fakeHost({ runner }), fakeUi(), {
      range,
      root: () => ROOT,
    });
    expect(checks.map((c) => [c.name, c.state])).toEqual([
      ["pi version", "ok"],
      ["login", "ok"],
      ["git", "ok"],
      ["GitHub", "ok"],
      ["qcr", "ok"],
    ]);
  });

  it("fails the login with the /login hint when only a key is there", async () => {
    const host = fakeHost({
      runner: scriptedRunner({}),
      auth: fakeAuth({ openai: { type: "api_key", expires: null } }),
    });
    const checks = await runSetupChecks(host, fakeUi(), { range, root: () => ROOT });
    const login = checks.find((c) => c.name === "login")!;
    expect(login.state).toBe("fail");
    expect(login.detail).toMatch(/\/login openai-codex/);
  });

  // MUTATION: install without asking — this fails.
  it("installs qcr only on the person's yes", async () => {
    const withoutQcr = (): Runner & { calls: string[][] } => {
      let installed = false;
      const inner = scriptedRunner({ "npm i": (): RunResult => ((installed = true), ok({})) }, [
        "git",
        "npm",
      ]);
      return { ...inner, which: (c) => (c === "qcr" && installed ? "/bin/qcr" : inner.which(c)) };
    };
    const no = withoutQcr();
    const c1 = await runSetupChecks(fakeHost({ runner: no }), fakeUi({ yes: false }), {
      range,
      root: () => ROOT,
    });
    expect(no.calls.some((c) => c[0] === "/bin/npm")).toBe(false);
    expect(c1.find((c) => c.name === "qcr")!.state).toBe("fail");
    const yes = withoutQcr();
    const c2 = await runSetupChecks(fakeHost({ runner: yes }), fakeUi({ yes: true }), {
      range,
      root: () => ROOT,
    });
    expect(yes.calls).toContainEqual(["/bin/npm", "i", "-g", "@quickchatai/quickreview"]);
    expect(c2.find((c) => c.name === "qcr")!.state).toBe("ok");
    // with nobody to ask, nothing is installed
    const quiet = withoutQcr();
    await runSetupChecks(
      fakeHost({ runner: quiet }),
      fakeUi({ interactive: false, mode: "print" }),
      {
        range,
        root: () => ROOT,
      },
    );
    expect(quiet.calls.some((c) => c[0] === "/bin/npm")).toBe(false);
  });

  it("reads a GitHub token's presence only", async () => {
    const host = fakeHost({ runner: scriptedRunner({}) });
    host.env["GITHUB_TOKEN"] = "secret-value";
    const checks = await runSetupChecks(host, fakeUi(), { range, root: () => ROOT });
    const gh = checks.find((c) => c.name === "GitHub")!;
    expect(gh.detail).toMatch(/GITHUB_TOKEN is set/);
    expect(JSON.stringify(checks)).not.toContain("secret-value");
  });
});

// The custom message type is the plugin's own; nothing else writes it.
it("keeps the run's JSON next to a saved report", async () => {
  const dir = join(tmp, "saved");
  mkdirSync(dir, { recursive: true });
  const report = join(dir, "report.md");
  writeFileSync(report, "# r\n");
  const deps = fakeReview({ data: { schema_version: 1, ok: true, report } });
  const ui = fakeUi();
  await runReviewCommand("--to file", fakeHost(), ui, deps);
  expect(JSON.parse(readFileSync(join(dir, "review.json"), "utf8"))).toMatchObject({ report });
});
