// The dataset's state-machine study (`state_machines/`, its two runs and a preliminary third, unlabelled): the
// export copies the folder only when it is the committed manifest's, validation.json checks it and recomputes
// every number of the study from its tables,
// the claims verifier reads those numbers by name, and the card links the folder and counts its checks
// apart. Runs for real under python3, standard library only, on a small study of .jsonl tables (two pull
// requests, neutral planted names):
//
//   1. the manifest: a folder with a file missing, extra or changed is refused before anything is copied,
//      and fails validation.json's manifest check; without the folder every check fails;
//   2. validation.json's checks pass on a whole folder whose numbers are the expected ones, and each fails
//      on what it guards (a column, each way a row can fail to fit the others, the README, a label that
//      repeats the answer key's words, every recomputed number);
//   3. the claims verifier: claim_metrics.StateMachines gives the numbers by name, discover finds the
//      folder beside the tables, and its release checks carry needs ["state_machines"];
//   4. the export and the card: the leak scan reads the folder's tables, a state_machines key links no arm,
//      the card links the folder and lists its tables, and the release checks' split counts its checks;
//   5. the build: the folder's rows from small run dirs and label files (the judge's ids of the posted
//      comments, a finding posted in the review body, the class spellings, reachability, the blind
//      re-checks, the answer key's words cut from a reason) and its refusals.

import { afterAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const AACR = join(ROOT, "bench", "aacr");
const RECOMPUTE = join(AACR, "recompute");
const tmp = mkdtempSync(join(tmpdir(), "hf-state-machines-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const SCRUB_ENV = {
  QCR_SCRUB_HOME: "/home/alice",
  QCR_SCRUB_RUNS_DIR: "/home/alice/projects/qcr-bench-runs",
  QCR_SCRUB_OWNER: "Jordan",
  QCR_SCRUB_BOT: "acme-review,acme-review-2",
  QCR_SCRUB_OLD_NAME: "acme-reviewd",
  QCR_SCRUB_PRIVATE_REPO: "widgetco-app",
};

function py(code: string, ...args: string[]): unknown {
  const p = spawnSync(
    "python3",
    [
      "-c",
      `import sys, json, types, collections; sys.path.insert(0, ${JSON.stringify(RECOMPUTE)}); sys.path.insert(0, ${JSON.stringify(AACR)})\n${code}`,
      ...args,
    ],
    { encoding: "utf8", env: { ...process.env, ...SCRUB_ENV } },
  );
  if (p.status !== 0) throw new Error(p.stderr);
  return JSON.parse(p.stdout);
}

type Row = Record<string, unknown>;

function jsonl(dir: string, name: string, rows: Row[]): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.jsonl`), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

function rows(dir: string, name: string): Row[] {
  return readFileSync(join(dir, `${name}.jsonl`), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as Row);
}

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : [p];
  });
}

/** A sha256sum manifest of a dataset root's state_machines/ (paths relative to the root). */
function manifest(root: string, path: string): string {
  const lines = files(join(root, "state_machines"))
    .sort()
    .map(
      (p) => `${createHash("sha256").update(readFileSync(p)).digest("hex")}  ${relative(root, p)}`,
    );
  writeFileSync(path, lines.join("\n") + "\n");
  return path;
}

const S = "sm4-p"; // the state-machine review
const D = "sm1-c"; // the default review
const A = "sm5-a"; // the preliminary third run: the state-machine review with GPT-6.2 Astra, unlabelled

/**
 * A study on two PRs. Answer key: p1/D1 state (old list), p1/D2 not (old list), p2/D1 state but not
 * reachable at head, p2/D2 borderline, p2/D3 state. The state review finds p1/D1 and only partly p2/D3; the
 * default review finds p1/D1, p1/D2 and p2/D3 and partly p2/D2. Pool: the two reachable state defects and
 * three unlisted bugs (both, state only, default only). The third run (A, no labels) finds p1/D1, p1/D2 and
 * p2/D1 (not reachable) and partly p2/D3, with three inline comments on p1 and one plus a review-body finding
 * on p2.
 */
function dataset(root: string): void {
  const sm = join(root, "state_machines");
  mkdirSync(join(root, "data"), { recursive: true });
  const commit = {
    qcr_commit_on_public_main: true,
    qcr_commit_match: "same",
    qcr_commit_dirty: false,
  };
  jsonl(sm, "arms", [
    {
      arm_id: S,
      display_name: "State",
      image: "img:a",
      image_id: "sha256:a",
      config: "c",
      profile: "state-machines",
      qcr_commit: "a1",
      ...commit,
      pi: "1",
      reviewer_model: "m",
      judge_model: "m",
      runs: [`${S}-x`],
      prs: 2,
      note: "n",
    },
    {
      arm_id: D,
      display_name: "Default",
      image: "img:b",
      image_id: "sha256:b",
      config: "c",
      profile: null,
      qcr_commit: "b1",
      qcr_commit_on_public_main: false,
      qcr_commit_match: null,
      qcr_commit_dirty: false,
      pi: "1",
      reviewer_model: "m",
      judge_model: "m",
      runs: [`${D}-x`],
      prs: 2,
      note: "n",
    },
    {
      arm_id: A,
      display_name: "Astra",
      image: "img:c",
      image_id: "sha256:c",
      config: "c",
      profile: "state-machines",
      qcr_commit: "c1",
      qcr_commit_on_public_main: false,
      qcr_commit_match: null,
      qcr_commit_dirty: false,
      pi: "1",
      reviewer_model: "m2",
      judge_model: "m",
      runs: [`${A}-x`],
      prs: 2,
      note: "n",
    },
  ]);
  const kase = (arm: string, pr: string, usd: number, minutes: number, n_posted: number) => ({
    arm_id: arm,
    instance_id: pr,
    set: "x",
    run: `${arm}-x`,
    status: "ok",
    verdict: "COMMENT",
    usd,
    minutes,
    n_posted,
    judged: true,
    judge_input_tokens: 1,
    judge_output_tokens: 1,
    judge_cache_read_tokens: 0,
  });
  jsonl(sm, "cases", [
    kase(S, "p1", 2, 10, 2),
    kase(S, "p2", 3, 14, 2),
    kase(D, "p1", 1, 20, 1),
    kase(D, "p2", 2, 30, 2),
    kase(A, "p1", 10, 12, 3),
    kase(A, "p2", 20, 16, 1),
  ]);
  const rev = (arm: string, pr: string, index: number | null, comment_id: string | null) => ({
    arm_id: arm,
    instance_id: pr,
    index,
    inline: index !== null,
    path: "a.c",
    line: 10 + (index ?? 9),
    side: "RIGHT",
    body: `[blocker] T${index}\n\nbody`,
    comment_id,
  });
  jsonl(sm, "reviews", [
    rev(S, "p1", 0, "C1"),
    rev(S, "p1", 1, "C2"),
    rev(S, "p2", 0, "C1"),
    rev(S, "p2", 1, "C2"),
    rev(D, "p1", 0, "C1"),
    rev(D, "p2", 0, "C1"),
    rev(D, "p2", 1, "C2"),
    rev(D, "p2", null, "C3"), // a finding posted in the review body
    rev(A, "p1", 0, "C1"),
    rev(A, "p1", 1, "C2"),
    rev(A, "p1", 2, "C3"),
    rev(A, "p2", 0, "C1"),
    rev(A, "p2", null, "C2"),
  ]);
  const dv = (arm: string, pr: string, defect_id: string, verdict: string) => ({
    arm_id: arm,
    instance_id: pr,
    judge: "j",
    key_version: "2",
    defect_id,
    verdict,
    credit: verdict === "found" ? 1 : verdict === "partial" ? 0.5 : 0,
    comment_ids: [],
    why: "w",
  });
  jsonl(sm, "defect_verdicts", [
    dv(S, "p1", "D1", "found"),
    dv(S, "p1", "D2", "missed"),
    dv(S, "p2", "D1", "missed"),
    dv(S, "p2", "D2", "missed"),
    dv(S, "p2", "D3", "partial"),
    dv(D, "p1", "D1", "found"),
    dv(D, "p1", "D2", "found"),
    dv(D, "p2", "D1", "missed"),
    dv(D, "p2", "D2", "partial"),
    dv(D, "p2", "D3", "found"),
    dv(A, "p1", "D1", "found"),
    dv(A, "p1", "D2", "found"),
    dv(A, "p2", "D1", "found"),
    dv(A, "p2", "D2", "missed"),
    dv(A, "p2", "D3", "partial"),
  ]);
  const cv = (
    arm: string,
    pr: string,
    comment_id: string,
    index: number | null,
    grade: string,
    defect_id: string | null,
  ) => ({
    arm_id: arm,
    instance_id: pr,
    judge: "j",
    comment_id,
    index,
    grade,
    defect_id,
    new_defect: false,
    why: "w",
  });
  jsonl(sm, "comment_verdicts", [
    cv(S, "p1", "C1", 0, "correct-valuable", "D1"),
    cv(S, "p1", "C2", 1, "correct-minor", null),
    cv(S, "p2", "C1", 0, "correct-valuable", null),
    cv(S, "p2", "C2", 1, "incorrect", null),
    cv(D, "p1", "C1", 0, "correct-valuable", "D2"),
    cv(D, "p2", "C1", 0, "correct-valuable", "D3"),
    cv(D, "p2", "C2", 1, "correct-valuable", null),
    cv(D, "p2", "C3", null, "correct-minor", null), // judged, posted in the review body
    cv(A, "p1", "C1", 0, "correct-valuable", "D1"),
    cv(A, "p1", "C2", 1, "correct-valuable", "D2"),
    cv(A, "p1", "C3", 2, "incorrect", null),
    cv(A, "p2", "C1", 0, "correct-valuable", "D1"),
    cv(A, "p2", "C2", null, "correct-minor", null),
  ]);
  const lab = (
    pr: string,
    defect_id: string,
    verdict: string,
    old45: boolean,
    reachable = true,
    how = "agree",
  ) => ({
    instance_id: pr,
    defect_id,
    verdict,
    klass: verdict === "not" ? null : "event-order",
    how,
    old45,
    reachable,
    votes: [
      { reader: 1, verdict, klass: null, reason: "a reader's reason", state: null, event: null },
    ],
  });
  jsonl(sm, "state_labels", [
    lab("p1", "D1", "state_machine", true),
    lab("p1", "D2", "not", true),
    lab("p2", "D1", "state_machine", false, false, "tiebreak"),
    lab("p2", "D2", "borderline", false),
    lab("p2", "D3", "state_machine", false),
  ]);
  const csl = (
    arm: string,
    pr: string,
    index: number,
    verdict: string,
    first: string,
    second: string | null,
  ) => ({
    arm_id: arm,
    instance_id: pr,
    index,
    title: "t",
    verdict,
    klass: null,
    reason: "r",
    first_verdict: first,
    second_read_verdict: second,
    second_read_agrees: second === null ? null : second === first,
    second_read_reason: second && "s",
    key_defect: null,
    real_if_unlisted: "n/a",
  });
  jsonl(sm, "comment_state_labels", [
    csl(S, "p1", 0, "state_machine", "state_machine", null),
    csl(S, "p1", 1, "not", "not", "not"),
    csl(S, "p2", 0, "borderline", "not", "borderline"),
    csl(S, "p2", 1, "not", "not", "not"),
    csl(D, "p2", 1, "state_machine", "state_machine", null),
  ]);
  const bug = (
    pr: string,
    local: string,
    source: string,
    klass: string,
    s: number[] | null,
    d: number[] | null,
    blind: string | null = null,
  ) => ({
    bug_id: `${pr}#${local}`,
    instance_id: pr,
    local_id: local,
    source,
    klass,
    // an answer-key row's flags are the judge's verdicts and it lists no comments; an unlisted row lists
    // the inline comments that raise it
    state_found: source === "unlisted" ? s!.length > 0 : s !== null,
    default_found: source === "unlisted" ? d!.length > 0 : d !== null,
    statement: source === "unlisted" ? "ours" : null,
    state_review_comments: source === "unlisted" ? s : null,
    default_review_comments: source === "unlisted" ? d : null,
    check_reason: null,
    blind_verdict: blind,
    blind_agrees: blind === null ? null : true,
    blind_reason: blind && "b",
  });
  jsonl(sm, "pooled_bugs", [
    bug("p1", "D1", "answer-key", "event-order", [], []),
    bug("p2", "D3", "answer-key", "stale-copy", null, []),
    bug("p1", "U1", "unlisted", "event-order", [0], [0]),
    bug("p2", "U1", "unlisted", "lifecycle-order", [0], [], "state"),
    bug("p2", "U2", "unlisted", "stored-state", [], [1], "default"),
  ]);
  const miss = (pr: string, defect_id: string, cause: string) => ({
    instance_id: pr,
    defect_id,
    cause,
    owning_lens: "pass-sm-events",
    planned_lenses: ["pass-sm-events"],
    what_would_have_caught_it: "w",
    second_read_verdict: null,
    second_read_agrees: null,
    second_read_reason: null,
    relabel_note: null,
  });
  jsonl(sm, "misses", [
    miss("p2", "D1", "defect_not_real_or_unreachable"),
    miss("p2", "D3", "site_read_nothing_reported"),
  ]);
  const ea = (arm: string, found: string[]) =>
    ["p1#D1", "p2#D1", "p2#D3"].map((k) => ({
      arm_id: arm,
      description: "d",
      instance_id: k.split("#")[0],
      defect_id: k.split("#")[1],
      found: found.includes(k),
    }));
  jsonl(sm, "earlier_arms", [
    ...ea("sm1-s4", ["p1#D1"]),
    ...ea("sm1-s8", []),
    ...ea("sm1-s8d", ["p2#D3"]),
    ...ea("sm1-r", ["p1#D1", "p2#D1", "p2#D3"]),
  ]);
  mkdirSync(join(sm, "figures"), { recursive: true });
  writeFileSync(join(sm, "figures", "fig1.svg"), "<svg/>\n");
  // the answer key's own text, beside the folder as the dataset's `defects` table holds it
  jsonl(join(root, "data"), "defects", [
    {
      instance_id: "p1",
      defect_id: "D1",
      title: "Toggle lost",
      statement: KEY_STATEMENT,
      evidence: "e",
      counts_if: null,
    },
  ]);
  writeReadme(sm);
}

