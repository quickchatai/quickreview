// `qcr model` (src/modelcli.ts): the route a review here would run on and
// why, `use` and `reset` over the choice file in pi's agent dir, `--json`,
// and what a directory that cannot be written says. Then the words every
// surface shares (packages/pi-plugin/src/modelroute.ts): the route notice and
// the five refusals.
//
// Then the verb as a process runs it (`runModelCli`), where the environment
// decides which directories it reads: the login a daemon was handed
// (`QCR_LOGIN_DIR`) and the wizards' secrets dir (`QC_SECRETS_DIR`).
//
// Every route here is resolved by the real pi over a temp agent dir whose
// `models.json` defines a provider of its own, with a built-in provider keyed
// through the environment the case names. Nothing is sent anywhere, and the
// developer's own keys never count: the environment is the one each case gives.
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { builtinProviders, getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
// Loaded here so the verb's own lazy imports (the pi SDK, and what
// `runModelCli` reads its homes with) are not on a test's clock.
import "@quickchatai/pi-quickreview/src/engine/pisdk.js";
import "@quickchatai/pi-quickreview/src/assetroot.js";
import "../src/homes.js";
import "../src/piagentdir.js";
import { MODEL_CHOICE_FILE, readModelChoice } from "@quickchatai/pi-quickreview/src/modelchoice.js";
import {
  credentialWords,
  refusalText,
  routeNotice,
  routeNoticeLines,
  routePicked,
  routeWhy,
  type ModelRoute,
} from "@quickchatai/pi-quickreview/src/modelroute.js";
import { CONTAINER_LOGIN_DIR, LOGIN_DIR_ENV } from "../src/loginrefresh/supervisor.js";
import {
  cmdModel,
  inDaemonContainer,
  MODEL_USAGE,
  REVIEW_WINDOW_MS,
  refresherOwnsLogin,
  runModelCli,
  type ModelCliDeps,
  type ModelCliJson,
} from "../src/modelcli.js";
import { MODEL_ENV_DIR } from "../src/modelenv.js";
import { LOGIN_STATUS_FILE } from "../src/workerworld.js";
import { MEASURED } from "@quickchatai/pi-quickreview/src/measured.js";
import type { OnboardAdapters } from "../src/onboard/engine.js";
import { secretsDirFor } from "../src/onboard/steps/ingress.js";
import { FAKE_ROUTE_MODEL, writeFakeProvider } from "./helpers/fake-openai.js";
import { HEAVY_TIMEOUT_MS } from "./helpers/suite-timeouts.js";
import { useOfflineGuard } from "./pi-canary/harness.js";

useOfflineGuard();

/** A built-in provider no case has a credential for unless it gives one. */
const BUILTIN = "deepseek";
const BUILTIN_NAME = builtinProviders().find((p) => p.id === BUILTIN)!.name;
const BUILTIN_ENV = "DEEPSEEK_API_KEY";
/** A built-in provider pi can sign in to: pi counts a stored login only for a
 * provider with a login of its own. */
const SIGN_IN = "anthropic";
/** Never listened on: no case sends a request. */
const NOWHERE = "http://127.0.0.1:9/v1";
/** A config that pins nothing: each tier at its own level. */
const UNPINNED: ModelCliDeps["models"] = {
  model: "",
  tiers: { light: ":medium", standard: ":medium", deep: ":high" },
};
const NOW = Date.UTC(2026, 0, 15, 12, 0, 0);

let dir: string;
let home: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "model-cli-"));
  home = join(dir, "pi-home");
  mkdirSync(home, { recursive: true });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** The pi home with the custom provider `local` (models `m` and `r`). */
const withLocal = (): void => writeFakeProvider(home, NOWHERE, { routable: true });

interface Run {
  code: number;
  out: string[];
  err: string[];
  text: string;
}

async function run(args: string[], over: Partial<ModelCliDeps> = {}, json = false): Promise<Run> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await cmdModel(args, json, {
    env: {},
    agentDir: home,
    tmpDir: join(dir, "state", "tmp"),
    models: UNPINNED,
    configPath: null,
    secretsDir: null,
    daemon: false,
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    now: () => NOW,
    ...over,
  });
  return { code, out, err, text: out.join("\n") };
}

async function runJson(args: string[], over: Partial<ModelCliDeps> = {}) {
  const r = await run(args, over, true);
  expect(r.out).toHaveLength(1);
  return { ...r, json: JSON.parse(r.out[0]!) as ModelCliJson & { error?: string } };
}

const choiceFile = (): unknown =>
  JSON.parse(readFileSync(join(home, MODEL_CHOICE_FILE), "utf8")) as unknown;

