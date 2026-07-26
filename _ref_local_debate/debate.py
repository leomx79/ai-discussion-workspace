#!/usr/bin/python3
# -*- coding: utf-8 -*-

"""
Copyright [2025] Rafael Sene (rpsene@gmail.com)

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.

    Contributors: Rafael Sene (rpsene@gmail.com) - Initial implementation

Enhanced Multi-Agent Debate System via Ollama

This script orchestrates a structured debate between multiple AI agents
powered by Ollama. It implements the following features:

1.  Agent Personas: Loaded from a YAML config file for easy customization.
2.  Argument Evolution Tracking: Notes when an agent's position changes.
3.  Moderator Agent: Summarizes rounds and declares a winner.
4.  Semantic Agreement Detection: Ends the debate if agents reach a consensus.
5.  Transcript Export: Saves the full debate to a Markdown file.
6.  Round Timer & Interruptions: Enforces a time limit per round.
7.  Variable Agent Temperament: Controlled via the 'temperature' setting in config.
8.  Voting Mechanism: Agents vote on the most persuasive participant.
"""

import ollama
import argparse
import time
import uuid
import yaml
import random
from typing import List, Dict, Any
from sentence_transformers import SentenceTransformer, util
import torch

# --- Constants and Configuration ---
# Apple Silicon Optimization: Check for Metal Performance Shaders (MPS)
if torch.backends.mps.is_available():
    DEVICE = torch.device("mps")
    print("✅ Found Apple Silicon MPS backend. Using GPU for embeddings.")
else:
    DEVICE = torch.device("cpu")
    print("ℹ️ MPS backend not found. Using CPU for embeddings.")

try:
    # Load the model and move it to the selected device (GPU or CPU)
    EMBEDDING_MODEL = SentenceTransformer("all-MiniLM-L6-v2", device=DEVICE)
except Exception as e:
    print(f"Error loading SentenceTransformer model: {e}")
    print(
        "Please ensure you have an internet connection and the necessary libraries installed."
    )
    exit(1)

# --- Class Definitions ---


class OllamaAgent:
    """Represents an AI agent participating in the debate."""

    def __init__(
        self, name: str, model: str, personality: str, temperature: float = 0.7
    ):
        self.name = name
        self.model = model
        self.personality = personality
        self.temperature = temperature
        self.previous_response: str = ""

    def __repr__(self) -> str:
        return f"OllamaAgent(name={self.name}, model={self.model})"

    def respond(self, history: List[Dict[str, str]], debate_topic: str) -> str:
        """Generates a response based on the debate history and its personality."""
        system_prompt = f"""
You are a participant in a formal debate.
Your Name: {self.name}
Your Persona: {self.personality}
Debate Topic: {debate_topic}

RULES:
- Analyze the previous statements in the history.
- Address other participants' points directly.
- Formulate a clear, concise, and compelling argument from your perspective.
- Do not announce your name. Your response will be labeled automatically.
"""
        messages = [{"role": "system", "content": system_prompt}]

        # Add the debate history to the message list
        for entry in history:
            role = "assistant" if entry["role"] == self.name else "user"
            messages.append(
                {"role": role, "content": f"{entry['role']}: {entry['content']}"}
            )

        try:
            response = ollama.chat(
                model=self.model,
                messages=messages,
                options={"temperature": self.temperature},
            )
            reply = response["message"]["content"].strip()
            return reply
        except Exception as e:
            return f"[Error: Could not get a response from model '{self.model}'. {e}]"


class Moderator:
    """The moderator AI that summarizes rounds and decides the winner."""

    def __init__(self, model: str):
        self.model = model

    def _query_moderator(self, prompt: str) -> str:
        """Helper function to send a prompt to the moderator model."""
        try:
            response = ollama.chat(
                model=self.model, messages=[{"role": "user", "content": prompt}]
            )
            return response["message"]["content"].strip()
        except Exception as e:
            return f"[Error: Moderator model '{self.model}' failed. {e}]"

    def summarize_round(self, history: List[Dict[str, str]], round_num: int) -> str:
        """Summarizes the key points and developments of a debate round."""
        formatted_history = "\n".join(
            [f"- {entry['role']}: {entry['content']}" for entry in history]
        )
        prompt = f"""
As the debate moderator, provide a concise summary of Round {round_num}.
Focus on:
1. The main argument made by each participant.
2. Any key points of conflict or disagreement that emerged.
3. Any shifts in position or notable concessions.

Debate History for this Round:
{formatted_history}
"""
        return self._query_moderator(prompt)

    def decide_winner(
        self, full_history: List[Dict[str, str]], voting_results: Dict[str, int]
    ) -> str:
        """Analyzes the entire debate and voting results to declare a winner."""
        formatted_history = "\n".join(
            [f"- {entry['role']}: {entry['content']}" for entry in full_history]
        )
        formatted_votes = "\n".join(
            [f"- {agent}: {count} vote(s)" for agent, count in voting_results.items()]
        )
        prompt = f"""
As the debate moderator, your final task is to declare a winner.
Base your decision on the entire debate transcript and the peer voting results.

Criteria for your decision:
- Persuasiveness and consistency of arguments.
- Effective rebuttals and engagement with others.
- Clarity and impact of the final statements.
- Consideration of the peer voting results.

Full Debate Transcript:
{formatted_history}

Peer Voting Results:
{formatted_votes}

Announce the winner and provide a detailed justification for your choice.
"""
        return self._query_moderator(prompt)


