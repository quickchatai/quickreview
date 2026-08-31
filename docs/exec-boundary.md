# The exec boundary

Review sessions read code. They never run it, and they never write to GitHub
except through the sanctioned scripts, which mirror the one mutation gate.

This document states what that boundary **guarantees** — as claims that can be
shown false, not as reassurance. Two earlier docstrings in
`extensions/bash-guard.ts` asserted a closedness that did not hold; both were
disproved by someone running a command. Assume this one can be too, and try.

## Why there is more than one layer

`extensions/bash-guard.ts` vets **command strings**. It has been hardened over
six adversarial review rounds, and every round but the last looked complete to
its author and passed a green suite while a live bypass stood:

| Round | Closed | Still open after it |
|---|---|---|
| 1 | `gh pr review --approve`, the documented verb | `gh api … --input` — the channel the predecessor used for *every* review it posted |
| 2 | that, and `git -c`; found the `GIT_EXTERNAL_DIFF` env twin unprompted | `gh api -fevent=APPROVE` (same flag, different *form*); `git --git-dir=` (same family, third *mechanism*) |
| 3 | both, structurally; added the compiled-artifact probe | `HOME` / `XDG_CONFIG_HOME` — the *implicit* config search path behind the *explicit* pointers |
| 4 | those | five write primitives on the guard's own read-only allowlist, and three that execute a command outright |
| 5–6 | those, at the write boundary and by round-boundary integrity | `awk` executing an arbitrary command held in a **variable** — invisible to all five layers |
| 7 | `awk` removed from the allowlist outright | *(see the "not guaranteed" list)* |

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

A sixth round — the first adversarial review of the fix above — made the point
harder. Five write primitives, **all on the guard's own read-only allowlist**,
reach `<clone>/.git/config` past a command-string write veto, and all five were
verified to make a subsequent plain `git diff <base> <head>` execute:

```
T=.git/config; cat payload >> $T          find . -maxdepth 0 -fprintf .git/config …
awk 'BEGIN{print x >>".git/config"}'      sort -o .git/config payload
sed -n 'w .git/config' payload
```

The first is decisive: `T=` is not a config-injecting variable and the
redirection target is `$T`, so **no scan over a command string can ever see
it.** A write veto built to compensate for a command guard's blindness had
inherited exactly that blindness. That is why layer 5 below exists and why it
is not another list.

The same round turned up a class that is not about git config at all:
`awk 'BEGIN{system("cmd")}'`, `awk 'BEGIN{"cmd"|getline}'` and
`find . -exec cmd \;` **run a command outright**, straight through the program
allowlist — the no-exec policy was false on its own terms.

A seventh round then broke the fix for the awk half, and it is the sharpest
lesson in the sequence. `awk` had been kept on the allowlist and gated by four
regexes. Every one of them keyed on a quote, `$` or `(` after the operator, so a
**bare identifier** defeated all four:

```
awk 'BEGIN{c="sh"; print "<cmd>" | c}'        → ran <cmd>
awk 'BEGIN{f="<path>"; print "x" > f}'        → wrote <path>
awk 'BEGIN{f=".git/config"; printf … >> f}'   → then a plain `git diff` ran <cmd>
```

That is `T=.git/config; cat p >> $T` moved one level in, into a language being
parsed with regexes. The first line is the severe one: it executes an arbitrary
command **with no config file touched**, so layer 4 has nothing to compare and
layer 5 has no review to see — the guard allowed it and the audit missed it.
Arbitrary execution invisible to all five layers, against a manifesto non-goal.

**The decision: `awk` is off the allowlist.** Not a fifth pattern. `system(x)`,
`x | getline`, `print | x` and `print > x` are first-class in awk and every one
takes an arbitrary expression, so no command-string rule can parse it. `sed`
stays on a narrower argument — its script language has exactly three file/exec
verbs (`w`/`r`/`e`), single letters at a command position rather than
expressions, which is parseable. The cost of removing awk is close to zero: it
appears in no prompt, no agent and no session-sanctioned script, and a reviewer
keeps `rg`, `grep`, `jq`, `cut`, `sort`, `uniq`, `head`, `tail`, `wc`, `nl`,
`tr` and `sed -n`.