describe("qcr model: the route, and why", () => {
  it("one provider: names the model, why, how it was picked, the credential and the levels", async () => {
    withLocal();
    const r = await run([]);
    expect(r.code).toBe(0);
    expect(r.out).toEqual([
      `model: ${FAKE_ROUTE_MODEL}`,
      "  why: the one provider pi has a usable credential for",
      "  picked: the newest version on local",
      "  credential: local, a key in pi's models.json",
      "  levels: light medium, standard medium, deep high",
      "  price: no estimate for this model; a review stops at $15.00 unless --limit says otherwise",
      "change it: qcr model use <provider[/model]>    automatic again: qcr model reset    one run: --model <provider/model>",
    ]);
    expect(r.err).toEqual([]);
  });

  // MUTATION: leave the route host's private agent dir behind in routeHost's
  // dispose — the tmp dir is not empty and this fails.
  it("reads the pi home and writes nothing to it; the private agent dir is gone afterwards", async () => {
    withLocal();
    const before = readdirSync(home).sort();
    await run([]);
    expect(readdirSync(home).sort()).toEqual(before);
    expect(readdirSync(join(dir, "state", "tmp"))).toEqual([]);
  });

  it("several providers: the order's reason, and the others as usable too", async () => {
    withLocal();
    const r = await run([], { env: { [BUILTIN_ENV]: "not-a-key" } });
    expect(r.code).toBe(0);
    expect(r.out[0]).toBe(`model: ${FAKE_ROUTE_MODEL}`);
    expect(r.out[1]).toBe("  why: a key pi holds comes first");
    const also = r.out.indexOf("also usable:");
    expect(also).toBeGreaterThan(0);
    expect(r.out[also + 1]).toMatch(
      // the last column: what is known of its price before a review
      new RegExp(`^  ${BUILTIN}/\\S+    ${BUILTIN_NAME}, ${BUILTIN_ENV}    no estimate$`),
    );
    expect(r.text).not.toContain("not-a-key");
  });

  // The install's secrets dir carries a provider's key as a file: the verb
  // sees what a worker's process sees, with nothing in the shell.
  // MUTATION: drop the model env from the route host's authEnv in
  // src/modelcli.ts — pi has no credential and this fails.
  it("a key in the secrets dir's model env is a credential, and its value is never printed", async () => {
    const secrets = join(dir, "secrets");
    mkdirSync(join(secrets, MODEL_ENV_DIR), { recursive: true });
    writeFileSync(join(secrets, MODEL_ENV_DIR, BUILTIN_ENV), "value-from-the-secrets-dir\n");
    const r = await run([], { secretsDir: secrets });
    expect(r.code).toBe(0);
    expect(r.out[0]).toMatch(new RegExp(`^model: ${BUILTIN}/`));
    expect(r.text).toContain(`credential: ${BUILTIN_NAME}, ${BUILTIN_ENV}`);
    expect([...r.out, ...r.err].join("\n")).not.toContain("value-from-the-secrets-dir");
    const j = await runJson([], { secretsDir: secrets });
    expect(JSON.stringify(j.json)).not.toContain("value-from-the-secrets-dir");
  });

  it("the config's pin is the route, with the file that pins it", async () => {
    withLocal();
    const r = await run([], {
      models: { ...UNPINNED, model: "local/m:high" },
      configPath: "/etc/qcr/config.toml",
    });
    expect(r.code).toBe(0);
    expect(r.out.slice(0, 3)).toEqual([
      "model: local/m",
      "  why: pinned by [models] model in /etc/qcr/config.toml",
      "  credential: local, a key in pi's models.json",
    ]);
    // Zero-config: the shipped defaults are the config.
    const shipped = await run([], { models: { ...UNPINNED, model: "local/m" } });
    expect(shipped.out[1]).toBe("  why: pinned by [models] model in the shipped defaults");
  });

  // An unpinned config under `[models] effort` or a review preset holds a level
  // and no model there (`":high"`). That pins nothing: the text never reaches
  // pi's parser, which would match some model to it.
  // MUTATION: test the pin with `deps.models.model !== ""` in resolve() of
  // src/modelcli.ts — ":high" is resolved as the config's pin and this fails.
  it("a [models] model that names only a level pins nothing", async () => {
    withLocal();
    const env = { [BUILTIN_ENV]: "not-a-key" };
    const level: ModelCliDeps["models"] = { ...UNPINNED, model: ":high" };
    const plain = await run([], { env });
    const r = await run([], { env, models: level, configPath: "/etc/qcr/config.toml" });
    expect(r.code).toBe(0);
    expect(r.out).toEqual(plain.out);
    expect(r.text).not.toContain("pinned by");
    const j = await runJson([], { env, models: level });
    expect(j.json.config_pin).toBeNull();
    expect(j.json.route).toEqual((await runJson([], { env })).json.route);
    expect(j.json.route).toMatchObject({ spec: FAKE_ROUTE_MODEL, source: "credential-order" });
    // Nothing in the config stands over a choice either.
    const used = await run(["use", BUILTIN], { env, models: level });
    expect(used.out).toHaveLength(1);
    expect(used.text).not.toContain("still pins");
    expect((await run([], { env, models: level })).out[1]).toBe(
      "  why: you chose it (qcr model use)",
    );
  });

  /** A pi home whose provider `local` serves one model, as the case prices it. */
  const withModel = (model: { id: string; api: string; cost: Record<string, number> }): void => {
    writeFileSync(
      join(home, "models.json"),
      JSON.stringify({
        providers: {
          local: {
            baseUrl: NOWHERE,
            api: model.api,
            apiKey: "not-a-key",
            models: [
              {
                id: model.id,
                name: model.id,
                reasoning: true,
                input: ["text"],
                cost: { cacheWrite: 0, ...model.cost },
                contextWindow: 200000,
                maxTokens: 4000,
              },
            ],
          },
        },
      }),
    );
  };
  const priceOf = (r: Run): string | undefined => r.out.find((l) => l.startsWith("  price:"));

  // MUTATION: return the "no estimate" line from priceLine whatever the
  // models (src/modelcli.ts) — the measured model is told it has no
  // estimate, and this fails.
  it(
    "the price line: an estimate on the measured model, a stop on any other, neither with no list price",
    {
      timeout: HEAVY_TIMEOUT_MS,
    },
    async () => {
      withModel({ id: MEASURED.model_id, api: MEASURED.apis[0], cost: { ...MEASURED.rates } });
      const measured = await run([]);
      expect(measured.code).toBe(0);
      expect(priceOf(measured)).toBe(
        `  price: an estimate before each review (measured on ${MEASURED.model_id}); a review stops at twice it`,
      );
      // the same model with one tier pinned elsewhere is not a measured review
      const mixed = await run([], {
        models: { model: "", tiers: { ...UNPINNED.tiers, deep: "elsewhere/other-model:high" } },
      });
      expect(priceOf(mixed)).toBe(
        "  price: no estimate for this model; a review stops at $15.00 unless --limit says otherwise",
      );
      // the same id through an API outside the measured family
      withModel({ id: MEASURED.model_id, api: "openai-completions", cost: { ...MEASURED.rates } });
      expect(priceOf(await run([]))).toMatch(/^ {2}price: no estimate for this model/);
      // a model pi has no price for
      withModel({
        id: "free-model-1",
        api: "openai-completions",
        cost: { input: 0, output: 0, cacheRead: 0 },
      });
      expect(priceOf(await run([]))).toBe(
        "  price: pi has no list price for this model: no dollar stop",
      );
    },
  );

  it("a tier the config pins to a model of its own is shown whole", async () => {
    withLocal();
    const r = await run([], {
      models: { model: "", tiers: { ...UNPINNED.tiers, deep: "local/m:high" } },
    });
    expect(r.text).toContain("  levels: light medium, standard medium, deep local/m:high");
  });

  it("an install with a config of its own also says what holds for the bot's rounds", async () => {
    withLocal();
    const r = await run([], { daemon: true });
    expect(r.out).toContain("  bot rounds: no dollar stop (time limits hold)");
    expect((await run([])).text).not.toMatch(/bot rounds/);
  });

  it("no credential: `model: none`, the refusal that names qcr login, exit 1", async () => {
    const r = await run([]);
    expect(r.code).toBe(1);
    expect(r.out).toEqual([
      "model: none",
      `pi has no model credential (agent dir ${home}). Run \`qcr login\` and sign in to any provider, or set a provider's API key in the environment, then run this again.`,
    ]);
  });

  it("a pin pi has no credential for is refused with the pin's own remedy", async () => {
    withLocal();
    const id = getBuiltinModels(BUILTIN)[0]!.id;
    const r = await run([], {
      models: { ...UNPINNED, model: `${BUILTIN}/${id}` },
      configPath: "/etc/qcr/config.toml",
    });
    expect(r.code).toBe(1);
    expect(r.out).toEqual([
      "model: none",
      `this review is pinned to ${BUILTIN}/${id} ([models] model in /etc/qcr/config.toml), and pi has no credential for ${BUILTIN}. Sign in with \`qcr login ${BUILTIN}\`, or drop the pin (remove model from [models]).`,
    ]);
  });

  // A stored login that cannot last a review is left out before the route is
  // chosen. The borrow knows only the provider's id; the verb says pi's name.
  // MUTATION: print the skipped logins as the borrow returns them in
  // src/modelcli.ts — the row names the id and this fails.
  it("a login too short for a review is listed as not usable here, under pi's name for it", async () => {
    withLocal();
    writeFileSync(
      join(home, "auth.json"),
      JSON.stringify({
        [BUILTIN]: { type: "oauth", access: "a", refresh: "r", expires: NOW + 20 * 60_000 },
      }),
    );
    const r = await run([]);
    expect(r.code).toBe(0);
    expect(r.out[0]).toBe(`model: ${FAKE_ROUTE_MODEL}`);
    const at = r.out.indexOf("not usable here:");
    expect(at).toBeGreaterThan(0);
    expect(r.out[at + 1]).toMatch(
      new RegExp(
        `^  ${BUILTIN_NAME}: its login expires at \\d\\d:\\d\\d and nothing here renews it \\(inside pi: /qcr-review\\)$`,
      ),
    );
    // Said once: the block is where it is, not a note as well.
    expect(r.out.filter((l) => l.includes("nothing here renews it"))).toHaveLength(1);
    const j = await runJson([]);
    expect(j.json.skipped).toEqual([
      { provider: BUILTIN, name: BUILTIN_NAME, expiresAt: NOW + 20 * 60_000 },
    ]);
    expect(j.json.route?.notices).toEqual([
      expect.stringMatching(new RegExp(`^skipped ${BUILTIN_NAME}: its login expires at `)),
    ]);
  });

  it("with only such a login, the refusal names it and what works", async () => {
    writeFileSync(
      join(home, "auth.json"),
      JSON.stringify({
        [BUILTIN]: { type: "oauth", access: "a", refresh: "r", expires: NOW + 20 * 60_000 },
      }),
    );
    const r = await run([]);
    expect(r.code).toBe(1);
    expect(r.out).toHaveLength(2);
    expect(r.out[1]).toMatch(
      new RegExp(
        `^your ${BUILTIN_NAME} login expires at \\d\\d:\\d\\d, inside this review's 60-minute budget, and nothing here renews it\\. Run the review inside pi \\(/qcr-review\\), where pi renews it, or use another credential: \`qcr login\`, or a provider key in the environment\\.$`,
      ),
    );
    expect(REVIEW_WINDOW_MS).toBe(60 * 60_000);
  });

  // A worker keeps a login shorter than its round while the bot's refresher
  // renews it (src/botworker.ts), so the verb, asked where the daemon runs,
  // keeps it too: the wizard's model step takes this answer for the daemon's.
  // MUTATION: pass `owner: false` to borrowedCredentials in resolve
  // (src/modelcli.ts) — the login is left out, the answer is login-too-short
  // and this fails.
  it("a short login the refresher is renewing is the route, as a worker's is; without the refresher it is refused", async () => {
    writeFileSync(
      join(home, "auth.json"),
      JSON.stringify({
        [SIGN_IN]: { type: "oauth", access: "a", refresh: "r", expires: NOW + 20 * 60_000 },
      }),
    );
    const owned = await runJson([], { daemon: true, owner: true });
    expect(owned.code).toBe(0);
    expect(owned.json.ok).toBe(true);
    expect(owned.json.route).toMatchObject({
      provider: SIGN_IN,
      credential: { kind: "oauth", origin: "stored" },
    });
    expect(owned.json.skipped).toEqual([]);
    for (const none of [{ daemon: true }, { daemon: true, owner: false }]) {
      const alone = await runJson([], none);
      expect(alone.code).toBe(1);
      expect(alone.json.refusal?.code).toBe("login-too-short");
    }
    // An expired login is refused under the refresher too: nothing to renew.
    writeFileSync(
      join(home, "auth.json"),
      JSON.stringify({
        [SIGN_IN]: { type: "oauth", access: "a", refresh: "r", expires: NOW - 60_000 },
      }),
    );
    const expired = await runJson([], { daemon: true, owner: true });
    expect(expired.json.ok).toBe(false);
  });

  // The read waits out a file that is being rewritten before it calls it
  // unreadable, which is most of a second each time.
  it(
    "a login file that cannot be read is said in one line, never taken for no login",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      withLocal();
      writeFileSync(join(home, "auth.json"), "{ not json");
      const r = await run([]);
      expect(r.code).toBe(1);
      expect(r.out).toEqual([]);
      expect(r.err).toHaveLength(1);
      expect(r.err[0]).toMatch(/^qcr model: could not read pi's credentials at .*auth\.json: /);
      const j = await runJson([]);
      expect(j.code).toBe(1);
      expect(j.json).toMatchObject({ ok: false, route: null });
      expect(j.json.error).toMatch(/could not read pi's credentials/);
    },
  );

  it("usage: --help prints it, anything else it does not know is exit 2", async () => {
    const help = await run(["--help"]);
    expect(help).toMatchObject({ code: 0, text: MODEL_USAGE });
    for (const args of [["nonsense"], ["use"], ["use", "a", "b"], ["reset", "now"]]) {
      const r = await run(args);
      expect(r.code, args.join(" ")).toBe(2);
      expect(r.err.join("\n")).toContain("usage: qcr model");
    }
  });
});

describe("qcr model --json", () => {
  // The wizard, the scan sandbox and the smoke scripts read this object.
  // MUTATION: leave `config_pin` out of stateJson in src/modelcli.ts — this fails.
  it("is one object: ok, route, choice, config_pin, skipped", async () => {
    withLocal();
    const j = await runJson([], { env: { [BUILTIN_ENV]: "not-a-key" } });
    expect(j.code).toBe(0);
    expect(Object.keys(j.json).sort()).toEqual(["choice", "config_pin", "ok", "route", "skipped"]);
    expect(j.json).toMatchObject({
      ok: true,
      choice: null,
      config_pin: null,
      skipped: [],
      route: {
        provider: "local",
        modelId: "r",
        providerName: "local",
        spec: FAKE_ROUTE_MODEL,
        thinking: null,
        source: "credential-order",
        pick: "newest",
        custom: false,
        movedFrom: null,
        priced: true,
        ask: false,
        credential: { kind: "api_key", origin: "models-json", subscription: false },
      },
    });
    expect(j.json.route!.alternatives).toEqual([
      expect.objectContaining({
        provider: BUILTIN,
        providerName: BUILTIN_NAME,
        credential: { kind: "api_key", origin: "env-key", label: BUILTIN_ENV, subscription: false },
      }),
    ]);
  });

  it("with no route: ok false, route null, the refusal's code and text, exit 1", async () => {
    const j = await runJson([], { models: { ...UNPINNED, model: "local/m" } });
    expect(j.code).toBe(1);
    expect(j.json.ok).toBe(false);
    expect(j.json.route).toBeNull();
    expect(j.json.config_pin).toBe("local/m");
    expect(j.json.refusal?.code).toBe("pin-unknown");
    expect(j.json.refusal?.text).toMatch(
      /^pi knows no model "local\/m" \(.+\)\. qcr model lists what is usable\.$/,
    );
    const none = await runJson([]);
    expect(none.json.refusal).toEqual({
      code: "no-credential",
      text: expect.stringContaining("`qcr login`") as unknown as string,
    });
  });

  it("carries the remembered choice and the config's pin as they are", async () => {
    withLocal();
    await run(["use", "local/m"]);
    const j = await runJson([], { models: { ...UNPINNED, model: "local/r:high" } });
    expect(j.json.choice).toEqual({
      provider: "local",
      model: "m",
      via: "use",
      no_estimate_ok: [],
    });
    expect(j.json.config_pin).toBe("local/r:high");
    // The config wins over the choice.
    expect(j.json.route).toMatchObject({ spec: "local/r", source: "config", thinking: "high" });
  });
});

describe("qcr model use", () => {
  // MUTATION: write the choice into the config home instead of pi's agent dir
  // — the file is not beside the logins and this fails.
  it("remembers a provider in pi's agent dir, and reviews then run on it", async () => {
    withLocal();
    const env = { [BUILTIN_ENV]: "not-a-key" };
    const r = await run(["use", BUILTIN], { env });
    expect(r.code).toBe(0);
    expect(r.out).toEqual([
      `remembered: ${BUILTIN}. Reviews on this pi run on it; qcr model reset makes the choice automatic again.`,
    ]);
    expect(choiceFile()).toEqual({
      version: 1,
      provider: BUILTIN,
      model: null,
      via: "use",
      no_estimate_ok: [],
    });
    expect(readdirSync(home).sort()).toEqual(["models.json", MODEL_CHOICE_FILE].sort());
    const now = await run([], { env });
    expect(now.out[0]).toMatch(new RegExp(`^model: ${BUILTIN}/`));
    expect(now.out[1]).toBe("  why: you chose it (qcr model use)");
  });

  it("with a model: pi reads the text, and the model runs though the pick rule would not take it", async () => {
    withLocal();
    const r = await run(["use", "local/m:high"]);
    expect(r.code).toBe(0);
    // The level is not part of the choice.
    expect(r.out[0]).toMatch(/^remembered: local\/m\. /);
    expect(choiceFile()).toMatchObject({ provider: "local", model: "m", via: "use" });
    const now = await run([]);
    expect(now.out.slice(0, 2)).toEqual(["model: local/m", "  why: you chose it (qcr model use)"]);
  });

  it("an id pi's catalog does not hold is kept and said to be sent as written", async () => {
    withLocal();
    const r = await run(["use", "local/my-own-deployment"]);
    expect(r.code).toBe(0);
    expect(r.out).toEqual([
      "remembered: local/my-own-deployment. Reviews on this pi run on it; qcr model reset makes the choice automatic again.",
      "note: my-own-deployment is not in pi's catalog for local: it is sent as written",
    ]);
    expect((await run([])).text).toContain(
      "  note: not in pi's catalog for local: sent as written",
    );
  });

  it("a provider pi does not know is a usage error, and nothing is written", async () => {
    withLocal();
    const r = await run(["use", "no-such-provider"]);
    expect(r.code).toBe(2);
    expect(r.err).toEqual([
      'qcr model: pi knows no provider "no-such-provider": qcr model lists the usable ones',
    ]);
    expect((await run(["use", "no-such-provider/x"])).code).toBe(2);
    expect((await run(["use", "local/"])).code).toBe(2);
    expect((await run(["use", "/m"])).code).toBe(2);
    expect(existsSync(join(home, MODEL_CHOICE_FILE))).toBe(false);
  });

  it("a provider pi knows and has no credential for yet is remembered, with how to sign in", async () => {
    withLocal();
    const r = await run(["use", BUILTIN]);
    expect(r.code).toBe(0);
    expect(r.out).toEqual([
      `remembered: ${BUILTIN}. Reviews on this pi run on it; qcr model reset makes the choice automatic again.`,
      `pi has no credential for ${BUILTIN} yet: qcr login ${BUILTIN}`,
    ]);
    // A stated choice holds like a pin: the next answer is its refusal.
    const now = await run([]);
    expect(now.code).toBe(1);
    expect(now.out[1]).toBe(
      `this review is pinned to ${BUILTIN} (qcr model use), and pi has no credential for ${BUILTIN}. Sign in with \`qcr login ${BUILTIN}\`, or drop the pin (qcr model reset).`,
    );
  });

  it("a provider none of whose models a review can run on is not remembered", async () => {
    writeFakeProvider(home, NOWHERE);
    const r = await run(["use", "local"]);
    expect(r.code).toBe(1);
    expect(r.err).toEqual([
      "qcr model: pi has a credential for local, but none of its models passes the review's filter (a model that reasons, 128k context). Name one: qcr model use <provider>/<id>",
    ]);
    expect(existsSync(join(home, MODEL_CHOICE_FILE))).toBe(false);
  });

  it("says when the config still pins another model", async () => {
    withLocal();
    const r = await run(["use", "local"], {
      models: { ...UNPINNED, model: "local/m" },
      configPath: "/etc/qcr/config.toml",
    });
    expect(r.code).toBe(0);
    expect(r.out[1]).toBe(
      "[models] model in /etc/qcr/config.toml still pins local/m: the config wins",
    );
  });

  // A person with a provider key in the environment who never ran pi has no
  // agent dir yet, and no config to pin in: the file is all there is.
  // MUTATION: drop the mkdirSync from store() in
  // packages/pi-plugin/src/modelchoice.ts — the write is ENOENT, the exit
  // status is 1 and this fails.
  it("pi's agent dir does not exist yet: it is made, and the choice is remembered", async () => {
    const fresh = join(dir, "never-ran-pi", "agent");
    const over = { agentDir: fresh, env: { [BUILTIN_ENV]: "not-a-key" } };
    expect((await run([], over)).code).toBe(0);
    expect(existsSync(fresh)).toBe(false);
    const r = await run(["use", BUILTIN], over);
    expect(r.err).toEqual([]);
    expect(r.code).toBe(0);
    expect(r.out).toEqual([
      `remembered: ${BUILTIN}. Reviews on this pi run on it; qcr model reset makes the choice automatic again.`,
    ]);
    expect(readdirSync(fresh)).toEqual([MODEL_CHOICE_FILE]);
    expect(statSync(fresh).mode & 0o777).toBe(0o700);
    expect(readModelChoice(fresh).choice).toMatchObject({ provider: BUILTIN, via: "use" });
    expect((await run([], over)).out[1]).toBe("  why: you chose it (qcr model use)");
  });

  it("keeps the no-estimate answers the file already holds", async () => {
    withLocal();
    writeFileSync(
      join(home, MODEL_CHOICE_FILE),
      JSON.stringify({ version: 1, no_estimate_ok: ["local/r"] }),
    );
    await run(["use", "local"]);
    expect(readModelChoice(home).choice).toEqual({
      provider: "local",
      model: null,
      via: "use",
      no_estimate_ok: ["local/r"],
    });
  });

  it("--json prints the state after the change", async () => {
    withLocal();
    const j = await runJson(["use", "local/m"]);
    expect(j.code).toBe(0);
    expect(j.json).toMatchObject({
      ok: true,
      route: { spec: "local/m", source: "choice" },
      choice: { provider: "local", model: "m", via: "use" },
    });
  });

  // The pi home may be mounted read-only. The sentence is the choice module's
  // own, and it names the pin as the way that still works.
  // MUTATION: report a failed writeModelChoice as success in src/modelcli.ts —
  // the exit status is 0 and this fails.
  it.skipIf(process.getuid?.() === 0)(
    "a directory that cannot be written says so and exits 1",
    async () => {
      withLocal();
      chmodSync(home, 0o500);
      try {
        const r = await run(["use", "local"]);
        expect(r.code).toBe(1);
        expect(r.out).toEqual([]);
        expect(r.err).toHaveLength(1);
        expect(r.err[0]).toMatch(
          new RegExp(
            `^qcr model: cannot remember the choice in ${home}: .+\\. Pin it instead: \\[models\\] model in config\\.toml$`,
          ),
        );
        // The route itself still resolves: reading needs no write.
        expect((await run([])).code).toBe(0);
      } finally {
        chmodSync(home, 0o700);
      }
    },
  );
});

describe("qcr model reset", () => {
  it("removes the file and says the route that is now automatic", async () => {
    withLocal();
    await run(["use", "local/m"]);
    expect(existsSync(join(home, MODEL_CHOICE_FILE))).toBe(true);
    const r = await run(["reset"]);
    expect(r.code).toBe(0);
    expect(r.out).toEqual([
      `forgot the remembered model. Now: model: ${FAKE_ROUTE_MODEL} (the provider pi has a credential for)`,
    ]);
    expect(existsSync(join(home, MODEL_CHOICE_FILE))).toBe(false);
  });

  it("with nothing remembered, and with no route, it still answers", async () => {
    const r = await run(["reset"]);
    expect(r.code).toBe(0);
    expect(r.out[0]).toBe("forgot the remembered model. Now: model: none");
    expect(r.out[1]).toMatch(/^pi has no model credential/);
    const j = await runJson(["reset"]);
    expect(j.code).toBe(0);
    expect(j.json).toMatchObject({ ok: false, route: null, choice: null });
  });

  it.skipIf(process.getuid?.() === 0)("a file it cannot remove is said, exit 1", async () => {
    withLocal();
    await run(["use", "local"]);
    chmodSync(home, 0o500);
    try {
      const r = await run(["reset"]);
      expect(r.code).toBe(1);
      expect(r.err[0]).toMatch(new RegExp(`^qcr model: cannot forget the choice in ${home}: `));
    } finally {
      chmodSync(home, 0o700);
    }
  });
});

// ---- the words every surface shares ---------------------------------------------

const KEY = {
  kind: "api_key",
  origin: "env-key",
  label: "ALPHA_API_KEY",
  subscription: false,
} as const;
const LOGIN = { kind: "oauth", origin: "stored", subscription: true } as const;

function route(over: Partial<ModelRoute> = {}): ModelRoute {
  return {
    provider: "alpha",
    modelId: "alpha-5.1",
    providerName: "Alpha",
    spec: "alpha/alpha-5.1",
    thinking: null,
    source: "only-credential",
    pick: "newest",
    piDefaultId: null,
    custom: false,
    movedFrom: null,
    credential: LOGIN,
    priced: true,
    ask: false,
    alternatives: [],
    notices: [],
    ...over,
  };
}

const alt = (provider: string, credential: ModelRoute["credential"]) => ({
  provider,
  providerName: provider[0]!.toUpperCase() + provider.slice(1),
  modelId: `${provider}-4.0`,
  spec: `${provider}/${provider}-4.0`,
  credential,
  priced: true,
});

// ---- the login a daemon was handed --------------------------------------------
//
// On a single box the daemon reviews on the host's login, mounted beside its
// own pi home: only the login moves, and with it the remembered choice and
// pi's saved provider (src/botworker.ts `workerRoute`). The verb is what the
// wizard asks in the daemon's container, so it reads the same directory.

describe("qcr model where the login is not in pi's agent dir", () => {
  let login: string;

  beforeEach(() => {
    login = join(dir, "login");
    mkdirSync(login, { recursive: true });
  });

  /** The only credential anywhere: a key stored by /login, in the login dir. */
  const storedKey = (): void =>
    writeFileSync(
      join(login, "auth.json"),
      JSON.stringify({ [BUILTIN]: { type: "api_key", key: "not-a-key" } }),
    );

  // MUTATION: borrow from `deps.agentDir` in resolve (src/modelcli.ts) — the
  // stored key is not seen, the built-in provider is gone from the answer and
  // this fails. Or hand routeHost the login dir as `srcAgentDir` — the catalog
  // of pi's own agent dir is not read, `local` is gone and this fails.
  it("the login is read from the login dir, the catalog from pi's agent dir", async () => {
    storedKey();
    withLocal();
    const usable = (j: ModelCliJson): Record<string, string> =>
      Object.fromEntries(
        (j.route ? [j.route, ...j.route.alternatives] : []).map((r) => [
          r.provider,
          r.credential.origin,
        ]),
      );
    const j = await runJson([], { loginDir: login });
    expect(j.code).toBe(0);
    expect(usable(j.json)).toEqual({ local: "models-json", [BUILTIN]: "stored" });
    expect(JSON.stringify(j.json)).not.toContain("not-a-key");
    // Asked of the agent dir alone, the login is not there.
    expect(usable((await runJson([])).json)).toEqual({ local: "models-json" });
    // With no catalog key either, the box's one credential is the login's.
    rmSync(join(home, "models.json"));
    const only = await runJson([], { loginDir: login });
    expect(only.json.route).toMatchObject({
      provider: BUILTIN,
      credential: { kind: "api_key", origin: "stored" },
    });
    const own = await runJson([]);
    expect(own.code).toBe(1);
    expect(own.json.refusal?.code).toBe("no-credential");
    // Neither directory was written to.
    expect(readdirSync(login)).toEqual(["auth.json"]);
    expect(readdirSync(home)).toEqual([]);
  });

  // MUTATION: write the choice with `deps.agentDir` in use (src/modelcli.ts)
  // — the file lands in the agent dir, where no worker reads it, and this fails.
  it("the remembered choice is written, read and removed beside the login", async () => {
    storedKey();
    const used = await run(["use", BUILTIN], { loginDir: login });
    expect(used.code).toBe(0);
    expect(existsSync(join(login, MODEL_CHOICE_FILE))).toBe(true);
    expect(existsSync(join(home, MODEL_CHOICE_FILE))).toBe(false);
    expect(readModelChoice(login).choice).toMatchObject({ provider: BUILTIN, via: "use" });
    const now = await run([], { loginDir: login });
    expect(now.out[1]).toBe("  why: you chose it (qcr model use)");
    const reset = await run(["reset"], { loginDir: login });
    expect(reset.code).toBe(0);
    expect(existsSync(join(login, MODEL_CHOICE_FILE))).toBe(false);
  });

  it("a refusal names the directory the login is read from", async () => {
    const r = await run([], { loginDir: login });
    expect(r.code).toBe(1);
    expect(r.out[1]).toContain(`(agent dir ${login})`);
  });
});

// ---- the verb as a process runs it ---------------------------------------------
//
// `runModelCli` is where the environment becomes directories. Each case gives
// the whole environment: a scratch HOME and XDG homes, so the install's config
// is the shipped defaults and nothing of the person running the suite counts.

describe("qcr model for a process: which directories its environment names", () => {
  let agent: string;

  beforeEach(() => {
    agent = join(dir, "container-pi", "agent");
    mkdirSync(agent, { recursive: true });
  });

  const envOf = (over: Record<string, string> = {}): NodeJS.ProcessEnv => ({
    HOME: join(dir, "user"),
    XDG_CONFIG_HOME: join(dir, "xdg-config"),
    XDG_STATE_HOME: join(dir, "xdg-state"),
    PI_CODING_AGENT_DIR: agent,
    ...over,
  });

  async function asProcess(env: NodeJS.ProcessEnv): Promise<ModelCliJson> {
    const out: string[] = [];
    await runModelCli([], true, env, { out: (l) => out.push(l), err: () => {} });
    expect(out).toHaveLength(1);
    return JSON.parse(out[0]!) as ModelCliJson;
  }

  // The wizard's model step asks this in the daemon's container
  // (src/onboard/steps/llmauth.ts), whose environment the compose file gives
  // QCR_LOGIN_DIR on a box that shares the host's login.
  // MUTATION: drop `loginDir: loginDirOf(env, agentDir)` from runModelCli's
  // deps (src/modelcli.ts) — the verb asks the container's own pi home, which
  // holds no login, answers no-credential and this fails.
  it("QCR_LOGIN_DIR names the login the daemon reviews on: the verb answers for that one", async () => {
    expect(LOGIN_DIR_ENV).toBe("QCR_LOGIN_DIR");
    // The mount, as the container sees it: the one login on the box.
    const shared = join(dir, CONTAINER_LOGIN_DIR);
    mkdirSync(shared, { recursive: true });
    writeFileSync(
      join(shared, "auth.json"),
      JSON.stringify({ [BUILTIN]: { type: "api_key", key: "not-a-key" } }),
    );
    const handed = await asProcess(envOf({ [LOGIN_DIR_ENV]: shared }));
    expect(handed.ok).toBe(true);
    expect(handed.route).toMatchObject({
      provider: BUILTIN,
      credential: { kind: "api_key", origin: "stored" },
    });
    // A daemon that is handed none keeps the login of its own pi home: the
    // compose file sets the variable empty then.
    for (const none of [envOf(), envOf({ [LOGIN_DIR_ENV]: "" })]) {
      const own = await asProcess(none);
      expect(own.ok).toBe(false);
      expect(own.refusal?.code).toBe("no-credential");
    }
  });

  // The same question on a bot whose only credential is a login shorter than
  // a review: its workers run on it while the refresher renews it, so the
  // daemon's answer is a route, not "sign in again".
  // MUTATION: drop `owner` from runModelCli's deps (src/modelcli.ts) — the
  // verb answers login-too-short beside a healthy refresher and this fails.
  it("a short login beside a refresher that works is the daemon's route; with the refresher off, gone or failing it is not", async () => {
    const config = join(dir, "xdg-config", "qcr", "default", "config.toml");
    const example = readFileSync(join(process.cwd(), "config.example.toml"), "utf8");
    const off = "[login_refresh]\nenabled = false";
    expect(example).toContain(off);
    const withRefresher = (enabled: boolean): void => {
      mkdirSync(join(config, ".."), { recursive: true });
      writeFileSync(config, example.replace(off, `[login_refresh]\nenabled = ${enabled}`));
    };
    writeFileSync(
      join(agent, "auth.json"),
      JSON.stringify({
        [SIGN_IN]: { type: "oauth", access: "a", refresh: "r", expires: Date.now() + 20 * 60_000 },
      }),
    );
    const status = (over: Record<string, unknown> = {}): void =>
      writeFileSync(
        join(agent, LOGIN_STATUS_FILE),
        JSON.stringify({
          pid: process.pid,
          checked_at: new Date().toISOString(),
          paused: false,
          last_error: null,
          ...over,
        }),
      );
    withRefresher(true);
    status();
    const owned = await asProcess(envOf());
    expect(owned.ok).toBe(true);
    expect(owned.route).toMatchObject({ provider: SIGN_IN, credential: { kind: "oauth" } });
    // failing, or paused for a sign-in: it renews nothing
    status({ last_error: "refresh refused" });
    expect((await asProcess(envOf())).refusal?.code).toBe("login-too-short");
    status({ paused: true });
    expect((await asProcess(envOf())).refusal?.code).toBe("login-too-short");
    // no status file
    rmSync(join(agent, LOGIN_STATUS_FILE));
    expect((await asProcess(envOf())).refusal?.code).toBe("login-too-short");
    // a healthy file the config does not stand behind
    status();
    withRefresher(false);
    expect((await asProcess(envOf())).refusal?.code).toBe("login-too-short");
    // and the shipped defaults: no daemon runs on those
    rmSync(config);
    expect((await asProcess(envOf())).refusal?.code).toBe("login-too-short");
  });

  it("refresherOwnsLogin: the config's switch and the refresher's own file, both", async () => {
    const toml = (enabled: boolean): string => `[login_refresh]\nenabled = ${enabled}\n`;
    writeFileSync(
      join(agent, LOGIN_STATUS_FILE),
      JSON.stringify({
        pid: 4242,
        checked_at: new Date(NOW).toISOString(),
        paused: false,
        last_error: null,
      }),
    );
    const ask = (o: Partial<Parameters<typeof refresherOwnsLogin>[0]>): Promise<boolean> =>
      refresherOwnsLogin({ toml: toml(true), loginDir: agent, now: NOW, alive: () => true, ...o });
    expect(await ask({})).toBe(true);
    expect(await ask({ alive: () => false })).toBe(false);
    expect(await ask({ toml: toml(false) })).toBe(false);
    expect(await ask({ toml: "" })).toBe(false);
    expect(await ask({ toml: null })).toBe(false);
    expect(await ask({ loginDir: join(dir, "nowhere") })).toBe(false);
    expect(await ask({ now: NOW + 60 * 60_000 })).toBe(false);
  });

  // A worker's process inherits an allowlist of the daemon's environment and
  // the secrets dir's model env (src/workersupervisor.ts `workerProcessEnv`):
  // a provider key given to the container itself (compose `environment:`,
  // `docker run -e`) reaches no worker, so it is no route for the daemon.
  // MUTATION: hand deps the whole `env` in runModelCli whatever
  // inDaemonContainer says (src/modelcli.ts) - the verb names a route no
  // worker can run on, the wizard's model step goes green, and this fails.
  it("in a daemon's container a provider key only in the environment is no route; the same key under model-env/ is", async () => {
    const secrets = join(dir, "mounted-secrets");
    const keyed = { [BUILTIN_ENV]: "not-a-key", QC_SECRETS_DIR: secrets };
    // On a host the process's environment counts, as it does for a review.
    const host = await asProcess(envOf(keyed));
    expect(host.route).toMatchObject({ provider: BUILTIN, credential: { label: BUILTIN_ENV } });
    expect(inDaemonContainer(envOf(keyed))).toBe(false);
    const inside = envOf({ ...keyed, QCR_SECRETS_MOUNT: secrets });
    expect(inDaemonContainer(inside)).toBe(true);
    const none = await asProcess(inside);
    expect(none.ok).toBe(false);
    expect(none.refusal?.code).toBe("no-credential");
    mkdirSync(join(secrets, MODEL_ENV_DIR), { recursive: true });
    writeFileSync(join(secrets, MODEL_ENV_DIR, BUILTIN_ENV), "value-from-the-secrets-dir\n");
    const now = await asProcess(inside);
    expect(now.ok).toBe(true);
    expect(now.route).toMatchObject({
      provider: BUILTIN,
      credential: { origin: "env-key", label: BUILTIN_ENV },
    });
  });

  // The step tells the person where a provider key goes
  // (`secretsDirFor`, the wizards' one resolution) and then asks this verb
  // whether pi has a credential: the two must reach one directory, also
  // before any config names a secrets dir, when only `$QC_SECRETS_DIR` does.
  // MUTATION: drop `secretsOverride` from runModelCli's loadOneShotConfig call
  // (src/modelcli.ts) — the verb reads `<config home>/secrets`, the key the
  // step asked for is not seen and this fails.
  it("QC_SECRETS_DIR: a key put where the wizard's step says is the key the verb reads", async () => {
    const env = envOf({ QC_SECRETS_DIR: join(dir, "wizard-secrets") });
    // The step's side: no config.toml yet, no recorded choice.
    const paths = {
      stateDir: join(dir, "checkout", "state"),
      configPath: join(dir, "xdg-config", "qcr", "default", "config.toml"),
    };
    const said = secretsDirFor({ paths } as OnboardAdapters, {}, env);
    expect(said).toBe(join(dir, "wizard-secrets"));
    expect((await asProcess(env)).refusal?.code).toBe("no-credential");
    mkdirSync(join(said, MODEL_ENV_DIR), { recursive: true });
    writeFileSync(join(said, MODEL_ENV_DIR, BUILTIN_ENV), "value-from-the-secrets-dir\n");
    const now = await asProcess(env);
    expect(now.ok).toBe(true);
    expect(now.route).toMatchObject({
      provider: BUILTIN,
      credential: { origin: "env-key", label: BUILTIN_ENV },
    });
    expect(JSON.stringify(now)).not.toContain("value-from-the-secrets-dir");
    // With no override, the install's own secrets dir is the one read.
    expect((await asProcess(envOf())).ok).toBe(false);
  });
});

describe("routeNotice: one line that names the route, why, and how to change it", () => {
  it("each way a route comes about has its own words", () => {
    const head = (over: Partial<ModelRoute>, surface: "app" | "plugin" = "app"): string =>
      routeNoticeLines(route(over), surface)[0]!;
    expect(head({ source: "flag", pick: "pinned" })).toBe(
      "model: alpha/alpha-5.1 (pinned by --model)",
    );
    expect(head({ source: "config", pick: "pinned" })).toBe(
      "model: alpha/alpha-5.1 (pinned by [models] model)",
    );
    expect(head({ source: "choice" })).toBe(
      "model: alpha/alpha-5.1 (your choice; qcr model use <provider[/model]> changes it)",
    );
    expect(head({ source: "remembered" })).toBe(
      "model: alpha/alpha-5.1 (you picked Alpha when asked; qcr model use <provider[/model]> changes it)",
    );
    expect(head({ source: "only-credential" })).toBe(
      "model: alpha/alpha-5.1 (the provider pi has a credential for)",
    );
  });

  // MUTATION: say "qcr model use" on the plugin surface in CHANGE_IT — a person
  // inside pi is told a command pi does not have, and this fails.
  it("the way to change it is the surface's own", () => {
    const r = route({ source: "remembered" });
    expect(routeNotice(r, "plugin")).toBe(
      "model: alpha/alpha-5.1 (you picked Alpha when asked; /qcr-setup model changes it)",
    );
    expect(routeNotice(r, "plugin")).not.toMatch(/qcr model/);
    expect(routeNotice(r, "app")).not.toMatch(/qcr-setup/);
  });

  it("picked among several: how many, and what decided", () => {
    const several = (over: Partial<ModelRoute>, surface: "app" | "plugin" = "app"): string =>
      routeNotice(route({ source: "credential-order", ...over }), surface);
    expect(several({ alternatives: [alt("beta", KEY)] })).toBe(
      "model: alpha/alpha-5.1 (picked among 2 providers pi has credentials for: a stored login comes first). Change it: qcr model use <provider[/model]>, or --model for one run",
    );
    expect(
      several({
        credential: KEY,
        alternatives: [alt("beta", { kind: "api_key", origin: "ambient", subscription: false })],
      }),
    ).toMatch(/pi has credentials for: an environment key comes first\)/);
    expect(
      several({
        credential: { kind: "api_key", origin: "models-json", subscription: false },
        alternatives: [alt("beta", KEY)],
      }),
    ).toMatch(/: a key pi holds comes first\)/);
    expect(several({ alternatives: [alt("beta", LOGIN), alt("gamma", KEY)] })).toMatch(
      /picked among 3 providers pi has credentials for: it has the newest model\)/,
    );
    const piProvider = { source: "pi-provider", alternatives: [alt("beta", LOGIN)] } as const;
    expect(several(piProvider)).toMatch(/: pi itself starts on Alpha\)/);
    expect(several(piProvider, "plugin")).toMatch(
      /: this pi session is on Alpha\)\. Change it: \/qcr-setup model, or --model for one run$/,
    );
  });

  it("what else is worth saying once is appended, each fact once", () => {
    expect(routeNotice(route({ piDefaultId: "alpha-4.8" }), "app")).toBe(
      "model: alpha/alpha-5.1 (the provider pi has a credential for). pi's own default there is alpha-4.8: qcr model use alpha/alpha-4.8",
    );
    expect(routeNotice(route({ piDefaultId: "alpha-4.8" }), "plugin")).toMatch(
      /pi's own default there is alpha-4\.8: --model alpha\/alpha-4\.8$/,
    );
    expect(
      routeNotice(
        route({
          source: "config",
          pick: "pinned",
          custom: true,
          modelId: "dep",
          spec: "alpha/dep",
        }),
        "app",
      ),
    ).toBe(
      "model: alpha/dep (pinned by [models] model). not in pi's catalog for Alpha: sent as written",
    );
    // A cloud identity the shell happens to carry is named before anything is spent.
    expect(
      routeNotice(
        route({
          credential: {
            kind: "api_key",
            origin: "ambient",
            label: "AWS_PROFILE",
            subscription: false,
          },
        }),
        "app",
      ),
    ).toMatch(/\. credential: AWS_PROFILE$/);
    expect(routeNotice(route({ credential: KEY }), "app")).not.toMatch(/credential:/);
  });

  it("a pin that moved says where it runs and which provider had no credential", () => {
    const moved = route({ source: "config", pick: "pinned", movedFrom: "alpha-legacy" });
    expect(routeNotice(moved, "app")).toBe(
      "model: alpha-5.1 runs on Alpha: alpha-legacy, which the config names, has no credential here",
    );
    expect(routeNotice({ ...moved, source: "flag" }, "app")).toMatch(/, which --model names, /);
  });

  it("the route's own notices follow, a line each", () => {
    const notices = [
      "skipped Beta: its login expires at 14:25 and nothing here renews it",
      "pi's default for alpha could not be read: picked by version only",
    ];
    expect(routeNoticeLines(route({ notices }), "app")).toEqual([
      "model: alpha/alpha-5.1 (the provider pi has a credential for)",
      ...notices,
    ]);
    expect(routeNotice(route({ notices }), "app").split("\n")).toHaveLength(3);
  });
});

