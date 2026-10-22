// The session helpers' GitHub reads, served by the daemon.
//
// pr-context.sh, pr-checks.sh, pr-threads.sh and pr-self.sh read the reviewed
// PR from GitHub. They used to mint an installation token themselves
// (scripts/mint-token.sh), which needs the App's private key: so the model's
// bash, which runs them, had to be able to read secrets/. On a host the daemon
// runs (a round worker, an answer worker, a takeover, a debug round) they now ask
// the daemon instead, over the worker socket with the command's capability
// (src/ipc/ghreadshim.ts), and the model's tools run as a uid that cannot read
// secrets/ at all (docker/entrypoint.sh, D32).
//
// What the daemon serves is a READ and nothing else, of the reviewed repo and
// nothing else:
//   - `rest`: one GET of a path under /repos/<the configured repo>/, a plain
//     path and query (no `..`, no empty segment, no scheme or host). GET is the
//     only method there is; a body is never sent.
//   - `graphql`: one of the queries this module holds (GH_READ_QUERIES), by
//     name, with the variables that query declares. The owner and the name are
//     the configured repo's, filled in here; a session never sends query text,
//     so no mutation can be spelled.
// GitHub's answer comes back as it is: the status and the body as text, capped
// (a job log keeps its tail). Nothing here writes, and nothing goes near the
// MutationGate: there is no mutation to gate.
import type { RawReadAnswer, RawReadOptions } from "./github.js";
import type { OpHandler, RequestContext } from "./ipc/server.js";
import { IpcError } from "./ipc/protocol.js";

export const GH_READ_OP = "github.read";

/** The most of a body a read hands back, and of a job log's tail. */
export const GH_READ_MAX_BYTES = 4 * 1024 * 1024;
export const GH_READ_LOG_TAIL_BYTES = 512 * 1024;

/** The GraphQL reads the helpers make, by name: the query text and the
 * variables it declares beside `$owner`/`$name` (which are the repo's). Each
 * text is the script's own, byte for byte where the script still carries it for
 * a host without the daemon (tests/gh-read.test.ts holds the two equal). */
export const GH_READ_QUERIES = {
  "pr-threads": {
    text: `query($owner:String!,$name:String!,$number:Int!,$after:String){
  repository(owner:$owner,name:$name){ pullRequest(number:$number){
    reviewThreads(first:100,after:$after){pageInfo{hasNextPage endCursor}
      nodes{id isResolved isOutdated path line
        comments(first:100){totalCount nodes{databaseId author{login} body}}}}}}}`,
    cursors: ["after"],
  },
  "pr-context": {
    text: `query($owner:String!,$name:String!,$number:Int!,$filesCursor:String,$threadsCursor:String){
      repository(owner:$owner,name:$name){pullRequest(number:$number){
        title state headRefOid baseRefName author{login}
        files(first:100,after:$filesCursor){nodes{path additions deletions} pageInfo{hasNextPage endCursor}}
        reviews(last:10){nodes{author{login} state submittedAt}}
        reviewThreads(first:100,after:$threadsCursor){nodes{id isResolved isOutdated path line
          comments(last:2){nodes{author{login} body}}} pageInfo{hasNextPage endCursor}}
      }}}`,
    cursors: ["filesCursor", "threadsCursor"],
  },
} as const satisfies Record<string, { text: string; cursors: readonly string[] }>;

export type GhReadQueryName = keyof typeof GH_READ_QUERIES;

/** One read, as the daemon will make it. */
export type GhRead =
  | { kind: "rest"; path: string; tail: boolean }
  | { kind: "graphql"; name: GhReadQueryName; variables: Record<string, unknown> };

/** What answers a read: the adapter's raw reads. */
export interface GhReader {
  readonly owner: string;
  readonly repo: string;
  readText(path: string, o: RawReadOptions): Promise<RawReadAnswer>;
  graphqlText(
    query: string,
    variables: Record<string, unknown>,
    o: RawReadOptions,
  ): Promise<RawReadAnswer>;
}

const SEGMENT = /^[A-Za-z0-9._~%-]+$/;
const QUERY = /^[A-Za-z0-9._~%&=,-]*$/;
const CURSOR = /^[A-Za-z0-9+/=_:-]{1,512}$/;

function bad(message: string): IpcError {
  return new IpcError("bad_request", `github.read: ${message}`);
}

/** A REST path the helpers may read: a plain path under the repo's own
 * /repos/<owner>/<repo>/, with an optional plain query. */
