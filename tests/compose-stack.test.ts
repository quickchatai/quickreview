// The compose stack (docker-compose.yml): the always-on daemon, its memory
// sidecar and the optional tunnels, from the RELEASED images. Running it needs
// Docker, a registry login and the images, so the suite pins what can be read
// without them:
//   - the daemon and memory services are pulled (image: ...:${QCR_VERSION}),
//     never built, and the daemon runs the image's `daemon` mode;
//   - nothing from a checkout is mounted: no sandbox bind, no docker.sock;
//   - the mounts land on paths the release image really has and can write;
//   - the image names are the ones release.yml pushes;
//   - the tunnel sidecars (the one thing built) have their build context in
//     the release image, so a Docker-only install can extract it;
//   - `docker compose config` accepts the file when Docker is installed (it
//     reads no daemon and pulls nothing), and refuses it without a version pin.
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { parse as parseToml } from "smol-toml";
import { memoryEndpointPatch } from "../src/onboard/steps/bringup.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string): string => readFileSync(join(root, rel), "utf8");
const composeText = read("docker-compose.yml");
const dockerfile = read("docker/Dockerfile");
const dockerignore = read("docker/Dockerfile.dockerignore");
const release = read(".github/workflows/release.yml");

interface Service {
  image?: string;
  command?: unknown;
  build?: unknown;
  user?: string;
  ports?: string[];
  volumes?: string[];
  environment?: Record<string, string>;
  profiles?: string[];
  cap_drop?: string[];
  security_opt?: string[];
  depends_on?: string[];
}
const doc = parse(composeText) as {
  services: Record<string, Service>;
  volumes: Record<string, unknown>;
};
const daemon = doc.services.daemon!;
const memory = doc.services.memory!;
const tunnels = ["tunnel-quick", "tunnel-ngrok", "tunnel-named"].map((n) => doc.services[n]!);

describe("the daemon and memory services are pulled, not built", () => {
  it("name the released images, pinned by QCR_VERSION and required", () => {
    expect(daemon.image).toMatch(/^ghcr\.io\/quickchatai\/quickreview:\$\{QCR_VERSION:\?[^}]+\}$/);
    expect(memory.image).toMatch(
      /^ghcr\.io\/quickchatai\/quickreview-memory:\$\{QCR_VERSION:\?[^}]+\}$/,
    );
    expect(daemon.build).toBeUndefined();
    expect(memory.build).toBeUndefined();
    expect(composeText).not.toMatch(/:latest\b/);
  });

  it("use the repositories release.yml pushes", () => {
    expect(release).toMatch(/ghcr\.io\/quickchatai\/quickreview:<version>\s+the release image/);
    expect(release).toMatch(
      /ghcr\.io\/quickchatai\/quickreview-memory:<version>\s+the memory sidecar/,
    );
  });

  it("run the image's daemon mode, as the operator's uid, with nothing extra", () => {
    expect(daemon.command).toEqual(["daemon"]);
    expect(daemon.user).toBe("${QCR_UID:-1000}:${QCR_UID:-1000}");
    expect(memory.user).toBe(daemon.user);
    for (const svc of [daemon, memory]) {
      expect(svc.cap_drop).toEqual(["ALL"]);
      expect(svc.security_opt).toContain("no-new-privileges:true");
    }
  });

  it("mount no checkout and no docker.sock", () => {
    for (const svc of [daemon, memory]) {
      for (const v of svc.volumes ?? []) {
        expect(v, v).not.toMatch(/^\.{1,2}\//);
        expect(v, v).not.toContain("docker.sock");
        expect(v, v).not.toContain("/sandbox");
      }
    }
    expect(composeText).not.toContain("./:/opt");
  });

  it("carry no credential in their environment (rule 3)", () => {
    for (const svc of [daemon, memory, ...tunnels]) {
      for (const key of Object.keys(svc.environment ?? {})) {
        // a path or a file NAME is fine (QCR_SECRETS_MOUNT, ..._KEY_FILE); a value is not
        if (/_(MOUNT|DIR|FILE)$/.test(key)) continue;
        expect(key).not.toMatch(/TOKEN|SECRET|API_KEY|PRIVATE|PASSWORD/i);
      }
    }
  });
});

