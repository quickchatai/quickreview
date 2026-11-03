<!-- Synthesis of the six deep-lens drafts, 2026-11-02. Written before revision 2 (pass-sec-iam, gap patches); README §11 is the current summary. -->

# Security profile: how the six deep lenses fit together

All six drafts are in `docs/research/security-review/lenses/`. I checked the orchestration against `packages/pi-plugin/src/planner.ts`, `packages/pi-plugin/src/templates.ts`, `packages/pi-plugin/src/types.ts`, `prompts/round-first.md` and `docs/single-shepherd-invariant.md`.

## 1. Who owns what when two lenses overlap

Rule for every pair: **the lens whose fix closes the defect owns it**. If both still claim it, the validator merges them on the sink `file:line`, the owner's tag goes first and the other lens's tag is added after it.

| Pair | Owner | Tie-break rule |
|---|---|---|
| authn-coverage × access | authn-coverage: routes with no authentication, function-level authz, sibling guard diff (CWE-306/862) | access keeps object-level checks: IDOR/BOLA, tenant keys, ordinary mass assignment, CSRF/CORS |
| authn-coverage × privesc | authn-coverage when the grant route has **no authentication at all**; privesc when it is authenticated but the role gate is weak | The two drafts conflict today (privesc anchors "at the write"). Rule: fixed by adding a guard → authn-coverage; fixed by tightening a role check → privesc |
| authn-coverage × tokens | authn-coverage: no verifier, decode-only, a result that does not stop the request, a trusted identity header | tokens: a verifier that runs but accepts too much. An empty secret: verification skipped → authn-coverage; a check runs with an empty key → tokens |
| authn-coverage × infra | authn-coverage: IaC auth cells (`AuthType: NONE`, `allUsers` invoker, backend reachable around the gateway's auth) | infra: network controls (SG/NSG/NetworkPolicy/firewall) |
| authn-coverage × toctou | authn-coverage: a guard that runs after the first effect in the same request | toctou: a check that reads a different state from the one the use acts on |
| privesc × access | privesc: authority writes and mass assignment of the six privileged fields | access: everything else bound from input |
| privesc × tokens | Split by where the role is held: in a credential (JWT claim, session field, API-key record) → tokens; in a server cache → privesc | privesc keeps "the requester chooses the minted scope" and default roles for new principals |
| privesc × toctou | toctou: races past a ceiling or last-admin check, invite-accept races | privesc: "the accept request picks the role" (no race). Toctou drops its cached-authority bullet |
| privesc × infra × tokens (CI OIDC `sub`, IAM, RBAC, sudoers) | **Nobody owns this today.** Infra hands it to privesc, privesc's revision handed it to infra, tokens hands it to infra | Move it to a new **`pass-sec-iam`** lens (§2). tokens keeps workload-token lifetime only |
| privesc × widened | privesc, when the value a deny-list admits is a role | widened otherwise |
| tokens × toctou | toctou: double redemption, atomic consume, parser differentials | tokens: a token never consumed; SAML wrapping inside one parser |
| tokens × secrets-data | secrets-data: literals, logs, responses | tokens: a token placed in a URL, plaintext API-key tables |
| tokens × boundaries / injection | boundaries: SSRF via `jku`/`x5u`; injection: `kid` or `$ne` reaching a query | tokens: an attacker-chosen key that leads to forgery |
| toctou × concurrency | toctou, when the hunk has a security-asset word and the effect is a security effect | concurrency: lost or duplicated data |
| toctou × boundaries | boundaries: canonicalisation order, DNS rebinding, symlinks in general | toctou: a privileged check-then-open where a lower principal can swap the path |
| toctou × supply-chain | supply-chain: pwn-request, unpinned actions, digest vs tag | toctou: only an approval or label gate followed by a checkout of a mutable ref |
| infra × supply-chain | supply-chain: `FROM`, workflows, install scripts | infra: runtime privilege (`USER root`, `privileged`, hostPath) |
| infra × bounds | bounds: DEBUG output and error leakage | infra: actuator or pprof exposed through config. A debug route registered in code → authn-coverage |
| infra × secrets-data | secrets-data: credential literals | infra: an exposed store (tfstate, a public bucket), a plane with auth switched off |
| infra × boundaries | boundaries: SSRF in code | infra: IMDS settings and node-credential reach |
| exploit-chain × every class lens | The class lens owns any single hop | The chain lens owns only a composition of 2 or more hops that reaches a goal no single hop reaches. It references the class lens's rows and never re-posts them |
| pass-security × the whole family | The family | In the security profile pass-security is not planned (see §2). If the owner keeps it, it needs an addendum that defers to the family |
| bounds × security family | bounds: limits and exhaustion | DoS is excluded as a chain hop. A limit overrun reached through parallel requests belongs to toctou |

## 2. Merge or split, and the final roster

- The deep lenses **sit beside `pass-sec-access`**. They do not replace it.
- `access` is narrowed to object-level authorization. Route coverage moves to authn-coverage, privileged-field binding moves to privesc.
- Merging access into authn-coverage would plan object checks on every route-shaped PR. Splitting is cheaper.
- One split is needed: **`pass-sec-iam`**, for privilege escalation on the platform. Today it has no home. Its content already exists in infra Part B's handoff list and in privesc's cut third, so it is mostly assembly.
- `pass-security` is replaced in the security profile. That fits the §8 ruling. Note it is in `risk_passes`, so the profile has to override `risk_passes` as well as `skip_lenses`. The owner should ratify this against the keep-all-lenses rule.

| Lens | Remit |
|---|---|
| `pass-sec-authn-coverage` | Every entry point: effective authentication, function-level authz, matcher vs router, checks that do not stop the request |
| `pass-sec-access` (narrowed) | May this principal touch this object: IDOR/BOLA, tenant keys, ordinary mass assignment, CSRF/CORS |
| `pass-sec-privesc` | Application role model: grant sinks, ceilings, invites, SSO/SCIM binding, bootstrap, weakly protected permitted escalation |
| `pass-sec-iam` (new) | Platform grant graph: cloud IAM, trust and federation (CI OIDC `sub`/`aud`, WIF), k8s RBAC, sudoers, setuid, docker group |
| `pass-sec-tokens` | Credential verification, claims, lifecycle, rotation and revocation, OAuth/OIDC/SAML |
| `pass-sec-toctou` | A check and its use bound to different state, time or representation, with an attacker-driven second actor |
| `pass-sec-infra` | Who can reach what: a network control that is declared, enabled, attached and covers the path; exposure; runtime privilege |
| `pass-sec-exploit-chain` | Compositions of 2–6 hops to a goal above the persona's starting authority, one row per strategy |
| `pass-sec-injection` / `-boundaries` / `-secrets-data` / `-supply-chain` / `-llm` / `-variant` | As in README §3. boundaries names DNS rebinding as its own |
| `pass-bounds` | Unchanged; joins the risk tier |
| `pass-concurrency` | Unchanged; races with a security effect defer to toctou |

## 3. Running pass-sec-exploit-chain inside a round

Facts checked in the code:
- Two launchers only: the engine starts the planned discovery wave, and the PR's main session launches everything else, including the validator.
- `pass-validate` runs only after every discovery pass has returned (`round-first.md:183,292`).
- `slowestFirst` puts risk rows in class 0 (`planner.ts:446-476`).
- There is a precedent for a post-discovery row: `renderCoverageNote` (`templates.ts:663`), rendered as `{{intent_note}}{{coverage_note}}` at the end of step 2.
- `round-first.md` and `round-follow-up.md` are not seeded (`seeds/prompts/` holds only three files), so adding a placeholder is an allowed edit.

Proposed flow:
1. **`delta`, `forward` and `backward`** are ordinary discovery-wave rows, one `PassPlanEntry` per strategy. They are risk-tier and class 0, and add no latency.
2. **`compose`** is a plan row the engine's wave skips. `renderChainNote` → `{{chain_note}}`, placed after `{{coverage_note}}`, tells the main session to:
   - collect the security-family candidates after every lens and coverage row has returned, before step 3;
   - number them `L1…Ln` under `CHAIN LEADS`;
   - launch one `compose` run;
   - log `CHAIN-SKIPPED no leads` when there are none.

   This keeps S2: the daemon renders a note and schedules nothing. It keeps S3: only the main session launches it, and the lens stays a leaf.
3. **Two conflicts in the code:**
   - `required` is set per lens (`types.ts:128`). If exploit-chain joins `risk_passes`, a failed `compose` requeues the whole round (`requiredpasses.ts`). That contradicts the draft's "report it, don't retry". Fix: `required` only on `delta`; the other strategies report "did not complete" in the review body.
   - `leanFollowUpPlan` keeps required rows, so a follow-up round keeps `delta` and drops the rest. That is acceptable.

**Validator changes, chains:**
- Re-check every lead a chain uses before the chain itself, then label each hop `valid`, `plausible` or `contradicted`.
- Compute the outcome in code from the hop labels: all valid → confirmed; one plausible → question; two or more → `partial-chain` (stored, never posted); any contradicted → refuted.
- Recompute severity mechanically from persona × goal × ui.
- Step 3 must never merge a chain into its leads. The chain lists its hops' rows, and each lead row gets "part of chain at …".
- `validator_shards` must keep a chain in the same shard as its leads.

**Validator changes, the other deep lenses:**
- One shared table of what does not count as counterevidence: the PR body, an edge control the repo does not contain, "unlikely".
- Label each line of the evidence block.
- Infra: a control counts only when it is cited as attached and enabled.
- Toctou: the scan skeptic's `[contrived-concurrency]` class (`include.ts:1363`) needs a carve-out for attacker-sent parallel or aliased requests.
- Tokens: read the library version from the lockfile before ruling on a verifier cell.
- privesc and authn-coverage: the anchor rule from §1.

## 4. Planning triggers, frequency and cost

The frequencies below are my **estimates, not measurements**: no runs were made. M25 measures them for free.

| Lens | Consolidated trigger | Web app, % of PRs | Infra repo, % of PRs |
|---|---|---|---|
| authn-coverage | route/controller/middleware/security-config globs; registration and guard probes over changed lines (removed lines too); config auth probes; threat-model entry points | 30–40 | 5–10 |
| access | handler/query files with a tenant or owner key; a recorded control changed | 20–30 | <5 |
| privesc | authority-field regex, grant APIs, role SQL/RLS, override and identity headers, bootstrap flags; removed authz lines; roles/invites/sso/scim dirs | 8–12 | <3 |
| iam (new) | IAM/policy JSON, trust or WIF blocks, `aws-auth`, Role/ClusterRole bindings, sudoers, Ansible groups, CI cloud-auth actions | 2–5 | 30–50 |
| tokens | JWT/JWKS receivers, verifier options (±), lifetime knobs, lifecycle words, single-use names, OAuth/SAML, token-library bumps; auth/identity dirs | 5–10 | 2–5 |
| toctou | serializer, uniqueness and consume probes **gated on a security-asset word**; read-then-write; CI gate then mutable checkout | 5–8 | 2–5 |
| infra | IaC/k8s/compose/proxy/firewall globs; port, attachment, selector and fail-open probes (±); forced when the threat model lists the control | 5–10 | 60–80 |
| chain `delta` | one removed-guard hit, or two trigger families, or a threat-model file | 15–25 | 40–60 |
| chain `forward` + `backward` | a threat-model file, or more than ~150 triggered server-side lines | 5–10 | 15–25 |
| chain `compose` | at least one security lead reached step 3 | 10–20 | 20–30 |

Cost, in extra risk-tier lens runs (README §3 lenses included):
- **Web app:** about 2.3 per PR on average, 4–6 on a triggered PR, up to ~10 on a large auth PR.
- **Infra repo:** about 2.9 per PR on average.
- **Both:** add +1 serial run on rounds where `compose` fires, plus the validator at the risk tier.

## 5. Mechanism changes beyond M1–M10

In build order:

| # | Change | Seam | Fence |
|---|---|---|---|
| M11 | Shared include `prompts/pass-sec-common.md`: evidence block, four outcomes, exclusions, persona-exposure severity matrix (privesc's 3×3 matrix moved over unchanged) | `include.ts` | `tests/include.test.ts`: every `pass-sec-*` composes it. MUTATION: drop the include from one lens — fails |
| M12 | Removed-line probes for built-in triggers, plus profile probes with `removed = true` (today wrapped `^\+`, `heuristics.ts:206`) | `heuristics.ts` | `tests/heuristics.test.ts`: a `-login_required` hunk plans `delta` |
| M13 | `CONFIG_FILE_RE` probe set for config files: IaC auth, ports, attachment fields | `heuristics.ts` | `tests/heuristics.test.ts` |
| M14 | `strategy?` and `stage?: "post-discovery"` on `PassPlanEntry`; one row per strategy; the engine's wave skips post-discovery rows | `types.ts`, `planner.ts`, `src/engine/lens/` | `tests/planner.test.ts`; `tests/single-shepherd.test.ts`. MUTATION: the engine launches `compose` — fails |
| M15 | Per-row `required`: only `delta` requeues a round; other security rows report "did not complete" in the review body | `requiredpasses.ts`, `verdicts.ts` | `tests/requiredpasses.test.ts` |
| M16 | `chain_compose` on `RoundOrder` + `renderChainNote` + `{{chain_note}}` in round-first.md and round-follow-up.md | `planner.ts`, `templates.ts`, both templates | Templates test: the note is empty without the flag, and the placeholder is present in both templates |
| M17 | Evidence parser, outcome computed in code from line and hop labels | new core `secevidence.ts`, called by `findingsrecord.ts` | `tests/secevidence.test.ts` table |
| M18 | `partial-chain` record-only state keyed by hop files; posting drops it; fed to a later `delta` as `UNCONFIRMED` | `findingsrecord.ts`, `postingpolicy.ts`, `planner.ts` | MUTATION: admit `partial-chain` in posting — fails |
| M19 | Validator addenda: chain hop adjudication with leads first, the no-counterevidence table, never merging a chain into a lead, shard affinity | `PASS_ADDENDA` (security profile), `templates.ts` shard note | `tests/include.test.ts`, shard test |
| M20 | Scan-skeptic security carve-out for attacker-driven races; scan `forward` per persona and `backward` per crown jewel; complete chains carried into file records | `include.ts` (mode: scan, M4), `scanrun.ts` | `tests/include.test.ts`, scan test |
| M21 | Threat-model fields: personas, crown jewels, network controls, DB isolation and process model, access-token TTL | M9 reader | `tests/threatmodel.test.ts` |
| M22 | Deterministic security pre-checks rendered as gate notes, cheapest first: removed guard → role-enum shift → uniqueness without an index → unattached SG / compose port on a ufw host / NetworkPolicy selector mismatch → static route inventory | new core `secprechecks.ts`, modelled on `ecosystem.ts` | Fixture tests, one per check |
| M23 | Per-strategy telemetry tag `pass-sec-exploit-chain:<strategy>` | `findingsrecord.ts`, `eod.ts` | Record test |
| M24 | Security-profile `risk_passes`/`skip_lenses` swap for `pass-security`, and access narrowed | `profiles/security/` | `tests/profile-inheritance.test.ts` |
| M25 | Trigger-rate replay: pure `buildPassPlan` over archived PR file lists, no model calls, to replace the §4 estimates | script over `planner.ts` | A fixture test |

**Decisions needed from the owner:**
- Create `pass-sec-iam`, or have infra take the platform grant graph.
- Ratify the authn-coverage / privesc anchor rule.
- Replace `pass-security` in the security profile.
- Make only `delta` a required row.
- The 4 citations in the exploit-chain and infra drafts that were not re-fetched.