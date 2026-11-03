# A security profile for review and scan — research and proposal

Researched 2026-11-02. Status: **historical — implemented**. This is the
research and the proposal as they stood before the build; it is kept for the
reasoning and the mined data, not as a description of the code. Where it and
the code disagree, the code and these pages win:

- [`docs/profiles.md`](../../profiles.md), section *Security review — the
  `pass-sec-*` family and `[security]`*: the family, its triggers, the
  threat model, the security facts, validation, posting and requests;
- [`profiles/security/README.md`](../../../profiles/security/README.md): the
  security-only profile, its scan and its cost.

What shipped: fourteen `pass-sec-*` lenses (not the seven of §8), content
triggers in every profile, the security fold as an operator lever, the
threat model in both homes, deterministic security facts (M22) read through
read-only git with a line parser and no new dependency, exploit-chain rows
per strategy, the security-only profile, on-demand security requests, and the
scan's stage-0 threat-model draft. The questions in §8 and §11.5 were ruled
as the implementation shows: OAuth `state` belongs to tokens, an automounted
broad-role token to infra, a migration `GRANT` to iam; the field renames of
§11.5 item 8 were made; only the chain's `delta` row is required.

Deferred: scan findings carried into PR rounds (§5 item 4); reading
`SECURITY.md`, root or nested (§5 item 1); stage 2's per-instance file
ranking and loop-until-dry (§5 item 2); the trigger-rate replay over
archived PRs (M25, §11.3), so trigger rates and costs are unmeasured;
terraform or helm rendering for the facts (§11.5 item 3); and the gaps
listed in §11.4.

The question: what security lenses should QuickReview have, and what must
change so a security-focused review works plainly better? The review must be
*more sensitive*, and a speculative finding must be *weighed*, not silently
dropped. It must work both for a PR (the delta) and for a scan (existing
code), as one `security` profile.

Sources:
- [`industry.md`](industry.md) — how Anthropic, OpenAI Codex Security, Google
  Big Sleep/Naptime, Vulnhuntr, ZeroPath, DryRun, Semgrep, GitHub, Socket and
  others build their security reviewers. The prompts were read from the
  cloned repos where they are public.
- [`academic.md`](academic.md) — taxonomies (OWASP 2025, CWE Top 25 2025, API,
  LLM/agentic), measured results from the literature, failure modes, and
  benchmarks.

Every external claim below has a URL in one of those two files.

---

## 1. Where we stand today

Security is **one generic lens with path-only triggers**. Its one special
rule ("demote, never kill") is contradicted by a later addendum and is
enforced nowhere in code.

| # | Gap | Where |
|---|---|---|
| G1 | `pass-security` is a 30-line generic checklist. It has no per-class rubric, no source→sink procedure and no evidence record. | `agents/pass-security.md` |
| G2 | It is planned by **path/filename only**: `auth/`, `security/`, `middleware/`, `*token*`, `.env`, and dependency manifests. A SQL string, a `subprocess` call, a new route or a `fetch(userUrl)` in `api/orders.py` does not plan it. It ran on **14 % of benchmark PRs**. | `packages/pi-plugin/src/heuristics.ts:308-319`; `bench/aacr/paper/quickreview.tex:429` |
| G3 | **The demote-not-kill promise is broken.** The seed validator says an unconfirmed security finding becomes a P3 question (`security-demoted`). The later `validate-doubt-not-kill` addendum sends every `refuted`/`unverifiable`/`bad-anchor` to DOUBTED, with no security exception. `findingsrecord.ts` then folds those words to `doubted` whatever the session wrote, so the finding is **never posted**. No code reads `security-demoted`. | `agents/pass-validate.md:18-33`; `include.ts:581-584`; `findingsrecord.ts:66,423`; `doubtwords.ts` |
| G4 | No security branch downstream. The reachability gate caps a `plausible` P2 to a question. Under `snappy` (`questions="blocking"`) every question is withheld. Security is not ranked first in the caps. | `severity.ts:166-210`; `postingpolicy.ts:344-350` |
| G5 | `out-of-scope` kills a pre-existing vulnerability even when the PR makes it *newly reachable*. | `include.ts:571` (kill vocabulary) |
| G6 | In scan, security runs only if stage 1 suggests it or the operator lists it. It is not in the deep floor. Stage 1 says "no speculation dressed as a finding", and `scan-precision`'s `same-principal` class turns trust-boundary doubts into P3 "hardening". | `passes.ts:104-109`; `agents/scan/pass-scan.md:37,70`; `include.ts:1296` |
| G7 | A profile cannot add a lens, force-plan one, put one in the risk set, or scope an addendum to scan or review mode. | `profileoverrides.ts:15-20`; `lenstuning.ts:247-253`; `profiles.ts:345-368` |
| G8 | Nothing reads a threat model or `SECURITY.md`, and nothing checks for secrets, CI/workflow risks or advisories. `depsources.ts` fetches library sources, not advisories. | — |

