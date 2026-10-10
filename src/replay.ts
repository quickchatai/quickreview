// The regression REPLAY and the `qcr regression` entrypoint.
//
// `src/regression.ts` is the instrument: it selects cases, scores them and
// writes the investigation. It deliberately has ZERO imports — it cannot reach
// the daemon, a GitHub adapter or the gate even by accident, and
// `tests/regression.test.ts` pins that emptiness. The replay it needs is
// therefore INJECTED, and this module is what injects it. The dependency runs
// one way only: replay.ts → regression.ts, never back.
//
// ---- WHY A REPLAY IS NOT A POSTING PATH -------------------------------------
//
// The obvious way to make the reviewer look at an old PR is the `qcr compare` route:
// label it and let the live daemon dispatch a round. That route ends at
// `createReview` through the MutationGate — it is the production posting path,
// and pointing it at 40 merged PRs would post 40 reviews to real authors on
// PRs whose work finished months ago. It is FORBIDDEN as a replay mechanism,
// and nothing here uses it: this module holds no adapter, no gate constructor,
// no token minting and no HTTP client, and it never labels anything.
//
// What it does instead: for each case it checks the recorded head out into a
// SCRATCH tree of its own, spawns a throwaway pi session whose whole contract
// is "read this tree and write one JSON file", waits for that file, and kills
// the session. Five layers keep that from becoming a post, in descending order
// of strength — the first three are structural in code, the last two are the
// session's environment:
//
//   1. **No mutation surface in this process.** Nothing here imports `gate.js`,
//      `github.js`, `githubAuth.js`, `posting.js`, `daemon.js`, `wire.js` or
//      `reconcile.js`; there is no `fetch`, no token, no `addLabel`. Pinned by
//      `tests/replay.test.ts` reading this file's own source, the same way the
//      regression module's emptiness is pinned.
//   2. **`assertReplaySafe` before anything happens** — the gate handed in must
//      report dry-run, every case must be a closed PR, and every case must
//      predate the contamination cutoff (rule 1; `src/regression.ts`). It runs
//      once for the whole set inside `runRegression` AND again per case here,
//      because a per-case check is what survives someone later calling
//      `ScratchReplay.replay` directly.
//   3. **The scratch tree is never the daemon's.** `assertScratchIsolation`
//      refuses a scratch root that is the sandbox root or lives under `wt/`, so
//      a replay can never reset a worktree a live round is reading.
//   4. **No sandbox script runs in a replay session.** The sanctioned posting
//      route is `scripts/post-review.sh` / `approve-pr.sh`. The replay's pi
//      is spawned with `QCR_REPLAY=1`, and under it the no-exec guard
//      (`extensions/bash-guard.ts`) sanctions NO script in any spelling — so
//      `cd <sandbox root> && bash scripts/post-review.sh …`, which a missing
//      `scripts/` symlink alone never stopped (`cd` is allowed), is blocked.
//      The scratch root still symlinks in only `extensions/` and
//      `state/agents` (the passes must resolve), never `scripts/`.
//   5. **No credential reaches the session.** `GH_TOKEN` is never set (rule 3),
//      and `scripts/mint-token.sh` is unreachable for the same reason as (4),
//      so bare `gh` is unauthenticated and any write fails at GitHub. Nor does
//      the reviewer MEMORY: the replay's pi loads no OpenViking extension, so
//      there is no `viking_write` into the live reviewer namespace.
//
// Layers 4–5 are honest about their own strength: they are environmental, not
// structural, and they are the reason the replay prompt still says in words
// that this session posts nothing. Layers 1–3 are the ones that cannot be
// talked around.
//
// ---- SCOPING RULE 2 ---------------------------------------------------------
//
// A replay READS. It checks out a tree and reads it; it runs no tests, no
// migrations and no application code, exactly as a review round does not. The
// git commands here are the same read-only set `worktrees.ts` uses (fetch,
// cat-file, worktree add/remove, merge-base, diff) and nothing pushes: the
// upstream repo is only ever fetched from.
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { githubCloneDir, type Config } from "./config.js";
import { buildPassPlan } from "./dispatch.js";
// Type-only, erased at build: `buildPassPlan` takes the file list shape the
// files API returns, and this module builds one out of `git diff --numstat`.
import type { PrFileEntry } from "./github.js";
import type { ExecFn } from "./tmux.js";
import {
  assertReplaySafe,
  parseCaseSet,
  ReplayRefused,
  runRegression,
  type CaseSet,
  type RegressionCase,
  type RegressionRun,
  type ReplayGate,
  type SandboxFinding,
} from "./regression.js";

