# Release notes

## Unreleased

### The board export, for a host that runs the reviewer

A host that runs QuickReview for its operator (a page that lists the pull
requests being reviewed, reviewed and still open) can now read the
reviewer's board as one JSON object, without a terminal and without opening
the state database.

- **`qcr --schema 3 board`** prints it: who posts and on which repository,
  whether the reviewer runs (`off`, `starting`, `on`, `paused_login`,
  `broken`), whether it posts or records (`posting`, and `posting_pending`
  when the config already says live and the daemon has not restarted), the
  host's model login, the trigger label, the last poll, today's and the
  month's spend, how many pull requests were reviewed today
  (`reviewed_today`: each pull request with a review round finished since
  midnight in the install's `[ops] timezone`, open or closed, posted or
  practice; absent, never zero, when the daemon could not count), and three
  lists of at most 50 pull requests each, newest
  first: `reviewing` (queued, running, posting, failed with a closed
  `problem`, paused), `reviewed` (the verdict, and separately what GitHub
  holds: `posted_event`, absent for a round that posted nothing) and `open`.
  The shape is `schemas/board.v1.json`.
- **Absent means unknown.** A field the verb cannot read is left out, never
  printed as a zero, an empty list or a default: with the daemon off the
  lists are absent, and before setup the repository and identity are. The
  export carries no URL. The verb starts nothing and writes nothing, and
  when it cannot build the object it prints nothing on stdout and exits
  non-zero.
- **The daemon writes `state/board.json`** beside `status.json`, atomically,
  on every status write and whenever a round moved, and the verb reads that
  one file. Nothing to do on an existing install: the file appears with the
  first status write after an update.
- **Host contract 3.** `--schema` takes a third contract: contract 2's
  review, scan and version families, plus the host families, of which
  `board` is the first. The contracts a release supports are recorded in its
  `package.json` (`qcrContracts`: the contract numbers, and the host
  families with their versions) and printed by `qcr --schema 3 version`
  (`contracts`, `host_families`). Contracts 1 and 2 are unchanged;
  `--schema 1 board` and `--schema 2 board` are refused with exit 3, as a
  contract with no board.

### A host-managed GitHub credential

A host that runs the reviewer for a person can now keep the GitHub credential
itself, so nothing on the machine signs in to GitHub.

- **`[github] token_source = "host"`**, beside `auth = "user"` (or
  `auth = "installation"`, below), is the marker. The host writes `<secrets>/github_token` (atomically, `0600`, the
  token alone) and keeps a token with at least 15 minutes of life in it at
  all times. The daemon reads the file exactly as before: on first use, every
  five minutes, and after a 401. The default, `"self"`, is every install's
  behaviour until now, and a config without the key is unchanged.
- **An optional expiry note** beside the token,
  `<secrets>/github_token.expires_at` (one ISO 8601 instant with its zone),
  feeds the board export's `github` field: `ok`, `expired` or `missing`, and
  absent when the file or the note cannot be read. GitHub is not asked.
- **Nothing on such an install obtains or refreshes a GitHub credential.**
  The onboarding account step proves the file's token and neither runs `gh`
  nor installs the refresh crontab entry, and creates no label;
  `qcr github-token sync` refuses, in words; `scripts/mint-token.sh` prints
  the file's token; the local `qcr review` route reads that file and no other
  source.
- **The home shows the identity and the repository as "managed by your
  host"**, reads pull requests with the same token, and offers no GitHub
  sign-in, no repository pick, no switch-on and no go-live of its own. It
  never prints `gh auth login` there. Reviewing a pull request on demand
  stays, and so does switching auto-review off.

### A host-supplied installation token: a bot identity with no key on the machine

A third credential mode, for a host that holds a GitHub App's private key
and runs the reviewer for a person: the reviewer posts as the App's bot, and
the key never leaves the host.

- **`[github] auth = "installation"`**, always with `token_source = "host"`
  (config load refuses it without the marker). The host mints an
  installation token for the one repository and writes it to
  `<secrets>/github_token`, under the host-managed contract above. The
  daemon reads the file exactly as before.
- **`app_slug` is required, and `bot_login` is derived** from it as
  `<slug>[bot]`; a stated `bot_login` that says anything else is refused.
  The route is polling-only: any `[ingress] shape` but `"polling"` is
  refused, as under `auth = "user"`.
