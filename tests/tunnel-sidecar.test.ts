// the webhook-ingress tunnel sidecar: the wrapper's hostname
// capture and file contract, and the compose/image topology it rides.
//
// NO TEST OPENS A TUNNEL. The client is a fake spawn returning canned vendor
// output; the hostname file is a temp dir. The load-bearing assertion is the
// contract itself: what this wrapper WRITES is exactly what's watcher
// READS — proven twice over, by holding the two hostname regexes to the same
// characters and by driving a real WebhookHealer over a file this wrapper
// wrote.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WebhookHealer } from "../src/webhookheal.js";
import type { GateResult } from "../src/gate.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

interface SidecarModule {
  KINDS: string[];
  HOSTNAME_RE: RegExp;
  isHostname(value: unknown): boolean;
  extractHostname(kind: string, line: string): string | null;
  readSecret(dir: string, name: string): string | null;
  writeHostname(file: string, hostname: string): "written" | "unchanged";
  tunnelSpec(cfg: Record<string, unknown>): {
    cmd: string | null;
    args: string[];
    env: Record<string, string>;
    captures: boolean;
    missing: string | null;
    unknownKind?: string;
  };
  backoffMs(attempt: number, min?: number, max?: number): number;
  sidecarConfig(env: Record<string, string | undefined>): Record<string, unknown>;
  runClientOnce(cfg: unknown, spec: unknown, opts: Record<string, unknown>): Promise<{ ok: boolean; reason: string }>;
  runSidecar(cfg: unknown, opts: Record<string, unknown>): Promise<Array<{ ok: boolean; reason: string }>>;
}

const sidecar = (await import("../docker/tunnel/sidecar.mjs")) as unknown as SidecarModule;

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "qcr-tunnel-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function cfg(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: "quick",
    upstream: "http://daemon:8787",
    hostnameFile: join(dir, "ingress", "hostname"),
    secretsDir: join(dir, "secrets"),
    domain: "",
    backoffMinMs: 1,
    backoffMaxMs: 4,
    ...overrides,
  };
}

/** A fake child process: streams we push canned vendor output into. */
function fakeChild(): EventEmitter & { stdout: EventEmitter; stderr: EventEmitter } {
  const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  return child;
}

// ---- hostname capture -------------------------------------------------------

describe("extractHostname — the vendor's own output, nothing else", () => {
  it("reads the quick tunnel's assigned name out of cloudflared's banner", () => {
    const banner = "2026-08-30T10:00:00Z INF |  https://odd-shape-cloud-42.trycloudflare.com    |";
    expect(sidecar.extractHostname("quick", banner)).toBe("odd-shape-cloud-42.trycloudflare.com");
  });

  it("ignores every other cloudflared line, including its own doc links", () => {
    for (const line of [
      "2026-08-30T10:00:00Z INF Requesting new quick Tunnel on trycloudflare.com...",
      "2026-08-30T10:00:00Z INF Visit https://developers.cloudflare.com/cloudflare-one/ for docs",
      "2026-08-30T10:00:00Z INF Registered tunnel connection connIndex=0",
      "",
    ]) {
      expect(sidecar.extractHostname("quick", line)).toBeNull();
    }
  });

  it("reads ngrok's url= field (logfmt) and its json equivalent — never the upstream addr", () => {
    const logfmt =
      't=2026-08-30T10:00:00+0000 lvl=info msg="started tunnel" obj=tunnels name=command_line addr=http://daemon:8787 url=https://review-bot.ngrok-free.app';
    expect(sidecar.extractHostname("ngrok", logfmt)).toBe("review-bot.ngrok-free.app");
    const json = '{"lvl":"info","msg":"started tunnel","addr":"http://daemon:8787","url":"https://review-bot.ngrok.app"}';
    expect(sidecar.extractHostname("ngrok", json)).toBe("review-bot.ngrok.app");
    // A reserved domain captures exactly the same way.
    expect(sidecar.extractHostname("ngrok", "url=https://reviews.example.com")).toBe("reviews.example.com");
  });

  it("ignores ngrok's account chatter and any non-https url", () => {
    expect(sidecar.extractHostname("ngrok", 'msg="visit https://dashboard.ngrok.com/status"')).toBeNull();
    expect(sidecar.extractHostname("ngrok", "url=http://localhost:4040")).toBeNull();
    expect(sidecar.extractHostname("ngrok", "url=https://localhost")).toBeNull();
  });

  it("a named tunnel captures nothing — its hostname is the operator's, not the client's", () => {
    expect(sidecar.extractHostname("named", "INF Registered tunnel connection https://review.example.com")).toBeNull();
  });
});

