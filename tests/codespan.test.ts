import { describe, expect, it } from "vitest";
import { codePath } from "@quickchatai/pi-quickreview/src/codespan.js";

/** CommonMark's code-span content rule: strip the fence, then one space from
 * each end when the content both starts and ends with one and is not all
 * spaces. Enough of a reader to check `codePath` reads back exactly. */
function readSpan(span: string): string {
  const fence = /^`+/.exec(span)![0];
  expect(span.endsWith(fence)).toBe(true);
  const inner = span.slice(fence.length, span.length - fence.length);
  return /^ [^]* $/.test(inner) && /[^ ]/.test(inner) ? inner.slice(1, -1) : inner;
}

describe("codePath", () => {
  it("reads back exactly for plain, backticked and space-edged names", () => {
    for (const path of [
      "src/a.ts",
      "a`b.ts",
      "`lead.ts",
      " foo.ts ",
      " lead.ts",
      "trail.ts ",
      "  ",
    ])
      expect(readSpan(codePath(path)), JSON.stringify(path)).toBe(path);
  });

  it("keeps a plain name a single-backtick span", () => {
    expect(codePath("src/a.ts")).toBe("`src/a.ts`");
    expect(codePath(" foo.ts ")).toBe("`  foo.ts  `");
  });
});
