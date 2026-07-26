#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
ansteel_agents.py — 鞍钢宪法多智能体讨论系统（基于 OpenAI Agents SDK）
=====================================================================

不是从零造轮子！基于 openai-agents 框架（pip install openai-agents），
外部模型（GLM/DeepSeek/Claude/通义千问）全部变成真正的工具智能体：
  - 能读代码文件
  - 能搜索代码
  - 能跑命令（编译、测试）
  - 能多步推理（框架自动管理 tool-calling 循环）

用法:
  python ansteel_agents.py "AT32F407的4通道ADC温度采集怎么做"
  python ansteel_agents.py "review main.c 的初始化顺序" --workdir F:/my_project --mode B
  python ansteel_agents.py "快速问一下：STM32的HAL库和LL库区别" --quick

依赖: pip install openai-agents
配置: llm-config.json（已有，填上 API Key 即可）
"""

import argparse
import asyncio
import json
import os
import re
import subprocess
import sys
import glob as glob_module
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Optional

from agents import (
    Agent,
    ModelSettings,
    RunContextWrapper,
    Runner,
    RunConfig,
    function_tool,
    set_tracing_disabled,
)
from agents.models.openai_chatcompletions import OpenAIChatCompletionsModel
from openai import AsyncOpenAI
import httpx

# 关闭 OpenAI tracing（我们用自定义模型，不需要发到 OpenAI 服务器）
set_tracing_disabled(True)

# Windows 终端 UTF-8 输出
if sys.platform == "win32":
    import io
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace", line_buffering=True)
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace", line_buffering=True)

SCRIPT_DIR = Path(__file__).parent
DEFAULT_CONFIG = SCRIPT_DIR / "llm-config.json"


# ============================================================
# 1. 配置加载
# ============================================================

def load_config(config_path: Path = DEFAULT_CONFIG) -> dict:
    """读取 llm-config.json，合并 default + role 配置"""
    with open(config_path, "r", encoding="utf-8-sig") as f:
        cfg = json.load(f)
    return cfg


def get_role_config(cfg: dict, role: str) -> dict:
    """获取某角色的完整配置（default + role 覆盖）"""
    default = cfg.get("default", {})
    role_cfg = cfg.get("roles", {}).get(role, {})
    merged = {}
    for key in ["base_url", "api_key", "model", "temperature", "max_tokens", "max_tool_rounds", "ssl_verify"]:
        val = role_cfg.get(key)
        merged[key] = val if val is not None else default.get(key)
    merged["tools"] = role_cfg.get("tools", default.get("tools", ["read_file", "list_dir", "grep_code", "read_memory", "save_memory", "search_history"]))
    return merged


def make_model(role_cfg: dict) -> OpenAIChatCompletionsModel:
    """根据角色配置创建模型实例（支持任意 OpenAI 兼容 API）"""
    base_url = role_cfg["base_url"]
    api_key = role_cfg["api_key"]

    # 通用 fallback
    if not api_key or api_key.startswith("your-"):
        api_key = os.environ.get("ANSTEEL_API_KEY", api_key)
    if not api_key or api_key.startswith("your-"):
        print(f"[ERROR] 请配置 API Key！编辑 llm-config.json 或设置环境变量 ANSTEEL_API_KEY", file=sys.stderr)
        sys.exit(1)

    # SSL 验证：代理服务可能证书过期，配置 "ssl_verify": false 可跳过
    ssl_verify = role_cfg.get("ssl_verify", True)
    if not ssl_verify:
        http_client = httpx.AsyncClient(verify=False)
        client = AsyncOpenAI(base_url=base_url, api_key=api_key, http_client=http_client)
    else:
        client = AsyncOpenAI(base_url=base_url, api_key=api_key)

    return OpenAIChatCompletionsModel(model=role_cfg["model"], openai_client=client)


# ============================================================
# 2. 讨论上下文（所有工具共享）
# ============================================================

@dataclass
class DiscussionContext:
    """智能体共享的运行时上下文"""
    workdir: str = "."
    discussion_log: list = field(default_factory=list)  # 累积的讨论记录
    memory_dir: str = ""   # .ansteel/ 记忆目录
    project_profile: dict = field(default_factory=dict)  # 项目画像


# ============================================================
# 3. 工具定义（@function_tool — 框架自动管理调用循环）
# ============================================================

BLOCKED_COMMANDS = [
    r"\brm\b", r"\bdel\b", r"\brmdir\b", r"\bformat\b",
    r"\bRemove-Item\b", r"\bRemove-Item\s", r"\bClear-Disk\b",
    r"\bmkfs\b", r"\bdd\b.*of=/dev/", r"\bshutdown\b", r"\breboot\b",
]


@function_tool
def read_file(ctx: RunContextWrapper[DiscussionContext], path: str,
              start_line: int = 0, end_line: int = 0) -> str:
    """读取文件内容。用于查看源代码、配置文件、数据手册等。

    Args:
        path: 文件路径（相对于工作目录或绝对路径）
        start_line: 起始行号（可选，从1开始，0表示从头）
        end_line: 结束行号（可选，0表示到尾）
    """
    workdir = ctx.context.workdir
    fpath = Path(path) if Path(path).is_absolute() else Path(workdir) / path
    if not fpath.exists():
        return f"[ERROR] 文件不存在: {fpath}"
    if not fpath.is_file():
        return f"[ERROR] 不是文件: {fpath}"
    try:
        text = fpath.read_text(encoding="utf-8", errors="replace")
    except Exception as e:
        return f"[ERROR] 读取失败: {e}"
    lines = text.splitlines()
    total = len(lines)
    s = max(start_line - 1, 0) if start_line > 0 else 0
    e = end_line if end_line > 0 else total
    e = min(e, total)
    selected = lines[s:e]
    header = f"[文件: {fpath.name} | 行 {s+1}-{e}/{total}]\n"
    return header + "\n".join(selected)


@function_tool
def list_dir(ctx: RunContextWrapper[DiscussionContext], path: str,
             recursive: bool = False) -> str:
    """列出目录内容（文件和子目录）。用于了解项目结构。

    Args:
        path: 目录路径（相对于工作目录或绝对路径）
        recursive: 是否递归列出子目录（默认 false）
    """
    workdir = ctx.context.workdir
    dpath = Path(path) if Path(path).is_absolute() else Path(workdir) / path
    if not dpath.exists():
        return f"[ERROR] 目录不存在: {dpath}"
    if not dpath.is_dir():
        return f"[ERROR] 不是目录: {dpath}"
    result = []
    if recursive:
        for item in sorted(dpath.rglob("*")):
            rel = item.relative_to(dpath)
            prefix = "[D] " if item.is_dir() else "[F] "
            result.append(f"{prefix}{rel}")
            if len(result) > 300:
                result.append(f"... (超过300项，截断)")
                break
    else:
        for item in sorted(dpath.iterdir()):
            prefix = "[D] " if item.is_dir() else "[F] "
            size = "" if item.is_dir() else f" ({item.stat().st_size} bytes)"
            result.append(f"{prefix}{item.name}{size}")
    return f"[目录: {dpath}]\n" + "\n".join(result) if result else f"[目录: {dpath}] (空)"


@function_tool
def grep_code(ctx: RunContextWrapper[DiscussionContext], pattern: str, path: str,
              file_pattern: str = "*") -> str:
    """在文件中搜索文本模式（支持正则表达式）。用于查找函数定义、寄存器引用、宏定义等。

    Args:
        pattern: 搜索模式（支持正则表达式）
        path: 要搜索的目录或文件路径
        file_pattern: 文件名过滤（如 *.c, *.h, *.py）
    """
    workdir = ctx.context.workdir
    spath = Path(path) if Path(path).is_absolute() else Path(workdir) / path
    try:
        regex = re.compile(pattern, re.IGNORECASE)
    except re.error as e:
        return f"[ERROR] 无效的正则表达式: {e}"

    results = []
    files_to_search = []
    if spath.is_file():
        files_to_search = [spath]
    elif spath.is_dir():
        files_to_search = sorted(spath.rglob(file_pattern))
    else:
        return f"[ERROR] 路径不存在: {spath}"

    for fpath in files_to_search:
        if not fpath.is_file():
            continue
        # 跳过二进制和太大的文件
        if fpath.stat().st_size > 1_000_000:
            continue
        try:
            text = fpath.read_text(encoding="utf-8", errors="replace")
        except Exception:
            continue
        for i, line in enumerate(text.splitlines(), 1):
            if regex.search(line):
                rel = fpath.relative_to(spath) if spath.is_dir() else fpath.name
                results.append(f"{rel}:{i}: {line.strip()}")
                if len(results) > 100:
                    results.append("... (超过100条，截断)")
                    return "\n".join(results)
    return "\n".join(results) if results else f"未找到匹配 '{pattern}' 的内容"


@function_tool
def run_command(ctx: RunContextWrapper[DiscussionContext], command: str,
                timeout: int = 30) -> str:
    """在工作目录中执行 shell 命令。用于编译、运行测试、查看 git log 等。
    危险操作（删除、格式化）会被阻止。

    Args:
        command: 要执行的命令
        timeout: 超时秒数（默认30）
    """
    # 安全检查
    for blocked in BLOCKED_COMMANDS:
        if re.search(blocked, command, re.IGNORECASE):
            return f"[BLOCKED] 命令包含危险操作，已被阻止: {command}"

    workdir = ctx.context.workdir
    try:
        result = subprocess.run(
            command, shell=True, capture_output=True, text=True,
            timeout=timeout, cwd=workdir, encoding="utf-8", errors="replace"
        )
        output = ""
        if result.stdout:
            output += result.stdout
        if result.stderr:
            output += f"\n[STDERR]\n{result.stderr}"
        output = output.strip()
        if len(output) > 5000:
            output = output[:5000] + "\n... (输出截断)"
        return f"[exit={result.returncode}]\n{output}" if output else f"[exit={result.returncode}] (无输出)"
    except subprocess.TimeoutExpired:
        return f"[TIMEOUT] 命令超时 ({timeout}s): {command}"
    except Exception as e:
        return f"[ERROR] 执行失败: {e}"




# ============================================================
# 3b. 记忆工具（持久化项目知识）
# ============================================================

def _get_memory_dir(ctx: RunContextWrapper[DiscussionContext]) -> Path:
    """获取记忆目录，不存在则创建"""
    mem_dir = Path(ctx.context.memory_dir) if ctx.context.memory_dir else Path(ctx.context.workdir) / ".ansteel"
    mem_dir.mkdir(parents=True, exist_ok=True)
    return mem_dir


@function_tool
def read_memory(ctx: RunContextWrapper[DiscussionContext], category: str) -> str:
    """读取项目记忆。用于了解项目背景、历史讨论、已积累的知识。

    Args:
        category: 记忆类别，可选值：
          - "project" : 项目画像（芯片型号、RTOS、外设、已知约束）
          - "history" : 历史讨论摘要（日期、主题、关键结论）
          - "knowledge": 累积知识库（技术要点、经验教训）
          - "evolution": 进化日志（系统犯过的错、学到的教训）
    """
    mem_dir = _get_memory_dir(ctx)
    file_map = {
        "project": ("project.json", "json"),
        "history": ("history.json", "json"),
        "knowledge": ("knowledge.md", "md"),
        "evolution": ("evolution.md", "md"),
    }
    if category not in file_map:
        return f"[ERROR] 未知类别: {category}。可选: {list(file_map.keys())}"
    filename, fmt = file_map[category]
    fpath = mem_dir / filename
    if not fpath.exists():
        return f"[{category}] 暂无记录（首次讨论）"
    try:
        text = fpath.read_text(encoding="utf-8")
        if fmt == "json":
            data = json.loads(text)
            text = json.dumps(data, ensure_ascii=False, indent=2)
        # 截断过长的记忆
        if len(text) > 6000:
            text = text[:6000] + "\n...(记忆过长，已截断)"
        return f"[{category}]\n{text}"
    except Exception as e:
        return f"[ERROR] 读取失败: {e}"


@function_tool
def save_memory(ctx: RunContextWrapper[DiscussionContext], category: str,
                content: str, append: bool = True) -> str:
    """保存发现到项目记忆。用于记录新发现的项目信息、技术要点、经验教训。

    Args:
        category: 记忆类别（project/history/knowledge/evolution）
        content: 要保存的内容（markdown格式）
        append: 是否追加（默认true）。project类别建议用false覆盖。
    """
    mem_dir = _get_memory_dir(ctx)
    file_map = {
        "project": "project.json",
        "history": "history.json",
        "knowledge": "knowledge.md",
        "evolution": "evolution.md",
    }
    if category not in file_map:
        return f"[ERROR] 未知类别: {category}"
    fpath = mem_dir / file_map[category]

    # project 和 history 是 JSON，特殊处理
    if category == "project":
        try:
            existing = json.loads(fpath.read_text(encoding="utf-8")) if fpath.exists() else {}
            # content 应该是 JSON 格式的更新
            try:
                updates = json.loads(content)
                existing.update(updates)
            except json.JSONDecodeError:
                existing["notes"] = existing.get("notes", "") + "\n" + content
            fpath.write_text(json.dumps(existing, ensure_ascii=False, indent=2), encoding="utf-8")
            return f"[SAVED] 项目画像已更新: {list(updates.keys()) if isinstance(updates, dict) else 'notes'}"
        except Exception as e:
            return f"[ERROR] 保存失败: {e}"

    if category == "history":
        try:
            existing = json.loads(fpath.read_text(encoding="utf-8")) if fpath.exists() else []
            try:
                entry = json.loads(content)
                existing.append(entry)
            except json.JSONDecodeError:
                existing.append({"note": content, "date": __import__("datetime").datetime.now().isoformat()})
            fpath.write_text(json.dumps(existing, ensure_ascii=False, indent=2), encoding="utf-8")
            return f"[SAVED] 历史记录已追加（共 {len(existing)} 条）"
        except Exception as e:
            return f"[ERROR] 保存失败: {e}"

    # knowledge 和 evolution 是 markdown，直接追加
    try:
        if append and fpath.exists():
            existing = fpath.read_text(encoding="utf-8")
            fpath.write_text(existing + "\n\n" + content, encoding="utf-8")
        else:
            fpath.write_text(content, encoding="utf-8")
        return f"[SAVED] {category} 已{'追加' if append else '覆盖'}"
    except Exception as e:
        return f"[ERROR] 保存失败: {e}"


@function_tool
def search_history(ctx: RunContextWrapper[DiscussionContext], query: str) -> str:
    """搜索历史讨论记录。用于查找之前讨论过的相关问题。

    Args:
        query: 搜索关键词（如"ADC"、"死锁"、"时钟配置"）
    """
    mem_dir = _get_memory_dir(ctx)
    fpath = mem_dir / "history.json"
    if not fpath.exists():
        return "[history] 暂无历史记录"
    try:
        history = json.loads(fpath.read_text(encoding="utf-8"))
        results = []
        query_lower = query.lower()
        for entry in history:
            entry_str = json.dumps(entry, ensure_ascii=False).lower()
            if query_lower in entry_str:
                results.append(entry)
        if not results:
            return f"[history] 未找到与 '{query}' 相关的历史讨论"
        return f"[history] 找到 {len(results)} 条相关记录:\n" + json.dumps(results, ensure_ascii=False, indent=2)
    except Exception as e:
        return f"[ERROR] 搜索失败: {e}"


# 工具名 → 工具对象 的映射

# 工具调用预算提示（防止思考模型无限读文件）
TOOL_BUDGET_MSG = """
⚠️ 【工具调用预算】你最多只能调用 12 次工具（read_file/grep_code/list_dir 合计）。
策略：先读最关键的 2-3 个文件的核心段落，然后立即基于已读内容给出结论。
不要试图读完项目中所有文件！不要对同一个文件反复读取不同行！
如果 12 次工具调用内无法完成，就用已有信息给出最佳分析，标注置信度。
"""

ALL_TOOLS = {
    "read_file": read_file,
    "list_dir": list_dir,
    "grep_code": grep_code,
    "run_command": run_command,
    "read_memory": read_memory,
    "save_memory": save_memory,
    "search_history": search_history,
}


# ============================================================
# 4. 角色 System Prompt（鞍钢宪法职责）
# ============================================================

ROLE_INSTRUCTIONS = {
    "tech-lead": """你是 Tech Lead（技术负责人），鞍钢宪法中的"干部"。

