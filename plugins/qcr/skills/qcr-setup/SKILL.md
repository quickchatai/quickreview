---
name: qcr-setup
description: Set up qcr on this machine so the qcr review and scan skills work — checks Docker, then access to the private qcr image, then installs the qcr wrapper, then model login. Use when the user asks to set up, install or fix qcr, or when a qcr call fails because qcr, Docker, the image pull or the login is missing.
---

# Setting up qcr

qcr runs in a Docker image. Setup brings a machine to a working `qcr` in a fixed order, and skips what is already done, so running it again is safe.

Run the script, from the plugin:

```sh
sh "${CLAUDE_PLUGIN_ROOT}/scripts/qcr-setup.sh"
```

It checks, in order:

1. **Docker** is installed and its daemon answers.
2. **Pull access.** The image is private. If it cannot be pulled: `gh auth refresh -s read:packages`, then `gh auth token | docker login ghcr.io -u <user> --password-stdin`.
3. **The wrapper.** `docker run … install` writes `~/.local/bin/qcr`, pinned to the image version.
4. **Login.** `qcr login` runs pi's own `/login`. It is skipped when the login volume already holds a login or a model API key is in the environment.

## When it exits 10

Steps 2 and 4 need the person: a browser sign-in and pi's interactive `/login`. You have no terminal for them, so the script prints the exact command and exits 10. Do not retry it and do not work around it. Tell the user to run the printed command themselves (in Claude Code, `! <command>` runs it in their session), then run the script again.

## When it exits 1

A step failed and the message names the fix. Report it as printed. Docker missing or stopped is the user's to install or start.

## Done

The last line is `ready: qcr <version>`. Setup never makes a model call.
