# 鞍钢宪法式AI防幻觉讨论方案 V4
# ——2026年开源框架落地版：可运行代码、3人起步、同模型多角色

> **V4 核心升级（相对V3）：**
> 1. 更新2026年框架格局（AG2独立、CrewAI Flow、Google ADK等）
> 2. 提供**可直接运行**的完整代码（不再是伪代码）
> 3. 双轨实现：CrewAI Flow（结构化七步法）+ AG2 GroupChat（自由讨论）
> 4. 同模型不同API的**具体配置示例**
> 5. 鞍钢宪法治理规则**嵌入Prompt模板**（可直接复制使用）
> 6. 3人最小团队**一键启动**

---

## 一、2026年开源多Agent框架格局

### 1.1 框架全景（2026年7月更新）

| 框架 | 维护方 | 设计理念 | 角色定义 | 同模型多配置 | 流程控制 | 3人可用 | 辩论支持 | 学习曲线 |
|---|---|---|---|---|---|---|---|---|
| **CrewAI** ⭐主选 | crewAIInc | 角色驱动+Flow | role/goal/backstory | ✅ 每Agent独立LLM | Flow(精确)+Crew(自主) | ✅ | ✅ 有debate示例 | 低-中 |
| **AG2** ⭐备选 | ag2ai（AutoGen原创团队） | 对话驱动 | system_message | ✅ 每Agent独立config | GroupChat+Swarm | ✅ | ✅ 内置辩论 | 中 |
| **AutoGen v0.4** | Microsoft | 企业级事件驱动 | system_message | ✅ | 事件驱动 | ⚠️ 偏重 | ⚠️ 需自建 | 中-高 |
| **LangGraph** | LangChain | 状态机/图 | 自定义节点 | ✅ | 图结构极灵活 | ❌ 曲线陡 | ⚠️ 需自建 | 高 |
| **Google ADK** | Google | 企业多Agent | Agent定义 | ✅ | 层级/循环 | ⚠️ 偏企业 | ⚠️ 需自建 | 中 |
| **OpenAI Agents SDK** | OpenAI | 极简Handoff | instructions | ✅ | Handoff链 | ✅ | ⚠️ 需自建 | 低 |
| **MAD** | 学术 | 辩论专用 | 辩手+裁判 | ✅ | 固定辩论 | ✅ | ✅ 专为辩论 | 低 |

### 1.2 关键变化（V3→V4）

| 变化 | 说明 |
|---|---|
| **AG2独立** | AutoGen原创团队（Chi Wang、Qingyun Wu）离开微软，创建AG2（ag2ai）。AG2继承了AutoGen的对话式基因，GroupChat+Swarm更适合讨论/辩论场景。微软的AutoGen v0.4转向企业级事件驱动。 |
| **CrewAI Flow** | CrewAI新增Flow系统，允许精确控制Agent执行顺序、条件分支、循环，比纯Sequential更适合"七步法"。 |
| **Google ADK** | Google推出Agent Development Kit，适合企业级多Agent，但对小团队偏重。 |
| **框架成熟度** | CrewAI和AG2在2026年都进入稳定期，API变化小，适合生产使用。 |

### 1.3 最终选型：双轨制

```
┌─────────────────────────────────────────────────────────┐
│                    双轨实现策略                          │
│                                                         │
│  轨道A：CrewAI Flow（结构化七步法）                      │
│  → 适合：需要固定流程、可审计、可复现的正式讨论          │
│  → 优势：角色定义直观、Flow精确控制、工具集成好          │
│                                                         │
│  轨道B：AG2 GroupChat（自由讨论）                        │
│  → 适合：需要动态对话、多轮质疑、灵活发言的头脑风暴      │
│  → 优势：对话式自然、speaker_selection灵活、辩论基因     │
│                                                         │
│  轨道C：纯Python（零依赖验证）                           │
│  → 适合：快速验证概念、学习理解、最小可行产品            │
│  → 优势：零框架依赖、只需openai库、完全可控              │
│                                                         │
│  推荐路径：C（验证）→ A（正式）→ B（高级）              │
└─────────────────────────────────────────────────────────┘
```

