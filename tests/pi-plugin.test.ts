// The pi plugin (packages/pi-plugin), in process: its manifest and skills, the
// version gate, what the extension registers, /qcr-review in the background
// through the extension on a fake pi (status line, result message, one review
// at a time, stop, the posting rule), its arguments and presets, the
// destination rule, the borrowed login, and /qcr-scan and /qcr-setup over a
// fake runner. Nothing here spawns a process or touches the network: the
// faux-provider round is tests/pi-plugin-round.test.ts, the packed install
// tests/pi-plugin-install.test.ts, the real gate behind a post
// tests/review-post-cli.test.ts. git runs: each fake host's repo is a scratch
// git repo (the review store keys a repo's state by its root commit).
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  createQuickReview,
  QUICKREVIEW_COMMANDS,
} from "@quickchatai/pi-quickreview/extensions/quickreview.js";
import {
  declaredPiRange,
  parseSemver,
  piGate,
  satisfiesRange,
} from "@quickchatai/pi-quickreview/src/plugin/versiongate.js";
import {
  parseReviewCommand,
  REVIEW_PRESET_NAMES,
  reviewLabel,
  SECURITY_LENSES,
  splitArgs,
} from "@quickchatai/pi-quickreview/src/plugin/args.js";
import { readQuickReviewSettings } from "@quickchatai/pi-quickreview/src/plugin/settings.js";
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
  KEEP_IT_HERE,
  REVIEW_MESSAGE,
  REVIEW_TIMEOUT_MS,
  liveLensLines,
  reviewStatusLine,
  runReviewCommand,
  type ReviewCommandDeps,
} from "@quickchatai/pi-quickreview/src/plugin/review.js";
import type {
  PostOffer,
  ReviewIo,
  ReviewOptions,
  ReviewResult,
  ReviewTarget,
} from "@quickchatai/pi-quickreview/src/reviewapi.js";
import { parseScanCommand, runScanCommand } from "@quickchatai/pi-quickreview/src/plugin/scan.js";
import { runSetupChecks } from "@quickchatai/pi-quickreview/src/plugin/setup.js";
import type {
  PluginHost,
  Runner,
  RunResult,
  SessionUi,
} from "@quickchatai/pi-quickreview/src/plugin/session.js";
import { coreExtensionFile } from "@quickchatai/pi-quickreview/src/engine/extfiles.js";
import { ROUND_EXTENSIONS } from "@quickchatai/pi-quickreview/src/engine/round.js";
import { parseSkillFrontmatter } from "./helpers/skill-frontmatter.js";

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
  it("is a pi package of exactly one extension, the host entry, and its skills", () => {
    const pkg = pluginPkg();
    expect(pkg.keywords).toContain("pi-package");
    expect(pkg.pi).toEqual({ extensions: ["./dist/src/plugin/index.js"], skills: ["./skills"] });
    expect(pkg.files).toEqual(["dist", "assets", "skills", "README.md", "LICENSE"]);
  });

  // Each command is also a skill of the same name, and each skill names its
  // command. MUTATION: delete skills/qcr-scan, or rename its `name:` — this
  // fails.
  it("ships one skill per command, named as the command, that tells the model the command", () => {
    const dir = join(PLUGIN, "skills");
    expect(readdirSync(dir).sort()).toEqual([...QUICKREVIEW_COMMANDS].sort());
    for (const name of QUICKREVIEW_COMMANDS) {
      const fm = parseSkillFrontmatter(readFileSync(join(dir, name, "SKILL.md"), "utf8"));
      expect(fm.fields.get("name")?.value, name).toBe(name);
      const description = fm.fields.get("description");
      expect(description?.resolvesTo, name).toBe("string");
      expect(description!.value.length, name).toBeGreaterThan(40);
      // pi offers it to the model: a skill hidden from it could not route
      expect(fm.fields.has("disable-model-invocation"), name).toBe(false);
      expect(fm.body, name).toContain(`/${name}`);
    }
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
    expect(pkg.peerDependencies["@earendil-works/pi-coding-agent"]).toBe("^1.4.0");
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
    expect(declaredPiRange()).toBe("^1.4.0");
    expect(piGate("1.4.0", "^1.4.0")).toBeNull();
    const msg = piGate("2.0.0", "^1.4.0")!;
    expect(msg).toMatch(/\^1\.4\.0/);
    expect(msg).toMatch(/2\.0\.0/);
  });
});

