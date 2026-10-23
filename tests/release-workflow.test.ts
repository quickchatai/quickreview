// The release workflow (.github/workflows/release.yml). Running it needs
// GitHub, docker, two architectures and a model, so the suite pins what can be
// read without any of them:
//   - the triggers (a vX.Y.Z tag or a manual dispatch, nothing else);
//   - the gate order: nothing but `publish` logs in or pushes, and publish
//     needs the build and the e2e;
//   - the paid e2e: its own environment, and the only job that reads a secret;
//   - the arm64 runners (D15): native by default, QEMU on a variable;
//   - provenance attestations for every pushed digest;
//   - the `plan` step's version rules, run for real against a temp package.json.
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const text = readFileSync(join(root, ".github", "workflows", "release.yml"), "utf8");

interface Step {
  name?: string;
  id?: string;
  uses?: string;
  run?: string;
  env?: Record<string, string>;
}
interface Job {
  needs?: string | string[];
  if?: string;
  environment?: string;
  "runs-on": string;
  permissions?: Record<string, string>;
  strategy?: { matrix: Record<string, unknown> };
  steps: Step[];
}
const wf = parse(text) as {
  on: { push: { tags: string[] }; workflow_dispatch: { inputs: Record<string, unknown> } } & Record<
    string,
    unknown
  >;
  permissions: Record<string, string>;
  jobs: Record<string, Job>;
};
const jobText = (name: string): string => JSON.stringify(wf.jobs[name]);
const needs = (name: string): string[] => [wf.jobs[name]!.needs ?? []].flat();

describe("release.yml — triggers and permissions", () => {
  it("runs on a v* tag or a manual dispatch and nothing else", () => {
    expect(Object.keys(wf.on).sort()).toEqual(["push", "workflow_dispatch"]);
    expect(wf.on.push).toEqual({ tags: ["v*.*.*"] });
    expect(Object.keys(wf.on.workflow_dispatch.inputs).sort()).toEqual([
      "publish",
      "run_e2e",
      "version",
    ]);
  });

  it("is read-only by default; only publish may write packages or attest, only attach-manifest contents", () => {
    expect(wf.permissions).toEqual({ contents: "read" });
    for (const [name, job] of Object.entries(wf.jobs)) {
      if (name !== "publish" && name !== "attach-manifest")
        expect(job.permissions, name).toBeUndefined();
    }
    // Actions sets permissions per job, so the contents write is its own job
    // and publish never holds it.
    expect(wf.jobs["attach-manifest"]!.permissions).toEqual({ contents: "write" });
    expect(wf.jobs.publish!.permissions).not.toHaveProperty("contents", "write");
    expect(wf.jobs.publish!.permissions).toEqual({
      contents: "read",
      packages: "write",
      "id-token": "write",
      attestations: "write",
    });
  });
});

