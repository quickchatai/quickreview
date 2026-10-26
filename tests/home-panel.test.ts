// The home (extensions/home.ts) through its factory, on a fake pi with fake
// adapters: what the panel shows, and what its keys, the mouse and the
// `home_*` tools do. Each case drives the home as a person or the model
// would and asserts the rendered lines (tests/helpers/fake-theme.ts) and what
// was asked of the outside world.
import { describe, expect, it } from "vitest";
import { createHome } from "../extensions/home.js";
import { HOME_TOOL_NAMES } from "../src/home/toolnames.js";
import {
  known,
  unknown,
  type AutoReviewStatus,
  type HomeAdapters,
  type Known,
  type MemoryState,
  type OpenPull,
  type PrReview,
  type ReviewsPort,
  type SpendTotals,
} from "../src/home/ports.js";
import { fakePi, settle, type FakePi } from "./helpers/fake-pi.js";

const NOW = Date.parse("2026-10-26T12:00:00Z");

function pull(n: number, over: Partial<OpenPull> = {}): OpenPull {
  return {
    number: n,
    title: `Change number ${n}`,
    author: `dev${n}`,
    updatedAt: new Date(NOW - n * 3_600_000).toISOString(),
    isDraft: false,
    additions: 10 * n,
    deletions: n,
    changedFiles: n,
    headRefName: `branch-${n}`,
    headSha: `sha${n}`,
    ...over,
  };
}

const range = (from: number, to: number): number[] =>
  Array.from({ length: to - from + 1 }, (_, i) => from + i);

interface World {
  login: Known<readonly string[]>;
  user: Known<string | null>;
  repo: Known<string | null>;
  pulls: Known<readonly OpenPull[]>;
  reviews: Known<ReadonlyMap<number, PrReview>>;
  autoRounds: Known<ReadonlyMap<number, PrReview>>;
  auto: Known<AutoReviewStatus>;
  memory: Known<MemoryState>;
  spend: Known<SpendTotals>;
  open: { ok: true } | { ok: false; why: string };
}

/** A configured machine: the openai-codex login, gh signed in, a repo. */
function configured(over: Partial<World> = {}): World {
  return {
    login: known(["openai-codex"]),
    user: known("octo"),
    repo: known("acme/widgets"),
    pulls: known([pull(1), pull(3), pull(2)]),
    reviews: unknown("the home cannot read it yet"),
    autoRounds: known(new Map()),
    auto: unknown("the home cannot read it yet"),
    memory: unknown("the home cannot read it yet"),
    spend: unknown("the home cannot read it yet"),
    open: { ok: true },
    ...over,
  };
}

interface Calls {
  pulls: string[];
  user: number;
  opened: Array<[string, number]>;
}

/** A reviewer that is never asked in these cases (tests/home-review.test.ts
 * drives the review button). */
function idleReviews(w: World): ReviewsPort {
  const no = async (): Promise<{ ok: false; why: string }> => ({
    ok: false,
    why: "no reviewer in this test",
  });
  return {
    latest: async () => w.reviews,
    autoRounds: async () => w.autoRounds,
    preview: no,
    start: no,
    stop: no,
    post: no,
    status: async () => unknown("no reviewer in this test"),
    runs: async () => known([]),
    dryRun: async () => known(true),
  };
}

function adaptersOver(w: World, calls: Calls): HomeAdapters {
  return {
    login: { providers: async () => w.login },
    github: {
      user: async () => {
        calls.user++;
        return w.user;
      },
      openPulls: async (repo) => {
        calls.pulls.push(repo);
        return w.pulls;
      },
      openInBrowser: async (repo, pr) => {
        calls.opened.push([repo, pr]);
        return w.open;
      },
    },
    repo: { repo: async () => w.repo },
    clock: { now: () => NOW },
    reviews: idleReviews(w),
    autoReview: { status: async () => w.auto },
    memory: { status: async () => w.memory },
    spend: { totals: async () => w.spend },
  };
}