---

## 二、鞍钢宪法 → AI治理 映射表（核心参考）

| 鞍钢宪法原则 | 原始含义 | AI防幻觉映射 | 实现机制 |
|---|---|---|---|
| **政治挂帅** | 政治方向第一 | **事实挂帅**：证据 > 自信 | 每个断言必须标注证据来源和置信度 |
| **党的领导** | 党委统一领导 | **PM把控方向**：定义议题、验收输出 | PM角色（5人团队）或Tech Lead兼任（3人团队） |
| **群众运动** | 广泛动员群众 | **多角色参与**：不同视角审视 | 至少3个角色，可扩展到N个 |
| **干部参加劳动** | 干部深入一线 | **Tech Lead亲自验证**：不做甩手掌柜 | TL必须对关键争议点亲自核查 |
| **工人参加管理** | 工人有管理权 | **QA有否决权**：不是橡皮图章 | QA可以veto任何未经验证的断言 |
| **改革不合理制度** | 破旧立新 | **废除8条旧规，建立8条新规** | 见下方"一改"详细规则 |
| **三结合** | 干部+技术人员+工人 | **TL+SE+QA三方Sign-off** | 最终输出必须三方确认 |

### "一改"：废除8条旧规 → 建立8条新规

| 旧规（马钢宪法/单Agent思维） | 新规（鞍钢宪法/多Agent治理） |
|---|---|
| 1. 默认自信：AI说什么就是什么 | 1. 默认存疑：每个断言都需要证据支撑 |
| 2. 一次成型：第一次回答就是最终答案 | 2. 迭代修正：至少经过质疑-回应-验证三轮 |
| 3. 权威崇拜：模型越大越权威 | 3. 事实挂帅：只看证据，不看模型大小 |
| 4. 黑箱输出：不解释推理过程 | 4. 透明推理：必须展示推理链和证据来源 |
| 5. 单点决策：一个Agent说了算 | 5. 三方合议：关键结论需TL+SE+QA确认 |
| 6. 回避质疑：被问到就含糊其辞 | 6. 正面回应：必须逐条回应质疑 |
| 7. 模糊表述：用"可能""大概"搪塞 | 7. 精确标注：用L1-L4置信度标签 |
| 8. 拒绝认错：坚持错误不修正 | 8. 有错必纠：发现错误立即修正并记录 |

---

## 三、角色设计（大厂对标 + 鞍钢宪法身份）

### 3.1 最小团队（3人）——鞍钢宪法"三结合"核心

```
┌─────────────────────────────────────────────────────────────┐
│              最小可行团队（3人）= 三结合核心                   │
│                                                             │
│   ┌──────────┐    ┌──────────────┐    ┌──────────┐         │
│   │Tech Lead │◄──►│Staff Engineer│◄──►│QA Engineer│         │
│   │ （干部）  │    │ （技术人员）  │    │ （工人）  │         │
│   └────┬─────┘    └──────┬───────┘    └────┬─────┘         │
│        │                 │                  │               │
│        └─────────────────┼──────────────────┘               │
│                          │                                  │
│                   三方Sign-off                              │
│                   才能输出                                  │
└─────────────────────────────────────────────────────────────┘
```

| 角色 | 大厂对标 | 核心职责 | 鞍钢宪法身份 | Temperature |
|---|---|---|---|---|
| **Tech Lead** | Google Tech Lead / Meta Tech Lead | 主持讨论、裁决争议、**亲自验证**关键事实 | 干部（参加劳动） | 0.1 |
| **Staff Engineer** | Google Staff Eng / OpenAI Research Scientist | 提出方案、提供证据、回应质疑 | 技术人员 | 0.3 |
| **QA Engineer** | Google SET / OpenAI Red Team / Anthropic Safety | 逐条质疑、验证证据、**行使否决权** | 工人（参加管理） | 0.5 |

