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
import type { PgMasService } from './db.ts'
import { SkillSource, normalizeSkillsSource, type SkillsSourceConfig } from './skills-source.ts'
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
} from './flow-repo.ts'
import { WorktreeManager } from './worktree.ts'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SubagentResult, SubagentRun, SubagentStartRequest } from '@deepseek-ai/dsh-subagent'
import { STAGES, WorkerPipeline, parsePrResult, stageWindowAllowed, withinWindow, type ClaimedRequirement, type PipelineWorktree, type PrExecution, type StageAgentOptions, type StageExecution, type StageInput } from './worker-pipeline.ts'
export { buildResolvePrompt, buildPrompt, buildPrPrompt, runLanes, stageWindowAllowed, withinWindow, WorkerPipeline, type GapRow } from './worker-pipeline.ts'

export const DEFAULT_DATABASE = 'cm'
export const DEFAULT_POLL_MS = 10_000
export const DEFAULT_STAGE_TIMEOUT_MS = 30 * 60_000
export const DEFAULT_MAX_RETRIES = 10
export const DEFAULT_SUBAGENT_PROVIDER = 'spawn'

/**
 * 时段门控（见 worker-pipeline.ts）：withinWindow 判窗口（start>end 跨天，如
 * 22:00→06:00）；stageWindowAllowed 按阶段清单判「该阶段此刻能否起跑」——
 * 清单缺省 = 全部阶段受限（窗口外整轮不派发），清单内阶段窗口外延后。
 */


