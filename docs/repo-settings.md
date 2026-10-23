# Repository settings — how the public repo is locked down

The contribution process ([CONTRIBUTING.md](../CONTRIBUTING.md)) is held by
three things: GitHub settings, the PR intake workflow, and the shape of CI.
This page is for maintainers: what each one does, which settings a script
applies and which stay manual, and what to check before approving a fork's
CI run.

## What protects what

| Concern | Held by |
|---|---|
| Outside code never runs on the paid runners | `ci.yml`: a PR from a fork runs on GitHub's hosted runners (free for a public repo), and Blacksmith's builder step is skipped for it |
| No CI minute is spent before a maintainer looks | Actions setting "Require approval for all external contributors": a fork's workflow run waits for a maintainer's approval |
| Every PR is a draft until it is complete | `pr-intake.yml` converts a PR opened as ready into a draft; `ci.yml` runs nothing for a draft, and is triggered only by `ready_for_review` and later pushes |
| An outside PR links an open issue and carries its self-review | `pr-intake.yml`: a PR marked ready without both goes back to draft, with one comment naming what is missing |
| Contributions come from forks | Outsiders cannot push branches here; forking is on |
| One contributor cannot flood the queue | The open-PR limit for users without write access (manual, below) |
| `main` cannot be rewritten or merged into unreviewed | The `main` ruleset: no deletion, no force push, squash-merged PRs with one approval and green CI; repository admins bypass it |
| A leaked workflow token can do little | Default workflow token is read-only; Actions cannot approve PRs |
| No one but an admin starts a release | The `release tags` ruleset: only repository admins create, move or delete a `v*` tag. Every org member can push to this repo, and a tag push runs `release.yml` |
| The release's model login stays put | The `release-e2e` environment (`RELEASE_E2E_PI_AUTH`) deploys only from `main` or a `v*.*.*` tag, after the admin who ran the script approves. A real release cannot publish without its e2e, so that approval gates every publish |

## Applying the settings

[`.github/repo-settings.sh`](../.github/repo-settings.sh) applies everything
the API can set, as a repository admin with `gh`:

```sh
.github/repo-settings.sh                 # prints every call, changes nothing
.github/repo-settings.sh --apply         # makes them
```

It refuses a repository that is not public, because the fork-PR approval
policy and private vulnerability reporting exist only on a public one. Run it
right after the repository goes public, and again whenever this page changes;
every call sets a value, so a second run changes nothing.

It sets: squash-only merging (PR title as the commit title, the commits as
its body, never the PR body, which holds the pasted review), branch deletion
on merge, forking on, the wiki off, secret scanning and push protection,
private vulnerability reporting (what [SECURITY.md](../SECURITY.md) points
at), Dependabot alerts, the read-only workflow token, no PR approval by
Actions, fork-PR approval for all external contributors, the `main` and
`release tags` rulesets, the `release-e2e` environment's reviewer (the admin
running the script) and deployment policy, and the `proposal` label the issue
form applies.

The ruleset's required checks are the CI job names as GitHub reports them:
`test (26)`, `pi-range (1.4.0)`, `image`, `clone`. A change to a job name or
a matrix value in `ci.yml` changes the check's name: update the script in the
same PR, or every PR waits for a check that never comes.

## Manual settings

The API has no call for these, or they are a judgement per occasion:

- **Open-PR limit** (Settings → General → Pull requests): the limit of open
  PRs per user without write access. Set it to 2. A trusted regular
  contributor goes on the bypass list rather than getting write access.
- **Who may open PRs** (Settings → General → Features → Pull requests): stays
  at everyone. "Collaborators only" would close fork PRs to outsiders
  entirely, because opening a PR needs write access; it is the lever for a
  flood, not the normal state.
- **Interaction limits** (Settings → Moderation options): the emergency
  brake. A temporary limit (up to six months) to existing users, prior
  contributors or collaborators, for issues, comments and PRs alike.
- **Blacksmith**: the Blacksmith app should serve this repository's own
  pushes and maintainers' PRs only. If its dashboard can refuse jobs from
  fork PRs, turn that on as a second wall behind the runner choice in
  `ci.yml`.

## Before approving a fork's CI run

A `pull_request` run uses the workflow files from the PR itself. A fork can
edit `ci.yml` to ask for a paid runner, print what it can reach or run
anything else, and approving the run approves that. So before you click
"Approve and run":

1. Read the diff of `.github/`, `package.json`, `package-lock.json`, every
   script the suite or the build runs (`scripts/`, `.github/ci/`), and any
   new test that spawns a process. A change there needs a reason in the PR.
2. Check that the runner expressions in `ci.yml` are unchanged.
3. Approve only the latest push; a later push waits for approval again.

`pr-intake.yml` is the one workflow that runs on a fork's PR without
approval. It can, because `pull_request_target` runs the version on `main`,
never the PR's, and the script reads the PR's text without ever checking out
or running its code. A change to `pr-intake.yml` that adds a checkout, a
`run` that interpolates `${{ github.event... }}` text, or a call to a script
from the tree breaks that; refuse it.

## Not yet seen working

These are written against GitHub's documented behaviour and have not run on
a fork PR yet. Check them with a test PR from a personal fork after the
repository goes public:

- `gh pr ready --undo` (GraphQL `convertPullRequestToDraft`) with the
  workflow's own token, on a fork's PR.
- A fork's CI run landing on `ubuntu-latest` and waiting for approval.
- The intake comment edited in place on a second edit, not posted twice.
