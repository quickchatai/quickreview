# The memory sidecar image: OpenViking, its venv, llama-cpp-python and the
# pinned GGUF, run by the same supervisors the daemon uses in-container.
#
#   docker build -f docker/memory/Dockerfile -t qcr-memory .
#
# The build context is the repo root, narrowed by
# docker/memory/Dockerfile.dockerignore (BuildKit reads it in preference to the
# root .dockerignore).
#
# WHAT IT IS. The daemon's `[openviking] endpoint = "local"` (the default, and
# every live daemon today) supervises the server and the local embedder as its
# own children, in its own container. With `endpoint = "remote"` the daemon
# only probes a server somebody else runs, and THIS image is that somebody:
# entrypoint.sh renders ov.conf, runs the embedder migration's `prepare`, and
# provisions the users, then execs src/openviking/sidecar-main.ts, which
# supervises the server and the embedder and drives the re-embed.
#
# The four OpenViking pins of CLAUDE.md rule 7 move here intact (the vendored
# extension's base commit rides the repo, not an image). The ARG defaults below
# are a MIRROR of config.toml [openviking] and deploy/ansible/group_vars/
# all.yml: tests/memory-image.test.ts fails the moment one drifts, the same
# discipline as the release image's pins (tests/release-image.test.ts). Bump a
# pin deliberately - config.toml + group_vars + this Dockerfile together, never
# one alone - and never change the embedder under a live store without the
# re-embed migration (docs/memory-embeddings.md).
ARG NODE_MAJOR=22

# ---- build ---------------------------------------------------------------------
# Compiles the TypeScript; the sidecar ships dist/ and the one runtime package
# its import closure reaches (smol-toml - tests/memory-image.test.ts holds the
# closure to the COPY below).
FROM node:${NODE_MAJOR}-bookworm AS build
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY scripts/verify-dist.mjs scripts/verify-dist.mjs
COPY src src
COPY extensions extensions
RUN npx tsc -p tsconfig.json && node scripts/verify-dist.mjs

# ---- memory --------------------------------------------------------------------
FROM ubuntu:24.04 AS memory

# ---- pinned versions (mirror of config.toml + group_vars; see header) -----------
ARG TZ=Europe/Warsaw
ARG NODE_MAJOR
ARG OPENVIKING_VERSION=0.4.15
ARG LLAMA_CPP_PYTHON_VERSION=0.3.35
ARG OPENVIKING_VENV=/opt/openviking/venv
ARG LOCAL_EMBEDDER_MODEL=bge-small-en-v1.5-f16
ARG LOCAL_EMBEDDER_DIR=/opt/openviking/models
ARG LOCAL_EMBEDDER_URL=https://huggingface.co/CompendiumLabs/bge-small-en-v1.5-gguf/resolve/d32f8c040ea3b516330eeb75b72bcc2d3a780ab7/bge-small-en-v1.5-f16.gguf
ARG LOCAL_EMBEDDER_SHA256=f0b2fef971e8366438bfd2d9aefea1b0115919389448806d290237f638bae999
ARG OPENVIKING_PORT=1933
# set by buildx per platform: the llama build below targets it, never the build host
ARG TARGETARCH

