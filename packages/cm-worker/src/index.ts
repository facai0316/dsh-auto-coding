/**
 * cm-worker — host-only dsh plugin: the coding-pipeline worker. A timer
 * interval drives a serial poll loop (claim / resume / retry / finalize) that
 * pulls `open` requirements into stage sessions (subagents) running inside
 * per-task git worktrees; every stage is a `records` ledger row.
 *
 * The worker only orchestrates and keeps books — it never writes code. All
 * database writes go through the cm-flow repos over `pgmas.withClient`;
 * `pg_query` stays read-only.
 *
 * @module @auto-coding/cm-worker
 */

import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { randomUUID } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { PgMasService } from '@auto-coding/db-pgmas'
import {
  DEFAULT_WORKER_CONFIG,
  MAX_CONCURRENCY,
  ProjectsRepo,
  QuestionsRepo,
  RequirementsRepo,
  ReviewsRepo,
  WorkerConfigRepo,
  type RecordListItem,
  type WorkerConfig,
} from '@auto-coding/cm-flow'
import { WorktreeManager } from '@auto-coding/cm-worktree'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SubagentResult, SubagentRun, SubagentStartRequest } from '@deepseek-ai/dsh-subagent'
import { WorkerPipeline, parsePrResult, withinWindow, type ClaimedRequirement, type PipelineWorktree, type PrExecution, type StageAgentOptions, type StageExecution, type StageInput } from './pipeline.ts'
export { buildResolvePrompt, buildPrompt, buildPrPrompt, runLanes, withinWindow, WorkerPipeline, type GapRow } from './pipeline.ts'

export const DEFAULT_DATABASE = 'cm'
export const DEFAULT_POLL_MS = 10_000
export const DEFAULT_STAGE_TIMEOUT_MS = 30 * 60_000
export const DEFAULT_MAX_RETRIES = 10
export const DEFAULT_SUBAGENT_PROVIDER = 'spawn'

/**
 * 时段门控：当前时刻是否落在配置窗口内。小时粒度（含 start、不含 end）；
 * start>end 视为跨天窗口（如 22:00→06:00）。disabled 时恒为 true。
 */


export interface Config {
  database: string
  pollMs: number
  stageTimeoutMs: number
  maxRetries: number
  subagentProvider: string
}

/** 阶段会话统一结构化输出契约（ObjectJsonSchema，subagent outputSchema 用）。 */
export const STAGE_RESULT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['isError', 'message', 'artifacts', 'questions'],
  properties: {
    isError: { type: 'boolean' },
    message: { type: 'string' },
    artifacts: { type: 'array', items: { type: 'string' } },
    questions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['question', 'options'],
        properties: {
          question: { type: 'string' },
          options: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  },
} as const

/** PR 创建任务结构化输出契约（方案 §8）。 */
export const PR_RESULT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['is_ok'],
  properties: {
    is_ok: { type: 'boolean' },
    pr_url: { type: 'string' },
    error: { type: 'string' },
  },
} as const

interface SubagentService {
  start(name: string, request: SubagentStartRequest): Promise<SubagentRun>
}
interface AgentsService {
  create(options: unknown): Promise<{ agent: Agent; dispose: () => Promise<void> }>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    timer: {
      interval(callback: () => void, delay: number): () => void
    }
  }
}

/**
 * 真实阶段执行器：subagents.start + STAGE_RESULT_SCHEMA 结构化回传。
 * 每个阶段会话都以「任务 worktree 为 cwd」新建一个 parent agent（不再复用
 * 单例 worker agent）：子会话的默认工作目录与沙箱 workspace 都指向 worktree，
 * 产物落在任务分支；并把 parent 会话的 sandbox/mode 放宽到 danger-full-access
 * —— git worktree 的 commit/push 会写主仓 .git（在 worktree 之外），
 * workspace-write 会被文件沙箱拒绝；这与方案 §7/§11「阶段会话权限 = 本机
 * bash/fs，worktree 限制只改任务分支」一致。会话用完即销毁。
 */
