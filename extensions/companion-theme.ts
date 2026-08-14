// Companion-only low-contrast theme. Tool success intentionally uses the same
// neutral background as pending tools: command completion must not flash a
// bright green panel at the operator.
//
// VERIFY-ON-PIN: session_start's second argument and ctx.ui.setTheme are the
// documented 0.84.1 extension API, also exercised by pi's mac-system-theme
// example.
import type { Pi } from "@earendil-works/pi-coding-agent";

export const COMPANION_THEME = "companion-muted";

export const activate = (pi: Pi): void => {
  pi.on("session_start", (_event, ctx) => {
    const ui = ctx?.ui as { setTheme?: (theme: string) => { success: boolean; error?: string } } | undefined;
    const result = ui?.setTheme?.(COMPANION_THEME);
    if (result && !result.success) console.error(`[companion-theme] ${result.error ?? "could not select theme"}`);
  });
};

export default activate;
