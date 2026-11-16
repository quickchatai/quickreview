// The workflow that runs the QuickReview Action (src/actionworkflow.ts): one
// renderer behind `qcr action workflow`, `qcr action install` and the docs
// template, docs/action/qcr-review.yml.
//
// What it holds, for each trigger recipe and for every combination of them:
// the `on:` triggers (label and push merged into one pull_request list), the
// job's `if:` as the OR of the chosen recipes' parts, the `pr` input passed
// only with `manual`, no checkout step, the permissions, the Action at the
// floating major tag, the 90-minute timeout, the concurrency group on the
// job, the model key's secret in the step's env, and actionlint on the
// output (skipped where actionlint is not installed). The docs template is
// the renderer's output byte for byte.
//
// The example secret name lives here, not in the renderer: shipped code names
// no provider (tests/fences-modelnames.test.ts, ADR 0002).
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  COMMENT_COMMAND,
  DEFAULT_RECIPES,
  RECIPES,
  REVIEW_LABEL,
  WORKFLOW_PATH,
  parseRecipes,
  renderWorkflow,
  secretNameProblem,
  type Recipe,
} from "../src/actionworkflow.js";

const ROOT = resolve(import.meta.dirname, "..");

/** The docs template, and the secret name it is rendered with. */
const TEMPLATE = "docs/action/qcr-review.yml";
const EXAMPLE_SECRET = "ANTHROPIC_API_KEY";
const REGENERATE = `qcr action workflow --on comment,manual --secret ${EXAMPLE_SECRET} > ${TEMPLATE}`;

/** Each recipe's part of the job's `if:`, as the spec words it (FT-0809 B1). */
const IF_PART: Record<Recipe, string> = {
  comment:
    "github.event_name == 'issue_comment' && github.event.issue.pull_request && startsWith(github.event.comment.body, '/qcr')",
  label:
    "github.event_name == 'pull_request' && github.event.action == 'labeled' && github.event.label.name == 'qcr-review'",
  push: "github.event_name == 'pull_request' && github.event.action != 'labeled' && !github.event.pull_request.draft",
  manual: "github.event_name == 'workflow_dispatch'",
};

interface Step {
  uses?: string;
  run?: string;
  env?: Record<string, string>;
  with?: Record<string, string>;
}
interface Workflow {
  name: string;
  on: Record<string, Record<string, unknown> | null>;
  permissions: Record<string, string>;
  concurrency?: unknown;
  jobs: Record<
    string,
    {
      "runs-on": string;
      "timeout-minutes": number;
      concurrency: { group: string; "cancel-in-progress": boolean };
      if: string;
      steps: Step[];
    }
  >;
}

const render = (on: readonly Recipe[], secretEnv = "SOME_MODEL_KEY"): string =>
  renderWorkflow({ on, secretEnv });
const parsed = (on: readonly Recipe[], secretEnv?: string): Workflow =>
  parse(render(on, secretEnv)) as Workflow;
const jobOf = (w: Workflow) => w.jobs["review"]!;

/** Every non-empty set of recipes, each in RECIPES order. */
const COMBOS: Recipe[][] = Array.from({ length: 2 ** RECIPES.length - 1 }, (_, i) =>
  RECIPES.filter((_r, bit) => ((i + 1) >> bit) & 1),
);

