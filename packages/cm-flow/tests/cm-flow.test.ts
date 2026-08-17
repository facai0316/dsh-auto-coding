import { afterAll, describe, expect, it } from 'vitest'
import pg from 'pg'
import {
  DEFAULT_WORKER_CONFIG,
  MAX_CONCURRENCY,
  REQUIREMENT_STATUSES,
  ProjectsRepo,
  QuestionsRepo,
  RequirementsRepo,
  ReviewsRepo,
  WorkerConfigRepo,
  normalizeWorkerConfig,
  assertStatus,
  canTransition,
  type RequirementView,
  type WriteSeam,
} from '../src/repo.ts'

/** Test-only user id so even partial cleanup never touches real panel rows. */
const TEST_USER_ID = '00000000-0000-4000-8000-00000000fffb'
const TEST_DATABASE = 'cm_fake_test'
// 防再犯：测试绝不允许直连生产 cm 库（曾因误连 cm，FakeExecutor 把真实需求的
// 剩余阶段全部空跑成假记录）。换库名必须同时改这里与 cm-worker 测试。
if ((TEST_DATABASE as string) === 'cm') throw new Error('测试禁止连生产 cm 库；请使用独立测试库（如 cm_fake_test）')

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
    // records.requirement_id 是 varchar；先删 records（级联删 ask_user_questions）
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

describe('cm-flow state machine', () => {
  it('accepts exactly the documented transitions', () => {
    expect(canTransition('draft', 'open')).toBe(true)
    expect(canTransition('draft', 'cancelled')).toBe(true)
    expect(canTransition('draft', 'done')).toBe(false)
    expect(canTransition('open', 'done')).toBe(true) // panel-era shortcut (removed with panel 改造)
    expect(canTransition('open', 'in_progress')).toBe(true)
    expect(canTransition('in_progress', 'merging')).toBe(true) // pipeline: PR 已建
    expect(canTransition('merging', 'done')).toBe(true) // pipeline: 用户确认已合并
    expect(canTransition('merging', 'cancelled')).toBe(true)
    expect(canTransition('done', 'merging')).toBe(false)
    expect(canTransition('done', 'open')).toBe(true) // panel-era reopen (removed with panel 改造)
    expect(canTransition('done', 'cancelled')).toBe(true) // panel-era delete
    expect(canTransition('cancelled', 'open')).toBe(false)
    expect(canTransition('open', 'open')).toBe(false)
  })

  it('assertStatus rejects unknown values', () => {
    for (const status of REQUIREMENT_STATUSES) expect(assertStatus(status)).toBe(status)
    expect(() => assertStatus('done-done')).toThrow(/未知需求状态/)
    expect(() => assertStatus(null)).toThrow(/未知需求状态/)
  })
})