# --- Core Logic Functions ---


def load_config(config_path: str) -> Dict[str, Any]:
    """Loads debate configuration from a YAML file."""
    try:
        with open(config_path, "r", encoding="utf-8") as f:
            return yaml.safe_load(f)
    except FileNotFoundError:
        print(f"Error: Configuration file not found at '{config_path}'")
        exit(1)
    except yaml.YAMLError as e:
        print(f"Error parsing YAML file: {e}")
        exit(1)


def check_semantic_agreement(responses: List[str], threshold: float) -> bool:
    """Checks if agents' responses are semantically similar enough to be considered in agreement."""
    if len(responses) < 2:
        return False
    embeddings = EMBEDDING_MODEL.encode(responses, convert_to_tensor=True)
    cosine_scores = util.pytorch_cos_sim(embeddings, embeddings)

    # Get the upper triangle of the matrix to avoid self-comparison and duplicates
    # CORRECTED LINE: Changed util.triu to torch.triu
    upper_triangle = torch.triu(torch.ones(cosine_scores.shape), diagonal=1).bool()

    # Check if there are any pairs to compare
    if upper_triangle.sum() == 0:
        return False

    avg_similarity = cosine_scores[upper_triangle].mean()
    return avg_similarity.item() > threshold


def conduct_voting(
    agents: List[OllamaAgent], history: List[Dict[str, str]], debate_topic: str
) -> Dict[str, int]:
    """Asks each agent to vote for the most persuasive participant using semantic matching."""
    print("\n--- 🗳️  Conducting Peer Vote ---")
    votes = {agent.name: 0 for agent in agents}
    # A confidence threshold for matching a vote to an agent's name
    VOTE_SIMILARITY_THRESHOLD = 0.70

    for voter in agents:
        other_agents = [agent.name for agent in agents if agent.name != voter.name]

        prompt = f"""
You are {voter.name}. The formal debate on '{debate_topic}' has concluded.
Your task is to vote for the participant (excluding yourself) who was most persuasive.

The other participants were:
{", ".join(other_agents)}

**VOTING INSTRUCTIONS:**
1.  On the very first line of your response, write **ONLY** the name of the agent you are voting for.
2.  Your response **MUST** begin with the agent's name. Do not add preliminary text or thoughts.
"""
        print(f"{voter.name} is casting their vote...")
        try:
            response = ollama.chat(
                model=voter.model,
                messages=[{"role": "user", "content": prompt}],
                options={"temperature": 0.1},
            )
            response_text = response["message"]["content"].strip()

            # --- Semantic Matching Logic ---
            # Use the first line of the response as the potential vote
            potential_vote = response_text.split("\n")[0].strip()

            if not potential_vote:
                print(f"{voter.name} cast an invalid vote: (empty response)")
                continue

            # Generate embeddings for the potential vote and all valid agent names
            vote_embedding = EMBEDDING_MODEL.encode(
                potential_vote, convert_to_tensor=True
            )
            agent_name_embeddings = EMBEDDING_MODEL.encode(
                other_agents, convert_to_tensor=True
            )

            # Calculate cosine similarities between the vote and each agent name
            similarities = util.pytorch_cos_sim(vote_embedding, agent_name_embeddings)[
                0
            ]

            # Find the agent with the highest similarity score
            best_match_index = torch.argmax(similarities)
            best_match_score = similarities[best_match_index]

            # If the best match is above our confidence threshold, accept the vote
            if best_match_score > VOTE_SIMILARITY_THRESHOLD:
                best_match_agent = other_agents[best_match_index]
                votes[best_match_agent] += 1
                print(
                    f"{voter.name} voted for {best_match_agent} (matched '{potential_vote}' with {best_match_score:.2f} similarity)."
                )
            else:
                print(
                    f"{voter.name} cast an invalid vote: '{potential_vote}' (no close semantic match found)."
                )

        except Exception as e:
            print(f"Error during {voter.name}'s vote: {e}")

    print("\n--- 📊 Voting Results ---")
    for agent_name, count in sorted(
        votes.items(), key=lambda item: item[1], reverse=True
    ):
        print(f"{agent_name}: {count} vote(s)")
    return votes


