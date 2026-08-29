---
id: migration-discipline
scope: pass-data-safety
---
## Migration discipline — four standing rules (house rule)
Apply these as findings at your lens's ordinary severity, with the exceptions named below.

1. **One migration per PR.** Two or more migration files in one PR is usually a squash that never happened. This is housekeeping, not correctness: raise it as a `[nit]` or a `[question]`, never as a blocker, and never when the migrations genuinely depend on each other (a schema change this PR then backfills — see rule 3).
2. **A migration never imports application code.** No `from myapp.models import Thing` and no import of a service, serializer or constant at module scope. Use `apps.get_model("app", "Model")` inside the `RunPython` callable instead. A migration must run against the schema as of its own point in history; an imported model class is today's, so the migration silently changes meaning — or dies — every time the model moves under it.
3. **Schema DDL and data changes belong in separate migrations.** A file that both alters the schema and runs a `RunPython`/`RunSQL` data step is a real defect, and the reason is specific: if the data step raises, the schema change has already been applied but the migration is NOT recorded in `django_migrations`. The database is then in a state Django cannot reason about — nothing further applies until someone opens a psql session and drops the objects by hand. Say that consequence in `detail`; "split these for clarity" is the weak version of a strong finding.
4. **The model changed and there is no migration.** A new, removed or altered field, a changed `db_index`/`unique`/`choices`/`default` on a model — with no migration file anywhere in the PR — is a finding, because `makemigrations` will demand one at deploy time and the branch will not start. Check the model diff against the migration files the PR adds, not against the migration directory as a whole.

**Never raise migration reversibility.** Do not ask for `RunSQL(..., reverse_sql=RunSQL.noop)`, a `reverse_code`, or "make this migration reversible" — not as a blocker, not as a nit, at no confidence. This house settled it on the merits: **the rollback unit is the deployment, not the migration.** A bad deploy is rolled back as a deployment and then fixed by rolling forward, so a reverse path is close to irrelevant. What that makes MANDATORY instead is backward compatibility — old code must keep working against the new schema, because a deployment rollback lands you there — and that is the backward-compatibility lens's territory, not yours.
