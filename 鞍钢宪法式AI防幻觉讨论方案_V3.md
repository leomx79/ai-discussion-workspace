# 鞍钢宪法式AI防幻觉讨论方案 V3
# ——基于开源框架落地，小团队可用，同模型多角色

> **核心变更（V3）：**
> 1. 选定开源框架作为基座，不从零开发
> 2. 最小3人团队即可运行，向上可扩展
> 3. 支持同一模型、不同API配置（不同System Prompt = 不同角色）
> 4. 角色职责借鉴大厂，治理关系遵循鞍钢宪法

---

## 一、开源框架选型

### 1.1 候选框架对比

| 框架 | GitHub | 设计理念 | 角色定义 | 同模型多配置 | 流程控制 | 小团队友好 | 辩论/讨论支持 |
|---|---|---|---|---|---|---|---|
| **CrewAI** ⭐ | crewAIInc/crewAI | 角色驱动（Role-Based） | role + goal + backstory | ✅ 每个Agent独立LLM配置 | Sequential / Hierarchical / Flow | ✅ 3个Agent即可 | ✅ 有debate示例 |
| **AutoGen** | microsoft/autogen | 对话驱动（Conversation） | system_message | ✅ 每个Agent独立config | 对话式，灵活但复杂 | ⚠️ 配置较重 | ✅ 内置debate模式 |
| **LangGraph** | langchain-ai/langgraph | 状态机（State Machine） | 自定义节点 | ✅ | 图结构，极灵活 | ❌ 学习曲线陡 | ⚠️ 需自建 |
| **MAD** | Skytliang/Multi-Agents-Debate | 辩论专用 | 辩手+裁判 | ✅ | 固定辩论流程 | ✅ 极简 | ✅ 专为辩论设计 |
| **OpenAI Agents SDK** | openai/openai-agents-python | 极简（Agent+Handoff） | instructions | ✅ | Handoff链 | ✅ 极简 | ⚠️ 需自建 |
| **MetaGPT** | geekan/MetaGPT | 软件公司模拟 | 角色+职责 | ✅ | SOP流程 | ⚠️ 偏重 | ❌ 非讨论型 |

### 1.2 最终选择：CrewAI 为主基座

**选择理由：**

| 需求 | CrewAI 如何满足 |
|---|---|
| 角色借鉴大厂 | Agent 定义 = `role`（职位）+ `goal`（职责）+ `backstory`（部门背景），天然匹配 |
| 同模型不同API | 每个 Agent 可独立配置 `llm` 参数（model, temperature, api_key, base_url） |
| 鞍钢宪法治理 | Hierarchical Process（Tech Lead统领）+ Sequential Process（七步流程）+ 自定义规则 |
| 小团队3人起 | 最少定义3个Agent即可运行 |
| 向上扩展 | 增加Agent即可，不影响核心流程 |
| 外部验证工具 | 内置Tool系统，可接入搜索、代码执行等 |
| 现有辩论示例 | GitHub有 debate-agents 示例可直接改造 |
| 社区活跃 | 2024-2026年最活跃的多Agent框架之一 |

**辅助参考：**
- AutoGen 的对话式辩论模式 → 借鉴其"多轮质疑-回应"的对话结构
- MAD 的裁判机制 → 借鉴其"裁判总结"的裁决模式

---

## 二、团队规模设计

### 2.1 最小团队（3人）——鞍钢宪法"三结合"核心

```
┌─────────────────────────────────────────────┐
│           最小可行团队（3人）                 │
│                                             │
│   Tech Lead ──── Staff Engineer ──── QA     │
│   （干部）        （技术人员）       （工人）  │
│                                             │
│   三结合：三方Sign-off才能输出               │
└─────────────────────────────────────────────┘
```

| 角色 | 大厂对标 | 核心职责 | 鞍钢宪法身份 |
|---|---|---|---|
| **Tech Lead** | Google Tech Lead | 主持、裁决、亲自验证 | 干部 |
| **Staff Engineer** | Google Staff Eng / OpenAI Research Scientist | 提出方案、提供证据 | 技术人员 |
| **QA Engineer** | Google SET / OpenAI Red Team | 质疑、验证、否决 | 工人 |

