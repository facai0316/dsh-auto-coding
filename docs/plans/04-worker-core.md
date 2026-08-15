# 04 · cm-worker 核心（插件 + 调度 + 编排 + 记账 + 会话适配）

> 前置：02（服务面）、03（worktree）。新包 `packages/cm-worker`（host-only）。
> 目标：轮询驱动的流水线执行器骨架，先把「领取 → 单阶段 plan 会话 → 记账」跑通，再承载全阶段。

## 1. 插件骨架

```ts
// packages/cm-worker/src/index.ts
export default class CmWorkerService extends Service {
  static inject = ['timer', 'subagents', 'agents', 'pgmas', 'cmFlow', 'cmProjects', 'cmQuestions']

  static Config: z<Config> = z.object({
    database: z.string().default('cm'),
    pollMs: z.number().min(1000).default(10_000),
    stageTimeoutMs: z.number().default(30 * 60_000),
    maxRetries: z.number().min(0).max(5).default(1),
    subagentProvider: z.string().default('spawn'),   // 阶段会话 backend
  })

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'cmWorker')
    this.ctx = ctx
    this.pgmas = ctx.get('pgmas') as PgMasService
    this.subagents = ctx.get('subagents') as SubagentRuntime
    this.agents = ctx.get('agents') as AgentRuntime
    // …
    ctx.timer.interval(() => { if (!this.running) void this.tick() }, this.pollMs)
  }
}
```

> `inject` 里的 `cmFlow`/`cmProjects`/`cmQuestions` 是 02 提供的三个 TypertRemoteService 的**服务 key**（非 namespace）；worker 通过 `ctx.get(...)` 拿到其 repo 方法直接调用（进程内），不必走 remote wire。

## 2. worker 根 agent（阶段会话 parent）

懒创建并缓存（首次 tick 时）：

```ts
private workerAgent?: Agent

private async ensureWorkerAgent(project: ProjectView): Promise<Agent> {
  if (this.workerAgent !== undefined) return this.workerAgent
  // 实现时确认 CreateAgentOptions 形状；目标是 cwd=project.localPath 的专用 root agent
  const handle = await this.agents.create({
    // id/session 相关，cwd 指向 project.localPath（验证点）
  })
  this.workerAgent = handle.agent
  return this.workerAgent
}
```

> 验证点：`ctx.agents.create` 与 `ctx.agentLoop.create` 哪个能稳定产出「cwd=主 checkout 的 root agent」。若都需 session，用 worker 自己的 session。parent 用于血缘/深度/cwd 派生，阶段会话真实 cwd 由 prompt + workdir 约束（见 §6）。

## 3. tick 循环（串行，5 个动作）

```ts
private async tick(): Promise<void> {
  this.running = true
  try {
    await this.claimAndRun()      // ① 领取 open 需求并起阶段链
    await this.resumeWaiting()    // ② waiting_reply 且全 answered → 续跑
    await this.retryFailed()      // ③ failed 且 < 上限 → 重试
    await this.finalizeMerged()   // ④ done 但 worktree 未清 → 收尾（03/06）
  } catch (e) { this.log(e) }     // ⑤ 库不可达等：静默，下轮重试
  finally { this.running = false }
}
```

## 4. 领取（① claimAndRun）

```ts
// SQL（乐观锁）
const row = await this.pgmas.withClient(this.db, c => c.query(`
  update requirements r set status='in_progress', updated_at=now()
  where r.id = (
    select r2.id from requirements r2
    where r2.status='open' and r2.project_id is not null
    order by r2.created_at asc limit 1
    for update skip locked
  )
  returning r.id, r.project_id, r.title, r.description
`))
if (row.rows.length === 0) return
const { id, project_id, title, description } = row.rows[0]

// 建 worktree + 分支
const project = await this.projectsRepo.get(project_id)
const wt = await this.worktree(project).create(`req-${id.slice(0,8)}`)
await this.worktree(project).linkSharedTarget(wt)

// 记首条 record + 进入阶段链
await this.requirementsRepo.appendRecord({ requirementId: id, category: 'decision', status: 'running', branchId: wt.branch, skills: ['facai-decision'] })
await this.runPipeline(id, project, wt)
```

## 5. 阶段编排器（runPipeline）

