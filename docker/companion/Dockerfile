# Local companion container.
#
# Unlike the VM runtime image (deploy/ansible/templates/Dockerfile.j2, built by
# ansible) this one is a plain `docker build` on the owner's PC:
#
#   docker build -t qcr-companion --build-arg COMPANION_UID="$(id -u)" docker/companion
#
# Deltas from the VM image:
#   - node:22 base instead of ubuntu + NodeSource (same major, less plumbing).
#   - no memory extension baked in: memory is OpenViking over the
#     host-owned forward, through the vendored extension mounted at /workspace.
#   - no gh CLI / mint-token credential helper / webhook port: the companion
#     reads the daemon over ssh and writes local files, it never mutates GitHub.
#   - its own pihome volume: never share the VM's auth.json (OAuth tokens
#     refresh in place; two hosts refreshing one grant is a hazard). One-time
#     `/login` inside the container is a HITL step.
FROM node:22-bookworm

ENV DEBIAN_FRONTEND=noninteractive \
    TZ=Europe/Warsaw

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl git jq openssh-client tzdata \
    && rm -rf /var/lib/apt/lists/*

# tmux 3.5a from source — bookworm ships 3.3a, below the ≥3.5 needed for
# `extended-keys-format csi-u` (modified keys actually reaching pi). Recipe
# copied from the VM image so both sides speak the same key protocol.
ARG TMUX_VERSION=3.5a
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential libevent-dev libncurses-dev bison pkg-config \
    && curl -fsSL https://github.com/tmux/tmux/releases/download/${TMUX_VERSION}/tmux-${TMUX_VERSION}.tar.gz \
      | tar xz -C /tmp \
    && cd /tmp/tmux-${TMUX_VERSION} && ./configure && make -j"$(nproc)" && make install \
    && rm -rf /tmp/tmux-${TMUX_VERSION} \
    && apt-get purge -y bison && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*

# pi — pinned, never floating. Pin must equal config.toml [pi], package.json's
# `pi` block and deploy/ansible/group_vars, or every VERIFY-ON-PIN assumption
# in this repo is void.
ARG PI_PACKAGE=@earendil-works/pi-coding-agent
ARG PI_VERSION=1.0.0
RUN npm install -g ${PI_PACKAGE}@${PI_VERSION}

# No memory extension is installed here. The companion's memory is OpenViking
# on the VM, reached over a host-owned forward, and its pi extension is the
# vendored+patched `extensions/vendor/openviking-pi` bind-mounted at /workspace
# and passed with `--extension` by src/tui/companion.ts — nothing to bake into
# the image. Do not add a local memory package (pi-memory, qmd): a second
# engine writing a local MEMORY.md would fork the companion's memory silently.

# Non-root, and the uid MUST match the invoking host user: every interesting
# mount here is a host bind mount the companion writes (/alerts, /feed,
# /workspace, /tracker), so a mismatched uid means "Permission denied" on the
# very first alert file (the VM image's 1001 does not transfer to a laptop). Both
# scripts/companion-e2e.sh and scripts/smoke-companion.sh build with
# `--build-arg COMPANION_UID="$(id -u)"`; the default is the usual desktop
# 1000. --non-unique because node:22 already ships a uid-1000 `node` user.
ARG COMPANION_UID=1000
RUN useradd --create-home --non-unique --uid ${COMPANION_UID} companion \
    && mkdir -p /home/companion/.pi /workspace /tracker /feed /alerts \
    && chown -R companion:companion /home/companion /feed /alerts

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
# The memory health watcher. Baked into the image rather than read off
# /workspace so it starts with the container, before any repo build exists.
COPY memory-health.mjs /usr/local/lib/qcr/memory-health.mjs
RUN chmod 0755 /usr/local/bin/entrypoint.sh && chmod 0644 /usr/local/lib/qcr/memory-health.mjs

# Mount points — the lifecycle code (src/tui/companion.ts) wires the host side:
#   /home/companion/.pi  named volume companion-pihome (OAuth, sessions, memory)
#   /workspace           the review-sandbox repo, rw
#   /tracker             the issue tracker, rw (actor `companion`)
#   /feed                TUI → companion ambient snapshots
#   /alerts             companion → TUI alert files
#
# There is NO ssh mount and NO agent socket (CLAUDE.md rule 8): the
# container holds no VM credential. Its one reach into the VM is OpenViking
# memory, over a forward owned by the host (scripts/companion-memory-forward.mjs),
# reached at OPENVIKING_ENDPOINT on the qcr-memory docker bridge with the two
# USER keys docker passes in via --env-file.
VOLUME ["/home/companion/.pi"]

USER companion
# HOME must be set EXPLICITLY. `useradd --non-unique --uid 1000 companion`
# leaves two passwd entries at uid 1000, and docker resolves `USER companion`
# back through the uid to the FIRST of them — node:22's own `node` user — so
# HOME would be /home/node while the pihome volume is mounted on
# /home/companion/.pi. Everything pi writes to $HOME/.pi (settings, trust,
# `auth.json`) would then land on the container's writable layer and the OAuth
# login would not survive a recreate. Do not remove this line, and do not
# "simplify" it by dropping the companion user: uid 1000 is required to write
# /workspace and /tracker as the host user, so the collision cannot be avoided
# — only overridden.
ENV HOME=/home/companion
WORKDIR /workspace

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
