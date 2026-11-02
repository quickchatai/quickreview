// The security family's content triggers (packages/pi-plugin/src/
// securitytriggers.ts): which pass-sec-* lenses a PR's diff plans, and which
// exploit-chain strategies follow. Every strong probe is pinned in both
// directions, as the concurrency trigger's are: it fires in two languages (or
// two config dialects), and its near-miss — the safe spelling, a test file, a
// comment-free mention in the wrong file type — does not. The default profile
// plans on the strong probes alone, so a near-miss that fired would put a
// risk-tier lens on ordinary PRs.
import { describe, expect, it } from "vitest";
import type { PrFileEntry } from "@quickchatai/pi-quickreview/src/githubcore.js";
import {
  addedCode,
  addedConfig,
  CONFIG_FILE_RE,
  PROFILE_EXTENDABLE_LENSES,
  removedCode,
} from "@quickchatai/pi-quickreview/src/heuristics.js";
import { CHAIN_PASS, SECURITY_FAMILY } from "@quickchatai/pi-quickreview/src/passes.js";
import { parseProfileHeuristics } from "@quickchatai/pi-quickreview/src/profiles.js";
import type { SecurityFact } from "@quickchatai/pi-quickreview/src/secfacts.js";
import {
  CHAIN_WIDE_SERVER_LINES,
  chainStrategies,
  isDocsOnlyChange,
  planChainStrategies,
  SECURITY_TRIGGERS,
  selectSecurityLenses,
  triggeredServerLines,
  type SecuritySelection,
} from "@quickchatai/pi-quickreview/src/securitytriggers.js";
import { parseThreatModel } from "@quickchatai/pi-quickreview/src/threatmodel.js";

type Mode = "off" | "strong" | "all";

/** One file whose patch adds (or removes) exactly these lines. */
const changed = (filename: string, lines: string[], sign: "+" | "-" = "+"): PrFileEntry => ({
  filename,
  additions: sign === "+" ? lines.length : 0,
  deletions: sign === "-" ? lines.length : 0,
  status: "modified",
  patch: [
    `@@ -1,${lines.length + 1} +1,${lines.length + 1} @@`,
    " context",
    ...lines.map((l) => `${sign}${l}`),
  ].join("\n"),
});

/** One file whose patch removes `minus` and adds `plus`. */
const hunk = (filename: string, minus: string[], plus: string[]): PrFileEntry => ({
  filename,
  additions: plus.length,
  deletions: minus.length,
  status: "modified",
  patch: [
    `@@ -1,${minus.length} +1,${plus.length} @@`,
    ...minus.map((l) => `-${l}`),
    ...plus.map((l) => `+${l}`),
  ].join("\n"),
});

const lenses = (files: PrFileEntry[], mode: Mode = "strong"): string[] =>
  selectSecurityLenses(files, { mode }).map((s) => s.lens);

// Credential shapes are built at runtime: the publishability lint fails a
// tracked file that carries one literally.
const GH_TOKEN = "gh" + "p_" + "a".repeat(36);
const AWS_KEY_ID = "AK" + "IA" + "Z".repeat(16);
const PRIVATE_KEY_HEADER = "-".repeat(5) + "BEGIN RSA " + "PRIVATE KEY" + "-".repeat(5);

