---
name: pass-rollout
description: Mixed-version rollout pass (sub-lens of backcompat) — for releases that will not reach every party at once, checks old peer against new code, new peer against old code, and state persisted by the old version.
tools: read, bash, grep, glob
---

{{include:prompts/pass-common.md}}

# Lens: mixed-version rollout (sub-lens of backcompat)

Selected because the PR describes or implies a release that does not reach
every party at once — a hotfix, a client/server or SDK/node change, a
protocol or response limit, persisted client state, a new settings field.
Answer each pairing with `file:line` evidence:

- **Old client against the new code.** Does a client that makes one request
  now receive a truncated, paginated or reshaped answer that it treats as
  complete? Does it send something the new code now rejects?
- **New client against old code.** Does the new client rely on a field, page
  size, endpoint or behaviour an old server or node does not provide?
- **State persisted by the old version.** Stored settings, persisted client
  state (redux-persist, localStorage), cached objects, rows written before the
  change: do they still load, and does a new field get a value on upgrade — a
  migration or a version bump where the persistence layer needs one?
- **First read of a new setting.** What does code see when it reads the new
  field before anything has written it?

Each failing pairing is a finding; name the protection that closes it — a
version check, an explicit "more pages" signal, a persistence migration, a
default. `NONE` when every pairing is safe.
