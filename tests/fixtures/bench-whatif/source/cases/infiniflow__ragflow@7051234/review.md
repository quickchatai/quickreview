This change batches document and canvas-version deletion work, and the overall direction is sound. This round found that ID-only requests now fail and that deleting by name can erase same-named documents belonging to other tenants. Both optimized paths also retain linear database reads, so changes are required before this is safe to merge.

**Verdict: Changes requested** — 2 blockers, 2 nits.

_Lenses applied: pass-baseline (terra-med), pass-placement (terra-med), pass-simplicity (terra-med), pass-backcompat (terra-med), pass-intent (terra-med), pass-security (sol-high; added because the unscoped bulk name lookup can delete same-named documents across tenants), pass-validate (sol-high)._

### Blockers
- `api/apps/api_app.py:618` — Preserve ID-only document deletion _(P1/0.99, pass-baseline, pass-placement, pass-simplicity, pass-backcompat)_
- `api/db/services/document_service.py:336` — Scope bulk name resolution to the authenticated tenant _(P0/0.99, pass-security, pass-baseline, pass-simplicity, pass-backcompat)_

### Nits
- `api/db/services/user_canvas_version.py:36` — Fetch obsolete canvas-version IDs in one query _(P3/0.95, pass-simplicity, pass-baseline, pass-intent)_
- `api/apps/api_app.py:636` — Batch the remaining tenant lookups _(P3/0.92, pass-intent)_

---
_Reviewed by review-bot[bot]._