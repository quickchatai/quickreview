#!/usr/bin/env python3
"""The run catalogue: which run family every unit of the bench runs belongs
to, whether that family ships, and the public run index built from it.

The catalogue is a JSON file kept beside the release tooling (not in this
repository): one entry per run family with its member units (run dirs,
scoring dirs, top-level trees), its location, what it was for, the model it
billed, its judges, the claims it backs, `ship` and `hf_tables`. The
exporters read it as the source of truth for what ships:

  ship = "yes"           in the run archive, the slim bundle and the HF tables;
  ship = "archive-only"  in the run archive only (SWE-PRBench);
  anything else          withheld whole, the reason being the part after "no:".

A unit is named by where it lives:

  ("runs", name)       <runs root>/runs/<name>        archive: runs/<name>
  ("om-runs", name)    <open-models>/runs/<name>      archive: open-models/runs/<name>
  ("om-top", name)     <open-models>/<name>           archive: open-models/<name>
  ("top", name)        <runs root>/<name>             archive: <name>

A unit the catalogue does not list is withheld (fail closed), never shipped.
Standard library only.
"""
from __future__ import annotations

import json
import os
import re
from typing import Dict, Iterable, List, Optional, Tuple

import scrub_extra as SX

KINDS = ("runs", "om-runs", "om-top", "top")
SHIPS = ("yes", "archive-only")


def location_kinds(location: str) -> Tuple[str, ...]:
    """The unit kinds a catalogue `location` string covers."""
    loc = location or ""
    out = []
    if "open-models/runs" in loc:
        out.append("om-runs")
    elif "open-models" in loc:
        out.append("om-top")
    if "qcr-bench-runs/runs" in loc:
        out.append("runs")
    elif "qcr-bench-runs/" in loc and "qcr-bench-runs/runs" not in loc:
        out.append("top")
    return tuple(out)


def archive_prefix(kind: str, name: str) -> str:
    return {"runs": f"runs/{name}", "om-runs": f"open-models/runs/{name}",
            "om-top": f"open-models/{name}", "top": name}[kind]


class Catalogue:
    def __init__(self, data: dict):
        # family ids as the release names them (scrub_extra.renamed: $QCR_SCRUB_RENAMES); the
        # members keep their source names, which is how the walk finds them
        data = dict(data, families=[dict(f, id=SX.renamed(f["id"])) for f in data["families"]],
                    uncertain=[dict(u, family=SX.renamed(u["family"])) if u.get("family") else u
                               for u in data.get("uncertain") or []])
        self.data = data
        self.families: Dict[str, dict] = {f["id"]: f for f in data["families"]}
        self.claims: Dict[str, str] = data.get("claims") or {}
        self._unit: Dict[Tuple[str, str], List[str]] = {}
        for f in data["families"]:
            for kind in location_kinds(f.get("location", "")):
                for m in f.get("members") or []:
                    self._unit.setdefault((kind, m), []).append(f["id"])

    @classmethod
    def load(cls, path: str) -> "Catalogue":
        with open(path) as fh:
            return cls(json.load(fh))

    def family_of(self, kind: str, name: str) -> Optional[dict]:
        """The family of a unit; when two families list it (the `*-code`
        dirs: the answer key ships, the reviewed code does not, split per
        file), the shipping one."""
        ids = self._unit.get((kind, name)) or []
        fams = [self.families[i] for i in ids]
        ship = [f for f in fams if f.get("ship") in SHIPS]
        return (ship or fams or [None])[0]

    @staticmethod
    def ships(family: Optional[dict]) -> bool:
        return bool(family) and family.get("ship") in SHIPS

    @staticmethod
    def hf_ships(family: Optional[dict]) -> bool:
        return bool(family) and family.get("ship") == "yes"

    @staticmethod
    def hf_tables(family: Optional[dict]) -> List[str]:
        """The HF configs the family has rows in (catalogue `hf_tables`, the
        "(new)" marks dropped)."""
        if not Catalogue.hf_ships(family):
            return []
        return [re.sub(r"\s*\(new\)$", "", t).strip() for t in family.get("hf_tables") or []]

    @staticmethod
    def withheld_reason(family: Optional[dict]) -> str:
        if family is None:
            return "not in the run catalogue (withheld until catalogued)"
        ship = family.get("ship") or ""
        why = ship.split(":", 1)[1] if ship.startswith("no:") else ship
        return {"own-repo": "withheld: QuickReview reviewing our own repositories (not a benchmark run)",
                "aborted": "left out: an aborted or interrupted attempt",
                "owner": "withheld by the authors: a regression check of a development build (backs no published number)",
                "regenerable": "left out: regenerable (code, caches, scheduler state or release builds)",
                "private": "left out: private working notes"}.get(why, f"left out: {why}")

    def shipped_families(self) -> List[dict]:
        return [f for f in self.data["families"] if self.ships(f)]

    def withheld_families(self) -> List[dict]:
        return [f for f in self.data["families"] if not self.ships(f)]


