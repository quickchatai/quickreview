---
name: qcr-setup
description: Check that QuickReview can run here (the reviewer itself and the model login it reviews with) and show how to fix what is missing. Use when a QuickReview command failed, or the person asks to set up, install, fix or check QuickReview.
---

# Setting up qcr

QuickReview runs here as `qcr`, its command-line tool from npm. Setup checks two things in order and hands the person the exact command for whatever is missing. It installs nothing without their go, makes no model call, and is safe to run again.

## 1. A qcr that speaks the skills' contract

```sh
qcr --schema 1 version
```

`--schema 1` asks qcr for contract 1, the JSON these skills were written for.

- **It exits 0 and prints JSON:** the installed qcr is ready. `image.version` is its release.
- **`qcr` is not found:** there is no global install. Offer the person `npm i -g @quickchatai/quickreview` (it needs Node 22.19 or later) and run it only on their go. Until it is installed, every qcr call runs as `npx -y @quickchatai/quickreview@0.0.0-golden` in place of `qcr`, the release these skills came from: check that one with `npx -y @quickchatai/quickreview@0.0.0-golden --schema 1 version`.
- **It exits nonzero or prints anything but JSON:** the installed qcr is too old for these skills (one that does not print the contract exits 3 with nothing on stdout). Offer `npm i -g @quickchatai/quickreview` to bring it up to date, and meanwhile use the `npx` form above.

If the `npx` form fails as well, report its error as printed and stop.

## 2. A model login

A review runs on a model login kept by pi, the agent qcr runs its reviewers in, or on the provider's own API key in the environment. Check that a login is stored, without reading it:

```sh
test -s "${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/auth.json" && echo "login stored"
```

If none is stored and no provider API key is set, the login is the person's to do: it opens pi's own `/login`, which needs a terminal and a browser, so you cannot run it for them. Give them the one line to run in a terminal of their own:

- `qcr login` when qcr is installed globally;
- `npx -y @quickchatai/quickreview@0.0.0-golden login` when it is not.

A review that runs with no usable login is refused with an error that names `qcr login`; the fix is the same line. Never read or print a token or key yourself.

## Done

When both checks pass, say that QuickReview is ready and that a review starts with /qcr-review.
