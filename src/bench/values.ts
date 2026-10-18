// Shared scalar readings for benchmark adapters. Artifact traversal stays with each adapter.
export function finiteNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function integerOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value.trim())) return Number(value.trim());
  return null;
}

export function bridgeApiBase(url: string): string {
  return `${url.replace(/\/+$/, "")}/v1`;
}

/** Child usage accepts either a scalar cost or a total-bearing object. */
export function usageCost(value: unknown): number {
  return finiteNumber(typeof value === "object" && value !== null
    ? (value as { total?: unknown }).total : value);
}
