// The dataset's state-machine study (`state_machines/`): the export copies the folder only when it is the
// committed manifest's, validation.json checks it and recomputes every number of the study from its tables,
// the claims verifier reads those numbers by name, and the card links the folder and counts its checks
// apart. Runs for real under python3, standard library only, on a small study of .jsonl tables (two pull
// requests, neutral planted names):
//
//   1. the manifest: a folder with a file missing, extra or changed is refused before anything is copied,
//      and fails validation.json's manifest check; without the folder every check fails;
//   2. validation.json's checks pass on a whole folder whose numbers are the expected ones, and each fails
//      on what it guards (a column, a row that does not fit the others, every recomputed number);
//   3. the claims verifier: claim_metrics.StateMachines gives the numbers by name, discover finds the
//      folder beside the tables, and its release checks carry needs ["state_machines"];
//   4. the export and the card: the leak scan reads the folder's tables, a state_machines key links no arm,
//      the card links the folder and lists its tables, and the release checks' split counts its checks.

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

/**
 * A study on two PRs. Answer key: p1/D1 state (old list), p1/D2 not (old list), p2/D1 state but not
 * reachable at head, p2/D2 borderline, p2/D3 state. The state review finds p1/D1 and only partly p2/D3; the
 * default review finds p1/D1, p1/D2 and p2/D3 and partly p2/D2. Pool: the two reachable state defects and
 * three unlisted bugs (both, state only, default only).
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
  ]);
  const rev = (arm: string, pr: string, index: number, comment_id: string | null) => ({
    arm_id: arm,
    instance_id: pr,
    index,
    path: "a.c",
    line: 10 + index,
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
  ]);
  const dv = (arm: string, pr: string, defect_id: string, verdict: string) => ({
    arm_id: arm,
    instance_id: pr,
    defect_id,
    verdict,
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
    cv(D, "p2", "C3", null, "correct-minor", null), // judged, not posted
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
    votes: [{ reader: 1, verdict, klass: null, reason: "r", state: null, event: null }],
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
    s: boolean,
    d: boolean,
    blind: string | null = null,
  ) => ({
    bug_id: `${pr}#${local}`,
    instance_id: pr,
    local_id: local,
    source,
    klass,
    state_found: s,
    default_found: d,
    statement: source === "unlisted" ? "ours" : null,
    state_review_comments: null,
    default_review_comments: null,
    check_reason: null,
    blind_verdict: blind,
    blind_agrees: blind === null ? null : true,
    blind_reason: blind && "b",
  });
  jsonl(sm, "pooled_bugs", [
    bug("p1", "D1", "answer-key", "event-order", true, true),
    bug("p2", "D3", "answer-key", "stale-copy", false, true),
    bug("p1", "U1", "unlisted", "event-order", true, true),
    bug("p2", "U1", "unlisted", "lifecycle-order", true, false, "state"),
    bug("p2", "U2", "unlisted", "stored-state", false, true, "default"),
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
  writeFileSync(join(sm, "README.md"), "# A study\n");
}

/** The fixture's numbers, in POST's shape: what the checks must recompute. */
const POST = {
  prs: 2,
  relabel: { total: 5, state: 3, borderline: 1, not: 1, reachable: 2 },
  old45: { total: 2, state: 1, borderline: 0, not: 1 },
  key_found: { [S]: 1, [D]: 2, "sm1-s4": 1, "sm1-s8": 0, "sm1-s8d": 1, "sm1-r": 2 },
  key_only: { state_not_default: 0, default_not_state: 1 },
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
    site_read_nothing_reported: 1,
    reported_a_different_problem: 0,
    defect_not_real_or_unreachable: 1,
  },
  cost: { usd_per_pr_state: 2.5, usd_per_pr_default: 1.5, minutes_per_pr_state: 12 },
};

const BASE = join(tmp, "base");
dataset(BASE);
const MANIFEST = manifest(BASE, join(tmp, "state-machines.sha256"));

/** A copy of the base dataset, changed by `edit` (the manifest stays the base's unless re-made). */
function variant(name: string, edit: (sm: string) => void): string {
  const root = join(tmp, name);
  cpSync(BASE, root, { recursive: true });
  edit(join(root, "state_machines"));
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
    "the rows are whole: both arms judged on the same pull requests, one verdict per arm on every labelled answer-key defect, every labelled comment a posted one, and the default review's labelled comments exactly its posted comments matched to no answer-key defect",
  prs: "both arms reviewed the same pull requests",
  relabel:
    "the strict relabel of the answer-key defects: state, borderline and not, and the state ones reachable at head",
  old45: "the earlier list of 45 state defects under the strict relabel",
  key_found:
    "answer-key recall on the reachable strict state defects (judge verdict found), of the two runs and the four earlier builds",
  key_only: "the reachable strict state defects one run found and the other did not",
  pool: "the pool of known real state bugs (answer key + unlisted) and how many of them each run and either run found; the answer-key part's found flags are the judge's verdicts",
  unlisted:
    "the unlisted bugs found by both runs or by one, and the one-sided ones re-checked blind",
  classes: "per class of state bug: pool, state review, default review",
  comments:
    "the posted comments: the state review's by label after the second reads, its not-state ones the judge graded correct, the default review's, and comments per pull request",
  default_found_any: "the answer-key defects of every kind the default review found",
  misses: "the state review's misses on the strict state defects, by cause",
  cost: "list-price dollars and minutes per pull request (compare.usd_and_minutes)",
};

