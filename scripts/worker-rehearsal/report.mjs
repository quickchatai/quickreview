#!/usr/bin/env node
// Render docs/worker-rehearsal.md from a rehearsal run: report.mjs <results.tsv> <facts.tsv> <out.md> <sha>
// The findings and the limits are written by hand in findings.md beside this file and carried
// into the report as they are; everything else is this run's.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const [resultsPath, factsPath, out, sha] = process.argv.slice(2);
const here = dirname(fileURLToPath(import.meta.url));
const rows = readFileSync(resultsPath, "utf8")
  .split("\n")
  .filter(Boolean)
  .map((l) => l.split("\t"));
const facts = new Map(
  readFileSync(factsPath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => l.split("\t"))
    .map(([k, ...v]) => [k, v.join("\t")]),
);
const passed = rows.filter((r) => r[1] === "pass").length;
const failed = rows.length - passed;
const cell = (s) =>
  String(s ?? "")
    .replace(/\|/g, "\\|")
    .replace(/\n/g, " ");
const date = new Date().toISOString().slice(0, 10);
const [imgId, imgSize] = (facts.get("release_image") ?? "? 0").split(" ");
const [memId, memSize] = (facts.get("memory_image") ?? "? 0").split(" ");
const mb = (n) => `${(Number(n) / 1e6).toFixed(0)} MB`;

const md = [];
md.push("# Worker rehearsal", "");
md.push(
  `The pre-deletion rehearsal of the worker world: HEAD's release and memory images, run with the cutover run spec's volumes and command (\`deploy/qcr-update.sh\`) over a legacy-shaped host directory, before the legacy runtime was deleted. While the process runtime, the tmux host and the bridge still exist a failure is found before anything is gone.`,
  "",
  `Run ${date} on ${sha}. **${passed} of ${rows.length} checks passed, ${failed} failed.** Cost: $0 (no model, no GitHub, no registry; the containers cannot reach anything but a scripted stub).`,
  "",
  "Re-run it: `scripts/worker-rehearsal.sh` (about 10 minutes with the images built, 25 with a cold build; `--reuse-images`, `--keep`, `--work DIR` and `--only IDS` are in the script's header). It exits 0 only when every check passed, and a full run rewrites this file; an `--only` run writes its report into its work directory.",
  "",
  "## The rehearsal's world",
  "",
  `- **Images**, built from HEAD by \`scripts/worker-rehearsal/build-images.sh\` (the Dockerfiles' own allowlists, staged because this host has no BuildKit): release \`${imgId.slice(0, 19)}\` (${mb(imgSize)}), memory \`${memId.slice(0, 19)}\` (${mb(memSize)}); run spec label ${facts.get("runspec_label") ?? "?"}.`,
  `- **The host directory** (\`scripts/worker-rehearsal/layout.sh\`) is what the VM's \`/opt/quickreview\` is the moment before the cutover: a \`state.db\` created by the LEGACY build with the operator's drain standing and an earlier closed PR; PR 7's legacy interactive-pi JSONL under \`state/pi-sessions\` (${facts.get("legacy_jsonl") ?? "?"}), its header cwd the legacy sandbox root \`/opt/quickreview/sandbox\`; the legacy mounts (\`sandbox/wt\`, \`archive\`, \`commands\`, \`digest\`, \`inject\`, \`verdict\`, the base clone); a pihome with a far-future fake login; a generated App key and ids; \`dry_run = true\`.`,
  "- **The containers** are started with the run spec's flags and volumes, in the run spec's order: the memory sidecar (seeded, key read back, restarted, `/ready`), then the daemon (`daemon`, `--restart unless-stopped --init`, 2 CPUs, 8 GiB, the same bind mounts including the legacy-path continuity mounts).",
  "- **The model** is `scripts/worker-rehearsal/stub.mjs`, an OpenAI-compatible server on the rehearsal network. pi reaches it through the pihome's own `models.json` (a `local` provider) and `config.toml` names `local/m` for every role and tier: no code hook, no real provider. It plays a playbook read off each request (the main session joins the wave with `lens_wave`, writes and commits the verdict, posts through the shim; a lens leaf answers `NONE`).",
  "- **GitHub** is the same stub, answering as `api.github.com` (a network alias, over TLS with a throwaway CA the containers trust through `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`, `CURL_CA_BUNDLE` and `GIT_SSL_CAINFO`) and `auth.openai.com` (pi-ai's own token refresh). The base clone's origin is a local bare repository; \`git\` fetches from it, not from GitHub.",
  "- **The network** is `docker network create --internal`: no route out. The capture is the stub's request log (every request it served) plus what the containers tried to reach and could not (failed lookups in the logs).",
  "",
  "## Results",
  "",
  "| | check | result | evidence |",
  "|---|---|---|---|",
);
for (const [id, status, title, detail] of rows)
  md.push(
    `| ${id} | ${cell(title)} | ${status === "pass" ? "pass" : "**FAIL**"} | ${cell(detail)} |`,
  );
md.push("");
md.push("## The capture", "");
md.push(`- Stub: ${facts.get("capture") ?? "?"}`);
md.push(
  `- Lookups from the containers that could not leave the network: ${facts.get("blocked_lookups") ?? "none"}`,
);
md.push("");
md.push("## Run notes", "");
for (const k of [
  "schema_diff",
  "first_worker",
  "wave",
  "permits_status",
  "burst",
  "debug_end",
  "login_refresh",
  "process_tree_pi",
  "tmux_sessions",
  "status_runtime",
  "answer_without",
  "answer_with",
])
  if (facts.get(k))
    md.push(`- **${k.replace(/_/g, " ")}**: \`${facts.get(k).replace(/`/g, "'").slice(0, 600)}\``);
md.push("");
try {
  md.push(readFileSync(join(here, "findings.md"), "utf8").trimEnd(), "");
} catch {
  /* no findings file */
}
writeFileSync(out, md.join("\n"));
console.log(`wrote ${out}`);
