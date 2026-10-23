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
//     verbatim in the file it quotes. A landing that pastes a block marks its
//     section LANDED (as rules 1, 3, 5, 6, 7, 8 and 9 are), keeps that section's
//     `current` blocks as `replaced`, and its `proposed` blocks are then held
//     word for word against the files they landed in.
// An ASSEMBLED public tree has neither the drafts nor CLAUDE.md, so those
// assertions skip there.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string): string => readFileSync(join(root, rel), "utf8");
const has = (rel: string): boolean => existsSync(join(root, rel));
/** The private rulebook: CLAUDE.md's short form and the full texts it points
 * at in docs/rulebook/, where the landed rules and decisions now sit. */
const rulebook = (): string =>
  [
    "CLAUDE.md",
    "docs/rulebook/hard-rules.md",
    "docs/rulebook/decisions.md",
    "docs/rulebook/architecture.md",
  ]
    .map(read)
    .join("\n");

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
    // Every drafted rule has landed (rule 7's, pasted at the cutover, was the
    // last), so no `current` block is left to check.
    expect(checked).toBe(0);
  });

  it("every drafted rule opens with the line CLAUDE.md's rule opens with, and rules 7 and 8 and 9 are whole", () => {
    const claude = rulebook();
    const rules = blocks.filter((b) => b.kind === "proposed" && /^\d+\. /.test(b.body));
    // 1 and 3 twice (landed + delta), 5, 7, 8, and rule 9's landed stage (iii):
    // its stage (i) block is kept as `replaced` and stage (ii), skipped as moot,
    // as `skipped`, so neither reads as a proposal.
    expect(rules.map((b) => b.body.slice(0, 2))).toEqual([
      "1.",
      "1.",
      "3.",
      "3.",
      "5.",
      "7.",
      "8.",
      "9.",
    ]);
    for (const b of rules) expect(claude, b.body.slice(0, 40)).toContain(b.body.slice(0, 40));
    // Rule 7 is ONE text (the owner's ruling): no part A/B/C wording survives in the proposal.
    const r7 = rules.find((b) => b.body.startsWith("7."))!.body;
    expect(r7).toContain("SSH only\n   triggers the update");
    expect(r7).not.toMatch(/\bPart [ABC]\b/);
  });

  it("rule 8 and rule 11's first bullet sit in CLAUDE.md word for word, as ratified", () => {
    const sec = sections.find((x) => x.startsWith("Rule 8 "))!;
    const proposed = [...sec.matchAll(FENCE)].filter((m) => m[1] === "proposed");
    expect(proposed).toHaveLength(2);
    for (const m of proposed) expect(rulebook()).toContain(m[3]!);
    expect(rulebook()).not.toContain("never runs `scripts/deploy.sh`");
    expect(rulebook()).not.toContain("No `~/.ssh` and no ssh-agent socket are ever mounted");
  });

  it("rules 1 (IPC delta), 5 and 6 sit in CLAUDE.md word for word, as ratified 2026-10-20", () => {
    const claude = rulebook();
    for (const head of ["Rule 1 — the IPC post path", "Rule 5 ", "Rule 6 "]) {
      const sec = sections.find((x) => x.startsWith(head))!;
      expect(sec, head).toMatch(/^LANDED in CLAUDE\.md \(ratified 2026-10-20\)/m);
      const proposed = [...sec.matchAll(FENCE)].filter((m) => m[1] === "proposed");
      expect(proposed, head).toHaveLength(1);
      expect(claude, head).toContain(proposed[0]![3]!);
    }
    expect(claude).not.toContain("(shell side:");
    expect(claude).not.toContain("`conversation-system.md` and `overseer-system.md`");
  });

  it("rule 7 sits in CLAUDE.md word for word, as re-ratified at the cutover", () => {
    const claude = rulebook();
    const sec = sections.find((x) => x.startsWith("Rule 7 "))!;
    expect(sec).toMatch(/^LANDED in CLAUDE\.md \(ratified 2026-10-21/m);
    const proposed = [...sec.matchAll(FENCE)].filter((m) => m[1] === "proposed");
    expect(proposed).toHaveLength(1);
    expect(claude).toContain(proposed[0]![3]!);
    expect(claude).not.toContain("caught in three places");
    expect(claude).not.toContain("`tests/docker-daemon.test.ts` for the plain Dockerfile");
    expect(claude).not.toContain("deploy with `-e rebuild_image=true`");
  });

  it("rule 9 stage (iii), the single-shepherd doc's S1, S3, S4, S5, audit row and amendment, and the PR-pane rule's part 2 sit in place word for word", () => {
    const claude = rulebook();
    const doc = read("docs/single-shepherd-invariant.md");
    const proposed = blocks.filter((b) => b.kind === "proposed");
    const rule9 = proposed.filter((b) => b.body.startsWith("9. "));
    // Stage (iii) is in; stages (i) and (ii) are kept as `replaced` / `skipped`.
    expect(rule9).toHaveLength(1);
    expect(claude).toContain(rule9[0]!.body);
    expect(text).toContain("```text skipped CLAUDE.md\n9. ");
    for (const start of ["**S1 ", "**S3 ", "**S4 ", "**S5 ", "| S1 |", "## Amendment: workers\n"]) {
      const block = proposed.filter((b) => b.body.startsWith(start));
      expect(block, start).toHaveLength(1);
      expect(doc, start).toContain(block[0]!.body);
    }
    const bullet = proposed.find((b) => b.body.startsWith("- **One lens tool, one rule.**"))!;
    expect(doc).toContain(bullet.body);
    expect(doc).not.toContain("Two lens tools, one rule");
    expect(doc).not.toContain("The Slack router and the TUI alert sink");
    expect(doc).not.toContain("subagents glue");
    expect(doc).not.toContain("the `subagent` tool is the only launcher");
    const pane = proposed.filter((b) =>
      b.body.startsWith("- **An embedded pi surface is a TERMINAL"),
    );
    // Part 3 is the live text (ratified with P9.6); parts 1 and 2 are not.
    expect(pane).toHaveLength(3);
    expect(claude).toContain(pane[2]!.body);
    expect(claude).not.toContain(pane[1]!.body);
    expect(claude).not.toContain(pane[0]!.body);
    // The sentences the landings made false are gone, and the new ones are there.
    const folded = claude.replace(/\s+/g, " ");
    expect(folded).not.toContain("One exception: an operator's steer");
    expect(folded).not.toContain("flushed at round end (`src/wakes.ts`). One");
    expect(folded).not.toContain("two daemon-owned session kinds only");
    expect(folded).not.toContain("`overseer`, the global watcher");
    expect(folded).toContain("Two exceptions, both the operator's");
    expect(folded).toContain("answered at once by a short worker that resumes the session");
    expect(folded).toContain("posts only when the operator marked the message may-post");
    expect(folded).toContain("(rule 9's first exception)");
    // Each replaced `current` block is kept as `replaced`, so no test mistakes it for live text.
    expect(text).toContain("```text replaced CLAUDE.md");
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
