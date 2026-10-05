# qcr-bench — the AACR-Bench sandbox image.
#
#   docker build --target runtime -t qcr-bench -f bench/aacr/Dockerfile .      (bench.sh build)
#   docker build --target ocr --build-arg RUNTIME_BASE=node:22-trixie \
#                -t qcr-bench-ocr -f bench/aacr/Dockerfile .                  (bench.sh build --arm ocr)
#   docker build --target codex -t qcr-bench-codex -f bench/aacr/Dockerfile .  (bench.sh build --arm codex)
#   docker build --target opencode -t qcr-bench-opencode -f bench/aacr/Dockerfile .
#                                                                        (bench.sh build --arm opencode)
#   docker build --target claude --build-arg RUNTIME_BASE=node:22-trixie \
#                -t qcr-bench-claude -f bench/aacr/Dockerfile .               (bench.sh build --arm claude)
#   docker build --target pireview -t qcr-bench-pireview -f bench/aacr/Dockerfile .
#                                                                        (bench.sh build --arm pireview)
#   docker build --target pragent --build-arg RUNTIME_BASE=node:22-trixie \
#                -t qcr-bench-pragent -f bench/aacr/Dockerfile .              (bench.sh build --arm pragent)
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
#   pi 1.0.0                           = config.toml [pi], package.json "pi"
#   aacr-bench harness 68a5697         = the scorer's code
#   AACR-Bench dataset v1.0 ab8af8d    = what every published row is scored on;
#                                        its sha256 is verified at build time
#   open-code-review 1.3.1 (ocr only)  = the version most leaderboard rows ran;
#                                        the linux-amd64 binary's sha256 is pinned
#   Codex CLI 0.158.0 (codex only)     = @openai/codex; the linux-x64 binary's
#                                        sha256 is pinned (CODEX_SHA256_LINUX_X64)
#   opencode-ai 1.18.33 (opencode only) = the linux-x64 binary's sha256 is pinned
#   Claude Code 2.1.283 (claude only)  = the version the Claude Code arm ran; the
#                                        linux-x64 native binary's sha256 is pinned
#   @zephyrdeng/pi-review 0.18.0       = the npm tarball's sha512 (= the registry's
#     (pireview only)                    dist.integrity) is pinned; runs on the pi above
#   pr-agent 0.46.0 (pragent only)     = qodo-ai/pr-agent's PyPI wheel, its sha256 pinned
#                                        (= PyPI's digest); Python 3.13 (trixie)

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
ARG PI_VERSION=1.0.0
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
# AGENTS.md, as the VM's rsync ships it: pi loads the FIRST of
# AGENTS.override.md → AGENTS.md → CLAUDE.md from the cwd. The image ships the
# override (below), so a CLAUDE.md would never be read — and it is not part of
# the public tree, so it is not copied.
COPY package.json config.toml AGENTS.md ./
# That config.toml is the one bench.sh baked in (QCR_BENCH_CONFIG, else the
# operator's own via the install locator,, else config.example.toml).
# Named explicitly so the locator inside the image takes it as given.
ENV QCR_CONFIG=/opt/quickreview/sandbox/config.toml
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

# ---- codex: the Codex CLI arm (bench.sh build --arm codex) ----------------------
# Placed BEFORE `ocr`: the legacy builder builds every stage up to the target
# in file order, and `ocr` needs a trixie base.
# The SAME runtime plus the Codex CLI at a pinned version, run the way the
# AACR harness's own evaluation/reviewers/codex.py runs it (bench/aacr/
# codex_arm.py imports that runner). Bump: change CODEX_VERSION (and the
# sha256 of the linux-x64 binary it ships), rebuild with bench.sh build --arm
# codex, and record the bump in bench/aacr/README.md.
FROM runtime AS codex
ARG CODEX_VERSION=0.158.0
ARG CODEX_SHA256_LINUX_X64=167c0148a849d2444f1b5a7fb5f8bb2de1de5ae13a2a504b833fc765980f5cd9
RUN test "$(dpkg --print-architecture)" = amd64 \
    && npm install -g @openai/codex@${CODEX_VERSION} --no-audit --no-fund \
    && echo "${CODEX_SHA256_LINUX_X64}  $(npm root -g)/@openai/codex/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex" | sha256sum -c - \
    && codex --version | grep -qx "codex-cli ${CODEX_VERSION}"
COPY bench/aacr/codex_arm.py /opt/quickreview/bench/
RUN /opt/aacr-venv/bin/python /opt/quickreview/bench/codex_arm.py --self-test \
    && ! test -e scripts && ! command -v gh