describe("the route in phrases: why, how it was picked, the credential", () => {
  it("routeWhy has a phrase per source", () => {
    const why = (over: Partial<ModelRoute>, surface: "app" | "plugin" = "app"): string =>
      routeWhy(route(over), surface, { configPath: "/c/config.toml" });
    expect(why({ source: "flag" })).toBe("--model on this run");
    expect(why({ source: "config" })).toBe("pinned by [models] model in /c/config.toml");
    expect(why({ source: "config", movedFrom: "alpha-legacy" })).toBe(
      "pinned by [models] model in /c/config.toml; it runs on Alpha, since pi has no credential for alpha-legacy",
    );
    expect(why({ source: "choice" })).toBe("you chose it (qcr model use)");
    expect(why({ source: "choice" }, "plugin")).toBe("you chose it (/qcr-setup model)");
    expect(why({ source: "remembered" })).toBe("you picked it when asked");
    expect(why({ source: "only-credential" })).toBe(
      "the one provider pi has a usable credential for",
    );
    expect(why({ source: "pi-provider", alternatives: [alt("beta", LOGIN)] })).toBe(
      "pi has credentials for 2 providers; pi itself starts on Alpha",
    );
    expect(why({ source: "credential-order", alternatives: [alt("beta", KEY)] })).toBe(
      "a stored login comes first",
    );
    expect(why({ source: "credential-order", alternatives: [alt("beta", LOGIN)] })).toBe(
      "the newest model among 2 providers",
    );
    expect(routeWhy(route({ source: "config" }), "app")).toBe("pinned by [models] model");
  });

  it("routePicked says how the model was picked, and nothing for one that was named", () => {
    expect(routePicked(route({ pick: "pinned" }))).toBeNull();
    expect(routePicked(route())).toBe("the newest version on Alpha");
    expect(routePicked(route({ piDefaultId: "alpha-4.8" }))).toBe(
      "the newest version on Alpha (pi's own default there: alpha-4.8)",
    );
    expect(routePicked(route({ pick: "pi-default" }))).toBe("pi's default on Alpha");
  });

  it("credentialWords says where pi found it, by pi's own label for an environment", () => {
    expect(credentialWords(LOGIN)).toBe("signed in with pi (subscription)");
    expect(credentialWords({ ...LOGIN, subscription: false })).toBe("signed in with pi");
    expect(credentialWords({ kind: "api_key", origin: "stored", subscription: false })).toBe(
      "an API key stored in pi",
    );
    expect(credentialWords({ kind: "api_key", origin: "models-json", subscription: false })).toBe(
      "a key in pi's models.json",
    );
    expect(credentialWords({ kind: "api_key", origin: "runtime", subscription: false })).toBe(
      "a key handed to pi for this run",
    );
    expect(credentialWords(KEY)).toBe("ALPHA_API_KEY");
    expect(
      credentialWords({
        kind: "api_key",
        origin: "ambient",
        label: "AWS_PROFILE",
        subscription: false,
      }),
    ).toBe("AWS_PROFILE");
    expect(credentialWords({ kind: "api_key", origin: "ambient", subscription: false })).toBe(
      "an ambient credential",
    );
  });
});

