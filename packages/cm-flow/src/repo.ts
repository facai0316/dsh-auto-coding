/**
 * cm-flow domain + storage, independent of Cordis so it can be tested against
 * a real `pg` pool without a harness context, and free of TS decorators so the
 * vitest/esbuild transform can parse it.
 * @module @auto-coding/cm-flow/repo
 */

import type { PoolClient } from 'pg'

// ──────────────────────────────── domain ─────────────────────────────────

export const REQUIREMENT_STATUSES = ['draft', 'open', 'in_progress', 'merging', 'done', 'cancelled', 'terminated'] as const
export type RequirementStatus = (typeof REQUIREMENT_STATUSES)[number]

/** records.status 合法值（流水线阶段账本）。 */
export const RECORD_STATUSES = ['running', 'success', 'failed', 'waiting_reply', 'retrying', 'waiting_review', 'terminated'] as const
export type RecordStatus = (typeof RECORD_STATUSES)[number]

/** 审核单 kind：review=人工审核（ADR/计划等产物），reply=待决策问答的放行审核。 */
export const REVIEW_KINDS = ['review', 'reply'] as const
export type ReviewKind = (typeof REVIEW_KINDS)[number]

/** 审核单状态。 */
export const REVIEW_STATUSES = ['pending', 'approved', 'rejected'] as const
export type ReviewStatus = (typeof REVIEW_STATUSES)[number]

/** Wire/client-facing projection of one requirements row (lossless JSON). */
export interface RequirementView {
  id: string
  title: string
  description: string | null
  status: RequirementStatus
  projectId: string | null
  createdAt: string
  updatedAt: string
}

/** One stage ledger row folded into a requirement list view. */
export interface StageSummary {
  category: string
  status: string
  /** record id（待决策问答按此查问题）。 */
  recordId: string
  prUrl?: string
  updatedAt: string
}

/** Requirement plus its stage ledger fold (panel pipeline console). */
export interface RequirementWithStages extends RequirementView {
  stages: StageSummary[]
}

/** One records row (lossless JSON projection). */
export interface RecordView {
  id: string
  category: string
  status: RecordStatus
  result: string | null
  artifacts: string[]
  skills: string[]
  parentId: string | null
  requirementId: string
  branchId: string | null
  /** 该阶段已重试次数（worker 复用原 record 计数，上限 maxRetries）。 */
  retryCount: number
  createdAt: string
  updatedAt: string
}

/** Record plus its requirement title (运行页卡片/筛选需要). */
export interface RecordListItem extends RecordView {
  requirementTitle: string | null
}

/** Input for opening a stage ledger row. */
export interface RecordInput {
  requirementId: string
  category: string
  status: RecordStatus
  branchId?: string
  result?: string
  artifacts?: string[]
  skills?: string[]
  parentId?: string | null
}

/** Wire/client-facing projection of one projects row (token never returned). */
export interface ProjectView {
  id: string
  name: string
  localPath: string
  gitUrl: string
  platform: 'gitee' | 'gitea'
  hasToken: boolean
}

/** Wire/client-facing projection of one ask_user_questions row. */
export interface QuestionView {
  id: string
  recordId: string
  question: string
  options: string[]
  status: 'pending' | 'answered'
  answer: string | null
  createdAt: string
  answeredAt: string | null
}

/** Wire/client-facing projection of one reviews row. */
export interface ReviewView {
  id: string
  recordId: string
  kind: ReviewKind
  status: ReviewStatus
  /** 驳回时的整改意见（通过/待审为 null）。 */
  feedback: string | null
  createdAt: string
  decidedAt: string | null
  /** 关联 record / 需求信息（审核大厅卡片展示）。 */
  category: string
  result: string | null
  artifacts: string[]
  requirementId: string
  requirementTitle: string | null
  requirementStatus: RequirementStatus
}

/** 每阶段/默认的子会话模型覆盖（agentOptions 直通 subagents.start）。 */
export interface StageModelConfig {
  /** Provider 路由（缺省继承 worker 根 agent）。 */
  provider?: string | null
  /** 模型 id（缺省继承 worker 根 agent）。 */
  model?: string | null
  /** 每次会话请求的最大输出 tokens。 */
  maxTokens?: number | null
}

/** Worker 运行配置：时段窗口 + 并发 + 每阶段模型/模式。 */
export interface WorkerConfig {
  /** 是否启用「仅指定时段运行」。false = 24h 全时段。 */
  timeWindowEnabled: boolean
  /** 起始小时（0-23，含）。 */
  startHour: number
  /** 结束小时（0-23，不含；start>end 视为跨天窗口）。 */
  endHour: number
  /** 并发领取并运行的流水线数（1-8；1 = 串行）。 */
  concurrency: number
  /** 每阶段覆盖（category → 配置；merge/resolve 亦属阶段）。 */
  stages: Record<string, StageModelConfig>
  /** 未配置阶段的默认模型。 */
  defaultModel?: string | null
  /** 未配置阶段的默认 provider。 */
  defaultProvider?: string | null
  /** 未配置阶段的默认 maxTokens。 */
  defaultMaxTokens?: number | null
}

export const DEFAULT_WORKER_CONFIG: WorkerConfig = {
  timeWindowEnabled: false,
  startHour: 9,
  endHour: 18,
  concurrency: 1,
  stages: {},
  defaultModel: null,
  defaultProvider: null,
  defaultMaxTokens: null,
}

/** 并发上限：同时运行的流水线条数不超过该值（钳制上限，防资源打爆）。 */
export const MAX_CONCURRENCY = 8

