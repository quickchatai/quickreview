// The OpenViking runtime: the server the daemon supervises inside
// the container, on loopback :1933, plus its health gate and heartbeat block.
// Nothing here is on a review round's critical path — see supervisor.ts.
export { probeHealth, type FetchLike, type ProbeOptions } from "./health.js";
export { ProcSampler, parseProcStat, type ProcStat, type ProcSamplerDeps } from "./proc.js";
export {
  OpenVikingSupervisor,
  type Schedule,
  type SpawnFn,
  type SupervisedChild,
  type SupervisorDeps,
} from "./supervisor.js";
export type {
  Embedder,
  LocalEmbedderStatus,
  OpenVikingHealth,
  OpenVikingStatus,
  ProcSample,
  ReembedJournalStatus,
  ReembedNamespace,
  ReembedStatus,
} from "./types.js";
// The local English embedder (S4): the loopback service the server
// embeds through, supervised beside it.
export {
  EMBEDDER_FAST_POLL_MS,
  EMBEDDER_GATE_MAX_WAIT_MS,
  LocalEmbedderSupervisor,
  localEmbedderArgv,
  localEmbedderOffReason,
  localEmbedderSpec,
  memoryServing,
  type LocalEmbedderDeps,
  type LocalEmbedderSpec,
} from "./embedder.js";
// The embedder migration's daemon half: drives the script's
// `resume` once /ready passes and folds the journal into the heartbeat.
export {
  REEMBED_POLL_MS,
  REEMBED_RETRY_MS,
  ReembedDriver,
  loadReembedModule,
  reembedNamespaces,
  type OperatorReembedResult,
  type ReembedDriverDeps,
  type ReembedFetch,
  type ReembedModule,
  type ReindexOutcome,
} from "./reembed.js";

// The memory engine proper: the HTTP client, the `MemoryStore`
// implementation over it, and the round path's `ContextAssembler`. Writes go
// through `content/batch-write` exclusively — there is no `content/write`
// wrapper anywhere below this barrel, by design.
export {
  DISABLED_MEMORY_POLICY,
  OpenVikingClient,
  QUOTA_CATEGORIES,
  batchWriteLanded,
  buildContextSearchBody,
  isAuthFailure,
  keyFromFile,
  ovFailed,
  type BatchWriteOperation,
  type BatchWritePrecondition,
  type BatchWriteRequest,
  type BatchWriteResult,
  type ContextSearchEntry,
  type ContextSearchOptions,
  type ContextSearchResult,
  type HttpFetch,
  type HttpResponse,
  type KeyFileSource,
  type KeySource,
  type OpenVikingClientOptions,
  type OvDirEntry,
  type OvGap,
  type OvFailure,
  type OvOutcome,
  type OvRequestRecord,
  type OvSessionResult,
  type TimeField,
} from "./client.js";
export {
  DEFAULT_CATEGORY,
  MANUAL_TAG,
  OpenVikingStore,
  PINNED_TAG,
  RETIRED_TAG,
  entryFrom,
  openVikingStore,
  renderEntryBody,
  sha256Prefixed,
  stampOf,
  tagsOf,
  tsFromModTime,
  tsFromName,
  validEntryId,
  withTag,
  withoutTag,
  type MemorySweep,
  type OpenVikingStoreOptions,
} from "./store.js";
export {
  OpenVikingContextAssembler,
  openVikingContextAssembler,
  type OpenVikingContextOptions,
} from "./context.js";
// The AUTHENTICATED probe and the boot provisioning report (S1) —
// what the memory health monitor (src/memory/health.ts) is fed from.
export {
  classifyProbe,
  credentialProbe,
  probeKeyFrom,
  type CredentialProbeOptions,
  type ProbeKey,
} from "./probe.js";
export { provisionReportPath, provisionWake, readProvisionReport } from "./provisionreport.js";
