// The OpenCode arm of the AACR-Bench harness (`bench.sh --arm opencode`).
//
// The AACR harness ships runners for three reviewers — OCR, Claude Code and
// Codex CLI (`evaluation/reviewers/{ocr,claude,codex}.py` at the pinned
// harness commit) — and none for OpenCode. This module is that runner, built
// in the shape of the harness's CODEX runner so the rows compare:
//
//   harness codex.py                          here
//   ----------------------------------------  ---------------------------------------
//   `codex exec review "/review B...H (F)"`   `opencode run --command review "B...H (F)"`
//     (codex's built-in /review)                (OpenCode's built-in /review template,
//                                               re-declared with subtask:false — see
//                                               REVIEW_COMMAND_TEMPLATE)
//   F = INLINE_FINDINGS_PROMPT_FRAGMENT       the same fragment, word for word, but the
//                                               tool is named `findings_report` (OpenCode
//                                               prefixes MCP tools with the server name)
//   MCP server mcp_codex_finding_server.py    the SAME script from the pinned harness,
//     report(file, start_line, end_line,        run by the harness's own venv
//     severity, summary, description)
//   --sandbox workspace-write                 --auto (permissions not explicitly denied are
//                                               approved); webfetch and directories outside
//                                               the tree denied (workspace-write has no network)
//   process timeout = timeout×60 + 60 s       the same (timeout 30 → 1,860 s)
//   save_result: MCP partial vs JSON parsed   the same dual channel and the same tie rule
//     from the final text, the larger wins,     (text = the session's last answer)
//     tie → MCP
//   result file { review_output, … }          the same payload, reviewer "opencode", PLUS
//                                               `review.comments` — the identical comments in
//                                               the OCR reader's shape (note = summary + "\n"
//                                               + description, lines = start/end), because
//                                               the bench scores every arm with the harness's
//                                               OCR reader and the defect judge reads that key
//
// What cannot be the harness's: the model endpoint. Like the OCR arm, OpenCode
// reaches `gpt-6-sol` through the loopback Codex bridge (bench/aacr/
// codex_bridge.py) as a custom OpenAI-compatible provider; the bridge forces
// the model and the effort and reads only the sandbox's refresh-disabled copy
// of the pi login. OpenCode itself never sees a credential: its API key is a
// dummy for the loopback, and its data dir (where it would keep its own
// auth.json) is a fresh per-case tmpfs directory.
//
// No PR title or description reaches OpenCode — the harness's codex runner
// passes none either — unless the equal-inputs switch is on (QCR_BENCH_PR_TEXT=1,
// src/bench/prtext.ts): then they follow the target in the `review` command's
// arguments ($ARGUMENTS — the template's own "Input").
//
// The native provider (QCR_BENCH_OPENCODE_PROVIDER=native).
// The bridge above costs OpenCode two things its own path has: reasoning carried
// between tool turns (encrypted reasoning content) and prompt caching. Native,
// OpenCode talks to the ChatGPT Codex backend itself, through its OWN built-in
// ChatGPT Plus/Pro login (the `openai` provider's OAuth loader — an internal
// default plugin, so OPENCODE_DISABLE_DEFAULT_PLUGINS stays unset on this path),
// model `openai/<model>`, the built-in `review` command as shipped
// (`subtask: true` — its duplicate reports are the tool's own behaviour), and
// `--variant <effort>` (the openai variant: reasoningEffort + reasoningSummary
// "auto" + include reasoning.encrypted_content). Its credential follows the
// Codex arm's rule: `opencodeAuthFrom` builds OpenCode's auth.json from the
// sandbox's refresh-disabled pi copy — the access token, its expiry and account
// id, with the refresh token the disabled sentinel — in the per-case data dir
// that dies with the case. OpenCode refreshes only an EXPIRED token
// (`expires < now`), and syncBenchAuth refuses a case the token would not
// outlive; were it ever to try, it could only send the sentinel, which no OAuth
// server accepts, so the companion's grant can never be rotated. OpenCode's
// token issuer is not configurable (unlike Codex's
// CODEX_REFRESH_TOKEN_URL_OVERRIDE), which is why the sentinel is the brace.
// Native default effort: OpenCode sets NO reasoning effort for `gpt-6-sol`
// without a variant (its "medium" default applies only to ids containing
// `gpt-5`), so the backend's own default would apply; the arm keeps
// `--variant medium`, the effort every other OpenAI arm ran at. Tokens come from
// OpenCode's own session store (every step of every session, the subtask's
// included — the event stream carries the parent's only), read with
// `opencode db` before the data dir is removed.

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { safeId, type BenchCase, type CaseSet, type PrefetchMeta } from "./aacr.js";
import {
  authFingerprint,
  AuthExpiring,
  benchAuthMode,
  DISABLED_REFRESH,
  syncBenchAuth,
} from "./auth.js";
import { jwtAccount } from "./codex.js";
import { run } from "./exec.js";
import { bridgeDelta, type BridgeStats, type BridgeUsage } from "./ocr.js";
import { prTextFor } from "./prtext.js";
import { roundMetrics } from "./report.js";
import { prepareTree } from "./runner.js";

// ---- the harness's codex runner, mirrored -----------------------------------------

/** reviewers/codex.py `review_instance(timeout_minutes=30)` = pipeline.py
 * `apply_defaults` (timeout None → 30). */
export const OPENCODE_HARNESS_DEFAULTS = { timeoutMin: 30 } as const;

/** reviewers/codex.py `run_codex_review`: `process_timeout = timeout_minutes * 60 + 60`. */
export function opencodeProcessTimeoutMs(timeoutMin: number): number {
  return (timeoutMin * 60 + 60) * 1000;
}

/** The MCP server's name in OpenCode's config; its `report` tool is exposed
 * to the model as `<server>_report`. */
export const FINDINGS_SERVER = "findings";
export const FINDINGS_TOOL = `${FINDINGS_SERVER}_report`;

/** reviewers/codex.py INLINE_FINDINGS_PROMPT_FRAGMENT at the pinned harness
 * commit, verbatim, except the tool's name. */
export const INLINE_FINDINGS_PROMPT_FRAGMENT =
  `You have an MCP tool named \`${FINDINGS_TOOL}\`. The moment you confirm any individual ` +
  "code-review finding, immediately call this tool once for that single finding " +
  "— do not wait until the end or batch them into one final message. The tool is " +
  "already bound to the instance under review, so you do NOT pass any instance id. " +
  "For every call provide ONLY the finding itself:\n" +
  "  - file: path relative to the repository root\n" +
  "  - start_line: the 1-based starting line number\n" +
  "  - end_line: the 1-based ending line number (for single-line issues, set equal to start_line or omit)\n" +
  "  - severity: one of Critical, Major, Minor, Trivial, Info\n" +
  "  - summary: a concise one-line title of the issue\n" +
  "  - description: detailed explanation including failure scenario and suggested fix\n" +
  "Call the tool exactly once per finding, in addition to whatever you normally " +
  "print. Any finding not sent through this tool will be lost.";

/** reviewers/codex.py `build_findings_prompt` is `/review {base}...{head} ({F})`;
 * with `--command review` OpenCode supplies the `/review` and this is its
 * `$ARGUMENTS`. */
export function opencodeReviewArguments(
  base: string,
  head: string,
  prText: string | null = null,
): string {
  const args = `${base}...${head} (${INLINE_FINDINGS_PROMPT_FRAGMENT})`;
  return prText ? `${args}\n\n${prText}` : args;
}

