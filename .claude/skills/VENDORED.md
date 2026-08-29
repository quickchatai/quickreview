# Vendored skills — mattpocock/skills

These 25 skill folders are a **vendored copy** of the curated plugin set from
[github.com/mattpocock/skills](https://github.com/mattpocock/skills), flattened
out of the repo's `skills/engineering/` and `skills/productivity/` buckets so
Claude Code discovers each at `.claude/skills/<name>/SKILL.md`.

- Source: `mattpocock/skills` (plugin + package v1.2.3 — commit is the real pin)
- Commit: `9c9f36ccd3995266cd675468af71639c8dde1ec5`
- Vendored: 2026-08-17 (operator session; previous pin
  `2ab958093e83e0ec752e6c1c5932da465bf23e0c`, v1.2.0, 2026-07-30 — 123 commits back)
- Method: wholesale folder copy (SKILL.md + companion .md + agents/ intact).
  All intra-skill links are `./file.md` within the same folder, so they survive
  flattening. No skill references another by relative path. Verified at vendor
  time: no link escapes its skill folder, every `name:` frontmatter matches its
  directory.

## Changes in this update (v1.2.0 → v1.2.3)

The curated set grew 22 → 25.

- **Added:** `wizard`, `to-questionnaire`, `wait-what`, `writing-for-agents`.
- **Renamed:** `writing-great-skills` → `writing-for-agents` (upstream commit
  `1fc6573`, a breaking rename + restructure). The old folder is gone.
- **Updated in place:** `ask-matt` (largest change), `diagnosing-bugs` (now
  redacts secrets), `grilling`, `improve-codebase-architecture`, `code-review`,
  `prototype` (LOGIC.md reworked around a shareable HTML demo),
  `setup-matt-pocock-skills`, `tdd`, `codebase-design`, `domain-modeling`,
  `grill-me`, `grill-with-docs`, `handoff`, `to-spec`, `to-tickets`, `triage`,
  `wayfinder`.
- A repo-wide theme in this range: cross-skill invocation is now phrased as an
  explicit *"call the Skill tool with `<name>`"* rather than `/slash` invocation,
  and skills no longer call user-invoked skills.

## Updating

Re-clone upstream and re-copy the curated folders (the `skills` list in
`.claude-plugin/plugin.json`). These copies are pristine upstream — pinned,
not forked.

## The issue-tracker seam

`wayfinder`, `to-tickets`, `to-spec`, `triage` are tracker-agnostic. They
consult one per-repo adapter file, `docs/agents/issue-tracker.md`, emitted by
`setup-matt-pocock-skills` — point them at whatever issue tracker your
installation uses.

## License and first-party additions

The vendored set is MIT (Copyright (c) Matt Pocock) — full text in `LICENSE`
beside this file. Skill folders authored for this project and NOT part of the
upstream set are listed there and in the repo-root `THIRD-PARTY-NOTICES.md`.
