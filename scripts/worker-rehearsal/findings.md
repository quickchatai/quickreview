## Findings

What the rehearsal found on the way to a green run. Two were product bugs, fixed in product code
with unit tests before this run; the rest were the rehearsal's own expectations or its stub.

- **F1, product: a debug round on a legacy PR could not post or commit its verdict** (DEBUG-1).
  Interactive pi opens `--session <file>` in the cwd the JSONL's header records. A PR the legacy
  tmux bot reviewed carries `/opt/quickreview/sandbox` there, which the release container keeps only
  for path continuity (no `scripts/`, `state/` or `verdict/`). The debug pi ran its bash in that
  directory, bash-guard refused `scripts/post-review.sh` ("not a sanctioned script": the cwd was
  not the sandbox root), and the round never ended, so its lease stayed held. The takeover pane had
  the same cwd. Fixed by `src/picwd.ts`: both panes start pi's own CLI through an entry whose
  `SessionManager.open` defaults to the process's cwd, as the SDK route already resumes a session
  in the spec's cwd; the header on disk is not rewritten (`tests/picwd.test.ts`).
- **F2, product: bash-guard threw on a glob class JavaScript cannot compile.** A verdict written
  by bash carries `[{"name":"pass-a",…}]`; the guard's glob-to-regex turned the word's
  `[name:pass-a]` into a class with a reversed range and threw instead of answering. Such a class
  now widens to any one character but `/`, the most a bracket expression can match in bash, so
  the guard refuses at least as much as before (`tests/bash-guard.test.ts`). The stub's debug
  round had been writing a verdict with empty `passes` to step around it; it now writes the real
  one.
- **F3, rehearsal: what the answer worker may post** (ANSWER-1). With `may_post`, the worker's
  review COMMENT at the head round 1 had just reviewed was refused by guard 2 (no new evidence),
  which is the guard working: an answer is not a second review of the same head. The operator's
  "answer the author" is a thread reply, and that is what the rehearsal now asks for; it lands in
  `state/dryrun` through the post IPC and the one gate. Without `may_post` the worker holds no
  posting tool at all (P8.17: read-only tools plus chat), so its bash call fails as "Tool bash not
  found" and nothing lands; the daemon's own `may_post_required` refusal of the post IPC is the
  second belt, covered by P8.17's unit tests because no tool in that worker can reach it. The
  section also moved back after round 1: before it the PR is not tracked, and the message is
  refused.
- **F4, rehearsal: a debug round ends itself** (DEBUG-1). The daemon stops the debug pi once the
  verdict is committed and the pane has been quiet `DEBUG_VERDICT_SETTLE_MS` (15 s), confirms it
  gone, then frees the lease. The check released the lease itself after 8 s; it now waits for the
  round's own end and records why the lease went.
- **F5, rehearsal: the stub's playbook.** A worker that takes a round over adds a continuation turn
  that points back at the order; the stub read it as a lens leaf's task, answered `NONE`, and the
  resumed worker ended the round without a verdict, which the daemon rightly failed loud
  (RESTART-1). The stub's rounds also wrote no findings record and no ledger block, so the daemon
  nudged the PR's session a minute after each round, and that nudge's worker held the PR's one
  active slot while RESTART-1 waited for its round. The stub now plays a taken-over round from its
  order and writes both. Its answer stub ran `…; echo post-exit=$?`, which hid the post's exit
  status from the worker's post count.
- **F6, rehearsal: the login refresh had no OAuth server** (LOGIN-1). The stub's certificate named
  only GitHub, so pi-ai's refresh to `auth.openai.com` failed TLS (`ERR_TLS_CERT_ALTNAME_INVALID`).
  The leaf now names `auth.openai.com` and the stub answers the refresh with a rotated refresh
  token. The check's comparison of the rotated token was also a prefix match that the new token
  (`rehearsal-refresh-token-1`) always matched.
- **F7, rehearsal: PERMIT-1 measured nothing on one earlier run.** That run triggered round 1 at
  the head the legacy bot had reviewed, and the round settled in six seconds with no burst pass in
  the stub's log. With the trigger on a new head every run since has measured the burst (24
  passes, at most 20 in flight, grants about 250 ms apart). That run's log was not kept, so the
  mechanism was not pinned further.

## Limits

- The model is a scripted stub: the rehearsal proves the plumbing (who starts what, where it
  writes, what the gate records), not review quality.
- `dry_run = true` throughout: every post ends in `state/dryrun`, and the stub refuses any
  mutation that reaches it.
- The breaker scenario leaves PR 7 parked and the login scenario restarts the daemon, so both run
  last.
