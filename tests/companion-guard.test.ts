// companion-guard (2026-08-25) — the companion's bright lines as tool_call
// vetoes. The interesting property is the NEGATIVE space: rule 6's frozen set
// is exactly the seed manifest, and the tight bash patterns must not veto the
// companion's ordinary work (commits, branch switches, stash list).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { bashBlockReason, frozenPaths, writeBlockReason, REGISTRY_FIXTURES } from "../extensions/companion-guard.js";

describe("bashBlockReason", () => {
  it("vetoes the rule-8 GitHub/deploy family", () => {
    expect(bashBlockReason("git push origin master")).toMatch(/rule 8/);
    expect(bashBlockReason("cd /workspace && git push")).toMatch(/rule 8/);
    expect(bashBlockReason("gh pr view 5362")).toMatch(/rule 8/);
    expect(bashBlockReason("./scripts/deploy.sh --dry-run")).toMatch(/rule 8/);
    expect(bashBlockReason("bash scripts/deploy.sh sync")).toMatch(/rule 8/);
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
    JSON.stringify({ files: { "agents/pass-baseline.md": "x", "prompts/conversation-system.md": "y" } }),
  );

  it("freezes exactly the manifest plus the two registry fixtures", () => {
    const frozen = frozenPaths(root);
    expect(frozen.has("agents/pass-baseline.md")).toBe(true);
    expect(frozen.has("prompts/conversation-system.md")).toBe(true);
    for (const f of REGISTRY_FIXTURES) expect(frozen.has(f)).toBe(true);
    expect(frozen.size).toBe(2 + REGISTRY_FIXTURES.length);
  });

  it("vetoes frozen writes by relative or absolute path, with the rule-6 reason", () => {
    const frozen = frozenPaths(root);
    expect(writeBlockReason("agents/pass-baseline.md", root, frozen)).toMatch(/rule 6/);
    expect(writeBlockReason(join(root, "agents/pass-baseline.md"), root, frozen)).toMatch(/frozen seed/);
    expect(writeBlockReason("tests/fixtures/ratified-divergence.json", root, frozen)).toMatch(/two sanctioned writers/);
  });

  it("allows everything else — ours-to-edit files are NOT in the manifest, so they pass", () => {
    const frozen = frozenPaths(root);
    expect(writeBlockReason("prompts/round-1.md", root, frozen)).toBeUndefined();
    expect(writeBlockReason("agents/pass-intent.md", root, frozen)).toBeUndefined();
    expect(writeBlockReason("src/tui/app.ts", root, frozen)).toBeUndefined();
    // Outside the repo: mounts enforce their own modes; the guard stays out.
    expect(writeBlockReason("/tracker/efforts/x/tickets/FT-0001.md", root, frozen)).toBeUndefined();
  });

  it("degrades to fixtures-only when the manifest is unreadable — never wedges pi", () => {
    const frozen = frozenPaths(join(root, "nowhere"));
    expect(frozen.size).toBe(REGISTRY_FIXTURES.length);
    expect(writeBlockReason("tests/fixtures/seed-manifest.json", join(root, "nowhere"), frozen)).toMatch(/rule 6/);
  });

  it("the REAL repo manifest freezes the seeds and spares what is ours", () => {
    const repoRoot = join(import.meta.dirname, "..");
    const frozen = frozenPaths(repoRoot);
    expect(frozen.has("agents/pass-baseline.md")).toBe(true);
    // rule 6's ours-to-edit list must never be vetoed:
    for (const ours of ["prompts/companion.md", "agents/pass-intent.md", "agents/pass-placement.md"]) {
      expect(frozen.has(ours)).toBe(false);
    }
  });
});
