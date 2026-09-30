// Proposals module (§7/§8; producer moved to the companion after
// retired the EOD curator's authoring): LOCAL state/rubric/ dir
// list/read/remove, gh parsing, patch vetting incl. the RATIFIED-fence
// refusal, and accept = merge + auto-ratify against a temp repo-root with a
// fake git.
import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TuiConfig } from "../src/config.js";
import {
  acceptProposal,
  configPatchViolation,
  fenceRanges,
  fenceSourceFrom,
  IMPROVEMENTS_FAILED,
  improvementsArgv,
  listRubricProposals,
  parseImprovements,
  patchFenceViolation,
  patchShapeViolation,
  patchTargets,
  proposalKind,
  readRubricFile,
  recordRatification,
  removeRubricDir,
  rubricDir,
  targetsAllowed,
  validSlug,
  type FenceSource,
} from "../src/tui/proposals.js";

const cfg = {
  ssh_host: "my-vm",
  container: "quickreview-sandbox",
  remote_state_dir: "/opt/quickreview/state",
  remote_sandbox_root: "/opt/quickreview/sandbox",
  sudo_docker: true,
  poll_interval_s: 5,
  stale_after_s: 90,
  msg_timeout_s: 10,
} as TuiConfig;

describe("slugs", () => {
  it("accepts kebab slugs, refuses traversal and shell metacharacters", () => {
    expect(validSlug("baseline-mergebase-2026-08-20")).toBe(true);
    expect(validSlug("../etc")).toBe(false);
    expect(validSlug("a b")).toBe(false);
    expect(validSlug("x;rm")).toBe(false);
    expect(validSlug(".hidden")).toBe(false);
  });
});

describe("local proposal store (state/rubric/ in THIS repo — the companion writes it at /workspace)", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "rubric-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const seed = (slug: string, files: Record<string, string>): void => {
    mkdirSync(join(root, "state/rubric", slug), { recursive: true });
    for (const [name, body] of Object.entries(files))
      writeFileSync(join(root, "state/rubric", slug, name), body);
  };

  it("lives under <repoRoot>/state/rubric — a local path, never a VM one", () => {
    expect(rubricDir(root)).toBe(join(root, "state", "rubric"));
  });

  it("lists slugs sorted, skipping invalid names, and is empty (not a throw) with no dir", () => {
    expect(listRubricProposals(root)).toEqual([]);
    seed("b-slug", { "PROPOSAL.md": "x" });
    seed("a-slug", { "PROPOSAL.md": "x" });
    mkdirSync(join(root, "state/rubric", ".hidden"), { recursive: true });
    writeFileSync(join(root, "state/rubric", "stray file"), "not a dir, bad name");
    expect(listRubricProposals(root)).toEqual(["a-slug", "b-slug"]);
  });

  it("reads proposal files (null when missing) and validates the slug", () => {
    seed("ok-slug", { "PROPOSAL.md": "## Rationale\nbody\n" });
    expect(readRubricFile(root, "ok-slug", "PROPOSAL.md")).toContain("## Rationale");
    expect(readRubricFile(root, "ok-slug", "changes.patch")).toBeNull();
    expect(() => readRubricFile(root, "../x", "PROPOSAL.md")).toThrow(/bad rubric slug/);
  });

  it("removes a decided dir, slug-validated", () => {
    seed("done", { "PROPOSAL.md": "x" });
    removeRubricDir(root, "done");
    expect(existsSync(join(root, "state/rubric/done"))).toBe(false);
    expect(() => removeRubricDir(root, "a/../b")).toThrow(/bad rubric slug/);
  });
});

describe("gh improvements read (still remote — the ONLY ssh this module produces)", () => {
  it("reads both lists with the mint-token credential", () => {
    const s = improvementsArgv(cfg, "exampleorg/example-app").join(" ");
    expect(s).toContain("mint-token.sh");
    expect(s).toContain("head:bot/improve");
    expect(s).toContain("--label bot-filed");
  });

  it("lists issues by the CONFIGURED github.issue_label — the one the writer files with — quoted for sh", () => {
    const s = improvementsArgv(cfg, "exampleorg/example-app", "qcr bot's").join(" ");
    expect(s).toContain(`--label 'qcr bot'\\''s'`);
    expect(s).not.toContain("--label bot-filed");
  });

  it("parses the two gh JSON lists around the --- separator", () => {
    const out = `[{"number":12,"title":"docs: fix typo","state":"MERGED"}]\n---\n[{"number":9,"title":"flaky test","state":"OPEN"}]`;
    expect(parseImprovements(out)).toEqual({
      items: [
        { kind: "pr", number: 12, title: "docs: fix typo", state: "merged" },
        { kind: "issue", number: 9, title: "flaky test", state: "open" },
      ],
      failed: [],
    });
  });

  it("a failed gh call is a FAILED list, never an empty one — per list", () => {
    // What the in-container script prints when gh (or mint-token) fails: the
    // per-list fallback keeps the other list, but marks this one failed.
    const s = improvementsArgv(cfg, "exampleorg/example-app").join(" ");
    expect(s).not.toContain("echo '[]'");
    expect(s).toContain(`echo '${IMPROVEMENTS_FAILED}'`);
    expect(
      parseImprovements(`${IMPROVEMENTS_FAILED}\n---\n[{"number":9,"title":"t","state":"OPEN"}]`),
    ).toEqual({
      items: [{ kind: "issue", number: 9, title: "t", state: "open" }],
      failed: ["pr"],
    });
    expect(parseImprovements("[]\n---\n[]")).toEqual({ items: [], failed: [] });
  });

  it("garbage is a failed read of both lists, not two empty ones", () => {
    expect(parseImprovements("gh: auth broken")).toEqual({ items: [], failed: ["pr", "issue"] });
  });

  it("refuses a malformed repo string in the gh read", () => {
    expect(() => improvementsArgv(cfg, "owner/repo; rm -rf /")).toThrow(/bad repo/);
  });
});

