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

  // A credential may be any provider's login, or a key: the app says whether
  // pi has a model route, and no file's presence stands in for that.
  // MUTATION: put `test -f /pi/agent/auth.json` back as the step's probe — this fails.
  it("asks the app for a model route over the read-only pi home, never for a login file", () => {
    const code = script
      .split("\n")
      .filter((line) => !/^\s*#/.test(line))
      .join("\n");
    expect(code).not.toMatch(/test -[fs] [^\n]*auth\.json/);
    expect(code).toMatch(/--network none --volume "\$PIHOME_VOLUME:\/pi:ro"/);
    expect(code).toMatch(/dist\/src\/cli\.js model --json/);
    expect(code).toMatch(/grep -q '"ok":true'/);
  });

  it("probes the tmux server, not just the tmux binary", () => {
    expect(script).not.toMatch(/tmux -V/);
    expect(script).toMatch(/tmux show-options -s exit-empty/);
  });
});