/** 规范化一个 WorkerConfig（补默认值、整型边界钳制）。 */
export function normalizeWorkerConfig(input: unknown): WorkerConfig {
  const value = (input ?? {}) as Record<string, unknown>
  const stages = (value.stages ?? {}) as Record<string, unknown>
  const normalizedStages: Record<string, StageModelConfig> = {}
  for (const [category, raw] of Object.entries(stages)) {
    const stage = (raw ?? {}) as Record<string, unknown>
    normalizedStages[category] = {
      ...(stage.provider !== null && stage.provider !== undefined ? { provider: String(stage.provider) } : {}),
      ...(stage.model !== null && stage.model !== undefined ? { model: String(stage.model) } : {}),
      ...(stage.maxTokens !== null && stage.maxTokens !== undefined ? { maxTokens: Number(stage.maxTokens) } : {}),
    }
  }
  const clampHour = (candidate: unknown, fallback: number): number => {
    const parsed = Number(candidate)
    return Number.isFinite(parsed) ? Math.min(23, Math.max(0, Math.floor(parsed))) : fallback
  }
  const optionalText = (candidate: unknown): string | null | undefined =>
    candidate === null || candidate === undefined || candidate === '' ? undefined : String(candidate)
  const optionalTokens = (candidate: unknown): number | null | undefined => {
    if (candidate === null || candidate === undefined || candidate === '') return undefined
    const parsed = Number(candidate)
    return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : undefined
  }
  const clampConcurrency = (candidate: unknown): number => {
    const parsed = Number(candidate)
    if (!Number.isFinite(parsed)) return DEFAULT_WORKER_CONFIG.concurrency
    return Math.min(MAX_CONCURRENCY, Math.max(1, Math.floor(parsed)))
  }
  return {
    timeWindowEnabled: value.timeWindowEnabled === true,
    startHour: clampHour(value.startHour, DEFAULT_WORKER_CONFIG.startHour),
    endHour: clampHour(value.endHour, DEFAULT_WORKER_CONFIG.endHour),
    concurrency: clampConcurrency(value.concurrency),
    stages: normalizedStages,
    ...optionalText(value.defaultModel) !== undefined ? { defaultModel: optionalText(value.defaultModel) } : {},
    ...optionalText(value.defaultProvider) !== undefined ? { defaultProvider: optionalText(value.defaultProvider) } : {},
    ...optionalTokens(value.defaultMaxTokens) !== undefined ? { defaultMaxTokens: optionalTokens(value.defaultMaxTokens) } : {},
  }
}

/**
 * Legal transitions. Legacy panel-era edges (`open→done`, `done→open`) are
 * retained for the current checklist UI; the pipeline era converges them away
 * (panel 提交执行 + worker 验收，见 docs/plans/02) — they will be removed
 * together with the panel 改造. `in_progress→merging` / `merging→done` are the
 * pipeline edges. `terminated` 为不可逆终态：可从任何非终态进入，无任何出路。
 */
export const TRANSITIONS: Readonly<Record<RequirementStatus, readonly RequirementStatus[]>> = {
  draft: ['open', 'cancelled', 'terminated'],
  open: ['in_progress', 'done', 'cancelled', 'terminated'],
  in_progress: ['merging', 'done', 'cancelled', 'terminated'],
  merging: ['done', 'cancelled', 'terminated'],
  done: ['open', 'cancelled', 'terminated'],
  cancelled: [],
  terminated: [],
}

export function assertStatus(value: unknown): RequirementStatus {
  if (typeof value === 'string' && (REQUIREMENT_STATUSES as readonly string[]).includes(value)) {
    return value as RequirementStatus
  }
  throw new Error(`未知需求状态 ${JSON.stringify(value)}（合法值：${REQUIREMENT_STATUSES.join(', ')}）`)
}

export function assertRecordStatus(value: unknown): RecordStatus {
  if (typeof value === 'string' && (RECORD_STATUSES as readonly string[]).includes(value)) {
    return value as RecordStatus
  }
  throw new Error(`未知记录状态 ${JSON.stringify(value)}（合法值：${RECORD_STATUSES.join(', ')}）`)
}

export function canTransition(from: RequirementStatus, to: RequirementStatus): boolean {
  return from !== to && (TRANSITIONS[from] as readonly string[]).includes(to)
}

// ──────────────────────────────  migrations ──────────────────────────────

interface Migration {
  version: number
  name: string
  apply(client: PoolClient): Promise<void>
}

/**
 * Forward migrations owned by this plugin. Version 1 is a baseline assertion
 * (SeaORM schema must already exist); v2-v4 add the pipeline data model.
 */
const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'baseline: assert SeaORM requirements table exists',
    apply: async client => {
      // Raises `relation "requirements" does not exist` when absent.
      await client.query('select 1 from requirements limit 1')
    },
  },
  {
    version: 2,
    name: 'projects table + seed fac-ai-rs',
    apply: async client => {
      await client.query(`
        create table if not exists projects (
          id          uuid primary key default gen_random_uuid(),
          name        varchar not null,
          local_path  text not null unique,
          git_url     text not null,
          platform    varchar not null default 'gitee',   -- 'gitee' | 'gitea'
          pr_token    text,
          created_at  timestamptz not null default now(),
          updated_at  timestamptz not null default now()
        )
      `)
      // Pilot project seed (idempotent, fixed id for later references).
      await client.query(`
        insert into projects (id, name, local_path, git_url, platform)
        select '00000000-0000-4000-8000-0000000000c1',
               'fac-ai-rs',
               '/root/workspace/rust/fac-ai-rs',
               'git@gitee.com:wb200327/fac-ai-rs.git',
               'gitee'
        where not exists (select 1 from projects where local_path = '/root/workspace/rust/fac-ai-rs')
      `)
    },
  },
  {
    version: 3,
    name: 'requirements.project_id + open index',
    apply: async client => {
      await client.query('alter table requirements add column project_id uuid references projects(id)')
      await client.query(`
        create index if not exists requirements_project_open_idx
          on requirements(project_id)
          where status = 'open'
      `)
    },
  },
  {
    version: 4,
    name: 'ask_user_questions table + pending index',
    apply: async client => {
      await client.query(`
        create table if not exists ask_user_questions (
          id          uuid primary key default gen_random_uuid(),
          record_id   uuid not null references records(id) on delete cascade,
          question    text not null,
          options     text[] not null default '{}',
          status      varchar not null default 'pending',   -- 'pending' | 'answered'
          answer      text,
          created_at  timestamptz not null default now(),
          answered_at timestamptz
        )
      `)
      await client.query(`
        create index if not exists ask_user_questions_pending_idx
          on ask_user_questions(record_id)
          where status = 'pending'
      `)
    },
  },
  {
    version: 5,
    name: 'worker_config singleton table (time window + per-stage model)',
    apply: async client => {
      await client.query(`
        create table if not exists worker_config (
          id         integer primary key default 1 check (id = 1),
          payload    jsonb not null,
          updated_at timestamptz not null default now()
        )
      `)
    },
  },
  {
    version: 6,
    name: 'records.retry_count column (worker reuses the record on retry)',
    apply: async client => {
      await client.query('alter table records add column if not exists retry_count integer not null default 0')
    },
  },
  {
    version: 7,
    name: 'reviews table (human review gates + reply release tickets)',
    apply: async client => {
      await client.query(`
        create table if not exists reviews (
          id          uuid primary key default gen_random_uuid(),
          record_id   uuid not null references records(id) on delete cascade,
          kind        varchar not null default 'review',   -- 'review' | 'reply'
          status      varchar not null default 'pending',  -- 'pending' | 'approved' | 'rejected'
          feedback    text,                                -- 驳回时的整改意见
          created_at  timestamptz not null default now(),
          decided_at  timestamptz
        )
      `)
      await client.query(`
        create index if not exists reviews_pending_idx
          on reviews(record_id)
          where status = 'pending'
      `)
    },
  },
]

