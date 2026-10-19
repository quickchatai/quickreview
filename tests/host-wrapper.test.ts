// The host wrapper (P6.6): `docker run … install` writes ~/.local/bin/qcr, and
// the wrapper starts one throwaway container per call. No docker, no image, no
// model: the installed sh runs against a fake `docker` (and a fake `gh`) on
// PATH that log every argv. What is pinned:
//   - the installer: the pinned image, the -v ~/.local/bin:/out shape and the
//     `| sh` shape, an option-looking image refused, nothing else on stdout;
//   - every container: --rm -i --init, --cap-drop ALL, no-new-privileges, the
//     repo read-only at /repo, a worktree's git dir read-only at its own path;
//   - the mounts: ONLY the profiles dir of the config home (never the install
//     home that holds <install>/secrets/, never the gh config), the qcr-state
//     and qcr-login volumes, and the token dir;
//   - the token: GITHUB_TOKEN, GH_TOKEN, then gh, staged as a 0600 file in a
//     0700 dir that is gone after the call; in no -e/--env and no argv; no App
//     and so no mint container and no secrets mount (D14);
//   - the verbs: the model-reaching calls start as root with SETUID/SETGID for
//     the D32 uid split, the others as the caller; tui/open/login/debug get a
//     terminal; a scan runs in the foreground inside the sandbox marker;
//   - update: repins the file; the once-a-day notice never fires in CI.
import { afterEach, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { IN_SANDBOX_ENV } from "../src/scanbox.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const INSTALLER = join(root, "scripts", "install-wrapper.sh");
const TEMPLATE = join(root, "scripts", "qcr-host.sh");
const PKG = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
  version: string;
  repository: { url: string };
};
// ghcr.io/<owner>/<name>:<version>, from the repository URL the way the installer reads it
const REPO = `ghcr.io/${/github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?$/.exec(PKG.repository.url)![1]!.toLowerCase()}`;
const IMAGE = `${REPO}:${PKG.version}`;
const TOKEN = "ghp_WRAPPER_SECRET_0123456789";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

// A docker that logs one file per call (an argv per line) and answers the verbs
// the wrapper uses. For a call that mounts /run/qcr-in it records the token
// file's modes and content, since the wrapper removes it afterwards.
const FAKE_DOCKER = `#!/bin/sh
dir="$FAKE_DIR/calls"
mkdir -p "$dir"
n=$(ls "$dir" | grep -c '^[0-9]*$')
f="$dir/$(printf '%03d' "$n")"
for a in "$@"; do printf '%s\\n' "$a"; done > "$f"
case "$1" in
  pull) exit 0 ;;
  manifest)
    case "$3" in
      *:latest) printf '%s' "\${FAKE_LATEST-same}" ;;
      *) printf '%s' "\${FAKE_MINE-same}" ;;
    esac
    exit 0
    ;;
  run) ;;
  *) echo "fake docker: unexpected $*" >&2; exit 99 ;;
esac
for a in "$@"; do
  case "$a" in
    type=bind,src=*,dst=/run/qcr-in)
      src=\${a#type=bind,src=}
      src=\${src%,dst=/run/qcr-in}
      printf '%s %s %s\\n' "$(stat -c %a "$src")" "$(stat -c %a "$src/gh-token")" "$(cat "$src/gh-token")" > "$f.token"
      printf '%s\\n' "$src" > "$f.tokendir"
      ;;
    type=bind,src=*,dst=/out) outdir=\${a#type=bind,src=}; outdir=\${outdir%,dst=/out} ;;
  esac
done
last=
for a in "$@"; do last=$a; done
if [ "$last" = install ] && [ -n "\${outdir-}" ]; then
  image=
  for a in "$@"; do case "$a" in QCR_IMAGE=*) image=\${a#QCR_IMAGE=} ;; esac; done
  printf '#!/bin/sh\\n# repinned %s\\n' "$image" > "$outdir/qcr"
  chmod 755 "$outdir/qcr"
  exit 0
fi
case " $* " in
  *" cli version --json "*) printf '%s\\n' '{"schema_version":1,"image":{"version":"2.0.0","build_sha":null},"schemas":{"review":1,"scan":1},"pi":null}'; exit 0 ;;
esac
exit "\${FAKE_RC-0}"
`;
const FAKE_GH = `#!/bin/sh
[ "$1 $2" = "auth token" ] || exit 2
[ -n "\${FAKE_GH_TOKEN-}" ] || exit 1
printf '%s\\n' "$FAKE_GH_TOKEN"
`;

