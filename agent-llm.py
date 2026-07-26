#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
agent-llm.py - Ansteel Constitution Agent (V3.1)
=================================================
External models are not just one-shot Q&A - they are agents with tools:
  - Can read code files
  - Can search code
  - Can run commands (compile, test)
  - Can do multi-step reasoning (tool call loop)

Usage:
  python agent-llm.py --role tech-lead --prompt "analyze clock tree" --workdir F:/my_project
  python agent-llm.py --role qa-engineer --prompt "review main.c init order" --workdir F:/my_project
  python agent-llm.py --role staff-engineer --prompt "propose ADC plan" --no-tools

Dependency: requests (already installed), no openai package needed
"""

import argparse
import json
import os
import re
import subprocess
import sys
import glob as glob_module
from pathlib import Path

import requests

# ============================================================
# Config
# ============================================================
SCRIPT_DIR = Path(__file__).parent
DEFAULT_CONFIG_PATH = SCRIPT_DIR / "llm-config.json"


def load_config(role: str, config_path: Path = None) -> dict:
    if config_path is None:
        config_path = DEFAULT_CONFIG_PATH
    with open(config_path, "r", encoding="utf-8") as f:
        cfg = json.load(f)
    default = cfg["default"]
    role_cfg = cfg["roles"].get(role, {})
    merged = {}
    for key in ["base_url", "api_key", "model", "temperature", "max_tokens", "max_tool_rounds"]:
        val = role_cfg.get(key)
        merged[key] = val if val is not None else default.get(key)
    merged["tools"] = role_cfg.get("tools", ["read_file", "list_dir", "grep_code"])
    return merged


# ============================================================
# Tool Definitions (OpenAI function calling format)
# ============================================================
TOOL_DEFS = {
    "read_file": {
        "type": "function",
        "function": {
            "name": "read_file",
            "description": "Read a file's content. For viewing source code, config files, datasheets, etc.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "File path (relative to workdir or absolute)"},
                    "start_line": {"type": "integer", "description": "Start line number (optional, 1-based)"},
                    "end_line": {"type": "integer", "description": "End line number (optional)"}
                },
                "required": ["path"]
            }
        }
    },
    "list_dir": {
        "type": "function",
        "function": {
            "name": "list_dir",
            "description": "List directory contents (files and subdirectories). For understanding project structure.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "Directory path (relative to workdir or absolute)"},
                    "recursive": {"type": "boolean", "description": "List subdirectories recursively (default false)"}
                },
                "required": ["path"]
            }
        }
    },
    "grep_code": {
        "type": "function",
        "function": {
            "name": "grep_code",
            "description": "Search for text pattern (regex) in files. For finding function definitions, register references, macros, etc.",
            "parameters": {
                "type": "object",
                "properties": {
                    "pattern": {"type": "string", "description": "Search pattern (supports regex)"},
                    "path": {"type": "string", "description": "Directory or file path to search"},
                    "file_pattern": {"type": "string", "description": "Filename filter (e.g. *.c, *.h, *.py)"}
                },
                "required": ["pattern", "path"]
            }
        }
    },
    "run_command": {
        "type": "function",
        "function": {
            "name": "run_command",
            "description": "Execute a shell command in the working directory. For compiling, running tests, checking git log, etc. Dangerous operations (delete, format) are blocked.",
            "parameters": {
                "type": "object",
                "properties": {
                    "command": {"type": "string", "description": "Command to execute"},
                    "timeout": {"type": "integer", "description": "Timeout in seconds (default 30)"}
                },
                "required": ["command"]
            }
        }
    }
}

# ============================================================
# Tool Executors
# ============================================================
BLOCKED_COMMANDS = [
    r"\brm\b", r"\bdel\b", r"\brmdir\b", r"\bformat\b",
    r"\bRemove-Item\b", r"\bdeltree\b", r"\bshutil\.rmtree\b",
    r"\bmkfs\b", r"\bdd\b.*of=",
]


def is_safe_command(cmd: str) -> bool:
    for pattern in BLOCKED_COMMANDS:
        if re.search(pattern, cmd, re.IGNORECASE):
            return False
    return True


def exec_read_file(args: dict, workdir: str) -> str:
    path = args["path"]
    if not os.path.isabs(path):
        path = os.path.join(workdir, path)
    path = os.path.normpath(path)
    if not os.path.isfile(path):
        return f"Error: file not found: {path}"
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            lines = f.readlines()
        start = args.get("start_line", 1) - 1
        end = args.get("end_line", len(lines))
        selected = lines[start:end]
        numbered = [f"{start+i+1:4d} | {line.rstrip()}" for i, line in enumerate(selected)]
        result = "\n".join(numbered)
        if len(result) > 30000:
            result = result[:30000] + f"\n... (truncated, total {len(lines)} lines)"
        return result
    except Exception as e:
        return f"Error: read failed: {e}"


def exec_list_dir(args: dict, workdir: str) -> str:
    path = args["path"]
    if not os.path.isabs(path):
        path = os.path.join(workdir, path)
    path = os.path.normpath(path)
    if not os.path.isdir(path):
        return f"Error: directory not found: {path}"
    recursive = args.get("recursive", False)
    entries = []
    if recursive:
        for root, dirs, files in os.walk(path):
            dirs[:] = [d for d in dirs if not d.startswith('.') and d not in
                       ('node_modules', '__pycache__', '.git', 'build', 'Build')]
            level = root.replace(path, '').count(os.sep)
            indent = '  ' * level
            entries.append(f"{indent}{os.path.basename(root)}/")
            for f in sorted(files):
                if not f.startswith('.'):
                    entries.append(f"{indent}  {f}")
            if len(entries) > 500:
                entries.append("... (truncated)")
                break
    else:
        for item in sorted(os.listdir(path)):
            if item.startswith('.'):
                continue
            full = os.path.join(path, item)
            if os.path.isdir(full):
                entries.append(f"  {item}/")
            else:
                size = os.path.getsize(full)
                entries.append(f"  {item}  ({size} bytes)")
    return "\n".join(entries) if entries else "(empty directory)"


def exec_grep_code(args: dict, workdir: str) -> str:
    pattern = args["pattern"]
    path = args["path"]
    if not os.path.isabs(path):
        path = os.path.join(workdir, path)
    path = os.path.normpath(path)
    file_pattern = args.get("file_pattern", "*")

    try:
        regex = re.compile(pattern, re.IGNORECASE)
    except re.error as e:
        return f"Error: invalid regex: {e}"

    results = []
    files_to_search = []

    if os.path.isfile(path):
        files_to_search = [path]
    elif os.path.isdir(path):
        for fp in glob_module.glob(os.path.join(path, "**", file_pattern), recursive=True):
            if os.path.isfile(fp) and not any(
                skip in fp for skip in ['.git', 'node_modules', '__pycache__', '.o', '.bin', '.elf', '.hex']
            ):
                files_to_search.append(fp)
    else:
        return f"Error: path not found: {path}"

    for fp in files_to_search[:200]:
        try:
            with open(fp, "r", encoding="utf-8", errors="replace") as f:
                for i, line in enumerate(f, 1):
                    if regex.search(line):
                        rel = os.path.relpath(fp, workdir)
                        results.append(f"{rel}:{i}: {line.rstrip()}")
                        if len(results) >= 100:
                            results.append("... (>100 matches, truncated)")
                            return "\n".join(results)
        except (PermissionError, OSError):
            continue

    return "\n".join(results) if results else f"No matches for '{pattern}'"


def exec_run_command(args: dict, workdir: str) -> str:
    command = args["command"]
    timeout = args.get("timeout", 30)

    if not is_safe_command(command):
        return f"BLOCKED: command contains dangerous operation: {command}"

    try:
        result = subprocess.run(
            command, shell=True, capture_output=True, text=True,
            cwd=workdir, timeout=timeout
        )
        output = ""
        if result.stdout:
            output += result.stdout
        if result.stderr:
            output += "\n[STDERR]\n" + result.stderr
        output += f"\n[Exit code: {result.returncode}]"
        if len(output) > 20000:
            output = output[:20000] + "\n... (truncated)"
        return output.strip()
    except subprocess.TimeoutExpired:
        return f"Error: command timed out ({timeout}s)"
    except Exception as e:
        return f"Error: execution failed: {e}"


TOOL_EXECUTORS = {
    "read_file": exec_read_file,
    "list_dir": exec_list_dir,
    "grep_code": exec_grep_code,
    "run_command": exec_run_command,
}

# ============================================================
# Role System Prompts (Ansteel Constitution)
# ============================================================
ANSTEEL_RULES = """
## Ansteel Constitution Rules (MUST follow strictly)

