// The `host` family of the host contract, at its door (src/host/cli.ts,
// schemas/host.v1.json): what `qcr --schema 3 host <verb>` prints is one JSON
// object from a closed set, stamped with the contract's number, valid against
// the schema file, with an exit code a host can branch on. The closed sets in
// the code (src/host/outcomes.ts) and the two schema files (host.v1.json, and
// board.v1.json for the progress words) are held to each other here. What
// each verb does is its own suite.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CONTRACTS,
  HOST_FAMILIES,
  HOST_SCHEMA_VERSION,
  contractsWith,
  hostFamilies,
  hostPayloadVersion,
} from "@quickchatai/pi-quickreview/src/contract.js";
import { GITHUB_TRIGGERS } from "@quickchatai/pi-quickreview/src/reviewconfig.js";
import { POSTED_EVENTS } from "../src/boardfile.js";
import { HOST_USAGE, cmdHost } from "../src/host/cli.js";
import { walkGoLive } from "../src/host/golive.js";
import {
  GO_LIVE_PROBLEMS,
  HOST_HOLDERS,
  HOST_MESSAGE_CAP,
  HOST_REASONS,
  HOST_STATES,
  HOST_VERBS,
  LABEL_WORDS,
  PROGRESS_STATES,
  PROOF_BODY_CAP,
  PROOF_COMMENT_BODY_CAP,
  PROOF_COMMENT_CAP,
  PROOF_PATH_CAP,
  REVIEW_EVENTS,
  SETUP_PROBLEMS,
  SETUP_STEPS,
  TRIGGER_WORDS,
  exitCodeOf,
  refused,
  type HostVerb,
} from "../src/host/outcomes.js";
import { WALK_KINDS, type HostPorts } from "../src/host/ports.js";
import { LOCK_HOLDERS, acquireChecklistLock } from "../src/onboard/checklistlock.js";
import { binRoute } from "../src/qcrbin.js";
import { SCHEMA_VERBS, forgetRequestedContract, parseSchemaFlag } from "../src/schemaflag.js";
import { stripComments } from "./helpers/engine-fences.js";
import { validate } from "./helpers/json-schema-lite.js";
import {
  REPO,
  WALK_PID,
  finishedRound,
  hostWorld,
  setUpConfig,
  type HostWorld,
} from "./helpers/host-rig.js";

const ROOT = join(import.meta.dirname, "..");
type Json = Record<string, unknown>;
const schemaOf = (name: string): Json =>
  JSON.parse(readFileSync(join(ROOT, "schemas", `${name}.json`), "utf8")) as Json;
const schema = schemaOf("host.v1");
const board = schemaOf("board.v1");
const defs = (s: Json): Record<string, Json> => s["$defs"] as Record<string, Json>;
const props = (node: Json): Record<string, Json> => node["properties"] as Record<string, Json>;

let w: HostWorld;
beforeEach(() => {
  w = hostWorld();
});
afterEach(() => {
  w.close();
  forgetRequestedContract();
});

/** One call at the door: what it printed, and the exit code. */
async function call(
  args: string[],
  contract: number | undefined = 3,
): Promise<{ code: number; out: string[]; err: string[]; payload: Json | undefined }> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await cmdHost(args, {
    ...(contract !== undefined ? { contract } : {}),
    ports: w.ports,
    out: (l) => out.push(l),
    err: (l) => err.push(l),
  });
  const payload = out[0] === undefined ? undefined : (JSON.parse(out[0]) as Json);
  return { code, out, err, payload };
}

/** A payload as the contract promises it: one line, the three leading keys,
 * a state of the verb's own set, and valid against the schema file. */
