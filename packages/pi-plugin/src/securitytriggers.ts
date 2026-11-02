// Security triggers: which lenses of the security family a PR's content
// plans, and which exploit-chain strategies follow from them.
//
// The family's lenses are planned by what the diff SAYS, never only by where
// it lives: a path-only trigger misses most security defects, and a guard
// taken away has no filename at all. So each trigger is a probe over one side
// of the patch — added code, removed lines, added configuration — or, for the
// weak signals alone, a changed path.
//
// Two strengths:
//   strong   a shape that is a security question on its own: a guard removed
//            and not put back, interpolated SQL, a shell, an unsafe
//            deserializer, an escape hatch out of HTML escaping, a disabled
//            signature or certificate check, an attacker-written workflow
//            expression, a credential, a world-open ingress, a wildcard
//            grant, a role written from request input, a threat-model hit,
//            a profile probe, a deterministic security fact.
//            These plan in the default profile (`[security] triggers =
//            "strong"`).
//   weak     a surface where a security defect may live: a route, a tenant
//            key in a query, outbound HTTP, an LLM call, a manifest, …
//            Planned only with `triggers = "all"` (the security profile).
//
// `selectSecurityLenses` never plans a lens a profile switched off; the
// planner applies `enabled = false` and `skip_lenses` after it, as for every
// lens. It never touches `selectLenses` either: the generic selection is
// frozen against a legacy copy of itself (tests/heuristics.test.ts).
//
// Pure: the planner passes the files, the threat model and the facts in.

import type { PrFileEntry } from "./githubcore.js";
import {
  addedCode,
  addedConfig,
  CODE_FILE_RE,
  CONFIG_FILE_RE,
  DEPS_MANIFEST_RE,
  diffSide,
  EMPTY_HEURISTICS,
  isTestFile,
  removedCode,
  type HeuristicsExtension,
} from "./heuristics.js";
import { CHAIN_PASS, SECURITY_FAMILY, type ChainStrategy } from "./passes.js";
import type { SecurityTriggerMode } from "./reviewconfig.js";
import type { SecurityFact } from "./secfacts.js";
import { threatModelHits, type ThreatModel } from "./threatmodel.js";

export interface SecurityTrigger {
  lens: string;
  strength: "strong" | "weak";
  /** What the probe reads:
   *  - `added`   the added lines of a patched file;
   *  - `removed` the removed lines of a patched file — and a hit counts only
   *              when the matched text is not added back in the same file
   *              (a moved decorator is not a removed one);
   *  - `config`  the added lines of a configuration file (`CONFIG_FILE_RE`);
   *  - `path`    a changed filename (`re` is tested against it).
   * `added` and `removed` read non-test CODE files unless `files` is set:
   * then every patched file whose name matches `files` (code or not). */
  probe: "added" | "removed" | "config" | "path";
  /** Tested against the file's chosen lines with their signs stripped,
   * joined by newlines (so `^`/`$` with the `m` flag are line anchors, and a
   * pattern may span lines of one file). Never global. */
  re: RegExp;
  /** Narrows the population by filename (and, for `added`/`removed`, widens
   * it past code files — see `probe`). */
  files?: RegExp;
  /** Test files count too (a literal credential is a leak wherever it sits). */
  tests?: true;
  /** The reason never quotes the matched line (it may be the secret). */
  redact?: true;
  /** A hit also selects `pass-sec-exploit-chain`: the change opens a hop. */
  chain?: true;
  /** What fired, for the plan: "<why> in <file>". */
  why: string;
}

// ---- strong probes ---------------------------------------------------------

/** A guard: an authentication or authorisation check, or a verification,
 * whose removal leaves something unguarded. The same markers as the
 * `removed-guard` security fact (secfacts.ts), which a planner with facts
 * passes in as well. */
