import { describe, expect, it } from "vitest";
import activate, { checkBashCommand } from "../extensions/bash-guard.js";

const allow = (cmd: string): void => {
  const res = checkBashCommand(cmd);
  expect(res.allowed, `${cmd} → ${res.reason ?? ""}`).toBe(true);
};
const block = (cmd: string, reasonPart?: string): void => {
  const res = checkBashCommand(cmd);
  expect(res.allowed, `${cmd} should be blocked`).toBe(false);
  expect(res.reason).toBeTruthy();
  if (reasonPart) expect(res.reason).toContain(reasonPart);
};

describe("checkBashCommand — allowed read-only commands", () => {
  it("allows plain read-only pipelines and lookups", () => {
    allow("git diff | head");
    allow("rg -n foo");
    allow("gh pr checks 5249");
    allow("gh api repos/x/pulls/5/files");
    allow("cat src/a.ts | grep -c foo");
    allow("git log --oneline -5 2>&1 | tail -3");
  });

  it("skips env VAR=val prefixes, env itself, cd and subshell parens", () => {
    allow("FOO=1 git status");
    allow("env FOO=1 git status");
    allow("cd src && git log");
    allow("(git diff)");
    allow("echo done");
  });

  it("allows xargs only onto allowed programs", () => {
    allow("git diff --name-only | xargs grep foo");
    block("echo x.py | xargs python", "python");
  });

  it("allows sh only as a syntax check", () => {
    allow("sh -n scripts/pr-checks.sh");
    block("sh evil.sh", "'sh'");
  });
});

describe("checkBashCommand — sanctioned scripts", () => {
  it("allows sanctioned scripts/*.sh directly and via bash", () => {
    allow("scripts/pr-context.sh 5249");
    allow("./scripts/pr-threads.sh 5249");
    allow("bash scripts/post-review.sh 5249 REQUEST_CHANGES body.md");
    allow("bash scripts/approve-pr.sh 5249");
  });

  it("blocks non-sanctioned scripts, traversal and absolute paths", () => {
    block("scripts/deploy.sh");
    block("scripts/mint-token.sh");
    block("bash scripts/../deploy.sh");
    block("bash /tmp/evil.sh");
    block("bash");
  });
});

describe("checkBashCommand — blocked executors", () => {
  it("blocks direct execution", () => {
    block("python x.py", "'python'");
    block("uv run pytest", "'uv'");
    block("npm test", "'npm'");
    block("/usr/bin/node server.js", "'node'");
    block("make build");
    block("cargo test");
  });

  it("blocks executors hidden behind separators and substitution", () => {
    block("git diff && python -c 1", "'python'");
    block("echo hi; node evil.js", "'node'");
    block("git log || pip install x", "'pip'");
    block("echo $(python -c 1)", "'python'");
    block("cat `node gen.js`", "'node'");
  });
});

describe("checkBashCommand — gh mutating verbs", () => {
  it("blocks gh pr merge/close/edit", () => {
    block("gh pr merge 5249", "gh pr merge");
    block("gh pr close 5249");
    block("gh pr edit 5249 --title x");
  });

  it("blocks mutating gh api, allows plain GET", () => {
    block("gh api -X POST repos/x/issues");
    block("gh api --method DELETE repos/x/labels/foo");
    block("gh api repos/x/pulls/5/reviews -f event=APPROVE");
    block("gh api repos/x -F body=@file");
    allow("gh api repos/x/pulls/5/files");
    allow("gh api -X GET repos/x/pulls/5");
  });
});

describe("activate (pi hookup)", () => {
  it("registers a tool_call handler that blocks bash exec and passes everything else", () => {
    let handler: ((event: Record<string, unknown>) => unknown) | undefined;
    const pi = {
      on: (event: string, h: (e: Record<string, unknown>) => unknown) => {
        if (event === "tool_call") handler = h;
      },
    };
    activate(pi as never);
    expect(handler).toBeDefined();
    expect(handler!({ toolName: "bash", input: { command: "python x.py" } })).toMatchObject({ block: true });
    expect(handler!({ toolName: "bash", input: { command: "git status" } })).toBeUndefined();
    expect(handler!({ toolName: "read", input: { command: "python x.py" } })).toBeUndefined();
    // arguments fallback field name (VERIFY-ON-PIN both ways)
    expect(handler!({ toolName: "bash", arguments: { command: "npm test" } })).toMatchObject({ block: true });
  });
});
