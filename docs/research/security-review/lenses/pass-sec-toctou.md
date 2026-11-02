---
name: pass-sec-toctou
description: Security TOCTOU and race pass — a security decision is checked on one state, object or representation and acted on another, and the attacker can act in the gap. Covers parallel and batched limit overruns, single-use tokens redeemed twice, uniqueness and upserts that do not hold, check/use binding mismatches, provider-retried webhooks, privileged check-then-open, and CI gates followed by a mutable-ref checkout. Every finding carries a recipe and the serializer it hunted.
tools: read, bash, grep, glob
---

{{include:prompts/pass-common.md}}

# Lens: security time-of-check / time-of-use

Apply to: code where a **security decision** (allowed, unused, unique,
under limit, paid, approved) is made on one state and the **effect** it
protects (spend, grant, create, redeem, fulfil, run) happens on another,
with an attacker who can act in between. Not yours: races with no security
effect (`pass-concurrency`), a missing check (`pass-sec-authn-coverage`
on an entry point, `pass-sec-access` on an object), a role cached past
demotion (`pass-sec-privesc` in a server cache, `pass-sec-tokens` in a
credential), a token or socket outliving
revocation (`pass-sec-tokens`), SSRF and rebinding (`pass-sec-boundaries`).

No window is too short: a single-packet attack lands 20–30 requests within
about 1 ms, so one DB round trip or one `await` between check and write is
hittable. The converse holds: on a single-threaded runtime with no `await`,
I/O or yield between check and write, the row is dead.

## Worksheet — fill it in your notes before writing any finding

1. **Guarded effects and their writers.** One row per effect a check
   protects in the diff and its blast radius, plus each effect whose
   serializer the diff removes. Kinds: value created per win (credit, gift
   card, coupon, trial, payout); single-use artefacts (reset, confirm,
   invite tokens, OAuth codes, refresh tokens, idempotency keys, webhook
   event ids); identity keys; role grants; attempt counters guarding a
   secret. **Grep every writer** of the guarded column or key (ORM, raw
   SQL, admin actions, jobs, imports, webhook handlers) and list them. Add
   the **inverse operations** (refund, cancel, prorated downgrade, undo):
   race each against itself and against its forward operation.
2. **Check and use.** For each row, the CHECK site — traced into the
   middleware, decorator or policy object that really decides — and the USE
   site, and what each **binds to**: row + version, the loaded object or a
   re-fetch by another key, the value the token was issued for or what is
   pending now, a session field, a re-registrable name, a replica or the
   primary, a key or its version id, a branch or a SHA. Same immutable
   thing in one atomic step → dead.
3. **The window**, measured from where the state is fixed: the check line
   under READ COMMITTED, the transaction's **first read** under REPEATABLE
   READ or snapshot isolation. List each DB round trip, `await`, outbound
   call, password-hash compare before an attempt counter increments, second
   request in the flow, queue hop. Empty → cross out.
4. **The second actor.** For each writer from step 1, can the attacker
   invoke it inside the window? Means: the same endpoint N times in
   parallel; one request carrying many operations (GraphQL aliases
   `a1: redeem(c) … a50: redeem(c)`, batched arrays, bulk endpoints); a
   sibling writer (change email × confirm, leave org × accept invite,
   refund × ship); step 1 of a flow rerun on the same session cookie; an
   inbound webhook's provider retries and reordering; a `git push` after a
   gate; a lower-privileged principal swapping a path or rewriting a key.
   Name the principal and whether they choose the timing. Only an operator,
   an admin or nobody → excluded.
