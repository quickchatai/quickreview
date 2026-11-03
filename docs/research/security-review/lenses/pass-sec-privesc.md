# `pass-sec-privesc` — draft lens and design notes

Drafted 2026-11-02 for the security profile
([`../README.md`](../README.md) §3), revised the same day after a red-team
and a precision critique, and again (revision 2) after the synthesis split
ownership — see "Revision 2 notes" at the end — and once more after a
second red-team and precision critique ("Critique log (revision 2)").
Status: **proposal, nothing built.** Part A is the
lens file as it would ship at `agents/pass-sec-privesc.md`. Part B explains
the design and is not shipped.

---

## Part A — the lens

```markdown
---
name: pass-sec-privesc
description: Privilege-escalation review pass (security profile) — every application surface that grants, inherits, assumes or overrides authority (roles and role definitions, memberships and groups, scopes, ownership, impersonation, invites, SSO/SCIM role mapping, domain claims, integration consent, setup bootstrap, override inputs), takes over a higher account through its recovery channel, or weakens a security setting is traced from the weakest actor who can reach it to the power it confers; the role gate is checked for failing open, the target for tenant and rank, and a permitted grant for ceiling, approver rank and step-up against the threat model or the repo's own precedent.
tools: read, bash, grep, glob
---

{{include:prompts/pass-common.md}}

# Lens: privilege escalation in the application's role model

Apply to: code that **changes who may do what inside the application** —
the grant and setting sinks of step 1, and the mounts, gates, accounts,
fields, inputs, provisioning, bootstrap, invites and hierarchies steps
2–10 name. The platform grant graph (cloud IAM, federation, Kubernetes
RBAC, database roles, sudoers, setuid/setcap, the docker group) is
`pass-sec-iam`'s; ordinary reads and actions on objects are
`pass-sec-access`'s. You start from a **grant, an override or a security
setting**.

For every surface, answer one sentence: **who is the weakest actor that can
make this run, and what can they do afterwards that they could not do
before?** That difference is the *delta*. No delta, no finding. In review,
search the tree only for the guard, the mounts of a sink the diff adds or
changes, and a sibling precedent; old grant paths are scan's and
`pass-sec-variant`'s.

## Worksheet — fill it in your notes before writing any finding

1. **Grant sinks.** In the diff and in code it makes newly reachable, list
   each write of authority with its `file:line`: ORM or raw-SQL writes to
   a role, `is_admin`, group or membership; GraphQL, gRPC and queue
   handlers taking a role; IdP claim writes (`setCustomUserClaims`). Also:
   - **Inherited grants.** Membership in a team, group, parent org or
     project that carries a role grants that role; resolve nesting before
     computing `delta`. Removing a deny entry, a restriction group or a
     scope boundary is a grant; compute `delta` after it is gone.
   - **Settings that grant.** Default role, auto-approve, open sign-up and
     self-assign-role settings grant every future member the role they
     confer.
   - **Settings that weaken.** Org-wide MFA off; an IdP added or its
     metadata URL or signing certificate replaced; allowed domains or JIT
     widened; in-app IP allowlist, session lifetime, password policy or
     lockout loosened; webhook or OAuth callback URL changed; audit deleted
     or retention cut; an auth-gating flag flipped.
   - **Bulk writes.** A full-replace `PUT`, import, restore or clone that
     defaults an omitted security field or carries user and role rows.
   Out: operator-run entries no request reaches (management commands, rake
   tasks, data migrations, `createsuperuser`); `GRANT`s and RLS policies in
   migrations. Run steps 2, 4 and 9 on every sink. A tenant admin never
   weakens a control the platform sets for all tenants — cite the platform
   default's `file:line` or threat-model line; with neither, no such
   control exists.
2. **Every mount, weakest actor.** For each sink the diff adds or changes,
   list every route that reaches it: sub-routers, versioned prefixes, a
   legacy `/v1`, GraphQL resolvers, websocket handlers, a gRPC gateway,
   API-key and PAT routes beside the web one. A guard on one mount proves
   nothing about another; read each mount's guards, never a name or folder.
3. **The role gate holds the exact value and fails closed.** At each
   mount, cite the check. It compares the value **actually written** (not
   the path's role while the body carries another; not `PUT` while
   `PATCH`/`POST` write too; not a role from a client-set header, cookie or
   unverified claim), before the first effect. It cannot allow by
   accident: an un-awaited async role check (a Promise is truthy); an error
   caught and followed by `next()`; an `undefined` role passing `!==` or a
   deny-list; a policy defaulting `allow = true`. A cached role it reads is
   keyed by user **and** tenant.
4. **Ceiling, target and minting.**
   - Can the granter confer a role above its own, add to a role's
     definition a permission it lacks, or edit a role it holds? Can a lower
     role demote, delete or impersonate a higher one? Can actor == target?
   - **Taking a higher account.** Can a lower role change a higher user's
     email, phone, password, MFA factors or linked login methods, add a
     delegate or mail forwarding, or hide it from admin lists? Each one
     grants that account's role.
   - The target user, membership and role ID are looked up **in the
     actor's tenant inside the write's `WHERE`**, not only in the guard. A
     `roleId` from the body may name a custom role from another tenant.
   - A minted key, bot or OAuth client gets a subset of the minter's
     scopes; read every auto-created principal's default role. An
     integration install or OAuth consent is a mint: its scopes stay within
     the installer's, and org-wide scopes need admin consent.
   - Impersonation: actions that outlive the session (a new API key, an
     MFA or email change, a grant); the original actor recorded. Last-admin
     removal counts only when a lower role can do it.
5. **Privileged fields bound from input.** Trace `role`, `is_admin`,
   `owner_id`, `org_id`/`tenant_id`/`account_id`, `permissions`, `scopes`,
   `groups`, `email_verified`, `status`/`approved`/`active`, `user_type`,
   plan or tier entitlements from the parser to the persisted write, flat
   **and nested** (Rails `*_attributes`, Prisma nested writes, GraphQL
   input types). Name the allowlist that strips them or say it is absent. Also `merge`/`defaultsDeep`/a
   recursive assign of the body into an object later read for authority
   (`__proto__`, `constructor.prototype`). Claim a parser differential
   (`role=user&role=admin`, duplicate JSON keys) or a denylist bypass only
   with the parser line, at the lockfile version, that produces it.
   Pydantic without `extra="allow"` drops undeclared fields: a model that
   does not declare `role` is the allowlist — no finding.
6. **Override and acting-as inputs — cite the reader.** For each input
   that skips or widens a role check or names whom to act as (`admin`,
   `debug`, `force`, `skip_*`, `bypass`, `as_user`, `impersonate`,
   `X-Act-As`, a role-valued header), cite the **line where it changes the
   authz branch** — a name match is not a reader. Only inputs the diff adds
   or newly reads. A header carrying the authenticated user
   (`X-Forwarded-User`, `X-Remote-User`) is authn-coverage's; an IP or
   "internal" gate's proxy trust is infra's — cite either as a proof gap.
7. **Provisioning (SSO, JIT, SCIM, domains).** Role mapping reads only
   issuer-scoped immutable claims (`iss`+`sub`, Entra `tid`+`oid`), never
   `email`, `preferred_username` or `upn`. Domain auto-join requires a
   verified email. Claiming an email domain for a tenant requires DNS or
   file proof before it routes sign-in or auto-joins anyone. An IdP group
   name (`admins`) never maps to an instance role, and a tenant-configured
   IdP cannot assert a role above that tenant.
8. **Bootstrap.** When the diff touches setup, name the flag that closes it
   (`setupComplete`, `User.count() == 0`), each API route that checks it,
   and that one flag's writers (a settings endpoint, a user deletion
   re-arming "first user becomes admin").
9. **Permitted escalation, weakly protected.** For grants and settings
   meant to exist:
   - Invite or approval: token single-use, bound to invitee and tenant;
     the role comes from the stored invite, never the accept request; a
     multi-use or link invite carries no role above the default; approver
     ≠ requester and holds at least the granted role; inviter ≠ invitee.
   - Missing step-up, approval, audit or notification needs a `precedent`:
     a sibling grant path that has it, or a `.qcr/threat-model.md` rule
     ("admin grants require re-authentication") — cite the line.
   - **Top tier** (become owner, grant admin, MFA off org-wide, add or
     replace an IdP or signing certificate, claim a domain, mint a SCIM
     token, change an admin's recovery channel): on a route or guard the
     diff adds or changes, recent re-authentication (`auth_time`, sudo
     mode, password or factor confirm) needs no precedent. It must hold on
     every mount (API-key and PAT routes too), take `auth_time` from the
     last login, not a refresh, and not skip password-less accounts.
     Absent or bypassable → finding, unless the threat model says "no
     step-up by design".
   - A cookie-authenticated grant or setting route forgeable cross-site
     (write on `GET`, `csrf_exempt`, "JSON only" while `text/plain` or
     forms parse) gets one `chain-lead:` row; the CSRF defect is access's.
10. **Hierarchy, defaults, migrations.** When the diff inserts a role or a
    comparison: ordinal or string compares (`IntEnum >=`, `"admin" in
    role`), a deny-list (`role != "user"`) admitting new roles, the default
    and `null` role on create. A migration default or backfill counts only
    when it grants principals more than they held before.
11. **Hunt the defeating control** and record where you looked: a global
    guard (`APP_GUARD`, `DEFAULT_PERMISSION_CLASSES`, a base `before_action`,
    the Spring filter chain), a DB constraint or trigger, a policy call.

## Evidence block (required in every finding's `evidence`)

    source:      <file:line> — <what the attacker controls>, trust: untrusted|tenant|operator|first-party
    boundary:    <trust boundary crossed>
    sink:        <file:line> — <the write that confers authority>
    path:        <hops, each file:line; gaps marked "?">
    controls:    <guards looked for, where, why they don't cover this path>
    cwe:         CWE-<id>   (269, 862, 863, 915, 1321, 640, 693)
    proof-gaps:  <smallest fact(s) that, if false, kill the finding>
    actor:       unauth | any-user | tenant-member | tenant-admin | instance-admin
    gains:       <role/permission/scope> at scope resource | tenant | instance | cross-tenant
    delta:       <what gains has that actor lacked>   ("none" ⇒ do not emit)
    gate:        <file:line of the check, what it compares, on which value> | absent | fails-open: <how>
    precedent:   <sibling path file:line | threat-model:<line> | top-tier>   (weak-protection rows only)
    chain-lead:  <CSRF|CORS|framing> at <file:line> → <gains>   (cross-site rows only)

## Confirmed, plausible, excluded

- **Confirmed:** every mount to the sink read, the sink writes the
  privileged value, `gate` is absent, fails open or compares the wrong
  value, `delta` non-empty, no proof gap.
- **Plausible — a question naming the one fact** you cannot read here
  ("Does the edge strip `X-Act-As`? If not, any member acts as any user"),
  never one you could close by reading. Score sign-up from shipped config.
- **Exclusions (no finding, no question):**
  - `delta: none` — the actor already holds the power, unless the grant
    crosses scope (tenant → instance, tenant A → tenant B, ceiling). A
    power the threat model's `roles:` section grants that actor (support
    impersonation, break-glass, an owner console) is `delta: none`.
  - A tenant-scoped setting written by a role that already owns it (the
    new callback receives that admin's own data); retention kept inside a
    cited platform floor.
  - Missing MFA, step-up, approval or audit with no `precedent`, except
    the top tier (step 9). A lower role acting on a higher account's
    recovery channel or login methods is a ceiling breach (step 4), never
    excluded as "missing step-up".
  - A chain lead on a bearer-authenticated route, or one default CSRF
    middleware covers unexempted; a limit or lockout that never existed.
  - Operator-run entries (step 1); Django admin or ActiveAdmin under a
    permission model the diff does not change; grants to the application's
    own runtime, migration or service principals.
  - Self-demotion or self-removal; an ordinal role comparison or denylist
    the diff did not add or change.
  - Env/CLI toggles (`AUTH_DISABLED`) no request reaches and no production
    manifest defaults on; test fixtures, seed and demo scripts, `examples/`,
    config used only by a non-production manifest (dev settings, compose
    dev overrides, local bootstrap admins); frontend-only role checks.

## Severity — impact × exposure, never "unlikely in practice"

Impact: **I1** instance admin/superuser or admin in another tenant;
**I2** tenant admin or owner, or role-management power inside a tenant;
**I3** one extra permission inside the actor's tenant. A power that
confers a higher one in **one cited hop** — mint a token at any scope,
edit a role's definition, reset setup, take a higher account — scores as
the higher one; longer paths are `pass-sec-exploit-chain`'s. Exposure:
**E1** unauthenticated, including open sign-up enabled in shipped config;
**E2** any authenticated user; **E3** a lower role in the same tenant, or
a tenant admin acting beyond its tenant.

| | E1 | E2 | E3 |
|---|---|---|---|
| I1 | P0 | P0 | P1 |
| I2 | P0 | P1 | P1 |
| I3 | P1 | P2 | P2 |

A setting scores as what it hands over: an IdP, certificate, domain claim
or callback replaced, or MFA off org-wide, is I2 (I1 instance-wide); a
tenant admin weakening a platform-set control is I1; deleted audit and
other posture changes inside the tenant are I3 (I1 across tenants). A
weak-protection or top-tier re-authentication row needs a stolen session
first: one tier below the grant's cell, never below P2. A chain lead takes
the grant's impact and its weakest path's exposure; the victim action it
needs goes in `reachability`.

## Stay inside your lens

BOLA/IDOR, ordinary mass assignment, CSRF, CORS, framing: access (you add
only step 9's chain lead). No authentication, a header carrying the
authenticated user, matcher vs router: authn-coverage; an authenticated
route whose role gate is absent, weak or reads the wrong value is yours.
Races past a ceiling, last-admin or invite check: `pass-sec-toctou`. A
role held in a credential, lifetime, revocation, account linking, and how
a factor or recovery change is verified: `pass-sec-tokens`; **who may
change whose** account, a role in a server cache, and a request writing a
callback URL or session lifetime are yours. The platform grant graph,
database roles included: iam. Reachability and proxy trust: infra. Chains
of two or more hops: exploit-chain. `NONE` is the expected output when
every grant surface holds — say which you walked.
```