### Facts First
- Evidence > Confidence. An L2 with evidence beats an L1 without.
- Say "I don't know" if you don't know. NEVER fabricate.
- Every factual claim MUST have a confidence label (L1-L4).

### Confidence Labels
- L1: Verified - has specific source, cross-verifiable (MUST cite source)
- L2: High confidence - based on reliable knowledge (MUST explain reasoning)
- L3: Needs verification - uncertain (MUST suggest verification method)
- L4: Doubtful/Unknown - possibly wrong (MUST say "I'm not sure")

### Discussion Discipline
- Challenge ideas, not people.
- Correct errors immediately.
- Must respond to every challenge directly.
- Final output must not contain unlabeled L3/L4 claims.

### Tool Usage Principles
- You have tools to read code, search, run commands. USE THEM to verify claims!
- Don't answer from memory what you can verify with tools. Check first, then answer.
- Use read_file to see actual code. Don't guess.
- Use grep_code to find register definitions, function call relationships.
- Use run_command to compile/test (if applicable).
- Claims verified by tools = L1. Unverified = L2-L4.
"""

ROLE_PROMPTS = {
    "tech-lead": f"""You are a Tech Lead at a major tech company.

## Your Responsibilities
1. Define problem scope, key questions, acceptance criteria
2. Personally verify key disputed points (get hands dirty, don't just judge)
3. Lead three-party consensus, form final conclusions
4. Use tools to read code, run commands to verify - don't rely on gut feeling

## Your Ansteel Identity: Cadre (Manager)
- You must personally verify, not just referee
- You must respect QA's veto power

## Work Style
- Rigorous, pragmatic, impartial
- Verify before concluding
{ANSTEEL_RULES}""",

    "staff-engineer": f"""You are a Staff Engineer at a major tech company.

## Your Responsibilities
1. Propose solutions and answers for the topic
2. Every factual claim MUST have confidence label (L1-L4)
3. Use tools to read code, search to support your proposals
4. Respond to every QA challenge point-by-point, no dodging
5. Correct errors, re-label confidence after corrections

## Your Ansteel Identity: Technical Staff
- Your proposals must withstand scrutiny and verification
- Speak with evidence, not authority

## Work Style
- Professional, thorough, well-reasoned
- Acknowledge uncertainty, don't pretend omniscience
- Welcome challenges as improvement opportunities
{ANSTEEL_RULES}""",

    "qa-engineer": f"""You are a QA & Reliability Engineer at a major tech company.

## Your Responsibilities
1. Challenge proposals point-by-point
2. Use tools to read code and verify others' claims
3. Focus on L2-L4 claims: Is evidence sufficient? Is reasoning sound?
4. Check for omissions, contradictions, logic gaps
5. Exercise veto power: can veto unverified critical claims (with reasons)

## Your Ansteel Identity: Worker (with veto power)
- Your veto is REAL, not a rubber stamp
- Dare to say "no", even to the Tech Lead

## Work Style
- Doubt all unverified claims
- Focus on edge cases, exception paths, worst-case scenarios
- Don't let "looks right but no evidence" slide
- Use tools to check code yourself, don't just reason
{ANSTEEL_RULES}""",
}

# ============================================================
# Agent Loop (Core)
# ============================================================
def agent_loop(
    role: str,
    prompt: str,
    workdir: str,
    context: str = "",
    use_tools: bool = True,
    verbose: bool = True,
    config_path: Path = None,
) -> str:
    cfg = load_config(role, config_path)
    api_key = cfg["api_key"]
    base_url = cfg["base_url"].rstrip("/")
    model = cfg["model"]
    temperature = cfg["temperature"]
    max_tokens = cfg["max_tokens"]
    max_rounds = cfg["max_tool_rounds"]
    allowed_tools = cfg["tools"] if use_tools else []

    if "your-" in api_key or not api_key:
        print(f"ERROR: Please configure api_key for {role} in llm-config.json!", file=sys.stderr)
        sys.exit(1)

    # Build messages
    messages = [{"role": "system", "content": ROLE_PROMPTS[role]}]
    if context:
        messages.append({"role": "user", "content": f"Previous discussion context:\n\n{context}"})
        messages.append({"role": "assistant", "content": "OK, I've read the previous discussion and will continue from here."})
    messages.append({"role": "user", "content": prompt})

    # Build tools list
    tools = [TOOL_DEFS[t] for t in allowed_tools if t in TOOL_DEFS] or None

    url = f"{base_url}/chat/completions"
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }

    if verbose:
        print(f"=== Agent: {role} | Model: {model} | Tools: {allowed_tools} ===", file=sys.stderr)
        print(f"---", file=sys.stderr)

    for round_num in range(1, max_rounds + 1):
        body = {
            "model": model,
            "messages": messages,
            "temperature": temperature,
            "max_tokens": max_tokens,
        }
        if tools:
            body["tools"] = tools
            body["tool_choice"] = "auto"

        try:
            resp = requests.post(url, headers=headers, json=body, timeout=120)
            resp.raise_for_status()
            data = resp.json()
        except requests.exceptions.RequestException as e:
            error_body = ""
            if hasattr(e, 'response') and e.response is not None:
                error_body = e.response.text[:500]
            print(f"API Error: {e}\n{error_body}", file=sys.stderr)
            sys.exit(1)

        choice = data["choices"][0]
        msg = choice["message"]
        finish = choice.get("finish_reason", "")

        # Case 1: tool_calls -> execute -> continue loop
        if msg.get("tool_calls"):
            messages.append(msg)

            for tc in msg["tool_calls"]:
                fn_name = tc["function"]["name"]
                try:
                    fn_args = json.loads(tc["function"]["arguments"])
                except json.JSONDecodeError:
                    fn_args = {}

                if verbose:
                    args_str = json.dumps(fn_args, ensure_ascii=False)
                    if len(args_str) > 200:
                        args_str = args_str[:200] + "..."
                    print(f"  [tool] {fn_name}({args_str})", file=sys.stderr)

                executor = TOOL_EXECUTORS.get(fn_name)
                if executor:
                    result = executor(fn_args, workdir)
                else:
                    result = f"Unknown tool: {fn_name}"

                if verbose:
                    preview = result[:200].replace('\n', ' ')
                    print(f"     -> {preview}{'...' if len(result)>200 else ''}", file=sys.stderr)

                messages.append({
                    "role": "tool",
                    "tool_call_id": tc["id"],
                    "content": result,
                })
            continue

        # Case 2: final text -> done
        content = msg.get("content", "")
        if content:
            if verbose:
                print(f"  Done (round {round_num})", file=sys.stderr)
            return content

        # Case 3: empty
        if finish == "stop":
            return "(model returned empty content)"

        return content or f"(abnormal termination: finish_reason={finish})"

    return f"(reached max tool rounds {max_rounds}, forced stop)"


# ============================================================
# CLI Entry
# ============================================================
def main():
    parser = argparse.ArgumentParser(description="Ansteel Constitution Agent (external model with tools)")
    parser.add_argument("--role", required=True,
                        choices=["tech-lead", "staff-engineer", "qa-engineer"],
                        help="Role")
    parser.add_argument("--prompt", required=True, help="Instruction/question")
    parser.add_argument("--workdir", default=".", help="Working directory for tool operations")
    parser.add_argument("--context", default="", help="Previous discussion context")
    parser.add_argument("--no-tools", action="store_true", help="Disable tools, pure chat mode")
    parser.add_argument("--quiet", action="store_true", help="Quiet mode, only output final result")
    parser.add_argument("--config", default=str(DEFAULT_CONFIG_PATH), help="Config file path")
    args = parser.parse_args()

    result = agent_loop(
        role=args.role,
        prompt=args.prompt,
        workdir=os.path.abspath(args.workdir),
        context=args.context,
        use_tools=not args.no_tools,
        verbose=not args.quiet,
        config_path=Path(args.config),
    )

    # Final result to stdout (Codex reads this)
    print(result)


if __name__ == "__main__":
    main()