describe("release.yml — the gates", () => {
  it("orders plan, build, e2e, publish", () => {
    expect(needs("build")).toEqual(["plan"]);
    expect(needs("e2e").sort()).toEqual(["build", "plan"]);
    expect(needs("publish").sort()).toEqual(["build", "e2e", "plan"]);
  });

  it("logs in and pushes in the publish job only", () => {
    for (const name of ["plan", "build", "e2e"]) {
      expect(jobText(name), name).not.toMatch(
        /docker\/login-action|docker push|imagetools|push\\?":\s*true|packages/,
      );
    }
    expect(jobText("publish")).toMatch(/docker\/login-action/);
    const build = wf.jobs.build!.steps.find((s) => s.uses?.startsWith("docker/build-push-action"));
    expect(build).toBeDefined();
    expect(JSON.stringify(build)).toMatch(/"push":false/);
    expect(JSON.stringify(build)).toMatch(/"load":true/);
  });

  it("publishes only after the e2e passed, or was skipped on purpose", () => {
    const cond = wf.jobs.publish!.if!;
    expect(cond).toContain("needs.build.result == 'success'");
    expect(cond).toContain("needs.e2e.result == 'success'");
    expect(cond).toContain("needs.e2e.result == 'skipped' && needs.plan.outputs.e2e != 'true'");
  });

  it("the paid e2e runs in release-e2e and no other job reads a secret but the token", () => {
    expect(wf.jobs.e2e!.environment).toBe("release-e2e");
    expect(jobText("e2e")).toContain("secrets.RELEASE_E2E_PI_AUTH");
    expect(jobText("e2e")).toMatch(/--limit/);
    expect(jobText("e2e")).toContain("D37");
    for (const name of ["plan", "build", "publish"]) {
      const secrets = [...jobText(name).matchAll(/secrets\.([A-Z_]+)/g)].map((m) => m[1]);
      expect(
        secrets.filter((s) => s !== "GITHUB_TOKEN"),
        name,
      ).toEqual([]);
    }
    expect(wf.jobs.e2e!.if).toBe("needs.plan.outputs.e2e == 'true'");
  });

  it("builds both images for both architectures and smokes each offline", () => {
    const m = wf.jobs.build!.strategy!.matrix;
    expect(m.image).toEqual(["release", "memory"]);
    expect(m.arch).toEqual(["amd64", "arm64"]);
    const run = wf.jobs.build!.steps.map((s) => s.run ?? "").join("\n");
    expect(run).toContain(".github/ci/image-smoke.sh");
    expect(run).toContain("openviking");
    expect(jobText("build")).toContain("docker/Dockerfile");
    expect(jobText("build")).toContain("docker/memory/Dockerfile");
  });

  it("native arm64 runners by default, QEMU when RELEASE_ARM64_RUNNER=qemu (D15)", () => {
    const inc = (wf.jobs.build!.strategy!.matrix.include as Record<string, string>[]).find(
      (i) => i.arch === "arm64",
    )!;
    expect(inc.runner).toContain("ubuntu-24.04-arm");
    expect(inc.runner).toContain("vars.RELEASE_ARM64_RUNNER == 'qemu'");
    expect(inc.qemu).toContain("vars.RELEASE_ARM64_RUNNER == 'qemu'");
    const qemu = wf.jobs.build!.steps.find((s) => s.uses?.startsWith("docker/setup-qemu-action"));
    expect(qemu).toBeDefined();
    expect((qemu as unknown as { if: string }).if).toBe("matrix.qemu == 'true'");
  });

  it("runs on Blacksmith's runners and builder, and on GitHub's with QCR_RUNNERS=github", () => {
    for (const [name, job] of Object.entries(wf.jobs)) {
      const runsOn = job["runs-on"];
      if (name === "build") continue;
      expect(runsOn, name).toMatch(
        /^\$\{\{ vars\.QCR_RUNNERS == 'github' && 'ubuntu-latest' \|\| 'blacksmith-\d+vcpu-ubuntu-2404' \}\}$/,
      );
    }
    const inc = wf.jobs.build!.strategy!.matrix.include as Record<string, string>[];
    expect(inc.find((i) => i.arch === "amd64")!.runner).toContain("blacksmith-8vcpu-ubuntu-2404'");
    expect(inc.find((i) => i.arch === "arm64")!.runner).toContain(
      "blacksmith-8vcpu-ubuntu-2404-arm",
    );
    // one builder per route, each the only one that runs there; both load and never push
    const steps = wf.jobs.build!.steps as (Step & {
      if?: string;
      with?: Record<string, unknown>;
    })[];
    const bs = steps.find((s) => s.uses?.startsWith("useblacksmith/build-push-action@"))!;
    const gh = steps.find((s) => s.uses?.startsWith("docker/build-push-action@"))!;
    expect(bs.if).toBe("startsWith(matrix.runner, 'blacksmith-')");
    expect(gh.if).toBe("${{ !startsWith(matrix.runner, 'blacksmith-') }}");
    for (const b of [bs, gh]) expect(b.with).toMatchObject({ load: true, push: false });
    const setup = steps.find((s) => s.uses?.startsWith("useblacksmith/setup-docker-builder@"))!;
    expect(setup.if).toBe(bs.if);
    expect(JSON.stringify(bs.with)).not.toContain("type=gha");
  });

  it("attests provenance for each arch digest and the index", () => {
    const att = wf.jobs.publish!.steps.filter((s) =>
      s.uses?.startsWith("actions/attest-build-provenance"),
    );
    expect(att).toHaveLength(3);
    expect(JSON.stringify(att)).toMatch(
      /steps\.push\.outputs\.amd64.*steps\.push\.outputs\.arm64.*steps\.push\.outputs\.index/,
    );
    expect(JSON.stringify(att)).not.toMatch(/"push-to-registry":false/);
    // a private repo on a plan without attestations still publishes
    for (const step of att)
      expect((step as unknown as { if: string }).if).toBe(
        "github.event.repository.visibility == 'public' || vars.RELEASE_ATTEST == 'true'",
      );
  });

  it("tags nothing but the version (no latest, no floating major)", () => {
    expect(text).not.toMatch(/:latest|imagetools create -t [^\n]*:v?[0-9]+["\s]/);
    expect(text).toContain('imagetools create -t "$REPO:$VERSION"');
  });
});

describe("release.yml — the deploy manifest", () => {
  it("is assembled after publish and attached by its own job", () => {
    expect(needs("manifest").sort()).toEqual(["plan", "publish"]);
    expect(needs("attach-manifest")).toContain("publish");
    expect(needs("attach-manifest")).toContain("manifest");
    expect(wf.jobs.manifest!.permissions).toBeUndefined();
  });

  it("a scratch version gets no manifest", () => {
    expect(wf.jobs.manifest!.if).toContain("needs.plan.outputs.scratch != 'true'");
    expect(wf.jobs["attach-manifest"]!.if).toContain("needs.manifest.result == 'success'");
  });

  it("the manifest is a workflow artifact and the attach step uploads that file to the release", () => {
    const up = wf.jobs.manifest!.steps.find((s) => s.uses?.startsWith("actions/upload-artifact"));
    expect(JSON.stringify(up)).toContain("deploy-manifest-");
    expect(jobText("manifest")).toContain("scripts/emit-deploy-manifest.mjs");
    expect(jobText("attach-manifest")).toContain("gh release upload");
    // the write job runs no checked-out code and never logs in to a registry
    expect(jobText("attach-manifest")).not.toMatch(/actions\/checkout|docker\/login-action/);
  });

  it("publish records each image's digests for the manifest", () => {
    expect(jobText("publish")).toContain("digests-${{ matrix.image }}");
  });
});

describe("release.yml — the plan step", () => {
  const plan = wf.jobs.plan!.steps.find((s) => s.id === "plan")!;
  const dirs: string[] = [];

  function runPlan(
    env: Record<string, string>,
    pkgVersion = "1.2.3",
  ): { status: number | null; out: Record<string, string> } {
    const dir = mkdtempSync(join(tmpdir(), "release-plan-"));
    dirs.push(dir);
    writeFileSync(join(dir, "package.json"), JSON.stringify({ version: pkgVersion }));
    const out = join(dir, "out");
    writeFileSync(out, "");
    const r = spawnSync("bash", ["-c", plan.run!], {
      cwd: dir,
      env: {
        PATH: process.env.PATH!,
        GITHUB_OUTPUT: out,
        GITHUB_STEP_SUMMARY: join(dir, "sum"),
        ...env,
      },
      encoding: "utf8",
    });
    const kv = Object.fromEntries(
      readFileSync(out, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
    );
    return { status: r.status, out: kv };
  }
  const tag = (name: string) => ({ EVENT: "push", REF_TYPE: "tag", REF_NAME: name });
  const dispatch = (v: string, e2e: boolean, publish: boolean, ref = "refs/heads/x") => ({
    EVENT: "workflow_dispatch",
    REF_TYPE: ref.includes("tags") ? "tag" : "branch",
    REF_NAME: ref.replace(/^refs\/(heads|tags)\//, ""),
    IN_VERSION: v,
    IN_E2E: String(e2e),
    IN_PUBLISH: String(publish),
  });

  it("a real tag matching package.json runs the e2e and publishes", () => {
    const r = runPlan(tag("v1.2.3"));
    expect(r.status).toBe(0);
    expect(r.out).toEqual({ version: "1.2.3", scratch: "false", e2e: "true", publish: "true" });
  });

  it("refuses a tag that disagrees with package.json", () => {
    expect(runPlan(tag("v1.2.4")).status).toBe(1);
  });

  it("refuses a malformed version", () => {
    expect(runPlan(tag("vNEXT")).status).toBe(1);
    expect(runPlan(dispatch("1.2", true, false)).status).toBe(1);
  });

  it("refuses a hyphen inside the suffix, which the deploy-side version checks reject", () => {
    expect(runPlan(dispatch("1.2.3-rc-one", true, false)).status).toBe(1);
    expect(runPlan(tag("v0.0.0-scratch-1")).status).toBe(1);
  });

  it("a scratch tag skips the paid e2e, whatever package.json says", () => {
    const r = runPlan(tag("v0.0.0-scratch.1"));
    expect(r.status).toBe(0);
    expect(r.out).toMatchObject({ scratch: "true", e2e: "false", publish: "true" });
  });

  it("a real version cannot skip the e2e, nor run from a branch", () => {
    expect(runPlan(dispatch("1.2.3", false, false, "refs/tags/v1.2.3")).status).toBe(1);
    expect(runPlan(dispatch("1.2.3", true, true)).status).toBe(1);
    expect(runPlan(dispatch("1.2.3", true, true, "refs/tags/v1.2.3")).out.publish).toBe("true");
  });

  it("a scratch dispatch may skip the e2e and defaults to not publishing", () => {
    const r = runPlan(dispatch("0.0.0-scratch.2", false, false));
    expect(r.status).toBe(0);
    expect(r.out).toMatchObject({ scratch: "true", e2e: "false", publish: "false" });
  });

  it("cleans up", () => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });
});
