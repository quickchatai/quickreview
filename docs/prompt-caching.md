# Prompt caching for lens sessions

## Why

Every lens of a round reads the same diff and, mostly, the same few changed files. Each one read them as fresh, uncached tool output. Measured on real review rounds:
- uncached input was most of every lens child's cost;
- the children were nearly all of a round's cost;
- one file was read dozens of times in a single round.

The children's first turns read **0** cached tokens, even where two children's prompts were byte-identical.

The reason is that pi uses its session id as the provider's cache key (`prompt_cache_key`, and the routing headers built from the same id). The measured run was pi's native subagent tool, whose children ran `--no-session`, so every child got a random id and landed on a cold cache. That tool, and the glue around it, are gone: every route runs pi in-process on the SDK and launches lenses through our lens tool (`packages/pi-plugin/src/engine/lens/`), which creates each lens as a session of its own process and gives it the group's session id. The measurements below are what that design rests on.

## What the backend does (measured)

About 30 short probe calls on `gpt-6.1-sol`, through pi's `openai-codex-responses` API. Each case below is a pair of separate pi processes over the same ~24k-token prefix.

| Case | What the second request reads from cache |
|---|---|
| Both `--no-session` | 0 |
| One session id, the second request identical | 24,320 of 24,467 tokens |
| One session id, sent at the same instant | Both miss |
| Second sent 2 s later | Hit |
| Second **extends** the first, any length added | Hit (23,808 under a 1,500-word lens text) |
| Prefix shared, then **diverges**: ≈60 words | Hit |
| Prefix shared, then diverges: ≈250 words | Miss (a 10 s wait made no difference) |

The extend case is also how a child's own later turns are cached today.

So a prefix the lenses share is reused only if each lens request extends a request that held just that prefix. Two lens requests that diverge after it do not share it.

## Shape

**Cache groups** (`[engine] lens_cache_group`, default 5; `packages/pi-plugin/src/engine/lens/cache-group.ts`, `cache-run.ts`).
- A lens session is created with its group's key as its session id, which pi turns into the provider's cache key and routing headers. The group shares one id (see docs/probes/p4.6-codex-cache-routing.md), so the sessions of a group are disposed together once the whole group is done: one lens's dispose would otherwise close a sibling's live transport.
- Sessions share a key in groups of N per model, so no single key carries a whole round's request rate.
- The groups are for every provider. Where an API has no cache routing keyed on the session id, the shared id changes nothing.
- A group that is not packed (a round without a pack, or a model outside the pack's API family, below) starts its later sessions `[engine] lens_cache_stagger_ms` (2500) after its first. Rows of one agent whose prompts differ only in a short task pointer, such as the sweep rows, then share their system prompt.

**The context pack** (`[review] context_pack = "pack-first"`, the default; `"off"` restores the old prompts). Three pieces:
- **The pack file.** `packages/pi-plugin/src/contextpack.ts` renders the round's pack, written beside its task files as `<passes>/context-pack.md`. It holds, within `context_pack_max_tokens` (40,000):
  - the change since the last review, on follow-up rounds;
  - the PR's diff, file by file;
  - the full text of its most-changed non-test files.

  Files are read only as regular files inside the worktree (never a symlink a PR planted) and under 256 KB. What did not fit is named.
- **The warm-up.** For a packed group (a round with a pack, and a model on the pack's API family, below), the lens runner starts the group's first session together with a **warm-up**:
  - the same request without the lens text, and "reply OK" as its task;
  - every session of the group waits for the warm-up to finish, at most 30 s, before it starts.
- **The lens extension.** `packages/pi-plugin/src/engine/lens/leaf-cache.ts`, loaded into a packed group's sessions as an in-process extension, rewrites each request:
  - the lens body comes out of pi's `<addendum>` block in `instructions`;
  - the input becomes the pack (user role, fenced data), then the lens body as a **developer** message, then the task.

The warm-up's request is exactly that shared prefix, and every lens request of the group extends it.

The task files tell the lens that the pack is the first message of its conversation, and to read the pack file instead when it is not there.

Measured end to end (real pi 1.0.0 parent, the retired native glue): two lenses with different instructions over a 24k-token pack. Each paid ~1.2k uncached tokens and read 23,808 from cache, against ~25k uncached each without it.

## Which APIs the pack applies to

The warm-up and the rewrite build the request of one API family, so they are an optimisation for that family and nothing more. The family is keyed on the model's API as pi names it (a model's `api`), never on a provider or a model name. `PACK_FIRST_APIS` in `packages/pi-plugin/src/engine/lens/leaf-cache.ts` holds it:

- `openai-responses`
- `openai-codex-responses`
- `azure-openai-responses`

A cache group is **packed** when the round has a pack and the model the group's sessions run on has one of those as its API. The model is the one the session really gets: the route's for a lens that names none, and the credentialed provider's when a pinned provider has no credential and another serves the same id. A group whose model the runner cannot name before a session exists is not packed.

Inside the family the rewrite is fail-open. It expects the system prompt as a string in `instructions` and the conversation in `input`, which is the request pi builds for `openai-codex-responses`. A request of another shape is sent as pi built it, and the runner writes one warning line for that session. At pi 1.4.0 the `openai-responses` and `azure-openai-responses` requests carry the system prompt as the first input message, so they are sent unchanged.

A group on any other API (`anthropic-messages`, `openai-completions`, `google-generative-ai` and the rest):
- gets no warm-up, no 30 s wait and no rewrite;
- starts its later sessions after the stagger, as a round without a pack does;
- sends each lens's request as pi built it. The lens then reads the pack file, which its task names for exactly this case.

The pack file is written for every round with `context_pack = "pack-first"`, whatever the model. Only what the runner does with it differs.

The savings on this page were measured on GPT-6.1 Sol only, through `openai-codex-responses`. Nothing here was measured on another model or another API. The measured cost estimate (`packages/pi-plugin/src/measured.ts`) is shown for the same family and no other, because the pack is what its token mix rests on; a test holds its API list equal to `PACK_FIRST_APIS`.

## The measured run

The pack moves each lens's instructions from the system prompt into a developer message after the pack, so it was measured before it was turned on. The run used a set of follow-up replay cases, each run under three arms on the bench: the old follow-up code, the new code with the pack off (cache groups on), and the new code with the pack on.

| | Old code | New, pack off | New, pack on |
|---|---|---|---|
| Total cost, relative to the old code | 1.00 | 1.43 | **0.85** |
| Share of input read from cache | 0.68 | 0.69 | **0.88** |
| The same, children's first turns | 0.21 | 0.15 | **0.83** |

The pack was about 40% cheaper than the same code without it, case by case, with no loss of verdict agreement with the recorded rounds and no loss of recall on their blockers, so it is on by default. The pack-off arm cost more than the old code because the early pre-approval sweep then ran in rounds that ended in REQUEST_CHANGES; the early start was removed afterwards (docs/follow-up-rounds.md). The cache groups change nothing the model sees.

## Debugging

`prefixDigest` (`packages/pi-plugin/src/engine/lens/leaf-cache.ts`) gives a short hash of each request's prefix parts (`instructions`, `tools`, `input0…`). Comparing two lens sessions' digests shows where they diverge. A session's `turn1 cacheRead` shows whether it hit.
