// The state_explore git reader (packages/pi-plugin/src/stateexploregit.ts)
// against a scratch repository whose own configuration tries to run a
// program: core.fsmonitor, diff.external, a textconv driver every path
// uses, core.pager and core.sshCommand all point at a script that leaves a
// marker. Every action runs over the real git; no marker may appear. The
// argv and environment of every child are asserted through the injectable
// spawn, and the target check is driven with real paths and symlinks.
import { execFileSync, spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { stateExploreTool } from "@quickchatai/pi-quickreview/extensions/state-explore.js";
import {
  runStateExplore,
  type ExploreRequest,
} from "@quickchatai/pi-quickreview/src/stateexplore.js";
import {
  absolutePath,
  checkExploreTarget,
  EXPLORE_DIFF_FLAGS,
  EXPLORE_GIT_PINS,
  exploreGitEnv,
  gitExploreIo,
  type ExploreSpawn,
} from "@quickchatai/pi-quickreview/src/stateexploregit.js";

const PATH = process.env.PATH ?? "";

let root: string;
let repo: string;
let marker: string;
let base: string;
let head: string;

function git(args: string[], dir: string = repo): string {
  return execFileSync(
    "git",
    ["-c", "maintenance.auto=false", "-c", "gc.auto=0", "-C", dir, ...args],
    {
      env: {
        PATH,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        HOME: root,
        LC_ALL: "C",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  )
    .toString("utf8")
    .trim();
}

const SAVE_BASE = [
  "export async function save(form: Form) {",
  "  setSaving(true);",
  "  const r = await api.save(form);",
  "  if (!r.ok) {",
  "    return null;",
  "  }",
  "  return r.id;",
  "}",
  "",
].join("\n");
const SAVE_HEAD = SAVE_BASE.replace("  return r.id;", "  setSaving(false);\n  return r.id;");

beforeAll(() => {
  // Real paths throughout: the reader compares the repository git finds
  // with the worktree's real path.
  root = realpathSync(mkdtempSync(join(tmpdir(), "qcr-explore-git-")));
  repo = join(root, "wt");
  marker = join(root, "marker");
  mkdirSync(repo);
  const script = join(root, "hostile.sh");
  writeFileSync(script, `#!/bin/sh\necho "$0 $*" >> "${marker}"\ncat "$1" 2>/dev/null\nexit 0\n`);
  chmodSync(script, 0o755);
  git(["init", "-q"]);
  git(["config", "user.email", "bench@example.invalid"]);
  git(["config", "user.name", "bench"]);
  mkdirSync(join(repo, "src"));
  writeFileSync(join(repo, ".gitattributes"), "* diff=x\n");
  writeFileSync(join(repo, "src/save.ts"), SAVE_BASE);
  writeFileSync(join(repo, "src/other.ts"), "export function reset() {\n  setSaving(false);\n}\n");
  git(["add", "-A"]);
  git(["commit", "-qm", "base"]);
  base = git(["rev-parse", "HEAD"]);
  writeFileSync(join(repo, "src/save.ts"), SAVE_HEAD);
  symlinkSync("/etc/hostname", join(repo, "src/link.ts"));
  git(["add", "-A"]);
  git(["commit", "-qm", "head"]);
  head = git(["rev-parse", "HEAD"]);
  // A linked worktree of the same repository, added before the hostile
  // configuration (adding one runs the fsmonitor).
  git(["worktree", "add", "-q", "--detach", join(root, "linked"), head]);
  // The hostile configuration goes in after the commits, so only the reader
  // under test can trip it.
  for (const [k, v] of [
    ["core.fsmonitor", script],
    ["diff.external", script],
    ["diff.x.textconv", script],
    ["diff.x.command", script],
    ["core.pager", script],
    ["core.sshCommand", script],
  ] as const)
    git(["config", k, v]);
  // An uncommitted edit in the working tree: the reader must not see it.
  writeFileSync(join(repo, "src/other.ts"), "export function reset() {\n  this.planted = 1;\n}\n");
});

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

function io(spawnFn?: ExploreSpawn) {
  return gitExploreIo({
    worktree: repo,
    base,
    head,
    path: PATH,
    ...(spawnFn ? { spawn: spawnFn } : {}),
  });
}

const REQUESTS: ExploreRequest[] = [
  { action: "anchors" },
  { action: "writes", name: "saving" },
  { action: "reads", name: "planted" },
  { action: "exits", file: "src/save.ts", line: 3 },
  { action: "siblings", file: "src/save.ts", line: 7 },
];

describe("state_explore over git", () => {
  // MUTATIONS, each fails this: drop `-c core.fsmonitor=false` from the pins
  // (diff-tree runs the fsmonitor hook); add `--textconv` to the diff-tree
  // flags (the driver runs on both sides of every file).
  it("runs every action over committed objects and runs nothing from the repository", async () => {
    const out: Record<string, string> = {};
    for (const r of REQUESTS) {
      const x = io();
      expect(await x.verify()).toBeNull();
      out[r.action] = await runStateExplore(r, x);
    }
    expect(existsSync(marker)).toBe(false);
    expect(out.anchors).toContain(
      "[exit-gap] src/save.ts:7 (save) — `setSaving(false)` (added) comes before return@L8; not before return@L5",
    );
    expect(out.writes).toContain("src/other.ts:2  (reset)  [setter] setSaving(false);");
    // The planted working-tree edit is not committed, so it is not there.
    expect(out.reads).toContain("0 sites in 0 files");
    expect(out.exits).toContain(
      "- `setSaving(false)` (L7): before return@L8; missing before return@L5",
    );
    expect(out.siblings).toContain("src/other.ts:2  (reset)  setSaving(false);");
  });

  // MUTATION: pass PATH through as given — the empty and relative entries,
  // which a child would resolve against its own directory, stay and this
  // fails.
  it("keeps PATH's absolute entries only", () => {
    expect(absolutePath(":/usr/bin:bin:./x::/bin")).toBe("/usr/bin:/bin");
    expect(exploreGitEnv(":/usr/bin:.", "/a/b").PATH).toBe("/usr/bin");
  });

  // MUTATIONS, each fails this: spread `process.env` into the child's
  // environment; drop `--no-ext-diff` from the diff flags; read with
  // `git show` instead of `cat-file --batch`.
  it("every child is git with the pins, -C the worktree, a plumbing verb and the built environment", async () => {
    const calls: {
      command: string;
      args: string[];
      env: Record<string, string | undefined>;
      shell: unknown;
      cwd: unknown;
    }[] = [];
    const spy: ExploreSpawn = (command, args, options) => {
      calls.push({
        command,
        args: [...args],
        env: { ...(options.env ?? {}) },
        shell: options.shell,
        cwd: options.cwd,
      });
      return spawn(command, args, options);
    };
    for (const r of REQUESTS) await runStateExplore(r, io(spy));
    expect(calls.length).toBeGreaterThan(0);
    const verbs = new Set<string>();
    const n = EXPLORE_GIT_PINS.length;
    let discovered = 0;
    for (const c of calls) {
      expect(c.command).toBe("git");
      expect(c.shell).toBe(false);
      expect(c.cwd).toBe("/");
      expect(c.args.slice(0, n)).toEqual([...EXPLORE_GIT_PINS]);
      expect(c.args.slice(n, n + 2)).toEqual(["-c", `safe.directory=${repo}`]);
      expect(c.env).toEqual(exploreGitEnv(PATH, repo));
      // Only the one question "which repository is this" lets git discover
      // it; every other child names the accepted git directory.
      let rest = c.args.slice(n + 2);
      if (rest[0]?.startsWith("--git-dir=")) {
        expect(rest.slice(0, 4)).toEqual([
          `--git-dir=${join(repo, ".git")}`,
          `--work-tree=${repo}`,
          "-C",
          repo,
        ]);
        rest = rest.slice(4);
      } else {
        expect(rest.slice(0, 2)).toEqual(["-C", repo]);
        rest = rest.slice(2);
        expect(rest[1]).toBe("--path-format=absolute");
        discovered += 1;
      }
      verbs.add(rest[0]!);
      if (rest[0] === "diff-tree")
        expect(rest).toEqual(["diff-tree", ...EXPLORE_DIFF_FLAGS, base, head]);
      else if (rest[0] === "cat-file") expect(rest).toEqual(["cat-file", "--batch"]);
      else if (rest[0] === "ls-tree")
        expect(rest.slice(0, 5)).toEqual(["ls-tree", "--full-tree", "-r", "-l", "-z"]);
      else if (rest[0] === "rev-parse" && rest[1] !== "--path-format=absolute")
        expect(rest.slice(0, 3)).toEqual(["rev-parse", "--verify", "--quiet"]);
    }
    expect(discovered).toBe(REQUESTS.length);
    expect([...verbs].sort()).toEqual(["cat-file", "diff-tree", "ls-tree", "rev-parse"]);
    expect(EXPLORE_GIT_PINS).toContain("safe.bareRepository=explicit");
    expect(exploreGitEnv("/bin", "/srv/wt/pr-1")).toEqual({
      PATH: "/bin",
      GIT_CEILING_DIRECTORIES: "/srv/wt",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
      GIT_NO_LAZY_FETCH: "1",
      GIT_OPTIONAL_LOCKS: "0",
      LC_ALL: "C",
      HOME: "/nonexistent",
    });
    expect(EXPLORE_DIFF_FLAGS).toContain("--no-textconv");
    expect(EXPLORE_DIFF_FLAGS).toContain("--no-ext-diff");
  });

  it("serves regular blobs only: a committed symlink and an unknown path read as nothing", async () => {
    const x = io();
    const listing = (await x.listHead())!.map((e) => e.path).sort();
    expect(listing).toEqual([".gitattributes", "src/other.ts", "src/save.ts"]);
    expect(await x.readHead("src/link.ts")).toBeNull();
    expect(await x.readHead("src/none.ts")).toBeNull();
    expect(await x.readHead("src/other.ts")).toBe(
      "export function reset() {\n  setSaving(false);\n}\n",
    );
    expect(await x.readBase("src/save.ts")).toBe(SAVE_BASE);
    await x.close();
  });

  it("refuses a commit id that does not resolve, and reads nothing for it", async () => {
    const x = gitExploreIo({ worktree: repo, base: "0".repeat(40), head, path: PATH });
    expect(await x.verify()).toMatch(/^refused: `base` 000000000000 does not resolve to a commit/);
    expect(await x.listHead()).toBeNull();
    expect(await x.diff()).toBeNull();
    await x.close();
  });
});

/** A spawn that runs real git after rewriting its argv or environment: one
 * defence taken away, to show the other holds alone. */
function rewriting(
  args: (a: readonly string[]) => readonly string[],
  env: (e: Record<string, string>) => Record<string, string> = (e) => e,
): ExploreSpawn {
  return (command, a, options) =>
    spawn(command, [...args(a)], {
      ...options,
      env: env({ ...(options.env as Record<string, string>) }),
    });
}
const withoutPin =
  (pin: string) =>
  (a: readonly string[]): readonly string[] => {
    const i = a.indexOf(pin);
    return i > 0 && a[i - 1] === "-c" ? [...a.slice(0, i - 1), ...a.slice(i + 1)] : a;
  };
const withoutPinPrefix = (prefix: string) => (a: readonly string[]) =>
  withoutPin(a.find((x) => x.startsWith(prefix)) ?? "\0")(a);
const withoutEnv = (key: string) => (e: Record<string, string>) => {
  const { [key]: _drop, ...rest } = e;
  return rest;
};

describe("state_explore picks the repository, not git", () => {
  let secret: string;
  let secretHead: string;
  let hx: string;

  beforeAll(() => {
    // Another repository on the same machine, with a commit the attacker
    // knows; the reader must never read its objects.
    secret = join(root, "secret");
    mkdirSync(secret);
    git(["init", "-q"], secret);
    writeFileSync(join(secret, "s.ts"), "export const apiKey = 'SECRET-TOKEN';\n");
    git(["add", "-A"], secret);
    git(["-c", "user.email=s@example.invalid", "-c", "user.name=s", "commit", "-qm", "s"], secret);
    secretHead = git(["rev-parse", "HEAD"], secret);
    // A PR that commits a directory shaped like a bare repository whose
    // object store borrows the secret repository's.
    hx = join(root, "hx");
    mkdirSync(join(hx, "vendor/x/refs"), { recursive: true });
    mkdirSync(join(hx, "vendor/x/objects/info"), { recursive: true });
    git(["init", "-q"], hx);
    writeFileSync(join(hx, "vendor/x/HEAD"), "ref: refs/heads/main\n");
    writeFileSync(join(hx, "vendor/x/refs/.keep"), "");
    writeFileSync(
      join(hx, "vendor/x/objects/info/alternates"),
      `${join(secret, ".git/objects")}\n`,
    );
    git(["add", "-A"], hx);
    git(["-c", "user.email=h@example.invalid", "-c", "user.name=h", "commit", "-qm", "h"], hx);
  });

  const target = (worktree: string, spawnFn?: ExploreSpawn, b = base, h = head) =>
    gitExploreIo({
      worktree,
      base: b,
      head: h,
      path: PATH,
      ...(spawnFn ? { spawn: spawnFn } : {}),
    });

  // MUTATION: drop `safe.bareRepository=explicit` from EXPLORE_GIT_PINS — git
  // opens the committed directory as a bare repository, the refusal comes
  // from the top check instead, and the first expectation fails.
  it("refuses a committed directory shaped like a bare repository", async () => {
    const x = target(join(hx, "vendor/x"), undefined, secretHead, secretHead);
    expect(await x.verify()).toMatch(/is a bare repository, not a work tree/);
    expect(await x.listHead()).toBeNull();
    expect(await x.readHead("s.ts")).toBeNull();
    await x.close();
  });

  // MUTATION: accept whatever git directory git found (return it without
  // comparing it with `<worktree>/.git`) — the planted `.git` file lends the
  // reader the secret repository and the token is read.
  it("refuses a work tree whose .git names another repository", async () => {
    const plant = join(root, "plant");
    mkdirSync(plant);
    writeFileSync(join(plant, ".git"), `gitdir: ${join(secret, ".git")}\n`);
    const x = target(plant, undefined, secretHead, secretHead);
    expect(await x.verify()).toMatch(/is not that worktree's own/);
    expect(await x.readHead("s.ts")).toBeNull();
    await x.close();
  });

  // MUTATION: drop the comparison of the linked worktree's `gitdir` file
  // with `<worktree>/.git` — the forged `.git` file borrows the registered
  // worktree's directory and is accepted.
  it("accepts a registered linked worktree and refuses one that borrows its directory", async () => {
    const linked = target(join(root, "linked"));
    expect(await linked.verify()).toBeNull();
    expect(await linked.readHead("src/save.ts")).toBe(SAVE_HEAD);
    await linked.close();
    const forged = join(root, "forged");
    mkdirSync(forged);
    writeFileSync(join(forged, ".git"), `gitdir: ${join(repo, ".git/worktrees/linked")}\n`);
    const x = target(forged);
    expect(await x.verify()).toMatch(/is not that worktree's own/);
    await x.close();
  });

  // A worktree added with relative paths (`git worktree add --relative-paths`,
  // `worktree.useRelativePaths`) has a backlink relative to its admin
  // directory; it is written by hand here so any git version serves.
  // MUTATION: resolve the backlink without the admin directory
  // (`real(text.trim())` in stateexploregit.ts) — it resolves against the
  // process's cwd, the registered worktree is refused, and this fails.
  it("accepts a linked worktree whose backlink is relative, and refuses one that names another", async () => {
    const add = (name: string): string => {
      git([
        "-c",
        "core.fsmonitor=false",
        "worktree",
        "add",
        "-q",
        "--detach",
        join(root, name),
        head,
      ]);
      return join(repo, ".git", "worktrees", name);
    };
    const relAdmin = add("rel");
    const otherAdmin = add("rel-other");
    writeFileSync(join(relAdmin, "gitdir"), `${relative(relAdmin, join(root, "rel", ".git"))}\n`);
    writeFileSync(
      join(otherAdmin, "gitdir"),
      `${relative(otherAdmin, join(root, "rel", ".git"))}\n`,
    );
    const rel = target(join(root, "rel"));
    expect(await rel.verify()).toBeNull();
    expect(await rel.readHead("src/save.ts")).toBe(SAVE_HEAD);
    await rel.close();
    const other = target(join(root, "rel-other"));
    expect(await other.verify()).toMatch(/is not that worktree's own/);
    await other.close();
  });

  // MUTATIONS, each fails this: drop GIT_CEILING_DIRECTORIES from
  // exploreGitEnv (git finds the repository above and the first refusal
  // reads differently); drop the top-of-work-tree check (with the ceiling
  // taken away, a directory inside the worktree is accepted and its partial
  // listing would read as the whole tree).
  it("refuses a directory inside the worktree", async () => {
    const x = target(join(repo, "src"));
    expect(await x.verify()).toMatch(/no git repository at `worktree` itself/);
    await x.close();
    const y = target(
      join(repo, "src"),
      rewriting((a) => a, withoutEnv("GIT_CEILING_DIRECTORIES")),
    );
    expect(await y.verify()).toMatch(/not the top of its git work tree/);
    expect(await y.listHead()).toBeNull();
    await y.close();
  });

  // MUTATION: drop the `safe.directory=<worktree>` pin — a worktree owned by
  // another uid (a bind mount in the release image, whose system-level
  // `safe.directory` the reader does not load) is refused on every call.
  it("reads a worktree another uid owns, and names that refusal when git still refuses", async () => {
    const otherOwner = (e: Record<string, string>) => ({
      ...e,
      GIT_TEST_ASSUME_DIFFERENT_OWNER: "1",
    });
    const x = target(
      repo,
      rewriting((a) => a, otherOwner),
    );
    expect(await x.verify()).toBeNull();
    expect(await x.readHead("src/save.ts")).toBe(SAVE_HEAD);
    await x.close();
    const y = target(repo, rewriting(withoutPinPrefix("safe.directory="), otherOwner));
    expect(await y.verify()).toMatch(/does not trust the owner of `worktree`/);
    await y.close();
  });
});

describe("state_explore never fetches a missing object", () => {
  let lz: string;
  let lzBase: string;
  let lzHead: string;
  let lzMarker: string;

  beforeAll(() => {
    // A partial clone whose head blob is missing, with a promisor remote
    // whose upload-pack is a script that leaves a marker.
    lz = join(root, "lz");
    mkdirSync(lz);
    lzMarker = join(root, "lz-marker");
    const script = join(root, "upload.sh");
    writeFileSync(script, `#!/bin/sh\necho "$0 $*" >> "${lzMarker}"\nexit 1\n`);
    chmodSync(script, 0o755);
    git(["init", "-q"], lz);
    const commit = (m: string) =>
      git(["-c", "user.email=l@example.invalid", "-c", "user.name=l", "commit", "-qm", m], lz);
    writeFileSync(join(lz, "a.ts"), "function f() {\n  x = 1;\n}\n");
    git(["add", "-A"], lz);
    commit("b");
    lzBase = git(["rev-parse", "HEAD"], lz);
    writeFileSync(join(lz, "a.ts"), "function f() {\n  x = 2;\n  return;\n}\n");
    git(["add", "-A"], lz);
    commit("h");
    lzHead = git(["rev-parse", "HEAD"], lz);
    const blob = git(["rev-parse", "HEAD:a.ts"], lz);
    renameSync(
      join(lz, ".git/objects", blob.slice(0, 2), blob.slice(2)),
      join(root, "lz-moved-blob"),
    );
    for (const [k, v] of [
      ["core.repositoryformatversion", "1"],
      ["extensions.partialClone", "origin"],
      ["remote.origin.promisor", "true"],
      ["remote.origin.url", join(root, "nowhere")],
      ["remote.origin.uploadpack", script],
    ] as const)
      git(["config", k, v], lz);
  });

  /** Every action over the partial clone through `spawnFn`; did the
   * promisor's upload-pack run? */
  async function fetched(spawnFn: ExploreSpawn): Promise<boolean> {
    if (existsSync(lzMarker)) renameSync(lzMarker, `${lzMarker}.${Date.now()}`);
    for (const r of [
      { action: "anchors" },
      { action: "writes", name: "x" },
      { action: "exits", file: "a.ts", line: 2 },
    ] as const) {
      const x = gitExploreIo({
        worktree: lz,
        base: lzBase,
        head: lzHead,
        path: PATH,
        spawn: spawnFn,
      });
      await x.verify();
      await runStateExplore(r, x);
    }
    return existsSync(lzMarker) && readFileSync(lzMarker, "utf8") !== "";
  }

  it("the fixture bites: with both defences taken away the promisor runs", async () => {
    expect(
      await fetched(rewriting(withoutPin("protocol.allow=never"), withoutEnv("GIT_NO_LAZY_FETCH"))),
    ).toBe(true);
  });

  // MUTATION: drop GIT_NO_LAZY_FETCH from exploreGitEnv — with the protocol
  // pin taken away here, the promisor's upload-pack runs and this fails.
  it("GIT_NO_LAZY_FETCH holds on its own", async () => {
    expect(await fetched(rewriting(withoutPin("protocol.allow=never")))).toBe(false);
  });

  // MUTATION: drop `protocol.allow=never` from EXPLORE_GIT_PINS — with the
  // environment variable taken away here, the promisor's upload-pack runs
  // and this fails.
  it("protocol.allow=never holds on its own", async () => {
    expect(await fetched(rewriting((a) => a, withoutEnv("GIT_NO_LAZY_FETCH")))).toBe(false);
  });
});

describe("checkExploreTarget", () => {
  it("accepts the worktree under the session's directory, by real path", async () => {
    const ok = await checkExploreTarget(root, repo, base.toUpperCase(), head);
    expect(ok).toEqual({ ok: true, worktree: repo, base, head });
    expect(await checkExploreTarget(repo, repo, base, head)).toMatchObject({ ok: true });
  });

  // MUTATION: compare the paths as given instead of their real paths — the
  // symlink inside the session's directory that points outside it passes
  // and this fails.
  it("refuses a relative path, a path outside, a symlink out, a missing path and bad ids", async () => {
    const outside = mkdtempSync(join(tmpdir(), "qcr-explore-outside-"));
    const session = join(root, "session");
    mkdirSync(session, { recursive: true });
    symlinkSync(outside, join(session, "escape"));
    const refusal = async (wt: unknown, b: unknown = base, h: unknown = head) => {
      const r = await checkExploreTarget(session, wt, b, h);
      expect(r.ok, JSON.stringify(wt)).toBe(false);
      return r.ok ? "" : r.refusal;
    };
    expect(await refusal("wt")).toMatch(/absolute path/);
    expect(await refusal(repo)).toMatch(/not inside this session's working directory/);
    expect(await refusal(join(session, "escape"))).toMatch(
      /not inside this session's working directory/,
    );
    expect(await refusal(join(session, "missing"))).toMatch(/does not exist/);
    expect(await refusal(session, "abc123", head)).toMatch(/full commit ids/);
    expect(await refusal(session, base, null)).toMatch(/required on the first call/);
    rmSync(outside, { recursive: true, force: true });
  });

  // The one-shot routes (`qcr review`, `/qcr-review`) run the session in
  // `<run>/out` and check the review tree out at `<run>/tree`, beside it.
  // MUTATION: drop the isRoundWorktree test from checkExploreTarget — the
  // round's own tree is refused and this fails.
  // MUTATION: accept a path under the round's worktree instead of the
  // worktree itself — the subdirectory passes and this fails.
  it("accepts the round's own worktree beside the session's directory, and nothing else there", async () => {
    const run = mkdtempSync(join(tmpdir(), "qcr-explore-run-"));
    const out = join(run, "out");
    const tree = join(run, "tree");
    const other = join(run, "other");
    for (const d of [out, join(tree, "sub"), other]) mkdirSync(d, { recursive: true });
    symlinkSync(tree, join(run, "tree-link"));
    expect(await checkExploreTarget(out, tree, base, head)).toMatchObject({ ok: false });
    expect(await checkExploreTarget(out, tree, base, head, tree)).toEqual({
      ok: true,
      worktree: realpathSync(tree),
      base,
      head,
    });
    // By real path on both sides.
    expect(await checkExploreTarget(out, join(run, "tree-link"), base, head, tree)).toMatchObject({
      ok: true,
    });
    expect(await checkExploreTarget(out, tree, base, head, join(run, "tree-link"))).toMatchObject({
      ok: true,
    });
    for (const [wt, round] of [
      [other, tree],
      [join(tree, "sub"), tree],
      [tree, ""],
      [tree, "tree"],
      [tree, join(run, "missing")],
    ] as const) {
      const r = await checkExploreTarget(out, wt, base, head, round);
      expect(r, `${wt} / ${round}`).toEqual({
        ok: false,
        refusal: "refused: `worktree` is not inside this session's working directory",
      });
    }
    rmSync(run, { recursive: true, force: true });
  });
});

describe("a session verifies its target once", () => {
  /** A spawn that runs the real git and counts each child by its verb. */
  function counting(): { spawn: ExploreSpawn; verbs: string[] } {
    const verbs: string[] = [];
    const counted: ExploreSpawn = (cmd, args, opts) => {
      const n = args.indexOf("-C");
      const rest = args.slice(n + 2);
      verbs.push(rest[0] === "rev-parse" ? `rev-parse ${rest[1]}` : (rest[0] ?? ""));
      return spawn(cmd, args, opts);
    };
    return { spawn: counted, verbs };
  }
  const count = (verbs: string[], verb: string): number =>
    verbs.filter((v) => v.startsWith(verb)).length;
  const call = async (
    tool: ReturnType<typeof stateExploreTool>,
    params: Record<string, unknown>,
  ): Promise<string> => {
    const r = await tool.execute("c", params, undefined, undefined, undefined as never);
    const first = r.content[0];
    return first !== undefined && first.type === "text" ? first.text : "";
  };

  // The first call verifies (one `rev-parse --show-toplevel …` and two
  // `rev-parse --verify`) and lists the head tree; a later call over the same
  // target reuses the accepted git directory and the listing; a call that
  // changes `base` verifies again.
  // MUTATION: drop `if (gitDir !== null) reuse.verified = { gitDir };` in
  // stateExploreTool (extensions/state-explore.ts) — the second call verifies
  // again, six rev-parse children in all, and this fails.
  it("three rev-parse children for two calls over one target, and three more for a new base", async () => {
    const { spawn: counted, verbs } = counting();
    const tool = stateExploreTool({ cwd: root, path: PATH, spawn: counted });
    const first = await call(tool, {
      action: "writes",
      name: "saving",
      worktree: repo,
      base,
      head,
    });
    expect(first).not.toMatch(/refused|failed/);
    expect(count(verbs, "rev-parse")).toBe(3);
    const listed = count(verbs, "ls-tree");
    expect(listed).toBeGreaterThan(0);
    const second = await call(tool, { action: "writes", name: "saving" });
    expect(second).toBe(first);
    expect(count(verbs, "rev-parse")).toBe(3);
    // The head tree's listing is the session's: no second ls-tree for it.
    expect(count(verbs, "ls-tree")).toBe(listed);
    await call(tool, { action: "writes", name: "saving", base: head });
    expect(count(verbs, "rev-parse")).toBe(6);
  });

  // What a session reuses belongs to the target it verified: a later call
  // that names a worktree whose `.git` lends another repository is checked
  // from the start and refused, and the session keeps the target it had.
  // MUTATION: drop `reuse = { cache: newExploreGitCache() };` from the
  // changed-target branch of stateExploreTool — the new worktree inherits
  // the first target's accepted git directory, skips the own-repository
  // check, and the refusal this expects never comes.
  it("a reused verification never carries over to another worktree", async () => {
    const foreign = join(root, "session-foreign");
    mkdirSync(foreign);
    git(["init", "-q"], foreign);
    writeFileSync(join(foreign, "f.ts"), "export const token = 'FOREIGN';\n");
    git(["add", "-A"], foreign);
    git(["-c", "user.email=f@example.invalid", "-c", "user.name=f", "commit", "-qm", "f"], foreign);
    const foreignHead = git(["rev-parse", "HEAD"], foreign);
    const plant = join(root, "session-plant");
    mkdirSync(plant);
    writeFileSync(join(plant, ".git"), `gitdir: ${join(foreign, ".git")}\n`);

    const tool = stateExploreTool({ cwd: root, path: PATH });
    const first = await call(tool, {
      action: "writes",
      name: "saving",
      worktree: repo,
      base,
      head,
    });
    expect(first).not.toMatch(/refused|failed/);
    const moved = await call(tool, {
      action: "writes",
      name: "token",
      worktree: plant,
      base: foreignHead,
      head: foreignHead,
    });
    expect(moved).toMatch(/refused: .*is not that worktree's own/);
    expect(moved).not.toContain("FOREIGN");
    // The refused change keeps the verified target, still reused.
    expect(await call(tool, { action: "writes", name: "saving" })).toBe(first);
  });
});
