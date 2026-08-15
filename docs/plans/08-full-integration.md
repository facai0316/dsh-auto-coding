# 08 · 全阶段集成（6 阶段 + 收尾 + 重试/超时 + 多项目）

> 前置：04/05/06/07。目标：把单阶段骨架扩成完整流水线并加固。

## 1. 阶段链终态（在 04 STAGES 上补齐）

```
decision ─▶ plan ─▶ review-plan ─▶ coding ─▶ contract ─▶ review-code ─▶ merge
```

每个阶段输出推进规则（`runPipeline` 循环内）：

- `success` → 下一阶段
- `waiting` → 停止，等 ⑤ 续跑（续跑后从**同阶段**继续）
- `failed` → 停止，等 ③ 重试（重试同阶段）

`review-plan`/`review-code` 同用 `facai-review`，区别仅在 prompt 的「审核对象」段（计划 vs 代码）——在 STAGES 里加 `reviewTarget: 'plan' | 'code'` 字段注入 prompt。

## 2. 各阶段 prompt 差异点（在 00 §4.7 模板上追加）

| 阶段 | 追加指令 |
|---|---|
| decision | 产出 ADR 至 `decisions/`，方案多选时用 questions 返回 `{question, options}` |
| plan | 产出 `docs/plans/`，不写实现 |
| review-plan | 审 `docs/plans/`，计划冲突 → questions；可直改计划 |
| coding | 按 plan 落地 + 自动 facai-selfcheck 闭环；不 commit 由会话自理 |
| contract | 同步 `spec/`，语义不明 → questions |
| review-code | 审代码，冲突直改 |

## 3. 重试/超时/现场保留（加固 04 §9）

| 场景 | 行为 |
|---|---|
| 会话超时（AbortSignal.timeout） | stopReason 非 completed → failed → 重试 |
| 失败重试 | `retries < maxRetries`：重置 record 重跑同阶段；超限：requirement 回 `open`，worktree 保留，artifacts 记 wt 路径 + commit |
| 现场保留 | 失败/挂起均不删 worktree；artifacts 记录 `wt:<path> commit:<sha>` |

## 4. merge 收尾串联（06）

```
review-code success → runMerge：
  push → PR 任务 → merging（markMerging 记 pr_url）
面板「已合并」→ confirmMerged → done
worker finalizeMerged → worktree remove + 删分支
```

## 5. 多项目

- 固定 facai 6 skill，阶段硬编码（不做动态发现）
- 新项目接入 = 你手动跑 `facai-init`（把 `.agents` 初始化到新项目）+ 面板 `projects.create`（name/localPath/gitUrl/platform/prToken）
- worker 领取按 `project_id` 取项目，`WorktreeManager` 用 `project.local_path`；skill 从 `<local_path>/.agents/skills/facai-*/` 读
- 未跑 facai-init 的项目：`runStage` 读不到 SKILL.md → failed 并提示（不静默）

## 6. 配置项汇总（cm-worker Config）

```ts
database, pollMs(10s), stageTimeoutMs(30m), maxRetries(1),
subagentProvider('spawn'), worktreeRoot(可选，默认 <local_path>/../worktrees),
codingTimeoutMs(可更长), mergeTimeoutMs(可更长)
```

## 7. 实现步骤

1. STAGES 全表 + reviewTarget 注入
2. 各阶段 prompt 差异段
3. 超时/重试/现场保留加固
4. 多项目 skill 读取 + 缺失降级
5. 全链路真机走查（fac-ai-rs 一条需求）

## 8. 验收

- fac-ai-rs 一条需求「提交执行 → merging」全自动，仅决策点人工
- 阶段 failed 自动重试；超限回 open 且现场保留
- 第二项目（已 facai-init）注册后零改动跑通