**The evidence base is thin.** There are 14 `kind: security` defects in the
defect benchmark (default recall 92 %, `benchmark.tex:1733`); security is 4 %
of AACR references; and there are no stored kill-reason statistics for
security findings. One known loss: a real finding killed as `unverifiable`
(`docs/open-code-review-comparison.md:150-175`).

## 2. What the field has learned (condensed)

1. **Generic "is this vulnerable?" prompting is near random.**
   - PrimeVul pairs: GPT-4 with CoT gets both halves of a pair right 12.9 %
     of the time, below random (22.7 %).
   - Identifier renames flip 17–26 % of answers.
   - The fix is **per-class rubrics plus an explicit
     source → sink → sanitizer → unsanitized-path enumeration**: F1 0.33 →
     0.56 → 0.67 in Khare et al. The data-flow version also finds sanitizers
     the plain prompt misses.
2. **Industry splits work by vulnerability class or by trust boundary.**
   - By class: Vulnhuntr (7 classes), DryRun, GitHub AI scan, and ZeroPath's
     per-class verifiers.
   - By trust boundary: Codex Security's "packets" (attacker, asset, entry
     point, expected control, sensitive operation), built from a **threat
     model generated first**.
3. **Diversity buys recall; validation must buy back precision.**
   - SecPRBench: the union of agents reaches 91 % recall against 78 % for the
     best single agent.
   - Union voting without validation runs at about 85 % FPR.
   - LLMs are good at confirming true positives (Semgrep agreement 96 %) and
     bad at recognising false positives (41 %).
4. **Structured validation beats debate.**
   - VulAgent labels each assumption *valid / plausible / contradicted* and
     checks that guards cover every path to the sink. That took FPR from
     49 % to 21 % at equal accuracy; debate got 40 %.
   - IRIS: the validator must name *which* endpoint (source or sink) is
     wrong, and it needs the strongest model.
5. **Three or four outcomes, not keep/drop.**
   - Codex Security: reportable / suppressed / not_applicable / deferred. It
     suppresses only with "evidence that defeats the exact claim", and
     "absence alone does not establish safety".
   - A `needs_review` item must "name the smallest fact that would change the
     verdict".
   - ZeroPath, Semgrep, GitHub and Socket all route the "plausible, unproven"
     class to a **separate, lower-visibility channel**, never to deletion.
6. **Precision-first thresholds lose real bugs.**
   - Anthropic's `/security-review` drops anything below 8/10 and says
     "better to miss some theoretical issues". That is the opposite of what
     we want.
   - Its **exclusion list** (DoS, rate limiting, missing hardening,
     theoretical races, outdated deps, env/CLI trusted, React auto-escaping,
     UUIDs unguessable) is still the best ready-made list for keeping the
     *volume* sane.
7. **Missing-check (absence) defects need their own hunt.**
   - Codex: compare **sibling operations** for authn/ownership/tenant
     differences, and check that the control covers *the exact object the
     sink consumes* and runs *before the first sensitive effect*.
   - CWE-862 (missing authorization) rose five places in the 2025 Top 25.
     Five of the 25 are authz/authn weaknesses.
8. **Variant analysis is a read-only superpower.** Big Sleep and Anthropic's
   red team find bugs by reading a past security fix and hunting for its
   unfixed siblings.
9. **The PR text is attacker-controlled.** SEVRA-Bench shows "prior
   approval", "dependency compatibility" and "fake bug-fix" framings get
   vulnerable PRs approved. PRWeaver shows attacks split across PRs drop
   detection from 50–60 % to 16–22 %, which matters for scan.
10. **Fail closed.** A validator that errors or times out is not a clean
    result. Anthropic's Action fails open; Socket explicitly says not to.

## 3. Proposed lenses

Label findings with CWE ids and organise lenses by OWASP Top 10:2025
families. The benchmarks are keyed by CWE, and the per-class rubric is the
lever that measurably helps.

All lenses are **new agent files** (`agents/pass-sec-*.md`). They are not
seeded, so they sit outside the frozen-seed fence. Every one shares one
**evidence block** (§4.1) and one **procedure**:

1. Enumerate sources, sinks and sanitizers in scope.
2. Trace each unsanitized path.
3. State the trust boundary crossed.
4. Hunt the control that would defeat the finding before writing it.

Every lens also receives the **threat model** (§5) when one exists.

