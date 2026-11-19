// leaf-cache, the pack-first payload rewrite and the SDK lens's extension that
// applies it.
//
// The rewrite takes the lens body out of the system prompt pi built (its
// `<addendum>` block) and lays the request out so that everything up to the
// end of the round's context pack is the same in a cache group's warm-up and
// in every lens of the group: the prefix each lens request extends, and so
// reads from the provider's cache (docs/prompt-caching.md). It builds the
// request of two API families, told apart by the request's own shape:
//
//   - The Responses request (`instructions`, `input`): pi's tool declarations
//     where pi put them (the head of the input), then the pack (user role,
//     fenced data), then the lens body as a developer message, then the task.
//     The tool declarations stay ahead of the pack because the backend shares
//     a prefix between two requests only as far as their tool declarations sit
//     in the same place: with the declarations after the pack in a warm-up and
//     after the lens body in a lens, a lens read nothing of the warm-up from
//     cache (measured: 0 of ~36k tokens; with them at the head, 33k of 36k).
//
//   - The Messages request (`system`, `messages`): the system prompt without
//     the lens body; the first user message opening with the pack, as a block
//     of its own that ends on a cache breakpoint; then the lens body as a
//     system message, right after that user message. The lens body keeps the
//     operator's voice there, and the pack, which holds text a pull request
//     wrote, stays in the user's (measured: a lens read 50,751 of ~54,400
//     tokens of its warm-up; without the pack in the prompt each lens wrote
//     the pack into a cache of its own, through a tool).
//
// leafCache({ pack, cacheKey }) rewrites each request pack-first, and on a payload that carries
// a `prompt_cache_key` sets it to the group's key. Under the shared session id
// of a cache group (docs/probes/p4.6-codex-cache-routing.md) the key already
// equals that id, so the second edit is a belt for a pi that derives the key
// another way, not what routes the cache. Fail-open, always: a payload that is
// not the expected shape goes out unchanged, and a throw inside the handler is
// pi's to contain (it reports it as an extension error), never the request's.
//
// The rewrite is an optimisation for the API families it builds a request
// for, PACK_FIRST_APIS, so the runner attaches this extension only to a cache
// group whose model the pack applies to (`packFirstApplies`, asked by
// runlens.ts). A lens on any other model gets its own request untouched and
// reads the pack file its task names.
//
// VERIFY-ON-PIN (pi 1.3.0, re-read at 1.4.0): `before_provider_request` may return a replacement
// payload. The codex payload carries `instructions` (string), `input` (an array
// of `{ role, content: [{ type: "input_text", text }] }`) and `prompt_cache_key`;
// at 1.4.0 its tools are declared in the input, by `{ type: "additional_tools" }`
// items starting at its head, and no longer in a top-level `tools` field. The
// Messages payload carries `system` (an array of `{ type: "text", text }`
// blocks, the last with the request's `cache_control`) and `messages`, whose
// first is the user's turn. tests/pi-canary/canary-16-pack-first-prefix.test.ts
// holds the rewrite to pi's real request for both.
import { createHash } from "node:crypto";
import type { KnownApi } from "@earendil-works/pi-ai";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

const ADDENDUM_OPEN = "<addendum>";
const ADDENDUM_CLOSE = "</addendum>";

// VERIFY-ON-PIN (pi 1.4.0): pi-ai's own names (`KnownApi`, a model's `api`)
// for the APIs whose request the rewrite builds. The annotation holds each
// name to that union, so a pi that renames or drops one stops the build.
//   - `openai-codex-responses` carries the system prompt as a string in
//     `instructions`. pi's other Responses APIs (`openai-responses`,
//     `azure-openai-responses`) send it as the first input message: the
//     rewrite would leave their request as it is, so they are not in the
//     family, and a group on one gets no warm-up to wait for.
//   - `anthropic-messages` carries it as the blocks of `system`.
// An API is added here by hand, once pi builds its request in a shape the
// rewrite reads (a test holds that) and a lens was measured to read its
// warm-up there.
const PACK_FIRST_FAMILY: readonly KnownApi[] = ["openai-codex-responses", "anthropic-messages"];