### 3.2 标准团队（5人）

| 新增角色 | 大厂对标 | 核心职责 | 鞍钢宪法身份 | Temperature |
|---|---|---|---|---|
| **Product Manager** | Google PM / OpenAI Product | 定义议题、把控方向、验收输出 | 党的领导 | 0.2 |
| **Data Analyst** | Google Data Analyst / Eval Engineer | 外部验证、事实核查、数据支撑 | 技术装备 | 0.2 |

### 3.3 完整团队（7人）

| 新增角色 | 大厂对标 | 核心职责 | 鞍钢宪法身份 | Temperature |
|---|---|---|---|---|
| **SRE** | Google SRE / Meta Production Eng | 实践检验、真实场景验证、边界测试 | 生产一线 | 0.4 |
| **Recorder** | Program Manager / TPM | 如实记录、归档、可追溯 | 工会（监督记录） | 0.0 |

### 3.4 扩展团队（7人以上）

- 多个 **Staff Engineer**（不同专业领域：前端、后端、算法、安全）
- 多个 **QA**（不同维度：逻辑QA、事实QA、安全QA、合规QA）
- **Domain Expert**（领域专家：医疗、法律、金融等）
- **Red Team Specialist**（红队专员：专门攻击性测试）

> **扩展原则：核心"三结合"（TL+SE+QA）永远不变，增加的是"群众运动"的广度和深度。**

---

## 四、置信度标签体系（L1-L4）

每个事实性断言必须标注置信度：

| 等级 | 标签 | 含义 | 要求 |
|---|---|---|---|
| **L1** | 🟢 已验证 | 有明确来源、可交叉验证 | 必须给出具体来源（URL、论文、官方文档） |
| **L2** | 🟡 高可信 | 基于可靠知识但无法即时验证 | 必须说明推理依据 |
| **L3** | 🟠 待验证 | 不确定，需要进一步核查 | 必须标注"待验证"并建议验证方法 |
| **L4** | 🔴 存疑/未知 | 不确定或可能错误 | 必须明确说"我不确定"或"这可能不正确" |

**规则：任何L3/L4断言不得出现在最终输出中，除非明确标注为"未验证信息"。**

---

## 五、七步讨论流程（鞍钢宪法版）

```
Step 1: 立项（PM或TL）
  │  定义议题、范围、验收标准
  ▼
Step 2: 初步方案（SE）
  │  提出回答，每个断言标注L1-L4
  ▼
Step 3: 质疑（QA）
  │  逐条质疑，重点关注L2-L4断言
  │  行使"工人参加管理"权力
  ▼
Step 4: 回应与修正（SE）
  │  必须逐条回应，不得回避
  │  有错必纠，修正后重新标注
  ▼
Step 5: 亲自验证（TL）
  │  "干部参加劳动"：对关键争议点亲自核查
  │  不是当裁判，是下场干活
  ▼
Step 6: 三方合议（TL主持）
  │  TL+SE+QA三方Sign-off
  │  QA可行使否决权（需给出理由）
  ▼
Step 7: 输出与归档（TL/Recorder）
  │  形成最终结论，附讨论记录
  │  标注残余不确定点
  ▼
```

---

## 六、鞍钢宪法治理规则（嵌入Prompt）

以下规则直接嵌入每个Agent的System Prompt中：

