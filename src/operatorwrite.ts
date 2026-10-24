// The one in-container shell that writes an operator command file as root
// into the root-sealed `<commands>/operator/` — its full rationale is on
// `operatorCommandWriteScript` in src/tui/unwedge.ts, the TUI's caller. A
// leaf module (no imports) so the onboarding wizard's proof round, which knows
// the release image's command root rather than a TUI config, uses the same
// script without reaching the TUI's module graph.

/** `operatorCommandWriteScript` for a known command root (`<root>/commands`
 * inside the container) — the onboarding wizard's caller, which knows the
 * release image's layout rather than a TUI config. */
export function operatorCommandWriteScriptAt(root: string, name: string): string {
  const dir = `${root}/operator`;
  const tmp = `.${name}.tmp`;
  return (
    `[ -d '${root}' ] || { echo 'daemon commands dir ${root} missing - is the daemon running?' >&2; exit 1; }; ` +
    `mkdir -p '${dir}' || exit 1; ` +
    `[ ! -L '${dir}' ] || { echo '${dir} is a symlink - refusing to write the operator command' >&2; exit 1; }; ` +
    `R=$(cd -P '${root}' && pwd -P) || exit 1; ` +
    `cd -P '${dir}' || exit 1; ` +
    `[ "$(pwd -P)" = "$R/operator" ] || { echo '${dir} was replaced while writing - refusing to write the operator command' >&2; exit 1; }; ` +
    `chown -h 0:0 . && chmod 0755 . || exit 1; ` +
    `find . -maxdepth 1 -name '*.json' -mmin +1440 -delete 2>/dev/null; ` +
    `rm -f '${tmp}' '${name}' && cat > '${tmp}' && chmod 0644 '${tmp}' && mv '${tmp}' '${name}'`
  );
}
