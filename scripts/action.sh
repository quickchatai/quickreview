#!/usr/bin/env bash
# The composite Action's steps (action.yml), one verb each:
#
#   scripts/action.sh gate        review this run at all? (GitHub reads only)
#   scripts/action.sh preflight   can this repository pull the image?
#   scripts/action.sh login       docker login, only for a private mirror
#   scripts/action.sh run         one review of one PR, in a throwaway container
#   scripts/action.sh cleanup     remove everything the other verbs staged
#
# The composite calls this file so that what the Action does can be read, tested
# with a fake docker, and linted, instead of living inside YAML strings.
#
# The gate runs before the image is pulled and before anything is spent. It
# makes GitHub reads only, and decides, in this order:
#   1. which pull request: the pr input, else the one the event payload names
#      (a pull_request event, or an issue event whose issue is a pull
#      request). A comment on a plain issue is skipped; an event that names
#      no pull request is an error. It never guesses one from a commit;
#   2. the repository, as the run checks it;
#   3. who started the run (the triggering actor, else the actor): anyone
#      allowed-users names, else a person with write access to the
#      repository. A bot not named there is skipped, and so is a person
#      without write access; an answer it cannot read is an error;
#   4. the pull request's state: a merged or closed one is skipped;
#   5. a model credential, from the same names the run forwards: none on a
#      fork's pull_request event is skipped (GitHub gives that event no
#      secrets), none elsewhere is an error.
# It writes skipped, skip-reason and pr to the step's outputs. A skip prints a
# notice, adds one line to the job summary and exits 0; the later steps then
# do not run. An error exits 1.
#
# The run writes its result to the step's outputs and to the job summary: it
# reads the review's JSON result, the last line of its stdout, which it holds
# back from the log.
#
# What `run` hands the container, and nothing else (the host wrapper's call,
# scripts/qcr-host.sh, with the Action's differences):
#   - the workspace read-only at /repo (an empty git repository when the job
#     did not check one out), the generated config read-only, the pi login
#     directory read-only at /qcr-login, the state in the container's own /tmp;
#   - QCR_ROUTE=action, so the review is not capped unless `limit` is set and
#     nothing is asked;
#   - the GitHub token as a read-once file: a 0600 file in a
#     fresh 0700 directory under $RUNNER_TEMP, mounted at /run/qcr-in and named
#     in QCR_GH_TOKEN_FILE. The token is in no `-e`, no `--env-file` and no
#     argument list; the image reads it and unlinks it before any pi or bash
#     child exists (packages/pi-plugin/src/ghcred.ts);
#   - model credentials by NAME only (docker reads the value from this
#     environment): the names pi reads, for any provider, generated into the
#     block below, plus the names in QCR_MODEL_ENV.
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
#   QCR_ACTION_REGISTRY_TOKEN   a token that can read a private mirror, used for
#                               docker login and the preflight only; without
#                               one the image is pulled anonymously
#   QCR_ACTION_GH_TOKEN         the GitHub token the gate reads with and the
#                               review reads and posts with
#   QCR_ACTION_PR               gate: the pr input (empty: the event decides);
#                               run: the pull request the gate chose
#   QCR_ACTION_REPO, QCR_ACTION_LIMIT, QCR_ACTION_PI_AUTH
#   QCR_ACTION_<NAME>_API_KEY   a key input (openai-api-key and the three beside
#                               it): a given one becomes <NAME>_API_KEY for the
#                               review
#   QCR_ACTION_MODEL            the model input, passed to the review as --model
#   QCR_ACTION_PROFILE          the profile input, passed as --profile
#   QCR_ACTION_POST             the post input: "true" (the default) posts the
#                               review, "false" posts nothing
#   QCR_ACTION_ALLOWED_USERS    gate: the allowed-users input
#   QCR_ACTION_HAS_KEY_INPUT    gate: "true" when a key input was given (the
#                               gate never sees a key's value)
#   QCR_ACTION_HAS_PI_AUTH      gate: "true" when pi-auth was given
#   QCR_MODEL_ENV               more environment names to forward to the review
#                               (a workflow's own env:), beside pi's own
#   QCR_REGISTRY_API            tests only: the registry's base URL
# and the runner's own: GITHUB_EVENT_NAME, GITHUB_EVENT_PATH, GITHUB_ACTOR,
# GITHUB_TRIGGERING_ACTOR, GITHUB_REPOSITORY, GITHUB_API_URL (the GitHub API
# the gate reads; tests point it at a stub), GITHUB_OUTPUT and
# GITHUB_STEP_SUMMARY (neither is written when it is not set).
set -euo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP="${QCR_ACTION_PATH:-$(cd "$SELF_DIR/.." && pwd)}"
LOGIN_GID=4747

