// extensions/setup.ts — the companion's setup tool belt over the SetupEngine,
// and the real ports it assembles (src/setup/adapters.ts). The belt
// is driven over an engine with a scratch checkout and a temp state home; the
// ports are driven against temp dirs, one scratch git repo (the listing is
// `git ls-files`, so git is the thing under test there) and a fake fetch.
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { QcrTool, QcrToolResult } from "../extensions/pi-tool.js";
import { EventEmitter } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import activate from "../extensions/cli/setup.js";
import {
  COMPANION_AGENTS_DIR,
  DEFAULT_REVIEWED_REPO,
  buildEngine,
  renderSurveyStatus,
  toolDefinitions,
} from "../extensions/setup.js";
import { CONTAINER } from "../src/tui/companion.js";
import {
  checkoutReader,
  configHomeFs,
  reviewerMemoryFromEnv,
  stateHomeFs,
  tokenFileGitHubReader,
} from "../src/setup/adapters.js";
import { parseAgentFile, piCaseRunner, type SpawnFn } from "../src/setup/caserunner.js";
import { SetupEngine, type CaseOutcome, type CaseSpec } from "../src/setup/engine.js";
import { notYetTrackerSink } from "../src/setup/adapters.js";
import type { MemoryEntry, MemoryOp, MemoryStore } from "../src/memory/store.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "qcr-setup-ext-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function tree(root: string, files: Record<string, string>): void {
  for (const [p, t] of Object.entries(files)) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), t);
  }
}

function textOf(r: QcrToolResult): string {
  return r.content.map((c) => c.text).join("\n");
}

async function call(
  defs: QcrTool[],
  name: string,
  params: Record<string, unknown> = {},
): Promise<string> {
  const def = defs.find((d) => d.name === name);
  expect(def, `tool ${name}`).toBeDefined();
  return textOf(await def!.execute("id", params));
}

