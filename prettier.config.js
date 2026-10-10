// Prettier configuration for QuickReview.
//
// Every value below was measured against the tree as it stood before any
// formatter ran, not chosen from habit. The rule was: pick the setting that
// already describes what this codebase does, so the one-time reformat touches
// as little as possible and nobody has to relearn how to write here.
//
//   quotes        9,587 double-quoted string literals vs 473 single-quoted,
//                 and 116 of 116 relative imports written `from "./x.js"`.
//                 -> singleQuote: false (Prettier's default; not restated).
//   semicolons    21,405 statement lines end in `;`. -> semi: true (default).
//   indentation   17,677 two-space continuation lines, zero tab-indented.
//                 -> tabWidth 2, useTabs false (defaults).
//   trailing      7,201 lines already end in a trailing comma inside a
//   commas        multi-line literal or argument list. -> "all" (default in
//                 Prettier 3; not restated).
//   arrow parens  1,013 single-argument arrows written `(x) =>` vs 168 bare.
//                 -> arrowParens: "always" (default).
//
// So the codebase was already writing Prettier's defaults everywhere the
// defaults are opinionated, and the only value worth stating is the width.
//
// printWidth: measured across the 376 non-vendored .ts/.mjs files, the number
// of lines the reformat touches falls monotonically as the width grows:
//
//     80 -> 82,943    100 -> 46,041    120 -> 24,896    160 -> 13,766
//
// so "fewest lines changed" on its own has no minimum — it would pick an
// unbounded width. (Prettier only ever splits this tree; across every width
// tried it joined fewer than 600 lines in total, because it preserves an
// object literal that was already expanded. There is no natural crossover
// point to read off.) The tie is broken by what the code itself measures:
//
//   - comment prose is wrapped at ~76-79 columns throughout — this repo is
//     written as an 80-column document;
//   - code lines (comments and blanks excluded, 48,504 of them) run
//     p50 32, p75 58, p90 90, p95 110, p99 141.
//
// 100 is the narrowest round width that leaves ~90% of existing code lines
// unaffected by the width constraint while keeping code within sight of the
// 80-column prose it sits next to. 80 would fight that p90 of 90 and cost
// nearly double the churn; 120+ buys less churn only by drifting further from
// the document the comments are written as.
export default {
  printWidth: 100,
};
