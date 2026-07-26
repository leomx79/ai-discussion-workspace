# 鞍钢宪法式AI防幻觉讨论方案 V5
# ——开源项目改造实战指南：Fork哪个、改哪里、怎么改

> **V5 核心升级（相对V4）：**
> 1. 不再泛泛推荐框架，而是**具体到GitHub仓库、具体到文件、具体到代码行**
> 2. 对3个候选项目进行了**源码级分析**（已clone到本地逐行阅读）
> 3. 给出**改造难度评级**和**改造工作量估算**
> 4. 提供**Before/After代码对比**，照着改就行
> 5. 明确**改造路线图**：先改什么、后改什么、每步验证什么

---

## 一、候选项目源码级评估

### 1.1 评估标准

| 标准 | 权重 | 说明 |
|---|---|---|
| 代码量 | 25% | 越少越好改，你没有编程基础 |
| 结构清晰度 | 25% | 文件少、职责明确 |
| 与鞍钢方案匹配度 | 20% | 角色数、流程、制衡机制 |
| 同模型多API支持 | 15% | 能否给每个角色配不同API |
| 可扩展性 | 15% | 3人→5人→7人是否方便 |

### 1.2 三个候选项目对比（源码实测）

| 维度 | 🥇 crewai-debate | 🥈 local-llms-debate | 🥉 LLM-Discussion |
|---|---|---|---|
| **GitHub** | `omarlebda/crewai-debate` | `rpsene/local-llms-debate` | `lawraa/LLM-Discussion` |
| **核心代码量** | **4个文件，共4.7KB** | 2个文件，共19KB | 4个文件，共42KB |
| **框架依赖** | CrewAI（pip install crewai） | Ollama + SentenceTransformer | OpenAI + Gemini SDK |
| **Agent数量** | 2个（debater+judge） | N个（YAML配置） | N个（JSON配置） |
| **流程** | 顺序3步（propose→oppose→decide） | 多轮辩论+投票+裁判 | 三阶段（初始→多轮讨论→最终） |
| **角色配置** | YAML（agents.yaml） | YAML（config.yaml） | JSON（config_role.json） |
| **同模型多API** | ✅ 每Agent可配独立LLM | ⚠️ 需改代码（Ollama→OpenAI） | ✅ 每Agent独立client |
| **改造难度** | ⭐ 极简 | ⭐⭐ 中等 | ⭐⭐⭐ 较难 |
| **改造工时** | **2-4小时** | 4-8小时 | 8-16小时 |
| **适合人群** | 零编程基础 | 有Python基础 | 有工程经验 |

### 1.3 最终推荐

```
┌─────────────────────────────────────────────────────────────────┐
│                                                                 │
│   🥇 主改造对象：omarlebda/crewai-debate                        │
│      理由：代码最少（4.7KB）、结构最清晰、CrewAI生态成熟        │
│      改造量：改2个YAML + 1个Python文件，2-4小时搞定             │
│                                                                 │
│   🥈 借鉴对象：rpsene/local-llms-debate                         │
│      借鉴：投票机制、共识检测、Markdown导出、轮次总结            │
│      不直接用：绑定Ollama，需大量改造                            │
│                                                                 │
│   🥉 参考对象：lawraa/LLM-Discussion                            │
│      借鉴：角色扮演配置模式、多轮讨论结构                        │
│      不直接用：学术项目，代码复杂，改造成本高                    │
│                                                                 │
│   推荐路径：                                                    │
│   Phase 0: 用已有的 ansteel_discussion.py 验证概念 ✅（已完成）  │
│   Phase 1: Fork crewai-debate → 改造为鞍钢宪法3人版             │
│   Phase 2: 加入投票/共识检测（借鉴local-llms-debate）           │
│   Phase 3: 扩展到5人/7人团队                                    │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## 二、🥇 主改造对象：crewai-debate 源码分析

### 2.1 项目结构（总共就这些文件）

```
crewai-debate/
├── pyproject.toml              # 项目配置（不用改）
├── README.md                   # 说明文档（不用改）
├── knowledge/
│   └── user_preference.txt     # 知识库（可选）
└── src/debate/
    ├── __init__.py             # 空文件（不用改）
    ├── crew.py                 # ⭐ 核心：定义Agent和Task（要改）
    ├── main.py                 # ⭐ 入口：运行讨论（要改）
    ├── config/
    │   ├── agents.yaml         # ⭐ 角色定义（要改，最重要）
    │   └── tasks.yaml          # ⭐ 任务定义（要改，最重要）
    └── tools/
        ├── __init__.py         # 空文件（不用改）
        └── custom_tool.py      # 自定义工具（暂不用改）
