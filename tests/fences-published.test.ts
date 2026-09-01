// fences over the PUBLISHED surface: the shipped configs, and the
// manifesto's mechanically-checkable claims. See tests/fences.test.ts for the
// three rules all of these are written under.
//
// This map gates publication, and the manifesto closes with "where the
// codebase drifts from a principle, the drift is the bug". It is currently
// referenced by `README.md` and asserted by no test at all. Two of its claims
// can be checked by a machine; these are them.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..");

/** Every file under a tree, recursively. */
function allFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? allFiles(join(dir, e.name)) : [join(dir, e.name)],
  );
}

function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !/^\s*(\/\/|\*)/.test(l))
    .map((l) => l.replace(/\/\/.*$/, ""))
    .join("\n");
}

/** Members of a `export const X: readonly T[] = ["a", "b"];` array literal. */
function arrayMembers(relPath: string, name: string): string[] {
  const text = stripComments(readFileSync(join(ROOT, relPath), "utf8"));
  const m = new RegExp(`export const ${name}\\b[^=]*=\\s*\\[([\\s\\S]*?)\\]`).exec(text);
  if (!m?.[1]) throw new Error(`array ${name} not found in ${relPath} — the fence over it is now vacuous`);
  const members = [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]!);
  if (members.length === 0) throw new Error(`array ${name} in ${relPath} parsed to zero members`);
  return members;
}

// ---------------------------------------------------------------------------
// [T11] A shipped config must not describe a retired state
// ---------------------------------------------------------------------------

describe("[T11] the shipped configs describe the system that exists", () => {
  /**
   * `config.example.toml` is the first file a stranger reads, and [P1]
   * found it describing the park as live — which survived every previous
   * review precisely because the sentence's FIRST clause was true. A reader
   * who checks the first half stops reading.
   *
   * The park was retired 2026-08-19: a session always decides on the
   * merits, and `awaiting_human` is unreachable. The prose in both files was
   * corrected here; this keeps it corrected.
   *
   * MUTATION: put `the round parks on awaiting_human` back into a comment in
   * config.example.toml — this fails.
   */
  const RETIRED_PRESENT_TENSE = [
    /\bparks?\s+(on|as)\b/i,
    /\bis\s+parked\b/i,
    /\bwaits?\s+for\s+a\s+(person|human)\b/i,
    /\bhanded\s+(back\s+)?to\s+a\s+(person|human)\b/i,
  ];

  /**
   * The remnants that are CODE, not prose: a knob the config parses and a
   * Slack cause keyed on a state nothing can enter. Removing them means
   * editing `src/config.ts` and `src/slack/`, which is's [A10]/[P50]
   * cut and not a comment fix. Both ship DISABLED, so they are inert —
   * recorded so a reader can tell them from an oversight, and so a THIRD one
   * cannot appear quietly.
   */
  const RETIRED_KNOBS_PENDING_REMOVAL = ["awaiting_human_stale_h", "pr.awaiting_human_stale"];

  for (const file of ["config.toml", "config.example.toml"]) {
    it(`${file} carries no present-tense park`, () => {
      const lines = readFileSync(join(ROOT, file), "utf8").split("\n");
      const offenders: string[] = [];
      for (const [i, line] of lines.entries()) {
        if (RETIRED_KNOBS_PENDING_REMOVAL.some((k) => line.includes(k))) continue;
        // A sentence that RECORDS the retirement necessarily names it.
        // A line that RECORDS the retirement necessarily names the thing it
        // retired, and a line that NEGATES it ("is never handed to a human")
        // says the pattern out loud in order to deny it.
        if (/\b(retired|never|no park|was |removed|no longer)\b/i.test(line)) continue;
        if (RETIRED_PRESENT_TENSE.some((re) => re.test(line))) offenders.push(`${file}:${i + 1}  ${line.trim()}`);
      }
      expect(offenders, "a shipped config describes the retired park as current behaviour").toEqual([]);
    });
  }

  it("the only awaiting_human remnants in the shipped configs are the two recorded knobs", () => {
    const found = new Set<string>();
    for (const file of ["config.toml", "config.example.toml"]) {
      for (const line of readFileSync(join(ROOT, file), "utf8").split("\n")) {
        if (!/awaiting_human/.test(line)) continue;
        const hit = RETIRED_KNOBS_PENDING_REMOVAL.find((k) => line.includes(k));
        found.add(hit ?? `UNRECORDED: ${file} → ${line.trim()}`);
      }
    }
    expect(
      [...found].sort(),
      "an awaiting_human reference appeared in a shipped config that is not one of the two recorded knobs",
    ).toEqual([...RETIRED_KNOBS_PENDING_REMOVAL].sort());
  });
});