class SubagentStageExecutor implements WorkerExecutor {
  constructor(
    private readonly subagents: SubagentService,
    private readonly agents: AgentsService,
    private readonly provider: string,
    private readonly stageTimeoutMs: number,
    /**
     * 给阶段 parent agent 挂载部署的 agent preset（工具集）。与 GUI 会话代理
     * 同路径（agentPresets.mount）；缺失时保持 host 基础工具集。
     */
    private readonly composeAgent: ((agentCtx: unknown) => Promise<void>) | undefined,
  ) {}

  async run(input: StageInput, agentOptions?: StageAgentOptions): Promise<StageExecution> {
    const { parent, dispose } = await this.createParentAgent(input.wtPath)
    try {
      const run = await this.subagents.start(this.provider, {
        label: `${input.category}:${input.wtPath.split('/').pop() ?? ''}`,
        prompt: [{ type: 'text', text: input.prompt }],
        parent,
        signal: AbortSignal.timeout(this.stageTimeoutMs),
        outputSchema: STAGE_RESULT_SCHEMA as unknown as SubagentStartRequest['outputSchema'],
        ...(agentOptions !== undefined && agentOptions !== null ? { agentOptions } : {}),
      })
      const result: SubagentResult = await run.result
      await run.dispose().catch(() => {})
      return { stopReason: result.stopReason, structured: result.structured }
    } finally {
      await dispose().catch(() => {})
    }
  }

  async runPr(input: { prompt: string; repo: string; wtPath: string }, agentOptions?: StageAgentOptions): Promise<PrExecution> {
    const { parent, dispose } = await this.createParentAgent(input.wtPath)
    try {
      const run = await this.subagents.start(this.provider, {
        label: `merge:pr`,
        prompt: [{ type: 'text', text: input.prompt }],
        parent,
        signal: AbortSignal.timeout(this.stageTimeoutMs),
        outputSchema: PR_RESULT_SCHEMA as unknown as SubagentStartRequest['outputSchema'],
        ...(agentOptions !== undefined && agentOptions !== null ? { agentOptions } : {}),
      })
      const result: SubagentResult = await run.result
      await run.dispose().catch(() => {})
      if (result.stopReason !== 'completed') {
        return { isOk: false, error: `PR 会话未完成（stopReason=${result.stopReason}）` }
      }
      return parsePrResult(result.structured) ?? { isOk: false, error: 'PR 会话未返回合法 JSON' }
    } finally {
      await dispose().catch(() => {})
    }
  }

  private async createParentAgent(cwd: string): Promise<{ parent: Agent; dispose: () => Promise<void> }> {
    const handle = await this.agents.create({
      sessionId: randomUUID(),
      meta: { cwd, origin: 'subagent' },
      ...(this.composeAgent !== undefined ? { setup: this.composeAgent } : {}),
    })
    // 放宽子会话沙箱：delegation 会把 parent 会话的 sandbox/mode 继承给子代理。
    // 与 dsh-sandbox-policy 的 setSandboxMode 等价（append 一个 sandbox/mode 事件）。
    const session = handle.agent.session as unknown as { append(type: string, data: unknown): void }
    session.append('sandbox/mode', { mode: 'danger-full-access' })
    return { parent: handle.agent, dispose: () => handle.dispose() }
  }
}

export interface WorkerExecutor {
  run(input: StageInput, agentOptions?: StageAgentOptions): Promise<StageExecution>
  runPr(input: { prompt: string; repo: string; wtPath: string }, agentOptions?: StageAgentOptions): Promise<PrExecution>
}

/**
 * Typert Remote service (namespace `merge`): 审核大厅「解决冲突」按钮的入口。
 * 起跑一条冲突解决任务（fetch + merge + 解决冲突 + commit + push，可挂
 * waiting_reply 提问后携答复续跑）；返回 resolve record 列表项，执行在后台。
 */
export class MergeService extends TypertRemoteService {
  constructor(
    ctx: Context,
    private readonly startResolve: (requirementId: string) => Promise<RecordListItem>,
  ) {
    super(ctx, 'cmMerge', { namespace: 'merge' })
  }

  @Remote('resolveConflicts')
  async resolveConflicts(requirementId: string): Promise<RecordListItem> {
    return this.startResolve(requirementId)
  }
}

