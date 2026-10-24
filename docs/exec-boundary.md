# The exec boundary

Review sessions read code. They never run it, and they never write to GitHub
except through the sanctioned scripts, which mirror the one mutation gate.

This document states what that boundary **guarantees** — as claims that can be
shown false, not as reassurance. Two earlier docstrings in
`packages/pi-plugin/extensions/bash-guard.ts` asserted a closedness that did not hold; both were
disproved by someone running a command. Assume this one can be too, and try.

## Why there is more than one layer

`packages/pi-plugin/extensions/bash-guard.ts` vets **command strings**, and `checkWritePath` /
`checkProtectedWrites` vet **write targets**. The command guard was hardened over
seven adversarial review rounds, and every round but the last looked complete to
its author and passed a green suite while a live bypass stood; an eighth
then showed the boundary had never protected its OWN configuration —
and, while that was being closed, that the redirection scan knew two of bash's
seven output-redirection spellings:

| Round | Closed | Still open after it |
|---|---|---|
| 1 | `gh pr review --approve`, the documented verb | `gh api … --input` — the channel the predecessor used for *every* review it posted |
| 2 | that, and `git -c`; found the `GIT_EXTERNAL_DIFF` env twin unprompted | `gh api -fevent=APPROVE` (same flag, different *form*); `git --git-dir=` (same family, third *mechanism*) |
| 3 | both, structurally; added the compiled-artifact probe | `HOME` / `XDG_CONFIG_HOME` — the *implicit* config search path behind the *explicit* pointers |
| 4 | those | five write primitives on the guard's own read-only allowlist, and three that execute a command outright |
| 5–6 | those, at the write boundary and by round-boundary integrity | `awk` executing an arbitrary command held in a **variable** — invisible to all five layers |
| 7 | `awk` removed from the allowlist outright | the boundary's OWN configuration — `config.toml`, the sanctioned scripts, the compiled guard — writable through both channels; `bash -c '…;…'` laundering a refused command behind a sanctioned one |
| 8 | those, at both write boundaries from one definition, by re-parsing `bash -c`, and by round-boundary integrity; then `&>`/`>&`/`{v}>`/`<>`/`>|`, quoted and escaped targets, `env -S`, `bash -o … -c`, `bash -c "$(…)"` — each found by running it | *(see the "not guaranteed" list)* |

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
2. **Command guard** — `checkBashCommand`, `packages/pi-plugin/extensions/bash-guard.ts`. Program
   allowlist; `gh` and `git` by read-verb allowlist; the config-injection and
   config-relocation option and env families; and `checkReaderModes`, which gates the write and exec modes of the three
   programs allowlisted for *reading*: `sed`, which is PARSED rather than
   matched (`checkSedInvocation`: `-i`/`-f`, the `e`/`w`/`W`/`r`/`R` commands
   and `s`'s `e`/`w` flags at any address and with any delimiter, and anything
   the parser cannot read),
   `sort -o`/`--compress-program`, and `find -exec`/`-delete`/`-fprintf` and
   kin. `awk` is off the allowlist entirely. git's read verbs have two such
   modes of their own, both refused: the diff options' `--output=<file>` (`git log`/`show`/`diff` WRITE
   their output there — a committed blob or a `--format=format:` string makes
   the bytes anything) and `git grep`'s `-O<cmd>`/`--open-files-in-pager`
   (which RUNS `<cmd>`), and every git and gh option is judged as the tool
   receives it, inner quotes removed (so `--up"load"-pack=` is
   `--upload-pack=` and `gh api … --in"p"ut` sends a body). A git or gh word
   carrying ANSI-C `$'…'` or locale `$"…"` quoting, which can spell any byte,
   is refused rather than decoded; the transcript audit flags such a `gh`
   segment as a GitHub write. This is
   the pattern-based layer and it stays pattern-based: its job is to narrow the
   surface and to stop a caller *lifting* layer 1, both of which are
   command-shaped acts.
