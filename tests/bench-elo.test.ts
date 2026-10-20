// bench/aacr/elo/ — the pairwise Elo judge. Its own self-test runs
// the canonicalisation, the context packing (against a scratch git repo), the
// verdict check, the Bradley-Terry fit and the adaptive schedule, with no
// model and no network. The rest pins the decisions a quiet edit could undo:
// one no-tool call per judgment, identical prompts for both judges, the GPT
// judge on loopback only, the Opus key never in argv or the environment.
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ELO = join(ROOT, "bench", "aacr", "elo");
const read = (f: string) => readFileSync(join(ELO, f), "utf8");

describe("bench/aacr/elo", () => {
  it("the self-test passes", () => {
    const r = spawnSync("python3", ["-I", join(ELO, "elo.py"), "--self-test"], {
      encoding: "utf8",
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
    });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("elo self-test: ok");
  });

  it("a judgment is one call with no tools, the same prompt for both judges", () => {
    const judge = read("elo_judge.py");
    expect(judge).not.toMatch(/"tools"\s*:/);
    // The tool keys appear once: in the list a request is refused for carrying.
    expect(judge).toMatch(/^TOOL_KEYS = \("tools", "tool_choice",/m);
    expect(judge.replace(/^TOOL_KEYS = \([^)]*\)$/m, "")).not.toMatch(/tool_choice/);
    expect(judge).toContain("check_chat_body(body)");
    expect(judge).toContain("check_opus_params(params)");
    // An answer counts only as one plain final message, recorded as one turn.
    expect(judge).toContain('if finish != "stop":');
    expect(judge).toContain('if stop != "end_turn" or tool_blocks:');
    expect(judge).toMatch(/"turns": 1/);
    // GPT: system + shared context + the two reviews; Opus: the same three texts.
    expect(judge).toContain('{"role": "system", "content": SYSTEM}');
    expect(judge).toContain('"system": SYSTEM');
    const elo = read("elo.py");
    expect(elo).toContain('"prompt_sha256": prompt_sha');
    // A judgment counts only at its unit's current prompt.
    expect(elo).toContain('r.get("prompt_sha256") == sha');
  });

  it("the GPT judge is published on loopback only; the Opus key is read from a file", () => {
    const sh = read("judge-gpt.sh");
    expect(sh).toContain('-p "127.0.0.1:$PORT:8765"');
    expect(sh).not.toMatch(/-p "?\$PORT/);
    const judge = read("elo_judge.py");
    expect(judge).toContain("anthropic.Anthropic(api_key=read_anthropic_key(env_file)");
    expect(judge).not.toMatch(/os\.environ\[?.?ANTHROPIC_API_KEY/);
  });

  it("the smoke plan names its four arms, both judges at xhigh, the agreed caps", () => {
    const plan = JSON.parse(read(join("plans", "martian-hard20-ft0622.json")));
    expect(plan.runs).toEqual([
      "ft0622-hard20-qr-opus55",
      "ft0622-hard20-qr-sonnet55",
      "ft0622-hard20-sonnet",
      "ft0622-hard20-cc-high-sonnet55",
    ]);
    expect(plan.judges.gpt).toMatchObject({ model: "gpt-6.1-sol", effort: "xhigh" });
    expect(plan.judges.opus).toMatchObject({ model: "claude-opus-5-5", effort: "xhigh" });
    expect(plan.max_prompt_tokens).toBe(400000);
    expect(plan.cap).toBe(300);
  });
});