/**
 * Worker 服务：timer 驱动串行 tick。组合可测的 WorkerPipeline 与真实依赖
 * （subagents / agents / fs / worktree）。
 */
export default class CmWorkerService extends Service {
  static inject = ['pgmas', 'timer', 'subagents', 'agents']

  static Config: z<Config> = z.object({
    database: z.string().default(DEFAULT_DATABASE),
    pollMs: z.number().min(1000).default(DEFAULT_POLL_MS),
    stageTimeoutMs: z.number().min(10_000).default(DEFAULT_STAGE_TIMEOUT_MS),
    maxRetries: z.number().min(0).max(10).default(DEFAULT_MAX_RETRIES),
    subagentProvider: z.string().default(DEFAULT_SUBAGENT_PROVIDER),
  })

  private readonly pipeline: WorkerPipeline
  private readonly configRepo: WorkerConfigRepo
  private running = false
  private config: WorkerConfig = DEFAULT_WORKER_CONFIG
  /** 全局并发预算：当前正在跑的流水线任务数（领取 / 审核续跑 / 重试 / 冲突解决）。 */
  private active = 0
  /** 并发预算满时排队的后台任务（用户触发的冲突解决等）。 */
  private waiters: (() => void)[] = []
  /** 已派发、尚未落定的 record id（防同一审核/重试动作被多轮 tick 重复派发）。 */
  private dispatched = new Set<string>()
  /** 启动自愈（僵尸/残留恢复）只执行一次（见 tick 首个分支）。 */
  private startupRecovered = false

  constructor(ctx: Context, config: Config = {
    database: DEFAULT_DATABASE,
    pollMs: DEFAULT_POLL_MS,
    stageTimeoutMs: DEFAULT_STAGE_TIMEOUT_MS,
    maxRetries: DEFAULT_MAX_RETRIES,
    subagentProvider: DEFAULT_SUBAGENT_PROVIDER,
  }) {
    super(ctx, 'cmWorker')
    const pgmas = ctx.get('pgmas') as PgMasService | undefined
    if (pgmas === undefined) throw new Error('cm-worker: pgmas service is unavailable (mount @auto-coding/db-pgmas first)')
    const database = config.database ?? DEFAULT_DATABASE

    const requirements = new RequirementsRepo({ pgmas, database })
    const projects = new ProjectsRepo({ pgmas, database })
    const questions = new QuestionsRepo({ pgmas, database })
    const reviews = new ReviewsRepo({ pgmas, database })
    this.configRepo = new WorkerConfigRepo({ pgmas, database })

    const subagents = ctx.get('subagents') as SubagentService | undefined
    if (subagents === undefined) throw new Error('cm-worker: subagents service is unavailable')
    const agents = ctx.get('agents') as AgentsService | undefined
    if (agents === undefined) throw new Error('cm-worker: agents service is unavailable')

    // 与 GUI 会话同路径挂载部署默认 preset（bash/fs/git 等工具集），否则
    // worker 子代理只有 host 基础工具（如 db-pgmas 的 pg_query/pg_schema）。
    const presets = ctx.get('agentPresets') as {
      resolve(id?: string): Promise<{ id: string }>
      mount(agentCtx: Context, id: string): Promise<unknown>
    } | undefined
    const composeAgent = presets === undefined
      ? undefined
      : async (agentCtx: unknown) => {
          const preset = await presets.resolve()
          await presets.mount(agentCtx as Context, preset.id)
        }

    const executor = new SubagentStageExecutor(
      subagents,
      agents,
      config.subagentProvider ?? DEFAULT_SUBAGENT_PROVIDER,
      config.stageTimeoutMs ?? DEFAULT_STAGE_TIMEOUT_MS,
      composeAgent,
    )

    const worktrees = new Map<string, WorktreeManager>()
    const worktreeFor = (project: { id: string; localPath: string }): PipelineWorktree => {
      let manager = worktrees.get(project.id)
      if (manager === undefined) {
        manager = new WorktreeManager({ repo: project.localPath })
        worktrees.set(project.id, manager)
      }
      return manager
    }

    this.pipeline = new WorkerPipeline({
      pgmas,
      database,
      requirements,
      projects,
      questions,
      reviews,
      executor,
      readSkillMd: async (repo, skill) => readFile(join(repo, `.agents/skills/${skill}/SKILL.md`), 'utf8'),
      // 产物存在性校验：相对 worktree 根的路径真实存在（文件/目录均可）；不存在返回 false。
      artifactExists: async (wtPath, relPath) => {
        try {
          await stat(join(wtPath, relPath))
          return true
        } catch {
          return false
        }
      },
      worktreeFor,
      maxRetries: config.maxRetries ?? DEFAULT_MAX_RETRIES,
      configFor: category => {
        const stage = this.config.stages[category]
        const provider = stage?.provider ?? this.config.defaultProvider ?? undefined
        const model = stage?.model ?? this.config.defaultModel ?? undefined
        const maxTokens = stage?.maxTokens ?? this.config.defaultMaxTokens ?? undefined
        if (provider === undefined && model === undefined && maxTokens === undefined) return undefined
        return {
          ...(provider !== undefined ? { provider } : {}),
          ...(model !== undefined ? { model } : {}),
          ...(maxTokens !== undefined ? { maxTokens } : {}),
        }
      },
      // 冲突解决等用户触发的后台长任务走同一全局并发预算：满则排队，槽位空出即跑。
      dispatchBackground: task => {
        void this.withSlot(task).catch(error =>
          console.warn(`[cm-worker] 后台任务异常: ${error instanceof Error ? error.message : String(error)}`))
      },
      // 阶段兜底提交：技能层（facai-coding 等）默认不 git commit，而 merge push
      // 只推已提交内容——不提交则 PR 会漏掉全部代码。此处把阶段留下的未提交
      // 产物以一次 commit 落到任务分支（无改动 no-op，见 WorktreeManager.commitAll）。
      commitWorktree: async (project, wtPath, message) => {
        const manager = worktrees.get(project.id)
        if (manager === undefined) return
        await manager.commitAll(wtPath, message)
      },
    })

    const pollMs = config.pollMs ?? DEFAULT_POLL_MS
    ctx.timer.interval(() => {
      if (this.running) return
      void this.tick()
    }, pollMs)

    // 审核大厅「解决冲突」按钮的 Typert Remote 入口（namespace `merge`）。
    new MergeService(ctx, id => this.pipeline.startResolve(id))
  }