describe("strong probes fire in two languages", () => {
  // [lens, file, line, sign]
  const FIRES: Array<[string, string, string, "+" | "-"]> = [
    // a guard removed and not put back
    ["pass-sec-authn-coverage", "app/views.py", "@login_required", "-"],
    [
      "pass-sec-authn-coverage",
      "src/users/users.controller.ts",
      "@UseGuards(AuthGuard('jwt'))",
      "-",
    ],
    [
      "pass-sec-authn-coverage",
      "app/controllers/admin_controller.rb",
      "before_action :authenticate_user!",
      "-",
    ],
    [
      "pass-sec-authn-coverage",
      "src/main/java/AdminApi.java",
      "@PreAuthorize(\"hasRole('ADMIN')\")",
      "-",
    ],
    // published with no authentication
    ["pass-sec-authn-coverage", "template.yaml", "      AuthType: NONE", "+"],
    ["pass-sec-authn-coverage", "infra/api.tf", '  authorization = "NONE"', "+"],
    ["pass-sec-authn-coverage", "infra/bucket.tf", '  member = "allUsers"', "+"],
    // a role written from request input
    ["pass-sec-privesc", "app/views.py", "user.role = request.data['role']", "+"],
    [
      "pass-sec-privesc",
      "src/routes/users.ts",
      "await db.user.update({ where: { id }, data: { role: req.body.role } });",
      "+",
    ],
    [
      "pass-sec-privesc",
      "app/controllers/users_controller.rb",
      "@user.update(role: params[:role])",
      "+",
    ],
    // a wide grant
    ["pass-sec-iam", "infra/deploy-policy.json", '      "Action": "*",', "+"],
    ["pass-sec-iam", "infra/iam.tf", '    actions   = ["*"]', "+"],
    ["pass-sec-iam", "infra/iam.tf", '      "iam:PassRole",', "+"],
    ["pass-sec-iam", "k8s/rbac.yaml", '    verbs: ["escalate", "bind"]', "+"],
    ["pass-sec-iam", "provision/sudoers", "deploy ALL=(ALL) NOPASSWD: ALL", "+"],
    [
      "pass-sec-iam",
      "db/0042_grants.sql",
      "GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO app_user;",
      "+",
    ],
    [
      "pass-sec-iam",
      "app/migrations/0042_grant.py",
      'migrations.RunSQL("GRANT SELECT ON billing TO reporting")',
      "+",
    ],
    // a verification turned off
    ["pass-sec-tokens", "app/client.py", "r = requests.get(url, verify=False)", "+"],
    [
      "pass-sec-tokens",
      "auth/jwt.py",
      'claims = jwt.decode(t, key, options={"verify_signature": False})',
      "+",
    ],
    ["pass-sec-tokens", "auth/jwt.py", 'claims = jwt.decode(t, key, algorithms=["none"])', "+"],
    ["pass-sec-tokens", "src/auth.ts", "jwt.verify(token, key, { ignoreExpiration: true });", "+"],
    [
      "pass-sec-tokens",
      "pkg/client.go",
      "TLSClientConfig: &tls.Config{InsecureSkipVerify: true},",
      "+",
    ],
    // SQL built by interpolation
    [
      "pass-sec-injection",
      "app/repo.py",
      "cur.execute(f\"SELECT * FROM users WHERE name = '{name}'\")",
      "+",
    ],
    [
      "pass-sec-injection",
      "app/repo.py",
      "cur.execute(\"DELETE FROM sessions WHERE owner = '%s'\" % owner)",
      "+",
    ],
    [
      "pass-sec-injection",
      "app/repo.py",
      "cur.execute(\"INSERT INTO log VALUES ('{}')\".format(msg))",
      "+",
    ],
    [
      "pass-sec-injection",
      "src/repo.ts",
      "const rows = await db.query(`SELECT * FROM users WHERE id = ${id}`);",
      "+",
    ],
    [
      "pass-sec-injection",
      "src/main/java/Repo.java",
      'String q = "SELECT name FROM users WHERE id = \'" + id + "\'";',
      "+",
    ],
    [
      "pass-sec-injection",
      "pkg/repo.go",
      "q := fmt.Sprintf(\"UPDATE users SET name = '%s' WHERE id = %d\", name, id)",
      "+",
    ],
    // a shell or an evaluator on a non-literal
    ["pass-sec-injection", "app/tasks.py", "subprocess.run(cmd, shell=True)", "+"],
    ["pass-sec-injection", "app/tasks.py", 'os.system(f"convert {path} out.png")', "+"],
    ["pass-sec-injection", "src/run.ts", "const out = execSync(`git log ${branch}`);", "+"],
    ["pass-sec-injection", "src/run.js", "const result = eval(userCode);", "+"],
    ["pass-sec-injection", "pkg/run.go", 'cmd := exec.Command("sh", "-c", script)', "+"],
    // an unsafe deserializer
    ["pass-sec-injection", "app/api.py", "data = pickle.loads(request.body)", "+"],
    ["pass-sec-injection", "app/api.py", "cfg = yaml.load(stream)", "+"],
    [
      "pass-sec-injection",
      "src/main/java/Rpc.java",
      "ObjectInputStream in = new ObjectInputStream(sock.getInputStream());",
      "+",
    ],
    ["pass-sec-injection", "app/models/blob.rb", "obj = Marshal.load(params[:blob])", "+"],
    // escaping bypassed
    ["pass-sec-injection", "src/Bio.tsx", "<div dangerouslySetInnerHTML={{ __html: bio }} />", "+"],
    ["pass-sec-injection", "src/render.js", "el.innerHTML = userInput;", "+"],
    ["pass-sec-injection", "app/templatetags/bio.py", 'return mark_safe(f"<b>{name}</b>")', "+"],
    ["pass-sec-injection", "templates/profile.html", "<p>{{ user.bio|safe }}</p>", "+"],
    ["pass-sec-injection", "app/views/comments/show.html.erb", "<%== @comment.body %>", "+"],
    // attacker-written workflow input
    ["pass-sec-supply-chain", ".github/workflows/ci.yml", "on: pull_request_target", "+"],
    [
      "pass-sec-supply-chain",
      ".github/workflows/ci.yml",
      '      - run: echo "${{ github.event.pull_request.title }}"',
      "+",
    ],
    [
      "pass-sec-supply-chain",
      ".github/workflows/triage.yaml",
      '          echo "${{ github.event.issue.body }}" > body.txt',
      "+",
    ],
    [
      "pass-sec-supply-chain",
      ".github/workflows/ci.yml",
      "          git checkout ${{ github.event.pull_request.head.ref }}",
      "+",
    ],
    [
      "pass-sec-supply-chain",
      ".github/workflows/ci.yml",
      '      - run: echo "${{ github.head_ref }}"',
      "+",
    ],
    [
      "pass-sec-supply-chain",
      ".github/workflows/deploy.yml",
      "          ./deploy.sh ${{ github.event.workflow_run.head_branch }}",
      "+",
    ],
    [
      "pass-sec-supply-chain",
      ".github/workflows/notify.yml",
      '          echo "${{ github.event.head_commit.message }}"',
      "+",
    ],
    // the host given away
    ["pass-sec-infra", "infra/sg.tf", '  ingress { cidr_blocks = ["0.0.0.0/0"] }', "+"],
    ["pass-sec-infra", "k8s/deploy.yaml", "      hostNetwork: true", "+"],
    ["pass-sec-infra", "docker-compose.yml", "    privileged: true", "+"],
    ["pass-sec-infra", "Dockerfile", "USER root", "+"],
    ["pass-sec-infra", "docker/Dockerfile.api", "USER app", "-"],
  ];

  it.each(FIRES)("%s fires on %s: %s", (lens, file, line, sign) => {
    const sel = selectSecurityLenses([changed(file, [line], sign)], { mode: "strong" });
    const hit = sel.find((s) => s.lens === lens);
    expect(hit, `${lens} on ${file}`).toBeDefined();
    expect(hit!.strength).toBe("strong");
    expect(hit!.files).toEqual([file]);
    expect(hit!.why).toContain(file);
  });

  it("a credential-shaped literal fires anywhere, a test or a README included, and is never quoted", () => {
    for (const [file, line] of [
      ["app/settings.py", `GITHUB_TOKEN = "${GH_TOKEN}"`],
      ["config/deploy.yaml", `  aws_access_key_id: ${AWS_KEY_ID}`],
      ["tests/fixtures/key.pem", PRIVATE_KEY_HEADER],
      ["README.md", `export GITHUB_TOKEN=${GH_TOKEN}`],
    ] as const) {
      const hit = selectSecurityLenses([changed(file, [line])], { mode: "strong" }).find(
        (s) => s.lens === "pass-sec-secrets-data",
      );
      expect(hit, file).toBeDefined();
      expect(hit!.why).not.toContain(GH_TOKEN);
      expect(hit!.why).not.toContain(AWS_KEY_ID);
      expect(hit!.why).not.toContain("PRIVATE KEY");
    }
  });

  it("a cluster-admin binding spans lines of one manifest", () => {
    const f = changed("k8s/admin-binding.yaml", [
      "kind: ClusterRoleBinding",
      "metadata:",
      "  name: ci-admin",
      "roleRef:",
      "  kind: ClusterRole",
      "  name: cluster-admin",
    ]);
    expect(lenses([f])).toContain("pass-sec-iam");
  });

  it("a CloudFormation ingress open to the world fires; the same CIDR on egress does not", () => {
    const ingress = changed("stack.template.yaml", [
      "  SecurityGroupIngress:",
      "    - IpProtocol: tcp",
      "      FromPort: 22",
      "      CidrIp: 0.0.0.0/0",
    ]);
    expect(lenses([ingress])).toContain("pass-sec-infra");
    const egress = changed("infra/sg.tf", ['  egress { cidr_blocks = ["0.0.0.0/0"] }']);
    expect(lenses([egress])).not.toContain("pass-sec-infra");
  });
});