describe("the recipes", () => {
  it("are comment, label, push and manual, with the label and the comment command named once", () => {
    expect(RECIPES).toEqual(["comment", "label", "push", "manual"]);
    expect(DEFAULT_RECIPES).toEqual(["comment", "manual"]);
    expect(REVIEW_LABEL).toBe("qcr-review");
    expect(COMMENT_COMMAND).toBe("/qcr");
    expect(WORKFLOW_PATH).toBe(".github/workflows/quickreview.yml");
    expect(COMBOS).toHaveLength(15);
  });

  it("each renders its own trigger", () => {
    expect(parsed(["comment"]).on).toEqual({ issue_comment: { types: ["created"] } });
    expect(parsed(["label"]).on).toEqual({ pull_request: { types: ["labeled"] } });
    expect(parsed(["push"]).on).toEqual({
      pull_request: { types: ["opened", "synchronize", "ready_for_review"] },
    });
    expect(parsed(["manual"]).on).toEqual({
      workflow_dispatch: {
        inputs: { pr: { description: expect.any(String), required: true, type: "string" } },
      },
    });
  });

  // MUTATION: render label's `pull_request:` block on its own beside push's —
  // the key repeats, the YAML no longer parses to one list, and this fails.
  it("label and push merge into one pull_request types list", () => {
    const w = parsed(["label", "push"]);
    expect(Object.keys(w.on)).toEqual(["pull_request"]);
    expect(w.on["pull_request"]).toEqual({
      types: ["opened", "synchronize", "ready_for_review", "labeled"],
    });
    expect(render(["label", "push"]).match(/^ {2}pull_request:$/gm)).toHaveLength(1);
  });

  it("combine: every chosen recipe's trigger, and no other", () => {
    const trigger: Record<Recipe, string> = {
      comment: "issue_comment",
      label: "pull_request",
      push: "pull_request",
      manual: "workflow_dispatch",
    };
    for (const on of COMBOS) {
      const want = [...new Set(on.map((r) => trigger[r]))];
      expect(Object.keys(parsed(on).on), on.join(",")).toEqual(want);
    }
  });

  it("parse from a comma-separated list, in RECIPES order with repeats dropped", () => {
    expect(parseRecipes("comment,manual")).toEqual(["comment", "manual"]);
    expect(parseRecipes(" manual, comment ,comment")).toEqual(["comment", "manual"]);
    expect(parseRecipes("push,label,manual,comment")).toEqual([...RECIPES]);
    expect(typeof parseRecipes("")).toBe("string");
    expect(typeof parseRecipes(",")).toBe("string");
    expect(parseRecipes("comment,nightly")).toMatch(/"nightly" is not a trigger/);
  });
});