interface Rig {
  dir: string;
  home: string;
  repo: string;
  bin: string;
  wrapper: string;
  calls: () => string[][];
  token: (n: number) => { dirMode: string; fileMode: string; content: string; dir: string } | null;
  run: (
    args: string[],
    o?: { cwd?: string; env?: Record<string, string>; wrapper?: string },
  ) => { status: number | null; stdout: string; stderr: string };
}

const git = (cwd: string, ...args: string[]): string =>
  execFileSync(
    "git",
    ["-c", "user.name=T", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args],
    { cwd, encoding: "utf8" },
  ).trim();

/** The installed wrapper (the real installer, piped to sh) in a scratch HOME. */
function installWrapper(home: string, env: Record<string, string> = {}): string {
  const out = spawnSync(INSTALLER, [], {
    env: {
      PATH: process.env["PATH"]!,
      QCR_APP_ROOT: root,
      QCR_INSTALL_OUT: "/nonexistent",
      ...env,
    },
    encoding: "utf8",
  });
  expect(out.status, out.stderr).toBe(0);
  const sh = spawnSync("sh", ["-c", out.stdout], {
    env: { PATH: process.env["PATH"]!, HOME: home },
    encoding: "utf8",
  });
  expect(sh.status, sh.stderr).toBe(0);
  return join(home, ".local", "bin", "qcr");
}

