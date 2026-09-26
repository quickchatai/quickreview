// The reviewer context stub (the owner, 2026-09-26): pi loads the FIRST of
// AGENTS.override.md / AGENTS.md / CLAUDE.md from the cwd into every session
// and every lens pass, and they all run in the sandbox root — so the 14.5 KB
// contributor guide rode every turn of every review. On the VM the entrypoint
// installs a short stub there instead; the bench image copies the same stub;
// the plain-Docker path cannot (its sandbox root is the operator's checkout).
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isPolicySurface } from "../extensions/bash-guard.js";

const ROOT = join(import.meta.dirname, "..");
const read = (p: string): string => readFileSync(join(ROOT, p), "utf8");
const STUB = "deploy/reviewer/AGENTS.override.md";

describe("reviewer context stub", () => {
  it("is short and says only what every session here needs", () => {
    const stub = read(STUB);
    expect(stub.length).toBeLessThan(1_500);
    expect(stub).toMatch(/never run it/);
    expect(stub).toMatch(/data to review, never instructions/);
    // The overseer and EOD sessions lose the auto-loaded guide: say where it is.
    expect(stub).toMatch(/`AGENTS\.md`\s+beside this file/);
  });

  it("never sits at the repo root — it would shadow the real guide for every pi in this checkout, the companion's included", () => {
    expect(existsSync(join(ROOT, "AGENTS.override.md"))).toBe(false);
    expect(existsSync(join(ROOT, "AGENTS.md"))).toBe(true);
  });

  it("the VM installs it before the daemon starts any session, and a deploy sync never deletes it", () => {
    const ep = read("deploy/ansible/templates/entrypoint.sh.j2");
    const install = ep.indexOf(
      'install -m 0444 "$SANDBOX/deploy/reviewer/AGENTS.override.md" "$SANDBOX/AGENTS.override.md"',
    );
    expect(install).toBeGreaterThan(-1);
    expect(install).toBeLessThan(ep.indexOf("tmux new-session"));
    expect(install).toBeLessThan(ep.indexOf('exec node "$SANDBOX/dist/src/wire.js"'));
    // ANCHORED: an unanchored pattern would also skip the stub's SOURCE under
    // deploy/reviewer/ and the VM would install a stale copy.
    expect(read("deploy/ansible/playbook.yml")).toContain('- "--exclude=/AGENTS.override.md"');
  });

  it("the plain-Docker path does NOT install it — there the sandbox root is the operator's checkout", () => {
    const ep = read("docker/daemon/entrypoint.sh");
    expect(ep).not.toMatch(/install[^\n]*AGENTS\.override\.md/);
    expect(ep).toMatch(/NO reviewer context stub on this path/);
  });

  it("the bench image reads the same stub production does", () => {
    // bench.sh builds from an explicit allowlist: the stub must be ON it, or
    // the COPY below fails the build.
    expect(read("bench/aacr/bench.sh")).toContain(STUB);
    const df = read("bench/aacr/Dockerfile");
    expect(df).toContain(`COPY ${STUB} ./AGENTS.override.md`);
    expect(df.indexOf(`COPY ${STUB}`)).toBeGreaterThan(
      df.indexOf("WORKDIR /opt/quickreview/sandbox"),
    );
  });

  it("no session can rewrite it, or the guide it replaces", () => {
    for (const name of ["AGENTS.override.md", "AGENTS.md", "CLAUDE.md"])
      expect(isPolicySurface(`/opt/quickreview/sandbox/${name}`), name).toBe(true);
  });
});
