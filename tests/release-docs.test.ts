// The release-side document of P6.16 (no docker, no model):
// docs/macos-release-checklist.md ships, and covers what the ruling asked of
// the Mac check: the wrapper install, the token handoff directory under
// $TMPDIR, the Docker Desktop VM's ptrace_scope, and one run with no model.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string): string => readFileSync(join(root, rel), "utf8");
const has = (rel: string): boolean => existsSync(join(root, rel));

describe("docs/macos-release-checklist.md", () => {
  const CHECKLIST = "docs/macos-release-checklist.md";
  const text = read(CHECKLIST);

  it("ships: the checklist is tracked", () => {
    expect(has(CHECKLIST)).toBe(true);
  });

  it("covers the wrapper install, the handoff dir under $TMPDIR, ptrace_scope and a run with no model", () => {
    expect(text).toMatch(/\binstall\b/);
    expect(text).toContain("~/.local/bin/qcr");
    expect(text).toContain("$TMPDIR");
    expect(text).toContain("/run/qcr-in");
    expect(text).toContain("QCR_GH_TOKEN_FILE");
    expect(text).toContain("kernel.yama.ptrace_scope");
    expect(text).toContain("review --preview --json");
  });

  it("asks for no real token and no model key", () => {
    expect(text).toContain("not-a-real-token");
    expect(text).not.toMatch(/gh auth token/);
    expect(text).toMatch(/must not reach a model/);
  });

  it("uses the commands the tree has: the wrapper's volume-free install and the image's debug line", () => {
    const entrypoint = read("docker/entrypoint.sh");
    expect(entrypoint).toContain("kernel.yama.ptrace_scope");
    expect(entrypoint).toContain("QCR_DEBUG");
    expect(read("scripts/qcr-host.sh")).toContain("/run/qcr-in");
    expect(read("scripts/qcr-host.sh")).toContain("QCR_GH_TOKEN_FILE");
  });
});
