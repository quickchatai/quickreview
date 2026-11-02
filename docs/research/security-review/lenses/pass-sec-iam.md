# `pass-sec-iam` — draft lens and design notes

Drafted 2026-11-02 for the security profile
([`../README.md`](../README.md) §3 and §11.1), as the new lens the synthesis
created for the platform grant graph ([`SYNTHESIS.md`](SYNTHESIS.md) §1,
[`COVERAGE-AUDIT.md`](COVERAGE-AUDIT.md) gap 1). Status: **proposal, nothing
built; red-teamed and precision-critiqued once** (revision 2, 2026-11-02;
see the critique log at the end). Part A is the lens file as it would ship
at `agents/pass-sec-iam.md`. Part B explains the design and is not shipped.

---

## Part A — the lens

```markdown
---
name: pass-sec-iam
description: Platform-grant review pass (security profile) — resolves each cloud IAM, federation, Kubernetes RBAC, Vault or host grant the diff adds, widens or un-guards to the weakest actor it admits and the strongest identity it confers.
tools: read, bash, grep, glob
---

{{include:prompts/pass-common.md}}

# Lens: privilege escalation in the platform grant graph

Apply to: IAM, trust and federation policies, role assignments, SA
bindings and directory roles (AWS, GCP, Azure, Entra) in any IaC or JSON;
Kubernetes RBAC, `aws-auth`, access entries, Argo CD and Flux objects;
Vault policies and auth roles; CI cloud-auth steps and platform settings as
code (`github_*` environments, rulesets, OIDC templates); database roles
(`GRANT` and role membership in migrations); sudoers, polkit, doas,
setuid/setcap and groups in Ansible, cloud-init, images and compose.

Every grant is an edge: **grantee pattern → permission → resource, under
conditions.** Per edge: **who is the weakest actor the pattern admits, and
what identity can they hold afterwards that they could not before?** That
difference is the *delta*. No delta, no finding. A removed grant is never a
finding; a removed narrowing control is.

## Worksheet — fill it in your notes before writing any finding

1. **Edges.** One row per statement, binding, trust, federated credential,
   auth role or sudoers/polkit rule the diff adds or changes, plus each
   removed `Condition`, `Deny`, boundary, `resourceNames`,
   `attribute_condition`, bound claim or `env_reset`. Resolve variables,
   `for_each` maps and local modules; a registry module, chart or values
   file outside the worktree is `?`, never a guess or a question.
2. **Resolve the grantee to the weakest actor.**
   - AWS: `Principal: "*"` on a role is any AWS account unless
     `aws:PrincipalOrgID`/`SourceAccount` binds it. A third party without
     `sts:ExternalId`, or a service principal without `aws:SourceArn`/
     `SourceAccount`, admits that party's other customers. Same-account
     `:root` is AWS's delegation: an edge only when a cited line gives a
     weaker principal `sts:AssumeRole` on `*` or on this role. Another
     account's `:root` is a question only when that account is outside the
     org or threat model and the role is I1.
   - CI federation: the issuer authenticates **every customer of the
     vendor**; only `aud` and `sub` narrow it. GitHub `StringLike`
     `repo:O/*` is the org, `repo:O/app*` admits `O/app-evil`, `repo:O/R:*`
     every branch, tag and PR. `ref:refs/heads/main` admits
     `pull_request_target`/`workflow_run` jobs only when a cited workflow
     with that trigger requests `id-token`. A
     `subject_claim_customization_template` keeping only `repository_owner`
     lets any org repo match. GitLab `project_path:G/*` is the group; HCP
     Terraform `organization:O:*` every workspace and `plan`; CircleCI with
     only `aud` the whole org. GCP WIF without `attribute_condition`, or one
     on a name claim instead of `*_id`; Entra FIC `matches` expressions.
   - Workload identity: IRSA needs `StringEquals` on both `:sub`
     (`system:serviceaccount:NS:SA`) and `:aud`. A Pod Identity
     association, GKE `PROJECT.svc.id.goog[NS/KSA]` member or AKS federated
     credential is held by anyone who can create pods in NS; GKE pools are
     project-wide, so that NS/KSA in any cluster of the project holds it.
   - A Cognito unauthenticated role is held by the internet (the enhanced
     flow's scope-down still leaves `s3:*`, `dynamodb:*`, `lambda:*`); with
     the classic flow on, a pool role trusted without `amr` is too. GCP
     `allAuthenticatedUsers`/`domain:`; Kubernetes `system:anonymous`,
     `system:(un)authenticated`, `system:serviceaccounts[:ns]`; an
     `aws-auth`/access-entry mapping of a widely held role. A node or
     instance role, the GCP default compute SA or a namespace's `default`
     SA is held by every pod or process there (E2).
   - Vault JWT `bound_claims_type = "glob"` or `*` in bound claims, k8s
     auth `bound_service_account_*` = `["*"]`; host `%users`, `ALL`, the
     app's service user, a polkit `YES` for a group, doas `permit nopass`.
3. **Resolve the permission to the identity it confers.** A power that
   grants a higher power **is** the higher one.
   - AWS → admin: `iam:CreatePolicyVersion`, `SetDefaultPolicyVersion`,
     `Attach*Policy`, `Put*Policy`, `AddUserToGroup`,
     `UpdateAssumeRolePolicy`, `CreateAccessKey`, `*LoginProfile`,
     `DeleteRolePermissionsBoundary`; `Allow` + `NotAction`/`NotResource`.
     `iam:PassRole` + compute (`ec2:RunInstances`,
     `ReplaceIamInstanceProfileAssociation`, Lambda, ECS, Glue,
     CloudFormation, CodeBuild, SageMaker creates) → the passed role.
     `kms:CreateGrant`/`PutKeyPolicy` → all the key protects. Org plane →
     every member account: Identity Center assignments and permission
     sets, the StackSets execution-role trust,
     `OrganizationAccountAccessRole`, `RegisterDelegatedAdministrator`.
   - **Writing what a stronger identity runs is that identity**, no
     PassRole needed: `lambda:UpdateFunctionCode`, `ssm:SendCommand`/
     `StartSession`/`CreateAssociation`, `ecs:ExecuteCommand`,
     `ec2-instance-connect:SendSSHPublicKey`, user data, launch template
     versions, `codebuild:StartBuild` (buildspec override),
     `sagemaker:CreatePresignedNotebookInstanceUrl`; write to S3, ECR or
     Artifact Registry objects compute pulls (code, scripts, images); GCP
     `setMetadata`/`setCommonInstanceMetadata` (SSH keys, startup
     scripts); deploying Functions, Run, Build, Dataproc, Dataflow,
     Composer or Workflows → the SA it runs as (default SAs: often Editor).
   - GCP: `setIamPolicy` on project, folder, org or SA; `iam.roles.update`
     on a role you hold; `actAs`, `getAccessToken`, `signBlob`, `signJwt`,
     `implicitDelegation`, `serviceAccountKeys.create` → that SA;
     `iam.workloadIdentityPools*` admin → every SA bound to the pool.
   - Azure/Entra: `roleAssignments/write`, `roleDefinitions/write`, Owner,
     User Access Administrator, RBAC Administrator without a condition →
     that scope; Contributor → each managed identity its VMs, Functions or
     Automation run as, and Key Vault data under access policies;
     `userAssignedIdentities/*/assign/action`,
     `…/federatedIdentityCredentials/write` (bring your own issuer). An
     app's or SP's **owner** adds a secret and acts as it. Privileged Role
     or Authentication Admin, (Cloud) Application Admin, Graph
     `RoleManagement.ReadWrite.Directory`, `AppRoleAssignment.ReadWrite.All`,
     `Application.ReadWrite.All` → tenant admin. A dynamic-group rule on a
     user-editable or guest attribute admits whoever sets it.
   - Kubernetes: `escalate`, `bind`, `impersonate` → any role; `*`; create
     pods or any pod controller → every SA, Secret and ConfigMap in the
     namespace (`kube-system` or a controller's: the cluster); `create
     secrets` → every SA there (the control plane fills a
     `service-account-token` Secret); `pods/exec|attach|ephemeralcontainers`;
     `get|list|watch secrets`; `nodes/proxy` `get` (exec in every pod on
     the node); `serviceaccounts/token`; CSR approval for
     `kube-apiserver-client`; `patch` on webhook configurations, namespaces
     (PSA labels) or `aws-auth`; hostPath PVs; OpenShift `use` on the
     `privileged`/`anyuid` SCC; `aggregate-to-admin|edit` carrying secrets
     or these verbs; tenant Ingresses with snippets on. **Write on what a
     privileged controller reconciles is the controller:** Argo
     `Application`/`AppProject` (`sourceRepos: '*'` with cluster
     resources), `argocd-cm`, `argocd-rbac-cm`, Flux `Kustomization`/
     `HelmRelease` without an enforced `serviceAccountName`, Crossplane
     claims, Kyverno `generate`, an Argo `Workflow` naming its own SA.
   - Vault: write on `sys/policy/*`, `sys/auth/*`, `identity/*`,
     `auth/token/create` → any policy.
   - Host → root: sudo `NOPASSWD` on a GTFOBins escape or a wildcard
     argument, `SETENV`, `env_keep` of `LD_PRELOAD|PYTHONPATH|PATH`,
     `!env_reset`, `(ALL, !root)`, `sudoedit`; setuid on an interpreter;
     `cap_setuid|setgid|dac_override|sys_admin|sys_ptrace|sys_module`;
     `docker`/`lxd`/`disk` group; a root cron, unit or `ld.so.preload`
     loading or globbing (`tar *`) a path a cited `chown`/`chmod`/
     `COPY --chown` hands a lower user, or a command without a full path.
4. **Conditions as written, not as meant.** Quote each condition, bound
   claim and Runas list. Traps: `StringLike` meant as `StringEquals`;
   `…IfExists` and `ForAllValues` pass when the key is absent;
   `StringNotEquals`/`Null` inverted; a duplicate HCL/JSON key (the last
   wins); PassRole without `iam:PassedToService` and a role ARN; a boundary
   not required by `iam:PermissionsBoundary` on create; Azure `notActions`
   is not a deny; ABAC on `aws:PrincipalTag`/`ResourceTag` binds no actor
   holding `sts:TagSession`, `iam:Tag*` or `ec2:CreateTags`; CEL
   `startsWith`, `contains`, `matches` are wildcards. Claims the attacker
   sets bind nothing: GitHub `workflow`, `actor`, `head_ref`, branch names;
   `ref:refs/tags/*` admits any writer unless a tag ruleset is cited.
5. **Shared identities.** One role, SA or credential reachable from two
   trust levels: PR `plan` and `main` apply (plan runs `external` data
   sources and providers: every PR author it runs for holds the role);
   workflow-level `id-token: write` inherited by PR jobs; a self-hosted or
   ARC runner, Atlantis, Spacelift or TFC agent whose cloud identity every
   accepted job holds (fork PRs too when its group allows public repos);
   one k8s SA across many deployments.
6. **Hunt the defeating control** and cite it: an explicit `Deny`, an
   enforced boundary, a condition binding org, repo id, ref or environment,
   `resourceNames`, an enforcing admission policy blocking the needed pod,
   `env_reset` without `SETENV`, `NOEXEC`. Environments, branch protection
   and rulesets managed in the repo are evidence: read them. SCPs, org and
   deny policies, protection managed elsewhere: a proof gap, never a
   refutation; one question per PR per guardrail kind, only for an edge
   that is P0/P1 without it.

## Evidence block (required in every finding's `evidence`)

    source:      <file:line> — <grantee as written> = <weakest actor>, trust: untrusted|tenant|operator|first-party
    boundary:    <actor> → <identity gained> at resource|namespace|env|account|org/cluster/tenant|host-root
    sink:        <file:line> — <action/verb/rule> on <resource> [conditions: <quoted> | none]
    path:        <edges, each file:line; "?" outside the repo>
    controls:    <conditions, boundaries, denies looked for, where, why they don't bind this actor>
    cwe:         CWE-<id>
    proof-gaps:  <smallest fact(s) that, if false, kill the finding>
    delta:       <what the actor holds now that it lacked>   ("none" ⇒ do not emit)

## Confirmed, plausible, excluded

- **Confirmed:** grantee, primitive and every condition cited, none binds
  the actor, `delta` non-empty. Anchor on the line that adds or widens the
  edge (a removed condition: its statement).
- **Plausible — a question naming the one fact** outside the repo ("Does
  an SCP cap this `repo:acme/*` trust? If not, any org repository assumes
  the deploy role."). Never for a gap the repo could close.
- **Exclusions (no finding, no question):**
  - `delta: none`. An admin grant whose grantee resolves exactly to the
    intended pipeline or operator subject (`StringEquals` on
    `repo:O/R:environment:prod` or `…:ref:refs/heads/main`, an exact FIC
    subject, a deploy SP with Contributor): the finding is ever the trust,
    never the power. CDK bootstrap roles as bootstrapped.
  - Execution-role trust for a service without a confused-deputy surface;
    service-linked roles; AWS-managed `ReadOnlyAccess`, `ViewOnlyAccess`,
    `SecurityAudit`; the default KMS key policy.
  - Scoped wildcards: `Resource: "*"` inside a key, queue or topic policy;
    actions with no resource-level support (`logs:CreateLogGroup`,
    `ecr:GetAuthorizationToken`, `cloudwatch:PutMetricData`, `xray:Put*`);
    `Describe*`/`List*` without secret contents; a prefix in one owned path.
  - An operator chart's RBAC for its own function (cert-manager on
    secrets, Argo CD's controller), even when bumped or added, unless
    bound to another subject or opened to tenants; `aggregate-to-view|edit`
    without secrets or escalation verbs; `system:authenticated` on
    `system:discovery`/`basic-user`.
  - Declared human admins and break-glass roles; operator-run bootstrap; a
    cloud image's default user with `NOPASSWD:ALL`; sudo, setuid or
    `docker` group in an image already running as root, `.devcontainer/`,
    CI runner or builder images.
  - Platform defaults the diff does not change (a new resource using a
    default SA is a change). Missing MFA or session limits; long-lived keys.
  - Setups no deploy path references (`examples/`, `test/`, kind,
    localstack, vulnerable fixtures). Never exclude by environment name.

## Severity — persona exposure × what is reached, never "unlikely"

Impact: **I1** admin of an account, project, subscription, org, tenant or
cluster that holds production data or trusts into production (unknown:
I1 with a `?`); root on a production host or node; any power to grant
oneself more there. **I2** can read production secrets or deploy
production code, short of admin; admin of an account shown isolated from
production. **I3** less. Exposure: **E1** outside the org — anyone, any CI
vendor or IdP customer, any AWS account, `system:anonymous`, a fork-PR
author whom a cited workflow or runner hands the identity. **E2** an
insider foothold — any org repo or branch, account principal, pod or
cluster user, the app's service user after an RCE, a human group the
threat model does not name as operator. **E3** a named operator role.

| | E1 | E2 | E3 |
|---|---|---|---|
| I1 | P0 | P0 | P1 |
| I2 | P0 | P1 | P2 |
| I3 | P2 | P2 | P3 |

Score each environment by its own blast; a `?` lowers confidence, never
the cell.

## Stay inside your lens

Reach, a plane with auth switched off, privileged containers, IMDS, and
`Principal: "*"`/`allUsers` on a **data** resource (on a role, SA or
identity it is yours): `pass-sec-infra`, which cites your row as its
`tamper` link. `allUsers` or `principal = "*"` on an invoker, an
`AuthType: NONE` endpoint: `pass-sec-authn-coverage`. Workflow
triggers, `GITHUB_TOKEN` `permissions:`, pinning: `pass-sec-supply-chain`.
Token verification, lifetime and rotation: `pass-sec-tokens`. Literal keys:
`pass-sec-secrets-data`. App roles, and a `GRANT` the app runs per request:
`pass-sec-privesc`. You report single
edges and one-hop resolutions (PassRole + compute, `actAs`, a `sub`
wildcard); joining your edge to another lens's foothold is
`pass-sec-exploit-chain`'s. `NONE` is the expected output when every edge
holds — say which you walked.
```

---

## Part B — Design notes (not part of the lens)

### B1. Planning triggers

Profile: `security`. Planned **on trigger** in review. Synthesis §4
estimates 2–5 % of web-app PRs and 30–50 % of infra-repo PRs (not
measured; M25 measures it). In **scan** it joins the deep floor when the
stage-0 inventory finds an IAM, trust, federation, RBAC or sudoers
resource, and it is force-planned when the threat model (M21) lists a
crown jewel held by a cloud or cluster identity.

**Two deterministic daemon checks come first** (M22 gate notes; parsing
only, no code runs):
- *Escalation-primitive table:* parse added or changed policy statements
  (JSON, `aws_iam_policy_document`, CDK `PolicyStatement`) and RBAC rules
  and match them against a fixed table (B5); the note names each hit, so
  the model does not have to notice `iam:CreatePolicyVersion` inside a
  50-action list.
- *Federation without a subject:* a trust or provider naming a CI issuer
  (`token.actions.githubusercontent.com`, `gitlab.com`, `oidc.circleci.com`,
  `app.terraform.io`) with no `sub`/`attribute_condition`/subject, or a
  `StringLike` value ending in `*` before the repo separator; an EKS OIDC
  trust (`oidc.eks.*`) with `StringLike` on `:sub` or no `:aud`.

File scope: IaC and manifests (`*.tf`, `*.tf.json`, `*.tfvars`,
`*.template.{json,yaml}`, `template.y?ml`, `serverless.y?ml`, Pulumi
programs, CDK stacks under `{cdk,infra,infrastructure,deploy,stacks,lib}/`),
`**/{k8s,kubernetes,manifests,deploy,charts,helm}/**`, `.github/workflows/**`,
`.gitlab-ci.yml`, `.circleci/config.yml`, `**/*policy*.json`,
`**/*trust*.json`, `**/iam/**`, `**/sudoers`, `**/sudoers.d/**`,
`**/{ansible,playbooks,roles}/**`, `**/{cloud-init,user-data}*`,
`**/Dockerfile*`, `**/{docker-,}compose*.y?ml`, `**/*.service`,
`**/cron*`, `**/*.hcl` (Vault policies), `**/polkit-1/**`, `**/doas.conf`.
`.devcontainer/**` is out (the lens excludes it). Application sources are out: the `roles/` and `permissions/`
directories of an app belong to privesc's triggers, and Ansible `roles/` is
in only because content must also match.

Content regexes match **added and removed lines** (`^[+-]`, M12),
case-insensitive, except the condition-key line, which narrows rather than
grants and so fires on **removed** lines only (`^-`):

```
# AWS escalation primitives and wildcards
iam:(\*|PassRole|CreatePolicyVersion|SetDefaultPolicyVersion|Attach(User|Role|Group)Policy|Put(User|Role|Group)Policy|AddUserToGroup|UpdateAssumeRolePolicy|CreateAccessKey|(Create|Update)LoginProfile|(Delete|Put)\w*PermissionsBoundary|Tag(Role|User))
sts:(\*|AssumeRole\w*|TagSession)|lambda:(\*|UpdateFunction\w+|CreateFunction|AddPermission)|ssm:(\*|SendCommand|StartSession|CreateAssociation)|ec2-instance-connect:|ecs:(RegisterTaskDefinition|RunTask|ExecuteCommand)|glue:(Create|Update)DevEndpoint|cloudformation:(Create|Update)Stack|codebuild:(CreateProject|StartBuild)
ec2:(ReplaceIamInstanceProfileAssociation|CreateLaunchTemplateVersion|ModifyLaunchTemplate|ModifyInstanceAttribute|CreateTags)|kms:(\*|CreateGrant|PutKeyPolicy)|sagemaker:(CreatePresignedNotebookInstanceUrl|CreateNotebookInstance)
"?(NotAction|NotResource|NotPrincipal)"?\s*[:=]|"Action"\s*:\s*"\*"|actions\s*=\s*\[\s*"\*"
# principals, trust and the org plane
"(Principal|AWS)"\s*:\s*"\*"|AnyPrincipal|ArnPrincipal\(\s*["']\*|AccountRootPrincipal|:root["']|grantAssumeRole|grantPassRole
aws_ssoadmin_\w+|sso:CreateAccountAssignment|aws_cloudformation_stack_set|StackSetExecutionRole|OrganizationAccountAccessRole|RegisterDelegatedAdministrator
allow_unauthenticated_identities|AllowUnauthenticatedIdentities|cognito-identity\.amazonaws\.com
# removed lines only: conditions, boundaries and bound claims
^-.*(sts:ExternalId|aws:Source(Arn|Account)|aws:PrincipalOrgID|iam:PassedToService|iam:PermissionsBoundary|permissions_boundary|PermissionsBoundary|ForAllValues|ForAnyValue|StringLike|StringEquals|attribute_condition|bound_\w+|env_reset)
# federation and workload identity
token\.actions\.githubusercontent\.com|oidc\.circleci\.com|app\.terraform\.io|aws_iam_openid_connect_provider|OpenIdConnectProvider|WebIdentityPrincipal|FederatedPrincipal|:sub["']|:aud["']|client_id_list
attribute_condition|attribute_mapping|principalSet://|workload_identity_pool|federated_identity_credential|claimsMatchingExpression|IfExists
oidc\.eks\.|system:serviceaccount:|aws_eks_pod_identity_association|svc\.id\.goog|iam\.gke\.io/gcp-service-account|eks\.amazonaws\.com/role-arn|azure\.workload\.identity
id-token:\s*write|role-to-assume|workload_identity_provider|aws-actions/configure-aws-credentials|google-github-actions/auth|azure/login|^\s*[+-]\s*id_tokens:|CIRCLE_OIDC_TOKEN|runs-on:.*self-hosted
oidc_subject_claim_customization_template|include_claim_keys|github_repository_environment|github_(repository|organization)_ruleset|bypass_actors|github_branch_protection
# GCP and Azure/Entra
google_\w+_iam_(member|binding|policy)|roles/(owner|editor|iam\.\w+|resourcemanager\.\w+)|serviceAccount(User|TokenCreator|KeyAdmin)|workloadIdentityUser|setIamPolicy|actAs|allAuthenticatedUsers|setMetadata|setCommonInstanceMetadata|workloadIdentityPools
azurerm_role_(assignment|definition)|azuread_(app_role_assignment|application_federated_identity_credential|service_principal_delegated_permission_grant|directory_role_assignment|application_owner)|roleAssignments/write|roleDefinitions/write|User Access Administrator|Role Based Access Control Administrator|Privileged (Role|Authentication) Administrator|Application Administrator|RoleManagement\.ReadWrite|AppRoleAssignment\.ReadWrite|Application\.ReadWrite\.All|userAssignedIdentities/.*/assign|federatedIdentityCredentials/write|dynamic_membership|^\s*[+-]\s*owners\s*=
# Kubernetes RBAC, cluster access and reconciling controllers
^[+-]\s*kind:\s*(Cluster)?Role(Binding)?\b|kubernetes_(cluster_)?role(_binding)?(_v1)?|aws_eks_access_(entry|policy_association)|AmazonEKSClusterAdminPolicy|(bootstrap|enable)_cluster_creator_admin|aws-auth|mapRoles|mapUsers
\b(escalate|bind|impersonate)\b|nodes/proxy|serviceaccounts/token|certificatesigningrequests/approval|pods/(exec|attach|ephemeralcontainers)|(mutating|validating)webhookconfigurations|system:(masters|anonymous|unauthenticated|authenticated|serviceaccounts)|aggregate-to-(admin|edit)|clusterResourceWhitelist|sourceRepos|securitycontextconstraints
^[+-]\s*-\s*["']?(\*|secrets|nodes/proxy|escalate|bind|impersonate|use)["']?\s*$
argoproj\.io|argocd-(rbac-)?cm|kustomize\.toolkit\.fluxcd\.io|helm\.toolkit\.fluxcd\.io|kyverno\.io|crossplane\.io
# Vault
vault_(policy|\w*auth_backend_role)|bound_(claims(_type)?|subject|service_account_\w+|audiences)|sys/(policy|auth)|auth/token/create|identity/(entity|group)
# host grants
NOPASSWD|SETENV|env_keep|!?env_reset|visudo|\bsudoers\b|\(ALL\s*(:\s*ALL)?\s*(,\s*!root)?\)|setcap|cap_(setuid|setgid|dac_override|dac_read_search|sys_admin|sys_ptrace|sys_module|chown|fowner)|polkit\.Result\.YES|permit\s+nopass|ld\.so\.preload
chmod\s+(0?[467][0-7]{3}\b|[ugoa]*\+[rwx]*s)|usermod\s+-a?G|gpasswd\s+-a|adduser\s+\S+\s+(docker|sudo|wheel|lxd|disk)|groups:\s*.*\b(docker|sudo|wheel|lxd|disk|adm)\b|group_add|--group-add
```

The bare `\b(escalate|bind|impersonate)\b` and the `use` list item fire
only inside the file scope above (RBAC YAML, Terraform), never in
application code, where they are privesc's words. Dropped as too broad:
`Contributor` (every README of an open-source repo), `grant\w*\(` (CDK
grants on buckets are ordinary least-privilege), `roles:` (Ansible role
lists), bare `Condition`, `serviceAccountName` (every Deployment), the
`Kustomization` kind (every `kustomization.yaml`; the Flux apiVersion
group is matched instead). Dropped in revision 2: `assume_role_policy` and
`AssumeRolePolicyDocument` (every Lambda and ECS role; the principal and
federation lines still catch the dangerous trusts, and a new cross-account
role ARN without `ExternalId` is left to the M22 parse),
`aggregate-to-view`, condition keys on added lines, and the `2` in the
`chmod` class (setgid on shared directories).

### B2. Validator guidance

The validator re-derives each edge by reading. The rule that decides it:
**an edge is refuted only by a cited line, in the same environment, that
binds the actor out or caps the permission.**

| Claim | Verify by reading | Refutes (cite file:line) | NOT counterevidence |
|---|---|---|---|
| Grantee wider than meant | The trust/binding block with every condition, variables resolved | A `StringEquals` on `sub` (or `*_id` attribute condition, exact FIC subject) naming the intended repo and ref/environment; `aws:PrincipalOrgID`; `ExternalId`; `SourceArn` | The role name ("github-deploy-main"); a comment; "only our workflows know the ARN"; the PR text |
| Account-root trust | Same account: identity policies in the repo granting `sts:AssumeRole`. Another account: whether the threat model or org lists it | Same account: excluded unless a cited line gives a weaker principal `sts:AssumeRole` on `*` or this ARN. Other account: inside the org or threat model, or the role short of I1 → excluded | "Nobody in that account has AssumeRole" when the repo does show such a grant |
| Admin for the pipeline | The trust that admits the grantee | The trust resolves exactly to the intended pipeline or operator subject (`StringEquals` sub with environment or protected ref, exact FIC subject) → `excluded: same-principal` | "Admin is more than it needs" (least-privilege hygiene, not escalation) |
| Primitive → higher identity | The primitive's resource scope, the role/SA it can reach, that role's policy | Resource scoped to a role no stronger than the actor; `iam:PassedToService` plus a role ARN list; `resourceNames` excluding the powerful object | "PassRole needs a compute permission too" when the actor's policy grants one; "it is just a read" for `list secrets` |
| Condition bypass | Operator, key and value as written; duplicate keys | The operator and value as quoted exclude the attacker's spelling | "The intent is clearly main only" |
| Plan/apply sharing | The workflow triggers and the role each job assumes | Plan jobs on PRs assume a different, read-only role; apply runs only on protected refs with an environment the threat model says has reviewers | "Plan is read-only" (external data sources and providers execute) |
| k8s workload → SA | SAs and Secrets in the namespace; admission mode | An enforcing admission policy that rejects the pod and the namespace holds no SA stronger than the actor | PSA `warn`/`audit` (infra's fail-open list) |
| sudo/setcap → root | The binary's escape and the rule's arguments | A fixed full path, no wildcard, no `SETENV`, a binary with no escape in GTFOBins, `NOEXEC` where it holds | "Only ops use that account" when the app runs as it |
| Outside-repo cap | — | — | An SCP, org policy, deny policy or environment protection that is not in the repo: label `plausible`, name it in `proof-gaps` |

`delta: none` with evidence is `excluded: same-principal`, not refuted. A
grantee the validator narrows (E1 → E2) is re-scored by the matrix, not
killed.

### B3. Overlap and boundaries — what this lens absorbs

**Rule from the synthesis:** the lens whose fix closes the defect owns it.
A fix in a policy, trust, binding, sudoers file, group list or file mode is
this lens's.

Taken over from `pass-sec-infra` Part B ("handed to privesc"):
- GCP WIF providers with no `attribute_condition` → step 2 (federation).
- HCP Terraform, GitLab and CircleCI trusts with no org/project/workspace in
  `sub`; `StringLike "repo:org/app*"` matching `org/app-evil`; one role for
  `pull_request` plan and `main` apply → steps 2 and 5.
- `Allow` + `NotAction`/`NotResource`; trust in `…:root`; cross-account
  without `ExternalId`; service-principal resource policies without
  `SourceArn`/`SourceAccount`; `ssm:SendCommand`/`StartSession` on `*`;
  `lambda:UpdateFunctionCode`; `iam.serviceAccountUser` → steps 2 and 3.
- EKS `aws-auth` → `system:masters`; `create ingresses` for tenants → step
  3 (Kubernetes). Infra keeps the snippet and webhook-reachability halves.
- Ansible `groups: docker`; sudo on `systemctl`, `docker`, `tee` → step 3
  (Host).

Taken over from `pass-sec-privesc`'s cut third (critique log RT-13 and open
question 3): `lambda:UpdateFunctionCode` on an admin-role function,
`cloudformation:*` + PassRole, `patch` on `aws-auth` and
`mutatingwebhookconfigurations`, "creating a workload or editing code under
an identity is holding it" (step 3, AWS and Kubernetes); sudoers
`SETENV`/`LD_PRELOAD`, setcap, setuid, and a root cron or unit running a
lower-user-writable script (step 3, Host); the RT severity note that
workload-create in a cluster-admin namespace scores I1 (the "power that
confers a higher one" rule).

Taken over from `pass-sec-tokens` B3 ("infra owns who can obtain a
workload token: CI OIDC trust `sub`/`aud`"): **who can obtain** a workload
or federated token is this lens's; tokens keeps lifetime, rotation and
legacy SA token Secrets. Tokens' removed triggers (`id-token: write`,
`token.actions.githubusercontent.com`, `attribute_condition`,
`federated_identity_credential`) are in B1 here.

Remaining lines with neighbours:
- **`pass-sec-infra`** — owns reach, enforcement and runtime privilege
  (`privileged`, `hostPath`, `docker.sock`, IMDS, `automountServiceAccountToken`).
  Its `tamper` link and its "identity the reached workload hands over" cite
  this lens's row; it never re-derives an edge. Dedupe by anchor; iam wins
  on a grant line. `allUsers` on a bucket stays infra's (a public store);
  on a Cloud Run or function invoker it is `pass-sec-authn-coverage`'s (an
  endpoint auth cell, infra revision 3); `allAuthenticatedUsers` on a
  service-account role is this lens's.
- **`pass-sec-supply-chain`** — owns workflow triggers, `GITHUB_TOKEN`
  `permissions:`, unpinned actions, and `pull_request_target` checking out
  head code. This lens owns what the job's **cloud** identity admits.
  `pull_request_target` + OIDC + a `ref:refs/heads/main` trust is two rows
  (one each) and a chain.
- **`pass-sec-privesc`** — the application role model. Database roles are
  platform grants: SQL `GRANT` and role membership in migrations are this
  lens's; a request-time `GRANT` the application runs on a user's behalf
  is privesc's; an RLS tenant predicate is `pass-sec-access`'s, and RLS
  switched off on an exposed table is `pass-sec-authn-coverage`'s (the
  split privesc revision 3 proposes; pending the owner's ratification).
- **`pass-sec-tokens`** — as above.
- **`pass-sec-secrets-data`** — a key literal, `aws_iam_access_key` output
  in state, an SA key file committed.
- **`pass-sec-exploit-chain`** — consumes `source → boundary` rows. This lens
  resolves one primitive to its identity (PassRole + RunInstances → the
  role); a foothold from another lens (an SSRF, an RCE) joined to it is the
  chain's.
- **`pass-sec-toctou`** — a grant revoked while a session still holds it
  (k8s bound tokens, AWS role sessions outliving a trust change) is
  tokens'/toctou's, not here.

Revision 2 rulings:
- **`Principal: "*"`, `allUsers`, `allAuthenticatedUsers`:** on a data
  resource (S3, SQS, SNS, a KMS key policy, a bucket) → infra, or
  secrets-data for what the data is; on an invoker
  (`aws_lambda_permission principal = "*"`, Cloud Run) →
  authn-coverage; on a role, SA or identity → iam.
  The earlier B6 seed "`Principal: "*"` on a KMS key" moved to infra.
- **`pull_request_target`:** Part A keeps one clause (the trust admits
  those jobs only when a cited workflow requests `id-token`); trigger
  analysis stays supply-chain's.
- **Exploit-chain overlap:** the chain draft's "Pairs that compose" list
  (`pass-sec-exploit-chain.md`, cloud-identity bullet) names three
  single-hop items — PassRole + `RunInstances`/`CreateFunction`, GCP
  `serviceAccountTokenCreator`/`actAs`, and the OIDC `repo:org/*`
  wildcard. Under the ruling they are this lens's rows; the chain cites
  them as a hop and never emits them alone. The consistency pass
  (2026-11-02) edited that bullet to say so, closing open question 6.
- **Self-hosted runners:** who can schedule a job on a runner (fork PRs,
  runner-group `allows_public_repositories`) is supply-chain's trigger
  analysis; the cloud identity the runner holds and hands every job is
  this lens's step 5.

### B4. Motivating incidents and sources

Escalation catalogues:
- Rhino Security Labs, 21 AWS IAM escalation methods (CreatePolicyVersion, PassRole + compute, UpdateAssumeRolePolicy …): https://rhinosecuritylabs.com/aws/aws-privilege-escalation-methods-mitigation/ and https://github.com/RhinoSecurityLabs/AWS-IAM-Privilege-Escalation
- Rhino Security Labs, GCP privilege escalation (actAs, getAccessToken, setIamPolicy, deploy-as-SA): https://rhinosecuritylabs.com/gcp/privilege-escalation-google-cloud-platform-part-1/ (not re-fetched)
- Kubernetes RBAC good practices, "Kubernetes RBAC — privilege escalation risks" (secrets list, workload creation, PV hostPath, `nodes/proxy`, escalate, bind, impersonate, CSR approval, TokenRequest, webhooks, namespace patch): https://kubernetes.io/docs/concepts/security/rbac-good-practices/ ; RBAC escalation prevention: https://kubernetes.io/docs/reference/access-authn-authz/rbac/#privilege-escalation-prevention-and-bootstrapping
- GTFOBins (sudo, SUID and capabilities escapes per binary): https://gtfobins.github.io/

Primary documentation for each rule:
- AWS `iam:PassRole`: https://docs.aws.amazon.com/IAM/latest/UserGuide/id_roles_use_passrole.html
- AWS confused deputy (`aws:SourceArn`, `aws:SourceAccount`): https://docs.aws.amazon.com/IAM/latest/UserGuide/confused-deputy.html ; third-party `ExternalId`: https://docs.aws.amazon.com/IAM/latest/UserGuide/id_roles_create_for-user_externalid.html
- AWS `Principal` (account root delegates to the account's IAM): https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_policies_elements_principal.html ; `NotAction`: https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_policies_elements_notaction.html ; multi-valued keys (`ForAllValues` on an absent key): https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_policies_condition-single-vs-multi-valued-context-keys.html ; permissions boundaries: https://docs.aws.amazon.com/IAM/latest/UserGuide/access_policies_boundaries.html
- GitHub OIDC reference: `sub` formats, `pull_request` only without an environment, immutable owner/repo-id subjects for repositories created after 2026-07-15: https://docs.github.com/en/actions/reference/security/oidc ; "you must define at least one condition": https://docs.github.com/en/actions/how-tos/secure-your-work/security-harden-deployments/oidc-in-aws
- GitHub events: `pull_request_target` runs in the context of the default branch (`GITHUB_REF` = default branch): https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows
- GCP WIF for deployment pipelines: "you must use an attribute condition" for GitHub, GitLab SaaS and HCP Terraform; prefer numeric `*_id` claims over names (cybersquatting): https://docs.cloud.google.com/iam/docs/workload-identity-federation-with-deployment-pipelines
- GCP service-account impersonation roles: https://cloud.google.com/iam/docs/service-account-permissions (not re-fetched)
- Entra flexible federated identity credentials (`claimsMatchingExpression` with `matches` wildcards): https://learn.microsoft.com/en-us/entra/workload-id/workload-identities-set-up-flexible-federated-identity-credential
- Azure built-in roles (Owner, User Access Administrator, RBAC Administrator): https://learn.microsoft.com/en-us/azure/role-based-access-control/built-in-roles ; constrained delegation via assignment conditions: https://learn.microsoft.com/en-us/azure/role-based-access-control/delegate-role-assignments-overview (not re-fetched)
- EKS `aws-auth` deprecated in favour of access entries: https://docs.aws.amazon.com/eks/latest/userguide/auth-configmap.html
- Docker: the `docker` group "grants root-level privileges": https://docs.docker.com/engine/install/linux-postinstall/
- sudoers (`SETENV`, `env_keep`, `NOEXEC`): https://www.sudo.ws/docs/man/sudoers.man/ ; capabilities(7): https://man7.org/linux/man-pages/man7/capabilities.7.html

Incidents and research:
- Datadog Security Labs, "No keys attached" (2023): AWS roles trusting GitHub OIDC with no `sub` condition, assumable by any repository; the UK GDS case lost its `sub` check to a **duplicate HCL key**; AWS later blocked creating such trust policies but existing roles remained: https://securitylabs.datadoghq.com/articles/exploring-github-to-aws-keyless-authentication-flaws/
- Unit 42, "OH-MY-DC" (DEF CON 32, 2024): the CI vendor is the IdP, so every other customer passes authentication; missing or permissive federation policies and user-controllable claims (CircleCI): https://unit42.paloaltonetworks.com/oidc-misconfigurations-in-ci-cd/
- GitLab HackerOne #3137660 (2025): a fork's merge-request pipeline run in the parent received `sub` `project_path:<victim>:ref_type:branch:ref:main`, identical to a protected-branch push: https://gitlab.com/gitlab-org/gitlab/-/issues/548165 (fix status not stated on the issue)
- Sysdig TRT (Feb 2026): leaked keys → `lambda:UpdateFunctionCode` on a function with an admin execution role → new admin access keys in about eight minutes: https://www.sysdig.com/blog/ai-assisted-cloud-intrusion-achieves-admin-access-in-8-minutes
- Tenable "ConfusedFunction" (2024): deploying a Cloud Function ran a build as an over-privileged default Cloud Build SA (deploy-as-SA escalation); secondary: https://thehackernews.com/2024/07/experts-expose-confusedfunction.html
- Graham Helton / Horizon3.ai (2026): `nodes/proxy` `get` → exec in every pod on the node via kubelet websocket, maintainers treat it as intended: https://horizon3.ai/attack-research/when-read-only-isnt-k8s-nodes-proxy-get-to-rce/
- Aqua "RBAC Buster" (2023): anonymous API access with privileges → a ClusterRole + binding to a `kube-system` SA as a backdoor that survives disabling anonymous access, on 60 clusters; secondary: https://thehackernews.com/2023/04/kubernetes-rbac-exploited-in-large.html
- Midnight Blizzard (2024): a legacy test OAuth app with elevated access used to grant Exchange `full_access_as_app` (Graph/app-role grants as escalation): https://www.microsoft.com/en-us/security/blog/2024/01/25/midnight-blizzard-guidance-for-responders-on-nation-state-attack/ (not re-fetched)
- Terraform plan executes code (`external` data sources), so a PR-triggered plan role is held by the PR author: https://labs.snyk.io/resources/gitflops-dangers-of-terraform-automation-platforms ; https://www.pentestpartners.com/security-blog/terraform-token-abuse-speculative-plan/
- Added in revision 2 (fetched 2026-11-02 unless marked):
  - AWS condition operators: `…IfExists` — "If the key is not present,
    evaluate the condition element as true"; `ForAllValues` "returns true
    if there are no context keys in the request": https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_policies_elements_condition_operators.html
  - EKS IRSA trust: `StringEquals` on `:aud` (`sts.amazonaws.com`) and
    `:sub` (`system:serviceaccount:NS:SA`); the doc itself shows switching
    to `StringLike` with `*` to admit a whole namespace: https://docs.aws.amazon.com/eks/latest/userguide/associate-service-account-role.html
  - GKE Workload Identity, identity sameness: the pool is
    `PROJECT_ID.svc.id.goog`, "IAM doesn't distinguish between the clusters
    making the calls", and an untrusted cluster with a matching namespace
    gets the access: https://docs.cloud.google.com/kubernetes-engine/docs/concepts/workload-identity
  - Cognito identity-pool roles: `aud` (pool id) and `amr`
    (`authenticated`/`unauthenticated`) conditions; IAM now refuses to save
    a `cognito-identity.amazonaws.com` trust without `aud` (legacy roles
    remain, unmodifiable); the enhanced-flow guest scope-down still allows
    `s3:*`, `dynamodb:*`, `lambda:*`: https://docs.aws.amazon.com/cognito/latest/developerguide/role-trust-and-permissions.html
  - Kubernetes: a Secret of type `kubernetes.io/service-account-token`
    annotated with an SA is filled with a long-lived token by the control
    plane, so `create secrets` mints any SA's token: https://kubernetes.io/docs/reference/access-authn-authz/service-accounts-admin/ ;
    RBAC good practices on `escalate`, `bind`, `impersonate`,
    `nodes/proxy` ("**get** permission on `nodes/proxy` is not a read-only
    permission"), CSR approval, webhooks, namespace labels: https://kubernetes.io/docs/concepts/security/rbac-good-practices/
  - GitHub OIDC subject customization: a template "results in a new format
    for the entire `sub` claim"; `workflow`, `actor` and `head_ref` are
    claims describing the run, not its trust: https://docs.github.com/en/actions/reference/security/oidc
  - GitHub self-hosted runner security (forks of a public repository can
    run code on the runner): https://docs.github.com/en/actions/hosting-your-own-runners/managing-self-hosted-runners/about-self-hosted-runners#self-hosted-runner-security (not re-fetched; community summary https://github.com/orgs/community/discussions/26722)
  - Entra: Datadog Security Labs, "I SPy" — Application Administrator,
    Cloud Application Administrator or `Application.ReadWrite.All` → Global
    Admin by backdooring a first-party SP: https://securitylabs.datadoghq.com/articles/i-spy-escalating-to-entra-id-global-admin/ ;
    Semperis, service principal ownership abuse (an owner adds a client
    secret and acts as the SP): https://www.semperis.com/blog/service-principal-ownership-abuse-in-entra-id/
    (both from search results, not re-fetched)
- sudo CVE-2019-14287 (`(ALL, !root)` bypassed with `-u#-1`): https://nvd.nist.gov/vuln/detail/CVE-2019-14287 ; CVE-2023-22809 (`sudoedit` with extra files in `EDITOR`): https://nvd.nist.gov/vuln/detail/CVE-2023-22809

### B5. What a read-only reviewer cannot establish

- **Guardrails outside the repo:** SCPs and RCPs, GCP org policies and deny
  policies, Azure deny assignments and Management Group policy, GitHub
  environment protection rules and branch rulesets, Entra admin consent.
  These are the usual proof gaps. *Cover:* threat-model fields (M21) for
  "guardrails in force" — the SCP set, which environments require
  reviewers — filled once by the operator and read as fact.
- **The rest of the grant graph:** IAM managed in another repo, a console
  grant, SSO permission sets, who already holds `sts:AssumeRole`. Account-
  root trust is therefore usually `plausible` unless the threat model says
  the repo manages the whole account.
- **Effective permissions** after AWS policy evaluation (identity ∩
  boundary ∩ SCP ∩ session policy, explicit deny) are easy to misjudge by
  reading.
- **Live cluster state:** CRD-installed ClusterRoles, aggregated rules
  filled by the controller, what Helm renders with external values.
- **Platform settings not managed as code:** the GitHub OIDC sub-claim
  customization template (an org template keeping only `repository_owner`
  gives every org repo the same `sub`, so a trust on it admits them all),
  environment protection, tag rulesets, runner-group repository access.
  When `github_*` resources for them are in the repo they are evidence.
- **Other clusters and mounts:** GKE clusters elsewhere in the same
  project (they share the workload pool); Vault mounts and policies
  configured outside Terraform.

Deterministic pre-checks that cover part of this (parsing or simulation of
configuration — never executing the reviewed code):
1. **Primitive table** (M22, in the daemon): Rhino's 21 AWS methods, the
   GCP `actAs`/`getAccessToken`/`setIamPolicy` set, Azure
   `roleAssignments/write`, the Kubernetes good-practices verbs, and a
   GTFOBins list for sudo/SUID/capabilities, matched against parsed
   statements. Offline linters doing similar work, as references for the
   table: Cloudsplaining (privilege-escalation and data-exfiltration
   classes over policy JSON), PMapper (graph of who-can-become-whom), and
   the Checkov/Prisma IAM rules (`CKV_AWS_286` privilege escalation,
   `CKV_AWS_287` credential exposure; Cortex docs, not re-checked against
   Checkov's own index).
2. **Policy simulation, read from CI** (a new-dependency decision, like
   infra's): IAM Access Analyzer custom policy checks
   (`CheckNoNewAccess` against the base branch's policy,
   `CheckAccessNotGranted` for `iam:*`/`sts:AssumeRole`, `CheckNoPublicAccess`
   for resource policies), `aws iam simulate-custom-policy`; GCP Policy
   Troubleshooter/Analyzer; for Kubernetes, `kubectl auth can-i --list
   --as=system:serviceaccount:ns:sa`, `rbac-tool`, `kubectl-who-can` and
   Palo Alto's `rbac-police` over a rendered manifest set. Results enter as
   gate notes; the lens reads them as facts.
3. **An operator checklist** a plausible finding can name: `sudo -l` as
   the service user, `getcap -r /`, the SCP list, the environment's
   reviewers.

### B6. How to evaluate it

Seeded single-mutation corpus over clean IaC/cluster repos, one edge per
PR, each scored as a vulnerable/fixed pair:
- GitHub trust: `sub` removed; `repo:org/*`; `repo:org/app*`; `repo:org/app:*`
  for a prod role; `ref:refs/heads/main` with a `pull_request_target`
  workflow requesting the token; duplicate `StringEquals` key in HCL;
  missing `aud`.
- GitLab `project_path:group/*`; HCP Terraform `organization:o:*` on an
  apply role; CircleCI trust with `aud` only; GCP provider without
  `attribute_condition`; a condition on `repository_owner` name; an Entra
  FIC with `matches 'repo:org/*'`.
- AWS: PassRole `*` + `lambda:CreateFunction`; `iam:CreatePolicyVersion`
  on a policy the role holds; `NotAction: iam:*` with `Resource: *`;
  `Principal: "*"` on a role; cross-account `:root` trust from an account
  outside the org on an admin role; SNS → Lambda permission without
  `SourceArn`; one role for PR plan and main apply; `kms:PutKeyPolicy` on
  `*`; `ec2:ReplaceIamInstanceProfileAssociation` + PassRole `*`;
  `s3:PutObject` on the bucket holding Lambda code; a `…IfExists` condition
  on a key the request omits; ABAC on `PrincipalTag` with `sts:TagSession`
  granted; IRSA trust `StringLike` `system:serviceaccount:*:*`; a Cognito
  unauthenticated role with `s3:*`; a self-hosted runner whose instance
  profile is the deploy role; an Identity Center permission set edit.
- GCP `serviceAccountTokenCreator` to a CI SA on the project; a new
  instance group using the default compute SA that holds Editor (a diff
  change, not a platform default); a GKE `svc.id.goog[ns/ksa]` binding in a
  project shared with a tenant cluster; `compute.instances.setMetadata` for
  a developer group. Azure: a CI SP made User Access Administrator at
  subscription scope; RBAC Administrator without a condition; a CI SP
  added to an app's `owners`; FIC write on a user-assigned identity; a
  dynamic group on a guest-editable attribute.
- Kubernetes: `escalate` on clusterroles; `bind` on rolebindings;
  `impersonate` groups; `create pods` in `kube-system`; `list secrets`
  cluster-wide for a metrics agent; `nodes/proxy get`; `aws-auth` mapping
  the node role to `system:masters`; a ClusterRole labelled
  `aggregate-to-edit` with secrets; `system:authenticated` bound to `edit`;
  `create secrets` for a tenant; `use` on the `privileged` SCC; a tenant
  allowed to create a Flux `Kustomization` with no enforced SA; write on
  `argocd-rbac-cm`. Vault: JWT role `bound_claims_type = "glob"` with
  `sub = "repo:org/*"`; k8s auth `bound_service_account_names = ["*"]`.
- Host: `NOPASSWD: /usr/bin/vim`, `/usr/bin/python3`, `/bin/systemctl`;
  `SETENV`; `(ALL, !root)`; `setcap cap_setuid+ep` on python; Ansible
  `groups: docker` for the app user; a root cron running a script chowned
  to the app user; a polkit rule returning `YES` for a group; doas
  `permit nopass` for the app user.

Benign controls (all must be NONE): an execution-role trust for
`lambda.amazonaws.com`; `StringEquals` on `repo:org/app:environment:prod`;
PassRole scoped to one role with `iam:PassedToService`; the default KMS
key policy; `view` bound to a group; a Prometheus ClusterRole on
`nodes/metrics` only; cloud-init's default user with `NOPASSWD:ALL`;
`cap_net_bind_service` on a web server; a break-glass role the threat model
declares; a kind cluster's `cluster-admin` binding. Added in revision 2: a
new apply role with `AdministratorAccess` trusted by `StringEquals`
`repo:o/r:environment:prod`; a deploy SP with Contributor bound by an exact
FIC subject; CDK bootstrap roles; a same-account `:root` trust; `Resource:
"*"` in an SQS queue policy; `logs:CreateLogGroup` on `*`; attaching
`ReadOnlyAccess` or `SecurityAudit`; a cert-manager chart bump with its
secrets ClusterRole; a CRD operator's `aggregate-to-view`; the `docker`
group in `.devcontainer/`; sudo in an image whose process runs as root; a
PR that removes a grant. Sandbox-account admin with no prod trust scores
I2, not NONE, so it belongs in the severity check, not here.

Real pairs mined from public history (commits adding a `sub` condition,
scoping PassRole, removing `escalate`/`bind`, dropping a docker group),
replayed as the introducing PR. CloudGoat and KubernetesGoat are smoke
tests only. Score recall on P0/P1 first, then the question-to-finding ratio
and the benign false-block rate. No run without the owner's go.

### B7. Open questions for the owner

1. Is the platform-grant split final — this lens takes every item infra
   and privesc handed each other, and tokens keeps only lifetime — so the
   three sibling drafts' overlap sections can be edited to point here?
   (All four drafts now point here, after the 2026-11-02 consistency
   pass; the owner's ratification is still open.)
2. Should the primitive table (B5.1) be built before this lens ships, as a
   planning signal and gate note, in the same M22 module as infra's checks?
3. Host grants inside container images (`USER` plus a `NOPASSWD` sudoers
   in the image) matter only after an RCE in that container. Keep them at
   E2 here, or drop them unless the container is privileged (infra's)?
4. Read CI-rendered policy simulations (Access Analyzer, `rbac-tool`) as
   gate notes — the same new-dependency decision as infra's rendered
   artifacts, or separate?
5. Should the `pull_request_target` + OIDC + default-branch trust be
   force-planned for both this lens and `pass-sec-supply-chain`, so the
   chain lens always has both rows?
6. ~~Edit `pass-sec-exploit-chain.md`'s "Pairs that compose" so its
   single-hop cloud-identity items cite this lens's row?~~ Done in the
   2026-11-02 consistency pass (B3).
7. An account not known to be isolated scores I1 with a `?` (the
   precision critique wanted I2 by default). Keep, or add a threat-model
   field (M21) listing sandbox accounts so no default decides?
8. The E3 column now reads P1/P2/P3, unlike privesc's P1/P1/P2. Align
   the two, or keep platform operators a step lower?

### Critique log

Revision 2 (2026-11-02) answered one red-team and one precision critique.
Part A went from about 220 to 238 lines inside the lens block while adding
the variants below; the room came from folding the evidence block
(`actor`/`grant`/`gains` into `source`/`boundary`/`sink`, the CWE list
dropped), a one-clause description, dropping the GTFOBins binary list and
the step-2 `environment:` and `pull_request_target` prose, and moving the
data-resource boundary into "Stay inside your lens".

Accepted, red team: RT1 workload-identity bridges (IRSA, Pod Identity, GKE
pool sameness verified against the GKE doc, AKS); RT2 writing what a
stronger identity runs; RT3 shared CI executors (step 5); RT4 reconciling
controllers; RT5 Entra ownership, directory roles, dynamic groups, FIC
write; RT6 condition traps (`…IfExists` verified, ABAC with tag rights, CEL,
attacker-set claims, tag refs); RT7 first half, the unauthenticated role;
RT8 `create secrets` (verified: the control plane fills the Secret) and
SCC `use`; RT9 org plane; RT10 Vault; RT11 node and default identities at
E2; RT12 platform settings as code are evidence; RT13 polkit, doas, root
cron globs and `ld.so.preload`, restricted per precision to paths a cited
line hands a lower user; RT14 `kms:CreateGrant`/`PutKeyPolicy`,
`ReplaceIamInstanceProfileAssociation`,
`CreatePresignedNotebookInstanceUrl`; the B5 line on the OIDC template.

Accepted, precision: P1 pipeline admin with a tight trust and CDK
bootstrap; P2 the `environment:` sentence deleted, `ref:main` +
`pull_request_target` only with a cited workflow requesting the token; P3
same-account root excluded, cross-account a question only outside the org
and for I1; P4 scoped wildcards; P5 AWS-managed read-only policies; P6
operator chart RBAC, `aggregate-to-view|edit`, discovery bindings; P8
root images, devcontainers and builder images, the `2` dropped from the
`chmod` class; P9 Azure Contributor via FIC as P1's case, the "group,
managed identity, subscription scope" grantee line deleted; P10 a removed
grant is never a finding; the four read-only fixes (registry modules are
`?` with no question, writable paths only from a cited `chown`/`chmod`,
`pull_request_target` only with a cited workflow, one guardrail question
per PR per kind); the overlap rulings (B3); E2/E3 tie-break; I2's
production test; E1×I3 to P2; B1 trigger cuts; the B6 default-SA
contradiction.

Rejected or changed, with the reason:
- **RT7 second half (Cognito trust without `:aud`)** — IAM refuses to save
  a `cognito-identity.amazonaws.com` trust without an `aud` condition, and
  legacy roles that lack one cannot be modified, so no diff can add it.
  Replaced by the case a diff can add: with the classic flow on, a pool
  role trusted without `amr` is held by guests too.
- **RT8 `patch nodes`** (labels or taints that draw privileged pods) — the
  escalation needs a node foothold first, so it is two hops:
  `pass-sec-exploit-chain`'s, with this lens's row as one hop.
- **RT14 `aws_lambda_permission principal = "*"`** — who can invoke a
  function is an invoker's auth cell (authn-coverage under the B3 ruling); what the
  invoker gains depends on the function's code acting on input, which is a
  chain. Not added to this lens.
- **Precision P7, sandbox accounts capped at I2 by default** — kept the
  direction (admin of an account shown isolated from production is I2) but
  not the default: an account whose production reach is unknown scores I1
  with a `?`, because a missing fact lowers confidence, never the cell
  (README §4.3). Open question 7.
- **Precision, cut step 3 to the non-obvious resolutions "if M22 ships"**
  — M22 is not decided (open question 2), so the AWS/GCP/Azure primitive
  lists stay, compressed; only the GTFOBins binary list (which the model
  knows) and repeated detail went.
- **Precision, E3×I1 to P2** — met through the impact definition instead:
  non-production admin is now I2, so E3×I1 only covers production-reaching
  admin and stays P1; E3×I2 moved to P2 and E3×I3 to P3. Open question 8
  asks whether to align privesc's matrix.
- **Precision, edit the exploit-chain "Pairs that compose" list** — out of
  this revision's file scope; recorded in B3 and as open question 6.
