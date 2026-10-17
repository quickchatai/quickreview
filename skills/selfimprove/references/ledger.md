# Ledger

The ledger is the one place the user reads to see where the loop stands, so update it after every scan, verdict, review and landing. It lives in `ledger_dir` and holds these files:

- `LEDGER.md` has the following sections:
  - **Status** is a table with one row per packet per round: packet, findings, verdict counts, branch, review state, landed.
  - **Rounds** has one line per scan: round, cost, files covered, new, fixed, still open.
  - **Regressions caught** has one plain-language paragraph for each reviewer catch: what would have broken, and for whom.
  - **Log** holds timestamped one-liners.
  - **Where it stopped** is written when the loop ends or is paused: what is unfinished, and the exact next step.
- `fixes-explained.md` has one entry per landed fix:
  - **What was wrong**, including what it would have caused.
  - **Fix**.
  - **Proof**, meaning the test name and the re-scan result.

  Write each entry for someone who hasn't read the code.
- `NEEDS-OWNER.md` lists each finding left for the owner: the question, the options, and their trade-offs. Nothing listed here gets implemented.
- `dispositions/r<N>.md` has one line per finding: fingerprint, verdict, packet, reason. Review files sit beside it.

Every number in the ledger has to come from a command's output (`qcr scan status`, `findings`, the test runner). Don't estimate them.
