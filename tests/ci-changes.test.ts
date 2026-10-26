// CI's routing (.github/ci/changes.mjs, and the `changes` and `ci` jobs in
// .github/workflows/ci.yml). What is pinned here, with no runner and no git
// beyond `git ls-files`:
//   - classify: which jobs each kind of change needs, unknown changes running
//     everything;
//   - the image rule agrees with the Dockerfile: every path it COPYs from the
//     checkout is in the build context the dockerignore admits;
//   - DOCS_SUITE: a test that names a docs file is in it, or says why not;
//   - gate: the one required check fails on a failed, cancelled or wrongly
//     skipped job;
//   - the workflow: the gate needs every job, runs even when one failed, every
//     classify key is a job output, and the repo settings require the gate alone.
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { classify, dockerContext, DOCS_SUITE, gate, isDocs } from "../.github/ci/changes.mjs";

interface Route {
  full: boolean;
  lint: boolean;
  image: boolean;
  clone: boolean;
}
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string): string => readFileSync(join(root, rel), "utf8");
const dockerignore = read("docker/Dockerfile.dockerignore");
const route = (paths: string[] | null): Route => classify(paths, { dockerignore });
const ALL: Route = { full: true, lint: true, image: true, clone: true };

describe("classify", () => {
  // MUTATION: drop `/^[^/]+\.md$/` from isDocs — the root-prose case fails.
  it("a docs-only change runs the docs tests alone", () => {
    const pr11 = [
      "AGENTS.md",
      "CONTEXT.md",
      "docs/adr/0001-plugin-and-app-nest.md",
      "docs/adr/README.md",
    ];
    expect(route(pr11)).toEqual({ full: false, lint: false, image: false, clone: false });
    expect(
      route([".github/pull_request_template.md", "memory/README.md", "docs/media/a.gif"]),
    ).toEqual({
      full: false,
      lint: false,
      image: false,
      clone: false,
    });
  });

  // MUTATION: make isDocs accept any `.md` — the prompts and src cases fail.
  it("Markdown inside a code or data directory is not docs", () => {
    for (const p of [
      "prompts/round-first.md",
      "src/README.md",
      "tests/AGENTS.md",
      "packages/pi-plugin/README.md",
    ])
      expect(isDocs(p), p).toBe(false);
    expect(route(["prompts/round-first.md"])).toEqual({
      full: true,
      lint: false,
      image: true,
      clone: true,
    });
  });

  // MUTATION: drop `.github/ci/changes.mjs` from ROUTING — the second case fails.
  it("a change to the routing itself, or an unknown change, runs everything", () => {
    expect(route([".github/workflows/ci.yml"])).toEqual(ALL);
    expect(route([".github/ci/changes.mjs"])).toEqual(ALL);
    expect(route(["README.md", ".github/workflows/ci.yml"])).toEqual(ALL);
    expect(route([])).toEqual(ALL);
    expect(route(null)).toEqual(ALL);
  });

  it("code runs every job; dependencies too", () => {
    expect(route(["src/daemon.ts"])).toEqual(ALL);
    expect(route(["packages/pi-plugin/src/gate.ts"])).toEqual(ALL);
    expect(route(["package-lock.json"])).toEqual(ALL);
  });

  // MUTATION: drop the `tests/` row from NOT_CLONE — clone turns true and this fails.
  it("tests run the build, the suite and lint, never the image or the clone", () => {
    expect(route(["tests/gate.test.ts"])).toEqual({
      full: true,
      lint: true,
      image: false,
      clone: false,
    });
    expect(route(["tests/fixtures/seed-manifest.json"])).toEqual(ALL);
  });

  it("each smoke script runs its own job", () => {
    expect(route([".github/ci/image-smoke.sh"])).toEqual({
      full: true,
      lint: false,
      image: true,
      clone: false,
    });
    expect(route([".github/ci/clone-smoke.sh"])).toEqual({
      full: true,
      lint: false,
      image: false,
      clone: true,
    });
    expect(route(["docker/Dockerfile"]).image).toBe(true);
    expect(route(["docker/memory/Dockerfile"]).image).toBe(false);
  });

  // MUTATION: drop `ya?ml` from LINTED — prettier's yml would go unchecked and this fails.
  it("lint runs for what eslint or prettier reads", () => {
    expect(route(["docs/action/qcr-review.yml"])).toEqual({
      full: true,
      lint: true,
      image: false,
      clone: false,
    });
    expect(route([".prettierignore"]).lint).toBe(true);
    expect(route(["scripts/qcr"]).lint).toBe(false);
  });

  it("a path no rule names still runs the suite and the clone", () => {
    expect(route(["brand-new/thing"])).toEqual({
      full: true,
      lint: false,
      image: false,
      clone: true,
    });
  });
});

