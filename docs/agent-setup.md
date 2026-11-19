# Set up QuickReview: steps for a coding agent

This page is for a coding agent that a person asked to set up QuickReview.
Follow the steps in order and run the commands as written, inside the
person's repository. At the end the person restarts or reloads you and types
one command to run a review.

QuickReview is an open-source AI code reviewer. Its plugin adds a review, a
scan and a setup command to you, each of which runs `qcr`, its command-line
tool from npm. A review runs on pi, a coding agent installed with it, and
signs in to a model provider of its own.

## Rules

- Ask the person before any step that signs in, spends money or writes to
  GitHub. No command here spends money or writes to GitHub, and the sign-in
  is theirs to do.
- Never ask the person to paste a key, a token or a password into this chat.
  Never read their credential files (pi's `auth.json`, `.env` files, a
  secrets folder), and never print a key.
- Pass `-y` to every `npx` call. Without it, on a terminal, npx stops at
  `Ok to proceed? (y)` and waits. Ignore the `npm notice` lines on stderr.
- In Codex, these commands need the network and write outside the workspace
  (npm's cache, Codex's config, QuickReview's data home). Ask the person once
  to run them with escalated permissions, and say why in one line.

## 1. Check Node

```sh
node --version
```

QuickReview needs Node 22.19 or later. If `node` is missing or older, stop.
Tell the person to install a current Node release (from nodejs.org or their
package manager), then to ask you again.

## 2. Pick your host

Your row's `--to` value goes in the install command, and its last column is
what the person types once the plugin is in. If you cannot tell which host
you are, ask. If you are none of these, tell the person QuickReview has no
plugin for you yet, and point them at the README's "In your terminal".

| You are     | `--to`        | The person types                         |
| ----------- | ------------- | ---------------------------------------- |
| Claude Code | `claude`      | `/qcr:review`, `/qcr:scan`, `/qcr:setup` |
| Codex       | `codex`       | `$qcr:review`, `$qcr:scan`, `$qcr:setup` |
| Copilot CLI | `copilot`     | `/qcr-review`, `/qcr-scan`, `/qcr-setup` |
| Cursor      | `cursor`      | `/qcr-review`, `/qcr-scan`, `/qcr-setup` |
| opencode    | `opencode`    | `/qcr-review`, `/qcr-scan`, `/qcr-setup` |
| Gemini CLI  | `gemini`      | `/qcr:review`, `/qcr:scan`, `/qcr:setup` |
| Antigravity | `antigravity` | `/qcr:review`, `/qcr:scan`, `/qcr:setup` |

## 3. Install the plugin

```sh
npx -y @quickchatai/quickreview plugin install --to <host>
```

It installs for the person's user, in every repository, in a few seconds.
(In Claude Code alone, `--project` limits it to this repository; add it only
when asked.) Success looks like this:

```text
Claude Code: installed at user scope, release <version>
  Type /qcr:review, /qcr:scan or /qcr:setup.
  To pick it up: restart Claude Code, or run /reload-plugins in a session already open.
```

`updated` in place of `installed` means an older release was there. Keep
the `To pick it up:` line for the hand-over. A further indented line is a
note for the person (such as how to remove an older QuickReview plugin):
show it, and run what it names only on their go. With `--json` it prints one
object whose `hosts` holds your row: `outcome`, `detail`, `reload`, `notes`.

- `installed` or `updated`: done, and `reload` is the line to keep.
- `skipped`: `detail` says why, such as `copilot is not on PATH`. The exit
  code is still 0, so read the outcome (Troubleshooting below).
- `failed` (exit code 1): `detail` is the host's own message. Show it as
  printed. If it reads as a sandbox or permission refusal, ask the person to
  allow the command, or to run it in their own terminal.

## 4. Check the model credential

```sh
npx -y @quickchatai/quickreview model --json
```

It prints one JSON object and makes no model call.

- `"ok": true`: a review can run. `route.spec` is the model, and
  `route.credential.label` names the credential (a login, or an environment
  variable's name, never its value). Tell the person both: a review spends
  on that credential.
- `"ok": false` with `refusal.code` `"no-credential"` (exit code 1): there
  is no model credential yet. Give the person the two ways, and wait:
  1. Sign in with pi, in a terminal of their own:
     `npx -y @quickchatai/quickreview login`. It is interactive, so you
     cannot run it for them. pi opens; they type `/login` if it is not typed
     for them, pick a provider, sign in, and quit pi.
  2. Or keep a provider's API key in their environment, such as their shell
     profile, and restart you from a shell that has it.

  Any provider pi supports works, by subscription or API key. QuickReview
  never uses your own login. When they are done, check again.
- `"ok": false` with another code: show `refusal.text` as printed. It names
  the fix.

## 5. Optional: preview a review

Free, and it starts nothing:

```sh
npx -y @quickchatai/quickreview review --preview
```

It prints what it would review against which base, the lenses, the model,
the price and a key, then the same as one JSON line. With no credential the
model line reads `model: none` and the price is unknown. Show the person the
lines. Never run `review` without `--preview` from this page: that starts a
paid review, and one whose estimate is under the limit starts without asking.

## 6. Hand over

Tell the person, briefly:

- How to pick up the plugin: the `To pick it up` line from step 3. The
  commands are not in this session before that.
- If step 4 found no credential, the sign-in comes first.
- Then type the review command from your row, inside the repository. A bare
  review reviews the branch's commits against the default branch. Asked for
  the uncommitted changes or a pull request, it reviews those instead. It
  shows the model, the plan and the price, and starts only on their go.
- A review is slow and costs money. On the one model whose price was
  measured, it took about two dollars and more than fifteen minutes per pull
  request. On any other model it shows no estimate and stops at a spend
  limit. On a subscription plan it uses quota and adds no bill.
- It reads the code and runs none of it, and posts nothing to GitHub by
  default. If a QuickReview command fails later, the setup command from your
  row checks the install and the sign-in and names the fix.

## Troubleshooting

| What you see | What to do |
| --- | --- |
| `Need to install the following packages` and `Ok to proceed? (y)`, then nothing | Stop it, and run the same command with `-y`. |
| `skipped: <command> is not on PATH` | The installer finds a host by its command-line tool, and this shell's PATH has none. Tell the person which command it looked for; once it is on PATH, run step 3 again. |
| `no coding-agent CLI found (looked for …)` | The same, for `--to all`. Name your host with `--to`. |
| `"<name>" is not a host qcr plugin installs into` (exit code 2) | A misspelled `--to`: use a value from step 2. |
| `model: none`, or `refusal.code` `"no-credential"` | No model credential: step 4. |
| `qcr login is interactive: run it in a terminal` | You ran the sign-in yourself. Give the person the line instead. |
| `<folder> is not a git repository` | A review runs inside a repository. Ask the person where theirs is. |
| `nothing to review: <branch> has no changes against <base>` | The branch has no commits of its own. A review needs some, or can take the uncommitted changes instead. |

More: [plugin.md](plugin.md) on the plugin and its hosts, and
[llm-setup.md](llm-setup.md) on models, credentials and price.
