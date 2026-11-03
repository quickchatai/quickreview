// Where a host-side `qcr scan` runs and keeps its state: the checkout it
// scans and the state home it writes (`scanEnv`), and where that leaves a
// run's transcripts (`scanTranscriptsDir`). A module of its own because
// `qcr open scan[:RUN]` (src/opencli.ts) reads the same answer, and only the
// CLI's two doors may reach src/scancli.ts (tests/single-shepherd.test.ts).
import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, sandboxRoot, type CompanionConfig } from "./config.js";
import { repoScanHome, stateHome } from "./install.js";
import { IN_COMPANION_ENV } from "./tui/companion.js";
import { SCAN_TRANSCRIPTS_DIR } from "@quickchatai/pi-quickreview/src/scan/scanrun.js";

/** Set in a scan sandbox: the process is the driver inside, so the
 * `[companion]` checkout and tracker (host paths) are not read, and no
 * further sandbox is launched. */
export const IN_SANDBOX_ENV = "QCR_IN_SCAN_SANDBOX";

/** Git's toplevel of the checkout `cwd` is in; null when it is in none. */
export function toplevelOf(cwd: string): string | null {
  const r = spawnSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  const top = r.status === 0 ? (r.stdout ?? "").trim() : "";
  return top !== "" ? top : null;
}

/** The checkout `cwd` is in: git's toplevel, else `cwd` itself. */
export function checkoutOf(cwd: string): string {
  return toplevelOf(cwd) ?? cwd;
}

/** The repository `dir` belongs to, as git's common dir (one for a checkout
 * and every worktree of it); null when `dir` is in none. */
function repositoryOf(dir: string): string | null {
  const r = spawnSync(
    "git",
    ["-C", dir, "rev-parse", "--path-format=absolute", "--git-common-dir"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
  );
  const common = r.status === 0 ? (r.stdout ?? "").trim() : "";
  if (common === "") return null;
  try {
    return realpathSync(common);
  } catch {
    return common;
  }
}

/** The env a host-side `qcr scan` assembles under: which checkout it scans
 * and where its state lives.
 *
 * - `QCR_REVIEWED_REPO` in the env names the checkout, always.
 * - On the host (not in the companion), a call from inside a checkout scans
 *   that checkout — a host plugin's `/qcr:scan` from inside the person's
 *   repo, like `qcr review` from it — and keeps the scan's state in that
 *   repo's own folder (`repoScanHome`, as the pi plugin keys it) unless
 *   QCR_STATE_HOME names one, so two repos never share a unit cut or a
 *   findings store. A `[companion] reviewed_repo_dir` naming another repo is
 *   not read then: it would price and scan a repo the caller is not in.
 *   When the call's checkout is that repo (or a worktree of it), the
 *   companion's checkout and shared state are kept, so the TUI and the
 *   companion read the run.
 * - Elsewhere (outside any checkout, or in the companion) `[companion]
 *   reviewed_repo_dir`, else the directory the command runs in.
 *
 * The tracker is the env's, else `[companion]`'s. Inside a scan sandbox none
 * of that is read — they are host paths — and the container's env decides,
 * `defaultRepo` when it names no checkout. */
export function scanEnv(
  env: NodeJS.ProcessEnv,
  defaultRepo: string,
  companionOf: () => Pick<CompanionConfig, "reviewed_repo_dir" | "tracker_dir"> = () =>
    loadConfig().companion,
  here: () => string | null = () => toplevelOf(process.cwd()),
  cwd: () => string = () => process.cwd(),
): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env, QCR_ROOT: env.QCR_ROOT?.trim() || sandboxRoot() };
  if (env[IN_SANDBOX_ENV]?.trim())
    return { ...out, QCR_REVIEWED_REPO: env.QCR_REVIEWED_REPO?.trim() || defaultRepo };
  let companion: { reviewed_repo_dir: string; tracker_dir: string } | null = null;
  try {
    companion = companionOf();
  } catch {
    // No readable config: the env and the checkout decide.
  }
  const tracker = env.QCR_TRACKER_DIR?.trim() || companion?.tracker_dir?.trim() || "";
  if (tracker) out.QCR_TRACKER_DIR = tracker;
  const named = env.QCR_REVIEWED_REPO?.trim() ?? "";
  if (named) return { ...out, QCR_REVIEWED_REPO: named };
  const configured = companion?.reviewed_repo_dir?.trim() ?? "";
  const own = (repo: string): NodeJS.ProcessEnv => ({
    ...out,
    QCR_REVIEWED_REPO: repo,
    ...(env.QCR_STATE_HOME?.trim() ? {} : { QCR_STATE_HOME: repoScanHome(env, repo) }),
  });
  const top = env[IN_COMPANION_ENV]?.trim() ? null : here();
  if (top !== null) {
    const mine = repositoryOf(top);
    if (configured && mine !== null && repositoryOf(configured) === mine)
      return { ...out, QCR_REVIEWED_REPO: configured };
    return own(top);
  }
  if (configured) return { ...out, QCR_REVIEWED_REPO: configured };
  return own(cwd());
}

/** Where a `qcr scan` run from here keeps its transcripts: under the state
 * home `scanEnv` chose (a checkout's own `repoScanHome` on the host), as
 * scanassemble.ts writes them. `qcr open scan[:RUN]` reads this, never the
 * global state home's. Takes `scanEnv`'s arguments. */
export function scanTranscriptsDir(...args: Parameters<typeof scanEnv>): string {
  return join(stateHome(scanEnv(...args)), SCAN_TRANSCRIPTS_DIR);
}

/** The checkout a docker scan sandbox mounts: the one `scanEnv` chose (a
 * host path, which is what docker mounts), never the config read again. */
export function mountedCheckout(env: NodeJS.ProcessEnv): string {
  return env.QCR_REVIEWED_REPO?.trim() ?? "";
}