# ---------------------------------------------------------------- the public run index

INDEX_FIELDS = ("title", "benchmark", "purpose", "arm_config", "model_billed", "judges", "claims", "notes")


# how a recorded build id was matched to its public main commit (the remap's evidence file, `match`):
# "same", the history rewrites' commit maps carry it there (or it is on public main itself);
# "date+subject", matched by author date and subject alone; "ancestor", the rewrite dropped the
# commit, which touched only files never published, so it maps to its nearest kept ancestor
MATCH_KINDS = ("same", "date+subject", "ancestor")


def load_remap(path: Optional[str]) -> Tuple[Dict[str, Optional[str]], Dict[str, dict]]:
    """The commit remap, a flat {recorded qcr_commit: public main commit or
    null}, and its evidence by recorded id: the entries of the file beside it
    (`qcr-commit-remap.json` -> `qcr-commit-remap-evidence.json`), each with
    the `match` kind the release publishes. A remap that maps any id needs
    its evidence file."""
    if not path:
        return {}, {}
    with open(path) as fh:
        remap = json.load(fh)
    ev_path = re.sub(r"\.json$", "", path) + "-evidence.json"
    if not os.path.exists(ev_path):
        if any(remap.values()):
            raise SystemExit(f"{path}: no {os.path.basename(ev_path)} beside it, so no match kind for its mapped ids")
        return remap, {}
    with open(ev_path) as fh:
        return remap, {e["recorded"]: e for e in json.load(fh)["entries"]}


def commit_fields(commit: Optional[str], remap: Dict[str, Optional[str]],
                  evidence: Optional[Dict[str, dict]] = None) -> Dict[str, object]:
    """A run's build commit as the release states it: `qcr_commit` is the
    public main commit the history rewrite made of the recorded one, with
    `qcr_commit_on_public_main` true and `qcr_commit_match` the evidence's
    kind for it (MATCH_KINDS; null when not on public main); a commit with no
    public equivalent keeps its recorded id with false; one the remap does
    not know, with null (and no commit at all is null throughout).
    `qcr_commit_dirty` is true when the recorded id carries `-dirty` (the
    build had uncommitted changes, so it is the named commit plus them, not
    the commit itself), false otherwise; a dirty build keeps the `-dirty`
    suffix on whichever id it publishes."""
    if not commit:
        return {"qcr_commit": None, "qcr_commit_on_public_main": None, "qcr_commit_match": None,
                "qcr_commit_dirty": None}
    c = commit.strip()
    dirty = c.endswith("-dirty")
    base = c[:-len("-dirty")] if dirty else c
    pub = remap_commit(c, remap)
    if pub:
        match = ((evidence or {}).get(remap_key(c, remap)) or {}).get("match")
        return {"qcr_commit": pub + c[len(base):], "qcr_commit_on_public_main": True, "qcr_commit_match": match,
                "qcr_commit_dirty": dirty}
    known = c in remap or base in remap
    return {"qcr_commit": c, "qcr_commit_on_public_main": False if known else None, "qcr_commit_match": None,
            "qcr_commit_dirty": dirty}


def remap_key(commit: str, remap: Dict[str, Optional[str]]) -> str:
    """The remap's key for a recorded id: as spelled, else without `-dirty`."""
    c = commit.strip()
    return c if c in remap else (c[:-len("-dirty")] if c.endswith("-dirty") else c)


def remap_commit(commit: Optional[str], remap: Dict[str, Optional[str]]) -> Optional[str]:
    """The public main commit a run's build commit became after the history
    rewrites (None when it maps to none: a side branch never merged)."""
    if not commit:
        return None
    return remap.get(remap_key(commit, remap))


def _run_json(path: str) -> dict:
    try:
        with open(os.path.join(path, "run.json")) as fh:
            d = json.load(fh)
        return d if isinstance(d, dict) else {}
    except (OSError, ValueError):
        return {}