/**
 * OpenCode 1.18.33's built-in `review` command template, byte for byte (taken
 * from the prompt the binary renders, `$ARGUMENTS` restored; its text matches
 * the binary's embedded template). It is re-declared in the config ONLY to set
 * `subtask: false`: the built-in runs as a subtask, and after the subtask
 * returns OpenCode tells the parent session to "continue with your task" — the
 * parent, which also holds the findings tool and the fragment, would then
 * review the PR again and re-report the same findings. Codex's /review delegates too,
 * but its main thread only relays. With `subtask: false` the one session gets
 * exactly this prompt and reports once. Re-check it on every version bump.
 */
export const REVIEW_COMMAND_TEMPLATE: string =
  "You are a code reviewer. Your job is to review code changes and provide actionable feedback.\n\n---\n\nInput: $ARGUMENTS\n\n---\n\n## Determining What to Review\n\nBased on the input provided, determine which type of review to perform:\n\n1. **No arguments (default)**: Review all uncommitted changes\n   - Run: `git diff` for unstaged changes\n   - Run: `git diff --cached` for staged changes\n   - Run: `git status --short` to identify untracked (net new) files\n\n2. **Commit hash** (40-char SHA or short hash): Review that specific commit\n   - Run: `git show $ARGUMENTS`\n\n3. **Branch name**: Compare current branch to the specified branch\n   - Run: `git diff $ARGUMENTS...HEAD`\n\n4. **PR URL or number** (contains \"github.com\" or \"pull\" or looks like a PR number): Review the pull request\n   - Run: `gh pr view $ARGUMENTS` to get PR context\n   - Run: `gh pr diff $ARGUMENTS` to get the diff\n\nUse best judgement when processing input.\n\n---\n\n## Gathering Context\n\n**Diffs alone are not enough.** After getting the diff, read the entire file(s) being modified to understand the full context. Code that looks wrong in isolation may be correct given surrounding logic—and vice versa.\n\n- Use the diff to identify which files changed\n- Use `git status --short` to identify untracked files, then read their full contents\n- Read the full file to understand existing patterns, control flow, and error handling\n- Check for existing style guide or conventions files (CONVENTIONS.md, AGENTS.md, .editorconfig, etc.)\n\n---\n\n## What to Look For\n\n**Bugs** - Your primary focus.\n- Logic errors, off-by-one mistakes, incorrect conditionals\n- If-else guards: missing guards, incorrect branching, unreachable code paths\n- Edge cases: null/empty/undefined inputs, error conditions, race conditions\n- Security issues: injection, auth bypass, data exposure\n- Broken error handling that swallows failures, throws unexpectedly or returns error types that are not caught.\n\n**Structure** - Does the code fit the codebase?\n- Does it follow existing patterns and conventions?\n- Are there established abstractions it should use but doesn't?\n- Excessive nesting that could be flattened with early returns or extraction\n\n**Performance** - Only flag if obviously problematic.\n- O(n²) on unbounded data, N+1 queries, blocking I/O on hot paths\n\n**Behavior Changes** - If a behavioral change is introduced, raise it (especially if it's possibly unintentional).\n\n---\n\n## Before You Flag Something\n\n**Be certain.** If you're going to call something a bug, you need to be confident it actually is one.\n\n- Only review the changes - do not review pre-existing code that wasn't modified\n- Don't flag something as a bug if you're unsure - investigate first\n- Don't invent hypothetical problems - if an edge case matters, explain the realistic scenario where it breaks\n- If you need more context to be sure, use the tools below to get it\n\n**Don't be a zealot about style.** When checking code against conventions:\n\n- Verify the code is *actually* in violation. Don't complain about else statements if early returns are already being used correctly.\n- Some \"violations\" are acceptable when they're the simplest option. A `let` statement is fine if the alternative is convoluted.\n- Excessive nesting is a legitimate concern regardless of other style choices.\n- Don't flag style preferences as issues unless they clearly violate established project conventions.\n\n---\n\n## Tools\n\nUse these to inform your review:\n\n- **Explore agent** - Find how existing code handles similar problems. Check patterns, conventions, and prior art before claiming something doesn't fit.\n- **Exa Code Context** - Verify correct usage of libraries/APIs before flagging something as wrong.\n- **Web Search** - Research best practices if you're unsure about a pattern.\n\nIf you're uncertain about something and can't verify it with these tools, say \"I'm not sure about X\" rather than flagging it as a definite issue.\n\n---\n\n## Output\n\n1. If there is a bug, be direct and clear about why it is a bug.\n2. Clearly communicate severity of issues. Do not overstate severity.\n3. Critiques should clearly and explicitly communicate the scenarios, environments, or inputs that are necessary for the bug to arise. The comment should immediately indicate that the issue's severity depends on these factors.\n4. Your tone should be matter-of-fact and not accusatory or overly positive. It should read as a helpful AI assistant suggestion without sounding too much like a human reviewer.\n5. Write so the reader can quickly understand the issue without reading too closely.\n6. AVOID flattery, do not give any comments that are not helpful to the reader. Avoid phrasing like \"Great job ...\", \"Thanks for ...\".";

/**
 * Models the native path serves that OpenCode 1.18.33's bundled model catalog
 * does not list (models fetch is off, OPENCODE_DISABLE_MODELS_FETCH), declared
 * in the config on the `openai` provider itself. Its ChatGPT-login filter
 * (the codex plugin's `models()` hook) keeps any `gpt-N[.M]` with N > 5, so a
 * declared gpt-6.1-sol survives it; with `reasoning: true` OpenCode derives
 * the same `low|medium|high` variants (reasoningEffort + reasoningSummary
 * "auto" + reasoning.encrypted_content) it gives gpt-6-sol. The numbers are
 * pi 0.99.1's catalog (unchanged at 1.0.0) for openai-codex/gpt-6.1-sol (272k context, 128k out).
 * A model OpenCode already knows (gpt-6-sol) gets no entry — its config is
 * unchanged.
 */
export const NATIVE_MODEL_ENTRIES: Record<string, Record<string, unknown>> = {
  "gpt-6.1-sol": {
    name: "GPT-6.1 Sol",
    reasoning: true,
    tool_call: true,
    attachment: true,
    temperature: false,
    modalities: { input: ["text", "image"], output: ["text"] },
    limit: { context: 272_000, output: 128_000 },
  },
};

export function nativeModelEntry(model: string): Record<string, unknown> | null {
  return Object.hasOwn(NATIVE_MODEL_ENTRIES, model) ? NATIVE_MODEL_ENTRIES[model]! : null;
}

/** The provider id and model OpenCode is told to use: `bridge/<model>`. */
export const BRIDGE_PROVIDER = "bridge";
/** OpenCode's own OpenAI provider — with an OAuth credential, its ChatGPT login. */
export const NATIVE_PROVIDER = "openai";

/** `bridge`: the loopback Chat Completions bridge (the published arm);
 * `native`: OpenCode's own ChatGPT provider (see the header). */
export type OpencodeProvider = "bridge" | "native";

export interface OpencodeFlags {
  timeoutMin: number;
  /** `--variant` (reasoning effort); the bridge forces its own --effort
   * whatever arrives, and logs what was asked. Native, it IS the effort. */
  variant: string;
  /** Default `bridge` (the published arm). */
  provider?: OpencodeProvider;
}

export function providerId(provider: OpencodeProvider | undefined): string {
  return provider === "native" ? NATIVE_PROVIDER : BRIDGE_PROVIDER;
}

/** `opencode run`, non-interactive: JSON events on stdout, the built-in
 * review command, external plugins off, permissions auto-approved. */
