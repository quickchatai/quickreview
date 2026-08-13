# Review-sandbox provisioning (Ansible)

Minimal, idempotent provisioning for the review sandbox: **one VM → one Docker
container** (plain Ubuntu + pinned pi + node/gh/tmux + secrets + the
prompt/agent seed) with **cloudflared on the host** forwarding
`review.example.com` → `localhost:8787` → the container, so GitHub webhooks
flow the moment the daemon (build slice B2) listens.

Asset of; written at
the owner's direction 2026-08-13. Architecture note: running the whole sandbox
inside one container is the isolation answer to pi having no built-in
permission system.

## Prerequisites (once, manual)

1. **VM exists** in the dev GCP project (checklist §B: e2-standard-4,
   100 GB, no external IP, OS Login + IAP).
2. **Cloudflare tunnel exists** (checklist §A): remote-managed tunnel,
   public hostname `review.example.com` → `http://localhost:8787`; its
   **token** saved as `~/.config/quickreview-bot/tunnel_token` locally.
3. **Local secrets dir** `~/.config/quickreview-bot/` contains:
   `app_id`, `app.pem`, `openai_api_key`, `webhook_secret`, `tunnel_token`.
   (Never a personal credential.)
4. Controller tooling:
   ```
   ansible-galaxy collection install community.docker ansible.posix
   gcloud compute config-ssh
   cp inventory.example.ini inventory.ini   # then edit
   ```
5. Pin `pi_version` in `group_vars/all.yml` (and confirm `pi_npm_package`
   against's findings) before first run.

## Run

```
ansible-playbook -i inventory.ini playbook.yml
# force an image rebuild after bumping pins:
ansible-playbook -i inventory.ini playbook.yml -e rebuild_image=true
```

What it does, in order: host packages + Docker → cloudflared apt repo, install,
service registration with the tunnel token → directory layout under
`/opt/quickreview/` → secrets copied `0600` → the prompts/agents seeded
into the container volume (no duplication in the tracker) →
optional rsync of your local `review-sandbox` working copy (uncomment
`sandbox_src` once B1+ exist) → image build → container up
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
- The webhook port is published on loopback only; the sole ingress is the
  tunnel. No inbound firewall rule is ever needed.
- Image pins: pi and node are pinned in `group_vars/all.yml`; bumping them is
  a deliberate edit + `rebuild_image=true`, never automatic (spec §9).
- Jump-in from the laptop: `ssh -t <vm> docker exec -it quickreview-sandbox
  tmux attach -t <pr-N|overseer|main>` (the `qcr attach` helper wraps this in
  build slice B1).
