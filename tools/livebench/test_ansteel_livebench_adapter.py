"""Offline contract regressions for the Ansteel-to-LiveBench answer boundary."""

from __future__ import annotations

import importlib.util
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch


ADAPTER_PATH = Path(__file__).with_name("ansteel_livebench_adapter.py")
PROTOCOL_CONFIG_PATH = Path(__file__).with_name("ansteel-livebench-config.json")
SPEC = importlib.util.spec_from_file_location("ansteel_livebench_adapter", ADAPTER_PATH)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError(f"Cannot load adapter from {ADAPTER_PATH}")
ADAPTER = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = ADAPTER
SPEC.loader.exec_module(ADAPTER)


class AnsteelLiveBenchAdapterTests(unittest.TestCase):
    def test_question_workspace_input_excludes_ground_truth(self) -> None:
        question = {
            "question_id": "question-1",
            "category": "reasoning",
            "task": "spatial",
            "turns": ["Solve the visible prompt."],
            "ground_truth": "MUST_NOT_REACH_ANSTEEL",
        }

        rendered = ADAPTER.render_question_input(question)

        self.assertIn("Solve the visible prompt.", rendered)
        self.assertNotIn("MUST_NOT_REACH_ANSTEEL", rendered)
        self.assertNotIn("ground_truth", rendered)

    def test_benchmark_contract_requires_one_unquoted_final_verdict_marker(self) -> None:
        contract = ADAPTER.render_benchmark_contract("question-1")
        topic = ADAPTER.build_protocol_topic("question-1")

        self.assertIn("exactly one `VERDICT: APPROVE` or `VERDICT: REJECT` marker", contract)
        self.assertIn("Do not quote, restate, embed, or otherwise reproduce", contract)
        self.assertIn("never quote a VERDICT marker elsewhere", topic)

    def test_approved_consensus_extracts_exactly_one_answer(self) -> None:
        report = "\n".join(
            [
                "# Ansteel Engineering Review",
                "",
                "## Status",
                "- Governance result: APPROVED",
                "",
                "## Tech Lead Consensus",
                "Decision accepted by final sign-off.",
                ADAPTER.FINAL_ANSWER_OPEN,
                "42",
                ADAPTER.FINAL_ANSWER_CLOSE,
            ]
        )

        self.assertEqual(ADAPTER.extract_final_answer(report), "42")

    def test_approved_consensus_preserves_multiline_code_and_ignores_tag_mentions(self) -> None:
        report = "\n".join(
            [
                "# Ansteel Engineering Review",
                "",
                "## Status",
                "- Governance result: APPROVED",
                "",
                "## Tech Lead Consensus",
                "Use the `<livebench-final-answer>` block below exactly once.",
                ADAPTER.FINAL_ANSWER_OPEN,
                "",
                '        """',
                "        return 42",
                ADAPTER.FINAL_ANSWER_CLOSE,
            ]
        )

        self.assertEqual(ADAPTER.extract_final_answer(report), '\n        """\n        return 42')

    def test_rejected_or_ambiguous_report_never_becomes_answer(self) -> None:
        rejected = "## Status\n- Governance result: REJECTED\n\n## Tech Lead Consensus\n<livebench-final-answer>42</livebench-final-answer>"
        ambiguous = "## Status\n- Governance result: APPROVED\n\n## Tech Lead Consensus\n<livebench-final-answer>42</livebench-final-answer>\n<livebench-final-answer>43</livebench-final-answer>"

        with self.assertRaises(ADAPTER.ProtocolResultError):
            ADAPTER.extract_final_answer(rejected)
        with self.assertRaises(ADAPTER.ProtocolResultError):
            ADAPTER.extract_final_answer(ambiguous)

    def test_protocol_config_requires_distinct_read_only_roles(self) -> None:
        config = {
            "roles": {
                "tech-lead": {"model": "provider-a/model-a", "tools": ["read"]},
                "staff-engineer": {"model": "provider-b/model-b", "tools": ["grep"]},
                "qa-engineer": {"model": "provider-c/model-c", "tools": ["find", "ls"]},
            },
            "allowProviderFallback": False,
            "allowSingleModel": False,
        }
        with tempfile.TemporaryDirectory() as temporary_directory:
            config_path = Path(temporary_directory) / "ansteel.json"
            config_path.write_text(ADAPTER.json_text(config), encoding="utf-8")
            loaded = ADAPTER.load_protocol_config(config_path)

        self.assertEqual(loaded["roles"]["qa-engineer"]["model"], "provider-c/model-c")

    def test_repository_protocol_config_keeps_strict_role_and_budget_contract(self) -> None:
        config = ADAPTER.load_protocol_config(PROTOCOL_CONFIG_PATH)

        self.assertEqual(
            [config["roles"][role]["model"] for role in ("tech-lead", "staff-engineer", "qa-engineer")],
            [
                "volcengine-agent-plan/glm-5.2",
                "deepseek-flash/deepseek-v4-flash",
                "qwen-token-plan-cn/qwen3.8-max",
            ],
        )
        # These are the core protocol's representable maxima. Within the fixed
        # two-revision topology, they do not impose a practical resource ceiling.
        self.assertEqual(config["stageTimeoutMs"], 2147483647)
        self.assertEqual(config["stageBudgetPolicy"]["maxStageTimeoutMs"], 2147483647)
        self.assertEqual(config["stageBudgetPolicy"]["maxStageExtensions"], 0)
        self.assertEqual(config["maxToolCallsPerStage"], 32)
        self.assertEqual(config["stageBudgetPolicy"]["projectTimeoutMs"], 2147483647)
        self.assertEqual(config["stageBudgetPolicy"]["maxProjectToolCalls"], 1024)

    def test_generated_answer_preserves_official_shape_without_cost_claim(self) -> None:
        question = {
            "question_id": "question-2",
            "category": "reasoning",
            "task": "spatial",
            "turns": ["Prompt"],
        }

        answer = ADAPTER.build_livebench_answer(
            question,
            "final answer",
            "ansteel-three-role-consensus-v1",
            12.5,
            "ansteel-run-123",
            "a" * 64,
        )

        self.assertEqual(answer["model_id"], "ansteel-three-role-consensus-v1")
        self.assertEqual(answer["choices"][0]["turns"], ["final answer"])
        self.assertIsNone(answer["cost_usd"])
        self.assertEqual(answer["api_info"]["provider"], ADAPTER.PROTOCOL_PROVIDER)

    def test_approved_answer_retries_only_the_official_scorer(self) -> None:
        question = {
            "question_id": "question-3",
            "category": "reasoning",
            "task": "spatial",
            "turns": ["Prompt"],
        }
        with tempfile.TemporaryDirectory() as temporary_directory:
            workspace = Path(temporary_directory)
            answer_path = workspace / "answer.jsonl"
            answer_path.write_text('{"question_id":"question-3","choices":[{"turns":["answer"]}]}\n', encoding="utf-8")
            manifest = {
                "protocol_status": "approved",
                "scoring_status": "failed",
                "answer_file": str(answer_path),
            }
            args = SimpleNamespace(
                python_path=Path("python.exe"),
                livebench_root=Path("livebench"),
                release="2024-11-25",
                model_display_name="ansteel-three-role-consensus-v1",
            )
            with patch.object(ADAPTER, "score_question", return_value=(0, workspace / "livebench-judgment.log")) as scorer:
                outcome = ADAPTER.retry_approved_scoring(workspace, "live_bench/reasoning/spatial", question, args, manifest)

            self.assertEqual(outcome, "approved")
            self.assertEqual(scorer.call_count, 1)
            self.assertEqual(manifest["scoring_status"], "passed")
            persisted = ADAPTER.read_json(workspace / "protocol-result.json")
            self.assertEqual(persisted["scoring_exit_code"], 0)


    def test_approved_consensus_uses_final_section_when_transcript_repeats_heading(self) -> None:
        report = "\n".join(
            [
                "# Ansteel Engineering Review",
                "",
                "## Status",
                "- Governance result: APPROVED",
                "",
                "## Full Transcript",
                "### 13. tech-lead / consensus",
                "## Tech Lead Consensus",
                "Role text repeats the heading before the coordinator section.",
                "",
                "## Tech Lead Consensus",
                "Decision accepted by final sign-off.",
                ADAPTER.FINAL_ANSWER_OPEN,
                "42",
                ADAPTER.FINAL_ANSWER_CLOSE,
            ]
        )
        self.assertEqual(ADAPTER.extract_final_answer(report), "42")

    def test_approved_consensus_requires_final_section_when_heading_missing(self) -> None:
        report = "\n".join(
            [
                "# Ansteel Engineering Review",
                "",
                "## Status",
                "- Governance result: APPROVED",
                "",
                "## Some Other Section",
                ADAPTER.FINAL_ANSWER_OPEN,
                "42",
                ADAPTER.FINAL_ANSWER_CLOSE,
            ]
        )
        with self.assertRaises(ADAPTER.ProtocolResultError):
            ADAPTER.extract_final_answer(report)

if __name__ == "__main__":
    unittest.main()
