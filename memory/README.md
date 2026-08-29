# memory/ — runtime drop-box (and where reviewer memory actually lives)

This directory is a **runtime drop-box** like `inject/`, `verdict/` and
`archive/`: empty in the repo (only this file and `.gitkeep` are tracked),
populated only at runtime, never committed.

Reviewer memory itself does **not** live in files here. Since the
cutover the memory engine is **OpenViking**, a second supervised process in
the container on loopback `:1933`:

- `src/memory/` is the engine-agnostic **seam** — the `MemoryStore`
  interface every surface talks to, the round path's context assembler
  (memory never blocks or delays a round; failures resolve to `""`), and the
  one reader/writer of the `#tag`/`k=v` entry header.
- `src/openviking/` is the **engine** — supervisor, health gate, HTTP
  client (every write is a `content/batch-write` with a hash precondition),
  and the seam's single implementation.

Who writes memory: the end-of-day curator session (durable learnings, via
the pi extension's `viking_write`), the `[feedback]` tuning-loop sink, and
the operator through the TUI's Memory & learning tab (`retire`/`pin`/`edit`/
`add`). Lens passes are read-only by construction — they hold search/read
tools and no writer. Pinned entries (`#pinned`) survive truncation at the
head of every round's context and are never consolidated by the sweep;
`#manual` marks the owner's own words.

Historical note: an earlier hand-rolled engine kept a `MEMORY.md` file per
pi convention. That engine is deleted; `src/memory/legacy-file.ts` remains as
a read-only parser over an archived `MEMORY.md` (used by the one-time curated
import, `scripts/import-pi-memory.mjs`), which is the only reason the old
format is mentioned anywhere.
