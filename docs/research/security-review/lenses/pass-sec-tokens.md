# `pass-sec-tokens` — draft lens and design notes

Drafted 2026-11-02 for the security profile
([`../README.md`](../README.md) §3), and revised the same day after a
red-team critique and a precision critique (B8), then for the synthesis
(revision 2: rollover, recovery, the `pass-sec-iam` split; see "Revision
2 notes" at the end), then once more after a red-team and a precision
critique of revision 2 ("Critique log (revision 2)"). Status: **proposal, nothing built.** Part A is the
lens file as it would ship at `agents/pass-sec-tokens.md`. Part B
explains the design and is not shipped.

---

## Part A — the lens

```markdown
---
name: pass-sec-tokens
description: Token and credential lifecycle pass (security profile) — for every credential check that runs, asks whether the token it accepts can be forged, replayed, used for the wrong purpose or account, outlive its revocation or its key, or reach someone it was not issued to, and whether a login path, factor change or recovery channel gets past the factors it should require; walks issue → verify → consume → refresh → rotate → revoke → recover per token kind and hunts the defeating control before writing.
tools: read, bash, grep, glob
---

{{include:prompts/pass-common.md}}

# Lens: token and credential lifecycle

Apply to: code that **issues, verifies, stores, transports, refreshes,
rotates or revokes** a bearer credential (session, JWT, refresh token, API
key, single-use code, OAuth `state`/`code`, SAML or WebAuthn assertion,
webhook or URL signature) or **changes an authentication factor**. Your
question: **the check runs — can the credential it accepts be forged,
replayed, used for another purpose or account, outlive its revocation or
its key, or reach someone it was not issued to?** No effective
verification (no check, decode-only, skipped on an empty secret, a result
that never stops the request) is `pass-sec-authn-coverage`'s.

## Worksheet — fill it in your notes before writing any finding

1. **Inventory.** Per token kind touched: kind · issuer and verifiers
   file:line · storage · transport · lifetime · key set; diff a second
   verifier cell by cell against the first. Promises: `.qcr/threat-model.md`.
2. **Verifier audit.** One cell per check: *checked at file:line* or
   *missing*. For a cell a finding rests on, read the library source at
   the lockfile version (`depsources`); otherwise write *default, unread*.
   - Signature or MAC before any claim is read; `alg` from a server
     allowlist tied to the key type (not unset, not from the header). A
     verifier that runs with an empty key accepts forgeries.
   - Key from a **fixed issuer allowlist in config**; `kid` selects within
     it (a `Keyfunc` trusting `kid` does not), and an unknown `kid` fails
     rather than falling back to a default key. `jku`/`x5u`/`jwk`, or a
     JWKS URL built from the unverified `iss`, is attacker-chosen. A
     multi-tenant issuer (Azure `common`, a shared Cognito pool) needs the
     tenant pinned; a workload token (`TokenReview`, CI OIDC) verified in
     app code checks issuer, `aud`, `exp`.
   - `exp` required, in seconds (`Date.now() + 3600` never expires;
     golang-jwt v5 skips a missing one without `WithExpirationRequired()`).
   - Purpose: an ID, reset, verify, refresh or invite token is not an
     access token. Each purpose has its own key, or a salt or `typ` the
     verifier checks; signing user-chosen data with the session key mints
     sessions (`itsdangerous` with no salt).
   - Auth state: a pre-MFA, step-up-pending, password-expired or
     impersonation session is not a full one on any route (`mfa_pending`
     set, guard reads only `user_id`). In a pre-MFA session, enrolment
     serves only accounts with no factor and never replaces one.
   - Identity from decryption alone (CBC/CTR cookie, JWE with no inner
     signature) is forgeable unless AEAD with a server-only key.
3. **Claim consumers.** Every claim read comes from the verified object,
   not a second decode. Per authorization claim: re-read per request, or
   trusted until `exp`? Per scope field (key `read_only`, PAT or OAuth
   scopes), find its **reader** on each mutating route it reaches. Identity
   is `iss`+`sub` (a tenant's SSO: connection + `sub`/NameID), never
   `upn`/`preferred_username`; an email only when verified and, for a
   tenant's SSO, inside a domain that tenant verified. JIT provisioning
   never attaches to an account outside its connection.
4. **Lifecycle events.** Per event the code handles (login, MFA
   completion, privilege change, logout, password or email change, reset,
   MFA change, demotion, deactivation, org removal, key revoke) × token
   kind: the handler file:line, what it voids (session rows, stamp or
   `token_version`, denylist, refresh family, remember-me, pending links,
   OAuth grants), and the read of that state in **every** verifier of the
   kind (refresh, socket upgrade and open connection, secondary APIs).
   Event fires, one verifier still accepts → finding, with the window.
   API keys, PATs and grants re-check the owner's active flag and
   membership on each use. Login, MFA completion and privilege change
   issue a new session id (CWE-384). A role held **in a credential** is
   yours; a cached one is privesc's.
5. **Single-use tokens** (reset, verify, magic link, invite, OTP, `code`):
   - CSPRNG, ≥128 bits (not `random`, `Math.random`, `uuid1`, `time()`).
     Numeric codes: count the bits and find the attempt cap, kept per
     account across resends, sessions and IPs. TOTP stores the last
     accepted step (RFC 6238 §5.2), window ≤ ±1.
   - Stored hashed or server-side; bound to one user and one purpose;
     expiring; consumed on use; voided by a newer issue, a password change
     and, for resets, an email change.
   - **The account a consume or second-factor step acts on comes from the
     server record** (token row, pending-login record), as do OTP resend
     and remember-device issue; a `user_id`/`email` in the request is
     attacker input (`POST /reset {token, email, password}`).
   - Both sides non-empty strings before the compare
     (`user.reset_token == body.token` with both unset; PHP `==`).
   - Address and link host from the record and config, never the request
     (`Host`, `X-Forwarded-Host`, an array-valued email).
6. **Refresh.** Re-reads role, scopes, tenant and the active flag from the
   store; `sign({...old, exp})` carries a demotion through the chain.
   Bound to its `client_id`; scope cannot widen. A public client's refresh
   token is sender-constrained, or rotates with replay revoking the
   family (RFC 9700 §4.14).
7. **Inbound MACs** (webhooks, signed URLs and cookies): every
   security-relevant parameter (path, method, expiry,
   `response-content-disposition`) inside the MAC, delimited
   (`hmac(user + role)`: `"ab"+"c"` = `"a"+"bc"`) · no truncating hash
   (bcrypt drops bytes past 72) · constant-time compare (never `==`) ·
   timestamp in the MAC, tolerance bounded and non-zero · event id
   deduplicated for non-idempotent effects.
8. **OAuth, OIDC, SAML, WebAuthn.**
   - Client: `state` bound to the session and compared (or PKCE `S256`) ·
     response `iss` with several providers · ID-token `nonce` · no token
     in a query string. Linking needs a verified email or an authenticated
     step; when SSO or verification claims an account created unverified,
     its password, sessions and factors are voided, or it stays unmerged.
   - Authorization server: the code is bound to `client_id` and
     `redirect_uri`, re-checked at `/token`, single use; `code_verifier`
     required when a challenge was sent, refused when none was, no `plain`.
   - SAML SP: the element read is the one the verified signature
     references, not a fresh XPath lookup; the Assertion is signed; NameID
     survives XML comments; `Audience`, `NotOnOrAfter`, `InResponseTo`.
   - WebAuthn: a single-use server challenge from the session; `origin`
     and `rpIdHash`; the credential is the logging-in account's
     (`userHandle`); UV when it is the only factor; sign counter compared.
9. **Key and secret rollover** (code, not the operator's schedule). Per
   key set (JWKS, `SECRET_KEY_FALLBACKS`, webhook secrets, API-key rows,
   `MultiFernet`): how does a key leave, and does it then stop working?
   - A row only when the repo holds the removal step: a committed
     fallback list that holds a retired entry and grows; a revoke path
     (admin endpoint, DB row) whose write a boot-time copy never reads.
   - Rotate, regenerate and revoke void the old credential where the
     verifier looks (not a new API-key row beside an active old one, not
     a reissue with no `token_version` bump); a bounded overlap is fine.
   - As issuer, the published JWKS holds public members only (no `d`,
     `p`, `q`, `k`); a retired key leaves once its tokens expire.
10. **Recovery and factors.** A factor change (password, MFA enrol,
    disable or reset, recovery-code regenerate, email or phone, minting a
    PAT, API, SSH or deploy key, app password, linked identity, OAuth
    grant or passkey) needs the password and, with MFA on, a factor, now
    or by a step-up stamp kept per session. A re-auth with no password to
    compare steps up another way (a factor, `prompt=login`), never passes.
    - Every login path (SSO or social callback, magic link, passkey
      fallback, key-to-session exchange, mobile grant) ends in the MFA
      gate unless a checked `amr`/`acr` proves the factor. A reset or
      recovery code never skips an enrolled factor.
    - A new email or phone counts once verified; the old one confirms or
      is told. Recovery codes: CSPRNG ≥64 bits, hashed, single use,
      capped; regenerate voids the old set. Remember-device tokens:
      server-side, one user, expiring, voided by a password or MFA reset.
    - A support override the PR adds or changes (not a framework admin
      console or declared break-glass credential) forces re-enrolment or
      a reset link, never a chosen password, and voids the target's
      sessions and remember-device tokens.
11. **Hunt the defeating control** per failing row, recording where you
    looked: a per-request store read, a stamp or `token_version` compare,
    a denylist, a library default at the lockfile version. An **upstream
    verifier** (gateway, `auth_request`, mesh) counts once its strip or
    overwrite of the identity is cited; a path around it defeats it only
    when cited (a second ingress, a public Service). **Global middleware**
    counts with its exclude list read. "Not found" goes in `proof-gaps`.
    Report failing rows only; `NONE`, naming the kinds inventoried.

## Excluded — never a finding, never a question

- Framework token defaults (DRF `authtoken` never expiring,
  `has_secure_token` plaintext, django-otp plaintext recovery codes,
  cookie defaults) that the code, threat model and PR leave alone.
- Missing `aud`/`iss`, unless the repo or threat model shows a second
  relying party, a shared key, or a public multi-tenant issuer (Google or
  Firebase ID tokens, Azure `common`, a shared Cognito pool).
- "Is X set in production?"; a lifetime you would choose differently; a
  window ≤ 15 min; key age or rotation schedule; a secret read at boot
  from the environment; a fallback added as a rotation step; JWKS cache
  policy; existing cloud keys or k8s `service-account-token` Secrets.
- Entropy of UUIDv4 or ≥128-bit CSPRNG tokens; timing on a hashed lookup
  or digest compare; browser token storage with no XSS sink; rate limits,
  except a code under ~40 bits with no cap found (DRF throttles,
  django-axes, rack-attack, Devise `lockable` are caps); IdP-hosted OTP.
- Dev and test setups (unsigned-token helpers production never imports,
  `docker-compose.dev`, local Keycloak or mock-OAuth realms, `examples/`,
  fixtures); a client sending its own token to a third party; a CLI
  storing its user's token; hosted SDKs (NextAuth, Clerk, Auth0, Firebase
  `verifyIdToken`) and managed authorizers (API Gateway JWT, ALB OIDC,
  Cloudflare Access) used as documented; key sets held outside the repo
  (IdP JWKS, KMS, Vault); a cookie flag the PR does not weaken; CSRF.
- Revocation with no event the code handles (step 4) meant to end access;
  a missing MFA, recovery or notification feature.

## Evidence — the family block, plus these lines

    token:   <kind> — issuer <file:line>; verifier <file:line>; library <name@lockfile version, when a cell rests on it>
    holder:  <anyone | any user | password holder | session thief | former member | old-key holder | URL reader | another service>
    window:  <seconds | N min | exp=N | refresh lifetime | forever>

`controls` names each failing step-2 cell with its file:line.

## Severity — impact × exposure, never demoted for "unlikely"

Exposure: remote unauthenticated > remote authenticated >
tenant-internal > local/operator. A claim is **privileged** when it gates
admin, cross-tenant or money actions.

- **P0** — anyone mints an accepted token (`alg` confusion, `none`, an
  attacker-chosen key, private members in a published JWKS, an empty key
  a shipped config leaves empty, unauthenticated encryption, SAML
  wrapping, a forgeable privileged webhook); takeover via a single-use
  token or second-factor step (account from the request, null equals
  null, reusable, attacker address or host, a cited cap bypass); one
  tenant's SSO logging into another tenant's user.
- **P1** — a broken promise on a privileged claim over 1 h, or refresh
  re-minting stale claims; partial auth as full (a login path, pre-MFA
  enrolment, reset or recovery code past an enrolled factor); an unread
  scope on a mutating route; shared-case `aud`/`iss`; a public client's
  refresh token neither rotated nor sender-bound; a token in a URL; an
  unverified email used for identity, a reset or a merge; an old
  credential still valid after revoke or regenerate; a factor change on
  a session alone that disables MFA, regenerates codes, or skips a
  re-auth a sibling route or the threat model requires; a re-auth
  passing with no password.
- **P2** — 15 min to 1 h, or a P1 at tenant-internal exposure; a
  non-constant-time compare of a long-lived static secret; a retired key
  with no end; a step-up stamp kept on the user; a PR weakening a session
  cookie flag or widening its `Domain` to a parent shared with tenants.
- **P3** — local/operator exposure; any other factor change on a session
  alone, as a question; a remember-device token surviving a reset. A
  low-confidence P0 stays P0 and posts as a question, as does a guessable
  code whose cap was not found.

`reachability`: `routine` for anyone or any user, `contrived` only with
operator access, `plausible` for every other holder, as expected.

## Stay inside your lens

No effective verification, a webhook MAC checked after parsing, or a
client-settable identity header → `pass-sec-authn-coverage`; this
principal on this object → `pass-sec-access`; role grants, cached roles,
SSO role mapping, domain claims, who may override or impersonate and what
impersonation may do → `pass-sec-privesc`; concurrent redemption, atomic
consume, parser differentials → `pass-sec-toctou`; a token in a log, a
literal secret → `pass-sec-secrets-data`; SSRF via `jku`, a client's
open redirect → `pass-sec-boundaries`; `kid` in a query →
`pass-sec-injection`; which workloads may obtain a token (trust policy,
CI OIDC `sub`/`aud`, WIF) and a long-lived key's grants → `pass-sec-iam`;
SA automount → `pass-sec-infra`. Anchor at the line holding the defect.
```

---

## Part B — Design notes (not part of the lens)

### B1. Planning triggers

**Plan rule.** In review: on any trigger below. A PR that changes a
threat-model-listed token control (verifier, session middleware, key
config) always plans it, as README §5.3 does for `pass-sec-access`. In
scan: plan it for an instance only when that instance's stage-1 file
ranking puts a file holding an issuer or verifier hit (the JWT, session,
single-use, signature and SAML regexes below) in its focus set. "The
threat model lists a token kind" would make it always-on for nearly every
web app.

**Co-plan.** When the privesc triggers fire on a demotion, deactivation or
member-removal change, and the repo holds a self-contained token (the
threat model lists one, or a JWT library is in the manifest), plan this
lens too. Those PRs rarely say "token".

**Path globs** (any changed file), kept narrow on purpose:
- `**/{auth,authn,authentication,identity,oauth,oidc,sso,saml,jwt,jwks,webhooks}/**`
- `**/*{jwt,jws,jwk,jwks,oauth,oidc,saml,webhook,apikey,api_key,api-key,totp,mfa,2fa,magic_link,magiclink,password_reset,passwordreset,recovery_code,backup_code,keyring}*`
- Dropped as too noisy: `*token*`/`tokens/` (tokenizers, design tokens,
  LLM token counting, which includes this repo), `hooks/` (React), `keys/`
  (i18n), `*session*` (SQLAlchemy), `*reset*` (reset.css), `*refresh*`,
  `*signature*`, `*verify*`, `*otp*` (it matches "footprint"). These fire
  only together with a content hit.

**Patch probes.** Built-in probes in `heuristics.ts` are arbitrary regexes
over the unified patch, so they can read removed lines. Probes marked ±
match `^[+-]`, because deleting `algorithms=`, `audience=`, `verify_exp`,
`session.regenerate` or a `token_version` bump is the classic regression.
All others match `^\+`. Profile extensions are wrapped as `^\+` only
(`heuristics.ts:206`), so a profile cannot add ± probes.
- JWT receivers: `\b(jwt|jose|jws|JWT|Jwts)\.(decode|verify|sign|parse\w*)\s*\(`,
  `\b(jwtVerify|createRemoteJWKSet|jwks_?uri|verifyIdToken|ParseUnverified|get_unverified_(claims|header)|parseClaimsJwt|parseUnsecuredClaims)\b`
- Verifier options (±): `verify_signature|verify_exp|verify_aud|ignoreExpiration|algorithms\s*[:=]|audience\s*[:=]|issuer\s*[:=]|ValidateLifetime|ValidateAudience|ValidateIssuer|SignatureValidator|ClockSkew|leeway|clockTolerance|WithExpirationRequired|WithValidMethods|WithAudience|WithIssuer`
- Inbound credential reads: `(headers|META|get_header|header)\W.{0,30}(authorization|x-api-key|HTTP_AUTHORIZATION)` (case-insensitive), `\bBearer\s` on the same line as `split|startswith|startsWith|replace`.
- Sessions and cookies (±): `session\.(regenerate|destroy|flush|cycle_key)|cycle_key|reset_session|SESSION_COOKIE_(AGE|DOMAIN|SECURE|HTTPONLY)|express-session|cookie-session`; a cookie write only with an auth name: `(set_cookie|res\.cookie|cookies?\.set)\s*\(\s*["'][^"']*(sess|auth|token|jwt|sid|remember)`.
- Lifetime knobs: `expiresIn|expires_in|maxAge|max_age|SESSION_COOKIE_AGE|ACCESS_TOKEN_LIFETIME|REFRESH_TOKEN_LIFETIME|remember_for|reset_password_within`.
- Lifecycle (±): `\b(logout|log_out|sign_?out|revoke\w*|blacklist|denylist|token_version|security_?stamp|UpdateSecurityStamp|update_session_auth_hash|password_changed_at|refresh_token|ROTATE_REFRESH_TOKENS|BLACKLIST_AFTER_ROTATION|SECRET_KEY_FALLBACKS)\b`;
  `invalidate|rotate` only on a line that also matches `session|token|credential|secret`.
- Rollover (±, revision 2): `\b(SECRET_KEY_FALLBACKS|MultiFernet|previous_keys|old_secrets?|key_version|keyring|includePrivate|private_?jwk)\b`;
  `rotate|regenerate|roll` only on a line that also matches `key|secret|token|kid|jwks`.
  The JWKS cache knobs (`cooldownDuration`, `cacheMaxAge`, `rateLimit`) were dropped with the refetch row.
- Recovery and factors (revision 2): `\b(recovery_?codes?|backup_?codes?|remember_?(device|browser)|trusted_?device|(disable|reset|remove)_?(mfa|2fa|totp|otp)|(change|update)_?(email|phone)|email_?change|reauth\w*|step_?up|sudo_?mode|password_confirm\w*|has_usable_password)\b`.
- Login paths, minted credentials, SSO and WebAuthn (revision 2, critique pass): `\b(personal_?access_?tokens?|deploy_?keys?|app_?passwords?|ssh_?keys?|jit_?provision\w*|(saml|sso|oidc)_?connections?|passkeys?|webauthn|userHandle|rpIdHash|verifyAuthenticationResponse|verify_authentication_response|amr|acr_values)\b`;
  `login\(|log_in\(|sign_in\(|signIn\(` only in a file whose path matches `callback|oauth|sso|saml|magic|passkey`.
- Single-use: `\b(reset_password|password_reset|PasswordResetTokenGenerator|generates_token_for|magic_?link|invite_?token|verification_?token|email_?verif|otp|totp|mfa_pending|valid_window)\b`.
- Randomness: `secrets\.token_|crypto\.randomBytes|SecureRandom|random\.(random|randint|choice)|Math\.random|uuid1|uuid\.v1` on a line that also matches `token|code|secret|otp|reset|invite` (not `key`, which hits React keys; not `nonce`, which hits CSP).
- Signatures: `\b(hmac|HMAC|createHmac|compare_digest|timingSafeEqual|secure_compare|ConstantTimeCompare|FixedTimeEquals|MessageDigest\.isEqual|X-Hub-Signature|Stripe-Signature|X-Slack-Signature|webhook-signature|X-Twilio-Signature|presign\w*|signed_?url)\b`.
- OAuth: `\b(redirect_uri|code_verifier|code_challenge|authorization_code|grant_type|email_verified|id_token|preferred_username)\b`. Dropped: `nonce`, `state=`, `access_token` (every outbound client).
- SAML: `ruby-saml|python3-saml|passport-saml|node-saml|OneLogin|Saml2|wantAssertionsSigned|NameID|signxml|xmlsec`.
- Manifest and lockfile changes to: jsonwebtoken, jose, express-jwt,
  passport-jwt, fast-jwt, next-auth, @auth/core, PyJWT, python-jose,
  python-jwt, authlib, djangorestframework-simplejwt, devise, ruby-saml,
  python3-saml, @node-saml/*, jjwt, nimbus-jose-jwt, golang-jwt,
  System.IdentityModel.Tokens.Jwt, Microsoft.IdentityModel.*. This
  overlaps `pass-sec-supply-chain`'s manifest trigger. That is
  intended: supply-chain reads the package, this lens re-reads the
  verifier cells against the new version's defaults.

Removed in the revision-2 critique pass: the helm/k8s glob on
`service-account-token|expirationSeconds`. Existing legacy SA token
Secrets are excluded in Part A, so the glob bought a pass with nothing to
report.

Removed from the first draft: `id-token: write`, `token.actions.githubusercontent.com`,
`attribute_condition`, `federated_identity_credential` and `aws_iam_access_key`
(now `pass-sec-iam`'s triggers), `automountServiceAccountToken` (`pass-sec-infra`), the bare `\b(decode|verify|sign)\s*\(`
(base64, JSON, `Math.sign`), and `set_cookie` for any cookie.

### B2. Validator guidance

The validator re-derives each claim by reading, labels each evidence line
*valid / plausible / contradicted*, and names the endpoint that fails.

| Claim | Verified by reading | Counterevidence that refutes | NOT counterevidence |
|---|---|---|---|
| Verifier cell missing (`alg`, key source, `exp`, purpose) | The verifier call and its options; the dep source at the **lockfile** version when the cell rests on a default. | The library version's source enforcing the check; a cited verifier in this repo that runs first on this route with the cell set. | "The library is secure by default" with no version read. PR text. |
| Upstream verifier covers it | The edge config stripping or overwriting the identity; any second ingress or public Service the repo declares. | The strip cited, and no cited path around the edge (a NetworkPolicy, security group or threat-model line counts as the control). Reachability beyond that is `pass-sec-infra`'s. | A gateway described in docs; a strip on one `location` block but not this one. |
| Missing `aud`/`iss` | The verifier options, plus who else trusts the issuer or key. | No second relying party or shared key evidenced and the issuer is not public multi-tenant. Then the claim is **excluded**, not refuted. | "Our IdP only issues tokens for us" when the issuer is Google, Firebase or Azure `common`. |
| Unread scope | Each scope field and every route the token kind reaches. | A cited reader on that route (decorator, guard, policy). | The scope being parsed or stored ("parsed" is not "read for a decision"). |
| Revocation broken promise | The event handler, the state it writes, and whether the verifier reads it. | The verifier reads `token_version`, stamp, denylist or session row (cited); `exp` ≤ 15 min. | "Tokens are short-lived" with no `exp` value. "Users rarely get demoted." |
| Refresh re-mints stale claims | The refresh handler: where each claim in the new token comes from. | A store read of role, tenant and active flag (cited) before signing. | A store read of the user's existence only. |
| Single-use defect | Generator, storage, consume step, binding, compare. | Account read from the token record; a non-empty guard before the compare; a hash input that includes the password; a server-side address lookup. | "Reset links are emailed, so only the user sees them" when the address or host comes from the request. |
| Webhook/HMAC | The parameters covered, the delimiting, the compare, the tolerance, the dedupe. (Raw body and the failure branch are authn-coverage's.) | An official SDK verifier (`constructEvent`, `parse_event_notification`) used with the raw body (cited). | IP allowlisting described in docs but absent from the repo's infra. |
| SAML | Where the read element is located vs the signed reference; assertion-signed setting. | The library returns the verified assertion object and the code reads only from it (cited at the lockfile version). | "We use a well-known SAML library" (CVE-2024-45409 was in one). |
| Rotation/reuse detection | The refresh handler and the family or denylist store. | Sender-constrained refresh (DPoP/mTLS) or a confidential client only (RFC 9700 §2.2.2 allows either). | "Refresh tokens are stored securely on the client." |
| Rollover: old key or credential still verifies | The key set the verifier reads, how a key leaves it (prune, `not_after`, store update), and the rotate/regenerate/revoke handler's write against the verifier's read. | A cited removal path the verifier honours (a `not_after` compare, a pruned list, the old row deactivated in the same write); a bounded dual-verify window. | "We rotate keys every 90 days" (operational, excluded both ways); a fallback list in the environment; a fallback a PR adds as the first step of a documented rotation. |
| Published JWKS leaks private members | The serializer that builds the JWKS response and what it is given (keyring object vs public projection). | A public-only export call cited (`export({format:'jwk'})` of a public `KeyObject`, `public_key()` before serializing). | "The endpoint only lists public keys" with no serializer read. |
| Key or purpose separation | The signer and verifier for each purpose: key, salt, `typ`/`aud`. | A distinct salt, key or checked `typ` per purpose, cited at both ends. | Different expiry per purpose: it does not stop a cross-purpose replay. |
| Login path skips MFA | Every route that ends in `login(user)` or sets a full session, and the MFA gate the password route uses. | The same gate on that path, or a checked `amr`/`acr` from the IdP (cited). | "SSO users don't have TOTP" when the account model lets them enrol. |
| Cross-tenant SSO identity | The SSO callback's account lookup and JIT provisioning: what key it matches on. | A match on `(connection, sub)`, or email limited to the connection's verified domains (cited). | "Tenants only configure their own IdP": the IdP's assertion is attacker-controlled for any other tenant's emails. |
| WebAuthn assertion | The verify call's options: expected challenge source, origin, RP ID, the credential-to-user lookup, UV. | A maintained library called with the session challenge and the user's own credential list (cited). | "The browser enforces origin": the server must check it. |
| Factor or recovery change on a session alone | The handler for each action in step 10 and every guard on its route; for severity, the sibling factor routes and the threat model. | A cited password or factor check in this request, or a per-session step-up timestamp the handler reads with a bound. | A front-end confirm dialog; a client `reauthenticated=true` flag; "the user is logged in"; a stamp on the user row. |
| Email/phone change takeover | The change handler, when the new value starts to count, and whether the reset flow reads the pending or the confirmed value. | The reset flow reads only the confirmed address; the old address must approve or the new one is held until verified. | An email notification to the new address only. |
| Recovery code / remember-device defect | Generator, storage, consume, regenerate handler; the device-token record and what voids it. | Hashed storage, a consume that deletes the row, a regenerate that deletes the old set; a password-change handler that clears device tokens (cited). | "Codes are shown only once." |
| Support override | The override handler: what it sets on the target account and what it voids. | Forced re-enrolment or a reset link to the confirmed address, plus session and device-token voiding (cited). | An internal-only UI (who may call it is privesc's, and does not change what it does to the target). |

Rules for the validator, from README §4.4 and §9: PR intent is not
counterevidence; a pre-existing weak verifier newly reachable through a new
route is in scope (the hidden "callback `state` newly reachable" group in
§9.2); absence is not refutation; a library default is a fact to read, not
to recall, and an unread one is *plausible* with the version named.
Severity is computed from `holder` × sink × `window`. The validator checks
the facts, not the label.

**CWE mapping** (moved out of Part A in the critique pass; the family
block's `cwe` line carries the one that applies): 347 forged signature ·
345/353 unverified data or integrity · 287 improper authentication · 384
fixation · 613 insufficient expiration · 640 weak recovery · 620
unverified password change · 308 single-factor where MFA is enrolled ·
324 key past its expiry · 330/338 weak randomness · 294 capture-replay ·
208 timing · 598 token in a query string · 863 unread scope · 352 OAuth
`state` · 1390 weak authentication (WebAuthn checks) · 320 key
management (published private JWK members).

### B3. Overlap and boundaries

The rule: **this lens owns "the check runs; is the credential it accepts
genuine, current, correctly scoped and confined to its holder"**.

| Lens | Boundary |
|---|---|
| `pass-sec-authn-coverage` | Owns no effective verification: no check, decode-only, a skipped signature, a check skipped on an empty secret, a verify result that does not control the branch (its step 7), a webhook MAC computed after parsing or a failure branch that does not return (its step 10), and identity read from a client-settable header (its step 8). This lens owns verifiers that run but accept too much (including one running with an empty key), and a decoded copy used where a verified one exists. |
| `pass-sec-access` | Owns authorization of a valid principal on an object, CSRF/CORS/framing and `SameSite`. This lens owns authorization claims and scopes *inside the token*: forged, stale or never read. OAuth `state` stays here (login CSRF on the callback is a token-binding defect), pending the owner's ruling (B9). |
| `pass-sec-privesc` | Owns the endpoint that grants a role, **roles held in caches**, SSO role mapping and domain claims (its step 7), who may call a support override or impersonate, and what an impersonation session may do (its step 4: actions that outlive the session). This lens owns what an override does to the target's credentials (step 10), roles held **in a credential** and scope widening at refresh, and SSO **identity** resolution: which account a tenant's assertion logs into. Invite tokens: this lens owns the token's properties (CSPRNG, single use, binding to the invitee, expiry); privesc keeps "the role comes from the stored invite". Privesc step 9 lists both today; proposal in B9. When privesc's caller gate and this lens's effect on the target both fail on one override handler, the validator merges the rows on the sink (SYNTHESIS §1), so one handler posts one row. |
| `pass-sec-toctou` / `pass-concurrency` | Own double redemption, atomic consume, and parser differentials (two XML or JSON parsers, duplicate claim keys, mixed JWS serialisations). This lens owns a token never consumed at all, and SAML signature wrapping within one parser. Proposal: toctou drops its "cached authority" bullet, which privesc and this lens split by where the role is held. Concurrent-refresh false reuse detection is availability, so it goes to concurrency. Two parallel redemptions of one recovery code are toctou's; a code never consumed is this lens's. |
| `pass-sec-secrets-data` | Owns hardcoded keys, literal fallback secrets, secrets in logs, responses and traces, and weak crypto in general. This lens owns the *transport* cause (a token put in a URL) and storage for verification (a plaintext API-key table). Browser storage of tokens without an XSS sink is excluded in both. |
| `pass-sec-injection` / `pass-sec-boundaries` | Own `kid` reaching SQL or a path, Mongo operator objects in token lookups, SSRF via `jku`/`x5u`, and a client's open redirect after login (the client half of `redirect_uri`). This lens owns the forgery when the attacker effectively picks the key, and the authorization server's exact `redirect_uri` binding of a code. |
| `pass-sec-iam` | Owns the platform grant graph, including **which workloads may obtain a token**: cloud trust policies, CI OIDC `sub`/`aud`/`repository` conditions, GCP WIF `attribute_condition`, Azure federated credentials, k8s RBAC (`escalate`/`bind`/`impersonate`, `create serviceaccounts/token`). This lens keeps only what application code does with a workload token it verifies: issuer pin, `aud` naming this service, `exp`, and the lifetime of tokens it mints. Existing long-lived cloud access keys and legacy SA token Secrets are **excluded** here (Part A's third exclusion); iam's pointer to this lens for "long-lived keys existing" finds nothing to report, and the grants such a key carries are iam's. A home-made token exchange that maps a CI `sub` to a role in app code is iam's too: the condition is a grant, not a verification cell. |
| `pass-sec-infra` | Owns SA automount, exposure of a token endpoint or metadata service, and runtime privilege. A SAS's scope is a grant (`pass-sec-iam`); its expiry is this lens's lifetime cell; its leak is secrets-data's. |
| `pass-sec-supply-chain` | Owns workflow `permissions:` and `GITHUB_TOKEN` scope, and the package read on a bump. |
| `pass-sec-exploit-chain` | Consumes this lens's findings as links (a token leaked via Referer, replayed against a session that was not revoked, then admin). |
| `pass-sec-variant` | When a PR fixes one verifier, variant hunts the siblings repo-wide. Step 1 here only diffs a newly added verifier against an existing one. |
| `pass-sec-llm` | Owns tokens handed to model context or tools. |

### B4. Motivating incidents, CVEs and sources

- **CVE-2015-9235.** jsonwebtoken accepted HS256 signed with the RSA public key, and `none`. https://nvd.nist.gov/vuln/detail/CVE-2015-9235 · https://auth0.com/blog/critical-vulnerabilities-in-json-web-token-libraries/
- **CVE-2022-23540.** jsonwebtoken <9 accepted `none` with a falsy key and unset `algorithms`: fail-open on an unset secret. https://github.com/advisories/GHSA-qwph-4952-7xr6
- **CVE-2022-29217.** PyJWT key confusion with `ssh-ed25519` keys when all algorithms were allowed. https://github.com/jpadilla/pyjwt/security/advisories/GHSA-ffqj-6fqr-9h24
- **CVE-2023-48223.** fast-jwt missed `BEGIN RSA PUBLIC KEY` PEMs, so HS/RS confusion returned. https://nvd.nist.gov/vuln/detail/CVE-2023-48223
- **CVE-2022-21449.** Java ECDSA accepted an all-zero signature. https://neilmadden.blog/2022/04/19/psychic-signatures-in-java/
- **CVE-2022-39227.** python-jwt accepted a token mixing compact and JSON serialisation, so claims could be forged without the key (routed to toctou as a parser differential; listed here as a library-version case). https://nvd.nist.gov/vuln/detail/CVE-2022-39227
- **CVE-2024-45409.** ruby-saml signature wrapping: the verified element was not the element read, so any user could be impersonated (GitLab affected). https://nvd.nist.gov/vuln/detail/CVE-2024-45409
- **SAML comment truncation (2018).** XML comments inside NameID truncated the identity in several SAML libraries. https://duo.com/blog/duo-finds-saml-vulnerabilities-affecting-multiple-implementations
- **Storm-0558 (2023).** A consumer signing key was accepted for enterprise tokens because issuer/key scope was not validated. https://msrc.microsoft.com/blog/2023/09/results-of-major-technical-investigations-for-storm-0558-key-acquisition/
- **CVE-2023-7028 (GitLab).** A reset was delivered to a second, attacker-supplied email via an array parameter. https://about.gitlab.com/releases/2024/01/11/critical-security-release-gitlab-16-7-2-released/
- **Okta AD/LDAP delegated auth (2024).** A bcrypt cache key over userId+username+password ignored bytes past 72. https://trust.okta.com/security-advisories/ · https://josephscott.org/blog/2024/11/okta-bcrypt-and-52-character-usernames/
- **nOAuth (2023).** Apps keyed identity on Azure AD's mutable, unverified `email` claim. https://www.descope.com/blog/post/noauth
- **Cloudflare, Thanksgiving 2023.** Unrotated service tokens from the Okta breach were used to enter Atlassian. https://blog.cloudflare.com/thanksgiving-2023-security-incident
- **Okta support HAR files (2023).** Session tokens in uploaded HAR files were replayed. https://sec.okta.com/harfiles
- **Storm-0558, the rollover half (CSRB, 2024).** The 2016 consumer key was due for retirement in 2021, but manual rotation had been stopped and nothing alerted on old active keys, so it was still accepted in 2023. A key with no end in the verifier's set (step 9). https://www.cisa.gov/resources-tools/resources/CSRB-Review-Summer-2023-MEO-Intrusion · https://www.wiz.io/blog/key-takeaways-from-microsofts-latest-storm-0558-report
- **Okta help-desk resets (2023).** Callers talked service desks into resetting all MFA factors of Super Administrators, then raised other accounts and added a rogue IdP. The override path (step 10) is where code meets that attack: what a reset forces and voids. https://sec.okta.com/articles/2023/08/cross-tenant-impersonation-prevention-and-detection
- **Salesloft Drift (2025).** Stolen long-lived OAuth tokens bulk-exported Salesforce data across tenants. https://cloud.google.com/blog/topics/threat-intelligence/data-theft-salesforce-instances-via-salesloft-drift

**Normative sources:**
- RFC 9700 (OAuth 2.0 Security BCP: exact `redirect_uri` §2.1, PKCE §2.1.1, audience restriction §2.3, code single use §4.2.4, no tokens in query §4.3.2, mix-up §4.4, PKCE downgrade §4.8.2, refresh rotation and reuse revocation §4.14). https://www.rfc-editor.org/rfc/rfc9700.html
- RFC 6749 §4.1.3 (the AS checks the code was issued to this client and that `redirect_uri` matches). https://www.rfc-editor.org/rfc/rfc6749.html · RFC 7636 §4.6 (PKCE verification). https://www.rfc-editor.org/rfc/rfc7636.html
- RFC 8725 (JWT BCP: algorithm verification §3.1, validate every crypto op §3.3, key belongs to issuer §3.8, `aud` §3.9, `kid`/`jku`/`x5u` §3.10, explicit typing §3.11, cross-JWT confusion §3.12). https://www.rfc-editor.org/rfc/rfc8725.html
- RFC 6238 §5.2 (a TOTP verifier must not accept the same OTP twice; a small window). https://www.rfc-editor.org/rfc/rfc6238.html
- OWASP ASVS 5.0 V7 (7.2.3 ≥128-bit tokens; 7.2.4 a new token on (re)authentication; 7.4.1–7.4.3 termination) https://github.com/OWASP/ASVS/blob/master/5.0/en/0x16-V7-Session-Management.md and V9 (9.1.1–9.1.3 signature, alg, key source; 9.2.1–9.2.4 validity, type, audience) https://github.com/OWASP/ASVS/blob/master/5.0/en/0x18-V9-Self-contained-Tokens.md
- OWASP Session Management Cheat Sheet (renew the session id after any privilege-level change; `__Host-` prefix). https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html
- OWASP Forgot Password Cheat Sheet. https://cheatsheetseries.owasp.org/cheatsheets/Forgot_Password_Cheat_Sheet.html
- OWASP SAML Security Cheat Sheet (XSW, validate the signed element). https://cheatsheetseries.owasp.org/cheatsheets/SAML_Security_Cheat_Sheet.html
- Stripe webhooks (raw body; timestamp in the MAC; "Don't use a tolerance value of `0`"). Stripe's own Ruby example sets `status 400` on `SignatureVerificationError` without returning: the fall-through `pass-sec-authn-coverage` step 7 now hunts. https://docs.stripe.com/webhooks
- OpenID Connect Core 1.0 §10.1.1: "The verifier knows to go back to the jwks_uri location to re-retrieve the keys when it sees an unfamiliar kid value." https://openid.net/specs/openid-connect-core-1_0.html#RotateSigKeys · jose `createRemoteJWKSet`: an unmatched `kid` refetches only after `cooldownDuration` (default 30 s; `cacheMaxAge` 10 min). https://github.com/panva/jose/blob/main/docs/jwks/remote/functions/createRemoteJWKSet.md
- Django `SECRET_KEY_FALLBACKS`: move the old key to the front, then "remove the old values from the end … when you are ready to expire the sessions, password reset tokens, and so on"; "fallback values should be removed after an appropriate period". https://docs.djangoproject.com/en/5.2/ref/settings/#secret-key-fallbacks
- Standard Webhooks: the signature header is a list "to support zero downtime secret rotation"; the sender signs with the current and an old key "for a set period of time"; consumers try each. https://github.com/standard-webhooks/standard-webhooks/blob/main/spec/standard-webhooks.md
- Rails `ActiveRecord::Encryption::KeyProvider`: with key references stored, decryption picks the referenced key; without them it tries the full list. https://api.rubyonrails.org/classes/ActiveRecord/Encryption/KeyProvider.html
- NIST SP 800-63B-4: binding a new authenticator requires authentication at the account's AAL and a notification by an independent channel (§4.1.2); saved recovery codes ≥64 bits, stored hashed, and a recovery event always notifies (§4.2); look-up secrets single use (§3.1.2.2); "remember my browser" never replaces authentication. https://pages.nist.gov/800-63-4/sp800-63b.html
- OWASP ASVS 5.0: 7.5.1 full re-authentication before changing email, phone, MFA configuration or other recovery data; 7.4.3 terminate other sessions after a factor change; 6.4.3 a reset does not bypass enabled MFA; 6.4.4 lost-factor recovery proves identity at enrolment strength; 6.4.6 an admin starts a reset but never sets the password. https://github.com/OWASP/ASVS/blob/master/5.0/en/0x15-V6-Authentication.md
- OWASP MFA Cheat Sheet: reauthenticate with an existing factor before factor changes; "Do not rely solely on the active session, as it may be hijacked"; notify out of band on factor change. https://cheatsheetseries.owasp.org/cheatsheets/Multifactor_Authentication_Cheat_Sheet.html
- Microsoft identity platform: multi-tenant apps must validate the issuer/tenant themselves. https://learn.microsoft.com/en-us/entra/identity-platform/access-tokens

**Added in the revision-2 critique pass:**
- Sudhodanan & Paverd, "Pre-hijacked accounts: An Empirical Study of Security Failures in User Account Creation on the Web", USENIX Security 2022: five pre-hijacking attack types, among them an attacker-created unverified account later merged with the victim's federated login, and sessions that survive the merge (step 8's linking bullet). https://www.usenix.org/conference/usenixsecurity22/presentation/sudhodanan
- W3C WebAuthn Level 3, §7.2 "Verifying an Authentication Assertion": the relying party checks the challenge, origin, `rpIdHash`, UV when required, that the credential belongs to the identified user (`userHandle`), and the signature counter (step 8). https://www.w3.org/TR/webauthn-3/#sctn-verifying-assertion
- itsdangerous concepts: "The salt is combined with the secret key to derive a unique key for distinguishing different contexts"; one key serves all signers and the salt keeps a token from one context invalid in another (step 2, purpose). https://itsdangerous.palletsprojects.com/en/stable/concepts/
- RFC 7518 §6.2.2.1 (EC `d`), §6.3.2 (RSA `d`, `p`, `q`, `dp`, `dq`, `qi`) and §6.4.1 (`k`): the private and symmetric JWK members a published set must never carry (step 9). https://www.rfc-editor.org/rfc/rfc7518.html
- OpenID Connect Core §3.1.2.1: `prompt=login` and `max_age` force a fresh authentication at the IdP, and `amr`/`acr` report how it happened (step 10's re-auth for accounts with no password). https://openid.net/specs/openid-connect-core-1_0.html#AuthRequest

### B5. What a read-only reviewer cannot establish

- **Deployed configuration**: whether a secret is set, the real `exp` an
  IdP issues, gateway verification outside the repo, the IdP's `aud` and
  `email_verified` behaviour. After the revision these are *excluded* or
  *proof gaps* rather than questions, unless code skips on the missing
  fact. **Cover them with** threat-model entries ("tokens verified at the
  gateway, header stripped: yes/no; relying parties: …; access TTL: N").
- **Library behaviour at the installed version** when the dep source is
  not fetched. **Cover it with** daemon-side `depsources` prefetch for the
  token libraries in B1's manifest list, plus an OSV lookup of the lockfile
  versions for known JWT/SAML CVEs.
- **Remote timing and runtime RNG seeding.** The lens reasons from the API
  used; the compare finding is capped at P2.
- **Whether old keys or secrets were rotated.** An operational fact. The
  lens excludes it; an operator secret-age inventory covers it. Step 9
  (rollover) asks only whether the code *can* retire a key and stops verifying when
  it does.
- **Help-desk procedure.** How support staff verify a caller is outside
  the repo; step 10 reads only what the override endpoint does.
- **Cross-service audience reuse** in another repo. Excluded unless the
  threat model lists the relying parties.
- **Reachability around a gateway** (pod IP, second ingress) is often
  partly outside the repo. Since the critique pass, step 11 counts a
  cited strip at the edge as the control and lets a path around it defeat
  the control only when that path is cited; deeper reachability is
  `pass-sec-infra`'s.
- **Attempt caps held outside the repo** (a WAF rule, a Redis limiter in
  another service). A guessable code with no cap found is a P0 question,
  never a confirmed P0, unless a bypass is cited.

### B6. How to evaluate it

Ground truth is thin (§9.1 has almost no token-lifecycle items), so
evaluation needs seeded and mined cases. Each run waits for the owner's go.

- **Seeded PR pairs (vulnerable/fixed), scored pairwise**, across at least
  three stacks: `algorithms` from the header; JWKS URL from `iss`;
  `exp` in milliseconds; a pre-MFA session reaching `/settings`; an unread
  `read_only` key flag on `POST`; a demotion with no `token_version` bump;
  refresh copying `role` from the old token; a reset reading `email` from
  the body; `user.reset_token == body.token` with both unset; OTP attempt
  counter reset by resend; a reset link built from `request.get_host()`;
  a webhook with `tolerance=0`; `hmac(user + role)`; a signed URL that
  leaves `response-content-disposition` outside the MAC; an AS matching
  `redirect_uri` with `startswith`; an AS accepting a missing
  `code_verifier`; SAML reading NameID by XPath after verification; a CBC
  cookie carrying `role`; a gateway-only verifier with the service also
  exposed by a second ingress. Revision 2 adds: an API-key regenerate that
  inserts a new row and leaves the old one active; a JWKS lookup falling
  back to `keys[0]` on an unknown `kid`; a committed `SECRET_KEY_FALLBACKS`
  that already holds a retired key and grows again; MFA disable on a
  session alone; email change counting before verification while reset
  reads the new address; a password reset that logs in past TOTP;
  recovery codes not deleted on use; regenerate leaving the old set; an
  admin override that sets a chosen password. The critique pass adds: a
  Google callback calling `login(user)` past an enrolled TOTP; a PAT
  minted on a cookie alone while password change re-authenticates; tenant
  A's SAML connection asserting a tenant-B email; a pre-MFA session
  replacing the enrolled TOTP; `POST /mfa/verify {user_id, code}`;
  `if user.has_usable_password(): check(pw)` guarding MFA disable;
  `password_confirmed_at` on the user row; an unverified signup merged on
  a later Google login with the old password still valid; one Flask key
  and no salt for sessions and download links; a WebAuthn assertion
  accepted for another user's credential; a JWKS route serializing the
  keyring with `d`; an API key still accepted after org removal; logout
  writing a denylist the refresh endpoint never reads. Benign controls:
  `sudo_mode`/`password_confirm` middleware on the factor routes; a JWKS
  client at its default cooldown; `JWT_SECRET` read once from the
  environment; a PR adding the old key to `SECRET_KEY_FALLBACKS` as
  Django documents; `MultiFernet` with `previous:` keys; an API Gateway
  JWT authorizer in front of the service; the Django admin password form;
  django-otp static tokens as shipped; an email change form on a session
  in an app with no other re-auth route (a P3 question at most).
- **Removed from the seeded set by the critique pass**: a JWKS cache that
  never refetches or refetches per request, a try-every-key decrypt loop,
  a webhook verifying `JSON.stringify(req.body)` or not returning on
  failure (now authn-coverage's), a client-side `redirect_uri` prefix
  match (boundaries' open redirect; the AS case stays).
- **Real fix commits reverted onto their parents**: jsonwebtoken v9,
  PyJWT 2.4.0, fast-jwt 3.3.2, ruby-saml 1.17.0, the GitLab 16.7.2 patch.
- **Benign controls**, to measure the false-block rate the exclusions
  target: SDK webhook verification; SimpleJWT with blacklist on; a 10-min
  `exp` with no denylist; lookup by hashed token; a single-service app
  verifying a JWT without `aud`; DRF `authtoken` used as shipped; a test
  helper minting `none` tokens; a CLI storing its own PAT; `verifyIdToken`
  from Firebase; a tokenizer or design-token PR (trigger noise).
- **SEVRA-style framing**: the seeded pairs with "dev-only, intended"
  descriptions.
- **SecPRBench** is C/C++/Rust with few web-token defects. Do not tune on
  it.
- **Metrics**: recall of P0/P1 pairs first; then the question-to-finding
  ratio (the revision should cut it: the `aud` and empty-secret questions
  are now exclusions); then the benign false-block rate; then trigger
  precision on the noise controls.

### B7. Per-stack spellings moved out of Part A

The first draft carried about 45 lines of per-stack spellings on every
run. Revision 1 kept eight cross-stack traps; revision 2 folded them into
the worksheet cells they belong to. The rest is a candidate addendum
per stack, loaded only for that stack (open question: how, see B9).

- **Node**: `@nestjs/jwt` `decode` where `verifyAsync` belongs; passport-jwt
  `ExtractJwt.fromUrlQueryParameter`; `express-session` `regenerate()` at
  login and `destroy()` at logout; `crypto.timingSafeEqual` throws on a
  length mismatch.
- **Python**: PyJWT `exp` not in `options["require"]`; python-jose
  `get_unverified_claims`; SimpleJWT `ROTATE_REFRESH_TOKENS` +
  `BLACKLIST_AFTER_ROTATION` with `token_blacklist` installed (only when the
  repo promises revocation); `secrets.token_urlsafe`.
- **Rails**: `JWT.decode(t, key, false)`; Devise `reset_password_within`,
  `expire_all_remember_me_on_sign_out`, `lockable`.
- **Spring**: `aud` is checked only with `jwt.audiences` or a
  `JwtClaimValidator`; a custom `JwtDecoder` without
  `JwtValidators.createDefaultWithIssuer` loses `iss`; jjwt
  `parseClaimsJwt`/`parseUnsecuredClaims` accept unsigned tokens.
- **Go**: `jwt.ParseUnverified`; `WithAudience`/`WithIssuer` opt-in.
- **Any stack** (cut from step 2 for length in the critique pass): when
  header, cookie and query can each carry a token, the one verified must
  be the one whose claims are used.
- **ASP.NET**: raised `ClockSkew` (default 5 min); the
  `SecurityStampValidator` interval is the revocation window.
- **PHP/Laravel**: loose `==` and `strcmp` on tokens, `hash_equals`,
  Sanctum token abilities (`tokenCan`) never checked, `Str::random` for
  tokens (CSPRNG since Laravel 5.x).

### B8. Critique log

Accepted in full unless listed. Each line is a point rejected, or accepted
only in part, and why.

- **RT1 (gateway identity header), partial.** The bug itself, a backend
  reading `X-User-Id`, is `pass-sec-authn-coverage` step 8. Accepted here:
  step 11 (step 9 before revision 2) no longer counts an upstream
  verifier as a control without the strip and the reachability proof.
- **RT4 (verify result ignored or not awaited), routed.** "A result that
  is computed and ignored" is authn-coverage step 7, and the precision
  critic's one-owner rule gives it "no effective verification". It is
  named in Stay-inside and in Apply-to.
- **RT14 (parser differentials), partial.** Duplicate claim keys, mixed JWS
  serialisations and two XML parsers are toctou's "parser differentials".
  Kept: the verified-object rule (step 3) and which token source wins
  (step 2).
- **RT17 (`__Host-` cookie), partial.** Only a PR that widens `Domain`
  is a finding (P2), per the precision critic's "PR weakens a flag" rule. A
  pre-existing host cookie without `__Host-` is excluded.
- **RT18 (Mongo operators, PHP section), partial.** A Mongo operator in a
  lookup is NoSQL injection (`pass-sec-injection`). PHP juggling joined
  step 5's compare rule. The PHP spellings went to B7, not Part A.
- **PC "move the ecosystem section to stack-scoped profile addenda",
  partial.** No stack-scoped addendum mechanism exists: profile addenda are
  per repository and not gated by the detected ecosystem. Kept eight
  cross-stack traps inline and moved the rest to B7.
- **PC "drop toctou's cached-authority bullet".** That file is out of
  scope for this revision. Recorded as a proposal in B3.
- **PC "CSRF is CWE-352 under access", partial.** Cookie CSRF and
  `SameSite` moved out. OAuth `state` stays here, because it binds the
  callback to the session that began the flow.
- **PC "scan: accept always-on or gate".** Chose the gate (stage-1 focus
  files with an issuer or verifier hit), since always-on would cost a full
  pass on most web repos.
- **PC "trigger `^-`", partial.** Built-in probes can read removed lines.
  Profile-added probes cannot (`^\+` wrapper), so a profile cannot extend
  the ± set.

### Critique log (revision 2)

A red-team (RT) and a precision (PC) critique of revision 2. Accepted in
full unless listed. Each line is a point rejected, or accepted only in
part, and why. Part A ends at 233 lines.

- **RT2 (minting a credential on a session alone at P1), partial.**
  Minting a PAT, API, SSH or deploy key, app password, linked identity,
  OAuth grant or passkey is now a factor change in step 10. Its severity
  follows PC6's precedent rule, not a flat P1: P1 when a sibling factor
  route re-authenticates or the threat model requires it, otherwise a P3
  question. A flat P1 would fire on most apps' "create API key" forms.
- **RT3 (cross-tenant SSO identity), partial.** Accepted in step 3 at P0.
  Domain-claim proof and SSO role mapping stay privesc's step 7: this
  lens owns only which account an assertion logs into.
- **RT7 (step-up stamp on the user), partial.** Accepted at P2, not P1.
  The attacker needs the victim to have re-authenticated elsewhere inside
  the stamp's window, which is narrower than a missing re-auth.
- **RT10 (impersonation session used for persistence), routed.**
  Privesc step 4 already owns "Impersonation: actions that outlive the
  session (a new API key, an MFA or email change, a grant)". Two lenses
  would post two rows on the same handler. Named in Stay-inside instead.
- **RT13 (JWKS), partial.** Private members in a published JWKS are now in
  step 9 at P0. "A newly generated key is published before it signs" is
  rejected. Signing too early makes verifiers fail closed until they
  refetch, which is an outage, the class PC4 cut.
- **RT15 (severity), partial.** Items 13, 3 and 5 at P0, and items 1 and 4
  at P1, all accepted. Item 2 is graded as in RT2. `password holder` is
  added as a holder and lands at `plausible`.
- **PC "empty secret is authn-coverage's", partial.** Per SYNTHESIS §1,
  a check *skipped* on an empty secret is authn-coverage's, so the step-2
  bullet, the P0 example and the P2 item are gone. A verifier that *runs*
  with an empty key (HMAC over `""`, CVE-2022-23540's falsy key) still
  accepts forgeries and stays here as one clause and one P0 example.
- **PC "one handler gets one posted row" for support overrides,
  partial.** Not added to Part A, which had no room. The validator's
  sink merge (SYNTHESIS §1) already gives one row per handler, as B3 now
  says.
- **PC "invite tokens: pick one owner", partial.** This lens keeps the
  token's properties (step 5). Privesc step 9 still lists "single-use,
  bound to invitee". Trimming it is a change to that file and is put to
  the owner (B9).
- **PC "OAuth `state`: ratify one owner".** Kept here as a token-binding
  defect, as revision 1 argued, and put to the owner (B9). Not moved,
  because access's CSRF checks read form and cookie handling, never the
  OAuth callback.
- **PC "legacy SA token Secrets: drop the glob or own a narrow case".**
  Dropped the glob. The exclusion now names existing Secrets and existing
  long-lived cloud keys explicitly, so neither iam's nor infra's pointer
  invites a finding. A narrow case was not kept: a PR adding a legacy SA
  token Secret is a lifetime choice with no broken promise, and its risk
  is the grants the SA holds, which are iam's.
- **PC "no reuse detection on a public client → P2", rejected.** Step 6
  and P1 now accept sender-constraining as the alternative, as RFC 9700
  §4.14.2 does. That leaves only refresh tokens that neither rotate nor
  are sender-constrained, which breaks the RFC's MUST and leaves a stolen
  refresh token valid for its full lifetime. That is P1 under the window
  rule.
- **PC "step 11: accept a cited NetworkPolicy or threat-model line",
  partial.** Accepted. One residue remains: the strip or overwrite at the
  edge must still be cited before the gateway counts. A gateway that
  forwards a client-set identity is no control at all, whatever the
  network shape.
- **PC "library version per inventory row", accepted with a
  remainder.** The lockfile version is now read only for the cell a
  finding rests on. The `token` evidence line keeps a version field for
  that case.
- **PC length.** Cut lines 143-147 and 151-152, the empty-secret and
  fall-through duplicates, the client `redirect_uri` and the CWE list, as
  proposed. The red-team additions then needed about 35 more lines, so
  these went as well: the "header, cookie or query" token-source rule
  (moved to B7), the long event spellings, and the separate "Report only
  failing rows" paragraph (folded into step 11).

### B9. Open questions for the owner

1. Stack-gated addenda: should B7 become per-stack addenda loaded when
   `ecosystem.ts` detects the stack (a new mechanism, M-series), live in a
   profile pack, or be dropped?
2. Co-planning: should a tokens trigger also plan
   `pass-sec-authn-coverage` (which now owns decode-only and ignored verify
   results), so a JWT PR never runs one without the other?
3. Ownership splits to ratify in the sibling drafts: privesc step 9 keeps
   caches only and drops the invite token's properties (single use,
   binding), keeping "role from the stored invite"; toctou drops "cached
   authority"; `pass-sec-iam` owns CI OIDC and WIF trust conditions and
   the grants of existing long-lived keys and SA token Secrets; infra owns
   SA automount.
7. OAuth `state` on the client callback: keep it here as a token-binding
   cell, or move it to `pass-sec-access` with the rest of CSRF?
8. Step 10's precedent rule makes a factor change on a session alone a P3
   question when no sibling route re-authenticates. Should the security
   profile instead exclude it (quieter) or treat MFA-enrolled accounts as
   the precedent (louder)?
4. Should the security profile allow a profile to add ± (removed-line)
   probes, or keep removed-line probes built-in only?
5. The 15 min / 1 h window bands are judgement. Should they come from the
   threat model's stated access-token TTL when one is recorded?
6. Step 10's re-authentication rule: should a recorded step-up window
   (`sudo_mode`, `password_confirmed_at`) have a maximum the lens enforces
   (say 15 min, the existing window band), or only "bounded and read"?

### Revision 2 notes

Where the critique pass changed a revision-2 item, the critique log above
wins: JWKS refetch, unversioned ciphertext and the webhook dual-secret
window were cut; "a key with no end" fell to P2 and only counts where the
repo holds the removal step; the remember-device item fell to P3; and the
factor-change P1 now needs a precedent.

Revision 2 (2026-11-02) applies the synthesis rulings
([`SYNTHESIS.md`](SYNTHESIS.md) §1, §2) and fills two gaps.

- **Key and secret rollover (step 9), new.** The code-level half of
  rotation: a retired `kid` or fallback secret with no end; an unknown
  `kid` falling back to a default key; JWKS never refetched, or refetched
  per unknown `kid` (forced fetches against the IdP); a key read once at
  boot that a revoke path cannot reach; webhook secrets with no dual-secret
  window or no revoke; rotate, regenerate and revoke handlers that leave
  the old credential valid (moved here from step 6, which is now
  "Refresh"); ciphertext with no key version. The rotation *schedule*,
  key age and an operator's environment-set fallback list stay excluded:
  a reviewer can read whether the code can retire a key, never whether
  anyone did. Storm-0558 is the case that shows both halves at once.
- **Recovery and factor lifecycle (step 10), new.** Re-authentication
  with an existing factor before password, MFA, recovery-code, email or
  phone changes (ASVS 7.5.1, OWASP MFA); a new contact address counting
  only once verified; resets and recovery codes that skip MFA (ASVS
  6.4.3); recovery-code generation, hashing, single use and regenerate
  (NIST 800-63B §3.1.2, §4.2); remember-device tokens; support overrides.
  Session fixation stays in step 4 (CWE-384). Who may call an override is
  privesc's; what the override does to the target is this lens's. A
  missing MFA or notification feature is excluded as hardening.
- **CI OIDC removed.** Every claim on trust conditions (`sub`, `aud`,
  `repository`, WIF `attribute_condition`, federated credentials) now
  routes to `pass-sec-iam`, in Stay-inside, B1 and B3. This lens keeps
  issuer, `aud` and `exp` of a workload token that application code
  verifies (step 2), and the lifetime of tokens it mints or stores. A
  home-made token exchange mapping a CI `sub` to a role is ruled iam's,
  since the condition is a grant.
- **Room for it.** Part A grew from 223 to 248 lines, over the ~230
  target; the two rows carry about 30 lines that could not be cut
  without losing an item the synthesis asked for. To pay for
  the two rows, the "Cross-stack traps" section was dissolved into the
  worksheet cells it belonged to (`algorithms`, `Keyfunc`, golang-jwt
  `exp`, constant-time compares, CSPRNG, raw-body parsing, password-bound
  reset hashes; SA token Secrets joined the framework-default exclusion),
  and the Excluded list was merged into fewer bullets with no rule
  dropped.
- **Severity.** P1 adds factor or recovery-channel changes on a session
  alone, resets and recovery codes that skip an enrolled factor, rotate or
  revoke that leaves the old credential valid, and a retired key with no
  end. P2 adds JWKS refetch never or per unknown `kid`, unversioned
  ciphertext, and a remember-device token that survives a password change
  or MFA reset. New `holder` values: session thief, old-key holder; both
  land at `plausible`. New CWEs: 620, 308, 324.
- **Sources checked for this revision:** OIDC Core §10.1.1, jose's
  `createRemoteJWKSet` docs, Django `SECRET_KEY_FALLBACKS`, Standard
  Webhooks, Rails `KeyProvider`, NIST SP 800-63B-4, OWASP ASVS 5.0 V6/V7,
  OWASP MFA Cheat Sheet, the CSRB Storm-0558 report page (CISA) and Wiz's summary,
  and Okta's 2023 help-desk advisory (B4). A Termix CVE on MFA disable
  with only a password was found through search but its advisory could
  not be opened, so it is not cited.
