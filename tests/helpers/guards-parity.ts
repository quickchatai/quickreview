// The two posting routes behind one interface, for the parity block in
// tests/guards.test.ts: the shell route (scripts/post-review.sh,
// approve-pr.sh and reply-thread.sh, which source scripts/guards.sh) and the
// Node route (the real MutationGate with src/guards.ts installed and the real
// GitHubAdapter doing the reads).
//
// Both routes read ONE world: the shell rig's loopback GitHub stub, its
// state.db and its config.toml. A case sets the world up once and each route
// answers from it, so a difference in an answer is a difference in the
// guards, never in the fixtures. Everything runs in dry-run, so nothing is
// sent: the outcome is read from the dry-run record the route wrote.
//
// The Node route is the one the shell routes are removed in favour of
// (P9.3), so these answers are the contract it must keep.
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { vi } from "vitest";
import { parse } from "smol-toml";
import { GUARDS_DEFAULTS, parseConfig, type Config } from "../../src/config.js";
import { MutationGate, type MutationIntent } from "../../src/gate.js";
import { GitHubAdapter } from "../../src/github.js";
import { makePostingGuard } from "../../src/guards.js";
import { StateStore } from "../../src/state.js";
import type { GuardsShellRig, PrStub } from "./guards-shell-rig.js";
import { HEAD as RIG_HEAD } from "./guards-shell-rig.js";

export const WORLD_HEAD = RIG_HEAD;
export const PR_NUMBER = 5180;
export const COMMENT_ID = 12345;
const BODY_TEXT = "Automated review body.\n";

/** What a session asks a route to post. */
export type PostAction =
  | { kind: "review"; event: "COMMENT" | "REQUEST_CHANGES" }
  | { kind: "approve" }
  | { kind: "reply" };

/** Why a route refused, in the gate's own vocabulary (guards.ts BlockReason). */
export type Blocked =
  "pr-merged" | "pr-closed" | "pr-unreadable" | "no-new-evidence" | "head-drift";

/** What reached (in dry-run: was recorded for) GitHub, route-independent. */
export interface Outcome {
  /** The review event sent, "REPLY" for a thread reply, or null when nothing was. */
  sent: string | null;
  /** The guard that refused the post, or null when it was not refused. */
  blocked: Blocked | null;
  /** The sent payload's body ("" when nothing was sent). */
  body: string;
  /** The sent payload's commit_id ("" for a reply or when nothing was sent). */
  commitId: string;
  /** The recorded intent's note. */
  note: string;
}

export interface Route {
  readonly name: "shell" | "node";
  post(action: PostAction, opts?: { expectedHead?: string | null }): Promise<Outcome>;
}

const NOTHING: Outcome = { sent: null, blocked: null, body: "", commitId: "", note: "" };

// ---- the world -------------------------------------------------------------

/** The PR a real GitHub would answer with: head and author always present. */
export function setPr(s: GuardsShellRig, over: Partial<PrStub> = {}): void {
  s.pr = {
    state: "open",
    merged: false,
    head: { sha: WORLD_HEAD },
    user: { login: "pr-author" },
    ...over,
  };
}

/** Seed the reviewed-head mark both routes read (guard 2). */
export function seedMark(
  s: GuardsShellRig,
  mark: { head_sha: string; verdict?: string | null; round_no?: number; reply_at?: string },
  dbPath = s.dbPath,
): void {
  const store = new StateStore(dbPath);
  store.recordReviewedHead(PR_NUMBER, {
    head_sha: mark.head_sha,
    verdict: mark.verdict ?? null,
    round_no: mark.round_no ?? null,
  });
  if (mark.reply_at) store.noteAuthorReply(PR_NUMBER, mark.reply_at);
  store.close();
}

/** Switch [guards] knobs in the one config.toml both routes parse. */
export function setGuardKnobs(s: GuardsShellRig, knobs: Record<string, boolean>): void {
  const path = join(s.dir, "config.toml");
  const lines = Object.entries(knobs).map(([k, v]) => `${k} = ${v}`);
  writeFileSync(path, `${readFileSync(path, "utf8")}\n[guards]\n${lines.join("\n")}\n`);
}

// ---- the shell route ---------------------------------------------------------

const SHELL_REFUSALS: Array<[RegExp, Blocked]> = [
  [/already merged/, "pr-merged"],
  [/is closed — refusing/, "pr-closed"],
  [/refusing to post \(guard 3, fail closed\)/, "pr-unreadable"],
  [/\(guard 2\)/, "no-new-evidence"],
  [/\(guard 5\)/, "head-drift"],
];

/** A dry-run record as the gate and the scripts write it. */
interface DryRunRecord {
  kind: string;
  note?: string;
  body: { event?: string; body?: string; commit_id?: string };
}

function readRecords(dir: string): Array<DryRunRecord> {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .map((n) => JSON.parse(readFileSync(join(dir, n), "utf8")) as DryRunRecord)
    .filter((r) => r.kind === "create_review" || r.kind === "create_review_comment_reply");
}

function outcomeOf(records: Array<DryRunRecord>): Outcome {
  if (records.length === 0) return NOTHING;
  const r = records[0]!;
  return {
    sent: r.kind === "create_review" ? String(r.body.event) : "REPLY",
    blocked: null,
    body: String(r.body.body ?? ""),
    commitId: String(r.body.commit_id ?? ""),
    note: String(r.note ?? ""),
  };
}

