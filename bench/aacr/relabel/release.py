"""The labelling passes' files as the release carries them, and the check every reader of them runs.

The archive's `analysis` volume and the slim bundle both carry, under `analysis/relabel/`:
  <pass>.labels.jsonl  the label file (one row per labelled unit: the key, the answer, `model`,
                       `effort` and `prompt_sha256`);
  <pass>.prompt.md     the system prompt every request of the pass carried, byte for byte;
  LABELS.json          per pass: the script, the model and effort, the prompt's sha256, the row count.
export_runs.py adds them (`files()`); martian_tiers.py and lost_credit.py `--compute` read them
from the unpacked archive and refuse a label file whose rows do not carry a model and the sha256
of the prompt shipped beside it (`check_rows()`). Standard library only.
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Dict, List

HERE = Path(__file__).resolve().parent
PASSES = ("martian_tiers", "lost_credit")
DIR = "analysis/relabel"  # the path inside the archive's analysis volume and the slim bundle
MODELS = ("gpt-6.1-sol", "claude-opus-5-5")  # the labellers the passes can use (relabel_common)
ROUTE = {"gpt-6.1-sol": "the Elo judge's GPT bridge (bench/aacr/elo/judge-gpt.sh) on a ChatGPT login: one Chat "
                        "Completions turn per request, a strict json_schema answer, no tools",
         "claude-opus-5-5": "the Message Batches API: one user message, a json_schema answer, no tools"}
WHAT = {"martian_tiers": "which posted QuickReview comment each Martian candidate was extracted from, for the "
                         "candidates word overlap cannot settle (benchmark paper, tab:martiantiers)",
        "lost_credit": "whether each posted comment or dropped finding near a defect states it (same), touches it "
                       "(related) or is about something else (different), from text only (QuickReview paper, the "
                       "lost-credit attribution and the validator's kills)"}


def sha256(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()


def read_rows(path: Path) -> List[dict]:
    with open(path) as f:
        return [json.loads(x) for x in f if x.strip()]


def check_rows(rows: List[dict], prompt_text: str, where: str = "") -> List[str]:
    """Every row records a known model and the sha256 of exactly this prompt; [] when all do."""
    want = sha256(prompt_text)
    errs = []
    for i, r in enumerate(rows):
        if r.get("model") not in MODELS:
            errs.append(f"{where}row {i + 1}: model {r.get('model')!r} is not one of {MODELS}")
        if r.get("prompt_sha256") != want:
            errs.append(f"{where}row {i + 1}: prompt_sha256 {r.get('prompt_sha256')!r} is not the prompt's {want}")
    return errs


def provenance(src: Path = HERE) -> dict:
    out = {"note": "The labelling passes behind the benchmark paper's tab:martiantiers and the QuickReview paper's "
                   "lost-credit figures. Each label row records the model, the effort and the sha256 of the "
                   "prompt file beside it; bench/aacr/relabel/<pass>.py --compute turns labels plus this archive "
                   "into the published numbers with no model call.", "passes": {}}
    for name in PASSES:
        rows = read_rows(src / f"{name}.labels.jsonl")
        prompt = (src / f"{name}.prompt.md").read_text()
        models = sorted({r.get("model") for r in rows})
        efforts = sorted({r.get("effort") for r in rows})
        out["passes"][name] = {
            "what": WHAT[name], "script": f"bench/aacr/relabel/{name}.py", "labels": f"{name}.labels.jsonl",
            "rows": len(rows), "prompt": f"{name}.prompt.md", "prompt_sha256": sha256(prompt),
            "model": models[0] if len(models) == 1 else models, "effort": efforts[0] if len(efforts) == 1 else efforts,
            "route": ROUTE.get(models[0]) if len(models) == 1 else None}
    return out


def files(src: Path = HERE) -> Dict[str, bytes]:
    """{path inside the release: bytes} for every file the release carries, after checking each label file
    against its prompt (a mismatch stops the build)."""
    out: Dict[str, bytes] = {}
    for name in PASSES:
        prompt = (src / f"{name}.prompt.md").read_text()
        errs = check_rows(read_rows(src / f"{name}.labels.jsonl"), prompt, f"{name}.labels.jsonl ")
        if errs:
            raise SystemExit("relabel files: " + "; ".join(errs[:5]))
        for f in (f"{name}.labels.jsonl", f"{name}.prompt.md"):
            out[f"{DIR}/{f}"] = (src / f).read_bytes()
    out[f"{DIR}/LABELS.json"] = (json.dumps(provenance(src), indent=1) + "\n").encode()
    return out
