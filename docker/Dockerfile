# The release image: one image for every shape of qcr (laptop, Action, bot).
#
#   docker buildx build --platform linux/amd64,linux/arm64 -f docker/Dockerfile .
#   docker build -f docker/Dockerfile --target build .     # compile only
#
# Stages: `tmux-build` and `build` are throwaway; `release` is the image and
# the default target. Bench is NOT a target here: it is bench/aacr/Dockerfile
# built FROM this release image, so the claude arm lives only there
# (CLAUDE.md rule 5) and this file asserts its absence.
#
# What the image is (all of it under /opt/qcr, root-owned, read-only to every
# runtime uid):
#   - the compiled app (dist/), its production dependencies (pi among them,
#     from `npm ci`), and src/ + extensions/ so a pi extension loaded from here
#     resolves its imports;
#   - the frozen seeds (agents/, prompts/, seeds/), the profiles, and the seed
#     manifest, checked against each other at build time (CLAUDE.md rule 6);
#   - the reviewer context stub as /opt/qcr/AGENTS.override.md: pi loads the
#     first of AGENTS.override.md / AGENTS.md / CLAUDE.md from the cwd and each
#     ancestor, and the engine's cwd here is /opt/qcr, so every session and
#     lens reads the stub, never the contributor guide (the ruling on context
#     files, tests/fixtures/context-files/inventory.json);
#   - docker/entrypoint.sh, the one entrypoint (mode dispatch), and
#     <root>/state, the one writable directory under /opt/qcr.
#
# Any uid: the image carries no passwd entry for the user it runs as. The
# caller picks it (`docker run --user "$(id -u):$(id -g)"`), HOME is fixed at
# /home/qcr and writable by every uid, and nothing under /opt/qcr but state/
# is ever written at run time. This replaces the companion image's 1001/1000 split
# and its COMPANION_UID build arg.
#
# The local companion on the owner's PC is this image too, in `companion` mode:
# `qcr companion rebuild` builds it from the checkout (src/tui/companion.ts
# appImageBuildArgv) and `docker run --user <host uid>` starts it, so its
# extensions, prompt and agent set are the image's, never the /workspace mount
# (D20: no hot reload for the companion - a change lands with a rebuild).
#
# The build context is the repo root, narrowed by docker/Dockerfile.dockerignore
# (BuildKit reads it in preference to the root .dockerignore, which belongs to
# the clone route's scan sandbox image, docker/companion/Dockerfile).

# ---- pinned versions ---------------------------------------------------------
# A MIRROR of config.toml [pi] / package.json / group_vars: PI_VERSION must
# equal the version `npm ci` puts in node_modules (the image's one pi, checked
# below), and tests/release-image.test.ts fails the moment either default
# drifts. Bump them together, never one alone.
ARG NODE_MAJOR=22
# The Debian release under node. bookworm is the image; bench/aacr/Dockerfile's
# ocr, claude and pragent arms need git >= 2.41 and python >= 3.12, so bench.sh
# builds this same file with NODE_DISTRO=trixie for those three.
ARG NODE_DISTRO=bookworm
ARG TMUX_VERSION=3.5a
ARG PI_PACKAGE=@earendil-works/pi-coding-agent
ARG PI_VERSION=1.3.0

# The always-on bot's tool identity: the uid and gid the model's
# tools run as, compiled into the setid helper, which can switch to nothing else.
ARG QCR_TOOL_UID=65534
ARG QCR_TOOL_GID=4749

# ---- the setid helper ---------------------------------------------------------
# docker/setid/qcr-setid.c, built here so the release stage carries the binary,
# not a compiler. It takes setpriv's argv as the engine spells it and refuses any
# identity but the one compiled in.
FROM node:${NODE_MAJOR}-${NODE_DISTRO} AS setid-build
ARG QCR_TOOL_UID
ARG QCR_TOOL_GID
COPY docker/setid/qcr-setid.c /src/qcr-setid.c
RUN mkdir -p /out \
    && gcc -O2 -Wall -Wextra -Werror -DTOOL_UID="${QCR_TOOL_UID}" -DTOOL_GID="${QCR_TOOL_GID}" \
         -o /out/qcr-setid /src/qcr-setid.c

