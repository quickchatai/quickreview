// The release-side documents of P6.16 (no docker, no model):
//   - docs/macos-release-checklist.md ships, and covers what the ruling asked
//     of the Mac check: the wrapper install, the token handoff directory under
//     $TMPDIR, the Docker Desktop VM's ptrace_scope, and one run with no model;
//   - docs/rule-text-drafts.md (draft CLAUDE.md text for rules 1, 3, 5, 6, 7, 8
//     and 9, the PR-pane rule and the D5 exception, awaiting the owner; P6.16,
//     P7.17) stays out of the PUBLIC snapshot, is not silently dropped from the
//     internal one, and names only files that exist or that its landing
//     checklist says a ticket will create or remove;
//   - CLAUDE.md is not edited by the drafting: every `current` block is still
//     verbatim in the file it quotes. A landing ticket that pastes a block marks
//     its section LANDED (as rules 1 and 3 are) and drops that section's
//     `current` blocks in the same commit.
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
  const FENCE = /^```text (current|proposed)([^\n]*)\n([\s\S]*?)\n```$/gm;
  const blocks = [...text.matchAll(FENCE)].map((m) => ({
    kind: m[1]!,
    file: m[2]!.trim() || "CLAUDE.md",
    body: m[3]!,
  }));
  const prose = text.replace(FENCE, "");
  const sections = text.split(/^## /m).slice(1);

  it("is excluded from the public snapshot and left in the internal one", () => {
    expect(excludes(publicManifest, DRAFTS)).toBe(true);
    if (internalManifest) expect(excludes(internalManifest, DRAFTS)).toBe(false);
  });

  it("is marked a draft and drafts rules 1, 3, 5, 6, 7, 8 and 9, the PR-pane rule and the D5 exception", () => {
    expect(text).toMatch(/^STATUS: DRAFT/m);
    const headings = [...prose.matchAll(/^## (.+)$/gm)].map((m) => m[1]!);
    expect(
      headings.filter((h) => /^Rule \d+/.test(h)).map((h) => /^Rule (\d+)/.exec(h)![1]),
    ).toEqual(["1", "1", "3", "3", "5", "6", "7", "8", "9"]);
    for (const start of [
      "Landing table",
      "The PR-pane rule",
      "The D5 exception",
      "Landing checklist",
    ])
      expect(
        headings.some((h) => h.startsWith(start)),
        start,
      ).toBe(true);
  });

  it("names the landing ticket of every draft", () => {
    const table = prose.slice(prose.indexOf("## Landing table"), prose.indexOf("## Rule 1"));
    for (const t of [
      "P7.6",
      "P7.13",
      "P8.17",
      "P8.19",
      "P8.22",
      "P9.3",
      "P9.4",
      "P9.9",
      "P8.21",
      "P9.13",
      "P9.14",
    ])
      expect(table, t).toContain(t);
    expect(table).toMatch(/Rule 7, ONE text/);
  });

  it("every `current` block is verbatim in the file it names, until its section is LANDED", () => {
    let checked = 0;
    for (const sec of sections) {
      if (/^LANDED\b/m.test(sec.replace(FENCE, ""))) continue;
      for (const m of sec.matchAll(FENCE)) {
        if (m[1] !== "current") continue;
        const file = m[2]!.trim() || "CLAUDE.md";
        expect(read(file), `${sec.split("\n")[0]} quotes ${file}`).toContain(m[3]!);
        checked++;
      }
    }
    // A floor, not a count: each landing marks its section LANDED and takes its
    // `current` block out of the check (P7.13's rule 3 carve-out took one more).
    expect(checked).toBeGreaterThan(5);
  });

  it("every drafted rule opens with the line CLAUDE.md's rule opens with, and rules 7 and 8 and 9 are whole", () => {
    const claude = read("CLAUDE.md");
    const rules = blocks.filter((b) => b.kind === "proposed" && /^\d+\. /.test(b.body));
    // 1 and 3 twice (landed + delta), 5, 7, 8, and rule 9 in three stages.
    expect(rules.map((b) => b.body.slice(0, 2))).toEqual([
      "1.",
      "1.",
      "3.",
      "3.",
      "5.",
      "7.",
      "8.",
      "9.",
      "9.",
      "9.",
    ]);
    for (const b of rules) expect(claude, b.body.slice(0, 40)).toContain(b.body.slice(0, 40));
    // Rule 7 is ONE text (the owner's ruling): no part A/B/C wording survives in the proposal.
    const r7 = rules.find((b) => b.body.startsWith("7."))!.body;
    expect(r7).toContain("SSH only\n   triggers the update");
    expect(r7).not.toMatch(/\bPart [ABC]\b/);
  });

  it("states plainly that the companion's model can run any command on the VM", () => {
    const r8 = blocks.find((b) => b.kind === "proposed" && b.body.startsWith("8."))!.body;
    expect(r8).toContain("ANY command on the live VM");
    expect(r8).not.toContain("never runs\n   `scripts/deploy.sh`, and holds no VM credentials");
  });

  it("names the memory image as a plain-Dockerfile drift target, and paths that exist or are on the checklist", () => {
    expect(text).toContain("docker/memory/Dockerfile");
    expect(text).toMatch(/MEMORY IMAGE/);
    const at = prose.indexOf("## Landing checklist");
    const checklist = prose.slice(at);
    const PATH =
      /`((?:tests|src|docker|scripts|plugins|extensions|deploy|docs|prompts|seeds)\/[A-Za-z0-9_./-]+)`/g;
    const norm = (p: string): string => p.replace(/\/$/, "");
    const listed = new Set([...checklist.matchAll(PATH)].map((m) => norm(m[1]!)));
    const cited = new Set([...prose.slice(0, at).matchAll(PATH)].map((m) => norm(m[1]!)));
    for (const b of blocks)
      if (b.kind === "proposed") for (const m of b.body.matchAll(PATH)) cited.add(norm(m[1]!));
    expect(cited.size).toBeGreaterThan(30);
    for (const rel of cited)
      expect(
        has(rel) || listed.has(rel),
        `${rel} is cited in the drafts but absent and not on the checklist`,
      ).toBe(true);
  });
});
