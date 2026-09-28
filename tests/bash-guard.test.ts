import { describe, expect, it } from "vitest";
import activate, {
  checkBashCommand,
  checkReaderModes,
  checkWritePath,
} from "../extensions/bash-guard.js";

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
    block("gh api -XPOST repos/o/n/issues", "sends POST");
    block("gh api -XDELETE repos/o/n/labels/x", "sends DELETE");
    allow("gh api -XGET repos/o/n/pulls/5");
  });

  /**
   * F1, the blocker adversarial review found: `gh api --input <file>` promotes
   * gh's default GET to POST, and the flag blocklist did not name it. This is
   * the recipe the PREDECESSOR system actually used for every review it posted
   * — "a JSON file written with `Write` then `POST`ed via
   * `gh api .../pulls/<n>/reviews --input`"
   * (docs/retro/sources/12-review-content.md:5). Closing `gh pr review` while
   * leaving this open would have shut the documented door and left the
   * historical one wide.
   *
   * Verified empirically against gh 2.93.0 on a loopback server, not from
   * docs: `--input` → POST, `--input=` → POST, bare → GET,
   * `--method GET --input` → GET.
   */
  it("blocks gh api --input, which POSTs — the predecessor's actual approval channel", () => {
    block("gh api repos/o/n/pulls/5/reviews --input /tmp/rev.json", "sends POST");
    block("gh api repos/o/n/pulls/5/reviews --input=/tmp/rev.json", "sends POST");
    block("gh api repos/o/n/pulls/5/reviews --input -", "sends POST");
    // The whole chain, exactly as a session would write it: write the body
    // with the ordinary write tool, mint the token from the sanctioned script,
    // POST an APPROVE with no gate, no CI gate and no dry_run.
    block(
      'GH_TOKEN="$(bash scripts/mint-token.sh)" gh api repos/o/n/pulls/5/reviews --input /tmp/rev.json',
      "sends POST",
    );
  });

  /**
   * G2: `GH_API_BODY_FLAGS` was complete by flag NAME and still bypassed,
   * because a name is not a FORM. `-fevent=APPROVE` attaches the value and
   * `-if` clusters the boolean `-i` in front of `-f`; neither matched, `body`
   * stayed false, and the effective method resolved to GET — restoring the F1
   * chain verbatim one character away from the spelling F1's own test blocks.
   *
   * Verified sending POST on gh 2.93.0 against a loopback server.
   */
  it("blocks the ATTACHED and CLUSTERED short body flags — same failure mode as F1", () => {
    block("gh api repos/o/n/pulls/5/reviews -fevent=APPROVE", "sends POST");
    block("gh api repos/o/n/pulls/5/reviews -Fevent=APPROVE", "sends POST");
    block("gh api repos/o/n/pulls/5/reviews -if event=APPROVE", "sends POST");
    // The full chain, exactly as verified.
    block(
      'GH_TOKEN="$(bash scripts/mint-token.sh)" gh api repos/o/n/pulls/5/reviews -fevent=APPROVE',
      "sends POST",
    );
    // The detached spellings the name-based set already covered stay blocked.
    block("gh api repos/o/n/pulls/5/reviews -f event=APPROVE", "sends POST");
  });

  it("still allows the read forms, including the -i that is --include, not --input", () => {
    // `-i` is `--include` (print response status line and headers) — a pure
    // READ flag, and `--input` has no short form. Blocking it would break
    // legitimate reads and buy nothing.
    allow("gh api -i repos/o/n/pulls/5");
    allow("gh api --include repos/o/n/pulls/5");
    // `-i` contains no f/F, so the cluster rule cannot catch it; `-X`/`-XGET`
    // contain neither either and go through the explicit-method branch.
    allow("gh api -i -XGET repos/o/n/pulls/5");
    // Explicit GET wins even with a body flag — verified: the fields become
    // query parameters and the request is a GET.
    allow("gh api repos/o/n/search -XGET -fevent=APPROVE");
    // An explicit GET wins over the body flag's promotion (verified).
    allow("gh api repos/o/n/search --method GET --input /tmp/q.json");
    allow("gh api repos/o/n/pulls/5/files --paginate --jq '.[].filename'");
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
    block("git branch -D master", "read-only form");
    block("git tag -d v1", "read-only form");
    allow("git branch --contains HEAD");
    allow("git tag --list 'v*'");
  });

  /**
   * F2, the second blocker: `git -c` hands git a command to run, and the verb
   * blocklist could not see it because the payload rides an ALLOWED read verb
   * — or, in the alias form, mints a brand-new verb in one token. The no-exec
   * policy is this extension's entire purpose.
   *
   * VERIFIED executing on this host, not inferred:
   *   git -c "alias.probe=!<cmd>" probe   → ran <cmd>
   * (`core.pager` did not fire only because a tool call's stdout is not a TTY.)
   */
  it("blocks git -c and its kin — config-supplied shell is still shell", () => {
    block("git -c core.pager='sh -c \"npm test\"' log -1", "command to run");
    block("git -c alias.x='!npm test' x", "command to run");
    block("git -c core.sshCommand='npm test' fetch origin", "command to run");
    block("git -c alias.p=push p origin HEAD", "command to run");
    block("git --config-env=core.pager=EVIL log", "command to run");
    block("git -c protocol.ext.allow=always log", "command to run");
    // …and after the verb, where it is equally effective.
    block("git log -1 --exec=/tmp/x", "command to run");
    block("git fetch origin --upload-pack=/tmp/x", "command to run");
    // `--exec-path=` used to slip past the very `--exec` option above: the
    // regex anchors on `=` or end, and `--exec` is followed by `-path=`.
    block("git --exec-path=/tmp/evil diff HEAD", "command to run");
  });

  /**
   * G1 — the THIRD member of the family, and the one that reframed it. `-c`
   * INJECTS config and `GIT_EXTERNAL_DIFF` NAMES a program; `--git-dir`
   * RELOCATES the config file git reads, which reaches the same place.
   *
   * VERIFIED by execution on this host:
   *   git config -f <dir>/config diff.external 'sh -c "<cmd>" --'
   *   git --git-dir=<dir> diff --no-index <dir>/A <dir>/B    → ran <cmd>
   *
   * Three things make it as serious as `git -c`: the evil "repo" is ONE
   * PLAIN-TEXT FILE (`--no-index` means git never validates it as a
   * repository — no objects/, no refs/, no `git init`, no exec bit, and a
   * session writes `config` with its ordinary write tool); `--ext-diff` is NOT
   * required, because `git diff` honours `diff.external` by default; and both
   * the flag and the env form work.
   */
  it("blocks --git-dir / --work-tree and their env twins — relocating config is injecting it", () => {
    // The exact verified chain.
    block("git --git-dir=/tmp/gt3 diff --no-index /tmp/gt3/A /tmp/gt3/B", "command to run");
    block("git --git-dir /tmp/gt3 diff --no-index /tmp/gt3/A /tmp/gt3/B");
    block("git --work-tree=/tmp/evil status", "command to run");
    block("GIT_DIR=/tmp/gt3 git diff --no-index /tmp/gt3/A /tmp/gt3/B", "names a program");
    block("GIT_WORK_TREE=/tmp/evil git status", "names a program");
    block("GIT_EXEC_PATH=/tmp/evil git diff", "names a program");
    block("GIT_COMMON_DIR=/tmp/gt3 git log", "names a program");
    block("LD_AUDIT=/tmp/x.so git log", "names a program");
  });

  /**
   * The FOURTH member of "relocate", and the one that showed the category had
   * been implemented too narrowly: git reads config at THREE scopes, and the
   * global/XDG scope has its own relocation controls.
   *
   * `GIT_CONFIG_GLOBAL` and `GIT_CONFIG_SYSTEM` — the EXPLICIT pointers — were
   * already blocked. `HOME` and `XDG_CONFIG_HOME` are the implicit SEARCH PATH
   * those fall back to (`$HOME/.gitconfig`, `$XDG_CONFIG_HOME/git/config`), and
   * were open. The explicit door was shut and the implicit one beside it was
   * not.
   *
   * VERIFIED by execution:
   *   git config -f <dir>/.gitconfig diff.external 'sh -c "<cmd>" --'
   *   HOME=<dir> git diff --no-index <dir>/A <dir>/B          → ran <cmd>
   *   XDG_CONFIG_HOME=<dir> git diff --no-index …             → ran <cmd>
   *
   * Same primitive and the same cost as the repo-scope form: one plain-text
   * file plus one guard-ALLOWED command. No repo, no `git init`, no exec bit,
   * no `--ext-diff`.
   */
  it("blocks HOME / XDG_CONFIG_HOME — the global scope relocates too", () => {
    // The exact verified chains.
    block("HOME=/tmp/g6 git diff --no-index /tmp/g6/A /tmp/g6/B", "names a program");
    block("XDG_CONFIG_HOME=/tmp/g8 git diff --no-index /tmp/g8/A /tmp/g8/B", "names a program");
    // The explicit pointers this category already covered stay covered — the
    // point is that all four spellings reach the same config.
    block("GIT_CONFIG_GLOBAL=/tmp/g6/.gitconfig git log", "names a program");
    block("GIT_CONFIG_SYSTEM=/tmp/g6/.gitconfig git log", "names a program");
    // …and the rule is the variable, not the command it prefixes.
    block("HOME=/tmp/g6 rg foo src/", "names a program");
  });

  /**
   * The regression the third round caught: `-c` after the verb is git's
   * COMBINED MERGE DIFF option, not config injection — and CLAUDE.md's
   * ratified recheck decision requires auditing a hand-resolved conflict
   * against BOTH merge parents, which is exactly what it is for.
   */
  it("still allows git show -c / log -c — the combined merge diff the recheck depends on", () => {
    allow("git show -c HEAD");
    allow("git log -c -1 --patch");
    allow("git diff-tree -c HEAD");
    allow("git show --cc HEAD");
    // …while the top-level position, which is the only place git accepts the
    // config form, stays refused.
    block("git -c alias.x='!npm test' show", "command to run");
  });

  it("allows the reads added after the allowlist inversion", () => {
    allow("git range-diff origin/main...HEAD@{1} origin/main...HEAD");
    allow("git for-each-ref --format='%(refname)' refs/heads");
  });

  it("matches the read-only sub-form POSITIONALLY, not anywhere in the args", () => {
    // A scan over every argument would accept the marker as the VALUE of a
    // write form. The first token after the verb is what decides.
    block("git branch -m list", "read-only form");
    block("git worktree add /tmp/wt list", "read-only form");
    allow("git branch --list 'feature/*'");
  });

  it("blocks the ENV twin of git -c — VAR=val prefixes are skipped by the splitter", () => {
    // VERIFIED executing on this host:
    //   GIT_EXTERNAL_DIFF="<cmd>" git diff --ext-diff -- <file>  → ran <cmd>
    block("GIT_EXTERNAL_DIFF='sh -c \"npm test\"' git diff --ext-diff", "names a program");
    block("GIT_PAGER='sh -c \"npm test\"' git log", "names a program");
    block("GIT_SSH_COMMAND=/tmp/x git fetch origin", "names a program");
    block(
      "GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=alias.x GIT_CONFIG_VALUE_0='!npm test' git x",
      "names a program",
    );
    block("LD_PRELOAD=/tmp/x.so git log", "names a program");
    block("PATH=/tmp/evil git log", "names a program");
    block("BASH_ENV=/tmp/x rg foo", "names a program");
    // An ordinary env prefix is still fine — the rule is the variable, not the shape.
    allow("FOO=1 git status");
    allow("GIT_TERMINAL_PROMPT=0 git fetch origin");
  });

  /**
   * F3: the verb blocklist was asserted to be "a closed, well-known set" and
   * demonstrably was not — `send-pack` is the documented plumbing for the
   * `push` it blocked three lines above. Inverting to an allowlist is what
   * actually closes it, so an unknown verb is refused by construction rather
   * than by enumeration.
   */
  it("refuses write verbs nobody enumerated, because the allowlist closes by construction", () => {
    for (const cmd of [
      "git send-pack origin HEAD",
      "git bundle create /tmp/b.bundle HEAD",
      "git archive --output=/tmp/a.tar HEAD",
      "git svn dcommit",
      "git p4 submit",
      "git daemon --export-all",
      "git fast-export --all",
      "git symbolic-ref HEAD refs/heads/evil",
      "git reflog expire --all",
      "git difftool -y",
      "git update-server-info",
      "git repack -a",
      "git gc --prune=now",
      "git request-pull origin HEAD",
      "git format-patch -1 --stdout",
    ]) {
      block(cmd);
    }
    // …and a verb that simply does not exist, which is what an alias would be.
    block("git totally-made-up-verb", "not a sanctioned read-only git command");
  });

  it("the alias-from-another-repo trick dies with the allowlist too", () => {
    // `git -C /evil <alias>` used to pass a blocklist: the alias name is not a
    // blocked verb. Under the allowlist it is simply not a sanctioned read.
    block("git -C /tmp/evil-repo x", "not a sanctioned read-only git command");
    allow("git -C /opt/quickreview/wt/pr-5249 log --oneline -3");
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
    expect(handler!({ toolName: "bash", input: { command: "python x.py" } })).toMatchObject({
      block: true,
    });
    expect(handler!({ toolName: "bash", input: { command: "git status" } })).toBeUndefined();
    expect(handler!({ toolName: "read", input: { command: "python x.py" } })).toBeUndefined();
    // arguments fallback field name (VERIFY-ON-PIN both ways)
    expect(handler!({ toolName: "bash", arguments: { command: "npm test" } })).toMatchObject({
      block: true,
    });
  });
});

