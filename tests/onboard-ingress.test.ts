// the wizard's ingress step: four shapes offered with their real
// trade-offs, each configuring [ingress] (and the compose profile) correctly,
// resumable, and verified against the RUNNING shape rather than the record.
//
// Everything faked: temp dirs for the sandbox root, secrets dir and checklist;
// a fake ProcessRunner standing in for `docker compose ps` / `exec`. No
// docker, no network, no tunnel.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { toolDefinitions } from "../extensions/onboarding.js";
import {
  OnboardingEngine,
  readChecklist,
  type OnboardAdapters,
  type ProcessResult,
} from "../src/onboard/engine.js";
import { defaultSteps } from "../src/onboard/steps/index.js";
import {
  INGRESS_CHOICE_KEY,
  INGRESS_HOSTNAME_KEY,
  INGRESS_OPTIONS,
  INGRESS_STEP_ID,
  ingressStep,
  normalizeHostname,
  parseComposePs,
  patchTomlSection,
  readEnvKey,
  readTomlKey,
  sandboxRootOf,
  setEnvKey,
  setTomlKey,
} from "../src/onboard/steps/ingress.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const exampleConfig = readFileSync(join(repoRoot, "config.example.toml"), "utf8");

let root: string;
let secretsDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "qcr-ingress-"));
  secretsDir = join(root, "secrets");
  mkdirSync(secretsDir, { recursive: true });
  mkdirSync(join(root, "state"), { recursive: true });
  // A realistic config.toml: the shipped example with the secrets dir pointed
  // at this test's temp dir (so no check can ever read the real one).
  writeFileSync(
    join(root, "config.toml"),
    setTomlKey(exampleConfig, "github", "secrets_dir", secretsDir)!,
  );
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

interface Fake {
  engine: OnboardingEngine;
  calls: string[][];
}

function adapters(
  runner?: (cmd: string, args: string[]) => ProcessResult,
  calls: string[][] = [],
): OnboardAdapters {
  return {
    fetch: (() => {
      throw new Error("no network in tests");
    }) as unknown as typeof fetch,
    runner: {
      run: async (cmd, args) => {
        calls.push([cmd, ...args]);
        return runner ? runner(cmd, args) : { code: 1, stdout: "", stderr: "no docker in tests" };
      },
    },
    clock: () => new Date("2026-08-30T12:00:00Z"),
    host: { nodeVersion: "v22.5.1", uid: 1000 },
    paths: { stateDir: join(root, "state"), configPath: join(root, "config.toml") },
  };
}

function fake(runner?: (cmd: string, args: string[]) => ProcessResult): Fake {
  const calls: string[][] = [];
  return { engine: new OnboardingEngine([ingressStep()], adapters(runner, calls)), calls };
}

const configText = (): string => readFileSync(join(root, "config.toml"), "utf8");
const envText = (): string => readFileSync(join(root, ".env"), "utf8");

// ---- file surgery -----------------------------------------------------------