/** The replay cannot run on this machine at all (no pi, no tmux, no clone).
 * Distinct from `ReplayRefused`, which is a SAFETY refusal: this one means
 * "run it where pi lives", the same answer `npm run smoke:session` gives. */
export class ReplayUnavailable extends Error {}

// ---- the seam ----------------------------------------------------------------

export interface ExecOut {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Everything the replay does to the world. One interface so a test drives the
 * whole mechanism with no git, no tmux and no pi — and so the production
 * implementation is small enough to read in one screen (`nodeReplayIo`).
 */
export interface ReplayIo {
  exec(bin: string, args: string[], opts: { cwd?: string; timeoutMs?: number }): Promise<ExecOut>;
  spawnSession(name: string, systemPrompt: string, model: string): Promise<void>;
  injectOrder(name: string, body: string): Promise<void>;
  killSession(name: string): Promise<void>;
  readFile(path: string): string | null;
  writeFile(path: string, body: string): void;
  mkdirp(path: string): void;
  rm(path: string): void;
  linkDir(target: string, link: string): void;
  sleep(ms: number): Promise<void>;
  now(): number;
}

export interface ScratchReplayOptions {
  /** The gate this replay was handed. Checked, never used to mutate. */
  gate: ReplayGate;
  cfg: Config;
  /** The live sandbox root — read for the base clone, `extensions/` and the
   * built `state/agents`. Never written to. */
  sandboxRoot: string;
  /** Where the replay's trees, prompts and findings live. */
  scratchRoot: string;
  io: ReplayIo;
  /** The base clone the worktrees hang off. Defaults to
   * `<sandboxRoot>/<githubCloneDir(cfg.github)>`, the same clone
   * `worktrees.ts` maintains. */
  baseClone?: string;
  /** The branch PRs of this era targeted, for the diff base. Defaults to
   * `[github] base_branch`. */
  baseBranch?: string;
  model?: string;
  /** How long one case's session gets before the replay gives up on it and
   * returns nothing. Nothing is scored VACUOUS, which reads as a HARNESS
   * fault in the report — which is what a timeout is. */
  timeoutMs?: number;
  pollMs?: number;
  /** Discriminates this run's session names and scratch dirs. */
  runId?: string;
  log?: (line: string) => void;
}

const DEFAULTS = {
  timeoutMs: 20 * 60_000,
  pollMs: 5_000,
};

// ---- isolation ---------------------------------------------------------------

/**
 * Refuse a scratch root that could collide with the live daemon.
 *
 * The daemon's worktrees are `<root>/wt/pr-<n>` and a round in flight is
 * reading one. A replay that checked an old sha out into that path would
 * silently move the tree under a live lens pass — so the scratch root may be
 * neither the sandbox root itself nor anything under `wt/`.
 */
export function assertScratchIsolation(scratchRoot: string, sandboxRoot: string): void {
  const scratch = resolve(scratchRoot);
  const root = resolve(sandboxRoot);
  const wt = join(root, "wt");
  if (scratch === root) {
    throw new ReplayRefused(
      "regression replay refused: the scratch root is the sandbox root — a replay never writes into the daemon's own tree.",
    );
  }
  if (scratch === wt || scratch.startsWith(`${wt}/`)) {
    throw new ReplayRefused(
      `regression replay refused: the scratch root ${scratch} is inside the daemon's worktree area ${wt} — a live round is reading those trees.`,
    );
  }
}

// ---- the findings file -------------------------------------------------------

/** The file the replay session writes, relative to its case dir. */
export const FINDINGS_FILE = "findings.json";

function num(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === "string" && /^\d+$/.test(v.trim())) return Number(v.trim());
  return undefined;
}