describe("the image rule reads the dockerignore", () => {
  const inImage = dockerContext(dockerignore);

  // MUTATION: make a `!` line exclude instead of admit — every inside case fails.
  it("admits the allowlist and nothing else", () => {
    for (const p of [
      "src/daemon.ts",
      "packages/pi-plugin/src/gate.ts",
      "deploy/reviewer/AGENTS.override.md",
      "tests/fixtures/seed-manifest.json",
      "docker/tunnel/run.sh",
      "config.example.toml",
    ])
      expect(inImage(p), p).toBe(true);
    for (const p of [
      "docs/tui.md",
      ".github/workflows/release.yml",
      "packages/pi-plugin/dist/gate.js",
      "src/CLAUDE.md",
      "src/node_modules/x/index.js",
      "tests/gate.test.ts",
      "deploy/ansible/site.yml",
      "README.md",
    ])
      expect(inImage(p), p).toBe(false);
  });

  // MUTATION: delete `!src` from docker/Dockerfile.dockerignore — `COPY src` fails here.
  it("every checkout path the Dockerfile COPYs is in the context", () => {
    const sources = read("docker/Dockerfile")
      .split("\n")
      .filter((l) => /^COPY\s/.test(l) && !/--from=/.test(l))
      .flatMap((l) => l.trim().split(/\s+/).slice(1, -1));
    expect(sources.length).toBeGreaterThan(10);
    const tracked = execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8" }).split("\n");
    for (const src of sources) {
      const file = tracked.find((t) => t === src || t.startsWith(`${src}/`));
      expect(file, `${src} is tracked`).toBeDefined();
      expect(inImage(file!), src).toBe(true);
    }
  });
});