const PATCH = `--- a/agents/pass-baseline.md
+++ b/agents/pass-baseline.md
@@ -1,2 +1,3 @@
 line one
+Always diff questioned transforms against the merge base first.
 line two
`;

describe("patch vetting — targets", () => {
  it("extracts target files", () => {
    expect(patchTargets(PATCH)).toEqual(["agents/pass-baseline.md"]);
  });

  it("allows only agents/ and prompts/ targets", () => {
    expect(targetsAllowed(["agents/pass-baseline.md", "prompts/round-first.md"])).toBe(true);
    expect(targetsAllowed(["src/gate.ts"])).toBe(false);
    expect(targetsAllowed([])).toBe(false);
    expect(targetsAllowed(["agents/../src/gate.ts"])).toBe(false); // traversal
  });

  it("sees deletions and renames — a +++ /dev/null cannot hide a victim (review fix)", () => {
    const deletion =
      PATCH + `--- a/src/gate.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-export const gate = 1;\n`;
    expect(patchTargets(deletion)).toContain("src/gate.ts");
    expect(targetsAllowed(patchTargets(deletion))).toBe(false);
    const rename = "rename from src/gate.ts\nrename to agents/pass-x.md\n" + PATCH;
    expect(patchTargets(rename)).toContain("src/gate.ts");
    expect(targetsAllowed(patchTargets(rename))).toBe(false);
  });
});

// A comment-preserving config.toml hunk — the config-proposal shape.
const CONFIG_PATCH = `--- a/config.toml
+++ b/config.toml
@@ -409,2 +409,2 @@
 # most recent human author of the touched directive files, else this:
-escalation_mention_default = "oldhandle"
+escalation_mention_default = "casey"
`;

describe("proposal kinds (config beside rubric)", () => {
  it("classifies rubric, config, mixed and out-of-bounds target sets", () => {
    expect(proposalKind(["agents/pass-baseline.md", "prompts/round-first.md"])).toBe("rubric");
    expect(proposalKind(["config.toml"])).toBe("config");
    expect(proposalKind(["config.toml", "agents/pass-baseline.md"])).toBeNull(); // kinds never mix
    expect(proposalKind(["src/gate.ts"])).toBeNull();
    expect(proposalKind(["config.toml", "src/gate.ts"])).toBeNull();
    expect(proposalKind([])).toBeNull();
  });

  it("configPatchViolation refuses any changed line touching dry_run — added, removed, or renamed in", () => {
    const flip = `--- a/config.toml\n+++ b/config.toml\n@@ -4,1 +4,1 @@\n-dry_run = false\n+dry_run = true\n`;
    expect(configPatchViolation(flip)).toMatch(/dry_run/);
    const addOnly = `--- a/config.toml\n+++ b/config.toml\n@@ -10,1 +10,2 @@\n [ops]\n+dry_run = true\n`;
    expect(configPatchViolation(addOnly)).toMatch(/dry_run/);
    const inlineTable = `--- a/config.toml\n+++ b/config.toml\n@@ -10,1 +10,2 @@\n [ops]\n+review = { dry_run = false }\n`;
    expect(configPatchViolation(inlineTable)).toMatch(/dry_run/);
    // A comment merely mentioning it also trips — the false positive is safe.
    const comment = `--- a/config.toml\n+++ b/config.toml\n@@ -10,1 +10,2 @@\n [ops]\n+# see dry_run above\n`;
    expect(configPatchViolation(comment)).toMatch(/dry_run/);
  });

  it("configPatchViolation passes a clean knob change, dry_run in context lines included", () => {
    expect(configPatchViolation(CONFIG_PATCH)).toBeNull();
    // dry_run as an untouched CONTEXT line is not a violation — nothing changes it.
    const context = `--- a/config.toml\n+++ b/config.toml\n@@ -4,2 +4,3 @@\n dry_run = false\n [ops]\n+timezone = "Europe/Warsaw"\n`;
    expect(configPatchViolation(context)).toBeNull();
    // And a word that merely CONTAINS the token is not the token.
    const lookalike = `--- a/config.toml\n+++ b/config.toml\n@@ -1,1 +1,2 @@\n x\n+not_dry_running = 1\n`;
    expect(configPatchViolation(lookalike)).toBeNull();
  });
});

// A prompt with a RATIFIED fence on lines 3..6 (markers included).
const FENCED = [
  "intro line",
  "",
  "<!-- RATIFIED ci-gate — do not edit; owner only -->",
  "ratified line A",
  "ratified line B",
  "<!-- /RATIFIED ci-gate -->",
  "outro line",
  "",
].join("\n");

