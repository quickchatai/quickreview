// The core's half of the GitHub client: what a review route needs to read a
// PR and post through the one gate without the daemon's adapter
// (src/github.ts, which re-exports these).

/** A GitHub request that came back refused: the method, path and status, and
 * how long GitHub asked us to wait, when it said. */
export class GitHubRequestError extends Error {
  constructor(
    readonly method: string,
    readonly path: string,
    readonly status: number,
    detail: string,
    readonly retryAfterMs?: number,
  ) {
    super(`${method} ${path} → ${status}: ${detail}`);
    this.name = "GitHubRequestError";
  }
}
