// The home's setup checklist (src/home/setup.ts) through the home's factory,
// on a fake pi with fake adapters: what the setup card shows on a machine
// that is not set up, what each step does when a key, the card or a
// `home_*` tool runs it, and how the card turns into the home. Signed in is
// read off pi's own model registry (a fake by shape; the inventory over it is
// the real one), so the providers here are made up: no rule knows a real one.
// Then the repository pick and its config write (src/home/setupadapters.ts)
// over a fake gh.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "smol-toml";
import { afterAll, describe, expect, it } from "vitest";
import { readModelChoice } from "@quickchatai/pi-quickreview/src/modelchoice.js";
import { AUTOMATIC } from "@quickchatai/pi-quickreview/src/plugin/setup.js";
import { createHome } from "../extensions/home.js";
// loaded here so the module transform is not on a test's clock: the config
// write imports it on first use
import "../src/onboard/steps/configfill.js";
import type { RunResult, Runner } from "../src/home/adapters.js";
import { LOGIN_POLL_MS } from "../src/home/loginowner.js";
import { PRICE_REST_MS } from "../src/home/model.js";
import {
  known,
  unknown,
  type HomeAdapters,
  type Known,
  type LoginHold,
  type OpenPull,
  type ReviewQuote,
} from "../src/home/ports.js";
import {
  NO_CREDENTIAL,
  PASTE_REPO,
  SIGN_IN_TITLE,
  parseRepoInput,
  type HomeSetupPorts,
  type RepoChoice,
} from "../src/home/setup.js";
import { parsePreview } from "../src/home/reviews.js";
import { renderRepoConfig } from "../src/onboard/steps/repoconfig.js";
import { repoPickPort } from "../src/home/setupadapters.js";
import { HOME_SETUP_TOOL_NAMES, HOME_TOOL_NAMES } from "../src/home/toolnames.js";
import type { PluginHost } from "@quickchatai/pi-quickreview/src/plugin/session.js";
import { fakePi, settle, type FakePi } from "./helpers/fake-pi.js";
import { idleReviews } from "./helpers/fake-reviews.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TEMPLATE = readFileSync(join(root, "config.example.toml"), "utf8");
const NOW = Date.parse("2026-10-26T12:00:00Z");

function pull(n: number): OpenPull {
  return {
    number: n,
    title: `Change number ${n}`,
    author: `dev${n}`,
    updatedAt: new Date(NOW - n * 3_600_000).toISOString(),
    isDraft: false,
    headSha: `sha${n}`,
    additions: n,
    deletions: n,
    changedFiles: n,
    headRefName: `b${n}`,
  };
}

/** One credential pi has, as its registry says it. */
interface Cred {
  /** pi's display name for the provider. */
  name: string;
  /** A stored login (the default), a stored API key, or an environment key. */
  how?: "login" | "key" | "env";
  /** The environment variable, for `env`. */
  label?: string;
}

/** The providers pi's catalog knows, with or without a credential. */
const CATALOG: Record<string, string> = { north: "North", south: "South", east: "East" };
const NORTH: Record<string, Cred> = { north: { name: "North" } };
const SOUTH_ENV: Record<string, Cred> = {
  south: { name: "South", how: "env", label: "SOUTH_API_KEY" },
};

interface World {
  /** What pi has a credential for, by provider. A test signs in by adding one. */
  creds: Record<string, Cred>;
  /** pi's registry: read (the default), throwing, or not handed to the home. */
  registry: "ok" | "broken" | "absent";
  /** The login file's stored providers: read only when pi hands no registry. */
  stored: Known<readonly string[]>;
  user: Known<string | null>;
  repo: Known<string | null>;
  /** What is on PATH, for the first-run checks and gh. */
  path: Set<string>;
  recent: Known<readonly string[]>;
  describe: { ok: true; repo: string; defaultBranch: string | null } | { ok: false; why: string };
  /** How pi's /login opens; null: this pi gives no way. */
  menu: "opened" | "prefilled" | null;
  /** The refresher's pause, when auto-review runs here. */
  hold?: () => Promise<LoginHold>;
  /** What a preview of a pull request answers. */
  quote?: ReviewQuote;
  /** The refresher's pause, pi's menu and the pause's release, in the order they happened. */
  log: string[];
}

/** A machine with nothing set up: pi, git and gh installed, nothing else. */
function fresh(over: Partial<World> = {}): World {
  return {
    creds: {},
    registry: "ok",
    stored: known([]),
    user: known(null),
    repo: known(null),
    path: new Set(["git", "gh"]),
    recent: known(["acme/widgets", "acme/gadgets"]),
    describe: { ok: true, repo: "acme/widgets", defaultBranch: "trunk" },
    menu: "opened",
    log: [],
    ...over,
  };
}

/** pi's model registry, by shape, over the world's credentials: read live,
 * so a credential added to the world is one pi now has. */
function registry(w: World) {
  const models = Object.keys(CATALOG).map((provider) => ({
    provider,
    id: "large-3",
    name: "large-3",
    api: "made-up",
    reasoning: true,
    contextWindow: 200_000,
    cost: { input: 5, output: 15, cacheRead: 0, cacheWrite: 0 },
  }));
  return {
    getAll: () => models as never,
    getAvailable: () => {
      if (w.registry === "broken") throw new Error("registry down");
      return models.filter((m) => w.creds[m.provider] !== undefined) as never;
    },
    find: (p: string, id: string) => models.find((m) => m.provider === p && m.id === id) as never,
    getProviderAuthStatus: (p: string) => {
      const c = w.creds[p];
      if (c === undefined) return { configured: false };
      return c.how === "env"
        ? { configured: true, source: "environment", ...(c.label ? { label: c.label } : {}) }
        : { configured: true, source: "stored" };
    },
    getProvider: () => undefined,
    getProviderDisplayName: (p: string) => w.creds[p]?.name ?? CATALOG[p] ?? p,
    isUsingOAuth: (m: { provider: string }) => (w.creds[m.provider]?.how ?? "login") === "login",
  };
}

