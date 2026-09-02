# The QuickReview Manifesto

Humans decide what they want. The machine decides the rest.

Whether a change is wanted is a question about the product and the people,
and only a person can answer it. Whether the change is correct, safe, and the
thing its author described is a question about the code, and code can be
read. The reviewer answers the second kind in full, so that only the first
kind reaches a person.

## The human sets the standard

A person does not check findings. A person decides what a finding is.

The reviewer holds the organization's beliefs about its code: what matters
here, what never did, what a nit is, what is not worth saying. Those beliefs
are learned, and they are learned only from people. A correction from a
human changes what the reviewer believes; nothing the reviewer concludes on
its own does. The standard moves when a person moves it.

## The standard belongs to the organization, and so does the reviewer

Beliefs about code are part of a company. They live with it, under its keys,
in files it controls, on machines it runs. A reviewer that holds them
anywhere else holds them for someone else.

## A reviewer always decides

Doubt is not a verdict. When the reviewer cannot settle something in its
half, it decides anyway and names the doubt beside the decision, as a
question a person can answer in a minute. A review handed back undecided is
the work, returned.

## Severity is absolute

What blocks is set by the standard and by nothing else. A reviewer asked to
say less says less at the bottom: fewer nits, fewer questions, less prose.
The bar for a blocker never moves to make the reviewer quieter.

## The reviewer judges what shipped

It judges the change, and whether the change is the one its author
described. The author's own account is the contract; the conversation that
produced the change is no part of the evidence. It does not fix what it
finds. A reviewer that shares reasoning with the implementer loses the
ability to ask whether the fix is real.

## The reviewer reads

Code offered for review is assumed to pass its own tests. The reviewer reads
the code and the results, and runs nothing. Reading finds what running
cannot: whether a test could ever fail, whether a path is reachable, whether
two changes collide. What reading cannot find is what the tests are for.

## Many lenses, one judge

A model told to review the code reports whatever it happened to notice, and
notices something different each time. A model asked one question answers
that question. So a review is many narrow passes, each looking for one kind
of wrong, and none of them decides anything.

One agent holds the whole PR, takes what the lenses found, and decides.
There is one place the decision lives and one mind that owns it.

## A review is a conversation

That one agent holds the change for its whole life: what it raised, what
the author answered, what it let go and why. A new reviewer on every push
reaches the same verdict, having re-argued everything that came before it.

## Review responds to change

Nothing unchanged is judged twice. An approval stands until a change gives a
reason to withdraw it, and it is only ever withdrawn, never re-given.

## What must happen is code

The model judges. Everything that must hold regardless of judgment — what
gets written where, what can never be written, what follows a verdict — is
code, and a prompt is never asked to guarantee it. A rule in a prompt is a
request. A rule in code is a rule.