/** Ten words and more of an answer-key defect's statement (a label may not repeat ten in a row). */
const KEY_STATEMENT =
  "Two opposite toggles in one batch collapse into a single queue entry so the observer never sees the change.";

/** The folder's README as its tables give it (state_machines.readme of numbers()). */
function writeReadme(sm: string): void {
  writeFileSync(
    join(sm, "README.md"),
    py(
      "import state_machines as SM\nprint(json.dumps(SM.readme(SM.numbers(sys.argv[1]))))",
      sm,
    ) as string,
  );
}

/** The fixture's numbers, in POST's shape: what the checks must recompute. */
const POST = {
  prs: 2,
  relabel: { total: 5, state: 3, borderline: 1, not: 1, reachable: 2, state_not_old45: 2 },
  old45: { total: 2, state: 1, borderline: 0, not: 1, found_default: 2 },
  key_found: { [S]: 1, [D]: 2, "sm1-s4": 1, "sm1-s8": 0, "sm1-s8d": 1, "sm1-r": 2 },
  key_only: { state_not_default: 0, default_not_state: 1, default_not_state_ids: ["p2#D3"] },
  pool: { total: 5, key: 2, unlisted: 3, [S]: 3, [D]: 4, union: 5 },
  unlisted: { both: 1, state_only: 1, default_only: 1, blind_checked: 2, blind_agree: 2 },
  classes: {
    "event-order": [2, 2, 2],
    "stale-copy": [1, 0, 1],
    "lifecycle-order": [1, 1, 0],
    "stored-state": [1, 0, 1],
    "stuck-state": [0, 0, 0],
    "unhandled-state": [0, 0, 0],
    "unchecked-transition": [0, 0, 0],
    "impossible-states": [0, 0, 0],
  },
  shares: {
    key: { [S]: 50, [D]: 100, "sm1-s4": 50, "sm1-s8": 0, "sm1-s8d": 50 },
    pool: { [S]: 60, [D]: 80, union: 100 },
    state_comments_not: 50,
  },
  comments: {
    [S]: 4,
    state: 1,
    borderline: 1,
    not: 2,
    not_judged_correct: 1,
    [D]: 3,
    per_pr_state: 2,
    per_pr_default: 1.5,
    per_pr_union: 3.5,
  },
  default_found_any: { found: 3, of: 5 },
  misses: {
    total: 2,
    real: 1,
    site_read_nothing_reported: 1,
    reported_a_different_problem: 0,
    defect_not_real_or_unreachable: 1,
  },
  cost: { usd_per_pr_state: 2.5, usd_per_pr_default: 1.5, usd_per_pr_both: 4 },
  astra: {
    key_found: 1,
    of: 2,
    share: 50,
    defects_found: 3,
    defects_of: 5,
    comments: 4,
    per_pr: 2,
    usd_per_pr: 15,
  },
};

const BASE = join(tmp, "base");
dataset(BASE);
const MANIFEST = manifest(BASE, join(tmp, "state-machines.sha256"));

/**
 * A copy of the base dataset, changed by `edit` (the manifest stays the base's unless re-made). Its README
 * is then rendered again from the changed tables, so a case judges the one check it aims at; `keepReadme`
 * leaves the README as `edit` left it.
 */
