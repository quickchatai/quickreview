## Findings

Everything the rehearsal found on the way to a green run, and whether it is fixed. F1 to F3, F5 and F5b were
defects in the cutover tooling itself and are fixed in product code with tests; F4 is a contradiction in the
cutover procedure that needs the owner; the rest are properties worth knowing.

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
- **F4, procedure, OPEN (owner): stage 9 cannot do what it asks.** Stage 9 says the drain holds while the
  owner triggers ONE worker round and checks it, then lifts. Under any drain the dispatch pump starts
  nothing (`dispatch.ts`: `if (store.drainState().draining) return []`), the webhook delivery is dropped, and
  `qcr debug-round` is refused outright ("debug-round #7 refused (drained: the bot is draining: no worker
  starts)"); HOLD-3 records all three. So the first worker round can only be watched AFTER `qcr drain off`,
  and from that moment every triggered PR is reviewed. In this rehearsal the lift was therefore the owner's
  command at the point stage 9 reaches it, and the worker checks ran after it. The wizard is unchanged
  because the fix is a decision: either the owner accepts that the first round runs with the board open (and
  stage 9 says so), or the wizard pauses every tracked PR but the chosen one (`qcr pause-pr`) before the lift
  and resumes them after the check.
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
