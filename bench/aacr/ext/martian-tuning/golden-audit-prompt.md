# The Martian golden audit: the investigators' prompt

The audit behind `golden-audit-full.json` (the benchmark paper, §"What the
golden comments are"; the dataset's `martian_goldens.audit_bucket`) asked one
investigator per golden comment, an agent with read-only access to the
reviewed repository, never to any reviewer's output. A second, independent
investigator re-checked every golden the first did not confirm as a real
defect with high or medium confidence. The investigators were Claude Opus
5.5 agents. Each answered in the schema below; `golden-audit-full.json` holds
both answers per golden (`first`, `second`) and whether they agree.

Below is the prompt as it was sent. `<…>` marks what was filled in per
golden. Two values differ from the run: the case file's path, which was an
absolute path in the authors' checkout, and the bare repository's path, which
was a local cache of the public repository (any clone with both commits
does).

## The prompt

```text
You are an independent, adversarial auditor of ONE golden comment from the Martian code-review benchmark (a public benchmark whose answer key is known to contain some wrong or trivial items). <ROLE>

GOLDEN COMMENT (<PR url>, PR title "<PR title>"; labelled severity <severity>, category <category>):
"""<the golden comment>"""

CODE: bare git repo <repo>. Reviewed head commit <head>; merge-base <merge base> (the diff a reviewer sees is merge-base..head). Use the SHAs directly (named refs may be missing): git -C <repo> diff <merge base> <head>; git -C <repo> show <head>:<path>; git -C <repo> grep -n <pattern> <head>; git -C <repo> log --format='%h %s' <merge base>..<head>. The PR title/body is in bench/aacr/sets/martian50.json (case whose pr_url is <PR url>). Repos from github.com/ai-code-review-evaluation/* are benchmark copies where bugs may have been deliberately injected.

METHOD: (1) read the PR's diff and description; (2) locate exactly what the golden comment refers to; (3) build the STRONGEST case that it is a real defect the PR introduces or newly exposes: trace callers, routes, framework/library/language semantics (check the versions the repo pins), configuration and tests; (4) then judge honestly. Distinguish: REAL_DEFECT (as described, introduced or exposed by the PR); PARTLY_VALID (a real defect but the stated mechanism, impact or severity is substantially off); TRIVIAL (true but style/lint/nit/process, not a defect a careful reviewer must raise); LATENT (only a hazard for inputs or callers that do not occur); PRE_EXISTING (true but not introduced or worsened by the PR); INTENDED (the behaviour is the PR's deliberate purpose); NOT_A_DEFECT (the claim is false); UNVERIFIABLE (cannot be settled from the code). Read-only: no edits, no network, no other model runs. Do NOT read any reviewer's output or any earlier analysis files; judge from the code only. Be concise and concrete.
```

`<ROLE>` is, for the first investigator:

```text
Your job is to find out whether this golden comment describes a REAL defect.
```

and for the second:

```text
A first auditor did NOT confirm this golden comment as a real defect. Independently, try hard to prove it IS real; do not assume the first auditor was right.
```

The second investigator ran when the first answered anything but
`REAL_DEFECT`, or `REAL_DEFECT` with low confidence.

## The answer schema

| Field | Values |
|---|---|
| `verdict` | `REAL_DEFECT`, `PARTLY_VALID`, `TRIVIAL`, `LATENT`, `PRE_EXISTING`, `INTENDED`, `NOT_A_DEFECT`, `UNVERIFIABLE` |
| `severity_should_be` | `critical`, `high`, `medium`, `low`, `nit`, `none` |
| `confidence` | `high`, `medium`, `low` |
| `introduced_by_pr` | `yes`, `no`, `partly`, `unclear` |
| `evidence` | decisive evidence with path:line at the head commit and short quoted code; at most 150 words |
| `strongest_case_for_golden` | the best argument that the golden is right and whether it holds; at most 100 words |
| `reviewer_should_say` | what a careful reviewer should have posted, or "nothing"; at most 50 words |

The paper's section gives how the answers become the three buckets: real,
not real and disputed.
