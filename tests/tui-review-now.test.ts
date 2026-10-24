// The board's first review: every open PR of the repo is listed (status.json
// `open_prs`, the daemon's reconcile list), the ones the daemon does not track
// are offered rows marked "not reviewed", and `R` on any row asks the daemon
// to review it now — the operator's `review-now` over the sealed channel.
import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import type { Command } from "../src/commands.js";
import { TUI_DEFAULTS } from "../src/config.js";
import type { StatusSnapshot } from "../src/state.js";
import { App } from "../src/tui/app.js";
import { boardKeys, detailLines, reviewGuideLines } from "../src/tui/board.js";
import { TAB_VOCABULARY } from "../src/tui/cmdbar.js";
import { visiblePrs } from "../src/tui/filters.js";
import { glyphFor, OFFERED_GLYPH, offeredPrs } from "../src/tui/model.js";
import { stripAnsi } from "../src/tui/paint.js";

function snapshot(over: Partial<StatusSnapshot> = {}): StatusSnapshot {
  return {
    written_at: "2026-10-24T09:00:00Z",
    dry_run: true,
    prs: [
      {
        number: 7,
        state: "awaiting_author",
        title: "tracked one",
        head_sha: "a",
        stale_recheck: 0,
      },
    ],
    open_prs: {
      listed_at: "2026-10-24T08:59:00Z",
      prs: [
        {
          number: 7,
          title: "tracked one",
          author: "dana",
          draft: false,
          updated_at: "2026-10-24T08:00:00Z",
        },
        {
          number: 9,
          title: "older",
          author: "lee",
          draft: false,
          updated_at: "2026-10-23T08:00:00Z",
        },
        {
          number: 12,
          title: "newest",
          author: "kim",
          draft: true,
          updated_at: "2026-10-24T08:30:00Z",
        },
      ],
    },
    ...over,
  } as StatusSnapshot;
}

describe("offered rows", () => {
  it("are the open PRs the daemon does not track, newest activity first, after the tracked ones", () => {
    // MUTATION: return only the tracked list from visiblePrs — this fails.
    const rows = visiblePrs({ snapshot: snapshot(), boardFilter: null });
    expect(rows.map((r) => [r.number, r.offered === true])).toEqual([
      [7, false],
      [12, true],
      [9, true],
    ]);
    expect(rows[1]!.title).toBe("[draft] newest");
    expect(glyphFor(rows[1]!)).toBe(OFFERED_GLYPH);
  });

  it("are not offered under a board filter, nor before the daemon has listed", () => {
    expect(
      visiblePrs({ snapshot: snapshot(), boardFilter: { state: "awaiting_author" } }).map(
        (r) => r.number,
      ),
    ).toEqual([7]);
    expect(offeredPrs(snapshot({ open_prs: undefined }))).toEqual([]);
  });

  it("an offered row answers only R and g; a tracked row keeps its verbs and gains R", () => {
    const view = (selected: number) =>
      ({ snapshot: snapshot(), boardFilter: null, selected, repo: "acme/web" }) as never;
    const offered = boardKeys(view(1));
    expect(offered.bar.map((b) => b.key)).toEqual(["R", "g", "e", "I"]);
    expect(offered.inline).not.toContain("a");
    const tracked = boardKeys(view(0));
    expect(tracked.bar.map((b) => b.key)).toEqual(["R", "\r", "m", "g", "e", "u", "I"]);
    expect(TAB_VOCABULARY.board).toContainEqual({ key: "R", label: "R review now" });
  });

  it("an offered row's detail says it is not reviewed yet and what R does", () => {
    const row = visiblePrs({ snapshot: snapshot(), boardFilter: null })[1]!;
    const text = detailLines(undefined, row, 70).map(stripAnsi).join("\n");
    expect(text).toMatch(/#12/);
    expect(text).toMatch(/not reviewed yet/);
    expect(text).toMatch(/R reviews it now/);
    expect(text).not.toMatch(/loading detail/);
  });
});

describe("the guide under the PRS header", () => {
  it("says what to do while nothing is tracked, says there is nothing to review, and is otherwise silent", () => {
    const none = snapshot({ prs: [] });
    expect(
      reviewGuideLines({ snapshot: none, boardFilter: null, repo: "acme/web" }, 0, 3, 80).map(
        stripAnsi,
      ),
    ).toEqual(["select a pull request (j/k), then R reviews it now"]);
    const empty = snapshot({ prs: [], open_prs: { listed_at: "x", prs: [] } });
    expect(
      reviewGuideLines({ snapshot: empty, boardFilter: null, repo: "acme/web" }, 0, 0, 120).map(
        stripAnsi,
      )[0],
    ).toMatch(/^no open pull requests in acme\/web/);
    expect(
      reviewGuideLines({ snapshot: snapshot(), boardFilter: null, repo: "acme/web" }, 1, 2, 80),
    ).toEqual([]);
    // Not listed yet is unknown, never "no open pull requests".
    expect(
      reviewGuideLines(
        {
          snapshot: snapshot({ prs: [], open_prs: undefined }),
          boardFilter: null,
          repo: "acme/web",
        },
        0,
        0,
        80,
      ),
    ).toEqual([]);
  });
});

describe("R on the board", () => {
  function streams() {
    const out = new EventEmitter() as unknown as NodeJS.WriteStream;
    (out as unknown as { columns: number }).columns = 140;
    (out as unknown as { rows: number }).rows = 30;
    out.write = (() => true) as never;
    const input = new EventEmitter() as unknown as NodeJS.ReadStream;
    (input as unknown as { isTTY: boolean }).isTTY = false;
    input.resume = (() => input) as never;
    input.pause = (() => input) as never;
    return { out, input };
  }

  async function withApp(
    selected: number,
    body: (app: App, press: (k: string) => void, sent: Command[]) => Promise<void>,
  ) {
    const { out, input } = streams();
    const app = new App(
      TUI_DEFAULTS,
      async () => ({ ok: true, stdout: "", stderr: "", code: 0 }),
      out,
      input,
    );
    const sent: Command[] = [];
    app.hooks.operatorCommand = async (command) => {
      sent.push(command);
      return { state: "handled", label: `✓ ${command.command}` };
    };
    app.tab = "board";
    app.view.snapshot = snapshot();
    app.view.selected = selected;
    const running = app.run();
    try {
      await body(app, (k) => (input as unknown as EventEmitter).emit("data", Buffer.from(k)), sent);
    } finally {
      app.quit();
      await running;
    }
  }

  it("sends review-now for the selected offered PR", async () => {
    // MUTATION: drop the R branch in App.handleInput — this fails.
    await withApp(1, async (_app, press, sent) => {
      press("R");
      await Promise.resolve();
      expect(sent).toEqual([{ command: "review-now", pr: 12 }]);
    });
  });

  it("sends review-now for a tracked PR too", async () => {
    await withApp(0, async (_app, press, sent) => {
      press("R");
      await Promise.resolve();
      expect(sent).toEqual([{ command: "review-now", pr: 7 }]);
    });
  });

  it("m and u on an offered row act on nothing and say R reviews it", async () => {
    await withApp(1, async (app, press, sent) => {
      let unwedged = 0;
      app.hooks.unwedge = () => void unwedged++;
      press("u");
      expect(unwedged).toBe(0);
      expect(app.view.noticeLine).toBe("#12 is not reviewed yet — R reviews it now");
      press("m");
      expect(app.view.inputBox).toBeUndefined();
      expect(sent).toEqual([]);
    });
  });
});