ENV QCR_CODEX_VERSION=${CODEX_VERSION}

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

# ---- pireview: @zephyrdeng/pi-review, a pi code-review package ---------------------
# Above `ocr` for the same reason as opencode (no BuildKit here). Built on
# `runtime`, so pi (1.0.0 — the pin every arm shares), the scorer, the dataset
# and the judge shim are the ones every other arm is scored with. The npm
# TARBALL is fetched with `npm pack`, checked against the sha512 recorded HERE
# (the registry's own dist.integrity for that version), and unpacked — never
# `npm install`ed: its CLI (dist/) imports nothing but node builtins, and its
# one dependency (typebox, a floating ^range) serves only the pi-extension half
# the bench does not load. No install scripts run.
# To bump: `npm view @zephyrdeng/pi-review@<v> dist.integrity`, base64-decode it
# to hex (`echo <b64> | base64 -d | xxd -p -c 100`), set both ARGs (or pass
# QCR_BENCH_PIREVIEW_VERSION + QCR_BENCH_PIREVIEW_SHA512 to `bench.sh build
# --arm pireview`), re-read its prompt contract (dist/prompt.js,
# resources/system-prompt.md) and its PI_REVIEW_META_JSON shape, and re-run the
# smoke test — src/bench/pireview.ts reads that line.
FROM runtime AS pireview
ARG PIREVIEW_VERSION=0.18.0
ARG PIREVIEW_SHA512=5b5910dfde9730d38c64120a221be624a50fa5efd089a5fc4f8d8d9e00b49241584a1b6f2061cc6c557fa5f7b68b3f06afebece4440dbb489a2551cb8b909a99
RUN mkdir -p /tmp/pr-build && cd /tmp/pr-build \
    && npm pack "@zephyrdeng/pi-review@${PIREVIEW_VERSION}" --silent >/dev/null \
    && echo "${PIREVIEW_SHA512}  zephyrdeng-pi-review-${PIREVIEW_VERSION}.tgz" | sha512sum -c - \
    && mkdir -p /opt/pi-review \
    && tar -xzf "zephyrdeng-pi-review-${PIREVIEW_VERSION}.tgz" -C /opt/pi-review --no-same-owner \
    && chmod 0755 /opt/pi-review/package/bin/pi-review.js \
    && ln -s /opt/pi-review/package/bin/pi-review.js /usr/local/bin/pi-review \
    && test "$(node -p 'require("/opt/pi-review/package/package.json").version')" = "${PIREVIEW_VERSION}" \
    && HOME=/tmp/pr-build pi-review --help | grep -q 'pi-review \[review\] \[options\]' \
    && cd / && rm -rf /tmp/pr-build /root/.npm \
    && mkdir -p /work && chmod 1777 /work
RUN ! test -e scripts && ! command -v gh
ENV QCR_PIREVIEW_VERSION=${PIREVIEW_VERSION} PI_OFFLINE=1 PI_SKIP_VERSION_CHECK=1 PI_TELEMETRY=0

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

# ---- claude: Claude Code as a BENCHMARKED REVIEWER --------------------------------
# Root CLAUDE.md rule 5's ONE ratified exception (2026-09-28): `claude`
# exists in this target only and runs only inside its hardened review container
# (bench.sh --arm claude) — never on the host. Built on `runtime`, so the scorer,
# the dataset, pi and the judge shim are the ones every other arm is scored with.
# Pinned like OCR: the npm version here, and the linux-x64 native binary's sha256
# checked against the value recorded HERE (npm checks only the registry's own
# integrity). `/code-review` is Claude Code's built-in skill — nothing else is
# installed. The run is `claude_driver.py` → the harness's reviewers/claude.py.
# No credential is baked: bench.sh passes bench/aacr/claude.env with --env-file.
FROM runtime AS claude
ARG CLAUDE_CODE_VERSION=2.1.283
ARG CLAUDE_CODE_SHA256_LINUX_X64=1859583ce32920595c61ef868bee52e1b1594f7486db209935e01f1e5e804ae2
ENV DISABLE_AUTOUPDATER=1 \
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 \
    DISABLE_TELEMETRY=1 \
    DISABLE_ERROR_REPORTING=1 \
    DISABLE_BUG_COMMAND=1 \
    CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY=1 \
    CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL=1
