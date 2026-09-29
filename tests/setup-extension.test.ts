// extensions/setup.ts — the companion's setup tool belt over the SetupEngine
//, and the real ports it assembles (src/setup/adapters.ts). The belt
// is driven over an engine with a scratch checkout and a temp state home; the
// ports are driven against temp dirs, one scratch git repo (the listing is
// `git ls-files`, so git is the thing under test there) and a fake fetch.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PiToolDefinition, PiToolResult } from "@earendil-works/pi-coding-agent";
import { EventEmitter } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import activate, {
  COMPANION_AGENTS_DIR,
  DEFAULT_REVIEWED_REPO,
  buildEngine,
  renderSurveyStatus,
  toolDefinitions,
} from "../extensions/setup.js";
import { CONTAINER } from "../src/tui/companion.js";
import {
  checkoutReader,
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

function textOf(r: PiToolResult): string {
  return r.content.map((c) => c.text).join("\n");
}

async function call(defs: PiToolDefinition[], name: string, params: Record<string, unknown> = {}): Promise<string> {
  const def = defs.find((d) => d.name === name);
  expect(def, `tool ${name}`).toBeDefined();
  return textOf(await def!.execute("id", params));
}

describe("the tool belt", () => {
  function belt(): PiToolDefinition[] {
    const repo = join(dir, "repo");
    tree(repo, {
      "README.md": "# x\n",
      "api/apps.py": "x\n",
      "api/views.py": "a\nb\n",
      "web/package.json": JSON.stringify({ dependencies: { react: "18" } }),
      "web/src/a.tsx": "x\n",
      ".github/workflows/ci.yml": "name: CI\n",
    });
    const engine = buildEngine({ QCR_REVIEWED_REPO: repo, QCR_STATE_HOME: join(dir, "state") } as NodeJS.ProcessEnv);
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
    ]);
    for (const n of names) expect(n).toMatch(/^[a-z][a-z0-9_]*$/);
  });

  it("drives the whole cut: facts → propose → adjust → save, then status shows it in use", async () => {
    const defs = belt();
    const facts = await call(defs, "setup_repo_facts");
    expect(facts).toMatch(/GitHub Actions — \.github\/workflows\/ci\.yml \("CI"\)/);
    expect(facts).toMatch(/React — web\/package\.json/);
    expect(facts).toMatch(/Unit candidates/);

    const proposed = await call(defs, "setup_unit_cut_propose", { units: [{ name: "api", roots: ["api"] }] });
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

  it("answers a bad call with a refusal, never a throw", async () => {
    const defs = belt();
    expect(await call(defs, "setup_unit_cut_adjust", {})).toMatch(/Adjustment refused:\n✗ `ops` must be/);
    expect(await call(defs, "setup_unit_cut_propose", { units: "nope" })).toMatch(/Proposal refused/);
  });

  it("the default checkout path is the companion's mount point", () => {
    expect(DEFAULT_REVIEWED_REPO).toBe(CONTAINER.reviewedRepo);
  });

  it("an unreadable cut file renders the saved cut as UNKNOWN, never as 'no saved cut'", async () => {
    const state = join(dir, "state");
    tree(state, { "setup/unit-cut.json": "{ not json" });
    const engine = buildEngine({ QCR_REVIEWED_REPO: join(dir, "absent"), QCR_STATE_HOME: state } as NodeJS.ProcessEnv);
    const out = await call(toolDefinitions(engine), "setup_unit_cut");
    expect(out).toMatch(/Saved unit cut: UNKNOWN/);
    expect(out).not.toMatch(/No saved unit cut yet/);
  });

  it("a missing checkout is a refusal from the tools, not a failed start", async () => {
    const engine = buildEngine({ QCR_REVIEWED_REPO: join(dir, "absent"), QCR_STATE_HOME: join(dir, "state") } as NodeJS.ProcessEnv);
    expect(await call(toolDefinitions(engine), "setup_repo_facts")).toMatch(/no readable checkout at .*absent/);
  });

  it("activation degrades on a pi without registerTool, and registers every tool on one with it", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      activate({ on: () => {}, sendUserMessage: () => {} });
      expect(err).toHaveBeenCalledWith(expect.stringMatching(/registerTool unavailable/));
      const registered: string[] = [];
      activate({ on: () => {}, sendUserMessage: () => {}, registerTool: (d) => registered.push(d.name) });
      expect(registered).toHaveLength(11);
    } finally {
      err.mockRestore();
    }
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

  function surveyBelt(opts: { memory?: MemoryStore | null; answer?: (s: CaseSpec) => CaseOutcome } = {}) {
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
          return (opts.answer ?? (() => ({ ok: true, output: "[convention] a note", cost_usd: 0.01 })))(spec);
        },
      },
      tracker: notYetTrackerSink(""),
      github: { get: async () => ({ ok: false, reason: "none" }) },
    });
    engine.propose({ units: [{ name: "api", roots: ["api"] }, { name: "web", roots: ["web"] }, { name: "rest", roots: [""] }] });
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

    expect(await call(defs, "setup_survey_start", {})).toMatch(/Survey start refused:\n✗ no preview key/);
    expect(await call(defs, "setup_survey_start", { key: "000000000000" })).toMatch(/the plan changed since that preview/);
    const started = await call(defs, "setup_survey_start", { key });
    expect(started).toMatch(/started in the background: 3 cases/);
    await engine.surveyIdle();
    expect(specs.map((s) => s.agent)).toEqual(["pass-survey", "pass-survey", "pass-survey"]);
    const status = await call(defs, "setup_survey_status");
    expect(status).toMatch(/: complete\. 3\/3 cases done; 3 notes written/);
    expect(await call(defs, "setup_survey_stop")).toMatch(/Survey stop refused:\n✗ no survey is running/);
    // A second plain start is refused: re-surveys are on request only.
    expect(await call(defs, "setup_survey_start", { key })).toMatch(/resurvey: true/);
    expect(await call(defs, "setup_survey_preview")).toMatch(/starting again is a RE-SURVEY/);
  });

  it("with no memory the preview names the blocker and start refuses", async () => {
    const { defs } = surveyBelt({ memory: null });
    const preview = await call(defs, "setup_survey_preview");
    expect(preview).toMatch(/Existing #survey memory: UNKNOWN/);
    expect(preview).toMatch(/✗ survey notes are written to reviewer memory, and this companion has no memory store/);
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
      id, unit: id, stage: "unit" as const, files: [], lines: 10, status: "done" as const,
      notes_written: 1, notes_failed: 0, notes_dropped: 0, notes_truncated: 0, none: false,
      cost_usd: cost, error: null, started_at: null, finished_at: null,
    });
    const run = {
      id: "survey-x", started_at: "t", finished_at: "t", head: null, plan_key: "k", estimate_usd: 1,
      rate_basis: "r", resurvey: false, state: "complete" as const, display: "complete" as const,
      cases: [c("a", 0.25), c("b", null)], unsampled: [], superseded: 0, problems: [],
    };
    const text = renderSurveyStatus({ ok: true, problems: [], run, last_complete: null, active: false });
    expect(text).toMatch(/spent at least \$0\.25 of an estimated \$1\.00/);
    const all = renderSurveyStatus({ ok: true, problems: [], run: { ...run, cases: [c("a", 0.25)] }, last_complete: null, active: false });
    expect(all).toMatch(/spent \$0\.25 of/);
  });

  it("the belt's engine reads the REVIEWER key only, and no memory without it", async () => {
    expect(reviewerMemoryFromEnv({} as NodeJS.ProcessEnv)).toBeNull();
    expect(reviewerMemoryFromEnv({ OPENVIKING_URL: "http://x:1933" } as NodeJS.ProcessEnv)).toBeNull();
    // The companion's own key is not the reviewer's.
    expect(reviewerMemoryFromEnv({ OPENVIKING_URL: "http://x:1933", OPENVIKING_API_KEY: "k" } as NodeJS.ProcessEnv)).toBeNull();
    expect(reviewerMemoryFromEnv({ OPENVIKING_URL: "http://x:1933", OPENVIKING_REVIEWER_KEY: "k" } as NodeJS.ProcessEnv)).not.toBeNull();
    const engine = buildEngine({ QCR_REVIEWED_REPO: join(dir, "absent"), QCR_STATE_HOME: join(dir, "state") } as NodeJS.ProcessEnv);
    expect(await call(toolDefinitions(engine), "setup_survey_start", { key: "x" })).toMatch(/no memory store/);
  });
});