function expectContract(verb: HostVerb, r: Awaited<ReturnType<typeof call>>): Json {
  expect(r.out, verb).toHaveLength(1);
  expect(r.err, verb).toEqual([]);
  const payload = r.payload!;
  expect(Object.keys(payload).slice(0, 3)).toEqual(["schema_version", "verb", "state"]);
  expect(payload["schema_version"]).toBe(3);
  expect(payload["verb"]).toBe(verb);
  expect(HOST_STATES[verb] as readonly string[]).toContain(payload["state"]);
  expect(validate(schema, payload), JSON.stringify(payload)).toEqual([]);
  expect(r.code).toBe(exitCodeOf(payload as unknown as Parameters<typeof exitCodeOf>[0]));
  return payload;
}

describe("the contract", () => {
  // MUTATION: drop `host` from CONTRACTS[3], or add it to contract 2 — this fails.
  it("contract 3 carries the host family at its version, and no older contract does", () => {
    expect(HOST_FAMILIES).toContain("host");
    expect(CONTRACTS[3]?.host).toBe(HOST_SCHEMA_VERSION);
    expect(CONTRACTS[1]).not.toHaveProperty("host");
    expect(CONTRACTS[2]).not.toHaveProperty("host");
    expect(contractsWith("host")).toEqual([3]);
    expect(hostFamilies()["host"]).toBe(HOST_SCHEMA_VERSION);
    expect(hostPayloadVersion("host", 3)).toBe(3);
    expect(schema["$id"]).toBe(`host.v${HOST_SCHEMA_VERSION}.json`);
  });

  // MUTATION: drop `host` from VERB_FAMILY in src/schemaflag.ts — this fails.
  it("`--schema N host` runs under a contract that carries the family, and no other", () => {
    expect(SCHEMA_VERBS).toContain("host");
    expect(binRoute(["--schema", "3", "host", "review-now", "7"])).toEqual({
      route: "host",
      args: ["review-now", "7"],
      json: true,
      schema: 3,
    });
    for (const n of ["1", "2"]) {
      const no = parseSchemaFlag(["--schema", n, "host", "setup"]);
      expect(no).toMatchObject({ kind: "refused", code: 3 });
      expect(no.kind === "refused" && no.line).toMatch(
        new RegExp(`^qcr --schema: contract ${n} has no host payload \\(3 has one\\)`),
      );
    }
    // the detached walk comes in through the same door, with no contract named
    expect(binRoute(["host", "walk", "setup", "token"])).toEqual({
      route: "host",
      args: ["walk", "setup", "token"],
      json: false,
    });
  });
});

