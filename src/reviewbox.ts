// The review sandbox: where `qcr review` runs its pi when Docker is present.
// It follows the scan sandbox (src/scanbox.ts): a throwaway container
// (`docker run --rm`) from the same image, which carries the built app, sees
// only what the review needs:
//
//   the review's tree         /reviewed-repo         read-only (the host's
//   (and its git dirs         at their own host path read-only)  throwaway
//                                                    checkout of the head)
//   the install's state home  /qcr-state             read-write — the run
//                                                    dir, with the findings,
//                                                    stays on the host
//   the companion's login     /pi-agent-src          read-only; the run takes
//                                                    a refresh-disabled copy
//                                                    in a private tmpfs pi home
//   the live config, profiles read-only
//
// No GitHub token, no ssh, no tracker enters the container: it reviews and
// writes files. Posting (a later step) runs on the host, after the container
// is gone, so a token is never in the sandbox. Without Docker the review runs
// on the host and `qcr review` says so once.
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import type { ScanSandboxConfig } from "./config.js";
import {
  configHome,
  installName,
  PROFILES_DIR,
  scanConfigMirrorDir,
  stateHome,
  type InstallEnv,
} from "./install.js";
import {
  runOneShot,
  type OneShotInput,
  type OneShotResult,
  type OneShotTarget,
} from "./oneshot.js";
import type { PrFileEntry } from "./github.js";
import { SCAN_AUTH_SRC_ENV, syncScanAuth } from "./scanauth.js";
import {
  effectiveSandbox,
  hostGitDirs,
  imageProblem,
  loginMounts,
  loginProblem,
  mountSpec,
  readLoginSummary,
  SCANBOX,
  type GitDirs,
  type ScanMount,
} from "./scanbox.js";
import {
  dockerFailureLine,
  IN_COMPANION_ENV,
  mirrorConfigFile,
  PUBLIC_DNS,
  type ConfigMirrorOutcome,
  type DockerRunner,
} from "./tui/companion.js";

/** Runs one review; the host's is `runOneShot`, the sandbox's a container. */
export type ReviewRunner = (i: OneShotInput) => Promise<OneShotResult>;

/** Set in the review container: the process is the one inside. */
export const IN_REVIEW_SANDBOX_ENV = "QCR_IN_REVIEW_SANDBOX";
/** The result the container writes beside the review's files. */
export const RESULT_FILE = "oneshot-result.json";
export const SPEC_FILE = "review-spec.json";
/** Env names that carry a GitHub credential: none is ever passed on. */
export const GITHUB_TOKEN_ENVS = ["GITHUB_TOKEN", "GH_TOKEN", "GH_ENTERPRISE_TOKEN"] as const;

/** What the inside needs to run the review, in container paths. */
export interface ReviewSpec {
  profile: string;
  tree: string;
  outDir: string;
  files: PrFileEntry[];
  target: OneShotTarget;
  timeoutMs: number;
  capUsd?: number;
  sessionName?: string;
  label?: string;
  dependencyNote?: string;
}

export interface ReviewBoxPlan {
  name: string;
  image: string;
  pihomeVolume: string;
  /** Host path of the review's throwaway checkout. */
  tree: string;
  gitDirs: string[];
  stateHome: string;
  /** Host path of the run dir (holds `out/`, `tree/` and the spec). */
  runDir: string;
  configMirror: string;
  profiles: string;
  install: string;
}

/** The run dir as the container sees it, and the mounts that make it so. */
function runDirInside(p: ReviewBoxPlan): { path: string; mounts: ScanMount[] } {
  const rel = relative(p.stateHome, p.runDir);
  if (rel !== "" && !rel.startsWith("..") && !isAbsolute(rel)) {
    const path = `${SCANBOX.stateHome}/${rel}`;
    // The tree is the read-only mount's, never also read-write through the
    // state home: an empty tmpfs hides it there.
    return { path, mounts: [{ dest: `${path}/tree`, source: "", tmpfs: true }] };
  }
  return { path: "/qcr-run", mounts: [{ dest: "/qcr-run", source: p.runDir, mode: "rw" }] };
}

/** Every mount a review container gets, in `docker run` order. */
export function reviewMounts(p: ReviewBoxPlan): ScanMount[] {
  const run = runDirInside(p);
  return [
    { dest: SCANBOX.reviewedRepo, source: p.tree, mode: "ro" },
    ...p.gitDirs.map((d) => ({ dest: d, source: d, mode: "ro" as const })),
    { dest: SCANBOX.stateHome, source: p.stateHome, mode: "rw" },
    ...run.mounts,
    ...loginMounts(p.pihomeVolume),
    { dest: SCANBOX.configLive, source: p.configMirror, mode: "ro" },
    { dest: SCANBOX.profiles, source: p.profiles, mode: "ro" },
  ];
}

