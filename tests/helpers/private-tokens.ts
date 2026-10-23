// The private tokens a public file must never carry, as sha256 digests, so a
// file that ships publicly can check for them without naming anything.
//
// Three classes:
//   - words: a text "carries" one when one of its words (a run of letters,
//     digits and dashes, lower-cased), or a run of the word's dash-separated
//     parts, hashes to a listed digest;
//   - home directories: the user segment of `/home/<u>/` or `-home-<u>-`;
//   - dotted host names: a run of dot-joined words (`a.b.c`), lower-cased.
//
// The plain words live outside the repository, with the maintainers. To add
// one, hash its lower-cased spelling (`printf %s word | sha256sum`) and add
// the digest under the label that describes it; never spell it here.
import { createHash } from "node:crypto";

const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

/** Word digests, by the label a hit is reported under. */
const WORDS: Record<string, readonly string[]> = {
  "the owner's first name": ["fe8c433a0e86185e0facbb4c0f4f0cfcc16baff8f2129205c63279fedf2d06b2"],
  "the owner's GitHub handle": ["e358ec847a3acf8c7040f1fb5358162a93788ccad562ca6e4f4b904b66a26ed6"],
  "a teammate's GitHub handle": [
    "08a5fe2ed185892427026912a15847b377260bdf0d561b57d3a7bc3d33dcd554",
    "d2d92295bb52e8470ee69ec3e7a0f35b10023e188ea45237b72721b43f7709e9",
    "6fd9ee6d18d0b65afb5ec3742a59f520ac634d714c06223d4487bffcae3cf79c",
    "d1789a71e11bd6074c3a9d4d2562289130afcc9e2d920eee438b97c6a696e05d",
    "1f370074e6a26a84521980187fd86a413e350e35ee7c116d2649d3da9467cc2e",
  ],
  "a teammate's name or handle": [
    "51e00b415c7a12ab6e7ab591b37a5cd1b7435dfd05f24e025fcb2872a418c90d",
    "89c70fa9d4bc8f7d2fe8151705f80a68a2e916e0964f39cf29cffd609db8425f",
    "fa3d58cfbbdfb36bd5a4e56a13b3c4c864fa34b8b6e2626c541ae579fb610405",
    "9622a79ae4476adaecaec92dbeaafe0fe1b75e7c4fb5dd515974a169912f5b62",
    "a6949331316469717ab43b5cd6badedd092f58b80414303054e520a3e44432b0",
    "a92cc85c0d5235c6eb194e812b3e388d22eee5ad972b0d7d8cd079276fdcf09a",
    "325fbec12364954d6b9cd8a9c63103d49052acac2f7886caa11ccf2eb6578845",
    "21676dc8b4862496916395da32f1586affda0ba98d302090ec7e857865bac637",
    "8eaa48421ece058e78356c8a1c391099cc6d57e0520894089fdcd213ca06e27e",
    "71194ed4e9f947bfd48a5ccefb91a45c80f92fac532c7fba732167a5f757cd32",
    "b033e480010e17cba8473f006fb26e9006bfb67979442080f3b17aed0c508179",
    "f4a742ca60447657a6e4033da3df8033bb625f5f4aa8d4b66cb8723ede0aed86",
    "c7f6318b490e2e5ccbec61b75ecaa49cb0490379cfe9dbe002df933de5a4c69d",
  ],
  "the deployment VM's host name": [
    "2ff8ddd61f5e0a0c72ad9390b7c448e32b5055707f1be2e65a361b24f2a180ce",
    "921ec01e9cf05e6d00c6d090b469730672d894ecbc70e142175e3ba90c8133f0",
  ],
  "the operator terminal's host name or account": [
    "e4070b01c634a1c91e6df4dad34579727a70269e130ea09a788aa056bd7715af",
    "6ed9b5f82dd3ffb50b7605280f82e29f241c0f4fadfeb7dbf4c9922d8c27b6d5",
    "e40bb0573ddc49055e2826dd37798f73b8d38878cf9d97e03513e85d8a41d398",
  ],
  "the cloud project id": ["30fa7f81c91e610cdb9697a05a35082428e6fd90f395e68a5f2e05ddeaa562de"],
  "the private tracker repository": [
    "301a60aa6881b99a394f22e19a1cda623f31e2cb2665e5c4490739e45e884253",
  ],
  "the reviewed repository's name or package": [
    "27ff00ce79d3e8be20f0afd546b54e48a8c4a1b2182d9aea14f28fce9c1be736",
    "a4c689702b15e6f54e57ef51c2abfe2f9e89d55970d18e5bbc326055ad54d43f",
  ],
  "the operator's IDE projects directory": [
    "e925d6b9faf37ab8c3a27fd4c3ddba3ac3e2b1a1e4e291761ce0ea7fc86b2168",
  ],
};