def index_rows(cat: Catalogue, roots: Dict[str, str], remap: Dict[str, Optional[str]],
               volume_of=None, recorded: Optional[Dict[str, Optional[str]]] = None,
               evidence: Optional[Dict[str, dict]] = None) -> List[dict]:
    """One row per shipped unit: the family's facts plus the unit's own
    run.json facts (set, start, finish, build commit). `roots` maps a unit
    kind to the directory holding it; `volume_of(family_id)` names the
    archive volume(s) the unit's files are in; `recorded`, when given, is
    filled with each row's recorded build commit by its `path` (never
    published: the validation checks the published one against it);
    `evidence`, the remap's evidence (load_remap), gives each match kind.
    Strings are left raw (the caller scrubs)."""
    rows = []
    for f in cat.shipped_families():
        for kind in location_kinds(f.get("location", "")):
            for name in f.get("members") or []:
                if cat.family_of(kind, name) is not f:
                    continue
                base = roots.get(kind)
                path = os.path.join(base, name) if base else None
                if path is None or not os.path.exists(path):
                    continue
                rj = _run_json(path) if os.path.isdir(path) else {}
                commit = rj.get("qcr_commit")
                if recorded is not None:
                    recorded[archive_prefix(kind, name)] = commit
                claims = f.get("claims")
                claim_ids = [c.strip() for c in claims.split(",")] if isinstance(claims, str) and claims != "none" else (
                    list(claims) if isinstance(claims, list) else [])
                rows.append({
                    "unit": name, "path": archive_prefix(kind, name), "family": f["id"],
                    "family_title": f.get("title"), "ship": f.get("ship"), "benchmark": f.get("benchmark"),
                    "set": rj.get("set") if isinstance(rj.get("set"), str) else None,
                    "cases": len(rj["cases"]) if isinstance(rj.get("cases"), list) else None,
                    "started_at": rj.get("started_at"), "finished_at": rj.get("finished_at"),
                    **commit_fields(commit, remap, evidence),
                    "arm_config": f.get("arm_config"), "model_billed": f.get("model_billed"),
                    "judges": f.get("judges"), "purpose": f.get("purpose"), "notes": f.get("notes"),
                    "claims": claim_ids, "hf_tables": Catalogue.hf_tables(f),
                    "archive_volumes": list(volume_of(f["id"])) if volume_of else [],
                })
    rows.sort(key=lambda r: (r["family"], r["path"]))
    return rows


def commit_problems(rows: List[dict], recorded: Dict[str, Optional[str]],
                    remap: Dict[str, Optional[str]], evidence: Optional[Dict[str, dict]] = None) -> Dict[str, int]:
    """Rows of the run index whose published build commit misstates the
    recorded one: `dirty_unflagged`, a run whose recorded id carries `-dirty`
    without `qcr_commit_dirty` true (or a clean one flagged); `off_main`, a
    row marked `qcr_commit_on_public_main` true whose commit is not the
    remap's public main commit for the recorded id (the remap's values are
    the public main commits, each an ancestor of main); `unmatched`, a row on
    public main without a match kind, or not the evidence's kind for its
    recorded id, or a row off main with one; `ancestor_unproven`, an
    "ancestor" row whose evidence does not show the remap's commit an
    ancestor of main with the dropped commits' paths never on it."""
    public = {v for v in remap.values() if v}
    evidence = evidence or {}
    bad = {"dirty_unflagged": 0, "off_main": 0, "unmatched": 0, "ancestor_unproven": 0}
    for r in rows:
        rec = recorded.get(r["path"])
        rec = rec.strip() if isinstance(rec, str) else None
        dirty = bool(rec and rec.endswith("-dirty"))
        if rec and r.get("qcr_commit_dirty") is not dirty:
            bad["dirty_unflagged"] += 1
        match = r.get("qcr_commit_match")
        if r.get("qcr_commit_on_public_main") is True:
            pub = (r.get("qcr_commit") or "")
            pub = pub[:-len("-dirty")] if pub.endswith("-dirty") else pub
            if not rec or pub not in public or pub != remap_commit(rec, remap):
                bad["off_main"] += 1
            ev = evidence.get(remap_key(rec, remap)) if rec else None
            if match not in MATCH_KINDS or not ev or ev.get("match") != match:
                bad["unmatched"] += 1
            if match == "ancestor" and not (ev and ev.get("public_main") == pub == remap_commit(rec, remap)
                                            and ev.get("ancestor_of_origin_main") is True
                                            and ev.get("dropped_paths_on_public_main") == []):
                bad["ancestor_unproven"] += 1
        elif match is not None:
            bad["unmatched"] += 1
    return bad


def withheld_rows(cat: Catalogue) -> List[dict]:
    """Every withheld family, its members and why (the archive README and the
    card name each one). A family the catalogue lists as uncertain says so."""
    unsure = {u.get("family") for u in cat.data.get("uncertain") or [] if not u.get("resolved")}
    return [{"family": f["id"], "title": f.get("title"),
             "reason": Catalogue.withheld_reason(f) + (" (held back pending the owner's confirmation)" if f["id"] in unsure else ""),
             "members": list(f.get("members") or []), "location": f.get("location")}
            for f in cat.withheld_families()]


def claims_index(cat: Catalogue, ids: Iterable[str]) -> Dict[str, str]:
    return {i: cat.claims[i] for i in sorted(set(ids)) if i in cat.claims}