describe("the pass-survey agent and the case runner", () => {
  it("the agent file is a read-only leaf at low, named apart from the companion's survey skill", () => {
    expect(COMPANION_AGENTS_DIR).toBe(join(process.cwd(), "docker/companion/agents"));
    const agent = parseAgentFile(readFileSync(join(COMPANION_AGENTS_DIR, "pass-survey.md"), "utf8"))!;
    expect(agent).toMatchObject({ name: "pass-survey", tools: ["read", "grep", "find", "ls"], model: "openai-codex/gpt-6-sol:low" });
    expect(agent.systemPrompt).toMatch(/\[convention\]/);
    expect(agent.systemPrompt).toMatch(/NONE/);
    // The companion's candidate-triage skill keeps its own name.
    expect(existsSync(join(process.cwd(), "skills/companion/survey/SKILL.md"))).toBe(true);
    expect(agent.name).not.toBe("survey");
  });

  /** A fake child: emits the given JSON lines, then closes with `code`. */
  function fakeSpawn(lines: unknown[], code = 0, hold = false) {
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
        if (!hold) setTimeout(() => child.emit("close", code), 5);
      }, 0);
      return child;
    };
    return { spawn, calls, kills };
  }

  const spec: CaseSpec = { id: "survey-1/api", unit: "api", agent: "pass-survey", files: ["api/models.py"], prompt: "SURVEY — do it" };
  const msg = (text: string, cost: number, extra: Record<string, unknown> = {}) => ({
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text }], usage: { cost: { total: cost } }, ...extra },
  });

  it("runs the agent as an isolated pi leaf and returns its last answer and summed cost", async () => {
    const f = fakeSpawn([msg("thinking…", 0.01), { type: "tool_result_end", message: {} }, msg("[convention] x", 0.02)]);
    const runner = piCaseRunner({ agentsDir: COMPANION_AGENTS_DIR, cwd: "/workspace", spawn: f.spawn, invocation: { command: "pi", prefix: [] } });
    const out = await runner.run(spec, new AbortController().signal);
    expect(out).toEqual({ ok: true, output: "[convention] x", cost_usd: expect.closeTo(0.03) });
    const { command, args, cwd } = f.calls[0]!;
    expect(command).toBe("pi");
    expect(cwd).toBe("/workspace"); // never the reviewed checkout
    expect(args.slice(0, 6)).toEqual(["--mode", "json", "-p", "--no-session", "--no-extensions", "--approve"]);
    expect(args).toEqual(expect.arrayContaining(["--model", "openai-codex/gpt-6-sol:low", "--tools", "read,grep,find,ls", "--append-system-prompt"]));
    expect(args.at(-1)).toBe("Task: SURVEY — do it");
  });

  it("every failure resolves as a refusal: exit code, model error, no answer, unknown agent, abort", async () => {
    const inv = { command: "pi", prefix: [] };
    const sig = () => new AbortController().signal;
    const run = (lines: unknown[], code = 0) =>
      piCaseRunner({ agentsDir: COMPANION_AGENTS_DIR, cwd: "/w", spawn: fakeSpawn(lines, code).spawn, invocation: inv }).run(spec, sig());
    expect(await run([], 1)).toEqual({ ok: false, reason: "pi exited 1" });
    expect(await run([msg("", 0, { stopReason: "error", errorMessage: "rate limited" })])).toEqual({ ok: false, reason: "rate limited" });
    expect(await run([])).toEqual({ ok: false, reason: "the subagent gave no answer" });
    const r = piCaseRunner({ agentsDir: COMPANION_AGENTS_DIR, cwd: "/w", spawn: fakeSpawn([]).spawn, invocation: inv });
    expect(await r.run({ ...spec, agent: "nope" }, sig())).toEqual({ ok: false, reason: expect.stringMatching(/no agent nope/) });
    expect(await r.run({ ...spec, agent: "../x" }, sig())).toEqual({ ok: false, reason: expect.stringMatching(/not an agent name/) });

    const held = fakeSpawn([msg("partial", 0.01)], 0, true);
    const ac = new AbortController();
    const pending = piCaseRunner({ agentsDir: COMPANION_AGENTS_DIR, cwd: "/w", spawn: held.spawn, invocation: inv }).run(spec, ac.signal);
    await new Promise((res) => setTimeout(res, 10));
    ac.abort();
    expect(await pending).toEqual({ ok: false, reason: "stopped" });
    expect(held.kills[0]).toBe("SIGTERM");
  });
});