你的职责：
- 定义问题范围、关键约束、验收标准
- 亲自验证争议点（干部参加劳动，不能只指挥不动手）
- 排优先级、做架构评估、最终裁决
- 主持三方合议，形成结论

规则：
- 每个事实性断言必须标注置信度：L1🟢已验证 / L2🟡高可信 / L3🟠待验证 / L4🔴存疑
- 不知道就说不知道，绝不编造
- 有工具就用工具验证，不要空谈
- 回复用中文，技术术语保留英文""",

    "staff-engineer": """你是 Staff Engineer（主任工程师），鞍钢宪法中的"技术人员"。

你的职责：
- 提出具体技术方案（带代码示例、寄存器配置、参数计算）
- 读代码、定位问题、分析根因
- 系统架构分析、模块依赖图
- 回应质疑时必须有证据（代码、数据手册、测试结果）

规则：
- 每个事实性断言必须标注置信度：L1🟢已验证 / L2🟡高可信 / L3🟠待验证 / L4🔴存疑
- 方案必须具体到可执行（不能只说"建议优化"，要说怎么优化）
- 有工具就用工具验证，不要空谈
- 回复用中文，技术术语保留英文""",

    "qa-engineer": """你是 QA Engineer（质量保证工程师），鞍钢宪法中的"工人"，拥有否决权。

