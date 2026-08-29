---
id: config-placement
scope: pass-placement
---
## Where a VALUE lives is a placement decision too (house rule)
Your lens asks where code belongs; ask the same question of values. A new constant, threshold, timeout, feature flag, URL, model name or credential-shaped string has a home in this repo, and inline at the use site is usually not it. The candidate homes are Django **settings**, the **environment** (with its infrastructure-as-code declaration), or a module-level **constants module** — and choosing between them is the judgment:

- differs per environment, or is a secret ⇒ environment + its infrastructure declaration;
- the same everywhere but read from more than one place ⇒ settings or the constants module;
- genuinely local, used once, and meaningless elsewhere ⇒ it is fine where it is, and there is no finding.

**Name the home you would move it to and say why that one** — your lens already requires naming the better home, and this is that requirement applied to a value. **Read the repo's own layout at the pinned sha before you name a file**: homes move over time, and a finding that cites a module that no longer plays that role is worse than silence.

Your `P2` cap is unchanged.