// ---- the file contract ------------------------------------------------------

describe("writeHostname —'s file contract", () => {
  const file = (): string => join(dir, "ingress", "hostname");

  it("writes ONE bare lowercase hostname with a trailing newline, creating the dir", () => {
    expect(sidecar.writeHostname(file(), "ODD-Shape.TryCloudflare.Com")).toBe("written");
    expect(readFileSync(file(), "utf8")).toBe("odd-shape.trycloudflare.com\n");
  });

  it("is atomic: nothing but the hostname file is left behind", () => {
    sidecar.writeHostname(file(), "abc.trycloudflare.com");
    expect(readdirSync(join(dir, "ingress"))).toEqual(["hostname"]);
  });

  it("an unchanged hostname is not rewritten — the watcher is never woken for nothing", () => {
    expect(sidecar.writeHostname(file(), "abc.trycloudflare.com")).toBe("written");
    expect(sidecar.writeHostname(file(), "abc.trycloudflare.com")).toBe("unchanged");
    expect(sidecar.writeHostname(file(), "ABC.trycloudflare.com")).toBe("unchanged");
    expect(sidecar.writeHostname(file(), "rotated.trycloudflare.com")).toBe("written");
    expect(readFileSync(file(), "utf8")).toBe("rotated.trycloudflare.com\n");
  });

  it("refuses to write anything that is not a bare hostname", () => {
    for (const bad of ["https://abc.trycloudflare.com", "abc.trycloudflare.com/webhook", "abc.trycloudflare.com:443", "", "not a host"]) {
      expect(() => sidecar.writeHostname(file(), bad)).toThrow(/refusing/);
    }
    expect(existsSync(file())).toBe(false);
  });
});

describe("the contract matches the watcher that reads it", () => {
  it("the hostname regex is character-identical to src/webhookheal.ts's", () => {
    const watcher = readFileSync(join(root, "src/webhookheal.ts"), "utf8");
    const wrapper = readFileSync(join(root, "docker/tunnel/sidecar.mjs"), "utf8");
    const literal = /HOSTNAME_RE\s*=\s*(\/.+\/[a-z]*);/;
    const inWatcher = literal.exec(watcher)?.[1];
    const inWrapper = literal.exec(wrapper)?.[1];
    expect(inWatcher).toBeTruthy();
    expect(inWrapper).toBe(inWatcher);
    expect(sidecar.HOSTNAME_RE.source).toBe(new RegExp(inWatcher!.slice(1, inWatcher!.lastIndexOf("/"))).source);
  });

  it("a file this wrapper wrote heals a real WebhookHealer end to end", async () => {
    const file = join(dir, "ingress", "hostname");
    sidecar.writeHostname(file, "odd-shape-cloud-42.trycloudflare.com");
    const remote = { url: "https://stale.example.com/webhook" };
    const healer = new WebhookHealer({
      hostnameFile: file,
      readConfig: async () => ({ url: remote.url }),
      updateUrl: async (newUrl: string): Promise<GateResult> => {
        remote.url = newUrl;
        return { executed: true, response: {} };
      },
      logEvent: () => {},
      anomaly: () => {},
      log: () => {},
      sweepIntervalMs: 0,
    });
    expect(await healer.sweep()).toBe("healed");
    expect(remote.url).toBe("https://odd-shape-cloud-42.trycloudflare.com/webhook");
    // A rotation is just another write — and the second sweep re-points again.
    sidecar.writeHostname(file, "brand-new-name.trycloudflare.com");
    expect(await healer.sweep()).toBe("healed");
    expect(remote.url).toBe("https://brand-new-name.trycloudflare.com/webhook");
  });
});

