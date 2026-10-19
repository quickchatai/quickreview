// [P7.3] The shell posting route and the Node/IPC posting route write the same
// payload bytes in dry-run.
//
// There is no posting canary before the cutover, so this is the only proof the
// Node path gets: every recorded round in tests/fixtures/post-parity/ is posted
// once through the real scripts/post-review.sh, approve-pr.sh or
// reply-thread.sh (the legacy tmux route, a loopback stub of GitHub) and once
// through the Node client against a real daemon post endpoint (src/postops.ts,
// the real MutationGate, a scripted GitHub fetch). Both see the same GitHub
// state and the same input files, and both only write under their own dryrun
// directory. The records the two routes wrote must be byte-equal, line for
// line, apart from the one field that is the wall clock.
//
// A fixture is a directory: case.json (the kind of post, the round, the GitHub
// state, the record kinds it must produce) beside the files the host wrote
// (body.md, comments.json). Add a directory to add a case; the harness reads
// whatever it finds.
import { execFile } from "node:child_process";
import { createServer, type Server } from "node:http";
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCapabilityFd } from "../src/ipc/capability.js";
import type { IpcClient } from "../src/ipc/client.js";
import { runPostShim, type PostShimKind } from "../src/ipc/postshim.js";
import {
  FakeGitHub,
  HEAD,
  PR,
  REPO,
  buildRig,
  roundCommand,
  plainCommand,
  type Rig,
} from "./helpers/post-ops-rig.js";

const SANDBOX = resolve(import.meta.dirname, "..");
const FIXTURES = join(SANDBOX, "tests", "fixtures", "post-parity");
const run = promisify(execFile);

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
  /** The record kinds both routes must produce, in order. */
  records: string[];
  /**
   * A difference between the routes that is known and ruled on (the owner accepted it). It is pinned exactly: the field, what the
   * shell wrote and what the Node route wrote. The case still compares every other byte, and fails when the
   * difference changes or goes away, so the entry cannot outlive the fix.
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

const SHELL_SCRIPT: Record<PostShimKind, string> = {
  review: "post-review.sh",
  approval: "approve-pr.sh",
  reply: "reply-thread.sh",
};

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

/** The shell route: the real script, a loopback GitHub, its own throwaway home. */
async function postViaShell(c: ParityCase, fixture: string): Promise<Rec[]> {
  const home = mkdtempSync(join(tmpdir(), "qcr-parity-sh-"));
  const gh = scriptedGitHub(c);
  let server: Server | undefined;
  try {
    mkdirSync(join(home, "secrets"));
    // The config mirrors what the Node route's rig is built from.
    writeFileSync(
      join(home, "config.toml"),
      [
        "dry_run = true",
        "",
        "[github]",
        `repo = "${REPO}"`,
        'bot_login = "example-review[bot]"',
        'trigger_label = "AI review requested"',
        'review_team = "example-org/review"',
        `secrets_dir = "${join(home, "secrets")}"`,
        "",
      ].join("\n"),
    );
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (d: Buffer) => chunks.push(d));
      req.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        void gh
          .fetch(`http://stub${req.url}`, {
            method: req.method ?? "GET",
            ...(body ? { body } : {}),
          })
          .then(async (r) => {
            res.writeHead(r.status, { "content-type": "application/json" });
            res.end(await r.text());
          });
      });
    });
    await new Promise<void>((ok) => server!.listen(0, "127.0.0.1", ok));
    const addr = server.address();
    const api = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;

    const inputs = join(home, "inputs");
    mkdirSync(inputs);
    const copy = (name: string | null): string | undefined => {
      if (!name) return undefined;
      copyFileSync(join(FIXTURES, fixture, name), join(inputs, name));
      return join(inputs, name);
    };
    const args = argsFor(c, copy(c.body), copy(c.comments));
    const env: Record<string, string | undefined> = {
      ...process.env,
      GITHUB_API: api,
      QCR_CONFIG: join(home, "config.toml"),
      QCR_DRYRUN_DIR: join(home, "dryrun"),
      QCR_STATE_DB: join(home, "state.db"),
      QCR_ROUND_PROGRESS_DIR: join(home, "round-progress"),
      QCR_POSTING_RECEIPT_DIR: join(home, "receipts"),
    };
    // A leaked variable from the runner must not change which route this is.
    for (const k of [
      "QCR_IPC_SOCKET",
      "QCR_IPC_CAP_FD",
      "QCR_ROUND_NO",
      "QCR_EXPECTED_HEAD",
      "QCR_POSTING_KEY",
    ])
      delete env[k];
    if (c.round !== null) {
      env.QCR_ROUND_NO = String(c.round);
      env.QCR_EXPECTED_HEAD = HEAD;
    }
    await run("bash", [join(SANDBOX, "scripts", SHELL_SCRIPT[c.kind]), ...args], {
      env: env as NodeJS.ProcessEnv,
      encoding: "utf8",
    });
    expect(gh.posts()).toEqual([]); // dry-run: nothing was sent
    return recordFiles(join(home, "dryrun")).map(readRecord);
  } finally {
    await new Promise<void>((ok) => (server ? server.close(() => ok()) : ok()));
    rmSync(home, { recursive: true, force: true });
  }
}

describe("[P7.3] the shell and Node posting routes write byte-equal dry-run records", () => {
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
    const shell = await postViaShell(c, fixture);
    const node = await postViaNode(c, fixture);
    // Not vacuous: both routes recorded exactly what the fixture says they must.
    expect(shell.map((r) => r.kind)).toEqual(c.records);
    expect(node.map((r) => r.kind)).toEqual(c.records);
    const d = c.known_divergence;
    if (d) {
      // The pinned difference is exactly what it says, and nothing else differs.
      expect(valueAt(shell[d.record]!, d.field)).toBe(d.shell);
      expect(valueAt(node[d.record]!, d.field)).toBe(d.node);
      valueAt(shell[d.record]!, d.field, "<known divergence>");
      valueAt(node[d.record]!, d.field, "<known divergence>");
    }
    // Byte-equal, record by record (canonical form: see canonical()).
    expect(node.map(canonical)).toEqual(shell.map(canonical));
  });
});