/** A pi ExtensionAPI that records what an extension registers, with pi's
 * merged settings as `settings`. */
function fakePi(settings: Record<string, unknown> = {}): {
  api: ExtensionAPI;
  commands: Map<
    string,
    { description?: string; handler: (a: string, ctx: unknown) => Promise<void> }
  >;
  tools: unknown[];
  handlers: Map<string, Array<(e: unknown, ctx: unknown) => unknown>>;
  sent: Array<{ message: Record<string, unknown>; options?: Record<string, unknown> }>;
  userMessages: string[];
  emit: (event: string) => void;
} {
  const commands = new Map();
  const tools: unknown[] = [];
  const handlers = new Map<string, Array<(e: unknown, ctx: unknown) => unknown>>();
  const sent: Array<{ message: Record<string, unknown>; options?: Record<string, unknown> }> = [];
  const userMessages: string[] = [];
  const api = {
    registerCommand: (name: string, o: unknown) => commands.set(name, o),
    registerTool: (t: unknown) => tools.push(t),
    on: (event: string, h: (e: unknown, ctx: unknown) => unknown) => {
      handlers.set(event, [...(handlers.get(event) ?? []), h]);
      return () => {};
    },
    sendMessage: (m: Record<string, unknown>, o?: Record<string, unknown>) =>
      sent.push({ message: m, ...(o ? { options: o } : {}) }),
    sendUserMessage: (t: string) => userMessages.push(t),
    getSettings: () => structuredClone(settings),
  };
  const emit = (event: string): void => {
    for (const h of handlers.get(event) ?? []) h({}, {});
  };
  return {
    api: api as unknown as ExtensionAPI,
    commands,
    tools,
    handlers,
    sent,
    userMessages,
    emit,
  };
}

const noRunner: Runner = {
  which: () => null,
  run: async () => ({ code: 127, stdout: "", stderr: "" }),
};

describe("the extension", () => {
  const config = { env: {}, home: tmp, runner: noRunner, print: () => {} };

  // Passes are leaves: the person's session gets commands, never a tool. The
  // unprefixed names are dropped, not aliased (ADR 0001). MUTATION: register
  // the lens tool here, or keep "review" beside "qcr-review" — this fails.
  it("registers exactly the three qcr- commands, and no tool, on a pi inside the range", () => {
    const pi = fakePi();
    createQuickReview({ ...config, piVersion: "1.4.0", range: "^1.4.0" })(pi.api);
    expect([...pi.commands.keys()].sort()).toEqual(["qcr-review", "qcr-scan", "qcr-setup"]);
    for (const gone of ["review", "scan", "selfimprove"]) expect(pi.commands.has(gone)).toBe(false);
    expect(pi.tools).toEqual([]);
  });

  // MUTATION: drop the gate — this fails.
  it("registers nothing on a pi outside the range, and says why once", () => {
    const pi = fakePi();
    createQuickReview({ ...config, piVersion: "1.3.0", range: "^1.4.0" })(pi.api);
    expect(pi.commands.size).toBe(0);
    expect(pi.tools).toEqual([]);
    const notes: string[] = [];
    const ctx = { ui: { notify: (m: string) => notes.push(m) } };
    for (const h of pi.handlers.get("session_start") ?? []) h({}, ctx);
    for (const h of pi.handlers.get("session_start") ?? []) h({}, ctx);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatch(/\^1\.4\.0.*1\.3\.0/);
  });
});

