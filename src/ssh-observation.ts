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

/** Every `key value` row of the output, lowercased key, in order and unmerged.
 * SSH's first scalar value wins, but this parser applies no precedence: the
 * caller picks the first row of a scalar key, and repeated identityfile rows
 * stay separate. */
export function sshConfigRows(text: string): Array<readonly [string, string]> {
  return text.split("\n").flatMap((line) => {
    const match = /^(\S+)\s+(.+)$/.exec(line.trim());
    return match ? [[match[1]!.toLowerCase(), match[2]!.trim()] as const] : [];
  });
}

export const SSH_HOST_KEY_FAILURE =
  /host key verification failed|remote host identification has changed/i;
export const SSH_DNS_FAILURE = /could not resolve hostname|name or service not known/i;
export const SSH_TIMEOUT_FAILURE = /connection timed out|operation timed out|timed out after/i;
export const SSH_ROUTE_FAILURE = /connection refused|no route to host|network is unreachable/i;
