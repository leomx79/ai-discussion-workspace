"""
鞍钢宪法式AI防幻觉讨论 - 纯Python最小实现（轨道C）
=====================================================
只需: pip install openai
3个角色、七步流程、同模型不同配置，完整实现鞍钢宪法治理。

使用方式:
  1. pip install openai
  2. 修改下方 API_KEY 和 MODEL 配置
  3. python ansteel_discussion.py
"""
import openai
import json
from datetime import datetime
from pathlib import Path

# ============================================================
# 配置区：同一个模型，不同的"帽子"
# ============================================================
API_KEY = "sk-your-key"                    # ← 改成你的API Key
BASE_URL = "https://api.openai.com/v1"     # ← 改成你的端点（如DeepSeek: https://api.deepseek.com/v1）
MODEL = "gpt-4o"                           # ← 改成你的模型名

# 同一个API（最简单）
CLIENT = openai.OpenAI(api_key=API_KEY, base_url=BASE_URL)

# 如需同模型不同API，取消注释以下配置：
# CLIENT_TL = openai.OpenAI(api_key="key-1", base_url="https://endpoint-1/v1")
# CLIENT_SE = openai.OpenAI(api_key="key-2", base_url="https://endpoint-2/v1")
# CLIENT_QA = openai.OpenAI(api_key="key-3", base_url="https://endpoint-3/v1")

# ============================================================
# 鞍钢宪法治理规则（嵌入所有角色Prompt）
# ============================================================
ANSTEEL_RULES = """
## 鞍钢宪法治理规则（必须严格遵守）

### 事实挂帅
- 证据 > 自信。有证据的L2胜过没证据的L1。
- 不知道就说不知道，绝不编造。
- 每个事实性断言必须标注置信度（L1-L4）。

### 置信度标签
- L1 🟢 已验证：有明确来源、可交叉验证（必须给出具体来源）
- L2 🟡 高可信：基于可靠知识但无法即时验证（必须说明推理依据）
- L3 🟠 待验证：不确定，需要进一步核查（必须标注并建议验证方法）
- L4 🔴 存疑/未知：不确定或可能错误（必须明确说"我不确定"）

### 讨论纪律
- 对事不对人：质疑观点，不质疑角色。
- 有错必纠：发现错误立即修正，不掩饰。
- 不得回避质疑：必须逐条正面回应。
- 最终输出中不得包含未标注的L3/L4断言。
"""

# ============================================================
# 角色定义（大厂职位 + 鞍钢宪法身份）
# ============================================================
ROLES = {
    "tech_lead": {
        "name": "Tech Lead",
        "client": CLIENT,  # 可替换为 CLIENT_TL
        "temperature": 0.1,
        "system": f"""你是一家大型科技公司的 Tech Lead（技术负责人），对标 Google Tech Lead。

## 你的职责
1. 主持讨论，确保流程按鞍钢宪法七步法进行
2. 对关键争议点**亲自验证**（干部参加劳动，不当甩手掌柜）
3. 主持三方合议，形成最终结论
4. 确保最终输出质量

## 你的鞍钢宪法身份：干部
- 你必须亲自下场验证，不能只当裁判
- 你要确保"三结合"（TL+SE+QA）真正落实
- 你要确保QA的否决权被尊重

## 你的工作风格
- 严谨、务实、不偏不倚
- 先验证再下结论
- 尊重每一个角色的意见

{ANSTEEL_RULES}""",
    },
    "staff_engineer": {
        "name": "Staff Engineer",
        "client": CLIENT,  # 可替换为 CLIENT_SE
        "temperature": 0.3,
        "system": f"""你是一家大型科技公司的 Staff Engineer（资深工程师），对标 Google Staff Engineer / OpenAI Research Scientist。

## 你的职责
1. 针对议题提出初步方案和回答
2. 每个事实性断言必须标注置信度（L1-L4）
3. 提供证据来源和推理依据
4. **逐条回应**QA的质疑，不得回避
5. 有错必纠，修正后重新标注置信度

## 你的鞍钢宪法身份：技术人员
- 你是"三结合"中的技术人员代表
- 你的方案必须经得起质疑和验证
- 你要用证据说话，不用权威压人

## 你的工作风格
- 专业、深入、有理有据
- 承认不确定性，不假装全知
- 欢迎质疑，视质疑为改进机会

{ANSTEEL_RULES}""",
    },
    "qa_engineer": {
        "name": "QA Engineer",
        "client": CLIENT,  # 可替换为 CLIENT_QA
        "temperature": 0.5,
        "system": f"""你是一家大型科技公司的 QA & Reliability Engineer（质量与可靠性工程师），对标 Google SET / OpenAI Red Team。

## 你的职责
1. 对Staff Engineer的回答进行**逐条质疑**
2. 重点检查L2-L4断言：证据是否充分？推理是否合理？
3. 检查是否有遗漏、矛盾、逻辑漏洞
4. **行使否决权**：对未经验证的关键断言，你有权否决（需给出理由）
5. 验证修正后的回答是否真正解决了问题

## 你的鞍钢宪法身份：工人
- 你是"工人参加管理"的代表
- 你的否决权是真实的，不是橡皮图章
- 你要敢于说"不"，即使对方是Tech Lead

## 你的工作风格
- 怀疑一切，验证一切
- 不放过任何模糊表述
- 但也要公正：好的回答要认可，不为质疑而质疑

## 质疑清单（每次必须检查）
- [ ] 每个事实性断言都有置信度标注吗？
- [ ] L1断言有具体来源吗？
- [ ] L2断言的推理依据充分吗？
- [ ] 有没有遗漏的重要方面？
- [ ] 有没有内部矛盾？
- [ ] 有没有过度自信的表述？

{ANSTEEL_RULES}""",
    },
}

