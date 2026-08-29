---
id: orm-usage
scope: pass-baseline
---
## ORM usage — make the database do the work, exactly once (house rule)
**Query efficiency runs in BOTH directions, and it is one rule: do not make Python do work the database can do, and do not make the database redo work you already hold.** The two directions look like a contradiction and are not — the same principle applied to opposite situations:

- The queryset has NOT been evaluated and only a number or a boolean is wanted: `len(qs)` / `bool(list(qs))` pulls every row and every column into Python. Use `.count()` / `.exists()`.
- The queryset HAS already been evaluated (iterated, `list()`-ed, cached in a template): `.count()` fires a fresh query for something already in memory — twice over if it is called twice. Use `len()`.
- The same logic decides `.values_list()`, `.only()`, aggregate-vs-loop, and filtering in the query rather than in a comprehension.

**Read which side of the line the call site is on before raising.** The direction is the finding; the method name is not. A finding that says "use `.count()`" without establishing that the queryset was unevaluated is as wrong as the code it complains about — say in `evidence` where the queryset is evaluated.

**`.objects.create()` in a loop is `bulk_create`/`bulk_update` — with two named exceptions.** Before raising it, rule both out:

- **the code needs the primary keys back** — `bulk_create` does not return them on every backend, so a loop is the correct shape when the ids feed the next statement; and
- **the set is strictly bounded and small by construction** — a fixed handful of rows from a literal, an enum, or a validated max — where the batching buys nothing.

If either holds there is **no finding**. Say which you checked in `evidence`; a bulk-create finding that has not addressed the ids question is the single most likely way this rule fires on correct code.