describe("near-misses do not fire", () => {
  // [lens, file, line, sign]
  const NEAR: Array<[string, string, string, "+" | "-"]> = [
    // a guard ADDED is not a guard removed
    ["pass-sec-authn-coverage", "app/views.py", "@login_required", "+"],
    // a removed guard in a test file
    ["pass-sec-authn-coverage", "tests/test_views.py", "@login_required", "-"],
    // removing a disabled check turns verification back on
    ["pass-sec-authn-coverage", "app/client.py", "r = requests.get(url, verify=False)", "-"],
    // the config spelling inside a code string
    ["pass-sec-authn-coverage", "app/lambda_cfg.py", 'cfg = "AuthType: NONE"', "+"],
    ["pass-sec-authn-coverage", "infra/bucket.tf", "  allUsersCount = 3", "+"],
    // the caller's own role, read off the request; a comparison
    ["pass-sec-privesc", "app/views.py", "role = request.user.role", "+"],
    ["pass-sec-privesc", "app/views.py", "if user.role == request.data['role']:", "+"],
    ["pass-sec-privesc", "app/views.py", 'user.role = "member"', "+"],
    // a scoped action; a grant in application code that is not a migration
    ["pass-sec-iam", "infra/deploy-policy.json", '      "Action": "s3:GetObject",', "+"],
    ["pass-sec-iam", "app/sharing.py", 'msg = "GRANT access TO the team"', "+"],
    // verification on
    ["pass-sec-tokens", "app/client.py", "r = requests.get(url, verify=True)", "+"],
    ["pass-sec-tokens", "src/auth.ts", "jwt.verify(token, key, { ignoreExpiration: false });", "+"],
    // parameterised SQL, a LIKE pattern, a tagged template, prose
    [
      "pass-sec-injection",
      "app/repo.py",
      'cur.execute("SELECT * FROM users WHERE id = %s", (uid,))',
      "+",
    ],
    [
      "pass-sec-injection",
      "app/repo.py",
      "cur.execute(\"SELECT * FROM t WHERE name LIKE '%foo%'\")",
      "+",
    ],
    [
      "pass-sec-injection",
      "src/repo.ts",
      "const rows = await sql`SELECT * FROM users WHERE id = ${id}`;",
      "+",
    ],
    ["pass-sec-injection", "app/ui.py", 'label = f"Please select {name} from the list"', "+"],
    // a regex's exec, a literal command, a safe loader, plain JSON
    ["pass-sec-injection", "src/parse.ts", "const m = pattern.exec(text);", "+"],
    ["pass-sec-injection", "app/tasks.py", 'subprocess.run(["git", "status"])', "+"],
    ["pass-sec-injection", "app/api.py", "cfg = yaml.safe_load(stream)", "+"],
    ["pass-sec-injection", "app/api.py", "cfg = yaml.load(stream, Loader=yaml.SafeLoader)", "+"],
    ["pass-sec-injection", "app/api.py", "data = json.loads(request.body)", "+"],
    // escaping kept
    ["pass-sec-injection", "src/render.js", 'el.innerHTML = "";', "+"],
    ["pass-sec-injection", "src/render.js", "el.textContent = userInput;", "+"],
    ["pass-sec-injection", "app/templatetags/bio.py", 'return mark_safe("<br>")', "+"],
    ["pass-sec-injection", "templates/profile.html", "<p>{{ user.bio }}</p>", "+"],
    // the safe workflow spellings
    ["pass-sec-supply-chain", ".github/workflows/ci.yml", "on: pull_request", "+"],
    [
      "pass-sec-supply-chain",
      ".github/workflows/ci.yml",
      "          TITLE: ${{ github.event.pull_request.title }}",
      "+",
    ],
    [
      "pass-sec-supply-chain",
      ".github/workflows/ci.yml",
      "      - run: echo ${{ github.sha }}",
      "+",
    ],
    // a field no outsider writes: the PR's number, a SHA
    // MUTATION: restore the bare `event\.(?:pull_request|…)\b` root in
    // WORKFLOW_INJECTION_RE — the three rows below fire.
    [
      "pass-sec-supply-chain",
      ".github/workflows/ci.yml",
      '      - run: echo "PR ${{ github.event.pull_request.number }}"',
      "+",
    ],
    [
      "pass-sec-supply-chain",
      ".github/workflows/ci.yml",
      "          git checkout ${{ github.event.pull_request.head.sha }}",
      "+",
    ],
    [
      "pass-sec-supply-chain",
      ".github/workflows/ci.yml",
      "          git diff ${{ github.event.pull_request.base.sha }}...HEAD",
      "+",
    ],
    // a workflow word outside a workflow
    ["pass-sec-supply-chain", "docs/ci.yaml", "on: pull_request_target", "+"],
    // the host kept
    ["pass-sec-infra", "k8s/deploy.yaml", "      privileged: false", "+"],
    ["pass-sec-infra", "Dockerfile", "USER app", "+"],
    ["pass-sec-infra", "app/settings.py", "PRIVILEGED = True  # privileged: true", "+"],
    // a token too short to be one
    ["pass-sec-secrets-data", "app/settings.py", 'PREFIX = "ghp_short"', "+"],
  ];

  it.each(NEAR)("%s does not fire on %s: %s", (lens, file, line, sign) => {
    expect(lenses([changed(file, [line], sign)], "strong")).not.toContain(lens);
  });

  it("a guard moved within its file is not a guard removed", () => {
    const moved = hunk(
      "app/views.py",
      ["@login_required", "def a(request):"],
      ["def a(request):", "@login_required"],
    );
    expect(lenses([moved])).not.toContain("pass-sec-authn-coverage");
    expect(lenses([moved])).not.toContain(CHAIN_PASS);
  });

  it("os.environ and a README-only change plan nothing, in either mode", () => {
    const env = hunk("app/settings.py", ["    pass"], ["import os", "    return os.environ['X']"]);
    expect(lenses([env], "strong")).toEqual([]);
    const readme = changed("README.md", ["Run `make` to build.", "See the docs for more."]);
    expect(lenses([readme], "strong")).toEqual([]);
    expect(lenses([readme], "all")).toEqual([]);
  });
});

