---
name: qcr-setup
description: Check that QuickReview can run here (pi version, model login, git, GitHub credential) and set up this repo's QuickReview profile, with the /qcr-setup command. Use when a QuickReview command failed, the person asks whether QuickReview is set up, or they want the reviewer tuned to this repo.
---

# QuickReview: setup

QuickReview's checks are the `/qcr-setup` command of this pi. It checks the running pi's version, the model login the review runs on, git, and the GitHub credential a pull-request review reads with, and shows each check with how to fix it.

A slash command is the person's to type: you cannot run it yourself. Give the person the line to type:

```text
/qcr-setup
```

When a check fails, its line names the fix (for a missing login, pi's own `/login`). Help the person with that fix; never read or print a token or key yourself.

To tune the reviewer to this repo, the person types `/qcr-setup profile`: it hands you the brief for Setup, a survey of the repo, its review history and an interview, ending in the repo profile `.qcr/`. Follow that brief when it arrives. Do not write `.qcr/` before it does.
