## Findings

Everything the rehearsal found on the way to a green run, and whether it is fixed. F1 to F3, F5 and F5b were
defects in the cutover tooling itself and are fixed in product code with tests; F4 was a contradiction in the
cutover procedure, since fixed in the procedure; the rest are properties worth knowing.

- **F1, product, FIXED: `deploy.sh` ignored `QCR_CUTOVER_ACK`.** The cutover procedure and the wizard
  (`QCR_CUTOVER_ACK=<v> deploy.sh [--dry-run] release <v>`) spell the acknowledgement as an environment
  variable; `deploy.sh` read only the `--cutover-ack` flag, so on the legacy layout both the wizard's plan
  and its release stopped at "refusing the release — the VM still runs the legacy layout … Re-run with
  --cutover-ack". The first rehearsal run died there. `deploy.sh` now takes `QCR_CUTOVER_ACK=<version>` as
  the same acknowledgement, and an ack naming another version is refused (a stale one must not authorize
  this cutover). `tests/deploy.test.ts`.
- **F2, product, FIXED: the plan did not name the point of no return.** The cutover procedure asks that the
  dry-run plan shows "the recreate of quickreview-sandbox, named as the point of no return", and the wizard's
  stage 3 asks the owner to confirm it does. The plan said "recreate the daemon container" only. It now says
  "THE POINT OF NO RETURN on the legacy layout (the first boot migrates state.db forward; there is no way
  back to tmux or processes)". `tests/deploy.test.ts`.
- **F3, product, FIXED: the wizard's reconcile-backstop stage compared GitHub with nothing.** Stage 7 read
  the daemon's tracked PRs from `qcr status` run on the OWNER'S machine, which reads that machine's own
  state dir ("no status.json yet"): no PR line, so every open PR was "not tracked" and the stage passed
  vacuously, which is exactly the check the backstop stage exists for. It now reads `qcr status` in the daemon's
  container (`docker exec … node /opt/qcr/dist/src/cli.js status`) and fails when that prints no snapshot.
  `tests/cutover-wizard.test.ts`.
- **F4, procedure, FIXED: stage 9 could not do what it asked.** Stage 9 said the
  drain holds while the owner triggers ONE worker round and checks it, then lifts. Under any drain the dispatch
  pump starts nothing (`dispatch.ts`: `if (store.drainState().draining) return []`), the webhook delivery is
  dropped, and `qcr debug-round` is refused outright ("debug-round #7 refused (drained: the bot is draining: no
  worker starts)"); HOLD-3 records all three. So the first worker round can only be watched AFTER `qcr drain
  off`. In this rehearsal the lift was therefore the owner's command at the point stage 9 reaches it, and the
  worker checks ran after it. The procedure now says: nothing runs under any drain, so the first round is watched after
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
  No PR session, no pi and no overseer exists, which is what the cutover procedure asks. The worker rehearsal's TREE-1
  check expected the overseer's `main` session and a pi; it now expects the shell only, which is what the
  overseer's deletion proves. The event name `overseer_heartbeat` (the daily heartbeat's marker in `events`) outlived
  the overseer; it is a name, not a process.
- **F9, rehearsal: what the unprivileged host needed.** The updater is run in the test mode its header
  documents (non-root). Four things a root updater does had to be stood in for, all in `vm-shims/`, none in
  product code: the root-sealed operator command directory is opened to the user for the length of a run
  and sealed again after it; the sidecar is started as the user that owns its store (root would chown it);
  the daemon container takes the stub's CA through `--env-file` (the run spec has no seam for extra
  environment); `sudo` runs the command as the user. The sidecar's OpenViking home is the host path
  (config.toml names it), because the unprivileged host cannot create `/opt/quickreview`.

## Limits

- **No KVM guest.** The rehearsal host has no qemu; the "VM" is a directory tree on the host's docker,
  reached over a throwaway unprivileged sshd on localhost (a forced command, `vm-shell.sh`, that maps the
  host path `/opt/quickreview` onto the rehearsal's directory for host-side commands and leaves
  `docker exec` commands alone). Nothing about a real VM's packages, systemd, cloudflared or a root
  `qcr-update` was exercised: root-only branches of the updater (chown of the staged config, the root-owned
  run spec check, the root `chown` of the operator dir) did not run. `deploy.sh provision` ran for real up
  to the playbook, which is a stub that installs the run spec the script rendered.
- **The legacy bot is a stand-in** (`legacy-daemon.mjs`): the legacy build's own StateStore and its drain
  contract (heartbeat, operator channel, the first-reconcile lift, the strict command schema), not the legacy
  daemon. The first-boot migration, the hold and everything after it ran on the real release image over a
  state.db the legacy build wrote.
- **The registry is `registry:2` on localhost**, the images single-arch; the manifests are in the
  deploy-manifest format but a real release's index is multi-arch. No ghcr login, attestation or CI is involved.
- **The model, GitHub and OAuth are the worker rehearsal's stub**; `dry_run = true` throughout, so a post ends in
  `state/dryrun`. The worker checks are the worker rehearsal's scenarios, unchanged apart from TREE-1.
