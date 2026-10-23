// Golden prompts: master's bench renderers, recorded. `renderCasePrompts`
// (src/bench/runner.ts) is the production round renderer run offline over a
// case, with `renderFollowUpPrompts` behind it for a follow-up case. The
// distribution refactor moves where prompts are built and delivered; this file
// pins what master built, byte for byte: the system prompt, the round order,
// the lens plan, the lens task files and every other file the order names.
//
// Test-only, no model. The first-round scenarios render the committed
// smoke10 cases over a synthetic prefetch (the shape bench-aacr.test.ts uses);
// the follow-up scenarios replay a scratch repo exactly as bench-followup.test.ts
// does, with fixed commit dates so the shas in the prompts are stable.
//
// A deliberate prompt change (a ratified reseed, a template edit) updates the
// fixtures in the same commit: `UPDATE_GOLDEN=1 npx vitest run tests/golden-prompts.test.ts`,
// then review the diff under tests/fixtures/golden-prompts/.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
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
import { dirname, join, relative, resolve } from "node:path";

vi.stubEnv("GIT_ALLOW_PROTOCOL", "file");

const ROOT = resolve(import.meta.dirname, "..");
vi.stubEnv("QCR_CONFIG", join(ROOT, "tests", "fixtures", "config.toml"));
const GOLDEN = join(ROOT, "tests", "fixtures", "golden-prompts");
const UPDATE = process.env.UPDATE_GOLDEN === "1";

const { parseCaseSet } = await import("../src/bench/aacr.js");
type BenchCase = import("../src/bench/aacr.js").BenchCase;
type PrefetchMeta = import("../src/bench/aacr.js").PrefetchMeta;
type CasePrompts = import("../src/bench/runner.js").CasePrompts;
const { prefetchCase, storeDir } = await import("../src/bench/prefetch.js");
const { benchConfig, prepareTree, renderCasePrompts } = await import("../src/bench/runner.js");

/** The fixtures pin the NATIVE route's bytes (`subagent` / `launch_plan`). The
 * SDK engine is the config default, so the golden configs say native outright. */
const pinNativeLens = (cfg: { pi: { lens_runtime: string; engine_wave: boolean } }): void => {
  cfg.pi.lens_runtime = "native";
  cfg.pi.engine_wave = false;
};
const { benchDelta } = await import("../src/bench/followup.js");
const { ecosystemFor } = await import("@quickchatai/pi-quickreview/src/ecosystem.js");

const SMOKE = parseCaseSet(
  JSON.parse(readFileSync(join(ROOT, "bench", "aacr", "sets", "smoke10.json"), "utf8")),
);

/** The tree and case dir every prompt names; the scratch tree is rewritten to it. */
const TREE = "/opt/quickreview/sandbox/wt/x";
const CASE_DIR = "/bench-out/cases/x";

const tmp = mkdtempSync(join(tmpdir(), "golden-prompts-"));
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

/** One scenario's recording: every file a case's prompts consist of, by a
 * stable name — system.md, order.md, plan.json, then each file the order
 * names under files/ at its path below the case dir. */
function recordingOf(p: CasePrompts, scrub: (s: string) => string = (s) => s): Map<string, string> {
  const out = new Map<string, string>();
  out.set("system.md", scrub(p.system));
  out.set("order.md", scrub(p.order));
  out.set(
    "plan.json",
    JSON.stringify(
      {
        plannedLenses: p.plannedLenses,
        passPlan: p.passPlan,
        sweepPlan: p.sweepPlan ?? null,
        followUp: p.followUp ?? null,
      },
      null,
      2,
    ) + "\n",
  );
  const named = [
    ...(p.contextPack ? [p.contextPack] : []),
    ...p.taskFiles,
    ...(p.extraFiles ?? []),
  ];
  for (const f of named) {
    expect(f.path.startsWith(`${CASE_DIR}/`), f.path).toBe(true);
    out.set(join("files", relative(CASE_DIR, f.path)), scrub(f.text));
  }
  return out;
}

function listFiles(dir: string, base = dir): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? listFiles(join(dir, e.name), base) : [relative(base, join(dir, e.name))],
  );
}

/** Compare a recording to tests/fixtures/golden-prompts/<name>/ — or rewrite it. */
function expectGolden(name: string, rec: Map<string, string>): void {
  const dir = join(GOLDEN, name);
  if (UPDATE) {
    rmSync(dir, { recursive: true, force: true });
    for (const [file, text] of rec) {
      mkdirSync(dirname(join(dir, file)), { recursive: true });
      writeFileSync(join(dir, file), text);
    }
  }
  expect(listFiles(dir).sort(), `${name}: the recorded file set`).toEqual([...rec.keys()].sort());
  for (const [file, text] of rec)
    expect(text, `${name}/${file}`).toBe(readFileSync(join(dir, file), "utf8"));
}

