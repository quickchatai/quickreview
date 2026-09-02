# LLM setup — the two routes

Every review is produced by **pi** sessions (the coding agent the daemon runs
in tmux) talking to OpenAI models. There are two ways to give those sessions
credentials, and they differ in the model-string prefix, the money model, and
one operational step. Pick one before first boot.

pi resolves credentials in this order: CLI flag → `auth.json` (the OAuth
token store) → environment (`OPENAI_API_KEY`). A completed `/login` therefore
takes precedence over an API key in the environment.

**The onboarding wizard does all of this for you** (`qcr onboard`):
it asks the question, points you at the same secrets flow for the key (a key
pasted into an agent session would land in a transcript, so it never accepts
one as an argument), performs the six-value prefix rewrite below itself
(comment-preserving, idempotent and reversible — switching routes later just
re-runs the step), and, on the OAuth route, guides each of the three logins in
turn and checks that each container's token landed on that container's
*persistent* pi-home volume rather than in a writable layer a recreate would
throw away. This page is the manual path and stays authoritative for what the
wizard does; drift between the two is a bug.

## Route 1 — ChatGPT OAuth (subscription, the shipped default)

The model strings in `config.toml [models]` default to the **`openai-codex/`**
provider prefix — pi's ChatGPT-OAuth route. No API key is needed for the
review models.

**The logins, once each:** after a container is up, open a pi session in it and
log in:

```sh
docker exec -it <container> tmux attach -t overseer
# inside pi:  /login   → follow the browser flow, then detach (Ctrl-b d)
```

The OAuth tokens land in `auth.json` under pi's home, which is a **named
Docker volume** (`pihome`) — so the login survives container restarts and
image rebuilds. You repeat `/login` only if that volume is deleted or the
tokens are revoked.

**Expect up to three of them, and know why.** pi's tokens live in the pi home
of whichever process logged in, and **they do not transfer between your host
and a container** — there is no shared credential store. So the daemon
container needs its own, the local companion container needs its own, and any
pi you run on the host (including the setup wizard's own session) needs a third.
Each one is a separate browser flow, each is once-per-volume, and the wizard
guides them where they happen. If a login "disappears" after a rebuild, the
cause is almost always a container whose pi home was *not* on a persistent
volume: the token was written into the writable layer and went with it.

**Cost shape:** flat — whatever the ChatGPT plan costs, bounded by the plan's
usage limits rather than a per-token meter. An actively reviewed repo runs
many long, tool-heavy sessions per day (each round fans out ~10 read-only
analysis passes plus a validator over the full diff), which is far beyond
casual-use budgets: expect to need a high-tier plan, and expect to hit the
plan's rate/usage ceilings before you hit any daemon-side limit if you choose
a low one.

## Route 2 — API key (metered)

1. Put the key in the secrets dir — the wizard has a slot for it:

   ```sh
   bash deploy/collect-secrets.sh    # paste it at the openai_api_key prompt
   ```

   It lands as the file `openai_api_key` (0600) in the secrets dir; the
   container entrypoint exports it as `OPENAI_API_KEY` for every pi process.

2. Change the model strings from the OAuth provider to the direct API
   provider — the prefix is the route. All of them live in
   `config.toml [models]`:

   ```toml
   [models]
   default      = "openai/<model>"      # was "openai-codex/<model>"
   conversation = "openai/<model>"
   overseer     = "openai/<model>"

   [models.tiers]
   "terra-med" = "openai/<small-model>:medium"
   "sol-med"   = "openai/<model>:medium"
   "sol-high"  = "openai/<model>:high"
   ```

   The `:suffix` is the reasoning-effort tier; `[models] small_diff_lines`
   decides which PRs start on the cheaper tier, and `validate_tier` is the
   validator's floor.

3. If a ChatGPT `/login` was ever completed in the container, its tokens
   outrank the env key — log out in pi (or clear `auth.json` on the `pihome`
   volume) when you truly want the metered route.

**Cost shape:** metered per token. A review round reads the full diff through
each selected pass, so a mid-size PR round is typically on the order of
hundreds of thousands of input tokens and tens of thousands of output tokens;
a busy repo with sticky per-PR conversations, rechecks and ping-pong can run
into millions of tokens per day. (For calibration: the laptop-loop predecessor
this system replaced measured single failure classes in the multi-million-
output-token range per audit window.) Budget accordingly, prefer a cheaper
model for the `terra-med` tier, and fill in `[models.pricing]`
(`input_per_mtok` / `output_per_mtok` per bare model id) so `qcr spend`
reports real dollars instead of raw token counts.

## Either route: memory embeddings need nothing here

The memory engine (OpenViking) embeds every memory entry — and every search
query — to store and find it. **By default it does that locally**, with its
own llama-cpp embedder inside the daemon container
(`config.toml [openviking] embedding_provider = "local"`, the shipped value):
no key, no account, and no memory text ever leaves your machine. Nothing but
the model call does. Neither route above changes that, and **`openai_api_key`
is pi's model credential alone — it is never read for embeddings.**

A hosted embedder is an explicit opt-in, not a fallback and not an upgrade the
wizard suggests: `embedding_provider = "openai"` (with the model and its
dimension, e.g. `text-embedding-3-small` / `1536`) sends every memory entry's
text to OpenAI, and reads **its own** credential file,
`<secrets dir>/openai_embeddings_api_key` (`deploy/collect-secrets.sh` has the
prompt; `embedding_key_file` names it). The onboarding wizard's embeddings
step (order 38) writes the opt-in for you and refuses to go green without that
file. Either file can exist without the other.

Changing the embedder changes the vector space, and an existing store is
migrated rather than abandoned — see
[docs/memory-embeddings.md](memory-embeddings.md).

## Quick reference

| | ChatGPT OAuth | API key |
|---|---|---|
| Provider prefix in `[models]` | `openai-codex/` (shipped default) | `openai/` |
| Credential | `/login` once in any pi session | `openai_api_key` file → `OPENAI_API_KEY` |
| Memory embeddings | local, no key (hosted = separate opt-in + `openai_embeddings_api_key`) | same |
| Survives restarts via | `pihome` volume (`auth.json`) | secrets dir file |
| Cost | plan-flat, plan-limited | per-token, effectively unlimited |
| Spend visibility | plan dashboard only | `qcr spend` with `[models.pricing]` filled |
