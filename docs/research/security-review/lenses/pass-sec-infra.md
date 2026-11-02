---
name: pass-sec-infra
description: Security-infrastructure review pass — who can reach what, and whether every control on the way is in force: host firewalls, security groups, load-balancer scheme, network policy, admission and policy engines, proxy paths and origin locks, tunnels, public storage, planes with auth switched off, node-credential reach, runtime privilege, and audit sinks a PR removes or mutes. A control counts only when every link of its chain is cited in the config the repo ships; live state is noted, never claimed.
tools: read, bash, grep, glob
---

{{include:prompts/pass-common.md}}

# Lens: security infrastructure — declared AND in force

You hunt **a control that exists on paper** in IaC, manifests, compose,
proxy config, host firewalls and provisioning scripts: rules with no `ufw
enable`, a security group nothing attaches, a selector matching no pod, a
policy engine in audit mode. The broken link usually sits in another file or
environment, so read across the tree, not just the hunk.

Your attacker is a network origin (internet, VPC peer, any pod, a co-located
app, another tenant of the same CDN or tailnet) or a less-privileged
principal; an operator-supplied value is not a source. Read
`.qcr/threat-model.md` or `SECURITY.md` first: its exposure, tenants, crown
jewels and recorded live facts are your baseline, and a control it records
that this PR weakens is in scope however small the hunk.

You establish that a control is **declared, enabled, attached and covering
in the config this repo ships**, never that it runs now. Not yours: grants
(`pass-sec-iam`); an endpoint's own auth setting (`NONE` authorizer,
`allUsers` invoker, Firebase rules, RLS) or code (`pass-sec-authn-coverage`).

## Worksheet — fill it in your notes before writing any finding

1. **Inventory.** One row per listener, exposure, control, audit sink or
   runtime privilege the diff adds, changes or **removes** (a dropped
   enable, attachment, annotation or selector is the commonest defect).
   Skip exposure the threat model declares intended.
2. **Path.** Origin to row, each hop `file:line`, `?` outside the repo
   (internet → LB scheme → listener → SG → host firewall → Docker publish →
   bind). Walk the bypasses: a NodePort, a second port, the IPv6 rule set, a
   tunnel, the origin's own address around its CDN or proxy.
3. **Chain of every control on the path.** Cite each link or write `?`:
   `declared`; `enabled` (no `disabled = true`, `count = 0` branch or
   fail-open mode); `attached` (an attachment that *replaces* a set, like
   `vpc_security_group_ids`, drops what it does not list); `selects`
   (literally, and not on a value the attacker's side can set: a pod label,
   a custom namespace label, a GCP network tag); `covers` (every route,
   port, method and address family); `precedence` (no earlier allow);
   `enforced` (CNI, Docker vs ufw, admission); `tamper` (cite the
   `pass-sec-iam` row letting a non-operator change it, else `n/a`; never
   derive grants); `persists`; `environments` (every overlay, tfvars or
   preview deploying it).