export function opencodeRunArgv(o: {
  dir: string;
  model: string;
  variant: string;
  title: string;
  arguments: string;
  provider?: OpencodeProvider;
}): string[] {
  return [
    "run",
    "--pure",
    "--auto",
    "--format",
    "json",
    "--dir",
    o.dir,
    "--model",
    `${providerId(o.provider)}/${o.model}`,
    "--variant",
    o.variant,
    "--title",
    o.title,
    "--command",
    "review",
    o.arguments,
  ];
}

/**
 * OpenCode's whole configuration for one case (written to a per-case file and
 * named by OPENCODE_CONFIG; project config is disabled, so the reviewed repo
 * cannot add providers, plugins, MCP servers or permissions).
 *   - one provider, the loopback bridge, through the AI SDK's
 *     openai-compatible provider (bundled in the binary — nothing is
 *     installed at run time); a dummy API key; header/chunk timeouts long
 *     enough for one aggregated high-reasoning call (the bridge answers only
 *     after the backend finished);
 *   - the harness's codex findings MCP server, bound to this instance;
 *   - no auto-update, no sharing, no snapshots (OpenCode's undo tracking —
 *     it hashes the whole tree every step and changes nothing the model sees).
 */
export function opencodeConfig(o: {
  bridgeUrl: string;
  model: string;
  mcpPython: string;
  mcpScript: string;
  resultsDir: string;
  instanceId: string;
  provider?: OpencodeProvider;
}): Record<string, unknown> {
  const findingsMcp = {
    [FINDINGS_SERVER]: {
      type: "local",
      command: [o.mcpPython, o.mcpScript],
      environment: { REVIEW_RESULTS_DIR: o.resultsDir, REVIEW_INSTANCE_ID: o.instanceId },
      enabled: true,
      timeout: 30_000,
    },
  };
  const permission = { webfetch: "deny", websearch: "deny", external_directory: "deny" };
  if (o.provider === "native") {
    // OpenCode's own ChatGPT provider and its built-in `review` command as
    // shipped (subtask: true) — no provider block, no command override. The
    // small model is pinned to the same model: the ChatGPT login serves only
    // an allow-set of models, and a title/summary call must not pick another.
    const model = `${NATIVE_PROVIDER}/${o.model}`;
    const entry = nativeModelEntry(o.model);
    return {
      autoupdate: false,
      share: "disabled",
      snapshot: false,
      model,
      small_model: model,
      enabled_providers: [NATIVE_PROVIDER],
      // A model newer than OpenCode's bundled catalog is DECLARED on the same
      // built-in provider (config `provider.<id>.models`, OpenCode's documented
      // custom-model route) — still the native ChatGPT login and transport.
      ...(entry ? { provider: { [NATIVE_PROVIDER]: { models: { [o.model]: entry } } } } : {}),
      permission,
      mcp: findingsMcp,
    };
  }
  const model = `${BRIDGE_PROVIDER}/${o.model}`;
  return {
    autoupdate: false,
    share: "disabled",
    snapshot: false,
    model,
    small_model: model,
    enabled_providers: [BRIDGE_PROVIDER],
    provider: {
      [BRIDGE_PROVIDER]: {
        npm: "@ai-sdk/openai-compatible",
        name: "ChatGPT Codex backend via the loopback bridge",
        options: {
          baseURL: `${o.bridgeUrl.replace(/\/+$/, "")}/v1`,
          apiKey: "loopback-bridge",
          headerTimeout: 900_000,
          chunkTimeout: 900_000,
        },
        models: {
          [o.model]: {
            name: o.model,
            tool_call: true,
            reasoning: true,
            limit: { context: 272_000, output: 128_000 },
          },
        },
      },
    },
    permission,
    command: {
      review: {
        template: REVIEW_COMMAND_TEMPLATE,
        description: "review changes [commit|branch|pr], defaults to uncommitted",
        subtask: false,
      },
    },
    mcp: findingsMcp,
  };
}

/**
 * OpenCode's `auth.json` (its data dir, keyed by provider id) from the
 * sandbox's refresh-disabled pi copy: the ChatGPT access token, its expiry and
 * account id, and the disabled sentinel as the refresh token. Refuses any
 * source whose refresh token is not the sentinel — only the sandbox copy may
 * feed OpenCode, never the companion's real login.
 */
export function opencodeAuthFrom(benchAuthRaw: string): string {
  const parsed = JSON.parse(benchAuthRaw) as Record<string, unknown>;
  const cred = parsed["openai-codex"] as Record<string, unknown> | undefined;
  if (!cred || cred["type"] !== "oauth" || typeof cred["access"] !== "string" || !cred["access"])
    throw new Error("no openai-codex OAuth login in the sandbox's token copy");
  if (cred["refresh"] !== DISABLED_REFRESH)
    throw new Error(
      "refusing a pi login whose refresh token is not the disabled sentinel — only the sandbox's refresh-disabled copy (src/bench/auth.ts) may feed OpenCode",
    );
  if (typeof cred["expires"] !== "number")
    throw new Error("the pi login carries no expiry — OpenCode would refresh it at once");
  const access = cred["access"];
  const account =
    (typeof cred["accountId"] === "string" && cred["accountId"]) || jwtAccount(access);
  if (!account) throw new Error("the pi login carries no ChatGPT account id");
  return (
    JSON.stringify(
      {
        [NATIVE_PROVIDER]: {
          type: "oauth",
          refresh: DISABLED_REFRESH,
          access,
          expires: cred["expires"],
          accountId: account,
        },
      },
      null,
      2,
    ) + "\n"
  );
}

/** The SQL `opencodeUsage` reads: every model step of every session in the
 * case's own (fresh) OpenCode database — the subtask's included. */
export const USAGE_SQL =
  "SELECT json_extract(data,'$.tokens.input') AS input, json_extract(data,'$.tokens.output') AS output, " +
  "json_extract(data,'$.tokens.reasoning') AS reasoning, json_extract(data,'$.tokens.cache.read') AS cache_read, " +
  "json_extract(data,'$.tokens.cache.write') AS cache_write FROM part WHERE json_extract(data,'$.type')='step-finish'";

/** Every assistant message's provider and model (OpenCode records the pair
 * on the message; a later layout nests it under `model`). */
export const MODELS_SQL =
  "SELECT coalesce(json_extract(data,'$.providerID'), json_extract(data,'$.model.providerID')) AS provider, " +
  "coalesce(json_extract(data,'$.modelID'), json_extract(data,'$.model.modelID')) AS model, count(*) AS n " +
  "FROM message WHERE json_extract(data,'$.role')='assistant' GROUP BY 1, 2";

/** MODELS_SQL's rows → `{ "provider/model": count }`; null for anything but
 * a JSON array. */
export function opencodeModels(rowsJson: string): Record<string, number> | null {
  let rows: unknown;
  try {
    rows = JSON.parse(rowsJson);
  } catch {
    return null;
  }
  if (!Array.isArray(rows)) return null;
  const out: Record<string, number> = {};
  for (const r of rows as Array<Record<string, unknown>>) {
    const key = `${String(r?.["provider"] ?? "?")}/${String(r?.["model"] ?? "?")}`;
    out[key] = (out[key] ?? 0) + num(r?.["n"]);
  }
  return out;
}

/**
 * OpenCode's own per-step tokens, summed into the bridge's shape (what
 * compare.py and the defect judge's cost line price). OpenCode's `input`
 * excludes the cached part and its `output` excludes reasoning (checked
 * against the bridge's own counts on the published run), so the OpenAI-style
 * totals add them back. Null for anything but a JSON array of rows.
 */
