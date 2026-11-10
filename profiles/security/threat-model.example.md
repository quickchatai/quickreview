# Threat model — an example to copy

This file is an example and is never read. To give the review a threat
model, copy it to one of two places and rewrite every entry for your system:

- `.qcr/threat-model.md` in the reviewed repository, on its base branch.
  It is visible to the repository's team and wins over every profile's.
- `threat-model.md` in your own profile in the config home, one that
  `extends = "security"`. It is private to your install and is read only
  when the repository has none.

How it is read:

- Each `##` heading below is a section the review knows, matched without
  regard to case. Other headings and prose are kept as context for the
  lenses but plan nothing.
- Each list item under a section is one entry. When an entry starts with a
  path glob in backticks (`src/api/**`), a pull request that changes a file
  the glob matches plans the matching security lens: an entry point plans
  authentication coverage and injection, a control plans access and
  authentication coverage, a sink plans injection and boundaries. An entry
  with no glob, or a glob that names an HTTP route rather than a file,
  informs the lenses and plans nothing.
- Every entry is a claim the lenses check against the code, never proof
  that a control is in force. Write what you believe is true; the review
  will tell you where the code disagrees.
- Keep it short. The first 32,000 characters are read and the rest is cut.

## Entry points

- `src/api/routes/**` — the public HTTP API; every route requires a session
  except the ones under `src/api/routes/public/`.
- `src/api/routes/public/**` — sign-up, log-in, password reset; reachable
  without a session.
- `src/webhooks/**` — inbound webhooks from the payment provider, signed
  with a shared secret.
- `src/workers/**` — queue consumers; their messages come from the API and
  carry a tenant id the API set.
- `src/cli/**` — operator commands, run only by the on-call engineer.

## Personas

- Anonymous visitor: reaches the public routes only.
- Tenant member: a signed-in user of one tenant; reads and writes that
  tenant's records.
- Tenant admin: a member who also manages the tenant's users and billing.
- Operator: an employee with shell access to production; trusted.

## Crown jewels

- Every tenant's customer records, and the boundary between tenants.
- Payment-provider credentials and the webhook signing secret.
- The ability to mint an admin session or change another user's role.

## Controls

- `src/auth/middleware.*` — the session check every non-public route runs.
- `src/auth/permissions.*` — the role checks for admin actions.
- `src/db/tenant_scope.*` — the query filter that adds the tenant id to
  every read and write of tenant data.
- `src/webhooks/verify.*` — the webhook signature check.

## Sinks

- `src/db/raw/**` — hand-written SQL.
- `src/render/**` — server-side templates that output HTML.
- `src/files/**` — reads and writes paths built from user input.
- `src/integrations/http_client.*` — outbound requests to URLs that users
  configure.

## Network controls

- The database accepts connections only from the application subnet
  (`infra/network/db.tf`).
- The admin dashboard is served only on the internal load balancer.

## Data isolation

- One database, shared by every tenant; isolation is the tenant filter in
  `src/db/tenant_scope.*`, not row-level security.

## Token lifetimes

- Session cookie: 12 hours, rotated on log-in and on a role change.
- Password-reset token: single use, 30 minutes.
- API keys: no expiry; revoked when the user is removed.