# The environment names a model credential is forwarded under, by name only.
# The Action runs before the image does and cannot ask pi, so the list is
# generated from the pi the image pins; tests/model-env.test.ts holds it equal.
# BEGIN pi model env names
# Generated by scripts/model-env-names.mjs from the pinned pi: the names pi
# reads a model credential from. Do not edit; run it with --write.
PI_MODEL_ENV_NAMES='
AI_GATEWAY_API_KEY
ANTHROPIC_API_KEY
ANTHROPIC_AUTH_TOKEN
ANTHROPIC_FEDERATION_RULE_ID
ANTHROPIC_IDENTITY_TOKEN_FILE
ANTHROPIC_OAUTH_TOKEN
ANTHROPIC_ORGANIZATION_ID
ANTHROPIC_SERVICE_ACCOUNT_ID
ANTHROPIC_WORKSPACE_ID
ANT_LING_API_KEY
AWS_ACCESS_KEY_ID
AWS_BEARER_TOKEN_BEDROCK
AWS_CONTAINER_CREDENTIALS_FULL_URI
AWS_CONTAINER_CREDENTIALS_RELATIVE_URI
AWS_PROFILE
AWS_SECRET_ACCESS_KEY
AWS_WEB_IDENTITY_TOKEN_FILE
AZURE_OPENAI_API_KEY
BASETEN_API_KEY
CEREBRAS_API_KEY
CLOUDFLARE_ACCOUNT_ID
CLOUDFLARE_API_KEY
CLOUDFLARE_GATEWAY_ID
COPILOT_GITHUB_TOKEN
DEEPSEEK_API_KEY
FIREWORKS_API_KEY
GCLOUD_PROJECT
GEMINI_API_KEY
GOOGLE_APPLICATION_CREDENTIALS
GOOGLE_CLOUD_API_KEY
GOOGLE_CLOUD_LOCATION
GOOGLE_CLOUD_PROJECT
GROQ_API_KEY
HF_TOKEN
KIMI_API_KEY
META_API_KEY
MINIMAX_API_KEY
MINIMAX_CN_API_KEY
MISTRAL_API_KEY
MOONSHOT_API_KEY
NVIDIA_API_KEY
OPENAI_API_KEY
OPENCODE_API_KEY
OPENROUTER_API_KEY
QWEN_TOKEN_PLAN_API_KEY
QWEN_TOKEN_PLAN_CN_API_KEY
RADIUS_API_KEY
TOGETHER_API_KEY
TYPESAFE_API_KEY
XAI_API_KEY
XIAOMI_API_KEY
XIAOMI_TOKEN_PLAN_AMS_API_KEY
XIAOMI_TOKEN_PLAN_CN_API_KEY
XIAOMI_TOKEN_PLAN_SGP_API_KEY
ZAI_API_KEY
ZAI_CODING_CN_API_KEY
'
# END pi model env names

# Names pi reads when it makes a request, beside a credential of the block:
# the generator records what a provider's credential check asks for, and
# these are asked for later. Forwarded as the block's names are, by name only.
MODEL_ENV_COMPANIONS='AWS_SESSION_TOKEN'

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

# ---- step outputs ----------------------------------------------------------------------

random_hex() {
  local h
  h="$(od -An -tx1 -N16 /dev/urandom 2>/dev/null | tr -d ' \n')" || h=''
  [ -n "$h" ] || h="$RANDOM$RANDOM$RANDOM$RANDOM$$"
  printf '%s\n' "$h"
}

# One step output, in the runner's multi-line form under a random delimiter
# that is not in the value, so no value can end the entry early or add one of
# its own. Nothing is written outside a runner (no GITHUB_OUTPUT). Fails when
# the file cannot be written; the caller decides what that means.
put_output() { # put_output <name> <value>
  local file="${GITHUB_OUTPUT:-}" delim
  [ -n "$file" ] || return 0
  delim="ghadelimiter_$(random_hex)"
  case "$2" in *"$delim"*) return 1 ;; esac
  printf '%s<<%s\n%s\n%s\n' "$1" "$delim" "$2" "$delim" >>"$file" || return 1
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

