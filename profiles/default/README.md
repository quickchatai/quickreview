# default — the shipped behaviour, as a base

The profile a repo's own profile extends. It encodes exactly what
the reviewer does with no profile at all: the compiled-in generic addendum
registry (`PASS_ADDENDA`, `src/include.ts`) and nothing else, the generic
lens-selection core with no extra predicates, and `ecosystem = "none"`.

Start a profile for your repo from a `profile.toml` that says

```toml
extends = "default"
```

and add only what differs: addenda under `addenda/`, predicates in
`heuristics.toml`, `ecosystem = "django"` for a Django codebase. An inherited
addendum can be reworded (a file with the same `id`) or removed
(`[addenda] drop = ["<id>"]`). See the inheritance section of
`docs/profiles.md`.

Leave this directory as it is: every child of it inherits what it says, so a
house rule added here would silently reach every repo built on it.
