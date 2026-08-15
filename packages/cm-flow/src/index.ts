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
import type { PgMasService } from '@auto-coding/db-pgmas'
import {
  DEFAULT_DATABASE,
  DEFAULT_USER_ID,
  ProjectsRepo,
  QuestionsRepo,
  RequirementsRepo,
  type ProjectView,
  type QuestionView,
  type RecordView,
  type RequirementView,
  type RequirementWithStages,
} from './repo.ts'

export type {
  RequirementStatus,
  RecordStatus,
  RequirementView,
  RequirementWithStages,
  StageSummary,
  RecordView,
  RecordInput,
  ProjectView,
  QuestionView,
  WriteSeam,
  RepoOptions,
} from './repo.ts'
export {
  REQUIREMENT_STATUSES,
  RECORD_STATUSES,
  TRANSITIONS,
  RequirementsRepo,
  ProjectsRepo,
  QuestionsRepo,
  assertStatus,
  assertRecordStatus,
  canTransition,
  DEFAULT_DATABASE,
  DEFAULT_USER_ID,
} from './repo.ts'

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

export type { RecordView as CmFlowRecordView }