| Lens | Covers | OWASP 2025 / CWE | Lens-specific reasoning |
|---|---|---|---|
| `pass-sec-access` | authn, authz, IDOR/BOLA, tenant isolation, mass assignment, privilege escalation | A01, A07; CWE-862/863/639/306/284/915; API1/3/5 | **Sibling comparison**: list the neighbouring handlers and diff their guards. Check that the control applies to *the object the sink consumes* and runs *before the first effect*. Check the repo's own tenant key on every query. This is the absence hunter. |
| `pass-sec-injection` | SQL/NoSQL, OS command, template/SSTI, XSS, deserialization, eval, LDAP/XPath, header/log injection | A05; CWE-89/78/94/79/502/1336 | Per-sink micro-rubric. Recognise the framework's own sanitizer (ORM params, auto-escaping) and say where it was checked. Name the escape hatch (`raw()`, `|safe`, `dangerouslySetInnerHTML`, `shell=True`). |
| `pass-sec-boundaries` | path traversal, archive extraction, uploads, SSRF, open redirect, XXE, unsafe file perms | CWE-22/434/918/601/611/732 | URL/path canonicalisation order, allowlist vs denylist, DNS rebinding and redirect-follow for SSRF, symlink following. Classify the source with the same-principal test before claiming. |
| `pass-sec-secrets-data` | hardcoded credentials, secrets in logs/traces/responses/caches, PII exposure, weak crypto/randomness, cache-key tenancy | A04, A09; CWE-798/532/200/327/330/524 | **Secrets ignore reachability.** A credential in a test, doc or dead code is still a disclosure, and "it's a test file" is not counterevidence. Absorbs today's cache-safety and log-payload rules. |
| `pass-sec-supply-chain` | dependency adds/bumps, lockfile-only changes, install scripts, typosquats, CI workflows (`pull_request_target`, `${{ github.event.* }}` in `run:`, unpinned actions, token scopes), Dockerfiles, IaC | A03, A08, A02; CWE-829/494/1395 | Read the added package's source via `depsources` (already fetched). The trigger it inherits from `pass-security` today (manifest adds, lockfile poisoning) moves here. |
| `pass-sec-llm` | prompt injection into model context, model output reaching sinks, tool/agent authority, hidden-context exposure | OWASP LLM 2025 LLM01/05/06/07, ASI01–05 | Generalises the existing `concrete-injection-evidence` rule (payload or untrusted source → model sink → control effect). Planned when the diff touches model calls, tool definitions or prompt templates. |
| `pass-sec-variant` | the PR fixes or introduces a security pattern: hunt its unfixed or newly-unsafe siblings in the repo | — | Inputs: this PR's security-relevant hunks, plus `git log` security-fix commits for scan. Output: sibling sites. **Leaf only**: it greps and reads; it never spawns. |

What stays:
- `pass-security` stays as is in the default profile (keep-all-lenses).
- `pass-bounds` stays (A10 exceptional conditions, resource limits). In the
  security profile it joins the security family's risk tier.

Exclusions, as one addendum scoped to the security family:
- Take Anthropic's list (§2.6) almost verbatim: DoS and resource exhaustion
  except an unauthenticated amplification, missing rate limiting, generic
  "missing hardening", theoretical races without a window, outdated deps
  without a reachable advisory, and env/CLI/operator config as trusted.
- An excluded concern is never a finding. It is not a question either.
- That is the volume control. It lets the *confidence* bar drop without
  spamming.

## 4. What changes in validation

The aim is more sensitive, and *more careful*, not more permissive. A
speculative finding stays alive, but only with a precise statement of what
is unproven.

### 4.1 An evidence block every security finding must carry

```
source:      <file:line> — <what the attacker controls>, trust: untrusted|tenant|operator|first-party
boundary:    <which trust boundary is crossed>
sink:        <file:line> — <the sensitive operation>
path:        <hops, each file:line>  (gaps marked "?")
controls:    <guards/sanitizers looked for, where, and why they don't cover this path>
cwe:         CWE-<id>
proof-gaps:  <the smallest fact(s) that, if false, kill the finding>
```

The validator labels each line **valid / plausible / contradicted**
(VulAgent). It also names *which* endpoint fails if one does (IRIS).

### 4.2 Four outcomes, enforced in code (fixes G3)

| Outcome | When | What happens |
|---|---|---|
| **confirmed** | Every line valid, no proof gap | Normal finding; severity from §4.3. |
| **plausible** | No line contradicted, at least one proof gap | **Posted as a security question** stating the proof gap ("is `org_id` always set by the middleware before this handler? If not, any user reads other orgs' invoices"). Never DOUBTED. |
| **refuted** | A line is *contradicted by evidence read* (file:line cited) | DOUBTED, kept in the record, shown in the TUI. "Absence alone does not establish safety": not finding the attack is not a refutation. |
| **excluded** | Falls in the exclusion list or the same-principal class | Killed with the class name, so the EOD critic can count it. |

