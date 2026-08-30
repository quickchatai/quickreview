# pr-agent vs quickreviewd — what to take from it

Comparison of the open-source pr-agent (v0.43.0, HEAD 39d1e95, MIT, checked
2026-08-29) against this system. Ten research agents read both codebases; every
claim below was then re-verified against the actual files by two adversarial
fact-check passes, and several first-draft recommendations died in verification
(listed at the end — they died because we already have the thing).

## What pr-agent is

A stateless Python tool. A PR comment like `/review` or `/improve` triggers one
LLM call (~30s, README.md:133) over a token-budgeted compressed diff; the result
is posted as a comment. No database: continuity is reconstructed from the PR page
itself. Ten git-provider adapters, any model via LiteLLM (default gpt-5.6,
fallback gpt-5.6-terra), and nearly everything including prompts is per-repo
configurable via `.pr_agent.toml`. It never approves, never blocks, never
remembers: `REQUEST_CHANGES` appears nowhere in the codebase, and auto-approve is
dead code three ways (call site commented out at pr_reviewer.py:154-157, no
config default, key on the forbidden-CLI-args list).

Ownership: Qodo donated it to the community (README.md:259); previously
Codium-ai/pr-agent. The paid Qodo Merge tier left and took its learning features
with it — `[auto_best_practices]` (configuration.toml:474-479) has zero
implementing code, and the best-practices prompt variable is hardcoded empty
(pr_code_suggestions.py:110).

The two systems answer different questions — pr-agent assists a human reviewer
across many repos, we replace one on a single repo — so most differences are not
gaps. Below is only what is actionable.

## Improvements worth doing

### 1. Review-effort label on the posted review

pr-agent's `/review` publishes a `Review effort {n}/5` label (pr_reviewer.py:648,
published at :668). It answers a question our system leaves open: which
bot-approved PRs deserve a human glance anyway. Today the PR-side attention
artifacts are the verdict, `[check this]` comments, the double-check section, and
the guard notes — none of them summarize how hard the review was.

Verified feasibility: `add_label` is already a gate MutationKind (gate.ts:9-28,
used live for `in_progress_label` and `reviewed_label`), so no new kind is
needed. The rounds row already carries the inputs: `lenses`, `validate_tier`,
`executed_passes`, `additions/deletions/changed_files`, `comments_posted`,
`est_usd` (state.ts RoundRow). Derive the label from those recorded facts.

One honest caution: rule 10 retired the escalation-worthiness score, and
heuristics.ts:48-50 records why ("no code ever checked whether the score
predicted anything"). An effort label is adjacent to that. If built, it should be
a readout of measured round facts, not a new predictive heuristic — and whether
it is different enough from the retired score is the owner's call, not ours.

### 2. Close the marker-scan gap in posting recovery

First draft said "steal pr-agent's comment-embedded fingerprints." Verification
showed we already have them: every receipt-keyed review body carries
`<!-- qcr-post:key -->` (posting-receipt.ts:29-31, appended by
post-review.sh:155-157), and verdicts.ts:402-411 scans GitHub for the marker to
confirm ambiguous posts.

The remaining gap: that scan is keyed off `round.posting_key` from the SQLite
row. If the state DB and `state/posting-receipts/` are both lost or restored from
an older snapshot, no pre-post path scans GitHub bodies for markers before
posting — `reviewed_heads` is DB-only and reconcile never rebuilds it from
GitHub. pr-agent's version (inline_comment_dedup.py: scan existing comments for
markers, skip matches, no local state consulted) is the DB-independent shape. A
guard-2-adjacent scan of existing bot reviews at the head for our own markers
would make posting idempotent against state loss using markers we already emit.

Effort: small. The marker and the scan logic both exist; this is wiring a
DB-independent read into the pre-post path.

### 3. Feed guard-1 downgrades into feedback capture

When guard 1 downgrades REQUEST_CHANGES to COMMENT over a standing human
approval, the event is logged (`posting_guard_downgraded`, guards.ts:277) and
mined by the TUI (candidates.ts:287 DISAGREEMENT_KINDS) — but feedback.ts never
sees it. Its behavioral signals (feedback.ts:60-63: `review_set_aside`,
`merged_over_block`, `bot_comment_deleted`, `trigger_withdrawn`) are inferences;
the guard-1 moment is a direct, unambiguous human-overrode-the-bot record that
the same-day validator addendum and the EOD sweep currently don't receive.

Effort: small — one more deduped signal kind through the existing sink.

### 4. Disclose degraded rounds in the review body

pr-agent ends a clipped review with "⚠️ Review coverage: the following files
were not included… because of the token budget" (pr_reviewer.py:346-356, on by
default). We never clip, but two of our degraded modes are operator-loud and
review-invisible: a degraded migration pre-check (anomaly + a session note, but
no instruction to disclose in the body — templates.ts:175-191) and a degraded
recheck merge-verify (event + anomaly only, recheck.ts:543-551). The author reads
a review that looks full-confidence.

