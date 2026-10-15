import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseConfig, type Config } from "../src/config.js";
import { MutationGate } from "../src/gate.js";
import { GitHubAdapter, GitHubRequestError } from "../src/github.js";
import type { TokenMinter } from "../src/githubAuth.js";
import { StateStore } from "../src/state.js";
import {
  botBranchFor,
  checkDiffstat,
  deniedPath,
  fileImprovementPr,
  fileIssue,
  findDuplicateIssue,
  improvementRateReason,
  isBranchName,
  issueRateReason,
  jaccard,
  normalizeTitleTokens,
  parseNumstat,
  type Run,
} from "../src/improvements.js";
import { HEAVY_TIMEOUT_MS } from "./helpers/suite-timeouts.js";

const cfg: Config = parseConfig(
  readFileSync(join(process.cwd(), "tests/fixtures/config.toml"), "utf8"),
);

const fakeMinter = {
  appJwt: () => "jwt",
  installationToken: async () => "tok",
  invalidate: () => {},
} as unknown as TokenMinter;

function numstat(entries: Array<[number, number, string]>): string {
  return entries.map(([a, d, p]) => `${a}\t${d}\t${p}`).join("\n");
}

describe("parseNumstat / deniedPath / checkDiffstat", () => {
  it("parses numstat incl. binary markers", () => {
    const out = parseNumstat("3\t2\tsrc/a.ts\n-\t-\tdocs/logo.png\n");
    expect(out).toEqual([
      { additions: 3, deletions: 2, path: "src/a.ts", binary: false },
      { additions: 0, deletions: 0, path: "docs/logo.png", binary: true },
    ]);
  });

  it("parses the -z form: raw paths (unquoted), binary markers, and a rename record whose BOTH sides the denylist checks", () => {
    const out = parseNumstat(
      "3\t2\tsrc/a b.ts\0-\t-\tdocs/logo.png\0" + "0\t0\t\0src/cfg.txt\0.env\0",
    );
    expect(out).toEqual([
      { additions: 3, deletions: 2, path: "src/a b.ts", binary: false },
      { additions: 0, deletions: 0, path: "docs/logo.png", binary: true },
      { additions: 0, deletions: 0, path: ".env", binary: false, from: "src/cfg.txt" },
    ]);
    // A move OUT of a denied place is refused as well as a move into one.
    const outOf = checkDiffstat(parseNumstat("0\t0\t\0migrations/0001.sql\0src/x.sql\0"), cfg.caps);
    expect(outOf.ok).toBe(false);
    expect(outOf.reason).toContain("migrations/0001.sql");
  });

  it("denies migrations / infra / ansible / workflows / .env at any depth", () => {
    for (const p of [
      "migrations/0001.sql",
      "db/migrations/0002.sql",
      "infra/main.tf",
      "ansible/site.yml",
      ".github/workflows/ci.yml",
      ".env",
      ".env.production",
      "app/.env.local",
    ]) {
      expect(deniedPath(p), p).toBe(true);
    }
    for (const p of [
      "src/a.ts",
      "docs/readme.md",
      "tests/x.test.ts",
      "environment/config.ts",
      "src/migrationsHelper.ts",
    ]) {
      expect(deniedPath(p), p).toBe(false);
    }
  });

  it("accepts exactly 50 changed lines and rejects 51", () => {
    expect(checkDiffstat(parseNumstat(numstat([[30, 20, "src/a.ts"]])), cfg.caps)).toMatchObject({
      ok: true,
      lines: 50,
    });
    const over = checkDiffstat(parseNumstat(numstat([[30, 21, "src/a.ts"]])), cfg.caps);
    expect(over.ok).toBe(false);
    expect(over.reason).toContain("51 changed lines > cap 50");
  });

  it("accepts 3 files and rejects 4", () => {
    const three = numstat([
      [1, 0, "a.ts"],
      [1, 0, "b.ts"],
      [1, 0, "c.ts"],
    ]);
    expect(checkDiffstat(parseNumstat(three), cfg.caps).ok).toBe(true);
    const four = `${three}\n1\t0\td.ts`;
    const res = checkDiffstat(parseNumstat(four), cfg.caps);
    expect(res.ok).toBe(false);
    expect(res.reason).toContain("4 files changed > cap 3");
  });

  it("rejects a denylisted path even when tiny", () => {
    const res = checkDiffstat(parseNumstat(numstat([[1, 0, "db/migrations/0003.sql"]])), cfg.caps);
    expect(res.ok).toBe(false);
    expect(res.reason).toContain("path denylist");
  });

  it("the prefix list is config — a configured value replaces it, .env stays unconditional", () => {
    // Custom list: migrations/ not denied, db/ is.
    const caps = { ...cfg.caps, improvement_pr_deny_prefixes: ["db/"] };
    expect(checkDiffstat(parseNumstat(numstat([[1, 0, "migrations/0001.sql"]])), caps).ok).toBe(
      true,
    );
    const denied = checkDiffstat(parseNumstat(numstat([[1, 0, "db/schema.sql"]])), caps);
    expect(denied.ok).toBe(false);
    expect(denied.reason).toContain("path denylist");
    // deniedPath honours the same override…
    expect(deniedPath("migrations/0001.sql", ["db/"])).toBe(false);
    expect(deniedPath("db/schema.sql", ["db/"])).toBe(true);
    // …and .env-named files are refused whatever the list says.
    expect(deniedPath(".env.production", [])).toBe(true);
    expect(
      checkDiffstat(parseNumstat(numstat([[1, 0, "app/.env.local"]])), {
        ...cfg.caps,
        improvement_pr_deny_prefixes: [],
      }).ok,
    ).toBe(false);
    // The fixture (which omits the knob) parses to the shipped default list.
    expect(cfg.caps.improvement_pr_deny_prefixes).toEqual([
      "migrations/",
      "infra/",
      "ansible/",
      ".github/workflows/",
    ]);
  });

  it("rejects an empty diff and binary files", () => {
    expect(checkDiffstat([], cfg.caps).ok).toBe(false);
    expect(checkDiffstat(parseNumstat("-\t-\tx.png"), cfg.caps).reason).toContain("binary");
  });

  // `files > undefined` is false, so a cap that never arrived would pass. The
  // type says number, but a config cast can let undefined through. The check
  // refuses on anything it cannot compare against, before any pass.
  it.each([
    ["improvement_pr_max_files", undefined],
    ["improvement_pr_max_files", Number.NaN],
    ["improvement_pr_max_files", -1],
    ["improvement_pr_max_lines", undefined],
    ["improvement_pr_max_lines", Number.POSITIVE_INFINITY],
  ] as const)("cannot pass a cap comparison against an unusable %s (%s)", (key, value) => {
    const caps = { ...cfg.caps, [key]: value as unknown as number };
    const tiny = checkDiffstat(parseNumstat(numstat([[1, 0, "src/a.ts"]])), caps);
    expect(tiny.ok).toBe(false);
    expect(tiny.reason).toContain(`caps.${key}`);
    expect(tiny.reason).toContain("refusing");
  });
});