3. **Write veto** — `checkWritePath` / `checkProtectedWrites` /
   `isProtectedWriteTarget`, same file, bound to the `write`/`edit` tools AND to
   shell redirection / `sed -i` targets, from ONE predicate so the two
   boundaries cannot drift. Every output-redirection spelling bash has
   (`>`, `>>`, `&>`, `&>>`, `>&f`, `{v}>`, `<>`, `>|`, fd-prefixed) is folded
   onto `>`/`>>` first (`normalizeRedirections`), and a target is judged by the
   name bash would OPEN — quotes and backslashes inside the word removed. It
   is also judged over the redirections bash would
   actually PERFORM (`redirectTargets`, which reads quotes): an operator glued
   to the word before it (`printf x>config.toml`, which no whitespace token
   showed), `$'…'`/`$"…"` names, and a target bash EXPANDS — a pathname
   pattern (`> config.tom?`, `> retired-uri[s].json`) or a one-element
   sequence brace (`> recall-hint{s..s}/…`) is judged by every protected name
   it can expand onto (`protectedPatternHit`), while a `>` inside a quoted grep
   pattern stays text to this scan (the whitespace scan still reads a spaced one
   as an operator — see "What is NOT guaranteed"). It refuses four closed, documented sets:
   - **git's configuration surface** (`isGitConfigSurface`): anything
     inside a `.git` directory, `.gitconfig`, `<any>/git/config`,
     `.gitattributes` — git's own config locations, not attacks.
   - **this system's own policy surface** (`isPolicySurface`):
     `config.toml`, `scripts/**`, `dist/**`, `extensions/**`, the frozen
     seeds `prompts/**` / `agents/**` / `seeds/**` (the built `state/agents/**`
     pass bodies included), pi's project dir `.pi/**`, and the review core's
     export map `packages/pi-plugin/package.json`. These are the files that decide what every
     layer here DOES. See "The policy surface" below.
   - **the memory-scope files a session's own recall reads**
     (`isMemoryScopeSurface`): `recall-hints/**` (the daemon's
     per-session recall hint — the only memory areas the session's recall and
     memory tools may reach) and `retired-uris.json` (the retired entries its
     recall excludes), both in the session's pi home. See "The memory scope"
     below.
   - **the wake-delivery files** (`isDeliverySurface`): every `inject/` dir
     and anything in it, the inject bridge's `.done/`, and any file named
     like a wake (`<ISO stamp>-<seq>[--cmd-<id>].md`). See "The wake-delivery
     files" below.
4. **Integrity across the round** — `gitConfigWatchPaths` /
   `policySurfaceWatchPaths` / `fingerprintRoundIntegrity` / `integrityChanges`
   in `src/execboundary.ts`. `dispatch` hashes every file git reads
   configuration or hooks from AND the policy surface under the sandbox root
   when it prepares the worktree; `verdicts.measureUsage` re-hashes them when
   the round is measured; a difference raises the `git_config_modified` or the
   `policy_surface_modified` **wake**. Directories are hashed recursively by
   CONTENT (a rewritten `scripts/guards.sh` keeps the listing identical). It
   enumerates no write primitive, so variable indirection is irrelevant to it.
   Both hashes are async, with an event-loop turn after every file; the value is the synchronous one, byte for byte, so a baseline taken
   before a deploy still compares with a re-check after it. Each is bounded by
   `INTEGRITY_BUDGET_MS` (60 s): a read that never returns leaves the round
   UNCHECKED — no baseline, or no verdict on the re-hash — with a
   `round_integrity_unchecked` event, never a held dispatch pump or a round end
   that does not finish.
5. **Outcome detection** — `auditUngatedReviews`, same file, run by the
   reconcile comment sweep. Asks the only question whose answer does not depend
   on knowing the mechanism.

## The policy surface — the boundary protects its own configuration

For seven rounds the boundary protected the files that turn a GIT command into
shell execution, and never the files that decide what the boundary itself does.
Three write targets were `allowed: true` on both source and the compiled
`dist/`, each found by EXECUTION, not by reading:

```
cat /tmp/evil > config.toml                      → the guards' OWN config
cat /tmp/evil > packages/pi-plugin/dist/extensions/bash-guard.js    → the COMPILED guard
printf 'x'   > scripts/post-review.sh            → the gate's shell mirror
```

The first is a hard-rule-1 gate bypass on its own. The posting scripts read
`dry_run` and every `[guards]` knob out of `config.toml` per invocation, and
`guard_enabled` treats a knob as ON unless it is literally `false`, so ONE write
turns guards 1-5 off and flips a dry-run install to live on the very next
sanctioned post. The second is worse in reach: `packages/pi-plugin/dist/extensions/bash-guard.js` is
the guard the container actually runs, so overwriting it disables the boundary
for every later round in that container. `scripts/guards.sh` and
`scripts/approve-pr.sh` were equally writable.

Two more doors of the same class were verified by review:

```
bash -c 'scripts/pr-self.sh ; QCR_CONFIG=/tmp/x.toml scripts/approve-pr.sh 5 b.md'
QCR_POSTING_RECEIPT_DIR=/tmp/r scripts/approve-pr.sh 5 b.md
```

The first launders a refused command behind a sanctioned one: `checkProgram`
vetted `bash` by its first bare token and the splitter treated `;` inside single
quotes as literal, so everything after the separator was never seen. The second
is `QCR_POSTING_RECEIPT_DIR`, left out of `POLICY_RELOCATING_ENV` as "an
argument"; but it names a DIRECTORY like `QCR_DRYRUN_DIR`,
the daemon never sets it (it relies on the scripts' default
`state/posting-receipts`, which `verdicts.ts` reads), and it relocates the
record that settles a round — so it is a relocator and it is refused.

