// The Node post client behind scripts/post-review.sh, approve-pr.sh and
// reply-thread.sh.
//
// On a host the daemon runs (a round worker, an answer worker, a debug pi) the
// three scripts keep their seeded names and their arguments, and always hand
// over to this client; without QCR_IPC_SOCKET and QCR_IPC_CAP_FD in env the
// client refuses:
//
//     exec node dist/src/ipc/postshim.js review|approval|reply "$@"
//
// It holds no GitHub credential and builds no payload. It names the result
// files the host wrote (absolute paths; the daemon checks they sit in the PR's
// own directories) and sends the round's identity the host already carries in
// env. The capability is read from the inherited fd with pread for EACH post,
// never cached, so a revoked or replaced capability is never used twice.
//
// Exit code 0: the daemon posted, recorded the post in dry-run, found it
// already confirmed, took the delivery over (deferred), or another attempt in
// the daemon owns the round's posting right now (in flight). A review or an
// approval this client stopped waiting for is in flight too: the daemon goes on
// and records its outcome, so the session is told not to post again. Anything
// else prints the daemon's typed refusal and exits 1.
import { resolve } from "node:path";
import { connectFromEnv, type IpcEnv } from "./client.js";
import { IpcError } from "./protocol.js";

const KINDS = {
  review: {
    op: "post.review",
    prefix: "post-review",
    usage:
      "usage: post-review.sh <pr-number> <REQUEST_CHANGES|COMMENT> <body-file> [comments-json-file]",
  },
  approval: {
    op: "post.approval",
    prefix: "approve-pr",
    usage: "usage: approve-pr.sh <pr-number> [review-body-file] [comments-json-file]",
  },
  reply: {
    op: "post.reply",
    prefix: "reply-thread",
    usage: "usage: reply-thread.sh <pr-number> <comment-id> <body-file>",
  },
} as const;

export type PostShimKind = keyof typeof KINDS;

/** What the daemon answers a post op with (src/postops.ts `PostOutcome`). */
interface Outcome {
  status?: string;
  lines?: unknown;
}

export interface ShimIo {
  stdout(text: string): void;
  stderr(text: string): void;
}

const processIo: ShimIo = {
  stdout: (t) => void process.stdout.write(t),
  stderr: (t) => void process.stderr.write(t),
};

/**
 * How long the client waits for the daemon's answer. The worst case of one
 * post: the daemon's own reads are capped at 20 s each (the approval's CI
 * pre-check, the marker read; postops.ts `POSTING_READ_DEADLINE_MS`), and
 * the posting guards' reads on the gate (the PR, the reviews, the checks)
 * each have the adapter's bounded retry, 3 attempts of up to 60 s plus about
 * 4 s of backoff; then the POST itself, up to 60 s. 2 × 20 + 3 × 184 + 60 ≈
 * 650 s. Past this the post is still running in the daemon, which records
 * its outcome: the client answers "in flight", never "failed".
 */
export const POST_TIMEOUT_MS = 720_000;

/** What a review or an approval answers when this client stopped waiting. */
const IN_FLIGHT =
  "a posting for this round is in flight in the daemon; do NOT post again — finish the round normally (verdict file as decided)";

/** The round identity a keyed round's host carries in env. */
function roundClaims(env: IpcEnv): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const round = env.QCR_ROUND_NO;
  if (round !== undefined && round !== "") {
    if (!/^\d+$/.test(round)) throw new IpcError("bad_request", "QCR_ROUND_NO must be an integer");
    out.round_no = Number(round);
  }
  if (env.QCR_EXPECTED_HEAD) out.expected_head = env.QCR_EXPECTED_HEAD;
  if (env.QCR_POSTING_KEY) out.posting_key = env.QCR_POSTING_KEY;
  return out;
}

