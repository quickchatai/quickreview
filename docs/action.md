# The GitHub Action

`uses: quickchatai/quickreview@v1` reviews one pull request and posts the
findings as one comment-only review. Its Marketplace name is **QuickReview AI
Code Review**. The Action is stateless: each run starts on a fresh runner, with
no memory and nothing learned from earlier runs. Every run is a full review on
your model key, and you pay for each one. The review is always a comment: it
never approves and never requests changes, whatever its verdict says. You
decide when it runs.

## Install

Inside a checkout of the repository, run:

```sh
npx @quickchatai/quickreview action install
```

It needs [`gh`](https://cli.github.com/) signed in with the `repo` and
`workflow` scopes. When a scope is missing it tells you the command to run
(`gh auth refresh -h github.com -s workflow`) and writes nothing. It asks two
things:

1. **When reviews should run.** Pick any of the [four recipes](#when-it-runs-you-decide):
   `comment`, `label`, `push`, `manual`. `comment` and `manual` are picked by
   default.
2. **The secret's name.** When your own model route uses an API key (what
   `qcr model` shows), it takes that key's name and says so. It asks only
   when the route names no key.

Then it does the rest, saying what it is about to do and asking before each
write:

- **The secret.** A repository secret of that name that already exists is
  kept. So is an organization secret of that name that your organization
  shares with the repository: a repository secret would override it for every
  workflow in the repository. Otherwise it stores your key with
  `gh secret set`: the value from your environment, handed to gh on stdin, or
  gh asks you for it without echo. With neither, it prints the command for
  you to run.
- **The label.** With the `label` recipe, it creates the label `qcr-review`.
- **The workflow.** It creates the branch `qcr/action-install` on GitHub,
  commits `.github/workflows/quickreview.yml` to it, and opens a pull request.
  Your local checkout is not touched.

Merge that pull request. The `comment` and `manual` recipes work only once the
workflow is on the default branch. With the defaults, a `/qcr` comment on a
pull request then asks for a review.

The flags: `--on comment,label,push,manual`, `--secret NAME`,
`--repo OWNER/NAME` (outside a checkout), `--local` (write the file into this
checkout and print the git steps, instead of opening a pull request), `--force`
(replace a workflow file that is already there), `--yes` (make each write
without asking; in a terminal it still asks the two questions above when you
did not pass `--on` or `--secret`) and `--json`. Without a terminal it takes
`comment,manual`, and the secret's name from `--secret` or your model route.
Without a terminal and without `--yes`, it makes no write and prints each
command for you instead. `qcr action workflow` prints the workflow and writes
nothing.

`--json` prints one object, for a script to read:

| Key | Value |
|---|---|
| `ok` | `true` when no step failed (exit 0) |
| `repo` | `OWNER/NAME` |
| `on` | the triggers, empty when the run stopped before choosing them |
| `secret` | `{ "name", "state" }`, `state` one of `kept`, `set`, `printed` (left for you to run); `null` when the run stopped before this step |
| `label` | `created`, `exists`, `printed` (left for you to run); `null` when the `label` trigger is not chosen, or the run stopped before this step |
| `workflow` | `{ "path", "written", "pr_url" }`, `written` one of `pr`, `local`, or `null` when no file was written |
| `next` | what is left for you to do, one step each |
| `errors` | what failed, one line each |

With the `push` recipe, the install's own pull request is reviewed once the
secret is set, and that review is paid for like any other.

The install's GitHub writes are made by your own `gh`, on your command. Why
they do not go through the reviewer's gate is
[ADR 0003](adr/0003-setup-writes-through-gh.md).

**By hand.** Add your provider's API key as a repository secret (Settings,
Secrets and variables, Actions; or `gh secret set ANTHROPIC_API_KEY`), and add
a workflow with the step below.
[`docs/action/qcr-review.yml`](action/qcr-review.yml) is the file
`qcr action install` writes with the default recipes: copy it to
`.github/workflows/quickreview.yml` and change the secret's name to yours.

## The minimal workflow

The whole Action is one step:

```yaml
- uses: quickchatai/quickreview@v1
  env:
    ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

Under any trigger, it reviews the pull request the event names. You need no
checkout step: the review fetches the pull request itself and reads the
repository's `.qcr/` profile from the pull request's base. Any provider works:
put its key under the name it documents ([Any provider's key](#any-providers-key)).

Around it, a workflow needs `pull-requests: write` to post, a Linux runner with
docker (GitHub's `ubuntu-latest` has it), and a job timeout longer than a
review:

```yaml
name: QuickReview