5. **Hunt the serializer** in the **final** migration state, including
   inherited models and library migrations (Django `AbstractUser.username`,
   Devise's email index, ASP.NET Identity's `NormalizedUserName`). Record
   each place you looked. It counts only when atomic **on the same key**:
   - a conditional write whose result is read: `UPDATE … WHERE used = false`
     with the row count checked, `findOneAndUpdate` with the guard in the
     filter, `DELETE … RETURNING`, DynamoDB `ConditionExpression`, Redis
     `SET NX` / `GETDEL` / `INCR` with the result compared;
   - a lock on that row, in the same transaction, taken before the check;
   - a DB constraint whose violation is neither swallowed nor caught and
     followed by a fetch of the existing row;
   - `SERIALIZABLE` with a retry loop.
   For a constraint, also check: the indexed column is the one the lookup
   uses (`email` vs `normalized_email`); folding matches (`citext`, a
   `lower()` index, a collation); NULLs — Postgres treats them as distinct
   unless `NULLS NOT DISTINCT`, so `UNIQUE(org_id, email)` with a null
   `org_id` holds nothing; a partial predicate (`WHERE deleted_at IS NULL`)
   against restore; no later migration drops it.
6. **Representations.** When check and use read different forms of one
   input — normalisation, case or Unicode folding, array vs scalar
   (`param[]=`), `null` vs missing, number vs string id, duplicate keys
   across two parsers — name one concrete disagreeing input and show the
   disagreement from library source in the worktree or `depsources`, or
   from a cited advisory. Recalled from memory → no row.
