/** Raw OpenSSH observations, shared by onboarding and operator diagnostics. */
export function sshIdentityLines(stdout: string): string[] {
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !/has no identities/i.test(line));
}

export function sshAgentUnavailable(code: number | null, text: string): boolean {
  return (
    code === 2 || /could not open a connection|error connecting to agent|agent refused/i.test(text)
  );
}

/** SSH's first scalar value wins; repeated identityfile rows remain separate. */
export function sshConfigRows(text: string): Array<readonly [string, string]> {
  return text.split("\n").flatMap((line) => {
    const match = /^(\S+)\s+(.+)$/.exec(line.trim());
    return match ? [[match[1]!.toLowerCase(), match[2]!.trim()] as const] : [];
  });
}

export const SSH_HOST_KEY_FAILURE =
  /host key verification failed|remote host identification has changed/i;
export const SSH_DNS_FAILURE = /could not resolve hostname|name or service not known/i;
export const SSH_TIMEOUT_FAILURE = /connection timed out|operation timed out/i;
export const SSH_ROUTE_FAILURE = /connection refused|no route to host|network is unreachable/i;
