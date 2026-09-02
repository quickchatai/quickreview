#!/usr/bin/env bash
# Interactive wizard: collect the quickreview secrets into ~/.config/quickreview-bot/.
# Values are read with hidden input and NEVER printed back. Re-run any time —
# existing files are kept unless you choose to replace them.
#
# `scripts/qcr onboard` writes app_id / app.pem / webhook_secret itself, from
# the GitHub App manifest exchange, and mints the OpenViking keys — so on the
# guided path you only reach for this script for the values it points you at
# (the OpenAI key, a tunnel token, an ngrok authtoken, the hosted-embeddings
# key under that opt-in). It writes the same file
# names with the same validation and the same 0600 mode; the two paths must
# stay in step. See docs/onboarding.md.
#
# The wizard is deployment-shape-aware: the first choice is HOW the
# GitHub webhook reaches the daemon, and the required set follows from it.
#   tunnel — a Cloudflare Tunnel on the host fronts the webhook port
#            (tunnel_token REQUIRED)
#   docker — plain Docker; you bring your own ingress/TLS to the webhook port
#            (tunnel_token not needed)
# The choice persists in <secrets dir>/deploy_shape; QC_DEPLOY_SHAPE=tunnel|docker
# overrides it non-interactively.
#
#   bash deploy/collect-secrets.sh          # prompt for whatever is missing
#   bash deploy/collect-secrets.sh --force  # offer to replace existing files too
set -euo pipefail

DIR="${QC_SECRETS_DIR:-$HOME/.config/quickreview-bot}"
FORCE=0
[[ "${1:-}" == "--force" ]] && FORCE=1

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
ok()   { printf '  \033[32m✔\033[0m %s\n' "$*"; }
bad()  { printf '  \033[31m✘\033[0m %s\n' "$*"; }
info() { printf '  · %s\n' "$*"; }

mkdir -p "$DIR"
chmod 700 "$DIR"

SHAPE_FILE="$DIR/deploy_shape"

status_of() { # file
  if [[ -s "$DIR/$1" ]]; then
    printf 'present (%s bytes, %s)' "$(wc -c < "$DIR/$1" | tr -d ' ')" "$(date -r "$DIR/$1" '+%Y-%m-%d %H:%M')"
  else
    printf 'MISSING'
  fi
}

shape() { # -> "tunnel" | "docker" | "" (unset)
  if [[ -s "$SHAPE_FILE" ]]; then cat "$SHAPE_FILE"; fi
}

save_shape() { # tunnel|docker
  umask 077
  printf '%s' "$1" > "$SHAPE_FILE"
  chmod 600 "$SHAPE_FILE"
}

choose_shape() {
  if [[ -n "${QC_DEPLOY_SHAPE:-}" ]]; then
    case "$QC_DEPLOY_SHAPE" in
      tunnel|docker) save_shape "$QC_DEPLOY_SHAPE"; info "deployment shape: $QC_DEPLOY_SHAPE (from QC_DEPLOY_SHAPE)"; return 0 ;;
      *) bad "QC_DEPLOY_SHAPE must be 'tunnel' or 'docker' (got: $QC_DEPLOY_SHAPE)"; exit 1 ;;
    esac
  fi
  local current; current="$(shape)"
  if [[ -n "$current" && $FORCE -eq 0 ]]; then
    info "deployment shape: $current (stored; re-run with --force to change)"
    return 0
  fi
  bold "deployment shape — how does the GitHub webhook reach the daemon?"
  info "1) tunnel — Cloudflare Tunnel on the host fronts the webhook port (needs tunnel_token)"
  info "2) docker — plain Docker; you bring your own ingress/TLS to the webhook port (no tunnel_token)"
  local a
  while true; do
    if ! read -r -p "  choose [1/2]${current:+ (Enter keeps: $current)}: " a; then
      [[ -n "$current" ]] && { save_shape "$current"; return 0; }
      bad "no input — set QC_DEPLOY_SHAPE=tunnel|docker to choose non-interactively"
      exit 1
    fi
    case "$a" in
      1|tunnel) save_shape tunnel; break ;;
      2|docker) save_shape docker; break ;;
      "") if [[ -n "$current" ]]; then save_shape "$current"; break; fi; bad "pick 1 or 2" ;;
      *) bad "pick 1 or 2" ;;
    esac
  done
  ok "deployment shape: $(shape)"
}

