#!/usr/bin/env python3
"""The scrub rules both exporters (hf_export.py, export_runs.py) add to the
identity placeholders, each read from the environment at export time and never
spelled in this repository:

  $QCR_SCRUB_SECRET_FILES   comma-separated env files (KEY=VALUE lines) whose
                            values are credentials: every value of 12+
                            characters is replaced, wherever it occurs, by
                            `<redacted-secret>`. A reviewer could read its
                            container's environment, so a key can sit in a
                            transcript verbatim; the rule is by value, so no
                            key shape can slip past it.
  $QCR_SCRUB_PRIVATE_WORDS  comma-separated private tokens (a personal handle,
                            a private commit id, an account id) -> `<private>`,
                            any case, never inside a longer word.
  $QCR_SCRUB_HOSTS          comma-separated private host names ->
                            `<private-host>` (the re-grep hunts them too).
  $QCR_SCRUB_CONTENT_RULES  a rules file in git-filter-repo's --replace-text
                            format (the format of the publication kit that
                            rewrote the public repository's history):
                            `OLD==>NEW` literal lines, `regex:OLD==>NEW` lines,
                            a line without `==>` replacing OLD with
                            `***REMOVED***`; every literal first, in file
                            order, then every regex, in file order. The run
                            data quotes the prompts as they were built at run
                            time, so the stand-ins the public repository
                            carries are applied to it the same way.
  $QCR_SCRUB_RENAMES        comma-separated `OLD=NEW` pairs: a run-name study
                            prefix as the run dirs spell it -> the name the
                            release gives it (any case, never inside a longer
                            word or number), in member paths, volume and
                            family names and text alike. The source run dirs
                            keep their names; only the export renames.
  $QCR_PUBLISH_DENYLIST     (re-grep only) the publishability lint's denylist
                            (`[word:|user:|host:]token` lines); default
                            ~/.config/qcr/publish-denylist.txt.

One rule needs no input: the authors' tracker is not public, so its ticket
ids (`FT-` and four digits, in any case, with or without the hyphen) and
any path through its `tracker/` directory (into its efforts, tickets or maps) become
`<ticket>` (TICKET_RULES, by pattern), and so does the lower-case form
without the hyphen (`ft` and a number from 0001, in an image tag or a run
name). No ticket number is kept: a study whose run names began with one is
renamed by $QCR_SCRUB_RENAMES first (RENAME rules, before the tracker's).

Standard library only; bytes in, bytes out.
"""
from __future__ import annotations

import os
import re
from typing import List, Optional, Tuple

SECRET = b"<redacted-secret>"
PRIVATE = b"<private>"
PRIVATE_HOST = b"<private-host>"
TICKET = b"<ticket>"
_SECRET_MIN = 12

# (name, pattern, prefilter as ("low", literal) = in the lower-cased text):
# the tracker path first, so a ticket id inside it goes with the path
TICKET_RULES = [
    ("ticket-path", rb"[\w.~$/{}-]*(?<![A-Za-z0-9_])tracker/(?:efforts|tickets|maps)/[^\s\"'`<>()\[\]{},;]*",
     ("low", b"tracker/")),
    ("ticket-id", rb"(?<![A-Za-z0-9])(?:[Ff][Tt]-\d{3,4}|FT\d{3,4})(?!\d)", ("low", b"ft")),
    # the lower-case form without the hyphen (an image tag, a run name)
    ("ticket-id-lower", rb"(?<![A-Za-z0-9])ft0\d{3}(?!\d)", ("low", b"ft0")),
]


def renames(spec: Optional[str] = None) -> List[Tuple[str, str]]:
    """[(old, new)] from `spec` or $QCR_SCRUB_RENAMES (`OLD=NEW,OLD=NEW`), longest old first."""
    raw = os.environ.get("QCR_SCRUB_RENAMES", "") if spec is None else spec
    out = []
    for pair in raw.split(","):
        if not pair.strip():
            continue
        old, sep, new = pair.partition("=")
        if not sep or not old.strip() or not new.strip():
            raise SystemExit(f"QCR_SCRUB_RENAMES: {pair!r} is not OLD=NEW")
        out.append((old.strip(), new.strip()))
    return sorted(out, key=lambda p: len(p[0]), reverse=True)


