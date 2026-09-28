# qcr-bench — the AACR-Bench sandbox image.
#
#   docker build --target runtime -t qcr-bench -f bench/aacr/Dockerfile .      (bench.sh build)
#   docker build --target ocr --build-arg RUNTIME_BASE=node:22-trixie \
#                -t qcr-bench-ocr -f bench/aacr/Dockerfile .                  (bench.sh build --arm ocr)
#   docker build --target opencode -t qcr-bench-opencode -f bench/aacr/Dockerfile .
#                                                                        (bench.sh build --arm opencode)
#
# One image, three uses, each run by bench.sh with its own minimal mounts:
#   prefetch  git over https to github.com (anonymous) → the repos volume
#   review    pi + the production reviewer, model API only, repos read-only
#   eval      Alibaba's own scorer (alibaba/aacr-bench evaluation/, pinned)
#
# The `ocr` target is the SAME runtime (same harness, dataset, pi and judge
# shim) plus the open-code-review baseline arm: the pinned OCR binary and the
# loopback Codex bridge (codex_bridge.py). It needs git >= 2.41 (OCR's
# documented floor), which bookworm (2.39) and bookworm-backports lack — hence
# RUNTIME_BASE=node:22-trixie (git 2.47) for that target only.
#
# What it deliberately does NOT contain: `scripts/` (the posting route,
# mint-token.sh), the `gh` CLI, any GitHub credential, the OpenViking memory
# server, tmux, or the daemon's secrets dir. A review in here cannot post,
# because nothing in the image knows how.
#
# Pins — each one a rule-7-style pin, bumped only on purpose:
#   pi 0.87.1                          = config.toml [pi], package.json "pi"
#   aacr-bench harness 68a5697         = the scorer's code
#   AACR-Bench dataset v1.0 ab8af8d    = what every published row is scored on;
#                                        its sha256 is verified at build time
#   open-code-review 1.3.1 (ocr only)  = the version most leaderboard rows ran;
#                                        the linux-amd64 binary's sha256 is pinned
#   opencode-ai 1.18.33 (opencode only) = the linux-x64 binary's sha256 is pinned

ARG RUNTIME_BASE=node:22-bookworm

# ---- build: compile the repo exactly as `npm run build` does ------------------
FROM node:22-bookworm AS build
WORKDIR /src
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci --no-audit --no-fund
COPY src ./src
COPY extensions ./extensions
RUN npx tsc -p tsconfig.json && npm prune --omit=dev --no-audit --no-fund

# ---- runtime -------------------------------------------------------------------
FROM ${RUNTIME_BASE} AS runtime

