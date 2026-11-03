# `pass-sec-authn-coverage` — draft lens and design notes

Drafted 2026-11-02 for the security profile (README §3); revised the same
day after a red-team critic and a precision critic (Part B, critique log).
Status: proposal, nothing built. Part A is the lens file as it would ship at
`agents/pass-sec-authn-coverage.md`; Part B is the reasoning behind it.

---

## Part A — the lens

```markdown
---
name: pass-sec-authn-coverage
description: Authentication-coverage security pass — tabulates every in-scope entry point (HTTP, GraphQL, gRPC, WebSocket, webhook, cron target, server action, IaC- or backend-declared endpoint, ops/debug surface), resolves the guard chain that actually runs on it, and reports the ones an attacker reaches without the authentication or function-level authorization their siblings have, or through a check that does not stop the request.
tools: read, bash, grep, glob
---

{{include:prompts/pass-common.md}}

# Lens: authentication coverage (every entry point, its effective guards)

Apply to: a diff that adds, changes, moves or removes an entry point, a
router mount, an auth middleware/guard/decorator, a public-paths list or
matcher, a framework security config, an IaC or backend-service auth
setting, or the listener an endpoint is served on. In scan, the entry-point
files your task names.

Your defects are **absences** that read correct line by line: the route
without its siblings' guard, the `401` with no `return`, the prefix rule that
also matches `/public-admin`. You find them by building a table.

## Worksheet — fill it in your notes before writing any finding

1. **The house mechanism.** With `file:line`: the global guard or its
   absence (deny- or allow-by-default), the public allowlist and its
   matching semantics, every opt-out marker in use, the fronting layer if
   its config is in the repo, and the session states that exist (pre-MFA,
   unverified email, must-reset, suspended, impersonating). A threat
   model's entry points and controls are your checklist, not proof.
2. **Rows in scope, and how you found them.** Every added or changed entry
   point, every entry point whose resolved chain differs between base and
   head, and every pre-existing one the PR makes reachable. Kinds: routes
   and controllers (incl. file-based), GraphQL resolvers incl. field and
   `node`, gRPC methods incl. streaming, WebSocket handshakes and message
   handlers, webhooks, cron/scheduler HTTP targets, server actions, static
   and file-serving roots, setup/install routes, ops surfaces (health,
   metrics, debug, docs UIs, admin), and endpoints declared in IaC or a
   backend service — function URLs, API Gateway methods, serverless.yml
   functions, Cloud Run invoker IAM, Supabase RLS/policies, Firebase rules;
   their auth cell comes from that config. Write down the registration
   mechanisms you searched. If routes are generated, discovered at runtime
   or declared where you did not look, say the table is incomplete. Cap the
   table at ~30 rows, most sensitive effect first, and name what you left
   out.
3. **Resolve the effective chain before comparing anything.** What runs on
   this request: registration order (a later `use` misses earlier routes),
   group and sub-router membership, inheritance and mixins (the most-derived
   `permission_classes`/filters win; an inherited `skip_before_action`
   undoes the base's guard), opt-outs that beat opt-ins, and a guard that
   runs after the first sensitive effect. For every declarative marker
   (decorator, directive, annotation, OpenAPI `security`), find the code that
   reads it on this route; a marker nothing reads is no guard. A client-side
   or SSR check on a page is not a guard on the API it calls; tabulate the
   API on its own.
4. **The table.** One row per entry: `entry · file:line · listener (public /
   internal / unknown, with evidence) · authn (mechanism, file:line, how
   attached) · session states accepted · function-level authz · public-by-
   design (cite) · first sensitive effect (file:line)`. A cell you cannot
   fill is a lead, not a finding.
5. **Siblings.** Same router, controller or class; same prefix; same
   resource under other methods; same operation under another API version
   or transport (REST, GraphQL, WebSocket, gRPC reaching one service
   function). Diff the resolved guard sets from step 3. A row weaker than
   its siblings with an equal-or-more sensitive effect is a candidate. A
   row authenticated by a different mechanism by design (HMAC webhook, mTLS,
   API key, basic auth) is judged against that mechanism, not against the
   siblings' session. Role checks must be allow-lists: `role != "guest"`
   admits new, null and differently cased roles.
6. **Matcher vs router — only where they are separate.** Run this step when
   the matcher is hand-written in the repo (`startsWith`, regex, `strncmp`)
   or the matcher and the router are different components (proxy vs app,
   security filter vs dispatcher, middleware `matcher` vs file router). A
   route-level decorator has no gap. Write one line per hop: `proxy (decode?
   merge slashes? strip ;?) → matcher → router`; a bypass exists exactly
   where adjacent hops differ. Try trailing slash, case, `//`, `..`/`%2e`,
   `%2f`, `;param`, a format suffix, the version prefix, the mount point,
   facts the app routes on that the matcher never sees (`X-Original-URL`,
   `X-Rewrite-URL`, `_method`/`X-HTTP-Method-Override`, GraphQL
   `operationName` vs the parsed document, batched operations), and method
   gaps (`HEAD` reaching a `GET` handler, a guard keyed on method beside a
   `GET` that mutates). Semantics you recall rather than read in the repo,
   vendored source or pinned docs cap the finding at confidence 0.7.
