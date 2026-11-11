---
status: accepted
built: yes — the shipped config names no model, the route is resolved from pi's inventory at every entry point, the pick rule, the credential filter, the remembered choice, the price bases and the tiers light, standard and deep are in the tree, and the fences under "Consequences" hold them. The record was written before the code
---

# The model route: a review runs on the credential the person has

A review runs on any model provider pi supports. Which provider and model a
run uses is its **model route**: it is resolved once per run, from pi's own
view of the credentials, a pin, or a remembered choice. The shipped config
names no model, and no provider or model name decides anything in the code. A
person with one login gets a review on it without choosing anything; a person
with several is asked once.

## The route

- **It is resolved where pi is.** The daemon builds agent files before any pi
  exists and imports no pi package, so it cannot name a model. The engine host
  (`PiHost`, `packages/pi-plugin/src/engine/pisdk.ts`, the core's only
  importer of pi's SDK) builds an inventory from pi's public model registry
  and hands it to one pure function, `resolveRoute`
  (`packages/pi-plugin/src/modelroute.ts`). Inside a running pi the plugin
  builds the same inventory from the session's registry and calls the same
  function. The daemon writes specs and agent files that may be unpinned, and
  the worker reports the model that ran.
- **An unpinned spec is an empty model.** A model spec is
  `[provider/id][:level]`. An empty model part means "the run's route": `""`,
  `":medium"`, `":high"`. Every reader keeps its string type. A built agent
  file for an unpinned tier has no `model:` line and a `thinking:` line.
- **A pin is carried once.** `[models] model` is the route's pin. A tier or a
  lens with no entry of its own runs on the route, so the pin reaches it
  without being copied into it. In the file an explicit tier or lens entry
  wins for that tier or lens. `--model` on one run is that run's pin and
  replaces every tier and lens pin for the run. A remembered choice applies
  only when neither the flag nor the config pins.
- **One catalog per pi home.** Every SDK host loads the catalog of the pi home
  it borrows from, pi's stored overlay included, without a network call. So
  `qcr review`, `qcr model` and `/qcr-review` name the same model on one
  machine.
- **A session pi's own CLI starts keeps the model pi started on.** The home,
  the companion, a takeover and a debug round pass `--model` only for a pin.
  The login-route extension moves such a session only when its model has no
  credential, by the same rule.

With nothing pinned, the order is:

1. A choice the person stated (`qcr model use`, `/qcr-setup model`). It holds
   like a pin.
2. The answer to an earlier question, while its provider still has a usable
   credential. When it has none the run says so, goes on down the order, and
   neither asks again nor overwrites the answer.
3. The only provider with a usable credential.
4. Among several: the provider pi itself is on (its saved default, or the
   running session's), then a stored login before an environment key before
   an ambient cloud credential, then the provider whose picked model is newer
   (version, then list price), then the provider id.

The function never asks. An interactive surface asks when two or more
providers tie in the best credential class, so a login beside an incidental
cloud profile in the shell is not a question. A run with nobody to ask takes
the order's answer and says, in one line, which model runs, why, and how to
change it. A run that cannot resolve a route refuses with one of five
reasons: no credential, a login too short for the run, no model that passes
the filter, a pin with no credential, a pin pi does not know.

## The pick inside a provider

A pure function over catalog metadata (`packages/pi-plugin/src/modelpick.ts`).

- **Candidates** are the provider's models that reason and have a context
  window of at least 128k tokens. A variant of another candidate at the same
  version (a speed tier, a sibling, a dated snapshot) is dropped: the base id
  stands for the family.
- **The newest version wins.** The version is parsed from the model id; dates,
  build numbers, size tokens and calendar versions are not versions. Ties go
  to the higher list price, then the larger context window, then pi's default
  for the provider, then the id.
- **The guard.** When the newest version's list price is under a quarter of
  the list price of pi's own default model for the provider, pi's default runs
  instead. A small model with a high version number is priced far below a
  flagship, and a pick that is the provider's flagship sits above that line.
- **pi's default is read through pi's root export.** `resolveCliModel`
  answers an unknown id with a clone of the provider's default model, which
  is enough to learn its id. When it cannot be read the version pick stands
  and the route says so.

## A pin whose provider has no credential

The spec moves to another credentialed provider that serves the same model
id, as an exact string, when the choice is unambiguous:

1. a candidate of the same provider family (the provider ids share the text
   before their first `-`);
2. the provider of the remembered choice, when it is a candidate;
3. the only candidate.

Several unrelated candidates are a refusal that names them: a pin states an
intent, and among providers with other billing and other terms the run does
not guess. A move is said once per run, and on the bot the worker reports it
and the daemon raises an anomaly when the route changes. One helper,
`moveToCredentialed`, decides this for every spec. A login that exists and is
too short is refused as such, never moved.

## Credentials are filtered before the route

There is one inventory, and it is pi's: a stored login, a stored key, a
runtime key, an environment key under any name pi knows, a `models.json` key
and an ambient cloud credential all count, because pi's registry counts them.

A stored login that cannot last the run on this surface is left out before
the route is chosen. It is then never picked, never offered in a question and
never remembered, and an environment key for the same provider takes over by
pi's own rule. A stored login that can last keeps its provider, which is pi's
order.

A surface where something renews the login while the run is going (a running
pi, or the daemon while its refresher is healthy) keeps a shorter login and
re-reads the owner's entry when pi asks for a fresh one. A borrower never
refreshes a login itself. An unreadable login store is a refusal, never an
empty store.

One exception is stated rather than hidden: `qcr review` outside pi has
nothing that renews a login, so a login whose tokens are shorter than a
review is skipped there, and the refusal names what works (`/qcr-review`
inside pi, or another credential).

## The remembered choice

One JSON file beside pi's logins, `<pi agent dir>/qcr-model.json`. It works
for the plugin alone, for `qcr`, and for the daemon on the same pi home;
`qcr model` and `/qcr-setup model` show and change it.

- **Two kinds.** The answer to a run's question is a preference: a provider,
  never a model. A choice the person stated holds like a pin and may name a
  model, which is how a zero-config install names one.
- **It also holds the person's word on price:** the models they agreed to run
  with no estimate.
- **It is ours to write, never a session's.** The file joins the write veto
  of the execution boundary.
- **A repo profile still cannot name a model.** It is read from the reviewed
  repo and would steer whose credential and money a review spends.

This amends [ADR 0001](0001-plugin-and-app-nest.md) on one point: the plugin
still reads no app config file, and it now owns one file of its own, beside
pi's logins.

## Price

The fitted estimate is data about one measurement: the model id, the API
family and the rate card it was measured on, kept in one file
(`packages/pi-plugin/src/measured.ts`, the one model id in product code). The
API family is the one the prompt-cache pack applies to, because the fit's
token mix depends on the pack. A run has one price basis:

| Basis        | When                                                       | What the person sees and what holds the run                                              |
| ------------ | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `measured`   | every model the run uses is the measured one               | the estimate; the hard stop is twice the estimate                                        |
| `repo`       | the repo's own review settings set the rates               | the estimate at those rates; the same hard stop                                          |
| `unmeasured` | pi has a list price, and the estimate was not fitted on it | no estimate; the person's word once per model; a spend limit (default $15, or `--limit`) |
| `unpriced`   | pi has no list price for the model                         | no dollar stop; spend is recorded as unknown, never `$0.00`; time and turn limits hold   |
| `unknown`    | no route resolves                                          | no price; a start refuses                                                                |

Where a route resolves, the repo's own rates win over the other bases, for
any model.

Spend is counted from pi's own per-call cost. The JSON contract gains a
second review schema with a nullable estimate and the route's fields; the
first contract refuses where it cannot state a price, and never prints a
zero, a stop or a guess as an estimate. The hand-written price table leaves
the core and serves the benchmark's comparator arms only. A bot round has no
dollar stop on any model, as before: its deadline and turn budgets hold it,
and the model it runs on is reported.

## Tiers

The tiers are `light`, `standard` and `deep`: thinking levels `medium`,
`medium` and `high` on the route's model, each of which a config may pin to a
model of its own. The older names (`terra-med`, `sol-med`, `sol-high`) are
read on every input for good (config, profiles, levers, verdict files, stored
rows, the agent names a long-lived session still calls) and are never
written. A rollback goes only to a version that reads both spellings.

## Why

The review engine never depended on one provider; the code around it did. The
shipped config named one provider's model in every model setting, a table of
two provider names switched between them, credential checks read a list of
environment variable names, and the price estimate assumed the model it was
fitted on. A person holding only another provider's login was refused until
they rewrote the config's model settings by hand.

pi already knows the providers, their credentials, the catalog and how to
parse `--model`. Every copy of that knowledge in this repository drifts from
pi on its next release, so the route asks pi, in one place, through pi's
public surface. With no model name in the code, a model or provider that pi
gains needs no release of ours.

The route is deterministic and stated before anything is spent. A person can
always see which model a run will use, why, and the one command that changes
it.

## Considered options

- **A table of models per provider and tier.** Rejected: it is model names in
  our code, stale with every catalog release, and it covers only the
  providers someone wrote a row for. The tiers are thinking levels on one
  model, which is what the shipped config already ran.
- **A deep import of pi's table of per-provider defaults.** Rejected: pi does
  not export it, and a file-path import is refused inside a running pi, which
  is exactly where `/qcr-review` runs. pi's root export gives the same answer.
- **A file-and-env resolver beside pi's, for the sessions pi's CLI starts.**
  Rejected: a second reading of credentials that can disagree with pi's. The
  login-route extension already runs inside those sessions and can set the
  model.
- **Copying a pin into every tier's spec when the config is parsed.**
  Rejected: it needs two matchers that disagree on anything but an exact id,
  `--model` could not move a pinned tier, and one move was reported once per
  copy.
- **An ordered move for a pin with no credential** (the first credentialed
  provider that serves the id). Rejected: pi's provider order is alphabetical
  and one id can be served by seven providers, so a pinned install with two
  logins could move to the one its owner did not mean. Matching on the last
  part of an id was rejected with it: it would move a pin to an aggregator at
  another price.
- **The remembered choice in the app's config home.** Rejected: the daemon's
  config home is mounted read-only and replaced on every update, a worker
  loads no config and derives no path, and the plugin must work without the
  app.
- **Scaling the measured estimate by the ratio of list prices.** Rejected:
  the estimate's token mix assumes the prompt-cache pack, which is off outside
  its API family, so the scaled number would be a guess shown as an estimate.
  No estimate and a stated stop is the honest answer.
- **Resolving the route in the container entrypoint** and writing it as pi's
  default model. Rejected: the route would later be read back as pi's own
  default and feed itself. The entrypoint writes a default only for a pin.

## Consequences

- **Nothing to migrate.** A config that names models keeps running on them:
  every spec a person wrote is a pin. `[models] default` and `conversation`
  fold into `model`, `[models.pricing]` is read and ignored, and the older
  tier names are read everywhere they were.
- **Two behaviours change.** A config that set `default` and `conversation`
  but not all three tiers used to get the missing tiers from a model named in
  the code; they now run on the config's own model. And a stored login that
  can last the run keeps its provider even when a key for the same provider
  is in the environment.
- **The provider-specific code goes:** the two-provider switch and its inline
  copies, the table of environment key names, the hand-parsed login file
  where pi is available, the wizard's route question and model-prefix
  rewrite, and the home's own device login. Login surfaces name no provider.
- **Version numbers are compared across model families,** inside an
  aggregator and between providers that tie on credential class. That is
  deterministic and stated before every run, and it is arbitrary; a stated
  choice overrides it.
- **Fences hold it, built with the code:** no provider or model name decides
  anything in product code; the shipped config pins nothing; every entry
  point resolves the same route from the same inventory; an unpinned tier has
  no `model:` line; no older tier name is emitted; unknown spend is never
  rendered as zero; the choice file is not a session's to write. The pi
  behaviours the route leans on (the default probe, the credential status
  labels, the borrowed store, the offline catalog load) are each pinned by a
  canary against the pinned pi.
