# The exec boundary

Review sessions read code. They never run it, and they never write to GitHub
except through the sanctioned scripts, which mirror the one mutation gate.

This document states what that boundary **guarantees** — as claims that can be
shown false, not as reassurance. Two earlier docstrings in
`extensions/bash-guard.ts` asserted a closedness that did not hold; both were
disproved by someone running a command. Assume this one can be too, and try.

## Why there is more than one layer

`extensions/bash-guard.ts` vets **command strings**. It was hardened over four
adversarial review rounds, and each of the first three looked complete to its
author and passed a green suite while a live bypass stood:

| Round | Closed | Still open after it |
|---|---|---|
| 1 | `gh pr review --approve`, the documented verb | `gh api … --input` — the channel the predecessor used for *every* review it posted |
| 2 | that, and `git -c`; found the `GIT_EXTERNAL_DIFF` env twin unprompted | `gh api -fevent=APPROVE` (same flag, different *form*); `git --git-dir=` (same family, third *mechanism*) |
| 3 | both, structurally; added the compiled-artifact probe | `HOME` / `XDG_CONFIG_HOME` — the *implicit* config search path behind the *explicit* pointers |
| 4 | those | *(see below)* |

The pattern is not "the lists were short". Every one of those bypasses needed a
command string to inspect, and the decisive ingredient in each was **a file the
session writes with its ordinary write tool** — which a command guard never
sees. Pushed one step, the command becomes innocent. Verified executing with
round 4's fix in place:

```
printf '[diff]\n\texternal = <cmd>\n' >> <clone>/.git/config
git diff <base> <head>          → ran <cmd>
```

`git diff <base> <head>` is the most ordinary command a review session runs.
No blocklist reaches it. **The guard should be one layer precisely because it
cannot be the layer.**

## The four layers

1. **Config-scope pin** — `sessionGitConfigPins`, `src/sessions.ts`.
   `GIT_CONFIG_GLOBAL` is named explicitly (the pi HOME's own `.gitconfig`, so
   the entrypoint's `credential.helper` survives and session-side `fetch` still
   works), `GIT_CONFIG_SYSTEM=/dev/null`, `GIT_CONFIG_NOSYSTEM=1`. It rides the
   `env K=V … pi …` **argv**, because tmux panes inherit the tmux *server*
   environment. The global/XDG search path is never consulted.
2. **Command guard** — `checkBashCommand`, `extensions/bash-guard.ts`. Program
   allowlist; `gh` and `git` by read-verb allowlist; the config-injection and
   config-relocation option and env families. This is the pattern-based layer,
   and it stays pattern-based: its job is to stop a caller *lifting* layer 1,
   which is a command-shaped act.
3. **Write veto** — `checkWritePath` / `isGitConfigSurface`, same file, bound to
   the `write`/`edit` tools and to shell redirection targets. Refuses writes to
   git's configuration surface: anything inside a `.git` directory,
   `.gitconfig`, `<any>/git/config`, `.gitattributes`. This rule enumerates
   **git's own config locations** — closed and documented — not attacks.
4. **Outcome detection** — `src/execboundary.ts`, run by the reconcile comment
   sweep. Asks the only question whose answer does not depend on knowing the
   mechanism.

Layers 1 and 3 make the git-config-executes-shell family *impossible* at all
three of git's config scopes. Layer 4 notices the terminal harm whatever caused
it. Layer 2 remains an enumeration, and that is now acceptable, because it is no
longer the only thing standing between a session and an ungated approval.

## The guarantees, stated so they can be falsified

**G1 — git's configuration comes from files the session cannot write.**
For a review session, the set of files git consults for configuration is fixed
at spawn: the pinned global file, and the repository's own config. Both are on
the write veto's refusal list. *Falsify it by* finding a config location git
reads that is neither pinned away nor refused by `isGitConfigSurface`, or a
write path to one of those files that reaches the filesystem.

**G2 — `HOME` and `XDG_CONFIG_HOME` are not config vectors.**
Not because they are blocked (they are, at layer 2) but because the search path
that consults them never runs. *Falsify it by* executing a payload from
`$HOME/.gitconfig` or `$XDG_CONFIG_HOME/git/config` in a real session pane.

**G3 — an approval the daemon did not make is visible within one reconcile
poll.** A bot-authored `APPROVED` review at a PR's current head with no local
trace (posting marker, `rounds.gh_review_id`, the `reviewed_heads` mark,
or a migration-precheck event) raises an `ungated_approval` anomaly.
*Falsify it by* posting a bot review at the current head that acquires one of
those traces without going through the gate or the sanctioned scripts.

### What is NOT guaranteed — say so rather than implying otherwise

- **Layer 2 is not closed and is not claimed to be.** A general-purpose tool
  has more paths to `exec` than any list holds. Four rounds are the evidence.
- **The write veto is belt-and-braces, not a sandbox.** The session runs as the
  same uid as the daemon. It binds the write tools and shell redirection; a
  write smuggled inside a quoted program body (`awk 'BEGIN{print > "…"}'`) is
  not seen. The program allowlist is what keeps the set of programs that can
  write a file at all small.
- **G3 is bounded to the current head**, because `reviewed_heads` is one row per
  PR. An older head's legitimate review has no surviving trace, so auditing
  history would be noise.
- **G3 has one benign false positive**: `guard_stamp_reviewed_head` in
  `scripts/guards.sh` swallows its own failures, so a silently failed stamp
  presents identically to an ungated write. The anomaly text names both
  readings. That is the right way round — both are faults.
- **The post-hoc audit (`src/usage.ts`) is telemetry, never a control.** It is
  deliberately an independent implementation from the guard, because a shared
  one shares its blind spots; and it cannot see what leaves no recognisable
  spelling.

## Review discipline for changes to any of this

Four rounds found four bypasses. Unit tests found none of them. So:

1. **Verify by execution, never by reading.** Every bypass was found by running
   something. A claim that a chain is blocked, unaccompanied by a run, is a
   hypothesis.
2. **Probe the compiled artifact.** The container runs `dist/`; tests assert the
   source. Rounds two and three both shipped source fixes whose compiled form
   was never exercised. `tests/exec-boundary.test.ts` replays the corpus against
   `dist/extensions/bash-guard.js` and asserts source and build agree.
3. **The corpus is the regression suite.** `CORPUS` in
   `tests/exec-boundary.test.ts` holds every chain proven to execute or POST.
   Add to it; never quietly drop from it.
4. **Mutation-verify every regression test.** Revert the fix, watch the test
   fail, restore. A test that passes without its fix proves nothing.
5. **A new layer must catch the corpus without being told about it.** A defence
   that works only because someone enumerated the known attacks has rebuilt the
   thing that failed four times.
6. **Adding a layer never licenses relaxing an existing one.** Layer 2 stops a
   caller re-pointing layer 1's pin; remove it and the pin is a suggestion.
