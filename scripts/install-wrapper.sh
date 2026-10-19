#!/bin/sh
# The image's `install` mode (docker/entrypoint.sh): the host wrapper, pinned.
#
#   docker run --rm --user "$(id -u):$(id -g)" -v ~/.local/bin:/out IMAGE install
#       writes /out/qcr (D14: the -v ~/.local/bin:/out shape);
#   docker run --rm IMAGE install | sh
#       with no /out mounted, prints a script that writes ~/.local/bin/qcr.
#
# The wrapper (scripts/qcr-host.sh) is the image's own copy with the image
# pinned into it: QCR_IMAGE if the caller named one (`qcr update` does), else
# ghcr.io/<owner>/<name>:<this image's version>, owner and name from
# package.json's repository URL. The image cannot see its own tag or digest
# from inside, so a local or retagged image is installed with
# -e QCR_IMAGE=<its tag>.
#
# Nothing but the wrapper (or the printed installer) goes to stdout.
set -eu

APP="${QCR_APP_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
OUT="${QCR_INSTALL_OUT:-/out}"

die() {
  echo "qcr-install: $*" >&2
  exit 1
}

template="$APP/scripts/qcr-host.sh"
[ -f "$template" ] || die "the wrapper template is missing: $template"

image="${QCR_IMAGE:-}"
if [ -z "$image" ]; then
  image="$(node -e '
    const pkg = require(process.argv[1]);
    const m = /github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?$/.exec(pkg.repository?.url ?? "");
    if (!m || !pkg.version) process.exit(1);
    console.log("ghcr.io/" + m[1].toLowerCase() + "/" + m[2].toLowerCase() + ":" + pkg.version);
  ' "$APP/package.json" 2>/dev/null)" ||
    die "cannot tell the image from $APP/package.json (repository url, version): name it with -e QCR_IMAGE=<ref>"
fi
# One option-safe token, and nothing the substitution below could misread.
case "$image" in
  '' | -* | *[!A-Za-z0-9._/:@-]*) die "QCR_IMAGE \"$image\" is not an image reference" ;;
esac

wrapper="$(sed "s|@@QCR_IMAGE@@|$image|" "$template")"
case "$wrapper" in *@@QCR_IMAGE@@*) die "the wrapper template has no image placeholder" ;; esac
case "$wrapper" in *QCR_WRAPPER_EOF*) die "the wrapper template holds the installer's terminator" ;; esac

if [ -d "$OUT" ]; then
  [ -w "$OUT" ] ||
    die "$OUT is not writable by uid $(id -u) — run with --user \"\$(id -u):\$(id -g)\" so the file is yours"
  tmp="$(mktemp "$OUT/.qcr.XXXXXX")"
  printf '%s\n' "$wrapper" >"$tmp"
  chmod 0755 "$tmp"
  mv -f "$tmp" "$OUT/qcr"
  echo "qcr-install: wrote $OUT/qcr, pinned to $image" >&2
  exit 0
fi

# No /out: the installer for `| sh`. It writes the same file, atomically.
cat <<INSTALLER
set -eu
dest="\$HOME/.local/bin"
mkdir -p "\$dest"
tmp="\$(mktemp "\$dest/.qcr.XXXXXX")"
cat >"\$tmp" <<'QCR_WRAPPER_EOF'
$wrapper
QCR_WRAPPER_EOF
chmod 0755 "\$tmp"
mv -f "\$tmp" "\$dest/qcr"
echo "qcr: installed \$dest/qcr, pinned to $image" >&2
case ":\$PATH:" in
  *":\$dest:"*) ;;
  *) echo "qcr: add \$dest to your PATH" >&2 ;;
esac
INSTALLER
