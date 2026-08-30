# Plain Docker path — run the daemon on any host

The review daemon in one container, no Ansible, no cloud account, no private
checkouts: this directory's `Dockerfile` + `entrypoint.sh` are the
non-templated equivalents of the Ansible route's
`deploy/ansible/templates/*.j2`, and the repo-root `docker-compose.yml` builds
and runs them. The Ansible route (`deploy/ansible/`) remains the advanced
path for a managed VM; both produce the same runtime.

## Quick start

```sh
# 1. secrets (see below), then from the repo root:
export QCR_UID=$(id -u)      # container user owns your checkout's files
docker compose up -d --build

# 2. check
curl -s http://127.0.0.1:8787/health
docker compose logs -f daemon
```

The first boot runs `npm ci` + `npm run build` inside the mounted repo and
replaces the repo's `state/` dir with a symlink onto the state volume — both
are how the VM image behaves too. Steady-state restarts are instant.

## What the container expects

- **The repo, bind-mounted rw** at `/opt/quickreview/sandbox` (compose mounts
  `./`). The code, prompts and agents ride the repo — there is no seed step.
- **A secrets dir, mounted read-only** at `/opt/quickreview/secrets` (default
  `~/.config/quickreview-bot`, override with `QCR_SECRETS_DIR`):
  - `app_id`, `app.pem`, `webhook_secret` — the GitHub App credential
    (required; the only credential the system ever uses).
  - `openai_api_key` — optional; pi can instead use ChatGPT OAuth (`/login`
    once inside a session; tokens persist on the pihome volume). Without it
    OpenViking falls back to its local dense embedder.
  - `openviking_root_key`, `openviking_reviewer_key` — optional; without the
    root key the memory engine degrades loudly to `auth_mode=dev` (no
    per-user confinement) rather than blocking the boot.
  `deploy/collect-secrets.sh` can assemble the dir interactively.
- **Two named volumes** (compose creates them): `qcr-state`
  (`/opt/quickreview/state` — SQLite, heartbeat, OpenViking memory) and
  `qcr-pihome` (`/home/review/.pi` — pi OAuth tokens + session JSONLs; sticky
  conversations depend on it surviving rebuilds).

## Ingress — your choice, and three of the shapes are sidecars

The container publishes exactly one port: the webhook port, `8787`, bound to
`127.0.0.1` by default (`QCR_WEBHOOK_BIND` / `QCR_WEBHOOK_PORT` to change).
**Any HTTPS proxy or tunnel that forwards your webhook hostname to that port
works** — the GitHub App just needs a reachable HTTPS webhook URL. Since
the compose file carries the three tunnel shapes as optional sidecars,
each behind its own profile, and the onboarding wizard's ingress step picks one
for you (it writes `COMPOSE_PROFILES` into the project `.env` and the matching
`[ingress]` block into `config.toml`). **With no profile selected you get the
daemon alone** — the fourth shape.

| `COMPOSE_PROFILES` | service | what you get | what it costs |
| --- | --- | --- | --- |
| `quick-tunnel` | `tunnel-quick` | cloudflared quick tunnel — no account, working in seconds | the `*.trycloudflare.com` hostname **rotates** on every restart, and there is no SLA |
| `ngrok` | `tunnel-ngrok` | a stable hostname with a reserved domain | an ngrok account, and free-tier caps (~20k requests/month, ~1 GB transfer, 1 agent, ~120 req/min) |
| `named-tunnel` | `tunnel-named` | your own Cloudflare tunnel on your own domain — what the VM route uses | a Cloudflare account, a zone, and a connector token |
| *(unset)* | — | nothing exposed at all; the reconcile poll triggers reviews | up to one poll interval of latency, and author-reply routing plus the `[feedback]` loop go quiet (both are webhook-driven) |