/** `docker run` for one review: foreground, `--rm`, nothing else mounted,
 * and no GitHub credential in its env. */
export function reviewRunArgv(p: ReviewBoxPlan): string[] {
  const run = runDirInside(p);
  const out = ["run", "--rm", "--init", "--name", p.name, "--label", `qcr.review=${p.install}`];
  for (const ip of PUBLIC_DNS) out.push("--dns", ip);
  for (const m of reviewMounts(p)) out.push("--mount", mountSpec(m));
  const env: Array<[string, string]> = [
    ["QCR_ROOT", SCANBOX.app],
    ["QCR_CONFIG", SCANBOX.configFile],
    ["QCR_CONFIG_HOME", SCANBOX.configHome],
    ["QCR_STATE_HOME", SCANBOX.stateHome],
    ["QCR_INSTALL", p.install],
    [IN_REVIEW_SANDBOX_ENV, "1"],
    [SCAN_AUTH_SRC_ENV, SCANBOX.authSrc],
    ["PI_CODING_AGENT_DIR", SCANBOX.agentDir],
  ];
  for (const [k, v] of env) out.push("--env", `${k}=${v}`);
  out.push(p.image, "node", SCANBOX.cli, "review", "--run-spec", `${run.path}/${SPEC_FILE}`);
  return out;
}

export interface ReviewBoxDeps {
  docker: DockerRunner;
  env: InstallEnv;
  sandbox: ScanSandboxConfig;
  configSource: () => string | undefined;
  /** The app root's build stamp (default: hash the app root). */
  stamp: () => string;
  gitDirs?: (tree: string) => GitDirs;
  mirror?: (source: string, dir: string) => ConfigMirrorOutcome;
  token?: () => string;
  now?: () => number;
}

/** The container's name: unique per run. */
export function reviewContainerName(install: string, token: string): string {
  return `qcr-review-${install}-${token}`;
}

/** The runner that drives a review in a throwaway container. A refusal
 * (login, config, git) is a throw: the review never starts. The container is
 * removed whatever happens. */
export function dockerReviewRunner(deps: ReviewBoxDeps): ReviewRunner {
  return async (i) => {
    const source = deps.configSource();
    if (source === undefined)
      throw new Error("no live config to hand the review container — `qcr install where`");
    const vol = deps.sandbox.pihome_volume;
    const login = await readLoginSummary(deps.docker, deps.sandbox.image, vol);
    if (!login.ok) throw new Error(`the pi login in ${vol} cannot be read: ${login.error}`);
    const why = loginProblem(login.summary, (deps.now ?? Date.now)());
    if (why !== null) throw new Error(why);
    const git = (deps.gitDirs ?? hostGitDirs)(i.tree);
    if (!git.ok) throw new Error(`git cannot read the review tree ${i.tree}: ${git.error}`);
    const home = stateHome(deps.env);
    const mirrorDir = scanConfigMirrorDir(deps.env);
    const mirrored = (deps.mirror ?? mirrorConfigFile)(source, mirrorDir);
    if (typeof mirrored === "object")
      throw new Error(`the config could not be copied for the container: ${mirrored.failed}`);
    const profiles = join(configHome(deps.env), PROFILES_DIR);
    mkdirSync(profiles, { recursive: true });
    const runDir = dirname(i.outDir);
    const bad = [i.tree, ...git.mounts, home, runDir, mirrorDir, profiles].find((p) =>
      p.includes(","),
    );
    if (bad !== undefined)
      throw new Error(`the path ${bad} holds a comma, which docker's --mount cannot take`);
    const install = installName(deps.env);
    const token = (deps.token ?? (() => randomBytes(4).toString("hex")))();
    const plan: ReviewBoxPlan = {
      name: reviewContainerName(install, token),
      image: deps.sandbox.image,
      pihomeVolume: vol,
      tree: i.tree,
      gitDirs: git.mounts,
      stateHome: home,
      runDir,
      configMirror: mirrorDir,
      profiles,
      install,
    };
    const inside = runDirInside(plan).path;
    const spec: ReviewSpec = {
      profile: i.cfg.review.profile,
      tree: SCANBOX.reviewedRepo,
      outDir: `${inside}/${relative(runDir, i.outDir)}`,
      files: i.files,
      target: i.target,
      timeoutMs: i.timeoutMs,
      ...(i.capUsd !== undefined ? { capUsd: i.capUsd } : {}),
      ...(i.sessionName !== undefined ? { sessionName: i.sessionName } : {}),
      ...(i.label !== undefined ? { label: i.label } : {}),
      ...(i.dependencyNote !== undefined ? { dependencyNote: i.dependencyNote } : {}),
    };
    mkdirSync(i.outDir, { recursive: true });
    writeFileSync(join(runDir, SPEC_FILE), JSON.stringify(spec, null, 2) + "\n");
    rmSync(join(i.outDir, RESULT_FILE), { force: true });
    try {
      const r = await deps.docker(reviewRunArgv(plan), { timeoutMs: i.timeoutMs + 120_000 });
      let text: string;
      try {
        text = readFileSync(join(i.outDir, RESULT_FILE), "utf8");
      } catch {
        throw new Error(
          `the review container ended without a result${r.ok ? "" : `: ${dockerFailureLine(r)}`}`,
        );
      }
      return JSON.parse(text) as OneShotResult;
    } finally {
      // `--rm` removes it on exit; this covers a timeout or a killed docker.
      await deps.docker(["rm", "-f", plan.name]);
    }
  };
}