// ────────────────────────────── shared infra ─────────────────────────────

function iso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value)
}

function toTextArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.map(entry => String(entry))
}

function rowToView(row: Record<string, unknown>): RequirementView {
  return {
    id: String(row.id),
    title: String(row.title),
    description: row.description === null || row.description === undefined ? null : String(row.description),
    status: assertStatus(row.status),
    projectId: row.project_id === null || row.project_id === undefined ? null : String(row.project_id),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  }
}

function recordRowToView(row: Record<string, unknown>): RecordView {
  return {
    id: String(row.id),
    category: String(row.category),
    status: assertRecordStatus(row.status),
    result: row.result === null || row.result === undefined ? null : String(row.result),
    artifacts: toTextArray(row.artifacts),
    skills: toTextArray(row.skills),
    parentId: row.parent_id === null || row.parent_id === undefined ? null : String(row.parent_id),
    requirementId: row.requirement_id === null || row.requirement_id === undefined ? '' : String(row.requirement_id),
    branchId: row.branch_id === null || row.branch_id === undefined ? null : String(row.branch_id),
    retryCount: row.retry_count === null || row.retry_count === undefined ? 0 : Number(row.retry_count),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  }
}

/** PgMasService is a ten-method seam; the repo needs only the write seam. */
export interface WriteSeam {
  withClient<T>(database: string, fn: (client: PoolClient) => Promise<T>, signal?: AbortSignal): Promise<T>
}

export const DEFAULT_USER_ID = '00000000-0000-4000-8000-000000000001'
export const DEFAULT_DATABASE = 'cm'

/**
 * Ensure schema + fixed dsh user exist. Idempotent; safe to run from any repo
 * construction (version rows skip already-applied migrations).
 */
async function runMigrations(pgmas: WriteSeam, database: string, userId: string): Promise<void> {
  await pgmas.withClient(database, async client => {
    // 进程/连接级互斥：并发首次应用同一迁移（如两个测试文件同时建 v5 表）会在
    // pg_type 上撞唯一索引；advisory lock 串行化整个迁移序列。
    await client.query('select pg_advisory_lock(747200001)')
    try {
      await client.query(`
        create table if not exists _cm_flow_migrations (
          version integer primary key,
          name text not null,
          applied_at timestamptz not null default now()
        )
      `)
      await client.query(
        `insert into users (id, email, password_hash, nickname, created_at, updated_at)
         values ($1, $2, '', 'dsh', now(), now())
         on conflict (id) do nothing`,
        [userId, `dsh+${userId}@dsh.local`],
      )
      for (const migration of MIGRATIONS) {
        const applied = await client.query('select 1 from _cm_flow_migrations where version = $1', [migration.version])
        if ((applied.rows ?? []).length > 0) continue
        await client.query('begin')
        try {
          await migration.apply(client)
          await client.query('insert into _cm_flow_migrations (version, name) values ($1, $2)', [migration.version, migration.name])
          await client.query('commit')
        } catch (error) {
          await client.query('rollback')
          throw error
        }
      }
    } finally {
      await client.query('select pg_advisory_unlock(747200001)')
    }
  })
}

// ──────────────────────────────── repos ──────────────────────────────────

export interface RepoOptions {
  pgmas: WriteSeam
  database?: string
  userId?: string
}

/** Requirements storage + state machine + stage ledger. */
export class RequirementsRepo {
  private readonly database: string
  private readonly userId: string
  private readonly pgmas: WriteSeam
  private readonly ready: Promise<void>

  constructor(options: RepoOptions) {
    this.pgmas = options.pgmas
    this.database = options.database ?? DEFAULT_DATABASE
    this.userId = options.userId ?? DEFAULT_USER_ID
    this.ready = runMigrations(this.pgmas, this.database, this.userId)
  }

  async list(options?: { projectId?: string }): Promise<RequirementWithStages[]> {
    await this.ready
    const result = await this.pgmas.withClient(this.database, client =>
      client.query(`
        select r.id, r.title, r.description, r.status, r.project_id, r.created_at, r.updated_at,
               coalesce((
                 select json_agg(json_build_object(
                   'category', rc.category,
                   'status', rc.status,
                   'recordId', rc.id,
                   'prUrl', case when rc.category = 'merge' and rc.artifacts is not null
                                     and array_length(rc.artifacts, 1) > 0 then rc.artifacts[1] end,
                   'updatedAt', rc.updated_at
                 ) order by rc.created_at asc, rc.id asc)
                 from records rc
                 where rc.requirement_id = r.id::text
               ), '[]'::json) as stages
        from requirements r
        where r.status <> 'cancelled'
          and ($1::uuid is null or r.project_id = $1::uuid)
        order by r.created_at asc, r.id asc
        limit 500
      `, [options?.projectId ?? null]))
    return (result.rows as Record<string, unknown>[]).map(row => ({
      ...rowToView(row),
      stages: Array.isArray(row.stages) ? row.stages as StageSummary[] : [],
    }))
  }