function variant(name: string, edit: (sm: string) => void, keepReadme = false): string {
  const root = join(tmp, name);
  const sm = join(root, "state_machines");
  cpSync(BASE, root, { recursive: true });
  edit(sm);
  if (!keepReadme && existsSync(join(sm, "README.md"))) {
    try {
      writeReadme(sm);
    } catch {
      // tables readme() cannot render (no common PRs): the README stays the base's, and fails its check
    }
  }
  return root;
}

/** Rewrite one table of a folder, row by row. */
function edit(sm: string, table: string, f: (r: Row) => Row | null): void {
  jsonl(
    sm,
    table,
    rows(sm, table)
      .map(f)
      .filter((r): r is Row => r !== null),
  );
}

type Check = { check: string; ok: boolean; got: unknown; want: unknown };

function checks(root: string, man = MANIFEST): Check[] {
  return py(
    `import state_machines as SM\nprint(json.dumps(SM.checks(sys.argv[1], sys.argv[2], ${JSON.stringify(POST)}), default=str))`,
    root,
    man,
  ) as Check[];
}

/** The checks a variant fails (its manifest re-made, so only the content is judged). */
function failing(root: string): string[] {
  return checks(root, manifest(root, join(root, "m.sha256")))
    .filter((c) => !c.ok)
    .map((c) => c.check.replace("state_machines: ", ""));
}

const C = {
  manifest:
    "every file is the committed manifest's (bench/aacr/hf/state-machines.sha256), none missing, extra or differing",
  columns: "every table has exactly its listed columns (no answer-key defect text)",
  whole:
    "the rows are whole: every run judged on the same pull requests, one verdict per run on every labelled answer-key defect, every judged comment a posted one (inline or in the review body), every labelled comment an inline one of the two labelled runs, the default review's labelled comments exactly its inline comments matched to no answer-key defect, and every unlisted bug found exactly by the reviews whose inline comments it lists",
  readme: "README.md is the README its tables give (state_machines.readme of numbers())",
  quotes:
    "no label text of ours repeats 10 words in a row of an answer-key defect's text (the dataset's `defects`)",
  prs: "every run reviewed the same pull requests",
  relabel:
    "the strict relabel of the answer-key defects: state, borderline and not, the state ones reachable at head, and the state ones not on the earlier list of 45",
  old45:
    "the earlier list of 45 state defects under the strict relabel, and how many of them the default review found",
  key_found:
    "answer-key recall on the reachable strict state defects (judge verdict found), of the two runs and the four earlier builds",
  key_only: "the reachable strict state defects one run found and the other did not, and which",
  pool: "the pool of known real state bugs (answer key + unlisted) and how many of them each run and either run found; the answer-key part's found flags are the judge's verdicts",
  unlisted:
    "the unlisted bugs found by both runs or by one, and the one-sided ones re-checked blind",
  classes: "per class of state bug: pool, state review, default review",
  shares:
    "the percentages: answer-key recall, the pool found, and the state review's comments about something else",
  comments:
    "the inline comments: the state review's by label after the second reads, its not-state ones the judge graded correct, the default review's, and comments per pull request",
  default_found_any: "the answer-key defects of every kind the default review found",
  misses: "the state review's misses on the strict state defects, by cause",
  cost: "list-price dollars per pull request (compare.usd_and_minutes), and both runs' exact combined cost rounded",
  astra:
    "the preliminary GPT-6.2 Astra run (sm5-a): answer-key recall on the reachable strict state defects and its share, the answer-key defects of every kind it found, its inline comments and comments per pull request, and list-price dollars per pull request (compare.usd_and_minutes)",
};

describe("state_machines: the manifest", () => {
  // MUTATION: in state_machines.manifest_problems, return no "extra" list (only missing and differs) — this fails
  // MUTATION: in hf_export.refuse_state_machines, return before the manifest check — this fails
  it("refuses a folder with a file missing, extra or changed, before anything is copied", () => {
    const extra = variant("extra", (sm) => writeFileSync(join(sm, "notes.md"), "x\n"));
    const changed = variant("changed", (sm) => appendFileSync(join(sm, "README.md"), " "), true);
    const missing = variant("missing", (sm) => rmSync(join(sm, "figures", "fig1.svg")));
    const copy = (root: string, out: string) =>
      py(
        `import hf_export as h
try:
    h.copy_state_machines(sys.argv[1], sys.argv[2], sys.argv[3]); print(json.dumps("copied"))
except SystemExit as e:
    print(json.dumps(str(e)))`,
        join(root, "state_machines"),
        out,
        MANIFEST,
      ) as string;
    const out = join(tmp, "copy-out");
    mkdirSync(out, { recursive: true });
    expect(copy(extra, out)).toMatch(
      /not the committed manifest's .*extra \['state_machines\/notes.md'\]/,
    );
    expect(copy(changed, out)).toMatch(/differs \['state_machines\/README.md'\]/);
    expect(copy(missing, out)).toMatch(/missing \['state_machines\/figures\/fig1.svg'\]/);
    expect(existsSync(join(out, "state_machines"))).toBe(false);
    expect(copy(BASE, out)).toBe("copied");
    expect(readFileSync(join(out, "state_machines", "README.md"), "utf8")).toBe(
      readFileSync(join(BASE, "state_machines", "README.md"), "utf8"),
    );
    expect(
      checks(extra)
        .filter((c) => !c.ok)
        .map((c) => c.check),
    ).toEqual([`state_machines: ${C.manifest}`]);
  });

  // MUTATION: in state_machines.checks, give the number checks `post.get(key)` as got when the folder is missing — this fails
  it("fails every check when the folder is not in the dataset (fails closed)", () => {
    const gone = variant("gone", (sm) => rmSync(sm, { recursive: true }));
    const cs = checks(gone);
    expect(cs).toHaveLength(19);
    expect(cs.filter((c) => c.ok)).toEqual([]);
  });

  it("the committed manifest is the release folder's: its README, the ten tables and the four charts", () => {
    const got = py(
      "import state_machines as SM\nprint(json.dumps(sorted(SM.read_manifest())))",
    ) as string[];
    const tables = py(
      "import state_machines as SM\nprint(json.dumps(list(SM.TABLES)))",
    ) as string[];
    const figs = py("import state_machines as SM\nprint(json.dumps(list(SM.FIGURES)))") as string[];
    expect(got).toEqual(
      [
        "state_machines/README.md",
        ...tables.map((t) => `state_machines/${t}.parquet`),
        ...figs.map((f) => `state_machines/figures/${f}`),
      ].sort(),
    );
  });
});

