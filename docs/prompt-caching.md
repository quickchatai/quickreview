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

### Where the tool declarations sit

Measured again on the request pi 1.4.0 builds, on `gpt-6-luna` and `gpt-6.1-sol`: a warm-up over a ~33k-token pack, then lens requests with a 1,500-word lens text each. pi 1.4.0 declares the tools in the request's input, as an `additional_tools` item at its head, and no longer in a top-level `tools` field.

| Where the tool item is | What a lens request reads of the warm-up |
|---|---|
| Top-level `tools` (the older request) | 32,640 of ~35,300 tokens |
| At the head of the input, ahead of the pack, in both | 33,024 of ~35,700 |
| After the pack in both, ahead of the lens text | 33,024 of ~35,700 |
| After the pack in the warm-up, after the lens text in the lens | **0** |

The last row held whether the lenses were sent the instant the warm-up ended or 5 s later, alone or four at once, over SSE or the WebSocket. So two requests share a prefix only when their tool declarations come before the point where they part. A request whose declarations come after it reads nothing, not even the part the two do share.

The last row is what the rewrite sent from the day pi moved the declarations into the input until it was fixed: the pack went ahead of the whole input, the tool item with it. Every lens of every packed group then paid for the pack again, and the warm-up bought nothing. The rewrite now leaves pi's leading tool declarations where they are and puts the pack after them.

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
  - the input becomes pi's tool declarations where pi put them (its head), then the pack (user role, fenced data), then the lens body as a **developer** message, then the task.

The warm-up's request is exactly that shared prefix, and every lens request of the group extends it.

Measured on the SDK runner at pi 1.4.0 (the real host and runner, a 36k-token pack): four lenses and one that started 20 s after them each read 35,584 tokens of their first request from cache and paid for about 2,500, on `gpt-6-luna` and on `gpt-6.1-sol`. The late lens joined the group's key and needed no warm-up of its own.

**The bench runs the same path.** A bench case's pack sits beside its ledger, and the bench's lens config (`roundLensConfig`, `packages/pi-plugin/src/engine/lens/round-lens.ts`) carries it as `qcr review`'s does. Bench runs between 2026-10-19 and this change carried no pack in the prompt: their lenses read the pack file through a tool, so their cost figures are of a path no production round runs.

The task files tell the lens that the pack is the first message of its conversation, and to read the pack file instead when it is not there.

Measured end to end (real pi 1.0.0 parent, the retired native glue): two lenses with different instructions over a 24k-token pack. Each paid ~1.2k uncached tokens and read 23,808 from cache, against ~25k uncached each without it.

## Which models the pack applies to

The warm-up and the rewrite build the request of two API families, so they are an optimisation for those families and nothing more. A family is keyed on the model's API as pi names it (a model's `api`), never on a provider or a model name. `PACK_FIRST_APIS` in `packages/pi-plugin/src/engine/lens/leaf-cache.ts` holds them:

- `openai-codex-responses`
- `anthropic-messages`, on a model that takes a system message after the first user message (pi's `supportsMidConvoSystemMessages`)

A cache group is **packed** when the round has a pack and the pack applies to the model the group's sessions run on (`packFirstApplies`). The model is the one the session really gets: the route's for a lens that names none, and the credentialed provider's when a pinned provider has no credential and another serves the same id. A group whose model the runner cannot name before a session exists is not packed.

**The Responses request** (`openai-codex-responses`) is laid out as the section above says: tool declarations, the pack, the lens body as a developer message, the task.

**The Messages request** (`anthropic-messages`) has no developer role, and its cache reads a prefix in the order tools, system prompt, messages. So:

- the lens body comes out of the system prompt, which is then the same for every lens of the round;
- the first user message opens with the pack, as a block of its own that ends on a cache breakpoint (the one pi gave the system prompt, with its lifetime);
- the lens body follows that message as a **system message** inside the conversation. It keeps the operator's voice there. The pack, which holds text a pull request wrote, stays in the user's.

A request may carry four cache breakpoints. pi marks the tools, the system prompt and the last message; the pack's is the fourth. Where pi marked two system blocks (a login's request), the earlier one gives way: the last covers both. A request pi marked nowhere has caching off, and is sent as it came.

A model that takes no system message there (an older one) is not packed: the lens body would have to stay ahead of the pack, where it differs per lens, and no lens could read the warm-up.

Measured on `claude-haiku-5-5`, on the real runner, over a pack of about 54,000 tokens (the same text is about 36,000 tokens on GPT):