describe("DOCS_SUITE", () => {
  const suite = DOCS_SUITE;

  it("lists test files that exist", () => {
    for (const f of suite) expect(existsSync(join(root, f)), f).toBe(true);
  });

  // A test names a docs file by its repo path, or joins the repo root with
  // `docs`. README.md and AGENTS.md are left out of the names: dozens of tests
  // use them as fixture file names. Each exemption says why the test does not
  // read this repository's docs.
  const EXEMPT: Record<string, string> = {
    "tests/quality-lenses.test.ts": "writes CONTRIBUTING.md and docs/ into a temp repo",
    "tests/setup-facts.test.ts": "CONTRIBUTING.md is a fake repo's file",
    "tests/setup-portrait.test.ts": "CONTRIBUTING.md is a fake repo's file",
    "tests/style-guide-sources.test.ts": "CONTRIBUTING.md is a fake repo's guide",
  };

  // MUTATION: remove tests/release-docs.test.ts from DOCS_SUITE — this fails.
  it("holds every test that reads this repository's docs", () => {
    const tracked = execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8" })
      .split("\n")
      .filter(Boolean);
    const docs = tracked.filter((p) => isDocs(p) && p !== "README.md" && p !== "AGENTS.md");
    const quoted = (p: string): RegExp =>
      new RegExp(`["'\`]${p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["'\`]`);
    const rootJoin = /\b(?:ROOT|root|REPO_ROOT|repoRoot)\s*,\s*["'`]docs["'`/]/;
    const readers = tracked.filter((t) => {
      if (!/^tests\/.*\.ts$/.test(t)) return false;
      const src = read(t);
      return rootJoin.test(src) || docs.some((d) => quoted(d).test(src));
    });
    expect(readers.length).toBeGreaterThan(5);
    for (const t of readers) expect(suite.includes(t) || t in EXEMPT, `${t} reads docs`).toBe(true);
    for (const t of Object.keys(EXEMPT)) expect(suite, t).not.toContain(t);
  });
});

describe("gate", () => {
  const verdict = gate;
  const ok = { result: "success" };
  const skipped = { result: "skipped" };
  const changes = (outputs: Record<string, string>) => ({ result: "success", outputs });

  it("passes when the needed jobs passed and the rest were skipped", () => {
    expect(
      verdict({
        changes: changes({ full: "false", lint: "false", image: "false", clone: "false" }),
        test: ok,
        lint: skipped,
        image: skipped,
        clone: skipped,
      }),
    ).toEqual([]);
    expect(
      verdict({
        changes: changes({ lint: "true", image: "true", clone: "true" }),
        test: ok,
        lint: ok,
        image: ok,
        clone: ok,
      }),
    ).toEqual([]);
  });

  // MUTATION: treat `skipped` as passing whatever `changes` said — this fails.
  it("fails a needed job that was skipped", () => {
    expect(
      verdict({
        changes: changes({ lint: "true" }),
        test: ok,
        lint: skipped,
        image: skipped,
        clone: skipped,
      }),
    ).toEqual(["lint: skipped (needed)"]);
  });

  // MUTATION: drop the `job === "test"` clause — a skipped test passes and this fails.
  it("always needs the test job", () => {
    expect(
      verdict({
        changes: changes({}),
        test: skipped,
        lint: skipped,
        image: skipped,
        clone: skipped,
      }),
    ).toEqual(["test: skipped (needed)"]);
  });

  it("fails on a failed or cancelled job, and on a failed classification", () => {
    expect(
      verdict({
        changes: changes({}),
        test: ok,
        lint: skipped,
        image: { result: "failure" },
        clone: skipped,
      }),
    ).toEqual(["image: failure"]);
    expect(
      verdict({
        changes: changes({}),
        test: { result: "cancelled" },
        lint: skipped,
        image: skipped,
        clone: skipped,
      }),
    ).toEqual(["test: cancelled (needed)"]);
    expect(verdict({ changes: { result: "failure" }, test: skipped })).toEqual([
      "changes: failure",
    ]);
    expect(verdict({})).toEqual(["changes: missing"]);
  });
});

describe("ci.yml — the routing", () => {
  const workflow = read(".github/workflows/ci.yml");
  const jobs = [...workflow.slice(workflow.indexOf("\njobs:\n")).matchAll(/^ {2}([\w-]+):$/gm)].map(
    (m) => m[1]!,
  );
  const job = (name: string): string => {
    const m = new RegExp(`^ {2}${name}:\\n([\\s\\S]*?)(?=^ {2}\\S|(?![\\s\\S]))`, "m").exec(
      workflow,
    );
    expect(m, `a \`${name}:\` job`).not.toBeNull();
    return m![1]!;
  };

  // MUTATION: add a job to ci.yml without listing it in the gate's needs — this fails.
  it("the gate needs every other job and runs even when one failed or was cancelled", () => {
    const gateJob = job("ci");
    const needs = /needs: \[([^\]]*)\]/
      .exec(gateJob)?.[1]
      ?.split(",")
      .map((s) => s.trim());
    expect(needs?.sort()).toEqual(jobs.filter((j) => j !== "ci").sort());
    expect(gateJob).toMatch(/if: \$\{\{ always\(\)/);
    expect(gateJob).toContain("node .github/ci/changes.mjs gate");
  });

  // MUTATION: drop the `image:` output line from the changes job — this fails.
  it("every classify key is a changes output, and each gated job reads its own", () => {
    const changesJob = job("changes");
    for (const key of Object.keys(route(["src/daemon.ts"])))
      expect(changesJob).toContain(`${key}: \${{ steps.classify.outputs.${key} }}`);
    for (const name of ["lint", "image", "clone"])
      expect(job(name)).toContain(`if: \${{ needs.changes.outputs.${name} == 'true' }}`);
    expect(job("test")).toContain("needs.changes.outputs.full");
  });

  // MUTATION: re-add `{ "context": "image" }` to the ruleset — this fails.
  it("the repository requires the gate alone, from GitHub Actions", () => {
    const settings = read(".github/repo-settings.sh");
    const contexts = [...settings.matchAll(/"context": "([^"]+)"/g)].map((m) => m[1]);
    expect(contexts).toEqual(["ci"]);
    expect(settings).toContain('{ "context": "ci", "integration_id": 15368 }');
  });
});
