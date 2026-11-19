// The board export (src/boardexport.ts, `qcr --schema 3 board`): what a host
// reads of the reviewer. Driven at the export's seam over fixture state: the
// board is the one the daemon would write from a real in-memory store
// (tests/helpers/board-rig.ts), and every other source is a fake port.
//
// The rule under test is "absent means unknown": a field whose source cannot
// be read is left out, never printed as a zero, an empty list or a default.
// Each case below takes one source away and names what must go with it, and
// what must stay. What the lists hold is tests/board-file.test.ts.
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BOARD_SCHEMA_VERSION,
  CONTRACTS,
  HOST_SCHEMA_VERSION,
  REVIEW_SCHEMA_VERSION,
  SCAN_SCHEMA_VERSION,
  VERSION_SCHEMA_VERSION,
  contractsWith,
  hostFamilies,
  hostPayloadVersion,
  supportedContracts,
} from "@quickchatai/pi-quickreview/src/contract.js";
import { VERDICTS } from "@quickchatai/pi-quickreview/src/types.js";
import {
  CREDENTIAL_WORDS,
  IDENTITY_MODES,
  REVIEWER_STATES,
  boardExport,
  cmdBoard,
  configFacts,
  githubWord,
  readBoardProgress,
  realBoardPorts,
  type BoardExport,
  type BoardPorts,
} from "../src/boardexport.js";
import {
  BOARD_LIST_CAP,
  POSTED_EVENTS,
  REVIEWING_PROBLEMS,
  REVIEWING_STATES,
} from "../src/boardfile.js";
import { known, unknown } from "../src/home/ports.js";
import type { ProcessResult, ProcessRunner } from "../src/onboard/engine.js";
import { binRoute } from "../src/qcrbin.js";
import {
  SCHEMA_VERBS,
  forgetRequestedContract,
  parseSchemaFlag,
  requestedContract,
} from "../src/schemaflag.js";
import { versionInfo } from "../src/version.js";
import {
  AUTH,
  AUTH_FILE,
  BoardWorld,
  CONFIG,
  NOW,
  REFRESHER_FILE,
  at,
  fakeBoardPorts,
  fsError,
  openPr,
} from "./helpers/board-rig.js";
import { validate } from "./helpers/json-schema-lite.js";
import { closureReachesStateStore } from "./helpers/worker-fences.js";

const ROOT = join(import.meta.dirname, "..");
type Json = Record<string, unknown>;
const schema = JSON.parse(readFileSync(join(ROOT, "schemas", "board.v1.json"), "utf8")) as Json;

let w: BoardWorld;
beforeEach(() => {
  w = new BoardWorld();
});
afterEach(() => {
  w.close();
  forgetRequestedContract();
});

/** A small board: one queued, one reviewed and posted, two open. */
function smallBoard(): string {
  w.tick(-3600);
  w.pr(1, { state: "queued", trigger_ts: at(-3000) });
  w.pr(2);
  w.finished(2, {
    verdict: "APPROVE",
    posted: { event: "APPROVE", id: 9001, at: at(-3500) },
    comments: 1,
  });
  w.pr(3);
  w.tick(0);
  w.open = [openPr(1), openPr(2), openPr(3), openPr(4)];
  return w.boardText();
}

/** The ports of a working install: the daemon runs and wrote `text`. */
const withBoard = (text: string, over: Parameters<typeof fakeBoardPorts>[0] = {}): BoardPorts =>
  fakeBoardPorts({ boardFile: async () => known(text), ...over });

const read = (ports: BoardPorts): Promise<BoardExport> => boardExport(ports, 3);

/** What the config and pi's login say, whatever the daemon does. */
const SETUP = {
  repo: "acme/webapp",
  identity: { mode: "user", login: "octo-dev" },
  model_login: "ok",
  trigger_label: "AI review requested",
  // the rig's config leaves the key out: labelled pull requests
  trigger: "label",
};

/** The fields that are the running daemon's: gone whenever its board is. */
const DAEMON_FIELDS = [
  "written_at",
  "posting",
  "posting_pending",
  "poll",
  "spend",
  "reviewed_today",
  "reviewing",
  "reviewed",
  "open",
  "listed_at",
  "more",
];

