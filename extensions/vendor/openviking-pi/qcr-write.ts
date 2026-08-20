// QCR FORK — file added by PATCH 4 (durable writes). Not upstream.
//
// The pure half of the `viking_write` tool: URI/tag validation, body
// rendering, hashing and request assembly. It is deliberately free of pi and
// of the OV client so `tests/openviking-fork.test.ts` can exercise it in the
// normal vitest run — `tools.ts` cannot be imported from a test because it
// pulls `typebox` and `@earendil-works/pi-ai`, neither of which is installed
// in this repo (pi lives only in the container).
//
// WHY THIS EXISTS AT ALL: upstream's `viking_remember` is not a write. It
// prefixes the text with `[Remember — <category>]` and appends it as a SESSION
// MESSAGE; the fact becomes durable memory only through commit-time
// extraction, which needs a `vlm` — and our deployment configures none
// (memories are authored, never extracted). Verified against a running
// v0.4.15 server: assets/findings.md §3.2.
//
// WHY batch-write AND NOT content/write: for memory-context targets
// `content/write` appends a server-side `MEMORY_FIELDS` footer that
// `content/read` strips again, so the natural read → sha256 → write round trip
// 409s forever and no API returns the stored hash. Files created *by*
// batch-write carry no footer and round-trip correctly. batch-write is
// therefore the ONE write path — findings §3.3.

import { createHash } from "node:crypto";

/** Memory targets keep a text-extension allowlist server-side; these are the
 * two we ever author. */
export const ALLOWED_EXTENSIONS: readonly string[] = [".md", ".txt"];

/** Tags are our own convention (`#pinned`, `#manual`, `#feedback`, `#bug`,
 * `#rejected-proposal`), so the grammar is ours and it is strict: a mistyped
 * tag that silently lands is worse than a refused write. */
export const TAG_RE = /^[a-z0-9][a-z0-9._-]*$/;
export const MAX_TAGS = 16;

export interface BatchWriteOperation {
  uri: string;
  content: string;
  precondition:
    | { kind: "create_if_absent" }
    | { kind: "replace_if_hash"; base_hash: string };
}

export interface BatchWriteRequest {
  root_uri: string;
  operations: BatchWriteOperation[];
  wait: boolean;
}

export interface WriteRequestOk {
  ok: true;
  request: BatchWriteRequest;
  /** The exact bytes sent — the caller reports this back so a follow-up
   * replace has its precondition without a read. */
  body: string;
  /** `sha256:<hex>` over `body`, i.e. the stored bytes of what we just wrote. */
  hash: string;
  tags: string[];
}

export interface WriteRequestError {
  ok: false;
  /** Rendered verbatim to the model — say what to do, not just what broke. */
  error: string;
}

export type WriteRequestResult = WriteRequestOk | WriteRequestError;

export interface WriteRequestInput {
  uri: unknown;
  content: unknown;
  tags?: unknown;
  mode?: unknown;
  expect_hash?: unknown;
  wait?: unknown;
}

/** `sha256:<lowercase-hex>` — the shape batch-write's `base_hash` wants. */
export function sha256Prefixed(body: string): string {
  return `sha256:${createHash("sha256").update(Buffer.from(body, "utf8")).digest("hex")}`;
}

/** Accepts a bare hex digest or an already-prefixed one; rejects anything
 * else rather than sending a precondition the server will misread. */
export function normalizeHash(raw: unknown): string | null {
  const value = String(raw ?? "").trim().toLowerCase();
  const bare = value.startsWith("sha256:") ? value.slice("sha256:".length) : value;
  if (!/^[0-9a-f]{64}$/.test(bare)) return null;
  return `sha256:${bare}`;
}

/** `viking://a/b/c.md` → `viking://a/b`. Empty when there is no parent. */
export function parentUri(uri: string): string {
  const cleaned = uri.replace(/\/+$/, "");
  const cut = cleaned.lastIndexOf("/");
  if (cut < 0) return "";
  const parent = cleaned.slice(0, cut);
  return parent === "viking:/" || parent === "viking://" ? "" : parent;
}

/** A write target must be a concrete text file under a viking:// directory.
 * Server-side the reviewer's USER key confines it to `user/reviewer/` anyway
 * (findings §1) — this only catches the obvious mistakes early. */
