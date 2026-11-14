# QuickReview for pi

QuickReview is an open-source AI code reviewer. This package runs it inside
your own [pi](https://github.com/earendil-works/pi) session.

```sh
pi install npm:@quickchatai/pi-quickreview
```

That adds three commands:

| Command       | What it does                                                                   |
| ------------- | ------------------------------------------------------------------------------ |
| `/qcr-review` | reviews this branch with your uncommitted changes, a pull request, or a branch |
| `/qcr-scan`   | scans the whole repository, or one folder of it, for defects                   |
| `/qcr-setup`  | checks what a review needs, and sets up the model and this repo's profile      |

Each command is also a skill of the same name, so the model in your session
knows the command and can tell you the line to type.

It is the same review core the QuickReview bot runs. What a review looks like,
how it works and how it was measured are in
[the project's README](https://github.com/quickchatai/quickreview#readme).

## Your first review

Type `/qcr-review` inside a git repository. It reviews the current branch
against its base, together with your uncommitted changes, as one review.

- **What you need.** pi 1.4.0 or a later 1.x, and a model credential in pi: a
  login made with `/login`, or a provider key in the environment. Any provider
  pi supports works. With no credential, `/qcr-review` stops and names
  `/login`.
- **Look before you spend.** `/qcr-review --preview` shows the plan and the
  price, and runs nothing.
- **It runs in the background.** The command returns at once and you keep
  chatting. The status line shows the review's progress, and the result
  arrives in the session as a message.
- **It is slow and it costs money.** A review reads the change through many
  *lenses*, each a narrow reviewer that looks for one kind of problem, and a
  *validator* then re-checks every finding against the code. On the one model
  with a measured price, that took about two dollars and more than fifteen
  minutes per pull request
  ([Benchmarks](https://github.com/quickchatai/quickreview#benchmarks)).
  `/qcr-review quick` runs at lower reasoning for about half the cost.
- **It reads your code and runs none of it.** It never writes to your
  checkout either.
- **It posts nothing unless you say yes.** After a pull request review it
  asks, with "No, keep it here" offered first. On the shipped defaults a yes
  is recorded and nothing is sent, because `dry_run` is on until you turn it
  off in a qcr config.

`/qcr-setup` checks what a review needs here and lists what is missing.

## Commands

### `/qcr-review [preset] [target]`

The review runs in the background: the command returns at once, you keep
chatting, the status line shows the review's progress, and the result arrives
in the session as a message. It is also kept as markdown and JSON under the
qcr state home. One review runs per session at a time, and ending the session
stops it.

The target:

| You type                            | It reviews                                                                                |
| ----------------------------------- | ----------------------------------------------------------------------------------------- |
| nothing                             | the current branch against its base, together with its uncommitted changes, as one review |
| `123`, `#123` or a pull request URL | that pull request                                                                         |
| a branch name                       | that branch                                                                               |
| `--uncommitted`                     | the uncommitted changes alone                                                             |

The preset goes first when you give one:

- `quick`: lower reasoning, about half the cost.
- `full`: the whole target again, at the highest reasoning.
- `security`: the whole `pass-sec-*` security family, planned as a request
  whatever the change's signals say, and the validator. Every other lens is
  skipped.
- `state-machines`: the whole `pass-sm-*` state-machine family, planned as a
  request whatever the change's signals say, and the validator. Every other
  lens is skipped.

The flags:

- `--preview` shows the plan and the price without running anything.
- `--stop` stops the review that is running.
- `--security` asks for a security review on top of the plan: all fourteen
  `pass-sec-*` lenses are planned, at the risk tier, except any your profile
  switched off. The `security` preset already asks for it. The profile that
  reviews only security on every review is `security` (`--profile security`).
- `--state-machines` asks for a state-machine review on top of the plan: the
  eight `pass-sm-*` lenses (implicit state machines gone wrong: flags that
  can disagree, a status written with no check of the old one, a state a
  dispatch does not handle, a transient state an error leaves set, an event
  delivered twice or out of order). The profile that reviews only state
  machines is `state-machines` (`--profile state-machines`).
- `--model MODEL` names the model the whole review runs on, for this run:
  `provider/id`, an id pi knows, or either with a `:level`, read the way pi's
  own `--model` reads it. It replaces every tier and lens model your config
  pins. `/qcr-setup model` keeps a choice instead.
- `--base REF` names the base a branch is reviewed against.
- `--repo OWNER/NAME` names the pull request's repository when it is not the
  one you are in.
- `--profile NAME` reviews under that profile.
- `--limit USD` sets this run's limit (see [Which model](#which-model)).
- `--json` gives the result as JSON, for pi's print mode.

After a pull request review, your posting rule decides whether it goes to the
pull request as a comment-only review (see [Settings](#settings)).

### `/qcr-scan [--delta] [--sha REF] [--path DIR] [--model M] [--preview]`

The scan reads the whole repo for defects, or with `--path` one folder of it.
It is priced first and starts only on your yes. `--preview` shows the price
and starts nothing.

- `--delta` scans only the files that changed since the last scan, and
  `--sha REF` scans the tree at `REF`.
- It runs on one model, picked the same way a review picks its own. `--model`
  names it for one run.
- It runs in the background in this pi, like a review: a status line while it
  runs, the new findings as a message when it ends, and `/qcr-scan stop` to
  stop it.
- Its cases are SDK sessions of this pi, behind the same read-only bash guard
  as the review's lenses.
- `/qcr-scan findings`, `status`, `units` and the other scan subcommands pass
  through as typed.
- The scan sandbox (a container) and dismissing a finding belong to the `qcr`
  app (`qcr scan`).

### `/qcr-setup`

`/qcr-setup` checks the pi version, the model credential, git, and GitHub
access for pull request targets. It also shows the model reviews run on and
why.

It then offers to set up this repo's profile (`.qcr/`), with No offered
first. On your yes, your agent in the session surveys the repo, reads its
review history, interviews you and writes the profile for you to commit.

- `/qcr-setup profile` starts the profile setup straight away.
- `/qcr-setup model` picks the provider reviews run on (see
  [Which model](#which-model)).

Its checks are steps on a setup checklist (`src/setupchecklist.ts`) that the
`qcr` app extends with its own steps.

### Commands that are gone

`/review`, `/scan` and `/selfimprove` are gone. pi's command namespace is
shared with every other extension, so the commands carry the `qcr-` prefix:
`/review` is `/qcr-review` and `/scan` is `/qcr-scan`. `/selfimprove` is a
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

- `posting` decides what happens after a pull request review: `ask` (the
  default) asks, with "No, keep it here" offered first; `never` keeps every
  review in the session; `always` posts without asking.
- `preset` is the preset a `/qcr-review` without one runs under.

Rules for one repository live in its profile, not here.

## Which model

A review runs on a model this pi has a credential for, on any provider pi
supports: a login made with `/login`, a stored API key, or a provider key in
the environment. Nothing names a provider for you.

- With one usable provider, the review runs on it. Its model is the newest
  version pi's catalog lists for that provider, or pi's own default there
  when the newest is priced far below it.
- With several, the provider this pi session is on goes first, then a stored
  login before an environment key. When two tie, `/qcr-review` asks once which
  one to use and remembers the answer. With nobody to ask it takes the first
  and says which model runs and how to change it.
- `/qcr-setup model` shows the usable providers and picks one, or hands the
  pick back to QuickReview. The choice is kept in `qcr-model.json` beside
  pi's logins, the one file the plugin writes there, so the `qcr` CLI on the
  same pi home runs on the same model.
- `--model` on `/qcr-review` or `/qcr-scan` names the model for one run, and
  `[models] model` in a qcr config pins it for every run. `--model` is the
  whole run's model: it replaces every tier and lens a config pinned.
- The dollar estimate was measured on one model. There, a review whose
  estimate is within your limit ($2 by default, or `--limit`) starts without
  asking, a dearer one asks first, and the review stops at twice its
  estimate. On any other model, the preview shows no estimate and the review
  stops at a spend limit ($15, or `--limit`); the first review on such a
  model asks once. A model pi has no price for has no dollar stop, and its
  spend shows as unknown.
- A login whose tokens are shorter than a review runs here, because this pi
  renews it while the review goes.

The whole rule, the refusals and the price are in
[docs/llm-setup.md](https://github.com/quickchatai/quickreview/blob/main/docs/llm-setup.md).

A provider that another pi extension registered, or one keyed with
`pi --api-key`, cannot be borrowed: the review's sessions run in a host of
their own, which loads no extension and holds no key of your session.

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
- A model credential in pi, for any provider (`/login` in pi, or a provider
  key in the environment). The review borrows the login of the provider it
  runs on and no other: pi renews it when needed, and the review only ever
  holds a copy that cannot refresh. With no credential at all, `/qcr-review`
  stops and names `/login`. The scan borrows it the same way.
- For a pull request: the App when a qcr install configures one, else
  `GITHUB_TOKEN`, `GH_TOKEN` or `gh auth login`, in that order.
- For posting: a qcr config with `dry_run = false`. The shipped defaults keep
  `dry_run` on, and then a post is recorded under the qcr state home
  (`review/dryrun/`) and nothing is sent; the post question says so.

## What it never does

- The review and the scan never write to your checkout: they read the tree
  as it is.
- The review and the scan never run your code, tests or app: they read code
  (and the review, CI).
- It never runs the `qcr` CLI.
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

- `dist/`: the compiled review core and the plugin.
- `skills/`: one skill per command, rendered at pack time from the same skill
  source as QuickReview's plugins for other coding-agent CLIs, and checked
  against it.
- `assets/`: the data the core reads, which is the agents, prompts and seeds,
  the schemas, the profiles and the shipped config defaults.

`assets/` is copied from the repository at pack time and checked file by file
against its source, so the prompts in the package are byte-identical to the
ones the bot runs. They sit under `assets/`, not at the package root, so pi
never offers them as your slash commands.
