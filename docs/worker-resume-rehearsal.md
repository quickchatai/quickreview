# Worker resume rehearsal

P8.4. At the cutover every open PR resumes in a per-round worker for the first time. This records the same resume done offline first: the real worker (`src/botworker.ts`) resumes a copy of each PR JSONL on pi-ai's faux provider, in the worker rig (a fake daemon on a real unix socket, a production-shaped root). No model, no network: the offline guard of `tests/worker-resume-rehearsal.test.ts` fails the run on any connection attempt, and the JSONLs themselves are only read (every one is copied into a scratch world that is deleted afterwards). Cost: $0.

Run 2026-10-19 on 304a6b08. 446 JSONL file(s), 2048.4 MB: **446 resumed with every check green, 0 not.**

Re-run it: `scripts/worker-resume-rehearsal.sh <label>=<dir> ...` (see the script's header). The same resume check runs on the day inside the cutover preflight (P8.4b), on the library half of this rehearsal (`src/resumecheck.ts`).

## What is checked, per file

1. **Parse time**: our own pass over every line (`inspectSessionJsonl`), and pi's `SessionManager.open` + `buildSessionContext`, which is what a worker pays before its first request.
2. **The id is kept**: the resumed session's id is the header's id, the provider's cache key (`options.sessionId` of the request) is that id, and the file is the same file.
3. **Append-only**: no second JSONL appears beside it and every earlier line is byte-for-byte what it was.
4. **Cache prefix** (canary 10's concern, on real history): the request's system message is compared section by section (`preamble`, `project_context`, `cwd`) with the stored one, its tool schemas with the stored `toolsAdded`, and both with a session born in the same world. The D34 reviewer stub is looked for in the stored context file.
5. **Custom entries are tolerated**: the file's entry types, custom entries and the session-command / inject-bridge markers are counted, and the file resumed anyway.
6. **Legacy cwd headers** resolve under the release image's legacy mounts (read from `deploy/ansible/playbook.yml`), and the legacy paths the history mentions are split into those the image still has and those it does not.

**What an offline run cannot show.** The faux has no cache: it shows the bytes the prompt prefix is made of (the stored system message and tool schemas, replayed as they were, the provider session id unchanged), not a provider's cache hit. The tail the worker appends (the engine's tool announcement and the round order) is new text and is not cached on the first round.

Compaction is not run in the rehearsal (`compact: false`): it is one more provider call, and `tests/botworker.test.ts` holds it.

## Results

### live

The owner's read-only snapshot of the live bot's `state/pi-sessions` (every PR JSONL modified in the last seven days): the files the cutover resumes.

119 JSONL file(s), 318.1 MB; 119 resumed with every check green, 0 not. Largest 26.5 MB (243 entries): our parse 330 ms, pi 350 ms, worker round 619 ms.

| per file, ms | median | p95 | max |
|---|---|---|---|
| our JSON parse of every line | 21 | 186 | 330 |
| pi: SessionManager.open + buildSessionContext | 13 | 147 | 350 |
| the whole worker round on the faux (connect to exit) | 122 | 277 | 619 |

pi's open time by file size: < 1 MB: 53 file(s), median 3.0 ms, max 12 ms; 1-10 MB: 61 file(s), median 35 ms, max 147 ms; >= 10 MB: 5 file(s), median 250 ms, max 350 ms.

| check | files passing |
|---|---|
| worker exits 0 and resumes the file (not a new session) | 119 / 119 |
| the session id is kept (the header's id) | 119 / 119 |
| the provider cache key is that id | 119 / 119 |
| same file, no JSONL beside it, every earlier line byte-identical | 119 / 119 |
| the request replays the file's history | 119 / 119 |
| exactly one provider request (the faux's) | 119 / 119 |
| every line is JSON and the header is a v3 session | 119 / 119 |

**Cache prefix.** pi stores the system message (prompt sections and tool schemas) as the first entry and replays it as it is.
119 of 119 files carry one; 119 of those are sent with every section byte-equal to the stored one, so the prefix the old session cached against is unchanged. Against a session born in the same world, 119 send another system message and 119 other tool schemas: they keep the old build's, which is what keeps the prefix.
The worker's tools that the file did not record are announced after the replayed history, in a system message of their own (the whole list, for a file with no stored one): `lens` 119, `lens_wave` 119.
Tools the file records that the worker's session does not register (the model may still try them): `launch_plan` 119, `subagent` 119.
The stored preamble (standing instructions, frozen at the session's birth) still names tools the worker does not register: `subagent` 118. The round order's engine section is what redirects the model to `lens` and `lens_wave`.
The stored context file against the current reviewer stub (D34): `current` 119.
The `cwd` section the old session was shown: `/opt/quickreview/sandbox` 119.

**Entries the worker had to tolerate** (all resumed):

- entry types: `message` 8246, `model_change` 119, `session` 119, `session_info` 119, `thinking_level_change` 119, `custom` 65, `compaction` 63, `context_edit` 39
- custom entries: `qcr-review-ledger` 65
- markers in user turns: `qcr-command` 668, `qcr-recheck` 372, `qcr-round` 126, `qcr-post` 6, `qcr-inject` 4. The session-command ledger's `qcr-command` turns are in 118 file(s) and the inject bridge's `qcr-inject` turns in 1; P9.1 deletes their writers and the old turns stay in the history.

**Legacy paths.** Header cwd against the release image's legacy mounts (`/opt/quickreview/sandbox/<clone>`, `/opt/quickreview/sandbox/wt`): `/opt/quickreview/sandbox -> mount-parent` 119.
Paths under `/opt/quickreview/sandbox/` that the history mentions, by first component: still mounted `wt` 78187; not in the release image `state` 23748, `AGENTS.override.md` 1675, `example-app` 5, `depcache` 2, `verdict` 1.

### mirror

The transcript mirror pulled from the live daemon on 2026-09-21: older interactive-pi JSONLs, from PRs that have since closed (the archiver's transcripts are these same bytes).

327 JSONL file(s), 1730.4 MB; 327 resumed with every check green, 0 not. Largest 43.6 MB (722 entries): our parse 281 ms, pi 255 ms, worker round 373 ms.

| per file, ms | median | p95 | max |
|---|---|---|---|
| our JSON parse of every line | 25 | 274 | 492 |
| pi: SessionManager.open + buildSessionContext | 16 | 224 | 526 |
| the whole worker round on the faux (connect to exit) | 98 | 394 | 800 |

pi's open time by file size: < 1 MB: 72 file(s), median 2.6 ms, max 17 ms; 1-10 MB: 211 file(s), median 22 ms, max 196 ms; >= 10 MB: 44 file(s), median 173 ms, max 526 ms.

| check | files passing |
|---|---|
| worker exits 0 and resumes the file (not a new session) | 327 / 327 |
| the session id is kept (the header's id) | 327 / 327 |
| the provider cache key is that id | 327 / 327 |
| same file, no JSONL beside it, every earlier line byte-identical | 327 / 327 |
| the request replays the file's history | 327 / 327 |
| exactly one provider request (the faux's) | 327 / 327 |
| every line is JSON and the header is a v3 session | 327 / 327 |

**Cache prefix.** pi stores the system message (prompt sections and tool schemas) as the first entry and replays it as it is.
None of the 327 files carries one (written before pi stored it): the worker builds the prompt fresh for them, so their prefix is the new build's and not the old session's.
The worker's tools that the file did not record are announced after the replayed history, in a system message of their own (the whole list, for a file with no stored one): `bash` 327, `cluster_findings` 327, `coverage_gaps` 327, `edit` 327, `lens` 327, `lens_wave` 327, `read` 327, `write` 327.
Tools the file records that the worker's session does not register (the model may still try them): none.
The stored preamble (standing instructions, frozen at the session's birth) still names tools the worker does not register: none. The round order's engine section is what redirects the model to `lens` and `lens_wave`.
The stored context file against the current reviewer stub (D34): `no system message` 327.
The `cwd` section the old session was shown: none.

**Entries the worker had to tolerate** (all resumed):

- entry types: `message` 41208, `custom` 449, `compaction` 445, `model_change` 327, `session` 327, `session_info` 327, `thinking_level_change` 327
- custom entries: `quickreview-ledger` 449
- markers in user turns: `qcr-command` 1676, `qcr-post` 967, `qcr-round` 674, `qcr-recheck` 518, `qcr-inject` 1. The session-command ledger's `qcr-command` turns are in 314 file(s) and the inject bridge's `qcr-inject` turns in 1; P9.1 deletes their writers and the old turns stay in the history.

**Legacy paths.** Header cwd against the release image's legacy mounts (`/opt/quickreview/sandbox/<clone>`, `/opt/quickreview/sandbox/wt`): `/opt/quickreview/sandbox -> mount-parent` 327.
Paths under `/opt/quickreview/sandbox/` that the history mentions, by first component: still mounted `wt` 366301; not in the release image `state` 8012, `archive` 6349, `verdict` 4459, `commands` 2575, `ledger.md` 521, `notes` 517, `src` 343, `node_modules` 336, `inject` 264, `scripts` 262, `prompts` 166, `state-snapshots` 147, and 47 more.

## What the cutover should know

- Every PR JSONL resumes in the worker under its own id, in its own file, append-only, with the provider's cache key unchanged. Parse time is a few milliseconds for most files and under a second for the largest.
- pi 1.3 stores the system message and the tool schemas in the file and replays them verbatim, so the resumed prefix is the old session's, not the worker's. What the worker adds (the engine's tools, `lens` and `lens_wave`) arrives after the replayed history, in a system message of its own: the first resumed round pays for that tail and the round order only.
- The stored system message and tool list also freeze what the old session was told. The file still advertises `subagent` and `launch_plan` (the native lens pair), which the worker does not register, and its preamble still says to launch passes as subagents. A call to either is a tool-not-found; the round order's engine section is what points the model at `lens` and `lens_wave`.
- Every header cwd is `/opt/quickreview/sandbox`, which the release image's container has only as the parent of the legacy mounts (`wt` and the base clone). It resolves, but the old production tree is not in it. Absolute `/opt/quickreview/sandbox/state/...` (and `verdict`, `archive`, `commands`, ...) paths that the history mentions do not exist in the image: those directories are under the app root there. `wt/...` paths still resolve through the legacy mounts. Relative paths resolve against the worker's cwd, which must be the app root.
- The `qcr-command` and `qcr-inject` turns of the session-command ledger and the inject bridge, and the custom ledger entries, are inert text and entries to the worker; deleting their writers (P9.1) does not touch the old turns.

## Canary 10 (cache-prefix parity with the interactive build, stub included)

Run beside the rehearsal, on the same tree. These start the real interactive `pi` in a pty over a loopback endpoint and compare the raw request bodies with the SDK build's.

| file | tests | result |
|---|---|---|
| `tests/pi-canary/canary-10-bot-request.test.ts` | 4 | pass |
| `tests/pi-canary/canary-10-oneshot-request.test.ts` | 2 | pass |
| `tests/pi-canary/canary-10-bare-request.test.ts` | 2 | pass |