```

**你只需要改4个文件：`agents.yaml`、`tasks.yaml`、`crew.py`、`main.py`**

### 2.2 原始代码（改造前）

#### agents.yaml（原始：2个角色）
```yaml
debater:
  role: >
    A compelling debater
  goal: >
    Present a clear argument either in favor of or against the motion.
    The motion is: {topic}
  backstory: >
    You're an experienced debator with a knack for giving concise
    but convincing arguments.
  llm: openai/gpt-4o-mini

judge:
  role: >
    Decide the winner of the debate based on the arguments presented
  goal: >
    Given arguments for and against this motion: {topic}, decide
    which side is more convincing.
  backstory: >
    You are a fair judge with a reputation for weighing up arguments
    without factoring in your own views.
  llm: openai/gpt-4o-mini
```

#### tasks.yaml（原始：3个任务）
```yaml
propose:
  description: >
    You are proposing the motion: {topic}.
    Come up with a clear argument in favor of the motion.
  expected_output: >
    Your clear argument in favor of the motion, in a concise manner.
  agent: debater

oppose:
  description: >
    You are in opposition to the motion: {topic}.
    Come up with a clear argument against the motion.
  expected_output: >
    Your clear argument against the motion, in a concise manner.
  agent: debater

decide:
  description: >
    Review the arguments presented by the debaters and decide
    which side is more convincing.
  expected_output: >
    Your decision on which side is more convincing, and why.
  agent: judge
```

#### crew.py（原始：2个Agent + 3个Task）
```python
from crewai import Agent, Crew, Process, Task
from crewai.project import CrewBase, agent, crew, task

@CrewBase
class Debate():
    agents_config = 'config/agents.yaml'
    tasks_config = 'config/tasks.yaml'

    @agent
    def debater(self) -> Agent:
        return Agent(config=self.agents_config['debater'], verbose=True)

    @agent
    def judge(self) -> Agent:
        return Agent(config=self.agents_config['judge'], verbose=True)

    @task
    def propose(self) -> Task:
        return Task(config=self.tasks_config['propose'])

    @task
    def oppose(self) -> Task:
        return Task(config=self.tasks_config['oppose'])

    @task
    def decide(self) -> Task:
        return Task(config=self.tasks_config['decide'])

    @crew
    def crew(self) -> Crew:
        return Crew(
            agents=self.agents,
            tasks=self.tasks,
            process=Process.sequential,
            verbose=True,
        )
```

---

## 三、改造方案：Before → After（照着改）

### 3.1 第一步：改 agents.yaml（最重要，10分钟）

**把2个角色 → 3个鞍钢宪法角色**

```yaml
# ============================================================
# 鞍钢宪法式AI防幻觉讨论 - 角色定义
# 三结合：干部(Tech Lead) + 技术人员(Staff Engineer) + 工人(QA Engineer)
# ============================================================

tech_lead:
  role: >
    Tech Lead（技术负责人），鞍钢宪法身份：干部
  goal: >
    主持鞍钢宪法式防幻觉讨论，确保七步流程严格执行。
    对关键争议点亲自验证（干部参加劳动），主持三方合议（三结合）。
    讨论议题：{topic}
  backstory: >
    你是一家大型科技公司的Tech Lead，对标Google Tech Lead。
    你的鞍钢宪法身份是"干部"——你必须亲自下场验证，不能只当裁判。
    你要确保"三结合"（TL+SE+QA）真正落实，确保QA的否决权被尊重。
    你的工作风格：严谨、务实、不偏不倚、先验证再下结论。

    ## 鞍钢宪法治理规则（必须严格遵守）
    ### 事实挂帅
    - 证据 > 自信。有证据的L2胜过没证据的L1。
    - 不知道就说不知道，绝不编造。
    ### 置信度标签
    - L1 🟢 已验证：有明确来源、可交叉验证（必须给出具体来源）
    - L2 🟡 高可信：基于可靠知识但无法即时验证（必须说明推理依据）
    - L3 🟠 待验证：不确定，需要进一步核查（必须标注并建议验证方法）
    - L4 🔴 存疑/未知：不确定或可能错误（必须明确说"我不确定"）
    ### 讨论纪律
    - 对事不对人，有错必纠，不得回避质疑，最终输出不得包含未标注的L3/L4断言。
  llm: openai/gpt-4o-mini
  temperature: 0.1