RUN test "$(dpkg --print-architecture)" = amd64 \
    && npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} --no-audit --no-fund \
    && CC_BIN="$(readlink -f "$(command -v claude)")" \
    && echo "${CLAUDE_CODE_SHA256_LINUX_X64}  ${CC_BIN}" | sha256sum -c - \
    && grep -q '/code-review low' "${CC_BIN}" \
    && HOME=/tmp/cc-build claude --version | tee /opt/quickreview/bench/claude-version.txt \
    && grep -q "^${CLAUDE_CODE_VERSION} " /opt/quickreview/bench/claude-version.txt \
    && rm -rf /tmp/cc-build
COPY bench/aacr/claude_driver.py /opt/quickreview/bench/
# The driver against a stub `claude` through the PINNED harness runner: the
# argv shape claudecode.ts checks and the result shape the scorer reads.
RUN HOME=/tmp/cc-build /opt/aacr-venv/bin/python /opt/quickreview/bench/claude_driver.py --self-test \
    && /opt/aacr-venv/bin/python -c 'import mcp.server.fastmcp' \
    && rm -rf /tmp/cc-build /tmp/claude-driver-selftest-* \
    && mkdir -p /work && chmod 1777 /work \
    && ! test -e scripts && ! command -v gh
ENV QCR_CLAUDE_VERSION=${CLAUDE_CODE_VERSION}

# ---- pragent: PR-Agent (qodo-ai/pr-agent, MIT) --------------------------------------
# Last, on the trixie runtime (RUNTIME_BASE=node:22-trixie, as for ocr/claude):
# pr-agent requires Python >= 3.12 and bookworm ships 3.11. Built on `runtime`,
# so the scorer, the dataset, pi and the judge shim are the ones every other arm
# is scored with. The PyPI WHEEL is downloaded alone (--no-deps), checked against
# the sha256 recorded HERE (PyPI's own digest for that file), then installed into
# its own venv; its dependencies resolve from PyPI under pr-agent's own pins
# (litellm==1.101.0 and most others are exact), and the resolved set is frozen
# into /opt/pragent-venv/freeze.txt for the record. The run is
# bench/aacr/pragent_driver.py → pr_agent.cli (review, improve) on the local git
# provider; the model through the loopback Codex bridge.
# To bump: `curl -s https://pypi.org/pypi/pr-agent/<v>/json` → the wheel's
# `digests.sha256`, set both ARGs (or pass QCR_BENCH_PRAGENT_VERSION +
# QCR_BENCH_PRAGENT_SHA256 to `bench.sh build --arm pragent`), re-read the local
# provider, the reviewer's structured-review hook and /improve's artifact path
# (pragent_driver.py relies on all three), and re-run the smoke test.
FROM runtime AS pragent
ARG PRAGENT_VERSION=0.46.0
ARG PRAGENT_SHA256=6a37f507cc3bf0cb00be79b8b96e7885bf35b27a905adb1926965af839f247f5
RUN python3 -c 'import sys; assert sys.version_info >= (3, 12), sys.version' \
    && python3 -m venv /opt/pragent-venv \
    && mkdir -p /tmp/pa \
    && /opt/pragent-venv/bin/pip download --quiet --no-cache-dir --no-deps --only-binary=:all: \
         -d /tmp/pa "pr-agent==${PRAGENT_VERSION}" \
    && echo "${PRAGENT_SHA256}  /tmp/pa/pr_agent-${PRAGENT_VERSION}-py3-none-any.whl" | sha256sum -c - \
    && /opt/pragent-venv/bin/pip install --quiet --no-cache-dir "/tmp/pa/pr_agent-${PRAGENT_VERSION}-py3-none-any.whl" \
    && /opt/pragent-venv/bin/pip freeze > /opt/pragent-venv/freeze.txt \
    && test "$(/opt/pragent-venv/bin/python -c 'import importlib.metadata as m; print(m.version("pr-agent"))')" = "${PRAGENT_VERSION}" \
    && rm -rf /tmp/pa /root/.cache
COPY bench/aacr/codex_bridge.py bench/aacr/pragent_driver.py /opt/quickreview/bench/
# The driver end to end — PR-Agent's CLI, both commands, the bench provider —
# against an in-process stub endpoint on a scratch repo (no network).
RUN python3 /opt/quickreview/bench/codex_bridge.py --self-test \
    && HOME=/tmp/pa-home LITELLM_LOCAL_MODEL_COST_MAP=True \
       /opt/pragent-venv/bin/python /opt/quickreview/bench/pragent_driver.py --self-test \
    && rm -rf /tmp/pa-home /tmp/pragent-selftest-* \
    && ! test -e scripts && ! command -v gh
ENV QCR_PRAGENT_VERSION=${PRAGENT_VERSION} LITELLM_LOCAL_MODEL_COST_MAP=True
