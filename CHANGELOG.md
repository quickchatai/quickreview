# Release notes

## Unreleased

The GitHub Action installs with one command and runs on whatever trigger you
choose ([docs/action.md](docs/action.md)).

- **`npx @quickchatai/quickreview action install`** sets the Action up on a
  repository. It asks when reviews should run, stores your model key as a
  repository secret with `gh secret set` (the value on stdin, never on the
  command line), creates the `qcr-review` label for the label trigger, and
  opens a pull request that adds `.github/workflows/quickreview.yml`. A
  secret of that name the repository or its organization already gives the
  workflow is kept. Each
  write is asked first. `--local` writes the file into your checkout instead,
  and `qcr action workflow` prints it. These writes go through your own `gh`,
  on your command, from a closed list of gh calls
  ([docs/adr/0003-setup-writes-through-gh.md](docs/adr/0003-setup-writes-through-gh.md)).
- **The Action takes any event.** Your workflow's `on:` and `if:` decide when
  it runs. It finds the pull request in the event, and an event that names
  none (a schedule, a manual run, `workflow_run`) needs the `pr` input. The
  docs give four recipes: a `/qcr` comment, a label, every push, a manual run.
- **It checks who asked before anything is spent.** A run started by someone
  without write access to the repository, or by a bot, is skipped unless the
  new `allowed-users` input names them. Before, the template trusted a
  comment's `author_association`, which does not prove write access. A comment
  on an issue, a closed or merged pull request, and a fork's pull request on
  an event that gets no secrets are skipped with the reason. A missing model
  key fails before the image is pulled.
- **A fork's pull request is reviewed when someone with write access asks**,
  with a `/qcr` comment or a manual run. Your model key is then in a container
  that reads the fork's text: [docs/action.md](docs/action.md#pull-requests-from-forks)
  says what keeps it from the model's tools and what does not, and advises a
  key with a spend limit at the provider.
- **Two more inputs.** `profile` runs a shipped profile (`security`,
  `state-machines`, …) instead of the standard review, and `post: "false"`
  reviews and posts nothing.