describe("checkoutReader", () => {
  it("lists what git tracks — ignored build output is not the repo", () => {
    const repo = join(dir, "git");
    tree(repo, { "a.py": "x\ny\n", ".gitignore": "out/\n", "out/gen.js": "x\n", "sub/b.py": "z" });
    const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "ignore" });
    git("init", "-q");
    git("add", "-A");
    git("-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", "commit", "-qm", "init");
    const r = checkoutReader(repo);
    expect(r.listFiles()?.sort()).toEqual([".gitignore", "a.py", "sub/b.py"]);
    expect(r.head()).toMatch(/^[0-9a-f]{40}$/);
    expect(r.lines("a.py")).toBe(2);
    expect(r.lines("sub/b.py")).toBe(1);
    // The survey's most-changed count: commits per file over recent history.
    writeFileSync(join(repo, "a.py"), "x\ny\nz\n");
    git("-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", "commit", "-qam", "two");
    expect(r.changeCounts?.()).toEqual({ ".gitignore": 1, "a.py": 2, "sub/b.py": 1 });
  });

  it("falls back to a walk without git, and never reads outside the root or a binary", () => {
    const repo = join(dir, "plain");
    tree(repo, { "x.ts": "x\n", "node_modules/y.js": "y\n", "bin.dat": "a\0b" });
    tree(dir, { "secret.txt": "no" });
    const r = checkoutReader(repo);
    expect(r.listFiles()?.sort()).toEqual(["bin.dat", "x.ts"]);
    expect(r.read("../secret.txt")).toBeNull();
    expect(r.read("/etc/passwd")).toBeNull();
    expect(r.read("bin.dat")).toBeNull();
    expect(r.head()).toBeNull();
    expect(r.changeCounts?.()).toBeNull();
    expect(checkoutReader(join(dir, "absent")).listFiles()).toBeNull();
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
    writeFileSync(p, `QCR_GITHUB_READ_TOKEN=ghs_abc\nQCR_GITHUB_READ_EXPIRES_AT=${expires}\nQCR_GITHUB_REPO=o/r\n`);
    return p;
  }

  it("GETs under the API root with the token, and nothing else", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ full_name: "o/r" }), { status: 200 }));
    const gh = tokenFileGitHubReader({ envFile: envFile("2026-09-29T11:00:00Z"), fetch: fetch as unknown as typeof globalThis.fetch, clock: () => now });
    expect(await gh.get("/repos/o/r")).toEqual({ ok: true, data: { full_name: "o/r" } });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.github.com/repos/o/r");
    expect(init.method).toBe("GET");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer ghs_abc");
  });

  it("refuses a path that could aim the token elsewhere, and an expired or missing token", async () => {
    const fetch = vi.fn();
    const f = fetch as unknown as typeof globalThis.fetch;
    const live = tokenFileGitHubReader({ envFile: envFile("2026-09-29T11:00:00Z"), fetch: f, clock: () => now });
    for (const bad of ["https://evil.example/x", "//evil.example/x", "/repos/../x", "/repos/%2E%2e/x", "repos/o/r"]) {
      expect((await live.get(bad)).ok).toBe(false);
    }
    const expired = tokenFileGitHubReader({ envFile: envFile("2026-09-29T09:00:00Z"), fetch: f, clock: () => now });
    expect(await expired.get("/repos/o/r")).toEqual({ ok: false, reason: expect.stringMatching(/expired/) });
    const none = tokenFileGitHubReader({ envFile: undefined, fetch: f, clock: () => now });
    expect(await none.get("/repos/o/r")).toEqual({ ok: false, reason: expect.stringMatching(/QCR_GITHUB_READ_ENV unset/) });
    expect(fetch).not.toHaveBeenCalled();
  });
});