describe("patch vetting — RATIFIED fences (rule 6, structural)", () => {
  const read = (rel: string): FenceSource =>
    rel === "prompts/round-first.md" ? { state: "content", content: FENCED } : { state: "absent" };

  it("fenceRanges returns 1-based inclusive ranges, markers included; unterminated protects to EOF", () => {
    expect(fenceRanges(FENCED)).toEqual([{ start: 3, end: 6 }]);
    expect(fenceRanges("a\n<!-- RATIFIED FT-1 x -->\nb\nc")).toEqual([{ start: 2, end: 4 }]);
    expect(fenceRanges("no fences here\n")).toEqual([]);
  });

  it("refuses a deletion/edit of a line inside the fence", () => {
    const patch = `--- a/prompts/round-first.md\n+++ b/prompts/round-first.md\n@@ -3,4 +3,4 @@\n <!-- RATIFIED ci-gate — do not edit; owner only -->\n-ratified line A\n+quietly weakened line A\n ratified line B\n <!-- /RATIFIED ci-gate -->\n`;
    expect(patchFenceViolation(patch, read)).toMatch(
      /inside a RATIFIED fence in prompts\/round-first\.md/,
    );
  });

  it("refuses deleting a fence marker itself", () => {
    const patch = `--- a/prompts/round-first.md\n+++ b/prompts/round-first.md\n@@ -5,2 +5,1 @@\n ratified line B\n-<!-- /RATIFIED ci-gate -->\n`;
    expect(patchFenceViolation(patch, read)).toMatch(/RATIFIED fence/);
  });

  it("refuses an insertion between fenced lines", () => {
    const patch = `--- a/prompts/round-first.md\n+++ b/prompts/round-first.md\n@@ -4,2 +4,3 @@\n ratified line A\n+a rider paragraph\n ratified line B\n`;
    expect(patchFenceViolation(patch, read)).toMatch(/inserts inside a RATIFIED fence/);
  });

  it("refuses added lines carrying a fence marker anywhere — a proposal cannot mint a fence", () => {
    const patch = `--- a/prompts/round-first.md\n+++ b/prompts/round-first.md\n@@ -7,1 +7,3 @@\n outro line\n+<!-- RATIFIED fake — do not edit; owner only -->\n+ridden-in text\n`;
    expect(patchFenceViolation(patch, read)).toMatch(/adds a RATIFIED fence marker/);
    const close = `--- a/agents/pass-x.md\n+++ b/agents/pass-x.md\n@@ -1,1 +1,2 @@\n body\n+<!-- /RATIFIED sneaky -->\n`;
    expect(patchFenceViolation(close, () => ({ state: "content", content: "body\n" }))).toMatch(
      /adds a RATIFIED fence marker/,
    );
  });

  // the guard fails CLOSED. It refuses at the `--- ` line, before it
  // has looked at a single hunk, because it cannot know what it would be
  // touching — and it refuses even for a patch that would have been clean.
  it("refuses on an unreadable target, whatever the hunks do", () => {
    const unreadable = (): FenceSource => ({ state: "unreadable", reason: "EACCES" });
    const outside = `--- a/prompts/round-first.md\n+++ b/prompts/round-first.md\n@@ -7,1 +7,2 @@\n outro line\n+one more outro line\n`;
    expect(patchFenceViolation(outside, unreadable)).toMatch(
      /cannot read prompts\/round-first\.md to check its RATIFIED fences \(EACCES\)/,
    );
    expect(patchFenceViolation(outside, unreadable)).toMatch(
      /an unreadable file is not an unfenced one/,
    );

    // fenceSourceFrom is the production reader: ENOENT is the ONLY absence.
    const dir = mkdtempSync(join(tmpdir(), "fence-src-"));
    mkdirSync(join(dir, "agents"), { recursive: true });
    expect(fenceSourceFrom(dir, "agents/nope.md")).toEqual({ state: "absent" });
    writeFileSync(join(dir, "agents/real.md"), "body\n");
    expect(fenceSourceFrom(dir, "agents/real.md")).toEqual({ state: "content", content: "body\n" });
    mkdirSync(join(dir, "agents/adir.md"));
    expect(fenceSourceFrom(dir, "agents/adir.md").state).toBe("unreadable");
    rmSync(dir, { recursive: true, force: true });
  });

  it("passes edits strictly outside the fence, and new files with no fence", () => {
    const outside = `--- a/prompts/round-first.md\n+++ b/prompts/round-first.md\n@@ -7,1 +7,2 @@\n outro line\n+one more outro line\n`;
    expect(patchFenceViolation(outside, read)).toBeNull();
    const fresh = `--- /dev/null\n+++ b/agents/pass-new.md\n@@ -0,0 +1,1 @@\n+brand new body\n`;
    expect(patchFenceViolation(fresh, () => ({ state: "absent" }))).toBeNull();
    expect(
      patchFenceViolation(PATCH, () => ({ state: "content", content: "line one\nline two\n" })),
    ).toBeNull();
  });
});