describe("the tool belt", () => {
  function belt(): QcrTool[] {
    const repo = join(dir, "repo");
    tree(repo, {
      "README.md": "# x\n",
      "api/apps.py": "x\n",
      "api/views.py": "a\nb\n",
      "web/package.json": JSON.stringify({ dependencies: { react: "18" } }),
      "web/src/a.tsx": "x\n",
      ".github/workflows/ci.yml": "name: CI\n",
    });
    const engine = buildEngine({
      QCR_REVIEWED_REPO: repo,
      QCR_STATE_HOME: join(dir, "state"),
      QCR_CONFIG_HOME: join(dir, "config"),
    } as NodeJS.ProcessEnv);
    return toolDefinitions(engine);
  }

  it("registers the facts, unit-cut and survey tools, tool-name-safe", () => {
    const names = belt().map((d) => d.name);
    expect(names).toEqual([
      "setup_repo_facts",
      "setup_unit_cut",
      "setup_unit_cut_propose",
      "setup_unit_cut_adjust",
      "setup_unit_cut_save",
      "setup_review_history",
      "setup_review_history_themes",
      "setup_survey_preview",
      "setup_survey_start",
      "setup_survey_status",
      "setup_survey_stop",
      "setup_portrait_assemble",
      "setup_portrait",
      "setup_portrait_narrative",
      "setup_interview",
      "setup_profile",
      "setup_profile_apply",
      "setup_retune",
      "setup_profile_validate",
      "setup_pin_propose",
    ]);
    for (const n of names) expect(n).toMatch(/^[a-z][a-z0-9_]*$/);
  });

  it("drives the whole cut: facts → propose → adjust → save, then status shows it in use", async () => {
    const defs = belt();
    const facts = await call(defs, "setup_repo_facts");
    expect(facts).toMatch(/GitHub Actions — \.github\/workflows\/ci\.yml \("CI"\)/);
    expect(facts).toMatch(/React — web\/package\.json/);
    expect(facts).toMatch(/Unit candidates/);

    const proposed = await call(defs, "setup_unit_cut_propose", {
      units: [{ name: "api", roots: ["api"] }],
    });
    expect(proposed).toMatch(/Draft stored/);
    expect(proposed).toMatch(/! .*belong to no unit/);
    const refused = await call(defs, "setup_unit_cut_save");
    expect(refused).toMatch(/Save refused/);

    const adjusted = await call(defs, "setup_unit_cut_adjust", {
      ops: [
        { op: "add", name: "web", roots: ["web"], kind: "js-package" },
        { op: "add", name: "rest", roots: [""] },
      ],
    });
    expect(adjusted).toMatch(/Draft adjusted/);
    expect(await call(defs, "setup_unit_cut_save")).toMatch(/Unit cut saved/);
    const status = await call(defs, "setup_unit_cut");
    expect(status).toMatch(/Saved unit cut/);
    expect(status).toMatch(/- api \[custom\] api: 2 files/);
    expect(status).not.toMatch(/Draft/);
  });

  it("drives the portrait: assemble → narrative → read, the narrative in the CONFIG home", async () => {
    const defs = belt();
    expect(await call(defs, "setup_portrait")).toMatch(/No portrait facts yet/);
    const assembled = await call(defs, "setup_portrait_assemble");
    expect(assembled).toMatch(/Portrait facts ([0-9a-f]{12})/);
    expect(assembled).toMatch(/NO SAVED CUT — the deterministic candidates, not the cut/);
    expect(assembled).toMatch(/CI GitHub Actions — \.github\/workflows\/ci\.yml \("CI"\)/);
    expect(assembled).toMatch(/themes: none saved/);
    expect(assembled).toMatch(/The first facts for this repo/);
    const key = /Portrait facts ([0-9a-f]{12})/.exec(assembled)![1]!;
    expect(assembled).toContain(`setup_portrait_narrative, facts_key ${key}`);

    expect(
      await call(defs, "setup_portrait_narrative", { facts_key: "000000000000", narrative: "x" }),
    ).toMatch(/Narrative refused:\n✗ the facts changed since that key/);
    const stored = await call(defs, "setup_portrait_narrative", {
      facts_key: key,
      narrative: "A Django API beside a React app.",
    });
    expect(stored).toMatch(new RegExp(`Narrative stored from facts ${key}`));
    expect(existsSync(join(dir, "config", "portrait", "narrative.md"))).toBe(true);
    expect(existsSync(join(dir, "state", "setup", "portrait-facts.json"))).toBe(true);

    const replaced = await call(defs, "setup_portrait_narrative", {
      facts_key: key,
      narrative: "A Django API and a React app.",
    });
    expect(replaced).toMatch(
      /The previous one is kept \(portrait\/narrative\.previous\.md\); changes:\n {2}- A Django API beside a React app\.\n {2}\+ A Django API and a React app\./,
    );

    const read = await call(defs, "setup_portrait", { diff: true });
    expect(read).toMatch(
      /Narrative \(.*; current with these facts\):\n\nA Django API and a React app\./,
    );
    expect(read).toMatch(/The narrative it replaced is kept/);
    expect(read).toMatch(/Facts: no earlier version kept yet\./);
    expect(read).toMatch(/Narrative changes since the one it replaced:/);
    expect(await call(defs, "setup_portrait_assemble")).toMatch(
      /Facts: no change in shape since they were last assembled/,
    );
  });

  it("answers a bad call with a refusal, never a throw", async () => {
    const defs = belt();
    expect(await call(defs, "setup_unit_cut_adjust", {})).toMatch(
      /Adjustment refused:\n✗ `ops` must be/,
    );
    expect(await call(defs, "setup_unit_cut_propose", { units: "nope" })).toMatch(
      /Proposal refused/,
    );
  });

  it("the default checkout path is the companion's mount point", () => {
    expect(DEFAULT_REVIEWED_REPO).toBe(CONTAINER.reviewedRepo);
  });

  it("an unreadable cut file renders the saved cut as UNKNOWN, never as 'no saved cut'", async () => {
    const state = join(dir, "state");
    tree(state, { "setup/unit-cut.json": "{ not json" });
    const engine = buildEngine({
      QCR_REVIEWED_REPO: join(dir, "absent"),
      QCR_STATE_HOME: state,
    } as NodeJS.ProcessEnv);
    const out = await call(toolDefinitions(engine), "setup_unit_cut");
    expect(out).toMatch(/Saved unit cut: UNKNOWN/);
    expect(out).not.toMatch(/No saved unit cut yet/);
  });

  it("a missing checkout is a refusal from the tools, not a failed start", async () => {
    const engine = buildEngine({
      QCR_REVIEWED_REPO: join(dir, "absent"),
      QCR_STATE_HOME: join(dir, "state"),
    } as NodeJS.ProcessEnv);
    expect(await call(toolDefinitions(engine), "setup_repo_facts")).toMatch(
      /no readable checkout at .*absent/,
    );
  });

  it("activation degrades on a pi without registerTool, and registers every tool on one with it", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      activate({ on: () => {}, sendUserMessage: () => {} } as unknown as ExtensionAPI);
      expect(err).toHaveBeenCalledWith(expect.stringMatching(/registerTool unavailable/));
      const registered: string[] = [];
      activate({
        on: () => {},
        sendUserMessage: () => {},
        registerTool: (d: { name: string }) => registered.push(d.name),
      } as unknown as ExtensionAPI);
      expect(registered).toEqual([
        "setup_repo_facts",
        "setup_unit_cut",
        "setup_unit_cut_propose",
        "setup_unit_cut_adjust",
        "setup_unit_cut_save",
        "setup_review_history",
        "setup_review_history_themes",
        "setup_survey_preview",
        "setup_survey_start",
        "setup_survey_status",
        "setup_survey_stop",
        // The repo portrait.
        "setup_portrait_assemble",
        "setup_portrait",
        "setup_portrait_narrative",
        // The interview's tuning.
        "setup_interview",
        "setup_profile",
        "setup_profile_apply",
        "setup_retune",
        "setup_profile_validate",
        "setup_pin_propose",
        // The scan half of the belt.
        "scan_preview",
        "scan_start",
        "scan_status",
        "scan_stop",
        "scan_findings",
        // The companion's sameness hand-off.
        "scan_matches",
        "scan_match",
        // Stage 2.
        "scan_suggestions",
        "scan_stage2_propose",
        "scan_stage2_start",
        // Triage and scan memory.
        "scan_dismiss",
        "scan_promote",
        "scan_close_fixed",
        "scan_memory",
        // The PR replay, old vs new profile.
        "setup_replay_preview",
        "setup_replay_start",
        "setup_replay_status",
        "setup_replay_stop",
      ]);
    } finally {
      err.mockRestore();
    }
  });
});

