// pi's own `/login`, typed for the person: the argv that starts pi in a fresh
// tmux session and sends `/login` once its input box is drawn. A leaf with no
// imports, so `qcr login` (src/npmverbs.ts) and `qcr scan login`
// (src/scanbox.ts) share it without one reaching the other.

/** pi itself, with `/login` (or `/login <provider>`) typed and sent for the
 * user: pi runs in a fresh tmux session; once its input box is drawn (two
 * editor borders on screen) the keys go in, and again every 0.3 s until pi's
 * login menu shows — an Enter sent while pi still starts is lost, and a
 * `/login` left in the editor then only needs the Enter. After 30 s the
 * terminal attaches regardless, so every login pi offers is there and
 * quitting pi ends it. `pi` is the pi to start: the companion image's CLI on
 * its PATH by default; the release image's entrypoint passes its one pi,
 * node_modules/.bin/pi (src/picli.ts `piCliIn`), and `qcr login` the pinned
 * package's own bin (src/picli.ts `piCliPath`). */
export function loginInPi(provider?: string, pi: string = "pi"): string[] {
  if (provider !== undefined && !/^[A-Za-z0-9._-]+$/.test(provider))
    throw new Error(
      `scan login: provider ${JSON.stringify(provider)} is not a plain provider name`,
    );
  // `@` and `+` are plain in sh: an npm install's pi lives under @earendil-works/.
  if (!/^[A-Za-z0-9._/@+-]+$/.test(pi))
    throw new Error(`scan login: pi ${JSON.stringify(pi)} is not a plain path`);
  const keys = provider ? `/login ${provider}` : "/login";
  return [
    "sh",
    "-c",
    `s=qcr-login-$$; tmux new-session -d -s "$s" ${pi} || exit 1; i=0; ` +
      `while [ $i -lt 100 ]; do p=$(tmux capture-pane -p -t "$s"); ` +
      `case "$p" in *"Select authentication"*|*"Select provider"*) break;; esac; ` +
      `if [ "$(printf '%s\\n' "$p" | grep -cF '──────────')" -ge 2 ]; then ` +
      `if printf '%s\\n' "$p" | grep -qxF '${keys}'; then tmux send-keys -t "$s" Enter; ` +
      `else tmux send-keys -t "$s" -l '${keys}'; tmux send-keys -t "$s" Enter; fi; fi; ` +
      `sleep 0.3; i=$((i+1)); done; ` +
      `exec tmux attach -t "$s"`,
  ];
}
