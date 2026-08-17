/**
 * cm-flow — host-only dsh plugin: requirements persistence + state machine
 * over the pg-mas `cm` database, exposed to the browser as Typert Remote
 * namespaces `requirements` / `projects` / `questions`.
 *
 * The panel is the first consumer. No model tools are registered — writes to
 * the business database happen only through these services' typed methods, via
 * `pgmas.withClient`. `pg_query` stays read-only.
 *
 * Schema ownership: the `cm` schema was created by coding-manager's SeaORM
 * migrations (now archived); this plugin treats that schema as baseline and
 * layers its own forward migrations in `_cm_flow_migrations` (v1 baseline,
 * v2 projects, v3 requirements.project_id, v4 ask_user_questions).
 *
 * The domain + storage live decorator-free in `./repo.ts` so tests (vitest →
 * esbuild, no decorator transform) can exercise them against a real `pg`
 * pool. This module only adds the Typert Remote service shells.
 *
 * @module @auto-coding/cm-flow
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { PgMasService } from './db.ts'
import {
  DEFAULT_DATABASE,
  DEFAULT_USER_ID,
  ProjectsRepo,
  QuestionsRepo,
  RequirementsRepo,
  ReviewsRepo,
  WorkerConfigRepo,
  runMigrations as runCmMigrations,
  type WriteSeam,
  type ProjectView,
  type QuestionView,
  type RecordListItem,
  type RecordView,
  type RequirementView,
  type RequirementWithStages,
  type ReviewView,
  type WorkerConfig,
} from './flow-repo.ts'

export type {
  RequirementStatus,
  RecordStatus,
  RequirementView,
  RequirementWithStages,
  StageSummary,
  RecordView,
  RecordListItem,
  RecordInput,
  ProjectView,
  QuestionView,
  ReviewKind,
  ReviewStatus,
  ReviewView,
  WriteSeam,
  RepoOptions,
  WorkerConfig,
  StageModelConfig,
} from './flow-repo.ts'

/** 一个 LLM 模型的目录条目（面板下拉用）。 */
export interface LlmModelInfo {
  id: string
  name: string
}

/** 一个已注册 LLM 提供商及其模型目录（面板下拉用）。 */
export interface LlmProviderInfo {
  id: string
  name: string
  models: LlmModelInfo[]
}
export {
  REQUIREMENT_STATUSES,
  RECORD_STATUSES,
  REVIEW_KINDS,
  REVIEW_STATUSES,
  TRANSITIONS,
  RequirementsRepo,
  ProjectsRepo,
  QuestionsRepo,
  ReviewsRepo,
  WorkerConfigRepo,
  DEFAULT_WORKER_CONFIG,
  MAX_CONCURRENCY,
  normalizeWorkerConfig,
  assertStatus,
  assertRecordStatus,
  canTransition,
  DEFAULT_DATABASE,
  DEFAULT_USER_ID,
  runMigrations as runCmMigrations,
} from './flow-repo.ts'

export interface Config {
  database: string
  userId: string
}

function resolvePgmas(ctx: Context): PgMasService {
  const pgmas = ctx.get('pgmas') as PgMasService | undefined
  if (pgmas === undefined) throw new Error('cm-flow: pgmas service is unavailable (mount @auto-coding/db-pgmas first)')
  return pgmas
}

/**
 * Typert Remote service (namespace `requirements`): methods become
 * `requirements/*` endpoints callable from the browser via
 * `ctx.remote.$mount(...)`. Parameter names are the wire field names (SRC
 * mode reads them from source), so keep them stable and match the client
 * descriptors exactly.
 */
export default class CmFlowService extends TypertRemoteService {
  static inject = ['pgmas']

  static Config: z<Config> = z.object({
    database: z.string().default(DEFAULT_DATABASE),
    userId: z.string().default(DEFAULT_USER_ID),
  })

  private readonly repo: RequirementsRepo

  constructor(ctx: Context, config: Config = { database: DEFAULT_DATABASE, userId: DEFAULT_USER_ID }) {
    super(ctx, 'cmFlow', { namespace: 'requirements' })
    const pgmas = resolvePgmas(ctx)
    const database = config.database ?? DEFAULT_DATABASE
    const userId = config.userId ?? DEFAULT_USER_ID
    this.repo = new RequirementsRepo({ pgmas, database, userId })
    // Sibling namespaces share the same write seam and migration gate.
    new ProjectsService(ctx, new ProjectsRepo({ pgmas, database, userId }))
    new QuestionsService(ctx, new QuestionsRepo({ pgmas, database, userId }))
    new ReviewsService(ctx, new ReviewsRepo({ pgmas, database, userId }))
    new RecordsService(ctx, this.repo)
    new ConfigService(ctx, new WorkerConfigRepo({ pgmas, database, userId }), { pgmas, database, userId })
  }