/** pi's name for the Messages API, whose pack needs more than the API: see
 * `packFirstApplies`. */
const MESSAGES_API: KnownApi = "anthropic-messages";

/**
 * The API families the pack-first rewrite is built for, as pi's API names:
 * what a model's `api` says, never a provider and never a model. A cache group
 * is packed (warm-up, wait, rewrite) only when its model's API is in this set
 * and the model takes the request the rewrite builds (`packFirstApplies`).
 * Inside the family the rewrite is still fail-open: a request that is not a
 * shape it expects goes out unchanged, with one warning line.
 *
 * The measured cost estimate (measured.ts `MEASURED.apis`) is true for APIs
 * of this set only, since the pack is what its token mix rests on; it was
 * measured on fewer than the pack applies to, and a test holds its list
 * inside this one.
 */
export const PACK_FIRST_APIS: ReadonlySet<string> = new Set<string>(PACK_FIRST_FAMILY);

/** Whether `api` is one the rewrite builds a request for. An API the host
 * could not name is not in the family. */
export function isPackFirstApi(api: string | undefined): boolean {
  return api !== undefined && PACK_FIRST_APIS.has(api);
}

/** What the runner knows of a model before a session exists: pi's own model
 * object, as far as the pack reads it. */
export interface PackModel {
  api?: string;
  compat?: unknown;
}

/**
 * Whether a cache group on `model` is packed. Its API must be in the family,
 * and on the Messages API the model must take a system message after the
 * first user message, which is where the lens body goes (pi's
 * `supportsMidConvoSystemMessages`): without it the body would have to stay
 * ahead of the pack, where it differs per lens, and no lens could read the
 * warm-up. A model the host could not name is not packed.
 */