你的职责：
- 逐条质疑方案中的每个技术断言
- 发现遗漏：边界条件、异常处理、资源竞争
- 死锁检测、优先级反转审查、故障传播分析
- 验证修正是否到位（不行使否决权就是失职）

规则：
- 每个事实性断言必须标注置信度：L1🟢已验证 / L2🟡高可信 / L3🟠待验证 / L4🔴存疑
- 质疑必须具体（不能只说"可能有问题"，要指出哪里有问题、为什么）
- 有工具就用工具验证，不要空谈
- 如果你认为方案有致命缺陷，必须明确说"我行使否决权"并给出理由
- 回复用中文，技术术语保留英文""",
}



# ============================================================
# 4b. 项目预扫描（解决弱模型找不到文件的问题）
# ============================================================

def scan_project_structure(workdir: str, max_files: int = 60) -> str:
    """
    自动扫描项目目录结构，生成精简的源文件清单。
    V3.2: 只保留 .c/.h 源代码，跳过 BSP 驱动库和数据文件，
    让弱模型也能一眼看到关键文件在哪。
    """
    wpath = Path(workdir)
    if not wpath.exists():
        return ""

    # 跳过的目录（BSP驱动库、数据、文档、构建产物）
    skip_dirs = {".git", ".svn", ".ansteel", ".venv", "venv", "__pycache__",
                 "node_modules", ".vs", ".vscode", "build", "Build",
                 "Debug", "Release", "obj", "bin", "Lib", "Scripts",
                 "RTE", "Intermediate", "BSP", "CORE", "Listings", "Objects",
                 "csv", "data", "docs", "tools", "Inc"}
    # 只保留源代码扩展名
    keep_exts = {".c", ".h", ".s", ".cpp", ".hpp", ".py", ".ld", ".sct"}

    files = []
    dirs_with_src = set()

    def _scan(d, depth=0):
        if depth > 5:
            return
        try:
            entries = sorted(d.iterdir())
        except PermissionError:
            return
        for item in entries:
            if item.name in skip_dirs:
                continue
            if item.is_dir():
                _scan(item, depth + 1)
            elif item.is_file():
                if item.suffix.lower() not in keep_exts:
                    continue
                if item.stat().st_size > 500_000:
                    continue
                rel = str(item.relative_to(wpath)).replace("\\", "/")
                files.append(rel)
                dirs_with_src.add(str(item.parent.relative_to(wpath)).replace("\\", "/"))

    _scan(wpath)

    if not files:
        return ""

    # 按目录分组，让用户源文件排在前面
    user_files = [f for f in files if f.startswith("USER/") or f.startswith("user/") or f.startswith("src/") or f.startswith("App/") or f.startswith("app/")]
    ctrl_files = [f for f in files if f.startswith("controller/") or f.startswith("Controller/")]
    other_files = [f for f in files if f not in user_files and f not in ctrl_files]

    parts = []
    parts.append("## 项目源文件清单（自动扫描，共{}个文件）".format(len(files)))
    parts.append("工作目录: {}".format(workdir))
    parts.append("")
    parts.append("**重要：读取文件时必须使用下面列出的完整相对路径！不要猜测路径！**")
    parts.append("")

    if user_files:
        parts.append("### 用户源代码（USER/Src/）:")
        for f in user_files[:40]:
            parts.append("  - {}".format(f))
        parts.append("")

    if ctrl_files:
        parts.append("### 控制器代码:")
        for f in ctrl_files[:20]:
            parts.append("  - {}".format(f))
        parts.append("")

    if other_files:
        parts.append("### 其他源文件:")
        for f in other_files[:20]:
            parts.append("  - {}".format(f))
        if len(other_files) > 20:
            parts.append("  ... (还有{}个文件)".format(len(other_files) - 20))
        parts.append("")

    parts.append('> 示例：要读 mpc_solver.c，请调用 read_file(path="USER/Src/mpc_solver.c")')

    return "\n".join(parts)


def auto_build_project_profile(workdir: str) -> dict:
    """自动构建项目画像（芯片型号、文件数、关键模块等）"""
    wpath = Path(workdir)
    profile = {
        "workdir": workdir,
        "scanned_at": __import__("datetime").datetime.now().isoformat(),
    }

    chip_patterns = {
        "AT32F407": r"at32f40[37]",
        "AT32F403A": r"at32f403a",
        "STM32F103": r"stm32f103",
        "STM32F407": r"stm32f407",
        "STM32H743": r"stm32h743",
        "RK3568": r"rk3568",
        "ESP32": r"esp32",
    }
    all_text = ""
    for ext in ["*.h", "*.c", "*.s"]:
        for f in wpath.rglob(ext):
            if f.stat().st_size < 100_000:
                try:
                    all_text += f.read_text(encoding="utf-8", errors="replace")[:2000]
                except Exception:
                    pass
            if len(all_text) > 50000:
                break

    for chip, pattern in chip_patterns.items():
        if re.search(pattern, all_text, re.IGNORECASE):
            profile["chip"] = chip
            break

    if re.search(r"freertos|FreeRTOS", all_text):
        profile["rtos"] = "FreeRTOS"
    elif re.search(r"rt-thread|rtthread", all_text, re.IGNORECASE):
        profile["rtos"] = "RT-Thread"

    src_files = [f.name for f in wpath.rglob("*.c") if f.stat().st_size < 500_000]
    modules = []
    module_keywords = {
        "mpc": "MPC控制", "pid": "PID控制", "adc": "ADC采样",
        "modbus": "Modbus通信", "fault": "故障监控", "dac": "DAC输出",
        "thermal": "热模型", "calibrat": "温度校准", "config": "配置管理",
    }
    for kw, label in module_keywords.items():
        if any(kw in f.lower() for f in src_files):
            modules.append(label)
    if modules:
        profile["modules"] = modules

    profile["source_file_count"] = len(src_files)
    return profile


# ============================================================
# 5. 创建智能体
# ============================================================

def create_agent(role: str, cfg: dict) -> Agent:
    """根据角色和配置创建一个 Agent 实例"""
    role_cfg = get_role_config(cfg, role)
    model = make_model(role_cfg)

    # 根据配置选择工具
    tool_names = role_cfg.get("tools", ["read_file", "list_dir", "grep_code"])
    tools = [ALL_TOOLS[name] for name in tool_names if name in ALL_TOOLS]

    settings = ModelSettings(
        temperature=role_cfg.get("temperature", 0.2),
        max_tokens=role_cfg.get("max_tokens", 4096),
    )

    agent = Agent(
        name=role,
        instructions=ROLE_INSTRUCTIONS[role],
        model=model,
        model_settings=settings,
        tools=tools,
    )
    return agent


# ============================================================
# 6. 单智能体调用（框架管理 tool-calling 循环）
# ============================================================

async def call_agent(agent: Agent, prompt: str, ctx: DiscussionContext,
                     max_turns: int = 10, verbose: bool = True) -> str:
    """
    调用一个智能体，框架自动处理 tool-calling 循环。
    这就是用框架代替手写循环的核心价值：
    - 不用自己管理 messages 列表
    - 不用自己解析 tool_calls
    - 不用自己写循环
    - 框架自动处理多轮工具调用直到模型给出最终回答
    """
    run_config = RunConfig(tracing_disabled=True)

    if verbose:
        model_name = ""
        if hasattr(agent.model, 'model'):
            model_name = agent.model.model
        print(f"\n{'='*60}", file=sys.stderr)
        print(f"  Agent: {agent.name} | Model: {model_name}", file=sys.stderr)
        print(f"  Tools: {[t.name for t in agent.tools]}", file=sys.stderr)
        print(f"{'='*60}", file=sys.stderr)

    try:
        result = await asyncio.wait_for(
            Runner.run(
                agent,
                input=prompt,
                context=ctx,
                max_turns=max_turns,
                run_config=run_config,
            ),
            timeout=300,  # 5分钟硬超时
        )
    except asyncio.TimeoutError:
        error_msg = f"[ERROR] Agent {agent.name} 超时（5分钟），跳过"
        print(error_msg, file=sys.stderr)
        return error_msg
    except Exception as e:
        error_msg = f"[ERROR] Agent {agent.name} 调用失败: {type(e).__name__}: {e}"
        print(error_msg, file=sys.stderr)
        return error_msg

    output = result.final_output
    if verbose:
        # 打印工具调用记录
        for item in result.raw_responses:
            if hasattr(item, 'output'):
                for out in item.output:
                    if hasattr(out, 'type') and out.type == 'function_call':
                        print(f"  [tool] {out.name}({out.arguments[:100]}...)", file=sys.stderr)

    return output


# ============================================================
# 7. 鞍钢宪法讨论编排器（3轮循环）
# ============================================================

async def run_discussion(topic: str, cfg: dict, workdir: str,
                         mode: str = "A", verbose: bool = True) -> str:
    """
    执行完整的鞍钢宪法3轮讨论。

    模式A（方案生成）：发散 → 收敛 → 定稿
    模式B（项目分析）：同上，但第1步先分析代码
    """
    ctx = DiscussionContext(workdir=workdir)

    # 创建3个智能体（不同模型 → 跨模型制衡）
    tl = create_agent("tech-lead", cfg)
    se = create_agent("staff-engineer", cfg)
    qa = create_agent("qa-engineer", cfg)

    log = []  # 讨论记录

    def record(role_label: str, content: str):
        log.append(f"### {role_label}\n\n{content}\n")
        ctx.discussion_log.append(f"[{role_label}]: {content[:500]}")

    def context_so_far(max_chars: int = 12000) -> str:
        """把之前的讨论内容拼成上下文（带截断，防止超出模型上下文窗口）"""
        if not log:
            return ""
        full = "\n---\n".join(log)
        if len(full) <= max_chars:
            return "以下是之前的讨论记录，请在此基础上继续：\n\n" + full
        # 截断策略：保留第1轮全文 + 后续轮次只保留摘要
        truncated = []
        budget = max_chars
        for entry in log:
            if budget <= 0:
                truncated.append("### (更早的讨论已省略，请关注最近的修正)")
                break
            if len(entry) <= budget:
                truncated.append(entry)
                budget -= len(entry)
            else:
                truncated.append(entry[:budget] + "\n\n...(此处截断)")
                budget = 0
        return "以下是之前的讨论记录（部分截断），请在此基础上继续：\n\n" + "\n---\n".join(truncated)

    max_turns = cfg.get("default", {}).get("max_tool_rounds", 30)

    # ── 加载项目记忆 ──────────────────────────────────
    memory_context = ""
    mem_dir = Path(workdir) / ".ansteel"
    ctx.memory_dir = str(mem_dir)
    if mem_dir.exists():
        # 加载项目画像
        proj_file = mem_dir / "project.json"
        if proj_file.exists():
            try:
                profile = json.loads(proj_file.read_text(encoding="utf-8"))
                ctx.project_profile = profile
                memory_context += f"\n## 项目画像（历史积累）\n```json\n{json.dumps(profile, ensure_ascii=False, indent=2)}\n```\n"
            except Exception:
                pass
        # 加载知识库（截断）
        know_file = mem_dir / "knowledge.md"
        if know_file.exists():
            try:
                know = know_file.read_text(encoding="utf-8")
                if len(know) > 3000:
                    know = know[:3000] + "\n...(知识库过长，已截断)"
                memory_context += f"\n## 累积知识库\n{know}\n"
            except Exception:
                pass
        # 加载最近3条历史
        hist_file = mem_dir / "history.json"
        if hist_file.exists():
            try:
                history = json.loads(hist_file.read_text(encoding="utf-8"))
                recent = history[-3:] if len(history) > 3 else history
                memory_context += f"\n## 最近讨论历史（共{len(history)}条）\n"
                for h in recent:
                    memory_context += f"- [{h.get('date','')}] {h.get('topic','')}: {h.get('summary','')}\n"
            except Exception:
                pass
        if memory_context and verbose:
            print(f"  [MEMORY] 已加载项目记忆: {mem_dir}", file=sys.stderr)

    # ── 项目预扫描（V3.2新增：解决弱模型找不到文件的问题）──────
    project_scan = ""
    if mode == "B":
        project_scan = scan_project_structure(workdir)
        if project_scan and verbose:
            print(f"  [SCAN] 项目预扫描完成，发现文件结构", file=sys.stderr)
        # 首次讨论自动构建项目画像
        proj_file = mem_dir / "project.json"
        if not proj_file.exists():
            try:
                profile = auto_build_project_profile(workdir)
                mem_dir.mkdir(parents=True, exist_ok=True)
                proj_file.write_text(
                    __import__("json").dumps(profile, ensure_ascii=False, indent=2),
                    encoding="utf-8"
                )
                ctx.project_profile = profile
                if verbose:
                    print(f"  [SCAN] 项目画像已自动构建: {profile.get('chip','未知')} | {profile.get('source_file_count',0)} 个源文件", file=sys.stderr)
            except Exception as e:
                if verbose:
                    print(f"  [SCAN] 项目画像构建失败: {e}", file=sys.stderr)

    # 把项目结构注入到记忆上下文中
    if project_scan:
        memory_context = project_scan + "\n" + memory_context

    # ── 第1轮：发散 ──────────────────────────────────
    if verbose:
        print("\n" + "█"*60, file=sys.stderr)
        print("  第1轮：发散", file=sys.stderr)
        print("█"*60, file=sys.stderr)

    # 1. TL 立项
    tl_prompt = f"""讨论议题：{topic}

