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
`.claude-plugin/plugin.json`). These are pinned/editable on purpose — some are
forked to point at the fleet-internal issue tracker (see below).

## The issue-tracker seam — and the planner's fork

`wayfinder`, `to-tickets`, `to-spec`, `triage` are tracker-agnostic. They consult
one per-repo adapter file, `docs/agents/issue-tracker.md`, emitted by
`setup-matt-pocock-skills`.

**The copies in this folder are pristine upstream.** The forked copies live in
`planner/.claude/skills/` — 8 skills, of which 5 (`wayfinder`, `to-spec`,
`to-tickets`, `triage`, `prototype`) carry fleet-specific edits pointing them at
`tracker/` and the `tracker-lint` MCP tool.

**When updating, do not overwrite the planner copies** — 3-way merge them:

```sh
git merge-file planner/.claude/skills/<n>/<f> <old-pin>/<n>/<f> <new>/<n>/<f>
```

In the 1.2.0 → 1.2.3 update, 6 of 7 forked files merged clean; only
`wayfinder/SKILL.md` conflicted (upstream reworded the research-subagent line)
and was hand-resolved to keep both upstream's phrasing and the fork's
asset-directory + lint additions.

## Fleet deployment

The same 25 skills are installed at `~/.claude/skills/` on every operator-box VM
container for the owner (10 boxes as of 2026-08-17). Those copies are
pristine upstream — no forks — and are expected to stay byte-identical to this
folder minus this file.
