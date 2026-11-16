// `qcr action install` and `qcr action workflow` (src/actioncli.ts), driven
// through injected deps: a fake `run` that answers the gh and git calls as gh
// 2.101.0 and GitHub's REST API answer, and records each call with its stdin;
// a scripted prompt; a fake model route. One test runs the whole verb
// through the bin's front door (runBin) against a fake `gh` on PATH, so the
// real child assembly carries the secret on stdin too.
//
// What it holds: every branch of the install (the repository, gh and its
// scopes, the triggers, the secret's name and value, the label, the workflow
// as a pull request or with --local, --force, the end), the secret's value in
// no argv ever, the closed list of gh calls over every path (ADR 0003), the
// --json object, the defaults with no terminal, and the usage errors.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ACTION_HELP,
  cmdAction,
  ghCallAllowed,
  routeKeyOf,
  runGh,
  secretNames,
  tokenScopes,
  type ActionDeps,
  type ActionRunResult,
  type InstallReport,
} from "../src/actioncli.js";
import { RECIPES, WORKFLOW_PATH, renderWorkflow, type Recipe } from "../src/actionworkflow.js";
import { runBin } from "../src/qcrbin.js";

const R = "acme/widgets";
const KEY = "MY_MODEL_KEY";
/** The model key's value: it must never be in an argv. */
const VALUE = "the-model-key-value-7f3a9c";
const HEAD_SHA = "0123456789abcdef0123456789abcdef01234567";
const OLD_SHA = "fedcba9876543210fedcba9876543210fedcba98";
const PR_URL = "https://github.com/acme/widgets/pull/12";
const ALL: Recipe[] = [...RECIPES];
/** Every branch name the install tries, all taken. */
const TAKEN = Array.from({ length: 20 }, (_, i) =>
  i === 0 ? "qcr/action-install" : `qcr/action-install-${i + 1}`,
);

