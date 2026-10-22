// src/localreview.ts: a changed file with a non-ASCII or tab-bearing name keeps
// its real path (git's numstat would C-quote it), and a capped run's raw
// findings record reads the way a finished run's does. Real throwaway git repo.

import { afterAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { groupFindings, resolveUncommitted } from "../src/localreview.js";

const tmp = mkdtempSync(join(tmpdir(), "localreview-paths-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const git = (cwd: string, ...args: string[]): string =>
  execFileSync(
    "git",
    ["-c", "user.name=T", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args],
    { cwd, encoding: "utf8" },
  ).trim();

describe("diff file names", () => {
  it("keeps the real path of a non-ASCII or tab-bearing file and its patch", () => {
    const repo = join(tmp, "repo");
    mkdirSync(repo, { recursive: true });
    git(repo, "init", "-q", "-b", "main");
    writeFileSync(join(repo, "base.txt"), "x\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "base");
    writeFileSync(join(repo, "zażółć.txt"), "one\n");
    writeFileSync(join(repo, "a\tb.txt"), "two\n");
    const r = resolveUncommitted(repo);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const byName = new Map(r.target.files.map((f) => [f.filename, f]));
    expect([...byName.keys()].sort()).toEqual(["a\tb.txt", "zażółć.txt"]);
    for (const f of byName.values()) {
      expect(f.status).toBe("added");
      expect(f.patch).toMatch(/^\+/m);
    }
  });
});

describe("groupFindings on a raw record", () => {
  it("reads the candidates alias and a numeric-string line", () => {
    const g = groupFindings({
      candidates: [{ path: "a.ts", line: "42", severity: "P1", title: "t", lens: "pass-x" }],
    });
    expect(g["P1"]).toEqual([
      { path: "a.ts", line: 42, severity: "P1", title: "t", lens: "pass-x" },
    ]);
  });
});