const META_OF = (c: BenchCase, title: string, body: string): PrefetchMeta => ({
  instance_id: c.instance_id,
  repo: c.repo,
  pr: c.pr,
  base_commit: c.base_commit,
  head_commit: c.head_commit,
  merge_base: "c".repeat(40),
  base_ref: "master",
  base_ref_source: "github-api",
  title,
  body,
  depth: 50,
  diff: { files: 2, additions: 60, deletions: 5 },
  fetched_at: "2026-09-25T00:00:00Z",
});

const file = (filename: string, additions: number, deletions: number, status = "modified") => ({
  filename,
  additions,
  deletions,
  status,
});

describe("the first round a bench case runs (renderCasePrompts)", () => {
  const first = (
    index: number,
    over: {
      files: ReturnType<typeof file>[];
      ecosystem?: "none" | "django";
      profile?: string;
      review?: Record<string, unknown>;
      dependencyNote?: string;
      body?: string;
    },
  ): Map<string, string> => {
    const c = SMOKE.cases[index]!;
    const cfg = benchConfig(over.profile ?? "");
    pinNativeLens(cfg);
    Object.assign(cfg.review, over.review ?? {});
    return recordingOf(
      renderCasePrompts({
        root: ROOT,
        cfg,
        ecosystem: ecosystemFor(over.ecosystem ?? "none"),
        c,
        meta: META_OF(
          c,
          "Enforce all pyflake lint rules",
          over.body ?? "A body long enough to be a body.",
        ),
        tree: TREE,
        caseDir: CASE_DIR,
        files: over.files,
        issuedAt: "2026-09-25T00:00:00Z",
        ...(over.dependencyNote ? { dependencyNote: over.dependencyNote } : {}),
      }),
    );
  };

  it("a plain Python change under the production config", () => {
    expectGolden(
      "first-python",
      first(0, {
        files: [file("comfy/model.py", 40, 5), file("tests/test_model.py", 20, 0, "added")],
      }),
    );
  });

  it("a Django change, with the Django ecosystem and the example Django profile", () => {
    expectGolden(
      "first-django",
      first(1, {
        ecosystem: "django",
        profile: "example-django",
        files: [
          file("shop/models.py", 30, 2),
          file("shop/migrations/0007_add_sku.py", 18, 0, "added"),
          file("shop/views.py", 22, 9),
          file("shop/templates/shop/detail.html", 6, 1),
          file("shop/tests/test_views.py", 40, 0, "added"),
        ],
      }),
    );
  });

  it("a TypeScript change with agent directives, a workflow, a manifest and third-party sources", () => {
    expectGolden(
      "first-directives",
      first(2, {
        files: [
          file("CLAUDE.md", 4, 1),
          file("src/api/client.ts", 55, 12),
          file("src/api/client.test.ts", 30, 0, "added"),
          file(".github/workflows/ci.yml", 8, 2),
          file("package.json", 3, 1),
        ],
        dependencyNote: "THIRD-PARTY SOURCES\n- left-pad 1.3.0 at /deps/left-pad (read-only)\n",
      }),
    );
  });

  it("a long, multi-byte PR body is bounded before it reaches the prompts", () => {
    expectGolden(
      "first-long-body",
      first(3, {
        files: [file("lib/parser.py", 44, 3), file("lib/lexer.py", 12, 12)],
        body: "字".repeat(10_000),
      }),
    );
  });

  it("with the context pack on, the pack is rendered beside the task files", () => {
    const rec = first(0, {
      files: [file("comfy/model.py", 40, 5), file("tests/test_model.py", 20, 0, "added")],
      review: { context_pack: "pack-first" },
    });
    expect([...rec.keys()].some((k) => k.endsWith("context-pack.md"))).toBe(true);
    expectGolden("first-context-pack", rec);
  });

  it("task files off: the order carries no task-file rows", () => {
    expectGolden(
      "first-no-task-files",
      first(0, {
        files: [file("comfy/model.py", 40, 5), file("tests/test_model.py", 20, 0, "added")],
        review: { task_files: false },
      }),
    );
  });
});

