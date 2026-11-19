# Set up QuickReview: steps for a coding agent

<!-- An agent reads this page from main, but its commands run the latest npm
release. Describe only what a release has: a verb, flag, host or output line
that is on main alone goes in with the release that ships it. -->

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
  `Ok to proceed? (y)` and waits. Ignore the `npm notice` and `npm warn`
  lines on stderr.
- Where qcr's own output names `qcr`, such as `qcr login`, run it as
  `npx -y @quickchatai/quickreview`, unless `qcr` is on the person's PATH.
- In Codex, every command here needs the network and writes outside the
  workspace: npm's cache, Codex's config, and QuickReview's data and state
  homes. Run each one with `sandbox_permissions: "require_escalated"` from
  the first call, and say why in one line. Do not try it in the sandbox
  first. The person sees an approval prompt for each command, unless they
  pick the option that stops asking for these commands. If Codex's approval
  policy is `never`, nothing can be escalated: give the person the commands
  of steps 3 to 5 to run in their own terminal.

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
you are, ask.

| You are     | `--to`        | The person types                         |
| ----------- | ------------- | ---------------------------------------- |
| Claude Code | `claude`      | `/qcr:review`, `/qcr:scan`, `/qcr:setup` |
| Codex       | `codex`       | `$qcr:review`, `$qcr:scan`, `$qcr:setup` |
| Copilot CLI | `copilot`     | `/qcr-review`, `/qcr-scan`, `/qcr-setup` |
| Cursor      | `cursor`      | `/qcr-review`, `/qcr-scan`, `/qcr-setup` |
| opencode    | `opencode`    | `/qcr-review`, `/qcr-scan`, `/qcr-setup` |
| Gemini CLI  | `gemini`      | `/qcr:review`, `/qcr:scan`, `/qcr:setup` |
| Antigravity | `antigravity` | `/qcr:review`, `/qcr:scan`, `/qcr:setup` |