/**
 * Parse what the session wrote into the shape the scorer reads.
 *
 * Tolerant the way verdict parsing is (a bare array is accepted, digit strings
 * coerce, an unknown extra key is ignored) and silent about entries it cannot
 * use — but never inventive: an entry with no path or no text is dropped
 * rather than guessed at, because a fabricated sandbox finding would score as
 * agreement the reviewer never reached.
 */
export function parseReplayFindings(raw: unknown): SandboxFinding[] {
  const rows = Array.isArray(raw)
    ? raw
    : typeof raw === "object" &&
        raw !== null &&
        Array.isArray((raw as { findings?: unknown }).findings)
      ? (raw as { findings: unknown[] }).findings
      : [];
  const out: SandboxFinding[] = [];
  for (const row of rows) {
    if (typeof row !== "object" || row === null) continue;
    const r = row as Record<string, unknown>;
    const path = typeof r.path === "string" ? r.path.trim() : "";
    const text = typeof r.text === "string" ? r.text : typeof r.body === "string" ? r.body : "";
    if (!path || !text.trim()) continue;
    const line = num(r.line) ?? num(r.end_line);
    const tag = typeof r.tag === "string" && r.tag.trim() ? r.tag.trim() : undefined;
    out.push({ path, text, ...(line !== undefined ? { line } : {}), ...(tag ? { tag } : {}) });
  }
  return out;
}

// ---- the prompts -------------------------------------------------------------

/** The replay session's system prompt. Short on purpose: this session is not a
 * reviewer conversation, it owns no PR, it has no ledger and no verdict, and
 * the one thing it must not do is act like one. */
export function replaySystemPrompt(): string {
  return [
    "# Regression replay session",
    "",
    "You are a THROWAWAY session in an offline regression harness. You are not",
    "reviewing a live pull request and you own no conversation.",
    "",
    "Absolute rules for this session:",
    "",
    "- **Post nothing, anywhere.** No review, no comment, no reply, no label, no",
    "  approval. There is no PR waiting for you: every tree you are given belongs",
    "  to a pull request that was merged or closed long ago, and a comment on one",
    "  would reach real people about finished work. There is no posting script in",
    "  this working directory and no credential in this environment; that is",
    "  deliberate, and trying to route around it is the one thing that turns this",
    "  harness into the incident it was built to avoid.",
    "- **Read only** (scoping rule 2). Read the tree, the diff and the history.",
    "  Never run the project's tests, migrations, build or application code.",
    "- **Write exactly one file**, the findings JSON named in the order below.",
    "  No verdict file, no ledger, no memory write, no findings record.",
    "",
    "Your output is a list of the findings the reviewer WOULD have raised on this",
    "diff. Say nothing you could not evidence from the tree in front of you: an",
    "invented finding scores as agreement the reviewer never reached, which is",
    "worse for this harness than an empty list.",
    "",
  ].join("\n");
}

export interface ReplayOrderArgs {
  c: RegressionCase;
  treePath: string;
  findingsPath: string;
  lenses: readonly string[];
  baseSha: string;
  changedFiles: number;
  /** True when the diff base could not be resolved — the session is told so
   * rather than left to assume the empty file list meant an empty PR. */
  degradedDiff: boolean;
}

