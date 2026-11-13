// `state_explore` — the state-machine family's structural reader of a PR, as
// a pi tool (packages/pi-plugin/src/stateexplore.ts is the reader; this file
// gives it to a lens session).
//
// Who holds it: a `pass-sm-*` lens session, and nothing else. Two gates, both
// on the runner's side of the session: the agent's name must be a
// STATE_FAMILY variant and its own `tools:` allowlist must name the tool, or
// it must carry no allowlist at all (`stateLeafTools` in extensions/lens.ts,
// which every lens route's runner config comes from). The build puts the name on exactly the family's lines
// (`applyStateTools`, packages/pi-plugin/src/include.ts) and strips it from
// every other agent and from a scan or replay build.
//
// What it is: in-process, read-only, deterministic. It runs in the worker
// process, outside the bash guard, the tool-uid split and the file fence, so
// it holds the exec boundary itself (docs/exec-boundary.md, "The in-process
// state reader"): it reads committed git objects only, through plumbing verbs
// with git's configuration pinned (stateexploregit.ts), and only inside the
// session's `cwd`. It writes nothing, starts no session and reaches no
// network.
//
// Session memory: `worktree`, `base` and `head` are required on a session's
// first call and remembered for its later calls; a call that changes one is
// validated again (the path check, then both ids resolving to commits). Each
// call of the factory createStateExplore returns is one session, so the memory
// lives in that call's closure and two lens sessions never share it. The
// target is verified once per session: a later call over the same target
// hands its reader the git directory the first verification accepted and
// the target's tree listings and diff (stateexploregit.ts says why that is
// safe), and a call that changes the target verifies again over an empty
// cache. A reader itself is never kept: runStateExplore closes the reader it
// is given (one `cat-file --batch` child per call), so every call builds a
// fresh one.
//
// Every failure is a text result: a missing or malformed argument, a target
// the check refuses, a reader that throws. The tool never throws into pi.
//
// VERIFY-ON-PIN: defineTool's and registerTool's definition shape, as in
// finding-clusters.ts.
import { isAbsolute } from "node:path";
import { defineTool } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { textResult, toPiTool, type QcrTool, type QcrToolResult } from "./pi-tool.js";
import {
  STATE_EXPLORE_DESCRIPTION,
  STATE_EXPLORE_PARAMS,
  STATE_EXPLORE_TOOL,
  runStateExplore,
  type ExploreAction,
  type ExploreIo,
  type ExploreRequest,
} from "../src/stateexplore.js";
import {
  checkExploreTarget,
  gitExploreIo,
  newExploreGitCache,
  type ExploreGitCache,
  type ExploreSpawn,
  type ExploreTargetCheck,
} from "../src/stateexploregit.js";

export { STATE_EXPLORE_TOOL };

/** The PR a session explores: its worktree and the two commits of its diff. */
export interface ExploreTarget {
  worktree: string;
  base: string;
  head: string;
}

/** What checkExploreTarget answers: the resolved target, or a refusal. */
export type ExploreCheck = ExploreTargetCheck;

/** A reader the tool can use: an ExploreIo, and optionally the question
 * whether the target's ids resolve to commits and the git directory that
 * answer accepted (gitExploreIo answers both). */
export type ExploreReader = ExploreIo & {
  verify?(): Promise<string | null>;
  gitDir?(): string | null;
};

/** What a session reuses across its calls over one target: the git
 * directory its first verification accepted, and the reads it cached. */
export interface ExploreReuse {
  verified?: { gitDir: string };
  cache: ExploreGitCache;
}

export interface StateExploreConfig {
  /** The lens session's working directory: a worktree must be this or under it. */
  cwd: string;
  /** The `PATH` git is found on (the host's; the reader builds the rest of git's env itself). */
  path: string;
  /** How the default reader starts its git children. Default: node's spawn. A test seam. */
  spawn?: ExploreSpawn;
  /** A reader over a checked target, one per call, given what the session
   * reuses for that target. Default: gitExploreIo. A test seam. */
  makeIo?: (target: ExploreTarget, reuse: ExploreReuse) => ExploreReader;
  /** The target check. Default: checkExploreTarget. A test seam. */
  check?: (
    cwd: string,
    worktree: string,
    base: string,
    head: string,
  ) => ExploreCheck | Promise<ExploreCheck>;
}

const ACTIONS: readonly ExploreAction[] = ["anchors", "writes", "reads", "exits", "siblings"];

/** A commit id as the task prints it: full SHA-1 or SHA-256 hex. */
const SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** One session's remembered target: as the call named it, and as the check
 * resolved it (the worktree's real path, the ids lowercased). */
interface SessionMemory {
  asked: ExploreTarget | undefined;
  resolved: ExploreTarget | undefined;
  /** For `resolved`; replaced whenever the target changes. */
  reuse: ExploreReuse;
}

/** A refusal as the tool's text; the engine's own refusals already say "refused: ". */
const refused = (why: string): QcrToolResult =>
  textResult(`${STATE_EXPLORE_TOOL} refused: ${why.replace(/^refused:\s*/, "")}`);

const sameTarget = (a: ExploreTarget, b: ExploreTarget): boolean =>
  a.worktree === b.worktree && a.base === b.base && a.head === b.head;

/** A string argument, trimmed; undefined when absent or blank. */
function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
}