| | Without the pack in the prompt | Pack first |
|---|---|---|
| What a lens does with the pack | reads the file through a tool, in three reads, and writes it into a cache of its own | reads 55,982 of ~59,400 tokens of its first request from the group's cache |
| Requests before a lens starts its work | 4 | 1 |
| Cost, as measured | three lenses: $0.026 | four lenses and the warm-up: $0.016 |

A lens that started 20 s after the others joined the group's key and read the same cache. Lenses that think at different levels share the pack: pi sends the level as a marker after the first user message, behind the pack.

Inside the family the rewrite is fail-open. It expects the system prompt as a string in `instructions` and the conversation in `input`, or the system prompt as the blocks of `system` and the conversation in `messages`. A request of another shape is sent as pi built it, and the runner writes one warning line for that session. At pi 1.4.0 the `openai-responses` and `azure-openai-responses` requests carry the system prompt as the first input message, so the rewrite has nothing to move there: those two APIs are outside the family, and a group on one runs as any other API's does.

A group on any other API (`openai-responses`, `azure-openai-responses`, `openai-completions`, `google-generative-ai` and the rest), or on a model of the family the pack does not apply to:
- gets no warm-up, no 30 s wait and no rewrite;
- starts its later sessions after the stagger, as a round without a pack does;
- sends each lens's request as pi built it. The lens then reads the pack file, which its task names for exactly this case.

The pack file is written for every round with `context_pack = "pack-first"`, whatever the model. Only what the runner does with it differs.

The savings in "The measured run" below were measured on GPT-6.1 Sol only, through `openai-codex-responses`; the cache reads above are all that was measured on Claude. The measured cost estimate (`packages/pi-plugin/src/measured.ts`) is shown for the API it was fitted on and no other: the pack is what its token mix rests on, so a test holds its API list inside `PACK_FIRST_APIS`, and an API joins it only when reviews on it were recorded and fitted. So the measured model reached through another API (an API key on `openai-responses`, Azure, a gateway) shows no estimate and runs under the spend limit of an unmeasured model ([docs/llm-setup.md](llm-setup.md)).

## The measured run

The pack moves each lens's instructions from the system prompt into a developer message after the pack, so it was measured before it was turned on. The run used a set of follow-up replay cases, each run under three arms on the bench: the old follow-up code, the new code with the pack off (cache groups on), and the new code with the pack on.

| | Old code | New, pack off | New, pack on |
|---|---|---|---|
| Total cost, relative to the old code | 1.00 | 1.43 | **0.85** |
| Share of input read from cache | 0.68 | 0.69 | **0.88** |
| The same, children's first turns | 0.21 | 0.15 | **0.83** |

The pack was about 40% cheaper than the same code without it, case by case, with no loss of verdict agreement with the recorded rounds and no loss of recall on their blockers, so it is on by default. The pack-off arm cost more than the old code because the early pre-approval sweep then ran in rounds that ended in REQUEST_CHANGES; the early start was removed afterwards (docs/follow-up-rounds.md). The cache groups change nothing the model sees.

## Telemetry

Whether the cache hit is recorded for every run of a cache group, in the round's `lens-ledger.jsonl`:

- `turn1`: the tokens the run's first request paid for in full (`input`), read from cache (`cacheRead`) and, where the provider bills it apart, wrote to the cache (`cacheWrite`). A warm-up's is its only request.
- `group`: the cache group's key.
- `prefix`: short hashes of the parts of the first request, as it was sent, for a packed group's runs. It holds `other`, `reasoning`, `instructions`, `tools`, one `inputN` per input item through the pack, `pack_at` and `tools_after_pack`. It never holds text.

Two lines go to the run's log:

- When a pass's first request does not extend its group's warm-up, one warning per group names the part: `other`, `instructions`, `tools`, `inputN`, `pack` (the request carries no pack) or `tool-declarations` (a tool is declared after the pack). The thinking level is not compared, because the passes of one group think at different levels and still share the prefix.
- When a group's sessions are disposed: `cache group <key>: turn1_hot=<n>/<passes> warmup_input=<tokens>`. A first turn is hot when it read at least nine tenths of what the warm-up sent (all of its request: what it paid for, read and wrote).

`tests/pi-canary/canary-16-pack-first-prefix.test.ts` runs pi's own request builder through the rewrite, so a pi that changes what it puts in the input fails there and not on the bill.