/** The order injected into the replay session. */
export function replayOrder(a: ReplayOrderArgs): string {
  const L: string[] = [];
  L.push(`# Regression replay — PR #${a.c.pr} @ ${a.c.headSha}`);
  L.push("");
  L.push(
    `Worktree: \`${a.treePath}\` (detached at \`${a.c.headSha}\`, the exact head the human review was made against).`,
  );
  L.push(
    a.degradedDiff
      ? "Diff base: **could not be resolved**. Work out the PR's own changes from the history yourself; do NOT assume the change is empty."
      : `Diff base: \`${a.baseSha}\` — \`git diff ${a.baseSha} ${a.c.headSha}\` is this PR's change (${a.changedFiles} file(s)).`,
  );
  L.push("");
  L.push("Run these lens passes as subagents against that tree, exactly as a review round would:");
  L.push("");
  for (const lens of a.lenses) L.push(`- \`${lens}\``);
  L.push("");
  L.push("Then write the surviving findings — the ones that would actually have been posted — to:");
  L.push("");
  L.push(`\`${a.findingsPath}\``);
  L.push("");
  L.push("```json");
  L.push('{ "pr": ' + a.c.pr + ', "head_sha": "' + a.c.headSha + '", "findings": [');
  L.push(
    '  { "path": "app/x.py", "line": 42, "tag": "[blocker]", "text": "the finding, in the words you would have posted" }',
  );
  L.push("] }");
  L.push("```");
  L.push("");
  L.push(
    "`line` is the line on the head side. An empty `findings` array is a legitimate answer and is recorded as one.",
  );
  L.push("");
  L.push(
    "Post NOTHING. Write no verdict file. When the JSON file is on disk you are done — stop and wait.",
  );
  L.push("");
  return L.join("\n");
}

// ---- the replay ---------------------------------------------------------------

export class ScratchReplay {
  private readonly o: Required<Omit<ScratchReplayOptions, "log">> & { log: (line: string) => void };

  constructor(opts: ScratchReplayOptions) {
    assertScratchIsolation(opts.scratchRoot, opts.sandboxRoot);
    this.o = {
      ...opts,
      // Both derive from [github] — the clone dir from the repo slug
      // (githubCloneDir), the branch from base_branch — so the replay reads
      // the same clone worktrees.ts maintains, whatever the repo is called.
      baseClone: opts.baseClone ?? join(opts.sandboxRoot, githubCloneDir(opts.cfg.github)),
      baseBranch: opts.baseBranch ?? opts.cfg.github.base_branch,
      model: opts.model ?? opts.cfg.models.conversation,
      timeoutMs: opts.timeoutMs ?? DEFAULTS.timeoutMs,
      pollMs: opts.pollMs ?? DEFAULTS.pollMs,
      runId: opts.runId ?? `${Date.now()}-${process.pid}`,
      log: opts.log ?? (() => {}),
    };
  }

  /** Per RUN as well as per PR: two `qcr regression` invocations over one
   * case set must not clear each other's findings or remove each other's tree. */
  caseDir(pr: number): string {
    return join(this.o.scratchRoot, `run-${this.o.runId}`, `pr-${pr}`);
  }

  treePath(pr: number): string {
    return join(this.caseDir(pr), "tree");
  }

  sessionName(pr: number): string {
    return `replay-${this.o.runId}-pr-${pr}`;
  }

  /**
   * Lay out the scratch root: `extensions/` and `state/agents` are symlinked in
   * (the pass agents and the no-exec guard must resolve), and `scripts/` is
   * deliberately NOT — see layer 4 in the module header.
   */
  private ensureLayout(): void {
    const { io, scratchRoot, sandboxRoot } = this.o;
    io.mkdirp(scratchRoot);
    io.mkdirp(join(scratchRoot, "state"));
    io.linkDir(join(sandboxRoot, "extensions"), join(scratchRoot, "extensions"));
    io.linkDir(join(sandboxRoot, "state", "agents"), join(scratchRoot, "state", "agents"));
  }

  private async git(args: string[], cwd: string): Promise<ExecOut> {
    return this.o.io.exec("git", args, { cwd, timeoutMs: 120_000 });
  }

