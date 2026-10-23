# open-code-review vs quickreviewd — what to take from it

Comparison of Alibaba's open-source `open-code-review` (`ocr`, Apache-2.0, Go,
HEAD `486022d` of 2026-09-24, checked 2026-09-25) against this system. The
claims about ocr come from its source at that commit, not from its README.
Paths below are relative to its repository root. This is a companion to
`docs/pr-agent-comparison.md`.

## What open-code-review is

A **stateless review CLI**. You run `ocr review` on a diff: workspace changes,
a branch range, or one commit. It prints structured comments or writes JSON or
SARIF, then exits. It came out of Alibaba's internal reviewer, and the README
says that reviewer served "tens of thousands of developers". It runs as a CLI,
as a GitHub Action (`action.yml` plus
`scripts/github-actions/post-review-comments.js`), as IDE plugins, and as a
"delegate" mode where a host agent such as Claude Code does the LLM work.

Its thesis matches ours: **deterministic engineering for every step that must
not go wrong, and the agent only for dynamic decisions and fetching context.**
It reaches that thesis from a different starting point. We built a teammate
that owns a PR. They built a one-shot tool that has to be correct the first
time, cheaply, on any repo, with any model.

### One review, end to end (`internal/agent/agent.go` `Run` → `dispatchSubtasks` → `executeGroupSubtask`)

1. **Deterministic file selection** (`internal/agent/selection.go`). Binary
   files, secret paths, user excludes and includes, an extension allowlist,
   default excluded paths, and a per-file token ceiling. Every exclusion has
   a named reason.
2. **Grouping** (`internal/agent/grouping.go`, `prompts/grouping_task_*`).
   With 4 or more files, an LLM clusters related files, up to 10 per group
   (i18n variants, interface with implementation). Below 4 files, a
   deterministic rule applies: one bundle under 200 changed lines, otherwise
   one file per group. Each group becomes an isolated sub-agent, and up to 8
   run at once.
3. **Rule matching** (`internal/config/rules/`). Per file, a glob-matched
   checklist is chosen: about 50 embedded language docs
   (`rule_docs/python.md`, `ts_js_tsx_jsx.md`, …), then global, project
   (`.opencodereview/rule.json` in the reviewed repo) and `--rule` layers. The
   first match wins, and all of it is injected as `{{system_rule}}`. The
   language docs lead with "favor precision over recall" and each ends its
   sections with explicit **"Do not report …"** exclusions.
4. **Plan phase**, gated by churn: at least 50 lines in one file or at least
   100 across the group. A single call writes a risk list sorted by severity,
   with the tool calls it intends to make for each risk.
5. **Main loop**: one tool-use conversation per group, with tools
   `file_read`, `code_search`, `file_find`, `file_read_diff`, `code_comment`
   and `task_done`, capped at 100 tool requests. Old turns are compressed in
   the background at 80% of the context
   (`internal/llmloop/compression.go`).
6. **Extra rounds** (`MAX_REVIEW_ROUNDS`: effort low, medium and high give 1,
   2 and 3 rounds). Round 2 onwards **drops the plan on purpose "to avoid it
   acting as a coverage ceiling"** and gets the confirmed findings so far.
   The loop stops early when a round adds nothing, or at 30 confirmed
   findings.
7. **Comment positioning**. `code_comment` takes **`existing_code`**, a
   verbatim snippet, not line numbers. `internal/diff/resolver.go` tries
   three steps in order. First, a sliding-window match against the comment's
   own file (hunks, then the full file). Second, a **cross-file search that
   re-files** the comment to the file that actually contains the snippet.
   Third, a small LLM "re-location" call that re-extracts the snippet
   verbatim from the diff (`prompts/re_location_task_*`).
8. **Review filter** (`prompts/review_filter_task_*`, `filterTools` in
   `agent.go`). This is a fact-checker that sees **only the diffs**, and its
   default is to approve everything (details below).
9. **Coverage manifest** (`internal/session/manifest.go`). Every selected
   file gets a terminal state: completed, reused, or failed with a class
   such as `budget` or `panic`. The run is marked complete, partial or
   failed, and hashes of the input, rules and runtime config are sealed in.
   Runs can be resumed.

