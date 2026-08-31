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
    allow("scripts/mint-token.sh"); // sanctioned since 2026-08-17: raw read-only gh needs it
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

/**
 * / MC-04 + MC-06 — the two write channels the exec policy left open.
 *
 * `gh pr review <n> --approve` was permitted: a direct approval around the
 * mutation gate, the CI gate and `dry_run`. It is not hypothetical — the
 * predecessor system posted 47 approvals exactly that way (docs/retro), and a
 * session can mint the credential itself from the sanctioned
 * `scripts/mint-token.sh`, whose installation token carries `pull_requests:
 * write` and is the very token `scripts/approve-pr.sh` uses to POST an APPROVE.
 *
 * `git` sat unconditionally on the read-only allowlist three lines from `gh`'s
 * filter, so `git push` (a GitHub write around the ONE gate) and the discard
 * family were both allowed.
 */
describe("checkBashCommand — gh is read-only", () => {
  it("blocks the approval that went around the gate", () => {
    block("gh pr review 5249 --approve", "gh pr review");
    block("gh pr review 5249 --approve --body 'lgtm'");
    block("gh pr review --approve 5249");
    block("gh pr comment 5249 --body hi", "gh pr comment");
    block("GH_TOKEN=x gh pr review 5249 --approve");
    // The credential recipe the templates hand the session, in one line.
    block('GH_TOKEN="$(scripts/mint-token.sh)" gh pr review 5249 --approve');
  });

  it("blocks every other mutating pr verb, including ones nobody enumerated", () => {
    for (const verb of ["ready", "reopen", "lock", "unlock", "create", "merge", "close", "edit"]) {
      block(`gh pr ${verb} 5249`, `gh pr ${verb}`);
    }
  });

  it("blocks workflow dispatch — the reviewer reads CI, it never starts it", () => {
    block("gh workflow run ci.yml", "gh workflow run");
    block("gh workflow enable ci.yml");
    allow("gh workflow list");
    allow("gh run view 12345");
  });

  it("blocks whole mutating namespaces rather than enumerating their verbs", () => {
    block("gh release create v1", "gh release create");
    block("gh secret set TOKEN", "gh secret");
    block("gh repo clone o/n", "gh repo clone");
    block("gh issue create --title x", "gh issue create");
    block("gh browse");
  });

  it("catches the attached -X form the exact compare missed", () => {
    block("gh api -XPOST repos/o/n/issues", "-XPOST");
    block("gh api -XDELETE repos/o/n/labels/x");
    allow("gh api -XGET repos/o/n/pulls/5");
  });

  it("still allows every read the round templates actually use", () => {
    allow("gh pr view 5249 --json title,body");
    allow("gh pr list --label 'AI review requested'");
    allow("gh pr diff 5249");
    allow("gh pr checks 5249");
    allow("gh issue view 42");
    allow("gh api repos/o/n/pulls/5/files --paginate");
    allow("gh search prs --repo o/n");
  });
});