  /**
   * Materialise the case's recorded head in a scratch worktree.
   *
   * The recorded sha is the authority and there is no fallback: if it is not
   * reachable after the fetch, the replay REFUSES rather than checking out
   * whatever `refs/pull/<n>/head` points at today. Replaying a different tree
   * than the human reviewed would silently turn every score into noise.
   */
  private async prepareTree(c: RegressionCase): Promise<{
    tree: string;
    baseSha: string;
    files: PrFileEntry[];
    degraded: boolean;
    /** Why the scratch checkout failed; a session is never asked to review it. */
    checkoutFailed?: string;
  }> {
    const { io, baseClone, baseBranch } = this.o;
    if (!existsSync(join(baseClone, ".git"))) {
      throw new ReplayUnavailable(
        `regression replay: no base clone at ${baseClone}. Run this where the sandbox's clone lives (the VM container), or point --clone at one.`,
      );
    }
    const ref = `refs/qcr/replay-${c.pr}`;
    await this.git(
      [
        "fetch",
        "--force",
        "origin",
        `+refs/pull/${c.pr}/head:${ref}`,
        `+refs/heads/${baseBranch}:refs/remotes/origin/${baseBranch}`,
      ],
      baseClone,
    );
    const have = await this.git(["cat-file", "-e", `${c.headSha}^{commit}`], baseClone);
    if (have.code !== 0) {
      throw new ReplayRefused(
        `regression replay refused: case ${c.id} records head ${c.headSha}, which is not reachable in ${baseClone} after fetching refs/pull/${c.pr}/head. ` +
          `Replaying a different tree than the human reviewed would score the reviewer against a diff nobody ever saw.`,
      );
    }
    const tree = this.treePath(c.pr);
    io.mkdirp(dirname(tree));
    await this.git(["worktree", "remove", "--force", tree], baseClone);
    const added = await this.git(["worktree", "add", "--detach", tree, c.headSha], baseClone);
    if (added.code !== 0) {
      return {
        tree,
        baseSha: "",
        files: [],
        degraded: true,
        checkoutFailed:
          (added.stderr || added.stdout).trim().split("\n")[0] || `exit ${added.code}`,
      };
    }

    let baseSha = "";
    let degraded = true;
    const files: PrFileEntry[] = [];
    const mb = await this.git(
      ["merge-base", `refs/remotes/origin/${baseBranch}`, c.headSha],
      baseClone,
    );
    if (mb.code === 0 && mb.stdout.trim()) {
      baseSha = mb.stdout.trim();
      const diff = await this.git(["diff", "--numstat", baseSha, c.headSha], baseClone);
      if (diff.code === 0) {
        for (const line of diff.stdout.split("\n")) {
          const [add = "", del = "", path = ""] = line.trim().split("\t");
          if (!path) continue;
          files.push({
            filename: path,
            additions: Number(add) || 0,
            deletions: Number(del) || 0,
            status: "modified",
          });
        }
        // A merge-committed PR's head is an ancestor of TODAY's base, so the
        // merge-base is the head itself and the diff is empty. A replayed PR
        // changed something by definition: an empty diff means the base was
        // not recovered, never that the change was empty.
        degraded = files.length === 0;
      }
    }
    return { tree, baseSha, files, degraded };
  }

  private async teardown(c: RegressionCase): Promise<void> {
    const name = this.sessionName(c.pr);
    try {
      await this.o.io.killSession(name);
    } catch {
      // A session that is already gone is the outcome we wanted.
    }
    try {
      await this.git(["worktree", "remove", "--force", this.treePath(c.pr)], this.o.baseClone);
    } catch {
      // Leaving a scratch tree behind costs disk and nothing else; the order
      // and the findings file stay on purpose, so a run can be audited.
    }
  }

