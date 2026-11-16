// The GitHub workflow that runs the QuickReview Action: one renderer, so the
// docs template (docs/action/qcr-review.yml), `qcr action workflow` and `qcr
// action install` (src/actioncli.ts) write the same file.
//
// The developer decides when a review runs. The renderer offers four trigger
// recipes, combinable into one workflow:
//
//   comment  `issue_comment` created: a comment that starts with /qcr on a
//            pull request asks for a review
//   label    `pull_request` labeled: the label qcr-review asks for one
//   push     `pull_request` opened, synchronize, ready_for_review: every push
//            to a pull request that is not a draft
//   manual   `workflow_dispatch` with a required `pr` input: run by hand
//
// `label` and `push` merge into one `pull_request: types:` list. The job's
// `if:` is the OR of the chosen recipes' parts; it only keeps runners from
// starting, and the Action's own gate (`scripts/action.sh gate`) decides who
// may start a review and which pull request it is. The `pr` input is passed
// only with `manual`, and `inputs.pr` is named only then (actionlint refuses
// an input the workflow does not declare).
//
// The job runs no checkout: the image fetches the pull request and reads the
// repository's `.qcr/` profile from its base. The concurrency group is on the
// job, so a comment that is not /qcr skips the job and cancels nothing.
//
// Pure: no I/O, the same output for the same input, the recipes always in
// the order of RECIPES whatever order they were given in. The model key's
// secret name is the caller's: no provider or key name is written here
// (tests/fences-modelnames.test.ts, ADR 0002).

/** The trigger recipes, in the order the workflow renders them. */
export const RECIPES = ["comment", "label", "push", "manual"] as const;

export type Recipe = (typeof RECIPES)[number];

/** The recipes a workflow has when nobody chose: ask by comment, or run by hand. */
export const DEFAULT_RECIPES: readonly Recipe[] = ["comment", "manual"];

/** The label that asks for a review under the `label` recipe. */
export const REVIEW_LABEL = "qcr-review";

/** The comment that asks for a review under the `comment` recipe. */
export const COMMENT_COMMAND = "/qcr";

/** Where the workflow lives in the repository. */
export const WORKFLOW_PATH = ".github/workflows/quickreview.yml";

/** The Action, at its floating major tag. */
export const ACTION_REF = "quickchatai/quickreview@v1";

/** The Action's docs, linked from the workflow's header. */
export const ACTION_DOCS_URL =
  "https://github.com/quickchatai/quickreview/blob/main/docs/action.md";

/** What each recipe does, one line each: the workflow's header and the help. */
export const RECIPE_SAYS: Readonly<Record<Recipe, string>> = {
  comment: `Comment ${COMMENT_COMMAND} on a pull request to ask for a review.`,
  label: `Add the label ${REVIEW_LABEL} to a pull request to ask for a review.`,
  push: "Every push to a pull request that is not a draft is reviewed.",
  manual:
    "Run the workflow by hand from the Actions tab (QuickReview, Run workflow) with a pull request number.",
};

/** Each recipe's part of the job's `if:`. */
const IF_PART: Readonly<Record<Recipe, string>> = {
  comment: `github.event_name == 'issue_comment' && github.event.issue.pull_request && startsWith(github.event.comment.body, '${COMMENT_COMMAND}')`,
  label: `github.event_name == 'pull_request' && github.event.action == 'labeled' && github.event.label.name == '${REVIEW_LABEL}'`,
  push: "github.event_name == 'pull_request' && github.event.action != 'labeled' && !github.event.pull_request.draft",
  manual: "github.event_name == 'workflow_dispatch'",
};

/** The `pull_request` event types, in the order they are listed. */
const PULL_REQUEST_TYPES: ReadonlyArray<{ type: string; recipe: Recipe }> = [
  { type: "opened", recipe: "push" },
  { type: "synchronize", recipe: "push" },
  { type: "ready_for_review", recipe: "push" },
  { type: "labeled", recipe: "label" },
];

/** The commented-out settings under the Action's `with:`, and what each does. */
const OPTIONS: ReadonlyArray<[string, string]> = [
  ["profile: security", "a shipped profile instead of the standard review"],
  ["model: provider/model", "default: the provider's newest"],
  ['limit: "5"', "a hard stop in US dollars; none by default"],
];

/** Why `name` cannot be the secret's name, or null when it can: an
 * environment name in capitals that GitHub accepts for a secret (it refuses
 * names starting GITHUB_). */