Mechanically:
- `findingsrecord.ts` already folds kill words. Add the rule that a
  security-family finding carrying `unverifiable` folds to a **question**
  with reason `security-demoted`, not to `doubted`.
- Add a pinned test.
- Add a security clause to `validate-doubt-not-kill`, so the prompt and the
  code agree.

### 4.3 Severity set mechanically, confidence kept separate

- Use Codex's impact × exposure matrix. Exposure: remote unauthenticated >
  remote authenticated > tenant-internal > local/operator.
- Severity is computed from the evidence block's facts. The validator does
  not argue it.
- Confidence stays the probability the claim holds. A low-confidence
  critical stays critical *and* becomes a question. It is never "demoted for
  unlikely in practice"; that rule is already in `pass-security`, now made
  structural.
- `severity.ts` gains one security branch: a security question is not capped
  away by the reachability gate. Its reachability label is shown in the
  question instead.

### 4.4 Other validator changes

- **The validator runs at the risk tier** for security-family findings, not
  at its own tier. Research (IRIS) shows weak validators make things worse.
- **Blast radius includes newly reachable sinks** (G5). A pre-existing
  vulnerability is in scope when the PR adds a path to it: a new route,
  caller, or removed guard.
- **The PR description is untrusted** for security claims. "Already
  reviewed", "only a test", and "dependency bump" carry no weight as
  counterevidence. This is a security-family addendum next to
  `injection-fencing`.
- **Fail closed.** A security lens or validator that errored or timed out is
  reported as "security pass did not complete" in the review body. It is
  never silent.

### 4.5 Posting: a separate, visible channel

- Security questions go into the existing `### For a human to double-check`
  section (`prompts/round-first.md:350`), with their own budget.
- They are exempt from `questions="blocking"` and `max_comments` in the
  security profile (profile knob).
- Security is ranked first among non-blockers.
- In scan they become a `needs-review` state next to `confirmed`/`likely`/
  `doubtful`.

## 5. Scan as part of the review: the threat model

The piece that makes "scan built into the review" more than two modes
sharing a profile:

1. **Stage 0 (scan, security profile): build a threat model.**
   - The model holds entry points (routes, CLI, queue consumers, webhooks),
     trust levels per source, assets, existing controls (auth middleware,
     tenant filters, sanitizers) and known sinks.
   - It is written as a file the operator edits: `.qcr/threat-model.md` in
     the reviewed repo, or the profile.
   - Nested `SECURITY.md` files are read too; the closest one wins.
2. **The scan uses it** to choose stage-2 rows. Entry-point files get
   `pass-sec-access` + `pass-sec-injection`; `pass-sec-variant` runs over
   the repo's own security-fix history.
   - The security lenses join the profile's deep floor.
   - Each lens instance starts from a **different file ranking** (bug
     likelihood 1–5), to fight the "found easier bugs instead" bias.
   - Deep mode repeats until a pass finds nothing new (Codex's
     loop-until-dry). The deep-scan recall notes say this was offered, not built.
3. **The review uses it.** A PR touching a file the threat model lists as an
   entry point, control or sink plans the matching security lens (G2). Every
   security lens gets the model's controls as the **"what would defeat this"
   checklist**. A PR that changes a recorded control (auth middleware,
   tenant filter) always plans `pass-sec-access`.
4. **Scan findings carry forward.** A `needs-review` security item from the
   scan, in a file a PR touches, is fed to that PR's security lenses as a
   lead. That is the cross-PR window PRWeaver shows reviewers lose.

## 6. Mechanism changes the profile needs

Today a profile cannot express most of this (G7). In rough build order:

| # | Change | Seam / fence |
|---|---|---|
| M1 | Seven `agents/pass-sec-*.md` lenses, plus the security-family evidence and exclusion addenda in `PASS_ADDENDA` | `include.ts`, `tests/include.test.ts`. Lens registry in `passes.ts`. |
| M2 | Profile `[lenses.<pass>] plan = "always" \| "triggered"` and `risk = true` (join the risk tier) | `lenstuning.ts`, `planner.ts`. A new knob is consumed (`fences-config`). |
| M3 | Content triggers for the security family: added lines with SQL strings, `subprocess`/`exec`/`eval`, route decorators, `open(` on variables, outbound HTTP on variables, deserializers, LLM client calls. Plus `PROFILE_EXTENDABLE_LENSES` for the new lenses. | `heuristics.ts` |
| M4 | Addendum frontmatter `mode: review \| scan \| both` | `profiles.ts:345-368` |
| M5 | The security fold: `unverifiable` on a security finding → question `security-demoted`; a `refuted` one requires a citation | `findingsrecord.ts`, `doubtwords.ts`; a test at that seam |
| M6 | The security branch in severity (impact × exposure; not capped by reachability) and in the posting policy (own budget, ranked first, exempt from `questions="blocking"`) | `severity.ts`, `postingpolicy.ts` |
| M7 | Validator tier = risk tier for security findings | `planner.ts` |
| M8 | Scan: profile-set deep floor (the `[scan]` table already merges from profiles, `profiles.ts:534`), `needs-review` skeptic outcome, stage-0 threat model | `passes.ts`, `scanrun.ts`, `scan.ts` |
| M9 | Threat-model reader: `.qcr/threat-model.md` and `SECURITY.md` → planning and lens context | new module in the core; `heuristics.ts` |
| M10 | `profiles/security/`: `extends = "default"`, the knobs above, `[scan] deep_lenses`, the README | profile tests (`tests/profile-inheritance.test.ts`) |

