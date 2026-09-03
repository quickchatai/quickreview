// the STRUCTURAL half of the choice-key fix: a cheap, no-I/O check
// that catches a fourth key drift before anyone runs anything.
//
// The defect this file exists to make impossible: the GitHub App step read the
// reviewed repo under "github_repo", a key NO step ever wrote, and its own
// suite stayed green because it injected that key directly. Two rules close it,
// and this file is where they are enforced:
//
//   1. every shared key lives in ONE declaration (src/onboard/choices.ts) and
//      no step carries its own string literal for one;
//   2. every declared key is genuinely WRITTEN by the step(s) CHOICE_WRITERS
//      names — a key that is only ever read cannot survive.
//
// It reads the step SOURCES rather than running them, so it costs nothing and
// fails with the file and the key in the message.
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CHOICE_KEYS,
  CHOICE_WRITERS,
  PRIVATE_CHOICE_KEYS,
  type ChoiceName,
} from "../src/onboard/choices.js";
import { defaultSteps } from "../src/onboard/steps/index.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const stepsDir = join(repoRoot, "src", "onboard", "steps");

interface StepSource {
  file: string;
  text: string;
  /** The step id this file declares, when it declares one. */
  stepId: string | null;
}

const sources: StepSource[] = readdirSync(stepsDir)
  .filter((f) => f.endsWith(".ts") && f !== "index.ts")
  .map((f) => {
    const text = readFileSync(join(stepsDir, f), "utf8");
    const declared = /_STEP_ID = "([a-z][a-z0-9_]*)"/.exec(text);
    return { file: `src/onboard/steps/${f}`, text, stepId: declared?.[1] ?? null };
  });

function sourceFor(stepId: string): StepSource {
  const found = sources.find((s) => s.stepId === stepId);
  if (!found) throw new Error(`no step source declares the step id "${stepId}"`);
  return found;
}

describe("every shared choice key is written by a step", () => {
  it("CHOICE_WRITERS covers every declared key, with a real step id", () => {
    const registered = new Set(defaultSteps().map((s) => s.id));
    for (const name of Object.keys(CHOICE_KEYS) as ChoiceName[]) {
      const writers = CHOICE_WRITERS[name];
      expect(
        writers,
        `CHOICE_KEYS.${name} has no writer — a key nothing writes is the defect`,
      ).toBeDefined();
      expect(writers.length, `CHOICE_KEYS.${name} has an EMPTY writer list`).toBeGreaterThan(0);
      for (const id of writers) {
        expect(
          registered.has(id),
          `CHOICE_WRITERS.${name} names "${id}", which is not a registered step`,
        ).toBe(true);
      }
    }
  });

  it("each named writer really records the key", () => {
    // The assertion that would have failed on the day the bug landed: the App
    // step read CHOICE_KEYS.repo and no source contained a matching write.
    for (const name of Object.keys(CHOICE_KEYS) as ChoiceName[]) {
      for (const id of CHOICE_WRITERS[name]) {
        const src = sourceFor(id);
        expect(
          src.text.includes(`recordChoice(CHOICE_KEYS.${name},`),
          `${src.file} is named as a writer of CHOICE_KEYS.${name} ("${CHOICE_KEYS[name]}") but never records it`,
        ).toBe(true);
      }
    }
  });

  it("every key a step READS is declared and has a writer", () => {
    // TypeScript already rejects an undeclared CHOICE_KEYS.x; what it cannot
    // see is a key that is read but never written by anything.
    const used = new Set<string>();
    for (const src of sources) {
      for (const m of src.text.matchAll(/CHOICE_KEYS\.([A-Za-z]+)/g)) used.add(m[1]!);
    }
    expect(
      used.size,
      "no step references CHOICE_KEYS at all — did the shared declaration get bypassed?",
    ).toBeGreaterThan(5);
    for (const name of used) {
      expect(
        Object.keys(CHOICE_KEYS),
        `a step names CHOICE_KEYS.${name}, which is not declared`,
      ).toContain(name);
      expect(
        CHOICE_WRITERS[name as ChoiceName]?.length ?? 0,
        `CHOICE_KEYS.${name} is read but nothing writes it`,
      ).toBeGreaterThan(0);
    }
  });
});