// ---- what gets run, and with what ------------------------------------------

describe("tunnelSpec — credentials in the environment, NEVER an argv", () => {
  it("quick needs no credential and points the client at the daemon service", () => {
    const spec = sidecar.tunnelSpec(cfg());
    expect(spec.cmd).toBe("cloudflared");
    expect(spec.args).toEqual(["tunnel", "--no-autoupdate", "--url", "http://daemon:8787"]);
    expect(spec.missing).toBeNull();
    expect(spec.captures).toBe(true);
  });

  it("ngrok reads the authtoken from the secrets FILE and passes it in the env", () => {
    const secretsDir = join(dir, "secrets");
    const token = "2abcDEF_ngrok_authtoken_value";
    mkdirSync(secretsDir, { recursive: true });
    writeFileSync(join(secretsDir, "ngrok_authtoken"), `${token}\n`);
    const spec = sidecar.tunnelSpec(cfg({ kind: "ngrok", secretsDir, domain: "reviews.example.com" }));
    expect(spec.cmd).toBe("ngrok");
    expect(spec.env).toEqual({ NGROK_AUTHTOKEN: token });
    expect(spec.args.join(" ")).not.toContain(token);
    expect(spec.args).toContain("--domain");
    expect(spec.args).toContain("reviews.example.com");
    expect(spec.missing).toBeNull();
  });

  it("a missing credential is a named refusal, not a throw (and no --domain without one configured)", () => {
    const ngrok = sidecar.tunnelSpec(cfg({ kind: "ngrok", secretsDir: join(dir, "nope") }));
    expect(ngrok.missing).toBe(join(dir, "nope", "ngrok_authtoken"));
    expect(ngrok.args).not.toContain("--domain");
    const named = sidecar.tunnelSpec(cfg({ kind: "named", secretsDir: join(dir, "nope") }));
    expect(named.missing).toBe(join(dir, "nope", "tunnel_token"));
  });

  it("named runs the connector with TUNNEL_TOKEN in the env and captures no hostname", () => {
    const secretsDir = join(dir, "secrets");
    mkdirSync(secretsDir, { recursive: true });
    writeFileSync(join(secretsDir, "tunnel_token"), "eyJhIjoi-connector-token\n");
    const spec = sidecar.tunnelSpec(cfg({ kind: "named", secretsDir }));
    expect(spec.args).toEqual(["tunnel", "--no-autoupdate", "run"]);
    expect(spec.env.TUNNEL_TOKEN).toBe("eyJhIjoi-connector-token");
    expect(spec.args.join(" ")).not.toContain("eyJhIjoi");
    expect(spec.captures).toBe(false);
  });

  it("an unknown kind is reported, never guessed", () => {
    expect(sidecar.tunnelSpec(cfg({ kind: "wireguard" })).unknownKind).toBe("wireguard");
    expect(sidecar.KINDS).toEqual(["quick", "ngrok", "named"]);
  });
});