{"工作目录: " + workdir if mode == "B" else ""}
{memory_context if memory_context else ""}
请你作为 Tech Lead 立项：
1. 明确问题范围和关键约束
2. 列出需要解决的核心问题（按优先级排序）
3. 定义验收标准（怎样算"做完了"）
4. 指出最大的技术风险

{("项目文件结构已在上方列出。请用 read_file 工具读取关键源文件（使用上面列出的相对路径），基于实际代码给出分析。\n" + TOOL_BUDGET_MSG) if mode == "B" else ""}"""

    tl_r1 = await call_agent(tl, tl_prompt, ctx, max_turns=max_turns, verbose=verbose)
    record("Tech Lead — 立项（第1轮）", tl_r1)

    # 2. SE 初步方案
    se_prompt = f"""讨论议题：{topic}

{context_so_far()}

请你作为 Staff Engineer 提出初步技术方案：
1. 针对 TL 列出的每个核心问题，给出具体解决方案
2. 方案必须具体到可执行（代码示例、寄存器配置、参数计算）
3. 每个断言标注置信度（L1-L4）
4. 列出方案的技术选型理由

{("项目文件结构已在上方列出。请务必用 read_file 工具读取相关源代码（使用上面列出的相对路径，如 USER/Src/xxx.c），基于实际代码给方案。不要猜测文件路径！\n" + TOOL_BUDGET_MSG) if mode == "B" else ""}"""

    se_r1 = await call_agent(se, se_prompt, ctx, max_turns=max_turns, verbose=verbose)
    record("Staff Engineer — 初步方案（第1轮）", se_r1)

    # 3. QA 质疑
    qa_prompt = f"""讨论议题：{topic}

