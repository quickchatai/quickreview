import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseConfig, type Config } from "../src/config.js";
import { MutationGate } from "../src/gate.js";
import { GitHubAdapter } from "../src/github.js";
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
  issueRateReason,
  jaccard,
  normalizeTitleTokens,
  parseNumstat,
  type Run,
} from "../src/improvements.js";

const cfg: Config = parseConfig(readFileSync(join(process.cwd(), "tests/fixtures/config.toml"), "utf8"));

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
    for (const p of ["src/a.ts", "docs/readme.md", "tests/x.test.ts", "environment/config.ts", "src/migrationsHelper.ts"]) {
      expect(deniedPath(p), p).toBe(false);
    }
  });

  it("accepts exactly 50 changed lines and rejects 51", () => {
    expect(checkDiffstat(parseNumstat(numstat([[30, 20, "src/a.ts"]])), cfg.caps)).toMatchObject({ ok: true, lines: 50 });
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
    // Custom list: migrations/ no longer denied, db/ is.
    const caps = { ...cfg.caps, improvement_pr_deny_prefixes: ["db/"] };
    expect(checkDiffstat(parseNumstat(numstat([[1, 0, "migrations/0001.sql"]])), caps).ok).toBe(true);
    const denied = checkDiffstat(parseNumstat(numstat([[1, 0, "db/schema.sql"]])), caps);
    expect(denied.ok).toBe(false);
    expect(denied.reason).toContain("path denylist");
    // deniedPath honours the same override…
    expect(deniedPath("migrations/0001.sql", ["db/"])).toBe(false);
    expect(deniedPath("db/schema.sql", ["db/"])).toBe(true);
    // …and .env-named files are refused whatever the list says.
    expect(deniedPath(".env.production", [])).toBe(true);
    expect(checkDiffstat(parseNumstat(numstat([[1, 0, "app/.env.local"]])), { ...cfg.caps, improvement_pr_deny_prefixes: [] }).ok).toBe(false);
    // The fixture (which omits the knob) parses to the shipped default list.
    expect(cfg.caps.improvement_pr_deny_prefixes).toEqual(["migrations/", "infra/", "ansible/", ".github/workflows/"]);
  });

  it("rejects an empty diff and binary files", () => {
    expect(checkDiffstat([], cfg.caps).ok).toBe(false);
    expect(checkDiffstat(parseNumstat("-\t-\tx.png"), cfg.caps).reason).toContain("binary");
  });
});