describe("a removed guard", () => {
  // MUTATION: make removed-line probes test "+" lines (`diffSide(…, "+")` in
  // heuristics.ts `removedCode`) — this fails: the "-@login_required" hunk no
  // longer plans the lens, and the "+" one starts to.
  it("plans authn-coverage and the chain's delta; the same line added plans neither", () => {
    const removed = changed("app/views.py", ["@login_required"], "-");
    const sel = selectSecurityLenses([removed], { mode: "strong" });
    expect(sel.map((s) => s.lens)).toEqual(["pass-sec-authn-coverage", CHAIN_PASS]);
    expect(sel[0]!.why).toMatch(/guard is removed/);
    expect(
      chainStrategies(sel, {
        threatModel: null,
        triggeredServerLines: 1,
        mode: "strong",
        requested: false,
      }),
    ).toEqual(["delta"]);

    const added = changed("app/views.py", ["@login_required"], "+");
    expect(lenses([added])).toEqual([]);
  });

  /**
   * MUTATION: drop the import skip in contentHit's removed-line loop (read
   * `t.re.exec(line)` for every line) — this fails; restore the bare
   * `\bverify\s*=` arm in GUARD_RE — the `createVerify` case fails.
   */
  it("an unused import dropped, or a variable named verify, is no guard removed", () => {
    for (const minus of [
      ["from django.contrib.auth.decorators import login_required"],
      ["import { requireAuth } from './auth';"],
      ["const { requireAuth } = require('./auth');"],
      [
        "from django.contrib.auth.decorators import (",
        "    login_required,",
        "    permission_required,",
        ")",
      ],
      ["import {", "  requireAuth,", "  requireAdmin,", "} from './auth';"],
      ["use App\\Http\\Middleware\\RequireAuth;"],
      ["const verify = createVerify('sha256');"],
      ["verify = make_verifier(key)"],
    ]) {
      const f = hunk("src/app.ts", minus, ["const ok = true;"]);
      expect(lenses([f]), minus.join(" / ")).toEqual([]);
    }
  });

  it("a guard decorator removed still plans the pair, its import gone with it or not", () => {
    const withImport = hunk(
      "app/views.py",
      ["from django.contrib.auth.decorators import login_required", "@login_required"],
      [],
    );
    const importKept = changed("app/views.py", ["@login_required"], "-");
    // An import added elsewhere does not put back the removed decorator.
    const reordered = hunk(
      "app/views.py",
      ["@login_required", "from django.contrib.auth.decorators import login_required"],
      ["from django.contrib.auth.decorators import login_required  # noqa"],
    );
    const kwarg = changed("app/client.py", ["    verify=ca_bundle,"], "-");
    for (const f of [withImport, importKept, reordered, kwarg])
      expect(lenses([f]), f.patch).toEqual(["pass-sec-authn-coverage", CHAIN_PASS]);
  });

  it("a removed-guard fact plans the same pair with no patch at all", () => {
    const fact: SecurityFact = {
      check: "removed-guard",
      status: "found",
      lens: "pass-sec-authn-coverage",
      file: "app/views.py",
      detail:
        "removes `@login_required` (base line 4) and adds no `login_required` back in this file",
    };
    const bare: PrFileEntry = {
      filename: "app/views.py",
      additions: 0,
      deletions: 1,
      status: "modified",
    };
    const sel = selectSecurityLenses([bare], { mode: "strong", facts: [fact] });
    expect(sel.map((s) => s.lens)).toEqual(["pass-sec-authn-coverage", CHAIN_PASS]);
    // an unknown or clear fact, and the route inventory, plan nothing
    for (const f of [
      { ...fact, status: "unknown" as const },
      { ...fact, status: "clear" as const },
      { ...fact, check: "route-inventory" as const },
    ])
      expect(selectSecurityLenses([bare], { mode: "strong", facts: [f] })).toEqual([]);
  });
});