In CI, the Action adds features that belong to a stateless tool:
- a sticky summary comment;
- incremental posting that skips a new inline comment when its line range
  overlaps an earlier one (intersection-over-union above a threshold);
- opt-in **checkpoint ranges**, which review only `last-checkpoint..head`
  and fail closed back to a full review when in doubt;
- routing of low-severity or chosen-category findings to the summary instead
  of inline comments;
- opt-in resolution of its own outdated threads.

It never approves and never requests changes. It only comments.

### Their benchmark (README, `imgs/benchmark-en.png`)

AACR-Bench ([Hugging Face](https://huggingface.co/datasets/Alibaba-Aone/aacr-bench)):
50 repos, 200 real PRs, 10 languages, and **1,505 ground-truth issues
annotated by 80+ engineers**.

| Setup | F1 | Precision | Recall | Tokens/review |
|---|---|---|---|---|
| ocr + Claude-4.6-Opus (best F1) | 25.1% | 33.9% | 20.0% | 385K |
| ocr + Claude-4.8-Opus (best precision) | 17.9% | 37.8% | 11.7% | 352K |
| ocr + GPT-5.5 | 21.0% | 32.1% | 15.5% | 422K |
| Claude Code + Claude-4.6-Opus | 11.6% | 7.2% | 28.9% | 5,664K |
| Codex + GPT-5.5 | 8.4% | 27.8% | 4.9% | 525K |

Their setup reaches about 4 to 5 times the precision of a general agent, for
about one ninth of the tokens, and gives up some recall. It is also a useful
calibration for us. **The best tool on a human-annotated benchmark finds one
fifth of what humans flagged, and about two thirds of its comments match no
human annotation.**

## Side by side

| Dimension | open-code-review | quickreviewd |
|---|---|---|
| Shape | Stateless CLI; one run is one review | 24/7 daemon; one sticky pi conversation per PR for its whole life |
| Scope | Any repo, any of about 50 languages, any model provider | One reviewed repo (set at install), one model family (codex) |
| Trigger | Developer, CI job, or IDE | Label or the configured review-team request; webhook plus reconcile poll |
| Verdict | None; comments only | APPROVE / REQUEST_CHANGES / COMMENT, with a CI hard gate and posting-time guards |
| Unit of work | A **file group** (LLM clustering) as an isolated sub-agent | A **lens** (concern: data-safety, backcompat, intent…) as a blank-slate leaf over the whole PR |
| Specialisation axis | **By file type**: a glob-matched language checklist | **By concern**: heuristic lens selection, a `PASS_ADDENDA` registry |
| Recall mechanism | 1 to 3 rounds per group; plan dropped after round 1 | Up to about 13 parallel lenses; a later round sees the new delta |
| Validation | Diff-only fact-checker, **approve by default**, only 2 removal grounds, protected-subject veto | Worktree-reading adversary, **kill by default when unverifiable**, never cheaper than the lenses |
| Anchoring | Verbatim snippet → deterministic match → cross-file re-file → LLM re-extract | `path:line:side` fixed by the validator (an LLM); the live shell route checks shape only, and `anchors.ts` stripping is off the live path |
| Re-review | Checkpoint range plus overlap dedupe, reconstructed from the PR page | Same session remembers; recheck classifies the delta; SETTLED list; nit cap from round 3 |
| Memory and learning | None (on the H1 2027 roadmap) | OpenViking memory, EOD sweep, `[feedback]` loop, findings record |
| Evaluation | **Offline benchmark** with human ground truth, per model and version | Live retros, a human-review corpus, adjudicated feedback; an offline replay (`qcr regression`) that has never run end to end |
| Cost control | Token estimate, aggregate budget, per-group look-ahead gate | Round caps, tier choice, recheck triviality classifier |
| Coverage accounting | Per-file terminal state in a sealed manifest | Per round; `rounds.lenses` records the plan, not what ran (open item) |

## Where they chose differently, and why both are right for their context

- **Grouping by file versus lenses by concern.** A tool that has to work on a
  500-file refactor in any language has to split the work, and the file is
  the natural unit. A reviewer of one team's PRs is better served by concerns
  that cross files (backcompat, migrations, intent), and our PRs are small
  enough for every lens to read the whole diff. Their grouping prompt exists
  to avoid the "incomplete coverage" failure. Our lenses guard against it by
  being narrow instead.
- **Stateless versus sticky.** They rebuild continuity from the PR page with
  hidden markers, overlap tests and checkpoints. That is sophisticated
  machinery for a problem that our sticky session and SETTLED list solve at
  the source. Their machinery is the right answer when you cannot keep state.
  We can.
- **No verdict versus a verdict.** Because ocr only comments, a false
  positive costs a few seconds of a reader's time. That is exactly how their
  filter justifies approving by default. Our false positive can be a
  REQUEST_CHANGES that blocks a merge, which is why our blocker bar is
  guarded so hard. The asymmetry they reason from is real, but its size
  depends on what a comment can do.
- **Filter mandate.** Their filter is the "evidence-only checking" validator
  that **we explicitly rejected on **: the broad veto was kept and paid
  for. Do not re-open that decision because of this project. The part of
  their filter worth taking is compatible with our broad veto (idea 1).

## Ideas worth taking (ranked)

### 1. A protected-subject list: demote, never kill

Their filter has a list of **protected subjects** that it may not remove
however confident it is: memory safety; concurrency; declaration and linkage
consistency; **behavioural or compatibility change** ("a message, field,
status, or default that the old code produced and the new code no longer
does; an altered error path"); and an accepted-but-unused parameter. Their
reasoning, in the prompt, is that "these are the categories where a wrongly
removed comment is most expensive, and where your own confidence is least
trustworthy — including confidence that the language, compiler, or runtime
does not behave the way the comment claims."

We already have one member of this class: security findings are demoted to a
question, never killed silently (pass-validate step 1). We also have evidence
of the failure it prevents. found a real funnel-scope finding killed as
"unverifiable" and lost as a legitimate question. The proposal is a
`PASS_ADDENDA` validator addendum (the sanctioned path) that extends the
security rule to a short list of subjects. On those subjects, `unverifiable`
or low confidence becomes a demotion to `[question]`, not a kill. `refuted`
with cited counterevidence still kills. Candidates: concurrency or races;
behaviour and compatibility changes (this overlaps `pass-backcompat`);
data-safety and migrations. The broad veto stays in full, and the blocker bar
does not move, because a demoted finding cannot block.
**Measure first:** grep the findings record for `unverifiable` kills by lens
over the last month, to see whether the class is big enough to matter.

### 2. Snippet anchors, relocated deterministically before stripping

Their `code_comment` takes a verbatim code snippet, not a line number. A
deterministic resolver then places it. It first looks in the claimed file,
then **re-files the comment to another changed file if the snippet lives
there**, and only then asks an LLM to re-extract the snippet. They built this
because "position drift" was one of the three failures they measured in
general agents.

Our route is based on line numbers, and there is a gap in it.
`packages/pi-plugin/src/anchors.ts` holds the right discipline: validate every anchor against
the changed-line runs and strip invalid ones into the body overflow, because
"GitHub rejects the *whole* review call when a single inline comment fails to
anchor". But `anchors.ts` is **off the live path**. It is imported only by
`posting.ts` and `compare.ts`. Sessions post through `scripts/post-review.sh`,
which checks only shape (`path` is a string, `line` > 0, `body` is a string,
`side`). So one drifted line number fails the whole post, and the session
has to notice, fix it and retry. The only defence today is the validator's
step 3, which is an LLM.

Two steps, both pure code, with no LLM and no new mutation kind:
- ① Put the `anchors.ts` validate-and-strip in front of the shell route. The
  posting boundary is already an open lever in
  `docs/review-design-assessment.md`.
- ② Let findings carry an optional verbatim `line:` quote. Before stripping a
  finding, search the PR's patches for that quote, first in the same file and
  then in other files, and re-anchor on a unique match.

Step ① turns a failed post into a degraded one. Step ② keeps a comment's
inline thread, and with it the "resolve every conversation" merge rule that
makes humans look.
**Measure first:** grep the logs for review posts that failed with a 422 or
an anchor error.

### 3. An offline replay benchmark for lens and addendum changes

This is the biggest structural difference. They can say "v1.3.1 with model X
scores F1 25%" and compare versions before release. We change lenses and
addenda and learn the effect from live PRs and retros, days later.

We already own the raw material: the human-review corpus (1,387 PRs
and 8,763 findings), the findings record and adjudicated `[feedback]`
items. The seam exists too. `src/replay.ts` (ScratchReplay, `qcr regression`,
) checks a head out into a scratch worktree, plans lenses with the
pure `buildPassPlan`, runs a throwaway pi session and collects a
`findings.json`, and it touches no gate and no GitHub adapter. **It has never
run end to end, and it cannot as written.** `replay.ts:456` orders the bare
lens names (`pass-baseline`), but `buildAgents` emits only `<lens>--<tier>`
agents and deletes anything without the tier suffix (`include.ts:829`,
`:858`). Production orders use `p.agent` (`dispatch.ts:680`).

Fixing that and pointing it at a frozen set of about 30 to 50 historical PRs
would turn "did this addendum help?" into a number, measured before a deploy.
This is not the reviewer running code (the reviewer still never executes what it reviews). It is us
testing the reviewer. It costs real tokens per replay, so it should be run on
demand and not on every commit.

The corpus converts mechanically into AACR's format:
- **Size:** 4,536 filtered human findings over 1,113 (PR, commit) instances.
- **Line numbers:** recovered from each diff hunk. They matched GitHub 268 of
  268 times and the real file content 2,636 of 2,642 times.
- **Caveats:** its labels are sparse, human-only and question-shaped. It is
  also circular with the house rules, because derived them from it.
  Score it on a temporal holdout, not with one headline F1.

#### Running on AACR-Bench itself (checked 2026-09-25)

It is fully open:
- **Data:** Apache-2.0 on [Hugging Face](https://huggingface.co/datasets/Alibaba-Aone/aacr-bench), not gated.
- **Harness:** [alibaba/aacr-bench](https://github.com/alibaba/aacr-bench) `evaluation/`.
- **Judge:** the paper names `Qwen3-235B-A22B-Instruct-2507`, which has open weights.

A quickreviewd arm needs no fork of their code. Write OCR-shaped result JSON,
`{review:{comments:[{path,start_line,end_line,content}]}}`, one file per
instance, and run `python -m pipeline run --stage eval --reviewer ocr
--dataset … --run-id …`. What must be right for the number to mean anything:

- **Pin dataset v1.0** (git `ab8af8d`, the HF file): 1,505 references over the
  196 PRs the harness scores. `main` now has 1,506, and the harness's own
  sha256 pin rejects the file its URL serves. Assert `evaluated_instances ==
  196`: a PR with no result file silently leaves both denominators.
- **Emit one anchored, head-side issue per comment.** The path, side and line
  gates are skipped when a field is missing, so a body-only comment is a
  wildcard judged against every reference. Matching is greedy and
  one-to-one, side is forced to `right`, and line tolerance is ±1.
- **The judge is loose.** It runs at temperature 0.7, and its yes/no parser
  scores "No, they are not the same" as a match. Run 3 or more eval rounds.
- **The ground truth is 74% AI-seeded.** GPT-5.2 alone wrote 25.2%, which is
  our model's family. 41.6% is Maintainability/Readability, which our
  validator trims on purpose. Report the result split by category.
- **The published leaderboard is not reproducible as-is.** 13 of its 14 rows
  existed before the public harness (first commit 2026-07-01), and its judge,
  rounds and k are undisclosed. The only fair comparison is to re-run one
  published baseline, e.g. OCR v1.3.1 + GPT-5.5 (published 234/728,
  234/1505), under our pinned judge, next to our arm.
- **Our subset is small.** Python is 21 scored PRs with no Django, and
  TS+JS is 40.

Cost, measured from 163 real first rounds (2026-09-03 to 09-21):
- Per round: median 758 s, mean about 83k uncached input and 12.6k output
  tokens.
- For all 196 PRs: about 45 hours serially, or about 11 hours with 4 in
  parallel.
- It must run on its own pi login and with memory off, never on the live
  `pihome`: a main session both recalls from and writes to reviewer memory.
- The judge costs under $1 per eval round even in the worst case.

The adapter work, on top of the replay fix:
- a shallow fetch by SHA per foreign repo, instead of `refs/pull` and the
  configured base branch;
- the NONE ecosystem, instead of the Django default;
- the OpenViking extension dropped;
- the real per-file status and patch, instead of `status: "modified"`.

One bias cannot be removed without a reseed: the frozen `pass-baseline` seed
carries the deployed repo profile's pytest and Django Ninja conventions.

**Cheaper first experiment:** the HF release pairs 1,505 correct comments
with 640 incorrect ones and is framed as a test for reflection models that
"intercept low-quality review comments". It can score `pass-validate` as a
keep-or-kill classifier, with no clones, no review runs and no F1 judge.

### 4. Per-file coverage, disclosed

Their manifest gives every selected file a terminal state. The main prompt
also carries an explicit completeness gate: before `task_done`, "confirm you
have given every `<file>` its own pass … a file being the smaller or secondary
member of the group is not a reason to skip it." Two small borrowings:
- Put the same sentence in our round templates, which are ours to edit, or in
  a lens addendum.
- Record which files each lens actually opened. This moves the open item
  "`rounds.lenses` records the plan, not what ran" forward, and it pairs with
  "disclose degraded rounds" from the pr-agent comparison.

### 5. Path-scoped checklists with explicit "do not report" lists

Their rule docs are matched to files by glob and are mostly exclusions, for
example "Do not report edge cases that a caller or type contract has already
ruled out" or "Only flag concurrency issues when there is evidence of …
concurrent invocation". Our specialisation is by concern, so a Python or
Django or TS checklist would add a missing axis, aimed at precision.
**Check (`docs/corpus-rule-placements.md`) first.** The corpus rules
may already fill this role. If built, inject it through the round template or
an addendum, never a seed edit. A repo-owned rules file in the style of their
`.opencodereview/rule.json` would have to be read at **base sha**, never from
the PR head, or a PR could rewrite its own review rules.

### 6. Reasoning before commitment in structured output (small, cheap)

In their filter tool schema, the `analysis` field comes before `comment_ids`.
Their comment in the code says this order is load-bearing: on replay, with the
order reversed, the model wrote "this is a protected subject, I should not
remove it" **after** it had already committed that id. Check that our
validator's kill log and the session's verdict JSON put the reasoning field
before the decision field.

## What the comparison validates

- **Deterministic scaffolding with an agent for judgment** is the same core
  bet, and their benchmark is independent evidence that it beats an
  unstructured general agent, by about 4 to 5 times on precision.
- **Precision over recall** is their stated default in every rule doc. It is
  our "the blocker bar never moves" and the reachability axis.
- **Review only the delta since the last reviewed head** (their checkpoint
  ranges) is our recheck. They fail closed to a full review when in doubt,
  and we classify the delta instead.
- **A separate filtering step after generation** exists in both systems.
  Only the mandate differs, and ours was decided.

## Not to import

- **LLM file grouping**: it answers a scale problem we do not have, and our
  lenses already see the whole PR.
- **Repeated same-prompt rounds per group**: a recall booster that re-spends
  a whole review. Our parallel lenses are a different way to buy recall, and
  the hard round budget is on the wish list, not something to rebuild quietly.
- **Overlap dedupe, hidden checkpoint markers, sticky summary rebuilds**:
  continuity reconstructed from the PR page, which our sticky session makes
  unnecessary.
- **Diff-only, narrow-mandate filter**: rejected on (see above).
- **Severity routing to the summary**: the nit cap already limits nit volume.
  Revisit only if inline nits turn out to cost authors resolve-clicks under
  the merge rule.
- **Delegate mode, multi-provider layer, IDE plugins**: product surface for a
  general tool.
