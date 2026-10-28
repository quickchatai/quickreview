# macOS pre-tag checklist

Run this on a Mac, by hand, before a `vX.Y.Z` release tag is pushed. CI
cannot do it: the release workflow tests the image on Linux runners, and
the host wrapper (`scripts/qcr-host.sh`) is the part that behaves differently
on macOS: its temp directory, its tools (BSD `mktemp`, no `timeout`), and the
Docker Desktop VM between the wrapper and the kernel.

It costs nothing: no model is called, no GitHub token is needed, and nothing
is pushed. Allow about ten minutes, plus the image build if you build it.

Record the outcome in the release notes or the release ticket: macOS version,
chip, Docker Desktop version, the `ptrace_scope` value from step 4, and a pass
or a failure per step. A failed step blocks the tag.

## Before you start

- A Mac with Docker Desktop running (`docker info` answers). Note the chip:
  an Apple silicon Mac exercises the `linux/arm64` image natively, an Intel Mac
  the `linux/amd64` one. If you can, run both once per release series.
- The commit you are about to tag, checked out clean.
- No model login or API key is needed. Do not set `OPENAI_API_KEY` or any other
  model key in this shell: the run below must not reach a model, and with no key
  and no login it cannot.

## 1. The image

Build the release image from the commit to be tagged, so the check covers
exactly what the tag will publish:

```sh
docker build -f docker/Dockerfile --build-arg BUILD_SHA="$(git rev-parse HEAD)" -t qcr-mac:check .
```

(BuildKit is required; Docker Desktop has it on. The build runs the image's
own checks: seeds against the manifest, the three pi versions, no `claude`.)

The alternative is a scratch release (`workflow_dispatch` with a
`X.Y.Z-scratch.N` version) pulled from the registry. A
locally built image is the quicker path and needs no registry login.

```sh
export QCR_IMAGE=qcr-mac:check
docker run --rm "$QCR_IMAGE" version --json
```

Pass: JSON with `schema_version`, an `image.version`, and a `pi.version` equal
to the pin in `config.example.toml`.

## 2. The wrapper install

The wrapper is written by the image, never copied from the checkout:

```sh
mkdir -p "$HOME/.local/bin"
docker run --rm --user "$(id -u):$(id -g)" -e "QCR_IMAGE=$QCR_IMAGE" \
  -v "$HOME/.local/bin:/out" "$QCR_IMAGE" install
```

Pass:

- `~/.local/bin/qcr` exists, is executable, and `sh -n ~/.local/bin/qcr` is
  silent;
- `grep qcr-mac:check ~/.local/bin/qcr` finds the pinned image;
- `~/.local/bin` is on `PATH` (`command -v qcr`), or you call it by path below;
- `qcr version` and `qcr help` answer. macOS ships no `timeout` and has BSD
  `mktemp`, `date` and `stat`; the wrapper must run on them as they are.

If the install wrote the file but the wrapper then dies on a missing tool or a
BSD-versus-GNU flag, that is the failure this step exists to find.

## 3. The token handoff directory, under `$TMPDIR`

On macOS the wrapper stages the GitHub token in a fresh `0700` directory made
by `mktemp -d` under `$TMPDIR` (a per-user path under `/var/folders/`), writes
the token as a `0600` file, bind-mounts the directory at `/run/qcr-in`, and the
image reads and unlinks it. Four things can differ from Linux: the path, the
mount through Docker Desktop's file sharing, the unlink through that mount, and
the clean-up. Check each, with a throwaway value, never a real token:

```sh
echo "$TMPDIR"                      # a /var/folders/... path, trailing slash or not
d="$(umask 077 && mktemp -d "${TMPDIR:-/tmp}/qcr-in.XXXXXX")"
ls -ld "$d"                         # drwx------, owned by you
(umask 077 && printf '%s' 'not-a-real-token' > "$d/gh-token")
ls -l "$d"                          # -rw-------

# The mount carries the file in, as the user the wrapper runs the call as:
docker run --rm --user "$(id -u):$(id -g)" --entrypoint sh \
  --mount "type=bind,src=$d,dst=/run/qcr-in" "$QCR_IMAGE" \
  -c 'ls -l /run/qcr-in; cat /run/qcr-in/gh-token >/dev/null && echo readable'
```