describe("modes", () => {
  const route = changed("app/api/users.py", ['@app.get("/users/{user_id}")']);

  it("strong ignores the weak probes; all reads them; off plans nothing at all", () => {
    expect(lenses([route], "strong")).toEqual([]);
    const all = selectSecurityLenses([route], { mode: "all" });
    expect(all.find((s) => s.lens === "pass-sec-authn-coverage")?.strength).toBe("weak");
    const strongHit = changed("app/views.py", ["@login_required"], "-");
    expect(lenses([strongHit, route], "off")).toEqual([]);
  });

  it("a strong reason wins over a weak one for the same lens", () => {
    const strongHit = changed("app/views.py", ["@login_required"], "-");
    const sel = selectSecurityLenses([route, strongHit], { mode: "all" });
    const authn = sel.find((s) => s.lens === "pass-sec-authn-coverage")!;
    expect(authn.strength).toBe("strong");
    expect(authn.files).toEqual(["app/views.py", "app/api/users.py"]);
  });

  it("each weak probe plans its lens in all mode only", () => {
    const WEAK: Array<[string, PrFileEntry]> = [
      ["pass-sec-access", changed("app/repo.py", ["rows = Doc.objects.filter(tenant_id=tid)"])],
      ["pass-sec-privesc", changed("app/invites/accept.py", ["x = 1"])],
      ["pass-sec-tokens", changed("app/login.py", ["session.cycle_key()"])],
      [
        "pass-sec-toctou",
        changed("app/redeem.py", [
          "c = Coupon.objects.get(code=code)",
          "c.used = True",
          "c.save()",
        ]),
      ],
      ["pass-sec-boundaries", changed("app/fetch.py", ["r = requests.get(target_url)"])],
      ["pass-sec-supply-chain", changed("package.json", ['    "left-pad": "1.3.0"'])],
      [
        "pass-sec-llm",
        changed("app/chat.py", ["resp = client.chat.completions.create(model=m, messages=msgs)"]),
      ],
      ["pass-sec-infra", changed("deploy/nginx/site.conf", ["  listen 80;"])],
    ];
    for (const [lens, f] of WEAK) {
      expect(lenses([f], "all"), lens).toContain(lens);
      expect(lenses([f], "strong"), lens).not.toContain(lens);
    }
  });

  it("variant reads the PR title, in all mode only", () => {
    const f = changed("app/fetch.py", ["x = 1"]);
    const intent = { title: "Fix SSRF in the webhook fetcher", body: "" };
    expect(selectSecurityLenses([f], { mode: "all", intent }).map((s) => s.lens)).toContain(
      "pass-sec-variant",
    );
    expect(selectSecurityLenses([f], { mode: "strong", intent })).toEqual([]);
    expect(
      selectSecurityLenses([f], { mode: "all", intent: { title: "Tidy the fetcher" } }).map(
        (s) => s.lens,
      ),
    ).not.toContain("pass-sec-variant");
  });

  it("the selection comes back in family order, one entry per lens", () => {
    const sel = selectSecurityLenses(
      [
        changed("infra/sg.tf", ['  ingress { cidr_blocks = ["0.0.0.0/0"] }']),
        changed("app/repo.py", [
          "cur.execute(f\"SELECT * FROM t WHERE a = '{a}'\")",
          "subprocess.run(c, shell=True)",
        ]),
        changed("app/views.py", ["@login_required"], "-"),
      ],
      { mode: "strong" },
    );
    const order = sel.map((s) => SECURITY_FAMILY.indexOf(s.lens));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(new Set(sel.map((s) => s.lens)).size).toBe(sel.length);
  });
});

