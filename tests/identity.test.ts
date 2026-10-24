// The one "is this ours?" answer (packages/pi-plugin/src/identity.ts), for the
// App and for person mode (`[github] auth = "user"`), as a table.
import { describe, expect, it } from "vitest";
import {
  botAccountLogin,
  carriesOwnMarker,
  excludeOwnAppQualifier,
  isOwnContent,
  isPersonMode,
  ownActorAlias,
  ownLogins,
  type GithubIdentity,
} from "@quickchatai/pi-quickreview/src/identity.js";
import { renderedFooter } from "@quickchatai/pi-quickreview/src/reviewrender.js";
import { postingMarker } from "@quickchatai/pi-quickreview/src/postingkey.js";
import { findingMarker } from "@quickchatai/pi-quickreview/src/findingkey.js";

const APP: GithubIdentity = { auth: "app", bot_login: "qcr[bot]", app_slug: "qcr" };
const LEGACY: GithubIdentity = { bot_login: "qcr[bot]", app_slug: "qcr" }; // no key ⇒ app
const PERSON: GithubIdentity = { auth: "user", bot_login: "alice", app_slug: "" };

const MARKED = `Looks fine.\n\n${postingMarker("v1:7:1:abc")}`;
const FOOTED = `Looks fine.\n\n${renderedFooter("alice")}`;
const INLINE = `[nit] tidy this\n\n${findingMarker(1, "k")}`;
const PLAIN = "I typed this myself — please rename the helper.";

describe("isOwnContent", () => {
  const rows: Array<[string, GithubIdentity, string, string, boolean]> = [
    // app mode: by login, as it always was
    ["app: the bot login, plain body", APP, "qcr[bot]", PLAIN, true],
    ["app: the bare App actor (GraphQL)", APP, "qcr", PLAIN, true],
    ["app: a human", APP, "alice", MARKED, false],
    ["app: another bot", APP, "dependabot[bot]", MARKED, false],
    ["legacy config (no auth key) is app", LEGACY, "qcr[bot]", PLAIN, true],
    // person mode: the person's login AND the reviewer's marker or footer
    ["person: posting marker", PERSON, "alice", MARKED, true],
    ["person: review footer", PERSON, "alice", FOOTED, true],
    ["person: finding marker on an inline comment", PERSON, "alice", INLINE, true],
    ["person: the same login typing by hand is a human", PERSON, "alice", PLAIN, false],
    ["person: someone else quoting a marker", PERSON, "bob", MARKED, false],
    ["person: an empty login never matches", PERSON, "", MARKED, false],
    ["person: no App actor exists", PERSON, "qcr", MARKED, false],
  ];
  for (const [name, g, author, body, want] of rows)
    it(name, () => expect(isOwnContent(g, author, body)).toBe(want));
});

describe("the rest of the identity table", () => {
  it("person mode is auth = user, and only that", () => {
    expect([isPersonMode(APP), isPersonMode(LEGACY), isPersonMode(PERSON)]).toEqual([
      false,
      false,
      true,
    ]);
  });

  it("botAccountLogin: the App's login is a bot account; the person's is not", () => {
    expect(botAccountLogin(APP)).toBe("qcr[bot]");
    expect(botAccountLogin(PERSON)).toBe("");
  });

  it("ownLogins and the GraphQL alias: no [bot] spelling and no alias without an App", () => {
    expect(ownLogins(APP)).toEqual(["qcr[bot]"]);
    expect(ownLogins({ ...APP, bot_login: "custom" })).toEqual(["custom", "qcr[bot]"]);
    expect(ownLogins(PERSON)).toEqual(["alice"]);
    expect(ownActorAlias(APP)).toBe("qcr");
    expect(ownActorAlias(PERSON)).toBeUndefined();
    expect(ownActorAlias({ ...PERSON, app_slug: "qcr", bot_login: "qcr[bot]" })).toBeUndefined();
  });

  it("the -author:app/<slug> qualifier is omitted when there is no App slug", () => {
    expect(excludeOwnAppQualifier(APP)).toBe(" -author:app/qcr");
    expect(excludeOwnAppQualifier(PERSON)).toBe("");
    expect(excludeOwnAppQualifier({ ...APP, app_slug: "" })).toBe("");
  });

  it("carriesOwnMarker reads every qcr marker family and the footer, nothing else", () => {
    for (const b of [MARKED, FOOTED, INLINE, "<!-- qcr:reply=5 -->", "<!-- qcr-escalation:ab -->"])
      expect(carriesOwnMarker(b), b).toBe(true);
    for (const b of [PLAIN, "", "<!-- other -->", "qcr-post without the comment"])
      expect(carriesOwnMarker(b), b).toBe(false);
    expect(carriesOwnMarker(null)).toBe(false);
  });
});