describe("state_machines: the manifest", () => {
  // MUTATION: in state_machines.manifest_problems, return no "extra" list (only missing and differs) — this fails
  // MUTATION: in hf_export.refuse_state_machines, return before the manifest check — this fails
  it("refuses a folder with a file missing, extra or changed, before anything is copied", () => {
    const extra = variant("extra", (sm) => writeFileSync(join(sm, "notes.md"), "x\n"));
    const changed = variant("changed", (sm) => appendFileSync(join(sm, "README.md"), " "));
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
    expect(readFileSync(join(out, "state_machines", "README.md"), "utf8")).toBe("# A study\n");
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
    expect(cs).toHaveLength(15);
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
  it("passes all fifteen on a whole folder that is the manifest's, recomputing every number", () => {
    const cs = checks(BASE);
    expect(cs).toHaveLength(15);
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
    expect(post.relabel).toEqual({ total: 186, state: 56, borderline: 2, not: 128, reachable: 55 });
    expect(post.comments).toMatchObject({ [S]: 159, state: 96, borderline: 31, not: 32, [D]: 397 });
    expect(Object.keys(post).sort()).toEqual(Object.keys(POST).sort());
  });

  // MUTATION: in state_machines.checks, pass a table that has every listed column (set(want) <= set(c)) — this fails
  it("fails a table carrying a column it does not list (a defect's text)", () => {
    const bad = variant("columns", (sm) =>
      edit(sm, "state_labels", (r) => ({ ...r, statement: "the defect" })),
    );
    expect(failing(bad)).toEqual([C.columns]);
  });

  // MUTATION: in state_machines.whole_problems, compare the default review's labels with all its posted comments (drop the defect_id test) — this fails
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
    expect(failing(bad)).toEqual([C.key_found]);
  });

  // MUTATION: in state_machines.numbers, count pool.union as found by both (`and` for `or`) — this fails
  // MUTATION: in state_machines.numbers.got, read an answer-key row's found flags from the table (state_found) — this fails
  it("recomputes the pool, its answer-key part from the judge's verdicts", () => {
    const bad = variant("pool", (sm) =>
      edit(sm, "pooled_bugs", (r) => (r.bug_id === "p1#U1" ? { ...r, default_found: false } : r)),
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
    expect(failing(bad)).toEqual([C.default_found_any]);
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

  // MUTATION: in state_machines.numbers, give prs from the state arm alone (drop the comparison with the default arm's) — this fails
  it("fails when the two arms did not review the same PRs", () => {
    const bad = variant("prs", (sm) =>
      edit(sm, "cases", (r) =>
        r.arm_id === D && r.instance_id === "p2" ? { ...r, instance_id: "p3" } : r,
      ),
    );
    expect(failing(bad)).toEqual(expect.arrayContaining([C.prs, C.whole]));
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
    for k in ("pool.sm4-p", "key.sm1-c", "comments.sm4-p.per_pr", "nope"):
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
      nope: "KeyError: unknown state_machines number 'nope'",
    });
    expect(got["claims-gone"]!["pool.sm4-p"]).toBe(
      "KeyError: no state_machines/ beside the tables",
    );
  });

  // MUTATION: in verify_claims.discover, never set found["state_machines"] — this fails
  // MUTATION: in verify_claims.consistency, give the state-machine checks needs [] — this fails
  it("finds the folder beside the tables, and its release checks need it", () => {
    jsonl(join(BASE, "data"), "prs", [{ instance_id: "p1" }]);
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
      BASE,
      join(tmp, "consistency"),
    ) as [string, [string[], boolean][]];
    expect(got[0]).toBe(join(BASE, "state_machines"));
    // the fixture's folder is not the committed manifest's: the manifest check fails, the rest pass
    expect(got[1]).toHaveLength(15);
    expect(got[1].every(([n]) => n.join() === "state_machines")).toBe(true);
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
    expect(card[0]).toContain(`("Second judge"), and ${link}\nholds a study`);
    expect(card[0]).toContain(`## State-machine study\n\n${link} holds a study`);
    expect(card[0]).toContain("| File | Rows |\n|---|---:|\n| `state_machines/arms.jsonl` | 2 |");
    expect(card[0]).toContain("| `state_machines/pooled_bugs.jsonl` | 5 |");
    expect(card[1]).toContain("and `<state_machines/ not in this build>`\nholds a study");
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
