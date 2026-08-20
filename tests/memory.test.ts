// Memory model — parser, timeline ordering, and the pi-memory
// implementation's remote argv (memedit knowledge lives in
// src/memory/pi-memory.ts and nowhere else; the seam itself is exercised
// against fakes in memory-store.test.ts).
import { describe, expect, it } from "vitest";
import type { TuiConfig } from "../src/config.js";
import { blockHash, memEditArgv, memoryCatArgv, parseMemory } from "../src/memory/pi-memory.js";
import { defectEntries, timelineOrder } from "../src/tui/memory.js";

const SAMPLE = `<!-- 2026-08-18 23:03:08 [01a0165a] -->
#bug #operations [[pass-registry]] On 2026-08-18, built pass definitions
existed but dist omitted the extension.

<!-- 2026-08-19 18:13:54 [01a01ab3] -->
#false-positive #eod-learning [[pr-5308]] type: false-positive — compare
transforms with the merge base first.

#refuted #eod-learning [[pr-5242]] type: refuted — External Apps omission is
deliberate.

<!-- 2026-08-20 09:01:42 [01a01b03] -->
#pinned #repo-gotcha guard 2 can suppress a same-head substantive review.
`;

const cfg = {
  ssh_host: "my-vm",
  container: "quickreview-sandbox",
  remote_state_dir: "/opt/quickreview/state",
  remote_sandbox_root: "/opt/quickreview/sandbox",
  sudo_docker: true,
  poll_interval_s: 5,
  stale_after_s: 90,
  msg_timeout_s: 10,
} as TuiConfig;

describe("parseMemory", () => {
  it("splits batches on header comments and blocks on blank lines", () => {
    const entries = parseMemory(SAMPLE);
    expect(entries).toHaveLength(4);
    expect(entries[0]).toMatchObject({ id: "01a0165a", day: "2026-08-18", block: 0 });
    expect(entries[0]!.hash).toBe(blockHash(entries[0]!.text)); // the token every addressed op carries back
    expect(entries[1]).toMatchObject({ id: "01a01ab3", block: 0 });
    expect(entries[2]).toMatchObject({ id: "01a01ab3", block: 1 });
    expect(entries[3]).toMatchObject({ id: "01a01b03", block: 0, pinned: true });
  });

  it("extracts tags and wiki links", () => {
    const entries = parseMemory(SAMPLE);
    expect(entries[0]!.tags).toEqual(["bug", "operations"]);
    expect(entries[0]!.links).toEqual(["pass-registry"]);
    expect(entries[1]!.tags).toContain("eod-learning");
  });

  it("keeps multi-line block text joined and trimmed", () => {
    const entries = parseMemory(SAMPLE);
    expect(entries[0]!.text).toContain("dist omitted the extension.");
    expect(entries[0]!.text.startsWith("#bug")).toBe(true);
  });

  it("parses an empty or headerless file safely", () => {
    expect(parseMemory("")).toEqual([]);
    const loose = parseMemory("just a preamble line\n");
    expect(loose).toEqual([]); // headerless text has no batch identity
  });
});

describe("timelineOrder", () => {
  it("floats pinned first, then newest ts", () => {
    const ordered = timelineOrder(parseMemory(SAMPLE));
    expect(ordered[0]!.pinned).toBe(true);
    expect(ordered[1]!.ts).toBe("2026-08-19 18:13:54");
    expect(ordered[ordered.length - 1]!.day).toBe("2026-08-18");
  });
});

describe("defectEntries", () => {
  it("selects #bug entries only", () => {
    const defects = defectEntries(parseMemory(SAMPLE));
    expect(defects).toHaveLength(1);
    expect(defects[0]!.id).toBe("01a0165a");
  });
});

describe("remote argv", () => {
  it("reads MEMORY.md via docker exec", () => {
    const argv = memoryCatArgv(cfg);
    expect(argv.slice(0, 4)).toEqual(["sudo", "docker", "exec", "quickreview-sandbox"]);
    expect(argv.join(" ")).toContain("MEMORY.md");
  });

  it("addressed ops carry id/ts/block/expect on argv, payload on stdin", () => {
    const entries = parseMemory(SAMPLE);
    const e = entries[1]!;
    const { argv, stdin } = memEditArgv(cfg, { op: "edit", id: e.id, ts: e.ts, block: e.block, expect: blockHash(e.text), text: "new text" });
    const script = argv[argv.length - 1]!;
    expect(script).toContain("memedit.mjs");
    expect(script).toContain(`--id '01a01ab3'`);
    expect(script).toContain(`--ts '2026-08-19 18:13:54'`);
    expect(script).toContain("--block 0");
    expect(stdin).toBe("new text");
    expect(argv).toContain("-i"); // stdin rides docker exec -i
  });

  it("sanitizes hostile ids and refuses malformed timestamps", () => {
    const { argv } = memEditArgv(cfg, { op: "retire", id: "x'; rm -rf /", ts: "2026-08-19 18:13:54", block: 0, expect: "abc" });
    const script = argv[argv.length - 1]!;
    expect(script).not.toContain("rm -rf");
    expect(/--id '[\w.:-]*'/.test(script)).toBe(true);
    expect(() => memEditArgv(cfg, { op: "retire", id: "a", ts: "'; reboot; '", block: 0, expect: "abc" })).toThrow(/bad memory ts/);
  });

  it("keeps benign ids intact", () => {
    const { argv } = memEditArgv(cfg, { op: "retire", id: "01a01ab3.p2", ts: "2026-08-19 18:13:54", block: 1, expect: "0123abc" });
    expect(argv[argv.length - 1]).toContain("--id '01a01ab3.p2'");
  });

  it("distinguishes two batches sharing one session id by ts", () => {
    const twice = `<!-- 2026-08-19 18:13:54 [01a01ab3] -->\nfirst batch lesson.\n\n<!-- 2026-08-19 18:19:32 [01a01ab3] -->\nsecond batch lesson.\n`;
    const entries = parseMemory(twice);
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => `${e.ts}|${e.id}|${e.block}`)).toEqual([
      "2026-08-19 18:13:54|01a01ab3|0",
      "2026-08-19 18:19:32|01a01ab3|0",
    ]);
  });

  it("add sends text on stdin with no address", () => {
    const { argv, stdin } = memEditArgv(cfg, { op: "add", text: "a standing rule" });
    expect(argv[argv.length - 1]).toContain("memedit.mjs' add");
    expect(stdin).toBe("a standing rule");
  });
});
