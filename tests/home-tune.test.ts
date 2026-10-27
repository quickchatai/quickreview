// "Tune to this repo" (src/home/tune.ts) through the home's factory, on a
// fake pi with a fake tune port: the key or `home_tune` hands the chat's
// agent the Setup brief, the agent writes the profile through
// `home_tune_write` on the person's yes, and the home says when it is done.
// Nothing waits on it: a review runs before any tune. Then the real port over
// a scratch checkout, with git faked.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createHome } from "../extensions/home.js";
import type { ProcessResult, ProcessRunner } from "../src/onboard/engine.js";
import {
  known,
  type HomeAdapters,
  type Known,
  type Outcome,
  type ReviewsPort,
} from "../src/home/ports.js";
import {
  TUNE_POLL_MS,
  WRITE_NO,
  WRITE_YES,
  checkoutTune,
  findCheckout,
  profileFile,
  type TunePort,
  type TuneStart,
  type TuneStatus,
} from "../src/home/tune.js";
import { fakePi, settle } from "./helpers/fake-pi.js";
import { idleReviews } from "./helpers/fake-reviews.js";

const NOW = Date.parse("2026-10-27T12:00:00Z");
const REPO = "acme/widgets";

interface Tuner {
  status: Known<TuneStatus>;
  start: Outcome<TuneStart>;
  starts: string[];
  writes: Array<{ checkout: string; file: string; text: string }>;
}

function tuner(over: Partial<Tuner> = {}): Tuner {
  return {
    status: known({ tuned: false, detail: "reviews run on the default profile", at: null }),
    start: { ok: true, checkout: "/src/widgets", brief: "Set up QuickReview's repo profile…" },
    starts: [],
    writes: [],
    ...over,
  };
}

function port(t: Tuner): TunePort {
  return {
    status: async () => t.status,
    start: async (repo) => {
      t.starts.push(repo);
      return t.start;
    },
    write: async (checkout, file, text) => {
      t.writes.push({ checkout, file, text });
      t.status = known({ tuned: true, detail: `.qcr/profile.toml in ${checkout}`, at: NOW + 1 });
      return { ok: true, path: join(checkout, ".qcr", file) };
    },
  };
}

function adapters(reviews: ReviewsPort): HomeAdapters {
  return {
    login: { providers: async () => known(["openai-codex"]) },
    github: {
      user: async () => known("octo"),
      openPulls: async () =>
        known([
          {
            number: 7,
            title: "Add a widget",
            author: "dev",
            updatedAt: new Date(NOW).toISOString(),
            isDraft: false,
            additions: 3,
            deletions: 1,
            changedFiles: 1,
            headRefName: "w",
            headSha: "sha7",
          },
        ]),
      openInBrowser: async () => ({ ok: true }),
    },
    repo: { repo: async () => known(REPO) },
    clock: { now: () => NOW },
    reviews,
    autoReview: { status: async () => known({ state: "off" as const }) },
    memory: { status: async () => known("off" as const) },
    spend: { totals: async () => known({ today: 0, month: 0 }) },
  };
}

