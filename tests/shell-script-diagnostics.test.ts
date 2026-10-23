// Source-text fences for two operator scripts: the companion smoke keeps its logs when it fails and
// takes the layout root from the TUI's own resolver; the worker rehearsal states only what it ran
// and fails when its report does.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (f: string): string => readFileSync(join(ROOT, f), "utf8");

describe("scripts/smoke-companion.sh", () => {
  const src = read("scripts/smoke-companion.sh");
  it("keeps the work directory (build.log, ssh.log) when the run did not succeed", () => {
    expect(src).not.toMatch(/^trap 'rm -rf "\$WORK"' EXIT$/m);
    expect(src).toMatch(/trap .*EXIT/);
    expect(src).toMatch(/rc=\$\?/);
  });
  it("maps the container layout to its root through the TUI resolver, not a copy", () => {
    expect(src).toContain("rootForLayout");
    expect(src).not.toContain('release) VM_ROOT="/opt/qcr"');
  });
});

describe("scripts/worker-rehearsal.sh", () => {
  const src = read("scripts/worker-rehearsal.sh");
  it("does not claim fixed scenario counts in the BUSY-1 evidence", () => {
    expect(src).not.toContain("3 rounds, 2 answers, a takeover, a debug round and a restart");
  });
  it("fails the run when the report could not be written", () => {
    expect(src).not.toMatch(/report\.mjs"[^\n]*\|\| log "the report failed"\n/);
    expect(src).toMatch(/REPORT_RC/);
  });
});