/** The request body for one script's arguments, or an IpcError naming the usage. */
export function postRequest(
  kind: PostShimKind,
  args: readonly string[],
  env: IpcEnv,
): { pr: number; body: Record<string, unknown> } {
  const usage = KINDS[kind].usage;
  const pr = args[0] ?? "";
  if (!/^\d+$/.test(pr)) throw new IpcError("bad_request", usage);
  const prNo = Number(pr);
  const file = (p: string | undefined): string | undefined =>
    p === undefined || p === "" ? undefined : resolve(p);
  if (kind === "review") {
    const event = args[1] ?? "";
    if (event === "APPROVE")
      throw new IpcError(
        "bad_request",
        "APPROVE is not allowed here — use scripts/approve-pr.sh (it also clears the wake triggers)",
      );
    if (event !== "REQUEST_CHANGES" && event !== "COMMENT")
      throw new IpcError("bad_request", usage);
    const bodyFile = file(args[2]);
    if (!bodyFile) throw new IpcError("bad_request", `unreadable review body file: <missing>`);
    return {
      pr: prNo,
      body: {
        pr: prNo,
        event,
        body_file: bodyFile,
        ...(file(args[3]) ? { comments_file: file(args[3]) } : {}),
        ...roundClaims(env),
      },
    };
  }
  if (kind === "approval") {
    return {
      pr: prNo,
      body: {
        pr: prNo,
        ...(file(args[1]) ? { body_file: file(args[1]) } : {}),
        ...(file(args[2]) ? { comments_file: file(args[2]) } : {}),
        ...roundClaims(env),
      },
    };
  }
  const cid = args[1] ?? "";
  if (!/^\d+$/.test(cid))
    throw new IpcError(
      "bad_request",
      `${usage} (comment-id is the numeric databaseId, see pr-threads.sh)`,
    );
  const bodyFile = file(args[2]);
  if (!bodyFile) throw new IpcError("bad_request", `unreadable reply body file: <missing>`);
  return { pr: prNo, body: { pr: prNo, comment_id: Number(cid), body_file: bodyFile } };
}

/** Run one post. Resolves to the process exit code. */
export async function runPostShim(
  kind: string,
  args: readonly string[],
  env: IpcEnv = process.env,
  io: ShimIo = processIo,
  opts: { timeoutMs?: number } = {},
): Promise<number> {
  if (!Object.hasOwn(KINDS, kind)) {
    io.stderr(`postshim: unknown kind ${kind} (review, approval or reply)\n`);
    return 2;
  }
  const k = KINDS[kind as PostShimKind];
  let client;
  try {
    const { pr, body } = postRequest(kind as PostShimKind, args, env);
    client = await connectFromEnv("shim", env, { timeoutMs: opts.timeoutMs ?? POST_TIMEOUT_MS });
    try {
      const out = await client.request<Outcome>(k.op, body, { pr });
      for (const line of Array.isArray(out?.lines) ? out.lines : []) io.stdout(`${String(line)}\n`);
      return 0;
    } catch (e) {
      // The request reached the daemon and no answer came in time: the post
      // goes on there. A review or an approval is the round's posting, which
      // the daemon records; a reply's outcome is simply unknown.
      if (e instanceof IpcError && e.code === "timeout") {
        if (kind === "reply") {
          io.stderr(
            `${k.prefix}: timeout: the daemon did not answer in time; whether the reply was posted is unknown — do NOT retry\n`,
          );
          return 1;
        }
        io.stdout(`${IN_FLIGHT}\n`);
        return 0;
      }
      throw e;
    }
  } catch (e) {
    const err = e instanceof IpcError ? e : new IpcError("internal", String(e));
    io.stderr(`${k.prefix}: ${err.code}: ${err.message}\n`);
    return 1;
  } finally {
    client?.close();
  }
}

// Run only as the entry point, not when a test imports runPostShim.
if (process.argv[1]?.endsWith("postshim.js")) {
  void runPostShim(process.argv[2] ?? "", process.argv.slice(3)).then((code) => process.exit(code));
}
