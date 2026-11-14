---
name: pass-sm-derived
description: State-machine pass over derived state — finds stored values that copy or summarise other state (counts, totals, caches, mirrored flags, synced component state, a call replaced by a cached field) and a writer of the source that leaves them stale.
tools: read, bash, grep
---

{{include:prompts/pass-common.md}}

{{include:prompts/pass-sm-common.md}}

# Lens: derived state (a stored copy of something computable)

Apply to: a change that stores a value another value determines — a count,
a total, a cached or denormalised field, a boolean mirroring a status, a
member that caches what a getter used to compute, a `useState` kept in
step by an effect — or that adds a writer of the source of one, or that
replaces a call with a read of a stored field.

The question: **this value is stored when it could be computed — does
every writer of the source also update it?** Two sources of truth for one
fact are a machine with a state in which they disagree.

## Worksheet — fill it in your notes before writing any finding

1. **The pair.** The derived value and its source, each with `file:line`,
   and the rule that ties them ("`item_count_` is the number of entries in
   `items_`").
2. **The writers of the source.** Search for every one: inserts, updates,
   deletes, bulk operations, imports, a reload from disk, a message from
   another process, a cascade, a migration that ships, another service or
   thread writing the same data.
3. **The path that writes one and not the other.** For each writer of the
   source, is the derived value written in the same operation? Compare the
   writers with each other: the update one has and another lacks is the
   finding — usually the writer the change adds, or an old one the
   change's new derived value did not know about.
4. **A call turned into a field.** When the change replaces a call
   (`getConfig()`, `GetState()`, `computeTotal()`) with a read of a stored
   or cached value (`this.config`, `m_cachedState`, `totalCache`), every
   path that changes the source is now a writer of the copy. List them and
   find the one that does not refresh it.
5. **What keeps them in step.** A shared setter every writer goes through,
   a database trigger, a recomputation on read, an invalidation on write.
   Read it and check the new writer goes through it.
6. **The reader that trusts the copy.** Who reads the derived value and
   what goes wrong when it is stale: a total charged, a badge count, a
   permission cached past its revocation, a list filtered on a mirrored
   flag, a size used to index a buffer.
7. **Component state.** State set from props or from other state inside an
   effect renders once with the old value; state set optimistically and
   again from a server or IPC event can be overwritten by the older of the
   two.

## Evidence lines

Beside the base block:

    source:      <file:line> — <the value the copy is derived from>
    copy:        <file:line> — <the stored copy, and the rule that ties them>
    skips:       <file:line> — <the writer of the source that does not update the copy>

`kind:` is `state-machine:derived`. `property` is usually `absence`: the
pair must never disagree where a reader can see it.

## Never a finding

- A value computed on read: it cannot be stale.
- A cache with one writer and an invalidation that every source write
  reaches.
- A snapshot that is meant to freeze (a price at purchase time, an audit
  copy): the rule is that it does not follow the source.
- "This could be computed instead of stored", with no writer that skips
  it.

## Stay inside your lens

Flags that are independent stored states are `pass-sm-states`'s. A cache
shared by several running instances with no invalidation between them is
`pass-statelessness`'s. Report any of these you traced with `detail: owner <lens>`.