describe("/qcr-review's arguments", () => {
  it("split on spaces, with quotes grouping", () => {
    expect(splitArgs(' 12  --profile "my p" ')).toEqual(["12", "--profile", "my p"]);
  });

  // MUTATION: make the bare command the branch alone (drop uncommitted) —
  // this fails.
  it("bare: this branch with its uncommitted changes, as one target", () => {
    expect(parseReviewCommand("")).toEqual({
      preset: null,
      target: { kind: "branch", uncommitted: true },
      preview: false,
      json: false,
    });
    expect(parseReviewCommand("--base dev")).toMatchObject({
      target: { kind: "branch", base: "dev", uncommitted: true },
    });
  });

  it("a target: a PR as a number, #N or a URL, a branch by name, or --uncommitted", () => {
    expect(parseReviewCommand("12")).toMatchObject({ target: { kind: "pr", pr: "12" } });
    expect(parseReviewCommand("#12 --repo o/r --limit 3 --profile p --json")).toEqual({
      preset: null,
      target: { kind: "pr", pr: "#12", repo: "o/r" },
      preview: false,
      json: true,
      limitUsd: 3,
      profile: "p",
    });
    const url = "https://github.com/o/r/pull/7";
    expect(parseReviewCommand(url)).toMatchObject({ target: { kind: "pr", pr: url } });
    expect(parseReviewCommand("feature/x --base dev")).toMatchObject({
      target: { kind: "branch", head: "feature/x", base: "dev" },
    });
    expect(parseReviewCommand("feature/x")).not.toHaveProperty("target.uncommitted");
    expect(parseReviewCommand("--uncommitted --preview")).toMatchObject({
      target: { kind: "uncommitted" },
      preview: true,
    });
  });

  // Either form the usage shows: a preset alone, a target alone, or the
  // preset first and then the target. MUTATION: read the preset from any
  // position — "12 quick" stops failing.
  it("a preset is the first word when it names one, in front of any target", () => {
    expect(REVIEW_PRESET_NAMES).toEqual(["quick", "full", "security"]);
    expect(parseReviewCommand("quick")).toMatchObject({
      preset: "quick",
      target: { kind: "branch", uncommitted: true },
    });
    expect(parseReviewCommand("security 12")).toMatchObject({
      preset: "security",
      target: { kind: "pr", pr: "12" },
    });
    expect(parseReviewCommand("full --uncommitted")).toMatchObject({
      preset: "full",
      target: { kind: "uncommitted" },
    });
    // a branch that happens to be called like a preset, after one
    expect(parseReviewCommand("full quick")).toMatchObject({
      preset: "full",
      target: { kind: "branch", head: "quick" },
    });
    // the person's default preset applies when none is typed, and a typed one wins
    expect(parseReviewCommand("12", "quick")).toMatchObject({ preset: "quick" });
    expect(parseReviewCommand("security 12", "quick")).toMatchObject({ preset: "security" });
    expect(parseReviewCommand("12 quick")).toHaveProperty("error");
    expect(parseReviewCommand("--preview quick")).toHaveProperty("error");
  });

  it("refuses what is not one target, and says the usage", () => {
    for (const bad of [
      "12 13",
      "12 --uncommitted",
      "feature --uncommitted",
      "--to pr",
      "--full",
      "--branch",
      "--limit -1",
      "--repo o/r",
      "feature --repo o/r",
      "--uncommitted --base x",
      "12 --base x",
      "--wat",
      "--profile",
      "--stop 12",
    ]) {
      const r = parseReviewCommand(bad);
      expect(r, bad).toHaveProperty("error");
      expect((r as { error: string }).error, bad).toMatch(/usage: \/qcr-review/);
    }
    expect(parseReviewCommand("--stop")).toEqual({ stop: true });
  });

  it("names what is reviewed in a person's words", () => {
    const label = (l: string): string => reviewLabel(parseReviewCommand(l) as never);
    expect(label("")).toBe("this branch with its uncommitted changes");
    expect(label("quick 12")).toBe("PR #12 (quick)");
    expect(label("#12")).toBe("PR #12");
    expect(label("feature")).toBe("the branch feature");
    expect(label("--uncommitted")).toBe("the uncommitted changes");
  });
});

describe("the person's QuickReview settings (pi's settings, the quickreview key)", () => {
  it("default to asking, with no preset", () => {
    expect(readQuickReviewSettings({})).toEqual({
      settings: { posting: "ask", preset: null },
      warnings: [],
    });
    expect(readQuickReviewSettings(undefined).settings.posting).toBe("ask");
  });

  it("read the posting rule and the preset", () => {
    for (const posting of ["ask", "never", "always"] as const)
      expect(readQuickReviewSettings({ quickreview: { posting } }).settings.posting).toBe(posting);
    expect(readQuickReviewSettings({ quickreview: { preset: "security" } }).settings.preset).toBe(
      "security",
    );
  });

  // A misspelt rule must never post. MUTATION: take any string as the rule —
  // this fails.
  it("keep the default on a value they do not know, and say so", () => {
    const r = readQuickReviewSettings({ quickreview: { posting: "allways", preset: "fast" } });
    expect(r.settings).toEqual({ posting: "ask", preset: null });
    expect(r.warnings).toHaveLength(2);
    expect(r.warnings[0]).toMatch(/quickreview\.posting/);
    expect(readQuickReviewSettings({ quickreview: "always" }).settings.posting).toBe("ask");
  });
});

