# Release notes

## Unreleased

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

`/qcr-setup` keeps its name.

`/qcr-review` also changes how it runs:

- It reviews in the background. The command returns at once, the status line
  shows the progress, and the result arrives in the session as a message.
  `/qcr-review --stop` stops it, and so does ending the session.
- A bare `/qcr-review` reviews the current branch against its base together
  with its uncommitted changes, as one review. `/qcr-review NAME` reviews the
  branch `NAME`; a PR number or URL and `--uncommitted` work as before.
- A preset may come first: `quick`, `full` or `security`. `--full` is now the
  `full` preset, and `--branch` is gone (the bare command, or a branch name).
- Where the result goes is no longer asked. It is shown in the session and
  kept as markdown and JSON, and `--to` is gone. After a PR review, the
  posting rule in pi's settings decides: `"quickreview": { "posting": "ask" }`
  (the default) asks, with "No, keep it here" first; `"never"` and `"always"`
  skip the question. A post is one comment-only review through the gate,
  recorded and not sent while the install keeps `dry_run` on.