```markdown
## 鞍钢宪法治理规则（所有角色必须遵守）

### 事实挂帅
- 证据 > 自信。有证据的L2胜过没证据的L1。
- 不知道就说不知道，绝不编造。
- 每个事实性断言必须标注置信度（L1-L4）。

### 两参
- 干部参加劳动：Tech Lead必须亲自验证关键争议点，不能只当裁判。
- 工人参加管理：QA Engineer有权否决任何未经验证的断言，否决需给出理由。

### 一改
- 废除"默认自信"：每个断言默认需要验证。
- 废除"一次成型"：至少经过质疑-回应-验证三轮。
- 废除"回避质疑"：必须逐条正面回应质疑。
- 废除"模糊表述"：用L1-L4精确标注，不用"可能""大概"搪塞。

### 三结合
- 最终输出必须经过Tech Lead + Staff Engineer + QA Engineer三方确认。
- 任何一方有异议，必须讨论解决后才能输出。
- QA的否决权是真实的，不是形式。

### 讨论纪律
- 对事不对人：质疑观点，不质疑角色。
- 有错必纠：发现错误立即修正，不掩饰。
- 如实记录：讨论过程完整记录，可追溯。
```

---

## 七、轨道C：纯Python实现（零依赖，一键运行）

> **推荐从这里开始。** 只需 `pip install openai`，3个角色、七步流程、同模型不同配置，完整实现鞍钢宪法治理。

### 7.1 完整可运行代码

```python
"""
鞍钢宪法式AI防幻觉讨论 - 纯Python最小实现
只需: pip install openai
"""
import openai
import json
from datetime import datetime

# ============================================================
# 配置区：同一个模型，不同的"帽子"
# ============================================================
# 方式1：同一个API（最简单）
CLIENT = openai.OpenAI(
    api_key="sk-your-key",       # 你的API Key
    base_url="https://api.openai.com/v1",  # 或其他兼容端点
)
MODEL = "gpt-4o"  # 或任何兼容模型

# 方式2：同模型不同API（如需不同endpoint）
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
    result = ansteel_discussion("鞍钢宪法是哪一年提出的？核心内容是什么？")
    
    # 保存讨论记录
    with open("discussion_log.json", "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=2)
    
    print("\n📄 讨论记录已保存到 discussion_log.json")
```

### 7.2 运行方式

```bash
# 1. 安装依赖（只需一个）
pip install openai

# 2. 设置API Key（二选一）
export OPENAI_API_KEY="sk-your-key"
# 或在代码中直接设置

# 3. 运行
python ansteel_discussion.py
```

### 7.3 同模型不同API配置

```python
# 场景：同一个模型（如DeepSeek），通过不同API端点/Key调用
# 好处：分散限流、不同账号、不同计费

import openai

# 三个不同的API配置（同一个模型）
CLIENT_TL = openai.OpenAI(
    api_key="sk-account-1",
    base_url="https://api.deepseek.com/v1",
)
CLIENT_SE = openai.OpenAI(
    api_key="sk-account-2", 
    base_url="https://api.deepseek.com/v1",
)
CLIENT_QA = openai.OpenAI(
    api_key="sk-account-3",
    base_url="https://api.deepseek.com/v1",
)

MODEL = "deepseek-chat"  # 同一个模型

# 在ROLES中分别指定
ROLES = {
    "tech_lead": {"client": CLIENT_TL, "temperature": 0.1, ...},
    "staff_engineer": {"client": CLIENT_SE, "temperature": 0.3, ...},
    "qa_engineer": {"client": CLIENT_QA, "temperature": 0.5, ...},
}
```

---

## 八、轨道A：CrewAI Flow实现（结构化七步法）

### 8.1 安装

```bash
pip install crewai crewai-tools
```

### 8.2 完整代码

