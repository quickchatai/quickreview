// The improvement channel END TO END against REAL git — the second
// real-subprocess test in the suite, beside worktrees.test.ts, and for the
// same reason: the thing under test is where git runs. For the channel's whole
// life every git step ran with no cwd, in the daemon's own checkout — a repo
// with no remote — so the push could never succeed; a fake runner that
// discarded its cwd kept the suite green over it. Reading the guard cannot
// review that claim; only running the pipeline against a repo with a remote
// can. No network: a bare repo in a temp dir is the "GitHub" end, cloned over
// a file path, and the production runner (`gitRunner(nodeExec)`, the exact
// function wire.ts installs) drives every step.
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseConfig, type Config } from "../src/config.js";
import { MutationGate, type MutationIntent } from "../src/gate.js";
import { GitHubAdapter } from "../src/github.js";
import type { TokenMinter } from "../src/githubAuth.js";
import { fileImprovementPr, gitRunner, type ImprovementContext } from "../src/improvements.js";
import { StateStore } from "../src/state.js";
import { nodeExec } from "../src/tmux.js";

const cfg: Config = parseConfig(readFileSync(join(process.cwd(), "tests/fixtures/config.toml"), "utf8"));
const BASE = cfg.github.base_branch;

const fakeMinter = {
  appJwt: () => "jwt",
  installationToken: async () => "tok",
  invalidate: () => {},
} as unknown as TokenMinter;

let tmp: string;
/** The bare "GitHub" end. */
let remote: string;
/** A human's clone: seeds the remote and, later, advances its base branch. */
let seed: string;
/** The reviewed repo's base clone — `WorktreeManager.basePath` in production. */
let clone: string;
let scratch: string;
let store: StateStore;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    },
  });
}

function commitLines(cwd: string, file: string, lines: number, message: string): string {
  mkdirSync(join(cwd, file, ".."), { recursive: true });
  writeFileSync(join(cwd, file), Array.from({ length: lines }, (_, i) => `line ${i + 1}`).join("\n") + "\n");
  git(cwd, "add", file);
  git(cwd, "commit", "-q", "-m", message);
  return git(cwd, "rev-parse", "HEAD").trim();
}

/** What the EOD session does: a branch off the FRESH base with one small commit. */
function prepareBranch(branch: string, file: string, lines: number): string {
  git(clone, "fetch", "-q", "origin", `+refs/heads/${BASE}:refs/remotes/origin/${BASE}`);
  git(clone, "branch", "-q", branch, `origin/${BASE}`);
  git(clone, "checkout", "-q", branch);
  const sha = commitLines(clone, file, lines, `improve ${file}`);
  git(clone, "checkout", "-q", "--detach", `origin/${BASE}`);
  return sha;
}

function remoteHeads(): Record<string, string> {
  const heads: Record<string, string> = {};
  for (const line of git(remote, "for-each-ref", "--format=%(refname) %(objectname)", "refs/heads/").trim().split("\n")) {
    if (!line) continue;
    const [ref, sha] = line.split(" ");
    heads[ref!] = sha!;
  }
  return heads;
}

function context(gate: MutationGate, adapter: GitHubAdapter): ImprovementContext {
  return {
    cfg,
    adapter,
    gate,
    store,
    run: gitRunner(nodeExec),
    ensureRepoDir: async () => clone,
    scratchDir: scratch,
  };
}

function dryRunIntents(dir: string): MutationIntent[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .sort()
    .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as MutationIntent);
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "qcr-improve-e2e-"));
  remote = join(tmp, "remote.git");
  seed = join(tmp, "seed");
  clone = join(tmp, "example-app");
  scratch = join(tmp, "state", "scratch-improve");
  git(tmp, "init", "-q", "--bare", "-b", BASE, remote);
  git(tmp, "init", "-q", "-b", BASE, seed);
  git(seed, "remote", "add", "origin", remote);
  commitLines(seed, "README.md", 3, "seed");
  git(seed, "push", "-q", "-u", "origin", BASE);
  // The production shape: a clone whose `origin` IS the reviewed repo.
  git(tmp, "clone", "-q", remote, clone);
  store = new StateStore(":memory:");
});