describe("the supervised run", () => {
  it("captures a hostname split across two reads and publishes it", async () => {
    const child = fakeChild();
    const conf = cfg();
    const run = sidecar.runClientOnce(conf, sidecar.tunnelSpec(conf), {
      spawn: () => child,
      log: () => {},
      echo: false,
    });
    child.stderr.emit("data", "INF |  https://odd-shape-cl");
    child.stderr.emit("data", "oud-42.trycloudflare.com  |\n");
    expect(readFileSync(conf.hostnameFile as string, "utf8")).toBe("odd-shape-cloud-42.trycloudflare.com\n");
    child.emit("close", 0, null);
    expect((await run).reason).toBe("exit 0");
  });

  it("a client that dies is restarted, and the new hostname simply replaces the old", async () => {
    const conf = cfg();
    const children: Array<ReturnType<typeof fakeChild>> = [];
    const sleeps: number[] = [];
    const spawn = (): EventEmitter => {
      const child = fakeChild();
      children.push(child);
      // The client announces, then dies (a quick tunnel being reaped).
      setTimeout(() => {
        child.stderr.emit("data", `INF |  https://name-${children.length}.trycloudflare.com |\n`);
        child.emit("close", 1, null);
      }, 0);
      return child;
    };
    const outcomes = await sidecar.runSidecar(conf, {
      spawn,
      log: () => {},
      echo: false,
      sleep: async (ms: number) => {
        sleeps.push(ms);
      },
      maxRuns: 3,
    });
    expect(outcomes).toHaveLength(3);
    expect(children).toHaveLength(3);
    // Each restart published its own hostname; the last one stands.
    expect(readFileSync(conf.hostnameFile as string, "utf8")).toBe("name-3.trycloudflare.com\n");
    // Capped, growing backoff — never a fork bomb, never a give-up.
    expect(sleeps).toEqual([1, 2, 4]);
  });

  it("a missing credential never spawns and never exits — it waits, re-reading the file", async () => {
    const secretsDir = join(dir, "secrets");
    const conf = cfg({ kind: "ngrok", secretsDir });
    const spawned: string[] = [];
    const logs: string[] = [];
    const spawn = (cmd: string): EventEmitter => {
      spawned.push(cmd);
      const child = fakeChild();
      setTimeout(() => child.emit("close", 0, null), 0);
      return child;
    };
    const sleep = async (): Promise<void> => {
      // The operator drops the token in while the sidecar waits.
      mkdirSync(secretsDir, { recursive: true });
      writeFileSync(join(secretsDir, "ngrok_authtoken"), "token-arrived-later");
    };
    const outcomes = await sidecar.runSidecar(conf, { spawn, log: (l: string) => logs.push(l), echo: false, sleep, maxRuns: 2 });
    expect(outcomes[0]).toEqual({ ok: false, reason: "missing-secret" });
    expect(logs.join("\n")).toContain("ngrok_authtoken");
    // Second attempt: the credential is there now, no restart was needed.
    expect(spawned).toEqual(["ngrok"]);
  });

  it("an unknown kind idles loudly instead of crash-looping", async () => {
    const logs: string[] = [];
    const outcomes = await sidecar.runSidecar(cfg({ kind: "nope" }), {
      spawn: () => {
        throw new Error("must not spawn");
      },
      log: (l: string) => logs.push(l),
      sleep: async () => {},
      maxRuns: 1,
    });
    expect(outcomes[0]?.reason).toBe("unknown-kind");
    expect(logs.join("\n")).toContain("unknown QCR_TUNNEL_KIND");
  });

  it("an unwritable hostname file costs the announcement, never the tunnel", async () => {
    const conf = cfg({ hostnameFile: join(dir, "hostname") });
    writeFileSync(join(dir, "hostname"), "abc.trycloudflare.com\n");
    const logs: string[] = [];
    const child = fakeChild();
    const run = sidecar.runClientOnce(conf, sidecar.tunnelSpec(conf), {
      spawn: () => child,
      log: (l: string) => logs.push(l),
      echo: false,
      onHostname: () => {
        throw new Error("EROFS: read-only file system");
      },
    });
    child.stderr.emit("data", "INF |  https://new.trycloudflare.com |\n");
    child.emit("close", 0, null);
    await run;
    expect(logs.join("\n")).toContain("could not publish hostname new.trycloudflare.com");
  });

  it("backoff climbs and then caps", () => {
    expect([0, 1, 2, 3, 4, 5, 99].map((n) => sidecar.backoffMs(n, 2000, 60000))).toEqual([2000, 4000, 8000, 16000, 32000, 60000, 60000]);
  });
});

