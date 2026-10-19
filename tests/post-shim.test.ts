// [P7.2] The Node post client behind post-review.sh, approve-pr.sh and
// reply-thread.sh: argument parsing, the round identity it carries from env,
// the capability read from the inherited fd for every post, the exit codes, and
// the scripts' hand-over to it whenever the worker socket is in env.
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCapabilityFd } from "../src/ipc/capability.js";
import type { IpcClient } from "../src/ipc/client.js";
import { postRequest, runPostShim } from "../src/ipc/postshim.js";
import { postingMarker } from "../src/posting-receipt.js";
import {
  HEAD,
  KEY,
  OTHER_PR,
  PR,
  buildRig,
  dryrunRecords,
  plainCommand,
  roundCommand,
  type Rig,
} from "./helpers/post-ops-rig.js";

const SANDBOX = resolve(import.meta.dirname, "..");

describe("[P7.2] the client builds its request from the scripts' own arguments", () => {
  const env = {};
  it("post-review: absolute file paths, the round identity from env", () => {
    const r = postRequest(
      "review",
      ["7", "REQUEST_CHANGES", "state/pr-7-r1-review.md", "state/pr-7-r1-comments.json"],
      { QCR_ROUND_NO: "1", QCR_EXPECTED_HEAD: HEAD, QCR_POSTING_KEY: KEY },
    );
    expect(r).toEqual({
      pr: 7,
      body: {
        pr: 7,
        event: "REQUEST_CHANGES",
        body_file: resolve("state/pr-7-r1-review.md"),
        comments_file: resolve("state/pr-7-r1-comments.json"),
        round_no: 1,
        expected_head: HEAD,
        posting_key: KEY,
      },
    });
  });

  it("approve-pr: both files optional", () => {
    expect(postRequest("approval", ["7"], env)).toEqual({ pr: 7, body: { pr: 7 } });
    expect(postRequest("approval", ["7", "b.md"], env).body).toMatchObject({
      body_file: resolve("b.md"),
    });
  });

  it("reply-thread: a numeric comment id and a body file", () => {
    expect(postRequest("reply", ["7", "9001", "r.md"], env)).toEqual({
      pr: 7,
      body: { pr: 7, comment_id: 9001, body_file: resolve("r.md") },
    });
  });

  it("refuses what the scripts refuse", () => {
    const bad = (k: "review" | "approval" | "reply", a: string[], e = {}) =>
      expect(() => postRequest(k, a, e)).toThrow();
    bad("review", ["x", "COMMENT", "b.md"]);
    bad("review", ["7", "APPROVE", "b.md"]);
    bad("review", ["7", "NOPE", "b.md"]);
    bad("review", ["7", "COMMENT"]);
    bad("review", ["7", "COMMENT", "b.md"], { QCR_ROUND_NO: "one" });
    bad("approval", []);
    bad("reply", ["7", "abc", "r.md"]);
    bad("reply", ["7", "9001"]);
  });
});