# The credential for a private mirror: the registry-token input, never the
# workflow's token. Echoes the user, then the token, on two lines. Called only
# when a registry token was given; the release image is public and needs none.
registry_credential() {
  local user="${QCR_ACTION_REGISTRY_USER:-}" token="${QCR_ACTION_REGISTRY_TOKEN:-}"
  [ -n "$user" ] || user="${GITHUB_ACTOR:-}"
  [ -n "$token" ] || die "no registry token"
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

# The ways in to an image that is not public: a read:packages token, or the
# workflow's own token once the package grants this repository access.
private_ways() {
  local owner="${IMG_REPO%%/*}" name="${IMG_REPO#*/}"
  cat >&2 <<EOF
An image that is not public (a private mirror, named by the \`image\` input) needs
a token that can read it, as the \`registry-token\` input. Either:
  1. a token with the read:packages scope and nothing else, as a secret; or
  2. \`\${{ github.token }}\`, with \`permissions: packages: read\` in the workflow,
     once this repository has the Read role under "Manage Actions access":
       https://github.com/orgs/$owner/packages/container/$name/settings
It is used only for \`docker login\`; the review never sees it.
EOF
}

denied_message() { # denied_message <image> <http status> <anonymous: 1|0>
  local image="$1" status="$2" anon="$3"
  if [ "$anon" = 1 ]; then
    cat >&2 <<EOF

qcr-action: the qcr image $image cannot be pulled anonymously (HTTP $status).

The release image is public, so the likely cause is a tag that does not exist:
check the action's ref, and that release ${IMG_REF} is published.
EOF
    private_ways
    printf '::error::qcr action: %s cannot be pulled anonymously (HTTP %s): check that the tag is published; an image that is not public needs registry-token\n' "$image" "$status"
    return 0
  fi
  cat >&2 <<EOF

qcr-action: the registry-token cannot pull the qcr image $image (HTTP $status).

The release image is public: without registry-token it is pulled anonymously.
EOF
  private_ways
  if [ "$status" = 404 ]; then
    echo "qcr-action: (a 404 also means the tag ${IMG_REF} does not exist: check the action's ref and the release.)" >&2
  fi
  printf '::error::qcr action: registry-token cannot pull %s (HTTP %s): give it read access to the package, or drop it to pull the public image anonymously\n' "$image" "$status"
}

preflight() {
  local image cred user token api body status tok anon=1
  local -a auth=()
  image="$(resolve_image)"
  split_image "$image"
  if [ "$IMG_HOST" != ghcr.io ] && [ -z "${QCR_REGISTRY_API:-}" ]; then
    say "preflight skipped: $IMG_HOST is not ghcr.io, so docker's own pull reports access"
    return 0
  fi
  # Without a registry token the check is anonymous, as docker's pull will be.
  if [ -n "${QCR_ACTION_REGISTRY_TOKEN:-}" ]; then
    cred="$(registry_credential)"
    user="${cred%%$'\n'*}"
    token="${cred#*$'\n'}"
    auth=("user = \"$user:$token\"")
    anon=0
  fi
  api="${QCR_REGISTRY_API:-https://$IMG_HOST}"
  body="$(mktemp)"

  # The registry hands out a pull token for the repository; whether this
  # credential (or none) may read it shows on the manifest.
  status="$(http_status "$api/token?service=$IMG_HOST&scope=repository:$IMG_REPO:pull" "$body" "${auth[@]}")"
  case "$status" in
    200) ;;
    401 | 403 | 404)
      rm -f "$body"
      denied_message "$image" "$status" "$anon"
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
      denied_message "$image" "$status" "$anon"
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
# Only with a registry token: the release image is public and pulls without one.
# The config is staged either way, so an anonymous pull is anonymous: a login
# left in the runner's ~/.docker (a self-hosted runner's stale one) is never sent.
login() {
  local image cred user token w
  image="$(resolve_image)"
  split_image "$image"
  w="$(work_dir)"
  (umask 077 && mkdir -p "$w/docker")
  if [ -z "${QCR_ACTION_REGISTRY_TOKEN:-}" ]; then
    say "no registry-token: $image is pulled anonymously, with no login"
    return 0
  fi
  cred="$(registry_credential)"
  user="${cred%%$'\n'*}"
  token="${cred#*$'\n'}"
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

# Is this exactly one of pi's model env names (the generated block, or a
# request-time companion of one)?
is_model_env_name() { # is_model_env_name <name>
  local n
  for n in $PI_MODEL_ENV_NAMES $MODEL_ENV_COMPANIONS; do
    [ "$n" != "$1" ] || return 0
  done
  return 1
}

# Does this name point at something on this machine that the container does
# not have? A profile name (*_PROFILE), a file path (*_FILE), or a value that
# is the absolute path of a file here: nothing mounts it, and pi would count
# the provider as credentialed on the name alone and fail at its first call.
# Such a name is never forwarded.
host_only() { # host_only <name> <value>
  case "$1" in *_PROFILE | *_FILE) return 0 ;; esac
  case "$2" in /*) [ ! -f "$2" ] || return 0 ;; esac
  return 1
}

# The names QCR_MODEL_ENV adds (a provider's extra settings, or the key of a
# provider added to pi by hand), into MODEL_ENV_EXTRA. A name is an environment
# variable in capitals; this program's own prefixes are refused, and so is a
# name with TOKEN, SECRET or PASSWORD in it that is not one of pi's own. It
# sets a variable, never prints: a refusal must end this shell, not a subshell.
MODEL_ENV_EXTRA=''
model_env_extra() {
  local raw="${QCR_MODEL_ENV:-}" n
  MODEL_ENV_EXTRA=''
  raw="${raw//,/ }"
  raw="${raw//$'\n'/ }"
  raw="${raw//$'\t'/ }"
  case "$raw" in
    *[!A-Z0-9_\ ]*) die "QCR_MODEL_ENV holds names of environment variables (capitals, digits and _), separated by commas" ;;
  esac
  for n in $raw; do
    case "$n" in
      [!A-Z]*) die "QCR_MODEL_ENV: $n is not the name of an environment variable" ;;
      GH_* | GITHUB_* | QCR_* | PI_* | OPENVIKING_* | GIT_*) die "QCR_MODEL_ENV: $n is not a model setting and is never forwarded" ;;
    esac
    if ! is_model_env_name "$n"; then
      case "$n" in
        *TOKEN* | *SECRET* | *PASSWORD*) die "QCR_MODEL_ENV: $n is not forwarded (a name with TOKEN, SECRET or PASSWORD in it is forwarded only when it is one of pi's own)" ;;
      esac
    fi
    MODEL_ENV_EXTRA="$MODEL_ENV_EXTRA $n"
  done
}

# The names a model credential is forwarded under, into FORWARD_NAMES: pi's
# own (the block at the top), whatever provider they belong to, with their
# request-time companions, plus the names in QCR_MODEL_ENV, QCR_DEBUG and
# DIGITALOCEAN_API_KEY (an older spelling; pi does not know the name). Only a
# name that is set; one that points at a profile or a file on the runner
# stays there (host_only): the container has neither. Call model_env_extra
# first. The run forwards these names, and the gate asks of the same list
# whether any credential is there at all.
FORWARD_NAMES=()
forward_names() {
  local key val
  FORWARD_NAMES=()
  for key in $PI_MODEL_ENV_NAMES $MODEL_ENV_COMPANIONS $MODEL_ENV_EXTRA DIGITALOCEAN_API_KEY QCR_DEBUG; do
    val="${!key-}"
    [ -n "$val" ] || continue
    host_only "$key" "$val" || FORWARD_NAMES+=("$key")
  done
}

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
          # One of pi's own model names, given by name alone (no value), is
          # what the run forwards; nothing else with such a name passes.
          if ! is_model_env_name "$a"; then
            case "${a%%=*}" in
              QCR_GH_TOKEN_FILE) ;;
              *TOKEN* | *SECRET* | *PASSWORD* | QCR_ACTION_*) die "the docker command line passes $a in the environment" ;;
            esac
          fi
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
  local image w pr repo limit model profile post to key val token pi_auth run_uid run_gid tokdir login_dir repo_dir name rc out
  local -a st=()
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
  # A model spec is one word of pi's own (`provider/model`, a bare id, either
  # with `:level`); it is an argument of the review, never an option of docker.
  model="${QCR_ACTION_MODEL:-}"
  case "$model" in
    -* | *[!A-Za-z0-9._/:@+-]*) die "model \"$model\" is not a model spec (provider/model, with an optional :level)" ;;
  esac
  # A profile is a name the image looks up (an unknown one is its refusal,
  # exit 2); like the model it is an argument of the review.
  profile="${QCR_ACTION_PROFILE:-}"
  if [ -n "$profile" ]; then
    [[ "$profile" =~ ^[a-z0-9][a-z0-9._-]{0,63}$ ]] || die "profile \"$profile\" is not a profile name (lower-case letters, digits, '.', '_' and '-')"
  fi
  # post chooses where the result goes, and json always goes with it: the
  # outputs and the job summary are read from it. This is not dry run: the
  # generated config stays live either way.
  post="${QCR_ACTION_POST:-true}"
  case "$post" in
    true) to=pr,terminal,json ;;
    false) to=terminal,json ;;
    *) die "post must be true or false (got \"$post\")" ;;
  esac
  # The key inputs arrive as QCR_ACTION_<NAME>_API_KEY (action.yml): a given
  # one becomes <NAME>_API_KEY, the variable the review reads; an empty one
  # changes nothing, so a key in the step's own env is left as it is.
  for key in "${!QCR_ACTION_@}"; do
    case "$key" in
      QCR_ACTION_*_API_KEY)
        val="${!key-}"
        [ -z "$val" ] || export "${key#QCR_ACTION_}=$val"
        unset "$key"
        ;;
    esac
  done
  val=''
  model_env_extra
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
  # A root runner reviews as 1000 and the image drops to that uid before it
  # reads these, so the private staging is handed to it.
  if [ "$(id -u)" = 0 ]; then
    chown -R "$run_uid:$run_gid" "$tokdir" "$login_dir" || die "could not hand the staged credentials to uid $run_uid"
  fi

  name="qcr-action-${GITHUB_RUN_ID:-local}-$$"
  local -a args=(docker run --rm --init --name "$name")
  # Model-reaching: start as root with only CAP_SETUID/CAP_SETGID and drop to the
  # runner's uid inside, so the model's tools run as another uid.
  args+=(--user 0:0 --cap-drop ALL --cap-add SETUID --cap-add SETGID)
  args+=(--security-opt no-new-privileges)
  args+=(-e "QCR_RUN_UID=$run_uid" -e "QCR_RUN_GID=$run_gid")
  args+=(--group-add "$LOGIN_GID" -e "QCR_LOGIN_GID=$LOGIN_GID")
  args+=(--mount "type=bind,src=$repo_dir,dst=/repo,readonly" -w /repo)
  # The review's state in the container's own /tmp, gone with --rm. Never under
  # the image's /opt/qcr: the review host refuses a run directory inside the
  # qcr tree (packages/pi-plugin/src/reviewhost.ts prepareReviewHost).
  args+=(-e QCR_STATE_HOME=/tmp/qcr/home)
  args+=(--mount "type=bind,src=$w/login,dst=/qcr-login,readonly" -e PI_CODING_AGENT_DIR=/qcr-login)
  args+=(--mount "type=bind,src=$w/config.toml,dst=/qcr-config/config.toml,readonly" -e QCR_CONFIG=/qcr-config/config.toml)
  args+=(--mount "type=bind,src=$tokdir,dst=/run/qcr-in" -e QCR_GH_TOKEN_FILE=/run/qcr-in/gh-token)
  args+=(-e QCR_ROUTE=action)
  # Model credentials by name (forward_names): docker reads the value from
  # this environment.
  forward_names
  for key in ${FORWARD_NAMES[@]+"${FORWARD_NAMES[@]}"}; do args+=(-e "$key"); done
  args+=("$image" cli review "$pr" --repo "$repo" --to "$to")
  if [ -n "$limit" ]; then args+=(--limit "$limit"); fi
  if [ -n "$model" ]; then args+=(--model "$model"); fi
  if [ -n "$profile" ]; then args+=(--profile "$profile"); fi

  assert_argv "$token" "$image" "${args[@]}"
  token=''
  if [ -d "$w/docker" ]; then export DOCKER_CONFIG="$w/docker"; fi

  # The review's stdout goes to the log as it comes and, whole, to a file
  # under the staging directory. A last line that opens with `{` stays out of
  # the log: it is the JSON result (long; it goes to the outputs and the
  # summary), and report_result gives it back to the log when it is not.
  # The exit code is docker's.
  out="$w/review-stdout.txt"
  : >"$out"
  set +e
  "${args[@]}" | QCR_STDOUT_FILE="$out" awk '
    BEGIN { file = ENVIRON["QCR_STDOUT_FILE"] }
    {
      print > file
      if (have) { print held; have = 0 }
      if (substr($0, 1, 1) == "{") { held = $0; have = 1 } else print
      fflush()
    }
  '
  st=("${PIPESTATUS[@]}")
  set -e
  rc="${st[0]}"
  [ "${st[1]:-0}" = 0 ] || say "could not keep the review's stdout (awk exited ${st[1]:-})"
  rm -rf "$tokdir"
  if [ "$rc" = 125 ]; then
    say "docker could not start the container: the image may be unreadable here (see the preflight's message), or the runner has no docker"
  fi
  report_result "$out" "$repo" "$pr" "$rc"
  return "$rc"
}

# The result: the last stdout line that is a JSON object with a
# schema_version (schemas/review-result.v2.json). From it, the outputs of
# action.yml and a job summary; with none, a summary that says the review did
# not finish. Written to <dir>/outputs (name and value, each ended by a NUL)
# and <dir>/summary.md. A last line that opened with `{` and is not the
# result goes back to the log on stdout. Exit 3: no result.
# shellcheck disable=SC2016 # JavaScript, not shell: nothing in it expands
RESULT_JS='
const fs = require("fs");
const [file, dir, repo, pr, rc] = process.argv.slice(1);
const lines = fs.readFileSync(file, "utf8").split("\n");
if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
let result = null;
let raw = "";
let at = -1;
for (let i = lines.length - 1; i >= 0 && result === null; i--) {
  const line = lines[i].trim();
  if (!line.startsWith("{")) continue;
  let v;
  try {
    v = JSON.parse(line);
  } catch {
    continue;
  }
  if (v !== null && typeof v === "object" && !Array.isArray(v) && "schema_version" in v) {
    result = v;
    raw = line;
    at = i;
  }
}
const last = lines.length > 0 ? lines[lines.length - 1] : "";
if (last.startsWith("{") && at !== lines.length - 1) process.stdout.write(last + "\n");

// Text from the review (a title is written by the model) as one table cell:
// on one line, with nothing that ends the cell, opens code or makes HTML.
const cell = (s) =>
  String(s ?? "")
    .replace(/\r\n|\r|\n/g, " ")
    .replace(/\\/g, "\\\\")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\|/g, "\\|")
    .replace(/`/g, "\\`");

let s = "### QuickReview\n\n- Pull request: " + repo + "#" + pr + "\n";
if (result === null) {
  s += "\nThe review did not finish (exit code " + rc + ") and printed no result. The log of this step says why.\n";
  fs.writeFileSync(dir + "/summary.md", s);
  fs.writeFileSync(dir + "/outputs", "");
  process.exit(3);
}

const findings =
  result.findings !== null && typeof result.findings === "object" && !Array.isArray(result.findings)
    ? result.findings
    : null;
const rows = [];
if (findings !== null)
  for (const [severity, list] of Object.entries(findings))
    if (Array.isArray(list)) for (const f of list) rows.push([severity, f ?? {}]);
const verdict =
  result.verdict === "APPROVE" || result.verdict === "REQUEST_CHANGES" ? result.verdict : "";
const post = result.post !== null && typeof result.post === "object" ? result.post : null;
const url =
  post !== null && typeof post.url === "string" && /^https?:\/\/[^\s<>]+$/.test(post.url)
    ? post.url
    : "";
const cost =
  typeof result.cost_usd === "number" && Number.isFinite(result.cost_usd) ? result.cost_usd : null;

const outputs = [
  ["review-url", url],
  ["verdict", verdict],
  ["findings", findings === null ? "" : String(rows.length)],
  ["cost-usd", cost === null ? "" : String(cost)],
  ["result", raw],
];
fs.writeFileSync(dir + "/outputs", outputs.map(([k, v]) => k + "\0" + v + "\0").join(""));

if (result.ok === false) {
  const errors = Array.isArray(result.errors) ? result.errors.map(cell).join("; ") : "";
  const why = result.partial === true ? "it stopped at the cost limit" : errors || "it failed";
  s += "\nThe review did not finish: " + why + "\n\n";
}
const said = { APPROVE: "Approved", REQUEST_CHANGES: "Changes requested" };
s += "- Verdict: " + (said[verdict] ?? "none") + "\n";
s += "- Review: " + (url ? "<" + url + ">" : post !== null && post.dry_run === true ? "not posted (dry run)" : "not posted") + "\n";
s += "- Cost: " + (cost === null ? "unknown" : "$" + cost.toFixed(2)) + "\n";
if (findings !== null && rows.length === 0) s += "\nNo findings.\n";
if (rows.length > 0) {
  s += "\n| Severity | Where | Finding | Lens |\n|---|---|---|---|\n";
  for (const [severity, f] of rows.slice(0, 50)) {
    const where =
      typeof f.path === "string" ? (Number.isInteger(f.line) ? f.path + ":" + f.line : f.path) : "";
    s += "| " + [typeof f.severity === "string" ? f.severity : severity, where, f.title, f.lens].map(cell).join(" | ") + " |\n";
  }
  if (rows.length > 50) s += "\n… " + (rows.length - 50) + " more\n";
}
fs.writeFileSync(dir + "/summary.md", s);
'

# After the review, whatever its exit code: the outputs and the job summary
# from its result. A write that fails is a warning, and nothing here changes
# the step's exit code.
report_result() { # report_result <stdout file> <repo> <pr> <docker exit code>
  local out="$1" dir code=0 failed=0 name value last
  dir="$(dirname "$out")"
  if ! command -v node >/dev/null 2>&1; then
    last="$(tail -n 1 "$out" 2>/dev/null)" || last=''
    case "$last" in '{'*) printf '%s\n' "$last" ;; esac
    echo "::warning::qcr action: node is not on this runner, so the review's result sets no outputs and no job summary"
    return 0
  fi
  node -e "$RESULT_JS" "$out" "$dir" "$2" "$3" "$4" || code=$?
  case "$code" in
    0) say "the review's JSON result is in this step's outputs and the job summary, not in the log" ;;
    3) ;;
    *)
      echo "::warning::qcr action: could not read the review's result (node exited $code): no outputs and no job summary"
      return 0
      ;;
  esac
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
    cat "$dir/summary.md" >>"$GITHUB_STEP_SUMMARY" || echo "::warning::qcr action: could not write the job summary"
  fi
  if [ -n "${GITHUB_OUTPUT:-}" ] && [ -s "$dir/outputs" ]; then
    while IFS= read -r -d '' name && IFS= read -r -d '' value; do
      put_output "$name" "$value" || failed=1
    done <"$dir/outputs"
    [ "$failed" = 0 ] || echo "::warning::qcr action: could not write the step outputs"
  fi
  return 0
}

