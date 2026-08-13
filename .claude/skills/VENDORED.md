# Vendored skills — mattpocock/skills

These 22 skill folders are a **vendored copy** of the curated plugin set from
[github.com/mattpocock/skills](https://github.com/mattpocock/skills), flattened
out of the repo's `skills/engineering/` and `skills/productivity/` buckets so
Claude Code discovers each at `.claude/skills/<name>/SKILL.md`.

- Source: `mattpocock/skills` (plugin v1.2.0 / package v1.1.0 — commit is the real pin)
- Commit: `2ab958093e83e0ec752e6c1c5932da465bf23e0c`
- Vendored: 2026-07-30 (developer session of issue-tracker)
- Method: wholesale folder copy (SKILL.md + companion .md + agents/ intact).
  All intra-skill links are `./file.md` within the same folder, so they survive
  flattening. No skill references another by relative path.

## Updating

Re-clone upstream and re-copy the 22 curated folders (the plugin manifest's
`skills` list in `package.json`). These are pinned/editable on purpose — we will
fork some of them (notably the issue-tracker skills) to point wayfinder / to-tickets
/ triage at a **fleet-internal issue tracker** instead of GitHub or `.scratch/`.

## The issue-tracker seam

`wayfinder`, `to-tickets`, `to-spec`, `triage` are tracker-agnostic. They consult
one per-repo adapter file, `docs/agents/issue-tracker.md`, emitted by
`setup-matt-pocock-skills`. The fleet-internal tracker will be a custom adapter
written into that seam. Not built yet.