  /**
   * Create a requirement. With `projectId` → pipeline form: status `draft`,
   * attached to the project, awaiting panel 「开始执行」(transition to open).
   * Without → legacy panel-compatible: status `open`, no project.
   */
  async create(title: string, description?: string, projectId?: string): Promise<RequirementView> {
    await this.ready
    const trimmed = (title ?? '').trim()
    if (trimmed === '') throw new Error('标题不能为空')
    const status = projectId === undefined ? 'open' : 'draft'
    const result = await this.pgmas.withClient(this.database, client =>
      client.query(
        `insert into requirements (id, user_id, title, description, status, project_id, created_at, updated_at)
         values (gen_random_uuid(), $1, $2, $3, $4, $5, now(), now())
         returning id, title, description, status, project_id, created_at, updated_at`,
        [this.userId, trimmed, description === undefined ? null : description, status, projectId === undefined ? null : projectId],
      ))
    const row = (result.rows as Record<string, unknown>[])[0]
    if (row === undefined) throw new Error('插入需求失败：没有返回行')
    return rowToView(row)
  }

  async transition(id: string, to: string): Promise<RequirementView> {
    await this.ready
    const target = assertStatus(to)
    return this.pgmas.withClient(this.database, async client => {
      await client.query('begin')
      try {
        const current = await client.query('select status from requirements where id = $1 for update', [id])
        const row = (current.rows as Record<string, { status: unknown }>[])[0]
        if (row === undefined) throw new Error('需求不存在或已删除')
        const from = assertStatus(row.status)
        if (!canTransition(from, target)) {
          throw new Error(`非法状态流转 ${from} → ${target}`)
        }
        const updated = await client.query(
          `update requirements set status = $1, updated_at = now()
           where id = $2 and status = $3
           returning id, title, description, status, project_id, created_at, updated_at`,
          [target, id, from],
        )
        const updatedRow = (updated.rows as Record<string, unknown>[])[0]
        if (updatedRow === undefined) throw new Error('需求状态已变化，请刷新后重试')
        // 终止（不可逆）：同一事务内把该需求所有未完成（非 success/terminated）的
        // record 一并标记终止，流水线/审核大厅随之清空，worker 不会续跑。
        if (target === 'terminated') {
          await client.query(
            `update records set status = 'terminated', result = '需求已终止', updated_at = now()
             where requirement_id = $1 and status not in ('success', 'terminated')`,
            [id],
          )
        }
        await client.query('commit')
        return rowToView(updatedRow)
      } catch (error) {
        await client.query('rollback')
        throw error
      }
    })
  }

  /** 单条需求（续跑上下文用，不带 stages 折叠）。 */
  async getById(id: string): Promise<RequirementView | undefined> {
    await this.ready
    const result = await this.pgmas.withClient(this.database, client =>
      client.query(
        'select id, title, description, status, project_id, created_at, updated_at from requirements where id = $1',
        [id],
      ))
    const row = (result.rows as Record<string, unknown>[])[0]
    return row === undefined ? undefined : rowToView(row)
  }

  /** 该需求最近一条 success record（供下阶段上下文引用产物）。 */
  async listRecentRecord(requirementId: string): Promise<RecordView | undefined> {
    await this.ready
    const result = await this.pgmas.withClient(this.database, client =>
      client.query(
        `select id, requirement_id, branch_id, category, status, result, artifacts, skills, parent_id, created_at, updated_at
         from records where requirement_id = $1 and status = 'success'
           and category not in ('review-plan', 'review-code')
         order by created_at desc limit 1`,
        [requirementId],
      ))
    const row = (result.rows as Record<string, unknown>[])[0]
    return row === undefined ? undefined : recordRowToView(row)
  }

  /** 该需求某 category 最近一条 record（延后人审门定位被审产物 record 用）。 */
  async latestRecordByCategory(requirementId: string, category: string): Promise<RecordView | undefined> {
    await this.ready
    const result = await this.pgmas.withClient(this.database, client =>
      client.query(
        `select id, requirement_id, branch_id, category, status, result, artifacts, skills, parent_id, retry_count, created_at, updated_at
         from records where requirement_id = $1 and category = $2
         order by created_at desc, id desc limit 1`,
        [requirementId, category],
      ))
    const row = (result.rows as Record<string, unknown>[])[0]
    return row === undefined ? undefined : recordRowToView(row)
  }

  /** Worker: open a stage ledger row (status `running`). */
  async appendRecord(input: RecordInput): Promise<RecordView> {
    await this.ready
    const result = await this.pgmas.withClient(this.database, client =>
      client.query(
        `insert into records (id, requirement_id, branch_id, category, title, status, result, artifacts, skills, parent_id, retry_count, created_at, updated_at)
         values (gen_random_uuid(), $1, $2, $3, $3, $4, $5, $6, $7, $8, 0, now(), now())
         returning id, requirement_id, branch_id, category, status, result, artifacts, skills, parent_id, retry_count, created_at, updated_at`,
        [
          input.requirementId,
          input.branchId ?? null,
          input.category,
          input.status,
          input.result ?? null,
          input.artifacts ?? [],
          input.skills ?? [],
          input.parentId ?? null,
        ],
      ))
    const row = (result.rows as Record<string, unknown>[])[0]
    if (row === undefined) throw new Error('插入记录失败：没有返回行')
    return recordRowToView(row)
  }

  /** Worker: settle one stage ledger row by id. */
  async updateRecord(
    id: string,
    patch: { status?: RecordStatus; result?: string; artifacts?: string[]; skills?: string[]; retryCount?: number },
  ): Promise<RecordView> {
    await this.ready
    const sets: string[] = []
    const values: unknown[] = []
    const push = (column: string, value: unknown): void => {
      sets.push(`${column} = $${values.length + 1}`)
      values.push(value)
    }
    if (patch.status !== undefined) push('status', patch.status)
    if (patch.result !== undefined) push('result', patch.result)
    if (patch.artifacts !== undefined) push('artifacts', patch.artifacts)
    if (patch.skills !== undefined) push('skills', patch.skills)
    if (patch.retryCount !== undefined) push('retry_count', patch.retryCount)
    if (sets.length === 0) throw new Error('updateRecord: 没有要更新的字段')
    sets.push('updated_at = now()')
    values.push(id)
    const result = await this.pgmas.withClient(this.database, client =>
      client.query(
        `update records set ${sets.join(', ')} where id = $${values.length}
         returning id, requirement_id, branch_id, category, status, result, artifacts, skills, parent_id, retry_count, created_at, updated_at`,
        values,
      ))
    const row = (result.rows as Record<string, unknown>[])[0]
    if (row === undefined) throw new Error('记录不存在或已删除')
    return recordRowToView(row)
  }

