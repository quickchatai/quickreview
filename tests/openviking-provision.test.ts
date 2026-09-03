// boot provisioning for `auth_mode: "api_key"`.
//
// Three properties are pinned here, and each is an acceptance criterion of the
// ticket rather than an implementation detail:
//
//   1. IDEMPOTENCE. Re-running creates nothing and rotates nothing. A user that
//      is already there is left exactly as it is; an unreadable listing creates
//      NOTHING (guessing would mint a duplicate identity for a user who has
//      one, and orphan the key already distributed to the owner's PC).
//   2. NOTHING IS EVER A PASS BY DEFAULT. The reviewer-key check reuses the
//      confinement proof's own verdict logic: 2xx is reach, 401/403 refusal,
//      and anything else — including a 200 carrying an error envelope — is
//      INCONCLUSIVE and reported, never assumed fine.
//   3. MEMORY NEVER BLOCKS THE BOOT. Every failure path resolves a report; the
//      module never throws, and the CLI exits 0 unless asked to be strict.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
// A plain-JS script, deliberately dependency-free so the container entrypoint
// can run it before any TypeScript build exists. `tsconfig.tests.json` sets
// `allowJs`, so tsc now INFERS its exported shapes and this import needs no
// suppression — which is what makes the call sites below checked.
import * as prov from "../scripts/openviking-provision.mjs";

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

/** A fetch that answers from a scripted table and records every call. */
function fakeFetch(
  routes: Array<{ match: RegExp; method?: string; status: number; body?: unknown }>,
) {
  const calls: Call[] = [];
  // `init` is optional here because the module's seam declares it optional —
  // a two-required-parameter double is not assignable to it, which is how the
  // tests/ type-check catches a fake that has drifted from the real contract.
  const fetchFn = async (
    url: string,
    init?: { method?: string; headers?: Record<string, string>; body?: string },
  ) => {
    calls.push({
      url,
      method: init?.method ?? "GET",
      headers: init?.headers ?? {},
      body: init?.body,
    });
    const hit = routes.find(
      (r) => r.match.test(url) && (r.method === undefined || r.method === (init?.method ?? "GET")),
    );
    if (!hit) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: hit.status < 300, status: hit.status, json: async () => hit.body ?? {} };
  };
  return { fetchFn, calls };
}

const BASE = "http://127.0.0.1:1933";

describe("planProvision — the idempotence core", () => {
  it("creates only what is missing", () => {
    expect(prov.planProvision(["reviewer"], ["reviewer", "companion"])).toEqual({
      create: ["companion"],
      keep: ["reviewer"],
      unknown: [],
    });
  });

  it("a second run creates nothing", () => {
    expect(prov.planProvision(["reviewer", "companion"], ["reviewer", "companion"])).toEqual({
      create: [],
      keep: ["reviewer", "companion"],
      unknown: [],
    });
  });

  it("an UNREADABLE listing creates nothing at all", () => {
    // The dangerous branch: "I could not read it" must never read as "there is
    // nothing there" — that would mint a second identity for an existing user.
    expect(prov.planProvision(null, ["reviewer", "companion"])).toEqual({
      create: [],
      keep: [],
      unknown: ["reviewer", "companion"],
    });
  });

  it("dedupes and trims the wanted list", () => {
    expect(prov.planProvision([], [" reviewer ", "reviewer", "", "companion"]).create).toEqual([
      "reviewer",
      "companion",
    ]);
  });
});

describe("usersFromListing — tolerant of envelope shape, honest about garbage", () => {
  it("reads the shapes the server might use", () => {
    expect(
      prov.usersFromListing({ data: { users: [{ user_id: "reviewer" }, { id: "companion" }] } }),
    ).toEqual(["reviewer", "companion"]);
    expect(prov.usersFromListing({ users: ["reviewer"] })).toEqual(["reviewer"]);
    expect(prov.usersFromListing([{ name: "companion" }])).toEqual(["companion"]);
  });

  it("returns null — not [] — for anything that is not a listing", () => {
    expect(prov.usersFromListing({ status: "error" })).toBeNull();
    expect(prov.usersFromListing("nope")).toBeNull();
  });
});