7. **The checks that do not stop the request.** Read the verifier and every
   rejecting branch. Each must end the request: `return` after
   `http.Error`/`res.status(401).send()`, `exit` after a PHP redirect
   header, no `next()` after a 401 — code after a response write still
   runs. Shared-secret and API-key comparisons: what happens when the
   configured value is unset or empty, or the header is absent? Equal when
   both are missing is no authentication. Then: a missing or malformed
   credential that falls through; an exception or timeout (JWKS, session
   store) swallowed; a result computed and ignored; optional auth on a
   mutating route with no `None` check; a token decoded with no verifier
   anywhere on the path. A verifier that exists but checks too little is
   `pass-sec-tokens`.
8. **Identity facts the client can forge.** Only headers or fields that
   decide identity or authorization: a user-id or role header, an
   "is internal"/"is localhost" test on `X-Forwarded-For` or `Host`, an
   identity-proxy email header without its signed assertion, a
   framework-internal header (`x-middleware-subrequest`). For each, find
   the layer that strips or overwrites it on every route. Logging,
   rate-limit and geo uses are not yours; neither is a framework-managed
   `trust proxy`/forwarded-headers setting that is configured.
9. **Reachability for every row.** Fill the listener cell: bind address,
   port, Service type, compose `ports:`, Ingress and proxy routes. Ops and
   debug surfaces on the main listener (a profiler on the default mux,
   management endpoints exposed on the app port). Static roots: which
   directory, and does it hold config, source, `.env`, `.git` or uploads?
   A wildcard or catch-all registered before a guarded route shadows it.
   Dev/test routes gated on an environment check: a default that is on, a
   negated check (`!== 'production'` where nothing sets it) or a truthy
   string (`"False"`) is not off.
10. **Transports and adapters.** WebSocket: per-message authority needs a
    per-message check; handshake-only auth does not cover room, tenant or
    role switches; no `Origin` check on a cookie-authenticated socket.
    gRPC: a unary interceptor without the stream one; reflection or admin
    services on the public server; REST transcoding or in-process adapters
    (grpc-gateway `Register…HandlerServer`) that bypass the interceptor
    chain; global guards that do not cover a hybrid microservice or gateway.
    GraphQL: field and `node` resolvers. Webhooks and cron targets: the
    signature, secret or OIDC token checked before parsing or acting, and
    required when absent. Queue consumers: only when the repo itself
    contains a less trusted producer onto that topic. Server actions: a
    page-level check does not cover the actions defined in it. Middleware
    `matcher` exclusions (`_next`, `/api`) leave the data routes behind
    them unguarded.
11. **Hunt the defeating control, then test it.** Before writing a row up,
    look for what makes it safe and record where you looked: a global guard,
    an in-handler or data-layer check before the first effect, a gateway or
    ingress rule, a normalising firewall that rejects the bypass. Re-run the
    `bypass` request against that control's own matcher. A gateway or
    ingress auth rule defeats the finding only if the backend has no other
    published path (Service type, compose ports, a second Ingress, a public
    bind). PR text, comments ("handled upstream"), path names, an unlinked
    URL and a passing test are not controls.

Report only failing rows. `NONE` is right when every row passes; say what
you tabulated and which registration mechanisms you searched.

## Evidence block (every finding, inside `detail`)

    source:      <METHOD path | op | event | resource> — <kind>, registered <file:line>; attacker controls <what>, trust: untrusted|tenant|operator|first-party
    listener:    <public|internal|unknown> — <bind/port/Service/ingress evidence, file:line>
    boundary:    <unauthenticated | <session state> | role X> → <what the row requires>
    path:        <guards that actually run, in order, each file:line + how attached> (gaps "?")
    siblings:    <2–4 siblings and their resolved guard sets; the guard this row lacks>
    bypass:      <the request that reaches the effect: method, raw path, headers, session state> | n/a
    sink:        <file:line> — <the first sensitive effect>
    controls:    <defeating controls hunted (step 11), incl. public-by-design evidence, and why they do not cover this request>
    cwe:         CWE-<id>   (306 missing authn · 862 missing function-level authz · 288 alternate path · 647 non-canonical path · 698 execution after redirect/response · 636 fail-open · 290 spoofable identity · 489 debug surface)
    proof-gaps:  <the smallest fact(s) that, if false, kill the finding>

## Confidence

≥0.8: every cell of the row is read in the repo (chain, listener, effect)
and, for a matcher gap, both semantics are cited and the `bypass` request is
written. 0.4–0.7: the chain is open in the repo but one fact lives outside
it — a gateway rule, header stripping, the deployed framework's
normalisation; name that fact in `proof-gaps` so the finding can be asked
as a question: "Does the ingress for `api.example` require auth on
`/internal/*`? If not, anyone can call `POST /internal/users/:id/role`."

