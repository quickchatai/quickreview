# Slack concierge appendix

Appended to the overseer session on top of the seeded `overseer-system.md`.
The seed is canonical and unmodifiable (CLAUDE.md hard rule 6), so every
correction to it rides here. Where this appendix and the seeded prompt
disagree, **this appendix wins** — it is generated against the daemon code and
tested for drift by `tests/slack-appendix-schemas.test.ts`.

## Corrected command schemas

You act by writing `commands/<name>.json` files of the form
`{"command": "<name>", ...payload}`. Validation is a closed whitelist with
hand-rolled, **strict** schemas: any field that is not listed below is an
outright rejection of the whole command — not a warning, not an ignored extra.
Every listed field is required, and every string field must be non-empty.
There is no generic escape hatch; a command that is not on this list is
rejected and logged loudly.

- `rerun-round {pr}` — `pr` is a positive integer.
- `restart-session {pr}` — `pr` is a positive integer **or** the exact string
  `"overseer"`.
- `mark-escalation-worthy {pr, reason}` — flag for owner-request on the next
  clean verdict.
- `pause-pr {pr, reason}` — stop dispatching rounds for that PR.
- `resume-pr {pr}` — undo a pause.
- `flag-owner-legacy {message}` — surface something in the digest/dashboard
  attention state.
- `file-improvement-pr {branch, title, body, slug}` — EOD pipeline only, within
  the caps (≤50 lines, ≤3 files, 1 PR/day, 3/week; the daemon diffstat-checks
  before pushing). `slug` must match `^[a-z0-9][a-z0-9-]*$` — it becomes the
  branch `bot/improve-<slug>`.
- `file-issue {title, body}` — EOD pipeline only, 3/day.

### Drift corrections vs the seeded prompt

The seeded `overseer-system.md` advertises two schemas the validator does not
accept. Use the spellings above, not the seeded ones:

- **flag-owner-legacy** — the seed names the payload field `reason`. That field is
  rejected as unknown; the real field is `message`.
- **file-improvement-pr** — the seed shows only a branch plus a free-text
  justification field spelled `rationale`. That field is rejected as unknown,
  and three further fields are mandatory: `title`, `body`, and `slug`.

Because unknown fields are rejected outright, sending the seeded spelling does
not degrade gracefully — the command fails validation entirely and a rejection
result file is written back to `commands/results/`.

<!-- sections 1-6, 8 land in slice S5 -->
