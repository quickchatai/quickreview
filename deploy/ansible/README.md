# Review-sandbox provisioning (Ansible) — the advanced VM route

Minimal, idempotent provisioning for the review sandbox: **one VM → one Docker
container** (plain Ubuntu + pinned pi + node/gh/tmux + secrets; the prompts
and agents ride the repo rsync — there is no separate seed source since
), optionally with **cloudflared on the host** forwarding a public
hostname → `localhost:8787` → the container.

**Not deploying to a managed VM?** The primary route is the plain Docker path:
`docker compose up` from the repo root — see `docker/daemon/README.md`. This
Ansible route adds VM host setup, the optional tunnel, and the
`scripts/deploy.sh` sync/rebuild/verify workflow on top of the same image.

**Ingress is a choice, not a requirement**: any HTTPS proxy or tunnel that
forwards your webhook hostname to the published port works. The cloudflared
tasks are gated on `cloudflared_enabled` (group_vars, default `true` — the
live deployment keeps its tunnel); set `-e cloudflared_enabled=false` to
bring your own ingress.

Asset of; written at
the owner's direction 2026-08-13. Architecture note: running the whole sandbox
inside one container is the isolation answer to pi having no built-in
permission system.

## Prerequisites (once, manual)

1. **VM exists** in the dev GCP project (checklist §B: e2-standard-4,
   100 GB, no external IP, OS Login + IAP).
2. **Ingress**: either a Cloudflare tunnel (remote-managed tunnel, public
   hostname → `http://localhost:8787`; its **token** saved as
   `~/.config/quickreview-bot/tunnel_token` locally — required only with
   `cloudflared_enabled: true`), or your own HTTPS proxy/tunnel pointed at
   the VM's `localhost:8787` (then set `cloudflared_enabled: false`).
3. **Local secrets dir** `~/.config/quickreview-bot/` contains:
   `app_id`, `app.pem`, `webhook_secret` (plus `openai_api_key` optional —
   OAuth route — and `tunnel_token` when the tunnel is enabled).
   (Never any personal token.)
4. Controller tooling:
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
ansible-playbook -i inventory.ini playbook.yml
# force an image rebuild after bumping pins:
ansible-playbook -i inventory.ini playbook.yml -e rebuild_image=true
```

What it does, in order: host packages + Docker → (when `cloudflared_enabled`)
cloudflared apt repo, install, service registration with the tunnel token →
directory layout under `/opt/quickreview/` → secrets copied `0600` → rsync of
the `sandbox_src` working copy (daemon, extensions, prompts, agents — the
seed content rides the repo) → image build → container up
(`restart: unless-stopped`, port bound to **127.0.0.1 only**).

## Verify

```
ssh <vm> systemctl is-active cloudflared docker
ssh <vm> docker ps --filter name=quickreview-sandbox
ssh <vm> docker exec quickreview-sandbox tmux ls
```

A GitHub test delivery (step 4) will 502 until the daemon exists —
expected pre-B2; the tunnel path itself is proven by the 502 arriving from
cloudflared rather than a timeout.

## OpenAI auth for pi

Native in pi — nothing to install (verified,
findings):

- **API key (wired automatically)**: the entrypoint exports `OPENAI_API_KEY`
  from the mounted `secrets/openai_api_key`, so the tmux server and every pi
  session inherit it. Works headless from the first boot.
- **ChatGPT-subscription OAuth (optional, "Codex for OSS" billing)**: run
  `/login` once inside any pi session in the container
  (`docker exec -it quickreview-sandbox pi` → `/login`); tokens land in
  `/home/review/.pi/agent/auth.json`, which lives on the persistent `pihome`
  volume, auto-refresh, and **take precedence** over the env-var key (pi's
  resolution order: CLI flag → auth.json → env var). Both routes can coexist.

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
  a deliberate edit + `rebuild_image=true`, never automatic (spec §9).
- Jump-in from the laptop: `ssh -t <vm> docker exec -it quickreview-sandbox
  tmux attach -t <pr-N|overseer|main>` (the `qcr attach` helper wraps this in
  build slice B1).