**Never a finding:** routes public by design and shown so by code, sibling
convention or the threat model (login, signup, reset *request*, OAuth
callbacks, static assets); public reads whose data an unauthenticated page
already renders (cite the page); health, readiness and metrics returning
status or numeric telemetry, unless public and carrying secrets, env or
heap; framework-generated, internally guarded routes (Django admin, Devise)
the PR does not reconfigure; mock and dev servers (MSW handlers, Storybook,
examples, scripts, test fixtures, `*dev*`/`*.local.*` compose files); CLI
commands with no network entry; operator-trusted inputs (env, flags, config
tokens); same-principal effects; `jwt.decode` that reads a header or `kid`
before a verify, or decodes after one; `auto_error=False` whose `None`
branch is an anonymous read-only view; `OPTIONS` preflights with no data;
missing rate limiting or security headers. CSRF, CORS and framing policy
belong to `pass-sec-access`, but a method or path gap that skips a guard
the siblings rely on, CSRF included, is yours.

## Severity: impact × exposure

Impact **A**: acts on other users or the system — admin actions, role or
credential minting, writes to others' data, config or code execution,
secret, env or heap dump. **B**: reads others' or non-public data, or an
action the app requires an account for (posting as nobody, sending mail or
SMS through the app, spending paid quota). **C**: version, build or
topology disclosure. Exposure: remote unauthenticated > remote
authenticated > tenant-internal > local/operator. "Any authenticated user"
counts as remote unauthenticated only when you cite an open signup route.

| | remote unauth | remote auth | tenant-internal | local/operator |
|---|---|---|---|---|
| A | P0 | P1 | P2 | P3 |
| B | P1 | P2 | P3 | excluded |
| C | P3 | excluded | excluded | excluded |

Confidence carries doubt; severity never does. Never demote for "unlikely",
"obscure path" or "no client calls it" — routes ship in bundles and API
documents. Reachability: `routine` on a public listener; `plausible` when it
rests on a deployment fact you named; `contrived` only if it needs an
operator misconfiguration.

## Stay inside your lens