M1, M3 and M5 alone fix the worst of today: the path-only trigger, the
broken demote promise and the generic prompt. They also help the default
profile, not just the security one. The default can keep the single
`pass-security`, but should get the content triggers and the fold fix.

## 7. How to know it works

**The current evidence is too small to tune on**: 14 security defects, and
no precision measure. Proposed, each run only on the owner's go:

1. **Mine first, free.**
   - Grep stored round records for kill and doubt reasons on findings from
     `pass-security`/`pass-bounds`, to see how often G3 fires today.
   - Re-judge the 14 benchmark defects for *which lens* found them.
2. **SecPRBench** (265 PoC-validated vulnerability-introducing commits, repo
   + diff + read tools; the closest task shape).
   - Published recall: Opus 5.5 74 %, GPT-6 sol 76 %, best harness 81.5 %.
   - Its limits: C/C++/Rust only, recall only, licence unverified.
3. **MalPR-Bench** (89 malicious + 50 benign PRs, 8 language families). It
   scores verdict, identification and evidence, so it measures *precision*
   and "right verdict, wrong reason". The artifact URL was not found yet.
4. **SEVRA-Bench** for robustness to misleading PR text. **PrimeVul paired
   split** (MIT) as cheap per-lens regression tests, scored pairwise, never
   by F1 alone.
5. Avoid BigVul (about 25 % label accuracy), and OWASP Benchmark, Juliet and
   CASTLE (synthetic) for headline numbers.

Report recall on high-severity security defects first, then the
question-to-finding ratio and the benign-control false-block rate. The
benign controls are what catch a profile that has become a spam cannon.

## 8. Decisions

Ruled 2026-11-02:

- **Lens split** — the seven `pass-sec-*` lenses run in the security
  profile. The default profile keeps the single `pass-security` and gains
  the content triggers (M3).
- **Uncertain security findings** — the security fold (M5) is an operator
  **lever, off by default**. When it is on, a validator addendum lets an
  unverified security finding survive as a question; the fold maps
  `unverifiable` to `security-demoted`. When it is off, today's behaviour is
  unchanged. The security profile turns it on.
- **Threat model** — both homes. `.qcr/threat-model.md` in the reviewed repo
  wins, and the install profile's copy is the fallback.
- **Next** — mine the data before building anything: stored security
  findings and their fates, and every benchmark and benchmarked PR, mapped
  onto the proposed lenses (§9).

## 9. What the stored data says (mined 2026-11-02, no runs)

Two read-only passes over stored data. Aggregates only: the raw rows stay
outside the repository, because production rounds are private.

### 9.1 Ground truth: security defects across every benchmark

- **Scope.** 4,452 ground-truth items:
  - AACR raw references: 1,505.
  - Our derived defects: 520.
  - Martian: 173.
  - Qodo: 580.
  - SWE-PRBench: 1,674.
- **Method.** A keyword prefilter, then judging each candidate by reading
  its text, then a hand check of every positive.
- **Result.** 73 are security defects and 101 more are borderline. That is
  1.6 % of all items, or 3.9 % with the borderline ones.
- **Caveat.** These were judged from the item text, not re-derived from the
  code.

| Proposed lens | yes | yes + borderline | Dominant CWEs |
|---|---|---|---|
| `pass-sec-access` | 22 | 42 | 863, 352, 639, 862 |
| `pass-sec-secrets-data` | 20 | 30 | 532, 316/528, 312, 200 |
| `pass-sec-injection` | 10 | 16 | 89, 79, 78 |
| `pass-bounds` | 9 | 46 | 787, 476 (C/C++ heavy) |
| `pass-sec-boundaries` | 7 | 16 | 22, 918 |
| `pass-sec-variant` | 4 | 5 | incomplete fixes of a leak |
| `pass-sec-llm` | 1 | 2 | — |
| `pass-sec-supply-chain` | 0 | 2 | — |