  /**
   * 串行 tick：读配置 → 时段门控 → 短派发（领取 / 审核续跑 / 重试，受全局并发
   * 预算约束）→ 收尾。tick 本身只做快查询与派发，不阻塞在长流水线上：每条
   * 领取 / 续跑 / 重试都以后台任务运行，槽位在流水线挂起（进审核门）或完成时
   * 释放——审核放行逐条到来也能按预算并发续跑（10s 一轮，槽位空出即补）。
   * 任一异常静默下轮重试。
   */
  private async tick(): Promise<void> {
    this.running = true
    try {
      this.config = await this.configRepo.get()
      if (!withinWindow(this.config)) {
        return
      }
      // 启动后第一个 tick：先自愈上一进程遗留的僵尸/残留（标记 stale running +
      // 缺口续跑）。恢复任务以后台派发（占并发槽），本 tick 即返回，下一 tick 再正常派发。
      if (!this.startupRecovered) {
        this.startupRecovered = true
        await this.recoverStartup()
        return
      }
      await this.dispatchClaims()
      await this.dispatchReviews()
      await this.dispatchRetries()
      await this.pipeline.finalizeMerged()
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      console.warn(`[cm-worker] tick 异常（下轮重试）: ${detail}`)
    } finally {
      this.running = false
    }
  }

  /** 全局并发预算：当前配置的 concurrency（1..MAX_CONCURRENCY 钳制）。 */
  private budget(): number {
    return Math.min(MAX_CONCURRENCY, Math.max(1, this.config.concurrency ?? 1))
  }

  /** 非阻塞获取一个并发槽：空闲则占用并返回 true；已满返回 false（下轮 tick 再试）。 */
  private trySlot(): boolean {
    if (this.active >= this.budget()) return false
    this.active += 1
    return true
  }