Object ownership, tenant keys and IDOR are `pass-sec-access`; the logic of
endpoints that grant roles is `pass-sec-privesc`; how a present verifier
checks algorithm, audience, expiry and rotation is `pass-sec-tokens`;
check-then-use windows are `pass-sec-toctou`; firewall, security-group and
network-policy state is `pass-sec-infra`; grants to a role, service account
or group (cloud IAM, trust, k8s RBAC) are `pass-sec-iam`, while an
invoker's `allUsers` is your auth cell. When an unguarded row's effect is
one of those, anchor at the missing guard here and name the other lens.
```

---

## Part B — design notes (not part of the lens)

### 1. Planning triggers

**Plan:** *triggered* in the security profile, and *always* in the scan deep
floor for files the threat model lists as entry points or controls. A PR
that changes a recorded control (auth middleware, public-path list,
framework security config) always plans it. Not planned in the default
profile, where `pass-security` keeps its generic sentence and gains the same
content triggers (M3).

Why not "always" in the security profile: a PR with no entry point and no
guard change has an empty table, and the pass costs a full lens run to say
`NONE`. README §9.1 shows path-only triggers miss 60 % of security defects,
so content triggers carry the weight.

**Path globs** (any changed file, *including removed files* — a deleted
middleware or guard file is the purest shape of this defect; the
`status === "removed"` handling at `heuristics.ts:834` is the pattern):

```
**/routes/** **/router*.* **/urls.py **/views*.py **/viewsets*.py
**/controllers/** **/*Controller.* **/endpoints/** **/resolvers/**
**/*.graphql **/*.gql **/*.proto
**/middleware*.* **/proxy.ts **/app/**/route.{ts,js} **/pages/api/** **/app/api/**
**/config/routes.rb **/*Security*Config*.* **/guards/** **/policies/**
**/Program.cs **/Startup.cs **/application*.{yml,yaml,properties}
**/webhooks/** **/gateways/** **/ws/**
**/nginx*.conf **/conf.d/** **/ingress*.y*ml **/openapi*.{yml,yaml,json} **/swagger*.*
**/serverless.y*ml **/template.y*ml **/cdk*.json **/firebase.json **/*.rules
**/supabase/migrations/** **/vercel.json **/cron.yaml
```

Excluded roots, so client and mock code does not fire the glob tier:
`**/components/**`, `**/frontend/**`, `**/client/**`, `**/web/src/**`,
`**/mocks/**`, `**/__mocks__/**`, `**/msw/**`, `**/*.stories.*`,
`**/examples/**`. `**/api/**`, `**/handlers/**`, `**/listeners/**`,
`**/consumers/**` and `**/socket*.*` are dropped: they matched frontend API
clients, MSW handlers and UI listeners more often than servers. A server
file under them is still caught by the content probes.

**Content probes over `changedCode()`** (added *and* removed lines,
`heuristics.ts:514`, the helper the concurrency probes already use; a
deleted `before_action`, decorator or `app.use(auth)` fires). Multiline;
case-insensitive unless marked:

```
# route registration: a path literal starting with "/" and a handler argument
\b(app|router|routes|server|fastify|hono|mux|bp|blueprint|group|v\d+)\.(get|post|put|patch|delete|all|route|use|on|mount|handle|handlefunc|include_router|add_api_route)\s*\(\s*['"`]/[^'"`]*['"`]\s*,
\b(r|mux|router)\.(Get|Post|Put|Patch|Delete|Route|Mount|Handle|HandleFunc|Group)\(        # case-sensitive (chi/gorilla)
\bhttp\.Handle(Func)?\(
^\s*@(app|router|api|bp|blueprint)\.(get|post|put|patch|delete|route|websocket|api_route)\b
\bRoute::(get|post|put|patch|delete|any|match|resource|group|middleware)\b|->(middleware|withoutMiddleware)\(
# annotations/attributes (Nest, Spring, ASP.NET)
^\s*@(Get|Post|Put|Patch|Delete|All|Controller|Resolver|Mutation|SubscribeMessage|WebSocketGateway|RequestMapping|GetMapping|PostMapping|PutMapping|PatchMapping|DeleteMapping|RestController|PreAuthorize|Secured|EnableMethodSecurity|Public|Roles|UseGuards)\b
^\s*\[(Http(Get|Post|Put|Patch|Delete)|Route|AllowAnonymous|Authorize)\b
\bMap(Get|Post|Put|Patch|Delete|Methods|Group|Hub|GrpcService|Controllers)\s*[<(]
# Python/Ruby/tRPC guard markers
\b(path|re_path)\s*\(.*(view|as_view|include)
\b(permission_classes|authentication_classes|DEFAULT_PERMISSION_CLASSES|AllowAny|login_not_required|login_required|csrf_exempt|dependencies\s*=\s*\[|Security\()
\bDepends\(\s*\w*(auth|user|current|token|verify|require)
\b(before_action|skip_before_action|skip_forgery_protection|allow_unauthenticated_access)\b
\b(publicProcedure|protectedProcedure|adminProcedure)\b
# opt-outs, fail-open, decode-only
(permitAll|web\.ignoring|requestMatchers|authorizeHttpRequests|FallbackPolicy|credentialsRequired|auto_error\s*=\s*False|verify_signature|ParseUnverified|decodeJwt|jwt\.decode)
\b(startsWith|startswith|HasPrefix|strncmp)\s*\(.*(path|url|uri|route)
# identity headers (not logging-grade ones)
(x-middleware-subrequest|X-Original-URL|X-Rewrite-URL|X-User-?(Id|Role|Email)|X-Internal|X-Goog-Authenticated|X-Forwarded-For.*(==|127\.0\.0\.1|localhost))
# non-HTTP and cron entry points (server-side spellings only)
("use server"|'use server'|\bio\.(of|use)\(|\bwss?\.on\(\s*['"](connection|message)|grpc\.(Unary|Stream)Interceptor|Chain(Unary|Stream)Interceptor|Register\w+HandlerServer|add_\w+Servicer_to_server|reflection\.Register|@(Kafka|Rabbit|Sqs|Jms)Listener|CRON_SECRET|X-Appengine-Cron|/api/cron/)
# ops/debug (code spellings; config spellings are in the config probe set)
(net/http/pprof|expvar|graphiql|swagger-ui|express\.static\(|static_folder\s*=|DEBUG\s*=\s*(True|os\.getenv))
```

Dropped from the first draft: `.subscribe(`, `consume(` and `socket.on(`
(RxJS, Angular and client sockets), the single-letter receivers `r|e|g` and
`api` with lowercase verbs (`api.get('/users')` client calls, Python
`r.get(`, `Map.get(`), and bare `req.ip`, `/admin`, `/metrics`,
`/internal/` (string literals anywhere).

**Config probe set (seam change, M3).** Content probes only scan
`CODE_FILE_RE` files (`heuristics.ts:159,497`), so config spellings never
fire there. Either the globs above carry them (done for files whose name
says it), or `heuristics.ts` gains a `CONFIG_FILE_RE`
(`yml|yaml|json|tf|properties|conf|toml|rules|sql`) probe set over changed
lines, for spellings in files whose names say nothing:

```
AuthType:\s*NONE|authorization_type\s*=\s*"NONE"|AuthorizationType:\s*NONE|"?authorizer"?\s*:\s*null
allUsers|allow-unauthenticated|roles/run\.invoker
security:\s*\[\s*\]|auth_basic\s+off|auth_request\s+off|management\.endpoints|exposure\.include
allow\s+read,\s*write:\s*if\s+true|disable\s+row\s+level\s+security|create\s+policy
```

The `.tf` and cloud-IAM spellings are shared with `pass-sec-infra`'s and
`pass-sec-iam`'s triggers; each lens plans and owns its own claim (§3).

### 2. Validator guidance

The validator re-derives each claim by reading. Framework semantics the
lens no longer spells out live here, where the validator needs them to
refute.

| Claim | Verify by reading | Counterevidence that refutes | Not counterevidence |
|---|---|---|---|
| Row has no authn / no function-level authz | Registration line; every global, group and inherited guard; the framework default (DRF `DEFAULT_PERMISSION_CLASSES` defaults to `AllowAny`; ASP.NET endpoints need no auth without a `FallbackPolicy`; Django `LoginRequiredMiddleware` 5.1+; `[AllowAnonymous]` voids every `[Authorize]`; Nest class `@Public()` via `getAllAndOverride`; Spring `web.ignoring()` skips the whole chain; `@PreAuthorize` inert without `@EnableMethodSecurity`); the handler up to the first effect | A guard, cited `file:line`, that provably runs on this route before the effect: `APP_GUARD`, `FallbackPolicy`, `anyRequest().authenticated()` with no earlier `permitAll` match, the DRF default set, an in-handler or data-layer check, a gateway rule in the repo covering this path **and** no other published path to the backend | PR text ("internal", "behind VPN"); a path name; a comment claiming upstream auth without the config; the UI not linking it; a sibling being guarded; tests passing |
| Ordering gap | The framework's registration semantics (gin `combineHandlers` copies the group's handlers at registration; Express runs in order) and the actual order and mount tree | chi panics on `Use` after routes; the route sits in a sub-router whose own chain has the guard | "Middleware is global" — only as global as its registration order |
| Reject branch does not stop the request | The rejecting branch and what follows it | A `return`/`exit`/thrown error after the write; the framework aborts the chain (`c.AbortWithStatus`, Nest guard returning `false`) | "The client stops on 401" — the server code still runs |
| Unset secret passes | Where the secret is read and the comparison | A startup check that refuses to boot without it; a guard that rejects an empty configured value | "It is always set in prod" without the deploy config |
| Partial session reaches the effect | The guard's predicate and where the MFA/verified/suspended flag is checked | The flag checked in the same guard or a global one that runs first | A check on a different page (`/dashboard`) |
| Matcher/router disagreement | Both semantics, cited: matcher and router/servlet/proxy (case, slash, `;`, decoding order, override headers); the `bypass` request | A normalising firewall before the matcher that rejects or canonicalises the bypass (Spring `StrictHttpFirewall` rejects `;`, `//`, encoded `/` and `..` by default; Shiro `blockSemicolon`; explicit normalise-and-reject) | "Browsers normalise `..`" — raw clients do not; "nobody sends that" |
| Fail-open verifier | Every branch: missing header, parse error, exception, timeout | The framework turns the error into 401/403/500 before the handler; the `None` path is checked | "The verifier never throws"; "our client always sends it" |
| Forgeable identity header | Who sets it, who strips it, on every route | Proxy config in the repo overwriting it on every `location`, or a platform documented to strip it (App Engine strips client-sent `X-Appengine-*`) **and** evidence the app runs there | "The load balancer handles it"; IAP unsigned headers when the signed JWT is not checked |
| IaC/backend endpoint open | The auth setting on that function, method, invoker or table | An authorizer or IAM binding on that resource; RLS enabled with a policy that keys on `auth.uid()` | "Only our frontend has the anon key" — the anon key ships to every browser |
| Internal surface exposed | Bind, port, Service/Ingress/compose/nginx routing | Management port on loopback and absent from Service/Ingress; a network policy in the repo restricting it | "It's on an internal port" with no binding evidence |
| Transport/adapter gap | Per-message or per-method dispatch; whether the adapter goes through the server's interceptor chain | A per-message check in a shared dispatcher; a stream interceptor in the chain option; the gateway dials the server over a client connection | Handshake-time auth for per-message authority |

Outcome rules (README §4.2): **refuted** needs a cited control that covers
*this row's* request; absence of an attack is not a refutation; a sibling's
safety never decides another row. **Plausible** survives as a question when
the open fact is deployment-side. **Excluded** only for the lens's listed
classes, and "public by design" needs evidence from code, sibling convention
or the threat model, never the PR description.

### 3. Overlap and boundaries

**Ownership decision needed (README §3).** As README §3 stands,
`pass-sec-access` is "the absence hunter" with sibling comparison and
CWE-306/862. This lens does the same job more thoroughly, so every
unguarded route would be reported twice. Recommendation: **narrow
`pass-sec-access` to object-level authorization** — IDOR/BOLA, ownership,
tenant keys on queries, mass assignment, CSRF and CORS policy
(CWE-639/863/915/352) — and move CWE-306/862 and route-level sibling
comparison here. Access keeps a sibling diff only for *ownership* checks
("these three handlers filter by `org_id`, this one does not"). If the
owner prefers one lens, merge this worksheet into access as its first half;
splitting is still better for cost, because access is planned on far fewer
triggers once it no longer owns route coverage.

**`pass-security` in the security profile.** Seeds are frozen and addenda
only add text, so nothing "replaces" its sentence on new endpoints. Two
mechanisms, both proposed: (a) a security-profile addendum scoped to
`pass-security` that says "missing authentication on an entry point is
`pass-sec-authn-coverage`'s; do not report it here" (the same muzzle shape
`ecosystem.ts:270` describes for `pass-data-safety`); (b) the validator's
existing duplicate merge as the backstop, keyed on `sink` file:line.