/** The container's side: `qcr review --run-spec <file>`. Takes the
 * refresh-disabled copy of the login, runs the one-shot on the read-only tree
 * and writes its result beside the files. Exit 0 when a result was written. */
export async function runReviewSpec(
  specPath: string,
  deps: {
    env: NodeJS.ProcessEnv;
    context: (
      root: string,
      profile: string,
    ) => { cfg: OneShotInput["cfg"]; ecosystem: OneShotInput["ecosystem"] };
    run?: ReviewRunner;
    log?: (line: string) => void;
  },
): Promise<number> {
  const spec = JSON.parse(readFileSync(specPath, "utf8")) as ReviewSpec;
  const srcDir = deps.env[SCAN_AUTH_SRC_ENV]?.trim();
  const agentDir = deps.env["PI_CODING_AGENT_DIR"]?.trim();
  const root = deps.env["QCR_ROOT"]?.trim() || SCANBOX.app;
  if (!srcDir || !agentDir) {
    console.error(`review: ${SCAN_AUTH_SRC_ENV} and PI_CODING_AGENT_DIR must both be set`);
    return 1;
  }
  try {
    syncScanAuth({ srcDir, dstDir: agentDir, needMs: Math.min(spec.timeoutMs, 60 * 60_000) });
  } catch (err) {
    console.error(`review: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  const { cfg, ecosystem } = deps.context(root, spec.profile);
  const result = await (deps.run ?? runOneShot)({
    root,
    agentDir,
    tree: spec.tree,
    files: spec.files,
    target: spec.target,
    outDir: spec.outDir,
    cfg,
    ecosystem,
    timeoutMs: spec.timeoutMs,
    ...(spec.capUsd !== undefined ? { capUsd: spec.capUsd } : {}),
    ...(spec.sessionName !== undefined ? { sessionName: spec.sessionName } : {}),
    ...(spec.label !== undefined ? { label: spec.label } : {}),
    ...(spec.dependencyNote !== undefined ? { dependencyNote: spec.dependencyNote } : {}),
    ...(deps.log ? { log: deps.log } : {}),
  });
  writeFileSync(join(spec.outDir, RESULT_FILE), JSON.stringify(result));
  return 0;
}

export interface ReviewSandboxChoice {
  /** Absent: run on the host. */
  runner?: ReviewRunner;
  /** Said once, before the run, when the sandbox is not used. */
  warning?: string;
}

/** Docker when it is there and its image fits this checkout; otherwise the
 * host, with the reason as the warning. A host chosen on purpose
 * (`[scan] sandbox = "host"`, or the companion container itself) is not a
 * warning. */
export async function chooseReviewSandbox(
  deps: ReviewBoxDeps & { appRoot: string; exists?: (p: string) => boolean },
): Promise<ReviewSandboxChoice> {
  const { sandbox } = await effectiveSandbox(deps.sandbox, {
    env: deps.env as NodeJS.ProcessEnv,
    exists: deps.exists ?? ((p) => existsSync(p)),
    docker: deps.docker,
  });
  if (sandbox.sandbox === "host" || (deps.env as NodeJS.ProcessEnv)[IN_COMPANION_ENV]?.trim())
    return {};
  const v = await deps.docker(["version", "--format", "{{.Server.Version}}"], {
    timeoutMs: 10_000,
  });
  if (!v.ok)
    return {
      warning:
        "Docker is not available: this review runs on the host, not in a sandbox " +
        `(${dockerFailureLine(v)})`,
    };
  const problem = await imageProblem(deps.docker, sandbox.image, deps.stamp());
  if (problem !== null)
    return {
      warning: `the review sandbox cannot be used (${problem}): this review runs on the host, not in a sandbox`,
    };
  return { runner: dockerReviewRunner({ ...deps, sandbox }) };
}
