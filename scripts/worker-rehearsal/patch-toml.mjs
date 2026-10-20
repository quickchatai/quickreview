#!/usr/bin/env node
// Set keys in a config.toml without touching its comments: patch-toml.mjs <file> <section>.<key>=<toml value> ...
// A key that exists in the section is replaced in place (its trailing comment dropped); one
// that does not is added at the end of the section. A section that does not exist is appended.
import { readFileSync, writeFileSync } from "node:fs";

const [file, ...edits] = process.argv.slice(2);
let lines = readFileSync(file, "utf8").split("\n");
for (const e of edits) {
  const eq = e.indexOf("=");
  const path = e.slice(0, eq);
  const value = e.slice(eq + 1);
  const dot = path.lastIndexOf(".");
  const section = dot < 0 ? "" : path.slice(0, dot);
  const key = path.slice(dot + 1);
  let inSection = section === "";
  let sectionEnd = -1;
  let hit = -1;
  for (let i = 0; i < lines.length; i++) {
    const h = /^\[([^\]]+)\]\s*(#.*)?$/.exec(lines[i]);
    if (h) {
      if (inSection && section !== "") {
        sectionEnd = i;
        break;
      }
      inSection = h[1] === section;
      continue;
    }
    if (
      inSection &&
      new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*=`).test(lines[i])
    ) {
      hit = i;
      break;
    }
  }
  if (hit >= 0) lines[hit] = `${key} = ${value}`;
  else if (section === "") lines.splice(0, 0, `${key} = ${value}`);
  else {
    const start = lines.findIndex((l) =>
      new RegExp(`^\\[${section.replace(/\./g, "\\.")}\\]`).test(l),
    );
    if (start < 0) lines.push("", `[${section}]`, `${key} = ${value}`);
    else {
      // after the section's last line that has content, not after the blank line before the next one
      let at = sectionEnd >= 0 ? sectionEnd : lines.length;
      while (at > start + 1 && lines[at - 1].trim() === "") at--;
      lines.splice(at, 0, `${key} = ${value}`);
    }
  }
}
writeFileSync(file, lines.join("\n"));