describe("where a result goes (the rule qcr review keeps; the session shows and saves)", () => {
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
    ).toEqual({ ok: true, refreshed: [], providers: ["openai-codex"] });
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
    ).toEqual({ ok: true, refreshed: ["openai-codex"], providers: ["openai-codex"] });
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

  // MUTATION: drop routeProvider from borrowLogin — the openai-codex review is
  // refused although an OpenAI login exists.
  it("an openai-codex review runs on whichever OpenAI login pi has, and carries only that one", async () => {
    const now = Date.now();
    for (const login of [
      { type: "api_key", expires: null },
      { type: "oauth", expires: now + 5 * 3600_000 },
    ] as const) {
      const r = await borrowLogin({
        providers: ["openai-codex", "anthropic"],
        host: fakeAuth({ openai: login, anthropic: { type: "api_key", expires: null } }),
        needMs: 3600_000,
        marginMs: 0,
      });
      expect(r).toEqual({ ok: true, refreshed: [], providers: ["openai", "anthropic"] });
    }
    // the provider the spec names wins when its login exists
    const both = await borrowLogin({
      providers: ["openai-codex"],
      host: fakeAuth({
        openai: { type: "api_key", expires: null },
        "openai-codex": { type: "oauth", expires: now + 5 * 3600_000 },
      }),
      needMs: 3600_000,
      marginMs: 0,
    });
    expect(both).toEqual({ ok: true, refreshed: [], providers: ["openai-codex"] });
  });

  // Only a key for another provider and no login fails with a hint; the review
  // never switches models across providers. MUTATION: accept any configured
  // provider — this fails.
  it("fails a provider pi has no login for, naming /login, even with a key for another", async () => {
    const keyOnly = fakeAuth({ anthropic: { type: "api_key", expires: null } });
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
    ).toEqual({ ok: true, refreshed: [], providers: ["anthropic"] });
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
    piVersion: "1.4.0",
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

describe("/qcr-review's work, waited for (runReviewCommand)", () => {
  // MUTATION: ask "Where should the review go?" again — this fails.
  it("shows the result in the session and keeps it as files, asking nothing", async () => {
    const deps = fakeReview();
    const ui = fakeUi();
    await runReviewCommand("", fakeHost(), ui, deps);
    expect(ui.asked).toEqual([]);
    expect(deps.calls[0]!.target).toEqual({ kind: "branch", uncommitted: true });
    expect(deps.calls[0]!.opts.destinations).toEqual(["terminal", "file"]);
    expect(ui.shown.join("\n")).toMatch(/# Review/);
  });

  it("runs as a host inside pi: its login, its cwd, the state home's runs, no memory", async () => {
    const host = fakeHost();
    const deps = fakeReview();
    await runReviewCommand("12 --profile generic", host, fakeUi(), deps);
    const { target, opts } = deps.calls[0]!;
    // the shipped defaults keep dry_run on, and nothing here moves it
    expect(opts.config.dry_run).toBe(true);
    expect(target).toEqual({ kind: "pr", pr: "12" });
    expect(opts.repoDir).toBe(host.cwd);
    expect(opts.agentDir).toBe(host.agentDir);
    expect(opts.runsDir).toBe(
      join(host.env["XDG_STATE_HOME"]!, "qcr", "default", "review", "runs"),
    );
    expect(opts.dryrunDir).toBe(
      join(host.env["XDG_STATE_HOME"]!, "qcr", "default", "review", "dryrun"),
    );
    expect(opts.memory).toBeNull();
    // a post is never a destination: the posting rule offers it afterwards
    expect(opts.destinations).not.toContain("pr");
    expect(opts.limits.timeoutMs).toBe(REVIEW_TIMEOUT_MS);
  });

  // A preset is the core's own options, named: never a path of its own.
  // MUTATION: drop the preset's levers from contextFrom — this fails.
  it("resolves a preset to the core's review options", async () => {
    const deps = fakeReview();
    await runReviewCommand("quick 12", fakeHost(), fakeUi(), deps);
    await runReviewCommand("full feature", fakeHost(), fakeUi(), deps);
    await runReviewCommand("security", fakeHost(), fakeUi(), deps);
    await runReviewCommand("", fakeHost(), fakeUi(), deps);
    const [quick, full, security, none] = deps.calls.map((c) => c.opts);
    expect(quick!.config.review.preset).toBe("low");
    expect(quick!.full).toBe(false);
    expect(full!.config.review.preset).toBe("max");
    expect(full!.full).toBe(true);
    expect(deps.calls[1]!.target).toEqual({ kind: "branch", head: "feature" });
    const skipped = security!.config.review.skip_lenses;
    expect(skipped.length).toBeGreaterThan(0);
    for (const kept of SECURITY_LENSES) expect(skipped).not.toContain(kept);
    expect(skipped).toContain("pass-ui");
    expect(none!.config.review.preset).toBe("default");
    expect(none!.config.review.skip_lenses).toEqual([]);
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
    const ui = fakeUi();
    const host = fakeHost({ auth: fakeAuth({ anthropic: { type: "api_key", expires: null } }) });
    await runReviewCommand("", host, ui, deps);
    expect(deps.calls).toHaveLength(0);
    expect(ui.notes.find(([l]) => l === "error")?.[1]).toMatch(
      /\/login openai-codex.*\/qcr-review again/,
    );
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

  it("says a usage error and runs nothing", async () => {
    const deps = fakeReview();
    const ui = fakeUi();
    await runReviewCommand("--to pr", fakeHost(), ui, deps);
    expect(deps.calls).toHaveLength(0);
    expect(ui.notes[0]).toEqual(["error", expect.stringMatching(/unknown flag --to/)]);
  });

  // One function builds every status line, so a later stage can enrich it.
  it("builds its status line from the stage, the plan and the time since it started", () => {
    const at = 1_000_000;
    const base = { label: "PR #12", startedAt: at };
    expect(reviewStatusLine({ ...base, stage: "preparing" }, at + 2_000)).toBe(
      "QuickReview: preparing the review of PR #12… 2s",
    );
    expect(
      reviewStatusLine(
        { ...base, stage: "running", lenses: 9, estimateUsd: 1.1, capUsd: 2.2 },
        at + 79_000,
      ),
    ).toBe("QuickReview: reviewing PR #12 — 9 lenses, about $1.10, stops at $2.20 · 1m 19s");
    expect(reviewStatusLine({ ...base, stage: "asking" }, at + 5_000)).toMatch(/post it\?/);
    // While lenses run, the first one's activity, and how many more are running.
    expect(
      reviewStatusLine(
        {
          ...base,
          stage: "running",
          lenses: 9,
          running: ["security · read src/x.ts · 7 tools · 0:41", "tests · 0:12"],
        },
        at + 79_000,
      ),
    ).toBe(
      "QuickReview: reviewing PR #12 — 9 lenses · 1m 19s · security · read src/x.ts · 7 tools · 0:41 (+1 more)",
    );
  });

  it("reads no lens lines for a run with no live log, and never throws", () => {
    expect(liveLensLines(join(tmpdir(), "qcr-no-such-run"), Date.now())).toEqual([]);
  });
});

/** A command context as pi hands one to a handler, over `ui` and `cwd`. */
function fakeCtx(
  ui: ReturnType<typeof fakeUi>,
  cwd: string,
): { ctx: unknown; statuses: Array<string | undefined> } {
  const statuses: Array<string | undefined> = [];
  const ctx = {
    mode: ui.mode,
    hasUI: ui.interactive,
    cwd,
    isIdle: () => true,
    modelRegistry: {
      getProviderAuthStatus: () => ({ configured: false }),
      getProviderAuth: async () => undefined,
    },
    ui: {
      select: (t: string, o: string[], x?: { signal?: AbortSignal }) => ui.select(t, o, x?.signal),
      confirm: (t: string, m: string, x?: { signal?: AbortSignal }) => ui.confirm(t, m, x?.signal),
      notify: (m: string, l: "info" | "warning" | "error") => ui.notify(m, l),
      setStatus: (_key: string, text: string | undefined) => statuses.push(text),
      onTerminalInput: () => () => {},
    },
  };
  return { ctx, statuses };
}

/** A review the test lets finish: its round starts (lenses, price), then it
 * waits for `finish`, or ends stopped when its signal aborts. With `offer`,
 * the finished review offers itself for posting as the core does, and the
 * answer is kept in `answers`. */
function heldReview(o: { offer?: PostOffer; posted?: string } = {}): ReviewCommandDeps & {
  calls: Array<{ target: ReviewTarget; opts: ReviewOptions; io: ReviewIo }>;
  finish: () => void;
  answers: boolean[];
} {
  const calls: Array<{ target: ReviewTarget; opts: ReviewOptions; io: ReviewIo }> = [];
  const answers: boolean[] = [];
  let finish: () => void = () => {};
  const finished = new Promise<void>((done) => (finish = done));
  return {
    ...fakeReview(),
    calls,
    answers,
    finish: () => finish(),
    review: async (target, opts, io = {}) => {
      calls.push({ target, opts, io });
      io.started?.({
        runDir: join(tmp, "held-run"),
        outDir: join(tmp, "held-run", "out"),
        sessionName: "review-x",
        lenses: ["pass-baseline", "pass-security", "pass-validate"],
        estimateUsd: 0.5,
        capUsd: 1,
      });
      const stopped = new Promise<"stopped">((done) => {
        if (io.signal?.aborted) done("stopped");
        io.signal?.addEventListener("abort", () => done("stopped"), { once: true });
      });
      if ((await Promise.race([finished, stopped])) === "stopped")
        return {
          data: { schema_version: 1, ok: false, stopped: true },
          markdown: null,
          text: "✗ the review was stopped",
          exitCode: 1 as const,
          destinations: opts.destinations ?? null,
        };
      let post: Record<string, unknown> | undefined;
      if (o.offer && io.offerPost) {
        const yes = await io.offerPost(o.offer, io.signal ? { signal: io.signal } : {});
        answers.push(yes);
        if (yes) post = { ok: true, posted: 0, url: null, dry_run: true, recorded: "/d/x.json" };
      }
      return {
        data: { schema_version: 1, ok: true, ...(post ? { post } : {}) },
        markdown: "# Review of PR #12\n\n1 finding.\n",
        text: `Review done\n${post ? (o.posted ?? "posted") : ""}`.trimEnd(),
        exitCode: 0 as const,
        destinations: opts.destinations ?? null,
      };
    },
  };
}

/** Waits for `cond` inside the test's deadline, never by a count of ticks. */
async function until(cond: () => boolean, what: string, ms = 3_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** The plugin on a fake pi, signed in through its agent dir's auth.json,
 * with `review` as its core and `settings` as pi's settings. */
function pluginOnFakePi(
  review: ReviewCommandDeps,
  settings: Record<string, unknown> = {},
): {
  pi: ReturnType<typeof fakePi>;
  host: PluginHost;
  run: (
    args: string,
    ui: ReturnType<typeof fakeUi>,
  ) => Promise<{ statuses: Array<string | undefined> }>;
} {
  const host = fakeHost();
  mkdirSync(host.agentDir, { recursive: true });
  writeFileSync(
    join(host.agentDir, "auth.json"),
    JSON.stringify({ "openai-codex": { type: "oauth", expires: Date.now() + 10 * 3600_000 } }),
  );
  const pi = fakePi(settings);
  createQuickReview({
    env: host.env,
    home: host.home,
    runner: noRunner,
    print: () => {},
    piVersion: "1.4.0",
    range: "^1.4.0",
    agentDir: host.agentDir,
    review,
  })(pi.api);
  const run = async (
    args: string,
    ui: ReturnType<typeof fakeUi>,
  ): Promise<{ statuses: Array<string | undefined> }> => {
    const { ctx, statuses } = fakeCtx(ui, host.cwd);
    await pi.commands.get("qcr-review")!.handler(args, ctx);
    return { statuses };
  };
  return { pi, host, run };
}

/** The review messages the plugin sent the session. */
const reviewMessages = (pi: ReturnType<typeof fakePi>): string[] =>
  pi.sent
    .filter((s) => s.message["customType"] === REVIEW_MESSAGE)
    .map((s) => String(s.message["content"]));

describe("/qcr-review in the background, through the extension on a fake pi", () => {
  // MUTATION: await the review in the command's handler — the handler does
  // not return before `finish`, and this fails.
  it("returns at once; the status line shows the progress, and the result arrives as the review message", async () => {
    const deps = heldReview();
    const { pi, run } = pluginOnFakePi(deps);
    const ui = fakeUi();
    const { statuses } = await run("", ui);
    // the handler is back, and the review is still running
    expect(ui.notes.at(-1)).toEqual(["info", expect.stringMatching(/in the background/)]);
    await until(() => deps.calls.length === 1, "the review to start");
    await until(
      () => statuses.some((t) => /reviewing this branch .* 3 lenses, about \$0\.50/.test(t ?? "")),
      "the round's status line",
    );
    expect(reviewMessages(pi)).toEqual([]);
    deps.finish();
    await until(() => reviewMessages(pi).length === 1, "the review message");
    expect(reviewMessages(pi)[0]).toMatch(/# Review of PR #12/);
    // shown without starting or steering a turn of the person's agent
    expect(pi.sent[0]!.options).toEqual({ triggerTurn: false });
    await until(() => statuses.at(-1) === undefined, "the status line to clear");
  });

  // MUTATION: drop the slot's check — a second review starts, and this fails.
  it("runs one review at a time, and a second start says which one is running", async () => {
    const deps = heldReview();
    const { pi, run } = pluginOnFakePi(deps);
    await run("quick 12", fakeUi());
    await until(() => deps.calls.length === 1, "the first review");
    const second = fakeUi();
    await run("--uncommitted", second);
    expect(second.notes).toEqual([
      ["warning", expect.stringMatching(/already reviewing PR #12 \(quick\)/)],
    ]);
    expect(deps.calls).toHaveLength(1);
    deps.finish();
    await until(() => reviewMessages(pi).length === 1, "the first review's message");
    await new Promise((r) => setTimeout(r, 0));
    // once it is done, the next one starts
    const third = fakeUi();
    await run("--uncommitted", third);
    await until(() => deps.calls.length === 2, "the next review");
  });

  // MUTATION: drop the session_shutdown handler — the review never stops,
  // and this fails.
  it("stops with the session's end, and with /qcr-review --stop", async () => {
    const deps = heldReview();
    const { pi, run } = pluginOnFakePi(deps);
    const ui = fakeUi();
    await run("", ui);
    await until(() => deps.calls.length === 1, "the review");
    pi.emit("session_shutdown");
    await until(() => deps.calls[0]!.io.signal?.aborted === true, "the stop");
    await until(() => ui.notes.some(([l]) => l === "error"), "the stopped result");
    expect(ui.notes.find(([l]) => l === "error")![1]).toMatch(/stopped/);

    pi.emit("session_start");
    const again = fakeUi();
    await run("12", again);
    await until(() => deps.calls.length === 2, "the second review");
    const stopper = fakeUi();
    await run("--stop", stopper);
    expect(stopper.notes).toEqual([["warning", "stopping the review of PR #12…"]]);
    await until(() => deps.calls[1]!.io.signal?.aborted === true, "the second stop");
    await until(() => again.notes.some(([l]) => l === "error"), "the second stopped result");
    await new Promise((r) => setTimeout(r, 0));
    const idle = fakeUi();
    await run("--stop", idle);
    expect(idle.notes).toEqual([["info", "no QuickReview review is running here"]]);
  });

  const offer: PostOffer = {
    repo: "o/r",
    pr: 12,
    markdown: "# Review of PR #12\n\n1 finding.\n",
    findings: 1,
    dryRun: true,
  };

  // The default rule asks, with No first, after the review is shown.
  // MUTATION: offer the Yes answer first — this fails.
  it("posting rule ask (the default): the review first, then a select with No first; No posts nothing", async () => {
    const deps = heldReview({ offer });
    const { pi, run } = pluginOnFakePi(deps);
    const ui = fakeUi({ picks: [KEEP_IT_HERE] });
    await run("12", ui);
    await until(() => deps.calls.length === 1, "the review");
    deps.finish();
    await until(() => deps.answers.length === 1, "the answer");
    expect(deps.answers).toEqual([false]);
    expect(ui.asked).toHaveLength(1);
    expect(ui.asked[0]![0]).toBe("No, keep it here");
    // a dry-run install says so in the Yes it offers
    expect(ui.asked[0]![1]).toMatch(/^Yes, post it \(dry run: the review is recorded, not sent\)$/);
    // the review was shown before the question, and once
    expect(reviewMessages(pi)).toEqual([offer.markdown]);
    await until(() => ui.notes.some(([, m]) => /stays here/.test(m)), "the kept note");
  });

  it("posting rule ask: Yes posts, and the gate's line reaches the person", async () => {
    const deps = heldReview({
      offer,
      posted:
        "Dry run (dry_run = true in this install's config): the review of 1 comment on PR #12 was recorded, not posted: /d/x.json",
    });
    const { run } = pluginOnFakePi(deps, { quickreview: { posting: "ask" } });
    const ui = fakeUi({ picks: ["Yes, post it (dry run: the review is recorded, not sent)"] });
    await run("12", ui);
    await until(() => deps.calls.length === 1, "the review");
    deps.finish();
    await until(() => ui.notes.some(([, m]) => /recorded, not posted/.test(m)), "the post line");
    expect(deps.answers).toEqual([true]);
  });

  // MUTATION: offer the post on "never" — this fails.
  it("posting rule never: no question, nothing posted", async () => {
    const deps = heldReview({ offer });
    const { pi, run } = pluginOnFakePi(deps, { quickreview: { posting: "never" } });
    const ui = fakeUi();
    await run("12", ui);
    await until(() => deps.calls.length === 1, "the review");
    expect(deps.calls[0]!.io.offerPost).toBeUndefined();
    deps.finish();
    await until(() => reviewMessages(pi).length === 1, "the review message");
    expect(ui.asked).toEqual([]);
  });

  it("posting rule always: posts without a question", async () => {
    const deps = heldReview({ offer, posted: "Posted 1 comment to PR #12 (comment-only review)" });
    const { run } = pluginOnFakePi(deps, { quickreview: { posting: "always" } });
    const ui = fakeUi();
    await run("12", ui);
    await until(() => deps.calls.length === 1, "the review");
    deps.finish();
    await until(() => deps.answers.length === 1, "the answer");
    expect(deps.answers).toEqual([true]);
    expect(ui.asked).toEqual([]);
    await until(() => ui.notes.some(([, m]) => /Posted 1 comment/.test(m)), "the post line");
  });

  it("a misspelt posting rule asks, and says why", async () => {
    const deps = heldReview({ offer });
    const { run } = pluginOnFakePi(deps, { quickreview: { posting: "yes please" } });
    const ui = fakeUi({ picks: [KEEP_IT_HERE] });
    await run("12", ui);
    expect(ui.notes[0]).toEqual(["warning", expect.stringMatching(/quickreview\.posting/)]);
    await until(() => deps.calls.length === 1, "the review");
    deps.finish();
    await until(() => deps.answers.length === 1, "the answer");
    expect(ui.asked).toHaveLength(1);
  });

  it("the person's default preset from pi's settings", async () => {
    const deps = heldReview();
    const { run } = pluginOnFakePi(deps, { quickreview: { preset: "quick" } });
    await run("12", fakeUi());
    await until(() => deps.calls.length === 1, "the review");
    expect(deps.calls[0]!.opts.config.review.preset).toBe("low");
    deps.finish();
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

describe("/qcr-scan (the qcr on PATH)", () => {
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
    expect((parseScanCommand("--wat") as { error: string }).error).toMatch(/usage: \/qcr-scan/);
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
});

describe("/qcr-setup", () => {
  const range = "^1.4.0";

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
  await runReviewCommand("", fakeHost(), ui, deps);
  expect(JSON.parse(readFileSync(join(dir, "review.json"), "utf8"))).toMatchObject({ report });
});