> 3人即可完整运行"两参一改三结合"：
> - Tech Lead 亲自验证 = 干部参加生产劳动
> - QA 有否决权 = 工人参加企业管理
> - 三方Sign-off = 三结合

### 2.2 标准团队（5人）

在3人基础上增加：

| 新增角色 | 大厂对标 | 核心职责 | 鞍钢宪法身份 |
|---|---|---|---|
| **Product Manager** | Google PM | 定义议题、把控方向、验收输出 | 党的领导 |
| **Data Analyst** | Google Data Analyst / Eval Engineer | 外部验证、事实核查 | 技术装备 |

### 2.3 完整团队（7人）

在5人基础上增加：

| 新增角色 | 大厂对标 | 核心职责 | 鞍钢宪法身份 |
|---|---|---|---|
| **SRE** | Google SRE | 实践检验、真实场景验证 | 生产一线 |
| **Recorder** | Program Manager | 如实记录、归档、可追溯 | 工会 |

### 2.4 扩展团队（7人以上）

可继续增加：
- 多个 Staff Engineer（不同专业领域）
- 多个 QA（不同测试维度：逻辑QA、事实QA、安全QA）
- 领域专家（Domain Expert）
- 红队专员（Red Team Specialist）

> **扩展原则：核心"三结合"不变，增加的是"群众运动"的广度。**

---

## 三、同模型多角色配置方案

### 3.1 核心思路

> **同一个模型（如 GPT-4o / DeepSeek / Qwen），通过不同的 System Prompt + 不同的 temperature + 不同的工具权限，扮演不同角色。**

这不是"多个不同的AI"，而是"同一个AI戴不同的帽子"——
就像鞍钢的工人、技术人员、干部，都是鞍钢的人，但职责不同、权力不同、视角不同。

### 3.2 CrewAI 配置示例

```python
from crewai import Agent, Task, Crew, Process
from crewai.llm import LLM

# ============================================================
# 同一个模型，不同配置 = 不同角色
# ============================================================

# 共享模型基础配置（同一个API，同一个模型）
base_model = "gpt-4o"  # 或 "deepseek-chat", "qwen-plus" 等
base_api_key = "sk-xxx"  # 同一个API Key
base_url = "https://api.openai.com/v1"  # 或 DeepSeek/Qwen 的 endpoint

# --- 角色一：Tech Lead（干部）---
tech_lead = Agent(
    role="Tech Lead（技术负责人）",
    goal="""
    1. 主持技术讨论，确保每个角色充分发言
    2. 对关键争议点亲自推理验证（干部参加生产劳动）
    3. 对最终结论做裁决，裁决必须附推理过程
    4. 确保讨论不跑偏，聚焦核心问题
    """,
    backstory="""
    你是一位资深技术负责人，曾在Google担任Tech Lead 10年。
    你深知"不看代码就签字"的危害，所以坚持亲自验证关键论据。
    你的裁决从来不是"我说了算"，而是"我的推理过程如下"。
    你信奉鞍钢宪法：干部必须参加生产劳动，不能当甩手掌柜。
    """,
    llm=LLM(
        model=base_model,
        api_key=base_api_key,
        base_url=base_url,
        temperature=0.1,  # 低温度 = 更严谨、更确定性
    ),
    verbose=True,
)

# --- 角色二：Staff Research Engineer（技术人员）---
staff_engineer = Agent(
    role="Staff Research Engineer（首席研究工程师）",
    goal="""
    1. 基于专业知识给出初步回答/方案
    2. 提供完整推理链条和证据来源
    3. 明确标注确信度（High/Medium/Low/Speculative）
    4. 逐条回应QA的质疑，修正错误
    5. 禁止编造数据、引用、来源
    """,
    backstory="""
    你是一位首席研究工程师，曾在OpenAI担任Research Scientist。
    你的专业能力强，但你深知"自信不等于正确"。
    你习惯标注确信度，习惯说"我不确定"。
    你欢迎QA的质疑，因为质疑帮你发现盲点。
    你信奉：流畅≠正确，证据=正确。
    """,
    llm=LLM(
        model=base_model,
        api_key=base_api_key,
        base_url=base_url,
        temperature=0.3,  # 中低温度 = 有创造性但不离谱
    ),
    verbose=True,
)

# --- 角色三：QA & Reliability Engineer（工人）---
qa_engineer = Agent(
    role="QA & Reliability Engineer（质量与可靠性工程师）",
    goal="""
    1. 逐条质疑Staff Engineer的每一个事实性论断
    2. 要求提供证据来源，追问"证据呢？"
    3. 提出反例、边界条件、替代解释
    4. 每次讨论至少提出3个质疑点
    5. 如果证据不足，行使否决权
    6. 参与最终结论的形成，不是被动接受
    """,
    backstory="""
    你是一位质量与可靠性工程师，曾在Google担任SET（Software Engineer in Test），
    后在OpenAI Red Team工作。你的天职就是"找茬"。
    你拥有Release Veto（发布否决权），这不是摆设，是实权。
    你信奉鞍钢宪法：工人参加企业管理，不是走过场。
    你的座右铭："没有证据的结论，就是幻觉。"
    """,
    llm=LLM(
        model=base_model,
        api_key=base_api_key,
        base_url=base_url,
        temperature=0.5,  # 中温度 = 更有创造性地质疑
    ),
    verbose=True,
)
```