{context_so_far()}

请你作为 QA Engineer 逐条质疑上面的方案：
1. 检查每个技术断言是否有证据支撑
2. 找出遗漏：边界条件、异常处理、资源竞争、初始化顺序
3. 检查嵌入式特有问题：时钟配置、中断优先级、栈大小、volatile
4. 对每个问题标注严重程度（致命/严重/建议）
5. 如果有致命问题，明确说"我行使否决权"

{("项目文件结构已在上方列出。请务必用 read_file/grep_code 工具验证你的质疑（使用上面列出的相对路径读取代码）。不要说'无法访问'——文件路径已经在上方列出了！\n" + TOOL_BUDGET_MSG) if mode == "B" else ""}"""

    qa_r1 = await call_agent(qa, qa_prompt, ctx, max_turns=max_turns, verbose=verbose)
    record("QA Engineer — 质疑（第1轮）", qa_r1)

    # ── 第2轮：收敛（含 QA 否决循环，最多修正2次）──────────
    VETO_KEYWORDS = ["否决", "不通过", "驳回", "拒绝签字", "不同意"]
    max_corrections = 2  # 最多修正2次，防止无限循环

    for correction_round in range(1, max_corrections + 2):  # 1次正常 + 最多2次修正
        round_label = f"第2轮" if correction_round == 1 else f"第2轮-修正{correction_round - 1}"

        if verbose:
            print("\n" + "█"*60, file=sys.stderr)
            print(f"  {round_label}：收敛", file=sys.stderr)
            print("█"*60, file=sys.stderr)

        # 4. SE 回应质疑
        se_prompt_r2 = f"""讨论议题：{topic}

