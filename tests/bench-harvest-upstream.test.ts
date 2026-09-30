// bench/aacr/harvest_upstream.py, run for real on fixture API answers (no
// network: --fetch is never passed, the raw cache is pre-seeded). What it must
// guarantee: every inline comment and every low-confidence body item becomes
// one scored comment, the overview stays review body, only the bot's own
// reviews count, and a comment made on an EARLIER commit keeps its line only
// when the code around it is provably unchanged — otherwise it is path-only.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const HEAD = "h".repeat(40);
const OLD = "e".repeat(40);
const AT_HEAD = "o__a@hhhhhhh";
const EARLIER = "o__b@hhhhhhh";
const NO_BOT = "o__c@hhhhhhh";

let t: string;
beforeEach(() => {
  t = mkdtempSync(join(tmpdir(), "qcr-harvest-"));
  const kase = (id: string) => ({ instance_id: id, repo: "o/x", base_commit: "b".repeat(40), head_commit: HEAD });
  mkdirSync(join(t, "sets"));
  writeFileSync(join(t, "sets", "dev10.json"), JSON.stringify({ dataset: {}, cases: [kase(AT_HEAD), kase(EARLIER), kase(NO_BOT)] }));
  const api = join(t, "api");
  mkdirSync(api);
  const bot = { login: "copilot-pull-request-reviewer[bot]", type: "Bot" };
  const human = { login: "someone", type: "User" };
  const body =
    "## Pull Request Overview\n\nSummary text.\n\n<details>\n<summary>Comments suppressed due to low confidence (2)</summary>\n\n" +
    "**src/a.ts:7**\n* [nitpick] Rename `x`.\n```\nconst x = 1\n```\n**src/b.ts:3**\n* Possible null.\n```\nfoo()\n```\n</details>\n";
  writeFileSync(join(api, `${AT_HEAD}.reviews.json`), JSON.stringify([
    { id: 1, user: bot, state: "COMMENTED", submitted_at: "2025-05-01T00:00:00Z", commit_id: HEAD, body },
    { id: 2, user: human, state: "APPROVED", submitted_at: "2025-05-02T00:00:00Z", commit_id: HEAD, body: "lgtm" },
  ]));
  writeFileSync(join(api, `${AT_HEAD}.comments.json`), JSON.stringify([
    { user: { login: "Copilot" }, path: "src/a.ts", original_line: 12, original_start_line: 10, side: "RIGHT", original_commit_id: HEAD, body: "Off by one.", pull_request_review_id: 1 },
    { user: { login: "Copilot" }, path: "src/a.ts", original_line: 12, side: "RIGHT", original_commit_id: HEAD, body: "reply", in_reply_to_id: 9 },
    { user: human, path: "src/a.ts", original_line: 3, side: "RIGHT", original_commit_id: HEAD, body: "human note" },
  ]));
  writeFileSync(join(api, `${EARLIER}.reviews.json`), JSON.stringify([
    { id: 3, user: bot, state: "COMMENTED", submitted_at: "2025-04-01T00:00:00Z", commit_id: OLD, body: "Copilot reviewed 2 files." },
  ]));
  writeFileSync(join(api, `${EARLIER}.comments.json`), JSON.stringify([
    { user: { login: "Copilot" }, path: "same.c", original_line: 5, side: "RIGHT", original_commit_id: OLD, body: "same file" },
    { user: { login: "Copilot" }, path: "ctx.c", original_line: 5, side: "RIGHT", original_commit_id: OLD, body: "context unchanged" },
    { user: { login: "Copilot" }, path: "moved.c", original_line: 5, side: "RIGHT", original_commit_id: OLD, body: "context changed" },
    { user: { login: "Copilot" }, path: "gone.c", original_line: 5, side: "RIGHT", original_commit_id: OLD, body: "file unreadable" },
  ]));
  writeFileSync(join(api, `${NO_BOT}.reviews.json`), JSON.stringify([{ id: 4, user: human, commit_id: HEAD, body: "" }]));
  const lines = (n: number, tag = "") => Array.from({ length: n }, (_, i) => `l${i + 1}${tag}`).join("\n");
  const put = (sha: string, p: string, s: string) => {
    mkdirSync(join(t, "raw", sha), { recursive: true });
    writeFileSync(join(t, "raw", sha, p), s);
  };
  put(OLD, "same.c", lines(20));
  put(HEAD, "same.c", lines(20));
  put(OLD, "ctx.c", lines(20));
  put(HEAD, "ctx.c", lines(20).replace("l15", "CHANGED"));
  put(OLD, "moved.c", lines(20));
  put(HEAD, "moved.c", "inserted\n" + lines(20));
});
afterEach(() => rmSync(t, { recursive: true, force: true }));

const harvest = () =>
  run("python3", [
    join(ROOT, "bench", "aacr", "harvest_upstream.py"),
    "--api", join(t, "api"), "--out", join(t, "runs"), "--prefix", "up", "--sets-dir", join(t, "sets"),
    "--raw-cache", join(t, "raw"),
  ]);
const read = (...p: string[]) => JSON.parse(readFileSync(join(t, "runs", "up-dev10", ...p), "utf8"));

describe("harvest_upstream.py", () => {
  it("writes only the cases the bot reviewed, as a harvested (non-arm) run", async () => {
    await harvest();
    const r = read("run.json");
    expect(r.cases.sort()).toEqual([AT_HEAD, EARLIER].sort());
    expect(r.kind).toBe("harvested-upstream-reviews");
    expect(r.reviewer).toBeNull(); // scored on the harness's OCR reader, like every arm
    expect(r.reviewed_earlier_commit).toEqual({ [EARLIER]: [OLD] });
  });

  it("scores inline comments with their span and low-confidence body items, never the overview, replies or humans", async () => {
    await harvest();
    const c = read("results", "all", `${AT_HEAD}.json`).review.comments;
    expect(c).toEqual([
      { path: "src/a.ts", start_line: 7, end_line: 7, content: "[nitpick] Rename `x`.\n```\nconst x = 1\n```" },
      { path: "src/b.ts", start_line: 3, end_line: 3, content: "Possible null.\n```\nfoo()\n```" },
      { path: "src/a.ts", start_line: 10, end_line: 12, content: "Off by one." },
    ]);
    const md = readFileSync(join(t, "runs", "up-dev10", "cases", AT_HEAD, "review.md"), "utf8");
    expect(md).toContain("Summary text.");
    expect(md).not.toContain("suppressed");
    expect(read("cases", AT_HEAD, "case-summary.json").by_source).toEqual({ inline: 1, "body-low-confidence": 2 });
  });

  it("keeps an earlier commit's line only when the file or its context is unchanged", async () => {
    await harvest();
    const c = read("results", "all", `${EARLIER}.json`).review.comments;
    const line = (p: string) => c.find((x: { path: string }) => x.path === p).start_line;
    expect(line("same.c")).toBe(5); // byte-identical file
    expect(line("ctx.c")).toBe(5); // change outside lines 2..8
    expect(line("moved.c")).toBeNull(); // shifted: path-only
    expect(line("gone.c")).toBeNull(); // unreadable: path-only
    const how = Object.fromEntries(read("run.json").line_drift[EARLIER].map((d: { path: string; mapping: string }) => [d.path, d.mapping]));
    expect(how).toEqual({ "same.c": "identical-file", "ctx.c": "identical-context", "moved.c": "dropped-line", "gone.c": "dropped-line" });
  });
});