describe("the schema file and the code's closed sets", () => {
  // MUTATION: add a state, a reason or a holder in src/host/outcomes.ts and
  // not in schemas/host.v1.json (or the other way round) — this fails,
  // naming the set.
  it("every verb, state, reason and holder is in both", () => {
    const d = defs(schema);
    const names: Record<HostVerb, string> = {
      setup: "setup",
      "review-now": "review_now",
      "proof-start": "proof_start",
      "proof-result": "proof_result",
      "go-live": "go_live",
      "set-trigger": "set_trigger",
    };
    expect(Object.keys(names)).toEqual([...HOST_VERBS]);
    expect((schema["oneOf"] as Json[]).map((x) => x["$ref"])).toEqual(
      HOST_VERBS.map((v) => `#/$defs/${names[v]}`),
    );
    for (const verb of HOST_VERBS) {
      const p = props(d[names[verb]]!);
      expect(p["verb"]!["const"], verb).toBe(verb);
      expect(p["state"]!["enum"], verb).toEqual([...HOST_STATES[verb]]);
      expect(p["schema_version"]!["const"], verb).toBe(hostPayloadVersion("host", 3));
      expect(d[names[verb]]!["additionalProperties"], verb).toBe(false);
      // a verb that can answer `busy` says what holds the lock
      expect("holder" in p, verb).toBe((HOST_STATES[verb] as readonly string[]).includes("busy"));
      expect(p["message"]!["maxLength"], verb).toBe(HOST_MESSAGE_CAP);
    }
    expect(d["reason"]!["enum"]).toEqual([...HOST_REASONS]);
    expect(d["holder"]!["enum"]).toEqual([...HOST_HOLDERS]);
    expect([...HOST_HOLDERS]).toEqual([...LOCK_HOLDERS]);
    // the trigger label's word: go-live's alone, and the same closed set in
    // the board export
    expect(props(d["go_live"]!)["label"]!["enum"]).toEqual([...LABEL_WORDS]);
    for (const verb of HOST_VERBS)
      expect("label" in props(d[names[verb]]!), verb).toBe(verb === "go-live");
    // what the reviewer picks up by itself: set-trigger's word alone, and the
    // same closed set as the board export's `trigger` and the config key's
    expect(props(d["set_trigger"]!)["trigger"]!["enum"]).toEqual([...TRIGGER_WORDS]);
    expect(props(board)["trigger"]!["enum"]).toEqual([...TRIGGER_WORDS]);
    expect([...TRIGGER_WORDS]).toEqual([...GITHUB_TRIGGERS]);
    for (const verb of HOST_VERBS)
      expect("trigger" in props(d[names[verb]]!), verb).toBe(verb === "set-trigger");
    expect(HOST_REASONS).toContain("not_host_managed");
  });

  // MUTATION: raise PROOF_COMMENT_CAP, or a length cap, without the schema — this fails.
  it("the practice review's caps are the schema's", () => {
    const review = props(defs(schema)["review"]!);
    const comment = props(defs(schema)["comment"]!);
    expect(review["comments"]!["maxItems"]).toBe(PROOF_COMMENT_CAP);
    expect(review["body"]!["maxLength"]).toBe(PROOF_BODY_CAP);
    expect(comment["body"]!["maxLength"]).toBe(PROOF_COMMENT_BODY_CAP);
    expect(comment["path"]!["maxLength"]).toBe(PROOF_PATH_CAP);
    expect(review["event"]!["enum"]).toEqual([...REVIEW_EVENTS]);
    expect([...REVIEW_EVENTS]).toEqual([...POSTED_EVENTS]);
  });

  // MUTATION: add a setup step or a problem word in the code and not in
  // schemas/board.v1.json — a host would read a word its schema does not
  // list, and this fails.
  it("the board export's `setup` and `go_live` words are the code's closed sets", () => {
    const setup = props(defs(board)["setup"]!);
    const goLive = props(defs(board)["go_live"]!);
    expect(setup["state"]!["enum"]).toEqual([...PROGRESS_STATES]);
    expect(setup["step"]!["enum"]).toEqual([...SETUP_STEPS]);
    expect(setup["problem"]!["enum"]).toEqual([...SETUP_PROBLEMS]);
    expect(goLive["state"]!["enum"]).toEqual([...PROGRESS_STATES]);
    expect(goLive["problem"]!["enum"]).toEqual([...GO_LIVE_PROBLEMS]);
    // the label is its own closed field, never a problem
    expect(goLive["label"]!["enum"]).toEqual([...LABEL_WORDS]);
    expect(GO_LIVE_PROBLEMS.filter((p) => /label/.test(p))).toEqual([]);
    expect(goLive).not.toHaveProperty("step");
    expect(props(board)["setup"]).toEqual({ $ref: "#/$defs/setup" });
    expect(props(board)["go_live"]).toEqual({ $ref: "#/$defs/go_live" });
  });

  // MUTATION: add a word to a closed set that no verb ever answers with —
  // a name appears in its own declaration, so the declaring file is not
  // read — and this fails.
  it("every word of every closed set is one some host-verb source writes", () => {
    const dir = join(ROOT, "src", "host");
    const code = readdirSync(dir)
      .filter((f) => f.endsWith(".ts") && f !== "outcomes.ts")
      .map((f) => stripComments(readFileSync(join(dir, f), "utf8")))
      .join("\n");
    const words = new Set<string>([
      ...HOST_REASONS,
      ...SETUP_PROBLEMS,
      ...GO_LIVE_PROBLEMS,
      ...HOST_VERBS.flatMap((v) => [...HOST_STATES[v]]),
    ]);
    const unwritten = [...words].filter((word) => !code.includes(`"${word}"`));
    // `queued` and `sent` are the daemon's receipt, passed on as the state
    expect(unwritten).toEqual([]);
  });
});