ENV DEBIAN_FRONTEND=noninteractive TZ=UTC LANG=C.UTF-8
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates git jq ripgrep fd-find python3 python3-venv \
    && ln -s /usr/bin/fdfind /usr/local/bin/fd \
    && rm -rf /var/lib/apt/lists/*

ARG PI_PACKAGE=@earendil-works/pi-coding-agent
ARG PI_VERSION=0.87.1
RUN npm install -g ${PI_PACKAGE}@${PI_VERSION} --no-audit --no-fund

# The scorer, at a pinned commit, in its own venv with its own locked deps.
ARG AACR_BENCH_REPO=https://github.com/alibaba/aacr-bench.git
ARG AACR_BENCH_COMMIT=68a569759289a83654a59d06db2a72910edf0a4a
ARG AACR_V1_COMMIT=ab8af8d5c74e2a4d1945d247ea4bbc49f93eb33f
ARG AACR_V1_SHA256=d8683cb240249bc4e0aff6428802bdffa7b7573ace600552cab1cd0cb7e905c9
RUN git clone --quiet ${AACR_BENCH_REPO} /opt/aacr-bench \
    && git -C /opt/aacr-bench checkout --quiet ${AACR_BENCH_COMMIT} \
    && mkdir -p /opt/aacr-data \
    && git -C /opt/aacr-bench show ${AACR_V1_COMMIT}:dataset/positive_samples.json > /opt/aacr-data/positive_samples.json \
    && echo "${AACR_V1_SHA256}  /opt/aacr-data/positive_samples.json" | sha256sum -c - \
    && python3 -m venv /opt/aacr-venv \
    && /opt/aacr-venv/bin/pip install --quiet --no-cache-dir -r /opt/aacr-bench/evaluation/requirements.txt \
    && cd /opt/aacr-bench/evaluation \
    && PYTHONDONTWRITEBYTECODE=1 /opt/aacr-venv/bin/python -m converters.aacr_bench \
         --input /opt/aacr-data/positive_samples.json \
         --output /opt/aacr-data/aacr_bench_v1.jsonl --seed 42 --validate \
    && test "$(wc -l < /opt/aacr-data/aacr_bench_v1.jsonl)" = "196"

# The production tree at the VM's own path, so every path the prompts, the
# agents and the extensions mention means the same thing it means live. Only
# what a review round reads: no scripts/, no deploy/, no docs/, no tests/.
WORKDIR /opt/quickreview/sandbox
COPY --from=build /src/node_modules ./node_modules
COPY --from=build /src/dist ./dist
# AGENTS.md AND CLAUDE.md, as the VM's rsync ships them: pi loads the FIRST of
# AGENTS.override.md → AGENTS.md → CLAUDE.md from the cwd, so without
# AGENTS.md every bench session would read the 80 KB dev manual instead of
# what production reviewers read.
COPY package.json config.toml AGENTS.md CLAUDE.md ./
# …and the reviewer context stub the VM entrypoint installs at boot
# (deploy/reviewer/AGENTS.override.md): pi takes it FIRST, so bench sessions
# and passes read the stub, exactly as production's do.
COPY deploy/reviewer/AGENTS.override.md ./AGENTS.override.md
# The project .pi/ (settings.json: httpIdleTimeoutMs) is baked OUTSIDE the tree
# and seeded into a tmpfs .pi/ at start (in-container.sh): pi takes a lock
# beside settings.json on every read, which a read-only root refuses — and pi
# then IGNORES the file ("Invalid settings file"), i.e. runs without the
# production project settings.
COPY .pi /opt/quickreview/bench/pi-project
COPY src ./src
COPY extensions ./extensions
COPY prompts ./prompts
COPY agents ./agents
COPY profiles ./profiles
COPY bench/aacr/sets /opt/quickreview/bench/sets
COPY bench/aacr/defects /opt/quickreview/bench/defects
COPY bench/aacr/judge_shim.py bench/aacr/in-container.sh bench/aacr/eval_shards.py /opt/quickreview/bench/

# Writable points — every one is replaced at run time by a tmpfs or an
# anonymous volume (bench.sh runs with --read-only); created here so they
# exist, world-writable, whatever uid the host maps in.
RUN mkdir -p wt state .pi /repos /bench-out /pi-agent-src \
    && chmod 1777 wt state .pi /repos /bench-out \
    && chmod 0755 /opt/quickreview/bench/in-container.sh \
    && ! test -e scripts && ! command -v gh

ARG QCR_BENCH_COMMIT=unknown
ENV QCR_BENCH_COMMIT=${QCR_BENCH_COMMIT} \
    PYTHONDONTWRITEBYTECODE=1 \
    HOME=/tmp/home \
    PI_CODING_AGENT_DIR=/tmp/pi-agent

ENTRYPOINT ["/opt/quickreview/bench/in-container.sh"]

# ---- opencode: the OpenCode arm ----------------------------------------------------
# Placed ABOVE `ocr` on purpose: without BuildKit (this PC has no buildx),
# `docker build --target X` builds every stage above X, and the ocr stage
# refuses bookworm's git — a stage on the default runtime base below it would
# never build.
# Built on top of `runtime`, so the scorer, the dataset, pi, the judge shim and
# the harness's own MCP findings server (evaluation/mcp_codex_finding_server.py,
# run by /opt/aacr-venv) are the ones every other arm is scored with. OpenCode
# is the `opencode-ai` npm package's linux-x64 binary, installed as its platform
# package directly (the `opencode-ai` wrapper only links it in a postinstall
# script) and checked against the sha256 recorded HERE.
# To bump: `npm pack opencode-linux-x64@<v>`, `sha256sum package/bin/opencode`,
# then set both ARGs below (or pass QCR_BENCH_OPENCODE_VERSION +
# QCR_BENCH_OPENCODE_SHA256 to `bench.sh build --arm opencode`) and re-run the
# smoke test — src/bench/opencode.ts reads OpenCode's --format json events and
# its built-in `review` command, neither of which is a stable contract.
FROM runtime AS opencode
ARG OPENCODE_VERSION=1.18.33
ARG OPENCODE_SHA256_LINUX_X64=0abbb7c32ab0294c0a7bfa2705f9ff0df5dce5ab721d1f00cccfe393f2a11427
RUN test "$(dpkg --print-architecture)" = amd64 \
    && npm install -g opencode-linux-x64@${OPENCODE_VERSION} --no-audit --no-fund \
    && OPENCODE_BIN="$(npm root -g)/opencode-linux-x64/bin/opencode" \
    && echo "${OPENCODE_SHA256_LINUX_X64}  ${OPENCODE_BIN}" | sha256sum -c - \
    && ln -s "${OPENCODE_BIN}" /usr/local/bin/opencode \
    && test "$(HOME=/tmp OPENCODE_DISABLE_AUTOUPDATE=1 opencode --version)" = "${OPENCODE_VERSION}"
COPY bench/aacr/codex_bridge.py /opt/quickreview/bench/
RUN python3 /opt/quickreview/bench/codex_bridge.py --self-test \
    && test -f /opt/aacr-bench/evaluation/mcp_codex_finding_server.py \
    && /opt/aacr-venv/bin/python -c "import mcp.server.fastmcp" \
    && ! test -e scripts && ! command -v gh
ENV OPENCODE_DISABLE_AUTOUPDATE=1 OPENCODE_DISABLE_SHARE=1 OPENCODE_DISABLE_MODELS_FETCH=1 \
    OPENCODE_DISABLE_LSP_DOWNLOAD=1 OPENCODE_DISABLE_DEFAULT_PLUGINS=1 OPENCODE_DISABLE_PROJECT_CONFIG=1 \
    QCR_OPENCODE_VERSION=${OPENCODE_VERSION}

# ---- ocr: the open-code-review baseline arm --------------------------------------
# Built on top of `runtime`, so the scorer, the dataset, pi and the judge shim
# are the ones the quickreviewd arm is scored with. OCR is installed from npm at
# the pinned version, and its downloaded binary is checked against the sha256
# recorded HERE (npm's installer checks it only against the release's own
# sha256sum.txt). The bench calls the binary directly: the npm `ocr` wrapper
# spawns a background self-update check on every run.
FROM runtime AS ocr
ARG OCR_VERSION=1.3.1
ARG OCR_SHA256_LINUX_AMD64=7b7478be6200fba0aaa7feffd4177a951952edf5ae8cdd03ea5bfe5b8b0a703c
RUN test "$(dpkg --print-architecture)" = amd64 \
    && npm install -g @alibaba-group/open-code-review@${OCR_VERSION} --no-audit --no-fund \
    && OCR_BIN="$(npm root -g)/@alibaba-group/open-code-review/bin/opencodereview" \
    && echo "${OCR_SHA256_LINUX_AMD64}  ${OCR_BIN}" | sha256sum -c - \
    && ln -s "${OCR_BIN}" /usr/local/bin/opencodereview \
    && git version | awk '{split($3, v, "."); exit !(v[1] > 2 || (v[1] == 2 && v[2] >= 41))}' \
    && OCR_NO_UPDATE=1 opencodereview version
COPY bench/aacr/codex_bridge.py /opt/quickreview/bench/
RUN python3 /opt/quickreview/bench/codex_bridge.py --self-test \
    && ! test -e scripts && ! command -v gh
ENV OCR_NO_UPDATE=1 QCR_OCR_VERSION=${OCR_VERSION}