describe("the interview's profile tools", () => {
  function profileBelt(profile: string): QcrTool[] {
    const cfgHome = join(dir, "config");
    tree(cfgHome, { "config.toml": `[review]\nprofile = ${JSON.stringify(profile)}\n` });
    const engine = buildEngine({
      QCR_REVIEWED_REPO: join(dir, "repo"),
      QCR_STATE_HOME: join(dir, "state"),
      QCR_CONFIG_HOME: cfgHome,
    } as NodeJS.ProcessEnv);
    return toolDefinitions(engine);
  }

  it("the table tool shows the four points, every concern and the priority table", async () => {
    const out = await call(profileBelt(""), "setup_interview");
    for (const point of ["goals", "merge-blocking", "risk", "style-tests"])
      expect(out).toContain(point);
    expect(out).toMatch(/security — .*\[pass-security, pass-bounds\]/);
    expect(out).toMatch(
      /critical: enabled = true, min_tier = "sol-high", effort = "high", max_severity = "P0"/,
    );
    expect(out).toMatch(/normal: \(nothing — the shipped behaviour\)/);
  });

  it("status nudges while no profile is named; apply previews, then writes against the app's own default", async () => {
    const defs = profileBelt("");
    expect(await call(defs, "setup_profile")).toMatch(
      /SETUP IS OWED: the live config names no repo profile/,
    );
    const all = Object.fromEntries(
      [
        "correctness",
        "reliability",
        "compatibility",
        "integrations",
        "frontend",
        "design",
        "security",
        "data",
        "money",
        "compliance",
        "style",
        "tests",
      ].map((c) => [c, "normal"]),
    );
    const preview = await call(defs, "setup_profile_apply", {
      profile: "acme",
      priorities: { ...all, security: "critical" },
      goals: "g",
    });
    expect(preview).toMatch(/PREVIEW of profile "acme"/);
    expect(preview).toContain("+ [lenses.pass-security]");
    expect(existsSync(join(dir, "config", "profiles", "acme"))).toBe(false);
    const written = await call(defs, "setup_profile_apply", {
      profile: "acme",
      priorities: { ...all, security: "critical" },
      goals: "g",
      write: true,
    });
    expect(written).toMatch(/Profile "acme" created/);
    expect(written).toMatch(/chain: default → acme/);
    expect(written).toMatch(/until the owner sets `\[review\] profile = "acme"`/);
    expect(written).toMatch(/profile changed, not deployed/);
    expect(await call(defs, "setup_profile_validate", { profile: "acme" })).toMatch(
      /Profile "acme" loads/,
    );
  });
});

