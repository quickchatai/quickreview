/** The daemon supplies QCR_PR; absent or invalid identity never names a PR. */
export function parsePrIdentity(raw: string | undefined): number | undefined {
  const trimmed = raw?.trim();
  if (!trimmed || !/^\d+$/.test(trimmed)) return undefined;
  const pr = Number(trimmed);
  return Number.isSafeInteger(pr) && pr > 0 ? pr : undefined;
}
