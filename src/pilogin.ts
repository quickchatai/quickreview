// pi's own `/login`, typed for the person: the argv that starts pi in a fresh
// tmux session and sends `/login` once its input box is drawn. A leaf with no
// imports, so `qcr login` (src/npmverbs.ts) and `qcr scan login`
// (src/scanbox.ts) share it without one reaching the other.

/** pi itself, with `/login` (or `/login <provider>`) typed and sent for the
 * user: pi runs in a fresh tmux session, and qcr reads pi's input box, the
 * lines between the last two editor borders on screen, every 0.3 s (a second
 * after a key). Empty, it gets the keys and an Enter; still holding exactly
 * the keys, one more Enter (an Enter sent while pi still starts is lost, and
 * the first one may only accept the autocomplete). Anything else in the box is
 * one of pi's menus (the provider list, a provider's own login methods), and
 * no key goes in again. pi draws every selection in that box, so this holds
 * whatever title pi or a provider gives the menu, where an Enter would pick
 * its default: a browser login, opened again on every poll. pi starts with
 * `--no-approve`: a login needs nothing from the folder qcr was run in, so a
 * project folder neither stops it at pi's trust prompt nor gets trusted. A pi
 * that has already exited ends the wait at once. After 30 s the terminal
 * attaches regardless, so every login pi offers is there and quitting pi ends
 * it; a failed attach (no terminal) ends the session instead of leaving pi
 * running where nobody can reach it. `pi` is the pi to start: the
 * companion image's CLI on its PATH by default; the release image's entrypoint
 * passes its one pi, node_modules/.bin/pi (src/picli.ts `piCliIn`), and
 * `qcr login` the pinned package's own bin (src/picli.ts `piCliPath`). */
export function loginInPi(provider?: string, pi: string = "pi"): string[] {
  if (provider !== undefined && !/^[A-Za-z0-9._-]+$/.test(provider))
    throw new Error(
      `scan login: provider ${JSON.stringify(provider)} is not a plain provider name`,
    );
  // `@` and `+` are plain in sh: an npm install's pi lives under @earendil-works/.
  if (!/^[A-Za-z0-9._/@+-]+$/.test(pi))
    throw new Error(`scan login: pi ${JSON.stringify(pi)} is not a plain path`);
  const keys = provider ? `/login ${provider}` : "/login";
  // The input box, its side padding (pi's editorPaddingX) trimmed and blank
  // lines dropped; awk fails while fewer than two borders are drawn (pi still
  // starting), and the loop then only waits.
  const box =
    `tmux capture-pane -p -t "$s" 2>/dev/null | awk '/──────────/ { b[++n] = NR } { l[NR] = $0 } ` +
    `END { if (n < 2) exit 1; for (i = b[n - 1] + 1; i < b[n]; i++) ` +
    `{ sub(/^ +/, "", l[i]); sub(/ +$/, "", l[i]); if (l[i] != "") print l[i] } }'`;
  return [
    "sh",
    "-c",
    `s=qcr-login-$$; tmux new-session -d -s "$s" ${pi} --no-approve || exit 1; i=0; ` +
      `while [ $i -lt 100 ]; do tmux has-session -t "$s" 2>/dev/null || break; ` +
      `if e=$(${box}); then ` +
      `if [ -z "$e" ]; then tmux send-keys -t "$s" -l '${keys}'; tmux send-keys -t "$s" Enter; sleep 1; ` +
      `elif [ "$e" = '${keys}' ]; then tmux send-keys -t "$s" Enter; sleep 1; ` +
      `else break; fi; fi; ` +
      `sleep 0.3; i=$((i+1)); done; ` +
      `tmux attach -t "$s" || { tmux kill-session -t "$s" 2>/dev/null; exit 1; }`,
  ];
}