afterEach(() => {
  store.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("improvement channel end to end — real git, a repo with a remote", () => {
  it("DRY-RUN: the whole path runs — fresh base, scratch worktree, diffstat, gate — and the push lands in state/dryrun/, never on the remote", async () => {
    const dryrun = join(tmp, "state", "dryrun");
    const gate = new MutationGate(true, dryrun, async () => {
      throw new Error("executor must not run in dry-run");
    });
    const adapter = new GitHubAdapter(cfg, fakeMinter, gate, (async () => {
      throw new Error("no direct fetch expected");
    }) as unknown as typeof fetch);
    const before = remoteHeads();
    const sha = prepareBranch("wip/docs", "docs/readme.md", 10);

    const out = await fileImprovementPr(
      { branch: "wip/docs", title: "Docs: clarify retry", body: "rationale", slug: "clarify-retry" },
      context(gate, adapter),
    );

    expect(out).toMatchObject({ ok: true, branch: "bot/improve-clarify-retry", files: 1, lines: 10, pushed: false, pr: null, dry_run: true });
    const intents = dryRunIntents(dryrun);
    expect(intents.map((i) => i.kind)).toEqual(["push_branch", "create_pull", "add_label"]);
    expect(intents[0]).toMatchObject({
      method: "git",
      path: "git push origin wip/docs:refs/heads/bot/improve-clarify-retry",
      body: { remote: "origin", source: "wip/docs", target: "bot/improve-clarify-retry" },
    });
    // Suppressed means suppressed: the remote is byte-for-byte what it was.
    expect(remoteHeads()).toEqual(before);
    expect(git(clone, "rev-parse", "wip/docs").trim()).toBe(sha);
    // The scratch worktree was real (git knew it) and is gone again.
    expect(existsSync(scratch)).toBe(false);
    expect(git(clone, "worktree", "list")).not.toContain("scratch-improve");
    expect(store.filedSince("improvement_pr", "1970-01-01T00:00:00.000Z")).toBe(1);
  });

  it("LIVE: the push completes through the gate — exactly one new ref on the remote, bot/improve-<slug>, the base untouched", async () => {
    const seen: string[] = [];
    const gate = new MutationGate(false, join(tmp, "state", "dryrun"), async (i) => {
      if (i.method === "git") throw new Error("the REST executor must never perform a git push");
      return { number: 77 };
    });
    gate.setGuard({
      before: async (i) => {
        seen.push(i.kind);
        return {};
      },
    });
    const adapter = new GitHubAdapter(cfg, fakeMinter, gate, (async () => {
      throw new Error("no direct fetch expected");
    }) as unknown as typeof fetch);
    const before = remoteHeads();
    const sha = prepareBranch("wip/docs", "docs/readme.md", 10);

    const out = await fileImprovementPr(
      { branch: "wip/docs", title: "Docs: clarify retry", body: "rationale", slug: "clarify-retry" },
      context(gate, adapter),
    );

    expect(out).toMatchObject({ ok: true, branch: "bot/improve-clarify-retry", pushed: true, pr: 77, dry_run: false });
    expect(seen).toEqual(["push_branch", "create_pull", "add_label"]);
    const after = remoteHeads();
    // Rule 4, observed on the remote rather than read off the intent: the
    // ONLY ref that appeared is bot/improve-<slug>, at the prepared commit,
    // and the base branch is exactly where it was.
    expect(after).toEqual({ ...before, "refs/heads/bot/improve-clarify-retry": sha });
    expect(after[`refs/heads/${BASE}`]).toBe(before[`refs/heads/${BASE}`]);
    expect(existsSync(scratch)).toBe(false);
    expect(store.filedSince("improvement_pr", "1970-01-01T00:00:00.000Z")).toBe(1);
    const kinds = store.eventsOn(new Date().toISOString().slice(0, 10)).map((e) => e.kind);
    expect(kinds).toContain("branch_pushed");
    expect(kinds).toContain("improvement_pr_filed");
  });

  it("LIVE: a push the remote refuses is a loud rejection — no branch_pushed, no PR, nothing filed", async () => {
    // A git step that fails must FAIL. The daemon's first runner returned
    // stdout whatever the exit code, so a refused push would have been
    // recorded as pushed and a PR opened against a branch that did not exist.
    writeFileSync(join(remote, "hooks", "pre-receive"), "#!/bin/sh\necho 'policy: refused' >&2\nexit 1\n");
    chmodSync(join(remote, "hooks", "pre-receive"), 0o755);
    const seen: string[] = [];
    const gate = new MutationGate(false, join(tmp, "state", "dryrun"), async () => ({ number: 78 }));
    gate.setGuard({
      before: async (i) => {
        seen.push(i.kind);
        return {};
      },
    });
    const adapter = new GitHubAdapter(cfg, fakeMinter, gate, (async () => {
      throw new Error("no direct fetch expected");
    }) as unknown as typeof fetch);
    const before = remoteHeads();
    prepareBranch("wip/docs", "docs/readme.md", 10);

    const out = await fileImprovementPr(
      { branch: "wip/docs", title: "Docs: clarify retry", body: "rationale", slug: "clarify-retry" },
      context(gate, adapter),
    );

    expect(out.ok).toBe(false);
    expect(out.reason).toContain("improvement-PR pipeline failed");
    expect(out.reason).toContain("policy: refused");
    expect(seen).toEqual(["push_branch"]);
    expect(remoteHeads()).toEqual(before);
    const kinds = store.eventsOn(new Date().toISOString().slice(0, 10)).map((e) => e.kind);
    expect(kinds).not.toContain("branch_pushed");
    expect(kinds).toContain("improvement_pr_rejected");
    expect(store.filedSince("improvement_pr", "1970-01-01T00:00:00.000Z")).toBe(0);
    expect(existsSync(scratch)).toBe(false);
  });

  it("the caps bind on the real diffstat: 51 lines refused, a denylisted path refused, nothing reaches the gate or the remote", async () => {
    const dryrun = join(tmp, "state", "dryrun");
    const gate = new MutationGate(true, dryrun, async () => {
      throw new Error("executor must not run in dry-run");
    });
    const adapter = new GitHubAdapter(cfg, fakeMinter, gate, (async () => {
      throw new Error("no direct fetch expected");
    }) as unknown as typeof fetch);
    const before = remoteHeads();

    prepareBranch("wip/big", "src/big.ts", 51);
    const big = await fileImprovementPr({ branch: "wip/big", title: "t", body: "b", slug: "big" }, context(gate, adapter));
    expect(big.ok).toBe(false);
    expect(big.reason).toContain("51 changed lines > cap 50");

    prepareBranch("wip/infra", "infra/main.tf", 1);
    const infra = await fileImprovementPr({ branch: "wip/infra", title: "t", body: "b", slug: "infra" }, context(gate, adapter));
    expect(infra.ok).toBe(false);
    expect(infra.reason).toContain("path denylist");

    // And the boundary itself, on real git: exactly 50 lines is filed.
    prepareBranch("wip/fifty", "src/fifty.ts", 50);
    const fifty = await fileImprovementPr({ branch: "wip/fifty", title: "t", body: "b", slug: "fifty" }, context(gate, adapter));
    expect(fifty).toMatchObject({ ok: true, files: 1, lines: 50, dry_run: true });

    expect(dryRunIntents(dryrun).map((i) => `${i.kind}:${String((i.body as { target?: string }).target ?? "")}`)).toEqual([
      "push_branch:bot/improve-fifty",
      "create_pull:",
      "add_label:",
    ]);
    expect(remoteHeads()).toEqual(before);
    expect(existsSync(scratch)).toBe(false);
  });

  it("the diffstat is against the FRESH base (origin/<base>), not the clone's frozen local branch", async () => {
    // The base clone's local `<base>` is checked out at clone time and never
    // advanced — every round fetches into refs/remotes/origin/<base>. A
    // diffstat against the local name would count everything the base gained
    // since the clone as the session's own change.
    const gate = new MutationGate(true, join(tmp, "state", "dryrun"), async () => {
      throw new Error("executor must not run in dry-run");
    });
    const adapter = new GitHubAdapter(cfg, fakeMinter, gate, (async () => {
      throw new Error("no direct fetch expected");
    }) as unknown as typeof fetch);
    // The base moves on after the clone: 200 lines in three files.
    for (const f of ["src/a.ts", "src/b.ts", "src/c.ts"]) commitLines(seed, f, 200, `base grows ${f}`);
    git(seed, "push", "-q", "origin", BASE);
    // The session's branch is off the fresh base with one 4-line change.
    prepareBranch("wip/docs", "docs/readme.md", 4);

    const out = await fileImprovementPr({ branch: "wip/docs", title: "t", body: "b", slug: "docs" }, context(gate, adapter));

    expect(out).toMatchObject({ ok: true, files: 1, lines: 4 });
    expect(git(clone, "rev-parse", BASE).trim()).not.toBe(git(clone, "rev-parse", `origin/${BASE}`).trim());
  });

  it("a branch the session never prepared is a loud rejection, nothing filed", async () => {
    const dryrun = join(tmp, "state", "dryrun");
    const gate = new MutationGate(true, dryrun, async () => {
      throw new Error("executor must not run in dry-run");
    });
    const adapter = new GitHubAdapter(cfg, fakeMinter, gate, (async () => {
      throw new Error("no direct fetch expected");
    }) as unknown as typeof fetch);

    const out = await fileImprovementPr({ branch: "wip/nothing", title: "t", body: "b", slug: "nothing" }, context(gate, adapter));

    expect(out.ok).toBe(false);
    expect(out.reason).toContain("improvement-PR pipeline failed");
    expect(out.reason).toMatch(/wip\/nothing/);
    expect(dryRunIntents(dryrun)).toEqual([]);
    expect(store.filedSince("improvement_pr", "1970-01-01T00:00:00.000Z")).toBe(0);
    expect(existsSync(scratch)).toBe(false);
  });
});
