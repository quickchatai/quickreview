# The compose stack — run the daemon on any host with Docker

The review daemon, its memory engine and an optional webhook tunnel, from the
released images: no checkout, no build, no Ansible, no cloud account. The
repo-root `docker-compose.yml` is the whole stack, and the release image
carries a copy of it. The Ansible route (`deploy/ansible/`) remains the path
for a managed VM; both run the same daemon.

> **`qcr onboard` drives this route for you.** The wizard's **topology** step
> offers it as one of two first-class answers — "this computer", the zero-server
> way to run QuickReview — and then does everything below: it captures your uid,
> writes the version pin, `QCR_UID` and `COMPOSE_PROFILES` into the project
> `.env`, points `config.toml` at the memory service, tells you about the first
> pull before starting it, streams it, and checks the container states
> afterwards. Where the wizard itself runs inside the image there is no Docker
> to drive, so it prints the exact commands for your host instead and you run
> them there. It composes this path; it does not replace it, and drift between
> the two is a bug. Everything here stays true for a manual run. See
> [../docs/onboarding.md](../docs/onboarding.md).

## Quick start

The images are private, so log in to the registry once:

```sh
gh auth refresh -s read:packages
gh auth token | docker login ghcr.io -u <your github login> --password-stdin
```

Then, in an empty directory (the project directory):

```sh
# 1. the compose file and the tunnels' build context, out of the image
docker run --rm --entrypoint tar ghcr.io/quickchatai/quickreview:<version> \
  -C /opt/qcr -cf - docker-compose.yml docker/tunnel | tar -xf -

# 2. .env: what the stack needs (the wizard writes this for you)
cat > .env <<EOF
QCR_VERSION=<version>
QCR_UID=$(id -u)
QCR_CONFIG_HOME=$HOME/.config/qcr/default
QCR_SECRETS_DIR=$HOME/.config/qcr/default/secrets
QCR_CLONE_DIR=<the reviewed repo's name, or your [github] clone_dir>
EOF

# 3. pull and start
docker compose pull --ignore-buildable
docker compose up -d

# 4. check
curl -s http://127.0.0.1:8787/health
docker compose logs -f daemon
```

`QCR_VERSION` is the one pin: the daemon image and the memory image are always
the same release. To move to another release, change it and run step 3 again.
Nothing is built except the tunnel sidecar you select (below), and the first
pull is the slow one: it downloads two images, and the memory one carries its
embedding model.

## What the stack is

- **`daemon`** — `ghcr.io/quickchatai/quickreview`, run as `daemon` mode, as
  your uid (`QCR_UID`). The model's tools run as another uid
  (`QCR_TOOLS_AS`, default `65534`) that cannot read your secrets or pi's
  login: the daemon reaches it through the image's setid helper, so it gets
  the helper's gate group (`group_add`) and, of all capabilities, only
  `SETUID`/`SETGID` (the helper) and `CHOWN`/`DAC_OVERRIDE`/`FOWNER` (the
  operator channel's `docker exec -u 0`), and no `no-new-privileges`, which
  would void the helper. It publishes one port, the webhook port `8787`, bound
  to `127.0.0.1` by default (`QCR_WEBHOOK_BIND` / `QCR_WEBHOOK_PORT` to
  change).
- **`volume-init`** — a one-shot root container that runs before the daemon
  and hands the roots of the daemon's volumes to `QCR_UID` (it touches no file
  inside them), then exits.
