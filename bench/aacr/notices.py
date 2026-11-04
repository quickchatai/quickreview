#!/usr/bin/env python3
"""The third-party notices every published folder of the benchmark release
carries (the Hugging Face tables, the run archive, the slim bundle), in one
place so the three NOTICE files cannot drift apart.

    write_licences(out)   copies LICENSE (Apache-2.0) and LICENSES/MIT-*.txt into `out`
    notice(lead, parts)   the NOTICE text: `lead`, then the paragraphs named in `parts`

The MIT licences of Martian's benchmark and Qodo PR-Review-Bench require their
copyright and permission notice in every copy of a substantial portion: the
full texts ship as LICENSES/MIT-martian.txt and LICENSES/MIT-qodo.txt.
Standard library only.
"""
from __future__ import annotations

import shutil
from pathlib import Path

HERE = Path(__file__).resolve().parent
LICENCES = HERE / "hf" / "LICENSES"

AACR = """It contains material derived from AACR-Bench v1.0 (https://github.com/alibaba/aacr-bench,
dataset commit ab8af8d5c74e2a4d1945d247ea4bbc49f93eb33f, harness commit
68a569759289a83654a59d06db2a72910edf0a4a), licensed under the Apache License, Version 2.0.
AACR-Bench ships no NOTICE file of its own. {modified} Cite: Zhang et al., "AACR-Bench:
Evaluating Automatic Code Review with Holistic Repository-Level Context", arXiv:2601.19494 (2026)."""

MARTIAN = """{where} contain material from Martian's offline code-review benchmark
(https://github.com/withmartian/code-review-benchmark, commit
e616e849755441da38f18bf3adba2c9583b03803): its golden comments and, in the tables, its
published tool-level judgements. MIT License, Copyright (c) 2025 Martian (withmartian.com);
the full licence text, whose copyright and permission notice must accompany these portions,
is in LICENSES/MIT-martian.txt. That part stays under the MIT licence."""

QODO = """{where} contain issues from Qodo PR-Review-Bench
(https://huggingface.co/datasets/Qodo/PR-Review-Bench, revision
a73957c450a70693a743260e5637fffc44625f16), curated by the Qodo team, MIT licence; the full
licence text is in LICENSES/MIT-qodo.txt. That part stays under the MIT licence."""

SWEPR = """SWE-PRBench (https://huggingface.co/datasets/foundry-ai/swe-prbench, CC BY 4.0; harness
MIT): its data is not redistributed here; its human review comments are left out."""

CODE = """Code quoted anywhere in this release (defect evidence and sites, review comments, judge
verdicts and reasoning, Elo judgments, Qodo's problematic-code snippets) comes from the
reviewed open-source repositories at the commits each row or case names, and stays under
each project's own licence, including copyleft (AGPL) and source-available ones (for
example sentry's FSL, n8n's Sustainable Use Licence, elasticsearch's and timescaledb's
source-available parts). The release carries short excerpts only: the reviewed repositories'
code itself (their trees and diffs) is not included."""

THIRD_PARTY_TEXT = """Comments written by third-party review tools (the vendors Martian and Qodo publish, the
upstream GitHub Copilot reviews) and the descriptions PR authors wrote are not included: each
is replaced by a hash and a link to the original. Two copies of vendor text do ship verbatim,
in the run archive and the slim bundle: the Martian judge's extractions of the re-judged
vendors' comments (the scoring dirs' `candidates.json` and `evaluations.json`) and, in the
archive only, the blind annotation's vendor candidates (`analysis/.../fair/secret.json`). That
text belongs to its authors, the vendors' review bots that posted it on public pull requests,
and is not covered by this release's licence. AACR-Bench's own reference comments, some of
which AACR-Bench derived from review bots' comments (flagged `bot_derived`), ship under
AACR-Bench's Apache-2.0 licence as part of its dataset."""


def notice(lead: str, modified: str, martian_where: str, qodo_where: str, swepr: bool = True) -> str:
    parts = [lead, AACR.format(modified=modified), MARTIAN.format(where=martian_where),
             QODO.format(where=qodo_where)]
    if swepr:
        parts.append(SWEPR)
    parts += [CODE, THIRD_PARTY_TEXT]
    return "\n\n".join(p.strip() for p in parts) + "\n"


def write_licences(out: Path) -> None:
    out = Path(out)
    shutil.copyfile(HERE / "hf" / "LICENSE", out / "LICENSE")
    (out / "LICENSES").mkdir(exist_ok=True)
    for f in sorted(LICENCES.glob("MIT-*.txt")):
        shutil.copyfile(f, out / "LICENSES" / f.name)