describe("a working install", () => {
  it("prints the spec's shape, leading with the contract, and validates", async () => {
    const out = await read(withBoard(smallBoard()));
    const row = (number: number) => ({ number, title: `PR ${number}`, author: "alice" });
    expect(out).toEqual({
      schema_version: 3,
      written_at: at(0),
      ...SETUP,
      posting: "dry_run",
      reviewer: "on",
      poll: { last_at: at(-60), ok: true, interval_s: 300 },
      spend: { today_usd: 0.25, month_usd: 0.25 },
      reviewing: [{ ...row(1), state: "queued" }],
      reviewed: [
        {
          ...row(2),
          verdict: "APPROVE",
          posted_event: "APPROVE",
          approval_withheld: false,
          posted_at: at(-3500),
          review_id: 9001,
          rounds: 1,
          findings: 1,
          head_changed: false,
        },
      ],
      open: [
        { ...row(4), draft: false, updated_at: at(-3600) },
        { ...row(3), draft: false, updated_at: at(-3600) },
      ],
      listed_at: at(-60),
    });
    expect(Object.keys(out)).toEqual([
      "schema_version",
      "written_at",
      "repo",
      "identity",
      "posting",
      "reviewer",
      "model_login",
      "trigger_label",
      "poll",
      "spend",
      "trigger",
      "reviewing",
      "reviewed",
      "open",
      "listed_at",
    ]);
    expect(validate(schema, out)).toEqual([]);
  });

  // MUTATION: print `html_url` (or the repository) on a row — a string that is
  // a URL appears, and this fails.
  it("carries no URL anywhere", async () => {
    const strings: string[] = [];
    const walk = (v: unknown): void => {
      if (typeof v === "string") strings.push(v);
      else if (Array.isArray(v)) v.forEach(walk);
      else if (typeof v === "object" && v !== null)
        for (const [k, x] of Object.entries(v)) {
          strings.push(k);
          walk(x);
        }
    };
    walk(await read(withBoard(smallBoard())));
    expect(strings.length).toBeGreaterThan(30);
    expect(strings.filter((s) => /:\/\/|^url$|_url$/.test(s))).toEqual([]);
  });

  it("the daemon's own flag is `posting`; a config that already says live is pending", async () => {
    const dry = smallBoard();
    const liveConfig = CONFIG.replace("dry_run = true", "dry_run = false");
    expect(await read(withBoard(dry))).not.toHaveProperty("posting_pending");
    // MUTATION: read `posting` from the config — this says live while the
    // daemon that is running still records and posts nothing.
    expect(await read(withBoard(dry, { config: () => known(liveConfig) }))).toMatchObject({
      posting: "dry_run",
      posting_pending: "live",
    });
    w.dryRun = false;
    const live = await read(withBoard(w.boardText(), { config: () => known(liveConfig) }));
    expect(live.posting).toBe("live");
    expect(live).not.toHaveProperty("posting_pending");
  });

  it("a capped list says so, and never runs past the cap", async () => {
    for (let n = 1; n <= BOARD_LIST_CAP + 5; n++)
      w.pr(n, { state: "queued", trigger_ts: at(-10_000 + n) });
    const out = await read(withBoard(w.boardText()));
    expect(out.reviewing).toHaveLength(BOARD_LIST_CAP);
    expect(out.reviewing?.[0]?.number).toBe(BOARD_LIST_CAP + 5);
    expect(out.more).toBe(true);
    expect(validate(schema, out)).toEqual([]);
    expect(validate(schema, { ...out, reviewing: [...out.reviewing!, { number: 1 }] })).not.toEqual(
      [],
    );
  });
});

describe("absent means unknown: the daemon", () => {
  // MUTATION: read the board file whatever the daemon's state — a stopped
  // daemon's last board would print as today's lists, and this fails.
  it("off: the daemon does not run, so the lists and all it reports are absent", async () => {
    const out = await read(
      withBoard(smallBoard(), { daemon: async () => known("stopped" as const) }),
    );
    expect(out).toEqual({ schema_version: 3, ...SETUP, reviewer: "off" });
    for (const field of DAEMON_FIELDS) expect(out, field).not.toHaveProperty(field);
  });

  it("restarting: broken, and no lists", async () => {
    const out = await read(
      withBoard(smallBoard(), { daemon: async () => known("restarting" as const) }),
    );
    expect(out).toEqual({ schema_version: 3, ...SETUP, reviewer: "broken" });
  });

  // MUTATION: map an unknown label to "off" — every case here reads as a
  // reviewer that is switched off, and this fails.
  it("nothing can say whether it runs: no `reviewer` at all, never off and never on", async () => {
    const cases: Array<[string, Parameters<typeof fakeBoardPorts>[0]]> = [
      ["Docker cannot answer", { daemon: async () => unknown("docker is not installed") }],
      [
        "the question throws",
        {
          daemon: async () => {
            throw new Error("spawn failed");
          },
        },
      ],
      ["it runs and has written no board yet", { boardFile: async () => known(null) }],
      ["its board cannot be read", { boardFile: async () => unknown("permission denied") }],
      ["its board is not JSON", { boardFile: async () => known("{") }],
      [
        "its board is another format",
        { boardFile: async () => known(JSON.stringify({ ...w.board(), format: 2 })) },
      ],
    ];
    const text = smallBoard();
    for (const [name, over] of cases) {
      const out = await read(withBoard(text, over));
      expect(out, name).toEqual({ schema_version: 3, ...SETUP });
    }
  });

  it("a board no longer rewritten: broken, the lists as last written, no spend", async () => {
    const out = await read(withBoard(smallBoard(), { now: () => NOW + 86_400_000 }));
    expect(out.reviewer).toBe("broken");
    expect(out.written_at).toBe(at(0));
    expect(out.reviewing).toHaveLength(1);
    expect(out.reviewed).toHaveLength(1);
    // MUTATION: pass the board's spend through whatever its day — yesterday's
    // figure prints as today's, and this fails.
    expect(out).not.toHaveProperty("spend");
  });

  it("before the first poll has ended: starting, and a poll with its cadence alone", async () => {
    smallBoard();
    const snapshot = w.snapshot();
    snapshot.poll = { last_at: null, ok: null, interval_s: 300 };
    const out = await read(withBoard(w.boardText(snapshot)));
    expect(out.reviewer).toBe("starting");
    // MUTATION: print `ok: false` for a pass that has not run — this fails.
    expect(out.poll).toEqual({ interval_s: 300 });
  });

  it("before a pass has listed the open pull requests: no `open`, no `listed_at`", async () => {
    w.pr(1, { state: "queued", trigger_ts: at(-10) });
    const out = await read(withBoard(w.boardText()));
    expect(out.reviewing).toHaveLength(1);
    expect(out.reviewed).toEqual([]);
    expect(out).not.toHaveProperty("open");
    expect(out).not.toHaveProperty("listed_at");
  });

  it("an older board with no spend figures: no `spend`", async () => {
    smallBoard();
    const { today_spend_usd: _today, month_spend_usd: _month, ...older } = w.snapshot();
    const out = await read(withBoard(JSON.stringify(w.board(older))));
    expect(out).not.toHaveProperty("spend");
    expect(out.reviewer).toBe("on");
  });
});