export interface Config {
  database: string
  pollMs: number
  stageTimeoutMs: number
  maxRetries: number
  subagentProvider: string
  /**
   * facai skills 外部来源（决策 4 修订：**插件不内置 skills**，那套 facai
   * skills 是项目/组织特定的）。可选：dir（绝对路径）| git（url+ref）；
   * 缺省/未配置 = 只读项目自身 `.agents/skills/`（需先跑 facai-init）。
   */
  skillsSource?: SkillsSourceConfig
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
    // 决策 4（P3 修订）：facai skills 外部来源（dir|git）。缺省不配置 =
    // 只读项目自身 .agents/skills/（插件不内置任何技能）。
    skillsSource: z.object({
      kind: z.string(),
      path: z.string(),
      url: z.string(),
      ref: z.string(),
    }),
  }) as unknown as z<Config>

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
  /** 在途整链任务（requirement id）：领取/续跑/重试/缺口任务运行期间，缺口扫描不得对同一需求再派发。 */
  private readonly inflight = new Set<string>()
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

    // 决策 4（P3 修订）：skills 外部来源。**插件不内置任何技能**——facai
    // skills 是项目/组织特定的（编码 fac-ai-rs 的规则），所以流水线总是先读
    // 项目自身 `.agents/skills/<skill>/SKILL.md`（facai-init 或人工放置）；
    // skillsSource（dir|git）只是可选的外部技能仓库兜底。
    const skills = new SkillSource(normalizeSkillsSource(config.skillsSource))

    this.pipeline = new WorkerPipeline({
      pgmas,
      database,
      requirements,
      projects,
      questions,
      reviews,
      executor,
      readSkillMd: async (repo, skill) => {
        try {
          return await readFile(join(repo, `.agents/skills/${skill}/SKILL.md`), 'utf8')
        } catch {
          const dir = skills.skillDir(skill)
          if (dir === undefined) throw new Error(`技能 ${skill} 不在项目与 skillsSource 中`)
          return readFile(join(dir, 'SKILL.md'), 'utf8')
        }
      },
      // 决策 4（P3）：worktree 建好后把技能集补进 .agents/skills/（仅缺失项）。
      provisionSkills: async wtPath => {
        for (const skill of skills.list()) {
          const dir = skills.skillDir(skill)
          if (dir === undefined) continue
          const target = join(wtPath, `.agents/skills/${skill}/SKILL.md`)
          try {
            await stat(target)
          } catch {
            const { mkdir, writeFile } = await import('node:fs/promises')
            await mkdir(join(wtPath, `.agents/skills/${skill}`), { recursive: true })
            await writeFile(target, await readFile(join(dir, 'SKILL.md'), 'utf8'), 'utf8')
          }
        }
      },
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
      // 每阶段时段门控（配置热生效：每轮 tick 重读后经此透传给流水线）。
      windowFor: category => this.windowFor(category),
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
   * 串行 tick：读配置 → 时段门控 → 短派发（领取 / 审核续跑 / 重试 / 缺口续跑，
   * 受全局并发预算约束）→ 收尾。tick 本身只做快查询与派发，不阻塞在长流水线上：
   * 每条领取 / 续跑 / 重试都以后台任务运行，槽位在流水线挂起（进审核门）或完成时
   * 释放——审核放行逐条到来也能按预算并发续跑（10s 一轮，槽位空出即补）。
   * 任一异常静默下轮重试。
   *
   * 时段门控两级：阶段清单缺省（旧配置）= 全部阶段受限，窗口外整轮跳过
   * （与历史行为一致）；配置了清单则按阶段过滤派发——受限阶段窗口外不领取/
   * 不续跑/不重试，未勾选阶段 24h 可跑；阶段链中途受限的，由 runStage 返回
   * 'deferred' 停在缺口态，窗口开启后经 dispatchGaps 接续。
   */
  private async tick(): Promise<void> {
    this.running = true
    try {
      this.config = await this.configRepo.get()
      if (this.config.timeWindowEnabled === true && this.config.timeWindowStages == null && !withinWindow(this.config)) {
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
      await this.dispatchGaps()
      await this.pipeline.finalizeMerged()
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      console.warn(`[cm-worker] tick 异常（下轮重试）: ${detail}`)
    } finally {
      this.running = false
    }
  }

  /** 每阶段时段门控：该阶段此刻是否允许起跑（清单外/未启用恒 true）。 */
  private windowFor(category: string): boolean {
    return stageWindowAllowed(this.config, category)
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

  /**
   * 后台派发一个占槽任务：异常落日志，落定（成功/失败）即释放槽位。
   * inflightId（requirement id）任务在途期间登记进 inflight，供缺口扫描避让。
   */
  private dispatchTask(fn: () => Promise<unknown>, what: string, onSettled?: () => void, inflightId?: string): void {
    if (inflightId !== undefined) this.inflight.add(inflightId)
    void fn()
      .catch(error => console.warn(`[cm-worker] 后台任务 ${what} 异常: ${error instanceof Error ? error.message : String(error)}`))
      .finally(() => {
        if (inflightId !== undefined) this.inflight.delete(inflightId)
        if (onSettled !== undefined) onSettled()
        this.releaseSlot()
      })
  }

  /** 派发领取：按预算逐个原子领取 open 需求（for update skip locked 互斥），各自后台跑阶段链。 */
  private async dispatchClaims(): Promise<void> {
    // 首阶段受限且窗口外 → 暂不领取（领取后阶段链会立刻延后，需求反而停在
    // 「无任何 record」的状态，缺口续跑看不见它）。
    if (!this.windowFor(STAGES[0]!.category)) return
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
      this.dispatchTask(() => this.pipeline.runClaimed(claim), `领取 ${claim.id.slice(0, 8)}`, undefined, claim.id)
    }
  }

  /** 派发审核续跑：补 reply 单后，把已放行/驳回的记录按预算逐个后台续跑（多记录可并行）。 */
  private async dispatchReviews(): Promise<void> {
    await this.pipeline.ensureReplyTickets()
    const actions = await this.pipeline.listActionableReviews()
    for (const action of actions) {
      if (this.dispatched.has(action.record_id)) continue
      // 驳回重跑 / 待决策放行都会重跑 action.category 本身：该阶段受限且窗口外
      // 则本轮跳过（record/审核单原样保留，窗口开后再续跑）。审核门通过
      // （kind=review + approved）只做记账并跑下一阶段——下一阶段受限时由
      // runPipeline 内部延后，这里不拦。
      if (action.review_status === 'rejected' || action.review_kind === 'reply') {
        if (!this.windowFor(action.category)) continue
      }
      if (!this.trySlot()) break
      this.dispatched.add(action.record_id)
      this.dispatchTask(
        () => this.pipeline.processReviewAction(action),
        `审核续跑 record ${action.record_id.slice(0, 8)}`,
        () => this.dispatched.delete(action.record_id),
        action.requirement_id,
      )
    }
  }

  /** 派发重试：把可重试的 failed record 按预算逐个后台重跑（可并行）。 */
  private async dispatchRetries(): Promise<void> {
    const rows = await this.pipeline.listRetryable()
    for (const row of rows) {
      if (this.dispatched.has(row.record_id)) continue
      // 该阶段受限且窗口外 → 本轮不重试（record 保持 failed，不消耗重试次数）。
      if (!this.windowFor(row.category)) continue
      if (!this.trySlot()) break
      this.dispatched.add(row.record_id)
      this.dispatchTask(
        () => this.pipeline.processRetryRow(row),
        `重试 record ${row.record_id.slice(0, 8)}`,
        () => this.dispatched.delete(row.record_id),
        row.requirement_id,
      )
    }
  }

  /**
   * 派发缺口续跑（每轮 tick）：扫描「in_progress + 最新 record = 阶段 success
   * （或领取后尚无 record）+ 无挂起/失败 + 无 merge」的缺口需求，按预算后台
   * 从下一阶段续跑。
   *
   * 覆盖三类缺口：① 进程崩溃/重启遗留（原启动自愈路径，现每轮兜底）；
   * ② 阶段链中途被时段门控延后的（runStage 返回 'deferred'，不落 record，
   * 需求自然停在上一阶段 success 的缺口态）——受限阶段进入窗口后即由此接续；
   * ③ 领取后尚未落 record 的竞态残留（从首阶段跑起）。
   * 在途整链任务（inflight）避让，防止与领取/续跑/重试并行重跑同一需求；
   * 下一阶段仍受限时 resumeGap → runStage 再次延后，只耗几次快查询。
   */
  private async dispatchGaps(): Promise<void> {
    const gaps = await this.pipeline.listStuckGaps()
    for (const gap of gaps) {
      if (this.inflight.has(gap.requirement_id)) continue
      if (!this.trySlot()) break
      this.dispatchTask(
        () => this.pipeline.resumeGap(gap),
        `缺口续跑 ${gap.requirement_id.slice(0, 8)}`,
        undefined,
        gap.requirement_id,
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
        if (this.inflight.has(gap.requirement_id)) continue
        if (!this.trySlot()) break
        this.dispatchTask(
          () => this.pipeline.resumeGap(gap),
          `缺口续跑 ${gap.requirement_id.slice(0, 8)}`,
          undefined,
          gap.requirement_id,
        )
      }
    } catch (error) {
      console.warn(`[cm-worker] 启动自愈异常（下轮不再重试，可人工介入）: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}
