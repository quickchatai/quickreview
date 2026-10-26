# QuickReview for pi

The QuickReview code reviewer as a pi package: the same review core the
QuickReview bot runs, in your own pi session.

```sh
pi install npm:@quickchatai/pi-quickreview
```

## Commands

Each command is also a skill of the same name, so the model in your session
knows the command and can tell you the line to type.

- `/qcr-review [preset] [target]` reviews in the background: the command
  returns at once, you keep chatting, the status line shows the review's
  progress, and the result arrives in the session as a message (and is kept
  as markdown and JSON under the qcr state home).
  - The target: nothing reviews the current branch against its base together
    with its uncommitted changes, as one review; `123`, `#123` or a pull
    request URL reviews a PR; a branch name reviews that branch;
    `--uncommitted` reviews the uncommitted changes alone.
  - The preset, first when given: `quick` (lower reasoning, about half the
    cost), `full` (the whole target again at the highest reasoning) or
    `security` (only the security and data-safety lenses the change
    triggers).
  - `--preview` shows the plan and the price without running anything;
    `--stop` stops the review that is running. One review runs per session
    at a time, and ending the session stops it.
  - After a PR review, your posting rule decides whether it goes to the PR
    as a comment-only review (see Settings).
- `/qcr-scan` scans the whole repo for defects, priced first and started
  only on your yes. It runs the `qcr` CLI on your machine; `--sandbox docker`
  runs it in the scan sandbox instead.
- `/qcr-setup` checks the pi version, the login, git, GitHub access for PR
  targets and the `qcr` CLI, and offers to install `qcr`
  (`npm i -g @quickchatai/quickreview`).

`/review`, `/scan` and `/selfimprove` are gone: pi's command namespace is
shared with every other extension, so the commands carry the `qcr-` prefix.
`/review` is `/qcr-review`, `/scan` is `/qcr-scan`, and `/selfimprove` is a
command of the `qcr` app's own pi (`qcr pi`).

## Settings

Your own defaults live in pi's settings (`~/.pi/agent/settings.json`, or the
project's `.pi/settings.json`), under `quickreview`:

```json
{
  "quickreview": {
    "posting": "ask",
    "preset": "quick"
  }
}
```

- `posting` decides what happens after a PR review: `ask` (the default)
  asks, with "No, keep it here" offered first; `never` keeps every review in
  the session; `always` posts without asking.
- `preset` is the preset a `/qcr-review` without one runs under.

Rules for one repository live in its profile, not here.

## Which pi

The package declares `^1.4.0` for pi (`peerDependencies`): pi 1.4.0 and any
later 1.x. At load the plugin reads the running pi's version, and outside
that range it registers no command at all and says why, once. A review
engine written against one pi's SDK never half-runs on another. Only pi
versions the plugin's offline canaries ran on belong in the range.

The `qcr` CLI (`@quickchatai/quickreview`) and the QuickReview image pin pi
exactly instead; `qcr pi` starts that pinned pi with this plugin preloaded.

## What it needs

- pi in the range above.
- A pi login for the review's models (`/login` in pi). The review borrows
  it: pi refreshes it when needed, and the review only ever reads a copy.
  An API key for another provider is not used in its place: with no login
  for the review's provider, `/qcr-review` stops and names `/login`.
- For a PR: the App when a qcr install configures one, else `GITHUB_TOKEN`,
  `GH_TOKEN` or `gh auth login`, in that order.
- For posting: a qcr config with `dry_run = false`. The shipped defaults keep
  `dry_run` on, and then a post is recorded under the qcr state home
  (`review/dryrun/`) and nothing is sent; the post question says so.

## What it never does

- The review never writes to your checkout: it reads the tree as it is.
- The review never runs your code, tests or app: it reads code and CI.
- It never posts unless you say yes to the post question (or your posting
  rule is `always`), and then it posts one comment-only review through the
  same mutation gate the bot uses. It never approves, requests changes or
  dismisses a review.
- It never refreshes your login itself, and never hands a token to the
  model's tools.
- It never gives your session a tool. The review's lens passes run in their
  own sessions, with none of your pi extensions, skills or settings, and
  your session only sees the result. The skills it ships are instructions
  for your session's model, naming the commands.
- It never sets or flips `dry_run`.
- It never starts `claude`.

## What ships in the package

The compiled review core and the plugin (`dist/`), one skill per command
(`skills/`), and under `assets/` the
data the core reads: the agents, prompts and seeds, the schemas, the
profiles and the shipped config defaults. `assets/` is copied from the
repository at pack time and checked file by file against its source, so the
prompts in the package are byte-identical to the ones the bot runs. They sit
under `assets/`, not at the package root, so pi never offers them as your
slash commands.