### 3.3 关键配置差异

| 配置项 | Tech Lead | Staff Engineer | QA Engineer |
|---|---|---|---|
| **model** | 同一个模型 | 同一个模型 | 同一个模型 |
| **api_key** | 同一个Key | 同一个Key | 同一个Key |
| **temperature** | 0.1（严谨裁决） | 0.3（专业推理） | 0.5（创造性质疑） |
| **System Prompt** | 干部职责+亲自验证 | 专家职责+标注确信度 | 工人职责+否决权 |
| **工具权限** | 搜索+计算（亲自验证） | 搜索+计算（提供证据） | 搜索+计算（独立验证） |

> **核心：同一个大脑，不同的"帽子"（System Prompt）+ 不同的"性格"（temperature）= 不同的视角和制衡。**

---

## 四、鞍钢宪法治理规则（嵌入Prompt）

### 4.1 全局规则（所有角色共享）

```python
ANSTEEL_RULES = """
## 鞍钢宪法讨论规则（全员必须遵守）

### 事实挂帅（最高原则）
- 一切以可验证的事实为准，不以"谁说的"为准，不以"多自信"为准
- "我不知道"是合法且受鼓励的回答
- 流畅 ≠ 正确，自信 ≠ 正确

### 确信度标注（强制）
每条事实性陈述必须标注：
- ✅ [VERIFIED] 经外部验证的事实
- 🔵 [HIGH] 高度可信的推理结论
- 🟡 [MEDIUM] 有依据但不完全确定
- 🔴 [SPECULATIVE] 猜测/假设/未验证

### 证据来源标注（强制）
- [SOURCE: verified] 经工具/数据验证
- [SOURCE: reasoning] 逻辑推导
- [SOURCE: memory] 模型记忆（可能有误）
- [SOURCE: assumption] 假设
- [SOURCE: unverified] 未验证

### 禁止行为
- ❌ 禁止编造具体数字、日期、人名
- ❌ 禁止编造不存在的论文、书籍、法规
- ❌ 禁止回避质疑
- ❌ 禁止"和稀泥"式模糊结论
- ❌ 禁止未经讨论直接输出最终答案

### 三结合规则
- 最终结论必须经 Tech Lead + Staff Engineer + QA 三方确认
- 三方一致 → High Confidence
- 两方一致+一方异议 → Medium Confidence + 附异议记录
- 三方分歧 → 标注"有争议"，列出各方观点
- 事实判断禁止"二对一"投票——事实不是投票决定的
"""
```

