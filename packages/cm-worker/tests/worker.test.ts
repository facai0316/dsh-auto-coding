import { afterAll, describe, expect, it } from 'vitest'
import pg from 'pg'
import {
  ProjectsRepo,
  QuestionsRepo,
  RequirementsRepo,
  ReviewsRepo,
  type WriteSeam,
} from '@auto-coding/cm-flow'
import {
  DEFERRED_REVIEW_GATES,
  REVIEW_GATED,
  STAGES,
  WorkerPipeline,
  buildPrompt,
  buildPrPrompt,
  buildResolvePrompt,
  isPathArtifact,
  missingArtifacts,
  parsePrResult,
  parseStageResult,
  runLanes,
  withinWindow,
  type PipelineWorktree,
  type PrExecution,
  type StageAgentOptions,
  type StageDef,
  type StageExecution,
  type StageInput,
} from '../src/pipeline.ts'

const TEST_DATABASE = 'cm_fake_test'
// 防再犯：测试绝不允许直连生产 cm 库（曾因误连 cm，FakeExecutor 把真实需求的
// 剩余阶段全部空跑成假记录）。换库名必须同时改这里与 cm-flow 测试。
if ((TEST_DATABASE as string) === 'cm') throw new Error('测试禁止连生产 cm 库；请使用独立测试库（如 cm_fake_test）')
const TEST_USER_ID = '00000000-0000-4000-8000-00000000fffc'

function writeSeam(pool: pg.Pool): WriteSeam {
  return {
    withClient: async (_database, fn) => {
      const client = await pool.connect()
      try {
        return await fn(client)
      } finally {
        client.release()
      }
    },
  }
}

const pool = new pg.Pool({
  host: '127.0.0.1',
  port: 25678,
  user: 'mas',
  password: 'Fa^Cai!0316#Mas.',
  database: TEST_DATABASE,
  connectionTimeoutMillis: 3000,
  statement_timeout: 10_000,
  max: 2,
})
pool.on('error', () => {})

async function reachable(): Promise<boolean> {
  try {
    await pool.query('select 1')
    return true
  } catch {
    return false
  }
}

/** 轮询等待谓词成立（后台 fire-and-forget 任务落库用）。 */
async function waitUntil(predicate: () => Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error('waitUntil 超时')
}

const createdIds: string[] = []
const createdProjectIds: string[] = []
afterAll(async () => {
  if (createdIds.length > 0) {
    await pool.query('delete from records where requirement_id = any($1::text[])', [createdIds]).catch(() => {})
    await pool.query('delete from requirements where id = any($1::uuid[])', [createdIds]).catch(() => {})
  }
  if (createdProjectIds.length > 0) {
    await pool.query('delete from projects where id = any($1::uuid[])', [createdProjectIds]).catch(() => {})
  }
  await pool.end().catch(() => {})
})

function track(id: string): string {
  createdIds.push(id)
  return id
}

/** 可编程的 fake 阶段执行器。 */
class FakeExecutor {
  calls: StageInput[] = []
  agentOptionsCalls: (StageAgentOptions | undefined)[] = []
  prCalls: { prompt: string; wtPath: string }[] = []
  prAgentOptionsCalls: (StageAgentOptions | undefined)[] = []
  constructor(
    private readonly handler: (input: StageInput) => StageExecution,
    private readonly prHandler: () => PrExecution = () => ({ isOk: true, prUrl: 'https://gitee.com/o/r/pulls/1' }),
  ) {}
  run(input: StageInput, agentOptions?: StageAgentOptions): Promise<StageExecution> {
    this.calls.push(input)
    this.agentOptionsCalls.push(agentOptions)
    return Promise.resolve(this.handler(input))
  }
  runPr(input: { prompt: string; wtPath: string }, agentOptions?: StageAgentOptions): Promise<PrExecution> {
    this.prCalls.push({ prompt: input.prompt, wtPath: input.wtPath })
    this.prAgentOptionsCalls.push(agentOptions)
    return Promise.resolve(this.prHandler())
  }
}

/** 可观察的 fake worktree。 */
class FakeWorktree implements PipelineWorktree {
  pushes: string[] = []
  removes: string[] = []
  pulls: string[] = []
  /** 置 true 时 pullMain 抛错（模拟主 checkout 同步 main 失败）。 */
  failPull = false
  create(branch: string): Promise<{ path: string; branch: string }> {
    return Promise.resolve({ path: `/tmp/fake-wt/${branch}`, branch })
  }
  pathFor(branch: string): string {
    return `/tmp/fake-wt/${branch}`
  }
  linkSharedTarget(): void {}
  push(handle: { branch: string }): Promise<void> {
    this.pushes.push(handle.branch)
    return Promise.resolve()
  }
  pullMain(branch?: string): Promise<void> {
    if (this.failPull) return Promise.reject(new Error('git pull main 失败 (fake)'))
    this.pulls.push(branch ?? 'main')
    return Promise.resolve()
  }
  commitAll(): Promise<boolean> {
    return Promise.resolve(false)
  }
  remove(handle: { branch: string }): Promise<void> {
    this.removes.push(handle.branch)
    return Promise.resolve()
  }
}

interface MakeDepsResult {
  deps: ConstructorParameters<typeof WorkerPipeline>[0]
  worktree: FakeWorktree
}

function makeDeps(
  executor: FakeExecutor,
  requirements: RequirementsRepo,
  projects: ProjectsRepo,
  questions: QuestionsRepo,
  reviews: ReviewsRepo,
  worktree: FakeWorktree = new FakeWorktree(),
  maxRetries = 1,
  configFor: (category: string) => StageAgentOptions | undefined = category =>
    category === 'decision' ? { model: 'deepseek-v4-pro' } : undefined,
  artifactExists: (wtPath: string, relPath: string) => Promise<boolean> = async () => true,
): MakeDepsResult {
  return {
    deps: {
      pgmas: writeSeam(pool),
      database: TEST_DATABASE,
      requirements,
      projects,
      questions,
      reviews,
      executor: executor as unknown as { run(input: StageInput, agentOptions?: StageAgentOptions): Promise<StageExecution>; runPr(input: { prompt: string; repo: string; wtPath: string }, agentOptions?: StageAgentOptions): Promise<PrExecution> },
      readSkillMd: async () => 'SKILL 内容占位',
      artifactExists,
      worktreeFor: () => worktree,
      maxRetries,
      configFor,
    },
    worktree,
  }
}

async function openRequirement(requirements: RequirementsRepo, projectId?: string): Promise<string> {
  const project = projectId !== undefined
    ? await new ProjectsRepo({ pgmas: writeSeam(pool), database: TEST_DATABASE }).getById(projectId)
    : (await new ProjectsRepo({ pgmas: writeSeam(pool), database: TEST_DATABASE }).list())[0]
  expect(project).toBeDefined()
  const created = track((await requirements.create('worker 集成测试', '流水线测试', project!.id)).id)
  await requirements.transition(created, 'open')
  return created
}

/** 造一个带 prToken 的专用项目（merge 成功路径用），返回 projectId。 */
async function createTokenProject(): Promise<string> {
  const created = await new ProjectsRepo({ pgmas: writeSeam(pool), database: TEST_DATABASE }).create({
    name: 'token-project',
    localPath: `/tmp/token-project-${Date.now()}`,
    gitUrl: 'git@gitee.com:o/token-project.git',
    platform: 'gitee',
    prToken: 'tok-test',
  })
  createdProjectIds.push(created.id)
  return created.id
}

/** 某 requirement 下指定 category 的最新 record id。 */
async function recordIdOf(requirementId: string, category: string): Promise<string> {
  const rows = (await pool.query(
    'select id from records where requirement_id = $1 and category = $2 order by created_at asc, id asc limit 1',
    [requirementId, category],
  )).rows as { id: string }[]
  expect(rows[0]).toBeDefined()
  return rows[0]!.id
}

/** 通过某 record 的最新 review 人工审核门。 */
async function approveGate(reviews: ReviewsRepo, recordId: string): Promise<void> {
  const ticket = await reviews.latestByRecord(recordId)
  expect(ticket).toBeDefined()
  expect(ticket?.kind).toBe('review')
  await reviews.approve(ticket!.id)
}

/** 驳回某 record 的最新 review 人工审核门（带整改意见）。 */
async function rejectGate(reviews: ReviewsRepo, recordId: string, feedback: string): Promise<void> {
  const ticket = await reviews.latestByRecord(recordId)
  expect(ticket).toBeDefined()
  expect(ticket?.kind).toBe('review')
  await reviews.reject(ticket!.id, feedback)
}

