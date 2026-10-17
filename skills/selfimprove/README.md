# selfimprove

This is a portable Agent Skill (agentskills.io format) that runs the review tool's whole-repo scan in a loop: scan, fix, review, re-scan, for N fix rounds. N defaults to 2. You need `qcr` on PATH, because the skill drives `qcr scan … --json`.

## Install

The skill is the whole `skills/selfimprove/` directory. Copy or symlink it into the location your CLI reads:

| CLI | Skill location | Invoke |
|---|---|---|
| Claude Code | `.claude/skills/selfimprove/` or `~/.claude/skills/` | `/selfimprove 3` |
| Codex | `.agents/skills/selfimprove/` or `~/.agents/skills/` | `$selfimprove 3` |
| opencode | `.agents/skills/` or `.claude/skills/` (also `.opencode/skills/`) | `/selfimprove 3` (`opencode/slash` metadata), or copy `commands/selfimprove.md` to `.opencode/commands/` |
| pi | `.agents/skills/` or `~/.agents/skills/` | `/skill:selfimprove 3`, or copy `commands/selfimprove.md` to `~/.pi/agent/prompts/` for `/selfimprove 3` |

`commands/selfimprove.md` is a thin prompt wrapper for clients that want a separate command file. It uses `$ARGUMENTS`, which every one of these clients supports.

## Subagents

The skill delegates fixers and reviewers when the client can (Claude Code, Codex, opencode, or pi with a subagent extension). Otherwise it works serially, and the review is a separate fresh pass over the diff.
