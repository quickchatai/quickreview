# Worker rehearsal

P8.20a. The pre-deletion rehearsal of the worker world: HEAD's release and memory images, run with the cutover run spec's volumes and command (`deploy/qcr-update.sh`) over a legacy-shaped host directory, before any Phase 9 deletion. While `procRuntime`, the tmux host and the bridge still exist a failure is found before anything is gone.

Run 2026-10-20 on 1baa2f5e. **21 of 21 checks passed, 0 failed.** Cost: $0 (no model, no GitHub, no registry; the containers cannot reach anything but a scripted stub).

Re-run it: `scripts/worker-rehearsal.sh` (about 10 minutes with the images built, 25 with a cold build; `--reuse-images`, `--keep`, `--work DIR` and `--only IDS` are in the script's header). It exits 0 only when every check passed, and a full run rewrites this file; an `--only` run writes its report into its work directory.

## The rehearsal's world

- **Images**, built from HEAD by `scripts/worker-rehearsal/build-images.sh` (the Dockerfiles' own allowlists, staged because this host has no BuildKit): release `sha256:b4fc7006accd` (768 MB), memory `sha256:7dbe06df36b4` (1983 MB); run spec label 1 layout=release.
- **The host directory** (`scripts/worker-rehearsal/layout.sh`) is what the VM's `/opt/quickreview` is the moment before the cutover: a `state.db` created by the LEGACY build (commit 8169df6f, the one the live bot runs) with the operator's drain standing and an earlier closed PR; PR 7's legacy interactive-pi JSONL under `state/pi-sessions` (2026-10-18T10-00-00-000Z_rh-legacy-5f25b3dd.jsonl 8931 bytes), its header cwd the legacy sandbox root `/opt/quickreview/sandbox`; the legacy mounts (`sandbox/wt`, `archive`, `commands`, `digest`, `inject`, `verdict`, the base clone); a pihome with a far-future fake login; a generated App key and ids; `dry_run = true`.
- **The containers** are started with the run spec's flags and volumes, in the run spec's order: the memory sidecar (seeded, key read back, restarted, `/ready`), then the daemon (`daemon`, `--restart unless-stopped --init`, 2 CPUs, 8 GiB, the same bind mounts including the legacy-path continuity mounts).
- **The model** is `scripts/worker-rehearsal/stub.mjs`, an OpenAI-compatible server on the rehearsal network. pi reaches it through the pihome's own `models.json` (a `local` provider) and `config.toml` names `local/m` for every role and tier: no code hook, no real provider. It plays a playbook read off each request (the main session joins the wave with `lens_wave`, writes and commits the verdict, posts through the shim; a lens leaf answers `NONE`).
- **GitHub** is the same stub, answering as `api.github.com` (a network alias, over TLS with a throwaway CA the containers trust through `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`, `CURL_CA_BUNDLE` and `GIT_SSL_CAINFO`) and `auth.openai.com` (pi-ai's own token refresh). The base clone's origin is a local bare repository; `git` fetches from it, not from GitHub.
- **The network** is `docker network create --internal`: no route out. The capture is the stub's request log (every request it served) plus what the containers tried to reach and could not (failed lookups in the logs).

## Results

| | check | result | evidence |
|---|---|---|---|
| IMG-1 | the release image is built from HEAD | pass | qcr.build-sha=1baa2f5e (HEAD itself); qcr.layout=release qcr.runspec=1 |
| NET-1 | the network is internal: example.com is unreachable, api.github.com is the stub | pass | internal=true; example.com: curl: (6) Could not resolve host: example.com 000 rc=6 unresolved ; api.github.com via the stub: HTTP 200 |
| MEM-1 | the memory sidecar is ready and the reviewer key authenticates | pass | /ready after the seed boot and a restart; image 1983472149 bytes |
| CFG-1 | the new image accepts the new world's config (qcr config check) | pass | {"ok":true,"config_home":"/cfg","errors":[]} |
| MIG-1 | the migrations apply to the legacy state.db: nothing lost, the legacy rows kept | pass | legacy_tables=42 migrated_tables=69 tables_added=worker_breaker,worker_breaker_global,pr_host_leases,pr_conversation,pingpong_threads,pingpong_handled,pingpong_decisions,pingpong_decision_retries,pingpong_decision_breaker,finding_comments,finding_outcomes,review_outcomes,outcome_capture_activity,outcome_capture_marks,lesson_rounds,lesson_selections,lesson_shadow_marks,lesson_switch,lesson_suppressions,finding_cases,case_sync_marks,case_backfill,case_activity_marks,lesson_candidates,eod_curations,learner_marks,learner_recall_scans columns_added=session_commands.est_usd,session_commands.lens_usd,session_commands.usage_final,drain_state.reason LOST=none legacy event and closed PR 6 survive |
| DRAIN-1 | the drain the legacy bot left standing lifts on the first healthy reconcile | pass | draining 1 -> 0, drain_lifted event, no round started by the lift |
| WEBHOOK-1 | a signed fake webhook starts a round, and a worker runs it | pass | webhook HTTP 200; round 1 done; worker_spawned=1; verdict REQUEST_CHANGES |
| RESUME-1 | the worker resumes the PR's legacy session by id, with its legacy cwd | pass | one JSONL (2026-10-18T10-00-00-000Z_rh-legacy-5f25b3dd.jsonl), its first 8931 bytes unchanged, grown to 125228; the worker's session id and cwd: rh-legacy-5f25b3dd /opt/quickreview/sandbox |
| WAVE-1 | the engine starts the planned wave at round start, the session joins it with lens_wave and the verdict's passes match the plan | pass | 4 planned lens sessions ran (01-pass-baseline--sol-high,02-pass-behaviour-delta--sol-high,03-pass-sweep--sol-high,04-pass-tests--terra-med); no pass_plan_mismatch; permits block: {"ceiling": 20, "stagger_ms": 250, "in_use": 0, "queued": 0, "commands": []} |
| PERMIT-1 | the permit broker holds the ceiling (20) and staggers its grants (250 ms) across a burst of 24 parallel lens passes | pass | passes=24 peak_in_flight=20 span_first20_ms=4767 median_gap_first20_ms=251 start_of_21st_after_first_ms=6011 - the 21st pass could not start until the first had answered (6000 ms), so no more than 20 were ever alive |
| POST-1 | the worker posts through the gate into state/dryrun and commits the verdict | pass | 1 create_review record for round 1 (REQUEST_CHANGES, the model's body; 1 records in all); verdict_applied; GitHub mutations reaching the stub: 0 |
| ANSWER-1 | the answer worker works without may_post (it holds no posting tool, nothing lands) and with it (its reply goes through the gate into state/dryrun) | pass | without: reply records 0 -> 0, result: {   "command_id": "1444b6bf-25e3-4cc2-adf6-f0c15c278cd6",   "pr": 7,   "ok": true,   "reply": "reply attempt: Tool bash not found",   "may_post": false,   "posted": 0,   "est_usd": 0.0027199999999999998,   "finished_at": "2026-10-20T14:40:0; with --may-post: 0 -> 1, 2026-10-20T14-40-08-881Z-0006-create_review_comment_reply.json (reply to comment 9001), result: {   "command_id": "5a9cafe8-cf76-4047-a9ae-3c470dcf5652",   "pr": 7,   "ok": true,   "reply": "reply attempt: dry-run: reply to review comment 9001 on #7 -> /opt/qcr/state/dryrun/2026-10-20T14-40-08-881Z-0006-create_review_comment_reply.jso |
| TAKEOVER-1 | takeover works in a pty: the operator talks to the PR's own session, a worker is kept out while it stands, and the pi is gone before the lease frees | pass | attached with docker exec -it (pty), typed a line and the session answered; lease 'takeover held'; a message during it: → message #7 pending… ✖ message #7 refused (#7 is under a takeover lease: the operator works in its session; release it first) ; after release: lease rows 0, takeover pi processes 0 |
| DEBUG-1 | debug-round runs the PR's next round in interactive pi in a pty, posts through the gate, and keeps every worker out until the pi is confirmed gone | pass | lease 'debug held' armed; round 2 ran in tmux debug-pr-7 (attached in a pty, rc=0), its review went through the gate (create_review records 1 -> 2); verdict committed, its passes the plan's (no pass_plan_mismatch); status.json runtime while it ran: debug; the round ended itself ({"kind":"debug","why":"the round's verdict is committed"}): pi gone, lease rows 0; workers spawned while it stood: 0 |
| RESTART-1 | a daemon restart kills and requeues a worker; a fresh one finishes the round over the same JSONL | pass | worker mid-round, daemon SIGKILLed, container restarted by its policy; boot said: workers: recovered killed=0 stale=1 requeued=1 failed=0 ; the command's attempt 1 -> 2; round 3 done; one JSONL |
| BREAKER-1 | a failing worker trips the breaker: the PR is parked after two failures and no third worker starts | pass | workers spawned for the round: 2; worker_crash_loop anomaly x1; status.json worker_crash: {"failures": 2, "parked_at": "2026-10-20T14:43:04.253Z", "last_error": "the round: the provider failed the turn: 500: {\"message\":\"the rehearsal stub is told to fail\"}", "last_at": "2026-10-20T14:43:04.253Z"} |
| LOGIN-1 | the refresher holds auth.json.lock; after a real refresh a second refresher is refused | pass | lock held before and after the refresh; the due token was refreshed through pi-ai's own OAuth refresh against the stub (1 token POST(s), the refresh token rotated); a second refresher exited 75: login refresh: another login refresher holds /home/qcr/.pi/agent/auth.json.lock — refusing to start  |
| BUSY-1 | concurrent daemon and worker activity leaves no SQLITE_BUSY | pass | 0 hits in the daemon log, 12 worker logs and the events table, over 7 worker spawns, 3 rounds, 2 answers, a takeover, a debug round and a restart |
| TREE-1 | the daemon's process tree holds no PR pi; the only pi is the tmux overseer's (HEAD still births it at boot; P9.13 deletes it) | pass | pi processes under the daemon (node wire.js): 0; tmux sessions: main overseer ; pi processes in the container: 1 (the overseer's, under the tmux server) |
| STATUS-1 | status.json shows the runtime fields | pass | {"permits": {"ceiling": 20, "stagger_ms": 250, "in_use": 0, "queued": 0, "commands": []}, "runtime": {"6": "idle", "7": "idle"}} |
| NETCAP-1 | no provider and no GitHub call: the network capture shows only the stub | pass | the network is --internal; 121 model requests, every GitHub/OAuth request and 0 GitHub mutations were served by the stub; stub_requests={"github": 105, "admin": 13, "model": 121, "oauth": 1} unmodelled={}  lookups that could not leave: none |

## The capture

- Stub: stub_requests={"github": 105, "admin": 13, "model": 121, "oauth": 1} unmodelled={} github_mutations=0 
- Lookups from the containers that could not leave the network: none

## Run notes

- **schema diff**: `legacy_tables=42 migrated_tables=69 tables_added=worker_breaker,worker_breaker_global,pr_host_leases,pr_conversation,pingpong_threads,pingpong_handled,pingpong_decisions,pingpong_decision_retries,pingpong_decision_breaker,finding_comments,finding_outcomes,review_outcomes,outcome_capture_activity,outcome_capture_marks,lesson_rounds,lesson_selections,lesson_shadow_marks,lesson_switch,lesson_suppressions,finding_cases,case_sync_marks,case_backfill,case_activity_marks,lesson_candidates,eod_curations,learner_marks,learner_recall_scans columns_added=session_commands.est_usd,session_commands.lens_usd`
- **first worker**: `{"command_id":"8fc93311-eee1-4ece-850f-cd6653c476d0","mode":"round","generation":1,"pid":126}`
- **wave**: `leaf_sessions=4 min_gap_ms=102 rows=01-pass-baseline--sol-high,02-pass-behaviour-delta--sol-high,03-pass-sweep--sol-high,04-pass-tests--terra-med `
- **permits status**: `{"ceiling": 20, "stagger_ms": 250, "in_use": 0, "queued": 0, "commands": []}`
- **burst**: `passes=24 peak_in_flight=20 span_first20_ms=4767 median_gap_first20_ms=251 start_of_21st_after_first_ms=6011 `
- **debug end**: `{"kind":"debug","why":"the round's verdict is committed"}`
- **login refresh**: `null`
- **process tree pi**: `84 60 pi                                                                                                                                                                                                      `
- **tmux sessions**: `main overseer `
- **status runtime**: `{"permits": {"ceiling": 20, "stagger_ms": 250, "in_use": 0, "queued": 0, "commands": []}, "runtime": {"6": "idle", "7": "idle"}}`
- **answer without**: `{   "command_id": "1444b6bf-25e3-4cc2-adf6-f0c15c278cd6",   "pr": 7,   "ok": true,   "reply": "reply attempt: Tool bash not found",   "may_post": false,   "posted": 0,   "est_usd": 0.0027199999999999998,   "finished_at": "2026-10-20T14:40:06.824Z" } `
- **answer with**: `{   "command_id": "5a9cafe8-cf76-4047-a9ae-3c470dcf5652",   "pr": 7,   "ok": true,   "reply": "reply attempt: dry-run: reply to review comment 9001 on #7 -> /opt/qcr/state/dryrun/2026-10-20T14-40-08-881Z-0006-create_review_comment_reply.json — nothing was sent",   "may_post": true,   "posted": 1,   "est_usd": 0.0027199999999999998,   "finished_at": "2026-10-20T14:40:08.934Z" } `

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
  order and writes both. It also reported every agent a later round's order names (the raise-to
  tiers, the pre-approval sweep's plan) as the verdict's passes, which the daemon rightly logged
  as `pass_plan_mismatch`; it now reports the rows of the order's pass plan. Its answer stub ran `…; echo post-exit=$?`, which hid the post's exit
  status from the worker's post count.
- **F6, rehearsal: the login refresh had no OAuth server** (LOGIN-1). The stub's certificate named
  only GitHub, so pi-ai's refresh to `auth.openai.com` failed TLS (`ERR_TLS_CERT_ALTNAME_INVALID`).
  The leaf now names `auth.openai.com` and the stub answers the refresh with a rotated refresh
  token. The check's comparison of the rotated token was also a prefix match that the new token
  (`rehearsal-refresh-token-1`) always matched.
- **F7, rehearsal: reading a restarted daemon's logs by time.** A restarted container keeps the
  previous boot's lines, so "a healthy reconcile in the last two minutes" matched the old daemon's
  and RESTART-1 read the first boot's `workers: recovered … requeued=0` while the new boot had
  logged `requeued=1`. The rehearsal now waits for a boot after the kill and a reconcile after
  that boot's recovery. BREAKER-1 read a status field that does not exist (`worker_error`); it now
  reads the park where the board and the alerts do, `prs[].worker_crash.parked_at`.
- **F8, rehearsal: PERMIT-1 measured nothing on one earlier run.** That run triggered round 1 at
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