interface Timer {
  ms: number;
  fn: () => void;
  cancelled: boolean;
}

interface Setup {
  pi: FakePi;
  w: World;
  /** How many times pi's /login was opened. */
  opens: number[];
  /** The refresher's pauses: taken, and released. */
  holds: { taken: number; released: number };
  timers: Timer[];
  writes: RepoChoice[];
  described: string[];
  selects: Array<{ title: string; options: string[] }>;
  /** What the next dialogs answer. */
  answers: { select?: string; input?: string };
  /** Let the timers of `ms` that are due run once, then settle. */
  tick(ms: number): Promise<void>;
  lines(height?: number, width?: number): string[];
  text(height?: number): string;
}

function adapters(w: World, holds: Setup["holds"]): HomeAdapters {
  const hold = w.hold;
  return {
    login: { providers: async () => w.stored },
    github: {
      user: async () => w.user,
      openPulls: async () => known([pull(1), pull(2)]),
      openInBrowser: async () => ({ ok: true }),
    },
    repo: { repo: async () => w.repo },
    clock: { now: () => NOW },
    reviews: {
      ...idleReviews(),
      ...(w.quote ? { preview: async () => ({ ok: true as const, quote: w.quote! }) } : {}),
    },
    autoReview: { status: async () => unknown("not yet") },
    memory: { status: async () => unknown("not yet") },
    spend: { totals: async () => unknown("not yet") },
    ...(hold
      ? {
          loginOwner: {
            health: async () => known({ refresher: "auto-review" as const }),
            hold: async () => {
              const h = await hold();
              if (!h.ok) return h;
              holds.taken++;
              w.log.push("hold");
              return {
                ...h,
                release: () => {
                  holds.released++;
                  w.log.push("release");
                },
              };
            },
          },
        }
      : {}),
  };
}

function host(w: World): PluginHost {
  return {
    cwd: "/state/home",
    env: {},
    home: "/home/someone",
    piVersion: "1.4.0",
    agentDir: "/home/someone/.pi/agent",
    auth: { logins: () => ({}), refresh: async () => {} },
    runner: {
      which: (cmd) => (w.path.has(cmd) ? `/usr/bin/${cmd}` : null),
      run: async () => ({ code: 0, stdout: "", stderr: "" }),
    },
    shutdown: new AbortController().signal,
  };
}

async function openSetup(
  w: World = fresh(),
  o: { mode?: "tui" | "print"; rows?: number; agentDir?: string } = {},
): Promise<Setup> {
  const opens: number[] = [];
  const holds = { taken: 0, released: 0 };
  const timers: Timer[] = [];
  const writes: RepoChoice[] = [];
  const described: string[] = [];
  const selects: Setup["selects"] = [];
  const answers: Setup["answers"] = {};
  const ports: HomeSetupPorts = {
    firstRun: { host: host(w), range: "^1.4.0" },
    timezone: () => "Europe/Warsaw",
    repos: {
      recent: async () => w.recent,
      describe: async (repo) => {
        described.push(repo);
        return w.describe;
      },
      profile: async () => known({ login: "octo", name: "Octo Cat" }),
      write: async (choice) => {
        writes.push(choice);
        w.repo = known(choice.repo);
        return { ok: true, path: "/cfg/config.toml", wrote: ["[github] repo"] };
      },
    },
  };
  const pi = fakePi({ mode: o.mode ?? "tui", rows: o.rows ?? 40 });
  if (w.registry !== "absent") Object.assign(pi.ctx, { modelRegistry: registry(w) });
  // the route step moves a session with no model onto the route's
  Object.assign(pi.api, { setModel: async () => true });
  const ui = pi.ctx.ui as unknown as {
    select: (title: string, options: string[]) => Promise<string | undefined>;
    input: () => Promise<string | undefined>;
  };
  ui.select = async (title, options) => {
    selects.push({ title, options });
    return answers.select;
  };
  ui.input = async () => answers.input;
  await createHome({
    adapters: adapters(w, holds),
    model: "",
    tools: "reviewer",
    every: () => () => {},
    after: (ms, fn) => {
      const t: Timer = { ms, fn, cancelled: false };
      timers.push(t);
      return () => {
        t.cancelled = true;
      };
    },
    setup: ports,
    loginMenu: {
      open: () => {
        if (w.menu !== null) {
          opens.push(opens.length + 1);
          w.log.push("open");
        }
        return w.menu;
      },
    },
    ...(o.agentDir !== undefined ? { agentDir: o.agentDir } : {}),
  })(pi.api);
  await pi.start();
  const lines = (h = 40, wd = 100): string[] => pi.render(wd, h).lines;
  return {
    pi,
    w,
    opens,
    holds,
    timers,
    writes,
    described,
    selects,
    answers,
    tick: async (ms) => {
      for (const t of timers.splice(0)) {
        if (t.cancelled) continue;
        if (t.ms === ms) t.fn();
        else timers.push(t);
      }
      await settle();
    },
    lines,
    text: (h = 40) => flat(lines(h)),
  };
}

/** The card as running text: frame off, rows joined. */
const flat = (lines: string[]): string =>
  lines
    .map((l) => l.replace(/^[│├╭╰]─*|[│┤╮╯]$/g, "").trim())
    .join(" ")
    .replace(/\s+/g, " ");
const open = (s: Setup) => s.pi.overlays.filter((x) => !x.closed);
const row = (s: Setup, label: string): string | undefined =>
  s.lines().find((l) => l.includes(label));
/** The person sends the chat a message. */
const say = async (s: Setup, text: string): Promise<void> => {
  await s.pi.emit("input", { text, source: "interactive" });
  await settle();
};

