// The remembered model choice (packages/pi-plugin/src/modelchoice.ts): one
// file beside pi's logins, read without ever throwing and written aside and
// renamed. Every case runs in a temp agent dir.
import {
  chmodSync,
  existsSync,
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
import {
  MODEL_CHOICE_FILE,
  allowNoEstimate,
  clearModelChoice,
  readModelChoice,
  writeModelChoice,
} from "@quickchatai/pi-quickreview/src/modelchoice.js";

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "model-choice-"));
  file = join(dir, MODEL_CHOICE_FILE);
});

afterEach(() => {
  chmodSync(dir, 0o700);
  rmSync(dir, { recursive: true, force: true });
});

const stored = (): unknown => JSON.parse(readFileSync(file, "utf8"));

describe("the remembered model choice", () => {
  it("is one file, named so the write veto can name it", () => {
    expect(MODEL_CHOICE_FILE).toBe("qcr-model.json");
  });

  it("nothing stored reads as nothing remembered, with no notice", () => {
    expect(readModelChoice(dir)).toEqual({ noEstimateOk: [] });
    expect(readModelChoice(join(dir, "no-such-dir"))).toEqual({ noEstimateOk: [] });
  });

  it("the answer to a question round-trips as a provider with no model", () => {
    expect(writeModelChoice(dir, { provider: "alpha", model: null, via: "ask" })).toEqual({
      ok: true,
    });
    expect(stored()).toEqual({
      version: 1,
      provider: "alpha",
      model: null,
      via: "ask",
      no_estimate_ok: [],
    });
    expect(readModelChoice(dir)).toEqual({
      choice: { provider: "alpha", model: null, via: "ask", no_estimate_ok: [] },
      noEstimateOk: [],
    });
  });

  it("a stated choice keeps the model the person named", () => {
    writeModelChoice(dir, { provider: "alpha", model: "alpha-5.1", via: "use" });
    expect(readModelChoice(dir).choice).toEqual({
      provider: "alpha",
      model: "alpha-5.1",
      via: "use",
      no_estimate_ok: [],
    });
  });

  // MUTATION: store `choice.model` as given for `via: "ask"` — a model rides
  // in on a preference and this fails.
  it("an answer to a question never carries a model, written or read", () => {
    writeModelChoice(dir, { provider: "alpha", model: "alpha-5.1", via: "ask" });
    expect(stored()).toMatchObject({ model: null });
    writeFileSync(
      file,
      JSON.stringify({ version: 1, provider: "alpha", model: "alpha-5.1", via: "ask" }),
    );
    expect(readModelChoice(dir).choice).toMatchObject({ model: null, via: "ask" });
  });

  // MUTATION: write the file in place with the default mode — the mode
  // expectation fails; leave the `.tmp` behind and the listing fails.
  it("is written aside and renamed into place, readable by its owner alone", () => {
    writeModelChoice(dir, { provider: "alpha", model: null, via: "use" });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir)).toEqual([MODEL_CHOICE_FILE]);
    expect(readFileSync(file, "utf8").endsWith("\n")).toBe(true);
  });

  // A machine that has a provider key in the environment and never ran pi
  // has no agent dir yet.
  // MUTATION: drop the mkdirSync from store() — the write is ENOENT and this fails.
  it("an agent dir that does not exist yet is made, for its owner alone", () => {
    const fresh = join(dir, "never-ran-pi", "agent");
    expect(writeModelChoice(fresh, { provider: "alpha", model: null, via: "ask" })).toEqual({
      ok: true,
    });
    expect(statSync(fresh).mode & 0o777).toBe(0o700);
    expect(readdirSync(fresh)).toEqual([MODEL_CHOICE_FILE]);
    expect(readModelChoice(fresh).choice).toMatchObject({ provider: "alpha", via: "ask" });
    const other = join(dir, "another", "agent");
    expect(allowNoEstimate(other, "alpha/a")).toEqual({ ok: true });
    expect(readModelChoice(other).noEstimateOk).toEqual(["alpha/a"]);
  });

  it("the no-estimate answers are kept beside the choice, and survive a new choice", () => {
    expect(allowNoEstimate(dir, "alpha/alpha-5.1")).toEqual({ ok: true });
    // No choice yet: the file holds the answers alone.
    expect(stored()).toEqual({ version: 1, no_estimate_ok: ["alpha/alpha-5.1"] });
    expect(readModelChoice(dir)).toEqual({ noEstimateOk: ["alpha/alpha-5.1"] });

    writeModelChoice(dir, { provider: "beta", model: null, via: "ask" });
    allowNoEstimate(dir, "beta/beta-6.0");
    allowNoEstimate(dir, "beta/beta-6.0");
    expect(readModelChoice(dir)).toEqual({
      choice: {
        provider: "beta",
        model: null,
        via: "ask",
        no_estimate_ok: ["alpha/alpha-5.1", "beta/beta-6.0"],
      },
      noEstimateOk: ["alpha/alpha-5.1", "beta/beta-6.0"],
    });
    // A choice that brings its own answers replaces them.
    writeModelChoice(dir, { provider: "beta", model: null, via: "use", no_estimate_ok: [] });
    expect(readModelChoice(dir).noEstimateOk).toEqual([]);
  });

  it("forgetting removes the choice and the answers, and forgetting nothing is fine", () => {
    writeModelChoice(dir, { provider: "alpha", model: null, via: "use" });
    allowNoEstimate(dir, "alpha/alpha-5.1");
    expect(clearModelChoice(dir)).toEqual({ ok: true });
    expect(existsSync(file)).toBe(false);
    expect(readModelChoice(dir)).toEqual({ noEstimateOk: [] });
    expect(clearModelChoice(dir)).toEqual({ ok: true });
  });

  // MUTATION: let JSON.parse throw out of readModelChoice — the first row fails.
  it.each([
    ["not JSON", "{oops", /was not used: .+/],
    ["not an object", "[1]", /it is not a JSON object/],
    [
      "another version",
      JSON.stringify({ version: 2, provider: "alpha", via: "use" }),
      /version is 2, not 1/,
    ],
    [
      "no version",
      JSON.stringify({ provider: "alpha", via: "use" }),
      /version is undefined, not 1/,
    ],
  ])("a file that is %s reads as nothing remembered, with a notice", (_what, text, notice) => {
    writeFileSync(file, text);
    const read = readModelChoice(dir);
    expect(read.choice).toBeUndefined();
    expect(read.noEstimateOk).toEqual([]);
    expect(read.notice).toMatch(notice);
    expect(read.notice).toContain(file);
  });

  it.each([
    ["a provider that is not a name", { provider: 7, via: "use" }, /provider is not a name/],
    ["an empty provider", { provider: " ", via: "use" }, /provider is not a name/],
    ["no way it was said", { provider: "alpha" }, /neither "ask" nor "use"/],
    [
      "a model that is not a name",
      { provider: "alpha", via: "use", model: 5 },
      /model is not a name/,
    ],
  ])("a choice with %s is not used, and the answers beside it still are", (_what, body, notice) => {
    writeFileSync(
      file,
      JSON.stringify({ version: 1, ...body, no_estimate_ok: ["alpha/a", 3, ""] }),
    );
    const read = readModelChoice(dir);
    expect(read.choice).toBeUndefined();
    expect(read.noEstimateOk).toEqual(["alpha/a"]);
    expect(read.notice).toMatch(notice);
  });

  // MUTATION: throw from writeModelChoice when the directory refuses the
  // write — the run that could not remember dies and this fails.
  it("a directory that cannot be written says so in a sentence and throws nothing", () => {
    if (process.getuid?.() === 0) return; // root writes anywhere: the case cannot be made
    chmodSync(dir, 0o500);
    const result = writeModelChoice(dir, { provider: "alpha", model: null, via: "ask" });
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({
      error: expect.stringMatching(
        /^cannot remember the choice in .+: .+\. Pin it instead: \[models\] model in config\.toml$/,
      ),
    });
    expect((result as { error: string }).error).toContain(dir);
    expect(allowNoEstimate(dir, "alpha/a").ok).toBe(false);
    expect(readdirSync(dir)).toEqual([]);
  });
});
