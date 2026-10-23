// pi's built-in extensions that every surface we provision switches OFF.
//
// pi 0.99.0 started shipping four extensions INSIDE the package, loaded by
// default: `builtin:mcp`, `builtin:codemode`, `builtin:tool-search` and
// `builtin:llama.cpp` (dist/extensions/index.js `builtInExtensions`). The
// documented switch is a `-builtin:<name>` entry in the GLOBAL settings'
// `extensions` array (docs/settings.md "The built-in extensions are named …
// `-builtin:mcp` disables one"; dist/core/package-manager.js resolves each
// built-in through isEnabledByOverrides, where a `-` entry is an exact-match
// force-exclude on the literal path `builtin:<name>`). A `+`/`-`/`!` entry in a
// trusted PROJECT `.pi/settings.json` overrides the user setting — which is why
// `.pi/` is also on bash-guard's policy surface.
//
// Why each one is off (none is used by any reviewer, lens, judge or companion):
//  - mcp: launches stdio server PROCESSES and opens HTTP connections from an
//    `mcp.json` — global, or a trusted project's `.pi/mcp.json`, and every
//    project is trusted (`defaultProjectTrust = "always"`). A process launch
//    that never passes through a tool call, so bash-guard never sees it.
//  - codemode: a QuickJS tool that runs model-written scripts calling the
//    other tools. Registered inactive, but one `defaultTools: ["+codemode"]`
//    in a project settings file activates it — a changed tool set.
//  - tool-search: declares not-yet-declared tools mid-session (MCP's deferred
//    tools); a changed tool set, and useless without MCP.
//  - llama.cpp: registers a model provider that talks to a local llama.cpp
//    server (127.0.0.1:8080 by default). Starts nothing, but it is a model
//    route nobody configured; off so the provider set stays the one we pin.
//
// VERIFY-ON-PIN (0.99.1, re-read at 1.0.0, 1.3.0 and 1.4.0 — dist/extensions/index.js unchanged): the four names and
// the `-builtin:<name>` spelling. A later pi that adds a built-in is NOT
// covered by this list — re-read dist/extensions/index.js on every bump.
//
// The mirrors (plain JS, they run before any build): the release image's
// entrypoint (docker/entrypoint.sh, the VM's too), the companion's
// (docker/companion/entrypoint.sh)
// and the sandbox settings below (`benchSettings`, the bench's and
// `qcr review`'s). tests/pibuiltins.test.ts pins every mirror to this list.
export const PI_DISABLED_BUILTINS = [
  "-builtin:mcp",
  "-builtin:codemode",
  "-builtin:tool-search",
  "-builtin:llama.cpp",
] as const;

/**
 * pi 1.0.0 made the interactive TUI fullscreen by default (CHANGELOG 1.0.0,
 * "Changed the default TUI mode to fullscreen"). Every interactive pi we run
 * sits in tmux — the VM's PR sessions and overseer, the companion — and the
 * operator TUI mirrors those panes and scrolls them (PgUp), which needs the
 * terminal's normal scrollback: pi 0.99's default. The three entrypoint merges
 * set it; tests/pibuiltins.test.ts pins each one to this value.
 */
export const PI_TUI_MODE = "regular";

/** pi's agent-level retry for a benchmark sandbox — every session and every
 * lens child reads it (one agent dir). pi's own default (3 attempts, ≤ 60 s
 * apart) gives up inside two minutes, and a provider's overload window
 * (DigitalOcean "529 Platform overloaded", or a request timeout) is longer than
 * that: the lens is lost and the review posts without it. This backs off from
 * 5 s doubling to a 2-minute cap over 10 attempts — about 13 minutes of
 * patience per request — so a PR is processed fully and fails only when the
 * provider is really unavailable. Provider-level retries stay off (pi's advice:
 * they would hide quota and usage-limit errors from pi). */
export const BENCH_RETRY = {
  enabled: true,
  maxRetries: 10,
  baseDelayMs: 5_000,
  maxAgentDelayMs: 120_000,
} as const;

/** pi's global settings for the sandbox: pi's built-in extensions switched off
 * (packages/pi-plugin/src/pibuiltins.ts — the reviewed checkout is exactly the untrusted ground a
 * `.pi/mcp.json` would come from); every project trusted so no modal can stall
 * a run; /opt/quickreview pre-trusted; and the durable retry above. No global
 * bash-guard: every route that runs a model hands the guard to
 * its sessions itself, as an `--extension` or a factory. */
export function benchSettings(_root: string): { settings: string; trust: string } {
  return {
    settings:
      JSON.stringify(
        {
          extensions: [...PI_DISABLED_BUILTINS],
          defaultProjectTrust: "always",
          retry: BENCH_RETRY,
        },
        null,
        2,
      ) + "\n",
    trust: JSON.stringify({ "/opt/quickreview": true }, null, 2) + "\n",
  };
}
