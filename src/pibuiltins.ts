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
// VERIFY-ON-PIN (0.99.1, re-read at 1.0.0 and 1.3.0 — dist/extensions/index.js unchanged): the four names and
// the `-builtin:<name>` spelling. A later pi that adds a built-in is NOT
// covered by this list — re-read dist/extensions/index.js on every bump.
//
// The mirrors (plain JS, they run before any build): the VM entrypoints
// (deploy/ansible/templates/entrypoint.sh.j2, docker/daemon/entrypoint.sh),
// the companion's (docker/companion/entrypoint.sh) and the bench sandbox's
// settings (src/bench/auth.ts benchSettings). tests/pibuiltins.test.ts pins
// every mirror to this list.
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