def export_markdown_transcript(
    filename: str, config: Dict, history: List, summaries: List, final_elements: Dict
):
    """Exports the entire debate to a well-formatted Markdown file."""
    with open(filename, "w", encoding="utf-8") as f:
        f.write(f"# 📜 Debate Transcript: {config['debate_settings']['question']}\n\n")
        f.write("## 🏛️ Debate Configuration\n")
        for agent_conf in config["agents"]:
            f.write(
                f"- **{agent_conf['name']}** (Model: `{agent_conf['model']}`, Temp: `{agent_conf['temperature']}`)\n"
            )
        f.write("\n---\n\n")

        round_num = 1
        current_round_history = []
        for entry in history:
            if "Round Summary" in entry["role"]:
                f.write(f"## 🏁 Round {round_num} Summary\n")
                f.write(f"> {entry['content']}\n\n")
                round_num += 1
                f.write(f"## 🎤 Round {round_num}\n")
            else:
                f.write(f"**{entry['role']}**: {entry['content']}\n\n")

        f.write("---\n\n")
        f.write("## 📝 Final Statements\n")
        for statement in final_elements.get("statements", []):
            f.write(f"**{statement['role']}**: {statement['content']}\n\n")

        f.write("## 🗳️ Peer Voting Results\n")
        for agent_name, count in final_elements.get("votes", {}).items():
            f.write(f"- **{agent_name}**: {count} vote(s)\n")

        f.write("\n## 🏆 Moderator's Final Decision\n")
        f.write(f"{final_elements.get('decision', 'No decision was made.')}\n")


def run_debate(config: Dict[str, Any]):
    """Main function to orchestrate the entire debate."""
    settings = config["debate_settings"]
    question = settings["question"]
    max_rounds = settings["max_rounds"]
    summary_model = settings["summary_model"]
    agreement_threshold = settings["agreement_threshold"]
    round_time_limit = settings["round_time_limit_seconds"]

    agents = [OllamaAgent(**agent_config) for agent_config in config["agents"]]
    moderator = Moderator(summary_model)

    full_history = []
    round_summaries = []

    print(f'---  debating on: "{question}" ---')

    for round_num in range(1, max_rounds + 1):
        print(f"\n--- 🎬 Round {round_num} of {max_rounds} ---")
        round_start_time = time.time()
        round_history = []
        round_responses = []

        # Randomize the speaking order each round
        random.shuffle(agents)

        for agent in agents:
            if time.time() - round_start_time > round_time_limit:
                print(
                    f"\n M-O-D-E-R-A-T-O-R : ⏰ Time limit for Round {round_num} exceeded. Moving on."
                )
                break

            print(f"\n🤔 {agent.name} is thinking...")

            # Combine full history and current round history for context
            context_history = full_history + round_history
            reply = agent.respond(context_history, question)

            print("─" * 70)
            print(f"{agent.name} says:\n{reply}")
            print("─" * 70)

            # Note if the agent's position has evolved
            change_note = ""
            if agent.previous_response and not check_semantic_agreement(
                [agent.previous_response, reply], 0.95
            ):
                change_note = " [Position Evolved]"

            response_entry = {"role": agent.name, "content": f"{reply}{change_note}"}
            round_history.append(response_entry)
            round_responses.append(reply)
            agent.previous_response = reply

        full_history.extend(round_history)

        if check_semantic_agreement(round_responses, agreement_threshold):
            print("\n--- ✅ Consensus Reached ---")
            break

        print("\n M-O-D-E-R-A-T-O-R : Summarizing the round...")
        summary = moderator.summarize_round(round_history, round_num)
        print(f"\n--- 🧾 Round {round_num} Summary ---\n{summary}")
        summary_entry = {
            "role": f"Moderator Round {round_num} Summary",
            "content": summary,
        }
        full_history.append(summary_entry)
        round_summaries.append(summary)

    # --- Post-Debate Phase ---
    print("\n--- 🏁 Debate Concluded: Final Phase ---")
    final_statements = [
        {"role": agent.name, "content": agent.previous_response} for agent in agents
    ]
    print("\n--- 📝 Final Statements ---")
    for statement in final_statements:
        print(f"**{statement['role']}**: {statement['content']}\n")

    voting_results = conduct_voting(agents, full_history, question)

    print("\n M-O-D-E-R-A-T-O-R : Analyzing debate and declaring a winner...")
    decision = moderator.decide_winner(full_history, voting_results)
    print(f"\n--- 🏆 Moderator's Final Decision ---\n{decision}")

    # --- Export ---
    output_file = f"debate_transcript_{uuid.uuid4().hex[:8]}.md"
    final_elements = {
        "statements": final_statements,
        "votes": voting_results,
        "decision": decision,
    }
    export_markdown_transcript(
        output_file, config, full_history, round_summaries, final_elements
    )
    print(f"\n--- 🗂️ Debate transcript saved to: {output_file} ---")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="Enhanced Multi-agent LLM Debate via Ollama."
    )
    parser.add_argument(
        "--config",
        type=str,
        default="config.yaml",
        help="Path to the YAML configuration file for the debate.",
    )
    args = parser.parse_args()

    config_data = load_config(args.config)
    run_debate(config_data)
