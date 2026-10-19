// The onboarding docs are pinned to the onboarding code.
//
// `qcr onboard` composes the tools the manual path documents, so the wizard and
// the docs must describe ONE truth — drift between them is the bug this suite
// exists to catch. It asserts the load-bearing FACTS only (step ids and orders,
// label names, ingress option ids and their compose profiles, the entry
// command), never prose: a doc may be reworded freely, but it may not silently
// stop describing a step that exists, or keep describing one that does not.
//
// Prior art: tests/skill-descriptions.test.ts (prose-content assertions over
// checked-in files) and tests/docker-daemon.test.ts (image defaults pinned
// against their mirrors).
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DEFAULT_LABELS } from "../src/onboard/steps/githubapp.js";
import { INGRESS_OPTIONS } from "../src/onboard/steps/ingress.js";
import { defaultSteps } from "../src/onboard/steps/index.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string): string => readFileSync(join(repoRoot, rel), "utf8");

const onboardingDoc = read("docs/onboarding.md");
const readme = read("README.md");
const appDoc = read("docs/github-app-setup.md");
const dockerDoc = read("docker/daemon/README.md");
const ansibleDoc = read("deploy/ansible/README.md");

describe("docs/onboarding.md tracks the registered steps", () => {
  const steps = defaultSteps();

  it("every registered step's order appears in the checklist table", () => {
    for (const step of steps) {
      expect(
        onboardingDoc,
        `step "${step.id}" (order ${step.order}) is registered but its order is not in the checklist table`,
      ).toContain(`| ${step.order} |`);
    }
  });

  it("the checklist table lists no order that no step registers", () => {
    const registered = new Set(steps.map((s) => String(s.order)));
    const table = [...onboardingDoc.matchAll(/^\| (\d+) \|/gm)].map((m) => m[1]!);
    expect(table.length, "the checklist table was not found").toBeGreaterThan(0);
    for (const order of table) {
      expect(
        registered.has(order),
        `the doc lists step order ${order}, which nothing registers`,
      ).toBe(true);
    }
  });

  it("the two route-specific step sets are documented as such", () => {
    // `enabled` is what makes a step route-specific; the doc's table marks the
    // route in the same row. A step that gains or loses an `enabled` predicate
    // must have its row updated.
    const routed = steps.filter((s) => s.enabled !== undefined).map((s) => s.order);
    expect(
      routed.length,
      "no route-specific steps found — the topology split is gone?",
    ).toBeGreaterThan(0);
    for (const order of routed) {
      const row = onboardingDoc.match(new RegExp(`^\\| ${order} \\|.*$`, "m"));
      expect(row, `no checklist row for order ${order}`).not.toBeNull();
      expect(
        row![0],
        `order ${order} is route-specific in code but its row says "both"`,
      ).not.toContain("| both |");
    }
  });
});

describe("the setup docs name the real ingress shapes", () => {
  it("every ingress option id and compose profile is documented", () => {
    for (const option of INGRESS_OPTIONS) {
      expect(
        onboardingDoc,
        `ingress option "${option.id}" is missing from docs/onboarding.md`,
      ).toContain(`\`${option.id}\``);
      if (option.profile !== "") {
        expect(
          dockerDoc,
          `compose profile "${option.profile}" is missing from docker/daemon/README.md`,
        ).toContain(option.profile);
      }
      if (option.service !== null) {
        expect(
          dockerDoc,
          `sidecar service "${option.service}" is missing from docker/daemon/README.md`,
        ).toContain(option.service);
      }
    }
  });

  it("the degraded surfaces of the no-tunnel shape are named, not implied", () => {
    // The polling shape is the one whose cost is invisible until it bites: the
    // webhook-driven paths go quiet. Both the code's own trade-off text and the
    // docs must say so.
    const polling = INGRESS_OPTIONS.find((o) => o.id === "polling");
    expect(polling).toBeDefined();
    expect(polling!.tradeoffs.join(" ")).toMatch(/feedback/i);
    for (const [name, doc] of [
      ["docs/onboarding.md", onboardingDoc],
      ["README.md", readme],
      ["docker/daemon/README.md", dockerDoc],
    ] as const) {
      expect(doc, `${name} must name the [feedback] loop among the polling-only costs`).toMatch(
        /poll[\s\S]{0,600}feedback/i,
      );
    }
  });
});

