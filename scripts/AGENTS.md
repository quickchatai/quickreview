# scripts/ — the session posting shims

The PR sessions post to GitHub through three scripts that keep their seeded
names: `post-review.sh`, `approve-pr.sh` and `reply-thread.sh`. Each is
Node-only: one `exec node dist/src/ipc/postshim.js <review|approval|reply> "$@"`
and nothing else. The host a session runs on holds no GitHub credential and no
config; the client sends the result files' absolute paths and the round's
identity (`QCR_ROUND_NO`, `QCR_EXPECTED_HEAD`, `QCR_POSTING_KEY`) to the
daemon over the worker socket (`QCR_IPC_SOCKET`, capability from
`QCR_IPC_CAP_FD`), and without them it refuses. The daemon (`src/postops.ts`)
validates the paths, builds the intent and posts through the one
`MutationGate` with the install's `dry_run`, the posting-time guards
(`packages/pi-plugin/src/guards.ts`, `packages/pi-plugin/src/cigate.ts`) installed on it, and the receipt and outbox
(`src/posting-journal.ts`). There is no shell mirror of the guards any more:
the guards are tested once, through the gate, in `tests/guards.test.ts`, and
the client in `tests/post-shim.test.ts`. A new script that posts to GitHub does
not get a shell route; it is a new op on the daemon.
- `mint-token.sh` is the only credential source (App JWT → installation
  token, cached, single-flight). Never a personal token, never `GH_TOKEN`.
  The one personal credential is not GitHub access at all: `vm-ghcr-login.sh`
  (run by the owner, on the controller) gives the VM's docker its classic
  `read:packages` login for pulling the release images, and refuses any other
  scope. It never takes the token as an argument or env, and posts nothing.
- `cutover.sh <version>` is the owner's one-time cutover window (runbook
  sections C and D): resumable through a state file, a stop at every go, and
  the drain HELD after the release. Its stage 9 pauses every tracked PR but one
  (the operator's `qcr pause-pr`, recorded in the state file), lifts the drain
  on the owner's go, and resumes exactly those PRs once the owner has checked
  that one PR's first worker round. It never lifts the drain by itself and never passes a force flag;
  `tests/cutover-wizard.test.ts` drives it against stubbed ssh, deploy.sh and qcr.
- `vm-postcutover-cleanup.sh` is the owner's one-off cleanup after the
  cutover, run ON the VM as root (`ssh <vm> 'sudo bash -s' < scripts/vm-postcutover-cleanup.sh`).
  The dry run is the default and prints a plan key; `--apply <key>` removes
  exactly that plan and refuses a changed one. It removes the legacy and
  VM-built images, the allowlisted names of the old rsynced checkout and all
  but the newest three updater snapshots. It refuses unless `qcr-update status
  --json` says release, and keeps every `sandbox/` dir the installed updater
  names or any container mounts, the legacy runtime data, and (as the owner's
  decision) `state/openviking` and the rescued sidecar stores;
  `tests/vm-postcutover-cleanup.test.ts` drives it against a fake docker.
- `commit-verdict.sh` is sanctioned for sessions but posts nothing: it
  publishes a staged `verdict/<name>.tmp` onto `verdict/<name>` by
  one rename after checking it is one whole JSON object, so the daemon never
  reads a half-written verdict. It accepts only the two verdict-file name
  shapes and writes nothing outside `verdict/`; `mv` itself stays off the
  bash guard's allowlist.