  /** Worker: 标记一次重试——复用原 record（不新开），retry_count 原子 +1。 */
  async markRetrying(id: string): Promise<RecordView> {
    await this.ready
    const result = await this.pgmas.withClient(this.database, client =>
      client.query(
        `update records set status = 'retrying', retry_count = retry_count + 1, updated_at = now()
         where id = $1
         returning id, requirement_id, branch_id, category, status, result, artifacts, skills, parent_id, retry_count, created_at, updated_at`,
        [id],
      ))
    const row = (result.rows as Record<string, unknown>[])[0]
    if (row === undefined) throw new Error('记录不存在或已删除')
    return recordRowToView(row)
  }

  /** 运行页：records 列表，支持 category / requirementId / status 筛选。 */
  async listRecords(filters: { category?: string; requirementId?: string; status?: RecordStatus } = {}): Promise<RecordListItem[]> {
    await this.ready
    const conditions: string[] = []
    const values: unknown[] = []
    if (filters.category !== undefined && filters.category !== '') {
      values.push(filters.category)
      conditions.push(`rc.category = $${values.length}`)
    }
    if (filters.requirementId !== undefined && filters.requirementId !== '') {
      values.push(filters.requirementId)
      conditions.push(`rc.requirement_id = $${values.length}`)
    }
    if (filters.status !== undefined) {
      values.push(filters.status)
      conditions.push(`rc.status = $${values.length}`)
    }
    const where = conditions.length > 0 ? `where ${conditions.join(' and ')}` : ''
    const result = await this.pgmas.withClient(this.database, client =>
      client.query(
        `select rc.id, rc.requirement_id, rc.branch_id, rc.category, rc.status, rc.result,
                rc.artifacts, rc.skills, rc.parent_id, rc.retry_count, rc.created_at, rc.updated_at,
                rq.title as requirement_title
         from records rc
         left join requirements rq on rq.id::text = rc.requirement_id
         ${where}
         order by rc.created_at desc, rc.id desc
         limit 500`,
        values,
      ))
    return (result.rows as Record<string, unknown>[]).map(row => ({
      ...recordRowToView(row),
      requirementTitle: row.requirement_title === null || row.requirement_title === undefined ? null : String(row.requirement_title),
    }))
  }

  /** 运行页：删除一条 record（其 ask_user_questions 由 ON DELETE CASCADE 清理）。 */
  async removeRecord(id: string): Promise<void> {
    await this.ready
    await this.pgmas.withClient(this.database, client =>
      client.query('delete from records where id = $1', [id]))
  }

  /** 单条 record + 需求标题（records/update 后返回完整列表项）。 */
  async getRecordListItem(id: string): Promise<RecordListItem> {
    await this.ready
    const result = await this.pgmas.withClient(this.database, client =>
      client.query(
        `select rc.id, rc.requirement_id, rc.branch_id, rc.category, rc.status, rc.result,
                rc.artifacts, rc.skills, rc.parent_id, rc.retry_count, rc.created_at, rc.updated_at,
                rq.title as requirement_title
         from records rc
         left join requirements rq on rq.id::text = rc.requirement_id
         where rc.id = $1
         limit 1`,
        [id],
      ))
    const row = (result.rows as Record<string, unknown>[])[0]
    if (row === undefined) throw new Error('记录不存在或已删除')
    return {
      ...recordRowToView(row),
      requirementTitle: row.requirement_title === null || row.requirement_title === undefined ? null : String(row.requirement_title),
    }
  }

  /** 面板：编辑需求字段（标题/描述/项目）。 */
  async updateRequirement(
    id: string,
    patch: { title?: string; description?: string | null; projectId?: string | null },
  ): Promise<RequirementView> {
    await this.ready
    const sets: string[] = []
    const values: unknown[] = []
    const push = (column: string, value: unknown): void => {
      sets.push(`${column} = $${values.length + 1}`)
      values.push(value)
    }
    if (patch.title !== undefined) {
      const trimmed = String(patch.title).trim()
      if (trimmed === '') throw new Error('标题不能为空')
      push('title', trimmed)
    }
    if (patch.description !== undefined) push('description', patch.description === null ? null : String(patch.description))
    if (patch.projectId !== undefined) push('project_id', patch.projectId === null ? null : patch.projectId)
    if (sets.length === 0) throw new Error('updateRequirement: 没有要更新的字段')
    sets.push('updated_at = now()')
    values.push(id)
    const result = await this.pgmas.withClient(this.database, client =>
      client.query(
        `update requirements set ${sets.join(', ')} where id = $${values.length}
         returning id, title, description, status, project_id, created_at, updated_at`,
        values,
      ))
    const row = (result.rows as Record<string, unknown>[])[0]
    if (row === undefined) throw new Error('需求不存在或已删除')
    return rowToView(row)
  }

  /** 面板：真删一条需求及其全部 records（questions 级联清理）。 */
  async removeRequirement(id: string): Promise<void> {
    await this.ready
    await this.pgmas.withClient(this.database, async client => {
      await client.query('begin')
      try {
        await client.query('delete from records where requirement_id = $1', [id])
        await client.query('delete from requirements where id = $1', [id])
        await client.query('commit')
      } catch (error) {
        await client.query('rollback')
        throw error
      }
    })
  }

  /**
   * Worker: PR created → requirement in_progress → merging。merge 阶段本身由
   * worker 的 runMerge 记账（merge record 含 pr_url）；此方法只推进状态，
   * 不重复插 record。
   */
  async markMerging(id: string, _prUrl: string): Promise<RequirementView> {
    await this.ready
    return this.pgmas.withClient(this.database, async client => {
      await client.query('begin')
      try {
        const updated = await this.transitionOnClient(client, id, 'merging')
        await client.query('commit')
        return updated
      } catch (error) {
        await client.query('rollback')
        throw error
      }
    })
  }

