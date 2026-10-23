// leaf-cache, the pack-first payload rewrite and the SDK lens's extension that
// applies it.
//
// The request layout: the lens body comes out of pi's `<addendum>` block in
// `instructions`; the input becomes the pack (user role, fenced data), then the
// lens body as a developer message, then the task. The pack is then the prefix
// every lens request of a cache group extends (docs/prompt-caching.md).
//
// leafCache({ pack, cacheKey }) rewrites each request pack-first, and on a payload that carries
// a `prompt_cache_key` sets it to the group's key. Under the shared session id
// of a cache group (D7, docs/probes/p4.6-codex-cache-routing.md) the key already
// equals that id, so the second edit is a belt for a pi that derives the key
// another way, not what routes the cache. Fail-open, always: a payload that is
// not the expected shape goes out unchanged, and a throw inside the handler is
// pi's to contain (it reports it as an extension error), never the request's.
//
// VERIFY-ON-PIN (pi 1.3.0): `before_provider_request` may return a replacement
// payload; the codex payload carries `instructions` (string), `input` (an array
// of `{ role, content: [{ type: "input_text", text }] }`) and `prompt_cache_key`.
import { createHash } from "node:crypto";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

const ADDENDUM_OPEN = "<addendum>";
const ADDENDUM_CLOSE = "</addendum>";

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

/** The payload with `prompt_cache_key` set to `cacheKey`, or undefined when it
 * carries no string key or already has this one. */
function withCacheKey(payload: unknown, cacheKey: string): Record<string, unknown> | undefined {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return undefined;
  const p = payload as Record<string, unknown>;
  const held = p["prompt_cache_key"];
  return typeof held === "string" && held !== cacheKey
    ? { ...p, prompt_cache_key: cacheKey }
    : undefined;
}

export interface LeafCacheOptions {
  /** The round's context pack text. Blank: the extension does nothing. */
  pack: string;
  /** The cache group's key (= its shared session id). */
  cacheKey: string;
  /** The lens body as appended to the system prompt; "" for a group's warm-up. */
  body?: string;
  /** Told once when a request is not the shape the rewrite expects. */
  onUnexpected?: () => void;
}

/** The extension that puts the pack first and pins the cache key. */
export function leafCache(options: LeafCacheOptions): ExtensionFactory {
  return (pi) => {
    if (!options.pack.trim()) return;
    let warned = false;
    pi.on("before_provider_request", (event) => {
      const packed = packFirstPayload(event.payload, options.body ?? "", options.pack);
      if (packed === undefined && !warned) {
        warned = true;
        options.onUnexpected?.();
      }
      return withCacheKey(packed ?? event.payload, options.cacheKey) ?? packed;
    });
  };
}