Other neighbours:
- **pass-sec-privesc** owns the logic of permitted escalation: role-grant
  endpoints, invites, approval flows. An *unguarded* role-grant route is
  anchored here; a *guarded but weak* one goes there (privesc draft
  B3 agrees).
- **pass-sec-tokens** owns verification correctness and lifecycle. This lens
  claims only "no verifier on this path at all" and "the check does not stop
  the request"; tokens B3 draws the same line.
- **pass-sec-toctou** owns checks that read a different state than the one
  acted on. "Guard after the first effect" is ordering inside one request,
  so it stays here.
- **pass-sec-infra** owns firewalls, security groups and network policies
  existing and being attached. This lens reads bind, Service, compose and
  ingress config only to fill the `listener` cell. "The admin route is
  public" and "the backend is reachable around the gateway's auth" anchor
  here; "the security group allows 0.0.0.0/0 on 8081" anchors there. IaC
  *auth* settings (`AuthType: NONE`, `AuthorizationType: NONE`, `allUsers`
  invoker) are entry-point auth cells, so they are here; IaC *network*
  settings are infra.
- **pass-sec-iam** owns the platform grant graph (cloud IAM, trust and
  federation, k8s RBAC, sudoers). An invoker binding to `allUsers` or
  `allAuthenticatedUsers` is an entry-point auth cell, so it is here; the
  same members on a role, service account or identity are iam's.
