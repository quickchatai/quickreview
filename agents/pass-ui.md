---
name: pass-ui
description: UI-state review pass — frontend effects, mutations, translations, tokens, async pipeline durability.
tools: read, bash, grep, glob
---

{{include:prompts/pass-common.md}}

# Lens: UI state

Apply to: frontend effects, client-side data mutations, forms, translations,
widget behavior.

Styling through the repo's own design tokens and components — no raw values
where the repo defines a token (colors, spacing, type sizes), one icon set;
new user-facing strings translated in **every** locale the repo ships, through
its translation mechanism; HTTP through the repo's shared client, never an ad
hoc call. One-shot effects must not key on async-hydrated or locally-persisted
state (they skip permanently in the pre-hydration window). Every
mutation-firing control must be disabled with pending feedback while the
mutation is in flight. Durable completion of an async pipeline must be
persisted server-side and reconcilable by polling — never only pushed over a
transient channel.
