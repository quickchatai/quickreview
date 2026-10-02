# Review-sandbox runtime — plain (non-templated) Docker path.
#
# The Ansible route renders deploy/ansible/templates/Dockerfile.j2 for the
# live VM; THIS file is the same image for any Docker host, with the Jinja
# variables replaced by build ARGs. The ARG defaults below are a MIRROR of the
# pins in config.toml ([pi] / [openviking]) and deploy/ansible/group_vars/
# all.yml — tests/docker-daemon.test.ts fails the moment any default drifts
# from those sources of truth, the same discipline the templated image gets
# from tests/openviking.test.ts. Bumping a pin is a deliberate act: change
# config.toml + group_vars + these defaults together, never one alone.
#
# Build (from the repo root; the context is this directory — the code itself
# is bind-mounted at runtime, exactly like the VM image):
#   docker compose build          # or:
#   docker build -t quickreview-sandbox:v1 docker/daemon
FROM ubuntu:24.04

# ---- pinned versions (mirror of config.toml + group_vars; see header) -------
ARG TZ=Europe/Warsaw
ARG TMUX_VERSION=3.5a
ARG NODE_MAJOR=22
ARG PI_NPM_PACKAGE=@earendil-works/pi-coding-agent
ARG PI_VERSION=1.0.0
ARG OPENVIKING_VERSION=0.4.15
ARG LLAMA_CPP_PYTHON_VERSION=0.3.35
ARG OPENVIKING_VENV=/opt/openviking/venv
ARG WEBHOOK_PORT=8787

ENV DEBIAN_FRONTEND=noninteractive \
    TZ=${TZ}

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl git jq ripgrep openssh-client gnupg tzdata sqlite3 \
      build-essential python3 \
    && rm -rf /var/lib/apt/lists/*

# tmux >= 3.5 from source — 24.04's apt tmux is 3.4, below the >=3.5 needed
# for `extended-keys-format csi-u` (modified keys reaching pi).
RUN apt-get update && apt-get install -y --no-install-recommends \
      libevent-dev libncurses-dev bison pkg-config \
    && curl -fsSL "https://github.com/tmux/tmux/releases/download/${TMUX_VERSION}/tmux-${TMUX_VERSION}.tar.gz" \
      | tar xz -C /tmp \
    && cd "/tmp/tmux-${TMUX_VERSION}" && ./configure && make -j"$(nproc)" && make install \
    && rm -rf "/tmp/tmux-${TMUX_VERSION}" \
    && apt-get purge -y bison && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*

# Node (NodeSource)
RUN curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# GitHub CLI
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/*

# pi — pinned, never floating
RUN npm install -g "${PI_NPM_PACKAGE}@${PI_VERSION}"

# NOTE: the pi-memory extension and the qmd search CLI used to be
# installed here. Both retired with the hand-rolled memory engine — memory is
# OpenViking (below) and the only memory extension a session loads is the
# vendored, patched `extensions/vendor/openviking-pi`, passed per spawn. Do not
# re-add either: a second memory engine writing MEMORY.md would fork memory,
# and pi-memory also hooks `session_before_compact`, which extensions/
# ledger-pin.ts must own alone.

# RETIRED: the third-party pi-subagents clone layer. Subagents are
# pi's own first-party extension, shipped inside the pinned pi package above
# (examples/extensions/subagent) and loaded from the install path by
# extensions/subagents.ts — the pi layer's version pin covers it, and the
# fan-out cap now rides config.toml [pi] subagent_max_concurrency instead of
# a baked config.json. The layer hard-fails if the shipped example is missing
# from the published package.
RUN test -f "$(npm root -g)/${PI_NPM_PACKAGE}/examples/extensions/subagent/index.ts" \
    || { echo "FATAL: pi ${PI_VERSION} does not ship examples/extensions/subagent" >&2; exit 1; }

# OpenViking — the context store the daemon supervises on loopback (1933 by
# default; the port is a runtime knob, see the entrypoint). Its own venv so
# its ~90 Python deps never collide with anything system-side.
#
# llama-cpp-python is installed FIRST and deliberately: it is NOT an openviking
# dependency but an undeclared optional extra, and without it the default local
# dense embedder raises EmbeddingConfigurationError at startup — the official
# image cannot boot (verified against a running 0.4.15, 2026-08-20). It is also
# our fallback embedder when no OpenAI key is mounted.
#
# Both versions come from the ARG mirror above (== config.toml [openviking] ==
# group_vars); a literal here would be exactly the drift the pin prevents. The
# layer hard-fails unless the INSTALLED distribution reports the pinned version
# and the server entry point exists — the same provenance discipline the pi
# pin above gets.
#
# The vendored pi extension's upstream base commit is pinned too, in
# config.toml [openviking] extension_commit + extensions/vendor/openviking-pi/
# upstream.json; it rides the repo rather than this image, so there is no layer
# for it here.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3-venv python3-dev cmake \
    && python3 -m venv "${OPENVIKING_VENV}" \
    && "${OPENVIKING_VENV}/bin/pip" install --no-cache-dir --upgrade pip \
    && "${OPENVIKING_VENV}/bin/pip" install --no-cache-dir "llama-cpp-python==${LLAMA_CPP_PYTHON_VERSION}" \
    && "${OPENVIKING_VENV}/bin/pip" install --no-cache-dir "openviking==${OPENVIKING_VERSION}" \
    && "${OPENVIKING_VENV}/bin/python" -c "import importlib.metadata as m, sys; v=m.version('openviking'); sys.exit(0 if v=='${OPENVIKING_VERSION}' else 'openviking version %s != ${OPENVIKING_VERSION}' % v)" \
    && "${OPENVIKING_VENV}/bin/python" -c "import importlib.metadata as m, sys; v=m.version('llama-cpp-python'); sys.exit(0 if v=='${LLAMA_CPP_PYTHON_VERSION}' else 'llama-cpp-python %s != ${LLAMA_CPP_PYTHON_VERSION}' % v)" \
    && "${OPENVIKING_VENV}/bin/python" -c "import llama_cpp" \
    && test -x "${OPENVIKING_VENV}/bin/openviking-server" \
    && rm -rf /var/lib/apt/lists/* \
    || { echo "FATAL: openviking==${OPENVIKING_VERSION} / llama-cpp-python==${LLAMA_CPP_PYTHON_VERSION} failed verification" >&2; exit 1; }

# The container user. 1001 matches the templated VM image; on a plain host,
# build with REVIEW_UID=$(id -u) (compose: QCR_UID) so the bind-mounted repo
# is writable by the container (`npm ci`/`npm run build` run in the mount).
# --non-unique because 24.04 already ships an `ubuntu` user at 1000, and HOME
# is set EXPLICITLY below — the lesson: a uid collision otherwise
# leaves $HOME on the colliding user and the pihome volume mounted elsewhere,
# silently costing the pi OAuth login on every rebuild.
ARG REVIEW_UID=1001
RUN useradd --create-home --non-unique --uid ${REVIEW_UID} review
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod 0755 /usr/local/bin/entrypoint.sh

# The entrypoint provisions OpenViking against the venv this image built.
ENV QCR_OPENVIKING_VENV=${OPENVIKING_VENV}
ENV HOME=/home/review

USER review
WORKDIR /opt/quickreview/sandbox
EXPOSE ${WEBHOOK_PORT}

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