  /** Panel: user confirmed merged → requirement merging → done + merge record. */
  async confirmMerged(id: string): Promise<RequirementView> {
    await this.ready
    return this.pgmas.withClient(this.database, async client => {
      await client.query('begin')
      try {
        const updated = await this.transitionOnClient(client, id, 'done')
        await client.query(
          `insert into records (id, requirement_id, category, title, status, result, created_at, updated_at)
           values (gen_random_uuid(), $1, 'merge', 'merge', 'success', 'user confirmed merged', now(), now())`,
          [id],
        )
        await client.query('commit')
        return updated
      } catch (error) {
        await client.query('rollback')
        throw error
      }
    })
  }

  /** Shared state-machine transition on an already-acquired client (caller owns the transaction). */
  private async transitionOnClient(client: PoolClient, id: string, to: RequirementStatus): Promise<RequirementView> {
    const current = await client.query('select status from requirements where id = $1 for update', [id])
    const row = (current.rows as Record<string, { status: unknown }>[])[0]
    if (row === undefined) throw new Error('需求不存在或已删除')
    const from = assertStatus(row.status)
    if (!canTransition(from, to)) {
      throw new Error(`非法状态流转 ${from} → ${to}`)
    }
    const updated = await client.query(
      `update requirements set status = $1, updated_at = now()
       where id = $2 and status = $3
       returning id, title, description, status, project_id, created_at, updated_at`,
      [to, id, from],
    )
    const updatedRow = (updated.rows as Record<string, unknown>[])[0]
    if (updatedRow === undefined) throw new Error('需求状态已变化，请刷新后重试')
    return rowToView(updatedRow)
  }
}

/** Projects registry (local path + git url + platform + optional PR token). */
export class ProjectsRepo {
  private readonly database: string
  private readonly pgmas: WriteSeam
  private readonly ready: Promise<void>

  constructor(options: RepoOptions) {
    this.pgmas = options.pgmas
    this.database = options.database ?? DEFAULT_DATABASE
    this.ready = runMigrations(this.pgmas, this.database, options.userId ?? DEFAULT_USER_ID)
  }

  async list(): Promise<ProjectView[]> {
    await this.ready
    const result = await this.pgmas.withClient(this.database, client =>
      client.query('select id, name, local_path, git_url, platform, pr_token from projects order by created_at asc, name asc'))
    return (result.rows as Record<string, unknown>[]).map(row => ({
      id: String(row.id),
      name: String(row.name),
      localPath: String(row.local_path),
      gitUrl: String(row.git_url),
      platform: (row.platform === 'gitea' ? 'gitea' : 'gitee') as ProjectView['platform'],
      hasToken: row.pr_token !== null && row.pr_token !== undefined && String(row.pr_token) !== '',
    }))
  }

  async create(input: { name: string; localPath: string; gitUrl: string; platform: string; prToken?: string }): Promise<ProjectView> {
    await this.ready
    const name = (input.name ?? '').trim()
    const localPath = (input.localPath ?? '').trim()
    const gitUrl = (input.gitUrl ?? '').trim()
    if (name === '' || localPath === '' || gitUrl === '') throw new Error('项目名称/本地路径/git 链接均不能为空')
    if (input.platform !== 'gitee' && input.platform !== 'gitea') throw new Error('平台必须是 gitee 或 gitea')
    const result = await this.pgmas.withClient(this.database, client =>
      client.query(
        `insert into projects (id, name, local_path, git_url, platform, pr_token, created_at, updated_at)
         values (gen_random_uuid(), $1, $2, $3, $4, $5, now(), now())
         returning id, name, local_path, git_url, platform, pr_token`,
        [name, localPath, gitUrl, input.platform, input.prToken === undefined || input.prToken === '' ? null : input.prToken],
      ))
    const row = (result.rows as Record<string, unknown>[])[0]
    if (row === undefined) throw new Error('插入项目失败：没有返回行')
    return {
      id: String(row.id),
      name: String(row.name),
      localPath: String(row.local_path),
      gitUrl: String(row.git_url),
      platform: (row.platform === 'gitea' ? 'gitea' : 'gitee') as ProjectView['platform'],
      hasToken: row.pr_token !== null && row.pr_token !== undefined && String(row.pr_token) !== '',
    }
  }

  /** Worker/PR 阶段读取 token；空串视为未配置。 */
  async getToken(id: string): Promise<string | undefined> {
    await this.ready
    const result = await this.pgmas.withClient(this.database, client =>
      client.query('select pr_token from projects where id = $1', [id]))
    const row = (result.rows as Record<string, unknown>[])[0]
    const token = row?.pr_token
    return typeof token === 'string' && token !== '' ? token : undefined
  }

  /** Resolve one project by id (worker 领取后取项目信息)。 */
  async getById(id: string): Promise<ProjectView | undefined> {
    await this.ready
    const result = await this.pgmas.withClient(this.database, client =>
      client.query('select id, name, local_path, git_url, platform, pr_token from projects where id = $1', [id]))
    const row = (result.rows as Record<string, unknown>[])[0]
    if (row === undefined) return undefined
    return {
      id: String(row.id),
      name: String(row.name),
      localPath: String(row.local_path),
      gitUrl: String(row.git_url),
      platform: (row.platform === 'gitea' ? 'gitea' : 'gitee') as ProjectView['platform'],
      hasToken: row.pr_token !== null && row.pr_token !== undefined && String(row.pr_token) !== '',
    }
  }

