// pi's own /login, typed for the person (src/pilogin.ts `loginInPi`): the
// script runs under sh against a fake tmux on PATH that draws pi's screens as
// pi 1.4.0 does (an input box between two editor borders, and every selection
// menu drawn inside that box) and logs every key it is sent. No pi, no
// terminal, no network.
//
//   - the keys go in once, Enter until pi takes them, and no key at all once a
//     menu is up, whatever its title: an Enter on a provider's method menu
//     picks its default, a browser login, and a key loop opened one per poll;
//   - pi starts with --no-approve, so a project folder is never trusted and
//     never stops the login at pi's trust prompt;
//   - with no terminal to attach to, the tmux session is ended, not left
//     running pi where nobody can reach it; a pi that is already gone ends
//     the wait at once.
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
// autocomplete), the keys still shown for 0.6 s after the Enter that submits
// them (a slow box), the menu, and what a pick on the menu leads to. An Enter
// on the menu, or while it is being drawn, logs "picked" — the browser tab of
// the bug. PAD is pi's editorPaddingX; DEAD a pi that exited at once.
const FAKE_TMUX = `#!/bin/sh
D="$(dirname "$0")"
log() { echo "$*" >> "$D/log"; }
border() { echo "────────────────────────────────────────"; }
cmd="$1"; shift
case "$cmd" in
  new-session)
    shift 3; log "start $*"; echo 0 > "$D/polls"
    if [ -n "$DEAD" ]; then echo dead > "$D/state"; else echo start > "$D/state"; fi;;
  has-session) [ "$(cat "$D/state")" != dead ];;
  capture-pane)
    echo x >> "$D/captures"
    st=$(cat "$D/state")
    [ "$st" = dead ] && exit 1
    echo " pi v1.4.0"
    case "$st" in
      start) n=$(($(cat "$D/polls") + 1)); echo $n > "$D/polls"; [ $n -ge 2 ] && echo empty > "$D/state";;
      empty) border; echo "$PAD"; border;;
      typed|accepted|submitting) border; printf '%s%s\\n' "$PAD" "$(cat "$D/keys")"; border; echo " → openai-codex  OpenAI Codex";;
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
        accepted)
          echo submitting > "$D/state"
          (sleep 0.6; [ "$(cat "$D/state")" = submitting ] && echo menu > "$D/state") >/dev/null 2>&1 &;;
        submitting|menu) log picked; echo picked > "$D/state";;
      esac
    fi;;
  attach) log attach; exit "\${ATTACH_RC:-0}";;
  kill-session) log kill;;
esac
`;

const PI = "/opt/qcr/node_modules/.bin/pi";

async function runLogin(
  provider: string | undefined,
  menu: string,
  env: Record<string, string> = {},
): Promise<{ log: string[]; captures: number; code: number }> {
  // Each run removes its own scratch dir: the cases run concurrently, so an
  // afterEach sweep would pull a sibling's fake tmux from under it.
  const dir = mkdtempSync(join(tmpdir(), "qcr-pilogin-"));
  try {
    writeFileSync(join(dir, "tmux"), FAKE_TMUX);
    chmodSync(join(dir, "tmux"), 0o755);
    writeFileSync(join(dir, "log"), "");
    writeFileSync(join(dir, "captures"), "");
    const [sh, c, script] = loginInPi(provider, PI);
    let code = 0;
    try {
      await exec(sh!, [c!, script!], {
        env: { PATH: `${dir}:${process.env["PATH"] ?? ""}`, MENU: menu, ...env },
      });
    } catch (err) {
      code = (err as { code?: number }).code ?? -1;
    }
    const lines = (f: string): string[] =>
      readFileSync(join(dir, f), "utf8").split("\n").filter(Boolean);
    return { log: lines("log"), captures: lines("captures").length, code };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("loginInPi: keys go in until pi takes them, never on a menu", () => {
  // MUTATION: restore the title match in src/pilogin.ts
  // (`case "$p" in *"Select authentication"*|*"Select provider"*) break;; esac`,
  // keys retyped whenever the box does not hold them) — the provider-method
  // titles and the unknown title fail with "picked" in the log.
  // MUTATION: drop the `sleep 1;` after the Enter that submits the keys — the
  // keys are still on screen at the next poll, and every case logs "picked".
  // MUTATION: drop `--no-approve` from the new-session line — every case fails
  // on the "start" line.
  it.concurrent.each([
    ["openai-codex", "Select OpenAI Codex login method:"],
    ["anthropic", "Select Anthropic login method:"],
    ["example", "How do you want to sign in to Example?"],
    [undefined, "Select authentication method:"],
    [undefined, "Select provider to configure:"],
  ])("/login %s stops at %j", async (provider, menu) => {
    const keys = provider ? `/login ${provider}` : "/login";
    const r = await runLogin(provider, menu);
    expect(r.log).toEqual([`start ${PI} --no-approve`, `type ${keys}`, "enter", "enter", "attach"]);
    expect(r.code).toBe(0);
  });

  // MUTATION: drop the two `sub(...)` trims from the awk — the padded keys no
  // longer equal the keys, the loop stops with them unsubmitted, and the log
  // has one "enter".
  it.concurrent("pi's editor padding (editorPaddingX) does not hide the typed keys", async () => {
    const r = await runLogin("openai-codex", "Select OpenAI Codex login method:", { PAD: "  " });
    expect(r.log).toEqual([
      `start ${PI} --no-approve`,
      "type /login openai-codex",
      "enter",
      "enter",
      "attach",
    ]);
  });

  // MUTATION: put `exec tmux attach -t "$s"` back — the log has no "kill".
  it.concurrent("with no terminal to attach to, the session is ended", async () => {
    const r = await runLogin("openai-codex", "Select OpenAI Codex login method:", {
      ATTACH_RC: "1",
    });
    expect(r.log.slice(-2)).toEqual(["attach", "kill"]);
    expect(r.log).not.toContain("picked");
    expect(r.code).toBe(1);
  });

  // MUTATION: drop `tmux has-session -t "$s" 2>/dev/null || break;` — the loop
  // polls a session that is gone 100 times, 30 s, before it fails.
  it.concurrent("a pi that exited at once ends the wait without polling", async () => {
    const r = await runLogin("openai-codex", "Select OpenAI Codex login method:", {
      DEAD: "1",
      ATTACH_RC: "1",
    });
    expect(r.log).toEqual([`start ${PI} --no-approve`, "attach", "kill"]);
    expect(r.captures).toBe(0);
    expect(r.code).toBe(1);
  });
});