on:
  issue_comment:
    types: [created]

permissions:
  contents: read
  pull-requests: write

jobs:
  review:
    runs-on: ubuntu-latest
    timeout-minutes: 90
    if: github.event.issue.pull_request && startsWith(github.event.comment.body, '/qcr')
    steps:
      - uses: quickchatai/quickreview@v1
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

## When it runs: you decide

Your workflow's `on:` and `if:` decide when the Action runs, and it takes any
event. It reads the pull request from the event, or from the `pr` input when
you pass one. The job's `if:` only keeps runners from starting for nothing.
The Action's own gate decides whether to review
([Who can start a review](#who-can-start-a-review)).

`qcr action install` writes any mix of these four recipes into one workflow.
`label` and `push` share one `pull_request: types:` list, and the job's `if:` is
the OR of the parts you picked. The installed workflow also has one concurrency
group per pull request. A newer push to the pull request's own branch cancels
the review in flight (that takes write access). Any other run waits for it: a
`/qcr` comment, a label, a manual run, or a push to a fork. Anyone who can
comment can send `/qcr`, and the gate may then skip them, so their run must
not cancel a review that has already spent. GitHub keeps one run waiting per
group: a newer one replaces it before it starts.

**`comment`**: someone comments `/qcr` on a pull request.

```yaml
on:
  issue_comment:
    types: [created]
jobs:
  review:
    if: github.event_name == 'issue_comment' && github.event.issue.pull_request && startsWith(github.event.comment.body, '/qcr')
```

**`label`**: someone adds the label `qcr-review` to a pull request.

```yaml
on:
  pull_request:
    types: [labeled]
jobs:
  review:
    if: github.event_name == 'pull_request' && github.event.action == 'labeled' && github.event.label.name == 'qcr-review'
```

**`push`**: every push to a pull request, when it is opened, and when a draft
is marked ready. Drafts are skipped. Each push pays for a full review.

```yaml
on:
  pull_request:
    types: [opened, synchronize, ready_for_review]
jobs:
  review:
    if: github.event_name == 'pull_request' && github.event.action != 'labeled' && !github.event.pull_request.draft
```

**`manual`**: someone runs the workflow from the Actions tab (Run workflow)
and types the pull request's number, or runs
`gh workflow run quickreview.yml -f pr=<number>`.

```yaml
on:
  workflow_dispatch:
    inputs:
      pr:
        description: The number of the pull request to review
        required: true
        type: string
jobs:
  review:
    if: github.event_name == 'workflow_dispatch'
    steps:
      - uses: quickchatai/quickreview@v1
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
        with:
          pr: ${{ inputs.pr }}
```

**`pull_request_target`.** It works like `pull_request`, with one difference:
it runs from the default branch with the repository's secrets and a write
token, on a fork's pull request too. With `types: [labeled]` it lets someone
with write access ask by label on a fork's pull request. On a push, the person
who started the run is the fork's author, so the gate skips it unless
`allowed-users` names them. Read
[Pull requests from forks](#pull-requests-from-forks) first. From
2026-12-02 GitHub blocks `pull_request_target` by default in public
repositories, unless the repository's Actions event policy allows it. Private
and internal repositories are not affected. `qcr action install` does not offer
it.

**Events that name no pull request**: `schedule`, `workflow_run`, `push`,
`merge_group`, and `workflow_dispatch` without an input. Pass the `pr` input.
The Action never guesses a pull request from a commit. Without `pr` it fails,
and the error names the event and says to pass `pr`.

## Inputs

All inputs are optional.

| Input | Default | What it does |
|---|---|---|
| `pr` | the event's pull request | The pull request's number. Needed on an event that names none. |
| `repo` | `${{ github.repository }}` | The repository of the pull request, `OWNER/NAME`. |
| `github-token` | `${{ github.token }}` | The token the Action checks access with, reads the pull request with and posts with. It needs `pull-requests: write` to post. |
| `profile` | none | A shipped [review profile](profiles.md#selecting-a-profile) to run instead of the standard review: `security`, `state-machines`, `fast`, `snappy`, `default`, `minimal` or `example-django`. The repository's own `.qcr/` profile applies either way. An unknown name fails the run. `fast` is meant to go with the `low` preset, which the Action does not set. |
| `post` | `"true"` | `"false"` runs the review, puts the result in the job summary and the outputs, and posts nothing. Any other value fails. |
| `allowed-users` | none | Who else may start a review, beyond people with write access: GitHub logins separated by commas (a bot as `name[bot]`), or `*` for anyone. |
| `limit` | none | A hard stop in US dollars. With none, the review has no cap. |
| `model` | the provider's newest | The model, as `qcr review --model` takes it: `provider/model`, with an optional `:level`. |
| `pi-auth` | none | The contents of a pi `auth.json` (a login for any provider), as a secret. Not needed with an API key in `env:`. |
| `openai-api-key`, `anthropic-api-key`, `gemini-api-key`, `digitalocean-api-key` | none | Older names for a key in `env:`. |
| `image` | the release image at this Action's ref | An image to run instead, `ghcr.io/OWNER/NAME:VERSION`. |
| `registry-token` | none | A token that can read a private image named by `image` ([A private mirror](#a-private-mirror)). |
| `registry-user` | `${{ github.actor }}` | The user docker logs in as with `registry-token`. |

## Outputs

| Output | Value |
|---|---|
| `skipped` | `"true"` when the Action decided not to review, else `"false"` |
| `skip-reason` | Why, in one line. Empty when it did not skip. |
| `pr` | The pull request's number. Empty when there is none. |
| `review-url` | The link to the posted review. Empty when nothing was posted. |
| `verdict` | `APPROVE`, `REQUEST_CHANGES`, or empty. The verdict is the review body's text: the review itself is always a comment. |
| `findings` | The number of findings, over every severity. Empty when the result holds no findings at all, as when the review was refused or printed no result. |
| `cost-usd` | What the run spent in US dollars, as the review reports it. Empty when unknown. |
| `result` | The whole review result, as [schema 2](../schemas/review-result.v2.json) JSON on one line. Empty when the run printed none. |

The run also writes a job summary: the pull request, the verdict, the review's
link or "not posted", the cost, and a table of the findings (severity,
`path:line`, title, lens), at most 50 rows. When the review did not finish, the
summary says so and points at the log.

To read an output in a later step, give the step an `id`. Pass the value
through `env:`, never straight into `run:`:

```yaml
    steps:
      - uses: quickchatai/quickreview@v1
        id: review
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
      - name: Fail the job when the review asks for changes
        if: steps.review.outputs.verdict == 'REQUEST_CHANGES'
        env:
          REVIEW_URL: ${{ steps.review.outputs.review-url }}
        run: |
          echo "QuickReview asks for changes: $REVIEW_URL"
          exit 1
```

## Examples

**A security review on a label.** A second workflow, beside your usual one,
runs the `security` profile when someone adds the label `qcr-security`:

```yaml
name: QuickReview security

on:
  pull_request:
    types: [labeled]

permissions:
  contents: read
  pull-requests: write

jobs:
  security-review:
    if: github.event.label.name == 'qcr-security'
    runs-on: ubuntu-latest
    timeout-minutes: 90
    steps:
      - uses: quickchatai/quickreview@v1
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
        with:
          profile: security
```

**Try it without posting.** With `post: "false"` the review runs in full and
is paid for, the result goes to the job summary and the outputs, and nothing
reaches the pull request. This is not dry run: `post` only chooses where the
result goes. With the `manual` recipe you can try it on one pull request:

```yaml
      - uses: quickchatai/quickreview@v1
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
        with:
          pr: ${{ inputs.pr }}
          post: "false"
```

## Who can start a review

Before it pulls the image or spends anything, the Action checks who started the
run. That is the person who triggered it, or who re-ran it (re-running needs
write access too).

- **A login named in `allowed-users`**, or anyone when it is `*`: reviewed.
- **A bot** (a login that ends in `[bot]`): skipped, unless `allowed-users`
  names it. GitHub treats Dependabot's pull requests like a fork's, too.
- **Anyone else**: the Action asks GitHub for their permission on the
  repository, with the workflow's token. `admin` or `write` (maintain counts
  as write) is reviewed. `read`, `none` or no access at all is skipped, and
  the reason says how to let them in.
- **No answer from GitHub** (a network error, a 5xx, a 401 or a 403): the run
  fails rather than guess.

A skip is not a failure. The step succeeds, the output `skipped` is `"true"`,
and the reason is in the log and the job summary.

Why: every review spends your model key and posts on your repository. On a
public repository anyone can comment `/qcr`. The `author_association` a comment
carries does not prove write access (a read-only collaborator is a
`COLLABORATOR`), so the Action asks GitHub directly. GitHub's own coding
agents start only for people with write access, and this is the same default.

Setting `allowed-users: "*"` on a public repository lets anyone spend your key.

## Pull requests from forks

What GitHub gives a run on a fork's pull request:

| Event | Your secrets (the model key) | A token that can post |
|---|---|---|
| `pull_request` (the `push` and `label` recipes) | no | no |
| `pull_request_review`, `pull_request_review_comment` | no | no |
| `issue_comment` (the `comment` recipe) | yes | yes |
| `workflow_dispatch` (the `manual` recipe) | yes | yes |
| `pull_request_target` | yes | yes |

These are GitHub's defaults. A private repository can choose to send secrets
and write tokens to runs from forks.

So the `push` and `label` recipes do not review a fork's pull request:

- **`push`**: the fork's author starts the run with their push. The gate
  skips it because they have no write access to your repository. Naming them
  in `allowed-users` does not help here: the run then gets past the gate's
  first check and is skipped at the next, because GitHub gives a
  `pull_request` run from a fork no secrets.
- **`label`**: someone with write access adds the label, so the gate lets
  them in, and then skips the run with that reason: GitHub gave it no key.

To review a fork's pull request, someone with write access asks with a `/qcr`
comment or a manual run. The fork's author can ask with a `/qcr` comment only
when `allowed-users` names them.

**The risk.** When a fork's pull request is reviewed, your model key is in the
review container, and the container reads the fork's text: its code, its
description and its comments. Someone can write a pull request to steer the
model. These layers stand between that text and your key:

- The reviewer reads the code and never runs it: no build, no tests, no install
  scripts ([docs/exec-boundary.md](exec-boundary.md)).
- The key is in the review process's environment, and the model's tools are
  kept out of it. The model's shell runs as another user, with an environment
  of `GIT_*` and `QCR_*` names only, and cannot read the review process's
  environment.
- The model's file tools are fenced off `/proc`, the token mount and the login
  directories.
- The command guard refuses curl, wget and every interpreter.
- The GitHub token is never in the environment. The image reads it once from a
  file and deletes the file before any model tool exists.

The command guard works on command strings, and that layer is not claimed to
be closed. The container's network is not firewalled. Treat a key that reviews
a fork's pull request as one that could leak.

What to do:

- Let a maintainer's request be the gate. Review a fork's pull request only
  when someone with write access asks, after they have read it. That is the
  default.
- Know what the request covers. The review reads the pull request's head as
  it is when the run fetches it, not the commit you read. The fork's author
  can push between your request and the fetch, while the runner starts and
  pulls the image, and that push is reviewed with your key. When a push lands
  after you asked, cancel the run from the Actions tab, read the push, and
  ask again.
- Use a key with a spend limit at the provider, kept for this workflow alone. A
  leaked key then costs at most that limit, and you can revoke it without
  touching anything else.
- Set `limit` as well. It stops one review, and does nothing about a leaked key
  used elsewhere.

## Cost and time

- **Every run is a full review on your key.** A re-run, a new push under the
  `push` recipe and a second `/qcr` each pay again. The Action keeps no state
  between runs, so it has no "nothing new" shortcut.
- **No cap unless you set `limit`.** With a limit, the run stops at that spend
  and posts nothing.
- **A cancelled run still cost what it spent.** With the `push` recipe, the
  installed workflow cancels a review when a newer push to the same pull
  request's branch starts one. Every other run waits for the review in flight
  and then pays for its own.
- **A skip costs nothing but a runner start.** The gate runs before the image
  is pulled.
- **A review takes many minutes.** Its own limit is 60 minutes, plus the fetch
  and the post, so the workflow's job timeout is `timeout-minutes: 90`. A
  shorter one can stop a review after it has spent. What a review cost on the
  benchmarks is in [BENCHMARKS.md](../BENCHMARKS.md).

## Any provider's key

The Action has no input per provider. It forwards to the review, by name only,
every environment variable pi reads a model credential from, so a key is set
with the workflow's own `env:` on the step:

```yaml
- uses: quickchatai/quickreview@v1
  env:
    XAI_API_KEY: ${{ secrets.XAI }}
  with:
    model: xai/<model id> # optional: the default is the provider's newest
```

The names are pi's own, one list for every built-in provider
(`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `OPENROUTER_API_KEY`,
`AWS_ACCESS_KEY_ID` with `AWS_SECRET_ACCESS_KEY`, and so on). The list is the
block between `# BEGIN pi model env names` and `# END pi model env names` in
[`scripts/action.sh`](../scripts/action.sh), generated from the pi the image
pins by `scripts/model-env-names.mjs`. Only the name is put on the docker
command line; docker reads the value from the step's environment.

- **A name that is not in the list** (a provider's extra setting, or the key
  of a provider you defined in a `models.json`): name it in `QCR_MODEL_ENV`,
  separated by commas, in the same `env:`. A name that starts with `GH_`,
  `GITHUB_`, `QCR_`, `PI_`, `OPENVIKING_` or `GIT_` is refused, and so is one
  with `TOKEN`, `SECRET` or `PASSWORD` in it that is not one of pi's own.
- **Amazon Bedrock on temporary credentials** (what
  `aws-actions/configure-aws-credentials` exports): `AWS_SESSION_TOKEN` is
  forwarded beside the key pair, with no setting of yours. The region is not
  a credential: put `AWS_REGION` in `QCR_MODEL_ENV`.
- **A name that points at the runner** is never forwarded: a profile name
  (`*_PROFILE`), a file path (`*_FILE`), or any value that is the absolute
  path of a file on the runner, such as `GOOGLE_APPLICATION_CREDENTIALS`. The
  container has neither the profile nor the file, and pi would count the
  provider as credentialed on the name alone. Use a key, or a login given as
  `pi-auth`.
- **The four key inputs** (`openai-api-key`, `anthropic-api-key`,
  `gemini-api-key`, `digitalocean-api-key`) are the same route under older
  names and stay. pi has no built-in provider for `DIGITALOCEAN_API_KEY`: the
  login given as `pi-auth` must define one in its `models.json`.
- **`model`** takes what `qcr review --model` takes: `provider/model`, with an
  optional `:level`. With no `model`, and credentials for more than one
  provider, the review says which one it picked.

**A login instead of a key.** Copy the contents of a `~/.pi/agent/auth.json`
that holds the login into a repository secret and pass it as `pi-auth`. The
engine works from a copy with refresh disabled and refuses a login that would
expire mid-run, so log in again when the secret ages out. A key suits CI
better: it does not expire, and GitHub advises against a JSON blob as a secret.

## A private mirror

An image that is not public, named by the `image` input, needs a token that can
read it as the `registry-token` input: a token with the `read:packages` scope
and nothing else, as a repository secret, or `${{ github.token }}` with
`permissions: packages: read` once the package grants the repository the Read
role under **Manage Actions access**. That token is used for `docker login` and
for the preflight, and the review never sees it.

The release image (`ghcr.io/<owner>/<name>:<version>`, the version being
package.json's at the Action's ref) is public: the Action pulls it anonymously,
so your repository needs no package access, no `packages: read` permission and
no registry secret.

## What the Action does

`action.yml` is a composite. It first checks that the runner is Linux and has
docker; every step after that is a verb of
[`scripts/action.sh`](../scripts/action.sh):

1. **gate.** Decides whether to review, before the image is pulled and before
   anything is spent. It only reads from GitHub. In order:
   - **Which pull request:** the `pr` input, else the event's pull request
     (a `pull_request*` event, or a comment on a pull request). A comment on
     an issue is skipped. An event that names no pull request fails.
   - **Who started it:** [Who can start a review](#who-can-start-a-review).
   - **The pull request's state:** closed or merged is skipped, and one that
     is not found fails. A draft is reviewed: filter drafts in your `if:` when
     you want to (the `push` recipe does).
   - **A model credential:** none in the step's `env:` or the inputs fails,
     with a pointer to [Any provider's key](#any-providers-key). On a
     `pull_request` event for a fork's pull request it is a skip instead,
     because GitHub gave the run no secrets.

   A skip exits 0 with a notice and a line in the job summary. A
   misconfiguration fails the step with an error.
2. **preflight.** Asks the registry whether the image's manifest can be read,
   the way docker will pull it: anonymously, or with `registry-token` when one is
   given. On a refusal it fails before anything runs: anonymously that most
   likely means the tag is not published, and the message also names the
   private-mirror route. A registry that does not answer is only a warning:
   docker's own pull then reports.
3. **login.** Only with `registry-token`: `docker login` into a docker config of
   its own under `$RUNNER_TEMP`, with the password on stdin. Without one it only
   stages that docker config, empty, so the pull is anonymous even on a runner
   that holds logins of its own.
4. **run.** One throwaway container of the pinned image:
   `review <pr> --repo <owner/name> --to pr,terminal,json`, with
   `--to terminal,json` when `post` is `"false"` and `--profile NAME` when a
   profile is set. The container is the sandbox: no `docker.sock`,
   `--cap-drop ALL`, `no-new-privileges`, the model's tools under another uid.
   It gets the workspace read-only, a generated config, the pi login
   read-only, `QCR_ROUTE=action`, and the model credentials of the step's
   environment by name. The log shows the review's progress. The result's
   JSON line goes to the outputs and the job summary instead of the log.
5. **cleanup.** Runs even when a step failed. It removes the staging
   directory, any docker login and the captured output included.

**The token never enters the container's environment.** The GitHub token is
written to a `0600` file in a fresh `0700` directory under `$RUNNER_TEMP`, mounted
at `/run/qcr-in` and named in `QCR_GH_TOKEN_FILE`; the image reads it once and
unlinks it before any model tool exists. `scripts/action.sh` refuses to
start docker if the token, an env file, a network or a memory service is in the
command line, or if an environment name with `TOKEN`, `SECRET` or `PASSWORD` in
it is forwarded that is not one of pi's own model names.

**The generated config.** It is the image's `config.example.toml` with two lines
changed: `dry_run = false`, because the Action is a live reviewer on the
repository that installed it (the post still goes through the one
`MutationGate`, with this config's `dry_run`), and `[openviking] enabled = false`,
because there is no memory in the Action. `scripts/action.sh` finds both lines
exactly once, or fails.

**No memory, no state.** The runner is fresh each time, and the review keeps
its state inside the throwaway container. A review posts only findings the pull request does not already
carry, found by the hidden markers on earlier comments, which is what keeps a
second run from repeating the first. Nothing else carries over: the second run
is a full review too.

## Pinning by SHA

An organization can require every action to be pinned to a full-length commit
SHA. Then pin the commit of a release tag, with the version in a comment so
Dependabot can propose the next one:

```yaml
- uses: quickchatai/quickreview@<full commit SHA> # vX.Y.Z
  env:
    ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

The release tags are annotated, so ask for the commit they point at:

```sh
git ls-remote https://github.com/quickchatai/quickreview 'refs/tags/vX.Y.Z^{}'
```

Pin a release's commit, never any commit of `main`. The Action runs the image
whose version is `package.json`'s at the pinned commit, and only a release's
version is on ghcr.

## For maintainers: releasing the Action

The Action ships from this repository with every release. Two steps are done
by hand after a `vX.Y.Z` release.

1. **Move `v1`.** Wait until the release workflow's `publish` job has pushed
   that version's image to ghcr. Then a repository admin moves the tag (the
   `release tags` ruleset lets no one else move a `v*` tag):

   ```sh
   git tag -f v1 vX.Y.Z^{commit} && git push -f origin refs/tags/v1
   ```

   Pushing `v1` starts no workflow. Moved before the image is on ghcr, every
   workflow on `@v1` would fail at the preflight. `v1` never gets a GitHub
   release of its own, so it stays a plain tag that can move. A change that
   breaks an existing workflow (an input
   removed, or one whose meaning changes) goes out as a new major tag, `v2`.
2. **List it on the Marketplace.** Edit the `vX.Y.Z` release on GitHub (the
   release workflow created it), tick "Publish this Action to the GitHub
   Marketplace", accept the Marketplace Developer Agreement with 2FA if GitHub
   asks, and pick the categories Code review and AI Assisted. The listing's
   name is `action.yml`'s `name:`, "QuickReview AI Code Review". Plain
   "QuickReview" is refused, because a GitHub user account of that name
   exists.