describe("deterministic file surgery", () => {
  it("patchTomlSection inserts [ingress] before [daemon] and leaves the commented template alone", () => {
    const patched = patchTomlSection(
      exampleConfig,
      "ingress",
      '[ingress]\nshape = "tunnel-file"\n',
    );
    expect(readTomlKey(patched, "ingress", "shape")).toBe("tunnel-file");
    expect(patched.indexOf("[ingress]\nshape")).toBeLessThan(patched.indexOf("[daemon]"));
    // The documentation block (#[ingress] …) is untouched, and so is everything else.
    expect(patched).toContain("#[ingress]");
    expect(patched).toContain('#shape = "tunnel-file"');
    expect(readTomlKey(patched, "daemon", "poll_interval_s")).toBe("300");
  });

  it("patchTomlSection REPLACES an existing section, keeping the rest byte-identical", () => {
    const once = patchTomlSection(exampleConfig, "ingress", '[ingress]\nshape = "tunnel-file"\n');
    const twice = patchTomlSection(once, "ingress", '[ingress]\nshape = "none"\n');
    expect(readTomlKey(twice, "ingress", "shape")).toBe("none");
    expect(twice.match(/^\[ingress\]/gm)).toHaveLength(1);
    expect(twice.length).toBeLessThan(once.length + 10);
    expect(readTomlKey(twice, "github", "trigger_label")).toBe("AI review requested");
  });

  it("setTomlKey rewrites one key in one table, and refuses a table that is not there", () => {
    const patched = setTomlKey(exampleConfig, "server", "hostname", "review.example.com")!;
    expect(readTomlKey(patched, "server", "hostname")).toBe("review.example.com");
    expect(readTomlKey(patched, "server", "port")).toBe("8787");
    expect(setTomlKey(exampleConfig, "no_such_table", "k", "v")).toBeNull();
  });

  it("setTomlKey patches an indented key in place, never a duplicate the loader rejects", async () => {
    const { parse } = await import("smol-toml");
    const text = `  [server]\n  hostname = "old"\n  port = 8787\n[github]\nhostname = "other"\n`;
    const patched = setTomlKey(text, "server", "hostname", "new");
    expect(patched).toBe(`  [server]\n  hostname = "new"\n  port = 8787\n[github]\nhostname = "other"\n`);
    const loaded = parse(patched!) as { server: { hostname: string }; github: { hostname: string } };
    expect(loaded.server.hostname).toBe("new");
    expect(loaded.github.hostname).toBe("other");
    // The table boundary is found through indentation too.
    const nested = setTomlKey(`[server]\nport = 1\n  [github]\n  hostname = "g"\n`, "server", "hostname", "h");
    expect(parse(nested!)).toEqual({ server: { hostname: "h", port: 1 }, github: { hostname: "g" } });
  });

  it("readTomlKey reads a string value the way the loader (smol-toml) does", async () => {
    const { parse } = await import("smol-toml");
    const cases = [
      `[github]\nsecrets_dir = '/srv/secrets#prod'\n`,
      `[github]\nsecrets_dir = "/srv/secrets#prod" # the prod keys\n`,
      `[github]\nsecrets_dir = "/srv/a\\\\b\\u0041\\"q"\n`,
      `[github]\nsecrets_dir = '/srv/x' # 'quoted' comment\n`,
      `[github]\nsecrets_dir = "/srv/plain"\n`,
    ];
    for (const text of cases) {
      const loader = (parse(text) as { github: { secrets_dir: string } }).github.secrets_dir;
      expect([text, readTomlKey(text, "github", "secrets_dir")]).toEqual([text, loader]);
    }
    // Bare scalars still read as their text, a trailing comment stripped.
    expect(readTomlKey("[server]\nport = 8787 # the port\n", "server", "port")).toBe("8787");
  });

  it("setEnvKey adds then replaces; readEnvKey reads back, empty included", () => {
    const first = setEnvKey("", "COMPOSE_PROFILES", "quick-tunnel");
    expect(first).toBe("COMPOSE_PROFILES=quick-tunnel\n");
    const second = setEnvKey(`QCR_UID=1000\n${first}`, "COMPOSE_PROFILES", "");
    expect(readEnvKey(second, "COMPOSE_PROFILES")).toBe("");
    expect(readEnvKey(second, "QCR_UID")).toBe("1000");
    expect(readEnvKey(second, "NOPE")).toBeNull();
  });

  it("normalizeHostname strips what an operator typically pastes", () => {
    expect(normalizeHostname("https://Review.Example.com/webhook")).toBe("review.example.com");
    expect(normalizeHostname("review.example.com:443")).toBe("review.example.com");
    expect(normalizeHostname("localhost")).toBeNull();
    expect(normalizeHostname("")).toBeNull();
  });

  it("parseComposePs reads both compose output shapes and shrugs at garbage", () => {
    expect(parseComposePs('[{"Service":"daemon","State":"running"}]')).toEqual([
      { service: "daemon", state: "running" },
    ]);
    expect(
      parseComposePs(
        '{"Service":"daemon","State":"running"}\n{"Service":"tunnel-quick","State":"exited"}',
      ),
    ).toEqual([
      { service: "daemon", state: "running" },
      { service: "tunnel-quick", state: "exited" },
    ]);
    expect(parseComposePs("")).toEqual([]);
    expect(parseComposePs("not json at all")).toEqual([]);
  });

  it("sandboxRootOf derives the repo root from the engine's stateDir contract", () => {
    expect(sandboxRootOf(adapters())).toBe(root);
  });
});