describe("rate caps from StateStore.filedSince", () => {
  it(
    "blocks the second improvement PR of the day and the fourth of the week",
    { timeout: HEAVY_TIMEOUT_MS },
    () => {
      const now = new Date("2026-08-13T10:00:00Z");
      const store = new StateStore(":memory:", () => now);
      expect(improvementRateReason(store, cfg.caps, now)).toBe(null);
      store.recordFiledItem("improvement_pr", "one", "#1");
      expect(improvementRateReason(store, cfg.caps, now)).toContain("day cap");

      const week = new StateStore(":memory:", () => new Date("2026-08-11T10:00:00Z"));
      week.recordFiledItem("improvement_pr", "a", null);
      week.recordFiledItem("improvement_pr", "b", null);
      week.recordFiledItem("improvement_pr", "c", null);
      expect(improvementRateReason(week, cfg.caps, now)).toContain("week cap");
      store.close();
      week.close();
    },
  );

  // The day caps count the operations day (`[ops] timezone`) — the day every
  // other boundary in the system uses — not the UTC one. Europe/Warsaw is
  // UTC+2 in August, so 22:00Z is already tomorrow there.
  // MUTATION: compute the window from getUTC* — both directions fail.
  it("counts the day caps on the operations day, never the UTC day (MC-16)", () => {
    const tz = "Europe/Warsaw";
    // Filed 23:30 Warsaw on the 13th; asked 00:30 Warsaw on the 14th — the
    // same UTC day, a new operations day: not capped.
    const lateFiling = new StateStore(":memory:", () => new Date("2026-08-13T21:30:00Z"));
    lateFiling.recordFiledItem("improvement_pr", "late", "#1");
    lateFiling.recordFiledItem("issue", "a", null);
    lateFiling.recordFiledItem("issue", "b", null);
    lateFiling.recordFiledItem("issue", "c", null);
    const nextDay = new Date("2026-08-13T22:30:00Z");
    expect(improvementRateReason(lateFiling, cfg.caps, nextDay, tz)).toBe(null);
    expect(issueRateReason(lateFiling, cfg.caps, nextDay, tz)).toBe(null);
    // The UTC reading — what an absent zone still means — caps both.
    expect(improvementRateReason(lateFiling, cfg.caps, nextDay)).toContain("day cap");
    expect(issueRateReason(lateFiling, cfg.caps, nextDay)).toContain("issue day cap");
    lateFiling.close();

    // Filed 01:30 Warsaw on the 14th; asked 02:30 Warsaw on the 14th — a new
    // UTC day, the same operations day: capped.
    const earlyFiling = new StateStore(":memory:", () => new Date("2026-08-13T23:30:00Z"));
    earlyFiling.recordFiledItem("improvement_pr", "early", "#2");
    const sameOpsDay = new Date("2026-08-14T00:30:00Z");
    expect(improvementRateReason(earlyFiling, cfg.caps, sameOpsDay, tz)).toContain("day cap");
    expect(improvementRateReason(earlyFiling, cfg.caps, sameOpsDay)).toBe(null);
    earlyFiling.close();
  });

  it("blocks the fourth issue of the day", () => {
    const now = new Date("2026-08-13T10:00:00Z");
    const store = new StateStore(":memory:", () => now);
    for (let i = 0; i < 2; i++) store.recordFiledItem("issue", `i${i}`, null);
    expect(issueRateReason(store, cfg.caps, now)).toBe(null);
    store.recordFiledItem("issue", "i3", null);
    expect(issueRateReason(store, cfg.caps, now)).toContain("issue day cap");
    store.close();
  });

  // `day >= undefined` is false, so a rate cap that never arrived would be
  // uncapped — the same fail-open as checkDiffstat's, on the same caps object.
  // The rate checks refuse on a cap they cannot compare against, even at zero
  // filings, whoever built the caps.
  it.each([
    ["improvement_pr_per_day", undefined],
    ["improvement_pr_per_day", Number.NaN],
    ["improvement_pr_per_week", -1],
    ["improvement_pr_per_week", Number.POSITIVE_INFINITY],
  ] as const)(
    "the improvement-PR rate check cannot pass against an unusable %s (%s)",
    (key, value) => {
      const now = new Date("2026-08-13T10:00:00Z");
      const store = new StateStore(":memory:", () => now);
      const reason = improvementRateReason(
        store,
        { ...cfg.caps, [key]: value as unknown as number },
        now,
      );
      expect(reason).toContain(`caps.${key}`);
      expect(reason).toContain("refusing");
      store.close();
    },
  );

  it.each([
    ["issues_per_day", undefined],
    ["issues_per_day", "3"],
  ] as const)("the issue rate check cannot pass against an unusable %s (%s)", (key, value) => {
    const now = new Date("2026-08-13T10:00:00Z");
    const store = new StateStore(":memory:", () => now);
    const reason = issueRateReason(store, { ...cfg.caps, [key]: value as unknown as number }, now);
    expect(reason).toContain(`caps.${key}`);
    expect(reason).toContain("refusing");
    store.close();
  });
});