# ---- gate --------------------------------------------------------------------------------

# A GitHub login, a bot's with its [bot] suffix. An Enterprise Managed User's
# login carries an underscore (handle_shortcode). Every character here is safe
# in the URL path segment the login goes into.
LOGIN_RE='^[A-Za-z0-9][A-Za-z0-9_-]*(\[bot\])?$'

# The gate's three outputs. When they cannot be written the later steps would
# not know what to do, so that ends the step.
gate_outputs() { # gate_outputs <skipped> <reason> <pr>
  put_output skipped "$1" && put_output skip-reason "$2" && put_output pr "$3" ||
    die "could not write the step outputs (GITHUB_OUTPUT)"
}

# Not reviewing this run: the outputs say so, a notice and one line of the
# job summary say why, and the step succeeds.
skip() { # skip <reason>
  printf '::notice::qcr action: %s\n' "$1"
  say "not reviewing: $1"
  gate_outputs true "$1" ""
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
    printf 'QuickReview did not review this run: %s\n' "$1" >>"$GITHUB_STEP_SUMMARY" ||
      echo "::warning::qcr action: could not write the job summary"
  fi
  exit 0
}

# Fields of a JSON file, one line each, by dotted path (head.repo.full_name);
# an absent or null field is an empty line. Fails when the file is not JSON.
json_fields() { # json_fields <file> <path…>
  node -e '
    const fs = require("fs");
    const doc = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    for (const path of process.argv.slice(2)) {
      let v = doc;
      for (const k of path.split(".")) v = v !== null && typeof v === "object" ? v[k] : undefined;
      const s = v === undefined || v === null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
      console.log(s.replace(/[\r\n]+/g, " "));
    }
  ' "$@"
}