def _rename_rx(old: str) -> str:
    # any case; not inside a longer word or number (a hyphen beside it is fine: `x-OLD-y`)
    return r"(?<![A-Za-z0-9])(?i:" + re.escape(old) + r")(?![A-Za-z0-9])"


def rename_rules(spec: Optional[str] = None):
    """[(name, compiled bytes regex, replacement, prefilter)]: the study renames, for export_runs.NAME_RULES."""
    return [("rename", re.compile(_rename_rx(o).encode()), n.encode(), ("low", o.lower().encode()))
            for o, n in renames(spec)]


def rename_rules_str(spec: Optional[str] = None):
    """The same for str text (the HF tables): [(label, regex, replacement)]."""
    return [("study rename", _rename_rx(o), n) for o, n in renames(spec)]


def renamed(name: str, spec: Optional[str] = None) -> str:
    """`name` (a run, family or plan name as the source spells it) as the release names it."""
    for _, rx, rep in rename_rules_str(spec):
        name = re.sub(rx, rep, name)
    return name


def ticket_rules():
    """[(name, compiled bytes regex, replacement, prefilter)] for the tracker."""
    return [(n, re.compile(p), TICKET, pre) for n, p, pre in TICKET_RULES]


def ticket_rules_str():
    """The same rules for str text (the HF tables): [(label, regex, replacement)]."""
    return [({"ticket-path": "tracker path", "ticket-id": "ticket id", "ticket-id-lower": "ticket id"}[n], p.decode(),
             TICKET.decode())
            for n, p, _ in TICKET_RULES]


def env_list(key: str) -> List[str]:
    return [t.strip() for t in os.environ.get(key, "").split(",") if t.strip()]


def secret_values(files: Optional[List[str]] = None) -> List[bytes]:
    """Every credential value of the env files, longest first."""
    out = set()
    for path in files if files is not None else env_list("QCR_SCRUB_SECRET_FILES"):
        with open(os.path.expanduser(path), "rb") as fh:
            for line in fh:
                line = line.strip()
                if not line or line.startswith(b"#") or b"=" not in line:
                    continue
                v = line.split(b"=", 1)[1].strip()
                if len(v) >= 2 and v[:1] == v[-1:] and v[:1] in (b"'", b'"'):
                    v = v[1:-1]
                if len(v) >= _SECRET_MIN:
                    out.add(v)
    return sorted(out, key=len, reverse=True)


def word_rx(token: str) -> "re.Pattern[bytes]":
    """`token` in any case, never inside a longer word (letters, digits, `_`)."""
    return re.compile(rb"(?<![A-Za-z0-9_])(?i:" + re.escape(token.encode()) + rb")(?![A-Za-z0-9_])")


# ---------------------------------------------------------------- content rules (kit format)

_META = set(b"[](){}*+?|^$.")
_QUANT = set(b"*?{")  # the char before one of these may be absent


