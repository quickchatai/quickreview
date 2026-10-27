// The host wrapper: `docker run … install` writes ~/.local/bin/qcr, and
// the wrapper starts one throwaway container per call. No docker, no image, no
// model: the installed sh runs against a fake `docker` (and a fake `gh`) on
// PATH that log every argv. What is pinned:
//   - the installer: the pinned image, the -v ~/.local/bin:/out shape and the
//     `| sh` shape, an option-looking image refused, nothing else on stdout;
//   - every container: --rm -i --init, --cap-drop ALL, no-new-privileges, the
//     repo read-only at /repo (the home and login take none), a worktree's git
//     dir read-only at its own path;
//   - the mounts: ONLY the profiles dir of the config home (never the install
//     home that holds <install>/secrets/, never the gh config), the qcr-state
//     and qcr-login volumes, and the token dir;
//   - the token: GITHUB_TOKEN, GH_TOKEN, then gh, staged as a 0600 file in a
//     0700 dir that is gone after the call; in no -e/--env and no argv; no App
//     and so no mint container and no secrets mount;
//   - the verbs: the model-reaching calls start as root with SETUID/SETGID for
//     the uid split, the others as the caller; a bare qcr is the home;
//     home/tui/open/login/debug get a
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
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { IN_SANDBOX_ENV } from "../src/scanbox.js";
import { companionPlan, renderPlan } from "../src/tui/companionplan.js";

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
  inspect)
    # the companion: absent, or "<running> <plan label>" as the test left it
    [ -f "$FAKE_DIR/companion-state" ] || { echo "Error: No such object: $2" >&2; exit 1; }
    case " $* " in *" --format "*) cat "$FAKE_DIR/companion-state"; echo ;; esac
    exit 0
    ;;
  start)
    [ -z "\${FAKE_START_FAIL-}" ] || exit 1
    sed -i 's/^false/true/' "$FAKE_DIR/companion-state"
    exit 0
    ;;
  stop) sed -i 's/^true/false/' "$FAKE_DIR/companion-state"; exit 0 ;;
  rm) rm -f "$FAKE_DIR/companion-state"; exit 0 ;;
  kill) exit 0 ;;
  ps)
    # the review containers: their names, or their run ids as labelled
    case " $* " in
      *"qcr.role=review"*)
        case "$*" in
          *Label*) printf '%s' "\${FAKE_REVIEW_IDS-}" ;;
          *) printf '%s' "\${FAKE_REVIEW_PS-}" ;;
        esac
        ;;
      *) printf '%s' "\${FAKE_TUI_PS-}" ;;
    esac
    exit 0
    ;;
  manifest)
    case "$3" in
      *:latest) printf '%s' "\${FAKE_LATEST-same}" ;;
      *) printf '%s' "\${FAKE_MINE-same}" ;;
    esac
    exit 0
    ;;
  run)
    case " $* " in
      *" cli companion plan "*)
        [ -z "\${FAKE_PLAN_FAIL-}" ] || { echo "planner: no ssh agent" >&2; exit 1; }
        cat "$FAKE_DIR/plan.txt"
        exit 0
        ;;
    esac
    if [ "$2" = --detach ]; then
      [ -z "\${FAKE_COMPANION_RUN_FAIL-}" ] || exit 1
      for a in "$@"; do
        case "$a" in qcr.plan=*) printf 'true %s' "\${a#qcr.plan=}" > "$FAKE_DIR/companion-state" ;; esac
      done
      echo fakecontainerid
      exit 0
    fi
    ;;
  *) echo "fake docker: unexpected $*" >&2; exit 99 ;;
esac
for a in "$@"; do
  case "$a" in
    type=bind,src=*,dst=/run/qcr-in)
      src=\${a#type=bind,src=}
      src=\${src%,dst=/run/qcr-in}
      printf '%s %s %s\\n' "$(stat -c %a "$src")" "$(stat -c %a "$src/gh-token")" "$(cat "$src/gh-token")" > "$f.token"
      printf '%s\\n' "$src" > "$f.tokendir"
      tokensrc=$src
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
case " $* " in
  *" --container-run "*)
    # the image reads the token file once and unlinks it, FAKE_TOKEN_DELAY seconds
    # after the detached run returned (never with FAKE_TOKEN_KEEP); the file's
    # presence at that moment is recorded
    if [ -n "\${tokensrc-}" ] && [ -z "\${FAKE_TOKEN_KEEP-}" ]; then
      (
        sleep "\${FAKE_TOKEN_DELAY-0}"
        if [ -f "$tokensrc/gh-token" ]; then
          echo present > "$FAKE_DIR/token-present-when-taken"
          rm -f "$tokensrc/gh-token"
        fi
      ) >/dev/null 2>&1 &
    fi
    exit "\${FAKE_DRIVER_RC-0}"
    ;;
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
  /** The docker calls; the companion's own (the plan, inspect, start, rm, stop,
   * ps and the detached run) only with `all`. */
  calls: (all?: boolean) => string[][];
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
  // what `qcr companion plan` prints for this HOME, from the real planner
  writeFileSync(
    join(dir, "plan.txt"),
    renderPlan(
      companionPlan({
        QCR_HOST_HOME: home,
        QCR_HOST_XDG_CONFIG_HOME: join(home, ".config"),
        QCR_HOST_XDG_STATE_HOME: join(home, ".local", "state"),
        QCR_IMAGE: IMAGE,
      }),
    ),
  );
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
    calls: (all = false) =>
      callFiles()
        .map((f) =>
          readFileSync(join(dir, "calls", f), "utf8")
            .trimEnd()
            .split("\n"),
        )
        .filter((c) => all || !companionCall(c)),
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
          // the companion has its own describe below
          QCR_NO_COMPANION: "1",
          ...o.env,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      return { status: r.status, stdout: r.stdout, stderr: r.stderr };
    },
  };
}