describe("[P7.2] the client posts through a daemon", () => {
  let rig: Rig;
  let clients: IpcClient[];
  let fd: number;
  let out: string;
  let err: string;
  const io = { stdout: (t: string) => (out += t), stderr: (t: string) => (err += t) };

  const envFor = (id: string, extra: Record<string, string> = {}): Record<string, string> => ({
    QCR_IPC_SOCKET: rig.sock,
    QCR_IPC_COMMAND_ID: id,
    QCR_IPC_GENERATION: "1",
    QCR_IPC_CAP_FD: String(fd),
    ...extra,
  });

  beforeEach(async () => {
    clients = [];
    out = err = "";
    rig = await buildRig(true, clients);
    roundCommand(rig);
    fd = createCapabilityFd(join(rig.root, "state"), rig.caps.get("c-round")!);
  });
  afterEach(async () => {
    closeSync(fd);
    for (const c of clients) c.close();
    await rig.server.stop();
    rig.store.close();
    rmSync(rig.root, { recursive: true, force: true });
  });

  it("post-review: exit 0, the daemon's lines on stdout, one record in state/dryrun/", async () => {
    const body = rig.write(`pr-${PR}-round-1-review.md`, "from the shim");
    const code = await runPostShim(
      "review",
      [String(PR), "COMMENT", body],
      envFor("c-round", { QCR_ROUND_NO: "1", QCR_EXPECTED_HEAD: HEAD }),
      io,
    );
    expect({ code, err }).toEqual({ code: 0, err: "" });
    expect(out).toMatch(/dry-run: post COMMENT review on #7 -> .*nothing was sent/);
    const [rec] = dryrunRecords(rig);
    expect(rec!.body.body).toBe(`from the shim\n\n${postingMarker(KEY)}`);
  });

  it("reads the capability from the fd for every post: two posts, one fd, both served", async () => {
    const body = rig.write(`pr-${PR}-round-1-review.md`, "twice");
    const run = () => runPostShim("review", [String(PR), "COMMENT", body], envFor("c-round"), io);
    expect(await run()).toBe(0);
    expect(await run()).toBe(0); // the repeat is the recorded receipt
    expect(out).toMatch(/already recorded/);
  });

  it("approve-pr and reply-thread", async () => {
    const body = rig.write(`pr-${PR}-round-1-approve.md`, "ok");
    expect(await runPostShim("approval", [String(PR), body], envFor("c-round"), io)).toBe(0);
    expect(dryrunRecords(rig).map((r) => r.kind)).toEqual([
      "create_review",
      "remove_label",
      "delete_team_review_request",
    ]);
    const reply = rig.write(`pr-${PR}-reply.md`, "thanks");
    expect(await runPostShim("reply", [String(PR), "9001", reply], envFor("c-round"), io)).toBe(0);
    expect(dryrunRecords(rig).at(-1)!.kind).toBe("create_review_comment_reply");
  });

  it("exits 1 and names the daemon's typed refusal for another PR's post", async () => {
    const body = rig.write(`pr-${OTHER_PR}-x.md`, "x");
    const code = await runPostShim(
      "review",
      [String(OTHER_PR), "COMMENT", body],
      envFor("c-round"),
      io,
    );
    expect(code).toBe(1);
    expect(err).toMatch(/^post-review: wrong_pr: /);
    expect(dryrunRecords(rig)).toEqual([]);
  });

  it("exits 1 for a path outside the PR's directories", async () => {
    const code = await runPostShim(
      "review",
      [String(PR), "COMMENT", "/etc/hostname"],
      envFor("c-round"),
      io,
    );
    expect(code).toBe(1);
    expect(err).toMatch(/^post-review: bad_path: /);
  });

  it("exits 1 under a takeover lease and for an answer worker without may_post", async () => {
    plainCommand(rig, "c-take", { lease: "takeover" });
    plainCommand(rig, "c-ans", { answer: true });
    const body = rig.write(`pr-${PR}-x.md`, "x");
    for (const [id, code] of [
      ["c-take", "lease_takeover"],
      ["c-ans", "may_post_required"],
    ] as const) {
      const f = createCapabilityFd(join(rig.root, "state"), rig.caps.get(id)!);
      try {
        err = "";
        const rc = await runPostShim(
          "review",
          [String(PR), "COMMENT", body],
          { ...envFor(id), QCR_IPC_CAP_FD: String(f) },
          io,
        );
        expect(rc).toBe(1);
        expect(err).toContain(`: ${code}: `);
      } finally {
        closeSync(f);
      }
    }
    expect(dryrunRecords(rig)).toEqual([]);
  });

  it("exits 1 with no capability on the fd, and 2 for an unknown kind", async () => {
    expect(
      await runPostShim(
        "review",
        [String(PR), "COMMENT", "b.md"],
        { ...envFor("c-round"), QCR_IPC_CAP_FD: "x" },
        io,
      ),
    ).toBe(1);
    expect(await runPostShim("nope", [], {}, io)).toBe(2);
  });
});

describe("[P7.2] the three scripts hand over to the client when the worker socket is in env", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "shim-script-"));
    mkdirSync(join(root, "scripts"));
    mkdirSync(join(root, "dist", "src", "ipc"), { recursive: true });
    writeFileSync(
      join(root, "dist", "src", "ipc", "postshim.js"),
      "console.log(JSON.stringify(process.argv.slice(2)));\n",
    );
    for (const f of ["post-review.sh", "approve-pr.sh", "reply-thread.sh"]) {
      copyFileSync(join(SANDBOX, "scripts", f), join(root, "scripts", f));
      chmodSync(join(root, "scripts", f), 0o755);
    }
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const run = (script: string, args: string[], env: Record<string, string | undefined>) =>
    spawnSync("bash", [join(root, "scripts", script), ...args], {
      env: { PATH: process.env.PATH ?? "", ...env },
      encoding: "utf8",
    });
  const IPC = { QCR_IPC_SOCKET: "/x/qcr.sock", QCR_IPC_CAP_FD: "3" };

  it.each([
    ["post-review.sh", "review", ["7", "COMMENT", "b.md", "c.json"]],
    ["approve-pr.sh", "approval", ["7", "b.md"]],
    ["reply-thread.sh", "reply", ["7", "9001", "r.md"]],
  ])("%s runs the client with its own arguments and reads no config", (script, kind, args) => {
    // No config, no install locator, no GitHub credential: nothing the shell
    // route needs exists in this tree.
    const r = run(script, args, IPC);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual([kind, ...args]);
  });

  it.each(["post-review.sh", "approve-pr.sh", "reply-thread.sh"])(
    "%s keeps its shell route when either variable is missing",
    (script) => {
      for (const env of [{}, { QCR_IPC_SOCKET: "/x/qcr.sock" }, { QCR_IPC_CAP_FD: "3" }]) {
        const r = run(script, ["7", "COMMENT", "b.md"], env);
        // The shell route runs: it needs the install locator, which is not here.
        expect(r.stdout).not.toContain('["');
        expect(r.status).not.toBe(0);
      }
    },
  );
});
