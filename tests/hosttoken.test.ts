// A host-managed GitHub credential, at its two read seams:
//
//   * the token file and its optional expiry note
//     (packages/pi-plugin/src/hosttoken.ts): what a read answers, and the
//     `ok | expired | missing` the board export reports, absent when it
//     cannot be told;
//   * the marker (src/hostmanaged.ts): `[github] token_source = "host"`, read
//     off the config file as written.
//
// Everything is a temp dir or an injected reader: no network, no process.
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  HOST_MANAGED,
  TOKEN_EXPIRY_NOTE_FILE,
  expiryInstant,
  githubTokenHealth,
  hostTokenProblem,
  readTokenFile,
} from "@quickchatai/pi-quickreview/src/hosttoken.js";
import { USER_TOKEN_FILE } from "@quickchatai/pi-quickreview/src/githubAuth.js";
import { hostManagedAt, hostManagedToml, secretsDirAt } from "../src/hostmanaged.js";
import { secretsHome } from "../src/homes.js";

const TOKEN = "ghu_hostWrittenTokenValue0123456789ab";
const NOW = Date.parse("2026-11-19T12:00:00Z");

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "qcr-hosttoken-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const writeToken = (text: string): void =>
  writeFileSync(join(dir, USER_TOKEN_FILE), text, { mode: 0o600 });
const writeNote = (text: string): void =>
  writeFileSync(join(dir, TOKEN_EXPIRY_NOTE_FILE), text, { mode: 0o600 });
const health = (auth: "app" | "user" = "user") =>
  githubTokenHealth({ auth, secrets_dir: dir }, { now: () => NOW });

/** A reader whose named file fails with `code`; every other path is real. */
const failing =
  (name: string, code: string) =>
  (path: string): string => {
    if (path === join(dir, name)) throw Object.assign(new Error(code), { code });
    throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  };

describe("the token file, read as its writer left it", () => {
  it("is the token alone, trimmed, beside its path", () => {
    writeToken(`${TOKEN}\n`);
    expect(readTokenFile(dir)).toEqual({
      ok: true,
      token: TOKEN,
      path: join(dir, USER_TOKEN_FILE),
    });
  });

  it("tells no file from an empty one, a two-word one and one it cannot read", () => {
    expect(readTokenFile(dir)).toMatchObject({ ok: false, reason: "missing" });
    writeToken("  \n");
    expect(readTokenFile(dir)).toMatchObject({ ok: false, reason: "empty" });
    writeToken("ghu_one ghu_two");
    expect(readTokenFile(dir)).toMatchObject({ ok: false, reason: "malformed" });
    expect(readTokenFile(dir, failing(USER_TOKEN_FILE, "EACCES"))).toMatchObject({
      ok: false,
      reason: "unreadable",
    });
  });

  it("says a problem as the host's to put right: the file, never a command and never the token", () => {
    writeToken("ghu_one ghu_two");
    for (const read of [
      readTokenFile(join(dir, "nowhere")),
      readTokenFile(dir),
      readTokenFile(dir, failing(USER_TOKEN_FILE, "EACCES")),
    ]) {
      if (read.ok) throw new Error("expected a failed read");
      const said = hostTokenProblem(read);
      expect(said).toContain(read.path);
      expect(said).toMatch(/managed by its host/);
      expect(said).not.toMatch(/gh auth login|github-token sync|ghu_one/);
    }
  });

  it("the expiry note sits beside the token file, under its name", () => {
    expect(TOKEN_EXPIRY_NOTE_FILE).toBe("github_token.expires_at");
    expect(HOST_MANAGED).toBe("managed by your host");
  });
});

