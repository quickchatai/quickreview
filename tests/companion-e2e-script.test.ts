// scripts/companion-e2e.sh asserts the image's real contract: pi is the
// package-local bin (docker/Dockerfile forbids pi on PATH), and the tmux check
// contacts a server rather than only running the binary.
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const script = readFileSync(join(root, "scripts", "companion-e2e.sh"), "utf8");

describe("scripts/companion-e2e.sh", () => {
  it("checks pi at the image's package-local bin, never on PATH", () => {
    expect(script).not.toMatch(/command -v pi/);
    expect(script).toContain("/opt/qcr/node_modules/.bin/pi");
  });

  it("probes the tmux server, not just the tmux binary", () => {
    expect(script).not.toMatch(/tmux -V/);
    expect(script).toMatch(/tmux show-options -s exit-empty/);
  });
});
