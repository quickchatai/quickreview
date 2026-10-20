// The env shim for the onboarding wizard's extension: the one place the
// process's env and cwd become its config (extensions/onboarding.ts).
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createOnboarding, onboardingConfigFromEnv } from "../onboarding.js";

export default function activate(pi: ExtensionAPI): void {
  void createOnboarding(onboardingConfigFromEnv(process.env, process.cwd()))(pi);
}