describe("the threat model", () => {
  const tm = parseThreatModel(
    [
      "# Threat model",
      "## Entry points",
      "- `app/api/**` the public API",
      "## Controls",
      "- `app/auth/**` session middleware",
      "## Sinks",
      "- `app/db/raw.py` raw queries",
    ].join("\n"),
    "repo",
  );

  it("an entry-point hit plans authn-coverage, injection and the chain, strong", () => {
    const sel = selectSecurityLenses([changed("app/api/users.py", ["x = 1"])], {
      mode: "strong",
      threatModel: tm,
    });
    expect(sel.map((s) => s.lens)).toEqual([
      "pass-sec-authn-coverage",
      "pass-sec-injection",
      CHAIN_PASS,
    ]);
    expect(sel.every((s) => s.strength === "strong")).toBe(true);
    expect(sel[0]!.why).toMatch(/threat-model entry point/);
  });

  it("a control plans access and authn-coverage; a sink plans injection and boundaries", () => {
    // without the model the same change plans nothing
    expect(lenses([changed("app/auth/session.py", ["x = 1"])], "strong")).toEqual([]);
    const control = selectSecurityLenses([changed("app/auth/session.py", ["x = 1"])], {
      mode: "strong",
      threatModel: tm,
    }).map((s) => s.lens);
    expect(control).toEqual(["pass-sec-authn-coverage", "pass-sec-access", CHAIN_PASS]);
    const sink = selectSecurityLenses([changed("app/db/raw.py", ["x = 1"])], {
      mode: "strong",
      threatModel: tm,
    }).map((s) => s.lens);
    expect(sink).toEqual(["pass-sec-injection", "pass-sec-boundaries", CHAIN_PASS]);
  });

  it("a file the model does not name plans nothing", () => {
    expect(
      selectSecurityLenses([changed("app/ui/home.py", ["x = 1"])], {
        mode: "strong",
        threatModel: tm,
      }),
    ).toEqual([]);
  });
});