### 4.2 Tech Lead 专属规则（干部参加生产劳动）

```python
TECH_LEAD_RULES = """
## Tech Lead 专属规则（干部参加生产劳动）

1. 你不能只做裁判。对每个关键争议点，你必须亲自给出推理过程。
2. 你必须对 Staff Engineer 引用的数据/事实至少抽查验证30%。
3. 如果你无法验证某个论据，必须在结论中标注"Tech Lead未独立验证"。
4. 你的裁决必须附带推理过程，禁止"我说了算"式裁决。
5. 你必须阅读 QA 的完整质疑报告，不允许只看摘要。
6. 如果 QA 行使否决权，你必须认真对待，不能强行推翻。
"""
```

### 4.3 QA 专属规则（工人参加企业管理）

```python
QA_RULES = """
## QA Engineer 专属规则（工人参加企业管理）

1. 你拥有质疑权：对任何论断提出"证据呢？来源呢？"
2. 你拥有否决权：如果 Staff Engineer 无法提供充分证据，你可以否决该结论。
3. 你拥有提案权：你可以提出替代解释，要求纳入讨论。
4. 你拥有升级权：如果你认为 Tech Lead 的裁决不合理，你可以要求重新讨论。
5. 最终结论必须记录你的意见，即使被否决也要记录。
6. 你每次讨论必须至少提出3个质疑点，防止走过场。
7. 你不是橡皮图章。你的否决权是实权，不是形式。
"""
```

### 4.4 Staff Engineer 专属规则（技术人员接受监督）

```python
STAFF_ENGINEER_RULES = """
## Staff Engineer 专属规则（技术人员接受群众监督）

1. 你必须逐条回应 QA 的质疑，不允许回避。
2. 如果你无法回应某个质疑，该点自动标记为"未证实"。
3. 你必须主动标注确信度，不能等别人问。
4. 你必须在初始回答中区分"我确定的"和"我不确定的"。
5. 你欢迎质疑，因为质疑帮你发现盲点。
6. 被质疑不是丢脸，拒绝修正才是。
"""
```

---

## 五、讨论流程（CrewAI Task 编排）

### 5.1 七步流程 → CrewAI Sequential Process

