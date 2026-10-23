// The reviewer stub has two homes: a checkout keeps it at
// deploy/reviewer/AGENTS.override.md, the release and bench images install it at
// the tree's root as AGENTS.override.md. Every route that copies or reads it
// resolves it through packages/pi-plugin/src/reviewerstub.ts, so a route cannot look in one place
// only (the 1.0.0 release e2e failed exactly that way: the review route looked
// for the checkout's path inside the image).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  findReviewerStub,
  reviewerStubSource,
} from "@quickchatai/pi-quickreview/src/reviewerstub.js";

const tmp = mkdtempSync(join(tmpdir(), "qcr-reviewerstub-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function tree(name: string, files: string[]): string {
  const root = join(tmp, name);
  for (const f of files) {
    mkdirSync(join(root, f, ".."), { recursive: true });
    writeFileSync(join(root, f), "stub\n");
  }
  mkdirSync(root, { recursive: true });
  return root;
}

describe("the reviewer stub's source", () => {
  it("a checkout: deploy/reviewer/AGENTS.override.md", () => {
    const root = tree("checkout", ["deploy/reviewer/AGENTS.override.md"]);
    expect(reviewerStubSource(root)).toBe(join(root, "deploy", "reviewer", "AGENTS.override.md"));
  });

  it("the release image: AGENTS.override.md at the tree's root", () => {
    const root = tree("image", ["AGENTS.override.md"]);
    expect(reviewerStubSource(root)).toBe(join(root, "AGENTS.override.md"));
  });

  it("neither: null from find, a loud error from the source", () => {
    const root = tree("empty", []);
    expect(findReviewerStub(root)).toBeNull();
    expect(() => reviewerStubSource(root)).toThrow(/reviewer context stub is missing/);
  });

  it("the image installs it at the root, where the resolver looks", async () => {
    const { readFileSync } = await import("node:fs");
    const dockerfile = readFileSync(
      join(import.meta.dirname, "..", "docker", "Dockerfile"),
      "utf8",
    );
    expect(dockerfile).toMatch(
      /COPY deploy\/reviewer\/AGENTS\.override\.md \.\/AGENTS\.override\.md/,
    );
  });
});
