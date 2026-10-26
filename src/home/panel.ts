// The home's panel: a non-capturing overlay, a full-height column at the top
// right of the chat (FT-0664's reference look). It draws the HomeModel in
// pi's theme tokens and turns keys and the mouse into the model's actions; it
// owns no state of its own beyond the rows it last drew, which a click or a
// hover maps back to a pull request.
//
//   ╭─ quickreview ───────────────── owner/name ─╮
//   │ auto-review, memory + spend, the logins     │
//   ├─ To review ─────────────────────────── n ─┤
//   ├─ Reviewed ──────────────────────────── n ─┤
//   │ (spare rows)                               │
//   ├─ #n ──────────────────────────────────────┤  the selected PR
//   ├───────────────────────────────────────────┤
//   │ the notice, then the key hints             │
//   ╰───────────────────────────────────────────╯
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";
import {
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { ago, providerLabel, type HomeModel, type SetupGap } from "./model.js";
import type { OpenPull, PrReview, Slot } from "./ports.js";

type Fg = Parameters<Theme["fg"]>[0];

/** Where the panel sits: the reference placement. */
export const HOME_OVERLAY = {
  anchor: "top-right",
  width: "34%",
  minWidth: 74,
  margin: { top: 1, right: 1 },
  nonCapturing: true,
} as const;

/** The rows the panel leaves under it for pi's editor and footer. */
export const EDITOR_ROWS = 8;
/** Each list shows this many rows before "… n more" wherever the column
 * allows; the details area gives way before a list goes under it. */
export const LIST_ROWS = 10;
/** A notice wraps onto at most this many rows. */
const NOTICE_ROWS = 3;

export interface PanelHost {
  model: HomeModel;
  focused(): boolean;
  /** The terminal's height. */
  rows(): number;
  /** Give the keyboard back to the editor. */
  unfocus(): void;
  /** A spinner frame counter. */
  frame(): number;
}

const SPIN = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const money = (n: number): string => `$${n.toFixed(2)}`;
const plural = (n: number, w: string): string => `${n} ${w}${n === 1 ? "" : "s"}`;

/** How many pull requests each list may show, out of `room` rows for both
 * lists (their titles aside). Each gets half, its "… n more" row included; a
 * list that needs less gives the rest to the other. */
export function listCaps(
  room: number,
  need: { toReview: number; reviewed: number },
): { toReview: number; reviewed: number } {
  const base = Math.max(3, Math.floor((room - 2) / 2));
  const rows = (n: number, cap: number): number => (n > cap ? cap + 1 : Math.max(1, n));
  const toReview = Math.max(base, room - rows(need.reviewed, base) - 1);
  return { toReview, reviewed: Math.max(base, room - rows(need.toReview, toReview) - 1) };
}

/** Would a list show fewer than LIST_ROWS while it has more to show? */
function cramped(
  caps: { toReview: number; reviewed: number },
  need: { toReview: number; reviewed: number },
): boolean {
  return (
    (need.toReview > caps.toReview && caps.toReview < LIST_ROWS) ||
    (need.reviewed > caps.reviewed && caps.reviewed < LIST_ROWS)
  );
}

export class HomePanel implements Component {
  /** rendered line → the pull request drawn on it, for clicks and hover */
  private rowMap = new Map<number, number>();

  constructor(
    private readonly th: Theme,
    private readonly host: PanelHost,
  ) {}

  private get m(): HomeModel {
    return this.host.model;
  }

  private c(color: Fg, s: string): string {
    return this.th.fg(color, s);
  }

  private spin(): string {
    return SPIN[this.host.frame() % SPIN.length]!;
  }

  private edge(s: string): string {
    return this.c(this.host.focused() ? "borderAccent" : "borderMuted", s);
  }

  /** One framed row, the right part pushed to the edge. */
  private row(w: number, left: string, right = "", selected = false): string {
    const inner = w - 4;
    const r = right ? ` ${right}` : "";
    const l = truncateToWidth(left, Math.max(1, inner - visibleWidth(r)), "…");
    const gap = Math.max(0, inner - visibleWidth(l) - visibleWidth(r));
    let text = ` ${l}${" ".repeat(gap)}${r} `;
    if (selected) text = this.th.bg("selectedBg", text);
    return `${this.edge("│")}${text}${this.edge("│")}`;
  }

  /** A divider, optionally titled, with a count on the right. */
  private rule(w: number, title = "", count = ""): string {
    const left = title
      ? `${this.edge("├─ ")}${this.th.bold(this.c("text", title))} `
      : this.edge("├");
    const right = count ? ` ${this.c("muted", count)}${this.edge(" ─┤")}` : this.edge("┤");
    const fill = Math.max(0, w - visibleWidth(left) - visibleWidth(right));
    return `${left}${this.edge("─".repeat(fill))}${right}`;
  }

  private top(w: number): string {
    const left = `${this.edge("╭─ ")}${this.th.bold(this.c("accent", "quickreview"))} `;
    const repo = this.m.state.repo;
    const name =
      repo.kind === "known"
        ? (repo.value ?? "no repository")
        : repo.kind === "unknown"
          ? "repository unknown"
          : "…";
    const right = ` ${this.c("muted", name)}${this.edge(" ─╮")}`;
    const fill = Math.max(0, w - visibleWidth(left) - visibleWidth(right));
    return `${left}${this.edge("─".repeat(fill))}${right}`;
  }

  private bottom(w: number): string {
    return this.edge(`╰${"─".repeat(Math.max(0, w - 2))}╯`);
  }

  private checking(label: string): string {
    return `${this.c("accent", this.spin())} ${label} ${this.c("dim", "checking…")}`;
  }

  private autoLine(): [string, string] {
    const s = this.m.state.autoReview;
    const c = (k: Fg, t: string): string => this.c(k, t);
    if (s.kind === "pending") return [this.checking("Auto-review"), ""];
    if (s.kind === "unknown")
      return [
        `${c("dim", "?")} Auto-review ${c("muted", "unknown")} ${c("dim", "· can't read its status")}`,
        "",
      ];
    const when =
      s.value.checkedAt === undefined
        ? ""
        : c("dim", `checked ${ago(s.value.checkedAt, this.m.now())} ago`);
    switch (s.value.state) {
      case "off":
        return [`${c("dim", "○")} Auto-review ${c("muted", "off")}`, ""];
      case "starting":
        return [`${c("warning", this.spin())} Auto-review ${c("warning", "starting")}`, ""];
      case "on-live":
        return [
          `${c("success", "●")} Auto-review ${c("success", "on")} ${c("muted", "· live")}`,
          when,
        ];
      case "on-dry":
        return [
          `${c("accent", "●")} Auto-review ${c("accent", "on")} ${c("muted", "· dry-run")}`,
          when,
        ];
      case "paused-login":
        return [
          `${c("warning", "‖")} Auto-review ${c("warning", "paused")} ${c("muted", "· login expired")}`,
          "",
        ];
      case "broken":
        return [
          `${c("error", "✗")} Auto-review ${c("error", "stopped")}${s.value.cause ? ` ${c("muted", `· ${s.value.cause}`)}` : ""}`,
          "",
        ];
    }
  }

  private memLine(): [string, string] {
    const s = this.m.state.memory;
    const left =
      s.kind === "pending"
        ? this.checking("Memory")
        : s.kind === "unknown"
          ? `${this.c("dim", "?")} Memory ${this.c("muted", "unknown")}`
          : s.value === "on"
            ? `${this.c("success", "●")} Memory ${this.c("success", "on")}`
            : s.value === "starting"
              ? `${this.c("warning", this.spin())} Memory ${this.c("warning", "starting")}`
              : `${this.c("dim", "○")} Memory ${this.c("muted", "off")}`;
    const sp = this.m.state.spend;
    const right =
      sp.kind === "pending"
        ? this.c("dim", "spend checking…")
        : sp.kind === "unknown"
          ? this.c("dim", "spend unknown")
          : this.c("muted", `${money(sp.value.today)} today · ${money(sp.value.month)} this month`);
    return [left, right];
  }

  private loginLine(): [string, string] {
    const label = providerLabel(this.m.chatProvider());
    const signed = this.m.signedIn();
    const login =
      this.m.state.login.kind === "pending"
        ? `${this.c("accent", this.spin())} ${this.c("muted", label)} ${this.c("dim", "checking…")}`
        : signed === null
          ? `${this.c("dim", "?")} ${this.c("muted", label)} unknown`
          : signed
            ? `${this.c("success", "✓")} ${this.c("muted", label)} ${label === "OpenAI" ? "ChatGPT" : "signed in"}`
            : `${this.c("warning", "✗")} ${this.c("muted", label)} ${this.c("warning", "not signed in")}`;
    const g = this.m.state.github;
    const gh =
      g.kind === "pending"
        ? `${this.c("accent", this.spin())} ${this.c("muted", "GitHub")} ${this.c("dim", "checking…")}`
        : g.kind === "unknown"
          ? `${this.c("dim", "?")} ${this.c("muted", "GitHub")} unknown`
          : g.value === null
            ? `${this.c("warning", "✗")} ${this.c("muted", "GitHub")} ${this.c("warning", "not signed in")}`
            : `${this.c("success", "✓")} ${this.c("muted", "GitHub")} @${g.value}`;
    return [
      `${login}    ${gh}`,
      this.c("dim", this.m.tools === "full" ? "all pi tools" : "reviewer tools"),
    ];
  }

  /** The setup steps a read showed to be needed (the checklist's place). */
  private setup(w: number): string[] {
    const step: Record<SetupGap, [string, string]> = {
      login: [`Sign in to ${providerLabel(this.m.chatProvider())}`, "run qcr login"],
      github: ["Sign in to GitHub", "run gh auth login"],
      repo: ["Choose a repository", "set [github] repo in your qcr config"],
    };
    const out = [this.rule(w, "Setup")];
    for (const g of this.m.gaps()) {
      const [label, how] = step[g];
      out.push(
        this.row(
          w,
          `${this.c("accent", "▸")} ${this.th.bold(this.c("text", label))}`,
          this.c("muted", how),
        ),
      );
    }
    out.push(
      this.row(
        w,
        `${this.c("dim", "Then")} ${this.c("accent", this.host.focused() ? "u" : "alt+u")} ${this.c("dim", "checks again.")}`,
      ),
    );
    return out;
  }

  private prRow(w: number, p: OpenPull, review: PrReview | undefined, isSel: boolean): string {
    let mark: string;
    let right: string;
    if (review) {
      mark = review.high ? this.c("warning", "●") : this.c("success", "✓");
      right =
        review.findings === 0
          ? this.c("success", "clean")
          : this.c(review.high ? "warning" : "muted", plural(review.findings, "finding"));
      right += this.c("dim", ` · ${review.by} · ${ago(review.at, this.m.now())}`);
    } else {
      mark = this.c("dim", "○");
      right = this.c("dim", `@${p.author} · ${ago(Date.parse(p.updatedAt), this.m.now())}`);
    }
    const cursor = isSel ? this.c("accent", "▌") : " ";
    const num = this.c(isSel ? "accent" : "muted", `#${p.number}`);
    const title = `${isSel ? this.th.bold(p.title) : p.title}${p.isDraft ? ` ${this.c("dim", "draft")}` : ""}`;
    return this.row(w, `${cursor}${mark} ${num}  ${title}`, right, isSel);
  }

  /** One list's rows: up to `cap`, a window that keeps the selection in view,
   * then "… n more". */
  private listRows(
    w: number,
    out: string[],
    rows: ReadonlyArray<{ pull: OpenPull; review?: PrReview }>,
    cap: number,
  ): void {
    const sel = rows.findIndex((r) => r.pull.number === this.m.selected);
    const start = rows.length <= cap || sel < cap ? 0 : Math.min(sel - cap + 1, rows.length - cap);
    for (const r of rows.slice(start, start + cap)) {
      this.rowMap.set(out.length, r.pull.number);
      out.push(this.prRow(w, r.pull, r.review, r.pull.number === this.m.selected));
    }
    if (rows.length > cap) out.push(this.row(w, this.c("dim", `… ${rows.length - cap} more`)));
  }

  private pending(s: Slot<unknown>, w: number): string {
    return s.kind === "unknown"
      ? this.row(w, this.c("warning", `Unknown — ${s.why}.`))
      : this.row(
          w,
          `${this.c("accent", this.spin())} ${this.c("dim", "reading the pull requests…")}`,
        );
  }

  private need(): { toReview: number; reviewed: number } | null {
    const l = this.m.lists();
    return l && { toReview: l.toReview.length, reviewed: l.reviewed?.length ?? 1 };
  }

  private lists(w: number, out: string[], room: number): void {
    const l = this.m.lists();
    if (l === null) {
      out.push(this.rule(w, "To review", "?"));
      out.push(this.pending(this.m.state.pulls, w));
      out.push(this.rule(w, "Reviewed", "?"));
      out.push(this.pending(this.m.state.pulls, w));
      return;
    }
    const caps = listCaps(room, this.need()!);
    out.push(this.rule(w, "To review", String(l.toReview.length)));
    if (l.toReview.length === 0)
      out.push(this.row(w, this.c("dim", "Nothing waiting. New pull requests show up here.")));
    this.listRows(
      w,
      out,
      l.toReview.map((pull) => ({ pull })),
      caps.toReview,
    );
    const reviews = this.m.state.reviews;
    out.push(this.rule(w, "Reviewed", l.reviewed === null ? "?" : String(l.reviewed.length)));
    if (l.reviewed === null)
      out.push(
        this.row(
          w,
          this.c(
            "warning",
            `Unknown — ${reviews.kind === "unknown" ? reviews.why : "still reading"}.`,
          ),
        ),
      );
    else if (l.reviewed.length === 0)
      out.push(this.row(w, this.c("dim", "Nothing reviewed here yet.")));
    else this.listRows(w, out, l.reviewed, caps.reviewed);
  }

  private details(w: number): string[] {
    const p = this.m.selectedPull();
    if (!p) return [];
    const c = (k: Fg, t: string): string => this.c(k, t);
    const out = [this.rule(w, `#${p.number}`)];
    out.push(this.row(w, this.th.bold(p.title)));
    const size = ` · ${c("success", `+${p.additions}`)} ${c("error", `−${p.deletions}`)} in ${plural(p.changedFiles, "file")}`;
    out.push(
      this.row(
        w,
        c(
          "muted",
          `@${p.author} · updated ${ago(Date.parse(p.updatedAt), this.m.now())} ago · ${p.headRefName}`,
        ) + size,
      ),
    );
    const review = this.m.reviewOf(p.number);
    if (review)
      out.push(
        this.row(
          w,
          `${c("success", "✓")} Reviewed by ${review.by === "auto" ? "auto-review" : "you"} · ${c(review.high ? "warning" : "text", plural(review.findings, "finding"))}`,
        ),
      );
    out.push(
      this.row(
        w,
        `${c("accent", this.host.focused() ? "o" : "alt+o")} ${c("muted", "opens it on GitHub")}`,
      ),
    );
    return out;
  }

  private hints(w: number): string {
    const k = (key: string, label: string): string =>
      `${this.c("accent", key)} ${this.c("muted", label)}`;
    const items = this.host.focused()
      ? [k("j/k", "move"), k("o", "open"), k("u", "refresh"), k("esc", "chat")]
      : [k("alt+j/k", "move"), k("alt+o", "open"), k("alt+u", "refresh"), k("f2", "focus")];
    return this.row(w, items.join("  "));
  }

  render(width: number): string[] {
    const w = Math.max(40, width);
    this.rowMap.clear();
    const target = Math.max(20, this.host.rows() - EDITOR_ROWS);
    const [a, aRight] = this.autoLine();
    const [mem, spend] = this.memLine();
    const [login, tools] = this.loginLine();
    const body = [
      this.top(w),
      this.row(w, a, aRight),
      this.row(w, mem, spend),
      this.row(w, login, tools),
    ];
    const foot = [this.rule(w)];
    const n = this.m.notice;
    if (n) {
      const color: Fg = n.kind === "ok" ? "success" : n.kind === "warn" ? "warning" : "text";
      for (const l of wrapTextWithAnsi(n.text, w - 4).slice(0, NOTICE_ROWS))
        foot.push(this.row(w, this.c(color, l)));
    }
    foot.push(this.hints(w), this.bottom(w));
    let detail: string[] = [];
    if (this.m.gaps().length > 0) body.push(...this.setup(w));
    else {
      // two titles and the rows of both lists share what the rest leaves
      const roomWith = (d: number): number => target - body.length - d - foot.length - 2;
      detail = this.details(w);
      const need = this.need();
      if (need && detail.length > 0 && cramped(listCaps(roomWith(detail.length), need), need))
        detail = [];
      this.lists(w, body, roomWith(detail.length));
    }
    const spare = Math.max(0, target - body.length - detail.length - foot.length);
    const blank = Array.from({ length: spare }, () => this.row(w, ""));
    return [...body, ...blank, ...detail, ...foot].map((l) => truncateToWidth(l, w));
  }

  handleInput(data: string): void {
    const m = this.m;
    if (matchesKey(data, "escape")) this.host.unfocus();
    else if (data === "j" || matchesKey(data, "down")) m.move(1);
    else if (data === "k" || matchesKey(data, "up")) m.move(-1);
    else if (data === "o") void m.openPr();
    else if (data === "u") void m.refresh();
  }

  handleMouse(e: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (e.type !== "click" && e.type !== "move") return undefined;
    const pr = this.rowMap.get(e.y);
    if (pr !== undefined) this.m.select(pr);
    return e.type === "click" ? { focus: true } : undefined;
  }

  invalidate(): void {}
}