describe("`reviewed_today`: the daemon's count of the day", () => {
  /** The day the fixture board is written in, on the install's calendar:
   * twelve hours either side of the write. */
  const day = (count: number) => ({ count, since: at(-12 * 3600), until: at(12 * 3600) });
  /** The small board, with the count the daemon made (or none). */
  const boardWith = (reviewedToday?: ReturnType<typeof day>): string => {
    smallBoard();
    return w.boardText(undefined, reviewedToday);
  };

  it("is the daemon's number, printed after `spend`, and a zero it counted is a zero", async () => {
    const out = await read(withBoard(boardWith(day(3))));
    expect(out.reviewed_today).toBe(3);
    const keys = Object.keys(out);
    expect(keys.indexOf("reviewed_today")).toBe(keys.indexOf("spend") + 1);
    expect(validate(schema, out)).toEqual([]);
    // counted, and nobody was reviewed: zero is a reading
    const none = await read(withBoard(w.boardText(undefined, day(0))));
    expect(none.reviewed_today).toBe(0);
    // the schema takes a count, and nothing else
    for (const bad of [-1, 1.5, "3", null])
      expect(validate(schema, { ...out, reviewed_today: bad }), String(bad)).not.toEqual([]);
  });

  // MUTATION: print 0 where the board carries no count — a daemon that could
  // not read its store or its timezone says nobody was reviewed, and this fails.
  it("is absent, never zero, when the daemon could not count", async () => {
    const out = await read(withBoard(boardWith()));
    expect(out).not.toHaveProperty("reviewed_today");
    // everything else the board carries is still printed
    expect(out.reviewed).toHaveLength(1);
    expect(out.spend).toBeDefined();
  });

  // MUTATION: print the board's count whatever the time — yesterday's number
  // is shown as today's once the day has turned, and this fails.
  it("is absent once the day it is the count of is over, or has not begun", async () => {
    const text = boardWith(day(3));
    const readAt = (now: number) => read(withBoard(text, { now: () => now }));
    expect((await readAt(NOW)).reviewed_today).toBe(3);
    // the last millisecond of the day, then the first of the next
    const until = Date.parse(at(12 * 3600));
    expect((await readAt(until - 1)).reviewed_today).toBe(3);
    expect(await readAt(until)).not.toHaveProperty("reviewed_today");
    expect(await readAt(Date.parse(at(-12 * 3600)) - 1)).not.toHaveProperty("reviewed_today");
  });

  it("is the running daemon's: gone with its board", async () => {
    const out = await read(
      withBoard(boardWith(day(3)), { daemon: async () => known("stopped" as const) }),
    );
    expect(out).not.toHaveProperty("reviewed_today");
  });
});

