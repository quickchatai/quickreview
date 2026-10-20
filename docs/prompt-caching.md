# Prompt caching for lens children

## Why

Every lens of a round reads the same diff and, mostly, the same few changed files. Each one read them as fresh, uncached tool output. In 12 live rounds (2026-10-09):
- uncached input was 71–81% of every lens child's cost;
- the children were 91–95% of a round's cost;
- one file was read 78 times in one round.

The children's first turns read **0** cached tokens, even where two children's prompts were byte-identical.

The reason is that pi uses its session id as the provider's cache key (`prompt_cache_key`, and the routing headers built from the same id). Native subagent children run `--no-session`, so every child gets a random id and lands on a cold cache.

This is the native lens tool's (and the tmux bot's) case. The review, bench and scan routes run pi in-process on the SDK (the one adapter; the process runtime is retired), where the SDK creates the sessions in this process rather than as `pi` children.

## What the backend does (measured)

About 30 short probe calls on 2026-10-09, all on the reviewer's own ChatGPT login and `gpt-6.1-sol`. Each case below is a pair of separate pi processes over the same ~24k-token prefix.

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

**Cache groups** (`[pi] subagent_cache_group`, default 5; `extensions/subagents.ts`).
- At spawn, the glue rewrites a lens child's `--no-session` to `--session-id <group key> --session-dir <its own temp dir>`. The dir is removed when the child exits.
- Children share a key in groups of N per model, so no single key carries a whole round's request rate.
- Only native's exact leaf argv (`--mode json -p --no-session`) is touched. A child stays a leaf: `-p` alone marks it so for `qcr-leaf.ts`.
- Without a pack, a group's later children start `subagent_cache_stagger_ms` (2500) after its first. Rows of one agent whose prompts differ only in a short task pointer, such as the sweep rows, then share their system prompt.

**The context pack** (`[review] context_pack = "pack-first"`, the default; `"off"` restores the old prompts). Three pieces:
- **The pack file.** `src/contextpack.ts` renders the round's pack, written beside its task files as `<passes>/context-pack.md`. It holds, within `context_pack_max_tokens` (40,000):
  - the change since the last review, on follow-up rounds;
  - the PR's diff, file by file;
  - the full text of its most-changed non-test files.

  Files are read only as regular files inside the worktree (never a symlink a PR planted) and under 256 KB. What did not fit is named.
- **The warm-up.** For a task-file child of a round with a pack, the glue starts the group's first child together with a **warm-up**:
  - the same argv without the lens text, and "reply OK" as its task;
  - every child of the group waits for the warm-up to finish, at most 30 s, before it starts.
- **The child extension.** `extensions/leaf-cache.ts`, loaded into those children, rewrites each request:
  - the lens body comes out of pi's `<addendum>` block in `instructions`;
  - the input becomes the pack (user role, fenced data), then the lens body as a **developer** message, then the task.

The warm-up's request is exactly that shared prefix, and every lens request of the group extends it.

The task files tell the lens that the pack is the first message of its conversation, and to read the pack file instead when it is not there.

Measured end to end in a real pi 1.0.0 parent with this glue: two lenses with different instructions over a 24k-token pack. Each paid ~1.2k uncached tokens and read 23,808 from cache, against ~25k uncached each without it.

## The measured run (2026-10-09)

The pack moves each lens's instructions from the system prompt into a developer message after the pack, so it was measured before it was turned on. The run used 10 follow-up replay cases from October, each run under three arms on the bench: the old follow-up code, the new code with the pack off (cache groups on), and the new code with the pack on.

| | Old code | New, pack off | New, pack on |
|---|---|---|---|
| Total cost | $33.9 | $48.4 | **$28.9** |
| Median cost per case | $3.46 | $4.99 | **$3.01** |
| Share of input read from cache | 0.68 | 0.69 | **0.88** |
| The same, children's first turns | 0.21 | 0.15 | **0.83** |
| Verdict matches the live round | 9/10 | 9/10 | **10/10** |
| Live blockers found again | 3/4 | 4/4 | **4/4** |

The pack was 40% cheaper than the same code without it, case by case, with no loss of verdict agreement or recall, so it is on by default. The pack-off arm cost more than the old code because the early pre-approval sweep then ran in rounds that ended in REQUEST_CHANGES; the early start was removed afterwards (docs/follow-up-rounds.md). The cache groups change nothing the model sees.

## Debugging

`QCR_LEAF_CACHE_DEBUG=1` in a child's environment prints a short hash of each request's prefix parts (`instructions`, `tools`, `input0…`). Comparing two children shows where they diverge. The child's `turn1 cacheRead` shows whether it hit.
