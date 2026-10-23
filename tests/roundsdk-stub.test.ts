// The SDK round's reviewer stub (D34) is found where a checkout keeps it and
// where the release and bench images install it.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { reviewerStub } from "@quickchatai/pi-quickreview/src/engine/roundsdk.js";

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});
function tree(): string {
  const d = mkdtempSync(join(tmpdir(), "qcr-stub-"));
  dirs.push(d);
  return d;
}

describe("reviewerStub", () => {
  it("reads a checkout's deploy/reviewer/AGENTS.override.md", () => {
    const root = tree();
    mkdirSync(join(root, "deploy", "reviewer"), { recursive: true });
    writeFileSync(join(root, "deploy", "reviewer", "AGENTS.override.md"), "checkout stub");
    expect(reviewerStub(root, "/work")).toEqual({
      path: "/work/AGENTS.override.md",
      content: "checkout stub",
    });
  });

  it("reads an image's root AGENTS.override.md when the checkout path is absent", () => {
    const root = tree();
    writeFileSync(join(root, "AGENTS.override.md"), "image stub");
    expect(reviewerStub(root, "/work").content).toBe("image stub");
  });

  it("prefers the checkout path when both exist", () => {
    const root = tree();
    mkdirSync(join(root, "deploy", "reviewer"), { recursive: true });
    writeFileSync(join(root, "deploy", "reviewer", "AGENTS.override.md"), "checkout stub");
    writeFileSync(join(root, "AGENTS.override.md"), "image stub");
    expect(reviewerStub(root, "/work").content).toBe("checkout stub");
  });

  it("fails loudly, naming both places, when neither exists", () => {
    const root = tree();
    expect(() => reviewerStub(root, "/work")).toThrow(
      /reviewer context stub is missing at .* and /,
    );
  });
});