If you are pi, skip steps 3 and 4. Run
`pi install npm:@quickchatai/pi-quickreview` instead: it needs pi 1.4.0 or a
later 1.x, and a review runs on the login pi already has. In step 6 the
person types `/qcr-review`, `/qcr-scan` or `/qcr-setup` after `/reload` or a
restart of pi
([In pi](https://github.com/quickchatai/quickreview#in-pi)).

If you are none of these, tell the person QuickReview has no plugin for you
yet, and point them at
[In your terminal](https://github.com/quickchatai/quickreview#in-your-terminal).

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
Its `ok` stays true on a skip, so read `outcome`.

- `installed` or `updated`: done, and `reload` is the line to keep.
- `skipped`: `detail` says why, such as `copilot is not on PATH`. The exit
  code is still 0 (Troubleshooting below).
- `failed` (exit code 1): `detail` is the host's own message. Show it as
  printed. If it reads as a sandbox or permission refusal, ask the person to
  allow the command, or to run it in their own terminal.

## 4. Check the model credential

```sh
npx -y @quickchatai/quickreview model --json
```

It prints one JSON object and makes no model call.

- `"ok": true`: a review can run. Run the same command once more without
  `--json`, and show the person its `model:`, `credential:` and `price:`
  lines as printed. They name the model, what a review spends on, and its
  price. If `route.ask` is true, several providers could run it, and the
  first review asks the person to pick one.
- `"ok": false` with `refusal.code` `"no-credential"` (exit code 1): there
  is no model credential yet. Give the person the two ways, and wait:
  1. Sign in with pi, in a terminal of their own:
     `npx -y @quickchatai/quickreview login`. It is interactive, so you
     cannot run it for them. pi opens; they type `/login` if it is not typed
     for them, pick a provider, sign in, and quit pi. When they are done,
     check again.
  2. Or keep a provider's API key in their environment, such as their shell
     profile, and restart you from a shell that has it. The restart ends
     this session, so give the hand-over (step 6) first. The same restart
     picks up the plugin, and after it the review command checks the
     credential itself.

  Any provider pi supports works, by subscription or API key. QuickReview
  never uses your own sign-in as a coding agent (Claude Code's, Codex's),
  only pi's.
- `"ok": false` with another code: show `refusal.text` as printed. It names
  the fix.
- `"ok": false` with an `error` field and no `refusal`: show `error` as
  printed.

## 5. Optional: preview a review

Free, and it starts nothing:

```sh
npx -y @quickchatai/quickreview review --preview
```

It prints what it would review against which base, the lenses, the model,
the price and a key, then the same as one JSON line. Show the person the
lines.

- On the default branch with no commits of its own it prints
  `nothing to review` (exit code 1). Skip this step, or, if there are
  uncommitted changes, preview those:
  `npx -y @quickchatai/quickreview review --uncommitted --preview`.
- `model: none (no model credential: …)`: no credential yet, as step 4
  found. The price is unknown until there is one.
- `model: none (…)` with another reason: show it as printed. It names the
  fix.

Never run `review` without `--preview` from this page: that starts a paid
review, and one whose estimate is under the limit starts without asking.

## 6. Hand over

Tell the person, briefly:

- How to pick up the plugin: the `To pick it up` line from step 3. The
  commands are not in this session before that.
- If step 4 found no credential, the sign-in comes first.
- Then type the review command from your row, inside the repository. A bare
  review reviews the branch's commits against the default branch. Asked for
  the uncommitted changes or a pull request, it reviews those instead. It
  shows the model, the plan and the price, and starts only on their go.
- A review is slow and costs money. On the one route whose price was
  measured, GPT-6.1 Sol through pi's ChatGPT sign-in, it took about two
  dollars and more than fifteen minutes per pull request. For their model,
  repeat the `price:` line from step 4 or 5 as printed. It gives the
  estimate, or says there is none and where a review stops, or that pi has
  no price for the model and only a time limit holds. On a subscription plan
  a review uses quota and adds no bill.
- It reads the code and runs none of it, and posts nothing to GitHub by
  default. If a QuickReview command fails later, the setup command from your
  row checks the install and the sign-in and names the fix.
- In Codex, a review needs network approval too, as these steps did.

## Troubleshooting

| What you see | What to do |
| --- | --- |
| `Need to install the following packages` and `Ok to proceed? (y)`, then nothing | Stop it, and run the same command with `-y`. |
| `EAI_AGAIN`, `ENOTFOUND`, `EROFS` or `Read-only file system` from npm | A sandbox blocked the network or the home folder. Run the command again with escalated permissions (in Codex, `sandbox_permissions: "require_escalated"`), or ask the person to run it in their own terminal. |
| `skipped: … on PATH` (Cursor's ends `, and there is no ~/.cursor`) | The installer finds a host by its command-line tool on PATH, and Cursor also by its `~/.cursor` folder. It found neither here. Tell the person what it looked for; once that is there, run step 3 again. |
| `no coding-agent CLI found (looked for …)` (exit code 0) | The same, for `--to all`. Name your host with `--to`. |
| `"<name>" is not a host qcr plugin installs into` (exit code 2) | A misspelled `--to`, or a host this release does not have yet. The last line of `npx -y @quickchatai/quickreview plugin --help` lists the hosts this release installs into. |
| `refusal.code` `"no-credential"`, or `model: none (no model credential: …)` | No model credential: step 4. |
| `model: none (…)` with another reason | Show it as printed. It names the fix. |
| `qcr login is interactive: run it in a terminal` (exit code 1) | You ran the sign-in yourself. Give the person the line instead. |
| `<folder> is not a git repository` | A review runs inside a repository. Ask the person where theirs is. |
| `nothing to review: <branch> has no changes against <base>` | The branch has no commits of its own. Skip the preview, or preview the uncommitted changes with `review --uncommitted --preview`. |

More: [plugin.md](plugin.md) on the plugin and its hosts, and
[llm-setup.md](llm-setup.md) on models, credentials and price.
