---
name: pass-ui
description: UI-state review pass — frontend effects, mutations, translations, tokens, async pipeline durability.
tools: read, bash, grep, glob
---

{{include:prompts/pass-common.md}}

# Lens: UI state

Apply to: frontend effects, react-query mutations, forms, translations, widget
behavior.

Semantic color tokens (no `bg-gray-*`, `hsl(var(...))`, legacy `surface-*`);
`lucide-react` icons; standard Tailwind text sizes; no em/en dashes in
user-facing strings; new UI strings translated in **all**
`frontend/Config/app/translation/` files; HTTP via `queryClient.ts`. One-shot
effects must not key on async-hydrated or localStorage-seeded state (they skip
permanently in the pre-hydration window). Every mutation-firing control must
be disabled with pending feedback while the mutation is in flight. Durable
completion of an async pipeline must be persisted server-side and reconcilable
by polling — never only pushed over a transient channel.
