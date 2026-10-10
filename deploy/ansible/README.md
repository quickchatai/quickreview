# Review-sandbox provisioning (Ansible) — the VM/server route

Minimal, idempotent provisioning for the review sandbox: **one VM → one Docker
container** (plain Ubuntu + pinned pi + node/gh/tmux + secrets; the prompts
and agents ride the repo rsync — there is no separate seed source),
optionally with **cloudflared on the host** forwarding a public
hostname → `localhost:8787` → the container.

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
`docker compose up` from the repo root — see `docker/daemon/README.md`. It
needs no server at all, and it reviews only while that machine is awake. This
Ansible route adds VM host setup, the optional tunnel, and the
`scripts/deploy.sh` sync/rebuild/verify workflow on top of the same image.

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

```
ansible-playbook -i inventory.ini playbook.yml -e base_clone_dir=<clone dir> \
  -e config_home_src=<config home> -e config_file_name=config.toml
# force an image rebuild after bumping pins: the same, plus -e rebuild_image=true
```

`base_clone_dir` is mandatory: it is the reviewed repo's base-clone directory
under the sandbox root (`[github] clone_dir`, else the repo's basename), and
the rsync `--delete` keeps it only because it is excluded by that name.
`scripts/deploy.sh` derives and passes it for you.

`config_home_src` and `config_file_name` are mandatory too: the
install's config home on the controller — the directory holding the live
config (`~/.config/qcr/<install>/`, or the one `$QCR_CONFIG` names) — and the
config's file name there. The playbook ships exactly that file and the
`profiles/` beside it (never the home's `secrets/`) to
`/opt/quickreview/config-home/`, mounted read-only into the container, whose
`QCR_CONFIG` names the shipped file. It runs in `sync` too, so a profile
change reaches the VM without a rebuild; `deploy.sh` passes both, and refuses
a config that lives only in the checkout or a `[review] profile` the home (or
the checkout's generic examples) does not hold.

What it does, in order: host packages + Docker → (when `cloudflared_enabled`)
cloudflared apt repo, install, service registration with the tunnel token →
directory layout under `/opt/quickreview/` → secrets copied `0600` → rsync of
the `sandbox_src` working copy (daemon, extensions, prompts, agents — the
seed content rides the repo) → the config home (config + profiles) → image
build → container up
(`restart: unless-stopped`, port bound to **127.0.0.1 only**).

## Verify

```
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

- **API key (wired automatically)**: the entrypoint exports `OPENAI_API_KEY`
  from the mounted `secrets/openai_api_key`, so the tmux server and every pi
  session inherit it. Works headless from the first boot.
- **ChatGPT-subscription OAuth (optional)**: run `/login` once inside any pi
  session in the container (`docker exec -it quickreview-sandbox pi` →
  `/login`); tokens land in `/home/review/.pi/agent/auth.json`, which lives on
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
- Image pins: pi and node are pinned in `group_vars/all.yml`; bumping them is
  a deliberate edit + `rebuild_image=true`, never automatic.
- Jump-in from your own machine: `ssh -t <vm> docker exec -it quickreview-sandbox
  tmux attach -t <pr-N|overseer>` — `scripts/qcr attach <n>` wraps it, and the
  operator TUI (`scripts/qcr tui`, with `[tui] target = "ssh"`) embeds the same
  session in a pane.
