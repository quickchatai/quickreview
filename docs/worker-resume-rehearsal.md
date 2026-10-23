# Worker resume rehearsal

At the cutover every open PR resumes in a per-round worker for the first time. This records the same resume done offline first: the real worker (`src/botworker.ts`) resumes a copy of each PR JSONL on pi-ai's faux provider, in the worker rig (a fake daemon on a real unix socket, a production-shaped root). No model, no network: the offline guard of `tests/worker-resume-rehearsal.test.ts` fails the run on any connection attempt, and the JSONLs themselves are only read (every one is copied into a scratch world that is deleted afterwards). Cost: $0.

Result: **every file in both transcript sets resumed with every check green.**

Re-run it: `scripts/worker-resume-rehearsal.sh <label>=<dir> ...` (see the script's header). The same resume check runs on the day inside the cutover preflight, on the library half of this rehearsal (`src/resumecheck.ts`).

## What is checked, per file

1. **Parse time**: our own pass over every line (`inspectSessionJsonl`), and pi's `SessionManager.open` + `buildSessionContext`, which is what a worker pays before its first request.
2. **The id is kept**: the resumed session's id is the header's id, the provider's cache key (`options.sessionId` of the request) is that id, and the file is the same file.
3. **Append-only**: no second JSONL appears beside it and every earlier line is byte-for-byte what it was.
4. **Cache prefix** (canary 10's concern, on real history): the request's system message is compared section by section (`preamble`, `project_context`, `cwd`) with the stored one, its tool schemas with the stored `toolsAdded`, and both with a session born in the same world. The reviewer stub (the context file that points a resumed session at its standing instructions) is looked for in the stored context file.
5. **Custom entries are tolerated**: the file's entry types, custom entries and the session-command / inject-bridge markers are counted, and the file resumed anyway.
6. **Legacy cwd headers** resolve under the release image's legacy mounts (read from `deploy/ansible/playbook.yml`), and the legacy paths the history mentions are split into those the image still has and those it does not.

**What an offline run cannot show.** The faux has no cache: it shows the bytes the prompt prefix is made of (the stored system message and tool schemas, replayed as they were, the provider session id unchanged), not a provider's cache hit. The tail the worker appends (the engine's tool announcement and the round order) is new text and is not cached on the first round.

Compaction is not run in the rehearsal (`compact: false`): it is one more provider call, and `tests/botworker.test.ts` holds it.

## Results

The rehearsal ran on two transcript sets, each a read-only copy:

- **recent**: the PR transcripts modified in the week before the run, which are the files the cutover resumes;
- **older**: interactive-pi transcripts from PRs that have since closed (the archiver's transcripts are these same bytes).

Every file in both sets passed every check:

| check | recent | older |
|---|---|---|
| worker exits 0 and resumes the file (not a new session) | all | all |
| the session id is kept (the header's id) | all | all |
| the provider cache key is that id | all | all |
| same file, no JSONL beside it, every earlier line byte-identical | all | all |
| the request replays the file's history | all | all |
| exactly one provider request (the faux's) | all | all |
| every line is JSON and the header is a v3 session | all | all |

| per file, median ms | recent | older |
|---|---|---|
| our JSON parse of every line | 21 | 25 |
| pi: SessionManager.open + buildSessionContext | 13 | 16 |
| the whole worker round on the faux (connect to exit) | 122 | 98 |

pi's open time grows with file size: a few milliseconds under 1 MB, tens of milliseconds between 1 and 10 MB, and a few hundred milliseconds above that. No file took longer than a second.

**Cache prefix, recent set.** pi stores the system message (prompt sections and tool schemas) as the first entry and replays it as it is. Every file carries one, and every one is sent with each section byte-equal to the stored one, so the prefix the old session cached against is unchanged. Against a session born in the same world, every file sends another system message and other tool schemas: they keep the old build's, which is what keeps the prefix.
The worker's tools that the file did not record (`lens`, `lens_wave`) are announced after the replayed history, in a system message of their own. Tools the files record that the worker's session does not register (the model may still try them): `launch_plan` and `subagent`. The stored preambles (standing instructions, frozen at the session's birth) still name `subagent`; the round order's engine section is what redirects the model to `lens` and `lens_wave`. Every stored context file matches the current reviewer stub, and the `cwd` section every old session was shown is `/opt/quickreview/sandbox`.

**Cache prefix, older set.** None of these files carries a stored system message (they were written before pi stored it): the worker builds the prompt fresh for them, so their prefix is the new build's and not the old session's. The worker's whole tool list is announced after the replayed history.

**Entries the worker had to tolerate** (all resumed): the entry types `message`, `model_change`, `session`, `session_info`, `thinking_level_change`, `custom`, `compaction` and `context_edit`; the custom review-ledger entries; and the `qcr-command`, `qcr-recheck`, `qcr-round`, `qcr-post` and `qcr-inject` markers in user turns. The session-command ledger's `qcr-command` turns and the inject bridge's `qcr-inject` turns are history: their writers are gone and the old turns stay.

**Legacy paths.** Every header cwd is `/opt/quickreview/sandbox`, which resolves as the parent of the release image's legacy mounts (`/opt/quickreview/sandbox/<clone>`, `/opt/quickreview/sandbox/wt`). Of the paths under it that the history mentions, `wt/...` is still mounted; `state`, `verdict`, `archive`, `commands`, `AGENTS.override.md` and the rest of the old production tree are not in the release image.

## What the cutover should know

- Every PR JSONL resumes in the worker under its own id, in its own file, append-only, with the provider's cache key unchanged. Parse time is a few milliseconds for most files and under a second for the largest.
- pi 1.3 stores the system message and the tool schemas in the file and replays them verbatim, so the resumed prefix is the old session's, not the worker's. What the worker adds (the engine's tools, `lens` and `lens_wave`) arrives after the replayed history, in a system message of its own: the first resumed round pays for that tail and the round order only.
- The stored system message and tool list also freeze what the old session was told. The file still advertises `subagent` and `launch_plan` (the native lens pair), which the worker does not register, and its preamble still says to launch passes as subagents. A call to either is a tool-not-found; the round order's engine section is what points the model at `lens` and `lens_wave`.
- Every header cwd is `/opt/quickreview/sandbox`, which the release image's container has only as the parent of the legacy mounts (`wt` and the base clone). It resolves, but the old production tree is not in it. Absolute `/opt/quickreview/sandbox/state/...` (and `verdict`, `archive`, `commands`, ...) paths that the history mentions do not exist in the image: those directories are under the app root there. `wt/...` paths still resolve through the legacy mounts. Relative paths resolve against the worker's cwd, which must be the app root.
- The `qcr-command` and `qcr-inject` turns of the session-command ledger and the inject bridge, and the custom ledger entries, are inert text and entries to the worker; deleting their writers does not touch the old turns.

## Canary 10 (cache-prefix parity with the interactive build, stub included)

Run beside the rehearsal, on the same tree. These start the real interactive `pi` in a pty over a loopback endpoint and compare the raw request bodies with the SDK build's.

| file | tests | result |
|---|---|---|
| `tests/pi-canary/canary-10-bot-request.test.ts` | 4 | pass |
| `tests/pi-canary/canary-10-oneshot-request.test.ts` | 2 | pass |
| `tests/pi-canary/canary-10-bare-request.test.ts` | 2 | pass |