describe("absent means unknown: the config", () => {
  const off = { daemon: async () => known("stopped" as const) };

  // MUTATION: fall back to the shipped defaults when there is no config —
  // a trigger label and an "app" identity appear before any setup.
  it("before setup there is no config: no repo, no identity, no trigger label", async () => {
    const out = await read(fakeBoardPorts({ ...off, config: () => known(null) }));
    expect(out).toEqual({ schema_version: 3, reviewer: "off", model_login: "ok" });
  });

  it("a config that cannot be read, or is not TOML, says nothing", async () => {
    for (const config of [() => unknown("permission denied"), () => known("= not toml")]) {
      const out = await read(fakeBoardPorts({ ...off, config }));
      expect(out).toEqual({ schema_version: 3, reviewer: "off", model_login: "ok" });
    }
  });

  it("a template nobody filled names no repository and no identity", async () => {
    const template = ["dry_run = true", "[github]", 'repo = ""', 'bot_login = ""', ""].join("\n");
    const out = await read(fakeBoardPorts({ ...off, config: () => known(template) }));
    expect(out).not.toHaveProperty("repo");
    // MUTATION: default the mode to "app" whenever `auth` is unwritten — an
    // identity nobody chose is printed, and this fails.
    expect(out).not.toHaveProperty("identity");
    // the label is the shipped one the daemon would run on
    expect(out.trigger_label).toBe("AI review requested");
  });

  // What the reviewer picks up by itself is the config's own word, read where
  // the running daemon reads it at every poll.
  // MUTATION: drop `trigger` from configFacts, or from boardExport's object —
  // a host cannot say which of the two the person chose, and this fails.
  it("`trigger` is the config's word: label where the key is left out, all where it says so", async () => {
    const withTrigger = (value: string): string =>
      CONFIG.replace("[github]\n", `[github]\ntrigger = ${value}\n`);
    expect(configFacts(CONFIG).trigger).toBe("label");
    expect(configFacts(withTrigger('"label"')).trigger).toBe("label");
    expect(configFacts(withTrigger('"all"')).trigger).toBe("all");

    const out = await read(fakeBoardPorts({ ...off, config: () => known(withTrigger('"all"')) }));
    expect(out.trigger).toBe("all");
    expect(validate(schema, out)).toEqual([]);
    // printed after the day's count, before the host's own records
    const live = await read(
      withBoard(smallBoard(), {
        config: () => known(withTrigger('"all"')),
        progress: () => ({ setup: { state: "done" } }),
      }),
    );
    const keys = Object.keys(live);
    expect(keys.indexOf("trigger")).toBeGreaterThan(keys.indexOf("poll"));
    expect(keys.indexOf("trigger")).toBe(keys.indexOf("setup") - 1);
    // the schema takes the two words, and nothing else
    for (const bad of ["every", "", true, null])
      expect(validate(schema, { ...out, trigger: bad }), String(bad)).not.toEqual([]);
  });

  // MUTATION: default an unreadable value to "label" in configFacts — a
  // config that says something this release does not know prints as the
  // default, and this fails.
  it("`trigger` is absent when the config cannot say: unreadable, not TOML, or a value that is neither", async () => {
    for (const config of [
      () => unknown("permission denied"),
      () => known("= not toml"),
      () => known(null),
      () => known(CONFIG.replace("[github]\n", '[github]\ntrigger = "every"\n')),
      () => known(CONFIG.replace("[github]\n", "[github]\ntrigger = true\n")),
    ]) {
      const out = await read(fakeBoardPorts({ ...off, config }));
      expect(out).not.toHaveProperty("trigger");
    }
    // the rest of that config is still said: one bad key costs its own field
    const out = await read(
      fakeBoardPorts({
        ...off,
        config: () => known(CONFIG.replace("[github]\n", '[github]\ntrigger = "every"\n')),
      }),
    );
    expect(out.repo).toBe("acme/webapp");
    expect(out.trigger_label).toBe("AI review requested");
  });

  // On a host-managed install the host's choice (`host set-trigger`) is the
  // running daemon's, carried in its board (src/triggerchoice.ts).
  // MUTATION: print `facts.trigger` again in boardExport (skip
  // effectiveTrigger) — the export says the config's `label` while the
  // reviewer runs on the host's `all`, and this fails; or say the config's
  // word with the daemon off — the absent case fails.
  it("`trigger` on a host-managed install: the host's choice from the daemon's board, absent without one", async () => {
    const hosted = CONFIG.replace("[github]\n", '[github]\ntoken_source = "host"\n');
    const boardWithChoice = (choice: unknown): string =>
      JSON.stringify({ ...(JSON.parse(smallBoard()) as Json), trigger_choice: choice });
    const at = (text: string, over: Parameters<typeof fakeBoardPorts>[0] = {}) =>
      read(withBoard(text, { config: () => known(hosted), ...over }));
    expect((await at(boardWithChoice("all"))).trigger).toBe("all");
    expect((await at(boardWithChoice("label"))).trigger).toBe("label");
    // no choice made: the config's word
    expect((await at(boardWithChoice(null))).trigger).toBe("label");
    // a board that does not say (an older daemon, a store it could not read)
    expect(await at(boardWithChoice(undefined))).not.toHaveProperty("trigger");
    expect(await at(boardWithChoice("every"))).not.toHaveProperty("trigger");
    // the daemon off: its choice cannot be read
    expect(
      await at(boardWithChoice("all"), { daemon: async () => known("stopped" as const) }),
    ).not.toHaveProperty("trigger");
    // an install no host manages: the config's word, whatever the board says
    expect(
      (await read(withBoard(boardWithChoice("all"), { config: () => known(CONFIG) }))).trigger,
    ).toBe("label");
    expect(validate(schema, await at(boardWithChoice("all")))).toEqual([]);
  });

  it("the identity is the mode the file names and the login it posts under", () => {
    const github = (lines: string[]): string => ["[github]", ...lines, ""].join("\n");
    expect(configFacts(github(['auth = "user"', 'bot_login = "octo-dev"'])).identity).toEqual({
      mode: "user",
      login: "octo-dev",
    });
    expect(configFacts(github(['bot_login = "acme-review[bot]"'])).identity).toEqual({
      mode: "app",
      login: "acme-review[bot]",
    });
    expect(configFacts(github(['auth = "installation"'])).identity).toEqual({
      mode: "installation",
    });
    expect(configFacts(github(['auth = "someone-else"', 'bot_login = "x"'])).identity).toBe(
      undefined,
    );
    expect(configFacts(github(['repo = "not a repo"'])).repo).toBe(undefined);
    expect(configFacts(github(['repo = "acme/webapp"'])).repo).toBe("acme/webapp");
  });
});