7. **The recipe.** Steps ending on gain per win × wins per burst ("one
   POST with 50 aliased `redeem(code)` → 50 credits"), and whether anything
   cited reverses the effect later (refund, reconciliation). Cannot write
   it → no finding; blocked by one named fact → a question.

## Shapes to recognise

- **Not serializers** — the counterintuitive part:
  - a transaction at READ COMMITTED, or a plain `SELECT` under MySQL
    REPEATABLE READ (a snapshot read, no lock);
  - a locking read matching zero rows: Postgres locks exactly the rows
    returned, so `select_for_update().filter(…).exists()` → `create()`
    locks nothing; exists-then-insert needs a unique index or a lock on
    the parent row;
  - a lock in process memory (`threading.Lock`, `sync.Mutex`,
    `asyncio.Lock`, `async-mutex`, a module-level set) unless the repo pins
    one process for the whole service; "we run one worker" is not that;
  - a TTL lock (`SET NX PX`, Redlock) used as a mutex around a section that
    can outlive the TTL, with no fencing token checked at the write; a
    session advisory lock behind PgBouncer transaction pooling (`SET NX` as
    a consume marker is fine);
  - a replica read (`using('replica')`, a DB router, `connects_to reading:`)
    as the check for a primary write;
  - a self-invoked `@Transactional`; `select_for_update` on SQLite; a bulk
    update past `@Version`; Node across an `await`; the GIL; a UI debounce.
- **Uniqueness that does not hold**: model validators (Rails
  `uniqueness:`, DRF `UniqueValidator`), `get_or_create` and kin without an
  index, a pre-insert `exists()`, any step-5 index failure. In scope only when a
  reader resolves the identity by **first match** (login, reset or account
  link via `.first()`, `LIMIT 1`, `find_by`) — cite it. Without that
  reader a duplicate is `pass-concurrency`'s.
- **Conflict handler that hands over the row**: `ON CONFLICT (email) DO
  UPDATE SET password_hash = EXCLUDED.password_hash`; an upsert that sets
  owner or role; `get_or_create` that catches `IntegrityError` and returns
  the existing row to a new principal. Read the conflict clause: this is a
  finding, not a serializer.
- **Single-use, idempotency, webhooks**: a token looked up, then marked
  used in a later statement; a refresh token rotated as read → insert →
  delete; an idempotency key stored after the side effect, or not bound to
  parameters and principal; an inbound webhook whose value-creating effect
  (`credits += n`, plan activation) has no unique `event.id` insert before
  it, or applies a transition without checking the provider's current
  object or version (`subscription.deleted` handled before `.updated`
  leaves the plan active).
- **Check and use bound to different things**:
  - a confirm handler applying the value pending now, not the one the
    token was issued for (GitLab's email-change race);
  - a payment or approval fixed to an amount or item set, then fulfilment
    of the cart or plan as it is at completion (a second tab adds items);
    a `success_url` handler that marks the order paid;
  - a multi-step flow keeping its subject in the session
    (`session['reset_uid']`) while step 1 reruns on the same cookie;
  - an allowlist keyed by a name that can be re-registered after a rename
    (GitHub login, repo name) rather than the numeric id;
  - a worker that loads by id a row the attacker can change between
    enqueue and run;
  - an upload scanned or type-checked by object key, then served while a
    presigned PUT can still overwrite that key;
  - partial construction: a row whose secret, owner or MFA flag is set by a
    later statement, so an empty or `null` comparison passes in between.
- **Privileged check-then-open**: `access`/`stat`/`EvalSymlinks` then open
  by name, `mktemp -u`, a root cleanup walking a directory a lower
  principal writes — only with the privilege gap shown in code (setuid, a
  root entrypoint or daemon, `/tmp` or a shared volume). Safe: `O_EXCL`,
  `O_NOFOLLOW`, dirfd-relative opens, `os.Root`, `mkstemp`.
- **CI gate, then a mutable ref**: `pull_request_target`, `workflow_run` or
  `issue_comment` (`/deploy`) gated by a label, environment or comment,
  then checking out `head.ref` or `refs/pull/N/head`, not the SHA the
  approver saw. The fork author pushes after the gate.

## Evidence block — every finding carries it in `evidence`

```
source:       <file:line> — <what the attacker controls>, trust: untrusted|tenant|operator|first-party
boundary:     <which trust boundary is crossed>
sink:         <file:line> — <the guarded effect>, binds to <…>
path:         <hops, each file:line>  (gaps marked "?")
controls:     <serializers hunted, where (file:line or "searched: <globs>"), why none covers this key and window>
cwe:          CWE-367 | 362 | 59 | 377 | 436
proof-gaps:   <the smallest fact(s) that, if false, kill the finding>
check-site:   <file:line> — binds to <row+version | object | representation | name | ref>
window:       <what runs between, one item per hop, from where the state is fixed>
second-actor: <principal> via <parallel | aliases/batch | sibling writer | session rerun | provider retry | git push | fs swap>
recipe:       <the steps, N per burst, gain per win, reversed later? by what>
```

## Outcomes

- **Confirmed**: every line filled from code you read.
- **Plausible → `[question]`**: only `proof-gaps` facts lie outside the
  repo (an isolation level in an out-of-repo DSN, worker or replica counts,
  runtime directory ownership, the schema of a table **whose migrations
  are not in the repo**). If the repo holds the table's migrations, their
  absence is evidence: confirm, do not ask. Name one fact and its effect.
- **No finding**: the serializer exists (say where), the second actor is
  not the attacker, the recipe cannot be written, or no disagreeing input
  is shown. Do not keep a dead row alive as a question.

Excluded: duplicates with no security effect; contention or deadlock as
DoS; a missing rate limit (a race past an **implemented** attempt counter
guarding a secret is in scope); a second redemption that yields nothing new
(the holder reusing their own reset token, a stateless token that dies on
use) unless each win is a separate gain or the token binds to a mutable
value; overruns where the attacker pays per unit (overselling stock) and
soft quotas; serializers held downstream (an OAuth library's atomic code
consume, a provider idempotency key passed through); windows needing a
victim or admin to act at a moment the attacker cannot choose; tests,
fixtures, seeds, management commands, dev-only settings.

## Severity — impact × exposure, never "unlikely in practice"

Exposure: remote unauthenticated (any self-registered account counts) >
remote authenticated > tenant-internal > local.

| Effect | Remote unauth / self-registered | Authenticated / invited | Tenant-internal or local |
|---|---|---|---|
| Account takeover (twin identity read by first match, conflict handler handing over the row, confirm applying a pending value) | P0 | P0 | P1 |
| Value created per win, repeatable, nothing reverses it | P0 | P1 | P2 |
| Value created per win, reversed by a reconciliation you cite | P2 | P2 | P3 |
| Code run with secrets (CI ref swap after a gate) | P0 (fork author) | P1 | — |
| Single-use invite, trial or grant multiplied | P1 | P1/P2 by what it grants | P2 |
| Privileged process steered by a path swap | — | — | P1 on shared hosts, runners, shared volumes; P2 otherwise |

Reachability: `routine` when the attacker alone controls the parallelism
(never lowered for a millisecond window); `plausible` when it also needs a
natural event (a provider retry); `contrived` only with a privileged
co-actor.

## Finding form

`claim` names the effect and the doubled or wrong outcome. `detail` holds
the interleaving (A checks · B checks · A acts · B acts → result), the
recipe and the **serializer that restores the invariant** (database-level
where possible, else a fencing token, a descriptor-relative open, a SHA
pin) — the protection, not the rewrite. Anchor at the check or use in the
diff, or at the removed serializer. `NONE` when every row died in steps
2–6; say which serializer killed each.

---

## Design notes (not part of the lens)

### Planning triggers

The security profile plans the lens **on trigger, never always**. A race
has no filename (the existing `pass-concurrency` comment in
`heuristics.ts` already rules this), so content probes lead. Probes run on
changed lines, added **or removed**, of non-test code: dropping a lock
opens a window.

1. **Content probes.**
   - *Guarded-asset words* (the gate for the serializer and deferred
     probes below):
     `token|role|admin|balance|credits?|wallet|invite|coupon|voucher|gift_?card|redeem|referral|trial|payout|refund|\botp\b|password|pending_email|unconfirmed_email|email_change`
   - *Serializers, added or dropped* — plan this lens only when the same
     hunk also matches a guarded-asset word; otherwise they stay
     `pass-concurrency`'s (whose Python probe already holds
     `select_for_update(`):
     `select_for_update|with_for_update|lockForUpdate|FOR UPDATE|SKIP LOCKED|\block!|with_lock|lock_version|LockModeType|PESSIMISTIC_|@Version\b|ConcurrencyCheck|\[Timestamp\]|setLock\(|clause\.Locking|SERIALIZABLE|isolation_level|isolationLevel|ISOLATION LEVEL|@Transactional|\$transaction|RETURNING|ConditionExpression|runTransaction|\bSETNX\b|\bNX\b|GETDEL|\bWATCH\b|increment!|update_counters|\$inc\b`
   - *Uniqueness* (always):
     `get_or_create|find_or_create_by|first_or_create|FirstOrCreate|findOrCreate|upsert|ON CONFLICT|UniqueConstraint|unique\s*[:=]\s*(?:True|true)|add_index[^\n]*unique|uniqueness:|UniqueValidator|validate_unique|NULLS NOT DISTINCT|IntegrityError`
   - *Single-use and consume flags* (always):
     `idempoten|Idempotency-Key|single[_-]?use|one[_-]?time|used_at|\bused\s*=\s*(?:True|true)|is_used|redeemed|claimed|consum(?:e|ed)_?at|\bnonce\b|reset_token|invite_token|pending_email|unconfirmed_email|email_change|event_id|event\.id`.
     `refresh_token` counts only with `insert|create|delete|revoke|rotat`
     in the same hunk, so OAuth clients do not plan it.
   - *Read then write*: `findOne|findUnique|findFirst|find_by|\.get\(`
     followed in the same function by `save|update|create`, gated on an
     asset word; counters
     `\b(?:credits?|quota|stock|seats?|max_uses|uses_count|attempts?)\b\s*(?:[-+]=|=\s*\w+\s*[-+])`.
   - *Representation*:
     `NFKC|NFKD|casefold|unicodedata\.normalize|(?:email|username|login)\w*\.(?:lower|casefold|strip|toLowerCase)\(|rawBody|raw_body`.
   - *Enqueue*: `\.delay\(|apply_async|perform_later|perform_async|enqueue|add_task|@Async|queue\.add\(`,
     gated on an asset word.
   - *Privileged filesystem*:
     `os\.access\(|os\.path\.(?:exists|islink)\(|fs\.(?:access|exists|stat|lstat)(?:Sync)?\(|EvalSymlinks|mktemp\s+-u|tempfile\.mktemp\(`
     only when the file, its Dockerfile or its unit matches
     `setuid|setgid|chown|/tmp/|^USER\s+root|geteuid|User=root`.
   - *CI*: `pull_request_target|workflow_run|issue_comment` together with
     `head\.ref|refs/pull/|github\.event\.issue\.number|environment:|labels`
     in `.github/workflows/*.y*ml`. When a CodeQL
     `actions/untrusted-checkout-toctou` result exists, it is passed in as
     a lead.
2. **Path globs** (secondary, only with a changed write in the file):
   `**/{payments,billing,wallet,credits,coupons,promo*,voucher*,giftcard*,referral*,invite*,redeem*,payout*,refund*,withdraw*,webhooks}/**`,
   `**/*{password_reset,reset_password,email_confirm,confirm_email,magic_link,otp,mfa,invite,redeem,idempot}*`
   excluding `*.{tsx,jsx,vue,svelte,css,scss}`, and `**/migrations/**` when
   a migration drops a unique index or constraint.
3. **PR text**:
   `double[- ]spend|race condition|\btoctou\b|\bracy\b|idempot|single[- ]use|redeem|coupon|duplicate account`.
   This adds to `CONCURRENCY_TEXT_RE`; both lenses may fire and split by
   security effect.

The threat model (§5) also plans the lens: an asset of kind "limited
quantity", "single-use credential" or "identity key" lists the paths and
symbols that write it, and a PR touching those plans the lens. In scan,
those paths join the deep floor's stage-2 rows for this lens.

### Validator guidance

Re-derive each evidence line by reading. Per claim type, the **valid
counterevidence** and what **must not** be accepted:

| Claim | Refuted by (cite file:line) | Not counterevidence |
|---|---|---|
| Check-then-act on a row or counter | A conditional write whose result is read. A lock on the same row, same transaction, before the check. `SERIALIZABLE` with retry. A DB constraint (`CHECK balance >= 0`, unique) whose failure is not swallowed. | "It is in a transaction" at READ COMMITTED. A lock on another row, or a locking read matching zero rows. "The lock is held" when it is in-process or a TTL lock with no fencing token. "Runs as one process" / "one replica". A replica read. `select_for_update` on SQLite. A self-invoked `@Transactional`. A mocked-DB test passing. "Low traffic", "requests are fast", "Node is single-threaded" (across an `await`), a frontend debounce. |
| Uniqueness | A unique index or constraint in the final migration state, inherited model or library migration, on the column the lookup uses, with the same folding, NULL semantics that cover the case, and no partial predicate the flow escapes. | A model validator. `get_or_create` without an index. "An index exists" without the column, NULL, partial and later-migration checks. "An upsert is used" without reading its conflict clause. An index named only in PR text. |
| Conflict handler hands over the row | The conflict clause updates no credential, owner or role, and the existing row is not returned to the new principal. | "Upserts are atomic." |
| Single-use / webhook double effect | An atomic consume before the effect (`DELETE … RETURNING`, conditional update with count, `GETDEL`, `SET NX`, a unique `event_id` insert). For ordering: a check against the provider's current object or a version. | Expiry alone. "Tokens are random." Marking used after the effect. "The provider sends each event once." |
| Check/use binding mismatch | The use reads the very value the check produced, or the token, payment or approval binds the exact value applied; names resolved by immutable id. | Both sites reading "the same table". |
| Representation differential | One parser instance or one stored canonical form reused; the disagreeing input rejected before the check, shown in source. | "Both are JSON." "The library is popular." |
| Privileged filesystem | The directory is writable only by the same principal (mode, owner, container `USER`, volume). Descriptor-relative opens, `O_NOFOLLOW`, `O_EXCL`, `os.Root`, `mkstemp`, `PrivateTmp`. | `realpath` or `islink` checked first. "Tmp is cleaned on boot." |
| CI mutable ref | Checkout of `head.sha` or a SHA captured at the gate; a trigger on `labeled` together with SHA use. | "Only maintainers comment or label." "Environments need approval" (that is the gate being raced). |

Rules on top of the table:
- **Security carve-out for the scan skeptic.** The `doubtful` clause in
  `include.ts` (scan skeptic, "the trigger needs a model's or a person's
  action to land inside a window of seconds (`[contrived-concurrency]`)")
  must not apply when the `second-actor` is the attacker sending requests,
  aliases or retries they control. Proposed added sentence: "This never
  covers a window the attacker fills with requests they send themselves
  (parallel, batched or aliased); such a race is `routine` however short
  the window." The class text at the `contrived-concurrency` entry (no
  `await` between synchronous statements) stays as it is and matches the
  lens's own converse rule.
- A `refuted` verdict cites the serializer's `file:line`. A race's absence
  from tests is not evidence.

### Overlap and boundaries

- **pass-concurrency** owns races whose damage is lost or duplicated data;
  this lens owns races with a security effect. The serializer probes
  plan this lens only with an asset word in the hunk, so an inventory
  refactor plans concurrency alone. On a shared site, this lens anchors.
- **pass-sec-authn-coverage** owns a missing authentication or
  function-level check, including alternate entry points that skip it;
  **pass-sec-access** owns a missing object-level check. This lens owns a
  check that exists but binds to another object, time or representation.
- **pass-sec-privesc** owns the grant path and stale authority held
  server-side (a role in a server cache after demotion; a recurring job
  still running for a removed member); a role held in a credential (JWT
  claim, session field) is **pass-sec-tokens**'s. This lens owns the invite-accept and
  last-admin races and a job whose arguments the attacker mutates between
  enqueue and run.
- **pass-sec-tokens** owns token lifecycle: whether a token is single-use
  at all, expiry, rotation design, revocation, long-lived connections that
  outlive it, and SSO linking by a mutable claim. This lens owns a declared
  single-use or rotation that two parallel calls both pass.
- **pass-sec-authn-coverage** owns routes that never check a token. This
  lens owns partial construction and the MFA half-state.
- **pass-sec-boundaries** owns canonicalisation order, SSRF including DNS
  rebinding, and symlink following in general. This lens takes the path
  only when a privileged process checks then opens it and a lower principal
  can swap it.
- **pass-sec-infra** and **pass-sec-supply-chain** own workflow and IaC
  hygiene: unpinned actions, digest-vs-tag deploys, unsaved Terraform
  plans, admission policies that skip a verb, and boot-order windows. This
  lens owns only a gate followed by a mutable-ref checkout.
- **pass-sec-exploit-chain** consumes this lens's confirmed and plausible
  rows as chain links (a race is often the link that turns one invite into
  admin).
- **pass-sec-variant** takes the serializer fixes as seeds for sibling
  `get_or_create` sites and other token types.
- **pass-security** (the default profile) has no race rubric. Candidate:
  plan this lens there too when the uniqueness or single-use probes fire.
- **pass-bounds** owns size limits; a limit overrun via parallelism is this
  lens's.

### Motivating incidents and sources

- **Primary references.**
  - Kettle, "Smashing the state machine": the single-packet attack, the
    race classes, GitLab email confirmation sent to the wrong address
    (CVE-2022-4037). https://portswigger.net/research/smashing-the-state-machine
  - PortSwigger Academy: partial construction, MFA half-state, PHP
    session locking. https://portswigger.net/web-security/race-conditions
  - OWASP ASVS 5.0 V2.3.3 (atomic business operations), V2.3.4 (locking
    for limited-quantity resources).
    https://cornucopia.owasp.org/taxonomy/asvs-5.0/02-validation-and-business-logic/03-business-logic-security
  - OWASP GraphQL Cheat Sheet, batching attacks: many operations in one
    request bypass request-counting limits.
    https://cheatsheetseries.owasp.org/cheatsheets/GraphQL_Cheat_Sheet.html
  - CWE-367 https://cwe.mitre.org/data/definitions/367.html ·
    CWE-362 https://cwe.mitre.org/data/definitions/362.html ·
    CWE-436 https://cwe.mitre.org/data/definitions/436.html ·
    CAPEC-29 https://capec.mitre.org/data/definitions/29.html
- **Serializer semantics.**
  - Postgres locking clause: "the rows that are locked are exactly those
    that are returned by the query", so a zero-row locking read locks
    nothing. https://www.postgresql.org/docs/current/sql-select.html#SQL-FOR-UPDATE-SHARE
  - Postgres unique indexes: NULLs are distinct unless `NULLS NOT
    DISTINCT`. https://www.postgresql.org/docs/current/indexes-unique.html
  - Postgres isolation: READ COMMITTED re-checks the WHERE; serialization
    failures must be retried. https://www.postgresql.org/docs/current/transaction-iso.html
  - Kleppmann, distributed locking: a TTL lock needs a fencing token.
    https://martin.kleppmann.com/2016/02/08/how-to-do-distributed-locking.html
  - Django `select_for_update`: raises in autocommit, no effect on SQLite.
    https://docs.djangoproject.com/en/5.2/ref/models/querysets/#select-for-update
  - Rails `validates_uniqueness_of`: app-level uniqueness is "inherently
    prone to race conditions".
    https://api.rubyonrails.org/classes/ActiveRecord/Validations/ClassMethods.html
  - Stripe webhooks: events may arrive more than once and out of order;
    track event ids. https://docs.stripe.com/webhooks#handle-duplicate-events ·
    https://docs.stripe.com/webhooks#event-ordering
  - Stripe idempotency keys: same-key requests compare parameters.
    https://docs.stripe.com/api/idempotent_requests
  - RFC 6749 §4.1.2 (single-use code) https://www.rfc-editor.org/rfc/rfc6749#section-4.1.2 ·
    RFC 9700 (refresh-token rotation) https://www.rfc-editor.org/rfc/rfc9700
- **Incidents and CVEs.**
  - anything-llm CVE-2024-2913: one invite accepted concurrently created
    several accounts. https://www.cve.org/CVERecord?id=CVE-2024-2913
  - HackerOne #759247: a gift card loaded several times in parallel.
    https://hackerone.com/reports/759247
  - Starbucks gift-card transfer race (2015).
    https://sakurity.com/blog/2015/05/21/starbucks.html
  - ruby-saml CVE-2025-25291/25292: REXML and Nokogiri saw different
    signatures. https://github.blog/security/sign-in-as-anyone-bypassing-saml-sso-authentication-with-parser-differentials/
  - Spotify: non-idempotent username canonicalisation, takeover.
    https://engineering.atspotify.com/2013/06/creative-usernames
  - Bishop Fox, JSON interoperability (duplicate keys, truncation).
    https://bishopfox.com/blog/json-interoperability-vulnerabilities
  - Docker CVE-2018-15664: `docker cp` symlink swap gave host root.
    https://seclists.org/oss-sec/2019/q2/131
  - Rust CVE-2022-21658: `remove_dir_all` check-then-delete.
    https://blog.rust-lang.org/2022/01/20/cve-2022-21658/
  - GitHub Security Lab, "Preventing pwn requests": privileged triggers
    checking out untrusted PR code.
    https://securitylab.github.com/resources/github-actions-preventing-pwn-requests/
- **Remedies.** Go `os.Root` (notes `EvalSymlinks` then open is racy)
  https://go.dev/blog/osroot · CodeQL `actions/untrusted-checkout-toctou`
  https://codeql.github.com/codeql-query-help/actions/actions-untrusted-checkout-toctou-high
  · Node `fs.access` before open is discouraged
  https://nodejs.org/api/fs.html#fsaccesspath-mode-callback

### What a read-only reviewer cannot establish, and what could

Not establishable by reading, so these become proof gaps: an isolation
level set outside the repo; replica, worker and process counts and per-key
queue partitioning; schema for tables whose migrations are not in the
repo; real edge behaviour (a proxy or HTTP/1.1 edge makes single-packet
delivery harder, never impossible — and aliases need no parallel
transport); runtime file ownership on volumes. Coverage outside the LLM:

- **A deterministic "uniqueness without index" fact.** Parse model
  validators against final migrations, including NULL semantics and
  partial predicates; emit a fact the lens reads. Prior art:
  `active_record_doctor`, `database_consistency`.
  https://github.com/gregnavis/active_record_doctor ·
  https://github.com/djezzzl/database_consistency
- **Static queries as leads, not findings**: CodeQL
  `actions/untrusted-checkout-toctou`, `js/file-system-race`,
  `py/insecure-temporary-file`.
- **Threat-model fields the operator fills once**: DB engine and isolation
  level, process model (so "one process" can be cited), worker concurrency,
  which tables hold limits or single-use rows.
- **An operator step outside the reviewer**: a staging-only single-packet
  or aliased-batch test for each plausible question. The reviewer never
  runs it.

### How to evaluate it

Pairs of a defect and a **benign twin** with the same shape and a correct
serializer, scored pairwise (PrimeVul-style), so a lens that flags every
`get_or_create` loses:

- `select_for_update` or a conditional `WHERE used = false` removed vs kept.
- A redeem endpoint as read-then-save vs `F()` with a count check; the same
  as 50 GraphQL aliases.
- `exists()` under `select_for_update` then create vs a unique index.
- An in-process `asyncio.Lock` around a redeem under gunicorn vs a
  conditional update.
- A unique index with a nullable column vs `NULLS NOT DISTINCT`.
- `ON CONFLICT DO UPDATE SET password_hash` vs `DO NOTHING` + error.
- A webhook crediting with no `event.id` insert vs with one.
- An email-change confirm applying the pending value (GitLab) vs a token
  bound to the address.
- A label- or comment-gated workflow checking out `head.ref` vs `head.sha`.
- `os.access` then open in a root helper vs `openat` with `O_NOFOLLOW`.
- ruby-saml 1.18.0 reversed.

Reverse-applied fix commits make the best positives: GitLab CVE-2022-4037,
anything-llm CVE-2024-2913, ruby-saml. Measure recall on high-severity
rows, the false-flag rate on twins, the share of `recipe` and `controls`
lines the validator marks valid, and how many questions became confirmed
after the operator's answer. Any run waits for the owner's go.

### Critique log

Rejected or narrowed critic points, one line each:

- RT7 (socket or JWT role claim outliving demotion): not taken.
  `pass-sec-tokens` step 4 owns long-lived connections, and privesc step 9
  owns cached roles.
- RT8 (DNS-rebinding SSRF): not taken. README §3 assigns DNS rebinding to
  `pass-sec-boundaries`; that draft should name it.
- RT15, SSO linked by the `email` claim: not taken, `pass-sec-tokens` step
  3 owns it. The re-registrable-name allowlist half is kept.
- RT17 (admission webhook on CREATE only): not taken. A policy that skips a
  verb is a coverage gap with no time gap, so it goes to `pass-sec-infra`.
- RT18, Firestore spelling: not taken, per the precision rule that
  serializers are rules, not catalogues. DynamoDB `ConditionExpression`
  stays as one example of a conditional write.
- RT step 2, "list entry points that skip the check": narrowed. A skipping
  entry point is a missing check, so it goes to `pass-sec-access`. The
  writers that race the checked path are listed in steps 1 and 4.
- RT5 (webhook retries and reordering): narrowed to value-creating or
  plan-keeping effects at `plausible` reachability, because the provider
  chooses the timing.
- PC §1, the ~1,100-word target: not met (Part A is about 2,000 words, 220 lines).
  The red-team variants (zero-row locks, in-process and TTL locks,
  replicas, NULL and partial indexes, conflict handlers, aliases,
  webhooks, payment snapshots, session flows) each change what the agent
  checks. Catalogue sprawl was cut instead: the ORM spellings, the cached
  authority shape, the JWT example, three CI shapes and the general
  filesystem list.
- PC §1, drop `interleave`: done in the evidence block. The four-step
  interleaving moved to `detail`, where pass-concurrency's form already
  lives.
- PC §2, treat the CI shape only as a CodeQL lead: narrowed. The shape
  stays at one bullet, because CodeQL does not run in the pipeline today.
  When a CodeQL result exists, it comes in as a lead.
- PC §3, enqueue-time checks: narrowed. Recurring jobs for removed members
  go to privesc (stale authority). Only arguments the attacker mutates
  between enqueue and run stay here.