// ---- the offer --------------------------------------------------------------

describe("the offer", () => {
  it("called with no choice, it lists all four shapes with honest trade-offs and stays pending", async () => {
    const f = fake();
    const result = await f.engine.runStep(INGRESS_STEP_ID);
    expect(result.ok).toBe(false);
    const text = result.failures.join("\n");
    for (const id of ["quick", "ngrok", "named", "polling"]) expect(text).toContain(`${id}:`);
    // The bad news is in the offer, not only the good.
    expect(text).toMatch(/ROTATES/);
    expect(text).toMatch(/no SLA/);
    expect(text).toMatch(/free tier caps/i);
    expect(text).toMatch(/reconcile poll becomes the ONLY trigger path/);
    expect(text).toMatch(/author replies do not route/);
    expect(readChecklist(join(root, "state"))?.steps[INGRESS_STEP_ID]?.status).toBe("pending");
    // Nothing was written on an offer.
    expect(readdirSync(root)).not.toContain(".env");
    expect(readTomlKey(configText(), "ingress", "shape")).toBeNull();
  });

  it("every option states what it costs, not only what it gives", () => {
    expect(INGRESS_OPTIONS.map((o) => o.id)).toEqual(["quick", "ngrok", "named", "polling"]);
    for (const option of INGRESS_OPTIONS) expect(option.tradeoffs.length).toBeGreaterThanOrEqual(3);
  });
});

// ---- the four choices -------------------------------------------------------

