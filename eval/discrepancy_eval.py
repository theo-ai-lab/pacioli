"""
Pacioli — the citable eval harness (Inspect AI, UK AISI).

The deterministic TypeScript engine is the single classifier. `npm run eval:build`
runs it over the labeled fixtures and writes eval/dataset.jsonl, one row per case:
    {"id": "...", "text": "...", "gold": ["OVERSPEND", ...], "predicted": [...]}
This task only SCORES gold vs predicted — it never re-implements the engine — and
reports PER-CLASS precision/recall (plus overall accuracy + standard error) over a
frozen, seed-shuffled held-out split.

Reproduce:
    npm run eval:build
    inspect eval eval/discrepancy_eval.py --model mockllm/model \
        -T split=test -T seed=1234 -T test_frac=0.2

(--model mockllm/model satisfies Inspect's model requirement; the solver does no
generation, so no API key or network is used.)
"""

from __future__ import annotations

from inspect_ai import Task, task
from inspect_ai.dataset import Dataset, FieldSpec, json_dataset
from inspect_ai.scorer import (
    Metric,
    SampleScore,
    Score,
    Scorer,
    Target,
    accuracy,
    metric,
    scorer,
    stderr,
)
from inspect_ai.solver import Generate, Solver, TaskState, solver

CLASSES = ["OVERSPEND", "SCOPE_CREEP", "UNAUTH_RECURRENCE", "CLAIM_MISMATCH"]


def _gold_pred(s: SampleScore) -> tuple[set[str], set[str]]:
    md = s.score.metadata or {}
    return set(md.get("gold") or []), set(md.get("pred") or [])


@metric
def per_class_precision() -> Metric:
    # Omit a class with zero predictions (e.g. CLAIM_MISMATCH, abstained by design) rather than
    # reporting 0.000 — undefined, matching the TS scorer's dash. A deliberate abstention is not 0% precision.
    def compute(scores: list[SampleScore]) -> dict[str, float]:
        out: dict[str, float] = {}
        for c in CLASSES:
            tp = sum(1 for s in scores if c in _gold_pred(s)[1] and c in _gold_pred(s)[0])
            fp = sum(1 for s in scores if c in _gold_pred(s)[1] and c not in _gold_pred(s)[0])
            if tp + fp:
                out[f"precision/{c}"] = tp / (tp + fp)
        return out

    return compute


@metric
def per_class_recall() -> Metric:
    # Omit a class with no labeled positives (recall undefined), matching the TS scorer's dash.
    def compute(scores: list[SampleScore]) -> dict[str, float]:
        out: dict[str, float] = {}
        for c in CLASSES:
            tp = sum(1 for s in scores if c in _gold_pred(s)[1] and c in _gold_pred(s)[0])
            fn = sum(1 for s in scores if c not in _gold_pred(s)[1] and c in _gold_pred(s)[0])
            if tp + fn:
                out[f"recall/{c}"] = tp / (tp + fn)
        return out

    return compute


@solver
def passthrough() -> Solver:
    # Predictions are precomputed by the engine; surface them as the completion.
    async def solve(state: TaskState, generate: Generate) -> TaskState:
        predicted = state.metadata.get("predicted") or []
        state.output.completion = ",".join(predicted)
        return state

    return solve


@scorer(metrics=[accuracy(), stderr(), per_class_precision(), per_class_recall()])
def setmatch_scorer() -> Scorer:
    async def score(state: TaskState, target: Target) -> Score:
        gold = list(state.metadata.get("gold") or [])
        pred = list(state.metadata.get("predicted") or [])
        return Score(
            value="C" if set(gold) == set(pred) else "I",
            answer=",".join(pred),
            metadata={"gold": gold, "pred": pred},
        )

    return score


def load_split(path: str, split: str, seed: int = 1234, test_frac: float = 0.2) -> Dataset:
    ds = json_dataset(path, FieldSpec(input="text", id="id", metadata=["gold", "predicted"]))
    ds.shuffle(seed=seed)  # in-place, deterministic: same file + seed => identical split
    n_test = max(1, int(len(ds) * test_frac))
    if split == "test":
        return ds[:n_test]
    if split == "train":
        return ds[n_test:]
    return ds  # "all"


@task
def discrepancy_eval(
    dataset_path: str = "dataset.jsonl",  # resolved relative to this task file (eval/)
    split: str = "all",
    seed: int = 1234,
    test_frac: float = 0.2,
) -> Task:
    return Task(
        dataset=load_split(dataset_path, split, seed, test_frac),
        solver=passthrough(),
        scorer=setmatch_scorer(),
    )