```python
"""
鞍钢宪法式AI防幻觉讨论 - CrewAI Flow实现
需要: pip install crewai crewai-tools
"""
from crewai import Agent, Task, Crew, Process, LLM
from crewai.flow.flow import Flow, listen, start
from pydantic import BaseModel
import json

# ============================================================
# 同模型不同配置
# ============================================================
# 方式1：同一个LLM配置（最简单）
LLM_CONFIG = LLM(
    model="gpt-4o",
    temperature=0.3,  # 会被每个Agent覆盖
)

# 方式2：不同API端点
# LLM_TL = LLM(model="gpt-4o", api_key="key-1", base_url="https://endpoint-1/v1", temperature=0.1)
# LLM_SE = LLM(model="gpt-4o", api_key="key-2", base_url="https://endpoint-2/v1", temperature=0.3)
# LLM_QA = LLM(model="gpt-4o", api_key="key-3", base_url="https://endpoint-3/v1", temperature=0.5)

# ============================================================
# 鞍钢宪法规则（嵌入Prompt）
# ============================================================
ANSTEEL_RULES = """
## 鞍钢宪法治理规则
- 事实挂帅：证据 > 自信，不知道就说不知道
- 置信度标签：L1🟢已验证 / L2🟡高可信 / L3🟠待验证 / L4🔴存疑
- 两参：干部参加劳动（TL亲自验证），工人参加管理（QA有否决权）
- 一改：废除默认自信、一次成型、回避质疑、模糊表述
- 三结合：TL+SE+QA三方Sign-off才能输出
"""

# ============================================================
# 角色定义
# ============================================================
tech_lead = Agent(
    role="Tech Lead",
    goal="主持鞍钢宪法式讨论，亲自验证关键事实，主持三方合议，确保输出质量",
    backstory="""你是一家大型科技公司的Tech Lead，对标Google Tech Lead。
    你的鞍钢宪法身份是"干部"——你必须亲自参加劳动（验证），不能只当裁判。
    你负责主持讨论、裁决争议、亲自验证、形成最终结论。
    你尊重QA的否决权，确保三结合真正落实。""" + ANSTEEL_RULES,
    llm=LLM(model="gpt-4o", temperature=0.1),
    verbose=True,
)

staff_engineer = Agent(
    role="Staff Engineer",
    goal="提出有据可查的方案，每个断言标注置信度，逐条回应质疑，有错必纠",
    backstory="""你是一家大型科技公司的Staff Engineer，对标Google Staff Engineer。
    你的鞍钢宪法身份是"技术人员"——你用证据说话，不用权威压人。
    你欢迎质疑，视质疑为改进机会。你承认不确定性，不假装全知。""" + ANSTEEL_RULES,
    llm=LLM(model="gpt-4o", temperature=0.3),
    verbose=True,
)

qa_engineer = Agent(
    role="QA Engineer",
    goal="逐条质疑未经验证的断言，行使否决权，确保输出无幻觉",
    backstory="""你是一家大型科技公司的QA & Reliability Engineer，对标Google SET / OpenAI Red Team。
    你的鞍钢宪法身份是"工人"——你参加管理，有真实的否决权，不是橡皮图章。
    你怀疑一切、验证一切，但也公正：好的回答要认可。""" + ANSTEEL_RULES,
    llm=LLM(model="gpt-4o", temperature=0.5),
    verbose=True,
)

# ============================================================
# 任务定义（七步法）
# ============================================================
def create_tasks(topic: str):
    task1_kickoff = Task(
        description=f"为以下议题立项，明确讨论范围、关键问题和验收标准：\n{topic}",
        expected_output="议题立项书：范围、关键问题、验收标准",
        agent=tech_lead,
    )
    
    task2_proposal = Task(
        description="针对议题给出初步回答。每个事实性断言标注置信度（L1-L4），给出证据来源。",
        expected_output="初步回答（含L1-L4标注）",
        agent=staff_engineer,
        context=[task1_kickoff],
    )
    
    task3_challenge = Task(
        description="逐条质疑Staff Engineer的回答。检查置信度标注、证据来源、逻辑漏洞。对关键断言明确表态。",
        expected_output="逐条质疑报告（含认可/质疑/否决表态）",
        agent=qa_engineer,
        context=[task1_kickoff, task2_proposal],
    )
    
    task4_revision = Task(
        description="逐条回应QA质疑，有错必纠，修正后重新标注置信度，给出修正后完整回答。",
        expected_output="修正后回答（含逐条回应）",
        agent=staff_engineer,
        context=[task1_kickoff, task2_proposal, task3_challenge],
    )
    
    task5_verify = Task(
        description="亲自验证关键争议点（干部参加劳动）。对分歧点亲自核查，给出验证结论。",
        expected_output="验证报告（已确认/仍有不确定性的点）",
        agent=tech_lead,
        context=[task1_kickoff, task2_proposal, task3_challenge, task4_revision],
    )
    
    task6_consensus = Task(
        description="主持三方合议（三结合）。总结各方观点，确认QA无否决意见，形成最终结论，标注残余不确定点。",
        expected_output="最终结论（三方Sign-off，含残余不确定点）",
        agent=tech_lead,
        context=[task1_kickoff, task2_proposal, task3_challenge, task4_revision, task5_verify],
    )
    
    return [task1_kickoff, task2_proposal, task3_challenge, 
            task4_revision, task5_verify, task6_consensus]

# ============================================================
# 运行
# ============================================================
def run_crewai_discussion(topic: str):
    tasks = create_tasks(topic)
    
    crew = Crew(
        agents=[tech_lead, staff_engineer, qa_engineer],
        tasks=tasks,
        process=Process.sequential,  # 按顺序执行七步法
        verbose=True,
    )
    
    result = crew.kickoff()
    return result

if __name__ == "__main__":
    result = run_crewai_discussion("鞍钢宪法是哪一年提出的？核心内容是什么？")
    print(result)
```

