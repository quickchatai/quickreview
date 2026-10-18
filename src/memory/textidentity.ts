import { createHash } from "node:crypto";

/** Stable words identity. Callers strip their own provenance/header fields
 * first; pin placement and whitespace do not change the entry's words. */
export function memoryTextKey(text: string): string {
  const normalized = text.replace(/(^|\s)#pinned(?=\s|$)/g, "$1").replace(/\s+/g, " ").trim();
  return `sha1:${createHash("sha1").update(normalized, "utf8").digest("hex").slice(0, 16)}`;
}
