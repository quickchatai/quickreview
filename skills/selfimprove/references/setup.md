# Setup questions

These questions run on the first run only, when there is no settings file yet. Ask them in this order, a few to a round. Each option should be short and say one thing. When there is a default, list it first. If the user doesn't pick, use the default and say that you did.

| Key | Question | Options (first is the default) |
|---|---|---|
| `scope` | Which findings get fixed? | `all` (every validated finding) · `min-severity:P2` · `min-severity:P1`. Before settling this, calibrate: show 5 findings from the first scan across tiers and ask "fix these?" Adjust `scope` until the user's answers match it. |
| `tdd` | Test first for behaviour fixes? | `required` (fails before, passes after; no test, no landing) · `preferred` (the fixer explains when it's skipped) · `off` |
| `review` | Who approves a fix before it lands? | `independent` (a separate reviewer, or a fresh-pass self-review when no subagents) · `rescan-only` (the delta re-scan is the review) |
| `land` | What happens to an approved fix? | `branch` (a branch per packet, left for the user) · `pr` (a PR per packet; PRs are opened only after this answer) · `merge` (fast-forward into the current branch once the integration build and tests pass) |
| `parallel` | Max fixers at once? | `1` · `4` · `8`. Ignored when the client can't delegate. Each parallel fixer gets its own `git worktree add <path>`. |
| `depth` | Scan depth for round 1? | `standard` · `deep` (more lenses and higher recall, at more cost) |
| `budget_usd` | Total scan spend cap for the whole loop? | A number. Show the first preview's price next to the question so the user has something to go on. |
| `ledger_dir` | Where does the ledger live? | `.selfimprove/ledger/` (gitignored) · a directory outside the repo · `docs/selfimprove/` (committed) |
| `no_touch` | Paths fixers never edit? | Default: vendored code and dated records. Detect candidates first (`vendor/`, `third_party/`, `*VENDORED*`, dated `docs/` records) and let the user add globs. |
| `git` | Commit identity and trailers? | `user-only` (no co-author trailers) · `with-trailer` |
| `scan_cmd` | How is the scan invoked? | `qcr scan` (it runs its driver in its own sandbox container) · a wrapper path around it |
| `build` / `test` | Commands that make a fix green? | Detect them from the package manifest, Makefile or CI config, and confirm with the user. |

Write the answers to `.selfimprove/settings.json`:

```json
{
  "scope": "all",
  "tdd": "required",
  "review": "independent",
  "land": "branch",
  "parallel": 4,
  "depth": "standard",
  "budget_usd": 60,
  "ledger_dir": ".selfimprove/ledger",
  "no_touch": ["vendor/**"],
  "git": "user-only",
  "scan_cmd": "qcr scan",
  "build": "npm run build",
  "test": "npm test"
}
```

Before writing `test`, check whether the suite flakes when it runs under parallel load. If it does, record a per-file rerun command too, as `test_file`, for example `timeout 300 npx vitest run <file>`.