staff_engineer:
  role: >
    Staff Engineer（资深工程师），鞍钢宪法身份：技术人员
  goal: >
    针对议题提出初步方案，每个事实性断言标注置信度（L1-L4），
    提供证据来源和推理依据，逐条回应QA质疑，有错必纠。
    讨论议题：{topic}
  backstory: >
    你是一家大型科技公司的Staff Engineer，对标Google Staff Engineer / OpenAI Research Scientist。
    你的鞍钢宪法身份是"技术人员"——你是"三结合"中的技术人员代表。
    你的方案必须经得起质疑和验证，用证据说话，不用权威压人。
    你的工作风格：专业、深入、有理有据、承认不确定性、欢迎质疑。

    ## 鞍钢宪法治理规则（必须严格遵守）
    ### 事实挂帅
    - 证据 > 自信。有证据的L2胜过没证据的L1。
    - 不知道就说不知道，绝不编造。
    ### 置信度标签
    - L1 🟢 已验证：有明确来源、可交叉验证（必须给出具体来源）
    - L2 🟡 高可信：基于可靠知识但无法即时验证（必须说明推理依据）
    - L3 🟠 待验证：不确定，需要进一步核查（必须标注并建议验证方法）
    - L4 🔴 存疑/未知：不确定或可能错误（必须明确说"我不确定"）
    ### 讨论纪律
    - 对事不对人，有错必纠，不得回避质疑，最终输出不得包含未标注的L3/L4断言。
  llm: openai/gpt-4o-mini
  temperature: 0.3

qa_engineer:
  role: >
    QA & Reliability Engineer（质量与可靠性工程师），鞍钢宪法身份：工人
  goal: >
    对Staff Engineer的回答进行逐条质疑，重点检查L2-L4断言，
    行使否决权（对未经验证的关键断言有权否决），验证修正后的回答。
    讨论议题：{topic}
  backstory: >
    你是一家大型科技公司的QA & Reliability Engineer，对标Google SET / OpenAI Red Team。
    你的鞍钢宪法身份是"工人"——你是"工人参加管理"的代表。
    你的否决权是真实的，不是橡皮图章。你的质疑是为了提升质量，不是找茬。
    你的工作风格：怀疑一切、追根究底、用证据说话、建设性质疑。

    ## 鞍钢宪法治理规则（必须严格遵守）
    ### 事实挂帅
    - 证据 > 自信。有证据的L2胜过没证据的L1。
    - 不知道就说不知道，绝不编造。
    ### 置信度标签
    - L1 🟢 已验证：有明确来源、可交叉验证（必须给出具体来源）
    - L2 🟡 高可信：基于可靠知识但无法即时验证（必须说明推理依据）
    - L3 🟠 待验证：不确定，需要进一步核查（必须标注并建议验证方法）
    - L4 🔴 存疑/未知：不确定或可能错误（必须明确说"我不确定"）
    ### 讨论纪律
    - 对事不对人，有错必纠，不得回避质疑，最终输出不得包含未标注的L3/L4断言。
  llm: openai/gpt-4o-mini
  temperature: 0.5
```

> **💡 同模型不同API怎么配？**
> 把 `llm: openai/gpt-4o-mini` 改成：
> ```yaml
> # 方式1：不同API Key（通过环境变量）
> tech_lead:
>   llm: openai/gpt-4o-mini    # 使用 OPENAI_API_KEY 环境变量
>
> # 方式2：不同端点（如DeepSeek）
> staff_engineer:
>   llm: deepseek/deepseek-chat  # 使用 DEEPSEEK_API_KEY 环境变量
>
> # 方式3：在crew.py中用代码配置（见3.3节）
> ```

### 3.2 第二步：改 tasks.yaml（15分钟）

**把3个辩论任务 → 7个鞍钢宪法步骤**

```yaml
# ============================================================
# 鞍钢宪法式AI防幻觉讨论 - 七步流程
# ============================================================

# Step 1: 立项（Tech Lead）
step1_initiate:
  description: >
    【Step 1: 立项】
    作为Tech Lead，请为以下议题立项：{topic}

    要求：
    1. 明确讨论范围和边界
    2. 列出需要回答的关键问题（3-5个）
    3. 定义验收标准（什么样的回答算合格）
    4. 标注哪些是事实性问题（可验证）、哪些是观点性问题（需讨论）
  expected_output: >
    立项报告：包含讨论范围、关键问题清单、验收标准。
  agent: tech_lead

