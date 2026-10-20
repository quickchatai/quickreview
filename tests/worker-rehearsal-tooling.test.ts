// [P8.20a] The pre-deletion worker rehearsal's tooling (scripts/worker-rehearsal.sh and
// scripts/worker-rehearsal/): the pieces that need no docker. The rehearsal itself is the
// script's run, written up in docs/worker-rehearsal.md; this holds what it stands on.
//
//   - patch-toml.mjs edits a config without touching its comments;
//   - the stub plays a round the way the round template asks (join the wave, run the
//     validator, commit the verdict, post through the shim), answers a leaf with NONE, and
//     refuses every GitHub mutation (the rehearsal's no-GitHub claim rests on that);
//   - report.mjs renders a run, and the committed report is one whose checks all passed and
//     names every check the script defines.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "..");
const RH = join(ROOT, "scripts", "worker-rehearsal");
const hasOpenssl = (() => {
  try {
    execFileSync("openssl", ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

const freePort = (): Promise<number> =>
  new Promise((ok, fail) => {
    const s = net.createServer();
    s.once("error", fail);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address() as net.AddressInfo;
      s.close(() => ok(port));
    });
  });

describe("[P8.20a] patch-toml.mjs", () => {
  it("replaces a key in place, adds a missing one to its section and appends a missing section, keeping comments", () => {
    const dir = mkdtempSync(join(tmpdir(), "rh-toml-"));
    try {
      const f = join(dir, "c.toml");
      writeFileSync(
        f,
        'dry_run = false # the flag\n\n[github]\nrepo = ""  # fill\nbase_branch = "main"\n\n[models.tiers]\n"sol-high" = "x/y:high"\n\n[pi]\nversion = "1.3.0"\n',
      );
      execFileSync("node", [
        join(RH, "patch-toml.mjs"),
        f,
        "dry_run=true",
        'github.repo="o/r"',
        'github.clone_dir="base-clone"',
        'models.tiers."sol-high"="local/m"',
        'tui.target="local"',
      ]);
      const out = readFileSync(f, "utf8");
      expect(out).toContain("dry_run = true");
      expect(out).toContain('repo = "o/r"');
      expect(out).toMatch(
        /\[github\]\nrepo = "o\/r"\nbase_branch = "main"\nclone_dir = "base-clone"\n/,
      );
      expect(out).toContain('"sol-high" = "local/m"');
      expect(out).toContain('[pi]\nversion = "1.3.0"');
      expect(out).toMatch(/\[tui\]\ntarget = "local"/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe.skipIf(!hasOpenssl)("[P8.20a] the scripted stub", () => {
  let dir = "";
  let httpPort = 0;
  let httpsPort = 0;
  let proc: ReturnType<typeof spawn>;
  const HEAD = "a".repeat(40);

  const post = (path: string, body: unknown): Promise<{ status: number; text: string }> =>
    new Promise((ok, fail) => {
      const req = http.request(
        { host: "127.0.0.1", port: httpPort, path, method: "POST" },
        (res) => {
          let text = "";
          res.on("data", (c) => (text += c));
          res.on("end", () => ok({ status: res.statusCode ?? 0, text }));
        },
      );
      req.on("error", fail);
      req.end(JSON.stringify(body));
    });

  const gh = (
    method: string,
    path: string,
    o: { host?: string; body?: string } = {},
  ): Promise<{ status: number; text: string }> =>
    new Promise((ok, fail) => {
      const req = https.request(
        {
          host: "127.0.0.1",
          port: httpsPort,
          path,
          method,
          rejectUnauthorized: false,
          ...(o.host ? { headers: { host: o.host } } : {}),
        },
        (res) => {
          let text = "";
          res.on("data", (c) => (text += c));
          res.on("end", () => ok({ status: res.statusCode ?? 0, text }));
        },
      );
      req.on("error", fail);
      req.end(o.body);
    });

  /** The tool call the stub makes next, or its text, from the SSE the reply streams. */
  const next = async (
    user: string,
    nTail: number,
  ): Promise<{ tool?: string; args?: any; text?: string }> => {
    const messages: any[] = [
      { role: "system", content: "s" },
      { role: "user", content: user },
    ];
    for (let i = 0; i < nTail; i++)
      messages.push(
        { role: "assistant", content: "x" },
        { role: "tool", tool_call_id: `t${i}`, content: "ok" },
      );
    const res = await post("/v1/chat/completions", {
      messages,
      tools: [{ function: { name: "bash" } }, { function: { name: "write" } }],
    });
    expect(res.status).toBe(200);
    let tool: string | undefined;
    let args = "";
    let text = "";
    for (const line of res.text.split("\n")) {
      if (!line.startsWith("data: ") || line.includes("[DONE]")) continue;
      const d = JSON.parse(line.slice(6)).choices?.[0]?.delta ?? {};
      for (const c of d.tool_calls ?? []) {
        tool = c.function.name;
        args += c.function.arguments;
      }
      text += d.content ?? "";
    }
    return tool ? { tool, args: JSON.parse(args) } : { text };
  };

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "rh-stub-"));
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        join(dir, "leaf.key"),
        "-out",
        join(dir, "leaf.crt"),
        "-days",
        "1",
        "-subj",
        "/CN=api.github.com",
      ],
      { stdio: "ignore" },
    );
    writeFileSync(
      join(dir, "fixture.json"),
      JSON.stringify({
        repo: "o/r",
        pr: 7,
        title: "t",
        author: "alice",
        app_slug: "app",
        trigger_label: "AI review requested",
        head_sha: HEAD,
        base_sha: "b".repeat(40),
        heads: [HEAD],
        files: [],
      }),
    );
    writeFileSync(join(dir, "log.jsonl"), "");
    httpPort = await freePort();
    httpsPort = await freePort();
    proc = spawn(
      "node",
      [join(RH, "stub.mjs"), join(dir, "fixture.json"), dir, join(dir, "log.jsonl")],
      {
        env: {
          ...process.env,
          QCR_STUB_HTTP_PORT: String(httpPort),
          QCR_STUB_HTTPS_PORT: String(httpsPort),
          QCR_STUB_HOST: "127.0.0.1",
        },
        stdio: "ignore",
      },
    );
    for (let i = 0; i < 100; i++) {
      if (
        readFileSync(join(dir, "log.jsonl"), "utf8")
          .split("\n")
          .filter((l) => l.includes('"up"')).length >= 2
      )
        return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error("the stub did not come up");
  });
  afterAll(() => {
    proc?.kill("SIGKILL");
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  const ORDER = `# Review round — first review\n**ROUND: first** — PR #7 ("t")\nplan: pass-baseline--sol-high pass-tests--terra-med pass-validate--sol-high\n<!-- qcr-round: pr-7 round-3 -->`;

  it("plays a round: lens_wave, the validator, the verdict and review files, the commit, the post, then done", async () => {
    await post("/admin/mode", { mode: "round" });
    const a = await next(ORDER, 0);
    expect(a.tool).toBe("lens_wave");
    const b = await next(ORDER, 1);
    expect(b.tool).toBe("lens");
    expect(b.args.agent).toBe("pass-validate--sol-high");
    const review = await next(ORDER, 2);
    expect(review.tool).toBe("write");
    expect(review.args.path).toBe("state/pr-7-round-3-review.md");
    const verdict = await next(ORDER, 3);
    expect(verdict.tool).toBe("write");
    expect(verdict.args.path).toBe("verdict/pr-7-round-3.json.tmp");
    const body = JSON.parse(verdict.args.content);
    expect(body).toMatchObject({ pr: 7, round_no: 3, verdict: "REQUEST_CHANGES", head_sha: HEAD });
    expect(body.passes.map((p: { name: string }) => p.name)).toEqual([
      "pass-baseline",
      "pass-tests",
      "pass-validate",
    ]);
    expect((await next(ORDER, 4)).args.command).toBe("scripts/commit-verdict.sh pr-7-round-3.json");
    expect((await next(ORDER, 5)).args.command).toContain(
      "scripts/post-review.sh 7 REQUEST_CHANGES state/pr-7-round-3-review.md",
    );
    const record = await next(ORDER, 6);
    expect(record.tool).toBe("write");
    expect(record.args.path).toBe("state/findings/pr-7-round-3.json");
    expect(JSON.parse(record.args.content)).toEqual({ pr: 7, round_no: 3, findings: [] });
    const done = (await next(ORDER, 7)).text;
    expect(done).toMatch(/^round done/);
    expect(done).toContain(`LEDGER PR #7 @ ${HEAD}`);
  });

  it("reports the plan table's lenses as the verdict's passes, not every agent the order names", async () => {
    await post("/admin/mode", { mode: "round" });
    const order = [
      "# Review round — re-review",
      "**ROUND: re-review** — PR #7",
      "**Pass plan for this round** (chosen by the daemon):",
      "",
      "| lens | lens to call | tier | may raise to | focus / why |",
      "| --- | --- | --- | --- | --- |",
      "| pass-baseline | `pass-baseline--sol-high` | sol-high | — (pinned) | every round |",
      "| pass-tests | `pass-tests--terra-med` | terra-med | `pass-tests--sol-med`, `pass-tests--sol-high` | code |",
      "| pass-validate | `pass-validate--sol-high` | sol-high | — (pinned) |  |",
      "",
      "The sweep's own plan:",
      "| pass-sweep | `pass-sweep--sol-high` | sol-high | — (pinned) | files |",
      "<!-- qcr-round: pr-7 round-4 -->",
    ].join("\n");
    const verdict = await next(order, 3);
    expect(verdict.args.path).toBe("verdict/pr-7-round-4.json.tmp");
    expect(
      JSON.parse(verdict.args.content).passes.map((p: { name: string; tier: string }) => [
        p.name,
        p.tier,
      ]),
    ).toEqual([
      ["pass-baseline", "sol-high"],
      ["pass-tests", "terra-med"],
      ["pass-validate", "sol-high"],
    ]);
  });

  it("plays a round a worker took over from its order, not as a lens leaf", async () => {
    await post("/admin/mode", { mode: "round" });
    // the killed worker's order, then the taking-over worker's continuation turn
    const res = await post("/v1/chat/completions", {
      messages: [
        { role: "system", content: "s" },
        { role: "user", content: ORDER },
        {
          role: "user",
          content:
            "The worker that was running this round stopped before the round finished; this conversation is intact. Carry on from where it stopped.",
        },
      ],
      tools: [{ function: { name: "bash" } }, { function: { name: "write" } }],
    });
    expect(res.status).toBe(200);
    expect(res.text).toContain('"name":"lens_wave"');
  });

  it("fires a burst of parallel passes when told to, and delays only their answers", async () => {
    await post("/admin/mode", { mode: "round", burst: 3, burstMs: 1 });
    expect((await next(ORDER, 0)).tool).toBe("lens_wave");
    const burst = await next(ORDER, 1);
    expect(burst.tool).toBe("lens");
    expect(burst.args.tasks).toHaveLength(3);
    expect(burst.args.tasks[0].task).toBe("Burst 1: reply NONE.");
    expect((await next("Task: Burst 2: reply NONE.", 0)).text).toBe("NONE");
    await post("/admin/mode", { mode: "round" });
  });

  it("answers an operator's message with a thread reply through the shim, its exit status unmasked", async () => {
    await post("/admin/mode", { mode: "answer_post", comment: 9001 });
    const reply = await next("Please answer the author's question.", 0);
    expect(reply.tool).toBe("bash");
    expect(reply.args.command).toContain(
      "scripts/reply-thread.sh 7 9001 state/pr-7-answer-reply.md",
    );
    expect(reply.args.command).not.toMatch(/;\s*echo/);
    await post("/admin/mode", { mode: "round" });
  });

  it("answers a lens leaf with NONE and fails every request when told to", async () => {
    await post("/admin/mode", { mode: "round" });
    expect((await next("Task: Task file: /x/tasks/01-pass-baseline--sol-high.md.", 0)).text).toBe(
      "NONE",
    );
    await post("/admin/mode", { mode: "fail" });
    const res = await post("/v1/chat/completions", { messages: [{ role: "user", content: "hi" }] });
    expect(res.status).toBe(500);
    await post("/admin/mode", { mode: "round" });
  });

  it("answers the login's OAuth refresh as auth.openai.com, with a rotated refresh token", async () => {
    const host = "auth.openai.com";
    const body = "grant_type=refresh_token&refresh_token=old&client_id=x";
    const first = await gh("POST", "/oauth/token", { host, body });
    expect(first.status).toBe(200);
    const token = JSON.parse(first.text);
    expect(token.expires_in).toBeGreaterThan(3600);
    const claims = JSON.parse(atob(token.access_token.split(".")[1]));
    expect(claims["https://api.openai.com/auth"].chatgpt_account_id).toBe("rehearsal-account");
    const second = JSON.parse((await gh("POST", "/oauth/token", { host, body })).text);
    expect(second.refresh_token).not.toBe(token.refresh_token);
    expect((await gh("GET", "/oauth/token", { host })).status).toBe(404);
    // never a GitHub mutation: it is the login's own host
    expect(readFileSync(join(dir, "log.jsonl"), "utf8")).not.toMatch(/github-mutation.*oauth/);
  });

  it("serves GitHub's reads and refuses every mutation, recording it", async () => {
    await post("/admin/github", { triggered: true, head: HEAD });
    expect((await gh("GET", "/repos/o/r/pulls/7")).status).toBe(200);
    expect(
      JSON.parse((await gh("GET", "/search/issues?q=repo:o/r+label:x")).text).items,
    ).toHaveLength(1);
    expect((await gh("POST", "/repos/o/r/pulls/7/reviews")).status).toBe(403);
    expect((await gh("DELETE", "/repos/o/r/issues/7/labels/x")).status).toBe(403);
    const log = readFileSync(join(dir, "log.jsonl"), "utf8");
    expect(log.match(/"kind":"github-mutation"/g)).toHaveLength(2);
  });
});

describe("[P8.20a] the rehearsal's scripts and report", () => {
  it("every script parses", () => {
    for (const f of [
      "scripts/worker-rehearsal.sh",
      "scripts/worker-rehearsal/build-images.sh",
      "scripts/worker-rehearsal/layout.sh",
      "scripts/worker-rehearsal/legacy-db.sh",
    ])
      execFileSync("bash", ["-n", join(ROOT, f)]);
    for (const f of ["stub.mjs", "patch-toml.mjs", "report.mjs"])
      execFileSync("node", ["--check", join(RH, f)]);
    execFileSync("python3", [
      "-I",
      "-c",
      `import ast,sys; ast.parse(open(sys.argv[1]).read())`,
      join(RH, "pty-drive.py"),
    ]);
  });

  it("report.mjs renders the results table and counts", () => {
    const dir = mkdtempSync(join(tmpdir(), "rh-report-"));
    try {
      writeFileSync(
        join(dir, "r.tsv"),
        "A-1\tpass\tfirst thing\tit held\nB-2\tfail\tsecond thing\tit did not\n",
      );
      writeFileSync(join(dir, "f.tsv"), "capture\tstub_requests={}\n");
      execFileSync("node", [
        join(RH, "report.mjs"),
        join(dir, "r.tsv"),
        join(dir, "f.tsv"),
        join(dir, "out.md"),
        "abc1234",
      ]);
      const md = readFileSync(join(dir, "out.md"), "utf8");
      expect(md).toContain("**1 of 2 checks passed, 1 failed.**");
      expect(md).toContain("| A-1 | first thing | pass | it held |");
      expect(md).toContain("| B-2 | second thing | **FAIL** | it did not |");
      expect(md).toContain("abc1234");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the committed report is a run whose checks all passed, and names every check the script defines", () => {
    const report = join(ROOT, "docs", "worker-rehearsal.md");
    expect(existsSync(report)).toBe(true);
    const md = readFileSync(report, "utf8");
    expect(md).toMatch(/\*\*(\d+) of \1 checks passed, 0 failed\.\*\*/);
    const script = readFileSync(join(ROOT, "scripts", "worker-rehearsal.sh"), "utf8");
    const ids = [...script.matchAll(/\bcheck ([A-Z]+-\d+) (?:pass|fail)/g)].map((m) => m[1]!);
    expect(ids.length).toBeGreaterThanOrEqual(15);
    for (const id of new Set(ids)) expect(md, `check ${id}`).toContain(`| ${id} |`);
  });
});
