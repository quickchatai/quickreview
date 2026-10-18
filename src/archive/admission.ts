/** The JSON object shape shared by archive readers; schemas stay with callers. */
export const isObj = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
