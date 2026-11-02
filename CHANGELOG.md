# Release notes

## Unreleased

### The Claude Code plugin moves off Docker

QuickReview installs into Claude Code, Codex, Copilot CLI, Cursor, opencode,
Gemini CLI and Antigravity from npm, through one installer:
`npx @quickchatai/quickreview plugin install --to <host|all>`, then
`qcr plugin update` and `qcr plugin uninstall --from <host|all>`
([docs/plugin.md](docs/plugin.md)). It needs no Docker, no image and no
GitHub package token.

The Docker-based Claude Code plugin is gone: its setup script, the image
wrapper install it ran, and this repository's own marketplace. If you
installed it, remove it, then install the new one:

```sh
claude plugin uninstall qcr@quickreview
claude plugin marketplace remove quickreview
npx @quickchatai/quickreview plugin install --to claude
```

Name the old plugin in full: the new one is `qcr@quickreview-local`, and both
answer `/qcr:review`. While the old one is installed, `qcr plugin install` and
`qcr plugin update` say so. `qcr plugin install --project` installs into
Claude Code for you in this repository only (`.claude/settings.local.json`).
The release image's own `qcr` wrapper is unchanged.

`qcr scan` on the host scans the checkout it runs in, even when
`[companion] reviewed_repo_dir` names another repository: that setting is
read only outside any checkout. From inside the companion's repository, or a
worktree of it, the scan still uses the companion's checkout and state.
`QCR_REVIEWED_REPO` still names any checkout. A preview and a start now name
the checkout they scan (`repo`).

## 1.3.2

The pi plugin reviews again in a plain pi. Installed with `pi install
npm:@quickchatai/pi-quickreview`, `/qcr-review` failed with
`ERR_MODULE_NOT_FOUND` for `@earendil-works/pi-coding-agent`: pi installs a
package without its peers, and the review's engine, loaded on first use,
looked for pi beside the plugin. The plugin now resolves pi's own packages
from the running pi. The `qcr` app was not affected.

The bot rides out a provider blip and raises less noise:

- **A breaker drain lifts itself.** A two-second network drop to the model
  provider could fail the rounds running at that moment, trip the worker
  crash-loop breaker and drain the bot until an operator ran `drain off`. A
  breaker drain now lapses after 15 minutes; if workers fail again it drains
  again, each time twice as long, up to 4 hours. A PR's first network failure
  no longer counts toward it, and a breaker drain an older daemon left
  standing heals on upgrade. An operator's own drain is unchanged.
- **The round-stage supervisor kills fewer live rounds.** The optional lenses
  the daemon dispatches with a round now count toward its first fan-out, and
  a plan of more than 20 lenses gets one more minute per lens, up to 20, on
  its passes bound.
- **Reviewer memory no longer stalls on its own locks.** The OpenViking
  extension sends one turn sync at a time per session, in order, where a
  session could send overlapping appends of the same messages and hold the
  server's session locks for minutes.
- **Fewer false anomalies.** A follow-up round whose new lenses found nothing
  no longer raises a pass-plan mismatch for skipping its validator, a recheck
  that upheld the review no longer finds the ledger stale, and an ignored
  ledger nudge is raised once rather than at every check.

## 1.3.1

The first published release of the changes below: the 1.3.0 tag's release
run was cancelled before it published anything. The release workflow no
longer runs a paid end-to-end review behind an approval: a tag goes from the
two-arch build and its offline smoke to the ghcr images and the npm stage.

## 1.3.0

### The pi plugin's commands are renamed

The pi plugin (`@quickchatai/pi-quickreview`) shares pi's command namespace
with every other extension, so its commands now carry the `qcr-` prefix, and
each is also shipped as a skill of the same name
([ADR 0001](docs/adr/0001-plugin-and-app-nest.md)). The old names are gone,
with no alias:

| Removed        | Use instead                                                                       |
| -------------- | --------------------------------------------------------------------------------- |
| `/review`      | `/qcr-review`                                                                     |
| `/scan`        | `/qcr-scan`                                                                       |
| `/selfimprove` | `/selfimprove` in the app's own pi (`qcr pi`): it is no longer part of the plugin |

`/qcr-setup` keeps its name. It checks the pi version, the login, git and
the GitHub credential, and no longer offers to install the `qcr` app. It
offers instead to set up this repo's profile (`.qcr/`) with your agent, No
first, and `/qcr-setup profile` starts that straight away.

`/qcr-review` also changes how it runs:

- It reviews in the background. The command returns at once, the status line
  shows the progress, and the result arrives in the session as a message.
  `/qcr-review --stop` stops it, and so does ending the session.
- A bare `/qcr-review` reviews the current branch against its base together
  with its uncommitted changes, as one review. `/qcr-review NAME` reviews the
  branch `NAME`; a PR number or URL and `--uncommitted` work as before.
- A preset may come first: `quick`, `full` or `security`. `--full` is now the
  `full` preset, and `--branch` is the bare command; both are still accepted.
- Where the result goes is no longer asked. It is shown in the session and
  kept as markdown and JSON. `--to` is still accepted, and of its
  destinations only `json` still changes anything. After a PR review, the
  posting rule in pi's settings decides: `"quickreview": { "posting": "ask" }`
  (the default) asks, with "No, keep it here" first; `"never"` and `"always"`
  skip the question. A post is one comment-only review through the gate,
  recorded and not sent while the install keeps `dry_run` on.
