# qcr-bench — the AACR-Bench sandbox image.
#
#   docker build -t qcr-bench -f bench/aacr/Dockerfile .      (bench.sh build)
#
# One image, three uses, each run by bench.sh with its own minimal mounts:
#   prefetch  git over https to github.com (anonymous) → the repos volume
#   review    pi + the production reviewer, model API only, repos read-only
#   eval      Alibaba's own scorer (alibaba/aacr-bench evaluation/, pinned)
#
# What it deliberately does NOT contain: `scripts/` (the posting route,
# mint-token.sh), the `gh` CLI, any GitHub credential, the OpenViking memory
# server, tmux, or the daemon's secrets dir. A review in here cannot post,
# because nothing in the image knows how.
#
# Pins — each one a rule-7-style pin, bumped only on purpose:
#   pi 0.84.4                          = config.toml [pi], package.json "pi"
#   aacr-bench harness 68a5697         = the scorer's code
#   AACR-Bench dataset v1.0 ab8af8d    = what every published row is scored on;
#                                        its sha256 is verified at build time

# ---- build: compile the repo exactly as `npm run build` does ------------------
FROM node:22-bookworm AS build
WORKDIR /src
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci --no-audit --no-fund
COPY src ./src
COPY extensions ./extensions
RUN npx tsc -p tsconfig.json && npm prune --omit=dev --no-audit --no-fund

# ---- runtime -------------------------------------------------------------------
FROM node:22-bookworm

ENV DEBIAN_FRONTEND=noninteractive TZ=UTC LANG=C.UTF-8
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates git jq ripgrep python3 python3-venv \
    && rm -rf /var/lib/apt/lists/*

ARG PI_PACKAGE=@earendil-works/pi-coding-agent
ARG PI_VERSION=0.84.4
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
COPY package.json config.toml CLAUDE.md ./
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
COPY bench/aacr/judge_shim.py bench/aacr/in-container.sh /opt/quickreview/bench/

# Writable points — every one is replaced at run time by a tmpfs or an
# anonymous volume (bench.sh runs with --read-only); created here so they
# exist, world-writable, whatever uid the host maps in.
RUN mkdir -p wt state .pi /repos /bench-out /pi-agent \
    && chmod 1777 wt state .pi /repos /bench-out \
    && chmod 0755 /opt/quickreview/bench/in-container.sh \
    && ! test -e scripts && ! command -v gh

ARG QCR_BENCH_COMMIT=unknown
ENV QCR_BENCH_COMMIT=${QCR_BENCH_COMMIT} \
    PYTHONDONTWRITEBYTECODE=1 \
    HOME=/tmp/home \
    PI_CODING_AGENT_DIR=/pi-agent

ENTRYPOINT ["/opt/quickreview/bench/in-container.sh"]