describe("state_machines: validation.json's checks", () => {
  it("passes all nineteen on a whole folder that is the manifest's, recomputing every number", () => {
    const cs = checks(BASE);
    expect(cs).toHaveLength(19);
    expect(cs.filter((c) => !c.ok)).toEqual([]);
    expect(cs.find((c) => c.check.endsWith(C.pool))!.got).toEqual(POST.pool);
  });

  it("POST holds the write-up's numbers", () => {
    const post = py("import state_machines as SM\nprint(json.dumps(SM.POST))") as typeof POST;
    expect(post.pool).toEqual({ total: 105, key: 55, unlisted: 50, [S]: 89, [D]: 75, union: 95 });
    expect(post.key_found).toEqual({
      [S]: 44,
      [D]: 45,
      "sm1-s4": 38,
      "sm1-s8": 39,
      "sm1-s8d": 43,
      "sm1-r": 46,
    });
    expect(post.relabel).toEqual({
      total: 186,
      state: 56,
      borderline: 2,
      not: 128,
      reachable: 55,
      state_not_old45: 21,
    });
    expect(post.old45).toEqual({ total: 45, state: 35, borderline: 2, not: 8, found_default: 36 });
    expect(post.key_only.default_not_state_ids).toEqual(["immich-app__immich@b7a1255#D2"]);
    expect(post.comments).toMatchObject({ [S]: 159, state: 96, borderline: 31, not: 32, [D]: 397 });
    expect(post.shares).toEqual({
      key: { [S]: 80, [D]: 82, "sm1-s4": 69, "sm1-s8": 71, "sm1-s8d": 78 },
      pool: { [S]: 85, [D]: 71, union: 90 },
      state_comments_not: 20,
    });
    // both runs together: the exact (94.62 + 94.30) / 34 = 5.5566, not 2.78 + 2.77
    expect(post.cost).toEqual({
      usd_per_pr_state: 2.78,
      usd_per_pr_default: 2.77,
      usd_per_pr_both: 5.56,
    });
    expect(post.misses).toEqual({
      total: 12,
      real: 11,
      site_read_nothing_reported: 5,
      reported_a_different_problem: 6,
      defect_not_real_or_unreachable: 1,
    });
    // the preliminary GPT-6.2 Astra run (sm5-a), as the card prints it
    expect(post.astra).toEqual({
      key_found: 52,
      of: 55,
      share: 95,
      defects_found: 152,
      defects_of: 186,
      comments: 448,
      per_pr: 13.2,
      usd_per_pr: 21.06,
    });
    expect(Object.keys(post).sort()).toEqual(Object.keys(POST).sort());
  });

  // MUTATION: in state_machines.checks, pass a table that has every listed column (set(want) <= set(c)) — this fails
  it("fails a table carrying a column it does not list (a defect's text)", () => {
    const bad = variant("columns", (sm) =>
      edit(sm, "state_labels", (r) => ({ ...r, statement: "the defect" })),
    );
    expect(failing(bad)).toEqual([C.columns]);
  });

  // MUTATION: in state_machines.whole_problems, compare the default review's labels with all its inline comments (drop the defect_id test) — this fails
  // MUTATION: in state_machines.whole_problems, skip the defect_verdicts comparison with state_labels — this fails
  it("fails rows that do not fit each other", () => {
    // a label on a default comment the judge matched to a defect
    const matched = variant("whole-matched", (sm) =>
      appendFileSync(
        join(sm, "comment_state_labels.jsonl"),
        JSON.stringify({ ...rows(sm, "comment_state_labels")[4]!, instance_id: "p1", index: 0 }) +
          "\n",
      ),
    );
    expect(failing(matched)).toContain(C.whole);
    // a verdict missing for one labelled defect
    const verdict = variant("whole-verdict", (sm) =>
      edit(sm, "defect_verdicts", (r) =>
        r.arm_id === S && r.defect_id === "D2" && r.instance_id === "p2" ? null : r,
      ),
    );
    expect(failing(verdict)).toEqual([C.whole]);
    // an answer-key row's flag that is not the judge's verdict: the pool still counts the verdict
    const flag = variant("whole-flag", (sm) =>
      edit(sm, "pooled_bugs", (r) => (r.bug_id === "p2#D3" ? { ...r, default_found: false } : r)),
    );
    expect(failing(flag)).toEqual([C.whole]);
    // a miss that is a defect the state review found
    const miss = variant("whole-miss", (sm) =>
      edit(sm, "misses", (r) =>
        r.defect_id === "D3" ? { ...r, instance_id: "p1", defect_id: "D1" } : r,
      ),
    );
    expect(failing(miss)).toEqual([C.whole]);
  });

  /** The problems whole_problems names for a variant's folder (only their names). */
  function problems(root: string): string[] {
    return py(
      "import state_machines as SM\nprint(json.dumps(sorted(SM.whole_problems(sys.argv[1]))))",
      join(root, "state_machines"),
    ) as string[];
  }

  // Each case breaks one guard of whole_problems and names exactly the problems it must raise, so deleting
  // any one guard drops its name and fails the case:
  // MUTATION: in state_machines.whole_problems, delete the `cases: not judged` guard — this fails
  // MUTATION: in state_machines.whole_problems, delete the inline index guard (`0..n-1`) — this fails
  // MUTATION: in state_machines.whole_problems, delete the `cases: n_posted differs` guard — this fails
  // MUTATION: in state_machines.whole_problems, delete the review-body row guard (index set or no judge's id) — this fails
  // MUTATION: in state_machines.whole_problems, test only `stray` in the label guard (drop `len(lab) != len(set(lab))`) — this fails
  // MUTATION: in state_machines.whole_problems, test only the repeat in the label guard (drop `stray or`) — this fails
  // MUTATION: in state_machines.whole_problems, delete the guard that every state-review inline comment has a label — this fails
  // MUTATION: in state_machines.whole_problems, delete the `reviews: a comment id the judge's verdicts lack` guard — this fails
  // MUTATION: in state_machines.whole_problems, delete the guard that every judged comment is a reviews row of its index — this fails
  // MUTATION: in state_machines.whole_problems, compare the defect verdicts as a set (`sorted(set(got)) != labelled`) — this fails
  // MUTATION: in state_machines.whole_problems, delete the unlisted bugs' flag guard — this fails
  // MUTATION: in state_machines.whole_problems, test only the flag in the unlisted guard (drop the posted-index test) — this fails
  // MUTATION: in state_machines.whole_problems, compare the defect verdicts of the study's two runs alone (`for a in ARMS`) — this fails
  // MUTATION: in state_machines.whole_problems, delete the guard on a label of a run the study did not label — this fails
  it.each([
    [
      "an unjudged case",
      (sm: string) =>
        edit(sm, "cases", (r) =>
          r.arm_id === S && r.instance_id === "p1" ? { ...r, judged: false } : r,
        ),
      ["cases: not judged"],
    ],
    [
      "a gap in a review's inline indices",
      (sm: string) => {
        const move = (r: Row) =>
          r.arm_id === D && r.instance_id === "p2" && r.comment_id === "C1"
            ? { ...r, index: 2 }
            : r;
        edit(sm, "reviews", move);
        edit(sm, "comment_verdicts", move);
      },
      ["reviews: inline comment indices are not 0..n-1"],
    ],
    [
      "n_posted off by one",
      (sm: string) =>
        edit(sm, "cases", (r) =>
          r.arm_id === D && r.instance_id === "p1" ? { ...r, n_posted: 2 } : r,
        ),
      ["cases: n_posted differs from the inline comments"],
    ],
    [
      "a review-body finding with an index",
      (sm: string) => {
        const body = (r: Row) => r.arm_id === D && r.comment_id === "C3";
        const move = (r: Row) => (body(r) ? { ...r, index: 5, defect_id: "D2" } : r);
        edit(sm, "reviews", (r) => (body(r) ? { ...r, index: 5 } : r));
        edit(sm, "comment_verdicts", move);
      },
      ["reviews: a finding in the review body with an index, or without the judge's id"],
    ],
    [
      "a label of no inline comment",
      (sm: string) =>
        appendFileSync(
          join(sm, "comment_state_labels.jsonl"),
          JSON.stringify({ ...rows(sm, "comment_state_labels")[0]!, arm_id: "sm9-x" }) + "\n",
        ),
      ["comment_state_labels: a label of no inline comment, or two labels of one"],
    ],
    [
      "two labels of one comment",
      (sm: string) =>
        appendFileSync(
          join(sm, "comment_state_labels.jsonl"),
          JSON.stringify(rows(sm, "comment_state_labels")[4]!) + "\n",
        ),
      ["comment_state_labels: a label of no inline comment, or two labels of one"],
    ],
    [
      "a state-review comment with no label",
      (sm: string) =>
        edit(sm, "comment_state_labels", (r) =>
          r.arm_id === S && r.instance_id === "p2" && r.index === 1 ? null : r,
        ),
      ["comment_state_labels: the state review's labels are not every one of its inline comments"],
    ],
    [
      "a review's comment id the judge never gave",
      (sm: string) =>
        edit(sm, "reviews", (r) =>
          r.arm_id === D && r.instance_id === "p1" ? { ...r, comment_id: "C9" } : r,
        ),
      [
        "comment_verdicts: a judged comment that is no reviews row, or another index than its row's",
        "reviews: a comment id the judge's verdicts lack",
      ],
    ],
    [
      "a judged comment that is no reviews row",
      (sm: string) =>
        appendFileSync(
          join(sm, "comment_verdicts.jsonl"),
          JSON.stringify({ ...rows(sm, "comment_verdicts")[0]!, comment_id: "C7", index: null }) +
            "\n",
        ),
      [
        "comment_verdicts: a judged comment that is no reviews row, or another index than its row's",
      ],
    ],
    [
      "a defect verdict given twice",
      (sm: string) =>
        appendFileSync(
          join(sm, "defect_verdicts.jsonl"),
          JSON.stringify(rows(sm, "defect_verdicts")[6]!) + "\n",
        ),
      ["defect_verdicts: sm1-c is not one verdict on each labelled defect"],
    ],
    [
      "a verdict missing from the third run",
      (sm: string) =>
        edit(sm, "defect_verdicts", (r) =>
          r.arm_id === A && r.instance_id === "p2" && r.defect_id === "D2" ? null : r,
        ),
      ["defect_verdicts: sm5-a is not one verdict on each labelled defect"],
    ],
    [
      "a label of the third run, which the study did not label",
      (sm: string) =>
        appendFileSync(
          join(sm, "comment_state_labels.jsonl"),
          JSON.stringify({ ...rows(sm, "comment_state_labels")[0]!, arm_id: A }) + "\n",
        ),
      ["comment_state_labels: a label of a run the study did not label"],
    ],
    [
      "an unlisted bug found by a review that lists no comment for it",
      (sm: string) =>
        edit(sm, "pooled_bugs", (r) =>
          r.bug_id === "p2#U1" ? { ...r, state_review_comments: [] } : r,
        ),
      ["pooled_bugs: an unlisted bug's found flag is not its listed inline comments"],
    ],
    [
      "an unlisted bug that lists a comment no review posted",
      (sm: string) =>
        edit(sm, "pooled_bugs", (r) =>
          r.bug_id === "p2#U1" ? { ...r, state_review_comments: [7] } : r,
        ),
      ["pooled_bugs: an unlisted bug's found flag is not its listed inline comments"],
    ],
  ] as [string, (sm: string) => void, string[]][])("fails %s", (name, change, want) => {
    const root = variant(`whole-${name.replace(/\W+/g, "-")}`, change);
    expect(problems(root)).toEqual(want);
    expect(failing(root)).toContain(C.whole);
  });

  // MUTATION: in state_machines.checks, compare README.md with anything but readme(numbers()) (`same = True`) — this fails
  it("fails a README that is not the one its tables give", () => {
    const stale = variant(
      "readme",
      (sm) => appendFileSync(join(sm, "README.md"), "\nThe state review found 99 of them.\n"),
      true,
    );
    expect(failing(stale)).toEqual([C.readme]);
  });

  // MUTATION: in state_machines.quote_problems, read only the defects' titles (key_text gives [d.get("title")]) — this fails
  // MUTATION: in state_machines.quote_problems, skip a vote's reason (LABEL_TEXT without "votes.reason") — this fails
  it("fails a label that repeats ten words of the answer key's text, and fails closed without `defects`", () => {
    const words = KEY_STATEMENT.split(" ").slice(2, 12).join(" ");
    const quoted = variant("quotes", (sm) =>
      edit(sm, "state_labels", (r) =>
        r.instance_id === "p1" && r.defect_id === "D1"
          ? {
              ...r,
              votes: [
                { ...(r.votes as Row[])[0]!, reason: `As the key says, ${words.toUpperCase()}!` },
              ],
            }
          : r,
      ),
    );
    expect(failing(quoted)).toEqual([C.quotes]);
    // nine words in a row are not a quote
    const nine = variant("quotes-nine", (sm) =>
      edit(sm, "state_labels", (r) =>
        r.instance_id === "p1" && r.defect_id === "D1"
          ? {
              ...r,
              votes: [
                {
                  ...(r.votes as Row[])[0]!,
                  reason: KEY_STATEMENT.split(" ").slice(2, 11).join(" "),
                },
              ],
            }
          : r,
      ),
    );
    expect(failing(nine)).toEqual([]);
    const gone = variant("quotes-gone", (sm) => rmSync(join(dirname(sm), "data", "defects.jsonl")));
    expect(failing(gone)).toEqual([C.quotes]);
  });

  // MUTATION: in state_machines.numbers, count relabel.reachable over every state row (drop `and r["reachable"]`) — this fails
  it("recomputes the strict relabel from state_labels", () => {
    const bad = variant("relabel", (sm) =>
      edit(sm, "state_labels", (r) =>
        r.defect_id === "D2" && r.instance_id === "p2" ? { ...r, verdict: "not" } : r,
      ),
    );
    expect(failing(bad)).toEqual([C.relabel]);
    const reach = variant("reach", (sm) =>
      edit(sm, "state_labels", (r) => ({ ...r, reachable: true })),
    );
    expect(failing(reach)).toEqual(expect.arrayContaining([C.relabel, C.key_found]));
  });

  // MUTATION: in state_machines.numbers, count old45 over every row (old = labels) — this fails
  it("recomputes the old list's split", () => {
    const bad = variant("old45", (sm) =>
      edit(sm, "state_labels", (r) =>
        r.defect_id === "D2" && r.instance_id === "p1" ? { ...r, old45: false } : r,
      ),
    );
    expect(failing(bad)).toEqual([C.old45]);
  });

  // MUTATION: in state_machines.numbers, count a partial verdict as found in `found` — this fails
  // MUTATION: in state_machines.numbers, count an earlier build's key over every strict defect (drop `& reach`) — this fails
  // MUTATION: in state_machines.numbers, compute key.default_not_state as found[STATE] - found[DEFAULT] — this fails
  it("recomputes answer-key recall from the judge's verdicts and the earlier builds' flags", () => {
    const bad = variant("key", (sm) =>
      edit(sm, "earlier_arms", (r) =>
        r.arm_id === "sm1-s8" && r.defect_id === "D3" ? { ...r, found: true } : r,
      ),
    );
    expect(failing(bad)).toEqual([C.key_found, C.shares]);
  });

  // MUTATION: in state_machines.numbers, count pool.union as found by both (`and` for `or`) — this fails
  // MUTATION: in state_machines.numbers.got, read an answer-key row's found flags from the table (state_found) — this fails
  it("recomputes the pool, its answer-key part from the judge's verdicts", () => {
    const bad = variant("pool", (sm) =>
      edit(sm, "pooled_bugs", (r) =>
        r.bug_id === "p1#U1" ? { ...r, default_found: false, default_review_comments: [] } : r,
      ),
    );
    expect(failing(bad)).toEqual(expect.arrayContaining([C.pool, C.unlisted, C.classes]));
    expect(failing(bad)).not.toContain(C.whole);
  });

  // MUTATION: in state_machines.numbers, count unlisted.blind_agree without matching blind_verdict to the review that found it — this fails
  it("counts a blind re-check as agreeing only when it names the review that found the bug", () => {
    const bad = variant("blind", (sm) =>
      edit(sm, "pooled_bugs", (r) =>
        r.bug_id === "p2#U1" ? { ...r, blind_verdict: "default" } : r,
      ),
    );
    expect(failing(bad)).toEqual([C.unlisted]);
  });

  // MUTATION: in state_machines.numbers, count class.<k>.<DEFAULT> with got(b, STATE) — this fails
  it("counts every class of the pool, and a class spelling outside the eight fails", () => {
    const bad = variant("classes", (sm) =>
      edit(sm, "pooled_bugs", (r) => (r.bug_id === "p2#U2" ? { ...r, klass: "stored" } : r)),
    );
    expect(failing(bad)).toEqual([C.whole, C.classes]);
  });

  // MUTATION: in state_machines.numbers, count the state review's labels by first_verdict instead of verdict — this fails
  // MUTATION: in state_machines.numbers, count not_judged_correct over every grade (drop the startswith("correct") test) — this fails
  it("recomputes the comments: final labels after the second reads, the judged-correct not-state ones, per PR", () => {
    const bad = variant("comments", (sm) =>
      edit(sm, "comment_verdicts", (r) =>
        r.arm_id === S && r.instance_id === "p2" && r.comment_id === "C2"
          ? { ...r, grade: "correct-minor" }
          : r,
      ),
    );
    expect(failing(bad)).toEqual([C.comments]);
  });

  // MUTATION: in state_machines.numbers, count defects.<arm>.found with `partial` as found — this fails
  it("recomputes the default review's answer-key finds of every kind", () => {
    const bad = variant("any", (sm) =>
      edit(sm, "defect_verdicts", (r) =>
        r.arm_id === D && r.defect_id === "D2" && r.instance_id === "p1"
          ? { ...r, verdict: "missed" }
          : r,
      ),
    );
    // p1/D2 is on the old list, so the default review's count on it drops too
    expect(failing(bad)).toEqual([C.old45, C.default_found_any]);
  });

  // MUTATION: in state_machines.numbers, count misses.<cause> over every miss (drop the cause test) — this fails
  it("recomputes the misses by cause", () => {
    const bad = variant("misses", (sm) =>
      edit(sm, "misses", (r) =>
        r.defect_id === "D3" ? { ...r, cause: "reported_a_different_problem" } : r,
      ),
    );
    expect(failing(bad)).toEqual([C.misses]);
  });

  // MUTATION: in state_machines.numbers, price an arm over both arms' cases (drop the arm filter in the cost block) — this fails
  it("recomputes dollars and minutes per PR from cases", () => {
    const bad = variant("cost", (sm) =>
      edit(sm, "cases", (r) => (r.arm_id === S && r.instance_id === "p2" ? { ...r, usd: 3.5 } : r)),
    );
    expect(failing(bad)).toEqual([C.cost]);
  });

  // MUTATION: in state_machines.post_values, give usd_per_pr_both as the sum of the two rounded per-PR costs (round(sum(round(x, 2) for x in both), 2)) — this fails
  it("gives both runs' cost as their exact combined cost, rounded, not the sum of the two rounded", () => {
    // 2.504 and 1.504 print as 2.50 and 1.50, which add to 4.00; the exact 4.008 prints as 4.01
    const bad = variant("cost-both", (sm) =>
      edit(sm, "cases", (r) =>
        r.instance_id === "p2" ? { ...r, usd: (r.usd as number) + 0.008 } : r,
      ),
    );
    expect(failing(bad)).toEqual([C.cost]);
    const cost = checks(bad, manifest(bad, join(bad, "m.sha256"))).find((c) =>
      c.check.endsWith(C.cost),
    )!;
    expect(cost.got).toEqual({
      usd_per_pr_state: 2.5,
      usd_per_pr_default: 1.5,
      usd_per_pr_both: 4.01,
    });
  });

  // MUTATION: in state_machines.numbers, give prs from the state arm alone (drop the comparison with the default arm's) — this fails
  // MUTATION: in state_machines.numbers, give prs from the study's two runs alone (`for a in ARMS` in prs) — this fails
  // MUTATION: in state_machines.whole_problems, compare the PRs of the study's two runs alone — this fails
  it("fails when the runs did not review the same PRs", () => {
    for (const arm of [D, A]) {
      const bad = variant(`prs-${arm}`, (sm) =>
        edit(sm, "cases", (r) =>
          r.arm_id === arm && r.instance_id === "p2" ? { ...r, instance_id: "p3" } : r,
        ),
      );
      expect(failing(bad)).toEqual(expect.arrayContaining([C.prs, C.whole]));
      expect(problems(bad)).toContain("cases: the runs' pull requests differ");
    }
  });

  // MUTATION: in state_machines.numbers, count key.<run> over every strict defect for the third run (drop `& reach`) — this fails
  // MUTATION: in state_machines.post_values, give astra.defects_found as the state review's (defects.sm4-p.found) — this fails
  it("recomputes the preliminary third run apart from the study's numbers", () => {
    const key = variant("astra-key", (sm) =>
      edit(sm, "defect_verdicts", (r) =>
        r.arm_id === A && r.instance_id === "p2" && r.defect_id === "D3"
          ? { ...r, verdict: "found" }
          : r,
      ),
    );
    expect(failing(key)).toEqual([C.astra]);
    const got = checks(key, manifest(key, join(key, "m.sha256"))).find((c) =>
      c.check.endsWith(C.astra),
    )!.got;
    expect(got).toEqual({ ...POST.astra, key_found: 2, share: 100, defects_found: 4 });
    // its comments and cost: none of the two runs' numbers moves
    const cost = variant("astra-cost", (sm) =>
      edit(sm, "cases", (r) => (r.arm_id === A && r.instance_id === "p1" ? { ...r, usd: 12 } : r)),
    );
    expect(failing(cost)).toEqual([C.astra]);
  });
});

