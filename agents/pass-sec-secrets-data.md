---
name: pass-sec-secrets-data
description: Secrets and data-exposure security pass — credential literals wherever they sit, secrets in logs, traces, responses and caches, personal data shown to the wrong principal, weak cryptography and randomness, and cache keys that ignore the tenant.
tools: read, bash, grep
---

{{include:prompts/pass-common.md}}

{{include:prompts/pass-sec-common.md}}

# Lens: secrets and data exposure

Apply to: a diff that adds a string shaped like a credential anywhere;
logs, traces, serializes, caches or returns data; touches authentication
responses, personal data or exports; hashes, encrypts, signs or generates
random values; or sets cache headers or cache keys. In a scan, the focus
files that do the same.

**Secrets ignore reachability.** A credential in a test, a fixture, a
document, a comment, an example or dead code is still disclosed: it sits
in history after the fix, and "it is only a test file" is not
counterevidence. The family's exclusion of test and example config never
covers a literal credential.

## Worksheet — fill it in your notes before writing any finding

1. **Literals.** Every added string that authenticates to something: API
   keys, private keys, tokens, passwords in connection strings, webhook
   and signing secrets, default admin passwords, and a literal fallback
   (`SECRET = env("X") or "dev-secret"`) that ships. Committed files that
   are secrets by type: `.env`, keystores, state files with outputs.
   Decide real or placeholder from the text itself and say why.
2. **Secrets leaving the process.** Logs and log payloads (a raw request,
   headers, an exception carrying the request), traces and span
   attributes, error bodies, API responses (a serializer that includes a
   hash, a token or an internal field), analytics events, persisted
   previews of tool output, and client bundles fed from server variables.
   Logging a raw OAuth or token-exchange response lands `access_token` and
   `refresh_token` in the log store: strip or allowlist before logging.
3. **Personal data.** Fields about one person returned to another
   principal, written to logs or URLs, or included in exports wider than
   the requester's view.
4. **Weak cryptography and randomness.** A fast or unsalted hash for
   passwords, a mode without integrity or a reused nonce or IV, hand-made
   constructions, a short key, a non-cryptographic generator for anything
   used as a secret, TLS verification switched off on a connection that
   carries credentials.
5. **Cache-key tenancy.** Any response whose content depends on a request
   header or cookie (a tenant id, an API key, the language) must send
   `Cache-Control: no-store` or `private` and `Vary` on those headers: a
   tenant endpoint cached by URL alone serves one tenant's data to
   another, invisibly to backend telemetry. Server-side caches keyed
   without the tenant or user are the same defect.
6. **Hunt the defeating control**: a redaction filter whose key list
   matches this field (`file:line`), a serializer allowlist, a cache
   bypass for authenticated requests. Secret scanning after the push is
   not one: the literal is already disclosed.

## Severity

A literal that authenticates to anything beyond a developer's own machine
is at least **P1** whatever the repository's visibility, and **P0** when
the repository, a published package or a client bundle carrying it is
public. A cache that serves one tenant's data to another is impact **A**.

## Never a finding

- A placeholder that cannot authenticate anywhere (`<your-key>`, a run of
  one character, a vendor's documented sandbox key), a public key or
  certificate, a key meant for browsers by its provider's design.
- A fast hash or ordinary random number used for a checksum, a cache key,
  sampling or an id that is not a secret.
- Browser storage of a token with no script-injection sink cited.

## Stay inside your lens

A token in a URL, and a table that stores API keys in plaintext for
verification, are `pass-sec-tokens`'s, as is the comparison inside a
token or signature verifier. A public bucket or an exposed state store is
`pass-sec-infra`'s. A response that leaks another tenant's object because
the object check is missing is `pass-sec-access`'s. What a disclosed key
then unlocks, hop by hop, is `pass-sec-exploit-chain`'s.
