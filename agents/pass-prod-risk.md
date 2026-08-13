---
name: pass-prod-risk
description: Production-risk review pass — behavior changes to existing endpoints, rollout widening, cascade and latency risk.
tools: read, bash, grep, glob
model: openai/gpt-5.6-sol
---

{{include:prompts/pass-common.md}}

# Lens: production risk

Apply to: changes to existing endpoint behavior, defaults, webhooks/callbacks,
load on external services, user-blocking latency paths.

Does any existing endpoint change response shape, status codes, or error
behavior? Default-value changes that alter behavior for existing
implementations? Backward-incompatible webhook/callback changes? Could
failures cascade? New load on external services (LLM providers, Meta API)?
**Rollout widening**: when a diff merely flips a gate or widens an audience,
review the *entire widened feature's* delivery matrix (schedules × opt-ins ×
dedup × quotas) — newly exposed bugs live in unchanged code the diff never
shows. Consider latency from the user's perspective on user-blocking paths
(e.g. a synchronous request path vs. an async job).
