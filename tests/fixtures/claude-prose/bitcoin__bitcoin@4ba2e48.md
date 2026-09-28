I found two issues in `ae024137bd...4ba2e480ff`. The race is plausible but I haven't reproduced it; the missing dirty flag is confirmed from the code.

1. **Race during `InvalidateBlock` (`src/validation.cpp:3714`).**
   - **The problem:** The two new lookup maps (descendants to invalidate, and candidates for the best header) are built once, before the disconnect loop. The loop releases the `cs_main` lock between blocks, so headers that arrive in those gaps are missing from both maps. `CheckBlockIndex()` then runs before `InvalidChainFound`/`SetBlockFailureFlags` repairs the state.
   - **How it fails:** On regtest (where `-checkblockindex` is on by default), a peer sends a header whose parent is `pindex`, which is still connected and not yet failed. With the `m_failed_blocks` check gone, it is accepted. The next iteration disconnects `pindex`, but the child never gets a failed flag, so the new assert "invalid blocks and their descendants must be marked as invalid" fires.
   - **Second case:** If `m_best_header` becomes failed, it is recomputed from the stale map only. That can set it below a newly arrived valid header, which trips the new "no block with more work than `m_best_header`" assert.

2. **Status change never saved (`src/validation.cpp:3771`).**
   - **The problem:** The new loop that sets `BLOCK_FAILED_CHILD` on out-of-chain descendants, and clears `BLOCK_FAILED_VALID` from them, never adds those entries to `m_blockman.m_dirty_blockindex`.
   - **Effect:** A descendant that was already `BLOCK_FAILED_VALID` stays that way on disk after a restart, even though the code comment says it should be replaced with `BLOCK_FAILED_CHILD`. Every other status change in this function marks the entry dirty.

Summary:
- `src/validation.cpp:3714` — maps built before the loop miss headers that arrive while `cs_main` is released, so the new `CheckBlockIndex` asserts (failed-mask on descendants, work vs `m_best_header`) can fail before `SetBlockFailureFlags` fixes things up.
- `src/validation.cpp:3771` — descendants re-marked `BLOCK_FAILED_CHILD` are not added to `m_dirty_blockindex`, so the change is not written to disk.
