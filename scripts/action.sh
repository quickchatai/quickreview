#!/usr/bin/env bash
# The composite Action's steps (action.yml), one verb each:
#
#   scripts/action.sh preflight   can this repository pull the private image?
#   scripts/action.sh login       docker login to the image's registry
#   scripts/action.sh run         one review of one PR, in a throwaway container
#   scripts/action.sh cleanup     remove everything the other verbs staged
#
# The composite calls this file so that what the Action does can be read, tested
# with a fake docker, and linted, instead of living inside YAML strings.
#
# What `run` hands the container, and nothing else (the host wrapper's call,
# scripts/qcr-host.sh, with the Action's differences):
#   - the workspace read-only at /repo (an empty git repository when the job
#     did not check one out), the generated config read-only, the pi login
#     directory read-only at /qcr-login, an anonymous volume for the state;
#   - QCR_ROUTE=action, so the review is not capped unless `limit` is set and
#     nothing is asked;
#   - the GitHub token as a read-once file (D39 amending R7): a 0600 file in a
#     fresh 0700 directory under $RUNNER_TEMP, mounted at /run/qcr-in and named
#     in QCR_GH_TOKEN_FILE. The token is in no `-e`, no `--env-file` and no
#     argument list; the image reads it and unlinks it before any pi or bash
#     child exists (src/ghcred.ts);
#   - model keys by NAME only (docker reads the value from this environment).
# The config is the image's own config.example.toml with two lines changed
# (`gen_config`): `dry_run = false`, because the Action is a live reviewer on
# the user's own repository, and `[openviking] enabled = false`, because the
# Action has no memory. Both are asserted before docker starts. No sidecar, no
# network flag, no other container.
#
# Environment (all set by action.yml):
#   RUNNER_TEMP                 required: where the staging directory lives
#   QCR_ACTION_PATH             the action checkout (default: this file's repo)
#   QCR_ACTION_IMAGE            an image reference; default: the registry path
#                               and version of package.json at the action's ref
#   QCR_ACTION_REGISTRY_USER    docker login user (default: the workflow actor)
#   QCR_ACTION_REGISTRY_TOKEN   a registry-only read:packages secret, used for
#                               docker login and the preflight only
#   QCR_ACTION_GH_TOKEN         the GitHub token: the registry login when no
#                               registry token is given, and the review's token
#   QCR_ACTION_PR, QCR_ACTION_REPO, QCR_ACTION_LIMIT, QCR_ACTION_PI_AUTH
#   QCR_REGISTRY_API            tests only: the registry's base URL
set -euo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP="${QCR_ACTION_PATH:-$(cd "$SELF_DIR/.." && pwd)}"
LOGIN_GID=4747

say() { echo "qcr-action: $*" >&2; }
# An annotation on stdout (what the runner parses) and the same on stderr.
die() {
  printf '::error::qcr action: %s\n' "$1"
  echo "qcr-action: FATAL: $*" >&2
  exit 1
}

work_dir() {
  [ -n "${RUNNER_TEMP:-}" ] || die "RUNNER_TEMP is not set: this runs as a workflow step"
  printf '%s\n' "$RUNNER_TEMP/qcr-action"
}

# ---- the image -------------------------------------------------------------------

# The image this version of the Action runs. The floating v1 tag points at a
# release commit, whose package.json is the image's version and whose
# repository URL is its registry path (the wrapper's rule, scripts/install-wrapper.sh).
resolve_image() {
  local image="${QCR_ACTION_IMAGE:-}"
  if [ -z "$image" ]; then
    command -v node >/dev/null 2>&1 || die "node is needed to read the image version from package.json (set the image input to skip it)"
    image="$(node -e '
      const pkg = require(process.argv[1]);
      const m = /github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?$/.exec(pkg.repository?.url ?? "");
      if (!m || !pkg.version) process.exit(1);
      console.log("ghcr.io/" + m[1].toLowerCase() + "/" + m[2].toLowerCase() + ":" + pkg.version);
    ' "$APP/package.json" 2>/dev/null)" ||
      die "cannot tell the image from $APP/package.json (repository url, version): set the image input"
  fi
  case "$image" in
    '' | -* | *[!A-Za-z0-9._/:@-]*) die "the image \"$image\" is not an image reference" ;;
  esac
  printf '%s\n' "$image"
}

