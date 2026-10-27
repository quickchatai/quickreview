// The home's setup checklist (src/home/setup.ts) through the home's factory,
// on a fake pi with fake adapters: what the setup card shows on a machine
// that is not set up, what each step does when a key, the card or a
// `home_*` tool runs it, and how the card turns into the home. Then the
// step's real adapters on their own seams: pi's device login
// (src/home/devicelogin.ts) over a fake pi runtime, and the repository pick
// and its config write (src/home/setupadapters.ts) over a fake gh.
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "smol-toml";
import { describe, expect, it } from "vitest";
import { createHome } from "../extensions/home.js";
// loaded here so the module transform is not on a test's clock: the config
// write imports it on first use
import "../src/onboard/steps/configfill.js";
import type { RunResult, Runner } from "../src/home/adapters.js";
import { loginFailure, piDeviceLogin } from "../src/home/devicelogin.js";
import { known, unknown, type HomeAdapters, type Known, type OpenPull } from "../src/home/ports.js";
import {
  PASTE_REPO,
  parseRepoInput,
  type DeviceCode,
  type HomeSetupPorts,
  type LoginOutcome,
  type RepoChoice,
} from "../src/home/setup.js";
import { renderRepoConfig } from "../src/onboard/steps/repoconfig.js";
import { repoPickPort } from "../src/home/setupadapters.js";
import { HOME_SETUP_TOOL_NAMES, HOME_TOOL_NAMES } from "../src/home/toolnames.js";
import type { PluginHost } from "@quickchatai/pi-quickreview/src/plugin/session.js";
import { fakePi, settle, type FakePi } from "./helpers/fake-pi.js";
import { idleReviews } from "./helpers/fake-reviews.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TEMPLATE = readFileSync(join(root, "config.example.toml"), "utf8");
const NOW = Date.parse("2026-10-26T12:00:00Z");
const URL = "https://auth.openai.com/codex/device";

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

interface World {
  login: Known<readonly string[]>;
  user: Known<string | null>;
  repo: Known<string | null>;
  /** What is on PATH, for the first-run checks and gh. */
  path: Set<string>;
  recent: Known<readonly string[]>;
  describe: { ok: true; repo: string; defaultBranch: string | null } | { ok: false; why: string };
}

/** A machine with nothing set up: pi, git and gh installed, nothing else. */
function fresh(over: Partial<World> = {}): World {
  return {
    login: known([]),
    user: known(null),
    repo: known(null),
    path: new Set(["git", "gh"]),
    recent: known(["acme/widgets", "acme/gadgets"]),
    describe: { ok: true, repo: "acme/widgets", defaultBranch: "trunk" },
    ...over,
  };
}

interface Device {
  provider: string;
  onCode(c: DeviceCode): void;
  finish(o: LoginOutcome): void;
  signal: AbortSignal;
}

interface Setup {
  pi: FakePi;
  w: World;
  devices: Device[];
  writes: RepoChoice[];
  described: string[];
  selects: Array<{ title: string; options: string[] }>;
  /** What the next dialogs answer. */
  answers: { select?: string; input?: string };
  lines(height?: number, width?: number): string[];
  text(height?: number): string;
}

function adapters(w: World): HomeAdapters {
  return {
    login: { providers: async () => w.login },
    github: {
      user: async () => w.user,
      openPulls: async () => known([pull(1), pull(2)]),
      openInBrowser: async () => ({ ok: true }),
    },
    repo: { repo: async () => w.repo },
    clock: { now: () => NOW },
    reviews: idleReviews(),
    autoReview: { status: async () => unknown("not yet") },
    memory: { status: async () => unknown("not yet") },
    spend: { totals: async () => unknown("not yet") },
  };
}

function host(w: World): PluginHost {
  return {
    cwd: "/state/home",
    env: {},
    home: "/home/someone",
    piVersion: "1.4.0",
    agentDir: "/home/someone/.pi/agent",
    auth: { logins: () => ({}), configured: () => false, refresh: async () => {} },
    runner: {
      which: (cmd) => (w.path.has(cmd) ? `/usr/bin/${cmd}` : null),
      run: async () => ({ code: 0, stdout: "", stderr: "" }),
    },
    shutdown: new AbortController().signal,
  };
}

