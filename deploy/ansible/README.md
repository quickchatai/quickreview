# Review-sandbox provisioning (Ansible) — the VM/server route

Minimal, idempotent provisioning for the review sandbox: **one VM → the release
image in `daemon` mode** (`ghcr.io/quickchatai/quickreview`: the compiled app,
pinned pi, tmux, the seeds and the reviewer stub, all baked under `/opt/qcr`),
**beside the memory sidecar** (`ghcr.io/quickchatai/quickreview-memory`),
optionally with **cloudflared on the host** forwarding a public
hostname → `localhost:8787` → the container. The image either comes from the
registry (`deploy.sh release <version>`) or is built on the VM from the rsynced
checkout (`deploy.sh sync`, the dev build).

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
`scripts/deploy.sh` release/sync/rebuild/verify workflow on top of the same image.

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
   (`deploy.sh rebuild` passes the install locator's answer as `secrets_src`;
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
   `scripts/deploy.sh` preflight refuse on drift. `sandbox_src` defaults to
   the repo this playbook lives in — override with
   `-e sandbox_src=/path/to/checkout` for a different working copy.

## Run

Through `scripts/deploy.sh`, which checks the pins and drift first:

```
scripts/deploy.sh release 0.1.0   # pull the published images, recreate the containers
scripts/deploy.sh sync            # the dev build: rsync this checkout, build docker/Dockerfile on the VM
scripts/deploy.sh rebuild         # the dev build over the whole playbook, base images refreshed
scripts/deploy.sh --dry-run <any of them>   # the plan, nothing executed
```

or the playbook by hand:

```
ansible-playbook -i inventory.ini playbook.yml -e image_source=dev -e build_sha=<commit> \
  -e base_clone_dir=<clone dir> -e sandbox_src=<checkout> \
  -e config_home_src=<config home> -e config_file_name=config.toml
ansible-playbook -i inventory.ini playbook.yml --start-at-task "Image source and version" \
  -e image_source=release -e release_version=0.1.0 -e base_clone_dir=<clone dir> \
  -e config_home_src=<config home> -e config_file_name=config.toml
# refresh the base images after bumping pins: the dev run, plus -e rebuild_image=true
```

`image_source` says where the daemon image comes from. `release` pulls
`release_image:release_version` and the memory image of the same version; there
is no `latest` tag, so a version is always named, and the playbook refuses an
image without a CI `qcr.build-sha` label. `dev` builds `docker/Dockerfile` on
the VM from the rsynced tree (BuildKit, the docker layer cache; the pins reach
it as build args from `group_vars/all.yml`) and tags it `quickreview-sandbox:dev`,
stamped with `build_sha`. Either way the container is the one named
`quickreview-sandbox`, run as `container_uid`, with the command `daemon`.

`base_clone_dir` is mandatory: it is the reviewed repo's base-clone directory
under the sandbox root (`[github] clone_dir`, else the repo's basename). A dev
run keeps it out of the rsync `--delete` by that name, and every run mounts it
into the container. `scripts/deploy.sh` derives and passes it for you.

`config_home_src` and `config_file_name` are mandatory too: the
install's config home on the controller — the directory holding the live
config (`~/.config/qcr/<install>/`, or the one `$QCR_CONFIG` names) — and the
config's file name there. The playbook ships exactly that file and the
`profiles/` beside it (never the home's `secrets/`) to
`/opt/quickreview/config-home/`, mounted read-only into the container, whose
`QCR_CONFIG` names the shipped file. It runs in every mode but `verify`, so a
profile change reaches the VM without a rebuild; `deploy.sh` passes both, and
refuses a config that lives only in the checkout or a `[review] profile` the
home (or the checkout's generic examples) does not hold.

What it does, in order: host packages + Docker → (when `cloudflared_enabled`)
cloudflared apt repo, install, service registration with the tunnel token →
directory layout under `/opt/quickreview/` → secrets copied `0600` → *(from here
on, what `release` and `sync` run)* the image source check → the images (pull,
or rsync of the `sandbox_src` working copy and the VM-side build) → the image's
build-stamp label → the config home → the runtime directories → the memory
sidecar → the daemon container
(`restart: unless-stopped`, port bound to **127.0.0.1 only**).

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

The TUI's `[tui] remote_sandbox_root` must be `/opt/qcr` (the container's app
root; `remote_state_dir` stays the host path): `deploy.sh` refuses to ship a
config that says otherwise.

### Pulling the release

The images are private. The VM pulls them with ONE credential: your own CLASSIC
personal access token, scoped `read:packages` and nothing else, stored by
`docker login` in root's docker config on the VM host (never in a container,
env, argv or the secrets directory; CLAUDE.md rule 3). Not the token `gh auth
token` prints: that one carries the full scopes of your gh login.

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

`scripts/deploy.sh release <version>` runs the same manifest check first (also
under `--dry-run`) and refuses, with nothing changed, when the VM cannot read
either image. `scripts/deploy.sh verify` warns 14 days before the recorded
expiry. `ssh <vm> sudo docker logout ghcr.io` removes the login.

### The cutover (legacy image to release image)

The first `release`, `sync` or `rebuild` against a VM still running the legacy
image (`quickreview-sandbox:v1`, the Ubuntu image the retired `Dockerfile.j2`
built) swaps the image and the container shape in one restart. A release bakes
the code, `node_modules` (pi), the retyped extensions and the Phase 3 factory
shims, so none of those may reach the VM for the first time inside it. They go
out first, on their own deploys, and `deploy.sh` refuses the cutover until you
name the commits that landed them and each is an ancestor of what the VM runs:

```
QCR_CUTOVER_REQUIRES="<P1.8 commit> <P2.12 commit> <P3.5 commit>" scripts/deploy.sh --dry-run release 0.1.0
QCR_CUTOVER_REQUIRES="…" scripts/deploy.sh release 0.1.0
```

Drain first (`qcr drain on`, wait for `running_rounds` 0). After the deploy,
`deploy.sh verify` shows the image and its build stamp, that pi's
`settings.json` lists bash-guard, and that `AGENTS.override.md` in the app root
is the 12-line reviewer stub.

### Rollback

Two things are left on the VM and nothing is deleted: the legacy image
`quickreview-sandbox:v1` (this playbook never removes an image) and every host
directory the new container used (state, pihome, the sandbox tree with its
runtime directories, the memory sidecar's store).

- **Back to a previous release**: `scripts/deploy.sh release <previous version>`.
  The same containers, the same directories.
- **Back to the legacy image**: check out the commit *before* the release-image
  cutover merged (its `deploy/ansible/templates/` is the legacy build context and
  its playbook the legacy container shape), set `[tui] remote_sandbox_root` in
  the config home back to `/opt/quickreview/sandbox`, and run that commit's
  `scripts/deploy.sh sync`. Its stale-image guard compares the `v1` image's
  stamp with its own templates, which are the ones that built it, so nothing is
  rebuilt: the container is recreated on `quickreview-sandbox:v1` with the old
  single mount of `/opt/quickreview/sandbox`, and the rsync puts the old tree
  back. Record that commit's SHA in the cutover notes before you start. Memory
  stays on the sidecar (`openviking_endpoint: remote` is also the legacy
  playbook's value), so this rollback does not touch it; moving memory back into
  the daemon container is the sidecar's own rollback (the deploying skill).
  pi's `settings.json` on the pihome volume names the bash-guard of the app root
  it last booted under; the legacy entrypoint prunes a path that is not on disk
  and registers its own on boot.

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
rebuilds — required for the sticky per-PR conversations, not just for auth.

## Notes

- Re-runs are safe: package installs are idempotent, the cloudflared service
  task is guarded by `creates:`, secrets/seed copies only rewrite on change,
  the container recreates only when the image or config changed.
- The webhook port is published on loopback only; ingress is whatever HTTPS
  proxy/tunnel you point at it (the optional cloudflared service, or your
  own). No inbound firewall rule is ever needed.
- Image pins: pi and node are pinned in `group_vars/all.yml` (and are the
  Dockerfile's ARG defaults, which tests hold equal); a published release carries
  its own, a dev build gets them as build args. Bumping them is a deliberate edit
  + a new release, or `rebuild_image=true` for a dev build, never automatic.
- Jump-in from your own machine: `ssh -t <vm> docker exec -it quickreview-sandbox
  tmux attach -t <pr-N|overseer>` — `scripts/qcr attach <n>` prints that
  command (it never attaches itself), and the operator TUI (`scripts/qcr tui`, with `[tui] target = "ssh"`) embeds the same
  session in a pane.