describe("the job", () => {
  // MUTATION: drop the parentheses around one part, or join the parts with
  // `&&` — the folded `if:` differs and this fails.
  it("its if: is the OR of the chosen recipes' parts, in RECIPES order", () => {
    for (const on of COMBOS) {
      const want = on.map((r) => `(${IF_PART[r]})`).join(" || ");
      expect(jobOf(parsed(on)).if, on.join(",")).toBe(want);
    }
  });

  it("the parts are the label and the command the module names", () => {
    expect(IF_PART.comment).toContain(`'${COMMENT_COMMAND}'`);
    expect(IF_PART.label).toContain(`'${REVIEW_LABEL}'`);
  });

  // MUTATION: pass `pr: ${{ inputs.pr }}` whatever the recipes — a workflow
  // with no workflow_dispatch names an input it does not declare, and this
  // fails (actionlint refuses it too).
  it("passes the pr input only with manual, and names inputs.pr nowhere else", () => {
    for (const on of COMBOS) {
      const text = render(on);
      const step = jobOf(parse(text) as Workflow).steps[0]!;
      if (on.includes("manual")) {
        expect(step.with, on.join(",")).toEqual({ pr: "${{ inputs.pr }}" });
        expect(jobOf(parse(text) as Workflow).concurrency.group).toContain("inputs.pr");
      } else {
        expect(step.with, on.join(",")).toBeUndefined();
        expect(text, on.join(",")).not.toContain("inputs.pr");
      }
    }
  });

  // MUTATION: add an actions/checkout step before the Action — this fails.
  it("has one step, the Action, and no checkout", () => {
    for (const on of COMBOS) {
      const text = render(on);
      const steps = jobOf(parse(text) as Workflow).steps;
      expect(steps, on.join(",")).toHaveLength(1);
      expect(steps[0]!.run).toBeUndefined();
      expect(text).not.toMatch(/actions\/checkout/);
    }
  });

  it("reads contents and writes pull requests, nothing more", () => {
    for (const on of COMBOS)
      expect(parsed(on).permissions, on.join(",")).toEqual({
        contents: "read",
        "pull-requests": "write",
      });
  });

  it("uses the Action at the floating major tag", () => {
    for (const on of COMBOS)
      expect(jobOf(parsed(on)).steps[0]!.uses, on.join(",")).toMatch(/^[\w-]+\/quickreview@v1$/);
  });

  it("times out after 90 minutes, on ubuntu", () => {
    for (const on of COMBOS) {
      expect(jobOf(parsed(on))["timeout-minutes"]).toBe(90);
      expect(jobOf(parsed(on))["runs-on"]).toBe("ubuntu-latest");
    }
  });

  // On the workflow, a comment that is not /qcr would cancel a review in
  // flight. MUTATION: move `concurrency:` to the workflow's top level — this
  // fails.
  it("has one concurrency group per pull request, on the job, cancelling the run in flight", () => {
    for (const on of COMBOS) {
      const w = parsed(on);
      expect(w.concurrency, on.join(",")).toBeUndefined();
      const c = jobOf(w).concurrency;
      expect(c["cancel-in-progress"]).toBe(true);
      expect(c.group).toMatch(/^quickreview-\$\{\{ .+ \}\}$/);
      expect(c.group).toContain("github.event.pull_request.number");
      expect(c.group).toContain("github.event.issue.number");
    }
  });

  it("puts the model key's secret in the step's env, under its own name", () => {
    for (const on of COMBOS)
      expect(jobOf(parsed(on, "MY_PROVIDER_KEY")).steps[0]!.env).toEqual({
        MY_PROVIDER_KEY: "${{ secrets.MY_PROVIDER_KEY }}",
      });
  });

  it("sets no cap and no dry run, and shows the optional settings as comments", () => {
    for (const on of COMBOS) {
      const text = render(on);
      expect(text).not.toMatch(/dry[_-]run/i);
      expect(text).toMatch(/^\s*#\s+profile: security\s/m);
      expect(text).toMatch(/^\s*#\s+model: provider\/model\s/m);
      expect(text).toMatch(/^\s*#\s+limit: "5"\s/m);
    }
  });

  it("says in its header how each chosen recipe asks for a review", () => {
    const head = (on: Recipe[]): string => render(on).split("\nname: ")[0]!;
    expect(head(["comment"])).toContain("/qcr");
    expect(head(["label"])).toContain("qcr-review");
    expect(head(["push"])).not.toContain("/qcr");
    for (const on of COMBOS) {
      const lines = head(on).split("\n");
      expect(lines.every((l) => l.startsWith("# "))).toBe(true);
      // the title, one line per recipe, the cost, the docs
      expect(lines, on.join(",")).toHaveLength(on.length + 3);
      expect(head(on)).toContain("a re-run pays again");
    }
  });
});

describe("the renderer", () => {
  // MUTATION: render the recipes in the order they were given — this fails.
  it("is deterministic: the same file whatever the order or repeats of the recipes", () => {
    for (const on of COMBOS) {
      const once = render(on);
      expect(render([...on].reverse())).toBe(once);
      expect(render([...on, ...on])).toBe(once);
      expect(once.endsWith("\n")).toBe(true);
      expect(once.endsWith("\n\n")).toBe(false);
    }
  });

  it("refuses no recipe, an unknown one, and a secret name GitHub would refuse", () => {
    expect(() => render([])).toThrow(/no trigger/);
    expect(() => render(["nightly" as Recipe])).toThrow(/"nightly" is not a trigger/);
    for (const bad of ["lower_key", "9LIVES", "A-B", "A KEY", "", "GITHUB_TOKEN", "GITHUB_X"]) {
      expect(() => render(["comment"], bad), bad).toThrow();
      expect(secretNameProblem(bad), bad).not.toBeNull();
    }
    for (const good of ["X", "MY_KEY", EXAMPLE_SECRET, "KEY_2"])
      expect(secretNameProblem(good), good).toBeNull();
  });

  // Skipped silently where actionlint is not installed, as tests/action.test.ts
  // does. MUTATION: name `inputs.pr` in the concurrency group whatever the
  // recipes — actionlint refuses the input no workflow_dispatch declares.
  it("passes actionlint for every combination of recipes", () => {
    const which = spawnSync("actionlint", ["-version"], { encoding: "utf8" });
    if (which.error) return;
    for (const on of COMBOS) {
      const r = spawnSync("actionlint", ["-"], { input: render(on), encoding: "utf8" });
      expect(r.stdout + r.stderr, on.join(",")).toBe("");
      expect(r.status, on.join(",")).toBe(0);
    }
  });
});

describe("the docs template", () => {
  // MUTATION: edit docs/action/qcr-review.yml by hand, or change the renderer
  // without regenerating it — this fails and names the command.
  it("is the renderer's output for comment and manual, byte for byte", () => {
    const text = readFileSync(join(ROOT, TEMPLATE), "utf8");
    expect(
      text,
      `${TEMPLATE} is the workflow renderer's output (src/actionworkflow.ts). Regenerate it with:\n  ${REGENERATE}`,
    ).toBe(renderWorkflow({ on: ["comment", "manual"], secretEnv: EXAMPLE_SECRET }));
  });
});
