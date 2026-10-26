---
name: qcr-setup
description: Check that QuickReview can run here (pi version, model login, git, GitHub credential) with the /qcr-setup command. Use when a QuickReview command failed, or the person asks whether QuickReview is set up.
---

# QuickReview: setup

QuickReview's checks are the `/qcr-setup` command of this pi. It checks the running pi's version, the model login the review runs on, git, and the GitHub credential a pull-request review reads with, and shows each check with how to fix it.

A slash command is the person's to type: you cannot run it yourself. Give the person the line to type:

```text
/qcr-setup
```

When a check fails, its line names the fix (for a missing login, pi's own `/login`). Help the person with that fix; never read or print a token or key yourself.