- **Outputs and a job summary.** `skipped`, `skip-reason`, `pr`, `review-url`,
  `verdict`, `findings`, `cost-usd` and `result` (the review's schema 2 JSON),
  and a summary with the verdict, the cost and a table of the findings.
- **No checkout step.** The review fetches the pull request itself and reads
  `.qcr/` from its base.
- **A review in flight is not lost to a request the gate will skip.** In the
  installed workflow, only a newer push to the pull request's own branch
  cancels a running review. A `/qcr` comment, a label or a manual run waits
  for it.
- **The workflow's job timeout is 90 minutes.** The template's 60 was shorter
  than a review's own limit plus the fetch and the post.
- **The Action is named QuickReview AI Code Review**, its Marketplace name.
  The floating `v1` tag the docs name is moved to each release once its image
  is on ghcr.

### Migration

A workflow made from the old template needs no change: the inputs it uses
keep their meaning, and the Action now also checks who started the run. If you
install the new workflow, delete the old `.github/workflows/qcr-review.yml`,
or each pull request is reviewed twice. The template no longer uses the
repository variable `QCR_REQUEST_ONLY` or the secret `QCR_PI_AUTH`: pick the
triggers you want instead, and give the model an API key.

## 1.5.1

Fixes from an end-to-end test of 1.5.0 on a fresh install: a partial
config.toml loads, a one-off profile review keeps its own checkpoint and
works from the terminal, and the terminal output loses two debug lines.

- **A config.toml needs only the keys you change.** Every table and key it
  leaves out takes the shipped value from `config.example.toml`, on every
  surface that reads it (`qcr review`, the pi plugin, the daemon,
  `qcr config check`): `[review] profile = "state-machines"` alone is a whole
  config, and an empty config.toml is no config.toml. Before, a partial file failed with
  `config.toml: missing key 'github'` and a stack trace. A key you set is
  checked as before, and a wrong value now refuses in one line naming the file
  and the key.
- **A config.toml that leaves out `[guards] no_checks_is_red` now withholds
  approval on a head with no checks**: it takes the shipped value, `true`. A
  repo with no CI at all sets `no_checks_is_red = false` to keep approving.
- An existing scan image (`qcr-scan`) now also carries `config.example.toml`;
  run `qcr scan rebuild` once before the next scan.
- A one-off `/qcr-review --profile NAME` review keeps its checkpoint apart
  from the normal review's: the next normal review covers the change since
  its own last review, not "nothing new", and the next review under that
  profile builds on the one-off's.
- An install whose configured `[review] profile` is named (a shipped profile
  or a house pack) reviews a target in full once if that target's review state
  was last saved before 1.5.0. Such a state does not record which profile
  saved it, and a one-off `--profile` run saved there too, so it is not taken
  as the configured profile's. An install with no profile set is unaffected.
- `qcr review --profile NAME` reviews under that profile for one run, as
  `/qcr-review --profile NAME` does, with its own checkpoint. `--preview`
  shows that profile's plan, and an unknown name is refused in one line that
  lists the shipped and local profiles.
- A terminal `qcr review` no longer prints two internal debug lines among its
  progress: a cache group's `[lens] pin-evidence cache-group-disposed …` and
  `[ledger-pin] debug: ignoring LEDGER PR #0 …`. Both now go to the run's log,
  `out/pi-stderr.log`; a warning a person should act on still reaches the
  terminal.

## 1.5.0

Two additions: QuickReview runs on any model provider pi supports, and a
state-machine review joins the security review (below).

QuickReview runs on any model provider pi supports, on the credential you
already have. The shipped config names no model. With one login or key a
review runs on it; with several, a terminal asks once and remembers.
`qcr model` (or `/qcr-setup model` in pi) shows which model runs and why, and
changes the choice. `--model` picks for one run and overrides every pinned
tier and lens for that run. The whole of it is in
[docs/llm-setup.md](docs/llm-setup.md).

### Migration: nothing to do

A config that names models keeps running on them: every spec you wrote is a
pin. A config pinned to a provider you have no login for runs on another
provider that serves the same model when there is exactly one, or one of the
same family, and says so. Before, this worked only between the two OpenAI
providers.

Three things behave differently on an existing install:

- **Tiers a config left out follow the config's own model.** A config that
  sets `[models] default` and `conversation` but not all three
  `[models.tiers]` used to get the missing tiers on
  `openai-codex/gpt-6.1-sol`. They now run on the config's own model.
- **`[models] default` names nothing of its own** when `conversation` or
  `model` is set. `default` and `conversation` are replaced by one optional
  `model`; both older keys are still read and fold into it.
- **A stored login keeps its provider.** A stored login that can last the run
  is used even when a key for the same provider is in the environment, which
  is pi's own order. The key is used when the login cannot last.

`[models.pricing]` is read and ignored: prices come from pi.

### The tiers are `light`, `standard` and `deep`

`terra-med`, `sol-med` and `sol-high` are read everywhere they were, for
good: config, profiles, levers, verdict files and stored rows. Output uses
the new names: agent names, the `lenses` of `--json`, the scan preview's
`tier`.

**Rolling back:** roll back only to a version that reads both spellings. An
older release refuses a tier it does not know, and reads a round that carries
a new name as a required pass that is missing.

### Price

- A model the estimate was not measured on shows no dollar estimate, asks
  once, and stops at $15 (`unmeasured_limit_usd` in `.git/qcr-review.json`)
  or at `--limit`.
- The estimate holds for the measured model through the API it was measured
  on (`openai-codex-responses`). The same model through another API (an API
  key, Azure, a gateway) is unmeasured, and a run names the models that have
  no estimate.
- A model pi has no price for has no dollar stop, and its spend shows as
  unknown, never `$0.00`. `qcr spend`, `qcr today`, the digest and the TUI
  print the known sum and the number of rounds whose cost is unknown.
- `--json`: review schema 2 (contract 2) adds `model`, `alternatives`,
  `tiers`, `price_basis` and a nullable `estimate_usd`. Contract 1 is
  unchanged on the measured model and refuses, with a message, where it
  cannot state the price. Installed host skills move to contract 2 with
  `qcr plugin update`.

### Credentials

- Sign-in surfaces name no provider: the home's first step is "Sign in to a
  model provider" and opens pi's own `/login`, `qcr login` takes any provider
  pi offers, and a provider key in the environment counts as signed in.
- A login whose tokens are shorter than a review (GitHub Copilot) runs inside
  pi (`/qcr-review`) and on the bot. `qcr review` outside pi says so and
  names what works.
- Secrets dir: `model-env/<ENV_NAME>` carries any provider's key, one file
  per environment variable. `openai_api_key` still works.
- The host wrapper and the Action forward any provider's key from the
  environment by name. The Action gains a `model` input.
- The setup wizard's model step checks one thing, that a model credential
  works where the daemon runs. It asks no route question and rewrites no
  config.

### The bot

- The bot reports the model it runs on (`qcr status`) and raises an alert,
  `model_route_changed`, when that changes: a lost login that turned a
  subscription into a metered key, a pin that moved to another provider, or a
  new credential that moved an unpinned bot.
- A bot round has no dollar stop on any model, as before: its deadline and
  turn budgets hold it.
- A provider that accepts the credential and refuses the model is no longer
  reported as an expired login.
- The prompt-cache pack applies to the API family it was built for, and a
  lens on any other API runs without the warm-up
  ([docs/prompt-caching.md](docs/prompt-caching.md)).

### State-machine review

Eight `pass-sm-*` lenses review implicit state machines: a status field, a
set of flags or a stored copy of other state that a change can leave in a
combination the code mishandles. They cover the states, transitions,
unhandled states, transient states left set, event order, stale copies,
lifecycle order and stored state. They share one contract
(`prompts/pass-sm-common.md`), run at the `deep` tier, and each holds
`state_explore`, a read-only tool over the PR's committed objects that lists
the lines where something may be missing and the writes, reads, exits and
siblings of a name. The validator
replays each finding's trace. Details: "State-machine review" in
[docs/profiles.md](docs/profiles.md).

- **The default review plans a state lens on its own** when a change shows a
  strong signal, such as a new member of an existing enumeration or a
  transient state entered in code that handles no failure
  (`[state_machines] triggers`, `strong` by default). A round that plans one
  costs more than before. `off` restores the old plan; `all` adds the weak
  signals.
- **Ask for one on a PR** with the `qcr:state-machines` label, an
  `@<bot> state-machines` comment from an owner, member or collaborator, or
  `qcr review-now <pr> --state-machines`.
- **Ask for one locally** with `qcr review --state-machines` or
  `/qcr-review --state-machines`: the usual plan plus the eight lenses. The
  `/qcr-review state-machines` preset runs them and the validator only.
- **A state-machine-only bot** is the `state-machines` profile
  (`[state_machines] only`): every other lens off, posting scoped to
  state-machine findings (`[posting] scope = "state"`), and an APPROVE means
  "no state-machine finding". `[security] only` and `[state_machines] only`
  together are refused at load.

### Fixes

- **A withheld approval no longer stays withheld at an unchanged head.** A
  cancelled CI run that a newer, successful run of the same workflow and
  event replaced no longer reads red, in the gate and in `pr-checks.sh`. A
  retry round that withholds the approval again keeps it owed, so green CI
  re-queues the PR. The board shows `APPROVE·withheld` when the code verdict
  was APPROVE and GitHub has only a COMMENT.

### Docs and benchmark data

- The README leads with the install command; the full benchmark results are
  in [BENCHMARKS.md](BENCHMARKS.md).
- The benchmark dataset has a DOI (10.57967/hf/11598) and downloads with no
  login. Its `state_machines/` folder holds the state-machine study, and
  `bench/aacr/recompute/state_machines.py` recomputes its numbers (tag
  `bench-data-v1.1`).

## 1.4.2

Fewer false pass-plan alerts. The check that holds a round's executed passes
against its plan raised a mismatch for two things the round instructions
allow: a pre-approval sweep that found nothing and so ran no validator, and
the exploit chain's `compose` step, which runs after the other passes only
when they turned up security leads. Both now conform; a validator skipped
over real candidates, an unplanned pass and a pass at the wrong tier still
raise the alert.

## 1.4.1

The bot no longer freezes on a diff. One pattern the security checks match
against a pull request's import lines could take exponential time on a long
dotted module name: a PR that removed two bracketed Python imports in a row
held the daemon's loop at full CPU, with no reconcile, no heartbeat and no
review, and a restart froze again on the same PR. That pattern, and two
others that read a PR's text in more than linear time (the ufw task key over
a line of carriage returns or line separators, and a SQL `UNIQUE KEY` over a
schema file), now read in linear time and match exactly what they matched
before.

