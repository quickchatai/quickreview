# GitHub App setup — zero to a configured App

quickreviewd authenticates as a **GitHub App** you register yourself: the daemon
mints a short-lived App JWT from the App's private key, exchanges it for an
installation token, reads the PR through that token, and posts every mutation
through its single gated path. No personal access token is ever used, anywhere.

This guide takes you from nothing to a working App. Everything the App needs —
permissions and webhook events — is declared in
[`deploy/github-app-manifest.json`](../deploy/github-app-manifest.json), which
is derived from the code and kept in sync by
`tests/github-app-manifest.test.ts` (the manifest's event list must equal the
webhook handler's accepted set, and its write grants must cover every gated
mutation kind). Trust the manifest over any hand-written list, including the
tables below if they ever disagree.

## 1. Create the App

Register under your **organization** (Settings → Developer settings → GitHub
Apps → New GitHub App under the org) rather than a personal account when the
reviewed repo is an org repo — the org-permission `members: read` (needed for
the review-team trigger) only means something there.

### Route A — from the manifest (fastest)

GitHub's [manifest flow](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest)
creates the App from a JSON blob and hands back the App ID, private key and
webhook secret in one exchange.

> **`qcr onboard` does all of this for you.** The wizard's GitHub App
> step serves the page below on your own machine, submits *this* manifest file
> (never a copy), receives the code on a loopback callback, exchanges it, and
> writes `app_id` / `app.pem` / `webhook_secret` into the secrets dir with the
> same validation and `0600` permissions as `deploy/collect-secrets.sh` — so no
> credential passes through your clipboard. It then guides the install click,
> verifies it through the App's own installation listing and the repo's
> presence among the selected repositories, and creates the trigger labels
> (§7). Re-running the step never creates a second App: with valid credentials
> already in place it verifies the existing one. A rejected code exchange is
> not a lost App either — manifest codes are single-use and expire an hour
> after GitHub issues them, and the step simply serves a fresh page. See
> [onboarding.md](onboarding.md). The steps below are the manual equivalent;
> they must stay in step with the wizard, and drift between the two is a bug.

Manually:

1. Edit `deploy/github-app-manifest.json`: set `name` (your App's name — the
   **slug** is derived from it), `url` (any homepage), and
   `hook_attributes.url` to your public webhook endpoint (see §3; the path
   must stay `/webhook`). The `redirect_url` can be any URL you control, even
   `http://127.0.0.1:...` — it only receives a one-time code.
2. Submit the manifest as a form POST. Save this as `create-app.html`, open it
   in a browser while logged in to GitHub, and click the button:

   ```html
   <form action="https://github.com/organizations/YOUR-ORG/settings/apps/new" method="post">
     <input type="hidden" name="manifest" id="manifest"><input type="submit" value="Create App">
   </form>
   <script>
     fetch("github-app-manifest.json").then(r => r.text())
       .then(t => document.getElementById("manifest").value = t);
   </script>
   ```

   (For a personal-account App the action is `https://github.com/settings/apps/new`.)
3. GitHub redirects to your `redirect_url` with `?code=...`. Exchange it
   within one hour:

   ```sh
   curl -sX POST https://api.github.com/app-manifests/CODE/conversions
   ```

   The response contains `id` (the App ID), `slug`, `pem` (the private key),
   and `webhook_secret`. Save them per §5 — this is the only time GitHub shows
   you the webhook secret it generated.

### Route B — manual

New GitHub App → fill in name, homepage URL, webhook URL (§3) and webhook
secret (§4), disable "Expire user authorization tokens" concerns by leaving
OAuth features off (the daemon never acts on behalf of a user), then set
exactly these permissions and events:

**Repository permissions**

