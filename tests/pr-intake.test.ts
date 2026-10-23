// The PR intake workflow (.github/workflows/pr-intake.yml). Its one step runs
// for real under bash against a fake gh on the PATH, which logs every call:
//   - a maintainer's PR is never checked, by association or, for a member
//     whose org membership is private, by repository permission;
//   - an outside PR asking for review without an open issue or the
//     self-review fails the check with one comment; on a draft it passes;
//   - nothing ever converts a PR to a draft (the workflow's token cannot).
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const wf = parse(readFileSync(join(root, ".github", "workflows", "pr-intake.yml"), "utf8")) as {
  on: { pull_request_target: { types: string[] } };
  jobs: { intake: { env: Record<string, string>; steps: { run: string }[] } };
};
const step = wf.jobs.intake.steps[0]!;

const SELF_REVIEW =
  "## QuickReview self-review\n\n2 findings.\n\n### What I did with each finding\n";
const COMPLETE = `Closes #7\n\n${SELF_REVIEW}`;

const dirs: string[] = [];
interface Case {
  body?: string;
  draft?: boolean;
  association?: string;
  perm?: string;
  issue?: string;
  comment?: string;
}
function run(c: Case) {
  const dir = mkdtempSync(join(tmpdir(), "pr-intake-"));
  dirs.push(dir);
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const log = join(dir, "gh.log");
  writeFileSync(log, "");
  // `api .../permission` prints FAKE_PERM (fails when unset, as a refused
  // lookup does); `api .../issues/<n>` prints FAKE_ISSUE; the comment listing
  // prints FAKE_COMMENT_ID; every other call succeeds silently.
  writeFileSync(
    join(bin, "gh"),
    `#!/usr/bin/env node
const fs = require("node:fs");
const a = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify(a) + "\\n");
const path = a.find((x) => x.startsWith("repos/")) || "";
if (a[0] === "api" && path.endsWith("/permission")) {
  if (!process.env.FAKE_PERM) process.exit(1);
  console.log(process.env.FAKE_PERM); process.exit(0);
}
if (a[0] === "api" && /\\/issues\\/\\d+\\/comments$/.test(path)) {
  if (process.env.FAKE_COMMENT_ID) console.log(process.env.FAKE_COMMENT_ID);
  process.exit(0);
}
if (a[0] === "api" && /\\/issues\\/\\d+$/.test(path)) { console.log(process.env.FAKE_ISSUE || "open"); process.exit(0); }
process.exit(0);
`,
  );
  chmodSync(join(bin, "gh"), 0o755);
  const r = spawnSync("bash", ["-c", step.run], {
    env: {
      PATH: `${bin}:${process.env.PATH!}`,
      FAKE_LOG: log,
      REPO: "o/r",
      PR: "12",
      ACTION: "ready_for_review",
      DRAFT: String(c.draft ?? false),
      ASSOCIATION: c.association ?? "CONTRIBUTOR",
      AUTHOR: "someone",
      BODY: c.body ?? "",
      ...(c.perm ? { FAKE_PERM: c.perm } : {}),
      ...(c.issue ? { FAKE_ISSUE: c.issue } : {}),
      ...(c.comment ? { FAKE_COMMENT_ID: c.comment } : {}),
    },
    encoding: "utf8",
  });
  const calls = readFileSync(log, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as string[]);
  return { status: r.status, calls, out: r.stdout + r.stderr };
}
const said = (calls: string[][]): string[] =>
  calls
    .filter((c) => (c[0] === "pr" && c[1] === "comment") || c.includes("PATCH"))
    .map((c) => c[c.length - 1]!);

describe("pr-intake.yml", () => {
  it("passes the author's login and association in as environment, never into the script", () => {
    expect(wf.jobs.intake.env.AUTHOR).toBe("${{ github.event.pull_request.user.login }}");
    expect(wf.jobs.intake.env.ASSOCIATION).toBe(
      "${{ github.event.pull_request.author_association }}",
    );
    expect(step.run).not.toMatch(/\$\{\{/);
  });

  it("re-runs when a PR is converted to a draft, so a failed check can clear", () => {
    expect(wf.on.pull_request_target.types).toEqual(
      expect.arrayContaining(["opened", "edited", "ready_for_review", "converted_to_draft"]),
    );
  });

  // MUTATION: put `gh pr ready "$PR" --repo "$REPO" --undo` back on an
  // opened PR — this fails.
  it("never converts a PR to a draft", () => {
    expect(step.run).not.toMatch(/gh pr ready|convertPullRequestToDraft/);
    for (const c of [{ draft: false }, { draft: true }, { body: COMPLETE }]) {
      const r = run(c);
      expect(r.calls.filter((x) => x[0] === "pr" && x[1] === "ready")).toEqual([]);
    }
  });

  it("a maintainer's PR by association is not checked", () => {
    for (const association of ["OWNER", "MEMBER", "COLLABORATOR"]) {
      const r = run({ association });
      expect(r.status, association).toBe(0);
      expect(r.calls, association).toEqual([]);
    }
  });

  // MUTATION: drop the permission lookup — a private org member reads as
  // CONTRIBUTOR, is checked as an outsider and this fails.
  it("a CONTRIBUTOR with admin or write on the repository is a maintainer", () => {
    for (const perm of ["admin", "write"]) {
      const r = run({ perm });
      expect(r.status, perm).toBe(0);
      expect(said(r.calls), perm).toEqual([]);
      expect(r.calls[0]).toEqual([
        "api",
        "repos/o/r/collaborators/someone/permission",
        "--jq",
        ".permission",
      ]);
    }
  });

  // MUTATION: `exit 0` after the ready-for-review comment — this fails.
  it("an outside PR asking for review without the issue and the self-review fails, naming both", () => {
    for (const perm of ["read", ""]) {
      const r = run({ perm, body: "no template" });
      expect(r.status, perm).toBe(1);
      const [text] = said(r.calls);
      expect(text).toContain("<!-- qcr-pr-intake -->");
      expect(text).toContain("This PR asks for review but is not ready for it");
      expect(text).toContain("an open issue, linked as `Closes #<issue>`");
      expect(text).toContain("the QuickReview self-review");
      expect(r.out).toContain("::error::missing:");
    }
  });

  it("a closed issue is not enough", () => {
    const r = run({ body: COMPLETE, issue: "closed" });
    expect(r.status).toBe(1);
    expect(said(r.calls)[0]).toContain("an open issue: #7 is closed");
  });

  it("an outside draft without them passes, with the same list as a comment", () => {
    const r = run({ draft: true, body: "no template" });
    expect(r.status).toBe(0);
    expect(said(r.calls)[0]).toContain(
      "Thanks for the PR. Before it is ready for review it needs:",
    );
  });

  it("a complete outside PR passes, and says so only where it said something before", () => {
    const fresh = run({ body: COMPLETE });
    expect(fresh.status).toBe(0);
    expect(said(fresh.calls)).toEqual([]);
    const edited = run({ body: COMPLETE, comment: "99" });
    expect(edited.status).toBe(0);
    const patch = edited.calls.find((c) => c.includes("PATCH"))!;
    expect(patch).toContain("repos/o/r/issues/comments/99");
    expect(said(edited.calls)[0]).toContain("Everything the intake asks for is here.");
  });

  it("cleans up", () => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });
});
