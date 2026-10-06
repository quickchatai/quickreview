# openviking-pi — vendored, patched fork

The OpenViking pi extension our sessions load. Vendored, not depended on:
upstream ships it as an `examples/` directory, not a package, and we need six
behaviour changes that upstream has no reason to make.

| | |
|---|---|
| Upstream | `github.com/volcengine/OpenViking` |
| Path | `examples/pi-coding-agent-extension` |
| Tag | `v0.4.15` |
| **Base commit** | **`d436baa23c83938b22bb0aab08b0ce48568b5ff4`** |
| Licence | Apache-2.0 (`LICENSE`, `NOTICE`) — the OpenViking *server* is AGPLv3, `examples/` is not |
| Entry point | `index.ts` (pi loads TypeScript sources directly) |
| Loaded by | `src/sessions.ts` → `extensionPaths()` → `pi --extension <path>` |

The base commit is pinned in `config.toml [openviking] extension_commit`, next
to the server `version` it must move with, and `tests/openviking-fork.test.ts`
fails on drift between the two.

## Why a fork rather than configuration

Every one of the six patches was tried as configuration first and does not
exist there. The evidence is a spike against a **running v0.4.15 server plus
the pinned pi 0.84.1** — `assets/findings.md` in the issue tracker,
with transcripts. Read it before changing anything here; several of its
findings contradict the OpenViking docs, which lead the tag.

## The patch series

Six numbered behaviour patches, applied in order over the vendored upstream
files, plus one unnumbered scaffolding patch. They live in `patches/` as
`git apply`-able diffs — verified by applying all seven, in order, to a
pristine `v0.4.15` extraction and diffing the result against this directory:
byte-identical. (`patches/` and `upstream.json` are meta and are not themselves
part of the reproduced tree.) Every hunk they add carries a greppable marker:

```sh
grep -rn "QCR PATCH" extensions/vendor/openviking-pi
```

### 0000 — vendoring and build conformance *(not a behaviour patch)*

* Fork banner in `index.ts`; `NOTICE` (Apache-2.0 §4(b) requires stating that
  the files were modified); this README.
* `vendor-pi-types.d.ts` — ambient declarations for
  `@earendil-works/pi-coding-agent` (`ExtensionAPI`), `typebox` and
  `@earendil-works/pi-ai`. None is installed here; pi lives only in the
  container. This repo's `tsconfig.json` compiles `extensions/**/*.ts`, so the
  fork is typechecked even though it is never emitted.
* Three `[QCR build conformance]` fixes in `client.ts` for `strict` +
  `noUncheckedIndexedAccess`.
* `shared/setup-wizard.mjs`, `shared/plugin-config.mjs`,
  `shared/debug-log.mjs` deleted — unreachable from `index.ts`. The wizard in
  particular is an interactive installer, which has no place in a daemon.
* **Root-key guard** in `config.ts` (`withoutRootKey`). Upstream's credential
  resolver falls back to `ov.conf`'s `server.root_api_key`, and in our
  container `~/.openviking` is a symlink to the state volume holding the
  *server's own* ov.conf — so the fallback would silently authenticate every
  review session as ROOT. The phase rule is absolute: never an ADMIN or ROOT
  key anywhere (findings §1). If the resolved key is the server's root key it
  is dropped; the client then 401s and the extension reports "not reachable",
  which is loud. Keep this on any rebase.
* Only the files `index.ts` reaches are vendored — `scripts/`, upstream
  `tests/`, `DESIGN.md`, `TAKEOVER.md` and the upstream `README.md` are not.
  `upstream.json` lists exactly what was taken and what was left.
* `tsc` also *emits* the fork into `dist/extensions/vendor/openviking-pi/`.
  That output is dead: pi loads the `.ts` here, and the emitted `.js` would not
  even resolve its `.mjs` siblings (they are not copied). Ignore it.

### 0001 — `session_before_compact` is deleted

`extensions/ledger-pin.ts` is the sole owner of compaction. It re-pins the
review ledger block that pi's token-driven compaction would otherwise
summarise away; pi does not document how two registered handlers merge, and
the failure mode is losing the ledger — the one thing ledger-pin exists to
protect.