## The five layers

1. **Config-scope pin** — `sessionGitConfigPins`, `src/sessions.ts`.
   `GIT_CONFIG_GLOBAL` is named explicitly (the pi HOME's own `.gitconfig`, so
   the entrypoint's `credential.helper` survives and session-side `fetch` still
   works), `GIT_CONFIG_SYSTEM=/dev/null`, `GIT_CONFIG_NOSYSTEM=1`. It rides the
   `env K=V … pi …` **argv**, because tmux panes inherit the tmux *server*
   environment. The global/XDG search path is never consulted.
2. **Command guard** — `checkBashCommand`, `extensions/bash-guard.ts`. Program
   allowlist; `gh` and `git` by read-verb allowlist; the config-injection and
   config-relocation option and env families; and — since round 6 —
   `checkReaderModes`, which gates the write and exec modes of the three
   programs allowlisted for *reading*: `sed -i` and its `w`/`r`/`e` script
   commands (including a script glued to `-e`/`--expression`),
   `sort -o`/`--compress-program`, and `find -exec`/`-delete`/`-fprintf` and
   kin. `awk` used to be a fourth and is now off the allowlist entirely. This is
   the pattern-based layer and it stays pattern-based: its job is to narrow the
   surface and to stop a caller *lifting* layer 1, both of which are
   command-shaped acts.
3. **Write veto** — `checkWritePath` / `isGitConfigSurface`, same file, bound to
   the `write`/`edit` tools and to shell redirection targets. Refuses writes to
   git's configuration surface: anything inside a `.git` directory,
   `.gitconfig`, `<any>/git/config`, `.gitattributes`. This rule enumerates
   **git's own config locations** — closed and documented — not attacks.
4. **Config integrity across the round** — `gitConfigWatchPaths` /
   `fingerprintRoundGitConfig` / `gitConfigChanges` in `src/execboundary.ts`.
   `dispatch` hashes every file git reads configuration or hooks from when it
   prepares the worktree; `verdicts.measureUsage` re-hashes them when the round
   is measured; a difference raises the `git_config_modified` **wake**. It
   enumerates no write primitive, so variable indirection is irrelevant to it.
5. **Outcome detection** — `auditUngatedReviews`, same file, run by the
   reconcile comment sweep. Asks the only question whose answer does not depend
   on knowing the mechanism.

Layers 1 and 3 make the git-config-executes-shell family *impossible* at all
three of git's config scopes for the write paths they can see; layer 4 catches
the ones they cannot see, which is every one that goes through a variable or a
program body. Layer 5 notices the terminal harm whatever caused it. Layer 2
remains an enumeration, and that is now acceptable, because it is no longer the
only thing standing between a session and an ungated approval.

## The guarantees, stated so they can be falsified

**G1 — the set of files git reads configuration from is fixed at spawn, small,
and named.** For a review session it is the pinned global file plus the
repository's own config and hooks; the search path that would find others never
runs. This is a claim about the READ side only — it deliberately no longer
claims those files cannot be written, because an earlier draft of this document
did claim that and the reviewer disproved it five ways in ten minutes. Writes
are handled by G4. *Falsify it by* naming a config or hook location git reads
that is neither pinned away nor in `gitConfigWatchPaths`.

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

**G4 — a session write to git's configuration does not survive a round
unnoticed.** Every file layer 4 watches is hashed when the round's worktree is
prepared and re-hashed when the round is measured; a difference is a wake.
*Falsify it by* changing one of those files mid-round and getting a clean
round, or by naming a config location git reads that `gitConfigWatchPaths`
omits.

### What is NOT guaranteed — say so rather than implying otherwise

- **Layer 2 is not closed and is not claimed to be.** A general-purpose tool
  has more paths to `exec` than any list holds. Seven rounds are the evidence.
