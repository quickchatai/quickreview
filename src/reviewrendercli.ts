// `scripts/render-review.sh <pr> <round>` → this. Renders the round's posted
// review from its findings record (src/reviewrender.ts) into the two pinned
// scratch files the posting scripts read, and prints what it rendered and
// what the record lacked. It reads one file and writes two, under state/;
// it never posts and never reaches GitHub.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { renderReviewFromRecord } from "./reviewrender.js";

function main(argv: string[]): number {
  const [root, prRaw, roundRaw, botLogin] = argv;
  if (!root || !/^\d+$/.test(prRaw ?? "") || !/^\d+$/.test(roundRaw ?? "")) {
    console.error("usage: render-review <sandbox-root> <pr> <round> [bot-login]");
    return 2;
  }
  const pr = Number(prRaw);
  const round = Number(roundRaw);
  const recordPath = join(root, "state", "findings", `pr-${pr}-round-${round}.json`);
  let record: unknown;
  try {
    record = JSON.parse(readFileSync(recordPath, "utf8"));
  } catch (err) {
    console.error(`render-review: cannot read ${recordPath}: ${String(err)}`);
    return 1;
  }
  const out = renderReviewFromRecord(record, botLogin ? { botLogin } : {});
  const body = join(root, "state", `pr-${pr}-round-${round}-review.md`);
  const comments = join(root, "state", `pr-${pr}-round-${round}-comments.json`);
  writeFileSync(body, out.body);
  writeFileSync(comments, JSON.stringify(out.comments, null, 2) + "\n");
  console.log(
    `render-review: ${out.comments.length} inline comment(s), ${out.in_body} in the body → ${body} + ${comments}`,
  );
  for (const p of out.problems) console.log(`render-review: record problem — ${p}`);
  return 0;
}

process.exitCode = main(process.argv.slice(2));
