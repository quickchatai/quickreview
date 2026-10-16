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

export type DeployMode = "sync" | "rebuild" | "verify";

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

/** `<root>/scripts/deploy.sh [--dry-run] <mode>`. */
export function deployArgv(
  root: string,
  mode: DeployMode,
  opts: { dryRun?: boolean } = {},
): string[] {
  return [deployScriptPath(root), ...(opts.dryRun ? ["--dry-run"] : []), mode];
}

/** How the same invocation reads when the operator types it themselves. */
export function deployCommandLine(mode: DeployMode, opts: { dryRun?: boolean } = {}): string {
  return deployArgv("", mode, opts).join(" ");
}