```python
from crewai import Task

# Step 1: 立项（如有PM角色则由PM执行，3人团队由Tech Lead执行）
task_kickoff = Task(
    description="""
    明确本次讨论的议题、边界和验收标准。
    输出格式：
    - 议题：[具体问题]
    - 边界：[讨论范围限定]
    - 验收标准：[什么算合格答案]
    """,
    expected_output="Issue Brief（议题简报）",
    agent=tech_lead,  # 3人团队由Tech Lead兼任
)

# Step 2: 初步方案（Staff Engineer）
task_initial_answer = Task(
    description="""
    基于你的专业知识，对议题给出初步回答。
    要求：
    1. 给出明确的答案/方案
    2. 提供推理链条
    3. 列出证据来源
    4. 标注每条陈述的确信度和来源类型
    5. 明确区分"确定的"和"不确定的"
    
    {ANSTEEL_RULES}
    {STAFF_ENGINEER_RULES}
    """,
    expected_output="Draft Answer + Evidence List + Confidence Tags",
    agent=staff_engineer,
    context=[task_kickoff],
)

# Step 3: 红队质疑（QA Engineer）
task_challenge = Task(
    description="""
    对 Staff Engineer 的初步回答进行逐条质疑。
    要求：
    1. 至少提出3个质疑点
    2. 对每个事实性论断追问"证据呢？"
    3. 提出反例、边界条件、替代解释
    4. 检查是否有编造的数据/引用
    5. 检查确信度标注是否合理
    
    {ANSTEEL_RULES}
    {QA_RULES}
    """,
    expected_output="Challenge Report（质疑报告，≥3个质疑点）",
    agent=qa_engineer,
    context=[task_initial_answer],
)

# Step 4: 回应与修正（Staff Engineer）
task_revision = Task(
    description="""
    逐条回应 QA 的质疑，修正错误，补充证据。
    要求：
    1. 逐条回应，不允许回避
    2. 接受有效质疑，修正错误
    3. 补充缺失的证据
    4. 更新确信度标注
    5. 无法回应的点标记为"未证实"
    
    {ANSTEEL_RULES}
    {STAFF_ENGINEER_RULES}
    """,
    expected_output="Revised Answer + Response to Challenges",
    agent=staff_engineer,
    context=[task_challenge],
)

# Step 5: Tech Lead 亲自验证（干部参加生产劳动）
task_verification = Task(
    description="""
    对关键争议点亲自推理验证。
    要求：
    1. 阅读 QA 的完整质疑报告
    2. 对关键争议点亲自给出推理过程
    3. 对 Staff Engineer 的数据/事实抽查验证
    4. 评估 QA 的质疑是否有效
    5. 给出你的独立判断
    
    {ANSTEEL_RULES}
    {TECH_LEAD_RULES}
    """,
    expected_output="Verification Notes + Tech Lead Assessment",
    agent=tech_lead,
    context=[task_revision, task_challenge],
)

# Step 6: 三方合议（三结合 Sign-off）
task_signoff = Task(
    description="""
    作为 Tech Lead，主持三方合议，形成最终结论。
    要求：
    1. 综合 Staff Engineer 的修正回答和 QA 的质疑
    2. 结合你自己的验证结果
    3. 形成最终结论
    4. 标注最终确信度（High/Medium/Low/Contested）
    5. 记录任何未解决的分歧
    6. 如果 QA 有否决意见，必须记录并说明处理方式
    
    三结合规则：
    - 三方一致 → High Confidence
    - 两方一致+一方异议 → Medium Confidence + 附异议记录
    - 三方分歧 → 标注"有争议"
    """,
    expected_output="Final Conclusion + Confidence Level + Dissent Record",
    agent=tech_lead,
    context=[task_verification, task_revision, task_challenge],
)

# Step 7: 输出归档
task_output = Task(
    description="""
    整理最终输出，格式如下：
    
    ## 最终结论
    [结论内容]
    
    ## 确信度
    [High/Medium/Low/Contested]
    
    ## 证据来源
    [列出关键证据及其验证状态]
    
    ## 讨论记录摘要
    - Staff Engineer 初始观点：[摘要]
    - QA 质疑要点：[摘要]
    - 修正内容：[摘要]
    - Tech Lead 验证结果：[摘要]
    - 未解决分歧：[如有]
    
    ## 元信息
    - 讨论轮次：[N]
    - 质疑点数量：[N]
    - 修正次数：[N]
    """,
    expected_output="Final Output + Discussion Archive",
    agent=tech_lead,
    context=[task_signoff],
)
```

### 5.2 组装 Crew

```python
# 最小团队（3人）
crew = Crew(
    agents=[tech_lead, staff_engineer, qa_engineer],
    tasks=[
        task_kickoff,
        task_initial_answer,
        task_challenge,
        task_revision,
        task_verification,
        task_signoff,
        task_output,
    ],
    process=Process.sequential,  # 顺序执行七步流程
    verbose=True,
)

# 启动讨论
result = crew.kickoff(inputs={"topic": "你的议题"})
print(result)
```

---

## 六、扩展到5人/7人团队

### 6.1 增加 PM（5人团队）

```python
product_manager = Agent(
    role="Product Manager（产品经理）",
    goal="""
    1. 定义议题、范围和验收标准
    2. 确保讨论不跑偏
    3. 从用户/需求角度审视最终输出
    4. 当技术讨论陷入僵局时，从需求角度做取舍
    5. 不干预技术细节，不推翻事实判断
    """,
    backstory="""
    你是一位资深产品经理，曾在Google担任PM。
    你定义"What"和"Why"，Tech Lead决定"How"。
    你信奉鞍钢宪法中"党的领导"——管方向、管大局，不代替技术人员做技术决策。
    """,
    llm=LLM(
        model=base_model,
        api_key=base_api_key,
        base_url=base_url,
        temperature=0.2,
    ),
)

# PM 负责 Step 1（立项）和 Step 7（验收）
task_kickoff.agent = product_manager
# 增加 PM 验收步骤
task_pm_review = Task(
    description="从需求角度审视最终输出，确认是否回答了用户的问题。",
    agent=product_manager,
    context=[task_output],
)
```

