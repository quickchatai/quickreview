#!/usr/bin/env bash
# vm-ghcr-login.sh — log the review VM in to ghcr.io, so it can pull the
# release images. Run by the owner, on the controller. Idempotent: running it
# again replaces the login and the recorded expiry.
#
# The credential is the owner's CLASSIC personal access token, scoped
# read:packages and nothing else (CLAUDE.md rule 3, "the VM's registry pull
# login"). This script
#
#   1. reads the token from stdin, or from a 0600 file (--token-file). Never
#      from argv or the environment, and it never puts it in either: GitHub's
#      API gets it as a curl config on stdin, the VM gets it on ssh's stdin;
#   2. asks api.github.com who the token is, and REFUSES it unless the
#      X-OAuth-Scopes header is exactly `read:packages` (a fine-grained token
#      sends no such header, so it is refused too) and the token carries an
#      expiry (GitHub-Authentication-Token-Expiration);
#   3. runs `ssh <vm> sudo docker login ghcr.io -u <login> --password-stdin`,
#      which stores the login in root's docker config on the VM host and
#      nowhere else — never in a container, env, argv or secrets/;
#   4. checks the login with `docker manifest inspect` of the named published
#      version of both release images;
#   5. only then records the expiry (one ISO UTC line, no secret) under the
#      install's state home, where `deploy.sh verify` warns 14 days before it.
#
# Usage:
#   scripts/vm-ghcr-login.sh --version X.Y.Z [--vm HOST] [--login USER] [--token-file FILE]
#   pbpaste | scripts/vm-ghcr-login.sh --version X.Y.Z      # token on stdin
#
#   --version      a published release version; both images must exist at it
#   --vm           ssh target (default: $QC_VM_HOST, else the inventory's first host)
#   --login        the GitHub login to store (default: the token's own; if given
#                  it must be the token's)
#   --token-file   a regular 0600 file holding the token (left in place)
#
# Env:
#   QC_VM_HOST, QC_INVENTORY       as for deploy.sh
#   QC_RELEASE_IMAGE, QC_RELEASE_MEMORY_IMAGE
#                  the image names (default: the group_vars' ghcr.io/quickchatai pair)
#   QC_GITHUB_API  the API base (default https://api.github.com)
#   QC_NOW_EPOCH   the clock, for tests
#   QCR_GHCR_EXPIRY_FILE  where the expiry is recorded (default: <state home>/ghcr-token-expiry)

set -euo pipefail
set +x

SELF="$(basename "${BASH_SOURCE[0]}")"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
. "$(dirname "${BASH_SOURCE[0]}")/install-locator.sh"

RELEASE_VERSION_RE='^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$'
GITHUB_LOGIN_RE='^[A-Za-z0-9]([A-Za-z0-9-]{0,38})$'
DAEMON_IMAGE="${QC_RELEASE_IMAGE:-ghcr.io/quickchatai/quickreview}"
MEMORY_IMAGE="${QC_RELEASE_MEMORY_IMAGE:-ghcr.io/quickchatai/quickreview-memory}"
API="${QC_GITHUB_API:-https://api.github.com}"

die() { echo "$SELF: $*" >&2; exit 1; }
note() { echo "$SELF: $*" >&2; }