describe("sidecarConfig — container env in, config out", () => {
  it("defaults point at the daemon service and the shared ingress mount", () => {
    const conf = sidecar.sidecarConfig({ QCR_TUNNEL_KIND: "quick" });
    expect(conf).toMatchObject({
      kind: "quick",
      upstream: "http://daemon:8787",
      hostnameFile: "/ingress/hostname",
      secretsDir: "/opt/quickreview/secrets",
      domain: "",
    });
  });
});

// ---- the images and the compose topology -----------------------------------

const compose = readFileSync(join(root, "docker-compose.yml"), "utf8");
const cloudflaredFile = readFileSync(join(root, "docker/tunnel/Dockerfile.cloudflared"), "utf8");
const ngrokFile = readFileSync(join(root, "docker/tunnel/Dockerfile.ngrok"), "utf8");
const daemonReadme = readFileSync(join(root, "docker/daemon/README.md"), "utf8");

const argOf = (dockerfile: string, name: string): string | undefined =>
  new RegExp(`^ARG ${name}=(.+)$`, "m").exec(dockerfile)?.[1];

describe("tunnel images — official binaries, pinned, verified at build time", () => {
  it("both clients are copied out of the VENDOR's own image, never rebuilt or downloaded", () => {
    expect(cloudflaredFile).toMatch(/^FROM cloudflare\/cloudflared:\$\{CLOUDFLARED_VERSION\} AS client$/m);
    expect(cloudflaredFile).toContain("COPY --from=client /usr/local/bin/cloudflared /usr/local/bin/cloudflared");
    expect(ngrokFile).toMatch(/^FROM ngrok\/ngrok:\$\{NGROK_VERSION\}-alpine AS client$/m);
    expect(ngrokFile).toContain("COPY --from=client /bin/ngrok /usr/local/bin/ngrok");
    for (const file of [cloudflaredFile, ngrokFile]) expect(file).not.toMatch(/curl|wget/);
  });

  it("versions are pinned as ARG defaults — never `latest`, never a literal in the FROM", () => {
    expect(argOf(cloudflaredFile, "CLOUDFLARED_VERSION")).toMatch(/^\d+\.\d+\.\d+$/);
    expect(argOf(ngrokFile, "NGROK_VERSION")).toMatch(/^\d+\.\d+\.\d+$/);
    for (const file of [cloudflaredFile, ngrokFile, compose]) expect(file).not.toMatch(/:latest\b/);
    expect(cloudflaredFile).not.toMatch(/cloudflared:\d/);
    expect(ngrokFile).not.toMatch(/ngrok:\d/);
  });

  it("the build hard-fails unless the INSTALLED client matches the pin (the docker/daemon discipline)", () => {
    expect(cloudflaredFile).toContain('cloudflared --version | grep -qF "${CLOUDFLARED_VERSION}"');
    expect(cloudflaredFile).toContain("failed verification");
    expect(ngrokFile).toContain('ngrok version | grep -qF "${NGROK_VERSION}"');
    expect(ngrokFile).toContain("failed verification");
  });

  it("both images run the ONE wrapper, and neither carries a credential", () => {
    for (const file of [cloudflaredFile, ngrokFile]) {
      expect(file).toContain("COPY sidecar.mjs /usr/local/lib/qcr/sidecar.mjs");
      expect(file).toContain('ENTRYPOINT ["node", "/usr/local/lib/qcr/sidecar.mjs"]');
      expect(file).not.toMatch(/AUTHTOKEN=\S/);
      expect(file).not.toMatch(/TUNNEL_TOKEN=\S/);
    }
  });
});

