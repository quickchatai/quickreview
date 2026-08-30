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
- First-party exceptions (authored for this project, licensed under the
  repository's own `LICENSE`, NOT part of the upstream set): the
  `deploying`, `runbook` and `feedback-mining` skills. The `skills/companion/`
  directory at the repository root is likewise first-party.

## Subagents — no third-party component

Subagents run on pi's **first-party** subagent extension, shipped inside the
pinned `@earendil-works/pi-coding-agent` npm package
(`examples/extensions/subagent/`, MIT like the rest of pi) and loaded at
runtime from the installed package by the first-party
`extensions/subagents.ts` — nothing is vendored or redistributed, so no
notice entry is needed. (History: the unlicensed third-party
amosblomqvist/pi-subagents extension that used to fill this role was removed
entirely on 2026-08-30 —'s licensing question dissolved by removal,
.)

## npm dependencies

Runtime and development npm packages (`better-sqlite3`, `smol-toml`,
`node-pty`, `@xterm/headless`, `typescript`, `vitest`, …) are installed from
the registry, not vendored; their licenses ride the packages themselves under
`node_modules/` and are all MIT/Apache-2.0/BSD-family. See `package.json`.
