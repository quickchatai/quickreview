/** A value named in a diagnostic: bounded, quoted and escaped. */
export function describeValue(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value.slice(0, 40));
  if (
    value === null ||
    value === undefined ||
    typeof value === "number" ||
    typeof value === "boolean"
  )
    return String(value);
  return Array.isArray(value)
    ? "an array"
    : `a${typeof value === "object" ? "n" : ""} ${typeof value}`;
}