describe("recordRatification", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "ratify-"));
    mkdirSync(join(root, "tests/fixtures"), { recursive: true });
    mkdirSync(join(root, "agents"), { recursive: true });
    writeFileSync(join(root, "agents/pass-baseline.md"), "patched body\n");
    writeFileSync(
      join(root, "tests/fixtures/seed-manifest.json"),
      JSON.stringify({ files: { "agents/pass-baseline.md": "oldhash" } }),
    );
    writeFileSync(
      join(root, "tests/fixtures/ratified-divergence.json"),
      JSON.stringify({ files: {} }),
    );
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("re-pins the manifest hash, refreshes the seeds/ copy, and appends a dated owner note", () => {
    const touched = recordRatification(
      root,
      ["agents/pass-baseline.md"],
      "fix-mergebase",
      "2026-08-20",
    );
    expect(touched).toEqual(["agents/pass-baseline.md"]);
    const manifest = JSON.parse(
      readFileSync(join(root, "tests/fixtures/seed-manifest.json"), "utf8"),
    );
    expect(manifest.files["agents/pass-baseline.md"]).toMatch(/^[0-9a-f]{64}$/);
    expect(manifest.files["agents/pass-baseline.md"]).not.toBe("oldhash");
    // the in-repo canonical copy tracks the ratified content, so the
    // provenance suite stays green after an accept.
    expect(readFileSync(join(root, "seeds/agents/pass-baseline.md"), "utf8")).toBe(
      "patched body\n",
    );
    const div = JSON.parse(
      readFileSync(join(root, "tests/fixtures/ratified-divergence.json"), "utf8"),
    );
    // grandfathering: new notes say "owner", legacy notes say
    // "the owner" — the verifying grammar accepts both, so old history validates.
    expect(div.files["agents/pass-baseline.md"][0]).toMatch(
      /^2026-08-20 (?:the owner|owner): rubric proposal 'fix-mergebase'/,
    );
  });

  it("skips non-seeded files (no exemption needed)", () => {
    const touched = recordRatification(root, ["agents/pass-intent.md"], "s", "2026-08-20");
    expect(touched).toEqual([]);
  });
});

