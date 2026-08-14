# review sandbox

The `example-review[bot]` PR-review flow, moved off the laptop: a small Node
daemon (`quickreviewd`) that watches the repo's review triggers, runs one sticky
pi session per PR inside tmux, and posts reviews as the GitHub App. One VM, one
Docker container, cloudflared on the host.

**Status: dry run.** `config.toml` has `dry_run = true` and it stays that way
until the cutover. In dry run *every* GitHub mutation is written to
`state/dryrun/` as a JSON record instead of being executed — there is one gate
(`src/gate.ts`) and nothing bypasses it. Flipping to live is a manual act by
the owner (see [Cutover](#cutover)); no script here does it, and none ever should.

Design of record: `tracker/efforts/review-sandbox/spec.md` in issue-tracker
(§9 runtime, §10 cutover) plus the build briefs.

## Layout

```
src/            daemon, adapter, state, sessions, content wiring, CLI
  gate.ts       the single GitHub mutation gate (dry-run writes to state/dryrun/)
  github.ts     the adapter — reads direct, every write through the gate
  checklist.ts  qcr checklist — the automated cutover items
  compare.ts    qcr compare — the 5-PR old-flow vs sandbox evidence harness
prompts/ agents/  canonical content (never rewritten by code)
extensions/     the two pi extensions (inject-bridge, ledger-pin)
state/          state.db, status.json (heartbeat), dryrun/ records
inject/ verdict/ commands/ digest/ archive/ memory/   session I/O drop-boxes
wt/             per-PR git worktrees
scripts/        qcr, mint-token.sh, deploy.sh
```

## Run

```sh
npm ci
npm run build            # tsc
npm test                 # vitest, all I/O mocked
npm run daemon           # quickreviewd (webhook receiver + reconcile poll)
```

On the VM the daemon is not run by hand and there is no systemd unit for it:
it is the container entrypoint (`restart: unless-stopped`). The only host
service is `cloudflared`.

### `qcr` — the operator CLI

```sh
scripts/qcr status              # snapshot: tracked PRs, running rounds, spend
scripts/qcr today               # today's rounds + event log
scripts/qcr why <pr>            # one PR: rounds, archive, archived ledger
scripts/qcr spend               # spend totals
scripts/qcr attach <pr|session> # jump into the tmux session (pr-<n>, overseer)
scripts/qcr checklist           # the automated cutover items (below)
scripts/qcr compare <pr...>     # the 5-PR comparison reports (below)
```

`attach` on the VM is `docker exec -it quickreview-sandbox tmux attach -t <s>`.

### `qcr tui` — the live board

The operator TUI on your PC, polling the VM over ssh (read-only against
the VM except your own keystrokes in the embedded session and quick-message
inject files). Every knob is in `config.toml [tui]` (ssh host, container,
poll interval, message timeout).

```sh
scripts/qcr tui                 # board: live PR list, detail, events strip
scripts/qcr tui 5012            # deep link straight into PR 5012's pi session
scripts/qcr tui overseer        # deep link into the overseer session
scripts/qcr tui --help          # usage + troubleshooting
```

- **Board** (`1`): PR list with lifecycle glyphs (`▶` reviewing · `●` queued ·
  `⚑` escalated · `✎` awaiting author · `·` tracked · `↻` stale-recheck
  prefix), detail pane (`qcr why --json` over ssh), events strip
  (`qcr events --tail`), dry-run/heartbeat banner. `j/k` select, `w` full
  detail, `e` scroll events, `r` refresh, `?` key map.
- **Attach** (`⏎`, `o` overseer, `M` main): the pi session takes the whole
  terminal except one status row; every byte reaches tmux verbatim.
  **`Ctrl-q` detaches** — the single intercepted key; `Ctrl-q Ctrl-q` sends a
  literal one. ssh drop shows `✖ lost — ⏎ retry`.
- **Quick-message** (`m`): one-line box (`Alt-⏎` newline) → written verbatim
  as an inject file the daemon's bridge delivers; the events strip shows
  `→ pending…` then `✓ delivered` or `✖ undelivered` after the timeout —
  never silent.
- **Digest tab** (`2`): latest `digest/<date>.md` left (`[`/`]` page older,
  `j/k` scroll; pre-18:00 you see yesterday's, tagged), awaiting-you right,
  oldest first with age (`↓/↑` pick, `⏎`/`w`/`m` act).

Troubleshooting: `✖ unreachable` = ssh failed (check `ssh my-vm true`,
bastion/VPN, control socket); `▲ DATA STALE` = ssh fine but `status.json`
stopped moving (container down or daemon hung — `sudo docker ps` / `logs` on
the box); modified keys (Shift-⏎) dying in pi = the *outer* terminal or an
outer tmux without csi-u/extended-keys passthrough — use kitty/ghostty/
wezterm/iterm2, and the in-container tmux ships ≥3.5 with csi-u baked into
the image.

### Companion — the local pi that watches with you (C1–C3)

A second pi (`openai-codex/gpt-5.6-sol`) in a **local** Docker container on your
PC — not on the VM, not in the review loop. It reads an ambient feed the TUI
writes, the VM over ssh, and the issue tracker (rw, as actor `companion`);
it can raise alerts and message the overseer, and it never touches GitHub.
Knobs live in `config.toml [companion]`.

```sh
docker build -t qcr-companion --build-arg COMPANION_UID="$(id -u)" docker/companion
                                # once (tmux 3.5a + pinned pi; the uid arg is
                                # what lets it write the bind mounts)
scripts/qcr tui                 # starts/adopts the container, tab 3 (or `c`)
scripts/qcr companion up|down|status
scripts/qcr tui --no-companion  # board only: no container, feed, alerts or tab
```

- **One-time `/login`**: `docker exec -it qcr-companion tmux attach -t companion`
  and run `/login` (ChatGPT OAuth). Tokens persist on the `companion-pihome`
  volume, so this is done once, ever. Provider prefix is `openai-codex/`.
- **Companion tab** (`3` / `c`): the pi session embedded, same key rules as the
  board's attach (`Ctrl-q` detaches).
- **Alerts**: the companion writes `<alerts_dir>/<ts>-<slug>.json`; the TUI
  routes `notice` → status line, `alert` → status line + `notify-send` + an
  overseer inject. One notification per cause per `cooldown_min`, repeats fold
  into a counter, and the memory persists across TUI restarts within the day
  (Europe/Warsaw).
- **Daily rollover**: on the first `qcr tui` of a new Warsaw day the
  conversation is archived date-stamped on the volume, the session respawns
  fresh, and the first message it reads is the assembled opening context —
  yesterday's digest, a deterministic compacted summary of yesterday, the
  conversation tail, unresolved alerts, the live board snapshot and the alert
  knobs in force (`prompts/companion-day-open.md`). pi-memory carries over; the
  transcript does not.
- **Boundaries**: overseer *inject* is its only channel to the daemon, its
  commits are prefixed `[companion]`, and it never runs `deploy.sh`.

```sh
npm run e2e:companion           # throwaway container: alert routing, wake gate,
                                # rollover — needs docker, not pi auth
npm run smoke:companion         # the real companion checklist (up/adopt/down,
                                # login, ssh read, rollover on a faked date)
npm run smoke:companion -- --live   # ... and actually inject into the overseer
```

### Deploy

```sh
scripts/deploy.sh --dry-run     # print the plan, do nothing
scripts/deploy.sh sync          # rsync the working copy + recreate the container
scripts/deploy.sh rebuild       # ... and force the image rebuild (after a pin bump)
scripts/deploy.sh verify        # cloudflared / docker / container / heartbeat checks
```

Everything runs through the ansible
(`assets/ansible/`; override with `QC_ANSIBLE_DIR`, `QC_INVENTORY`,
`QC_VM_HOST`). Pre-flight refusals, all deliberate:

- **dirty working tree** — what runs on the VM must be a commit you can name;
- **pi version drift** — `config.toml [pi] version` must equal the ansible
  `pi_version`, and the `PIN-ME` placeholder is an error. The pin never floats
  and the script never bumps it; bumping is a hand edit plus `rebuild`;
- **`sandbox_src` still commented out** in group_vars — otherwise the rsync
  task silently no-ops and you deploy nothing.

`deploy.sh` never touches `dry_run`.

## Cutover

Nine checklist items. Seven are automated by `qcr checklist` — ① tunnel +
HMAC (a signed test delivery is accepted, a forged one rejected), ② the
reconcile queue equals a hand-run of the two trigger queries, ④ staleness
wake, ⑤ ping-pong reply, ⑦ EOD digest present with its headline in
`status.json`, ⑧ tmux attach (`overseer` + a `pr-*` session), ⑨ restart
recovery (fresh heartbeat + a clean adopt pass). Exit code 0 means every
automated item passed.

Items ③ and ⑥ — the two live test PRs — are **guided-manual**: they are the
only steps that run with `dry_run` off, `qcr checklist` prints the procedure
and never executes it.

`qcr compare <pr...>` assembles the evidence for five already-reviewed PRs:
per PR it runs one dry-run round, reads the would-be review out of
`state/dryrun/`, fetches the old flow's actual review (read-only), and writes
`reports/<pr>-compare.md` plus an index. Mechanical gates: (a) blocker parity,
(b) invariant scan (mutation kinds against the known allowlist, escalation
redundancy), (c) anchor validity via `src/anchors.ts`, (d) settled-thread
discipline. (e) tone/format is human judgment — both review bodies are
reproduced verbatim. **The harness assembles; the human judges.**

**The flip is the owner's manual act, in one sitting:** set `dry_run = false` →
confirm the reconcile poll owns the standard triggers (same label + team
request, no config change) → stop the laptop `/loop 2h /auto-review` for good
→ post the team announcement (`assets/announcement.md`) → watch the
first organic day from the overseer session. Nothing automates any of this.

## Fallback runbook

**The rule: never run the old laptop loop and the sandbox at the same time.**
Same identity, same triggers — concurrent runs double-post and fight over the
trigger labels. Stop one before starting the other.

If the sandbox is down — daemon dead for more than ~30 minutes, or the tunnel
unrecoverable — fall back to manual single-PR ticks from the laptop on the
`owner/pr-auto-review` branch (kept unmerged precisely as this fallback):

1. confirm the sandbox is actually stopped (`docker stop quickreview-sandbox`
   on the VM if it is half-alive);
2. for each triggered PR, run `/auto-review <n>` once, by hand, from the
   laptop — one PR per tick, no loop;
3. when the VM recovers, stop the manual ticks first, then bring the sandbox
   back and let the reconcile poll re-derive the queue (GitHub is the truth).

### Triage

| symptom | first look |
| --- | --- |
| deliveries fail at the edge / 5xx | `systemctl status cloudflared`, `journalctl -u cloudflared -n 50` (host, not container) |
| tunnel fine, no reviews | `docker ps`, `docker logs quickreview-sandbox --tail 100` |
| daemon alive but idle | `state/status.json` heartbeat age; `qcr status`, `qcr today` |
| sessions wedged | `docker exec -it quickreview-sandbox tmux ls`, then attach |
| GitHub 401s | re-mint: `scripts/mint-token.sh --refresh` (app PEM only — no personal credential is ever on the VM) |
| nothing posted at all | expected while `dry_run = true`: look in `state/dryrun/` |

`scripts/deploy.sh verify` runs the first four of those checks over ssh in one
go and prints this triage order on failure.

## House rules

- `dry_run` stays true until the cutover; the flip is manual, never scripted.
- There is **no review-dismissal code path** anywhere, by construction: no such
  mutation kind exists in the gate, and `qcr compare`'s invariant scan is an
  allowlist check that flags any record outside the known kinds.
- Reads may hit GitHub freely; every write goes through the gate.
- Only the app credential (`~/.config/quickreview-bot/`) — never a personal one.
- The only branches this flow ever pushes are `bot/improve-*` and `rubric/*`.
  Never `master`/`main`.