**Do not "restore and disable" via `takeover.enabled: false`.** Verified on
the running server (findings §4.2): upstream registers the handler
**unconditionally**. The knob only changed what it did — with takeover off it
still ran a synchronous `sync.commit()` on the compaction path — and takeover
defaults **on** (`config.takeoverEnabled = config.takeoverEnabled !== false`).

The same patch forces `takeoverEnabled = false` in `config.ts`, in code.
Takeover exists to *replace* compaction; with the handler gone, a takeover
that still advances its boundary on `turn_end` and rewrites `context` would be
the worst of both. `config.json` also says `takeover.enabled: false`, which is
belt-and-braces only — a config knob is something an operator can flip, and
this one is structural.

Touches: `index.ts` (handler + the `compacted` flag it set), `config.ts`,
`config.json`.

### 0002 — no ambient work in a subagent/leaf process

A pi-subagents child running one lens pass gets the read tools and nothing
else: no recall injection, no profile block, no turn sync, no commit.

Two reasons. The single-shepherd invariant (root `CLAUDE.md` rule 9) makes the
PR's one main pi the owner of the review; a pass is a stateless evaluator of a
diff and memory injected under it is unaccounted context. And a commit from a
leaf would archive the **shepherd's** session, because the OV session id
reaches the child through the inherited environment.

pi-subagents builds child argv with `--no-extensions` (findings §4.3), so a
leaf structurally never loads this file — that is layer one. This patch is
layer two, and it keys off **argv**, not env: the child inherits the parent's
environment, so an env marker would read as "main" inside every leaf. See
`qcr-leaf.ts` for the flag set and the fail direction (unknown argv ⇒ main).

Touches: `qcr-leaf.ts` (new), `index.ts` (five guards + the `registerTools`
call sites), `tools.ts` (the `leaf` option and the write-tool gate).

### 0003 — the extension never creates an OpenViking session

