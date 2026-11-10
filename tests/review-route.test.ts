// `qcr review` on the model route (src/reviewcli.ts `routeRun`,
// packages/pi-plugin/src/reviewapi.ts): the review runs on what pi has a
// credential for. What the preview says and carries about the model, the one
// question a terminal is asked and what is remembered of it, the refusals a
// start gets, what `--model` replaces, the models in the preview key, and the
// host: the one the route was resolved on runs the round.
//
// Every route here is resolved by the real pi over a temp pi home, on
// credentials the case gives: a provider of the home's own `models.json`, a
// built-in provider keyed through the case's environment, or pi-ai's faux
// provider, which also answers the rounds that run. Nothing is sent anywhere,
// and the developer's own logins and keys never count.
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { builtinProviders, getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
// Loaded here so the route's own lazy imports are not on a test's clock.
import "@quickchatai/pi-quickreview/src/engine/pisdk.js";
import { contextFrom } from "@quickchatai/pi-quickreview/src/engine/context.js";
import type { PiHostOptions } from "@quickchatai/pi-quickreview/src/engine/pisdk.js";
import type { Runtime, SessionSpec } from "@quickchatai/pi-quickreview/src/engine/port.js";
import { reviewSdkRuntime } from "@quickchatai/pi-quickreview/src/engine/reviewsdk.js";
import { reviewKey, runModels, specAsRun } from "@quickchatai/pi-quickreview/src/localreview.js";
import { MODEL_CHOICE_FILE } from "@quickchatai/pi-quickreview/src/modelchoice.js";
import type { ModelRoute, ProviderInventory } from "@quickchatai/pi-quickreview/src/modelroute.js";
import { parseCoreConfig, type CoreConfig } from "@quickchatai/pi-quickreview/src/reviewconfig.js";
import { FAKE_ROUTE_MODEL, writeFakeProvider } from "./helpers/fake-openai.js";
import { freshStateHomePerTest } from "./helpers/fresh-state-home.js";
import { pricedFaux, ROUTABLE_FAUX_MODEL } from "./helpers/priced-faux.js";
import { useOfflineGuard } from "./pi-canary/harness.js";

vi.stubEnv(
  "QCR_CONFIG",
  resolve(dirname(fileURLToPath(import.meta.url)), "fixtures", "config.toml"),
);

const { parseReviewArgs, providerRows, reviewHelp, runReviewCli } =
  await import("../src/reviewcli.js");
type ReviewCliDeps = import("../src/reviewcli.js").ReviewCliDeps;
type ReviewRunHost = import("../src/reviewcli.js").ReviewRunHost;

useOfflineGuard();
freshStateHomePerTest();

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tmp = mkdtempSync(join(tmpdir(), "review-route-"));
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

/** A built-in provider no case has a credential for unless it gives one. */
const BUILTIN = "deepseek";
const BUILTIN_ENV = "DEEPSEEK_API_KEY";
const BUILTIN_MODEL = getBuiltinModels(BUILTIN)[0]!.id;
const BUILTIN_NAME = builtinProviders().find((p) => p.id === BUILTIN)!.name;
/** What a case puts in the environment as a key: not a credential's shape. */
const KEY_VALUE = "key-value-that-must-never-be-said";
/** Never listened on: no case sends a request. */
const NOWHERE = "http://127.0.0.1:9/v1";
const FAUX_ID = ROUTABLE_FAUX_MODEL.id;

const git = (cwd: string, ...args: string[]): string =>
  execFileSync(
    "git",
    ["-c", "user.name=T", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args],
    { cwd, encoding: "utf8" },
  ).trim();

let made = 0;
/** main with one file, `feature` adding two lines to it; the limit is high, so
 * no case is asked about the price unless it lowers it. */
function mkRepo(limit = 1000): string {
  const repo = join(tmp, `repo-${++made}`);
  mkdirSync(join(repo, "src"), { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "src", "a.ts"), "export const a = 1;\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "base");
  git(repo, "checkout", "-q", "-b", "feature");
  writeFileSync(join(repo, "src", "a.ts"), "export const a = 1;\nexport const b = 2;\n");
  git(repo, "commit", "-q", "-am", "add b");
  writeFileSync(join(repo, ".git", "qcr-review.json"), JSON.stringify({ auto_limit_usd: limit }));
  return repo;
}

/** A pi home of the case's own; `local` gives it the provider of its
 * `models.json` (a model a route can land on, and one it cannot). */
function mkHome(o: { local?: boolean } = {}): string {
  const home = join(tmp, `pi-home-${++made}`);
  mkdirSync(home, { recursive: true });
  if (o.local) writeFakeProvider(home, NOWHERE, { routable: true });
  return home;
}

// The asset tree, without the checkout's git dir and state.
const root = join(tmp, "root");
mkdirSync(root);
for (const e of readdirSync(ROOT))
  if (!["wt", ".git", "state"].includes(e)) symlinkSync(join(ROOT, e), join(root, e));

// The shipped config: it names no model, so every tier runs on the route.
const toml = readFileSync(join(ROOT, "config.example.toml"), "utf8");
const parsed = parseCoreConfig(toml);
const ctx = contextFrom(root, { cfg: parsed, toml }, parsed.review.profile, "", {});
const UNPINNED: CoreConfig = ctx.cfg;
/** A config that pins the review, two tiers and a lens to models of `local`. */
const PINNED: CoreConfig = {
  ...UNPINNED,
  models: {
    ...UNPINNED.models,
    model: `${FAKE_ROUTE_MODEL}:low`,
    tiers: { light: "local/m:low", standard: ":medium", deep: `${FAKE_ROUTE_MODEL}:high` },
    pass_models: { "pass-style": "local/m" },
  },
};

const record = JSON.stringify({
  findings: [
    {
      path: "src/a.ts",
      line: 2,
      severity: "P2",
      title: "b is a magic number",
      disposition: "posted",
    },
  ],
  verdict: "COMMENT",
});
const outcome = JSON.stringify({ verdict: "COMMENT", passes: [] });

/** A faux provider under `id` whose model a route can land on. `answers`
 * counts the turns it was asked for; each one finishes the round it is in. */
function fauxProvider(id: string, runsDir: () => string) {
  const faux = pricedFaux(() => 0.01, { provider: id, routable: true });
  const state = { answers: 0 };
  faux.appendResponses(
    Array.from({ length: 4 }, () => async () => {
      state.answers++;
      for (const d of readdirSync(runsDir()))
        for (const e of readdirSync(join(runsDir(), d), { recursive: true }))
          if (String(e).endsWith("round-order.md")) {
            const out = dirname(join(runsDir(), d, String(e)));
            writeFileSync(join(out, "findings-record.json"), record);
            writeFileSync(join(out, "outcome.json"), outcome);
          }
      return fauxAssistantMessage("done");
    }),
  );
  return { faux, state };
}

interface Harness {
  deps: ReviewCliDeps;
  lines: string[];
  /** What the verb said beside its output (stderr). */
  said: string[];
  /** What each runtime was handed of the model side. */
  hosts: ReviewRunHost[];
  /** The session specs the runtime was asked to create. */
  specs: SessionSpec[];
  /** How many hosts were built (each configures its model runtime once). */
  built: () => number;
  /** The providers of the faux family, by id. */
  faux: Record<string, ReturnType<typeof fauxProvider>>;
  tmpDir: string;
  text: () => string;
  json: () => Record<string, unknown>;
}

function harness(o: {
  repo?: string;
  home?: string;
  env?: Record<string, string>;
  /** Faux providers to register on every host, by id. */
  faux?: readonly string[];
  cfg?: CoreConfig;
  choose?: NonNullable<ReviewCliDeps["models"]>["choose"];
  confirm?: ReviewCliDeps["confirm"];
  now?: () => number;
  /** A runtime in place of the SDK one: it only records what it is asked. */
  recordOnly?: boolean;
}): Harness {
  const n = ++made;
  const lines: string[] = [];
  const said: string[] = [];
  const hosts: ReviewRunHost[] = [];
  const specs: SessionSpec[] = [];
  const runsDir = join(tmp, `runs-${n}`);
  const tmpDir = join(tmp, `state-tmp-${n}`);
  const faux = Object.fromEntries(
    (o.faux ?? []).map((id) => [id, fauxProvider(id, () => runsDir)]),
  );
  let built = 0;
  const configureModels: PiHostOptions["configureModels"] = (runtime) => {
    built++;
    for (const f of Object.values(faux)) runtime.registerNativeProvider(f.faux.provider);
  };
  const runtime = (host: ReviewRunHost): Runtime => {
    hosts.push(host);
    const inner = reviewSdkRuntime({
      lens: () => ({ factories: [], toolNames: [] }),
      ownsProcess: false,
      homeDir: join(tmp, "no-home"),
      ...host,
    });
    return {
      create: (spec) => {
        specs.push(spec);
        if (o.recordOnly) return Promise.reject(new Error("recorded, not run"));
        return inner.create(spec);
      },
      resume: (file, spec) => inner.resume(file, spec),
    };
  };
  const deps: ReviewCliDeps = {
    cwd: o.repo ?? mkRepo(),
    out: (l) => lines.push(l),
    warn: (l) => said.push(l),
    confirm: o.confirm ?? null,
    root,
    agentDir: o.home ?? mkHome(),
    cfg: o.cfg ?? UNPINNED,
    ecosystem: ctx.ecosystem,
    runtime,
    models: {
      env: o.env ?? {},
      tmpDir,
      configPath: null,
      choose: o.choose ?? null,
      host: { ownsProcess: false, homeDir: join(tmp, "no-home") },
      configureModels,
      ...(o.now ? { now: o.now } : {}),
    },
    runsDir,
    dryrunDir: join(tmp, `dryrun-${n}`),
    storeDir: join(tmp, `store-${n}`),
    timeoutMs: 10 * 60_000,
  };
  return {
    deps,
    lines,
    said,
    hosts,
    specs,
    built: () => built,
    faux,
    tmpDir,
    text: () => lines.join("\n"),
    json: () => JSON.parse(lines.find((l) => l.startsWith("{"))!) as Record<string, unknown>,
  };
}

/** The preview object of a `--json` run. */
const previewOf = (h: Harness): Record<string, unknown> =>
  h.json()["preview"] as Record<string, unknown>;

/** The lines of the text that name the model. */
const modelLines = (h: Harness): string[] =>
  h
    .text()
    .split("\n")
    .filter((l) => l.trimStart().startsWith("model:"));

describe("qcr review: the model in the preview", () => {
  it("names the model once, under the lenses, and carries it as model, alternatives and tiers", async () => {
    const home = mkHome({ local: true });
    const h = harness({ home });
    expect(await runReviewCli(["--preview"], false, h.deps)).toBe(0);
    expect(modelLines(h)).toEqual([
      `  model: ${FAKE_ROUTE_MODEL} (the provider pi has a credential for)`,
    ]);
    const shown = h.text().split("\n");
    expect(shown.findIndex((l) => l.startsWith("  model:"))).toBe(
      shown.findIndex((l) => l.startsWith("  lenses:")) + 1,
    );

    const j = harness({ home });
    expect(await runReviewCli(["--preview"], true, j.deps)).toBe(0);
    const p = previewOf(j);
    expect(p["model"]).toEqual({
      spec: FAKE_ROUTE_MODEL,
      provider: "local",
      id: "r",
      provider_name: "local",
      source: "only-credential",
      pick: "newest",
      pi_default: null,
      custom: false,
      moved_from: null,
      priced: true,
      ask: false,
      credential: { kind: "api_key", origin: "models-json", subscription: false },
    });
    expect(p["alternatives"]).toEqual([]);
    expect(p["tiers"]).toEqual({
      light: `${FAKE_ROUTE_MODEL}:medium`,
      standard: `${FAKE_ROUTE_MODEL}:medium`,
      deep: `${FAKE_ROUTE_MODEL}:high`,
    });
    // a preview starts nothing: its host was for the route alone, and is gone
    expect(j.hosts).toEqual([]);
    expect(existsSync(j.tmpDir) ? readdirSync(j.tmpDir) : []).toEqual([]);
  });

  it("a key for any provider is enough, and its value is in no line", async () => {
    const h = harness({ env: { [BUILTIN_ENV]: KEY_VALUE } });
    expect(await runReviewCli(["--preview"], true, h.deps)).toBe(0);
    expect(previewOf(h)["model"]).toMatchObject({
      provider: BUILTIN,
      provider_name: BUILTIN_NAME,
      source: "only-credential",
      credential: { kind: "api_key", origin: "env-key", subscription: false },
    });
    const t = harness({ env: { [BUILTIN_ENV]: KEY_VALUE } });
    expect(await runReviewCli(["--preview"], false, t.deps)).toBe(0);
    expect(modelLines(t)).toHaveLength(1);
    for (const said of [h.text(), t.text(), ...h.said, ...t.said])
      expect(said).not.toContain(KEY_VALUE);
  });

  it("with no credential the preview still shows the plan, and says there is no model", async () => {
    const h = harness({});
    expect(await runReviewCli(["--preview"], true, h.deps)).toBe(0);
    const p = previewOf(h);
    expect(p["model"]).toBeNull();
    expect(p["alternatives"]).toEqual([]);
    expect(p["tiers"]).toEqual({ light: ":medium", standard: ":medium", deep: ":high" });
    expect((p["lenses"] as string[]).length).toBeGreaterThan(0);

    const t = harness({});
    expect(await runReviewCli(["--preview"], false, t.deps)).toBe(0);
    expect(modelLines(t)).toEqual(["  model: none (no model credential: qcr login)"]);
  });
});

describe("qcr review: a start with no route is refused, in the route's words", () => {
  it("nothing at all: refused naming qcr login, and no runtime is built", async () => {
    const home = mkHome();
    const h = harness({ home });
    expect(await runReviewCli([], false, h.deps)).toBe(1);
    expect(h.text()).toContain(`pi has no model credential (agent dir ${home})`);
    expect(h.text()).toContain("Run `qcr login`");
    expect(h.hosts).toEqual([]);
    expect(h.specs).toEqual([]);
    // the host's private agent dir went with the refusal
    expect(readdirSync(h.tmpDir)).toEqual([]);
  });

  it("a pin pi cannot read, and a pin on a provider with no credential", async () => {
    const unknown = harness({ home: mkHome({ local: true }) });
    expect(await runReviewCli(["--model", "no-such-provider/x"], true, unknown.deps)).toBe(1);
    expect((unknown.json()["errors"] as string[])[0]).toMatch(
      /^pi knows no model "no-such-provider\/x" \(.+\)\. qcr model lists what is usable\.$/,
    );

    const pin = `${BUILTIN}/${BUILTIN_MODEL}`;
    const bare = harness({ home: mkHome({ local: true }) });
    expect(await runReviewCli(["--model", pin], true, bare.deps)).toBe(1);
    expect((bare.json()["errors"] as string[])[0]).toBe(
      `this review is pinned to ${pin} (--model), and pi has no credential for ${BUILTIN}. ` +
        `Sign in with \`qcr login ${BUILTIN}\`, or drop the pin (omit --model).`,
    );
    expect(bare.specs).toEqual([]);
  });

  it("a login shorter than the review is refused with what works, and one that cannot be read is not taken for none", async () => {
    const NOW = Date.UTC(2026, 0, 15, 12, 0, 0);
    const home = mkHome();
    writeFileSync(
      join(home, "auth.json"),
      JSON.stringify({
        [BUILTIN]: { type: "oauth", access: "a", refresh: "r", expires: NOW + 8 * 60_000 },
      }),
    );
    const short = harness({ home, now: () => NOW });
    expect(await runReviewCli([], true, short.deps)).toBe(1);
    const why = (short.json()["errors"] as string[])[0]!;
    expect(why).toContain(`your ${BUILTIN_NAME} login expires at `);
    expect(why).toContain("inside this review's 10-minute budget, and nothing here renews it");
    expect(why).toContain("Run the review inside pi (/qcr-review)");

    const broken = mkHome();
    writeFileSync(join(broken, "auth.json"), "{ not json");
    for (const args of [[], ["--preview"]]) {
      const h = harness({ home: broken });
      expect(await runReviewCli(args, true, h.deps)).toBe(1);
      expect((h.json()["errors"] as string[])[0]).toContain(join(broken, "auth.json"));
    }
  });
});

describe("qcr review: one host, and the question", () => {
  // MUTATION: drop `prebuilt` from what routeRun hands the runtime
  // (src/reviewcli.ts) — the round's session is built on a second host, which
  // has no faux provider, and this fails.
  it("the run's sessions are on the host the route was resolved on, which holds the login in memory", async () => {
    const h = harness({ faux: ["faux"] });
    expect(await runReviewCli([], false, h.deps), h.text()).toBe(0);
    expect(h.built()).toBe(1);
    expect(h.hosts).toHaveLength(1);
    expect(h.faux["faux"]!.state.answers).toBe(1);
    expect(h.text()).toMatch(/b is a magic number/);
    // the model line is the run's notice: said once, with the preview
    expect(modelLines(h)).toEqual([
      `  model: faux/${FAUX_ID} (the provider pi has a credential for)`,
    ]);
    // the session named no model (the route's), in a private agent dir with no
    // login file, which went with the run
    expect(h.specs).toHaveLength(1);
    expect(h.specs[0]!.model).toBe("");
    const agentDir = h.specs[0]!.env["PI_CODING_AGENT_DIR"]!;
    expect(agentDir.startsWith(h.tmpDir)).toBe(true);
    expect(agentDir).not.toBe(h.deps.agentDir);
    expect(existsSync(agentDir)).toBe(false);
    expect(readdirSync(h.tmpDir)).toEqual([]);
  });

  it("two providers tie: a terminal is asked once, the answer is remembered and runs", async () => {
    const home = mkHome();
    const asked: Array<{ question: string; rows: readonly string[] }> = [];
    const first = harness({
      home,
      faux: ["alpha", "beta"],
      choose: async (question, rows) => {
        asked.push({ question, rows });
        return 1;
      },
    });
    expect(await runReviewCli([], false, first.deps), first.text()).toBe(0);
    expect(asked).toHaveLength(1);
    expect(asked[0]!.question).toBe("pi can run this review on more than one provider:");
    // the first row is the one the order takes
    expect(asked[0]!.rows.map((r) => r.split(/\s+/)[0])).toEqual([
      `alpha/${FAUX_ID}`,
      `beta/${FAUX_ID}`,
    ]);
    expect(JSON.parse(readFileSync(join(home, MODEL_CHOICE_FILE), "utf8"))).toMatchObject({
      provider: "beta",
      model: null,
      via: "ask",
    });
    expect(first.said.join("\n")).toMatch(
      /^Remembered: .+\. qcr model use <provider> changes it\.$/m,
    );
    expect(modelLines(first)).toHaveLength(1);
    expect(modelLines(first)[0]).toMatch(
      new RegExp(
        `^  model: beta/${FAUX_ID} \\(you picked .+ when asked; qcr model use .+ changes it\\)$`,
      ),
    );
    // the answer ran: the round was beta's, on the host resolved with it
    expect(first.faux["beta"]!.state.answers).toBe(1);
    expect(first.faux["alpha"]!.state.answers).toBe(0);
    expect(first.built()).toBe(2);

    // the next run is not asked
    const again = harness({
      home,
      faux: ["alpha", "beta"],
      choose: async (question, rows) => {
        asked.push({ question, rows });
        return 0;
      },
    });
    expect(await runReviewCli(["--preview"], true, again.deps)).toBe(0);
    expect(await runReviewCli([], true, { ...again.deps, cwd: mkRepo() })).toBe(0);
    expect(asked).toHaveLength(1);
    expect(previewOf(again)["model"]).toMatchObject({
      provider: "beta",
      source: "remembered",
      ask: false,
    });
  });

  it("a preview and --json never ask; with nobody to ask the order decides and the line says how to change it", async () => {
    let asks = 0;
    const choose = async (): Promise<number> => {
      asks++;
      return 1;
    };
    const home = mkHome();
    const pre = harness({ home, faux: ["alpha", "beta"], choose });
    expect(await runReviewCli(["--preview"], true, pre.deps)).toBe(0);
    const p = previewOf(pre);
    expect(p["model"]).toMatchObject({ provider: "alpha", source: "credential-order", ask: true });
    expect(p["alternatives"]).toMatchObject([
      { spec: `beta/${FAUX_ID}`, provider: "beta", credential: { origin: "ambient" } },
    ]);
    const run = harness({ home, faux: ["alpha", "beta"], choose });
    expect(await runReviewCli([], true, run.deps), run.text()).toBe(0);
    expect(asks).toBe(0);
    expect(existsSync(join(home, MODEL_CHOICE_FILE))).toBe(false);

    const quiet = harness({ home, faux: ["alpha", "beta"] });
    expect(await runReviewCli(["--preview"], false, quiet.deps)).toBe(0);
    expect(modelLines(quiet)).toEqual([
      `  model: alpha/${FAUX_ID} (picked among 2 providers pi has credentials for: it has the newest model). ` +
        "Change it: qcr model use <provider[/model]>, or --model for one run",
    ]);
  });

  it("the rows say whose credential each provider runs on", () => {
    const credential = { kind: "api_key", origin: "env-key", label: "A_KEY", subscription: false };
    const route = {
      spec: "a/long-model-id",
      providerName: "A",
      credential,
      priced: true,
      alternatives: [
        {
          spec: "b/m",
          providerName: "B",
          credential: { kind: "oauth", origin: "stored", subscription: true },
          priced: false,
        },
      ],
    } as unknown as ModelRoute;
    expect(providerRows(route)).toEqual([
      "a/long-model-id    A, A_KEY",
      "b/m                B, signed in with pi (subscription)    no list price",
    ]);
  });
});

describe("qcr review --model", () => {
  it("parses, needs a value, and is in the help", () => {
    expect(parseReviewArgs(["--model", "p/m:high"])).toMatchObject({ model: "p/m:high" });
    expect(parseReviewArgs([])).not.toHaveProperty("model");
    expect(() => parseReviewArgs(["--model"])).toThrow(/--model needs a value/);
    expect(() => parseReviewArgs(["--model", "--preview"])).toThrow(/--model needs a value/);
    expect(reviewHelp()).toMatch(/--model MODEL/);
  });

  // MUTATION: drop the stripPins call from runReviewCli (src/reviewcli.ts) —
  // the tiers keep their own models under --model, and this fails.
  it("is the whole review's model for the run: it replaces every tier and lens the config pins, and says so", async () => {
    const home = mkHome({ local: true });
    const flag = `faux/${FAUX_ID}`;
    const h = harness({ home, faux: ["faux"], cfg: PINNED });
    expect(await runReviewCli(["--preview", "--model", flag], true, h.deps)).toBe(0);
    const p = previewOf(h);
    expect(p["model"]).toMatchObject({ spec: flag, source: "flag", pick: "pinned" });
    // each tier keeps its level and loses its model
    expect(p["tiers"]).toEqual({
      light: `${flag}:low`,
      standard: `${flag}:medium`,
      deep: `${flag}:high`,
    });
    const t = harness({ home, faux: ["faux"], cfg: PINNED });
    expect(await runReviewCli(["--preview", "--model", flag], false, t.deps)).toBe(0);
    expect(t.text().split("\n")).toContain(
      "  --model replaces 3 pinned tier and lens models for this run",
    );
    expect(modelLines(t)).toEqual([`  model: ${flag} (pinned by --model)`]);

    // the config's own pin, by contrast, leaves its tier pins standing
    const own = harness({ home, faux: ["faux"], cfg: PINNED });
    expect(await runReviewCli(["--preview"], true, own.deps)).toBe(0);
    expect(previewOf(own)["model"]).toMatchObject({ spec: FAKE_ROUTE_MODEL, source: "config" });
    expect(previewOf(own)["tiers"]).toEqual({
      light: "local/m:low",
      standard: `${FAKE_ROUTE_MODEL}:medium`,
      deep: `${FAKE_ROUTE_MODEL}:high`,
    });
    expect(own.text()).not.toContain("--model replaces");
  });

  it("the main session names no model under --model: the flag's level, else the config's", async () => {
    const home = mkHome({ local: true });
    const flag = `faux/${FAUX_ID}`;
    const plain = harness({ home, faux: ["faux"], cfg: PINNED, recordOnly: true });
    expect(await runReviewCli(["--model", flag], true, plain.deps)).toBe(1);
    expect(plain.specs.map((s) => s.model)).toEqual([":low"]);
    expect(plain.hosts[0]!.route).toMatchObject({ pin: { text: flag, from: "flag" } });

    const levelled = harness({ home, faux: ["faux"], cfg: PINNED, recordOnly: true });
    expect(await runReviewCli(["--model", `${flag}:high`], true, levelled.deps)).toBe(1);
    expect(levelled.specs.map((s) => s.model)).toEqual([""]);

    // without the flag the config's own spec is the session's
    const own = harness({ home, faux: ["faux"], cfg: PINNED, recordOnly: true });
    expect(await runReviewCli([], true, own.deps)).toBe(1);
    expect(own.specs.map((s) => s.model)).toEqual([`${FAKE_ROUTE_MODEL}:low`]);
    expect(own.hosts[0]!.route).toMatchObject({
      pin: { text: `${FAKE_ROUTE_MODEL}:low`, from: "config" },
    });
  });
});

describe("the models are in the preview key", () => {
  const base = { headSha: "h", baseSha: "b", lenses: ["pass-x--deep"], lines: 3, cap_usd: 1 };

  it("the key reads the specs sorted and distinct, and moves with any of them", () => {
    const key = reviewKey({ ...base, models: ["p/a:high", "p/b"] });
    expect(reviewKey({ ...base, models: ["p/b", "p/a:high", "p/b"] })).toBe(key);
    expect(reviewKey({ ...base, models: ["p/a:medium", "p/b"] })).not.toBe(key);
    expect(reviewKey({ ...base, models: ["q/a:high", "p/b"] })).not.toBe(key);
  });

  // MUTATION: drop `models` from reviewKey's input (packages/pi-plugin/src/localreview.ts) —
  // a start under another --model accepts the old key and this fails.
  it("a start under another --model does not accept the key a preview showed", async () => {
    const home = mkHome();
    // over the limit, with nobody to ask: only the key starts it
    const repo = mkRepo(0.0001);
    const pre = harness({ home, repo, faux: ["alpha", "beta"] });
    expect(await runReviewCli(["--preview"], true, pre.deps)).toBe(0);
    const key = previewOf(pre)["key"] as string;
    expect(previewOf(pre)["model"]).toMatchObject({ provider: "alpha" });

    const other = harness({ home, repo, faux: ["alpha", "beta"] });
    expect(await runReviewCli(["--key", key, "--model", `beta/${FAUX_ID}`], true, other.deps)).toBe(
      1,
    );
    expect((other.json()["errors"] as string[])[0]).toMatch(/does not match this review/);
    expect(other.specs).toEqual([]);

    // the same key under the same model starts the review
    const same = harness({ home, repo, faux: ["alpha", "beta"] });
    expect(await runReviewCli(["--key", key], true, same.deps), same.text()).toBe(0);
    expect(same.faux["alpha"]!.state.answers).toBe(1);
  });
});

describe("a spec as it will run", () => {
  const entry = (provider: string, ids: string[]): ProviderInventory => ({
    provider,
    name: provider,
    credential: { kind: "api_key", origin: "stored", subscription: false },
    models: ids.map((id) => ({ provider, id })),
  });
  const route = { spec: "held/x", thinking: null } as unknown as ModelRoute;
  const on = { route, inventory: [entry("held", ["x", "shared"])] };

  it("a spec with no model is the route's, at its own level or the one given", () => {
    expect(specAsRun(":medium", on)).toBe("held/x:medium");
    expect(specAsRun("", on, "high")).toBe("held/x:high");
    expect(specAsRun("", on)).toBe("held/x");
  });

  it("a pinned spec stays on a provider with a credential, and moves off one with none when that is not a guess", () => {
    expect(specAsRun("held/other:low", on)).toBe("held/other:low");
    expect(specAsRun("gone/shared:high", on)).toBe("held/shared:high");
    // nothing serves it here: as written, and the run refuses it
    expect(specAsRun("gone/alone", on)).toBe("gone/alone");
    const two = { route, inventory: [entry("a", ["shared"]), entry("b", ["shared"])] };
    expect(specAsRun("gone/shared", two)).toBe("gone/shared");
    expect(specAsRun("gone/shared", { ...two, prefer: "b" })).toBe("b/shared");
  });

  it("what is not known is not filled in: no route, or no route given", () => {
    expect(specAsRun(":high", { route: null, inventory: [] })).toBe(":high");
    expect(specAsRun("gone/shared:high", null)).toBe("gone/shared:high");
    expect(specAsRun("", null, "medium")).toBe(":medium");
  });

  it("a run's models: the main session's, each tier's, and each planned lens's own", () => {
    const cfg = {
      ...UNPINNED,
      models: {
        ...UNPINNED.models,
        model: "",
        tiers: { light: ":low", standard: "gone/shared:medium", deep: ":high" },
        pass_models: { "pass-style": ":minimal" },
      },
    };
    const m = runModels(
      cfg,
      ["pass-style--light", "pass-contracts--standard", "pass-security--deep"],
      { route: { ...route, thinking: "xhigh" } as ModelRoute, inventory: on.inventory },
    );
    expect(m.main).toBe("held/x:xhigh");
    expect(m.tiers).toEqual({
      light: "held/x:low",
      standard: "held/shared:medium",
      deep: "held/x:high",
    });
    expect(m.all).toEqual(
      ["held/x:xhigh", "held/x:minimal", "held/shared:medium", "held/x:high"].sort(),
    );
  });
});
