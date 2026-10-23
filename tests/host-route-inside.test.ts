// The host route's "run directory outside every checkout" guard must treat a
// directory whose name merely starts with two dots as inside its parent.
import { afterAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareHostRun } from "../src/hostroute.js";
import { isInside } from "../src/pathinside.js";

const tmp = realpathSync(mkdtempSync(join(tmpdir(), "host-inside-")));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe("isInside", () => {
  it("is lexical containment: the parent itself and its descendants, with `..`-prefixed names inside", () => {
    expect(isInside("/a/b", "/a/b")).toBe(true);
    expect(isInside("/a/b/c", "/a/b")).toBe(true);
    expect(isInside("/a/b/..runs/out", "/a/b")).toBe(true);
    expect(isInside("/a/b/..", "/a/b")).toBe(false);
    expect(isInside("/a/c", "/a/b")).toBe(false);
  });
});

describe("prepareHostRun checkout guard", () => {
  it("refuses a run directory under a `..`-prefixed folder of the checkout", () => {
    const repo = join(tmp, "repo");
    mkdirSync(join(repo, ".git"), { recursive: true });
    const cwd = join(repo, "..runs", "out");
    mkdirSync(cwd, { recursive: true });
    expect(() =>
      prepareHostRun({
        root: join(tmp, "elsewhere"),
        srcAgentDir: join(tmp, "src-agent"),
        agentDir: join(tmp, "agent"),
        cwd,
        cfg: {} as never,
        needMs: 0,
        checkouts: [repo],
      }),
    ).toThrow(/inside the checkout/);
  });
});