### 6.2 增加 Data Analyst（5人团队）

```python
data_analyst = Agent(
    role="Data & Fact Analyst（数据与事实分析师）",
    goal="""
    1. 对专家引用的数据、事实进行独立验证
    2. 调用搜索工具、数据库等外部资源交叉核实
    3. 提供"事实核查报告"
    4. 标注哪些信息可验证、哪些无法验证
    """,
    backstory="""
    你是一位数据分析师，曾在Google担任Data Analyst。
    你的天职是"用数据说话"。你不接受"我记得是..."，你要求"让我查一下"。
    你是鞍钢宪法中的"技术装备"——用工具验证，不靠记忆。
    """,
    llm=LLM(
        model=base_model,
        api_key=base_api_key,
        base_url=base_url,
        temperature=0.1,
    ),
    tools=[search_tool, calculator_tool],  # 外部验证工具
)

# Data Analyst 在 Step 5 协助 Tech Lead 验证
```

### 6.3 扩展原则

```
3人（核心三结合）→ 5人（+方向把控+外部验证）→ 7人（+实践检验+记录归档）→ N人（+多专家+多QA）

核心不变：三结合 Sign-off 机制
扩展的是：群众运动的广度和深度
```

---

## 七、备选方案：AutoGen 实现

如果偏好更动态的对话式讨论（而非固定流程），可以用 AutoGen：

```python
import autogen

# 同一个模型，不同配置
config_list = [{
    "model": "gpt-4o",
    "api_key": "sk-xxx",
}]

# Tech Lead
tech_lead = autogen.AssistantAgent(
    name="Tech_Lead",
    system_message="""你是Tech Lead（技术负责人）...
    [嵌入 TECH_LEAD_RULES]
    [嵌入 ANSTEEL_RULES]""",
    llm_config={"config_list": config_list, "temperature": 0.1},
)

# Staff Engineer
staff_eng = autogen.AssistantAgent(
    name="Staff_Engineer",
    system_message="""你是Staff Research Engineer（首席研究工程师）...
    [嵌入 STAFF_ENGINEER_RULES]
    [嵌入 ANSTEEL_RULES]""",
    llm_config={"config_list": config_list, "temperature": 0.3},
)

# QA Engineer
qa_eng = autogen.AssistantAgent(
    name="QA_Engineer",
    system_message="""你是QA & Reliability Engineer（质量与可靠性工程师）...
    [嵌入 QA_RULES]
    [嵌入 ANSTEEL_RULES]""",
    llm_config={"config_list": config_list, "temperature": 0.5},
)

# 群聊讨论
groupchat = autogen.GroupChat(
    agents=[tech_lead, staff_eng, qa_eng],
    messages=[],
    max_round=12,  # 最多12轮对话
    speaker_selection_method="auto",
)

manager = autogen.GroupChatManager(
    groupchat=groupchat,
    llm_config={"config_list": config_list},
)

# 启动讨论
staff_eng.initiate_chat(
    manager,
    message="请讨论：[你的议题]"
)
```

**AutoGen vs CrewAI 选择建议：**

| 场景 | 推荐 |
|---|---|
| 需要固定流程（七步法） | **CrewAI**（Sequential Process） |
| 需要自由讨论、动态对话 | **AutoGen**（GroupChat） |
| 小团队快速上手 | **CrewAI**（更简单） |
| 需要复杂条件分支 | **AutoGen** 或 **LangGraph** |
| 需要外部工具集成 | 两者都支持，CrewAI更直观 |

---

## 八、超轻量方案：纯Python（无框架依赖）