  /** One case. Never throws for an unproductive replay — an empty list is a
   * result the report reads as a harness fault, which is what it is. */
  readonly replay = async (c: RegressionCase): Promise<SandboxFinding[]> => {
    // Belt to `runRegression`'s braces: whoever calls this directly gets the
    // same three refusals.
    assertReplaySafe([c], this.o.gate);
    this.ensureLayout();
    const { io, log } = this.o;
    const dir = this.caseDir(c.pr);
    io.mkdirp(dir);
    const findingsPath = join(dir, FINDINGS_FILE);
    io.rm(findingsPath);

    const prepared = await this.prepareTree(c);
    // From here the scratch worktree is registered: the try/finally must begin
    // IMMEDIATELY, or a throw in the order build/write (e.g. a full disk)
    // skips teardown and leaks the worktree registration.
    try {
      if (prepared.checkoutFailed !== undefined) {
        // A missing or stale tree reviewed as if it were the head would score
        // as reviewer recall; an empty result is read as the harness fault it is.
        log(
          `replay: ${c.id} worktree add failed (${prepared.checkoutFailed}) — scored VACUOUS, no session spawned`,
        );
        return [];
      }
      const { pass_plan } = buildPassPlan(this.o.cfg, prepared.files);
      const lenses = pass_plan.map((p) => p.lens);
      const order = replayOrder({
        c,
        treePath: prepared.tree,
        findingsPath,
        lenses,
        baseSha: prepared.baseSha,
        changedFiles: prepared.files.length,
        degradedDiff: prepared.degraded,
      });
      io.writeFile(join(dir, "order.md"), order);

      const name = this.sessionName(c.pr);
      await io.spawnSession(name, replaySystemPrompt(), this.o.model);
      await io.injectOrder(name, order);
      const deadline = io.now() + this.o.timeoutMs;
      while (io.now() < deadline) {
        await io.sleep(this.o.pollMs);
        const raw = io.readFile(findingsPath);
        if (raw === null) continue;
        try {
          const findings = parseReplayFindings(JSON.parse(raw));
          log(`replay: ${c.id} produced ${findings.length} finding(s)`);
          return findings;
        } catch {
          // Half-written file: the session is still flushing. Keep polling.
        }
      }
      log(
        `replay: ${c.id} produced nothing within ${Math.round(this.o.timeoutMs / 1000)}s — scored VACUOUS`,
      );
      return [];
    } finally {
      await this.teardown(c);
    }
  };
}

// ---- the production seam ------------------------------------------------------

/**
 * The real `ReplayIo`: node's fs plus the sandbox's own pi lifecycle.
 *
 * `PiSessionManager` is rooted at the SCRATCH root so the session's cwd, inject
 * dir, prompts and session JSONLs are all scratch — but `piHome` stays the real
 * one, because that volume is where the ChatGPT OAuth tokens live and a replay
 * must not cost the login.
 */
export async function nodeReplayIo(opts: {
  cfg: Config;
  sandboxRoot: string;
  scratchRoot: string;
  /** Test seam: the process runner for git and tmux (default `nodeExec`). */
  exec?: ExecFn;
}): Promise<ReplayIo> {
  const { nodeExec, Tmux } = await import("./tmux.js");
  const { PiSessionManager } = await import("./sessions.js");
  const run: ExecFn = opts.exec ?? nodeExec;
  // Layer 5: the throwaway session gets no memory surface. The OpenViking
  // extension would register `viking_write` under the reviewer key — the same
  // namespace live reviews read — and nothing else would stop a replay's
  // "lesson" persisting past teardown.
  class ReplaySessionManager extends PiSessionManager {
    override extensionPaths(): string[] {
      return super.extensionPaths().filter((p) => !p.split(/[\\/]/).includes("openviking-pi"));
    }
  }
  const mgr = new ReplaySessionManager({
    cfg: opts.cfg,
    root: opts.scratchRoot,
    piHome: join(opts.sandboxRoot, "pihome"),
    tmux: new Tmux({ exec: run }),
  });
  return {
    exec: (bin, args, o) => run(bin, args, o),
    spawnSession: async (name, prompt, model) => {
      // Layer 4: under QCR_REPLAY the exec guard sanctions no sandbox script.
      await mgr.spawnSession(name, prompt, model, { QCR_REPLAY: "1" });
    },
    injectOrder: async (name, body) => {
      mgr.injectFile(name, body);
    },
    killSession: (name) => mgr.tmux.killSession(name),
    readFile: (p) => {
      try {
        return readFileSync(p, "utf8");
      } catch {
        return null;
      }
    },
    writeFile: (p, body) => {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, body);
    },
    mkdirp: (p) => mkdirSync(p, { recursive: true }),
    rm: (p) => rmSync(p, { force: true, recursive: true }),
    linkDir: (target, link) => {
      if (existsSync(link)) return;
      mkdirSync(dirname(link), { recursive: true });
      try {
        symlinkSync(target, link, "dir");
      } catch {
        // A filesystem without symlinks leaves the session under-equipped
        // rather than unstartable — the same degradation rule the entrypoints
        // follow for a missing skills dir.
      }
    },
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => Date.now(),
  };
}

// ---- `qcr regression` ---------------------------------------------------------