def regex_anchor(pattern: bytes) -> Tuple[Optional[bytes], bool]:
    """A literal every match of `pattern` must contain, and whether to look
    for it case-insensitively: the longest run of plain characters at
    nesting depth 0 not made optional by a quantifier. (None, _) when the
    pattern has a top-level alternation or no such run of 3+ bytes; the rule
    then runs on every file. Speed only: never a different result."""
    p = pattern
    icase = False
    m = re.match(rb"\(\?([aiLmsux]+)\)", p)
    if m:
        icase = b"i" in m.group(1)
        p = p[m.end():]
    runs: List[bytearray] = [bytearray()]
    depth, i, n = 0, 0, len(p)
    while i < n:
        c = p[i]
        if c == ord("["):  # a class matches one char we cannot name: skip it whole
            i += 1
            if p[i:i + 1] == b"^":
                i += 1
            if p[i:i + 1] == b"]":
                i += 1
            while i < n and p[i] != ord("]"):
                i += 2 if p[i] == 0x5C else 1
            i += 1
            runs.append(bytearray())
            continue
        if c == ord("{"):  # a {m,n} quantifier: its digits are not text
            while i < n and p[i] != ord("}"):
                i += 1
            i += 1
            runs.append(bytearray())
            continue
        if c == ord("("):
            depth += 1
            runs.append(bytearray())
            i += 1
            continue
        if c == ord(")"):
            depth -= 1
            runs.append(bytearray())
            i += 1
            continue
        if c == ord("|") and depth == 0:
            return None, icase
        if c == 0x5C:  # backslash: an escaped punctuation char is a literal; \b, \s, \d ... are not
            nxt = p[i + 1:i + 2]
            lit = nxt if nxt and not nxt.isalnum() else None
            i += 2
        elif c in _META:
            runs.append(bytearray())
            i += 1
            continue
        else:
            lit = bytes([c])
            i += 1
        if lit is None:
            runs.append(bytearray())
            continue
        q = p[i:i + 1]
        if q and q[0] in _QUANT:  # optional or {m,n}-repeated: may be absent
            runs.append(bytearray())
            continue
        if depth == 0:
            runs[-1] += lit
        if q == b"+":  # present, but may repeat: nothing after it joins this run
            runs.append(bytearray())
    best = max(runs, key=len)
    if len(best) < 3:
        return None, icase
    return (bytes(best).lower() if icase else bytes(best)), icase


class ContentRules:
    """A kit-format rules file, applied with git-filter-repo's semantics."""

    def __init__(self, lits: List[Tuple[bytes, bytes]], rxs: List[Tuple["re.Pattern[bytes]", bytes, Optional[bytes], bool]]):
        self.lits = lits
        self.rxs = rxs

    @classmethod
    def parse(cls, text: bytes) -> "ContentRules":
        lits, rxs = [], []
        for line in text.split(b"\n"):
            line = line.rstrip(b"\r")
            repl = b"***REMOVED***"
            if b"==>" in line:
                line, repl = line.rsplit(b"==>", 1)
            if line.startswith(b"regex:"):
                pat = line[6:]
                anchor, icase = regex_anchor(pat)
                rxs.append((re.compile(pat), repl, anchor, icase))
            elif line.startswith(b"glob:"):
                raise SystemExit("content rules: glob: lines are not supported")
            else:
                if line.startswith(b"literal:"):
                    line = line[8:]
                if line:
                    lits.append((line, repl))
        return cls(lits, rxs)

    @classmethod
    def from_env(cls) -> Optional["ContentRules"]:
        path = os.environ.get("QCR_SCRUB_CONTENT_RULES", "").strip()
        if not path:
            return None
        with open(os.path.expanduser(path), "rb") as fh:
            return cls.parse(fh.read())

    def __len__(self) -> int:
        return len(self.lits) + len(self.rxs)

    def apply(self, data: bytes, counts=None) -> bytes:
        for i, (old, new) in enumerate(self.lits):
            if old in data:
                if counts is not None:
                    counts[f"content-rule literal #{i + 1}"] += data.count(old)
                data = data.replace(old, new)
        low = None
        for i, (rx, new, anchor, icase) in enumerate(self.rxs):
            if anchor is not None:
                if icase:
                    if low is None:
                        low = data.lower()
                    if anchor not in low:
                        continue
                elif anchor not in data:
                    continue
            data, n = rx.subn(new, data)
            if n:
                low = None
                if counts is not None:
                    counts[f"content-rule regex #{i + 1}"] += n
        return data


# ---------------------------------------------------------------- the publish denylist (re-grep)

def denylist(path: Optional[str] = None) -> List[Tuple[str, str]]:
    """[(kind, token)] of the publishability lint's denylist; [] when absent."""
    p = path or os.environ.get("QCR_PUBLISH_DENYLIST") or os.path.expanduser("~/.config/qcr/publish-denylist.txt")
    if not os.path.exists(p):
        return []
    out = []
    for raw in open(p, encoding="utf8"):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        m = re.match(r"^(?:(word|user|host):)?(\S+)", line)
        if m:
            out.append((m.group(1) or "word", m.group(2).lower()))
    return out