describe("issue dedup — normalized-token Jaccard", () => {
  it("normalizes and scores", () => {
    expect([...normalizeTitleTokens("Fix: the Flaky, retry-loop!")]).toEqual([
      "fix",
      "the",
      "flaky",
      "retry",
      "loop",
    ]);
    expect(jaccard(new Set(["a", "b"]), new Set(["a", "b"]))).toBe(1);
    expect(jaccard(new Set(["a", "b"]), new Set(["c"]))).toBe(0);
  });

  it("treats near-identical titles as duplicates at >= 0.6", () => {
    const open = [{ number: 42, title: "Flaky retry loop in webhook receiver" }];
    const dup = findDuplicateIssue("Flaky retry loop in the webhook receiver", open);
    expect(dup?.number).toBe(42);
    expect(dup!.score).toBeGreaterThanOrEqual(0.6);
  });

  it("does not flag an unrelated title", () => {
    const open = [{ number: 42, title: "Flaky retry loop in webhook receiver" }];
    expect(findDuplicateIssue("Document the token minting script", open)).toBe(null);
  });

  it("scores just under threshold as distinct", () => {
    // 3 shared of 7 union → 0.43
    const open = [{ number: 1, title: "alpha beta gamma delta epsilon" }];
    expect(findDuplicateIssue("alpha beta gamma zeta eta", open)).toBe(null);
    // 4 shared of 6 union → 0.67
    expect(findDuplicateIssue("alpha beta gamma delta theta", open)?.number).toBe(1);
  });
});

/**
 * The reviewed repo's base clone — the one working tree every git step must
 * run in. A fixed fake path: these cases never touch a filesystem repo, they
 * assert that every invocation names this tree. A runner that dropped its
 * `cwd` would run git in the sandbox's own checkout, which has no remote, so
 * the push could never succeed.
 */
const REPO_DIR = "/srv/sandbox/example-app";
/** The commit the fake clone reports the prepared branch at. */
const TIP = "a".repeat(40);

/** A recording fake `Run`: what was asked, and WHERE. */
interface FakeRunner {
  run: Run;
  calls: string[][];
  cwds: string[];
}