# The pull request the event payload names, into EVENT_PR: `pr N`, `issue`
# for an issue that is not a pull request, or `none`. Only the payload's own
# pull_request.number, or issue.number when the issue is a pull request: never
# a guess from a commit or from workflow_run.pull_requests.
EVENT_PR=''
event_pr() {
  local path="${GITHUB_EVENT_PATH:-}" got
  EVENT_PR=none
  [ -n "$path" ] && [ -f "$path" ] || return 0
  got="$(node -e '
    const fs = require("fs");
    const e = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const num = (n) => (Number.isSafeInteger(n) && n > 0 ? String(n) : "");
    let out = "none";
    if (e !== null && typeof e === "object") {
      const p = e.pull_request;
      const i = e.issue;
      if (p !== null && typeof p === "object" && num(p.number)) out = "pr " + num(p.number);
      else if (i !== null && typeof i === "object")
        out = i.pull_request ? (num(i.number) ? "pr " + num(i.number) : "none") : "issue";
    }
    console.log(out);
  ' "$path" 2>/dev/null)" || die "could not read the event payload ($path)"
  EVENT_PR="$got"
}

# allowed-users, in lower case, into ALLOWED_USERS ("*" lets anyone start a
# review). Commas or spaces between names. A name that is no GitHub login is a
# mistake in the workflow and ends the step.
ALLOWED_USERS=()
allowed_users() {
  local raw="${QCR_ACTION_ALLOWED_USERS:-}" u
  local -a words=()
  raw="${raw//,/ }"
  raw="${raw//$'\n'/ }"
  raw="${raw//$'\r'/ }"
  raw="${raw//$'\t'/ }"
  read -r -a words <<<"$raw" || true
  ALLOWED_USERS=()
  for u in ${words[@]+"${words[@]}"}; do
    if [ "$u" != '*' ] && ! [[ "$u" =~ $LOGIN_RE ]]; then
      die "allowed-users: \"$u\" is not a GitHub login (a bot as name[bot]) or *"
    fi
    ALLOWED_USERS+=("${u,,}")
  done
}

