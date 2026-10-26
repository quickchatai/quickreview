// The real ports behind SetupEngine (the case runner is its own file,
// caserunner.ts; the checkout and the homes are scanfs.ts's, shared with the
// scan). Assembled by the companion's setup extension
// (extensions/setup.ts) inside the companion container, where the reviewed
// checkout is mounted read-only, the state home read-write and the config
// home in part (`profiles/`, `portrait/`) (the companion boundary). Tests use
// fakes and temp dirs; these are the only implementations that touch a real
// disk or network.
//
// Every port is total at its edge, like the engine above it: a missing
// checkout lists null, a missing token file answers a refusal, and nothing
// here throws into a tool call except the state port's "exists but cannot be
// read", which the engine turns into a reported, write-refusing problem.
import { readFileSync } from "node:fs";
import { OV_REVIEWER_USER } from "../memory/ovsession.js";
import type { MemoryStore } from "../memory/store.js";
import { OpenVikingClient } from "../openviking/client.js";
import { openVikingStore } from "../openviking/store.js";
import { EXPIRES_VAR, TOKEN_VAR } from "../tui/ghread.js";
import type { GitHubReader, TrackerSink } from "./engine.js";

// The checkout and home filesystems are the scan's own (scanfs.ts).
export {
  CHANGE_LOG_COMMITS,
  MAX_READ_BYTES,
  checkoutReader,
  configHomeFs,
  inRoot,
  stateHomeFs,
} from "@quickchatai/pi-quickreview/src/scan/scanfs.js";

/**
 * GitHub through the companion's read-only token file (`src/tui/ghread.ts`
 * writes it host-side). GET only — the method is not a
 * parameter anywhere on this path — and only API-relative paths, so a model-
 * supplied string can neither pick a verb nor aim the token at another host.
 * The file is re-read on every call: the host re-mints it in place.
 */
export function tokenFileGitHubReader(opts: {
  envFile: string | undefined;
  fetch: typeof fetch;
  clock: () => Date;
  apiRoot?: string;
}): GitHubReader {
  const apiRoot = opts.apiRoot ?? "https://api.github.com";
  return {
    get: async (path) => {
      if (
        !/^\/[A-Za-z0-9_./?&=%,:+-]*$/.test(path) ||
        path.startsWith("//") ||
        path.includes("..") ||
        /%2e/i.test(path)
      ) {
        return { ok: false, reason: `not an API path: ${JSON.stringify(path)}` };
      }
      if (!opts.envFile)
        return {
          ok: false,
          reason: "no read-only GitHub token is configured (QCR_GITHUB_READ_ENV unset)",
        };
      let text: string;
      try {
        text = readFileSync(opts.envFile, "utf8");
      } catch {
        return {
          ok: false,
          reason:
            "the read-only GitHub token file is missing — the TUI is closed or has no App credential",
        };
      }
      const token = new RegExp(`^${TOKEN_VAR}=(\\S+)$`, "m").exec(text)?.[1];
      const expires = Date.parse(new RegExp(`^${EXPIRES_VAR}=(\\S+)$`, "m").exec(text)?.[1] ?? "");
      if (!token) return { ok: false, reason: "the read-only GitHub token file holds no token" };
      if (!Number.isFinite(expires) || expires <= opts.clock().getTime()) {
        return {
          ok: false,
          reason: "the read-only GitHub token has expired — the TUI re-mints it while it runs",
        };
      }
      try {
        const res = await opts.fetch(`${apiRoot}${path}`, {
          method: "GET",
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
          },
          signal: AbortSignal.timeout(15_000),
        });
        if (!res.ok) return { ok: false, reason: `GitHub answered ${res.status} for GET ${path}` };
        return { ok: true, data: await res.json() };
      } catch (err) {
        return { ok: false, reason: `GET ${path} failed: ${String(err)}` };
      }
    },
  };
}

/** A port that is not wired: every call is an honest refusal, never a
 * silent no-op that reads as done. */
export function notYetTrackerSink(): TrackerSink {
  const reason = "the tracker sink is not wired yet";
  return {
    kind: "none",
    file: async () => ({ ok: false, reason }),
    close: async () => ({ ok: false, reason }),
  };
}

/**
 * Reviewer memory, from the companion's environment: the endpoint
 * its spawn is given (`OPENVIKING_URL`) and the reviewer user key its
 * `--env-file` carries — what setup writes is for the reviewer to read, and
 * the server confines that key to the reviewer's tree — never the
 * companion's own key (survey notes and history themes are for PR rounds),
 * never an ADMIN key. Null when either is missing: the caller then says memory
 * was not written (the survey refuses to start), never pretends.
 * A dead server is the store's own refusal, per write.
 */
export function reviewerMemoryFromEnv(env: NodeJS.ProcessEnv): MemoryStore | null {
  const baseUrl = env.OPENVIKING_URL?.trim() || env.OPENVIKING_BASE_URL?.trim();
  const key = env.OPENVIKING_REVIEWER_KEY?.trim();
  if (!baseUrl || !key) return null;
  return openVikingStore(new OpenVikingClient({ baseUrl, apiKey: key, user: OV_REVIEWER_USER }), {
    cacheTtlMs: 0,
  });
}
