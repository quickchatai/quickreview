// A round's inputs for the tests that run packages/pi-plugin/src/engine/round.ts: a production-
// shaped root, a prepared tree, a target and its file list. Shared by the round
// tests and the one-shot canary (tests/pi-canary/canary-10-oneshot-request).
import { mkdirSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The tests' config fixture: QCR_CONFIG must name it before src/config.js loads. */
export const FIXTURE_CONFIG = join(REPO_ROOT, "tests", "fixtures", "config.toml");

/** A production-shaped root without the checkout's own wt/ and state/. */
export function mkRoot(tmp: string, name: string): string {
  const root = join(tmp, name);
  mkdirSync(root);
  for (const e of readdirSync(REPO_ROOT))
    if (![".git", "state", "wt", "node_modules"].includes(e))
      symlinkSync(join(REPO_ROOT, e), join(root, e));
  symlinkSync(join(REPO_ROOT, "node_modules"), join(root, "node_modules"));
  return root;
}

export function mkTree(tmp: string, name: string): string {
  const tree = join(tmp, name);
  mkdirSync(join(tree, "src"), { recursive: true });
  writeFileSync(join(tree, "src", "a.ts"), "export const a = 1;\nexport const b = 2;\n");
  return tree;
}

export const TARGET = {
  repo: "example-org/example-app",
  number: 7,
  title: "Add b",
  body: null,
  headSha: "a".repeat(40),
  baseRef: "main",
  baseSha: "b".repeat(40),
  mergeBase: "b".repeat(40),
};

export const FILES = [{ filename: "src/a.ts", additions: 1, deletions: 0, status: "modified" }];

export const FINDING = { path: "src/a.ts", line: 2, severity: "important" };
export const RECORD = JSON.stringify({ findings: [FINDING], verdict: "REQUEST_CHANGES" });
export const OUTCOME = JSON.stringify({ verdict: "REQUEST_CHANGES", passes: [] });