describe("acceptProposal (local dirs, fake git)", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "accept-"));
    mkdirSync(join(root, "tests/fixtures"), { recursive: true });
    mkdirSync(join(root, "agents"), { recursive: true });
    mkdirSync(join(root, "prompts"), { recursive: true });
    writeFileSync(join(root, "agents/pass-baseline.md"), "line one\nline two\n");
    writeFileSync(
      join(root, "tests/fixtures/seed-manifest.json"),
      JSON.stringify({ files: { "agents/pass-baseline.md": "old" } }),
    );
    writeFileSync(
      join(root, "tests/fixtures/ratified-divergence.json"),
      JSON.stringify({ files: {} }),
    );
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const propose = (slug: string, patch: string): void => {
    mkdirSync(join(root, "state/rubric", slug), { recursive: true });
    writeFileSync(join(root, "state/rubric", slug, "PROPOSAL.md"), "## Rationale\n");
    writeFileSync(join(root, "state/rubric", slug, "changes.patch"), patch);
  };

  it("reads the LOCAL changes.patch, applies, ratifies, commits, then removes the dir", async () => {
    propose("fix-mergebase", PATCH);
    const gitCalls: string[][] = [];
    const res = await acceptProposal(
      {
        git: {
          run: (cmd, args) => {
            gitCalls.push([cmd, ...args]);
            return Promise.resolve("");
          },
        },
        repoRoot: root,
        today: () => "2026-08-20",
      },
      "fix-mergebase",
    );
    expect(res.ok).toBe(true);
    // --check, the shadow apply (post-image fences), the dirty-target status,
    // the real apply, add, commit.
    expect(gitCalls.map((c) => c.slice(0, 2).join(" "))).toEqual([
      "git apply",
      "git apply",
      "git status",
      "git apply",
      "git add",
      "git commit",
    ]);
    // The refreshed canonical copy rides the same commit as the reseed.
    expect(gitCalls[4]).toContain("seeds/agents/pass-baseline.md");
    // role wording, old spelling grandfathered (history never rewrites).
    expect(gitCalls[5]!.join(" ")).toMatch(/ratified by (?:the owner|the owner) via TUI/);
    const div = JSON.parse(
      readFileSync(join(root, "tests/fixtures/ratified-divergence.json"), "utf8"),
    );
    expect(Object.keys(div.files)).toEqual(["agents/pass-baseline.md"]);
    expect(existsSync(join(root, "state/rubric/fix-mergebase"))).toBe(false);
  });

  it("refuses when there is no changes.patch", async () => {
    const res = await acceptProposal(
      { git: { run: () => Promise.resolve("") }, repoRoot: root, today: () => "2026-08-20" },
      "ghost",
    );
    expect(res.ok).toBe(false);
    expect(res.message).toContain("no changes.patch");
  });

  it("refuses a patch reaching outside agents//prompts/ before touching git", async () => {
    propose("evil", PATCH.replace(/agents\/pass-baseline\.md/g, "src/gate.ts"));
    const gitCalls: string[][] = [];
    const res = await acceptProposal(
      {
        git: {
          run: (cmd, args) => {
            gitCalls.push([cmd, ...args]);
            return Promise.resolve("");
          },
        },
        repoRoot: root,
        today: () => "2026-08-20",
      },
      "evil",
    );
    expect(res.ok).toBe(false);
    expect(res.message).toContain("non-proposal paths");
    expect(gitCalls).toHaveLength(0);
    expect(existsSync(join(root, "state/rubric/evil"))).toBe(true); // a refusal never deletes the evidence
  });

  it("refuses a patch that edits inside a RATIFIED fence, before touching git", async () => {
    writeFileSync(join(root, "prompts/round-first.md"), FENCED);
    propose(
      "fence-ride",
      `--- a/prompts/round-first.md\n+++ b/prompts/round-first.md\n@@ -3,4 +3,4 @@\n <!-- RATIFIED ci-gate — do not edit; owner only -->\n-ratified line A\n+quietly weakened line A\n ratified line B\n <!-- /RATIFIED ci-gate -->\n`,
    );
    const gitCalls: string[][] = [];
    const res = await acceptProposal(
      {
        git: {
          run: (cmd, args) => {
            gitCalls.push([cmd, ...args]);
            return Promise.resolve("");
          },
        },
        repoRoot: root,
        today: () => "2026-08-20",
      },
      "fence-ride",
    );
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/RATIFIED fence/);
    expect(gitCalls).toHaveLength(0);
  });

  // the guard used to `catch → null`, making EACCES/EISDIR
  // indistinguishable from ENOENT, and `null` reads as "no fences". So ONE
  // unreadable target let a patch reaching inside an owner-fenced region be
  // accepted, applied and committed — a rule-6 bright-line bypass with a local
  // commit behind it. It fails CLOSED now.
  it("refuses when a fence target cannot be READ — an unreadable file is not an unfenced one", async () => {
    // A directory where the file should be: readFileSync raises EISDIR, which
    // the old catch-all folded into "this file does not exist yet".
    mkdirSync(join(root, "prompts/round-first.md"), { recursive: true });
    propose(
      "fence-ride-unreadable",
      `--- a/prompts/round-first.md\n+++ b/prompts/round-first.md\n@@ -3,4 +3,4 @@\n <!-- RATIFIED ci-gate — do not edit; owner only -->\n-ratified line A\n+quietly weakened line A\n ratified line B\n <!-- /RATIFIED ci-gate -->\n`,
    );
    const gitCalls: string[][] = [];
    const res = await acceptProposal(
      {
        git: {
          run: (cmd, args) => {
            gitCalls.push([cmd, ...args]);
            return Promise.resolve("");
          },
        },
        repoRoot: root,
        today: () => "2026-08-20",
      },
      "fence-ride-unreadable",
    );
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(
      /cannot read prompts\/round-first\.md to check its RATIFIED fences/,
    );
    expect(gitCalls).toHaveLength(0); // never applied, never committed
    expect(existsSync(join(root, "state/rubric/fence-ride-unreadable"))).toBe(true);
  });

  it("a target the patch CREATES is still fine — absent is not unreadable", async () => {
    propose(
      "brand-new",
      `--- /dev/null\n+++ b/agents/pass-new.md\n@@ -0,0 +1,1 @@\n+brand new body\n`,
    );
    const res = await acceptProposal(
      { git: { run: () => Promise.resolve("") }, repoRoot: root, today: () => "2026-08-20" },
      "brand-new",
    );
    expect(res.ok).toBe(true);
  });

  it("accepts a config proposal: applies + commits, no ratification bookkeeping, dir removed", async () => {
    writeFileSync(
      join(root, "config.toml"),
      '# comment\nescalation_mention_default = "oldhandle"\n',
    );
    propose("calibrate-mention", CONFIG_PATCH);
    const gitCalls: string[][] = [];
    const res = await acceptProposal(
      {
        git: {
          run: (cmd, args) => {
            gitCalls.push([cmd, ...args]);
            return Promise.resolve("");
          },
        },
        repoRoot: root,
        today: () => "2026-08-30",
      },
      "calibrate-mention",
    );
    expect(res.ok).toBe(true);
    // --check, the shadow apply (post-image fences), the dirty-target status,
    // the real apply, add, commit.
    expect(gitCalls.map((c) => c.slice(0, 2).join(" "))).toEqual([
      "git apply",
      "git apply",
      "git status",
      "git apply",
      "git add",
      "git commit",
    ]);
    expect(gitCalls[4]).toContain("config.toml");
    expect(gitCalls[4]).not.toContain("tests/fixtures/seed-manifest.json");
    expect(gitCalls[5]!.join(" ")).toContain("config: accept 'calibrate-mention'");
    // config.toml is not a seed: the divergence registry is untouched.
    const div = JSON.parse(
      readFileSync(join(root, "tests/fixtures/ratified-divergence.json"), "utf8"),
    );
    expect(Object.keys(div.files)).toEqual([]);
    expect(existsSync(join(root, "state/rubric/calibrate-mention"))).toBe(false);
  });

  // the live config lives in the install's config home, outside the
  // checkout — the accept applies to THAT file and commits nothing (the home
  // is not this repo). A QCR_CONFIG file not named config.toml cannot take a
  // `config.toml` patch, so it is refused rather than applied somewhere else.
  it("applies a config proposal to the config home's file, outside the checkout, without a commit", async () => {
    const home = join(root, "..", "cfg-home-" + Date.now());
    propose("calibrate-mention", CONFIG_PATCH);
    const gitCalls: string[][] = [];
    const res = await acceptProposal(
      {
        git: {
          run: (cmd, args) => {
            gitCalls.push([cmd, ...args]);
            return Promise.resolve("");
          },
        },
        repoRoot: root,
        today: () => "2026-08-30",
        configPath: join(home, "config.toml"),
      },
      "calibrate-mention",
    );
    expect(res.ok).toBe(true);
    // --check and the real apply target the home; between them the shadow
    // apply (post-image fences + parsed dry_run) targets a throwaway copy.
    expect(gitCalls.map((c) => c.slice(0, 2).join(" "))).toEqual([
      "git apply",
      "git apply",
      "git apply",
    ]);
    for (const call of [gitCalls[0]!, gitCalls[2]!]) {
      expect(call).toContain("--unsafe-paths");
      expect(call).toContain(`--directory=${home}`);
    }
    expect(gitCalls[1]).toContain("--unsafe-paths");
    expect(gitCalls[1]!.join(" ")).toMatch(/--directory=\S*qcr-proposal-/);
    expect(res.message).toContain(join(home, "config.toml"));
    expect(existsSync(join(root, "state/rubric/calibrate-mention"))).toBe(false);

    propose("calibrate-mention", CONFIG_PATCH);
    gitCalls.length = 0;
    const odd = await acceptProposal(
      {
        git: { run: (cmd, args) => (gitCalls.push([cmd, ...args]), Promise.resolve("")) },
        repoRoot: root,
        today: () => "2026-08-30",
        configPath: join(home, "mine.toml"),
      },
      "calibrate-mention",
    );
    expect(odd.ok).toBe(false);
    expect(odd.message).toContain("mine.toml");
    expect(gitCalls).toHaveLength(0);
  });

  // The fence check reads the file the patch LANDS on. With the live config in
  // the config home, reading the checkout's copy (absent, or a stale one with
  // no fence) would wave a fenced edit through.
  it("checks RATIFIED fences in the config home's file, not the checkout's", async () => {
    const home = join(root, "..", "cfg-home-fence-" + Date.now());
    mkdirSync(home, { recursive: true });
    const lines = Array.from({ length: 420 }, (_, i) => `k${i} = ${i}`);
    lines[406] = "# <!-- RATIFIED by the owner -->";
    lines[408] = "# most recent human author of the touched directive files, else this:";
    lines[409] = 'escalation_mention_default = "oldhandle"';
    lines[410] = "# <!-- /RATIFIED -->";
    writeFileSync(join(home, "config.toml"), lines.join("\n"));
    propose("calibrate-mention", CONFIG_PATCH);
    const gitCalls: string[][] = [];
    try {
      const res = await acceptProposal(
        {
          git: { run: (cmd, args) => (gitCalls.push([cmd, ...args]), Promise.resolve("")) },
          repoRoot: root,
          today: () => "2026-08-30",
          configPath: join(home, "config.toml"),
        },
        "calibrate-mention",
      );
      expect(res.ok).toBe(false);
      expect(res.message).toMatch(/RATIFIED/);
      expect(gitCalls).toHaveLength(0);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("refuses a config proposal touching dry_run, before touching git — rule 1, structural", async () => {
    propose(
      "flip-dry-run",
      `--- a/config.toml\n+++ b/config.toml\n@@ -4,1 +4,1 @@\n-dry_run = false\n+dry_run = true\n`,
    );
    const gitCalls: string[][] = [];
    const res = await acceptProposal(
      {
        git: {
          run: (cmd, args) => {
            gitCalls.push([cmd, ...args]);
            return Promise.resolve("");
          },
        },
        repoRoot: root,
        today: () => "2026-08-30",
      },
      "flip-dry-run",
    );
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/dry_run.*owner's alone/);
    expect(gitCalls).toHaveLength(0);
    expect(existsSync(join(root, "state/rubric/flip-dry-run"))).toBe(true); // a refusal never deletes the evidence
  });

  it("refuses a patch mixing config.toml with rubric targets — kinds never mix", async () => {
    propose("mixed", CONFIG_PATCH + PATCH);
    const res = await acceptProposal(
      { git: { run: () => Promise.resolve("") }, repoRoot: root, today: () => "2026-08-30" },
      "mixed",
    );
    expect(res.ok).toBe(false);
    expect(res.message).toContain("non-proposal paths");
  });

  it("refuses a patch that does not apply cleanly", async () => {
    propose("conflicting", PATCH);
    const res = await acceptProposal(
      {
        git: {
          run: (_cmd, args) =>
            args[1] === "--check"
              ? Promise.reject(new Error("does not apply"))
              : Promise.resolve(""),
        },
        repoRoot: root,
        today: () => "2026-08-20",
      },
      "conflicting",
    );
    expect(res.ok).toBe(false);
    expect(res.message).toContain("does not apply cleanly");
  });
});

// ---- selfscan2 (tui-learning): the accept path against a REAL git checkout.
// The fake-git suite above cannot see what `git apply` actually does — where
// it relocates a hunk, which sections it honours, what `git commit` sweeps
// up — and every defect below lived exactly there. A scratch repo in a temp
// dir, no network, no remote.
describe("acceptProposal against a real scratch checkout (selfscan2)", () => {
  let root: string;
  const gitEnv = {
    ...process.env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@example.invalid",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@example.invalid",
  };
  const run = (cmd: string, args: string[], stdin?: string): Promise<string> =>
    new Promise((res, rej) => {
      const child = execFile(cmd, args, { cwd: root, env: gitEnv }, (err, stdout, stderr) =>
        err ? rej(new Error(`${err.message}\n${stderr}`)) : res(stdout),
      );
      if (stdin !== undefined) child.stdin?.end(stdin);
    });
  const sh = (args: string[]): string =>
    execFileSync("git", args, { cwd: root, env: gitEnv, encoding: "utf8" });
  const deps = (): Parameters<typeof acceptProposal>[0] => ({
    git: { run },
    repoRoot: root,
    today: () => "2026-09-30",
  });
  const propose = (slug: string, patch: string): void => {
    mkdirSync(join(root, "state/rubric", slug), { recursive: true });
    writeFileSync(join(root, "state/rubric", slug, "PROPOSAL.md"), "## Rationale\n");
    writeFileSync(join(root, "state/rubric", slug, "changes.patch"), patch);
  };
  // A fenced prompt with enough tail that a shifted header lands outside it.
  const FENCED_LONG = [
    ...FENCED.split("\n").slice(0, 7),
    ...Array.from({ length: 20 }, (_, i) => `tail line ${i}`),
    "",
  ].join("\n");

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "accept-real-"));
    mkdirSync(join(root, "tests/fixtures"), { recursive: true });
    mkdirSync(join(root, "agents"), { recursive: true });
    mkdirSync(join(root, "prompts"), { recursive: true });
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "agents/pass-baseline.md"), "line one\nline two\n");
    writeFileSync(join(root, "prompts/round-first.md"), FENCED_LONG);
    writeFileSync(join(root, "prompts/round-next.md"), "alpha\nbeta\ngamma\ndelta\nepsilon\n");
    writeFileSync(join(root, "src/gate.ts"), "export const gate = 1;\n");
    writeFileSync(join(root, "config.toml"), "dry_run = true\n\n[ops]\nx = 1\n");
    writeFileSync(
      join(root, "tests/fixtures/seed-manifest.json"),
      JSON.stringify({ files: { "agents/pass-baseline.md": "old" } }),
    );
    writeFileSync(
      join(root, "tests/fixtures/ratified-divergence.json"),
      JSON.stringify({ files: {} }),
    );
    writeFileSync(join(root, ".gitignore"), "state/\n");
    sh(["init", "-q", "-b", "master"]);
    sh(["add", "-A"]);
    sh(["commit", "-q", "-m", "init"]);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("a hunk whose header is shifted off a RATIFIED fence is refused where git would APPLY it", async () => {
    // Real context from lines 3..5, declared at 20: the header-coordinate
    // check sees an edit at line 21 (outside the fence); git relocates it.
    propose(
      "shifted",
      `--- a/prompts/round-first.md\n+++ b/prompts/round-first.md\n@@ -20,3 +20,3 @@\n <!-- RATIFIED ci-gate — do not edit; owner only -->\n-ratified line A\n+quietly weakened line A\n ratified line B\n`,
    );
    const res = await acceptProposal(deps(), "shifted");
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/RATIFIED fence/);
    expect(readFileSync(join(root, "prompts/round-first.md"), "utf8")).toBe(FENCED_LONG);
    expect(sh(["log", "--format=%s"]).trim()).toBe("init");
  });

  it("a config patch that moves the root dry_run into a table is refused (parsed, not grepped)", async () => {
    propose(
      "rescope",
      `--- a/config.toml\n+++ b/config.toml\n@@ -1,1 +1,3 @@\n+"dry\\u005frun" = false\n+[calibration]\n dry_run = true\n`,
    );
    const res = await acceptProposal(deps(), "rescope");
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/dry_run/);
    expect(readFileSync(join(root, "config.toml"), "utf8")).toBe(
      "dry_run = true\n\n[ops]\nx = 1\n",
    );
  });

  it("a binary section naming src/ only in its diff --git header is refused, nothing applied", async () => {
    const binary = [
      "diff --git a/src/gate.ts b/src/gate.ts",
      "index 0000000000000000000000000000000000000000..1111111111111111111111111111111111111111 100644",
      "GIT binary patch",
      "literal 4",
      "LcmZ?wbYcJi0000",
      "",
      "literal 0",
      "HcmV?d00001",
      "",
    ].join("\n");
    const rubric = `diff --git a/prompts/round-next.md b/prompts/round-next.md\n--- a/prompts/round-next.md\n+++ b/prompts/round-next.md\n@@ -1,2 +1,3 @@\n alpha\n+alpha and a half\n beta\n`;
    expect(patchTargets(binary + rubric)).toContain("src/gate.ts");
    propose("binary-ride", binary + rubric);
    const res = await acceptProposal(deps(), "binary-ride");
    expect(res.ok).toBe(false);
    expect(readFileSync(join(root, "src/gate.ts"), "utf8")).toBe("export const gate = 1;\n");
    expect(sh(["status", "--porcelain"])).toBe("");
  });

  it("an unprefixed path that git strips out of prompts/ into src/ is refused, nothing written", async () => {
    // patchTargets reads `prompts/src/tui/evil.ts` (allowed); git -p1 strips
    // the first component and would create src/tui/evil.ts.
    propose(
      "strip-escape",
      `--- /dev/null\n+++ prompts/src/tui/evil.ts\n@@ -0,0 +1 @@\n+export const pwned = 1;\n`,
    );
    const res = await acceptProposal(deps(), "strip-escape");
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/src\/tui\/evil\.ts/);
    expect(existsSync(join(root, "src/tui/evil.ts"))).toBe(false);
    expect(sh(["status", "--porcelain"])).toBe("");
  });

  it("a mode-only section on an allowed target is refused at accept, nothing changed", async () => {
    propose(
      "chmod",
      "diff --git a/prompts/round-next.md b/prompts/round-next.md\nold mode 100644\nnew mode 100755\n",
    );
    const res = await acceptProposal(deps(), "chmod");
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/mode/);
    expect(sh(["status", "--porcelain"])).toBe("");
    expect(sh(["log", "--format=%s"]).trim()).toBe("init");
  });

  it("refuses binary and mode-only sections even on an allowed target", () => {
    expect(
      patchShapeViolation(
        "diff --git a/prompts/round-next.md b/prompts/round-next.md\nold mode 100644\nnew mode 100755\n",
      ),
    ).toMatch(/mode/);
    expect(
      patchShapeViolation(
        "diff --git a/agents/x.md b/agents/x.md\nnew file mode 120000\n--- /dev/null\n+++ b/agents/x.md\n@@ -0,0 +1 @@\n+../src/gate.ts\n",
      ),
    ).toMatch(/mode/);
    expect(
      patchShapeViolation(
        "diff --git a/agents/x.md b/agents/x.md\nGIT binary patch\nliteral 0\nHcmV?d00001\n",
      ),
    ).toMatch(/binary/);
    expect(patchShapeViolation(PATCH)).toBeNull();
    expect(
      patchShapeViolation(
        "diff --git a/agents/n.md b/agents/n.md\nnew file mode 100644\n--- /dev/null\n+++ b/agents/n.md\n@@ -0,0 +1 @@\n+x\n",
      ),
    ).toBeNull();
  });

  it("commits ONLY the proposal — someone else's staged work stays staged and uncommitted", async () => {
    writeFileSync(join(root, "src/gate.ts"), "export const gate = 2; // companion, mid-commit\n");
    sh(["add", "src/gate.ts"]);
    propose(
      "clean-edit",
      `--- a/prompts/round-next.md\n+++ b/prompts/round-next.md\n@@ -1,2 +1,3 @@\n alpha\n+alpha and a half\n beta\n`,
    );
    const res = await acceptProposal(deps(), "clean-edit");
    expect(res.ok).toBe(true);
    expect(sh(["show", "--name-only", "--format=", "HEAD"]).trim()).toBe("prompts/round-next.md");
    expect(sh(["diff", "--cached", "--name-only"]).trim()).toBe("src/gate.ts");
  });

  it("refuses a target with uncommitted edits — they would ride the acceptance commit", async () => {
    writeFileSync(
      join(root, "prompts/round-next.md"),
      "alpha\nbeta\ngamma\ndelta\nepsilon — the companion's in-flight edit\n",
    );
    propose(
      "dirty-target",
      `--- a/prompts/round-next.md\n+++ b/prompts/round-next.md\n@@ -1,2 +1,3 @@\n alpha\n+alpha and a half\n beta\n`,
    );
    const res = await acceptProposal(deps(), "dirty-target");
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/uncommitted/);
    expect(readFileSync(join(root, "prompts/round-next.md"), "utf8")).toBe(
      "alpha\nbeta\ngamma\ndelta\nepsilon — the companion's in-flight edit\n",
    );
    expect(sh(["log", "--format=%s"]).trim()).toBe("init");
    expect(existsSync(join(root, "state/rubric/dirty-target"))).toBe(true);
  });

  it("refuses deleting a seeded file before git ever sees it", async () => {
    propose(
      "drop-seed",
      `diff --git a/agents/pass-baseline.md b/agents/pass-baseline.md\ndeleted file mode 100644\n--- a/agents/pass-baseline.md\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-line one\n-line two\n`,
    );
    const res = await acceptProposal(deps(), "drop-seed");
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/seeded/);
    expect(existsSync(join(root, "agents/pass-baseline.md"))).toBe(true);
    expect(sh(["status", "--porcelain"])).toBe("");
  });

  it("a clean rubric patch still lands: applied, ratified, committed, dir removed", async () => {
    propose("seed-edit", PATCH);
    const res = await acceptProposal(deps(), "seed-edit");
    expect(res.ok).toBe(true);
    expect(sh(["show", "--name-only", "--format=", "HEAD"]).trim().split("\n").sort()).toEqual([
      "agents/pass-baseline.md",
      "seeds/agents/pass-baseline.md",
      "tests/fixtures/ratified-divergence.json",
      "tests/fixtures/seed-manifest.json",
    ]);
    expect(sh(["status", "--porcelain"])).toBe("");
  });
});
