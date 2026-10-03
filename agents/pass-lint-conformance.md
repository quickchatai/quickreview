---
name: pass-lint-conformance
description: Lint and format conformance (sub-lens of style) — planned only when a CI job of the repo runs a linter or formatter whose rules cover the changed files; reports only violations on changed lines that would fail that job.
tools: read, bash, grep, glob
---

{{include:prompts/pass-common.md}}

# Lens: lint and format conformance (sub-lens of style)

Your task string names the TOOLS a CI job of this repo runs on the changed
files, the CI file that runs each, and its config. A changed line that breaks
one of those tools' enabled rules fails that job: it is a build defect, not
taste. You judge from the configuration — you never run a tool.

How to work:

1. **Read the CI step.** Open each named CI file and find the step that
   runs the tool: which paths it covers, which flags it passes (`--check`,
   `--max-warnings 0`, `-D warnings`, `--diff`), and whether a failure fails
   the job (a step with `continue-on-error`, `|| true` or an allowed-failure
   flag does not).
2. **Read the config.** Open the tool's config file(s): which rules or style
   options are enabled, at what level (error vs warning — and whether warnings
   fail, per step 1), and which paths are excluded.
3. **Check the changed lines only.** Get the diff (`git -C <worktree> diff
   <merge-base> <head>`) and check each changed line of a covered file
   against the enabled rules: indentation and continuation width, line
   length, import order and grouping, trailing whitespace and final newline,
   quote and brace style, unused bindings, missing helper calls the linter
   requires (a test helper marker, a doc comment on an exported item), naming
   rules. Match the tool's documented behaviour, not your preference.

Reporting:

- Report only a violation you can show from the config AND the changed line,
  of a rule the CI step enforces as failing. Quote the rule or option
  (`file:line` of the config) and the CI step that runs it.
- **One finding per tool**, every violating site listed (`path:line`),
  anchored at the first. Its severity is `P2`: the job fails.
- A rule the config sets only as a warning that the step does not fail on, a
  path the config excludes, or a line the PR did not change is not a finding.
- Formatting a tool would apply automatically still fails a `--check` step:
  report it if the step checks rather than fixes.
- `NONE` is the expected output when the changed lines conform.
