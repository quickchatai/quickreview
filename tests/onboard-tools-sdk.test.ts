// The onboarding pi's tool set, on the REAL pi SDK: a pi that loads the wizard
// extension gets `--tools <list>`, and pi 1.4.0 applies that allowlist to
// extension tools too.
// With the old `read,ls,grep` the wizard extension loaded and every one of its
// tools stayed inactive, so the guide could only talk. This loads the real
// extension through pi's own resource loader, builds a session with exactly
// that allowlist, and asserts what is active.
//
// MUTATION: make onboardingToolAllowlist return "read,ls,grep" again — every onboard_*
// expectation fails. Add "bash" to ONBOARD_BUILTIN_TOOLS — the read-only
// expectation fails.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DefaultResourceLoader,
  SessionManager,
  createAgentSession,
} from "@earendil-works/pi-coding-agent";
import { defaultSteps } from "../src/onboard/steps/index.js";
import { onboardingExtensionToolNames, onboardingToolAllowlist } from "../src/onboard/toolnames.js";
import { withEnv } from "./helpers/extension-parity.js";
import { HEAVY_TIMEOUT_MS } from "./helpers/suite-timeouts.js";

const ROOT = join(import.meta.dirname, "..");

let tmp: string | undefined;
afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = undefined;
});

describe("the onboarding pi's --tools allowlist on the real SDK", () => {
  it(
    "activates every wizard tool and no write-capable built-in",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      tmp = mkdtempSync(join(tmpdir(), "qcr-onboard-tools-"));
      const dir = tmp;
      const tools = onboardingToolAllowlist(defaultSteps().map((s) => s.id));
      const active = await withEnv(
        // The extension's engine reads its state under QCR_ROOT and the
        // install's config at QCR_CONFIG: both in the scratch dir.
        { QCR_ROOT: dir, QCR_CONFIG: join(dir, "config.toml") },
        async () => {
          const agentDir = join(dir, "agent");
          const loader = new DefaultResourceLoader({
            cwd: dir,
            agentDir,
            noExtensions: true,
            noSkills: true,
            noContextFiles: true,
            noPromptTemplates: true,
            noThemes: true,
            additionalExtensionPaths: [join(ROOT, "extensions", "cli", "onboarding.ts")],
          });
          await loader.reload({ resolveProjectTrust: async () => true });
          expect(loader.getExtensions().errors).toEqual([]);
          const { session } = await createAgentSession({
            cwd: dir,
            agentDir,
            resourceLoader: loader,
            tools,
            sessionManager: SessionManager.inMemory(dir),
          });
          try {
            return session.getActiveToolNames();
          } finally {
            session.dispose();
          }
        },
      );
      const wizard = onboardingExtensionToolNames(defaultSteps().map((s) => s.id));
      expect(wizard.length).toBeGreaterThan(2);
      for (const name of wizard) expect(active, name).toContain(name);
      for (const name of ["read", "ls", "grep"]) expect(active).toContain(name);
      for (const name of ["bash", "write", "edit"]) expect(active).not.toContain(name);
    },
  );
});