describe.skipIf(!(await reachable()))('WorkerPipeline against the live cm database', () => {
  it('claims an open requirement and runs the full stage chain through review gates + merge to merging', async () => {
    const requirements = new RequirementsRepo({ pgmas: writeSeam(pool), database: TEST_DATABASE, userId: TEST_USER_ID })
    const projects = new ProjectsRepo({ pgmas: writeSeam(pool), database: TEST_DATABASE })
    const questions = new QuestionsRepo({ pgmas: writeSeam(pool), database: TEST_DATABASE })
    const reviews = new ReviewsRepo({ pgmas: writeSeam(pool), database: TEST_DATABASE })
    const tokenProjectId = await createTokenProject()
    const id = await openRequirement(requirements, tokenProjectId)

    const executor = new FakeExecutor(() => ({
      stopReason: 'completed',
      structured: { isError: false, message: 'ok', artifacts: ['docs/plans/001.md'], questions: [] },
    }))
    const { deps, worktree } = makeDeps(executor, requirements, projects, questions, reviews)
    const pipeline = new WorkerPipeline(deps)

    expect(await pipeline.claimAndRun()).toBe(true)
    // decision 产物（ADR）先停在人工审核门
    let rows = (await pool.query('select category, status from records where requirement_id = $1 order by created_at asc', [id])).rows as { category: string; status: string }[]
    expect(rows.map(r => r.category)).toEqual(['decision'])
    expect(rows[0]?.status).toBe('waiting_review')

    // 通过 ADR 审核 → plan 生成 + review-plan 机审 → plan 停在延后人审门
    await approveGate(reviews, await recordIdOf(id, 'decision'))
    await pipeline.processReviews()
    rows = (await pool.query('select category, status from records where requirement_id = $1 order by created_at asc', [id])).rows as { category: string; status: string }[]
    expect(rows.map(r => r.category)).toEqual(['decision', 'plan', 'review-plan'])
    expect(rows.find(r => r.category === 'plan')?.status).toBe('waiting_review')
    expect(rows.find(r => r.category === 'review-plan')?.status).toBe('success')
    const planGate = await reviews.latestByRecord(await recordIdOf(id, 'plan'))
    expect(planGate).toMatchObject({ kind: 'review', status: 'pending' })

    // 通过 plan 人审 → 剩余阶段 + merge 一口气跑完
    await approveGate(reviews, await recordIdOf(id, 'plan'))
    await pipeline.processReviews()
    rows = (await pool.query('select category, status from records where requirement_id = $1 order by created_at asc', [id])).rows as { category: string; status: string }[]
    expect(rows.map(r => r.category)).toEqual([...STAGES.map(s => s.category), 'merge'])
    expect(rows.every(r => r.status === 'success')).toBe(true)
    // PR 任务被调用并拿到指导指令（含 worktree 路径）
    expect(executor.prCalls).toHaveLength(1)
    expect(executor.prCalls[0]?.prompt).toContain('gitee.com')
    expect(executor.prCalls[0]?.wtPath).toContain('req-')
    expect(worktree.pushes).toEqual([`req-${id.slice(0, 8)}`])
    // 需求进入 merging（PR 已建）
    const req = (await pool.query('select status from requirements where id = $1', [id])).rows[0] as { status: string }
    expect(req.status).toBe('merging')
    // merge record 带 prUrl
    const artifacts = (await pool.query('select artifacts from records where requirement_id = $1 and category = $2', [id, 'merge'])).rows[0] as { artifacts: string[] }
    expect(artifacts.artifacts[0]).toBe('https://gitee.com/o/r/pulls/1')
  })

  it('pauses to waiting_reply with questions when a stage asks the user, and requires answering + approve to continue', async () => {
    const requirements = new RequirementsRepo({ pgmas: writeSeam(pool), database: TEST_DATABASE, userId: TEST_USER_ID })
    const projects = new ProjectsRepo({ pgmas: writeSeam(pool), database: TEST_DATABASE })
    const questions = new QuestionsRepo({ pgmas: writeSeam(pool), database: TEST_DATABASE })
    const reviews = new ReviewsRepo({ pgmas: writeSeam(pool), database: TEST_DATABASE })
    const id = await openRequirement(requirements)

    let planCalls = 0
    const executor = new FakeExecutor((input: StageInput) => {
      if (input.category === 'plan') {
        planCalls += 1
        if (planCalls === 1) {
          return {
            stopReason: 'completed',
            structured: { isError: false, message: '需要决策', artifacts: [], questions: [{ question: '方案 A 还是 B？', options: ['A', 'B'] }] },
          }
        }
        expect(input.prompt).toContain('用户答复')
        expect(input.prompt).toContain('选 A')
      }
      return { stopReason: 'completed', structured: { isError: false, message: 'ok', artifacts: [], questions: [] } }
    })
    const { deps } = makeDeps(executor, requirements, projects, questions, reviews)
    const pipeline = new WorkerPipeline(deps)

    await pipeline.claimAndRun()
    // 先放行 decision 审核门，plan 才会跑起来
    await approveGate(reviews, await recordIdOf(id, 'decision'))
    await pipeline.processReviews()

    const records = (await pool.query('select category, status from records where requirement_id = $1 order by created_at asc', [id])).rows as { category: string; status: string }[]
    expect(records.find(r => r.category === 'plan')?.status).toBe('waiting_reply')
    expect(records.at(-1)?.category).toBe('plan')
    const planRecordId = await recordIdOf(id, 'plan')
    const pending = await questions.pendingByRecord(planRecordId)
    expect(pending).toHaveLength(1)
    // 有 pending reply 放行单
    const ticket = await reviews.latestByRecord(planRecordId)
    expect(ticket?.kind).toBe('reply')
    expect(ticket?.status).toBe('pending')

    // 答完但未通过 → 不放行
    await questions.answer(pending[0]!.id, '选 A')
    await pipeline.processReviews()
    let status = (await pool.query('select status from records where id = $1', [planRecordId])).rows[0] as { status: string }
    expect(status.status).toBe('waiting_reply')

    // 通过放行单 → 携答复续跑：plan 重跑成功后走 review-plan 机审 → 停在 plan 人审门
    await reviews.approve(ticket!.id)
    await pipeline.processReviews()
    const planRows = (await pool.query('select status, retry_count from records where id = $1', [planRecordId])).rows as { status: string; retry_count: number }[]
    expect(planRows).toHaveLength(1)
    expect(planRows[0]?.status).toBe('waiting_review')
    expect(executor.calls.some(call => call.category === 'plan' && call.prompt.includes('选 A'))).toBe(true)
    expect(executor.calls.filter(call => call.category === 'review-plan')).toHaveLength(1)
    const gate = await reviews.latestByRecord(planRecordId)
    expect(gate?.kind).toBe('review')
    expect(gate?.status).toBe('pending')
  })

  it('rejects an immediate review gate (decision) with feedback and re-runs the same record with the feedback injected', async () => {
    const requirements = new RequirementsRepo({ pgmas: writeSeam(pool), database: TEST_DATABASE, userId: TEST_USER_ID })
    const projects = new ProjectsRepo({ pgmas: writeSeam(pool), database: TEST_DATABASE })
    const questions = new QuestionsRepo({ pgmas: writeSeam(pool), database: TEST_DATABASE })
    const reviews = new ReviewsRepo({ pgmas: writeSeam(pool), database: TEST_DATABASE })
    const id = await openRequirement(requirements)

    let decisionCalls = 0
    const executor = new FakeExecutor((input: StageInput) => {
      if (input.category === 'decision') {
        decisionCalls += 1
        if (decisionCalls > 1) {
          expect(input.feedback).toBe('ADR 缺少方案对比与取舍理由')
          expect(input.prompt).toContain('审核整改意见')
          expect(input.prompt).toContain('ADR 缺少方案对比与取舍理由')
        }
      }
      return { stopReason: 'completed', structured: { isError: false, message: 'ok', artifacts: ['decisions/001.md'], questions: [] } }
    })
    const { deps } = makeDeps(executor, requirements, projects, questions, reviews)
    const pipeline = new WorkerPipeline(deps)

    await pipeline.claimAndRun()
    const decisionRecordId = await recordIdOf(id, 'decision')
    expect(decisionCalls).toBe(1)

    await rejectGate(reviews, decisionRecordId, 'ADR 缺少方案对比与取舍理由')
    await pipeline.processReviews()

    // 复用原 record（不新开），retry_count=1，重新挂起等审核
    expect(decisionCalls).toBe(2)
    const rows = (await pool.query('select status, retry_count from records where id = $1', [decisionRecordId])).rows as { status: string; retry_count: number }[]
    expect(rows[0]).toMatchObject({ status: 'waiting_review', retry_count: 1 })
    const gate = await reviews.latestByRecord(decisionRecordId)
    expect(gate?.status).toBe('pending')
    const all = await reviews.listByRecord(decisionRecordId)
    expect(all).toHaveLength(2)
    expect(all[0]).toMatchObject({ status: 'rejected', feedback: 'ADR 缺少方案对比与取舍理由' })
  })

  it('rejects the deferred plan gate with feedback: plan re-runs with feedback, then machine review re-runs, then the gate re-arms', async () => {
    const requirements = new RequirementsRepo({ pgmas: writeSeam(pool), database: TEST_DATABASE, userId: TEST_USER_ID })
    const projects = new ProjectsRepo({ pgmas: writeSeam(pool), database: TEST_DATABASE })
    const questions = new QuestionsRepo({ pgmas: writeSeam(pool), database: TEST_DATABASE })
    const reviews = new ReviewsRepo({ pgmas: writeSeam(pool), database: TEST_DATABASE })
    const id = await openRequirement(requirements)

    let planCalls = 0
    const executor = new FakeExecutor((input: StageInput) => {
      if (input.category === 'plan') {
        planCalls += 1
        if (planCalls > 1) {
          expect(input.feedback).toBe('计划缺里程碑与验收命令')
          expect(input.prompt).toContain('审核整改意见')
          expect(input.prompt).toContain('计划缺里程碑与验收命令')
        }
      }
      return { stopReason: 'completed', structured: { isError: false, message: 'ok', artifacts: ['docs/plans/19-x/README.md'], questions: [] } }
    })
    const { deps } = makeDeps(executor, requirements, projects, questions, reviews)
    const pipeline = new WorkerPipeline(deps)

    await pipeline.claimAndRun()
    await approveGate(reviews, await recordIdOf(id, 'decision'))
    await pipeline.processReviews()
    const planRecordId = await recordIdOf(id, 'plan')
    expect(planCalls).toBe(1)
    expect((await reviews.latestByRecord(planRecordId))?.status).toBe('pending')

    await rejectGate(reviews, planRecordId, '计划缺里程碑与验收命令')
    await pipeline.processReviews()

    // plan 携反馈重跑 → review-plan 重新机审 → 再次挂人审门（同一 plan record 复用）
    expect(planCalls).toBe(2)
    expect(executor.calls.filter(call => call.category === 'review-plan')).toHaveLength(2)
    const planRows = (await pool.query('select status, retry_count from records where id = $1', [planRecordId])).rows as { status: string; retry_count: number }[]
    expect(planRows).toHaveLength(1)
    expect(planRows[0]).toMatchObject({ status: 'waiting_review', retry_count: 1 })
    const all = await reviews.listByRecord(planRecordId)
    expect(all).toHaveLength(2)
    expect(all[0]).toMatchObject({ status: 'rejected', feedback: '计划缺里程碑与验收命令' })
    expect(all[1]).toMatchObject({ kind: 'review', status: 'pending' })
  })

  it('marks a failing stage as failed and stops the chain', async () => {
    const requirements = new RequirementsRepo({ pgmas: writeSeam(pool), database: TEST_DATABASE, userId: TEST_USER_ID })
    const projects = new ProjectsRepo({ pgmas: writeSeam(pool), database: TEST_DATABASE })
    const questions = new QuestionsRepo({ pgmas: writeSeam(pool), database: TEST_DATABASE })
    const reviews = new ReviewsRepo({ pgmas: writeSeam(pool), database: TEST_DATABASE })
    const id = await openRequirement(requirements)

    const executor = new FakeExecutor(() => ({
      stopReason: 'completed',
      structured: { isError: true, message: '架构冲突', artifacts: [], questions: [] },
    }))
    const { deps } = makeDeps(executor, requirements, projects, questions, reviews)
    const pipeline = new WorkerPipeline(deps)

    await pipeline.claimAndRun()
    const records = (await pool.query('select category, status, result from records where requirement_id = $1 order by created_at asc', [id])).rows as { category: string; status: string; result: string }[]
    expect(records).toHaveLength(1)
    expect(records[0]?.status).toBe('failed')
    expect(records[0]?.result).toBe('架构冲突')
  })

  it('stops the chain when the requirement is terminated, marking the current record terminated', async () => {
    const requirements = new RequirementsRepo({ pgmas: writeSeam(pool), database: TEST_DATABASE, userId: TEST_USER_ID })
    const projects = new ProjectsRepo({ pgmas: writeSeam(pool), database: TEST_DATABASE })
    const questions = new QuestionsRepo({ pgmas: writeSeam(pool), database: TEST_DATABASE })
    const reviews = new ReviewsRepo({ pgmas: writeSeam(pool), database: TEST_DATABASE })
    const project = (await projects.list())[0]
    const id = track((await requirements.create('终止检查测试', undefined, project.id)).id)
    await requirements.transition(id, 'open')
    await requirements.transition(id, 'in_progress')
    await requirements.transition(id, 'terminated')

    const executor = new FakeExecutor(() => ({ stopReason: 'completed', structured: { isError: false, message: 'ok', artifacts: [], questions: [] } }))
    const { deps } = makeDeps(executor, requirements, projects, questions, reviews)
    const pipeline = new WorkerPipeline(deps)
    const wt = { path: `/tmp/fake-wt/req-${id.slice(0, 8)}`, branch: `req-${id.slice(0, 8)}` }
    const input = { id, title: '终止检查测试', description: null, project, wt }

    const outcome = await pipeline.runPipeline(input)
    expect(outcome).toBe('terminated')
    // 没有启动任何会话
    expect(executor.calls).toHaveLength(0)
    const rows = (await pool.query('select category, status from records where requirement_id = $1 order by created_at asc', [id])).rows as { category: string; status: string }[]
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ category: 'decision', status: 'terminated' })
  })

  it('pauses merge on a missing PR token and never calls the PR agent', async () => {
    // 新建一个无 token 的项目
    const projectsRepo = new ProjectsRepo({ pgmas: writeSeam(pool), database: TEST_DATABASE })
    const project = await projectsRepo.create({
      name: 'no-token-project', localPath: '/tmp/no-token-project', gitUrl: 'git@gitee.com:o/no-token.git', platform: 'gitee',
    })
    createdProjectIds.push(project.id)
    const requirements = new RequirementsRepo({ pgmas: writeSeam(pool), database: TEST_DATABASE, userId: TEST_USER_ID })
    const questions = new QuestionsRepo({ pgmas: writeSeam(pool), database: TEST_DATABASE })
    const reviews = new ReviewsRepo({ pgmas: writeSeam(pool), database: TEST_DATABASE })
    const id = track((await requirements.create('无 token 测试', undefined, project.id)).id)
    await requirements.transition(id, 'open')

    const executor = new FakeExecutor(() => ({ stopReason: 'completed', structured: { isError: false, message: 'ok', artifacts: [], questions: [] } }))
    const { deps } = makeDeps(executor, requirements, projectsRepo, questions, reviews)
    const pipeline = new WorkerPipeline(deps)

    await pipeline.claimAndRun()
    await approveGate(reviews, await recordIdOf(id, 'decision'))
    await pipeline.processReviews()
    await approveGate(reviews, await recordIdOf(id, 'plan'))
    await pipeline.processReviews()
    expect(executor.prCalls).toHaveLength(0)
    const mergeRecord = (await pool.query('select id, status from records where requirement_id = $1 and category = $2', [id, 'merge'])).rows[0] as { id: string; status: string }
    expect(mergeRecord.status).toBe('waiting_reply')
    const pending = await questions.pendingByRecord(mergeRecord.id)
    expect(pending).toHaveLength(1)
    expect(pending[0]?.question).toContain('PR token 未配置')
    const ticket = await reviews.latestByRecord(mergeRecord.id)
    expect(ticket?.kind).toBe('reply')
    expect(ticket?.status).toBe('pending')
    const req = (await pool.query('select status from requirements where id = $1', [id])).rows[0] as { status: string }
    expect(req.status).toBe('in_progress')
  })

  it('resolves merge conflicts: startResolve → agent questions → waiting_reply → answer+approve → resume with answers → success', async () => {
    const requirements = new RequirementsRepo({ pgmas: writeSeam(pool), database: TEST_DATABASE, userId: TEST_USER_ID })
    const projects = new ProjectsRepo({ pgmas: writeSeam(pool), database: TEST_DATABASE })
    const questions = new QuestionsRepo({ pgmas: writeSeam(pool), database: TEST_DATABASE })
    const reviews = new ReviewsRepo({ pgmas: writeSeam(pool), database: TEST_DATABASE })
    const tokenProjectId = await createTokenProject()
    const id = await openRequirement(requirements, tokenProjectId)

    let resolveCalls = 0
    const executor = new FakeExecutor((input: StageInput) => {
      if (input.category === 'resolve') {
        resolveCalls += 1
        if (resolveCalls === 1) {
          return {
            stopReason: 'completed',
            structured: { isError: false, message: '需要决策', artifacts: [], questions: [{ question: '冲突文件保留哪边？', options: ['保留任务分支', '保留远端'] }] },
          }
        }
        // 续跑：携答复继续 → 提交并推送
        expect(input.prompt).toContain('用户答复')
        expect(input.prompt).toContain('保留任务分支')
        return { stopReason: 'completed', structured: { isError: false, message: '冲突已解决并推送', artifacts: ['abc123'], questions: [] } }
      }
      return { stopReason: 'completed', structured: { isError: false, message: 'ok', artifacts: [], questions: [] } }
    })
    const { deps } = makeDeps(executor, requirements, projects, questions, reviews)
    const pipeline = new WorkerPipeline(deps)

    // 跑完整链条到 merging（PR 已建）
    await pipeline.claimAndRun()
    await approveGate(reviews, await recordIdOf(id, 'decision'))
    await pipeline.processReviews()
    await approveGate(reviews, await recordIdOf(id, 'plan'))
    await pipeline.processReviews()
    let req = (await pool.query('select status from requirements where id = $1', [id])).rows[0] as { status: string }
    expect(req.status).toBe('merging')

    // 审核大厅「解决冲突」→ 起跑 + 幂等（再次点击不重复起跑）
    const started = await pipeline.startResolve(id)
    expect(started.category).toBe('resolve')
    const again = await pipeline.startResolve(id)
    expect(again.id).toBe(started.id)

    // 等待后台会话落定：提问 → waiting_reply + questions + reply 放行单
    await waitUntil(async () =>
      (await pool.query('select status from records where id = $1', [started.id])).rows[0]?.status !== 'running')
    expect(resolveCalls).toBe(1)
    const statusRow = (await pool.query('select status from records where id = $1', [started.id])).rows[0] as { status: string }
    expect(statusRow.status).toBe('waiting_reply')
    const pending = await questions.pendingByRecord(started.id)
    expect(pending).toHaveLength(1)
    expect(pending[0]?.question).toContain('冲突文件保留哪边？')
    const ticket = await reviews.latestByRecord(started.id)
    expect(ticket?.kind).toBe('reply')
    expect(ticket?.status).toBe('pending')

    // 答完 + 放行 → 携答复续跑 runResolve → success；需求仍 merging（PR 未合）
    await questions.answer(pending[0]!.id, '保留任务分支')
    await reviews.approve(ticket!.id)
    await pipeline.processReviews()
    const after = (await pool.query('select status, result from records where id = $1', [started.id])).rows[0] as { status: string; result: string }
    expect(after).toMatchObject({ status: 'success', result: '冲突已解决并推送' })
    expect(resolveCalls).toBe(2)
    const resolveCallsMade = executor.calls.filter(call => call.category === 'resolve')
    expect(resolveCallsMade).toHaveLength(2)
    expect(resolveCallsMade[1]?.prompt).toContain('保留任务分支')
    req = (await pool.query('select status from requirements where id = $1', [id])).rows[0] as { status: string }
    expect(req.status).toBe('merging')
  })

  it('fails the resolve record when the resolve agent reports an error', async () => {
    const requirements = new RequirementsRepo({ pgmas: writeSeam(pool), database: TEST_DATABASE, userId: TEST_USER_ID })
    const projects = new ProjectsRepo({ pgmas: writeSeam(pool), database: TEST_DATABASE })
    const questions = new QuestionsRepo({ pgmas: writeSeam(pool), database: TEST_DATABASE })
    const reviews = new ReviewsRepo({ pgmas: writeSeam(pool), database: TEST_DATABASE })
    const tokenProjectId = await createTokenProject()
    const id = await openRequirement(requirements, tokenProjectId)

    const executor = new FakeExecutor((input: StageInput) => {
      if (input.category === 'resolve') {
        return { stopReason: 'completed', structured: { isError: true, message: '无法自动解决，需人工介入', artifacts: [], questions: [] } }
      }
      return { stopReason: 'completed', structured: { isError: false, message: 'ok', artifacts: [], questions: [] } }
    })
    const { deps } = makeDeps(executor, requirements, projects, questions, reviews)
    const pipeline = new WorkerPipeline(deps)

    await pipeline.claimAndRun()
    await approveGate(reviews, await recordIdOf(id, 'decision'))
    await pipeline.processReviews()
    await approveGate(reviews, await recordIdOf(id, 'plan'))
    await pipeline.processReviews()

    const started = await pipeline.startResolve(id)
    await waitUntil(async () =>
      (await pool.query('select status from records where id = $1', [started.id])).rows[0]?.status !== 'running')
    const row = (await pool.query('select status, result from records where id = $1', [started.id])).rows[0] as { status: string; result: string }
    expect(row).toMatchObject({ status: 'failed', result: '无法自动解决，需人工介入' })
  })

  it('fails the stage when declared artifacts do not exist in the worktree (phantom artifact guard)', async () => {
    const requirements = new RequirementsRepo({ pgmas: writeSeam(pool), database: TEST_DATABASE, userId: TEST_USER_ID })
    const projects = new ProjectsRepo({ pgmas: writeSeam(pool), database: TEST_DATABASE })
    const questions = new QuestionsRepo({ pgmas: writeSeam(pool), database: TEST_DATABASE })
    const reviews = new ReviewsRepo({ pgmas: writeSeam(pool), database: TEST_DATABASE })
    const id = await openRequirement(requirements)

    // 会话声称成功并返回一个幽灵产物路径（如历史上 review-plan 的 docs/plans/001.md）
    const executor = new FakeExecutor(() => ({
      stopReason: 'completed',
      structured: { isError: false, message: 'ok', artifacts: ['docs/plans/001.md'], questions: [] },
    }))
    // 校验器：ghost 路径不存在 → 阶段必须判失败，不得进入审核门/下一阶段
    const artifactExists = async (_wtPath: string, relPath: string): Promise<boolean> => relPath !== 'docs/plans/001.md'
    const { deps } = makeDeps(executor, requirements, projects, questions, reviews, new FakeWorktree(), 1, undefined, artifactExists)
    const pipeline = new WorkerPipeline(deps)

    await pipeline.claimAndRun()
    const rows = (await pool.query('select id, category, status, result from records where requirement_id = $1 order by created_at asc', [id])).rows as { id: string; category: string; status: string; result: string }[]
    // decision 是 REVIEW_GATED：幽灵产物必须先被拦下 → 只有一条 failed 的 decision record
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ category: 'decision', status: 'failed' })
    expect(rows[0]!.result).toContain('产物校验失败')
    expect(rows[0]!.result).toContain('docs/plans/001.md')
    // 没有挂任何审核门
    const gates = await reviews.listByRecord(rows[0]!.id)
    expect(gates).toHaveLength(0)
  })

  it('passes the stage when all declared artifact paths exist (commit-style entries skipped)', async () => {
    const requirements = new RequirementsRepo({ pgmas: writeSeam(pool), database: TEST_DATABASE, userId: TEST_USER_ID })
    const projects = new ProjectsRepo({ pgmas: writeSeam(pool), database: TEST_DATABASE })
    const questions = new QuestionsRepo({ pgmas: writeSeam(pool), database: TEST_DATABASE })
    const reviews = new ReviewsRepo({ pgmas: writeSeam(pool), database: TEST_DATABASE })
    const id = await openRequirement(requirements)

    const executor = new FakeExecutor(() => ({
      stopReason: 'completed',
      structured: {
        isError: false,
        message: 'ok',
        // 路径条目都存在；commit 描述条目（含空白）不参与校验
        artifacts: ['docs/plans/001.md', 'commit 05b3898 docs(plan): 修订', 'edd5302 docs(decision): ADR'],
        questions: [],
      },
    }))
    const artifactExists = async (_wtPath: string, relPath: string): Promise<boolean> => relPath === 'docs/plans/001.md'
    const { deps } = makeDeps(executor, requirements, projects, questions, reviews, new FakeWorktree(), 1, undefined, artifactExists)
    const pipeline = new WorkerPipeline(deps)

    await pipeline.claimAndRun()
    const rows = (await pool.query('select category, status from records where requirement_id = $1 order by created_at asc', [id])).rows as { category: string; status: string }[]
    // 产物校验通过 → decision 正常挂人工审核门（waiting_review）
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ category: 'decision', status: 'waiting_review' })
  })

  it('retries a failed stage by reusing the same record and continues the chain on success (through gates)', async () => {
    const requirements = new RequirementsRepo({ pgmas: writeSeam(pool), database: TEST_DATABASE, userId: TEST_USER_ID })
    const projects = new ProjectsRepo({ pgmas: writeSeam(pool), database: TEST_DATABASE })
    const questions = new QuestionsRepo({ pgmas: writeSeam(pool), database: TEST_DATABASE })
    const reviews = new ReviewsRepo({ pgmas: writeSeam(pool), database: TEST_DATABASE })
    const tokenProjectId = await createTokenProject()
    const id = await openRequirement(requirements, tokenProjectId)

    let decisionCalls = 0
    const executor = new FakeExecutor((input: StageInput) => {
      if (input.category === 'decision') {
        decisionCalls += 1
        if (decisionCalls === 1) {
          return { stopReason: 'completed', structured: { isError: true, message: '首次失败', artifacts: [], questions: [] } }
        }
      }
      return { stopReason: 'completed', structured: { isError: false, message: 'ok', artifacts: [], questions: [] } }
    })
    const { deps } = makeDeps(executor, requirements, projects, questions, reviews)
    const pipeline = new WorkerPipeline(deps)

    await pipeline.claimAndRun()
    expect(decisionCalls).toBe(1)
    await pipeline.retryFailed()
    // 重试复用原 record（不新开）：同一条 decision 由 failed → waiting_review（人工审核门），retry_count=1
    const decisionRows = (await pool.query('select status, retry_count from records where requirement_id = $1 and category = $2 order by created_at asc', [id, 'decision'])).rows as { status: string; retry_count: number }[]
    expect(decisionRows).toHaveLength(1)
    expect(decisionRows[0]?.status).toBe('waiting_review')
    expect(decisionRows[0]?.retry_count).toBe(1)

    // 放行 decision + plan 审核门 → 跑完到 merging
    await approveGate(reviews, await recordIdOf(id, 'decision'))
    await pipeline.processReviews()
    await approveGate(reviews, await recordIdOf(id, 'plan'))
    await pipeline.processReviews()
    const req = (await pool.query('select status from requirements where id = $1', [id])).rows[0] as { status: string }
    expect(req.status).toBe('merging')
  })

  it('stops retrying at maxRetries and leaves the requirement in_progress for manual intervention', async () => {
    const requirements = new RequirementsRepo({ pgmas: writeSeam(pool), database: TEST_DATABASE, userId: TEST_USER_ID })
    const projects = new ProjectsRepo({ pgmas: writeSeam(pool), database: TEST_DATABASE })
    const questions = new QuestionsRepo({ pgmas: writeSeam(pool), database: TEST_DATABASE })
    const reviews = new ReviewsRepo({ pgmas: writeSeam(pool), database: TEST_DATABASE })
    const id = await openRequirement(requirements)

    const executor = new FakeExecutor(() => ({
      stopReason: 'completed',
      structured: { isError: true, message: '总失败', artifacts: [], questions: [] },
    }))
    const { deps } = makeDeps(executor, requirements, projects, questions, reviews, new FakeWorktree(), 2) // maxRetries=2
    const pipeline = new WorkerPipeline(deps)

    await pipeline.claimAndRun()
    // 第 1 次失败 → 重试 1（retry_count=1，仍失败）
    await pipeline.retryFailed()
    let row = (await pool.query('select status, retry_count from records where requirement_id = $1 and category = $2', [id, 'decision'])).rows[0] as { status: string; retry_count: number }
    expect(row).toMatchObject({ status: 'failed', retry_count: 1 })
    // 重试 2（retry_count=2，仍失败）→ 已达上限
    await pipeline.retryFailed()
    row = (await pool.query('select status, retry_count from records where requirement_id = $1 and category = $2', [id, 'decision'])).rows[0] as { status: string; retry_count: number }
    expect(row).toMatchObject({ status: 'failed', retry_count: 2 })
    // 再跑也不再重试：record 保持 failed、retry_count 不再增长，需求停在 in_progress（不回 open 死循环）
    await pipeline.retryFailed()
    row = (await pool.query('select status, retry_count from records where requirement_id = $1 and category = $2', [id, 'decision'])).rows[0] as { status: string; retry_count: number }
    expect(row).toMatchObject({ status: 'failed', retry_count: 2 })
    const req = (await pool.query('select status from requirements where id = $1', [id])).rows[0] as { status: string }
    expect(req.status).toBe('in_progress')
  })

  it('continues two approved review gates concurrently via listActionableReviews + processReviewAction', async () => {
    // 复现「并发未生效」场景的核心：多条需求同时挂在人工审核门，用户逐条放行后，
    // 一轮 listActionableReviews 取齐全部已放行记录，processReviewAction 可并行续跑
    // （服务端 tick 按全局并发预算逐个派发，见 cm-worker/index.ts）。
    const requirements = new RequirementsRepo({ pgmas: writeSeam(pool), database: TEST_DATABASE, userId: TEST_USER_ID })
    const projects = new ProjectsRepo({ pgmas: writeSeam(pool), database: TEST_DATABASE })
    const questions = new QuestionsRepo({ pgmas: writeSeam(pool), database: TEST_DATABASE })
    const reviews = new ReviewsRepo({ pgmas: writeSeam(pool), database: TEST_DATABASE })
    const project = (await projects.list())[0]
    const wtFor = (id: string) => ({ path: `/tmp/fake-wt/req-${id.slice(0, 8)}`, branch: `req-${id.slice(0, 8)}` })

    const executor = new FakeExecutor(() => ({
      stopReason: 'completed',
      structured: { isError: false, message: 'ok', artifacts: ['docs/plans/001.md'], questions: [] },
    }))
    const { deps } = makeDeps(executor, requirements, projects, questions, reviews)
    const pipeline = new WorkerPipeline(deps)

    // 两条需求各自跑到 decision 人工审核门（不走 claim，避免命中库里遗留的 open 需求）
    const ids: string[] = []
    for (const title of ['并发续跑 A', '并发续跑 B']) {
      const id = track((await requirements.create(title, undefined, project.id)).id)
      await requirements.transition(id, 'open')
      await requirements.transition(id, 'in_progress')
      ids.push(id)
      await pipeline.runPipeline({ id, title, description: null, project, wt: wtFor(id) })
    }
    const decisionRows = (await pool.query(
      'select requirement_id, id from records where requirement_id = any($1::text[]) and category = $2 order by created_at asc',
      [ids, 'decision'],
    )).rows as { requirement_id: string; id: string }[]
    expect(decisionRows).toHaveLength(2)
    for (const row of decisionRows) await approveGate(reviews, row.id)

    // 一轮列出全部已放行记录 → 并行续跑
    const actions = await pipeline.listActionableReviews()
    expect(actions.map(a => a.record_id).sort()).toEqual(decisionRows.map(r => r.id).sort())
    await Promise.all(actions.map(action => pipeline.processReviewAction(action)))

    // 两条都从 plan 走到 plan 延后人审门（review-plan 机审已过）
    for (const id of ids) {
      const rows = (await pool.query('select category, status from records where requirement_id = $1 order by created_at asc', [id])).rows as { category: string; status: string }[]
      expect(rows.map(r => r.category)).toEqual(['decision', 'plan', 'review-plan'])
      expect(rows.find(r => r.category === 'plan')?.status).toBe('waiting_review')
      expect(rows.find(r => r.category === 'review-plan')?.status).toBe('success')
    }
    expect(executor.calls.filter(call => call.category === 'plan')).toHaveLength(2)
    expect(executor.calls.filter(call => call.category === 'review-plan')).toHaveLength(2)
  })

  it('routes the background resolve task through the dispatchBackground hook when provided', async () => {
    const requirements = new RequirementsRepo({ pgmas: writeSeam(pool), database: TEST_DATABASE, userId: TEST_USER_ID })
    const projects = new ProjectsRepo({ pgmas: writeSeam(pool), database: TEST_DATABASE })
    const questions = new QuestionsRepo({ pgmas: writeSeam(pool), database: TEST_DATABASE })
    const reviews = new ReviewsRepo({ pgmas: writeSeam(pool), database: TEST_DATABASE })
    const project = (await projects.list())[0]
    const id = track((await requirements.create('派发钩子测试', undefined, project.id)).id)
    await requirements.transition(id, 'open')
    await requirements.transition(id, 'in_progress')
    await requirements.markMerging(id, 'https://gitee.com/o/r/pulls/42')

    const executor = new FakeExecutor(() => ({
      stopReason: 'completed',
      structured: { isError: false, message: 'ok', artifacts: [], questions: [] },
    }))
    const captured: (() => Promise<void>)[] = []
    const { deps } = makeDeps(executor, requirements, projects, questions, reviews)
    deps.dispatchBackground = task => { captured.push(task) }
    const pipeline = new WorkerPipeline(deps)

    const started = await pipeline.startResolve(id)
    // 钩子被调用：任务没有自动 fire-and-forget（record 保持 running，等外部派发）
    expect(captured).toHaveLength(1)
    expect((await pool.query('select status from records where id = $1', [started.id])).rows[0]).toMatchObject({ status: 'running' })
    // 手动执行捕获的任务 → 正常落定（与 service 端 withSlot 派发等价）
    await captured[0]!()
    const row = (await pool.query('select status from records where id = $1', [started.id])).rows[0] as { status: string }
    expect(row.status).toBe('success')
  })

  it('finalizeMerged pulls main, cleans up the worktree for a done requirement once', async () => {
    const requirements = new RequirementsRepo({ pgmas: writeSeam(pool), database: TEST_DATABASE, userId: TEST_USER_ID })
    const projects = new ProjectsRepo({ pgmas: writeSeam(pool), database: TEST_DATABASE })
    const questions = new QuestionsRepo({ pgmas: writeSeam(pool), database: TEST_DATABASE })
    const reviews = new ReviewsRepo({ pgmas: writeSeam(pool), database: TEST_DATABASE })
    const project = (await projects.list())[0]
    const id = track((await requirements.create('收尾测试', undefined, project.id)).id)
    await requirements.transition(id, 'open')
    await requirements.transition(id, 'in_progress')
    await requirements.markMerging(id, 'https://gitee.com/o/r/pulls/9')
    await requirements.confirmMerged(id)
    // 模拟有一条带 branch 的 stage record（首条 record 提供 branch_id）
    await requirements.appendRecord({ requirementId: id, category: 'cleanup-seed', status: 'success', branchId: `req-${id.slice(0, 8)}`, skills: [] })

    const executor = new FakeExecutor(() => ({ stopReason: 'completed', structured: { isError: false, message: 'ok', artifacts: [], questions: [] } }))
    const worktree = new FakeWorktree()
    const { deps } = makeDeps(executor, requirements, projects, questions, reviews, worktree)
    const pipeline = new WorkerPipeline(deps)

    await pipeline.finalizeMerged()
    expect(worktree.pulls).toContain('main')
    expect(worktree.removes).toContain(`req-${id.slice(0, 8)}`)
    const cleanup = (await pool.query('select category, status from records where requirement_id = $1 and category = $2', [id, 'cleanup'])).rows as { category: string; status: string }[]
    expect(cleanup).toHaveLength(1)
    expect(cleanup[0]?.status).toBe('success')

    // 幂等：再跑一次不再 pull / 清理
    worktree.pulls.length = 0
    worktree.removes.length = 0
    await pipeline.finalizeMerged()
    expect(worktree.pulls).toHaveLength(0)
    expect(worktree.removes).toHaveLength(0)
  })

  it('finalizeMerged does not record cleanup when main pull fails (retried next tick)', async () => {
    const requirements = new RequirementsRepo({ pgmas: writeSeam(pool), database: TEST_DATABASE, userId: TEST_USER_ID })
    const projects = new ProjectsRepo({ pgmas: writeSeam(pool), database: TEST_DATABASE })
    const questions = new QuestionsRepo({ pgmas: writeSeam(pool), database: TEST_DATABASE })
    const reviews = new ReviewsRepo({ pgmas: writeSeam(pool), database: TEST_DATABASE })
    const project = (await projects.list())[0]
    const id = track((await requirements.create('收尾 pull 失败测试', undefined, project.id)).id)
    await requirements.transition(id, 'open')
    await requirements.transition(id, 'in_progress')
    await requirements.markMerging(id, 'https://gitee.com/o/r/pulls/10')
    await requirements.confirmMerged(id)
    await requirements.appendRecord({ requirementId: id, category: 'cleanup-seed', status: 'success', branchId: `req-${id.slice(0, 8)}`, skills: [] })

    const executor = new FakeExecutor(() => ({ stopReason: 'completed', structured: { isError: false, message: 'ok', artifacts: [], questions: [] } }))
    const worktree = new FakeWorktree()
    worktree.failPull = true
    const { deps } = makeDeps(executor, requirements, projects, questions, reviews, worktree)
    const pipeline = new WorkerPipeline(deps)

    // pull 失败 → 抛出，不记 cleanup、不删 worktree（下轮 tick 重试）
    await expect(pipeline.finalizeMerged()).rejects.toThrow('git pull main 失败')
    const cleanup = (await pool.query('select category from records where requirement_id = $1 and category = $2', [id, 'cleanup'])).rows as { category: string }[]
    expect(cleanup).toHaveLength(0)
    expect(worktree.removes).toHaveLength(0)

    // 下一轮 pull 成功 → 收尾完成（pull + 清理 + cleanup record）
    worktree.failPull = false
    await pipeline.finalizeMerged()
    expect(worktree.pulls).toEqual(['main'])
    expect(worktree.removes).toContain(`req-${id.slice(0, 8)}`)
    const cleanupDone = (await pool.query('select category, status from records where requirement_id = $1 and category = $2', [id, 'cleanup'])).rows as { category: string; status: string }[]
    expect(cleanupDone).toHaveLength(1)
    expect(cleanupDone[0]?.status).toBe('success')
  })

  it('阶段成功后调用兜底提交钩子（失败/挂起阶段不调用）', async () => {
    const requirements = new RequirementsRepo({ pgmas: writeSeam(pool), database: TEST_DATABASE, userId: TEST_USER_ID })
    const projects = new ProjectsRepo({ pgmas: writeSeam(pool), database: TEST_DATABASE })
    const questions = new QuestionsRepo({ pgmas: writeSeam(pool), database: TEST_DATABASE })
    const reviews = new ReviewsRepo({ pgmas: writeSeam(pool), database: TEST_DATABASE })
    await openRequirement(requirements)
    const commits: { wtPath: string; message: string }[] = []
    // a. 阶段成功（decision，即使随后挂人审门）→ 兜底提交被调用一次
    const okExecutor = new FakeExecutor(() => ({ stopReason: 'completed', structured: { isError: false, message: 'ok', artifacts: ['docs/plans/001.md'], questions: [] } }))
    const okDeps = makeDeps(okExecutor, requirements, projects, questions, reviews).deps
    okDeps.commitWorktree = async (_project, wtPath, message) => { commits.push({ wtPath, message }) }
    await new WorkerPipeline(okDeps).claimAndRun()
    expect(commits).toHaveLength(1)
    expect(commits[0]?.message).toContain('decision(pipeline)')
    expect(commits[0]?.wtPath).toContain('req-')
    // b. 阶段失败（isError）→ 不调用兜底提交
    const failExecutor = new FakeExecutor(() => ({ stopReason: 'completed', structured: { isError: true, message: '挂了', artifacts: [], questions: [] } }))
    const failDeps = makeDeps(failExecutor, requirements, projects, questions, reviews).deps
    failDeps.commitWorktree = async () => { commits.push({ wtPath: 'SHOULD-NOT', message: '' }) }
    const failId = await openRequirement(requirements)
    await new WorkerPipeline(failDeps).claimAndRun()
    expect(commits.some(c => c.wtPath === 'SHOULD-NOT')).toBe(false)
    const failRow = (await pool.query('select status from records where requirement_id = $1', [failId])).rows[0] as { status: string }
    expect(failRow.status).toBe('failed')
  })

  it('启动自愈①：把残留 running record 标记 failed（复用同一 record，不新开）', async () => {
    const requirements = new RequirementsRepo({ pgmas: writeSeam(pool), database: TEST_DATABASE, userId: TEST_USER_ID })
    const projects = new ProjectsRepo({ pgmas: writeSeam(pool), database: TEST_DATABASE })
    const questions = new QuestionsRepo({ pgmas: writeSeam(pool), database: TEST_DATABASE })
    const reviews = new ReviewsRepo({ pgmas: writeSeam(pool), database: TEST_DATABASE })
    const id = await openRequirement(requirements)
    await requirements.transition(id, 'in_progress')
    // 模拟上一进程死在会话中途：直接落一条 running record
    await pool.query(
      "insert into records (id, requirement_id, category, title, status, branch_id, retry_count, created_at, updated_at) values (gen_random_uuid(), $1, 'coding', 'coding', 'running', $2, 0, now(), now())",
      [id, `req-${id.slice(0, 8)}`],
    )
    const executor = new FakeExecutor(() => ({ stopReason: 'completed', structured: { isError: false, message: 'ok', artifacts: [], questions: [] } }))
    const { deps } = makeDeps(executor, requirements, projects, questions, reviews)
    const pipeline = new WorkerPipeline(deps)
    expect(await pipeline.markStaleRunning()).toBeGreaterThanOrEqual(1)
    const row = (await pool.query('select status, result from records where requirement_id = $1 and category = $2', [id, 'coding'])).rows[0] as { status: string; result: string }
    expect(row.status).toBe('failed')
    expect(row.result).toContain('进程重启')
    // 交给重试路径（复用同一 record）即可恢复
    expect((await pipeline.listRetryable()).some(r => r.requirement_id === id)).toBe(true)
  })

  it('启动自愈②：review-code success 但从未建 merge 的僵尸需求 → 补 merge（push + PR → merging）', async () => {
    const requirements = new RequirementsRepo({ pgmas: writeSeam(pool), database: TEST_DATABASE, userId: TEST_USER_ID })
    const projects = new ProjectsRepo({ pgmas: writeSeam(pool), database: TEST_DATABASE })
    const questions = new QuestionsRepo({ pgmas: writeSeam(pool), database: TEST_DATABASE })
    const reviews = new ReviewsRepo({ pgmas: writeSeam(pool), database: TEST_DATABASE })
    const tokenProjectId = await createTokenProject()
    const id = await openRequirement(requirements, tokenProjectId)
    await requirements.transition(id, 'in_progress')
    // 造 ADR-025 同款缺口：6 阶段全部 success、无 merge record
    for (const cat of STAGES.map(s => s.category)) {
      await requirements.appendRecord({ requirementId: id, category: cat, status: 'success', branchId: `req-${id.slice(0, 8)}`, skills: [], result: 'ok' })
    }
    const executor = new FakeExecutor(() => ({ stopReason: 'completed', structured: { isError: false, message: 'ok', artifacts: [], questions: [] } }))
    const { deps, worktree } = makeDeps(executor, requirements, projects, questions, reviews)
    const pipeline = new WorkerPipeline(deps)
    const gaps = (await pipeline.listStuckGaps()).filter(g => g.requirement_id === id)
    expect(gaps).toHaveLength(1)
    expect(gaps[0]?.last_category).toBe('review-code')
    await pipeline.resumeGap(gaps[0]!)
    const mergeRows = (await pool.query('select status, artifacts from records where requirement_id = $1 and category = $2', [id, 'merge'])).rows as { status: string; artifacts: string[] }[]
    expect(mergeRows).toHaveLength(1)
    expect(mergeRows[0]?.status).toBe('success')
    expect(mergeRows[0]?.artifacts[0]).toBe('https://gitee.com/o/r/pulls/1')
    const req = (await pool.query('select status from requirements where id = $1', [id])).rows[0] as { status: string }
    expect(req.status).toBe('merging')
    expect(worktree.pushes).toEqual([`req-${id.slice(0, 8)}`])
  })

  it('启动自愈③：中途缺口（contract success 后进程死亡）→ 从下一阶段 review-code 续跑', async () => {
    const requirements = new RequirementsRepo({ pgmas: writeSeam(pool), database: TEST_DATABASE, userId: TEST_USER_ID })
    const projects = new ProjectsRepo({ pgmas: writeSeam(pool), database: TEST_DATABASE })
    const questions = new QuestionsRepo({ pgmas: writeSeam(pool), database: TEST_DATABASE })
    const reviews = new ReviewsRepo({ pgmas: writeSeam(pool), database: TEST_DATABASE })
    const tokenProjectId = await createTokenProject()
    const id = await openRequirement(requirements, tokenProjectId)
    await requirements.transition(id, 'in_progress')
    // 前 5 阶段 success（最新 = contract），无 merge
    const cats = STAGES.map(s => s.category).slice(0, -1)
    for (const cat of cats) {
      await requirements.appendRecord({ requirementId: id, category: cat, status: 'success', branchId: `req-${id.slice(0, 8)}`, skills: [], result: 'ok' })
    }
    const executor = new FakeExecutor(() => ({ stopReason: 'completed', structured: { isError: false, message: 'ok', artifacts: [], questions: [] } }))
    const { deps, worktree } = makeDeps(executor, requirements, projects, questions, reviews)
    const pipeline = new WorkerPipeline(deps)
    const mine = (await pipeline.listStuckGaps()).find(g => g.requirement_id === id)
    expect(mine?.last_category).toBe('contract')
    await pipeline.resumeGap(mine!)
    const rows = (await pool.query('select category from records where requirement_id = $1 order by created_at asc', [id])).rows as { category: string }[]
    expect(rows.map(r => r.category)).toEqual([...STAGES.map(s => s.category), 'merge'])
    const req = (await pool.query('select status from requirements where id = $1', [id])).rows[0] as { status: string }
    expect(req.status).toBe('merging')
    expect(worktree.pushes).toEqual([`req-${id.slice(0, 8)}`])
  })

  it('启动自愈④：不误伤在途/挂起状态（running 与 waiting_review 不出现在缺口列表）', async () => {
    const requirements = new RequirementsRepo({ pgmas: writeSeam(pool), database: TEST_DATABASE, userId: TEST_USER_ID })
    const projects = new ProjectsRepo({ pgmas: writeSeam(pool), database: TEST_DATABASE })
    const questions = new QuestionsRepo({ pgmas: writeSeam(pool), database: TEST_DATABASE })
    const reviews = new ReviewsRepo({ pgmas: writeSeam(pool), database: TEST_DATABASE })
    const tokenProjectId = await createTokenProject()
    // a. 最新 record = running（在途会话）
    const runningId = await openRequirement(requirements, tokenProjectId)
    await requirements.transition(runningId, 'in_progress')
    await requirements.appendRecord({ requirementId: runningId, category: 'coding', status: 'running', branchId: `req-${runningId.slice(0, 8)}`, skills: [] })
    // b. 最新 record = waiting_review（人工审核门挂起）
    const gatedId = await openRequirement(requirements, tokenProjectId)
    await requirements.transition(gatedId, 'in_progress')
    await requirements.appendRecord({ requirementId: gatedId, category: 'decision', status: 'waiting_review', branchId: `req-${gatedId.slice(0, 8)}`, skills: [] })
    const executor = new FakeExecutor(() => ({ stopReason: 'completed', structured: { isError: false, message: 'ok', artifacts: [], questions: [] } }))
    const { deps } = makeDeps(executor, requirements, projects, questions, reviews)
    const pipeline = new WorkerPipeline(deps)
    const gaps = await pipeline.listStuckGaps()
    expect(gaps.some(g => g.requirement_id === runningId)).toBe(false)
    expect(gaps.some(g => g.requirement_id === gatedId)).toBe(false)
  })
})