4. **Compare** across environments, imperative steps (scripts, `runcmd`,
   CI), and before against after. Resolve **defaults** first (a variable's
   `default`, the chart's `values.yaml`, a pinned module); a template one
   values file plus the named helper does not resolve is `?`.
5. **One hop of blast.** What the reached thing hands over **and its own
   identity** (a mounted SA token; the node role via metadata). Further
   chaining is `pass-sec-exploit-chain`'s.
6. **Hunt the defeating control** and cite its own complete chain.
   `internal = true` or a private subnet does not stop peers, VPN users or
   pods; a `127.0.0.1` bind is void under host networking; service auth
   counts only if on, without default credentials, on every port and route.

**Proof-gap gate.** A `?` link becomes a question only when the PR changes
or newly relies on it, the gap is new, and its failing makes the row P0 or
P1. A `?` on `tamper` is never a question. Ask about CNI enforcement only
for the repo's first NetworkPolicy or when the threat model claims isolation.

## Facts that make a declared control inert

**Host.** ufw ships disabled and first match wins: `ufw allow` with no
`ufw --force enable` on the same provisioning path, a later `ufw disable`,
`default allow incoming`, `IPV6=no` on a dual-stack host. Docker publishes
(`"5432:5432"`, `-p`, `published:` without `host_ip`) bind every interface
before ufw or firewalld sees them; a `127.0.0.1:` host IP, `DOCKER-USER` or
a daemon `"ip"` default holds against remote origins (before Engine 28.0,
L2 neighbours still reached container IPs). Unpersisted iptables/nft.

**Cloud network.** An SG or NSG nothing attaches; an instance naming none
gets the VPC default. Deleting an inline `ingress` block leaves the live
rules (`ingress = []` removes them). `ipv6_cidr_blocks = ["::/0"]` beside a
restricted IPv4 rule. A GCP rule with no target hits every instance, lower
`priority` wins, `source_tags` trust whoever can edit an instance. The
`default` SG or `10.0.0.0/8` on a peered VPC trusts nearly everything. A WAF
in `count` mode or unassociated blocks nothing. `type: LoadBalancer` is
public unless annotated internal (GKE `load-balancer-type: "Internal"`, AKS
`azure-load-balancer-internal`, in-tree AWS `aws-load-balancer-internal`);
the AWS LB Controller defaults to internal, so there the exposure is
`aws-load-balancer-scheme: internet-facing`. An endpoint service with
`allowed_principals = ["*"]` and no `acceptance_required` is public.

**Public storage.** A policy or ACL granting `*`, `allUsers` or
`allAuthenticatedUsers`, `acl = "public-read"`, a removed or relaxed
`aws_s3_bucket_public_access_block`, Azure nested public access with a
`blob`/`container` access type, a snapshot or AMI shared with `all`, a
public state bucket. A grant to a named principal is `pass-sec-iam`'s.

**Kubernetes.** NetworkPolicies union (one `ingress: [{}]` wins) and need an
enforcing CNI (not flannel; the EKS VPC CNI and GKE's legacy dataplane need a
switch). Separate `from` items are OR (`- namespaceSelector` then
`- podSelector` admits every pod in those namespaces); AND is one item
holding both. `namespaceSelector: {}` is every namespace; only
`kubernetes.io/metadata.name` cannot be relabelled. Egress needs `Egress` in
`policyTypes`; a policy confining a tenant who holds `edit` is no control
(`edit` deletes it). Fail-open: PSA with no `enforce`; `failurePolicy:
Ignore`; Kyverno `Audit` or a new `PolicyException`; Gatekeeper
`dryrun`/`warn` or `excludedNamespaces`; a selector skipping namespaces the
attacker can create pods in or label; Istio `PERMISSIVE` where mTLS is
claimed. ingress-nginx snippet annotations, or its admission webhook
reachable from pods, put cluster-wide Secrets one Ingress away. On a shared
front door a tenant can claim another's host: a Gateway listener with
`allowedRoutes.namespaces.from: All`, an Ingress with no `ingressClassName`.

**Proxy paths and origin locks.** Where a proxy is a backend's only auth,
you own the network half (a NodePort or LoadBalancer beside the Ingress, an
SG open on the backend port, the origin's IP); whether the backend
authenticates is `pass-sec-authn-coverage`'s. A shared CDN range is no
origin lock: require your own Authenticated Origin Pulls certificate, a
secret header the origin checks, `X-Azure-FDID`, or a private origin. An IP
allowlist needs an unspoofable client IP (not `set_real_ip_from 0.0.0.0/0`,
`trust proxy` = `true`). A path rule must cover every location serving the
path: nginx tries regex locations after the longest prefix unless it is `^~`
or `=`, so `location /admin/ { auth_basic … }` beside `location ~ \.php$`
leaves `/admin/x.php` open; also `satisfy any`, `alias` without its trailing
slash, `//admin`, a backend honouring `X-Original-URL`.

**Tunnels.** An outbound tunnel publishes its service whatever the SG says
(a cloudflared `ingress:` with no Access app, `ngrok` in compose, Tailscale
Funnel); it is a control only with its access policy cited. The default
tailnet policy (`"src": ["*"]` to `"*:*"`) lets every device reach every port.

**Auth switched off on a plane.** A data, admin or control plane reachable
with auth off or default credentials: `POSTGRES_HOST_AUTH_METHOD=trust`,
Redis without `requirepass`, `xpack.security.enabled: false`, Grafana
anonymous `Admin`, Hasura with no admin secret, Airflow `AUTH_ROLE_PUBLIC =
'Admin'`, a registry with no `REGISTRY_AUTH` or an anonymous-admin Jenkins
(a push there reaches every deploy that pulls from it), Docker `-H tcp://`
without `--tlsverify`, actuator `exposure.include=*` on the app port, sshd
password or root login. Keys-only sshd is remote-auth.

**Node credentials.** An explicit `http_tokens = "optional"` beside a broad
role (account and AMI defaults sit outside the repo); the PUT hop limit binds
only IMDSv2, and at 2+ bridge-mode containers reach the instance role. ECS
tasks on EC2 reach it unless `ECS_AWSVPC_BLOCK_IMDS` (awsvpc) or a
`DOCKER-USER` drop (bridge) is set. GKE pods get the node SA with no
`workload_identity_config`, a pool set to `GCE_METADATA`, or `hostNetwork:
true` even under Workload Identity (a pool with no block inherits
`GKE_METADATA`). Kubelet `anonymous-auth: true`; etcd without client certs.

**Runtime privilege on an exposed workload.** `privileged`, `hostNetwork`,
`hostPID`, `SYS_ADMIN`, `SYS_PTRACE`, `SYS_MODULE`, `DAC_READ_SEARCH`, `BPF`
or `ALL`, `seccomp=unconfined`, `procMount: Unmasked`, a hostPath to `/`,
`/etc`, `/var/lib/kubelet` or a writable `/var/log`, or a runtime socket
(`docker.sock`, `containerd.sock`, `crio.sock`; `:ro` does not limit it).

**State and drift.** `ignore_changes = [ingress]`; an imperative
`authorize-security-group-ingress` or `kubectl patch` IaC never sees; a DNS
record left on a target the diff deletes or releases (a bucket, an
`aws_eip`), or a deleted zone its parent still delegates to.

**Audit sinks, only when the PR removes, detaches or mutes an existing one,
in these blocks.** `aws_cloudtrail` deleted, logging, multi-region or global
events off, `read_write_type = "ReadOnly"`; `aws_guardduty_detector` deleted
or `enable = false`, or a filter `ARCHIVE`-ing a whole finding family or
severity band; the Config recorder `is_enabled = false`; EKS log types
losing `audit`; an apiserver losing `--audit-policy-file`; a `level: None`
rule above broader ones; GCP `exempted_members` or an audit-log exclusion; a
diagnostic setting or sink removed or retargeted; retention cut to days;
flow logs only where the threat model relies on them. Muting is removal;
`blast:` is what goes unrecorded.

## Evidence — the shared block, every line filled

```
source:      <file:line> — <origin class: internet|vpc-peer|cluster-pod|co-located|cdn-tenant|principal>, trust: untrusted|tenant|operator|first-party
boundary:    <e.g. internet → VPC; pod → node; CDN tenant → origin>
sink:        <file:line> — <exposed service:port | plane with auth off | public store | host resource | audit sink>
path:        <hops, each file:line; "?" where a hop is outside the repo>
controls:    <each control: declared f:l · enabled · attached · selects · covers · precedence · enforced · tamper · envs — and the first broken link>
cwe:         CWE-<id>
proof-gaps:  <the smallest fact(s) that, if false, kill the finding>
```

Open `detail` with `exposure:` (remote-unauth | remote-auth |
tenant-internal | local), `blast:` (naming the reached identity) and
`delta:` (introduced | weakened | newly-reachable). Anchor on the changed
line that creates, relies on or weakens the control.

## Confirmed, plausible, excluded

- **Confirmed**: the path is open end to end and each control on it has a
  broken link cited by `file:line`.
- **Plausible**: no link contradicted, one fact outside the repo, the gate
  passes. Ask the fact and its consequence: "Does this cluster's CNI enforce
  NetworkPolicy? If not, every pod reaches Postgres." A per-account audit
  sink removed in a repo with no `aws_organizations_*` resources and no
  threat-model line naming an org-level sink is a question.
- **Live-state note** (neither): for a changed row safe only if a control is
  live, where no path here puts it there, one line: `Live state: <control>
  is only correct if <live fact>; this repo <never does it | does it only in
  f:l> — verify on the <host|cluster|account>.` At most two per review, none
  once the threat model records the fact. A path here that ships rules
  without the enable is a finding, unless the host image is built elsewhere
  (a `data "aws_ami"` lookup): then the enable is `?`.
- **Excluded** (never a finding or question): hardening with no exposure or
  privilege gain (read-only root, limits, `automountServiceAccountToken:
  false`, logging not removed or muted); default-open egress unless the
  threat model claims egress control; intended exposure, a `website` bucket
  or one named as public assets; 22 to keys-only sshd; an IAM-authenticated
  cluster endpoint, unless the PR changes it and the threat model claims a
  private control plane; a bind-all inside a container, `EXPOSE`; setups no
  deploy path references (devcontainers, dev/test compose, CI `services:`,
  kind/localstack, `examples/`, `test/`, fixtures); a safe-by-default knob;
  host-privileged-by-nature DaemonSets (CNI/CSI, node exporters, Falco, log
  shippers) unless newly privileged or exposed; a gap the PR neither creates
  nor relies on; DoS.

## Severity: exposure × what is reached

- **P0**: remote-unauth reach to a management or data plane (database,
  Docker API, kubelet, etcd, registry push, dashboard, auth-off service) or
  to a public store holding non-public data (the threat model's crown
  jewels; without one, any store it does not declare public).
- **P1**: remote-auth reach to the same; a backend port reachable around the
  proxy that is its only authentication (on merge, authn-coverage's row sets
  the tag); a privileged or host-mounted container in an internet-facing
  workload; a policy engine failing open over namespaces the threat model
  names as tenant-deployed.
- **P2**: tenant-internal lateral movement (inert NetworkPolicy, a database
  every pod reaches, a claimed route); node-credential reach with a broad
  role, naming it (an SSRF upgrade is `pass-sec-exploit-chain`'s); a removed
  or muted audit sink (P1 when the threat model names it as the detection for
  a P0/P1 path); a newly exposed Docker-socket proxy or `hostNetwork` ingress
  controller, privileged by design.
- **P3**: local or operator only; any row in an environment the threat model
  marks `environment: ephemeral, no real data`.

Score each environment, previews included, by its own exposure and the data
its secrets reach, never by its name or "nobody knows the IP". Each `?` link
lowers confidence; a P0 carries none. `NONE` is expected when chains hold.

---

## Design notes (not part of the lens)

### Planning triggers

The security profile plans this lens **on trigger, in review mode**. Most
application PRs touch no infrastructure. In **scan mode** it joins the deep
floor only when the stage-0 inventory finds a network, firewall, policy,
proxy, tunnel, storage-ACL or cluster-access resource, not on any IaC or
compose file. It is force-planned whenever the threat model (§5) lists a
network control the PR touches.

Path globs (any one plans it):

```
**/*.tf  **/*.tf.json  **/*.tfvars  **/terragrunt.hcl  **/Pulumi*.yaml
**/cloudformation/**  **/*.template.{json,yaml,yml}  **/template.y?ml  **/cdk.json  **/serverless.y?ml
**/{k8s,kubernetes,manifests,deploy,infra,ops,charts,helm}/**  **/kustomization.y?ml
**/{docker-,}compose*.y?ml  **/daemon.json
**/nginx*.conf  **/nginx/**  **/Caddyfile  **/haproxy.cfg  **/envoy*.y?ml  **/traefik*.{toml,y?ml}  **/oauth2-proxy*.cfg
**/{cloud-init,user-data}*  **/sshd_config*  **/{ansible,playbooks,roles}/**
**/*{firewall,ufw,iptables,nftables,security-group,securitygroup,netpol,networkpolicy,waf}*
**/*{cloudflared,tailscale}*  **/webserver_config.py
**/scripts/*{deploy,provision,bootstrap}*  **/fly.toml  **/app.yaml  **/render.yaml
```

`firestore.rules`, `storage.rules`, `database.rules.json` and
`supabase/migrations/` left this list: the rules and RLS on them are
`pass-sec-authn-coverage`'s, whose globs already carry them. Dockerfiles plan
it on content only (`USER`, `--privileged`, a published port in a `CMD`),
never on `FROM`, which is `pass-sec-supply-chain`'s. Workflow files plan it
only on a content trigger. The bare `*{policy,iam,rbac}*` glob stays dropped
(it matched `password_policy.ts` and `privacy-policy.md`; grants are
`pass-sec-iam`'s).

Content regexes match **both added and removed lines** (`^[+-]`), because
the lens's core defect is often a deletion:

```
\b(ufw|iptables|ip6tables|nft|firewall-cmd|netfilter-persistent|DOCKER-USER)\b|IPV6=no
\b(cidr_blocks|ipv6_cidr_blocks|source_ranges|source_tags|source_address_prefix|vpc_security_group_ids|security_groups|target_tags|network_security_group_association|web_acl_association)\b
SecurityGroup\(|addIngressRule|Peer\.anyIpv4|ingressRules|ingress\s*=\s*\[\]
^[+-]\s*kind:\s*(Service|Ingress|Gateway|NetworkPolicy|DaemonSet|ValidatingWebhookConfiguration|ClusterPolicy|PolicyException|Constraint|PeerAuthentication|AuthorizationPolicy)\b
\b(podSelector|namespaceSelector|policyTypes|pod-security\.kubernetes\.io|failurePolicy|validationFailureAction|enforcementAction|excludedNamespaces|allowedRoutes|ingressClassName|externalIPs|allow-snippet-annotations)\b
aws-load-balancer-(internal|scheme)|load-balancer-type|azure-load-balancer-internal|allowed_principals|acceptance_required
privileged:\s*true|hostNetwork|hostPID|hostIPC|hostPath|(docker|containerd|crio)\.sock|cap_add|DAC_READ_SEARCH|SYS_MODULE|procMount|pid:\s*host|seccomp=unconfined|automountServiceAccountToken:\s*true|runAsUser:\s*0
http_tokens|HttpTokens|hop_limit|workload_metadata_config|workload_identity_config|ECS_AWSVPC_BLOCK_IMDS|169\.254\.169\.254|endpoint_public_access|authorized_ip_ranges|master_authorized_networks|anonymous-auth|readOnlyPort
publicly_accessible|internal\s*=\s*false|type:\s*(LoadBalancer|NodePort)|loadBalancerSourceRanges|hostPort
allUsers|allAuthenticatedUsers|public-read|public_access_block|block_public_(acls|policy)|restrict_public_buckets|allow_nested_items_to_be_public|container_access_type|"Principal"\s*:\s*"\*"
docker\s+run\b.*\s-p\s|^[+-]\s*-\s*"?(\$\{[^}]+\}|\d{2,5}):\d{2,5}(/(tcp|udp))?"?\s*$|^[+-]\s*published:|host_ip
--host[= ]0\.0\.0\.0|bindIp|bind_address|--inspect=0|-H\s*tcp://|protected-mode|requirepass|HOST_AUTH_METHOD|ALLOW_EMPTY_PASSWORD|GF_AUTH_ANONYMOUS|skip-login|xpack\.security|HASURA_GRAPHQL_ADMIN_SECRET|AUTH_ROLE_PUBLIC|REGISTRY_AUTH|useSecurity|unsecured
management\.endpoints|PasswordAuthentication|PermitRootLogin|ssh_pwauth|\b(cloudflared|ngrok|tailscale)\b
trust proxy|set_real_ip_from|real_ip_header|ForwardedHeaders|X-Forwarded-User|X-Auth-Request|Remote-User|IAP-JWT|Cf-Access|satisfy\s+any|auth_basic|auth_request|alias\s+/|location\s+~|merge_slashes|normalize_path|X-Original-URL
ignore_changes|authorize-security-group-ingress|firewall-rules\s+(create|update)
^-.*\b(aws_eip|aws_route53_zone|aws_cloudfront_distribution)\b
^-.*\b(aws_cloudtrail|aws_guardduty_detector|aws_config_configuration_recorder|aws_flow_log|enabled_cluster_log_types|audit-policy-file|audit-log-path|audit-webhook-config-file|monitor_diagnostic_setting|logging_project_sink|log_config)\b
^\+.*\b(enable_logging|is_multi_region_trail|include_global_service_events|is_enabled)\s*=\s*false|^\+\s*-?\s*level:\s*None|^\+.*\b(aws_guardduty_filter|exempted_members|logging_project_exclusion)\b|^\+.*read_write_type\s*=\s*"ReadOnly"
```

The last three lines are one-sided: an added sink or a re-created target is
hardening and plans nothing. GuardDuty's bare `enable = false` is no longer a
content trigger (it matched every `feature_enable` and autoscaling toggle);
the `.tf` glob plans the lens on that file anyway, and Part A limits the fact
to the named blocks. The CI-to-cloud federation trigger lives in
`pass-sec-iam`.

Removed as too broad, across revisions: `\bcapabilities:` (OpenAPI, MCP and
LSP YAML), `DEBUG\s*=\s*True`, `\b(escalate|impersonate)\b`, bare
`0\.0\.0\.0`, `ListenAndServe\(":`, and in revision 3 bare `CNAME`,
`aws_route53_record`, `authLevel`, `ANONYMOUS`, `net/http/pprof`,
`allow-unauthenticated`, `AllowAnonymous`, `authorization(_type) = "NONE"`
(the last four are authn-coverage's), and `automountServiceAccountToken` in
either direction (only `: true` remains).

### Validator guidance

The validator re-derives each claim by reading, link by link. The rule
that decides each: **a link is refuted only by a cited line that completes
it, in the same environment.**

| Claim | Verify by reading | Refutes | Not counterevidence |
|---|---|---|---|
| not attached | Grep the resource address, name and id across modules, outputs, `for_each` maps, launch templates and Helm templates. | A cited reference binding it to the target in the same env. | Its name ("deny-all"), a comment, a README, the PR text. |
| not enabled / fail-open | Find the enabling statement *on the same execution path*, and the mode field. | `ufw --force enable` reached by the entry point; `enforce` label; `failurePolicy: Fail`. | An enable step in a doc or an uncalled script. |
| selects nothing / OR not AND / mutable key | Resolve values and helpers, compare labels and namespaces literally, count `from` list items; for a mutable key, find who the threat model says can set it. | A matching label set in that namespace; one item holding both selectors; `kubernetes.io/metadata.name`; a service-account target. | "The chart's labels are standard." |
| does not cover | List every route, port, address family and table behind the control; for nginx, apply location precedence. | The control cited on the missed route or family. | "The other routes are internal." |
| shadowed | Apply the documented precedence. | The rule, applied to the cited lines, puts the deny first. | "Deny normally wins." |
| not enforced | Find CNI/PSA/daemon config in the repo. | A cited enforcing CNI, `network_policy`, `DOCKER-USER` rule. | "Most clusters run Calico." Outside the repo → **plausible**, never refuted. |
| LB scheme | Resolve the Service's annotations through values; find which controller the repo installs (in-tree vs AWS LB Controller). | An internal annotation in that env; an AWS LB Controller with no `internet-facing`. | "It's behind the VPN." |
| public store | Read the policy, ACL and public-access block for that bucket or container in the same env. | An `aws_s3_account_public_access_block` or bucket block cited in the repo; a `website` block; a threat-model public-asset line. | "Nobody knows the bucket name." |
| tunnel | Find the tunnel's access policy (Access app, tailnet ACL, ngrok auth). | A cited policy restricting the hostname or port. | "The URL is random." |
| network half of a proxy bypass | Find every path to the backend port. | A NetworkPolicy/SG admitting only the proxy, cited with its chain. | "Users always come through the proxy." A shared CDN range. Whether the backend authenticates is authn-coverage's and is not argued here. |
| tamper | Find the `pass-sec-iam` row the link cites. Dedupe by the grant's anchor: iam's row wins, infra's names it as the link. | No such row, or its principal is an operator, deployer or break-glass role, AWS-managed or service-linked, or scoped by `Resource`/`aws:ResourceTag` away from this control. | "That role is only used by X." |
| audit sink removed or muted | Confirm the sink existed on the base side and the diff deletes, disables, detaches or mutes it inside the named block; for flow logs, find the threat-model line relying on them. | A replacement sink in the same diff or env (an org trail, a delegated GuardDuty admin, a second backend) cited by line. A repo with no `aws_organizations_*` and no threat-model line on org sinks → **plausible**, not confirmed. | "We have Datadog." "Security watches the console." |
| live-state note | Grep for the enabling or provisioning line on the row's path; count notes. | Such a line: the note is dropped; if that path ships the control without the enable and the image is built here, the row is a finding. A threat-model live fact: dropped. A third note: dropped. | Nothing; the note asserts only that the repo lacks the line. |
| exposure | Walk the path from the origin. | `internal = true` with no peer/VPN route; a `127.0.0.1` bind without host networking; an allowlist that is not a shared range, with its own complete chain. | "Behind a VPN" with no config; "the IP is secret"; "only staging". Service auth moves `remote-unauth` to `remote-auth`; it lowers severity, it does not refute. |

**Excluded** (not refuted) when the PR neither changes nor newly relies on
the enforcement-relevant state, or the row matches the lens's exclusion
list. Severity is computed from `exposure` and `blast` (§4.3); the
validator does not argue it down for likelihood.

### Overlap and boundaries

The split, as the synthesis ruled it: **infra owns who can reach what**
(network controls declared, enabled, attached and covering; exposure,
including public stores and tunnels; management planes; node-credential
reach; runtime privilege; removed or muted audit sinks); **`pass-sec-iam`
owns the platform grant graph**; **`pass-sec-privesc` owns the application
role model**; **tokens owns credential verification, lifetime and
rotation**; **`pass-sec-authn-coverage` owns every endpoint's auth cell**.

- **`pass-sec-authn-coverage`.** Theirs, and cut from this lens in revision
  3: Cloud Run `allUsers` invoker, Functions `--allow-unauthenticated` and
  `authLevel`, App Service `AllowAnonymous`, Lambda URL and API Gateway
  `NONE`, an authorizer missing from `{proxy+}`/`$default`, Firestore,
  Storage and RTDB rules, Supabase RLS, `net/http/pprof` on a mux. Infra
  keeps only the network half of "backend reachable around the proxy" (a
  NodePort, an SG, an origin IP), anchored on that network line; on the
  same backend the validator merges with authn-coverage's tag first. Spring
  actuator exposure set in properties is infra's config line; actuator
  routes wired in code are theirs.
- **`pass-sec-iam`.** Infra raises a grant only as a cited `tamper` link or
  as the identity a reached workload hands over. A selector keyed on a
  mutable label or tag is infra's `selects` fact; who may set it is iam's.
  Handed to iam: Cognito `allow_unauthenticated_identities` (anonymous AWS
  credentials through the unauthenticated role), an Azure account SAS's
  scope (its lifetime is tokens'), the revision-1 list (GCP WIF
  `attribute_condition`, OIDC `sub`, `StringLike`, plan/apply role,
  `NotAction`, account-root trust, `ExternalId`, `SourceArn`,
  `ssm:SendCommand`, `serviceAccountUser`, `aws-auth`, tenants' `create
  ingresses`, docker group, sudo).
- **Pipeline that applies the controls.** Atlantis without
  `apply_requirements`, or `terraform plan` on fork PRs holding the apply
  role (external data sources and providers execute at plan time), lets an
  outsider change every control this lens reads. Who can trigger plan or
  apply is `pass-sec-supply-chain`'s; the role's trust and scope is
  `pass-sec-iam`'s. Named here so it falls to neither by default.
- **`pass-sec-privesc`.** The application's own roles. The only seam: an
  app that maps a proxy-set header to a role. Whether the header can be
  forged around the proxy is the network half above; what the role then
  allows is privesc's.
- **`pass-sec-tokens`.** Credential verification, lifetime and rotation; a
  proxy's `X-Goog-IAP-JWT-Assertion` verification is tokens'. Tokens' B3
  now names `pass-sec-iam` for CI OIDC `sub`/`aud` and SAS scope (fixed in
  the 2026-11-02 consistency pass); keys in state are secrets-data's.
- **`pass-sec-access`.** Object-level authz and tenant keys, plus CSRF,
  CORS and clickjacking, even when the header sits in nginx or a CDN.
- **`pass-bounds`.** `DEBUG` stack traces and error leakage.
- **`pass-sec-supply-chain`.** Build-time trust: workflow triggers, action
  pinning, `GITHUB_TOKEN`, `FROM`, install scripts.
- **`pass-sec-secrets-data`.** A credential literal anywhere, including a
  committed tfstate. Infra owns a store's exposure (a public bucket or state
  bucket) and planes with auth switched off.
- **`pass-sec-boundaries`.** SSRF in code. Infra owns IMDS settings and
  node-credential reach, the next link.
- **`pass-sec-exploit-chain`.** Consumes infra's rows as pivot hops and owns
  every two-hop upgrade (IMDSv1 plus a cited SSRF; an unauthenticated
  registry plus a deploy that pulls from it, beyond infra's P0 for the push).
- **`pass-sec-toctou`.** Infra claims an ordering window only when a deploy
  script shows it (a service published before the firewall step runs).
- **`pass-prod-risk`.** The availability side of the same files.

### Motivating incidents and sources

- **Docker bypasses ufw**: published ports are diverted "before it goes
  through the ufw firewall settings" —
  https://docs.docker.com/engine/network/packet-filtering-firewalls/ ;
  publishing binds all interfaces —
  https://docs.docker.com/engine/network/port-publishing/ ; the fix point
  is `DOCKER-USER` — https://docs.docker.com/engine/network/firewall-iptables/ ;
  an advisory where ufw "gave a false sense of protection" —
  https://github.com/notthebee/ansible-easy-vpn/security/advisories/GHSA-79c3-9r24-3jmv ;
  https://github.com/moby/moby/issues/4737
- **Docker before 28.0, L2 neighbours**: "someone connected on an RFC1918
  subnet … could reach unpublished container ports if they knew (or guessed)
  its IP address"; "only affects Linux users running Docker versions earlier
  than 28.0.0 with `iptables`" —
  https://www.docker.com/blog/docker-engine-28-hardening-container-networking-by-default/
- **ufw ships disabled; first match wins** —
  https://manpages.ubuntu.com/manpages/noble/en/man8/ufw.8.html
- **NetworkPolicy**: no effect without an implementing plugin, policies
  union, and the `from` array with "two elements … allows connections from
  Pods in the local Namespace with the label `role=client`, *or* from any
  Pod in any namespace with the label `user=alice`" —
  https://kubernetes.io/docs/concepts/services-networking/network-policies/ ;
  GKE enforcement — https://cloud.google.com/kubernetes-engine/docs/how-to/dataplane-v2
- **`kubernetes.io/metadata.name`**: "The Kubernetes API server … sets this
  label on all namespaces … You can't change this label's value" —
  https://kubernetes.io/docs/reference/labels-annotations-taints/
- **`edit` can delete NetworkPolicies**: `system:aggregate-to-edit` grants
  `create, delete, deletecollection, patch, update` on `networkpolicies` —
  https://raw.githubusercontent.com/kubernetes/kubernetes/master/plugin/pkg/auth/authorizer/rbac/bootstrappolicy/testdata/cluster-roles.yaml
- **Gateway API**: custom namespace labels let "anyone that is able to label
  namespaces" change which namespaces a Gateway accepts, and distinct Routes
  can claim the same hostname (via search summary, page not fetched) —
  https://gateway-api.sigs.k8s.io/concepts/security/
- **Load-balancer scheme**: AWS LB Controller `aws-load-balancer-scheme`
  "If not specified, default is `internal`"; the legacy
  `aws-load-balancer-internal` defaults to `false` —
  https://kubernetes-sigs.github.io/aws-load-balancer-controller/latest/guide/service/annotations/ ;
  GKE `networking.gke.io/load-balancer-type: "Internal"`, external
  otherwise —
  https://docs.cloud.google.com/kubernetes-engine/docs/concepts/service-load-balancer-parameters ;
  AKS `azure-load-balancer-internal: "true"` —
  https://learn.microsoft.com/en-us/azure/aks/internal-lb
- **PrivateLink**: "If you grant everyone permission to access the endpoint
  service and configure the endpoint service to accept all requests, your
  load balancer will be public even if it has no public IP address" —
  https://docs.aws.amazon.com/vpc/latest/privatelink/configure-endpoint-service.html
- **GCP network tags**: "IAM principals who can edit an instance can change
  its network tags", and for strict control "use target service accounts and
  source service accounts instead" —
  https://docs.cloud.google.com/firewall/docs/firewalls
- **Terraform inline `ingress` removal and inline/standalone conflicts** —
  https://github.com/hashicorp/terraform-provider-aws/blob/main/website/docs/r/security_group.html.markdown
- **nginx location precedence**: the longest prefix is remembered, "Then
  regular expressions are checked … The search of regular expressions
  terminates on the first match"; with `^~` "regular expressions … are not
  checked" — https://nginx.org/en/docs/http/ngx_http_core_module.html#location
- **IMDS defaults are account-, AMI- and launch-dependent**, and AWS
  recommends hop limit 2 for container hosts under v2 —
  https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/configuring-IMDS-new-instances.html .
  This is why only an explicit `http_tokens = "optional"` is a finding.
- **ECS on EC2**: containers "can also access permissions assigned to the
  ECS container instance role"; `ECS_AWSVPC_BLOCK_IMDS` for awsvpc, a
  `DOCKER-USER` drop to 169.254.169.254 for bridge —
  https://docs.aws.amazon.com/AmazonECS/latest/developerguide/task-iam-roles.html
- **GKE metadata**: "Pods running on the host network (hostNetwork: true)
  don't use Workload Identity Federation for GKE", and GKE routes them to
  the Compute Engine metadata server —
  https://docs.cloud.google.com/kubernetes-engine/docs/concepts/workload-identity ;
  CIS GKE 5.4.2 (secondary) —
  https://www.tenable.com/audits/items/CIS_Google_Kubernetes_Engine_GKE_v1.1.0_L2_Master.audit:1a0a0e45edf6b59763a1c9d28cb99a4b
- **`/var/log` hostPath escape**: the kubelet follows a symlinked container
  log to a host file (Aqua) —
  https://www.aquasec.com/blog/kubernetes-security-pod-escape-log-mounts
- **IAP**: "If an attacker bypasses IAP, the attacker can forge the IAP
  unsigned identity headers" —
  https://docs.cloud.google.com/iap/docs/signed-headers-howto
- **CDN origin lock**: Cloudflare's global AOP certificate "is shared
  across all accounts" —
  https://developers.cloudflare.com/ssl/origin-configuration/authenticated-origin-pull/ ;
  AWS's primary CloudFront → ALB mechanism is a secret custom header —
  https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/restrict-access-to-load-balancer.html
- **Istio CVE-2021-31920** (`//admin` past a DENY on `/admin`) —
  https://istio.io/latest/news/security/istio-security-2021-005/
- **ingress-nginx CVE-2025-1974 (IngressNightmare)** —
  https://kubernetes.io/blog/2025/03/24/ingress-nginx-cve-2025-1974/
- **Kubernetes CVE-2020-8554 (`externalIPs` interception)** —
  https://github.com/kubernetes/kubernetes/issues/97076 (not re-fetched)
- **Planes with auth off**: Hasura needs an admin secret so the endpoint and
  console "are not publicly accessible" —
  https://hasura.io/docs/2.0/deployment/securing-graphql-endpoint/ ; Airflow
  `AUTH_ROLE_PUBLIC` deactivates authentication for that role —
  https://airflow.apache.org/docs/apache-airflow-providers-fab/stable/auth-manager/webserver-authentication.html ;
  the distribution registry's no-auth setups are "only appropriate for
  testing" — https://distribution.github.io/distribution/about/deploying/ ;
  ShadowRay, CVE-2023-48022 — https://nvd.nist.gov/vuln/detail/CVE-2023-48022
  (not re-fetched)
- **Tailscale**: the default policy "enables communication between all
  devices within the tailnet" — https://tailscale.com/kb/1018/acls
- **Capital One 2019** (IMDSv1 plus an over-broad role) —
  https://www.cloudsek.com/knowledge-base/capital-one-data-breach-attack-path-cloud-security-lessons
- **Tesla 2018** (a Kubernetes console with no password, a pod holding AWS
  credentials) —
  https://www.bleepingcomputer.com/news/security/tesla-internal-servers-infected-with-cryptocurrency-miner/
- **Handed off, kept for the receiving lens**: Microsoft AI 2023, an
  account-wide SAS committed to a public repo (scope → `pass-sec-iam`,
  lifetime → tokens, the leak → secrets-data) —
  https://wiz.io/blog/38-terabytes-of-private-data-accidentally-exposed-by-microsoft-ai-researchers ;
  GCP WIF `attribute_condition` (→ iam) —
  https://cloud.google.com/iam/docs/workload-identity-federation-with-deployment-pipelines
- **Kubernetes RBAC good practices and Pod Security Standards** —
  https://kubernetes.io/docs/concepts/security/rbac-good-practices/ ;
  https://kubernetes.io/docs/concepts/security/pod-security-standards/
- **Terraform state holds `sensitive` values in plaintext** —
  https://developer.hashicorp.com/terraform/language/state/sensitive-data
- **Academic**: "invalid IP address binding" among seven IaC security smells
  over 15,232 scripts (Rahman, Parnin, Williams, ICSE 2019) —
  https://2019.icse-conferences.org/event/icse-2019-technical-papers-the-seven-sins-security-smells-in-infrastructure-as-code-scripts
- **Audit sinks.** Kubernetes: "The first matching rule sets the audit
  level", and without `--audit-policy-file` "no events are logged" —
  https://kubernetes.io/docs/tasks/debug/debug-cluster/audit/ . EKS control
  plane logs are off by default —
  https://docs.aws.amazon.com/eks/latest/userguide/control-plane-logs.html .
  `aws_cloudtrail` defaults —
  https://github.com/hashicorp/terraform-provider-aws/blob/main/website/docs/r/cloudtrail.html.markdown .
  `aws_guardduty_detector` `enable = false` "is equivalent to 'suspending'
  GuardDuty", deletion "removes all existing findings" —
  https://github.com/hashicorp/terraform-provider-aws/blob/main/website/docs/r/guardduty_detector.html.markdown .
  GuardDuty suppression rules archive matching findings, which are "not sent
  to AWS Security Hub CSPM, Amazon Simple Storage Service, Amazon Detective,
  or Amazon EventBridge", and broad rules blind attack-sequence detection —
  https://docs.aws.amazon.com/guardduty/latest/ug/findings_suppression-rule.html .
  MITRE ATT&CK T1562.008, Disable or Modify Cloud Logs —
  https://attack.mitre.org/techniques/T1562/008/ ; Elastic's rule for a
  suspended trail —
  https://www.elastic.co/guide/en/security/current/aws-cloudtrail-log-suspended.html
- **Live-state checks**: AWS Config managed rules (`cloudtrail-enabled`,
  `guardduty-enabled-centralized`, `ec2-imdsv2-check`, `restricted-ssh`, …) —
  https://docs.aws.amazon.com/config/latest/developerguide/managed-rules-by-aws-config.html ;
  `terraform plan -refresh-only` —
  https://developer.hashicorp.com/terraform/tutorials/state/refresh

### What a read-only reviewer cannot establish

- **Live state**: `ufw status`, console-made rules, drift since the last
  apply, the CNI running, the policy engine's actual mode, Docker's version.
- **Guardrails outside the repo**: SCPs, org policies, account-level S3
  public-access blocks and IMDS defaults, a CDN origin lock or Access app set
  in a dashboard, a golden image's firewall.
- **Rendered output that needs execution**: `helm template` with external
  values, remote Terraform modules, apply-time variables.
- **Which scripts run in production.**

What covers these outside the LLM:

1. **Deterministic daemon-side leads** (greps and YAML/HCL reads, no code
   runs): an SG/NSG/firewall resource referenced nowhere; a compose port with
   no host IP in a repo that configures ufw or firewalld; a NetworkPolicy
   selector against plain-YAML pod labels; `from` arrays with separate
   selector items; a removed internal-LB annotation. The single-file
   catalogue cut from the lens body belongs here: `0.0.0.0/0` on 22/3389,
   `publicly_accessible`, nginx `proxy_ssl_verify off`, and the auth-off
   spellings the lens now covers by one sentence (`MYSQL_ALLOW_EMPTY_PASSWORD`,
   Mongo without `--auth`, Redis `protected-mode no`, Jupyter empty token,
   k8s dashboard `--enable-skip-login`, Argo CD anonymous, Consul/Nomad ACLs
   off, Ray dashboard bound wide, Node `--inspect=0.0.0.0`, cloud-init
   `ssh_pwauth: true`, firewalld `--permanent` without `--reload`).
2. **Rendered artifacts from the repo's own CI** (`terraform show -json`,
   `helm template`, Checkov/Trivy/kube-linter SARIF) read as inputs. A
   new-dependency decision.
3. **An operator checklist** a plausible finding can name: `ufw status
   verbose`, `nft list ruleset`, `ss -ltnp`, an external port scan,
   `kubectl auth can-i --list --as=…`, IAM Access Analyzer.

**Scope statement.** This lens establishes that a control is *declared,
enabled, attached and covering in the config this repo ships*. It never
establishes that the control is running now, and no finding, question or
note may imply it did. Live state reaches a review only as the capped
live-state note, which is never counted as a finding or question.

### Confirming live state out of band (summary)

The daemon never runs reviewed code or holds the reviewed repo's cloud
credentials, so a live-state note is settled outside the round: (1) the note
names one read-only operator command (`ufw status verbose`, `iptables -S
DOCKER-USER`, `aws cloudtrail get-trail-status`, …) whose dated answer goes
into `.qcr/threat-model.md` as a live fact, which silences that note; (2) an
operator-run collector writes the same outputs to `.qcr/live-state/`, read as
untrusted data, dropping or upgrading a note with its age shown, and
rendering a stale or missing snapshot as *unknown*; (3) where the account
already runs AWS Config, SCC or Azure Policy, the note names that rule. Route
1 ships with the lens; route 2 is a separate decision (a file format and a
reader). The full proposal belongs in README §11 when that file is next
edited.

### How to evaluate it

- **Seeded single-mutation corpus** over realistic clean IaC repos, one
  defect per PR: drop `ufw enable`; add compose `5432:5432` on a ufw host;
  an SG nothing attaches; `vpc_security_group_ids` replacing a restrictive
  set; a NetworkPolicy label typo, wrong namespace, or a `-` turning AND
  into OR; PSA `enforce` → `warn`; Kyverno `Audit`; a new `PolicyException`;
  delete the inline `ingress` block "to close it"; `::/0` beside a
  restricted IPv4 rule; remove the internal-LB annotation; an endpoint
  service open to `*` with auto-accept; a bucket's public-access block
  deleted; a cloudflared hostname with no Access app; a Gateway with
  `from: All`; oauth2-proxy in front of a Service also exposed as NodePort;
  an SG allowing only Cloudflare ranges; nginx regex location beside a
  protected prefix; Hasura with no admin secret; an unauthenticated
  registry; `http_tokens = "optional"`; a GKE pool set to `GCE_METADATA`; a
  `hostNetwork` pod under Workload Identity; a `containerd.sock` hostPath; a
  DNS record left after its EIP is released; delete an `aws_cloudtrail`;
  GuardDuty `enable = false`; an `ARCHIVE` filter over all high-severity
  findings; `read_write_type = "ReadOnly"`; a `level: None` audit rule above
  the catch-all.
- **Paired benign controls** for precision: 443 on a public LB; SSM or a
  keys-only bastion; a dev-only compose file; `0.0.0.0` inside a container
  published on `127.0.0.1`; correct labels; open egress; CI `services:`
  postgres; a kind cluster; a Calico DaemonSet with `hostNetwork`; a GKE pool
  with no `workload_metadata_config` on a WIF cluster; `http_tokens` absent;
  a static-site bucket with a `website` block; an EKS endpoint with default
  CIDRs; Traefik on `docker.sock` already exposed; a Cloud Run `allUsers`
  invoker (authn-coverage's, must yield nothing here); a GuardDuty filter on
  one scanner's portscan findings; a PR *adding* a trail; a per-account trail
  removed beside `aws_organizations_*` and an org trail; a sandbox account
  the threat model marks ephemeral; `automountServiceAccountToken: false`.
- **Live-state notes** scored apart: a host-only ufw rules file with no
  provisioning path yields exactly one note and no finding; the same rules
  in a cloud-init that never enables ufw yield a finding; the same with a
  `data "aws_ami"` golden image yield one note; a PR touching six such rows
  yields at most two notes.
- **Real pairs** mined from public history (commits that restrict an SG,
  require IMDSv2, bind `127.0.0.1`, fix Docker/ufw, add an origin header,
  re-add a public-access block), replayed as the introducing PR. TerraGoat,
  KubernetesGoat and CloudGoat are smoke tests only.
- **Scoring**: recall per broken-link class, with "declared but not in
  force" reported apart from plain exposure; false-block rate on the benign
  set; duplicate rows with authn-coverage and iam (target zero); questions
  per infra PR (target at most one) and notes per review (cap two).

### Critique log

Points from the revision-1 critics that were rejected or only partly taken:

- Red team 5 (`tamper` link): taken, scoped to controls on a row's path (revision 3 narrows it further to citing iam's row).
- Red team 8 (federated identity), 9 (IAM shapes), 10 (`aws-auth`), 11 (docker group, sudoers), 13 (`create ingresses`): handed to the grant-graph owner, now `pass-sec-iam`. Azure IMDS not named separately; step 5's "the reached identity via metadata" covers every cloud.
- Red team, step 2 identity path: rejected here; an identity path through grants is `pass-sec-iam`'s.
- Precision 3, `allUsers` on a Cloud Run invoker: kept in revisions 1–2, cut in revision 3 (authn-coverage's under the synthesis). `allUsers` on a bucket stays: that is a public store, not an endpoint auth cell.
- Precision 5, nginx minutiae to deterministic leads: partly rejected; path rules need proxy and backend read together. `proxy_ssl_verify off` and `listen 80` without redirect moved.
- Precision 5, "keep only seven declared-but-inert facts": rejected as too narrow; fail-open modes, OR/AND selectors, proxy bypass, shared CDN ranges and auth-off planes are the same class.
- Precision 1, IPv6 twin: cut in revision 1, restored in revision 3 (see below).
- Precision 6 (triggers) and 4 (per-environment severity): taken.

### Critique log (revision 2)

Taken in full or in substance: red team 1 (public storage, minus SAS), 2 (LB scheme, corrected for the AWS LB Controller, whose default is internal), 3 (tunnels, minus WireGuard), 5 (`edit`, `PolicyException`, `excludedNamespaces`), 6 (nginx precedence, `X-Original-URL`), 7 (`hostNetwork` under WIF; ECS on EC2), 9 (registry and Jenkins), 10 (muting audit sinks, scoped to named blocks), 11 (runtime sockets, capabilities, `procMount`, `/var/log`), 12 (shared front door), 13 (EIP and delegated zone), 14 (IPv6), 15 (previews), 16 (PrivateLink), 17 (Docker < 28), 18 (pipeline seam, in Overlap); precision 1, 2, 3, 4, 5, 6, 8, 10. Rejected or narrowed, with reasons:

- **Red team 1, account-wide SAS as exposure.** A SAS is a bearer credential: its scope is a grant (`pass-sec-iam`), its expiry is lifetime (tokens), its leak is secrets-data's. Infra keeps Azure public blob access, the exposure that needs no credential.
- **Red team 3, WireGuard `AllowedIPs = 0.0.0.0/0`.** On a client it routes all traffic into the tunnel; it publishes nothing. Not an exposure.
- **Red team 4, `tamper` grep over labels, tags, SGs and service accounts.** Conflicts with precision 2. Taken as a `selects` property instead (a selector keyed on a value the attacker's side can set, with `kubernetes.io/metadata.name` and GCP service-account targets as the fixed points); who can set the value stays iam's. Source-SG attachment and Istio `principals` dropped: both reduce to "who can run a pod or attach an ENI", a grant question.
- **Red team 5, `patch namespaces` to flip the PSA label.** Namespaces are cluster-scoped and tenants rarely hold `patch` on them; it is an iam row when they do.
- **Red team 7, GKE `disable-legacy-endpoints=false`.** The legacy v0.1/v1beta1 metadata endpoints are shut down; the flag no longer opens anything.
- **Red team 8.** Hasura and Airflow taken. Cognito unauthenticated identities handed to `pass-sec-iam` (federation into an IAM role). Firebase RTDB rules and the `database.rules.json` glob go to authn-coverage, which owns Firebase rules.
- **Red team 10, KMS key policy and lifecycle rule on the trail bucket.** The KMS policy is a grant (iam); a lifecycle rule expiring delivered logs is folded into "retention cut to days" only for the named audit log groups, not general bucket lifecycle, which fires on every bucket.
- **Red team 15, preview environments.** Taken in one clause; per-platform toggles (Vercel deployment protection) are product dashboards, not repo config.
- **Precision 3, live-state note.** Taken (cap two, changed rows only, silenced by a threat-model live fact, golden image → `?`).
- **Precision 4, audit trigger.** Taken: bare `enable` dropped; the plausible rule uses absence of `aws_organizations_*` as the signal, not presence of an org trail elsewhere.
- **Precision 5, Traefik `docker.sock:ro` as privileged by nature.** Taken as a P2 cap only when newly exposed, with the fact that `:ro` does not restrict the socket API; never excluded outright.
- **Precision 9, cut subdomain takeover.** Rejected: no other lens owns a DNS record left on a released target, and red team 13 shows the variants. Committed tfstate cut (secrets-data's); public state bucket kept.
- **Precision 9, move the live-state proposal and revision notes to README §11.** Not done: this task may edit only this file. Both were condensed in place, and the proposal summary names README §11 as its eventual home.
- **Precision 7, stale cross-references in tokens.** Recorded in Overlap for that draft's owner; not edited here.
- **Correction found while revising**: revision 2 said the IMDS hop limit "matters only with v1". It is the PUT response hop limit and binds only IMDSv2; Part A now says so.

---

## Revision notes

- **Revision 1 (2026-11-02).** Part A rebuilt after the first red-team and precision critiques: `covers`, `tamper`, replace-not-add attachment, default resolution, bypass paths, the reached identity, the proof-gap gate, fail-open engines, OR/AND selectors, proxy identity and CDN ranges, path normalization, auth-off planes, node-credential reach, compose privilege, dangling DNS; triggers match removed lines.
- **Revision 2 (2026-11-02).** Grant graph to `pass-sec-iam`; "config this repo ships, not live state" with the live-state note and an out-of-band proposal; removed audit sinks as a covered control (P2, P1 when the threat model relies on them).
- **Revision 3 (2026-11-02).** Endpoint auth cells (Cloud Run invoker, Lambda URL, API Gateway `NONE`, `{proxy+}`, Firebase and Supabase rules, pprof) cut to `pass-sec-authn-coverage`; infra keeps the network half of a proxy bypass. `tamper` now only cites iam's row and is never a question. New facts: LB scheme, PrivateLink, IPv6 twin, GCP source tags, public storage, tunnels, nginx location precedence, `edit` and policy exceptions, shared front doors, Hasura/Airflow/registry/Jenkins, ECS and `hostNetwork` metadata reach, runtime sockets and escape capabilities, released EIPs and delegated zones, muted audit sinks. New exclusions: GKE pools inheriting `GKE_METADATA`, implicit IMDS defaults, IAM-authenticated cluster endpoints, keys-only sshd, website buckets, ephemeral environments; audit removal without org context is a question. IMDSv1 stays P2; the SSRF upgrade is exploit-chain's. Live-state notes capped at two. Part A: 238 lines with the frontmatter (about 2,110 words), against 240 before; the management-plane catalogue moved to deterministic leads, and the intro, Kubernetes, proxy, audit, exclusion and severity text were tightened to pay for the additions.
