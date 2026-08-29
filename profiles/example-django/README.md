# example-django — a worked illustrative pack

A sanitized, illustrative house-rule pack for a Django + pytest codebase that
deploys with rolling releases. It is adapted from a real team's rules with the
team-specific names, attributions, measurements and product references
stripped — treat it as a template to edit, not a rubric to adopt wholesale:
several of these rules encode ONE team's settled trade-offs (global mocks as
house style, deployment-level rollback), and your team may have settled the
same arguments the other way. Delete what does not match your house before
selecting the profile.

Files compose in ascending filename order (numeric prefixes state intent).
Authoring rules, scopes and ordering: `docs/profiles.md`.

`profile.toml` selects `ecosystem = "django"`: the daemon runs the
migration-number collision pre-check (remedy posted as a COMMENT, never a
blocker), forces the sol-med tier on migration-touching rounds, and renders
the MIGRATION GATE prose into round prompts. A non-Django codebase should say
`ecosystem = "none"` (or omit the file) — that is a clean off: none of the
machinery runs and prompts carry no migration-gate prose. Details: the
ecosystem section of `docs/profiles.md`.
