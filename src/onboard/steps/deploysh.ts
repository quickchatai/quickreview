// scripts/deploy.sh, as the wizard invokes it.
//
// The guided path IS the manual path. This module is deliberately tiny and
// deliberately dumb: it builds the argv for the SAME script the deploying
// skill documents, and it does nothing else. In particular it passes:
//
//   * no flag that skips a check — there is no such flag, and there must
//     never be a reason to add one;
//   * no environment override — the real StreamRunner spawns with the
//     inherited environment and this builder has nowhere to put a `QC_*` var,
//     so the wizard structurally cannot point the script at a different
//     inventory, a different config or a different sandbox than the operator's
//     own `scripts/deploy.sh` would use. The defaults it computes are exactly
//     the ones the manual path gets: the install locator's config
//     (`$QCR_CONFIG`, else the config home's config.toml — never the
//     checkout's) and deploy/ansible/inventory.ini in the checkout.
//
// Every refusal therefore lands unchanged on the guided route: a dirty working
// tree, a pi/OpenViking pin mismatch (all five mirrors), the "PIN-ME"
// placeholder, a missing inventory or ansible-playbook, the disk and port
// preflights inside the playbook itself, and the drain advisory that warns
// when rounds are still running. The wizard's job is to run it and show what
// it said — never to soften it.
import { join } from "node:path";
import { CHOICE_KEYS } from "../choices.js";

/** `provision` installs the host (packages, Docker, secrets, the updater) and
 * ships no image; `release <version>` is the deploy (CI built the image once
 * from the release tag; the VM pulls it by digest); `verify` asks what runs.
 * `sync` and `rebuild` are gone from the script — it refuses them. */
export type DeployMode = "provision" | "release" | "verify";

/** The version spelling deploy.sh accepts: X.Y.Z, optionally -prerelease. It
 * names an image tag, so nothing else gets near the argv. */
export const RELEASE_VERSION_RE = /^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$/;

/** A typed version -> the spelling deploy.sh takes (a leading `v` is the git
 * tag's, not the version's), or null. */
export function releaseVersionOf(raw: unknown): string | null {
  const v = String(raw ?? "")
    .trim()
    .replace(/^v(?=\d)/, "");
  return RELEASE_VERSION_RE.test(v) ? v : null;
}

/** The release version recorded by the last successful deploy, or null. */
export function recordedReleaseVersion(choices: Readonly<Record<string, unknown>>): string | null {
  const rec = choices[CHOICE_KEYS.vmDeployed];
  if (typeof rec !== "object" || rec === null) return null;
  return releaseVersionOf((rec as Record<string, unknown>).version);
}

/** Match the deploy script's inherited inventory overrides without changing them. */
export function effectiveInventoryPath(root: string, env: NodeJS.ProcessEnv = process.env): string {
  return (
    env.QC_INVENTORY || join(env.QC_ANSIBLE_DIR || join(root, "deploy", "ansible"), "inventory.ini")
  );
}

export const DEPLOY_SCRIPT_REL = "scripts/deploy.sh";

export function deployScriptPath(root: string): string {
  return join(root, DEPLOY_SCRIPT_REL);
}

export interface DeployArgvOptions {
  dryRun?: boolean;
  /** Required by `release`, refused by every other mode. */
  version?: string;
  /** `release` only: the CI deploy manifest, when it is not the default
   * `./deploy-manifest-<version>.json`. */
  manifest?: string;
}

function words(mode: DeployMode, opts: DeployArgvOptions): string[] {
  if (mode === "release") {
    if (opts.version === undefined || !RELEASE_VERSION_RE.test(opts.version))
      throw new Error(
        `deploy.sh release needs a version (X.Y.Z), got ${JSON.stringify(opts.version)}`,
      );
    return [
      ...(opts.dryRun ? ["--dry-run"] : []),
      "release",
      opts.version,
      ...(opts.manifest ? ["--manifest", opts.manifest] : []),
    ];
  }
  if (opts.version !== undefined || opts.manifest !== undefined)
    throw new Error(`deploy.sh ${mode} takes no version or manifest`);
  return [...(opts.dryRun ? ["--dry-run"] : []), mode];
}

/** `<root>/scripts/deploy.sh [--dry-run] release <version> | provision | verify`. */
export function deployArgv(root: string, mode: DeployMode, opts: DeployArgvOptions = {}): string[] {
  return [deployScriptPath(root), ...words(mode, opts)];
}

/** How the same invocation reads when the operator types it themselves. */
export function deployCommandLine(mode: DeployMode, opts: DeployArgvOptions = {}): string {
  return deployArgv("", mode, opts).join(" ");
}
