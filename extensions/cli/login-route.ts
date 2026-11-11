// The env shim for the login route (extensions/login-route.ts): the one place
// the process becomes its config. QCR_LOGIN_OPEN=submit opens pi's login menu
// when there is no model to run on; =none is a pi on a borrowed copy of a
// login (a takeover, a debug round), which is told why and opens nothing;
// anything else leaves `/login` on the input line for one Enter. The agent
// dir is this pi's own, as pi itself resolves it: the remembered model choice
// is read from there.
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createLoginRoute, loginRouteConfigFromEnv } from "../login-route.js";

export default function activate(pi: ExtensionAPI): void {
  void createLoginRoute(loginRouteConfigFromEnv(process.env, getAgentDir()))(pi);
}