The rotating hostname is safe because the daemon fixes itself: the sidecar
writes its assigned **bare hostname** to `/ingress/hostname` on the shared
`qcr-ingress` volume, which the daemon sees at
`/opt/quickreview/state/ingress/hostname` — the default `[ingress] hostname_file`
— and re-points the GitHub App's own webhook URL when it changes (,
`src/webhookheal.ts`; the one mutation class that executes even in dry-run).
A sidecar restart is therefore a non-event: a new name is written, the daemon
follows it, and the reconcile poll covers the seconds in between.

```sh
COMPOSE_PROFILES=quick-tunnel docker compose up -d --build   # or set it in .env
docker compose logs -f tunnel-quick                          # the assigned hostname
```

Credentials never reach a command line. The ngrok authtoken is a file,
`<secrets dir>/ngrok_authtoken`, and the named tunnel's connector token is the
`tunnel_token` the secrets wizard already collects; both sidecars mount the
secrets dir **read-only** and the wrapper passes the value to the client in its
environment:

```sh
(umask 077; printf %s '<ngrok authtoken>' > ~/.config/quickreview-bot/ngrok_authtoken)
```

The wrapper itself is `docker/tunnel/sidecar.mjs`: it runs the vendor's own
binary (copied verbatim out of the official `cloudflare/cloudflared` and
`ngrok/ngrok` images, pinned by tag and version-verified at build time),
captures the hostname from the client's output, writes it atomically, restarts
the client forever on a capped backoff, and never exits — a tunnel that is down
must never wedge the stack.

Anything else still works too: a reverse proxy with TLS on the same host
(Caddy, nginx + certbot, …), the Ansible route's host-level cloudflared
(`cloudflared_enabled`, default true there), or any other tunnel pointed at
`localhost:8787`.

OpenViking's port (1933) is loopback inside the container and is deliberately
never published — not to the host, and not to a tunnel sidecar either (they
mount one directory: the hostname file's). Per-user confinement is server-side
and every review session already runs inside the container. Do not add 1933 to
any `ports:`.

## Pins — how versions are honored

The image versions are ARG defaults in the `Dockerfile`:

| ARG | mirrors |
| --- | --- |
| `PI_VERSION` / `PI_NPM_PACKAGE` | `config.toml [pi]` = `group_vars pi_version`/`pi_npm_package` |
| `OPENVIKING_VERSION` | `config.toml [openviking] version` = `group_vars openviking_version` |
| `LLAMA_CPP_PYTHON_VERSION` | same triple mirror (undeclared-but-required embedder dep) |
| `TMUX_VERSION`, `NODE_MAJOR`, `OPENVIKING_VENV`, `WEBHOOK_PORT` | `group_vars` |

`tests/docker-daemon.test.ts` fails the moment a default drifts from
`config.toml` or `deploy/ansible/group_vars/all.yml`, exactly as
`tests/openviking.test.ts` guards the templated image and
`scripts/deploy.sh`'s preflight refuses on drift. Bumping a pin is a
deliberate act: change every mirror together, then rebuild
(`docker compose build --no-cache` here; `deploy.sh rebuild` on the VM).

Runtime knobs (OpenViking port/workers/auth mode/key file names/…) are
`QCR_OPENVIKING_*` env vars on the container, defaulting to the same values
`group_vars` carries — see `entrypoint.sh`'s header block.

## Parity notes vs the templated image

- tmux is built from source (≥3.5 for csi-u extended keys), pi is npm-pinned,
  gh CLI installed, OpenViking lives in its own venv with the
  llama-cpp-python pin installed first (without it the server cannot boot).
- The no-stall trust layers ride the image/entrypoint: `defaultProjectTrust =
  "always"` and a pre-seeded `trust.json` for `/opt/quickreview` (the third
  layer, `--approve`, is on every pi spawn in `src/sessions.ts`).
- Subagents are pi's own first-party extension inside the pinned pi package
  — both images only verify the shipped example exists; the fan-out
  cap rides `config.toml [pi] subagent_max_concurrency`, not an image file.
- The one intentional difference: versions arrive as build ARGs instead of
  Jinja variables, and runtime knobs as env vars instead of template
  interpolation. Same defaults, same refusal-on-drift.

Building the image compiles llama-cpp-python from source — expect the first
build to take a while.