describe('buildPrompt / buildPrPrompt / parse helpers', () => {
  it('assembles the stage prompt template', () => {
    const stage: StageDef = STAGES[1]!
    const prompt = buildPrompt({
      stage,
      wtPath: '/wt/req-abc',
      repo: '/repo',
      skillMd: 'SKILL 正文',
      title: '标题',
      description: '描述',
      priorArtifacts: ['docs/plans/001.md'],
      userAnswers: [{ question: '选 A？', answer: '选 A' }],
    })
    expect(prompt).toContain('plan')
    expect(prompt).toContain('/wt/req-abc')
    expect(prompt).toContain('SKILL 正文')
    expect(prompt).toContain('选 A？  A: 选 A')
    // ask_user 引导：子代理不可用 → 放进 questions 字段；问题攒齐一次性发
    expect(prompt).toContain('ask_user_question 工具在此不可用')
    expect(prompt).toContain('questions=[{question, options}]')
    expect(prompt).toContain('注意不要遇到一个问题问一个')
    expect(prompt).toContain('没有其他问题要确认了再一起发')
  })

  it('injects review feedback into the prompt when re-running after rejection', () => {
    const stage: StageDef = STAGES[0]!
    const prompt = buildPrompt({
      stage,
      wtPath: '/wt/req-abc',
      repo: '/repo',
      skillMd: 'SKILL 正文',
      title: '标题',
      description: null,
      priorArtifacts: [],
      userAnswers: [],
      feedback: 'ADR 缺少方案对比',
    })
    expect(prompt).toContain('审核整改意见（驳回重跑）')
    expect(prompt).toContain('ADR 缺少方案对比')
  })

  it('assembles the PR guide with platform detection, injected token, and JSON contract', () => {
    const prompt = buildPrPrompt({ wtPath: '/wt/x', repo: '/repo', title: 'T', description: 'D', branch: 'req-abc', token: 'tok-inline-123' })
    expect(prompt).toContain('gitee.com')
    expect(prompt).toContain('Authorization: token <PR_TOKEN 值')
    expect(prompt).toContain('# PR_TOKEN')
    expect(prompt).toContain('tok-inline-123')
    expect(prompt).not.toContain('$PR_TOKEN')
    expect(prompt).toContain('"is_ok"')
    expect(prompt).toContain('req-abc')
    // 不确定点攒齐一次性列进 error
    expect(prompt).toContain('不要遇到一个问题问一个')
    expect(prompt).toContain('一次性在 error 中完整列出')
  })

  it('assembles the resolve-conflict prompt with fetch+merge+commit+push steps and batched question guidance', () => {
    const prompt = buildResolvePrompt({
      wtPath: '/wt/req-abc',
      repo: '/repo',
      branch: 'req-abc',
      title: 'T',
      description: 'D',
      userAnswers: [{ question: '保留哪边？', answer: '保留任务分支' }],
    })
    expect(prompt).toContain('/wt/req-abc')
    expect(prompt).toContain('req-abc')
    expect(prompt).toContain('fetch origin')
    expect(prompt).toContain('merge origin/main')
    expect(prompt).toContain('commit -m "resolve merge conflicts with origin/main"')
    expect(prompt).toContain('push')
    expect(prompt).toContain('questions=[{question, options}]')
    expect(prompt).toContain('注意不要遇到一个问题问一个')
    expect(prompt).toContain('没有其他问题要确认了再一起发')
    expect(prompt).toContain('Q: 保留哪边？  A: 保留任务分支')
  })

  it('parses valid and rejects invalid structured results', () => {
    expect(parseStageResult({ isError: false, message: 'ok', artifacts: ['a'], questions: [{ question: 'q', options: ['1'] }] }))
      .toMatchObject({ isError: false, artifacts: ['a'] })
    expect(parseStageResult(null)).toBeNull()
    expect(parsePrResult({ is_ok: 'true', pr_url: 'https://x/pulls/1' })).toMatchObject({ isOk: true, prUrl: 'https://x/pulls/1' })
    expect(parsePrResult({ is_ok: false, error: 'boom' })).toMatchObject({ isOk: false, error: 'boom' })
    expect(parsePrResult({ nope: 1 })).toBeNull()
  })

  it('isPathArtifact 只把不含空白的相对路径条目当作产物路径', () => {
    expect(isPathArtifact('decisions/028-artifact-file-transmission.md')).toBe(true)
    expect(isPathArtifact('docs/plans/20-x/README.md')).toBe(true)
    expect(isPathArtifact('')).toBe(false)
    expect(isPathArtifact('edd5302 docs(decision): ADR 定稿')).toBe(false) // commit 描述含空白
    expect(isPathArtifact('commit 05b3898 docs(plan): 修订')).toBe(false)
    expect(isPathArtifact('  ')).toBe(false)
  })

  it('missingArtifacts 只报告真实缺失的路径条目，且跳过 commit 描述', async () => {
    const exists = async (_wt: string, rel: string): Promise<boolean> => rel !== 'ghost.md'
    const missing = await missingArtifacts('/wt', ['real.md', 'ghost.md', 'commit abc123 docs: x'], exists)
    expect(missing).toEqual(['ghost.md'])
    expect(await missingArtifacts('/wt', [], exists)).toEqual([])
    expect(await missingArtifacts('/wt', ['a.md', 'b.md'], async () => true)).toEqual([])
  })

  it('REVIEW_GATED covers exactly decision, and plan is a deferred gate after review-plan', () => {
    expect(REVIEW_GATED).toEqual(['decision'])
    expect(DEFERRED_REVIEW_GATES).toEqual([{ category: 'plan', anchor: 'review-plan' }])
  })
})