function rig(): Rig {
  const dir = mkdtempSync(join(tmpdir(), "qcr-wrapper-"));
  dirs.push(dir);
  const home = join(dir, "home");
  const bin = join(dir, "bin");
  const repo = join(dir, "work", "repo");
  for (const d of [home, bin, repo, join(dir, "run")]) mkdirSync(d, { recursive: true });
  chmodSync(join(dir, "run"), 0o700);
  writeFileSync(join(bin, "docker"), FAKE_DOCKER, { mode: 0o755 });
  writeFileSync(join(bin, "gh"), FAKE_GH, { mode: 0o755 });
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "a.txt"), "a\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "base");
  const wrapper = installWrapper(home);
  const callFiles = (): string[] => {
    const d = join(dir, "calls");
    return existsSync(d)
      ? readdirSync(d)
          .filter((f) => /^\d+$/.test(f))
          .sort()
      : [];
  };
  return {
    dir,
    home,
    repo,
    bin,
    wrapper,
    calls: () =>
      callFiles().map((f) =>
        readFileSync(join(dir, "calls", f), "utf8")
          .trimEnd()
          .split("\n"),
      ),
    token: (n) => {
      const f = join(dir, "calls", String(n).padStart(3, "0"));
      if (!existsSync(`${f}.token`)) return null;
      const [dirMode, fileMode, ...rest] = readFileSync(`${f}.token`, "utf8").trimEnd().split(" ");
      return {
        dirMode: dirMode!,
        fileMode: fileMode!,
        content: rest.join(" "),
        dir: readFileSync(`${f}.tokendir`, "utf8").trim(),
      };
    },
    run: (args, o = {}) => {
      const r = spawnSync("sh", [o.wrapper ?? wrapper, ...args], {
        cwd: o.cwd ?? repo,
        encoding: "utf8",
        timeout: 30_000,
        env: {
          PATH: `${bin}:/usr/bin:/bin`,
          HOME: home,
          XDG_RUNTIME_DIR: join(dir, "run"),
          TMPDIR: dir,
          FAKE_DIR: dir,
          ...o.env,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      return { status: r.status, stdout: r.stdout, stderr: r.stderr };
    },
  };
}

const opt = (argv: string[], flag: string): string[] =>
  argv.flatMap((a, i) => (argv[i - 1] === flag ? [a] : []));
const mounts = (argv: string[]): string[] => opt(argv, "--mount");
const envs = (argv: string[]): string[] => opt(argv, "-e");

// ---- the installer -----------------------------------------------------------

describe("install: the image writes the wrapper", () => {
  it("prints an installer that writes an executable ~/.local/bin/qcr pinned to the image", () => {
    const home = mkdtempSync(join(tmpdir(), "qcr-wrapper-home-"));
    dirs.push(home);
    const out = spawnSync(INSTALLER, [], {
      env: { PATH: process.env["PATH"]!, QCR_APP_ROOT: root, QCR_INSTALL_OUT: "/nonexistent" },
      encoding: "utf8",
    });
    expect(out.status, out.stderr).toBe(0);
    // stdout is the installer and nothing else; the chatter is stderr's
    expect(out.stdout.startsWith("set -eu\n")).toBe(true);
    const bin = installWrapper(home);
    expect(statSync(bin).mode & 0o777).toBe(0o755);
    const text = readFileSync(bin, "utf8");
    expect(text).toContain(`QCR_PINNED_IMAGE='${IMAGE}'`);
    expect(text).not.toContain("@@QCR_IMAGE@@");
    expect(spawnSync("sh", ["-n", bin]).status).toBe(0);
    expect(spawnSync("bash", ["-n", bin]).status).toBe(0);
  });

  it("with /out mounted writes /out/qcr and prints nothing (the -v ~/.local/bin:/out shape)", () => {
    const out = mkdtempSync(join(tmpdir(), "qcr-wrapper-out-"));
    dirs.push(out);
    const r = spawnSync(INSTALLER, [], {
      env: { PATH: process.env["PATH"]!, QCR_APP_ROOT: root, QCR_INSTALL_OUT: out },
      encoding: "utf8",
    });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toBe("");
    expect(statSync(join(out, "qcr")).mode & 0o777).toBe(0o755);
    expect(readFileSync(join(out, "qcr"), "utf8")).toContain(`QCR_PINNED_IMAGE='${IMAGE}'`);
    expect(readdirSync(out)).toEqual(["qcr"]);
  });

  it("pins the image the caller names (a local or retagged image)", () => {
    const out = mkdtempSync(join(tmpdir(), "qcr-wrapper-out-"));
    dirs.push(out);
    const r = spawnSync(INSTALLER, [], {
      env: {
        PATH: process.env["PATH"]!,
        QCR_APP_ROOT: root,
        QCR_INSTALL_OUT: out,
        QCR_IMAGE: "qcr-ci:smoke",
      },
      encoding: "utf8",
    });
    expect(r.status, r.stderr).toBe(0);
    expect(readFileSync(join(out, "qcr"), "utf8")).toContain("QCR_PINNED_IMAGE='qcr-ci:smoke'");
  });

  it.each(["--privileged", "a b", "x;rm -rf ~", "i|j", "a&b"])(
    "refuses %j as an image reference",
    (image) => {
      const r = spawnSync(INSTALLER, [], {
        env: {
          PATH: process.env["PATH"]!,
          QCR_APP_ROOT: root,
          QCR_INSTALL_OUT: "/nonexistent",
          QCR_IMAGE: image,
        },
        encoding: "utf8",
      });
      expect(r.status).toBe(1);
      expect(r.stdout).toBe("");
      expect(r.stderr).toContain("is not an image reference");
    },
  );

  it("tells a caller whose uid cannot write /out to pass --user", () => {
    const out = mkdtempSync(join(tmpdir(), "qcr-wrapper-out-"));
    dirs.push(out);
    chmodSync(out, 0o555);
    const r = spawnSync(INSTALLER, [], {
      env: { PATH: process.env["PATH"]!, QCR_APP_ROOT: root, QCR_INSTALL_OUT: out },
      encoding: "utf8",
    });
    chmodSync(out, 0o755);
    if (process.getuid?.() === 0) return; // root writes anywhere
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("--user");
  });
});

// ---- one container per call ----------------------------------------------------

describe("a review call", () => {
  it("is a throwaway, capless, no-new-privileges container with the D32 root start", () => {
    const r = rig();
    const out = r.run(["review", "--preview", "--json"], { env: { GITHUB_TOKEN: TOKEN } });
    expect(out.status, out.stderr).toBe(0);
    const [argv] = r.calls();
    expect(argv!.slice(0, 5)).toEqual(["run", "--rm", "-i", "--init", "--user"]);
    expect(argv).toContain("0:0");
    expect(argv!.join(" ")).toContain("--cap-drop ALL --cap-add SETUID --cap-add SETGID");
    expect(argv!.join(" ")).toContain("--security-opt no-new-privileges");
    const uid = String(process.getuid?.());
    // a root host runs the review as 1000: the image refuses a root run uid
    expect(envs(argv!)).toContain(`QCR_RUN_UID=${uid === "0" ? "1000" : uid}`);
    // the image, then the mode, then the user's arguments untouched
    const i = argv!.indexOf(IMAGE);
    expect(argv!.slice(i)).toEqual([IMAGE, "cli", "review", "--preview", "--json"]);
  });

  it("mounts the repo read-only at /repo and works in the same directory", () => {
    const r = rig();
    mkdirSync(join(r.repo, "src", "deep"), { recursive: true });
    r.run(["review"], { cwd: join(r.repo, "src", "deep") });
    const [argv] = r.calls();
    const repo = execFileSync("sh", ["-c", "pwd -P"], { cwd: r.repo, encoding: "utf8" }).trim();
    expect(mounts(argv!)).toContain(`type=bind,src=${repo},dst=/repo,readonly`);
    expect(opt(argv!, "-w")).toEqual(["/repo/src/deep"]);
  });

  it("mounts a worktree's common git dir read-only at its own path", () => {
    const r = rig();
    const wt = join(r.dir, "work", "wt");
    git(r.repo, "worktree", "add", "-q", "-b", "side", wt);
    r.run(["review"], { cwd: wt });
    const [argv] = r.calls();
    const common = execFileSync("sh", ["-c", "cd .git && pwd -P"], {
      cwd: r.repo,
      encoding: "utf8",
    }).trim();
    expect(mounts(argv!)).toContain(`type=bind,src=${common},dst=${common},readonly`);
  });

  it("mounts ONLY the profiles dir of the config home: never the install home, secrets or gh config", () => {
    const r = rig();
    for (const d of [
      ".config/gh",
      ".config/qcr/default/secrets",
      ".config/qcr/profiles/mine",
      ".ssh",
    ])
      mkdirSync(join(r.home, d), { recursive: true });
    writeFileSync(join(r.home, ".config/qcr/default/secrets/app.pem"), "KEY");
    writeFileSync(join(r.home, ".config/gh/hosts.yml"), `oauth_token: ${TOKEN}\n`);
    r.run(["review"], { env: { GITHUB_TOKEN: TOKEN } });
    const [argv] = r.calls();
    const m = mounts(argv!);
    const profiles = execFileSync("sh", ["-c", "cd ~/.config/qcr/profiles && pwd -P"], {
      env: { HOME: r.home },
      encoding: "utf8",
    }).trim();
    const binds = m.filter((x) => x.startsWith("type=bind"));
    expect(
      binds.map((x) => x.replace(/^type=bind,src=/, "").replace(/,dst=.*$/, "")).sort(),
    ).toEqual(
      [
        profiles,
        execFileSync("sh", ["-c", "pwd -P"], { cwd: r.repo, encoding: "utf8" }).trim(),
        r.token(0)!.dir,
      ].sort(),
    );
    expect(m).toContain(`type=bind,src=${profiles},dst=/qcr-config/profiles,readonly`);
    const all = argv!.join("\n");
    expect(all).not.toMatch(/\.config\/gh|\.config\/qcr\/default|secrets|\.ssh|app\.pem/);
    expect(all).not.toContain("docker.sock");
    // no App on a laptop: no mint container, no secrets anywhere
    expect(all).not.toMatch(/\bmint\b/);
    expect(r.calls()).toHaveLength(1);
  });

  it("keeps state and the login in volumes, the login read-only", () => {
    const r = rig();
    r.run(["review"]);
    const [argv] = r.calls();
    expect(mounts(argv!)).toContain("type=volume,src=qcr-state,dst=/opt/qcr/state");
    expect(mounts(argv!)).toContain("type=volume,src=qcr-login,dst=/qcr-login,readonly");
    expect(envs(argv!)).toContain("QCR_STATE_HOME=/opt/qcr/state/home");
    expect(envs(argv!)).toContain("PI_CODING_AGENT_DIR=/qcr-login");
  });

  it("hands the token over as a 0600 file in a 0700 dir under XDG_RUNTIME_DIR, gone after the call", () => {
    const r = rig();
    r.run(["review"], { env: { GITHUB_TOKEN: TOKEN } });
    const [argv] = r.calls();
    const t = r.token(0)!;
    expect(t.content).toBe(TOKEN);
    expect(t.dirMode).toBe("700");
    expect(t.fileMode).toBe("600");
    expect(dirname(t.dir)).toBe(join(r.dir, "run"));
    expect(existsSync(t.dir)).toBe(false);
    expect(mounts(argv!)).toContain(`type=bind,src=${t.dir},dst=/run/qcr-in`);
    expect(envs(argv!)).toContain("QCR_GH_TOKEN_FILE=/run/qcr-in/gh-token");
  });

  it("puts the token in no -e/--env, and in no argument at all", () => {
    const r = rig();
    r.run(["review", "42"], {
      env: { GITHUB_TOKEN: TOKEN, GH_TOKEN: `${TOKEN}-2`, OPENAI_API_KEY: "sk-SECRET-KEY" },
    });
    const [argv] = r.calls();
    const all = argv!.join("\n");
    expect(all).not.toContain(TOKEN);
    expect(all).not.toContain("sk-SECRET-KEY");
    expect(envs(argv!).filter((e) => /^(GITHUB_TOKEN|GH_TOKEN)/.test(e))).toEqual([]);
    expect(argv).not.toContain("--env");
    expect(argv).not.toContain("--env-file");
    // a model key goes by name only: docker reads its value from the caller's env
    expect(envs(argv!)).toContain("OPENAI_API_KEY");
    expect(envs(argv!).filter((e) => e.startsWith("ANTHROPIC"))).toEqual([]);
  });

  it("resolves GITHUB_TOKEN, then GH_TOKEN, then gh; nothing found mounts nothing", () => {
    const r = rig();
    r.run(["review"], {
      env: { GITHUB_TOKEN: "t-env", GH_TOKEN: "t-gh-env", FAKE_GH_TOKEN: "t-gh" },
    });
    r.run(["review"], { env: { GH_TOKEN: "t-gh-env", FAKE_GH_TOKEN: "t-gh" } });
    r.run(["review"], { env: { FAKE_GH_TOKEN: "t-gh" } });
    r.run(["review"], {});
    expect([0, 1, 2].map((n) => r.token(n)!.content)).toEqual(["t-env", "t-gh-env", "t-gh"]);
    expect(r.token(3)).toBeNull();
    const none = r.calls()[3]!;
    expect(mounts(none).join(" ")).not.toContain("/run/qcr-in");
    expect(envs(none).join(" ")).not.toContain("QCR_GH_TOKEN_FILE");
  });

  it("removes the token dir when the container fails, and says how to log in to the registry on 125", () => {
    const r = rig();
    const out = r.run(["review"], { env: { GITHUB_TOKEN: TOKEN, FAKE_RC: "125" } });
    expect(out.status).toBe(125);
    expect(out.stderr).toContain("gh auth refresh -s read:packages");
    expect(existsSync(r.token(0)!.dir)).toBe(false);
    expect(r.run(["review"], { env: { FAKE_RC: "3" } }).status).toBe(3);
  });

  it("keeps the user's arguments exactly, quotes and spaces included", () => {
    const r = rig();
    const args = ["review", "--to", "a b", "it's", '"q"', "$HOME", "x;y"];
    r.run(args);
    const [argv] = r.calls();
    expect(argv!.slice(argv!.indexOf("cli") + 1)).toEqual(args);
  });
});

describe("the other verbs", () => {
  it("version is a plain call as the caller, with no token and no split", () => {
    const r = rig();
    r.run(["version", "--json"], { env: { GITHUB_TOKEN: TOKEN } });
    const [argv] = r.calls();
    const j = argv!.join(" ");
    expect(j).toContain(`--user ${process.getuid?.()}:${process.getgid?.()} --cap-drop ALL`);
    expect(j).not.toContain("--cap-add");
    expect(j).toContain("--security-opt no-new-privileges");
    expect(r.token(0)).toBeNull();
    expect(argv!.slice(argv!.indexOf(IMAGE))).toEqual([IMAGE, "cli", "version", "--json"]);
  });

  it("a verb that shares a mode's name cannot select that mode: the wrapper always says cli", () => {
    const r = rig();
    for (const verb of ["daemon", "worker", "mint", "companion"]) r.run([verb]);
    for (const argv of r.calls()) {
      const i = argv.indexOf(IMAGE);
      expect(argv[i + 1]).toBe("cli");
    }
  });

  it("a bare qcr opens the TUI as the caller; tui keeps its arguments", () => {
    const r = rig();
    r.run([]);
    r.run(["tui", "overseer"]);
    const [bare, named] = r.calls();
    expect(bare!.slice(bare!.indexOf(IMAGE))).toEqual([IMAGE, "tui"]);
    expect(named!.slice(named!.indexOf(IMAGE))).toEqual([IMAGE, "tui", "overseer"]);
    expect(bare!.join(" ")).not.toContain("--cap-add");
    expect(r.token(0)).toBeNull();
  });

  it("login is pi's own /login with the login volume the only read-write mount of it", () => {
    const r = rig();
    r.run(["login", "openai-codex"], { env: { GITHUB_TOKEN: TOKEN } });
    const [argv] = r.calls();
    expect(argv!.slice(argv!.indexOf(IMAGE))).toEqual([IMAGE, "login", "openai-codex"]);
    expect(mounts(argv!)).toEqual(["type=volume,src=qcr-login,dst=/home/qcr/.pi/agent"]);
    expect(r.token(0)).toBeNull();
    r.run(["review"]);
    expect(mounts(r.calls()[1]!).filter((m) => m.includes("qcr-login"))).toEqual([
      "type=volume,src=qcr-login,dst=/qcr-login,readonly",
    ]);
  });

  it("only login mounts the login volume read-write; every call joins its group", () => {
    const r = rig();
    const verbs = [["review"], ["scan", "start"], ["open"], ["debug"], [], ["tui"], ["version"]];
    for (const v of verbs) r.run(v);
    r.run(["login"]);
    const calls = r.calls();
    const loginCall = calls.pop()!;
    for (const argv of calls) {
      const login = mounts(argv).filter((m) => m.includes("qcr-login"));
      expect(login.every((m) => m.endsWith(",readonly"))).toBe(true);
    }
    expect(mounts(loginCall).filter((m) => m.includes("qcr-login"))).toEqual([
      "type=volume,src=qcr-login,dst=/home/qcr/.pi/agent",
    ]);
    // the login's files are in one fixed group, whichever uid wrote them
    for (const argv of [...calls, loginCall]) {
      expect(argv[argv.indexOf("--group-add") + 1]).toBe("4747");
      expect(envs(argv)).toContain("QCR_LOGIN_GID=4747");
    }
    // a login needs no model key and no token: nothing but the volume
    expect(envs(loginCall).filter((e) => /KEY|TOKEN/.test(e))).toEqual([]);
  });

  const script = spawnSync("script", ["--version"]).status === 0;
  it.skipIf(!script)("tui, open, login and debug get a terminal; review does not", () => {
    const r = rig();
    const viaTty = (verb: string): void => {
      const cmd = `sh ${r.wrapper} ${verb}`;
      spawnSync("script", ["-qec", cmd, "/dev/null"], {
        cwd: r.repo,
        encoding: "utf8",
        timeout: 30_000,
        env: {
          PATH: `${r.bin}:/usr/bin:/bin`,
          HOME: r.home,
          TMPDIR: r.dir,
          XDG_RUNTIME_DIR: join(r.dir, "run"),
          FAKE_DIR: r.dir,
          QCR_NO_UPDATE_NOTICE: "1",
        },
      });
    };
    for (const verb of ["tui", "open", "login", "debug"]) viaTty(verb);
    viaTty("review");
    const calls = r.calls();
    expect(calls).toHaveLength(5);
    expect(calls.slice(0, 4).map((c) => c[2])).toEqual(["-it", "-it", "-it", "-it"]);
    expect(calls[4]![2]).toBe("-i");
    expect(envs(calls[0]!)).toContain("TERM");
  });

  it("a scan runs in the foreground, inside the sandbox marker the scan code already knows", () => {
    const r = rig();
    r.run(["scan", "start", "--key", "K"]);
    r.run(["scan", "stage2", "start", "--key", "K"]);
    r.run(["scan", "start", "--key", "K", "--foreground"]);
    r.run(["scan", "status"]);
    const [start, stage2, already, status] = r.calls();
    const tail = (a: string[]): string[] => a.slice(a.indexOf("cli") + 1);
    expect(tail(start!)).toEqual(["scan", "start", "--key", "K", "--foreground"]);
    expect(tail(stage2!)).toEqual(["scan", "stage2", "start", "--key", "K", "--foreground"]);
    expect(tail(already!)).toEqual(["scan", "start", "--key", "K", "--foreground"]);
    expect(tail(status!)).toEqual(["scan", "status"]);
    // scanbox.ts's marker: this process is the driver inside; no sandbox of its own
    expect(envs(start!)).toContain(`${IN_SANDBOX_ENV}=1`);
    expect(envs(start!)).toContain("QCR_REVIEWED_REPO=/repo");
    expect(envs(start!)).toContain("QCR_SCAN_AUTH_SRC=/qcr-login");
    // the scan's own pi home is the container's, not the read-only login source
    expect(envs(start!).filter((e) => e.startsWith("PI_CODING_AGENT_DIR"))).toEqual([]);
    expect(envs(status!)).toContain(`${IN_SANDBOX_ENV}=1`);
    r.run(["review"]);
    expect(envs(r.calls()[4]!).join(" ")).not.toContain(IN_SANDBOX_ENV);
  });
});

// ---- update and the notice -------------------------------------------------------

describe("qcr update", () => {
  it("pulls the newest, repins the file and keeps it executable", () => {
    const r = rig();
    const out = r.run(["update"]);
    expect(out.status, out.stderr).toBe(0);
    expect(out.stderr).toContain(`now pinned to ${REPO}:2.0.0`);
    expect(readFileSync(r.wrapper, "utf8")).toContain(`# repinned ${REPO}:2.0.0`);
    expect(statSync(r.wrapper).mode & 0o111).not.toBe(0);
    const verbs = r.calls().map((c) => c[0]);
    expect(verbs[0]).toBe("pull");
    expect(r.calls()[0]).toEqual(["pull", `${REPO}:latest`]);
    // the new image writes its own wrapper, named to itself, as the caller
    const install = r.calls().find((c) => c.includes("install"))!;
    expect(envs(install)).toContain(`QCR_IMAGE=${REPO}:2.0.0`);
    expect(install.join(" ")).toContain(`--user ${process.getuid?.()}:${process.getgid?.()}`);
    expect(install.join("\n")).not.toContain(TOKEN);
  });

  it("takes an explicit version", () => {
    const r = rig();
    expect(r.run(["update", "1.9.0"]).status).toBe(0);
    expect(readFileSync(r.wrapper, "utf8")).toContain(`# repinned ${REPO}:1.9.0`);
    expect(r.calls()[0]).toEqual(["pull", `${REPO}:1.9.0`]);
  });

  it.each(["--rm", "a b"])("refuses %j as a version", (v) => {
    const r = rig();
    const out = r.run(["update", v]);
    expect(out.status).toBe(1);
    expect(r.calls()).toEqual([]);
  });
});

describe("the update notice", () => {
  const NEWER = { FAKE_MINE: "old", FAKE_LATEST: "new", QCR_NOTICE_ANYWHERE: "1" };
  const manifestCalls = (r: Rig): number => r.calls().filter((c) => c[0] === "manifest").length;

  it("appears once a day when a newer image exists", () => {
    const r = rig();
    const first = r.run(["review"], { env: NEWER });
    expect(first.stderr).toContain("a newer qcr image is available");
    const second = r.run(["review"], { env: NEWER });
    expect(second.stderr).not.toContain("newer qcr image");
    expect(manifestCalls(r)).toBe(2);
  });

  it("says nothing when the pinned image is the newest", () => {
    const r = rig();
    expect(
      r.run(["review"], { env: { ...NEWER, FAKE_MINE: "same", FAKE_LATEST: "same" } }).stderr,
    ).not.toContain("newer");
  });

  it.each<Record<string, string>>([
    { CI: "true" },
    { GITHUB_ACTIONS: "true" },
    { QCR_NO_UPDATE_NOTICE: "1" },
  ])("is suppressed under %j, and docker is not even asked", (extra) => {
    const r = rig();
    const out = r.run(["review"], { env: { ...NEWER, ...extra } });
    expect(out.stderr).not.toContain("newer qcr image");
    expect(manifestCalls(r)).toBe(0);
  });

  it("is not shown to a caller with no terminal on stderr (a plugin, a script)", () => {
    const r = rig();
    const out = r.run(["review"], { env: { FAKE_MINE: "old", FAKE_LATEST: "new" } });
    expect(out.stderr).not.toContain("newer qcr image");
    expect(manifestCalls(r)).toBe(0);
  });

  it("never fails the call it follows", () => {
    const r = rig();
    const out = r.run(["review"], {
      env: { ...NEWER, FAKE_RC: "0", PATH: `${r.bin}:/usr/bin:/bin` },
    });
    expect(out.status).toBe(0);
  });
});

// ---- the template itself ------------------------------------------------------------

describe("qcr-host.sh", () => {
  const text = readFileSync(TEMPLATE, "utf8");
  const code = text
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("#"))
    .join("\n");

  it("is POSIX sh that parses under sh and bash and is committed executable", () => {
    expect(text.startsWith("#!/bin/sh\n")).toBe(true);
    expect(spawnSync("sh", ["-n", TEMPLATE]).status).toBe(0);
    expect(spawnSync("bash", ["-n", TEMPLATE]).status).toBe(0);
    expect(statSync(TEMPLATE).mode & 0o111).not.toBe(0);
    expect(statSync(INSTALLER).mode & 0o111).not.toBe(0);
  });

  it("has no App route, no secrets mount, no gh config, no docker socket, no token in -e", () => {
    expect(code).not.toMatch(/secrets|app\.pem|app_id|docker\.sock|\.config\/gh|GH_CONFIG_DIR/);
    expect(code).not.toMatch(/\bmint\b/);
    expect(code).not.toMatch(/-e\s+"?\$?\{?(GITHUB_TOKEN|GH_TOKEN)/);
    expect(code).not.toMatch(/--privileged|--network\s+host|--pid|--ipc|--volumes-from/);
    // no --env/--env-file: every variable is an explicit -e
    expect(code).not.toMatch(/--env\b|--env-file/);
  });

  it("starts every container capless and without new privileges", () => {
    expect(code.match(/docker run --rm/g)?.length).toBeGreaterThanOrEqual(2);
    expect(code.match(/--cap-drop ALL/g)?.length).toBeGreaterThanOrEqual(2);
    expect(code.match(/no-new-privileges/g)?.length).toBeGreaterThanOrEqual(2);
  });
});