describe("a profile's heuristics.toml for a family lens", () => {
  it("every family lens is profile-extendable", () => {
    for (const lens of SECURITY_FAMILY) expect(PROFILE_EXTENDABLE_LENSES, lens).toContain(lens);
  });

  it("its path, added-line, removed-line and config-line probes plan the lens, strong", () => {
    const ext = parseProfileHeuristics(
      "heuristics.toml",
      [
        "[pass-sec-access]",
        "added_lines = ['tenant_scope\\(']",
        "[pass-sec-authn-coverage]",
        "removed_lines = ['@internal_only']",
        "[pass-sec-infra]",
        "config_lines = ['listen_public:\\s*yes']",
        "[pass-sec-llm]",
        "paths = ['^app/agents/']",
      ].join("\n"),
    );
    const sel = (files: PrFileEntry[]): SecuritySelection[] =>
      selectSecurityLenses(files, { mode: "strong", extension: ext });
    expect(sel([changed("app/repo.py", ["q = tenant_scope(q)"])]).map((s) => s.lens)).toEqual([
      "pass-sec-access",
    ]);
    expect(sel([changed("app/views.py", ["@internal_only"], "-")]).map((s) => s.lens)).toEqual([
      "pass-sec-authn-coverage",
    ]);
    expect(sel([changed("deploy/app.yaml", ["listen_public: yes"])]).map((s) => s.lens)).toEqual([
      "pass-sec-infra",
    ]);
    // a config-line probe reads configuration files only
    expect(sel([changed("app/cfg.py", ["listen_public: yes"])])).toEqual([]);
    expect(sel([changed("app/agents/plan.py", ["x = 1"])]).map((s) => s.lens)).toEqual([
      "pass-sec-llm",
    ]);
    expect(sel([changed("app/agents/plan.py", ["x = 1"])])[0]!.strength).toBe("strong");
  });
});

describe("chain strategies", () => {
  const one: SecuritySelection[] = [{ lens: "pass-sec-injection", why: "x", strength: "strong" }];
  const two: SecuritySelection[] = [
    ...one,
    { lens: "pass-sec-access", why: "y", strength: "weak" },
  ];
  const tm = parseThreatModel("## Entry points\n- `app/api/**`\n", "profile");
  const base = {
    threatModel: null,
    triggeredServerLines: 0,
    mode: "strong" as const,
    requested: false,
  };

  it("delta: two family lenses, a chain selection, or a request; one lens alone is not enough", () => {
    expect(chainStrategies(one, base)).toEqual([]);
    expect(chainStrategies(two, base)).toEqual(["delta"]);
    expect(
      chainStrategies([{ lens: CHAIN_PASS, why: "a guard is removed", strength: "strong" }], base),
    ).toEqual(["delta"]);
    expect(chainStrategies([], { ...base, requested: true })).toEqual([
      "delta",
      "forward",
      "backward",
    ]);
  });

  it(`forward and backward: a threat model and over ${CHAIN_WIDE_SERVER_LINES} triggered server lines, or all mode`, () => {
    expect(chainStrategies(one, { ...base, threatModel: tm, triggeredServerLines: 151 })).toEqual([
      "forward",
      "backward",
    ]);
    expect(chainStrategies(one, { ...base, threatModel: tm, triggeredServerLines: 150 })).toEqual(
      [],
    );
    expect(chainStrategies(one, { ...base, triggeredServerLines: 999 })).toEqual([]);
    expect(chainStrategies(one, { ...base, threatModel: tm, mode: "all" })).toEqual([
      "forward",
      "backward",
    ]);
    // nothing triggered: no lead to start from, even with a model in all mode
    expect(chainStrategies([], { ...base, threatModel: tm, mode: "all" })).toEqual([]);
  });

  it("never plans compose (the planner does, after the discovery wave), and names each rule", () => {
    const plan = planChainStrategies(two, { ...base, threatModel: tm, triggeredServerLines: 500 });
    expect(plan.map((p) => p.strategy)).toEqual(["delta", "forward", "backward"]);
    expect(plan.every((p) => p.why.length > 10)).toBe(true);
    expect(plan[0]!.why).toMatch(/pass-sec-injection, pass-sec-access/);
  });
});