describe("the GitHub App doc matches the labels the wizard creates", () => {
  it("names every default label", () => {
    for (const label of Object.values(DEFAULT_LABELS)) {
      expect(
        appDoc,
        `label "${label}" is created by the wizard but absent from docs/github-app-setup.md`,
      ).toContain(label);
    }
  });

  it("the defaults match config.example.toml, which is what the daemon reads", () => {
    const example = read("config.example.toml");
    expect(example).toContain(`trigger_label = "${DEFAULT_LABELS.trigger}"`);
    expect(example).toContain(`in_progress_label = "${DEFAULT_LABELS.in_progress}"`);
    expect(example).toContain(`reviewed_label = "${DEFAULT_LABELS.reviewed}"`);
  });
});

describe("the entry point is the one the docs promise", () => {
  // The user docs tell a reader to run `qcr onboard` (the host wrapper the
  // image installs); the developer docs tell a contributor to run it from a
  // clone with `scripts/qcr onboard` / `npm run onboard`, so that script must
  // exist and run the wrapper.
  const pkg = JSON.parse(read("package.json")) as { scripts?: Record<string, string> };

  it("package.json carries an onboard script that runs the wrapper", () => {
    const script = pkg.scripts?.onboard;
    expect(script, "package.json has no `onboard` script").toBeDefined();
    expect(script, "the onboard script must invoke the same wrapper the docs name").toContain(
      "scripts/qcr",
    );
    expect(script).toContain("onboard");
  });

  it("the wrapper the docs name exists and the CLI knows the verb", () => {
    expect(read("scripts/qcr")).toContain("dist/src/cli.js");
    expect(read("src/cli.ts")).toContain('case "onboard"');
    expect(read("CONTRIBUTING.md")).toContain("scripts/qcr onboard");
  });

  it("the user entry point is the host wrapper's, the clone one is in the developer section", () => {
    expect(onboardingDoc).toContain("```sh\nqcr onboard\n```");
    expect(readme).toContain("qcr onboard");
    expect(read("CONTRIBUTING.md")).toContain("npm run onboard");
    expect(read("scripts/install-wrapper.sh")).toContain("qcr");
  });

  it("the user docs install the wrapper from the image, behind the private-registry login", () => {
    for (const [name, doc] of [
      ["docs/onboarding.md", onboardingDoc],
      ["README.md", readme],
    ] as const) {
      expect(doc, name).toContain("gh auth refresh -s read:packages");
      expect(doc, name).toContain("docker login ghcr.io");
      expect(doc, name).toMatch(/ghcr\.io\/quickchatai\/quickreview:<version>/);
    }
  });
});

describe("the quickstart leads with the onboarding command", () => {
  it("README names the entry command and links the walkthrough", () => {
    const quickstart = readme.slice(
      readme.indexOf("## Quickstart"),
      readme.indexOf("### Where the reviewer lives"),
    );
    expect(quickstart, "the Quickstart section was not found").not.toBe("");
    expect(quickstart).toContain("qcr onboard");
    expect(readme).toContain("docs/onboarding.md");
  });

  it("the manual path survives as an appendix rather than being deleted", () => {
    const appendix = readme.slice(readme.indexOf("## Appendix — setting up by hand"));
    expect(appendix, "the manual-path appendix is gone").not.toBe("");
    for (const tool of ["config.example.toml", "docker compose pull", "docker compose up -d"]) {
      expect(appendix, `the manual path no longer mentions ${tool}`).toContain(tool);
    }
    // the image world: pulled, never built, and no checkout to clone
    expect(appendix).not.toMatch(/--build|git clone|npm ci/);
  });

  it("both topologies are advertised, and each route doc points back at the wizard", () => {
    expect(readme).toContain("deploy/ansible/README.md");
    expect(readme).toContain("docker/daemon/README.md");
    for (const [name, doc] of [
      ["deploy/ansible/README.md", ansibleDoc],
      ["docker/daemon/README.md", dockerDoc],
    ] as const) {
      expect(doc, `${name} must point at the guided path it is the manual half of`).toContain(
        "qcr onboard",
      );
    }
  });

  it("the Windows answer and the Slack later-step pointer are present", () => {
    expect(readme).toMatch(/WSL2/);
    expect(onboardingDoc).toMatch(/WSL2/);
    expect(readme).toContain("npm run slack:setup");
    expect(onboardingDoc).toContain("npm run slack:setup");
  });
});
