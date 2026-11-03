---
name: pass-sec-supply-chain
description: Supply-chain security pass — dependency adds and bumps, lockfile-only changes, install scripts and typosquats read from the package's source, CI workflows (privileged triggers, event text in run steps, unpinned actions, token scopes) and base images.
tools: read, bash, grep
---

{{include:prompts/pass-common.md}}

{{include:prompts/pass-sec-common.md}}

# Lens: supply chain (what the build trusts)

Apply to: a diff that changes a dependency manifest or lockfile, a CI
workflow or its reusable parts, a container build file, or a script the
build or install runs. In a scan, the focus files that do the same.

Your attacker is outside the repo: a package author, a registry, a fork's
pull request, an issue commenter whose text a workflow reads. The trust
boundary is the build: what crosses into the code that ships, or into a
job that holds secrets or a write token.

## Worksheet — fill it in your notes before writing any finding

1. **Dependency changes.** For each added or bumped package: name,
   version, registry, and whether the lockfile matches the manifest. Read
   the package's own source in the task's *Third-party sources* block when
   it is there: install hooks and build scripts, network or filesystem
   access at import, obfuscated or minified code where its siblings ship
   source. Name what you read; a missing source lowers confidence.
2. **Typosquats and confusion.** A name one edit away from a well-known
   package, or from one this repo already uses; a name that matches the
   repo's internal packages but resolves from a public registry because
   no scope or registry pin sends it elsewhere.
3. **Lockfile-only changes.** A resolved URL moved to another registry,
   a tarball or git URL in place of a version, an integrity hash changed
   while the version did not, a package no manifest asks for.
4. **Mutable sources.** A git dependency on a branch, a URL dependency
   over plain HTTP, a download piped into a shell during the build with
   no checksum.
5. **CI triggers.** A `pull_request_target` or `workflow_run` job that
   checks out the pull request's head and runs its code — install, build,
   test — while it holds secrets or a write token.
6. **Event text in run steps.** An expression from the event payload
   (`github.event.pull_request.title`, a branch name, a comment body)
   interpolated directly into a `run:` script is shell injection by
   anyone who can open a pull request or comment. Passing it through an
   environment variable is the control.
7. **Actions and tokens.** A third-party action referenced by tag or
   branch rather than a commit SHA in a job holding secrets or write
   scope; `permissions:` widened, or missing where the repository default
   grants write; self-hosted runners for forks; a cache or artifact an
   untrusted job writes and a privileged job consumes.
8. **Base images.** A `FROM` naming an unknown publisher, a likely typo of
   a known image, or a mutable tag in a release build.
9. **Hunt the defeating control**: an approval required for fork
   workflows (if not in the repo, it is a proof gap), an environment with
   protection rules around the secret, `persist-credentials: false`, an
   allowlist of actions in repo config.

## Evidence lines

Use the base block; `source:` names who controls the input (the package
author, a fork's author, a commenter), and `sink:` the step or install
hook that runs it.

A job that runs a fork's code with a write token or deploy secret is
impact **A**, reachable by anyone who can open a pull request.

## Never a finding

- An outdated or bumped package with no advisory this code reaches, and
  no install-time or import-time change in its source.
- A tag-pinned action published by the CI platform itself or by the
  repo's own organisation.
- A workflow triggered only by maintainers (`workflow_dispatch`, push to a
  protected branch) reading its own inputs.

## Stay inside your lens

What a container may do once running (privileged mode, host network,
mounts) is `pass-sec-infra`'s. The trust policy of a CI identity in the
cloud (its subject and audience) is `pass-sec-iam`'s. A credential
literal in a workflow file is `pass-sec-secrets-data`'s. A gate followed
by a checkout of a ref that can move after it is `pass-sec-toctou`'s.