// ---------------------------------------------------------------------------
// The manifesto's checkable claims
// ---------------------------------------------------------------------------

describe("MANIFESTO.md is pinned by something", () => {
  const manifesto = () => readFileSync(join(ROOT, "MANIFESTO.md"), "utf8");

  /**
   * The lens count (MC-20) — and the one claim that has already drifted: the
   * document says nine, which was the ORIGINAL frozen seed set.
   *
   * Correcting the public wording is, and that ticket is
   * `ready-for-human`: the manifesto is a public promise and its rewrite is
   * the owner's, not an agent's. So the divergence is RECORDED in the
   * self-retiring shape used elsewhere in these fences — it fails if the
   * count drifts to a third value, and it fails the moment the owner fixes
   * the sentence, forcing the record's deletion and the assertion's flip to
   * the direct form.
   *
   * The derived count is checked two ways that must agree, so the fence
   * cannot be satisfied by one of them rotting.
   *
   * MUTATION: change "nine" to "eleven" in MANIFESTO.md — this fails.
   */
  it("the stated lens count is the recorded stale one, and the real count is derived two ways", () => {
    const WORDS: Record<string, number> = {
      eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
    };
    const KNOWN_STALE_LENS_WORD = "nine"; //, ready-for-human

    const stated = /\b(\w+)\s+specialized lenses\b/.exec(manifesto())?.[1];
    expect(stated, "MANIFESTO.md no longer states a lens count in the shape this fence reads").toBeTruthy();

    const passFiles = readdirSync(join(ROOT, "agents")).filter((f) => /^pass-.*\.md$/.test(f));
    const allPasses = arrayMembers("src/dispatch.ts", "ALL_PASSES");
    expect(
      allPasses.length,
      "ALL_PASSES and agents/pass-*.md disagree — a lens with no agent file, or an agent file with no plan entry",
    ).toBe(passFiles.length);

    // pass-validate is the adversarial validator, never a lens.
    const lensCount = allPasses.filter((p) => p !== "pass-validate").length;
    expect(lensCount).toBeGreaterThan(0);

    if (WORDS[stated!] === lensCount) {
      throw new Error(
        `MANIFESTO.md now states the true lens count (${lensCount}) — delete KNOWN_STALE_LENS_WORD and assert it directly`,
      );
    }
    expect(
      stated,
      `MANIFESTO.md's lens count drifted to a third value; the truth is ${lensCount} (owns the rewrite)`,
    ).toBe(KNOWN_STALE_LENS_WORD);
  });

  /**
   * THE EGRESS ALLOWLIST — the assertion that makes the sovereignty claim
   * checkable rather than merely honest (MC-24). Every hostname literal in
   * `src/` and the deploy/docker templates must be on this list WITH A REASON.
   *
   * That is the point of the shape: the list is not "hosts we happen to
   * contact", it is "hosts a reader can verify we contact, and why". A new
   * host — a telemetry endpoint, an update check, a vendor SDK — fails here
   * and has to be argued for in the diff that adds it.
   *
   * MUTATION: add `fetch("https://telemetry.example.com/x")` anywhere under
   * src/ — this fails naming the host.
   */
  it("no hostname reaches src/ or the deploy templates without a recorded reason", () => {
    const EGRESS: ReadonlyArray<{ host: string; why: string }> = [
      { host: "api.github.com", why: "GitHub's REST API — every read, and every gated write. Where the reviewed code already lives." },
      { host: "github.com", why: "GitHub web + the git remote: PR URLs the operator opens, and the clone/fetch of the reviewed repo." },
      { host: "cli.github.com", why: "the `gh` CLI apt keyring, in the daemon image BUILD. Build-time only, never during a review." },
      { host: "deb.nodesource.com", why: "the Node apt repository, same image build. Build-time only, never during a review." },
      { host: "slack.com", why: "the Slack concierge, DEFAULT OFF — carries verdicts and reply text once an operator enables it." },
      {
        host: "api.slack.com",
        why:
          "the same Slack leg, named separately by the setup wizard (deploy/collect-slack-secrets.mjs). Worth its own "
          + "entry: the compliance audit's egress inventory said 'Slack' once, and this fence found the second spelling.",
      },
      { host: "pkg.cloudflare.com", why: "the cloudflared apt repository, in the ansible provision play. Build/provision time only." },
      { host: "localhost", why: "a loopback URL in deploy/ansible/README.md's operator instructions — the same leg as 127.0.0.1." },
      {
        host: "example.com",
        why: "the RFC-2606 reserved example domain, used as a placeholder in deploy/github-app-manifest.json. Reserved never to resolve.",
      },
      {
        host: "REPLACE-WITH-YOUR-WEBHOOK-HOST",
        why:
          "not a host at all — a FILL marker in the GitHub App manifest template, and it is meant to be conspicuous. "
          + "It is listed rather than pattern-excluded so a reader sees that the scan saw it.",
      },
      { host: "127.0.0.1", why: "loopback: the webhook listener and the OpenViking memory server. Nothing here leaves the host." },
      { host: "daemon", why: "a docker-compose SERVICE name, not a public host — it resolves only on the compose network." },
      { host: "host", why: "docker's `host.docker.internal` family in a compose template — the container's own host, not the internet." },
      {
        host: "foo-bar-baz.trycloudflare.com",
        why: "a PLACEHOLDER in the tunnel template, showing an operator what a quick-tunnel URL looks like. Nothing resolves it.",
      },
      { host: "x.ngrok-free.app", why: "the same placeholder role for the ngrok ingress shape, in operator-facing text." },
      {
        host: "mcp.example.com",
        why:
          "a QUOTED EXAMPLE inside a PASS_ADDENDA regression boundary (src/include.ts) — a URL from a past finding, "
          + "reproduced verbatim so the rule keeps its worked example. Prose in a string; nothing fetches it. This entry is "
          + "why the fence lists hosts with reasons rather than asserting an empty set: a naive hostname grep flags it, and "
          + "an unexplained exclusion would be indistinguishable from hiding a real egress.",
      },
      { host: "support.example.com", why: "the same: the #5386 injection-adjudication example, quoted in an addendum. Prose in a string." },
    ];

    const seen = new Map<string, string>();
    for (const root of ["src", "deploy", "docker"]) {
      for (const f of allFiles(join(ROOT, root))) {
        if (/\.(png|jpg|jpeg|ico|gz|pem|lock)$/.test(f)) continue;
        for (const m of readFileSync(f, "utf8").matchAll(/https?:\/\/([A-Za-z0-9._-]+)/g)) {
          if (!seen.has(m[1]!)) seen.set(m[1]!, f.slice(ROOT.length + 1));
        }
      }
    }
    expect(seen.size, "no hostname was found at all — the scan broke and this asserts nothing").toBeGreaterThan(3);
    for (const e of EGRESS) expect(e.why.length, `${e.host} needs a reason a stranger can check`).toBeGreaterThan(30);

    const allowed = new Set(EGRESS.map((e) => e.host));
    const unlisted = [...seen.entries()].filter(([h]) => !allowed.has(h)).map(([h, f]) => `${h} (${f})`);
    expect(
      unlisted.sort(),
      "a hostname appears in src/ or a deploy template that the egress allowlist does not name. The manifesto "
        + "claims your code and your reviewer's memory stay on your infrastructure — add the host WITH its reason, or remove it.",
    ).toEqual([]);

    // …and the list must not rot in the other direction either.
    const stale = [...allowed].filter((h) => !seen.has(h));
    expect(stale.sort(), "the egress allowlist names a host that no longer appears anywhere — delete the entry").toEqual([]);
  });

  /**
   * MC-27. The manifesto said what the reviewer learns "is periodically mined
   * back into the instructions of the implementing agents". `feedback-mining`
   * is an agent SKILL a human runs: no code path, scheduler, timer or command
   * invokes it, and the skill's own text describes a human-run sweep. Pinning
   * the ABSENCE is what would have caught the claim.
   *
   * MUTATION: add a `feedback-mining` reference to package.json — this fails.
   */
  it("nothing in the code invokes the feedback-mining skill", () => {
    const hits: string[] = [];
    for (const root of ["src", "scripts"]) {
      for (const f of allFiles(join(ROOT, root))) {
        if (readFileSync(f, "utf8").includes("feedback-mining")) hits.push(f.slice(ROOT.length + 1));
      }
    }
    if (readFileSync(join(ROOT, "package.json"), "utf8").includes("feedback-mining")) hits.push("package.json");
    expect(
      hits,
      "feedback-mining is now invoked by code — the loop is automated, and the README/MANIFESTO wording that calls it "
        + "a documented human-run loop has to change with it",
    ).toEqual([]);
  });
});
