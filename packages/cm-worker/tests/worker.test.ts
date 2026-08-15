import { afterAll, describe, expect, it } from 'vitest'
import pg from 'pg'
import {
  ProjectsRepo,
  QuestionsRepo,
  RequirementsRepo,
  type WriteSeam,
} from '@auto-coding/cm-flow'
import {
  STAGES,
  WorkerPipeline,
  buildPrompt,
  buildPrPrompt,
  parsePrResult,
  parseStageResult,
  type PipelineWorktree,
  type PrExecution,
  type StageDef,
  type StageExecution,
  type StageInput,
} from '../src/pipeline.ts'

const TEST_DATABASE = 'cm'
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
  prCalls: { prompt: string }[] = []
  constructor(
    private readonly handler: (input: StageInput) => StageExecution,
    private readonly prHandler: () => PrExecution = () => ({ isOk: true, prUrl: 'https://gitee.com/o/r/pulls/1' }),
  ) {}
  run(input: StageInput): Promise<StageExecution> {
    this.calls.push(input)
    return Promise.resolve(this.handler(input))
  }
  runPr(input: { prompt: string; repo: string }): Promise<PrExecution> {
    this.prCalls.push({ prompt: input.prompt })
    return Promise.resolve(this.prHandler())
  }
}

/** 可观察的 fake worktree。 */
class FakeWorktree implements PipelineWorktree {
  pushes: string[] = []
  removes: string[] = []
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
  worktree: FakeWorktree = new FakeWorktree(),
  maxRetries = 1,
): MakeDepsResult {
  return {
    deps: {
      pgmas: writeSeam(pool),
      database: TEST_DATABASE,
      requirements,
      projects,
      questions,
      executor: executor as unknown as { run(input: StageInput): Promise<StageExecution>; runPr(input: { prompt: string; repo: string }): Promise<PrExecution> },
      readSkillMd: async () => 'SKILL 内容占位',
      worktreeFor: () => worktree,
      maxRetries,
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

describe.skipIf(!(await reachable()))('WorkerPipeline against the live cm database', () => {
  it('claims an open requirement and runs the full stage chain + merge to merging', async () => {
    const requirements = new RequirementsRepo({ pgmas: writeSeam(pool), database: TEST_DATABASE, userId: TEST_USER_ID })
    const projects = new ProjectsRepo({ pgmas: writeSeam(pool), database: TEST_DATABASE })
    const questions = new QuestionsRepo({ pgmas: writeSeam(pool), database: TEST_DATABASE })
    const tokenProjectId = await createTokenProject()
    const id = await openRequirement(requirements, tokenProjectId)

    const executor = new FakeExecutor(() => ({
      stopReason: 'completed',
      structured: { isError: false, message: 'ok', artifacts: ['docs/plans/001.md'], questions: [] },
    }))
    const { deps, worktree } = makeDeps(executor, requirements, projects, questions)
    const pipeline = new WorkerPipeline(deps)

    expect(await pipeline.claimAndRun()).toBe(true)
    const rows = (await pool.query('select category, status from records where requirement_id = $1 order by created_at asc', [id])).rows as { category: string; status: string }[]
    // 6 阶段 + 1 merge
    expect(rows.map(r => r.category)).toEqual([...STAGES.map(s => s.category), 'merge'])
    expect(rows.every(r => r.status === 'success')).toBe(true)
    // PR 任务被调用并拿到指导指令
    expect(executor.prCalls).toHaveLength(1)
    expect(executor.prCalls[0]?.prompt).toContain('gitee.com')
    expect(worktree.pushes).toEqual([`req-${id.slice(0, 8)}`])
    // 需求进入 merging（PR 已建）
    const req = (await pool.query('select status from requirements where id = $1', [id])).rows[0] as { status: string }
    expect(req.status).toBe('merging')
    // merge record 带 prUrl
    const mergeRecord = rows.find(r => r.category === 'merge')
    const artifacts = (await pool.query('select artifacts from records where requirement_id = $1 and category = $2', [id, 'merge'])).rows[0] as { artifacts: string[] }
    expect(artifacts.artifacts[0]).toBe('https://gitee.com/o/r/pulls/1')
    expect(mergeRecord?.status).toBe('success')
  })

  it('pauses to waiting_reply with questions when a stage asks the user', async () => {
    const requirements = new RequirementsRepo({ pgmas: writeSeam(pool), database: TEST_DATABASE, userId: TEST_USER_ID })
    const projects = new ProjectsRepo({ pgmas: writeSeam(pool), database: TEST_DATABASE })
    const questions = new QuestionsRepo({ pgmas: writeSeam(pool), database: TEST_DATABASE })
    const id = await openRequirement(requirements)

    const executor = new FakeExecutor((input: StageInput) =>
      input.category === 'plan'
        ? {
          stopReason: 'completed',
          structured: { isError: false, message: '需要决策', artifacts: [], questions: [{ question: '方案 A 还是 B？', options: ['A', 'B'] }] },
        }
        : { stopReason: 'completed', structured: { isError: false, message: 'ok', artifacts: [], questions: [] } })
    const { deps } = makeDeps(executor, requirements, projects, questions)
    const pipeline = new WorkerPipeline(deps)

    expect(await pipeline.claimAndRun()).toBe(true)
    const records = (await pool.query('select category, status from records where requirement_id = $1 order by created_at asc', [id])).rows as { category: string; status: string }[]
    expect(records.find(r => r.category === 'plan')?.status).toBe('waiting_reply')
    expect(records.at(-1)?.category).toBe('plan')
    const planRecord = (await pool.query('select id from records where requirement_id = $1 and category = $2', [id, 'plan'])).rows[0] as { id: string }
    const pending = await questions.pendingByRecord(planRecord.id)
    expect(pending).toHaveLength(1)
  })

  it('resumes a waiting_reply record once all its questions are answered', async () => {
    const requirements = new RequirementsRepo({ pgmas: writeSeam(pool), database: TEST_DATABASE, userId: TEST_USER_ID })
    const projects = new ProjectsRepo({ pgmas: writeSeam(pool), database: TEST_DATABASE })
    const questions = new QuestionsRepo({ pgmas: writeSeam(pool), database: TEST_DATABASE })
    const tokenProjectId = await createTokenProject()
    const id = await openRequirement(requirements, tokenProjectId)

    let planCalls = 0
    const executor = new FakeExecutor((input: StageInput) => {
      if (input.category === 'plan') {
        planCalls += 1
        if (planCalls === 1) {
          return {
            stopReason: 'completed',
            structured: {
              isError: false, message: '需要决策', artifacts: [],
              questions: [
                { question: '方案 A 还是 B？', options: ['A', 'B'] },
                { question: '补充说明？', options: [] },
              ],
            },
          }
        }
        expect(input.prompt).toContain('用户答复')
        expect(input.prompt).toContain('选 A')
      }
      return { stopReason: 'completed', structured: { isError: false, message: 'ok', artifacts: [], questions: [] } }
    })
    const { deps } = makeDeps(executor, requirements, projects, questions)
    const pipeline = new WorkerPipeline(deps)

    await pipeline.claimAndRun()
    const planRecord = (await pool.query('select id from records where requirement_id = $1 and category = $2', [id, 'plan'])).rows[0] as { id: string }
    const pending = await questions.pendingByRecord(planRecord.id)
    expect(pending).toHaveLength(2)

    await questions.answer(pending[0]!.id, '选 A')
    await pipeline.resumeWaiting()
    expect((await questions.pendingByRecord(planRecord.id))).toHaveLength(1)
    let status = (await pool.query('select status from records where id = $1', [planRecord.id])).rows[0] as { status: string }
    expect(status.status).toBe('waiting_reply')

    await questions.answer(pending[1]!.id, '补充：A 方案')
    await pipeline.resumeWaiting()
    const rows = (await pool.query('select category, status from records where requirement_id = $1 order by created_at asc', [id])).rows as { category: string; status: string }[]
    expect(rows.filter(r => r.category === 'plan')).toHaveLength(1)
    expect(rows.filter(r => r.category === 'plan')[0]?.status).toBe('success')
    expect(rows.every(r => r.status === 'success')).toBe(true)
    status = (await pool.query('select status from records where id = $1', [planRecord.id])).rows[0] as { status: string }
    expect(status.status).toBe('success')
  })

  it('marks a failing stage as failed and stops the chain', async () => {
    const requirements = new RequirementsRepo({ pgmas: writeSeam(pool), database: TEST_DATABASE, userId: TEST_USER_ID })
    const projects = new ProjectsRepo({ pgmas: writeSeam(pool), database: TEST_DATABASE })
    const questions = new QuestionsRepo({ pgmas: writeSeam(pool), database: TEST_DATABASE })
    const id = await openRequirement(requirements)

    const executor = new FakeExecutor(() => ({
      stopReason: 'completed',
      structured: { isError: true, message: '架构冲突', artifacts: [], questions: [] },
    }))
    const { deps } = makeDeps(executor, requirements, projects, questions)
    const pipeline = new WorkerPipeline(deps)

    await pipeline.claimAndRun()
    const records = (await pool.query('select category, status, result from records where requirement_id = $1 order by created_at asc', [id])).rows as { category: string; status: string; result: string }[]
    expect(records).toHaveLength(1)
    expect(records[0]?.status).toBe('failed')
    expect(records[0]?.result).toBe('架构冲突')
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
    const id = track((await requirements.create('无 token 测试', undefined, project.id)).id)
    await requirements.transition(id, 'open')

    const executor = new FakeExecutor(() => ({ stopReason: 'completed', structured: { isError: false, message: 'ok', artifacts: [], questions: [] } }))
    const { deps } = makeDeps(executor, requirements, projectsRepo, questions)
    const pipeline = new WorkerPipeline(deps)

    await pipeline.claimAndRun()
    expect(executor.prCalls).toHaveLength(0)
    const mergeRecord = (await pool.query('select id, status from records where requirement_id = $1 and category = $2', [id, 'merge'])).rows[0] as { id: string; status: string }
    expect(mergeRecord.status).toBe('waiting_reply')
    const pending = await questions.pendingByRecord(mergeRecord.id)
    expect(pending).toHaveLength(1)
    expect(pending[0]?.question).toContain('PR token 未配置')
    const req = (await pool.query('select status from requirements where id = $1', [id])).rows[0] as { status: string }
    expect(req.status).toBe('in_progress')
  })

  it('retries a failed stage up to maxRetries and continues the chain on success', async () => {
    const requirements = new RequirementsRepo({ pgmas: writeSeam(pool), database: TEST_DATABASE, userId: TEST_USER_ID })
    const projects = new ProjectsRepo({ pgmas: writeSeam(pool), database: TEST_DATABASE })
    const questions = new QuestionsRepo({ pgmas: writeSeam(pool), database: TEST_DATABASE })
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
    const { deps } = makeDeps(executor, requirements, projects, questions)
    const pipeline = new WorkerPipeline(deps)

    await pipeline.claimAndRun()
    expect(decisionCalls).toBe(1)
    await pipeline.retryFailed()
    // 重试成功：decision 2 条（failed + success），后续阶段链 + merge 走完 → merging
    const decisionRows = (await pool.query('select status from records where requirement_id = $1 and category = $2 order by created_at asc', [id, 'decision'])).rows as { status: string }[]
    expect(decisionRows.map(r => r.status)).toEqual(['failed', 'success'])
    const req = (await pool.query('select status from requirements where id = $1', [id])).rows[0] as { status: string }
    expect(req.status).toBe('merging')
  })

  it('moves the requirement back to open when retries are exhausted', async () => {
    const requirements = new RequirementsRepo({ pgmas: writeSeam(pool), database: TEST_DATABASE, userId: TEST_USER_ID })
    const projects = new ProjectsRepo({ pgmas: writeSeam(pool), database: TEST_DATABASE })
    const questions = new QuestionsRepo({ pgmas: writeSeam(pool), database: TEST_DATABASE })
    const id = await openRequirement(requirements)

    const executor = new FakeExecutor(() => ({
      stopReason: 'completed',
      structured: { isError: true, message: '总失败', artifacts: [], questions: [] },
    }))
    const { deps } = makeDeps(executor, requirements, projects, questions, undefined, 0) // maxRetries=0 → 只允许 1 条 failed
    const pipeline = new WorkerPipeline(deps)

    await pipeline.claimAndRun()
    await pipeline.retryFailed() // 1 条 failed ≤ 1 → append 重试（第 2 次失败）
    const failed = (await pool.query('select count(*)::int as n from records where requirement_id = $1 and category = $2 and status = $3', [id, 'decision', 'failed'])).rows[0] as { n: number }
    expect(failed.n).toBe(2)
    await pipeline.retryFailed() // 2 > 1 → 超限 → requirement 回 open，不再重试
    const req = (await pool.query('select status from requirements where id = $1', [id])).rows[0] as { status: string }
    expect(req.status).toBe('open')
    const stillFailed = (await pool.query('select count(*)::int as n from records where requirement_id = $1 and category = $2 and status = $3', [id, 'decision', 'failed'])).rows as { n: number }[]
    expect(stillFailed[0]?.n).toBe(2)
  })

  it('finalizeMerged cleans up the worktree for a done requirement once', async () => {
    const requirements = new RequirementsRepo({ pgmas: writeSeam(pool), database: TEST_DATABASE, userId: TEST_USER_ID })
    const projects = new ProjectsRepo({ pgmas: writeSeam(pool), database: TEST_DATABASE })
    const questions = new QuestionsRepo({ pgmas: writeSeam(pool), database: TEST_DATABASE })
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
    const { deps } = makeDeps(executor, requirements, projects, questions, worktree)
    const pipeline = new WorkerPipeline(deps)

    await pipeline.finalizeMerged()
    expect(worktree.removes).toContain(`req-${id.slice(0, 8)}`)
    const cleanup = (await pool.query('select category, status from records where requirement_id = $1 and category = $2', [id, 'cleanup'])).rows as { category: string; status: string }[]
    expect(cleanup).toHaveLength(1)
    expect(cleanup[0]?.status).toBe('success')

    // 幂等：再跑一次不再清理
    worktree.removes.length = 0
    await pipeline.finalizeMerged()
    expect(worktree.removes).toHaveLength(0)
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
  })

  it('assembles the PR guide with platform detection and JSON contract', () => {
    const prompt = buildPrPrompt({ wtPath: '/wt/x', repo: '/repo', title: 'T', description: 'D', branch: 'req-abc' })
    expect(prompt).toContain('gitee.com')
    expect(prompt).toContain('$PR_TOKEN')
    expect(prompt).toContain('"is_ok"')
    expect(prompt).toContain('req-abc')
  })

  it('parses valid and rejects invalid structured results', () => {
    expect(parseStageResult({ isError: false, message: 'ok', artifacts: ['a'], questions: [{ question: 'q', options: ['1'] }] }))
      .toMatchObject({ isError: false, artifacts: ['a'] })
    expect(parseStageResult(null)).toBeNull()
    expect(parsePrResult({ is_ok: 'true', pr_url: 'https://x/pulls/1' })).toMatchObject({ isOk: true, prUrl: 'https://x/pulls/1' })
    expect(parsePrResult({ is_ok: false, error: 'boom' })).toMatchObject({ isOk: false, error: 'boom' })
    expect(parsePrResult({ nope: 1 })).toBeNull()
  })
})