async function openHome(
  t: Tuner,
  o: { answer?: string; reviews?: ReviewsPort; noTune?: boolean } = {},
) {
  const timers: Array<{ ms: number; fn: () => void; cancelled: boolean }> = [];
  const pi = fakePi({ select: o.answer === undefined ? undefined : () => o.answer });
  await createHome({
    adapters: adapters(o.reviews ?? idleReviews()),
    model: "openai-codex/gpt-6.1-sol",
    tools: "reviewer",
    every: () => () => {},
    after: (ms, fn) => {
      const timer = { ms, fn, cancelled: false };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
    ...(o.noTune ? {} : { tune: port(t) }),
  })(pi.api);
  await pi.start();
  return {
    pi,
    timers,
    text: () =>
      pi
        .render(100, 40)
        .lines.map((l) => l.replace(/^[│├╭╰]─*|[│┤╮╯]$/g, "").trim())
        .join(" ")
        .replace(/\s+/g, " "),
    /** Fire the tune's pending watch, as its timer would. */
    tick: async () => {
      const due = timers.filter((x) => x.ms === TUNE_POLL_MS && !x.cancelled);
      for (const x of due) {
        x.cancelled = true;
        x.fn();
      }
      await settle();
    },
    briefs: () =>
      pi.sent.flatMap((m) =>
        typeof m === "object" && m !== null && "user" in m
          ? [String((m as { user: unknown }).user)]
          : [],
      ),
  };
}

describe("tune to this repo", () => {
  // MUTATION: drop the tellAgent call from HomeTune.tune — this fails.
  it("home_tune hands the chat's agent the Setup brief, over the repo's checkout", async () => {
    const t = tuner();
    const h = await openHome(t);
    const said = await h.pi.tool("home_tune");
    expect(said).toMatch(/Setup of acme\/widgets started/);
    expect(t.starts).toEqual([REPO]);
    const [brief] = h.briefs();
    expect(brief).toContain("Set up QuickReview's repo profile");
    expect(brief).toContain("home_tune_write");
    expect(brief).toContain("/src/widgets");
    expect(h.text()).toMatch(/Tuning to acme\/widgets: your agent surveys \/src\/widgets/);
  });

  it("alt+t starts the same tune", async () => {
    const t = tuner();
    const h = await openHome(t);
    await h.pi.key("alt+t");
    expect(t.starts).toEqual([REPO]);
    expect(h.briefs()).toHaveLength(1);
  });

  it("a second tune while one runs says so, and sends no second brief", async () => {
    const t = tuner();
    const h = await openHome(t);
    await h.pi.tool("home_tune");
    expect(await h.pi.tool("home_tune")).toMatch(/under way/);
    expect(h.briefs()).toHaveLength(1);
  });

  // MUTATION: say "Tuned" from tune() itself, before the profile exists — this fails.
  it("reports when it is done: once the profile is written, not before", async () => {
    const t = tuner();
    const h = await openHome(t);
    await h.pi.tool("home_tune");
    await h.tick();
    expect(h.text()).not.toMatch(/Tuned to/);
    t.status = known({ tuned: true, detail: ".qcr/profile.toml in /src/widgets", at: NOW + 5 });
    await h.tick();
    expect(h.text()).toMatch(
      /Tuned to acme\/widgets: \.qcr\/profile\.toml in \/src\/widgets\. Reviews use it once it is committed/,
    );
    // done: it stops watching
    expect(h.timers.filter((x) => x.ms === TUNE_POLL_MS && !x.cancelled)).toHaveLength(0);
  });

  it("re-tuning a tuned repo is done only once the profile is written again", async () => {
    const t = tuner({
      status: known({ tuned: true, detail: ".qcr/profile.toml in /src/widgets", at: NOW - 1000 }),
    });
    const h = await openHome(t);
    await h.pi.tool("home_tune");
    await h.tick();
    expect(h.text()).not.toMatch(/Tuned to/);
    t.status = known({ tuned: true, detail: ".qcr/profile.toml in /src/widgets", at: NOW + 1 });
    await h.tick();
    expect(h.text()).toMatch(/Tuned to acme\/widgets/);
  });

  it("with no checkout to read, says why and starts nothing", async () => {
    const t = tuner({
      start: { ok: false, why: "Setup reads a checkout of acme/widgets, and there is none here" },
    });
    const h = await openHome(t);
    expect(await h.pi.tool("home_tune")).toMatch(/did not start/);
    expect(h.briefs()).toEqual([]);
    expect(h.text()).toMatch(/Can't tune to acme\/widgets yet: Setup reads a checkout/);
  });

  // MUTATION: make the review button wait for a tune (a gap until tuned) — this fails.
  it("nothing requires it before a review: the first review runs on the default profile", async () => {
    const previews: number[] = [];
    const reviews: ReviewsPort = {
      ...idleReviews(),
      preview: async (_repo, pr) => {
        previews.push(pr);
        return { ok: false, why: "stopped here by the test" };
      },
    };
    const h = await openHome(tuner(), { reviews });
    await h.pi.tool("home_review_pr", { pr: 7 });
    expect(previews).toEqual([7]);
    expect(JSON.parse(await h.pi.tool("home_status"))["setup_needed"]).toEqual([]);
  });

  it("a home without a tune port says so", async () => {
    const h = await openHome(tuner(), { noTune: true });
    expect(await h.pi.tool("home_tune")).toMatch(/can't be run from this home/);
  });
});

describe("the profile's files, on the person's yes", () => {
  it("are refused before a tune starts", async () => {
    const t = tuner();
    const h = await openHome(t, { answer: WRITE_YES });
    expect(await h.pi.tool("home_tune_write", { file: "profile.toml", content: "x" })).toMatch(
      /no tune is running/,
    );
    expect(t.writes).toEqual([]);
  });

  // MUTATION: write without asking (skip the select) — the "No" case fails.
  it("asks first, No first, and a no writes nothing", async () => {
    const t = tuner();
    const h = await openHome(t, { answer: WRITE_NO });
    await h.pi.tool("home_tune");
    expect(await h.pi.tool("home_tune_write", { file: "profile.toml", content: "a = 1" })).toMatch(
      /said no/,
    );
    expect(h.pi.selects.at(-1)?.options).toEqual([WRITE_NO, WRITE_YES]);
    expect(h.pi.selects.at(-1)?.title).toContain("/src/widgets/.qcr/profile.toml");
    expect(t.writes).toEqual([]);
  });

  it("a yes writes it into the checkout's .qcr/, and the home says Setup is done", async () => {
    const t = tuner();
    const h = await openHome(t, { answer: WRITE_YES });
    await h.pi.tool("home_tune");
    expect(
      await h.pi.tool("home_tune_write", { file: "addenda/01-no-raw-sql.md", content: "---" }),
    ).toBe("wrote /src/widgets/.qcr/addenda/01-no-raw-sql.md");
    await settle();
    expect(t.writes).toEqual([
      { checkout: "/src/widgets", file: "addenda/01-no-raw-sql.md", text: "---" },
    ]);
    expect(h.text()).toMatch(/Tuned to acme\/widgets/);
  });

  it("anything but a profile file is refused", async () => {
    const t = tuner();
    const h = await openHome(t, { answer: WRITE_YES });
    await h.pi.tool("home_tune");
    for (const file of ["../evil.toml", "addenda/../../x.md", "src/index.ts", "addenda/a.txt"])
      expect(await h.pi.tool("home_tune_write", { file, content: "x" })).toMatch(
        /not a profile file/,
      );
    expect(t.writes).toEqual([]);
  });
});

describe("profileFile", () => {
  it("names profile.toml and addenda markdown only", () => {
    expect(profileFile("profile.toml")).toBe("profile.toml");
    expect(profileFile(".qcr/profile.toml")).toBe("profile.toml");
    expect(profileFile("addenda/02-tests.md")).toBe("addenda/02-tests.md");
    expect(profileFile("addenda/..md")).toBeNull();
    expect(profileFile("/etc/passwd")).toBeNull();
  });
});

// ---- the real port: a checkout on this machine ---------------------------

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), "qcr-tune-"));
  dirs.push(d);
  return d;
}

