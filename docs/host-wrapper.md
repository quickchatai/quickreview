# The host wrapper

`qcr` on a laptop is one shell file, `~/.local/bin/qcr`. The release image
writes it and pins its own version into it; everything else runs in a
throwaway container of that image.

## Install

```sh
docker run --rm --user "$(id -u):$(id -g)" -v ~/.local/bin:/out \
  ghcr.io/<owner>/<name>:<version> install
```

writes `~/.local/bin/qcr`. Without the `-v` mount, `install` prints an
installer instead: `docker run --rm <image> install | sh`. A locally built or
retagged image names itself: `-e QCR_IMAGE=<tag>`. The registry path is the owner and name of package.json's repository URL. The wrapper pins the image
version (the tag), not a digest, because an image cannot see its own digest from
inside.

The image is private. Pull it once: `gh auth refresh -s read:packages`, then
`gh auth token | docker login ghcr.io -u <user> --password-stdin`.

## What a call is

Every call is `docker run --rm -i --init` with `--cap-drop ALL` and
`--security-opt no-new-privileges`, plus `-t` when the verb is `tui`, `open`,
`login` or `debug` and both ends are terminals.

| mount                                        | from                                         |                                                                       |
| -------------------------------------------- | -------------------------------------------- | --------------------------------------------------------------------- |
| `/repo` (and the working directory under it) | the repository you stand in                  | read-only                                                             |
| a worktree's common git dir, at its own path | `git rev-parse --git-common-dir`             | read-only                                                             |
| `/opt/qcr/state`                             | volume `qcr-state`                           | read-write                                                            |
| `/qcr-login`                                 | volume `qcr-login`                           | read-only (`qcr login` mounts it read-write at pi's agent dir, alone) |
| `/qcr-config/profiles`                       | `~/.config/qcr/profiles`                     | read-only                                                             |
| `/run/qcr-in`                                | a per-call dir holding the GitHub token file | read-write                                                            |

Only the profiles directory of the config home is mounted, never the install
home that holds `<install>/secrets/` (D39 amending R12). The gh config, the ssh
agent and `docker.sock` are never mounted.

A call that can reach a model or GitHub starts as root with only `CAP_SETUID`
and `CAP_SETGID` and drops to your uid inside, so the model's tools run as
another uid (D32, `docker/entrypoint.sh`). `version`, `help`, `install`, `tui`
and `login` start as you.

## The GitHub token

No GitHub App on a laptop (D14). The wrapper takes `GITHUB_TOKEN`, then
`GH_TOKEN`, then `gh auth token`, writes it to a `0600` file in a fresh `0700`
directory (under `$XDG_RUNTIME_DIR` on Linux, `$TMPDIR` elsewhere), mounts that
directory and names the file in `QCR_GH_TOKEN_FILE`. The image reads the file
once and unlinks it (`src/ghcred.ts`, D39 amending R7). The token is never in
`-e`, `--env` or any argument list, and the directory is removed when the call
ends. Model API keys (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`,
`DIGITALOCEAN_API_KEY`) go by name only: docker reads the value from your
environment.

## Verbs

- `qcr` opens the TUI (`tui` mode); `qcr tui [pr|overseer]` the same with arguments.
- `qcr login [provider]` runs pi's own `/login` over the `qcr-login` volume.
- `qcr scan …` runs in the call's own container, which is the scan sandbox
  (`QCR_IN_SCAN_SANDBOX=1`); `scan start` and `scan stage2 start` get
  `--foreground`, because a driver detached in a throwaway container would end
  with it. The clone route's docker launch (`src/scanbox.ts`) is unchanged.
- Everything else goes to the image's `cli` mode, exactly as typed. The wrapper
  always names the mode, so `qcr daemon` or `qcr mint` cannot select an image mode.
- `qcr update [version]` pulls the image (default `latest`), asks it for its
  version, has it write its own wrapper into a temporary directory and
  replaces `~/.local/bin/qcr` with that file.

## The update notice

After a call on a terminal, at most once a day, the wrapper compares the
registry manifest of the pinned tag with `:latest` and prints one line when they
differ. It never runs in CI (`CI` or `GITHUB_ACTIONS` set), when stderr is not a
terminal, or with `QCR_NO_UPDATE_NOTICE` set, and it never changes the call's
exit status.