- **pass-sec-exploit-chain** consumes this lens's unguarded rows as first
  links (its §5). This lens never chains.
- **pass-sec-injection, -boundaries, -secrets-data, -llm**: an unguarded row
  whose sink is an injection, SSRF or secret dump gets one finding here for
  the missing guard; the sink lens owns the sink.
- **pass-sec-supply-chain** owns framework *versions* with known auth-bypass
  advisories (Next.js < 15.2.3, < 14.2.15; Shiro; Spring Security). This
  lens uses the version only to choose matcher semantics.
- **pass-sec-variant** hunts unguarded siblings repo-wide when a PR adds a
  guard to one route. This lens's sibling diff stays local to the in-scope
  rows.
- **pass-bounds** owns exhaustion; **pass-concurrency** owns interleavings.

### 4. Motivating incidents

- CVE-2025-29927, Next.js: a client-sent `x-middleware-subrequest` header
  skipped middleware-based authorization —
  https://github.com/vercel/next.js/security/advisories/GHSA-f82v-jwr5-mffw
- CVE-2024-51479, Next.js: pathname-based middleware authorization bypassed
  for pages directly under the root; fixed in 14.2.15 —
  https://github.com/vercel/next.js/security/advisories/GHSA-7gfc-8cq8-jh5f ,
  https://advisories.gitlab.com/npm/next/CVE-2024-51479/
- CVE-2024-0012, PAN-OS: one nginx `location` did not overwrite
  `X-PAN-AUTHCHECK`, so a client-sent `off` skipped PHP auth —
  https://security.paloaltonetworks.com/CVE-2024-0012 ,
  https://labs.watchtowr.com/pots-and-pans-aka-an-sslvpn-palo-alto-pan-os-cve-2024-0012-and-cve-2024-9474/
- CVE-2022-1388, F5 BIG-IP: the `Connection` hop-by-hop header stripped
  `X-F5-Auth-Token` after the front check; the backend trusted a localhost
  `Host` —
  https://www.horizon3.ai/attack-research/disclosures/f5-icontrol-rest-endpoint-authentication-bypass-technical-deep-dive/
- CVE-2022-40684, FortiOS: alternate-path (CWE-288) admin auth bypass —
  https://www.fortiguard.com/psirt/FG-IR-22-377
- CVE-2023-46805, Ivanti Connect Secure: a `strncmp` prefix allowlist plus
  `../` reached `/api/v1/system/...` unauthenticated —
  https://www.rapid7.com/blog/post/ra-cve-2023-46805-analysis/
- CVE-2024-27198/27199, TeamCity: `;.jsp` path parameter plus a view
  rewrite, and `..` under public prefixes —
  https://www.rapid7.com/blog/post/2024/03/04/etr-cve-2024-27198-and-cve-2024-27199-jetbrains-teamcity-multiple-authentication-bypass-vulnerabilities-fixed/
- CVE-2023-22515, Confluence: `/setup/*` routes stayed reachable after
  install and created admin accounts —
  https://confluence.atlassian.com/security/cve-2023-22515-broken-access-control-vulnerability-in-confluence-data-center-and-server-1295682276.html
- CVE-2018-14773, Symfony: `X-Original-URL`/`X-Rewrite-URL` changed the
  routed path behind a front rule that matched the real URL; support was
  removed — https://nvd.nist.gov/vuln/detail/CVE-2018-14773 ,
  https://github.com/symfony/http-foundation/commit/5034dad837fee21b96b88e765e5df73181e1fc3e
- Apache Shiro CVE-2010-3863, CVE-2020-1957 and successors: no
  canonicalisation before the rule check —
  https://shiro.apache.org/security-reports.html
- Spring Security CVE-2022-22978 (`RegexRequestMatcher` `.` bypass) and
  CVE-2023-34035 (matchers applied to the wrong servlet) —
  https://spring.io/security/cve-2022-22978 ,
  https://spring.io/security/cve-2023-34035
- GitHub OAuth, 2019: Rails sent `HEAD` to the `GET` route; the
  controller's `if request.get?` else-branch granted access without CSRF —
  https://blog.teddykatz.com/2019/11/05/github-oauth-bypass.html
- OWASP API9:2023 scenario: a beta host lacked production's protection —
  https://api-security.owasp.org/editions/2023/en/0xa9-improper-inventory-management
- Our own data (README §9.2): a WebSocket room joined with no role check,
  hidden as "pre-existing" although the PR made it reachable.

Standards and platform facts behind the worksheet:
- OWASP ASVS 5.0 V8.2.1, V8.3.1, V4.1.3, V4.1.4, V4.4.3–4, V13.4.2/13.4.5 —
  https://github.com/OWASP/ASVS/tree/master/5.0/en
