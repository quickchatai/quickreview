# Opening a session in pi

The engine hosts its sessions in-process, but pi's own interactive UI stays the
way to see how a review session looks and works. Two things keep that true: a
finished session opens in pi, and a round can run inside pi so it can be watched
live.

## What a round keeps

Every one-shot, bench and scan round keeps its sessions as pi JSONL (v3) files
under the run directory:

```
<round dir>/session/<time>_<id>.jsonl             the main session
<round dir>/lens-sessions/<lens run id>/*.jsonl   one lens pass (a retry adds a file)
<round dir>/open-meta.json                        what `qcr open` needs to start pi
<round dir>/lens-ledger.jsonl                     lens run id -> agent name
```

The round dir is `<run>/out` for `qcr review`, the case dir for the bench, and
the run's transcript directory for a scan (`scan/transcripts/<run>/`, one
`lens-sessions/<case>/` per case; a scan has no main session).

Lens sessions are kept on the engine lens route (`[pi] lens_runtime = engine`),
where the passes are SDK sessions. A native lens pass is a `pi` child process
that discards its session, and the tmux bot's lenses are unchanged. The bench
judge's session is not kept.

## `qcr open`

```
qcr open [RUN_ID | DIR | FILE.jsonl | scan[:RUN]] [--lens ID] [--write] [--print]
```

With no argument it opens the newest run that kept a session. `--lens` takes a
lens run id, its agent name or an unambiguous id prefix (a scan: the case).

The session is forked (`pi --fork`), so the finished one is never touched;
`--write` opens the session itself (`pi --session`). Pi starts with the
extensions the round had and none that posts: bash-guard, ledger-pin, our lens
tools and `cluster_findings` on a main session, bash-guard alone on a lens pass.
It runs on a private agent dir holding a refresh-blanked copy of your login (so
the open never rotates the login your own pi holds, and a login that expires
within 30 minutes is refused with the fix), and with no GitHub token in its
environment. `--print` shows the command without starting anything.

The kept JSONL resumes under the same session id, so the provider's prompt cache
prefix still matches (pi canary 8).

## `qcr open pr`

```
qcr open pr <N> [--round R] [--lens ID] [--print] [--json]
```

Opens the bot's own session for PR N. The session is on the box that hosts the bot,
so it is pulled first, and then forked here like any kept session: the box does no
work for it and nothing on the box is written.

- **Live.** The PR's newest `<root>/<session_dir>/pr-<N>/*.jsonl`, read over the TUI's
  runner (`[tui] ssh_host`, `container`, `sudo_docker`; `target = "local"` reads the
  same way with no ssh). One listing call, one read of the file to the size the listing
  measured, and `qcr why N --json` when `--round` asks for a round. The commands are
  `ls`/`stat`/`head`/`base64` only; a test runs the real scripts against a fixture root
  and asserts the root is unchanged and no script carries a write. A tail the bot was
  still writing is dropped, so pi never reads a torn entry.
- **Archived.** A PR closed for 14 days has no live file. The archive manifest
  and the newest transcript's gzip are read off the box, laid out as an archive root
  under the state home, and decompressed by `extractPr` (what `qcr archive extract` runs)
  with every byte checked against the sha256 the manifest records. A gzip that does not
  verify opens nothing.
- **The copy.** `<state home>/open/pr-<N>/session/<name>.jsonl`, mode 0444, byte-for-byte
  the box's file (so its header id is the bot's session id), with `open-pr.json` beside it
  recording the source, host, sha256 and when. A second pull replaces it.
- **`--round R`** keeps the session as it stood when round R finished: the header and every
  entry stamped up to that round's `finished_at` (a prefix of the file, so ids and parents
  are the bot's), minus a turn left asking for a tool whose result falls after the cut. It
  lands in `.../pr-<N>/round-<R>/`. A tmux-hosted bot keeps one session per PR with every
  round in it, which is why a round is a cut and not a file. A round still running, or one
  `why` does not list, is refused with the finished ones named.
- **`--lens ID`** opens a kept lens pass of the PR by run id or unambiguous prefix, from
  `<pr dir>/lens-sessions/<run id>/*.jsonl` (the layout above). A tmux-hosted lens pass is
  a child of the PR's session with no file of its own, so today the answer is "kept no lens
  sessions"; they appear once workers persist them (P8.3, D10), and their archive inclusion
  is P8.16. `--round` and `--lens` do not combine yet: nothing records a lens pass's round.

Pi starts with bash-guard alone: the bot's tools are the tmux era's `subagent` and
`launch_plan`, which this machine does not run, and posting is the daemon's. The login copy
and the GitHub-token-free environment are the ones above. `--write` is refused: a copy has
nothing to write back to. A fork gets a session id of its own, with the copy as its
`parentSession`; the copy itself resumes under the bot's id.

## `qcr review --debug-pi`

```
qcr review [target] --debug-pi
```

Runs the round inside pi's interactive UI. The route prepares the round as any
round is prepared (task files, system prompt, order), then starts pi with the
round's extensions and `extensions/debug-round.ts` in the lens tool's place, and
`/qcr-round` as its first message. That command launches the planned discovery
wave (the engine's job at round start, rule 9, never pass-validate) and then
sends the order. The lens passes are SDK sessions of that pi process on pi's own
HTTP dispatcher, so they show up in `lens_wave` as on any engine route.
`debug-round.json` in the round dir records the wave, when the order went out
and which dispatcher the lens host used.

It needs a terminal, posts nothing, and takes no cap or live log: you are the
watcher. When you leave pi the round is read like any other (outcome, findings,
price from the kept session and the lens ledger).
