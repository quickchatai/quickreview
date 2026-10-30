# The gate and the boundaries

The reviewer is an LLM driving a terminal inside a container that holds a
GitHub credential: a GitHub App's by default, or under `[github] auth = "user"`
the operator's own token (see "The credential" below). Nothing about that
arrangement is safe on its own. What
makes it safe is a small number of **deterministic boundaries written in
plain code**, each of which the model cannot reason its way past because the
model is not asked.

This page is the inventory. For each boundary it says where the code is, what
it **guarantees**, and — as importantly — what it does **not**. A boundary
whose limits are unstated is a boundary people trust further than it goes.

## Where to look

| Boundary | Code | Tests |
|---|---|---|
| The credential seam | `packages/pi-plugin/src/githubAuth.ts`, `packages/pi-plugin/src/identity.ts` | `tests/githubAuth.test.ts`, `tests/identity.test.ts`, `tests/review-pr-target.test.ts` |
| The one mutation gate | `packages/pi-plugin/src/gate.ts` | `tests/gate.test.ts`, `tests/fences-gate.test.ts` |
| Posting-time guards 1–5 | `packages/pi-plugin/src/guards.ts` | `tests/guards.test.ts`, `tests/fences-guards.test.ts` |
| The CI gate | `packages/pi-plugin/src/cigate.ts` | `tests/cigate.test.ts`, `tests/fences-cigate.test.ts` |
| Shell mirror of the guards | `scripts/guards.sh` | `tests/guards-shell-*.test.ts` |
| Session posting routes | `scripts/post-review.sh`, `scripts/approve-pr.sh`, `scripts/reply-thread.sh` | `tests/guards-shell-*.test.ts` |
| Exec boundary (5 layers) | `packages/pi-plugin/extensions/bash-guard.ts`, `src/execboundary.ts` | `tests/bash-guard.test.ts`, `tests/exec-boundary.test.ts` |
| Migration collision pre-check | `packages/pi-plugin/src/migrations.ts`, `src/dispatch.ts` | `tests/migrations.test.ts`, `tests/migration-precheck.test.ts` |
| Severity → tag, reachability gate | `packages/pi-plugin/src/severity.ts` | `tests/severity.test.ts`, `tests/fences-severity.test.ts` |
| Improvement-channel caps | `src/improvements.ts` | `tests/improvements.test.ts`, `tests/improvements-e2e.test.ts` |
| Drain / pause levers | `src/levers.ts`, `src/commands.ts` | `tests/levers.test.ts`, `tests/commands.test.ts` |

Related pages: [the exec boundary in full](../exec-boundary.md),
[the single-shepherd invariant](../single-shepherd-invariant.md),
[owner-only surfaces](../ownership.md).

---

## 0. The credential

**`packages/pi-plugin/src/githubAuth.ts`.** The adapter (`src/github.ts`)
authenticates through one seam, `GitHubCredential`, which has exactly two
implementations, picked by `[github] auth`:

- **`"app"`** (the default; a missing key means it): `TokenMinter`, App JWT →
  installation token. This is the only route that takes webhooks.
- **`"user"`**: `UserTokenSource`, the operator's own token. Owner ruling
  2026-10-24, amending hard rule 3: the daemon may run on the person's own
  credential instead of an App. The token is read from the **file**
  `<secrets dir>/github_token` (0600, the token alone, rewritten atomically by
  the host-side `qcr github-token sync`). It is read on first use, every five
  minutes, and after a 401. It is never read from the environment or a
  command line. The git credential helper (`scripts/mint-token.sh`) prints the
  same file.

What `"user"` changes, and what it does not:

- **Polling only.** Config load refuses any `[ingress] shape` but
  `"polling"`. Under it, `/webhook` refuses every delivery unread and no
  webhook secret is read. The reconcile poll is the only trigger.