## 1.4.0

QuickReview installs into seven coding-agent CLIs from npm and runs on Node
22.19 or newer. It gains a security review, and the bot rides out network
failures that used to need an operator.

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

### Security review

Fourteen `pass-sec-*` lenses review security: identity (authentication
coverage, privilege escalation, IAM, tokens), the classes (access,
injection, boundaries, secrets and data, supply chain, LLM, variants of a
known bug) and three deep ones (check-then-use races, infrastructure,
exploit chains). They share one contract, read a person-written threat
model (`.qcr/threat-model.md`, or the profile's) and the security facts
computed from the change, and are planned when the change carries a
security signal (`[security] triggers`).

- **Ask for one on a PR** with the `qcr:security` label or an
  `@<bot> security` comment from an owner, member or collaborator
  (`[security] label`, `command`).
- **Ask for one locally** with `qcr review --security` or
  `/qcr-review --security`: the usual plan plus the whole family. The
  `/qcr-review security` preset runs the family and the validator only.
- **A security-only bot** is the `security` profile (`[security] only`):
  every other lens off, only security findings post, and an APPROVE means
  "no security finding". `[posting] security_max` gives security findings
  their own budget and `[posting] scope = "security"` posts only them.
- **A security scan** keeps the kinds you name (`[scan] kinds`, e.g.
  `["security"]`) and runs the lenses you list (`[scan] lenses`). With
  `[scan] threat_model` set (the security profile sets `"auto"`) a scan
  drafts the threat model first, at its own price, into the state home and
  never the repository: `qcr scan threat-model propose|start`, or as the
  first step of `/qcr-scan` and of every host's scan skill.

### Runs on more machines

- **Node 22.19 or newer**, down from 26: both packages declare
  `engines.node ">=22.19"`, and CI tests on Node 22, 24 and 26.
- **better-sqlite3 is optional.** An install where the native driver cannot
  build still installs. `qcr` itself and `qcr review`, `scan`, `login`,
  `pi`, `version`, `update` and `plugin` run without it; a verb that needs
  the state store says so and how to fix it.

### For scripts and plugins

- `qcr --schema N review|scan|version …` asks for one host-plugin contract
  (contract 1: review v1, scan v1, version v1). It implies `--json`; a
  contract this qcr does not print exits 3 with nothing on stdout, and the
  version payload lists the `contracts` it accepts. The plugin's `qcr-json`
  wrapper is gone.
- `qcr scan preview|start --path DIR`, `qcr scan stage2 propose --path DIR`
  and `/qcr-scan --path DIR` scan one folder of the repo. The folder is part
  of the plan key, and the scan payload gains `path` (null for the whole
  repo), still scan v1.

### The bot rides out network failures

- **A transient GitHub read no longer drops a review.** Reads and GraphQL
  queries are tried up to three times (a `retry-after` of 20 s or less is
  honoured; mutations are never retried), and a check listing that moves
  while it is read is read again rather than returned partial. A transient
  read in the pre-check before an approval defers the post, where it used to
  withdraw it and leave the PR waiting for an operator. A 4xx rejection
  clears the post and hands the session GitHub's own message, and a thread
  reply carries a hidden marker so a retry never posts it twice.
- **A transient failure with nothing posted retries by itself.** A model
  provider outage, a dead worker, or a post whose retry window ran out with
  nothing on GitHub now waits and retries at any stage (15 minutes, doubling
  to 6 hours) instead of waiting for `u`. It stays visible on the board, in
  Slack and in `qcr status`, which prints one line per open incident with its
  next retry or "operator u required". Whatever may already be on GitHub
  still stays with the operator: for example a post that may have landed, a
  malformed verdict or a posted round with no verdict. Self-requeues wait 2
  then 8 minutes, a worker turn the provider ended is requeued after 2, 8
  and 30 minutes, and a failed conversation reply no longer holds the PR's
  next round.
- **Model provider blips are absorbed.** The bot's pi sessions retry the
  provider for about 13 minutes (10 attempts, from 5 s doubling to 2
  minutes); an operator's own `retry` in pi's `settings.json` still wins. A
  rate limit or overload no longer parks a PR on the worker breaker, and a
  spent usage window drains it rather than parking. Thread replies and PR
  conversation answers that hit a transient GitHub failure wait on a
  schedule of about 3 hours instead of spending one of their three strikes.
- **Nothing on the network hangs the daemon.** Every daemon `git fetch` and
  `git clone` has a timeout, and a failed clone leaves no half-written
  repository. A failing dispatch backs off per PR, from 30 s to 30 minutes
  (anomaly `dispatch_failing`), and so does a failing webhook delivery
  (`webhook_delivery_failing`). Webhooks that arrive during a breaker drain
  are kept and handled after it lifts; a deploy drain still drops them. Slack announcements no longer block the verdict and deadline paths,
  and an incident alert that never reached Slack is sent again. A
  base-advance recheck that failed to read is retried rather than lost.
- **A memory server that stops answering is restarted**, after 3 failed
  health probes over at least 90 s (`[openviking] liveness_failures`,
  `liveness_span_s`, `liveness_startup_grace_s`).
- **Escalation rules read unknown facts as unknown.** A transient failure
  reading a path, label or check list defers the evaluation for 5 minutes,
  where it used to read as empty and skip the rule; a read GitHub refuses
  outright counts as a known absence.
- **One review, not two, when CI was still running.** An approval the bot
  withheld for running CI, then gave once CI went green, now posts as one
  line pointing at the review above, not a second copy of the whole review.
- **The improvement channel's git runs no hooks** from the reviewed
  repository's clone: it carries the same git pins as every other git the
  daemon starts.

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
