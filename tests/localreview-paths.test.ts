// packages/pi-plugin/src/localreview.ts: a changed file with a non-ASCII or tab-bearing name keeps
// its real path (git's numstat would C-quote it), and a capped run's raw
// findings record reads the way a finished run's does, and a candidate the
// validator doubted is listed apart, never as a finding. Real throwaway git repo.

import { afterAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  doubtedFindings,
  groupFindings,
  resolveUncommitted,
} from "@quickchatai/pi-quickreview/src/localreview.js";

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

  // A candidate the validator doubted "may not be valid" and is never posted
  // (findingkey.ts): it is no finding, and its refutation is no title.
  // MUTATION: drop "doubted" from localreview.ts HIDDEN — this fails.
  it("never lists or counts a candidate the validator doubted", () => {
    const g = groupFindings({
      findings: [
        { path: "a.ts", line: 1, severity: "P1", title: "real", disposition: "posted" },
        {
          path: "a.ts",
          line: 2,
          severity: "P0",
          disposition: "doubted",
          word: "refuted",
          reason: "the guard on line 1 already rejects it",
        },
      ],
    });
    expect(Object.keys(g)).toEqual(["P1"]);
    expect(JSON.stringify(g)).not.toContain("already rejects");
  });
});

describe("doubtedFindings on a raw record", () => {
  // MUTATION: fall back to the reason in doubtedFindings' title — this fails.
  it("lists each doubted candidate with its own title, word and reason", () => {
    const d = doubtedFindings({
      findings: [
        { path: "a.ts", line: 1, severity: "P1", title: "real", disposition: "posted" },
        {
          path: "a.ts",
          line: "2",
          severity: "P0",
          lens: "pass-x",
          disposition: "doubted",
          word: "refuted",
          reason: "the guard on line 1 already rejects it",
          evidence: "x can be null here\nsecond line",
        },
        {
          path: "b.ts",
          line: 5,
          severity: "P2",
          title: "a race on close",
          disposition: "doubted",
          word: "unverifiable",
          reason: "no caller reaches it",
        },
        { path: "c.ts", line: 9, severity: "P1", disposition: "doubted" },
        { path: "d.ts", line: 1, severity: "P1", title: "gone", disposition: "killed" },
      ],
    });
    expect(d).toEqual([
      {
        path: "a.ts",
        line: 2,
        severity: "P0",
        title: "x can be null here",
        lens: "pass-x",
        word: "refuted",
        reason: "the guard on line 1 already rejects it",
      },
      {
        path: "b.ts",
        line: 5,
        severity: "P2",
        title: "a race on close",
        lens: null,
        word: "unverifiable",
        reason: "no caller reaches it",
      },
      {
        path: "c.ts",
        line: 9,
        severity: "P1",
        title: "(untitled candidate)",
        lens: null,
        word: null,
        reason: null,
      },
    ]);
  });

  // The parser's own fold (findingsrecord.ts): a validity veto recorded as a
  // kill is still a doubt, so the report shows it as one.
  // MUTATION: read only disposition "doubted" in doubtedFindings — this fails.
  it("reads a kill carrying a doubt word as doubted", () => {
    const d = doubtedFindings({
      candidates: [
        { path: "a.ts", line: 3, title: "t", disposition: "killed", word: "Refuted" },
        { path: "a.ts", line: 4, title: "u", disposition: "killed", word: "below-bar" },
      ],
    });
    expect(d.map((x) => x.title)).toEqual(["t"]);
  });
});