- **No App.** The credential has no JWT, so the adapter refuses the App's own
  routes (hook deliveries, hook config, the self-heal's re-point) before
  sending anything.
- **The same gate.** Every mutation still goes through §1 and its guards.
- **Every review is a COMMENT.** The posting guard's last step rewrites
  APPROVE / REQUEST_CHANGES to COMMENT and states the verdict in the body,
  and the REST executor refuses any other event on the person's account. The
  verdict is still decided on the merits and recorded as decided. The posting
  receipt carries `person_mode`, so an APPROVE posted as a COMMENT never reads
  as guard 4's withheld approval.
- **"Ours" is the marker.** The login is the person's, so the reviewer's own
  reviews and comments are recognised by its hidden `<!-- qcr… -->` markers
  or its footer, not by the login (`identity.ts`). A comment the person typed
  is a human comment, and their own PRs are reviewed, not skipped as a bot's.

### Not guaranteed

- The token is the person's, with whatever scope they gave it. Nothing
  down-scopes it, and the companion's copy of it is not read-only: in this
  mode the companion guard's write veto is the companion's only fence.
- §5's outcome detector sees only marker-bearing reviews here. A write
  outside the gate that carries no marker looks like the person's own review.

---

## 1. The mutation gate

**`packages/pi-plugin/src/gate.ts`.** Every write to GitHub — REST, GraphQL or `git push` — is
described as a `MutationIntent` and passed to `MutationGate.execute()`. Reads
are not gated and go direct through the adapter (`src/github.ts`); a read
changes nothing.

### The closed set of kinds

`MutationKind` is a union, and `MUTATION_KINDS` is the same set as a runtime
array. The union alone stops only honest call sites — it is erased at
compile time, so a hand-rolled intent or one crossing a JSON boundary would
pass it. Admission checks the runtime array **first**, before the dry-run
branch, so an unknown kind is neither executed nor even recorded as a would-be
call.

The set contains no kind that dismisses a review. `supersede_own_review` is the
one review-mutating kind that exists, and it has **zero callers** in `src/` or
`scripts/` — `tests/fences-gate.test.ts` fails if one appears. So a dismissal
is not representable, and even the one adjacent capability is not reachable.

### Dry-run

When `dry_run = true` (the shipped default in `config.example.toml`), the gate
writes the intent as JSON into `state/dryrun/` and returns
`{ executed: false, dryRunFile }` instead of calling the executor. The dry-run
branch sits **after** the guards, so a mutation a guard refuses is neither
executed nor recorded — the dry-run record shows the behaviour the live path
would have had, not a superset of it.

Two exemptions, both narrow:

- **`forceLive`** — an intent field that executes despite dry-run. Admission
  throws for every kind except `supersede_own_review`, which has no caller. So
  the bypass is presently unreachable, and it cannot widen without failing a
  test.
- **`APP_SELF_CONFIG_KINDS`** — mutations touching only the App's own
  configuration, which can never reach the reviewed repo. It is a closed set of
  exactly one kind, `update_own_webhook_url` (a JWT-authed `PATCH
  /app/hook/config`, driven by `src/webhookheal.ts`), pinned by deep equality
  in `tests/gate.test.ts`. It executes for real in dry-run and logs a loud line
  every time. `forceLive` on it still throws.

### What a guard may change

Guards are installed on the gate (`MutationGuard`), not on call sites. A guard
answers `{}` (no opinion), `{ block: reason }` (refuse), or
`{ intent }` (a rewrite).

The rewrite is bounded to `GUARD_REWRITABLE_FIELDS = ["body", "note"]` — the
payload and the log line. Everything else is the mutation's **identity**:
`kind` selects the gate's policy, `method` + `path` are what the executor
sends, `pr` is what the after-hooks stamp, and `reviewPurpose` and `forceLive`
each buy an exemption. The mechanics:

1. `execute` reads the caller's object exactly once into a frozen `snapshot`
   with its own `structuredClone`d `body`, and admits **that**.
2. The guard is handed the snapshot. An in-place assignment to a top-level
   field throws (strict-mode ESM); an edit inside `body` lands on the copy.
3. Whatever comes back is snapshotted again — so a getter on any field is read
   once and cannot answer the check one way and the executor another.
4. `guardRewriteCheck` compares the two over every own key (string and symbol),
   and `admit` runs **again in full** on the copy that will execute.

Every `MutationIntent` field is `readonly`, so a guard that assigns rather than
returning a spread does not compile.

### `reviewPurpose`

A `reviewPurpose` marks a review the daemon composed itself rather than the
session — `"migration_precheck"` or `"escalation"`. It buys two exemptions
(the review never claims the head; the escalation purpose alone skips guard 2),
so admission refuses any purposed intent that is not a `create_review` with
`event: "COMMENT"` — checked on entry and again on the post-guard copy.

### Git pushes

A `method: "git"` intent carries a `GitPerformer` closure, because only the
caller knows which clone to push in. The **gate**, not the call site, decides
whether it runs: admission refuses a performer on any method but `"git"` and
any kind but `push_branch`, and re-checks both after the guard step.

### Guarantees

- No `MutationKind` outside `MUTATION_KINDS` executes or is recorded.
- No kind dismisses a review or another identity's review; the one
  review-mutating kind has no caller.
- In dry-run, nothing but the one app-self-config kind reaches GitHub.
- A guard can refuse or rewrite `body`/`note`. It cannot change which mutation
  runs, and it cannot grant itself an exemption.

### Not guaranteed

- The gate is not a permission boundary. Sessions run as the same uid as the
  daemon and could in principle reach the credential; what stops them is the
  exec boundary (§5), which is explicitly not closed.
- The gate binds the **daemon's** route. Sessions post through the shell
  scripts, which do not call it — see §4.

---

## 2. Posting-time guards

**`packages/pi-plugin/src/guards.ts`,** installed on the one gate as a `MutationGuard`. Five
refusals, each fired seconds before a review reaches GitHub, on the mutation
kinds in `POSTING_KINDS` (`create_review`, `create_review_comment_reply`,
`create_issue_comment`). Guard 3 binds all three; the other four bind
`create_review` only.

| # | Condition | Effect | Knob (`[guards]`) |
|---|---|---|---|
| 1 | A non-author human's standing `APPROVED` review sits at this head | REQUEST_CHANGES rewritten to COMMENT, findings intact, with a note naming the approver | `downgrade_on_human_approval` |
| 2 | The `reviewed_heads` mark is on this head and no author reply since (an APPROVE and the escalation note are exempt) | Refuse: post nothing | `skip_unchanged_head` |
| 3 | The PR is merged or closed (re-read immediately before the write) | Refuse | `recheck_pr_state_before_post` |
| 4 | CI is not green at this head | APPROVE rewritten to COMMENT with the approval withheld | `block_approve_on_red_ci` |
| 5 | The PR's live head is not the head the review's `commit_id` names | Refuse: the review is stale | `refuse_on_head_drift` |

Ordering matters: 3 runs first (an unreadable PR state **fails closed** and
refuses), then 5, then 2, then 1, then 4. Under `[github] auth = "user"` one
more step runs last, on whatever the five decided. It is not a refusal: a
review that would still post APPROVE or REQUEST_CHANGES posts as a COMMENT
with the verdict stated in its body (§0).

Details worth knowing before editing:

- **Guard 1** reads each person's *latest verdict-bearing* review
  (`humanApprovalAtHead`): a later CHANGES_REQUESTED or DISMISSED retires an
  approval, and COMMENTED/PENDING carry no verdict. A failed review listing
  logs and proceeds — the worst case is the pre-guard behaviour.
- **Guard 2** reads the mark through `packages/pi-plugin/src/standing-review.ts`, the one
  interpretation of `reviewed_heads` for lifecycle decisions, so this guard and
  dispatch's skip cannot disagree. An undecided mark never suppresses a posting.
  A reply timestamp equal to the review's counts as new evidence (`>=`, not
  `>`), because an ambiguous reply reads safely as new.
