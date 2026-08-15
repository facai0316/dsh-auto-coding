/**
 * Stage orchestration — pure, dependency-injected logic for the coding
 * pipeline worker: claim → stage chain → records ledger → decision channel
 * hooks. Cordis-free so it can be tested with fake executors against the real
 * `cm` database.
 * @module @auto-coding/cm-worker/pipeline
 */

import type { ProjectView, ProjectsRepo, QuestionsRepo, RequirementsRepo, WriteSeam } from '@auto-coding/cm-flow'

// ──────────────────────────────── stages ─────────────────────────────────

export interface StageDef {
  /** records.category 值。 */
  category: string
  /** facai skill 目录名（.agents/skills/<skill>/SKILL.md）。 */
  skill: string
  /** 附加到 prompt 的阶段专属指令。 */
  instruction?: string
}

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
  prompt: string
}

export interface StageExecution {
  stopReason: string
  structured?: unknown
}

/** Structured result contract the stage session must return (00 §4.4). */
export interface StageResult {
  isError: boolean
  message: string
  artifacts: string[]
  questions: { question: string; options: string[] }[]
}

export interface StageExecutor {
  run(input: StageInput): Promise<StageExecution>
  /** PR 创建任务（merge 阶段）：返回 {is_ok, pr_url, error}。 */
  runPr(input: { prompt: string; repo: string }): Promise<PrExecution>
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

/** 组装 PR 创建任务的指导指令（方案 §8）。 */
export function buildPrPrompt(input: { wtPath: string; repo: string; title: string; description: string | null; branch: string }): string {
  return [
    '你是 PR 创建任务，只做一件事：把当前分支创建为 Pull Request，返回 JSON。',
    '',
    `# 工作根目录`,
    input.wtPath,
    '',
    '# 步骤',
    `1. git -C ${input.wtPath} remote get-url origin → 取 host`,
    '2. 判断平台：host 含 "gitee.com" → Gitee；否则 → Gitea',
    '3. 解析 owner/repo：git@gitee.com:o/r.git 或 https://host/o/r.git → owner=o, repo=r',
    '4. 建 PR（用环境变量 $PR_TOKEN）：',
    '   Gitee: POST https://gitee.com/api/v5/repos/{owner}/{repo}/pulls',
    '   Gitea: POST https://<host>/api/v1/repos/{owner}/{repo}/pulls',
    '   header:  Authorization: token $PR_TOKEN',
    `   body:    { "title": ${JSON.stringify(input.title)}, "head": ${JSON.stringify(input.branch)}, "base": "main", "body": ${JSON.stringify(input.description ?? '')} }`,
    '5. 返回 JSON（唯一契约）：',
    '   成功：{"is_ok":"true","pr_url":"<PR 链接>"}',
    '   失败：{"is_ok":"false","error":"<原因>"}',
  ].join('\n')
}

export interface WorktreeHandleLike {
  path: string
  branch: string
}

export interface PipelineWorktree {
  create(branch: string, base: string): Promise<WorktreeHandleLike>
  /** 计算分支对应 worktree 的绝对路径（续跑重建 handle 用）。 */
  pathFor(branch: string): string
  linkSharedTarget(handle: WorktreeHandleLike): void
  /** push 任务分支到远程（merge 阶段用）。 */
  push(handle: WorktreeHandleLike): Promise<void>
  remove(handle: WorktreeHandleLike): Promise<void>
}

export interface PipelineDeps {
  pgmas: WriteSeam
  database: string
  requirements: RequirementsRepo
  projects: ProjectsRepo
  questions: QuestionsRepo
  executor: StageExecutor
  /** 读取项目 skill 的 SKILL.md 全文。 */
  readSkillMd: (repo: string, skill: string) => Promise<string>
  /** 每项目一个 worktree 管理器（create/link/remove）。 */
  worktreeFor: (project: Pick<ProjectView, 'id' | 'localPath'>) => PipelineWorktree
  /** 阶段失败最大重试次数（同 category）。 */
  maxRetries: number
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
 * Claim → stage chain → ledger. One instance per worker service; methods are
 * the tick's poll actions and must be called serially.
 */
export class WorkerPipeline {
  constructor(private readonly deps: PipelineDeps) {}

  /** ① 领取一条 open 需求并跑阶段链。返回是否领到并开始处理。 */
  async claimAndRun(): Promise<boolean> {
    const row = await this.deps.pgmas.withClient(this.deps.database, client => client.query(CLAIM_SQL))
    const claim = row.rows[0] as { id: string; project_id: string; title: string; description: string | null } | undefined
    if (claim === undefined) return false
    const project = await this.deps.projects.getById(claim.project_id)
    if (project === undefined) {
      throw new Error(`领取的需求 ${claim.id} 关联的项目不存在`)
    }
    const wt = this.deps.worktreeFor(project)
    const handle = await wt.create(`req-${claim.id.slice(0, 8)}`, 'origin/main')
    wt.linkSharedTarget(handle)
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

  /**
   * 阶段链：按 STAGES 顺序推进；waiting/failed 时停止。
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
  ): Promise<'success' | 'waiting' | 'failed'> {
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
      if (outcome === 'waiting' || outcome === 'failed') return outcome
    }
    // 全部阶段成功 → merge 阶段（push + PR agent 任务）
    return this.runMerge(input)
  }

  /** 单阶段：prompt → 会话 → 结构化结果 → 记账。带 recordId 时为续跑（复用该 record）。 */
  async runStage(
    requirement: { id: string; title: string; description: string | null; project: ProjectView; wt: WorktreeHandleLike },
    stage: StageDef,
    opts?: { recordId?: string; userAnswers?: { question: string; answer: string }[] },
  ): Promise<'success' | 'waiting' | 'failed'> {
    const recordId = opts?.recordId
    const userAnswers = opts?.userAnswers ?? []
    const record = recordId === undefined
      ? await this.deps.requirements.appendRecord({
        requirementId: requirement.id,
        category: stage.category,
        status: 'running',
        branchId: requirement.wt.branch,
        skills: [stage.skill],
      })
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
        prompt,
      })
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
      // 挂起：等用户作答（05 续跑）
      await this.deps.questions.insertMany(record.id, result.questions)
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