describe("state_machines: the claims verifier", () => {
  // MUTATION: in claim_metrics.StateMachines, return None for a name numbers() does not give — this fails
  // MUTATION: in claim_metrics.StateMachines, compute numbers() without the isdir test (no KeyError_ for a missing folder) — this fails
  it("gives the study's numbers by name from the folder beside the tables, and refuses an unknown name", () => {
    const got = py(
      `import claim_metrics as M
out = {}
for root in sys.argv[1:]:
    p = M.PROVIDERS["state_machines"](M.Tables(root + "/data"))
    r = {}
    for k in ("pool.sm4-p", "key.sm1-c", "comments.sm4-p.per_pr", "key.sm5-a", "comments.sm5-a", "nope"):
        try:
            r[k] = p.value(k)
        except M.KeyError_ as e:
            r[k] = "KeyError: " + str(e)
    out[root.rsplit("/", 1)[1]] = r
print(json.dumps(out))`,
      BASE,
      variant("claims-gone", (sm) => rmSync(sm, { recursive: true })),
    ) as Record<string, Record<string, unknown>>;
    expect(got.base).toEqual({
      "pool.sm4-p": 3,
      "key.sm1-c": 2,
      "comments.sm4-p.per_pr": 2,
      "key.sm5-a": 1,
      "comments.sm5-a": 4,
      nope: "KeyError: unknown state_machines number 'nope'",
    });
    expect(got["claims-gone"]!["pool.sm4-p"]).toBe(
      "KeyError: no state_machines/ beside the tables",
    );
  });

  // MUTATION: in verify_claims.discover, never set found["state_machines"] — this fails
  // MUTATION: in verify_claims.consistency, give the state-machine checks needs [] — this fails
  it("finds the folder beside the tables, and its release checks need it", () => {
    const root = variant("consistency-data", (sm) =>
      jsonl(join(dirname(sm), "data"), "prs", [{ instance_id: "p1" }]),
    );
    const got = py(
      `import verify_claims as V
a = types.SimpleNamespace(work=sys.argv[2], martian=None, qodo_gt=None, no_validation=True)
found = V.discover([sys.argv[1]])
src = V.Sources(a, {"checks": {}}, found)
a.no_validation = False
import hf_export as H
H.CONFIGS[:] = []
H.validate = lambda t: []
H.validate_release = lambda *x: []
import second_judges as SJ
print(json.dumps([found["state_machines"], [[c["needs"], c["ok"]] for c in V.consistency(a, found, src) if c["needs"]]]))`,
      root,
      join(tmp, "consistency"),
    ) as [string, [string[], boolean][]];
    expect(got[0]).toBe(join(root, "state_machines"));
    // the fixture's folder is not the committed manifest's, and the verifier compares its numbers with the
    // release's (POST): the manifest check and the fourteen number checks fail, the columns, the rows, the
    // README and the quotes pass
    expect(got[1].every(([n]) => n.join() === "state_machines")).toBe(true);
    expect(got[1].map(([, ok]) => ok)).toEqual([
      false,
      true,
      true,
      true,
      true,
      ...Array(14).fill(false),
    ]);
  });

  it("lints a claims manifest whose check needs state_machines", () => {
    const lint = spawnSync("python3", ["-I", join(AACR, "verify_claims.py"), "--lint"], {
      encoding: "utf8",
    });
    expect(lint.stderr).not.toMatch(/needs \[.state_machines.\] is not a part of the release/);
    expect(lint.stdout).toMatch(
      /bench\/aacr\/hf\/card.md: \d+ number tokens, \d+ claims, \d+ not-claims, 0 unaccounted/,
    );
    expect(lint.status).toBe(0);
  });
});