/** git, faked: each directory's top level and origin. */
function git(repos: Record<string, string>): ProcessRunner {
  const res = (code: number, stdout = "", stderr = ""): ProcessResult => ({ code, stdout, stderr });
  return {
    run: async (cmd, args) => {
      if (cmd !== "git" || args[0] !== "-C") return res(127, "", "unexpected");
      const dir = args[1]!;
      const origin = repos[dir];
      if (origin === undefined) return res(128, "", "fatal: not a git repository");
      if (args[2] === "rev-parse") return res(0, `${dir}\n`);
      if (args[2] === "remote") return res(0, `${origin}\n`);
      return res(1, "", "unexpected");
    },
  };
}

describe("the checkout Setup runs on", () => {
  it("is the directory the home was opened from, when its origin is the repo", async () => {
    const here = scratch();
    const other = scratch();
    const r = git({
      [other]: "git@github.com:acme/other.git",
      [here]: "https://github.com/acme/widgets.git",
    });
    expect(
      await findCheckout(REPO, {
        env: { QCR_REVIEWED_REPO: other, PWD: here },
        configPath: () => join(here, "missing.toml"),
        runner: r,
      }),
    ).toBe(here);
  });

  it("is the config's reviewed_repo_dir before it", async () => {
    const named = scratch();
    const here = scratch();
    const cfg = join(scratch(), "config.toml");
    writeFileSync(cfg, `[companion]\nreviewed_repo_dir = "${named}"\n`);
    const r = git({
      [named]: "git@github.com:acme/widgets.git",
      [here]: "git@github.com:acme/widgets.git",
    });
    expect(await findCheckout(REPO, { env: { PWD: here }, configPath: () => cfg, runner: r })).toBe(
      named,
    );
  });

  it("none, when nothing here is a checkout of the repo", async () => {
    const here = scratch();
    expect(
      await findCheckout(REPO, {
        env: { PWD: here },
        configPath: () => join(here, "none.toml"),
        runner: git({ [here]: "git@github.com:someone/else.git" }),
      }),
    ).toBeNull();
  });
});

describe("the real tune port", () => {
  const over = (here: string) =>
    checkoutTune({
      env: { PWD: here },
      root: () => "/opt/qcr",
      configPath: () => join(here, "none.toml"),
      runner: git({ [here]: "git@github.com:acme/widgets.git" }),
    });

  it("starts with the plugin's Setup brief over the checkout", async () => {
    const here = scratch();
    const r = await over(here).start(REPO);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.checkout).toBe(here);
    expect(r.brief).toContain(
      "This is QuickReview's Setup: a survey of the repo, its review history",
    );
    expect(r.brief).toContain(here);
  });

  it("is not tuned until .qcr/profile.toml is there, and writes only under .qcr/", async () => {
    const here = scratch();
    const tune = over(here);
    const before = await tune.status(REPO);
    expect(before).toEqual(
      known({ tuned: false, detail: "reviews run on the default profile", at: null }),
    );
    const w = await tune.write(here, "profile.toml", '[lenses.security]\nemphasis = "money"');
    expect(w).toEqual({ ok: true, path: join(here, ".qcr", "profile.toml") });
    expect(readFileSync(join(here, ".qcr", "profile.toml"), "utf8")).toBe(
      '[lenses.security]\nemphasis = "money"\n',
    );
    const after = await tune.status(REPO);
    expect(after.kind === "known" && after.value.tuned).toBe(true);
    expect((await tune.write(here, "../escape.toml", "x")).ok).toBe(false);
  });

  it("with no checkout, start refuses with what to do, and status is unknown", async () => {
    const here = scratch();
    mkdirSync(join(here, "sub"));
    const tune = checkoutTune({
      env: { PWD: join(here, "sub") },
      root: () => "/opt/qcr",
      configPath: () => join(here, "none.toml"),
      runner: git({}),
    });
    const r = await tune.start(REPO);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.why).toMatch(/open the home from inside one/);
    expect((await tune.status(REPO)).kind).toBe("unknown");
  });
});