There is precedent in both directions, so this is a narrow change, not a policy:
the solo-round disclosure already exists ("Lenses applied: none — reviewed solo
(degraded round)", round-first.md:518), while memory degradation is deliberately
undisclosed (context.ts:329 "do not mention it in the posted review") and should
stay that way. Proposal: one body line for the two named degradations only.

Effort: small, template additions.

### 5. Write the unpin-day page

pr-agent maintains per-model capability tables because it must run on anything
(NO_SUPPORT_TEMPERATURE_MODELS, CLAUDE_EXTENDED_THINKING_MODELS,
STREAMING_REQUIRED_MODELS in algo/__init__.py; GPT-5 reasoning normalization in
litellm_ai_handler.py:680-707). We pin one model family on purpose — but severity
bars, the kill vocabulary, and many addenda were calibrated against this model's
live behavior. One docs/ page now, listing what is model-calibrated and must be
re-verified on a pin change, is cheap while we still remember which addendum came
from which behavior.

Effort: a document, no code.

## Dropped after verification

Recommendations from the first draft that turned out to already exist or to rest
on a false premise. Kept here so they don't come back.

- **"Make human overrides visible on the PR."** Already done: guard 1 appends
  "_Not blocking: **@{approver}** has already approved this head…_" to the
  posted body (guards.ts:135-140, mirrored in guards.sh:207-210). What was
  missing is only the feedback wiring — item 3.
- **"Adopt comment-embedded fingerprints."** Already emitted and scanned
  (item 2); only the DB-independent recovery scan is missing.
- **"Extend diff excerpts to the enclosing function."** False premise: the
  daemon embeds no hunks at all. Round prompts hand the session a worktree and
  it runs its own diffs (round-first.md:15,85-87); the recheck prompt renders a
  file list, not hunks (templates.ts:64-69). Nothing to fix.

## What the comparison validates

Places where pr-agent either lacks what we built or demonstrates the failure our
rule prevents. All verified.

- **Human-only resolve on `[check this]`.** Their `resolve_threads` lets the
  model end an `/ask_line` answer with `[THREAD_RESOLVED]` and the bot resolves
  the thread; their own config comment: "also resolves threads started by human
  reviewers" (configuration.toml:163-165, off by default). This is the exact
  failure our rule forbids, running in production elsewhere.
- **The reconcile poll.** Their webhook route returns 200 before background
  processing and nothing replays a lost event (github_app.py:38-53); the polling
  server is a separate deployment mode, not a backstop. A dropped webhook is a
  silently missed review.
- **The trivial-delta recheck classifier.** Their push trigger (off by default,
  configuration.toml:293) reruns the full command list per push with no
  triviality check — the cost shape our 2.56M-token "byte-identical" retro paid
  to escape. A bot-commit filter is a TODO in their code (github_app.py:159).
- **Posting-time guards.** They have none: no merged/closed re-check, no
  human-approval awareness, no head-drift check before publishing (verified by
  grep across tools/ and providers). Each of our five guards encodes an incident
  class their deployments hit at comment-level severity.
- **Frozen seeds + addenda registry.** Their prompts are settings, overridable
  per repo at runtime. Right for a multi-tenant product; no audit trail of what
  the reviewer believed last week. For a self-modifying 24/7 reviewer, our shape
  is the defensible one.
- **Daemon-enforced findings telemetry.** Their outcome tracking is
  within-call only (the /improve self-reflection score). Our own history — the
  raise-side candidates file appeared in 3 of 105 rounds until the daemon
  enforced it (findingsrecord.ts:5-14; the kill log managed 82/105) — plus their
  absence of any record says telemetry needs a deterministic enforcer.
- **Worktree over compressed diff.** Their prompt tells the model: "you only see
  changed code segments (diff hunks in a PR), not the entire codebase. Avoid…
  questioning code elements… that may be defined elsewhere"
  (pr_reviewer_prompts.toml:46). Diff compression forecloses the
  outside-the-diff finding class our retro says produces the high-value catches.
- **Loud failure.** `propagate_tool_errors = false` — their own comment: "so a
  caller can tell a failed run from an empty one" (configuration.toml:77). An
  auto-triggered review that fails posts neither a progress nor a failure
  comment (pr_reviewer.py:181-182, 235-238): no PR-visible trace.

Also confirmed, and genuinely reassuring: their reviewer prompt independently
converged on our finding bar. Line 4: '+' lines only, issues introduced by this
PR only. Lines 49-61: "be certain before flagging" low severity, "do not
speculate… unless you can identify the specific affected code path", don't flag
intentional design choices, "communicate severity accurately", no filler praise.
The finding-quality doctrine is shared ground; the systems differ on trust,
state, and authority.

## Not to import

- **Finding-count caps** (`num_max_findings = 3`, configuration.toml:116). Drops
  the fourth real bug on a bad PR. Our cap-by-class approach needs the telemetry
  we have and they don't.
- **Fallback models** (`fallback_models=["gpt-5.6-terra"]`). A silent model swap
  would invalidate the calibration behind the addenda registry. Resilience stays
  at the orchestration layer.
- **Runtime prompt configurability.** Their config-plane hardening (below) is
  the tax for it. We don't pay it because nothing repo-side configures us.
- **Model-judged thread resolution.** See above.

## Watch item, no action now

Their config-plane defenses are the best-built part of their security posture
and the checklist for a door we keep closed: `validate_file_security`
(custom_merge_loader.py:103) rejecting dynaconf include/preload/loader
directives in repo TOML; `skills.paths` restricted to host config with the
written rationale that a repo-set path could read ~/.ssh into the prompt
(git_providers/utils.py:25-32); steering context read from the default branch
(configuration.toml:31 — governs `repo_context_files`, i.e. AGENTS.md;
`.pr_agent.toml` gets default-branch treatment by separate logic in
github_provider.py:1064-1066, overridable by a host-side CONFIG_BRANCH). If
anything repo-side or PR-side ever gets to configure reviewer behavior (the
`.pi/settings.json` trust-modal incident,, was a brush with this),
their code is the list of what it costs.
