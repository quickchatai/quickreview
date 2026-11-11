# Models and credentials

Every review is produced by **pi** sessions, and a review runs on any model
provider pi supports, on the credential you already have. The shipped config
names no model. Which provider and model a run uses is its **model route**: it
is resolved once per run, from pi's own view of the credentials, a pin, or a
remembered choice, and it is stated before anything is spent.

With one credential there is nothing to choose. With several, a terminal asks
once and remembers. `qcr model` shows the route, why, and what else is usable.

The decision and the options it rejected are recorded in
[ADR 0002](adr/0002-model-route.md).

## Which model a review runs on

The first of these that applies decides:

1. **`--model` on the run.** It is the whole review's model for that run.
2. **`[models] model`** in `config.toml`: the install's pin.
3. **A choice you stated**: `qcr model use <provider[/model]>`, or
   `/qcr-setup model` inside pi. It holds like a pin.
4. **Your answer to an earlier question**, while that provider still has a
   usable credential. When it has none, the run says so, goes on down this
   list, and neither asks again nor overwrites the answer.
5. **The only provider** pi has a usable credential for.
6. **Among several providers**, in this order: the provider pi itself is on
   (its saved default, or the running session's); a stored login before an
   environment key before an ambient cloud credential; the provider whose
   picked model is newer (version, then list price); the provider id.

Inside the provider, with no model named, the model is picked from pi's
catalog:

- **Candidates** are the provider's models that reason and have a context
  window of at least 128k tokens. A variant of another candidate at the same
  version (a speed tier, a sibling, a dated snapshot) is left out.
- **The newest version wins.** The version is read from the model id. Ties go
  to the higher list price, then the larger context window, then pi's own
  default for the provider.
- **The guard.** When the newest version's list price is under a quarter of
  the list price of pi's default model for the provider, pi's default runs
  instead: a small model with a high version number is not the flagship.

Version numbers are compared as plain numbers, across model families too, on
an aggregator and between providers. That is deterministic and arbitrary, and
a stated choice overrides it.

The review's three **tiers** are thinking levels on that model: `light` and
`standard` at `medium`, `deep` at `high`. pi lowers a level a model cannot
run.

### When it asks, and when it does not

An interactive surface asks when two or more providers tie in the best
credential class and nothing is pinned or chosen:

```
pi can run this review on more than one provider:
  1) <provider>/<model>    <name>, signed in with pi    measured estimate
  2) <provider>/<model>    <name>, signed in with pi    no estimate
Which one? [1]
```

The first row is the one the order would take. The answer is remembered as a
provider, never a model, so a newer model on that provider is picked up when
pi's catalog gains it. A stored login beside an environment key, or beside a
cloud profile that happens to be in the shell, is not a question: the login
runs and the others are listed as alternatives.

Where it asks: `qcr review` and `qcr scan` on a terminal, `/qcr-review` and
`/qcr-scan` through pi's own select, the home's optional "Review model" step,
and a host skill, which shows the choice and runs `qcr model use` with your
answer. `--preview` and `--json` never ask.

A run with nobody to ask (the bot, a pipe, CI) takes the order's answer and
says so in one line, for example:

```
model: <provider>/<model> (picked among 2 providers pi has credentials for: a stored login comes first). Change it: qcr model use <provider[/model]>, or --model for one run
```

The line also says when a pin was moved to another provider, when the pick is
not pi's own default (and how to take pi's), when the guard fired, when a
login was skipped, and when an ambient credential decided, so a shell's cloud
profile is named before anything is spent.

## `qcr model` and `/qcr-setup model`

```
qcr model [--json]                 which model reviews run on here, and why
qcr model use <provider[/model]>   run reviews on it from now on
qcr model reset                    make the choice automatic again
```

`qcr model` prints the route, why it was chosen, how the model was picked, the
credential, the tiers' levels, the price basis, the other usable providers,
and the logins that are not usable here with the reason. With no route it
prints `model: none` and the refusal, and exits 1. `--json` prints the same as
one object; the wizard, the scan sandbox and the smoke scripts read it.

`qcr model use <provider>` remembers a provider and lets the rule pick the
model. `qcr model use <provider>/<model>` names the model too, parsed the way
pi parses `--model`. It is the way to run a model the rule does not pick: an
older one, a provider's small model, or a model of a provider none of whose
models passes the candidate filter. When `[models] model` is set, the config
wins and the verb says so.

Inside pi, `/qcr-setup model` does the same two writes through pi's own
select, with a last row that makes the choice automatic again.

