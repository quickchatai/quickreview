// [P7.3] The Node/IPC posting route writes the payload bytes the shell route
// wrote, in dry-run.
//
// Every recorded round in tests/fixtures/post-parity/ is posted through the
// Node client against a real daemon post endpoint (src/postops.ts, the real
// MutationGate, a scripted GitHub fetch), and the records it writes must equal
// the fixture's expected.json, apart from the wall clock and the log label.
// expected.json was captured from the Node route on the day the legacy shell
// route (scripts/guards.sh and the shell bodies of the three scripts) was
// deleted (P9.3), after the test had shown the two routes byte-equal, record
// by record, apart from each case's pinned known_divergence.
//
// A fixture is a directory: case.json (the kind of post, the round, the GitHub
// state, the record kinds it must produce) beside the files the host wrote
// (body.md, comments.json). Add a directory to add a case; the harness reads
// whatever it finds.
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCapabilityFd } from "../src/ipc/capability.js";
import type { IpcClient } from "../src/ipc/client.js";
import { runPostShim, type PostShimKind } from "../src/ipc/postshim.js";
import {
  FakeGitHub,
  HEAD,
  PR,
  buildRig,
  roundCommand,
  plainCommand,
  type Rig,
} from "./helpers/post-ops-rig.js";

const SANDBOX = resolve(import.meta.dirname, "..");
const FIXTURES = join(SANDBOX, "tests", "fixtures", "post-parity");

interface ParityCase {
  about: string;
  kind: PostShimKind;
  event?: "REQUEST_CHANGES" | "COMMENT";
  comment_id?: number;
  /** The round the host carries in env, or null for an unkeyed post. */
  round: number | null;
  body: string | null;
  comments: string | null;
  github?: { reviews?: Array<Record<string, unknown>> };
  /** The record kinds the route must produce, in order. */
  records: string[];
  /**
   * A difference from the retired shell route that is known and ruled on (the owner accepted it): the field, what
   * the shell wrote and what the Node route writes. The Node value is pinned here and in expected.json.
   */
  known_divergence?: { record: number; field: string; shell: string; node: string; why: string };
}

/** One dry-run record without its wall clock and its log label: the payload GitHub would have received. */
type Rec = Record<string, unknown>;

function loadCases(): Array<[string, ParityCase]> {
  return readdirSync(FIXTURES)
    .sort()
    .filter((d) => existsSync(join(FIXTURES, d, "case.json")))
    .map((d) => {
      // "$HEAD" in a fixture is the head of the round, so the file stays literal.
      const text = readFileSync(join(FIXTURES, d, "case.json"), "utf8").replaceAll("$HEAD", HEAD);
      return [d, JSON.parse(text) as ParityCase];
    });
}

/** The script's own argument list for a case, over the given file paths. */
function argsFor(c: ParityCase, body: string | undefined, comments: string | undefined): string[] {
  if (c.kind === "review") return [String(PR), c.event!, body!, ...(comments ? [comments] : [])];
  if (c.kind === "approval")
    return [String(PR), ...(body || comments ? [body ?? "", ...(comments ? [comments] : [])] : [])];
  return [String(PR), String(c.comment_id), body!];
}

/** A scripted GitHub both routes read: the same PR, the same reviews, green CI. */
function scriptedGitHub(c: ParityCase): FakeGitHub {
  const gh = new FakeGitHub();
  gh.reviews = c.github?.reviews ?? [];
  return gh;
}

/** Object keys in sorted order at every depth: a JSON object has no key order, so two routes that write the
 * same fields in a different order wrote the same payload. Every value, string byte and array order is kept. */
function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v !== null && typeof v === "object")
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, x]) => [k, sortKeys(x)]),
    );
  return v;
}

/**
 * One dry-run record, read back. Two fields are not payload and are dropped: `recorded_at` (the wall clock) and
 * `note` (a log label each route words its own way; it never reaches GitHub). What is left is kind, method,
 * path, pr and the request body.
 */
function readRecord(file: string): Rec {
  const rec = JSON.parse(readFileSync(file, "utf8")) as Rec;
  expect(typeof rec.recorded_at).toBe("string");
  expect(typeof rec.note).toBe("string");
  delete rec.recorded_at;
  delete rec.note;
  return rec;
}