const GUARD_RE =
  /\blogin_required\b|\bpermission_required\b|\bpermission_classes\b|\bauthentication_classes\b|\bIs(?:Authenticated|AdminUser)\w*|@UseGuards\b|@(?:PreAuthorize|PostAuthorize|Secured|RolesAllowed)\b|\[Authorize\b|\b(?:load_and_)?authorize(?:_resource\b|!|\()|\b[rR]equire_?(?:[aA]uth\w*|[lL]ogin|[aA]dmin|[rR]ole|[pP]ermission)s?\b|\b(?:before_action|before_filter|prepend_before_action)\s+:(?:authenticate\w*|authorize\w*|require_login|ensure_\w*(?:auth|admin|login)\w*)|\b(?:auth|jwt|fresh_jwt|token|admin|staff_member)_required\b|\brequires_auth\w*|\b(?:ensure|is)Authenticated\b|\bpassport\.authenticate\b|\b\w*[Aa]uth\w*[Mm]iddleware\b|\.(?:authenticated|hasRole|hasAnyRole|hasAuthority|hasAnyAuthority)\(|\bverify\s*=(?!=)(?!\s*(?:False|false|0)\b)\s*\S+/;

/** A SQL statement inside a string: the keyword in capitals and the shape
 * after it, so prose that says "select … from" is not SQL. */
const SQL = String.raw`(?:SELECT\b[^\n]*?\bFROM\b|INSERT\s+INTO\b|UPDATE\s+[\w."\x60\[\]]+\s+SET\b|DELETE\s+FROM\b)`;

/** Raw SQL built by interpolation: an f-string, a JS template, `+`
 * concatenation, `%` formatting, `.format(`, `Sprintf`/`String.format` —
 * never the parameterised `execute("… %s", (x,))`. */
const SQL_INTERPOLATION_RE = new RegExp(
  [
    // Python f-string carrying SQL and a placeholder
    String.raw`\b[fF][rR]?(["'])(?=[^\n]*?${SQL})(?=[^\n]*?\{)`,
    // JS/TS template literal carrying SQL and ${…} — untagged: a tag
    // (sql`…`) is how the query libraries parameterise
    String.raw`(?<![\w.)\]$])\x60(?=[^\x60\n]*?${SQL})(?=[^\x60\n]*?\$\{)`,
    // "… SQL …" + value
    String.raw`${SQL}[^\n]*?["'\x60]\s*\+\s*[\w(]`,
    // "… SQL … %s" % value — the operator, spaced; never a parameter tuple
    // and never a LIKE pattern ('%foo%')
    String.raw`${SQL}[^\n]*?["'](?:\s+%\s*|\s*%\s+)[\w(]`,
    // "… SQL …".format(…)
    String.raw`${SQL}[^\n]*?["']\.format\(`,
    // Go / Java / C# formatting into a statement
    String.raw`\b(?:Sprintf|String\.format|string\.Format)\(\s*[@$]?["'\x60][^\n]*?${SQL}`,
  ].join("|"),
);

/** A shell or an evaluator on a non-literal. A method named `exec`
 * (`pattern.exec(text)`) is not a call into a shell. */
const SHELL_EVAL_RE =
  /\bshell\s*=\s*True\b|\bshell:\s*true\b|\bexec\.Command(?:Context)?\((?:\s*ctx\s*,)?\s*"(?:sh|bash)"\s*,\s*"-c"|(?<![\w.$])(?:exec|eval)\s*\(\s*(?![\s"'`)])|\bos\.(?:system|popen)\(\s*(?!["'\s])|\b(?:child_process\.)?exec(?:Sync)?\(\s*`[^`\n]*\$\{|\b(?:child_process\.)?exec(?:Sync)?\(\s*["'][^"'\n]*["']\s*\+|\bRuntime\.getRuntime\(\)\.exec\(|\bProcessBuilder\(\s*["'](?:sh|bash|cmd(?:\.exe)?)["']/;

/** A deserializer that runs code from its input. */
const DESERIALIZE_RE =
  /\b(?:c?[pP]ickle|dill|shelve)\.loads?\(|\byaml\.(?:load|load_all)\((?![^)\n]*Safe)|\byaml\.unsafe_load\w*\(|\bjsonpickle\.decode\(|\bObjectInputStream\b|\bMarshal\.load\b|\bBinaryFormatter\b|(?<![\w.])unserialize\(|\bnode-serialize\b/;

/** An escape hatch out of HTML escaping, in code. */
const HTML_ESCAPE_HATCH_RE =
  /\bdangerouslySetInnerHTML\b|\b(?:mark_safe|Markup)\(\s*(?![\s"')])|\bv-html\b|\.(?:inner|outer)HTML\s*\+?=(?!=)\s*(?:`[^`\n]*\$\{|(?![\s"'`]))|\binsertAdjacentHTML\(|\.html_safe\b|\bbypassSecurityTrust\w*\(|\bdocument\.write(?:ln)?\(\s*(?![\s"'`)])/;

/** The same, in a template (`{{ x|safe }}`, `{% autoescape off %}`,
 * triple-stash and unescaped Blade/ERB output). */
const TEMPLATE_FILE_RE = /\.(?:html?|jinja2?|j2|njk|twig|hbs|handlebars|mustache|erb|liquid|ejs)$/i;
const TEMPLATE_ESCAPE_HATCH_RE = /\|\s*safe\b|\bautoescape\s+(?:off|false)\b|\{\{\{|\{!!|<%==|<%-/;

/** A disabled signature, expiry or certificate check. */
const DISABLED_VERIFY_RE =
  /\bverify\s*=\s*False\b|["']?verify_(?:signature|exp|aud|iss)["']?\s*[:=]\s*False\b|\balgorithms\s*[:=]\s*\[\s*["']none["']|\bignoreExpiration\s*:\s*true\b|\brejectUnauthorized\s*:\s*false\b|\bInsecureSkipVerify\s*:\s*true\b|\bNODE_TLS_REJECT_UNAUTHORIZED\b["']?\s*[:=]\s*["']?0\b|\bCERT_NONE\b|\bcheck_hostname\s*=\s*False\b|\bVERIFY_NONE\b|\bparseUnsecuredClaims\b|\bget_unverified_claims\b/;

/** CI workflows. */
const WORKFLOW_FILE_RE = /(^|\/)\.github\/workflows\/[^/]+\.ya?ml$/;
/** A workflow running on the base repository's secrets for a fork's code. */
const PULL_REQUEST_TARGET_RE = /\bpull_request_target\b/;
/** An attacker-written field (a title, a body, a branch name, a commit
 * message) expanded into a shell: on a `run:` line or inside a run block —
 * never as a mapping value (`env:`), which is the safe spelling. */
const WORKFLOW_INJECTION_RE =
  /^(?!\s*-?\s*(?!run:)[\w.-]+:(?:\s|$)).*\$\{\{\s*github\.(?:head_ref\b|event\.(?:pull_request|issue|comment|review|review_comment|discussion|discussion_comment|pages|commits|head_commit|workflow_run)\b)/m;

/** Credential shapes (the publishability lint's set): a GitHub token, a
 * private key block, an OpenAI-style key, a Slack token, an AWS key id. */
const CREDENTIAL_RE =
  /\b(?:gh[pousr]_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{22,})|-{5}BEGIN (?:[A-Z]+ )*PRIVATE KEY-{5}|\bsk-[A-Za-z0-9_-]{32,}|\bxox[abpr]-[0-9A-Za-z-]{10,}|\bAKIA[0-9A-Z]{16}\b/;

/** Ingress open to every address (an egress rule to anywhere is normal). */
const OPEN_INGRESS_RE =
  /\bingress\b[\s\S]{0,400}?(?:0\.0\.0\.0\/0|::\/0)|\bSecurityGroupIngress\b[\s\S]{0,400}?CidrIp(?:v6)?:\s*["']?(?:0\.0\.0\.0\/0|::\/0)|\bsource_ranges\s*=\s*\[[^\]]*0\.0\.0\.0\/0|\bloadBalancerSourceRanges\b[\s\S]{0,80}?0\.0\.0\.0\/0/;
/** An endpoint or a resource published with no authentication. */
const NO_AUTH_RE =
  /\bAuthType:\s*["']?NONE\b|\bauthori[sz]ation(?:_type)?\s*=\s*["']NONE["']|\bauthorization_type\s*:\s*["']?NONE\b|\b(?:allUsers|allAuthenticatedUsers)\b|--allow-unauthenticated\b/;
/** A container or pod given the host. */
const PRIVILEGED_RE =
  /\bprivileged:\s*true\b|\bhost(?:Network|PID|IPC):\s*true\b|\ballowPrivilegeEscalation:\s*true\b|--privileged\b|\bnetwork_mode:\s*["']?host\b/;
const DOCKERFILE_RE = /(^|\/)(?:Dockerfile|Containerfile)[^/]*$/;
/** A container that runs as root, said outright. */
const USER_ROOT_RE = /^\s*USER\s+(?:root|0)(?::\S+)?\s*$/m;
/** A non-root user taken away: the container falls back to root. */
const USER_NONROOT_RE = /^\s*USER\s+(?!root\b|0\b)\S+/m;

/** A grant wide enough to be the escalation: a wildcard action or
 * principal, role passing, cluster-admin, the RBAC verbs that mint
 * privilege, passwordless sudo. */
const WILDCARD_GRANT_RE =
  /["']?Action["']?\s*[:=]\s*\[?\s*["']\*["']|\bactions\s*=\s*\[\s*"\*"\s*\]|\biam:PassRole\b|["']?(?:Principal|AWS)["']?\s*[:=]\s*\{?\s*["']?\*["']|\bkind:\s*ClusterRoleBinding\b[\s\S]{0,600}?\bname:\s*cluster-admin\b|^\s*verbs:\s*\[[^\]\n]*(?:\b(?:escalate|bind|impersonate)\b|["']\*["'])|^\s*-\s*["']?(?:escalate|bind|impersonate)["']?\s*$|\bNOPASSWD\b/m;
/** A database grant in a migration or SQL file. */
const SQL_GRANT_FILE_RE = /\.sql$|(^|\/)(?:migrations|db\/migrate|migrate)\//i;
const SQL_GRANT_RE = /\bGRANT\s+[^;\n]*?\bTO\s+["\w]/i;

/** A role or permission field written from request input — never the
 * caller's own identity read off the request (`request.user.role`). */
const ROLE_FROM_REQUEST_RE =
  /\b(?:is_?admin|is_?superuser|is_?staff|isSuperuser|roles?|permissions?|privileges?|access_level|accessLevel)["'\]]?\s*(?:=(?!=)|:)\s*(?:request|req|params|body|payload|input|ctx\.request|form|args)\b(?!\.(?:user|auth|session|principal|identity|claims|token)\b)/i;

// ---- weak probes -----------------------------------------------------------

const ROUTE_RE =
  /@(?:app|router|api|bp|blueprint|\w+_router)\.(?:get|post|put|patch|delete|route|api_route)\(|@(?:Get|Post|Put|Patch|Delete|Request)Mapping\b|@(?:Get|Post|Put|Patch|Delete|All)\(|\b(?:app|router|r|server)\.(?:get|post|put|patch|delete|all|route)\(\s*["'`/]|\b(?:re_)?path\(\s*r?["']|\bHandleFunc\(|^\s*(?:get|post|put|patch|delete|match|resources?)\s+["':]/m;
const TENANT_QUERY_RE =
  /^(?=.*\b(?:tenant|org(?:anization)?|account|workspace|owner|team|company|customer|user)_?[iI][dD]\b)(?=.*\b(?:filter|where|find\w*|query|select|objects|get_object_or_404)\b)/m;
const OUTBOUND_RE =
  /\b(?:requests|httpx|axios|got|superagent|urllib\.request|aiohttp|http|https|client)\.(?:get|post|put|patch|delete|request|urlopen|Get|Post|Do)\(\s*(?![\s"'`)])|(?<![\w.])(?:fetch|urlopen)\(\s*(?![\s"'`)])|(?<![\w.])open\(\s*(?![\s"'`)])|\bos\.(?:Open|OpenFile|ReadFile)\(\s*(?!")|\bfs\.(?:readFile|createReadStream|writeFile|createWriteStream)\w*\(\s*(?![\s"'`])|\bsend_?[fF]ile\(/;
const LLM_RE =
  /\b(?:openai|anthropic|OpenAI|Anthropic|ChatOpenAI|ChatAnthropic|genai|bedrock|langchain|llama_index|ollama|litellm)\b|\b(?:chat\.completions|messages|responses)\.create\(|\bgenerateContent\(|\b(?:system_prompt|systemPrompt|prompt_template|PromptTemplate|tool_choice|function_call)\b/;
const SUPPLY_PATH_RE = new RegExp(
  `${DEPS_MANIFEST_RE.source}|(^|/)\\.github/workflows/|(^|/)(?:Dockerfile|Containerfile)[^/]*$|(^|/)\\.gitlab-ci\\.ya?ml$|(^|/)\\.circleci/`,
);
const TOKEN_WORDS_RE =
  /\b(?:jwt|jwks?|jws|jose|oauth2?|oidc|saml|session|cookie|expires_?(?:in|at)?|expiresIn|max_?age|maxAge|refresh_token|access_token|id_token|api_?key|totp|mfa)\b/i;
const TOCTOU_RE =
  /^(?=[\s\S]*(?:\bfind(?:One|Unique|First|_by)\w*\(|\.get\(|\.exists\(\)|\.first\(\)|\bSELECT\b))(?=[\s\S]*\b(?:save|update|create|insert|delete|decrement|increment)\w*\b)(?=[\s\S]*\b(?:token|role|admin|balance|credits?|wallet|invite|coupon|voucher|gift_?card|redeem\w*|referral|trial|payout|refund|otp|password|quota|seats?|nonce|used)\b)/i;
const INFRA_PATH_RE =
  /\.(?:tf|tfvars)$|(^|\/)terragrunt\.hcl$|(^|\/)(?:k8s|kubernetes|manifests|charts|helm|deploy|infra|ops|cloudformation|ansible|playbooks)\/|(^|\/)kustomization\.ya?ml$|(^|\/)(?:docker-)?compose[^/]*\.ya?ml$|(^|\/)nginx[^/]*\.conf$|(^|\/)nginx\/|(^|\/)Caddyfile$|(^|\/)haproxy\.cfg$|(^|\/)sshd_config|(?:^|[/_.-])(?:firewall|ufw|iptables|nftables|security-?groups?|networkpolic(?:y|ies)|netpol|waf)(?:[/_.-]|$)/i;
const PRIVESC_PATH_RE =
  /(^|\/)(?:authz|rbac|acl|permissions|roles|invites|invitations|memberships|scim|sso|saml|impersonation)\//i;

/** Every trigger, strong first, each in family order. */
export const SECURITY_TRIGGERS: readonly SecurityTrigger[] = [
  // strong
  {
    lens: "pass-sec-authn-coverage",
    strength: "strong",
    probe: "removed",
    re: GUARD_RE,
    chain: true,
    why: "a guard is removed and not put back",
  },
  {
    lens: "pass-sec-authn-coverage",
    strength: "strong",
    probe: "config",
    re: NO_AUTH_RE,
    why: "an endpoint or resource is published with no authentication",
  },
  {
    lens: "pass-sec-privesc",
    strength: "strong",
    probe: "added",
    re: ROLE_FROM_REQUEST_RE,
    why: "a role or permission field is written from request input",
  },
  {
    lens: "pass-sec-iam",
    strength: "strong",
    probe: "config",
    re: WILDCARD_GRANT_RE,
    why: "a wildcard, role-passing or cluster-wide grant is added",
  },
  {
    lens: "pass-sec-iam",
    strength: "strong",
    probe: "added",
    re: SQL_GRANT_RE,
    files: SQL_GRANT_FILE_RE,
    why: "a database GRANT is added",
  },
  {
    lens: "pass-sec-tokens",
    strength: "strong",
    probe: "added",
    re: DISABLED_VERIFY_RE,
    why: "a signature, expiry or certificate check is turned off",
  },
  {
    lens: "pass-sec-tokens",
    strength: "strong",
    probe: "config",
    re: DISABLED_VERIFY_RE,
    why: "a signature, expiry or certificate check is turned off",
  },
  {
    lens: "pass-sec-injection",
    strength: "strong",
    probe: "added",
    re: SQL_INTERPOLATION_RE,
    why: "SQL is built by interpolation",
  },
  {
    lens: "pass-sec-injection",
    strength: "strong",
    probe: "added",
    re: SHELL_EVAL_RE,
    why: "a shell or an evaluator runs a non-literal",
  },
  {
    lens: "pass-sec-injection",
    strength: "strong",
    probe: "added",
    re: DESERIALIZE_RE,
    why: "an unsafe deserializer reads input",
  },
  {
    lens: "pass-sec-injection",
    strength: "strong",
    probe: "added",
    re: HTML_ESCAPE_HATCH_RE,
    why: "output bypasses HTML escaping",
  },
  {
    lens: "pass-sec-injection",
    strength: "strong",
    probe: "added",
    re: TEMPLATE_ESCAPE_HATCH_RE,
    files: TEMPLATE_FILE_RE,
    why: "a template bypasses HTML escaping",
  },
  {
    lens: "pass-sec-secrets-data",
    strength: "strong",
    probe: "added",
    re: CREDENTIAL_RE,
    files: /./,
    tests: true,
    redact: true,
    why: "a credential-shaped literal is added",
  },
  {
    lens: "pass-sec-supply-chain",
    strength: "strong",
    probe: "config",
    re: PULL_REQUEST_TARGET_RE,
    files: WORKFLOW_FILE_RE,
    why: "a workflow runs on pull_request_target",
  },
  {
    lens: "pass-sec-supply-chain",
    strength: "strong",
    probe: "config",
    re: WORKFLOW_INJECTION_RE,
    files: WORKFLOW_FILE_RE,
    why: "a workflow expands an attacker-written field into a shell",
  },
  {
    lens: "pass-sec-infra",
    strength: "strong",
    probe: "config",
    re: OPEN_INGRESS_RE,
    why: "ingress is opened to every address",
  },
  {
    lens: "pass-sec-infra",
    strength: "strong",
    probe: "config",
    re: PRIVILEGED_RE,
    why: "a container is given the host or privileged mode",
  },
  {
    lens: "pass-sec-infra",
    strength: "strong",
    probe: "config",
    re: USER_ROOT_RE,
    files: DOCKERFILE_RE,
    why: "a container is set to run as root",
  },
  {
    lens: "pass-sec-infra",
    strength: "strong",
    probe: "removed",
    re: USER_NONROOT_RE,
    files: DOCKERFILE_RE,
    why: "a container's non-root user is removed",
  },
  // weak
  {
    lens: "pass-sec-authn-coverage",
    strength: "weak",
    probe: "added",
    re: ROUTE_RE,
    why: "a route is registered",
  },
  {
    lens: "pass-sec-access",
    strength: "weak",
    probe: "added",
    re: TENANT_QUERY_RE,
    why: "a query filters on a tenant or owner key",
  },
  {
    lens: "pass-sec-privesc",
    strength: "weak",
    probe: "path",
    re: PRIVESC_PATH_RE,
    why: "the diff touches a role, membership or sign-on surface",
  },
  {
    lens: "pass-sec-tokens",
    strength: "weak",
    probe: "added",
    re: TOKEN_WORDS_RE,
    why: "token, session or expiry handling changes",
  },
  {
    lens: "pass-sec-toctou",
    strength: "weak",
    probe: "added",
    re: TOCTOU_RE,
    why: "a read then a write sits next to a guarded asset",
  },
  {
    lens: "pass-sec-boundaries",
    strength: "weak",
    probe: "added",
    re: OUTBOUND_RE,
    why: "a request or a file open takes a variable",
  },
  {
    lens: "pass-sec-supply-chain",
    strength: "weak",
    probe: "path",
    re: SUPPLY_PATH_RE,
    why: "a manifest, lockfile, workflow or image definition changes",
  },
  {
    lens: "pass-sec-llm",
    strength: "weak",
    probe: "added",
    re: LLM_RE,
    why: "a model client, tool definition or prompt changes",
  },
  {
    lens: "pass-sec-infra",
    strength: "weak",
    probe: "path",
    re: INFRA_PATH_RE,
    why: "the diff touches infrastructure, a proxy or a firewall",
  },
];

/** A PR title that says it fixes a security defect (variant's weak signal:
 * a fixed defect's siblings are the next ones). */
const SECURITY_FIX_TITLE_RE =
  /\b(?:security|vulnerab\w*|CVE-\d{4}-\d+|GHSA(?:-\w{4}){3}|XSS|CSRF|SSRF|XXE|IDOR|RCE|(?:sql|command|template|header)\s+injection|path\s+traversal|auth\w*\s+bypass|privilege\s+escalation|exploit\w*|sanitiz\w*)\b/i;
/** An advisory id anywhere in the PR text or the added lines. */
const ADVISORY_ID_RE = /\b(?:CVE-\d{4}-\d{4,}|GHSA(?:-[0-9a-z]{4}){3})\b/i;

export interface SecuritySelection {
  lens: string;
  why: string;
  strength: "strong" | "weak";
  /** The changed files whose content or path fired (empty for a signal that
   * names no file: the PR text, a request). */
  files?: readonly string[];
}

export interface SecuritySelectionOpts {
  mode: SecurityTriggerMode;
  threatModel?: ThreatModel | null;
  extension?: HeuristicsExtension;
  facts?: readonly SecurityFact[];
  /** The PR title and body, for the variant lens's weak signal. */
  intent?: { title?: string | null; body?: string | null };
}

interface Hit {
  lens: string;
  strength: "strong" | "weak";
  why: string;
  file?: string;
}

/** Strip each line's diff sign. */
function unsigned(side: string): string {
  return side.replace(/^[+-]/gm, "");
}

/** The matched line as the plan shows it: trimmed, capped, and with nothing
 * a template or a code span could take for markup. */
function shown(text: string, at: number): string {
  const start = text.lastIndexOf("\n", at) + 1;
  const end = text.indexOf("\n", at);
  const line = text
    .slice(start, end === -1 ? undefined : end)
    .trim()
    .replace(/`/g, "'")
    .replace(/\{\{/g, "{ {")
    .replace(/\}\}/g, "} }");
  return line.length > 70 ? `${line.slice(0, 67)}…` : line;
}

/** The (file, lines) pairs a probe reads. */
function population(
  files: readonly PrFileEntry[],
  t: SecurityTrigger,
): { file: PrFileEntry; text: string; other: string }[] {
  const scoped = (f: PrFileEntry): boolean =>
    f.patch !== undefined &&
    (t.tests === true || !isTestFile(f.filename)) &&
    (t.files === undefined || t.files.test(f.filename));
  const mutable = files as PrFileEntry[];
  switch (t.probe) {
    case "config":
      return addedConfig(mutable)
        .filter(({ file }) => t.files === undefined || t.files.test(file.filename))
        .map(({ file, added }) => ({
          file: file as PrFileEntry,
          text: unsigned(added),
          other: "",
        }));
    case "added":
      if (t.files === undefined)
        return addedCode(mutable).map(({ file, added }) => ({
          file: file as PrFileEntry,
          text: unsigned(added),
          other: "",
        }));
      return files.filter(scoped).map((f) => ({
        file: f,
        text: unsigned(diffSide(f.patch as string, "+")),
        other: "",
      }));
    case "removed":
      if (t.files === undefined)
        return removedCode(mutable).map(({ file, removed }) => ({
          file: file as PrFileEntry,
          text: unsigned(removed),
          other: unsigned(diffSide(file.patch as string, "+")),
        }));
      return files.filter(scoped).map((f) => ({
        file: f,
        text: unsigned(diffSide(f.patch as string, "-")),
        other: unsigned(diffSide(f.patch as string, "+")),
      }));
    case "path":
      return [];
  }
}

/** The first hit of one content trigger, or null. A removed-line match
 * counts only when its text is not added back in the same file. */
function contentHit(files: readonly PrFileEntry[], t: SecurityTrigger): Hit | null {
  const hit = (file: PrFileEntry, text: string, at: number): Hit => ({
    lens: t.lens,
    strength: t.strength,
    why: `${t.why} in ${file.filename}${t.redact ? "" : ` (\`${shown(text, at)}\`)`}`,
    file: file.filename,
  });
  for (const { file, text, other } of population(files, t)) {
    if (text === "") continue;
    if (t.probe !== "removed") {
      const m = t.re.exec(text);
      if (m) return hit(file, text, m.index);
      continue;
    }
    // removed: line by line, and only what the file does not add back
    let offset = 0;
    for (const line of text.split("\n")) {
      const m = t.re.exec(line);
      if (m && !other.includes(m[0].trim())) return hit(file, text, offset);
      offset += line.length + 1;
    }
  }
  return null;
}

/** Every hit of one trigger: content probes report the first file that
 * fires, path probes every matching file. */
function triggerHits(files: readonly PrFileEntry[], t: SecurityTrigger): Hit[] {
  if (t.probe === "path") {
    const named = files.filter((f) => !isTestFile(f.filename) && t.re.test(f.filename));
    return named.map((f) => ({
      lens: t.lens,
      strength: t.strength,
      why: `${t.why} (${named[0]!.filename}${named.length > 1 ? ` and ${named.length - 1} more` : ""})`,
      file: f.filename,
    }));
  }
  const hit = contentHit(files, t);
  return hit ? [hit] : [];
}

/** A profile's `heuristics.toml` probes for a family lens: strong, since an
 * operator wrote them for this repository. Its line probes are compiled to
 * match a signed patch line, so they read the whole patch, like the
 * compiled-in selection's profile probes. */
function extensionHits(files: readonly PrFileEntry[], ext: HeuristicsExtension): Hit[] {
  const out: Hit[] = [];
  for (const lens of SECURITY_FAMILY) {
    const at = (why: string, file: string): void => {
      out.push({ lens, strength: "strong", why: `${why} ${file}`, file });
    };
    for (const re of ext.paths[lens] ?? []) {
      const f = files.find((x) => re.test(x.filename));
      if (f) at("the profile's path signal matches", f.filename);
    }
    const patched = files.filter((f) => f.patch !== undefined);
    for (const re of ext.addedLines[lens] ?? []) {
      const f = patched.find((x) => re.test(x.patch as string));
      if (f) at("the profile's added-line signal matches in", f.filename);
    }
    for (const re of ext.removedLines?.[lens] ?? []) {
      const f = patched.find((x) => re.test(x.patch as string));
      if (f) at("the profile's removed-line signal matches in", f.filename);
    }
    for (const re of ext.configLines?.[lens] ?? []) {
      const f = patched.find((x) => CONFIG_FILE_RE.test(x.filename) && re.test(x.patch as string));
      if (f) at("the profile's config-line signal matches in", f.filename);
    }
  }
  return out;
}

/** A threat-model hit plans the lenses that read that kind of surface, and
 * the chain: a change at a recorded entry point, control or sink is where a
 * new hop is most likely. */
function threatModelLensHits(files: readonly PrFileEntry[], tm: ThreatModel): Hit[] {
  const hits = threatModelHits(
    tm,
    files.map((f) => f.filename),
  );
  const named = (globs: readonly string[]): string =>
    globs
      .slice(0, 3)
      .map((g) => `\`${g}\``)
      .join(", ");
  const out: Hit[] = [];
  const add = (lenses: readonly string[], why: string): void => {
    for (const lens of lenses) out.push({ lens, strength: "strong", why });
  };
  if (hits.entry.length > 0)
    add(
      ["pass-sec-authn-coverage", "pass-sec-injection", CHAIN_PASS],
      `the diff touches a threat-model entry point (${named(hits.entry)})`,
    );
  if (hits.control.length > 0)
    add(
      ["pass-sec-access", "pass-sec-authn-coverage", CHAIN_PASS],
      `the diff touches a threat-model control (${named(hits.control)})`,
    );
  if (hits.sink.length > 0)
    add(
      ["pass-sec-injection", "pass-sec-boundaries", CHAIN_PASS],
      `the diff touches a threat-model sink (${named(hits.sink)})`,
    );
  return out;
}

/** A deterministic fact that found something plans the lens it speaks to;
 * a removed guard plans the chain too. The route inventory lists, it does
 * not find, so it plans nothing. */
function factHits(facts: readonly SecurityFact[]): Hit[] {
  const out: Hit[] = [];
  for (const f of facts) {
    if (f.status !== "found" || f.check === "route-inventory") continue;
    const why = `the \`${f.check}\` security fact found ${f.file !== undefined ? `something in ${f.file}` : "something"}`;
    out.push({
      lens: f.lens,
      strength: "strong",
      why,
      ...(f.file !== undefined ? { file: f.file } : {}),
    });
    if (f.check === "removed-guard")
      out.push({
        lens: CHAIN_PASS,
        strength: "strong",
        why,
        ...(f.file !== undefined ? { file: f.file } : {}),
      });
  }
  return out;
}

/** Variant's weak signal: a PR that says it fixes a security defect. */
function variantHit(files: readonly PrFileEntry[], opts: SecuritySelectionOpts): Hit | null {
  const title = opts.intent?.title ?? "";
  const m = SECURITY_FIX_TITLE_RE.exec(title);
  if (m) return { lens: "pass-sec-variant", strength: "weak", why: `the PR title says "${m[0]}"` };
  const body = opts.intent?.body ?? "";
  const a = ADVISORY_ID_RE.exec(body);
  if (a) return { lens: "pass-sec-variant", strength: "weak", why: `the PR text names ${a[0]}` };
  for (const { file, added } of addedCode(files as PrFileEntry[])) {
    const c = ADVISORY_ID_RE.exec(added);
    if (c)
      return {
        lens: "pass-sec-variant",
        strength: "weak",
        why: `an added line in ${file.filename} names ${c[0]}`,
        file: file.filename,
      };
  }
  return null;
}

/**
 * The security-family lenses this PR's content plans, in family order, one
 * entry per lens with the first reason that fired (a strong reason before a
 * weak one) and the files that fired it.
 *
 * `mode`: `off` plans nothing; `strong` reads the strong probes, the threat
 * model, the profile's probes and the facts; `all` adds the weak probes. A
 * guard removed (by a probe or the `removed-guard` fact) and a threat-model
 * hit also select `pass-sec-exploit-chain`, whose rows the planner builds
 * from `chainStrategies`.
 */
export function selectSecurityLenses(
  files: PrFileEntry[],
  opts: SecuritySelectionOpts,
): SecuritySelection[] {
  if (opts.mode === "off") return [];
  const hits: Hit[] = [];
  for (const t of SECURITY_TRIGGERS) {
    if (t.strength === "weak" && opts.mode !== "all") continue;
    const found = triggerHits(files, t);
    hits.push(...found);
    if (t.chain) for (const h of found) hits.push({ ...h, lens: CHAIN_PASS });
  }
  if (opts.threatModel) hits.push(...threatModelLensHits(files, opts.threatModel));
  hits.push(...extensionHits(files, opts.extension ?? EMPTY_HEURISTICS));
  hits.push(...factHits(opts.facts ?? []));
  if (opts.mode === "all") {
    const v = variantHit(files, opts);
    if (v) hits.push(v);
  }

  const out: SecuritySelection[] = [];
  for (const lens of SECURITY_FAMILY) {
    const mine = hits.filter((h) => h.lens === lens);
    if (mine.length === 0) continue;
    const first = mine.find((h) => h.strength === "strong") ?? mine[0]!;
    const named = [...new Set(mine.flatMap((h) => (h.file !== undefined ? [h.file] : [])))];
    out.push({
      lens,
      why: first.why,
      strength: first.strength,
      ...(named.length > 0 ? { files: named } : {}),
    });
  }
  return out;
}

// ---- server-side lines -----------------------------------------------------

/** Client-side files: a browser runs them, so they add no server-side hop
 * (a server route under `api/` or `server/` stays server-side). */
const CLIENT_SIDE_RE =
  /\.(?:css|scss|sass|less|html?|svg)$|(^|\/)(?:components|frontend|client|web\/src|examples?|stories|mocks|__mocks__)\/|\.stories\.\w+$/i;
const CLIENT_EXT_RE = /\.(?:tsx|jsx|vue|svelte)$/i;
const SERVER_ROUTE_RE = /(^|\/)(?:app\/api|pages\/api|server|api)\//;

/** Whether a file is server-side: not a test, not docs, not client code. */
function isServerSide(path: string): boolean {
  if (isTestFile(path) || isDocsPath(path)) return false;
  if (CLIENT_SIDE_RE.test(path)) return false;
  if (CLIENT_EXT_RE.test(path) && !SERVER_ROUTE_RE.test(path)) return false;
  return true;
}

/** The changed lines (added plus deleted) of the server-side files a
 * selection's triggers fired on — the size a chain's `forward` and
 * `backward` searches key on. */
export function triggeredServerLines(
  files: readonly PrFileEntry[],
  sel: readonly SecuritySelection[],
): number {
  const named = new Set(sel.flatMap((s) => s.files ?? []));
  return files
    .filter((f) => named.has(f.filename) && isServerSide(f.filename))
    .reduce((n, f) => n + f.additions + f.deletions, 0);
}

// ---- chain strategies ------------------------------------------------------

/** Server-side lines in triggered files above which a chain also searches
 * forward from the personas and backward from the crown jewels. */
export const CHAIN_WIDE_SERVER_LINES = 150;

/** Distinct family lenses that, triggered together, make a new hop likely
 * enough to plan the chain's `delta`. */
export const CHAIN_DELTA_MIN_LENSES = 2;

export interface ChainStrategyOpts {
  threatModel: ThreatModel | null;
  triggeredServerLines: number;
  mode: SecurityTriggerMode;
  requested: boolean;
}

/**
 * Which chain strategies a PR plans, each with the rule that planned it, in
 * `CHAIN_STRATEGIES` order. `compose` is never here: it runs after the
 * discovery wave over that wave's leads, so the planner decides it from the
 * rows it planned.
 *
 *  - `delta`: a request; or the selection names the chain (a removed guard,
 *    a threat-model hit); or `CHAIN_DELTA_MIN_LENSES` distinct family lenses
 *    are triggered.
 *  - `forward` and `backward`: a request; or a threat model exists, something
 *    in the family triggered, and either the triggered server-side change is
 *    over `CHAIN_WIDE_SERVER_LINES` lines or the mode is `all`.
 */
export function planChainStrategies(
  sel: readonly SecuritySelection[],
  opts: ChainStrategyOpts,
): { strategy: ChainStrategy; why: string }[] {
  const out: { strategy: ChainStrategy; why: string }[] = [];
  const chain = sel.find((s) => s.lens === CHAIN_PASS);
  const others = sel.filter((s) => s.lens !== CHAIN_PASS).map((s) => s.lens);
  if (opts.requested) out.push({ strategy: "delta", why: "a security review was requested" });
  else if (chain) out.push({ strategy: "delta", why: chain.why });
  else if (others.length >= CHAIN_DELTA_MIN_LENSES)
    out.push({
      strategy: "delta",
      why: `${others.length} security lenses were triggered (${others.join(", ")})`,
    });

  let wide: string | null = null;
  if (opts.requested) wide = "a security review was requested";
  else if (opts.threatModel !== null && sel.length > 0) {
    if (opts.triggeredServerLines > CHAIN_WIDE_SERVER_LINES)
      wide = `a threat model exists and the triggered server-side change is ${opts.triggeredServerLines} lines (over ${CHAIN_WIDE_SERVER_LINES})`;
    else if (opts.mode === "all") wide = "a threat model exists and every security trigger is on";
  }
  if (wide !== null) {
    out.push({ strategy: "forward", why: `${wide}: search forward from the personas` });
    out.push({ strategy: "backward", why: `${wide}: search backward from the crown jewels` });
  }
  return out;
}

/** The chain strategies alone (`planChainStrategies` without the reasons). */
export function chainStrategies(
  sel: readonly SecuritySelection[],
  opts: ChainStrategyOpts,
): ChainStrategy[] {
  return planChainStrategies(sel, opts).map((s) => s.strategy);
}

// ---- docs-only changes -----------------------------------------------------

/** Prose and images, decided by the file's own name, never its directory:
 * Markdown, plain text, reStructuredText, AsciiDoc, raster images and the
 * licence files. A `docs/` directory makes nothing docs by itself (code sits
 * under `app/api/docs/` too), MDX carries JSX, and SVG can carry script, so
 * none of them is here. A file with a code or configuration extension is
 * never docs, wherever it sits. */
const DOCS_EXT_RE = /\.(?:md|markdown|txt|rst|adoc|png|jpe?g|gif|webp|ico|bmp)$/i;
const LICENCE_FILE_RE = /(^|\/)(?:LICEN[CS]E|COPYING|NOTICE|AUTHORS)(?:\.[^/]*)?$/i;
/** A build input or a dependency list spelled `.txt`: a manifest, not
 * prose (`requirements*.txt` is in `DEPS_MANIFEST_RE`). */
const TXT_MANIFEST_RE = /(^|\/)(?:CMakeLists\.txt|constraints[^/]*\.txt)$|(^|\/)requirements\/[^/]*\.txt$/i;

function isDocsPath(path: string): boolean {
  if (CODE_FILE_RE.test(path) || CONFIG_FILE_RE.test(path) || DEPS_MANIFEST_RE.test(path)) return false;
  if (TXT_MANIFEST_RE.test(path)) return false;
  return LICENCE_FILE_RE.test(path) || DOCS_EXT_RE.test(path);
}

/**
 * Whether a change touches only docs and text — no code, no configuration.
 * A lens a profile plans `always` is dropped on such a change: it has no
 * code to read. An empty file list is not docs-only: it may be a list that
 * failed to load, and an unknown never drops a lens.
 */
export function isDocsOnlyChange(files: readonly { filename: string }[]): boolean {
  return files.length > 0 && files.every((f) => isDocsPath(f.filename));
}
