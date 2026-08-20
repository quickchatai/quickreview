// shellQuote (src/tui/remote.ts) — the empty-tab root cause. ssh space-joins
// argv into one remote string; unquoted, a multi-word `sh -c <script>`
// element was shredded into separate words (`sh -c cat '/x' || true` ran
// bare `cat` on empty stdin, `|| true` masked it) — every dockerSh() read
// silently returned nothing. shellQuote makes the remote shell rebuild the
// exact argv.
import { describe, expect, it } from "vitest";
import { shellQuote } from "../src/tui/remote.js";

const SQ = "'";
const ESCAPED_SQ = SQ + "\\" + SQ + SQ; // the POSIX '\'' dance

describe("shellQuote", () => {
  it("keeps simple tokens bare and quotes scripts whole", () => {
    expect(shellQuote("sudo")).toBe("sudo");
    expect(shellQuote("/opt/quickreview/sandbox")).toBe("/opt/quickreview/sandbox");
    const script = "cat /x 2>/dev/null || true";
    const q = shellQuote(script);
    expect(q).toBe(SQ + script + SQ);
  });

  it("escapes embedded single quotes so the remote shell rebuilds the exact argv", () => {
    expect(shellQuote("echo " + SQ + "a b" + SQ)).toBe(SQ + "echo " + ESCAPED_SQ + "a b" + ESCAPED_SQ + SQ);
  });

  it("a full dockerSh argv joins into one remote token per element", () => {
    const argv = ["sudo", "docker", "exec", "c", "sh", "-c", "ls " + SQ + "x y" + SQ + " || true"];
    const joined = argv.map(shellQuote).join(" ");
    expect(joined).toBe("sudo docker exec c sh -c " + SQ + "ls " + ESCAPED_SQ + "x y" + ESCAPED_SQ + " || true" + SQ);
  });

  it("round-trips through a real local shell: the argv comes back intact", async () => {
    // Same mechanism ssh uses remotely: hand the flattened string to sh and
    // check the child sees the original elements.
    const { execFileSync } = await import("node:child_process");
    const script = "printf %s " + SQ + "/a b/c.md" + SQ; // path with a space
    const flat = ["sh", "-c", script].map(shellQuote).join(" ");
    const out = execFileSync("sh", ["-c", flat], { encoding: "utf8" });
    expect(out).toBe("/a b/c.md");
  });
});
