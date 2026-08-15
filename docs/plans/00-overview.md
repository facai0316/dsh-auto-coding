# 00 · 总览与依赖

> 目标：把 `docs/coding-pipeline-automation.md`（v2 方案）落地为可执行的实现计划。
> 本目录 `docs/plans/` 下 10 份计划按依赖顺序编号；本文是导航与全局约定。

## 1. 交付物总览

| # | 文件 | 一句话 |
|---|---|---|
| 01 | `01-data-model.md` | cm 库 schema 演进（projects / requirements.project_id / ask_user_questions） |
| 02 | `02-cm-flow-extension.md` | 宿主业务层扩展：repo + 状态机 + Typert remote 方法 |
| 03 | `03-worktree-manager.md` | git worktree 生命周期封装 |
| 04 | `04-worker-core.md` | cm-worker 插件：轮询调度 + 阶段编排 + records 记账 + 会话适配 |
| 05 | `05-decision-channel.md` | waiting_reply 挂起/作答/续跑闭环 |
| 06 | `06-pr-agent-task.md` | merge 阶段的 PR agent 任务 |
| 07 | `07-panel-upgrade.md` | 面板流水线控制台 |
| 08 | `08-full-integration.md` | 6 阶段全接入 + 重试/超时/多项目 |
| 09 | `09-testing-acceptance.md` | 测试策略与端到端验收清单 |

## 2. 依赖图与实施顺序

```
01 数据模型
   └─▶ 02 cm-flow 扩展（依赖 01 的表）
          ├─▶ 03 worktree（独立，可与 02 并行）
          │     └─▶ 04 worker 核心（依赖 02 服务面 + 03 worktree）
          │             ├─▶ 05 决策通道（依赖 04 编排 + 02 questions remote）
          │             ├─▶ 06 PR 任务（依赖 03 worktree + 04 阶段会话）
          │             └─▶ 07 面板（依赖 02 remote 面）
          │                     └─▶ 08 全集成（依赖 04/05/06/07）
          │                             └─▶ 09 测试验收（横跨全部）
```

**必须顺序**：01 → 02 → 04 → 05/06/07 → 08 → 09。03 可与 02 并行。每份计划都标注「前置」。

## 3. 全局术语

| 术语 | 含义 |
|---|---|
| requirement | 一条需求 = 一次完整流水线（一条分支） |
| record | 一个阶段的一次执行账本（category 区分阶段） |
| stage / 阶段 | decision / plan / review-plan / coding / contract / review-code / merge |
| worktree(wt) | 每任务一个 git worktree 目录 + 独立分支 |
| waiting_reply | record 状态：挂起等用户回答 questions |
| merging | requirement 状态：PR 已建，等用户手动合并 |
| 阶段会话 | 每阶段一个 subagent 会话，注入对应 facai skill |

## 4. 全局关键技术点（已探明，贯穿各计划）

### 4.1 阶段会话拉起与结构化回传

```ts
// host 侧（worker）
import type { SubagentStartRequest } from '@deepseek-ai/dsh-subagent'

const run = await ctx.subagents.start('spawn', {
  label: `${stage}-${requirementId}`,
  prompt: [{ type: 'text', text: promptText }],
  parent: workerAgent,          // 见 4.2
  signal: tickSignal,
  outputSchema: STAGE_RESULT_SCHEMA,   // 见 4.4
})
const result = await run.result        // SubagentResult
// result.stopReason: 'completed'|'aborted'|'error'|'max-tokens'|'refusal'
// result.structured: outputSchema 验证后的结构化值（成功时）
await run.dispose()
```

- 阶段结果用 **`outputSchema` + `result.structured`** 回传，不用 report 工具。
- `stopReason !== 'completed'` 视为阶段失败。

### 4.2 parent Agent（worker 根 agent）

`SubagentStartRequest.parent` 是硬要求（继承 cwd / 血缘 / 深度）。worker 启动时创建并缓存一个专用 root agent：

```ts
// 首次 tick 时（懒创建），session cwd = 项目主 checkout（见 04 计划）
const handle = await ctx.agents.create({ /* CreateAgentOptions，见 04 */ })
this.workerAgent = handle.agent
```

### 4.3 阶段 cwd 指向 worktree（验证项）

`SubagentStartRequest` 无 cwd 字段；in-process provider 从 `parent.session.header.cwd` 派生。v1 采用：
- prompt 注入 worktree 绝对路径（`工作根目录：<wt>`）
- 阶段会话内所有 bash/fs 以 `workdir`/`cwd` 传 `<wt>`

实现 03/04 时验证 `agentOptions` 能否覆盖 cwd，可覆盖则升级为 agentOptions 指定（不阻塞 v1）。

### 4.4 统一阶段结果 schema

```ts
const STAGE_RESULT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    isError: { type: 'boolean', required: true },
    message: { type: 'string', required: true },      // 人类可读结果/错误
    artifacts: { type: 'array', items: { type: 'string' }, required: true }, // 产物相对路径 + commit
    questions: {
      type: 'array', required: true,
      items: {
        type: 'object', additionalProperties: false,
        properties: {
          question: { type: 'string', required: true },
          options: { type: 'array', items: { type: 'string' }, required: true },
        },
      },
    },
  },
}
```

> `questions` 非空 → 阶段转入 `waiting_reply`（见 05）。

### 4.5 定时器与 tick 串行

```ts
// inject: ['timer', 'subagents', 'agents', 'pgmas', 'cmFlow']
const tick = async () => { /* 领取/续跑/重试/收尾，见 04 */ }
ctx.timer.interval(() => { if (!this.running) void this.tick() }, 10_000)
```

### 4.6 写库边界

- 写库一律经 `ctx.get('pgmas').withClient('cm', fn)`（cm-flow 提供的写缝）。
- worker 不注册模型写工具；`pg_query` 模型工具保持只读。

### 4.7 facai skill 注入（prompt 组装模板）

```
你是 FacAI 编码流水线的「{stage}」阶段执行者。

# 工作根目录
{worktreePath}   （所有文件/git 操作以此目录为 workdir）

# 项目规范
阅读 {repo}/.agents/AGENTS.md、{repo}/.agents/rules/*.md

# 技能指令
{SKILL.md 全文，来自 {repo}/.agents/skills/facai-{category}/SKILL.md}

# 需求
标题：{title}
描述：{description}

# 前序产物（相对 worktree 根）
{前序 records.artifacts 列表}

# 用户答复（续跑时）
Q: …  A: …（waiting_reply 的问答）

# 返回要求
完成后以结构化结果返回（字段见 outputSchema）：
- 成功：isError=false，artifacts=[产物相对路径, commit…]
- 需要用户决策：questions=[{question, options}]
- 失败：isError=true，message=原因
```

### 4.8 token 注入

`projects.pr_token` 经 bash 环境变量 `PR_TOKEN` 注入 PR 阶段会话（不进 prompt/git/records），见 06。

## 5. 验收总纲（09 展开）

- 一条需求「提交执行 → merging 待合并」全程自动，仅决策点人工
- 两需求并行互不干扰；合并冲突显式暴露
- 决策点正确挂起/作答/续跑；PR 由 agent 任务创建，Gitee/Gitea 动态判断
- 类型检查 + 真库集成 + 端到端走查全绿；断点续跑通过

## 6. 假设与边界

- 唯一试点项目 fac-ai-rs；projects 注册 + pr_token 由你面板输入；facai-init 手动
- 单 dsh 进程、单 worker 实例；`skip locked` 预留不验证
- 阶段会话超时默认 30min；PR 平台仅 Gitee/Gitea