overview() {
  local s; s="$(shape)"
  bold "quickreview secrets — $DIR  (deployment shape: ${s:-unset})"
  for f in app_id app.pem webhook_secret tunnel_token openai_api_key openai_embeddings_api_key openviking_root_key openviking_reviewer_key; do
    printf '  %-24s %s\n' "$f" "$(status_of "$f")"
  done
  if [[ "$s" == "docker" ]]; then
    info "tunnel_token is NOT required under the docker shape (own ingress)"
  else
    info "tunnel_token is required under the tunnel shape"
  fi
  info "openai_api_key is OPTIONAL (pi's model credential on the API-key route; ChatGPT-OAuth route: pi /login instead)"
  info "openai_embeddings_api_key is OPTIONAL and SEPARATE: memory embeds LOCALLY by default and nothing"
  info "but the model call leaves the machine. Only a hosted-embeddings opt-in (config.toml [openviking]"
  info "embedding_provider = \"openai\") reads it — pi's key is never used for embeddings."
  info "openviking_root_key / openviking_reviewer_key: memory. Missing root key => the"
  info "server falls back to auth_mode=dev and per-user confinement is NOT enforced."
  info "NEVER put the COMPANION key here — a review session could read it (rule 8)."
  echo
}

want() { # file  -> 0 if we should prompt for it
  if [[ -s "$DIR/$1" ]]; then
    if [[ $FORCE -eq 1 ]]; then
      read -r -p "  $1 exists — replace it? [y/N] " a
      [[ "$a" == "y" || "$a" == "Y" ]]
    else
      return 1
    fi
  fi
}

save() { # file  (value on stdin)
  umask 077
  cat > "$DIR/$1"
  chmod 600 "$DIR/$1"
}

prompt_hidden() { # file  label  validator-fn
  local file=$1 label=$2 validate=$3 value
  while true; do
    read -r -s -p "  paste $label (input hidden, Enter to submit; empty to skip): " value || value=""
    echo
    if [[ -z "$value" ]]; then
      info "skipped $file"
      return 0
    fi
    if printf '%s' "$value" | "$validate"; then
      printf '%s' "$value" | save "$file"
      ok "$file saved"
      return 0
    fi
    bad "that doesn't look right — try again (or Enter to skip)"
  done
}