export function shellRoute(s: GuardsShellRig): Route {
  const records = () => readRecords(join(s.dir, "dryrun"));
  const refusal = (out: string): Blocked => {
    const hit = SHELL_REFUSALS.find(([re]) => re.test(out));
    if (!hit) throw new Error(`the shell route failed for no known guard:\n${out}`);
    return hit[1];
  };
  return {
    name: "shell",
    async post(action, opts = {}) {
      const body = s.bodyFile();
      const env: Record<string, string> = {};
      const expected = opts.expectedHead === undefined ? WORLD_HEAD : opts.expectedHead;
      if (expected) env.QCR_EXPECTED_HEAD = expected;
      const [script, args] =
        action.kind === "review"
          ? (["post-review.sh", [String(PR_NUMBER), action.event, body]] as const)
          : action.kind === "approve"
            ? (["approve-pr.sh", [String(PR_NUMBER), body]] as const)
            : (["reply-thread.sh", [String(PR_NUMBER), String(COMMENT_ID), body]] as const);
      const res = await s.run(script, [...args], env);
      if (res.ok) return outcomeOf(records());
      // Guard 4 on this route REFUSES an approval rather than softening it:
      // approve-pr.sh can only approve, and the round template tells the
      // session to post the same review as a COMMENT through post-review.sh.
      // That follow-up is what the gate's softening does in one step, so the
      // two are compared as the session's net effect.
      if (action.kind === "approve" && /APPROVE is unavailable \(guard 4/.test(res.out)) {
        const fallback = await s.run("post-review.sh", [String(PR_NUMBER), "COMMENT", body], env);
        if (!fallback.ok) return { ...NOTHING, blocked: refusal(fallback.out) };
        return outcomeOf(records());
      }
      return { ...NOTHING, blocked: refusal(res.out) };
    },
  };
}

// ---- the Node route -----------------------------------------------------------

/** The Config both routes see: the fixture's shape, with the rig's repo, bot
 * login and [guards] — parsed from the very config.toml the scripts read. */
function nodeConfig(s: GuardsShellRig): Config {
  const base = parseConfig(
    readFileSync(resolve(process.cwd(), "tests/fixtures/config.toml"), "utf8"),
  );
  const rig = parse(readFileSync(join(s.dir, "config.toml"), "utf8")) as {
    github: { repo: string; bot_login: string };
    guards?: Partial<Config["guards"]>;
  };
  return {
    ...base,
    github: { ...base.github, repo: rig.github.repo, bot_login: rig.github.bot_login },
    guards: { ...GUARDS_DEFAULTS, ...(rig.guards ?? {}) },
  };
}

/** A token source that never leaves the process: the stub takes any bearer. */
const stubMinter = {
  installationToken: async () => "stub-token",
  appJwt: () => "stub-jwt",
  invalidate: () => {},
} as never;

export function nodeRoute(s: GuardsShellRig): Route {
  const dryrunDir = () => join(s.dir, "dryrun-node");
  return {
    name: "node",
    async post(action, opts = {}) {
      const cfg = nodeConfig(s);
      const store = new StateStore(s.dbPath);
      try {
        const gate = new MutationGate(true, dryrunDir(), vi.fn() as never);
        const adapter = new GitHubAdapter(cfg, stubMinter, gate, fetch, s.apiBase);
        gate.setGuard(
          makePostingGuard({
            store,
            adapter,
            botLogin: cfg.github.bot_login,
            guards: cfg.guards,
            log: () => {},
          }),
        );
        // The shim stamps the payload's commit_id with the head the round
        // reviewed (QCR_EXPECTED_HEAD on the shell route), and with the live
        // head when the session named none.
        const live = s.pr?.head?.sha ?? WORLD_HEAD;
        const commitId = opts.expectedHead === undefined ? WORLD_HEAD : (opts.expectedHead ?? live);
        const repo = cfg.github.repo;
        const intent: MutationIntent =
          action.kind === "reply"
            ? {
                kind: "create_review_comment_reply",
                method: "POST",
                path: `/repos/${repo}/pulls/${PR_NUMBER}/comments/${COMMENT_ID}/replies`,
                body: { body: BODY_TEXT },
                note: `reply to review comment ${COMMENT_ID} on #${PR_NUMBER}`,
                pr: PR_NUMBER,
              }
            : {
                kind: "create_review",
                method: "POST",
                path: `/repos/${repo}/pulls/${PR_NUMBER}/reviews`,
                body: {
                  commit_id: commitId,
                  event: action.kind === "approve" ? "APPROVE" : action.event,
                  body: BODY_TEXT,
                  comments: [],
                },
                note: `post review on #${PR_NUMBER}`,
                pr: PR_NUMBER,
              };
        const result = await gate.execute(intent);
        if (result.blocked) return { ...NOTHING, blocked: result.blocked as Blocked };
        mkdirSync(dryrunDir(), { recursive: true });
        return outcomeOf(readRecords(dryrunDir()));
      } finally {
        store.close();
      }
    },
  };
}

/** Both routes over the rig's world, shell first. */
export function routes(s: GuardsShellRig): Route[] {
  return [shellRoute(s), nodeRoute(s)];
}