describe("rate caps from StateStore.filedSince", () => {
  it("blocks the second improvement PR of the day and the fourth of the week", () => {
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
});

describe("issue dedup — normalized-token Jaccard", () => {
  it("normalizes and scores", () => {
    expect([...normalizeTitleTokens("Fix: the Flaky, retry-loop!")]).toEqual(["fix", "the", "flaky", "retry", "loop"]);
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

describe("fileImprovementPr / fileIssue (dry-run)", () => {
  let dir: string;
  let store: StateStore;
  let gate: MutationGate;
  let adapter: GitHubAdapter;
  let openIssues: Array<{ number: number; title: string }>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "qcr-improve-"));
    store = new StateStore(":memory:");
    gate = new MutationGate(true, join(dir, "dryrun"), async () => {
      throw new Error("executor must not run in dry-run");
    });
    openIssues = [];
    const fetchFn = (async (url: string) => {
      if (String(url).includes("/search/issues")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ items: openIssues.map((i) => ({ ...i, user: { login: "x", type: "Bot" }, updated_at: "", created_at: "" })) }),
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

  function runner(diff: string): { run: Run; calls: string[][] } {
    const calls: string[][] = [];
    const run: Run = async (args) => {
      calls.push(args);
      if (args[0] === "diff") return diff;
      if (args[0] === "push") throw new Error("must not push in dry-run");
      return "";
    };
    return { run, calls };
  }

  it("happy path: gated push_branch + create_pull + add_label, recorded, worktree cleaned", async () => {
    const { run, calls } = runner(numstat([[10, 5, "docs/readme.md"]]));
    const out = await fileImprovementPr(
      { branch: "wip/docs", title: "Docs: clarify retry", body: "rationale\n\norigin: #12", slug: "clarify-retry" },
      { cfg, adapter, gate, store, run, scratchDir: join(dir, "scratch") },
    );
    expect(out).toMatchObject({ ok: true, branch: "bot/improve-clarify-retry", files: 1, lines: 15, pushed: false, dry_run: true });

    const kinds = intents().map((i) => i.kind);
    expect(kinds).toEqual(["push_branch", "create_pull", "add_label"]);
    const push = intents()[0];
    expect(push.method).toBe("git");
    expect(push.body.target).toBe("bot/improve-clarify-retry");
    // base = the fixture's [github] base_branch — no more hardcoded master.
    expect(intents()[1].body).toMatchObject({ head: "bot/improve-clarify-retry", base: cfg.github.base_branch, title: "Docs: clarify retry" });
    expect(cfg.github.base_branch).toBe("main");
    expect(intents()[2].body.labels).toEqual([cfg.github.improvement_label]);

    expect(store.filedSince("improvement_pr", "1970-01-01T00:00:00.000Z")).toBe(1);
    expect(calls.map((c) => c[0])).toEqual(["fetch", "worktree", "diff", "worktree"]);
    expect(calls.at(-1)).toContain("remove");
  });

  it("rejects over-cap lines with a reason, files nothing", async () => {
    const { run } = runner(numstat([[40, 11, "src/a.ts"]]));
    const out = await fileImprovementPr(
      { branch: "wip/big", title: "t", body: "b", slug: "big" },
      { cfg, adapter, gate, store, run, scratchDir: join(dir, "scratch") },
    );
    expect(out.ok).toBe(false);
    expect(out.reason).toContain("51 changed lines");
    expect(readdirSync(dir)).not.toContain("dryrun");
    expect(store.filedSince("improvement_pr", "1970-01-01T00:00:00.000Z")).toBe(0);
    expect(store.eventsOn(new Date().toISOString().slice(0, 10)).some((e) => e.kind === "improvement_pr_rejected")).toBe(true);
  });

  it("rejects a denylisted path and a 4-file diff", async () => {
    const denied = await fileImprovementPr(
      { branch: "wip/x", title: "t", body: "b", slug: "x" },
      { cfg, adapter, gate, store, run: runner(numstat([[1, 0, "infra/main.tf"]])).run, scratchDir: join(dir, "s1") },
    );
    expect(denied.reason).toContain("path denylist");
    const many = await fileImprovementPr(
      { branch: "wip/y", title: "t", body: "b", slug: "y" },
      {
        cfg,
        adapter,
        gate,
        store,
        run: runner(
          numstat([
            [1, 0, "a.ts"],
            [1, 0, "b.ts"],
            [1, 0, "c.ts"],
            [1, 0, "d.ts"],
          ]),
        ).run,
        scratchDir: join(dir, "s2"),
      },
    );
    expect(many.reason).toContain("4 files changed");
  });

  it("rejects when the day cap is already spent (before touching git)", async () => {
    store.recordFiledItem("improvement_pr", "already", "#1");
    const { run, calls } = runner(numstat([[1, 0, "a.ts"]]));
    const out = await fileImprovementPr(
      { branch: "wip/x", title: "t", body: "b", slug: "x" },
      { cfg, adapter, gate, store, run, scratchDir: join(dir, "scratch") },
    );
    expect(out.ok).toBe(false);
    expect(out.reason).toContain("day cap");
    expect(calls).toHaveLength(0);
  });

  it("rejects a bad slug", async () => {
    const { run } = runner("");
    const out = await fileImprovementPr(
      { branch: "wip/x", title: "t", body: "b", slug: "Bad Slug" },
      { cfg, adapter, gate, store, run, scratchDir: join(dir, "scratch") },
    );
    expect(out.ok).toBe(false);
    expect(out.reason).toContain("bad slug");
    expect(botBranchFor("ok-slug")).toBe("bot/improve-ok-slug");
  });

  it("files an issue in dry-run with the bot-filed label and records it", async () => {
    const out = await fileIssue({ title: "Retry loop misses jitter", body: "evidence" }, { cfg, adapter, gate, store });
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
    const out = await fileIssue({ title: "brand new topic entirely", body: "b" }, { cfg, adapter, gate, store });
    expect(out.ok).toBe(false);
    expect(out.reason).toContain("issue day cap");
    expect(spy).not.toHaveBeenCalled();
  });

  // a deferral's ticket rides THIS path — no second writer, no new
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
      const out = await fileIssue({ title: "brand new topic", body: "b", pr: 5314 }, { cfg, adapter, gate, store });
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
      const out = await fileIssue({ title: "brand new topic", body: "b" }, { cfg, adapter, gate, store });
      expect(out.ok).toBe(false);
      expect(store.anomalies()).toHaveLength(0);
    });
  });
});
