// The three-way empty grammar: a list with nothing in it is one of three
// different facts, and a count is a
// claim. Every list on every surface renders one of these — never a bare
// "none", and never `(0)` for something nobody has read.
//
//   ▍SECTION (0)     none yet — <what would fill it>            empty
//   ▍SECTION (0)     none matching — <what clearing shows>      filtered-empty
//   ▍SECTION (—)     not read yet — <what would read it>        unknown, pending
//   ▍SECTION (—)     could not read — <why>                     unknown, failed
//
// `(—)` is the unknown count. This is the shared spelling, so the surfaces
// cannot each invent their own.
import { MUTED, RESET, WARN } from "./design.js";

export type Emptiness =
  | { kind: "none"; what: string }
  | { kind: "filtered"; what: string }
  | { kind: "unread"; how: string }
  | { kind: "unreadable"; why: string };

/** `(12)` for a count that was read; `(—)` for one that was not. */
export function countLabel(n: number | undefined): string {
  return n === undefined ? "(—)" : `(${n})`;
}

/** The one line an empty list shows, styled: muted for a real emptiness,
 * warning-coloured for a read that failed. */
export function emptyLine(e: Emptiness): string {
  switch (e.kind) {
    case "none":
      return `${MUTED}none yet — ${e.what}${RESET}`;
    case "filtered":
      return `${MUTED}none matching — ${e.what}${RESET}`;
    case "unread":
      return `${MUTED}not read yet — ${e.how}${RESET}`;
    case "unreadable":
      return `${WARN}could not read — ${e.why}${RESET}`;
  }
}