describe("absent means unknown: the model login", () => {
  const off = { daemon: async () => known("stopped" as const) };
  const login = async (over: Parameters<typeof fakeBoardPorts>[0]): Promise<unknown> =>
    (await read(fakeBoardPorts(over))).model_login;
  /** The refresher's record of a refresh that fails on a token past its expiry. */
  const lapsed = JSON.stringify({
    expires_at: at(-600),
    last_error: "the refresh failed",
    checked_at: at(-5),
    paused: false,
  });

  // The export is read before any setup: no config, no daemon, and still an answer.
  it("is readable before setup: missing without a stored login, ok with one", async () => {
    const bare = { ...off, config: () => known(null) };
    expect(await read(fakeBoardPorts({ ...bare, files: {} }))).toEqual({
      schema_version: 3,
      reviewer: "off",
      model_login: "missing",
    });
    expect(await login({ ...bare, files: { [AUTH_FILE]: "{}" } })).toBe("missing");
    expect(await login({ ...bare, files: { [AUTH_FILE]: AUTH } })).toBe("ok");
  });

  // MUTATION: answer "missing" for any read failure — a login the export
  // cannot read would send the person to sign in again, and this fails.
  it("an auth file that is there and cannot be read is unknown, not missing", async () => {
    for (const file of [fsError("EACCES", AUTH_FILE), "not json"]) {
      const out = await read(fakeBoardPorts({ ...off, files: { [AUTH_FILE]: file } }));
      expect(out).not.toHaveProperty("model_login");
    }
  });

  it("expired: the running daemon's refresher says the refresh fails past the expiry", async () => {
    const files = { [AUTH_FILE]: AUTH, [REFRESHER_FILE]: lapsed };
    expect(await login({ files })).toBe("expired");
    // a stopped daemon's refresher wrote that record some time ago: old news
    expect(await login({ ...off, files })).toBe("ok");
    expect(await login({ files: { [AUTH_FILE]: AUTH, [REFRESHER_FILE]: "not json" } })).toBe("ok");
  });

  it("expired: the daemon is paused on the login, and the reviewer says paused_login", async () => {
    smallBoard();
    const snapshot = { ...w.snapshot(), pi_auth_expired: { last_at: at(-5), hits: 2 } };
    const out = await read(withBoard(w.boardText(snapshot)));
    expect(out.reviewer).toBe("paused_login");
    expect(out.model_login).toBe("expired");
  });
});

describe("`github`: what the token file says of itself", () => {
  const SECRETS = "/install/secrets";
  const TOKEN_FILE = `${SECRETS}/github_token`;
  const NOTE_FILE = `${TOKEN_FILE}.expires_at`;
  // Nothing credential-shaped: the reader never looks at what a token is.
  const TOKEN = "a-token-its-host-wrote\n";
  const HOSTED = '[github]\ntoken_source = "host"\nauth = "user"\n';
  const word = (config: string | null, files: Record<string, string | Error>) =>
    githubWord({
      config,
      secretsDir: SECRETS,
      now: NOW,
      read: (path) => {
        const found = files[path];
        if (found === undefined) throw fsError("ENOENT", path);
        if (found instanceof Error) throw found;
        return found;
      },
    });

  it("is absent when the port says nothing, and when the port fails", async () => {
    expect(await read(fakeBoardPorts())).not.toHaveProperty("github");
    for (const said of CREDENTIAL_WORDS)
      expect((await read(fakeBoardPorts({ github: () => said }))).github).toBe(said);
    const failing = fakeBoardPorts({
      github: () => {
        throw new Error("the note is unreadable");
      },
    });
    expect(await read(failing)).not.toHaveProperty("github");
  });

  it("ok: a token, and no note or a note whose instant is ahead", () => {
    expect(word(HOSTED, { [TOKEN_FILE]: TOKEN })).toBe("ok");
    expect(word(HOSTED, { [TOKEN_FILE]: TOKEN, [NOTE_FILE]: `${at(900)}\n` })).toBe("ok");
  });

  it("expired: a token whose note is not ahead of now", () => {
    expect(word(HOSTED, { [TOKEN_FILE]: TOKEN, [NOTE_FILE]: at(-1) })).toBe("expired");
    // the instant itself is the lapse
    const now = new Date(NOW).toISOString();
    expect(word(HOSTED, { [TOKEN_FILE]: TOKEN, [NOTE_FILE]: now })).toBe("expired");
  });

  it("missing: no token file, or one with no token in it", () => {
    expect(word(HOSTED, {})).toBe("missing");
    expect(word(HOSTED, { [TOKEN_FILE]: "\n" })).toBe("missing");
    // a note with no token beside it says nothing of a token
    expect(word(HOSTED, { [NOTE_FILE]: at(900) })).toBe("missing");
  });

  // MUTATION: read the mode off `auth` alone — a config holding only a host's
  // marker says nothing of its token, and this fails.
  it("is read wherever the file is the credential: a person's token, or a host's marker", () => {
    const files = { [TOKEN_FILE]: TOKEN };
    expect(word('[github]\nauth = "user"\n', files)).toBe("ok");
    expect(word('[github]\ntoken_source = "host"\n', files)).toBe("ok");
    expect(word('[github]\ntoken_source = "host"\n', {})).toBe("missing");
  });

  // MUTATION: answer "missing" (or "ok") where the file cannot say — a host
  // would show a credential problem, or none, that nothing read; this fails.
  it("is absent, never a word, when it cannot be told", () => {
    const files = { [TOKEN_FILE]: TOKEN };
    // an App mints its own token: there is no file to speak of
    expect(word('[github]\nauth = "app"\n', files)).toBeUndefined();
    expect(word('[github]\nrepo = "acme/webapp"\n', files)).toBeUndefined();
    expect(word("dry_run = true\n", files)).toBeUndefined();
    // no config, and one that is not TOML
    expect(word(null, files)).toBeUndefined();
    expect(word("[github\nauth = ", files)).toBeUndefined();
    // a token file or a note that is there and cannot be read
    expect(word(HOSTED, { [TOKEN_FILE]: fsError("EACCES", TOKEN_FILE) })).toBeUndefined();
    expect(
      word(HOSTED, { [TOKEN_FILE]: TOKEN, [NOTE_FILE]: fsError("EACCES", NOTE_FILE) }),
    ).toBeUndefined();
    // a note that is no instant, and a file holding more than a token
    expect(word(HOSTED, { [TOKEN_FILE]: TOKEN, [NOTE_FILE]: "tomorrow" })).toBeUndefined();
    expect(word(HOSTED, { [TOKEN_FILE]: TOKEN, [NOTE_FILE]: "2026-11-19" })).toBeUndefined();
    expect(word(HOSTED, { [TOKEN_FILE]: "two words\n" })).toBeUndefined();
  });
});

