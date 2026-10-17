# selfimprove

This is a portable Agent Skill (agentskills.io format) that runs the review tool's whole-repo scan in a loop: scan, fix, review, re-scan, for N fix rounds. N defaults to 2. You need `qcr` on PATH, because the skill drives `qcr scan … --json`.

## Install

The skill is the whole `skills/selfimprove/` directory. Copy or symlink it into the location your CLI reads:

| CLI | Skill location | Invoke |
|---|---|---|
| Claude Code | `.claude/skills/selfimprove/` or `~/.claude/skills/` | `/selfimprove 3` |
| Codex | `.agents/skills/selfimprove/` or `~/.agents/skills/` | `$selfimprove 3` |
| opencode | `.agents/skills/` or `.claude/skills/` (also `.opencode/skills/`) | copy `commands/selfimprove.md` to `.opencode/commands/` for `/selfimprove 3`; otherwise ask for the selfimprove skill by name |
| pi | `.agents/skills/` or `~/.agents/skills/` | `/skill:selfimprove 3`, or copy `commands/selfimprove.md` to `~/.pi/agent/prompts/` for `/selfimprove 3` |

`commands/selfimprove.md` is a thin prompt wrapper for clients that want a separate command file. It uses `$ARGUMENTS`, which every one of these clients supports.

## Subagents

The skill delegates fixers and reviewers when the client can (Claude Code, Codex, opencode, or pi with a subagent extension). Otherwise it works serially, and the review is a separate fresh pass over the diff.

## Explicit invocation only

The skill spends money on scans, so it is meant to run only when you ask for it:

- **Claude Code and pi:** `disable-model-invocation: true` in the frontmatter stops them starting it on their own.
- **Codex:** `agents/openai.yaml` turns implicit invocation off.
- **Other clients:** they ignore both settings, and the skill body tells the agent to run only when invoked by name.

`disable-model-invocation` is a client extension, so a strict Agent Skills validator will flag it.

## Before you start

`qcr scan` must read this repository, through `[companion] reviewed_repo_dir` or `QCR_REVIEWED_REPO`. Its case runner also needs `pi` on PATH and logged in.
