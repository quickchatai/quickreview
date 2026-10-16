// leaf-cache — the CHILD half of the shared context pack
// (`[review] context_pack = "pack-first"`; the daemon half is
// src/contextpack.ts, the launcher half extensions/subagents.ts).
//
// The model provider caches a request's PREFIX. Without this extension, a
// lens child's request is `instructions` = pi's base system prompt + the lens
// agent's body (appended with --append-system-prompt), then `input` = the task.
// Every lens body is different, so two lenses share nothing past pi's base
// prompt — and the diff and files every lens then reads arrive as fresh,
// uncached tool output.
//
// This extension, loaded ONLY into a lens child (or its cache group's warm-up)
// and ONLY when the launcher found the round's pack (QCR_LEAF_PACK), reorders
// each request so the shared part comes first:
//
//   instructions  pi's base system prompt            (identical for every child)
//   input[0]      user:      the PR context pack     (identical for every child)
//   input[1]      developer: the lens agent's body   (this lens's charter)
//   input[2…]     the request's own input            (the task, then the turns)
//
// The lens body keeps instruction authority as a DEVELOPER message, above the
// pack, which is user-role DATA (and says so). The group's warm-up has no lens
// body: its request is instructions + pack + "reply OK", the prefix every lens
// request of the group extends — which is what the backend reuses (a request
// that merely shares a prefix with another and then diverges for more than a
// few dozen words does not hit; probed, see extensions/subagents.ts). The same rewrite is applied to
// every request of the child, so its own later turns keep a stable prefix too.
//
// Fail-open, always: when anything is not as expected — no pack, the appended
// prompt not found at the end of `instructions`, an `input` that is not an
// array — the payload goes out unchanged, exactly as without this extension.
//
// VERIFY-ON-PIN (pi 1.0.0, openai-codex-responses):
//  - `before_provider_request` may return a replacement payload
//    (examples/extensions/provider-payload.ts, CHANGELOG "inspect or replace");
//  - the codex payload carries `instructions` (string) and `input` (an array of
//    `{ role, content: [{ type: "input_text", text }] }`) — probed 2026-10-09;
//  - pi puts the appended prompt inside `<addendum>\n…\n</addendum>` near the
//    end of `instructions`, followed by `<cwd>…</cwd>` (probed 2026-10-09):
//    that one block is lifted out, found by the body's exact text — once, or
//    no rewrite;
//  - a `developer` role input message is accepted by the codex backend (probed
//    with this extension before it shipped; see docs/prompt-caching.md).
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const ADDENDUM_OPEN = "<addendum>";
const ADDENDUM_CLOSE = "</addendum>";

/** Env var: "1" prints a digest of each request's prefix parts to stderr, so
 * two children's requests can be compared for where they diverge. */
export const LEAF_CACHE_DEBUG_ENV = "QCR_LEAF_CACHE_DEBUG";

/** Short hashes of the parts that make up a request's cacheable prefix, in
 * request order (never their content). */
export function prefixDigest(payload: unknown): string {
  const h = (v: unknown) =>
    createHash("sha256")
      .update(JSON.stringify(v ?? null))
      .digest("hex")
      .slice(0, 10);
  if (typeof payload !== "object" || payload === null) return "no payload";
  const p = payload as Record<string, unknown>;
  const input = Array.isArray(p.input) ? p.input : [];
  const rest = Object.fromEntries(
    Object.entries(p).filter(([k]) => !["instructions", "input", "tools"].includes(k)),
  );
  return [
    `other=${h(rest)}`,
    `instructions=${h(p.instructions)}`,
    `tools=${h(p.tools)}`,
    ...input.slice(0, 3).map((m, i) => `input${i}=${h(m)}`),
  ].join(" ");
}

/** Env var naming the round's context pack (set by the launcher per child). */
export const LEAF_PACK_ENV = "QCR_LEAF_PACK";

/** The value of `--append-system-prompt` in a pi argv: a path to a file (as
 * pi's native subagent tool passes it) whose text is the lens body. */
export function appendedPromptPath(argv: readonly string[]): string | undefined {
  const i = argv.lastIndexOf("--append-system-prompt");
  return i >= 0 ? argv[i + 1] : undefined;
}

interface InputMessage {
  role: string;
  content: Array<{ type: string; text?: string }>;
}

function textMessage(role: string, text: string): InputMessage {
  return { role, content: [{ type: "input_text", text }] };
}

/**
 * The pack-first payload, or undefined to send the original. Pure.
 * `appended` is the lens body as pi appended it; `pack` the pack's text.
 */
export function packFirstPayload(
  payload: unknown,
  appended: string,
  pack: string,
): Record<string, unknown> | undefined {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return undefined;
  const p = payload as Record<string, unknown>;
  const instructions = p.instructions;
  const input = p.input;
  const body = appended.trim();
  if (typeof instructions !== "string" || !Array.isArray(input) || !pack.trim()) return undefined;
  // A group's WARM-UP (no lens text): only the pack goes first, so its request
  // is exactly the prefix every lens request of the group extends.
  if (!body) return { ...p, input: [textMessage("user", pack), ...input] };
  const at = instructions.indexOf(body);
  if (at < 0 || instructions.indexOf(body, at + 1) >= 0) return undefined;
  let start = at;
  let end = at + body.length;
  // The whole `<addendum>…</addendum>` block when the body is all it holds.
  const open = instructions.lastIndexOf(ADDENDUM_OPEN, at);
  const close = instructions.indexOf(ADDENDUM_CLOSE, end);
  if (
    open >= 0 &&
    close >= 0 &&
    instructions.slice(open + ADDENDUM_OPEN.length, at).trim() === "" &&
    instructions.slice(end, close).trim() === ""
  ) {
    start = open;
    end = close + ADDENDUM_CLOSE.length;
  }
  const before = instructions.slice(0, start).trimEnd();
  const after = instructions.slice(end).trim();
  if (!before) return undefined;
  const base = after ? `${before}\n\n${after}` : before;
  return {
    ...p,
    instructions: base,
    input: [textMessage("user", pack), textMessage("developer", body), ...input],
  };
}

export default function activate(pi: {
  on(event: string, handler: (event: { payload?: unknown }) => unknown): void;
}): void {
  const packPath = process.env[LEAF_PACK_ENV];
  const appendedPath = appendedPromptPath(process.argv);
  if (!packPath) return;
  let pack: string;
  let appended: string;
  try {
    pack = readFileSync(packPath, "utf8");
    // No appended prompt: this child is its group's warm-up.
    appended = appendedPath ? readFileSync(appendedPath, "utf8") : "";
  } catch (err) {
    console.error(
      `leaf-cache: pack not applied (${err instanceof Error ? err.message : String(err)})`,
    );
    return;
  }
  let warned = false;
  const debug = process.env[LEAF_CACHE_DEBUG_ENV] === "1";
  pi.on("before_provider_request", (event) => {
    const next = packFirstPayload(event.payload, appended, pack);
    if (debug) console.error(`leaf-cache: ${prefixDigest(next ?? event.payload)}`);
    if (!next && !warned) {
      warned = true;
      console.error("leaf-cache: request shape not as expected; sent unchanged");
    }
    return next;
  });
}
