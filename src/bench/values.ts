// Shared scalar readings for benchmark adapters. Artifact traversal stays with each adapter.
// finiteNumber and usageCost are core (src/pricing.ts): a round prices itself.
export { finiteNumber, usageCost } from "../pricing.js";

export function integerOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value.trim())) return Number(value.trim());
  return null;
}

export function bridgeApiBase(url: string): string {
  return `${url.replace(/\/+$/, "")}/v1`;
}