describe("no step carries its own string literal for a shared key", () => {
  it("no step writes a choice under a literal key", () => {
    for (const src of sources) {
      expect(
        src.text,
        `${src.file}: recordChoice("…") — a literal write is how the names drift apart`,
      ).not.toMatch(/recordChoice\(\s*["']/);
    }
  });

  it("no step reads a choice under a literal key", () => {
    for (const src of sources) {
      expect(
        src.text,
        `${src.file}: choices["…"] — read the key from CHOICE_KEYS instead`,
      ).not.toMatch(/choices\s*\[\s*["']/);
      expect(
        src.text,
        `${src.file}: choices.<name> — read the key from CHOICE_KEYS instead`,
      ).not.toMatch(/\.choices\.[a-z_]/);
    }
  });

  it("a literal-keyed choice constant is PRIVATE to its step, and declared as such", () => {
    // This is the rule that would have stopped at review: the App
    // step's `REPO_CHOICE_KEY = "github_repo"` was a literal cross-step key.
    // A literal is now only legal for a key one step keeps to itself, and the
    // closed list says which — so a value meant for another step has to go
    // through CHOICE_KEYS, where the writer check bites.
    for (const src of sources) {
      for (const m of src.text.matchAll(/export const ([A-Z][A-Z0-9_]*_KEY) = "([^"]+)"/g)) {
        const [, constName, key] = m as unknown as [string, string, string];
        const owner = PRIVATE_CHOICE_KEYS[key];
        expect(
          owner,
          `${src.file} declares ${constName} = "${key}" as a literal. Either add it to CHOICE_KEYS (shared, with a writer) ` +
            "or to PRIVATE_CHOICE_KEYS (kept inside this step).",
        ).toBeDefined();
        expect(
          owner,
          `PRIVATE_CHOICE_KEYS says "${key}" belongs to "${owner}", but it is declared in ${src.file}`,
        ).toBe(src.stepId);
        for (const other of sources) {
          if (other === src) continue;
          expect(
            other.text.includes(constName) || other.text.includes(`"${key}"`),
            `${other.file} uses ${constName} / "${key}", which is declared PRIVATE to ${src.stepId} — promote it to CHOICE_KEYS`,
          ).toBe(false);
        }
      }
    }
  });

  it("every private key is really declared by the step that claims it", () => {
    for (const [key, stepId] of Object.entries(PRIVATE_CHOICE_KEYS)) {
      const src = sourceFor(stepId);
      expect(
        src.text,
        `PRIVATE_CHOICE_KEYS lists "${key}" under ${stepId}, but ${src.file} does not declare it`,
      ).toContain(`= "${key}"`);
    }
  });

  it("the shared keys are declared exactly once — the step files only alias them", () => {
    for (const name of Object.keys(CHOICE_KEYS) as ChoiceName[]) {
      const literal = `"${CHOICE_KEYS[name]}"`;
      for (const src of sources) {
        // A step may name the key's VALUE only inside a `*_CHOICE_KEY = ` alias
        // — and none do today; the aliases all read `= CHOICE_KEYS.x`.
        const offending = src.text.includes(`_CHOICE_KEY = ${literal}`);
        expect(
          offending,
          `${src.file} redeclares the key ${literal} instead of aliasing CHOICE_KEYS.${name}`,
        ).toBe(false);
      }
    }
  });
});

describe("the value vocabularies agree on both sides of a handoff", () => {
  it("the ingress ids the step can record are the ids the readers test for", async () => {
    const { INGRESS_OPTIONS } = await import("../src/onboard/steps/ingress.js");
    const { ingressChoiceOf } = await import("../src/onboard/choices.js");
    for (const option of INGRESS_OPTIONS) {
      // Round-trip through the shared reader: an id the ingress step records
      // must be an id `IngressChoice` accepts, or the interview's conditional
      // question can never fire (it never did — it tested "named-tunnel").
      expect(
        ingressChoiceOf({ [CHOICE_KEYS.ingress]: option.id }),
        `ingress id "${option.id}" is not an IngressChoice`,
      ).toBe(option.id);
    }
  });

  it("the auth routes the LLM step can record are the routes the readers test for", async () => {
    const { parseRouteAnswer } = await import("../src/onboard/steps/llmauth.js");
    const { authRouteOf } = await import("../src/onboard/choices.js");
    for (const answer of ["oauth", "api"]) {
      const route = parseRouteAnswer(answer);
      expect(route).not.toBeNull();
      expect(
        authRouteOf({ [CHOICE_KEYS.authRoute]: route }),
        `route "${route}" is not an AuthRoute`,
      ).toBe(route);
    }
    // The vocabulary the interview used to test for, and which nothing writes.
    expect(authRouteOf({ [CHOICE_KEYS.authRoute]: "api_key" })).toBeNull();
  });

  it("the topologies the topology step can record are the ones its readers test for", async () => {
    const { TOPOLOGY_OPTIONS, topologyRecorded } = await import("../src/onboard/steps/topology.js");
    for (const option of TOPOLOGY_OPTIONS) {
      expect(
        topologyRecorded({ [CHOICE_KEYS.topology]: option.id }),
        `topology "${option.id}" is not a Topology`,
      ).toBe(option.id);
    }
  });
});