| Permission | Access | Why the code needs it |
|---|---|---|
| Pull requests | Read & write | Reads: PR metadata, files, reviews, review comments, requested reviewers (`src/github.ts` `getPr`/`listPrFiles`/`listReviews*`/`getRequestedReviewers`, staleness GraphQL). Writes: post reviews (`create_review`, `scripts/post-review.sh`/`approve-pr.sh`), reply in threads (`create_review_comment_reply`, `scripts/reply-thread.sh`), resolve its own threads (GraphQL `resolveReviewThread`), clear the team review request (`delete_team_review_request`), open improvement PRs (`create_pull`), and — only when you switch the optional `[escalation]` feature on — request a review from a login you configured (`request_reviewer`, `POST` on the same `requested_reviewers` route as the DELETE above; **it needs no additional permission**). |
| Issues | Read & write | Reads: top-level PR conversation comments (`listIssueComments` — the issues API is where GitHub keeps them), issue search. Writes: add/remove the trigger and status labels (`add_label`/`remove_label` — label endpoints live on the issues API), file bot issues (`create_issue`). |
| Contents | Read & write | Reads: `git fetch`/clone of the PR head and base into the review worktrees, commit compare (`compareFiles`), and the `push` webhook event. Write exists for exactly one thing: pushing `bot/improve-*` improvement branches (`push_branch` in `src/improvements.ts` — the only branch family the system ever pushes). If you never enable improvement PRs, Read suffices. |
| Checks | Read-only | CI evidence for the approve gate: `GET /commits/{ref}/check-runs` (`listChecks`, `scripts/guards.sh` guard 4) and the `check_suite` event. CI is consulted, never triggered. |
| Commit statuses | Read-only | The legacy half of the same CI evidence: `GET /commits/{ref}/status`. |
| Actions | Read-only | Required for delivery of the `workflow_run` event (a post-approval recheck trigger). No Actions REST call is made. |
| Metadata | Read-only | Mandatory for every App. |

**Organization permissions**

| Permission | Access | Why the code needs it |
|---|---|---|
| Members | Read-only | The review-team trigger: the `team-review-requested:` search qualifier (`searchTeamTriggered`), team entries in `GET/DELETE .../requested_reviewers`, and the `requested_team` field in `pull_request` `review_requested` payloads. Without it, team review requests are invisible to the App. Only needed if you configure `[github] review_team`; the label trigger works without it. |

**Subscribe to events** (all seven — the sync test pins this list to the
webhook handler):

`check_suite`, `issue_comment`, `pull_request`, `pull_request_review`,
`pull_request_review_comment`, `push`, `workflow_run`

Set **Where can this GitHub App be installed?** to *Only on this account*.

## 2. Download the private key and find the identifiers

On the App's settings page (Settings → Developer settings → GitHub Apps →
your App):

- **App ID** — the number at the top of the page.
- **Private key** — "Private keys" → *Generate a private key*; a `.pem`
  downloads. (Route A already gave you the PEM in the conversion response.)
- **Slug** — the URL-safe name in the settings page URL
  (`.../settings/apps/<slug>`), also `slug` in the conversion response.
- **Bot login** — always `<slug>[bot]`. This is the identity your reviews are
  posted under.

## 3. Webhook URL

The daemon serves `POST /webhook` (and `GET /health`) on the port configured
in `config.toml [server] port` (default `8787`), bound to loopback. The App's
webhook URL must be a public HTTPS endpoint that reaches it, and the path must
be `/webhook`.

Any HTTPS proxy or tunnel works. Four shapes ship ready to use, and the
wizard's ingress step configures whichever you pick — the trade-offs are laid
out in [../docker/README.md](../docker/README.md):