describe("the follow-up round a bench case runs (renderFollowUpPrompts)", () => {
  // Fixed dates: a commit's sha is a function of its content, parents, author
  // and dates, and the prompts name the shas.
  const DATE = "2026-01-02T03:04:05Z";
  const ENV = {
    ...process.env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@t",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@t",
    GIT_AUTHOR_DATE: DATE,
    GIT_COMMITTER_DATE: DATE,
  };
  const git = (dir: string, ...args: string[]): string =>
    execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", env: ENV }).trim();

  // Upstream: main B0 <- B1. The PR forks at B0: P1 (round 1) adds b.py; the
  // author merges main and fixes one line (P3). Round 2 reviews P1..P3.
  const upstream = join(tmp, "upstream");
  const B_PY = Array.from({ length: 10 }, (_, i) => `y${i} = ${i}`).join("\n") + "\n";
  let B1 = "";
  let P1 = "";
  let P3 = "";

  const followCase = (over: Partial<NonNullable<BenchCase["followup"]>> = {}): BenchCase => ({
    instance_id: `acme__app-7-r2@${P3.slice(0, 7)}`,
    repo: "acme/app",
    pr: 7,
    pr_url: "local://acme/app/7",
    base_commit: B1,
    head_commit: P3,
    language: "Python",
    pr_category: "follow-up",
    change_line_count: 10,
    references: 0,
    title: "Add b",
    body: "Adds b.py with ten settings.",
    base_ref: "main",
    followup: {
      prev_head: P1,
      round_no: 2,
      review_no: 2,
      sweep_owed: true,
      prior_findings: [
        {
          ref: "1:k-b3",
          round_no: 1,
          finding_key: "k-b3",
          path: "b.py",
          line: 4,
          severity: "P1",
          posted_as: "[blocker]",
          lens_ids: ["pass-baseline"],
          title: "y3 is wrong",
          reason: "y3 must be 33",
          evidence: "b.py:4",
        },
        {
          ref: "1:k-nit",
          round_no: 1,
          finding_key: "k-nit",
          path: "b.py",
          line: 1,
          severity: "P3",
          posted_as: "[nit]",
          lens_ids: [],
          title: "naming",
          reason: null,
          evidence: null,
        },
      ],
      ledger: "LEDGER PR #7 round 1\nOPEN: b.py:4 y3\nSETTLED: naming is fine\n",
      ...over,
    },
  });

  const cfg = benchConfig("");
  pinNativeLens(cfg);
  const files = [file("b.py", 10, 0, "added")];
  let meta: PrefetchMeta;
  let tree: string;

  beforeAll(async () => {
    mkdirSync(upstream);
    git(upstream, "init", "--quiet", "-b", "main");
    const commit = (name: string, text: string, msg: string): string => {
      writeFileSync(join(upstream, name), text);
      git(upstream, "add", name);
      git(upstream, "commit", "--quiet", "-m", msg);
      return git(upstream, "rev-parse", "HEAD");
    };
    const B0 = commit("a.py", "x = 1\n", "base zero");
    B1 = commit("a.py", "x = 2\n", "base one");
    git(upstream, "checkout", "--quiet", "-b", "pr", B0);
    P1 = commit("b.py", B_PY, "first try");
    git(upstream, "merge", "--quiet", "--no-edit", "main");
    P3 = commit("b.py", B_PY.replace("y3 = 3", "y3 = 33"), "address review");
    git(upstream, "checkout", "--quiet", "main");

    const c = followCase();
    meta = await prefetchCase(c, {
      store: join(tmp, "store"),
      remoteFor: () => join(tmp, "no-such-remote"),
      mirrors: new Map([["acme/app", upstream]]),
      mirrorOnly: true,
    });
    tree = join(tmp, "wt", "x");
    await prepareTree(storeDir(join(tmp, "store"), c), tree, meta);
  });

  const scrub = (s: string): string => s.replaceAll(tree, TREE);

  const render = async (
    c: BenchCase,
    over: Partial<typeof cfg.review> = {},
    delta: "computed" | "none" | "old-head-missing" = "computed",
  ): Promise<Map<string, string>> =>
    recordingOf(
      renderCasePrompts({
        root: ROOT,
        cfg: { ...cfg, review: { ...cfg.review, ...over } },
        ecosystem: ecosystemFor("none"),
        c,
        meta,
        tree,
        caseDir: CASE_DIR,
        files,
        issuedAt: "2026-10-08T00:00:00Z",
        ...(delta === "computed"
          ? { followUpDelta: await benchDelta(tree, c, meta) }
          : delta === "old-head-missing"
            ? { followUpDelta: { ok: false as const, reason: "old-head-missing" as const } }
            : {}),
      }),
      scrub,
    );

  it("the delta round: changed lines, prior findings, the ledger and the owed sweep", async () => {
    const rec = await render(followCase());
    expect(rec.get("order.md")).toContain("PRE-APPROVAL SWEEP — owed this round");
    expect(rec.get("order.md")).toContain("THE CHANGE SINCE THE LAST REVIEW");
    expectGolden("followup-delta-sweep", rec);
  });

  it("the delta round with no sweep owed", async () => {
    expectGolden("followup-delta-no-sweep", await render(followCase({ sweep_owed: false })));
  });

  it("a doubt is a full re-review: follow_up = full", async () => {
    expectGolden("followup-full-config", await render(followCase(), { follow_up: "full" }));
  });

  it("a doubt is a full re-review: no delta adapter", async () => {
    expectGolden("followup-full-no-adapter", await render(followCase(), {}, "none"));
  });

  it("a doubt is a full re-review: the old head is missing", async () => {
    expectGolden(
      "followup-full-old-head-missing",
      await render(followCase(), {}, "old-head-missing"),
    );
  });
});
