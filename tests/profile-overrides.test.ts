// Profile overrides of shipped agents and prompts, and the "customised" mark
// (src/profileoverrides.ts): the user's named profile and the repo's `.qcr/`
// (read from the BASE commit) may replace a shipped file; one replacement with
// different bytes makes the run customised, none leaves it exactly as it was;
// the repo profile can say less than the user's; nothing here writes a seed.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { parse as parseToml } from "smol-toml";
import { parseConfig } from "../src/config.js";
import { buildAgents } from "../src/include.js";
import { configHome, EXAMPLE_PROFILES, type InstallEnv } from "../src/install.js";
import { loadProfileEcosystem, loadProfileLensTuning } from "../src/profiles.js";
import {
  assessOverrides,
  customisedNote,
  extractRepoProfile,
  loadSeedManifest,
  overrideReader,
  resolveOverrides,
} from "../src/profileoverrides.js";
import {
  assemblePostReview,
  QCR_CUSTOMISED_MARKER,
  QCR_VISIBLE_MARKER,
} from "../src/reviewpost.js";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const sha = (s: string): string => createHash("sha256").update(s).digest("hex");

let dir: string;
let env: InstallEnv;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "qcr-profile-overrides-"));
  env = { HOME: join(dir, "home"), XDG_CONFIG_HOME: join(dir, "xdg-config") };
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const put = (path: string, text: string): void => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
};

/** A small app root: two seeded files and one of ours, with the manifest baked. */
function fakeRoot(): string {
  const root = join(dir, "app");
  put(
    join(root, "agents", "pass-security.md"),
    "---\nname: pass-security\n---\nshipped security\n",
  );
  put(join(root, "agents", "pass-intent.md"), "---\nname: pass-intent\n---\nshipped intent\n");
  put(join(root, "prompts", "conversation-system.md"), "shipped conversation\n");
  put(
    join(root, "seed-manifest.json"),
    JSON.stringify({
      files: {
        "agents/pass-security.md": sha(
          readFileSync(join(root, "agents", "pass-security.md"), "utf8"),
        ),
        "prompts/conversation-system.md": sha("shipped conversation\n"),
      },
    }),
  );
  return root;
}

/** A user profile `name` in the install's config home. */
function userProfile(name: string, files: Record<string, string>): void {
  const p = join(configHome(env), "profiles", name);
  mkdirSync(join(p, "addenda"), { recursive: true });
  writeFileSync(join(p, "profile.toml"), "");
  for (const [rel, text] of Object.entries(files)) put(join(p, rel), text);
}