describe("choosing a shape", () => {
  it("quick: tunnel-file self-heal on, quick-tunnel profile, no credential needed", async () => {
    const f = fake();
    const result = await f.engine.runStep(INGRESS_STEP_ID, { choice: "quick" });
    expect(result.ok).toBe(true);
    expect(readTomlKey(configText(), "ingress", "shape")).toBe("tunnel-file");
    expect(readTomlKey(configText(), "ingress", "hostname_file")).toBe("");
    expect(readEnvKey(envText(), "COMPOSE_PROFILES")).toBe("quick-tunnel");
    expect(f.engine.choices()[INGRESS_CHOICE_KEY]).toBe("quick");
    expect(result.checks.some((c) => c.name === "credential")).toBe(false);
  });

  it("ngrok: same self-heal, its own profile, and a REFUSAL until the authtoken file exists", async () => {
    const f = fake();
    const red = await f.engine.runStep(INGRESS_STEP_ID, { choice: "ngrok" });
    expect(red.ok).toBe(false);
    expect(red.failures.join(" ")).toContain(join(secretsDir, "ngrok_authtoken"));
    expect(red.failures.join(" ")).toMatch(/umask 077/);

    writeFileSync(join(secretsDir, "ngrok_authtoken"), "2abc_token\n");
    const green = await f.engine.runStep(INGRESS_STEP_ID, {
      choice: "ngrok",
      hostname: "reviews.example.com",
    });
    expect(green.ok).toBe(true);
    expect(readTomlKey(configText(), "ingress", "shape")).toBe("tunnel-file");
    expect(readEnvKey(envText(), "COMPOSE_PROFILES")).toBe("ngrok");
    expect(readTomlKey(configText(), "server", "hostname")).toBe("reviews.example.com");
    // The token itself never lands in config or .env.
    expect(configText()).not.toContain("2abc_token");
    expect(envText()).not.toContain("2abc_token");
  });

  it("named: no self-heal, the operator's hostname written, connector token required", async () => {
    const f = fake();
    const noHost = await f.engine.runStep(INGRESS_STEP_ID, { choice: "named" });
    expect(noHost.ok).toBe(false);
    expect(noHost.failures.join(" ")).toMatch(/needs the public hostname/);

    writeFileSync(join(secretsDir, "tunnel_token"), "connector-token\n");
    const green = await f.engine.runStep(INGRESS_STEP_ID, {
      choice: "named",
      hostname: "https://review.example.com/",
    });
    expect(green.ok).toBe(true);
    expect(readTomlKey(configText(), "ingress", "shape")).toBe("none");
    expect(readTomlKey(configText(), "server", "hostname")).toBe("review.example.com");
    expect(readEnvKey(envText(), "COMPOSE_PROFILES")).toBe("named-tunnel");
    expect(f.engine.choices()[INGRESS_HOSTNAME_KEY]).toBe("review.example.com");
  });

  it("polling: no sidecar, no self-heal — and the cost is spelled out in the result", async () => {
    const f = fake();
    const result = await f.engine.runStep(INGRESS_STEP_ID, { choice: "polling" });
    expect(result.ok).toBe(true);
    expect(readTomlKey(configText(), "ingress", "shape")).toBe("none");
    expect(readEnvKey(envText(), "COMPOSE_PROFILES")).toBe("");
    const tradeoffs = result.checks.find((c) => c.name === "trade-offs")?.detail ?? "";
    expect(tradeoffs).toMatch(/poll_interval_s/);
    expect(tradeoffs).toMatch(/author replies do not route/);
    expect(tradeoffs).toMatch(/\[feedback\] tuning loop never sees a comment/);
    expect(tradeoffs).toMatch(/re-run this step later/);
  });

  it("switching shape later rewrites both files cleanly — polling is never a dead end", async () => {
    const f = fake();
    await f.engine.runStep(INGRESS_STEP_ID, { choice: "polling" });
    await f.engine.runStep(INGRESS_STEP_ID, { choice: "quick" });
    expect(configText().match(/^\[ingress\]/gm)).toHaveLength(1);
    expect(envText().match(/^COMPOSE_PROFILES=/gm)).toHaveLength(1);
    expect(readTomlKey(configText(), "ingress", "shape")).toBe("tunnel-file");
    expect(readEnvKey(envText(), "COMPOSE_PROFILES")).toBe("quick-tunnel");
  });

  it("an unknown choice re-offers rather than guessing", async () => {
    const f = fake();
    const result = await f.engine.runStep(INGRESS_STEP_ID, { choice: "wireguard" });
    expect(result.ok).toBe(false);
    expect(result.failures.join(" ")).toMatch(/pick one of quick \| ngrok \| named \| polling/);
  });

  it("a missing config.toml is a plain instruction, not a crash", async () => {
    rmSync(join(root, "config.toml"));
    const result = await fake().engine.runStep(INGRESS_STEP_ID, { choice: "quick" });
    expect(result.ok).toBe(false);
    expect(result.failures.join(" ")).toMatch(/cp config\.example\.toml config\.toml/);
  });
});

// ---- resume + verify --------------------------------------------------------

const psJson = (rows: Array<[string, string]>): string =>
  JSON.stringify(rows.map(([Service, State]) => ({ Service, State })));

/** A fake docker: `compose ps` returns the given services, `compose exec … cat`
 * returns the published hostname (or fails when there is none). */
function fakeDocker(rows: Array<[string, string]>, hostname: string | null) {
  return (cmd: string, args: string[]): ProcessResult => {
    if (cmd !== "docker") return { code: 127, stdout: "", stderr: "not found" };
    if (args.includes("ps")) return { code: 0, stdout: psJson(rows), stderr: "" };
    if (args.includes("cat")) {
      return hostname === null
        ? { code: 1, stdout: "", stderr: "No such file or directory" }
        : { code: 0, stdout: `${hostname}\n`, stderr: "" };
    }
    return { code: 1, stdout: "", stderr: "unexpected docker args" };
  };
}