export function opencodeUsage(rowsJson: string): BridgeUsage | null {
  let rows: unknown;
  try {
    rows = JSON.parse(rowsJson);
  } catch {
    return null;
  }
  if (!Array.isArray(rows)) return null;
  const out: BridgeUsage = {
    requests: 0,
    ok: 0,
    errors: 0,
    upstream_refusals: 0,
    input_tokens: 0,
    cached_tokens: 0,
    output_tokens: 0,
    reasoning_tokens: 0,
    by_status: {},
  };
  for (const r of rows as Array<Record<string, unknown>>) {
    const input = num(r?.["input"]);
    const cacheRead = num(r?.["cache_read"]);
    const cacheWrite = num(r?.["cache_write"]);
    const reasoning = num(r?.["reasoning"]);
    out.requests++;
    out.ok++;
    out.input_tokens += input + cacheRead + cacheWrite;
    out.cached_tokens += cacheRead;
    out.output_tokens += num(r?.["output"]) + reasoning;
    out.reasoning_tokens += reasoning;
  }
  return out;
}

/** The environment OpenCode runs with: a fresh HOME and XDG tree per case (its
 * auth.json, sessions DB and caches live there and die with the case), the
 * per-case config, every phone-home off, git without any system/global
 * config. No pi agent dir, no token — the credential stays in the bridge. */
export function opencodeEnv(o: {
  path: string;
  home: string;
  tmpDir: string;
  configPath: string;
  provider?: OpencodeProvider;
}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: o.path,
    HOME: o.home,
    TMPDIR: o.tmpDir,
    LANG: "C.UTF-8",
    XDG_CONFIG_HOME: join(o.home, ".config"),
    XDG_DATA_HOME: join(o.home, ".local", "share"),
    XDG_CACHE_HOME: join(o.home, ".cache"),
    XDG_STATE_HOME: join(o.home, ".local", "state"),
    OPENCODE_CONFIG: o.configPath,
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    OPENCODE_DISABLE_SHARE: "1",
    OPENCODE_DISABLE_MODELS_FETCH: "1",
    OPENCODE_DISABLE_LSP_DOWNLOAD: "1",
    OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
    OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER: "1",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
  };
  // The ChatGPT login is an internal DEFAULT plugin: the native path needs it.
  if (o.provider === "native") delete env["OPENCODE_DISABLE_DEFAULT_PLUGINS"];
  return env;
}

// ---- reading what OpenCode did -----------------------------------------------------

