/** Split an assignment tail into its value and its trailing `#` comment,
 * ignoring `#` inside quotes. Returns null when the tail cannot be split
 * confidently (an unterminated quote), so the caller leaves the line alone. */
export function splitTail(tail: string): { value: string; gap: string; comment: string } | null {
  let quote: string | null = null;
  for (let i = 0; i < tail.length; i++) {
    const ch = tail[i]!;
    if (quote) {
      if (ch === "\\" && quote.startsWith('"')) i++;
      else if (tail.startsWith(quote, i)) {
        i += quote.length - 1;
        quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = tail.startsWith(ch.repeat(3), i) ? ch.repeat(3) : ch;
      i += quote.length - 1;
      continue;
    }
    if (ch === "#") {
      const value = tail.slice(0, i);
      const trimmed = value.replace(/\s+$/, "");
      return { value: trimmed, gap: value.slice(trimmed.length), comment: tail.slice(i) };
    }
  }
  if (quote) return null;
  const trimmed = tail.replace(/\s+$/, "");
  return { value: trimmed, gap: "", comment: "" };
}

/** Resolve the known dotted table path of a config field in a parsed document. */
export function tomlValueAt(document: unknown, section: string, key: string): unknown {
  let table = document;
  for (const part of section === "" ? [] : section.split(".")) {
    if (typeof table !== "object" || table === null || Array.isArray(table)) return undefined;
    table = (table as Record<string, unknown>)[part];
  }
  return typeof table === "object" && table !== null && !Array.isArray(table)
    ? (table as Record<string, unknown>)[key]
    : undefined;
}