# host, repository and tag-or-digest of an image reference.
IMG_HOST=''
IMG_REPO=''
IMG_REF=''
split_image() { # split_image <image>
  local i="$1" rest
  case "$i" in */*) ;; *) die "the image \"$i\" names no registry" ;; esac
  IMG_HOST="${i%%/*}"
  rest="${i#*/}"
  case "$rest" in
    *@*)
      IMG_REPO="${rest%%@*}"
      IMG_REF="${rest#*@}"
      ;;
    *:*)
      IMG_REPO="${rest%:*}"
      IMG_REF="${rest##*:}"
      ;;
    *)
      IMG_REPO="$rest"
      IMG_REF=latest
      ;;
  esac
}

# The credential for the registry: a registry-only secret when the workflow gave
# one, else the workflow's token. Echoes the user, then the token, on two lines.
registry_credential() {
  local user="${QCR_ACTION_REGISTRY_USER:-}" token="${QCR_ACTION_REGISTRY_TOKEN:-}"
  [ -n "$token" ] || token="${QCR_ACTION_GH_TOKEN:-}"
  [ -n "$user" ] || user="${GITHUB_ACTOR:-}"
  [ -n "$token" ] || die "no registry credential: pass github-token (the default is the workflow's token) or registry-token"
  [ -n "$user" ] || die "no registry user: pass registry-user"
  case "$user$token" in
    *[\"\\]* | *$'\n'*) die "the registry credential holds a character the preflight cannot send" ;;
  esac
  printf '%s\n%s\n' "$user" "$token"
}

# ---- preflight ---------------------------------------------------------------------

# One HTTP call; the status on stdout, the body in $2. The credential travels
# in a curl config on stdin, so it is in no argument list.
http_status() { # http_status <url> <body file> <curl config lines…>
  local url="$1" body="$2" cfg="" line code
  shift 2
  for line in "$@"; do cfg+="$line"$'\n'; done
  code="$(curl -sS -o "$body" -w '%{http_code}' --max-time 30 -K - "$url" <<<"$cfg" 2>/dev/null)" || code=000
  printf '%s\n' "${code:-000}"
}

denied_message() { # denied_message <image> <http status>
  local image="$1" status="$2" owner="${IMG_REPO%%/*}" name="${IMG_REPO#*/}"
  cat >&2 <<EOF

qcr-action: this repository cannot pull the qcr image $image (HTTP $status).

The image is a private package. Either:
  1. grant this repository access to the package: open
       https://github.com/orgs/$owner/packages/container/$name/settings
     and under "Manage Actions access" add this repository with the Read role; or
  2. give the action a registry-only secret: a token with the read:packages
     scope and nothing else, as the \`registry-token\` input. It is used only
     for \`docker login\`; the review never sees it.
The workflow also needs \`permissions: packages: read\` for the first way.
EOF
  if [ "$status" = 404 ]; then
    echo "qcr-action: (a 404 also means the tag ${IMG_REF} does not exist: check the action's ref and the release.)" >&2
  fi
  printf '::error::qcr action: this repository cannot pull %s (HTTP %s): grant it access under the package'"'"'s "Manage Actions access", or pass a registry-only read:packages secret as registry-token\n' "$image" "$status"
}

preflight() {
  local image cred user token api body status tok
  image="$(resolve_image)"
  split_image "$image"
  if [ "$IMG_HOST" != ghcr.io ] && [ -z "${QCR_REGISTRY_API:-}" ]; then
    say "preflight skipped: $IMG_HOST is not ghcr.io, so docker's own pull reports access"
    return 0
  fi
  cred="$(registry_credential)"
  user="${cred%%$'\n'*}"
  token="${cred#*$'\n'}"
  api="${QCR_REGISTRY_API:-https://$IMG_HOST}"
  body="$(mktemp)"

  # The registry hands out a pull token for the repository; whether this
  # credential may read it shows on the manifest.
  status="$(http_status "$api/token?service=$IMG_HOST&scope=repository:$IMG_REPO:pull" "$body" \
    "user = \"$user:$token\"")"
  case "$status" in
    200) ;;
    401 | 403 | 404)
      rm -f "$body"
      denied_message "$image" "$status"
      exit 1
      ;;
    *)
      rm -f "$body"
      echo "::warning::qcr action: the registry did not answer the preflight (HTTP $status); docker will say if the pull is refused"
      return 0
      ;;
  esac
  tok="$(sed -n 's/.*"token"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$body" | head -n 1)"
  [ -n "$tok" ] || {
    rm -f "$body"
    echo "::warning::qcr action: the registry's answer holds no pull token; docker will say if the pull is refused"
    return 0
  }
  status="$(http_status "$api/v2/$IMG_REPO/manifests/$IMG_REF" "$body" \
    "header = \"Authorization: Bearer $tok\"" \
    'header = "Accept: application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json"')"
  rm -f "$body"
  case "$status" in
    200)
      say "ok: this repository can pull $image"
      ;;
    401 | 403 | 404)
      denied_message "$image" "$status"
      exit 1
      ;;
    *)
      echo "::warning::qcr action: the registry did not answer the preflight (HTTP $status); docker will say if the pull is refused"
      ;;
  esac
}

# ---- docker login ----------------------------------------------------------------------

# Into a docker config of its own under the staging directory, so it touches
# neither the runner's ~/.docker nor any later step, and cleanup removes it.
login() {
  local image cred user token w
  image="$(resolve_image)"
  split_image "$image"
  w="$(work_dir)"
  cred="$(registry_credential)"
  user="${cred%%$'\n'*}"
  token="${cred#*$'\n'}"
  (umask 077 && mkdir -p "$w/docker")
  printf '%s' "$token" | DOCKER_CONFIG="$w/docker" docker login "$IMG_HOST" -u "$user" --password-stdin >/dev/null ||
    die "docker login to $IMG_HOST failed"
  say "logged in to $IMG_HOST as $user"
}

# ---- the generated config ------------------------------------------------------------------

# The image's config.example.toml with the Action's two settings. Each must be
# found exactly once, so a reworded example fails here, not silently in a review.
gen_config() { # gen_config <out file>
  local example="$APP/config.example.toml" out="$1"
  [ -f "$example" ] || die "the action checkout has no config.example.toml ($example)"
  awk '
    /^\[/ { section = $0; sub(/[[:space:]]*(#.*)?$/, "", section) }
    section == "" && /^dry_run[[:space:]]*=/ { print "dry_run = false"; live++; next }
    section == "[openviking]" && /^enabled[[:space:]]*=/ { print "enabled = false"; mem++; next }
    { print }
    END { if (live != 1 || mem != 1) exit 3 }
  ' "$example" >"$out" || die "config.example.toml no longer has exactly one top-level dry_run and one [openviking] enabled"
  assert_config "$out"
}

# What must be true of the config the container runs with.
assert_config() { # assert_config <file>
  awk '
    /^\[/ { section = $0; sub(/[[:space:]]*(#.*)?$/, "", section) }
    section == "" && /^dry_run[[:space:]]*=[[:space:]]*false[[:space:]]*(#.*)?$/ { live = 1 }
    section == "[openviking]" && /^enabled[[:space:]]*=[[:space:]]*false[[:space:]]*(#.*)?$/ { mem = 1 }
    END { exit (live && mem) ? 0 : 1 }
  ' "$1" || die "the generated config must have dry_run = false and [openviking] enabled = false (memory is off in the Action)"
}

# ---- run -------------------------------------------------------------------------------

# Refuse a docker command line that could carry the token or start a memory
# service. The token is not in any argument by construction; this is the
# assertion that it stays so. The memory and network checks cover the docker
# options only, up to the image: a mount path or a reviewed repository's name
# may say anything.
assert_argv() { # assert_argv <token> <image> <argv…>
  local token="$1" image="$2" a prev='' options=1
  shift 2
  for a in "$@"; do
    if [ "${#token}" -ge 8 ]; then
      case "$a" in *"$token"*) die "the GitHub token is in the docker command line" ;; esac
    fi
    if [ "$a" = "$image" ] && [ "$options" = 1 ]; then options=0; fi
    if [ "$options" = 1 ]; then
      case "$prev" in
        -e | --env)
          case "${a%%=*}" in
            QCR_GH_TOKEN_FILE) ;;
            *TOKEN* | *SECRET* | *PASSWORD* | QCR_ACTION_*) die "the docker command line passes $a in the environment" ;;
          esac
          ;;
        --mount | -w) prev="$a" && continue ;;
      esac
      case "$a" in
        --env-file | --env-file=*) die "the docker command line reads an env file" ;;
        --link | --link=* | --network | --network=* | --net | --net=*) die "the docker command line joins a network or a service ($a)" ;;
        *openviking* | *OPENVIKING* | *QCR_MEMORY* | *qcr-memory* | *quickreview-memory*) die "the docker command line names a memory service ($a)" ;;
      esac
    fi
    prev="$a"
  done
}

run_review() {
  local image w pr repo limit token pi_auth run_uid run_gid tokdir login_dir repo_dir name rc
  image="$(resolve_image)"
  w="$(work_dir)"
  pr="${QCR_ACTION_PR:-}"
  [[ "$pr" =~ ^[1-9][0-9]{0,8}$ ]] || die "no pull request number: this runs on pull_request or issue_comment events, or pass the pr input"
  repo="${QCR_ACTION_REPO:-${GITHUB_REPOSITORY:-}}"
  [[ "$repo" =~ ^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$ ]] || die "the repository \"$repo\" is not OWNER/NAME"
  limit="${QCR_ACTION_LIMIT:-}"
  if [ -n "$limit" ]; then
    [[ "$limit" =~ ^[0-9]+(\.[0-9]+)?$ ]] && [[ "$limit" =~ [1-9] ]] || die "limit must be a positive number of dollars (got \"$limit\")"
  fi
  token="${QCR_ACTION_GH_TOKEN:-}"
  [ -n "$token" ] || die "no GitHub token: pass github-token (the default is the workflow's token)"
  pi_auth="${QCR_ACTION_PI_AUTH:-}"
  # The token is staged below and then lives only in this shell's variable.
  unset QCR_ACTION_GH_TOKEN QCR_ACTION_REGISTRY_TOKEN QCR_ACTION_PI_AUTH

  (umask 077 && mkdir -p "$w")
  run_uid="$(id -u)"
  run_gid="$(id -g)"
  # The image refuses a root run uid; a root runner reviews as 1000.
  [ "$run_uid" != 0 ] || run_uid=1000
  [ "$run_gid" != 0 ] || run_gid=1000

  # The config, and the pi login the model route reads (empty when the workflow
  # gave API keys instead).
  gen_config "$w/config.toml"
  chmod 0644 "$w/config.toml"
  login_dir="$w/login"
  rm -rf "$login_dir"
  (umask 077 && mkdir -p "$login_dir")
  if [ -n "$pi_auth" ]; then
    (umask 077 && printf '%s' "$pi_auth" >"$login_dir/auth.json")
  fi
  pi_auth=''

  # The repository: the checkout when there is one, else an empty git
  # repository, so the review has a working directory to stand in.
  repo_dir="${GITHUB_WORKSPACE:-}"
  if [ -z "$repo_dir" ] || [ ! -e "$repo_dir/.git" ]; then
    repo_dir="$w/repo"
    rm -rf "$repo_dir"
    mkdir -p "$repo_dir"
    git -C "$repo_dir" init -q
  fi
  repo_dir="$(cd "$repo_dir" && pwd -P)"
  case "$repo_dir$w" in *,*) die "a path with a comma cannot be mounted: $repo_dir" ;; esac

  # The token handoff: a 0600 file in a fresh 0700 directory.
  tokdir="$(umask 077 && mktemp -d "$w/qcr-in.XXXXXX")" || die "no private directory for the GitHub token under $w"
  (umask 077 && printf '%s' "$token" >"$tokdir/gh-token") || die "could not stage the GitHub token"

  name="qcr-action-${GITHUB_RUN_ID:-local}-$$"
  local -a args=(docker run --rm --init --name "$name")
  # Model-reaching: start as root with only CAP_SETUID/CAP_SETGID and drop to the
  # runner's uid inside, so the model's tools run as another uid (D32).
  args+=(--user 0:0 --cap-drop ALL --cap-add SETUID --cap-add SETGID)
  args+=(--security-opt no-new-privileges)
  args+=(-e "QCR_RUN_UID=$run_uid" -e "QCR_RUN_GID=$run_gid")
  args+=(--group-add "$LOGIN_GID" -e "QCR_LOGIN_GID=$LOGIN_GID")
  args+=(--mount "type=bind,src=$repo_dir,dst=/repo,readonly" -w /repo)
  args+=(--mount "type=volume,dst=/opt/qcr/state" -e QCR_STATE_HOME=/opt/qcr/state/home)
  args+=(--mount "type=bind,src=$w/login,dst=/qcr-login,readonly" -e PI_CODING_AGENT_DIR=/qcr-login)
  args+=(--mount "type=bind,src=$w/config.toml,dst=/qcr-config/config.toml,readonly" -e QCR_CONFIG=/qcr-config/config.toml)
  args+=(--mount "type=bind,src=$tokdir,dst=/run/qcr-in" -e QCR_GH_TOKEN_FILE=/run/qcr-in/gh-token)
  args+=(-e QCR_ROUTE=action)
  # Model keys by name: docker reads the value from this environment.
  local key val
  for key in OPENAI_API_KEY ANTHROPIC_API_KEY GEMINI_API_KEY DIGITALOCEAN_API_KEY; do
    val="${!key-}"
    [ -z "$val" ] || args+=(-e "$key")
  done
  val=''
  args+=("$image" cli review "$pr" --repo "$repo" --to pr,terminal)
  if [ -n "$limit" ]; then args+=(--limit "$limit"); fi

  assert_argv "$token" "$image" "${args[@]}"
  token=''
  if [ -d "$w/docker" ]; then export DOCKER_CONFIG="$w/docker"; fi

  rc=0
  "${args[@]}" || rc=$?
  rm -rf "$tokdir"
  if [ "$rc" = 125 ]; then
    say "docker could not start the container: the image may be unreadable here (see the preflight's message), or the runner has no docker"
  fi
  return "$rc"
}

# ---- cleanup -----------------------------------------------------------------------------

cleanup() {
  local w
  w="$(work_dir)"
  # What a container wrote may belong to another uid; the runner is destroyed
  # after the job anyway, so a leftover must not fail the job.
  rm -rf "$w" 2>/dev/null || say "could not remove every file under $w"
  return 0
}

case "${1:-}" in
  preflight) preflight ;;
  login) login ;;
  run) run_review ;;
  cleanup) cleanup ;;
  image) resolve_image ;;
  *)
    echo "usage: action.sh preflight|login|run|cleanup" >&2
    exit 2
    ;;
esac
