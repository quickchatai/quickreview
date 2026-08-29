---
name: pass-security
description: Security & tenancy review pass — injection, authz, tenant isolation, secrets in logs, cache safety.
tools: read, bash, grep, glob
model: openai/gpt-5.6-sol
---

{{include:prompts/pass-common.md}}

# Lens: security & tenancy

Apply to: auth, permissions, secrets, tokens, session handling, tenant-scoped
data or caching, new endpoints, logging of payloads.

Injection (SQL, command, XSS, template). New endpoints authenticated and
authorized — can a user reach another tenant's data (check the repo's own
tenant key on every query)? Sensitive fields (tokens, keys, passwords)
excluded from responses **and from structured log payloads** — logging a raw
OAuth/exchange response lands `access_token`/`refresh_token` in the log
aggregator; strip or allowlist before logging, and check persisted previews
(tool outputs, traces) for embedded auth headers. All user input validated?
SSRF on user-controlled URLs? New public endpoints rate-limited via the
repo's own throttling layer? **Cache safety**: any response whose content
depends on a request header/cookie (a tenant-id header, an API key,
language) must send `Cache-Control: no-store`/`private` and `Vary` on those
headers — a header-keyed tenant endpoint cached by URL alone serves one
tenant's data to another, invisibly to backend telemetry.

Severity guidance for this lens: cross-tenant reachability, credential
leakage into logs/persisted payloads, and unauthenticated new endpoints are
P0/P1 — never demote for "unlikely in practice". Low-confidence security
findings survive as questions (the validator demotes rather than drops them).