describe("state_machines: the export and the card", () => {
  // MUTATION: in hf_export.leak_scan, read only the second judges' tables (drop SM.file_rows) — this fails
  it("leak-scans the folder's tables as it scans the configs", () => {
    const dir = variant("leak", (sm) =>
      edit(sm, "misses", (r) => ({ ...r, what_would_have_caught_it: "ask Jordan" })),
    );
    const n = py(
      `import hf_export as h\nh.CONFIGS[:] = []\nprint(json.dumps(sum(v for k, v in h.leak_scan(sys.argv[1]).items() if k.startswith("state_machines/misses.jsonl"))))`,
      dir,
    ) as number;
    expect(n).toBeGreaterThan(0);
  });

  // MUTATION: in hf_export.cited, drop "state_machines" from the folders whose keys link nothing — this fails
  it("a state_machines key links no arm and no run, whatever its name", () => {
    const got = py(
      `import hf_export as h
claims = [{"group": "g", "q": "state_machines:prs"}, {"group": "g2", "q": "{state_machines:prs} + {state_machines:pool.total}"}]
print(json.dumps([{k: sorted(v) for k, v in d.items()} for d in h.claim_links(claims, [{"arm_id": "prs", "runs": ["prs"]}], [{"unit": "prs"}], set(), {})]))`,
    ) as [Record<string, string[]>, Record<string, string[]>];
    expect(got).toEqual([{}, {}]);
  });

  // MUTATION: in hf_export.card_values, render STATE_MACHINES_MD from nothing (state_machines_link([], url)) — this fails
  // MUTATION: in hf_export.card_values, render STATE_MACHINES_FILES from nothing (always the pending marker) — this fails
  it("links the folder where the card lists the dataset's parts and in its own section, and lists its tables", () => {
    const card = py(
      `import hf_export as h, state_machines as SM
a = types.SimpleNamespace(repo_id="acme/bench")
v = lambda sm: h.fill_card(open(sys.argv[2]).read(), h.card_values(a, {n: 1 for n in h.CONFIGS}, [{"ok": True}],
                                                                   collections.Counter(), [], None, None, sm))
print(json.dumps([v(SM.file_rows(sys.argv[1])), v([])]))`,
      BASE,
      join(AACR, "hf", "card.md"),
    ) as [string, string];
    const link =
      "[`state_machines/`](https://huggingface.co/datasets/acme/bench/tree/main/state_machines)";
    expect(card[0]).toContain(`("Second judge"), ${link}\nholds a study`);
    expect(card[0]).toContain(`## State-machine study\n\n${link} holds a study`);
    expect(card[0]).toContain("| File | Rows |\n|---|---:|\n| `state_machines/arms.jsonl` | 3 |");
    expect(card[0]).toContain("| `state_machines/pooled_bugs.jsonl` | 5 |");
    expect(card[0]).toContain("\n### Preliminary: GPT-6.2 Astra\n");
    expect(card[1]).toContain("), `<state_machines/ not in this build>`\nholds a study");
    expect(card[1]).not.toContain("tree/main/state_machines");
  });

  // MUTATION: in hf_export.verify_result, count the state-machine checks with the slim bundle's (sm = 0) — this fails
  it("counts the state-machine checks with validation.json's, apart from the tables alone", () => {
    const report = join(tmp, "vc.json");
    const check = (needs: string[]) => ({ ok: true, needs });
    const write = (sm: number) =>
      writeFileSync(
        report,
        JSON.stringify({
          results: [{ status: "pass" }],
          consistency: [
            ...Array(3).fill(check([])),
            ...Array(2).fill(check(["second_judges"])),
            ...Array(sm).fill(check(["state_machines"])),
            check(["slim"]),
          ],
        }),
      );
    write(4);
    expect(
      py(`import hf_export as h\nprint(json.dumps(h.verify_result(sys.argv[1])))`, report),
    ).toContain(
      "The release's own checks pass 10 of 10: 9 from `validation.json`, re-run on the dataset (3 on the " +
        "tables, 2 on its `second_judges/` folder and 4 on its `state_machines/` folder), and 1 the slim bundle's.",
    );
    write(0);
    expect(
      py(`import hf_export as h\nprint(json.dumps(h.verify_result(sys.argv[1])))`, report),
    ).toContain("(3 on the tables and 2 on its `second_judges/` folder)");
  });
});