- **Guard 5** compares shas case-insensitively, matching the shell twin.
- The escalation note (`reviewPurpose: "escalation"`) is exempt from guard 2
  and **only** guard 2 — it carries no verdict and by design lands right after
  the round's own review. Guards 3 and 5 ran before that exemption is reached.
- An **APPROVE** is exempt from guard 2 too, as on the shell route
  (`approve-pr.sh` runs guards 3, 4 and 5 only): the approval that meets an
  already-stamped head is the CI-green retry of a withheld approval, whose
  COMMENT stamped the head. Guard 4 still binds it.
- The **after-step** stamps `reviewed_heads` only for a substantive review that
  really executed. It is keyed on the *presence* of a `reviewPurpose`, not on
  each spelling, so a future mechanical purpose cannot claim a head by being
  forgotten.

### Guarantees

- A guard can only **refuse** a mutation or **soften** REQUEST_CHANGES/APPROVE
  to COMMENT. Nothing here dismisses, retracts or edits an existing review.
- No posting route in the daemon reaches GitHub around them: they are on the
  gate, not on a call site.

### Not guaranteed

- Guards never block on what they cannot see. An unreadable check list or an
  unreadable review list logs and proceeds — failing closed there would turn a
  GitHub outage into a pile of withheld approvals. Guard 3 is the exception and
  fails closed deliberately.