export interface RegressionArgs {
  setPath?: string;
  /** Base clone to take the case trees out of. Defaults to the sandbox's own
   * reviewed-repo clone — named here so a machine without one can still run
   * the harness against a clone it does have. */
  clonePath?: string;
  changeUnderTest: string;
  limit?: number;
  outPath?: string;
  json: boolean;
}

/** Flag parsing, split out so it is testable without a config or a clone. */
export function parseRegressionArgs(rest: string[], json: boolean): RegressionArgs {
  const flag = (name: string): string | undefined => {
    const i = rest.indexOf(name);
    return i >= 0 ? rest[i + 1] : undefined;
  };
  const limitRaw = flag("--limit");
  const limit = limitRaw === undefined ? undefined : Number(limitRaw);
  if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0)) {
    throw new Error(
      "usage: qcr regression [--set <path>] [--clone <path>] [--change <name>] [--limit <n>] [--out <path>] [--json]",
    );
  }
  return {
    ...(flag("--set") !== undefined ? { setPath: flag("--set") } : {}),
    ...(flag("--clone") !== undefined ? { clonePath: flag("--clone") } : {}),
    changeUnderTest: flag("--change") ?? "(unnamed change)",
    ...(limit !== undefined ? { limit } : {}),
    ...(flag("--out") !== undefined ? { outPath: flag("--out") } : {}),
    json,
  };
}

export interface RegressionCliDeps {
  /** Read + validate the committed case set. */
  loadCaseSet: (path: string | undefined) => CaseSet;
  /** The gate this run is judged against. Built by the CALLER so the safety
   * assertion is about a real object rather than a sentence in a config. */
  gate: ReplayGate;
  /** Build the replay. Async so the caller can probe for pi/tmux first and
   * throw `ReplayUnavailable` with a useful message. */
  makeReplay: (gate: ReplayGate) => Promise<(c: RegressionCase) => Promise<SandboxFinding[]>>;
  reportPath: (ranAt: string) => string;
  writeReport: (path: string, body: string) => void;
  log: (line: string) => void;
  run?: typeof runRegression;
}

/**
 * `qcr regression` — run the case set and write the investigation.
 *
 * The exit code is ALWAYS 0 for a completed run, whatever it found: the module
 * has no blocking verdict and this entrypoint must not invent one by the back
 * door. The only non-zero codes are 2 (refused — a safety assertion failed, and
 * that is loud on purpose) and 3 (unavailable — run it where pi lives).
 */
export async function runRegressionCli(
  args: RegressionArgs,
  deps: RegressionCliDeps,
): Promise<number> {
  let run: RegressionRun;
  try {
    const set = deps.loadCaseSet(args.setPath);
    const cases = args.limit ? set.cases.slice(0, args.limit) : set.cases;
    // Before building anything expensive — a clone fetch, a pi session — check
    // that this run is allowed to happen at all.
    assertReplaySafe(cases, deps.gate);
    const replay = await deps.makeReplay(deps.gate);
    run = await (deps.run ?? runRegression)(cases, {
      replay,
      gate: deps.gate,
      changeUnderTest: args.changeUnderTest,
    });
  } catch (err) {
    if (err instanceof ReplayRefused) {
      deps.log(String(err.message));
      return 2;
    }
    if (err instanceof ReplayUnavailable) {
      deps.log(String(err.message));
      return 3;
    }
    throw err;
  }

  const path = args.outPath ?? deps.reportPath(run.ranAt);
  deps.writeReport(path, run.markdown);
  if (args.json) {
    deps.log(
      JSON.stringify({
        recommendation: run.recommendation,
        headline: run.headline,
        reviewer_skew: run.reviewerSkew,
        cases: run.cases.length,
        report: path,
      }),
    );
  } else {
    deps.log(`regression: ${run.recommendation} — ${run.headline}`);
    deps.log(`report: ${path}`);
  }
  return run.exitCode;
}

/** Read the committed set from disk. Refuses an unreadable or malformed file
 * loudly — `parseCaseSet` already refuses an empty one. */
export function readCaseSet(path: string): CaseSet {
  return parseCaseSet(JSON.parse(readFileSync(path, "utf8")));
}
