# Deferrals cost a ticket — the `[deferred]` protocol

**Decision (the owner, and its amendment).** *"Next iteration"* was never
the author proving a finding wrong. It was a **cost decision**: right finding,
real fix, not worth an hour then. That cost has collapsed, because an AI
implementer has the time. So a deferral stops being free.

**No ticket, no deferral.** The reviewer neither holds the block nor silently
concedes: **it files the issue itself, in the same round that deferred** —
through the daemon's existing capped issue path. There is no author-confirmation
step (the owner's correction of the first build: *"bot should just create issue,
with proper context on what was deferred from where by whom etc … and github
token is then open to comments and pickable by human"*). The filed issue is an
ordinary GitHub issue: commentable, correctable, pickable by any human.

**Nothing here forces a fix or blocks a merge.** A deferral only stops being
free. The falsifier the owner named: if the backlog becomes noise nobody works,
this was wrong.

## The three markers, and why there are three

A marker that means three things routes nothing — the same argument that gave
`[ask your human]` its own tag on instead of a second meaning for
`[check this]`. Each of the three has exactly one meaning, one addressee and one
resolution rule.

| marker | means | addressee | who may resolve the thread |
|:--|:--|:--|:--|
| `[check this]` | a HUMAN should verify this before merge | whoever reads the PR | **a human only** — `resolveOwnReviewThread` refuses structurally |
| `[ask your human]` | do not answer this yourself; put it to your person and bring the answer back | the PR author's AI implementer | the author, once the answer is in the thread |
| `[deferred]` | this finding is real, and this PR is not where it gets fixed | nobody in particular — it states the finding's own STATE | **a human only** — same structural refusal |

`[deferred]` is deliberately spelled to share no word with either other marker:
no *"this"* (which `[check this]` owns, and which would make a `[track this]` or
`[fix this]` read as its sibling), no *"human"*, no imperative. One word, a past
participle, naming a status rather than issuing an instruction.

The grammar lives in `src/severity.ts` (`CHECK_THIS_TAG`, `ASK_HUMAN_TAG`,
`DEFERRED_TAG` and their regexes, all listed in `SANCTIONED_TAGS`), and
`tests/severity.test.ts` pins that no marker's regex ever matches another and
that none is a substring of another.

## What legitimately counts as a deferral

A judgment, not a keyword list. **A legitimate refusal is a reason that is not
"later":**

- too big for this PR;
- not this PR's code;
- needs a product decision someone else owns.

*"We'll get to it"* is not one of those, and neither is silence.

## The path a ticket takes

There is exactly one route, and it is the one that already existed — **no second
writer, no new mutation kind, no cap lifted** (hard rule 1):

1. The review posts the finding with `[deferred]` leading the comment, before
   its posting tag.
2. In the same round, after the review posts, the session writes ONE command
   file, `commands/deferral-pr-<n>-<slug>.json`:

   ```json
   { "command": "file-issue", "pr": 5314, "title": "…", "body": "…" }
   ```

3. `src/commands.ts` validates it against the same whitelist and the same tier
   gate; `src/improvements.ts` `fileIssue` applies the same 3/day cap and the
   same duplicate detection; `createIssue` goes through the one `MutationGate`.
4. The session reads `commands/results/deferral-pr-<n>-<slug>.result.json` and
   replies in the finding's thread with the issue number, so the thread and the
   ticket point at each other.

## The issue body: full provenance

The issue is the artifact a stranger picks up, so its body must work without
the PR open — what was deferred, from where, by whom, and why. The round
templates carry this shape verbatim:

```markdown
<the defect: what is wrong, the mechanism, the evidence refs, and the
invariant a fix must restore — complete sentences, self-sufficient, exactly
as a blocker body would carry them>

---
Deferred from: <link to PR #<n>> at <head sha>, round <k> — <file>:<line>
Finding: `[deferred]` `[<tag>]` <title> — <link to the finding's review thread>
Raised by: <the lens pass that raised it, or "review session">; severity <as posted>
Deferred because: <which of the legitimate refusals above this is, in one
sentence>
```

The two links are load-bearing: the issue must lead a reader back to the PR and
to the finding's thread.

**A cap refusal is loud.** `"ok": false` is reported back in the thread with the
exact reason — cap reached, duplicate of issue #N — and the session says plainly
that no ticket exists yet. It never retries, never routes around it, and never
quietly drops the deferral: a deferral with no ticket that nobody was told about
is precisely the failure this mechanism prevents. On a PR-attributed draft the
refusal also leaves a `deferral_ticket_refused` anomaly row against that PR, so
it is visible in the TUI and queryable afterwards.

### How the session reaches the capped path (no tier widening)

`file-issue` is `author: false` in `src/commands.ts`'s `TIER_TABLE` — on Slack
it is the owner's tier only, exactly as before. The review session does
not need a widening: its command files land in the daemon's legacy `commands/`
directory with **no Slack origin**, and a turn with no origin runs at full
tier-M autonomy already (the same footing as the EOD sweep, which files issues
through this exact path today). The first build of briefly widened the
row to `author: "own"` for an author-confirmation step; the owner corrected the
intent — the session files the ticket itself — and the widening is reverted.
The optional `pr` field survives as pure provenance: it attributes the filing,
and any refusal, to the PR the deferral was raised on. Every cap is downstream
of the tier and none of them moved — a tier never lifts a cap.

## The implementer side

The reviewed repo gets both a standing directive and an in-thread pointer. The
in-thread pointer is the reviewer's reply carrying the filed issue's number.
The standing directive belongs in the reviewed repo's own agent directives
(`AGENTS.md` / `CLAUDE.md`); the text to paste:

> **A `[deferred]` review comment is a deferral, not a dismissal.** The reviewer
> agrees this is not this PR's job and has already filed a GitHub issue for it —
> the thread carries the issue number. If the ticket got something wrong,
> comment on the issue; it is an ordinary issue, open to correction and pickable
> by anyone. Do not resolve the thread on the strength of "we'll do it later":
> the reviewer cannot resolve the thread itself, and a human closing it should
> check the ticket exists first. Nothing about a `[deferred]` comment blocks the
> merge.

Keep it distinct from the other two directives the repo carries: `[check this]`
asks a person to verify something before merge, and `[ask your human]` tells you
not to answer a question yourself.
