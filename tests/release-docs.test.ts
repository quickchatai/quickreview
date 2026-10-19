// The release-side documents of P6.16 (no docker, no model):
//   - docs/macos-release-checklist.md ships, and covers what the ruling asked
//     of the Mac check: the wrapper install, the token handoff directory under
//     $TMPDIR, the Docker Desktop VM's ptrace_scope, and one run with no model;
//   - docs/rule-text-drafts.md (draft CLAUDE.md text for rules 1, 3, 5 and 7,
//     awaiting the owner) stays out of the PUBLIC snapshot, is not silently
//     dropped from the internal one, and names only files that exist;
//   - CLAUDE.md is not edited by the drafting: each rule heading the drafts
//     replace is still present in it, in the shape the draft starts from.
// An ASSEMBLED public tree has neither the drafts nor CLAUDE.md, so those
// assertions skip there.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string): string => readFileSync(join(root, rel), "utf8");
const has = (rel: string): boolean => existsSync(join(root, rel));

interface Manifest {
  exclude: { path: string }[];
}
const publicManifest = JSON.parse(read("publish-manifest.json")) as Manifest;
const internalManifest = has("publish-manifest.internal.json")
  ? (JSON.parse(read("publish-manifest.internal.json")) as Manifest)
  : null;
const excludes = (m: Manifest, path: string): boolean => m.exclude.some((e) => e.path === path);

describe("docs/macos-release-checklist.md", () => {
  const CHECKLIST = "docs/macos-release-checklist.md";
  const text = read(CHECKLIST);

  it("ships: the public manifest does not exclude it", () => {
    expect(excludes(publicManifest, CHECKLIST)).toBe(false);
  });

  it("covers the wrapper install, the handoff dir under $TMPDIR, ptrace_scope and a run with no model", () => {
    expect(text).toMatch(/\binstall\b/);
    expect(text).toContain("~/.local/bin/qcr");
    expect(text).toContain("$TMPDIR");
    expect(text).toContain("/run/qcr-in");
    expect(text).toContain("QCR_GH_TOKEN_FILE");
    expect(text).toContain("kernel.yama.ptrace_scope");
    expect(text).toContain("review --preview --json");
  });

  it("asks for no real token and no model key", () => {
    expect(text).toContain("not-a-real-token");
    expect(text).not.toMatch(/gh auth token/);
    expect(text).toMatch(/must not reach a model/);
  });

  it("uses the commands the tree has: the wrapper's volume-free install and the image's debug line", () => {
    const entrypoint = read("docker/entrypoint.sh");
    expect(entrypoint).toContain("kernel.yama.ptrace_scope");
    expect(entrypoint).toContain("QCR_DEBUG");
    expect(read("scripts/qcr-host.sh")).toContain("/run/qcr-in");
    expect(read("scripts/qcr-host.sh")).toContain("QCR_GH_TOKEN_FILE");
  });
});

describe.skipIf(!has("docs/rule-text-drafts.md"))("docs/rule-text-drafts.md", () => {
  const DRAFTS = "docs/rule-text-drafts.md";
  const text = has(DRAFTS) ? read(DRAFTS) : "";

  it("is excluded from the public snapshot and left in the internal one", () => {
    expect(excludes(publicManifest, DRAFTS)).toBe(true);
    if (internalManifest) expect(excludes(internalManifest, DRAFTS)).toBe(false);
  });

  it("is marked a draft and drafts exactly rules 1, 3, 5 and 7", () => {
    expect(text).toMatch(/^STATUS: DRAFT/m);
    const headings = [...text.matchAll(/^## (Rule \d+)/gm)].map((m) => m[1]);
    expect(headings).toEqual(["Rule 1", "Rule 3", "Rule 5", "Rule 7"]);
  });

  it("every block starts from the rule's current opening line in CLAUDE.md", () => {
    const claude = read("CLAUDE.md");
    const blocks = [...text.matchAll(/```text\n([\s\S]*?)\n```/g)].map((m) => m[1]!);
    expect(blocks).toHaveLength(4);
    const opening = (b: string): string => b.split("\n")[0]!;
    // Rule 3 is rewritten in its first words (the daemon holds only the App); the others open unchanged.
    for (const b of [blocks[0]!, blocks[2]!, blocks[3]!]) {
      expect(claude, opening(b)).toContain(opening(b));
    }
    expect(opening(blocks[1]!)).toMatch(/^3\. \*\*/);
  });

  it("names the memory image as a plain-Dockerfile drift target, and the tests that exist", () => {
    expect(text).toContain("docker/memory/Dockerfile");
    expect(text).toMatch(/MEMORY IMAGE/);
    const cited = new Set(
      [...text.matchAll(/`((?:tests|src|docker|scripts|plugins)\/[A-Za-z0-9_./-]+)`/g)].map(
        (m) => m[1]!,
      ),
    );
    expect(cited.size).toBeGreaterThan(10);
    for (const rel of cited)
      expect(has(rel), `${rel} is cited in the drafts but absent`).toBe(true);
  });
});