const tmp = mkdtempSync(join(tmpdir(), "action-install-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
let n = 0;
const fresh = (): string => {
  const d = join(tmp, `c${++n}`);
  mkdirSync(d, { recursive: true });
  return d;
};

// ---- the fake world ------------------------------------------------------------

interface World {
  ghInstalled: boolean;
  loggedIn: boolean;
  /** The `Token scopes:` line's value; null prints none. */
  scopes: string | null;
  secrets: string[];
  secretListFails: boolean;
  secretSetFails: boolean;
  /** The organization secrets that reach the repository, or the HTTP status
   * their list fails with (404: a repository with none to list). */
  orgSecrets: string[] | number;
  /** The total_count GitHub gives for them, when it is more than one page. */
  orgTotal: number | null;
  labelExists: boolean;
  /** `label create` fails for a reason other than "already exists". */
  labelFails: boolean;
  /** The repository read, for its default branch, fails. */
  repoReadFails: boolean;
  /** The read of the workflow file fails with something other than a 404. */
  contentsFails: boolean;
  /** The workflow file's sha on the default branch, null when absent. */
  workflowSha: string | null;
  /** The read of the default branch's head fails. */
  headFails: boolean;
  /** The check of a branch name fails with something other than a 404. */
  branchCheckFails: boolean;
  /** Branches already on GitHub. */
  taken: string[];
  /** Creating the branch fails. */
  postFails: boolean;
  /** Committing the workflow file fails. */
  putFails: boolean;
  prFails: boolean;
  /** The checkout's origin remote, null when there is none. */
  origin: string | null;
  /** The checkout's top, null when the directory is not in one. */
  checkout: string | null;
}

const WORLD: World = {
  ghInstalled: true,
  loggedIn: true,
  scopes: "'gist', 'read:org', 'repo', 'workflow'",
  secrets: [],
  secretListFails: false,
  secretSetFails: false,
  orgSecrets: [],
  orgTotal: null,
  labelExists: false,
  labelFails: false,
  repoReadFails: false,
  contentsFails: false,
  workflowSha: null,
  headFails: false,
  branchCheckFails: false,
  taken: [],
  postFails: false,
  putFails: false,
  prFails: false,
  origin: "git@github.com:acme/widgets.git",
  checkout: null,
};

interface Call {
  cmd: string;
  args: string[];
  input?: string;
  terminal?: boolean;
}

const ok = (stdout = ""): ActionRunResult => ({ status: 0, stdout, stderr: "" });
const no = (stderr: string, stdout = ""): ActionRunResult => ({ status: 1, stdout, stderr });
const NOT_FOUND: ActionRunResult = no(
  "gh: Not Found (HTTP 404)",
  '{"message":"Not Found","documentation_url":"https://docs.github.com/rest","status":"404"}',
);

function authStatus(scopes: string | null): string {
  return [
    "github.com",
    "  ✓ Logged in to github.com account octo (keyring)",
    "  - Active account: true",
    "  - Git operations protocol: https",
    "  - Token: gho_************",
    ...(scopes === null ? [] : [`  - Token scopes: ${scopes}`]),
    "",
  ].join("\n");
}

/** What gh and git answer in `w`. */
function answer(w: World, cmd: string, a: string[]): ActionRunResult {
  const j = a.join(" ");
  if (cmd === "git") {
    if (j === "remote get-url origin")
      return w.origin === null ? no("error: No such remote 'origin'") : ok(`${w.origin}\n`);
    if (j === "rev-parse --show-toplevel")
      return w.checkout === null ? no("fatal: not a git repository") : ok(`${w.checkout}\n`);
    return no(`the fake git knows no ${j}`);
  }
  if (cmd !== "gh") return no(`the fake knows no ${cmd}`);
  if (!w.ghInstalled)
    return {
      status: null,
      stdout: "",
      stderr: "",
      error: Object.assign(new Error("spawnSync gh ENOENT"), { code: "ENOENT" }),
    };
  if (j === "--version") return ok("gh version 2.101.0 (2026-09-15)\n");
  if (a[0] === "auth" && a[1] === "status")
    return w.loggedIn
      ? ok(authStatus(w.scopes))
      : no("You are not logged into any GitHub hosts. To log in, run: gh auth login");
  if (a[0] === "secret" && a[1] === "list")
    return w.secretListFails
      ? no("HTTP 403: Resource not accessible by integration")
      : ok(w.secrets.map((s) => `${s}\t2026-11-01T00:00:00Z\n`).join(""));
  if (a[0] === "secret" && a[1] === "set")
    return w.secretSetFails ? no("failed to set secret: HTTP 403") : ok("");
  if (a[0] === "label" && a[1] === "create") {
    if (w.labelFails) return no("HTTP 403: Resource not accessible by integration");
    return w.labelExists
      ? no(
          'label with name "qcr-review" already exists; use `--force` to update its color and description',
        )
      : ok("");
  }
  if (a[0] === "pr" && a[1] === "create")
    return w.prFails
      ? no("pull request create failed: GraphQL: Head sha can't be blank")
      : ok(`${PR_URL}\n`);
  if (a[0] === "api") {
    if (a[1] === "-X" && a[2] === "POST")
      return w.postFails
        ? no("gh: Reference already exists (HTTP 422)")
        : ok(JSON.stringify({ ref: "refs/heads/x", object: { sha: HEAD_SHA } }));
    if (a[1] === "-X" && a[2] === "PUT")
      return w.putFails
        ? no("gh: Resource not accessible by personal access token (HTTP 403)")
        : ok("{}");
    if (a[1] === "-X") return no(`the fake gh knows no ${j}`);
    const path = a[1] ?? "";
    if (path === `repos/${R}`)
      return w.repoReadFails
        ? no("gh: Bad credentials (HTTP 401)")
        : ok(JSON.stringify({ full_name: R, default_branch: "main" }));
    if (path === `repos/${R}/actions/organization-secrets?per_page=100`) {
      const org = w.orgSecrets;
      if (org === 404) return NOT_FOUND;
      if (typeof org === "number") return no(`gh: Resource not accessible (HTTP ${org})`);
      return ok(
        JSON.stringify({
          total_count: w.orgTotal ?? org.length,
          secrets: org.map((name) => ({ name, visibility: "selected" })),
        }),
      );
    }
    if (path.startsWith(`repos/${R}/contents/`)) {
      if (w.contentsFails) return no("gh: Server Error (HTTP 502)");
      return w.workflowSha === null
        ? NOT_FOUND
        : ok(JSON.stringify({ path: WORKFLOW_PATH, sha: w.workflowSha }));
    }
    if (path === `repos/${R}/git/ref/heads/main`)
      return w.headFails
        ? no("gh: Server Error (HTTP 500)")
        : ok(JSON.stringify({ ref: "refs/heads/main", object: { sha: HEAD_SHA } }));
    const m = /\/git\/ref\/heads\/(.+)$/.exec(path);
    if (m) {
      if (w.branchCheckFails) return no("gh: Server Error (HTTP 503)");
      return w.taken.includes(m[1]!) ? ok(JSON.stringify({ object: { sha: "x" } })) : NOT_FOUND;
    }
  }
  return no(`the fake gh knows no ${j}`);
}

/**
 * What is wrong with one call the install made, or nothing: gh only as
 * ALLOWED lists, git only to read, nothing else, and the key's value in no
 * argv. Every call any test in this file drives is checked, after each test,
 * so a call added on any path fails here, not only on the paths PATHS runs.
 */
function offTheList(cmd: string, args: readonly string[]): string[] {
  const line = `${cmd} ${args.join(" ")}`;
  const wrong: string[] = [];
  if (line.includes(VALUE)) wrong.push(`the key's value in an argv: ${cmd}`);
  if (cmd === "git") {
    if (!["remote get-url origin", "rev-parse --show-toplevel"].includes(args.join(" ")))
      wrong.push(line);
  } else if (cmd !== "gh" || !ALLOWED.some(([, allowed]) => allowed(args))) wrong.push(line);
  return wrong;
}
const offList: string[] = [];
// MUTATION: in the secret-set failure branch of src/actioncli.ts, also run
// `runGh(deps, repo, ["secret", "delete", secret, "--repo", repo, "--app",
// "actions"])`, with `secret delete` added to ghCallAllowed. The test of
// that branch fails here.
afterEach(() => {
  expect(offList.splice(0), "gh or git calls off the list").toEqual([]);
});

interface Rig {
  deps: ActionDeps;
  calls: Call[];
  out: string[];
  err: string[];
  asked: string[];
  /** Each gh call as one line. */
  gh: () => string[];
}

function rig(
  o: {
    world?: Partial<World>;
    env?: Record<string, string | undefined>;
    tty?: boolean;
    answers?: Array<string | null>;
    routeKey?: string | null;
  } = {},
): Rig {
  const w: World = { ...WORLD, ...o.world };
  const calls: Call[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const asked: string[] = [];
  const answers = [...(o.answers ?? [])];
  const deps: ActionDeps = {
    env: o.env ?? { [KEY]: VALUE },
    cwd: w.checkout ?? join(tmp, "not-a-checkout"),
    isTTY: o.tty ?? false,
    run: (cmd, args, opts) => {
      calls.push({
        cmd,
        args: [...args],
        ...(opts.input === undefined ? {} : { input: opts.input }),
        ...(opts.terminal ? { terminal: true } : {}),
      });
      offList.push(...offTheList(cmd, args));
      return answer(w, cmd, [...args]);
    },
    prompt: (q) => {
      asked.push(q);
      return Promise.resolve(answers.length > 0 ? (answers.shift() ?? null) : null);
    },
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    routeKey: () => Promise.resolve(o.routeKey ?? null),
  };
  return {
    deps,
    calls,
    out,
    err,
    asked,
    gh: () => calls.filter((c) => c.cmd === "gh").map((c) => c.args.join(" ")),
  };
}

/** `install` with `args` and --json: the exit code and the object. */
async function install(
  r: Rig,
  ...args: string[]
): Promise<{ code: number; report: InstallReport }> {
  const code = await cmdAction(["install", ...args], true, r.deps);
  return { code, report: JSON.parse(r.out.join("\n")) as InstallReport };
}

/** The `-f` fields of a gh api call. */
function fields(args: readonly string[]): Record<string, string> {
  const f: Record<string, string> = {};
  args.forEach((a, i) => {
    if (a === "-f") {
      const kv = args[i + 1]!;
      const eq = kv.indexOf("=");
      f[kv.slice(0, eq)] = kv.slice(eq + 1);
    }
  });
  return f;
}

/** The read of the organization secrets that reach the repository. */
const ORG_SECRETS = `repos/${R}/actions/organization-secrets?per_page=100`;

const callOf = (r: Rig, prefix: string[]): Call | undefined =>
  r.calls.find((c) => c.cmd === "gh" && prefix.every((p, i) => c.args[i] === p));

// ---- install, branch by branch -------------------------------------------------

describe("qcr action install: the pull request path", () => {
  // MUTATION: put the key on gh's argv (`--body`) instead of its stdin — the
  // value shows in the argv and this fails.
  it("stores the key on gh's stdin, creates the label, and opens a pull request with the workflow", async () => {
    const r = rig();
    const { code, report } = await install(
      r,
      "--on",
      "comment,label,push,manual",
      "--secret",
      KEY,
      "--yes",
    );
    expect(code).toBe(0);
    expect(r.gh()).toEqual([
      "--version",
      "auth status --hostname github.com",
      `secret list --repo ${R} --app actions`,
      `api repos/${R}/actions/organization-secrets?per_page=100`,
      `secret set ${KEY} --repo ${R} --app actions`,
      `label create qcr-review --repo ${R} --description Ask QuickReview for a review --color 1d76db`,
      `api repos/${R}`,
      `api repos/${R}/contents/${WORKFLOW_PATH}?ref=main`,
      `api repos/${R}/git/ref/heads/main`,
      `api repos/${R}/git/ref/heads/qcr/action-install`,
      expect.stringMatching(new RegExp(`^api -X POST repos/${R}/git/refs `)),
      expect.stringMatching(new RegExp(`^api -X PUT repos/${R}/contents/${WORKFLOW_PATH} `)),
      expect.stringMatching(
        new RegExp(`^pr create --repo ${R} --base main --head qcr/action-install `),
      ),
    ]);
    const set = callOf(r, ["secret", "set"])!;
    expect(set.input).toBe(VALUE);
    for (const c of r.calls) expect(c.args.join(" ")).not.toContain(VALUE);

    const ref = callOf(r, ["api", "-X", "POST"])!;
    expect(fields(ref.args)).toEqual({ ref: "refs/heads/qcr/action-install", sha: HEAD_SHA });
    const put = fields(callOf(r, ["api", "-X", "PUT"])!.args);
    expect(put["branch"]).toBe("qcr/action-install");
    expect(put["message"]).toBe("QuickReview: add the review workflow");
    expect(put).not.toHaveProperty("sha");
    expect(Buffer.from(put["content"]!, "base64").toString("utf8")).toBe(
      renderWorkflow({ on: ALL, secretEnv: KEY }),
    );
    const pr = callOf(r, ["pr", "create"])!.args;
    expect(pr[pr.indexOf("--title") + 1]).toBe("Add the QuickReview workflow");
    expect(pr[pr.indexOf("--body") + 1]).toContain(`\`${KEY}\``);

    expect(report).toEqual({
      ok: true,
      repo: R,
      on: ALL,
      secret: { name: KEY, state: "set" },
      label: "created",
      workflow: { path: WORKFLOW_PATH, written: "pr", pr_url: PR_URL },
      next: expect.arrayContaining([`merge the pull request: ${PR_URL}`]) as string[],
      errors: [],
    });
  });

  it("keeps a secret the repository already has, and asks gh for nothing more about it", async () => {
    const r = rig({ world: { secrets: ["OTHER", KEY] } });
    const { code, report } = await install(r, "--secret", KEY, "--yes");
    expect(code).toBe(0);
    expect(report.secret).toEqual({ name: KEY, state: "kept" });
    expect(callOf(r, ["secret", "set"])).toBeUndefined();
    expect(callOf(r, ["api", ORG_SECRETS])).toBeUndefined();
  });

  // A repository secret overrides an organization secret of the same name
  // for every workflow in the repository: storing one would move them all
  // onto this person's key.
  // MUTATION: skip the organization secrets read in secretThere. The local
  // key is stored over the organization's, and this fails.
  it("keeps an organization secret that reaches the repository, and stores nothing over it", async () => {
    const r = rig({ world: { orgSecrets: ["OTHER", KEY] } });
    const { code, report } = await install(r, "--secret", KEY, "--yes");
    expect(code).toBe(0);
    expect(report.secret).toEqual({ name: KEY, state: "kept" });
    expect(callOf(r, ["secret", "set"])).toBeUndefined();

    const text = rig({ world: { orgSecrets: [KEY] } });
    expect(await cmdAction(["install", "--secret", KEY, "--yes"], false, text.deps)).toBe(0);
    expect(text.out.join("\n")).toContain(
      `An organization secret ${KEY} reaches ${R}: kept. A repository secret of that name would override it for every workflow there.`,
    );
  });

  it("reads a 404 for the organization secrets as none, and stores the key", async () => {
    const r = rig({ world: { orgSecrets: 404 } });
    const { code, report } = await install(r, "--secret", KEY, "--yes");
    expect(code).toBe(0);
    expect(report.secret).toEqual({ name: KEY, state: "set" });
    expect(callOf(r, ["secret", "set"])!.input).toBe(VALUE);
  });

  // MUTATION: read a failed organization secrets list as none in
  // secretThere. The key is stored blind, and this fails.
  it("stores nothing when it cannot tell whether an organization secret reaches the repository", async () => {
    const cases: Array<[Partial<World>, string]> = [
      [{ orgSecrets: 403 }, "gh: Resource not accessible (HTTP 403)"],
      [{ orgSecrets: ["A_KEY", "B_KEY"], orgTotal: 140 }, "it has 140 and gh listed 2"],
    ];
    for (const [world, why] of cases) {
      const r = rig({ world });
      const { code, report } = await install(r, "--secret", KEY, "--yes");
      expect(code, why).toBe(1);
      expect(callOf(r, ["secret", "set"]), why).toBeUndefined();
      expect(report.secret).toEqual({ name: KEY, state: "printed" });
      expect(report.errors).toEqual([
        `could not list the organization secrets ${R} can use, which a repository secret ${KEY} would override: ${why}`,
      ]);
      expect(report.workflow.written, why).toBe("pr");
    }
  });

  it("with the key not set here and a terminal, hands the terminal to gh to ask for it", async () => {
    const r = rig({ env: {}, tty: true, answers: ["y", "y"] });
    const { code, report } = await install(r, "--on", "comment", "--secret", KEY);
    expect(code).toBe(0);
    const set = callOf(r, ["secret", "set"])!;
    expect(set.terminal).toBe(true);
    expect(set.input).toBeUndefined();
    expect(report.secret).toEqual({ name: KEY, state: "set" });
    expect(r.asked[0]).toMatch(new RegExp(`Store the repository secret ${KEY} on ${R} now\\?`));
  });

  it("with the key not set here and no terminal, prints the command and stores nothing", async () => {
    const r = rig({ env: {} });
    const { code, report } = await install(r, "--secret", KEY, "--yes");
    expect(code).toBe(0);
    expect(callOf(r, ["secret", "set"])).toBeUndefined();
    expect(report.secret).toEqual({ name: KEY, state: "printed" });
    expect(report.next).toContainEqual(
      expect.stringContaining(`gh secret set ${KEY} --repo ${R} --app actions`),
    );
    // the workflow still lands
    expect(report.workflow.written).toBe("pr");
  });

  it("a label that already exists is fine", async () => {
    const r = rig({ world: { labelExists: true } });
    const { code, report } = await install(r, "--on", "label", "--secret", KEY, "--yes");
    expect(code).toBe(0);
    expect(report.label).toBe("exists");
    expect(report.errors).toEqual([]);
  });

  // MUTATION: count any failure of `label create` as "already exists" in
  // install. The label reads as there, and this fails.
  it("a label gh could not create is a failure, printed, and the run goes on", async () => {
    const r = rig({ world: { labelFails: true } });
    const { code, report } = await install(r, "--on", "label", "--secret", KEY, "--yes");
    expect(code).toBe(1);
    expect(report.label).toBe("printed");
    expect(report.errors).toEqual([
      "gh could not create the label qcr-review: HTTP 403: Resource not accessible by integration",
    ]);
    expect(report.next).toContainEqual(
      expect.stringContaining(`create the label: gh label create qcr-review --repo ${R}`),
    );
    expect(report.workflow.written).toBe("pr");
  });

  it("makes no label without the label trigger", async () => {
    const r = rig();
    const { report } = await install(r, "--on", "comment,push", "--secret", KEY, "--yes");
    expect(report.label).toBeNull();
    expect(callOf(r, ["label", "create"])).toBeUndefined();
  });

  // MUTATION: drop the --force check before the PUT — the existing workflow
  // is overwritten and this fails.
  it("refuses to replace a workflow the default branch has, unless --force, which carries its sha", async () => {
    const r = rig({ world: { workflowSha: OLD_SHA } });
    const { code, report } = await install(r, "--secret", KEY, "--yes");
    expect(code).toBe(1);
    expect(report.errors.join("\n")).toMatch(
      /already has \.github\/workflows\/quickreview\.yml on main: pass --force/,
    );
    expect(callOf(r, ["api", "-X"])).toBeUndefined();
    expect(callOf(r, ["pr", "create"])).toBeUndefined();
    expect(report.workflow.written).toBeNull();

    const f = rig({ world: { workflowSha: OLD_SHA } });
    const forced = await install(f, "--secret", KEY, "--yes", "--force");
    expect(forced.code).toBe(0);
    expect(fields(callOf(f, ["api", "-X", "PUT"])!.args)["sha"]).toBe(OLD_SHA);
    expect(forced.report.workflow.written).toBe("pr");
  });

  it("takes the next free branch name when qcr/action-install is taken", async () => {
    const r = rig({ world: { taken: ["qcr/action-install", "qcr/action-install-2"] } });
    const { code } = await install(r, "--secret", KEY, "--yes");
    expect(code).toBe(0);
    expect(fields(callOf(r, ["api", "-X", "POST"])!.args)["ref"]).toBe(
      "refs/heads/qcr/action-install-3",
    );
    const pr = callOf(r, ["pr", "create"])!.args;
    expect(pr[pr.indexOf("--head") + 1]).toBe("qcr/action-install-3");
  });

  // Each step of the workflow's way onto GitHub stops the step when it fails:
  // the next one would act on what was not there (a pull request from a
  // branch with no commit, a commit to a branch that was not made).
  // MUTATION: drop `if (!ran(put)) { cannot(…); return; }` from openPr. The
  // putFails case opens a pull request, and this fails.
  it("stops the workflow at the first gh read or write that fails, and says how to write it yourself", async () => {
    const W = WORKFLOW_PATH;
    const cases: Array<[Partial<World>, string, string[]]> = [
      [
        { repoReadFails: true },
        `could not read ${R}'s default branch: gh: Bad credentials (HTTP 401)`,
        [],
      ],
      [{ contentsFails: true }, `could not read ${W} on ${R}: gh: Server Error (HTTP 502)`, []],
      [
        { headFails: true },
        `could not read the head of ${R}'s main: gh: Server Error (HTTP 500)`,
        [],
      ],
      [
        { branchCheckFails: true },
        `could not check the branch qcr/action-install on ${R}: gh: Server Error (HTTP 503)`,
        [],
      ],
      [
        { taken: TAKEN },
        `the branches qcr/action-install to qcr/action-install-20 are all taken on ${R}`,
        [],
      ],
      [
        { postFails: true },
        "gh could not create the branch qcr/action-install: gh: Reference already exists (HTTP 422)",
        ["api -X POST"],
      ],
      [
        { putFails: true },
        `gh could not commit ${W} to qcr/action-install (the branch is there; delete it or run again): gh: Resource not accessible by personal access token (HTTP 403)`,
        ["api -X POST", "api -X PUT"],
      ],
    ];
    for (const [world, error, writes] of cases) {
      const r = rig({ world });
      const { code, report } = await install(r, "--secret", KEY, "--yes");
      expect(code, error).toBe(1);
      expect(report.errors, error).toEqual([error]);
      expect(report.workflow, error).toEqual({ path: W, written: null, pr_url: null });
      expect(
        r
          .gh()
          .filter((c) => /^(api -X|pr create)/.test(c))
          .map((c) => c.split(" ").slice(0, 3).join(" ")),
        error,
      ).toEqual(writes);
      expect(report.next, error).toContain(
        `or write the workflow yourself: qcr action workflow --on comment,manual --secret ${KEY} > ${W}`,
      );
    }
  });

  it("a pull request gh could not open is a failure, with the command to open it", async () => {
    const r = rig({ world: { prFails: true } });
    const { code, report } = await install(r, "--secret", KEY, "--yes");
    expect(code).toBe(1);
    expect(report.ok).toBe(false);
    expect(report.workflow).toEqual({ path: WORKFLOW_PATH, written: null, pr_url: null });
    expect(report.next).toContainEqual(
      expect.stringMatching(/^open it yourself: gh pr create --repo acme\/widgets/),
    );
  });

  it("a secret gh could not store is a failure, printed, and the run goes on", async () => {
    const r = rig({ world: { secretSetFails: true } });
    const { code, report } = await install(r, "--secret", KEY, "--yes");
    expect(code).toBe(1);
    expect(report.secret).toEqual({ name: KEY, state: "printed" });
    expect(report.workflow.written).toBe("pr");
  });

  it("a secret list gh could not read is a failure, and nothing is stored blind", async () => {
    const r = rig({ world: { secretListFails: true } });
    const { code, report } = await install(r, "--secret", KEY, "--yes");
    expect(code).toBe(1);
    expect(callOf(r, ["secret", "set"])).toBeUndefined();
    expect(report.secret?.state).toBe("printed");
  });
});

describe("qcr action install: asking", () => {
  // MUTATION: treat "nobody to ask" as a yes — the writes are made with no
  // terminal and no --yes, and this fails.
  it("with no terminal and no --yes, writes nothing and prints what to run", async () => {
    const r = rig();
    const { code, report } = await install(r, "--on", "comment,label", "--secret", KEY);
    expect(code).toBe(0);
    const writes = r.gh().filter((c) => /^(secret set|label create|api -X|pr create)/.test(c));
    expect(writes).toEqual([]);
    expect(report.secret?.state).toBe("printed");
    expect(report.label).toBe("printed");
    expect(report.workflow.written).toBeNull();
    expect(report.next).toContainEqual(
      `or write the workflow yourself: qcr action workflow --on comment,label --secret ${KEY} > ${WORKFLOW_PATH}`,
    );
  });

  it("asks before each write in a terminal, and a no writes nothing", async () => {
    const r = rig({ tty: true, answers: ["n", "n", "n"] });
    const { code, report } = await install(r, "--on", "comment,label", "--secret", KEY);
    expect(code).toBe(0);
    expect(r.asked).toEqual([
      `Store your local ${KEY} as the repository secret ${KEY}? [y/N] `,
      `Create the label qcr-review on ${R}? [y/N] `,
      expect.stringMatching(
        /^Open a pull request on acme\/widgets that adds \.github\/workflows\/quickreview\.yml \(branch qcr\/action-install, from main\)\? \[y\/N\] $/,
      ),
    ]);
    expect(r.gh().filter((c) => /^(secret set|label create|api -X|pr create)/.test(c))).toEqual([]);
    expect(report.workflow.written).toBeNull();
  });

  it("asks for the triggers in a terminal: numbers or names, Enter for the defaults", async () => {
    const picked = rig({ tty: true, answers: ["2, push", "y", "y", "y"] });
    expect((await install(picked, "--secret", KEY)).report.on).toEqual(["label", "push"]);
    expect(picked.asked[0]).toMatch(/^Which triggers\?/);

    const kept = rig({ tty: true, answers: ["", "y", "y"] });
    expect((await install(kept, "--secret", KEY)).report.on).toEqual(["comment", "manual"]);

    const again = rig({ tty: true, answers: ["9", "manual", "y", "y"] });
    expect((await install(again, "--secret", KEY)).report.on).toEqual(["manual"]);
  });

  it("with no terminal, takes comment and manual and says how to choose others", async () => {
    const r = rig();
    const code = await cmdAction(["install", "--secret", KEY], false, r.deps);
    expect(code).toBe(0);
    expect(r.out.join("\n")).toMatch(
      /Triggers: comment, manual, the default \(--on comment,label,push,manual/,
    );
  });
});

describe("qcr action install: the secret's name", () => {
  it("is the key the model route uses here when --secret is not given", async () => {
    const r = rig({ routeKey: "ROUTE_MODEL_KEY", env: { ROUTE_MODEL_KEY: VALUE } });
    const { code, report } = await install(r, "--yes");
    expect(code).toBe(0);
    expect(report.secret).toEqual({ name: "ROUTE_MODEL_KEY", state: "set" });
    expect(callOf(r, ["secret", "set"])!.input).toBe(VALUE);
  });

  it("is asked in a terminal when the route names none, and refused with no terminal", async () => {
    const asked = rig({ tty: true, answers: ["", "lower", "ASKED_KEY", "y", "y"], env: {} });
    const { report } = await install(asked, "--on", "manual");
    expect(report.secret?.name).toBe("ASKED_KEY");

    const none = rig();
    const code = await cmdAction(["install", "--on", "manual"], true, none.deps);
    expect(code).toBe(2);
    expect(JSON.parse(none.out.join("\n"))).toEqual({
      error: expect.stringMatching(/^qcr action install: pass --secret NAME/) as string,
    });
    expect(none.gh().filter((c) => /^(secret set|label create|api -X|pr create)/.test(c))).toEqual(
      [],
    );
  });

  it("ignores a route key GitHub would refuse as a secret name", async () => {
    const r = rig({ routeKey: "GITHUB_MODEL_KEY" });
    expect(await cmdAction(["install", "--yes"], true, r.deps)).toBe(2);
  });

  it("reads the env key from qcr model --json, and only an env key", () => {
    const line = (credential: object): string =>
      JSON.stringify({ ok: true, route: { credential } });
    expect(
      routeKeyOf(
        line({ kind: "api_key", origin: "env-key", label: "SOME_API_KEY", subscription: false }),
      ),
    ).toBe("SOME_API_KEY");
    expect(routeKeyOf(line({ kind: "oauth", origin: "stored", subscription: true }))).toBeNull();
    expect(routeKeyOf(line({ kind: "api_key", origin: "ambient", label: "a profile" }))).toBeNull();
    expect(routeKeyOf(JSON.stringify({ ok: false, route: null }))).toBeNull();
    expect(routeKeyOf("not json")).toBeNull();
    expect(routeKeyOf(undefined)).toBeNull();
  });
});

describe("qcr action install: the repository and gh", () => {
  it("is --repo, as OWNER/NAME or a github.com URL, else this checkout's origin", async () => {
    const url = rig({ world: { origin: null } });
    expect(
      (await install(url, "--repo", "https://github.com/acme/widgets", "--secret", KEY, "--yes"))
        .report.repo,
    ).toBe(R);
    expect(url.calls.find((c) => c.cmd === "git")).toBeUndefined();

    const origin = rig({ world: { origin: "https://github.com/acme/widgets.git" } });
    expect((await install(origin, "--secret", KEY, "--yes")).report.repo).toBe(R);
  });

  it("refuses with exit 2 when there is none, before any gh call", async () => {
    for (const world of [{ origin: null }, { origin: "git@gitlab.example:acme/widgets.git" }]) {
      const r = rig({ world });
      expect(await cmdAction(["install", "--secret", KEY], false, r.deps)).toBe(2);
      expect(r.err.join("\n")).toMatch(/pass --repo OWNER\/NAME/);
      expect(r.gh()).toEqual([]);
    }
    const bad = rig();
    expect(
      await cmdAction(["install", "--repo", "not a repo", "--secret", KEY], false, bad.deps),
    ).toBe(2);
  });

  // MUTATION: go on to the writes when gh is missing — a write is attempted
  // and this fails.
  it("stops before any write when gh is missing, logged out, or lacks a scope, and says what to run", async () => {
    const cases: Array<[Partial<World>, string]> = [
      [{ ghInstalled: false }, "install gh, the GitHub CLI, then run: gh auth login"],
      [{ loggedIn: false }, "gh auth login"],
      [{ scopes: "'gist', 'read:org', 'repo'" }, "gh auth refresh -h github.com -s workflow"],
      [{ scopes: "'gist', 'read:org'" }, "gh auth refresh -h github.com -s repo,workflow"],
    ];
    for (const [world, fix] of cases) {
      const r = rig({ world });
      const { code, report } = await install(r, "--secret", KEY, "--yes");
      expect(code, fix).toBe(1);
      expect(report.next[0], fix).toBe(fix);
      // the steps it did not reach
      expect(report.on).toEqual([]);
      expect(report.secret).toBeNull();
      expect(report.label).toBeNull();
      expect(report.workflow.written).toBeNull();
      expect(
        r.gh().filter((c) => !/^(--version|auth status)/.test(c)),
        fix,
      ).toEqual([]);
    }
  });

  it("goes on when gh lists no scopes at all, and says what the token needs", async () => {
    const r = rig({ world: { scopes: null } });
    const code = await cmdAction(["install", "--secret", KEY, "--yes"], false, r.deps);
    expect(code).toBe(0);
    expect(r.out.join("\n")).toMatch(/gh lists no scopes for its token/);
  });
});

describe("qcr action install --local", () => {
  it("writes the workflow into the checkout, with the git steps next", async () => {
    const top = fresh();
    const r = rig({ world: { checkout: top } });
    const { code, report } = await install(r, "--local", "--on", "push", "--secret", KEY, "--yes");
    expect(code).toBe(0);
    expect(readFileSync(join(top, WORKFLOW_PATH), "utf8")).toBe(
      renderWorkflow({ on: ["push"], secretEnv: KEY }),
    );
    expect(report.workflow).toEqual({ path: WORKFLOW_PATH, written: "local", pr_url: null });
    expect(report.next).toEqual(
      expect.arrayContaining([`git add ${WORKFLOW_PATH}`, expect.stringMatching(/^git push/)]),
    );
    // the secret's step reads the organization's secrets; the workflow's way
    // onto GitHub is not taken
    expect(r.gh().filter((c) => /^(api|pr create)/.test(c))).toEqual([`api ${ORG_SECRETS}`]);
  });

  // MUTATION: drop the --force check in writeLocal — the file is replaced and
  // this fails.
  it("refuses to overwrite an existing workflow unless --force", async () => {
    const top = fresh();
    mkdirSync(join(top, ".github", "workflows"), { recursive: true });
    writeFileSync(join(top, WORKFLOW_PATH), "mine\n");
    const r = rig({ world: { checkout: top } });
    const { code, report } = await install(r, "--local", "--secret", KEY, "--yes");
    expect(code).toBe(1);
    expect(report.errors.join("\n")).toMatch(/is already there: pass --force/);
    expect(readFileSync(join(top, WORKFLOW_PATH), "utf8")).toBe("mine\n");

    const f = rig({ world: { checkout: top } });
    expect((await install(f, "--local", "--secret", KEY, "--yes", "--force")).code).toBe(0);
    expect(readFileSync(join(top, WORKFLOW_PATH), "utf8")).toBe(
      renderWorkflow({ on: ["comment", "manual"], secretEnv: KEY }),
    );
  });

  it("needs no gh for the workflow: the secret and the label are printed", async () => {
    const top = fresh();
    const r = rig({ world: { checkout: top, ghInstalled: false } });
    const { code, report } = await install(r, "--local", "--on", "label", "--secret", KEY, "--yes");
    expect(code).toBe(0);
    expect(report.secret).toEqual({ name: KEY, state: "printed" });
    expect(report.label).toBe("printed");
    expect(report.workflow.written).toBe("local");
    expect(existsSync(join(top, WORKFLOW_PATH))).toBe(true);
    expect(report.next).toContainEqual(
      expect.stringContaining(
        "gh label create qcr-review --repo acme/widgets --description 'Ask QuickReview for a review'",
      ),
    );
  });

  it("needs no workflow scope", async () => {
    const top = fresh();
    const r = rig({ world: { checkout: top, scopes: "'repo'" } });
    expect((await install(r, "--local", "--secret", KEY, "--yes")).code).toBe(0);
  });

  it("outside a checkout is a failure", async () => {
    const r = rig({ world: { checkout: null } });
    const { code, report } = await install(r, "--local", "--secret", KEY, "--yes");
    expect(code).toBe(1);
    expect(report.errors.join("\n")).toMatch(/not in one/);
  });
});

describe("qcr action install --json", () => {
  it("prints one object, with these keys", async () => {
    const r = rig();
    const { report } = await install(r, "--secret", KEY, "--yes");
    expect(r.out).toHaveLength(1);
    expect(Object.keys(report).sort()).toEqual(
      ["errors", "label", "next", "ok", "on", "repo", "secret", "workflow"].sort(),
    );
    expect(Object.keys(report.workflow).sort()).toEqual(["path", "pr_url", "written"]);
    expect(r.err).toEqual([]);
  });

  // The values are the ones docs/action.md lists, and every one of them is
  // reached by some path, so the sets are not a self-loop.
  // MUTATION: report `label: "declined"` when the person says no in install.
  // The value is outside the documented set, and this fails.
  it("holds every value to the documented set, on every install path", async () => {
    const seen = {
      secret: new Set<string | null>(),
      label: new Set<string | null>(),
      written: new Set<string | null>(),
    };
    for (const p of PATHS) {
      const r = p.rig();
      const code = await cmdAction(["install", ...p.args], true, r.deps);
      expect(r.out, p.name).toHaveLength(1);
      const report = JSON.parse(r.out[0]!) as InstallReport;
      expect(Object.keys(report).sort(), p.name).toEqual(
        ["errors", "label", "next", "ok", "on", "repo", "secret", "workflow"].sort(),
      );
      expect(report.ok, p.name).toBe(report.errors.length === 0);
      expect(code, p.name).toBe(report.ok ? 0 : 1);
      expect(report.repo, p.name).toBe(R);
      for (const on of report.on) expect(RECIPES, p.name).toContain(on);
      if (report.secret !== null) {
        expect(Object.keys(report.secret).sort(), p.name).toEqual(["name", "state"]);
        expect(["kept", "set", "printed"], p.name).toContain(report.secret.state);
      }
      seen.secret.add(report.secret?.state ?? null);
      expect([null, "created", "exists", "printed"], p.name).toContain(report.label);
      if (!report.on.includes("label")) expect(report.label, p.name).toBeNull();
      seen.label.add(report.label);
      expect(Object.keys(report.workflow).sort(), p.name).toEqual(["path", "pr_url", "written"]);
      expect(report.workflow.path, p.name).toBe(WORKFLOW_PATH);
      expect([null, "pr", "local"], p.name).toContain(report.workflow.written);
      seen.written.add(report.workflow.written);
      if (report.workflow.written !== "pr") expect(report.workflow.pr_url, p.name).toBeNull();
      for (const line of [...report.next, ...report.errors])
        expect(typeof line, p.name).toBe("string");
    }
    expect([...seen.secret].sort()).toEqual(["kept", "printed", "set", null].sort());
    expect([...seen.label].sort()).toEqual(["created", "exists", "printed", null].sort());
    expect([...seen.written].sort()).toEqual(["local", "pr", null].sort());
  });
});

// ---- the closed list of gh calls (ADR 0003) -----------------------------------

/** The gh calls the install may make, written here on their own: a call the
 * module adds to its own list fails here until it is added here too. */
const ALLOWED: ReadonlyArray<[string, (a: readonly string[]) => boolean]> = [
  ["--version", (a) => a.length === 1 && a[0] === "--version"],
  ["auth status", (a) => a.join(" ") === "auth status --hostname github.com"],
  ["secret list", (a) => a.join(" ") === `secret list --repo ${R} --app actions`],
  [
    "secret set",
    (a) => /^secret set [A-Z][A-Z0-9_]* --repo acme\/widgets --app actions$/.test(a.join(" ")),
  ],
  ["label create", (a) => a.slice(0, 5).join(" ") === `label create qcr-review --repo ${R}`],
  ["api GET repo", (a) => a.length === 2 && a[0] === "api" && a[1] === `repos/${R}`],
  [
    "api GET org secrets",
    (a) =>
      a.length === 2 &&
      a[0] === "api" &&
      a[1] === `repos/${R}/actions/organization-secrets?per_page=100`,
  ],
  [
    "api GET contents",
    (a) => a.length === 2 && a[0] === "api" && a[1]!.startsWith(`repos/${R}/contents/`),
  ],
  [
    "api GET ref",
    (a) => a.length === 2 && a[0] === "api" && a[1]!.startsWith(`repos/${R}/git/ref/heads/`),
  ],
  ["api POST refs", (a) => a.slice(0, 4).join(" ") === `api -X POST repos/${R}/git/refs`],
  [
    "api PUT contents",
    (a) => a.slice(0, 4).join(" ") === `api -X PUT repos/${R}/contents/${WORKFLOW_PATH}`,
  ],
  ["pr create", (a) => a.slice(0, 4).join(" ") === `pr create --repo ${R}`],
];

/** Every install path the branches above take, run again for the fence. */
const PATHS: ReadonlyArray<{ name: string; rig: () => Rig; args: string[] }> = [
  {
    name: "pr, everything",
    rig: () => rig(),
    args: ["--on", "comment,label,push,manual", "--secret", KEY, "--yes"],
  },
  {
    name: "secret kept",
    rig: () => rig({ world: { secrets: [KEY] } }),
    args: ["--secret", KEY, "--yes"],
  },
  {
    name: "secret by terminal",
    rig: () => rig({ env: {}, tty: true, answers: ["y", "y"] }),
    args: ["--on", "comment", "--secret", KEY],
  },
  { name: "secret printed", rig: () => rig({ env: {} }), args: ["--secret", KEY, "--yes"] },
  {
    name: "label exists",
    rig: () => rig({ world: { labelExists: true } }),
    args: ["--on", "label", "--secret", KEY, "--yes"],
  },
  {
    name: "workflow there",
    rig: () => rig({ world: { workflowSha: OLD_SHA } }),
    args: ["--secret", KEY, "--yes"],
  },
  {
    name: "workflow forced",
    rig: () => rig({ world: { workflowSha: OLD_SHA } }),
    args: ["--secret", KEY, "--yes", "--force"],
  },
  {
    name: "branch taken",
    rig: () => rig({ world: { taken: ["qcr/action-install"] } }),
    args: ["--secret", KEY, "--yes"],
  },
  {
    name: "pr fails",
    rig: () => rig({ world: { prFails: true } }),
    args: ["--secret", KEY, "--yes"],
  },
  { name: "nobody to ask", rig: () => rig(), args: ["--on", "label", "--secret", KEY] },
  {
    name: "all declined",
    rig: () => rig({ tty: true, answers: ["n", "n", "n"] }),
    args: ["--on", "label", "--secret", KEY],
  },
  {
    name: "no gh",
    rig: () => rig({ world: { ghInstalled: false } }),
    args: ["--secret", KEY, "--yes"],
  },
  {
    name: "logged out",
    rig: () => rig({ world: { loggedIn: false } }),
    args: ["--secret", KEY, "--yes"],
  },
  {
    name: "no workflow scope",
    rig: () => rig({ world: { scopes: "'repo'" } }),
    args: ["--secret", KEY, "--yes"],
  },
  {
    name: "local",
    rig: () => rig({ world: { checkout: fresh() } }),
    args: ["--local", "--on", "label", "--secret", KEY, "--yes"],
  },
  {
    name: "local, no gh",
    rig: () => rig({ world: { checkout: fresh(), ghInstalled: false } }),
    args: ["--local", "--secret", KEY, "--yes"],
  },
  { name: "route key", rig: () => rig({ routeKey: KEY }), args: ["--yes"] },
  {
    name: "secret list fails",
    rig: () => rig({ world: { secretListFails: true } }),
    args: ["--secret", KEY, "--yes"],
  },
  {
    name: "secret set fails",
    rig: () => rig({ world: { secretSetFails: true } }),
    args: ["--secret", KEY, "--yes"],
  },
  {
    name: "org secret kept",
    rig: () => rig({ world: { orgSecrets: [KEY] } }),
    args: ["--secret", KEY, "--yes"],
  },
  {
    name: "org secrets unreadable",
    rig: () => rig({ world: { orgSecrets: 403 } }),
    args: ["--secret", KEY, "--yes"],
  },
  {
    name: "org secrets 404",
    rig: () => rig({ world: { orgSecrets: 404 } }),
    args: ["--secret", KEY, "--yes"],
  },
  {
    name: "label fails",
    rig: () => rig({ world: { labelFails: true } }),
    args: ["--on", "label", "--secret", KEY, "--yes"],
  },
  {
    name: "triggers and name asked",
    rig: () => rig({ tty: true, env: {}, answers: ["label", "ASKED_KEY", "y", "y", "y"] }),
    args: [],
  },
  {
    name: "local, file there",
    rig: () => {
      const top = fresh();
      mkdirSync(join(top, ".github", "workflows"), { recursive: true });
      writeFileSync(join(top, WORKFLOW_PATH), "mine\n");
      return rig({ world: { checkout: top } });
    },
    args: ["--local", "--secret", KEY, "--yes"],
  },
  {
    name: "local, no checkout",
    rig: () => rig({ world: { checkout: null } }),
    args: ["--local", "--secret", KEY, "--yes"],
  },
  ...(
    [
      "repoReadFails",
      "contentsFails",
      "headFails",
      "branchCheckFails",
      "postFails",
      "putFails",
    ] as const
  ).map((knob) => ({
    name: knob,
    rig: () => rig({ world: { [knob]: true } }),
    args: ["--secret", KEY, "--yes"],
  })),
  {
    name: "every branch taken",
    rig: () => rig({ world: { taken: TAKEN } }),
    args: ["--secret", KEY, "--yes"],
  },
];

describe("the closed list of gh calls", () => {
  // MUTATION: add `runGh(deps, repo, ["pr", "merge", branch])` to a path of
  // src/actioncli.ts — runGh throws, or, with the call also added to
  // ghCallAllowed, the list here refuses it; either way this fails.
  it("every install path calls gh only as the list allows, git only to read, and nothing else", async () => {
    const seen = new Set<string>();
    for (const p of PATHS) {
      const r = p.rig();
      await cmdAction(["install", ...p.args], true, r.deps);
      for (const c of r.calls) {
        expect(["gh", "git"], `${p.name}: ${c.cmd}`).toContain(c.cmd);
        expect(c.args.join(" "), p.name).not.toContain(VALUE);
        if (c.cmd === "git") {
          expect(["remote get-url origin", "rev-parse --show-toplevel"], p.name).toContain(
            c.args.join(" "),
          );
          continue;
        }
        const kind = ALLOWED.find(([, allowed]) => allowed(c.args));
        expect(kind, `${p.name}: gh ${c.args.join(" ")}`).toBeDefined();
        seen.add(kind![0]);
      }
    }
    // the paths above reach every call on the list, so the list is not a
    // self-loop over calls nobody makes
    expect([...seen].sort()).toEqual(ALLOWED.map(([k]) => k).sort());
  });

  // MUTATION: make ghCallAllowed return true — runGh runs these, and this fails.
  it("runGh refuses any other call before it runs", () => {
    const r = rig();
    const refused: string[][] = [
      ["pr", "merge", "12", "--repo", R],
      ["repo", "delete", R, "--yes"],
      ["api", "-X", "DELETE", `repos/${R}/git/refs/heads/main`],
      ["api", `repos/${R}/contents/x`, "-f", "a=b"],
      ["api", "repos/other/repo"],
      ["api", `repos/${R}/../../orgs/acme`],
      ["api", "-X", "PUT", `repos/${R}/collaborators/eve`],
      ["api", "-X", "POST", `repos/${R}/git/refs`, "--input", "file"],
      ["secret", "set", KEY, "--body", VALUE, "--repo", R, "--app", "actions"],
      ["secret", "set", KEY, "--repo", "other/repo", "--app", "actions"],
      ["secret", "set", "GITHUB_TOKEN", "--repo", R, "--app", "actions"],
      ["label", "create", "other", "--repo", R],
      ["pr", "create", "--repo", "other/repo"],
      ["auth", "token"],
    ];
    for (const args of refused) {
      expect(ghCallAllowed(args, R), args.join(" ")).toBe(false);
      expect(() => runGh(r.deps, R, args), args.join(" ")).toThrow(
        /is not a call qcr action makes/,
      );
    }
    expect(r.calls).toEqual([]);
    expect(ghCallAllowed(["api", `repos/${R}/contents/${WORKFLOW_PATH}?ref=main`], R)).toBe(true);
  });
});

// ---- gh's output, read ---------------------------------------------------------

describe("reading gh", () => {
  it("reads the active account's token scopes, and none for a token that lists none", () => {
    expect(tokenScopes(authStatus("'gist', 'read:org', 'repo', 'workflow'"))).toEqual([
      "gist",
      "read:org",
      "repo",
      "workflow",
    ]);
    expect(tokenScopes(authStatus(null))).toBeNull();
    const two = [
      "github.com",
      "  ✓ Logged in to github.com account old (keyring)",
      "  - Active account: false",
      "  - Token scopes: 'gist'",
      "",
      "  ✓ Logged in to github.com account octo (keyring)",
      "  - Active account: true",
      "  - Token scopes: 'repo', 'workflow'",
    ].join("\n");
    expect(tokenScopes(two)).toEqual(["repo", "workflow"]);
  });

  it("reads secret names from gh secret list", () => {
    expect(secretNames("A_KEY\t2026-11-01T00:00:00Z\nb_key\t2026-11-02\n\n")).toEqual([
      "A_KEY",
      "B_KEY",
    ]);
    expect(secretNames("")).toEqual([]);
  });
});

// ---- qcr action workflow, the help, the usage ---------------------------------

describe("qcr action workflow", () => {
  it("prints the renderer's output and runs nothing", async () => {
    const r = rig();
    expect(
      await cmdAction(["workflow", "--on", "label,manual", "--secret", KEY], false, r.deps),
    ).toBe(0);
    expect(`${r.out.join("\n")}\n`).toBe(
      renderWorkflow({ on: ["label", "manual"], secretEnv: KEY }),
    );
    expect(r.calls).toEqual([]);
  });

  it("defaults to comment and manual, and the route's key", async () => {
    const r = rig({ routeKey: "ROUTE_MODEL_KEY" });
    expect(await cmdAction(["workflow"], true, r.deps)).toBe(0);
    expect(JSON.parse(r.out.join("\n"))).toEqual({
      ok: true,
      on: ["comment", "manual"],
      secret: "ROUTE_MODEL_KEY",
      path: WORKFLOW_PATH,
      workflow: renderWorkflow({ on: ["comment", "manual"], secretEnv: "ROUTE_MODEL_KEY" }),
    });
  });

  it("with no --secret and no route key, is a usage error", async () => {
    const r = rig();
    expect(await cmdAction(["workflow"], false, r.deps)).toBe(2);
    expect(r.err.join("\n")).toMatch(/pass --secret NAME/);
  });
});

describe("qcr action: help and usage", () => {
  it("bare, or with --help, prints the help", async () => {
    for (const args of [[], ["--help"], ["help"], ["install", "-h"]]) {
      const r = rig();
      expect(await cmdAction(args, false, r.deps), args.join(" ")).toBe(0);
      expect(r.out.join("\n")).toBe(ACTION_HELP);
      expect(r.calls).toEqual([]);
    }
    for (const r of RECIPES) expect(ACTION_HELP).toContain(r);
  });

  it("refuses a bad verb, flag or value with exit 2, as JSON under --json", async () => {
    const bad = [
      ["uninstall"],
      ["install", "--on", "nightly"],
      ["install", "--on"],
      ["install", "--on", "comment", "--on", "manual"],
      ["install", "--secret", "GITHUB_TOKEN"],
      ["install", "--secret", "lower"],
      ["install", "--dry-run"],
      ["workflow", "--local"],
      ["workflow", "--repo", R],
    ];
    for (const args of bad) {
      const text = rig();
      expect(await cmdAction(args, false, text.deps), args.join(" ")).toBe(2);
      expect(text.err.join("\n"), args.join(" ")).toMatch(/^qcr action: [\s\S]*usage: qcr action/);
      expect(text.calls).toEqual([]);
      const json = rig();
      expect(await cmdAction(args, true, json.deps)).toBe(2);
      expect(JSON.parse(json.out.join("\n"))).toEqual({
        error: expect.stringMatching(/^qcr action: /) as string,
      });
    }
  });

  it("takes --on=…, --secret=… and --repo=…", async () => {
    const r = rig({ world: { origin: null } });
    const { code, report } = await install(r, "--on=label", `--secret=${KEY}`, `--repo=${R}`, "-y");
    expect(code).toBe(0);
    expect(report.on).toEqual(["label"]);
    expect(report.secret?.name).toBe(KEY);
  });
});

// ---- through the bin, against a fake gh on PATH --------------------------------

// The fake: node, so it can log its argv and stdin as JSON; its shebang names
// this node, so the temp PATH needs nothing else. It reads its stdin before it
// exits, so the writer's EPIPE cannot race the case.
const FAKE_GH = `#!${process.execPath}
const fs = require("node:fs");
const argv = process.argv.slice(2);
let input = "";
try { input = fs.readFileSync(0, "utf8"); } catch {}
fs.appendFileSync(process.env.FAKE_GH_LOG, JSON.stringify({ argv, input }) + "\\n");
const R = "acme/widgets";
const j = argv.join(" ");
const say = (s) => { process.stdout.write(s); process.exit(0); };
const notFound = () => { process.stdout.write('{"message":"Not Found","status":"404"}'); process.stderr.write("gh: Not Found (HTTP 404)\\n"); process.exit(1); };
if (j === "--version") say("gh version 2.101.0 (2026-09-15)\\n");
if (argv[0] === "auth") say("github.com\\n  ✓ Logged in to github.com account octo (keyring)\\n  - Active account: true\\n  - Token scopes: 'repo', 'workflow'\\n");
if (argv[0] === "secret") say("");
if (argv[0] === "api" && argv[1] === "-X") say("{}");
if (argv[0] === "api" && argv[1] === "repos/" + R) say(JSON.stringify({ default_branch: "main" }));
if (argv[0] === "api" && argv[1].endsWith("/git/ref/heads/main")) say(JSON.stringify({ object: { sha: "${HEAD_SHA}" } }));
if (argv[0] === "api") notFound();
if (argv[0] === "pr" && argv[1] === "create") say("${PR_URL}\\n");
process.stderr.write("the fake gh knows no " + j + "\\n");
process.exit(1);
`;

describe("qcr action install through the bin, with a fake gh on PATH", () => {
  const KEYS = ["PATH", "QCR_NO_UPDATE_NOTICE", "FAKE_GH_LOG", "RUNBIN_MODEL_KEY"];
  const saved: Record<string, string | undefined> = {};
  let dir: string;
  let out: string[];

  beforeEach(() => {
    dir = fresh();
    mkdirSync(join(dir, "bin"));
    writeFileSync(join(dir, "bin", "gh"), FAKE_GH, { mode: 0o755 });
    for (const k of KEYS) saved[k] = process.env[k];
    process.env.PATH = join(dir, "bin");
    process.env.QCR_NO_UPDATE_NOTICE = "1";
    process.env.FAKE_GH_LOG = join(dir, "gh.log");
    process.env.RUNBIN_MODEL_KEY = VALUE;
    out = [];
    vi.spyOn(console, "log").mockImplementation((l: unknown) => void out.push(String(l)));
    vi.spyOn(console, "error").mockImplementation(() => {});
    process.exitCode = undefined;
  });

  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  // MUTATION: give the real run `stdio: "ignore"` for stdin whatever the
  // input — gh reads no key, and this fails.
  it("stores the key on the real child's stdin and opens the pull request", async () => {
    await runBin([
      "action",
      "install",
      "--repo",
      R,
      "--on",
      "comment,manual",
      "--secret",
      "RUNBIN_MODEL_KEY",
      "--yes",
      "--json",
    ]);
    expect(Number(process.exitCode ?? 0)).toBe(0);
    const report = JSON.parse(out.join("\n")) as InstallReport;
    expect(report.ok).toBe(true);
    expect(report.secret).toEqual({ name: "RUNBIN_MODEL_KEY", state: "set" });
    expect(report.workflow).toEqual({ path: WORKFLOW_PATH, written: "pr", pr_url: PR_URL });

    const log = readFileSync(process.env.FAKE_GH_LOG!, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { argv: string[]; input: string });
    for (const c of log) expect(c.argv.join(" ")).not.toContain(VALUE);
    for (const c of log) expect(offTheList("gh", c.argv)).toEqual([]);
    const set = log.find((c) => c.argv[0] === "secret" && c.argv[1] === "set")!;
    expect(set.input).toBe(VALUE);
    for (const c of log.filter((x) => x !== set)) expect(c.input).toBe("");
    const put = log.find((c) => c.argv[2] === "PUT")!;
    expect(Buffer.from(fields(put.argv)["content"]!, "base64").toString("utf8")).toBe(
      renderWorkflow({ on: ["comment", "manual"], secretEnv: "RUNBIN_MODEL_KEY" }),
    );
  });
});