**Where it is remembered:** `qcr-model.json` in the pi agent dir, beside the
logins it chooses among (`$PI_CODING_AGENT_DIR`, else `~/.pi/agent`). One
answer therefore serves `qcr review`, `/qcr-review`, the home and, on a single
box, the bot. The file also holds the models you agreed to run with no
estimate. It is QuickReview's to write and never a review session's: it is
part of the policy surface in [docs/exec-boundary.md](exec-boundary.md). pi's
own default-model setting is never written.

## Pinning a model

A model spec is `provider/id` with an optional `:<thinking level>`, in pi's
own spelling. Every spec you write is a pin.

| Pin | Where | Covers |
|---|---|---|
| the whole review | `[models] model = "provider/id"` | the main session and every tier and lens that has no pin of its own |
| one tier | `[models.tiers] deep = "provider/id:high"` | that tier's lenses |
| one lens | `[models.pass_models] "pass-x" = "provider/id"` | every variant of that lens |
| one run | `--model <provider/id>` on `qcr review`, `qcr scan`, `/qcr-review`, `/qcr-scan`; the Action's `model` input | the whole run |

- **In the file** an explicit tier or lens entry wins for its tier or lens,
  and everything unpinned runs on `[models] model`.
- **`--model` replaces every pinned tier and lens model for that run**, and
  keeps each one's level. The preview says so when it changed anything.
  `--config models.model=<spec>` is a config edit for one run and behaves as
  the file does.
- **A remembered choice applies only when neither the flag nor the config
  pins.**
- **A tier or lens entry may name only a level** (`":low"`): it moves the
  level and leaves the tier or lens on the review's model.
- **A model pi's catalog does not list** on a provider pi knows (a
  deployment name, a model newer than the catalog) is sent as written, and
  the preview says so. A typo there fails on the first call as "the provider
  refused the model".
- **The home's chat and the companion** keep the model pi itself starts on;
  `[home] model` and `[companion] model` pin one. A session whose model has no
  credential is moved to the review's route.
- **A repo profile cannot name a model.** It is read from the reviewed repo
  and would steer whose credential and money a review spends.

**A pin whose provider has no credential** moves to another credentialed
provider that serves the same model id, as an exact string, when the choice is
unambiguous: a provider of the same family (the ids share the text before
their first `-`), then the provider of the remembered choice, then the only
candidate. The run says so once. Several unrelated candidates are a refusal
that names them: a pin states an intent, and among providers with other
billing and other terms the run does not guess.

**Older keys are read for good.** `[models] default` and `conversation` fold
into `model`, the tier names `terra-med`, `sol-med` and `sol-high` are read as
`light`, `standard` and `deep`, and `[models.pricing]` is read and ignored. A
config that names models keeps running on them with nothing to migrate.

## Credentials pi reads

There is one inventory, and it is pi's. All of these count:

- a **login** stored by pi's `/login` (a subscription, or a provider's OAuth);
- an **API key** stored by pi's `/login`;
- a **provider key in the environment**, under any name pi knows for the
  provider;
- a key in pi's `models.json`;
- an **ambient cloud credential** (a profile or a role the provider's own SDK
  finds).

Ways to sign in: `qcr login [provider]` (pi's own `/login`, every provider it
offers), `/login` inside pi, the home's first setup step, and for a container
the image's `login` mode (`<wrapper> login`).

pi's own order holds. A stored credential owns its provider: a stored login
that can last the run keeps its provider even when a key for the same provider
is in the environment, and the key is used when the login cannot last. A login
file that exists and cannot be read is a refusal, never an empty store.

### When no route resolves

A run refuses before anything is spent, with one of five reasons:

| Refusal | When | What to do |
|---|---|---|
| no credential | pi has no model credential | `qcr login` (in pi: `/login`), or set a provider's key in the environment |
| login too short | the login expires inside the review's budget and nothing here renews it | run the review inside pi (`/qcr-review`), or use another credential |
| no model | pi has a credential, and none of the provider's models reasons with a 128k window | name one: `qcr model use <provider>/<id>` |
| pin with no credential | the pinned provider has no credential and the pin cannot move | sign in to that provider, or drop the pin |
| unknown pin | pi knows no model by that text | `qcr model` lists what is usable |

### Logins that are shorter than a review