{context_so_far()}

QA 提出了质疑，请你作为 Staff Engineer：
1. 逐条回应 QA 的质疑（接受/反驳/部分接受）
2. 反驳必须有证据（代码、数据手册、计算）
3. 接受的问题给出修正方案
4. 更新你的方案（标注修改点）"""

        se_r2 = await call_agent(se, se_prompt_r2, ctx, max_turns=max_turns, verbose=verbose)
        record(f"Staff Engineer — 回应质疑（{round_label}）", se_r2)

        # 5. TL 亲自验证
        tl_prompt_r2 = f"""讨论议题：{topic}

{context_so_far()}

请你作为 Tech Lead 亲自验证争议点（干部参加劳动）：
1. 对 SE 和 QA 有分歧的点，亲自用工具验证
2. 做出裁决（谁对谁错，或者都有道理但侧重点不同）
3. 确认修正后的方案是否可行
4. 更新优先级排序"""

        tl_r2 = await call_agent(tl, tl_prompt_r2, ctx, max_turns=max_turns, verbose=verbose)
        record(f"Tech Lead — 亲自验证（{round_label}）", tl_r2)

        # 6. QA 审核修正
        qa_prompt_r2 = f"""讨论议题：{topic}

{context_so_far()}

SE 已回应质疑，TL 已做裁决。请你作为 QA Engineer 审核：
1. 修正是否到位？（不是敷衍了事）
2. 修正是否引入了新问题？
3. 如果满意，明确说"确认通过"；如果不满意，明确说"我行使否决权"并说明理由
4. 列出剩余风险点