interface Home {
  pi: FakePi;
  w: World;
  calls: Calls;
  timers: Array<{ ms: number; fn: () => void; stopped: boolean }>;
  /** The panel's lines at a width and height. */
  lines(height?: number, width?: number): string[];
  styled(height?: number, width?: number): string[];
}

async function openHome(
  w: World = configured(),
  o: {
    model?: string;
    tools?: "reviewer" | "full";
    piModel?: { provider: string; id: string };
  } = {},
): Promise<Home> {
  const calls: Calls = { pulls: [], user: 0, opened: [] };
  const timers: Home["timers"] = [];
  const pi = fakePi(o.piModel ? { model: o.piModel } : {});
  await createHome({
    adapters: adaptersOver(w, calls),
    model: o.model ?? "openai-codex/gpt-6.1-sol",
    tools: o.tools ?? "reviewer",
    every: (ms, fn) => {
      const t = { ms, fn, stopped: false };
      timers.push(t);
      return () => {
        t.stopped = true;
      };
    },
    // the price-on-rest timer never fires here (tests/home-review.test.ts)
    after: () => () => {},
  })(pi.api);
  await pi.start();
  return {
    pi,
    w,
    calls,
    timers,
    lines: (h = 40, wd = 100) => pi.render(wd, h).lines,
    styled: (h = 40, wd = 100) => pi.render(wd, h).styled,
  };
}

const text = (lines: string[]): string => lines.join("\n");
/** The panel as running text: frame off, rows joined, so a wrapped notice reads whole. */
const flat = (lines: string[]): string =>
  lines
    .map((l) => l.replace(/^[│├╭╰]─*|[│┤╮╯]$/g, "").trim())
    .join(" ")
    .replace(/\s+/g, " ");
/** The PR numbers on the list rows, top to bottom. */
const listed = (lines: string[]): number[] =>
  lines.flatMap((l) => {
    const m = /^│.{2}\S #(\d+) {2}/.exec(l);
    return m ? [Number(m[1])] : [];
  });
/** The row the cursor bar sits on. */
const selectedRow = (lines: string[]): string | undefined => lines.find((l) => l.startsWith("│ ▌"));

describe("the home on a configured machine", () => {
  it("opens on the PR lists, newest first, with no setup step", async () => {
    const h = await openHome();
    const lines = h.lines();
    expect(lines[0]).toMatch(/^╭─ quickreview ─+ acme\/widgets ─╮$/);
    expect(text(lines)).not.toMatch(/Setup|Sign in to|Choose a repository/);
    expect(lines.find((l) => l.includes("To review"))).toMatch(/To review ─+ 3 ─┤$/);
    expect(listed(lines)).toEqual([3, 2, 1]);
    expect(lines.find((l) => l.includes("#3"))).toMatch(/@dev3 · 3h/);
    expect(flat(lines)).toMatch(
      /Found your OpenAI login, GitHub @octo and acme\/widgets from your qcr config: you're set\. 3 open pull requests\./,
    );
    expect(h.calls.pulls).toEqual(["acme/widgets"]);
  });

  it("every line is the panel's width, inside one frame", async () => {
    const h = await openHome();
    const lines = h.lines(40, 90);
    expect(lines.length).toBe(40 - 8);
    for (const l of lines) expect([...l].length).toBe(90);
    expect(lines.at(-1)).toMatch(/^╰─+╯$/);
  });

  it("shows the logins: the chat's provider and GitHub, and the tool set", async () => {
    const h = await openHome();
    const login = h.lines().find((l) => l.includes("GitHub"))!;
    expect(login).toMatch(/✓ OpenAI ChatGPT {4}✓ GitHub @octo/);
    expect(login).toMatch(/reviewer tools │$/);
    const full = await openHome(configured(), { tools: "full" });
    expect(full.lines().find((l) => l.includes("GitHub"))).toMatch(/all pi tools │$/);
  });

  it("draws the first frame before any source has answered", async () => {
    const never = new Promise<never>(() => {});
    const pi = fakePi();
    const stuck: HomeAdapters = {
      login: { providers: () => never },
      github: { user: () => never, openPulls: () => never, openInBrowser: () => never },
      repo: { repo: () => never },
      clock: { now: () => NOW },
      reviews: {
        latest: () => never,
        autoRounds: () => never,
        preview: () => never,
        start: () => never,
        status: () => never,
        stop: () => never,
        runs: () => never,
        post: () => never,
        dryRun: () => never,
      },
      autoReview: { status: () => never },
      memory: { status: () => never },
      spend: { totals: () => never },
    };
    await createHome({
      adapters: stuck,
      model: "openai-codex/x",
      tools: "reviewer",
      every: () => () => {},
    })(pi.api);
    await pi.start();
    const lines = pi.render(100, 40).lines;
    expect(lines[0]).toMatch(/quickreview/);
    expect(text(lines)).toMatch(/Auto-review checking…/);
    expect(text(lines)).toMatch(/OpenAI checking…/);
    expect(text(lines)).toMatch(/reading the pull requests…/);
    // nothing read yet is shown as a value
    expect(text(lines)).not.toMatch(/unknown|not signed in|\$0/);
  });
});