Some logins hand out tokens that live for minutes and are renewed as they go
(GitHub Copilot's, at the pinned pi). A review borrows a login and never
refreshes it, so such a login runs only where something else renews it during
the run:

- **inside pi** (`/qcr-review`, `/qcr-scan`): the running pi renews it;
- **on the bot**, while the daemon's login refresher is healthy
  (`[login_refresh] enabled`).

`qcr review` and `qcr scan` outside pi, the Action's `pi-auth`, the scan
sandbox, and the takeover and debug panes have nothing that renews a login.
There the login is left out before the route is chosen: an environment key for
the same provider takes over, another provider runs, or the run refuses and
names what works. A login with under five minutes left is renewed by opening
pi once.

### Subscription logins and plan limits

A subscription login is a login like any other: no provider is treated
specially. Two things follow from the plan rather than from QuickReview:

- **Prices are list prices.** On a subscription the preview adds that your
  plan is not billed per review. The dollar stop still holds, and it bounds
  plan usage in list-price dollars.
- **The plan's limits are the ceiling.** A review round fans out about ten
  read-only passes plus a validator over the whole diff, and an actively
  reviewed repository runs many such rounds a day. That is far beyond a
  casual-use allowance: expect to need a high plan tier, and expect the plan's
  rate and usage limits before any limit of the daemon's. When a provider
  answers that the account's usage limit is reached, the bot stops taking
  rounds and says so, because waiting minutes does not cure it.

## Price

The dollar estimate was fitted on recorded reviews of one model. A run has
one price basis, shown in the preview and as `price_basis` in `--json`:

| Basis | When | What you see, and what holds the run |
|---|---|---|
| `measured` | every model the run uses is the measured one, on the API family it was measured on | the estimate; the hard stop is twice the estimate |
| `repo` | the repo's `.git/qcr-review.json` sets its own rates | the estimate at those rates; the same hard stop |
| `unmeasured` | pi has a list price, and the estimate was not fitted on this model | no estimate; your word once per model; a spend limit |
| `unpriced` | pi has no list price for the model | no dollar stop; spend shows as unknown, never `$0.00`; the time and turn limits hold |
| `unknown` | no route resolves | no price; a start refuses |

- **The spend limit on an unmeasured model** is $15, set per repo by
  `unmeasured_limit_usd` in `.git/qcr-review.json`, or `--limit` on the run.
  It is counted from the cost pi reports for each call.
- **Your word, once.** The first review on an unmeasured model asks on a
  terminal, "Run on `<spec>` with no estimate? It stops at $15." A yes is
  remembered for that model. `--limit` on the run is the same word (you named
  the stop), and so is a start with the key of a preview a host skill showed
  you. With nobody to ask and none of these, the run refuses and says how to
  start it.
- **Why no scaled estimate.** The measured token mix depends on the
  prompt-cache pack, which applies to one API family
  ([docs/prompt-caching.md](prompt-caching.md)). Scaling by list-price ratios
  would be a guess shown as an estimate.
- **`--json`.** Review schema 2 (contract 2) carries `model`, `alternatives`,
  `tiers`, `price_basis` and a nullable `estimate_usd`. Contract 1 is
  unchanged on the measured model and refuses, with a message, where it
  cannot state a price.
- **The bot has no dollar stop on any model.** A round is held by its
  deadline and its turn budgets. `qcr status` names the model the bot runs
  on, and the daemon raises the `model_route_changed` alert when that changes
  ([docs/architecture/ops.md](architecture/ops.md)).
- **Spend that is not known** is shown as unknown: `qcr spend`, `qcr today`,
  the digest and the TUI print the known sum and the number of rounds whose
  cost is unknown, never a zero.

## The secrets dir's `model-env/`

An install whose model credential is a key keeps it in the secrets dir:

```
<secrets dir>/model-env/<ENV_NAME>     one file per environment variable
```

The file's name is the variable, its content the value, mode `0600`. Use the
name the provider documents: it carries any provider's key, and the further
variables a provider that needs several is configured with, with no table of
providers on our side.

- A name is capital letters, digits and `_`. Names that start with `GH_`,
  `GITHUB_`, `QCR_`, `PI_`, `OPENVIKING_` or `GIT_` are refused: they would
  configure this system or its tools, not a model provider.
- `deploy/collect-secrets.sh` asks which variable a key goes in and writes the
  file. A key pasted into an agent session would land in a transcript, so no
  step accepts one as an argument.
- The older single file, `<secrets dir>/openai_api_key`, is still read as
  `OPENAI_API_KEY`.
- **Where the values reach:** the process that asks pi for a credential (a
  bot worker, the preflight, `qcr model`), and nothing else. They are not
  exported to a shell, they are not in a session's environment, and the
  model's tools never see them ([docs/exec-boundary.md](exec-boundary.md)).

The host wrapper and the Action forward a provider's key from the environment
by name, never by value: [docs/host-wrapper.md](host-wrapper.md),
[docs/action.md](action.md).

## Where the logins live

A login lives in the pi home of the process that signed in.

- **A laptop or a single box:** your own pi home. Switching auto-review on
  shares that one login with the stack, and the daemon's refresher keeps it
  ([docs/onboarding.md](onboarding.md#one-login-per-box)).
- **A daemon container with a login of its own:** the `pihome` volume, which
  survives restarts and image updates. Sign in with the image's `login` mode.
- **The companion:** its own pi home volume. A scan in the Docker sandbox
  reads that login read-only.
- **A server:** its own login or key. A login is never copied to it.

If a login "disappears" after a rebuild, the pi home was not on a persistent
volume.

The wizard's model step (order 30) asks one thing, where the daemon runs:
does a route resolve? It runs `qcr model --json` there and is green on any
provider. It asks no route question, rewrites no config and writes no key
file. The daemon's preflight makes the same check at every boot.

## Provider notes

Short, and only what differs from "sign in and run".

- **A ChatGPT subscription.** pi's sign-in uses a device code where it cannot
  open a browser (a container, a machine over ssh). Device-code login must be
  switched on for the account first (ChatGPT → Settings → Security).
- **Amazon Bedrock.** The credential is ambient (a profile, a role), so the
  run's first line names it. The pick is made from pi's catalog, not from
  what your account may run: model access is granted per account and region,
  and pi's own default there uses a regional inference profile. When the
  first call is refused for the model, take pi's default:
  `qcr model use amazon-bedrock/<id>`, with the id `qcr model` prints as pi's
  own default. The region and the other AWS variables are yours to set; the
  host wrapper and the Action forward credential names only, so name the rest
  in `QCR_MODEL_ENV`.
- **Azure OpenAI.** The id pi sends is a deployment name unless you gave pi a
  map. Pin your deployment: `[models] model = "azure/<deployment>"` or
  `qcr model use azure/<deployment>`. It is sent as written.
- **Google Vertex.** A review host reads nothing under your home directory,
  so the default application credentials file is not seen there. Point
  `GOOGLE_APPLICATION_CREDENTIALS` at an absolute path.
- **One key that serves two providers.** Some keys are read by two providers
  of pi's (a global and a regional endpoint, a plan and its sibling). A
  terminal asks, and the rows say they share a key; with nobody to ask the
  run takes one by the order, and a key for the other endpoint then fails on
  the first call. `qcr model use <provider>` settles it.
- **A provider from pi's `models.json`.** A model declared there with pi's
  defaults does not reason and so passes no filter. Name it:
  `qcr model use <provider>/<id>`.

## Memory embeddings need nothing here

The memory engine (OpenViking) embeds every memory entry, and every search
query, to store and find it. **By default it does that locally**, with a
small English embedding model served on loopback inside the memory container
(`config.toml [openviking] embedding_provider = "local"`, the shipped value;
the model file is pinned in the image): no key, no account, and no memory text
ever leaves your machine. Nothing but the model call does. **No model
credential is ever read for embeddings**, whichever provider the review runs
on.

A hosted embedder is an explicit opt-in, not a fallback and not an upgrade the
wizard suggests: `embedding_provider = "openai"` (with the model and its
dimension, e.g. `text-embedding-3-small` / `1536`) sends every memory entry's
text to OpenAI, and reads **its own** credential file,
`<secrets dir>/openai_embeddings_api_key` (`deploy/collect-secrets.sh` has the
prompt; `embedding_key_file` names it). The onboarding wizard's embeddings
step (order 38) writes the opt-in for you and refuses to go green without that
file.

Changing the embedder changes the vector space, and an existing store is
migrated rather than abandoned: see
[docs/memory-embeddings.md](memory-embeddings.md).

## Quick reference

| I want to | Do this |
|---|---|
| see which model reviews run on | `qcr model` |
| run reviews on another provider from now on | `qcr model use <provider>` |
| run one review on another model | `qcr review --model <provider/id>` |
| pin the install | `[models] model = "provider/id"` in `config.toml` |
| go back to automatic | `qcr model reset`, and remove `model` from `[models]` |
| sign in | `qcr login`, or `/login` in pi |
| give a container a key | `<secrets dir>/model-env/<ENV_NAME>` |
| raise the stop on an unmeasured model | `--limit <usd>`, or `unmeasured_limit_usd` in `.git/qcr-review.json` |
| see what the bot runs on | `qcr status` |
