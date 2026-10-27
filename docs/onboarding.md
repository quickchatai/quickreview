# Onboarding — the first run, and the setup wizard's steps

A bare `qcr` opens the **home**: QuickReview's own pi, with the plugin loaded
and a panel of your repository's pull requests. On a machine that is not set
up, the home opens on a short [setup checklist](#the-first-run-the-homes-setup-checklist)
instead, and turns into the panel once it is done.

`qcr onboard`, the wizard's own door, is gone. Its steps, described from
[Before you start](#before-you-start) on, set up what the first run does not:
the always-on daemon, a GitHub App and webhooks, a server over ssh, memory and
going live. Switching auto-review on runs the ones this machine needs, and the
home's [Advanced](#spend-tune-to-this-repo-and-advanced) button offers the
rest; everything they do also has a manual equivalent, indexed in
[the README's appendix](../README.md#appendix--setting-up-by-hand).

## The first run: the home's setup checklist

```sh
qcr
```

The card shows three steps. Each is detected first: a step that is already
true shows as done, with what was found ("@you · via gh", "owner/name · from
your qcr config"), and is never asked again.

1. **Sign in to OpenAI.** pi's own device-code login for `openai-codex`, the
   provider the home's chat runs on, on your own pi home, so the chat, the
   panel and every review use the one login. It starts by itself: open the
   URL the card shows and enter the code. Device-code login must be on for
   your ChatGPT account first (ChatGPT → Settings → Security). A code that
   expires or is denied says so, and `alt+n` starts a clean new one.
2. **Connect GitHub.** `gh` installed and signed in. When it is not, the card
   says what to run (`gh auth login`, in a shell), and `alt+n` checks again.
3. **Choose a repository.** One of your recently pushed repositories, or paste
   any `owner/name` or GitHub URL. It is written to your config's
   `[github] repo`, with the defaults the home fills in silently: the timezone
   (this machine's), the base branch (the repository's default branch) and
   your name and login (from `gh`). A value you set yourself is kept, and
   `dry_run` is never written.

The first-run checks are pi, git and `gh`, and a check shows only while it
fails. `alt+n` runs the next step (`alt+enter` is pi's); `f2` focuses the card,
where `⏎` does the same and Esc gives the editor back. Every step is also a
tool the chat's model can call: `home_sign_in`, `home_check_github`,
`home_choose_repo` and `home_setup_next`. `qcr tui` opens the admin TUI, and
only it starts the companion.

## One login per box

A machine has one OpenAI login: the one the home signed in to, in your own pi
home (`$PI_CODING_AGENT_DIR`, else `~/.pi/agent`). The home's chat, every
review you start from it and auto-review all use it, and exactly one process
refreshes it at a time.

- **Auto-review off:** the home's pi refreshes the login itself, by pi's own
  rule (a token with under five minutes left, under pi's own lock on
  `auth.json`).
- **Switching auto-review on** shares that login with the stack. Switch-on's
  login step writes `QCR_PI_LOGIN_DIR` (your pi agent dir) into the project
  `.env`, which mounts it into the daemon's container at `/opt/qcr/login`,
  and turns `[login_refresh] enabled` on in `config.toml`. The daemon's
  refresher then owns that `auth.json`: it refreshes well ahead of pi's
  window, so the home's pi never has a token to refresh and only reads it.
  Only the login is shared. pi's settings in the container stay its own, and
  your global pi settings are never written. A stack brought up before is
  recreated on the shared login, with its data kept.
- **Switching auto-review off** stops the daemon and its refresher with it,
  and the home's pi refreshes on its own again.
- **One at a time:** the refresher's lock, `loginrefresh.lock`, sits beside
  `auth.json`, so a second refresher on the box is refused. The lock is never
  `auth.json.lock`, which is pi's own.

**When the login expires or is revoked,** the home's login line says
*login expired*, and auto-review shows *Paused: login*. `alt+l` (`l` on the
focused panel, or the `home_relogin` tool) signs in again with pi's device
code. While auto-review runs, the home first pauses its refresher, the same
handover the image's `login` mode makes, and waits until the refresher says it
has paused. The refresher keeps its lock but writes nothing until the pause
ends. When the sign-in ends, however it ends, the pause is lifted, the
refresher reads the new login at once, and auto-review resumes on it. A pause
left behind by a home that was killed mid-login is lifted by the refresher
after 15 minutes. A raw `/login` typed in the home does not pause the
refresher, so switch auto-review off before you use it.

**A remote server** (the advanced route) signs in with its own device login
and refreshes its own login. The host's login is never copied there.
## Spend, "Tune to this repo" and Advanced

- **The spend line** shows today's and this month's review cost: the home's
  own reviews (each finished run's cost, on the day it ended) and
  auto-review's recorded costs (its status snapshot's `today_spend_usd` and
  `month_spend_usd`), over UTC days and months as `qcr spend` counts them. It
  reads unknown when either cannot be read, for instance while auto-review is
  switched off with its data kept, never a zero.
- **Tune to this repo** (`t`, `alt+t`, `home_tune`) runs Setup: the chat's
  agent surveys a checkout of the repository, reads its review history when it
  can, interviews you, and writes the repo profile, `.qcr/` at the checkout's
  root, each file only on your yes (`home_tune_write`). The checkout is
  `QCR_REVIEWED_REPO`, `[companion] reviewed_repo_dir`, or the directory you
  opened the home from, whichever git says is the repository. The panel says
  when the profile is written; reviews use it once you commit it. Nothing
  waits on it: until then, every review runs on the default profile.
- **Advanced** (`x`, `alt+x`, `home_advanced`) runs the wizard's own steps on
  the same checklist switch-on uses:
  - **A GitHub App:** `github_account` on the App route, `github_app` (the
    manifest flow, through the hosted callback relay when
    `QCR_ONBOARD_PUBLIC_ORIGIN` is set) and `app_slug_reconcile`;
  - **Webhooks:** `ingress`, a tunnel instead of polling (on the App route
    only: GitHub delivers webhooks to an App);
  - **Another server, over ssh:** `topology`, `ssh_preflight`,
    `vm_inventory` and `vm_deploy` of a release, this app's by default;
  - **Slack:** says what is set up; the concierge's own guided tool,
    [`npm run slack:setup`](#slack-later), sets up the rest;
  - **Dry-run or live:** "Stay in dry-run" first, then "Go live", which is
    the wizard's go-live step. Going back to dry-run is your own edit of
    `dry_run`; nothing in the home moves it.

## The setup wizard

The wizard takes a machine with Docker to a working installation whose first
review you have watched happen. It is an interactive session: a pi agent talks
you through what the system is *while building it*, and every act it performs is
a named, deterministic tool whose result you see. The agent never improvises a
shell command; the tools do the work, and the agent reads their output back to
you honestly, red checks included.

This page is the reference for that session — what it asks, what it writes,
where it can stop, and what to do about it. The
[README quickstart](../README.md#quickstart) is the short version. If you would
rather assemble the installation yourself, everything the wizard does has a
manual equivalent; the ordered index is
[the README's appendix](../README.md#appendix--setting-up-by-hand), and the
wizard composes exactly those tools rather than replacing them.

## Before you start

- **Docker**, and the **Compose v2 plugin** (`docker compose`, not
  `docker-compose`). Nothing else is installed on your machine: QuickReview is
  one image, and the `qcr` command is a shell file that image writes
  ([docs/host-wrapper.md](host-wrapper.md)). Install it once and pin it to a
  release:

  ```sh
  docker run --rm --user "$(id -u):$(id -g)" -v ~/.local/bin:/out \
    ghcr.io/quickchatai/quickreview:<version> install
  ```

  The images are public on ghcr.io, so no registry login is needed. `qcr update`
  moves the pin to a newer release.

- **A GitHub sign-in on this machine** — `gh` logged in (`gh auth login`; on a
  Quickchat Boxes VM the Boxes GitHub connector has already done it). That is
  all the fast path needs: the reviewer runs on your own account. Only the App
  route needs a GitHub account that can create a GitHub App and install it on
  the repository you want reviewed.
- **On the server route only**: a Linux machine you already reach as `ssh
  <alias>`, with passwordless sudo there, and `ansible-playbook` installed on
  *your* machine — the deploy is an Ansible run from here, over your ssh.

The wizard runs pi at the pinned version (`config.toml [pi]`, which the image
carries and checks at every start). The session runs with no ambient
extensions, exactly one onboarding extension, and a read-only built-in tool
belt; its session store lives in `state/onboarding/pi-sessions/` and is never
shared with the reviewer or companion sessions.

**The wizard's own pi session needs model credentials before it can say
anything.** If you have neither a ChatGPT login on this machine nor
`OPENAI_API_KEY` in your environment, log in from pi's own input line with
`/login` when it starts. On the OAuth route that is login 1 of 3 (see
[The LLM route](#the-llm-route)).

## Its checklist

Run it again any time. The checklist lives in
`state/onboarding/checklist.json` (in the `qcr-state` volume), and **a step claimed done is always
re-verified against reality before it is believed** — so a second run is a
resume, and a run on a finished installation is a diagnostic. A corrupt or
unreadable checklist degrades to a fresh one rather than failing, because the
resume re-verifies everything anyway.

Start every session by asking for the status (the guide does this itself): it
reconciles the file against the world and demotes anything that no longer holds,
naming what broke.

### What you need, and the fast path

Three things, and only three:

1. **a model login** — pi's `/login` opens by itself the first time; any working
   OpenAI login does (see [The LLM route](#30--the-llm-route)). The reviewer's
   container needs its own login too, once the stack is up: the LLM step names
   the one command;
2. **your GitHub sign-in** — `gh` logged in here (already true on a Boxes VM);
3. **one repository** you can read.

The recommended path takes the defaults all the way: the reviewer on **this
computer** (`local`), **polling** instead of webhooks, and **your own GitHub
account** instead of an App. Setup ends there: once the stack verifies, the
wizard opens the TUI on the board, which lists every open pull request of the
repository. **Select one and press `R`** — the review starts at once, with no
label to add, and its progress shows on the board. Every question
the guide asks maps to a step's input; it never asks you for anything a tool
cannot take.

## The checklist

Nineteen steps, in this order. Three are specific to the server route and one
to the laptop route; the rest run on both, over whichever transport your
topology chose. The GitHub question splits the list a second way: your own
account (`user`) runs step 33, a GitHub App (`app`) runs steps 40 and 65 — once
it is answered, exactly one of 33 and 40 is enabled.

| # | step | route |
|---|---|---|
| 10 | preflight | both |
| 20 | topology — where the reviewer lives | both |
| 22 | ssh preflight | server |
| 30 | LLM auth | both |
| 33 | GitHub: your own account (the default), or an App | own account |
| 35 | interview and `config.toml` | both |
| 36 | escalation (optional, off by default) | both |
| 38 | memory embeddings: local by default | both |
| 39 | webhook ingress | both |
| 40 | GitHub App: create, install, label | App |
| 60 | memory keys, phase A | both |
| 65 | reconcile the App's real slug | App |
| 68 | deploy inventory | server |
| 70 | bring the compose stack up | laptop |
| 71 | deploy to the server | server |
| 72 | memory keys, phase B | both |
| 74 | verify the running system | both |
| 76 | the proof round: review this one PR now (after setup) | both |
| 78 | go live, or stay in dry-run (after setup) | both |

Steps 76 and 78 are **after setup**: they run and verify like the others, but
the checklist completes without them, so the wizard finishes once the stack
verifies and the first review happens on the board (`R`). Re-run the wizard
later to go live; it offers the flip once a review has completed.

### 10 — Preflight

Checks Node ≥ 26 (the supported Node, which the image carries; an older one is
noted, not refused),
`docker --version` and `docker compose version`, asks the registry whether the
release image can be pulled, and captures your user id. The uid matters: the
containers run as it, so they can read the 0600 files you own in the secrets
directory. If you change user between here and the bring-up, this step goes red
again on the next verification.

The registry question is a note, not a failure: an image it cannot reach (most
often a `QCR_VERSION` no release carries) shows up here with its fix, but only the laptop route pulls the image — the server route
builds on the server — and preflight runs before you have chosen. Bring-up's pull
is the hard gate and carries the same fix.

Where the wizard runs inside the image there is no Docker, and never will be
(no docker CLI, no socket): preflight notes that, and bring-up prints the
commands to run on your host.

There is no disk-space or port check here. The bring-up reports Docker's own
errors instead, and the deploy script has its own preflights.

### 20 — Where should your reviewer live?

The first real question, and it shapes everything after it. Both answers are
first-class; neither is the advanced one.

**A VM or server over ssh — the recommendation when this computer sleeps** (a
laptop), because a reviewer that is asleep reviews nothing.

- It is on 24/7: pull requests opened while you sleep still get reviewed.
- You bring the box — any ssh-reachable Linux machine, a cheap cloud VM is
  plenty. The wizard does not create one for you.
- Setup rides the same Ansible deploy the maintainers use, with every one of its
  preflights: clean tree, version-pin coherence, disk space, and a warning when
  review rounds are still running.
- Your operator TUI reaches it over ssh, so you need an ssh alias and a key your
  agent can use — checked in the very next step, before anything is built.
- The recommended ingress here is a named Cloudflare tunnel on your own domain.

**This computer — everything in Docker on the machine the wizard runs on.** The
pick when that machine is itself an always-on server, such as a cloud VM you are
logged into.

- Nothing else to own: `docker compose up` and the whole system is here — the
  daemon and the memory engine, and the TUI reads them locally with no ssh.
- It reviews only while this machine is on and the containers are running:
  always, on a server; on a laptop, until you close the lid.
- Nothing to expose on the default path: the daemon polls GitHub for new pull
  requests every few minutes, with no webhook, tunnel or public URL.
- The honest way to try QuickReview, and a perfectly good permanent setup on a
  desktop that stays on or a cloud VM.

On the server route you give the **ssh alias** here — the name you would type
after `ssh`, as it appears in `~/.ssh/config`. Not a URL, not `user@host`. If
you normally type a full `user@host`, add a `Host` entry for it first: the
deploy, the TUI and the memory forward all use that one name.

**Switching topology later** is supported and costs you none of your answers.
Re-run this step with the other choice; it refuses once and explains what
changes, and takes the confirmation phrase `SWITCH TOPOLOGY` on the second call.
The repo, the App, the labels, the memory keys and your config are all kept, and
**nothing is torn down** — anything already running keeps running until you stop
it by hand.

### 22 — ssh: the alias, the agent, and the passphrase trap (server route)

Deliberately the first thing the server route does, before anything is minted,
written or deployed. It checks that ssh knows your alias, that your agent holds
a usable key, that a real connection succeeds **without prompting for
anything**, that sudo on that machine needs no password, and that
`ansible-playbook` is installed here.

The one worth understanding: a passphrase-protected key with no agent does not
fail, it *prompts* — and a prompt inside a deploy is an invisible hang. Every
ssh the wizard runs carries `-o BatchMode=yes`, so it fails in the open instead.
When your agent is empty this step hands you the exact `ssh-add` line to run
**in your own shell**; the passphrase prompt belongs to your terminal and the
wizard will never try to type into it.

Passwordless sudo matters for the same reason: the deploy installs packages and
runs Docker as root on that machine, and a sudo password prompt would hang it
exactly the way an ssh passphrase would.

### 30 — The LLM route

Two routes, both fully supported. See [docs/llm-setup.md](llm-setup.md) for the
cost shapes and the manual equivalents.

**ChatGPT OAuth (subscription).** A stack the home switches on needs none of
the logins below: it shares the home's own login
([One login per box](#one-login-per-box)). For the wizard's route, the cost is
flat, and the catch is stated up front:
pi's OAuth tokens live in the pi home of whichever process logged in and **do
not transfer between your host and the containers**. Expect up to three separate
browser logins — this wizard's own pi session, the daemon container, and the
companion container. Each is guided where it happens, and each is verified to
have landed on that container's *persistent* pi-home volume, so a later
container recreate never silently costs you the login. Any OpenAI login counts
at each of them — "OpenAI Codex (legacy)", "OpenAI" (Sign in with ChatGPT), or
an OpenAI API key at `/login` — because every model reaches pi on the OpenAI
login that exists (see [docs/llm-setup.md](llm-setup.md)). The wizard's own
session opens `/login` by itself the first time, when pi has no usable login.

**An OpenAI API key.** One paste covers the daemon and its review sessions at
once: it lands as the `openai_api_key` file in your secrets dir, `0600`, and the
daemon container's entrypoint exports it as `OPENAI_API_KEY` for every pi
process in it. It reaches no other process: the companion container is never
handed the key file, so the companion keeps its own login (its model is on the
OAuth provider by default), and this wizard's own pi reads `OPENAI_API_KEY`
only from its own environment. The wizard then rewrites all six
model strings in `config.toml` from the `openai-codex/` provider prefix to
`openai/` — comment-preserving, idempotent, and reversible, so switching routes
later is just re-running this step. Model strings already pointing at some other
provider are left alone and reported.

The wizard does not accept a pasted key through the pi session (the value would
land in a transcript). It points you at the secrets directory and the exact
command that writes the file `0600` (`deploy/collect-secrets.sh`, from a clone,
reads it with hidden input).

**Either route: memory embeddings need nothing here.** The memory engine embeds
locally by default, inside the memory container, so no memory text leaves the
machine on either route — and `openai_api_key` is pi's credential alone, never
read for embeddings. A hosted embedder is a separate, explicit opt-in with its
own key file: step 38. This step says so as a note, never a blocker.

### 33 — GitHub: your own account, or a GitHub App

The step asks one thing, `github_auth`: **`user`** (your own GitHub account) or
**`app`** (a GitHub App). Where `gh auth token` works on this machine, `user` is
the default and the step goes straight ahead with no answer at all; with no
working sign-in and no answer it offers both and records nothing.

**`user` — your own account (recommended).** No App to create, nothing to paste,
any repository your account can read. It is **polling only** — webhooks are
delivered to Apps — and reviews are posted **as you**, as `COMMENT` reviews whose
body states the verdict (GitHub will not let anyone approve their own PR, and an
AI approval must never count as yours). What the step does, one ✓/✗ line each:

- **the token** — `qcr github-token sync`, run in-process: `gh auth token`
  (from the `gh` this shell resolves; `GH_TOKEN` / `GITHUB_TOKEN` when there is
  no gh), `GET /user` to prove it and name your login, then
  `<secrets>/github_token` written atomically, `0600`, the token alone. The
  login and the token's kind (`ghu_`/`gho_`/`ghp_`/`github_pat_`) are shown;
  the token never is.
- **the refresh** — a user crontab entry every 20 minutes, marked
  `# qcr github-token sync` (a re-run replaces it), running absolute `node` and
  `cli.js` with `--gh <the gh this wizard found>` and `--secrets-dir`, because
  cron's `PATH` is not yours (on Boxes the signed-in gh is the broker wrapper
  in `/usr/local/bin`, and the `/usr/bin/gh` beside it has no login). Boxes'
  gh hands out an 8-hour `ghu_` token, so there the refresh is what keeps the
  reviewer signed in; a `gho_`/`ghp_` token does not expire. A machine with no
  `crontab` gets the manual command and a plain statement of what lapses.
- **the repository** — call the step with `repo` (`owner/name` or its GitHub
  URL); with none, it lists the 15 repositories your account pushed to most
  recently. `GET /repos/{owner}/{repo}` proves your account can read it, which
  is enough to review and comment.
- **the labels** — the three trigger labels of [step 40](#40--github-app-create-install-label),
  created the same way, with your token, when your account may manage labels
  (triage or better). Otherwise they are skipped with the reason: nothing needs
  them for the first review.
- **the config** — `[github] auth = "user"`, `bot_login = "<your login>"`,
  `app_slug = ""` and `[ingress] shape = "polling"`. No App secrets exist on this
  route.

**`app` — a GitHub App.** The step records the answer; steps 40 and 65 do the
rest.

You can switch later by running the step again with the other answer. Nothing
is deleted either way: an App's secrets and your token file stay where they are.

### 35 — The interview, and `config.toml`

Asks the handful of things only you can answer, and computes the rest.

Asked: the repository to review (`owner/name`), where your local checkout of it
is, your GitHub App's slug, your IANA timezone, the repository's default branch,
and — all optional — your display name, your GitHub login, your Slack member id,
and the fallback login for escalation `@`-mentions. Two more are asked only when
they apply: the ssh alias on the server route, and the public webhook hostname
when your ingress does not assign one itself.

Derived, never asked: the bot login (`<app_slug>[bot]`), the clone directory,
the secrets directory, the end-of-day and Slack timezones (they cascade off
`[ops] timezone`, so you state your day once), the backfill identity, the defect
sink, the companion's repo dir, and the escalation-mention fallback.

Three properties worth knowing:

- **It patches, it does not rewrite.** Every comment, blank line and key order in
  your file survives; a commented-out assignment is uncommented in place, and a
  spent `← FILL (n)` marker becomes `filled by qcr`. A re-run whose
  answers all match produces a byte-identical file and does not touch the disk.
- **It validates before writing.** The candidate is loaded with the daemon's own
  strict loader first; if it would not load, nothing reaches `config.toml`.
- **It never writes `dry_run`, in either direction.** A fresh config carries the
  shipped `true`; an existing config keeps whatever it has. Every config-writing
  step in the wizard refuses an edit that names that key however it is spelled.
  Going live is its own explicit act, at step 78.

Secrets are never collected here. The step reports which of `app_id`, `app.pem`,
`webhook_secret` (and `tunnel_token`, when your deployment shape needs it) are
present, and points at the GitHub App step or `deploy/collect-secrets.sh` for
the rest.

### 36 — Escalation (optional, off by default)

One question, and **"no" is the right answer for most teams** — it is also the
shipped default, so declining changes nothing at all.

The thing to be clear about before answering, because the name misleads: this
is **not** "send the hard ones to a human". The reviewer decides every pull
request itself, on the merits, and posts a verdict — that never changes, and
there is no setting here that makes a review wait for a person. What escalation
adds is a **note beside that verdict**: an @-mention of one named person,
pointing them at *one thing* — this file and these lines, this migration, this
decision — with the question spelled out. It is a `[check this]` item with a
name on it.

If you turn it on, you must say two things, and the step will not finish
without both:

- **to whom** — `targets`, the closed list of GitHub logins escalation may
  ever reach, and `why`, in your own words, which is rendered verbatim in the
  note. One rule is written per login, so naming two people means **both** are
  told when a trigger fires;
- **what** — at least one trigger: paths touched (globs), a PR label, a
  severity floor on what the round posted, or a named check failing. All four
  together is fine; none of them is refused, because a rule that cannot fire is
  not a configuration.

Two optional answers:

- `shape` — `comment` (the default) posts the note. `review_request` **also**
  puts the pull request in that person's review-requested queue. Be aware of
  what you are choosing: GitHub words that queue entry "review this pull
  request", which is exactly what is *not* being asked, so the note is still
  posted alongside it and says so explicitly. `comment` is the shape that
  matches the intent.
- `session_judgement` — may the reviewer *also* escalate on its own judgement?
  Off by default. With it on it is still bounded to the same `targets`: a
  session that names anyone else is dropped by the daemon, not argued with.

You can re-run this step any time to change your mind, and you can write extra
`[[escalation.rules]]` blocks by hand — a re-run rewrites only the
`onboarding:<login>` rules the interview owns and leaves your own alone. The
`[escalation]` block in `config.example.toml` documents the whole grammar in
place.

Two things worth knowing while it is switched on. An escalation is recorded
only when it actually reaches GitHub, so running in dry-run first costs you
nothing — the same escalation still goes out for real when you go live. And
the same person is never pointed at the same file twice on one pull request,
however many rounds it takes.

### 38 — Memory embeddings: local by default

Decides where the memory engine computes the vectors it stores and searches by.
The shipped default is **local**: a small English embedding model
(`bge-small-en-v1.5`, its file pinned in the image) is served on
loopback inside the memory container, so nothing but the model call ever leaves
the machine — memory text included — and no key is needed. Calling the step with no
arguments keeps whatever `config.toml` already declares — the local default on a
fresh install, but a hosted provider an installation already chose stays hosted.
Moving an installation back to local takes an explicit `provider: "local"`.

The alternative is OpenAI's hosted embeddings (`provider: "openai"`, optionally
`model` and `dimension`; the defaults are `text-embedding-3-small` / `1536`).
The step says plainly what that means — every memory entry's text, and every
search query, is sent to OpenAI — writes `config.toml [openviking]
embedding_provider/model/dimension`, parses the result before writing it, and
then **stays red until the credential exists as its own file**,
`<secrets dir>/openai_embeddings_api_key`. Pi's `openai_api_key` is explicitly
not it: the two credentials are independent, so either can be set without the
other. As with every secret, the value never goes through the session — the
step points you at `bash deploy/collect-secrets.sh`, which has the prompt.

The answer reaches the boot through the route's own writer, from `config.toml`
as the single truth: on the laptop route the bring-up step (70) mirrors it into
the project `.env` (`QCR_OPENVIKING_EMBEDDING_*`, which `docker-compose.yml`
passes into the memory container); on the server route the inventory step (68) writes
a hosted opt-in as host vars on your inventory line (the tracked `group_vars`
say local), and `scripts/deploy.sh` refuses to deploy if `config.toml` and that
effective value ever disagree — that drift would reset the vector store for the
wrong embedder on the next boot.

Changing the embedder changes the vector space. An installation that already
holds memory is migrated at the next boot, never wiped and never left
unsearchable: the old vectors are moved aside (kept), the daemon re-embeds
reviewer memory through the server once it is ready, and the companion's
namespace is yours to rebuild from your PC with `qcr memory reembed`. The
memory text is never touched. [docs/memory-embeddings.md](memory-embeddings.md)
has the whole shape, the journal, and the rehearsal recipe.

### 39 — Webhook ingress

**The default is `polling`, on every route**: called with no answer, the step
applies it and says so in one line — the reviewer checks GitHub every few
minutes (`[daemon] poll_interval_s`) for pull requests to review; webhooks are
optional and can be added later by re-running this step. On your own GitHub
account (step 33) polling is the only shape: a tunnel answer is refused with
the reason.

Webhooks need an HTTPS URL for GitHub to deliver to. Four shapes, with their
real trade-offs. The upgrade worth having follows your topology: the quick
tunnel on this computer, the named tunnel on a server.

**`quick` — Cloudflare quick tunnel. No account, nothing to sign up for.**

- No account, no credential, no DNS: it works within seconds of `docker compose
  up`.
- The `*.trycloudflare.com` hostname **rotates** on every tunnel restart — and
  the daemon re-points the App's webhook URL itself, so this costs you nothing
  to operate.
- No SLA and no support: Cloudflare can drop a quick tunnel at any time. The
  reconcile poll still triggers every review, so an outage costs webhook
  latency, not correctness.
- Not for a permanent installation you advertise — for that, pick the named
  tunnel.

**`ngrok` — a stable hostname, at the price of an account.**

- Needs an ngrok account and an authtoken; with a reserved domain the hostname
  never changes.
- Free-tier caps: roughly 20,000 requests a month and 1 GB of transfer, one
  online agent, and rate limits around 120 requests a minute. A busy repo can
  exhaust that; the paid tier lifts it.
- Without a reserved domain the hostname still rotates, and the same self-heal
  covers it.
- The authtoken lives in a *file* in your secrets dir, never on a command line:
  `<secrets>/ngrok_authtoken`.

**`named` — your own Cloudflare tunnel, on your own domain.**

- A permanent hostname on a domain you own, with Cloudflare's SLA behind it.
- Needs a Cloudflare account, a zone, and a tunnel connector token (the secrets
  wizard collects it as `tunnel_token`).
- No rotation, so no webhook self-heal is needed or enabled.
- The same token works on either topology: as the compose sidecar here, or as
  the cloudflared service the Ansible playbook installs on the server.

**`polling` — no tunnel, nothing exposed (the default).** `[ingress] shape =
"polling"`.

- Nothing to install, nothing reachable from the internet: the daemon only makes
  outbound calls.
- The reconcile poll becomes the *only* trigger path, so a review starts up to
  one poll interval late (`[daemon] poll_interval_s`, 300s by default).
- What degrades, plainly: author replies do not route to the PR's session (the
  ping-pong path is webhook-driven), the `[feedback]` tuning loop never sees a
  comment, and the CI-completed retry of a withheld approval waits for the next
  sweep.
- It is not a dead end — re-run this step later and pick a tunnel; nothing else
  has to change.
- Switching a server that already ran the named tunnel to polling does not stop
  its `cloudflared` service — the deploy never stops one. The verify step warns
  when it is still active; stop it yourself with
  `sudo systemctl disable --now cloudflared` if it is yours.

The step writes the `[ingress]` block in `config.toml`, `[server] hostname` when
you gave one, and `COMPOSE_PROFILES` in the project's `.env`. It never accepts a
token as an argument: for `ngrok` and `named` it checks the secrets file exists
and tells you the `umask 077` line (or `deploy/collect-secrets.sh`) to create it.

Note that re-running this step replaces the whole `[ingress]` section body, so
hand-tuned `debounce_ms` / `sweep_interval_s` values go back to their defaults.

It runs before the App step on purpose: a hostname you give here (`named`, or
`ngrok` with a reserved domain) is written into the App's manifest when step 40
creates the App, so GitHub delivers to it from the first event. That happens
once. If the App already exists when you pick or change a fixed hostname, the
step says so, and you set the webhook URL on the App's settings page yourself
— only a rotating tunnel is re-pointed by the daemon.

### 40 — GitHub App: create, install, label

One click, no transcription. See
[docs/github-app-setup.md](github-app-setup.md) for what the App is and the
manual route.

The wizard serves a page on `127.0.0.1` that form-posts **this repository's
pinned App manifest** — `deploy/github-app-manifest.json`, the same artifact the
tests hold to the webhook handler's event set and the gate's write grants. It is
consumed, never copied, and exactly three fields are overridden: the App name
(yours if you give one, otherwise suffixed for global uniqueness — and editable
on GitHub's own page either way), the redirect URL, and the webhook URL. The
permissions and events are whatever the pinned artifact says. The page does not auto-submit: you see what is about to be
created, and the click is yours.

On a hosted box whose browser is not on the same machine (a reverse proxy
forwards a public https origin to the box's `127.0.0.1:8788`), set
`QCR_ONBOARD_PUBLIC_ORIGIN=https://<public host>` before the wizard runs, and
`QCR_ONBOARD_SETUP_URL` when the page you open is not the origin itself. The
manifest's redirect URL becomes `<origin>/manifest-callback`, the listener
admits the proxy's Host header beside loopback, and it binds port 8788
strictly: a busy port is a clear refusal, never a silent move to a port the
proxy does not forward.

GitHub redirects back to the wizard with a one-time code, which it exchanges for
the App id, private key and webhook secret — **the only moment GitHub ever
reveals that webhook secret** — and writes all three into your secrets dir as
`app_id`, `app.pem` and `webhook_secret`, `0600` in a `0700` directory, the same
three file names `deploy/collect-secrets.sh` writes. No credential passes
through your clipboard, and none is ever echoed back into the session.

Then you click Install on your repo. The wizard verifies it through the App's
own installation listing, checks that the repository is among the selected ones,
and creates the three labels:

| role | name | colour |
|---|---|---|
| trigger | `AI review requested` | blue |
| in progress | `AI review in progress` | yellow |
| reviewed | `Automatic Review` | green |

Those are the shipped defaults. The names come from **your** `config.toml`
(`[github] trigger_label` and its two siblings, recorded by the interview at
step 35), so if you renamed any of them the wizard creates the labels your
installation actually triggers on. A label that already exists is left exactly
as it is — colour and description included.

Two things that trip people up:

- **Manifest codes are single-use and expire an hour after GitHub issues them.**
  A rejected exchange is not a lost App: run the step again and it serves a
  fresh page with a fresh code. Nothing was written.
- **Organization Apps need an owner's approval for `members: read`** — and that
  approval is *deferrable*. It only powers the optional review-team trigger. The
  label trigger, which is the default way to ask for a review, works fully
  without it, so onboarding never waits for an org owner.

Re-running the step never creates a second App: with valid credentials already
in place it verifies the existing one instead. The only repository write it ever
makes is creating those label *definitions* — it never applies a label to a PR,
never posts a review, never pushes a branch.

### 60 and 72 — Memory, in two phases

Memory is what lets the reviewer remember what it learned about your repo across
pull requests. Three keys make it work, and **where each one lives is a security
boundary**:

| key | the secrets dir (the daemon's, read-only in its container) | the operator key file (yours) |
|---|---|---|
| root | `openviking_root_key` | never |
| reviewer | `openviking_reviewer_key` | `OPENVIKING_REVIEWER_KEY` |
| companion | **never** | `OPENVIKING_API_KEY` and `OPENVIKING_COMPANION_KEY` |

The reviewer key is what the daemon and every review session hold, and the
server confines it to the reviewer's namespace. The companion key is yours; it
must never reach the daemon host, because the container mounts the whole secrets
directory read-only and a review session could read it there.

**The step is two-phase, and the first phase ending red is expected.** The root
key can be minted offline and must exist *before* the daemon boots, because the
entrypoint renders it into the server's configuration — without it the memory
engine degrades to a mode with no per-user confinement at all. The two user keys
can only be issued *by a running server*. So step 60 places the root key, says
so plainly, and step 72 — after bring-up — mints the user keys, places them, and
proves the confinement with the four-cell matrix. An inconclusive matrix row
fails: a probe that cannot tell reach from refusal is never a pass.

The memory engine is never published on a host port, on either route: this
machine reaches it through the memory forward (`scripts/companion-memory-forward.mjs`,
`--local` on the laptop route, where it bridges into the compose `memory`
service, the container the engine runs in). On the laptop route the wizard opens
that forward itself for each memory step call and closes it when the call ends
(a forward that is already running, from `qcr tui` or the systemd unit, is used
and left alone), so step 72 needs nothing from you once the stack is up. On the
server route the step says which command starts one. There the daemon reads the copy of the reviewer
key a deploy shipped, and only `provision` copies the secrets dir (a `release`
never does): step 72 compares the server's copy with yours by hash — never the
key itself — and stays red, naming the provision, until they match.

Nothing is ever re-issued. A key that already exists is read back and
redistributed; a rotation would orphan every copy already handed out, so a file
holding a *different* value is reported as a conflict and left alone.

**Declining memory is a supported answer, and the step tells the daemon.** The
reviewer then runs memory-less: rounds still run and are never blocked or
delayed by memory, the TUI's memory tab shows the store as unavailable, and the
end-of-day curator and the `[feedback]` sink have nowhere to write. Declining
mints and places nothing; its one write is `[openviking] enabled = false` in
config.toml — the daemon's word for "off" — so memory health reports "not
monitored" and raises nothing (on the server route it ships with the next
release). Configuring memory later switches it back on. The difference
matters: with memory left ON and no reviewer key, a missing key is what it is —
a credential failure — and memory health treats it as one: every
round prompt carries a short `MEMORY UNAVAILABLE THIS ROUND` note (the session
reviews normally and never mentions it in the posted review), the TUI board
shows `MEMORY AUTH FAILED`, the overseer is woken (`memory_auth_failed`, again
every 6 h) and, after 2 h, the TUI files one tracker ticket. On an install that
DOES want memory, the same wake fires once, harmlessly, on a first bring-up
before step 72 has placed the keys, and boot provisioning's first run (which
creates the users) raises one `memory_provision_failed` — both expected on a
fresh install.

One placement detail you may see: the key file's home is
`~/.config/qcr-operator/<install>/openviking-keys.env` — outside the secrets dir
and the config home, both of which the container mounts. A key file at the
legacy location (`~/.config/quickreview-bot/openviking-keys.env`) is never read;
`qcr install migrate` moves it. A layout that would put the
key file inside a mounted dir anyway is refused, and the wizard tells you the
`export QCR_OPENVIKING_KEYS=…` line — the TUI, the companion and
`scripts/companion-memory-forward.mjs` all read that variable, and you have to
set it yourself for them to find the relocated file.

### 65 — Reconcile the App's real slug

Your App's slug is only settled once the App exists: GitHub makes the name
globally unique, and you can rename it on GitHub's own page afterwards. The
config was filled before that. This step asks the App itself (`GET /app` with an
App JWT) and corrects `[github] app_slug` and `bot_login` to match.

It matters more than it looks. `bot_login` is how the reviewer recognises its
own reviews and comments — and a wrong one fails *silently*: the posting guard
reads the bot's own review as a human approval, the ping-pong path mistakes its
own comments for the author's, and nothing else in the system checks it.

If it changed anything, the daemon is restarted, because the config is read once
at boot.

### 68 — The deploy inventory (server route)

Writes `deploy/ansible/inventory.ini` — the file `scripts/deploy.sh` reads —
from answers you have already given: the ssh alias, the login user your ssh
config resolves, and whether the playbook should install the cloudflared service
(yes for the named tunnel, no for every other ingress shape, in which case you
front the daemon's port yourself). It also points the operator TUI at that
machine (`[tui] target = "ssh"`, `[tui] ssh_host`).

`cloudflared_enabled` is written as a host var in the inventory rather than as
an override, because inventory host vars outrank the tracked `group_vars`, and a
tracked-file edit would be a dirty tree, which the deploy refuses on.

### 70 — Bring the compose stack up (laptop route)

Pulls the two released images and starts them. It writes `QCR_VERSION` (the
release both images are pinned to), `QCR_UID`, `COMPOSE_PROFILES`, the config
home, the secrets dir and the memory embedder's knobs into the project's
`.env`, and `[openviking] endpoint = "remote"` with `host = "memory"` into
`config.toml` (the daemon probes the memory service this stack runs; memory is
a container of its own, not a process inside the daemon's). Then it runs
`docker compose --project-directory <root> [--profile <p>] pull --ignore-buildable`
and `... up -d`, streaming every line. Nothing is built except the tunnel you
chose, from a small wrapper over the vendor's image.

**The first pull is the slow one.** It downloads the daemon image and the
memory image, and the memory image carries its embedding model, so it is the
larger of the two; how long that takes depends on your connection. That is
expected, not a hang — the output is streamed line by line and the wizard
prints an elapsed marker every 25 lines. Later starts reuse the layers already
here and take seconds. The wizard says so before the pull starts, not after.

A failed pull quotes Docker's own last lines. The usual causes are a `QCR_VERSION` no release carries, no disk space (`docker
system df`, then `docker system prune`), and a network failure mid-download —
all safe to retry, and a retry resumes from the layers already here.

**Where the wizard runs inside the image, it cannot run Docker** (there is no
docker CLI or socket in the image, by design), so this step starts nothing. It
prints the exact commands for your host, in order — make the project
directory, extract the compose file and the tunnel build context from the image
(`docker run --rm --entrypoint tar ghcr.io/quickchatai/quickreview:<version> -C
/opt/qcr -cf - docker-compose.yml docker/tunnel | tar -xf -`), write the
`.env`, `docker compose pull`, `docker compose up -d` — and stays red until you
have run them and run the step again to see the stack up. The paths in that
`.env` are the install's default config home; edit those lines if yours is
elsewhere. No secret is in any of it.

Bring-up's own success bar is "the compose command succeeded and the daemon
and memory containers are running". Whether the system *works* is step 74's
question.

### 71 — Deploy to the server (server route)

Runs `scripts/deploy.sh` — the same script, with the same preflights, that the
maintainers run. The plan is always printed first (a `--dry-run` of the same
mode), then the real run. The first deploy is a `provision` (the host:
packages, Docker, your secrets and the updater) followed by `release <version>`;
later ones are `release <version>` alone, and you pass `provision` by name after
changing the inventory's host settings or the secrets. A release needs the
deploy manifest CI emitted for that version.

The wizard passes no skip flag and no environment override — there is nowhere in
the argv builder to put one — so the guided path gets byte-identically the
manual path's refusals: a dirty working tree, any version-pin mismatch, a
missing inventory or `ansible-playbook`, the playbook's own on-box checks, and
the advisory warning when review rounds are still running. If the script
refuses, that refusal is quoted to you exactly; the wizard neither bypasses nor
softens it. The two commonest on a first install are an uncommitted change and a
version-pin mismatch.

Nothing is built on the server: the release is the image CI built once from the
tag, and the server pulls it by digest. The first pull downloads the daemon and
memory images (the memory image carries its embedding model), which is the slow
part on a small connection.

After the deploy the wizard does not take the script's word for it — it asks
Docker on that machine what is running.

### 74 — Verify the running system, in layers

Three layers, each meaningful only if the one before it holds. A red layer stops
here and says what to do: nothing later would mean anything until it is fixed.

1. **Containers** — the daemon, its memory sidecar (unless you declined memory)
   and the ingress sidecar, when your shape has one, are running.
2. **Health** — the daemon answers `GET /health` with `{"ok":true}`. On the
   server route this is a `curl` run on the box, because the daemon's port is
   loopback-only there.
3. **Ping delivery** — GitHub's own delivery log shows a ping your daemon
   accepted. This proves the whole path from GitHub through your ingress into
   the daemon, end to end. Under the polling shape this layer is skipped and
   reported as not checked: nothing is exposed, so no ping can arrive, and the
   reconcile poll is the only trigger path. On your own GitHub account it is
   skipped too, with that reason: there is no App, so no App webhook to read.

Beside the health layer, one more check, `tui-route`: the operator TUI's own
read. It resolves `[tui]` exactly as `qcr tui` does (`src/tui/route.ts`) and
reads `status.json` through the same runner — local docker into the daemon
container on this machine, ssh on the server route — so a red check here is the
board that would otherwise open on "unreachable". It does not stop the ping
layer.

If the last ping failed, the wizard redelivers it once and watches for about
thirty seconds. If it still fails, the three things to check are: the webhook
URL must be this daemon's public address (on a rotating tunnel the daemon
re-points it itself, so give it a few seconds after bring-up); a 401 or 403
means the webhook secret on GitHub is not the one in your secrets dir; and a
timeout means the tunnel is not reaching the daemon.

This step is safe to run as often as you like. The only write it can make is
that App-scoped webhook redelivery — never a review, a label or a comment.

### 76 — The proof round (after setup)

The first review normally happens on the board, after setup: `R` on a selected
pull request sends the same `review-now` command. The step stays for a
re-run of the wizard (go-live reads its record) and for anyone who asks the
guide to review from the chat.

Call it with no answer and it lists the five most recently updated open pull
requests in the repository, yours marked (on your own account your PRs are the
main target). Name one — `pr` (its number) or `url` (its link) — and **the review
starts immediately**: no label to add. The wizard writes one `review-now`
command into the daemon's root-sealed operator channel (`commands/operator/`,
the channel `qcr drain` uses; `qcr review-now <pr>` is the same command from the
host), which queues the PR exactly as a fresh trigger label would, with no
GitHub write. The label stays the way later reviews are asked for — the
reviewer never reviews anything on its own initiative. The wizard does not
create a demo PR for you, deliberately. On a LIVE installation
(`dry_run = false`) it asks first, because that review posts.

Then it follows the round through the daemon's own state store, checking every
thirty seconds for up to thirty minutes, and when a verdict lands it **shows you
the review**, read out of `state/dryrun/` — so you judge the output while it is
still structurally impossible for it to have posted anywhere. It shows the
verdict (on the merits, and the event it would have been posted as), how many
findings, the top five, and where the full text is (the dry-run file, with the
command that prints it) — then the review body and each inline comment with
its file and line, alongside a count of every other would-be GitHub call the
gate recorded instead of executing.

If nothing happens it stops waiting and tells you what to check, in order: that
the label is exactly the configured one (a near-miss looks like nothing
happening); that the PR is in the configured repo, open, and not authored by the
App itself; that polling-only ingress means allowing one poll interval; then the
verification step and the daemon's event log. If a round *failed*, the commonest
first-install cause is the review session having no working model credential —
attach to the session and a login prompt there is your answer.

### 78 — Go live, or stay in dry-run (after setup)

The last decision, and it is yours alone, made after setup: re-run the wizard
and ask for it. It is offered only after a completed
proof round, and the wizard re-checks that round against the daemon's own state
store first: this is the one decision it will not make on the strength of a
checklist file.

What it reads out:

> Right now `dry_run = true` in your config.toml. Everything runs — a labelled
> PR starts a round, the lenses read the diff, the session writes a review — but
> the single gate every GitHub write passes through records what it *would* have
> done into `state/dryrun/` instead of doing it. Nothing this system has ever
> done has reached your repository.
>
> Going live sets that flag to false. From then on the reviewer posts for real:
> reviews and inline comments on labelled pull requests, its own status labels,
> and replies to the author. It still never dismisses anyone's review and
> never touches your default branch. It nominates a human reviewer only if you
> turned escalation on at step 36 — and then only the people you named, beside
> a verdict it has already decided.
>
> Declining is a completely normal answer, and not a lesser one.

**Declining is a finished installation, not a failure.** Labelled PRs get
reviewed, the reviewer learns, the TUI and the companion work, and every review
lands in `state/dryrun/` for you to read. You can flip whenever you like.

Accepting takes the explicit phrase `GO LIVE` — not "yes", because a flip is
worth a sentence. The wizard then writes the flag, loads the result with the
strict loader to prove it reads back false, restarts the daemon (on the server
route that restart is `scripts/deploy.sh release <version>`, with all of its preflights
intact — so a flip can fail for a reason that looks unrelated, like a dirty
tree), and re-reads the flag from disk to confirm.

This is the owner-only surface described in [docs/ownership.md](ownership.md):
the wizard offers, the owner decides, and no other step in the wizard can move
that flag as a side effect.

## Finishing, and the handoff

When every step is done, the finish tool re-runs the **entire** verification
checklist. Anything red comes back as the answer and the session does not exit —
onboarding is never presented as finished while something is broken. All green
and it marks the checklist complete, writes
`state/companion/first-run.json` and closes itself.

### The companion's first-run interview

That marker is what tells the companion this is a brand-new installation. On the
first TUI start it introduces itself and runs a calibration interview instead of
the ordinary daily greeting. Everything about it is optional and nothing in the
review system waits on it — reviews run exactly the same whether the interview
happens now, later, or never.

Four areas, conversationally, one at a time:

- **A repo tour it does not assume.** It explores your reviewed repo read-only
  first, forms its own inferences about the stack, the layout, the test culture
  and the CI shape, then presents them to you for correction. Your corrections
  are the truth; it never writes an unconfirmed inference into memory.
- **Review taste.** Where your blocker-versus-nit line is, how much style
  commentary you want, how strict to be about tests and docs, and what kinds of
  findings have annoyed you in past review.
- **Team and workflow norms.** Who merges, branch conventions, and who should be
  `@`-mentioned when a PR touches agent-directive files.
- **A read-back** of what it learned and what it is about to store.

Confirmed answers go into reviewer memory tagged `#calibration`, so the very
first review round benefits. The few standing instructions you confirm — the
blocker/nit line, the escalation mention — are pinned (moved into the pinned
area), the one part of memory with guaranteed reach into every round prompt.

Answers that map onto a `config.toml` knob become **proposals**, never silent
edits: a pitch plus a patch, waiting in the TUI's `[7] feedback` tab (its
PROPOSED pane) for your accept or reject. A proposal touching `dry_run` is structurally
refused.

You can redo or continue the interview any time by asking the companion in
conversation; it is not re-delivered as a mechanism, and it never nags.

## If it is interrupted

Run the wizard again. Completed steps are re-verified, not repeated,
and the session continues at the first unfinished one. Nothing you answered is
asked twice: answers live in the checklist as recorded choices, and steps read
each other's rather than re-asking.

If the wizard exits without the checklist verifying complete, it says so and
tells you to run it again. That is the normal shape of a multi-session setup —
the GitHub App install click, an org owner's approval, or an overnight image
build are all fine places to stop.

## Re-running it on a working installation

It doubles as a diagnostic. Every claimed-done step is re-verified against
reality — containers, health endpoint, GitHub's delivery log, the memory
confinement matrix, the config's own invariants — and anything that no longer
holds is demoted with the reason. `verify` never writes to the installation or
the reviewed repo: a re-run on a healthy installation changes nothing. Its one
outward act is the stack check's: when GitHub's delivery log shows the newest
webhook ping failed (or deliveries since it did), it asks GitHub to redeliver
that ping — on the App's own hook, never a review, label, branch or comment.
Running a step tool again is different: a step
that succeeds has acted on the installation, so it withdraws the completion
claim until `finish_and_exit` runs green again.

## Windows

There is no Windows-native path. Run everything inside **WSL2**: Docker
(Docker Desktop's WSL2 backend, or Docker Engine inside the distro), the `qcr`
wrapper, and the wizard itself. The preflight step depends on a POSIX user
id to match the containers' user to the files you own, and says so if it
cannot find one.

## Slack, later

The Slack concierge is deliberately not part of onboarding. Skipping it now
costs nothing, and setting it up later is its own guided tool:

```sh
npm run slack:setup            # deploy/collect-slack-secrets.mjs, from a clone: the image does not carry it yet
```

It creates the app, collects the two tokens into your secrets dir, picks the one
channel, builds the identity map and patches `config.toml`. It never deploys,
never starts anything, and never touches `dry_run`.

## Working on QuickReview itself

A clone is for developing QuickReview, not for running it, and none of the
above needs one. The developer route (build, test, and the home run from a
checkout with `scripts/qcr home`) is in
[CONTRIBUTING.md](../CONTRIBUTING.md#running-from-a-clone).

## What the wizard will not do

- Create the VM on the server route. You bring an ssh-reachable box; the
  playbook handles everything on it.
- Open a demo pull request in your repository for the proof round.
- Flip `dry_run` without your explicit confirmation phrase, or in the other
  direction at all.
- Improvise a shell command. Every act is a named tool, and the guide reads its
  result back to you rather than claiming an outcome.
