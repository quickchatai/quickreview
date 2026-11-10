<!-- Coverage audit of the six drafts against the owner request, 2026-11-02, BEFORE revision 2; its gaps were the input to revision 2. -->

# Coverage audit: the six security lens drafts against the owner's request

## Owner's items: which lens covers each, and how deeply

| Owner item | Lens · worksheet step | Depth |
|---|---|---|
| Firewalls are set up | `pass-sec-infra` §1 Inventory, §3 `declared`/`covers`/`precedence`, plus "Facts that make a declared control inert" (Host, Cloud network, Kubernetes) | Deep |
| Firewalls are actually up (enabled, attached, enforced) | `pass-sec-infra` §3 `enabled`/`attached`/`selects`/`enforced`/`persists`/`environments`, §4 the cross-environment and default comparison, the proof-gap gate | Deep for the config the PR ships. Live state is never a finding, so a policy the CNI does not enforce or an imperative drift can only be a question. That is the right limit, but the owner should know "is it up right now" stays outside what the lens can establish. |
| Exploit-chain construction, several strategies | `pass-sec-exploit-chain` §1–8. Strategies `forward`/`backward`/`compose`/`delta` run as separate instances, with a glue check at §5 and hop status at §8 | Deep. One caveat: in review it only runs when the PR adds a hop (§7). With no STRATEGY set it runs `delta` alone, so the other three strategies run only if the planner emits their rows. |
| Privilege escalation, application role model | `pass-sec-privesc` §1–5, 10–11 | Deep |
| Privilege escalation, cloud IAM, Kubernetes RBAC, sudoers/setuid | **Nobody.** The revised `pass-sec-infra` (lines 26, 313; revision notes, line 507) says privesc owns the grant graph. `pass-sec-privesc` (lines 30, 227, 337) still says infra owns it, and lists it as an open question at line 507. | **Uncovered.** It shows up only as chain glue (`iam:PassRole`, `actAs`, an OIDC `sub` wildcard under "Pairs that compose") and as infra's `tamper` link. |
| Token rotation: refresh tokens and API keys | `pass-sec-tokens` §6 (rotate on refresh, family revocation on reuse per RFC 9700 §4.14, regenerate voids the old key) and §4 (lifecycle event × token kind) | Deep |
| Token rotation: signing-key and secret rollover | `pass-sec-tokens` excludes "no rotation schedule for operator secrets or fallbacks" (line 169) and B5 calls rotation operational | **Shallow.** No lens checks the rollover code: retired `kid`s still accepted, a `SECRET_KEY_FALLBACKS` list never pruned, a JWKS cached past rotation, no code path to revoke a leaked key. |
| APIs not checking tokens | `pass-sec-authn-coverage` §3–7, 9–10: effective-chain table, siblings, matcher vs router, rejecting branches that do not stop the request, every transport. `pass-sec-tokens` §2 handles a verifier that checks too little. | Deep |
| TOCTOU | `pass-sec-toctou` §1–7 plus "Shapes" (non-serializers, uniqueness, conflict handlers, webhooks, check and use bound to different objects, CI mutable ref) | Deep |
| Unprotected admin overrides: override inputs and identity headers | `pass-sec-privesc` §6, `pass-sec-authn-coverage` §8, exploit-chain "Trusted headers" | Adequate |
| Unprotected admin overrides: admin endpoints that rewrite security settings | Not owned. Privesc §1 lists only *grant* sinks. | **Gap.** Examples: an org-wide MFA requirement turned off, an SSO/IdP config replaced, allowed email domains, an in-app IP allowlist, webhook or callback URLs, password policy, a feature flag that gates auth. None of these is a role write, and `pass-sec-access` is request/object-centric. |
| Permitted escalation behind weak protection | `pass-sec-privesc` §9 (cross-site grant, invite or approval binding, missing step-up) and §8 (bootstrap re-arm) | Adequate, but **relative only**. Missing step-up, approval or audit counts only when a sibling path in the repo has it (`precedent`, line 184). A repo where *no* path has step-up never gets flagged. The threat model should also count as precedent ("admin grants require X"). |