export interface OpencodeEvents {
  /** The session's last text — or, if the review ran as a subtask (the
   * built-in command's default), the `task` tool's result — what codex.py reads as the `agent_message`. */
  resultText: string;
  /** Tokens OpenCode itself reported per step (the parent session only — a
   * subtask's steps are not in the stream; the bridge counts everything). */
  tokens: { input: number; output: number; reasoning: number; cacheRead: number };
  steps: number;
  /** Tool calls seen in the stream, by tool name. */
  tools: Record<string, number>;
  errors: string[];
  sessionId: string | null;
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

const TASK_RESULT_RE = /<task_result>\s*([\s\S]*?)\s*<\/task_result>/;

export function parseOpencodeEvents(stdout: string): OpencodeEvents {
  const out: OpencodeEvents = {
    resultText: "",
    tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0 },
    steps: 0,
    tools: {},
    errors: [],
    sessionId: null,
  };
  let lastText = "";
  let taskResult = "";
  for (const line of stdout.split("\n")) {
    if (!line.startsWith("{")) continue;
    let e: Record<string, unknown>;
    try {
      e = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (out.sessionId === null && typeof e["sessionID"] === "string")
      out.sessionId = e["sessionID"];
    const part = (e["part"] ?? {}) as Record<string, unknown>;
    switch (e["type"]) {
      case "text":
        if (typeof part["text"] === "string" && part["text"].trim()) lastText = part["text"];
        break;
      case "tool_use": {
        const tool = typeof part["tool"] === "string" ? part["tool"] : "?";
        out.tools[tool] = (out.tools[tool] ?? 0) + 1;
        const state = (part["state"] ?? {}) as Record<string, unknown>;
        if (tool === "task" && typeof state["output"] === "string") {
          const m = TASK_RESULT_RE.exec(state["output"]);
          taskResult = (m ? m[1]! : state["output"]).trim();
        }
        break;
      }
      case "step_finish": {
        out.steps++;
        const t = (part["tokens"] ?? {}) as Record<string, unknown>;
        const cache = (t["cache"] ?? {}) as Record<string, unknown>;
        out.tokens.input += num(t["input"]);
        out.tokens.output += num(t["output"]);
        out.tokens.reasoning += num(t["reasoning"]);
        out.tokens.cacheRead += num(cache["read"]);
        break;
      }
      case "error": {
        const err = (e["error"] ?? {}) as Record<string, unknown>;
        const data = (err["data"] ?? {}) as Record<string, unknown>;
        out.errors.push(
          String(data["message"] ?? err["message"] ?? err["name"] ?? JSON.stringify(err)).slice(
            0,
            600,
          ),
        );
        break;
      }
    }
  }
  out.resultText = taskResult || lastText;
  return out;
}

/** reviewers/codex.py `_EMPTY_REVIEW_PATTERNS` / `looks_like_empty_review`. */
const EMPTY_REVIEW_PATTERNS = [
  /\bno\s+findings?\b/m,
  /\bno\s+issues?\s+found\b/m,
  /\bnothing\s+to\s+report\b/m,
  /\bno\s+comments?\b/m,
  /^\s*\(?\s*none\s*\)?\s*$/m,
];

export function looksLikeEmptyReview(text: string): boolean {
  if (!text.trim()) return true;
  const lowered = text.toLowerCase();
  return EMPTY_REVIEW_PATTERNS.some((p) => p.test(lowered));
}

/** reviewers/codex.py `extract_findings_from_result`: a fenced or bare JSON
 * value → that value; an explicit "no findings" → []; else the raw text. */
export function extractFindingsFromText(text: string): unknown {
  const fence = /```(?:json)?\s*([\s\S]*?)\s*```/.exec(text);
  const jsonText = fence ? fence[1]! : text;
  try {
    return JSON.parse(jsonText);
  } catch {
    return looksLikeEmptyReview(text) ? [] : text;
  }
}

export interface ChosenFindings {
  review_output: unknown;
  source: "mcp_stream" | "jsonl_fallback";
  mcp: number;
  text: number | null;
}

/** reviewers/codex.py `save_result`'s dual channel: the MCP partial file vs
 * the findings parsed from the final text; the larger wins, a tie goes to
 * MCP, and with neither structured the raw text is stored (scored as zero
 * comments). */
export function chooseFindings(mcp: unknown[] | null, text: string): ChosenFindings {
  const mcpCount = mcp?.length ?? 0;
  const parsed = extractFindingsFromText(text);
  const structured = Array.isArray(parsed);
  const textCount = structured ? parsed.length : 0;
  if (mcpCount === 0 && !structured)
    return { review_output: parsed, source: "jsonl_fallback", mcp: 0, text: null };
  if (mcpCount >= textCount)
    return { review_output: mcp ?? [], source: "mcp_stream", mcp: mcpCount, text: textCount };
  return { review_output: parsed, source: "jsonl_fallback", mcp: mcpCount, text: textCount };
}

/** reviewers/codex.py `load_streamed_findings`: the partial file, or null
 * when absent, unreadable or empty. */
export function loadPartialFindings(path: string): unknown[] | null {
  if (!existsSync(path)) return null;
  try {
    const v = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return Array.isArray(v) && v.length ? v : null;
  } catch {
    return null;
  }
}

export interface OcrShapedComment {
  path: string;
  start_line: number | null;
  end_line: number | null;
  content: string;
  severity?: string;
}

function intOrNull(v: unknown): number | null {
  if (typeof v === "number" && Number.isInteger(v)) return v;
  if (typeof v === "string" && /^\d+$/.test(v.trim())) return Number(v.trim());
  return null;
}

/** evaluate.py `build_target_comments_from_codex`, emitted in the shape its
 * `build_target_comments_from_ocr` reads: note = summary + "\n" + description
 * (a finding with neither is skipped), path = file, the line range as given.
 * Scoring this with the OCR reader is scoring review_output with the codex
 * reader — the same notes, paths and lines. */
export function toOcrShapedComments(reviewOutput: unknown): OcrShapedComment[] {
  if (!Array.isArray(reviewOutput)) return [];
  const out: OcrShapedComment[] = [];
  for (const f of reviewOutput) {
    if (typeof f !== "object" || f === null) continue;
    const r = f as Record<string, unknown>;
    const summary = typeof r["summary"] === "string" ? r["summary"].trim() : "";
    const description = typeof r["description"] === "string" ? r["description"].trim() : "";
    const note = [summary, description].filter(Boolean).join("\n").trim();
    if (!note) continue;
    out.push({
      path: typeof r["file"] === "string" ? r["file"] : "",
      start_line: intOrNull(r["start_line"]),
      end_line: intOrNull(r["end_line"]),
      content: note,
      ...(typeof r["severity"] === "string" ? { severity: r["severity"] } : {}),
    });
  }
  return out;
}

/** reviewers/codex.py `save_result`'s payload, reviewer "opencode", plus the
 * OCR-reader copy of the comments under `review` and our `bench` block (the
 * scorer ignores both extras' other keys). The full event stream stays in the
 * case dir instead of the result file. */
export function opencodeResultPayload(a: {
  c: BenchCase;
  model: string;
  startedAt: string;
  durationSeconds: number;
  exitCode: number;
  chosen: ChosenFindings;
  tokenUsage: Record<string, number>;
  stderr: string;
  bench: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    instance_id: a.c.instance_id,
    repo: a.c.repo,
    base_commit: a.c.base_commit,
    head_commit: a.c.head_commit,
    reviewer: "opencode",
    model: a.model,
    started_at: a.startedAt,
    duration_seconds: Math.round(a.durationSeconds * 100) / 100,
    opencode_exit_code: a.exitCode,
    review_output_source: a.chosen.source,
    review_output: a.chosen.review_output,
    token_usage: a.tokenUsage,
    review: { comments: toOcrShapedComments(a.chosen.review_output) },
    stderr: a.stderr,
    bench: a.bench,
  };
}

// ---- one case ----------------------------------------------------------------------

export type OpencodeStatus = "ok" | "failed" | "timeout" | "no-output";

export interface OpencodeFingerprint {
  qcr_commit: string;
  opencode_version: string;
  model: string;
  effort: string;
  variant: string;
  timeout_min: number;
  /** Present only on the native provider (the published arm is the bridge). */
  provider?: "native";
  /** Present only when the PR text was handed over (QCR_BENCH_PR_TEXT=1). */
  pr_text?: true;
  /** Present only on the API-key route (src/bench/auth.ts authFingerprint). */
  auth?: "api-key";
}

export interface OpencodeCaseSummary {
  instance_id: string;
  arm: "opencode";
  status: OpencodeStatus;
  error?: string;
  fingerprint: OpencodeFingerprint;
  exit_code: number | null;
  duration_seconds: number;
  /** Comments the scorer reads from the result file. */
  comments: number;
  review_output_source: ChosenFindings["source"] | null;
  mcp_findings: number;
  text_findings: number | null;
  /** OpenCode's own per-step tokens (parent session only). */
  opencode_tokens: OpencodeEvents["tokens"] | null;
  /** The bridge's count of every call the case made (subtask included) — on
   * the native provider, OpenCode's own session store summed into the same
   * shape (`usage_source`). */
  bridge: BridgeUsage | null;
  usage_source?: "bridge" | "opencode-db";
  /** Native only: every assistant message in OpenCode's own store (the
   * subtask's included), counted by the `provider/model` it was sent to —
   * the evidence that each call went to the configured model. */
  models?: Record<string, number>;
  /** With the PR-text switch on: whether this case's title/body reached OpenCode. */
  pr_text?: boolean;
  /** Bridge tokens in the shape the defect judge's cost line reads:
   * input without the cached part, the cached part, output. */
  usage: { input: number; output: number; cacheRead: number } | null;
  tools: Record<string, number>;
  merge_base_ok: boolean;
  warnings: string[];
}

export function writeOpencodeResult(
  outDir: string,
  c: BenchCase,
  payload: Record<string, unknown>,
): void {
  const dir = join(outDir, "results", "all");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${safeId(c.instance_id)}.json`),
    JSON.stringify(payload, null, 2) + "\n",
  );
}

export function readOpencodeSummary(outDir: string, c: BenchCase): OpencodeCaseSummary | null {
  const p = join(outDir, "cases", safeId(c.instance_id), "case-summary.json");
  if (!existsSync(p)) return null;
  const s = JSON.parse(readFileSync(p, "utf8")) as Partial<OpencodeCaseSummary>;
  return s.arm === "opencode" ? (s as OpencodeCaseSummary) : null;
}

/** Status from one finished process: a timeout or a non-zero exit as named;
 * an `error` event, or a run that reached the model not once, is a failure
 * even when OpenCode exits 0. */
export function opencodeStatus(a: {
  exitCode: number;
  timedOut: boolean;
  events: OpencodeEvents;
  bridgeOk: number | null;
}): OpencodeStatus {
  if (a.timedOut) return "timeout";
  if (a.exitCode !== 0 || a.events.errors.length) return "failed";
  if (a.events.steps === 0 && !a.bridgeOk) return "no-output";
  return "ok";
}

export interface OpencodeRunnerOptions {
  root: string;
  store: string;
  outDir: string;
  opencodeBin: string;
  bridgeUrl: string;
  model: string;
  mcpPython: string;
  mcpScript: string;
  flags: OpencodeFlags;
  fingerprint: OpencodeFingerprint;
  keepTree?: boolean;
  log?: (line: string) => void;
  fetchImpl?: typeof fetch;
  /** Injected in tests; defaults to the real subprocess runner. */
  runImpl?: typeof run;
  /** Native provider only: the sandbox's refresh-disabled pi copy. */
  benchAuthFile?: string;
  /** Hand OpenCode the PR title/body in the review arguments (src/bench/prtext.ts). */
  prText?: boolean;
}

async function bridgeCall(
  o: Pick<OpencodeRunnerOptions, "bridgeUrl" | "fetchImpl">,
  path: string,
  body?: unknown,
): Promise<Record<string, unknown> | null> {
  try {
    const res = await (o.fetchImpl ?? fetch)(`${o.bridgeUrl.replace(/\/+$/, "")}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(10_000),
    });
    return res.ok ? ((await res.json()) as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function emptySummary(c: BenchCase, fingerprint: OpencodeFingerprint): OpencodeCaseSummary {
  return {
    instance_id: c.instance_id,
    arm: "opencode",
    status: "failed",
    fingerprint,
    exit_code: null,
    duration_seconds: 0,
    comments: 0,
    review_output_source: null,
    mcp_findings: 0,
    text_findings: null,
    opencode_tokens: null,
    bridge: null,
    usage: null,
    tools: {},
    merge_base_ok: false,
    warnings: [],
  };
}

/** Review one case with OpenCode and write its result file. Never throws for
 * a case that fails — a failure is a recorded outcome with an empty result. */
export async function reviewCaseOpencode(
  c: BenchCase,
  meta: PrefetchMeta,
  o: OpencodeRunnerOptions,
): Promise<OpencodeCaseSummary> {
  const log = o.log ?? (() => {});
  const exec = o.runImpl ?? run;
  const safe = safeId(c.instance_id);
  const caseDir = join(o.outDir, "cases", safe);
  const tree = join(o.root, "wt", safe);
  const scratch = join(o.root, "wt", `${safe}.opencode`);
  const home = join(scratch, "home");
  const tmpDir = join(scratch, "tmp");
  const partialDir = join(scratch, "findings");
  const native = o.flags.provider === "native";
  mkdirSync(caseDir, { recursive: true });
  const startedAt = new Date().toISOString();
  const started = Date.now();
  const summary = emptySummary(c, o.fingerprint);
  let stdout = "";
  let stderr = "";
  let exitCode = -1;
  let chosen: ChosenFindings = { review_output: [], source: "mcp_stream", mcp: 0, text: 0 };
  try {
    await prepareTree(join(o.store, safe), tree, meta);
    rmSync(scratch, { recursive: true, force: true });
    for (const d of [home, tmpDir, partialDir]) mkdirSync(d, { recursive: true });
    const configPath = join(scratch, "opencode.json");
    const config = opencodeConfig({
      bridgeUrl: o.bridgeUrl,
      model: o.model,
      mcpPython: o.mcpPython,
      mcpScript: o.mcpScript,
      resultsDir: partialDir,
      instanceId: c.instance_id,
      provider: o.flags.provider ?? "bridge",
    });
    writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
    if (native) {
      // OpenCode's own login store, in the per-case data dir (removed below).
      if (!o.benchAuthFile) throw new Error("the native provider needs the sandbox's token copy");
      const dataDir = join(home, ".local", "share", "opencode");
      mkdirSync(dataDir, { recursive: true, mode: 0o700 });
      writeFileSync(
        join(dataDir, "auth.json"),
        opencodeAuthFrom(readFileSync(o.benchAuthFile, "utf8")),
        {
          mode: 0o600,
        },
      );
    }
    writeFileSync(join(caseDir, "opencode-config.json"), JSON.stringify(config, null, 2) + "\n");
    const env = opencodeEnv({
      path: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
      home,
      tmpDir,
      configPath,
      provider: o.flags.provider ?? "bridge",
    });
    const mb = await exec("git", ["-C", tree, "merge-base", c.base_commit, c.head_commit], { env });
    summary.merge_base_ok = mb.code === 0 && mb.stdout.trim() === meta.merge_base;
    if (!summary.merge_base_ok)
      summary.warnings.push(
        `merge-base(${c.base_commit.slice(0, 7)}, head) = ${mb.stdout.trim() || mb.stderr.trim().slice(0, 200)}, prefetched ${meta.merge_base.slice(0, 7)}`,
      );
    const prText = prTextFor(meta, o.prText === true);
    if (o.prText) summary.pr_text = prText !== null;
    const argv = opencodeRunArgv({
      dir: tree,
      model: o.model,
      variant: o.flags.variant,
      title: c.instance_id,
      arguments: opencodeReviewArguments(c.base_commit, c.head_commit, prText),
      provider: o.flags.provider ?? "bridge",
    });
    writeFileSync(
      join(caseDir, "opencode-argv.json"),
      JSON.stringify([o.opencodeBin, ...argv], null, 2) + "\n",
    );
    if (!native) await bridgeCall(o, "/label", { label: c.instance_id });
    const before = native ? null : ((await bridgeCall(o, "/stats")) as BridgeStats | null);
    log(
      `opencode: ${c.instance_id} — ${meta.diff.files} files, /review ${c.base_commit.slice(0, 7)}...${c.head_commit.slice(0, 7)}`,
    );
    const r = await exec(o.opencodeBin, argv, {
      cwd: tree,
      env,
      timeoutMs: opencodeProcessTimeoutMs(o.flags.timeoutMin),
    });
    stdout = r.stdout;
    stderr = r.stderr;
    exitCode = r.code;
    summary.exit_code = r.code;
    if (native) {
      // Every step of every session (the subtask's too) from OpenCode's own store.
      const db = await exec(o.opencodeBin, ["db", USAGE_SQL, "--format", "json"], {
        cwd: tree,
        env,
      });
      summary.bridge = db.code === 0 ? opencodeUsage(db.stdout) : null;
      summary.usage_source = "opencode-db";
      if (!summary.bridge)
        summary.warnings.push(`opencode db: no token totals (${db.stderr.trim().slice(0, 200)})`);
      const models = await exec(o.opencodeBin, ["db", MODELS_SQL, "--format", "json"], {
        cwd: tree,
        env,
      });
      const m = models.code === 0 ? opencodeModels(models.stdout) : null;
      if (m) summary.models = m;
      else
        summary.warnings.push(
          `opencode db: no model counts (${models.stderr.trim().slice(0, 200)})`,
        );
    } else {
      const after = (await bridgeCall(o, "/stats")) as BridgeStats | null;
      await bridgeCall(o, "/label", { label: "" });
      summary.bridge = bridgeDelta(before, after);
      summary.usage_source = "bridge";
    }
    const events = parseOpencodeEvents(stdout);
    summary.opencode_tokens = events.tokens;
    summary.tools = events.tools;
    chosen = chooseFindings(
      loadPartialFindings(join(partialDir, `${safe}.partial.json`)),
      events.resultText,
    );
    summary.review_output_source = chosen.source;
    summary.mcp_findings = chosen.mcp;
    summary.text_findings = chosen.text;
    summary.status = opencodeStatus({
      exitCode: r.code,
      timedOut: r.timedOut,
      events,
      bridgeOk: summary.bridge?.ok ?? null,
    });
    summary.warnings.push(...events.errors.map((e) => `opencode error: ${e}`));
    if (summary.status !== "ok")
      summary.error = (events.errors.join(" | ") || stderr.trim() || stdout.trim()).slice(-1500);
    writeFileSync(join(caseDir, "opencode-result.txt"), events.resultText);
    // OpenCode's own log (it writes one per process under its data dir).
    const logDir = join(home, ".local", "share", "opencode", "log");
    if (existsSync(logDir))
      for (const f of readdirSync(logDir)
        .filter((n) => n.endsWith(".log"))
        .slice(-1))
        copyFileSync(join(logDir, f), join(caseDir, "opencode.log"));
  } catch (err) {
    summary.status = "failed";
    summary.error = String(err instanceof Error ? err.message : err).slice(0, 2000);
    log(`opencode: ${c.instance_id} FAILED — ${summary.error}`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
    if (!o.keepTree) rmSync(tree, { recursive: true, force: true });
  }
  summary.duration_seconds = Math.round((Date.now() - started) / 1000);
  const b = summary.bridge;
  summary.usage = b
    ? {
        input: b.input_tokens - Math.min(b.cached_tokens, b.input_tokens),
        cacheRead: Math.min(b.cached_tokens, b.input_tokens),
        output: b.output_tokens,
      }
    : null;
  writeFileSync(join(caseDir, "opencode-events.jsonl"), stdout);
  writeFileSync(join(caseDir, "opencode-stderr.log"), stderr);
  const payload = opencodeResultPayload({
    c,
    model: o.model,
    startedAt,
    durationSeconds: (Date.now() - started) / 1000,
    exitCode,
    chosen,
    // codex.py `_extract_codex_usage` field names, from the bridge (OpenAI
    // convention: input includes the cached part).
    tokenUsage: {
      input_tokens: b?.input_tokens ?? 0,
      cached_input_tokens: b?.cached_tokens ?? 0,
      output_tokens: b?.output_tokens ?? 0,
      reasoning_output_tokens: b?.reasoning_tokens ?? 0,
      cache_read_input_tokens: b?.cached_tokens ?? 0,
      cache_creation_input_tokens: 0,
      total_tokens: (b?.input_tokens ?? 0) + (b?.output_tokens ?? 0),
    },
    stderr,
    bench: { status: summary.status, bridge: b, fingerprint: o.fingerprint },
  });
  summary.comments = (payload["review"] as { comments: unknown[] }).comments.length;
  writeFileSync(join(caseDir, "case-summary.json"), JSON.stringify(summary, null, 2) + "\n");
  writeOpencodeResult(o.outDir, c, payload);
  log(
    `opencode: ${c.instance_id} ${summary.status} — ${summary.comments} comment(s) (${chosen.source}: mcp ${chosen.mcp}, text ${chosen.text ?? "raw"}), ${summary.duration_seconds}s` +
      (b
        ? `, ${b.requests} model call(s) (${b.errors} failed), ${b.input_tokens} in/${b.output_tokens} out`
        : ""),
  );
  return summary;
}

/** A case with no prefetched store: failed WITH an empty result file, so its
 * references count against recall instead of vanishing from both
 * denominators. */
export function unprefetchedOpencodeCase(
  outDir: string,
  c: BenchCase,
  fingerprint: OpencodeFingerprint,
  error: string,
): OpencodeCaseSummary {
  const summary = { ...emptySummary(c, fingerprint), error };
  const caseDir = join(outDir, "cases", safeId(c.instance_id));
  mkdirSync(caseDir, { recursive: true });
  writeFileSync(join(caseDir, "case-summary.json"), JSON.stringify(summary, null, 2) + "\n");
  writeOpencodeResult(
    outDir,
    c,
    opencodeResultPayload({
      c,
      model: fingerprint.model,
      startedAt: new Date().toISOString(),
      durationSeconds: 0,
      exitCode: -1,
      chosen: { review_output: [], source: "mcp_stream", mcp: 0, text: 0 },
      tokenUsage: {},
      stderr: error,
      bench: { status: "failed", bridge: null, fingerprint },
    }),
  );
  return summary;
}

// ---- the whole run (cli `opencode-review`) -------------------------------------------

export interface OpencodeReviewRun {
  set: CaseSet;
  cases: BenchCase[];
  outDir: string;
  root: string;
  store: string;
  authSrc: string;
  agentDir: string;
  opencodeBin: string;
  opencodeVersion: string;
  bridgeUrl: string;
  /** From the bridge's /health — what the model IS, never a flag. */
  model: string;
  effort: string;
  verbosity: string | null;
  mcpPython: string;
  mcpScript: string;
  flags: OpencodeFlags;
  qcrCommit: string;
  resume: boolean;
  keepTree: boolean;
  readMeta: (c: BenchCase) => PrefetchMeta;
  log: (line: string) => void;
  /** The equal-inputs switch (src/bench/prtext.ts). */
  prText?: boolean;
}

/** Every case, ONE AT A TIME (as the harness runs its CLI reviewers, and the
 * login is shared with the companion). Returns the process exit code. */
export async function runOpencodeReview(r: OpencodeReviewRun): Promise<number> {
  const fingerprint: OpencodeFingerprint = {
    qcr_commit: r.qcrCommit,
    opencode_version: r.opencodeVersion,
    model: r.model,
    effort: r.effort,
    variant: r.flags.variant,
    timeout_min: r.flags.timeoutMin,
    ...(r.flags.provider === "native" ? { provider: "native" as const } : {}),
    ...(r.prText ? { pr_text: true as const } : {}),
    ...authFingerprint(),
  };
  const native = r.flags.provider === "native";
  // OpenCode's own ChatGPT provider IS a login; the API-key route takes the bridge.
  if (native && benchAuthMode() === "api-key")
    throw new Error(
      "opencode-review: the native provider is OpenCode's ChatGPT login — on the API-key route use the bridge (unset QCR_BENCH_OPENCODE_PROVIDER)",
    );
  mkdirSync(r.outDir, { recursive: true });
  const runFile = join(r.outDir, "run.json");
  const previous = existsSync(runFile)
    ? (JSON.parse(readFileSync(runFile, "utf8")) as Record<string, unknown>)
    : null;
  // run.json is about to carry THIS configuration, so no case reviewed under
  // another may stay a result of the run: without --resume every case goes;
  // with it, every case whose fingerprint differs goes now, not when the loop
  // reaches it — a stop partway (AuthExpiring) must leave those cases
  // incomplete, never scored under the new model/flags label.
  for (const c of r.cases) {
    const prior = r.resume ? readOpencodeSummary(r.outDir, c) : null;
    if (r.resume && (!prior || JSON.stringify(prior.fingerprint) === JSON.stringify(fingerprint)))
      continue;
    if (prior)
      r.log(
        `opencode: ${c.instance_id} was reviewed by a different OpenCode/model/flags — its result is dropped`,
      );
    rmSync(join(r.outDir, "cases", safeId(c.instance_id), "case-summary.json"), { force: true });
    rmSync(join(r.outDir, "results", "all", `${safeId(c.instance_id)}.json`), { force: true });
  }
  const runRecord = {
    reviewer: "opencode",
    set: r.set.name,
    dataset: r.set.dataset,
    opencode_version: r.opencodeVersion,
    model: r.model,
    effort: r.effort,
    verbosity: r.verbosity,
    variant: r.flags.variant,
    endpoint: native
      ? "ChatGPT Codex backend through OpenCode's own ChatGPT login (provider openai, refresh-disabled token copy)"
      : benchAuthMode() === "api-key"
        ? "the public OpenAI API (API key) via the loopback bridge (bench/aacr/codex_bridge.py)"
        : "ChatGPT Codex backend via the loopback bridge (bench/aacr/codex_bridge.py)",
    provider: native ? "native" : "bridge",
    // Native only, and only for a model OpenCode's bundled catalog lacks: the
    // entry declared on its `openai` provider (NATIVE_MODEL_ENTRIES).
    ...(native && nativeModelEntry(r.model)
      ? { native_model_entry: nativeModelEntry(r.model) }
      : {}),
    // The built-in review command: re-declared with subtask:false on the
    // bridge (the published arm), as shipped (subtask:true) on the native path.
    subtask: native,
    command: `opencode run --pure --auto --format json --model ${providerId(r.flags.provider)}/<model> --variant <effort> --command review '<base>...<head> (<findings fragment>)${r.prText ? "\\n\\n<the PR title and description>" : ""}'`,
    // The equal-inputs switch (src/bench/prtext.ts).
    pr_text: r.prText === true,
    flags: { timeout_min: r.flags.timeoutMin },
    qcr_commit: r.qcrCommit,
    cases: r.cases.map((c) => c.instance_id),
    started_at:
      (r.resume && typeof previous?.["started_at"] === "string" && previous["started_at"]) ||
      new Date().toISOString(),
    resumes: [
      ...(r.resume && Array.isArray(previous?.["resumes"])
        ? (previous["resumes"] as unknown[])
        : []),
      ...(r.resume && previous ? [{ at: new Date().toISOString(), fingerprint }] : []),
    ],
    finished_at: null as string | null,
  };
  writeFileSync(runFile, JSON.stringify(runRecord, null, 2) + "\n");
  const summaries: OpencodeCaseSummary[] = [];
  let stopped: string | null = null;
  for (const c of r.cases) {
    const prior = readOpencodeSummary(r.outDir, c);
    // (a prior summary here carries this run's fingerprint — the others went above)
    if (r.resume && prior && prior.status === "ok") {
      r.log(`opencode: ${c.instance_id} already done — skipped (--resume)`);
      summaries.push(prior);
      continue;
    }
    try {
      // The bridge reads this refresh-disabled copy on every call.
      syncBenchAuth({
        srcDir: r.authSrc,
        dstDir: r.agentDir,
        root: r.root,
        needMs: opencodeProcessTimeoutMs(r.flags.timeoutMin) + 5 * 60_000,
      });
    } catch (err) {
      if (!(err instanceof AuthExpiring)) throw err;
      stopped = err.message;
      r.log(`opencode: STOPPED — ${err.message}`);
      break;
    }
    let meta: PrefetchMeta;
    try {
      meta = r.readMeta(c);
    } catch (err) {
      const error = String(err instanceof Error ? err.message : err);
      r.log(error);
      summaries.push(unprefetchedOpencodeCase(r.outDir, c, fingerprint, error));
      continue;
    }
    summaries.push(
      await reviewCaseOpencode(c, meta, {
        root: r.root,
        store: r.store,
        outDir: r.outDir,
        opencodeBin: r.opencodeBin,
        bridgeUrl: r.bridgeUrl,
        model: r.model,
        mcpPython: r.mcpPython,
        mcpScript: r.mcpScript,
        flags: r.flags,
        fingerprint,
        keepTree: r.keepTree,
        log: r.log,
        benchAuthFile: join(r.agentDir, "auth.json"),
        prText: r.prText === true,
      }),
    );
  }
  runRecord.finished_at = new Date().toISOString();
  writeFileSync(runFile, JSON.stringify(runRecord, null, 2) + "\n");
  const ok = summaries.filter((s) => s.status === "ok").length;
  r.log(
    `opencode: ${ok}/${r.cases.length} reviewed — results in ${join(r.outDir, "results", "all")}`,
  );
  if (stopped !== null) r.log(`opencode: run stopped early — ${stopped}`);
  return ok === r.cases.length ? 0 : 1;
}

// ---- the report ---------------------------------------------------------------------

function n(v: number | undefined): string {
  return v === undefined
    ? "?"
    : Number.isInteger(v)
      ? String(v)
      : String(Math.round(v * 100) / 100);
}

/** The OpenCode arm's report: the harness's numbers (average and every
 * round), then per case what OpenCode did and what it cost at the bridge. */
export function renderOpencodeReport(set: CaseSet, outDir: string, cases: BenchCase[]): string {
  const L: string[] = [];
  const runPath = join(outDir, "run.json");
  const run = (existsSync(runPath) ? JSON.parse(readFileSync(runPath, "utf8")) : {}) as Record<
    string,
    unknown
  >;
  const judgeFile = join(outDir, "judge.txt");
  const judge = existsSync(judgeFile)
    ? readFileSync(judgeFile, "utf8").trim().split("\n")
    : ["not run"];
  const k = (x: number): string => `${Math.round(x / 1000)}k`;
  L.push(`# AACR-Bench run — ${set.name} — OpenCode`);
  L.push("");
  L.push(
    `- Dataset: AACR-Bench v1.0 (\`${set.dataset.commit.slice(0, 7)}\`), ${cases.length} PRs, ${cases.reduce((a, c) => a + c.references, 0)} reference comments`,
  );
  L.push(
    `- Reviewer: OpenCode ${String(run["opencode_version"] ?? "?")}, run in the shape of the AACR harness's reviewers/codex.py: \`opencode run --command review "<base>...<head> (<findings fragment>)"\` (OpenCode's built-in /review), findings through the harness's codex MCP findings server, timeout ${String((run["flags"] as Record<string, unknown> | undefined)?.["timeout_min"] ?? "?")} min (+60 s); no PR title/description`,
  );
  L.push(
    `- Model: \`${String(run["model"] ?? "?")}\`, reasoning effort \`${String(run["effort"] ?? "?")}\` (asked: --variant \`${String(run["variant"] ?? "?")}\`) — the ChatGPT Codex backend through the loopback bridge (bench/aacr/codex_bridge.py, streaming Chat Completions)`,
  );
  L.push(`- Judge: ${judge[0] ?? ""}`);
  for (const w of judge.slice(1)) L.push(`  ${w}`);
  L.push("");
  L.push("## Scores (the AACR harness, OCR reader over the same comments)");
  L.push("");
  L.push("| Round | Evaluated | Generated | Matched | Precision | Recall | F1 | Line P | Line R |");
  L.push("|---|---|---|---|---|---|---|---|---|");
  const row = (label: string, s: Record<string, number>): string =>
    `| ${label} | ${n(s["evaluated_instances"])}/${cases.length} | ${n(s["generated_notes"])} | ${n(s["matched_semantic_notes"])}/${n(s["expected_notes"])} | ${s["semantic_match_rate"]} | ${s["semantic_recall_rate"]} | ${s["semantic_f1"]} | ${s["line_match_rate"]} | ${s["line_recall_rate"]} |`;
  const { rounds, average } = roundMetrics(join(outDir, "results", "all"));
  if (average) L.push(row("**average**", average));
  for (const r of rounds) L.push(row(String(r.round), r.summary));
  if (!average && rounds.length === 0) L.push("| — | — | — | — | — | — | — | — | — |");
  L.push("");
  L.push("## Per case");
  L.push("");
  L.push(
    "| Case | Lang | Refs | Status | Comments (source) | Minutes | Model calls (failed) | Backend tokens in (cached) / out (reasoning) | Tools |",
  );
  L.push("|---|---|---|---|---|---|---|---|---|");
  const warned: Array<{ c: BenchCase; s: OpencodeCaseSummary }> = [];
  for (const c of cases) {
    const s = readOpencodeSummary(outDir, c);
    if (!s) {
      L.push(`| ${c.instance_id} | ${c.language} | ${c.references} | not run | | | | | |`);
      continue;
    }
    if (s.warnings.length || s.error || !s.merge_base_ok) warned.push({ c, s });
    const b = s.bridge;
    const tools = Object.entries(s.tools)
      .sort((x, y) => y[1] - x[1])
      .map(([t, m]) => `${t} ${m}`)
      .join(", ");
    L.push(
      `| ${c.instance_id} | ${c.language} | ${c.references} | ${s.status} | ${s.comments} (${s.review_output_source ?? "?"}) | ${(s.duration_seconds / 60).toFixed(1)} | ${b ? `${b.requests} (${b.errors})` : "?"} | ${b ? `${k(b.input_tokens)} (${k(b.cached_tokens)}) / ${k(b.output_tokens)} (${k(b.reasoning_tokens)})` : "?"} | ${tools} |`,
    );
  }
  if (warned.length) {
    L.push("");
    L.push("## Warnings (case errors)");
    L.push("");
    for (const { c, s } of warned) {
      if (!s.merge_base_ok && s.status !== "failed")
        L.push(`- \`${c.instance_id}\`: merge-base check failed — see case-summary.json`);
      for (const w of [
        ...(s.error ? [s.error.replaceAll("\n", " ").slice(0, 400)] : []),
        ...s.warnings,
      ])
        L.push(`- \`${c.instance_id}\`: ${w}`);
    }
  }
  L.push("");
  L.push(
    "Reading the numbers: the findings carry the harness's codex severities (Critical…Info), not our blocker/nit tags, so only the `all` variant exists for this arm. The Tools column counts the session's tool calls (a `task` is a subagent OpenCode chose to spawn, whose own calls are not listed); the backend columns are the bridge's count of every call, subagents included.",
  );
  L.push("");
  return L.join("\n");
}