---

## Part B — Design notes (not part of the lens)

### B1. Planning triggers

Profile: `security`. Planned **on trigger** in review. In scan it is in the
**deep floor for every file the threat model lists as a role, membership,
provisioning or setup surface**, and always in stage 2 when the threat
model declares a role hierarchy. Grant surfaces are rare and high-value, so
the trigger leans recall and the exclusion list carries the volume — but
the revision removes triggers that fire on every frontend or DTO change.

**Two deterministic daemon checks come first** (they plan the lens with a
pre-filled note, so no model has to notice):
- *Removed guard:* a deleted line matching the authz-decorator group below.
- *Role enum shift:* a value inserted mid-enum in the file the threat model
  names as the hierarchy; the note spells out which ordinal comparisons
  shift.

**Two signals.** A content trigger plans the lens only when the same hunk
also matches the co-signal below (a request source, or a route, handler,
resolver or serializer file); a sink pattern alone in a model, constant or
client file does not. The path globs and the two daemon checks plan alone.

File scope for every content trigger: server-side sources only. Excluded:
`*.{jsx,tsx,vue,svelte,html,css,scss,md,mdx}`, `.github/workflows/**`
(supply-chain's), `*.tf`/k8s manifests and IAM policy JSON (iam's and
infra's), test directories.

Path globs (plan alone):
```
**/{authz,rbac,acl,permissions,roles,invites,invitations,memberships,scim,sso,saml,oidc,impersonation,setup,bootstrap}/**
**/migrations/** **/db/migrate/**     (content trigger must also match)
**/{serializers.py,*.dto.ts,*_params.rb,*Request.java,*Dto.cs,*.graphql,*.proto}   (content trigger must also match)
.qcr/threat-model.md (roles section changed)
```

Content triggers (added lines, case-insensitive):
```
# co-signal (required beside every content trigger except the decorator group)
\b(req|request|params|body|query|args|ctx|input)\b|@(Post|Put|Patch|Delete|Mutation|Resolver)\b|\b(router|app|r)\.(post|put|patch|delete)\(|routes?\.(rb|py|ts)$|views?\.py$|controller|resolver|serializer|\.dto\.

# authority fields, any spelling (has_admin_role, userRole, accessLevel, wp_capabilities)
\w*(role|admin|capabilit|permission|privilege|access_?level)s?\w*["']?\s*[:=](?!=)|\bscopes["']?\s*[:=](?!=)
# grant APIs and identity
\b(add_?to_?role|AddToRoleAsync|assign_?role|set_?role|grant_?(role|permission|access)|make_?admin|impersonat\w*|login_?as|switch_?user|become_user|transfer_?owner\w*|setCustomUserClaims|accepts_nested_attributes_for)\b
(claims|userinfo|id_?token|profile)\W{1,3}(groups|roles)\b|email_verified|auto_?join|allowed_domains|(verify|claim)\w*_?domain|domain_?verif\w*
# role definitions, inheritance, deny entries, grant-type settings, consent (revision 3)
\b(role|permission)_?(definition|grants?)\b|add_?permission|(parent|nested|sub)_?(group|team|org)|\b(deny|restrict)\w*_?(list|group|entry|acl)|default_?role|auto_?approve|self_?assign|open_?sign_?up|install\w*_?(scopes?|permissions?)|admin_?consent
# another account's recovery channel (the target id must come from input)
(email|phone|password|mfa|factor|totp|delegate|forward\w*|hidden|is_?hidden)\w*\s*=.*(params|body|input|target|other|member)\w*
# SQL (raw role writes)
UPDATE\s+\w*(user|member|role|account)\w*\s+SET|INSERT\s+INTO\s+\w*(member|role|permission)\w*
# override and acting-as inputs (a request source must be on the line)
(req|request|params|query|body|args|headers)\W{1,3}(admin|debug|force|skip_\w+|bypass\w*|override\w*|as_user|act_?as|sudo|impersonate)\b
\bx-(act-as|impersonate\w*|user-role|role|override|admin)\b
# binding sinks: mass assignment, nested writes, deep merge
Object\.assign\(\s*\w+\s*,\s*req\.body|\.\.\.\s*req\.body|(findByIdAndUpdate|updateOne|update)\([^)]*req\.body|data:\s*req\.body|params\.permit!|permit\([^)]*:(role|admin)|fields\s*=\s*["']__all__|TryUpdateModel|ShouldBind\w*\(&\w*(user|account|member)|\$guarded\s*=\s*\[\s*\]|extra\s*=\s*["']allow
\b(merge|mergeWith|defaultsDeep|deepmerge|assignDeep|extend)\([^)]*(req\.(body|query)|request\.(json|body|data))
# bootstrap
(setup|install)\w*_?(complete|done|finished)|first_?(user|admin)|is_?installed
# security-setting writes (revision 2)
\b(require|enforce)\w*_?(mfa|2fa|two_?factor|sso)\b|\b(mfa|2fa|sso)_?(required|enforced|enabled)\b|\b(idp|saml|sso)_?(metadata|cert\w*|issuer|entity_?id|config)\w*|jit_?provision\w*|ip_?allow_?list|session_?(lifetime|timeout|ttl|max_age)|password_?policy|(webhook|callback)_?url|audit_?(log|retention)\w*\s*[:=]|\.(destroy|delete)\w*\b.*audit|lockout|max_?(login|failed)_?attempts|scim_?token|(signing|idp)_?cert\w*
# role decorators/config changed — removed lines also trigger (plans alone)
@(PreAuthorize|Secured|RolesAllowed|Roles|staff_member_required|permission_required|user_passes_test)|permission_classes|get_permissions|Authorize\(Roles|skip_authorization|hasRole|hasAuthority|EnableMethodSecurity|RolesGuard
```

Revision 3 cut from the triggers, as other lenses' planning signals:
identity headers (`X-Forwarded-User`, `X-Remote-User`, `X-WEBAUTH-USER`,
`X-Original-URL`, `X-User-Id`) and method override (authn-coverage);
`@Public`, `AllowAnonymous`, `permitAll`, `csrf_exempt`,
`skip_forgery_protection` (authn-coverage and access); `CREATE POLICY` and
SQL `GRANT` (iam for database roles, access for RLS tenant predicates);
the `email`/`preferred_username`/`upn` claim reads (tokens' linking).

The first regex is broad on purpose (it catches Harbor's `has_admin_role`
and Ultimate Member's `wp_capabilities`, which the first draft's `\brole\b`
missed); the server-side file scope is what keeps ARIA `role="button"` and
workflow `permissions:` out. Dropped as noise: bare `setattr(`, `promote`,
`elevate`, `hijack` (Go's `http.Hijacker`), the `"debug"`/`"force"`/
`"internal"` key regex, and the `*admin*`/`*member*`/`*policy*` filename
globs (frontend components, privacy-policy pages). The precision critique
of revision 2 showed the first regex still matches `admin_email =`,
`permission_denied_message =` and `access_level_label`, and the setting
regex matches ordinary client config; the two-signal rule above is the
fix, not a narrower regex, so the spellings Harbor and Ultimate Member
used still hit.

### B2. Validator guidance

The validator re-derives each claim by reading. Per claim type:

| Claim | Verify by reading | Counterevidence (cite file:line) | NOT counterevidence |
|---|---|---|---|
| Missing gate on grant | Every mount → middleware/guard list → handler → write | A server-side guard on this method+path, before the write, comparing actor role ≥ granted role; a global guard proven to apply and not overridden on this handler | Hidden UI button; a guard on a sibling method or mount; a name or folder ("admin/"); a happy-path test; PR text |
| Role gate fails open | The role check's call site and its return type | The call is awaited / invoked; the error path returns deny; the policy default is deny | A unit test of the guard function itself (it does not exercise the call site) |
| Cross-tenant target | The write's query | Tenant key in the write's `WHERE`, or a DB constraint/RLS policy binding it | A tenant check in the guard over a different lookup |
| Privileged-field binding | Parser → DTO/serializer/permit list → ORM write (nested included) | Allowlist omitting the field (`permit` list, `read_only_fields`, `ValidationPipe whitelist`, Pydantic without `extra="allow"`), `attr_readonly`, DB trigger; `Object.create(null)` or a key filter before a deep merge | A TypeScript interface; class-validator decorators without `whitelist`; a denylist the claimed spelling passes per the cited parser line |
| Ceiling / self-target / minting / consent | Comparison code and the hierarchy definition; the consent or install handler | Server-side check of target role vs actor role; self-target rejection; scope ⊆ minter check; org-wide scopes routed to admin consent | A filtered dropdown; a DB enum (constrains values, not who sets them) |
| Role-definition edit | The permission-set write and the editor's own permission set | A check that every added permission is held by the editor and that the editor does not hold the role edited | A UI listing only the editor's permissions |
| Higher account taken over | The write of email, phone, password, factor, linked login, delegate or hidden flag on a target id; the rank check | A server-side check that the actor outranks the target (or is the target), before the write | Tokens' re-authentication of the actor (it proves the actor, not the rank); a notification to the old address |
| Inherited grant / deny removed | The membership or nesting write, the role the container carries, the deny evaluation | The container carries no role above the actor's; the nesting write checks the parent's role; deny entries are editable only above their scope | "Groups are just for organising" with no read of how roles resolve |
| Override / acting-as input | The reader line where it changes the branch; ingress config in the repo | Ingress overwriting or stripping the input; handler bound only to a loopback listener | "It's internal", a comment, a header-name prefix |
| Provisioning and domains | Callback → user lookup → role mapping; the domain-claim handler | Role mapping by `iss`+`sub`/`tid`+`oid`; `email_verified`/`xms_edov` before auto-join; a DNS TXT or file proof checked before the domain routes or joins | The IdP "usually" verifies email; a pending-verification flag nothing reads |
| Bootstrap re-entry | The setup flag, every reader, every writer | Flag immutable after first set (DB constraint, one-way write) and checked by every setup route | The setup UI page redirects |
| Weak protection | `precedent` sibling, or the cited threat-model line, beside the new path | The control is global (step-up on a shared base, an approval queue every grant passes); the threat-model rule does not cover this grant | A comment promising step-up later; MFA at login (it is not recent) |
| Top-tier re-authentication (finding, diff-scoped) | The route the diff adds or changes, every mount of it, and the `auth_time`/sudo-mode check | A recent-auth check before the write on every mount, API-key and PAT routes included (`auth_time` from the last login, password or factor confirm), or approval by a second admin; a threat-model line "no step-up by design" | Login MFA; a confirmation modal; a short session lifetime; sudo mode that only the web session passes through |
| Security-setting write | Every mount → gate → write; the cited `file:line` of the platform default | The gate requires a role that already holds the setting at that scope; the platform control is enforced at read time regardless of the tenant value (e.g. MFA checked against `max(platform, tenant)`); no platform default exists to weaken | A UI that hides the toggle; a tenant-admin role on a platform-wide control |
| Chain lead (cross-site) | Session mechanism, CSRF middleware registration, the route's exemptions and parsers | Bearer/header auth; default CSRF middleware covering the route; `SameSite=Strict` cookie on a same-site-only app | JSON content type when the server also parses `text/plain` or forms |

`delta: none` with evidence (the actor provably already holds the power) is
`excluded: same-principal`, not refuted; so is a power the threat model's
`roles:` section grants that actor. A finding whose `actor` the validator
downgrades (any-user → tenant-admin) is re-scored by the matrix, not
killed. A `chain-lead` row merges by anchor into access's CSRF/CORS row
when one exists (it adds the grant's `gains` line to that row). With no
access row it goes to `compose`; if no chain uses it, it is dropped
(revision 3 — open question 6), since posting it would re-create access's
finding under privesc's name.

### B3. Overlap with other lenses

- **pass-sec-access** (narrowed, README §11.1) — object-level authz
  (IDOR/BOLA, tenant keys), ordinary mass assignment, and CSRF/CORS/
  clickjacking. Privesc owns *writes of authority* and security settings,
  override inputs, and mass assignment of the **privileged fields** (role,
  is_admin, owner_id, org/tenant/account id, permissions, scopes, groups,
  `email_verified`, approval status, user type, plan entitlements —
  revision 3 widened the original six to fields that unlock authority one
  hop later). On a
  cross-site-forgeable grant or setting route privesc writes only a
  `chain-lead` row; the CSRF defect is access's.
- **pass-sec-authn-coverage** — routes with no authentication, function-
  level authz by sibling diff, matcher vs router, checks that do not stop
  the request, and headers that carry the authenticated user
  (`X-Forwarded-User`, `X-WEBAUTH-USER`; CWE-290). Privesc keeps only
  inputs whose value is a role or an acting-as identity, and the fail-open
  forms of a *role* check on an authenticated route (un-awaited role
  check, `undefined` role passing `!==`). Anchor rule (SYNTHESIS §1, README §11.1): a grant route
  with no authentication at all, fixed by adding a guard, is
  authn-coverage's; an authenticated grant route whose role gate is
  absent, weak or compares the wrong value, fixed by a role check, is
  privesc's.
- **pass-sec-tokens** — issuance, lifetime, rotation, revocation, claim
  verification, the MFA factor lifecycle. A role held in a credential (JWT
  claim, session field, API-key record) is tokens'; one held in a server
  cache is privesc's. Privesc owns "the requester chooses the minted
  scope", a new principal's default role, and the *org-wide* MFA
  requirement as a setting write; a user's own factor reset is tokens'.
  Revision 3 anchors: account linking (adding an IdP identity, passkey or
  secondary email to an existing account, its `state` and re-auth) is
  tokens' step 8/10; **who may change whose** recovery channel or login
  methods (a lower role writing a higher account's) is privesc's step 4,
  while *how* an admin override is done (reset link, session voiding) is
  tokens'. A request writing a callback URL or session lifetime is
  privesc's setting write; verifying `redirect_uri` and enforcing a
  lifetime are tokens'.
- **pass-sec-toctou / pass-concurrency** — races past a ceiling or
  last-admin check, double invite accept, an invite's role changed between
  issue and accept. Privesc owns "the accept request chooses the role" (no
  race) and demoted-but-cached authority in a server cache.
- **pass-sec-iam** (new) — the platform grant graph: cloud IAM escalation
  primitives, trust and federation (CI OIDC `sub`/`aud`, GCP WIF
  `attribute_condition`), Kubernetes RBAC including `escalate`/`bind`/
  `impersonate`, sudoers, setuid/setcap, the docker group. Everything the
  first revision cut from this lens and "forwarded to infra" lands there.
  Revision 3 also sends **database roles** there: SQL `GRANT` and role
  membership in migrations are platform grants. A request-time `GRANT`
  the application runs on a user's behalf stays here; RLS tenant
  predicates are access's (open question 8 asks the synthesis to ratify).
- **pass-sec-infra** — who can reach what: network controls declared,
  enabled and attached, exposure, runtime privilege, proxy trust. An
  in-app IP allowlist *edited through a request* is a privesc setting
  write; the same allowlist in network config is infra's.
- **pass-sec-exploit-chain** — consumes `actor → gains` rows as links.
- **pass-sec-supply-chain** — CI workflow permissions, branch-protection
  bypass.
- **pass-sec-secrets-data** — default admin credentials, leaked keys.
- **pass-sec-llm** — an LLM tool that grants roles without the user's
  authority (confused deputy, ASVS 8.3.3) is shared, anchored here when the
  grant code is the defect.
- **pass-sec-variant** — the history-driven hunt for sibling grant paths.
- **pass-widened** — deny-list checks admitting a new member; privesc owns
  it when the member is a role.

### B4. Motivating incidents

- GitHub 2012 — mass assignment on the public-key form: https://github.blog/2012-03-04-public-key-security-vulnerability-and-mitigation/
- Harbor CVE-2019-16097 — `has_admin_role` accepted at self-registration: https://unit42.paloaltonetworks.com/critical-vulnerability-in-harbor-enables-privilege-escalation-from-zero-to-admin-cve-2019-16097/
- Ultimate Member CVE-2023-3460 — registration wrote `wp_capabilities`, denylist bypassed: https://www.bleepingcomputer.com/news/security/hackers-exploit-zero-day-in-ultimate-member-wordpress-plugin-with-200k-installs/
- WooCommerce Payments CVE-2023-28121 — a request header made the plugin act as any user: https://www.bleepingcomputer.com/news/security/hackers-exploiting-critical-wordpress-woocommerce-payments-bug/
- Confluence CVE-2023-22515 — "setup complete" reset, admin created unauthenticated (bootstrap re-entry): https://confluence.atlassian.com/security/data-center-and-server-1295682276.html
- Cisco IOS XE CVE-2023-20198 — unauthenticated creation of a privilege-15 account: https://cert.europa.eu/publications/security-advisories/2023-078/
- LiteSpeed Cache CVE-2024-28000 — role-simulation cookie behind a weak hash: https://patchstack.com/articles/critical-privilege-escalation-in-litespeed-cache-plugin-affecting-5-million-sites
- Grafana CVE-2022-35957 — forged `X-WEBAUTH-USER` via datasource proxy (revision 3: an authenticated-user header, now authn-coverage's; kept as history): https://nvd.nist.gov/vuln/detail/cve-2022-35957
- CVE-2021-22538 — `UserWrite` holders created users above their own permissions (ceiling): https://github.com/advisories/GHSA-5v95-v8c8-3rh6
- DHIS2 CVE-2022-41948 — user manager made themselves superuser: https://nvd.nist.gov/vuln/detail/CVE-2022-41948
- GitLab CVE-2025-10871 — maintainer attached a custom role above their own (secondary source): https://www.sentinelone.com/vulnerability-database/cve-2025-10871/
- StudioCMS S3 storage CVE-2026-32101 — async `isAuthorized()` called without `await`; a Promise is truthy, so the lowest role wrote the whole bucket (fail-open gate): https://advisories.gitlab.com/npm/@studiocms/s3-storage/CVE-2026-32101/
- shvl CVE-2020-28278 — `set("__proto__.isAdmin", true)` makes every object report `isAdmin` (prototype pollution into an authority flag): https://github.com/advisories/GHSA-pqwc-3vhw-qcvq
- nOAuth (Descope, 2023) — apps linking Entra accounts by the mutable `email` claim; an attacker tenant sets the victim's address: https://www.descope.com/blog/post/noauth
- JSON parser differentials (Bishop Fox) — duplicate keys and truncation read differently by validator and consumer; a `superadmin\ud888` role read as `superadmin`: https://bishopfox.com/blog/json-interoperability-vulnerabilities
- Okta cross-tenant impersonation (2023) — a socially engineered Super Administrator added a second IdP and used it to sign in as other users (security-setting write: IdP added): https://sec.okta.com/articles/2023/08/cross-tenant-impersonation-prevention-and-detection
- SolarWinds/APT29 — federation trust changed to accept tokens signed by the attacker's own SAML certificate; MITRE T1484.002 Trust Modification (also "add a new federated identity provider"): https://attack.mitre.org/techniques/T1484/002/

Revision 3 (second critique round), each checked at the source on
2026-11-02:
- Budibase CVE-2026-72856 (GHSA-796c-884r-78pp) — any authenticated user could change the tenant owner's email via `PUT /api/global/users/tenant/owner`, then take the owner account through the public password reset (a lower role writing a higher account's recovery channel; step 4): https://github.com/advisories/GHSA-796c-884r-78pp
- Coder CVE-2026-55077 (GHSA-29xf-69gq-m9jx) — the password endpoint authorized only `ActionUpdatePersonal`, so a `user-admin` could reset an `owner`'s password; the fix stops non-owners resetting an owner (rank check on a recovery write): https://github.com/advisories/GHSA-29xf-69gq-m9jx
- better-auth SSO CVE-2026-80192 (GHSA-xfj7-7fp8-rhvp) — with domain verification off, an org owner registered an SSO provider for an arbitrary domain and auto-assignment pulled users with that email domain into the attacker's org (domain claim without proof; step 7): https://github.com/advisories/GHSA-xfj7-7fp8-rhvp
- Microsoft, illicit consent grants — an app granted consent gains account-level access "without the need for an organizational account", and `ConsentType = AllPrincipals` is the tenant-wide case to review (consent as a mint; step 4): https://learn.microsoft.com/en-us/defender-office-365/detect-and-remediate-illicit-consent-grants
- MITRE T1098.002 Additional Email Delegate Permissions — "grant additional permission levels to maintain persistent access" (delegate writes; step 4): https://attack.mitre.org/techniques/T1098/002/ — and T1114.003 Email Forwarding Rule (forwarding writes; the red-team cited T1098.002 for forwarding, which it does not cover): https://attack.mitre.org/techniques/T1114/003/
- GitHub sudo mode documents confirmation for web sessions and lists PAT creation as a protected action, but says nothing of PAT-authenticated API calls; that silence is why step 9 asks for the check on every mount rather than trusting "sudo mode exists": https://docs.github.com/en/enterprise-server@3.22/authentication/keeping-your-account-and-data-secure/sudo-mode

Security-setting writes and re-authentication (revision 2):
- MITRE T1556.006, MFA disabled or weakened by an already-privileged account (exclusions, policy tampering): https://attack.mitre.org/techniques/T1556/006/
- MITRE T1562.008, disable or modify cloud logs (the audit-deletion delta): https://attack.mitre.org/techniques/T1562/008/
- OWASP MFA Cheat Sheet — "Disabling MFA" and elevating to an admin session listed as sensitive actions; re-authenticate before factor changes, "do not rely solely on the active session": https://cheatsheetseries.owasp.org/cheatsheets/Multifactor_Authentication_Cheat_Sheet.html
- GitHub sudo mode — a shipped example of recent-auth before sensitive actions, the shape of the top-tier counterevidence: https://docs.github.com/en/enterprise-server@3.22/authentication/keeping-your-account-and-data-secure/sudo-mode

Standards the worksheet is built from:
- OWASP API5:2023 BFLA (method switching, invite-role replay): https://api-security.owasp.org/editions/2023/en/0xa5-broken-function-level-authorization
- OWASP API3:2023 BOPLA (mass assignment): https://api-security.owasp.org/editions/2023/en/0xa3-broken-object-property-level-authorization
- ASVS 5.0 V8 (8.2.3 field-level, 8.3.3 originating subject, 8.4.2 admin interfaces): https://github.com/OWASP/ASVS/blob/master/5.0/en/0x17-V8-Authorization.md
- ASVS 5.0 V2, 2.3.5 multi-user approval for high-value flows (approver ≠ requester): https://github.com/OWASP/ASVS/blob/master/5.0/en/0x11-V2-Validation-and-Business-Logic.md
- ASVS 5.0 V7 (7.5.1 re-authentication for sensitive attributes): https://github.com/OWASP/ASVS/blob/master/5.0/en/0x16-V7-Session-Management.md
- OWASP WSTG-CONF-06, method override headers as an access-control bypass: https://owasp.org/www-project-web-security-testing-guide/latest/4-Web_Application_Security_Testing/02-Configuration_and_Deployment_Management_Testing/06-Test_HTTP_Methods
- Microsoft identity platform, claims validation (`tid`+`oid`, never `email`/`upn` for authorization): https://learn.microsoft.com/en-us/entra/identity-platform/claims-validation and migration guide https://learn.microsoft.com/en-us/entra/identity-platform/migrate-off-email-claim-authorization
- Express "behind proxies" (`trust proxy` semantics; the evidence infra needs for an IP gate): https://expressjs.com/en/guide/behind-proxies.html
- OWASP Authorization Cheat Sheet: https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html
- OWASP Mass Assignment Cheat Sheet: https://cheatsheetseries.owasp.org/cheatsheets/Mass_Assignment_Cheat_Sheet.html
- Rails `ActionController::Parameters` (`permit!` warning): https://api.rubyonrails.org/classes/ActionController/Parameters.html
- CWE-269 https://cwe.mitre.org/data/definitions/269.html, CWE-266 https://cwe.mitre.org/data/definitions/266.html, CWE-915 https://cwe.mitre.org/data/definitions/915.html, CWE-1321 https://cwe.mitre.org/data/definitions/1321.html, CWE-807 https://cwe.mitre.org/data/definitions/807.html, CWE-842 https://cwe.mitre.org/data/definitions/842.html; CAPEC-233 https://capec.mitre.org/data/definitions/233.html

### B5. What a read-only reviewer cannot establish

- **Deployed configuration:** whether sign-up is open in production, which
  IdP groups map to which role, what the ingress strips. These are the
  usual proof gaps. *Cover:* the threat model (§5) gains a `roles:` section
  (hierarchy, who may grant what, sign-up mode, IdP mapping) and an
  `ingress:` section (which headers the edge sets), filled once by the
  operator and read as fact.
- **Policy engines with data:** OPA/Rego, Cedar, Zanzibar tuples. The lens
  reads the policy, not the stored relations, nor whether the engine
  allows when unreachable (deployment config, rarely in the repo).
  *Cover:* the repo's own policy tests, read as counterevidence.
- **Database collation:** whether a uniqueness index folds case and
  Unicode as login does depends on the deployed collation; revision 3 cut
  the step 7 clause rather than make it a standing question.
- **Role data in production:** a legacy admin row or a default account.
  Not knowable; out of scope.
- **Whether a framework parser nests or folds a spelling** at the version
  in the lockfile. *Cover:* the dep source at the lockfile version, which
  the daemon already fetches (`depsources`).

### B6. Per-ecosystem addenda (moved out of Part A)

Part A keeps only traps a model gets wrong across ecosystems. These go into
addenda selected by `packages/pi-plugin/src/ecosystem.ts`, so a Django repo
does not pay for ASP.NET:
- Express/Nest: `findByIdAndUpdate(id, req.body)`, Sequelize `update(body)`
  without `fields`, `{...req.body}`.
- Django/DRF: `ModelSerializer` with `fields="__all__"` or writable
  `is_staff`/`is_superuser`/`groups`/`user_permissions`; an `@action`
  inheriting `IsAuthenticated` where siblings use `IsAdminUser`.
- FastAPI: a `setattr` loop over `model_dump(exclude_unset=True)`; a router
  mounted without the admin `dependencies=[Depends(...)]`.
- Rails: `skip_before_action :authenticate`, Pundit `permitted_attributes`
  not role-dependent, CanCanCan `can :manage, :all`, Devise
  `permit(:sign_up, keys: [:role])`.
- Nest/Spring/ASP.NET detail cut from Part A's traps in revision 2:
  `Reflector.get` ignoring a class-level `@Roles`; `ROLE_` prefix behind
  `hasRole` vs `hasAuthority`; matcher variants `;`, `..`, `HEAD` → `GET`.
- Moved from Part A's traps in revision 3: Nest `@Roles()` with no
  `RolesGuard`, `Reflector.get` on the handler only, `ValidationPipe`
  without `whitelist: true`; Express `router.use(requireAdmin)` after the
  routes, `Object.assign(user, req.body)`; Spring `@PreAuthorize` without
  `@EnableMethodSecurity`, `this.adminOp()` skipping the proxy, `hasRole`
  vs `hasAuthority`; ASP.NET `Roles="Admin,User"` is OR; DRF
  `get_permissions()` → `[]`; Rails `params.permit!`. (`[AllowAnonymous]`
  beating `[Authorize]` is authn-coverage's.)
- Spring: `requestMatchers` patterns that miss the mapped path;
  `@InitBinder` without `setAllowedFields`.
- Go: a handler registered on `r` instead of the admin group;
  `ShouldBindJSON(&user)` into the GORM model then `Save`/`Updates`.
- ASP.NET: `TryUpdateModelAsync(entity)` with no include list;
  `AddToRoleAsync` reachable by a non-admin.

### B7. How to evaluate it

Vulnerable/fixed pairs scored pairwise (PrimeVul-style), mined from GitHub
Security Advisories tagged CWE-269/266/915/863/1321 by reverting the fix
into a PR shape:
- role field on sign-up or self-update, flat and nested (Harbor, Ultimate
  Member, `accepts_nested_attributes_for :memberships`);
- un-awaited async guard (StudioCMS); deep merge of the body into a user
  object (shvl shape);
- grant guarded on one method or one mount only; `X-HTTP-Method-Override`
  past a GET-only guard;
- grant ceiling (CVE-2021-22538), cross-tenant `roleId` (GitLab shape),
  bot minted with `Owner`;
- account linking by `email` claim (nOAuth); setup re-entry (Confluence);
- self-approval; invite accept choosing the role;
- trusted acting-as header without stripping (WooCommerce);
- `IntEnum` role inserted mid-hierarchy; migration backfilling admin.

Revision 2 adds: tenant admin disabling a platform-enforced MFA
requirement; SSO metadata URL editable by a tenant member; webhook
callback URL changed by a non-admin; audit-retention write without a role
gate; an org-owner transfer without re-authentication (expected: a
question); a cookie-authenticated admin grant under `csrf_exempt`
(expected: a `chain-lead` row merged into access's).

Revision 3 adds: tenant owner's email changed by a lower role (Budibase)
and owner password reset by `user-admin` (Coder); `email_verified` and
`status: approved` bound from a self-update; a member-level settings
endpoint setting `default_role=admin`; a maintainer nesting their group
inside `infra-admins`; a role manager adding a permission it lacks to its
own role; a top-tier route behind sudo mode that a PAT route skips
(expected: finding, P2); a domain claimed without DNS proof feeding
auto-join (better-auth shape); an integration installed with org-wide
scopes by a member; a full-replace `PUT /settings` resetting
`mfa_required`; a reusable link invite carrying `role=admin`; a deny ACL
entry deleted by a lower role.

Benign controls that measure the exclusions (all must be NONE): a
non-top-tier grant (assign `editor`) with a correct guard and no step-up in
a repo with no step-up anywhere or in the threat model; an org owner
turning off their own org's optional MFA behind sudo mode; a
bearer-authenticated grant with no CSRF token; `createsuperuser` and a data
migration that seed an admin; a Pydantic update model without `role`; an
admin removing themselves; an env-only `AUTH_DISABLED` defaulting off.
Revision 3 benign controls: support impersonation listed in the threat
model's `roles:` section; a tenant admin changing their own tenant's
webhook URL; a migration granting `SELECT` to the app's runtime role; a
`settings/dev.py` auto-login and a compose dev override seeding an admin;
a new permission column defaulting `true` for roles that already had the
power; an admin-grant route in a repo with no step-up whose diff does not
touch the route or its guard.
Report recall on P0/P1 first, then the question-to-finding ratio and the
benign false-block rate. No run without the owner's go.

### Critique log

Points from the two critiques that were **rejected or only partly taken**,
with the reason. Everything else was applied as written.

- RT-13 (add Kubernetes, AWS, GCP and host pivots): rejected here.
  *Revision 2: infra's draft handed the same list back to privesc, so the
  synthesis moved all of it — and the host items below — to the new
  `pass-sec-iam`.* `pass-sec-iam` owns control-plane escalation (PassRole,
  RBAC verbs, secrets and workload-create-as-SA); one line must not produce
  two findings (precision §1). Forwarded to iam for its pattern list:
  `lambda:UpdateFunctionCode` on an admin-role function, `ssm:SendCommand`,
  `cloudformation:*`+PassRole, trust `Principal …:root`, third-party trust
  without `sts:ExternalId`, OIDC `StringLike sub repo:org/*` and missing
  `aud`, GCP workload identity pool without `attribute_condition`, `patch`
  on `aws-auth`/`mutatingwebhookconfigurations`, and the rule "creating a
  workload or editing code under an identity is holding it".
- RT-13 host items (sudoers `SETENV`/`LD_PRELOAD`, `setcap`, setuid, a
  root cron/unit running a lower-user-writable script): rejected here;
  `pass-sec-iam` step 3 (Host) owns them.
- RT severity note (workload-create in a cluster-admin namespace scores
  I1): moved with RT-13 to iam. The general form stays in Part A: a
  power that confers a higher one scores as the higher one.
- RT-6 (IP gates behind a trusting proxy): rejected as a privesc step.
  Infra's rule is "fix in config → infra", and the fix is the `trust proxy`
  / `ProxyFix` / `real_ip_header` value. Step 6 cites it as a proof gap.
- RT step 7 (CORS reflected origin with credentials): rejected. CORS policy
  is access's (authn-coverage §3). Kept the half that is privesc's: "JSON
  only" fails as a CSRF counter when the server parses `text/plain` or
  forms. *Revision 2: that half is now a `chain-lead` row, not a finding.*
- RT-14 (permission cache key without tenant): taken as one clause in step
  3, not a step. README gives cache-key tenancy to secrets-data; the clause
  is limited to a cached *role* read by a grant gate.
- RT step 1 (require the SQL and GraphQL grep): taken for the diff and
  newly reachable code, rejected for the whole tree in review (precision
  §3). Whole-tree inventory is scan and variant's.
- Precision §1 (cut step 5 entirely): rejected in favour of the alternative
  it offered — narrowed to privileged fields. The matching edit to access
  and authn-coverage is outside this file (open question 2).
- Precision §4 / §5 (one shared severity matrix and evidence include):
  deferred, not rejected. No shared security include exists yet and every
  sibling draft carries its own; switching one lens alone makes the family
  less consistent. Part A's matrix was trimmed (E4 column, P3 cell and the
  object-ownership I3 removed) so it can move unchanged.
- Precision §5 (move framework patterns to addenda): partly taken. Six
  cross-ecosystem traps stay in Part A because a lens planned on a mixed
  repo must still see them; the rest moved to B6.
- Precision §2 (step 6 ingress check becomes a question every time):
  taken by limiting step 6 to inputs the diff adds or newly reads; the
  ingress question itself is kept, since a trusted identity header is P0
  when unstripped and the fact really is outside the repo.

### Critique log (revision 2)

The second round: a red-team (RT2) and a precision critique (PR2) of the
revision-2 draft, applied as revision 3. Everything not listed here was
taken as written; this lists what was **rejected, only partly taken, or
corrected**, with the reason.

- RT2-6 (linking a new login method needs a bound `state` and recent
  re-auth): rejected as a privesc step. Account linking is tokens' (its
  step 8 "account linking needs a verified email or an authenticated link
  step", its step 10 "factor add"), and PR2 asked for linking to leave
  this lens. The privesc half is kept: a **lower role** linking a login
  method to a **higher** account is step 4's "taking a higher account".
- RT2-14 (delegate, forwarding and hidden-user flags, "MITRE T1098.002"):
  taken, citation corrected. T1098.002 is Additional Email Delegate
  Permissions and does not cover forwarding; forwarding is T1114.003
  (B4). Folded into step 4 rather than step 1, because the defect is the
  rank of the target, not the setting.
- RT2-1 (a lower role writing a higher account's recovery channel): taken
  into step 4 with an anchor against tokens step 10, which already owns
  "an admin override of another user's factor forces re-enrolment". Rank
  (who may change whose) is privesc's; the mechanics of the override are
  tokens'. Two real cases confirm the class (Budibase, Coder, B4).
- RT2-7 (domain claim without proof): taken; the better-auth advisory
  (B4) is the shipped instance. The critic's "DNS or file" was kept,
  though one SSO vendor argues file proof is weaker (subdomain takeover);
  that refinement is left to the validator.
- PR2 step 3 bullets 2–3 (all fail-open forms are authn-coverage's): bullet
  3 (matcher, method override, `@Public`/`permitAll`) and the B2
  path/method row were cut. Bullet 2 was **only narrowed**: the synthesis
  anchor gives "an authenticated route whose role gate is absent, weak or
  reads the wrong value" to privesc, and StudioCMS (an un-awaited
  *role* check on an authenticated route) is exactly that. Kept: an
  un-awaited role check, an error before `next()` in a role check, an
  `undefined` role passing `!==`, a policy defaulting allow.
- PR2 "add an E4 tenant-admin column": partly taken. E3 now reads "a lower
  role in the same tenant, or a tenant admin acting beyond its tenant",
  which scores the headline case without widening the matrix (kept 3×3
  so it can move into the shared include, open question 5).
- PR2 "cap weak-protection rows at P2": taken as "one tier below the
  grant's cell, never below P2", so an I1 grant with no step-up lands at
  P1 from E1/E2 and P2 from E3. A flat P2 cap would rank an
  unauthenticated-reachable owner transfer with no re-auth beside a
  missing notification.
- PR2 CWE list to ~5 (269, 862/863, 915, 290, 693): partly taken; seven
  remain. 290 left with the identity headers; 1321 stays because step 5
  names prototype pollution; 640 was added for recovery-channel writes
  (the Budibase CWE).
- PR2 "the setting list is written three times": partly taken. Part A
  lists the settings once (step 1); the severity paragraph names only the
  scoring classes. B1's regex must spell patterns and stays.
- PR2 step 8 "every writer" is a whole-tree inventory: partly taken. The
  step now runs only when the diff touches setup, but still greps that one
  flag's writers. Confluence's re-entry came through a writer the
  vulnerable change did not name; one targeted grep is not an inventory.
- PR2 step 2 "every mount": taken as "every mount of a sink the diff adds
  or changes"; the mount search for that sink is kept, since "a guard on
  one mount proves nothing about another" is the most common miss.
- PR2 DB grants and RLS: taken and assigned. Migration `GRANT`s and role
  membership go to `pass-sec-iam` (platform grant graph), RLS tenant
  predicates to access; a request-time `GRANT` stays. The synthesis has
  not ruled this (open question 8).
- PR2 retention inside a platform floor: taken, with the floor cited;
  without a cited floor the exclusion does not apply.
- PR2 open question 6 (drop orphan chain leads): taken. Recall cost: a
  cross-site grant route that access misses and no chain uses is lost;
  accepted because posting it duplicates access's finding by design.

### Open questions for the owner

1. ~~Who anchors an **unauthenticated** role-grant route~~ — answered by
   the synthesis: authn-coverage (fixed by adding a guard); a weak or
   absent role gate on an authenticated grant route stays here. Still to
   ratify (SYNTHESIS §6).
2. ~~Mass assignment of privileged fields moves from `pass-sec-access`~~ —
   answered: the privileged fields are privesc's (revision 3 widened the
   list, B3), ordinary fields access's. The README §3 row and access's
   text still need the edit.
3. ~~Host privilege: infra or a host lens?~~ — answered: `pass-sec-iam`.
4. Build the removed-guard and role-enum-shift detectors in the daemon
   before this lens ships, as planning signals?
5. Create a shared security include (evidence block, four outcomes,
   exclusion addendum, severity matrix) now, so every `pass-sec-*` lens
   drops its own copy in one change? (SYNTHESIS M11 plans it.)
6. ~~Post or drop an orphan `chain-lead` row~~ — revision 3 drops it (PR2);
   confirm the recall cost is acceptable.
7. ~~Which settings are top tier~~ — revision 3 adds IdP or signing
   certificate added or replaced, a domain claimed, a SCIM token minted,
   an admin's recovery channel changed (RT2-9; Okta 2023, APT29). Ratify
   the list.
8. Database roles: migration `GRANT`s and role membership go to
   `pass-sec-iam`, RLS tenant predicates to access, request-time `GRANT`
   stays here. SYNTHESIS §1 should record it.
9. The threat model (README §5) needs two fields this lens now reads: an
   intended-powers list under `roles:` (support impersonation,
   break-glass, owner console) and a "no step-up by design" flag. Add them
   to the schema?
10. Tokens' draft should state the mirror anchor: it owns how a factor,
   recovery or linking change is verified; privesc owns who may make it
   on whose account. Edit `pass-sec-tokens.md` steps 8 and 10?

### Revision 2 notes

Applied after the synthesis (`SYNTHESIS.md` §1–§2, README §11.1).

- **Platform grant graph removed.** Part A's "Apply to" and "Stay inside"
  no longer hand cloud IAM, Kubernetes RBAC, host grants or IP allowlists
  to infra; they name `pass-sec-iam` for the grant graph (IAM, trust and
  federation incl. CI OIDC `sub`/`aud` and GCP WIF, RBAC, sudoers,
  setuid/setcap, docker group) and infra only for reachability and proxy
  trust. B1's file exclusion, B3 and the critique log were corrected to
  match; the RT-13 forwarding list now goes to iam.
- **Anchor lines that contradicted the split were fixed.** "A grant route
  with no authentication is anchored here at the write" became the
  synthesis rule (no authentication → authn-coverage). "A demoted role
  still cached → toctou" became "a role in a server cache is privesc's, in
  a credential tokens'". Access is described as narrowed (object-level,
  ordinary mass assignment, CSRF/CORS/framing).
- **Security-setting writes joined the sink inventory** (step 1): MFA
  requirement, SSO/IdP config, metadata URL and certificate, allowed
  domains and JIT, in-app IP allowlists, session and password policy,
  webhook/callback URLs, audit deletion and retention, auth-gating flags,
  rate-limit and lockout switches. They run through steps 2, 4 and 9, with
  one new ceiling rule (a tenant admin never weakens a platform-set
  control), a severity sentence, CWE-693, a trigger regex and a validator
  row. Rationale: real takeovers in this class wrote no role at all — Okta
  2023 added an IdP, APT29 added a SAML signing certificate — so a lens
  keyed only on role writes would pass them.
- **Weak protection is no longer purely relative.** `precedent` now
  accepts a `.qcr/threat-model.md` line as well as a sibling path, and
  the top tier (become owner, grant admin, disable MFA org-wide) without
  recent re-authentication is a question with no precedent at all. The
  benign control "admin grant, no step-up anywhere → NONE" in B7 was
  therefore changed to a non-top-tier grant, and the top-tier case added
  as an expected question. Basis: OWASP's MFA cheat sheet lists disabling
  MFA and elevating to admin as actions that need fresh authentication
  and warns that the active session may be hijacked; GitHub's sudo mode
  is the shipped shape of the counterevidence.
- **Cross-site moved out.** CSRF/CORS/framing on privileged routes is
  access's. Step 9 now emits a `chain-lead` row (new evidence line) for a
  cookie-authenticated grant or setting route forgeable cross-site; B2
  says how it merges with access's row or feeds `compose`. The E1 example
  "a cross-site-forgeable admin grant" left the severity text.
- **Length.** To keep Part A near 230 lines the trap list was compressed
  and a few framework details (Devise `permit`, `Reflector.get`, `ROLE_`
  prefix, `;`/`..`/`HEAD` matcher variants) moved to B6; matcher-vs-router
  in general is authn-coverage's.