- They bind the gate route. The session route is §4.

---

## 3. The CI gate

**`packages/pi-plugin/src/cigate.ts`** — the classifier both posting routes answer from, plus the
retry that keeps a withheld approval from becoming a stuck PR.

`classifyCi` maps the checks at a head onto four states:

| State | Meaning |
|---|---|
| `green` | every check completed and at least one really succeeded |
| `red` | something completed badly — failure, cancelled, timed out, action_required, stale |
| `pending` | a check is still queued or running |
| `none` | no check reported at this head at all |

`skipped` and `neutral` are inert: they neither make CI green nor make it red.
A suite whose every check is inert is **not** green — there is no evidence the
code passed anything.

`ciBlocksApproval` blocks on `red` and `pending`. It blocks on `none` only when
`no_checks_is_red` is set, which is off by default so a repo with no CI is
never permanently wedged.

**The latest-run rule** (`latestRunPerName`) exists because GitHub auto-cancels
superseded workflow runs and leaves permanent `cancelled` husks. It is keyed on
`CheckSummary.source`, which the adapter (`src/github.ts` `listChecks`) is the
only writer of:

- Only **check-runs** collapse. Among check-runs of one name carrying a
  `started_at`, the latest start wins (equal start → later list position). A
  check-run with no timestamp never competes with a timestamped one in either
  direction; among untimestamped check-runs of a name, the later list position
  wins.
- A **commit status** is never collapsed with anything — not with a check-run
  of its context, not with another status.

Three copies of this rule exist (`latestRunPerName`, `scripts/guards.sh`
`guard_ci_state`, `scripts/pr-checks.sh`); `tests/fences-cigate.test.ts` runs a
differential over the real adapter and the real shell function so they cannot
drift.

**Withholding and retry.** When guard 4 fires, the review still posts — as a
COMMENT with `withheldApprovalNote` appended, saying plainly that no blockers
were found and that approval waits on green CI alone — and
`recordApprovalWithheld` marks the PR. `retryWithheldApproval` runs on the
`ci_completed` webhook: if the mark still stands at that head, the PR is open
and CI now classifies green, the PR is re-queued through the ordinary
dispatch → round → verdict path. **No review is posted from there and no
verdict is invented** — the session decides again, and this time the approval
is available. When it approves at the same head with nothing new since (no
author reply) and nothing inline, over CI guard 4 saw green, the posting guard
gives that approval as one line in place of the session's body
(`givenApproval`): the withheld COMMENT above already carries the review, so
the approval does not repeat it. The footer and the posting marker stay.
Person mode never takes this step: its COMMENTs withheld nothing.

### Guarantees

- Red CI makes APPROVE unavailable regardless of findings, infra failures
  included. There is no prose-argued exception.
- Every noop reason (`head-moved`, `pr-not-open`, `ci-not-green`,
  `ci-unreadable`, …) leaves the withheld mark standing, so the next completion
  or the reconcile sweep tries again.