# Does allowed-users let this login start a review? Case does not matter.
allowed_user() { # allowed_user <login>
  local who="${1,,}" u
  for u in ${ALLOWED_USERS[@]+"${ALLOWED_USERS[@]}"}; do
    if [ "$u" = '*' ] || [ "$u" = "$who" ]; then return 0; fi
  done
  return 1
}

# Is a model credential there for the review? The same names the run
# forwards (forward_names; QCR_DEBUG is no credential), or a key input, or
# pi-auth. Of those two inputs the gate is told only whether one was given.
has_model_credential() {
  local n
  [ "${QCR_ACTION_HAS_KEY_INPUT:-}" != true ] || return 0
  [ "${QCR_ACTION_HAS_PI_AUTH:-}" != true ] || return 0
  forward_names
  for n in ${FORWARD_NAMES[@]+"${FORWARD_NAMES[@]}"}; do
    [ "$n" = QCR_DEBUG ] || return 0
  done
  return 1
}

gate() {
  local w event pr repo token api actor body status perm head got
  local -a cfg=() f=()
  command -v node >/dev/null 2>&1 || die "node is needed on the runner to read the event and GitHub's answers"
  w="$(work_dir)"
  (umask 077 && mkdir -p "$w")
  event="${GITHUB_EVENT_NAME:-}"
  [[ "$event" =~ ^[a-z_]+$ ]] || event=unknown

  # 1. Which pull request.
  pr="${QCR_ACTION_PR:-}"
  if [ -n "$pr" ]; then
    [[ "$pr" =~ ^[1-9][0-9]{0,8}$ ]] || die "the pr input is not a pull request number"
  else
    event_pr
    case "$EVENT_PR" in
      'pr '*) pr="${EVENT_PR#pr }" ;;
      issue) skip "the comment is on an issue, not a pull request" ;;
      *) die "this event (\`$event\`) names no pull request: pass the pr input" ;;
    esac
    [[ "$pr" =~ ^[1-9][0-9]{0,8}$ ]] || die "this event (\`$event\`) names no pull request: pass the pr input"
  fi

  # 2. The repository.
  repo="${QCR_ACTION_REPO:-${GITHUB_REPOSITORY:-}}"
  [[ "$repo" =~ ^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$ ]] || die "the repository \"$repo\" is not OWNER/NAME"

  # GitHub reads: the token travels in a curl config on stdin (http_status),
  # in no argument list.
  token="${QCR_ACTION_GH_TOKEN:-}"
  [ -n "$token" ] || die "no GitHub token: pass github-token (the default is the workflow's token)"
  case "$token" in
    *[\"\\]* | *[[:cntrl:]]*) die "the GitHub token holds a character the gate cannot send" ;;
  esac
  unset QCR_ACTION_GH_TOKEN
  cfg=(
    "header = \"Authorization: Bearer $token\""
    'header = "Accept: application/vnd.github+json"'
    'header = "X-GitHub-Api-Version: 2022-11-28"'
    'user-agent = "qcr-action"'
  )
  token=''
  api="${GITHUB_API_URL:-https://api.github.com}"
  api="${api%/}"
  body="$w/gate-answer.json"

  # 3. Who started it. A re-run is started by the person who re-ran it, and
  # re-running needs write access.
  actor="${GITHUB_TRIGGERING_ACTOR:-${GITHUB_ACTOR:-}}"
  [[ "$actor" =~ $LOGIN_RE ]] || die "cannot tell who started this run (GITHUB_ACTOR is \"$actor\")"
  allowed_users
  if allowed_user "$actor"; then
    say "$actor may start a review: allowed-users lets them"
  else
    case "$actor" in
      *'[bot]') skip "started by \`$actor\`: a bot starts a review only when allowed-users names it" ;;
    esac
    # GitHub maps maintain to write, and triage to read.
    status="$(http_status "$api/repos/$repo/collaborators/$actor/permission" "$body" "${cfg[@]}")"
    case "$status" in
      200)
        perm="$(json_fields "$body" permission)" || perm=''
        case "$perm" in
          admin | write) say "$actor may start a review: $perm access to $repo" ;;
          read | none) skip "\`$actor\` has no write access to \`$repo\`: name them in allowed-users to let them start reviews" ;;
          *) die "could not check \`$actor\`'s access to \`$repo\` (HTTP $status, no permission in the answer)" ;;
        esac
        ;;
      404) skip "\`$actor\` has no write access to \`$repo\`: name them in allowed-users to let them start reviews" ;;
      *) die "could not check \`$actor\`'s access to \`$repo\` (HTTP $status)" ;;
    esac
  fi

  # 4. The pull request's state. A draft is reviewed: the workflow's own if:
  # filters drafts when it wants to.
  status="$(http_status "$api/repos/$repo/pulls/$pr" "$body" "${cfg[@]}")"
  case "$status" in
    200) ;;
    404) die "pull request #$pr was not found in \`$repo\`, or the token cannot see it" ;;
    *) die "could not read pull request #$pr of \`$repo\` (HTTP $status)" ;;
  esac
  got="$(json_fields "$body" merged state head.repo.full_name)" ||
    die "could not read GitHub's answer for pull request #$pr"
  rm -f "$body"
  mapfile -t f <<<"$got"
  [ "${f[0]:-}" != true ] || skip "pull request #$pr is already merged"
  [ "${f[1]:-}" != closed ] || skip "pull request #$pr is closed"
  # null when the fork was deleted
  head="${f[2]:-}"

  # 5. A model credential. The pull_request family gets no secrets on a
  # fork's pull request, so a missing one there is the event's doing.
  model_env_extra
  if ! has_model_credential; then
    case "$event" in
      pull_request | pull_request_review | pull_request_review_comment)
        if [ "${head,,}" != "${repo,,}" ]; then
          skip "a pull request from a fork: GitHub gives this event no secrets. Ask for the review with a comment instead (docs/action.md)"
        fi
        ;;
    esac
    die "no model credential: set a provider's API key in this step's env (docs/action.md#any-providers-key), or a key input"
  fi

  # 6. Review it.
  gate_outputs false "" "$pr"
  say "reviewing pull request #$pr of $repo, started by $actor"
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
  gate) gate ;;
  preflight) preflight ;;
  login) login ;;
  run) run_review ;;
  cleanup) cleanup ;;
  image) resolve_image ;;
  *)
    echo "usage: action.sh gate|preflight|login|run|cleanup" >&2
    exit 2
    ;;
esac