重要：你的结论必须是"确认通过"或"我行使否决权"二选一。"""

        qa_r2 = await call_agent(qa, qa_prompt_r2, ctx, max_turns=max_turns, verbose=verbose)
        record(f"QA Engineer — 审核修正（{round_label}）", qa_r2)

        # ★ 检查 QA 是否行使了否决权
        qa_vetoed = any(kw in qa_r2 for kw in VETO_KEYWORDS)

        if not qa_vetoed:
            if verbose:
                print(f"\n  [QA 确认通过]", file=sys.stderr)
            break  # QA 通过，进入第3轮

        if correction_round > max_corrections:
            if verbose:
                print(f"\n  [QA 否决但已达最大修正次数 {max_corrections}，强制进入定稿]", file=sys.stderr)
            record("系统", f"QA 连续 {max_corrections} 次否决，达到最大修正次数，强制进入定稿。QA 的否决理由已记录在案。")
            break

        if verbose:
            print(f"\n  [QA 行使否决权！回到收敛环节修正（第 {correction_round} 次修正）]", file=sys.stderr)
            # V3.2: 自动记录否决到 evolution.md
            try:
                evo_file = mem_dir / "evolution.md"
                evo_entry = f"\n\n---\n### [{__import__('datetime').datetime.now().strftime('%Y-%m-%d %H:%M')}] QA否决（第{correction_round}次）\n\n议题: {topic[:80]}\n\nQA质疑要点:\n{qa_r2[:500] if qa_r2 else '(无内容)'}\n"
                if evo_file.exists():
                    evo_file.write_text(evo_file.read_text(encoding="utf-8") + evo_entry, encoding="utf-8")
                else:
                    evo_file.write_text(f"# 进化日志\n> QA否决记录，用于系统自我改进\n{evo_entry}", encoding="utf-8")
                if verbose:
                    print(f"  [EVOLUTION] 否决已记录到 evolution.md", file=sys.stderr)
            except Exception:
                pass

    # ── 第3轮：定稿 ──────────────────────────────────
    if verbose:
        print("\n" + "█"*60, file=sys.stderr)
        print("  第3轮：定稿", file=sys.stderr)
        print("█"*60, file=sys.stderr)

    # 7. TL 主持合议
    tl_prompt_r3 = f"""讨论议题：{topic}

{context_so_far()}

请你作为 Tech Lead 主持三方合议，形成最终结论：
1. 总结最终方案（整合所有修正）
2. 列出关键决策点和理由
3. 列出残余不确定点（标注 L3/L4）
4. 给出实施步骤和验证方法
5. 三方 Sign-off：TL ✅/❌, SE（由你代签）✅/❌, QA ✅/❌"""

    tl_r3 = await call_agent(tl, tl_prompt_r3, ctx, max_turns=max_turns, verbose=verbose)
    record("Tech Lead — 最终合议（第3轮）", tl_r3)

    # ── 组装输出 ──────────────────────────────────
    now = datetime.now()
    # Windows 文件名清理：去掉非法字符
    topic_short = re.sub(r'[<>:"/\\|?*]', '', topic[:30]).replace(" ", "-").strip("-")

    output = f"""# 鞍钢宪法讨论记录：{topic}

- 日期：{now.strftime('%Y-%m-%d %H:%M')}
- 模式：{'A（方案生成）' if mode == 'A' else 'B（项目分析）'}
- 工作目录：{workdir}
- 参与模型：TL={get_role_config(cfg, 'tech-lead')['model']}, SE={get_role_config(cfg, 'staff-engineer')['model']}, QA={get_role_config(cfg, 'qa-engineer')['model']}
- 框架：OpenAI Agents SDK (openai-agents)

---

## 第1轮：发散

{log[0]}

{log[1]}

{log[2]}

## 第2轮：收敛

{log[3]}

{log[4]}

{log[5]}

## 第3轮：定稿

{log[6]}

---

## 四方 Sign-off

- [ ] Tech Lead：见第3轮合议
- [ ] Staff Engineer：见第3轮合议
- [ ] QA Engineer：见第2轮审核
- [ ] 架构审查员（Codex）：待 Codex 审查

> 注：架构审查员由 Codex 在读取本记录后独立填写。

## 残余不确定点

