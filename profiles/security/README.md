# security — a security-only review

`extends = "default"`, then makes the review a security review and nothing
else. Select it with `[review] profile = "security"` (or `--profile security`
for a one-shot review).

## What runs

- **The fourteen security lenses**, the `pass-sec-*` family. Each reads the
  change for one class of security defect and nothing else:

  | Lens | Looks for |
  |---|---|
  | `pass-sec-authn-coverage` | an entry point without the authentication or function-level authorization its siblings have |
  | `pass-sec-access` | one principal reaching another's object: IDOR, the tenant key, mass assignment, CSRF and CORS |
  | `pass-sec-privesc` | the application's role model: grants, invites, SSO and SCIM binding, override inputs, security-setting writes |
  | `pass-sec-iam` | the platform's grants: cloud IAM, trust and federation, cluster RBAC, sudoers, a `GRANT` a migration adds |
  | `pass-sec-tokens` | verifiers that accept too much, token lifetime, rotation, revocation, OAuth, OIDC, SAML, webhook signatures |
  | `pass-sec-toctou` | a check and its use bound to different state, with an attacker driving the second actor |
  | `pass-sec-injection` | input read as code or query: SQL, shell, templates, XSS, deserialization, eval |
  | `pass-sec-boundaries` | path traversal, uploads, archives, SSRF, open redirects, XXE, file permissions |
  | `pass-sec-secrets-data` | credential literals, secrets in logs and responses, personal data, weak cryptography |
  | `pass-sec-supply-chain` | dependency changes, install scripts, CI workflows and their token permissions, base images |
  | `pass-sec-llm` | untrusted text reaching a model, and model output reaching a sink with authority |
  | `pass-sec-infra` | who can reach what as the repository ships it: network controls, exposure, runtime privilege |
  | `pass-sec-variant` | unfixed siblings of a pattern the change fixes or introduces |
  | `pass-sec-exploit-chain` | two or more hops composed into a goal no single hop reaches |

- **The validator**, at `sol-high` whatever the preset says
  (`[lenses.pass-validate] min_tier`). Every security finding has to survive
  it, and it removes any candidate that is not a security defect.

## What does not run

Everything else. `[security] only = true` switches off every lens outside
the family and the validator: `pass-baseline`, `pass-bounds`, the general
`pass-security`, the per-file sweep, behaviour-delta, `pass-tests`, the
quality and style lenses and every content-triggered sub-lens. None of them
is planned or addable, and a repository's `.qcr/profile.toml` cannot switch
one back on. A lens added to the code later is off here too, with no edit
to this profile.

So **an APPROVE from this profile means "no security finding"**. It does
not mean the change is correct, tested or maintainable: nothing here looked.
Run the default profile on the same repository when you want that review
too.

## When each lens is planned

- **Every content trigger plans its lens** (`[security] triggers = "all"`):
  the strong signals (a removed guard, SQL built from input, a disabled
  signature check, a credential literal, a wildcard grant, …) and the weak
  ones (a new route, an outbound request on a variable, a lockfile change,
  an LLM call, …).
- **Four lenses are planned on every PR that changes code or config**
  (`plan = "always"`): authentication coverage, access, injection and
  secrets. A PR that changes only documentation, text or images plans none
  of them.
- **The exploit-chain lens** runs one row per strategy: `delta` (from the
  hop this change adds) whenever two or more family lenses are planned, a
  guard is removed or the change touches the threat model, and the only
  security row whose failure re-runs the round; `forward` and `backward` on
  a request, or when a threat model exists and a security trigger fired
  (the four `always` lenses alone do not count; the default profile also
  wants over 150 triggered server-side lines); and `compose`, after every
  other lens has returned, over this round's security leads, and only when
  there are any.
- **A threat model** (below) plans the lenses its entries name when the
  change touches them.

Every family lens runs at the risk tier (`sol-high`, one variant, slowest
first), as on every profile. A family row that fails is named in the review
body as "did not complete"; it never reads as clean.

## What posts

- Only security findings post (`[posting] scope = "security"`): every
  other survivor, a `[blocker]` included, is withheld with the word
  `security-scope`. The validator kills every non-security candidate
  `out-of-scope` first, and posting withholds whatever it missed. A real
  security defect whose lens says nothing of security is recorded with a
  `security` kind, so it posts.
- Security findings have their own budget of eight comments
  (`security_max = 8`), apart from any comment cap.
- A security finding the validator cannot settle by reading survives as a
  question naming the gap (`[security] fold = true`), never as a silent
  kill. A refutation must cite the line that contradicts it.

## The threat model

A threat model tells the lenses where the entry points, controls and sinks
are, who the attackers are and what they want. The review reads one of two,
and the repository's wins:

1. `.qcr/threat-model.md` in the reviewed repository, read from the **base**
   branch, so a pull request cannot write its own.
2. `threat-model.md` in a profile in your config home that extends this one
   (`extends = "security"`): private to your install. The nearest profile
   in the chain that carries one wins.

Start from [`threat-model.example.md`](threat-model.example.md): copy it to
either place and rewrite every entry. The example itself is never read.
Every entry is a claim the lenses check against the code, never proof.
With no threat model the review still runs; it plans from the change alone.

## Scans

A scan under this profile is a deep security scan:

- only the family runs (`[scan] lenses`), and only security findings are
  kept (`[scan] kinds`);
- six lenses read every file stage 1 reads (`[scan] deep_lenses`):
  authentication coverage, access, injection, boundaries, secrets and
  variant;
- stage 1 reports security defects only and points only security lenses
  (the `scan-stage1-security` addendum);
- the scan reads the threat model from the scanned tree's
  `.qcr/threat-model.md`, else this profile chain's copy. When neither
  exists, the scan drafts one first (stage 0, `[scan] threat_model =
  "auto"`): the preview offers it at its price, the scan starts once it has
  run, and the draft — in the state home, never in the repository — is
  read labelled DRAFT wherever it is shown. Read it, correct it and commit
  it as `.qcr/threat-model.md` to make it the repository's. Under
  `threat_model = "always"` with a model already there, stage 0 still runs
  at every new sha, but its draft is only a revision for a person to adopt:
  the scan keeps reading the existing model.

## Cost

Every family row runs at `sol-high`. On any PR that changes code or config
that is at least five lens runs (the four planned always, and the chain's
`delta`), plus the validator, plus one `compose` run after them when the
round has security leads — a candidate raised by a family lens or of a
security kind. A round with none skips `compose`. The design estimate is
four to six family runs on a PR that fires a trigger and up to about ten
on a large authentication change. These numbers are estimates, not
measurements. A security-only review skips the general lenses, so a PR
with no security surface costs less than a default review; one with a
large surface can cost more.

## Without this profile

The default profile already runs part of the family. A strong trigger plans
its family lens at the risk tier (`[security] triggers = "strong"`), and a
security review can be asked for on any PR, on top of the default plan:

- the `qcr:security` label (`[security] label` in config.toml);
- a `@<bot> security` comment from an owner, member or collaborator
  (`[security] command`);
- `qcr review-now <pr> --security` from the operator;
- `/qcr-review --security` in pi, or `qcr review --security` in the terminal.

A request plans the whole family, but never a lens a profile switched off.