describe("compose topology — a sidecar only when the operator chose one", () => {
  /** One service's own lines — comments stripped, because the comment block
   * introducing the NEXT service sits inside this one's text span. */
  const service = (name: string): string => {
    const at = compose.indexOf(`\n  ${name}:\n`);
    expect(at, `service ${name}`).toBeGreaterThan(0);
    const next = compose.slice(at + 1).search(/\n  [a-z-]+:\n|\nvolumes:\n/);
    return compose
      .slice(at, next === -1 ? undefined : at + 1 + next)
      .split("\n")
      .filter((line) => !/^\s*#/.test(line))
      .join("\n");
  };

  it("every sidecar sits behind its own profile — plain `docker compose up` starts the daemon alone", () => {
    expect(service("tunnel-quick")).toContain('profiles: ["quick-tunnel"]');
    expect(service("tunnel-ngrok")).toContain('profiles: ["ngrok"]');
    expect(service("tunnel-named")).toContain('profiles: ["named-tunnel"]');
    // The daemon itself must never grow a profile — it is the whole point.
    expect(service("daemon")).not.toContain("profiles:");
  });

  it("no sidecar publishes a port — the tunnel dials OUT, nothing new is exposed", () => {
    for (const name of ["tunnel-quick", "tunnel-ngrok", "tunnel-named"]) {
      expect(service(name)).not.toContain("ports:");
      expect(service(name)).not.toContain("1933");
    }
  });

  it("the hostname file rides its OWN volume, shared with the daemon and nothing else", () => {
    expect(service("daemon")).toContain("qcr-ingress:/opt/quickreview/state/ingress");
    expect(service("tunnel-quick")).toContain("qcr-ingress:/ingress");
    expect(service("tunnel-ngrok")).toContain("qcr-ingress:/ingress");
    // No sidecar ever sees the state volume (SQLite, memory, the dry-run record).
    for (const name of ["tunnel-quick", "tunnel-ngrok", "tunnel-named"]) {
      expect(service(name)).not.toContain("qcr-state:");
      expect(service(name)).not.toContain("/opt/quickreview/sandbox");
    }
    expect(compose).toMatch(/^ {2}qcr-ingress:$/m);
  });

  it("the token-bearing sidecars mount the secrets dir READ-ONLY and pass nothing on a command line", () => {
    for (const name of ["tunnel-ngrok", "tunnel-named"]) {
      expect(service(name)).toMatch(/quickreview-bot\}:\/opt\/quickreview\/secrets:ro/);
    }
    // The quick tunnel needs no credential at all, so it gets no secrets mount.
    expect(service("tunnel-quick")).not.toContain("secrets");
    // No credential value ever reaches compose — not as an env assignment
    // (compose env lands in `docker inspect`), not as a client argument.
    expect(compose).not.toMatch(/^\s*(NGROK_AUTHTOKEN|TUNNEL_TOKEN)\s*[:=]/m);
    expect(compose).not.toMatch(/--token\b/);
    expect(compose).not.toMatch(/^\s*command:/m);
  });

  it("each sidecar is told its kind and restarts unless stopped", () => {
    expect(service("tunnel-quick")).toContain("QCR_TUNNEL_KIND: quick");
    expect(service("tunnel-ngrok")).toContain("QCR_TUNNEL_KIND: ngrok");
    expect(service("tunnel-named")).toContain("QCR_TUNNEL_KIND: named");
    for (const name of ["tunnel-quick", "tunnel-ngrok", "tunnel-named"]) {
      expect(service(name)).toContain("restart: unless-stopped");
    }
  });

  it("the compose header and the daemon README explain all four shapes, memory port included", () => {
    for (const doc of [compose, daemonReadme]) {
      expect(doc).toContain("quick-tunnel");
      expect(doc).toContain("ngrok");
      expect(doc).toContain("named-tunnel");
      expect(doc).toMatch(/poll/i);
    }
    expect(daemonReadme).toContain("1933");
    expect(daemonReadme).toMatch(/never published|deliberately never published/);
  });
});
