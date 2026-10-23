// Memory for `qcr review`: when an OpenViking memory is set up for this
// install and answers, the review prompt is seeded from it exactly as the
// daemon seeds a round (assembleRoundMemory: the pinned head plus one budgeted
// context block). Memory is a seasoning, never a precondition: not set up,
// unreachable, slow or throwing, the review runs without it and says so once.
import { join } from "node:path";
import { loadConfig, openVikingBaseUrl, type Config } from "./config.js";
import {
  MEMORY_LESS,
  assembleRoundMemory,
  describeGaps,
  roundContextQuery,
  type ContextAssembler,
  type ContextQueryFile,
  type RoundMemory,
} from "./memory/context.js";
import { OV_REVIEWER_KEY_SECRET } from "./memory/ovsession.js";
import { OpenVikingClient, keyFromFile } from "./openviking/client.js";
import { openVikingContextAssembler } from "./openviking/context.js";
import { openVikingStore } from "./openviking/store.js";

/** How long a review waits on memory before it goes without. Far shorter than
 * the daemon's seed budget: a person is watching the terminal. */
export const REVIEW_MEMORY_TIMEOUT_MS = 4000;

export interface ReviewMemorySource {
  /** Null: memory is not set up on this install. */
  assembler: ContextAssembler | null;
  timeoutMs?: number;
  maxTokens?: number;
}

export interface ReviewMemory {
  memory: RoundMemory;
  /** The prompt carries something from memory. */
  used: boolean;
  /** The one line saying the review ran without (all of) memory; null when it
   * answered whole. */
  notice: string | null;
}

/** The real memory of this install, or null when it is switched off or has no
 * reviewer key on disk. Constructing it touches no network. */
export function openReviewMemory(cfg: Config): ReviewMemorySource | null {
  if (!cfg.openviking.enabled) return null;
  const apiKey = keyFromFile(join(cfg.github.secrets_dir, OV_REVIEWER_KEY_SECRET));
  if (apiKey() === null) return null;
  const timeoutMs = Math.min(REVIEW_MEMORY_TIMEOUT_MS, cfg.memory.context_timeout_ms);
  const client = new OpenVikingClient({
    baseUrl: openVikingBaseUrl(cfg.openviking),
    user: cfg.openviking.user,
    account: cfg.openviking.account,
    timeoutMs: Math.min(cfg.openviking.request_timeout_ms, timeoutMs),
    apiKey,
  });
  const store = openVikingStore(client, {
    defaultCategory: cfg.openviking.default_category,
    cacheTtlMs: cfg.openviking.read_cache_ttl_ms,
  });
  return {
    assembler: openVikingContextAssembler({
      client,
      store,
      quotas: cfg.memory.context_quotas,
      searchTimeoutMs: Math.min(cfg.openviking.search_timeout_ms, timeoutMs),
    }),
    timeoutMs,
    maxTokens: cfg.memory.context_tokens,
  };
}

/** `openReviewMemory` for the install config at `path`: the memory sections
 * belong to the whole file, not to the review's own (src/reviewconfig.ts),
 * so the file is read whole, as the daemon reads it. */
export function openReviewMemoryAt(path: string): ReviewMemorySource | null {
  return openReviewMemory(loadConfig(path));
}

/** Seed one review from memory. Total: it never throws and never takes longer
 * than the source's timeout (plus a small grace). */
export async function seedReviewMemory(
  source: ReviewMemorySource | null | undefined,
  input: { title: string; files: readonly ContextQueryFile[] },
  log?: (line: string) => void,
): Promise<ReviewMemory> {
  if (!source?.assembler)
    return {
      memory: MEMORY_LESS,
      used: false,
      notice: "memory: not set up on this install — reviewing without it",
    };
  const timeoutMs = source.timeoutMs ?? REVIEW_MEMORY_TIMEOUT_MS;
  const without = (why: string): ReviewMemory => ({
    memory: MEMORY_LESS,
    used: false,
    notice: `memory: unavailable (${why}) — reviewing without it`,
  });
  let timer: NodeJS.Timeout | undefined;
  try {
    const query = roundContextQuery(input);
    const seeded = assembleRoundMemory(source.assembler, query, {
      timeoutMs,
      ...(source.maxTokens !== undefined ? { maxTokens: source.maxTokens } : {}),
      ...(log ? { log } : {}),
    });
    // assembleRoundMemory is deadline-guarded already; this is the belt.
    const hard = new Promise<null>((res) => {
      timer = setTimeout(() => res(null), timeoutMs + 500);
    });
    const mem = await Promise.race([seeded, hard]);
    if (mem === null) return without(`no answer in ${timeoutMs} ms`);
    const used = mem.head.length > 0 || mem.block.length > 0;
    if (mem.degraded)
      return {
        memory: mem,
        used,
        notice: `memory: ${used ? "partly " : ""}unavailable (${describeGaps(mem)}) — reviewing ${used ? "with what answered" : "without it"}`,
      };
    return { memory: mem, used, notice: null };
  } catch (err) {
    return without(String(err).slice(0, 120));
  } finally {
    if (timer) clearTimeout(timer);
  }
}