  @Remote('list')
  async list(projectId?: string): Promise<RequirementWithStages[]> {
    return this.repo.list(projectId === undefined ? {} : { projectId })
  }

  @Remote('create')
  async create(title: string, description?: string, projectId?: string): Promise<RequirementView> {
    return this.repo.create(title, description, projectId)
  }

  @Remote('transition')
  async transition(id: string, to: string): Promise<RequirementView> {
    return this.repo.transition(id, to)
  }

  @Remote('confirmMerged')
  async confirmMerged(id: string): Promise<RequirementView> {
    return this.repo.confirmMerged(id)
  }

  @Remote('update')
  async update(id: string, title?: string, description?: string | null, projectId?: string | null): Promise<RequirementView> {
    return this.repo.updateRequirement(id, { title, description, projectId })
  }

  @Remote('delete')
  async delete(id: string): Promise<void> {
    return this.repo.removeRequirement(id)
  }
}

/** Typert Remote service (namespace `projects`). */
export class ProjectsService extends TypertRemoteService {
  private readonly repo: ProjectsRepo

  constructor(ctx: Context, repo: ProjectsRepo) {
    super(ctx, 'cmProjects', { namespace: 'projects' })
    this.repo = repo
  }

  @Remote('list')
  async list(): Promise<ProjectView[]> {
    return this.repo.list()
  }

  @Remote('create')
  async create(name: string, localPath: string, gitUrl: string, platform: string, prToken?: string): Promise<ProjectView> {
    return this.repo.create({ name, localPath, gitUrl, platform, prToken })
  }

  @Remote('update')
  async update(id: string, name?: string, localPath?: string, gitUrl?: string, platform?: string, prToken?: string | null): Promise<ProjectView> {
    return this.repo.update(id, { name, localPath, gitUrl, platform, prToken })
  }

  @Remote('delete')
  async delete(id: string): Promise<void> {
    return this.repo.remove(id)
  }
}

/** Typert Remote service (namespace `questions`). */
export class QuestionsService extends TypertRemoteService {
  private readonly repo: QuestionsRepo

  constructor(ctx: Context, repo: QuestionsRepo) {
    super(ctx, 'cmQuestions', { namespace: 'questions' })
    this.repo = repo
  }

  @Remote('list')
  async list(recordId: string): Promise<QuestionView[]> {
    return this.repo.listByRecord(recordId)
  }

  @Remote('answer')
  async answer(questionId: string, answer: string): Promise<QuestionView> {
    return this.repo.answer(questionId, answer)
  }
}

/** Typert Remote service (namespace `reviews`): 审核大厅的审核单操作。 */
export class ReviewsService extends TypertRemoteService {
  private readonly repo: ReviewsRepo

  constructor(ctx: Context, repo: ReviewsRepo) {
    super(ctx, 'cmReviews', { namespace: 'reviews' })
    this.repo = repo
  }

  /** 全部 pending 审核单（含关联 record/需求信息），审核大厅数据源。 */
  @Remote('list')
  async list(): Promise<ReviewView[]> {
    return this.repo.listPending()
  }

  @Remote('approve')
  async approve(id: string): Promise<ReviewView> {
    return this.repo.approve(id)
  }

  @Remote('reject')
  async reject(id: string, feedback: string): Promise<ReviewView> {
    return this.repo.reject(id, feedback)
  }
}

/** Typert Remote service (namespace `records`): 运行页列表/删除。 */
export class RecordsService extends TypertRemoteService {
  private readonly repo: RequirementsRepo

  constructor(ctx: Context, repo: RequirementsRepo) {
    super(ctx, 'cmRecords', { namespace: 'records' })
    this.repo = repo
  }

  @Remote('list')
  async list(category?: string, requirementId?: string, status?: string): Promise<RecordListItem[]> {
    return this.repo.listRecords({
      category,
      requirementId,
      status: status === undefined ? undefined : (status as RecordListItem['status']),
    })
  }

