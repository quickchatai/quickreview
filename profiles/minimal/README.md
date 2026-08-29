# minimal — the empty profile

An intentionally empty addenda pack. Selecting it (`[review] profile =
"minimal"` in `config.toml`) yields exactly the same built pass bodies as
leaving `profile` unset: the compiled-in generic addendum registry
(`PASS_ADDENDA`, `src/include.ts`) and nothing else.

Use it as the starting skeleton for your own profile: copy this directory,
rename it, and add addenda files under `addenda/`. See `docs/profiles.md` for
the file format, scopes, and ordering rules, and `profiles/example-django/`
for a worked example.

`profile.toml` says `ecosystem = "none"` — the default, spelled out
so the skeleton documents the knob: no framework-specific machinery (no
migration pre-check, no tier-forcing migration gate, no migration-gate prompt
prose). Set `ecosystem = "django"` for a Django codebase; see the ecosystem
section of `docs/profiles.md`.