describe("the mounts land on the release image's own paths", () => {
  it("state, pi's home and the nested ingress dir are volumes the image has and can write", () => {
    expect(daemon.volumes).toContain("qcr-state:/opt/qcr/state");
    expect(daemon.volumes).toContain("qcr-ingress:/opt/qcr/state/ingress");
    expect(daemon.volumes).toContain("qcr-pihome:/home/qcr/.pi");
    // docker/entrypoint.sh keeps state at $APP/state; the image's app root is /opt/qcr.
    expect(read("docker/entrypoint.sh")).toContain('STATE="$APP/state"');
    // A volume over a directory the image has takes its mode; one over a
    // directory it lacks is root-owned and unwritable by the daemon's uid.
    expect(dockerfile).toMatch(
      /^RUN install -d -m 1777 \/opt\/qcr\/state \/opt\/qcr\/state\/ingress /m,
    );
    expect(dockerfile).toMatch(/^RUN install -d -m 1777 \/home\/qcr \/home\/qcr\/\.pi /m);
  });

  it("secrets and config are read-only, and required rather than defaulted into the home directory", () => {
    for (const svc of [daemon, memory]) {
      expect(svc.volumes).toContain(
        "${QCR_SECRETS_DIR:?set QCR_SECRETS_DIR to your secrets directory}:/opt/quickreview/secrets:ro",
      );
      expect(svc.volumes).toContain(
        "${QCR_CONFIG_HOME:?set QCR_CONFIG_HOME to the directory holding config.toml}:/opt/quickreview/config-home:ro",
      );
    }
    expect(daemon.environment?.QCR_CONFIG).toBe(
      "/opt/quickreview/config-home/${QCR_CONFIG_NAME:-config.toml}",
    );
    expect(daemon.environment?.QCR_SECRETS_MOUNT).toBe("/opt/quickreview/secrets");
  });

  it("the memory store is the sidecar's own volume, and its port is never published", () => {
    expect(memory.volumes).toContain("qcr-memory:/opt/quickreview/state/openviking");
    expect(memory.ports).toBeUndefined();
    expect(Object.keys(doc.volumes)).toEqual(
      expect.arrayContaining(["qcr-state", "qcr-pihome", "qcr-ingress", "qcr-memory"]),
    );
    expect(daemon.ports).toEqual(["${QCR_WEBHOOK_BIND:-127.0.0.1}:${QCR_WEBHOOK_PORT:-8787}:8787"]);
    // The memory image's user is any uid: its store and HOME are world-writable.
    expect(read("docker/memory/Dockerfile")).toMatch(
      /^RUN chmod 1777 \/opt\/quickreview\/state \/opt\/quickreview\/state\/openviking \/home\/review$/m,
    );
  });

  it("the config bring-up writes tells the daemon where the memory service is", () => {
    // bring-up's patch names the compose service, on the compose network
    const patched = memoryEndpointPatch("[openviking]\nenabled = true\n");
    expect(patched).not.toBeNull();
    const openviking = (parseToml(patched!) as { openviking: Record<string, unknown> }).openviking;
    expect(openviking.endpoint).toBe("remote");
    expect(openviking.host).toBe("memory");
    expect(Object.keys(doc.services)).toContain(openviking.host);
  });
});

describe("the tunnels are the one built thing, and the image carries what they build from", () => {
  it("each sidecar builds from docker/tunnel/, behind its own profile", () => {
    for (const t of tunnels) {
      expect((t.build as { context: string }).context).toBe("docker/tunnel");
      expect(t.profiles).toHaveLength(1);
    }
    expect(existsSync(join(root, "docker/tunnel/sidecar.mjs"))).toBe(true);
  });

  it("the release image copies the compose file and the tunnel context, and the build context admits them", () => {
    expect(dockerfile).toMatch(/^COPY docker-compose\.yml \.\/docker-compose\.yml$/m);
    expect(dockerfile).toMatch(/^COPY docker\/tunnel \.\/docker\/tunnel$/m);
    expect(dockerignore).toMatch(/^!docker-compose\.yml$/m);
    expect(dockerignore).toMatch(/^!docker\/tunnel$/m);
  });
});

const hasCompose = spawnSync("docker", ["compose", "version"], { encoding: "utf8" }).status === 0;

describe.skipIf(!hasCompose)("docker compose config lints the file", () => {
  const config = (env: Record<string, string>, profile?: string) =>
    spawnSync(
      "docker",
      [
        "compose",
        "-f",
        join(root, "docker-compose.yml"),
        ...(profile ? ["--profile", profile] : []),
        "config",
        "--quiet",
      ],
      {
        encoding: "utf8",
        env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...env },
      },
    );
  const full = { QCR_VERSION: "0.1.0", QCR_SECRETS_DIR: "/tmp/s", QCR_CONFIG_HOME: "/tmp/c" };

  it("accepts it with the .env the bring-up writes, with and without a tunnel", () => {
    expect(config(full).status).toBe(0);
    for (const profile of ["quick-tunnel", "ngrok", "named-tunnel"])
      expect(config(full, profile).status, profile).toBe(0);
  });

  it("refuses it without a version pin, a secrets dir or a config home", () => {
    for (const missing of Object.keys(full)) {
      const env = { ...full } as Record<string, string>;
      delete env[missing];
      const r = config(env);
      expect(r.status, missing).not.toBe(0);
      expect(r.stderr, missing).toContain(missing);
    }
  });
});