describe("parseUserList", () => {
  it("splits the group_vars spelling", () => {
    expect(prov.parseUserList("reviewer,companion")).toEqual(["reviewer", "companion"]);
    expect(prov.parseUserList("reviewer, companion ")).toEqual(["reviewer", "companion"]);
    expect(prov.parseUserList("")).toEqual([]);
  });
});

describe("provision — one pass against a live-shaped server", () => {
  const listing = (users: string[]) => ({
    match: /\/admin\/accounts\/[^/]+\/users$/,
    method: "GET",
    status: 200,
    body: { users },
  });
  const reviewerReach = {
    match: /\/api\/v1\/fs\/ls/,
    method: "GET",
    status: 200,
    body: { entries: [] },
  };

  it("creates the missing user, keeps the present one, and confirms the reviewer key", async () => {
    const { fetchFn, calls } = fakeFetch([
      listing(["reviewer"]),
      { match: /\/admin\/accounts\/[^/]+\/users$/, method: "POST", status: 201, body: {} },
      reviewerReach,
    ]);
    const lines: string[] = [];
    const report = await prov.provision({
      base: BASE,
      account: "default",
      users: ["reviewer", "companion"],
      rootKey: "root-secret-value",
      reviewerKey: "reviewer-secret-value",
      fetchFn,
      log: (l: string) => lines.push(l),
    });
    expect(report).toMatchObject({
      created: ["companion"],
      kept: ["reviewer"],
      failed: [],
      reviewer: "reach",
      ok: true,
    });
    // The root key authenticates the ADMIN calls and nothing else; the probe
    // carries the reviewer key.
    const post = calls.find((c) => c.method === "POST")!;
    expect(post.headers["Authorization"]).toBe("Bearer root-secret-value");
    const probe = calls.find((c) => /fs\/ls/.test(c.url))!;
    expect(probe.headers["Authorization"]).toBe("Bearer reviewer-secret-value");
    expect(probe.headers["X-OpenViking-User"]).toBe("reviewer");
    // No key value is ever logged.
    expect(lines.join("\n")).not.toContain("secret-value");
  });

  it("is a no-op on the second run", async () => {
    const { fetchFn, calls } = fakeFetch([listing(["reviewer", "companion"]), reviewerReach]);
    const report = await prov.provision({
      base: BASE,
      account: "default",
      users: ["reviewer", "companion"],
      rootKey: "root",
      reviewerKey: "rev",
      fetchFn,
      log: () => {},
    });
    expect(report.created).toEqual([]);
    expect(report.kept).toEqual(["reviewer", "companion"]);
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("a 409 on create is success, not a failure — the user was already there", async () => {
    const { fetchFn } = fakeFetch([
      listing([]),
      { match: /\/users$/, method: "POST", status: 409, body: {} },
      reviewerReach,
    ]);
    const report = await prov.provision({
      base: BASE,
      account: "default",
      users: ["reviewer"],
      rootKey: "r",
      reviewerKey: "k",
      fetchFn,
      log: () => {},
    });
    expect(report.kept).toEqual(["reviewer"]);
    expect(report.failed).toEqual([]);
  });

  it("an unreadable listing provisions nothing and says so", async () => {
    const { fetchFn, calls } = fakeFetch([
      {
        match: /\/users$/,
        method: "GET",
        status: 200,
        body: { status: "error", error: { message: "nope" } },
      },
      reviewerReach,
    ]);
    const lines: string[] = [];
    const report = await prov.provision({
      base: BASE,
      account: "default",
      users: ["reviewer"],
      rootKey: "r",
      reviewerKey: "k",
      fetchFn,
      log: (l: string) => lines.push(l),
    });
    expect(report.created).toEqual([]);
    expect(report.ok).toBe(false);
    expect(calls.some((c) => c.method === "POST")).toBe(false);
    expect(lines.join("\n")).toContain("could not read the user listing");
  });

  it("a reviewer key that does NOT authenticate is reported — and never rotated", async () => {
    const { fetchFn, calls } = fakeFetch([
      listing(["reviewer", "companion"]),
      { match: /fs\/ls/, method: "GET", status: 403, body: {} },
    ]);
    const lines: string[] = [];
    const report = await prov.provision({
      base: BASE,
      account: "default",
      users: ["reviewer"],
      rootKey: "r",
      reviewerKey: "k",
      fetchFn,
      log: (l: string) => lines.push(l),
    });
    expect(report.reviewer).toBe("refused");
    expect(report.ok).toBe(false);
    expect(lines.join("\n")).toContain("NOT rotating");
    // Nothing was written: no key route was ever called.
    expect(calls.some((c) => /\/key$/.test(c.url))).toBe(false);
  });

  it("an ambiguous answer is INCONCLUSIVE, never a pass", async () => {
    const { fetchFn } = fakeFetch([
      listing(["reviewer"]),
      { match: /fs\/ls/, method: "GET", status: 500, body: {} },
    ]);
    const report = await prov.provision({
      base: BASE,
      account: "default",
      users: ["reviewer"],
      rootKey: "r",
      reviewerKey: "k",
      fetchFn,
      log: () => {},
    });
    expect(report.reviewer).toBe("inconclusive");
    expect(report.ok).toBe(false);
  });

  it("no root key ⇒ nothing is attempted, and the boot is still fine", async () => {
    const { fetchFn, calls } = fakeFetch([listing([])]);
    const lines: string[] = [];
    const report = await prov.provision({
      base: BASE,
      account: "default",
      users: ["reviewer"],
      rootKey: "",
      reviewerKey: "k",
      fetchFn,
      log: (l: string) => lines.push(l),
    });
    expect(calls).toEqual([]);
    expect(report.ok).toBe(false);
    expect(lines.join("\n")).toContain("no root key in the secrets mount");
  });

  it("a dead server never throws — every probe is total", async () => {
    const dead = async () => {
      throw new Error("connect ECONNREFUSED");
    };
    const report = await prov.provision({
      base: BASE,
      account: "default",
      users: ["reviewer"],
      rootKey: "r",
      reviewerKey: "k",
      fetchFn: dead as never,
      log: () => {},
    });
    expect(report.ok).toBe(false);
    expect(report.created).toEqual([]);
  });
});

describe("the temporary provisioning server", () => {
  it("uses the same argv the supervisor does", () => {
    expect(prov.serverArgv({ config: "/s/ov.conf", host: "127.0.0.1", port: 1933 })).toEqual([
      "--config",
      "/s/ov.conf",
      "--host",
      "127.0.0.1",
      "--port",
      "1933",
    ]);
  });

  it("waitForReady gives up on a deadline rather than hanging the boot", async () => {
    let t = 0;
    const ok = await prov.waitForReady({
      base: BASE,
      fetchFn: (async () => ({ ok: false, status: 503, json: async () => ({}) })) as never,
      timeoutMs: 1000,
      sleep: async () => {
        t += 600;
      },
      now: () => t,
    });
    expect(ok).toBe(false);
  });

  it("waitForReady returns as soon as /ready answers", async () => {
    const ok = await prov.waitForReady({
      base: BASE,
      fetchFn: (async () => ({ ok: true, status: 200, json: async () => ({}) })) as never,
      timeoutMs: 1000,
    });
    expect(ok).toBe(true);
  });
});

describe("stopServerChild — the boot can never hang on the temporary server", () => {
  // Adversarial finding (P2): the child was only ever sent SIGTERM and never
  // unref'd, so a server that trapped SIGTERM kept the node event loop alive
  // forever — and the entrypoint's `|| true` never fired because node never
  // exited. The stop is now SIGTERM → bounded grace → SIGKILL, with the child
  // unref'd so even that cannot keep the loop alive.
  interface FakeChild {
    kills: string[];
    unrefs: number;
    exitCode: number | null;
    signalCode: string | null;
    kill(sig: string): void;
    once(ev: string, fn: () => void): void;
    removeListener(ev: string, fn: () => void): void;
  }

  function fakeChild(opts: { exitOn?: string } = {}): FakeChild {
    const listeners: Array<() => void> = [];
    const child: FakeChild = {
      kills: [],
      unrefs: 0,
      exitCode: null,
      signalCode: null,
      kill(sig: string) {
        child.kills.push(sig);
        if (opts.exitOn === sig) {
          child.signalCode = sig;
          for (const fn of listeners.splice(0)) fn();
        }
      },
      once: (_ev, fn) => void listeners.push(fn),
      removeListener: () => {},
    };
    (child as unknown as { unref: () => void }).unref = () => void child.unrefs++;
    return child;
  }

  it("a child that exits on SIGTERM is terminated, never SIGKILLed", async () => {
    const child = fakeChild({ exitOn: "SIGTERM" });
    expect(await prov.stopServerChild(child, { graceMs: 5 })).toBe("terminated");
    expect(child.kills).toEqual(["SIGTERM"]);
    expect(child.unrefs).toBeGreaterThan(0);
  });

  it("a child that TRAPS SIGTERM is SIGKILLed after the grace — node's loop is released", async () => {
    const child = fakeChild(); // never emits exit on SIGTERM
    expect(await prov.stopServerChild(child, { graceMs: 5 })).toBe("killed");
    expect(child.kills).toEqual(["SIGTERM", "SIGKILL"]);
    expect(child.unrefs).toBeGreaterThan(0); // even a SIGKILL survivor cannot hold the loop
  });

  it("an absent or already-exited child is a no-op", async () => {
    expect(await prov.stopServerChild(undefined)).toBe("absent");
    const gone = fakeChild();
    gone.exitCode = 0;
    expect(await prov.stopServerChild(gone, { graceMs: 5 })).toBe("already-exited");
    expect(gone.kills).toEqual([]);
  });

  it("main() routes every shutdown through the bounded stop — no bare SIGTERM path is left", () => {
    // Structural: reintroducing `child.kill("SIGTERM")` at a call site would
    // reintroduce the hang.
    const src = readFileSync(resolve(process.cwd(), "scripts/openviking-provision.mjs"), "utf8");
    const mainBody = src.slice(src.indexOf("async function main"));
    expect(mainBody).not.toContain('child.kill("SIGTERM")');
    expect(mainBody).toContain("stopServerChild(child)");
  });
});

describe("cli surface", () => {
  it("parses the entrypoint's invocation", () => {
    const cfg = prov.parseArgs([
      "--base",
      "http://127.0.0.1:1933",
      "--users",
      "reviewer,companion",
      "--root-key-file",
      "/secrets/openviking_root_key",
      "--reviewer-key-file",
      "/secrets/openviking_reviewer_key",
      "--start-server",
      "--bin",
      "/opt/openviking/venv/bin/openviking-server",
      "--config",
      "/state/ov.conf",
      "--port",
      "1933",
    ]);
    expect(cfg).toMatchObject({
      base: "http://127.0.0.1:1933",
      users: ["reviewer", "companion"],
      rootKeyFile: "/secrets/openviking_root_key",
      reviewerKeyFile: "/secrets/openviking_reviewer_key",
      startServer: true,
      port: 1933,
      strict: false,
    });
  });

  it("an unreadable secret file reads as empty, never as a throw", () => {
    expect(prov.readSecret("/nonexistent/openviking_root_key")).toBe("");
    expect(prov.readSecret("")).toBe("");
  });
});