VERSION=""
VM=""
LOGIN=""
TOKEN_FILE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --version)    [[ $# -ge 2 ]] || die "--version needs a value"; VERSION="$2"; shift ;;
    --vm)         [[ $# -ge 2 ]] || die "--vm needs a value"; VM="$2"; shift ;;
    --login)      [[ $# -ge 2 ]] || die "--login needs a value"; LOGIN="$2"; shift ;;
    --token-file) [[ $# -ge 2 ]] || die "--token-file needs a path"; TOKEN_FILE="$2"; shift ;;
    -h|--help)    sed -n '2,/^$/p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    --token|--token=*|--password|--password=*)
      die "the token is never an argument: pipe it in, or use --token-file" ;;
    *) die "unknown argument '$1' (usage: $SELF --version X.Y.Z [--vm HOST] [--login USER] [--token-file FILE])" ;;
  esac
  shift
done

[[ -n "$VERSION" ]] || die "--version is required: the login is checked against a published version of both images"
[[ "$VERSION" =~ $RELEASE_VERSION_RE ]] || die "version '$VERSION' is not X.Y.Z (optionally -prerelease)"
if [[ -n "$LOGIN" && ! "$LOGIN" =~ $GITHUB_LOGIN_RE ]]; then
  die "login '$LOGIN' is not a GitHub login"
fi

if [[ -z "$VM" ]]; then
  VM="${QC_VM_HOST:-}"
fi
if [[ -z "$VM" ]]; then
  INVENTORY="${QC_INVENTORY:-$ROOT/deploy/ansible/inventory.ini}"
  if [[ -f "$INVENTORY" ]]; then
    VM="$(awk '/^[[:space:]]*[#;]/ { next } /^[[:space:]]*\[/ { next } NF { print $1; exit }' "$INVENTORY")"
  fi
fi
[[ -n "$VM" ]] || die "no VM host: pass --vm, or set QC_VM_HOST"
# It is an ssh destination, and ssh would read a leading '-' as an option.
[[ "$VM" =~ ^[A-Za-z0-9_][A-Za-z0-9_.@:-]*$ ]] || die "vm host '$VM' is not a plain ssh destination"

# ---- the token: stdin or a 0600 file, held in a shell variable only ----------

TOKEN=""
if [[ -n "$TOKEN_FILE" ]]; then
  [[ -f "$TOKEN_FILE" && ! -L "$TOKEN_FILE" ]] || die "$TOKEN_FILE is not a regular file"
  mode="$(stat -c %a "$TOKEN_FILE" 2>/dev/null || stat -f %Lp "$TOKEN_FILE")"
  [[ "$mode" == 600 ]] || die "$TOKEN_FILE is mode $mode: the token file must be 0600 (chmod 600 it)"
  TOKEN="$(<"$TOKEN_FILE")"
elif [[ -t 0 ]]; then
  read -rsp "classic read:packages token: " TOKEN
  echo >&2
else
  TOKEN="$(cat)"
fi
TOKEN="${TOKEN//[[:space:]]/}"
[[ -n "$TOKEN" ]] || die "no token on stdin or in the file"
[[ "$TOKEN" =~ ^[A-Za-z0-9_]+$ ]] || die "that does not look like a GitHub token (one word of letters, digits and underscores)"

# ---- what the token is: scopes, expiry, owner --------------------------------

# GitHub gets the token as a curl config on stdin: printf is a builtin, so it is
# in no argv, and curl is given no environment variable for it either.
RESPONSE="$(printf 'header = "Authorization: Bearer %s"\n' "$TOKEN" |
  curl -sS -i --config - -H 'Accept: application/vnd.github+json' "$API/user")" ||
  die "could not reach $API"
RESPONSE="${RESPONSE//$'\r'/}"
HEADERS="${RESPONSE%%$'\n\n'*}"
BODY="${RESPONSE#*$'\n\n'}"

STATUS="$(sed -n '1s/^HTTP\/[0-9.]* \([0-9]*\).*/\1/p' <<<"$HEADERS")"
[[ "$STATUS" == 200 ]] || die "GitHub answered ${STATUS:-no status} to the token: it is not a valid token"

header_value() { # header_value <lowercase-name>
  awk -v want="$1" '
    NR > 1 {
      i = index($0, ":"); if (!i) next
      name = tolower(substr($0, 1, i - 1))
      if (name == want) { v = substr($0, i + 1); sub(/^[[:space:]]+/, "", v); sub(/[[:space:]]+$/, "", v); print v; exit }
    }' <<<"$HEADERS"
}

SCOPES="$(header_value x-oauth-scopes)"
if [[ "$SCOPES" != "read:packages" ]]; then
  if [[ -z "$(grep -i '^x-oauth-scopes:' <<<"$HEADERS" || true)" ]]; then
    die "refusing the token: it is not a classic personal access token (GitHub sent no X-OAuth-Scopes). Create a CLASSIC token with the read:packages scope and nothing else"
  fi
  die "refusing the token: its scopes are \"${SCOPES:-none}\", and they must be exactly \"read:packages\". Create a classic token with that one scope"
fi

EXPIRY_RAW="$(header_value github-authentication-token-expiration)"
[[ -n "$EXPIRY_RAW" ]] || die "refusing the token: it has no expiry (no GitHub-Authentication-Token-Expiration). The ruling is a one-year token; create it with an expiration"

# "2026-11-18 09:00:00 UTC" -> an ISO UTC stamp and its epoch.
if [[ "$EXPIRY_RAW" =~ ^([0-9]{4}-[0-9]{2}-[0-9]{2})[\ T]([0-9]{2}:[0-9]{2}:[0-9]{2})([\ ]*(UTC|Z))?$ ]]; then
  EXPIRY_ISO="${BASH_REMATCH[1]}T${BASH_REMATCH[2]}Z"
else
  die "cannot read the token's expiry \"$EXPIRY_RAW\""
fi
EXPIRY_EPOCH="$(date -u -d "$EXPIRY_ISO" +%s 2>/dev/null || date -u -j -f '%Y-%m-%dT%H:%M:%SZ' "$EXPIRY_ISO" +%s 2>/dev/null)" ||
  die "cannot read the token's expiry \"$EXPIRY_RAW\""
NOW="${QC_NOW_EPOCH:-$(date -u +%s)}"
(( EXPIRY_EPOCH > NOW )) || die "refusing the token: it expired at $EXPIRY_ISO"

API_LOGIN="$(grep -o '"login"[[:space:]]*:[[:space:]]*"[^"]*"' <<<"$BODY" | head -1 | sed 's/.*:[[:space:]]*"\(.*\)"/\1/')"
[[ "$API_LOGIN" =~ $GITHUB_LOGIN_RE ]] || die "GitHub did not say whose token this is"
if [[ -n "$LOGIN" && "$LOGIN" != "$API_LOGIN" ]]; then
  die "the token belongs to \"$API_LOGIN\", not \"$LOGIN\""
fi
LOGIN="$API_LOGIN"
note "token ok: read:packages only, account $LOGIN, expires $EXPIRY_ISO"

# ---- the login, in root's docker config on the VM host -----------------------

printf '%s\n' "$TOKEN" |
  ssh -T -o BatchMode=yes "$VM" sudo docker login ghcr.io -u "$LOGIN" --password-stdin ||
  die "docker login on $VM failed; nothing was recorded"

# ---- the check: both images, at the named version ----------------------------

for image in "$DAEMON_IMAGE" "$MEMORY_IMAGE"; do
  ssh -T -o BatchMode=yes "$VM" sudo docker manifest inspect "$image:$VERSION" </dev/null >/dev/null ||
    die "the VM is logged in, but cannot read $image:$VERSION: is that version published, and was the token made by an account that can read the package? Re-run when it is"
  note "$VM can read $image:$VERSION"
done

# ---- the record --------------------------------------------------------------

EXPIRY_FILE="$(qcr_ghcr_expiry_file)" || exit 1
mkdir -p "$(dirname "$EXPIRY_FILE")"
(umask 077 && printf '%s\n' "$EXPIRY_ISO" >"$EXPIRY_FILE.tmp") && mv -f "$EXPIRY_FILE.tmp" "$EXPIRY_FILE"
note "recorded the expiry ($EXPIRY_ISO) in $EXPIRY_FILE; deploy.sh verify warns 14 days before it"
note "done: $VM pulls from ghcr.io as $LOGIN"