# ---- validators (read candidate on stdin, exit 0/1, print reason on stderr) --
v_app_id()   { grep -qE '^[0-9]{1,12}$' || { echo "    app_id must be a number (GitHub App settings → App ID)" >&2; return 1; }; }
v_secret()   { local v; v="$(cat)"; [[ ${#v} -ge 8 ]] || { echo "    suspiciously short (<8 chars)" >&2; return 1; }; }
v_token()    { local v; v="$(cat)"; [[ ${#v} -ge 60 && "$v" != *" "* ]] || { echo "    tunnel token should be one long unbroken string (connector page → the string after 'cloudflared service install')" >&2; return 1; }; }
v_openai()   { grep -qE '^sk-' || { echo "    OpenAI keys start with sk-" >&2; return 1; }; }
# OpenViking keys have no documented prefix — length and "one unbroken string"
# is everything we can honestly assert about them.
v_nonempty() { local v; v="$(cat)"; [[ ${#v} -ge 16 && "$v" != *" "* ]] || { echo "    expected one unbroken string of at least 16 characters" >&2; return 1; }; }

prompt_pem() {
  want app.pem || return 0
  bold "app.pem — the GitHub App private key"
  info "GitHub → Settings → Developer settings → GitHub Apps → your App → Private keys"
  read -r -e -p "  path to the downloaded .pem (or Enter to paste it instead): " pempath || return 0
  if [[ -n "$pempath" ]]; then
    pempath="${pempath/#\~/$HOME}"
    [[ -r "$pempath" ]] || { bad "cannot read $pempath"; return 1; }
    save app.pem < "$pempath"
  else
    info "paste the whole PEM, then Ctrl-D on an empty line:"
    save app.pem
  fi
  if openssl pkey -in "$DIR/app.pem" -noout 2>/dev/null; then
    ok "app.pem saved (valid private key)"
  else
    bad "app.pem does not parse as a private key — re-run to fix"
    rm -f "$DIR/app.pem"
    return 1
  fi
}

choose_shape
overview

if want app_id; then
  bold "app_id — the numeric GitHub App ID"
  prompt_hidden app_id "the App ID" v_app_id
fi

prompt_pem || true

if want webhook_secret; then
  bold "webhook_secret — the secret on the App's webhook config"
  prompt_hidden webhook_secret "the webhook secret" v_secret
fi

if [[ "$(shape)" == "tunnel" ]]; then
  if want tunnel_token; then
    bold "tunnel_token — Cloudflare Zero Trust → Networks → Tunnels → connector token"
    prompt_hidden tunnel_token "the tunnel token" v_token
  fi
fi

if want openai_api_key; then
  bold "openai_api_key — OPTIONAL: pi's model credential on the API-key route (skip under ChatGPT OAuth)"
  info "NOT used for memory embeddings — those run locally unless you opt into a hosted embedder below"
  prompt_hidden openai_api_key "the OpenAI API key" v_openai
fi

# the HOSTED embeddings credential, its OWN file. The shipped
# default embeds memory locally (nothing but the model call leaves), so this
# is needed ONLY by an operator who set config.toml [openviking]
# embedding_provider = "openai". Kept separate from pi's key on purpose: either
# can be set without the other.
if want openai_embeddings_api_key; then
  bold "openai_embeddings_api_key — OPTIONAL: only under the hosted-embeddings opt-in (skip to keep memory local)"
  info "read by the memory engine alone; leaving it unset changes nothing about pi's credential"
  prompt_hidden openai_embeddings_api_key "the OpenAI key for embeddings" v_openai
fi

# the memory engine's identity. Two files, and only two: the SERVER's
# own root key (ov.conf needs it to run in api_key mode; boot provisioning uses
# it to create users) and the REVIEWER user key (the one client credential this
# container may hold). The COMPANION key never belongs on this machine: review
# sessions run in this container, and a companion key they could read would
# defeat the confinement entirely.
if want openviking_root_key; then
  bold "openviking_root_key — the OpenViking SERVER root key (api_key mode + boot provisioning)"
  info "never handed to a session, the companion, or the daemon; ov.conf holds it 0600"
  prompt_hidden openviking_root_key "the OpenViking root key" v_nonempty
fi

if want openviking_reviewer_key; then
  bold "openviking_reviewer_key — the reviewer USER key (daemon + every review session)"
  info "the SAME value goes in ~/.config/quickreview-bot/openviking-keys.env on your PC"
  prompt_hidden openviking_reviewer_key "the reviewer USER key" v_nonempty
fi

echo
overview
SHAPE_NOW="$(shape)"
required=(app_id app.pem webhook_secret)
if [[ "$SHAPE_NOW" == "tunnel" ]]; then
  required+=(tunnel_token)
fi
missing=0
for f in "${required[@]}"; do
  [[ -s "$DIR/$f" ]] || { bad "still missing: $f"; missing=1; }
done
if [[ $missing -eq 0 ]]; then
  ok "all required secrets in place for the '$SHAPE_NOW' shape — tell the session 'secrets done' to continue the deploy"
  if [[ "$SHAPE_NOW" == "docker" && -s "$DIR/tunnel_token" ]]; then
    info "tunnel_token is present but unused under the docker shape"
  fi
else
  info "re-run this wizard to fill the gaps (deploy will refuse until they exist)"
  exit 1
fi
