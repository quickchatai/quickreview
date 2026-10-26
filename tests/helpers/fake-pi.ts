// A fake pi for an extension that draws: it records what the extension
// registers (tools, shortcuts, commands, event handlers), captures the
// component an overlay `ui.custom` shows together with its overlay handle,
// and drives all of it the way a person or the model would: start the
// session, call a tool, press a shortcut, type into the focused overlay,
// move or click the mouse, and render the overlay at a width and height
// (tests/helpers/fake-theme.ts).
//
// Nothing here is pi: it models the slice of ExtensionAPI and
// ExtensionContext an extension calls, and fails loudly on what it does not.
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type {
  Component,
  OverlayHandle,
  TuiMouseEvent,
  TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import {
  fakeTheme,
  fakeTui,
  renderComponent,
  type FakeTheme,
  type FakeTui,
  type Rendered,
} from "./fake-theme.js";

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;

export interface FakeOverlay {
  component: Component;
  options: unknown;
  handle: OverlayHandle;
  /** done() was called: the overlay is closed. */
  closed: boolean;
}

export interface FakePi {
  api: ExtensionAPI;
  ctx: ExtensionContext;
  tools: Map<string, ToolDefinition>;
  shortcuts: Map<string, { description?: string; handler: (ctx: ExtensionContext) => unknown }>;
  commands: Map<string, unknown>;
  handlers: Map<string, Handler[]>;
  sent: unknown[];
  notes: string[];
  overlays: FakeOverlay[];
  tui: FakeTui;
  theme: FakeTheme;
  /** Is the overlay focused? */
  focused(): boolean;
  /** Fire an event's handlers with this fake's context. */
  emit(event: string, payload?: Record<string, unknown>): Promise<void>;
  /** `session_start`, then let what it started settle. */
  start(): Promise<void>;
  /** Call a registered tool; its text. */
  tool(name: string, params?: Record<string, unknown>): Promise<string>;
  /** Press a registered shortcut, then let it settle. */
  key(id: string): Promise<void>;
  /** Type into the overlay (as when it has focus), then let it settle. */
  input(data: string): Promise<void>;
  /** A mouse event on the overlay, at its local row `y`. */
  mouse(type: TuiMouseEvent["type"], y: number): TuiMouseEventResult | undefined;
  /** Render the open overlay. */
  render(width: number, height: number): Rendered;
}

/** Let promise chains started by an event or a key run to their end. */
export async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
}

export function fakePi(
  o: {
    mode?: ExtensionContext["mode"];
    /** The model pi says the chat runs on. */
    model?: { provider: string; id: string };
    rows?: number;
  } = {},
): FakePi {
  const tools = new Map<string, ToolDefinition>();
  const shortcuts: FakePi["shortcuts"] = new Map();
  const commands = new Map<string, unknown>();
  const handlers = new Map<string, Handler[]>();
  const sent: unknown[] = [];
  const notes: string[] = [];
  const overlays: FakeOverlay[] = [];
  const tui = fakeTui(o.rows ?? 40);
  const theme = fakeTheme();
  let focused = false;

  const handle: OverlayHandle = {
    hide: () => {},
    setHidden: () => {},
    isHidden: () => false,
    focus: () => {
      focused = true;
    },
    unfocus: () => {
      focused = false;
    },
    isFocused: () => focused,
    getBounds: () => undefined,
  };

  const ui = {
    notify: (m: string) => notes.push(m),
    setStatus: () => {},
    setWidget: () => {},
    select: async () => undefined,
    confirm: async () => false,
    input: async () => undefined,
    custom: (
      factory: (
        t: unknown,
        th: unknown,
        keys: unknown,
        done: (r: unknown) => void,
      ) => Component | Promise<Component>,
      options?: {
        overlay?: boolean;
        overlayOptions?: unknown;
        onHandle?: (h: OverlayHandle) => void;
      },
    ) =>
      new Promise((resolve) => {
        const entry = { options: options?.overlayOptions, handle, closed: false } as FakeOverlay;
        const done = (r: unknown): void => {
          entry.closed = true;
          resolve(r);
        };
        void Promise.resolve(factory(tui.tui, theme.theme, {}, done)).then((c) => {
          entry.component = c;
          overlays.push(entry);
          options?.onHandle?.(handle);
        });
      }),
  };

  const ctx = {
    ui,
    mode: o.mode ?? "tui",
    hasUI: true,
    cwd: "/home-cwd",
    model: o.model,
    isIdle: () => true,
    shutdown: () => {},
  } as unknown as ExtensionContext;

  const api = {
    registerTool: (t: ToolDefinition) => {
      if (tools.has(t.name)) throw new Error(`tool ${t.name} registered twice`);
      tools.set(t.name, t);
    },
    registerShortcut: (
      id: string,
      s: { description?: string; handler: (c: ExtensionContext) => unknown },
    ) => {
      if (shortcuts.has(id)) throw new Error(`shortcut ${id} registered twice`);
      shortcuts.set(id, s);
    },
    registerCommand: (name: string, c: unknown) => commands.set(name, c),
    on: (event: string, h: Handler) => {
      handlers.set(event, [...(handlers.get(event) ?? []), h]);
      return () => {};
    },
    sendMessage: (m: unknown) => sent.push(m),
    sendUserMessage: (t: string) => sent.push({ user: t }),
  } as unknown as ExtensionAPI;

  const overlay = (): FakeOverlay => {
    const open = overlays.filter((x) => !x.closed);
    const last = open[open.length - 1];
    if (!last) throw new Error("no overlay is open");
    return last;
  };

  const emit = async (event: string, payload: Record<string, unknown> = {}): Promise<void> => {
    for (const h of handlers.get(event) ?? []) await h({ type: event, ...payload }, ctx);
  };

  return {
    api,
    ctx,
    tools,
    shortcuts,
    commands,
    handlers,
    sent,
    notes,
    overlays,
    tui,
    theme,
    focused: () => focused,
    emit,
    start: async () => {
      await emit("session_start", { reason: "startup" });
      await settle();
    },
    tool: async (name, params = {}) => {
      const t = tools.get(name);
      if (!t) throw new Error(`no tool ${name}`);
      const r = await t.execute("call-1", params as never, undefined, undefined, ctx as never);
      return r.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
    },
    key: async (id) => {
      const s = shortcuts.get(id);
      if (!s) throw new Error(`no shortcut ${id}`);
      await s.handler(ctx);
      await settle();
    },
    input: async (data) => {
      const c = overlay().component;
      if (!c.handleInput) throw new Error("the overlay takes no input");
      c.handleInput(data);
      await settle();
    },
    mouse: (type, y) => {
      const c = overlay().component;
      const r = c.handleMouse?.({
        type,
        button: "left",
        x: 2,
        y,
        screenX: 2,
        screenY: y,
        width: 80,
        height: 40,
        shift: false,
        alt: false,
        ctrl: false,
      } as TuiMouseEvent);
      if (r?.focus) focused = true;
      return r;
    },
    render: (width, height) => renderComponent(overlay().component, { width, height, tui, theme }),
  };
}
