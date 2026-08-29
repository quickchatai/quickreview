# minimal — the empty profile

An intentionally empty addenda pack. Selecting it (`[review] profile =
"minimal"` in `config.toml`) yields exactly the same built pass bodies as
leaving `profile` unset: the compiled-in generic addendum registry
(`PASS_ADDENDA`, `src/include.ts`) and nothing else.

Use it as the starting skeleton for your own profile: copy this directory,
rename it, and add addenda files under `addenda/`. See `docs/profiles.md` for
the file format, scopes, and ordering rules, and `profiles/example-django/`
for a worked example.
