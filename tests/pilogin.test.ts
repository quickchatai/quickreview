// pi's own /login, typed for the person (src/pilogin.ts `loginInPi`): the
// script runs under sh against a fake tmux on PATH that draws pi's screens as
// pi 1.4.0 does (an input box between two editor borders, and every selection
// menu drawn inside that box) and logs every key it is sent. No pi, no
// terminal, no network.
//
//   - the keys go in once, Enter until pi takes them, and no key at all once a
//     menu is up, whatever its title: an Enter on a provider's method menu
//     picks its default, a browser login, and a key loop opened one per poll;
//   - with no terminal to attach to, the tmux session is ended, not left
//     running pi where nobody can reach it.
import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { loginInPi } from "../src/pilogin.js";

const exec = promisify(execFile);

// The fake tmux. Screens, in pi's order: starting (no borders yet, two polls),
// the empty input box, the keys typed (the first Enter only accepts the
// autocomplete), the menu, and what a pick on the menu leads to. Enter on the
// menu logs "picked" — the browser tab of the bug.
const FAKE_TMUX = `#!/bin/sh
D="$(dirname "$0")"
log() { echo "$*" >> "$D/log"; }
border() { echo "────────────────────────────────────────"; }
cmd="$1"; shift
case "$cmd" in
  new-session) echo start > "$D/state"; echo 0 > "$D/polls";;
  capture-pane)
    st=$(cat "$D/state")
    echo " pi v1.4.0"
    case "$st" in
      start) n=$(($(cat "$D/polls") + 1)); echo $n > "$D/polls"; [ $n -ge 2 ] && echo empty > "$D/state";;
      empty) border; echo; border;;
      typed|accepted) border; cat "$D/keys"; border; echo " → openai-codex  OpenAI Codex";;
      menu) border; echo; echo " $MENU"; echo; echo " → Browser login (default)"; echo; border;;
      picked) border; echo " Opening your browser…"; border;;
    esac;;
  send-keys)
    [ "$1" = -t ] && shift 2
    st=$(cat "$D/state")
    if [ "$1" = -l ]; then
      log "type $2"; [ "$st" = empty ] && { printf '%s\\n' "$2" > "$D/keys"; echo typed > "$D/state"; }
    else
      log "enter"
      case "$st" in
        typed) echo accepted > "$D/state";;
        accepted) echo menu > "$D/state";;
        menu) log picked; echo picked > "$D/state";;
      esac
    fi;;
  attach) log attach; exit "\${ATTACH_RC:-0}";;
  kill-session) log kill;;
esac
`;

async function runLogin(
  provider: string | undefined,
  menu: string,
  attachRc = 0,
): Promise<{ log: string[]; code: number }> {
  // Each run removes its own scratch dir: the cases run concurrently, so an
  // afterEach sweep would pull a sibling's fake tmux from under it.
  const dir = mkdtempSync(join(tmpdir(), "qcr-pilogin-"));
  try {
    writeFileSync(join(dir, "tmux"), FAKE_TMUX);
    chmodSync(join(dir, "tmux"), 0o755);
    writeFileSync(join(dir, "log"), "");
    const [sh, c, script] = loginInPi(provider, "/opt/qcr/node_modules/.bin/pi");
    let code = 0;
    try {
      await exec(sh!, [c!, script!], {
        env: {
          PATH: `${dir}:${process.env["PATH"] ?? ""}`,
          MENU: menu,
          ATTACH_RC: String(attachRc),
        },
      });
    } catch (err) {
      code = (err as { code?: number }).code ?? -1;
    }
    return { log: readFileSync(join(dir, "log"), "utf8").split("\n").filter(Boolean), code };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("loginInPi: keys go in until pi takes them, never on a menu", () => {
  // MUTATION: restore the title match in src/pilogin.ts
  // (`case "$p" in *"Select authentication"*|*"Select provider"*) break;; esac`,
  // keys retyped whenever the box does not hold them) — the provider-method
  // titles and the unknown title fail with "picked" in the log.
  it.concurrent.each([
    ["openai-codex", "Select OpenAI Codex login method:"],
    ["anthropic", "Select Anthropic login method:"],
    ["example", "How do you want to sign in to Example?"],
    [undefined, "Select authentication method:"],
    [undefined, "Select provider to configure:"],
  ])("/login %s stops at %j", async (provider, menu) => {
    const keys = provider ? `/login ${provider}` : "/login";
    const r = await runLogin(provider, menu);
    expect(r.log).toEqual([`type ${keys}`, "enter", "enter", "attach"]);
    expect(r.code).toBe(0);
  });

  // MUTATION: put `exec tmux attach -t "$s"` back — the log has no "kill".
  it.concurrent("with no terminal to attach to, the session is ended", async () => {
    const r = await runLogin("openai-codex", "Select OpenAI Codex login method:", 1);
    expect(r.log.slice(-2)).toEqual(["attach", "kill"]);
    expect(r.log).not.toContain("picked");
    expect(r.code).toBe(1);
  });
});
