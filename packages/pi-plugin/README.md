# QuickReview for pi

The QuickReview code reviewer as a pi package: the same review core the
QuickReview bot runs, in your own pi session.

```sh
pi install npm:@quickchatai/pi-quickreview
```

## Commands

- `/review` reviews the current branch against its base. `/review 123` (or a
  pull request URL) reviews a PR, and `/review --uncommitted` the uncommitted
  tree. `--preview` shows the plan and the price without running anything.
  The result is shown in the session, saved as markdown and JSON, or posted
  to the PR as a comment-only review (`--to pr`); pi asks each time, unless
  you keep an answer as the repo's default.
- `/scan` scans the whole repo for defects, priced first and started only on
  your yes. It runs the `qcr` CLI on your machine; `--sandbox docker` runs it
  in the scan sandbox instead.
- `/selfimprove` scans the repo, then hands the findings to this session's
  agent with a fix loop: triage, fix with tests, review, and a re-scan of
  what changed.
- `/qcr-setup` checks the pi version, the login, git, GitHub access for PR
  targets and the `qcr` CLI, and offers to install `qcr`
  (`npm i -g @quickchatai/quickreview`).

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
  for the review's provider, `/review` stops and names `/login`.
- For a PR: the App when a qcr install configures one, else `GITHUB_TOKEN`,
  `GH_TOKEN` or `gh auth login`, in that order.
- For posting (`--to pr`): a qcr config with `dry_run = false`. The shipped
  defaults keep `dry_run` on, and then `/review` refuses to post and says so.

## What it never does

- The review never writes to your checkout: it reads the tree as it is.
  (`/selfimprove`'s fixes are made by your own session's agent, under your
  pi's own tools and permissions, not by the review.)
- The review never runs your code, tests or app: it reads code and CI.
- It never posts unless you choose `--to pr`, and then it posts one
  comment-only review through the same mutation gate the bot uses. It never
  approves, requests changes or dismisses a review.
- It never refreshes your login itself, and never hands a token to the
  model's tools.
- It never gives your session a tool. The review's lens passes run in their
  own sessions, with none of your pi extensions, skills or settings, and
  your session only sees the result.
- It never sets or flips `dry_run`.
- It never starts `claude`.

## What ships in the package

The compiled review core and the plugin (`dist/`), and under `assets/` the
data the core reads: the agents, prompts and seeds, the schemas, the
profiles and the shipped config defaults. `assets/` is copied from the
repository at pack time and checked file by file against its source, so the
prompts in the package are byte-identical to the ones the bot runs. They sit
under `assets/`, not at the package root, so pi never offers them as your
slash commands.
