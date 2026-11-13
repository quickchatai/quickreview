// The pi plugin (packages/pi-plugin), in process: its manifest and skills (as
// rendered from the one skill source, plugins/qcr/), the
// version gate, what the extension registers, /qcr-review in the background
// through the extension on a fake pi (status line, result message, one review
// at a time, stop, the posting rule), its arguments and presets, the
// destination rule, the borrowed login, /qcr-scan over the plugin's own scan
// engine with a fake case runner, and /qcr-setup's checklist (the step
// registry) over a fake runner and a fake pi. Nothing here spawns a process or
// touches the network: the faux-provider round is tests/pi-plugin-round.test.ts, the packed install
// tests/pi-plugin-install.test.ts, the real gate behind a post
// tests/review-post-cli.test.ts. git runs: each fake host's repo is a scratch
// git repo (the review store keys a repo's state by its root commit).
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
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  createQuickReview,
  hostAuth,
  QUICKREVIEW_COMMANDS,
  routeInRunningPi,
  unborrowable,
  unseenByReviewHost,
  type RunningPi,
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
  providerRows,
  routeProviders,
  type HostAuth,
} from "@quickchatai/pi-quickreview/src/plugin/login.js";
import { MEASURED } from "@quickchatai/pi-quickreview/src/measured.js";
import { DISABLED_REFRESH } from "@quickchatai/pi-quickreview/src/engine/auth.js";
import type { ReviewRuntimeOptions } from "@quickchatai/pi-quickreview/src/engine/reviewruntime.js";
import { MODEL_CHOICE_FILE, readModelChoice } from "@quickchatai/pi-quickreview/src/modelchoice.js";
import {
  refusalText,
  routeNotice,
  type ModelRoute,
  type ProviderInventory,
} from "@quickchatai/pi-quickreview/src/modelroute.js";
import { isPinned, parseCoreConfig } from "@quickchatai/pi-quickreview/src/reviewconfig.js";
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
  ReviewRouted,
  ReviewRuntime,
  ReviewTarget,
} from "@quickchatai/pi-quickreview/src/reviewapi.js";
import {
  guidedScan,
  guidedScanLine,
  parseScanCommand,
  PLUGIN_SCAN_VERBS,
  runScanCommand,
  SCAN_COMMAND_USAGE,
  scanStateHome,
  ScanSessions,
  type ScanCommandDeps,
} from "@quickchatai/pi-quickreview/src/plugin/scan.js";
import {
  AUTOMATIC,
  PLUGIN_SETUP_STEPS,
  pluginSetupRegistry,
  renderChecklist,
  runSetupChecks,
} from "@quickchatai/pi-quickreview/src/plugin/setup.js";
import { SetupChecklist, type SetupStep } from "@quickchatai/pi-quickreview/src/setupchecklist.js";
import type {
  PluginHost,
  Runner,
  RunResult,
  SessionUi,
} from "@quickchatai/pi-quickreview/src/plugin/session.js";
import {
  makeCaseAgentDir,
  pluginScanCases,
  scanWords,
  type ScanCaseRoute,
} from "@quickchatai/pi-quickreview/src/plugin/scancases.js";
import { coreExtensionFile } from "@quickchatai/pi-quickreview/src/engine/extfiles.js";
import { ROUND_EXTENSIONS } from "@quickchatai/pi-quickreview/src/engine/round.js";
import { parseSkillFrontmatter } from "./helpers/skill-frontmatter.js";
import { loadSource, render, TEMPLATE_CONTRACT } from "../plugins/qcr/render.mjs";

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
  // command. The skills/ the Plugin ships is rendered from the one skill
  // source (plugins/qcr/render.mjs) at build and pack, and gitignored, so this
  // reads the render itself: a fresh clone has no skills/ before a build.
  // MUTATION: delete plugins/qcr/templates/scan.md, or render the pi copy
  // under the namespaced names — this fails.
  it("ships one skill per command, named as the command, that tells the model the command", () => {
    const files = render(loadSource(), "pi", {
      version: pluginPkg()["version"] as string,
      contract: TEMPLATE_CONTRACT,
    });
    expect(Object.keys(files).sort()).toEqual(
      [...QUICKREVIEW_COMMANDS].map((c) => `skills/${c}/SKILL.md`).sort(),
    );
    for (const name of QUICKREVIEW_COMMANDS) {
      const fm = parseSkillFrontmatter(files[`skills/${name}/SKILL.md`]!);
      expect(fm.fields.get("name")?.value, name).toBe(name);
      const description = fm.fields.get("description");
      expect(description?.resolvesTo, name).toBe("string");
      expect(description!.value.length, name).toBeGreaterThan(40);
      // pi offers it to the model: a skill hidden from it could not route
      expect(fm.fields.has("disable-model-invocation"), name).toBe(false);
      expect(fm.body, name).toContain(`/${name}`);
    }
  });

  // The plugin installs with no qcr bin: its setup skill sends a person who
  // wants another model to the plugin's own command.
  // MUTATION: write `qcr model use` in the pi body of
  // plugins/qcr/templates/setup.md — this fails.
  it("its setup skill names /qcr-setup model as the way to choose a model, never a qcr verb", () => {
    const files = render(loadSource(), "pi", {
      version: pluginPkg()["version"] as string,
      contract: TEMPLATE_CONTRACT,
    });
    const body = parseSkillFrontmatter(files["skills/qcr-setup/SKILL.md"]!).body;
    expect(body).toContain("`/qcr-setup model`");
    expect(body).not.toMatch(/qcr model|qcr login/);
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

  // pi installs the plugin without its peers; the entry's resolve hook is
  // handed the running pi's dir at load. MUTATION: drop the peers call from
  // createQuickReview — this fails.
  it("hands the running pi's package dir to the peer hook, and only inside the range", () => {
    const seen: string[] = [];
    const peers = (dir: string) => void seen.push(dir);
    createQuickReview({ ...config, peers, piDir: "/opt/pi", piVersion: "1.4.0", range: "^1.4.0" })(
      fakePi().api,
    );
    expect(seen).toEqual(["/opt/pi"]);
    createQuickReview({ ...config, peers, piDir: "/opt/pi", piVersion: "1.3.0", range: "^1.4.0" })(
      fakePi().api,
    );
    expect(seen).toEqual(["/opt/pi"]);
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
    expect(REVIEW_PRESET_NAMES).toEqual(["quick", "full", "security", "state-machines"]);
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
      "--to nowhere",
      "quick --full",
      "12 --branch",
      "--branch --uncommitted",
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

/** A model the pick rule takes: it reasons and a review fits in its window. */
const fakeModel = (provider: string, id: string): Model<Api> =>
  ({
    id,
    name: id,
    provider,
    api: "openai-completions",
    baseUrl: "http://127.0.0.1:9/v1",
    reasoning: true,
    input: ["text"],
    cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 4_000,
  }) as Model<Api>;

/** What a fake pi holds for one provider. The provider ids are made up on
 * purpose: nothing in the plugin may know a provider by name. */
interface FakeProvider {
  /** Its model ids; default one, `m-2`. */
  models?: string[];
  /** Where pi found the credential, as its auth status names it; "none": pi
   * knows the provider and has no credential for it. Default `stored`. */
  source?: "stored" | "environment" | "runtime" | "models_json_key" | "none";
  /** pi's label for an environment source. */
  label?: string;
  /** The stored credential is an OAuth login that expires then. */
  oauth?: { expires: number };
  /** An extension of the running pi registered the provider. */
  registered?: boolean;
  /** pi's status says "not configured" although its models are available. */
  statusSaysNo?: boolean;
  /** The provider's own lookup finds its credential in a file there. */
  credentialFile?: string;
}

type FakeProviders = Record<string, FakeProvider>;

/** A running pi's model registry over `providers`, by the public methods the
 * route reads. Display names are the id with a capital. */
function fakeRegistry(providers: FakeProviders): RunningPi["modelRegistry"] {
  const modelsOf = (p: string): Model<Api>[] =>
    (providers[p]?.models ?? ["m-2"]).map((id) => fakeModel(p, id));
  const has = (p: string): boolean => providers[p] !== undefined && providers[p].source !== "none";
  return {
    getAll: () => Object.keys(providers).flatMap(modelsOf),
    getAvailable: () => Object.keys(providers).filter(has).flatMap(modelsOf),
    getProviderAuthStatus: (p) =>
      has(p) && providers[p]!.statusSaysNo !== true
        ? {
            configured: true,
            source: providers[p]!.source ?? "stored",
            ...(providers[p]!.label !== undefined ? { label: providers[p]!.label } : {}),
          }
        : { configured: false },
    getProvider: (p) =>
      providers[p] === undefined
        ? undefined
        : {
            auth: {
              ...(providers[p].oauth ? { oauth: { isSubscription: false } } : {}),
              ...(providers[p].credentialFile !== undefined
                ? {
                    apiKey: {
                      resolve: async (o: {
                        ctx: { fileExists(path: string): Promise<boolean> };
                      }): Promise<unknown> =>
                        (await o.ctx.fileExists(providers[p]!.credentialFile!))
                          ? { auth: {} }
                          : undefined,
                    },
                  }
                : {}),
            },
          },
    getProviderDisplayName: (p) => p.charAt(0).toUpperCase() + p.slice(1),
    isUsingOAuth: (m) => providers[m.provider]?.oauth !== undefined,
    find: (p, id) => modelsOf(p).find((m) => m.id === id),
    getRegisteredProviderIds: () => Object.keys(providers).filter((p) => providers[p]!.registered),
  };
}

/** Write the login file a pi with `providers` would hold: an entry for each
 * stored credential, none for a key from elsewhere. The values are not keys. */
function writeLogins(agentDir: string, providers: FakeProviders): void {
  mkdirSync(agentDir, { recursive: true });
  const held: Record<string, unknown> = {};
  for (const [p, o] of Object.entries(providers)) {
    if ((o.source ?? "stored") !== "stored") continue;
    held[p] = o.oauth
      ? { type: "oauth", access: "not-a-token", refresh: "not-a-token", expires: o.oauth.expires }
      : { type: "api_key", key: "not-a-key" };
  }
  if (Object.keys(held).length > 0)
    writeFileSync(join(agentDir, "auth.json"), JSON.stringify(held));
}

/** The host auth the extension builds over a running pi (`hostAuth`), with
 * the refresh recorded: it extends the stored login to `refreshTo` (ten hours
 * on by default), or refuses. */
function piAuth(
  registry: RunningPi["modelRegistry"],
  agentDir: string,
  o: { model?: Model<Api>; refreshTo?: number; refuse?: boolean } = {},
): HostAuth & { refreshed: Array<[string, number]> } {
  const refreshed: Array<[string, number]> = [];
  const base = hostAuth(
    { model: o.model, modelRegistry: registry } as unknown as ExtensionCommandContext,
    agentDir,
  );
  return {
    ...base,
    refreshed,
    refresh: async (provider, ms) => {
      refreshed.push([provider, ms]);
      if (o.refuse) throw new Error("token endpoint said no");
      const file = join(agentDir, "auth.json");
      const held = JSON.parse(readFileSync(file, "utf8")) as Record<string, object>;
      held[provider] = { ...held[provider], expires: o.refreshTo ?? Date.now() + 10 * 3600_000 };
      writeFileSync(file, JSON.stringify(held));
    },
  };
}

let piN = 0;
/** A pi home holding `providers`: its login file, and its host auth. */
function fakePi2(
  providers: FakeProviders,
  o: Parameters<typeof piAuth>[2] = {},
): { agentDir: string; auth: ReturnType<typeof piAuth> } {
  const agentDir = join(tmp, `pi-home-${++piN}`);
  writeLogins(agentDir, providers);
  return { agentDir, auth: piAuth(fakeRegistry(providers), agentDir, o) };
}

const HOUR = 3600_000;

/** Make `agentDir` unable to keep a model choice, whoever runs the suite:
 * the file a write goes through is a directory there. Reads still find
 * nothing remembered. */
function refuseChoiceWrites(agentDir: string): void {
  mkdirSync(join(agentDir, `${MODEL_CHOICE_FILE}.tmp`), { recursive: true });
}

// The extension's side of the route: the running pi's own registry, read
// through the functions every other route uses.
describe("the route inside a running pi", () => {
  it("is the one provider pi has a credential for, with pi's own model object", () => {
    const registry = fakeRegistry({ alpha: {}, gamma: { source: "none" } });
    const r = routeInRunningPi({ model: undefined, modelRegistry: registry });
    expect(r.result).toMatchObject({
      ok: true,
      route: { spec: "alpha/m-2", source: "only-credential", providerName: "Alpha" },
    });
    expect(r.model).toEqual(registry.find("alpha", "m-2"));
    expect(r.inventory.map((e) => e.provider)).toEqual(["alpha"]);
    expect(r.nameOf("gamma")).toBe("Gamma");
  });

  // MUTATION: drop `piProvider` from routeInRunningPi's route input — the
  // route goes by the provider id's order and this fails.
  it("goes to the provider the session is on, among several", () => {
    const registry = fakeRegistry({ alpha: {}, beta: {} });
    const r = routeInRunningPi({ model: fakeModel("beta", "m-2"), modelRegistry: registry });
    expect(r.result).toMatchObject({
      ok: true,
      route: { provider: "beta", source: "pi-provider" },
    });
    expect(routeNotice((r.result as { route: ModelRoute }).route, "plugin")).toMatch(
      /this pi session is on Beta\). Change it: \/qcr-setup model, or --model for one run/,
    );
  });

  // The run's sessions are on a nested host that loads no extension and holds
  // no key of this process.
  // MUTATION: return an empty set from unborrowable — the review resolves to
  // the extension's provider, which its own host cannot use, and this fails.
  it("leaves out a provider an extension registered and one keyed for this process, and says so", () => {
    const providers: FakeProviders = {
      ext: { registered: true },
      keyed: { source: "runtime" },
      alpha: { source: "environment", label: "ALPHA_API_KEY" },
    };
    const registry = fakeRegistry(providers);
    expect([...unborrowable(registry)].sort()).toEqual(["ext", "keyed"]);
    const r = routeInRunningPi({ model: fakeModel("ext", "m-2"), modelRegistry: registry });
    expect(r.result).toMatchObject({
      ok: true,
      route: { spec: "alpha/m-2", source: "only-credential", alternatives: [] },
    });
    const note =
      "Ext is registered by a pi extension (or keyed with --api-key): the review cannot borrow it";
    expect(r.notes).toEqual([note]);
    expect((r.result as { route: ModelRoute }).route.notices).toContain(note);
    // with nothing else, there is no route, and the note still says why
    const alone = routeInRunningPi({
      model: fakeModel("keyed", "m-2"),
      modelRegistry: fakeRegistry({ keyed: { source: "runtime" } }),
    });
    expect(alone.result).toEqual({ ok: false, refusal: { code: "no-credential" } });
    expect(alone.notes[0]).toMatch(/^Keyed is registered by a pi extension/);
  });

  // The running pi looks under the home directory for a credential; the
  // run's host does not (engine/authcontext.ts).
  // MUTATION: answer an empty set from unseenByReviewHost, or drop `unseen`
  // from routeInRunningPi's exclusions - the route names the provider the
  // session is on, which no session of the run could open; this fails.
  it("leaves out a provider whose credential is a file under the home directory, and says so", async () => {
    const here = join(tmp, "ambient-credential.json");
    writeFileSync(here, "{}");
    const providers: FakeProviders = {
      homely: { source: "environment", label: "a file", credentialFile: "~/.config/x/cred.json" },
      absolute: { source: "environment", label: "a file", credentialFile: here },
      alpha: { source: "environment", label: "ALPHA_API_KEY" },
      stored: { credentialFile: "~/.config/x/other.json" },
    };
    const registry = fakeRegistry(providers);
    const unseen = await unseenByReviewHost(registry, {});
    expect([...unseen]).toEqual(["homely"]);
    const r = routeInRunningPi(
      { model: fakeModel("homely", "m-2"), modelRegistry: registry },
      {},
      unseen,
    );
    expect(r.inventory.map((e) => e.provider).sort()).toEqual(["absolute", "alpha", "stored"]);
    expect(r.result.ok && r.result.route.provider).not.toBe("homely");
    const note =
      "Homely's credential is under your home directory, which a review host does not read: point the provider's credential variable at an absolute path (docs/llm-setup.md)";
    expect(r.notes).toEqual([note]);
    // alone, there is no route, and the note says why
    const alone = fakeRegistry({ homely: providers["homely"]! });
    const none = routeInRunningPi(
      { model: fakeModel("homely", "m-2"), modelRegistry: alone },
      {},
      await unseenByReviewHost(alone, {}),
    );
    expect(none.result).toEqual({ ok: false, refusal: { code: "no-credential" } });
    expect(none.notes).toEqual([note]);
  });

  // MUTATION: hand textResolver the registry's own getAvailable in
  // routeInRunningPi — the bare id is read as the extension's model, the pin
  // is refused for want of a credential, and this fails.
  it("reads a pin's text among the providers a run can borrow", () => {
    const registry = fakeRegistry({
      ext: { registered: true, models: ["shared-3"] },
      alpha: { models: ["shared-3", "m-2"] },
    });
    const r = routeInRunningPi(
      { model: undefined, modelRegistry: registry },
      { pin: { text: "shared-3:high", from: "flag" } },
    );
    expect(r.result).toMatchObject({
      ok: true,
      route: { spec: "alpha/shared-3", source: "flag", pick: "pinned", thinking: "high" },
    });
  });

  // Availability is the credential test, as in the route's inventory: pi's
  // status can say "not configured" of a provider whose models it lists.
  // MUTATION: skip a provider whose getProviderAuthStatus(p).configured is
  // false in registryInventory — this fails.
  it("routes on a provider pi lists as available though its status says not configured", () => {
    const { auth } = fakePi2({ alpha: { statusSaysNo: true }, gamma: { source: "none" } });
    expect(auth.route!({}).result).toMatchObject({ ok: true, route: { provider: "alpha" } });
  });
});

describe("the borrowed login", () => {
  const inventoryOf = (providers: FakeProviders): readonly ProviderInventory[] =>
    routeInRunningPi({ model: undefined, modelRegistry: fakeRegistry(providers) }).inventory;
  const listed = async (store: { list(): Promise<readonly { providerId: string }[]> }) =>
    (await store.list()).map((c) => c.providerId).sort();

  // MUTATION: return `[route.provider]` alone from routeProviders — a tier
  // pinned to another provider gets no login, and this fails.
  it("is for the route's provider and the providers the config's pinned specs run on", () => {
    const inventory = inventoryOf({ alpha: {}, beta: {} });
    const unpinned = {
      models: { model: "", tiers: { light: ":medium", deep: ":high" }, pass_models: {} },
    } as unknown as Parameters<typeof routeProviders>[1];
    expect(routeProviders({ provider: "alpha" }, unpinned, { inventory })).toEqual(["alpha"]);
    const pinned = {
      models: {
        model: "alpha/m-2",
        tiers: { light: "beta/m-2:medium", deep: ":high" },
        pass_models: { "pass-x": "gamma/m-2" },
      },
    } as unknown as Parameters<typeof routeProviders>[1];
    // gamma has no credential and nothing else serves its model: it stays
    // named, and there is simply no login to borrow for it
    expect(routeProviders({ provider: "alpha" }, pinned, { inventory })).toEqual([
      "alpha",
      "beta",
      "gamma",
    ]);
    // the shipped config pins nothing
    const shipped = parseCoreConfig(readFileSync(join(ROOT, "config.example.toml"), "utf8"));
    expect(routeProviders({ provider: "beta" }, shipped, { inventory })).toEqual(["beta"]);
  });

  // MUTATION: return `borrowed.credentials` unnarrowed from borrowLogin — the
  // run holds the other provider's login too, and this fails.
  it("leaves a long login alone, and holds the route's providers and no other", async () => {
    const now = Date.now();
    const { agentDir, auth } = fakePi2({
      alpha: { oauth: { expires: now + 5 * HOUR } },
      beta: {},
      delta: { oauth: { expires: now + 60_000 } },
    });
    const r = await borrowLogin({ agentDir, host: auth, providers: ["alpha"], needMs: HOUR });
    if (!r.ok) throw new Error("refused");
    expect(auth.refreshed).toEqual([]);
    expect(await listed(r.credentials)).toEqual(["alpha"]);
    expect(await r.credentials.read("beta")).toBeUndefined();
    // the copy cannot refresh: the token's refresh half never leaves the host
    expect((await r.credentials.read("alpha")) as { refresh?: string }).toMatchObject({
      refresh: DISABLED_REFRESH,
    });
  });

  // MUTATION: refuse a short login instead of asking the host — this fails.
  it("has the host renew a login that would not last the run, for the run's window", async () => {
    const now = Date.now();
    const { agentDir, auth } = fakePi2({ alpha: { oauth: { expires: now + 600_000 } } });
    const r = await borrowLogin({
      agentDir,
      host: auth,
      providers: ["alpha"],
      needMs: HOUR,
      marginMs: 300_000,
    });
    expect(r.ok).toBe(true);
    expect(auth.refreshed).toEqual([["alpha", 3_900_000]]);
  });

  // An owner route: this pi renews its login while the run goes, so a login
  // shorter than the run is kept even when the renewal asked for failed.
  // MUTATION: borrow with `owner: false` — the short login is left out, the
  // run is refused, and this fails.
  it("keeps a login shorter than the run that the host could not renew now", async () => {
    const now = Date.now();
    const { agentDir, auth } = fakePi2(
      { alpha: { oauth: { expires: now + 20 * 60_000 } } },
      { refuse: true },
    );
    const r = await borrowLogin({ agentDir, host: auth, providers: ["alpha"], needMs: HOUR });
    if (!r.ok) throw new Error("refused");
    expect(auth.refreshed).toHaveLength(1);
    expect(await listed(r.credentials)).toEqual(["alpha"]);
  });

  // MUTATION: answer `ok` whatever the borrow skipped — the run starts on a
  // login that has run out, and this fails.
  it("refuses a login of the route that has run out and that the host could not renew, by pi's name for it", async () => {
    const now = Date.now();
    const expires = now + 60_000;
    const { agentDir, auth } = fakePi2(
      { alpha: { oauth: { expires } }, beta: {} },
      { refuse: true },
    );
    const r = await borrowLogin({
      agentDir,
      host: auth,
      providers: ["alpha", "beta"],
      needMs: HOUR,
      nameOf: (p) => p.toUpperCase(),
    });
    expect(r).toEqual({
      ok: false,
      refusal: {
        code: "login-too-short",
        logins: [{ provider: "alpha", name: "ALPHA", expiresAt: expires }],
      },
    });
    // a login of a provider the run is not on refuses nothing
    const other = await borrowLogin({ agentDir, host: auth, providers: ["beta"], needMs: HOUR });
    expect(other.ok).toBe(true);
    expect(auth.refreshed.map(([p]) => p)).toEqual(["alpha"]);
  });

  it("borrows nothing for a provider keyed in the environment, and refuses nothing", async () => {
    const { agentDir, auth } = fakePi2({
      alpha: { source: "environment", label: "ALPHA_API_KEY" },
    });
    expect(existsSync(join(agentDir, "auth.json"))).toBe(false);
    const r = await borrowLogin({ agentDir, host: auth, providers: ["alpha"], needMs: HOUR });
    if (!r.ok) throw new Error("refused");
    expect(await listed(r.credentials)).toEqual([]);
  });

  // A host that resolved no route names no provider: the whole login, less
  // what cannot last, and what was left out is told to the run's own host.
  it("with no providers named, holds every login that lasts and names the ones left out", async () => {
    const now = Date.now();
    const expires = now + 60_000;
    const { agentDir, auth } = fakePi2(
      { alpha: {}, beta: { oauth: { expires: now + 5 * HOUR } }, delta: { oauth: { expires } } },
      { refuse: true },
    );
    const r = await borrowLogin({ agentDir, host: auth, needMs: HOUR });
    if (!r.ok) throw new Error("refused");
    expect(await listed(r.credentials)).toEqual(["alpha", "beta"]);
    expect(r.skipped).toEqual([{ provider: "delta", name: "delta", expiresAt: expires }]);
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

/** The shipped config with `[models] model` pinned to `model`, written under
 * `dir`: for the cases about a review whose config names a provider. The
 * shipped one names none. */
function pinnedConfig(dir: string, model: string): string {
  const shipped = readFileSync(join(ROOT, "config.example.toml"), "utf8");
  const pinned = shipped.replace(/^# model = "provider\/id"$/m, `model = "${model}"`);
  if (pinned === shipped) throw new Error("config.example.toml has no model line to pin");
  const file = join(dir, "qcr-config-pinned.toml");
  writeFileSync(file, pinned);
  return file;
}

/** The shipped config with its deep tier pinned to `spec`, written under
 * `dir`. The shipped one pins no tier. */
function pinnedTierConfig(dir: string, spec: string): string {
  const shipped = readFileSync(join(ROOT, "config.example.toml"), "utf8");
  const pinned = shipped.replace(/^# "deep" = "provider\/id:high"$/m, `"deep" = "${spec}"`);
  if (pinned === shipped) throw new Error("config.example.toml has no deep tier line to pin");
  const file = join(dir, "qcr-config-pinned-tier.toml");
  writeFileSync(file, pinned);
  return file;
}

let hostN = 0;
/** A plugin host over a scratch repo and a pi that holds `providers` (one
 * stored key, by default). `pi` is that pi's session model and how its
 * refresh answers. */
function fakeHost(
  o: Omit<Partial<PluginHost>, "auth"> = {},
  providers: FakeProviders = { alpha: {} },
  pi: Parameters<typeof piAuth>[2] = {},
): PluginHost & { auth: ReturnType<typeof piAuth> } {
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
  const agentDir = join(dir, "agent");
  writeLogins(agentDir, providers);
  return {
    cwd: join(dir, "repo"),
    env: {
      XDG_STATE_HOME: join(dir, "state"),
      XDG_CONFIG_HOME: join(dir, "config"),
      PATH: process.env.PATH,
    },
    home: dir,
    piVersion: "1.4.0",
    agentDir,
    auth: piAuth(fakeRegistry(providers), agentDir, pi),
    runner: noRunner,
    shutdown: new AbortController().signal,
    ...o,
  };
}

/** One recorded call of a fake review. */
interface FakeReviewCall {
  target: ReviewTarget;
  opts: ReviewOptions;
  io: ReviewIo;
  mode: string;
  /** What the host's route answered (the core asks once it has a plan). */
  routed?: ReviewRouted;
  /** What the run's runtime was built from: asked for by a start whose route
   * resolved, as the core asks. */
  runtime?: ReviewRuntimeOptions;
}

/** Review deps whose review() goes the core's way as far as the model side:
 * it asks the host for the route, refuses a start that has none in the
 * route's own words, asks for the runtime, records all of it, and returns
 * `result`. */
function fakeReview(result: Partial<ReviewResult> = {}): ReviewCommandDeps & {
  calls: FakeReviewCall[];
} {
  const calls: FakeReviewCall[] = [];
  let handed: ReviewRuntimeOptions | undefined;
  const done =
    (mode: string) =>
    async (target: ReviewTarget, opts: ReviewOptions, io: ReviewIo = {}) => {
      const call: FakeReviewCall = { target, opts, io, mode };
      calls.push(call);
      if (opts.route) call.routed = await opts.route();
      const routed = call.routed;
      if (routed && !routed.result.ok && mode === "review") {
        const why = refusalText(routed.result.refusal, routed.surface, routed.facts);
        return {
          data: { schema_version: 1, ok: false, errors: [why] },
          markdown: null,
          text: `✗ ${why}`,
          exitCode: 1 as const,
          destinations: null,
        };
      }
      if (mode === "review") {
        handed = undefined;
        opts.runtime({ runDir: join(tmp, "no-such-run") });
        if (handed !== undefined) call.runtime = handed;
      }
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
    runtime: (_cfg, o) => {
      handed = o;
      return {} as ReviewRuntime;
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
  // MUTATION: drop `|| preset?.securityRequest` from runReviewCommand — the
  // security preset's request assertion fails.
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
    // the security preset plans the whole family as a request; no other does
    expect(security!.securityRequest).toEqual({ by: "", source: "operator" });
    for (const o of [quick, full, none]) expect(o!.securityRequest).toBeUndefined();
    expect(none!.config.review.preset).toBe("default");
    expect(none!.config.review.skip_lenses).toEqual([]);
  });

  it("prints in pi's print mode, the JSON with --json, and asks nothing", async () => {
    const deps = fakeReview();
    const ui = fakeUi({ mode: "print", interactive: false });
    await runReviewCommand("", fakeHost(), ui, deps);
    expect(ui.asked).toHaveLength(0);
    // nobody to ask: the line that names the model is printed, then the review
    expect(ui.printed).toEqual([
      "model: alpha/m-2 (the provider pi has a credential for)",
      "# Review\n\nNo findings.\n",
    ]);
    const uj = fakeUi({ mode: "print", interactive: false });
    await runReviewCommand("--json", fakeHost(), uj, deps);
    expect(JSON.parse(uj.printed[0]!)).toEqual({ schema_version: 1, ok: true });
  });

  // The shipped config pins no model, so the review runs on whichever
  // provider pi has a credential for: no provider is "the wrong one". The
  // providers here have names no code could know.
  // MUTATION: restore a pinned model in MODELS_TIER_DEFAULTS or the example
  // config — the route is that pin, it has no credential here, the review is
  // refused, and this fails.
  it("runs on whatever credential pi has: a stored login or a key in the environment, of any provider", async () => {
    const homes: FakeProviders[] = [
      { beta: { oauth: { expires: Date.now() + 10 * HOUR } } },
      { delta: { source: "environment", label: "DELTA_API_KEY" } },
    ];
    for (const providers of homes) {
      const provider = Object.keys(providers)[0]!;
      const deps = fakeReview();
      const ui = fakeUi();
      const host = fakeHost({}, providers);
      await runReviewCommand("", host, ui, deps);
      expect(ui.notes.filter(([l]) => l === "error")).toEqual([]);
      const call = deps.calls[0]!;
      expect(call.mode).toBe("review");
      expect(isPinned(call.opts.config.models.model)).toBe(false);
      expect(call.routed).toMatchObject({
        surface: "plugin",
        result: { ok: true, route: { spec: `${provider}/m-2`, source: "only-credential" } },
      });
      // the person is told which model runs, once
      expect(ui.notes.filter(([, m]) => m.startsWith("model: "))).toEqual([
        ["info", `model: ${provider}/m-2 (the provider pi has a credential for)`],
      ]);
    }
  });

  // The run's own host resolves nothing: it is handed the route this pi
  // resolved, with pi's model object, and the login of that provider alone.
  // MUTATION: drop `...runHost` from the runtime's options in reviewJob — the
  // nested host gets no route and no login, and this fails.
  it("hands the run's host the route as fixed, pi's model object, and only the route's login", async () => {
    const deps = fakeReview();
    const host = fakeHost({}, { alpha: {}, beta: {} }, { model: fakeModel("beta", "m-2") });
    await runReviewCommand("", host, fakeUi(), deps);
    const handed = deps.calls[0]!.runtime!;
    expect(handed.hostPi).toBe(true);
    expect(handed.fenceDirs).toEqual([host.agentDir]);
    expect(handed.route).toMatchObject({
      fixed: { spec: "beta/m-2", source: "pi-provider" },
      model: { provider: "beta", id: "m-2" },
    });
    const store = handed.credentials as { list(): Promise<readonly { providerId: string }[]> };
    expect((await store.list()).map((c) => c.providerId)).toEqual(["beta"]);
    // the private agent dir gets no login file: the host holds it in memory
    const run = mkdtempSync(join(tmp, "prepared-"));
    writeFileSync(join(host.agentDir, "models-store.json"), "{}");
    const prepared = deps.calls[0]!.opts.prepareHost!({
      root: ROOT,
      srcAgentDir: host.agentDir,
      agentDir: join(run, "agent"),
      cwd: join(run, "out"),
      cfg: deps.calls[0]!.opts.config,
      needMs: 60_000,
      checkouts: [],
      profile: { lookup: {} },
    });
    expect(existsSync(join(prepared.agentDir, "auth.json"))).toBe(false);
    // and pi's catalog overlay rides along, so the host knows what this pi knows
    expect(existsSync(join(prepared.agentDir, "models-store.json"))).toBe(true);
  });

  // A config that pins a model names its provider, and the review runs on
  // that model or not at all.
  it("with a pinned model whose provider has no credential, refuses naming the pin and pi's /login", async () => {
    const deps = fakeReview();
    const ui = fakeUi();
    // gamma's model is served nowhere else: there is no provider to move to
    const host = fakeHost({}, { alpha: {}, gamma: { source: "none", models: ["g-9"] } });
    const config = pinnedConfig(host.home, "gamma/g-9");
    host.env["QCR_CONFIG"] = config;
    await runReviewCommand("", host, ui, deps);
    expect(deps.calls[0]!.runtime).toBeUndefined();
    const said = ui.notes.find(([l]) => l === "error")?.[1] ?? "";
    expect(said).toContain(
      `this review is pinned to gamma/g-9 ([models] model in ${config}), and pi has no credential for gamma.`,
    );
    expect(said).toMatch(
      /Sign in with \/login in pi, or drop the pin \(remove model from \[models\]\)/,
    );
    // nothing on this surface points at a qcr bin, which may not be installed
    expect(said).not.toMatch(/qcr model|qcr login/);
  });

  it("with no credential at all, refuses with pi's /login", async () => {
    const deps = fakeReview();
    const ui = fakeUi();
    await runReviewCommand("", fakeHost({}, { gamma: { source: "none" } }), ui, deps);
    expect(ui.notes.find(([l]) => l === "error")?.[1]).toBe(
      "✗ pi has no model credential. Run /login in pi, then /qcr-review again.",
    );
    expect(deps.calls[0]!.runtime).toBeUndefined();
  });

  // --model is the whole review's model for the run.
  // MUTATION: drop the stripPins call under `cmd.model` in reviewJob — the
  // pinned tier keeps its own model, and this fails.
  it("--model is the route's pin, and no tier or lens keeps a model of its own under it", async () => {
    const deps = fakeReview();
    const ui = fakeUi();
    const host = fakeHost({}, { alpha: {}, beta: { models: ["m-2", "b-3"] } });
    host.env["QCR_CONFIG"] = pinnedTierConfig(host.home, "alpha/m-2:high");
    // as the config stands, the deep tier is on its own model
    await runReviewCommand("", host, fakeUi(), deps);
    expect(deps.calls[0]!.opts.config.models.tiers.deep).toBe("alpha/m-2:high");
    await runReviewCommand("--model beta/b-3:low", host, ui, deps);
    const call = deps.calls[1]!;
    expect(call.opts.config.models.tiers.deep).toBe(":high");
    expect(call.opts.config.models.model).toBe("");
    expect(call.routed).toMatchObject({
      result: { ok: true, route: { spec: "beta/b-3", source: "flag", thinking: "low" } },
      notes: ["--model replaces 1 pinned tier and lens model for this run"],
    });
    expect(ui.notes).toContainEqual(["info", "model: beta/b-3 (pinned by --model)"]);
    // only the flag's provider is borrowed now: no spec names another
    const store = call.runtime!.credentials as {
      list(): Promise<readonly { providerId: string }[]>;
    };
    expect((await store.list()).map((c) => c.providerId)).toEqual(["beta"]);
    expect(parseReviewCommand("--model")).toMatchObject({
      error: expect.stringMatching(/--model needs a value/),
    });
    expect(parseReviewCommand("12 --model beta/b-3")).toMatchObject({ model: "beta/b-3" });
  });

  // Two providers tie and nothing was chosen: the person is asked once,
  // through pi's own select, and the answer is remembered beside pi's logins.
  // MUTATION: drop the writeModelChoice call from routeInPi — the second
  // review asks again, and this fails.
  it("asks once which provider when two tie, remembers it, and does not ask again", async () => {
    const deps = fakeReview();
    const host = fakeHost({}, { alpha: {}, beta: {} });
    const titles: string[] = [];
    const ui = fakeUi({
      select: async (title, options) => {
        titles.push(title);
        ui.asked.push(options);
        return options.find((x) => x.startsWith("beta/"));
      },
    });
    await runReviewCommand("", host, ui, deps);
    expect(titles).toEqual(["QuickReview: which provider runs the review?"]);
    // the first row is the one the order would take; each says what is
    // known of its price (the fakes' models were never measured)
    expect(ui.asked).toEqual([
      [
        "alpha/m-2    Alpha, an API key stored in pi    no estimate",
        "beta/m-2     Beta, an API key stored in pi    no estimate",
      ],
    ]);
    expect(ui.notes).toContainEqual([
      "info",
      "QuickReview will use Beta from now on. /qcr-setup model changes it.",
    ]);
    expect(readModelChoice(host.agentDir).choice).toMatchObject({
      provider: "beta",
      model: null,
      via: "ask",
    });
    expect(deps.calls[0]!.routed).toMatchObject({
      result: { ok: true, route: { spec: "beta/m-2", source: "remembered", ask: false } },
      prefer: "beta",
    });
    const again = fakeUi();
    await runReviewCommand("", host, again, deps);
    expect(again.asked).toEqual([]);
    expect(again.notes).toContainEqual([
      "info",
      "model: beta/m-2 (you picked Beta when asked; /qcr-setup model changes it)",
    ]);
  });

  // MUTATION: leave `choice` as the file read it when the write failed in
  // routeInPi — the review runs on the order's first provider, and this fails.
  it("runs on an answer the agent dir would not keep, and says why it was not kept", async () => {
    const deps = fakeReview();
    const host = fakeHost({}, { alpha: {}, beta: {} });
    refuseChoiceWrites(host.agentDir);
    const ui = fakeUi({ picks: ["beta/m-2     Beta, an API key stored in pi    no estimate"] });
    await runReviewCommand("", host, ui, deps);
    expect(ui.asked).toHaveLength(1);
    expect(ui.notes).toContainEqual([
      "warning",
      expect.stringMatching(/^cannot remember the choice in .+\. Pin it instead: /),
    ]);
    expect(ui.notes.map((n) => n[1]).join("\n")).not.toMatch(/will use Beta from now on/);
    expect(readModelChoice(host.agentDir).choice).toBeUndefined();
    expect(deps.calls[0]!.routed).toMatchObject({
      result: { ok: true, route: { spec: "beta/m-2", source: "remembered" } },
      prefer: "beta",
    });
    expect(deps.calls[0]!.runtime?.route).toMatchObject({ fixed: { spec: "beta/m-2" } });
  });

  // MUTATION: ask whenever `route.ask` is set in routeInPi, whatever the
  // caller says — a preview and a JSON run open a dialog, and this fails.
  it("never asks for a preview, for JSON, or with nobody to ask: the order decides and the line says how to change it", async () => {
    for (const [args, o] of [
      ["--preview", {}],
      ["--json", {}],
      ["", { mode: "print", interactive: false }],
    ] as const) {
      const deps = fakeReview();
      const host = fakeHost({}, { alpha: {}, beta: {} });
      const ui = fakeUi(o);
      await runReviewCommand(args, host, ui, deps);
      expect(ui.asked, args).toEqual([]);
      expect(existsSync(join(host.agentDir, MODEL_CHOICE_FILE)), args).toBe(false);
      expect(deps.calls[0]!.routed, args).toMatchObject({
        result: { ok: true, route: { spec: "alpha/m-2", ask: true } },
      });
    }
    // pi's print mode prints the line; a JSON result stays the only output
    const deps = fakeReview();
    const printed = fakeUi({ mode: "print", interactive: false });
    await runReviewCommand("", fakeHost({}, { alpha: {}, beta: {} }), printed, deps);
    expect(printed.printed[0]).toMatch(
      /^model: alpha\/m-2 \(picked among 2 providers pi has credentials for: it has the newest model\)\. Change it: \/qcr-setup model, or --model for one run$/,
    );
    const json = fakeUi({ mode: "print", interactive: false });
    await runReviewCommand("--json", fakeHost({}, { alpha: {}, beta: {} }), json, deps);
    expect(json.printed).toHaveLength(1);
    expect(JSON.parse(json.printed[0]!)).toEqual({ schema_version: 1, ok: true });
  });

  // MUTATION: skip the borrow in routeInPi (hand the route over without a
  // login) — the review starts on a login that has run out, and this fails.
  it("refuses before anything runs when pi could not renew the route's login", async () => {
    const deps = fakeReview();
    const ui = fakeUi();
    const host = fakeHost(
      {},
      { alpha: { oauth: { expires: Date.now() + 60_000 } } },
      { refuse: true },
    );
    await runReviewCommand("", host, ui, deps);
    expect(host.auth.refreshed.map(([p]) => p)).toEqual(["alpha"]);
    expect(deps.calls[0]!.runtime).toBeUndefined();
    expect(ui.notes.find(([l]) => l === "error")?.[1]).toMatch(
      /^✗ your Alpha login expires at \d\d:\d\d, inside this review's 60-minute budget, and pi did not renew it\. Sign in again with \/login/,
    );
  });

  it("a preview borrows no login and asks nothing, and still names the model", async () => {
    const deps = fakeReview({ markdown: null, text: "price: $0.61" });
    const ui = fakeUi();
    const host = fakeHost({}, { alpha: { oauth: { expires: Date.now() + 60_000 } } });
    await runReviewCommand("--preview", host, ui, deps);
    expect(deps.calls[0]!.mode).toBe("preview");
    expect(deps.calls[0]!.routed).toMatchObject({ result: { ok: true } });
    expect(host.auth.refreshed).toEqual([]);
    expect(ui.asked).toHaveLength(0);
    expect(ui.shown[0]).toMatch(/price: \$0\.61/);
  });

  // A host that hands no registry names no model before the run: the run's
  // own host resolves one from the whole borrowed login.
  it("on a host with no registry, names no route and lends the run's host the whole login to resolve one", async () => {
    const deps = fakeReview();
    const ui = fakeUi();
    const full = fakeHost({}, { alpha: {}, beta: {} });
    const { route: _none, ...auth } = full.auth;
    await runReviewCommand("", { ...full, auth }, ui, deps);
    const call = deps.calls[0]!;
    expect(call.opts.route).toBeUndefined();
    expect(call.runtime!.route).toEqual({ skipped: [] });
    const store = call.runtime!.credentials as {
      list(): Promise<readonly { providerId: string }[]>;
    };
    expect((await store.list()).map((c) => c.providerId).sort()).toEqual(["alpha", "beta"]);
  });

  it("says a usage error and runs nothing", async () => {
    const deps = fakeReview();
    const ui = fakeUi();
    await runReviewCommand("--nope pr", fakeHost(), ui, deps);
    expect(deps.calls).toHaveLength(0);
    expect(ui.notes[0]).toEqual(["error", expect.stringMatching(/unknown flag --nope/)]);
  });

  // MUTATION: drop the `priceKnowledge` column from providerRows
  // (packages/pi-plugin/src/plugin/login.ts) — the question's rows say
  // nothing of an estimate, and this fails.
  it("each row of the provider question says what is known of its price", () => {
    const credential = { kind: "oauth", origin: "stored", subscription: false } as const;
    const rows = providerRows(
      {
        provider: "alpha",
        modelId: MEASURED.model_id,
        providerName: "Alpha",
        spec: `alpha/${MEASURED.model_id}`,
        thinking: null,
        source: "credential-order",
        pick: "newest",
        piDefaultId: null,
        custom: false,
        movedFrom: null,
        credential,
        priced: true,
        ask: true,
        alternatives: [
          {
            provider: "beta",
            providerName: "Beta",
            modelId: "other-model",
            spec: "beta/other-model",
            credential,
            priced: true,
          },
          {
            provider: "gamma",
            providerName: "Gamma",
            modelId: "local-model",
            spec: "gamma/local-model",
            credential,
            priced: false,
          },
        ],
        notices: [],
      },
      [
        {
          provider: "alpha",
          name: "Alpha",
          credential,
          models: [
            {
              provider: "alpha",
              id: MEASURED.model_id,
              api: MEASURED.apis[0],
              cost: { ...MEASURED.rates },
            },
          ],
        },
        {
          provider: "beta",
          name: "Beta",
          credential,
          models: [
            { provider: "beta", id: "other-model", api: "x", cost: { input: 4, output: 20 } },
          ],
        },
      ],
    );
    expect(rows.map((r) => r.split(/\s{4,}/).at(-1))).toEqual([
      "measured estimate",
      "no estimate",
      "no list price",
    ]);
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
    // A run with no estimate says so and names its stop: never a price.
    // MUTATION: drop the `p.estimateUsd === null` arm from reviewStatusLine
    // (packages/pi-plugin/src/plugin/review.ts) — `null.toFixed` throws, and this fails.
    expect(
      reviewStatusLine(
        { ...base, stage: "running", lenses: 9, estimateUsd: null, capUsd: 15 },
        at + 79_000,
      ),
    ).toBe("QuickReview: reviewing PR #12 — 9 lenses, no estimate, stops at $15.00 · 1m 19s");
    // pi has no price for the model: no dollar figure at all
    expect(
      reviewStatusLine(
        { ...base, stage: "running", lenses: 9, estimateUsd: null, capUsd: null },
        at + 79_000,
      ),
    ).toBe("QuickReview: reviewing PR #12 — 9 lenses, no estimate, no dollar stop · 1m 19s");
    // an estimate with no cap (the Action's route) says only the estimate
    expect(
      reviewStatusLine(
        { ...base, stage: "running", lenses: 9, estimateUsd: 1.1, capUsd: null },
        at + 79_000,
      ),
    ).toBe("QuickReview: reviewing PR #12 — 9 lenses, about $1.10 · 1m 19s");
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
  providers: FakeProviders = { alpha: {} },
): { ctx: unknown; statuses: Array<string | undefined> } {
  const statuses: Array<string | undefined> = [];
  const ctx = {
    mode: ui.mode,
    hasUI: ui.interactive,
    cwd,
    isIdle: () => true,
    model: undefined,
    modelRegistry: { ...fakeRegistry(providers), getProviderAuth: async () => undefined },
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

  // MUTATION: drop the securityRequest spread from the plugin's ReviewOptions
  // (packages/pi-plugin/src/plugin/review.ts) — `--security` is parsed and
  // then ignored, and this fails.
  it("--security asks the core for the security family; without it, nothing is asked", async () => {
    const asked = heldReview();
    const { run } = pluginOnFakePi(asked);
    await run("12 --security", fakeUi());
    await until(() => asked.calls.length === 1, "the review");
    expect(asked.calls[0]!.opts.securityRequest).toEqual({ by: "", source: "operator" });
    asked.finish();
    const plain = heldReview();
    const second = pluginOnFakePi(plain);
    await second.run("12", fakeUi());
    await until(() => plain.calls.length === 1, "the review");
    expect(plain.calls[0]!.opts).not.toHaveProperty("securityRequest");
    plain.finish();
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

/** A fake host whose repo has code to scan: two top-level units and the rest. */
function scanHost(
  o: Omit<Partial<PluginHost>, "auth"> = {},
  providers?: FakeProviders,
  pi?: Parameters<typeof piAuth>[2],
): ReturnType<typeof fakeHost> & { head: string } {
  const host = fakeHost(o, providers, pi);
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
      { cwd: host.cwd, encoding: "utf8" },
    );
  mkdirSync(join(host.cwd, "app"), { recursive: true });
  mkdirSync(join(host.cwd, "lib"), { recursive: true });
  writeFileSync(join(host.cwd, "app", "a.py"), "def add(a, b):\n    return a - b\n");
  writeFileSync(join(host.cwd, "lib", "b.py"), "X = 1\n");
  writeFileSync(join(host.cwd, "main.py"), "import app\n");
  git("add", "-A");
  git("commit", "-q", "-m", "code");
  return { ...host, head: git("rev-parse", "HEAD").trim() };
}

/** The scan's seams with a fake case runner: one finding per stage-1 case,
 * the skeptic upholding nothing (NONE). `hang` holds every stage-1 case until
 * it is stopped; `hold` holds them until it resolves. `built` hears the
 * options each case runner is built with. */
function fakeScan(
  host: { head: string },
  o: {
    hang?: boolean;
    hangStage0?: boolean;
    hold?: Promise<void>;
    built?: (opts: Parameters<ScanCommandDeps["cases"]>[0]) => void;
  } = {},
): ScanCommandDeps & {
  agents: string[];
} {
  const agents: string[] = [];
  return {
    agents,
    root: () => ROOT,
    cases: (opts) => {
      o.built?.(opts);
      return {
        run: async (spec, signal) => {
          agents.push(spec.agent);
          if (spec.agent.startsWith("pass-validate"))
            return { ok: true, output: "NONE\n", cost_usd: 0.01 };
          // Stage 0's lens: a threat model, in its sections.
          if (spec.agent.startsWith("pass-sec-threat-model") && o.hangStage0)
            return new Promise((done) =>
              signal.addEventListener("abort", () => done({ ok: false, reason: "stopped" }), {
                once: true,
              }),
            );
          if (spec.agent.startsWith("pass-sec-threat-model"))
            return {
              ok: true,
              cost_usd: 0.05,
              output: `THREAT MODEL ${spec.id} @${host.head}\n\n## Entry points\n\n- \`app/**\` — the public API.\n`,
            };
          if (o.hold) await o.hold;
          if (o.hang)
            return new Promise((done) =>
              signal.addEventListener("abort", () => done({ ok: false, reason: "stopped" }), {
                once: true,
              }),
            );
          return {
            ok: true,
            cost_usd: 0.02,
            output: `FINDINGS pass-scan SCAN ${spec.id} @${host.head}\n- path: ${spec.files[0]}\n  line: 1\n  kind: bug\n  severity: P1\n  claim: it subtracts\n\nSUGGEST NONE\n`,
          };
        },
      };
    },
  };
}

/** A runner that records every program asked for. */
function recordingRunner(): Runner & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    which: (cmd) => (asked.push(cmd), null),
    run: async (cmd) => (asked.push(cmd), { code: 127, stdout: "", stderr: "" }),
  };
}

// The plugin carries the scan: no qcr CLI anywhere (ADR 0001's nesting). The
// real engine runs over a scratch repo and a temp state home; only the case
// runner, the model's side, is fake.
describe("/qcr-scan (the plugin's own engine)", () => {
  // The cases are held until the command has returned: the return comes
  // before any finding. MUTATION: make runScanCommand await the run before
  // it returns — the command is still pending when the race settles, and
  // this fails.
  it("proposes the first unit cut, prices, asks, then scans in the background and shows the new findings", async () => {
    const runner = recordingRunner();
    const host = scanHost({ runner });
    const ui = fakeUi();
    let release!: () => void;
    const deps = fakeScan(host, { hold: new Promise<void>((r) => (release = r)) });
    const sessions = new ScanSessions();
    const command = runScanCommand("", host, ui, { sessions, deps }).then(() => "returned");
    const settled = await Promise.race([
      command,
      new Promise<string>((r) => setTimeout(() => r("still waiting"), 5_000)),
    ]);
    expect(settled).toBe("returned");
    // the command returned with the run in flight, and said so, before any finding
    expect(sessions.running).not.toBeNull();
    expect(ui.notes.map((n) => n[1]).join("\n")).toMatch(/scanning .* in the background/);
    expect(ui.shown.join("\n")).not.toMatch(/new findings?:/);
    release();
    await sessions.idle();
    expect(deps.agents.some((a) => a.startsWith("pass-scan"))).toBe(true);
    expect(ui.shown.at(-1)).toMatch(/new findings?:/);
    expect(ui.shown.at(-1)).toMatch(/^3 new findings:/);
    expect(ui.shown.at(-1)).toMatch(/`app\/a\.py:1` — it subtracts/);
    // the repo's own state home, under the qcr state home
    expect(existsSync(join(scanStateHome(host), "setup", "unit-cut.json"))).toBe(true);
    // never the qcr CLI, nor any other program through the host's runner
    expect(runner.asked).toEqual([]);
  });

  // Stage 0 is part of the guided scan ([scan] threat_model): asked for and
  // run first, then the scan itself is priced and asked for over its draft.
  // MUTATION: drop the stage-0 block from priceAndStart — the stage-1 start
  // is refused while stage 0 is due, and this fails.
  it("with [scan] threat_model = auto, drafts the threat model first, then scans over the draft", async () => {
    const host = scanHost();
    const config = join(host.home, "qcr-config.toml");
    writeFileSync(
      config,
      readFileSync(join(ROOT, "config.example.toml"), "utf8").replace(
        /^threat_model = "off"/m,
        'threat_model = "auto"',
      ),
    );
    const env = { ...host.env, QCR_CONFIG: config };
    const asked: string[] = [];
    const ui = fakeUi({
      confirm: async (_title: string, message: string) => (asked.push(message), true),
    });
    const deps = fakeScan(host);
    const sessions = new ScanSessions();
    await runScanCommand("units propose", { ...host, env }, ui, { sessions, deps });
    await runScanCommand("units save", { ...host, env }, ui, { sessions, deps });
    await runScanCommand("", { ...host, env }, ui, { sessions, deps });
    await sessions.idle();
    expect(asked[0]).toMatch(/drafts its threat model \(stage 0/);
    expect(asked[1]).toMatch(/^Scan \d+ files/);
    const lens = deps.agents.findIndex((a) => a.startsWith("pass-sec-threat-model"));
    const scan = deps.agents.findIndex((a) => a.startsWith("pass-scan"));
    expect(lens).toBeGreaterThanOrEqual(0);
    expect(scan).toBeGreaterThan(lens);
    expect(
      readFileSync(join(scanStateHome(host), "scan", "threat-model.draft.md"), "utf8"),
    ).toContain("DRAFT threat model");
    // never into the repository
    expect(existsSync(join(host.cwd, ".qcr"))).toBe(false);
  });

  // A preview with stage 0 due offers the guided run after it: that line
  // keeps the scope the person priced, so the scan priced after the draft is
  // the folder, delta and commit asked for, not the whole repository.
  // MUTATION: offer a bare `/qcr-scan` in priceAndStart's stage-0 preview — this fails.
  it("a stage-0 preview of one folder offers the guided run of that folder", async () => {
    const host = scanHost();
    const config = join(host.home, "qcr-config.toml");
    writeFileSync(
      config,
      readFileSync(join(ROOT, "config.example.toml"), "utf8").replace(
        /^threat_model = "off"/m,
        'threat_model = "auto"',
      ),
    );
    const env = { ...host.env, QCR_CONFIG: config };
    const ui = fakeUi();
    const deps = fakeScan(host);
    const sessions = new ScanSessions();
    await runScanCommand("units propose", { ...host, env }, ui, { sessions, deps });
    await runScanCommand("units save", { ...host, env }, ui, { sessions, deps });
    await runScanCommand("--path lib --sha HEAD --preview", { ...host, env }, ui, {
      sessions,
      deps,
    });
    const shown = ui.shown.at(-1)!;
    expect(shown).toMatch(/drafts its threat model \(stage 0/);
    expect(shown).toMatch(/\/qcr-scan threat-model start --key \w+ --sha \w+`/);
    expect(shown).toContain("`/qcr-scan --sha HEAD --path lib`");
    expect(guidedScanLine({ delta: true, sha: "abc", path: "my dir" })).toBe(
      '/qcr-scan --delta --sha abc --path "my dir"',
    );
    expect(guidedScanLine({ delta: false })).toBe("/qcr-scan");
    expect(deps.agents).toEqual([]);
  });

  // MUTATION: drop the Esc handler from priceAndStart's stage-0 wait — the
  // drafting case never ends, the command never returns, and this fails.
  it("Esc stops a threat-model draft in flight, and nothing is scanned", async () => {
    const host = scanHost();
    const config = join(host.home, "qcr-config.toml");
    writeFileSync(
      config,
      readFileSync(join(ROOT, "config.example.toml"), "utf8").replace(
        /^threat_model = "off"/m,
        'threat_model = "auto"',
      ),
    );
    const env = { ...host.env, QCR_CONFIG: config };
    const ui = fakeUi();
    const deps = fakeScan(host, { hangStage0: true });
    const sessions = new ScanSessions();
    await runScanCommand("units propose", { ...host, env }, ui, { sessions, deps });
    await runScanCommand("units save", { ...host, env }, ui, { sessions, deps });
    const command = runScanCommand("", { ...host, env }, ui, { sessions, deps }).then(
      () => "returned",
    );
    await until(
      () => deps.agents.some((a) => a.startsWith("pass-sec-threat-model")),
      "the threat-model draft to start",
    );
    ui.escape();
    const settled = await Promise.race([
      command,
      new Promise<string>((r) => setTimeout(() => r("still drafting"), 5_000)),
    ]);
    expect(settled).toBe("returned");
    expect(ui.notes.at(-1)?.[1]).toMatch(/threat-model stage was stopped/);
    expect(deps.agents.some((a) => a.startsWith("pass-scan"))).toBe(false);
  });

  it("starts nothing on a no, and nothing with nobody to confirm the price", async () => {
    const host = scanHost();
    const deps = fakeScan(host);
    const no = fakeUi({ yes: false });
    await runScanCommand("", host, no, { sessions: new ScanSessions(), deps });
    expect(no.notes.at(-1)?.[1]).toMatch(/not started/);
    const nobody = fakeUi({ interactive: false, mode: "print" });
    await runScanCommand("", scanHost(), nobody, { sessions: new ScanSessions(), deps });
    expect(nobody.printed.join("\n")).toMatch(/unit cut|nobody here can confirm/);
    expect(deps.agents).toEqual([]);
  });

  it("answers a subcommand in the session, the unit cut first, and prices with --preview", async () => {
    const host = scanHost();
    const deps = fakeScan(host);
    const sessions = new ScanSessions();
    const ui = fakeUi();
    await runScanCommand("units propose", host, ui, { sessions, deps });
    await runScanCommand("units save", host, ui, { sessions, deps });
    await runScanCommand("preview", host, ui, { sessions, deps });
    expect(ui.shown[0]).toMatch(/^```text\n\$ \/qcr-scan units propose\n/);
    expect(ui.shown[0]).toMatch(/\/qcr-scan units save/);
    expect(ui.shown[2]).toMatch(/calibration/i);
    // the next step is named in this pi's words, never qcr's
    expect(ui.shown[2]).toMatch(/\/qcr-scan start --key/);
    expect(ui.shown.join("\n")).not.toMatch(/qcr scan /);
    await runScanCommand("--preview", host, ui, { sessions, deps });
    expect(ui.shown.at(-1)).toMatch(/Scan 3 files of .*stops hard at \$/);
    expect(deps.agents).toEqual([]);
  });

  it("takes --path: the guided run and a preview price one folder, and the usage says so", async () => {
    expect(SCAN_COMMAND_USAGE).toMatch(/\[--path DIR\]/);
    expect(parseScanCommand("--path ./lib/ --preview")).toEqual({
      kind: "guided",
      o: { delta: false, path: "lib", preview: true },
    });
    expect((parseScanCommand("--path /etc") as { error: string }).error).toMatch(
      /absolute[\s\S]*usage: \/qcr-scan/,
    );
    // the last --path wins, as qcr scan's does; `.` is the whole repo.
    // MUTATION: keep an earlier folder when a later --path is `.` — this fails.
    expect(parseScanCommand("--path app --path .")).toEqual({
      kind: "guided",
      o: { delta: false },
    });
    expect(parseScanCommand("--path . --path app")).toEqual({
      kind: "guided",
      o: { delta: false, path: "app" },
    });
    const host = scanHost();
    const deps = fakeScan(host);
    const sessions = new ScanSessions();
    const ui = fakeUi();
    await runScanCommand("units propose", host, ui, { sessions, deps });
    await runScanCommand("units save", host, ui, { sessions, deps });
    await runScanCommand("--path lib --preview", host, ui, { sessions, deps });
    expect(ui.shown.at(-1)).toMatch(/Scan 1 files of lib\/ in /);
    expect(ui.shown.at(-1)).toMatch(/\/qcr-scan start --key \w+ --sha \w+ --path lib`/);
    // the guided line it offers beside the start keeps the folder too
    expect(ui.shown.at(-1)).toMatch(/, or `\/qcr-scan --path lib`\.$/);
    await runScanCommand("preview --path lib", host, ui, { sessions, deps });
    expect(ui.shown.at(-1)).toMatch(/\/qcr-scan start --key \w+ --sha \w+ --path lib/);
    await runScanCommand("--path nope --preview", host, ui, { sessions, deps });
    expect(ui.notes.at(-1)?.[1]).toMatch(/--path nope is not a folder/);
    expect(deps.agents).toEqual([]);
  });

  // MUTATION: render a /qcr-scan line's folder with the shell's quoting
  // (scanrender.ts pathFlag: single quotes, which splitArgs keeps as part of
  // the word) or JSON's (escapes it never undoes) — this fails.
  it("writes a /qcr-scan line's folder as pi's words read it back", () => {
    for (const path of ["lib", "my dir", "app/routes/$slug", "it's", 'a"b']) {
      const guided = guidedScanLine({ delta: false, path });
      expect(splitArgs(guided), guided).toEqual(["/qcr-scan", "--path", path]);
      // ...and the command reads the line it offered back to the same folder
      expect(parseScanCommand(guided.replace(/^\/qcr-scan /, ""))).toMatchObject({ o: { path } });
      const start = PLUGIN_SCAN_VERBS.start({ key: "k", sha: "s", mode: "stage1", path });
      expect(splitArgs(start).slice(-2), start).toEqual(["--path", path]);
    }
    // a folder no pi word spells is said to be one, never sent as a broken word
    expect(guidedScanLine({ delta: false, path: 'say "hi"' })).toMatch(
      /cannot quote: run qcr scan for it/,
    );
  });

  // MUTATION: drop the folder filter from followRun's listing — the folder
  // run answers with the whole repo's earlier new findings, and this fails.
  it("a folder run answers with the new findings inside its folder only", async () => {
    const host = scanHost();
    const deps = fakeScan(host);
    const sessions = new ScanSessions();
    const ui = fakeUi();
    await runScanCommand("units propose", host, ui, { sessions, deps });
    await runScanCommand("units save", host, ui, { sessions, deps });
    const whole = await guidedScan(host, ui, { delta: false }, { sessions, deps });
    expect(whole.ok && whole.findings.map((f) => f.file).sort()).toEqual([
      "app/a.py",
      "lib/b.py",
      "main.py",
    ]);
    writeFileSync(join(host.cwd, "lib", "b.py"), "X = 2\n");
    execFileSync(
      "git",
      [
        "-c",
        "user.name=T",
        "-c",
        "user.email=t@example.com",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "-qam",
        "b",
      ],
      { cwd: host.cwd },
    );
    const lib = await guidedScan(host, ui, { delta: true, path: "lib" }, { sessions, deps });
    if (!lib.ok) throw new Error(lib.error);
    expect(lib.findings.length).toBeGreaterThan(0);
    for (const f of lib.findings) expect(f.file).toMatch(/^lib\//);
    expect(lib.total).toBe(lib.findings.length);
  });

  it("stops the run in flight with /qcr-scan stop, and its findings so far follow", async () => {
    const host = scanHost();
    const deps = fakeScan(host, { hang: true });
    const sessions = new ScanSessions();
    const ui = fakeUi();
    await runScanCommand("", host, ui, { sessions, deps });
    expect(sessions.running).not.toBeNull();
    // one scan at a time
    await runScanCommand("", host, ui, { sessions, deps });
    expect(ui.notes.at(-1)?.[1]).toMatch(/already scanning/);
    await runScanCommand("stop", host, ui, { sessions, deps });
    await sessions.idle();
    expect(ui.shown.join("\n")).toMatch(/stopped/);
    expect(ui.notes.map((n) => n[1]).join("\n")).toMatch(/the scan ended stopped/);
  });

  // MUTATION: drop onStart or watchStops from passThrough's verb deps — the
  // foreground run is not the session's (a second start is let in) or Esc
  // never stops it (the command hangs), and this fails.
  it("a foreground start is the session's run in flight, and Esc stops it", async () => {
    const host = scanHost();
    const deps = fakeScan(host, { hang: true });
    const sessions = new ScanSessions();
    const ui = fakeUi();
    await runScanCommand("units propose", host, ui, { sessions, deps });
    await runScanCommand("units save", host, ui, { sessions, deps });
    await runScanCommand("preview", host, ui, { sessions, deps });
    const key = /\/qcr-scan start --key ([A-Za-z0-9._-]+)/.exec(ui.shown.at(-1) ?? "")?.[1];
    expect(key).toBeDefined();
    const foreground = runScanCommand(`start --key ${key} --foreground`, host, ui, {
      sessions,
      deps,
    });
    while (!deps.agents.some((a) => a.startsWith("pass-scan")))
      await new Promise((r) => setTimeout(r, 10));
    expect(sessions.running).not.toBeNull();
    await runScanCommand(`start --key ${key}`, host, ui, { sessions, deps });
    expect(ui.notes.at(-1)?.[1]).toMatch(/already scanning/);
    ui.escape();
    await foreground;
    await sessions.idle();
    expect(sessions.running).toBeNull();
    expect(ui.shown.at(-1)).toMatch(/STOPPED/);
  });

  // A scan has one model: the route this pi resolved when the run started.
  // MUTATION: leave `engine.caseRoute` unset in scanRouteOn — the cases get
  // no route, each case's host resolves its own, and this fails.
  it("plans on the route, records it on the run, and hands every case's host that one route", async () => {
    const host = scanHost({}, { alpha: {}, gamma: { source: "none" } });
    const seen: { route?: () => ScanCaseRoute | undefined } = {};
    const deps = fakeScan(host, { built: (o) => (seen.route = o.route) });
    const sessions = new ScanSessions();
    const preview = fakeUi();
    await runScanCommand("--preview", host, preview, { sessions, deps });
    // the plan names the model, in the plugin's words
    expect(preview.shown.at(-1)).toContain(
      "model: alpha/m-2 (the provider pi has a credential for)",
    );
    // a plan starts nothing, so no case has a route yet
    expect(seen.route?.()).toBeUndefined();
    await runScanCommand("", host, fakeUi(), { sessions, deps });
    await sessions.idle();
    const on = seen.route?.();
    expect(on).toMatchObject({
      route: { fixed: { spec: "alpha/m-2" }, model: { provider: "alpha", id: "m-2" } },
      providers: ["alpha"],
    });
    expect(sessions.engine(host, deps).scan.status().run?.settings.model).toBe("alpha/m-2");
  });

  // --model is the whole scan's model, and a plan made under it is started
  // under it.
  // MUTATION: drop `slashModelFlag(o.model)` from guidedScanLine — the line a
  // preview offers starts the scan on another model, and this fails.
  it("--model names the scan's model for one run, and every start line repeats it", async () => {
    const host = scanHost({}, { alpha: {}, beta: { models: ["m-2", "b-3"] } });
    host.env["QCR_CONFIG"] = pinnedTierConfig(host.home, "alpha/m-2:high");
    const deps = fakeScan(host);
    const sessions = new ScanSessions();
    const ui = fakeUi();
    await runScanCommand("--preview --model beta/b-3", host, ui, { sessions, deps });
    const shown = ui.shown.at(-1)!;
    expect(shown).toContain("model: beta/b-3 (pinned by --model)");
    expect(shown).toContain("--model replaces 1 pinned tier and lens model for this run");
    expect(shown).toMatch(/Start it with `\/qcr-scan start --key \S+ --sha \S+ --model beta\/b-3`/);
    expect(shown).toContain("or `/qcr-scan --model beta/b-3`.");
    expect(parseScanCommand("--model beta/b-3 --delta")).toEqual({
      kind: "guided",
      o: { delta: true, model: "beta/b-3" },
    });
    expect(guidedScanLine({ delta: true, model: "beta/b-3" })).toBe(
      "/qcr-scan --delta --model beta/b-3",
    );
    expect(SCAN_COMMAND_USAGE).toMatch(/\[--model M\]/);
    // the run it starts is on that model
    await runScanCommand("--model beta/b-3", host, fakeUi(), { sessions, deps });
    await sessions.idle();
    expect(sessions.engine(host, deps).scan.status().run?.settings.model).toBe("beta/b-3");
    // and a verb takes it too, where the host resolves a model
    const verb = fakeUi();
    await runScanCommand("preview --model beta/b-3", host, verb, { sessions, deps });
    expect(verb.shown.at(-1)).toContain("model: beta/b-3 (pinned by --model)");
  });

  // MUTATION: pass the plan no model in priceAndStart (drop `...planned`) —
  // a scan with no credential is priced and offered, and this fails.
  it("with no model credential, says pi's /login and starts nothing", async () => {
    const host = scanHost({}, { gamma: { source: "none" } });
    const deps = fakeScan(host);
    const sessions = new ScanSessions();
    const ui = fakeUi();
    await runScanCommand("", host, ui, { sessions, deps });
    expect(sessions.running).toBeNull();
    expect(deps.agents).toEqual([]);
    expect(ui.notes.at(-1)).toEqual([
      "error",
      "the scan cannot start: pi has no model credential. Run /login in pi, then /qcr-scan again.",
    ]);
  });

  // The login is checked again where it is spent: before a start, for the
  // route's provider alone.
  // MUTATION: resolve a start's route with `run: false` in priceAndStart —
  // the scan starts on a login that has run out, and this fails.
  it("refuses a start when pi could not renew the route's login, in a scan's words", async () => {
    const host = scanHost(
      {},
      { alpha: { oauth: { expires: Date.now() + 60_000 } } },
      { refuse: true },
    );
    const deps = fakeScan(host);
    const sessions = new ScanSessions();
    const ui = fakeUi();
    await runScanCommand("", host, ui, { sessions, deps });
    expect(sessions.running).toBeNull();
    expect(deps.agents).toEqual([]);
    expect(ui.notes.at(-1)?.[1]).toMatch(
      /your Alpha login expires at \d\d:\d\d, inside this scan's 30-minute budget, and pi did not renew it/,
    );
  });

  // The borrow never takes a login file it cannot read for an empty one: it
  // throws, and the guided start is where that surfaces.
  // MUTATION: drop the catch from priceAndStart — the command rejects with
  // nobody told, and this fails.
  it("a login file that cannot be read refuses the guided start, said to the person, and nothing runs", async () => {
    const host = scanHost();
    writeFileSync(join(host.agentDir, "auth.json"), "not the object pi writes");
    const deps = fakeScan(host);
    const sessions = new ScanSessions();
    const ui = fakeUi();
    await expect(runScanCommand("", host, ui, { sessions, deps })).resolves.toBeUndefined();
    expect(sessions.running).toBeNull();
    expect(deps.agents).toEqual([]);
    expect(ui.notes.at(-1)?.[0]).toBe("error");
    expect(ui.notes.at(-1)?.[1]).toMatch(/^could not read pi's credentials at .+auth\.json: /);
    const waited = await guidedScan(host, fakeUi(), { delta: false }, { sessions, deps });
    expect(waited).toEqual({
      ok: false,
      error: expect.stringMatching(/^could not read pi's credentials at /),
    });
  });

  // A plan and its start are one run: the answer to the plan's question
  // holds for the start even where it could not be written, or the start is
  // routed on another provider and its key is no longer the plan's.
  // MUTATION: drop `held` from the routeInPi call in scanRouteOn — the start
  // resolves on the order's first provider, the runner refuses the key as
  // changed, and this fails.
  it("starts on the provider picked for the plan when pi's agent dir would not keep the answer", async () => {
    const beta = "beta/m-2     Beta, an API key stored in pi    no estimate";
    const host = scanHost({}, { alpha: {}, beta: {} });
    refuseChoiceWrites(host.agentDir);
    const seen: { route?: () => ScanCaseRoute | undefined } = {};
    const deps = fakeScan(host, { built: (o) => (seen.route = o.route) });
    const sessions = new ScanSessions();
    const ui = fakeUi({ picks: [beta] });
    await runScanCommand("", host, ui, { sessions, deps });
    await sessions.idle();
    // asked once, for the plan; the start asked nothing
    expect(ui.asked).toHaveLength(1);
    expect(ui.notes).toContainEqual([
      "warning",
      expect.stringMatching(/^cannot remember the choice in /),
    ]);
    expect(readModelChoice(host.agentDir).choice).toBeUndefined();
    expect(ui.notes.filter((n) => n[0] === "error")).toEqual([]);
    expect(seen.route?.()).toMatchObject({
      route: { fixed: { spec: "beta/m-2" } },
      providers: ["beta"],
    });
    expect(sessions.engine(host, deps).scan.status().run?.settings.model).toBe("beta/m-2");
  });

  // The same holds across two commands: `preview`, then the start it names.
  // (The mutation above fails this one too.)
  it("a verb's start is on the provider picked for its preview, and the next plan asks again", async () => {
    const beta = "beta/m-2     Beta, an API key stored in pi    no estimate";
    const host = scanHost({}, { alpha: {}, beta: {} });
    refuseChoiceWrites(host.agentDir);
    const deps = fakeScan(host);
    const sessions = new ScanSessions();
    const ui = fakeUi({ picks: [beta] });
    await runScanCommand("units propose", host, ui, { sessions, deps });
    await runScanCommand("units save", host, ui, { sessions, deps });
    await runScanCommand("preview", host, ui, { sessions, deps });
    expect(ui.asked).toHaveLength(1);
    expect(ui.shown.at(-1)).toContain("model: beta/m-2");
    const start = /\/qcr-scan (start --key \S+ --sha \S+)/.exec(ui.shown.at(-1)!)?.[1];
    expect(start).toBeDefined();
    await runScanCommand(start!, host, ui, { sessions, deps });
    await sessions.idle();
    expect(ui.asked).toHaveLength(1);
    expect(ui.shown.join("\n")).not.toMatch(/the plan changed since that preview/);
    expect(sessions.engine(host, deps).scan.status().run?.settings.model).toBe("beta/m-2");
    // nothing was kept, so the next plan made for a person asks again
    await runScanCommand("--preview", host, ui, { sessions, deps });
    expect(ui.asked).toHaveLength(2);
  });

  it("says a review's refusal of a scan", () => {
    expect(scanWords("pi has no model credential. Run /login in pi, then /qcr-review again.")).toBe(
      "pi has no model credential. Run /login in pi, then /qcr-scan again.",
    );
    expect(scanWords("inside this review's 30-minute budget")).toBe(
      "inside this scan's 30-minute budget",
    );
  });

  // The real case runner, as far as the login: a case borrows the route's
  // login again, and one this pi could not renew stops the run with the fix.
  // MUTATION: borrow the whole login in pluginScanCases (drop `providers`) —
  // the case goes on without the route's login, and this fails.
  it("a case whose route's login ran out stops the run, naming pi's /login, before any host is built", async () => {
    const host = fakeHost(
      {},
      { alpha: { oauth: { expires: Date.now() + 60_000 } } },
      { refuse: true },
    );
    const home = mkdtempSync(join(tmp, "scan-home-"));
    const agentsDir = join(home, "agents");
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(
      join(agentsDir, "pass-scan.md"),
      "---\nname: pass-scan\ndescription: reads\ntools: read\n---\n\nRead the files.\n",
    );
    const stopped: string[] = [];
    const routed = host.auth.route!({});
    if (!routed.result.ok) throw new Error("no route");
    const cases = pluginScanCases({
      host: () => host,
      root: ROOT,
      home,
      route: () => ({
        route: { fixed: (routed.result as { route: ModelRoute }).route },
        providers: ["alpha"],
        nameOf: routed.nameOf,
      }),
      agentsDir,
      transcriptDir: join(home, "transcripts"),
      stop: (reason) => stopped.push(reason),
    });
    const outcome = await cases.run(
      { id: "c1", unit: "u", agent: "pass-scan", files: ["a.py"], prompt: "read" },
      new AbortController().signal,
    );
    expect(outcome.ok).toBe(false);
    expect(stopped).toHaveLength(1);
    expect(stopped[0]).toMatch(
      /^your Alpha login expires at \d\d:\d\d, inside this scan's 30-minute budget, and pi did not renew it\. Sign in again with \/login/,
    );
    // no private agent dir was made for the case
    expect(existsSync(join(home, "scan", "plugin-agent"))).toBe(false);
  });

  // One catalog: the case's host must know the models the running pi
  // resolved the route over, the ones pi learned since its build included.
  // MUTATION: copy models.json alone in makeCaseAgentDir — a route on a model
  // from pi's stored overlay is unknown to the case's host, and this fails.
  it("a case's private agent dir gets pi's two catalog files and no login", () => {
    const host = fakeHost();
    writeFileSync(join(host.agentDir, "models.json"), '{"providers":{}}');
    writeFileSync(join(host.agentDir, "models-store.json"), "{}");
    expect(existsSync(join(host.agentDir, "auth.json"))).toBe(true);
    const home = mkdtempSync(join(tmp, "scan-home-"));
    const dir = makeCaseAgentDir(host.agentDir, home);
    expect(dir.startsWith(join(home, "scan", "plugin-agent"))).toBe(true);
    expect(readdirSync(dir).sort()).toEqual(["models-store.json", "models.json"]);
  });

  it("leaves the app's sandbox and triage to the app", async () => {
    const host = scanHost();
    const deps = fakeScan(host);
    for (const sub of ["doctor", "login", "rebuild", "dismiss abc --reason x"]) {
      const ui = fakeUi();
      await runScanCommand(sub, host, ui, { sessions: new ScanSessions(), deps });
      expect(ui.notes.at(-1)?.[1], sub).toMatch(/app/);
    }
    expect((parseScanCommand("--sandbox docker") as { error: string }).error).toMatch(
      /sandbox is the app's/,
    );
    expect((parseScanCommand("--wat") as { error: string }).error).toMatch(/usage: \/qcr-scan/);
  });
});

describe("/qcr-setup", () => {
  const range = "^1.4.0";
  const ghOk = { "gh auth status": { code: 0, stdout: "", stderr: "" } };

  /** The plugin on a fake pi over `runner`, signed in through its agent dir,
   * with /qcr-setup run as the person types it. */
  function setupOnFakePi(
    runner: Runner,
    providers: FakeProviders = { alpha: {} },
  ): {
    pi: ReturnType<typeof fakePi>;
    host: PluginHost;
    run: (args: string, ui: ReturnType<typeof fakeUi>) => Promise<void>;
  } {
    const host = fakeHost({ runner }, providers);
    const pi = fakePi();
    createQuickReview({
      env: host.env,
      home: host.home,
      runner,
      print: () => {},
      piVersion: "1.4.0",
      range,
      agentDir: host.agentDir,
    })(pi.api);
    const run = async (args: string, ui: ReturnType<typeof fakeUi>): Promise<void> => {
      const { ctx } = fakeCtx(ui, host.cwd, providers);
      await pi.commands.get("qcr-setup")!.handler(args, ctx);
    };
    return { pi, host, run };
  }

  it("detects pi, the login, the review's model, git, GitHub and the repo profile, each with what it found", async () => {
    const lines = await runSetupChecks({
      host: fakeHost({ runner: scriptedRunner(ghOk) }),
      range,
      root: () => ROOT,
    });
    expect(lines.map((l) => [l.id, l.title, l.status])).toEqual([
      [PLUGIN_SETUP_STEPS.pi, "pi version", "done"],
      [PLUGIN_SETUP_STEPS.login, "login", "done"],
      [PLUGIN_SETUP_STEPS.model, "review model", "done"],
      [PLUGIN_SETUP_STEPS.git, "git", "done"],
      [PLUGIN_SETUP_STEPS.github, "GitHub", "done"],
      [PLUGIN_SETUP_STEPS.profile, "repo profile", "pending"],
    ]);
    expect(lines.find((l) => l.id === PLUGIN_SETUP_STEPS.model)!.found).toBe(
      "alpha/m-2 (the one provider pi has a usable credential for)",
    );
    expect(lines.find((l) => l.id === PLUGIN_SETUP_STEPS.pi)!.found).toBe(
      "pi 1.4.0, inside ^1.4.0",
    );
    expect(lines.find((l) => l.id === PLUGIN_SETUP_STEPS.git)!.found).toBe("/bin/git");
    expect(lines.find((l) => l.id === PLUGIN_SETUP_STEPS.profile)!.note).toMatch(
      /\/qcr-setup profile/,
    );
  });

  // The shipped config pins no model: a credential for any provider is one a
  // review can run on, wherever pi found it.
  // MUTATION: read the login step off the stored logins (`host.auth.logins()`)
  // instead of the route — the key in the environment reads missing, and this
  // fails.
  it("with no model pinned, a credential for any provider is the login, and none is missing", async () => {
    const homes: Array<[FakeProviders, string]> = [
      [{ beta: {} }, "Beta, an API key stored in pi: a review runs on beta/m-2"],
      [
        { delta: { oauth: { expires: Date.now() + 10 * HOUR } } },
        "Delta, signed in with pi: a review runs on delta/m-2",
      ],
      [
        { zeta: { source: "environment", label: "ZETA_API_KEY" } },
        "Zeta, ZETA_API_KEY: a review runs on zeta/m-2",
      ],
    ];
    for (const [providers, found] of homes) {
      const host = fakeHost({ runner: scriptedRunner({}) }, providers);
      const lines = await runSetupChecks({ host, range, root: () => ROOT });
      const login = lines.find((l) => l.id === PLUGIN_SETUP_STEPS.login)!;
      expect(login.status).toBe("done");
      expect(login.found).toBe(found);
    }
    const none = fakeHost({ runner: scriptedRunner({}) }, { gamma: { source: "none" } });
    const lines = await runSetupChecks({ host: none, range, root: () => ROOT });
    const login = lines.find((l) => l.id === PLUGIN_SETUP_STEPS.login)!;
    expect(login.status).toBe("pending");
    expect(login.note).toBe(
      "pi has no model credential. Run /login in pi, then /qcr-review again.",
    );
    // the model step has nothing to show, and is not a second failure
    const model = lines.find((l) => l.id === PLUGIN_SETUP_STEPS.model)!;
    expect(model.status).toBe("pending");
    expect(renderChecklist(lines)).toMatch(/✗ \*\*login\*\*/);
    expect(renderChecklist(lines)).toMatch(/! \*\*review model\*\*/);
    expect(renderChecklist(lines)).toMatch(/1 check failed\./);
  });

  it("with a pinned model, leaves the login missing when pi has no credential for its provider", async () => {
    const host = fakeHost(
      { runner: scriptedRunner({}) },
      { alpha: {}, gamma: { source: "none", models: ["g-9"] } },
    );
    const config = pinnedConfig(host.home, "gamma/g-9");
    host.env["QCR_CONFIG"] = config;
    const lines = await runSetupChecks({ host, range, root: () => ROOT });
    const login = lines.find((l) => l.id === PLUGIN_SETUP_STEPS.login)!;
    expect(login.status).toBe("pending");
    expect(login.note).toContain(
      `this review is pinned to gamma/g-9 ([models] model in ${config}), and pi has no credential for gamma.`,
    );
    expect(renderChecklist(lines)).toMatch(/✗ \*\*login\*\*/);
    expect(renderChecklist(lines)).toMatch(/1 check failed\./);
  });

  // The checklist reads the credential the way a review resolves its route:
  // a pin on a provider with no credential runs where the same model is
  // served under a credential, when that is no guess.
  // MUTATION: test `inventory.some((e) => e.provider === <the pin's provider>)`
  // in the login step instead of resolving the route — the moved pin reads
  // missing, and this fails.
  it("counts the provider a pinned model moves to as the login a pinned review runs on", async () => {
    const host = fakeHost(
      { runner: scriptedRunner({}) },
      { gamma: { source: "none", models: ["shared-3"] }, "gamma-two": { models: ["shared-3"] } },
    );
    host.env["QCR_CONFIG"] = pinnedConfig(host.home, "gamma/shared-3");
    const lines = await runSetupChecks({ host, range, root: () => ROOT });
    const step = lines.find((l) => l.id === PLUGIN_SETUP_STEPS.login)!;
    expect(step.status).toBe("done");
    expect(step.found).toBe(
      "Gamma-two, an API key stored in pi: a review runs on gamma-two/shared-3",
    );
    expect(lines.find((l) => l.id === PLUGIN_SETUP_STEPS.model)!.found).toMatch(
      /^gamma-two\/shared-3 \(pinned by \[models\] model in .*; it runs on Gamma-two, since pi has no credential for gamma\)$/,
    );
  });

  // /qcr-setup model: the one way to change the remembered choice where no
  // qcr bin is installed.
  // MUTATION: write `via: "ask"` from modelSetup — a stated choice would be a
  // preference the order may override, and this fails.
  it("`model` picks the provider through pi's select, remembers it as a stated choice, and says the new route", async () => {
    const providers: FakeProviders = { alpha: {}, beta: {} };
    const { host, run } = setupOnFakePi(scriptedRunner(ghOk), providers);
    const titles: string[] = [];
    const ui = fakeUi({
      select: async (title, options) => {
        titles.push(title);
        ui.asked.push(options);
        return options.find((x) => x.startsWith("beta/"));
      },
    });
    await run("model", ui);
    expect(titles).toEqual(["QuickReview: which provider do reviews run on?"]);
    expect(ui.asked).toEqual([
      [
        "alpha/m-2    Alpha, an API key stored in pi",
        "beta/m-2     Beta, an API key stored in pi",
        AUTOMATIC,
      ],
    ]);
    expect(readModelChoice(host.agentDir).choice).toMatchObject({
      provider: "beta",
      model: null,
      via: "use",
    });
    expect(ui.notes.at(-1)).toEqual([
      "info",
      "QuickReview will use Beta from now on.\nmodel: beta/m-2 (your choice; /qcr-setup model changes it)",
    ]);
    // automatic forgets the choice, and the rule picks again
    const back = fakeUi({ picks: [AUTOMATIC] });
    await run("model", back);
    expect(existsSync(join(host.agentDir, MODEL_CHOICE_FILE))).toBe(false);
    expect(back.notes.at(-1)?.[1]).toMatch(
      /^QuickReview picks the model again\.\nmodel: alpha\/m-2 \(picked among 2 providers/,
    );
    // dismissed: nothing changes and nothing is said
    const dismissed = fakeUi();
    await run("model", dismissed);
    expect(dismissed.notes).toEqual([]);
    expect(existsSync(join(host.agentDir, MODEL_CHOICE_FILE))).toBe(false);
  });

  it("`model` with nobody to ask says the route and how to name a model, and changes nothing", async () => {
    const { pi, host, run } = setupOnFakePi(scriptedRunner(ghOk), { alpha: {}, beta: {} });
    const ui = fakeUi({ interactive: false, mode: "rpc" });
    await run("model", ui);
    expect(ui.asked).toEqual([]);
    expect(existsSync(join(host.agentDir, MODEL_CHOICE_FILE))).toBe(false);
    const said = reviewMessages(pi).at(-1)!;
    expect(said).toMatch(/^model: alpha\/m-2 \(picked among 2 providers/);
    expect(said).toContain("--model <provider>/<id>");
    // with no credential there is nothing to choose among: the refusal says the fix
    const none = setupOnFakePi(scriptedRunner(ghOk), { gamma: { source: "none" } });
    await none.run("model", fakeUi());
    expect(reviewMessages(none.pi).at(-1)).toBe(
      "model: none\npi has no model credential. Run /login in pi, then /qcr-review again.",
    );
  });

  // The checklist's optional step: pending only while two providers tie and
  // nothing was chosen, and then the bare command offers the pick.
  // MUTATION: return `found` for a route whose `ask` is set in the model
  // step — the pick is never offered, and this fails.
  it("offers the provider pick after the list while two providers tie, before the profile offer", async () => {
    const { pi, host, run } = setupOnFakePi(scriptedRunner(ghOk), { alpha: {}, beta: {} });
    const ui = fakeUi({ picks: ["beta/m-2     Beta, an API key stored in pi", "No, not now"] });
    await run("", ui);
    expect(reviewMessages(pi)[0]).toContain(
      "- ! **review model** — alpha/m-2 (the newest model among 2 providers). pi has credentials for 2 providers: `/qcr-setup model` picks the one reviews run on",
    );
    expect(reviewMessages(pi)[0]).toMatch(/Ready\./);
    expect(ui.asked.map((o) => o.at(-1))).toEqual([AUTOMATIC, "Yes, set up this repo's profile"]);
    expect(readModelChoice(host.agentDir).choice).toMatchObject({ provider: "beta", via: "use" });
    // chosen: the step is done, and only the profile is offered
    const again = fakeUi({ picks: ["No, not now"] });
    await run("", again);
    expect(reviewMessages(pi).at(-1)).toContain(
      "- ✓ **review model** — beta/m-2 (you chose it (/qcr-setup model))",
    );
    expect(again.asked).toEqual([["No, not now", "Yes, set up this repo's profile"]]);
  });

  it("reads a GitHub token's presence only", async () => {
    const host = fakeHost({ runner: scriptedRunner({}) });
    host.env["GITHUB_TOKEN"] = "secret-value";
    const lines = await runSetupChecks({ host, range, root: () => ROOT });
    const gh = lines.find((l) => l.id === PLUGIN_SETUP_STEPS.github)!;
    expect(gh.found).toMatch(/GITHUB_TOKEN is set/);
    expect(JSON.stringify(lines)).not.toContain("secret-value");
  });

  it("finds this repo's .qcr/profile.toml at the repo's top level", async () => {
    const host = fakeHost();
    mkdirSync(join(host.cwd, ".qcr"), { recursive: true });
    writeFileSync(join(host.cwd, ".qcr", "profile.toml"), 'ecosystem = "none"\n');
    const sub = join(host.cwd, "src");
    mkdirSync(sub, { recursive: true });
    const runner = scriptedRunner({
      "git rev-parse": { code: 0, stdout: `${host.cwd}\n`, stderr: "" },
    });
    const lines = await runSetupChecks({
      host: { ...host, cwd: sub, runner },
      range,
      root: () => ROOT,
    });
    const profile = lines.find((l) => l.id === PLUGIN_SETUP_STEPS.profile)!;
    expect(profile.status).toBe("done");
    expect(profile.found).toMatch(/\.qcr\/profile\.toml in this repo/);
  });

  // The plugin does only what the plugin can do (ADR 0001): its setup never
  // offers to install the app, asked or not. MUTATION: put the qcr check and
  // its `npm i -g` offer back into /qcr-setup — this fails.
  it("shows the checklist through the extension and never offers to install the app", async () => {
    const runner = scriptedRunner(ghOk, ["git", "gh", "npm"]);
    const { pi, run } = setupOnFakePi(runner);
    const ui = fakeUi({ picks: ["No, not now"], yes: true });
    await run("", ui);
    const shown = reviewMessages(pi);
    expect(shown).toHaveLength(1);
    expect(shown[0]).toMatch(/^QuickReview setup/);
    for (const title of ["pi version", "login", "review model", "git", "GitHub"])
      expect(shown[0]).toContain(`- ✓ **${title}**`);
    expect(shown[0]).toContain("- ! **repo profile**");
    expect(shown[0]).toMatch(/Ready\./);
    const said = [...shown, ...ui.asked.flat(), ...ui.notes.map((n) => n[1])].join("\n");
    expect(said).not.toMatch(/npm i|install/i);
    expect(said).not.toContain("@quickchatai/quickreview");
    expect(runner.calls.some((c) => c[0] === "/bin/npm")).toBe(false);
  });

  // Setup is offered, never started: the offer's first answer is No.
  // MUTATION: offer Yes first, or hand the agent the brief without asking —
  // this fails.
  it("offers this repo's profile Setup, No first, and hands the agent the brief only on yes", async () => {
    const no = setupOnFakePi(scriptedRunner(ghOk));
    const noUi = fakeUi({ picks: ["No, not now"] });
    await no.run("", noUi);
    expect(noUi.asked).toEqual([["No, not now", "Yes, set up this repo's profile"]]);
    expect(no.pi.userMessages).toEqual([]);

    const yes = setupOnFakePi(scriptedRunner(ghOk));
    await yes.run("", fakeUi({ picks: ["Yes, set up this repo's profile"] }));
    expect(yes.pi.userMessages).toHaveLength(1);
    const brief = yes.pi.userMessages[0]!;
    expect(brief).toContain(yes.host.cwd);
    expect(brief).toMatch(/\.qcr\/profile\.toml/);
    expect(brief).toMatch(
      /goals, what must block a merge, its risk areas, and its style and tests/,
    );
    expect(brief).toContain(join(ROOT, "agents"));
    expect(reviewMessages(yes.pi).at(-1)).toMatch(/Setup is with your agent/);
  });

  it("runs Setup straight away on `profile`, and asks nothing with a profile in place", async () => {
    const direct = setupOnFakePi(scriptedRunner(ghOk));
    const ui = fakeUi();
    await direct.run("profile", ui);
    expect(ui.asked).toEqual([]);
    expect(direct.pi.userMessages).toHaveLength(1);
    expect(direct.pi.userMessages[0]).toMatch(/QuickReview's Setup/);

    const tuned = setupOnFakePi(scriptedRunner(ghOk));
    mkdirSync(join(tuned.host.cwd, ".qcr"), { recursive: true });
    writeFileSync(join(tuned.host.cwd, ".qcr", "profile.toml"), 'ecosystem = "none"\n');
    const quiet = fakeUi();
    await tuned.run("", quiet);
    expect(quiet.asked).toEqual([]);
    expect(reviewMessages(tuned.pi)[0]).toContain("- ✓ **repo profile**");
    expect(tuned.pi.userMessages).toEqual([]);

    const typo = setupOnFakePi(scriptedRunner(ghOk));
    const bad = fakeUi();
    await typo.run("profiel", bad);
    expect(bad.notes[0]?.[0]).toBe("error");
    expect(reviewMessages(typo.pi)).toEqual([]);
  });

  it("asks nothing with nobody to ask", async () => {
    const { pi, run } = setupOnFakePi(scriptedRunner(ghOk));
    const ui = fakeUi({ interactive: false, mode: "rpc" });
    await run("", ui);
    expect(ui.asked).toEqual([]);
    expect(pi.userMessages).toEqual([]);
    expect(reviewMessages(pi)[0]).toMatch(/^QuickReview setup/);
  });

  // The app's setup is this checklist with more steps registered onto it
  // (ADR 0001); a step the app registers lives on the app's registry and
  // never on /qcr-setup's. MUTATION: have /qcr-setup build its checklist from
  // a registry shared at module level that the app registers onto — this
  // fails.
  it("takes an app step onto the app's checklist, beside the plugin's, and never shows it in /qcr-setup", async () => {
    const appStep: SetupStep = {
      id: "repo_pick",
      title: "Pick a repository",
      explain: "The repository the home reviews.",
      order: 3.5,
      detect: async () => ({ found: "owner/name · from your qcr config" }),
      run: async () => ({ ok: true, checks: [] }),
      verify: async () => ({ ok: true, checks: [] }),
    };
    const host = fakeHost({ runner: scriptedRunner(ghOk) });
    const registry = pluginSetupRegistry({ host, range, root: () => ROOT }).register(appStep);
    const app = new SetupChecklist(registry, { clock: () => new Date() }, { file: null });
    await app.detect();
    expect(app.list().map((l) => l.id)).toEqual([
      PLUGIN_SETUP_STEPS.pi,
      PLUGIN_SETUP_STEPS.login,
      PLUGIN_SETUP_STEPS.model,
      PLUGIN_SETUP_STEPS.git,
      "repo_pick",
      PLUGIN_SETUP_STEPS.github,
      PLUGIN_SETUP_STEPS.profile,
    ]);
    expect(app.list().find((l) => l.id === "repo_pick")!.found).toBe(
      "owner/name · from your qcr config",
    );

    const { pi, run } = setupOnFakePi(scriptedRunner(ghOk));
    await run("", fakeUi({ picks: ["No, not now"] }));
    expect(reviewMessages(pi)[0]).not.toContain("Pick a repository");
    expect(
      (await runSetupChecks({ host, range, root: () => ROOT })).map((l) => l.id),
    ).not.toContain("repo_pick");
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