/** Read the request half of the arguments, or say what is wrong with it. */
function readRequest(params: Record<string, unknown>): ExploreRequest | string {
  const action = str(params["action"]);
  if (action === undefined || !(ACTIONS as readonly string[]).includes(action))
    return `action must be one of ${ACTIONS.join(", ")}`;
  const req: ExploreRequest = { action: action as ExploreAction };
  if (params["name"] !== undefined) {
    const name = str(params["name"]);
    if (name === undefined) return "name must be a non-empty string";
    req.name = name;
  }
  if (params["file"] !== undefined) {
    const file = str(params["file"]);
    if (file === undefined) return "file must be a non-empty string";
    req.file = file;
  }
  if (params["line"] !== undefined) {
    const raw = params["line"];
    const line =
      typeof raw === "number"
        ? raw
        : typeof raw === "string" && /^\d+$/.test(raw)
          ? Number(raw)
          : NaN;
    if (!Number.isInteger(line) || line < 1) return "line must be a 1-based line number";
    req.line = line;
  }
  return req;
}

/** The target this call names: its own arguments over the session's memory. */
function readTarget(
  params: Record<string, unknown>,
  remembered: ExploreTarget | undefined,
): ExploreTarget | string {
  const worktree = str(params["worktree"]) ?? remembered?.worktree;
  // Echo a bad id as the call wrote it; compare it lowercased.
  const baseArg = str(params["base"]);
  const headArg = str(params["head"]);
  const base = baseArg?.toLowerCase() ?? remembered?.base;
  const head = headArg?.toLowerCase() ?? remembered?.head;
  if (worktree === undefined || base === undefined || head === undefined)
    return 'the first call names worktree, base and head (the worktree path and the two shas of "git diff <base> <head>" in your task\'s "The code")';
  if (!isAbsolute(worktree)) return `worktree must be an absolute path (got ${worktree})`;
  if (!SHA_RE.test(base))
    return `base must be a full 40- or 64-hex commit id (got ${baseArg ?? base})`;
  if (!SHA_RE.test(head))
    return `head must be a full 40- or 64-hex commit id (got ${headArg ?? head})`;
  return { worktree, base, head };
}

/** The tool over one session's memory. Exported for tests; a session gets it
 * through createStateExplore. */
export function stateExploreTool(config: StateExploreConfig): QcrTool {
  const memory: SessionMemory = {
    asked: undefined,
    resolved: undefined,
    reuse: { cache: newExploreGitCache() },
  };
  const makeIo =
    config.makeIo ??
    ((t: ExploreTarget, reuse: ExploreReuse): ExploreReader =>
      gitExploreIo({
        ...t,
        path: config.path,
        ...(config.spawn !== undefined ? { spawn: config.spawn } : {}),
        cache: reuse.cache,
        ...(reuse.verified !== undefined ? { verified: reuse.verified } : {}),
      }));
  const check = config.check ?? checkExploreTarget;
  return {
    name: STATE_EXPLORE_TOOL,
    label: "State explore",
    description: STATE_EXPLORE_DESCRIPTION,
    parameters: STATE_EXPLORE_PARAMS,
    async execute(_id, params) {
      try {
        const req = readRequest(params);
        if (typeof req === "string") return refused(req);
        const target = readTarget(params, memory.asked);
        if (typeof target === "string") return refused(target);
        let resolved = memory.resolved;
        let reuse = memory.reuse;
        const fresh =
          memory.asked === undefined || resolved === undefined || !sameTarget(memory.asked, target);
        if (fresh) {
          const verdict = await check(config.cwd, target.worktree, target.base, target.head);
          // A refused change keeps the target the session had.
          if (!verdict.ok) return refused(verdict.refusal);
          resolved = { worktree: verdict.worktree, base: verdict.base, head: verdict.head };
          // A new target starts with nothing verified and nothing read.
          reuse = { cache: newExploreGitCache() };
        }
        if (resolved === undefined) return refused("no target");
        const io = makeIo(resolved, reuse);
        if (fresh && io.verify !== undefined) {
          const notCommits = await io.verify();
          if (notCommits !== null) {
            await io.close?.().catch(() => undefined);
            return refused(notCommits);
          }
          // Only an accepted verification is remembered.
          const gitDir = io.gitDir?.() ?? null;
          if (gitDir !== null) reuse.verified = { gitDir };
        }
        memory.asked = target;
        memory.resolved = resolved;
        memory.reuse = reuse;
        return textResult(await runStateExplore(req, io));
      } catch (e) {
        return textResult(
          `${STATE_EXPLORE_TOOL} failed: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    },
  };
}

/** The factory a lens session loads. Each call of the returned factory is one
 * session, with a memory of its own. */
export function createStateExplore(config: StateExploreConfig): ExtensionFactory {
  return (pi: ExtensionAPI): void => {
    pi.registerTool(defineTool(toPiTool(stateExploreTool(config))));
  };
}