describe('withinWindow 时段门控', () => {
  const at = (hour: number): Date => { const d = new Date(); d.setHours(hour, 0, 0, 0); return d }
  const cfg = (startHour: number, endHour: number, enabled = true) => ({ timeWindowEnabled: enabled, startHour, endHour })

  it('disabled 时恒为 true', () => {
    expect(withinWindow(cfg(9, 18, false), at(3))).toBe(true)
    expect(withinWindow(cfg(9, 18, false), at(12))).toBe(true)
  })

  it('同日内窗口：含 start、不含 end', () => {
    expect(withinWindow(cfg(9, 18), at(8))).toBe(false)
    expect(withinWindow(cfg(9, 18), at(9))).toBe(true)
    expect(withinWindow(cfg(9, 18), at(17))).toBe(true)
    expect(withinWindow(cfg(9, 18), at(18))).toBe(false)
    expect(withinWindow(cfg(9, 18), at(23))).toBe(false)
  })

  it('跨天窗口：22:00→06:00', () => {
    expect(withinWindow(cfg(22, 6), at(23))).toBe(true)
    expect(withinWindow(cfg(22, 6), at(2))).toBe(true)
    expect(withinWindow(cfg(22, 6), at(12))).toBe(false)
    expect(withinWindow(cfg(22, 6), at(6))).toBe(false)
  })

  it('起=止视为不限制', () => {
    expect(withinWindow(cfg(9, 9), at(3))).toBe(true)
    expect(withinWindow(cfg(0, 0), at(12))).toBe(true)
  })
})

