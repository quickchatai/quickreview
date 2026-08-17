# Local companion container (build slice C1).
#
# Unlike the VM runtime image (deploy/ansible/templates/Dockerfile.j2, built by
# ansible) this one is a plain `docker build` on the owner's PC:
#
#   docker build -t qcr-companion --build-arg COMPANION_UID="$(id -u)" docker/companion
#
# Deltas from the VM image, per assets/findings.md §Q4:
#   - node:22 base instead of ubuntu + NodeSource (same major, less plumbing).
#   - pi-memory is installed here for real — the VM image declares it in
#     package.json's `pi` block but installs only the CLI (the gap).
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
ARG PI_VERSION=0.84.1
RUN npm install -g ${PI_PACKAGE}@${PI_VERSION}

# pi-memory — declared in package.json's `pi`.extensions but installed nowhere
# (§Q3 gap). "Fresh conversation daily, memory carries" needs it
# present and discovered.
# VERIFY-ON-PIN: the install *route*. This installs the extension as a global
# npm package from the pinned git tag and lets the entrypoint point pi at it via
# ~/.pi/agent/settings.json "extensions"; pi 0.84.1's actual discovery contract
# (settings.json array vs ~/.pi/agent/extensions/ drop-in vs `--extension`
# path) is documented only second-hand (§5) and must be confirmed
# against the real package. If the array route is wrong, the fallback is a
# symlink into the discovery dir — no image rebuild needed.
ARG PI_MEMORY_SPEC=pi-memory@0.4.2
# Registry install, NOT github: — npm installs git specs for global packages
# as a SYMLINK into /root/.npm/_cacache/tmp (0700, ephemeral), so the
# non-root companion user could never load it (found live 2026-08-17). The
# registry name is collided (jayzeng vs josephkern/catlain/@chendpoc), so the
# build hard-fails unless the INSTALLED package's repository resolves to
# github.com/jayzeng/pi-memory — same discipline as the VM image.
RUN npm install -g --ignore-scripts ${PI_MEMORY_SPEC} \
  && node -e "const p=require('/usr/local/lib/node_modules/pi-memory/package.json'); const r=(p.repository&&(p.repository.url||p.repository))||''; if(!/github\.com[:\/]jayzeng\/pi-memory/.test(r)) { console.error('pi-memory is NOT jayzeng/pi-memory:', r); process.exit(1); }" \
  && chmod -R a+rX /usr/local/lib/node_modules/pi-memory

# Non-root, and the uid MUST match the invoking host user: every interesting
# mount here is a host bind mount the companion writes (/alerts, /feed,
# /workspace, /tracker), so a mismatched uid means "Permission denied" on the
# very first alert file (found this the first time the e2e ran the real
# container — the VM image's 1001 does not transfer to a laptop). Both
# scripts/companion-e2e.sh and scripts/smoke-companion.sh build with
# `--build-arg COMPANION_UID="$(id -u)"`; the default is the usual desktop
# 1000. --non-unique because node:22 already ships a uid-1000 `node` user.
ARG COMPANION_UID=1000
RUN useradd --create-home --non-unique --uid ${COMPANION_UID} companion \
    && mkdir -p /home/companion/.pi /workspace /tracker /feed /alerts \
    && chown -R companion:companion /home/companion /feed /alerts

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod 0755 /usr/local/bin/entrypoint.sh

# Mount points — the lifecycle code (src/tui/companion.ts) wires the host side:
#   /home/companion/.pi  named volume companion-pihome (OAuth, sessions, memory)
#   /workspace           the review-sandbox repo, rw
#   /tracker             the issue tracker, rw (actor `companion`)
#   /feed                TUI → companion ambient snapshots
#   /alerts             companion → TUI alert files
#   /home/companion/.ssh + /ssh-agent  read-only, for VM reads/inject
VOLUME ["/home/companion/.pi"]

USER companion
WORKDIR /workspace

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