**Then the fix was probed the way the finding was made**, by running each form
bash offers against a real file, and the first cut of it fell eleven ways. The
redirection scan knew `>` and `>>`; bash has five more spellings that write a
named file, and all five walked past the git-config veto as well:

```
cat /tmp/evil &>config.toml        cat /tmp/evil {v}>config.toml     cat /tmp/evil >| config.toml
cat /tmp/evil >&config.toml        printf x 1<>config.toml           (all five VERIFIED writing)
cat /tmp/evil > con"fig".toml      cat /tmp/evil > config\.toml      (bash opens config.toml; the scan compared spellings)
```

And the first `bash -c` re-parser had three launderers of its own:
`env -S 'bash -c "…"'` (env splits a second command line out of one word),
`bash -o pipefail -c '…'` (a value-taking option before `-c`, so the lift found
no payload and the `-c` form was waved through), `xargs bash -c '…'` (no raw
segment to lift from) — and `bash -c "$(cat x)"`, whose payload does not exist
until runtime, was re-parsed as the empty string and allowed.

**The fixes, none of them a blocklist of attacks:**

- **One definition, three consumers.** `POLICY_SURFACE_FILES` /
  `POLICY_SURFACE_DIRS` in the guard name this system's policy-carrying
  top-level entries — `config.toml` and pi's five project-context file names
  (`AGENTS.override.md`, `AGENTS.md`, `AGENTS.MD`, `CLAUDE.md`, `CLAUDE.MD`:
  pi loads the first one it finds in the cwd into every session and pass, and
  they all run in the sandbox root); `scripts/`, `dist/`, `extensions/`,
  `prompts/`, `agents/`, `seeds/`, `.pi/`. `POLICY_SURFACE_PATHS` adds whole
  paths under the root, today one: `packages/pi-plugin/package.json`, the
  review core's export map. Every shim and worker loads the compiled guard and
  gate through `@quickchatai/pi-quickreview/...`, which that map resolves
  (`./extensions/*` to `./dist/extensions/*`), so repointing it would swap the
  guard without touching `dist/`; a `package.json` anywhere else is not
  policy. The write/edit tool veto and the shell
  redirection / `sed -i` scan both read it as a path SHAPE through
  `isProtectedWriteTarget`; layer 4 reads it as concrete paths under the sandbox
  root through `policySurfaceWatchPaths`. A session cannot write through one
  channel what it is refused through another, and the integrity check cannot
  watch a different set than the veto refuses. It is git's own list one level
  out: the files that configure US, closed and listed here.
- **`.pi/` is in the set.** It is pi's PROJECT resource dir — `settings.json`,
  `extensions/` and `mcp.json` —
  and every project is trusted (`defaultProjectTrust = "always"`), so a file
  planted there loads into every later session and pass in that root: an
  extension is code, an `mcp.json` launches server processes that never pass
  through a tool call, and a project `+builtin:mcp` overrides the global
  `-builtin:mcp` the entrypoints provision (`packages/pi-plugin/src/pibuiltins.ts`). As a shape it
  also refuses `<pi home>/.pi/agent/…`, the session's own global settings and
  login. Layer 4 watches `<sandbox root>/.pi` like the other six directories
  (the pi home is NOT watched: pi itself rewrites its login there).
- **Every redirection spelling, one canonical form.** `normalizeRedirections`
  folds `&>`, `&>>`, `>&file`, `{v}>`, `<>` and `>|` onto `>`/`>>` and drops
  the fd-dups that name no file (`2>&1`, `>&2`, `1>&-`), before the scan and the
  splitter read the command. The target is then judged DEQUOTED — `con"fig".toml`
  and `config\.toml` are `config.toml`. The audit borrows the same normaliser,
  the way it already borrowed the splitter: the tokeniser, not the policy.
- **The indirect writers need no special case.** `tee`, `cp`, `mv`, `dd` and
  `install` are OFF the program allowlist, so `checkProgram` refuses them
  outright whatever their target; `sort -o`, `find -fprintf`, `sed 'w …'` and
  `awk` are refused whole by the reader-mode rules / removal. `sed -i` and the
  redirections are the writers that name a target as a plain word, and those
  the scan reads.