/** A call the wrapper makes for the companion rather than for the verb. */
const companionCall = (c: string[]): boolean =>
  ["inspect", "start", "stop", "kill", "rm", "ps"].includes(c[0]!) ||
  (c[0] === "run" && (c[1] === "--detach" || c.slice(-3).join(" ") === "cli companion plan"));

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

  it("refuses a wrapper template that has no image placeholder", () => {
    const app = mkdtempSync(join(tmpdir(), "qcr-wrapper-app-"));
    dirs.push(app);
    mkdirSync(join(app, "scripts"));
    writeFileSync(join(app, "scripts", "qcr-host.sh"), "#!/bin/sh\necho no placeholder\n");
    const r = spawnSync(INSTALLER, [], {
      env: {
        PATH: process.env["PATH"]!,
        QCR_APP_ROOT: app,
        QCR_INSTALL_OUT: "/nonexistent",
        QCR_IMAGE: "qcr-ci:smoke",
      },
      encoding: "utf8",
    });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("no image placeholder");
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
  it("is a throwaway, capless, no-new-privileges container with the root start", () => {
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

  // MUTATION: give the empty verb mode=tui again — the documented first run
  // opens the old TUI, and this fails.
  it("a bare qcr and qcr home open the home as the caller; tui keeps its arguments", () => {
    const r = rig();
    r.run([], { env: { GITHUB_TOKEN: TOKEN } });
    r.run(["home"]);
    r.run(["tui", "overseer"]);
    const [bare, home, named] = r.calls();
    expect(bare!.slice(bare!.indexOf(IMAGE))).toEqual([IMAGE, "home"]);
    expect(home!.slice(home!.indexOf(IMAGE))).toEqual([IMAGE, "home"]);
    expect(named!.slice(named!.indexOf(IMAGE))).toEqual([IMAGE, "tui", "overseer"]);
    expect(bare!.join(" ")).not.toContain("--cap-add");
    // the home is no TUI: no companion label, no ssh, no repo
    expect(bare).not.toContain("qcr.role=tui");
    expect(mounts(bare!).join("\n")).not.toMatch(/\.ssh|dst=\/repo/);
  });

  // MUTATION: mount the login volume read-only in home mode — the home's
  // device login cannot be saved, and this fails.
  it("the home gets pi's agent dir read-write, a writable config and state on the volume, and the token", () => {
    const r = rig();
    r.run([], { env: { GITHUB_TOKEN: TOKEN } });
    const [argv] = r.calls();
    expect(mounts(argv!)).toEqual([
      "type=volume,src=qcr-login,dst=/home/qcr/.pi/agent",
      "type=volume,src=qcr-state,dst=/opt/qcr/state",
      `type=bind,src=${r.token(0)!.dir},dst=/run/qcr-in`,
    ]);
    expect(envs(argv!)).toContain("QCR_STATE_HOME=/opt/qcr/state/home");
    expect(envs(argv!)).toContain("QCR_CONFIG=/opt/qcr/state/home/config.toml");
    expect(envs(argv!)).toContain("QCR_GH_TOKEN_FILE=/run/qcr-in/gh-token");
    expect(r.token(0)!.content).toBe(TOKEN);
    expect(argv!.join(" ")).not.toContain(TOKEN);
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

  it("only login and the home mount the login volume read-write; every call joins its group", () => {
    const r = rig();
    const verbs = [["review"], ["scan", "start"], ["open"], ["debug"], ["tui"], ["version"]];
    for (const v of verbs) r.run(v);
    r.run([]);
    r.run(["login"]);
    const calls = r.calls();
    const loginCall = calls.pop()!;
    const homeCall = calls.pop()!;
    expect(mounts(homeCall).filter((m) => m.includes("qcr-login"))).toEqual([
      "type=volume,src=qcr-login,dst=/home/qcr/.pi/agent",
    ]);
    for (const argv of calls) {
      const login = mounts(argv).filter((m) => m.includes("qcr-login"));
      expect(login.every((m) => m.endsWith(",readonly"))).toBe(true);
    }
    expect(mounts(loginCall).filter((m) => m.includes("qcr-login"))).toEqual([
      "type=volume,src=qcr-login,dst=/home/qcr/.pi/agent",
    ]);
    // the login's files are in one fixed group, whichever uid wrote them
    for (const argv of [...calls, homeCall, loginCall]) {
      expect(argv[argv.indexOf("--group-add") + 1]).toBe("4747");
      expect(envs(argv)).toContain("QCR_LOGIN_GID=4747");
    }
    // a login needs no model key and no token: nothing but the volume
    expect(envs(loginCall).filter((e) => /KEY|TOKEN/.test(e))).toEqual([]);
  });

  const script = spawnSync("script", ["--version"]).status === 0;
  it.skipIf(!script)("home, tui, open, login and debug get a terminal; review does not", () => {
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
          QCR_NO_COMPANION: "1",
        },
      });
    };
    for (const verb of ["home", "tui", "open", "login", "debug"]) viaTty(verb);
    viaTty("review");
    const calls = r.calls();
    expect(calls).toHaveLength(6);
    expect(calls.slice(0, 5).map((c) => c[2])).toEqual(["-it", "-it", "-it", "-it", "-it"]);
    expect(calls[5]![2]).toBe("-i");
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

// ---- the TUI: a companion on the host, a TUI container, no docker.sock ----------

describe("the TUI and its companion", () => {
  const NAME = "qcr-tui-companion";
  const TMUX_VOLUME = `${NAME}-tmux`;
  const withCompanion = { QCR_NO_COMPANION: "" };

  /** A real unix socket where an ssh agent's would be; closed by the caller. */
  async function agentSocket(dir: string): Promise<{ path: string; close: () => void }> {
    const path = join(dir, "agent.sock");
    const server = net.createServer();
    await new Promise<void>((res) => server.listen(path, res));
    return { path, close: () => server.close() };
  }

  const verbs = (r: Rig): string[] => r.calls(true).map((c) => c[0]!);
  const tuiCall = (r: Rig): string[] => r.calls().find((c) => c.includes("qcr.role=tui"))!;
  const companionRun = (r: Rig): string[] =>
    r.calls(true).find((c) => c[0] === "run" && c[1] === "--detach")!;

  function ssh(r: Rig): void {
    mkdirSync(join(r.home, ".ssh"), { recursive: true });
    writeFileSync(join(r.home, ".ssh", "config"), "Host vm\n  HostName 10.0.0.1\n");
    writeFileSync(join(r.home, ".ssh", "known_hosts"), "10.0.0.1 ssh-ed25519 AAAA\n");
  }

  it("runs the companion first, on the host, from the image's plan, then the TUI, then stops it", async () => {
    const r = rig();
    ssh(r);
    const agent = await agentSocket(r.dir);
    try {
      const out = r.run(["tui"], { env: { ...withCompanion, SSH_AUTH_SOCK: agent.path } });
      expect(out.status, out.stderr).toBe(0);
    } finally {
      agent.close();
    }
    // plan, look, create, the TUI, stop
    expect(verbs(r)).toEqual(["run", "inspect", "run", "run", "ps", "stop"]);
    const [plan] = r.calls(true);
    // the plan is the image's, run as the caller with no mounts at all
    expect(plan!.slice(plan!.indexOf(IMAGE))).toEqual([IMAGE, "cli", "companion", "plan"]);
    expect(mounts(plan!)).toEqual([]);
    expect(opt(plan!, "--user")).toEqual([`${process.getuid!()}:${process.getgid!()}`]);
    // the companion is the plan's run, labelled with its hash, detached
    const companion = companionRun(r);
    expect(companion.slice(0, 2)).toEqual(["run", "--detach"]);
    expect(opt(companion, "--label")).toEqual([expect.stringMatching(/^qcr\.plan=[0-9a-f]{16}$/)]);
    expect(companion).toContain(IMAGE);
    expect(companion.at(-1)).toBe("companion");
    // the tmux volume is how the TUI reaches it, and the stop comes last
    expect(companion).toContain(`${TMUX_VOLUME}:/run/qcr-tmux:rw`);
    expect(r.calls(true).at(-1)!.slice(0, 2)).toEqual(["stop", NAME]);
  });

  it("the TUI container gets the agent socket, ssh config, known_hosts and the tmux volume; the planner is told the same three for the companion", async () => {
    const r = rig();
    ssh(r);
    const agent = await agentSocket(r.dir);
    try {
      r.run(["tui", "--no-reload"], { env: { ...withCompanion, SSH_AUTH_SOCK: agent.path } });
    } finally {
      agent.close();
    }
    const tui = tuiCall(r);
    expect(mounts(tui)).toEqual(
      expect.arrayContaining([
        `type=bind,src=${agent.path},dst=/run/qcr-ssh-agent`,
        `type=bind,src=${r.home}/.ssh/config,dst=/home/qcr/.ssh/config,readonly`,
        `type=bind,src=${r.home}/.ssh/known_hosts,dst=/home/qcr/.ssh/known_hosts,readonly`,
        `type=volume,src=${TMUX_VOLUME},dst=/run/qcr-tmux`,
      ]),
    );
    expect(envs(tui)).toEqual(
      expect.arrayContaining(["SSH_AUTH_SOCK=/run/qcr-ssh-agent", "QCR_TUI_COMPANION=tmux-socket"]),
    );
    expect(tui.slice(tui.indexOf(IMAGE))).toEqual([IMAGE, "tui", "--no-reload"]);
    // the host dirs the two share are mounted into the TUI at their own paths
    const state = join(r.home, ".local", "state");
    expect(mounts(tui)).toContain(`type=bind,src=${state}/qcr/home,dst=${state}/qcr/home`);
    expect(mounts(tui)).toContain(
      `type=bind,src=${state}/qcr-operator/default/companion/feed,dst=${state}/qcr-operator/default/companion/feed`,
    );
    expect(envs(tui)).toContain(`QCR_STATE_HOME=${state}/qcr/home`);
    expect(envs(tui)).toContain(`QCR_HOST_HOME=${r.home}`);
    // the companion's ssh (rule 8: full ssh): the planner sees none of the
    // host's files, so the wrapper names the three present sources to it — by
    // env, never by a mount — and the plan mounts them read-only
    const [plan] = r.calls(true);
    expect(mounts(plan!)).toEqual([]);
    expect(envs(plan!)).toEqual(
      expect.arrayContaining([
        `QCR_HOST_SSH_AUTH_SOCK=${agent.path}`,
        `QCR_HOST_SSH_CONFIG=${r.home}/.ssh/config`,
        `QCR_HOST_SSH_KNOWN_HOSTS=${r.home}/.ssh/known_hosts`,
      ]),
    );
    // never ~/.ssh whole, never a key file
    expect(companionRun(r).join("\n")).not.toMatch(/\.ssh(,|:|$)|id_(rsa|ed25519|ecdsa)/m);
  });

  it("the plan mounts exactly the three ssh sources it is named, read-only, and points SSH_AUTH_SOCK at the agent", () => {
    const home = "/h";
    const base = {
      QCR_HOST_HOME: home,
      QCR_HOST_XDG_CONFIG_HOME: `${home}/.config`,
      QCR_HOST_XDG_STATE_HOME: `${home}/.local/state`,
      QCR_IMAGE: IMAGE,
    };
    const run = companionPlan({
      ...base,
      QCR_HOST_SSH_AUTH_SOCK: "/run/user/1/agent.sock",
      QCR_HOST_SSH_CONFIG: `${home}/.ssh/config`,
      QCR_HOST_SSH_KNOWN_HOSTS: `${home}/.ssh/known_hosts`,
    }).run;
    const volumes = opt(run, "--volume");
    expect(volumes.filter((v) => /ssh/.test(v))).toEqual([
      "/run/user/1/agent.sock:/run/qcr-ssh-agent:ro",
      `${home}/.ssh/config:/home/qcr/.ssh/config:ro`,
      `${home}/.ssh/known_hosts:/home/qcr/.ssh/known_hosts:ro`,
    ]);
    expect(opt(run, "--env")).toContain("SSH_AUTH_SOCK=/run/qcr-ssh-agent");
    // with none named, there is no ssh at all, and the plan's hash differs
    const bare = companionPlan(base);
    expect(bare.run.join("\n")).not.toMatch(/ssh/i);
    expect(bare.hash).not.toBe(
      companionPlan({ ...base, QCR_HOST_SSH_CONFIG: `${home}/.ssh/config` }).hash,
    );
    // the agent's path moves with every login: the hash names that there is
    // one, not where, so another shell's TUI adopts the running companion
    const agentAt = (p: string): string =>
      companionPlan({ ...base, QCR_HOST_SSH_AUTH_SOCK: p }).hash;
    expect(agentAt("/run/user/1/a.sock")).toBe(agentAt("/tmp/ssh-x/agent.9"));
    expect(agentAt("/run/user/1/a.sock")).not.toBe(bare.hash);
    // a relative or multi-line path is no path
    expect(
      companionPlan({ ...base, QCR_HOST_SSH_AUTH_SOCK: "agent.sock" }).run.join("\n"),
    ).not.toMatch(/ssh/i);
  });

  it("no container of any call mounts docker.sock, whatever the verb", async () => {
    const r = rig();
    ssh(r);
    const agent = await agentSocket(r.dir);
    try {
      r.run(["tui"], { env: { ...withCompanion, SSH_AUTH_SOCK: agent.path } });
      for (const v of [["review"], ["scan", "status"], ["login"], ["version"], ["open"]])
        r.run(v, { env: { SSH_AUTH_SOCK: agent.path } });
    } finally {
      agent.close();
    }
    const all = r.calls(true);
    expect(all.length).toBeGreaterThan(8);
    for (const argv of all) {
      expect(argv.join("\n")).not.toMatch(/docker\.sock|\/var\/run\/docker/);
      expect(argv).not.toContain("--privileged");
    }
    // the agent is MOUNTED into the TUI container and no other call here (the
    // companion's comes from its plan, which the planner call only names it to)
    const withAgent = all.filter((c) => mounts(c).some((m) => m.includes(agent.path)));
    expect(withAgent.map((c) => c.includes("qcr.role=tui"))).toEqual([true]);
    const named = all.filter((c) => envs(c).includes(`QCR_HOST_SSH_AUTH_SOCK=${agent.path}`));
    expect(named.map((c) => c.slice(c.indexOf(IMAGE)).join(" "))).toEqual([
      `${IMAGE} cli companion plan`,
    ]);
  });

  it("adopts a running companion that matches the plan, and creates nothing", () => {
    const r = rig();
    const hash = /plan (\S+)/.exec(readFileSync(join(r.dir, "plan.txt"), "utf8"))![1]!;
    writeFileSync(join(r.dir, "companion-state"), `true ${hash}`);
    r.run(["tui"], { env: withCompanion });
    expect(verbs(r)).toEqual(["run", "inspect", "run", "ps", "stop"]);
  });

  it("starts a stopped companion that matches", () => {
    const r = rig();
    const hash = /plan (\S+)/.exec(readFileSync(join(r.dir, "plan.txt"), "utf8"))![1]!;
    writeFileSync(join(r.dir, "companion-state"), `false ${hash}`);
    r.run(["tui"], { env: withCompanion });
    expect(verbs(r)).toEqual(["run", "inspect", "start", "run", "ps", "stop"]);
  });

  it("recreates a companion whose plan drifted (a mount, a flag, a new image)", () => {
    const r = rig();
    writeFileSync(join(r.dir, "companion-state"), "true 0000000000000000");
    const out = r.run(["tui"], { env: withCompanion });
    expect(out.stderr).toContain("recreating");
    expect(verbs(r)).toEqual(["run", "inspect", "rm", "run", "run", "ps", "stop"]);
    expect(companionRun(r)).toContain(`${TMUX_VOLUME}:/run/qcr-tmux:rw`);
  });

  it("recreates a stopped companion that will not start", () => {
    const r = rig();
    const hash = /plan (\S+)/.exec(readFileSync(join(r.dir, "plan.txt"), "utf8"))![1]!;
    writeFileSync(join(r.dir, "companion-state"), `false ${hash}`);
    r.run(["tui"], { env: { ...withCompanion, FAKE_START_FAIL: "1" } });
    expect(verbs(r)).toEqual(["run", "inspect", "start", "rm", "run", "run", "ps", "stop"]);
  });

  it("leaves the companion running while another TUI container still uses it", () => {
    const r = rig();
    r.run(["tui"], { env: { ...withCompanion, FAKE_TUI_PS: "abc123" } });
    expect(verbs(r)).not.toContain("stop");
  });

  it("--no-companion and QCR_NO_COMPANION run the TUI alone: no plan, no volume", () => {
    const r = rig();
    r.run(["tui", "--no-companion"], { env: withCompanion });
    r.run(["tui"]);
    expect(verbs(r)).toEqual(["run", "run"]);
    for (const argv of r.calls(true)) {
      expect(mounts(argv).join("\n")).not.toContain(TMUX_VOLUME);
      expect(envs(argv)).not.toContain("QCR_TUI_COMPANION=tmux-socket");
    }
    // the TUI keeps its own state volume as the state home
    expect(envs(r.calls(true)[1]!)).toContain("QCR_STATE_HOME=/opt/qcr/state/home");
  });

  it.each([
    ["the plan cannot be had", { FAKE_PLAN_FAIL: "1" }],
    ["the companion will not run", { FAKE_COMPANION_RUN_FAIL: "1" }],
  ])("when %s the TUI starts without a companion and says so", (_why, env) => {
    const r = rig();
    const out = r.run(["tui"], { env: { ...withCompanion, ...env } });
    expect(out.stderr).toContain("the companion could not be started");
    if ("FAKE_PLAN_FAIL" in env) expect(out.stderr).toContain("planner: no ssh agent");
    const tui = tuiCall(r);
    expect(tui.slice(tui.indexOf(IMAGE))).toEqual([IMAGE, "tui", "--no-companion"]);
    expect(envs(tui)).not.toContain("QCR_TUI_COMPANION=tmux-socket");
    expect(verbs(r)).not.toContain("stop");
  });

  it("gives the TUI the install's own config, read-only, and no other verb the ssh files", () => {
    const r = rig();
    ssh(r);
    const cfg = join(r.home, ".config", "qcr", "default", "config.toml");
    mkdirSync(dirname(cfg), { recursive: true });
    writeFileSync(cfg, "# the install's config\n");
    r.run(["tui"]);
    r.run(["review"]);
    const [tui, review] = r.calls();
    expect(mounts(tui!)).toContain(`type=bind,src=${cfg},dst=/qcr-config/config.toml,readonly`);
    expect(envs(tui!)).toContain("QCR_CONFIG=/qcr-config/config.toml");
    expect(envs(review!)).toContain("QCR_CONFIG=/opt/qcr/config.example.toml");
    expect(mounts(review!).join("\n")).not.toContain(".ssh");
    expect(mounts(review!).join("\n")).not.toContain("agent");
  });

  it("reads the TUI's config from an absolute QCR_CONFIG_HOME, as the install locator does", () => {
    const r = rig();
    ssh(r);
    const home = join(r.home, "custom-home");
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "config.toml"), "# the install's config\n");
    r.run(["tui"], { env: { QCR_CONFIG_HOME: home } });
    const [tui] = r.calls();
    expect(mounts(tui!)).toContain(
      `type=bind,src=${join(home, "config.toml")},dst=/qcr-config/config.toml,readonly`,
    );
  });

  it("has no secrets, config home or ssh dir in what the companion is run with", () => {
    const r = rig();
    r.run(["tui"], { env: withCompanion });
    const flat = companionRun(r).join("\n");
    expect(flat).not.toMatch(/secrets|\.ssh|docker\.sock/);
    // only the profiles and portrait dirs of the config home
    expect(flat).toContain(`${r.home}/.config/qcr/profiles:/qcr-config/profiles`);
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

/** Which docker call (counting every one, the companion's too) an argv was. */
const callIndex = (r: Rig, argv: string[]): number =>
  r.calls(true).findIndex((c) => c.join("\n") === argv.join("\n"));

// ---- a review run is a container -------------------------------------------

describe("qcr review start | status | stop: the run is a detached container", () => {
  /** The image runs: `run` calls that are not the companion's. */
  const runs = (r: Rig): string[][] => r.calls().filter((c) => c[0] === "run");
  const verbs = (r: Rig): string[] => r.calls(true).map((c) => c[0]!);
  const tail = (argv: string[]): string[] => argv.slice(argv.indexOf(IMAGE));

  it("start is two calls: a claim with no token, then the driver as a detached container", () => {
    const r = rig();
    const out = r.run(["review", "start", "--uncommitted", "--json"], {
      env: { GITHUB_TOKEN: TOKEN },
    });
    expect(out.status, out.stderr).toBe(0);
    const [claim, driver] = runs(r);
    expect(runs(r)).toHaveLength(2);

    // the claim: a short foreground call that only reads git, so it holds no token
    const id = envs(claim!)
      .find((e) => e.startsWith("QCR_RUN_ID="))!
      .slice("QCR_RUN_ID=".length);
    expect(id).toMatch(/^\d{14}-[0-9a-f]{6}$/);
    expect(claim!.slice(0, 4)).toEqual(["run", "--rm", "-i", "--init"]);
    expect(envs(claim!)).toContain(`QCR_REVIEW_CONTAINER=qcr-review-${id}`);
    expect(mounts(claim!).join(" ")).not.toContain("/run/qcr-in");
    expect(envs(claim!).join(" ")).not.toContain("QCR_GH_TOKEN_FILE");
    expect(mounts(claim!).join(" ")).toContain("dst=/repo,readonly");
    expect(tail(claim!)).toEqual([IMAGE, "cli", "review", "start", "--uncommitted", "--json"]);

    // the driver: detached, named and labelled, the run the claim wrote, with the token
    expect(driver!.slice(0, 5)).toEqual(["run", "--rm", "-d", "--init", "--name"]);
    expect(driver).not.toContain("-i");
    expect(opt(driver!, "--name")).toEqual([`qcr-review-${id}`]);
    expect(opt(driver!, "--label")).toEqual(["qcr.role=review", `qcr.review.run=${id}`]);
    expect(envs(driver!)).toContain(`QCR_RUN_ID=${id}`);
    expect(envs(driver!)).toContain(`QCR_REVIEW_CONTAINER=qcr-review-${id}`);
    expect(driver!.join(" ")).toContain("--cap-drop ALL --cap-add SETUID --cap-add SETGID");
    expect(tail(driver!)).toEqual([IMAGE, "cli", "review", "--container-run", id]);
    const t = r.token(callIndex(r, driver!))!;
    expect(t.content).toBe(TOKEN);
    expect(existsSync(t.dir)).toBe(false);
    // the state and the login are the foreground review's own, for both
    for (const argv of [claim!, driver!]) {
      expect(mounts(argv)).toContain("type=volume,src=qcr-state,dst=/opt/qcr/state");
      expect(mounts(argv)).toContain("type=volume,src=qcr-login,dst=/qcr-login,readonly");
    }
    // nobody else hears of the driver's container id
    expect(out.stdout).toBe("");
  });

  it("a refused claim is the call's answer, and no driver starts", () => {
    const r = rig();
    const out = r.run(["review", "start"], { env: { FAKE_RC: "1" } });
    expect(out.status).toBe(1);
    expect(runs(r)).toHaveLength(1);
  });

  it("a driver that cannot start frees the claimed target and fails the call", () => {
    const r = rig();
    const out = r.run(["review", "start", "--base", "main"], { env: { FAKE_DRIVER_RC: "125" } });
    expect(out.status).not.toBe(0);
    expect(out.stderr).toContain("the review container could not be started");
    const rs = runs(r);
    const id = envs(rs[0]!)
      .find((e) => e.startsWith("QCR_RUN_ID="))!
      .slice("QCR_RUN_ID=".length);
    // claim, driver, then the same stop a person would run
    expect(rs).toHaveLength(3);
    expect(tail(rs[2]!)).toEqual([IMAGE, "cli", "review", "stop", id]);
  });

  it("the token dir outlives the detached run until the container has taken the token", () => {
    const r = rig();
    // docker run -d returns at once; the image unlinks the file a second later
    const out = r.run(["review", "start", "--base", "main"], {
      env: { GITHUB_TOKEN: TOKEN, FAKE_TOKEN_DELAY: "1" },
    });
    expect(out.status, out.stderr).toBe(0);
    const driver = runs(r)[1]!;
    const t = r.token(callIndex(r, driver))!;
    expect(t.content).toBe(TOKEN);
    // still there when the container took it, gone once the wrapper has returned
    expect(existsSync(join(r.dir, "token-present-when-taken"))).toBe(true);
    expect(existsSync(t.dir)).toBe(false);
  });

  it("a container that never takes the token fails the start and frees the target", () => {
    const r = rig();
    const out = r.run(["review", "start", "--base", "main"], {
      env: { GITHUB_TOKEN: TOKEN, FAKE_TOKEN_KEEP: "1", QCR_TOKEN_WAIT: "1" },
    });
    expect(out.status).not.toBe(0);
    expect(out.stderr).toContain("did not take its GitHub token");
    expect(out.stderr).toContain("the review container could not be started");
    const rs = runs(r);
    expect(rs).toHaveLength(3);
    expect(tail(rs[2]!).slice(2, 4)).toEqual(["review", "stop"]);
    expect(existsSync(r.token(callIndex(r, rs[1]!))!.dir)).toBe(false);
  });

  it("start --help is one plain call: nothing is claimed", () => {
    const r = rig();
    r.run(["review", "start", "--help"]);
    expect(runs(r)).toHaveLength(1);
    expect(tail(runs(r)[0]!)).toEqual([IMAGE, "cli", "review", "start", "--help"]);
    expect(envs(runs(r)[0]!).filter((e) => e.startsWith("QCR_RUN_ID"))).toEqual([]);
  });

  it("tells every call which review containers are up, by name", () => {
    const r = rig();
    const live = "qcr-review-20261019080000-aaaaaa\nqcr-review-20261019080100-bbbbbb\n";
    for (const verb of ["status", "stop"])
      r.run(["review", verb, "20261019080000-aaaaaa"], { env: { FAKE_REVIEW_PS: live } });
    for (const argv of runs(r))
      expect(envs(argv)).toContain(
        "QCR_LIVE_REVIEWS=qcr-review-20261019080000-aaaaaa qcr-review-20261019080100-bbbbbb ",
      );
    // a foreground review does not ask
    const r2 = rig();
    r2.run(["review", "--preview"]);
    expect(envs(runs(r2)[0]!).join(" ")).not.toContain("QCR_LIVE_REVIEWS");
    expect(verbs(r2)).not.toContain("ps");
  });

  it("stop ends the container after the image has marked the run: docker stop -t <grace>, then docker kill", () => {
    const r = rig();
    const out = r.run(["review", "stop", "20261019080000-aaaaaa"], {
      env: { QCR_STOP_GRACE: "3" },
    });
    expect(out.status, out.stderr).toBe(0);
    const calls = r.calls(true);
    const iRun = calls.findIndex((c) => c[0] === "run");
    const iStop = calls.findIndex((c) => c[0] === "stop");
    const iKill = calls.findIndex((c) => c[0] === "kill");
    expect(iRun).toBeLessThan(iStop);
    expect(iStop).toBeLessThan(iKill);
    expect(calls[iStop]).toEqual(["stop", "-t", "3", "qcr-review-20261019080000-aaaaaa"]);
    expect(calls[iKill]).toEqual(["kill", "qcr-review-20261019080000-aaaaaa"]);
  });

  it("the grace defaults to 10 seconds and a value that is not a number is not used", () => {
    for (const grace of [undefined, "ten", "-1", "1;rm"]) {
      const r = rig();
      r.run(
        ["review", "stop", "run1"],
        grace === undefined ? {} : { env: { QCR_STOP_GRACE: grace } },
      );
      expect(r.calls(true).find((c) => c[0] === "stop")).toEqual([
        "stop",
        "-t",
        "10",
        "qcr-review-run1",
      ]);
    }
  });

  it("stop without an id stops the newest review container that is up", () => {
    const r = rig();
    r.run(["review", "stop"], {
      env: { FAKE_REVIEW_IDS: "20261019080100-bbbbbb\n20261019080000-aaaaaa\n" },
    });
    expect(tail(runs(r)[0]!)).toEqual([IMAGE, "cli", "review", "stop", "20261019080100-bbbbbb"]);
    expect(r.calls(true).find((c) => c[0] === "stop")![3]).toBe("qcr-review-20261019080100-bbbbbb");
  });

  it("stop with nothing up leaves the answer to the image and stops nothing", () => {
    const r = rig();
    r.run(["review", "stop"]);
    expect(tail(runs(r)[0]!)).toEqual([IMAGE, "cli", "review", "stop"]);
    expect(verbs(r)).not.toContain("stop");
    expect(verbs(r)).not.toContain("kill");
  });

  it("stop of a run the image refuses stops no container", () => {
    const r = rig();
    const out = r.run(["review", "stop", "run1"], { env: { FAKE_RC: "1" } });
    expect(out.status).toBe(1);
    expect(verbs(r)).not.toContain("stop");
    expect(verbs(r)).not.toContain("kill");
  });

  it("an id that is not a run id never names a container", () => {
    const r = rig();
    r.run(["review", "stop", "x;rm"]);
    expect(verbs(r)).not.toContain("stop");
  });

  it("a plain foreground review is untouched: one --rm -i call, no name, no label", () => {
    const r = rig();
    r.run(["review", "--preview"], { env: { GITHUB_TOKEN: TOKEN } });
    expect(runs(r)).toHaveLength(1);
    const argv = runs(r)[0]!;
    expect(argv).not.toContain("--name");
    expect(argv).not.toContain("--label");
    expect(argv).not.toContain("-d");
    expect(envs(argv).filter((e) => e.startsWith("QCR_RUN_ID"))).toEqual([]);
  });

  it("an internal phase cannot be named without a run id", () => {
    const r = rig();
    const out = r.run(["review", "status"], { env: { QCR_WRAPPER_PHASE: "driver" } });
    expect(out.status).not.toBe(0);
    expect(runs(r)).toHaveLength(0);
  });
});

// qcr open and qcr review --debug-pi are pi's own interactive UI: a terminal on
// both ends gives -it, on the state volume the runs are kept in.
const HAS_SCRIPT = spawnSync("script", ["--version"]).status === 0;
describe("open and --debug-pi: -it on the state volume", () => {
  const tail = (argv: string[]): string[] => argv.slice(argv.indexOf(IMAGE));
  /** The wrapper under a pty (util-linux script), as a person at a terminal. */
  function inPty(r: Rig, args: string[], env: Record<string, string> = {}): number | null {
    const line = ["sh", r.wrapper, ...args].map((a) => `'${a}'`).join(" ");
    return spawnSync("script", ["-qec", line, "/dev/null"], {
      cwd: r.repo,
      encoding: "utf8",
      timeout: 30_000,
      input: "",
      env: {
        PATH: `${r.bin}:/usr/bin:/bin`,
        HOME: r.home,
        XDG_RUNTIME_DIR: join(r.dir, "run"),
        TMPDIR: r.dir,
        FAKE_DIR: r.dir,
        QCR_NO_COMPANION: "1",
        TERM: "xterm",
        ...env,
      },
    }).status;
  }
  const runCall = (r: Rig): string[] => r.calls().find((c) => c[0] === "run")!;

  it.skipIf(!HAS_SCRIPT)(
    "qcr open in a pty is -it, on the state volume, with no GitHub token",
    () => {
      const r = rig();
      expect(
        inPty(r, ["open", "20261019080000-aaaaaa", "--lens", "x"], { GITHUB_TOKEN: TOKEN }),
      ).toBe(0);
      const argv = runCall(r);
      expect(argv.slice(0, 4)).toEqual(["run", "--rm", "-it", "--init"]);
      expect(mounts(argv)).toContain("type=volume,src=qcr-state,dst=/opt/qcr/state");
      expect(envs(argv)).toContain("TERM");
      // pi on a kept session needs no GitHub: none is staged, none is in the container
      expect(mounts(argv).join(" ")).not.toContain("/run/qcr-in");
      expect(envs(argv).join(" ")).not.toContain("QCR_GH_TOKEN_FILE");
      expect(argv.join("\n")).not.toContain(TOKEN);
      expect(r.token(callIndex(r, argv))).toBeNull();
      expect(tail(argv)).toEqual([IMAGE, "cli", "open", "20261019080000-aaaaaa", "--lens", "x"]);
    },
  );

  it.skipIf(!HAS_SCRIPT)(
    "qcr review --debug-pi in a pty is -it on the state volume, takes the root start for the tool uid split and holds no token",
    () => {
      const r = rig();
      expect(inPty(r, ["review", "--debug-pi", "12"], { GITHUB_TOKEN: TOKEN })).toBe(0);
      const argv = runCall(r);
      expect(argv.slice(0, 4)).toEqual(["run", "--rm", "-it", "--init"]);
      expect(mounts(argv)).toContain("type=volume,src=qcr-state,dst=/opt/qcr/state");
      // the person watches this session in their own terminal: the image starts that
      // pi as the separate tool uid, from the root start of every model-reaching call
      expect(argv.join(" ")).toContain(
        "--user 0:0 --cap-drop ALL --cap-add SETUID --cap-add SETGID",
      );
      expect(envs(argv).join(" ")).not.toContain("QCR_ALLOW_SHARED_TOOL_UID");
      // no token is staged: a debug round takes a branch or uncommitted target
      expect(mounts(argv).join(" ")).not.toContain("/run/qcr-in");
      expect(envs(argv).join(" ")).not.toContain("QCR_GH_TOKEN_FILE");
      expect(argv.join("\n")).not.toContain(TOKEN);
      expect(r.token(callIndex(r, argv))).toBeNull();
      expect(tail(argv)).toEqual([IMAGE, "cli", "review", "--debug-pi", "12"]);
    },
  );

  it("without a terminal neither is given one (docker refuses -t on a pipe)", () => {
    const r = rig();
    r.run(["open"]);
    r.run(["review", "--debug-pi"]);
    for (const argv of r.calls().filter((c) => c[0] === "run")) expect(argv[2]).toBe("-i");
  });

  it.skipIf(!HAS_SCRIPT)(
    "a plain review in a pty stays without -t, and no review allows the shared uid",
    () => {
      const r = rig();
      expect(inPty(r, ["review", "--preview"])).toBe(0);
      const argv = runCall(r);
      expect(argv[2]).toBe("-i");
      expect(envs(argv).join(" ")).not.toContain("QCR_ALLOW_SHARED_TOOL_UID");
    },
  );
});