# Step 2: 初步方案（Staff Engineer）
step2_proposal:
  description: >
    【Step 2: 初步方案】
    作为Staff Engineer，请针对议题给出初步回答。

    严格要求：
    1. 每个事实性断言必须标注置信度（L1-L4）
    2. L1断言必须给出具体来源
    3. L2断言必须说明推理依据
    4. L3/L4断言必须标注并建议验证方法
    5. 不确定的就说不确定，绝不编造
  expected_output: >
    初步方案：每个断言都有L1-L4置信度标注和证据/推理依据。
  agent: staff_engineer
  context:
    - step1_initiate

# Step 3: 质疑（QA Engineer）
step3_challenge:
  description: >
    【Step 3: 质疑】
    作为QA Engineer，请对Staff Engineer的回答进行逐条质疑。

    检查清单：
    1. 每个断言的置信度标注是否合理？（有没有过度自信？）
    2. L1断言的来源是否真实存在？（防止编造来源）
    3. L2断言的推理链是否完整？（有没有跳跃？）
    4. 是否有遗漏的重要方面？
    5. 是否有内部矛盾？
    6. 对每个关键断言，明确表态：✅认可 / ⚠️质疑 / ❌否决

    你有权否决任何未经验证的关键断言（工人参加管理）。
  expected_output: >
    质疑报告：逐条质疑，每条标注✅/⚠️/❌，否决项需给出理由。
  agent: qa_engineer
  context:
    - step1_initiate
    - step2_proposal

# Step 4: 回应与修正（Staff Engineer）
step4_revision:
  description: >
    【Step 4: 回应与修正】
    作为Staff Engineer，请逐条回应QA的质疑。

    严格要求：
    1. 不得回避任何质疑（改革不合理制度：废除"回避质疑"旧规）
    2. 有错必纠，修正后重新标注置信度
    3. 对❌否决的断言：要么提供新证据，要么撤回
    4. 对⚠️质疑的断言：补充证据或降低置信度
    5. 给出修正后的完整回答
  expected_output: >
    修正后的完整回答：逐条回应质疑，修正置信度标注。
  agent: staff_engineer
  context:
    - step2_proposal
    - step3_challenge

# Step 5: 亲自验证（Tech Lead）
step5_verify:
  description: >
    【Step 5: 亲自验证（干部参加劳动）】
    作为Tech Lead，请亲自验证关键争议点。

    你不能只当裁判，必须亲自下场：
    1. 对QA和SE仍有分歧的点，亲自核查并给出你的判断
    2. 对关键事实，给出你的验证结论（标注L1-L4）
    3. 明确哪些点已确认、哪些仍有不确定性
    4. 如果QA有否决意见，你必须正面回应
  expected_output: >
    验证报告：对每个争议点的亲自验证结论，标注置信度。
  agent: tech_lead
  context:
    - step3_challenge
    - step4_revision

# Step 6: 三方合议（三结合）
step6_consensus:
  description: >
    【Step 6: 三方合议（三结合）】
    作为Tech Lead，请主持三方合议。

    要求：
    1. 总结TL、SE、QA三方观点
    2. 确认QA是否有否决意见（如有，必须解决后才能通过）
    3. 形成三方Sign-off的最终结论
    4. 标注残余不确定点（L3/L4）
    5. 给出最终输出

    最终输出格式：
    - 【结论】：...
    - 【置信度】：L? 🟢/🟡/🟠/🔴
    - 【证据】：...
    - 【残余不确定性】：...
    - 【三方Sign-off】：TL ✅ / SE ✅ / QA ✅（或❌+理由）
  expected_output: >
    三方合议结论：包含最终答案、置信度、证据、残余不确定性、三方Sign-off。
  agent: tech_lead
  context:
    - step4_revision
    - step5_verify

# Step 7: 输出归档
step7_archive:
  description: >
    【Step 7: 输出归档】
    作为Tech Lead，请将讨论结果整理为最终归档文档。

    格式：
    1. 议题
    2. 最终结论（含置信度）
    3. 关键证据
    4. 讨论中的主要争议点及解决方式
    5. 残余不确定性
    6. 三方Sign-off记录
    7. 讨论时间戳
  expected_output: >
    完整归档文档。
  agent: tech_lead
  context:
    - step6_consensus
```

### 3.3 第三步：改 crew.py（10分钟）

```python
from crewai import Agent, Crew, Process, Task
from crewai.project import CrewBase, agent, crew, task


