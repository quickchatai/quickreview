# Cutover rehearsal

P8.20. The real cutover tooling, end to end, against a throwaway legacy-shaped host: `scripts/cutover.sh` (the P8.21a wizard) driving `scripts/deploy.sh`, ssh, `deploy/qcr-update.sh`, a registry and the release and memory images built from this tree, over a host directory a LEGACY build wrote. Four failures are injected before the clean run; the clean run goes through the point of no return, verify, the first reconcile under the operator's hold and the owner's lift, and then the P8.20a worker checks run on the release boot the updater made.

Run 2026-10-20 on 0bb52395. **40 of 40 checks passed, 0 failed.** Cost: $0 (no model, no GitHub, no ghcr; the containers sit on an internal docker network with a scripted stub).

Re-run it: `scripts/cutover-rehearsal.sh` (about 25 minutes with the images built; `--work DIR` reuses the registry, the pushed images and the pristine legacy host; `--fresh`, `--keep` and `--skip-worker` are in the script's header). It exits 0 only when every check passed, and a full run rewrites this file. The images come from `scripts/worker-rehearsal/build-images.sh` (the same tooling as P8.20a).

## What is real and what stands in

Real: `scripts/cutover.sh`, `scripts/deploy.sh` (provision, `--dry-run release`, `release`, `verify`), ssh to a throwaway sshd, `deploy/qcr-update.sh` itself (lock, drain check, layout check, `docker pull` BY DIGEST from a registry, label checks, `qcr config check` and `daemon --preflight` of the NEW image on the staged config and a snapshot of the legacy state, the store copy and its checksum verification, the config swap, the sidecar, the recreate, the rescue), the release and memory images, the release daemon's first boot over a state.db the legacy build (8169df6f) wrote, the migrations, the hold, the login refresher, the entrypoint's login mode.

Stands in (a test tool; none of it ships): see Limits.

## The world

- **Images** from this tree: release `sha256:ed3eb16e6a4c`, memory `sha256:0209b39b8379`; build stamp 0bb52395f28842a57828728f02e30dc373f5978d (HEAD 0bb52395f28842a57828728f02e30dc373f5978d).
- **Registry**: localhost:57373; daemon 1.0.0 sha256:20f25339385373ea0dafee0271b7d69740911817dc578aaad4c728fb69c15b41; memory 1.0.0 sha256:e019caecd1edf36f3aa34a3abd01fdee2467418f92cd3131c6b48d7e7f066208; never-ready memory 0.9.4 sha256:a4963841b0f5738be20c73227d5401e82a3f50fe7223030055a32dcdf4179346.
- **The legacy store**: 66 files, 3.3M; checksum 06eed2b561acbbb8.

## Results: the cutover

| | check | result | evidence |
|---|---|---|---|
| IMG-1 | the release image is built from this tree and carries the labels the updater requires | pass | qcr.build-sha=0bb52395f28842a57828728f02e30dc373f5978d (HEAD is 0bb52395f28842a57828728f02e30dc373f5978d, differing only in the rehearsal's own tooling, tests and docs); qcr.layout=release qcr.preflight=true qcr.runspec=1 qcr.pi=1.3.0 |
| REG-1 | the images are in a registry and the manifests are in the P7.16 format | pass | registry:2 on localhost:57373; deploy-manifest-<v>.json for 5 versions, each validated by scripts/deploy-manifest.mjs; daemon 1.0.0 sha256:20f253393853, memory sha256:e019caecd1ed; the manifest's platforms entries repeat the single-arch manifest digest (CI's index is multi-arch) |
| NET-1 | the containers' network is internal: example.com is unreachable, api.github.com is the stub | pass | internal=true; example.com: curl: (6) Could not resolve host: example.com 000 rc=6 unresolved ; api.github.com via the stub: HTTP 200; the legacy stand-in runs --network none |
| PROV-1 | deploy.sh provision installs the run spec; `sudo qcr-update status --json` answers over ssh and shows layout=legacy | pass | provision rc 0 (ansible-playbook is a stub that installs the rendered update.conf); layout=legacy; run spec v1 fingerprint 7ce6e15d350e19e3…; the stand-in container has no qcr.layout label (none) |
| HOST-1 | the legacy host: a legacy-shaped bot is running over a state.db the LEGACY build wrote, with the legacy config and a populated OpenViking store | pass | container quickreview-sandbox (image qcr-cutrh/legacy-standin:1, no qcr.layout label), state.db 43 tables (the legacy schema), config-home holds the old-world config ([engine] runtime = "proc", openviking.endpoint local), 66 store files; no sidecar yet |
| DRAIN-0 | qcr drain on drains the legacy bot (the operator's plain drain: the legacy daemon cannot spell a hold) | pass | [quickreviewd] config.toml [models] overseer is deprecated and ignored: the overseer session was deleted. Remove the key. drain on → cutover-vm:/opt/quickreview/sandbox/commands/ ✓ draining — 0 round(s) still finishing; deploy when `qcr status` draining_by=operator running_rounds=0 pending_wakes=0 |
| PLAN-1 | the dry-run plan shows what runbook C.11 asks for | pass | legacy layout, the manifest digests and a pull by digest, the new image's config check, stop then snapshot then preflight, the seed, the swap, sidecar /ready, the recreate named as the point of no return; nothing executed |
| INJ-1 | a failed config check changes nothing: the legacy bot is never stopped and stays drained | pass | the new image's config check refused the shipped config (a retired [engine] runtime key):                  stage the config to config-home.next; the NEW image's `qcr config check --json` on it; exit 1, last run 'refused config-check'; the legacy container 44bdf6a9c490 kept its id, config (sha 85b3102fb9139eaf), OpenViking store (checksum 06eed2b561acbbb8) and legacy schema (43 tables); no sidecar, no -prev container, no .next/.prev; drained by the operator again with 0 rounds; legacy bot boots 1 -> 1, drain lifts 1 -> 1, drain-on commands 1 -> 1 |
| INJ-2 | a failed preflight is rescued: the legacy bot is restarted on its old config and drained after its first reconcile | pass | daemon --preflight of the new image refused the scratch copy of the snapshot: {"ok":false,"checks":[{"name":"migrations","ok":true,"detail":"the scratch copy migrated forward"},{"name":"resume","ok":false,"detail":"1 open PR(s), 1 session file(s) resumed offline, 0 without a session","reason":"1 s; the snapshot stayed under the backup dir (0.9.2-20261020T212258Z ); exit 1, last run 'rescued preflight'; the legacy container 44bdf6a9c490 kept its id, config (sha 85b3102fb9139eaf), OpenViking store (checksum 06eed2b561acbbb8) and legacy schema (43 tables); no sidecar, no -prev container, no .next/.prev; drained by the operator again with 0 rounds; legacy bot boots 1 -> 2, drain lifts 1 -> 2, drain-on commands 1 -> 2 |
| INJ-3 | a failed store copy is rescued: the legacy bot is restarted on its old config and drained after its first reconcile | pass | the updater's checksum verification caught a byte flipped in the copy: qcr-update: the sidecar store copy does not verify by checksum: >fc.t...... ov.conf; the 'seeded' marker written: no; the config swap had not happened; exit 1, last run 'rescued seed'; the legacy container 44bdf6a9c490 kept its id, config (sha 85b3102fb9139eaf), OpenViking store (checksum 06eed2b561acbbb8) and legacy schema (43 tables); no sidecar, no -prev container, no .next/.prev; drained by the operator again with 0 rounds; legacy bot boots 2 -> 3, drain lifts 2 -> 3, drain-on commands 2 -> 3 |
| INJ-4 | a sidecar that never becomes ready is rescued: config swapped back, the sidecar removed, the legacy bot restarted and drained after its first reconcile | pass | the sidecar from the never-ready memory image (qcr-cutrh/memory-never-ready:1) was pulled and started, the config had been SWAPPED and the store SEEDED: qcr-update: the memory sidecar was not ready within 25s (a re-embed is a boot; read: docker logs --tail 100 quickreview-memory); seeded marker present (the retry will say 'already seeded'); config-home.failed kept for the post-mortem: yes; exit 1, last run 'rescued sidecar-ready'; the legacy container 44bdf6a9c490 kept its id, config (sha 85b3102fb9139eaf), OpenViking store (checksum 06eed2b561acbbb8) and legacy schema (43 tables); no sidecar, no -prev container, no .next/.prev; drained by the operator again with 0 rounds; legacy bot boots 3 -> 4, drain lifts 3 -> 4, drain-on commands 3 -> 4 |
| WIZ-A | scripts/cutover.sh runs stages 1-8 (preconditions, drain, plan, release, verify, first reconcile, backstop, surfaces) and stops at stage 9 | pass | stages recorded: preconditions drain plan release verify reconcile backstop surfaces ; stopped at stage 9 with the drain held (no answer to the worker-round question) |
| CUT-1 | the clean run passes the point of no return: both containers recreated by digest from the registry, config swapped, store seeded, snapshot kept | pass | daemon localhost:57373/qcr/quickreview@sha256:20f25339385373ea0dafee0271b7d69740911817dc578aaad4c728fb69c15b41 (qcr.build-sha 0bb52395f288) and sidecar localhost:57373/qcr/quickreview-memory@sha256:e019caecd1edf36f3aa34a3abd01fdee2467418f92cd3131c6b48d7e7f066208 running; the legacy container kept stopped as quickreview-sandbox-prev; config-home = the shipped config, config-home.prev = the legacy config; sidecar store = the legacy store (verified copy, original untouched); snapshot 1.0.0-20261020T212407Z: pi-sessions.tar.gz state.db modes 600; last run: {"version":"1.0.0","at":"20261020T212407Z","result":"ok","step":"done","detail":"updated to 1.0.0 (0bb52395f28842a57828728f02e30dc373f5978d); the drain stays on |
| MIG-1 | the release's first boot migrated the legacy state.db forward: nothing lost, the legacy rows kept | pass | legacy_tables=42 migrated_tables=69 tables_added=27 LOST=none legacy event and closed PR 6 survive; the snapshot the updater took (1.0.0-20261020T212407Z) is still the legacy file (43 tables) |
| VERIFY-1 | deploy.sh verify (the wizard's stage 5) passes: both containers up, build stamp, fresh heartbeat, pi settings and the AGENTS.override stub, sidecar ready and a memory search from the daemon's container | pass | no CHECK FAILED in the wizard's output; 26 checks ran |
| TREE-0 | right after the release boot the daemon container holds no pi, no PR tmux session and no overseer | pass | pi processes 0, tmux sessions other than the entrypoint's empty `main` shell: 0 (main: 1 windows (created Tue Oct 20 21:24:13 2026) ); the process tree is in the run notes |
| HOLD-1 | the operator's plain drain survives the release boot as the HOLD: drain_hold_carried at the boot, drain_hold_kept at the first healthy reconcile, no drain_lifted | pass | drain_hold_carried x1 (events), drain_hold_kept x1 (daemon log), drain_lifted x0; status.json: draining=true draining_by=operator draining_hold=true; drain_state row: 1\|1\|0\|2026-10-20T21:23:54.942Z\|2026-10-20T21:23:54.942Z\|operator\|\|\|1  |
| SURFACE-1 | the operator's read paths reach the release boot with the owner's [tui] config: the board's status read (cat /opt/quickreview/state/status.json over ssh) shows the hold, and the daemon's own qcr status says HELD | pass | DRAINING since 2026-10-20T21:23:54.942Z — HELD by the operator (hold: no boot lifts it) — webhook deliveries dropped: 0; deploy when rounds running hits 0 (only qcr drain off lifts it — no boot does) |
| HOLD-2 | no later reconcile pass and no daemon restart lifts the hold | pass | reconcile passes 1 -> 3 with the drain standing (True/True); after docker restart of the release container and its first healthy reconcile: True/True, drain_hold_kept x1 -> x2, drain_lifted x0 |
| HOLD-3 | under the hold a signed trigger and a debug-round request start nothing: no round, no command, no worker | pass | webhook HTTP 200 (the delivery is dropped, drained_deliveries 0 -> 1); debug-round: [quickreviewd] config.toml [models] overseer is deprecated and ignored: the overseer session was deleted. Remove the key. ✖ debug-round #7 refused (drained: the bot is draining: no worker starts)  |
| LIFT-1 | qcr drain off (the owner's go) lifts the hold, and it is the only thing that did | pass | [quickreviewd] config.toml [models] overseer is deprecated and ignored: the overseer session was deleted. Remove the key. drain off → cutover-vm:/opt/qcr/commands/ ✓ drain lifted — 1 webhook delivery(ie; drain_state draining=0; the heartbeat no longer shows draining; no round started by the lift itself (0 rounds) |
| SURFACE-2 | the operator's command channel follows the recreate with no [tui] edit: the drain on at stage 2 went to the legacy container's /opt/quickreview/sandbox/commands, the drain off to the release container's /opt/qcr/commands (the layout resolver reads the container's qcr.layout label) | pass | drain on → cutover-vm:/opt/quickreview/sandbox/commands/; drain off → cutover-vm:/opt/qcr/commands/ |
| REFRESH-1 | the login refresher took over the existing pihome login: it holds auth.json.lock, reports expires_at, and left the login file untouched (nothing was due) | pass | lock held: yes; auth.json sha 693a0020b8bcba8d == the legacy pihome's; status.json login_refresh: {"state": "supervised", "running": true, "restarts": 0, "login": {"pid": 74, "started_at": "2026-10-20T21:25:15.066Z", "expires_at": "2036-10-17T21:22:16.000Z", "provider": "openai-codex", "last_refre; refresher processes: 1 |
| LOGIN-PTY-1 | docker exec -it … entrypoint.sh login in a pty pauses the refresher (it keeps the lock) while pi's /login is open, and resumes it when the login ends; no OAuth was completed | pass | pty rc 0; during: loginrefresh.status.json paused=true, pause file yes, lock still held; after the pty was detached: paused cleared, pause file removed; auth.json unchanged. Screen:  ▀▀█ v1.3.0 █▀ █ escape interrupt · ctrl+c/ctrl+d clear/exit · / commands · ! bash · ctrl+o more Press ctrl+o to show full startup help and loaded resources. Pi can explain its own features and look up its docs. Ask it how to use or extend  |
| WIZ-B | the resumed wizard skips the finished stages (never repeats the release), records the owner's lift and the idle-PR answer, and schedules the 4-hour check | pass | rc 0; stages recorded: preconditions drain plan release verify reconcile backstop surfaces first_round idle_pr ; The 4-hour check is due at 2026-10-21 01:31 UTC. Come back then: |

## Results: the worker checks on the release boot (scripts/worker-rehearsal.sh --adopt)

| | check | result | evidence |
|---|---|---|---|
| WEBHOOK-1 | a signed fake webhook starts a round, and a worker runs it | pass | webhook HTTP 200; round 1 done; worker_spawned=1; verdict REQUEST_CHANGES |
| RESUME-1 | the worker resumes the PR's legacy session by id, with its legacy cwd | pass | one JSONL (2026-10-18T10-00-00-000Z_rh-legacy-b5d9e796.jsonl), its first 8931 bytes unchanged, grown to 125225; the worker's session id and cwd: rh-legacy-b5d9e796 /opt/quickreview/sandbox |
| WAVE-1 | the engine starts the planned wave at round start, the session joins it with lens_wave and the verdict's passes match the plan | pass | 4 planned lens sessions ran (01-pass-baseline--sol-high,02-pass-behaviour-delta--sol-high,03-pass-sweep--sol-high,04-pass-tests--terra-med); no pass_plan_mismatch; permits block: {"ceiling": 20, "stagger_ms": 250, "in_use": 14, "queued": 0, "commands": [{"command_id": "2c45a601-71db-4511-9958-c088a7b77329", "in_use": 14, "queued": 0}]} |
| PERMIT-1 | the permit broker holds the ceiling (20) and staggers its grants (250 ms) across a burst of 24 parallel lens passes | pass | passes=24 peak_in_flight=20 span_first20_ms=4761 median_gap_first20_ms=250 start_of_21st_after_first_ms=6015 - the 21st pass could not start until the first had answered (6000 ms), so no more than 20 were ever alive |
| POST-1 | the worker posts through the gate into state/dryrun and commits the verdict | pass | 1 create_review record for round 1 (REQUEST_CHANGES, the model's body; 1 records in all); verdict_applied; GitHub mutations reaching the stub: 0 |
| ANSWER-1 | the answer worker works without may_post (it holds no posting tool, nothing lands) and with it (its reply goes through the gate into state/dryrun) | pass | without: reply records 0 -> 0, result: {   "command_id": "e30480fc-0261-48e6-abbe-d62a5920cb65",   "pr": 7,   "ok": true,   "reply": "reply attempt: Tool bash not found",   "may_post": false,   "posted": 0,   "est_usd": 0.0027199999999999998,   "finished_at": "2026-10-20T21:26:5; with --may-post: 0 -> 1, 2026-10-20T21-26-57-721Z-0006-create_review_comment_reply.json (reply to comment 9001), result: {   "command_id": "357bcb9f-4310-439f-a3c3-0bee77ba0ee3",   "pr": 7,   "ok": true,   "reply": "reply attempt: dry-run: reply to review comment 9001 on #7 -> /opt/qcr/state/dryrun/2026-10-20T21-26-57-721Z-0006-create_review_comment_reply.jso |
| TAKEOVER-1 | takeover works in a pty: the operator talks to the PR's own session, a worker is kept out while it stands, and the pi is gone before the lease frees | pass | attached with docker exec -it (pty), typed a line and the session answered; lease 'takeover held'; a message during it: [quickreviewd] config.toml [models] overseer is deprecated and ignored: the overseer session was deleted. Remove the key. → message #7 pending… ✖ message #7 refus; after release: lease rows 0, takeover pi processes 0 |
| DEBUG-1 | debug-round runs the PR's next round in interactive pi in a pty, posts through the gate, and keeps every worker out until the pi is confirmed gone | pass | lease 'debug held' armed; round 2 ran in tmux debug-pr-7 (attached in a pty, rc=0), its review went through the gate (create_review records 1 -> 2); verdict committed, its passes the plan's (no pass_plan_mismatch); status.json runtime while it ran: debug; the round ended itself ({"kind":"debug","why":"the round's verdict is committed"}): pi gone, lease rows 0; workers spawned while it stood: 0 |
| RESTART-1 | a daemon restart kills and requeues a worker; a fresh one finishes the round over the same JSONL | pass | worker mid-round, daemon SIGKILLed, container restarted by its policy; boot said: workers: recovered killed=0 stale=1 requeued=1 failed=0 ; the command's attempt 1 -> 2; round 3 done; one JSONL |
| BREAKER-1 | a failing worker trips the breaker: the PR is parked after two failures and no third worker starts | pass | workers spawned for the round: 2; worker_crash_loop anomaly x1; status.json worker_crash: {"failures": 2, "parked_at": "2026-10-20T21:30:02.916Z", "last_error": "the round: the provider failed the turn: 500: {\"message\":\"the rehearsal stub is told to fail\"}", "last_at": "2026-10-20T21:30:02.916Z"} |
| LOGIN-1 | the refresher holds auth.json.lock; after a real refresh a second refresher is refused | pass | lock held before and after the refresh; the due token was refreshed through pi-ai's own OAuth refresh against the stub (1 token POST(s), the refresh token rotated); a second refresher exited 75: login refresh: another login refresher holds /home/qcr/.pi/agent/auth.json.lock — refusing to start  |
| BUSY-1 | concurrent daemon and worker activity leaves no SQLITE_BUSY | pass | 0 hits in the daemon log, 12 worker logs and the events table, over 7 worker spawns, 3 rounds, 2 answers, a takeover, a debug round and a restart |
| TREE-1 | the daemon's process tree holds no pi, no PR tmux session and no overseer: the daemon and the login refresher, nothing else long-lived | pass | pi processes in the container: 0 (under the daemon: 0); tmux sessions: main  (the entrypoint's empty shell, no pane runs pi); long-lived: node /opt/qcr/dist/src/wire.js;/usr/local/bin/node /opt/qcr/dist/src/loginrefresh/main.js; |
| STATUS-1 | status.json shows the runtime fields | pass | {"permits": {"ceiling": 20, "stagger_ms": 250, "in_use": 0, "queued": 0, "commands": []}, "runtime": {"6": "idle", "7": "idle"}} |
| NETCAP-1 | no provider and no GitHub call: the network capture shows only the stub | pass | the network is --internal; 121 model requests, every GitHub/OAuth request and 0 GitHub mutations were served by the stub; stub_requests={"github": 129, "admin": 13, "model": 121, "oauth": 1} unmodelled={}  lookups that could not leave: none |

## Run notes

- **wizard a**: `rc=1; stages recorded: preconditions drain plan release verify reconcile backstop surfaces `
- **backups**: `0.9.2-20261020T212258Z 0.9.3-20261020T212310Z 0.9.4-20261020T212322Z `
- **update log**: `81 lines in the updater's update.log across the four rescues and the clean run`
- **trigger under hold**: `webhook HTTP 200; drained_deliveries 0 -> 1; debug-round said: [quickreviewd] config.toml [models] overseer is deprecated and ignored: the overseer session was deleted. Remove the key. ✖ debug-round #7 refused (drained: the bot is draining: no worker starts) ; rounds 0, round commands 0, workers spawned 0`
- **login refresh**: `{"state": "supervised", "running": true, "restarts": 0, "login": {"pid": 74, "started_at": "2026-10-20T21:25:15.066Z", "expires_at": "2036-10-17T21:22:16.000Z", "provider": "openai-codex", "last_refresh": null, "last_error": null, "error_since": null, "paused": false, "checked_at": "2026-10-20T21:25:15.068Z"}}`
- **process tree**: ` node /opt/qcr/dist/src/wire.js; /usr/local/bin/node /opt/qcr/dist/src/loginrefresh/main.js; flock -n -E 75 /home/qcr/.pi/agent/auth.json.lock sh -c echo locked; exec cat;`
- **worker run**: `rc=0; 15 passed, 0 failed; first_worker {"command_id":"2c45a601-71db-4511-9958-c088a7b77329","mode":"round","generation":1,"pid":301} permits_status {"ceiling": 20, "stagger_ms": 250, "in_use": 14, "queued": 0, "commands": [{"command_id": "2c45a601-71db-4511-9958-c088a7b77329", "in_use": 14, "queued": 0}]} burst passes=24 peak_in_flight=20 span_first20_ms=4761 median_gap_first20_ms=250 start_of_21st_after_first_ms=6015  `
- **ssh commands**: `101 commands crossed the throwaway sshd`

## Findings

Everything the rehearsal found on the way to a green run, and whether it is fixed. F1 to F3, F5 and F5b were
defects in the cutover tooling itself and are fixed in product code with tests; F4 was a contradiction in the
cutover procedure, fixed by the owner's ruling of 2026-10-21; the rest are properties worth knowing.

- **F1, product, FIXED: `deploy.sh` ignored `QCR_CUTOVER_ACK`.** The runbook (C.11, C.12) and the wizard
  (`QCR_CUTOVER_ACK=<v> deploy.sh [--dry-run] release <v>`) spell the acknowledgement as an environment
  variable; `deploy.sh` read only the `--cutover-ack` flag, so on the legacy layout both the wizard's plan
  and its release stopped at "refusing the release — the VM still runs the legacy layout … Re-run with
  --cutover-ack". The first rehearsal run died there. `deploy.sh` now takes `QCR_CUTOVER_ACK=<version>` as
  the same acknowledgement, and an ack naming another version is refused (a stale one must not authorize
  this cutover). `tests/deploy.test.ts`.
- **F2, product, FIXED: the plan did not name the point of no return.** Runbook C.11 asks that the
  dry-run plan shows "the recreate of quickreview-sandbox, named as the point of no return", and the wizard's
  stage 3 asks the owner to confirm it does. The plan said "recreate the daemon container" only. It now says
  "THE POINT OF NO RETURN on the legacy layout (the first boot migrates state.db forward; there is no way
  back to tmux or processes)". `tests/deploy.test.ts`.
- **F3, product, FIXED: the wizard's reconcile-backstop stage compared GitHub with nothing.** Stage 7 read
  the daemon's tracked PRs from `qcr status` run on the OWNER'S machine, which reads that machine's own
  state dir ("no status.json yet"): no PR line, so every open PR was "not tracked" and the stage passed
  vacuously, which is exactly the check runbook C.15 exists for. It now reads `qcr status` in the daemon's
  container (`docker exec … node /opt/qcr/dist/src/cli.js status`) and fails when that prints no snapshot.
  `tests/cutover-wizard.test.ts`.
- **F4, procedure, FIXED (owner ruling 2026-10-21): stage 9 could not do what it asked.** Stage 9 said the
  drain holds while the owner triggers ONE worker round and checks it, then lifts. Under any drain the dispatch
  pump starts nothing (`dispatch.ts`: `if (store.drainState().draining) return []`), the webhook delivery is
  dropped, and `qcr debug-round` is refused outright ("debug-round #7 refused (drained: the bot is draining: no
  worker starts)"); HOLD-3 records all three. So the first worker round can only be watched AFTER `qcr drain
  off`. In this rehearsal the lift was therefore the owner's command at the point stage 9 reaches it, and the
  worker checks ran after it. The owner ruled: nothing runs under any drain, so the first round is watched after
  the lift, one PR at a time. Stage 9 now lists the tracked open PRs from the daemon's `qcr status` in its
  container, asks which PR runs first, pauses every other tracked PR with the operator's pause (`qcr pause-pr`,
  new: the sealed operator channel, so the pause carries no expiry and no session lifts it), checks each shows
  as the operator's, lifts the drain on the owner's go, says how to trigger the chosen PR's round (a queued PR
  starts at the lift; otherwise a re-request or the trigger label), and asks whether that round is good. On yes
  it resumes (`qcr resume-pr`, new) exactly the PRs it paused; on no they stay paused and it stops. Every pause,
  the lift and every resume is recorded in the wizard's state file, so a resumed run never pauses twice and
  touches only what it paused. `tests/cutover-wizard.test.ts`, `tests/prpause.test.ts`.
- **F5, product, FIXED: the wizard called a failure after the recreate "rescued".** When `deploy.sh
  release` fails in its post-deploy checks (after the updater's recreate), stage 4 still printed "A failure
  before the recreate was RESCUED by the updater: the legacy bot is back". It now asks the VM for its layout:
  `release` means the failure came after the point of no return and says to fix forward under the drain.
  `tests/cutover-wizard.test.ts`.
- **F5b, product, FIXED: `qcr drain` named the legacy directory after the cutover.** The command was
  written to the right place (the sender resolves the container's layout label first), but the line printed
  before it, `drain off → host:/opt/quickreview/sandbox/commands/`, used the unresolved root, so the owner
  who lifts the hold at stage 9 was told the legacy path. `qcr drain`, `qcr lessons` and `qcr archive` now
  resolve the layout before they say where they write. `tests/drain.test.ts`.
- **F6, property: a rescued legacy bot is undrained for a few seconds.** Every injected failure after the
  stop restarts the legacy bot, whose first healthy reconcile lifts the drain; the updater re-sends `drain
  on` only after it sees that reconcile. INJ-2 to INJ-4 show the lift and the re-drain in the legacy bot's
  log, a few seconds apart (about 5 s here, on a stand-in that has no work to dispatch). On the real legacy
  bot the dispatch pump may start held `pending_wakes` rounds in that window, which the updater says in its
  output ("rounds may be running"); a retry needs running_rounds 0 again. Not changed.
- **F7, property: a failed sidecar start leaves the seed done.** INJ-4 fails after the store copy and the
  config swap; the rescue undoes the swap (the failed config stays as `config-home.failed`) but not the
  seed marker, so the retry logs "sidecar store already seeded" and does not copy again. That is by design
  (the copy is verified once and the daemon's own store is never touched); a retry after a *failed copy*
  (INJ-3) leaves no marker and copies again.
- **F8, property: the release container keeps a tmux server and one empty `main` shell session.** The
  daemon-mode entrypoint starts it (the jump-in surface, and the host of the takeover and debug panes).
  No PR session, no pi and no overseer exists, which is what runbook step 13 asks. The P8.20a TREE-1 check
  expected the overseer's `main` session and a pi; it now expects the shell only, and P9.13's deletion is
  what it proves. The event name `overseer_heartbeat` (the daily heartbeat's marker in `events`) outlived
  the overseer; it is a name, not a process.
- **F9, rehearsal: what the unprivileged host needed.** The updater is run in the test mode its header
  documents (non-root). Four things a root updater does had to be stood in for, all in `vm-shims/`, none in
  product code: the root-sealed operator command directory is opened to the user for the length of a run
  and sealed again after it; the sidecar is started as the user that owns its store (root would chown it);
  the daemon container takes the stub's CA through `--env-file` (the run spec has no seam for extra
  environment); `sudo` runs the command as the user. The sidecar's OpenViking home is the host path
  (config.toml names it), because the unprivileged host cannot create `/opt/quickreview`.

## Limits

- **No KVM guest.** This machine has no qemu; the "VM" is a directory tree on this machine's docker,
  reached over a throwaway unprivileged sshd on localhost (a forced command, `vm-shell.sh`, that maps the
  host path `/opt/quickreview` onto the rehearsal's directory for host-side commands and leaves
  `docker exec` commands alone). Nothing about a real VM's packages, systemd, cloudflared or a root
  `qcr-update` was exercised: root-only branches of the updater (chown of the staged config, the root-owned
  run spec check, the root `chown` of the operator dir) did not run. `deploy.sh provision` ran for real up
  to the playbook, which is a stub that installs the run spec the script rendered.
- **The legacy bot is a stand-in** (`legacy-daemon.mjs`): the legacy build's own StateStore and its drain
  contract (heartbeat, operator channel, the first-reconcile lift, the strict command schema), not the legacy
  daemon. The first-boot migration, the hold and everything after it ran on the real release image over a
  state.db the legacy build (8169df6f) wrote.
- **The registry is `registry:2` on localhost**, the images single-arch; the manifests are in the P7.16
  format but a real release's index is multi-arch. No ghcr login, attestation or CI is involved.
- **The model, GitHub and OAuth are the P8.20a stub**; `dry_run = true` throughout, so a post ends in
  `state/dryrun`. The worker checks are the P8.20a scenarios, unchanged apart from TREE-1.
- **The owner's real config differs** in repo, profile, App identity and secrets; the shape that matters to
  the cutover (remote openviking endpoint, `lens_permits = 20`, the `[tui]` block with an ssh target and no
  `remote_*` keys) is the one rehearsed.
