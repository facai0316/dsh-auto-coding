/**
 * Stage orchestration — pure, dependency-injected logic for the coding
 * pipeline worker: claim → stage chain → records ledger → decision channel
 * hooks. Cordis-free so it can be tested with fake executors against the real
 * `cm` database.
 * @module @auto-coding/cm-worker/pipeline
 */

import type { ProjectView, ProjectsRepo, QuestionsRepo, RecordListItem, RequirementsRepo, ReviewsRepo, WorkerConfig, WriteSeam } from './flow-repo.ts'

// ──────────────────────────────── stages ─────────────────────────────────

export interface StageDef {
  /** records.category 值。 */
  category: string
  /** facai skill 目录名（.agents/skills/<skill>/SKILL.md）。 */
  skill: string
  /** 附加到 prompt 的阶段专属指令。 */
  instruction?: string
}

/**
 * 需要人工审核的产物阶段（立即门禁）：阶段成功后直接挂起为 `waiting_review`
 * 并生成一张 kind='review' 的审核单，等在审核大厅通过后才继续；
 * 驳回带整改意见 → 复用同一 record 携反馈重跑。
 */
export const REVIEW_GATED: readonly string[] = ['decision']

/**
 * 延后人工审核门：某阶段（category）的产物审核放在其「机审」阶段（anchor，
 * 如 plan → review-plan）成功之后——先 agent facai-review 机审，再人审。
 * 通过后从 anchor 的下一阶段继续；驳回则从 category 阶段携反馈重跑，再走机审。
 */
export interface DeferredReviewGate {
  /** 被审核的产物阶段（其 record 挂 waiting_review + 审核单）。 */
  category: string
  /** 机审阶段：成功后才挂人审门。 */
  anchor: string
}

export const DEFERRED_REVIEW_GATES: readonly DeferredReviewGate[] = [
  { category: 'plan', anchor: 'review-plan' },
]

export const STAGES: readonly StageDef[] = [
  { category: 'decision', skill: 'facai-decision', instruction: '产出 ADR 至 decisions/；方案多选时用 questions 返回 {question, options}。' },
  { category: 'plan', skill: 'facai-plan', instruction: '产出 docs/plans/ 下的实现计划；只规划不实现。' },
  { category: 'review-plan', skill: 'facai-review', instruction: '独立审读实现计划；与用户预期/架构冲突时用 questions 提问，可直改计划。' },
  { category: 'coding', skill: 'facai-coding', instruction: '按计划落地为可编译代码，并自动执行 facai-selfcheck 闭环。' },
  { category: 'contract', skill: 'facai-contract', instruction: '按变更同步 spec/ 行为契约；语义不明确时用 questions 提问。' },
  { category: 'review-code', skill: 'facai-review', instruction: '独立审读代码；与架构/规则冲突直接修改。' },
]

export interface StageInput {
  category: string
  skill: string
  wtPath: string
  repo: string
  title: string
  description: string | null
  priorArtifacts: string[]
  userAnswers: { question: string; answer: string }[]
  /** 审核驳回的整改意见（重跑注入上下文）。 */
  feedback?: string
  prompt: string
}

export interface StageExecution {
  stopReason: string
  structured?: unknown
}

/** 阶段子会话的模型覆盖（直通 subagents.start 的 agentOptions）。 */
export interface StageAgentOptions {
  provider?: string
  model?: string
  maxTokens?: number
}

/**
 * 时段门控：当前时刻是否落在配置窗口内。小时粒度（含 start、不含 end）；
 * start>end 视为跨天窗口（如 22:00→06:00）；起=止视为不限制。disabled 恒为 true。
 */
export function withinWindow(config: Pick<WorkerConfig, 'timeWindowEnabled' | 'startHour' | 'endHour'>, now: Date = new Date()): boolean {
  if (config.timeWindowEnabled !== true) return true
  const hour = now.getHours()
  const start = config.startHour
  const end = config.endHour
  if (start === end) return true
  if (start < end) return hour >= start && hour < end
  return hour >= start || hour < end
}

/**
 * 并发 lanes：同时启动 `count` 个流水线（每个领取并跑一条需求）。
 * 领取用 `for update skip locked`，并发安全；返回实际跑起来的条数。
 * count 已由调用方钳制（1..MAX_CONCURRENCY）。
 */
export async function runLanes(count: number, run: () => Promise<boolean>): Promise<number> {
  const settled = await Promise.all(Array.from({ length: count }, () => run()))
  return settled.filter(Boolean).length
}

/** Structured result contract the stage session must return (00 §4.4). */
export interface StageResult {
  isError: boolean
  message: string
  artifacts: string[]
  questions: { question: string; options: string[] }[]
}

export interface StageExecutor {
  run(input: StageInput, agentOptions?: StageAgentOptions): Promise<StageExecution>
  /** PR 创建任务（merge 阶段）：返回 {is_ok, pr_url, error}。 */
  runPr(input: { prompt: string; repo: string; wtPath: string }, agentOptions?: StageAgentOptions): Promise<PrExecution>
}

/** PR 任务结构化结果（方案 §8 JSON 契约）。 */
export interface PrExecution {
  isOk: boolean
  prUrl?: string
  error?: string
}