Pass: the container lists `gh-token` and prints `readable`. If the mount is
refused (`mounts denied`, `not shared from the host`), `$TMPDIR`'s parent is not
in Docker Desktop's file-sharing list (Settings, Resources, File sharing): note
which path and either add it or record that the wrapper needs a different base
on macOS. That is a finding, not a pass.

Now the unlink, through the mount, which is the half that matters:

```sh
docker run --rm --user "$(id -u):$(id -g)" \
  --cap-drop ALL --security-opt no-new-privileges \
  --mount "type=bind,src=$d,dst=/run/qcr-in" \
  -e QCR_GH_TOKEN_FILE=/run/qcr-in/gh-token \
  "$QCR_IMAGE" cli version --json >/dev/null
ls -A "$d"                          # must print nothing: the image read and unlinked it
rm -rf "$d"
```

Pass: the directory is empty afterwards. A token file still there means the
unlink did not cross Docker Desktop's file sharing and the handoff is unsound
on this setup; stop and record it.

Last, the clean-up the wrapper itself does. Run step 5 below with a dummy
`GITHUB_TOKEN`, then:

```sh
ls -d "${TMPDIR:-/tmp}"/qcr-in.* 2>/dev/null   # must print nothing
```

## 4. The Docker Desktop VM's `ptrace_scope`, recorded

Docker Desktop runs containers in a Linux VM, and that VM's kernel decides
whether a child process can read its parent's memory. Yama's
`kernel.yama.ptrace_scope` at 1 or above blocks it; at 0 it does not. The
value is not documented for Docker Desktop and can change between versions, so
the release records it. It is not a pass or fail: the image keeps the model's
tools on a separate uid and bash-guard denies `/proc` reads where it runs. It is
what a reviewer of the release needs to know.

```sh
docker run --rm --entrypoint cat "$QCR_IMAGE" /proc/sys/kernel/yama/ptrace_scope
```

(`/proc/sys` is the VM kernel's, so this is the VM's value. A line reading
`No such file` means the VM has no Yama; record `absent`.) The same value is
printed at the start of any call run with `QCR_DEBUG=1`:

```sh
# from inside the fixture repo of step 5
QCR_DEBUG=1 qcr review --preview --json 2>&1 >/dev/null | grep ptrace_scope
```

Record: `kernel.yama.ptrace_scope = <0|1|2|3|absent>`, with the Docker Desktop
version and the VM backend (Settings, General). Compare it with the Linux
runner's value in the release smoke's job summary; a different value is worth a
line in the release notes, not a blocked tag.

## 5. One run with no model

```sh
repo="$(mktemp -d "${TMPDIR:-/tmp}/qcr-fixture.XXXXXX")"
git -C "$repo" init -q -b main
printf 'a\n' > "$repo/a.txt"
git -C "$repo" add .
git -C "$repo" -c user.email=check@example.com -c user.name=check commit -qm base
git -C "$repo" checkout -qb feat
printf 'a\nb\n' > "$repo/a.txt"
git -C "$repo" -c user.email=check@example.com -c user.name=check commit -qam feat

cd "$repo"
GITHUB_TOKEN=not-a-real-token qcr review --preview --json
```

Pass:

- the output is one JSON object whose first key is `schema_version`, with
  `"ok": true` and `"preview"` naming branch `feat`, the same shape the image
  smoke checks on Linux (`.github/ci/image-smoke.sh`);
- the call exits 0, quickly, and made no model call (nothing was logged in, and
  no key was set);
- the repo you stood in is unchanged (`git status` is clean); it was mounted
  read-only;
- the clean-up check at the end of step 3 now passes.

Then `cd -` and `rm -rf "$repo"`.

## 6. Clean up and record

```sh
docker rmi qcr-mac:check
rm -f "$HOME/.local/bin/qcr"        # only if it was not there before this check
```

Write down: macOS version, chip, Docker Desktop version, the `ptrace_scope`
value, each step's result, and anything you had to change on the Mac to make a
step pass (a file-sharing entry, a missing tool). A step that passed only after
a Mac-side change is a finding for the user docs, even though the tag may go.
