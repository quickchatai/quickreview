// companion-guard — the companion's bright lines as tool_call
// vetoes. The interesting property is the NEGATIVE space: rule 6's frozen set
// is exactly the seed manifest, and the tight bash patterns must not veto the
// companion's ordinary work (commits, branch switches, stash list).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import activate, {
  bashBlockReason,
  frozenPaths,
  readSeedManifest,
  writeBlockReason,
  REGISTRY_FIXTURES,
} from "../extensions/companion-guard.js";

describe("bashBlockReason", () => {
  it("vetoes the rule-8 GitHub/deploy family", () => {
    expect(bashBlockReason("git push origin master")).toMatch(/rule 8/);
    expect(bashBlockReason("cd /workspace && git push")).toMatch(/rule 8/);
    expect(bashBlockReason("gh pr view 5362")).toMatch(/rule 8/);
    expect(bashBlockReason("./scripts/deploy.sh --dry-run")).toMatch(/rule 8/);
    expect(bashBlockReason("bash scripts/deploy.sh sync")).toMatch(/rule 8/);
  });

  it("still vetoes GitHub writes, the gate and deploy.sh with the read-only token in hand", () => {
    // The gate's shell route, by name — the companion holds no App key, and
    // these stay refused rather than merely failing.
    expect(bashBlockReason("bash scripts/post-review.sh 5362 1")).toMatch(/gate/);
    expect(bashBlockReason("/workspace/scripts/approve-pr.sh 1")).toMatch(/gate/);
    expect(bashBlockReason("scripts/reply-thread.sh 1 2 x")).toMatch(/gate/);
    expect(bashBlockReason("TOKEN=$(scripts/mint-token.sh)")).toMatch(/gate/);
    for (const cmd of [
      "./scripts/approve-pr.sh 1",
      "cd /workspace && scripts/approve-pr.sh 1",
      "true; bash -x scripts/post-review.sh 1 COMMENT b.md",
      "source scripts/mint-token.sh",
      ". scripts/mint-token.sh",
      "QCR_ROUND_NO=3 scripts/approve-pr.sh 1",
      "sudo -E env A=1 scripts/approve-pr.sh 1",
      "timeout 30 scripts/approve-pr.sh 1",
      "echo 1 | xargs scripts/approve-pr.sh",
      "find scripts -name x -exec scripts/approve-pr.sh {} \\;",
      "T=`scripts/mint-token.sh`",
      'eval "scripts/approve-pr.sh 1"',
      "(scripts/approve-pr.sh 1)",
    ]) {
      expect(bashBlockReason(cmd), cmd).toMatch(/gate/);
    }
    // Write-shaped API calls with the token: PUT/PATCH/DELETE, REST POST
    // (explicit or implied by a data flag), GraphQL mutations.
    const auth = 'curl -H "Authorization: Bearer $QCR_GITHUB_READ_TOKEN"';
    for (const cmd of [
      `${auth} -X PATCH https://api.github.com/repos/o/r/pulls/1 -d '{"state":"closed"}'`,
      `${auth} --request DELETE https://api.github.com/repos/o/r/issues/comments/9`,
      `${auth} -XPUT https://api.github.com/repos/o/r/pulls/1/merge`,
      `${auth} -X POST https://api.github.com/repos/o/r/issues`,
      `${auth} -d '{"body":"hi"}' https://api.github.com/repos/o/r/issues/1/comments`,
      `${auth} --json '{"event":"APPROVE"}' https://api.github.com/repos/o/r/pulls/1/reviews`,
      `${auth} -X POST https://api.github.com/graphql -d '{"query":"mutation { addComment(input:{}) { clientMutationId } }"}'`,
    ]) {
      expect(bashBlockReason(cmd), cmd).toMatch(/rule 8/);
    }
    // The other bright lines still hold.
    expect(bashBlockReason("gh api repos/o/r/pulls")).toMatch(/rule 8/);
    expect(bashBlockReason("git push")).toMatch(/rule 8/);
    expect(bashBlockReason("scripts/deploy.sh sync")).toMatch(/rule 8/);
  });

  it("lets the companion READ the gate's scripts — refused when run, never when read (2026-10-06)", () => {
    for (const cmd of [
      "git diff scripts/approve-pr.sh",
      "git diff -- scripts/approve-pr.sh tests/guards-shell-receipts.test.ts",
      "git log --oneline -5 -- scripts/post-review.sh",
      "cat scripts/approve-pr.sh",
      "sed -n 1,40p scripts/reply-thread.sh",
      "grep -n comments scripts/post-review.sh scripts/approve-pr.sh",
      "rg -n start_line scripts/approve-pr.sh",
      "git add scripts/approve-pr.sh && git commit -m '[companion] x'",
      "npx vitest run tests/guards-shell-receipts.test.ts # exercises approve-pr.sh",
    ]) {
      expect(bashBlockReason(cmd), cmd).toBeUndefined();
    }
  });

  it("lets the companion READ GitHub with its token", () => {
    const auth = 'curl -sH "Authorization: Bearer $QCR_GITHUB_READ_TOKEN"';
    expect(bashBlockReason(`${auth} https://api.github.com/repos/o/r/pulls/1`)).toBeUndefined();
    expect(
      bashBlockReason(`${auth} "https://api.github.com/repos/o/r/pulls?state=closed&per_page=100"`),
    ).toBeUndefined();
    // GraphQL queries go by POST — a query is a read.
    expect(
      bashBlockReason(
        `${auth} -X POST https://api.github.com/graphql -d '{"query":"{ repository(owner:"o",name:"r") { id } }"}'`,
      ),
    ).toBeUndefined();
    expect(bashBlockReason(`. "$QCR_GITHUB_READ_ENV" && echo "$QCR_GITHUB_REPO"`)).toBeUndefined();
  });

  it("vetoes the rule-11 discard family", () => {
    expect(bashBlockReason("git stash")).toMatch(/rule 11/);
    expect(bashBlockReason("git stash pop")).toMatch(/rule 11/);
    expect(bashBlockReason("git reset --hard HEAD~1")).toMatch(/rule 11/);
    expect(bashBlockReason("git reset -q --hard origin/master")).toMatch(/rule 11/);
    expect(bashBlockReason("git checkout -- src/tui/app.ts")).toMatch(/rule 11/);
    expect(bashBlockReason("git checkout .")).toMatch(/rule 11/);
    expect(bashBlockReason("git restore src/tui/app.ts")).toMatch(/rule 11/);
    expect(bashBlockReason("git clean -fd")).toMatch(/rule 11/);
  });

  it("stays out of the companion's ordinary way — tight patterns, no false vetoes", () => {
    expect(bashBlockReason('git commit -m "[companion] tweak"')).toBeUndefined();
    expect(bashBlockReason("git checkout -b bot/improve-x")).toBeUndefined();
    expect(bashBlockReason("git checkout master")).toBeUndefined();
    expect(bashBlockReason("git stash list")).toBeUndefined();
    expect(bashBlockReason("git stash show -p stash@{0}")).toBeUndefined();
    expect(bashBlockReason("git restore --staged src/tui/app.ts")).toBeUndefined();
    expect(bashBlockReason("git log --oneline -5")).toBeUndefined();
    // Words INSIDE other words or paths never trip the anchored patterns.
    expect(bashBlockReason("grep -rn 'git push' docs/")).toMatch(/rule 8/); // quoted text still matches — accepted: belt, not parser
    expect(bashBlockReason("cat docs/ghosts.md")).toBeUndefined();
    expect(bashBlockReason("rg deployed src/")).toBeUndefined();
  });
});

