# LLM setup — the two routes

Every review is produced by **pi** sessions (the coding agent the daemon runs
in tmux) talking to OpenAI models. There are two ways to give those sessions
credentials, and they differ in the model-string prefix, the money model, and
one operational step. Pick one before first boot.

pi resolves credentials in this order: CLI flag → `auth.json` (the OAuth
token store) → environment (`OPENAI_API_KEY`). A completed `/login` therefore
takes precedence over an API key in the environment.

## Route 1 — ChatGPT OAuth (subscription, the shipped default)

The model strings in `config.toml [models]` default to the **`openai-codex/`**
provider prefix — pi's ChatGPT-OAuth route. No API key is needed for the
review models.

**One manual step, once:** after the container is up, open any pi session and
log in:

```sh
docker exec -it <container> tmux attach -t overseer
# inside pi:  /login   → follow the browser flow, then detach (Ctrl-b d)
```

The OAuth tokens land in `auth.json` under pi's home, which is a **named
Docker volume** (`pihome`) — so the login survives container restarts and
image rebuilds. You repeat `/login` only if that volume is deleted or the
tokens are revoked.

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

## Either route: the embeddings key

The memory engine (OpenViking) embeds entries with an OpenAI embedding model
(`config.toml [openviking] embedding_model`, default
`text-embedding-3-small`) and reads its credential from the same
`openai_api_key` file. Without that file it falls back to a local dense
embedder — functional, but slower and lower quality. Embedding usage is tiny
(fractions of a cent per day), so providing the key file is worthwhile **even
on the OAuth route**: OAuth covers the review models only, never embeddings.

## Quick reference

| | ChatGPT OAuth | API key |
|---|---|---|
| Provider prefix in `[models]` | `openai-codex/` (shipped default) | `openai/` |
| Credential | `/login` once in any pi session | `openai_api_key` file → `OPENAI_API_KEY` |
| Survives restarts via | `pihome` volume (`auth.json`) | secrets dir file |
| Cost | plan-flat, plan-limited | per-token, effectively unlimited |
| Spend visibility | plan dashboard only | `qcr spend` with `[models.pricing]` filled |
