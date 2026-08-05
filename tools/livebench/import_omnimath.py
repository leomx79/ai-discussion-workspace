"""Convert Omni-MATH olympiad problems into the Ansteel LiveBench question format.

The selected questions are the hardest integer-answer problems (difficulty >= 9),
which are closest in spirit to FrontierMath: olympiad-level, exact-match integers,
and typically require computation or deep multi-step reasoning.

Output rows use the same schema as live_bench/frontiermath so the Ansteel protocol
runner and the official LiveBench AIME exact-match scorer work unchanged.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
from pathlib import Path

OMNI_MATH_SOURCE = Path(r"F:\codex\benchmarks\LiveBench\datasets\omni-math\Omni-Math.jsonl")
LIVEBENCH_DATA_ROOT = Path(r"F:\codex\benchmarks\LiveBench\livebench\data\live_bench")
RELEASE = "2024-11-25"
INTEGER_ANSWER = re.compile(r"^\s*\d+\s*$")


def safe_id(problem: str) -> str:
    return "omni-" + hashlib.sha256(problem.encode("utf-8")).hexdigest()[:16]


def load_rows() -> list[dict]:
    rows = []
    with OMNI_MATH_SOURCE.open(encoding="utf-8") as handle:
        for line in handle:
            if line.strip():
                rows.append(json.loads(line))
    return rows


def select_rows(rows: list[dict], min_difficulty: float, limit: int | None) -> list[dict]:
    selected = [
        row
        for row in rows
        if INTEGER_ANSWER.match(row["answer"]) and float(row["difficulty"]) >= min_difficulty
    ]
    selected.sort(key=lambda row: (-float(row["difficulty"]), row["problem"]))
    return selected[:limit] if limit is not None else selected


def to_question(row: dict) -> dict:
    return {
        "question_id": safe_id(row["problem"]),
        "category": "math",
        "task": "omnimath",
        "subtask": "aime_omnimath",
        "livebench_release_date": RELEASE,
        "livebench_removal_date": "",
        "turns": [row["problem"]],
        "ground_truth": row["answer"].strip(),
        "source": row["source"],
        "domain": row["domain"][0] if row.get("domain") else "",
        "difficulty": float(row["difficulty"]),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Import Omni-MATH problems into the Ansteel LiveBench data dir.")
    parser.add_argument("--min-difficulty", type=float, default=9.0)
    parser.add_argument("--limit", type=int, default=None)
    args = parser.parse_args()

    rows = load_rows()
    selected = select_rows(rows, args.min_difficulty, args.limit)
    out_dir = LIVEBENCH_DATA_ROOT / "omnimath"
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / "question.jsonl"
    with out_path.open("w", encoding="utf-8", newline="\n") as handle:
        for row in selected:
            handle.write(json.dumps(to_question(row), ensure_ascii=False) + "\n")
    print(f"wrote {len(selected)} questions to {out_path}")


if __name__ == "__main__":
    main()