describe("the customised mark", () => {
  it("no override gives customised = false, with no reader and no manifest read", () => {
    const root = join(dir, "bare"); // no manifest, no agents: nothing to compare against
    mkdirSync(root);
    userProfile("plain", {});
    const set = resolveOverrides({ root, profile: "plain", lookup: { env } });
    expect(set.layers.map((l) => l.origin)).toEqual(["user"]);
    expect(assessOverrides(root, set)).toEqual({ customised: false, overrides: [] });
    expect(overrideReader(root, set)).toBeUndefined();
  });

  it("one override gives customised = true and names the file", () => {
    const root = fakeRoot();
    userProfile("mine", { "agents/pass-security.md": "---\nname: pass-security\n---\nmine\n" });
    const set = resolveOverrides({ root, profile: "mine", lookup: { env } });
    const c = assessOverrides(root, set);
    expect(c.customised).toBe(true);
    expect(c.overrides).toEqual([
      {
        path: "agents/pass-security.md",
        origin: "user",
        layer: "mine",
        sha256: sha("---\nname: pass-security\n---\nmine\n"),
        shipped_sha256: sha("---\nname: pass-security\n---\nshipped security\n"),
        seed: true,
      },
    ]);
    expect(customisedNote(c)).toMatch(
      /1 shipped file replaced.*agents\/pass-security\.md \(user profile\)/,
    );
    // the reader serves the replacement for that path and the disk for the rest
    const read = overrideReader(root, set)!;
    expect(read(join(root, "agents", "pass-security.md"))).toContain("mine");
    expect(read(join(root, "agents", "pass-intent.md"))).toContain("shipped intent");
  });

  it("a byte-identical copy of a seed marks nothing", () => {
    const root = fakeRoot();
    userProfile("copy", {
      "agents/pass-security.md": readFileSync(join(root, "agents", "pass-security.md"), "utf8"),
    });
    const set = resolveOverrides({ root, profile: "copy", lookup: { env } });
    expect(assessOverrides(root, set)).toEqual({ customised: false, overrides: [] });
  });

  it("a file of ours (not a seed) is compared by its own hash", () => {
    const root = fakeRoot();
    userProfile("mine", { "agents/pass-intent.md": "---\nname: pass-intent\n---\nmine\n" });
    const c = assessOverrides(root, resolveOverrides({ root, profile: "mine", lookup: { env } }));
    expect(c.overrides.map((o) => [o.path, o.seed])).toEqual([["agents/pass-intent.md", false]]);
  });

  it("a replacement of a seed is judged against the manifest, not the file on disk", () => {
    const root = fakeRoot();
    const manifest = loadSeedManifest(root)!;
    expect(Object.keys(manifest)).toContain("agents/pass-security.md");
    userProfile("mine", {
      // equal to the disk file the manifest does NOT vouch for: still different
      "agents/pass-security.md": "---\nname: pass-security\n---\nshipped security\n",
    });
    writeFileSync(
      join(root, "seed-manifest.json"),
      JSON.stringify({ files: { "agents/pass-security.md": sha("something else") } }),
    );
    const c = assessOverrides(root, resolveOverrides({ root, profile: "mine", lookup: { env } }));
    expect(c.customised).toBe(true);
  });

  it("a file with no shipped namesake replaces nothing and is reported", () => {
    const root = fakeRoot();
    userProfile("mine", { "agents/pass-invented.md": "---\nname: pass-invented\n---\nx\n" });
    const set = resolveOverrides({ root, profile: "mine", lookup: { env } });
    expect(set.ignored.join("\n")).toMatch(/agents\/pass-invented\.md.*no shipped file/);
    expect(assessOverrides(root, set).customised).toBe(false);
    expect(overrideReader(root, set)).toBeUndefined();
  });

  it("a user replacement over the size cap is reported, not dropped silently", () => {
    const root = fakeRoot();
    userProfile("mine", { "agents/pass-security.md": "x".repeat(256 * 1024 + 1) });
    const set = resolveOverrides({ root, profile: "mine", lookup: { env } });
    expect(set.ignored.join("\n")).toMatch(/mine\/agents\/pass-security\.md: over the size cap/);
    expect(assessOverrides(root, set).customised).toBe(false);
  });

  it("the shipped example profiles replace nothing, so a stock install is never customised", () => {
    for (const name of EXAMPLE_PROFILES) {
      for (const sub of ["agents", "prompts"])
        expect(existsSync(join(REPO_ROOT, "profiles", name, sub)), `${name}/${sub}`).toBe(false);
    }
  });

  it("the posted review says so in its visible marker", () => {
    const record = { findings: [], verdict: "COMMENT" };
    const cfg = parseConfig(readFileSync(join(REPO_ROOT, "tests/fixtures/config.toml"), "utf8"));
    const common = { cfg, roundNo: 1, lenses: ["pass-security"] };
    const plain = assemblePostReview(record, common);
    const custom = assemblePostReview(record, { ...common, customised: true });
    expect(plain.body).toContain(QCR_VISIBLE_MARKER);
    expect(plain.body).not.toContain(QCR_CUSTOMISED_MARKER);
    expect(custom.body).toContain(QCR_CUSTOMISED_MARKER);
    expect(custom.body).not.toContain(QCR_VISIBLE_MARKER);
  });
});

describe("agents built from a replacement", () => {
  const agentsDir = join(REPO_ROOT, "agents");
  const build = (out: string, readFile?: (p: string) => string): Record<string, string> => {
    buildAgents(agentsDir, out, { root: REPO_ROOT, ...(readFile ? { readFile } : {}) });
    return Object.fromEntries(readdirSync(out).map((f) => [f, readFileSync(join(out, f), "utf8")]));
  };

  it("a replaced agent body reaches the built agent and every other agent is byte-identical", () => {
    userProfile("mine", {
      "agents/pass-security.md": readFileSync(join(agentsDir, "pass-security.md"), "utf8").replace(
        /\n---\n/,
        "\n---\nHOUSE RULE: profile body marker.\n",
      ),
    });
    const set = resolveOverrides({ root: REPO_ROOT, profile: "mine", lookup: { env } });
    const read = overrideReader(REPO_ROOT, set)!;
    const stock = build(join(dir, "stock"));
    const custom = build(join(dir, "custom"), read);
    expect(Object.keys(custom).sort()).toEqual(Object.keys(stock).sort());
    const changed = Object.keys(stock).filter((f) => stock[f] !== custom[f]);
    expect(changed.length).toBeGreaterThan(0);
    for (const f of changed) {
      expect(f).toMatch(/^pass-security--/);
      expect(custom[f]).toContain("HOUSE RULE: profile body marker.");
    }
  });

  it("a replaced agent still cannot grant a spawn tool: passes stay leaves", () => {
    userProfile("mine", {
      "agents/pass-security.md": readFileSync(join(agentsDir, "pass-security.md"), "utf8").replace(
        /^tools:.*$/m,
        "tools: read, bash, subagent, launch_plan",
      ),
    });
    const set = resolveOverrides({ root: REPO_ROOT, profile: "mine", lookup: { env } });
    const out = build(join(dir, "custom"), overrideReader(REPO_ROOT, set)!);
    for (const [f, text] of Object.entries(out)) {
      if (!f.startsWith("pass-security--")) continue;
      const tools = /^tools:.*$/m.exec(text)?.[0] ?? "";
      expect(tools).toMatch(/bash/);
      expect(tools).not.toMatch(/subagent|launch_plan/);
    }
  });
});

