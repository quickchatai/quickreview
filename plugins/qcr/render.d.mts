// The types of render.mjs, the one renderer of the skill source, for the
// TypeScript that imports it (the App's installer, the tests).

export type Command = "review" | "scan" | "setup" | "selfimprove";
export type Host =
  "claude" | "codex" | "copilot" | "cursor" | "opencode" | "gemini" | "antigravity";
export type Target = Host | "pi";

/** One command's template: the shared description and its two bodies. */
export interface Template {
  description: string;
  pi: string;
  host: string;
}

/** The skill source: the plugin's description, each command's template, the
 * partials a body includes and each host's note. */
export interface Source {
  description: string;
  commands: Partial<Record<Command, Template>>;
  partials: Record<string, string>;
  notes: Partial<Record<Host, string>>;
}

export interface RenderAt {
  /** The package version: every manifest's, and the pinned `npx` line's. */
  version: string;
  /** The host-plugin contract, the N of `qcr --schema N`. */
  contract: number;
}

/** A rendered tree: relative path to file contents, sorted by path. */
export type Rendered = Record<string, string>;

export const PLUGIN_NAME: "qcr";
export const MARKETPLACE_NAME: string;
export const APP_PACKAGE: string;
export const TEMPLATE_CONTRACT: number;
export const COMMANDS: readonly Command[];
export const HOSTS: readonly Host[];
export const TARGETS: readonly Target[];
export const NAMES: Readonly<
  Record<string, Readonly<Record<string, Readonly<{ name: string; invoke: string }>>>>
>;

export function commandName(target: string, command: string): string;
export function invokeSpelling(target: string, command: string): string;
export function parseTemplate(text: string, label?: string): Template;
export function loadSource(dir?: string): Source;
export function render(source: Source, target: string, at: RenderAt): Rendered;
export function renderedDiff(files: Rendered, dir: string, within?: string): string[];
export function writeRendered(files: Rendered, dir: string, within?: string): void;
export function packageVersion(): string;