describe("the board export's github value: the token file and its expiry note", () => {
  it("ok: a token, and no note to say otherwise", () => {
    writeToken(TOKEN);
    expect(health()).toBe("ok");
  });

  it("ok: a token whose note names an instant still ahead", () => {
    writeToken(TOKEN);
    writeNote("2026-11-19T12:20:00Z\n");
    expect(health()).toBe("ok");
  });

  // MUTATION: compare the note against 0 instead of `now` in githubTokenHealth
  // — a lapsed token reads ok, and this fails.
  it("expired: a token whose note names an instant that has passed, or is now", () => {
    writeToken(TOKEN);
    writeNote("2026-11-19T11:59:59Z");
    expect(health()).toBe("expired");
    writeNote("2026-11-19T12:00:00Z");
    expect(health()).toBe("expired");
    writeNote("2026-11-19T13:59:00+02:00");
    expect(health()).toBe("expired");
  });

  it("missing: no token file, or one with no token in it, whatever a note says", () => {
    expect(health()).toBe("missing");
    writeNote("2026-11-19T12:20:00Z");
    expect(health()).toBe("missing");
    writeToken("\n");
    expect(health()).toBe("missing");
  });

  // MUTATION: answer "ok" (or "missing") where githubTokenHealth returns null
  // — an unreadable source renders as a value, and this fails.
  it("absent (null) when it cannot be told: never ok, never missing", () => {
    // the App route has no token file: it mints its own
    writeToken(TOKEN);
    expect(health("app")).toBeNull();
    expect(githubTokenHealth({ secrets_dir: dir }, { now: () => NOW })).toBeNull();
    // a note that is not an instant
    for (const note of ["soon", "2026-11-19", "2026-11-19T12:20:00", "1763553600", ""]) {
      writeNote(note);
      expect(health(), JSON.stringify(note)).toBeNull();
    }
    // a token file that is there and cannot be read
    expect(
      githubTokenHealth(
        { auth: "user", secrets_dir: dir },
        { now: () => NOW, read: failing(USER_TOKEN_FILE, "EACCES") },
      ),
    ).toBeNull();
    // a two-word token file
    writeToken("ghu_one ghu_two");
    expect(health()).toBeNull();
  });

  it("absent when the note is there and cannot be read", () => {
    const read = (path: string): string => {
      if (path === join(dir, USER_TOKEN_FILE)) return TOKEN;
      throw Object.assign(new Error("EACCES"), { code: "EACCES" });
    };
    expect(
      githubTokenHealth({ auth: "user", secrets_dir: dir }, { now: () => NOW, read }),
    ).toBeNull();
  });

  it("reads an instant only with its zone", () => {
    expect(expiryInstant("2026-11-19T12:00:00Z")).toBe(NOW);
    expect(expiryInstant("2026-11-19T12:00:00.000Z")).toBe(NOW);
    expect(expiryInstant("2026-11-19T14:00:00+02:00")).toBe(NOW);
    expect(expiryInstant("2026-11-19T12:00:00")).toBeNull();
    expect(expiryInstant("2026-11-19")).toBeNull();
    expect(expiryInstant("tomorrow")).toBeNull();
  });
});

describe('the marker: [github] token_source = "host", as written', () => {
  it("is the key's own value, and nothing else in the file", () => {
    expect(hostManagedToml('[github]\ntoken_source = "host"\n')).toBe(true);
    expect(hostManagedToml('[github]\ntoken_source = "self"\n')).toBe(false);
    expect(hostManagedToml('[github]\nauth = "user"\n')).toBe(false);
    expect(hostManagedToml('[github]\n#token_source = "host"\n')).toBe(false);
    expect(hostManagedToml('token_source = "host"\n')).toBe(false);
    expect(hostManagedToml("")).toBe(false);
  });

  it("a config that is absent, unreadable or not TOML carries no marker", () => {
    const path = join(dir, "config.toml");
    const managed = hostManagedAt(() => path);
    expect(managed()).toBe(false);
    writeFileSync(path, "[github\nthis is not toml");
    expect(managed()).toBe(false);
    expect(
      hostManagedAt(
        () => path,
        () => {
          throw Object.assign(new Error("EACCES"), { code: "EACCES" });
        },
      )(),
    ).toBe(false);
    expect(
      hostManagedAt(() => {
        throw new Error("no config home");
      })(),
    ).toBe(false);
  });

  it("is read again on every call: a host may write it while the home is open", () => {
    const path = join(dir, "config.toml");
    const managed = hostManagedAt(() => path);
    writeFileSync(path, '[github]\nrepo = ""\n');
    expect(managed()).toBe(false);
    writeFileSync(path, '[github]\nrepo = ""\ntoken_source = "host"\n');
    expect(managed()).toBe(true);
  });

  it("the secrets dir is the configured one, else the install's own", () => {
    const path = join(dir, "config.toml");
    const env = { HOME: join(dir, "home"), XDG_CONFIG_HOME: join(dir, "xdg") };
    const where = secretsDirAt(() => path, env);
    expect(where()).toBe(secretsHome(env));
    writeFileSync(path, '[github]\nsecrets_dir = ""\n');
    expect(where()).toBe(secretsHome(env));
    writeFileSync(path, `[github]\nsecrets_dir = ${JSON.stringify(join(dir, "kept"))}\n`);
    expect(where()).toBe(join(dir, "kept"));
  });

  it("a token file written loose is still read: its mode is the account step's to judge", () => {
    writeToken(TOKEN);
    chmodSync(join(dir, USER_TOKEN_FILE), 0o644);
    expect(readTokenFile(dir)).toMatchObject({ ok: true, token: TOKEN });
  });
});