describe("state_machines: the build", () => {
  const B = join(tmp, "build");
  const runs = join(B, "runs");
  const labels = join(B, "labels");
  const PR = "p1";
  const QUOTE =
    "a queued toggle and its opposite collapse into one entry so nobody sees the change";

  function git(cwd: string, ...args: string[]): string {
    const p = spawnSync(
      "git",
      [
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@example.com",
        "-c",
        "maintenance.auto=false",
        ...args,
      ],
      { cwd, encoding: "utf8" },
    );
    if (p.status !== 0) throw new Error(p.stderr);
    return p.stdout.trim();
  }

  function write(path: string, value: unknown): void {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value));
  }

  /** A repo whose origin/main holds the state arm's commit and not the default arm's (a side branch). */
  const repo = join(B, "repo");
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  git(repo, "commit", "-q", "--allow-empty", "-m", "main");
  const onMain = git(repo, "rev-parse", "HEAD");
  git(repo, "update-ref", "refs/remotes/origin/main", onMain);
  git(repo, "checkout", "-q", "-b", "side");
  git(repo, "commit", "-q", "--allow-empty", "-m", "side");
  const offMain = git(repo, "rev-parse", "HEAD");

  /**
   * One PR in three runs. The state review posted two comments of the same text; the default review posted
   * one inline comment and one finding in its review body; the third run (unlabelled) one inline comment. Key: D1 state (old list), D2 state that a second
   * reader agreed cannot happen at head, D3 state whose not-real miss the second reader did not agree with.
   */
  function run(
    arm: string,
    commit: string,
    profile: string,
    posted: string[],
    rows: string[],
    md: string,
  ) {
    const r = join(runs, `${arm}-smoke10`);
    write(join(r, "run.json"), {
      qcr_commit: commit,
      profile,
      pi: "1",
      models: { conversation: "m" },
    });
    write(join(runs, `${arm}-smoke10.arm.json`), {
      image: `img:${arm}`,
      image_id: "sha256:x",
      config: "c",
    });
    const c = join(r, "cases", PR);
    write(join(c, "case-summary.json"), {
      status: "ok",
      verdict: "COMMENT",
      duration_seconds: 600,
      bench_cost_usd: 2,
    });
    write(
      join(c, "comments.json"),
      posted.map((body, i) => ({ path: "a.c", line: 10 + i, side: "RIGHT", body })),
    );
    write(join(c, "review.md"), md);
    write(join(r, "results", "all", `${PR}.json`), {
      review: {
        comments: rows.map((content, i) => ({
          path: "a.c",
          start_line: 20 + i,
          end_line: 21 + i,
          content,
        })),
      },
    });
    const found = arm === S ? ["D1"] : arm === A ? ["D1", "D2", "D3"] : ["D1", "D3"];
    write(join(r, "judge", "v2-gpt-6.1-sol-high", `${PR}.r1.json`), {
      defect_set_version: "2",
      defects: ["D1", "D2", "D3"].map((id) => ({
        id,
        verdict: found.includes(id) ? "found" : "missed",
        comments: found.includes(id) ? ["C1"] : [],
        why: "w",
      })),
      comments: rows.map((_, i) => ({
        id: `C${i + 1}`,
        defect: null,
        verdict: "correct-minor",
        new_defect: false,
        why: "w",
      })),
      usage: { input: 1, output: 2, cacheRead: 3 },
    });
  }
  const same = "[nit] Same title\n\nsame body";
  run(S, onMain, "state-machines", [same, same], [same, same], "summary\n");
  run(
    D,
    offMain,
    "",
    ["[blocker] Inline\n\nbody"],
    ["[blocker] Inline\n\nbody", "[nit] In the body\n\nbody"],
    "### Additional findings (not posted inline)\n\n- `a.c:22` — In the body — _posted in the body_\n",
  );
  run(
    A,
    offMain,
    "state-machines",
    ["[major] Astra\n\nbody"],
    ["[major] Astra\n\nbody"],
    "summary\n",
  );
  const vote = (verdict: string, reason: string) => ({
    "1": { verdict, klass: "lifecycle", reason },
  });
  write(join(labels, "strict-relabel.json"), {
    [`${PR}#D1`]: {
      verdict: "state_machine",
      klass: "lifecycle",
      how: "agree",
      old45: true,
      votes: vote("state_machine", `The reader saw that ${QUOTE}, at the queue.`),
    },
    [`${PR}#D2`]: {
      verdict: "state_machine",
      klass: "stuck",
      how: "tiebreak",
      old45: false,
      votes: vote("state_machine", "r"),
    },
    [`${PR}#D3`]: {
      verdict: "state_machine",
      klass: "impossible",
      how: "agree",
      old45: false,
      votes: vote("state_machine", "r"),
    },
  });
  const miss = (d: string, agree: boolean) => ({
    key: `${PR}#${d}`,
    cause: "defect_not_real_or_unreachable",
    owning_lens: "pass-sm-states",
    planned_lenses: ["pass-sm-states"],
    evidence: "a run path",
    what_would_have_caught_it: "w",
    check: { verdict: "agree", agree, reason: "c" },
  });
  write(join(labels, "comments-and-misses.json"), {
    comments: [0, 1].map((index) => ({
      pr: PR,
      index,
      title: "Same title",
      verdict: "not",
      klass: "none",
      reason: "r",
      key_defect: index === 0 ? "D1" : "",
      real_if_unlisted: "n/a",
    })),
    checked: [{ pr: PR, index: 1, check: { verdict: "borderline", agree: false, reason: "s" } }],
    misses: [
      {
        ...miss("D2", true),
        relabel_note: "Relabelled on review by Jordan: see /home/alice/notes",
      },
      miss("D3", false),
    ],
  });
  write(join(labels, "pooled-unlisted.json"), {
    classified: [],
    bugs: ["U1", "U2"].map((bug_id, i) => ({
      pr: PR,
      bug_id,
      statement: "ours",
      state_review_comments: i === 0 ? [0] : [],
      default_review_comments: i === 0 ? [] : [0],
      check: { reason: "real", real: "real" },
    })),
  });
  write(join(labels, "results.json"), {
    pool: [
      { id: `${PR}#D1`, source: "answer-key", klass: "lifecycle", state: true, default: true },
      { id: `${PR}#U1`, source: "unlisted", klass: "transition", state: true, default: false },
      { id: `${PR}#U2`, source: "unlisted", klass: "stale", state: false, default: true },
    ],
  });
  write(join(labels, "blind-result.json"), [
    { pr: PR, bug_id: "U1", blind: "state", expected: "state", real: "real", reason: "b" },
    { pr: PR, bug_id: "U2", blind: "state", expected: "default", real: "real", reason: "b" },
  ]);
  const positives = join(B, "positives.json");
  write(positives, { bysub: { smoke10: [PR] } });
  const earlier = (found_c: string[]) => {
    const p = join(B, `earlier-${found_c.length}.json`);
    write(p, {
      "sm1-s4": { found_strict: [`${PR}#D1`] },
      "sm1-s8": { found_strict: [] },
      "sm1-s8d": { found_strict: [] },
      "sm1-r": { found_strict: [`${PR}#D1`, `${PR}#D3`] },
      [D]: { found_strict: found_c },
    });
    return p;
  };
  const key = join(B, "key");
  write(join(key, "smoke10.json"), {
    version: 2,
    cases: {
      [PR]: {
        defects: [{ id: "D1", title: "t", statement: `When ${QUOTE}.`, evidence: "", notes: "" }],
      },
    },
  });
  const figures = join(B, "figures");
  const FIGS = py("import state_machines as SM\nprint(json.dumps(list(SM.FIGURES)))") as string[];
  for (const f of FIGS) write(join(figures, f), "<svg/>\n");

  const args = (over: Record<string, string> = {}) => ({
    runs_dir: runs,
    labels,
    positives,
    earlier: earlier([`${PR}#D1`, `${PR}#D3`]),
    figures,
    repo,
    key,
    out: join(B, "out", "state_machines"),
    ...over,
  });

  /** collect() on the fixture (no file written), or the message it refuses with. */
  function collect(over: Record<string, string> = {}): Record<string, Row[]> | string {
    return py(
      `import state_machines as SM
a = types.SimpleNamespace(**json.loads(sys.argv[1]))
try:
    print(json.dumps(SM.collect(a)[0], default=str))
except SystemExit as e:
    print(json.dumps(str(e)))`,
      JSON.stringify(args(over)),
    ) as Record<string, Row[]> | string;
  }

  /** build()'s refusal on the fixture, before anything is written. */
  function refusal(over: Record<string, string>): string {
    return py(
      `import state_machines as SM
a = types.SimpleNamespace(**json.loads(sys.argv[1]))
try:
    SM.build(a); print(json.dumps("built"))
except SystemExit as e:
    print(json.dumps(str(e)))`,
      JSON.stringify(args(over)),
    ) as string;
  }

  const T = collect() as Record<string, Row[]>;
  const pick = (rows: Row[], keys: string[]) =>
    rows.map((r) => Object.fromEntries(keys.map((k) => [k, r[k]])));

  // MUTATION: in state_machines.collect, give a posted comment the first row of its text, used or not (drop `not in used`) — this fails
  // MUTATION: in state_machines.collect, drop the review body's rows (no `rest` rows in reviews) — this fails
  it("numbers the posted comments with the judge's ids, two of one text apart, and keeps a review-body finding", () => {
    expect(pick(T.reviews!, ["arm_id", "index", "inline", "line", "comment_id"])).toEqual([
      { arm_id: S, index: 0, inline: true, line: 10, comment_id: "C1" },
      { arm_id: S, index: 1, inline: true, line: 11, comment_id: "C2" },
      { arm_id: D, index: 0, inline: true, line: 10, comment_id: "C1" },
      { arm_id: D, index: null, inline: false, line: 22, comment_id: "C2" },
      { arm_id: A, index: 0, inline: true, line: 10, comment_id: "C1" },
    ]);
    expect(pick(T.comment_verdicts!, ["arm_id", "comment_id", "index", "judge"])).toEqual([
      { arm_id: S, comment_id: "C1", index: 0, judge: "gpt-6.1-sol-high" },
      { arm_id: S, comment_id: "C2", index: 1, judge: "gpt-6.1-sol-high" },
      { arm_id: D, comment_id: "C1", index: 0, judge: "gpt-6.1-sol-high" },
      { arm_id: D, comment_id: "C2", index: null, judge: "gpt-6.1-sol-high" },
      { arm_id: A, comment_id: "C1", index: 0, judge: "gpt-6.1-sol-high" },
    ]);
    expect(pick(T.cases!, ["arm_id", "n_posted", "usd", "minutes", "judged"])).toEqual([
      { arm_id: S, n_posted: 2, usd: 2, minutes: 10, judged: true },
      { arm_id: D, n_posted: 1, usd: 2, minutes: 10, judged: true },
      { arm_id: A, n_posted: 1, usd: 2, minutes: 10, judged: true },
    ]);
    expect(T.defect_verdicts![0]).toMatchObject({
      judge: "gpt-6.1-sol-high",
      key_version: "2",
      credit: 1,
    });
  });

  // MUTATION: in state_machines.collect, write `profile` as the run gives it (drop `or None`) — this fails
  // MUTATION: in state_machines.collect, read the study's two runs alone (`for arm in ARMS` in the cases loop) — this fails
  it("states each arm's build: on public main or not, and no profile as null", () => {
    expect(
      pick(T.arms!, [
        "arm_id",
        "profile",
        "qcr_commit",
        "qcr_commit_on_public_main",
        "qcr_commit_match",
      ]),
    ).toEqual([
      {
        arm_id: S,
        profile: "state-machines",
        qcr_commit: onMain,
        qcr_commit_on_public_main: true,
        qcr_commit_match: "same",
      },
      {
        arm_id: D,
        profile: null,
        qcr_commit: offMain,
        qcr_commit_on_public_main: false,
        qcr_commit_match: null,
      },
      {
        arm_id: A,
        profile: "state-machines",
        qcr_commit: offMain,
        qcr_commit_on_public_main: false,
        qcr_commit_match: null,
      },
    ]);
    expect(T.arms![2]!.display_name).toBe("State-machine review, GPT-6.2 Astra (preliminary)");
    expect(T.defect_verdicts!.filter((r) => r.arm_id === A).map((r) => r.verdict)).toEqual([
      "found",
      "found",
      "found",
    ]);
  });

  // MUTATION: in state_machines._klass, return the spelling as given (drop CLASS_SPELLINGS) — this fails
  // MUTATION: in state_machines.collect, count every not-real miss as unreachable (drop the second reader's `agree`) — this fails
  // MUTATION: in state_machines.collect, count a blind re-check as agreeing whatever review it names (drop `bl["blind"] == bl["expected"]`) — this fails
  it("folds the class spellings, takes reachability from the agreed misses, and checks each blind re-check", () => {
    expect(pick(T.state_labels!, ["defect_id", "klass", "reachable"])).toEqual([
      { defect_id: "D1", klass: "lifecycle-order", reachable: true },
      { defect_id: "D2", klass: "stuck-state", reachable: false },
      { defect_id: "D3", klass: "impossible-states", reachable: true },
    ]);
    expect(pick(T.pooled_bugs!, ["bug_id", "klass", "blind_agrees"])).toEqual([
      { bug_id: "p1#D1", klass: "lifecycle-order", blind_agrees: null },
      { bug_id: "p1#U1", klass: "unchecked-transition", blind_agrees: true },
      { bug_id: "p1#U2", klass: "stale-copy", blind_agrees: false },
    ]);
    expect(
      pick(T.comment_state_labels!, ["index", "verdict", "first_verdict", "key_defect"]),
    ).toEqual([
      { index: 0, verdict: "not", first_verdict: "not", key_defect: "D1" },
      { index: 1, verdict: "borderline", first_verdict: "not", key_defect: null },
    ]);
  });

  // MUTATION: in state_machines.collect, write every miss's relabel_note as None (drop m.get("relabel_note")) — this fails
  it("carries a miss's relabel note, scrubbed, and null where the cause was not changed", () => {
    expect(pick(T.misses!, ["defect_id", "relabel_note"])).toEqual([
      { defect_id: "D2", relabel_note: "Relabelled on review by <owner>: see <home>/notes" },
      { defect_id: "D3", relabel_note: null },
    ]);
  });

  // MUTATION: in state_machines.collect, skip the cut of the answer key's words (no unquote) — this fails
  it("cuts the answer key's words from a reader's reason", () => {
    const reason = (T.state_labels![0]!.votes as Row[])[0]!.reason as string;
    expect(reason).toBe("The reader saw that [words of the answer key's defect], at the queue.");
    expect((T.state_labels![1]!.votes as Row[])[0]!.reason).toBe("r");
  });

  // MUTATION: in state_machines.collect, take the result rows no inline comment took without reading review.md — this fails
  // MUTATION: in state_machines.collect, drop the check of the score file's default run against the judge files — this fails
  it("refuses a judged row that is neither inline nor in the review body, and an --earlier file that disagrees", () => {
    const md = join(runs, `${D}-smoke10`, "cases", PR, "review.md");
    const kept = readFileSync(md, "utf8");
    writeFileSync(md, "summary\n");
    try {
      expect(collect()).toMatch(
        /result rows \['C2'\] are neither inline comments nor the review body's 0 findings/,
      );
    } finally {
      writeFileSync(md, kept);
    }
    expect(collect({ earlier: earlier([`${PR}#D1`]) })).toBe(
      "--earlier: its default-run found list differs from the judge files",
    );
  });

  // MUTATION: in state_machines.build, drop the check that --out does not exist — this fails
  // MUTATION: in state_machines.build, drop the scrub check of the figures — this fails
  it("refuses an --out that exists, and a figure the scrub would rewrite, before writing anything", () => {
    const out = join(B, "exists", "state_machines");
    mkdirSync(out, { recursive: true });
    expect(refusal({ out })).toMatch(/exists: give a new folder/);
    const figs = join(B, "figures-named");
    cpSync(figures, figs, { recursive: true });
    writeFileSync(join(figs, FIGS[0]!), "<svg><text>Jordan</text></svg>\n");
    expect(refusal({ figures: figs })).toMatch(/the scrub would rewrite it/);
    expect(existsSync(join(B, "out"))).toBe(false);
  });
});