describe("resume and verify", () => {
  it("a fresh engine over the same state re-verifies the recorded choice against the files", async () => {
    await fake().engine.runStep(INGRESS_STEP_ID, { choice: "quick" });
    const resumed = fake();
    const report = await resumed.engine.reconcile();
    expect(report.verified).toEqual([INGRESS_STEP_ID]);
    expect(report.demoted).toEqual([]);
  });

  it("config edited behind the wizard's back DEMOTES the step — the record is never trusted", async () => {
    await fake().engine.runStep(INGRESS_STEP_ID, { choice: "quick" });
    writeFileSync(
      join(root, "config.toml"),
      patchTomlSection(configText(), "ingress", '[ingress]\nshape = "none"\n'),
    );
    const report = await fake().engine.reconcile();
    expect(report.demoted[0]?.id).toBe(INGRESS_STEP_ID);
    expect(report.demoted[0]?.failures.join(" ")).toMatch(
      /\[ingress\] shape is "none" but the quick shape needs "tunnel-file"/,
    );
  });

  it("a compose profile edited away demotes it too", async () => {
    await fake().engine.runStep(INGRESS_STEP_ID, { choice: "quick" });
    writeFileSync(join(root, ".env"), "COMPOSE_PROFILES=\n");
    const report = await fake().engine.reconcile();
    expect(report.demoted[0]?.failures.join(" ")).toMatch(/COMPOSE_PROFILES=""/);
  });

  it("the credential vanishing after the fact is caught on re-verification", async () => {
    writeFileSync(join(secretsDir, "ngrok_authtoken"), "2abc_token\n");
    await fake().engine.runStep(INGRESS_STEP_ID, { choice: "ngrok" });
    rmSync(join(secretsDir, "ngrok_authtoken"));
    const report = await fake().engine.reconcile();
    expect(report.demoted[0]?.failures.join(" ")).toMatch(/ngrok_authtoken is missing or empty/);
  });

  it("with the stack down, verify checks configuration only — bring-up is a later step", async () => {
    const f = fake(fakeDocker([], null));
    await f.engine.runStep(INGRESS_STEP_ID, { choice: "quick" });
    const all = await f.engine.verifyAll();
    expect(all.ok).toBe(true);
  });

  it("docker missing entirely is a note, never a false failure", async () => {
    const f = fake(() => ({ code: 127, stdout: "", stderr: "docker: not found" }));
    await f.engine.runStep(INGRESS_STEP_ID, { choice: "quick" });
    expect((await f.engine.verifyAll()).ok).toBe(true);
  });

  it("verify reads the RUNNING shape: daemon up, sidecar up, hostname published", async () => {
    const f = fake(
      fakeDocker(
        [
          ["daemon", "running"],
          ["tunnel-quick", "running"],
        ],
        "odd-shape.trycloudflare.com",
      ),
    );
    await f.engine.runStep(INGRESS_STEP_ID, { choice: "quick" });
    const all = await f.engine.verifyAll();
    expect(all.ok).toBe(true);
    // It really asked docker, and it read the hostname back through the
    // DAEMON's own path — the file contract, proven where it is consumed.
    const cat = f.calls.find((c) => c.includes("cat"));
    expect(cat).toContain("/opt/quickreview/state/ingress/hostname");
    expect(cat).toContain("daemon");
  });

  it("daemon up but the chosen sidecar is not running ⇒ red, with the fix", async () => {
    const f = fake(
      fakeDocker(
        [
          ["daemon", "running"],
          ["tunnel-quick", "exited"],
        ],
        null,
      ),
    );
    await f.engine.runStep(INGRESS_STEP_ID, { choice: "quick" });
    const all = await f.engine.verifyAll();
    expect(all.ok).toBe(false);
    expect(all.results[0]?.failures.join(" ")).toMatch(/tunnel-quick is exited/);
  });

  it("a running sidecar that has published nothing ⇒ red, pointing at its logs", async () => {
    const f = fake(
      fakeDocker(
        [
          ["daemon", "running"],
          ["tunnel-quick", "running"],
        ],
        null,
      ),
    );
    await f.engine.runStep(INGRESS_STEP_ID, { choice: "quick" });
    const all = await f.engine.verifyAll();
    expect(all.ok).toBe(false);
    expect(all.results[0]?.failures.join(" ")).toMatch(/no hostname published yet/);
    expect(all.results[0]?.failures.join(" ")).toMatch(/docker compose logs tunnel-quick/);
  });

  it("polling with a sidecar still running ⇒ red (the shape on the machine is not the shape chosen)", async () => {
    const f = fake(
      fakeDocker(
        [
          ["daemon", "running"],
          ["tunnel-quick", "running"],
        ],
        "abc.trycloudflare.com",
      ),
    );
    await f.engine.runStep(INGRESS_STEP_ID, { choice: "polling" });
    const all = await f.engine.verifyAll();
    expect(all.ok).toBe(false);
    expect(all.results[0]?.failures.join(" ")).toMatch(/tunnel-quick still running/);
  });

  it("polling with nothing but the daemon up is green", async () => {
    const f = fake(fakeDocker([["daemon", "running"]], null));
    await f.engine.runStep(INGRESS_STEP_ID, { choice: "polling" });
    expect((await f.engine.verifyAll()).ok).toBe(true);
  });

  it("on the VM topology the compose profile is irrelevant and never inspected", async () => {
    const f = fake(fakeDocker([], null));
    await f.engine.runStep(INGRESS_STEP_ID, { choice: "named", hostname: "review.example.com" });
    writeFileSync(join(secretsDir, "tunnel_token"), "connector-token\n");
    // Re-run so the credential check is green, then flip the topology.
    await f.engine.runStep(INGRESS_STEP_ID, { choice: "named", hostname: "review.example.com" });
    (
      f.engine as unknown as { checklist: { choices: Record<string, unknown> } }
    ).checklist.choices.topology = "vm";
    const all = await f.engine.verifyAll();
    expect(all.ok).toBe(true);
    expect(f.calls.some((c) => c.includes("ps"))).toBe(false);
  });

  it("verify with nothing recorded refuses instead of inventing a shape", async () => {
    const report = await fake().engine.verifyAll();
    expect(report.ok).toBe(false);
    expect(report.results[0]?.failures.join(" ")).toMatch(/no ingress shape recorded/);
  });
});

