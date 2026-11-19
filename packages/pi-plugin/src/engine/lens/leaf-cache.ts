// leaf-cache, the pack-first payload rewrite and the SDK lens's extension that
// applies it.
//
// The request layout: the lens body comes out of pi's `<addendum>` block in
// `instructions`; the input becomes pi's tool declarations where pi put them
// (its head), then the pack (user role, fenced data), then the message that
// closes the pack (PACK_CLOSING, a warm-up's whole prompt), then the lens body
// as a developer message, then the task. A cache group's warm-up holds exactly
// what comes before the lens body, so every lens request of the group extends
// it and reads it from the provider's cache (docs/prompt-caching.md).
//
// The tool declarations stay ahead of the pack because the backend shares a
// prefix between two requests only as far as their tool declarations sit in
// the same place: with the declarations after the pack in a warm-up and after
// the lens body in a lens, a lens read nothing of the warm-up from cache
// (measured: 0 of ~36k tokens; with them at the head, 33k of 36k).
//
// leafCache({ pack, cacheKey }) rewrites each request pack-first, and on a payload that carries
// a `prompt_cache_key` sets it to the group's key. Under the shared session id
// of a cache group (docs/probes/p4.6-codex-cache-routing.md) the key already
// equals that id, so the second edit is a belt for a pi that derives the key
// another way, not what routes the cache. Fail-open, always: a payload that is
// not the expected shape goes out unchanged, and a throw inside the handler is
// pi's to contain (it reports it as an extension error), never the request's.
//
// The rewrite is an optimisation for one API family, PACK_FIRST_APIS: the
// request it builds is that family's, so the runner attaches this extension
// only to a cache group whose model speaks one of those APIs (runlens.ts). A
// lens on any other API gets its own request untouched and reads the pack file
// its task names.
//
// VERIFY-ON-PIN (pi 1.3.0, re-read at 1.4.0): `before_provider_request` may return a replacement
// payload; the codex payload carries `instructions` (string), `input` (an array
// of `{ role, content: [{ type: "input_text", text }] }`) and `prompt_cache_key`.
// At 1.4.0 the tools are declared in the input, by `{ type: "additional_tools" }`
// items starting at its head, and no longer in a top-level `tools` field
// (tests/pi-canary/canary-16-pack-first-prefix.test.ts holds the rewrite to
// pi's real request).
import { createHash } from "node:crypto";
import type { KnownApi } from "@earendil-works/pi-ai";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

const ADDENDUM_OPEN = "<addendum>";
const ADDENDUM_CLOSE = "</addendum>";

/**
 * The message that closes the pack: the whole of a warm-up's prompt, and a
 * message every lens request repeats right after the pack. A lens request then
 * EXTENDS its warm-up's, word for word, and does not part from it after the
 * pack.
 *
 * That matters because the backend keeps one reusable point per request, at
 * the last 128-token boundary before the request's end, and a later request
 * reads the cache only if it repeats the earlier one up to that point. A
 * warm-up that ended in words of its own ("reply OK") put that point inside
 * those words whenever a boundary fell there, and then every lens of the group
 * read nothing (measured: 0 of 16 lenses while the warm-up's size was 82 to 90
 * tokens past a boundary; no group lost over a whole 128-token cycle with the
 * lenses extending).
 *
 * For a lens the sentence is inert: its instructions and its task follow.
 */
export const PACK_CLOSING =
  "The context pack ends here. If no instructions and no task follow this message, reply with the single word OK and nothing else.";

// VERIFY-ON-PIN (pi 1.4.0): pi-ai's own name (`KnownApi`, a model's `api`) for
// the one API whose request carries the system prompt as a string in
// `instructions`, which is what the rewrite moves. The annotation holds the
// name to that union, so a pi that renames or drops it stops the build. pi's
// other Responses APIs (`openai-responses`, `azure-openai-responses`) send the
// system prompt as the first input message: the rewrite would leave their
// request as it is, so they are not in the family, and a group on one gets no
// warm-up to wait for. An API is added here by hand, once pi builds its
// request in the shape the rewrite reads (a test holds that) and a whole
// review on it was measured to cost less with the pack than without: on the
// Messages API every lens read the pack from cache and the round cost twice
// as much (docs/prompt-caching.md).
const PACK_FIRST_FAMILY: readonly KnownApi[] = ["openai-codex-responses"];

