# Review-sandbox provisioning (Ansible) — the VM/server route

Minimal, idempotent provisioning for the review sandbox: **one VM → the release
image in `daemon` mode** (`ghcr.io/quickchatai/quickreview`: the compiled app,
pinned pi, tmux, the seeds and the reviewer stub, all baked under `/opt/qcr`),
**beside the memory sidecar** (`ghcr.io/quickchatai/quickreview-memory`),
optionally with **cloudflared on the host** forwarding a public
hostname → `localhost:8787` → the container. The images are built ONCE, by CI,
from the release tag; the VM pulls those exact images by digest. **Nothing is
rsynced, built or installed on the VM by a deploy.** The host is provisioned
once (`deploy.sh provision`, this playbook), which installs a thin updater,
`qcr-update`, and its run spec; every deploy after that is
`deploy.sh release <version>`, which runs `ssh vm sudo qcr-update ...`.

> **`qcr onboard` drives this route for you.** The wizard's
> **topology** step offers it as one of two first-class answers — advertised as
> the always-on recommendation, because a reviewer that is asleep reviews
> nothing — then checks your ssh alias and agent *before* anything is built
> (the passphrase trap, in the open), fills `inventory.ini` from your answers,
> and runs the **same `scripts/deploy.sh` documented below**, with every one of
> its preflights. It composes this path; it does not replace it, and drift
> between the two is a bug. Everything here stays true for a manual run.
> The step-by-step walkthrough is
> [../../docs/onboarding.md](../../docs/onboarding.md).

**Prefer one machine?** The other first-class answer is the plain Docker path:
`docker compose up` on the released images — see `docker/daemon/README.md`. It
needs no server at all, and it reviews only while that machine is awake. This
Ansible route adds VM host setup, the optional tunnel, and the
`scripts/deploy.sh` provision/release/verify workflow on top of the same image.

**Ingress is a choice, not a requirement**: any HTTPS proxy or tunnel that
forwards your webhook hostname to the published port works. The cloudflared
tasks are gated on `cloudflared_enabled` (group_vars, default `true` — the
live deployment keeps its tunnel); set `-e cloudflared_enabled=false` to
bring your own ingress.

Running the whole sandbox inside one container is the isolation answer to pi
having no built-in permission system.

## Prerequisites (once, manual)

Items 2–4 are what `qcr onboard` fills in for you on this route; item 1 is
yours either way — the wizard never creates a machine.

1. **A VM you can reach over ssh by an alias**, with passwordless sudo for your
   login. Any Linux host will do; the playbook installs everything else. The
   live deployment runs a 4-vCPU / 100 GB box with no external IP, reached
   through a bastion — that shape is a comfortable default, not a requirement.
   The container is capped at 2 CPU / 8 GiB.
2. **Ingress**: either a Cloudflare tunnel (remote-managed tunnel, public
   hostname → `http://localhost:8787`; its **token** saved as
   `tunnel_token` in the local secrets dir (item 3) — required only with
   `cloudflared_enabled: true`), or your own HTTPS proxy/tunnel pointed at
   the VM's `localhost:8787` (then set `cloudflared_enabled: false`). The
   wizard's ingress step writes that flag into `inventory.ini` for you: `true`
   for the named-tunnel shape, `false` for every other one.