- **The write veto sees redirections, `sed -i` and the write tools — it does
  NOT see variable indirection or a write inside a program body.**
  `T=.git/config; cat p >> $T` is invisible to it *by construction*, and so is
  a write hidden inside a quoted `sed` program the reader-mode rules do not
  recognise. This is not a gap awaiting more spellings; it is the reason
  layer 4 exists. Adding spellings here is the mistake made four times.
- **The reader-mode rules are pattern-based too**, and their `sed` script
  parsing is approximate: a `w` flag on a non-`/` delimiter (`sed 's|a|b|w f'`)
  is not recognised — VERIFIED writing. It is left in place deliberately: it
  narrows to a *write*, which layer 4 catches when it lands on a config file.
  They narrow the surface; they do not close it. This is exactly the kind of
  residual that justified removing `awk` rather than gating it — when the gap
  is an *exec* primitive instead of a write, layer 4 cannot cover it and the
  program has to go.
- **Layer 4 does not watch `<clone>/.git/modules/*/config`** (submodule
  configs), so a submodule's config is outside G4.
- **G4's window starts at worktree preparation.** Anything planted BEFORE that
  — a hook, a config line — is baselined as legitimate and will never be
  reported. G4 says "unchanged during the round", not "clean".
- **The write veto is not a sandbox.** The session runs as the same uid as the
  daemon. Nothing here revokes filesystem permission; every layer above is a
  refusal or a detection.
- **Layer 4 detects; it does not prevent.** The write lands, the round
  completes, the anomaly follows. It bounds the damage to one round. Its window
  is round start → round measurement, so a write made and reverted inside that
  window leaves both hashes equal.
- **G3 is bounded to the current head**, because `reviewed_heads` is one row per
  PR. An older head's legitimate review has no surviving trace, so auditing
  history would be noise.
- **G3 has two benign false positives.** `guard_stamp_reviewed_head` in
  `scripts/guards.sh` swallows its own failures, so a silently failed stamp
  presents identically to an ungated write (the anomaly text names both
  readings — both are faults). And `reviewed_heads` is one UPSERTED row per PR,
  so a legitimate marker-less APPROVE at head H followed by any later
  `post-review.sh` COMMENT at the same H overwrites `posted_event` and the
  approval loses its trace.
- **G3 is weakened by the migration-precheck excuse.** `migrationPrecheck` is
  `lastEventAt(…) !== undefined` with no time bound, so a PR that has ever had
  a migration-collision comment excuses an unaccounted COMMENT review at its
  current head. It is bounded to ONE such review per audit, but not to the
  right one.
- **The post-hoc audit (`src/usage.ts`) is telemetry, never a control.** Its
  content rules are an independent implementation from the guard, because a
  shared one shares its blind spots — with one honest exception, the
  reader-mode rules, which are the same shape as the guard's by necessity. It
  cannot see what leaves no recognisable spelling, and it does not see
  `T=.git/config; cat p >> $T` either.

## Review discipline for changes to any of this

Seven rounds found fifteen bypasses. Unit tests found none of them; every one was
found by someone running a command. So:

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
7. **When a command-string rule is bypassed, ask whether a command-string rule
   is the right shape at all** before adding a spelling. Rounds 1–4 each added
   spellings. Round 6's `T=.git/config; cat p >> $T` is the case that cannot be
   spelled, and it is what layer 4 answers. Round 7 applied the rule to a rule
   written under it: the awk gating was itself an enumeration, and the answer
   was to remove the program, not to add a fifth pattern. **When the residual
   is an exec primitive rather than a write, layer 4 cannot cover it and the
   program comes off the allowlist.**
8. **A claim about what a program can do is not reviewable by reading the
   guard. Run the program.** Round 7's reviewer read this file closely twice
   and did not find `awk 'BEGIN{system(…)}'` by reading either; it took an
   execution probe. Two independent close readings missed a first-class feature
   of a language on the allowlist. Every allowlisted program's *whole* manual
   page is the attack surface, and the only way to know is to run it.