/**
 * The API family the pack-first rewrite is built for, as pi's API names: what
 * a model's `api` says, never a provider and never a model. A cache group is
 * packed (warm-up, wait, rewrite) only when its model's API is in this set.
 * Inside the family the rewrite is still fail-open: a request that is not the
 * shape it expects (the system prompt as a string in `instructions`, the
 * conversation in `input`) goes out unchanged, with one warning line.
 *
 * The measured cost estimate is true for this family alone, since the pack is
 * what its token mix rests on: `MEASURED.apis` (measured.ts) is this set, and
 * a test holds the two equal.
 */
export const PACK_FIRST_APIS: ReadonlySet<string> = new Set<string>(PACK_FIRST_FAMILY);

/** Whether a model that speaks `api` gets the pack first. An API the host could
 * not name is not in the family. */
export function isPackFirstApi(api: string | undefined): boolean {
  return api !== undefined && PACK_FIRST_APIS.has(api);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** pi's tool declaration item in a Responses input (pi-ai
 * openai-responses-shared.js `additional_tools`). */
const TOOL_DECLARATION = "additional_tools";

function isToolDeclaration(item: unknown): boolean {
  return isRecord(item) && item["type"] === TOOL_DECLARATION;
}

/** How many items at the head of `input` declare tools. */
function leadingToolDeclarations(input: readonly unknown[]): number {
  let n = 0;
  while (n < input.length && isToolDeclaration(input[n])) n += 1;
  return n;
}

/** The one text of a message item, or undefined when it holds anything else. */
function onlyText(item: unknown): string | undefined {
  const content = isRecord(item) ? item["content"] : null;
  if (!Array.isArray(content) || content.length !== 1 || !isRecord(content[0])) return undefined;
  const text = content[0]["text"];
  return typeof text === "string" ? text : undefined;
}

/**
 * Short hashes of the parts that make up a request's cacheable prefix, in
 * request order: never their content. `reasoning` is its own part: the
 * provider keeps a cache per thinking level, so a difference in it alone is a
 * cold lens and is named as such. The cache key is left out, since it names
 * the group and says nothing of what was sent. `input` holds one hash per
 * input item, through the pack when the request carries it (`packAt`) and
 * through the message that closes the pack when one follows it, else the
 * first three.
 */
export interface PrefixDigest {
  other: string;
  reasoning: string;
  instructions: string;
  tools: string;
  input: string[];
  /** Where the pack is in the input; -1 when the request does not carry it. */
  packAt: number;
  /** How many tool declarations the input holds after the pack. The backend
   * shares nothing between two requests whose declarations come after the
   * point where they part, the part they do share included (measured), so
   * anything but 0 here is a cold lens. */
  toolsAfterPack: number;
}

const digestOf = (v: unknown): string =>
  createHash("sha256")
    .update(JSON.stringify(v ?? null))
    .digest("hex")
    .slice(0, 10);

/** The parts of a request a digest sets apart from `other`. */
const DIGEST_OWN_PARTS: readonly string[] = [
  "instructions",
  "input",
  "tools",
  "reasoning",
  "prompt_cache_key",
];

/** The digest of `payload`; `pack` is the round's pack text when the request
 * should carry it. Undefined for a payload that is not an object. */
export function prefixDigest(payload: unknown, pack?: string): PrefixDigest | undefined {
  if (!isRecord(payload)) return undefined;
  const input = Array.isArray(payload["input"]) ? (payload["input"] as unknown[]) : [];
  const rest = Object.fromEntries(
    Object.entries(payload).filter(([k]) => !DIGEST_OWN_PARTS.includes(k)),
  );
  const packAt = pack === undefined ? -1 : input.findIndex((item) => onlyText(item) === pack);
  // The shared prefix runs through the pack, and through the message that
  // closes it where the request carries one right after.
  const closed = packAt >= 0 && onlyText(input[packAt + 1]) === PACK_CLOSING;
  const shared = packAt >= 0 ? packAt + (closed ? 2 : 1) : 3;
  return {
    other: digestOf(rest),
    reasoning: digestOf(payload["reasoning"]),
    instructions: digestOf(payload["instructions"]),
    tools: digestOf(payload["tools"]),
    input: input.slice(0, shared).map(digestOf),
    packAt,
    toolsAfterPack: packAt < 0 ? 0 : input.slice(packAt + 1).filter(isToolDeclaration).length,
  };
}

