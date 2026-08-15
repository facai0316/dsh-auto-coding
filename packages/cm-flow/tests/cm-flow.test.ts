import { afterAll, describe, expect, it } from 'vitest'
import pg from 'pg'
import {
  REQUIREMENT_STATUSES,
  ProjectsRepo,
  QuestionsRepo,
  RequirementsRepo,
  assertStatus,
  canTransition,
  type RequirementView,
  type WriteSeam,
} from '../src/repo.ts'

/** Test-only user id so even partial cleanup never touches real panel rows. */
const TEST_USER_ID = '00000000-0000-4000-8000-00000000fffb'
const TEST_DATABASE = 'cm'

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
})

describe.skipIf(!(await reachable()))('cm-flow migrations v2-v4 against the live cm database', () => {
  it('created projects / ask_user_questions and requirements.project_id', async () => {
    const projects = await pool.query("select to_regclass('public.projects') as rel")
    expect(projects.rows[0]?.rel).not.toBeNull()
    const questions = await pool.query("select to_regclass('public.ask_user_questions') as rel")
    expect(questions.rows[0]?.rel).not.toBeNull()
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
    expect(pilot?.hasToken).toBe(false)
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