（由第3轮合议提取，见上方 TL 最终结论）
"""

    # ── 自动提取记忆 ──────────────────────────────────
    try:
        mem_dir.mkdir(parents=True, exist_ok=True)

        # 1. 保存讨论历史
        hist_file = mem_dir / "history.json"
        history = []
        if hist_file.exists():
            try:
                history = json.loads(hist_file.read_text(encoding="utf-8"))
            except Exception:
                history = []
        # 从第3轮 TL 结论中提取摘要（取前200字）
        summary = tl_r3[:200].replace("\n", " ") if tl_r3 else ""
        history.append({
            "date": now.strftime("%Y-%m-%d %H:%M"),
            "topic": topic,
            "mode": mode,
            "summary": summary,
            "qa_vetoed": any(kw in (qa_r2 or "") for kw in ["否决", "不通过", "驳回"]),
            "file": filename if 'filename' in dir() else "",
        })
        hist_file.write_text(json.dumps(history, ensure_ascii=False, indent=2), encoding="utf-8")

        # 2. 追加知识库（从讨论中提取关键结论）
        know_file = mem_dir / "knowledge.md"
        know_entry = f"\n\n---\n### [{now.strftime('%Y-%m-%d')}] {topic}\n\n"
        # 取 TL 最终结论的前500字作为知识
        know_entry += tl_r3[:500] if tl_r3 else "(无结论)"
        if know_file.exists():
            know_file.write_text(know_file.read_text(encoding="utf-8") + know_entry, encoding="utf-8")
        else:
            know_file.write_text(f"# 项目知识库\n> 由鞍钢宪法讨论系统自动积累\n{know_entry}", encoding="utf-8")

        if verbose:
            print(f"  [MEMORY] 记忆已更新: {mem_dir}", file=sys.stderr)
    except Exception as e:
        if verbose:
            print(f"  [MEMORY] 记忆保存失败（不影响讨论）: {e}", file=sys.stderr)

    # 保存文件
    filename = f"ansteel-solution-{now.strftime('%Y-%m-%d')}-{topic_short}.md"
    output_dir = SCRIPT_DIR / "artifacts" / "runtime" / "legacy-solutions"
    output_dir.mkdir(parents=True, exist_ok=True)
    filepath = output_dir / filename
    filepath.write_text(output, encoding="utf-8")
    if verbose:
        print(f"\n[SAVED] {filepath}", file=sys.stderr)

    return output


# ============================================================
# 8. 快速模式（单角色单次调用，不走3轮讨论）
# ============================================================

async def run_quick(role: str, prompt: str, cfg: dict, workdir: str,
                    verbose: bool = True) -> str:
    """快速模式：只调用一个角色，不走完整讨论流程，但加载项目记忆"""
    ctx = DiscussionContext(workdir=workdir)
    agent = create_agent(role, cfg)
    max_turns = cfg.get("default", {}).get("max_tool_rounds", 30)

    # 加载项目记忆（和完整讨论一样）
    mem_dir = Path(workdir) / ".ansteel"
    ctx.memory_dir = str(mem_dir)
    memory_hint = ""
    if mem_dir.exists():
        hist_file = mem_dir / "history.json"
        if hist_file.exists():
            try:
                history = json.loads(hist_file.read_text(encoding="utf-8"))
                recent = history[-3:]
                memory_hint = "\n\n[项目记忆] 最近讨论历史:\n"
                for h in recent:
                    memory_hint += f"- [{h.get('date','')}] {h.get('topic','')}: {h.get('summary','')[:100]}\n"
                memory_hint += "你可以用 read_memory/search_history 工具查看更多。"
                if verbose:
                    print(f"  [MEMORY] 已加载 {len(history)} 条历史", file=sys.stderr)
            except Exception:
                pass

    # V3.2: 快速模式也注入项目结构
    project_scan = scan_project_structure(workdir)
    if project_scan:
        memory_hint = project_scan + "\n" + TOOL_BUDGET_MSG + "\n" + memory_hint

    full_prompt = prompt + memory_hint if memory_hint else prompt
    return await call_agent(agent, full_prompt, ctx, max_turns=max_turns, verbose=verbose)


# ============================================================
# 9. CLI 入口
# ============================================================

def main():
    parser = argparse.ArgumentParser(
        description="鞍钢宪法多智能体讨论系统（基于 OpenAI Agents SDK）",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
示例:
  python ansteel_agents.py "AT32F407的4通道ADC温度采集怎么做"
  python ansteel_agents.py "review main.c" --workdir F:/my_project --mode B
  python ansteel_agents.py "STM32 HAL vs LL" --quick --role tech-lead
        """
    )
    parser.add_argument("topic", help="讨论议题")
    parser.add_argument("--workdir", default=".", help="工作目录（工具操作的根目录）")
    parser.add_argument("--mode", choices=["A", "B"], default="A",
                        help="A=方案生成, B=项目分析 (默认 A)")
    parser.add_argument("--quick", action="store_true",
                        help="快速模式：只调用一个角色，不走3轮讨论")
    parser.add_argument("--role", default="tech-lead",
                        choices=["tech-lead", "staff-engineer", "qa-engineer"],
                        help="快速模式使用的角色 (默认 tech-lead)")
    parser.add_argument("--config", default=str(DEFAULT_CONFIG), help="配置文件路径")
    parser.add_argument("--quiet", action="store_true", help="安静模式，只输出最终结果")
    args = parser.parse_args()

    cfg = load_config(Path(args.config))
    workdir = os.path.abspath(args.workdir)
    verbose = not args.quiet

    if args.quick:
        result = asyncio.run(run_quick(args.role, args.topic, cfg, workdir, verbose))
    else:
        result = asyncio.run(run_discussion(args.topic, cfg, workdir, args.mode, verbose))

    # 最终结果输出到 stdout（Codex 读这个）
    print(result)


if __name__ == "__main__":
    main()
