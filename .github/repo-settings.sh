#!/usr/bin/env bash
# The public repository's GitHub settings, applied with gh by a repository
# admin (docs/repo-settings.md says what each one is for and which ones stay
# manual). Idempotent: every call sets a value, none toggles one.
#
#   .github/repo-settings.sh [OWNER/REPO]           print the calls, change nothing
#   .github/repo-settings.sh [OWNER/REPO] --apply   make them
#
# It refuses a repository that is not public: the fork-PR approval policy and
# private vulnerability reporting exist only there, and half a lockdown reads
# as a whole one.
set -euo pipefail

REPO=quickchatai/quickreview
APPLY=false
for a in "$@"; do
  case "$a" in
    --apply) APPLY=true ;;
    -h | --help) sed -n '2,11p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) echo "unknown option: $a" >&2; exit 2 ;;
    *) REPO=$a ;;
  esac
done

visibility=$(gh api "repos/$REPO" --jq .visibility)
if [ "$visibility" != public ]; then
  echo "refusing: $REPO is $visibility; run this after it is public" >&2
  exit 1
fi

# One gh api call: printed always, made only with --apply. A JSON body comes
# on stdin.
call() {
  local method=$1 path=$2 body=${3:-}
  echo "$method ${path:-/}${body:+ $(printf '%s' "$body" | tr -s ' \n' ' ')}"
  $APPLY || return 0
  if [ -n "$body" ]; then
    printf '%s' "$body" | gh api -X "$method" "repos/$REPO$path" --input - >/dev/null
  else
    gh api -X "$method" "repos/$REPO$path" >/dev/null
  fi
}

# Merging: squash only, the PR title as the commit title and the commits as
# its body (the PR body carries the pasted self-review, too long for a
# commit message); merged branches are deleted. Forking on: every outside PR
# comes from a fork. No wiki: the docs live in the tree.
call PATCH "" '{
  "allow_forking": true,
  "has_wiki": false,
  "allow_squash_merge": true,
  "allow_merge_commit": false,
  "allow_rebase_merge": false,
  "squash_merge_commit_title": "PR_TITLE",
  "squash_merge_commit_message": "COMMIT_MESSAGES",
  "delete_branch_on_merge": true,
  "allow_update_branch": true,
  "security_and_analysis": {
    "secret_scanning": { "status": "enabled" },
    "secret_scanning_push_protection": { "status": "enabled" }
  }
}'

# SECURITY.md sends reports here; Dependabot alerts on the lockfile and opens
# the PR that fixes one.
call PUT /private-vulnerability-reporting
call PUT /vulnerability-alerts
call PUT /automated-security-fixes

# Actions: a workflow may use an action only by its full commit SHA (a moved
# tag cannot change what the release job runs; .github/dependabot.yml proposes
# the bumps), the default token reads only (every workflow that writes says so
# per job), Actions can never approve a PR, and no workflow run from an
# outside contributor's fork starts until a maintainer approves it.
call PUT /actions/permissions '{
  "enabled": true,
  "allowed_actions": "all",
  "sha_pinning_required": true
}'
call PUT /actions/permissions/workflow '{
  "default_workflow_permissions": "read",
  "can_approve_pull_request_reviews": false
}'
call PUT /actions/permissions/fork-pr-contributor-approval '{
  "approval_policy": "all_external_contributors"
}'

# main: no deletion, no force push; changes land through a squashed PR with
# one approval, the last push approved, threads resolved and CI green. A
# repository admin may bypass, which keeps the maintainers' direct pushes.
ruleset='{
  "name": "main",
  "target": "branch",
  "enforcement": "active",
  "conditions": { "ref_name": { "include": ["~DEFAULT_BRANCH"], "exclude": [] } },
  "bypass_actors": [ { "actor_id": 5, "actor_type": "RepositoryRole", "bypass_mode": "always" } ],
  "rules": [
    { "type": "deletion" },
    { "type": "non_fast_forward" },
    { "type": "pull_request", "parameters": {
        "required_approving_review_count": 1,
        "dismiss_stale_reviews_on_push": true,
        "require_code_owner_review": false,
        "require_last_push_approval": true,
        "required_review_thread_resolution": true,
        "allowed_merge_methods": ["squash"] } },
    { "type": "required_status_checks", "parameters": {
        "strict_required_status_checks_policy": false,
        "required_status_checks": [
          { "context": "test (26)" }, { "context": "pi-range (1.4.0)" },
          { "context": "image" }, { "context": "clone" } ] } }
  ]
}'
# A ruleset by name: updated when it exists, created when it does not.
upsert_ruleset() {
  local id
  id=$(gh api "repos/$REPO/rulesets" --jq ".[] | select(.name == \"$1\") | .id")
  if [ -n "$id" ]; then
    call PUT "/rulesets/$id" "$2"
  else
    call POST /rulesets "$2"
  fi
}
upsert_ruleset main "$ruleset"

# Release tags: a v* tag push runs release.yml (ghcr publish, the npm stage),
# and every org member can push to this repo, so only a repository admin may
# create, move or delete one.
upsert_ruleset "release tags" '{
  "name": "release tags",
  "target": "tag",
  "enforcement": "active",
  "conditions": { "ref_name": { "include": ["refs/tags/v*"], "exclude": [] } },
  "bypass_actors": [ { "actor_id": 5, "actor_type": "RepositoryRole", "bypass_mode": "always" } ],
  "rules": [ { "type": "creation" }, { "type": "update" }, { "type": "deletion" } ]
}'

# release-e2e holds RELEASE_E2E_PI_AUTH: a run reaches it only from main (a
# dispatched scratch run) or a v*.*.* tag, and only after the admin running
# this script approves the deployment (release.yml's "the owner as the
# required reviewer", which a public repo's plan supports). A real release
# cannot publish without its e2e, so this approval gates every publish.
reviewer=$(gh api user --jq .id)
call PUT /environments/release-e2e "{
  \"reviewers\": [ { \"type\": \"User\", \"id\": $reviewer } ],
  \"deployment_branch_policy\": { \"protected_branches\": false, \"custom_branch_policies\": true }
}"
have=$(gh api "repos/$REPO/environments/release-e2e/deployment-branch-policies" \
  --jq '.branch_policies[] | .type + ":" + .name' 2>/dev/null || true)
for want in branch:main 'tag:v*.*.*'; do
  grep -qxF "$want" <<<"$have" ||
    call POST /environments/release-e2e/deployment-branch-policies \
      "{ \"type\": \"${want%%:*}\", \"name\": \"${want#*:}\" }"
done

# The label the proposal issue form applies (.github/ISSUE_TEMPLATE/proposal.yml).
echo "label proposal"
$APPLY && gh label create proposal --repo "$REPO" --force \
  --color 1d76db --description "A change proposed before its pull request" >/dev/null

$APPLY || echo "(dry run: nothing changed; --apply makes these calls)"