@CrewBase
class AnsteelDiscussion():
    """鞍钢宪法式AI防幻觉讨论"""

    agents_config = 'config/agents.yaml'
    tasks_config = 'config/tasks.yaml'

    # ========== 三个角色（三结合） ==========

    @agent
    def tech_lead(self) -> Agent:
        return Agent(
            config=self.agents_config['tech_lead'],
            verbose=True,
            # 如需不同API，取消注释：
            # llm="deepseek/deepseek-chat",
        )

    @agent
    def staff_engineer(self) -> Agent:
        return Agent(
            config=self.agents_config['staff_engineer'],
            verbose=True,
            # 如需不同API：
            # llm="openai/gpt-4o",
        )

    @agent
    def qa_engineer(self) -> Agent:
        return Agent(
            config=self.agents_config['qa_engineer'],
            verbose=True,
            # 如需不同API：
            # llm="openai/gpt-4o-mini",
        )

    # ========== 七步流程 ==========

    @task
    def step1_initiate(self) -> Task:
        return Task(config=self.tasks_config['step1_initiate'])

    @task
    def step2_proposal(self) -> Task:
        return Task(config=self.tasks_config['step2_proposal'])

    @task
    def step3_challenge(self) -> Task:
        return Task(config=self.tasks_config['step3_challenge'])

    @task
    def step4_revision(self) -> Task:
        return Task(config=self.tasks_config['step4_revision'])

    @task
    def step5_verify(self) -> Task:
        return Task(config=self.tasks_config['step5_verify'])

    @task
    def step6_consensus(self) -> Task:
        return Task(config=self.tasks_config['step6_consensus'])

    @task
    def step7_archive(self) -> Task:
        return Task(
            config=self.tasks_config['step7_archive'],
            output_file='output/discussion_result.md',  # 自动保存结果
        )

    # ========== 组装 ==========

    @crew
    def crew(self) -> Crew:
        return Crew(
            agents=self.agents,
            tasks=self.tasks,
            process=Process.sequential,  # 顺序执行七步
            verbose=True,
        )
```

### 3.4 第四步：改 main.py（5分钟）

```python
#!/usr/bin/env python
import sys
import warnings
from datetime import datetime
from debate.crew import AnsteelDiscussion

warnings.filterwarnings("ignore", category=SyntaxWarning, module="pysbd")


