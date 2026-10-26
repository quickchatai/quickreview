// The setup card: on a machine that is not set up, the home opens on this,
// centred at half the terminal's width and about half its height (FT-0664's
// reference look), instead of the panel. It draws the setup checklist
// (src/home/setup.ts) in pi's theme tokens; when the last step is done the
// extension swaps it for the panel at the top right.
//
//   ╭─ quickreview ──────────────────────────── setup ─╮
//   │   Welcome to quickreview            1 of 3 done   │
//   │   ✓  Sign in to OpenAI   ChatGPT · signed in with pi │
//   │   ▸  Connect GitHub                  alt+n check   │  the next step
//   │        gh is signed out: run `gh auth login` …     │
//   │   ○  Choose a repository                           │
//   ├──────────────────────────────────────────────────┤
//   │ the notice, then the key hints                     │
//   ╰──────────────────────────────────────────────────╯
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";
import {
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { HomeModel } from "./model.js";
import { loginFailureText, type HomeSetup, type SetupStepView } from "./setup.js";

type Fg = Parameters<Theme["fg"]>[0];

/** Where the card sits: centred, half the width. */
export const SETUP_OVERLAY = {
  anchor: "center",
  width: "50%",
  minWidth: 80,
  nonCapturing: true,
} as const;

/** The share of the terminal's height the card fills. */
export const CARD_HEIGHT = 0.5;
/** Sub-rows (instructions, the device code) are indented under the label. */
const INDENT = "       ";
const NOTICE_ROWS = 3;
const SPIN = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export interface CardHost {
  setup: HomeSetup;
  model: HomeModel;
  focused(): boolean;
  /** The terminal's height. */
  rows(): number;
  unfocus(): void;
  frame(): number;
  /** Run the next step (⏎ while the card is focused). */
  next(): void;
}

/** What each step's key does, in the hint beside it. */
const VERB: Record<SetupStepView["id"], string> = {
  login: "sign in",
  github: "check",
  repo: "choose",
};

export class SetupCard implements Component {
  constructor(
    private readonly th: Theme,
    private readonly host: CardHost,
  ) {}

  private c(color: Fg, s: string): string {
    return this.th.fg(color, s);
  }

  private spin(): string {
    return SPIN[this.host.frame() % SPIN.length]!;
  }

  private edge(s: string): string {
    return this.c(this.host.focused() ? "borderAccent" : "borderMuted", s);
  }

  /** The key that runs the next step now. */
  private key(): string {
    return this.host.focused() ? "⏎" : "alt+n";
  }

  private row(w: number, left: string, right = "", selected = false): string {
    const inner = w - 4;
    const r = right ? ` ${right}` : "";
    const l = truncateToWidth(left, Math.max(1, inner - visibleWidth(r)), "…");
    const gap = Math.max(0, inner - visibleWidth(l) - visibleWidth(r));
    let text = ` ${l}${" ".repeat(gap)}${r} `;
    if (selected) text = this.th.bg("selectedBg", text);
    return `${this.edge("│")}${text}${this.edge("│")}`;
  }

  /** Text under a step, wrapped inside the frame. */
  private sub(w: number, text: string, color: Fg = "muted"): string[] {
    const room = Math.max(10, w - 4 - INDENT.length);
    return wrapTextWithAnsi(text, room).map((l) => this.row(w, `${INDENT}${this.c(color, l)}`));
  }

  private top(w: number): string {
    const left = `${this.edge("╭─ ")}${this.th.bold(this.c("accent", "quickreview"))} `;
    const right = ` ${this.c("muted", "setup")}${this.edge(" ─╮")}`;
    const fill = Math.max(0, w - visibleWidth(left) - visibleWidth(right));
    return `${left}${this.edge("─".repeat(fill))}${right}`;
  }

  private rule(w: number): string {
    return this.edge(`├${"─".repeat(Math.max(0, w - 2))}┤`);
  }

  private bottom(w: number): string {
    return this.edge(`╰${"─".repeat(Math.max(0, w - 2))}╯`);
  }

  private stepRows(w: number, s: SetupStepView): string[] {
    const v = this.host.setup.view();
    const out: string[] = [];
    const k = this.key();
    let mark: string;
    let label: string;
    let right = "";
    if (s.state === "done") {
      mark = this.c("success", "✓");
      label = this.c("muted", s.title);
      right = this.c("muted", s.found ?? "done");
    } else if (s.state === "running") {
      mark = this.c("accent", this.spin());
      label = this.th.bold(this.c("text", s.title));
      right = this.c("dim", v.login.code ? "waiting for you…" : "starting…");
    } else if (s.unknown !== undefined) {
      mark = this.c("dim", "?");
      label = s.next ? this.th.bold(this.c("text", s.title)) : this.c("text", s.title);
      right = s.next
        ? `${this.c("accent", k)} ${this.c("muted", VERB[s.id])}`
        : this.c("dim", "unknown");
    } else if (s.next) {
      mark = this.c("accent", "▸");
      label = this.th.bold(this.c("text", s.title));
      right = `${this.c("accent", k)} ${this.c("muted", VERB[s.id])}`;
    } else {
      mark = this.c("dim", "○");
      label = this.c("dim", s.title);
    }
    out.push(this.row(w, `  ${mark}  ${label}`, right, s.next));
    if (s.state === "done") return out;
    if (s.id === "login") out.push(...this.loginRows(w, s));
    else if (s.unknown !== undefined)
      out.push(...this.sub(w, `Unknown — ${s.unknown}.`, "warning"));
    else if (s.next && s.id === "github" && s.missing)
      out.push(...this.sub(w, `${capital(s.missing)}, then ${k} checks again.`, "warning"));
    else if (s.next && s.id === "repo")
      out.push(
        ...this.sub(
          w,
          "One of your recently pushed repositories, or paste any owner/name or GitHub URL.",
        ),
      );
    return out;
  }

  private loginRows(w: number, s: SetupStepView): string[] {
    const v = this.host.setup.view();
    const k = this.key();
    const out: string[] = [];
    const chatgpt = v.provider === "OpenAI";
    const setting = "Device-code login must be on first: ChatGPT → Settings → Security.";
    if (s.state === "running") {
      const code = v.login.code;
      if (!code) {
        if (chatgpt) out.push(...this.sub(w, setting));
        out.push(
          this.row(
            w,
            `${INDENT}${this.c("accent", this.spin())} ${this.c("dim", "asking for a code…")}`,
          ),
        );
        return out;
      }
      out.push(this.row(w, ""));
      out.push(
        this.row(
          w,
          `${INDENT}${this.c("muted", "1  Open ")}  ${this.c("accent", code.verificationUri)}`,
        ),
      );
      out.push(
        this.row(
          w,
          `${INDENT}${this.c("muted", "2  Enter")}  ${this.th.bold(this.c("text", code.userCode))}`,
        ),
      );
      out.push(this.row(w, ""));
      if (chatgpt) out.push(...this.sub(w, setting, "dim"));
      out.push(
        this.row(
          w,
          `${INDENT}${this.c("accent", this.spin())} ${this.c("dim", "waiting for you to approve…")}`,
        ),
      );
      return out;
    }
    if (v.login.failure) out.push(...this.sub(w, loginFailureText(v.login.failure, k), "warning"));
    if (s.unknown !== undefined) out.push(...this.sub(w, `Unknown — ${s.unknown}.`, "warning"));
    if (s.next && chatgpt && v.login.failure?.kind !== "not_enabled")
      out.push(...this.sub(w, setting));
    return out;
  }

  private hints(w: number): string {
    const k = (key: string, label: string): string =>
      `${this.c("accent", key)} ${this.c("muted", label)}`;
    return this.row(
      w,
      this.host.focused()
        ? `${k("⏎", "next step")}  ${k("esc", "back to the chat")}`
        : `${k("alt+n", "next step")}  ${k("f2", "focus the card")}  ${this.c("dim", "· or just type to ask pi")}`,
    );
  }

  render(width: number): string[] {
    const w = Math.max(40, width);
    const v = this.host.setup.view();
    const body = [
      this.row(w, ""),
      this.row(
        w,
        `  ${this.th.bold(this.c("text", "Welcome to quickreview"))}`,
        this.c("muted", `${v.done} of ${v.total} done  `),
      ),
      this.row(
        w,
        `  ${this.c("muted", "Sign in once, choose a repository, and review your first pull request.")}`,
      ),
      this.row(w, ""),
    ];
    for (const c of v.checks) {
      body.push(
        this.row(
          w,
          `  ${this.c("warning", "✗")}  ${this.th.bold(this.c("text", c.title))}`,
          c.next ? `${this.c("accent", this.key())} ${this.c("muted", "check")}` : "",
          c.next,
        ),
      );
      body.push(
        ...this.sub(
          w,
          `${capital(c.why)}${c.next ? `, then ${this.key()} checks again.` : "."}`,
          "warning",
        ),
      );
    }
    for (const s of v.steps) body.push(...this.stepRows(w, s));
    body.push(this.row(w, ""));
    const foot = [this.rule(w)];
    const n = this.host.model.notice;
    if (n) {
      const color: Fg = n.kind === "ok" ? "success" : n.kind === "warn" ? "warning" : "text";
      for (const l of wrapTextWithAnsi(n.text, w - 4).slice(0, NOTICE_ROWS))
        foot.push(this.row(w, this.c(color, l)));
    }
    foot.push(this.hints(w), this.bottom(w));
    const target = Math.round(this.host.rows() * CARD_HEIGHT);
    const spare = Math.max(0, target - 1 - body.length - foot.length);
    const blank = (k: number): string[] => Array.from({ length: k }, () => this.row(w, ""));
    return [
      this.top(w),
      ...blank(Math.floor(spare / 2)),
      ...body,
      ...blank(Math.ceil(spare / 2)),
      ...foot,
    ].map((l) => truncateToWidth(l, w));
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape")) this.host.unfocus();
    else if (matchesKey(data, "enter")) this.host.next();
  }

  handleMouse(e: TuiMouseEvent): TuiMouseEventResult | undefined {
    return e.type === "click" ? { focus: true } : undefined;
  }

  invalidate(): void {}
}

const capital = (s: string): string => (s ? `${s[0]!.toUpperCase()}${s.slice(1)}` : s);
