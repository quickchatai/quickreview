#!/usr/bin/env bash
# The Elo judge's gpt-6.1-sol endpoint: ext_judge.py (the codex
# bridge) in the same hardened judge container bench/aacr/ext/ext.sh runs,
# at the plan's effort, published on loopback ONLY for elo.py on the host.
#
#   judge-gpt.sh start [--effort xhigh] [--port 8790]
#   judge-gpt.sh stop | status
#
# Credentials are ext.sh's: by default the container copies the companion's
# pi login into a refresh-disabled sandbox copy (`cli.js auth --need-min 120`
# refuses a token with less than two hours left — restart the container for a
# longer run); QCR_BENCH_AUTH=api-key uses OPENAI_API_KEY from
# bench/aacr/openai.env against the public API instead (272k-token window
# there, too small for this judge's 400k ceiling — the login route has 500k).
# The bridge code is mounted from this checkout, so the judge runs the code
# in this tree, not the copy baked into the image.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AACR="$(cd "$HERE/.." && pwd)"
NAME="qcr-elo-judge-gpt"
# ext.sh's default judge image (pi099-ext) fails `cli.js auth` with a missing
# module; this image's does not.
JIMG="${QCR_EXT_JUDGE_IMAGE:-qcr-bench:openbench-599732ba-ext}"
AUTH_VOLUME="${QCR_BENCH_AUTH_VOLUME:-companion-pihome}"
AUTH_MODE="${QCR_BENCH_AUTH:-login}"
OPENAI_ENV="${QCR_BENCH_OPENAI_ENV:-$AACR/openai.env}"
NET_EGRESS="qcr-ext-egress"
: "${QCR_BENCH_RUNS_DIR:?set QCR_BENCH_RUNS_DIR (outside any worktree)}"
LOGDIR="${QCR_ELO_JUDGE_LOG:-$QCR_BENCH_RUNS_DIR/../elo/judge-gpt-log}"

die() { echo "judge-gpt: $*" >&2; exit 1; }

cmd="${1:-}"; shift || true
EFFORT=xhigh
PORT=8790
while [[ $# -gt 0 ]]; do
  case "$1" in
    --effort) EFFORT="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    *) die "unknown argument $1" ;;
  esac
done

case "$cmd" in
  start)
    docker rm -f "$NAME" >/dev/null 2>&1 || true
    docker network inspect "$NET_EGRESS" >/dev/null 2>&1 || docker network create "$NET_EGRESS" >/dev/null
    mkdir -p "$LOGDIR"
    cred=()
    if [[ "$AUTH_MODE" == api-key ]]; then
      [[ -f "$OPENAI_ENV" && ! -L "$OPENAI_ENV" ]] && grep -qE '^OPENAI_API_KEY=.+' "$OPENAI_ENV" \
        || die "QCR_BENCH_AUTH=api-key needs OPENAI_API_KEY=<key> in $OPENAI_ENV (a regular file)"
      cred=(-e QCR_BENCH_AUTH=api-key --env-file "$OPENAI_ENV")
      auth_step="true"
    else
      [[ "$AUTH_MODE" == login ]] || die "QCR_BENCH_AUTH must be login | api-key"
      cred=(--mount "type=volume,src=$AUTH_VOLUME,dst=/pi-agent-src,volume-subpath=agent,readonly"
        --mount "type=tmpfs,dst=/pi-agent-src/sessions")
      auth_step="node /opt/quickreview/sandbox/dist/src/bench/cli.js auth --need-min 120"
    fi
    docker run -d --rm --name "$NAME" \
      --read-only --cap-drop ALL --security-opt no-new-privileges --pids-limit 4096 --user "$(id -u):$(id -g)" \
      --tmpfs /tmp:rw,exec,nosuid,size=2g,mode=1777 \
      --memory 2g --cpus 2 --network "$NET_EGRESS" -p "127.0.0.1:$PORT:8765" \
      "${cred[@]}" \
      --mount "type=bind,src=$AACR/codex_bridge.py,dst=/opt/elo/codex_bridge.py,readonly" \
      --mount "type=bind,src=$AACR/ext/ext_judge.py,dst=/opt/elo/ext_judge.py,readonly" \
      --mount "type=bind,src=$LOGDIR,dst=/judge-out" \
      --entrypoint bash "$JIMG" -c "mkdir -p \"\$HOME\" && $auth_step \
        && exec python3 /opt/elo/ext_judge.py --host 0.0.0.0 --port 8765 --model gpt-6.1-sol \
           --effort $EFFORT --max-inflight 8 --read-timeout 3600 --log /judge-out/judge.jsonl" >/dev/null
    for _ in $(seq 1 90); do
      if curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
        echo "judge-gpt: up on 127.0.0.1:$PORT (gpt-6.1-sol, effort $EFFORT); log $LOGDIR/judge.jsonl"
        exit 0
      fi
      sleep 1
    done
    docker logs "$NAME" 2>&1 | tail -20
    die "never answered /health on :$PORT"
    ;;
  stop) docker rm -f "$NAME" >/dev/null 2>&1 && echo "judge-gpt: stopped" || echo "judge-gpt: not running" ;;
  status) curl -fsS "http://127.0.0.1:$PORT/health" && echo || die "not answering on :$PORT" ;;
  *) die "usage: judge-gpt.sh start [--effort E] [--port P] | stop | status" ;;
esac
