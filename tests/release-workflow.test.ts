// The release workflow (.github/workflows/release.yml). Running it needs
// GitHub, docker, two architectures and a model, so the suite pins what can be
// read without any of them:
//   - the triggers (a vX.Y.Z tag or a manual dispatch, nothing else);
//   - the gate order: nothing but `publish` logs in to ghcr or pushes, and
//     publish needs the build and the e2e;
//   - the paid e2e: its own environment, and the only job that reads its
//     secret;
//   - the arm64 runners: native by default, QEMU on a variable;
//   - provenance attestations for every pushed digest;
//   - the `plan` step's version rules, run for real against a temp package.json;
//   - the `npm` job: a real tag push only, after the images, on GitHub's own
//     runner, in the npm-publish environment, staging and never publishing;
//     its version, pack and stage steps run for real against temp
//     package.json files and a fake npm on the PATH.
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
      if (name !== "publish" && name !== "attach-manifest" && name !== "npm")
        expect(job.permissions, name).toBeUndefined();
    }
    // MUTATION: give the npm job packages: write — this fails.
    expect(wf.jobs.npm!.permissions).toEqual({ contents: "read", "id-token": "write" });
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
    // npmjs is the npm job's alone, and the npm job never touches ghcr
    for (const [name] of Object.entries(wf.jobs)) {
      if (name === "npm") continue;
      expect(jobText(name), name).not.toMatch(
        /npm publish|npm stage|registry\.npmjs\.org|NPM_TOKEN/,
      );
    }
    expect(jobText("npm")).not.toMatch(/docker|ghcr/);
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
    expect(jobText("e2e")).toContain("release-grant ledger");
    for (const name of ["plan", "build", "publish"]) {
      const secrets = [...jobText(name).matchAll(/secrets\.([A-Z_]+)/g)].map((m) => m[1]);
      expect(
        secrets.filter((s) => s !== "GITHUB_TOKEN"),
        name,
      ).toEqual([]);
    }
    // the npm job logs in by trusted publishing alone and reads no secret.
    // MUTATION: put `NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}` back on the
    // stage step — this fails.
    const npmSecrets = [...jobText("npm").matchAll(/secrets\.([A-Z_]+)/g)].map((m) => m[1]);
    expect(npmSecrets).toEqual([]);
    // Both packages' trusted publishers name the npm-publish environment, whose
    // ref policy admits v*.*.* tags only, so a branch run cannot stage.
    // MUTATION: drop `environment: npm-publish` from the npm job — this fails.
    expect(wf.jobs.npm!.environment).toBe("npm-publish");
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

  it("native arm64 runners by default, QEMU when RELEASE_ARM64_RUNNER=qemu", () => {
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
      if (name === "build" || name === "npm") continue;
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
    // attestations only: no artifact-metadata storage record (no permission for one)
    expect(JSON.stringify(att).match(/"create-storage-record":false/g)).toHaveLength(3);
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

describe("release.yml — the npm job", () => {
  const job = wf.jobs.npm!;
  type FullStep = Step & { if?: string; with?: Record<string, unknown> };
  const steps = job.steps as FullStep[];
  const versions = steps.find((s) => s.id === "versions")!;
  const npmCheck = steps.find((s) => s.run?.includes("npm --version"))!;
  const pack = steps.find((s) => s.id === "pack")!;
  const upload = steps.find((s) => s.uses?.startsWith("actions/upload-artifact@"))!;
  const stage = steps.find((s) => s.run?.includes("npm stage publish"))!;
  const dirs: string[] = [];

  it("stages on a real tag push only, after the build, the e2e and the images", () => {
    expect(needs("npm").sort()).toEqual(["build", "e2e", "plan", "publish"]);
    const cond = job.if!;
    // MUTATION: drop the event check — a dispatch from a tag would stage to npm.
    for (const want of [
      "!cancelled()",
      "github.event_name == 'push'",
      "github.ref_type == 'tag'",
      "needs.plan.outputs.publish == 'true'",
      "needs.plan.outputs.scratch != 'true'",
      "needs.build.result == 'success'",
      "needs.e2e.result == 'success'",
      "needs.publish.result == 'success'",
    ])
      expect(cond, want).toContain(want);
    // a real version never skips the e2e, so a skipped e2e is no pass here
    expect(cond).not.toContain("needs.e2e.result == 'skipped'");
  });

  it("runs on GitHub's ubuntu-latest, whatever QCR_RUNNERS says", () => {
    // npm takes trusted publishing and provenance from GitHub-hosted runners only
    expect(job["runs-on"]).toBe("ubuntu-latest");
  });

  // The trusted publishers may stage and never publish: nothing reaches the
  // registry without a maintainer's 2FA approval.
  // MUTATION: replace `npm stage publish "$tgz"` with `npm publish "$tgz"` — this fails.
  it("never runs a plain npm publish, only npm stage publish", () => {
    const invocation = /(^|[;&|(]|\bthen|\bdo|\belse)\s*npm\s+publish\b/m;
    for (const s of steps) expect(s.run ?? "", s.name ?? s.uses).not.toMatch(invocation);
    expect(stage.run).toMatch(/^\s*if npm stage publish "\$tgz" "\$\{args\[@\]\}"; then$/m);
  });

  // MUTATION: give setup-node a registry-url — its placeholder token lands in
  // .npmrc and this fails.
  it("sets up Node 26 with the workflow's action majors, no registry-url, no cache", () => {
    const checkout = steps.find((s) => s.uses?.startsWith("actions/checkout@"))!;
    expect(checkout.uses).toBe(wf.jobs.plan!.steps[0]!.uses);
    const setup = steps.find((s) => s.uses?.startsWith("actions/setup-node@"))!;
    // pinned by SHA (tests/workflow-pins.test.ts); the trailing comment is the major
    expect(setup.uses).toMatch(/^actions\/setup-node@[0-9a-f]{40}$/);
    expect(text).toContain(`uses: ${setup.uses} # v7.`);
    expect(setup.with).toEqual({ "node-version": "26" });
    // the checks, then npm ci, then pack, then the artifact, then the stage
    const at = (s: FullStep): number => steps.indexOf(s);
    const ci = steps.find((s) => s.run === "npm ci")!;
    expect(at(versions)).toBeLessThan(at(ci));
    expect(at(npmCheck)).toBeLessThan(at(ci));
    expect(at(ci)).toBeLessThan(at(pack));
    expect(at(pack)).toBeLessThan(at(upload));
    expect(at(upload)).toBeLessThan(at(stage));
  });

  // MUTATION: name the artifact without the version, or point it off
  // $RUNNER_TEMP/npm — this fails.
  it("keeps both tarballs as the artifact npm-tarballs-<version>", () => {
    const other = wf.jobs.manifest!.steps.find((s) =>
      s.uses?.startsWith("actions/upload-artifact@"),
    )!;
    expect(upload.uses).toBe(other.uses);
    expect(upload.with).toEqual({
      name: "npm-tarballs-${{ env.VERSION }}",
      path: "${{ runner.temp }}/npm/*.tgz",
      "if-no-files-found": "error",
    });
  });

  it("logs in by trusted publishing alone: no token reaches the stage step", () => {
    expect(stage.env).toEqual({
      PUBLIC: "${{ github.event.repository.visibility == 'public' }}",
      PLUGIN_TGZ: "${{ steps.pack.outputs.plugin }}",
      APP_TGZ: "${{ steps.pack.outputs.app }}",
    });
  });

  function scratch(): string {
    const dir = mkdtempSync(join(tmpdir(), "release-npm-"));
    dirs.push(dir);
    return dir;
  }
  function packages(dir: string, root: string, plugin: string, pin: string): void {
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({
        name: "@quickchatai/quickreview",
        version: root,
        dependencies: { "@quickchatai/pi-quickreview": pin },
      }),
    );
    mkdirSync(join(dir, "packages", "pi-plugin"), { recursive: true });
    writeFileSync(
      join(dir, "packages", "pi-plugin", "package.json"),
      JSON.stringify({ name: "@quickchatai/pi-quickreview", version: plugin }),
    );
  }
  // A fake npm: `view` answers from a directory standing in for the registry;
  // `pack` writes npm's tarball name into --pack-destination; `stage publish`
  // records its arguments and fails for a tarball whose name contains
  // FAKE_STAGE_FAIL; a plain `publish` fails as a stage-only token makes it
  // fail; `--version` reports FAKE_NPM_VERSION.
  function fakeBin(dir: string): string {
    const bin = join(dir, "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(
      join(bin, "npm"),
      `#!/usr/bin/env node
const fs = require("node:fs"), path = require("node:path");
const a = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify(a) + "\\n");
const key = (s) => path.join(process.env.FAKE_REGISTRY, encodeURIComponent(s));
if (a[0] === "--version") { console.log(process.env.FAKE_NPM_VERSION || "11.20.0"); process.exit(0); }
if (a[0] === "view") {
  if (fs.existsSync(key(a[1]))) { console.log(fs.readFileSync(key(a[1]), "utf8")); process.exit(0); }
  console.error("npm error code E404"); process.exit(1);
}
if (a[0] === "pack") {
  const w = a.indexOf("--workspace");
  const p = JSON.parse(fs.readFileSync(path.join(w >= 0 ? a[w + 1] : ".", "package.json"), "utf8"));
  const file = p.name.replace(/^@/, "").replace("/", "-") + "-" + p.version + ".tgz";
  fs.writeFileSync(path.join(a[a.indexOf("--pack-destination") + 1], file), "tgz");
  console.log(file); process.exit(0);
}
if (a[0] === "stage" && a[1] === "publish") {
  const fail = process.env.FAKE_STAGE_FAIL;
  if (fail && path.basename(a[2]).includes(fail)) { console.error("npm error code E403"); process.exit(1); }
  console.log("staged"); process.exit(0);
}
if (a[0] === "publish") { console.error("npm error code E_STAGE_REQUIRED"); process.exit(1); }
process.exit(2);
`,
    );
    chmodSync(join(bin, "npm"), 0o755);
    return bin;
  }
  function runStep(
    step: Step,
    dir: string,
    env: Record<string, string>,
  ): { status: number | null; calls: string[][]; summary: string; output: string; log: string } {
    const reg = join(dir, "registry");
    mkdirSync(reg, { recursive: true });
    const log = join(dir, "npm.log");
    writeFileSync(log, "");
    const sum = join(dir, "sum");
    writeFileSync(sum, "");
    const out = join(dir, "out");
    writeFileSync(out, "");
    const r = spawnSync("bash", ["-c", step.run!], {
      cwd: dir,
      env: {
        PATH: `${fakeBin(dir)}:${process.env.PATH!}`,
        GITHUB_STEP_SUMMARY: sum,
        GITHUB_OUTPUT: out,
        RUNNER_TEMP: join(dir, "runner"),
        FAKE_LOG: log,
        FAKE_REGISTRY: reg,
        ...env,
      },
      encoding: "utf8",
    });
    const calls = readFileSync(log, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as string[]);
    return {
      status: r.status,
      calls,
      summary: readFileSync(sum, "utf8"),
      output: readFileSync(out, "utf8"),
      log: r.stdout + r.stderr,
    };
  }
  const onRegistry = (dir: string, spec: string, version: string): void => {
    mkdirSync(join(dir, "registry"), { recursive: true });
    writeFileSync(join(dir, "registry", encodeURIComponent(spec)), version);
  };
  const stages = (calls: string[][]): string[][] =>
    calls.filter((c) => c[0] === "stage" || c[0] === "publish");
  const tarballs = (dir: string, version: string) => ({
    PLUGIN_TGZ: join(dir, "runner", "npm", `quickchatai-pi-quickreview-${version}.tgz`),
    APP_TGZ: join(dir, "runner", "npm", `quickchatai-quickreview-${version}.tgz`),
  });
  function runStage(dir: string, version: string, env: Record<string, string>) {
    return runStep(stage, dir, { VERSION: version, ...tarballs(dir, version), ...env });
  }

  it("the version step passes when both packages and the root's pin are the tag's version", () => {
    const dir = scratch();
    packages(dir, "1.2.3", "1.2.3", "1.2.3");
    expect(runStep(versions, dir, { VERSION: "1.2.3", GITHUB_REF_NAME: "v1.2.3" }).status).toBe(0);
  });

  it("the version step refuses any package, or the pin, off the tag's version", () => {
    for (const [root, plugin, pin] of [
      ["1.2.4", "1.2.3", "1.2.3"],
      ["1.2.3", "1.2.4", "1.2.3"],
      ["1.2.3", "1.2.3", "^1.2.3"],
    ] as const) {
      const dir = scratch();
      packages(dir, root, plugin, pin);
      const r = runStep(versions, dir, { VERSION: "1.2.3", GITHUB_REF_NAME: "v1.2.3" });
      expect(r.status, `${root} ${plugin} ${pin}`).toBe(1);
    }
    const dir = scratch();
    packages(dir, "1.2.3", "1.2.3", "1.2.3");
    expect(runStep(versions, dir, { VERSION: "1.2.3", GITHUB_REF_NAME: "v1.2.4" }).status).toBe(1);
  });

  // MUTATION: put 11.5.1 back in the gate — 11.14.0 passes and this fails.
  it("refuses an npm older than 11.15.0, which npm stage needs", () => {
    const dir = scratch();
    for (const [v, ok] of [
      ["11.5.1", false],
      ["11.14.0", false],
      ["10.9.2", false],
      ["11.15.0", true],
      ["11.20.0", true],
      ["12.0.0", true],
    ] as const)
      expect(runStep(npmCheck, dir, { FAKE_NPM_VERSION: v }).status, v).toBe(ok ? 0 : 1);
  });

  // MUTATION: name the tarball without folding the scope's slash — the
  // existence check fails and so does this.
  it("packs the plugin and the app into $RUNNER_TEMP/npm and names both tarballs", () => {
    const dir = scratch();
    packages(dir, "1.2.3", "1.2.3", "1.2.3");
    const r = runStep(pack, dir, { VERSION: "1.2.3" });
    expect(r.status, r.log).toBe(0);
    const dest = join(dir, "runner", "npm");
    expect(r.calls.filter((c) => c[0] === "pack")).toEqual([
      ["pack", "--workspace", "packages/pi-plugin", "--pack-destination", dest],
      ["pack", "--pack-destination", dest],
    ]);
    const t = tarballs(dir, "1.2.3");
    expect(r.output).toBe(`plugin=${t.PLUGIN_TGZ}\napp=${t.APP_TGZ}\n`);
    for (const f of Object.values(t)) expect(readFileSync(f, "utf8")).toBe("tgz");
  });

  // MUTATION: swap the two `stage` lines — the app is staged first and this fails.
  it("stages the plugin's tarball first, then the app's, under latest, with provenance on a public repo", () => {
    const dir = scratch();
    packages(dir, "1.2.3", "1.2.3", "1.2.3");
    const t = tarballs(dir, "1.2.3");
    const r = runStage(dir, "1.2.3", { PUBLIC: "true" });
    expect(r.status, r.log).toBe(0);
    expect(stages(r.calls)).toEqual([
      ["stage", "publish", t.PLUGIN_TGZ, "--tag", "latest", "--access", "public", "--provenance"],
      ["stage", "publish", t.APP_TGZ, "--tag", "latest", "--access", "public", "--provenance"],
    ]);
    expect(r.summary).toContain(
      "`@quickchatai/pi-quickreview@1.2.3`: staged under dist-tag latest",
    );
    expect(r.summary).toContain("`@quickchatai/quickreview@1.2.3`: staged under dist-tag latest");
    expect(r.summary).toContain("(trusted publishing, provenance: yes)");
    expect(r.summary.indexOf("pi-quickreview@")).toBeLessThan(r.summary.indexOf("/quickreview@"));
    // the approval commands, the plugin before the app
    const listPlugin = r.summary.indexOf("`npm stage list @quickchatai/pi-quickreview`");
    const listApp = r.summary.indexOf("`npm stage list @quickchatai/quickreview`");
    expect(listPlugin).toBeGreaterThan(-1);
    expect(listApp).toBeGreaterThan(listPlugin);
    expect(r.summary).toContain("`npm stage approve <stage-id>`");
  });

  // MUTATION: drop the PUBLIC check around `args+=(--provenance)` — this fails.
  it("passes no --provenance on a private repo", () => {
    const dir = scratch();
    packages(dir, "1.2.3", "1.2.3", "1.2.3");
    const r = runStage(dir, "1.2.3", { PUBLIC: "false" });
    expect(r.status, r.log).toBe(0);
    expect(stages(r.calls)).toHaveLength(2);
    for (const c of stages(r.calls)) expect(c).not.toContain("--provenance");
    expect(r.summary).toContain("provenance: no");
  });

  // MUTATION: drop the `*-*` test that sets dist_tag=next — this fails.
  it("a prerelease is staged under next and never moves latest", () => {
    const dir = scratch();
    packages(dir, "1.3.0-rc.1", "1.3.0-rc.1", "1.3.0-rc.1");
    const r = runStage(dir, "1.3.0-rc.1", { PUBLIC: "true" });
    expect(r.status, r.log).toBe(0);
    expect(stages(r.calls)).toHaveLength(2);
    for (const c of stages(r.calls)) {
      expect(c.slice(c.indexOf("--tag"), c.indexOf("--tag") + 2)).toEqual(["--tag", "next"]);
      expect(c).not.toContain("latest");
    }
  });

  // MUTATION: drop the on_registry check before `npm stage publish` — a re-run
  // stages a published version again and this fails.
  it("skips a package whose exact version is already on the registry", () => {
    const dir = scratch();
    packages(dir, "1.2.3", "1.2.3", "1.2.3");
    onRegistry(dir, "@quickchatai/pi-quickreview@1.2.3", "1.2.3");
    const r = runStage(dir, "1.2.3", { PUBLIC: "true" });
    expect(r.status, r.log).toBe(0);
    expect(stages(r.calls)).toEqual([
      [
        "stage",
        "publish",
        tarballs(dir, "1.2.3").APP_TGZ,
        "--tag",
        "latest",
        "--access",
        "public",
        "--provenance",
      ],
    ]);
    expect(r.summary).toContain(
      "`@quickchatai/pi-quickreview@1.2.3`: skipped, already on the registry",
    );
    expect(r.summary).not.toContain("npm stage list @quickchatai/pi-quickreview");
    // every view asks for the exact version, never the bare name
    for (const c of r.calls.filter((c) => c[0] === "view")) expect(c[1]).toMatch(/@1\.2\.3$/);

    const both = scratch();
    packages(both, "1.2.3", "1.2.3", "1.2.3");
    onRegistry(both, "@quickchatai/pi-quickreview@1.2.3", "1.2.3");
    onRegistry(both, "@quickchatai/quickreview@1.2.3", "1.2.3");
    const again = runStage(both, "1.2.3", { PUBLIC: "true" });
    expect(again.status, again.log).toBe(0);
    expect(stages(again.calls)).toEqual([]);
    expect(again.summary).not.toContain("npm stage approve");
  });

  // MUTATION: let a refused stage `exit 1` on the spot — the app is never
  // attempted and this fails; drop the final `exit "$failed"` — the step
  // passes and this fails.
  it("a refused plugin stage still attempts the app, then fails the step naming the publisher and the hand route", () => {
    const dir = scratch();
    packages(dir, "1.2.3", "1.2.3", "1.2.3");
    const t = tarballs(dir, "1.2.3");
    const r = runStage(dir, "1.2.3", {
      PUBLIC: "true",
      FAKE_STAGE_FAIL: "pi-quickreview",
    });
    expect(r.status).toBe(1);
    expect(stages(r.calls).map((c) => c.slice(0, 3))).toEqual([
      ["stage", "publish", t.PLUGIN_TGZ],
      ["stage", "publish", t.APP_TGZ],
    ]);
    expect(r.summary).toContain("`@quickchatai/pi-quickreview@1.2.3`: failed to stage");
    expect(r.summary).toContain("`.github/npm-trust.sh --apply` sets it");
    expect(r.summary).toContain(
      "`npm publish quickchatai-pi-quickreview-1.2.3.tgz --access public`",
    );
    expect(r.summary).toContain("npm-tarballs-1.2.3");
    expect(r.summary).toContain("`@quickchatai/quickreview@1.2.3`: staged under dist-tag latest");
    expect(r.log).toContain("::error::npm stage publish refused @quickchatai/pi-quickreview@1.2.3");
  });

  it("cleans up", () => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });
});

// .github/npm-trust.sh sets the trusted publishers the `npm` job logs in by.
// It runs against a fake npm and a fake gh on the PATH, which log their
// arguments; `npm trust github <package>` fails for a package named in
// FAKE_TRUST_FAIL, and the fake gh lists FAKE_SECRETS as the environment's.
describe("npm-trust.sh — the trusted publishers", () => {
  const script = join(root, ".github", "npm-trust.sh");
  const body = readFileSync(script, "utf8");
  const dirs: string[] = [];
  const PLUGIN = "@quickchatai/pi-quickreview";
  const APP = "@quickchatai/quickreview";
  const trustArgs = (pkg: string): string[] => [
    "trust",
    "github",
    pkg,
    "--file",
    "release.yml",
    "--repository",
    "quickchatai/quickreview",
    "--environment",
    "npm-publish",
    "--allow-stage-publish",
    "--yes",
  ];

  function run(args: string[], env: Record<string, string> = {}) {
    const dir = mkdtempSync(join(tmpdir(), "npm-trust-"));
    dirs.push(dir);
    const bin = join(dir, "bin");
    mkdirSync(bin);
    const log = join(dir, "calls.log");
    writeFileSync(log, "");
    const fake = (name: string, rest: string): void => {
      writeFileSync(
        join(bin, name),
        `#!/usr/bin/env node
const fs = require("node:fs");
const a = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify(["${name}", ...a]) + "\\n");
${rest}
`,
      );
      chmodSync(join(bin, name), 0o755);
    };
    fake(
      "npm",
      `if (a[0] === "--version") { console.log("11.20.0"); process.exit(0); }
if (a[0] === "trust" && a.includes("--help")) {
  if (process.env.FAKE_NO_STAGE_TRUST) console.log("--allow-publish");
  else console.log("--allow-publish\\n--allow-stage-publish");
  process.exit(0);
}
if (a[0] === "trust" && a[1] === "github") {
  process.exit((process.env.FAKE_TRUST_FAIL || "").split(",").includes(a[2]) ? 1 : 0);
}
process.exit(2);`,
    );
    fake(
      "gh",
      `if (a[0] === "secret" && a[1] === "list") {
  for (const s of (process.env.FAKE_SECRETS || "").split(",").filter(Boolean)) console.log(s);
  process.exit(0);
}
if (a[0] === "secret" && a[1] === "delete") process.exit(0);
process.exit(2);`,
    );
    const r = spawnSync("bash", [script, ...args], {
      env: { PATH: `${bin}:${process.env.PATH!}`, FAKE_LOG: log, ...env },
      encoding: "utf8",
    });
    const calls = readFileSync(log, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as string[])
      .filter((c) => !c.includes("--help"));
    return { status: r.status, calls, out: r.stdout, err: r.stderr };
  }

  // MUTATION: name another workflow or environment in the script — this fails.
  it("names the workflow, the environment and the repository the npm job runs in", () => {
    expect(body).toMatch(/^WORKFLOW=release\.yml$/m);
    expect(body).toMatch(new RegExp(`^ENVIRONMENT=${wf.jobs.npm!.environment!}$`, "m"));
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      repository: { url: string };
    };
    const repo = /^REPO=(.+)$/m.exec(body)![1]!;
    expect(pkg.repository.url).toBe(`git+https://github.com/${repo}.git`);
  });

  it("a dry run prints both publishers, the plugin first, stage-only, and calls nothing", () => {
    const r = run([]);
    expect(r.status, r.err).toBe(0);
    expect(r.calls).toEqual([]);
    const lines = r.out.split("\n");
    expect(lines[0]).toBe(["npm", ...trustArgs(PLUGIN)].join(" "));
    expect(lines[1]).toBe(["npm", ...trustArgs(APP)].join(" "));
    expect(r.out).not.toContain("--allow-publish");
  });

  // MUTATION: add --allow-publish to the trust call — a publisher that can
  // publish without a maintainer's approval, and this fails.
  it("--apply sets both stage-only publishers, the plugin first, then deletes NPM_TOKEN", () => {
    const r = run(["--apply"], { FAKE_SECRETS: "NPM_TOKEN" });
    expect(r.status, r.err).toBe(0);
    expect(r.calls).toEqual([
      ["npm", ...trustArgs(PLUGIN)],
      ["npm", ...trustArgs(APP)],
      [
        "gh",
        "secret",
        "list",
        "--repo",
        "quickchatai/quickreview",
        "--env",
        "npm-publish",
        "--json",
        "name",
        "--jq",
        ".[].name",
      ],
      [
        "gh",
        "secret",
        "delete",
        "NPM_TOKEN",
        "--repo",
        "quickchatai/quickreview",
        "--env",
        "npm-publish",
      ],
    ]);
  });

  it("--apply deletes nothing when no NPM_TOKEN is left", () => {
    const r = run(["--apply"], { FAKE_SECRETS: "OTHER" });
    expect(r.status, r.err).toBe(0);
    expect(r.calls.filter((c) => c[0] === "gh" && c[2] === "delete")).toEqual([]);
  });

  // MUTATION: drop the `failed` check before the secret delete — this fails.
  it("a refused publisher still tries the other, keeps NPM_TOKEN and fails", () => {
    const r = run(["--apply"], { FAKE_SECRETS: "NPM_TOKEN", FAKE_TRUST_FAIL: PLUGIN });
    expect(r.status).toBe(1);
    expect(r.calls.filter((c) => c[0] === "npm")).toEqual([
      ["npm", ...trustArgs(PLUGIN)],
      ["npm", ...trustArgs(APP)],
    ]);
    expect(r.calls.filter((c) => c[0] === "gh")).toEqual([]);
    expect(r.err).toContain("NPM_TOKEN is kept");
  });

  it("refuses an npm that cannot set a stage-only publisher", () => {
    const r = run(["--apply"], { FAKE_NO_STAGE_TRUST: "1" });
    expect(r.status).toBe(1);
    expect(r.calls.filter((c) => c[0] === "npm" && c[1] === "trust")).toEqual([]);
  });

  it("cleans up", () => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });
});
