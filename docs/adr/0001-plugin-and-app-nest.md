---
status: accepted
built: yes — the plugin side is built (FT-0666, FT-0667, FT-0668); the app's home is being built on the first-run-home map
---

# The plugin and the app nest: each works without the one outside it

Quickreview ships as two npm packages that nest like dolls. The inner one, the
**plugin** (`@quickchatai/pi-quickreview`, `packages/pi-plugin`), is everything
a person using plain pi needs to review code. The outer one, the **app**
(`@quickchatai/quickreview`, the repo root, the `qcr` bin), is everything that
turns the plugin into a managed product. The line is not where code runs: the
app's home is a pi session too. The line is whether a plain pi user needs it to
review. Each doll works without the one outside it, and never the reverse.

## The plugin (inner doll)

- **The review core:** the engine, the lens plan and planner, the
  MutationGate and its guards, the renderer, and repo profiles.
- **Three commands, namespaced, each also shipped as a skill of the same
  name:**
  - **`/qcr-review [preset] [target]`:** presets such as quick, full or
    security are an argument, not separate commands. The bare command reviews
    the current branch against its base plus the uncommitted changes, as one
    review.
  - **`/qcr-scan`:** the whole-repo scan, run by the core itself, with no
    `qcr` CLI needed.
  - **`/qcr-setup`:** only what the plugin can do. It checks the pi range, the
    login, git and the GitHub credential, and it sets up this repo's profile.
- **Reviews run in the background.** The chat stays free, a status line shows
  progress, and the result arrives as a message.
- **Posting is opt-in.** After a review the plugin asks whether to post it to
  the PR as a comment-only review, through the gate. The default is no, and
  the posting rule is configurable.
- **Settings:** per-repo rules live in the repo's profile; personal defaults,
  such as the posting rule and the default preset, live in pi's own settings.
  The plugin reads no app config file.
- **No reviewer memory.** The core's memory port stays empty unless a host
  fills it.

## The app (outer doll)

- **Its own customised pi:** the app runs pi at its exact pin with the plugin
  and the app's extensions loaded. That pi is the **home**: the first-run
  login flow (pi's device code), the setup checklist, the PR list, the review
  buttons and the auto-review switch. A bare `qcr` and Boxes' `start-box` open
  it.
- **Setup extends the plugin's:** the app's setup is the plugin's checklist
  with more steps registered onto it (GitHub account, repository, auto-review),
  not a second checklist.
- **Auto-review:** the always-on daemon, its workers, and the image modes.
- **The admin TUI** (`qcr tui`), and the companion container it starts.
- **Reviewer memory:** the memory engine, plugged into the core through the
  memory port.
- **Slack, the learning loop, and `/selfimprove`.**

## Why

A person who only wants a better `/review` in their own pi should not need a
daemon, Docker, a config file or a second login. A person who wants the
managed experience should get the same review engine, not a fork of it. Nesting
gives both: the app consumes the plugin through its public seams (commands,
the setup step registry, the memory port, review options), and the plugin
never knows the app exists.

## Considered options

- **Keep the review core and its pi commands as separate packages.** Rejected:
  nobody installs the core except through pi or the app, and a third package
  adds a version to keep in step for no user.
- **A thin `qcr` front-door package beside the plugin and the app.** Rejected:
  the app already is the `qcr` bin.
- **Put the home in the plugin, so any pi gets it.** Rejected: the home, its
  setup and auto-review are the managed product, which is the app's job.

## Consequences

- **The old command names are dropped.** `/review`, `/scan` and
  `/selfimprove` are not kept as aliases. This is a deliberate exception to the
  legacy-input-folds rule, because the plugin's commands share pi's command
  namespace with every other extension. When the rename is built, the
  plugin's command tests and any legacy-acceptance entries for these names
  change with it.
- **The tree used to differ in four places**, and the build that followed
  this ADR closed them:
  - `/scan` and `/selfimprove` ran the `qcr` CLI. Now `/qcr-scan` runs the
    plugin's own scan engine, and `/selfimprove` is the app's.
  - `/qcr-setup` offered to `npm i -g` the app. Now it runs only the
    plugin's own steps.
  - The commands were not namespaced. Now they are `/qcr-review`,
    `/qcr-scan` and `/qcr-setup`.
  - The commands were not shipped as skills. Now each one is.
- **A fence proves the nesting:** the plugin, installed alone (packed and
  installed with no app), runs `/qcr-review` and `/qcr-scan`. The existing
  layer fence (`tests/layers.test.ts`: the core never imports the app) stays.
