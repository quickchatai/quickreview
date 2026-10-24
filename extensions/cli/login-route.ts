// The env shim for the login route (extensions/login-route.ts): the one place
// the process's env becomes its config. QCR_LOGIN_OPEN=submit opens pi's login
// menu when no model is usable; anything else leaves `/login` on the input
// line for one Enter.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createLoginRoute, loginRouteConfigFromEnv } from "../login-route.js";

export default function activate(pi: ExtensionAPI): void {
  void createLoginRoute(loginRouteConfigFromEnv(process.env))(pi);
}