async function openSetup(
  w: World = fresh(),
  o: { mode?: "tui" | "print"; rows?: number } = {},
): Promise<Setup> {
  const devices: Device[] = [];
  const writes: RepoChoice[] = [];
  const described: string[] = [];
  const selects: Setup["selects"] = [];
  const answers: Setup["answers"] = {};
  const ports: HomeSetupPorts = {
    firstRun: { host: host(w), range: "^1.4.0" },
    timezone: () => "Europe/Warsaw",
    deviceLogin: {
      login: (d) => new Promise<LoginOutcome>((finish) => devices.push({ ...d, finish })),
    },
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
    adapters: adapters(w),
    model: "openai-codex/gpt-6.1-sol",
    tools: "reviewer",
    every: () => () => {},
    setup: ports,
  })(pi.api);
  await pi.start();
  const lines = (h = 40, wd = 100): string[] => pi.render(wd, h).lines;
  return {
    pi,
    w,
    devices,
    writes,
    described,
    selects,
    answers,
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
    for (const step of ["Sign in to OpenAI", "Connect GitHub", "Choose a repository"])
      expect(row(s, step), step).toBeDefined();
    expect(s.pi.focused()).toBe(false);
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
  it("signed in and connected: only the repository is asked, and no login starts", async () => {
    const s = await openSetup(fresh({ login: known(["openai-codex"]), user: known("octo") }));
    expect(row(s, "Sign in to OpenAI")).toMatch(
      /✓ {2}Sign in to OpenAI\s+ChatGPT · signed in with pi/,
    );
    expect(row(s, "Connect GitHub")).toMatch(/✓ {2}Connect GitHub\s+@octo · via gh/);
    expect(row(s, "Choose a repository")).toMatch(/▸ {2}Choose a repository\s+alt\+n choose/);
    expect(s.text()).toMatch(/2 of 3 done/);
    expect(s.devices).toHaveLength(0);
  });

  it("everything found: the home opens on its lists and the card never shows", async () => {
    const s = await openSetup(
      fresh({ login: known(["openai-codex"]), user: known("octo"), repo: known("acme/widgets") }),
    );
    expect(open(s)).toHaveLength(1);
    expect(open(s)[0]!.options).toMatchObject({ anchor: "top-right" });
    expect(s.text()).toMatch(/To review/);
    expect(s.devices).toHaveLength(0);
    expect(await s.pi.tool("home_setup_next")).toMatch(/setup is done/);
  });

  it("a source that can't be read is Unknown, never a gap (invariant 9)", async () => {
    const s = await openSetup(
      fresh({
        login: known(["openai-codex"]),
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
    const s = await openSetup(
      fresh({ login: known(["openai-codex"]), user: unknown("gh failed: HTTP 502") }),
    );
    expect(row(s, "Connect GitHub")).toMatch(/\? {2}Connect GitHub/);
    expect(s.text()).toMatch(/Unknown — can't tell: gh failed: HTTP 502\./);
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
    // the login waits for git: nothing starts by itself
    expect(s.devices).toHaveLength(0);
    w.path.add("git");
    await s.pi.key("alt+n");
    expect(s.text()).not.toMatch(/✗ git/);
  });

  it("a passing check never shows", async () => {
    const s = await openSetup();
    expect(s.text()).not.toMatch(/pi version|✗ git/);
  });

  it("gh not installed: what to install, and a re-check", async () => {
    const w = fresh({ login: known(["openai-codex"]), path: new Set(["git"]) });
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

describe("Sign in to OpenAI: pi's own device-code login", () => {
  it("starts by itself, saying the ChatGPT setting first, then shows the URL and the code", async () => {
    const s = await openSetup();
    expect(s.devices).toHaveLength(1);
    expect(s.devices[0]!.provider).toBe("openai-codex");
    expect(s.text()).toMatch(/asking for a code…/);
    expect(s.text()).toMatch(/Device-code login must be on first: ChatGPT → Settings → Security\./);
    s.devices[0]!.onCode({ userCode: "ABCD-1234", verificationUri: URL, expiresInSeconds: 900 });
    await settle();
    const text = s.text();
    expect(text).toMatch(/1 Open https:\/\/auth\.openai\.com\/codex\/device/);
    expect(text).toMatch(/2 Enter ABCD-1234/);
    expect(text).toMatch(/Device-code login must be on first: ChatGPT → Settings → Security\./);
    expect(text).toMatch(/waiting for you to approve…/);
    // the code is bold, the URL in the accent colour
    const styled = s.pi.render(100, 40).styled.join("\n");
    expect(styled).toMatch(/<b><text>ABCD-1234<\/><\/b>/);
    expect(styled).toMatch(/<accent>https:\/\/auth\.openai\.com\/codex\/device<\/>/);
  });

  it("verifies on approval: the step is done with what pi now holds", async () => {
    const s = await openSetup();
    s.devices[0]!.onCode({ userCode: "ABCD-1234", verificationUri: URL });
    s.w.login = known(["openai-codex"]);
    s.devices[0]!.finish({ ok: true });
    await settle();
    expect(row(s, "Sign in to OpenAI")).toMatch(
      /✓ {2}Sign in to OpenAI\s+ChatGPT · signed in with pi/,
    );
    expect(s.text()).toMatch(/Signed in to OpenAI with pi\./);
    expect(s.text()).toMatch(/1 of 3 done/);
  });

  it.each([
    ["expired", /The code expired before it was approved\. alt\+n gets a new one\./],
    ["denied", /The sign-in was denied\. alt\+n tries again\./],
  ] as const)("%s: says so, and alt+n starts a clean new login", async (kind, said) => {
    const s = await openSetup();
    s.devices[0]!.onCode({ userCode: "ABCD-1234", verificationUri: URL });
    s.devices[0]!.finish({ ok: false, kind, why: kind });
    await settle();
    expect(s.text()).toMatch(said);
    expect(s.text()).not.toMatch(/ABCD-1234/);
    expect(row(s, "Sign in to OpenAI")).toMatch(/▸ {2}Sign in to OpenAI\s+alt\+n sign in/);
    await s.pi.key("alt+n");
    expect(s.devices).toHaveLength(2);
    s.devices[1]!.onCode({ userCode: "WXYZ-9876", verificationUri: URL });
    await settle();
    expect(s.text()).toMatch(/2 Enter WXYZ-9876/);
    expect(s.text()).not.toMatch(said);
  });

  it("a second press while it waits starts no second login", async () => {
    const s = await openSetup();
    s.devices[0]!.onCode({ userCode: "ABCD-1234", verificationUri: URL });
    await settle();
    expect(await s.pi.tool("home_sign_in")).toBe(`Still waiting: open ${URL} and enter ABCD-1234.`);
    await s.pi.key("alt+n");
    expect(s.devices).toHaveLength(1);
  });

  it("home_sign_in answers with the URL and the code once pi has them", async () => {
    const s = await openSetup(fresh(), { mode: "print" });
    // no terminal: nothing starts by itself
    expect(s.devices).toHaveLength(0);
    const answer = s.pi.tool("home_sign_in");
    await settle();
    s.devices[0]!.onCode({ userCode: "ABCD-1234", verificationUri: URL });
    expect(await answer).toMatch(
      /^Open https:\/\/auth\.openai\.com\/codex\/device and enter the code ABCD-1234\./,
    );
  });

  it("the session's end stops a login in flight", async () => {
    const s = await openSetup();
    await s.pi.emit("session_shutdown");
    expect(s.devices[0]!.signal.aborted).toBe(true);
  });
});

describe("Connect GitHub: gh, with a one-key re-check", () => {
  it("signed out: says what to run, and alt+n checks again", async () => {
    const w = fresh({ login: known(["openai-codex"]) });
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
    const w = fresh({ login: known(["openai-codex"]) });
    const s = await openSetup(w);
    expect(await s.pi.tool("home_check_github")).toMatch(/still signed out: run `gh auth login`/);
    w.user = known("octo");
    expect(await s.pi.tool("home_check_github")).toBe("GitHub: @octo · via gh");
  });
});

describe("Choose a repository", () => {
  const ready = (): World => fresh({ login: known(["openai-codex"]), user: known("octo") });

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
    const w = fresh({ login: known(["openai-codex"]) });
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

describe("pi's device login (devicelogin.ts)", () => {
  type Interaction = {
    signal: AbortSignal;
    prompt(p: { type: string; options?: Array<{ id: string }> }): Promise<string>;
    notify(e: Record<string, unknown>): void;
  };
  const registry = (
    login: (provider: string, type: string, i: Interaction) => Promise<unknown>,
  ) => ({
    runtime: { login },
  });

  it("answers the method with the device code and hands the code on", async () => {
    let picked = "";
    const codes: DeviceCode[] = [];
    const port = piDeviceLogin(
      registry(async (provider, type, i) => {
        expect([provider, type]).toEqual(["openai-codex", "oauth"]);
        picked = await i.prompt({
          type: "select",
          options: [{ id: "browser" }, { id: "device_code" }],
        });
        i.notify({
          type: "device_code",
          userCode: "ABCD-1234",
          verificationUri: URL,
          expiresInSeconds: 900,
        });
        return { type: "oauth" };
      }),
    );
    const r = await port.login({
      provider: "openai-codex",
      signal: new AbortController().signal,
      onCode: (c) => codes.push(c),
    });
    expect(r).toEqual({ ok: true });
    expect(picked).toBe("device_code");
    expect(codes).toEqual([{ userCode: "ABCD-1234", verificationUri: URL, expiresInSeconds: 900 }]);
  });

  it("a pi without the runtime is unavailable, with pi's /login named", async () => {
    const r = await piDeviceLogin({}).login({
      provider: "openai-codex",
      signal: new AbortController().signal,
      onCode: () => {},
    });
    expect(r).toMatchObject({ ok: false, kind: "unavailable" });
    expect(r.ok ? "" : r.why).toMatch(/\/login/);
  });

  it("another question pi's flow asks is refused, never guessed", async () => {
    const port = piDeviceLogin(registry(async (_p, _t, i) => i.prompt({ type: "text" })));
    const r = await port.login({
      provider: "openai-codex",
      signal: new AbortController().signal,
      onCode: () => {},
    });
    expect(r).toMatchObject({ ok: false, kind: "failed" });
  });

  it.each([
    ["Device flow timed out", false, "expired"],
    ["OpenAI Codex device auth failed with status 400: access_denied", false, "denied"],
    ["OpenAI Codex device code login is not enabled for this server.", false, "not_enabled"],
    ["Login cancelled", false, "cancelled"],
    ["socket hang up", true, "cancelled"],
    ["socket hang up", false, "failed"],
  ] as const)("%s → %s", (msg, aborted, kind) =>
    expect(loginFailure(new Error(msg), aborted).kind).toBe(kind),
  );
});

describe("the repository write (setupadapters.ts)", () => {
  const choice: RepoChoice = {
    repo: "acme/widgets",
    baseBranch: "trunk",
    timezone: "Europe/Warsaw",
    ownerName: "Octo Cat",
    ownerLogin: "octo",
  };

  it("a fresh config is the template with the pick and the defaults, dry_run still true", async () => {
    const r = await renderRepoConfig(null, TEMPLATE, choice);
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
  it("an existing config keeps the owner's own timezone and name; the repo and its branch change", async () => {
    const existing = TEMPLATE.replace('timezone = "UTC"', 'timezone = "America/New_York"').replace(
      /^name = ""/m,
      'name = "Someone Else"',
    );
    const r = await renderRepoConfig(existing, "", choice);
    if (!r.ok) throw new Error(r.why);
    const doc = parse(r.text) as Record<string, Record<string, unknown>>;
    expect(doc["ops"]!["timezone"]).toBe("America/New_York");
    expect(doc["owner"]!["name"]).toBe("Someone Else");
    expect(doc["owner"]!["github_login"]).toBe("octo");
    expect(doc["github"]!["repo"]).toBe("acme/widgets");
    expect(doc["github"]!["base_branch"]).toBe("trunk");
  });

  it("an existing config's dry_run is carried as it is, in either direction", async () => {
    const live = TEMPLATE.replace(/^dry_run = true/m, "dry_run = false");
    const r = await renderRepoConfig(live, "", choice);
    if (!r.ok) throw new Error(r.why);
    expect((parse(r.text) as Record<string, unknown>)["dry_run"]).toBe(false);
  });

  it("a config that is not TOML is refused, and the template that dropped dry_run too", async () => {
    expect(await renderRepoConfig("[github\nrepo = ", "", choice)).toMatchObject({ ok: false });
    const noDry = TEMPLATE.replace(/^dry_run = true/m, "dry_run = false");
    const r = await renderRepoConfig(null, noDry, choice);
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