describe("the survey tools", () => {
  /** Memory that just keeps notes. */
  class NoteMemory implements MemoryStore {
    notes: string[] = [];
    async read(): Promise<MemoryEntry[]> {
      return [];
    }
    async search(): Promise<MemoryEntry[]> {
      return [];
    }
    async apply(op: MemoryOp) {
      if (op.op === "note") this.notes.push(op.text);
      return { ok: true, message: "ok" };
    }
  }

  function surveyBelt(
    opts: { memory?: MemoryStore | null; answer?: (s: CaseSpec) => CaseOutcome } = {},
  ) {
    const repo = join(dir, "repo");
    tree(repo, {
      "AGENTS.md": "Use the service layer.\n",
      "README.md": "# x\n",
      "api/apps.py": "x\n",
      "api/models.py": "a\nb\n",
      "web/package.json": JSON.stringify({ dependencies: { react: "18" } }),
      "web/src/index.ts": "x\n",
    });
    const specs: CaseSpec[] = [];
    const engine = new SetupEngine({
      repo: checkoutReader(repo),
      state: stateHomeFs(join(dir, "state")),
      clock: () => new Date("2026-09-29T10:00:00Z"),
      memory: opts.memory === undefined ? new NoteMemory() : opts.memory,
      cases: {
        run: async (spec) => {
          specs.push(spec);
          return (
            opts.answer ?? (() => ({ ok: true, output: "[convention] a note", cost_usd: 0.01 }))
          )(spec);
        },
      },
      tracker: notYetTrackerSink(""),
      github: { get: async () => ({ ok: false, reason: "none" }) },
    });
    engine.propose({
      units: [
        { name: "api", roots: ["api"] },
        { name: "web", roots: ["web"] },
        { name: "rest", roots: [""] },
      ],
    });
    engine.save();
    return { engine, defs: toolDefinitions(engine), specs };
  }

  it("preview shows the cases, the reasons, the price basis and the key; start quotes it and returns at once", async () => {
    const { engine, defs, specs } = surveyBelt();
    const preview = await call(defs, "setup_survey_preview");
    expect(preview).toMatch(/Survey plan: 3 cases, \d+ lines, estimated \$\d+\.\d\d/);
    expect(preview).toMatch(/@repo \(repo-wide read\)/);
    expect(preview).toMatch(/AGENTS\.md — agent-directive file/);
    expect(preview).toMatch(/api\/models\.py — model \/ schema/);
    expect(preview).toMatch(/Price basis: reference rate/);
    expect(preview).toMatch(/Not surveyed .*: rest/);
    const key = /Preview key: ([0-9a-f]{12})/.exec(preview)![1]!;

    expect(await call(defs, "setup_survey_start", {})).toMatch(
      /Survey start refused:\n✗ no preview key/,
    );
    expect(await call(defs, "setup_survey_start", { key: "000000000000" })).toMatch(
      /the plan changed since that preview/,
    );
    const started = await call(defs, "setup_survey_start", { key });
    expect(started).toMatch(/started in the background: 3 cases/);
    await engine.surveyIdle();
    expect(specs.map((s) => s.agent)).toEqual(["pass-survey", "pass-survey", "pass-survey"]);
    const status = await call(defs, "setup_survey_status");
    expect(status).toMatch(/: complete\. 3\/3 cases done; 3 notes written/);
    expect(await call(defs, "setup_survey_stop")).toMatch(
      /Survey stop refused:\n✗ no survey is running/,
    );
    // A second plain start is refused: re-surveys are on request only.
    expect(await call(defs, "setup_survey_start", { key })).toMatch(/resurvey: true/);
    expect(await call(defs, "setup_survey_preview")).toMatch(/starting again is a RE-SURVEY/);
  });

  it("with no memory the preview names the blocker and start refuses", async () => {
    const { defs } = surveyBelt({ memory: null });
    const preview = await call(defs, "setup_survey_preview");
    expect(preview).toMatch(/Existing #survey memory: UNKNOWN/);
    expect(preview).toMatch(
      /✗ survey notes are written to reviewer memory, and this companion has no memory store/,
    );
  });

  it("status before any survey, and a failed case, render honestly", async () => {
    const { engine, defs } = surveyBelt({ answer: () => ({ ok: false, reason: "pi exited 1" }) });
    expect(await call(defs, "setup_survey_status")).toBe("No survey has run yet.");
    const key = /Preview key: ([0-9a-f]{12})/.exec(await call(defs, "setup_survey_preview"))![1]!;
    await call(defs, "setup_survey_start", { key });
    await engine.surveyIdle();
    const status = await call(defs, "setup_survey_status");
    expect(status).toMatch(/: partial\. 0\/3 cases done/);
    expect(status).toMatch(/- api: failed, 0 notes — pi exited 1/);
  });

  it("a spend that misses an unpriced finished case reads as a floor, never the whole spend", () => {
    const c = (id: string, cost: number | null) => ({
      id,
      unit: id,
      stage: "unit" as const,
      files: [],
      lines: 10,
      status: "done" as const,
      notes_written: 1,
      notes_failed: 0,
      notes_dropped: 0,
      notes_truncated: 0,
      none: false,
      cost_usd: cost,
      error: null,
      started_at: null,
      finished_at: null,
    });
    const run = {
      id: "survey-x",
      started_at: "t",
      finished_at: "t",
      head: null,
      plan_key: "k",
      estimate_usd: 1,
      rate_basis: "r",
      resurvey: false,
      state: "complete" as const,
      display: "complete" as const,
      cases: [c("a", 0.25), c("b", null)],
      unsampled: [],
      superseded: 0,
      problems: [],
    };
    const text = renderSurveyStatus({
      ok: true,
      problems: [],
      run,
      last_complete: null,
      active: false,
    });
    expect(text).toMatch(/spent at least \$0\.25 of an estimated \$1\.00/);
    const all = renderSurveyStatus({
      ok: true,
      problems: [],
      run: { ...run, cases: [c("a", 0.25)] },
      last_complete: null,
      active: false,
    });
    expect(all).toMatch(/spent \$0\.25 of/);
    for (const status of ["failed", "stopped"] as const) {
      const partial = renderSurveyStatus({
        ok: true,
        problems: [],
        run: { ...run, cases: [c("a", 0.25), { ...c("b", null), status, started_at: "t" }] },
        last_complete: null,
        active: false,
      });
      expect(partial).toContain("spent at least $0.25");
    }

    // A note cut at the length cap is counted where the operator reads it.
    const cut = renderSurveyStatus({
      ok: true,
      problems: [],
      run: { ...run, cases: [{ ...c("a", 0.25), notes_truncated: 2 }] },
      last_complete: null,
      active: false,
    });
    expect(cut).toMatch(/2 cut at the length cap/);
  });

  it("the belt's engine reads the REVIEWER key only, and no memory without it", async () => {
    expect(reviewerMemoryFromEnv({} as NodeJS.ProcessEnv)).toBeNull();
    expect(
      reviewerMemoryFromEnv({ OPENVIKING_URL: "http://x:1933" } as NodeJS.ProcessEnv),
    ).toBeNull();
    // The companion's own key is not the reviewer's.
    expect(
      reviewerMemoryFromEnv({
        OPENVIKING_URL: "http://x:1933",
        OPENVIKING_API_KEY: "k",
      } as NodeJS.ProcessEnv),
    ).toBeNull();
    expect(
      reviewerMemoryFromEnv({
        OPENVIKING_URL: "http://x:1933",
        OPENVIKING_REVIEWER_KEY: "k",
      } as NodeJS.ProcessEnv),
    ).not.toBeNull();
    const engine = buildEngine({
      QCR_REVIEWED_REPO: join(dir, "absent"),
      QCR_STATE_HOME: join(dir, "state"),
    } as NodeJS.ProcessEnv);
    expect(await call(toolDefinitions(engine), "setup_survey_start", { key: "x" })).toMatch(
      /no memory store/,
    );
  });
});

describe("the pass-survey agent and the case runner", () => {
  it("the agent file is a read-only leaf at low, named apart from the companion's survey skill", () => {
    expect(COMPANION_AGENTS_DIR).toBe(join(process.cwd(), "docker/companion/agents"));
    const agent = parseAgentFile(
      readFileSync(join(COMPANION_AGENTS_DIR, "pass-survey.md"), "utf8"),
    )!;
    expect(agent).toMatchObject({
      name: "pass-survey",
      tools: ["read", "grep", "find", "ls"],
      model: "openai-codex/gpt-6.1-sol:low",
    });
    expect(agent.systemPrompt).toMatch(/\[convention\]/);
    expect(agent.systemPrompt).toMatch(/NONE/);
    // The companion's candidate-triage skill keeps its own name.
    expect(existsSync(join(process.cwd(), "skills/companion/survey/SKILL.md"))).toBe(true);
    expect(agent.name).not.toBe("survey");
  });

  /** A fake child: emits the given JSON lines, then closes with `code`. */
  function fakeSpawn(lines: unknown[], code = 0, hold = false, stderrText = "") {
    const calls: Array<{ command: string; args: string[]; cwd: string }> = [];
    const kills: string[] = [];
    const spawn: SpawnFn = (command, args, o) => {
      calls.push({ command, args, cwd: o.cwd });
      const child = new EventEmitter() as EventEmitter & ReturnType<SpawnFn>;
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      Object.assign(child, {
        stdout,
        stderr,
        kill: (sig?: string) => {
          kills.push(sig ?? "SIGTERM");
          setTimeout(() => child.emit("close", null), 0);
          return true;
        },
      });
      setTimeout(() => {
        for (const l of lines) stdout.write(`${JSON.stringify(l)}\n`);
        // In chunks, as a pipe delivers it.
        for (let i = 0; i < stderrText.length; i += 1000)
          stderr.write(stderrText.slice(i, i + 1000));
        if (!hold) setTimeout(() => child.emit("close", code), 5);
      }, 0);
      return child;
    };
    return { spawn, calls, kills };
  }

  const spec: CaseSpec = {
    id: "survey-1/api",
    unit: "api",
    agent: "pass-survey",
    files: ["api/models.py"],
    prompt: "SURVEY — do it",
  };
  const msg = (text: string, cost: number, extra: Record<string, unknown> = {}) => ({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
      usage: { cost: { total: cost } },
      ...extra,
    },
  });

  it("runs the agent as an isolated pi leaf and returns its last answer and summed cost", async () => {
    const f = fakeSpawn([
      msg("thinking…", 0.01),
      { type: "tool_result_end", message: {} },
      msg("[convention] x", 0.02),
    ]);
    const runner = piCaseRunner({
      agentsDir: COMPANION_AGENTS_DIR,
      cwd: "/workspace",
      spawn: f.spawn,
      invocation: { command: "pi", prefix: [] },
    });
    const heard: number[] = [];
    const out = await runner.run(spec, new AbortController().signal, (v) => heard.push(v));
    // It made no tool call, and SAYS so: `reads: []` is "read nothing", never unknown.
    expect(out).toEqual({
      ok: true,
      output: "[convention] x",
      cost_usd: expect.closeTo(0.03),
      reads: [],
    });
    // The running cost is heard as it grows, so a capped caller can
    // stop a case mid-flight.
    expect(heard).toEqual([expect.closeTo(0.01), expect.closeTo(0.03)]);
    const { command, args, cwd } = f.calls[0]!;
    expect(command).toBe("pi");
    expect(cwd).toBe("/workspace"); // never the reviewed checkout
    expect(args.slice(0, 10)).toEqual([
      "--mode",
      "json",
      "-p",
      "--no-session",
      "-ne",
      "-ns",
      "-nc",
      "--extension",
      "/workspace/extensions/cli/bash-guard.ts",
      "--approve",
    ]);
    expect(args).toEqual(
      expect.arrayContaining([
        "--model",
        "openai-codex/gpt-6.1-sol:low",
        "--tools",
        "read,grep,find,ls",
        "--append-system-prompt",
      ]),
    );
    expect(args.at(-1)).toBe("Task: SURVEY — do it");
  });

  it("reports the paths its file-read tool calls named — read and grep, in call order; find/ls are not reads", async () => {
    let n = 0;
    // Each call starts and then ends — successfully unless told otherwise.
    const tool = (toolName: string, args: Record<string, unknown>, isError = false) => {
      const toolCallId = `c-${++n}`;
      return [
        { type: "tool_execution_start", toolCallId, toolName, args },
        { type: "tool_execution_end", toolCallId, toolName, result: {}, isError },
      ];
    };
    const f = fakeSpawn([
      ...tool("ls", { path: "/tree/api" }),
      ...tool("read", { path: "/tree/api/models.py", offset: 1 }),
      ...tool("find", { pattern: "*.py", path: "/tree" }),
      ...tool("grep", { pattern: "save", path: "/tree/api/views.py" }),
      ...tool("grep", { pattern: "x" }),
      ...tool("read", { nope: 1 }),
      msg("NONE", 0.01),
    ]);
    const runner = piCaseRunner({
      agentsDir: COMPANION_AGENTS_DIR,
      cwd: "/w",
      spawn: f.spawn,
      invocation: { command: "pi", prefix: [] },
    });
    const out = await runner.run(spec, new AbortController().signal);
    expect(out).toEqual({
      ok: true,
      output: "NONE",
      cost_usd: expect.closeTo(0.01),
      reads: ["/tree/api/models.py", "/tree/api/views.py"],
    });
  });

  it("credits a read only when its call succeeded — a failed read or grep, or one never finished, opened nothing", async () => {
    const start = (toolCallId: string, toolName: string, path: string) => ({
      type: "tool_execution_start",
      toolCallId,
      toolName,
      args: { path },
    });
    const end = (toolCallId: string, isError: boolean) => ({
      type: "tool_execution_end",
      toolCallId,
      toolName: "read",
      result: {},
      isError,
    });
    const f = fakeSpawn([
      start("a", "read", "/tree/missing.py"),
      end("a", true),
      start("b", "grep", "/tree/api/views.py"),
      end("b", true), // "Failed to run ripgrep: spawn rg EACCES"
      start("c", "read", "/tree/api/models.py"),
      start("d", "read", "/tree/api/urls.py"),
      end("d", false),
      msg("NONE", 0.01),
    ]);
    const out = await piCaseRunner({
      agentsDir: COMPANION_AGENTS_DIR,
      cwd: "/w",
      spawn: f.spawn,
      invocation: { command: "pi", prefix: [] },
    }).run(spec, new AbortController().signal);
    expect(out).toMatchObject({ ok: true, reads: ["/tree/api/urls.py"] });
  });

  it("names the LAST of a long stderr as the reason a case failed", async () => {
    const noise = `${"startup chatter\n".repeat(400)}`;
    const f = fakeSpawn([], 1, false, `${noise}FATAL: the real cause\n`);
    const out = await piCaseRunner({
      agentsDir: COMPANION_AGENTS_DIR,
      cwd: "/w",
      spawn: f.spawn,
      invocation: { command: "pi", prefix: [] },
    }).run(spec, new AbortController().signal);
    expect(out).toMatchObject({
      ok: false,
      reason: expect.stringContaining("FATAL: the real cause"),
    });
  });

  it("a temp directory it cannot make is a failed case, never a rejection", async () => {
    const was = process.env.TMPDIR;
    process.env.TMPDIR = join(dir, "no-such-tmp");
    try {
      const out = await piCaseRunner({
        agentsDir: COMPANION_AGENTS_DIR,
        cwd: "/w",
        spawn: fakeSpawn([msg("NONE", 0.01)]).spawn,
        invocation: { command: "pi", prefix: [] },
      }).run(spec, new AbortController().signal);
      expect(out).toMatchObject({ ok: false, reason: expect.stringMatching(/no temp directory/) });
    } finally {
      if (was === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = was;
    }
  });

  it("every failure resolves as a refusal — with what it spent: exit code, model error, no answer, unknown agent, abort", async () => {
    const inv = { command: "pi", prefix: [] };
    const sig = () => new AbortController().signal;
    const run = (lines: unknown[], code = 0) =>
      piCaseRunner({
        agentsDir: COMPANION_AGENTS_DIR,
        cwd: "/w",
        spawn: fakeSpawn(lines, code).spawn,
        invocation: inv,
      }).run(spec, sig());
    // A failure spent money too: priced when pi said, null
    // (unknown, never free) when it did not, 0 when nothing ever started.
    expect(await run([], 1)).toEqual({ ok: false, reason: "pi exited 1", cost_usd: null });
    expect(
      await run([msg("", 0.02, { stopReason: "error", errorMessage: "rate limited" })]),
    ).toEqual({ ok: false, reason: "rate limited", cost_usd: 0.02 });
    expect(await run([])).toEqual({
      ok: false,
      reason: "the subagent gave no answer",
      cost_usd: null,
    });
    const r = piCaseRunner({
      agentsDir: COMPANION_AGENTS_DIR,
      cwd: "/w",
      spawn: fakeSpawn([]).spawn,
      invocation: inv,
    });
    expect(await r.run({ ...spec, agent: "nope" }, sig())).toEqual({
      ok: false,
      reason: expect.stringMatching(/no agent nope/),
      cost_usd: 0,
    });
    expect(await r.run({ ...spec, agent: "../x" }, sig())).toEqual({
      ok: false,
      reason: expect.stringMatching(/not an agent name/),
      cost_usd: 0,
    });

    const held = fakeSpawn([msg("partial", 0.01)], 0, true);
    const ac = new AbortController();
    const pending = piCaseRunner({
      agentsDir: COMPANION_AGENTS_DIR,
      cwd: "/w",
      spawn: held.spawn,
      invocation: inv,
    }).run(spec, ac.signal);
    await new Promise((res) => setTimeout(res, 10));
    ac.abort();
    expect(await pending).toEqual({ ok: false, reason: "stopped", cost_usd: 0.01 });
    expect(held.kills[0]).toBe("SIGTERM");
  });
});

describe("checkoutReader", () => {
  it("lists what git tracks — ignored build output is not the repo", () => {
    const repo = join(dir, "git");
    tree(repo, {
      "a.py": "x\ny\n",
      ".gitignore": "out/\n",
      "out/gen.js": "x\n",
      "sub/b.py": "z",
      "café.ts": "x",
      " trail .ts ": "x",
      "two\nlines.ts": "x",
    });
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", repo, ...args], { stdio: "ignore" });
    git("init", "-q");
    git("add", "-A");
    git(
      "-c",
      "user.email=t@t",
      "-c",
      "user.name=t",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-qm",
      "init",
    );
    const r = checkoutReader(repo);
    expect(r.listFiles()?.sort()).toEqual([
      " trail .ts ",
      ".gitignore",
      "a.py",
      "café.ts",
      "sub/b.py",
      "two\nlines.ts",
    ]);
    expect(r.head()).toMatch(/^[0-9a-f]{40}$/);
    expect(r.lines("a.py")).toBe(2);
    expect(r.lines("sub/b.py")).toBe(1);
    expect(r.changeCounts?.()).toMatchObject({
      "café.ts": 1,
      " trail .ts ": 1,
      "two\nlines.ts": 1,
    });
    // The survey's most-changed count: commits per file over recent history.
    writeFileSync(join(repo, "a.py"), "x\ny\nz\n");
    git(
      "-c",
      "user.email=t@t",
      "-c",
      "user.name=t",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-qam",
      "two",
    );
    expect(r.changeCounts?.()).toEqual({
      ".gitignore": 1,
      "a.py": 2,
      "sub/b.py": 1,
      "café.ts": 1,
      " trail .ts ": 1,
      "two\nlines.ts": 1,
    });
  });

  it("falls back to a walk without git, and never reads outside the root or a binary", () => {
    const repo = join(dir, "plain");
    tree(repo, { "x.ts": "x\n", "node_modules/y.js": "y\n", "stray.ts": "const k = `a\0b`;\n" });
    // Real binary bytes (a PNG's signature and header chunk) under a name no
    // extension rule knows: the content alone decides.
    writeFileSync(
      join(repo, "bin.dat"),
      Buffer.from([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52, 0, 0,
        1, 0, 0, 0, 1, 0, 8, 6, 0, 0, 0, 0x5c, 0x72, 0xa8, 0x66,
      ]),
    );
    tree(dir, { "secret.txt": "no" });
    const r = checkoutReader(repo);
    expect(r.listFiles()?.sort()).toEqual(["bin.dat", "stray.ts", "x.ts"]);
    // One stray NUL in a source file is still text.
    expect(r.read("stray.ts")).toBe("const k = `a\0b`;\n");
    expect(r.read("../secret.txt")).toBeNull();
    expect(r.read("/etc/passwd")).toBeNull();
    expect(r.read("bin.dat")).toBeNull();
    expect(r.head()).toBeNull();
    expect(r.changeCounts?.()).toBeNull();
    expect(checkoutReader(join(dir, "absent")).listFiles()).toBeNull();
  });
});

describe("checkoutReader's edges", () => {
  it("reads a name that only starts with two dots — a parent COMPONENT is what leaves the root", () => {
    const repo = join(dir, "dots");
    tree(repo, { "..fixtures/a.ts": "a\n" });
    tree(dir, { "secret.txt": "no" });
    const r = checkoutReader(repo);
    expect(r.listFiles()).toEqual(["..fixtures/a.ts"]);
    expect(r.read("..fixtures/a.ts")).toBe("a\n");
    expect(r.lines("..fixtures/a.ts")).toBe(1);
    expect(r.read("../secret.txt")).toBeNull();
    expect(r.read("..")).toBeNull();
  });

  it("a symlink out of the checkout is not its content, and a directory link is never descended", () => {
    const repo = join(dir, "links");
    tree(repo, { "in.ts": "in\n" });
    tree(dir, { "outside/secret.ts": "no\n" });
    symlinkSync(join(dir, "outside", "secret.ts"), join(repo, "leak.ts"));
    symlinkSync(join(repo, "in.ts"), join(repo, "alias.ts"));
    symlinkSync(".", join(repo, "loop"));
    symlinkSync(join(dir, "outside"), join(repo, "elsewhere"));
    const r = checkoutReader(repo);
    expect(r.listFiles()?.sort()).toEqual(["alias.ts", "in.ts", "leak.ts"]);
    expect(r.read("leak.ts")).toBeNull();
    expect(r.read("elsewhere/secret.ts")).toBeNull();
    expect(r.read("alias.ts")).toBe("in\n");
  });

  it("a child whose metadata is inaccessible makes the fallback listing UNKNOWN", () => {
    if (process.getuid?.() === 0) return;
    const repo = join(dir, "metadata-denied");
    tree(repo, { "a.ts": "a\n", "sealed/b.ts": "b\n" });
    chmodSync(join(repo, "sealed"), 0o444);
    try {
      expect(checkoutReader(repo).listFiles()).toBeNull();
    } finally {
      chmodSync(join(repo, "sealed"), 0o755);
    }
  });

  it("a directory it cannot list makes the listing unknown, never a shorter one", () => {
    if (process.getuid?.() === 0) return; // root lists a 000 directory anyway
    const repo = join(dir, "locked");
    tree(repo, { "a.ts": "a\n", "sealed/b.ts": "b\n" });
    chmodSync(join(repo, "sealed"), 0o000);
    try {
      expect(checkoutReader(repo).listFiles()).toBeNull();
    } finally {
      chmodSync(join(repo, "sealed"), 0o755);
    }
  });
});

describe("configHomeFs", () => {
  it("is the same rooted, atomic port, and names the config home when a path leaves it", () => {
    const fs = configHomeFs(join(dir, "config"));
    fs.write("portrait/narrative.md", "hi\n");
    expect(readFileSync(join(dir, "config", "portrait", "narrative.md"), "utf8")).toBe("hi\n");
    expect(() => fs.write("../secrets/app.pem", "x")).toThrow(/leaves the config home/);
  });
});

describe("stateHomeFs", () => {
  it("writes atomically inside the root and refuses paths that leave it", () => {
    const fs = stateHomeFs(join(dir, "state"));
    expect(fs.read("setup/x.json")).toBeNull();
    fs.write("setup/x.json", "{}\n");
    expect(fs.read("setup/x.json")).toBe("{}\n");
    expect(() => fs.write("../escape", "x")).toThrow(/leaves the state home/);
    expect(() => fs.read("/etc/passwd")).toThrow(/leaves the state home/);
  });
});

describe("tokenFileGitHubReader — GET only, API paths only", () => {
  const now = new Date("2026-09-29T10:00:00Z");
  function envFile(expires: string): string {
    const p = join(dir, "github-read.env");
    writeFileSync(
      p,
      `QCR_GITHUB_READ_TOKEN=ghs_abc\nQCR_GITHUB_READ_EXPIRES_AT=${expires}\nQCR_GITHUB_REPO=o/r\n`,
    );
    return p;
  }

  it("GETs under the API root with the token, and nothing else", async () => {
    const fetch = vi.fn(
      async () => new Response(JSON.stringify({ full_name: "o/r" }), { status: 200 }),
    );
    const gh = tokenFileGitHubReader({
      envFile: envFile("2026-09-29T11:00:00Z"),
      fetch: fetch as unknown as typeof globalThis.fetch,
      clock: () => now,
    });
    expect(await gh.get("/repos/o/r")).toEqual({ ok: true, data: { full_name: "o/r" } });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.github.com/repos/o/r");
    expect(init.method).toBe("GET");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer ghs_abc");
  });

  it("refuses a path that could aim the token elsewhere, and an expired or missing token", async () => {
    const fetch = vi.fn();
    const f = fetch as unknown as typeof globalThis.fetch;
    const live = tokenFileGitHubReader({
      envFile: envFile("2026-09-29T11:00:00Z"),
      fetch: f,
      clock: () => now,
    });
    for (const bad of [
      "https://evil.example/x",
      "//evil.example/x",
      "/repos/../x",
      "/repos/%2E%2e/x",
      "repos/o/r",
    ]) {
      expect((await live.get(bad)).ok).toBe(false);
    }
    const expired = tokenFileGitHubReader({
      envFile: envFile("2026-09-29T09:00:00Z"),
      fetch: f,
      clock: () => now,
    });
    expect(await expired.get("/repos/o/r")).toEqual({
      ok: false,
      reason: expect.stringMatching(/expired/),
    });
    const none = tokenFileGitHubReader({ envFile: undefined, fetch: f, clock: () => now });
    expect(await none.get("/repos/o/r")).toEqual({
      ok: false,
      reason: expect.stringMatching(/QCR_GITHUB_READ_ENV unset/),
    });
    expect(fetch).not.toHaveBeenCalled();
  });
});
