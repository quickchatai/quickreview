// The reviewer context stub: pi loads the first of AGENTS.override.md /
// AGENTS.md / CLAUDE.md from the cwd into every session and every lens pass,
// and they all run in the sandbox root, so without a stub the full
// contributor guide would ride every turn of every review. On the VM the
// entrypoint installs a short stub there instead; the bench image copies the same stub;
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

  it("the VM image bakes it read-only into the engine's cwd, and the daemon mode re-installs it before any session starts", () => {
    const dockerfile = read("docker/Dockerfile");
    expect(dockerfile).toContain("COPY deploy/reviewer/AGENTS.override.md ./AGENTS.override.md");
    expect(dockerfile).toMatch(/chmod 0444 \/opt\/qcr\/AGENTS\.override\.md/);
    const ep = read("docker/entrypoint.sh");
    const daemon = ep.slice(ep.indexOf("mode_daemon() {"), ep.indexOf("mode_companion() {"));
    const install = daemon.indexOf('install -m 0444 "$stub_src" "$stub"');
    expect(install).toBeGreaterThan(-1);
    expect(install).toBeLessThan(daemon.indexOf("tmux new-session"));
    expect(install).toBeLessThan(daemon.indexOf('exec node "$APP/dist/src/wire.js"'));
    // Nothing is rsynced onto the VM any more (the stub rides the image), so the
    // old anchored rsync exclude has nothing left to guard.
    expect(read("deploy/ansible/playbook.yml")).not.toContain('AGENTS.override.md"');
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