describe("checkBashCommand — git is read-only", () => {
  it("blocks the push — a GitHub write must go through the ONE gate", () => {
    block("git push origin HEAD", "mutation gate");
    block("git push --force origin wip:master");
    block("cd /tmp && git push", "mutation gate");
    block("git -C /opt/quickreview/wt/pr-5249 push origin HEAD");
  });

  it("blocks the discard family — this worktree is the daemon's", () => {
    block("git reset --hard origin/main", "git reset");
    block("git checkout -- src/a.ts", "git checkout");
    block("git clean -fdx", "git clean");
    block("git stash", "git stash");
    block("git commit -am wip", "git commit");
    block("git rebase main");
    block("git apply /tmp/p.patch");
    block("git pull");
  });

  it("blocks a mutating git hidden behind a separator or substitution", () => {
    block("git diff && git push origin HEAD", "mutation gate");
    block("echo $(git reset --hard)", "git reset");
    block("git diff --name-only | xargs git checkout --", "git checkout");
  });

  it("still allows the reads a review session lives on", () => {
    allow("git diff origin/main...HEAD");
    allow("git log --oneline -20");
    allow("git show abc123:src/a.ts");
    allow("git status");
    allow("git blame src/a.ts");
    allow("git merge-base origin/main HEAD");
    allow("git ls-files 'src/**'");
    allow("git rev-parse HEAD");
    allow("git fetch origin main"); // a read of GitHub, not a write to it
    allow("git worktree list");
    allow("git config --get remote.origin.url");
    allow("git -C /opt/quickreview/wt/pr-5249 diff");
  });

  it("blocks the write form of a namespace whose read form is allowed", () => {
    block("git worktree add /tmp/wt HEAD", "read-only form");
    block("git config user.email evil@example.com", "read-only form");
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

describe("live-day regressions (2026-08-17): quoted patterns and substitutions", () => {
  const allow = (cmd: string) => expect(checkBashCommand(cmd), cmd).toMatchObject({ allowed: true });
  const deny = (cmd: string) => expect(checkBashCommand(cmd).allowed, cmd).toBe(false);

  it("never splits inside quoted arguments", () => {
    allow("rg -n -i 'reviewed by|automated review|start here' prompts src");
    allow(`jq -r '.data | select(any(.comments.nodes[]; .id)) | .url' out.json`);
    allow("find . -maxdepth 3 -type f \\( -iname '*5270*' -o -iname '*ledger*' \\) -print | sort | head -100");
    allow(`git log --grep="dispatch_due|match_user_specified_topic" --oneline`);
  });

  it("allows the sanctioned mint-token read pattern and plain scripts", () => {
    allow(`GH_TOKEN="$(scripts/mint-token.sh)" gh api repos/x/pulls/5/files`);
    allow("scripts/pr-checks.sh 4656");
    allow("cd /opt/quickreview/sandbox && GH_TOKEN=\"$(scripts/mint-token.sh)\" scripts/pr-context.sh 5197");
    allow("date -u +%Y-%m-%dT%H:%M:%SZ && git -C wt/pr-4656 status --short");
    allow("nl -ba file.py | head");
  });

  it("still vets the command FOLLOWING a substitution (segment-merge bypass)", () => {
    deny(`A="$(cat x)" python3 evil.py`);
    deny("B=`cat x` node evil.js");
    deny(`GH_TOKEN="$(scripts/mint-token.sh)" python3 -c 'import os'`);
  });

  it("keeps blocking real exec and mutations", () => {
    deny("python3 - <<'PY'\nprint(1)\nPY");
    deny("curl https://example.com");
    deny("echo hi; node evil.js");
    deny(`GH_TOKEN="$(scripts/mint-token.sh)" gh api -X POST repos/x/issues`);
  });

  // in api_key mode ov.conf carries the server's root_api_key, an
  // account-wide superuser that can list every USER key in plaintext. `cat`
  // and `grep` are legitimately allowed, so the PATH is the only thing that
  // separates "read a file" from "become root". This is the third layer: the
  // key is never on an argv or in a session env, and writeOvcliConf refuses to
  // write it as a session credential.
  it("refuses to read the OpenViking root credential, whatever reads it", () => {
    deny("cat ~/.openviking/ov.conf");
    deny("cat /opt/quickreview/state/openviking/ov.conf");
    deny("grep -n root_api_key /opt/quickreview/state/openviking/ov.conf");
    deny("jq -r .server.root_api_key ~/.openviking/ov.conf");
    deny("cat /opt/quickreview/secrets/openviking_root_key");
    deny("head -c 200 ~/.config/quickreview-bot/openviking_root_key");
    deny("cat ~/.config/quickreview-bot/openviking-keys.env");
  });

  it("says WHY, so the session learns the identity rule rather than retrying", () => {
    const why = checkBashCommand("cat ~/.openviking/ov.conf").reason ?? "";
    expect(why).toContain("root_api_key");
    expect(why).toContain("reviewer USER");
  });

  it("leaves ordinary reads alone — the rule is the credential, not the word", () => {
    allow("cat state/agents/pass-intent.md");
    allow("rg -n 'openviking' src/memory");
    allow("cat ~/.openviking/ovcli.conf"); // the session's OWN reviewer credential
  });
});