describe("what a call prints", () => {
  it("every verb answers one object of its own closed set, valid against the schema", async () => {
    const seen = new Set<string>();
    const ok = async (verb: HostVerb, args: string[]): Promise<Json> => {
      const payload = expectContract(verb, await call([verb, ...args]));
      seen.add(`${verb}:${String(payload["state"])}`);
      return payload;
    };
    const setup = ["--repo", REPO, "--auth", "user"];

    // before anything is set up
    expect(await ok("review-now", ["7"])).toMatchObject({ state: "refused", reason: "not_set_up" });
    expect(await ok("proof-result", ["7"])).toEqual({
      schema_version: 3,
      verb: "proof-result",
      state: "not_started",
      pr: 7,
    });
    expect(await ok("setup", ["--repo", REPO])).toMatchObject({
      state: "refused",
      reason: "usage",
    });

    // setup: started, then running while its walk holds the lock
    expect(await ok("setup", setup)).toEqual({
      schema_version: 3,
      verb: "setup",
      state: "started",
    });
    expect(await ok("setup", setup)).toMatchObject({ state: "running" });
    expect(await ok("proof-start", ["7"])).toMatchObject({ state: "busy", holder: "setup" });
    // the walk writes the config: the trigger is not changed under it
    expect(await ok("set-trigger", ["all"])).toEqual({
      schema_version: 3,
      verb: "set-trigger",
      state: "busy",
      holder: "setup",
    });
    expect(await ok("go-live", [])).toMatchObject({
      state: "refused",
      reason: "attestation_invalid",
    });
    // the walk is over and its lock given up; the reviewer is up, in dry-run
    const over = acquireChecklistLock(w.stateDir, "home", { pid: WALK_PID, alive: () => false });
    expect(over.ok).toBe(true);
    if (over.ok) over.lock.release();

    // a review, and the practice review
    expect(await ok("review-now", ["7"])).toMatchObject({ state: "queued", pr: 7 });
    w.daemon.receipt = "pending";
    expect(await ok("review-now", ["8"])).toMatchObject({ state: "sent", pr: 8 });
    w.daemon.receipt = "queued";
    expect(await ok("proof-start", ["7"])).toMatchObject({ state: "started", pr: 7 });
    w.daemon.state = "queued";
    expect(await ok("proof-result", ["7"])).toMatchObject({ state: "running", pr: 7 });
    const done = finishedRound(7, 1, { comments: 3 });
    w.daemon.state = "tracked";
    w.daemon.rounds = [done.round];
    w.daemon.dryrun = done.records;
    const shown = await ok("proof-result", ["7"]);
    expect(shown).toMatchObject({
      state: "done",
      pr: 7,
      proof: { pr: 7, round_no: 1 },
      review: { comments_total: 3 },
    });
    w.daemon.rounds = [{ round_no: 1, status: "cancelled", verdict: null }];
    expect(await ok("proof-result", ["7"])).toMatchObject({
      state: "failed",
      reason: "round_failed",
    });
    w.daemon.rounds = [done.round];

    // go-live: admitted, then running while its walk holds the lock
    w.stdin = JSON.stringify({
      operator: { host: "a-host", id: "user-1" },
      confirmed_at: new Date(w.now).toISOString(),
      proof: { pr: 7, round_no: 1 },
    });
    expect(await ok("go-live", [])).toEqual({
      schema_version: 3,
      verb: "go-live",
      state: "started",
    });
    expect(await ok("go-live", [])).toMatchObject({ state: "running" });
    expect(await ok("proof-result", ["7"])).toMatchObject({ state: "done" });

    // the walk goes live; a repeat call only tries the trigger label again
    expect(await walkGoLive(w.walker(), w.launched.at(-1)!.token)).toBe(0);
    w.writeConfig(w.config()!.replace(/^dry_run = true$/m, "dry_run = false"));
    expect(await ok("go-live", [])).toEqual({
      schema_version: 3,
      verb: "go-live",
      state: "done",
      label: "ok",
    });
    w.labelCreate = 403;
    expect(await ok("go-live", [])).toMatchObject({ state: "done", label: "failed" });

    // which pull requests it picks up by itself, changed with one call
    expect(await ok("set-trigger", ["all"])).toEqual({
      schema_version: 3,
      verb: "set-trigger",
      state: "done",
      trigger: "all",
    });
    expect(await ok("set-trigger", ["every"])).toMatchObject({
      state: "refused",
      reason: "usage",
    });

    // an install that keeps its own credential is not a host verb's to act on
    w.writeConfig(setUpConfig({ dryRun: false, hosted: false }));
    expect(await ok("go-live", [])).toMatchObject({
      state: "refused",
      reason: "not_host_managed",
    });
    expect(await ok("setup", setup)).toMatchObject({
      state: "refused",
      reason: "not_host_managed",
    });
    expect(await ok("set-trigger", ["label"])).toMatchObject({
      state: "refused",
      reason: "not_host_managed",
    });

    // the states a host must be ready for were all printed at least once
    for (const state of [
      "setup:started",
      "setup:running",
      "setup:refused",
      "review-now:queued",
      "review-now:sent",
      "review-now:refused",
      "proof-start:started",
      "proof-start:busy",
      "proof-result:not_started",
      "proof-result:running",
      "proof-result:done",
      "proof-result:failed",
      "go-live:started",
      "go-live:running",
      "go-live:done",
      "go-live:refused",
      "set-trigger:done",
      "set-trigger:busy",
      "set-trigger:refused",
    ])
      expect([...seen]).toContain(state);
  });

  it("no payload carries a URL or the token", async () => {
    w.writeConfig(setUpConfig());
    const lines: string[] = [];
    for (const args of [
      ["setup", "--repo", REPO, "--auth", "user"],
      ["review-now", "7"],
      ["proof-start", "7"],
      ["proof-result", "7"],
      ["set-trigger", "all"],
    ])
      lines.push(...(await call(args)).out);
    expect(lines.length).toBeGreaterThan(3);
    for (const line of lines) {
      expect(line).not.toMatch(/https?:\/\//);
      expect(line).not.toContain("ghu_");
    }
  });

  // MUTATION: return 0 for every printed answer — this fails.
  it("the exit code: 0 for what was done or is under way, 2 for a call it could not read, 1 for any other refusal", () => {
    expect(exitCodeOf({ state: "started" })).toBe(0);
    expect(exitCodeOf({ state: "running" })).toBe(0);
    expect(exitCodeOf({ state: "busy" })).toBe(0);
    expect(exitCodeOf({ state: "not_started" })).toBe(0);
    expect(exitCodeOf({ state: "done" })).toBe(0);
    expect(exitCodeOf(refused("usage", "x"))).toBe(2);
    expect(exitCodeOf(refused("proof_mismatch", "x"))).toBe(1);
    expect(exitCodeOf({ state: "failed", reason: "round_failed" })).toBe(1);
    expect(refused("usage", "m".repeat(HOST_MESSAGE_CAP + 50)).message).toHaveLength(
      HOST_MESSAGE_CAP,
    );
  });

  // A step's failure can be any length ("step threw: <an error's text>").
  // MUTATION: put the failure's words in `message` whole (drop the slice in
  // proof.ts `failed`) — the payload breaks the schema's maxLength, and this fails.
  it("a failure's message is capped as a refusal's is, whatever a step said", async () => {
    w.writeConfig(setUpConfig());
    expect((await call(["proof-start", "7"])).payload).toMatchObject({ state: "started" });
    const done = finishedRound(7, 1);
    w.daemon.rounds = [done.round];
    w.daemon.dryrun = done.records;
    const long = `step threw: ${"x".repeat(5 * HOST_MESSAGE_CAP)}`;
    const failing = {
      runStep: async () => ({ ok: false, checks: [], failures: [long] }),
    } as unknown as ReturnType<HostPorts["checklist"]>;
    const out: string[] = [];
    const code = await cmdHost(["proof-result", "7"], {
      contract: 3,
      ports: { ...w.ports, checklist: () => failing },
      out: (l) => out.push(l),
      err: () => {},
    });
    expect(code).toBe(1);
    const payload = JSON.parse(out[0]!) as Json;
    expect(payload).toMatchObject({ state: "failed", reason: "record_failed", pr: 7 });
    expect(String(payload["message"])).toHaveLength(HOST_MESSAGE_CAP);
    expect(validate(schema, payload)).toEqual([]);
  });

  it("a word that is not a host verb prints nothing on stdout: usage, exit 2", async () => {
    for (const args of [[], ["status"], ["golive"], ["--repo", REPO]]) {
      const r = await call(args);
      expect(r.code, args.join(" ")).toBe(2);
      expect(r.out).toEqual([]);
      expect(r.err).toHaveLength(1);
      expect(r.err[0]).toContain(HOST_USAGE);
    }
    expect(HOST_USAGE).toBe(`usage: qcr --schema N host ${HOST_VERBS.join("|")} [arguments…]`);
  });

  it("named no contract, it stamps the newest that carries the family", async () => {
    const r = await call(["proof-result", "7"], undefined);
    expect(r.payload).toMatchObject({ schema_version: 3, verb: "proof-result" });
  });

  it("a verb that throws prints nothing on stdout, and exits 1", async () => {
    w.writeConfig(setUpConfig());
    const out: string[] = [];
    const err: string[] = [];
    const code = await cmdHost(["review-now", "7"], {
      contract: 3,
      ports: {
        ...w.ports,
        read: () => {
          throw Object.assign(new Error("EIO: i/o error"), { code: "EIO" });
        },
      },
      out: (l) => out.push(l),
      err: (l) => err.push(l),
    });
    // an unreadable config is a refusal in words, not a throw
    expect(code).toBe(1);
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0]!)).toMatchObject({ state: "refused", reason: "config_unreadable" });
    const thrown = await cmdHost(["review-now", "7"], {
      contract: 3,
      ports: {
        ...w.ports,
        adapters: () => {
          throw new Error("no adapters");
        },
      },
      out: (l) => out.push(l),
      err: (l) => err.push(l),
    });
    expect(thrown).toBe(1);
    expect(out).toHaveLength(1);
    expect(err.at(-1)).toMatch(/^qcr host review-now: /);
  });
});

describe("the detached walk's door", () => {
  // MUTATION: accept `host walk` with no token, or a kind that is none — this fails.
  it("is `host walk <kind> <token>`, prints no payload, and without its lock does nothing", async () => {
    expect([...WALK_KINDS]).toEqual(["setup", "go-live"]);
    for (const args of [
      ["walk"],
      ["walk", "setup"],
      ["walk", "everything", "t"],
      ["walk", "setup", ""],
    ]) {
      const r = await call(args);
      expect(r.code, args.join(" ")).toBe(2);
      expect(r.out).toEqual([]);
    }
    for (const kind of WALK_KINDS) {
      const r = await call(["walk", kind, "a-token-nobody-handed-over"]);
      expect(r.code, kind).toBe(1);
      expect(r.out).toEqual([]);
    }
    expect(w.ran).toEqual([]);
    expect(w.calls).toEqual([]);
  });
});