- Nothing in this module triggers, re-runs or cancels CI. Every call is a GET.

### Not guaranteed

- Unreadable CI is not evidence of red. It never blocks.
- The classifier is only as good as what the two GitHub endpoints report; a
  check that never registers at the head is invisible to it, which is what
  `no_checks_is_red` exists for.

---

## 4. The shell mirror

Review sessions do not call the gate. They post through three scripts, and
`scripts/guards.sh` is the mirror that binds that route.

`guards.sh` is **sourced, never executed**. Its contract with the sourcing
script: `die`, `cfg`, and the variables `API`, `ROOT`, `CONFIG`, `REPO`, `PR`,
`LIVE` must already be defined.

| Script | Mutation | Guards called |
|---|---|---|
| `scripts/post-review.sh` | `POST /pulls/{n}/reviews` — REQUEST_CHANGES or COMMENT (APPROVE is hard-rejected) | 1, 2, 3, 5 |
| `scripts/approve-pr.sh` | approve, then clear both wake triggers (label + team request) | 3, 4, 5 |
| `scripts/reply-thread.sh` | `POST /pulls/{n}/comments/{id}/replies` | 3 |

That coverage table is **derived from the call sites** by
`tests/fences-guards.test.ts`, which numbers the functions from `guards.sh`'s
own section headers and reads the calls out of each script. A guard silently
dropped from a script fails that test.

Behavioural differences from the gate route, all deliberate:

- **Guard 4 refuses rather than softens.** `approve-pr.sh` can only approve, so
  there is nothing to soften into; the refusal message tells the session to
  post the review as a COMMENT through `post-review.sh` with
  `"approval_withheld": true` in its verdict file.
- **Guard 5 warns rather than refuses when it has no expectation.** The session
  exports `QCR_EXPECTED_HEAD` (the sha its round prompt cites); a missing value
  means a session on an older prompt, and wedging those is worse than the drift
  race.
- **Guard 2's refusal leaves evidence.** `post-review.sh` defines
  `guard_on_no_new_evidence`, which `guards.sh` calls before `die`, writing a
  `skipped` posting-receipt record carrying the exact mark the guard read.
  `src/verdicts.ts` then settles the round as a terminal `no_new_evidence`
  rather than a lost posting. A *missing* receipt still fails loud — only the
  exact recorded refusal is a no-op.
- **The dry-run gate is mirrored too.** Each script reads `dry_run` from
  `config.toml` and treats anything other than an explicit `false` as dry-run
  (fail closed), writing the same JSON record shape into `state/dryrun/`.
- **`guard_stamp_reviewed_head`** writes the mark the gate's after-step writes,
  and only after a post that really reached GitHub.

`tests/guards-shell-*.test.ts` runs the real scripts against a loopback stub over
the same cases `tests/guards.test.ts` runs the real gate, so the two halves
stay behaviourally identical rather than claimed identical.

### Not guaranteed

`guard_stamp_reviewed_head` swallows its own failures (`2>/dev/null || true`).
A silently failed stamp presents to the outcome detector (§5) as an unaccounted
review — deliberately, since a broken ledger and an ungated write are both
faults.

---

## 5. The exec boundary

**Full treatment: [docs/exec-boundary.md](../exec-boundary.md).** It is the one
document in this repo written as falsifiable claims, because a green suite has
repeatedly coexisted with a live bypass. Read it before
touching any of the code below; do not treat this section as a substitute.

The shape, so this inventory is complete:

| Layer | Code | Asks |
|---|---|---|
| 1. Config-scope pin | `sessionGitConfigPins`, `src/sessions.ts` | which files can git read config from at all? |
| 2. Command guard | `checkBashCommand`, `packages/pi-plugin/extensions/bash-guard.ts` | is this command string allowed? |
| 3. Write veto | `checkWritePath` / `checkProtectedWrites` / `isProtectedWriteTarget`, same file | may this write target be written? |
| 4. Round-boundary integrity | `fingerprintRoundIntegrity` / `integrityChanges`, `src/execboundary.ts` | did any watched file change during the round? |
| 5. Outcome detection | `auditUngatedReviews`, `src/execboundary.ts` | is there a bot review on GitHub the daemon has no record of posting? |