    await this.deps.requirements.updateRecord(record.id, {
      status: 'success',
      result: result.message || 'ok',
      artifacts: result.artifacts,
    })
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
  ): Promise<'success' | 'waiting' | 'failed'> {
    const recordId = opts?.recordId
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
      await this.deps.requirements.updateRecord(record.id, { status: 'waiting_reply', result: 'awaiting pr token' })
      return 'waiting'
    }

    const prompt = buildPrPrompt({
      wtPath: requirement.wt.path,
      repo: requirement.project.localPath,
      title: requirement.title,
      description: requirement.description,
      branch: requirement.wt.branch,
    })
    let pr: PrExecution
    try {
      pr = await this.deps.executor.runPr({ prompt, repo: requirement.project.localPath })
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
    await this.deps.requirements.updateRecord(record.id, { status: 'waiting_reply', result: 'pr creation failed' })
    return 'waiting'
  }

  /**
   * ② 续跑：waiting_reply 且无 pending 问题的 record → 组装用户答复 → 复用
   * 该 record 新开会话重跑同阶段（merge 阶段重跑 runMerge）。
   */
  async resumeWaiting(): Promise<void> {
    const rows = await this.deps.pgmas.withClient(this.deps.database, client =>
      client.query(`
        select r.id as record_id, r.requirement_id, r.category, r.branch_id
        from records r
        where r.status = 'waiting_reply'
          and not exists (
            select 1 from ask_user_questions q
            where q.record_id = r.id and q.status = 'pending'
          )
        order by r.updated_at asc
        limit 10
      `))
    for (const row of rows.rows as { record_id: string; requirement_id: string; category: string; branch_id: string | null }[]) {
      await this.resumeRecord(row)
    }
  }

  private async resumeRecord(row: { record_id: string; requirement_id: string; category: string; branch_id: string | null }): Promise<void> {
    const requirement = await this.deps.requirements.getById(row.requirement_id)
    if (requirement === undefined || requirement.status !== 'in_progress') return
    if (requirement.projectId === null) return
    const project = await this.deps.projects.getById(requirement.projectId)
    if (project === undefined) return
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
    await this.runPipeline(
      input,
      { resume: { recordId: row.record_id, category: row.category, userAnswers: answers } },
    )
  }

  /**
   * ③ 重试：failed 且同 requirement 同 category 的 failed 总数 ≤ maxRetries+1
   * → 复用上下文 append 新 record 重跑同阶段；任一同 category failed 数
   * 超限 → requirement 回 `open` 重新排队（worktree 现场保留）。
   */
  async retryFailed(): Promise<void> {
    const limit = this.deps.maxRetries + 1
    // 1) 超限回退：任一 category failed 数 > maxRetries+1 → requirement 回 open
    await this.deps.pgmas.withClient(this.deps.database, client =>
      client.query(`
        update requirements req set status = 'open', updated_at = now()
        where req.status = 'in_progress'
          and exists (
            select 1 from records rc
            where rc.requirement_id = req.id::text and rc.status = 'failed'
            group by rc.category
            having count(*) > $1
          )
      `, [limit]))
    // 2) 可重试的 failed record
    const rows = await this.deps.pgmas.withClient(this.deps.database, client =>
      client.query(`
        select r.id as record_id, r.requirement_id, r.category, r.branch_id
        from records r
        where r.status = 'failed'
          and exists (
            select 1 from requirements req
            where req.id::text = r.requirement_id and req.status = 'in_progress'
          )
          and (
            select count(*) from records rc
            where rc.requirement_id = r.requirement_id
              and rc.category = r.category
              and rc.status = 'failed'
          ) <= $1
        order by r.updated_at asc
        limit 10
      `, [limit]))
    for (const row of rows.rows as { record_id: string; requirement_id: string; category: string; branch_id: string | null }[]) {
      await this.retryRecord(row)
    }
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
    // append 新 record 作为重试尝试；旧 failed record 保留（计数/历史）
    const outcome = await this.runStage(input, stage)
    if (outcome === 'success') {
      const nextIndex = STAGES.findIndex(s => s.category === stage.category) + 1
      if (nextIndex < STAGES.length) {
        await this.runPipeline(input, { from: { category: STAGES[nextIndex]!.category } })
      }
    }
  }

  /**
   * ④ 收尾：用户点「已合并」→ confirmMerged（02）→ requirement done；
   * 此处对 done 且尚未清理（无 cleanup record）的需求清理 worktree + 分支，
   * 并记一条 cleanup record 保证幂等。
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

  /** 该需求最近成功的 record artifacts（供下阶段上下文）。 */
  private async priorArtifacts(requirementId: string): Promise<string[]> {
    const record = await this.deps.requirements.listRecentRecord(requirementId)
    return record === undefined ? [] : record.artifacts
  }
}
