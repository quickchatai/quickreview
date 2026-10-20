#!/usr/bin/env node
// Which VERIFY-ON-PIN assumptions have live evidence in a state/log extract?
//
// D29: a tag is cleared by production evidence only. scripts/pin-evidence-map.json
// maps every tag group to the signal that would prove it; this reads an extract
// and reports, per group, whether a line matching its signal exists. It removes
// no tag and edits nothing.
//
//   node scripts/pin-evidence.mjs <file|dir>... [--json] [--require-all]
//
// An extract is any mix of files (a directory is walked): LiveEvent .jsonl under
// state/live, pi session .jsonl, scan transcripts, daemon or worker .log text.
// A line that parses as a JSON object is tried against the `jsonl` signals;
// every line is tried against the `log` signals. Exit 0 always, except with
// --require-all, which exits 1 while any group has no evidence (gaps included).
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/** Value at a dotted path; numeric segments index arrays. */
export function valueAt(obj, path) {
  let v = obj;
  for (const seg of path.split(".")) {
    if (v === null || typeof v !== "object") return undefined;
    v = v[seg];
  }
  return v;
}

function clauseHolds(obj, c) {
  const v = valueAt(obj, c.path);
  if ("equals" in c) return v === c.equals;
  if ("gt" in c) return typeof v === "number" && v > c.gt;
  if ("matches" in c) return typeof v === "string" && new RegExp(c.matches).test(v);
  if ("exists" in c) return (v !== undefined) === c.exists;
  return false;
}

export const matchesJsonl = (obj, signal) => signal.where.every((c) => clauseHolds(obj, c));

function filesUnder(p) {
  if (!statSync(p).isDirectory()) return [p];
  return readdirSync(p)
    .sort()
    .flatMap((n) => filesUnder(join(p, n)));
}

/** Per entry id: { entry, status: "live" | "none" | "gap", hits, first }. */
export function evaluate(map, lines) {
  const out = [];
  for (const entry of map.entries) {
    const s = entry.signal;
    if (s.kind === "gap") {
      out.push({ id: entry.id, status: "gap", hits: 0, needs: s.needs });
      continue;
    }
    let hits = 0;
    let first;
    const re = s.kind === "log" ? new RegExp(s.pattern) : undefined;
    for (const { text, json, where } of lines) {
      const hit = re ? re.test(text) : json !== undefined && matchesJsonl(json, s);
      if (hit) {
        hits += 1;
        first ??= where;
      }
    }
    out.push({ id: entry.id, status: hits > 0 ? "live" : "none", hits, first });
  }
  return out;
}

export function readLines(paths) {
  const lines = [];
  for (const p of paths.flatMap(filesUnder)) {
    const rows = readFileSync(p, "utf8").split("\n");
    rows.forEach((text, i) => {
      if (!text) return;
      let json;
      if (text.startsWith("{")) {
        try {
          const v = JSON.parse(text);
          if (v && typeof v === "object" && !Array.isArray(v)) json = v;
        } catch {
          /* a text line that begins with a brace */
        }
      }
      lines.push({ text, json, where: `${p}:${i + 1}` });
    });
  }
  return lines;
}

export function loadMap() {
  return JSON.parse(readFileSync(join(here, "pin-evidence-map.json"), "utf8"));
}

function main(argv) {
  const args = argv.filter((a) => !a.startsWith("--"));
  const asJson = argv.includes("--json");
  const requireAll = argv.includes("--require-all");
  if (args.length === 0) {
    console.error("usage: pin-evidence.mjs <file|dir>... [--json] [--require-all]");
    return 2;
  }
  const map = loadMap();
  const results = evaluate(map, readLines(args));
  if (asJson) console.log(JSON.stringify(results, null, 2));
  else {
    for (const r of results) {
      const detail =
        r.status === "live"
          ? `${r.hits} line(s), first ${r.first}`
          : r.status === "gap"
            ? r.needs
            : "";
      console.log(`${r.status.padEnd(5)} ${r.id}${detail ? `  ${detail}` : ""}`);
    }
    const live = results.filter((r) => r.status === "live").length;
    console.log(`${live}/${results.length} groups have live evidence (pi ${map.pi})`);
  }
  return requireAll && results.some((r) => r.status !== "live") ? 1 : 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(main(process.argv.slice(2)));