Two sets are protected, from one definition each so the write veto and the
integrity check cannot drift: **git's configuration surface** (anything inside
a `.git` directory, `.gitconfig`, `<any>/git/config`, `.gitattributes`) and
**this system's own policy surface** — `POLICY_SURFACE_FILES` (`config.toml`
and the agent-directive files such as `AGENTS.md` and `CLAUDE.md`) and
`POLICY_SURFACE_DIRS` (`scripts`, `dist`, `extensions`, `prompts`, `agents`,
`seeds`, `.pi`) in `packages/pi-plugin/extensions/bash-guard.ts`.

The single most important thing to carry away: **layers 2 and 3 read command
strings and are not closed, and are not claimed to be.**
`T=.git/config; cat payload >> $T` is invisible to a command-string scan by
construction. That is why layers 4 and 5 exist, and why the right response to a
newly found bypass of that class is not another spelling in a list.

---

## 6. The migration collision pre-check

**`packages/pi-plugin/src/migrations.ts`** (pure detection and comment text) run from
`src/dispatch.ts` `ecosystemPreCheck`, per round, after the worktree is
prepared and before the session is handed its order.

It answers one deterministic question: does this PR occupy a migration number
the base branch already took at the round's pinned `base_sha`? Nothing else in
the pipeline catches that — GitHub reports MERGEABLE because the filenames
differ, and CI is green. `detectMigrationCollisions` also finds "renamed
dependency" follow-ups: later PR migrations whose `dependencies` reference a
file the remedy renames.

**It is delivered as a gated COMMENT, never a blocker and never a verdict** —
a `create_review` with `event: "COMMENT"` and
`reviewPurpose: "migration_precheck"`, which is why that purpose exists on the
gate (§1) and why the guard after-step will not let it claim the head.
`collisionFingerprint` plus the `migration_collision_comment` event dedupe it.

The ecosystem is selected by the repo profile (`packages/pi-plugin/src/ecosystem.ts`); `none` is a
first-class configured-off — nothing runs, nothing is read, nothing is logged.

**A degraded check is never quieter than no check.** If the PR touches
migrations and the check could not run, three things happen together: the round
prompt renders an explicit "the pre-check did not run — check collisions
yourself" note, that note un-muzzles the withdrawn collision rule in
`pass-data-safety` for exactly that round (`MIGRATION_NUMBERING_ADDENDUM` in
`packages/pi-plugin/src/include.ts`), and an overseer anomaly is raised. A *withheld* comment (the
ledger holds a collision-comment row it cannot read, so a duplicate cannot be
ruled out) is different: the check DID run, so nothing is un-muzzled. The
gate note hands the collisions' remedy to the session, which puts it in its
review body as mechanics — never a finding, never a blocker — and the overseer
anomaly is raised once per PR.

### Not guaranteed

Detection is path-shaped (`…/migrations/NNNN_name.py`) and scoped to one
ecosystem. It does not reason about migration *content*, and a repo whose
migrations are named otherwise is simply not covered.

---

## 7. Severity → tag, and the reachability gate

**`packages/pi-plugin/src/severity.ts`.** `postTag(severity, confidence, reachability)` is the
deterministic map from a finding's fields to the tag it posts under. It is
where the blocker bar lives, and the bar does not move.

Reachability is applied as a gate **before** the severity mapping, and it can
only ever weaken a tag:

| | `routine` (or absent/unrecognised) | `plausible` | `contrived` |
|---|---|---|---|
| **P0**, **P1** | `blocker` | `blocker` | `question` |
| **P2** | `blocker` if confidence ≥ 0.8, else `question` | `question` | `question` |
| **P3** | `question` | `question` | `question` |
| **nit** | `nit` | `nit` | `nit` |

`normalizeReachability` folds any unrecognised value to `routine`, so a pass
that invents one can never accidentally soften a blocker.
`tests/fences-severity.test.ts` walks the whole 5 × 4 × 4 cross-product,
including values the union does not name.