describe("fileImprovementPr / fileIssue (dry-run)", () => {
  let dir: string;
  let store: StateStore;
  let gate: MutationGate;
  let adapter: GitHubAdapter;
  let openIssues: Array<{ number: number; title: string }>;
  let ensureRepoDir: ReturnType<typeof vi.fn<() => Promise<string>>>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "qcr-improve-"));
    store = new StateStore(":memory:");
    gate = new MutationGate(true, join(dir, "dryrun"), async () => {
      throw new Error("executor must not run in dry-run");
    });
    openIssues = [];
    ensureRepoDir = vi.fn(async () => REPO_DIR);
    const fetchFn = (async (url: string) => {
      if (String(url).includes("/search/issues")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            items: openIssues.map((i) => ({
              ...i,
              user: { login: "x", type: "Bot" },
              updated_at: "",
              created_at: "",
            })),
          }),
        };
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as unknown as typeof fetch;
    adapter = new GitHubAdapter(cfg, fakeMinter, gate, fetchFn);
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const intents = (): any[] =>
    readdirSync(join(dir, "dryrun"))
      .sort()
      .map((f) => JSON.parse(readFileSync(join(dir, "dryrun", f), "utf8")));

  function runner(diff: string): FakeRunner {
    const calls: string[][] = [];
    const cwds: string[] = [];
    const run: Run = async (args, cwd) => {
      calls.push(args);
      cwds.push(cwd);
      if (args[0] === "for-each-ref") return `${TIP} ${args[2]}\n`; // the branch exists
      if (args[0] === "diff") return diff;
      if (args[0] === "push") throw new Error("must not push in dry-run");
      return "";
    };
    return { run, calls, cwds };
  }

  const ctx = (run: Run) => ({ cfg, adapter, gate, store, run, ensureRepoDir });

  it("happy path: gated push_branch + create_pull + add_label, recorded — refs only, nothing checked out", async () => {
    const { run, calls, cwds } = runner(numstat([[10, 5, "docs/readme.md"]]));
    const out = await fileImprovementPr(
      {
        branch: "wip/docs",
        title: "Docs: clarify retry",
        body: "rationale\n\norigin: #12",
        slug: "clarify-retry",
      },
      ctx(run),
    );
    expect(out).toMatchObject({
      ok: true,
      branch: "bot/improve-clarify-retry",
      files: 1,
      lines: 15,
      pushed: false,
      dry_run: true,
    });

    const kinds = intents().map((i) => i.kind);
    expect(kinds).toEqual(["push_branch", "create_pull", "add_label"]);
    const push = intents()[0];
    expect(push.method).toBe("git");
    expect(push.body.target).toBe("bot/improve-clarify-retry");
    // base = the fixture's [github] base_branch, never a hardcoded master.
    expect(intents()[1].body).toMatchObject({
      head: "bot/improve-clarify-retry",
      base: cfg.github.base_branch,
      title: "Docs: clarify retry",
    });
    expect(cfg.github.base_branch).toBe("main");
    expect(intents()[2].body.labels).toEqual([cfg.github.improvement_label]);

    expect(store.filedSince("improvement_pr", "1970-01-01T00:00:00.000Z")).toBe(1);
    // The channel reads refs and pushes: no `worktree add`, no `checkout` — a
    // scratch worktree serves no step, and a leftover one would wedge every
    // later filing.
    expect(calls.map((c) => c[0])).toEqual(["fetch", "for-each-ref", "diff"]);
    // Every one of those ran in the reviewed clone — no exceptions.
    expect(cwds).toEqual([REPO_DIR, REPO_DIR, REPO_DIR]);
    // The push intent names the branch as the LOCAL ref it is pushed from.
    expect(push.path).toBe(`git push origin ${TIP}:refs/heads/bot/improve-clarify-retry`);
    expect(push.body.source).toBe("refs/heads/wip/docs");
    // …pinned to the commit the diffstat validated, never re-resolved by name.
    expect(push.body.commit).toBe(TIP);
  });

  it("the git steps run in the reviewed repo's base clone, resolved once, before the first git call", async () => {
    const { run, calls, cwds } = runner(numstat([[2, 0, "docs/readme.md"]]));
    let resolvedBefore = -1;
    ensureRepoDir.mockImplementation(async () => {
      resolvedBefore = calls.length;
      return REPO_DIR;
    });
    const out = await fileImprovementPr(
      { branch: "wip/docs", title: "t", body: "b", slug: "docs" },
      ctx(run),
    );
    expect(out.ok).toBe(true);
    expect(ensureRepoDir).toHaveBeenCalledTimes(1);
    expect(resolvedBefore).toBe(0);
    // The fetch is the base FETCH (forced, remote-tracking name) and the
    // diffstat is against origin/<base> — the ref just fetched — never the
    // clone's own local `<base>`, which nothing ever advances.
    expect(calls[0]).toEqual([
      "fetch",
      "origin",
      `+refs/heads/${cfg.github.base_branch}:refs/remotes/origin/${cfg.github.base_branch}`,
    ]);
    // Both sides fully qualified: the session's branch is addressed as a LOCAL
    // branch (`refs/heads/`), so a remote-tracking name, a tag or a sha is not
    // "the branch the session prepared", and no argument can start with `-`.
    expect(calls[1]).toEqual([
      "for-each-ref",
      "--format=%(objectname) %(refname)",
      "refs/heads/wip/docs",
    ]);
    expect(calls[2]).toEqual([
      "diff",
      "--numstat",
      "-z",
      "--no-renames",
      `refs/remotes/origin/${cfg.github.base_branch}...${TIP}`,
    ]);
    expect(new Set(cwds)).toEqual(new Set([REPO_DIR]));
    expect(cwds).toHaveLength(calls.length);
  });

  it("a branch the clone does not hold as a LOCAL branch is refused after the fetch — no diff, no gate, nothing filed", async () => {
    const { run, calls } = runner(numstat([[2, 0, "docs/readme.md"]]));
    const missing: Run = async (args, cwd) => {
      const out = await run(args, cwd);
      return args[0] === "for-each-ref" ? "" : out;
    };
    const out = await fileImprovementPr(
      { branch: "wip/never", title: "t", body: "b", slug: "never" },
      ctx(missing),
    );
    expect(out.ok).toBe(false);
    expect(out.reason).toContain("branch 'wip/never' does not exist");
    expect(calls.map((c) => c[0])).toEqual(["fetch", "for-each-ref"]);
    expect(readdirSync(dir)).not.toContain("dryrun");
    expect(store.filedSince("improvement_pr", "1970-01-01T00:00:00.000Z")).toBe(0);
  });

  it("the branch name is allowlisted before git ever sees it — an option, a refspec or a revision expression is refused with no git call", async () => {
    for (const branch of [
      "--quiet",
      "-q",
      "+wip/x",
      "wip/x:refs/heads/main",
      "a..b",
      "wip docs",
      ".hidden",
      "wip/.x",
      "x.lock",
      "wip/x.lock/y",
      "a~1",
      "a^2",
      "@{-1}",
      "x\u0007y",
      "wip/",
      "/wip",
      "wip//x",
    ]) {
      expect(isBranchName(branch), branch).toBe(false);
      const { run, calls } = runner(numstat([[1, 0, "a.ts"]]));
      const out = await fileImprovementPr({ branch, title: "t", body: "b", slug: "x" }, ctx(run));
      expect(out.ok, branch).toBe(false);
      expect(out.reason, branch).toContain("bad branch name");
      expect(calls, branch).toHaveLength(0);
    }
    expect(ensureRepoDir).not.toHaveBeenCalled();
    expect(readdirSync(dir)).not.toContain("dryrun");
    for (const branch of [
      "wip/docs",
      "wip/fix-docs",
      "fix",
      "improve/2026-09-02.retry",
      "WIP/Docs_1",
      "a.b/c-d",
      "x".repeat(200),
    ]) {
      expect(isBranchName(branch), branch).toBe(true);
    }
    expect(isBranchName("x".repeat(201))).toBe(false);
  });

  it("a clone that cannot be produced is a loud rejection, and git never runs", async () => {
    const { run, calls } = runner(numstat([[2, 0, "docs/readme.md"]]));
    ensureRepoDir.mockRejectedValueOnce(
      new Error("git clone https://example.invalid/x.git exited 128"),
    );
    const out = await fileImprovementPr(
      { branch: "wip/docs", title: "t", body: "b", slug: "docs" },
      ctx(run),
    );
    expect(out.ok).toBe(false);
    expect(out.reason).toContain("improvement-PR pipeline failed");
    expect(out.reason).toContain("exited 128");
    expect(calls).toHaveLength(0);
    expect(readdirSync(dir)).not.toContain("dryrun");
    expect(store.filedSince("improvement_pr", "1970-01-01T00:00:00.000Z")).toBe(0);
  });

  it("rejects over-cap lines with a reason, files nothing", async () => {
    const { run, cwds } = runner(numstat([[40, 11, "src/a.ts"]]));
    const out = await fileImprovementPr(
      { branch: "wip/big", title: "t", body: "b", slug: "big" },
      ctx(run),
    );
    expect(new Set(cwds)).toEqual(new Set([REPO_DIR]));
    expect(out.ok).toBe(false);
    expect(out.reason).toContain("51 changed lines");
    expect(readdirSync(dir)).not.toContain("dryrun");
    expect(store.filedSince("improvement_pr", "1970-01-01T00:00:00.000Z")).toBe(0);
    expect(
      store
        .eventsOn(new Date().toISOString().slice(0, 10))
        .some((e) => e.kind === "improvement_pr_rejected"),
    ).toBe(true);
  });

  it("rejects a denylisted path and a 4-file diff", async () => {
    const one = runner(numstat([[1, 0, "infra/main.tf"]]));
    const denied = await fileImprovementPr(
      { branch: "wip/x", title: "t", body: "b", slug: "x" },
      ctx(one.run),
    );
    expect(denied.reason).toContain("path denylist");
    expect(new Set(one.cwds)).toEqual(new Set([REPO_DIR]));
    const four = runner(
      numstat([
        [1, 0, "a.ts"],
        [1, 0, "b.ts"],
        [1, 0, "c.ts"],
        [1, 0, "d.ts"],
      ]),
    );
    const many = await fileImprovementPr(
      { branch: "wip/y", title: "t", body: "b", slug: "y" },
      ctx(four.run),
    );
    expect(many.reason).toContain("4 files changed");
    expect(new Set(four.cwds)).toEqual(new Set([REPO_DIR]));
  });

  it("rejects when the day cap is already spent (before touching git)", async () => {
    store.recordFiledItem("improvement_pr", "already", "#1");
    const { run, calls } = runner(numstat([[1, 0, "a.ts"]]));
    const out = await fileImprovementPr(
      { branch: "wip/x", title: "t", body: "b", slug: "x" },
      ctx(run),
    );
    expect(out.ok).toBe(false);
    expect(out.reason).toContain("day cap");
    expect(calls).toHaveLength(0);
    expect(ensureRepoDir).not.toHaveBeenCalled();
  });

  it("rejects a bad slug", async () => {
    const { run } = runner("");
    const out = await fileImprovementPr(
      { branch: "wip/x", title: "t", body: "b", slug: "Bad Slug" },
      ctx(run),
    );
    expect(out.ok).toBe(false);
    expect(out.reason).toContain("bad slug");
    expect(botBranchFor("ok-slug")).toBe("bot/improve-ok-slug");
  });

  it("the caps hold across CONCURRENT filings — two watchers sharing one slot file once", async () => {
    // commands/, commands/operator/ and commands/slack/ are separate watchers
    // over the same handlers; each serialises only its own queue. The cap
    // check and the record straddle git + network awaits, so two filings
    // that overlap must not both read the last slot as free.
    const { run } = runner(numstat([[2, 0, "docs/readme.md"]]));
    const outs = await Promise.all(
      ["one", "two"].map((slug) =>
        fileImprovementPr({ branch: `wip/${slug}`, title: slug, body: "b", slug }, ctx(run)),
      ),
    );
    // MUTATION: drop the filing lock — both filings pass the 1/day cap.
    expect(outs.map((o) => o.ok)).toEqual([true, false]);
    expect(outs[1]!.reason).toContain("cap");
    expect(store.filedSince("improvement_pr", "1970-01-01T00:00:00.000Z")).toBe(1);

    store.recordFiledItem("issue", "a", null);
    store.recordFiledItem("issue", "b", null);
    const issues = await Promise.all(
      ["Alpha retry loop jitter", "Webhook dedupe ordering"].map((title) =>
        fileIssue({ title, body: "e" }, { cfg, adapter, gate, store }),
      ),
    );
    expect(issues.map((o) => o.ok)).toEqual([true, false]);
    expect(store.filedSince("issue", "1970-01-01T00:00:00.000Z")).toBe(3);
  });

  it("files an issue in dry-run with the bot-filed label and records it", async () => {
    const out = await fileIssue(
      { title: "Retry loop misses jitter", body: "evidence" },
      { cfg, adapter, gate, store },
    );
    expect(out).toMatchObject({ ok: true, dry_run: true });
    const [intent] = intents();
    expect(intent.kind).toBe("create_issue");
    expect(intent.body.labels).toEqual([cfg.github.issue_label]);
    expect(store.filedSince("issue", "1970-01-01T00:00:00.000Z")).toBe(1);
  });

  it("rejects a duplicate issue against open bot-filed issues", async () => {
    openIssues = [{ number: 99, title: "Retry loop misses jitter in webhook receiver" }];
    const out = await fileIssue(
      { title: "Retry loop misses jitter in the webhook receiver", body: "evidence" },
      { cfg, adapter, gate, store },
    );
    expect(out.ok).toBe(false);
    expect(out.reason).toContain("duplicate of open issue #99");
    expect(out.duplicate_of).toBe(99);
    expect(store.filedSince("issue", "1970-01-01T00:00:00.000Z")).toBe(0);
  });

  it("rejects issues over the day cap", async () => {
    for (let i = 0; i < 3; i++) store.recordFiledItem("issue", `i${i}`, null);
    const spy = vi.spyOn(adapter, "createIssue");
    const out = await fileIssue(
      { title: "brand new topic entirely", body: "b" },
      { cfg, adapter, gate, store },
    );
    expect(out.ok).toBe(false);
    expect(out.reason).toContain("issue day cap");
    expect(spy).not.toHaveBeenCalled();
  });

  // A deferral's ticket rides this path — no second writer, no new
  // mutation kind, every existing cap intact. What is new is that a refusal is
  // LOUD: a deferral whose ticket was silently refused is a deferral that
  // became free again, which is the failure the whole mechanism prevents.
  describe("deferral tickets", () => {
    it("files through the same capped path and attributes the filing to the PR", async () => {
      const out = await fileIssue(
        { title: "Retry loop misses jitter", body: "evidence", pr: 5314 },
        { cfg, adapter, gate, store },
      );
      expect(out).toMatchObject({ ok: true, pr: 5314, dry_run: true });
      expect(intents()[0]?.kind).toBe("create_issue");
      // The cap ledger counts it like any other issue — no exemption.
      expect(store.filedSince("issue", "1970-01-01T00:00:00.000Z")).toBe(1);
      expect(store.anomalies()).toHaveLength(0);
    });

    it("makes a cap refusal LOUD — an anomaly against the PR, and nothing filed", async () => {
      for (let i = 0; i < 3; i++) store.recordFiledItem("issue", `i${i}`, null);
      const spy = vi.spyOn(adapter, "createIssue");
      const out = await fileIssue(
        { title: "brand new topic", body: "b", pr: 5314 },
        { cfg, adapter, gate, store },
      );
      expect(out.ok).toBe(false);
      expect(out.reason).toContain("issue day cap");
      expect(spy).not.toHaveBeenCalled();
      const anomalies = store.anomalies();
      expect(anomalies).toHaveLength(1);
      expect(anomalies[0]).toMatchObject({ kind: "deferral_ticket_refused", pr: 5314 });
      expect(anomalies[0]?.detail).toContain("issue day cap");
    });

    it("is just as loud on a duplicate refusal", async () => {
      openIssues = [{ number: 99, title: "Retry loop misses jitter in webhook receiver" }];
      const out = await fileIssue(
        { title: "Retry loop misses jitter in the webhook receiver", body: "b", pr: 5314 },
        { cfg, adapter, gate, store },
      );
      expect(out.ok).toBe(false);
      expect(store.anomalies().map((a) => a.kind)).toEqual(["deferral_ticket_refused"]);
    });

    it("stays silent for an unattributed issue — the EOD pipeline is unchanged", async () => {
      for (let i = 0; i < 3; i++) store.recordFiledItem("issue", `i${i}`, null);
      const out = await fileIssue(
        { title: "brand new topic", body: "b" },
        { cfg, adapter, gate, store },
      );
      expect(out.ok).toBe(false);
      expect(store.anomalies()).toHaveLength(0);
    });
  });
});