describe("the login that counts", () => {
  // MUTATION: count any provider in the auth file as signed in — this fails.
  it("a login under another provider shows as not signed in, and is a setup step", async () => {
    const h = await openHome(configured({ login: known(["anthropic", "openai-other"]) }));
    const styled = text(h.styled());
    expect(styled).toMatch(/<warning>✗<\/> <muted>OpenAI<\/> <warning>not signed in<\/>/);
    expect(text(h.lines())).toMatch(/Sign in to OpenAI\s+run qcr login/);
    const status = JSON.parse(await h.pi.tool("home_status")) as {
      login: unknown;
      setup_needed: unknown;
    };
    expect(status.login).toEqual({ provider: "openai-codex", signed_in: false });
    expect(status.setup_needed).toEqual(["login"]);
  });

  it("counts the provider of the model the chat runs on, as pi reports it", async () => {
    const h = await openHome(configured({ login: known(["anthropic"]) }), {
      piModel: { provider: "anthropic", id: "claude-x" },
    });
    expect(h.lines().find((l) => l.includes("GitHub"))).toMatch(/✓ anthropic signed in/);
  });

  it("follows the person's /model to another provider", async () => {
    const h = await openHome();
    expect(h.lines().find((l) => l.includes("GitHub"))).toMatch(/✓ OpenAI ChatGPT/);
    await h.pi.emit("model_select", { model: { provider: "anthropic", id: "c" } });
    expect(h.lines().find((l) => l.includes("GitHub"))).toMatch(/✗ anthropic not signed in/);
  });

  it("names each missing piece as a setup step, and only those", async () => {
    const h = await openHome(configured({ user: known(null), repo: known(null) }));
    const lines = h.lines();
    expect(text(lines)).toMatch(/Sign in to GitHub\s+run gh auth login/);
    expect(text(lines)).toMatch(/Choose a repository\s+set \[github\] repo in your qcr config/);
    expect(text(lines)).not.toMatch(/Sign in to OpenAI/);
    expect(text(lines)).not.toMatch(/To review/);
    expect(lines[0]).toMatch(/no repository ─╮$/);
  });
});