- **`bash -c` payloads are re-parsed, and a payload the guard cannot read is
  REFUSED, never guessed.** `checkSegment` lifts the payload out of the RAW
  segment (`bashCPayload`: quote-aware, dequoted, `$'…'` decoded, so `;`,
  newline, `&&`, `||`, backticks and `$(…)` inside the quotes survive) and runs
  it through `checkBashCommand` as its own command, at every nesting depth up
  to a bound of eight. Three shapes are unliftable and refuse with a reason
  that says why: a payload assembled by a substitution (the segment was cut at
  `$(`/backtick — an unclosed quote is the tell); a value-taking option before
  `-c`; and a `-c` reaching `checkProgram` at all (through `xargs`), where no
  raw segment exists. `env -S`/`--split-string` is refused outright, and `sh -c`
  always was (only `sh -n` is sanctioned). The outer segment is still vetted
  first, so an env prefix like `QCR_CONFIG=… bash -c …` is caught before the
  payload matters.
- **`config.toml` specifically** cannot be rewritten (policy surface, both
  channels, every spelling), relocated (`QCR_CONFIG`) or shadowed by a
  receipt-dir relocation (`QCR_POSTING_RECEIPT_DIR`) — and a rewrite
  that reaches it anyway is a `policy_surface_modified` wake at round end.
- **The profile recovery journal is policy too.** Setup records a pending
  profile update in `state/setup/qcr-profile-write.json` before it changes
  profile files; an explicit write retry replays that intent. The reviewer
  cannot write that basename or its `.qcr-profile-write.json.tmp` sibling,
  through file tools or shell redirections, including pathname patterns.
  The audit classifies these as `policy_surface_write`. Like built
  `state/agents/**`, this companion-owned file changes during normal work,
  so layer 4 does not hash it; the located profile outputs remain watched.
- **Layer 4 watches the policy surface.** The same fingerprint dispatch takes
  and verdicts re-checks hashes `config.toml` and the seven directories,
  recursively by content, so `T=config.toml; cat p > $T` — the one spelling no
  string scan can see — is a wake, exactly as its `.git/config` twin is.
  The live config is not necessarily `<sandbox>/config.toml` (the install
  locator decides): layer 4 also watches the LOCATED config
  (`$QCR_CONFIG` — on the VM the shipped, read-only config home —
  else `<config home>/config.toml`) and the profile dirs the loader reads from
  the homes (`<config home>/profiles`, and `profiles/` beside `$QCR_CONFIG`),
  through `locatedPolicyWatchPaths`. Not `secrets/` or `portrait/`.
  `state/agents/**` is deliberately NOT in the watch set: the daemon itself
  rebuilds it mid-round on feedback ingest and the day change, and a check that
  fires on the daemon's own work gets switched off.

The post-hoc audit (`src/usage.ts`) has the matching telemetry kinds —
`policy_surface_write` (a redirection, `sed -i` or write-tool target on the
policy surface, dequoted, every spelling) and `policy_relocation` (a `QCR_*`
relocator, at the top level or inside a `bash -c` payload) — so a write that
somehow gets past the guard is at least *seen*, never silent; and
`memory_scope_write` the same way, for the memory-scope files below.

Layers 1 and 3 make the git-config-executes-shell family *impossible* at all
three of git's config scopes for the write paths they can see; layer 4 catches
the ones they cannot see, which is every one that goes through a variable or a
program body. Layer 5 notices the terminal harm whatever caused it. Layer 2
remains an enumeration, and that is acceptable, because it is not the
only thing standing between a session and an ungated approval.

## The memory scope — a session cannot widen its own recall

The daemon publishes two files into a PR session's pi home, beside its
`ovcli.conf` (`src/memory/ovsession.ts`), and the vendored OpenViking
extension reads them on every prompt: the RECALL HINT
(`.openviking/recall-hints/<session>.json` — the round's query and the memory
areas a round may read, `experiences/` alone; vendored patches 0008, 0009 and
0011 bound the recall AND the session's `viking_search`/`viking_read`/
`viking_browse` to those areas) and the RETIRED list
(`.openviking/retired-uris.json` — entries the recall excludes). The extension
takes the hint's areas as given (`toolScopeAreas`, run against a tampered file
in `tests/exec-boundary.test.ts`), so one write of
`{"areas":["finding-cases","events"]}` would widen the session's own memory
reach to the finding cases and feedback events no review round may read, until
the daemon wrote the hint again at the next round; an emptied retired list
would bring retired entries back into every recall.

So they are in the write veto as a third set, `MEMORY_SCOPE_SURFACE`, through the
same predicate (`isProtectedWriteTarget`) both channels read, every
redirection spelling and `sed -i` included, with their own refusal
(`memory-scope file`). Matched as a SHAPE — the distinctive name under any
prefix (`recall-hints/…`, `retired-uris.json`, and the writer's
`.tmp-<pid>` temps), because the guard does not know the pi home and a `cd`
into `.openviking/` drops that part of the spelling. The audit gained the
matching `memory_scope_write` kind. **Layer 4 does not watch them**, and that
is deliberate: the daemon rewrites the hint at every round's dispatch, so a
round-boundary hash would report its own work (the `state/agents/**`
reasoning) — the write veto is the protection these files have.

