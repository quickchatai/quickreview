# Ownership — the owner-only surfaces

quickreviewd distinguishes between what any agent or contributor may change and
what only **the owner** — the one accountable human running the installation —
may change. The owner-only surfaces are structural: each one is enforced by
code or by a pinned test, not by convention. This document lists them.

A note on names: the vocabulary is role-worded ("owner"). Older artifacts
(fence markers, divergence-registry notes) name the original owner, "the owner",
and the verifying grammars accept **both** spellings, so existing markers and
notes keep validating byte for byte; new ones say "owner".

## 1. The dry-run flag

`dry_run` in `config.toml` decides whether GitHub mutations execute or are
written to `state/dryrun/` as would-be calls. Flipping it — in **either
direction** — is the owner's explicit call, never an agent's (hard rule 1).

- Tripwire: `tests/config.test.ts` pins the live config's `dry_run` value, so
  an accidental flip reddens the suite.
- `config.example.toml` ships `dry_run = true`: a fresh install never mutates
  GitHub until its owner says so.
- The setup wizard **offers** the flip and never makes it. The offer comes only
  after a proof round the wizard re-verifies against the daemon's own state
  store, it takes the explicit phrase `GO LIVE` rather than a default or a
  "yes", and the written file is loaded with the strict loader and read back
  before the daemon is restarted. Every *other* config-writing step in the
  wizard — the interview, the App-slug reconcile, the ingress and inventory
  fills — refuses an edit naming that key however it is spelled, so the flag
  cannot move as a side effect of anything else. Declining is a first-class
  outcome: a dry-run installation is a complete one.
- One narrow, closed exception to "dry-run executes nothing":
  the App-self-config class, a single mutation kind that re-points **the App's
  own webhook URL** when a rotating tunnel hostname changes. It touches only
  the App's configuration, can never reach the reviewed repo, is logged every
  time, and the closed set is pinned by deep equality in `tests/gate.test.ts`
  so a second kind fails a test.

## 2. RATIFIED fences

Prompt files the system is allowed to edit still contain passages that are
**decisions**, not prose — the CI gate, the severity ladder, the one-way
recheck transition, and kin. Each such passage is wrapped in a fence:

```
<!-- RATIFIED <slug> — do not edit; owner only -->
…the ratified text, byte for byte…
<!-- /RATIFIED <slug> -->
```

A fence carries no citation, except the hard-rule invariants, which cite the
rule number (`RULE-N`) before the slug. A reseed of a fence's words may be
dated after the slug, ` (reseeded YYYY-MM-DD)`. The role half is always
`owner only`. `tests/invariant-fences.test.ts` pins every
fence by the sha256 of its contents; a changed passage and a deleted marker
fail equally loudly.

Changing fenced text is a ratification: the owner decides, and the hash is
re-pinned in the same commit, which says so. The rubric-accept
path (below) structurally refuses any proposal patch that reaches inside a
fence or mints a new fence marker.

## 3. The frozen seeds and the divergence registry

The 13 seeded files (9 `agents/pass-*.md` lenses + 4 `prompts/*.md` system
prompts) are frozen outright (hard rule 6): byte-identical to the canonical
copies in `seeds/`, sha-pinned by `tests/fixtures/seed-manifest.json`, both
verified by `tests/seed-integrity.test.ts` on every run. Pass behaviour
changes go through the `PASS_ADDENDA` registry (`src/include.ts`) — never
through a seed edit.

A **ratified reseed** — the owner explicitly ordering a seed change — is
recorded in `tests/fixtures/ratified-divergence.json`, which has exactly
**two sanctioned writers**:

1. a human recording the owner's ratified reseed, in the same commit that
   refreshes `seeds/` and re-pins the manifest;
2. the TUI's rubric-accept path (`recordRatification` in
   `src/tui/proposals.ts`), which appends the entry machine-side.

Adding an entry any other way is a violation of the freeze, not a fix. Each
entry records a divergence from the original seeding lineage; the file stays
sha-pinned, so any *further* drift is still caught.

## 4. Rubric accept-as-ratification

Rubric proposals (`state/rubric/<slug>/` — a pitch plus a patch targeting
`agents/`/`prompts/` only) are decided in the TUI by the owner. **The accept
click is the ratification**: the TUI applies the patch, refreshes
the `seeds/` canonical copies, re-pins the manifest hashes, appends the
divergence note, and commits locally. Reject removes the proposal and records
a `#rejected-proposal` memory entry so the same change is never re-proposed.
No agent may apply a proposal itself; the containment (path allowlist, fence
refusal) runs before git ever sees the patch.

## 5. The cap doctrine — a tier never lifts a cap

Caps bound what the system may do regardless of how capable, expensive, or
trusted the acting model is: the improvement-PR/issue caps (diffstat, files,
per-day/per-week counts), the per-lens severity caps (e.g. the judgment
lenses capped at P2), and the blocker bar itself. Raising an execution tier —
the validator tier floor, an overseer command's tier — **never loosens any of
them**: caps are enforced in daemon code downstream of every tier decision.
Moving a cap, like moving the blocker bar, is the owner's ratified call, not
a tuning knob.
