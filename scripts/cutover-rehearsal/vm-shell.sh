#!/usr/bin/env bash
# The "VM" side of the cutover rehearsal's ssh: the forced command of the throwaway sshd's one
# authorized key. Whatever the controller sends (`sudo qcr-update ...`, `sudo docker ...`, `cat
# /opt/quickreview/state/status.json`) lands here as SSH_ORIGINAL_COMMAND and runs in a shell whose PATH
# leads with vm-shims/ (sudo, qcr-update, rsync). This is a TEST TOOL: it never ships.
#
# One translation: the host-side path /opt/quickreview is the rehearsal's host directory ($QCR_RH_HOST),
# because an unprivileged user cannot create /opt/quickreview. A command that runs INSIDE a container
# (`docker exec ...`) names that container's own paths, which are left alone.
set -uo pipefail
# shellcheck disable=SC1090
. "${QCR_RH_ENV:?}"
cmd="${SSH_ORIGINAL_COMMAND:-}"
[[ -n "$cmd" ]] || { echo "vm-shell: no command" >&2; exit 2; }
if [[ "$cmd" != *"docker exec"* ]]; then
  cmd="${cmd//\/opt\/quickreview/$QCR_RH_HOST}"
fi
export PATH="$QCR_RH_SHIMS:$PATH"
printf '%s\t%s\n' "$(date +%H:%M:%S)" "$cmd" >>"$QCR_RH_VM/ssh-commands.log"
exec bash -c "$cmd"