/** One line for a ledger or a log: hashes only. */
export function renderPrefixDigest(d: PrefixDigest): string {
  return [
    `other=${d.other}`,
    `reasoning=${d.reasoning}`,
    `instructions=${d.instructions}`,
    `tools=${d.tools}`,
    ...d.input.map((h, i) => `input${i}=${h}`),
    `pack_at=${d.packAt}`,
    `tools_after_pack=${d.toolsAfterPack}`,
  ].join(" ");
}

/**
 * The first part in which a lens request does not extend its group's warm-up,
 * or undefined when it does: the warm-up's request up to the end of the pack
 * (and of its closing message) is what the lens must repeat, at the warm-up's
 * thinking level, and neither may declare a tool after the pack. A request
 * that carries no pack differs in `pack`.
 */
export function prefixDifference(warmup: PrefixDigest, lens: PrefixDigest): string | undefined {
  if (warmup.other !== lens.other) return "other";
  if (warmup.reasoning !== lens.reasoning) return "reasoning";
  if (warmup.instructions !== lens.instructions) return "instructions";
  if (warmup.tools !== lens.tools) return "tools";
  if (warmup.packAt < 0 || lens.packAt < 0) return "pack";
  // Every item the warm-up shares: through the pack, and its closing message.
  for (let i = 0; i < warmup.input.length; i++)
    if (warmup.input[i] !== lens.input[i]) return `input${i}`;
  if (warmup.toolsAfterPack > 0 || lens.toolsAfterPack > 0) return "tool-declarations";
  return undefined;
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
  if (!isRecord(payload)) return undefined;
  const p = payload;
  const instructions = p["instructions"];
  const held = p["input"];
  const body = appended.trim();
  if (typeof instructions !== "string" || !Array.isArray(held) || !pack.trim()) return undefined;
  const input = held as unknown[];
  // pi's tool declarations stay where pi put them, ahead of the pack: in the
  // same place in a warm-up and in a lens, or the two share no prefix.
  const lead = leadingToolDeclarations(input);
  const head = input.slice(0, lead);
  const tail = input.slice(lead);
  // A group's WARM-UP (no lens text): only the pack goes in, ahead of its
  // prompt, which is the closing message. Its request is then exactly the
  // prefix every lens request of the group extends.
  if (!body) return { ...p, input: [...head, textMessage("user", pack), ...tail] };
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
    input: [
      ...head,
      textMessage("user", pack),
      textMessage("user", PACK_CLOSING),
      textMessage("developer", body),
      ...tail,
    ],
  };
}

/** The payload with `prompt_cache_key` set to `cacheKey`, or undefined when it
 * carries no string key or already has this one. */
function withCacheKey(payload: unknown, cacheKey: string): Record<string, unknown> | undefined {
  if (!isRecord(payload)) return undefined;
  const held = payload["prompt_cache_key"];
  return typeof held === "string" && held !== cacheKey
    ? { ...payload, prompt_cache_key: cacheKey }
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
  /** Told the digest of the session's first request, as it is sent. */
  onFirstRequest?: (digest: PrefixDigest) => void;
}

/** The extension that puts the pack first and pins the cache key. */
export function leafCache(options: LeafCacheOptions): ExtensionFactory {
  return (pi) => {
    if (!options.pack.trim()) return;
    let warned = false;
    let first = true;
    pi.on("before_provider_request", (event) => {
      const packed = packFirstPayload(event.payload, options.body ?? "", options.pack);
      if (packed === undefined && !warned) {
        warned = true;
        options.onUnexpected?.();
      }
      const sent = withCacheKey(packed ?? event.payload, options.cacheKey) ?? packed;
      if (first) {
        first = false;
        const digest = prefixDigest(sent ?? event.payload, options.pack);
        if (digest !== undefined) options.onFirstRequest?.(digest);
      }
      return sent;
    });
  };
}