describe("the setup card on a fresh machine", () => {
  it("opens centred at half the width, with the three steps and none done", async () => {
    const s = await openSetup();
    expect(open(s)).toHaveLength(1);
    expect(open(s)[0]!.options).toMatchObject({
      anchor: "center",
      width: "50%",
      nonCapturing: true,
    });
    const lines = s.lines(40);
    expect(lines[0]).toMatch(/^╭─ quickreview ─+ setup ─╮$/);
    // about half the terminal's height, every line the card's width
    expect(lines).toHaveLength(20);
    for (const l of lines) expect([...l].length).toBe(100);
    expect(s.text()).toMatch(/Welcome to quickreview 0 of 3 done/);
    for (const step of [SIGN_IN_TITLE, "Connect GitHub", "Choose a repository"])
      expect(row(s, step), step).toBeDefined();
    expect(s.pi.focused()).toBe(false);
  });

  // MUTATION: title the first step after the chat's provider again — the card
  // names a provider (or an empty one, with no model pinned) and this fails.
  it("the first step names no provider: any one pi supports signs the home in", async () => {
    const s = await openSetup();
    expect(SIGN_IN_TITLE).toBe("Sign in to a model provider");
    // "Sign in to": the card's subtitle also starts with "Sign in"
    expect(row(s, "Sign in to")).toMatch(/Sign in to a model provider\s/);
    expect(s.text()).not.toMatch(/Sign in to {2}|ChatGPT|device code/i);
  });

  it("names the gaps as the setup the home still needs", async () => {
    const s = await openSetup();
    const status = JSON.parse(await s.pi.tool("home_status")) as { setup_needed: unknown };
    expect(status.setup_needed).toEqual(["login", "github", "repo"]);
  });

  it("registers a tool for every setup step, on the reviewer's allowlist", async () => {
    const s = await openSetup();
    for (const name of HOME_SETUP_TOOL_NAMES) expect(s.pi.tools.has(name), name).toBe(true);
    expect(HOME_TOOL_NAMES).toEqual(expect.arrayContaining([...HOME_SETUP_TOOL_NAMES]));
    expect(s.pi.shortcuts.has("alt+n")).toBe(true);
  });
});