That makes the veto's REACH the whole of the protection, and review
falsified G6 as first written with four spellings that each name a file and
each overwrote the real one in a scratch dir: a pathname pattern in the
redirection target (`> recall-hint?/pr-1.json`, `> retired-uri[s].json`,
`> retired-uris.js*`), a one-element sequence brace (`> recall-hint{s..s}/…`,
one word, so no "ambiguous redirect"), an operator glued to the word before it
(`printf x>retired-uris.json`), and a read verb's own write option
(`git show HEAD:<blob> --output=<hint>`, `git log --format=format:<text>
--output=<hint>` — no redirection at all, and the blob can ride the PR under
review). All four are closed for all three protected sets — the quote-aware
redirection scan and its pattern judgement in layer 3, `--output` in layer 2 —
and sit in round 10 of the corpus, replayed against the compiled guard; the
audit sees each (`memory_scope_write`, or `reader_write_or_exec` for a git
write mode onto no protected path), and its memory-scope shapes are the
guard's own (`recall-hints/…` or the dir, `retired-uris.json` and its
`.tmp-<pid>`; a `docs/recall-hints.md` or `retired-uris.json.bak` is neither,
in both). Closing `--output` turned up `git grep -O<cmd>`, which RUNS `<cmd>`:
arbitrary execution through a read verb, closed in the same change.

## The wake-delivery files — a session cannot forge whose turn is running

The daemon drops every session's wakes into `<root>/inject/<session>/`; the
inject bridge takes pending wakes in name order and moves the one pi accepts
into `.done/`. The daemon reads that move as "this turn is now running", and
for the overseer it decides RIGHTS: a Slack-driven command gets the rights of
the turn being served (`src/slack/origin.ts`), and the `commands/` belt is
lifted only by a daemon wake pi accepted. The overseer runs as the daemon's
uid, so before this set the inject dirs were writable: one
`printf x > inject/overseer/.done/<queued wake>.md` handed a running guest
turn the rights of a queued owner message or daemon wake, and a queued wake
emptied in place did the same through the bridge (it moves an empty file to
`.done/` without serving it).

So the write veto refuses a fourth set, `DELIVERY_SURFACE`, through the same
predicate both channels read, with its own refusal (`wake-delivery file`):
the `inject` dir under any prefix, a `.done` dir under any prefix (a `cd` into
the inject dir drops `inject/`), and the wake file's own NAME (a `cd` into the
session's dir drops every directory). The origin store also asks for both
halves of the bridge's one rename — the file in `.done/` AND gone from the
queue — and a session has no program that moves or removes a file. The audit
gained `delivery_surface_write`; the chains are round 12 of the corpus,
replayed against the compiled guard. **Layer 4 does not watch these dirs**:
the daemon and the bridge rewrite them all the time, so the write veto is
their protection, as it is for the memory scope.

A thirteenth round found that the argument `sed` had been kept on — its
file/exec verbs are single letters at a command position — had been enforced
with patterns, and the patterns were the round-7 awk mistake again. GNU sed's
`e` runs the pattern space as a shell command, as a command (`e`) and as a flag
of `s`; the rules keyed the flag on a `/` delimiter and on its being last, and
the command on a short list of address shapes, so each of these was allowed
and ran a command:

```
sed 's|.*|<cmd>|e' f        sed -n 's/.*/<cmd>/ep' f        sed -n '1!e' f
```

The decision held — sed stays — but its enforcement changed shape:
`checkSedInvocation` PARSES the invocation. Every option is classified (GNU
long options by unambiguous prefix, as getopt resolves them; short clusters
letter by letter), every script is split into commands (every address form,
any `s`/`y` delimiter, `a`/`i`/`c` text, labels and comments), and the
invocation is allowed only when every part is understood and none writes,
reads another file or runs a command. What it cannot read is refused: an
unknown option or command, an unfinished script, an argument whose value the
command text does not fix (a `$`-expansion, `$'…'`, a backtick), and `xargs
sed` unless sed's own words end with `--` — xargs appends stdin to them, and
GNU sed reads an option anywhere, so a file in a PR's tree named
`-es/.*/<cmd>/e` would otherwise be a script. The chains are round 13 of the
corpus, replayed against the compiled guard.

## The guarantees, stated so they can be falsified

