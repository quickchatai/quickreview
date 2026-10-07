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
// renderBenchOutputs), pinned equal by tests/dedup-parity.test.ts. One thing
// is this route's alone (S6): every inline comment carries the hidden
// `<!-- qcr:f=<round>:<finding key> -->` marker, which is how the daemon links
// a posted comment back to its `round_findings` row. The bench never asks for
// it, so its outputs stay byte-identical (the parity test strips the marker
// and compares the rest).
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, REVIEW_DEFAULTS } from "./config.js";
import { applyProfilePosting } from "./postingpolicy.js";
import { loadProfilePosting } from "./profiles.js";
import {
  postedRenderOptions,
  renderPostedReview,
  type PolicyWithheld,
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
):
  | {
      rendered: RenderedReview;
      merges: PostCheckMerge[];
      withheld: PolicyWithheld[];
      body: string;
      comments: string;
    }
  | { error: string } {
  const recordPath = join(root, "state", "findings", `pr-${pr}-round-${round}.json`);
  let record: unknown;
  try {
    record = JSON.parse(readFileSync(recordPath, "utf8"));
  } catch (err) {
    return { error: `cannot read ${recordPath}: ${String(err)}` };
  }
  const out = renderPostedReview(record, {
    ...postedRenderOptions(cfg),
    findingMarkers: { roundNo: round },
  });
  const body = join(root, "state", `pr-${pr}-round-${round}-review.md`);
  const comments = join(root, "state", `pr-${pr}-round-${round}-comments.json`);
  writeFileSync(body, out.rendered.body);
  writeFileSync(comments, JSON.stringify(out.rendered.comments, null, 2) + "\n");
  if (out.record !== record) writeFileSync(recordPath, JSON.stringify(out.record, null, 2) + "\n");
  return { rendered: out.rendered, merges: out.merges, withheld: out.withheld, body, comments };
}

/** The install's render config: the live config when it loads, else the
 * shipped defaults (a render must never fail for want of a config). */
function renderConfig(root: string, botLogin: string | undefined): PostedRenderConfig {
  let review: PostedRenderConfig["review"] = { dedup_merge: REVIEW_DEFAULTS.dedup_merge };
  let posting: PostedRenderConfig["posting"];
  try {
    const loaded = loadConfig();
    review = { dedup_merge: loaded.review.dedup_merge };
    // The profile's `[posting]` policy, overlaid exactly as the daemon does
    // (wire.ts buildParts) — so this route enforces the cut the bench does.
    posting = applyProfilePosting(loaded, loadProfilePosting(root, loaded.review.profile)).posting;
  } catch {
    // no readable config or profile: the defaults stand (no cut)
  }
  return {
    review,
    ...(posting ? { posting } : {}),
    ...(botLogin ? { github: { bot_login: botLogin } } : {}),
  };
}

function main(argv: string[]): number {
  const [root, prRaw, roundRaw, botLogin] = argv;
  if (!root || !/^\d+$/.test(prRaw ?? "") || !/^\d+$/.test(roundRaw ?? "")) {
    console.error("usage: render-review <sandbox-root> <pr> <round> [bot-login]");
    return 2;
  }
  const res = renderRound(root, Number(prRaw), Number(roundRaw), renderConfig(root, botLogin));
  if ("error" in res) {
    console.error(`render-review: ${res.error}`);
    return 1;
  }
  console.log(
    `render-review: ${res.rendered.comments.length} inline comment(s), ${res.rendered.in_body} in the body → ${res.body} + ${res.comments}`,
  );
  for (const w of res.withheld)
    console.log(`render-review: posting policy withheld ${w.id} (${w.word})`);
  for (const m of res.merges)
    console.log(
      `render-review: post-check merged ${m.follower} into ${m.lead} (${m.path}:${m.line})`,
    );
  for (const p of res.rendered.problems) console.log(`render-review: record problem — ${p}`);
  return 0;
}

if (process.argv[1]?.endsWith("reviewrendercli.js")) process.exitCode = main(process.argv.slice(2));