```ts
const STAGES: StageDef[] = [
  { category: 'decision',    skill: 'facai-decision' },
  { category: 'plan',        skill: 'facai-plan' },
  { category: 'review-plan', skill: 'facai-review' },   // 审计划
  { category: 'coding',      skill: 'facai-coding' },   // 含 selfcheck 闭环
  { category: 'contract',    skill: 'facai-contract' },
  { category: 'review-code', skill: 'facai-review' },   // 审代码
  // 'merge' 由 06 的 PR agent 任务处理，不在本表
]

private async runPipeline(requirementId, project, wt): Promise<void> {
  for (const stage of STAGES) {
    const outcome = await this.runStage(requirementId, project, wt, stage)
    if (outcome === 'waiting') return        // 已挂起，等 ⑤ 续跑
    if (outcome === 'failed') return         // 已失败，等 ③ 重试
  }
  await this.runMerge(requirementId, project, wt)   // 06
}
```

## 6. 单阶段执行（runStage）

```ts
private async runStage(req, project, wt, stage): Promise<'success'|'waiting'|'failed'> {
  // 1. prompt 组装
  const skillMd = await readFile(join(project.localPath, `.agents/skills/${stage.skill}/SKILL.md`), 'utf8')
  const prompt = this.buildPrompt({ stage, wtPath: wt.path, repo: project.localPath, skillMd, req, priorArtifacts: await this.requirementsRepo.listArtifacts(req.id) })

  // 2. 起会话
  const parent = await this.ensureWorkerAgent(project)
  const run = await this.subagents.start(this.subagentProvider, {
    label: `${stage.category}:${req.id}`,
    prompt: [{ type: 'text', text: prompt }],
    parent,
    signal: AbortSignal.timeout(this.stageTimeoutMs),
    outputSchema: STAGE_RESULT_SCHEMA,       // 见 00 §4.4
  })
  const result = await run.result
  await run.dispose()

  // 3. 处理结构化结果
  if (result.stopReason !== 'completed' || result.structured === undefined) {
    return this.failStage(req, stage, result.stopReason)   // → failed
  }
  const s = result.structured as StageResult
  if (s.questions.length > 0) {
    // 挂起：record=waiting_reply + insert questions（05）
    return this.waitStage(req, stage, s.questions)
  }
  if (s.isError) return this.failStage(req, stage, s.message)

  // 4. 记账成功
  await this.requirementsRepo.updateRecord({
    category: stage.category, requirementId: req.id,
    status: 'success', result: s.message, artifacts: s.artifacts, skills: [stage.skill],
  })
  return 'success'
}
```

## 7. prompt 组装（buildPrompt，模板见 00 §4.7）

- 注入 `SKILL.md` 全文 + 规则路径 + 需求 + 前序产物 + 续跑问答（05）
- 明确 `工作根目录：<wt.path>`，要求所有 bash/fs 以 workdir/cwd 传该路径
- 明确返回要求（STAGE_RESULT_SCHEMA 字段）

## 8. 记账（records 字段映射）

| 动作 | category | status | 其它字段 |
|---|---|---|---|
| 领取首条 | `decision` | `running` | `skills=['facai-decision']`, `branch_id` |
| 阶段成功 | 该阶段 | `success` | `result=message`, `artifacts=产物路径[]`, `skills=[skill]` |
| 阶段失败 | 该阶段 | `failed` | `result=error`, `retries+1` |
| 挂起 | 该阶段 | `waiting_reply` | `result='awaiting user reply'` |
| merge 建 PR | `merge` | `success` | `artifacts=[prUrl]`（06） |
| confirmMerged | `merge` | `success` | `result='user confirmed merged'`（02） |

`parent_id` = 同 requirement 上一条 record id（串链）；`requirement_id`/`branch_id` 关联。

## 9. 失败与重试（③）

```ts
// failed 且 retries < maxRetries → 重置该 record status='running'、retries+1，重跑同阶段（现场保留在 worktree）
// 超限 → requirement.status 回 'open'（重新排队）；worktree/分支保留，records.artifacts 记 wt 路径 + commit
```

## 10. 实现步骤

1. 包骨架 + Config + 服务类 + `timer.interval`
2. `ensureWorkerAgent`（确认 agents.create 形状）
3. `claimAndRun`：领取 SQL + worktree 创建 + 首条 record
4. `runStage`：单阶段 plan 端到端（prompt + subagents.start + 结构化结果 + 记账）
5. `runPipeline`：阶段链顺序推进
6. 重试逻辑
7. 真库集成测试：造一条 open 需求 → 跑通 plan 阶段 → records 正确

## 11. 验收

- 提交 open 需求 → 自动领取、建 worktree、跑 plan 会话、记 record（success/failed 正确）
- 阶段会话 stopReason 非 completed 或 isError → record failed；questions 非空 → waiting_reply（05 接入前可先落库不续跑）
- tick 串行不重入；库不可达不崩溃、下轮重试
- worker 重启后能从 records 续跑（首条 running 的记录重置）