3. **Local secrets dir** — the install's `~/.config/qcr/<install>/secrets/`
   (`deploy.sh provision` passes the install locator's answer as `secrets_src`;
   an old `~/.config/quickreview-bot/` is never read — `qcr install migrate`
   moves it) contains:
   `app_id`, `app.pem`, `webhook_secret` (plus `openai_api_key` optional —
   pi's API-key route — and `tunnel_token` when the tunnel is enabled), and
   `openviking_root_key` / `openviking_reviewer_key` for the memory engine.
   Memory embeds locally by default (nothing but the model call leaves the
   VM); `openai_embeddings_api_key` exists only under the hosted-embeddings
   opt-in, written as inventory host vars beside `cloudflared_enabled`
   ([docs/memory-embeddings.md](../../docs/memory-embeddings.md)).
   `bash deploy/collect-secrets.sh` assembles the first set interactively; the
   wizard's GitHub App and memory steps write the same files.
   (Never any personal token.)
4. Controller tooling **on the machine you deploy from** — the deploy is an
   Ansible run from here, not on the server:
   ```
   ansible-galaxy collection install community.docker ansible.posix
   cp inventory.example.ini inventory.ini   # then edit — inventory.ini is
                                            # gitignored (your real hostnames
                                            # stay local; the example documents
                                            # what to fill)
   ```
5. Pins ride `group_vars/all.yml` (pi, OpenViking, llama-cpp-python, …),
   mirrored with `config.toml`; `tests/openviking.test.ts` and the
   `scripts/deploy.sh` preflight refuse on drift. There is no `sandbox_src`:
   nothing is synced from a working copy to the VM.

## Run

Through `scripts/deploy.sh`, which checks the pins and drift first:

```
scripts/deploy.sh provision                          # once per VM (and when the run spec changes): host, secrets, directories, the updater
scripts/deploy.sh release 0.1.0 --manifest deploy-manifest-0.1.0.json   # the deploy: ssh vm sudo qcr-update ...
scripts/deploy.sh verify                             # post-deploy checks over ssh
scripts/deploy.sh --dry-run <any of them>            # the plan, nothing executed
```

The old dev modes are gone: they refuse with a pointer to `release`. A fix
that cannot wait is a release too (a patch version); there is no working-copy
deploy.

**`provision`** runs this whole playbook (no tags): host packages + Docker →
(when `cloudflared_enabled`) cloudflared apt repo, install, service
registration with the tunnel token → directory layout under `/opt/quickreview/`
→ secrets copied `0400` → `/usr/local/sbin/qcr-update` (root `0755`, from
`deploy/qcr-update.sh`) and `/etc/qcr/update.conf` (root-owned, the run spec
`deploy.sh` renders from `group_vars` — container names, mounts, caps, CPU and
memory limits, networks, the sidecar's `openviking_*` env, a run-spec version
and a fingerprint) → the operator channel's seal → the runtime directories.
**It never pulls or starts an image.** Required vars (`deploy.sh` passes them):
`base_clone_dir` (the reviewed repo's base-clone directory, `[github]
clone_dir`, else the repo's basename), `secrets_src`, `update_conf_src`, and the
Slack token file names.

**`release`** reads CI's deploy manifest (`deploy/manifest.schema.json`: the
version, the revision, both images' index digests and per-arch digests, and the
pins they were built with), holds those pins to `config.toml` and `group_vars`
(rule 7 stays: pi, openviking, llama-cpp-python and the embedder file/sha256
must agree), refuses a run-spec fingerprint the VM does not hold ("re-run
provision"), and then sends the install's config home — `config.toml` and
`profiles/`, never `secrets/` — as a tar to
`ssh vm sudo qcr-update <version>@<digest> --memory-digest <digest>`.
`scripts/deploy.sh` refuses a config that lives only in the checkout or a
`[review] profile` the home (or the checkout's generic examples) does not hold.

### The updater (`qcr-update`)

In order (the header of `deploy/qcr-update.sh` is the contract): flock; refuse
unless the board is drained and idle (`draining=true`, `running_rounds=0`);
on the legacy layout refuse without `--cutover-ack <version>`; pull both images
by digest and check them (`qcr.layout`, a CI `qcr.build-sha`, `qcr.preflight`,
`qcr.runspec` no newer than `update.conf`'s); stage the config and run the NEW
image's `qcr config check --json` on it (a failure here changes nothing); stop
the daemon; snapshot `state.db` (+wal/shm) and a tar of `state/pi-sessions` into
`/var/backups/qcr/<version>-<ts>/` (root, `0600`; pihome is never included);
run the new image's `daemon --preflight` on a scratch copy of the snapshot with
`--network none`; on the legacy layout seed the sidecar store once (copy plus
checksum verify; the daemon's old store is untouched); swap the config
(`config-home` → `.prev`, `.next` → `config-home`); start the memory sidecar and
wait for `/ready` (a long timeout: a re-embed is a boot); recreate the daemon
container on the new image. At the cutover the recreate is the point of no
return: the first boot migrates forward.

**Rescue.** Any failure from the stop to the recreate restores `.prev`, removes
the newly started sidecar (the old one is put back), starts the old daemon
container, waits for its first reconcile in `status.json` (a healthy legacy
boot lifts the drain), re-sends `drain on` through the operator channel,
confirms `draining=true` and exits non-zero naming the step. Between the
auto-lift and the re-sent drain the dispatch pump may already have started held
`pending_wakes` rounds: the bot is left drained but rounds may be running, so a
retry waits for `running_rounds` 0. A failure after the recreate keeps the drain
on (a failed first reconcile never lifts it) and is fixed forward.

`sudo qcr-update status --json` reports the layout, the images' labels, the
run-spec version and fingerprint, the drain state and the last run.

### What is inside the container

The release image's app root is `/opt/qcr`, root-owned and read-only to the
container user. Everything the daemon writes lives in a host directory under
`/opt/quickreview/`, the same ones the legacy container mounted, bind-mounted
back in: `state/` → `/opt/qcr/state`, `pihome/` → `/home/qcr/.pi`, `secrets/`
and `config-home/` read-only at `/opt/quickreview/`, and `sandbox/{wt,archive,
commands,digest,inject,verdict,<clone>}` → `/opt/qcr/<name>`. The worktree
directory and the base clone are mounted a second time at their old path
(`/opt/quickreview/sandbox/…`), so the absolute paths git and pi recorded before
the cutover still resolve. `commands/operator` stays root-owned on the host and
is re-sealed on every run.

The TUI finds the container's app root by itself: it reads the running
container's `qcr.layout` label (`release` = `/opt/qcr`, no label = the legacy
`/opt/quickreview/sandbox`) and reads it again whenever the container id changes,
so the cutover needs no TUI key edited (`src/tui/layout.ts`). An explicit
`[tui] remote_sandbox_root` still wins; `deploy.sh` warns, and does not refuse,
when one names another root. `remote_state_dir` stays the host path.

### Pulling the release

The images are private and are pulled BY the updater, on the VM, by digest. The VM pulls them with ONE credential: your own CLASSIC
personal access token, scoped `read:packages` and nothing else, stored by
`docker login` in root's docker config on the VM host (never in a container,
env, argv or the secrets directory; CLAUDE.md rule 3). Not the token `gh auth
token` prints: that one carries the full scopes of your gh login.

A deploy needs this login to exist before the first `release` (the pull is the
updater's first step, and a lapsed login fails there with nothing changed).

Once per VM, and again when the token is renewed (it expires after one year):

1. On github.com, Settings, Developer settings, Personal access tokens, Tokens
   (classic): a new token, expiration one year, the single scope
   `read:packages`.
2. Once a version is published, on the controller:

```
scripts/vm-ghcr-login.sh --version <published X.Y.Z>        # paste the token, then Ctrl-D
scripts/vm-ghcr-login.sh --version <X.Y.Z> --token-file <0600 file>
```

The script refuses a token unless GitHub reports its scopes as exactly
`read:packages` and it has an expiry, runs `ssh <vm> sudo docker login ghcr.io
-u <you> --password-stdin`, checks the login with `docker manifest inspect` of
both images at that version, and records the expiry on the controller. It is
idempotent, and the token is never an argument or an environment variable.

A lapsed login fails the updater's pull before anything on the VM changes
(`qcr-update` refuses at its `pull` step). `scripts/deploy.sh verify` and
`release` warn 14 days before the recorded expiry. `ssh <vm> sudo docker logout ghcr.io` removes the login.

### The cutover (legacy image to release image)

The first `release` against a VM still running the legacy image
(`quickreview-sandbox:v1`, the Ubuntu image the retired `Dockerfile.j2` built)
swaps the image and the container shape in one restart, and the first boot
migrates forward. It needs the deliberate `--cutover-ack`, which `deploy.sh`
hands the updater as `--cutover-ack <version>`; without it both refuse, with
nothing changed. **Until the cutover the legacy VM takes no deploy**: if something urgent comes
up, drain and wait for the cutover window. Run `provision` first (it installs
the updater beside the legacy container and touches no image), then:

```
qcr drain on                      # wait for running_rounds 0
scripts/deploy.sh --dry-run release 0.1.0 --manifest deploy-manifest-0.1.0.json --cutover-ack
scripts/deploy.sh release 0.1.0 --manifest deploy-manifest-0.1.0.json --cutover-ack
```

The drain stays on until the new boot's first healthy reconcile lifts it. After
the deploy, `deploy.sh verify` shows the image and its build stamp, that pi's
`settings.json` lists bash-guard, and that `AGENTS.override.md` in the app root
is the 12-line reviewer stub.

### Rollback

There is no rollback across a migration. The first boot of a release migrates
`state.db` forward, and an older image run over the newer schema is not a
supported state. Going back is therefore a **forward fix**: cut a new release
(a patch version) that contains the fix or the revert, and `deploy.sh release`
it. Nothing is hand-edited on the VM.

What the updater does for you:

- **Before the recreate** (config check, stop, snapshot, preflight, sidecar
  seed, config swap, sidecar `/ready`): any failure is a **rescue**. The
  updater restores `config-home.prev`, puts the old containers back (they were
  renamed to `<name>-prev`), waits for the old daemon's first reconcile,
  re-sends `drain on` and exits non-zero naming the step. Nothing was migrated,
  so the bot is exactly as it was, drained. Fix the cause and run the same
  release again once `running_rounds` is 0.
- **After the recreate** the new boot has migrated state: no rescue. The drain
  stays on until a first reconcile passes healthily; fix forward with a new
  release.
- **The snapshot** of every run is `/var/backups/qcr/<version>-<ts>/` on the VM
  (root, `0600`): `state.db` with its `-wal`/`-shm`, and a tar of
  `state/pi-sessions`. It is the evidence and the manual restore point, not an
  automatic one; pihome is never in it. Keep it until the release has proven
  itself.
- **Left in place, never deleted by a deploy**: the legacy image
  `quickreview-sandbox:v1` (nothing here removes an image), the previous
  containers, and every host directory the container uses (state, pihome, the
  sandbox tree, the memory sidecar's store).

Redeploying a **previous** version is allowed only when no migration lies
between it and the running one; `qcr-update status --json` and the release
notes say whether one does. When in doubt, the answer is a forward fix.

## Verify

```
scripts/deploy.sh verify     # all of the below, plus the image stamp, settings.json and the stub
ssh <vm> systemctl is-active cloudflared docker
ssh <vm> docker ps --filter name=quickreview-sandbox
ssh <vm> docker exec quickreview-sandbox tmux ls
ssh <vm> curl -sS http://127.0.0.1:8787/health     # loopback-only by design
```

That is the same layering `qcr onboard`'s verification step runs — containers,
then the health endpoint, then GitHub's own webhook delivery log — and the
order matters: a container that is not up cannot answer a health probe, and a
daemon that is not answering cannot accept a delivery. While the tunnel is up
but the daemon is not, a GitHub test delivery returns a 502 *from cloudflared*
rather than timing out; that distinction is itself the proof the tunnel path
works.

## OpenAI auth for pi

Native in pi — nothing to install. Both routes and their
cost shapes are in [../../docs/llm-setup.md](../../docs/llm-setup.md); here is
what this route does with each:

- **API key (wired automatically)**: the daemon mode of the image's entrypoint
  exports `OPENAI_API_KEY` from the mounted `secrets/openai_api_key`, so the tmux
  server and every pi session inherit it. Works headless from the first boot.
- **ChatGPT-subscription OAuth (optional)**: run `/login` once inside any pi
  session in the container (`docker exec -it quickreview-sandbox pi` →
  `/login`); tokens land in `/home/qcr/.pi/agent/auth.json`, which lives on
  the persistent `pihome` volume, auto-refresh, and **take precedence** over
  the env-var key (pi's resolution order: CLI flag → auth.json → env var).
  Both routes can coexist. A login here does **not** cover a companion
  container on your own machine, or a pi you run on the host: pi's tokens do
  not transfer, so each pi home needs its own.

The `pihome` volume also persists pi's session JSONLs across container
recreates — required for the sticky per-PR conversations, not just for auth.

## Notes

- Re-runs are safe: package installs are idempotent, the cloudflared service
  task is guarded by `creates:`, secrets copies only rewrite on change. A
  release recreates the containers (the updater's job, not this playbook's).
- The webhook port is published on loopback only; ingress is whatever HTTPS
  proxy/tunnel you point at it (the optional cloudflared service, or your
  own). No inbound firewall rule is ever needed.
- Image pins: pi and node are pinned in `group_vars/all.yml` (and are the
  Dockerfile's ARG defaults, which tests hold equal); the images carry them as
  labels (`qcr.pi`, `qcr.openviking`, ...) and the release manifest copies them.
  Bumping them is a deliberate edit and a new release, never automatic.
- Jump-in from your own machine: `ssh -t <vm> docker exec -it quickreview-sandbox
  tmux attach -t <pr-N|overseer>` — `scripts/qcr attach <n>` prints that
  command (it never attaches itself), and the operator TUI (`scripts/qcr tui`, with `[tui] target = "ssh"`) embeds the same
  session in a pane.