describe("live-day regressions (2026-08-17): quoted patterns and substitutions", () => {
  const allow = (cmd: string) =>
    expect(checkBashCommand(cmd), cmd).toMatchObject({ allowed: true });
  const deny = (cmd: string) => expect(checkBashCommand(cmd).allowed, cmd).toBe(false);

  it("never splits inside quoted arguments", () => {
    allow("rg -n -i 'reviewed by|automated review|start here' prompts src");
    allow(`jq -r '.data | select(any(.comments.nodes[]; .id)) | .url' out.json`);
    allow(
      "find . -maxdepth 3 -type f \\( -iname '*5270*' -o -iname '*ledger*' \\) -print | sort | head -100",
    );
    allow(`git log --grep="dispatch_due|match_user_specified_topic" --oneline`);
  });

  it("allows the sanctioned mint-token read pattern and plain scripts", () => {
    allow(`GH_TOKEN="$(scripts/mint-token.sh)" gh api repos/x/pulls/5/files`);
    allow("scripts/pr-checks.sh 4656");
    allow(
      'cd /opt/quickreview/sandbox && GH_TOKEN="$(scripts/mint-token.sh)" scripts/pr-context.sh 5197',
    );
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
    // the same files at their install-locator homes.
    deny("cat ~/.config/qcr/default/secrets/openviking_root_key");
    deny("cat ~/.config/qcr-operator/default/openviking-keys.env");
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

// ----: the write boundary -------------------------------------------
// The half a command guard cannot reach. Every bypass needed a
// suspicious token in a command; push the same idea one step and the command
// becomes a plain `git diff` and the payload is a FILE. VERIFIED executing on
// this host, with the config-scope pin already in force:
//
//   printf '[diff]\n\texternal = <cmd>\n' >> <clone>/.git/config
//   git diff <base> <head>          → ran <cmd>
//
// The rule is not a list of attacks. It is git's own list of the places it
// reads configuration from — closed, documented, and something a review
// session never writes to for any reason (scoping rule 2: it reads code).
describe("checkWritePath / git's configuration surface", () => {
  const writeBlocked = (p: string): void => {
    const res = checkWritePath(p);
    expect(res.allowed, `${p} should be refused`).toBe(false);
    expect(res.reason).toContain("configuration surface");
  };
  const writeOk = (p: string): void => {
    const res = checkWritePath(p);
    expect(res.allowed, `${p} → ${res.reason ?? ""}`).toBe(true);
  };

  it("refuses every location git reads configuration or hooks from", () => {
    writeBlocked("/opt/quickreview/reviewed-repo/.git/config"); // the fifth bypass, verbatim
    writeBlocked("wt/pr-5249/.git/config");
    writeBlocked(".git/config.worktree");
    writeBlocked("/opt/quickreview/reviewed-repo/.git/worktrees/pr-1/config.worktree");
    writeBlocked(".git/hooks/pre-commit");
    writeBlocked(".git/info/attributes");
    writeBlocked("/home/review/.gitconfig"); // the global scope's file
    writeBlocked("/home/review/.config/git/config"); // the XDG scope's file
    writeBlocked("reviewed-repo/.gitattributes"); // the other half of diff.*.textconv
  });

  it("leaves every write a session legitimately makes alone — this is not a write allowlist", () => {
    writeOk("verdict/pr-5249-round-2.json");
    writeOk("/opt/quickreview/state/ledger/pr-5249.md");
    writeOk("/tmp/review-body.md");
    writeOk("/tmp/comments.json");
    // NOTE — state/agents/pass-intent.md moved to the policy surface
    // below; it is the BUILT pass body pi loads, not a name a session authors.
    writeOk("src/gitconfig-parser.ts"); // a NAME is not a location
    writeOk("docs/git/configuration.md");
    writeOk("notes/gitattributes.md");
  });

  it("closes the same surface when the write rides a shell redirection", () => {
    // The segment splitter skips redirection remnants when hunting the PROGRAM
    // token, which is right for finding the program and wrong for finding the
    // target: `printf … > .git/config` vets as `printf` and would pass.
    block("printf '[diff]\\n' >> .git/config", "configuration surface");
    block("echo '[core]' > wt/pr-5249/.git/config", "configuration surface");
    block("cat evil > /home/review/.gitconfig", "configuration surface");
    block("printf x >/opt/quickreview/reviewed-repo/.git/config", "configuration surface");
    block("sed -i 's/a/b/' .git/config", "configuration surface");
  });

  it("still allows reading those files — the rule is the WRITE, not the path", () => {
    // A blocked read is a loud refusal on work a session legitimately does;
    // `git show HEAD:.gitattributes` is reviewing a file the PR touched.
    allow("cat .git/config");
    allow("git show HEAD:.gitattributes");
    allow("rg -n gitconfig docs/");
    allow("git config --get remote.origin.url");
  });
});

// ----: the boundary protects its OWN configuration too --------------
//
// The exec boundary protected git's configuration and NOT its own. Three write
// targets were `allowed: true` on source AND compiled dist, each found by
// EXECUTION on master:
//
//     cat /tmp/evil > config.toml                     → the guards' own config
//     cat /tmp/evil > dist/extensions/bash-guard.js   → the compiled guard
//     printf 'x'   > scripts/post-review.sh           → the gate's shell mirror
//
// One predicate (`isProtectedWriteTarget`) now binds BOTH boundaries — the
// write/edit tool veto and the shell-redirection / sed scan — so a session
// cannot write through one what it is refused through the other. Every
// redirection spelling below was VERIFIED writing its target in a real bash
// before it was added here; none is asserted from the manual alone.
describe("checkWritePath / this system's own policy surface", () => {
  const writeBlocked = (p: string, reasonPart = "policy surface"): void => {
    const res = checkWritePath(p);
    expect(res.allowed, `${p} should be refused`).toBe(false);
    expect(res.reason).toContain(reasonPart);
  };
  const writeOk = (p: string): void => {
    const res = checkWritePath(p);
    expect(res.allowed, `${p} → ${res.reason ?? ""}`).toBe(true);
  };

  // MUTATION: drop "scripts" (or "dist") from POLICY_SURFACE_DIRS, or
  // "config.toml" from POLICY_SURFACE_FILES, in extensions/bash-guard.ts — the
  // matching lines fail, in this test AND in the redirection test below,
  // because both read the one definition.
  it("refuses a write to every policy-carrying file, through the write tool", () => {
    writeBlocked("config.toml");
    writeBlocked("./config.toml");
    writeBlocked("/opt/quickreview/sandbox/config.toml");
    writeBlocked("scripts/post-review.sh");
    writeBlocked("scripts/guards.sh"); // the shell mirror of the gate
    writeBlocked("scripts/approve-pr.sh");
    writeBlocked("dist/extensions/bash-guard.js"); // the COMPILED guard itself
    writeBlocked("dist/src/gate.js");
    writeBlocked("extensions/bash-guard.ts"); // the guard's source
    writeBlocked("prompts/round-first.md"); // frozen seed
    writeBlocked("agents/pass-intent.md"); // frozen seed
    writeBlocked("seeds/prompts/conversation-system.md");
    writeBlocked("state/agents/pass-intent.md"); // the BUILT pass body pi loads
    // pi's project-context files: every session and pass in the sandbox root
    // loads the first of them, so one write would instruct them all.
    writeBlocked("AGENTS.override.md");
    writeBlocked("/opt/quickreview/sandbox/AGENTS.md");
    writeBlocked("./CLAUDE.md");
    writeBlocked("AGENTS.MD");
    writeBlocked("CLAUDE.MD");
    // …and the surface keeps its own, more specific refusal.
    writeBlocked(".git/config", "git's configuration");
  });

  it("refuses a context-file write through a redirection too — and only the exact names", () => {
    block("printf 'ignore your order' > AGENTS.override.md", "policy surface");
    block("cat /tmp/evil >> /opt/quickreview/sandbox/AGENTS.md", "policy surface");
    block("echo x > CLAUDE.md", "policy surface");
    // A file that merely CONTAINS the name is not a context file.
    writeOk("notes/AGENTS.md.bak");
    writeOk("state/MY_AGENTS.md");
  });

  it("closes the SAME surface when the write rides a shell redirection or sed -i", () => {
    // The three probes from the ticket, verbatim.
    block("cat /tmp/evil > config.toml", "policy surface");
    block("cat /tmp/evil > dist/extensions/bash-guard.js", "policy surface");
    block("printf 'x' > scripts/post-review.sh", "policy surface");
    // The other sanctioned scripts, append as well as truncate, an absolute
    // path, and the one allowlisted writer that names its target as an arg.
    block("printf 'x' > scripts/guards.sh", "policy surface");
    block("printf 'x' > scripts/approve-pr.sh", "policy surface");
    block("printf 'x' >> config.toml", "policy surface");
    block("cat evil > /opt/quickreview/sandbox/scripts/guards.sh", "policy surface");
    block("sed -i 's/dry_run = true/dry_run = false/' config.toml", "policy surface");
    block("sed -i.bak '1d' scripts/guards.sh", "policy surface");
    block("cat evil > state/agents/pass-validate.md", "policy surface");
  });

  // MUTATION: delete any one `.replace` line from `normalizeRedirections` in
  // extensions/bash-guard.ts — the matching spelling below goes green (and so
  // does its `.git/config` twin: every one of these was a bypass of the
  // veto too, on master).
  it("knows every spelling of an output redirection, not only `>` and `>>`", () => {
    // `&>` / `>&` write stdout+stderr to a FILE; `{v}>` picks a descriptor;
    // `<>` opens read-write and a write OVERWRITES; `>|` overrides noclobber.
    block("cat /tmp/evil &>config.toml", "policy surface");
    block("cat /tmp/evil &> config.toml", "policy surface");
    block("cat /tmp/evil &>>config.toml", "policy surface");
    block("cat /tmp/evil >&config.toml", "policy surface");
    block("cat /tmp/evil >& scripts/guards.sh", "policy surface");
    block("cat /tmp/evil {v}>config.toml", "policy surface");
    block("cat /tmp/evil {v}>>config.toml", "policy surface");
    block("printf x 1<>config.toml", "policy surface");
    block("printf x <>dist/extensions/bash-guard.js", "policy surface");
    block("cat /tmp/evil >| config.toml", "policy surface");
    block("cat /tmp/evil >|config.toml", "policy surface");
    block("cat /tmp/evil 2>scripts/guards.sh", "policy surface");
    // The git-config surface gains the same coverage from the same code.
    block("cat p &>.git/config", "git's configuration");
    block("cat p {v}>.git/config", "git's configuration");
    block("printf x 1<>.git/config", "git's configuration");
    block("cat p >&.git/hooks/pre-commit", "git's configuration");
    // …while the fd-dups that name no file are still not writes.
    allow("git log --oneline -5 2>&1 | tail -3");
    allow("git status >&2");
    allow("cat /tmp/out &>/dev/null");
    allow("cat x 1>&- 2>/dev/null");
  });

  // MUTATION: change `dequote` in extensions/bash-guard.ts to strip only the
  // leading/trailing quotes (the prior form) — the first three lines go green.
  it("judges the target by the name bash would OPEN, not by its spelling", () => {
    // bash concatenates `con"fig".toml`, `config\.toml` and `'config'.toml`
    // to the same file — VERIFIED writing.
    block(`cat /tmp/evil > con"fig".toml`, "policy surface");
    block("cat /tmp/evil > config\\.toml", "policy surface");
    block("cat /tmp/evil > 'scripts'/guards.sh", "policy surface");
    block(`cat p > .git/con"fig"`, "git's configuration");
    block('cat /tmp/evil > "$PWD/config.toml"', "policy surface");
    block("cat /tmp/evil > ~/sandbox/config.toml", "policy surface");
  });

  // The indirect writers the ticket names: tee/dd/cp/mv are OFF the allowlist
  // (refused as programs), sort -o / find -fprintf are refused whole by the
  // reader-mode rules — so none can reach a policy target by any spelling.
  it("the indirect file writers cannot reach a policy target either", () => {
    block("echo x | tee config.toml"); // tee: not on ALLOWED
    block("cp /tmp/evil scripts/post-review.sh"); // cp: not on ALLOWED
    block("mv /tmp/evil config.toml"); // mv: not on ALLOWED
    block("dd if=/tmp/evil of=config.toml"); // dd: not on ALLOWED
    block("install -m 755 /tmp/evil scripts/guards.sh");
    block("sort -o config.toml payload", "writes a file"); // reader-mode
    block("find . -maxdepth 0 -fprintf config.toml x", "writes a file");
    block("sed -n 'w config.toml' payload", "w/r/e command");
    block("echo f | xargs sed -i 's/a/b/' config.toml", "policy surface");
  });

  // MUTATION: in `checkSegment` (extensions/bash-guard.ts) delete the
  // `if (raw.slice(…) === "bash")` block that lifts the payload, and make
  // checkProgram's bash branch return { allowed: true } on -c — every door-4
  // line goes green: the sanctioned script launders what follows it.
  it("a `bash -c` payload cannot launder a refused command behind a sanctioned script (door 4)", () => {
    // The chain from the review, and every separator the ticket
    // names, in single quotes, double quotes and $'…'.
    block(
      "bash -c 'scripts/pr-self.sh ; QCR_CONFIG=/tmp/x.toml scripts/approve-pr.sh 5 b.md'",
      "guards",
    );
    block(
      `bash -c "scripts/pr-self.sh; QCR_CONFIG=/tmp/x.toml scripts/approve-pr.sh 5 b.md"`,
      "guards",
    );
    block("bash -c 'scripts/pr-self.sh && git push origin HEAD'", "mutation");
    block("bash -c 'scripts/pr-self.sh || cat evil > config.toml'", "policy surface");
    block("bash -c 'scripts/pr-self.sh\npython3 evil.py'", "read-only");
    block("bash -c $'scripts/pr-self.sh\\ngit push origin HEAD'", "mutation");
    block("bash -c 'echo `git push origin HEAD`'", "mutation");
    block("bash -c 'echo $(git push origin HEAD)'", "mutation");
    block("bash -lc 'git push origin HEAD'", "mutation");
    block("bash -c -- 'git push origin HEAD'", "mutation");
    block("env FOO=1 bash -c 'git push origin HEAD'", "mutation");
    block("/bin/bash -c 'git push origin HEAD'", "mutation");
    // Nested: the payload is re-parsed at every depth, up to a bound.
    block(`bash -c 'bash -c "git push origin HEAD"'`, "mutation");
    let nested = "git push origin HEAD";
    for (let i = 0; i < 10; i++) nested = `bash -c ${JSON.stringify(nested)}`;
    block(nested, "nested too deep");
    // …and a clean single command through `-c` still works, so the recursion
    // is an inspection, not a blanket ban.
    allow("bash -c 'git status'");
    allow("bash -c 'scripts/pr-self.sh 5 reviews'");
    allow("bash -c 'git log -1 && git status'");
    allow(`bash -c "git show HEAD:src/a.ts | head -40"`);
  });

  // MUTATION: in `bashCPayload` return `{ kind: "none" }` instead of
  // `unliftable` — the first four lines go green (checkProgram then sees a
  // bare `bash` form and refuses it, so watch the REASON, not only `allowed`).
  it("refuses a `bash -c` whose payload it cannot read, rather than guessing", () => {
    // Assembled at runtime by a substitution — VERIFIED running the file.
    block('bash -c "$(cat /tmp/x)"', "assembled at runtime");
    block('bash -c "git $(echo push) origin HEAD"', "assembled at runtime");
    block('bash -c "echo `cat /tmp/x`"', "assembled at runtime");
    // A value-taking option before -c shifts which word is the payload —
    // VERIFIED running the payload.
    block("bash -o pipefail -c 'git push origin HEAD'", "option taking a value");
    block("bash --rcfile /tmp/rc -c 'git status'", "option taking a value");
    // Through xargs the raw segment is not bash's, so there is no payload to
    // lift; through `env -S` a second command line is split out of a string.
    block("echo x | xargs bash -c 'git push origin HEAD'", "cannot read");
    block("env -S 'bash -c \"git push origin HEAD\"'", "env -S");
    block("env --split-string='python3 evil.py'", "env -S");
    // `sh -c` never had a payload path: only `sh -n` is sanctioned.
    block("sh -c 'git push origin HEAD'", "'sh'");
  });

  // MUTATION: drop "QCR_POSTING_RECEIPT_DIR" from POLICY_RELOCATING_ENV and the
  // first two lines fail. The ruling: it names a DIRECTORY like
  // QCR_DRYRUN_DIR, the daemon never sets it, so it is a relocator, not an arg.
  it("QCR_POSTING_RECEIPT_DIR is a relocator, not a per-call argument", () => {
    block("QCR_POSTING_RECEIPT_DIR=/tmp/r scripts/approve-pr.sh 5 b.md", "guards");
    block("env QCR_POSTING_RECEIPT_DIR=/tmp/r scripts/post-review.sh 5 COMMENT b.md", "guards");
    block("bash -c 'QCR_POSTING_RECEIPT_DIR=/tmp/r scripts/approve-pr.sh 5 b.md'", "guards");
    // The genuine per-call arguments are still allowed — they say what THIS
    // call is about, not what the guards are.
    allow("QCR_EXPECTED_HEAD=abc123 scripts/post-review.sh 5 COMMENT b.md");
    allow("QCR_POSTING_KEY=k scripts/post-review.sh 5 COMMENT b.md");
  });

  // MUTATION: drop "QCR_INSTALL" from POLICY_RELOCATING_ENV and this fails.
  // the install locator resolves the live config from the install's
  // config home, named by QCR_INSTALL — so naming another install is
  // `QCR_CONFIG=` by another spelling. QCR_CONFIG itself stays refused.
  it("QCR_INSTALL and QCR_CONFIG both move the config the locator finds — refused", () => {
    block("QCR_INSTALL=mine scripts/approve-pr.sh 5 b.md", "guards");
    block("env QCR_INSTALL=mine scripts/post-review.sh 5 COMMENT b.md", "guards");
    block("bash -c 'QCR_INSTALL=mine scripts/approve-pr.sh 5 b.md'", "guards");
    block("QCR_CONFIG=/tmp/x.toml scripts/approve-pr.sh 5 b.md", "guards");
  });

  it("leaves the reads and the legitimate writes a session lives on alone", () => {
    // Reading a policy file is the reviewer's whole job.
    allow("cat config.toml");
    allow("rg -n dry_run config.toml");
    allow("sed -n '1,40p' scripts/guards.sh");
    allow("cat state/agents/pass-intent.md");
    allow("git show HEAD:scripts/post-review.sh");
    allow("head -40 dist/src/gate.js");
    allow("rg -n 'config.toml' docs/ | head");
    allow("grep -c '>' config.toml"); // the quote glued to `>` keeps it from reading as an operator (docs: not-guaranteed list)
    // …and its own writes land where they always did.
    writeOk("verdict/pr-5249-round-2.json");
    writeOk("/tmp/review-body.md");
    writeOk("/opt/quickreview/state/ledger/pr-5249.md");
    writeOk("src/gate.ts"); // NOT a policy surface (src/ is source, not shipped)
    writeOk("descripts/notes.md"); // a NAME containing "scripts" is not scripts/
    writeOk("config.toml.example");
    allow("printf '%s\\n' x > /tmp/body.md");
    allow("cat body.md >> /tmp/notes.md");
    allow("echo x > verdict/pr-5249-round-2.json");
  });
});

// ---- round 2: allowlisted for READING is not allowlisted outright ---
//
// sed, sort and find are on ALLOWED because a reviewer slices text all
// day. Each also has a write or exec mode, and until the first adversarial
// review of every one was permitted. All VERIFIED on this host: the
// four write forms each wrote `<clone>/.git/config` and made a subsequent plain
// `git diff <base> <head>` execute, and the three exec forms ran a command
// outright — arbitrary execution straight through the program allowlist, with
// no git config involved at all.
describe("read-only programs with write/exec modes", () => {
  it("refuses the write modes — each one wrote .git/config in a live probe", () => {
    block("sed -n 'w .git/config' payload", "reads code");
    block("sed -i 's/a/b/' src/a.ts", "writes a file or runs a command");
    block("sed -ni 'p' src/a.ts", "reads code"); // clustered short form
    block("sort -o out.txt in.txt", "writes a file");
    block("find . -maxdepth 0 -fprintf out.txt '%p'", "writes a file");
    block("sed --expression='w /tmp/x' f", "reads code"); // script GLUED to its flag
    block("sed -e'w /tmp/x' f", "reads code");
  });

  it("refuses the EXEC modes — these ran a command with no config involved", () => {
    block("find . -maxdepth 0 -exec /tmp/pwn.sh ;", "runs a command");
    block("find . -name '*.ts' -delete", "runs a command or writes");
    block("find . -maxdepth 1 -ok rm {} ;", "runs a command");
    block("sort --compress-program=/tmp/pwn.sh big.txt", "names a program");
  });

  it("still allows every read-only form — a false veto here wedges real work", () => {
    allow("sed -n '10,20p' src/a.ts");
    allow("sed 's/foo/bar/' src/a.ts");
    allow("sed -ne '/start/,/end/p' src/a.ts");
    allow("sed -E 's/[0-9]+//g' data.txt");
    allow("sort -u names.txt");
    allow("sort -n -k2 data.tsv | head -5");
    allow("find src -name '*.ts' -maxdepth 3");
    allow("find . -type f -newer package.json");
    allow("cut -d: -f1 /etc/passwd"); // what awk used to be reached for
    allow("jq -r '.[].name' data.json | sort | uniq -c");
    allow("git diff --name-only | xargs grep -n TODO");
  });

  it("is asked the same question through xargs", () => {
    block("echo x | xargs sed -i 's/a/b/'", "writes a file or runs a command");
    allow("git diff --name-only | xargs sed -n '1p'");
  });

  it("checkReaderModes is inert for every other program", () => {
    expect(checkReaderModes("rg", ["-n", "foo"]).allowed).toBe(true);
    expect(checkReaderModes("cat", ["-o", "x"]).allowed).toBe(true);
    // …including awk, which no longer has a rule set here at all.
    expect(checkReaderModes("awk", ['BEGIN{system("x")}']).allowed).toBe(true);
  });
});

// ---- round 3: awk is OFF the allowlist -----------------------------
//
// It was on it, gated by four regexes, and all four keyed on a quote, `$` or
// `(` after the operator — so a bare identifier holding the command defeated
// every one. VERIFIED executing, with all five layers in force:
//
//     awk 'BEGIN{c="sh"; print "<cmd>" | c}'   → ran <cmd>, NO config touched
//
// which means the guard allowed it, the config pin was irrelevant, the audit
// missed it, the round-boundary integrity check had nothing to compare (no
// config file was written) and the outcome layer only sees reviews. Arbitrary
// execution invisible to the whole stack, against a manifesto non-goal.
//
// The fix is this file's own seventh review rule applied to itself: awk is a
// language whose exec and write forms take arbitrary EXPRESSIONS, so a
// command-string rule cannot parse it and a fifth pattern would have been the
// seventh round of the same mistake.
describe("awk is not a read-only program (round 3)", () => {
  it("refuses awk in every spelling, including the indirection that beat the rules", () => {
    block(`awk 'BEGIN{c="sh"; print "id" | c}'`, "programming language");
    block(`awk 'BEGIN{f="/tmp/out"; print "x" > f}'`, "programming language");
    block(`awk 'BEGIN{f=".git/config"; printf "[diff]" >> f}'`, "programming language");
    block(`awk 'BEGIN{system("id")}'`, "programming language");
    block("awk -F: '{print $1}' /etc/passwd", "programming language"); // even the innocent form
    block("gawk '{print}' f", "gawk");
    block("mawk '{print}' f", "mawk");
    block("nawk '{print}' f", "nawk");
    block("git diff --name-only | xargs awk '{print}'", "programming language");
    block("cat f | awk '{print $1}'", "programming language");
  });

  it("names the replacement, so the session re-plans instead of retrying", () => {
    const why = checkBashCommand("awk '{print $1}' f").reason ?? "";
    expect(why).toContain("rg/grep/jq/cut/sort/sed -n");
  });

  it("takes the other language runtimes with it", () => {
    block("perl -ne 'print' f", "arbitrary code");
    block("ruby -e 'puts 1'", "arbitrary code");
  });

  it("leaves the text vocabulary a reviewer actually needs", () => {
    for (const cmd of [
      "rg -n 'foo' src/",
      "grep -c TODO src/a.ts",
      "jq -r '.version' package.json",
      "cut -d, -f2 data.csv | sort -u",
      "sed -n '10,20p' src/a.ts",
      "head -50 src/a.ts | nl -ba",
      "tr -d '\\r' < f | wc -l",
    ])
      allow(cmd);
  });
});