---

## 九、轨道B：AG2 GroupChat实现（自由讨论）

### 9.1 安装

```bash
pip install ag2
```

### 9.2 完整代码

```python
"""
鞍钢宪法式AI防幻觉讨论 - AG2 GroupChat实现
需要: pip install ag2
适合：需要动态对话、多轮质疑、灵活发言的场景
"""
import autogen  # ag2 包名仍为 autogen

# ============================================================
# 同模型不同API配置
# ============================================================
config_list = [
    {
        "model": "gpt-4o",
        "api_key": "sk-your-key",
        # "base_url": "https://your-endpoint/v1",  # 可选
    }
]

# 如需不同API：
# config_list_tl = [{"model": "gpt-4o", "api_key": "key-1", "base_url": "https://ep1/v1"}]
# config_list_se = [{"model": "gpt-4o", "api_key": "key-2", "base_url": "https://ep2/v1"}]
# config_list_qa = [{"model": "gpt-4o", "api_key": "key-3", "base_url": "https://ep3/v1"}]

ANSTEEL_RULES = """
## 鞍钢宪法治理规则
- 事实挂帅：证据 > 自信，不知道就说不知道
- 置信度标签：L1🟢已验证 / L2🟡高可信 / L3🟠待验证 / L4🔴存疑
- 两参：干部参加劳动（TL亲自验证），工人参加管理（QA有否决权）
- 三结合：TL+SE+QA三方确认才能形成最终结论
- 讨论纪律：逐条回应质疑，有错必纠，不得回避
"""

# ============================================================
# 角色定义
# ============================================================
tech_lead = autogen.AssistantAgent(
    name="Tech_Lead",
    system_message=f"""你是一家大型科技公司的Tech Lead（对标Google Tech Lead）。
鞍钢宪法身份：干部（必须亲自参加劳动/验证）。

职责：
1. 主持讨论，确保按鞍钢宪法流程进行
2. 对关键争议点亲自验证
3. 主持三方合议，形成最终结论
4. 当你认为讨论已充分，请说"三方合议结论："后给出最终答案

{ANSTEEL_RULES}""",
    llm_config={"config_list": config_list, "temperature": 0.1},
)

staff_engineer = autogen.AssistantAgent(
    name="Staff_Engineer",
    system_message=f"""你是一家大型科技公司的Staff Engineer（对标Google Staff Engineer）。
鞍钢宪法身份：技术人员。

职责：
1. 提出方案，每个断言标注L1-L4置信度
2. 逐条回应QA质疑，不得回避
3. 有错必纠，修正后重新标注

{ANSTEEL_RULES}""",
    llm_config={"config_list": config_list, "temperature": 0.3},
)

qa_engineer = autogen.AssistantAgent(
    name="QA_Engineer",
    system_message=f"""你是一家大型科技公司的QA Engineer（对标Google SET / OpenAI Red Team）。
鞍钢宪法身份：工人（参加管理，有否决权）。

职责：
1. 逐条质疑，重点检查L2-L4断言
2. 对关键断言明确表态：认可/质疑/否决
3. 你的否决权是真实的，不是形式

{ANSTEEL_RULES}""",
    llm_config={"config_list": config_list, "temperature": 0.5},
)

# ============================================================
# 群聊设置
# ============================================================
groupchat = autogen.GroupChat(
    agents=[tech_lead, staff_engineer, qa_engineer],
    messages=[],
    max_round=15,  # 最多15轮对话
    speaker_selection_method="auto",  # 自动选择下一个发言者
    # 也可用 "round_robin" 强制轮流发言
)

manager = autogen.GroupChatManager(
    groupchat=groupchat,
    llm_config={"config_list": config_list},
)

# ============================================================
# 启动讨论
# ============================================================
if __name__ == "__main__":
    # 由Staff Engineer发起讨论
    staff_engineer.initiate_chat(
        manager,
        message="请讨论以下议题：鞍钢宪法是哪一年提出的？核心内容是什么？\n"
                "请按鞍钢宪法七步法进行：立项→初步方案→质疑→回应→验证→合议→输出。"
    )
```