/** 解析 PR 任务结构化输出；`is_ok` 兼容 boolean 与字符串 `"true"`。 */
export function parsePrResult(value: unknown): PrExecution | null {
  if (value === null || typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  if (v.is_ok !== true && v.is_ok !== 'true' && v.is_ok !== false && v.is_ok !== 'false') return null
  return {
    isOk: v.is_ok === true || v.is_ok === 'true',
    prUrl: typeof v.pr_url === 'string' ? v.pr_url : undefined,
    error: typeof v.error === 'string' ? v.error : undefined,
  }
}

/**
 * 组装 PR 创建任务的指导指令（方案 §8）。
 *
 * token 直接注入指令正文（本地个人部署可接受；子进程环境会做凭据清洗、
 * shellEnv 只放行 DSH_* 键，$PR_TOKEN 环境变量通道在本部署不可用）。
 * 约束：token 只用于 Authorization 头，不得写入 git 提交、records 或输出回显。
 */
export function buildPrPrompt(input: { wtPath: string; repo: string; title: string; description: string | null; branch: string; token: string }): string {
  return [
    '你是 PR 创建任务，只做一件事：把当前分支创建为 Pull Request，返回 JSON。',
    '',
    '# 工作根目录',
    input.wtPath,
    '',
    '# 步骤',
    `1. git -C ${input.wtPath} remote get-url origin → 取 host`,
    '2. 判断平台：host 含 "gitee.com" → Gitee；否则 → Gitea',
    '3. 解析 owner/repo：git@gitee.com:o/r.git 或 https://host/o/r.git → owner=o, repo=r',
    '4. 建 PR（凭证已直接给出，见下方 PR_TOKEN）：',
    '   Gitee: POST https://gitee.com/api/v5/repos/{owner}/{repo}/pulls',
    '   Gitea: POST https://<host>/api/v1/repos/{owner}/{repo}/pulls',
    '   header:  Authorization: token <PR_TOKEN 值，直接使用，不要写进任何 git/文件/输出>',
    `   body:    { "title": ${JSON.stringify(input.title)}, "head": ${JSON.stringify(input.branch)}, "base": "main", "body": ${JSON.stringify(input.description ?? '')} }`,
    '5. 返回 JSON（唯一契约）：',
    '   成功：{"is_ok":"true","pr_url":"<PR 链接>"}',
    '   失败：{"is_ok":"false","error":"<原因>"}',
    '',
    '注意：若遇到需要用户确认才能继续的不确定点（如目标分支、仓库归属），不要遇到一个问题问一个；',
    '先把所有不确定点攒齐、全部过一遍，确认没有其他问题要确认了，再一次性在 error 中完整列出。',
    '',
    '# PR_TOKEN',
    input.token,
  ].join('\n')
}

export interface WorktreeHandleLike {
  path: string
  branch: string
}

/**
 * 组装「解决冲突」任务的指导指令（merge 阶段的用户按钮触发）。
 *
 * 任务：把任务分支与远端 main 同步（fetch + merge）、解决合并冲突、commit +
 * push。需要用户决策时不中断——把所有不确定点攒齐，一次性放进结构化结果
 * questions 字段（与阶段通道一致：worker 落 waiting_reply + ask_user_questions，
 * 答完放行后携答复续跑，工作区未提交的冲突解决保留）。
 */
export function buildResolvePrompt(input: {
  wtPath: string
  repo: string
  branch: string
  title: string
  description: string | null
  userAnswers: { question: string; answer: string }[]
}): string {
  const lines: string[] = [
    '你是 FacAI 编码流水线的「冲突解决」任务执行者，只做一件事：把任务分支与远端 main 同步并解决合并冲突，返回 JSON。',
    '',
    '# 工作根目录',
    input.wtPath,
    '（所有 git/文件操作以此目录为 workdir/cwd；不要改动其他目录）',
    '',
    '# 背景',
    `任务分支：${input.branch}（本 worktree 当前所在分支）`,
    '目标分支：origin/main',
    `需求标题：${input.title}`,
    `需求描述：${input.description ?? '（无）'}`,
    '',
    '# 步骤',
    `1. git -C ${input.wtPath} fetch origin`,
    `2. git -C ${input.wtPath} merge origin/main`,
    '   - 无冲突：直接进入第 4 步。',
    '   - 有冲突：逐个文件解决。保留任务分支的实现意图，同时兼容远端 main 的改动；',
    '     不确定怎么合并的地方先记下来，不要中断（见下方「用户决策」）。',
    `3. git -C ${input.wtPath} add -A && git -C ${input.wtPath} commit -m "resolve merge conflicts with origin/main"`,
    `4. git -C ${input.wtPath} push`,
    '   - 若 push 被拒（远端有新提交）：git pull --rebase origin main 后重试 push。',
    '5. 返回 JSON（唯一契约）：',
    '   成功：{"isError":false,"message":"<一句话说明解决了什么>","artifacts":["<提交 hash>"],"questions":[]}',
    '   需要用户决策：{"isError":false,"message":"需要决策","artifacts":[],"questions":[{question, options}]}',
    '     （此时不要 commit；把已解决的冲突留在工作区，答复回来后继续）',
    '   失败：{"isError":true,"message":"<原因>","artifacts":[],"questions":[]}',
  ]
  if (input.userAnswers.length > 0) {
    lines.push('', '# 用户答复（续跑上下文）')
    for (const answer of input.userAnswers) lines.push(`Q: ${answer.question}  A: ${answer.answer}`)
  }
  lines.push(
    '',
    '# 用户决策（重要）',
    '本会话是流水线子代理：ask_user_question 工具在此不可用，调用会被拒绝（错误信息会提示你把问题放入最终结果）。',
    '当需要用户决策时：不要调用 ask_user_question；在最终结构化结果中返回 questions=[{question, options}]。',
    '流水线会自动把该 record 标记为 waiting_reply、把每题写入 ask_user_questions，并在审核大厅等你作答；',
    '全部答完并审核通过后，本任务会携你的答复自动续跑。',
    'options 为空数组表示自由输入；每题尽量给出 2-5 个选项。',
    '注意不要遇到一个问题问一个，遇到问题先攒下并继续推理，确认所有问题都过了一遍，没有其他问题要确认了再一起发。',
  )
  return lines.join('\n')
}

export interface PipelineWorktree {
  create(branch: string, base: string): Promise<WorktreeHandleLike>
  /** 计算分支对应 worktree 的绝对路径（续跑重建 handle 用）。 */
  pathFor(branch: string): string
  linkSharedTarget(handle: WorktreeHandleLike): void
  /** push 任务分支到远程（merge 阶段用）。 */
  push(handle: WorktreeHandleLike): Promise<void>
  /** 收尾：主 checkout 切到 main 并 pull（PR 已合并后同步本地 main）。 */
  pullMain(branch?: string): Promise<void>
  remove(handle: WorktreeHandleLike): Promise<void>
  /** 兜底提交：把 worktree 中未提交改动以一次 commit 落到任务分支（无改动 no-op）。 */
  commitAll(wtPath: string, message: string): Promise<boolean>
}

export interface PipelineDeps {
  pgmas: WriteSeam
  database: string
  requirements: RequirementsRepo
  projects: ProjectsRepo
  questions: QuestionsRepo
  reviews: ReviewsRepo
  executor: StageExecutor
  /** 读取项目 skill 的 SKILL.md 全文。 */
  readSkillMd: (repo: string, skill: string) => Promise<string>
  /**
   * 把技能集装进任务 worktree 的 `.agents/skills/`（仅补缺失项）。默认
   * no-op——项目经 facai-init 已有技能；配置了 skillsSource 时 worker 注入
   * 实现，让新项目开箱即用（决策 4 / P3）。
   */
  provisionSkills?: (wtPath: string) => Promise<void>
  /** 产物存在性校验：相对 worktree 根的一个相对路径是否真实存在（不存在返回 false）。 */
  artifactExists: (wtPath: string, relPath: string) => Promise<boolean>
  /** 每项目一个 worktree 管理器（create/link/remove）。 */
  worktreeFor: (project: Pick<ProjectView, 'id' | 'localPath'>) => PipelineWorktree
  /** 阶段失败最大重试次数（同 category）。 */
  maxRetries: number
  /** 某阶段（或 merge）的模型覆盖；无配置时返回 undefined（继承父 agent）。 */
  configFor: (category: string) => StageAgentOptions | undefined
  /**
   * 后台任务派发钩子（service 注入全局并发预算）；未提供则直接 fire-and-forget。
   * 冲突解决等用户触发的长任务经此排队执行（预算满时排队，槽位空出即跑）。
   */
  dispatchBackground?: (task: () => Promise<void>) => void
  /**
   * 阶段成功后兜底提交 worktree 未提交产物（facai-coding 等技能默认不 git commit，
   * 而 merge push 只推已提交内容——不提交则 PR 漏掉全部代码）。无改动时 no-op。
   */
  commitWorktree?: (project: Pick<ProjectView, 'id' | 'localPath'>, wtPath: string, message: string) => Promise<void>
}

const CLAIM_SQL = `
  update requirements r
  set status = 'in_progress', updated_at = now()
  where r.id = (
    select r2.id from requirements r2
    where r2.status = 'open' and r2.project_id is not null
    order by r2.created_at asc limit 1
    for update skip locked
  )
  returning r.id, r.project_id, r.title, r.description
`

/** `claim()` 的返回：一条已原子领取（open → in_progress）的需求。 */
export interface ClaimedRequirement {
  id: string
  projectId: string
  title: string
  description: string | null
}

/** 审核大厅轮询返回的一行「已到期需处理」的审核动作（含最新审核单字段）。 */
export interface ReviewActionRow {
  record_id: string
  requirement_id: string
  category: string
  branch_id: string | null
  review_kind: string
  review_status: string
  review_feedback: string | null
}

/** 缺口僵尸行：in_progress 需求停在 success 记录、未创建 merge（进程重启/崩溃残留）。 */
export interface GapRow {
  requirement_id: string
  branch_id: string | null
  last_category: string | null
}

/** 重试轮询返回的一行待重试的 failed record。 */
export interface RetryRow {
  record_id: string
  requirement_id: string
  category: string
  branch_id: string | null
}

/**
 * 判断一条 artifacts 条目是否应作为「相对文件路径」做存在性校验。
 * 产物的既有约定是「相对路径, commit…」——commit 描述（如
 * `edd5302 docs(decision): …` / `commit 05b3898 …`）含空白，跳过；
 * 只校验不含空白的相对路径条目。
 */
export function isPathArtifact(entry: string): boolean {
  const trimmed = (entry ?? '').trim()
  if (trimmed === '') return false
  if (/\s/.test(trimmed)) return false
  return !trimmed.startsWith('commit')
}

/**
 * 产物存在性校验：把声明为相对路径的 artifacts 逐一对照 worktree 真实文件系统，
 * 返回不存在的路径列表（空数组 = 全部真实存在）。防「幽灵产物」——会话声称
 * success 但产物根本没落盘（如旧进程曾出现的 `docs/plans/001.md` 幻影路径）。
 */
export async function missingArtifacts(
  wtPath: string,
  artifacts: string[],
  exists: (wtPath: string, relPath: string) => Promise<boolean>,
): Promise<string[]> {
  const missing: string[] = []
  for (const entry of artifacts ?? []) {
    if (!isPathArtifact(entry)) continue
    if (!(await exists(wtPath, entry))) missing.push(entry)
  }
  return missing
}

/** 组装阶段会话 prompt（00 §4.7 模板）。 */
export function buildPrompt(input: {
  stage: StageDef
  wtPath: string
  repo: string
  skillMd: string
  title: string
  description: string | null
  priorArtifacts: string[]
  userAnswers: { question: string; answer: string }[]
  feedback?: string
}): string {
  const lines: string[] = [
    `你是 FacAI 编码流水线的「${input.stage.category}」阶段执行者。`,
    '',
    `# 工作根目录`,
    input.wtPath,
    '（所有文件/git 操作以此目录为 workdir/cwd）',
    '',
    '# 项目规范',
    `阅读 ${input.repo}/.agents/AGENTS.md、${input.repo}/.agents/rules/*.md`,
    '',
    '# 技能指令',
    input.skillMd,
  ]
  if (input.stage.instruction !== undefined) {
    lines.push('', '# 阶段专属指令', input.stage.instruction)
  }
  lines.push(
    '',
    '# 用户决策（重要）',
    '本会话是流水线子代理：ask_user_question 工具在此不可用，调用会被拒绝（错误信息会提示你把问题放入最终结果）。',
    '当需要用户决策时：不要调用 ask_user_question；在最终结构化结果中返回 questions=[{question, options}]。',
    '流水线会自动把该 record 标记为 waiting_reply、把每题写入 ask_user_questions，并在审核大厅等你作答；',
    '全部答完并审核通过后，本阶段会携你的答复自动续跑。',
    'options 为空数组表示自由输入；每题尽量给出 2-5 个选项。',
    '注意不要遇到一个问题问一个，遇到问题先攒下并继续推理，确认所有问题都过了一遍，没有其他问题要确认了再一起发。',
  )
  if (input.feedback !== undefined && input.feedback.trim() !== '') {
    lines.push(
      '',
      '# 审核整改意见（驳回重跑）',
      `上一版产物未通过人工审核，以下整改意见必须逐条落实：`,
      input.feedback.trim(),
      '请基于已有产物修订（不要推翻需求），完成后照常返回结构化结果。',
    )
  }
  lines.push(
    '',
    '# 需求',
    `标题：${input.title}`,
    `描述：${input.description ?? '（无）'}`,
  )
  if (input.priorArtifacts.length > 0) {
    lines.push('', '# 前序产物（相对 worktree 根）', ...input.priorArtifacts.map(a => `- ${a}`))
  }
  if (input.userAnswers.length > 0) {
    lines.push('', '# 用户答复（续跑上下文）')
    for (const answer of input.userAnswers) lines.push(`Q: ${answer.question}  A: ${answer.answer}`)
  }
  lines.push(
    '',
    '# 返回要求',
    '完成后以结构化结果返回（字段见 outputSchema）：',
    '- 成功：isError=false，artifacts=[产物相对路径, commit…]',
    '- 需要用户决策：questions=[{question, options}]',
    '- 失败：isError=true，message=原因',
  )
  return lines.join('\n')
}

/** 解析阶段会话结构化输出；非法结构视为阶段失败。 */
export function parseStageResult(value: unknown): StageResult | null {
  if (value === null || typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  const questions = Array.isArray(v.questions)
    ? v.questions.map(q => {
        const item = q as Record<string, unknown>
        return {
          question: typeof item.question === 'string' ? item.question : '',
          options: Array.isArray(item.options) ? item.options.map(o => String(o)) : [],
        }
      })
    : []
  return {
    isError: v.isError === true,
    message: typeof v.message === 'string' ? v.message : '',
    artifacts: Array.isArray(v.artifacts) ? v.artifacts.map(a => String(a)) : [],
    questions,
  }
}

/**
 * Claim → stage chain → ledger. One instance per worker service. 领取/派发查询
 * （claim / listActionableReviews / listRetryable）由 tick 串行调用；续跑/重试
 * （runClaimed / processReviewAction / processRetryRow）可并行执行——DB 侧靠
 * 状态机（open 领取原子、waiting 记录一旦续跑即离开挂起态）保证不重复处理。
 */
export class WorkerPipeline {
  constructor(private readonly deps: PipelineDeps) {}

  /** ①a 领取一条 open 需求（原子：for update skip locked，open → in_progress）。 */
  async claim(): Promise<ClaimedRequirement | undefined> {
    const row = await this.deps.pgmas.withClient(this.deps.database, client => client.query(CLAIM_SQL))
    const claim = row.rows[0] as { id: string; project_id: string; title: string; description: string | null } | undefined
    if (claim === undefined) return undefined
    return {
      id: claim.id,
      projectId: claim.project_id,
      title: claim.title,
      description: claim.description,
    }
  }

  /** ①b 跑一条已领取的需求（建 worktree + 阶段链）。 */
  async runClaimed(claim: ClaimedRequirement): Promise<boolean> {
    const project = await this.deps.projects.getById(claim.projectId)
    if (project === undefined) {
      throw new Error(`领取的需求 ${claim.id} 关联的项目不存在`)
    }
    const wt = this.deps.worktreeFor(project)
    const handle = await wt.create(`req-${claim.id.slice(0, 8)}`, 'origin/main')
    wt.linkSharedTarget(handle)
    // 决策 4（P3）：把 skillsSource 提供的技能集补进 worktree（缺啥补啥），
    // 阶段会话的 .agents/skills/ 因此开箱可用，无需先跑 facai-init。
    if (this.deps.provisionSkills !== undefined) {
      try {
        await this.deps.provisionSkills(handle.path)
      } catch (error) {
        console.warn(`[cm-worker] skills 预装失败（继续）: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    // 阶段记账由 runPipeline/runStage 统一负责（首条 decision 在其中 append）
    await this.runPipeline({
      id: claim.id,
      title: claim.title,
      description: claim.description,
      project,
      wt: handle,
    })
    return true
  }

  /** ① 领取一条 open 需求并跑阶段链。返回是否领到并开始处理。 */
  async claimAndRun(): Promise<boolean> {
    const claim = await this.claim()
    if (claim === undefined) return false
    return this.runClaimed(claim)
  }

  /**
   * 阶段链：按 STAGES 顺序推进；waiting/failed/terminated 时停止。
   * `resume` 从挂起阶段复用 record 续跑；`from` 从某阶段新 append record 开始（重试后继续）。
   */
  async runPipeline(
    input: {
      id: string
      title: string
      description: string | null
      project: ProjectView
      wt: WorktreeHandleLike
    },
    opts?: {
      resume?: { recordId: string; category: string; userAnswers: { question: string; answer: string }[] }
      from?: { category: string }
    },
  ): Promise<'success' | 'waiting' | 'failed' | 'terminated'> {
    const resume = opts?.resume
    const from = opts?.from
    const startIndex = resume !== undefined
      ? STAGES.findIndex(s => s.category === resume.category)
      : from !== undefined
        ? STAGES.findIndex(s => s.category === from.category)
        : 0
    if ((resume !== undefined || from !== undefined) && startIndex < 0) {
      throw new Error(`续跑失败：未知阶段 ${resume?.category ?? from?.category}`)
    }
    for (let i = startIndex; i < STAGES.length; i++) {
      const stage = STAGES[i]!
      const stageOpts = resume !== undefined && i === startIndex
        ? { recordId: resume.recordId, userAnswers: resume.userAnswers }
        : undefined
      const outcome = await this.runStage(input, stage, stageOpts)
      if (outcome === 'waiting' || outcome === 'failed' || outcome === 'terminated') return outcome
    }
    // 全部阶段成功 → merge 阶段（push + PR agent 任务）
    return this.runMerge(input)
  }

  /** 单阶段：prompt → 会话 → 结构化结果 → 记账。带 recordId 时为续跑（复用该 record）。 */
  async runStage(
    requirement: { id: string; title: string; description: string | null; project: ProjectView; wt: WorktreeHandleLike },
    stage: StageDef,
    opts?: { recordId?: string; userAnswers?: { question: string; answer: string }[]; retry?: boolean; feedback?: string },
  ): Promise<'success' | 'waiting' | 'failed' | 'terminated'> {
    const recordId = opts?.recordId
    const userAnswers = opts?.userAnswers ?? []
    const feedback = opts?.feedback
    // 终止检查：需求已终止（不可逆）→ 当前 record 也标记终止并停止。
    const current = await this.deps.requirements.getById(requirement.id)
    if (current !== undefined && current.status === 'terminated') {
      if (recordId !== undefined) {
        await this.deps.requirements.updateRecord(recordId, { status: 'terminated', result: '需求已终止，阶段不再执行' })
      } else {
        await this.deps.requirements.appendRecord({
          requirementId: requirement.id,
          category: stage.category,
          status: 'terminated',
          branchId: requirement.wt.branch,
          skills: [stage.skill],
          result: '需求已终止，阶段不再执行',
        })
      }
      return 'terminated'
    }
    // 重试复用原 record：标记「重试中」并 retry_count+1，绝不新开 record。
    const record = recordId === undefined
      ? await this.deps.requirements.appendRecord({
        requirementId: requirement.id,
        category: stage.category,
        status: 'running',
        branchId: requirement.wt.branch,
        skills: [stage.skill],
      })
      : opts?.retry === true
        ? await this.deps.requirements.markRetrying(recordId)
        : await this.deps.requirements.updateRecord(recordId, { status: 'running' })

    let skillMd: string
    try {
      skillMd = await this.deps.readSkillMd(requirement.project.localPath, stage.skill)
    } catch {
      await this.deps.requirements.updateRecord(record.id, {
        status: 'failed',
        result: `技能 ${stage.skill} 不存在：${requirement.project.localPath}/.agents/skills/${stage.skill}/SKILL.md（项目需先跑 facai-init）`,
      })
      return 'failed'
    }

    const prior = await this.priorArtifacts(requirement.id)
    const prompt = buildPrompt({
      stage,
      wtPath: requirement.wt.path,
      repo: requirement.project.localPath,
      skillMd,
      title: requirement.title,
      description: requirement.description,
      priorArtifacts: prior,
      userAnswers,
      feedback,
    })

    let execution: StageExecution
    try {
      execution = await this.deps.executor.run({
        category: stage.category,
        skill: stage.skill,
        wtPath: requirement.wt.path,
        repo: requirement.project.localPath,
        title: requirement.title,
        description: requirement.description,
        priorArtifacts: prior,
        userAnswers,
        feedback,
        prompt,
      }, this.deps.configFor(stage.category))
    } catch (error) {
      await this.deps.requirements.updateRecord(record.id, {
        status: 'failed',
        result: `会话执行异常：${error instanceof Error ? error.message : String(error)}`,
      })
      return 'failed'
    }

    if (execution.stopReason !== 'completed') {
      await this.deps.requirements.updateRecord(record.id, {
        status: 'failed',
        result: `会话未完成（stopReason=${execution.stopReason}）`,
      })
      return 'failed'
    }
    const result = parseStageResult(execution.structured)
    if (result === null) {
      await this.deps.requirements.updateRecord(record.id, {
        status: 'failed',
        result: '会话未返回合法的结构化结果',
      })
      return 'failed'
    }

    if (result.questions.length > 0) {
      // 挂起：等用户作答（审核大厅答题 + 审核通过后续跑）
      await this.deps.questions.insertMany(record.id, result.questions)
      await this.deps.reviews.ensureReply(record.id)
      await this.deps.requirements.updateRecord(record.id, {
        status: 'waiting_reply',
        result: 'awaiting user reply',
      })
      return 'waiting'
    }
    if (result.isError) {
      await this.deps.requirements.updateRecord(record.id, {
        status: 'failed',
        result: result.message || '阶段报告失败',
      })
      return 'failed'
    }

    // 产物存在性校验（纯工程侧，零额外模型调用）：声明为相对路径的 artifacts
    // 必须在 worktree 中真实存在；缺失 → 判失败（可被 retryFailed 重试），
    // 幽灵产物/未落盘产物不会进入审核门。
    const missing = await missingArtifacts(requirement.wt.path, result.artifacts, this.deps.artifactExists)
    if (missing.length > 0) {
      await this.deps.requirements.updateRecord(record.id, {
        status: 'failed',
        result: `产物校验失败：以下声明产物在 worktree 中不存在：${missing.join('、')}（会话可能未真正产出/未提交，等待自动重试或人工介入）`,
      })
      return 'failed'
    }

    // 兜底提交：把本阶段留下的未提交产物落到任务分支（技能层默认不 commit；
    // 无改动则 no-op）。提交失败不阻断阶段成功（下一进程/人工可补）。
    if (this.deps.commitWorktree !== undefined) {
      try {
        await this.deps.commitWorktree(
          { id: requirement.project.id, localPath: requirement.project.localPath },
          requirement.wt.path,
          `${stage.category}(pipeline): 阶段产物提交 (req-${requirement.id.slice(0, 8)})`,
        )
      } catch (error) {
        console.warn(`[cm-worker] 阶段 ${stage.category} 兜底提交失败（不阻断）: ${error instanceof Error ? error.message : String(error)}`)
      }
    }

    // 立即人工审核门（ADR 等）：阶段成功后先挂人审，通过后才进入下一阶段。
    if ((REVIEW_GATED as readonly string[]).includes(stage.category)) {
      await this.deps.requirements.updateRecord(record.id, {
        status: 'waiting_review',
        result: result.message || 'ok',
        artifacts: result.artifacts,
      })
      await this.deps.reviews.create(record.id, 'review')
      return 'waiting'
    }
    // 延后人审门：机审阶段（如 review-plan）成功后，把被审产物阶段的 record
    // 挂人审门（先机审、后人审）。本阶段自身先落 success。
    await this.deps.requirements.updateRecord(record.id, {
      status: 'success',
      result: result.message || 'ok',
      artifacts: result.artifacts,
    })
    const deferred = DEFERRED_REVIEW_GATES.find(gate => gate.anchor === stage.category)
    if (deferred !== undefined) {
      const target = await this.deps.requirements.latestRecordByCategory(requirement.id, deferred.category)
      if (target !== undefined) {
        await this.deps.requirements.updateRecord(target.id, { status: 'waiting_review' })
        await this.deps.reviews.create(target.id, 'review')
        return 'waiting'
      }
    }
    return 'success'
  }

  /**
   * merge 阶段：push 分支 → PR agent 任务 → `markMerging`（in_progress→merging，
   * 记 merge record artifacts=[pr_url]）。无 token / 建 PR 失败 → 挂起
   * waiting_reply（用户补 token 或手动建 PR 后点「已合并」）。
   */
  async runMerge(
    requirement: { id: string; title: string; description: string | null; project: ProjectView; wt: WorktreeHandleLike },
    opts?: { recordId?: string },
  ): Promise<'success' | 'waiting' | 'failed' | 'terminated'> {
    const recordId = opts?.recordId
    // 终止检查：需求已终止（不可逆）→ merge record 也标记终止并停止。
    const current = await this.deps.requirements.getById(requirement.id)
    if (current !== undefined && current.status === 'terminated') {
      if (recordId !== undefined) {
        await this.deps.requirements.updateRecord(recordId, { status: 'terminated', result: '需求已终止，阶段不再执行' })
      } else {
        await this.deps.requirements.appendRecord({
          requirementId: requirement.id,
          category: 'merge',
          status: 'terminated',
          branchId: requirement.wt.branch,
          skills: [],
          result: '需求已终止，阶段不再执行',
        })
      }
      return 'terminated'
    }
    const record = recordId === undefined
      ? await this.deps.requirements.appendRecord({
        requirementId: requirement.id,
        category: 'merge',
        status: 'running',
        branchId: requirement.wt.branch,
        skills: [],
      })
      : await this.deps.requirements.updateRecord(recordId, { status: 'running' })

    await this.deps.worktreeFor(requirement.project).push(requirement.wt)

    const token = await this.deps.projects.getToken(requirement.project.id)
    if (token === undefined) {
      await this.deps.questions.insertMany(record.id, [{
        question: 'PR token 未配置。请到面板项目管理填入 Gitee/Gitea access token；或手动建 PR 后点「已合并」。',
        options: [],
      }])
      await this.deps.reviews.ensureReply(record.id)
      await this.deps.requirements.updateRecord(record.id, { status: 'waiting_reply', result: 'awaiting pr token' })
      return 'waiting'
    }

    const prompt = buildPrPrompt({
      wtPath: requirement.wt.path,
      repo: requirement.project.localPath,
      title: requirement.title,
      description: requirement.description,
      branch: requirement.wt.branch,
      token,
    })
    let pr: PrExecution
    try {
      pr = await this.deps.executor.runPr({
        prompt,
        repo: requirement.project.localPath,
        wtPath: requirement.wt.path,
      }, this.deps.configFor('merge'))
    } catch (error) {
      pr = { isOk: false, error: error instanceof Error ? error.message : String(error) }
    }
    if (pr.isOk && pr.prUrl !== undefined) {
      await this.deps.requirements.updateRecord(record.id, { status: 'success', result: 'PR created', artifacts: [pr.prUrl] })
      await this.deps.requirements.markMerging(requirement.id, pr.prUrl)
      return 'success'
    }

    await this.deps.questions.insertMany(record.id, [{
      question: `建 PR 失败：${pr.error ?? '未知原因'}。可补 token 后重试，或手动建 PR 后点「已合并」。`,
      options: [],
    }])
    await this.deps.reviews.ensureReply(record.id)
    await this.deps.requirements.updateRecord(record.id, { status: 'waiting_reply', result: 'pr creation failed' })
    return 'waiting'
  }

  /**
   * 「解决冲突」任务（merge 阶段的用户按钮触发）：把任务分支与远端 main 同步
   * （fetch + merge）、解决合并冲突、commit + push。需要用户决策时不中断——
   * 一次性把问题放进结构化结果 questions → 挂 waiting_reply + ask_user_questions
   * + reply 放行单；答完 + 审核通过后由 processReviews 携答复续跑（复用同一
   * record，工作区已解决的冲突保留）。
   */
  async runResolve(
    requirement: { id: string; title: string; description: string | null; project: ProjectView; wt: WorktreeHandleLike },
    opts?: { recordId?: string; userAnswers?: { question: string; answer: string }[] },
  ): Promise<'success' | 'waiting' | 'failed'> {
    const recordId = opts?.recordId
    const userAnswers = opts?.userAnswers ?? []
    const record = recordId === undefined
      ? await this.deps.requirements.appendRecord({
        requirementId: requirement.id,
        category: 'resolve',
        status: 'running',
        branchId: requirement.wt.branch,
        skills: [],
      })
      : await this.deps.requirements.updateRecord(recordId, { status: 'running' })

    const prompt = buildResolvePrompt({
      wtPath: requirement.wt.path,
      repo: requirement.project.localPath,
      branch: requirement.wt.branch,
      title: requirement.title,
      description: requirement.description,
      userAnswers,
    })

    let execution: StageExecution
    try {
      execution = await this.deps.executor.run({
        category: 'resolve',
        skill: '',
        wtPath: requirement.wt.path,
        repo: requirement.project.localPath,
        title: requirement.title,
        description: requirement.description,
        priorArtifacts: [],
        userAnswers,
        prompt,
      }, this.deps.configFor('resolve'))
    } catch (error) {
      await this.deps.requirements.updateRecord(record.id, {
        status: 'failed',
        result: `会话执行异常：${error instanceof Error ? error.message : String(error)}`,
      })
      return 'failed'
    }

    if (execution.stopReason !== 'completed') {
      await this.deps.requirements.updateRecord(record.id, {
        status: 'failed',
        result: `会话未完成（stopReason=${execution.stopReason}）`,
      })
      return 'failed'
    }
    const result = parseStageResult(execution.structured)
    if (result === null) {
      await this.deps.requirements.updateRecord(record.id, {
        status: 'failed',
        result: '会话未返回合法的结构化结果',
      })
      return 'failed'
    }

    if (result.questions.length > 0) {
      // 挂起：等用户作答（审核大厅答题 + 审核通过后续跑）
      await this.deps.questions.insertMany(record.id, result.questions)
      await this.deps.reviews.ensureReply(record.id)
      await this.deps.requirements.updateRecord(record.id, {
        status: 'waiting_reply',
        result: 'awaiting user reply',
      })
      return 'waiting'
    }
    if (result.isError) {
      await this.deps.requirements.updateRecord(record.id, {
        status: 'failed',
        result: result.message || '冲突解决失败',
      })
      return 'failed'
    }

    await this.deps.requirements.updateRecord(record.id, {
      status: 'success',
      result: result.message || 'ok',
      artifacts: result.artifacts,
    })
    return 'success'
  }

  /**
   * 「解决冲突」入口（审核大厅按钮 → merge Typert remote）：校验需求处于
   * `merging` → 幂等（已有 running/waiting_reply 的 resolve record 则直接返回，
   * 不重复起跑）→ 落 running record → 后台执行。返回 resolve record 列表项。
   *
   * 幂等检查与插入在同一事务内、以需求行锁（for update）串行化：并发双击/多
   * 标签页不会在同一任务分支上起跑两条 resolve 会话（会互踩 git 状态）。
   */
  async startResolve(requirementId: string): Promise<RecordListItem> {
    const requirement = await this.deps.requirements.getById(requirementId)
    if (requirement === undefined) throw new Error('需求不存在或已删除')
    if (requirement.status !== 'merging') throw new Error('只有「待合并」状态的需求可以解决冲突')
    if (requirement.projectId === null) throw new Error('需求未关联项目，无法解决冲突')
    const project = await this.deps.projects.getById(requirement.projectId)
    if (project === undefined) throw new Error('需求关联的项目不存在')
    const branch = await this.resolveBranch(requirementId)

    // started=true 表示本次真正插入并起跑；false 表示幂等命中（复用已有会话，不起跑）。
    const { recordId, started } = await this.deps.pgmas.withClient(this.deps.database, async client => {
      await client.query('begin')
      try {
        // 需求行锁：同一需求的并发 startResolve 串行化（后续调用看到已插入的 record → 幂等返回）。
        await client.query('select id from requirements where id = $1 for update', [requirementId])
        const existing = await client.query(`
          select id from records
          where requirement_id = $1 and category = 'resolve'
            and status in ('running', 'waiting_reply')
          order by created_at desc, id desc
          limit 1
        `, [requirementId])
        const existingRow = (existing.rows as { id: string }[])[0]
        if (existingRow !== undefined) {
          await client.query('commit')
          return { recordId: String(existingRow.id), started: false }
        }
        const inserted = await client.query(`
          insert into records (id, requirement_id, branch_id, category, title, status, result, artifacts, skills, parent_id, retry_count, created_at, updated_at)
          values (gen_random_uuid(), $1, $2, 'resolve', 'resolve', 'running', null, $3, $4, null, 0, now(), now())
          returning id
        `, [requirementId, branch, [], []])
        await client.query('commit')
        return { recordId: String((inserted.rows as { id: string }[])[0]!.id), started: true }
      } catch (error) {
        await client.query('rollback')
        throw error
      }
    })

    if (started) {
      const wt = { path: this.deps.worktreeFor(project).pathFor(branch), branch }
      const task = () => this.runResolveInBackground(requirement, project, wt, recordId)
      if (this.deps.dispatchBackground !== undefined) {
        this.deps.dispatchBackground(task)
      } else {
        void task()
      }
    }
    return this.deps.requirements.getRecordListItem(recordId)
  }

  /** 后台执行 resolve（前台 RPC 只负责起跑，不在调用里阻塞数分钟）。 */
  private async runResolveInBackground(
    requirement: { id: string; title: string; description: string | null },
    project: ProjectView,
    wt: WorktreeHandleLike,
    recordId: string,
  ): Promise<void> {
    try {
      await this.runResolve({ id: requirement.id, title: requirement.title, description: requirement.description, project, wt }, { recordId })
    } catch (error) {
      await this.deps.requirements.updateRecord(recordId, {
        status: 'failed',
        result: `冲突解决异常：${error instanceof Error ? error.message : String(error)}`,
      }).catch(() => {})
    }
  }

  /** 该需求最早带 branch 的 record 的分支名（合并/续跑同一分支）；无则按约定生成。 */
  private async resolveBranch(requirementId: string): Promise<string> {
    const rows = await this.deps.pgmas.withClient(this.deps.database, client =>
      client.query(`
        select branch_id from records
        where requirement_id = $1 and branch_id is not null
        order by created_at asc, id asc
        limit 1
      `, [requirementId]))
    const row = (rows.rows as { branch_id: string | null }[])[0]
    return row?.branch_id ?? `req-${requirementId.slice(0, 8)}`
  }

  /**
   * ② 审核大厅轮询：处理所有挂起记录的审核单（每 tick 一次）。
   *   a. 补单：waiting_reply 无 pending reply 单 → 补一张（旧数据兼容）。
   *   b. 人工审核门通过（waiting_review + 最新 review 单 approved）→ record 置
   *      success，并从下一阶段继续。
   *   c. 待决策放行（waiting_reply + 最新 reply 单 approved + 全部作答）→ 复用
   *      record 携答复续跑（merge 阶段重跑 runMerge）。
   *   d. 驳回（最新审核单 rejected，waiting_review 或 waiting_reply）→ 复用原
   *      record 携整改意见重跑同阶段。
   *
   * 串行版：逐条处理到完成（测试与纯同步场景用）。服务端并发派发请用
   * ensureReplyTickets + listActionableReviews + processReviewAction 组合，
   * 多个已放行的记录可并行续跑（受服务端全局并发预算约束，见 cm-worker/index.ts）。
   */
  async processReviews(): Promise<void> {
    await this.ensureReplyTickets()
    for (const row of await this.listActionableReviews()) {
      await this.processReviewAction(row)
    }
  }

  /**
   * a. 补 reply 单：仅为「完全没有 reply 单」的旧 waiting_reply 数据补一张；
   *    已 approved/rejected 的最新单保持现状（重跑后再提问由 runStage 的
   *    ensureReply 补新 pending 单）。
   */
  async ensureReplyTickets(): Promise<void> {
    const missing = await this.deps.pgmas.withClient(this.deps.database, client =>
      client.query(`
        select r.id as record_id from records r
        where r.status = 'waiting_reply'
          and not exists (
            select 1 from reviews v
            where v.record_id = r.id and v.kind = 'reply'
          )
        limit 20
      `))
    for (const row of missing.rows as { record_id: string }[]) {
      await this.deps.reviews.ensureReply(row.record_id)
    }
  }

  /**
   * b/c/d. 挂起记录 + 各自最新审核单（一次 join 取齐）；仅返回已到期的
   * approved/rejected 行（pending 行本轮不动，等审核大厅决定）。
   */
  async listActionableReviews(limit = 20): Promise<ReviewActionRow[]> {
    const rows = await this.deps.pgmas.withClient(this.deps.database, client =>
      client.query(`
        select r.id as record_id, r.requirement_id, r.category, r.branch_id,
               v.kind as review_kind, v.status as review_status, v.feedback as review_feedback
        from records r
        join reviews v on v.id = (
          select v2.id from reviews v2 where v2.record_id = r.id
          order by v2.created_at desc, v2.id desc limit 1
        )
        where r.status in ('waiting_review', 'waiting_reply')
          and v.status in ('approved', 'rejected')
        order by r.updated_at asc
        limit $1
      `, [limit]))
    return rows.rows as ReviewActionRow[]
  }

  /** 处理一条已到期的审核动作：驳回重跑 / 审核门通过续跑 / reply 放行续跑。 */
  async processReviewAction(row: ReviewActionRow): Promise<void> {
    if (row.review_status === 'rejected') {
      await this.rerunWithFeedback(row, row.review_feedback)
    } else if (row.review_kind === 'review') {
      await this.continueAfterGate(row)
    } else {
      await this.resumeRepliedRecord(row)
    }
  }

  /** b. 人工审核门通过：record → success，从审核门锚点的下一阶段（或 merge）继续。 */
  private async continueAfterGate(row: {
    record_id: string
    requirement_id: string
    category: string
    branch_id: string | null
  }): Promise<void> {
    const requirement = await this.deps.requirements.getById(row.requirement_id)
    if (requirement === undefined || requirement.status !== 'in_progress') return
    if (requirement.projectId === null) return
    const project = await this.deps.projects.getById(requirement.projectId)
    if (project === undefined) return
    await this.deps.requirements.updateRecord(row.record_id, { status: 'success' })
    const stageIndex = STAGES.findIndex(s => s.category === row.category)
    if (stageIndex < 0) return
    // 延后门（plan）：锚点 = 机审阶段（review-plan），从其下一阶段继续；
    // 立即门（decision）：从本阶段下一阶段继续。
    const deferred = DEFERRED_REVIEW_GATES.find(gate => gate.category === row.category)
    const anchorIndex = deferred !== undefined
      ? STAGES.findIndex(s => s.category === deferred.anchor)
      : stageIndex
    const wt = this.deps.worktreeFor(project)
    const branch = row.branch_id ?? `req-${requirement.id.slice(0, 8)}`
    const handle = { path: wt.pathFor(branch), branch }
    const input = {
      id: requirement.id,
      title: requirement.title,
      description: requirement.description,
      project,
      wt: handle,
    }
    const nextIndex = anchorIndex + 1
    if (nextIndex >= STAGES.length) {
      // 门禁阶段是最后一个 → 直接 merge
      await this.runMerge(input)
      return
    }
    await this.runPipeline(input, { from: { category: STAGES[nextIndex]!.category } })
  }

  /** c. 待决策放行：全部作答 + reply 单 approved → 复用 record 续跑。 */
  private async resumeRepliedRecord(row: {
    record_id: string
    requirement_id: string
    category: string
    branch_id: string | null
  }): Promise<void> {
    const requirement = await this.deps.requirements.getById(row.requirement_id)
    if (requirement === undefined) return
    // resolve（冲突解决）挂起时需求停留在 merging；其余（阶段/merge）挂起时需求为 in_progress。
    const expectedStatus = row.category === 'resolve' ? 'merging' : 'in_progress'
    if (requirement.status !== expectedStatus) return
    if (requirement.projectId === null) return
    const project = await this.deps.projects.getById(requirement.projectId)
    if (project === undefined) return
    // 必须全部作答才放行（与审核大厅「答完才能通过」一致）
    const pending = await this.deps.questions.pendingByRecord(row.record_id)
    if (pending.length > 0) return
    const answers = (await this.deps.questions.listByRecord(row.record_id))
      .filter(question => question.status === 'answered')
      .map(question => ({ question: question.question, answer: question.answer ?? '' }))
    const wt = this.deps.worktreeFor(project)
    const branch = row.branch_id ?? `req-${requirement.id.slice(0, 8)}`
    const handle = { path: wt.pathFor(branch), branch }
    const input = {
      id: requirement.id,
      title: requirement.title,
      description: requirement.description,
      project,
      wt: handle,
    }
    if (row.category === 'merge') {
      // merge 挂起（无 token / 建 PR 失败）→ 复用 record 重跑 runMerge
      await this.runMerge(input, { recordId: row.record_id })
      return
    }
    if (row.category === 'resolve') {
      // 冲突解决挂起（等用户决策）→ 复用 record 携答复续跑 runResolve
      await this.runResolve(input, { recordId: row.record_id, userAnswers: answers })
      return
    }
    await this.runPipeline(
      input,
      { resume: { recordId: row.record_id, category: row.category, userAnswers: answers } },
    )
  }

  /** d. 驳回（带整改意见）→ 复用原 record 携反馈重跑同阶段。 */
  private async rerunWithFeedback(row: {
    record_id: string
    requirement_id: string
    category: string
    branch_id: string | null
  }, feedback: string | null): Promise<void> {
    const requirement = await this.deps.requirements.getById(row.requirement_id)
    // resolve（冲突解决）挂起时需求停留在 merging；其余为 in_progress。
    const expectedStatus = row.category === 'resolve' ? 'merging' : 'in_progress'
    if (requirement === undefined || requirement.status !== expectedStatus) return
    if (requirement.projectId === null) return
    const project = await this.deps.projects.getById(requirement.projectId)
    if (project === undefined) return
    const wt = this.deps.worktreeFor(project)
    const branch = row.branch_id ?? `req-${requirement.id.slice(0, 8)}`
    const handle = { path: wt.pathFor(branch), branch }
    const input = {
      id: requirement.id,
      title: requirement.title,
      description: requirement.description,
      project,
      wt: handle,
    }
    if (row.category === 'merge') {
      // merge 被驳回（当前 UI 不提供该路径）→ 复用 record 重跑 runMerge
      await this.runMerge(input, { recordId: row.record_id })
      return
    }
    if (row.category === 'resolve') {
      // resolve 被驳回（当前 UI 不提供该路径）→ 复用 record 重跑 runResolve
      await this.runResolve(input, { recordId: row.record_id })
      return
    }
    const stage = STAGES.find(s => s.category === row.category)
    if (stage === undefined) return
    const answers = (await this.deps.questions.listByRecord(row.record_id))
      .filter(question => question.status === 'answered')
      .map(question => ({ question: question.question, answer: question.answer ?? '' }))
    const outcome = await this.runStage(input, stage, {
      recordId: row.record_id,
      retry: true,
      feedback: feedback ?? undefined,
      userAnswers: answers,
    })
    // 延后门（plan）被驳回：plan 携反馈重跑成功后，重新走机审（review-plan）→ 再次挂人审门。
    const deferred = DEFERRED_REVIEW_GATES.find(gate => gate.category === row.category)
    if (deferred !== undefined && outcome === 'success') {
      await this.runPipeline(input, { from: { category: deferred.anchor } })
    }
  }

  /**
   * ③ 重试：复用原 record（不新开），标记「重试中」并 retry_count+1，重跑同阶段。
   * 每阶段重试次数 ≤ maxRetries（默认 10）；超限不再重试——需求停留在
   * in_progress、record 保持 failed，由面板/用户介入（不再回 open 死循环）。
   *
   * 串行版：逐条重试到完成（测试用）。服务端并发派发请用 listRetryable +
   * processRetryRow 组合（受全局并发预算约束）。
   */
  async retryFailed(): Promise<void> {
    for (const row of await this.listRetryable()) {
      await this.processRetryRow(row)
    }
  }

  /** ③a 待重试的 failed record 列表（retry_count < maxRetries，需求仍 in_progress）。 */
  async listRetryable(limit = 10): Promise<RetryRow[]> {
    const rows = await this.deps.pgmas.withClient(this.deps.database, client =>
      client.query(`
        select r.id as record_id, r.requirement_id, r.category, r.branch_id
        from records r
        where r.status = 'failed'
          and r.retry_count < $1
          and exists (
            select 1 from requirements req
            where req.id::text = r.requirement_id and req.status = 'in_progress'
          )
        order by r.updated_at asc
        limit $2
      `, [this.deps.maxRetries, limit]))
    return rows.rows as RetryRow[]
  }

  /** ③b 重试一条 failed record（复用原 record）。 */
  async processRetryRow(row: RetryRow): Promise<void> {
    await this.retryRecord(row)
  }

  private async retryRecord(row: { record_id: string; requirement_id: string; category: string; branch_id: string | null }): Promise<void> {
    const requirement = await this.deps.requirements.getById(row.requirement_id)
    if (requirement === undefined || requirement.status !== 'in_progress') return
    if (requirement.projectId === null) return
    const project = await this.deps.projects.getById(requirement.projectId)
    if (project === undefined) return
    const stage = STAGES.find(s => s.category === row.category)
    if (stage === undefined) return
    const wt = this.deps.worktreeFor(project)
    const branch = row.branch_id ?? `req-${requirement.id.slice(0, 8)}`
    const handle = { path: wt.pathFor(branch), branch }
    const input = {
      id: requirement.id,
      title: requirement.title,
      description: requirement.description,
      project,
      wt: handle,
    }
    // 复用原 record 重跑：markRetrying 置「重试中」并计数；成功后从下一阶段继续。
    const outcome = await this.runStage(input, stage, { recordId: row.record_id, retry: true })
    if (outcome === 'success') {
      const nextIndex = STAGES.findIndex(s => s.category === stage.category) + 1
      if (nextIndex < STAGES.length) {
        await this.runPipeline(input, { from: { category: STAGES[nextIndex]!.category } })
      }
    }
  }

  /**
   * ④ 收尾：用户点「已合并」→ confirmMerged（02）→ requirement done；
   * 此处对 done 且尚未清理（无 cleanup record）的需求先把主 checkout 的 main
   * 同步到远端（git pull，PR 已合并后本地 main 拿到合并提交），再清理 worktree
   * + 分支，并记一条 cleanup record 保证幂等。pull 失败不记 cleanup → 需求
   * 保持待清理，下轮 tick 重试，直到 main 同步成功（每次点「已合并」都 pull）。
   */
  async finalizeMerged(): Promise<void> {
    const rows = await this.deps.pgmas.withClient(this.deps.database, client =>
      client.query(`
        select r.id, r.project_id,
               (select rc.branch_id from records rc
                where rc.requirement_id = r.id::text and rc.branch_id is not null
                order by rc.created_at asc limit 1) as branch_id
        from requirements r
        where r.status = 'done'
          and not exists (
            select 1 from records rc2
            where rc2.requirement_id = r.id::text and rc2.category = 'cleanup' and rc2.status = 'success'
          )
        order by r.updated_at asc
        limit 10
      `))
    for (const row of rows.rows as { id: string; project_id: string; branch_id: string | null }[]) {
      if (row.branch_id === null || row.branch_id === '') continue
      const project = await this.deps.projects.getById(row.project_id)
      if (project === undefined) continue
      const wt = this.deps.worktreeFor(project)
      const handle = { path: wt.pathFor(row.branch_id), branch: row.branch_id }
      // 主 checkout 同步 main（pull）。失败向上抛：本需求未记 cleanup，
      // 下轮 tick 重试，直到 pull 成功（保证「每次点已合并后都 pull」）。
      await wt.pullMain()
      try {
        await wt.remove(handle)
      } catch {
        // worktree/分支可能已被手动清理；跳过
      }
      await this.deps.requirements.appendRecord({
        requirementId: row.id,
        category: 'cleanup',
        status: 'success',
        branchId: row.branch_id,
        result: 'worktree removed',
        skills: [],
      })
    }
  }

  /**
   * ⑤ 启动自愈（进程重启后一次性执行）：把上一进程遗留的死状态拉回可推进轨道。
   *
   * 背景（2026-08-16 实测）：进程若死在「某阶段 success 记账之后、下一阶段/merge
   * 记账之前」（如 review-code success 后、merge record 创建前），需求会停在
   * in_progress、最新 record 为 success、无任何 running/waiting/failed 记录——
   * 而 claim / 审核续跑 / 重试 / 收尾四条路径都看不见它 → 永久「执行中」僵尸。
   * 另有进程重启后残留的 running record（旧会话必死）同样无人收尸。
   *
   * a. markStaleRunning：把全部 status='running' 的 record 标记 failed
   *    （'进程重启，中断的会话已失效'）——重启后旧会话必死，交给 retryFailed
   *    复用同一 record 续跑（同分支/worktree，不新开 record）。
   * b. listStuckGaps：找出 in_progress 且「最新 record = 阶段 success、无任何
   *    running/waiting/failed 记录、且从未创建 merge record」的需求（缺口僵尸），
   *    配合 resumeGap 从下一阶段（或最后阶段 → 补 merge：push + PR）续跑。
   *
   * 仅在服务启动后的第一个 tick 调用（见 cm-worker/index.ts）：此时进程刚起、
   * 无任何在途会话，恢复任务不会与正常派发抢跑（避免重复 merge/重复建 PR）。
   */
  async markStaleRunning(): Promise<number> {
    const res = await this.deps.pgmas.withClient(this.deps.database, client =>
      client.query(`
        update records r
        set status = 'failed',
            result = '进程重启，中断的会话已失效；等待 worker 自动重试',
            updated_at = now()
        where r.status = 'running'
        returning r.id
      `))
    return res.rowCount ?? 0
  }

  /** ⑤b 缺口僵尸行：in_progress 需求 + 最新 record = 阶段 success + 无挂起/失败 + 无 merge。 */
  async listStuckGaps(limit = 5): Promise<GapRow[]> {
    const rows = await this.deps.pgmas.withClient(this.deps.database, client =>
      client.query(`
        select r.id as requirement_id,
               (select rc.branch_id from records rc
                where rc.requirement_id = r.id::text and rc.branch_id is not null
                order by rc.created_at asc limit 1) as branch_id,
               (select rc2.category from records rc2
                where rc2.requirement_id = r.id::text
                order by rc2.created_at desc, rc2.id desc limit 1) as last_category
        from requirements r
        where r.status = 'in_progress'
          and r.project_id is not null
          and not exists (
            select 1 from records rc3
            where rc3.requirement_id = r.id::text and rc3.category = 'merge'
          )
          -- 最新 record 必须是阶段 success（running/waiting/failed 由正常派发路径接管；
          -- 更早的 failed（重试后成功）不影响缺口判定）
          and (
            select rc4.status from records rc4
            where rc4.requirement_id = r.id::text
            order by rc4.created_at desc, rc4.id desc limit 1
          ) = 'success'
        order by r.updated_at asc
        limit $1
      `, [limit]))
    return rows.rows as GapRow[]
  }

  /** ⑤c 续跑一条缺口僵尸：最后阶段 success → 补 merge；中途缺口 → 从下一阶段继续。 */
  async resumeGap(row: GapRow): Promise<void> {
    const stageIndex = STAGES.findIndex(s => s.category === row.last_category)
    if (stageIndex < 0) return
    const requirement = await this.deps.requirements.getById(row.requirement_id)
    if (requirement === undefined || requirement.status !== 'in_progress') return
    if (requirement.projectId === null) return
    const project = await this.deps.projects.getById(requirement.projectId)
    if (project === undefined) return
    const wt = this.deps.worktreeFor(project)
    const branch = row.branch_id ?? `req-${requirement.id.slice(0, 8)}`
    const input = {
      id: requirement.id,
      title: requirement.title,
      description: requirement.description,
      project,
      wt: { path: wt.pathFor(branch), branch },
    }
    if (stageIndex >= STAGES.length - 1) {
      // 最后阶段（review-code）已 success 但 merge 从未创建 → 补 merge（push + PR）
      await this.runMerge(input)
      return
    }
    await this.runPipeline(input, { from: { category: STAGES[stageIndex + 1]!.category } })
  }

  /** 该需求最近成功的 record artifacts（供下阶段上下文）。 */
  private async priorArtifacts(requirementId: string): Promise<string[]> {
    const record = await this.deps.requirements.listRecentRecord(requirementId)
    return record === undefined ? [] : record.artifacts
  }
}