# ============================================================
# 核心函数
# ============================================================
def chat(role_key: str, messages: list, instruction: str = "") -> str:
    """用同一个模型、不同配置调用不同角色"""
    role = ROLES[role_key]
    msgs = [{"role": "system", "content": role["system"]}] + messages
    if instruction:
        msgs.append({"role": "user", "content": instruction})

    response = role["client"].chat.completions.create(
        model=MODEL,
        messages=msgs,
        temperature=role["temperature"],
    )
    return response.choices[0].message.content


def format_speaker(role_key: str, content: str) -> str:
    """格式化发言记录"""
    name = ROLES[role_key]["name"]
    return f"\n{'='*60}\n📢 [{name}]\n{'='*60}\n{content}\n"


# ============================================================
# 鞍钢宪法七步讨论流程
# ============================================================
def ansteel_discussion(topic: str, verbose: bool = True) -> dict:
    """
    鞍钢宪法式AI防幻觉讨论

    Args:
        topic: 讨论议题
        verbose: 是否打印讨论过程

    Returns:
        dict: 包含最终结论和完整讨论记录
    """
    history = []  # 对话历史
    log = []      # 完整记录

    def step(role_key, instruction, step_name):
        """执行一步讨论"""
        result = chat(role_key, history, instruction)
        formatted = format_speaker(role_key, result)
        history.append({"role": "assistant", "content": f"[{ROLES[role_key]['name']}]\n{result}"})
        log.append({"step": step_name, "role": ROLES[role_key]["name"], "content": result})
        if verbose:
            print(f"\n{'─'*60}")
            print(f"📋 {step_name}")
            print(formatted)
        return result

    if verbose:
        print(f"\n{'═'*60}")
        print(f"🏭 鞍钢宪法式AI防幻觉讨论")
        print(f"📌 议题：{topic}")
        print(f"👥 参与：Tech Lead + Staff Engineer + QA Engineer")
        print(f"⏰ 时间：{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
        print(f"{'═'*60}")

    # Step 1: Tech Lead 立项
    step("tech_lead",
         f"请为以下议题立项，明确讨论范围、关键问题和验收标准：\n\n{topic}",
         "Step 1: 立项（Tech Lead）")

    # Step 2: Staff Engineer 初步方案
    step("staff_engineer",
         "请针对议题给出初步回答。每个事实性断言必须标注置信度（L1-L4），并给出证据来源或推理依据。",
         "Step 2: 初步方案（Staff Engineer）")

    # Step 3: QA 质疑
    step("qa_engineer",
         "请对Staff Engineer的回答进行逐条质疑。重点检查：\n"
         "1. 每个断言的置信度标注是否合理\n"
         "2. L1断言是否有具体来源\n"
         "3. L2断言的推理是否充分\n"
         "4. 是否有遗漏、矛盾、过度自信\n"
         "5. 对关键断言，明确表态：认可/质疑/否决",
         "Step 3: 质疑（QA Engineer）")

    # Step 4: Staff Engineer 回应与修正
    step("staff_engineer",
         "请逐条回应QA的质疑。要求：\n"
         "1. 不得回避任何质疑\n"
         "2. 有错必纠，修正后重新标注置信度\n"
         "3. 对否决的断言，要么提供新证据，要么撤回\n"
         "4. 给出修正后的完整回答",
         "Step 4: 回应与修正（Staff Engineer）")

    # Step 5: Tech Lead 亲自验证
    step("tech_lead",
         "作为Tech Lead，请亲自验证关键争议点（干部参加劳动）：\n"
         "1. 对QA和SE仍有分歧的点，亲自核查\n"
         "2. 对关键事实，给出你的验证结论\n"
         "3. 明确哪些点已确认、哪些仍有不确定性",
         "Step 5: 亲自验证（Tech Lead）")

    # Step 6: 三方合议
    step("tech_lead",
         "请主持三方合议（三结合）：\n"
         "1. 总结各方观点\n"
         "2. 确认QA是否有否决意见（如有，必须解决）\n"
         "3. 形成三方Sign-off的最终结论\n"
         "4. 标注残余不确定点\n"
         "5. 给出最终输出",
         "Step 6: 三方合议（Tech Lead主持）")

    # Step 7: 输出归档
    final = history[-1]["content"]

    if verbose:
        print(f"\n{'═'*60}")
        print(f"✅ 讨论完成")
        print(f"{'═'*60}")

    return {
        "topic": topic,
        "final_answer": final,
        "discussion_log": log,
        "timestamp": datetime.now().isoformat(),
        "participants": [ROLES[k]["name"] for k in ROLES],
    }


# ============================================================
# 运行
# ============================================================
if __name__ == "__main__":
    import sys

    # 支持命令行传入议题
    if len(sys.argv) > 1:
        topic = " ".join(sys.argv[1:])
    else:
        topic = "鞍钢宪法是哪一年提出的？核心内容是什么？"

    result = ansteel_discussion(topic)

    # 保存讨论记录
    output_dir = Path(__file__).parent / "artifacts" / "runtime" / "legacy-discussions"
    output_dir.mkdir(parents=True, exist_ok=True)
    log_file = output_dir / f"discussion_{datetime.now().strftime('%Y%m%d_%H%M%S')}.json"
    with open(log_file, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=2)

    print(f"\n📄 讨论记录已保存到 {log_file}")