- **`memory`** — `ghcr.io/quickchatai/quickreview-memory`: OpenViking, its
  venv, llama-cpp-python and the pinned embedding model, in a container of its
  own. It boots offline. `config.toml` must say `[openviking] endpoint =
"remote"` and `host = "memory"` (the wizard's bring-up writes both); the
  daemon then only probes its health. Port `1933` is on the compose network and
  is deliberately never published.
- **a tunnel**, optional, behind a compose profile (below).

## What the containers expect

- **A config home, mounted read-only** at `/opt/quickreview/config-home`
  (`QCR_CONFIG_HOME`, and `QCR_CONFIG_NAME` for the file in it, default
  `config.toml`). The daemon and the memory service read the same file. Both
  variables are required: an unset one fails `docker compose` before anything
  starts, rather than mounting an empty directory.
- **A secrets dir, mounted read-only** at `/opt/quickreview/secrets`
  (`QCR_SECRETS_DIR`, required; the install's
  `~/.config/qcr/<install>/secrets`):
  - `app_id`, `app.pem`, `webhook_secret` — the GitHub App credential
    (required; the only credential the system ever uses).
  - `openai_api_key` — optional; pi's model credential on the API-key route
    (pi can instead use ChatGPT OAuth: `/login` once inside a session; tokens
    persist on the pihome volume). Never read for memory embeddings.
  - `openai_embeddings_api_key` — optional, and only under the hosted-embeddings
    opt-in (`config.toml [openviking] embedding_provider = "openai"`, carried
    into the memory container as `QCR_OPENVIKING_EMBEDDING_*` in the project
    `.env`). By default the memory engine embeds locally and nothing but the
    model call leaves the machine
    ([docs/memory-embeddings.md](../docs/memory-embeddings.md)).
  - `openviking_root_key`, `openviking_reviewer_key` — optional; without the
    root key the memory engine degrades loudly to `auth_mode=dev` (no
    per-user confinement) rather than blocking the boot.
    `deploy/collect-secrets.sh` can assemble the dir interactively, from a clone;
    the wizard's secrets steps write the same files.
- **Named volumes** (compose creates them): `qcr-state` (`/opt/qcr/state` —
  SQLite, heartbeat, the dry-run record, the onboarding checklist), `qcr-pihome`
  (`/home/qcr/.pi` — pi OAuth tokens + session JSONLs; sticky conversations
  depend on it surviving a recreate), `qcr-memory` (the memory store) and
  `qcr-ingress` (the tunnel's hostname file), and the daemon's runtime trees
  under the read-only app root, the same set the VM mounts: `qcr-wt`
  (`/opt/qcr/wt`, the PR worktrees), `qcr-archive`, `qcr-commands`,
  `qcr-digest`, `qcr-inject`, `qcr-verdict`, `qcr-sessions-home`
  (`/opt/qcr/pihome`, the sessions' own HOME) and `qcr-base-clone`
  (`/opt/qcr/$QCR_CLONE_DIR`, the reviewed repo's base clone; the variable is
  required). `docker compose down` keeps all of them; `docker compose down -v`
  deletes them, memory included.

No checkout is mounted, and neither is `docker.sock`: a stack that can start
containers could hand a review session the host.

## Ingress — your choice, and three of the shapes are sidecars

**Any HTTPS proxy or tunnel that forwards your webhook hostname to the webhook
port works** — the GitHub App just needs a reachable HTTPS webhook URL. The
compose file carries the three tunnel shapes as optional sidecars,
each behind its own profile, and the onboarding wizard's ingress step picks one
for you (it writes `COMPOSE_PROFILES` into the project `.env` and the matching
`[ingress]` block into `config.toml`). **With no profile selected you get the
daemon and its memory alone** — the fourth shape.

| `COMPOSE_PROFILES` | service        | what you get                                                           | what it costs                                                                                                              |
| ------------------ | -------------- | ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `quick-tunnel`     | `tunnel-quick` | cloudflared quick tunnel — no account, working in seconds              | the `*.trycloudflare.com` hostname **rotates** on every restart, and there is no SLA                                       |
| `ngrok`            | `tunnel-ngrok` | a stable hostname with a reserved domain                               | an ngrok account, and free-tier caps (~20k requests/month, ~1 GB transfer, 1 agent, ~120 req/min)                          |
| `named-tunnel`     | `tunnel-named` | your own Cloudflare tunnel on your own domain — what the VM route uses | a Cloudflare account, a zone, and a connector token                                                                        |
| _(unset)_          | —              | nothing exposed at all; the reconcile poll triggers reviews            | up to one poll interval of latency, and author-reply routing plus the `[feedback]` loop go quiet (both are webhook-driven) |

The sidecars are the one thing built here rather than pulled: a thin wrapper
over the vendor's own image, built from `docker/tunnel/` (step 1 above extracts
it) the first time a profile selects one.

The rotating hostname is safe because the daemon fixes itself: the sidecar
writes its assigned **bare hostname** to `/ingress/hostname` on the shared
`qcr-ingress` volume, which the daemon sees at
`/opt/qcr/state/ingress/hostname` — the default `[ingress] hostname_file`
— and re-points the GitHub App's own webhook URL when it changes
(`src/webhookheal.ts`; the one mutation class that executes even in dry-run).
A sidecar restart is therefore a non-event: a new name is written, the daemon
follows it, and the reconcile poll covers the seconds in between.

```sh
COMPOSE_PROFILES=quick-tunnel docker compose up -d      # or set it in .env
docker compose logs -f tunnel-quick                     # the assigned hostname
```

Credentials never reach a command line. The ngrok authtoken is a file,
`<secrets dir>/ngrok_authtoken`, and the named tunnel's connector token is the
`tunnel_token` the secrets wizard already collects; both sidecars mount the
secrets dir **read-only** and the wrapper passes the value to the client in its
environment:

```sh
(umask 077; printf %s '<ngrok authtoken>' > ~/.config/qcr/default/secrets/ngrok_authtoken)
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

OpenViking's port (1933) is on the compose network and is deliberately never
published — not to the host, and not to a tunnel sidecar either (they mount one
directory: the hostname file's). Per-user confinement is server-side and every
review session already runs inside the daemon's container. Do not add 1933 to
any `ports:`.

## Pins — how versions are honored

The images are built from `docker/Dockerfile` and `docker/memory/Dockerfile`
by the release workflow; the versions they carry are ARG defaults there:

| ARG                                                  | mirrors                                                                                                                                                                                                             |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PI_VERSION` / `PI_PACKAGE`                          | `config.toml [pi]` = `package.json` = `group_vars pi_version`/`pi_npm_package`                                                                                                                                      |
| `OPENVIKING_VERSION`                                 | `config.toml [openviking] version` = `group_vars openviking_version`                                                                                                                                                |
| `LLAMA_CPP_PYTHON_VERSION`                           | same triple mirror (undeclared-but-required embedder dep)                                                                                                                                                           |
| `LOCAL_EMBEDDER_MODEL` / `_DIR` / `_URL` / `_SHA256` | the local English embedder's model file: `config.toml [openviking] local_embedder_file`/`_url`/`_sha256` = `group_vars openviking_local_embedder_*`; downloaded at build time and refused unless its sha256 matches |
| `TMUX_VERSION`, `NODE_MAJOR`, `OPENVIKING_VENV`      | `group_vars`                                                                                                                                                                                                        |

`tests/release-image.test.ts` and `tests/memory-image.test.ts` fail the moment
a default drifts from `config.toml` or `deploy/ansible/group_vars/all.yml`, and
the daemon refuses to start when `config.toml [pi] version` is not the version
of the pi inside the image. Bumping a pin is a deliberate act: change every
mirror together and cut a new release; a stack picks it up by changing
`QCR_VERSION`. There is nothing to rebuild on your side.

Runtime knobs for the memory engine (port, workers, auth mode, key file names)
are `QCR_OPENVIKING_*` env vars on the `memory` service, defaulting to the same
values `group_vars` carries — see `docker/memory/entrypoint.sh`'s header block.

## Developing on the stack

A clone is for working on QuickReview itself, not for running it; the clone
route is in [CONTRIBUTING.md](../CONTRIBUTING.md). To run locally built
images through this file, build them and name them:
`docker build -f docker/Dockerfile -t ghcr.io/quickchatai/quickreview:dev .` and
`docker build -f docker/memory/Dockerfile -t ghcr.io/quickchatai/quickreview-memory:dev .`,
set `QCR_VERSION=dev`, and skip the pull: `docker compose up -d` finds both
images locally.
