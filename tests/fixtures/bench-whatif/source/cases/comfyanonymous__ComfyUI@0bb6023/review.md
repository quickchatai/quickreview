This PR broadens linting to cover the full Pyflakes rule family. The lint configuration itself works as intended, but the cleanup breaks two standalone Colab launch options by removing imports they still use. Those notebook paths now fail in fresh runtimes, so changes are required before merge.

**Verdict: Changes requested** — 1 blocker.

_Lenses applied: pass-baseline (terra-med), pass-placement (terra-med), pass-backcompat (terra-med), pass-validate (sol-high)._

### Blockers

- `notebooks/comfyui_colab.ipynb:240` — **The alternative Colab launch cells fail in a fresh runtime** _(P1/0.99, pass-baseline + pass-placement + pass-backcompat)_

  Users selecting either alternative launcher get a `NameError` instead of a working tunnel or iframe. The localtunnel cell now imports only `threading` but still uses `time`, `socket`, `urllib.request`, and `subprocess`, while the iframe cell still uses `time` and `socket`; the only remaining imports are in the separate cloudflared launcher, which starts the server in the foreground and is not an unconditional setup cell. Each independently runnable launch option must import its dependencies itself or receive them from an unconditional setup cell.

---
_Reviewed by review-bot[bot]._