// ---- the repo profile ---------------------------------------------------------------

const git = (cwd: string, ...args: string[]): string =>
  execFileSync(
    "git",
    ["-c", "user.name=T", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args],
    { cwd, encoding: "utf8" },
  ).trim();

/** A repo whose BASE commit carries a `.qcr/` and whose HEAD changes it. */
function repoWithProfile(): { repo: string; base: string; head: string } {
  const repo = join(dir, "repo");
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  put(join(repo, "src.ts"), "x\n");
  put(
    join(repo, ".qcr", "profile.toml"),
    [
      'ecosystem = "django"',
      "dry_run = false",
      'extends = "default"',
      "[github]",
      'secrets_dir = "/steal"',
      "[lenses.pass-security]",
      'emphasis = "repo emphasis"',
    ].join("\n"),
  );
  put(
    join(repo, ".qcr", "agents", "pass-security.md"),
    "---\nname: pass-security\n---\nbase body\n",
  );
  put(join(repo, ".qcr", "prompts", "conversation-system.md"), "base conversation\n");
  put(join(repo, ".qcr", "extensions", "bash-guard.ts"), "export default {};\n");
  put(join(repo, ".qcr", "config.toml"), "dry_run = false\n");
  put(join(repo, ".qcr", "agents", "bad name.md"), "x\n");
  symlinkSync("/etc/passwd", join(repo, ".qcr", "agents", "pass-ui.md"));
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "base");
  const base = git(repo, "rev-parse", "HEAD");
  git(repo, "checkout", "-q", "-b", "feature");
  put(
    join(repo, ".qcr", "agents", "pass-security.md"),
    "---\nname: pass-security\n---\nHEAD body\n",
  );
  put(
    join(repo, ".qcr", "agents", "pass-delivery.md"),
    "---\nname: pass-delivery\n---\nHEAD only\n",
  );
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "head edits the profile");
  put(join(repo, ".qcr", "agents", "pass-security.md"), "uncommitted edit\n");
  return { repo, base, head: git(repo, "rev-parse", "HEAD") };
}

