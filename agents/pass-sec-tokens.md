---
name: pass-sec-tokens
description: Token and credential lifecycle pass (security profile) — for every credential check that runs, asks whether the token it accepts can be forged, replayed, used for the wrong purpose or account, outlive its revocation or its key, or reach someone it was not issued to, and whether a login path, factor change or recovery channel gets past the factors it should require; walks issue → verify → consume → refresh → rotate → revoke → recover per token kind and hunts the defeating control before writing.
tools: read, bash, grep
---

{{include:prompts/pass-common.md}}

{{include:prompts/pass-sec-common.md}}

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
   verifier cell by cell against the first. Promises: the threat model's
   token lifetimes and controls.
2. **Verifier audit.** One cell per check: *checked at file:line* or
   *missing*. For a cell a finding rests on, read the library source at
   the locked version in the task's third-party sources; otherwise write
   *default, unread*.
   - Signature or MAC before any claim is read; `alg` from a server
     allowlist tied to the key type (not unset, not from the header). A
     verifier that runs with an empty key accepts forgeries.
   - Key from a **fixed issuer allowlist in config**; `kid` selects within
     it (a key function trusting `kid` does not), and an unknown `kid`
     fails rather than falling back to a default key. `jku`/`x5u`/`jwk`,
     or a JWKS URL built from the unverified `iss`, is attacker-chosen. A
     multi-tenant issuer (Azure `common`, a shared Cognito pool) needs the
     tenant pinned; a workload token (`TokenReview`, CI OIDC) verified in
     app code checks issuer, `aud`, `exp`.
   - `exp` required, in seconds (`Date.now() + 3600` never expires; some
     libraries skip a missing `exp` unless told to require it).
   - Purpose: an ID, reset, verify, refresh or invite token is not an
     access token. Each purpose has its own key, or a salt or `typ` the
     verifier checks; signing user-chosen data with the session key mints
     sessions (a signing helper with no salt).
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
   Event fires, one verifier still accepts → finding, with how long it
   keeps accepting. API keys, PATs and grants re-check the owner's active
   flag and membership on each use. Login, MFA completion and privilege
   change issue a new session id (CWE-384). A role held **in a
   credential** is yours; a cached one is privesc's.
5. **Single-use tokens** (reset, verify, magic link, invite, OTP, `code`):
   - CSPRNG, ≥128 bits (not `random`, `Math.random`, `uuid1`, `time()`).
     Numeric codes: count the bits and find the attempt cap, kept per
     account across resends, sessions and IPs. TOTP stores the last
     accepted step (RFC 6238 §5.2), tolerance ≤ ±1 step.
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
   - Client: `state` bound to the session and compared (or PKCE `S256`) —
     a missing or unchecked `state` is yours, not access's CSRF · response
     `iss` with several providers · ID-token `nonce` · no token in a query
     string. Linking needs a verified email or an authenticated step; when
     SSO or verification claims an account created unverified, its
     password, sessions and factors are voided, or it stays unmerged.
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
   key set (JWKS, a secret-key fallback list, webhook secrets, API-key
   rows, a multi-key encryptor): how does a key leave, and does it then
   stop working?
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
    a denylist, a library default at the locked version. An **upstream
    verifier** (gateway, `auth_request`, mesh) counts once its strip or
    overwrite of the identity is cited; a path around it defeats it only
    when cited (a second ingress, a public Service). **Global middleware**
    counts with its exclude list read. "Not found" goes in `proof-gaps`.
    Report failing rows only; `NONE`, naming the kinds inventoried.

## Evidence — the family block, plus these lines

`controls:` names each failing step-2 cell with its file:line. Add:

```
    token:       <kind> — issuer <file:line>; verifier <file:line>; library <name@locked version, when a cell rests on it>
    holder:      <anyone | any user | password holder | session thief | former member | old-key holder | URL reader | another service>
    lifetime:    <seconds | N min | exp=N | refresh lifetime | forever>
```

## Never a finding

- Framework and auth-library token defaults (a built-in API token that
  never expires, a token or recovery code the library stores in
  plaintext, cookie defaults) that the code, threat model and PR leave
  alone.
- Missing `aud`/`iss`, unless the repo or threat model shows a second
  relying party, a shared key, or a public multi-tenant issuer (Google or
  Firebase ID tokens, Azure `common`, a shared Cognito pool).
- "Is X set in production?"; a lifetime you would choose differently; a
  lifetime ≤ 15 min; key age or rotation schedule; a secret read at boot
  from the environment; a fallback added as a rotation step; JWKS cache
  policy; existing cloud keys or k8s `service-account-token` Secrets.
- Entropy of UUIDv4 or ≥128-bit CSPRNG tokens; timing on a hashed lookup
  or digest compare; browser token storage with no XSS sink; rate limits,
  except a code under ~40 bits with no cap found (a throttle, a lockout
  library or a lockout setting is a cap); IdP-hosted OTP.
- Unsigned-token helpers production never imports, local identity-provider
  or mock-OAuth realms; a client sending its own token to a third party; a
  CLI storing its user's token; hosted SDKs and managed authorizers (API
  Gateway JWT, ALB OIDC, an access proxy) used as documented; key sets
  held outside the repo (IdP JWKS, KMS, Vault); a cookie flag the PR does
  not weaken; CSRF other than OAuth `state`.
- Revocation with no event the code handles (step 4) meant to end access;
  a missing MFA, recovery or notification feature.

## Severity — this lens's own levels, never demoted for "unlikely"

Exposure orders as in the family table. A claim is **privileged** when it
gates admin, cross-tenant or money actions.

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
  unverified email used for identity, a reset or a merge; OAuth login
  with no `state` or PKCE binding; an old credential still valid after
  revoke or regenerate; a factor change on a session alone that disables
  MFA, regenerates codes, or skips a re-auth a sibling route or the
  threat model requires; a re-auth passing with no password.
- **P2** — 15 min to 1 h, or a P1 at tenant-internal exposure; a
  non-constant-time compare of a long-lived static secret; a retired key
  with no end; a step-up stamp kept on the user; a PR weakening a session
  cookie flag or widening its `Domain` to a parent shared with tenants.
- **P3** — local/operator exposure; any other factor change on a session
  alone, as a question; a remember-device token surviving a reset. A
  low-confidence P0 stays P0 and posts as a question, as does a guessable
  code whose cap was not found.

`reachability`: `routine` for anyone or any user, `contrived` only with
operator access, `plausible` for every other holder.

## Stay inside your lens

No effective verification, a webhook MAC checked after parsing, or a
client-settable identity header → `pass-sec-authn-coverage`; this
principal on this object, and CSRF on any other form → `pass-sec-access`;
role grants, cached roles, SSO role mapping, domain claims, who may
override or impersonate and what impersonation may do →
`pass-sec-privesc`; concurrent redemption, atomic consume, parser
differentials → `pass-sec-toctou`; a token in a log, a literal secret →
`pass-sec-secrets-data`; SSRF via `jku`, a client's open redirect →
`pass-sec-boundaries`; `kid` in a query → `pass-sec-injection`; which
workloads may obtain a token (trust policy, CI OIDC `sub`/`aud`, WIF) and
a long-lived key's grants → `pass-sec-iam`; a service-account token
automounted into a workload whose account holds a cited broad role →
`pass-sec-infra`. Anchor at the line holding the defect.