**G1 — the set of files git reads configuration from is fixed at spawn, small,
and named.** For a review session it is the pinned global file plus the
repository's own config and hooks; the search path that would find others never
runs. This is a claim about the READ side only — it deliberately does not
claim those files cannot be written; that claim was disproved five ways in ten
minutes. Writes
are handled by G4. *Falsify it by* naming a config or hook location git reads
that is neither pinned away nor in `gitConfigWatchPaths`.

**G2 — `HOME` and `XDG_CONFIG_HOME` are not config vectors.**
Not because they are blocked (they are, at layer 2) but because the search path
that consults them never runs. *Falsify it by* executing a payload from
`$HOME/.gitconfig` or `$XDG_CONFIG_HOME/git/config` in a real session pane.

**G3 — an approval the daemon did not make is visible within one reconcile
poll.** A bot-authored `APPROVED` review at a PR's current head with no local
trace (a posting marker carrying a key the daemon issued for that PR at
that head, `rounds.gh_review_id`, the `reviewed_heads` mark,
or a migration-precheck event) raises an `ungated_approval` anomaly.
*Falsify it by* posting a bot review at the current head that acquires one of
those traces without going through the gate or the sanctioned scripts.

**G4 — a session write to git's configuration, or to this system's own policy
surface, does not survive a round unnoticed.** Every file layer 4 watches — git's
config and hook locations, and `config.toml`, `scripts/`, `dist/`,
`extensions/`, `prompts/`, `agents/`, `seeds/` under the sandbox root, the
directories hashed recursively by content — is hashed when the round's worktree
is prepared and re-hashed when the round is measured; a difference is a wake
(`git_config_modified` / `policy_surface_modified`). *Falsify it by* changing
one of those files mid-round and getting a clean round, or by naming a config
location git reads that `gitConfigWatchPaths` omits.

**G5 — a review session cannot write this system's own policy surface through
either write channel, in any spelling the guard can see.** No
`write`/`edit` tool call, no shell redirection in any of bash's spellings
(`>`, `>>`, `&>`, `&>>`, `>&f`, `{v}>`, `<>`, `>|`, fd-prefixed, the target
quoted or backslash-escaped) and no `sed -i` can land on `config.toml`,
`scripts/**`, `dist/**`, `extensions/**`, or the frozen seeds `prompts/**` /
`agents/**` / `seeds/**` (the built `state/agents/**` included). Both channels
read the one predicate `isProtectedWriteTarget`, whose set is the same
definition layer 4 watches. And a `bash -c '…'` cannot launder a refused
command — `;`, newline, `&&`, `||`, `$(…)` and backticks inside its payload are
re-parsed at every depth, and a payload the guard cannot read (a substitution,
a value-taking option before `-c`, `xargs bash -c`, `env -S`) is refused
outright. *Falsify it by* writing any of those paths from a real session — via
the write tool, a redirection, or a `bash -c` payload — and getting an
`allowed` result on the compiled `dist/` guard, with no
`policy_surface_modified` wake at round end.

**G6 — a review session cannot write the memory-scope files its own recall
reads through either write channel, in any spelling that names them**:
no `write`/`edit` tool call, redirection (glued or spaced,
quoted or not, `$'…'`), redirection target bash expands (a pathname pattern,
a sequence brace) or `sed -i` lands on a `recall-hints/…` path or a
`retired-uris.json`, and no git read verb writes one through `--output`.
*Falsify it by* writing either from a real session with a command that names
the file, literally or as a pattern, and getting an `allowed` result on the
compiled `dist/` guard.

### What is NOT guaranteed — say so rather than implying otherwise

- **Layer 2 is not closed and is not claimed to be.** A general-purpose tool
  has more paths to `exec` than any list holds. Seven rounds are the evidence.
- **The write veto sees redirections, `sed -i` and the write tools — it does
  NOT see variable indirection or a write inside a program body.**
  `T=.git/config; cat p >> $T` is invisible to it *by construction*, and so is
  a write hidden inside a quoted `sed` program the reader-mode rules do not
  recognise. This is not a gap awaiting more spellings; it is the reason
  layer 4 exists. Adding spellings here is the mistake rounds 1–4 made.
- **The `find` and `sort` reader-mode rules are pattern-based; `sed` is
  parsed.** The sed parser reads sed as GNU sed 4.x reads it; a sed whose
  script language grew a new file/exec verb would need the parser to learn it,
  and until then the verb is an unknown command — refused, not allowed. The
  parser's word split re-joins the guard's whitespace tokens, so a quoted
  script with a run of spaces is judged with one space; that changes no
  command boundary sed sees. Round 13 is the reminder that a residual left in
  place because it "only writes" sat beside exec spellings the same patterns
  missed: when the gap is an *exec* primitive, layer 4 cannot cover it.
- **Layer 4 does not watch `<clone>/.git/modules/*/config`** (submodule
  configs), so a submodule's config is outside G4.
