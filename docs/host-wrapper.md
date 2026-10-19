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
home that holds `<install>/secrets/` (D39 amending R12). The gh config and
`docker.sock` are never mounted, and the ssh agent only into the TUI container
(below).

A call that can reach a model or GitHub starts as root with only `CAP_SETUID`
and `CAP_SETGID` and drops to your uid inside, so the model's tools run as
another uid (D32, `docker/entrypoint.sh`). `version`, `help`, `install`, `tui`
and `login` start as you.

## The TUI and its companion (D35)

`qcr` (and `qcr tui`) is two containers and no `docker.sock` anywhere. A TUI in
a container cannot run `docker exec`, and handing it the socket would make it
the host, so the wrapper does the companion's docker work itself, on the host,
and the two containers meet in a named volume.

1. **The companion, started by the wrapper.** The wrapper asks the image for the
   run it should make (`qcr companion plan`, `src/tui/companionplan.ts`): the
   mount list lives in one place, `CompanionLifecycle` in `src/tui/companion.ts`,
   and the shell holds no copy of it. The plan carries a hash, which the
   container carries as the label `qcr.plan`. The wrapper adopts a running
   container whose label matches, starts a stopped one, and removes and
   recreates one whose label differs (a new image after `qcr update`, a changed
   mount, a new flag) or that will not start; the pi home and the login are on
   volumes, so a recreate resumes. The companion is `qcr-tui-companion`, with its
   own pi home volume `qcr-companion-pihome`, so it never adopts or recreates a
   clone-route companion on the same machine. It has no ssh agent, no `~/.ssh`
   and no `docker.sock` (rule 8), and no memory (the sidecar is opt-in on a
   laptop). Its tmux server listens on `/run/qcr-tmux/companion.sock`, inside
   the `qcr-tui-companion-tmux` volume.
2. **The TUI container.** It mounts that volume and drives the companion with
   `tmux -S <socket>` where the clone route runs `docker exec`
   (`src/tui/tmuxsocket.ts`; a `sh -c` script goes through `tmux run-shell`, so
   it runs inside the companion; anything else docker-shaped is refused by name,
   and a command that could start a tmux server is held back until one answers,
   so a server is never born in the TUI container). The channel dirs it shares
   with the companion (feed, alerts, evidence, the inject dir, the config
   mirror, the state home, the read-only token dir) are host dirs under the
   operator state home, created by the wrapper as you and mounted into the TUI
   at their own paths; the wrapper tells the TUI the host's `HOME` and XDG dirs
   in `QCR_HOST_*`, so both sides derive the same paths.
3. **The ssh runner's credentials go to the TUI container alone**, read-only:
   `SSH_AUTH_SOCK` (the host agent socket, or Docker Desktop's relay of it on
   macOS) at `/run/qcr-ssh-agent`, and `~/.ssh/config` and `~/.ssh/known_hosts`.
   The image gives ssh a passwd entry for the caller's uid (nss_wrapper), which
   it refuses to run without. An `Include`d file, an `IdentityFile` or a
   `ControlPath` under `~/.ssh` is not mounted: use the agent and a
   `ControlPath` outside `~/.ssh`, or `[tui] target = "local"`.
4. **The TUI reads the install's own `config.toml`** (`$QCR_CONFIG`, else
   `$XDG_CONFIG_HOME/qcr/<install>/config.toml`) when there is one, mounted
   read-only as that single file; otherwise the baked example.
5. **Quit stops the companion**, unless another TUI container is still running
   (label `qcr.role=tui`). A crash leaves it running, and the next start adopts
   it.

`--no-companion` (or `QCR_NO_COMPANION`) runs the TUI alone. A plan that cannot
be had, or a companion that will not run, does the same, with one line saying
so. The owner's dev TUI with hot reload (rule 11) stays on the clone route.

## The login

`qcr login` is pi's own `/login`, typed for you in a throwaway container: the
same script the clone route's `qcr scan login` uses (`loginInPi`,
`src/scanbox.ts`). It is the only call that mounts the `qcr-login` volume
read-write (at pi's agent dir); it holds no repo, no state, no profiles and no
GitHub token. Every other call mounts it read-only at `/qcr-login`, and the
engine takes a refresh-disabled copy of it (`src/engine/auth.ts`): only a
login ever refreshes. A headless run with `OPENAI_API_KEY` (or another model
key) in the environment reads no login at all, and nothing ever starts one.

The volume outlives every uid. Each call joins a fixed group (gid 4747,
`--group-add`, `QCR_LOGIN_GID`); when pi exits, `login` moves everything pi
wrote into that group at `0660` (directories `2770`); the cli mode keeps the
group when it drops to `QCR_RUN_UID`, while the model's tools, which clear
their groups, never hold it. So a login made under one uid is read under any
other, and a later login under a third can rewrite it. The files stay closed
to every uid outside the group. (`0660`, not `0640`, because a re-login under
another uid must be able to write.)

A new volume starts as the image's `/home/qcr/.pi/agent` is, which the
Dockerfile makes `0777` so that any uid can log in the first time.

To check a login by hand, with no model call: `qcr login`, finish pi's
`/login`, quit pi; then
`docker run --rm --mount type=volume,src=qcr-login,dst=/l,readonly --user 4321:4321 --group-add 4747 --entrypoint ls <image> -ln /l`
lists `auth.json` as `0660`, group 4747, and `cat`ing it works under that
other uid; the same line without `--group-add 4747` is refused.

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

- `qcr` opens the TUI (`tui` mode) and runs its companion (see "The TUI and its
  companion"); `qcr tui [pr|overseer]` the same with arguments.
- `qcr login [provider]` runs pi's own `/login` over the `qcr-login` volume
  (see "The login" below).
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
