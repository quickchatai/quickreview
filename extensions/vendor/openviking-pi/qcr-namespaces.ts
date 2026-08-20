// QCR FORK — file added by PATCH 5 (a second memory namespace). Not upstream.
//
// WHAT THIS SOLVES. Upstream builds ONE `OVClient` from ONE key, so a pi can
// only ever reach the user tree that key owns. The companion on the owner's PC
// holds TWO OpenViking USER keys — its own (`user/companion/`) and the
// reviewer's (`user/reviewer/`, the key the daemon and every review session
// hold) — because the ratified design is that the companion and the TUI can do
// EVERYTHING with memory, read and write, over every piece of it, while
// automated review sessions hold the reviewer key alone and stay confined
// server-side (docs/companion-memory-access.md).
//
// The second key was already delivered to the companion container as
// `OPENVIKING_REVIEWER_KEY` and proven usable; nothing consumed it. This file
// is the pure half of consuming it: which extra namespaces exist, and which
// namespace a given tool call is addressing. The clients themselves are built
// in `index.ts` and handed to `tools.ts` — pure logic lives here so
// `tests/openviking-fork.test.ts` can exercise it (`tools.ts` and `index.ts`
// cannot be imported from a test; they pull typebox and the pi packages).
//
// SHAPE BORROWED, NOT INVENTED. The TUI solved the same problem first
// (`src/tui/memory.ts`): one client per namespace, keys read by env
// name from the shared keys file, and every addressed operation prefixed with
// the namespace that owns it so a verb routes back to the right key. A
// namespace-prefixed address is the established convention; here the address
// the model already types is a `viking://user/<namespace>/…` URI, so the URI
// carries the prefix and an explicit `namespace` parameter settles the rest.
//
// THREE PROPERTIES THIS FILE IS RESPONSIBLE FOR:
//
//   1. A LEAF NEVER GETS A SECOND NAMESPACE. PATCH 2 stops all ambient work in
//      a pi-subagents leaf and PATCH 4 withholds the write tool there; a second
//      client must not become a way around either. `resolveExtraNamespaces`
//      returns [] for a leaf, `index.ts` does not even call it in the leaf
//      path, and `tools.ts` discards any namespaces handed to a leaf.
//   2. THE ROOT-KEY GUARD COVERS BOTH KEYS. Upstream's resolver ends its
//      fallback chain at the server's `root_api_key`, which our state-volume
//      symlink puts within reach. The second key goes through the SAME
//      `withoutRootKey` guard as the first — a new key must not reopen the hole
//      PATCH 0000 closed.
//   3. A REVIEW SESSION IS UNCHANGED. A PR session's own identity already IS
//      `reviewer` (`OPENVIKING_USER=reviewer`, key in a 0600 ovcli.conf, and
//      the daemon never puts `OPENVIKING_REVIEWER_KEY` in a session env), so a
//      namespace whose user equals our own is dropped rather than duplicated:
//      even if that variable ever appeared in a session, it would add nothing.
//      And with a single namespace, routing is a constant and the tools keep
//      the exact parameters and text they have today.
import { withoutRootKey } from "./config.js";

/** The extra namespace this fork knows how to build. */
export const REVIEWER_NAMESPACE = "reviewer";

/** Env name carrying the reviewer USER key. Spelled the same in
 * `src/tui/companion.ts` (`KEY_NAMES`), `src/tui/memory.ts` (`USER_KEY_ENV`)
 * and the keys file — do not invent a second spelling. */
export const REVIEWER_KEY_ENV = "OPENVIKING_REVIEWER_KEY";

/** Which OpenViking USER the reviewer key owns. Overridable only because the
 * user name is a deployment fact; the default is what the daemon uses. */
export const REVIEWER_USER_ENV = "OPENVIKING_REVIEWER_USER";

/** One extra namespace's credentials — never logged, never put on an argv. */
export interface NamespaceCredentials {
  /** How the model names it: `reviewer`. */
  name: string;
  /** `X-OpenViking-User` for that client. */
  user: string;
  apiKey: string;
}

export interface ResolveNamespaceOptions {
  /** True in a pi-subagents leaf — the answer is then always []. */
  leaf?: boolean;
  /** The root-key guard. Injectable for tests; production passes nothing and
   * gets `config.ts`'s, which reads the server's own ov.conf. */
  guardRootKey?: typeof withoutRootKey;
}