- **Absence defects (a missing check)** are 29 of the 73.
- **The path-only trigger (G2) is confirmed as the main gap.** Replaying
  `heuristics.ts:308-319` on each PR's file list:
  - It does **not fire for 44 of the 73 (60 %)**.
  - Of the 29 where it fires, 11 fire only because a manifest was touched.
  - So **75 % of security defects sit in PRs with no security-shaped
    path**.
  - The stored runs agree: `pass-security` was planned on 29 of these PRs
    and not on 42.
- **Labels undercount.** AACR `kind: security` misses 9 of our 22 (five of
  them incomplete fixes). Martian labels 3 of its security items `bug`.
- **The supply-chain and LLM lenses have almost no benchmark ground truth.**
  Measuring them needs MalPR-Bench or our own seeded cases. Note that
  "no benchmark ground truth" is not the same as "no value".

### 9.2 Fates of the security findings we raised

Covered:
- 297 benchmark runs (4,750 findings records).
- 909 production rounds over 368 PRs.
- The deep self-scan.

Counting is by root cause, as in `lens_yield.py`.

- **Of 2,473 root causes from `pass-security`/`pass-bounds`:**
  - 56 % were posted as blockers, 29 % as questions and 2 % as nits.
  - **4.0 % were hidden**, against about 9 % for findings from all lenses.
  - In production, hidden rises to **15.4 %**. In the cheap-model arms it
    is 21–27 %.
- **G3 is real.** About **35 % of "can't confirm" security outcomes take
  the hidden `doubted/unverifiable` route** (17 root causes) instead of
  `security-demoted` (31).
- **`security-demoted` does post**, but the session often omits
  `posted_as`. The record therefore counts posted questions as unposted
  (43 of 49 bench downgrades are in fact in `comments.json`). This is a
  findingsrecord bug in its own right: any metric built on the record alone
  understates what reached the author.
- **The two largest suppressors are not G3:**
  - **`refuted` because the PR description says the behaviour is
    intended.** This is 10 of 53 hidden bench groups and **23 of 50 hidden
    production groups**. It is the SEVRA failure in our own data, and it
    supports the §4.4 rule "the PR text is untrusted for security claims".
  - **Pre-existing code (G5).** This is 15 of 53 bench and 12 of 50
    production groups. They include a tenant check, a callback `state`
    newly reachable through a new surface, and a room joined with no role
    check. All three look real.
- **The reachability cap** turned 545 of 714 security questions from would-be
  blockers into questions. They are demoted, not hidden.
- **The posting policy** withheld only 7.
- **Real defects we found and then hid.** Of the 82 judged misses of
  ground-truth security defects, **at least 7 (about 9 %) were raised and
  then hidden**, plus 3 of 6 partials:
  - ClickHouse D2 was doubted as `unverifiable` because a submodule was
    absent. This is G3 exactly.
  - LocalAI D2 was refuted in 5 runs because "the author advertises the
    default". That is PR intent used as counterevidence.
  - linera D1 was killed `out-of-scope`, wrongly: the loop is new.
  - In one case demotion worked: elasticsearch D1 was posted as a
    question and got partial credit.
- **The deep self-scan planned no security lens.**
  - Its security-shaped findings came from other lenses: 122 in all, of
    which 40 were confirmed, 49 likely and 33 doubtful.
  - 19 of the 33 doubtful are `same-principal`, which looks right for an
    operator tool.

### 9.3 What this changes in the plan

1. **M3 (content triggers) is the largest single recall lever.** It is
   bigger than any validator change: three quarters of security defects never
   get a security lens planned.
2. **Two validator rules rise in priority above the G3 fold**, and should
   ride with M5:
   - "PR intent is not counterevidence for a security claim."
   - "A pre-existing sink is in scope when the PR adds a path to it."
3. **The `posted_as` record bug is a prerequisite for measuring any of
   this.** Fix it before the first evaluation run.
4. **The data supports `pass-sec-access`, `-secrets-data`, `-injection` and
   `-boundaries` directly.** `-variant`, `-supply-chain` and `-llm` rest on
   the research rather than on our ground truth.

## 10. The original decision options (kept for the record)

1. **Split lenses or one deeper lens?** Seven separate passes buy recall
   through diversity, at roughly 3–5× the security cost per PR. The
   alternative is one `pass-security` that walks per-class rubrics
   internally. The recommendation is the split for the security profile and
   the single lens with content triggers for the default.
2. **Should the security fold (M5) apply in the default profile too?** It
   restores what the seed already promises. The recommendation is yes.
