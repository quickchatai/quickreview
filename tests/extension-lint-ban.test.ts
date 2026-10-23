// An extension reads no ambient process state. The ban in eslint.config.js
// (`extensionBan`) is exercised on fixture text, with the path each fixture
// would have in the tree: a violation under extensions/ fails, the same text
// under extensions/cli/ (the env shims) or as inline-bash.ts does not.
import { describe, expect, it } from "vitest";
import { ESLint } from "eslint";
import tseslint from "typescript-eslint";
import { join } from "node:path";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore -- the config is plain JS
import { extensionBan } from "../eslint.config.js";

const ROOT = join(import.meta.dirname, "..");

// Syntax only: the ban is a syntactic rule, so no type information is needed.
const eslint = new ESLint({
  cwd: ROOT,
  overrideConfigFile: true,
  overrideConfig: [
    { files: ["**/*.ts"], languageOptions: { parser: tseslint.parser } },
    extensionBan as never,
  ],
});

async function rulesHit(text: string, path: string): Promise<string[]> {
  const [res] = await eslint.lintText(text, { filePath: join(ROOT, path) });
  return (res?.messages ?? []).map((m) => m.ruleId ?? "parse-error");
}

describe("extensions read no ambient process state", () => {
  const BANNED: Array<[string, string]> = [
    ["process.env in a body", "export const a = () => process.env.QCR_ROOT;"],
    ["process.env as a default parameter", "export function a(env = process.env) { return env; }"],
    ["process.cwd()", "export const a = () => process.cwd();"],
    ["process.argv", "export const a = process.argv.slice(2);"],
    [
      "os.homedir() via a default import",
      'import os from "node:os";\nexport const a = os.homedir();',
    ],
    ["a named homedir import", 'import { homedir } from "node:os";\nexport const a = homedir();'],
    ["a named homedir import from os", 'import { homedir as h } from "os";\nexport const a = h();'],
  ];

  for (const [what, text] of BANNED) {
    it(`refuses ${what} under extensions/`, async () => {
      const hit = await rulesHit(text, "extensions/fixture.ts");
      expect(
        hit.some((r) => r === "no-restricted-properties" || r === "no-restricted-imports"),
      ).toBe(true);
    });

    it(`allows ${what} in an env shim under extensions/cli/`, async () => {
      expect(await rulesHit(text, "extensions/cli/fixture.ts")).toEqual([]);
    });
  }

  it("does not apply to inline-bash.ts, which is vendored verbatim", async () => {
    expect(await rulesHit("export const a = process.cwd();", "extensions/inline-bash.ts")).toEqual(
      [],
    );
  });

  it("leaves the rest of process alone", async () => {
    expect(
      await rulesHit("export const a = () => process.exit(1);", "extensions/fixture.ts"),
    ).toEqual([]);
  });

  it("holds on the tree: no extension outside cli/ names process.env, cwd or argv", async () => {
    const real = new ESLint({
      cwd: ROOT,
      overrideConfigFile: true,
      overrideConfig: [
        { files: ["**/*.ts"], languageOptions: { parser: tseslint.parser } },
        // The tree's own ignores for the vendored files, as in the real config.
        { ignores: ["extensions/vendor/**"] },
        extensionBan as never,
      ],
    });
    const results = await real.lintFiles([
      "extensions/**/*.ts",
      "packages/pi-plugin/extensions/**/*.ts",
    ]);
    const hits = results.flatMap((r) =>
      r.messages
        .filter((m) => m.ruleId?.startsWith("no-restricted"))
        .map((m) => `${r.filePath.slice(ROOT.length + 1)}:${m.line} ${m.message}`),
    );
    expect(hits).toEqual([]);
  });
});