# ---- tmux from source --------------------------------------------------------
# bookworm ships 3.3a, below the >=3.5 that `extended-keys-format csi-u` needs
# (modified keys actually reaching pi). Built once here so the release stage
# carries the binary and its two runtime libraries, not a compiler.
FROM node:${NODE_MAJOR}-${NODE_DISTRO} AS tmux-build
ARG TMUX_VERSION
RUN apt-get update && apt-get install -y --no-install-recommends \
      libevent-dev libncurses-dev bison pkg-config \
    && curl -fsSL "https://github.com/tmux/tmux/releases/download/${TMUX_VERSION}/tmux-${TMUX_VERSION}.tar.gz" \
      | tar xz -C /tmp \
    && cd "/tmp/tmux-${TMUX_VERSION}" && ./configure && make -j"$(nproc)" \
    && make install DESTDIR=/out \
    && rm -rf /var/lib/apt/lists/*

# ---- build -------------------------------------------------------------------
# Compiles the TypeScript and leaves production-only node_modules (native
# addons - better-sqlite3, node-pty - are built here for the target arch).
FROM node:${NODE_MAJOR}-${NODE_DISTRO} AS build
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY scripts/verify-dist.mjs scripts/verify-dist.mjs
COPY src src
COPY extensions extensions
RUN npx tsc -p tsconfig.json && node scripts/verify-dist.mjs
RUN npm prune --omit=dev --no-audit --no-fund && npm cache clean --force

# ---- release -----------------------------------------------------------------
FROM node:${NODE_MAJOR}-${NODE_DISTRO}-slim AS release
ARG PI_PACKAGE
ARG PI_VERSION

ENV DEBIAN_FRONTEND=noninteractive TZ=UTC LANG=C.UTF-8

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl git jq ripgrep openssh-client python3 tzdata \
      'libevent-core-2.1-7*' libncurses6 libnss-wrapper libcap2-bin \
    && rm -rf /var/lib/apt/lists/*

COPY --from=tmux-build /out/usr/local/bin/tmux /usr/local/bin/tmux
RUN tmux -V

# GitHub CLI. The scripts the daemon mode runs (scripts/post-review.sh and
# friends) call it; bench, which posts nothing, purges it (bench/aacr/Dockerfile).
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/*

# Repos are bind-mounted under whatever uid the caller maps in; without this
# git refuses every one of them as "dubious ownership".
RUN git config --system --add safe.directory '*'

# pi: ONE copy, the pinned package npm ci put in node_modules below (P9.9b).
# There is no global pi CLI: every pi the app starts is that package's own bin,
# node_modules/.bin/pi (src/picli.ts), or its SDK. Lenses run on the SDK through
# our own lens tool (src/engine/lens/).

# The app. COPY lands root-owned; the chmod below makes it world-readable and
# writable by nobody.
WORKDIR /opt/qcr
COPY package.json package-lock.json ./
COPY --from=build /src/node_modules ./node_modules
COPY --from=build /src/dist ./dist
COPY src ./src
COPY extensions ./extensions
COPY agents ./agents
COPY prompts ./prompts
COPY seeds ./seeds
COPY profiles ./profiles
COPY schemas ./schemas
COPY scripts ./scripts
COPY config.example.toml ./config.example.toml
# The entrypoint and the tmux config the daemon and companion modes start from.
COPY docker/entrypoint.sh ./docker/entrypoint.sh
COPY docker/vm/tmux.conf ./docker/vm/tmux.conf
# The companion mode's own files: its agent set (the lens tool's agents dir,
# linked into pi's user scope) and the memory health watcher. They ride the
# image, not the /workspace mount (D20: the companion runs the image's code).
COPY docker/companion/agents ./docker/companion/agents
COPY docker/companion/memory-health.mjs ./docker/companion/memory-health.mjs
# The compose stack and the tunnel sidecars' build context, so a Docker-only
# install extracts them from the image (the wizard's bring-up prints the one
# `docker run --entrypoint tar` that does it): nothing is cloned.
COPY docker-compose.yml ./docker-compose.yml
COPY docker/tunnel ./docker/tunnel
# The seed manifest, at the path it has in the repo, so code that reads it
# relative to the app root finds it in the image.
COPY tests/fixtures/seed-manifest.json ./tests/fixtures/seed-manifest.json
# The reviewer context stub, in the engine's cwd (see the header).
COPY deploy/reviewer/AGENTS.override.md ./AGENTS.override.md

# The build stamp: `qcr version --json` reports it. CI passes the commit.
ARG BUILD_SHA=unstamped
LABEL qcr.build-sha="${BUILD_SHA}"
# What the VM's updater (deploy/qcr-update.sh) reads off the image before it
# stops anything. qcr.layout says this is the release layout (the legacy image
# has no such label). qcr.runspec is the run-spec version the image needs of
# /etc/qcr/update.conf, which `provision` renders: an image that needs a newer
# one than the VM holds is refused with "re-run provision". qcr.pi is the pi pin
# the preflight holds to config.toml [pi] and group_vars. qcr.preflight says the
# image has `daemon --preflight` (src/preflight.ts); qcr-update refuses an image
# without it. tests/deploy.test.ts pins the runspec to scripts/deploy.sh's
# RUNSPEC_VERSION.
LABEL qcr.layout="release" \
      qcr.preflight="true" \
      qcr.runspec="2" \
      qcr.pi="${PI_VERSION}"
RUN printf '%s\n' "${BUILD_SHA}" > /opt/qcr/BUILD_SHA

# The checks that make this the image it claims to be.
#   - the seeds: the baked agents/ and prompts/ and their seeds/ canonical
#     copies all hash to the manifest (rule 6). A drifted seed fails the build.
#   - pi: the one copy, in node_modules, is the ARG's version and the version
#     config.example.toml [pi] pins; its bin is node_modules/.bin/pi, and no
#     other pi is on the PATH.
#   - claude: absent (rule 5). The claude arm exists only in bench/aacr/.
RUN cd /opt/qcr \
    && jq -r '.files | to_entries[] | "\(.value)  seeds/\(.key)"' tests/fixtures/seed-manifest.json | sha256sum -c --quiet - \
    && jq -r '.files | to_entries[] | "\(.value)  \(.key)"' tests/fixtures/seed-manifest.json | sha256sum -c --quiet - \
    || { echo "FATAL: the baked seeds do not match tests/fixtures/seed-manifest.json" >&2; exit 1; }
RUN cd /opt/qcr \
    && local_="$(node -p "require('/opt/qcr/node_modules/${PI_PACKAGE}/package.json').version")" \
    && pinned="$(awk '/^\[pi\]/{p=1;next} /^\[/{p=0} p && $1=="version"{gsub(/"/,"",$3);print $3}' config.example.toml)" \
    && [ "${local_}" = "${PI_VERSION}" ] && [ "${pinned}" = "${PI_VERSION}" ] \
    || { echo "FATAL: pi versions disagree (ARG ${PI_VERSION}, node_modules ${local_:-?}, config ${pinned:-?})" >&2; exit 1; }
RUN [ -x /opt/qcr/node_modules/.bin/pi ] && ! command -v pi \
    || { echo "FATAL: pi must be node_modules/.bin/pi alone (bin: $(ls -l /opt/qcr/node_modules/.bin/pi 2>&1); PATH: $(command -v pi || echo none))" >&2; exit 1; }
RUN ! command -v claude
# setpriv (util-linux): the engine starts pi through it, as another uid with no
# capabilities, so the model's tools cannot read the token-holding process (D32).
RUN setpriv --version >/dev/null
# The always-on bot's setid helper. The bot runs as its own uid, not
# root, so a `docker exec` into it lands as that uid; docker gives a non-root
# uid no ambient capabilities, so it reaches the tool uid through
# docker/setid/qcr-setid.c, which carries CAP_SETUID/CAP_SETGID as FILE
# capabilities and switches to exactly one identity, QCR_TOOL_UID:QCR_TOOL_GID,
# never root. Only the gate group may run it (the run spec's --group-add, the
# qcr.setid-gid label below). The model's tools run with no_new_privs and
# without that group: to them the helper is a plain, unrunnable binary. The
# tool gid is its own group, shared with the daemon (its second --group-add)
# only through the directories the model's scripts write. setcap comes last: a
# chown or a copy afterwards would drop the capabilities.
ARG QCR_SETID_GID=4748
ARG QCR_TOOL_UID
ARG QCR_TOOL_GID
COPY --from=setid-build /out/qcr-setid /tmp/qcr-setid
RUN install -d -o root -g root -m 0755 /usr/local/libexec/qcr \
    && install -o root -g "${QCR_SETID_GID}" -m 0750 /tmp/qcr-setid /usr/local/libexec/qcr/qcr-setid \
    && rm -f /tmp/qcr-setid \
    && setcap cap_setuid,cap_setgid=ep /usr/local/libexec/qcr/qcr-setid \
    && getcap /usr/local/libexec/qcr/qcr-setid | grep -q 'cap_setgid,cap_setuid=ep' \
    || { echo "FATAL: the setid helper has no cap_setuid,cap_setgid=ep ($(getcap /usr/local/libexec/qcr/qcr-setid 2>&1))" >&2; exit 1; }
ENV QCR_IMAGE_TOOL_UID="${QCR_TOOL_UID}" QCR_IMAGE_TOOL_GID="${QCR_TOOL_GID}"
LABEL qcr.setid-gid="${QCR_SETID_GID}" \
      qcr.tool-uid="${QCR_TOOL_UID}" \
      qcr.tool-gid="${QCR_TOOL_GID}"
# flock (util-linux): the login refresher's single-instance lock and the login
# mode's test for whether one is running (src/loginrefresh/lock.ts, P8.22).
RUN flock --version >/dev/null

# Root-owned, world-readable, writable by no runtime uid. The stub is 0444 on
# its own account: it is a policy surface, not data.
RUN chmod -R a+rX,go-w /opt/qcr && chmod 0444 /opt/qcr/AGENTS.override.md

# The one writable spot under the app root: <root>/state, where the MutationGate
# writes state/dryrun and every mode keeps its state files. World-writable and
# sticky, like HOME below; a state volume mounts over it. The entrypoint
# refuses to start a mode whose uid cannot write here.
RUN install -d -m 1777 /opt/qcr/state /opt/qcr/state/ingress && chmod 0555 /opt/qcr/docker/entrypoint.sh

# HOME for whatever uid the caller maps in: world-writable and sticky, so
# `--user 1234:1234` can create ~/.pi and ~/.cache. The login and state
# volumes mount over parts of it.
# ~/.pi is pi's home, the mount point the compose stack's pihome volume lands
# on: a volume mounted over a directory the image has takes that directory's
# mode, one over a directory it lacks arrives root-owned and unwritable.
#
# pi's agent dir, which `qcr login` mounts the login volume over (P6.7). A new
# volume starts as this directory is, so it must be writable by whatever uid
# the caller logs in as; the login mode then moves everything pi wrote into the
# login group (docker/entrypoint.sh), and file modes keep it private.
RUN install -d -m 1777 /home/qcr /home/qcr/.pi && install -d -m 0777 /home/qcr/.pi/agent

# The shared tmux-socket volume (D35): the companion's tmux server listens in
# it and the containerised TUI drives that server over it. Like the dirs above,
# a new named volume takes this mode, so any uid can create the socket.
RUN install -d -m 1777 /run/qcr-tmux
ENV HOME=/home/qcr

# A default for a bare `docker run`; the wrapper always passes --user. A per-call
# run that reaches a model starts as root instead (--user 0:0 --cap-drop ALL
# --cap-add SETUID --cap-add SETGID): the entrypoint drops to QCR_RUN_UID and
# runs the model's tools as QCR_TOOLS_AS (D32, docker/entrypoint.sh). Started as
# any other uid, the engine refuses to run the model's tools unless QCR_ALLOW_SHARED_TOOL_UID=1.
USER 1000:1000
WORKDIR /opt/qcr

# One entrypoint, mode dispatch (docker/entrypoint.sh): install, mint, cli
# (the default: `docker run <img> version --json`), daemon, worker, tui,
# companion, login.
ENTRYPOINT ["/opt/qcr/docker/entrypoint.sh"]