## Named or implied, with no owner

1. **Cloud IAM / Kubernetes RBAC / host privilege escalation.** The infra and privesc drafts hand it to each other. This is the owner's "privilege escalation" applied to the owner's "infra", which makes it the most serious gap. One draft must take it: create/patch on RBAC `escalate`/`bind`/`impersonate`, `iam:PassRole` + create-compute, `serviceAccountTokenCreator`, trust-policy `Principal` wildcards, sudoers `SETENV`/NOPASSWD, setcap.
2. **Signing-key rotation correctness in code** (see the table).
3. **Security-configuration overwrite by an under-privileged admin or tenant-admin** (see the table).
4. **"Firewalls are up" at runtime.** This is by design, but nothing tells the owner the lens answers "declared and wired" and never "running". A question or a scan-side note should say so.

## Five most important adjacent classes still uncovered across the roster (README §3 + six drafts)

1. **CSRF, CORS and clickjacking on privileged endpoints.** `tokens` (line 181/337), `privesc` (line 222/473) and `authn-coverage` (line 185) all hand these to `pass-sec-access`. README §3's `pass-sec-access` row does not list them. Today they appear only in privesc §9 (grants only) and as exploit-chain "Browser hops". The orphan needs one owner: credentialed `Origin` reflection, `SameSite=None` plus state change, GET writes, `text/plain` JSON parsing, framing of admin consoles.
2. **Account recovery and MFA lifecycle.** `tokens` §5 covers reset tokens and §4 covers revocation on events, but nothing checks the *authorization* of recovery actions. Not covered: MFA disable or reset without re-auth, recovery-code generation and storage, phone or email change without re-verification as a takeover path (only a chain hop today), support or helpdesk override flows, "remember this device" tokens. Session fixation is adequately handled (tokens §4, CWE-384).
3. **Business-logic abuse that is not a race** (ASVS 5.0 V2.3, CWE-840/841): client-set price, plan or quantity (negative or overflow), skipping a workflow step (jumping to "approved" or "paid"), stacking coupons or trials, refund to a different instrument, limits enforced only in the UI. `pass-sec-toctou` covers only the concurrent form.
4. **Tenant isolation outside the request path.** Background jobs, exports and report generators, search-index queries without a tenant filter, shared object-storage prefixes, websocket rooms, and webhook fan-out that reuses a tenant context. The exploit chain lists "async principal" only as a hop shape, and `pass-sec-access` checks "tenant key on every query" request by request. No lens owns it as a single-defect finding.
5. **Audit-trail integrity and detection evasion** (A09). Not covered: a privileged action that writes no audit record, an admin or tenant-admin who can delete or edit audit logs, CloudTrail/audit sinks disabled or unattached in IaC, impersonation not attributed to the original actor. Privesc §4 asks the last question for impersonation only. `pass-sec-infra` lists flow logs as excluded hardening, and `secrets-data` covers only secrets *in* logs.

SSRF to cloud metadata as a chain hop is **covered** and needs no new lens: `pass-sec-boundaries` handles SSRF, `pass-sec-infra` §5 covers IMDS and the node SA, and exploit-chain "Pairs that compose" has the `http_tokens` nuance.

## Recommended fixes, cheapest first

- Settle the IAM/RBAC/host handoff in one draft and update the other.
- Add CSRF, CORS and framing explicitly to the `pass-sec-access` row, or to privesc §9 for every state-changing admin route.
- Extend privesc §1 grant sinks to "security-setting writes".
- Let the threat model serve as `precedent` in privesc §9.
- Add a code-level key-rollover row to tokens §6.

Files read: `docs/research/security-review/README.md` and the six drafts under `docs/research/security-review/lenses/`.