  /** 释放并发槽：有排队任务则直接移交（计数不变），否则 -1。 */
  private releaseSlot(): void {
    const next = this.waiters.shift()
    if (next !== undefined) next()
    else this.active -= 1
  }

  /** 排队获取并发槽（用户触发的冲突解决等：满了就排队，最终会跑）。 */
  private async withSlot<T>(fn: () => Promise<T>): Promise<T> {
    if (!this.trySlot()) {
      await new Promise<void>(resolve => this.waiters.push(resolve))
    }
    try {
      return await fn()
    } finally {
      this.releaseSlot()
    }
  }

  /** 后台派发一个占槽任务：异常落日志，落定（成功/失败）即释放槽位。 */
  private dispatchTask(fn: () => Promise<unknown>, what: string, onSettled?: () => void): void {
    void fn()
      .catch(error => console.warn(`[cm-worker] 后台任务 ${what} 异常: ${error instanceof Error ? error.message : String(error)}`))
      .finally(() => {
        if (onSettled !== undefined) onSettled()
        this.releaseSlot()
      })
  }

  /** 派发领取：按预算逐个原子领取 open 需求（for update skip locked 互斥），各自后台跑阶段链。 */
  private async dispatchClaims(): Promise<void> {
    while (this.trySlot()) {
      let claim: ClaimedRequirement | undefined
      try {
        claim = await this.pipeline.claim()
      } catch (error) {
        this.releaseSlot()
        throw error
      }
      if (claim === undefined) {
        this.releaseSlot()
        return
      }
      this.dispatchTask(() => this.pipeline.runClaimed(claim), `领取 ${claim.id.slice(0, 8)}`)
    }
  }

  /** 派发审核续跑：补 reply 单后，把已放行/驳回的记录按预算逐个后台续跑（多记录可并行）。 */
  private async dispatchReviews(): Promise<void> {
    await this.pipeline.ensureReplyTickets()
    const actions = await this.pipeline.listActionableReviews()
    for (const action of actions) {
      if (this.dispatched.has(action.record_id)) continue
      if (!this.trySlot()) break
      this.dispatched.add(action.record_id)
      this.dispatchTask(
        () => this.pipeline.processReviewAction(action),
        `审核续跑 record ${action.record_id.slice(0, 8)}`,
        () => this.dispatched.delete(action.record_id),
      )
    }
  }

  /** 派发重试：把可重试的 failed record 按预算逐个后台重跑（可并行）。 */
  private async dispatchRetries(): Promise<void> {
    const rows = await this.pipeline.listRetryable()
    for (const row of rows) {
      if (this.dispatched.has(row.record_id)) continue
      if (!this.trySlot()) break
      this.dispatched.add(row.record_id)
      this.dispatchTask(
        () => this.pipeline.processRetryRow(row),
        `重试 record ${row.record_id.slice(0, 8)}`,
        () => this.dispatched.delete(row.record_id),
      )
    }
  }

  /**
   * 启动自愈（仅第一个 tick）：标记上一进程残留的 running record 为 failed
   * （交给重试路径复用同一 record 续跑），并把停在 success 缺口的需求（如
   * review-code 已 success 但 merge 从未创建的僵尸）按并发预算后台续跑。
   */
  private async recoverStartup(): Promise<void> {
    try {
      const stale = await this.pipeline.markStaleRunning()
      if (stale > 0) {
        console.warn(`[cm-worker] 启动自愈：${stale} 条残留 running record 已转 failed（等待自动重试）`)
      }
      const gaps = await this.pipeline.listStuckGaps()
      for (const gap of gaps) {
        if (this.dispatched.has(gap.requirement_id)) continue
        if (!this.trySlot()) break
        this.dispatched.add(gap.requirement_id)
        this.dispatchTask(
          () => this.pipeline.resumeGap(gap),
          `缺口续跑 ${gap.requirement_id.slice(0, 8)}`,
          () => this.dispatched.delete(gap.requirement_id),
        )
      }
    } catch (error) {
      console.warn(`[cm-worker] 启动自愈异常（下轮不再重试，可人工介入）: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}