3. **Should security questions bypass `snappy`'s question filter** in every
   profile, or only in `security`?
4. **Threat-model home:** the reviewed repo (`.qcr/threat-model.md`, visible
   to its team) or the install's profile (private to the operator)?
5. **Which benchmark run goes first**, and when (§7). No run is started
   without a go.

## 11. Deep lenses (owner request 2026-11-02)

The owner asked for more depth on six things:
- security infrastructure: firewalls set up **and** actually up;
- exploit-chain construction, by several strategies;
- privilege escalation;
- token rotation;
- APIs that do not check tokens;
- TOCTOU, unprotected admin overrides, and weakly protected but permitted
  escalation.

A workflow drafted each lens, put it through a red-team critic and a
precision critic, revised it, and then had it checked for completeness. The
drafts are in [`lenses/`](lenses/). Each has two parts:
- **Part A** is the lens as it would ship in `agents/`.
- **Part B** holds the design notes: triggers, validator guidance, overlaps,
  incidents, the limits of a read-only reviewer, evaluation, and a critique
  log.

[`lenses/SYNTHESIS.md`](lenses/SYNTHESIS.md) has the full overlap matrix and
the orchestration. [`lenses/COVERAGE-AUDIT.md`](lenses/COVERAGE-AUDIT.md) has
the gaps found before revision 2.

### 11.1 Roster for the security profile

| Lens | Remit |
|---|---|
| `pass-sec-authn-coverage` | Every entry point × its *effective* authentication and function-level authz. Covers: matcher vs router, public-path allowlists that over-match, method gaps, normalisation bypasses, middleware that fails open, a check whose result does not stop the request, new endpoints without their siblings' guard. |
| `pass-sec-access` (narrowed) | Can this principal touch this object? Covers IDOR/BOLA, tenant keys, ordinary mass assignment, and CSRF/CORS/framing. |
| `pass-sec-privesc` | The application role model. Covers grant sinks, grant ceilings, self-grant, invite/SSO/SCIM binding, the first-user bootstrap, override inputs (`?admin=`, `force`, identity headers), **security-setting writes** (MFA off, SSO replaced, allowed domains), and **weakly protected permitted escalation**: no step-up, approval or audit, judged against the threat model or sibling precedent. |
| `pass-sec-iam` (new) | The platform grant graph. Covers cloud IAM escalation primitives, trust and federation (the CI OIDC `sub`/`aud`, WIF), k8s RBAC `escalate`/`bind`/`impersonate`, sudoers/setcap, and the docker group. |
| `pass-sec-tokens` | Verification, claims, lifecycle, **rotation and key rollover in code**, revocation on account events, single-use tokens, account recovery and the MFA lifecycle, OAuth/OIDC/SAML, webhook signatures. |
| `pass-sec-toctou` | A check and its use bound to different state, time or representation, with a concrete recipe for an attacker-driven second actor. Covers parallel redemption, limit overruns, uniqueness kept only in app code, symlink swaps, parser differentials. |
| `pass-sec-infra` | Who can reach what. Each network control is checked down the chain declared → enabled → attached → selects → covers → precedence → enforced → persists → per-environment; plus exposure and runtime privilege. **It establishes "in force in the config this repo ships", never "running right now"**. When live state is load-bearing it asks it as a `P3` question (`security:live-state`) naming the live fact. |
| `pass-sec-exploit-chain` | Compositions of 2–6 hops to a goal above the persona's starting authority, every hop cited. Four strategies run as separate rows: `delta` (the hop this PR adds), `forward` (persona × entry point), `backward` (from the crown jewels), and `compose` (post-discovery, over this round's security leads). |
| `pass-sec-injection`, `-boundaries`, `-secrets-data`, `-supply-chain`, `-llm`, `-variant` | As in §3. |
| `pass-bounds`, `pass-concurrency` | Unchanged. Races with a security effect defer to `pass-sec-toctou`. |

**Ownership rule.** The lens whose fix closes the defect owns it. A grant
route with no authentication belongs to authn-coverage; a weak role gate
belongs to privesc. A role held in a credential belongs to tokens; one held
in a server cache belongs to privesc. The chain lens owns only compositions.
It cites the class lenses' rows and never re-posts them.

### 11.2 How exploit chains run (verified against the code)

The design keeps the single-shepherd invariant: the daemon renders a note
and schedules nothing, and lenses stay leaves.

- **`delta`, `forward` and `backward`** are ordinary discovery-wave rows,
  one `PassPlanEntry` per strategy. They run at the risk tier, slowest
  first, so they add no latency.
- **`compose`** is a post-discovery row that the engine's wave skips. A
  `{{chain_note}}` (modelled on `renderCoverageNote`, `templates.ts:663`)
  tells the main session to do three things after every lens has returned
  and before validation:
  1. collect the security-family candidates as `CHAIN LEADS`;
  2. launch one `compose` run;
  3. log `CHAIN-SKIPPED` when there are no leads.