/**
 * A record as canonical bytes. The two routes serialise a record differently (Python escapes non-ASCII as
 * \uXXXX and orders its keys its own way; the gate writes the text as is), and none of that reaches GitHub, so
 * what is compared is the JSON value, down to every byte of every string.
 */
function canonical(rec: Rec): string {
  return JSON.stringify(sortKeys(rec), null, 2);
}

/** Read and replace the value at a dotted path (`body.body`, `body.comments.0.body`). */
function valueAt(rec: Rec, path: string, set?: string): unknown {
  const keys = path.split(".");
  const last = keys.pop()!;
  let node: any = rec;
  for (const k of keys) node = node?.[k];
  const was = node?.[last];
  if (set !== undefined && node) node[last] = set;
  return was;
}

function recordFiles(dir: string): string[] {
  return existsSync(dir)
    ? readdirSync(dir)
        .sort()
        .map((f) => join(dir, f))
    : [];
}

describe("[P7.3] the Node posting route writes the recorded dry-run payloads", () => {
  let rig: Rig | undefined;
  let clients: IpcClient[];
  let fd: number | undefined;

  beforeEach(() => {
    clients = [];
  });
  afterEach(async () => {
    if (fd !== undefined) closeSync(fd);
    fd = undefined;
    for (const c of clients) c.close();
    await rig?.server.stop();
    rig?.store.close();
    if (rig) rmSync(rig.root, { recursive: true, force: true });
    rig = undefined;
  });

  /** The Node route: the client against the daemon's post endpoint. */
  async function postViaNode(c: ParityCase, fixture: string): Promise<Rec[]> {
    rig = await buildRig(true, clients);
    rig.gh.reviews = scriptedGitHub(c).reviews;
    if (c.round !== null) roundCommand(rig);
    else plainCommand(rig, "c-round");
    fd = createCapabilityFd(join(rig.root, "state"), rig.caps.get("c-round")!);
    // The daemon takes the files from the PR's own directory, under their usual names.
    const stage = (name: string | null, as: string): string | undefined => {
      if (!name) return undefined;
      mkdirSync(rig!.state, { recursive: true });
      const dest = join(rig!.state, as);
      copyFileSync(join(FIXTURES, fixture, name), dest);
      return dest;
    };
    const stem = `pr-${PR}-round-${c.round ?? 0}`;
    const args = argsFor(
      c,
      stage(c.body, c.kind === "reply" ? `pr-${PR}-reply.md` : `${stem}-body.md`),
      stage(c.comments, `${stem}-comments.json`),
    );
    const env: Record<string, string> = {
      QCR_IPC_SOCKET: rig.sock,
      QCR_IPC_COMMAND_ID: "c-round",
      QCR_IPC_GENERATION: "1",
      QCR_IPC_CAP_FD: String(fd),
      ...(c.round !== null ? { QCR_ROUND_NO: String(c.round), QCR_EXPECTED_HEAD: HEAD } : {}),
    };
    let err = "";
    const code = await runPostShim(c.kind, args, env, {
      stdout: () => {},
      stderr: (t) => (err += t),
    });
    expect({ code, err }).toEqual({ code: 0, err: "" });
    expect(rig.gh.posts()).toEqual([]); // dry-run: nothing was sent
    return recordFiles(rig.dryrun).map(readRecord);
  }

  const cases = loadCases();

  it("has a fixture for review, approve and reply, and every case names its records", () => {
    expect(new Set(cases.map(([, c]) => c.kind))).toEqual(new Set(["review", "approval", "reply"]));
    for (const [, c] of cases) expect(c.records.length).toBeGreaterThan(0);
  });

  it.each(cases)("%s", { timeout: 60_000 }, async (fixture, c) => {
    const node = await postViaNode(c, fixture);
    // Not vacuous: the route recorded exactly what the fixture says it must.
    expect(node.map((r) => r.kind)).toEqual(c.records);
    const expected = (
      JSON.parse(readFileSync(join(FIXTURES, fixture, "expected.json"), "utf8")) as Rec[]
    ).map(canonical);
    const d = c.known_divergence;
    // The pinned difference from the retired shell route is what the Node route writes.
    if (d) expect(valueAt(node[d.record]!, d.field)).toBe(d.node);
    expect(node.map(canonical)).toEqual(expected);
  });
});