describe("a source that can't be read renders Unknown (invariant 9)", () => {
  it("unreadable logins and repository are Unknown, not missing", async () => {
    const h = await openHome(
      configured({
        login: unknown("can't read auth.json: EACCES"),
        user: unknown("gh is not installed"),
        repo: unknown("config.toml is not valid TOML"),
      }),
    );
    const lines = h.lines();
    expect(lines[0]).toMatch(/repository unknown ─╮$/);
    expect(lines.find((l) => l.includes("GitHub"))).toMatch(
      /\? OpenAI unknown {4}\? GitHub unknown/,
    );
    // unknown is not a gap: no setup step claims something is missing
    expect(text(lines)).not.toMatch(/Setup|not signed in/);
    expect(text(lines)).toMatch(/To review ─+ \? ─┤/);
    expect(text(lines)).toMatch(
      /Unknown — can't read the repository from your qcr config: config\.toml is not valid TOML\./,
    );
    const s = JSON.parse(await h.pi.tool("home_status")) as Record<string, unknown>;
    expect(s["repo"]).toBeNull();
    expect(s["to_review"]).toBeNull();
    expect(s["reviewed"]).toBeNull();
    expect(s["github"]).toEqual({ user: null, signed_in: null });
    expect((s["login"] as { signed_in: unknown }).signed_in).toBeNull();
    // and no action is offered on the missing data
    expect(await h.pi.tool("home_open_pr", { pr: 3 })).toMatch(/repository is unknown/);
    expect(h.calls.opened).toEqual([]);
  });

  // MUTATION: render an unknown PR list as an empty one — this fails.
  it("an unreadable PR list is Unknown with its reason, never zero", async () => {
    const h = await openHome(configured({ pulls: unknown("gh failed: HTTP 502") }));
    const lines = h.lines();
    expect(text(lines)).toMatch(/To review ─+ \? ─┤/);
    expect(text(lines)).toMatch(/Unknown — gh failed: HTTP 502\./);
    expect(text(lines)).not.toMatch(/Nothing waiting|─ 0 ─/);
    expect(flat(lines)).toMatch(
      /Couldn't read acme\/widgets's pull requests: gh failed: HTTP 502\./,
    );
    const s = JSON.parse(await h.pi.tool("home_status")) as Record<string, unknown>;
    expect(s["to_review"]).toBeNull();
    expect(s["pull_requests_unknown_because"]).toBe("gh failed: HTTP 502");
  });

  it("a port that throws instead of answering reads Unknown, and the home keeps going", async () => {
    const calls: Calls = { pulls: [], user: 0, opened: [] };
    const adapters = adaptersOver(configured(), calls);
    adapters.github.user = async () => {
      throw new Error("spawn gh EMFILE");
    };
    adapters.github.openInBrowser = async () => {
      throw new Error("spawn gh EMFILE");
    };
    const pi = fakePi();
    await createHome({
      adapters,
      model: "openai-codex/x",
      tools: "reviewer",
      every: () => () => {},
    })(pi.api);
    await pi.start();
    expect(pi.render(100, 40).lines.find((l) => l.includes("GitHub"))).toMatch(/\? GitHub unknown/);
    expect(listed(pi.render(100, 40).lines)).toEqual([3, 2, 1]);
    expect(await pi.tool("home_open_pr")).toMatch(/couldn't open a browser \(spawn gh EMFILE\)/);
  });

  it("auto-review, memory and spend read Unknown until their adapters land", async () => {
    const h = await openHome();
    const lines = h.lines();
    expect(text(lines)).toMatch(/\? Auto-review unknown · can't read its status/);
    expect(text(lines)).toMatch(/\? Memory unknown\s+spend unknown │/);
    expect(text(lines)).toMatch(/Reviewed ─+ \? ─┤/);
    expect(text(lines)).toMatch(/Unknown — the home cannot read it yet\./);
    const s = JSON.parse(await h.pi.tool("home_status")) as Record<string, unknown>;
    expect(s["auto_review"]).toBeNull();
    expect(s["memory"]).toBeNull();
    expect(s["spend"]).toBeNull();
  });

  it.each<[AutoReviewStatus, RegExp]>([
    [{ state: "off" }, /○ Auto-review off/],
    [{ state: "starting" }, /Auto-review starting/],
    [{ state: "on-live", checkedAt: NOW - 40_000 }, /● Auto-review on · live\s+checked 1m ago/],
    [{ state: "on-dry" }, /● Auto-review on · dry-run/],
    [{ state: "paused-login" }, /‖ Auto-review paused · login expired/],
    [
      { state: "broken", cause: "Docker is not running" },
      /✗ Auto-review stopped · Docker is not running/,
    ],
  ])("auto-review %j reads as its label", async (status, label) => {
    const h = await openHome(configured({ auto: known(status) }));
    expect(text(h.lines())).toMatch(label);
  });

  it("known memory and spend show their values", async () => {
    const h = await openHome(
      configured({ memory: known("on"), spend: known({ today: 1.1, month: 12.5 }) }),
    );
    expect(text(h.lines())).toMatch(/● Memory on\s+\$1\.10 today · \$12\.50 this month │/);
  });
});

describe("the lists", () => {
  const reviewed = (ns: number[]): Known<ReadonlyMap<number, PrReview>> =>
    known(
      new Map(
        ns.map((n) => [n, { findings: n % 3, high: n % 2, by: "you" as const, at: NOW - 60_000 }]),
      ),
    );

  it("splits open PRs into To review and Reviewed by their latest review", async () => {
    const h = await openHome(
      configured({ pulls: known(range(1, 5).map((n) => pull(n))), reviews: reviewed([2, 4]) }),
    );
    const lines = h.lines();
    expect(text(lines)).toMatch(/To review ─+ 3 ─┤/);
    expect(text(lines)).toMatch(/Reviewed ─+ 2 ─┤/);
    expect(listed(lines)).toEqual([5, 3, 1, 4, 2]);
    expect(lines.find((l) => l.includes("#4"))).toMatch(/1 finding · you · 1m/);
  });

  // MUTATION: drop the "… n more" row — this fails.
  it("shows 10 of each where the column has room, then … n more", async () => {
    const h = await openHome(
      configured({
        pulls: known(range(1, 50).map((n) => pull(n))),
        reviews: reviewed(range(1, 25)),
      }),
    );
    const lines = h.lines(41);
    expect(listed(lines)).toEqual([...range(41, 50).reverse(), ...range(16, 25).reverse()]);
    expect(lines.filter((l) => /… 15 more/.test(l))).toHaveLength(2);
    expect(lines.length).toBe(41 - 8);
  });

  it("the details area gives way before a list drops under 10", async () => {
    const h = await openHome(
      configured({
        pulls: known(range(1, 50).map((n) => pull(n))),
        reviews: reviewed(range(1, 25)),
      }),
    );
    expect(text(h.lines(41))).not.toMatch(/opens it on GitHub/);
    const short = await openHome();
    expect(text(short.lines(41))).toMatch(/├─ #3 ─+┤\n│ Change number 3/);
  });

  it("on a short column the lists shrink to fit, never past the panel", async () => {
    const h = await openHome(
      configured({
        pulls: known(range(1, 50).map((n) => pull(n))),
        reviews: reviewed(range(1, 25)),
      }),
    );
    const lines = h.lines(32);
    expect(lines.length).toBe(32 - 8);
    expect(listed(lines).length).toBeGreaterThan(5);
  });

  it("shows more when the column is tall", async () => {
    const h = await openHome(
      configured({
        pulls: known(range(1, 80).map((n) => pull(n))),
        reviews: reviewed(range(1, 40)),
      }),
    );
    const lines = h.lines(90);
    const rows = listed(lines);
    expect(rows.filter((n) => n > 40).length).toBeGreaterThan(10);
    expect(rows.filter((n) => n <= 40).length).toBeGreaterThan(10);
    expect(lines.length).toBe(90 - 8);
  });

  it("gives a short list's rows to the other", async () => {
    const h = await openHome(configured({ pulls: known(range(1, 40).map((n) => pull(n))) }));
    // Reviewed is Unknown (one row), so To review takes the rest
    expect(listed(h.lines(40)).length).toBeGreaterThan(10);
  });

  it("a draft says so; an empty list says nothing is waiting", async () => {
    const h = await openHome(configured({ pulls: known([pull(7, { isDraft: true })]) }));
    expect(h.lines().find((l) => l.includes("#7"))).toMatch(/Change number 7 draft/);
    const empty = await openHome(configured({ pulls: known([]) }));
    expect(text(empty.lines())).toMatch(/To review ─+ 0 ─┤/);
    expect(text(empty.lines())).toMatch(/Nothing waiting\. New pull requests show up here\./);
  });

  it("a refresh drops a PR that closed, and the selection moves to a listed one", async () => {
    const h = await openHome();
    await h.pi.tool("home_select", { pr: 1 });
    h.w.pulls = known([pull(3), pull(2)]);
    expect(await h.pi.tool("home_refresh")).toBe("2 to review, reviewed unknown");
    const lines = h.lines();
    expect(listed(lines)).toEqual([3, 2]);
    expect(selectedRow(lines)).toMatch(/#3/);
    expect(h.calls.pulls).toHaveLength(2);
  });
});

describe("keys, focus, hover and the browser", () => {
  it("alt+j and alt+k move the selection while typing", async () => {
    const h = await openHome();
    expect(selectedRow(h.lines())).toMatch(/#3/);
    await h.pi.key("alt+j");
    expect(selectedRow(h.lines())).toMatch(/#2/);
    expect(h.lines().find((l) => l.startsWith("├─ #"))).toMatch(/├─ #2 /);
    await h.pi.key("alt+j");
    await h.pi.key("alt+j");
    expect(selectedRow(h.lines())).toMatch(/#1/);
    await h.pi.key("alt+k");
    expect(selectedRow(h.lines())).toMatch(/#2/);
  });

  it("f2 focuses the panel: its plain keys work and Esc gives the editor back", async () => {
    const h = await openHome();
    expect(text(h.lines())).toMatch(/alt\+j\/k move {2}alt\+o open {2}alt\+u refresh {2}f2 focus/);
    expect(h.styled()[0]).toMatch(/^<borderMuted>╭─ /);
    await h.pi.key("f2");
    expect(h.pi.focused()).toBe(true);
    expect(h.styled()[0]).toMatch(/^<borderAccent>╭─ /);
    expect(text(h.lines())).toMatch(/j\/k move {2}o open {2}u refresh {2}esc chat/);
    await h.pi.input("j");
    expect(selectedRow(h.lines())).toMatch(/#2/);
    await h.pi.input("k");
    expect(selectedRow(h.lines())).toMatch(/#3/);
    await h.pi.input("\x1b");
    expect(h.pi.focused()).toBe(false);
  });

  it("hover selects a row; a click selects it and focuses the panel", async () => {
    const h = await openHome();
    const lines = h.lines();
    const at = (n: number): number => lines.findIndex((l) => new RegExp(`#${n} {2}`).test(l));
    expect(h.pi.mouse("move", at(1))).toBeUndefined();
    expect(selectedRow(h.lines())).toMatch(/#1/);
    expect(h.pi.focused()).toBe(false);
    expect(h.pi.mouse("click", at(2))).toEqual({ focus: true });
    expect(selectedRow(h.lines())).toMatch(/#2/);
    expect(h.pi.focused()).toBe(true);
    // a row that is not a PR selects nothing
    h.pi.mouse("move", 0);
    expect(selectedRow(h.lines())).toMatch(/#2/);
  });

  it("alt+o opens the selected PR in the browser, and o does when focused", async () => {
    const h = await openHome();
    await h.pi.key("alt+o");
    expect(h.calls.opened).toEqual([["acme/widgets", 3]]);
    expect(text(h.lines())).toMatch(/Opened #3 in your browser\./);
    await h.pi.key("f2");
    await h.pi.input("j");
    await h.pi.input("o");
    expect(h.calls.opened).toEqual([
      ["acme/widgets", 3],
      ["acme/widgets", 2],
    ]);
  });

  it("a browser that won't open leaves the link in the notice", async () => {
    const h = await openHome(configured({ open: { ok: false, why: "gh failed: no browser" } }));
    expect(await h.pi.tool("home_open_pr")).toBe(
      "couldn't open a browser (gh failed: no browser); the pull request is at https://github.com/acme/widgets/pull/3",
    );
    expect(flat(h.lines())).toMatch(
      /Couldn't open a browser \(gh failed: no browser\)\. The pull request is at https:\/\/github\.com\/acme\/widgets\/pull\/3/,
    );
  });

  it("a selection past the visible rows scrolls into view", async () => {
    const h = await openHome(
      configured({
        pulls: known(range(1, 30).map((n) => pull(n))),
        reviews: known(new Map([[99, { findings: 0, high: 0, by: "auto", at: NOW }]])),
      }),
    );
    await h.pi.tool("home_select", { pr: 2 });
    const lines = h.lines(40);
    expect(selectedRow(lines)).toMatch(/#2 /);
    expect(text(lines)).toMatch(/… \d+ more/);
  });
});

describe("every action is also a home_* tool", () => {
  it("registers exactly the home's tools and keys", async () => {
    const h = await openHome();
    expect([...h.pi.tools.keys()]).toEqual([...HOME_TOOL_NAMES]);
    expect([...h.pi.shortcuts.keys()].sort()).toEqual([
      "alt+a",
      "alt+j",
      "alt+k",
      "alt+m",
      "alt+o",
      "alt+r",
      "alt+s",
      "alt+u",
      "f2",
    ]);
    expect(h.pi.commands.size).toBe(0);
  });

  it("home_move and home_select move the same cursor the keys do", async () => {
    const h = await openHome();
    expect(await h.pi.tool("home_move", { by: 2 })).toBe("selected #1 Change number 1");
    expect(selectedRow(h.lines())).toMatch(/#1/);
    expect(await h.pi.tool("home_move", { by: -5 })).toBe("selected #3 Change number 3");
    expect(await h.pi.tool("home_select", { pr: 2 })).toBe("selected #2 Change number 2");
    expect(selectedRow(h.lines())).toMatch(/#2/);
    expect(await h.pi.tool("home_select", { pr: 42 })).toMatch(/#42 is not listed/);
    expect(selectedRow(h.lines())).toMatch(/#2/);
  });

  it("home_open_pr opens the PR it names, or the selected one", async () => {
    const h = await openHome();
    expect(await h.pi.tool("home_open_pr", { pr: 7 })).toBe(
      "opened https://github.com/acme/widgets/pull/7 in the browser",
    );
    await h.pi.tool("home_open_pr");
    expect(h.calls.opened).toEqual([
      ["acme/widgets", 7],
      ["acme/widgets", 3],
    ]);
  });

  it("home_refresh and alt+u read every source again", async () => {
    const h = await openHome();
    await h.pi.tool("home_refresh");
    await h.pi.key("alt+u");
    expect(h.calls.user).toBe(3);
    expect(h.calls.pulls).toHaveLength(3);
  });

  it("home_status reports what the panel shows", async () => {
    const h = await openHome();
    const s = JSON.parse(await h.pi.tool("home_status")) as Record<string, unknown>;
    expect(s).toMatchObject({
      repo: "acme/widgets",
      login: { provider: "openai-codex", signed_in: true },
      github: { user: "octo", signed_in: true },
      tools: "reviewer",
      setup_needed: [],
      selected: 3,
    });
    expect((s["to_review"] as Array<{ number: number }>).map((r) => r.number)).toEqual([3, 2, 1]);
  });
});

describe("the session's life", () => {
  it("re-reads its sources on a timer and stops it at shutdown", async () => {
    const h = await openHome();
    const refresh = h.timers.find((t) => t.ms === 60_000)!;
    refresh.fn();
    await settle();
    expect(h.calls.pulls).toHaveLength(2);
    await h.pi.emit("session_shutdown");
    expect(h.timers.every((t) => t.stopped)).toBe(true);
    expect(h.pi.overlays[0]!.closed).toBe(true);
  });

  it("mounts the overlay at the top right, without taking the keyboard", async () => {
    const h = await openHome();
    expect(h.pi.overlays).toHaveLength(1);
    expect(h.pi.overlays[0]!.options).toMatchObject({
      anchor: "top-right",
      width: "34%",
      minWidth: 74,
      nonCapturing: true,
    });
    expect(h.pi.focused()).toBe(false);
  });

  it("outside the TUI, draws nothing but its tools still answer", async () => {
    const calls: Calls = { pulls: [], user: 0, opened: [] };
    const pi = fakePi({ mode: "print" });
    await createHome({
      adapters: adaptersOver(configured(), calls),
      model: "openai-codex/x",
      tools: "reviewer",
      every: () => () => {},
    })(pi.api);
    await pi.start();
    expect(pi.overlays).toHaveLength(0);
    expect(JSON.parse(await pi.tool("home_status"))).toMatchObject({ repo: "acme/widgets" });
  });
});
