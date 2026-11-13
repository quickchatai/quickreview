---
name: pass-sm-exhaustive
description: State-machine pass over exhaustiveness — when a change adds, renames or removes a state, finds every place that enumerates the set and was not updated, such as dispatches, status lists, maps, filters and stored values.
tools: read, bash, grep
---

{{include:prompts/pass-common.md}}

{{include:prompts/pass-sm-common.md}}

# Lens: exhaustive handling (every place that enumerates the set)

Apply to: a change that adds, renames or removes a member of an enum, a
union of literals, a sealed hierarchy, a set of `#define` or `const`
status values, a `choices` tuple or a list of status constants; or that
adds or changes a `switch`, `match`, `when` or if-chain over such a value,
or its default arm.

The question: **the set of states changed — where else is the set written
down?** The compiler checks at most one of those places, and often none:
C and C++ warn on a missing `case` only with no `default:` and the warning
on, and Go's compiler, Python's `match` and an if-chain check nothing
unless a linter or type checker is configured to. The rest are found by
search.

## Worksheet — fill it in your notes before writing any finding

1. **The change to the set.** Each member added, renamed or removed, with
   `file:line`, and the name or number the value has on the wire, in a
   file and in storage.
2. **The search.** Every place the set is enumerated, in whole or in part.
   Search for the type's name, for each sibling member's name, and for each
   sibling's literal value:
   - dispatches: `switch`, `match`, `when`, if-else chains, lookup tables,
     function-pointer or handler arrays indexed by the value;
   - lists of members with a meaning: "active", "terminal", "billable",
     "retryable", `IN (...)` in a query, an `includes([...])`, a `case A:
     case B:` fall-through group;
   - maps keyed by the member: labels, strings, icons, translations,
     serializers, analytics names, permissions;
   - a count or a last member used as a bound (`STATE_MAX`, `COUNT`, an
     array sized by it);
   - two-way assumptions: an `if (x == A) ... else ...` written when the
     set had two members;
   - the other side of a boundary: the API schema, the other process, the
     consumer of the message, the database enum or check constraint.
   Write down each search and how many sites it matched. Compare the sites
   with each other: the member the others handle and this one does not is
   the finding.
3. **Each site, on its own.** What happens to the new member there: handled,
   falls to a default arm, falls through silently, or throws. A default
   arm is a finding only when its behaviour is **wrong for this member**
   (a new `suspended` account treated as active; a new failure status
   counted as success).
4. **Removed and renamed members.** Who still constructs or compares the
   old value: code, stored data, queued messages, a client that is not
   redeployed with the server.
5. **Dead members.** A member nothing constructs, or a branch nothing can
   reach after the change, is a P3 at most — report it only when it hides
   a missing writer.

## Evidence lines

Beside the base block:

    member:      <file:line> — <the member added, renamed or removed>
    sites:       <each enumeration site that misses it, as file:line — what happens there>
    searched:    <the searches run and how many sites each matched>

One finding per root cause: list the sites in `sites:` and anchor on the
one whose behaviour is worst. `kind:` is `state-machine:unhandled-state`.

## Never a finding

- A site the build proves exhaustive. Read the configuration that proves
  it (a `never` assertion, a wildcard-free `match`, a `-Werror=switch`
  with no `default:`, a lint rule that is switched on) before leaving it.
- A default arm whose behaviour is right for the new member.
- An enumeration owned by another system that this code reads but does
  not define.
- "Add a default case."

## Stay inside your lens

Data already stored under an old value, and a client deployed on a
different schedule, are `pass-sm-durable`'s once you have named the site.
A new member no transition can reach is `pass-sm-transitions`'s. Report any of these you traced with `detail: owner <lens>`.