  @Remote('create')
  async create(requirementId: string, category: string, status: string, result?: string): Promise<RecordListItem> {
    const created = await this.repo.appendRecord({
      requirementId,
      category,
      status: status as RecordListItem['status'],
      result,
    })
    return this.repo.getRecordListItem(created.id)
  }

  @Remote('update')
  async update(id: string, status?: string, result?: string): Promise<RecordListItem> {
    await this.repo.updateRecord(id, {
      status: status === undefined ? undefined : (status as RecordListItem['status']),
      result: result === undefined ? undefined : result,
    })
    return this.repo.getRecordListItem(id)
  }

  @Remote('delete')
  async delete(id: string): Promise<void> {
    return this.repo.removeRecord(id)
  }
}

/** Typert Remote service (namespace `config`): worker 运行配置读写 + LLM 目录。 */
export class ConfigService extends TypertRemoteService {
  private readonly repo: WorkerConfigRepo
  private readonly pgmas: PgMasService
  private readonly database: string
  private readonly userId: string

  constructor(ctx: Context, repo: WorkerConfigRepo, migration: { pgmas: PgMasService; database: string; userId: string }) {
    super(ctx, 'cmConfig', { namespace: 'config' })
    this.repo = repo
    this.pgmas = migration.pgmas
    this.database = migration.database
    this.userId = migration.userId
  }

  @Remote('get')
  async get(): Promise<WorkerConfig> {
    return this.repo.get()
  }

  @Remote('set')
  async set(config: WorkerConfig): Promise<WorkerConfig> {
    return this.repo.set(config)
  }

  /**
   * 显式跑一遍 schema 迁移（幂等）。数据库连接卡片的「迁移」按钮调用。
   *
   * 可选 `connection` 参数（卡片当前草稿值）：提供时用一次性 client 直连
   * 目标库执行迁移——不依赖运行中的 db-pgmas 连接池（池可能在「保存」后
   * 仍是旧配置，导致「测试连接成功、迁移却连旧地址被拒」的错位）。
   * 不提供时回退 pgmas 池（老路径）。
   */
  @Remote('migrate')
  async migrate(connection?: {
    host: string
    port: number
    user: string
    password?: string
    database: string
  }): Promise<{ ok: boolean; applied: string[]; message: string }> {
    try {
      if (connection !== undefined && connection.host !== undefined && connection.host !== '') {
        const pg = await import('pg') as typeof import('pg')
        const pool = new pg.Pool({
          host: connection.host,
          port: Number(connection.port) || 5432,
          user: connection.user,
          password: connection.password ?? '',
          database: connection.database,
          max: 1,
          connectionTimeoutMillis: 5_000,
        })
        pool.on('error', () => {})
        const seam: WriteSeam = {
          withClient: async <T>(_database: string, fn: (client: import('pg').PoolClient) => Promise<T>): Promise<T> => {
            const client = await pool.connect()
            try {
              return await fn(client)
            } finally {
              client.release()
            }
          },
        }
        try {
          const applied = await runCmMigrations(seam, connection.database, this.userId)
          return this.migrateResult(applied)
        } finally {
          await pool.end().catch(() => {})
        }
      }
      const applied = await runCmMigrations(this.pgmas, this.database, this.userId)
      return this.migrateResult(applied)
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      return { ok: false, applied: [], message: `迁移失败:${message}` }
    }
  }

  private migrateResult(applied: string[]): { ok: boolean; applied: string[]; message: string } {
    return {
      ok: true,
      applied,
      message: applied.length > 0
        ? `已应用 ${applied.length} 个迁移：${applied.join('；')}`
        : 'schema 已是最新，无需迁移',
    }
  }

  /** 已注册提供商及其模型目录（面板模型/提供商下拉数据源）。 */
  @Remote('providers')
  async providers(): Promise<LlmProviderInfo[]> {
    const llm = this.ctx.get('llm') as {
      listProviders(): { id: string; name?: string }[]
      listModels(provider: string): Promise<{ id: string; name: string }[]>
    } | undefined
    if (llm === undefined) return []
    const providers: LlmProviderInfo[] = []
    for (const provider of llm.listProviders()) {
      let models: LlmModelInfo[] = []
      try {
        models = (await llm.listModels(provider.id)).map(model => ({ id: model.id, name: model.name ?? model.id }))
      } catch {
        // 目录不可用（未实现 listModels 等）→ 该提供商无模型选项。
        models = []
      }
      providers.push({ id: provider.id, name: provider.name ?? provider.id, models })
    }
    return providers
  }
}

export type { RecordView as CmFlowRecordView }