  /** 面板：编辑项目字段。prToken 显式传入（含空串）时更新，undefined 保持不变。 */
  async update(
    id: string,
    patch: { name?: string; localPath?: string; gitUrl?: string; platform?: string; prToken?: string | null },
  ): Promise<ProjectView> {
    await this.ready
    const sets: string[] = []
    const values: unknown[] = []
    const push = (column: string, value: unknown): void => {
      sets.push(`${column} = $${values.length + 1}`)
      values.push(value)
    }
    if (patch.name !== undefined) {
      const name = String(patch.name).trim()
      if (name === '') throw new Error('项目名称不能为空')
      push('name', name)
    }
    if (patch.localPath !== undefined) {
      const localPath = String(patch.localPath).trim()
      if (localPath === '') throw new Error('本地路径不能为空')
      push('local_path', localPath)
    }
    if (patch.gitUrl !== undefined) {
      const gitUrl = String(patch.gitUrl).trim()
      if (gitUrl === '') throw new Error('git 链接不能为空')
      push('git_url', gitUrl)
    }
    if (patch.platform !== undefined) {
      if (patch.platform !== 'gitee' && patch.platform !== 'gitea') throw new Error('平台必须是 gitee 或 gitea')
      push('platform', patch.platform)
    }
    if (patch.prToken !== undefined) push('pr_token', patch.prToken === null || patch.prToken === '' ? null : patch.prToken)
    if (sets.length === 0) throw new Error('update: 没有要更新的字段')
    sets.push('updated_at = now()')
    values.push(id)
    const result = await this.pgmas.withClient(this.database, client =>
      client.query(
        `update projects set ${sets.join(', ')} where id = $${values.length}
         returning id, name, local_path, git_url, platform, pr_token`,
        values,
      ))
    const row = (result.rows as Record<string, unknown>[])[0]
    if (row === undefined) throw new Error('项目不存在或已删除')
    return {
      id: String(row.id),
      name: String(row.name),
      localPath: String(row.local_path),
      gitUrl: String(row.git_url),
      platform: (row.platform === 'gitea' ? 'gitea' : 'gitee') as ProjectView['platform'],
      hasToken: row.pr_token !== null && row.pr_token !== undefined && String(row.pr_token) !== '',
    }
  }

  /** 面板：删除项目。若仍有需求引用则拒绝（FK 保护）。 */
  async remove(id: string): Promise<void> {
    await this.ready
    await this.pgmas.withClient(this.database, async client => {
      const refs = await client.query('select count(*)::int as n from requirements where project_id = $1', [id])
      const n = Number((refs.rows[0] as { n?: unknown } | undefined)?.n ?? 0)
      if (n > 0) throw new Error(`项目仍被 ${n} 条需求引用，无法删除`)
      await client.query('delete from projects where id = $1', [id])
    })
  }
}

/** ask_user_questions ledger (decision channel). */
export class QuestionsRepo {
  private readonly database: string
  private readonly pgmas: WriteSeam
  private readonly ready: Promise<void>

  constructor(options: RepoOptions) {
    this.pgmas = options.pgmas
    this.database = options.database ?? DEFAULT_DATABASE
    this.ready = runMigrations(this.pgmas, this.database, options.userId ?? DEFAULT_USER_ID)
  }

  async insertMany(recordId: string, questions: { question: string; options: string[] }[]): Promise<void> {
    await this.ready
    await this.pgmas.withClient(this.database, async client => {
      for (const question of questions) {
        await client.query(
          `insert into ask_user_questions (id, record_id, question, options, status, created_at)
           values (gen_random_uuid(), $1, $2, $3, 'pending', now())`,
          [recordId, question.question, question.options ?? []],
        )
      }
    })
  }

  async listByRecord(recordId: string): Promise<QuestionView[]> {
    await this.ready
    const result = await this.pgmas.withClient(this.database, client =>
      client.query(
        `select id, record_id, question, options, status, answer, created_at, answered_at
         from ask_user_questions where record_id = $1 order by created_at asc, id asc`,
        [recordId],
      ))
    return (result.rows as Record<string, unknown>[]).map(questionRowToView)
  }

  async pendingByRecord(recordId: string): Promise<QuestionView[]> {
    await this.ready
    const result = await this.pgmas.withClient(this.database, client =>
      client.query(
        `select id, record_id, question, options, status, answer, created_at, answered_at
         from ask_user_questions where record_id = $1 and status = 'pending' order by created_at asc, id asc`,
        [recordId],
      ))
    return (result.rows as Record<string, unknown>[]).map(questionRowToView)
  }

  async answer(questionId: string, answer: string): Promise<QuestionView> {
    await this.ready
    const trimmed = (answer ?? '').trim()
    if (trimmed === '') throw new Error('回答不能为空')
    const result = await this.pgmas.withClient(this.database, client =>
      client.query(
        `update ask_user_questions set status = 'answered', answer = $2, answered_at = now()
         where id = $1
         returning id, record_id, question, options, status, answer, created_at, answered_at`,
        [questionId, trimmed],
      ))
    const row = (result.rows as Record<string, unknown>[])[0]
    if (row === undefined) throw new Error('问题不存在或已删除')
    return questionRowToView(row)
  }
}

/** 审核单账本：人工审核门（review）+ 待决策放行审核（reply）。 */
export class ReviewsRepo {
  private readonly database: string
  private readonly pgmas: WriteSeam
  private readonly ready: Promise<void>

  constructor(options: RepoOptions) {
    this.pgmas = options.pgmas
    this.database = options.database ?? DEFAULT_DATABASE
    this.ready = runMigrations(this.pgmas, this.database, options.userId ?? DEFAULT_USER_ID)
  }

  /** Worker：为 record 挂一张 pending 审核单。 */
  async create(recordId: string, kind: ReviewKind): Promise<ReviewView> {
    await this.ready
    await this.pgmas.withClient(this.database, client =>
      client.query(
        `insert into reviews (id, record_id, kind, status, created_at)
         values (gen_random_uuid(), $1, $2, 'pending', now())`,
        [recordId, kind],
      ))
    const latest = await this.latestByRecord(recordId)
    if (latest === undefined) throw new Error('插入审核单失败：没有返回行')
    return latest
  }

  /** 幂等补单：record 尚无 pending reply 单时插入一张（旧 waiting_reply 数据兼容；驳回重跑后再提问也会补新单）。 */
  async ensureReply(recordId: string): Promise<void> {
    await this.ready
    const latest = await this.latestByRecord(recordId)
    if (latest !== undefined && latest.kind === 'reply' && latest.status === 'pending') return
    await this.pgmas.withClient(this.database, client =>
      client.query(
        `insert into reviews (id, record_id, kind, status, created_at)
         values (gen_random_uuid(), $1, 'reply', 'pending', now())`,
        [recordId],
      ))
  }

  /** 审核大厅：所有 pending 审核单（含关联 record/需求信息）；已终止需求的不再展示。 */
  async listPending(): Promise<ReviewView[]> {
    await this.ready
    const result = await this.pgmas.withClient(this.database, client =>
      client.query(REVIEW_JOIN_SQL + `
        where v.status = 'pending'
          and (rq.status is null or rq.status <> 'terminated')
        order by v.created_at asc, v.id asc
        limit 200
      `))
    return (result.rows as Record<string, unknown>[]).map(reviewRowToView)
  }