- **G4's window starts at worktree preparation.** Anything planted BEFORE that
  — a hook, a config line — is baselined as legitimate and will never be
  reported. G4 says "unchanged during the round", not "clean".
- **The write veto is not a sandbox.** The session runs as the same uid as the
  daemon. Nothing here revokes filesystem permission; every layer above is a
  refusal or a detection.
- **The App's credentials are readable by the session.** Same uid, so
  nothing revokes the read. `checkSecretPaths` refuses the obvious SPELLINGS — a command or a file-tool path that names
  `app.pem`, `webhook_secret`, `tunnel_token`, the OpenAI/Slack key files or a
  secrets dir, including globs, quoting and `../secrets` from the sandbox root
  — but it is a belt: `d=/opt/quickreview/sec; cat ${d}rets/app_id` and
  `grep -r 'PRIVATE KEY' /opt/quickreview` still read them. A review body
  posted through the sanctioned scripts is a channel to GitHub, so a session
  past its instructions can publish what it reads. What IS refused (found by
  execution) is moving the scripts' host: `GITHUB_API=` as a command
  prefix pointed `mint-token.sh` — and with it the App's signed JWT — at any
  host the session named, the one outbound channel this policy otherwise
  leaves closed. The floor for the read is the same as for G5: a uid split or a
  mount the session cannot read, a deploy change.
- **Layer 4 detects; it does not prevent.** The write lands, the round
  completes, the anomaly follows. It bounds the damage to one round. Its window
  is round start → round measurement, so a write made and reverted inside that
  window leaves both hashes equal.
- **G3 under `[github] auth = "user"` sees only marker-bearing reviews.** In
  that mode the bot posts as the person, so a review under their login counts
  as the bot's only when it carries a `<!-- qcr… -->` marker or the review
  footer (`packages/pi-plugin/src/identity.ts`). The person's own hand-written
  approval never alarms. The cost: an out-of-gate review that carries neither
  is indistinguishable from the person's own, and G3 does not see it.
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
- **G3's marker trace is bounded to ISSUED keys, not to the sanctioned route.**
  A marker counts only when its key is a `rounds.posting_key` the daemon
  issued for that PR and names the review's own commit, so a typed-in marker
  (the format is public in `scripts/post-review.sh`) is no trace. But the
  round's session is handed its own key (`QCR_POSTING_KEY`), so a session that
  is already past layer 2 can still stamp that one key onto an out-of-gate
  review at its own round's head.
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
- **The policy surface (G5) is a WRITE veto, not a sandbox — and the residual
  is worse here than for git.** `T=config.toml; cat p > $T` is invisible to
  the veto by construction, exactly like its `.git/config` twin, and layer 4
  reports it at round END. For git that bounds the damage to one round's
  output. For `config.toml` the window is different in kind: a sanctioned
  `approve-pr.sh` run INSIDE that window reads the rewritten file, with
  `dry_run` and every guard knob under the session's control, before anything
  has been measured. Layer 5 sees the resulting review; nothing prevents it.
  The session runs as the daemon's uid and `deploy/ansible/playbook.yml` mounts
  the sandbox rw, so the true floor is still the mount. Making that floor real
  (a read-only mount for everything but `state/`, `verdict/`, `inject/` and
  `wt/`, or a uid split) is a deploy change and not this map's to make; until
  it is made, this bullet is the honest statement of G5.
- **G5 is the set of files named, not "anything that matters".** It is
  `config.toml`, `scripts/`, `dist/`, `extensions/`, `prompts/`/`agents/`/`seeds/`
  (and `state/agents/` at the write boundary) — the analogue of
  `isGitConfigSurface`, closed and listed in `POLICY_SURFACE_FILES` /
  `POLICY_SURFACE_DIRS`. A policy-carrying file OUTSIDE that set — a new
  top-level config, a policy input under another path — is not covered until
  it is added there (the veto and layer 4 follow automatically) AND to
  `POLICY_SURFACE_TARGET` / `POLICY_SURFACE_PATH_RE` in the audit, which stays
  an independent implementation on purpose. `src/**` is deliberately NOT on
  it: the container runs `dist/`, and the reviewed repo's own worktree carries
  `src/`.
- **G5 is a path SHAPE, not a rooted path.** The guard does not know the
  session's cwd, so it refuses `scripts/…`, `dist/…`, `agents/…` and a
  `config.toml` under ANY prefix — including inside the reviewed repo's
  worktree and under `/tmp`. A reviewer never writes those either (it reads
  code and never runs it), so the over-reach costs a loud refusal on a write nobody makes; but
  it is over-reach, and a legitimate future write under one of those names
  would have to be re-homed rather than exempted.
