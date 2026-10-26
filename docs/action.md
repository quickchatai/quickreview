# The GitHub Action

`uses: quickchatai/quickreview@v1` reviews a pull request and posts the findings
as one comment-only review.

## Set up once

The image (`ghcr.io/<owner>/<name>:<version>`, the version being package.json's
at the action's ref) is a public package: the action pulls it anonymously, so
the repository needs no package access, no `packages: read` permission and no
registry secret.

1. **Give it a model.** The default models log in through ChatGPT OAuth: copy the
   contents of a `~/.pi/agent/auth.json` that holds that login into a repository
   secret (`QCR_PI_AUTH` in the template) and pass it as `pi-auth`. The engine
   works from a copy with refresh disabled and refuses a login that would expire
   mid-run, so log in again when the secret ages out. Or pass a model API key
   (`openai-api-key`, `anthropic-api-key`, `gemini-api-key`,
   `digitalocean-api-key`) when the config's models are on that provider.
2. **Copy the workflow.** [`docs/action/qcr-review.yml`](action/qcr-review.yml) to
   `.github/workflows/qcr-review.yml`.

## When it runs

The template reviews every push to a pull request (`opened`, `synchronize`,
`ready_for_review`). It skips drafts and pull requests from forks, and a newer
run for the same pull request cancels the one in flight (a concurrency group per
pull request).

**Request-only.** Set the repository variable `QCR_REQUEST_ONLY` to `true` and the
push events review nothing; a review starts when someone adds the label
`qcr-review` or comments `/qcr` on the pull request (members, owners and
collaborators). Both also work in the every-push mode.

**No cost cap.** Nothing limits a review unless the `limit` input (US dollars) is
set; then the run stops hard at that limit. Nothing is ever asked.

**A private mirror.** An image that is not public, named by the `image` input,
needs a token that can read it as the `registry-token` input: a token with the
`read:packages` scope and nothing else, as a repository secret, or
`${{ github.token }}` with `permissions: packages: read` once the package grants
the repository the Read role under **Manage Actions access**. That token is used
for `docker login` and for the preflight, and the review never sees it.

## What the action does

`action.yml` is a composite whose steps are the verbs of
[`scripts/action.sh`](../scripts/action.sh):

1. **preflight.** Asks the registry whether the image's manifest can be read,
   the way docker will pull it: anonymously, or with `registry-token` when one is
   given. On a refusal it fails before anything runs: anonymously that most
   likely means the tag is not published, and the message also names the
   private-mirror route. A registry that does not answer is only a warning:
   docker's own pull then reports.
2. **login.** Only with `registry-token`: `docker login` into a docker config of
   its own under `$RUNNER_TEMP`, with the password on stdin. Without one it does
   nothing.
3. **run.** One throwaway container of the pinned image:
   `review <pr> --repo <owner/name> --to pr,terminal`. The container is the
   sandbox: no `docker.sock`, `--cap-drop ALL`, `no-new-privileges`, the model's
   tools under another uid. It gets the checkout read-only, a generated config,
   the pi login read-only, and `QCR_ROUTE=action`.
4. **cleanup.** Removes the staging directory, any docker login included.

**The token never enters the container's environment.** The GitHub token is
written to a `0600` file in a fresh `0700` directory under `$RUNNER_TEMP`, mounted
at `/run/qcr-in` and named in `QCR_GH_TOKEN_FILE`; the image reads it once and
unlinks it before any model tool exists. `scripts/action.sh` refuses to
start docker if the token, an env file, a network or a memory service is in the
command line.

**The generated config.** It is the image's `config.example.toml` with two lines
changed: `dry_run = false`, because the Action is a live reviewer on the
repository that installed it (the post still goes through the one
`MutationGate`, with this config's `dry_run`), and `[openviking] enabled = false`,
because there is no memory in the Action. `scripts/action.sh` finds both lines
exactly once, or fails.

**State.** The runner is fresh each time, so the review state volume is too. A
review posts only findings the pull request does not already carry (their hidden
markers), which is what keeps a second run from repeating the first.