def run():
    """运行鞍钢宪法式讨论"""
    # 议题：命令行传入或使用默认
    if len(sys.argv) > 1:
        topic = " ".join(sys.argv[1:])
    else:
        topic = "鞍钢宪法是哪一年提出的？核心内容是什么？"

    inputs = {
        'topic': topic,
        'current_year': str(datetime.now().year)
    }

    print(f"\n{'═'*60}")
    print(f"🏭 鞍钢宪法式AI防幻觉讨论")
    print(f"📌 议题：{topic}")
    print(f"👥 参与：Tech Lead + Staff Engineer + QA Engineer")
    print(f"⏰ 时间：{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    print(f"{'═'*60}\n")

    try:
        result = AnsteelDiscussion().crew().kickoff(inputs=inputs)
        print(f"\n{'═'*60}")
        print(f"✅ 讨论完成")
        print(f"{'═'*60}")
        print(result.raw)
    except Exception as e:
        raise Exception(f"讨论出错: {e}")


if __name__ == "__main__":
    run()
```

---

## 四、改造操作步骤（手把手）

### 4.1 环境准备（一次性）

```bash
# 1. 安装Python（如果还没有）
# 去 https://www.python.org/downloads/ 下载安装

# 2. 安装CrewAI
pip install crewai

# 3. 设置API Key（选一个你有的）
# OpenAI:
set OPENAI_API_KEY=sk-your-key-here
# 或 DeepSeek:
set DEEPSEEK_API_KEY=sk-your-key-here
# 或 其他OpenAI兼容API:
set OPENAI_API_KEY=your-key
set OPENAI_API_BASE=https://your-endpoint/v1
```

### 4.2 Fork并改造（30分钟）

```bash
# 1. 克隆项目
git clone https://github.com/omarlebda/crewai-debate.git ansteel-discussion
cd ansteel-discussion

# 2. 安装依赖
pip install -e .

# 3. 改文件（按上面的Before/After改这4个文件）
#    - src/debate/config/agents.yaml  ← 最重要
#    - src/debate/config/tasks.yaml   ← 最重要
#    - src/debate/crew.py
#    - src/debate/main.py

# 4. 运行测试
python -m debate.main "鞍钢宪法是哪一年提出的？"
```

### 4.3 验证清单

| 检查项 | 预期结果 | 通过？ |
|---|---|---|
| 3个角色都发言了 | TL→SE→QA→SE→TL→TL→TL | ☐ |
| SE的回答有L1-L4标注 | 每个断言都有置信度标签 | ☐ |
| QA进行了逐条质疑 | 有✅/⚠️/❌标注 | ☐ |
| SE逐条回应了质疑 | 没有回避任何质疑 | ☐ |
| TL亲自验证了争议点 | 不是只当裁判 | ☐ |
| 最终输出有三方Sign-off | TL✅ SE✅ QA✅ | ☐ |
| 结果保存到了文件 | output/discussion_result.md | ☐ |

---

## 五、🥈 借鉴对象：local-llms-debate 可借鉴的功能

### 5.1 值得借鉴的4个机制

| 机制 | 原项目实现 | 鞍钢方案中的应用 | 借鉴难度 |
|---|---|---|---|
| **投票机制** | 每个Agent投票选最有说服力的 | 三方合议时，SE和QA对TL的结论投票 | ⭐⭐ |
| **共识检测** | SentenceTransformer计算语义相似度 | 检测SE修正后是否真正解决了QA的质疑 | ⭐⭐⭐ |
| **轮次总结** | Moderator每轮总结 | TL在Step 5总结争议焦点 | ⭐ |
| **Markdown导出** | 自动生成格式化Markdown | 讨论记录自动归档 | ⭐ |

### 5.2 投票机制借鉴（Phase 2加入）

在CrewAI中，可以在Step 6（三方合议）后加一个投票Task：

```yaml
# 在tasks.yaml中追加
step6b_vote:
  description: >
    【投票】作为{role}，请对Tech Lead的三方合议结论进行投票。
    投票选项：✅同意 / ❌否决（需给出理由）
    如果你是QA且投了否决，讨论将回到Step 4重新修正。
  expected_output: >
    投票结果：✅或❌+理由
  agent: qa_engineer  # 先让QA投票（工人参加管理）
```

### 5.3 共识检测借鉴（Phase 2加入）

```python
# 借鉴local-llms-debate的语义相似度检测
# pip install sentence-transformers torch

from sentence_transformers import SentenceTransformer, util

model = SentenceTransformer("all-MiniLM-L6-v2")

def check_qa_satisfied(qa_challenge: str, se_revision: str) -> bool:
    """检测SE的修正是否真正解决了QA的质疑"""
    embeddings = model.encode([qa_challenge, se_revision], convert_to_tensor=True)
    similarity = util.cos_sim(embeddings[0], embeddings[1]).item()
    # 相似度>0.7说明SE的修正充分回应了QA的质疑
    return similarity > 0.7
```

---

## 六、🥉 参考对象：LLM-Discussion 可借鉴的模式

### 6.1 角色扮演配置模式

LLM-Discussion的`config_role.json`模式值得借鉴——用JSON/YAML定义角色：

```json
{
    "type": "openai",
    "model_name": "gpt-4o-mini",
    "agent_name": "Tech Lead - 干部",
    "agent_role": "Tech Lead",
    "agent_speciality": "技术决策与验证",
    "agent_role_prompt": "你是干部，必须亲自验证...",
    "speaking_rate": 1
}
```

**启发**：如果将来要扩展到5人/7人，可以用类似的JSON配置文件，而不是硬编码在代码里。

### 6.2 多轮讨论结构

LLM-Discussion的三阶段结构（初始回答→多轮讨论→最终汇总）与鞍钢七步法有相似之处：

| LLM-Discussion | 鞍钢七步法 |
|---|---|
| Phase 1: 初始回答 | Step 1-2: 立项+初步方案 |
| Phase 2: 多轮讨论 | Step 3-5: 质疑+修正+验证 |
| Phase 3: 最终汇总 | Step 6-7: 合议+归档 |

---

## 七、扩展到5人/7人团队

### 7.1 扩展方式（只需加YAML配置）

CrewAI的优势：加角色只需在YAML中加配置，不用改代码逻辑。

#### 5人团队（加PM + Data Analyst）

在`agents.yaml`中追加：

```yaml
product_manager:
  role: >
    Product Manager（产品经理），鞍钢宪法身份：党的领导
  goal: >
    把控讨论方向，定义议题边界，验收最终输出。
    确保讨论不跑题，输出符合用户需求。
  backstory: >
    你是一家大型科技公司的PM，对标Google PM。
    你的鞍钢宪法身份是"党的领导"——你把控方向，不参与具体技术争论。
  llm: openai/gpt-4o-mini
  temperature: 0.2

data_analyst:
  role: >
    Data Analyst（数据分析师），鞍钢宪法身份：技术装备
  goal: >
    用数据和事实支撑讨论，对SE的方案进行数据验证。
  backstory: >
    你是一家大型科技公司的Data Analyst，对标Google Data Analyst。
    你的鞍钢宪法身份是"技术装备"——你提供数据武器。
  llm: openai/gpt-4o-mini
  temperature: 0.2
```

在`tasks.yaml`中，在Step 2和Step 3之间插入数据验证步骤：

```yaml
step2b_data_check:
  description: >
    【数据验证】作为Data Analyst，请验证Staff Engineer方案中的数据性断言。
    重点检查：数字是否准确？统计是否可靠？样本是否有代表性？
  expected_output: >
    数据验证报告：对每个数据性断言的验证结果。
  agent: data_analyst
  context:
    - step2_proposal
```

在`crew.py`中追加对应的`@agent`和`@task`方法即可。

### 7.2 团队规模对照表

| 规模 | 角色 | 鞍钢身份 | 新增步骤 |
|---|---|---|---|
| **3人** | TL + SE + QA | 干部+技术人员+工人 | 基础七步 |
| **5人** | +PM +DA | +党的领导+技术装备 | +方向把控+数据验证 |
| **7人** | +SRE +Recorder | +生产一线+工会 | +可靠性审查+记录归档 |
| **N人** | +领域专家×N | +群众 | +多视角质疑 |

---

## 八、同模型不同API的3种配置方式

### 方式1：环境变量（最简单）

```bash
# 所有角色用同一个API
set OPENAI_API_KEY=sk-your-key
```

### 方式2：YAML中指定不同模型

```yaml
# agents.yaml
tech_lead:
  llm: openai/gpt-4o          # 用GPT-4o
staff_engineer:
  llm: deepseek/deepseek-chat  # 用DeepSeek
qa_engineer:
  llm: openai/gpt-4o-mini     # 用GPT-4o-mini
```

需要设置对应环境变量：
```bash
set OPENAI_API_KEY=sk-openai-key
set DEEPSEEK_API_KEY=sk-deepseek-key
```

### 方式3：crew.py中代码配置（最灵活）

```python
from crewai import Agent, LLM

@agent
def tech_lead(self) -> Agent:
    return Agent(
        config=self.agents_config['tech_lead'],
        llm=LLM(
            model="openai/gpt-4o",
            api_key="sk-key-1",
            base_url="https://api.openai.com/v1",
        ),
        verbose=True,
    )

@agent
def staff_engineer(self) -> Agent:
    return Agent(
        config=self.agents_config['staff_engineer'],
        llm=LLM(
            model="deepseek/deepseek-chat",
            api_key="sk-key-2",
            base_url="https://api.deepseek.com/v1",
        ),
        verbose=True,
    )
```

---

## 九、改造路线图

```
Phase 0 ✅ 已完成
│  用 ansteel_discussion.py 验证概念
│  确认七步流程可行、角色分工合理
│
Phase 1 ⬜ 本次改造（2-4小时）
│  Fork crewai-debate → 改造为鞍钢宪法3人版
│  改4个文件：agents.yaml + tasks.yaml + crew.py + main.py
│  验证：3个角色、七步流程、L1-L4标注、QA否决权
│
Phase 2 ⬜ 增强（4-8小时）
│  借鉴 local-llms-debate：
│  - 加入投票机制（QA否决→回到Step 4）
│  - 加入共识检测（SE修正是否真正解决QA质疑）
│  - 加入Markdown导出（讨论记录自动归档）
│  借鉴 LLM-Discussion：
│  - 角色配置外部化（JSON/YAML）
│
Phase 3 ⬜ 扩展（4-8小时）
│  扩展到5人团队（+PM +DA）
│  测试AG2 GroupChat模式（自由讨论）
│
Phase 4 ⬜ 评估（持续）
│  设计评估指标：幻觉率、修正率、QA否决率
│  A/B测试：单Agent vs 鞍钢宪法3人 vs 5人
│
Phase 5 ⬜ 开源
   发布"鞍钢协议 (Ansteel Protocol)"
   目标：成为AI防幻觉讨论的标准框架
```

---

## 十、常见问题

### Q1: CrewAI安装失败怎么办？
```bash
# 用虚拟环境
python -m venv venv
venv\Scripts\activate  # Windows
pip install crewai

# 如果还是失败，用纯Python版（ansteel_discussion.py）
pip install openai
python ansteel_discussion.py "你的议题"
```

### Q2: 没有OpenAI API Key怎么办？
CrewAI支持任何OpenAI兼容API：
```yaml
# 用DeepSeek
llm: deepseek/deepseek-chat

# 用本地Ollama
llm: ollama/llama3

# 用任何OpenAI兼容端点
llm: openai/your-model-name
# 设置环境变量：
# OPENAI_API_KEY=your-key
# OPENAI_API_BASE=https://your-endpoint/v1
```

### Q3: 讨论结果太长/太短怎么调？
在`tasks.yaml`的`description`中加字数要求：
```yaml
step2_proposal:
  description: >
    ...（原有内容）
    字数要求：500-1000字。
```

### Q4: 想让QA更严格/更温和？
调`agents.yaml`中的`temperature`：
```yaml
qa_engineer:
  temperature: 0.7  # 更严格（更随机、更激进）
  # temperature: 0.3  # 更温和（更保守、更克制）
```

### Q5: 和现有的ansteel_discussion.py是什么关系？
```
ansteel_discussion.py = 概念验证（Phase 0）
crewai-debate改造版   = 生产版本（Phase 1）

两者逻辑完全一致，只是实现方式不同：
- ansteel_discussion.py：纯Python，零依赖，适合理解原理
- crewai-debate改造版：CrewAI框架，有工具集成、记忆、并行等能力
```

---

## 附录A：三个候选项目详细源码分析

### A.1 crewai-debate 源码结构

```
总代码量：4.7KB（4个核心文件）
├── crew.py (1.2KB)     → 2个@agent + 3个@task + 1个@crew
├── main.py (1.9KB)     → run/train/replay/test 4个函数
├── agents.yaml (0.8KB) → 2个角色定义（debater + judge）
└── tasks.yaml (0.9KB)  → 3个任务定义（propose + oppose + decide）

改造点：
- agents.yaml: 2角色→3角色，加鞍钢宪法Prompt
- tasks.yaml: 3任务→7任务，加七步流程
- crew.py: 2个@agent→3个，3个@task→7个
- main.py: 改入口，加议题输入
```

### A.2 local-llms-debate 源码结构

```
总代码量：19KB（2个核心文件）
├── debate.py (17KB)    → OllamaAgent类 + Moderator类 + 辩论主循环
└── config.yaml (2KB)   → 5个Agent配置 + 辩论设置

特点：
- 绑定Ollama（本地模型），不直接用OpenAI API
- 有SentenceTransformer语义相似度检测
- 有投票机制、共识检测、Markdown导出
- 代码质量高，但改造需要替换Ollama→OpenAI

可借鉴：
- 投票机制（conduct_voting函数）
- 共识检测（check_semantic_agreement函数）
- Markdown导出（export_markdown_transcript函数）
- 轮次总结（Moderator.summarize_round方法）
```

### A.3 LLM-Discussion 源码结构

```
总代码量：42KB（4个核心文件）
├── agents.py (6.4KB)      → Agent基类 + OpenAIAgent + GeminiAgent + Llama2Agent
├── discussion.py (31KB)   → Discussion基类 + LLM_Debate + 多种任务类型
├── llm_discussion.py (2.5KB) → 命令行入口
└── config_role.json (2.3KB)  → 角色配置（JSON格式）

特点：
- 学术项目（创造力研究），不是防幻觉
- 三阶段讨论：初始→多轮→最终
- 支持OpenAI/Gemini/Llama2多后端
- 代码复杂，改造成本高

可借鉴：
- 角色配置外部化（config_role.json模式）
- 多轮讨论的construct_response方法
- 多后端Agent抽象（Agent基类）
```

---

## 附录B：鞍钢宪法核心概念速查

| 概念 | 含义 | AI映射 |
|---|---|---|
| **两参** | 干部参加劳动、工人参加管理 | TL亲自验证、QA有否决权 |
| **一改** | 改革不合理规章制度 | 废除8条旧规（默认自信、一次成型等） |
| **三结合** | 干部+技术人员+工人 | TL+SE+QA三方Sign-off |
| **政治挂帅** | 政治方向第一 | 事实挂帅：证据>自信 |
| **党的领导** | 党委统一领导 | PM把控方向（5人+） |
| **群众运动** | 广泛动员 | 多角色参与 |

> **鞍钢宪法 vs 马钢宪法（苏联模式）：**
> - 马钢宪法 = 一长制（一个人说了算）= 单Agent（一个大脑思考）→ 容易幻觉
> - 鞍钢宪法 = 两参一改三结合（多人制衡）= 多Agent讨论 → 减少幻觉