export function validateWriteUri(uri: string): string | null {
  if (!uri) return "viking_write needs a `uri`.";
  if (!uri.startsWith("viking://")) {
    return `viking_write only writes viking:// URIs; got "${uri}".`;
  }
  if (/\s/.test(uri) || uri.includes("..")) {
    return `Refusing to write "${uri}": a URI may not contain whitespace or "..".`;
  }
  if (!ALLOWED_EXTENSIONS.some((ext) => uri.endsWith(ext))) {
    return `Refusing to write "${uri}": memory files must end in ${ALLOWED_EXTENSIONS.join(" or ")}.`;
  }
  if (!parentUri(uri)) {
    return `Refusing to write "${uri}": it has no parent directory to write under.`;
  }
  return null;
}

export interface TagResult {
  ok: boolean;
  tags: string[];
  error?: string;
}

/** Normalizes `["#Pinned", "manual"]` → `["pinned", "manual"]`, deduped and
 * order-preserving. */
export function normalizeTags(raw: unknown): TagResult {
  if (raw === undefined || raw === null) return { ok: true, tags: [] };
  const list = Array.isArray(raw) ? raw : [raw];
  const out: string[] = [];
  for (const entry of list) {
    const tag = String(entry ?? "").trim().replace(/^#+/, "").toLowerCase();
    if (!tag) continue;
    if (!TAG_RE.test(tag)) {
      return {
        ok: false,
        tags: [],
        error: `Invalid tag "${String(entry)}": tags are lowercase words like "pinned" or "review-ops".`,
      };
    }
    if (!out.includes(tag)) out.push(tag);
  }
  if (out.length > MAX_TAGS) {
    return { ok: false, tags: [], error: `Too many tags (${out.length}); the cap is ${MAX_TAGS}.` };
  }
  return { ok: true, tags: out };
}

/**
 * The stored body. Tags are rendered as a visible `Tags: #a #b` line rather
 * than as a `MEMORY_FIELDS` block: plain text is what search indexes and what
 * `content/read` returns unmodified, and it cannot be stripped by a server
 * that reserves that footer for its own extractor. The retrieval tag list is
 * set separately, best-effort, by the tool (fs/attrs/set_tags).
 */
export function renderMemoryBody(content: unknown, tags: readonly string[]): string {
  const trimmed = String(content ?? "").replace(/\s+$/, "");
  if (!trimmed) return "";
  if (tags.length === 0) return `${trimmed}\n`;
  if (/(^|\n)Tags:[ \t]*#/.test(trimmed)) return `${trimmed}\n`; // author wrote their own
  return `${trimmed}\n\nTags: ${tags.map((t) => `#${t}`).join(" ")}\n`;
}

/**
 * Validate + assemble one `content/batch-write` request.
 *
 * `mode` defaults to `create` and `replace` REQUIRES `expect_hash`: there is
 * no blind-overwrite path, because a memory file is a shared document (the EOD
 * curator and the TUI write it too) and a lost update is silent.
 */
export function buildWriteRequest(input: WriteRequestInput): WriteRequestResult {
  const uri = String(input.uri ?? "").trim();
  const uriProblem = validateWriteUri(uri);
  if (uriProblem) return { ok: false, error: uriProblem };

  const rawMode = String(input.mode ?? "create").trim().toLowerCase();
  if (rawMode !== "create" && rawMode !== "replace") {
    return { ok: false, error: `Unknown mode "${rawMode}": use "create" or "replace".` };
  }

  const tags = normalizeTags(input.tags);
  if (!tags.ok) return { ok: false, error: tags.error ?? "Invalid tags." };

  const body = renderMemoryBody(input.content, tags.tags);
  if (!body.trim()) return { ok: false, error: "viking_write needs non-empty `content`." };

  let precondition: BatchWriteOperation["precondition"];
  if (rawMode === "create") {
    precondition = { kind: "create_if_absent" };
  } else {
    const baseHash = normalizeHash(input.expect_hash);
    if (!baseHash) {
      return {
        ok: false,
        error:
          'mode "replace" requires `expect_hash` — the sha256 of the CURRENT stored bytes ' +
          "(the hash returned by the last viking_write, or read it from the daemon). " +
          "Writing without one would silently overwrite someone else's edit.",
      };
    }
    precondition = { kind: "replace_if_hash", base_hash: baseHash };
  }

  return {
    ok: true,
    body,
    hash: sha256Prefixed(body),
    tags: tags.tags,
    request: {
      root_uri: parentUri(uri),
      operations: [{ uri, content: body, precondition }],
      // wait=false by default: `wait` blocks on the semantic/vector refresh,
      // measured at ~1.6 CORE-SECONDS per write on the 2-CPU container quota
      // (findings §6). The bytes are durable either way; only searchability
      // lags. "OpenViking must never block or delay a review round."
      wait: input.wait === true,
    },
  };
}