describe.skipIf(!(await reachable()))('RequirementsRepo against the live cm database', () => {
  const repo = new RequirementsRepo({ pgmas: writeSeam(pool), database: TEST_DATABASE, userId: TEST_USER_ID })
  const seen: RequirementView[] = []

  function remember(view: RequirementView): RequirementView {
    track(view.id)
    seen.push(view)
    return view
  }

  it('creates a requirement in the open status with a trimmed title', async () => {
    const created = remember(await repo.create('  需求面板第一条  ', '来自集成测试的描述'))
    expect(created.status).toBe('open')
    expect(created.title).toBe('需求面板第一条')
    expect(created.description).toBe('来自集成测试的描述')
    expect(created.id).toBeTruthy()
    expect(created.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('rejects an empty title', async () => {
    await expect(repo.create('   ')).rejects.toThrow(/标题不能为空/)
  })

  it('lists the created requirement and reflects status transitions', async () => {
    const created = seen[0]
    expect(created).toBeDefined()
    const list = await repo.list()
    expect(list.find(item => item.id === created.id)).toBeDefined()

    const done = await repo.transition(created.id, 'done')
    expect(done.status).toBe('done')

    const reopened = await repo.transition(created.id, 'open')
    expect(reopened.status).toBe('open')
  })

  it('rejects an illegal transition and an unknown id', async () => {
    const created = seen[0]
    expect(created).toBeDefined()
    await expect(repo.transition(created.id, 'cancelled')).resolves.toMatchObject({ status: 'cancelled' })
    await expect(repo.transition(created.id, 'done')).rejects.toThrow(/非法状态流转 cancelled → done/)
    await expect(repo.transition('00000000-0000-4000-8000-000000000000', 'open')).rejects.toThrow(/需求不存在/)
  })

  it('excludes cancelled requirements from list', async () => {
    const list = await repo.list()
    expect(list.find(item => seen.some(seenItem => seenItem.id === item.id && item.status === 'cancelled'))).toBeUndefined()
  })

  it('terminates a requirement irreversibly and marks its unfinished records terminated', async () => {
    const project = (await new ProjectsRepo({ pgmas: writeSeam(pool), database: TEST_DATABASE }).list())[0]
    const id = track((await repo.create('终止测试', 'desc', project.id)).id)
    await repo.transition(id, 'open')
    await repo.transition(id, 'in_progress')
    const running = await repo.appendRecord({ requirementId: id, category: 'coding', status: 'running' })
    const success = await repo.appendRecord({ requirementId: id, category: 'decision', status: 'success' })
    const waiting = await repo.appendRecord({ requirementId: id, category: 'plan', status: 'waiting_reply' })

    const terminated = await repo.transition(id, 'terminated')
    expect(terminated.status).toBe('terminated')
    // 不可逆：terminated 无任何出路
    await expect(repo.transition(id, 'open')).rejects.toThrow(/非法状态流转 terminated/)
    // 未完成 record 标记终止，success 保留
    const records = await repo.listRecords({ requirementId: id })
    expect(records.find(r => r.id === running.id)?.status).toBe('terminated')
    expect(records.find(r => r.id === waiting.id)?.status).toBe('terminated')
    expect(records.find(r => r.id === success.id)?.status).toBe('success')
  })
})

describe.skipIf(!(await reachable()))('cm-flow migrations v2-v4 against the live cm database', () => {
  it('created projects / ask_user_questions / reviews and requirements.project_id', async () => {
    const projects = await pool.query("select to_regclass('public.projects') as rel")
    expect(projects.rows[0]?.rel).not.toBeNull()
    const questions = await pool.query("select to_regclass('public.ask_user_questions') as rel")
    expect(questions.rows[0]?.rel).not.toBeNull()
    const reviews = await pool.query("select to_regclass('public.reviews') as rel")
    expect(reviews.rows[0]?.rel).not.toBeNull()
    const column = await pool.query(`
      select 1 from information_schema.columns
      where table_name = 'requirements' and column_name = 'project_id'
    `)
    expect(column.rows.length).toBe(1)
    const index = await pool.query(`
      select 1 from pg_indexes
      where schemaname = 'public' and indexname = 'requirements_project_open_idx'
    `)
    expect(index.rows.length).toBe(1)
  })

  it('seeded the fac-ai-rs pilot project row idempotently', async () => {
    const result = await pool.query("select count(*)::int as n from projects where local_path = '/root/workspace/rust/fac-ai-rs'")
    expect(result.rows[0]?.n).toBe(1)
    // 幂等：重复迁移不产生第二行（迁移框架按 version 跳过；这里直接再跑一次构造函数验证）
    const repo2 = new RequirementsRepo({ pgmas: writeSeam(pool), database: TEST_DATABASE, userId: TEST_USER_ID })
    await repo2.list()
    const again = await pool.query("select count(*)::int as n from projects where local_path = '/root/workspace/rust/fac-ai-rs'")
    expect(again.rows[0]?.n).toBe(1)
  })
})

describe.skipIf(!(await reachable()))('ProjectsRepo against the live cm database', () => {
  const repo = new ProjectsRepo({ pgmas: writeSeam(pool), database: TEST_DATABASE })

  it('lists the seeded fac-ai-rs project without token leak', async () => {
    const list = await repo.list()
    const pilot = list.find(p => p.localPath === '/root/workspace/rust/fac-ai-rs')
    expect(pilot).toBeDefined()
    expect(pilot?.platform).toBe('gitee')
    // hasToken 反映库中真实状态（面板可能已录入 pr_token），断言随行对齐。
    const stored = await pool.query("select pr_token from projects where local_path = '/root/workspace/rust/fac-ai-rs'")
    const storedToken = stored.rows[0]?.pr_token
    expect(pilot?.hasToken).toBe(storedToken !== null && storedToken !== undefined && String(storedToken) !== '')
    expect(JSON.stringify(pilot)).not.toContain('pr_token')
  })

  it('creates a project and rejects a duplicate local path', async () => {
    const created = await repo.create({
      name: 'cm-flow-test',
      localPath: '/tmp/cm-flow-test-repo',
      gitUrl: 'git@gitee.com:test/cm-flow-test.git',
      platform: 'gitee',
      prToken: 'tok-123',
    })
    createdProjectIds.push(created.id)
    expect(created.hasToken).toBe(true)
    expect(await repo.getToken(created.id)).toBe('tok-123')

    await expect(repo.create({
      name: 'dup', localPath: '/tmp/cm-flow-test-repo', gitUrl: 'git@example.com:x/y.git', platform: 'gitee',
    })).rejects.toThrow(/duplicate key/)
    await expect(repo.create({
      name: 'bad', localPath: '/tmp/x', gitUrl: 'git@example.com:x/y.git', platform: 'gitlab',
    })).rejects.toThrow(/必须是 gitee 或 gitea/)
  })
})

describe.skipIf(!(await reachable()))('WorkerConfigRepo against the live cm database', () => {
  const repo = new WorkerConfigRepo({ pgmas: writeSeam(pool), database: TEST_DATABASE })

  it('defaults when no row exists, and round-trips a configured payload (preserving prior live config)', async () => {
    // 保存现场：运行中的 worker/面板可能已写入真实配置，测试不得覆盖。
    const prior = await repo.get()
    const priorRow = (await pool.query('select 1 from worker_config where id = 1')).rows
    await pool.query('delete from worker_config where id = 1')
    try {
      const fresh = await repo.get()
      expect(fresh.timeWindowEnabled).toBe(false)
      expect(fresh.startHour).toBe(DEFAULT_WORKER_CONFIG.startHour)
      expect(fresh.endHour).toBe(DEFAULT_WORKER_CONFIG.endHour)
      expect(fresh.concurrency).toBe(1)
      expect(fresh.stages).toEqual({})

      const saved = await repo.set({
        timeWindowEnabled: true,
        timeWindowStages: ['coding', 'merge'],
        startHour: 9,
        endHour: 18,
        concurrency: 3,
        stages: {
          decision: { model: 'deepseek-v4-pro' },
          coding: { model: 'deepseek-v4-flash', maxTokens: 8192 },
        },
        defaultModel: 'deepseek-v4-pro',
        defaultProvider: null,
        defaultMaxTokens: 4096,
      })
      expect(saved.stages.decision?.model).toBe('deepseek-v4-pro')
      expect(saved.stages.coding?.maxTokens).toBe(8192)
      expect(saved.concurrency).toBe(3)
      expect(saved.timeWindowStages).toEqual(['coding', 'merge'])

      const read = await repo.get()
      expect(read.timeWindowEnabled).toBe(true)
      expect(read.timeWindowStages).toEqual(['coding', 'merge'])
      expect(read.stages.decision?.model).toBe('deepseek-v4-pro')
      expect(read.stages.coding?.model).toBe('deepseek-v4-flash')
      expect(read.defaultMaxTokens).toBe(4096)
      expect(read.concurrency).toBe(3)
    } finally {
      // 还原现场（无行则清空，有行则写回原配置）
      if (priorRow.length === 0) {
        await pool.query('delete from worker_config where id = 1')
      } else {
        await repo.set(prior)
      }
    }
  })

  it('normalizes out-of-range hours, concurrency and empty stage entries', () => {
    expect(normalizeWorkerConfig({ timeWindowEnabled: true, startHour: -3, endHour: 99, stages: {} }))
      .toMatchObject({ startHour: 0, endHour: 23 })
    expect(normalizeWorkerConfig({ stages: { plan: { model: 'x', provider: '', maxTokens: 0 } } }))
      .toMatchObject({ stages: { plan: { model: 'x' } } })
    // 并发钳制：缺省/越界 → 1..8
    expect(normalizeWorkerConfig({}).concurrency).toBe(1)
    expect(normalizeWorkerConfig({ concurrency: 0 }).concurrency).toBe(1)
    expect(normalizeWorkerConfig({ concurrency: 99 }).concurrency).toBe(MAX_CONCURRENCY)
    expect(normalizeWorkerConfig({ concurrency: 4.9 }).concurrency).toBe(4)
    expect(normalizeWorkerConfig({ concurrency: 'abc' }).concurrency).toBe(1)
    // 时段阶段清单：null/缺省/非数组 → null（全部阶段受限，旧语义）；数组只留字符串项
    expect(normalizeWorkerConfig({})).toMatchObject({ timeWindowStages: null })
    expect(normalizeWorkerConfig({ timeWindowStages: null })).toMatchObject({ timeWindowStages: null })
    expect(normalizeWorkerConfig({ timeWindowStages: 'coding' })).toMatchObject({ timeWindowStages: null })
    expect(normalizeWorkerConfig({ timeWindowStages: [] })).toMatchObject({ timeWindowStages: [] })
    expect(normalizeWorkerConfig({ timeWindowStages: ['coding', 'merge'] })).toMatchObject({ timeWindowStages: ['coding', 'merge'] })
    expect(normalizeWorkerConfig({ timeWindowStages: ['coding', 42, null] })).toMatchObject({ timeWindowStages: ['coding'] })
  })
})

describe.skipIf(!(await reachable()))('QuestionsRepo + pipeline ledger against the live cm database', () => {
  const requirementsRepo = new RequirementsRepo({ pgmas: writeSeam(pool), database: TEST_DATABASE, userId: TEST_USER_ID })
  const questionsRepo = new QuestionsRepo({ pgmas: writeSeam(pool), database: TEST_DATABASE })

  it('create with projectId → draft; markMerging → confirmMerged full pipeline states', async () => {
    const project = (await new ProjectsRepo({ pgmas: writeSeam(pool), database: TEST_DATABASE }).list())
      .find(p => p.localPath === '/root/workspace/rust/fac-ai-rs')
    expect(project).toBeDefined()

    const created = track((await requirementsRepo.create('流水线状态链测试', undefined, project!.id)).id)
    const view = await requirementsRepo.transition(created, 'open')
    expect(view.status).toBe('open')
    await requirementsRepo.transition(created, 'in_progress')

    const merging = await requirementsRepo.markMerging(created, 'https://gitee.com/wb200327/fac-ai-rs/pulls/1')
    expect(merging.status).toBe('merging')

    const done = await requirementsRepo.confirmMerged(created)
    expect(done.status).toBe('done')
    await expect(requirementsRepo.confirmMerged(created)).rejects.toThrow(/非法状态流转 done → done/)
  })

  it('appends/settles stage ledger rows and folds them into list stages', async () => {
    const project = (await new ProjectsRepo({ pgmas: writeSeam(pool), database: TEST_DATABASE }).list())[0]
    const id = track((await requirementsRepo.create('阶段折叠测试', undefined, project.id)).id)

    const running = await requirementsRepo.appendRecord({
      requirementId: id, category: 'plan', status: 'running', skills: ['facai-plan'],
    })
    expect(running.status).toBe('running')
    expect(running.skills).toEqual(['facai-plan'])

    const settled = await requirementsRepo.updateRecord(running.id, {
      status: 'success', result: 'plan done', artifacts: ['docs/plans/01-x.md'],
    })
    expect(settled.status).toBe('success')

    const list = await requirementsRepo.list({ projectId: project.id })
    const row = list.find(item => item.id === id)
    expect(row?.stages).toEqual([
      expect.objectContaining({ category: 'plan', status: 'success' }),
    ])
  })

  it('inserts questions, lists pending, answers, and reflects answered state', async () => {
    const project = (await new ProjectsRepo({ pgmas: writeSeam(pool), database: TEST_DATABASE }).list())[0]
    const id = track((await requirementsRepo.create('问答通道测试', undefined, project.id)).id)
    const record = await requirementsRepo.appendRecord({
      requirementId: id, category: 'decision', status: 'waiting_reply', result: 'awaiting user reply',
    })

    await questionsRepo.insertMany(record.id, [
      { question: '方案选 A 还是 B？', options: ['A', 'B'] },
      { question: '补充说明？', options: [] },
    ])
    const pending = await questionsRepo.pendingByRecord(record.id)
    expect(pending).toHaveLength(2)

    const answered = await questionsRepo.answer(pending[0]!.id, '选 B')
    expect(answered.status).toBe('answered')
    expect(answered.answer).toBe('选 B')
    expect(await questionsRepo.pendingByRecord(record.id)).toHaveLength(1)
    expect((await questionsRepo.listByRecord(record.id)).find(q => q.id === answered.id)?.answeredAt).not.toBeNull()
  })
})

describe.skipIf(!(await reachable()))('ReviewsRepo against the live cm database', () => {
  const requirementsRepo = new RequirementsRepo({ pgmas: writeSeam(pool), database: TEST_DATABASE, userId: TEST_USER_ID })
  const reviewsRepo = new ReviewsRepo({ pgmas: writeSeam(pool), database: TEST_DATABASE })

  it('creates a pending review gate, approves it, and lists pending views', async () => {
    const project = (await new ProjectsRepo({ pgmas: writeSeam(pool), database: TEST_DATABASE }).list())[0]
    const id = track((await requirementsRepo.create('审核单测试', undefined, project.id)).id)
    const record = await requirementsRepo.appendRecord({
      requirementId: id, category: 'decision', status: 'waiting_review', result: 'ADR ok', artifacts: ['decisions/001.md'],
    })

    const created = await reviewsRepo.create(record.id, 'review')
    expect(created).toMatchObject({ kind: 'review', status: 'pending', category: 'decision', requirementTitle: '审核单测试' })
    expect(created.artifacts).toEqual(['decisions/001.md'])

    const pending = await reviewsRepo.listPending()
    expect(pending.some(ticket => ticket.id === created.id)).toBe(true)

    const approved = await reviewsRepo.approve(created.id)
    expect(approved.status).toBe('approved')
    expect(approved.decidedAt).not.toBeNull()
    expect((await reviewsRepo.listPending()).some(ticket => ticket.id === created.id)).toBe(false)
    expect((await reviewsRepo.latestByRecord(record.id))?.status).toBe('approved')
  })

  it('rejects with mandatory feedback and re-creates a fresh reply ticket after rejection', async () => {
    const project = (await new ProjectsRepo({ pgmas: writeSeam(pool), database: TEST_DATABASE }).list())[0]
    const id = track((await requirementsRepo.create('驳回测试', undefined, project.id)).id)
    const record = await requirementsRepo.appendRecord({
      requirementId: id, category: 'plan', status: 'waiting_review', result: 'plan ok',
    })

    const ticket = await reviewsRepo.create(record.id, 'review')
    await expect(reviewsRepo.reject(ticket.id, '   ')).rejects.toThrow(/整改意见/)
    const rejected = await reviewsRepo.reject(ticket.id, '计划缺里程碑')
    expect(rejected.status).toBe('rejected')
    expect(rejected.feedback).toBe('计划缺里程碑')
    expect((await reviewsRepo.latestByRecord(record.id))?.status).toBe('rejected')

    // 驳回后重跑再提问：ensureReply 补一张新的 pending reply 单
    await reviewsRepo.ensureReply(record.id)
    const fresh = await reviewsRepo.latestByRecord(record.id)
    expect(fresh).toMatchObject({ kind: 'reply', status: 'pending' })
    expect((await reviewsRepo.listByRecord(record.id))).toHaveLength(2)
  })

  it('ensureReply is idempotent while a pending reply ticket exists', async () => {
    const project = (await new ProjectsRepo({ pgmas: writeSeam(pool), database: TEST_DATABASE }).list())[0]
    const id = track((await requirementsRepo.create('补单幂等测试', undefined, project.id)).id)
    const record = await requirementsRepo.appendRecord({
      requirementId: id, category: 'coding', status: 'waiting_reply',
    })

    await reviewsRepo.ensureReply(record.id)
    const first = await reviewsRepo.latestByRecord(record.id)
    expect(first).toMatchObject({ kind: 'reply', status: 'pending' })
    await reviewsRepo.ensureReply(record.id)
    expect((await reviewsRepo.listByRecord(record.id))).toHaveLength(1)
  })

  it('blocks approving a reply ticket while any question is unanswered', async () => {
    const project = (await new ProjectsRepo({ pgmas: writeSeam(pool), database: TEST_DATABASE }).list())[0]
    const id = track((await requirementsRepo.create('放行前置校验测试', undefined, project.id)).id)
    const record = await requirementsRepo.appendRecord({
      requirementId: id, category: 'plan', status: 'waiting_reply',
    })
    const questionsRepo = new QuestionsRepo({ pgmas: writeSeam(pool), database: TEST_DATABASE })
    await questionsRepo.insertMany(record.id, [
      { question: 'Q1？', options: [] },
      { question: 'Q2？', options: ['A', 'B'] },
    ])

    await reviewsRepo.ensureReply(record.id)
    const ticket = await reviewsRepo.latestByRecord(record.id)
    expect(ticket).toMatchObject({ kind: 'reply', status: 'pending' })
    await expect(reviewsRepo.approve(ticket!.id)).rejects.toThrow(/全部答完/)

    // 答完一题仍不行
    const pending = await questionsRepo.pendingByRecord(record.id)
    await questionsRepo.answer(pending[0]!.id, '答 1')
    await expect(reviewsRepo.approve(ticket!.id)).rejects.toThrow(/全部答完/)

    // 全部答完 → 可放行
    await questionsRepo.answer(pending[1]!.id, '选 A')
    const approved = await reviewsRepo.approve(ticket!.id)
    expect(approved.status).toBe('approved')
  })
})

describe.skipIf(!(await reachable()))('看板扩展方法 against the live cm database', () => {
  const requirementsRepo = new RequirementsRepo({ pgmas: writeSeam(pool), database: TEST_DATABASE, userId: TEST_USER_ID })
  const projectsRepo = new ProjectsRepo({ pgmas: writeSeam(pool), database: TEST_DATABASE })

  it('listRecords supports category / requirementId / status filters with requirement title', async () => {
    const project = (await projectsRepo.list())[0]
    const id = track((await requirementsRepo.create('运行页筛选测试', '用于 listRecords 断言', project.id)).id)

    const running = await requirementsRepo.appendRecord({
      requirementId: id, category: 'coding', status: 'running', skills: ['facai-coding'],
    })
    await requirementsRepo.updateRecord(running.id, { status: 'success', result: 'code done' })
    const waiting = await requirementsRepo.appendRecord({
      requirementId: id, category: 'decision', status: 'waiting_reply', result: 'need decision',
    })

    const all = await requirementsRepo.listRecords()
    expect(all.some(item => item.id === running.id)).toBe(true)

    const byCategory = await requirementsRepo.listRecords({ category: 'coding' })
    expect(byCategory.some(item => item.id === running.id)).toBe(true)
    expect(byCategory.some(item => item.id === waiting.id)).toBe(false)

    const byStatus = await requirementsRepo.listRecords({ status: 'waiting_reply' })
    expect(byStatus.some(item => item.id === waiting.id)).toBe(true)

    const byRqm = await requirementsRepo.listRecords({ requirementId: id })
    expect(byRqm.some(item => item.id === running.id)).toBe(true)
    expect(byRqm.some(item => item.id === waiting.id)).toBe(true)
    expect(byRqm.every(item => item.requirementTitle === '运行页筛选测试')).toBe(true)
  })

  it('getRecordListItem returns the joined requirement title after an update', async () => {
    const project = (await projectsRepo.list())[0]
    const id = track((await requirementsRepo.create('记录编辑返回测试', undefined, project.id)).id)
    const record = await requirementsRepo.appendRecord({
      requirementId: id, category: 'plan', status: 'running',
    })
    await requirementsRepo.updateRecord(record.id, { status: 'failed', result: 'plan failed' })
    const item = await requirementsRepo.getRecordListItem(record.id)
    expect(item.status).toBe('failed')
    expect(item.requirementTitle).toBe('记录编辑返回测试')
  })

  it('latestRecordByCategory returns the most recent record of a category (deferred review gate target)', async () => {
    const project = (await projectsRepo.list())[0]
    const id = track((await requirementsRepo.create('延后门定位测试', undefined, project.id)).id)
    await requirementsRepo.appendRecord({ requirementId: id, category: 'plan', status: 'success' })
    const second = await requirementsRepo.appendRecord({ requirementId: id, category: 'plan', status: 'running' })

    const latest = await requirementsRepo.latestRecordByCategory(id, 'plan')
    expect(latest?.id).toBe(second.id)
    expect(latest?.status).toBe('running')
    expect(await requirementsRepo.latestRecordByCategory(id, 'coding')).toBeUndefined()
    // listRecentRecord 只回产物型成功阶段（排除 review 审核阶段）
    await requirementsRepo.updateRecord(second.id, { status: 'success' })
    await requirementsRepo.appendRecord({ requirementId: id, category: 'review-plan', status: 'success', result: '机审通过' })
    const recent = await requirementsRepo.listRecentRecord(id)
    expect(recent?.category).toBe('plan')
  })

  it('updateRequirement edits title/description/projectId; removeRequirement deletes cascade', async () => {
    const project = (await projectsRepo.list())[0]
    const id = track((await requirementsRepo.create('待编辑需求', 'old desc', project.id)).id)
    const updated = await requirementsRepo.updateRequirement(id, { title: '已编辑需求', description: null })
    expect(updated.title).toBe('已编辑需求')
    expect(updated.description).toBeNull()

    await requirementsRepo.appendRecord({ requirementId: id, category: 'coding', status: 'running' })
    await requirementsRepo.removeRequirement(id)
    const gone = await requirementsRepo.getById(id)
    expect(gone).toBeUndefined()
    expect(await requirementsRepo.listRecords({ requirementId: id })).toHaveLength(0)
  })

  it('projects update edits fields and remove is blocked by referencing requirements', async () => {
    const created = await projectsRepo.create({
      name: '看板项目编辑', localPath: '/tmp/cm-board-edit', gitUrl: 'git@gitee.com:test/cm-board-edit.git',
      platform: 'gitee', prToken: 'old-token',
    })
    createdProjectIds.push(created.id)

    const updated = await projectsRepo.update(created.id, {
      name: '看板项目已编辑', prToken: 'new-token',
    })
    expect(updated.name).toBe('看板项目已编辑')
    expect(updated.hasToken).toBe(true)
    expect(await projectsRepo.getToken(created.id)).toBe('new-token')

    // 未引用时可删除
    await projectsRepo.remove(created.id)
    expect(await projectsRepo.getById(created.id)).toBeUndefined()

    // 引用需求时拒绝删除
    const ref = await projectsRepo.create({
      name: '引用项目', localPath: '/tmp/cm-board-ref', gitUrl: 'git@gitee.com:test/cm-board-ref.git', platform: 'gitee',
    })
    createdProjectIds.push(ref.id)
    track((await requirementsRepo.create('引用删除测试', undefined, ref.id)).id)
    await expect(projectsRepo.remove(ref.id)).rejects.toThrow(/仍被.*条需求引用/)
  })
})