  /** 某 record 的最新一张审核单（无则 undefined）。 */
  async latestByRecord(recordId: string): Promise<ReviewView | undefined> {
    await this.ready
    const result = await this.pgmas.withClient(this.database, client =>
      client.query(REVIEW_JOIN_SQL + `
        where v.record_id = $1
        order by v.created_at desc, v.id desc
        limit 1
      `, [recordId]))
    const row = (result.rows as Record<string, unknown>[])[0]
    return row === undefined ? undefined : reviewRowToView(row)
  }

  /** 某 record 的全部审核单（按时间正序，测试/审计用）。 */
  async listByRecord(recordId: string): Promise<ReviewView[]> {
    await this.ready
    const result = await this.pgmas.withClient(this.database, client =>
      client.query(REVIEW_JOIN_SQL + `
        where v.record_id = $1
        order by v.created_at asc, v.id asc
      `, [recordId]))
    return (result.rows as Record<string, unknown>[]).map(reviewRowToView)
  }

  /** 面板：审核通过。reply 放行单必须全部问题作答完毕才能通过（与审核大厅规则一致）。 */
  async approve(id: string): Promise<ReviewView> {
    await this.ready
    await this.pgmas.withClient(this.database, async client => {
      const ticket = await client.query('select kind from reviews where id = $1', [id])
      const kind = (ticket.rows[0] as { kind?: string } | undefined)?.kind
      if (kind === 'reply') {
        const pending = await client.query(
          `select 1 from ask_user_questions q
           join reviews v on v.record_id = q.record_id
           where v.id = $1 and q.status = 'pending' limit 1`,
          [id],
        )
        if ((pending.rows ?? []).length > 0) {
          throw new Error('仍有未作答的问题，请全部答完后再审核通过')
        }
      }
      await client.query(
        `update reviews set status = 'approved', decided_at = now()
         where id = $1 and status = 'pending'`,
        [id],
      )
    })
    return this.requireById(id)
  }

  /** 面板：驳回 + 整改意见（意见必填）。 */
  async reject(id: string, feedback: string): Promise<ReviewView> {
    await this.ready
    const trimmed = (feedback ?? '').trim()
    if (trimmed === '') throw new Error('驳回必须填写整改意见')
    await this.pgmas.withClient(this.database, client =>
      client.query(
        `update reviews set status = 'rejected', feedback = $2, decided_at = now()
         where id = $1 and status = 'pending'`,
        [id, trimmed],
      ))
    return this.requireById(id)
  }

  private async requireById(id: string): Promise<ReviewView> {
    const result = await this.pgmas.withClient(this.database, client =>
      client.query(REVIEW_JOIN_SQL + `
        where v.id = $1
        limit 1
      `, [id]))
    const row = (result.rows as Record<string, unknown>[])[0]
    if (row === undefined) throw new Error('审核单不存在或已删除')
    return reviewRowToView(row)
  }
}

/** reviews 与 record/requirement 的 join 骨架（各查询共用）。 */
const REVIEW_JOIN_SQL = `
  select v.id, v.record_id, v.kind, v.status, v.feedback, v.created_at, v.decided_at,
         rc.category, rc.result, rc.artifacts, rc.requirement_id,
         rq.title as requirement_title, rq.status as requirement_status
  from reviews v
  join records rc on rc.id = v.record_id
  left join requirements rq on rq.id::text = rc.requirement_id
`

function reviewRowToView(row: Record<string, unknown>): ReviewView {
  return {
    id: String(row.id),
    recordId: String(row.record_id),
    kind: row.kind === 'reply' ? 'reply' as const : 'review' as const,
    status: row.status === 'approved' ? 'approved' as const
      : row.status === 'rejected' ? 'rejected' as const
        : 'pending' as const,
    feedback: row.feedback === null || row.feedback === undefined ? null : String(row.feedback),
    createdAt: iso(row.created_at),
    decidedAt: row.decided_at === null || row.decided_at === undefined ? null : iso(row.decided_at),
    category: String(row.category),
    result: row.result === null || row.result === undefined ? null : String(row.result),
    artifacts: toTextArray(row.artifacts),
    requirementId: row.requirement_id === null || row.requirement_id === undefined ? '' : String(row.requirement_id),
    requirementTitle: row.requirement_title === null || row.requirement_title === undefined ? null : String(row.requirement_title),
    requirementStatus: assertStatus(row.requirement_status),
  }
}

function questionRowToView(row: Record<string, unknown>): QuestionView {
  return {
    id: String(row.id),
    recordId: String(row.record_id),
    question: String(row.question),
    options: toTextArray(row.options),
    status: row.status === 'answered' ? 'answered' as const : 'pending' as const,
    answer: row.answer === null || row.answer === undefined ? null : String(row.answer),
    createdAt: iso(row.created_at),
    answeredAt: row.answered_at === null || row.answered_at === undefined ? null : iso(row.answered_at),
  }
}

/** Worker 运行配置存储：worker_config 单例行（id=1）。 */
export class WorkerConfigRepo {
  private readonly database: string
  private readonly pgmas: WriteSeam
  private readonly ready: Promise<void>

  constructor(options: RepoOptions) {
    this.pgmas = options.pgmas
    this.database = options.database ?? DEFAULT_DATABASE
    this.ready = runMigrations(this.pgmas, this.database, options.userId ?? DEFAULT_USER_ID)
  }

  /** 读取当前配置；无行时返回默认值。 */
  async get(): Promise<WorkerConfig> {
    await this.ready
    const result = await this.pgmas.withClient(this.database, client =>
      client.query('select payload from worker_config where id = 1'))
    const row = (result.rows as Record<string, unknown>[])[0]
    return normalizeWorkerConfig(row?.payload)
  }

  /** 保存配置（upsert 单行），返回规范化后的值。 */
  async set(config: WorkerConfig): Promise<WorkerConfig> {
    await this.ready
    const normalized = normalizeWorkerConfig(config)
    await this.pgmas.withClient(this.database, client =>
      client.query(
        `insert into worker_config (id, payload, updated_at)
         values (1, $1::jsonb, now())
         on conflict (id) do update set payload = excluded.payload, updated_at = now()`,
        [JSON.stringify(normalized)],
      ))
    return normalized
  }
}

