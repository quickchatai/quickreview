---
status: accepted
built: yes. `src/actioncli.ts` runs gh only through `runGh`, over the closed list in `ghCallAllowed`, and `tests/action-install.test.ts` drives every install path against that list. The record was written before the code
---

# Setup writes through the person's own gh

`qcr action install` sets up the GitHub Action on a repository. It stores the
model key as an Actions secret, creates the trigger label when the label
recipe is picked, creates a branch, commits the workflow file to it, and opens
a pull request. Each of those is a GitHub write. They are made by the person's
own `gh`, on their command, after asking, and they do not go through the
`MutationGate`. This is a named exception to invariant 1 in
[`AGENTS.md`](../../AGENTS.md#invariants-an-agent-must-never-break), one
mutation gate, and it is closed.

## The decision

- **One function runs gh, over a closed list.** `src/actioncli.ts` runs `gh`
  only through one function, whose allowed calls are:
  - `--version` and `auth status`;
  - `secret list` and `secret set`;
  - `label create`;
  - `api` GET on `repos/R`, `repos/R/contents/…` and
    `repos/R/git/ref/heads/…`;
  - `api -X POST repos/R/git/refs`, which creates the branch;
  - `api -X PUT repos/R/contents/…`, which commits the workflow file;
  - `pr create`.

  Nothing else can be asked of it.
- **Every write is said and asked first**, unless the person passes `--yes`.
  A step that cannot be done prints the command for the person instead.
- **The secret's value never reaches argv.** `gh secret set` reads it on
  stdin, or gh asks the person for it on the terminal.
- **No other module of the app spawns gh for a write.** The home's gh calls
  are reads.
- **The bot's writes are unchanged.** A review, a comment, a label on a pull
  request and every other write the reviewer makes still go through the gate,
  on every surface: the daemon, `qcr review`, the plugin and the Action's own
  post.

## Why

- **The gate is the reviewer's.** It admits the mutations a review makes on a
  pull request, from a closed list of kinds, runs the posting guards over
  them, and in dry run records them instead of sending. Setting up a
  repository is not a review.
- **`dry_run` ships `true`.** Through the gate, a fresh install would record
  the secret, the branch and the pull request and send none of them, so
  `qcr action install` would do nothing on the install most people run it
  from. Moving `dry_run` is the operator's alone (invariant 6).
- **The person's own gh, on their command.** The person runs the command in
  their own terminal, sees each step and says yes to each write. The writes
  are made with their own credential, and they could make each one by hand
  with the same `gh` command. The installer saves the typing; it acts for
  nobody else. The onboarding wizard's label step stands on the same footing:
  it creates label definitions with the person's token, outside the gate,
  before any daemon exists ([docs/onboarding.md](../onboarding.md)).

## Considered options

- **Through the gate, with new mutation kinds** (a secret, a branch, a file, a
  pull request). Rejected. In dry run they would record and not send, so the
  install would need either to execute anyway or to join
  `APP_SELF_CONFIG_KINDS`. The first is refused for every ordinary kind. The
  second would grow a closed set meant for the app's own configuration with
  writes to a person's repository. And a kind that commits a file would put a
  push of repository content inside the reviewer's own list, which a reviewer
  must never have.
- **A local file only**: write the workflow into the checkout and print the
  rest. Rejected as the default. The person would still set the secret,
  create the label, commit, push and open the pull request by hand, which is
  the setup the installer exists to remove. It stays as `--local`, which
  writes the file into the checkout and prints the git steps.

## Consequences

- Invariant 1 in `AGENTS.md` names this exception and this record.
- The closed list is held by a fence: a test drives every install path with a
  fake `gh` and fails on any call outside the list. Adding `pr merge` to a
  path makes it fail.
- A new setup step that writes to GitHub is a change to this record: it joins
  the list with its own fence case, or it goes through the gate.
- The installer needs `gh` signed in with the `repo` and `workflow` scopes,
  and the person needs write access to the repository.