function trimmed(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** What the model calls the namespace this pi authenticates as. `own` only
 * when no `OPENVIKING_USER` was configured at all. */
export function ownNamespaceName(user: unknown): string {
  return trimmed(user).toLowerCase() || "own";
}

/**
 * The namespaces this process can reach BESIDES its own identity.
 *
 * Today that is at most one — `reviewer`, when `OPENVIKING_REVIEWER_KEY` is in
 * the environment. Its ABSENCE is a normal state, not an error: the process
 * then reaches its own tree only, exactly as before this patch.
 */
export function resolveExtraNamespaces(
  config: { user?: string },
  env: Record<string, string | undefined> = process.env,
  opts: ResolveNamespaceOptions = {},
): NamespaceCredentials[] {
  // (1) A leaf gets nothing ambient and no second key. See PATCH 2.
  if (opts.leaf === true) return [];

  const rawKey = trimmed(env[REVIEWER_KEY_ENV]);
  if (!rawKey) return [];

  // (2) The same guard the primary key goes through. If this IS the server's
  // root key it is dropped and the namespace simply does not exist — the fork
  // never authenticates as ROOT, by any route, including a new one.
  const guard = opts.guardRootKey ?? withoutRootKey;
  const guarded = guard({ apiKey: rawKey, hasApiKey: true }, env);
  if (!guarded.hasApiKey || !guarded.apiKey) return [];

  const user = trimmed(env[REVIEWER_USER_ENV]).toLowerCase() || REVIEWER_NAMESPACE;

  // (3) Never a second client for the tree we already are. This is what keeps
  // a review session (whose own user IS `reviewer`) structurally single-keyed.
  if (ownNamespaceName(config.user) === user) return [];

  return [{ name: REVIEWER_NAMESPACE, user, apiKey: guarded.apiKey }];
}

// ---- routing a tool call to a namespace -------------------------------------

export type NamespaceRoute =
  | { ok: true; namespace: string }
  | { ok: false; error: string };

/** The user tree a `viking://user/<space>/…` URI names, lowercased. `null`
 * for anything else — including the reserved-word form (`viking://user/
 * memories/…`) the client expands server-side, which names no namespace. */
export function namespaceOfUri(uri: unknown): string | null {
  const match = /^\s*viking:\/\/user\/([A-Za-z0-9._-]+)/i.exec(String(uri ?? ""));
  return match ? match[1]!.toLowerCase() : null;
}

/**
 * Which namespace a tool call is touching.
 *
 * `names[0]` is this pi's own identity and the default. Two ways to name
 * another one, and they must agree:
 *
 *   * `namespace: "reviewer"` — explicit, and what the tool schema advertises;
 *   * a `viking://user/reviewer/…` URI — implicit, because the address the
 *     model already types carries the namespace prefix.
 *
 * Disagreement is REFUSED rather than resolved by precedence: writing to the
 * wrong memory tree is silent, and a rule the model has to remember is exactly
 * the kind of thing it will get wrong at 3am.
 *
 * With ONE namespace this is a constant function that never fails — the
 * single-key case (every review session) keeps today's behaviour exactly.
 */
export function routeNamespace(
  params: { namespace?: unknown; uri?: unknown; scope?: unknown },
  names: readonly string[],
): NamespaceRoute {
  const known = names.map((n) => n.toLowerCase());
  const fallback = known[0] ?? "";
  if (known.length <= 1) return { ok: true, namespace: fallback };

  const explicit = trimmed(params.namespace).toLowerCase();
  if (explicit && !known.includes(explicit)) {
    return {
      ok: false,
      error:
        `Unknown memory namespace "${explicit}". This pi reaches: ${known.join(", ")}.` +
        (explicit === REVIEWER_NAMESPACE ? ` Reviewer memory needs ${REVIEWER_KEY_ENV} in this process's environment.` : ""),
    };
  }

  const implied = namespaceOfUri(params.uri) ?? namespaceOfUri(params.scope);
  if (implied && known.includes(implied)) {
    if (explicit && explicit !== implied) {
      return {
        ok: false,
        error:
          `That URI is in the ${implied} memory tree but namespace says "${explicit}". ` +
          "Pass one or the other, not two different answers.",
      };
    }
    return { ok: true, namespace: implied };
  }

  return { ok: true, namespace: explicit || fallback };
}

/** The sentence appended to every namespace-aware tool description. Written
 * once so the four tools cannot drift apart on what they tell the model. */
export function namespaceNote(names: readonly string[]): string {
  if (names.length <= 1) return "";
  const own = names[0]!;
  const others = names.slice(1);
  return (
    ` MEMORY NAMESPACES: this pi reaches ${names.join(" and ")} — ${own} is your own memory and the default, ` +
    `${others.join(" and ")} is the review system's. Pick one with \`namespace\`, or address a ` +
    "viking://user/<namespace>/… URI (the two must agree); every answer is prefixed with the tree it came from."
  );
}