如果连框架都不想装，可以用纯Python + API调用实现最小版本：

```python
import openai

client = openai.OpenAI(api_key="sk-xxx")
MODEL = "gpt-4o"

ROLES = {
    "tech_lead": {
        "system": "你是Tech Lead...[完整prompt]",
        "temperature": 0.1,
    },
    "staff_engineer": {
        "system": "你是Staff Engineer...[完整prompt]",
        "temperature": 0.3,
    },
    "qa_engineer": {
        "system": "你是QA Engineer...[完整prompt]",
        "temperature": 0.5,
    },
}

def chat(role_name, messages):
    """用同一个模型、不同配置调用"""
    role = ROLES[role_name]
    response = client.chat.completions.create(
        model=MODEL,
        messages=[{"role": "system", "content": role["system"]}] + messages,
        temperature=role["temperature"],
    )
    return response.choices[0].message.content

def ansteel_discussion(topic):
    """鞍钢宪法式讨论流程"""
    history = []
    
    # Step 1: Tech Lead 立项
    kickoff = chat("tech_lead", [{"role": "user", "content": f"请为以下议题立项：{topic}"}])
    history.append({"role": "assistant", "content": f"[Tech Lead 立项]\n{kickoff}"})
    
    # Step 2: Staff Engineer 初步回答
    answer = chat("staff_engineer", history + [{"role": "user", "content": "请给出初步回答"}])
    history.append({"role": "assistant", "content": f"[Staff Engineer]\n{answer}"})
    
    # Step 3: QA 质疑
    challenge = chat("qa_engineer", history + [{"role": "user", "content": "请逐条质疑"}])
    history.append({"role": "assistant", "content": f"[QA Engineer]\n{challenge}"})
    
    # Step 4: Staff Engineer 回应
    revision = chat("staff_engineer", history + [{"role": "user", "content": "请逐条回应质疑"}])
    history.append({"role": "assistant", "content": f"[Staff Engineer 修正]\n{revision}"})
    
    # Step 5: Tech Lead 亲自验证
    verify = chat("tech_lead", history + [{"role": "user", "content": "请亲自验证关键争议点"}])
    history.append({"role": "assistant", "content": f"[Tech Lead 验证]\n{verify}"})
    
    # Step 6: Tech Lead 三方合议
    final = chat("tech_lead", history + [{"role": "user", "content": "请主持三方合议，形成最终结论"}])
    
    return final

# 运行
result = ansteel_discussion("鞍钢宪法是哪一年提出的？")
print(result)
```

> 这个纯Python版本零依赖（只需openai库），3个角色、7步流程、同模型不同配置，完整实现鞍钢宪法治理。

---

## 九、方案对比总结

| 方案 | 复杂度 | 灵活性 | 适合场景 | 依赖 |
|---|---|---|---|---|
| **CrewAI** ⭐推荐 | 中 | 高 | 正式项目、需要工具集成、流程可控 | crewai, crewai-tools |
| **AutoGen** | 中高 | 很高 | 需要动态对话、自由讨论 | pyautogen |
| **纯Python** | 低 | 中 | 快速验证、最小可行、学习理解 | openai |
| **MAD** | 低 | 低 | 纯辩论场景、学术研究 | 轻量 |

---

## 十、实施路线图

```
Phase 0（1天）：用纯Python版本跑通最小3人讨论，验证鞍钢宪法治理有效性
    ↓
Phase 1（3天）：迁移到CrewAI，完善角色Prompt，接入搜索工具
    ↓
Phase 2（1周）：扩展到5人团队（+PM +Data Analyst），测试不同议题类型
    ↓
Phase 3（2周）：设计评估指标（幻觉率、质疑有效率、收敛速度），A/B测试
    ↓
Phase 4（持续）：根据评估结果迭代Prompt和流程，开源发布"鞍钢协议"
```

---

*形是硅谷，魂是鞍钢。*
*同一个模型，不同的帽子。*
*干部参加劳动，工人参加管理，改革不合理的规章制度，三结合出真知。*