ENV DEBIAN_FRONTEND=noninteractive \
    TZ=${TZ}

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl tzdata \
      build-essential python3 \
    && rm -rf /var/lib/apt/lists/*

# Node (NodeSource): the supervisors and the boot scripts are node.
RUN curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# OpenViking - the context store, in its own venv so its ~90 Python deps never
# collide with anything system-side.
#
# llama-cpp-python is installed FIRST and deliberately: it is NOT an openviking
# dependency but an undeclared optional extra, and without it the default local
# dense embedder raises EmbeddingConfigurationError at startup - the official
# image cannot boot (verified against a running 0.4.15). It is also the
# runtime of the local English embedder (the model layer below). Do not "clean
# it up".
#
# Both versions come from the ARG mirror above (== config.toml [openviking] ==
# group_vars); a literal here would be exactly the drift the pin prevents. The
# layer hard-fails unless the INSTALLED distribution reports the pinned version
# and the server entry point exists.
#
# llama-cpp-python compiles llama.cpp from source, and by default for the BUILD
# host's CPU (-march=native). CI's runners have AVX-512; the VM's Xeon does not,
# so a native build dies of SIGILL on the VM (the 1.0.2 cutover). The build is
# therefore portable: on amd64 the AVX2 level (AVX, AVX2, FMA, F16C) and nothing
# newer, on arm64 the architecture's baseline. The layer then refuses a library
# that carries AVX-512, VNNI or AMX instructions, because CI's own smoke runs on
# a CPU that has them and could never see the crash.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3-venv python3-dev cmake \
    && python3 -m venv "${OPENVIKING_VENV}" \
    && "${OPENVIKING_VENV}/bin/pip" install --no-cache-dir --upgrade pip \
    && arch="${TARGETARCH:-$(dpkg --print-architecture)}" \
    && case "$arch" in \
         amd64) llama_cmake="-DGGML_NATIVE=OFF -DGGML_AVX=ON -DGGML_AVX2=ON -DGGML_FMA=ON -DGGML_F16C=ON -DGGML_AVX_VNNI=OFF -DGGML_AVX512=OFF -DGGML_AVX512_VBMI=OFF -DGGML_AVX512_VNNI=OFF -DGGML_AVX512_BF16=OFF -DGGML_AMX_TILE=OFF -DGGML_AMX_INT8=OFF -DGGML_AMX_BF16=OFF" ;; \
         *) llama_cmake="-DGGML_NATIVE=OFF" ;; \
       esac \
    && CMAKE_ARGS="$llama_cmake" "${OPENVIKING_VENV}/bin/pip" install --no-cache-dir --no-binary llama-cpp-python "llama-cpp-python==${LLAMA_CPP_PYTHON_VERSION}" \
    && if [ "$arch" = amd64 ]; then \
         libs="$(find "${OPENVIKING_VENV}" -path '*llama_cpp*' -name '*.so*' -type f)" \
         && [ -n "$libs" ] \
         && for so in $libs; do \
              if objdump -d --no-show-raw-insn "$so" | grep -qE '%zmm|vpdpbusd|vpdpwssd|tdpb|tileloadd'; then \
                echo "FATAL: $so carries AVX-512/VNNI/AMX instructions: the VM cannot run it (SIGILL)" >&2; exit 1; \
              fi; \
            done; \
       fi \
    && "${OPENVIKING_VENV}/bin/pip" install --no-cache-dir "openviking==${OPENVIKING_VERSION}" \
    && "${OPENVIKING_VENV}/bin/python" -c "import importlib.metadata as m, sys; v=m.version('openviking'); sys.exit(0 if v=='${OPENVIKING_VERSION}' else 'openviking version %s != ${OPENVIKING_VERSION}' % v)" \
    && "${OPENVIKING_VENV}/bin/python" -c "import importlib.metadata as m, sys; v=m.version('llama-cpp-python'); sys.exit(0 if v=='${LLAMA_CPP_PYTHON_VERSION}' else 'llama-cpp-python %s != ${LLAMA_CPP_PYTHON_VERSION}' % v)" \
    && "${OPENVIKING_VENV}/bin/python" -c "import llama_cpp" \
    && test -x "${OPENVIKING_VENV}/bin/openviking-server" \
    && rm -rf /var/lib/apt/lists/* \
    || { echo "FATAL: openviking==${OPENVIKING_VERSION} / llama-cpp-python==${LLAMA_CPP_PYTHON_VERSION} failed verification" >&2; exit 1; }

# The LOCAL ENGLISH EMBEDDER's model file - pinned by URL AND sha256 (the ARG
# mirror above == config.toml [openviking] local_embedder_* == group_vars
# openviking_local_embedder_*). Downloaded HERE, at build time, so the running
# container never fetches a model (the sidecar boots offline); the layer
# hard-fails unless the bytes hash to the pin, and scripts/openviking-embedder.py
# re-checks the hash at every start. Carried whatever the configured provider.
RUN mkdir -p "${LOCAL_EMBEDDER_DIR}" \
    && curl -fsSL --retry 3 -o "${LOCAL_EMBEDDER_DIR}/${LOCAL_EMBEDDER_MODEL}.gguf" "${LOCAL_EMBEDDER_URL}" \
    && echo "${LOCAL_EMBEDDER_SHA256}  ${LOCAL_EMBEDDER_DIR}/${LOCAL_EMBEDDER_MODEL}.gguf" | sha256sum -c - \
    && chmod 0444 "${LOCAL_EMBEDDER_DIR}/${LOCAL_EMBEDDER_MODEL}.gguf" \
    || { echo "FATAL: the local embedder model ${LOCAL_EMBEDDER_MODEL} failed to download or does not match its pinned sha256" >&2; exit 1; }
# ...and the image TELLS its entrypoint which file it carries, so the boot
# renders from the image's pin, whatever ARGs it was built with.
ENV QCR_OPENVIKING_LOCAL_EMBEDDER_MODEL=${LOCAL_EMBEDDER_MODEL} \
    QCR_OPENVIKING_LOCAL_EMBEDDER_DIR=${LOCAL_EMBEDDER_DIR} \
    QCR_OPENVIKING_LOCAL_EMBEDDER_SHA256=${LOCAL_EMBEDDER_SHA256} \
    QCR_OPENVIKING_VENV=${OPENVIKING_VENV} \
    QCR_OPENVIKING_PORT=${OPENVIKING_PORT}

# The pins this image carries, as labels the VM's updater and the deploy
# preflight read without running it (mirrors: config.toml [openviking] ==
# group_vars openviking_* == the ARGs above).
LABEL qcr.openviking="${OPENVIKING_VERSION}" \
      qcr.llama-cpp-python="${LLAMA_CPP_PYTHON_VERSION}" \
      qcr.embedder-file="${LOCAL_EMBEDDER_DIR}/${LOCAL_EMBEDDER_MODEL}.gguf" \
      qcr.embedder-sha256="${LOCAL_EMBEDDER_SHA256}"

# The app: root-owned, never written at run time. dist/ is the supervisors and
# the config parser; scripts/ is the boot provisioning, the migration and the
# embedder service; smol-toml is the one package config.ts reaches.
WORKDIR /opt/qcr
COPY package.json ./
COPY --from=build /src/dist ./dist
COPY --from=build /src/node_modules/smol-toml ./node_modules/smol-toml
COPY scripts ./scripts
COPY config.example.toml ./config.example.toml
COPY docker/memory/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod -R a+rX,go-w /opt/qcr && chmod 0755 /usr/local/bin/entrypoint.sh

# The container user. 1001 is the uid the daemon-era stores were
# written under, so one opens here without a chown. --non-unique because 24.04
# already ships an `ubuntu` user at 1000; HOME is set EXPLICITLY.
ARG REVIEW_UID=1001
RUN useradd --create-home --non-unique --uid ${REVIEW_UID} review
# The state mount point, owned by the container user: Docker seeds a fresh
# named volume from the image directory it is mounted over - a mount point the
# image lacks would be root-owned and unwritable.
RUN install -d -o review -g review /opt/quickreview/state /opt/quickreview/state/openviking
# Any uid: the compose stack runs this container as the operator's own uid (so
# the 0600 key files in the secrets mount stay readable), which owns neither
# the store nor HOME. World-writable and sticky, like the release image's.
RUN chmod 1777 /opt/quickreview/state /opt/quickreview/state/openviking /home/review
ENV HOME=/home/review \
    QCR_APP_ROOT=/opt/qcr

USER review
WORKDIR /opt/quickreview/state/openviking
# The port is the container network's, never published to a host.
EXPOSE ${OPENVIKING_PORT}
HEALTHCHECK --interval=30s --timeout=5s --start-period=120s --retries=3 \
    CMD curl -fsS "http://127.0.0.1:${QCR_OPENVIKING_PORT:-1933}/health" >/dev/null || exit 1

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