- a Cloudflare **quick tunnel** (no account; the hostname rotates, and the
  daemon re-points the App's own webhook URL when it does — see below);
- **ngrok** (an account, free-tier caps, a stable hostname with a reserved
  domain);
- your own **named Cloudflare tunnel** on your own domain, either as a compose
  sidecar or as the host service the Ansible route installs;
- **no tunnel at all**, with the reconcile poll as the trigger path.

**The rotating-hostname case is handled for you.** Under `config.toml
[ingress] shape = "tunnel-file"` the tunnel sidecar writes its assigned
hostname to a file the daemon watches, and the daemon re-points the App's
webhook URL through a JWT-authed `PATCH /app/hook/config`. That is the one
mutation class that executes even in dry-run — it touches only the App's own
configuration and can never reach the reviewed repo — and it is logged every
time.

Content type: `application/json`. Deliveries are HMAC-verified
(`X-Hub-Signature-256`) and deduplicated on `X-GitHub-Delivery`; GitHub never
retries a failed delivery, so the daemon's reconcile poll is the correctness
backbone either way — a missed webhook delays a review, it never loses one.

## 4. Webhook secret

Generate one and set it on the App's webhook config:

```sh
openssl rand -hex 32
```

(Route A: GitHub generated it for you; it is `webhook_secret` in the
conversion response.)

## 5. Where each value lands

On the guided path, the App step above writes the three credential files
itself, and the interview step writes the three config keys — you do not run
this by hand at all. Doing it manually, run the secrets wizard: it prompts for
whatever is missing, validates, and stores everything `0600` in the secrets dir
(`~/.config/qcr/<install>/secrets` by default — `qcr install where`; in-container `/opt/quickreview/secrets`):

```sh
bash deploy/collect-secrets.sh
```

| Value from GitHub | Secrets-dir file | Config key |
|---|---|---|
| App ID (number) | `app_id` | — |
| Private key (PEM) | `app.pem` | — |
| Webhook secret | `webhook_secret` | — |
| App slug | — | `config.toml [github] app_slug` |
| Bot login (`<slug>[bot]`) | — | `config.toml [github] bot_login` |
| Reviewed repo (`owner/name`) | — | `config.toml [github] repo` |

The secrets wizard also asks for the deployment shape (§3): the tunnel shape
additionally requires `tunnel_token`; the plain-Docker shape does not. On the
guided path the ingress step decides that instead, and checks the credential
file the shape you chose needs. `openai_api_key` and the OpenViking memory keys
are separate concerns — see [`docs/llm-setup.md`](llm-setup.md) and
[`docs/onboarding.md`](onboarding.md#60-and-72--memory-in-two-phases).

## 6. Install the App on the reviewed repo

App settings → *Install App* → your account/org → **Only select
repositories** → the repo named in `config.toml [github] repo`. The daemon
resolves the installation automatically (`GET /app/installations`), so no
installation ID needs configuring.

## 7. Repo-side prerequisites

Reviews are triggered per-PR, never automatically on open. Two triggers exist,
either is enough:

- **Label** — create the label named by `config.toml [github] trigger_label`
  in the reviewed repo (also `in_progress_label` and `reviewed_label`, which
  the daemon applies as status markers, and `improvement_label` /
  `issue_label` if you enable improvement PRs / bot-filed issues).
- **Team review request** — create the team named by `[github] review_team`
  (`org/slug` form) and request a review from it on a PR. Requires the
  Members read permission above — which, on an organization, an owner must
  approve. That approval is **deferrable and nothing blocks on it**: the label
  trigger works fully without it, and `[github] review_team` may stay empty.

The App step creates the three shipped-default labels for you, and leaves an
existing label of the same name exactly as it is — colour and description
included:

| role | config key | name | colour |
|---|---|---|---|
| trigger | `trigger_label` | `AI review requested` | blue |
| in progress | `in_progress_label` | `AI review in progress` | yellow |
| reviewed | `reviewed_label` | `Automatic Review` | green |

## 8. Verify

The wizard's verification step runs these in layers and stops at the first red
one, because nothing later means anything until it is fixed. By hand:

1. `scripts/mint-token.sh` prints an installation token — the App JWT →
   installation-token exchange works.
2. The daemon container is running.
3. `GET /health` on the daemon answers `{"ok":true,...}`.
4. The App settings' *Advanced* tab shows a green `ping` delivery to your
   webhook URL (use *Redeliver* after fixing anything). A 401 or 403 there
   means the webhook secret on GitHub is not the one in your secrets dir; a
   timeout means your ingress is not reaching the daemon. On a rotating
   tunnel, give the daemon a few seconds after start-up to re-point the URL
   before judging a stale one.
5. Label a test PR with the trigger label; the daemon logs the delivery and
   queues the PR.