export function secretNameProblem(name: string): string | null {
  if (!/^[A-Z][A-Z0-9_]*$/.test(name))
    return `${JSON.stringify(name)} is not a secret name: capital letters, digits and _, starting with a letter`;
  if (name.startsWith("GITHUB_"))
    return `${JSON.stringify(name)} starts with GITHUB_, which GitHub refuses for a secret`;
  return null;
}

/** Is `s` one of the recipes? */
export function isRecipe(s: string): s is Recipe {
  return (RECIPES as readonly string[]).includes(s);
}

/** The recipes `text` names (comma-separated, e.g. `comment,manual`), in
 * RECIPES order with repeats dropped; or why it names none. */
export function parseRecipes(text: string): Recipe[] | string {
  const names = text
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
  if (names.length === 0) return `no trigger given (${RECIPES.join(", ")})`;
  const bad = names.find((n) => !isRecipe(n));
  if (bad !== undefined) return `${JSON.stringify(bad)} is not a trigger (${RECIPES.join(", ")})`;
  return RECIPES.filter((r) => names.includes(r));
}

/** The workflow's options: the chosen recipes and the name of the
 * repository secret that holds the model's API key. */
export interface WorkflowOptions {
  on: readonly Recipe[];
  secretEnv: string;
}

/** The workflow for `o`, as the file's text (it ends in a newline). Throws
 * on an unknown recipe, no recipe, or a secret name GitHub would refuse. */
export function renderWorkflow(o: WorkflowOptions): string {
  const unknown = o.on.find((r) => !isRecipe(r));
  if (unknown !== undefined)
    throw new Error(`${JSON.stringify(unknown)} is not a trigger (${RECIPES.join(", ")})`);
  const on = RECIPES.filter((r) => o.on.includes(r));
  if (on.length === 0) throw new Error(`no trigger given (${RECIPES.join(", ")})`);
  const problem = secretNameProblem(o.secretEnv);
  if (problem !== null) throw new Error(problem);
  const has = (r: Recipe): boolean => on.includes(r);
  const secret = o.secretEnv;

  const lines: string[] = [
    "# QuickReview: an AI code review of a pull request, posted as one comment-only review.",
    ...on.map((r) => `# ${RECIPE_SAYS[r]}`),
    "# Every run is a full review on your model key; a re-run pays again.",
    `# Docs: ${ACTION_DOCS_URL}`,
    "name: QuickReview",
    "",
    "on:",
  ];
  if (has("comment")) lines.push("  issue_comment:", "    types: [created]");
  const types = PULL_REQUEST_TYPES.filter((t) => has(t.recipe)).map((t) => t.type);
  if (types.length > 0) lines.push("  pull_request:", `    types: [${types.join(", ")}]`);
  if (has("manual"))
    lines.push(
      "  workflow_dispatch:",
      "    inputs:",
      "      pr:",
      "        description: The number of the pull request to review",
      "        required: true",
      "        type: string",
    );

  const group = [
    "github.event.pull_request.number",
    "github.event.issue.number",
    ...(has("manual") ? ["inputs.pr"] : []),
  ].join(" || ");
  lines.push(
    "",
    "permissions:",
    "  contents: read",
    "  pull-requests: write",
    "",
    "jobs:",
    "  review:",
    "    runs-on: ubuntu-latest",
    "    timeout-minutes: 90",
    "    concurrency:",
    `      group: quickreview-\${{ ${group} }}`,
    "      cancel-in-progress: true",
    "    if: >-",
  );
  // One line per `&&` term, each recipe's part in parentheses, the parts
  // joined by `||`: a folded scalar joins the lines back with spaces.
  on.forEach((r, i) => {
    const terms = IF_PART[r].split(" && ");
    terms.forEach((t, j) => {
      const open = j === 0 ? `${i === 0 ? "" : "|| "}(` : "&& ";
      const close = j === terms.length - 1 ? ")" : "";
      lines.push(`      ${open}${t}${close}`);
    });
  });
  lines.push(
    "    steps:",
    `      - uses: ${ACTION_REF}`,
    "        env:",
    `          ${secret}: \${{ secrets.${secret} }}`,
  );
  const option = ([setting, note]: [string, string]): string => `# ${setting.padEnd(26)}# ${note}`;
  if (has("manual")) {
    lines.push("        with:", "          pr: ${{ inputs.pr }}");
    for (const opt of OPTIONS) lines.push(`          ${option(opt)}`);
  } else {
    // a `with:` holding only comments would be an empty mapping
    lines.push("        # with:");
    for (const opt of OPTIONS) lines.push(`        #   ${option(opt).slice(2)}`);
  }
  return `${lines.join("\n")}\n`;
}
