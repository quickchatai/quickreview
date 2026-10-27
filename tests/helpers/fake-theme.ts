// A fake pi-tui theme and terminal, for rendering a pi component to lines
// without pi.
//
// The theme styles text the way pi's own Theme does, with real SGR escapes,
// so pi-tui's width math (visibleWidth, truncateToWidth) sees zero-width
// styling and lays the component out exactly as on a terminal. Each theme
// token gets its own 256-colour index, so a rendered line can be read back
// two ways:
//   plain   the text a person sees, every escape stripped;
//   tagged  the same text with its styling as tags: <accent>…</>, <b>…</b>,
//           <bg:selectedBg>…</bg>. A close tag closes the innermost of its
//           kind, as SGR does.
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";

const ESC = "\x1b";

export interface FakeTheme {
  theme: Theme;
  /** The token behind a 256-colour index the theme handed out. */
  tokenOf(index: number): string | undefined;
}

export function fakeTheme(): FakeTheme {
  const tokens: string[] = [];
  const index = (token: string): number => {
    let i = tokens.indexOf(token);
    if (i < 0) i = tokens.push(token) - 1;
    return i + 16; // clear of the 16 base colours
  };
  const wrap = (open: string, close: string) => (s: string) =>
    `${ESC}[${open}m${s}${ESC}[${close}m`;
  const theme = {
    name: "fake",
    fg: (token: string, s: string) => wrap(`38;5;${index(token)}`, "39")(s),
    bg: (token: string, s: string) => wrap(`48;5;${index(token)}`, "49")(s),
    bold: wrap("1", "22"),
    italic: wrap("3", "23"),
    underline: wrap("4", "24"),
    inverse: wrap("7", "27"),
    strikethrough: wrap("9", "29"),
    getFgAnsi: (token: string) => `${ESC}[38;5;${index(token)}m`,
    getBgAnsi: (token: string) => `${ESC}[48;5;${index(token)}m`,
  };
  return {
    theme: theme as unknown as Theme,
    tokenOf: (i) => tokens[i - 16],
  };
}

const SGR = /\x1b\[([0-9;]*)m/g;
const OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

/** A rendered line as a person sees it. */
export function plain(line: string): string {
  return line.replace(OSC, "").replace(SGR, "");
}

/** A rendered line with its styling as tags (see the header). */
export function tagged(line: string, t: FakeTheme): string {
  return line.replace(OSC, "").replace(SGR, (_m, codes: string) => {
    const c = codes.split(";");
    if (c[0] === "38" && c[1] === "5") return `<${t.tokenOf(Number(c[2])) ?? `fg${c[2]}`}>`;
    if (c[0] === "48" && c[1] === "5") return `<bg:${t.tokenOf(Number(c[2])) ?? c[2]}>`;
    switch (codes) {
      case "39":
        return "</>";
      case "49":
        return "</bg>";
      case "1":
        return "<b>";
      case "22":
        return "</b>";
      default:
        return "";
    }
  });
}

/** A terminal-sized TUI stand-in: what a component reads off `tui`, and a
 * count of the renders it asked for. */
export interface FakeTui {
  tui: TUI;
  terminal: { rows: number; columns: number };
  renders(): number;
}

export function fakeTui(rows = 40, columns = 200): FakeTui {
  const terminal = { rows, columns };
  let renders = 0;
  const tui = {
    terminal,
    requestRender: () => {
      renders++;
    },
  };
  return { tui: tui as unknown as TUI, terminal, renders: () => renders };
}

export interface Rendered {
  /** The lines as a person sees them. */
  lines: string[];
  /** The lines with their styling as tags. */
  styled: string[];
}

/** Render `component` at `width`, on a terminal `height` rows tall. */
export function renderComponent(
  component: Component,
  o: { width: number; height: number; tui: FakeTui; theme: FakeTheme },
): Rendered {
  o.tui.terminal.rows = o.height;
  const raw = component.render(o.width);
  return { lines: raw.map(plain), styled: raw.map((l) => tagged(l, o.theme)) };
}
