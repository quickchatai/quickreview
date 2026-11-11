// The auth context of a review host: where a provider may look for a
// credential that is not stored.
//
// pi-ai's default auth context expands `~` to the operator's home to look for
// ambient credentials (one provider checks a file under ~/.config for its
// application-default credentials). A review host takes its credentials from
// the store it was given and from an environment, so `~` paths are simply
// absent. The environment is the one the host names (`authEnv`), else the
// process's, read at each lookup.
//
// One rule, two readers: the host isolates its model runtime with it
// (pisdk.ts), and the plugin asks it which of a running pi's ambient
// credentials a review host would not find (extensions/quickreview.ts).
import { access } from "node:fs/promises";

export interface ReviewAuthContext {
  env(name: string): Promise<string | undefined>;
  fileExists(path: string): Promise<boolean>;
}

export function reviewAuthContext(
  authEnv: Readonly<Record<string, string | undefined>> | undefined,
): ReviewAuthContext {
  return {
    async env(name: string): Promise<string | undefined> {
      const value = (authEnv ?? process.env)[name];
      return typeof value === "string" && value.trim().length > 0 ? value : undefined;
    },
    async fileExists(path: string): Promise<boolean> {
      if (path.startsWith("~")) return false;
      try {
        await access(path);
        return true;
      } catch {
        return false;
      }
    },
  };
}