/** Home-directory user segments. */
const HOME_USERS: readonly string[] = [
  "0c1c541af9cc252a1c759f3ae0416921e745c1d359dd9f782ec3d3ff0c432dcf",
];

/** Dotted host names. */
const HOSTS: readonly string[] = [
  // The webhook host.
  "c4190202a15c48509767c9ae6656a779d35c52f2eed7742f6932c4c7d19f95bd",
  // The chat workspace host.
  "c87c57a56f19c674602a43844baecd8440eb80478bcccdaadaf6164d0eeb463f",
];

export const HOME_LABEL = "the operator's home directory";
export const HOST_LABEL = "a private host name";

export interface TokenTables {
  words: ReadonlyMap<string, string>;
  homeUsers: ReadonlySet<string>;
  hosts: ReadonlySet<string>;
}

const wordTable = (words: Record<string, readonly string[]>): Map<string, string> =>
  new Map(Object.entries(words).flatMap(([label, ds]) => ds.map((d) => [d, label] as const)));

export const PRIVATE_TOKENS: TokenTables = {
  words: wordTable(WORDS),
  homeUsers: new Set(HOME_USERS),
  hosts: new Set(HOSTS),
};

/** The production tables plus extra digests: for a negative control's canaries. */
export function tokenTables(extra: {
  words?: Record<string, readonly string[]>;
  homeUsers?: readonly string[];
  hosts?: readonly string[];
}): TokenTables {
  return {
    words: new Map([...PRIVATE_TOKENS.words, ...wordTable(extra.words ?? {})]),
    homeUsers: new Set([...PRIVATE_TOKENS.homeUsers, ...(extra.homeUsers ?? [])]),
    hosts: new Set([...PRIVATE_TOKENS.hosts, ...(extra.hosts ?? [])]),
  };
}

export interface TokenHit {
  /** 1-based line. */
  line: number;
  /** What kind of private token it is; the token itself is never named. */
  label: string;
}

const WORD = /[a-z0-9][a-z0-9-]*/g;
const HOME = /\/home\/([a-z0-9._-]+)|-home-([a-z0-9]+)-/g;
const DOTTED = /[a-z0-9][a-z0-9-]*(?:\.[a-z0-9][a-z0-9-]*)+/g;

/** The private tokens a text carries, one hit per (line, label). */
export function privateTokenHits(text: string, tables: TokenTables = PRIVATE_TOKENS): TokenHit[] {
  const hits: TokenHit[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.toLowerCase();
    const labels = new Set<string>();
    for (const [w] of line.matchAll(WORD)) {
      // The word and every run of its dash-separated parts: `a-b-c` is
      // checked as `a-b-c`, `a-b`, `b-c`, `a`, `b` and `c`.
      const parts = w.split("-");
      for (let from = 0; from < parts.length; from++) {
        for (let to = from + 1; to <= parts.length; to++) {
          const run = parts.slice(from, to).join("-");
          const label = run ? tables.words.get(sha256(run)) : undefined;
          if (label) labels.add(label);
        }
      }
    }
    for (const m of line.matchAll(HOME)) {
      if (tables.homeUsers.has(sha256((m[1] ?? m[2])!))) labels.add(HOME_LABEL);
    }
    for (const [host] of line.matchAll(DOTTED)) {
      // The host itself and every parent domain: `a.b.example.com` carries
      // `b.example.com` too.
      const parts = host.split(".");
      for (let k = 0; k < parts.length - 1; k++)
        if (tables.hosts.has(sha256(parts.slice(k).join(".")))) labels.add(HOST_LABEL);
    }
    for (const label of labels) hits.push({ line: i + 1, label });
  }
  return hits;
}

/** The 1-based line numbers of `text` that carry any private token. */
export function privateHandleLines(text: string): number[] {
  return [...new Set(privateTokenHits(text).map((h) => h.line))];
}
