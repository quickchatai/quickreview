# Release notes

## 1.3.2

The pi plugin reviews again in a plain pi. Installed with `pi install
npm:@quickchatai/pi-quickreview`, `/qcr-review` failed with
`ERR_MODULE_NOT_FOUND` for `@earendil-works/pi-coding-agent`: pi installs a
package without its peers, and the review's engine, loaded on first use,
looked for pi beside the plugin. The plugin now resolves pi's own packages
from the running pi. The `qcr` app was not affected.

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
