import { fstatSync } from "node:fs";

/** The descriptor a round's commands inherit: the capability fd the env names
 * (`QCR_IPC_CAP_FD`), when it is a descriptor number and open in this process.
 * Null for a round with none. The one validator for the SDK bot host and the
 * interactive debug round. */
export function capabilityFdOf(env: Readonly<Record<string, string | undefined>>): number | null {
  const named = env["QCR_IPC_CAP_FD"];
  if (named === undefined || named === "") return null;
  const fd = /^\d{1,4}$/.test(named) ? Number(named) : 0;
  if (fd < 3) throw new Error(`QCR_IPC_CAP_FD is not an fd number (${JSON.stringify(named)})`);
  try {
    fstatSync(fd);
  } catch {
    throw new Error(`QCR_IPC_CAP_FD names fd ${fd}, which is not open in this process`);
  }
  return fd;
}