`deriveVerdict` is equally small: any blocker ⇒ REQUEST_CHANGES, else APPROVE.
(`NEEDS_HUMAN` remains accepted on input from older prompts and lands as a
posted review with no approval; no daemon-side criterion produces it.)

### The closed tag grammar

`SANCTIONED_TAGS` is the whole vocabulary: the three posting tags
`[blocker]` / `[question]` / `[nit]`, plus three marker prefixes that route
rather than grade.

| Marker | Means | Resolution |
|---|---|---|
| `[check this]` | a human should verify this before merge | human only — `resolveOwnReviewThread` in `src/github.ts` refuses (`skipped: "check-this-human-only"`) |
| `[ask your human]` | the author's AI implementer must put this to its person, not answer it | author-resolvable once answered, through the ordinary ping-pong path |
| `[deferred]` | the finding is real, this PR is not where it is fixed, the ticket is filed | human only — the same structural refusal |

The grammar is closed because the tag is what downstream machinery keys on: an
invented tag is a finding that escapes its own routing.
`stripUngrammaticalTag` removes a non-sanctioned bracketed prefix from a
finding title and reports it, so the escape shows up in telemetry rather than
on the PR. It cuts the label only — never a word of the finding's reasoning.

Directive provenance (`isFirstPartyDirectivePath`,
`DEFAULT_DIRECTIVE_VOCABULARY`) is also defined here and used by dispatch to
pick the deterministic mention for a PR that edits agent-directive files. The
vocabulary is **extend-only** from `[review.directives]` config: extras add
entries and nothing can remove a built-in.

### Not guaranteed

The map grades what a pass reports. Whether `severity`, `confidence` and
`reachability` are honest is the validator's job, not this module's.

---

## 8. The improvement-channel caps

**`src/improvements.ts`** is the only place in the system that files anything on
GitHub about itself. Every cap is enforced in daemon code, never by prompt: the
overseer can ask, the daemon decides.

**Branch rule.** The only branch this system ever pushes is
`bot/improve-<slug>` (`botBranchFor`). The base branch is fetched and read and
never pushed, never merged into, never checked out for writing. Every git step
runs in the reviewed repo's base clone (`ensureRepoDir`), and `Run` requires a
cwd so a call without one does not compile.

**`fileImprovementPr` order of checks:** slug shape (`SLUG_RE`) → branch shape
(`BRANCH_RE`, which forbids a leading `-`, a `:`, `..`, whitespace and a
`.lock` segment) → rate caps → fetch base → confirm the branch exists as a
local ref → diffstat → gated push → gated `createPull` → label → record.

| Cap | Config key | Shipped example |
|---|---|---|
| Changed lines (adds + deletes) | `caps.improvement_pr_max_lines` | 50 |
| Changed files | `caps.improvement_pr_max_files` | 3 |
| Improvement PRs per day | `caps.improvement_pr_per_day` | 1 |
| Improvement PRs per week | `caps.improvement_pr_per_week` | 3 |
| Issues per day | `caps.issues_per_day` | 3 |
| Forbidden path prefixes | `caps.improvement_pr_deny_prefixes` | migrations, infra, ansible, workflows |

`deniedPath` matches a prefix at the root **or at any depth**, and refuses any
`.env*`-named file unconditionally regardless of the configured list. Binary
files and an empty diff are refused outright.

`usableCap` is the belt under all of it: a cap that is not a finite
non-negative number is a **refusal**, not a pass (`files > undefined` is
`false`, so an unchecked missing cap would pass everything). `parseCaps` also refuses such a config at
startup, and these checks distrust the type they were handed anyway.

`fileIssue` adds title-token Jaccard dedup against open bot-filed issues
(`DEDUP_THRESHOLD = 0.6`). A cap refusal on a PR-attributed issue also writes a
`deferral_ticket_refused` anomaly against that PR — a deferral that produced no
ticket is a deferral that quietly became free again, so the refusal is louder,
never weaker.

