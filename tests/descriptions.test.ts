// One description of QuickReview on every published surface.
//
// A person meets QuickReview on npm, in `qcr help`, in a coding agent's
// plugin list, on the Action and on the image. Each says what it is in the
// same words, so no surface grows a tagline of its own:
//
//   - the root package.json's `description` is the sentence, and `qcr help`
//     (src/qcrbin.ts TAGLINE) and the release image's description label
//     (docker/Dockerfile) carry it word for word;
//   - a surface that needs a sentence of its own (the pi plugin's package,
//     the host plugins' one manifest line, the Action) names the same thing.
//
// The GitHub repository's About is set on GitHub, not in this tree, so
// nothing here reads it.
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { loadSource } from "../plugins/qcr/render.mjs";
import { BIN_HELP, TAGLINE } from "../src/qcrbin.js";

const ROOT = resolve(import.meta.dirname, "..");
const read = (rel: string): string => readFileSync(join(ROOT, rel), "utf8");
const pkg = (rel: string): { description: string } =>
  JSON.parse(read(rel)) as { description: string };

/** What every surface calls QuickReview. */
const WHAT = "an open-source AI code reviewer";

describe("the one-line description", () => {
  // MUTATION: reword package.json's description alone, or the label in
  // docker/Dockerfile alone — this fails.
  it("is package.json's, word for word, in qcr help and on the release image", () => {
    expect(pkg("package.json").description).toBe(TAGLINE);
    expect(BIN_HELP.split("\n").slice(0, 2)).toEqual(["qcr — QuickReview", TAGLINE]);
    expect(read("docker/Dockerfile")).toContain(
      `org.opencontainers.image.description="${TAGLINE}"`,
    );
    expect(TAGLINE.toLowerCase()).toContain(WHAT.toLowerCase());
  });

  // MUTATION: write "QuickReview's multi-lens AI code review" back into
  // plugins/qcr/templates/plugin.txt — this fails.
  it.each([
    ["the pi plugin's package", (): string => pkg("packages/pi-plugin/package.json").description],
    ["the host plugins' manifest line", (): string => loadSource().description],
    [
      "the Action",
      (): string => (parse(read("action.yml")) as { description: string }).description,
    ],
  ])("%s names QuickReview and the same thing", (_where, text) => {
    expect(text()).toContain("QuickReview");
    expect(text()).toContain(WHAT);
  });

  // An Antigravity manifest carries its release as a sentence after this one
  // (plugins/qcr/render.mjs), and a skill's front matter is YAML.
  // MUTATION: drop the full stop that ends plugin.txt, or write
  // "QuickReview: a reviewer" in it — this fails.
  it("the host plugins' manifest line ends with a full stop and is a plain YAML scalar", () => {
    const line = loadSource().description;
    expect(line).not.toContain("\n");
    expect(line.endsWith(".")).toBe(true);
    expect(line).not.toMatch(/: | #|^[-?:,[\]{}#&*!|>'"%@`]/);
  });
});
