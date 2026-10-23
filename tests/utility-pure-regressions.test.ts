import { expect, it } from "vitest";
import { globMatcher } from "@quickchatai/pi-quickreview/src/glob.js";
import { parseUnifiedDiff } from "@quickchatai/pi-quickreview/src/unifieddiff.js";
import { detectLoosenedAssertions } from "@quickchatai/pi-quickreview/src/loosenedtests.js";

it("recursive exclusions include legal line terminators in filenames and descendants", () => {
  for (const path of ["src/a\nb/x.ts", "src/a\rb/x.ts", "src/a\u2028b/x.ts"])
    expect(globMatcher(["src/**/x.ts"])(path)).toBe(true);
  expect(globMatcher(["src/**"])("src/a\nb.ts")).toBe(true);
  expect(globMatcher(["generated"])("generated/a\nb.ts")).toBe(true);
});
it("preserves quoted mode-only files in the replay changed-file list", () => {
  expect(
    parseUnifiedDiff('diff --git "a/a\\tb.py" "b/a\\tb.py"\nold mode 100644\nnew mode 100755\n'),
  ).toEqual([{ filename: "a\tb.py", status: "modified", additions: 0, deletions: 0 }]);
});
function detect(patch: string) {
  return detectLoosenedAssertions([
    { filename: "tests/test_x.py", additions: 2, deletions: 2, patch },
  ]);
}
it("an unchanged moved assertion cannot replace a different deleted assertion", () => {
  const hits = detect("@@ -1,2 +1,1 @@\n-assert a == 1\n-assert b == 2\n+assert a == 1\n");
  expect(hits).toContainEqual({ file: "tests/test_x.py", line: 2, kind: "assert-removed" });
});
it("a commented assertion does not consume another assertion's weakened replacement", () => {
  const hits = detect(
    "@@ -1,2 +1,2 @@\n-assert a == 1\n-assert b == 2\n+assert b >= 2\n+# assert a == 1\n",
  );
  expect(hits).toContainEqual({ file: "tests/test_x.py", line: 2, kind: "assert-commented" });
  expect(hits).toContainEqual({ file: "tests/test_x.py", line: 1, kind: "exact-to-bound" });
});