describe("the repo profile is read from the base commit", () => {
  it("takes the base's files, never the head's or the working tree's", () => {
    const { repo, base } = repoWithProfile();
    const r = extractRepoProfile({ gitDir: repo, ref: base, destDir: join(dir, "x") });
    expect(r.dir).toBe(join(dir, "x"));
    expect(readFileSync(join(dir, "x", "agents", "pass-security.md"), "utf8")).toContain(
      "base body",
    );
    expect(existsSync(join(dir, "x", "agents", "pass-delivery.md"))).toBe(false);
    expect(readFileSync(join(dir, "x", "prompts", "conversation-system.md"), "utf8")).toBe(
      "base conversation\n",
    );
  });

  it("drops what a repo may not carry and says so", () => {
    const { repo, base } = repoWithProfile();
    const r = extractRepoProfile({ gitDir: repo, ref: base, destDir: join(dir, "x") });
    expect(existsSync(join(dir, "x", "extensions"))).toBe(false);
    expect(existsSync(join(dir, "x", "config.toml"))).toBe(false);
    expect(existsSync(join(dir, "x", "agents", "pass-ui.md"))).toBe(false); // a symlink
    expect(existsSync(join(dir, "x", "agents", "bad name.md"))).toBe(false);
    const said = r.ignored.join("\n");
    expect(said).toMatch(/extensions\/bash-guard\.ts: not a file a repo profile may carry/);
    expect(said).toMatch(/config\.toml: not a file/);
    expect(said).toMatch(/pass-ui\.md: not a regular file/);
    expect(said).toMatch(/"dry_run" is guarded/);
    expect(said).toMatch(/"github" is guarded/);
    expect(said).toMatch(/"extends" is not a key a repo profile may set/);
    // what survives of profile.toml: only the keys a repo may set
    const toml = parseToml(readFileSync(join(dir, "x", "profile.toml"), "utf8"));
    expect(Object.keys(toml).sort()).toEqual(["ecosystem", "lenses"]);
  });

  it("no .qcr/ on the base is no repo profile, even when the head adds one", () => {
    const repo = join(dir, "plain");
    mkdirSync(repo);
    git(repo, "init", "-q", "-b", "main");
    put(join(repo, "a.ts"), "x\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "base");
    const base = git(repo, "rev-parse", "HEAD");
    put(join(repo, ".qcr", "agents", "pass-security.md"), "head only\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "head");
    const r = extractRepoProfile({ gitDir: repo, ref: base, destDir: join(dir, "x") });
    expect(r).toEqual({ dir: null, ignored: [] });
    expect(existsSync(join(dir, "x"))).toBe(false);
  });

  it("is read from a commit, nothing else", () => {
    const { repo } = repoWithProfile();
    for (const ref of ["feature", "HEAD~1", "--help", ""])
      expect(() => extractRepoProfile({ gitDir: repo, ref, destDir: join(dir, "x") })).toThrow(
        /from a commit/,
      );
  });

  it("an invalid profile.toml on the base is a loud failure, not a silent skip", () => {
    const repo = join(dir, "broken");
    mkdirSync(repo);
    git(repo, "init", "-q", "-b", "main");
    put(join(repo, ".qcr", "profile.toml"), "this is = = not toml");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "base");
    expect(() =>
      extractRepoProfile({
        gitDir: repo,
        ref: git(repo, "rev-parse", "HEAD"),
        destDir: join(dir, "x"),
      }),
    ).toThrow(/not valid TOML/);
  });

  it("layers under the user's profile: the repo's file applies alone, the user's wins a clash", () => {
    const root = fakeRoot();
    const { repo, base } = repoWithProfile();
    // the repo profile names two shipped files this root has
    const noRoot = resolveOverrides({
      root,
      profile: "",
      repo: { gitDir: repo, baseRef: base, destDir: join(dir, "r1") },
    });
    const only = assessOverrides(root, noRoot);
    expect(only.overrides.map((o) => [o.path, o.origin, o.layer])).toEqual([
      ["agents/pass-security.md", "repo", ".qcr"],
      ["prompts/conversation-system.md", "repo", ".qcr"],
    ]);
    userProfile("mine", {
      "agents/pass-security.md": "---\nname: pass-security\n---\nuser body\n",
    });
    const both = resolveOverrides({
      root,
      profile: "mine",
      lookup: { env },
      repo: { gitDir: repo, baseRef: base, destDir: join(dir, "r2") },
    });
    const c = assessOverrides(root, both);
    expect(c.overrides.map((o) => [o.path, o.origin])).toEqual([
      ["agents/pass-security.md", "user"],
      ["prompts/conversation-system.md", "repo"],
    ]);
    const read = overrideReader(root, both)!;
    expect(read(join(root, "agents", "pass-security.md"))).toContain("user body");
    expect(read(join(root, "prompts", "conversation-system.md"))).toBe("base conversation\n");
  });

  it("its tuning reaches the loaders as the lowest layer, under the named profile", () => {
    const root = fakeRoot();
    const { repo, base } = repoWithProfile();
    const set = resolveOverrides({
      root,
      profile: "",
      lookup: { env },
      repo: { gitDir: repo, baseRef: base, destDir: join(dir, "r1") },
    });
    // no named profile: the repo's tuning and ecosystem alone
    expect(loadProfileLensTuning(root, "", set.lookup)["pass-security"]?.emphasis).toBe(
      "repo emphasis",
    );
    expect(loadProfileEcosystem(root, "", set.lookup)).toBe("django");
    // without the repo layer, nothing
    expect(loadProfileLensTuning(root, "", { env })).toEqual({});
    expect(loadProfileEcosystem(root, "", { env })).toBe("none");
    // a named profile that sets the same key wins
    userProfile("mine", {});
    writeFileSync(
      join(configHome(env), "profiles", "mine", "profile.toml"),
      'ecosystem = "none"\n[lenses.pass-security]\nemphasis = "user emphasis"\n',
    );
    const layered = resolveOverrides({
      root,
      profile: "mine",
      lookup: { env },
      repo: { gitDir: repo, baseRef: base, destDir: join(dir, "r2") },
    });
    expect(loadProfileLensTuning(root, "mine", layered.lookup)["pass-security"]?.emphasis).toBe(
      "user emphasis",
    );
    expect(loadProfileEcosystem(root, "mine", layered.lookup)).toBe("none");
  });
});