- **G6 is a write veto by name, with no layer 4 behind it.** A write that
  names neither `recall-hints` nor `retired-uris.json`, literally or as a
  pattern that can expand onto one — a `cd` into the hint dir first, then
  `> pr-5249.json`; a variable (`T=retired-uris.json; … > $T`); a name built
  by command substitution — is not seen, and because the daemon rewrites the
  hint every round there is no round-boundary hash to catch it either. The
  same is true of a writer the guard does not know is one: the program
  allowlist is what keeps that set small (`tee`, `cp`, `mv`, `dd` are off
  it), and layer 2 is not claimed closed. The damage is bounded to that session until its next
  round's hint, and the extension still reads only memory areas by name
  (`AREA_RE`). The floor is the same as G5's: a uid or mount split.
- **Layer 4 does not watch `state/agents/**`**, because the daemon rebuilds it
  mid-round; the write veto is the only protection the built pass bodies have.
  And a `dist/` rewritten by a development `tsc --watch` while a LOCAL daemon
  runs a round is a genuine `policy_surface_modified` wake — the check cannot
  tell a compiler from a session. On the VM the deploy DRAIN gate keeps `sync`
  out of a round's window.
- **`bash -c` recursion is quote- and separator-aware, not a shell.** It lifts
  the payload as a dequoted word and re-parses it; a construction that a real
  bash would assemble at runtime but that is not literally present in the
  payload — parameter expansion of a variable set earlier in the same `-c`
  string, say `bash -c 'X=config.toml; cat p > $X'` — is not modelled, and is
  layer 4's again. What the recursion closes is the laundering of a LITERAL
  refused command behind a sanctioned one (door 4); what it refuses is any
  payload it cannot read. The audit, which never had a payload path, does not
  see `bash -c "$(…)"` at all.
- **The redirection scan is quote-BLIND on the operator side.** It splits on
  whitespace, so a `>` that stands as its own word inside a quoted pattern is
  an operator to it: `rg -n 'x > config.toml' docs/` is refused (VERIFIED),
  while `rg -n '>config.toml' docs/` — the quote glued to the `>` — is not
  seen. That asymmetry is an accident of tokenisation, not a design; the
  refusal is a false one on a read, loud and recoverable, the same trade
  the git-config veto makes for `.git/config`, and it is preferred to a quote-aware scan
  that would have to be a real tokeniser to be right.
- **`QCR_POSTING_RECEIPT_DIR` is refused as a relocator** alongside `QCR_CONFIG`,
  `QCR_STATE_DB` and `QCR_DRYRUN_DIR`. The per-call `QCR_*` arguments the daemon
  itself sets (`QCR_EXPECTED_HEAD`, `QCR_POSTING_KEY`, `QCR_ROUND_NO`,
  `QCR_POST_RESPONSE`) stay allowed — blocking them would break the daemon's
  own dispatch.
- **`QCR_INSTALL` is refused as a relocator** too: the install
  locator finds the live config in `$XDG_CONFIG_HOME/qcr/$QCR_INSTALL/`, so
  naming another install moves the config exactly as `QCR_CONFIG=` would. The
  daemon hands each session the config path it resolved as `QCR_CONFIG` in the
  pane environment; a session's own prefix is still refused.

## Review discipline for changes to any of this

Seven rounds found fifteen bypasses; the eighth found that the boundary had
never protected its own configuration, and then eleven more forms in the first
draft of the fix for that. Unit tests found none of them; every one was found
by someone running a command. So:

1. **Verify by execution, never by reading.** Every bypass was found by running
   something. A claim that a chain is blocked, unaccompanied by a run, is a
   hypothesis.
2. **Probe the compiled artifact.** The container runs `dist/`; tests assert the
   source. Rounds two and three both shipped source fixes whose compiled form
   was never exercised. `tests/exec-boundary.test.ts` replays the corpus against
   `packages/pi-plugin/dist/extensions/bash-guard.js` and asserts source and build agree.
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
9. **Ask what the boundary does not protect, starting with itself.** Round 8's
   finding was not a clever spelling; it was that seven rounds of hardening a
   guard had never listed the guard's own config, scripts and compiled body
   as things a session must not write. When a defence is finished, enumerate
   the files that decide what it does and check each is behind it.
10. **Probe the fix with the same tool that found the bug.** The first draft
    of round 8's fix passed its own tests and the compiled probe, and fell to
    `&>`, `{v}>`, `1<>`, `>&f`, `>|`, a quoted target, `env -S`, `bash -o …
    -c` and `bash -c "$(…)"` inside an hour — every one of them from bash's
    manual, every one confirmed by running it against a scratch file before
    it went into the corpus. A fix for a by-execution finding is not done
    until it has been attacked by execution.