- **The validator checks the leads first, then labels each hop**
  valid / plausible / contradicted. The code computes the outcome from those
  labels:

  | Hop labels | Outcome |
  |---|---|
  | all valid | confirmed |
  | exactly one plausible | question naming that hop |
  | two or more plausible | `partial-chain`: stored, never posted, fed to the next round's `delta` |
  | any contradicted | refuted |

  A chain is never merged into its leads, and it stays in the same
  validator shard as them.
- **Only `delta` is a required row.** The other strategies report "did not
  complete" in the review body. If they were required, a failed `compose`
  would requeue the whole round (`requiredpasses.ts`).

### 11.3 More mechanism changes (beyond M1–M10)

The full table, with seams and the mutation each fence names, is in
`lenses/SYNTHESIS.md` §5. In short:

- **M11** — a shared `prompts/pass-sec-common.md` with the evidence block,
  the outcomes, the exclusions and the severity matrix.
- **M12/M13** — trigger probes on removed lines and on config files. A
  `-login_required` hunk must plan a lens.
- **M14–M16** — chain strategy rows, required-per-row, and `{{chain_note}}`.
- **M17/M18** — an evidence parser that computes the outcome in code, and
  the `partial-chain` state.
- **M19/M20** — validator addenda for chains and for counterevidence that
  does not count; a scan-skeptic carve-out for attacker-driven races.
- **M21** — threat-model fields: personas, crown jewels, network controls,
  DB isolation, token TTLs.
- **M22** — deterministic security pre-checks rendered as gate notes, in
  the manner of `ecosystem.ts`: a removed guard, a role-enum shift,
  uniqueness without an index, an unattached SG, a compose port on a ufw
  host, a NetworkPolicy selector mismatch, a static route inventory. These
  are the "is it really in force" checks a model reading the diff cannot
  settle.
- **M23** — a per-strategy telemetry tag.
- **M24** — the security profile swaps `pass-security` out, which touches
  `risk_passes` and `skip_lenses`.
- **M25** — a trigger-rate replay over archived PR file lists, with no model
  calls, to replace the estimated plan frequencies.

**Estimated cost.** The plan frequencies come from the synthesis and are not
yet measured; M25 measures them. The security profile adds about 2–3
risk-tier lens runs per PR on average: 4–6 on a PR that fires a trigger,
up to about 10 on a large auth PR. Add one serial `compose` run where leads
exist.

### 11.4 Still uncovered, by design or for later

- **Business-logic abuse that is not a race:** a client-set price, a
  skipped workflow step, stacked coupons (ASVS V2.3, CWE-840/841).
- **Tenant isolation outside the request path:** background jobs, exports,
  search indexes, websocket rooms.
- **Audit-trail integrity:** privileged actions with no audit record, and
  admins able to delete audit logs. Infra covers detaching an existing audit
  sink, and privesc covers audit-log deletion as a security-setting write.
- **Live state of controls.** It needs an out-of-band check, proposed in the
  infra draft's Part B.

### 11.5 Decisions needed

1. **Replace `pass-security` in the security profile** with the family.
   This needs ratifying against keep-all-lenses: the lens stays in the
   default profile.
2. **Required rows.** Only chain `delta` is required.
3. **Deterministic pre-checks (M22).** One option reads CI-rendered
   `terraform show -json` or `helm template` output. That is a
   new-dependency decision.
4. **Scan cost.** Infra and chain `forward`/`backward` join the scan's deep
   floor only when the inventory finds network or IAM resources. Is that
   narrower trigger acceptable?
5. **Who owns OAuth `state`?** The tokens lens treats it as token binding;
   the CSRF ruling would give it to access.
6. **Database roles.** Migration `GRANT` and role membership go to iam,
   which has no SQL `GRANT` trigger yet. A `GRANT` issued at request time
   goes to privesc. The RLS predicate goes to access, and RLS switched off
   on an exposed table goes to authn-coverage. Not yet ratified.
7. **A service-account token automounted with a broad role.** Tokens hands
   it to infra, but infra excludes automount as hardening. One of the two
   must report it.
8. **Field names for the M17 parser.** `delta:` and `window:` mean different
   things in different drafts. Rename them before building the shared
   parser.

Status after revision 2: there are seven deep drafts in `lenses/`. A
consistency pass aligned their ownership statements, the evidence-block
field names and the outcome names. Each Part A is about 220–240 lines,
slightly over the 230-line target. `SYNTHESIS.md` and `COVERAGE-AUDIT.md`
describe the state *before* revision 2.