export function packFirstApplies(model: PackModel | undefined): boolean {
  if (model === undefined || !isPackFirstApi(model.api)) return false;
  if (model.api !== MESSAGES_API) return true;
  const compat = model.compat;
  return (
    typeof compat === "object" &&
    compat !== null &&
    (compat as { supportsMidConvoSystemMessages?: unknown }).supportsMidConvoSystemMessages === true
  );
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

/** The conversation of a request: a Responses `input` or a Messages `messages`. */
function conversationOf(p: Record<string, unknown>): unknown[] {
  if (Array.isArray(p["input"])) return p["input"] as unknown[];
  if (Array.isArray(p["messages"])) return p["messages"] as unknown[];
  return [];
}

/** Where the pack is in `items`: the item that holds it and the block of that
 * item's content that is the pack's text, whole. */
function packPlace(items: readonly unknown[], pack: string): { item: number; block: number } {
  for (let item = 0; item < items.length; item++) {
    const content = isRecord(items[item]) ? (items[item] as { content?: unknown }).content : null;
    if (!Array.isArray(content)) continue;
    const block = content.findIndex((b) => isRecord(b) && b["text"] === pack);
    if (block >= 0) return { item, block };
  }
  return { item: -1, block: -1 };
}

/**
 * Short hashes of the parts that make up a request's cacheable prefix, in
 * request order: never their content. `reasoning` is its own part, because
 * the passes of one cache group may think at different levels and still share
 * a prefix; the cache key is left out, since it names the group and says
 * nothing of what was sent. `input` holds one hash per item of the
 * conversation, through the pack when the request carries it (`packAt`; the
 * item that holds the pack is hashed up to the pack's end), else the first
 * three. `instructions` is the system prompt, wherever the API puts it.
 */
export interface PrefixDigest {
  other: string;
  reasoning: string;
  instructions: string;
  tools: string;
  input: string[];
  /** Where the pack is in the conversation; -1 when the request does not carry it. */
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
  "system",
  "input",
  "messages",
  "tools",
  "reasoning",
  "prompt_cache_key",
];

/** The digest of `payload`; `pack` is the round's pack text when the request
 * should carry it. Undefined for a payload that is not an object. */
export function prefixDigest(payload: unknown, pack?: string): PrefixDigest | undefined {
  if (!isRecord(payload)) return undefined;
  const items = conversationOf(payload);
  const rest = Object.fromEntries(
    Object.entries(payload).filter(([k]) => !DIGEST_OWN_PARTS.includes(k)),
  );
  const place = pack === undefined ? { item: -1, block: -1 } : packPlace(items, pack);
  const through = items.slice(0, place.item >= 0 ? place.item + 1 : 3).map((item, i) => {
    if (i !== place.item) return item;
    // What follows the pack in its own item (a Messages request's task) is
    // not part of the shared prefix.
    const held = item as { content: unknown[] };
    return { ...held, content: held.content.slice(0, place.block + 1) };
  });
  return {
    other: digestOf(rest),
    reasoning: digestOf(payload["reasoning"]),
    instructions: digestOf(payload["instructions"] ?? payload["system"]),
    tools: digestOf(payload["tools"]),
    input: through.map(digestOf),
    packAt: place.item,
    toolsAfterPack:
      place.item < 0 ? 0 : items.slice(place.item + 1).filter(isToolDeclaration).length,
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
 * is what the lens must repeat, and neither may declare a tool after it. The
 * thinking level is not compared (see PrefixDigest). A request that carries
 * no pack differs in `pack`.
 */
export function prefixDifference(warmup: PrefixDigest, lens: PrefixDigest): string | undefined {
  if (warmup.other !== lens.other) return "other";
  if (warmup.instructions !== lens.instructions) return "instructions";
  if (warmup.tools !== lens.tools) return "tools";
  if (warmup.packAt < 0 || lens.packAt < 0) return "pack";
  for (let i = 0; i <= warmup.packAt; i++)
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
 * `prompt` without the lens body pi appended to it, or undefined when the
 * body is not there exactly once or nothing else is. The whole
 * `<addendum>…</addendum>` block goes when the body is all it holds.
 */
function withoutBody(prompt: string, body: string): string | undefined {
  const at = prompt.indexOf(body);
  if (at < 0 || prompt.indexOf(body, at + 1) >= 0) return undefined;
  let start = at;
  let end = at + body.length;
  const open = prompt.lastIndexOf(ADDENDUM_OPEN, at);
  const close = prompt.indexOf(ADDENDUM_CLOSE, end);
  if (
    open >= 0 &&
    close >= 0 &&
    prompt.slice(open + ADDENDUM_OPEN.length, at).trim() === "" &&
    prompt.slice(end, close).trim() === ""
  ) {
    start = open;
    end = close + ADDENDUM_CLOSE.length;
  }
  const before = prompt.slice(0, start).trimEnd();
  const after = prompt.slice(end).trim();
  if (!before) return undefined;
  return after ? `${before}\n\n${after}` : before;
}

/** The Responses request, pack-first. */
function packFirstResponses(
  p: Record<string, unknown>,
  instructions: string,
  input: unknown[],
  body: string,
  pack: string,
): Record<string, unknown> | undefined {
  // pi's tool declarations stay where pi put them, ahead of the pack: in the
  // same place in a warm-up and in a lens, or the two share no prefix.
  const lead = leadingToolDeclarations(input);
  const head = input.slice(0, lead);
  const tail = input.slice(lead);
  // A group's WARM-UP (no lens text): only the pack goes in, so its request
  // is exactly the prefix every lens request of the group extends.
  if (!body) return { ...p, input: [...head, textMessage("user", pack), ...tail] };
  const base = withoutBody(instructions, body);
  if (base === undefined) return undefined;
  return {
    ...p,
    instructions: base,
    input: [...head, textMessage("user", pack), textMessage("developer", body), ...tail],
  };
}

/** The most cache breakpoints one Messages request may carry. */
const MAX_CACHE_BREAKPOINTS = 4;

function hasBreakpoint(block: unknown): boolean {
  return isRecord(block) && isRecord(block["cache_control"]);
}

function breakpointsIn(blocks: unknown): number {
  return Array.isArray(blocks) ? blocks.filter(hasBreakpoint).length : 0;
}

/** The Messages request, pack-first. */
function packFirstMessages(
  p: Record<string, unknown>,
  system: unknown[],
  messages: unknown[],
  body: string,
  pack: string,
): Record<string, unknown> | undefined {
  const first = messages[0];
  if (!isRecord(first) || first["role"] !== "user") return undefined;
  const held = first["content"];
  const content: unknown[] | undefined =
    typeof held === "string"
      ? [{ type: "text", text: held }]
      : Array.isArray(held)
        ? (held as unknown[])
        : undefined;
  if (content === undefined) return undefined;
  // The pack ends on the breakpoint pi gave the system prompt (its lifetime
  // with it). A request pi marked nowhere is one with caching off: a pack in
  // it would be paid in full by every lens, so it goes out as it came.
  const marked = system.findLast(hasBreakpoint);
  if (!isRecord(marked)) return undefined;
  const packBlock = { type: "text", text: pack, cache_control: marked["cache_control"] };

  let nextSystem = system;
  if (body) {
    const textOf = (block: unknown): string =>
      isRecord(block) && typeof block["text"] === "string" ? block["text"] : "";
    const holders = system.flatMap((block, i) => (textOf(block).includes(body) ? [i] : []));
    const holder = holders[0];
    if (holders.length !== 1 || holder === undefined) return undefined;
    const base = withoutBody(textOf(system[holder]), body);
    if (base === undefined) return undefined;
    nextSystem = system.map((block, i) =>
      i === holder ? { ...(block as Record<string, unknown>), text: base } : block,
    );
  }
  // The pack's breakpoint is one more than pi counted. A request already at
  // the limit gives up the system prompt's earlier ones: its last covers them.
  const others =
    breakpointsIn(p["tools"]) +
    messages.reduce<number>((n, m) => n + (isRecord(m) ? breakpointsIn(m["content"]) : 0), 0);
  let spare = MAX_CACHE_BREAKPOINTS - 1 - others - breakpointsIn(nextSystem);
  if (spare < 0) {
    const last = nextSystem.findLastIndex(hasBreakpoint);
    nextSystem = nextSystem.map((block, i) => {
      if (spare >= 0 || i === last || !hasBreakpoint(block)) return block;
      spare += 1;
      const { cache_control: _dropped, ...kept } = block as Record<string, unknown>;
      return kept;
    });
  }
  if (spare < 0) return undefined;

  const packed = { ...first, content: [packBlock, ...content] };
  // A lens's body follows the first user message as a system message: after
  // the pack, in the operator's voice, in the same place on every turn.
  const lens = body ? [{ role: "system", content: body }] : [];
  return { ...p, system: nextSystem, messages: [packed, ...lens, ...messages.slice(1)] };
}

/**
 * The pack-first payload, or undefined to send the original. Pure.
 * `appended` is the lens body as pi appended it; `pack` the pack's text. The
 * request's shape says which API's it is.
 */
export function packFirstPayload(
  payload: unknown,
  appended: string,
  pack: string,
): Record<string, unknown> | undefined {
  if (!isRecord(payload) || !pack.trim()) return undefined;
  const body = appended.trim();
  const { instructions, input, system, messages } = payload;
  if (typeof instructions === "string" && Array.isArray(input))
    return packFirstResponses(payload, instructions, input as unknown[], body, pack);
  if (Array.isArray(system) && Array.isArray(messages))
    return packFirstMessages(payload, system as unknown[], messages as unknown[], body, pack);
  return undefined;
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
