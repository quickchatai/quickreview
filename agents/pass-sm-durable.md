---
name: pass-sm-durable
description: State-machine pass over stored state — finds state that outlives the process and breaks there, such as a persisted shape changed with no migration or version change, a state write and its side effect that are not atomic, sequential writes outside a transaction, a stored transition with no compare on the old state, recovery after a crash, and old rows, files or messages meeting new code.
tools: read, bash, grep
---

{{include:prompts/pass-common.md}}

{{include:prompts/pass-sm-common.md}}

# Lens: durable state (the state that outlives the process)

Apply to: a change that writes a stored status or phase (a column, a
document field, a record in a file, a key in a store), changes the shape of
anything persisted, writes two or more stored things in one operation,
pairs a stored write with an external effect (a payment, an email, a
publish, a call to another service or process), changes what a stored
value means, or touches a migration, a durable workflow, a saga, or code
that resumes work after a restart.

Persisted means anything the next run of the program reads back: a
database column or ORM model, a SQLite file and its `user_version`, a
settings or JSON file, electron-store, redux-persist, `localStorage`,
IndexedDB or Dexie, a serialized struct, a protobuf message, a cache file.
Client-side stores count exactly as server tables do.

The question: **the process can stop between any two lines, and the data
outlives the code that wrote it — is every stored state one the code can
pick up from?**

## Worksheet — fill it in your notes before writing any finding

1. **The stored machine.** The column, field, key or file, its values, and
   the code that reads it back after a restart, a retry, an upgrade or a
   redeploy.
2. **The shape change.** For each field the change adds, renames, removes
   or retypes in a persisted shape, find the migration or version change
   in the same diff: a migration file, a `version:` bump with a migrate
   step (redux-persist `createMigrate`, electron-store `migrations`, Dexie
   `.version(n)`, `indexedDB.open(name, v)`, `PRAGMA user_version`), a
   reader that handles both shapes, a new protobuf field number. **None in
   the diff, with data already stored in the old shape and a reader that
   mishandles it, is itself a finding**: say what the new reader does with
   the old data (a crash on
   load, a missing key read as `undefined`, a setting silently reset). A
   migration whose error is caught and dropped is the same finding, one
   step later. "Absent means default" clears a new field only when the
   value an upgraded reader actually receives for it — read where the store
   loads it: an optional or nullable type, a language zero value, a
   deserializer or column default, a store merge that fills the initial
   state — is the value the new code intends, and every reader, each one
   read, handles it without an error or warning, a throw or a wrong value;
   a reader that reports the missing field as an error is evidence for the
   finding.
3. **The compare.** Each stored transition: is the old state part of the
   write (`UPDATE ... WHERE status = 'pending'`, a version column, a
   conditional put, a compare-and-swap, `SELECT ... FOR UPDATE` in the
   same transaction)? A read, a check in memory and an unconditional write
   is a transition two workers can both make. Name the second worker and
   its entry point.
4. **The cut.** The process stops or a call throws — never a second actor —
   between any two stored writes, and between each stored write and its
   effect, both ways round:
   - effect done, state not written: does the retry do the effect again?
   - state written, effect not done: does anything ever do it?
   - first write done, second not: what does the next start read?
   Answer the cut apart from any race step 3 found, with its own trace: a
   cut that leaves stored data nothing picks up from is its own finding once
   the hunt below finds nothing that makes it safe. A call that commits its
   own write (a repository or service method that saves, updates or
   deletes) is a stored write, though no tool follows it. Two or more
   writes with no transaction, batch or
   write-temp-then-rename around them is the usual shape; a file rewritten
   in place (open, truncate, write) is a file a crash leaves empty. Look for what makes it safe: a
   transaction, an outbox, an idempotency key on the effect, a recovery job
   that drives abandoned rows on.
5. **Recovery.** After a crash at each cut, what does the stored data say,
   and what does the code that resumes conclude? Two different pre-crash
   states that leave the same stored data cannot be told apart.
6. **Old data.** The rows, files, queued messages and in-flight workflows
   written before this change. For each stored value the change adds,
   renames, removes or gives a new meaning: who still holds the old one,
   and what does the new code do with it? A new non-null column that
   depends on the state needs a value for the rows already in each state.
7. **Replayed steps.** In durable-workflow or saga code, a step inserted,
   removed or reordered changes what a workflow already past that point
   replays. Look for the version guard.
8. **Registration.** Where the store saves only what it is told about (a
   dirty set, a save or flush queue, an ORM `add` or `markModified`, a
   persist allowlist or schema), a new stored field must be on its list,
   and each new write of one must carry the mark its sibling writes carry
   (check with `writes` or a `writer-companion` anchor): without it, and
   with no other mark of the same object on that path before the next
   flush, the write is lost at the next restart. A store that tracks changes
   itself needs no mark: compare with the sibling writes, never with the API.

## Evidence lines

Beside the base block:

    stored:      <file:line> — <the stored state and the value in question>
    migration:   <file:line of the migration or version change> | none in the diff
    cut:         <file:line> — <the point between two stored writes, or a write and its effect, where the process can stop> | n/a
    left-behind: <what is stored, and what has happened in the world, after the cut>
    second-actor: <file:line> — <the other worker or request, for a missing compare> | n/a

`kind:` is `state-machine:stored`. For a missing migration, `compare` names
the changed shape and the place the migration or version would be, and the
trace is the old data loaded by the new reader.

## Never a finding

- A pair inside one database transaction with no external effect.
- An effect that carries an idempotency key the receiver honours, or a
  write that is conditional on the old state.
- A stored value with no data yet (a table, a store or a key the same
  change creates, with nothing written by an earlier release).
- A migration's own locking, backfill size or reversibility: that is
  `pass-data-safety`'s, and not a question of state.

## Stay inside your lens

Old and new code serving traffic together during a deploy is
`pass-rollout`'s. A dispatch that misses the new value is
`pass-sm-exhaustive`'s. An in-memory double submit is `pass-sm-events`'s.
Report any of these you traced with `detail: owner <lens>`.