---

## 十、三轨对比与选择指南

| 维度 | 轨道C：纯Python | 轨道A：CrewAI | 轨道B：AG2 |
|---|---|---|---|
| **依赖** | openai | crewai, crewai-tools | ag2 |
| **安装复杂度** | ⭐ 极简 | ⭐⭐ 简单 | ⭐⭐ 简单 |
| **流程控制** | 手动编码 | Flow/Sequential精确控制 | GroupChat动态对话 |
| **讨论模式** | 固定七步 | 固定七步（可配） | 自由讨论+七步引导 |
| **同模型多API** | ✅ 手动配置 | ✅ LLM对象 | ✅ config_list |
| **工具集成** | 手动 | ✅ 内置Tool系统 | ✅ 内置函数调用 |
| **可扩展性** | 手动加角色 | 加Agent即可 | 加Agent即可 |
| **适合场景** | 验证概念、学习 | 正式项目、可审计 | 头脑风暴、动态讨论 |
| **推荐起步** | ✅ 第一步 | ✅ 第二步 | 第三步 |

**推荐路径：**
```
轨道C（纯Python）→ 验证鞍钢宪法治理有效性（1天）
    ↓
轨道A（CrewAI）→ 正式项目，固定流程，工具集成（3天）
    ↓
轨道B（AG2）→ 高级场景，自由讨论，动态对话（按需）
```

---

## 十一、扩展：3人→5人→7人→N人

### 11.1 扩展原则

> **核心"三结合"（TL+SE+QA）永远不变，增加的是"群众运动"的广度。**

### 11.2 纯Python扩展（加角色即可）

```python
# 在ROLES字典中添加新角色即可
ROLES["product_manager"] = {
    "name": "Product Manager",
    "client": CLIENT,
    "temperature": 0.2,
    "system": f"""你是一家大型科技公司的Product Manager（对标Google PM）。
鞍钢宪法身份：党的领导（把控方向）。
职责：定义议题、把控方向、验收输出。
{ANSTEEL_RULES}""",
}

ROLES["data_analyst"] = {
    "name": "Data Analyst",
    "client": CLIENT,
    "temperature": 0.2,
    "system": f"""你是一家大型科技公司的Data Analyst（对标Google Data Analyst）。
鞍钢宪法身份：技术装备（外部验证）。
职责：外部验证、事实核查、数据支撑。
{ANSTEEL_RULES}""",
}

# 在ansteeel_discussion函数中添加对应步骤即可
```