- OWASP API5:2023 BFLA —
  https://api-security.owasp.org/editions/2023/en/0xa5-broken-function-level-authorization
- OWASP GraphQL Cheat Sheet —
  https://cheatsheetseries.owasp.org/cheatsheets/GraphQL_Cheat_Sheet.html
- CWE-306/862/288/647/698/636/290/489 —
  https://cwe.mitre.org/data/definitions/306.html ,
  https://cwe.mitre.org/data/definitions/862.html ,
  https://cwe.mitre.org/data/definitions/288.html ,
  https://cwe.mitre.org/data/definitions/647.html ,
  https://cwe.mitre.org/data/definitions/698.html ,
  https://cwe.mitre.org/data/definitions/636.html
- Step 7, unset secret: Vercel's cron docs compare `Authorization` to
  `Bearer ${CRON_SECRET}`; an unset env var makes a naive comparison
  `"Bearer undefined"` —
  https://vercel.com/docs/cron-jobs/manage-cron-jobs
- Step 2, IaC-declared endpoints: Lambda function URL `AuthType: NONE` —
  https://docs.aws.amazon.com/lambda/latest/dg/urls-auth.html ; Cloud Run
  public access via `allUsers` invoker —
  https://cloud.google.com/run/docs/authenticating/public ; Supabase RLS —
  https://supabase.com/docs/guides/database/postgres/row-level-security ;
  Firebase insecure rules — https://firebase.google.com/docs/rules/insecure-rules
