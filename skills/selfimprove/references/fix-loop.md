# Fix loop: one packet

## Fixer

Give the fixer these four things:

- the packet, meaning its findings with fingerprint, file, range and the scan's reasoning
- the settings
- this brief
- a worktree, made by `git worktree add ../<repo>-si-r<round>-<packet> -b selfimprove/r<round>-<packet> <base>`. `<base>` is the previous round's integration commit, or the starting HEAD in round 1. Link or install dependencies in it.

Line numbers in a finding can be stale, so locate the code by its content.

1. Read the flagged code and what calls it. Confirm the verdict, and downgrade it if the code proves the finding wrong. Downgrades go back in the disposition with a reason.
2. If `tdd` is `required` and this is a behaviour fix, write a test that fails on the current code and commit it, or note the commit. A comment-only or pure-refactor change doesn't need a new test. For those, the existing tests must stay green.
3. Make the smallest fix that removes the defect. Write comments that state what the code does, not why it changed. The why belongs in the commit message.
4. Run `build` and `test`. When `test_file` is set, rerun any failing file on its own before calling the failure real.
5. Commit with a plain message that names the finding fingerprint(s).

If a fix would change behaviour the repo's docs describe as intended, stop and mark it `needs-owner`. Do the same if it would trade one quality for another, such as precision for recall or speed for safety. Don't fix it.

**Done when:** each finding in the packet is fixed with its test, downgraded with a reason, or moved to `needs-owner`, and the branch builds and tests green.

## Reviewer

When `review` is `independent`, use a different agent from the fixer, or a fresh pass when you can't delegate. Its input is the diff, the packet, and the finding text. It does not get the fixer's notes.

Review adversarially:

- Does the fix remove the defect?
- Does the new test fail without the fix?
- What did the fix break? Check its callers, error paths, config, and paths the tests don't reach.
- Does it duplicate a helper another packet also touched?

End the review with `VERDICT: approve` or `VERDICT: changes-needed`, followed by numbered items.

If the verdict is changes-needed, send the items back to the fixer. Repeat until the reviewer approves. If a packet fails review three times, park it in the ledger and move on.

The fixer must stop committing once review has started. If it commits after that, the review covers a commit that is no longer the branch tip, so review the new tip again.

**Done when:** the review file `dispositions/r<round>-<packet>.review.md` ends with `VERDICT: approve`.

## Landing

- `branch`: leave the branch as it is and list it in the ledger.
- `pr`: push the branch and open a PR. The setup answer authorised this. From round 2 on, packets are based on the previous round's integration commit, so their PRs also carry the earlier rounds' commits. Open them as stacked on that round's PRs, or say so in the description.
- `merge`: merge into an integration worktree, run `build` and `test` there, and fast-forward the target branch only when everything is green. Land packets one at a time, and rerun the tests after each one, so a conflict between two packets shows up against the one that caused it.

Afterwards, remove the packet worktree, from the main checkout rather than from inside the worktree.
