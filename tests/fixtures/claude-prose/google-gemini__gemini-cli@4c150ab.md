I found one real bug in this diff.

packages/cli/src/config/config.ts:372 — ACP mode (`--experimental-acp`) now loses the shell, edit and write tools.
- **Cause:** the change moved the "remove these tools when not interactive" logic into `loadCliConfig`, so it now runs for every caller, not just the non-interactive path.
- **Why ACP is hit:** it talks JSON-RPC over piped stdin and gets no prompt, so `shouldBeInteractive` comes out false. Without `--yolo`, `run_shell_command`, `replace` and `write_file` get added to `excludeTools`.
- **Effect:** the ACP peer never gets those tools, even though it has its own flow for asking the user's permission to run them.
- **Before:** the exclusion only ran in `loadNonInteractiveConfig`, which is reached after `runAcpPeer` has already returned, so ACP kept all three tools.

Otherwise the new `shouldBeInteractive` check in `config.ts` matches the one still in `gemini.tsx`, and `loadCliConfig` has no other callers.
