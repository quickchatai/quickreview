// `scripts/render-review.sh <pr> <round>` → this. Renders the round's posted
// review from its findings record (src/reviewrender.ts) into the two pinned
// scratch files the posting scripts read, and prints what it rendered and
// what the record lacked. It reads the record and writes the two files (and,
// when the duplicate-merge post-check merged anything, the record back with
// those dispositions), all under state/; it never posts and never reaches
// GitHub.
//
// The render step is `renderPostedReview` with `postedRenderOptions(cfg)` —
// the same two calls the bench runner makes (src/bench/runner.ts
// renderBenchOutputs), pinned equal by tests/dedup-parity.test.ts.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, REVIEW_DEFAULTS } from "./config.js";
import {
  postedRenderOptions,
  renderPostedReview,
  type PostedRenderConfig,
  type RenderedReview,
} from "./reviewrender.js";
import type { PostCheckMerge } from "./dedup.js";

/** Render one round's files from its record. Pure apart from the files under
 * `root/state/` it reads and writes. */
export function renderRound(
  root: string,
  pr: number,
  round: number,
  cfg: PostedRenderConfig,
): { rendered: RenderedReview; merges: PostCheckMerge[]; body: string; comments: string } | { error: string } {
  const recordPath = join(root, "state", "findings", `pr-${pr}-round-${round}.json`);
  let record: unknown;
  try {
    record = JSON.parse(readFileSync(recordPath, "utf8"));
  } catch (err) {
    return { error: `cannot read ${recordPath}: ${String(err)}` };
  }
  const out = renderPostedReview(record, postedRenderOptions(cfg));
  const body = join(root, "state", `pr-${pr}-round-${round}-review.md`);
  const comments = join(root, "state", `pr-${pr}-round-${round}-comments.json`);
  writeFileSync(body, out.rendered.body);
  writeFileSync(comments, JSON.stringify(out.rendered.comments, null, 2) + "\n");
  if (out.merges.length) writeFileSync(recordPath, JSON.stringify(out.record, null, 2) + "\n");
  return { rendered: out.rendered, merges: out.merges, body, comments };
}

/** The install's render config: the live config when it loads, else the
 * shipped defaults (a render must never fail for want of a config). */
function renderConfig(botLogin: string | undefined): PostedRenderConfig {
  let review: PostedRenderConfig["review"] = { dedup_merge: REVIEW_DEFAULTS.dedup_merge };
  try {
    review = { dedup_merge: loadConfig().review.dedup_merge };
  } catch {
    // no readable config: the defaults stand
  }
  return { review, ...(botLogin ? { github: { bot_login: botLogin } } : {}) };
}

function main(argv: string[]): number {
  const [root, prRaw, roundRaw, botLogin] = argv;
  if (!root || !/^\d+$/.test(prRaw ?? "") || !/^\d+$/.test(roundRaw ?? "")) {
    console.error("usage: render-review <sandbox-root> <pr> <round> [bot-login]");
    return 2;
  }
  const res = renderRound(root, Number(prRaw), Number(roundRaw), renderConfig(botLogin));
  if ("error" in res) {
    console.error(`render-review: ${res.error}`);
    return 1;
  }
  console.log(
    `render-review: ${res.rendered.comments.length} inline comment(s), ${res.rendered.in_body} in the body → ${res.body} + ${res.comments}`,
  );
  for (const m of res.merges)
    console.log(`render-review: post-check merged ${m.follower} into ${m.lead} (${m.path}:${m.line})`);
  for (const p of res.rendered.problems) console.log(`render-review: record problem — ${p}`);
  return 0;
}

if (process.argv[1]?.endsWith("reviewrendercli.js")) process.exitCode = main(process.argv.slice(2));