- **Reviews post as APPROVE / REQUEST_CHANGES / COMMENT**, as under
  `auth = "app"`. The COMMENT-only rule stays bound to the person identity
  (`auth = "user"`), not to "the token came from a file". The label search
  and own-thread matching work from `app_slug`, as in App mode.
- **No `app.pem`, `app_id` or webhook secret is read**, no App JWT is signed,
  and every route that needs one is refused. `scripts/mint-token.sh` prints
  the file's token. The companion gets no GitHub token in this mode.
- **The token is proved with a read of the configured repository**, never
  GitHub's user endpoint, and the reviewer checks that the token's own login
  (GraphQL's `viewer`) is the configured `bot_login`. A slug that names
  another App than the token's is said plainly, by the account step and by
  `host setup`, instead of leaving a reviewer that cannot recognise its own
  reviews.
- **Onboarding has a third route.** The account step takes the mode from the
  config its host wrote; the App-creation and slug-reconcile steps are off on
  it, and the proof and verify steps read the token file.
- **Token length is not assumed.** A token of any length GitHub issues is
  read, written and masked whole: the sync verb's token shape no longer caps
  it at 255 characters or excludes `.` and `-`, and the mask on GitHub's
  error text now covers a token's whole word.
- `SECURITY.md` and `docs/architecture/boundaries.md` state the amended rule:
  three credential modes over two implementations.

### Host verbs: a host starts the reviewer, shows a practice review and takes it live

The second family of host contract 3, `host: 1`. A host that has
authenticated its own operator can now do from its own process what a person
does in the terminal home, without a prompt: `qcr --schema 3 host <verb>`.
Each verb answers within seconds with one JSON object (`schema_version`,
`verb`, then `state`, one of that verb's closed set; a refusal or failure
carries a closed `reason` and a `message` in words). The shape is
`schemas/host.v1.json`.

- **`host setup --repo owner/name --auth user`** writes the config (the
  shipped template with the repository and its default branch, read from
  GitHub with the token file; no `gh` is run) and starts switch-on's steps as
  a detached process, with the silent defaults: this machine, polling,
  escalation off, local embeddings, the login of the pi on this machine. It
  answers `started`; a second call while the first runs answers `running`.
  The reviewer comes up in dry-run. It refuses, in words, a missing model
  login, a token file it cannot use, and a repository or auth mode other than
  the one already on record. It states the auth mode beside the marker and
  sets the improvement-PR and bot-filed-issue caps to zero, so the host's
  token never needs to write contents or issues.
- **`host setup --repo owner/name --auth installation --app-slug <slug>`**
  sets the reviewer up on a host-supplied installation token (below). The
  slug is required. Before anything is written the verb asks GitHub who the
  token is and refuses, as `identity_mismatch`, a token that is not
  `<slug>[bot]`. It then states `auth = "installation"`, `app_slug` and
  `bot_login` beside the marker.
- **Host-managed installs only.** The verbs act for a host's attested
  operator, who exists only where the install's config carries
  `[github] token_source = "host"`. On a machine with no config, `host setup`
  writes that marker and the auth mode itself. On a config that is already
  there without it, `host setup` and `host go-live` refuse
  (`not_host_managed`) before anything is written: a host verb never turns an
  install that keeps its own credential into a host-managed one.
- **`host review-now <pr>`** asks the daemon to review one pull request now,
  as `qcr review-now` does.
- **`host proof-start <pr>` and `host proof-result <pr>`** are the practice
  review. The first asks for the round and returns; it refuses when the
  config says the reviewer already posts. The second never waits: it answers
  `running` until the round has finished, then prints the review as it would
  have been posted (the body, and at most 50 inline comments, each
  length-capped) and records it as the proof. Only `proof-result` writes that
  record, and returning it is what marks the practice review as shown.
- **`host go-live`** takes an attestation as JSON on standard input, never on
  the command line: `{operator: {host, id}, confirmed_at, proof: {pr,
  round_no}}`. It refuses unless the proof is the recorded one, was returned
  by `proof-result`, the confirm is under ten minutes old, and the process
  was not started from an agent session. Then it runs the existing go-live
  step, detached, and records the attestation. `dry_run` still moves only
  through that one step ([docs/ownership.md](docs/ownership.md) names "a
  host's attested operator"). The go-live is `done` once that step has
  succeeded. The trigger label is made sure of after it and reported beside
  it (`label`: `ok` or `failed`), and never fails a go-live: a host whose
  token has only just been allowed to write commonly reads `failed` first.
  Called again on an install that is already live, the verb answers `done`
  with `label`, having tried the label again and nothing else: the go-live
  step is not re-run and the daemon is not restarted.
- **Progress is in the board export.** `qcr --schema 3 board` now fills
  `setup` (`running` with the step, `done`, or `failed` with the step and a
  closed `problem`), `go_live` (the same, without a step) and `proof` (the
  practice round, once `proof-result` has returned it). A go-live that is
  `done` carries `label` beside it. A walk whose process is gone reads as
  `failed`, `interrupted`. Both fields' words are closed sets in
  `schemas/board.v1.json`.
- **One writer of the setup checklist at a time.** The host verbs and the
  terminal home's switches take the same lock around their steps
  (`state/onboarding/checklist.lock`). Whichever finds it taken says by what
  and runs nothing: a verb answers `busy` with the holder, and the home says
  that its host is working and to try again. The lock's record carries the
  machine's boot id and its holder's start time, so a lock left behind by a
  machine that was stopped or restarted mid-walk is stale and is taken over
  instead of answering `running` for ever.
- **No agent session this system starts can run them.** Every host verb
  refuses when it was started from a review session, the companion, the
  home's own pi or `qcr pi`, and inside the daemon's container.
- `package.json` records `host` under `qcrContracts.host_families`, and
  `qcr --schema 3 version` prints it under `host_families`.
- **The practice review's `event` is the record's own.** `host proof-result`
  leaves `event` out when the dry-run record names none, and a failure's
  `message` is capped at 600 characters as a refusal's is.

### Review every pull request: `[github] trigger`

Until now the reviewer picked up a pull request only when somebody asked: the
trigger label, or a review request to the review team. That stays the
default. A second choice reviews every pull request.

- **`[github] trigger = "label" | "all"`**, default `"label"`. A config
  without the key behaves exactly as before.
- **`"all"` spends model usage on every pull request.** Under it every open
  pull request that is not a draft and was not opened by the reviewer itself
  or by another bot is picked up as if it carried the trigger label, once. A
  draft is picked up when it is marked ready; a closed pull request never is.
  Switching to `"all"` queues every open pull request that has no review yet,
  so set it knowing how many your repository has open.
- **A push still queues nothing by itself**, under either value: a pull
  request that is already reviewed is not reviewed again because commits
  landed on it. Ask again with the label, a review request, or
  `qcr review-now <pr>`; those work under both values. A round that failed is
  not asked for again by the trigger either.
- **The running daemon follows the key without a restart.** It reads
  `[github] trigger` again at every poll, so a change takes effect at the next
  one and no round in flight is lost. It is the only key read that way. The
  pickup is the poll's: on a webhook install a new pull request is picked up
  at the next poll, not at the moment it is opened.
- **`host setup --trigger label|all`** records the choice in the config it
  writes; left out, the config's own stays (`label` on a new install).
  **`host set-trigger label|all`** changes it later: one edit of the config,
  under the setup lock (`busy` while a setup or a go-live runs), on
  host-managed installs only (`not_host_managed` anywhere else). It starts and
  restarts nothing, never touches `dry_run`, and answers `done` with
  `trigger`.
- **The board export carries `trigger`** (`label` or `all`), read off the
  config as written; absent when the config cannot be read or states neither.

## 1.6.0

Three changes: a review is quiet by default, the lenses of a round read
their shared context from the provider's cache again, and QuickReview runs
on pi 1.5.2 (both below).

A review is now quiet by default, wherever it runs: the bot on a pull
request, `qcr review` in a terminal and `/qcr-review` in pi. It raises and
posts (in a terminal or in pi: lists) what someone must act on, and nothing
below that.

- **No nits, nothing below P2.** The lenses no longer raise nits or `P3`
  findings (naming, style, structure, duplication, leftovers, doc wording,
  missing-test asks), unless one names a wrong behaviour someone can hit, which
  is then raised at its honest severity. The validator kills what it would have
  demoted to a nit, and the posting step withholds any that slip through.
  Blockers, `P2` questions (a likely defect in a rare state), `[check this]`
  items and security questions post as before, and the verdict still depends
  on blockers only. A wrong behaviour that the style lens, or a lens outside
  its own lane, used to report as a nit or a `P3` question is now raised at
  its honest severity, so it can be a blocker.
- The style lens reports only breaks of rules your repository enforces — a
  lint, format or type check its CI runs, or a written house rule whose break
  does something — as defects, never a cosmetic nit. The intent lens is not
  planned under quiet.
- **To get the previous review back**, set `quiet = false` under `[review]`
  in `config.toml`: nits, `P3` questions, the intent lens and the
  `[review] nits` policy return exactly as they were.
- A profile's own rules are quiet too. A house pack's rule that asks for a
  nit or a `P3` is outranked: the pack posts its blocker-class rules as
  before, and its nits only with `quiet = false`. Quiet is a `config.toml`
  key; a `profile.toml` cannot set it.
- Whole-repository scans are unchanged.
- The benchmark reviews with quiet off unless an arm sets
  `--config review.quiet=true`, so it reproduces the published numbers, which
  were all measured with the previous review.

### The lenses read their shared context from cache again

The lenses of a round share one context pack. It is sent once, in a warm-up
request, and every lens is meant to read it from the provider's prompt cache
on its first request. On the ChatGPT login (pi's `openai-codex-responses`
API) almost no lens did: the warm-up ran, and each lens then paid for the
whole pack again. In five whole reviews on builds of this fix 96 of 97 lenses read
it, and 86 to 88% of the lenses' input tokens came from cache in the four
where that was counted. What was wrong, what was measured and what stays the
provider's is in [docs/prompt-caching.md](docs/prompt-caching.md).

Nothing to do on an existing install. What behaves differently:

- **A round has one cache key for each model, tool list and thinking level.**
  `[engine] lens_cache_group` now defaults to 32, from 5: a smaller group
  only bought a warm-up for every group after the first. A config that sets
  the key keeps its value; remove a `lens_cache_group = 5` you copied from the
  old example to get the new default.
- **A warm-up is one request.** Its whole prompt is one closing message, and
  every lens request repeats that message after the pack, so a lens extends
  its warm-up word for word. A warm-up whose model answers with a tool call is
  ended at that answer; before, it ran to its time limit while its lenses
  waited 30 s. A warm-up that warmed nothing is started once more by the next
  lens that joins.
- **A planned lens is sent its task.** The lens wave puts the task file's
  text in the lens's prompt; a lens no longer spends two requests fetching it.
- **`lens-ledger.jsonl` says whether the cache hit.** Each line of a cache
  group carries `turn1` (what the first request paid for, read from cache and
  wrote) and `group`; a group that is sent the pack also carries `prefix`
  (hashes of the first request, never its text). A lens whose request does
  not extend its warm-up is named once per group in the run's log, with the
  part that differs.
- **No other provider gets the pack.** The pack stays on the one API it pays
  on. It was built and measured on the Messages API, where every lens read it
  and the review cost about twice as much, and taken out again. On the chat
  completions API of two open models it was costed from a real review's
  requests and would have saved nothing, so nothing is built there. The cache
  key, the task a planned lens is sent and the ledger's `turn1` and `group`
  are the same on every provider; the warm-up and `prefix` come with the
  pack.
- The benchmark's lenses are now sent the case's pack as `qcr review`'s are.
  Before, they read the pack file through a tool, which a review on the
  ChatGPT login does not.

### pi 1.5.2

`qcr` and the release image carry pi 1.5.2, from 1.4.0. The pi plugin still
runs on pi 1.4.0 and any later 1.x.

**One thing to do on an install that runs the image:** if your config.toml
sets `[pi] version`, change it to `"1.5.2"`, or delete the line to take the
shipped value. The container refuses to start when the config names another
pi than the image carries (`pi version mismatch ... refusing to start`), and
`scripts/deploy.sh` refuses to deploy over the same difference.

- **New models.** pi's catalogue adds `gpt-6.1-terra` on the ChatGPT login
  and on OpenAI, and `claude-fable-5-2` on Anthropic, among others. Name one
  with `--model` or under `[models]`.
- **pi's own default model moved** for several providers: Anthropic to
  `claude-opus-5-5`, OpenAI to `gpt-6.1-sol`. The ChatGPT login's default is
  unchanged. An install that pins no model on one of the others may start on
  a different model; `qcr model` shows which.
- pi 1.5 keeps a prompt cache warm for up to 30 minutes after a turn ends,
  on models with a cache lifetime. QuickReview's own sessions keep the
  earlier behaviour, warming only while a session streams: the refreshes are
  requests no round asked for, and a round's cost does not count them.
- Every other package is at its latest, which clears the open `minimatch`
  advisory.

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
