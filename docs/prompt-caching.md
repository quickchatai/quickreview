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

### One warm-up per thinking level

Measured on `gpt-6-luna` and `gpt-6.1-sol`, under one session id, over a ~33k-token pack:

| Warm-up sent at | Lens sent at | What the lens reads of the warm-up |
|---|---|---|
| high | high | 33,024 of ~35,700 tokens |
| high | medium | **0** |
| high | low | **0** |
| medium (a second warm-up, same id) | medium | 33,024 |

A second lens at medium, sent after the first one, read nothing of it either: the two part after the pack, and only a request that held just the shared prefix is read by both. So on this API the cache is kept per thinking level, and a warm-up serves the lenses of its own level. A cache group therefore holds one level, and a round whose lenses think at two levels sends two warm-ups.


### A lens extends its warm-up

The backend keeps one point per request from which a later request can read: the last 128-token boundary before the request's own end. A later request reads the cache only if it repeats the earlier one up to that point.

A warm-up that ended in words of its own (a "reply OK" task after the pack) put that point inside those words whenever a boundary fell there. A lens parts from such a warm-up right after the pack, so it read nothing. Measured on the SDK runner, `gpt-6-luna`, four lenses a run over packs of about 17,000 tokens whose size was stepped a few tokens at a time:

| | Runs where no lens read the warm-up | Lenses that read it |
|---|---|---|
| The warm-up ends in a task of its own | 4 of 4 runs in a window about nine tokens wide (the warm-up's size 82 to 90 past a boundary); none outside it | 0 of 16 inside the window |
| The lens extends the warm-up | 0 of 16 runs, over a whole 128-token cycle | 59 of 64 |

So a warm-up's prompt is one fixed message that closes the pack, and every lens request repeats that message right after the pack, ahead of its own instructions. The lens then extends the warm-up word for word, and the point lies inside what the two share at every size. For a lens the message is inert: it asks for the word OK only when nothing follows it, and the lens's instructions and task do.

### What stays the provider's

With everything above in place a lens still misses now and then, alone, with a request that repeats its warm-up byte for byte: about one first turn in ten on the afternoon these were measured, and none of some 150 that morning. A lens's own later turns miss the same way, more often while its conversation is short. Neither the transport (SSE or the WebSocket), nor a wait after the warm-up, nor a second warm-up changed that. It is the backend's routing, and the `turn1_hot` line and the `turn1` ledger field are where it shows.

### One key for a round

Measured on the SDK runner, lenses of five turns each over a 36k-token pack, all at one level:

| | Warm-ups | Lenses whose first turn read the warm-up | Later turns that missed their own prefix |
|---|---|---|---|
| `gpt-6-luna`, 12 lenses, 4 at a time, groups of 5 | 3 | 12 of 12 | 0 of 48 |
| `gpt-6-luna`, 12 lenses, 4 at a time, one group | 1 | 12 of 12 | 0 of 48 |
| `gpt-6.1-sol`, 12 lenses, 4 at a time, one group | 1 | 12 of 12 | 0 of 48 |
| `gpt-6-luna`, 16 lenses, 8 at a time, one group | 1 | 16 of 16 | 0 of 64 |
| `gpt-6-luna`, 20 lenses, 20 at a time, one group, three runs | 1 | 20 of 20, 20 of 20, 7 of 20 | 0 of 80, 0 of 80, 16 of 80 |
| `gpt-6-luna`, 20 lenses, 20 at a time, groups of 8, two runs beside them | 3 | 19 of 20, 20 of 20 | 9 of 80, 0 of 80 |

A key that carries a whole round's lenses loses nothing, and each group after the first only pays for the pack again. That is why the default group is larger than a round. The one bad run at twenty at a time came in minutes when smaller groups lost turns too: it is the provider's noise (below), not the width.

## Shape

**Cache groups** (`[engine] lens_cache_group`, default 32; `packages/pi-plugin/src/engine/lens/cache-group.ts`, `cache-run.ts`).
- A lens session is created with its group's key as its session id, which pi turns into the provider's cache key and routing headers. The group shares one id (see docs/probes/p4.6-codex-cache-routing.md), so the sessions of a group are disposed together once the whole group is done: one lens's dispose would otherwise close a sibling's live transport.
- A group is the lenses of one model, one tool list and one thinking level (see "One warm-up per thinking level" above).
- A group holds up to N sessions over its life. The default is more than a round has, so a round has one key, and one warm-up, for each model, tool list and level. A key never carries more sessions at a time than the lens cap, whatever N is: `[engine] lens_max_concurrency` under `qcr review` and the bench, and the daemon's `[daemon] lens_permits`, across every worker, on the bot.
- A group none of whose sessions was in use for 4 minutes starts afresh, with a new key and a new warm-up. A row that comes later in the round (the validator, a retry, a coverage row) joins its group's key and reads the same cache, with no warm-up of its own.
- The groups are for every provider. Where an API has no cache routing keyed on the session id, the shared id changes nothing.
- A group that is not packed (a round without a pack, or a model outside the pack's API family, below) starts its later sessions `[engine] lens_cache_stagger_ms` (2500) after its first, so the first session's request is in the cache before the others are sent. Lenses whose prompts differ by a few words only (the same agent, launched by the session with short tasks) then share their system prompt. A planned row is sent its task file's text (below), so two planned rows of one agent part by a whole task file; what they still share is not measured here.

**The context pack** (`[review] context_pack = "pack-first"`, the default; `"off"` restores the old prompts). Three pieces:
- **The pack file.** `packages/pi-plugin/src/contextpack.ts` renders the round's pack, written beside its task files as `<passes>/context-pack.md`. It holds, within `context_pack_max_tokens` (40,000):
  - the change since the last review, on follow-up rounds;
  - the PR's diff, file by file;
  - the full text of its most-changed non-test files.

  Files are read only as regular files inside the worktree (never a symlink a PR planted) and under 256 KB. What did not fit is named.
- **The warm-up.** For a packed group (a round with a pack, and a model on the pack's API family, below), the lens runner starts the group's first session together with a **warm-up**:
  - the same request without the lens text, and as its whole prompt the message that closes the pack, which asks for the single word OK when nothing follows it;
  - every session of the group waits for the warm-up to finish, at most 30 s, before it starts.
- **The lens extension.** `packages/pi-plugin/src/engine/lens/leaf-cache.ts`, loaded into a packed group's sessions as an in-process extension, rewrites each request:
  - the lens body comes out of pi's `<addendum>` block in `instructions`;
  - the input becomes pi's tool declarations where pi put them (its head), then the pack (user role, fenced data), then the message that closes the pack, then the lens body as a **developer** message, then the task.

The warm-up's request is exactly that shared prefix, and every lens request of the group extends it: the lens repeats the warm-up's whole conversation, the closing message included, and adds its own after it (see "A lens extends its warm-up" above).

Measured on the SDK runner at pi 1.4.0 (the real host and runner, a 36k-token pack): four lenses and one that started 20 s after them each read 35,584 tokens of their first request from cache and paid for about 2,500, on `gpt-6-luna` and on `gpt-6.1-sol`. The late lens joined the group's key and needed no warm-up of its own.

And in a whole review (21 lenses on two models, a change of 1,500 lines, the default settings): 21 of 21 lenses read their warm-up on their first request, none of 74 later requests missed what its lens had sent before, and 88% of the lenses' input tokens were read from cache.

**The bench runs the same path.** A bench case's pack sits beside its ledger, and the bench's lens config (`roundLensConfig`, `packages/pi-plugin/src/engine/lens/round-lens.ts`) carries it as `qcr review`'s does. Bench runs between 2026-10-19 and this change carried no pack in the prompt: their lenses read the pack file through a tool, so their cost figures are of a path no production round runs.

The task files tell the lens that the pack is the first message of its conversation, and to read the pack file instead when it is not there.

**The task is sent, not pointed at.** A lens of the round's planned wave is sent its task file's text, under a first line that names the file (`packages/pi-plugin/src/engine/lens/launch-plan.ts` `unitMessage`). Sent a bare pointer, a lens spent its first request asking for the file and its second reading it, with the whole prefix read again in between. Only a planned row is sent this way: its path was listed from the round's own task directories. A lens the session launches by hand is sent what the session wrote.

Measured end to end (real pi 1.0.0 parent, the retired native glue): two lenses with different instructions over a 24k-token pack. Each paid ~1.2k uncached tokens and read 23,808 from cache, against ~25k uncached each without it.

## Which APIs the pack applies to

The warm-up and the rewrite build the request of one API family, so they are an optimisation for that family and nothing more. The family is keyed on the model's API as pi names it (a model's `api`), never on a provider or a model name. `PACK_FIRST_APIS` in `packages/pi-plugin/src/engine/lens/leaf-cache.ts` holds it:

- `openai-codex-responses`

A cache group is **packed** when the round has a pack and the model the group's sessions run on has that as its API. The model is the one the session really gets: the route's for a lens that names none, and the credentialed provider's when a pinned provider has no credential and another serves the same id. A group whose model the runner cannot name before a session exists is not packed.

Inside the family the rewrite is fail-open. It expects the system prompt as a string in `instructions` and the conversation in `input`, which is the request pi builds for `openai-codex-responses`. A request of another shape is sent as pi built it, and the runner writes one warning line for that session. At pi 1.4.0 the `openai-responses` and `azure-openai-responses` requests carry the system prompt as the first input message, so the rewrite has nothing to move there: those two APIs are outside the family, and a group on one runs as any other API's does.

A group on any other API (`openai-responses`, `azure-openai-responses`, `anthropic-messages`, `openai-completions`, `google-generative-ai` and the rest):
- gets no warm-up, no 30 s wait and no rewrite;
- starts its later sessions after the stagger, as a round without a pack does;
- sends each lens's request as pi built it. The lens then reads the pack file, which its task names for exactly this case.

The pack file is written for every round with `context_pack = "pack-first"`, whatever the model. Only what the runner does with it differs.

The savings of the measured run below were measured on GPT-6.1 Sol only, through `openai-codex-responses`; the cache reads above were measured on `gpt-6-luna` as well, through the same API. Two other APIs were measured and showed no saving: they are the next two sections. The measured cost estimate (`packages/pi-plugin/src/measured.ts`) is shown for the same family and no other, because the pack is what its token mix rests on; a test holds its API list equal to `PACK_FIRST_APIS`. So the measured model reached through another API (an API key on `openai-responses`, Azure, a gateway) shows no estimate and runs under the spend limit of an unmeasured model ([docs/llm-setup.md](llm-setup.md)).

## Measured and not adopted: the pack on the Messages API

The pack was built for `anthropic-messages` too, measured on real reviews, and taken out again. What was built: the lens body left the system prompt; the first user message opened with the pack, on a cache breakpoint of its own; the body followed as a system message inside the conversation, which the current Claude models accept there. It kept the operator's voice, and the pack, which holds text a pull request wrote, stayed in the user's.

The cache did what it was built to do. On `claude-haiku-5-5` every lens of both rounds read the whole pack from the group's cache on its first turn (11 of 11, and 18 of 18), a late lens included, and lenses at three thinking levels read one warm-up (pi sends the level there as a marker behind the pack).

The reviews cost more all the same:

| Review | Pack read through a tool (unpacked) | Pack first |
|---|---|---|
| 9 files, 127 lines, a pack of about 9,500 tokens, 11 lenses | $0.16 | $0.27 |
| 31 files, 1,089 lines, a pack of about 70,600 tokens, 18 lenses | $2.33, finished | $5.08, and it reached its spend cap with no findings written |

Three reasons, each measured:

- **A cached token is not free, and a lens there takes many turns.** The lenses of the larger review ran about 24 requests each. The whole pack is read again, at the cached price, on every one of them: the average request was 134,000 tokens against 74,000. An unpacked lens reads the parts of the pack file it needs.
- **The model's price step.** That model bills a request over 100,000 tokens at five times the rate. With the pack first, 76% of the requests were over it, against 30%.
- **The lens body is paid twice.** The provider reads a system message inside the conversation from cache only once an assistant turn follows it. So a packed lens sent its instructions in full on its first turn and wrote them to the cache on its second. A breakpoint on that message is read by an identical request and by no later turn.

So on that API a lens reads the pack file, as before. Whether the pack pays on a model with cheaper cached reads, no price step and fewer turns a lens was not measured: one such review costs about twenty times the ones above.

## Measured: the open models on the chat completions API

Measured on `glm-5.3-flash` and `deepseek-v4.1-flash` through an OpenAI-compatible endpoint (`openai-completions`), where a lens reads the pack file through a tool.

- **The provider caches, and a shared prefix would be read.** A request that repeats a warm-up and extends it read 86% of itself from cache on both models: every time on the second (10 of 10), and with about one random miss in five on the first.
- **A lens already reads its own conversation from cache.** In one real review of 31 files (18 lenses, about 42 requests a lens on either model), 93% and 98% of the lenses' input tokens were read from cache, and a later request read what the lens had sent before in 96% and 100% of cases.
- **Pack first would not pay.** Recomputed from the same requests (the whole pack in every request at the cached price, against the part of the pack file each lens read, paid once): 5% more on the first model, whose cached tokens cost a fifth of the others, and no difference on the second, whose cached tokens cost a fiftieth. A lens there makes many requests, so a pack in every one of them costs about what reading half of it once does.

So nothing is built for that API: its lenses read the pack file, and the cache they need is the one they already get.

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

- When a pass's first request does not extend its group's warm-up, one warning per group names the part: `other`, `reasoning` (it was sent at another thinking level than the warm-up), `instructions`, `tools`, `inputN`, `pack` (the request carries no pack) or `tool-declarations` (a tool is declared after the pack).
- When a group's sessions are disposed: `cache group <key>: turn1_hot=<n>/<passes> warmup_input=<tokens>`. A first turn is hot when it read at least nine tenths of what the warm-up sent (all of its request: what it paid for, read and wrote).

`tests/pi-canary/canary-16-pack-first-prefix.test.ts` runs pi's own request builder through the rewrite, so a pi that changes what it puts in the input fails there and not on the bill.