describe("refusalText: five refusals, each with what to do", () => {
  const AT = Date.UTC(2026, 0, 15, 12, 0, 0);
  const facts = { agentDir: "/pi/agent", needMs: 60 * 60_000, now: () => AT };
  const login = (minutes: number, name = "Beta") => ({
    provider: name.toLowerCase(),
    name,
    expiresAt: AT + minutes * 60_000,
  });

  // The host skills key on `qcr login` and `/login` in these two texts.
  // MUTATION: drop "`qcr login`" from the app's no-credential text — this fails.
  it("no-credential names the login verb of its surface", () => {
    expect(refusalText({ code: "no-credential" }, "app", facts)).toBe(
      "pi has no model credential (agent dir /pi/agent). Run `qcr login` and sign in to any provider, or set a provider's API key in the environment, then run this again.",
    );
    expect(refusalText({ code: "no-credential" }, "plugin", facts)).toBe(
      "pi has no model credential. Run /login in pi, then /qcr-review again.",
    );
    expect(refusalText({ code: "no-credential" }, "app")).toMatch(/^pi has no model credential\. /);
  });

  it("login-too-short says when it expires, against which budget, and what works", () => {
    const text = refusalText({ code: "login-too-short", logins: [login(20)] }, "app", facts);
    expect(text).toMatch(
      /^your Beta login expires at \d\d:\d\d, inside this review's 60-minute budget, and nothing here renews it\. Run the review inside pi \(\/qcr-review\), where pi renews it, or use another credential: `qcr login`, or a provider key in the environment\.$/,
    );
    // pi renews a login only inside its last five minutes, and only when it is opened.
    expect(refusalText({ code: "login-too-short", logins: [login(3)] }, "app", facts)).toMatch(
      /in the environment\. Open pi once and it renews the login\.$/,
    );
    // MUTATION: require `l.expiresAt > now` for `renewable` in refusalText -
    // an expired login, which pi renews when opened as it does one in its last
    // minutes, loses the sentence; this fails.
    expect(refusalText({ code: "login-too-short", logins: [login(-5)] }, "app", facts)).toMatch(
      /^your Beta login expired at \d\d:\d\d and nothing here renews it\. .* Open pi once and it renews the login\.$/,
    );
    expect(
      refusalText(
        { code: "login-too-short", logins: [login(20), login(30, "Gamma")] },
        "app",
        facts,
      ),
    ).toMatch(
      /^your Beta login expires at \d\d:\d\d and your Gamma login expires at \d\d:\d\d, inside /,
    );
    // Inside pi there is no "run it inside pi" to say.
    const inside = refusalText({ code: "login-too-short", logins: [login(3)] }, "plugin", facts);
    expect(inside).toMatch(/budget, and pi did not renew it\. Sign in again with \/login, /);
    expect(inside).not.toMatch(/qcr login|inside pi|Open pi/);
  });

  it("no-model names the providers and how to name a model", () => {
    const refusal = { code: "no-model", providers: ["alpha", "beta"] } as const;
    const nameOf = (p: string): string => p.toUpperCase();
    expect(refusalText(refusal, "app", { nameOf })).toBe(
      "pi has a credential for ALPHA and BETA, but none of their models passes the review's filter (a model that reasons, 128k context). Name one: qcr model use <provider>/<id>",
    );
    expect(refusalText({ code: "no-model", providers: ["alpha"] }, "plugin")).toBe(
      "pi has a credential for alpha, but none of its models passes the review's filter (a model that reasons, 128k context). Name one: --model <provider>/<id>, or [models] model",
    );
  });

  it("pin-no-credential names what pinned it, how to sign in and how to drop the pin", () => {
    const pin = { code: "pin-no-credential", pin: "alpha/alpha-5.1", provider: "alpha" } as const;
    expect(refusalText({ ...pin, from: "flag", candidates: [] }, "app")).toBe(
      "this review is pinned to alpha/alpha-5.1 (--model), and pi has no credential for alpha. Sign in with `qcr login alpha`, or drop the pin (omit --model).",
    );
    expect(
      refusalText({ ...pin, from: "config", candidates: [] }, "app", {
        configPath: "/c/config.toml",
      }),
    ).toBe(
      "this review is pinned to alpha/alpha-5.1 ([models] model in /c/config.toml), and pi has no credential for alpha. Sign in with `qcr login alpha`, or drop the pin (remove model from [models]).",
    );
    expect(refusalText({ ...pin, from: "choice", candidates: [] }, "app")).toMatch(
      /\(qcr model use\), .* or drop the pin \(qcr model reset\)\.$/,
    );
    expect(refusalText({ ...pin, from: "choice", candidates: [] }, "plugin")).toBe(
      "this review is pinned to alpha/alpha-5.1 (/qcr-setup model), and pi has no credential for alpha. Sign in with /login in pi, or drop the pin (/qcr-setup model).",
    );
    // Several unrelated providers serve the id: the run does not guess.
    expect(refusalText({ ...pin, from: "flag", candidates: ["beta", "gamma"] }, "app")).toMatch(
      /\(omit --model\)\. alpha-5\.1 is also served by beta, gamma: name one\.$/,
    );
  });

  it("pin-unknown carries pi's own first sentence", () => {
    const refusal = {
      code: "pin-unknown",
      pin: "nope",
      detail: 'Model "nope" not found.',
    } as const;
    expect(refusalText(refusal, "app")).toBe(
      'pi knows no model "nope" (Model "nope" not found). qcr model lists what is usable.',
    );
    expect(refusalText(refusal, "plugin")).toMatch(
      /\)\. \/qcr-setup model lists what is usable\.$/,
    );
  });
});
