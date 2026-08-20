// QCR FORK — file added for BUILD CONFORMANCE (not a numbered patch).
//
// `tsconfig.json` compiles `extensions/**/*.ts`, so the vendored fork is
// typechecked by `npm run build` even though it is never emitted for use (pi
// loads the .ts sources directly through jiti). None of the three packages the
// upstream sources import is installed here — pi and its ecosystem live only
// inside the container — so the slice each one uses is declared ambiently.
//
// This file merges with `extensions/pi-api.d.ts`, which already declares
// `@earendil-works/pi-coding-agent` for our own extensions; ambient module
// declarations merge, so both halves are visible everywhere.
//
// VERIFY-ON-PIN, every declaration below: nothing here is checked against the
// real packages. Keep the shapes loose — a wrong-but-narrow type would turn a
// working upstream call into a build error on the next rebase.

declare module "@earendil-works/pi-coding-agent" {
  /** The object a pi extension's default export receives. Deliberately
   * permissive: the fork only ever calls `on`, `registerTool`,
   * `registerCommand` and (through takeover.ts) `appendEntry`. */
  export interface ExtensionAPI {
    on(event: string, handler: (event: any, ctx: any) => any): void;
    registerTool(definition: any): void;
    /** Typed just enough that the handler's parameters are not implicit
     * `any` under `strict` — the fork registers `/viking`. */
    registerCommand(
      name: string,
      definition: { description?: string; handler: (args: string, ctx: any) => any },
    ): void;
    appendEntry?(customType: string, data: any): void;
    getAllTools?(): unknown;
    [key: string]: unknown;
  }
}

declare module "typebox" {
  /** TypeBox schema builders. `any` on purpose — the fork uses Type.Object /
   * Type.String / Type.Number / Type.Optional / Type.Array as opaque schema
   * values that go straight to pi. */
  export const Type: any;
}

declare module "@earendil-works/pi-ai" {
  /** `StringEnum(["a","b"] as const)` — a TypeBox string-enum helper. */
  export function StringEnum(values: readonly string[]): any;
}