- Step 10, grpc-gateway in-process registration calls the server directly,
  so gRPC interceptors do not run (the generated comment warns that "many
  gRPC library features will stop working") —
  https://pkg.go.dev/github.com/go-coldbrew/interceptors
- Framework semantics (used in §2): gin
  https://github.com/gin-gonic/gin/blob/master/routergroup.go ; ASP.NET
  https://learn.microsoft.com/en-us/aspnet/core/mvc/security/authorization/simple ,
  https://learn.microsoft.com/en-us/aspnet/core/security/authorization/secure-data ;
  DRF https://www.django-rest-framework.org/api-guide/permissions/ ; Django
  https://docs.djangoproject.com/en/5.1/ref/middleware/#django.contrib.auth.middleware.LoginRequiredMiddleware ;
  Nest https://docs.nestjs.com/guards ; Next.js
  https://nextjs.org/docs/app/guides/data-security ; Socket.IO
  https://socket.io/docs/v4/middlewares/ ; Go pprof
  https://pkg.go.dev/net/http/pprof ; Spring Boot actuator
  https://docs.spring.io/spring-boot/reference/actuator/endpoints.html ;
  App Engine cron headers
  https://docs.cloud.google.com/appengine/docs/standard/scheduling-jobs-with-cron-yaml ;
  IAP signed headers https://docs.cloud.google.com/iap/docs/signed-headers-howto

### 5. What a read-only reviewer cannot establish

- **Deployed topology**: whether a gateway, WAF, ingress or mesh enforces
  auth, strips a header or normalises a URL, unless the config is in the
  repo. Most 0.4–0.7 rows come from here.
- **Dynamic routes**: registered from a database, plugin discovery,
  reflection or generated code. Step 2 makes the lens say the table is
  incomplete instead of a confident `NONE`.
- **Runtime framework normalisation** when the lockfile is absent or the
  container pins another version (step 6 caps these at 0.7).
- **Authorization in another service** — ZeroPath's main IDOR false-positive
  source (industry.md §3).
- **Broker ACLs** — which is why step 10 reports queue consumers only with
  an in-repo less trusted producer.

What could cover these outside the LLM:
- **A deterministic route inventory, daemon-side and static.** Tree-sitter
  or Semgrep rules per framework extract `(method, path, file:line,
  decorators, group)` at base and head; the daemon diffs them and hands the
  lens the changed rows and their siblings' guard sets. This executes
  nothing, makes step 2 a given rather than recall, and makes the 30-row cap
  rarely bind. An OpenAPI diff does the same for `security: []`.
- **Threat-model facts as operator input** (`.qcr/threat-model.md`): public
  listeners, what the gateway enforces, which headers the edge strips. Turns
  0.4–0.7 rows into confirmed or refuted.
- **Operator-side DAST** against staging with normalisation and
  method-override variants. The `bypass` field names the request; the
  reviewer never sends it.

### 6. How to evaluate it

Defect shapes, each a minimal PR seeded into a real repo with a benign twin:

1. A new route in a guarded controller without its siblings' decorator
   (Nest, DRF, Rails `skip_before_action` widened by `except:`).
2. `app.use(auth)` moved below a route registration (Express, gin).
3. A `startsWith("/public")` allowlist or unanchored regex over-matching a
   new protected route.
4. A verifier that calls `next()` on a missing header, or swallows a JWKS
   error.
5. `http.Error(w, …, 401)` with no `return`; Express `res.status(401).send()`
   then `next()`.
6. `req.headers['x-admin-key'] === process.env.ADMIN_KEY` with the env var
   absent from the deploy config.
7. A guard checking `session.userId` while `mfaPassed` is checked only on
   one page.
8. `jwt.decode` replacing `jwt.verify`; `auto_error=False` with no `None`
   check on a mutating route.
9. A gRPC streaming method with only a unary interceptor; a grpc-gateway
   `Register…HandlerServer` beside an auth interceptor.
10. A new WebSocket event changing room or tenant without the role check.
11. A webhook or Vercel cron route verifying the secret only when present.
12. `import _ "net/http/pprof"` on `DefaultServeMux`; actuator
    `include=*` with a custom filter chain; `express.static(".")`.
13. A Next.js `matcher` that excludes `/api` or `_next`; a server action with
    no auth inside.
14. `/api/v2` added without `/api/v1`'s guard.
15. A Lambda function URL or API Gateway method with `AuthType: NONE`; a
    Supabase table with RLS disabled.
16. An Ingress with `auth-url` beside `Service type: LoadBalancer` for the
    same backend.
17. `if (process.env.NODE_ENV !== 'production') app.use('/__test/login-as', …)`
    in a container that never sets `NODE_ENV`.
18. `X-Forwarded-For == 127.0.0.1` gating an admin route.

**Benign controls** carry equal weight, because they measure the
false-block rate: login, health and OAuth callback routes; guards moved but
still effective; an HMAC-verified webhook beside session-guarded siblings;
MSW handlers and Storybook mocks; `X-Forwarded-For` used only for logging
or rate limiting; a public catalog `GET` whose data the home page renders;
`jwt.decode` reading `kid` before a verify; a DRF view inheriting a guarded
base class.

Ground truth beyond seeding: the CWE-862/306/288 subset of the 22
`pass-sec-access` defects in README §9.1, and fix commits of the public
incidents above replayed as the vulnerable-introducing PR. SecPRBench is
C/C++/Rust and does not fit this class.

Score row recall beside finding recall: did the coverage table list the
changed entry point? The notes are stored, so this needs no extra run. Score
per defect shape, so a weak transport (WebSocket, gRPC, IaC) shows as its
own gap, and track trigger precision on the benign set separately from the
lens's false-block rate.

### 7. Critique log

Accepted in full: red-team 1–15 and its step notes (2 stop rule, 4↔5
reorder, 6 per-hop line, 7 named exits, 9 reachability for every row, 11
counter-check); precision §1 (ownership, §3 above), §2 (steps 2, 6, 8 and
10 narrowed), §3 exclusions, §4 severity, §6 triggers, §7 triggers, §8
benign twins. Rejected or changed:

- **Precision §5, trim the evidence block to nine fields dropping
  `source`/`boundary`/`path`:** rejected. Those three are README §4.1's
  shared fields, which the validator labels line by line; dropped instead
  the lens-only duplicates (`entry` folded into `source`, `chain` into
  `path`, `public-by` into `controls`) — ten fields.
- **Precision §5, move framework trivia to framework-keyed addenda selected
  by `ecosystem.ts`:** partly rejected. `ecosystem.ts` has exactly two
  implementations (Django, none) and selects no addenda; building that is a
  seam change. Moved the trivia to the validator table (§2), which needs it
  to refute, and kept one principle per step in the lens.
- **Precision §5, cut the CWE list to 306/862/288/647/636/290/489:** kept
  that list and added 698 for the red-team's unterminated-reject variant.
- **Precision §5, cut "chi panics on `Use` after routes":** accepted for the
  lens; it stays in the validator table, where it refutes an ordering claim.
- **Precision §2, cap the table at ~30 rows:** accepted, with the red-team's
  stop rule — the lens must name what it left out, so a cap never reads as
  coverage.
- **Precision §3, exclude `/metrics` and readiness outright:** narrowed —
  still a finding when public and the payload carries secrets, env or heap
  (actuator `env`/`heapdump`).
- **Precision §3, "different mechanism by design" as an exclusion:** made a
  sibling-diff rule instead, because the red-team's items 2 and 7 show the
  different mechanism itself can fail open (unset secret, signature checked
  only when present).
- **Precision §7, `Depends(` as a probe:** narrowed to `Depends(` with an
  auth-shaped name, because bare `Depends(` fires on every FastAPI file.
- **Precision §6, exclude `app/` files with `"use client"`:** not
  implementable in the glob tier (no file content); handled instead by the
  server-side probe spellings, and noted as a gap.
- **Red-team 14, `/_next/data` and CVE-2024-51479:** the `_next` matcher
  clause went into step 10; the CVE itself is a version advisory, so it is
  cited in §4 and owned by `pass-sec-supply-chain`.

### 8. Open questions for the owner

1. Narrow `pass-sec-access` to object-level authorization and move
   CWE-306/862 and route-level sibling diff here (recommended), or merge the
   two lenses?
2. Mute `pass-security`'s missing-authentication check by a security-profile
   addendum, or rely on the validator's duplicate merge alone?
3. Build the `CONFIG_FILE_RE` probe set in `heuristics.ts` (so `.tf`,
   `.yaml` and `.sql` auth settings plan this lens), or rely on the glob
   tier and named files only?
4. Is the ~30-row cap right, or should a global-middleware change plan the
   lens at a higher tier with a larger cap?
5. Build the daemon-side static route inventory (§5) before or after
   shipping the lens? It would replace step 2's recall with a given.
