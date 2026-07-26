# -*- coding: utf-8 -*-
import os, sys

path = os.path.join("F:", os.sep, "codex", "ai\u7fa4\u8ba8\u8bba", "ansteel_agents.py")
print(f"Patching: {path}")
print(f"Exists: {os.path.exists(path)}")

with open(path, "r", encoding="utf-8") as f:
    code = f.read()

changes = 0

# Fix 1: line_buffering
old1 = 'sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")'
new1 = 'sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace", line_buffering=True)'
if old1 in code:
    code = code.replace(old1, new1)
    changes += 1
    print("Fix 1a: stdout line_buffering")

old1b = 'sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")'
new1b = 'sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace", line_buffering=True)'
if old1b in code:
    code = code.replace(old1b, new1b)
    changes += 1
    print("Fix 1b: stderr line_buffering")

# Fix 2: TOOL_BUDGET_MSG constant
if "TOOL_BUDGET_MSG" not in code:
    budget_const = '''
# \u5de5\u5177\u8c03\u7528\u9884\u7b97\u63d0\u793a\uff08\u9632\u6b62\u601d\u8003\u6a21\u578b\u65e0\u9650\u8bfb\u6587\u4ef6\uff09
TOOL_BUDGET_MSG = """
\u26a0\ufe0f \u3010\u5de5\u5177\u8c03\u7528\u9884\u7b97\u3011\u4f60\u6700\u591a\u53ea\u80fd\u8c03\u7528 12 \u6b21\u5de5\u5177\uff08read_file/grep_code/list_dir \u5408\u8ba1\uff09\u3002
\u7b56\u7565\uff1a\u5148\u8bfb\u6700\u5173\u952e\u7684 2-3 \u4e2a\u6587\u4ef6\u7684\u6838\u5fc3\u6bb5\u843d\uff0c\u7136\u540e\u7acb\u5373\u57fa\u4e8e\u5df2\u8bfb\u5185\u5bb9\u7ed9\u51fa\u7ed3\u8bba\u3002
\u4e0d\u8981\u8bd5\u56fe\u8bfb\u5b8c\u9879\u76ee\u4e2d\u6240\u6709\u6587\u4ef6\uff01\u4e0d\u8981\u5bf9\u540c\u4e00\u4e2a\u6587\u4ef6\u53cd\u590d\u8bfb\u53d6\u4e0d\u540c\u884c\uff01
\u5982\u679c 12 \u6b21\u5de5\u5177\u8c03\u7528\u5185\u65e0\u6cd5\u5b8c\u6210\uff0c\u5c31\u7528\u5df2\u6709\u4fe1\u606f\u7ed9\u51fa\u6700\u4f73\u5206\u6790\uff0c\u6807\u6ce8\u7f6e\u4fe1\u5ea6\u3002
"""
'''
    marker = "ALL_TOOLS = {"
    if marker in code:
        code = code.replace(marker, budget_const + "\n" + marker)
        changes += 1
        print("Fix 2: TOOL_BUDGET_MSG added")

# Fix 3: Inject budget into prompts
# TL prompt
old_tl = '\u201c\u9879\u76ee\u6587\u4ef6\u7ed3\u6784\u5df2\u5728\u4e0a\u65b9\u5217\u51fa\u3002\u8bf7\u7528 read_file \u5de5\u5177\u8bfb\u53d6\u5173\u952e\u6e90\u6587\u4ef6\uff08\u4f7f\u7528\u4e0a\u9762\u5217\u51fa\u7684\u76f8\u5bf9\u8def\u5f84\uff09\uff0c\u57fa\u4e8e\u5b9e\u9645\u4ee3\u7801\u7ed9\u51fa\u5206\u6790\u3002\u201d if mode == \u201cB\u201d else \u201c\u201d'
# Actually let me search for the actual pattern
import re
# Find all occurrences of the mode B prompt injection
pattern = r'(\u201c\u9879\u76ee\u6587\u4ef6\u7ed3\u6784\u5df2\u5728\u4e0a\u65b9\u5217\u51fa.*?\u201d) if mode == \u201cB\u201d else \u201c\u201d'
# Hmm, the quotes might be regular quotes not smart quotes. Let me check
print(f"Looking for prompt patterns...")
# Count occurrences of the pattern
count = code.count('if mode == "B" else ""')
print(f"Found {count} mode B prompt injections")

# Replace each one to append TOOL_BUDGET_MSG
# Pattern: "..." if mode == "B" else ""
# Replace with: ("..." + TOOL_BUDGET_MSG) if mode == "B" else ""
code = re.sub(
    r'\u201c([^\u201d]*?\u9879\u76ee\u6587\u4ef6\u7ed3\u6784\u5df2\u5728\u4e0a\u65b9\u5217\u51fa[^\u201d]*?)\u201d if mode == \u201cB\u201d else \u201c\u201d',
    lambda m: f'(\u201c{m.group(1)}\\n\u201d + TOOL_BUDGET_MSG) if mode == \u201cB\u201d else \u201c\u201d',
    code
)
# Also try with regular quotes
code = re.sub(
    r'"([^"]*?\u9879\u76ee\u6587\u4ef6\u7ed3\u6784\u5df2\u5728\u4e0a\u65b9\u5217\u51fa[^"]*?)" if mode == "B" else ""',
    lambda m: f'("{m.group(1)}\\n" + TOOL_BUDGET_MSG) if mode == "B" else ""',
    code
)
changes += 1
print("Fix 3: prompt injection attempted")

# Fix 4: per-agent timeout
old_try = '''    try:
        result = await Runner.run(
            agent,
            input=prompt,
            context=ctx,
            max_turns=max_turns,
            run_config=run_config,
        )
    except Exception as e:
        error_msg = f"[ERROR] Agent {agent.name} \u8c03\u7528\u5931\u8d25: {type(e).__name__}: {e}"
        print(error_msg, file=sys.stderr)
        return error_msg'''

new_try = '''    try:
        result = await asyncio.wait_for(
            Runner.run(
                agent,
                input=prompt,
                context=ctx,
                max_turns=max_turns,
                run_config=run_config,
            ),
            timeout=300,  # 5\u5206\u949f\u786c\u8d85\u65f6
        )
    except asyncio.TimeoutError:
        error_msg = f"[ERROR] Agent {agent.name} \u8d85\u65f6\uff085\u5206\u949f\uff09\uff0c\u8df3\u8fc7"
        print(error_msg, file=sys.stderr)
        return error_msg
    except Exception as e:
        error_msg = f"[ERROR] Agent {agent.name} \u8c03\u7528\u5931\u8d25: {type(e).__name__}: {e}"
        print(error_msg, file=sys.stderr)
        return error_msg'''

if old_try in code:
    code = code.replace(old_try, new_try)
    changes += 1
    print("Fix 4: 5min timeout added")
else:
    print("Fix 4: WARNING pattern not found")

# Fix 5: quick mode budget
old_quick = '    if project_scan:\n        full_prompt = project_scan + "\\n" + full_prompt'
new_quick = '    if project_scan:\n        full_prompt = project_scan + "\\n" + TOOL_BUDGET_MSG + "\\n" + full_prompt'
if old_quick in code:
    code = code.replace(old_quick, new_quick)
    changes += 1
    print("Fix 5: quick mode budget added")
else:
    print("Fix 5: skipped")

with open(path, "w", encoding="utf-8") as f:
    f.write(code)

print(f"\nTotal changes: {changes}")
print("Done!")