### 11.3 CrewAI扩展

```python
# 添加新Agent
product_manager = Agent(
    role="Product Manager",
    goal="定义议题、把控方向、验收输出",
    backstory="对标Google PM，鞍钢宪法身份：党的领导。" + ANSTEEL_RULES,
    llm=LLM(model="gpt-4o", temperature=0.2),
)

# 添加到Crew
crew = Crew(
    agents=[product_manager, tech_lead, staff_engineer, qa_engineer, data_analyst],
    tasks=tasks,
    process=Process.sequential,
)
```

### 11.4 规模对照表

| 规模 | 角色 | 鞍钢宪法覆盖 | 适合场景 |
|---|---|---|---|
| **3人** | TL + SE + QA | 三结合核心 | 日常问答、快速验证 |
| **5人** | +PM +Data Analyst | +党的领导+技术装备 | 正式报告、需要外部验证 |
| **7人** | +SRE +Recorder | +生产一线+工会监督 | 高风险决策、需要完整审计 |
| **N人** | +多SE +多QA +专家 | +群众运动广度 | 复杂跨领域议题 |

---

## 十二、评估指标（Phase 3用）

| 指标 | 定义 | 测量方法 |
|---|---|---|
| **幻觉率** | 最终输出中错误/无据断言的比例 | 人工标注 + 自动事实核查 |
| **质疑有效率** | QA质疑中被SE接受并修正的比例 | 统计讨论日志 |
| **否决有效率** | QA否决中确实发现问题的比例 | 人工复核 |
| **收敛速度** | 从初步方案到三方Sign-off的轮数 | 统计步骤数 |
| **置信度校准** | L1断言的实际准确率 | 事后验证 |
| **vs单Agent** | 与单Agent回答的幻觉率对比 | A/B测试 |

---

## 十三、实施路线图

```
Phase 0（1天）：用轨道C（纯Python）跑通最小3人讨论
  → 验证鞍钢宪法治理是否真的减少幻觉
  → 调整Prompt和温度参数
    ↓
Phase 1（3天）：迁移到轨道A（CrewAI），完善角色Prompt
  → 接入搜索工具（crewai-tools）实现真正的外部验证
  → 测试不同议题类型（事实题、推理题、创作题）
    ↓
Phase 2（1周）：扩展到5人团队（+PM +Data Analyst）
  → 测试轨道B（AG2）自由讨论模式
  → 对比结构化 vs 自由讨论的效果
    ↓
Phase 3（2周）：设计评估指标，A/B测试
  → 幻觉率、质疑有效率、收敛速度
  → 与单Agent对比
    ↓
Phase 4（持续）：迭代优化，开源发布"鞍钢协议（Ansteel Protocol）"
  → 标准化Prompt模板
  → 标准化讨论流程
  → 社区贡献角色和规则
```

---

## 十四、文件清单

| 文件 | 说明 |
|---|---|
| `鞍钢宪法式AI防幻觉讨论方案.md` | V1：抽象角色设计 |
| `鞍钢宪法式AI防幻觉讨论方案_V2.md` | V2：大厂角色命名 |
| `鞍钢宪法式AI防幻觉讨论方案_V3.md` | V3：开源框架选型 |
| `鞍钢宪法式AI防幻觉讨论方案_V4.md` | **V4：可运行代码+2026框架更新**（本文件） |

---

*形是硅谷，魂是鞍钢。*
*同一个模型，不同的帽子。*
*干部参加劳动，工人参加管理，改革不合理的规章制度，三结合出真知。*
*——2026年7月，V4*