describe("frozenPaths + writeBlockReason", () => {
  const root = mkdtempSync(join(tmpdir(), "companion-guard-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "tests/fixtures"), { recursive: true });
  writeFileSync(
    join(root, "tests/fixtures/seed-manifest.json"),
    JSON.stringify({
      files: { "agents/pass-baseline.md": "x", "prompts/conversation-system.md": "y" },
    }),
  );

  it("freezes exactly the manifest plus the two registry fixtures", () => {
    const frozen = frozenPaths(readSeedManifest(root));
    expect(frozen.has("agents/pass-baseline.md")).toBe(true);
    expect(frozen.has("prompts/conversation-system.md")).toBe(true);
    for (const f of REGISTRY_FIXTURES) expect(frozen.has(f)).toBe(true);
    expect(frozen.size).toBe(2 + REGISTRY_FIXTURES.length);
  });

  it("vetoes frozen writes by relative or absolute path, with the rule-6 reason", () => {
    const frozen = frozenPaths(readSeedManifest(root));
    expect(writeBlockReason("agents/pass-baseline.md", root, frozen)).toMatch(/rule 6/);
    expect(writeBlockReason(join(root, "agents/pass-baseline.md"), root, frozen)).toMatch(
      /frozen seed/,
    );
    expect(writeBlockReason("tests/fixtures/ratified-divergence.json", root, frozen)).toMatch(
      /two sanctioned writers/,
    );
  });

  it("allows everything else — ours-to-edit files are NOT in the manifest, so they pass", () => {
    const frozen = frozenPaths(readSeedManifest(root));
    expect(writeBlockReason("prompts/round-1.md", root, frozen)).toBeUndefined();
    expect(writeBlockReason("agents/pass-intent.md", root, frozen)).toBeUndefined();
    expect(writeBlockReason("src/tui/app.ts", root, frozen)).toBeUndefined();
    // Outside the repo: mounts enforce their own modes; the guard stays out.
    expect(writeBlockReason("/tracker/efforts/x/tickets/FT-0001.md", root, frozen)).toBeUndefined();
  });

  it("degrades to fixtures-only when the manifest is unreadable — never wedges pi", () => {
    const frozen = frozenPaths(readSeedManifest(join(root, "nowhere")));
    expect(frozen.size).toBe(REGISTRY_FIXTURES.length);
    expect(
      writeBlockReason("tests/fixtures/seed-manifest.json", join(root, "nowhere"), frozen),
    ).toMatch(/rule 6/);
  });

  // A manifest that names no files disarms the rule-6 veto for every seed just
  // as completely as an unparseable one. Classifying it as a good read of
  // nothing would make the degradation silent — the warning below is keyed on
  // the read, so this must be `unreadable`, same as
  // CandidateStore.read's "no candidates array".
  it("a manifest that names no files is UNREADABLE, not a good read of nothing", () => {
    const empty = mkdtempSync(join(tmpdir(), "companion-guard-empty-"));
    mkdirSync(join(empty, "tests/fixtures"), { recursive: true });
    const at = join(empty, "tests/fixtures/seed-manifest.json");

    writeFileSync(at, "{}");
    expect(readSeedManifest(empty)).toEqual({ state: "unreadable", reason: "no files object" });
    writeFileSync(at, JSON.stringify({ files: {} }));
    expect(readSeedManifest(empty)).toEqual({
      state: "unreadable",
      reason: "manifest lists no files",
    });
    writeFileSync(at, JSON.stringify({ files: [] }));
    expect(readSeedManifest(empty)).toEqual({ state: "unreadable", reason: "no files object" });
    writeFileSync(at, JSON.stringify({ files: null }));
    expect(readSeedManifest(empty).state).toBe("unreadable");

    // Top-level non-objects. `null` is the dangerous one: it parses, and
    // reaching for `.files` on it THROWS out of the pi tool_call handler —
    // no DEGRADED line, no veto, the silent outcome this classification
    // exists to prevent. Every check here must be total on an `unknown`.
    for (const scalar of ["null", "3", '"a string"', "true", "[]"]) {
      writeFileSync(at, scalar);
      expect(() => readSeedManifest(empty)).not.toThrow();
      expect(readSeedManifest(empty).state, `top-level ${scalar}`).toBe("unreadable");
    }
    writeFileSync(at, "null");
    expect(readSeedManifest(empty)).toEqual({
      state: "unreadable",
      reason: "manifest is not an object",
    });

    // One real entry and it is a good read again.
    writeFileSync(at, JSON.stringify({ files: { "agents/pass-baseline.md": "x" } }));
    expect(readSeedManifest(empty)).toEqual({
      state: "manifest",
      files: ["agents/pass-baseline.md"],
    });
    rmSync(empty, { recursive: true, force: true });
  });

  it("the REAL repo manifest freezes the seeds and spares what is ours", () => {
    const repoRoot = join(import.meta.dirname, "..");
    const frozen = frozenPaths(readSeedManifest(repoRoot));
    expect(frozen.has("agents/pass-baseline.md")).toBe(true);
    // rule 6's ours-to-edit list must never be vetoed:
    for (const ours of [
      "prompts/companion.md",
      "agents/pass-intent.md",
      "agents/pass-placement.md",
    ]) {
      expect(frozen.has(ours)).toBe(false);
    }
  });
});

// The fail-open on an unreadable manifest is deliberate (see the `frozenPaths`
// docstring — this guard is belt, tests/seed-integrity.test.ts is the brace,
// and failing closed would veto every write the companion makes over a fixture
// problem). The degraded set must never be cached for the life of the session.
describe("activate — a degraded manifest read is never cached", () => {
  it("retries on the next write, so a transient unreadable manifest costs one tool call", () => {
    const dir = mkdtempSync(join(tmpdir(), "companion-guard-act-"));
    mkdirSync(join(dir, "tests/fixtures"), { recursive: true });
    let handler: ((e: unknown) => { block?: boolean; reason?: string } | undefined) | undefined;
    const pi = {
      on: (_name: string, h: (e: unknown) => { block?: boolean; reason?: string } | undefined) => {
        handler = h;
      },
    };
    const prevRoot = process.env.QCR_ROOT;
    const realError = console.error;
    const errs: string[] = [];
    process.env.QCR_ROOT = dir;
    console.error = (...args: unknown[]): void => {
      errs.push(args.map(String).join(" "));
    };
    try {
      activate(pi as never);
      const write = (path: string): { block?: boolean; reason?: string } | undefined =>
        handler!({ toolName: "write", input: { path } });

      // No manifest: degraded — the seed is NOT vetoed, the fixtures still are.
      expect(write("agents/pass-baseline.md")).toBeUndefined();
      expect(write("tests/fixtures/ratified-divergence.json")?.block).toBe(true);
      expect(errs.filter((e) => e.includes("DEGRADED"))).toHaveLength(1); // said once, not per call

      // The manifest becomes readable. Caching the degraded set on the first
      // write/edit would keep this permitted for the whole session — a rule-6
      // veto silently switched off by one bad moment.
      writeFileSync(
        join(dir, "tests/fixtures/seed-manifest.json"),
        JSON.stringify({ files: { "agents/pass-baseline.md": "x" } }),
      );
      expect(write("agents/pass-baseline.md")?.reason).toMatch(/rule 6/);

      // A GOOD read is still cached — the set changes only on a reseed, and a
      // reseed restarts everything.
      rmSync(join(dir, "tests/fixtures/seed-manifest.json"));
      expect(write("agents/pass-baseline.md")?.reason).toMatch(/rule 6/);
    } finally {
      console.error = realError;
      if (prevRoot === undefined) delete process.env.QCR_ROOT;
      else process.env.QCR_ROOT = prevRoot;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // An empty manifest disarms the veto for every seed, so it has to be as loud
  // as a torn one.
  // The same handler, driven over every useless payload shape. The assertion
  // that matters is that NONE of them throws out of `pi.on("tool_call", …)`:
  // what pi's dispatcher does with an exception there is VERIFY-ON-PIN, and a
  // throw skips both the DEGRADED line and the veto.
  it.each([
    ["null", "manifest is not an object"],
    ["3", "manifest is not an object"],
    ["[]", "manifest is not an object"],
    ["{}", "no files object"],
    ['{"files":null}', "no files object"],
    ['{"files":[]}', "no files object"],
    ['{"files":{}}', "manifest lists no files"],
    ["{not json", "JSON"],
  ])("a %s manifest degrades loudly through activate, never throws", (payload, expected) => {
    const dir = mkdtempSync(join(tmpdir(), "companion-guard-shape-"));
    mkdirSync(join(dir, "tests/fixtures"), { recursive: true });
    writeFileSync(join(dir, "tests/fixtures/seed-manifest.json"), payload);
    let handler: ((e: unknown) => { block?: boolean; reason?: string } | undefined) | undefined;
    const pi = {
      on: (_name: string, h: (e: unknown) => { block?: boolean; reason?: string } | undefined) => {
        handler = h;
      },
    };
    const prevRoot = process.env.QCR_ROOT;
    const realError = console.error;
    const errs: string[] = [];
    process.env.QCR_ROOT = dir;
    console.error = (...args: unknown[]): void => {
      errs.push(args.map(String).join(" "));
    };
    try {
      activate(pi as never);
      expect(() =>
        handler!({ toolName: "write", input: { path: "agents/pass-baseline.md" } }),
      ).not.toThrow();
      expect(errs.filter((e) => e.includes("DEGRADED"))).toHaveLength(1);
      expect(errs[0]).toContain(expected);
      // The fixtures are still vetoed on every one of these shapes.
      expect(
        handler!({ toolName: "write", input: { path: "tests/fixtures/ratified-divergence.json" } })
          ?.block,
      ).toBe(true);
    } finally {
      console.error = realError;
      if (prevRoot === undefined) delete process.env.QCR_ROOT;
      else process.env.QCR_ROOT = prevRoot;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("an empty manifest degrades LOUDLY, and is retried rather than cached", () => {
    const dir = mkdtempSync(join(tmpdir(), "companion-guard-empty-act-"));
    mkdirSync(join(dir, "tests/fixtures"), { recursive: true });
    writeFileSync(join(dir, "tests/fixtures/seed-manifest.json"), JSON.stringify({ files: {} }));
    let handler: ((e: unknown) => { block?: boolean; reason?: string } | undefined) | undefined;
    const pi = {
      on: (_name: string, h: (e: unknown) => { block?: boolean; reason?: string } | undefined) => {
        handler = h;
      },
    };
    const prevRoot = process.env.QCR_ROOT;
    const realError = console.error;
    const errs: string[] = [];
    process.env.QCR_ROOT = dir;
    console.error = (...args: unknown[]): void => {
      errs.push(args.map(String).join(" "));
    };
    try {
      activate(pi as never);
      const write = (path: string): { block?: boolean; reason?: string } | undefined =>
        handler!({ toolName: "write", input: { path } });
      expect(write("agents/pass-baseline.md")).toBeUndefined(); // fail-open, as ruled
      expect(errs.filter((e) => e.includes("DEGRADED"))).toHaveLength(1); // but never silent
      expect(errs[0]).toMatch(/manifest lists no files/);

      // Not cached: the moment the manifest is real, the veto is back.
      writeFileSync(
        join(dir, "tests/fixtures/seed-manifest.json"),
        JSON.stringify({ files: { "agents/pass-baseline.md": "x" } }),
      );
      expect(write("agents/pass-baseline.md")?.reason).toMatch(/rule 6/);
    } finally {
      console.error = realError;
      if (prevRoot === undefined) delete process.env.QCR_ROOT;
      else process.env.QCR_ROOT = prevRoot;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