describe("triggered server-side lines", () => {
  it("count the lines of server-side files a trigger fired on, not client, test or docs files", () => {
    const files: PrFileEntry[] = [
      { filename: "app/api/users.py", additions: 100, deletions: 60, status: "modified" },
      { filename: "src/components/Users.tsx", additions: 200, deletions: 0, status: "modified" },
      { filename: "tests/test_users.py", additions: 50, deletions: 0, status: "modified" },
      { filename: "app/other.py", additions: 70, deletions: 0, status: "modified" },
    ];
    const sel: SecuritySelection[] = [
      {
        lens: "pass-sec-access",
        why: "x",
        strength: "strong",
        files: ["app/api/users.py", "src/components/Users.tsx", "tests/test_users.py"],
      },
    ];
    expect(triggeredServerLines(files, sel)).toBe(160);
  });
});

describe("docs-only changes", () => {
  it("prose, docs and raster images are docs-only; code, config, a manifest or an SVG are not", () => {
    expect(
      isDocsOnlyChange([
        { filename: "README.md" },
        { filename: "docs/guide/setup.rst" },
        { filename: "docs/img/flow.png" },
        { filename: "LICENSE" },
        { filename: "CHANGES.txt" },
      ]),
    ).toBe(true);
    for (const extra of ["app/main.py", "deploy/app.yaml", "requirements.txt", "static/logo.svg"])
      expect(isDocsOnlyChange([{ filename: "README.md" }, { filename: extra }]), extra).toBe(false);
  });

  /**
   * MUTATION: put back the bare `(^|\/)docs?\/` arm (or `mdx`) in the docs
   * test, or drop the `.txt` manifest names — this fails.
   */
  it("a file is docs by its own name, never by a docs/ directory: code and build files under it are not", () => {
    for (const path of [
      "app/api/docs/views.py",
      "app/internal/docs/export.py",
      "src/doc/handler.ts",
      "docs/conf.py",
      "docs/deploy.yaml",
      "CMakeLists.txt",
      "native/CMakeLists.txt",
      "requirements/base.txt",
      "constraints.txt",
      "pages/blog.mdx",
    ])
      expect(isDocsOnlyChange([{ filename: path }]), path).toBe(false);
    expect(isDocsOnlyChange([{ filename: "docs/api/index.md" }, { filename: "NOTICE" }])).toBe(
      true,
    );
  });

  it("an empty list is not docs-only: it may be a list that failed to load", () => {
    expect(isDocsOnlyChange([])).toBe(false);
  });
});

describe("the registry and its line helpers", () => {
  // MUTATION: give any trigger's regex the "g" flag — this fails (a global
  // regex keeps lastIndex between files and silently skips matches).
  it("every trigger names a family lens and none is global or sticky", () => {
    for (const t of SECURITY_TRIGGERS) {
      expect(SECURITY_FAMILY, t.lens).toContain(t.lens);
      expect(t.re.global || t.re.sticky, t.why).toBe(false);
      expect(t.why.length, t.lens).toBeGreaterThan(10);
    }
  });

  it("every family lens but the chain and variant has a trigger of its own", () => {
    const covered = new Set(SECURITY_TRIGGERS.map((t) => t.lens));
    for (const lens of SECURITY_FAMILY.filter((l) => l !== CHAIN_PASS && l !== "pass-sec-variant"))
      expect(covered, lens).toContain(lens);
  });

  it("CONFIG_FILE_RE takes configuration and leaves code and prose", () => {
    for (const f of [
      "k8s/deploy.yaml",
      ".github/workflows/ci.yml",
      "infra/main.tf",
      "infra/vars.tfvars",
      "vault/policy.hcl",
      "Dockerfile",
      "docker/Dockerfile.api",
      "docker-compose.yml",
      "nginx/site.conf",
      "firestore.rules",
      "etc/sudoers",
      "etc/sudoers.d/deploy",
      "db/0001_init.sql",
      "infra/deploy-policy.json",
      "stack.template.json",
    ])
      expect(CONFIG_FILE_RE.test(f), f).toBe(true);
    for (const f of ["app/main.py", "src/index.ts", "README.md", "package.json", "data/users.json"])
      expect(CONFIG_FILE_RE.test(f), f).toBe(false);
  });

  it("addedConfig skips tests; removedCode never reads the --- header", () => {
    expect(addedConfig([changed("tests/fixtures/app.yaml", ["a: 1"])])).toEqual([]);
    expect(addedConfig([changed("deploy/app.yaml", ["a: 1"])])[0]!.added).toBe("+a: 1");
    const withHeaders: PrFileEntry = {
      filename: "app/views.py",
      additions: 1,
      deletions: 1,
      status: "modified",
      patch: "--- a/app/views.py\n+++ b/app/views.py\n@@ -1 +1 @@\n-old()\n+new()",
    };
    expect(removedCode([withHeaders])[0]!.removed).toBe("-old()");
    expect(addedCode([withHeaders])[0]!.added).toBe("+new()");
  });
});
