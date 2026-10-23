// The newer-version notice (src/updatenotice.ts): once a day at most, never
// in CI, never on a machine-readable run, never blocking. The registry is an
// injected fetch; the "detached child" is a recorded callback.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  inCi,
  isNewer,
  latestUrl,
  readUpdateCache,
  refreshUpdateCache,
  UPDATE_CHECK_INTERVAL_MS,
  updateCachePath,
  updateNotice,
  type NoticeInput,
} from "../src/updatenotice.js";

const ROOT = resolve(import.meta.dirname, "..");
mkdirSync(join(ROOT, "node_modules", ".cache"), { recursive: true });
const tmp = mkdtempSync(join(ROOT, "node_modules", ".cache", "update-notice-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

let n = 0;
const freshCache = (): string => updateCachePath(join(tmp, `state-${n++}`));

function input(o: Partial<NoticeInput> & { cachePath: string }): {
  i: NoticeInput;
  refreshed: () => number;
} {
  let refreshes = 0;
  const i: NoticeInput = {
    current: "1.0.8",
    env: {},
    tty: true,
    json: false,
    installed: true,
    now: 1_000_000_000_000,
    refresh: () => refreshes++,
    ...o,
  };
  return { i, refreshed: () => refreshes };
}

const writeCache = (path: string, checked_at: number, latest: string | null): void => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify({ checked_at, latest }));
};

describe("the notice", () => {
  it("first run: no answer yet, so it starts the day's check and says nothing", () => {
    const cachePath = freshCache();
    const { i, refreshed } = input({ cachePath });
    expect(updateNotice(i)).toBeNull();
    expect(refreshed()).toBe(1);
    // stamped at once, so the next run in the same minute does not check again
    expect(readUpdateCache(cachePath)?.checked_at).toBe(i.now);
    const again = input({ cachePath, now: i.now + 60_000 });
    expect(updateNotice(again.i)).toBeNull();
    expect(again.refreshed()).toBe(0);
  });

  it("names the newer version from the kept answer, without asking the registry again", () => {
    const cachePath = freshCache();
    writeCache(cachePath, 1_000_000_000_000 - 1000, "1.2.0");
    const { i, refreshed } = input({ cachePath });
    expect(updateNotice(i)).toMatch(
      /qcr 1\.2\.0 is available \(this is 1\.0\.8\): run `qcr update`/,
    );
    expect(refreshed()).toBe(0);
  });

  // MUTATION: compare with `>` — an answer exactly a day old is never asked again.
  it("asks again once the answer is a day old", () => {
    const cachePath = freshCache();
    writeCache(cachePath, 1_000_000_000_000 - UPDATE_CHECK_INTERVAL_MS, "1.0.8");
    const { i, refreshed } = input({ cachePath });
    expect(updateNotice(i)).toBeNull();
    expect(refreshed()).toBe(1);
  });

  it("is silent and starts nothing in CI, on --json, with no terminal, opted out, or not installed", () => {
    for (const o of [
      { env: { CI: "true" } },
      { env: { GITHUB_ACTIONS: "true" } },
      { json: true },
      { tty: false },
      { env: { QCR_NO_UPDATE_NOTICE: "1" } },
      { installed: false },
    ]) {
      const cachePath = freshCache();
      writeCache(cachePath, 0, "9.9.9");
      const { i, refreshed } = input({ cachePath, ...o });
      expect(updateNotice(i), JSON.stringify(o)).toBeNull();
      expect(refreshed(), JSON.stringify(o)).toBe(0);
    }
  });

  it("CI=false is not CI", () => {
    expect(inCi({ CI: "false" })).toBe(false);
    expect(inCi({ CI: "1" })).toBe(true);
  });

  it("only a newer release counts", () => {
    expect(isNewer("1.0.8", "1.0.9")).toBe(true);
    expect(isNewer("1.0.8", "1.1.0")).toBe(true);
    expect(isNewer("1.0.8", "1.0.8")).toBe(false);
    expect(isNewer("1.0.8", "1.0.7")).toBe(false);
    expect(isNewer("1.0.8", "2.0.0-rc.1")).toBe(false);
    expect(isNewer("1.0.8", "garbage")).toBe(false);
  });
});

describe("the registry check", () => {
  it("asks the registry for the scoped package's latest and keeps the answer", async () => {
    const cachePath = freshCache();
    const asked: string[] = [];
    const fetchFn = (async (url: string | URL | Request) => {
      asked.push(String(url));
      return new Response(JSON.stringify({ name: "@quickchatai/quickreview", version: "1.3.1" }), {
        status: 200,
      });
    }) as typeof fetch;
    const c = await refreshUpdateCache({
      cachePath,
      pkg: "@quickchatai/quickreview",
      fetchFn,
      now: () => 42,
    });
    expect(asked).toEqual([
      `https://registry.npmjs.org/${"@quickchatai/quickreview".replace("/", "%2f")}/latest`,
    ]);
    expect(c).toEqual({ checked_at: 42, latest: "1.3.1" });
    expect(readUpdateCache(cachePath)).toEqual({ checked_at: 42, latest: "1.3.1" });
  });

  it("a failing registry keeps the previous answer and waits a day", async () => {
    const cachePath = freshCache();
    writeCache(cachePath, 1, "1.1.0");
    const fetchFn = (async () => {
      throw new Error("offline");
    }) as typeof fetch;
    const c = await refreshUpdateCache({ cachePath, pkg: "p", fetchFn, now: () => 99 });
    expect(c).toEqual({ checked_at: 99, latest: "1.1.0" });
  });

  it("an answer that is not a release is not kept", async () => {
    const cachePath = freshCache();
    const fetchFn = (async () =>
      new Response(JSON.stringify({ version: "<script>" }), { status: 200 })) as typeof fetch;
    const c = await refreshUpdateCache({ cachePath, pkg: "p", fetchFn, now: () => 5 });
    expect(c.latest).toBeNull();
    expect(existsSync(cachePath)).toBe(true);
    expect(JSON.parse(readFileSync(cachePath, "utf8"))).toEqual({ checked_at: 5, latest: null });
  });

  it("the URL escapes the scope's slash only", () => {
    expect(latestUrl("@a/b", "https://r.example/")).toBe("https://r.example/@a%2fb/latest");
    expect(latestUrl("plain")).toBe("https://registry.npmjs.org/plain/latest");
  });
});
