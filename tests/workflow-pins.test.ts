// Every action a workflow runs is pinned to a full commit SHA, with the
// version it was at in a trailing comment. A tag can be moved by whoever
// controls the action's repository, and release.yml's publish job holds
// packages: write and id-token: write, so a moved tag would run inside the
// release. The repository setting `sha_pinning_required` (.github/repo-
// settings.sh) refuses an unpinned action at run time; this fence refuses it
// before merge, and .github/dependabot.yml keeps the pins moving.
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dir = join(root, ".github", "workflows");
const workflows = readdirSync(dir).filter((f) => /\.ya?ml$/.test(f));

const PINNED = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]+@[0-9a-f]{40} # v\d+(\.\d+){1,2}$/;

function usesLines(file: string): string[] {
  return readFileSync(join(dir, file), "utf8")
    .split("\n")
    .map((l) => l.match(/^\s*(?:-\s+)?uses:\s*(.+?)\s*$/)?.[1])
    .filter((u): u is string => u !== undefined);
}

describe("workflow action pins", () => {
  it("reads the workflows this repository runs", () => {
    expect(workflows).toEqual(expect.arrayContaining(["ci.yml", "pr-intake.yml", "release.yml"]));
    expect(usesLines("release.yml").length).toBeGreaterThan(10);
  });

  // MUTATION: change one `uses:` in release.yml back to `actions/checkout@v7`
  // — this fails, naming the file and the line.
  it.each(workflows)("%s uses every action by commit SHA, with its version beside it", (file) => {
    for (const u of usesLines(file)) {
      if (u.startsWith("./")) continue; // a local action is this commit's own code
      expect(u, `${file}: uses: ${u}`).toMatch(PINNED);
    }
  });

  // MUTATION: pin one checkout step to a different SHA than the others — this fails.
  it("pins each action to one SHA across all workflows", () => {
    const shaByAction = new Map<string, Set<string>>();
    for (const file of workflows)
      for (const u of usesLines(file)) {
        const m = u.match(/^(.+)@([0-9a-f]{40})/);
        if (!m) continue;
        const set = shaByAction.get(m[1]!) ?? new Set<string>();
        set.add(m[2]!);
        shaByAction.set(m[1]!, set);
      }
    for (const [action, shas] of shaByAction) expect([...shas], action).toHaveLength(1);
  });

  // MUTATION: delete the github-actions entry from .github/dependabot.yml — this fails.
  it("has Dependabot propose the pin bumps", () => {
    const cfg = parse(readFileSync(join(root, ".github", "dependabot.yml"), "utf8")) as {
      updates: { "package-ecosystem": string; directory: string }[];
    };
    expect(cfg.updates).toContainEqual(
      expect.objectContaining({ "package-ecosystem": "github-actions", directory: "/" }),
    );
  });

  // MUTATION: drop "sha_pinning_required": true from .github/repo-settings.sh — this fails.
  it("has the repository refuse an unpinned action at run time", () => {
    const script = readFileSync(join(root, ".github", "repo-settings.sh"), "utf8");
    expect(script).toMatch(/call PUT \/actions\/permissions '\{[^}]*"sha_pinning_required": true/);
  });
});
