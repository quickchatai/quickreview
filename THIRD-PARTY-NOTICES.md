# Third-party notices

This repository is licensed under the MIT License (see `LICENSE`). It
redistributes the third-party components below. Each entry names the upstream,
its license, and where the full text and provenance live in this tree.

## extensions/vendor/openviking-pi — OpenViking pi coding-agent extension

- Upstream: <https://github.com/volcengine/OpenViking>, path
  `examples/pi-coding-agent-extension`, tag `v0.4.15`
  (base commit `d436baa23c83938b22bb0aab08b0ce48568b5ff4`).
- License: **Apache-2.0**. The OpenViking project as a whole is AGPLv3, but
  `examples/` — where this extension lives — is Apache-2.0 (see the upstream
  README, "License").
- Full license text: `extensions/vendor/openviking-pi/LICENSE`.
- Attribution and modification notice (Apache-2.0 §4(b)):
  `extensions/vendor/openviking-pi/NOTICE` — this is a MODIFIED copy; the full
  delta is the `patches/` series beside it, and
  `extensions/vendor/openviking-pi/upstream.json` is the machine-readable
  provenance record.

## extensions/inline-bash.ts — pi example extension

- Upstream: the pi coding agent package
  `@earendil-works/pi-coding-agent`, file
  `examples/extensions/inline-bash.ts`, vendored verbatim (2026-08-25 at
  0.84.1; byte-identical at the current 0.84.4 pin).
- License: **MIT** (the pi package's license). The MIT text as it applies to
  this file:

  > MIT License
  >
  > Copyright (c) 2025 Mario Zechner
  >
  > Permission is hereby granted, free of charge, to any person obtaining a
  > copy of this software and associated documentation files (the
  > "Software"), to deal in the Software without restriction, including
  > without limitation the rights to use, copy, modify, merge, publish,
  > distribute, sublicense, and/or sell copies of the Software, and to permit
  > persons to whom the Software is furnished to do so, subject to the
  > following conditions:
  >
  > The above copyright notice and this permission notice shall be included
  > in all copies or substantial portions of the Software.
  >
  > THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
  > OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
  > MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
  > IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
  > CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
  > TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
  > SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

## .claude/skills — vendored skill set

- Upstream: <https://github.com/mattpocock/skills>, pinned by commit in
  `.claude/skills/VENDORED.md`.
- License: **MIT** (Copyright (c) 2026 Matt Pocock). Full text:
  `.claude/skills/LICENSE`.
- First-party exception (authored for this project, licensed under the
  repository's own `LICENSE`, NOT part of the upstream set): the
  `selfimprove` skill. The `skills/companion/` directory at the repository
  root is likewise first-party.

## bench/aacr — third-party benchmark data

The benchmark harness (`bench/aacr/`) commits rows derived from four public
benchmarks: case sets (PR ids, commits, and the PR author's title and
description) and, for Martian, its golden comments. Each set file's `dataset`
field pins the source commit and file hash (`sets/dedup5-*.json` are cut
from the four below and name their source the same way). No third-party review-tool
comment text is committed: vendor reviews and SWE-PRBench's human review
comments are fetched from the pinned sources at run time and verified by hash
(`bench/aacr/ext/sweprbench/dataset-manifest.sha256`, the Martian manifest
sha256 in `sets/martian*.json`). The exceptions are the reviewer-output
fixtures and the verbatim prompts and harness code listed under "bench/aacr —
reviewer prompts, harness code and output fixtures" below.

- **AACR-Bench** — <https://github.com/alibaba/aacr-bench> (dataset commit
  `ab8af8d5`, harness commit `68a5697`), **Apache-2.0**. Derived here:
  `sets/` (smoke10, dev10, holdout10, fresh10, rest145, full and their
  subsets), `references.json`, `bot_references.json`, `sets/*.labels.json`,
  and the defect keys in `defects/` (a modified work: our verified answer key
  over AACR-Bench's PRs).
- **Martian code-review-benchmark** — <https://github.com/withmartian/code-review-benchmark>
  (commit `e616e84`), **MIT**. Derived here: `sets/martian*.json`,
  `ext/martian/fork-prs.json`, and the golden comments quoted in
  `ext/martian-tuning/golden-audit-full.json`.
- **Qodo PR-Review-Bench** — <https://huggingface.co/datasets/Qodo/PR-Review-Bench>
  (commit `a73957c`), **MIT**. Derived here: `sets/qodo-*.json`.
- **SWE-PRBench** — <https://huggingface.co/datasets/foundry-ai/swe-prbench>
  (commit `b87f579`), **CC-BY-4.0**. Derived here: `sets/sweprbench-*.json`
  (PR metadata with each PR's title and description from the dataset's
  `prs.jsonl`); attribution: SWE-PRBench, FoundryHQ-AI.

## bench/aacr — reviewer prompts, harness code and output fixtures

`bench/aacr/docs/PROMPTS.md` reproduces, word for word, the prompts and code
each compared reviewer ran with, so a reader can check what produced a number.
The test suite keeps a few real outputs of those reviewers as parser fixtures.
Each item names its source and, for code and prompt text, its license:

- **AACR-Bench harness code** — <https://github.com/alibaba/aacr-bench>
  (harness commit `68a5697`), **Apache-2.0**. Quoted unmodified in
  `bench/aacr/docs/PROMPTS.md`: `evaluation/judge.py` (§3), the findings
  prompt fragment of `reviewers/codex.py` (§5.2, §5.3; also restated in
  `src/bench/opencode.ts`) and `reviewers/claude.py` (§5.5).
- **OpenCode** — <https://github.com/sst/opencode>, **MIT**. Its built-in
  `review` command template, copied verbatim from 1.18.33, is in
  `src/bench/opencode.ts` and quoted in `bench/aacr/docs/PROMPTS.md` §5.3.
- **pi-review** — [`@zephyrdeng/pi-review`](https://github.com/ZephyrDeng/pi-review)
  0.18.0, **MIT**. Its `resources/system-prompt.md` (which carries its own
  MIT credit for the prompt structure it was inspired by) and the output
  contract of `dist/prompt.js` are quoted in `bench/aacr/docs/PROMPTS.md`
  §5.4; `tests/fixtures/pireview-stdout-immich.txt` is one real pi-review
  output on a public PR.
- **Claude Code** `/code-review` output — `tests/fixtures/claude-prose/*.md`
  are real outputs of the Claude Code arm on public benchmark PRs, kept as the
  golden set of the prose parser (`tests/bench-claude-prose.test.ts`).
  Claude Code's own prompt is not reproduced (it is internal to the CLI).

## Subagents — no third-party component

Lenses run through the first-party lens tool (`packages/pi-plugin/src/engine/lens/`), SDK sessions
of the host process — nothing is vendored or redistributed, so no notice entry
is needed. (The pi-package example subagent extension that once filled this
role, loaded by `extensions/subagents.ts`, is retired.)

## npm dependencies

Runtime and development npm packages (`better-sqlite3`, `smol-toml`,
`typescript`, `vitest`, …) are installed from
the registry, not vendored; their licenses ride the packages themselves under
`node_modules/` and are all MIT/Apache-2.0/BSD-family. See `package.json`.