`client.createSession()` is deleted, `getSession()` lost its `auto_create`
query parameter, and `sync.ensureSession()` no longer derives an id from pi's
session id — it **attaches** to an id the daemon put in the environment
(`OPENVIKING_SESSION_ID`, or `QCR_OV_SESSION_ID` which survives
`src/sessions.ts`'s `QCR_`-only argv prefix) and verifies it exists.

The daemon owns session lifecycle because creation carries a payload only it
knows: the extraction-disabling `memory_policy`
(`{self,peer,working_memory}.enabled = false`). Our deployment configures no
`vlm`, so a session created without it leaves a **failed background task on
every commit** (findings §2.3 / §2.5) while looking perfectly healthy.

No session id is a normal, non-fatal state: ambient sync is off, the memory
tools still work. Degrading memory-less is always allowed; blocking a review
round on memory never is.

Touches: `client.ts`, `sync.ts`, `index.ts` (the call site).

### 0004 — `viking_write`, the only write tool

Upstream's `viking_remember` is **not a write**: it appends
`[Remember — <category>] …` as a session message and relies on commit-time
extraction to promote it — i.e. on the `vlm` we deliberately do not configure.
Verified: nothing durable is produced (findings §3.2). Since sessions
authoring their own memories is the ratified design, they need a real write
tool.

`viking_write(uri, content, tags?, mode?, expect_hash?, wait?)`:

* **`content/batch-write` only, never `content/write`.** For memory targets
  `content/write` appends a server-side `MEMORY_FIELDS` footer that
  `content/read` strips again, so `read → sha256 → replace_if_hash` 409s
  forever and no API returns the stored hash. Files written through
  batch-write carry no footer and round-trip (findings §3.3).
* **Preconditions always.** `mode: "create"` sends `create_if_absent`;
  `mode: "replace"` **requires** `expect_hash` and sends `replace_if_hash`.
  There is no blind-overwrite path — a memory file is a shared document (the
  EOD curator and the TUI write it too) and a lost update is silent. A 409 is
  reported as a distinct outcome, with instructions to re-read rather than
  retry.
* **The response carries the hash of the bytes just written**, so a follow-up
  replace needs no read.
* **Tags** are rendered into the body as a visible `Tags: #a #b` line — plain
  text is what search indexes and what `content/read` returns unmodified — and
  *additionally* pushed to the retrieval tag list via `fs/attrs/set_tags`,
  best-effort, after the durable write. A `set_tags` failure narrows
  retrieval; it never loses the memory.
* **`wait: false` by default.** `wait` blocks on the semantic/vector refresh,
  measured at ~1.6 **core-seconds** per write on the 2-CPU container quota
  (findings §6). The bytes are durable either way; only searchability lags.

The patch also deletes `viking_forget` (curation belongs to the EOD sweep and
the TUI; retire is a tag+directory convention, not an `rm`, and a fuzzy
`>0.8`-match delete is a silent data-loss path) and `viking_add_resource` (the
reviewer reads code and CI results, it does not ingest the web — scoping
rule 2 — and this was an unreviewed egress path).

Remaining tool set: `viking_search`, `viking_read`, `viking_browse`,
`viking_write`, `viking_archive_expand`. In a leaf, the same minus
`viking_write`.

The pure half — URI/tag validation, body rendering, hashing, request assembly
— lives in `qcr-write.ts` so it can be unit-tested; `tools.ts` cannot be
imported from a test because it pulls `typebox` and `@earendil-works/pi-ai`.

Touches: `qcr-write.ts` (new), `client.ts` (`batchWrite`, `setTags`),
`tools.ts`, `index.ts` (the advertised tool list).

### 0005 — a second memory namespace (the companion's reviewer key)

Upstream builds ONE `OVClient` from ONE key, so a pi reaches exactly the user
tree that key owns. The ratified design is asymmetric: **the companion
and the TUI can do everything with memory — full read and write over every piece
of it** — while automated review sessions hold the reviewer key alone and stay
confined server-side. The companion container already receives the second USER
key as `OPENVIKING_REVIEWER_KEY` (`docs/companion-memory-access.md`); this patch
is what consumes it.

`qcr-namespaces.ts` resolves the extra namespaces and routes each tool call to
one; `index.ts` builds one `OVClient` per namespace (same endpoint, same
account, same actor peer — only the bearer key and `X-OpenViking-User` differ,
which is the pairing the server confines) and `tools.ts` addresses whichever one
the call names. The shape is the TUI's, not a second invention:
`src/tui/memory.ts` already runs one client per namespace with the namespace
prefixed onto every address.

Four properties are the patch:

* **Absence is normal.** No `OPENVIKING_REVIEWER_KEY` ⇒ no second namespace, no
  error, no `namespace` parameter in any tool schema, unprefixed answers — i.e.
  every review session keeps today's behaviour exactly, down to the tool
  descriptions the model sees.
* **The call says which tree it touches.** `namespace: "reviewer"` or a
  `viking://user/reviewer/…` URI; if both are given and disagree the call is
  REFUSED rather than resolved by a precedence rule, and every answer is
  prefixed `[<namespace>]`. Silently writing the wrong memory tree is the one
  failure here that is both invisible and durable.
* **`withoutRootKey` covers BOTH keys.** It is generic and `env`-parameterised
  now; the reviewer key goes through it before a client is built. A new key must
  not reopen the hole 0000 closed.
* **A leaf gains nothing.** `resolveExtraNamespaces` returns `[]` for a leaf,
  `index.ts` does not construct the clients in the leaf path, and
  `registerTools` discards namespaces handed to a leaf. Ambient work (recall,
  sync, commit) stays on the primary client in all cases — a second namespace is
  a TOOL surface only, never a second session.

Touches: `qcr-namespaces.ts` (new), `config.ts` (`withoutRootKey` generic +
`env`), `index.ts` (client construction, health probe, the advertised
namespaces), `tools.ts` (routing, the `namespace` parameter, prefixed answers).

### 0006 — writes that stick, errors that say so (S2)

Four changes, one reason: memory writes were dropped and memory failures were
read as empty answers.

* **A busy 409 is retried; a precondition 409 is not.** The server's
  batch-write takes a zero-timeout try-lock on its root directory, and a
  second writer into the same directory gets `409 CONFLICT` with
  `details.conflict_type = "path_busy"` and `retryable: true` — nothing was
  checked or written. The tool used to answer every 409 with "someone else
  edited the file — re-read it, never retry", for files nobody had touched:
  6 of the 8 EOD writes on 2026-10-05 died that way. `batchWrite` and
  `setTags` now retry exactly that answer, jittered and bounded (≤10 s,
  `qcr-honest.ts` `BUSY_RETRY`, the same rule as the daemon's client); a
  hash-precondition 409 carries no `path_busy` and stays a refusal.
* **`viking_write` takes several entries as ONE batch-write.** `entries[]`
  (or the old `uri` + `content` for one) — one request under the entries'
  deepest common directory, so a day's lessons take the directory lock once
  and land whole or not at all. The frozen EOD seed already said "it batches,
  so write today's entries in one call"; now it is true. A batch is routed by
  its entries' own addresses (`routeWrite`): in a two-key process (the
  companion) a batch of reviewer-tree entries goes to the reviewer key
  without naming the namespace, and one that straddles both trees is refused.
* **No failure reads as "No results found".** `find()` returns the envelope
  instead of collapsing every failure to `[]`, and `viking_search`,
  `viking_read` and `viking_browse` name a refused key, a dead server or a
  busy directory as what it is (`failureText`): every PR-session memory call
  in history came back "No results found." or "No content at …", two of them
  inside the five-week `Invalid API Key` outage. "No content" / "Not found" /
  "Empty directory" now mean exactly that (a NOT_FOUND or an empty answer).
* **A refused key is re-read once.** The primary client's key is re-resolved
  from its source after an auth failure (`rereadApiKey` in `config.ts`) and
  the request retried once, only if the key actually changed — the daemon
  rewrites the sessions' `ovcli.conf` when its key rotates, and a running
  session used to keep sending the dead one until it died.

Touches: `qcr-honest.ts` (new), `qcr-write.ts` (`buildBatchWriteRequest`,
`routeWrite`),
`client.ts` (`rekey`, busy retry, `find` / `readLevel` / `lsResponse` /
`statResponse` envelopes), `config.ts` (`rereadApiKey`), `tools.ts`,
`index.ts` (the banner, the re-reader).

## Rebasing onto a newer upstream

```sh
git clone --filter=blob:none https://github.com/volcengine/OpenViking /tmp/ov
git -C /tmp/ov checkout <new-tag>
# 1. Refresh the vendored files (only the ones listed by `git ls-files` here):
#    copy examples/pi-coding-agent-extension/{index,config,client,recall,sync,
#    tools,takeover}.ts, config.json, lib/, shared/ and examples/LICENSE.
# 2. Re-apply, in order:
for p in extensions/vendor/openviking-pi/patches/0*.patch; do
  git apply --3way "$p" || echo "RESOLVE: $p"
done
# 3. Re-verify all six patches, then:
timeout 900 npm test && npm run build
```

Then update `extension_commit` and `version` in `config.toml [openviking]`,
the base commit in `NOTICE` and in the table above, and re-run the live
verification below. A bump re-verifies **all six** patches — a patch that no
longer applies is a patch whose reason may have changed, not a patch to drop.

`tests/openviking-fork.test.ts` is the guard rail: it asserts the six patches
are still present (markers, and the *absence* of what each one removed) and
that the pinned commit here matches `config.toml`. It cannot tell you whether
upstream grew a *new* compaction handler or a *new* write tool — read the
upstream diff for those two things specifically.

## What is verified, and what is not

Verified on a running v0.4.15 + pi 0.84.1 (findings, with transcripts):
the extension loads on our pinned pi and registers its tools; `takeover.enabled
: false` does not unhook `session_before_compact`; `viking_remember` is not a
durable write; `batch-write` preconditions 409 correctly and the
`MEMORY_FIELDS` footgun is real; pi-subagents children carry `--no-extensions`;
`OPENVIKING_PEER_ID` overrides the path-derived peer id.

Also verified, for 0005: the reviewer USER key reaches `user/reviewer/` and is
refused on `user/companion/` when paired with the other user's header — that is
the four-cell matrix `node scripts/companion-memory-forward.mjs verify` runs,
and it is what makes two USER keys safe. What it proves is the SERVER's
confinement, not this extension's plumbing.

**Not yet verified end to end** (needs a session smoke on the VM, where a real
model provider exists): that a `viking_write` entry is readable through the
daemon's client against a live server, and that the ledger block survives a
real compaction with this fork loaded. The second half of that is the open
item — "does a no-op second handler drop ledger-pin's pinned block?" —
which this patch series makes moot by construction rather than by measurement.
Fold both into `npm run smoke:session`.

Also unverified live: a `viking_read`/`viking_write` through the SECOND
(reviewer) client from the companion's pi. The key and the server-side
confinement are proven; the extension-side routing is covered by unit tests
only. Fold it into the companion smoke (`npm run smoke:companion`).
