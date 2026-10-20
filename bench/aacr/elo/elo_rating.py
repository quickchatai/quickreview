"""Bradley-Terry ratings on the Elo scale, their uncertainty, and the adaptive
schedule that decides which pairs get judged next.

A GAME is one judgment: (pr, x, y, score) with score 1 when x won, 0.5 for a
tie, 0 when y won — ties count as half a win each. The fit is the
Bradley-Terry maximum-likelihood estimate by Hunter's MM iteration, with a
weak prior (half a virtual tie between every pair) so a configuration that
won every game still gets a finite rating. Ratings are reported as
1500 + 400·log10(strength / geometric mean): a 100-point gap means the
higher one wins about 64% of games.

Uncertainty is a bootstrap over PRs, not over games: judgments on one PR share
its difficulty, so the PR is the unit that is resampled.
"""
from __future__ import annotations

import math
import random
from itertools import combinations
from typing import Dict, List, Sequence, Tuple

Game = Tuple[str, str, str, float]  # (pr, x, y, score of x)

PRIOR_TIES = 0.5
BASE = 1500.0


def fit(players: Sequence[str], games: Sequence[Game], iters: int = 500, tol: float = 1e-10) -> Dict[str, float]:
    idx = {p: i for i, p in enumerate(players)}
    k = len(players)
    wins = [0.0] * k
    n = [[0.0] * k for _ in range(k)]
    for i, j in combinations(range(k), 2):
        n[i][j] += PRIOR_TIES
        n[j][i] += PRIOR_TIES
        wins[i] += PRIOR_TIES / 2
        wins[j] += PRIOR_TIES / 2
    for _pr, x, y, s in games:
        i, j = idx[x], idx[y]
        n[i][j] += 1
        n[j][i] += 1
        wins[i] += s
        wins[j] += 1 - s
    p = [1.0] * k
    for _ in range(iters):
        new = []
        for i in range(k):
            denom = sum(n[i][j] / (p[i] + p[j]) for j in range(k) if j != i and n[i][j])
            new.append(wins[i] / denom if denom else p[i])
        g = math.exp(sum(math.log(v) for v in new) / k)
        new = [v / g for v in new]
        done = max(abs(a - b) for a, b in zip(new, p)) < tol
        p = new
        if done:
            break
    return {pl: BASE + 400 * math.log10(p[idx[pl]]) for pl in players}


def bootstrap(players: Sequence[str], games: Sequence[Game], reps: int = 1000, seed: int = 1) -> List[Dict[str, float]]:
    by_pr: Dict[str, List[Game]] = {}
    for g in games:
        by_pr.setdefault(g[0], []).append(g)
    prs = sorted(by_pr)
    rng = random.Random(seed)
    out = []
    for _ in range(reps):
        sample: List[Game] = []
        for _ in prs:
            sample.extend(by_pr[rng.choice(prs)])
        out.append(fit(players, sample, iters=200, tol=1e-8))
    return out


def interval(values: Sequence[float], level: float = 0.95) -> Tuple[float, float]:
    v = sorted(values)
    lo = v[int(math.floor((1 - level) / 2 * (len(v) - 1)))]
    hi = v[int(math.ceil((1 + level) / 2 * (len(v) - 1)))]
    return lo, hi


def table(players: Sequence[str], games: Sequence[Game], reps: int = 1000, seed: int = 1) -> dict:
    """Ratings, 95% intervals, records and the adjacent-gap intervals, ranked."""
    point = fit(players, games)
    boots = bootstrap(players, games, reps=reps, seed=seed) if games else []
    rows = []
    for p in players:
        w = t = l = 0
        for _pr, x, y, s in games:
            if p not in (x, y):
                continue
            mine = s if p == x else 1 - s
            w, t, l = w + (mine == 1), t + (mine == 0.5), l + (mine == 0)
        lo, hi = interval([b[p] for b in boots]) if boots else (float("nan"), float("nan"))
        rows.append({"player": p, "elo": point[p], "lo": lo, "hi": hi, "w": w, "t": t, "l": l})
    rows.sort(key=lambda r: -r["elo"])
    gaps = []
    for a, b in zip(rows, rows[1:]):
        diffs = [bt[a["player"]] - bt[b["player"]] for bt in boots]
        lo, hi = interval(diffs) if diffs else (float("nan"), float("nan"))
        gaps.append({"upper": a["player"], "lower": b["player"], "gap": a["elo"] - b["elo"],
                     "lo": lo, "hi": hi, "separated": bool(diffs) and lo > 0})
    return {"rows": rows, "gaps": gaps, "games": len(games)}


# ---- scheduling ----------------------------------------------------------------------

def pair_key(x: str, y: str) -> Tuple[str, str]:
    return (x, y) if x < y else (y, x)


def round0(runs: Sequence[str], eligible: Dict[str, List[str]], prs_per_pair: int, seed: int) -> List[dict]:
    """Every configuration pair on the same PRs where possible: PRs every run
    reviewed come first (one shared seeded order), then the pair's own extras."""
    order = sorted(set(pr for prs in eligible.values() for pr in prs))
    random.Random(seed).shuffle(order)
    everyone = [pr for pr in order if all(pr in eligible[r] for r in runs)]
    units = []
    for x, y in combinations(runs, 2):
        shared = [pr for pr in order if pr in eligible[x] and pr in eligible[y]]
        picks = [pr for pr in everyone if pr in shared][:prs_per_pair]
        picks += [pr for pr in shared if pr not in picks][:prs_per_pair - len(picks)]
        units.extend({"pr": pr, "x": x, "y": y} for pr in picks)
    return units


def next_round(runs: Sequence[str], eligible: Dict[str, List[str]], done: Dict[Tuple[str, str], List[str]],
               tables: Sequence[dict], per_pair: int, budget: int, seed: int) -> Tuple[List[dict], str]:
    """More PRs for every rank-adjacent pair whose gap is not yet separated in
    ANY judge's table (both judges judge every unit, so agreement stays
    measurable). Returns (units, why-stopped-or-'')."""
    unresolved = []
    for t in tables:
        for g in t["gaps"]:
            k = pair_key(g["upper"], g["lower"])
            if not g["separated"] and k not in unresolved:
                unresolved.append(k)
    if not unresolved:
        return [], "every adjacent gap is separated in every judge's table"
    if budget <= 0:
        return [], "the judgment cap is reached"
    order = sorted(set(pr for prs in eligible.values() for pr in prs))
    random.Random(seed).shuffle(order)
    units: List[dict] = []
    for k in unresolved:
        x, y = k
        fresh = [pr for pr in order if pr in eligible[x] and pr in eligible[y] and pr not in done.get(k, [])]
        units.extend({"pr": pr, "x": x, "y": y} for pr in fresh[:per_pair])
    if not units:
        return [], "the unresolved pairs have no PRs left to judge"
    return units[:budget], ""


def agreement(pairs: Sequence[Tuple[str, str]]) -> dict:
    """pairs of (winner by judge 1, winner by judge 2) in A/B/tie terms."""
    n = len(pairs)
    same = sum(a == b for a, b in pairs)
    opposite = sum({a, b} == {"A", "B"} for a, b in pairs)
    return {"n": n, "same": same, "opposite": opposite,
            "same_rate": same / n if n else None, "opposite_rate": opposite / n if n else None}
