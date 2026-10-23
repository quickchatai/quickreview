#!/usr/bin/env bash
# Build the release and memory images from HEAD for the worker rehearsal.
#
#   scripts/worker-rehearsal/build-images.sh <release-tag> <memory-tag>
#
# The Dockerfiles are written for BuildKit, which reads <Dockerfile>.dockerignore as an
# allowlist. A host without buildx runs the legacy builder, which ignores that file and
# would send (or fail to find) the context. So the context is STAGED here from the same
# allowlist: exactly the paths the file un-ignores, copied out of `git ls-files` of HEAD
# (a committed tree, never the working directory's dirt), and the build runs on that.
set -euo pipefail
ROOT="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../.." && pwd)"
REL_TAG="${1:?usage: build-images.sh <release-tag> <memory-tag>}"
MEM_TAG="${2:?usage: build-images.sh <release-tag> <memory-tag>}"
SHA="$(git -C "$ROOT" rev-parse HEAD)"   # the full sha: the deploy manifest's revision is 40 hex
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

stage() { # <dockerignore> <dest>
  local ign="$1" dest="$2" path
  mkdir -p "$dest"
  while IFS= read -r path; do
    git -C "$ROOT" ls-tree -r -z --name-only HEAD -- "$path" \
      | xargs -0 -r git -C "$ROOT" archive HEAD -- | tar -x -C "$dest"
  done < <(sed -n 's/^!//p' "$ign")
  mkdir -p "$dest/docker"
}

stage "$ROOT/docker/Dockerfile.dockerignore" "$WORK/release"
cp "$ROOT/docker/Dockerfile" "$WORK/release/Dockerfile"
echo "== release image $REL_TAG from $SHA" >&2
docker build --build-arg "BUILD_SHA=$SHA" -t "$REL_TAG" "$WORK/release"

stage "$ROOT/docker/memory/Dockerfile.dockerignore" "$WORK/memory"
cp "$ROOT/docker/memory/Dockerfile" "$WORK/memory/Dockerfile"
echo "== memory image $MEM_TAG from $SHA" >&2
docker build --build-arg "BUILD_SHA=$SHA" -t "$MEM_TAG" "$WORK/memory"