// ---- registration -----------------------------------------------------------

describe("registration", () => {
  it("the step is in the default registry, after preflight, with a tool-name-safe id", () => {
    const steps = defaultSteps();
    const ingress = steps.find((s) => s.id === INGRESS_STEP_ID);
    expect(ingress).toBeDefined();
    expect(INGRESS_STEP_ID).toMatch(/^[a-z][a-z0-9_]*$/);
    expect(ingress!.order).toBeGreaterThan(steps.find((s) => s.id === "preflight")!.order);
    // It declares its own parameters — the operator's answer is an input, not
    // a guess (the tool belt passes them straight through).
    const params = ingress!.parameters as { properties: { choice: { enum: string[] } } };
    expect(params.properties.choice.enum).toEqual(["quick", "ngrok", "named", "polling"]);
  });

  it("the pi tool belt declares those parameters and hands the operator's answer to the step", async () => {
    const engine = new OnboardingEngine([ingressStep()], adapters());
    const def = toolDefinitions(engine, () => {}).find((d) => d.name === "onboard_ingress");
    expect(def).toBeDefined();
    expect(
      (def!.parameters as { properties: Record<string, unknown> }).properties.choice,
    ).toBeDefined();

    const offered = await def!.execute("call-1", {});
    expect(offered.content.map((c) => c.text).join("\n")).toMatch(/pick one of/);

    const answered = await def!.execute("call-2", { choice: "polling" });
    expect(answered.content.map((c) => c.text).join("\n")).toMatch(/completed and recorded/);
    expect(readTomlKey(configText(), "ingress", "shape")).toBe("none");
  });
});