/**
 * The improvement-branch push is gated in live mode too.
 *
 * The suite above runs in dry-run, so it cannot tell a gated push from one
 * that shells straight to `git push` when live — a live push with no kind
 * check, no guard and no `after` hook would be the mutation path around the
 * gate that CLAUDE.md rule 1 forbids. These cases run the gate live.
 */
describe("fileImprovementPr — the push goes through the gate in live mode", () => {
  let dir: string;
  let store: StateStore;
  let gate: MutationGate;
  let adapter: GitHubAdapter;
  /** Every intent the gate's guard saw — proof the gate mediated it. */
  let seen: string[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "qcr-improve-live-"));
    store = new StateStore(":memory:");
    gate = new MutationGate(false, join(dir, "dryrun"), async (i) => {
      if (i.method === "git") throw new Error("the REST executor must never perform a git push");
      return { number: 4242 };
    });
    seen = [];
    gate.setGuard({
      before: async (i) => {
        seen.push(i.kind);
        return {};
      },
    });
    adapter = new GitHubAdapter(cfg, fakeMinter, gate, (async () => {
      throw new Error("no direct fetch expected");
    }) as unknown as typeof fetch);
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function liveRunner(): FakeRunner {
    const calls: string[][] = [];
    const cwds: string[] = [];
    const run: Run = async (args, cwd) => {
      calls.push(args);
      cwds.push(cwd);
      if (args[0] === "for-each-ref") return `${TIP} ${args[2]}\n`;
      if (args[0] === "diff") return numstat([[3, 1, "docs/readme.md"]]);
      return "";
    };
    return { run, calls, cwds };
  }

  const ctx = (run: Run) => ({
    cfg,
    adapter,
    gate,
    store,
    run,
    ensureRepoDir: async () => REPO_DIR,
  });

  it("the gate SEES the push_branch intent, and the git push runs from inside it — in the reviewed clone", async () => {
    const { run, calls, cwds } = liveRunner();
    const out = await fileImprovementPr(
      {
        branch: "wip/docs",
        title: "Docs: clarify retry",
        body: "rationale",
        slug: "clarify-retry",
      },
      ctx(run),
    );

    expect(out).toMatchObject({ ok: true, pushed: true, dry_run: false });
    // The bypass this pins: a live push that skips the gate leaves
    // `push_branch` out of this list, which would begin at `create_pull`.
    expect(seen).toEqual(["push_branch", "create_pull", "add_label"]);
    const push = calls.find((c) => c[0] === "push");
    expect(push).toEqual(["push", "origin", `${TIP}:refs/heads/bot/improve-clarify-retry`]);
    // The push, like every other step, runs where `origin` is the reviewed
    // repo.
    expect(cwds).toEqual([REPO_DIR, REPO_DIR, REPO_DIR, REPO_DIR]);
    expect(
      store.eventsOn(new Date().toISOString().slice(0, 10)).some((e) => e.kind === "branch_pushed"),
    ).toBe(true);
  });

  it("a label failure after the PR opened still records the filing — the cap slot is spent, the caller told it filed", async () => {
    const { run } = liveRunner();
    gate = new MutationGate(false, join(dir, "dryrun"), async (i) => {
      if (i.kind === "add_label") throw new Error("HTTP 502 on add_label");
      return { number: 4242 };
    });
    adapter = new GitHubAdapter(cfg, fakeMinter, gate, (async () => {
      throw new Error("no direct fetch expected");
    }) as unknown as typeof fetch);
    const out = await fileImprovementPr(
      {
        branch: "wip/docs",
        title: "Docs: clarify retry",
        body: "rationale",
        slug: "clarify-retry",
      },
      ctx(run),
    );

    // The PR exists on GitHub: the outcome and the ledger must both say so.
    expect(out).toMatchObject({ ok: true, pr: 4242 });
    expect(String(out.label_warning)).toContain("502");
    expect(store.filedSince("improvement_pr", "1970-01-01T00:00:00.000Z")).toBe(1);
    // …so the day's 1/day slot is spent and a second filing is refused.
    expect(improvementRateReason(store, cfg.caps, new Date())).toContain("day cap");
    expect(
      store
        .eventsOn(new Date().toISOString().slice(0, 10))
        .some((e) => e.kind === "improvement_pr_label_failed"),
    ).toBe(true);
  });

  // selfscan 336e43a6: a POST GitHub may have carried out — a 5xx, a dropped
  // connection, an undecodable body — throws before the ledger row. Freeing
  // the slot let a second slug open a second PR the same day. An ambiguous
  // creation keeps its cap charge; only a definite 4xx refusal frees it.
  const liveWith = (fail: (kind: string) => Error | null): void => {
    gate = new MutationGate(false, join(dir, "dryrun"), async (i) => {
      const err = fail(i.kind);
      if (err) throw err;
      return { number: 4242 };
    });
    adapter = new GitHubAdapter(cfg, fakeMinter, gate, (async () => {
      throw new Error("no direct fetch expected");
    }) as unknown as typeof fetch);
    vi.spyOn(adapter, "listOpenBotIssues").mockResolvedValue([]);
  };
  const today = "1970-01-01T00:00:00.000Z";

  for (const [label, err] of [
    ["a 5xx", new GitHubRequestError("POST", "/repos/o/r/pulls", 502, "bad gateway")],
    ["a dropped connection", new TypeError("fetch failed")],
    ["an undecodable body", new SyntaxError("Unexpected end of JSON input")],
  ] as const) {
    it(`an ambiguous create_pull failure (${label}) keeps the cap slot charged`, async () => {
      liveWith((k) => (k === "create_pull" ? err : null));
      const { run } = liveRunner();
      const out = await fileImprovementPr(
        {
          branch: "wip/docs",
          title: "Docs: clarify retry",
          body: "rationale",
          slug: "clarify-retry",
        },
        ctx(run),
      );
      expect(out.ok).toBe(false);
      expect(String(out.reason)).toContain("outcome unknown");
      expect(store.filedSince("improvement_pr", today)).toBe(1);
      expect(improvementRateReason(store, cfg.caps, new Date())).toContain("day cap");
    });

    it(`an ambiguous create_issue failure (${label}) keeps the cap slot charged`, async () => {
      liveWith((k) => (k === "create_issue" ? err : null));
      const out = await fileIssue(
        { title: "Retry loop misses jitter", body: "e" },
        { cfg, adapter, gate, store },
      );
      expect(out.ok).toBe(false);
      expect(String(out.reason)).toContain("outcome unknown");
      expect(store.filedSince("issue", today)).toBe(1);
    });
  }

  it("a definite 4xx refusal of create_pull / create_issue frees the slot — nothing was created", async () => {
    liveWith((k) =>
      k === "create_pull" || k === "create_issue"
        ? new GitHubRequestError("POST", "/repos/o/r/x", 422, "Validation Failed")
        : null,
    );
    const { run } = liveRunner();
    const pr = await fileImprovementPr(
      {
        branch: "wip/docs",
        title: "Docs: clarify retry",
        body: "rationale",
        slug: "clarify-retry",
      },
      ctx(run),
    );
    expect(pr.ok).toBe(false);
    expect(store.filedSince("improvement_pr", today)).toBe(0);
    const issue = await fileIssue(
      { title: "Retry loop misses jitter", body: "e" },
      { cfg, adapter, gate, store },
    );
    expect(issue.ok).toBe(false);
    expect(String(issue.reason)).toContain("422");
    expect(store.filedSince("issue", today)).toBe(0);
  });

  it("the slot is charged while the create request is in flight — a daemon dying there still has it spent", async () => {
    let inFlight: { pr: number; issue: number } | null = null;
    gate = new MutationGate(false, join(dir, "dryrun"), async (i) => {
      if (i.kind === "create_pull" || i.kind === "create_issue")
        inFlight = {
          pr: store.filedSince("improvement_pr", today),
          issue: store.filedSince("issue", today),
        };
      return { number: 4242 };
    });
    adapter = new GitHubAdapter(cfg, fakeMinter, gate, (async () => {
      throw new Error("no direct fetch expected");
    }) as unknown as typeof fetch);
    vi.spyOn(adapter, "listOpenBotIssues").mockResolvedValue([]);
    const { run } = liveRunner();
    const pr = await fileImprovementPr(
      {
        branch: "wip/docs",
        title: "Docs: clarify retry",
        body: "rationale",
        slug: "clarify-retry",
      },
      ctx(run),
    );
    expect(pr).toMatchObject({ ok: true, pr: 4242 });
    expect(inFlight).toEqual({ pr: 1, issue: 0 });
    const issue = await fileIssue(
      { title: "Retry loop misses jitter", body: "e" },
      { cfg, adapter, gate, store },
    );
    expect(issue.ok).toBe(true);
    expect(inFlight).toEqual({ pr: 1, issue: 1 });
    // one slot each, settled with what GitHub created — never a second row
    expect(store.filedSince("improvement_pr", today)).toBe(1);
    expect(store.filedSince("issue", today)).toBe(1);
  });

  it("a guard refusal stops the push AND the PR — no branch, no pull", async () => {
    const { run, calls } = liveRunner();
    gate.setGuard({
      before: async (i) => {
        seen.push(i.kind);
        return i.kind === "push_branch" ? { block: "pr-closed" } : {};
      },
    });
    const out = await fileImprovementPr(
      {
        branch: "wip/docs",
        title: "Docs: clarify retry",
        body: "rationale",
        slug: "clarify-retry",
      },
      ctx(run),
    );

    expect(out.ok).toBe(false);
    expect(out.reason).toContain("gate refused");
    expect(calls.map((c) => c[0])).not.toContain("push");
    expect(seen).toEqual(["push_branch"]); // never reached create_pull
  });
});