describe("the records a host's verbs leave", () => {
  // What the reader finds in a real state directory is tests/host-record.test.ts.
  it("`setup`, `go_live` and `proof` come through one reader, which finds none where no host verb ran", async () => {
    expect(readBoardProgress("/stack/state")).toEqual({});
    const bare = await read(fakeBoardPorts());
    for (const field of ["setup", "go_live", "proof"]) expect(bare).not.toHaveProperty(field);
    const progress = {
      setup: { state: "running" as const, step: "bringup" },
      go_live: { state: "failed" as const, problem: "proof_unverified" },
      proof: { pr: 2, round_no: 1, verdict: "APPROVE", completed_at: at(-100) },
    };
    const out = await read(fakeBoardPorts({ progress: () => progress }));
    expect(out).toMatchObject(progress);
    expect(validate(schema, out)).toEqual([]);
    const failing = fakeBoardPorts({
      progress: () => {
        throw new Error("the checklist is unreadable");
      },
    });
    expect(await read(failing)).toEqual(bare);
  });

  // A go-live says nothing of a trigger label: no host verb writes one, and
  // the live daemon makes sure of it through the gate (src/triggerlabel.ts).
  // MUTATION: give the schema's `go_live` a `label` again, or say the label
  // as a `problem` of the go-live — this fails.
  it("a go-live that is done is done, and carries no trigger label", async () => {
    const out = await read(fakeBoardPorts({ progress: () => ({ go_live: { state: "done" } }) }));
    expect(out.go_live).toEqual({ state: "done" });
    expect(validate(schema, out)).toEqual([]);
    const goLive = (schema["$defs"] as Record<string, { properties: Record<string, unknown> }>)[
      "go_live"
    ]!;
    expect(Object.keys(goLive.properties).sort()).toEqual(["problem", "state"]);
    const base = await read(fakeBoardPorts());
    expect(
      validate(schema, { ...base, go_live: { state: "failed", problem: "label_failed" } }),
    ).not.toEqual([]);
  });
});