describe("a step already true is skipped, with what was found", () => {
  // MUTATION: drop the detect from the home's steps (every step pending) — this fails.
  it("signed in and connected: only the repository is asked, and no login opens", async () => {
    const s = await openSetup(fresh({ creds: NORTH, user: known("octo") }));
    expect(row(s, SIGN_IN_TITLE)).toMatch(
      /✓ {2}Sign in to a model provider\s+North, signed in with pi/,
    );
    expect(row(s, "Connect GitHub")).toMatch(/✓ {2}Connect GitHub\s+@octo · via gh/);
    expect(row(s, "Choose a repository")).toMatch(/▸ {2}Choose a repository\s+alt\+n choose/);
    expect(s.text()).toMatch(/2 of 3 done/);
    expect(s.opens).toEqual([]);
  });

  it("everything found: the home opens on its lists and the card never shows", async () => {
    const s = await openSetup(
      fresh({ creds: NORTH, user: known("octo"), repo: known("acme/widgets") }),
    );
    expect(open(s)).toHaveLength(1);
    expect(open(s)[0]!.options).toMatchObject({ anchor: "top-right" });
    expect(s.text()).toMatch(/To review/);
    expect(s.opens).toEqual([]);
    expect(await s.pi.tool("home_setup_next")).toMatch(/setup is done/);
  });

  it("a source that can't be read is Unknown, never a gap (invariant 9)", async () => {
    const s = await openSetup(
      fresh({
        creds: NORTH,
        user: unknown("gh failed: HTTP 502"),
        repo: known("acme/widgets"),
      }),
    );
    // nothing a read showed missing: the home, not the card
    expect(open(s)[0]!.options).toMatchObject({ anchor: "top-right" });
    const status = JSON.parse(await s.pi.tool("home_status")) as { setup_needed: unknown };
    expect(status.setup_needed).toEqual([]);
  });

  it("an Unknown beside a real gap shows as Unknown on the card", async () => {
    const s = await openSetup(fresh({ creds: NORTH, user: unknown("gh failed: HTTP 502") }));
    expect(row(s, "Connect GitHub")).toMatch(/\? {2}Connect GitHub/);
    expect(s.text()).toMatch(/Unknown — can't tell: gh failed: HTTP 502\./);
  });
});

describe("signed in is what pi's registry says, for any provider", () => {
  // MUTATION: read the login file's providers instead of pi's inventory in
  // HomeModel.credentials — a key in the environment is "not signed in" and this fails.
  it("a provider key in the environment counts, and is named by its variable", async () => {
    const s = await openSetup(fresh({ creds: SOUTH_ENV, user: known("octo") }));
    expect(row(s, SIGN_IN_TITLE)).toMatch(
      /✓ {2}Sign in to a model provider\s+South, SOUTH_API_KEY in the environment/,
    );
    expect(s.opens).toEqual([]);
    const status = JSON.parse(await s.pi.tool("home_status")) as {
      login: { signed_in: unknown; providers: unknown };
      setup_needed: unknown;
    };
    expect(status.login.signed_in).toBe(true);
    expect(status.login.providers).toEqual([
      { provider: "south", name: "South", credential: "SOUTH_API_KEY" },
    ]);
    expect(status.setup_needed).toEqual(["repo"]);
  });

  it("a stored API key and several providers are said in pi's own names", async () => {
    const key = await openSetup(
      fresh({ creds: { east: { name: "East", how: "key" } }, user: known("octo") }),
    );
    expect(row(key, SIGN_IN_TITLE)).toMatch(/East, an API key in pi/);
    const two = await openSetup(fresh({ creds: { ...NORTH, ...SOUTH_ENV }, user: known("octo") }));
    expect(row(two, SIGN_IN_TITLE)).toMatch(/✓ {2}Sign in to a model provider\s+North, South/);
  });

  // MUTATION: answer `known([])` when the registry throws (extensions/home.ts
  // credentials) — the login becomes a gap, /login opens by itself, and this fails.
  it("a registry that cannot be read is unknown: no gap, and nothing to act on (invariant 9)", async () => {
    const s = await openSetup(
      fresh({ registry: "broken", user: known("octo"), repo: known("acme/widgets") }),
    );
    // the first half: unknown is rendered as unknown, and the home opens
    expect(open(s)[0]!.options).toMatchObject({ anchor: "top-right" });
    expect(s.lines().find((l) => l.includes("GitHub"))).toMatch(/\? model login unknown/);
    const status = JSON.parse(await s.pi.tool("home_status")) as {
      login: { signed_in: unknown; providers: unknown; unknown_because: string };
      setup_needed: unknown;
    };
    expect(status.login.signed_in).toBeNull();
    expect(status.login.providers).toBeNull();
    expect(status.login.unknown_because).toMatch(/registry down/);
    expect(status.setup_needed).toEqual([]);
    // the second half: nothing derived from it acts
    expect(s.opens).toEqual([]);
    expect(await s.pi.tool("home_sign_in")).toMatch(/^model login unknown .*nothing was opened/);
    expect(s.opens).toEqual([]);
  });

  it("an unknown login beside a real gap is never the step alt+n runs", async () => {
    const s = await openSetup(fresh({ registry: "broken" }));
    expect(row(s, SIGN_IN_TITLE)).toMatch(/\? {2}Sign in to a model provider\s+unknown/);
    expect(s.text()).toMatch(/Unknown — can't read pi's model credentials: .*registry down\./);
    expect(row(s, "Connect GitHub")).toMatch(/▸ {2}Connect GitHub\s+alt\+n check/);
    await s.pi.key("alt+n");
    expect(s.opens).toEqual([]);
    const status = JSON.parse(await s.pi.tool("home_status")) as { setup_needed: unknown };
    expect(status.setup_needed).toEqual(["github", "repo"]);
  });

  it("a pi that hands the home no registry is read by its login file", async () => {
    const s = await openSetup(
      fresh({ registry: "absent", stored: known(["north"]), user: known("octo") }),
    );
    expect(row(s, SIGN_IN_TITLE)).toMatch(/✓ {2}Sign in to a model provider\s+north, signed in/);
  });
});

describe("the first-run checks are pi, git and gh", () => {
  it("git missing: the card says so first, and alt+n checks again", async () => {
    const w = fresh({ path: new Set(["gh"]) });
    const s = await openSetup(w);
    expect(row(s, "✗  git")).toMatch(/alt\+n check/);
    expect(s.text()).toMatch(
      /Git is not on PATH: every review reads a git repo, then alt\+n checks again\./,
    );
    w.path.add("git");
    await s.pi.key("alt+n");
    expect(s.text()).not.toMatch(/✗ git/);
  });

  it("a passing check never shows", async () => {
    const s = await openSetup();
    expect(s.text()).not.toMatch(/pi version|✗ git/);
  });

  it("gh not installed: what to install, and a re-check", async () => {
    const w = fresh({ creds: NORTH, path: new Set(["git"]) });
    const s = await openSetup(w);
    expect(s.text()).toMatch(
      /Gh is not installed: get it from https:\/\/cli\.github\.com, then alt\+n checks again\./,
    );
    w.path.add("gh");
    w.user = known("octo");
    await s.pi.key("alt+n");
    expect(row(s, "Connect GitHub")).toMatch(/✓ {2}Connect GitHub\s+@octo · via gh/);
  });
});

describe("Sign in to a model provider: pi's own /login", () => {
  // MUTATION: drop maybeStartLogin from HomeSetup.sync — nothing opens and this fails.
  it("opens pi's /login by itself when it is the first thing missing, and says where to sign in", async () => {
    const s = await openSetup();
    expect(s.opens).toEqual([1]);
    expect(s.text()).toMatch(
      /pi's \/login is open: pick a provider there and sign in, or paste an API key\./,
    );
    expect(s.text()).toMatch(/waiting for pi to have a credential…/);
    expect(row(s, SIGN_IN_TITLE)).toMatch(/waiting for you…/);
  });

  // MUTATION: end the sign-in when the menu opens instead of polling the
  // inventory (LoginMenu.run) — the step is never done and this fails.
  it("is done once pi has a credential, for whichever provider the person picked", async () => {
    const s = await openSetup();
    await s.tick(LOGIN_POLL_MS);
    // still none: it goes on waiting
    expect(row(s, SIGN_IN_TITLE)).toMatch(/waiting for you…/);
    s.w.creds = { east: { name: "East", how: "key" } };
    await s.tick(LOGIN_POLL_MS);
    expect(row(s, SIGN_IN_TITLE)).toMatch(
      /✓ {2}Sign in to a model provider\s+East, an API key in pi/,
    );
    expect(s.text()).toMatch(/Signed in to East with pi\./);
    expect(s.text()).toMatch(/1 of 3 done/);
    // nothing is polled after it
    expect(s.timers.filter((t) => t.ms === LOGIN_POLL_MS && !t.cancelled)).toEqual([]);
  });

  // MUTATION: drop the onInput hook in createHome (loginMenu.left) — the card
  // waits for good after the person left pi's menu, and this fails.
  it("the person leaves the menu with no credential: says so, and alt+n opens it again", async () => {
    const s = await openSetup();
    await say(s, "what is this repo?");
    expect(s.text()).toMatch(
      /pi's \/login closed before pi had a model credential\. alt\+n opens it again\./,
    );
    expect(row(s, SIGN_IN_TITLE)).toMatch(/▸ {2}Sign in to a model provider\s+alt\+n sign in/);
    expect(s.text()).toMatch(/Pi has no model credential yet\./);
    expect(NO_CREDENTIAL).toBe("pi has no model credential yet");
    await s.pi.key("alt+n");
    expect(s.opens).toEqual([1, 2]);
    expect(s.text()).not.toMatch(/closed before pi had a model credential/);
  });

  it("the /login the home itself submits, and an extension's message, are not the person leaving", async () => {
    const s = await openSetup();
    await say(s, "/login");
    await s.pi.emit("input", { text: "Setup brief", source: "extension" });
    await settle();
    expect(row(s, SIGN_IN_TITLE)).toMatch(/waiting for you…/);
  });

  it("a login made just before the person's message still counts", async () => {
    const s = await openSetup();
    s.w.creds = NORTH;
    await say(s, "review the first PR");
    expect(row(s, SIGN_IN_TITLE)).toMatch(
      /✓ {2}Sign in to a model provider\s+North, signed in with pi/,
    );
  });

  it("a second press while it waits opens no second menu", async () => {
    const s = await openSetup();
    expect(await s.pi.tool("home_sign_in")).toBe(
      "Still waiting: pi's /login is open, sign in there.",
    );
    await s.pi.key("alt+n");
    expect(s.opens).toEqual([1]);
  });

  it("where pi wires no submit, /login is left on the input line for one Enter", async () => {
    const s = await openSetup(fresh({ menu: "prefilled" }));
    expect(s.text()).toMatch(/\/login is on the input line: press Enter to open pi's menu\./);
    expect(await s.pi.tool("home_sign_in")).toBe(
      "Still waiting: /login is on the input line, press Enter to open pi's menu.",
    );
  });

  it("with no terminal nothing opens: home_sign_in says to type /login", async () => {
    const s = await openSetup(fresh(), { mode: "print" });
    expect(s.opens).toEqual([]);
    expect(await s.pi.tool("home_sign_in")).toMatch(
      /the sign-in did not finish: .*type \/login to sign in with pi's own menu/,
    );
    expect(s.opens).toEqual([]);
  });

  // MUTATION: open pi's /login before taking the hold, or drop the release
  // (LoginMenu.run) — the refresher could write over the new login, and this fails.
  it("holds auto-review's refresher from before the menu opens until the sign-in ends", async () => {
    const s = await openSetup(
      fresh({ hold: async () => ({ ok: true, held: true, release: () => {} }) }),
    );
    expect(s.w.log).toEqual(["hold", "open"]);
    await s.tick(LOGIN_POLL_MS);
    expect(s.holds).toEqual({ taken: 1, released: 0 });
    s.w.creds = NORTH;
    await s.tick(LOGIN_POLL_MS);
    expect(s.w.log).toEqual(["hold", "open", "release"]);
  });

  it("a refresher that cannot be paused: nothing opens, and the card says why", async () => {
    const s = await openSetup(
      fresh({ hold: async () => ({ ok: false, why: "the refresher did not pause" }) }),
    );
    expect(s.opens).toEqual([]);
    expect(s.text()).toMatch(
      /The sign-in did not start: the refresher did not pause\. alt\+n tries again\./,
    );
  });

  it("the session's end stops a sign-in in flight, and lifts its hold", async () => {
    const s = await openSetup(
      fresh({ hold: async () => ({ ok: true, held: true, release: () => {} }) }),
    );
    expect(s.holds).toEqual({ taken: 1, released: 0 });
    await s.pi.emit("session_shutdown");
    await settle();
    expect(s.holds.released).toBe(1);
    expect(s.timers.filter((t) => t.ms === LOGIN_POLL_MS && !t.cancelled)).toEqual([]);
  });
});

describe("Review model: the optional step, when a quote says providers tie", () => {
  const dir = mkdtempSync(join(tmpdir(), "home-setup-model-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const plain: ReviewQuote = {
    estimateUsd: 1.2,
    capUsd: 2.4,
    basis: "measured",
    model: "north/large-3",
    key: "k1",
    lenses: [],
    files: 1,
    headSha: "sha1",
  };
  const asking: ReviewQuote = { ...plain, ask: true, providers: 2 };
  const ready = (over: Partial<World> = {}): World =>
    fresh({
      creds: { ...NORTH, ...SOUTH_ENV },
      user: known("octo"),
      repo: known("acme/widgets"),
      ...over,
    });
  /** The cursor rests on the first pull request: the home prices it. */
  const priced = async (s: Setup): Promise<void> => s.tick(PRICE_REST_MS);

  // MUTATION: drop the `ask` spread from parsePreview (src/home/reviews.ts) —
  // no quote ever asks, and this fails.
  it("the preview's model.ask and its alternatives are the quote's question", () => {
    const preview = (model: Record<string, unknown>): Record<string, unknown> => ({
      ok: true,
      preview: {
        estimate_usd: 1.2,
        cap_usd: 2.4,
        price_basis: "measured",
        key: "k1",
        lenses: [],
        files: 1,
        model,
        alternatives: [{ spec: "south/large-3" }],
      },
    });
    expect(parsePreview(preview({ spec: "north/large-3", ask: true }))).toMatchObject({
      ok: true,
      quote: { model: "north/large-3", ask: true, providers: 2 },
    });
    const settled = parsePreview(preview({ spec: "north/large-3", ask: false }));
    expect(settled.ok && ("ask" in settled.quote || "providers" in settled.quote)).toBe(false);
  });

  it("is not on the card or in the way while no quote asks", async () => {
    const s = await openSetup(ready({ quote: plain }));
    await priced(s);
    expect(open(s)[0]!.options).toMatchObject({ anchor: "top-right" });
    expect(s.text()).not.toMatch(/Review model/);
  });

  // MUTATION: drop the `onQuote` hook (HomeModel) or `quoted` (HomeSetup) —
  // the question is never shown and this fails.
  it("the first quote that asks brings the card back with the step and what reviews would run on", async () => {
    const s = await openSetup(ready({ quote: asking }), { agentDir: dir });
    expect(open(s)[0]!.options).toMatchObject({ anchor: "top-right" });
    await priced(s);
    expect(open(s)[0]!.options).toMatchObject({ anchor: "center" });
    expect(row(s, "Review model")).toMatch(/▸ {2}Review model\s+alt\+n choose/);
    expect(s.text()).toMatch(
      /2 providers signed in; reviews would run on north\/large-3\. alt\+n picks the provider/,
    );
    expect(s.text()).toMatch(/3 of 4 done/);
    // optional: it is never a gap
    const status = JSON.parse(await s.pi.tool("home_status")) as { setup_needed: unknown };
    expect(status.setup_needed).toEqual([]);
  });

  it("choosing a provider remembers it as the person's stated choice, and the home comes back", async () => {
    const s = await openSetup(ready({ quote: asking }), { agentDir: dir });
    await priced(s);
    s.answers.select = "South    SOUTH_API_KEY";
    await s.pi.key("alt+n");
    expect(s.selects.at(-1)).toEqual({
      title: "QuickReview: which provider do reviews run on?",
      options: ["North    signed in with pi", "South    SOUTH_API_KEY", AUTOMATIC],
    });
    expect(readModelChoice(dir).choice).toMatchObject({
      provider: "south",
      model: null,
      via: "use",
    });
    expect(open(s)[0]!.options).toMatchObject({ anchor: "top-right" });
    expect(s.text()).toMatch(/QuickReview will use South from now on\./);
  });

  // MUTATION: keep the card up after the list is dismissed (leave `asked` set
  // in chooseModel) — the optional step holds the home, and this fails.
  it("skipping is allowed: dismissing the list keeps the order and gives the home back", async () => {
    const skip = mkdtempSync(join(tmpdir(), "home-setup-skip-"));
    try {
      const s = await openSetup(ready({ quote: asking }), { agentDir: skip });
      await priced(s);
      await s.pi.key("alt+n");
      expect(readModelChoice(skip).choice).toBeUndefined();
      expect(open(s)[0]!.options).toMatchObject({ anchor: "top-right" });
      expect(s.text()).toMatch(/Reviews run on north\/large-3\./);
      // it is not asked again in this session
      await priced(s);
      expect(open(s)[0]!.options).toMatchObject({ anchor: "top-right" });
    } finally {
      rmSync(skip, { recursive: true, force: true });
    }
  });

  it("a tool cannot make the choice: home_setup_next says what it is", async () => {
    const s = await openSetup(ready({ quote: asking }), { agentDir: dir });
    await priced(s);
    expect(await s.pi.tool("home_setup_next")).toMatch(
      /2 providers signed in; reviews would run on north\/large-3\. Choosing is the person's/,
    );
  });
});

describe("the session's end, with reads still out", () => {
  // MUTATION: keep `session` after session_shutdown, or let setup.sync go on
  // after close — the stale context throws from a read nobody awaits, and this fails.
  it("a read that lands after /new replaced the session touches nothing of it", async () => {
    const w = fresh();
    let release: (v: Known<string | null>) => void = () => {};
    const held = new Promise<Known<string | null>>((r) => (release = r));
    const a = adapters(w, { taken: 0, released: 0 });
    a.github = { ...a.github, user: () => held };
    const pi = fakePi({ mode: "tui" });
    await createHome({
      adapters: a,
      model: "",
      tools: "reviewer",
      every: () => () => {},
      setup: { firstRun: { host: host(w), range: "^1.4.0" } },
    })(pi.api);
    await pi.start();
    const mounted = pi.overlays.length;
    await pi.emit("session_shutdown");
    // pi makes the outgoing context stale: any use of it throws
    for (const k of ["mode", "hasUI", "ui", "modelRegistry"])
      Object.defineProperty(pi.ctx, k, {
        get: () => {
          throw new Error("This extension ctx is stale after session replacement");
        },
      });
    const rejections: unknown[] = [];
    const onRejection = (e: unknown): void => void rejections.push(e);
    process.on("unhandledRejection", onRejection);
    try {
      release(known(null));
      await settle();
      await new Promise((r) => setTimeout(r, 10));
    } finally {
      process.off("unhandledRejection", onRejection);
    }
    expect(rejections).toEqual([]);
    expect(pi.overlays.length).toBe(mounted);
  });
});

describe("Connect GitHub: gh, with a one-key re-check", () => {
  it("signed out: says what to run, and alt+n checks again", async () => {
    const w = fresh({ creds: NORTH });
    const s = await openSetup(w);
    expect(row(s, "Connect GitHub")).toMatch(/▸ {2}Connect GitHub\s+alt\+n check/);
    expect(s.text()).toMatch(
      /Gh is signed out: run `gh auth login` in a shell, then alt\+n checks again\./,
    );
    // still signed out: the same instruction, as the notice
    await s.pi.key("alt+n");
    expect(s.text()).toMatch(
      /gh is still signed out: run `gh auth login` in a shell, then press alt\+n/,
    );
    w.user = known("octo");
    await s.pi.key("alt+n");
    expect(row(s, "Connect GitHub")).toMatch(/✓ {2}Connect GitHub\s+@octo · via gh/);
    expect(s.text()).toMatch(/Connected to GitHub as @octo · via gh\./);
  });

  it("home_check_github is the same check", async () => {
    const w = fresh({ creds: NORTH });
    const s = await openSetup(w);
    expect(await s.pi.tool("home_check_github")).toMatch(/still signed out: run `gh auth login`/);
    w.user = known("octo");
    expect(await s.pi.tool("home_check_github")).toBe("GitHub: @octo · via gh");
  });
});

describe("Choose a repository", () => {
  const ready = (): World => fresh({ creds: NORTH, user: known("octo") });

  it("lists the recently pushed repositories, then writes the pick with the silent defaults", async () => {
    const s = await openSetup(ready());
    s.answers.select = "acme/widgets";
    await s.pi.key("alt+n");
    expect(s.selects).toEqual([
      {
        title: "Choose a repository: your recently pushed ones",
        options: ["acme/widgets", "acme/gadgets", PASTE_REPO],
      },
    ]);
    expect(s.writes).toEqual([
      {
        repo: "acme/widgets",
        baseBranch: "trunk",
        timezone: "Europe/Warsaw",
        ownerLogin: "octo",
        ownerName: "Octo Cat",
      },
    ]);
  });

  it("accepts any pasted owner/name or URL", async () => {
    const s = await openSetup(ready());
    s.answers.select = PASTE_REPO;
    s.answers.input = "https://github.com/Acme/Widgets/pull/3";
    await s.pi.key("alt+n");
    expect(s.described).toEqual(["Acme/Widgets"]);
    // GitHub's own spelling is what is written
    expect(s.writes[0]!.repo).toBe("acme/widgets");
  });

  it("the last step done: the card turns into the home", async () => {
    const s = await openSetup(ready());
    expect(open(s)[0]!.options).toMatchObject({ anchor: "center" });
    s.answers.select = "acme/widgets";
    await s.pi.key("alt+n");
    expect(open(s)).toHaveLength(1);
    expect(open(s)[0]!.options).toMatchObject({ anchor: "top-right", width: "34%" });
    const lines = s.lines();
    expect(lines[0]).toMatch(/quickreview ─+ acme\/widgets ─╮$/);
    expect(flat(lines)).toMatch(/You're set\. 2 open pull requests in acme\/widgets\./);
    expect(flat(lines)).toMatch(/To review/);
  });

  it("a repository GitHub can't show is refused, and nothing is written", async () => {
    const w = ready();
    w.describe = { ok: false, why: "Could not resolve to a Repository" };
    const s = await openSetup(w);
    expect(await s.pi.tool("home_choose_repo", { repo: "acme/nope" })).toMatch(
      /GitHub can't show acme\/nope: Could not resolve to a Repository/,
    );
    expect(s.writes).toEqual([]);
    expect(await s.pi.tool("home_choose_repo", { repo: "not a repo" })).toMatch(
      /"not a repo" is not a repository: give owner\/name or a GitHub URL/,
    );
  });

  it("home_choose_repo without a repository answers the recent ones", async () => {
    const s = await openSetup(ready());
    expect(await s.pi.tool("home_choose_repo")).toMatch(
      /Recently pushed: acme\/widgets, acme\/gadgets\./,
    );
    expect(await s.pi.tool("home_choose_repo", { repo: "github.com/acme/widgets.git" })).toMatch(
      /acme\/widgets, written to \/cfg\/config\.toml/,
    );
    expect(s.writes).toHaveLength(1);
  });

  it("dismissing the list chooses nothing", async () => {
    const s = await openSetup(ready());
    await s.pi.key("alt+n");
    expect(s.writes).toEqual([]);
    expect(open(s)[0]!.options).toMatchObject({ anchor: "center" });
  });
});

describe("the card's keys", () => {
  it("⏎ on the focused card runs the next step; esc gives the editor back", async () => {
    const w = fresh({ creds: NORTH });
    const s = await openSetup(w);
    await s.pi.key("f2");
    expect(s.pi.focused()).toBe(true);
    expect(s.text()).toMatch(/⏎ next step esc back to the chat/);
    expect(row(s, "Connect GitHub")).toMatch(/⏎ check/);
    w.user = known("octo");
    await s.pi.input("\r");
    expect(row(s, "Connect GitHub")).toMatch(/✓ {2}Connect GitHub/);
    await s.pi.input("\x1b");
    expect(s.pi.focused()).toBe(false);
    expect(s.text()).toMatch(/alt\+n next step f2 focus the card · or just type to ask pi/);
  });
});

describe("parseRepoInput", () => {
  it.each([
    ["acme/widgets", "acme/widgets"],
    ["  acme/widgets  ", "acme/widgets"],
    ["https://github.com/acme/widgets", "acme/widgets"],
    ["https://github.com/acme/widgets/", "acme/widgets"],
    ["https://github.com/acme/widgets.git", "acme/widgets"],
    ["https://github.com/acme/widgets/pull/12?x=1", "acme/widgets"],
    ["github.com/acme/my.repo", "acme/my.repo"],
    ["git@github.com:acme/widgets.git", "acme/widgets"],
    ["ssh://git@github.com/acme/widgets.git", "acme/widgets"],
  ])("%s → %s", (input, want) => expect(parseRepoInput(input)).toBe(want));

  it.each([
    "",
    "widgets",
    "acme/widgets/extra",
    "-acme/x",
    "acme/..",
    "a b/c",
    "https://gitlab.com/a/b",
  ])("refuses %j", (input) => expect(parseRepoInput(input)).toBeNull());
});

describe("the repository write (setupadapters.ts)", () => {
  const choice: RepoChoice = {
    repo: "acme/widgets",
    baseBranch: "trunk",
    timezone: "Europe/Warsaw",
    ownerName: "Octo Cat",
    ownerLogin: "octo",
  };

  it("a fresh config is the template with the pick and the defaults, dry_run still true", () => {
    const r = renderRepoConfig(null, TEMPLATE, choice);
    if (!r.ok) throw new Error(r.why);
    const doc = parse(r.text) as Record<string, Record<string, unknown>>;
    expect(doc["github"]!["repo"]).toBe("acme/widgets");
    expect(doc["github"]!["base_branch"]).toBe("trunk");
    expect(doc["ops"]!["timezone"]).toBe("Europe/Warsaw");
    expect(doc["owner"]!["name"]).toBe("Octo Cat");
    expect(doc["owner"]!["github_login"]).toBe("octo");
    expect((doc as Record<string, unknown>)["dry_run"]).toBe(true);
    // comment-preserving: the template's header survives
    expect(r.text.split("\n").slice(0, 5)).toEqual(TEMPLATE.split("\n").slice(0, 5));
    expect(r.wrote).toEqual(
      expect.arrayContaining(["[github] repo", "[ops] timezone", "[owner] github_login"]),
    );
  });

  // MUTATION: fill the timezone and owner whatever the config holds — this fails.
  it("an existing config keeps the owner's own timezone and name; the repo and its branch change", () => {
    const existing = TEMPLATE.replace('timezone = "UTC"', 'timezone = "America/New_York"').replace(
      /^name = ""/m,
      'name = "Someone Else"',
    );
    const r = renderRepoConfig(existing, "", choice);
    if (!r.ok) throw new Error(r.why);
    const doc = parse(r.text) as Record<string, Record<string, unknown>>;
    expect(doc["ops"]!["timezone"]).toBe("America/New_York");
    expect(doc["owner"]!["name"]).toBe("Someone Else");
    expect(doc["owner"]!["github_login"]).toBe("octo");
    expect(doc["github"]!["repo"]).toBe("acme/widgets");
    expect(doc["github"]!["base_branch"]).toBe("trunk");
  });

  it("an existing config's dry_run is carried as it is, in either direction", () => {
    const live = TEMPLATE.replace(/^dry_run = true/m, "dry_run = false");
    const r = renderRepoConfig(live, "", choice);
    if (!r.ok) throw new Error(r.why);
    expect((parse(r.text) as Record<string, unknown>)["dry_run"]).toBe(false);
  });

  // MUTATION: drop the CRLF round-trip in patchToml (split on LF only) — this fails.
  it("a CRLF config stays CRLF: only the values change, never the line endings", () => {
    const existing = TEMPLATE.replace(/\r?\n/g, "\r\n");
    const r = renderRepoConfig(existing, "", choice);
    if (!r.ok) throw new Error(r.why);
    expect(r.text.replace(/\r\n/g, "")).not.toContain("\n");
    expect(r.text).toMatch(/^repo = "acme\/widgets" +# filled by qcr: [^\r\n]*\r\n/m);
    expect((parse(r.text) as Record<string, Record<string, unknown>>)["github"]!["repo"]).toBe(
      "acme/widgets",
    );
  });

  it("a config that is not TOML is refused, and the template that dropped dry_run too", () => {
    expect(renderRepoConfig("[github\nrepo = ", "", choice)).toMatchObject({ ok: false });
    const noDry = TEMPLATE.replace(/^dry_run = true/m, "dry_run = false");
    const r = renderRepoConfig(null, noDry, choice);
    expect(r).toMatchObject({ ok: false });
    expect(r.ok ? "" : r.why).toMatch(/dry_run/);
  });

  function ghRunner(answers: Record<string, RunResult>): Runner & { calls: string[][] } {
    const calls: string[][] = [];
    return {
      calls,
      run: async (cmd, args) => {
        calls.push([cmd, ...args]);
        return answers[args.slice(0, 2).join(" ")] ?? { code: 1, stdout: "", stderr: "unexpected" };
      },
    };
  }

  it("reads the recent repositories, the repository and the account through gh", async () => {
    const runner = ghRunner({
      "repo list": {
        code: 0,
        stdout: '[{"nameWithOwner":"acme/widgets"},{"nameWithOwner":"acme/x"}]',
        stderr: "",
      },
      "repo view": {
        code: 0,
        stdout: '{"nameWithOwner":"Acme/Widgets","defaultBranchRef":{"name":"trunk"}}',
        stderr: "",
      },
      "api user": { code: 0, stdout: '{"login":"octo","name":"Octo Cat"}', stderr: "" },
    });
    const port = repoPickPort({ runner, configPath: () => "/c", templatePath: () => "/t" });
    expect(await port.recent()).toEqual(known(["acme/widgets", "acme/x"]));
    expect(runner.calls[0]).toEqual([
      "gh",
      "repo",
      "list",
      "--limit",
      "8",
      "--json",
      "nameWithOwner",
    ]);
    expect(await port.describe("acme/widgets")).toEqual({
      ok: true,
      repo: "Acme/Widgets",
      defaultBranch: "trunk",
    });
    expect(await port.profile()).toEqual(known({ login: "octo", name: "Octo Cat" }));
  });

  it("a signed-out gh is said as such, never an empty list", async () => {
    const port = repoPickPort({
      runner: ghRunner({
        "repo list": {
          code: 1,
          stdout: "",
          stderr: "To get started with GitHub CLI, please run:  gh auth login",
        },
      }),
      configPath: () => "/c",
      templatePath: () => "/t",
    });
    expect(await port.recent()).toEqual(unknown("gh is signed out: run `gh auth login`"));
  });

  it("writes the config the home's repo port reads, from the template when there is none", async () => {
    const files = new Map<string, string>([["/tpl", TEMPLATE]]);
    const port = repoPickPort({
      runner: ghRunner({}),
      configPath: () => "/cfg/config.toml",
      templatePath: () => "/tpl",
      read: (p) => files.get(p) ?? null,
      write: (p, t) => void files.set(p, t),
    });
    const r = await port.write(choice);
    expect(r).toMatchObject({ ok: true, path: "/cfg/config.toml" });
    expect(
      (parse(files.get("/cfg/config.toml")!) as { github: { repo: string } }).github.repo,
    ).toBe("acme/widgets");
  });

  it("a config that exists and cannot be read is never replaced", async () => {
    let wrote = false;
    const port = repoPickPort({
      runner: ghRunner({}),
      configPath: () => "/cfg/config.toml",
      templatePath: () => "/tpl",
      read: () => {
        throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
      },
      write: () => void (wrote = true),
    });
    expect(await port.write(choice)).toMatchObject({ ok: false });
    expect(wrote).toBe(false);
  });
});