The push itself goes through the gate in **both** modes: `ctx.gate.execute`
receives the `push_branch` intent and the performer, and calls the performer
only when the mutation is genuinely to happen. A gate-refused push short-circuits
before the PR is opened, so no PR is ever created against a branch that was not
pushed.

---

## 9. The drain and pause levers

**`src/levers.ts`.** Two levers stop review work: `drain` stops all of it,
`pause-pr` stops one PR's. Both have two possible issuers, and the bound is
entirely different.

| | Operator | Session |
|---|---|---|
| Expiry | optional — may hold until lifted | **always** present |
| Daily budget | none | `session_drain_budget_min_per_day`, `session_pause_budget_min_per_day` |
| Single-hold cap | none | `session_drain_max_min`, `session_pause_max_min` |
| May lift the other's hold | yes | no |

The brace is the type, not a check: `LeverGrant`'s session member declares
`expires_at: string` (never `null`), so **a session hold without an expiry is
unspellable**. `boundSessionGrant` refuses an ask past the cap or past the day's
remaining budget with the number, so the session can ask again smaller; an
omitted duration gets the largest grant the cap and budget allow, never "until
lifted". `mergeHold` holds the precedence — an operator's grant upgrades a
session's, a session's never narrows an operator's — and `mayLift` enforces the
lifting rule.

**Who is asking is decided by the directory, never by a field.** The daemon
serves two command directories with one vocabulary (`src/commands.ts`,
`CommandWatcher`): the session's `commands/` and the operator's
`commands/operator/`. The operator directory is root-owned `0755` and therefore
unwritable by the daemon's uid — which is the uid every session runs as — so a
session cannot put a file there. `operatorSealVerdict` re-checks the directory
and the file (owner, mode, kind) at handling time; a file that arrives there
without the seal is served **as a session's**, loudly, with an
`operator_channel_unsealed` event. The watcher never creates that directory: a
daemon-made one would carry the daemon's uid and be no seal.

The operator's own write path is the other half of the seal —
`operatorCommandWriteScript` in `src/tui/unwedge.ts`, used by the TUI's unwedge
key, `qcr drain` (`src/tui/deploy-drain.ts`) and the deploy tab. It refuses a
symlinked `commands/operator`, takes over a real one a session pre-made
(`chown 0:0`, `0755`), and sets the file's mode itself.

**Expiry binds at the reader.** `holdActive`, `drainState()` and every PR row
fold the expiry themselves, so a lapsed hold stops binding the instant it
lapses. `sweepExpiredLevers`, run from the dispatch pump, writes the
`drain_expired` / `pr_pause_expired` ledger rows — it is the record, not the
enforcement.

Neither lever touches GitHub and neither goes near the gate. Holds are visible
in `status.json` (`draining_by`, `draining_until`, per-PR `pause`), in
`qcr status`, and on the TUI board.

### Not guaranteed

A session's budget is counted per operations day (`opsDay`, `src/eod.ts`,
which takes the `[ops] timezone` from config) and, for pauses, per PR. It bounds duration,
not intent: a session can still spend its whole budget, and the operator lever
remains the backstop.

---

## 10. Reading this list correctly

Three habits keep these boundaries honest.

**Say what is not covered.** Every section above has a "not guaranteed" note
because each of these mechanisms has been trusted further than it went at least
once. A boundary documented only by its guarantee invites exactly that.

**Prefer a structural fence to a sentence.** Several of the invariants here are
enforced by tests that *derive* the claim rather than assert prose:
`tests/fences-gate.test.ts` (no caller for the review-mutating kind),
`tests/fences-guards.test.ts` (guard coverage read out of the scripts),
`tests/fences-cigate.test.ts` (the three copies of the latest-run rule agreeing
over the real adapter and the real shell function),
`tests/fences-severity.test.ts` (the full tag matrix). When a claim here needs
maintaining, that is the shape to reach for.

**Change both halves.** Anything that binds posting exists twice — once in
`src/` on the gate route, once in `scripts/guards.sh` on the session route.
Changing one without the other produces a system that enforces a rule on the
route nobody uses.