export function readablePath(path: unknown, owner: string, repo: string): string {
  if (typeof path !== "string" || path.length === 0 || path.length > 2048)
    throw bad("`path` must be a string of at most 2048 characters");
  const q = path.indexOf("?");
  const pathPart = q === -1 ? path : path.slice(0, q);
  const query = q === -1 ? "" : path.slice(q + 1);
  if (!QUERY.test(query)) throw bad(`the query of ${JSON.stringify(path)} is not a plain query`);
  if (!pathPart.startsWith("/")) throw bad("`path` must start with /repos/<owner>/<repo>/");
  const segs = pathPart.slice(1).split("/");
  if (segs.some((s) => !SEGMENT.test(s) || s === "." || s === ".."))
    throw bad(`${JSON.stringify(path)} is not a plain path`);
  if (segs.some((s) => /%2e|%2f|%5c/i.test(s)))
    throw bad(`${JSON.stringify(path)} carries an encoded separator`);
  const [r, o, n, ...rest] = segs;
  if (
    r !== "repos" ||
    o?.toLowerCase() !== owner.toLowerCase() ||
    n?.toLowerCase() !== repo.toLowerCase() ||
    rest.length === 0
  )
    throw bad(`only the reviewed repo is read (/repos/${owner}/${repo}/…), not ${path}`);
  return path;
}

/** The request body of a read, checked. Throws bad_request. */
export function parseGhRead(body: unknown, owner: string, repo: string): GhRead {
  if (typeof body !== "object" || body === null || Array.isArray(body))
    throw bad("the body must be an object");
  const b = body as Record<string, unknown>;
  if (b["kind"] === "rest") {
    const path = readablePath(b["path"], owner, repo);
    return { kind: "rest", path, tail: /\/actions\/jobs\/\d+\/logs$/.test(path.split("?")[0]!) };
  }
  if (b["kind"] === "graphql") {
    const name = b["name"];
    if (typeof name !== "string" || !Object.hasOwn(GH_READ_QUERIES, name))
      throw bad(
        `unknown query ${JSON.stringify(name)} (${Object.keys(GH_READ_QUERIES).join(", ")})`,
      );
    const q = GH_READ_QUERIES[name as GhReadQueryName];
    const raw = b["variables"];
    if (typeof raw !== "object" || raw === null || Array.isArray(raw))
      throw bad("`variables` must be an object");
    const given = raw as Record<string, unknown>;
    const allowed = new Set<string>(["number", ...q.cursors]);
    for (const k of Object.keys(given))
      if (!allowed.has(k)) throw bad(`query ${name} takes no variable ${JSON.stringify(k)}`);
    const number = given["number"];
    if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 1)
      throw bad("`variables.number` must be a positive integer");
    const variables: Record<string, unknown> = { owner, name: repo, number };
    for (const c of q.cursors) {
      const v = given[c];
      if (v === undefined || v === null) variables[c] = null;
      else if (typeof v === "string" && CURSOR.test(v)) variables[c] = v;
      else throw bad(`\`variables.${c}\` must be a cursor string or null`);
    }
    return { kind: "graphql", name: name as GhReadQueryName, variables };
  }
  throw bad("`kind` must be rest or graphql");
}

/** What the op answers: GitHub's status and body, and whether it was cut. */
export interface GhReadAnswer {
  status: number;
  body: string;
  truncated: boolean;
}

/** Serve one read. */
export async function serveGhRead(reader: GhReader, read: GhRead): Promise<GhReadAnswer> {
  if (read.kind === "rest")
    return reader.readText(read.path, {
      maxBytes: read.tail ? GH_READ_LOG_TAIL_BYTES : GH_READ_MAX_BYTES,
      tail: read.tail,
    });
  return reader.graphqlText(GH_READ_QUERIES[read.name].text, read.variables, {
    maxBytes: GH_READ_MAX_BYTES,
  });
}

/** The op the worker socket serves. Every caller a worker, a post shim or a
 * pane's script holds a live command; a read needs nothing more (an answer
 * worker without may_post has no bash, and a takeover may read). */
export function ghReadOps(deps: {
  reader: GhReader;
  log?: (line: string) => void;
}): Record<string, OpHandler> {
  return {
    [GH_READ_OP]: {
      roles: ["shim", "worker"],
      handle: async (ctx: RequestContext, body: unknown) => {
        const read = parseGhRead(body, deps.reader.owner, deps.reader.repo);
        try {
          return await serveGhRead(deps.reader, read);
        } catch (e) {
          deps.log?.(
            `github.read for pr ${ctx.pr} (${read.kind === "rest" ? read.path : read.name}) failed: ${String(e)}`,
          );
          throw new IpcError("internal", `github.read: the request failed (${String(e)})`);
        }
      },
    },
  };
}