describe("the verb", () => {
  const run = async (
    args: string[],
    io: { contract?: number; ports: BoardPorts },
  ): Promise<{ code: number; out: string[]; err: string[] }> => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await cmdBoard(args, {
      ...io,
      out: (line) => out.push(line),
      err: (line) => err.push(line),
    });
    return { code, out, err };
  };

  it("prints one line of JSON that leads with schema_version 3, and exits 0", async () => {
    const r = await run([], { contract: 3, ports: withBoard(smallBoard()) });
    expect(r.code).toBe(0);
    expect(r.err).toEqual([]);
    expect(r.out).toHaveLength(1);
    expect(r.out[0]).not.toContain("\n");
    const payload = JSON.parse(r.out[0]!) as Json;
    expect(Object.keys(payload)[0]).toBe("schema_version");
    expect(payload["schema_version"]).toBe(3);
    expect(validate(schema, payload)).toEqual([]);
  });

  // MUTATION: print `{ "error": … }` on stdout when the export throws — a host
  // would parse it as a board, and this fails.
  it("when it cannot, stdout is empty and the exit is non-zero", async () => {
    const broken = fakeBoardPorts({
      now: () => {
        throw new Error("no clock");
      },
    });
    const failed = await run([], { contract: 3, ports: broken });
    expect(failed.code).toBe(1);
    expect(failed.out).toEqual([]);
    expect(failed.err).toHaveLength(1);
    expect(failed.err[0]).toMatch(/^qcr board: the board could not be read: no clock$/);
    const usage = await run(["--everything"], { contract: 3, ports: withBoard(smallBoard()) });
    expect(usage.code).toBe(2);
    expect(usage.out).toEqual([]);
    expect(usage.err).toEqual(["usage: qcr --schema N board"]);
  });

  it("is stamped with the contract its caller named; with none, the newest one", async () => {
    const ports = withBoard(smallBoard());
    expect(requestedContract()).toBeUndefined();
    expect(JSON.parse((await run([], { ports })).out[0]!)).toMatchObject({ schema_version: 3 });
    expect(parseSchemaFlag(["--schema", "3", "board"])).toEqual({
      kind: "ok",
      contract: 3,
      argv: ["board"],
    });
    expect(requestedContract()).toBe(3);
    expect(JSON.parse((await run([], { ports })).out[0]!)).toMatchObject({ schema_version: 3 });
  });

  // The verb's whole cost on a compose stack: Docker is asked what runs and
  // for the one file, and nothing is started or written.
  // MUTATION: read status.json as well, or exec `node` in the daemon's
  // container — the calls differ, and this fails.
  it("asks Docker two things, reads one file, starts nothing and writes nothing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "qcr-board-verb-"));
    try {
      mkdirSync(join(dir, "agent"));
      writeFileSync(join(dir, "agent", "auth.json"), AUTH);
      writeFileSync(join(dir, "config.toml"), CONFIG);
      // the token file of the person's account, and the note beside it
      mkdirSync(join(dir, "home", "secrets"), { recursive: true });
      writeFileSync(join(dir, "home", "secrets", "github_token"), "a-token\n");
      writeFileSync(
        join(dir, "home", "secrets", "github_token.expires_at"),
        new Date(Date.now() + 3_600_000).toISOString(),
      );
      const env = {
        HOME: dir,
        QCR_ROOT: join(dir, "stack"),
        QCR_CONFIG: join(dir, "config.toml"),
        QCR_CONFIG_HOME: join(dir, "home"),
        PI_CODING_AGENT_DIR: join(dir, "agent"),
      };
      const text = smallBoard();
      const calls: string[][] = [];
      const answer = (stdout: string): ProcessResult => ({ code: 0, stdout, stderr: "" });
      /** A Docker whose compose project runs `services`. */
      const docker = (services: string): ProcessRunner => ({
        run: async (cmd, args) => {
          calls.push([cmd, ...args]);
          if (args.includes("ps")) return answer(services);
          if (args.includes("exec")) return answer(text);
          return { code: 1, stdout: "", stderr: "not a call the board makes" };
        },
      });
      const before = readdirSync(dir, { recursive: true });

      const up = await boardExport(
        realBoardPorts(env, docker('[{"Service":"daemon","State":"running"}]')),
        3,
      );
      expect(up).toMatchObject({
        ...SETUP,
        github: "ok",
        posting: "dry_run",
        written_at: at(0),
      });
      expect(up.reviewing).toHaveLength(1);
      expect(up.reviewed).toHaveLength(1);
      expect(calls.map((c) => c[0])).toEqual(["docker", "docker"]);
      const tails = calls.map((c) => c.slice(c.indexOf("--project-directory") + 2).join(" "));
      expect(tails.sort()).toEqual([
        "exec -T daemon cat /opt/qcr/state/board.json",
        "ps --format json",
      ]);
      expect(calls.every((c) => c.includes(join(dir, "stack")))).toBe(true);

      const down = await boardExport(realBoardPorts(env, docker("[]")), 3);
      expect(down).toEqual({ schema_version: 3, ...SETUP, github: "ok", reviewer: "off" });
      // the token lapsed by its note: said with the daemon off too
      writeFileSync(
        join(dir, "home", "secrets", "github_token.expires_at"),
        new Date(Date.now() - 1_000).toISOString(),
      );
      expect((await boardExport(realBoardPorts(env, docker("[]")), 3)).github).toBe("expired");
      expect(readdirSync(dir, { recursive: true })).toEqual(before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // The bin routes the verb to this module where the SQLite driver cannot
  // load (tests/sqlite-free-routes.test.ts walks the front door); this names
  // the rule for the export by itself.
  // MUTATION: `import { StateStore } from "./state.js"` in src/boardfile.ts or
  // src/boardexport.ts — the chain appears here.
  it("loads no state store", () => {
    expect(closureReachesStateStore(ROOT, ["src/boardexport.ts"])).toEqual([]);
  });
});

describe("the contract", () => {
  // MUTATION: redefine contract 2 with a board family — this fails.
  it("contract 3 adds the host families to contract 2; the older two are as they were", () => {
    expect(CONTRACTS[1]).toEqual({ review: 1, scan: 1, version: 1 });
    expect(CONTRACTS[2]).toEqual({ review: 2, scan: 1, version: 1 });
    expect(CONTRACTS[3]).toEqual({
      review: REVIEW_SCHEMA_VERSION,
      scan: SCAN_SCHEMA_VERSION,
      version: VERSION_SCHEMA_VERSION,
      board: BOARD_SCHEMA_VERSION,
      host: HOST_SCHEMA_VERSION,
    });
    expect(supportedContracts()).toEqual([1, 2, 3]);
    expect(contractsWith("board")).toEqual([3]);
    expect(contractsWith("review")).toEqual([1, 2, 3]);
    expect(hostFamilies()).toEqual({ board: BOARD_SCHEMA_VERSION, host: HOST_SCHEMA_VERSION });
  });

  it("a host-family payload leads with its contract's number", () => {
    expect(hostPayloadVersion("board", 3)).toBe(3);
    expect(hostPayloadVersion("board", undefined)).toBe(3);
    // a contract with no board cannot stamp one: the newest that carries it does
    expect(hostPayloadVersion("board", 2)).toBe(3);
  });

  // MUTATION: drop the family check from readSchemaFlag — `--schema 2 board`
  // prints a board under a contract that has none, and this fails.
  it("`--schema N board` runs under a contract that carries the board, and no other", () => {
    expect(SCHEMA_VERBS).toContain("board");
    expect(binRoute(["--schema", "3", "board"])).toEqual({
      route: "board",
      args: [],
      json: true,
      schema: 3,
    });
    expect(binRoute(["board"])).toEqual({ route: "board", args: [], json: false });
    for (const n of ["1", "2"]) {
      const refused = parseSchemaFlag(["--schema", n, "board"]);
      expect(refused).toMatchObject({ kind: "refused", code: 3 });
      expect(refused.kind === "refused" && refused.line).toMatch(
        new RegExp(`^qcr --schema: contract ${n} has no board payload \\(3 has one\\)`),
      );
      expect(binRoute(["--schema", n, "board"])).toMatchObject({ route: "refused", code: 3 });
    }
    expect(parseSchemaFlag(["--schema", "9", "board"])).toMatchObject({ kind: "refused", code: 3 });
    // the three older verbs run under every contract, the host one included
    for (const verb of ["review", "scan", "version"])
      expect(parseSchemaFlag(["--schema", "3", verb]).kind, verb).toBe("ok");
  });

  // The contracts a release supports are recorded in its package.json
  // (`qcrContracts`) and printed by `qcr --schema 3 version`: a host that
  // packages a release asks the release itself.
  it("`qcr version` and package.json's `qcrContracts` name contract 3 and its families", () => {
    const v = versionInfo(ROOT, null);
    expect(v.contracts).toEqual([1, 2, 3]);
    expect(v.host_families).toEqual({ board: 1, host: 1 });
    // MUTATION: add a contract in contract.ts and not in package.json's
    // `qcrContracts` (what a host that packages a release reads) — this fails.
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
      qcrContracts: { supported: number[]; host_families: Record<string, number> };
    };
    expect(pkg.qcrContracts.supported).toEqual(supportedContracts());
    expect(pkg.qcrContracts.host_families).toEqual(hostFamilies());
  });

  // MUTATION: add a state to REVIEWING_STATES (or a problem, a verdict, a
  // reviewer state) without the schema — this fails, naming the set.
  it("the schema file is the family's version and lists the code's closed sets", () => {
    type Props = Record<string, { enum?: string[]; const?: unknown; maxItems?: number }>;
    const props = (node: unknown): Props => (node as { properties: Props }).properties;
    const defs = schema["$defs"] as Record<string, unknown>;
    expect(schema["$id"]).toBe(`board.v${BOARD_SCHEMA_VERSION}.json`);
    expect(props(schema)["schema_version"]!.const).toBe(hostPayloadVersion("board", 3));
    expect(props(schema)["reviewer"]!.enum).toEqual([...REVIEWER_STATES]);
    expect(props(schema)["model_login"]!.enum).toEqual([...CREDENTIAL_WORDS]);
    expect(props(schema)["github"]!.enum).toEqual([...CREDENTIAL_WORDS]);
    expect(props(props(schema)["identity"])["mode"]!.enum).toEqual([...IDENTITY_MODES]);
    expect(props(defs["reviewing"])["state"]!.enum).toEqual([...REVIEWING_STATES]);
    expect(props(defs["reviewing"])["problem"]!.enum).toEqual([...REVIEWING_PROBLEMS]);
    expect(props(defs["reviewed"])["verdict"]!.enum).toEqual([...VERDICTS]);
    expect(props(defs["reviewed"])["posted_event"]!.enum).toEqual([...POSTED_EVENTS]);
    for (const list of ["reviewing", "reviewed", "open"])
      expect(props(schema)[list]!.maxItems, list).toBe(BOARD_LIST_CAP);
  });
});
