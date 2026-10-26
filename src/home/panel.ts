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
//   ├─ #n ──────────────────────────────────────┤  the selected PR: its price,
//   │                                             its review's progress (the
//   │                                             plan, the lenses, validate,
//   │                                             write-up, a "now" line per
//   │                                             running lens) or its findings
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
import { clockOf } from "@quickchatai/pi-quickreview/src/live/lensline.js";
import { ago, providerLabel, type HomeModel, type SetupGap } from "./model.js";
import type { OpenPull, PrReview, ReviewQuote, Slot } from "./ports.js";
import { sevOf, shortWhere, whereOf, type Lens, type Run } from "./review.js";

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
/** The finished view lists this many findings before "… n more". */
const FINDING_ROWS = 8;
/** "now" lines for this many running lenses, then "and n more". */
const NOW_ROWS = 4;

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

  /** "~$1.33 · stops at $2.66", "price unknown", a spinner while pricing,
   * or nothing before it is asked for. */
  private price(q: Slot<ReviewQuote> | null, long: boolean): string {
    if (q === null) return "";
    if (q.kind === "pending") return this.c("dim", `${this.spin()} pricing`);
    if (q.kind === "unknown") return this.c("dim", "price unknown");
    const cap = q.value.capUsd;
    return this.c(
      "dim",
      `~${money(q.value.estimateUsd)}${long ? (cap === null ? " · no hard stop" : ` · stops at ${money(cap)}`) : ""}`,
    );
  }

  /** A run's lens bar: done of planned, `cells` wide. */
  private bar(run: Run, cells: number): string {
    const done = run.lenses.filter((l) => l.state === "done" || l.state === "failed").length;
    const filled = Math.round((done / Math.max(1, run.lenses.length)) * cells);
    return `${this.c("accent", "▰".repeat(filled))}${this.c("dim", "▱".repeat(cells - filled))} ${this.c("muted", `${done}/${run.lenses.length || "?"}`)}`;
  }

  private prRow(w: number, p: OpenPull, review: PrReview | undefined, isSel: boolean): string {
    let mark: string;
    let right: string;
    const run = this.m.runs.get(p.number);
    if (run && this.m.isRunning(p.number)) {
      mark = this.c("accent", this.spin());
      right = this.bar(run, 8);
    } else if (review) {
      mark = review.high ? this.c("warning", "●") : this.c("success", "✓");
      right =
        review.findings === null
          ? this.c("muted", "reviewed")
          : review.findings === 0
            ? this.c("success", "clean")
            : this.c(review.high ? "warning" : "muted", plural(review.findings, "finding"));
      right += this.c("dim", ` · ${review.by} · ${ago(review.at, this.m.now())}`);
    } else {
      mark = this.c("dim", "○");
      const price = this.price(this.m.quoteOf(p), false);
      right =
        this.c("dim", `@${p.author} · ${ago(Date.parse(p.updatedAt), this.m.now())}`) +
        (price && this.m.quoteOf(p)?.kind === "known" ? this.c("dim", " · ") + price : "");
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
    // auto-review's note, when its half is unknown, takes a row of the room
    const note = l.reviewed !== null && this.m.autoUnknown() !== null ? 1 : 0;
    const caps = listCaps(room - note, this.need()!);
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
    const auto = this.m.autoUnknown();
    if (l.reviewed !== null && auto !== null)
      out.push(this.row(w, this.c("dim", `Auto-review's reviews unknown — ${auto}.`)));
  }

  private details(w: number): string[] {
    const p = this.m.selectedPull();
    if (!p) return [];
    const c = (k: Fg, t: string): string => this.c(k, t);
    const run = this.m.runs.get(p.number);
    const running = run !== undefined && this.m.isRunning(p.number);
    const out = [this.rule(w, `#${p.number}`, running && run.runId ? `run ${run.runId}` : "")];
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
    if (running) out.push(...this.progress(w, run));
    else {
      out.push(this.row(w, ""));
      // a failed or stopped run says why, and the PR stays reviewable
      if (run?.stage === "failed" && (review === undefined || (run.ended ?? 0) >= review.at))
        out.push(this.row(w, c("warning", `✗ The last review stopped: ${run.error ?? "unknown"}`)));
      if (review) out.push(...this.finishedView(w, review));
      else
        out.push(
          this.row(
            w,
            `${c("dim", "○")} Not reviewed yet.  ${c("accent", this.host.focused() ? "⏎" : "alt+r")} ${c("muted", "reviews it now, in the background")}`,
            this.price(this.m.quoteOf(p), true),
          ),
        );
    }
    out.push(
      this.row(
        w,
        `${c("accent", this.host.focused() ? "o" : "alt+o")} ${c("muted", "opens it on GitHub")}`,
      ),
    );
    return out;
  }

  /** A running review: the plan, the lens bar and chips, validate and
   * write-up, then what each running lens is doing now. */
  private progress(w: number, r: Run): string[] {
    const c = (k: Fg, t: string): string => this.c(k, t);
    const now = this.m.now();
    const order: Run["stage"][] = ["plan", "lenses", "validate", "write", "done"];
    const at = order.indexOf(r.stage);
    const mark = (i: number): string =>
      at > i ? c("success", "✓") : at === i ? c("accent", this.spin()) : c("dim", "○");
    const price =
      r.est === null
        ? "price unknown"
        : `~${money(r.est)}${r.cap === null ? "" : `, stops at ${money(r.cap)}`}`;
    const plan =
      r.lenses.length > 0
        ? `${r.files === undefined ? "" : `${plural(r.files, "file")} → `}${r.lenses.length} lens${r.lenses.length === 1 ? "" : "es"}`
        : (r.now ?? "planning");
    const out = [
      this.row(w, ""),
      this.row(
        w,
        `${mark(0)} Plan       ${c("muted", plan)}`,
        c("dim", `${clockOf(now - r.started)} · ${price}`),
      ),
      this.row(w, `${mark(1)} Lenses     ${this.bar(r, 12)}`),
    ];
    const chip = (l: Lens): string =>
      l.state === "done"
        ? `${c("success", "✓")} ${c("muted", l.name)}${c("dim", ` ${l.tools}t`)}${l.findings ? c("warning", ` ·${l.findings}`) : ""}`
        : l.state === "run"
          ? `${c("accent", this.spin())} ${l.name}${c("dim", ` ${clockOf(now - (l.since ?? now))}`)}`
          : l.state === "failed"
            ? `${c("error", "✗")} ${c("muted", l.name)}`
            : `${c("dim", "○")} ${c("dim", l.name)}`;
    const cell = Math.max(0, ...r.lenses.map((l) => l.name.length)) + 9;
    const pad = (t: string): string => t + " ".repeat(Math.max(0, cell - visibleWidth(t)));
    const chips = r.lenses.map(chip);
    for (let i = 0; i < chips.length; i += 3)
      out.push(
        this.row(
          w,
          `             ${chips
            .slice(i, i + 3)
            .map(pad)
            .join("")}`,
        ),
      );
    out.push(
      this.row(w, `${mark(2)} Validate   ${c("muted", "checks every finding against the code")}`),
    );
    out.push(
      this.row(w, `${mark(3)} Write-up   ${c("muted", "the review, ready to read or post")}`),
    );
    out.push(this.row(w, ""));
    // what the reviewer is doing right now: one line per running lens
    const busy = r.lenses.filter((l) => l.state === "run");
    if (busy.length === 0)
      out.push(this.row(w, `${c("dim", "now")}  ${c("muted", r.now ?? "starting")}`));
    for (const l of busy.slice(0, NOW_ROWS)) {
      const line = l.line ?? `${l.name} · ${clockOf(now - (l.since ?? now))}`;
      const cut = line.indexOf(" · ");
      const name = cut < 0 ? line : line.slice(0, cut);
      const rest = cut < 0 ? "" : line.slice(cut + 3);
      out.push(this.row(w, `${c("dim", "now")}  ${c("accent", name)}  ${c("muted", rest)}`));
    }
    if (busy.length > NOW_ROWS)
      out.push(this.row(w, c("dim", `     and ${busy.length - NOW_ROWS} more`)));
    return out;
  }

  /** A finished review: who, how many, the time and the real cost, then one
   * line per finding. */
  private finishedView(w: number, r: PrReview): string[] {
    const c = (k: Fg, t: string): string => this.c(k, t);
    const right = [
      ...(r.tookMs !== undefined ? [`took ${clockOf(r.tookMs)}`] : []),
      ...(r.costUsd !== undefined ? [r.costUsd === null ? "cost unknown" : money(r.costUsd)] : []),
      ...(r.tookMs === undefined && r.costUsd === undefined
        ? [`${ago(r.at, this.m.now())} ago`]
        : []),
    ].join(" · ");
    const count =
      r.findings === null ? "findings on the pull request" : plural(r.findings, "finding");
    const out = [
      this.row(
        w,
        `${c("success", "✓")} Reviewed by ${r.by === "auto" ? "auto-review" : "you"} · ${c(r.high ? "warning" : "text", count)}`,
        c("dim", right),
      ),
    ];
    const list = r.list ?? [];
    for (const f of list.slice(0, FINDING_ROWS)) {
      const sev = sevOf(f.severity);
      out.push(
        this.row(
          w,
          `  ${c(sev === "high" ? "warning" : sev === "medium" ? "text" : "muted", sev.padEnd(6))} ${c("dim", shortWhere(whereOf(f)))}  ${f.title}`,
        ),
      );
    }
    if (list.length > FINDING_ROWS)
      out.push(this.row(w, c("dim", `  … ${list.length - FINDING_ROWS} more`)));
    if (r.list !== undefined && list.length === 0)
      out.push(this.row(w, c("muted", "  Nothing worth raising.")));
    out.push(
      this.row(
        w,
        `  ${c("accent", this.host.focused() ? "⏎" : "alt+r")} ${c("muted", "shows the review in the chat")}`,
      ),
    );
    return out;
  }

  private hints(w: number): string {
    const k = (key: string, label: string): string =>
      `${this.c("accent", key)} ${this.c("muted", label)}`;
    const p = this.m.selectedPull();
    const running = p !== undefined && this.m.isRunning(p.number);
    const enter =
      p === undefined ? null : !running && this.m.reviewOf(p.number) ? "show review" : "review";
    const f = this.host.focused();
    const items = [
      ...(enter !== null && !running ? [k(f ? "⏎" : "alt+r", enter)] : []),
      k(f ? "j/k" : "alt+j/k", "move"),
      k(f ? "o" : "alt+o", "open"),
      ...(running ? [k(f ? "s" : "alt+s", "stop")] : []),
      k(f ? "u" : "alt+u", "refresh"),
      k(f ? "esc" : "f2", f ? "chat" : "focus"),
    ];
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
      // a tall details area (a running review's lenses, a finished one's
      // findings) keeps to what the lists left: its head stays, its tail is cut
      const left = target - body.length - foot.length;
      if (detail.length > left)
        detail = left >= 4 ? [...detail.slice(0, left - 1), this.row(w, this.c("dim", "…"))] : [];
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
    else if (matchesKey(data, "enter")) void m.enter();
    else if (data === "r") void m.review();
    else if (data === "s") void m.stopReview();
  }

  handleMouse(e: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (e.type !== "click" && e.type !== "move") return undefined;
    const pr = this.rowMap.get(e.y);
    if (pr !== undefined) this.m.select(pr);
    return e.type === "click" ? { focus: true } : undefined;
  }

  invalidate(): void {}
}