describe('runLanes 并发 lanes', () => {
  it('并发跑 count 条并返回实际领取数', async () => {
    let active = 0
    let peak = 0
    let started = 0
    const run = async (): Promise<boolean> => {
      started += 1
      active += 1
      peak = Math.max(peak, active)
      await new Promise(resolve => setTimeout(resolve, 20))
      active -= 1
      return true
    }
    const claimed = await runLanes(3, run)
    expect(claimed).toBe(3)
    expect(started).toBe(3)
    expect(peak).toBe(3)
  })

  it('只统计实际领取（返回 true）的 lane', async () => {
    let calls = 0
    const claimed = await runLanes(2, async () => {
      calls += 1
      return calls === 1
    })
    expect(claimed).toBe(1)
    expect(calls).toBe(2)
  })
})

describe('configFor 阶段模型覆盖', () => {
  it('claimAndRun 将 decision 的 agentOptions 透传给执行器', async () => {
    const requirements = new RequirementsRepo({ pgmas: writeSeam(pool), database: TEST_DATABASE, userId: TEST_USER_ID })
    const projects = new ProjectsRepo({ pgmas: writeSeam(pool), database: TEST_DATABASE })
    const questions = new QuestionsRepo({ pgmas: writeSeam(pool), database: TEST_DATABASE, userId: TEST_USER_ID })
    const reviews = new ReviewsRepo({ pgmas: writeSeam(pool), database: TEST_DATABASE, userId: TEST_USER_ID })
    const project = await projects.getById('00000000-0000-4000-8000-0000000000c1')
    track(await openRequirement(requirements, project?.id))
    const executor = new FakeExecutor(() => ({ stopReason: 'completed', structured: { isError: false, message: 'ok', artifacts: [], questions: [] } }))
    const { deps } = makeDeps(
      executor,
      requirements,
      projects,
      questions,
      reviews,
      new FakeWorktree(),
      1,
      category => category === 'decision' ? { model: 'deepseek-v4-pro' } : undefined,
    )
    const pipeline = new WorkerPipeline(deps)

    await pipeline.claimAndRun()

    expect(executor.agentOptionsCalls[0]).toEqual({ model: 'deepseek-v4-pro' })
    expect(executor.agentOptionsCalls.slice(1).every(options => options === undefined)).toBe(true)
  })
})
