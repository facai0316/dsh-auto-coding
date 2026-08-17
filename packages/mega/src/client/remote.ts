/**
 * Requirements pipeline remote bridge: hand-written Typert contributions for
 * the `requirements` / `projects` / `questions` namespaces exported by the
 * `@auto-coding/cm-flow` host half, plus typed facades the panel calls.
 * Descriptors are plain data with zod `strict` codecs — the same shape the
 * Typert generator emits, kept in sync with cm-flow's service method
 * signatures (argument order, wire field names).
 */
import { z } from 'zod'

// ───────────────────────────── schema / types ────────────────────────────

export const statusSchema = z.enum(['draft', 'open', 'in_progress', 'merging', 'done', 'cancelled', 'terminated'])
export type Status = z.infer<typeof statusSchema>

export const requirementViewSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  status: statusSchema,
  projectId: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type RequirementView = z.infer<typeof requirementViewSchema>

export const stageSummarySchema = z.object({
  category: z.string(),
  status: z.string(),
  recordId: z.string(),
  // host 对非 merge 阶段返回 null（SQL case 无匹配分支）。
  prUrl: z.string().nullable().optional(),
  updatedAt: z.string(),
})
export type StageSummary = z.infer<typeof stageSummarySchema>

export const requirementWithStagesSchema = requirementViewSchema.extend({
  stages: z.array(stageSummarySchema),
})
export type RequirementWithStages = z.infer<typeof requirementWithStagesSchema>

export const projectSchema = z.object({
  id: z.string(),
  name: z.string(),
  localPath: z.string(),
  gitUrl: z.string(),
  platform: z.enum(['gitee', 'gitea']),
  hasToken: z.boolean(),
})
export type Project = z.infer<typeof projectSchema>

export const recordStatusSchema = z.enum(['running', 'success', 'failed', 'waiting_reply', 'retrying', 'waiting_review', 'terminated'])
export type RecordStatus = z.infer<typeof recordStatusSchema>

export const recordListItemSchema = z.object({
  id: z.string(),
  category: z.string(),
  status: recordStatusSchema,
  result: z.string().nullable(),
  artifacts: z.array(z.string()),
  skills: z.array(z.string()),
  parentId: z.string().nullable(),
  requirementId: z.string(),
  branchId: z.string().nullable(),
  retryCount: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
  requirementTitle: z.string().nullable(),
})
export type RecordListItem = z.infer<typeof recordListItemSchema>

export const questionSchema = z.object({
  id: z.string(),
  recordId: z.string(),
  question: z.string(),
  options: z.array(z.string()),
  status: z.enum(['pending', 'answered']),
  answer: z.string().nullable(),
  createdAt: z.string(),
  answeredAt: z.string().nullable(),
})
export type Question = z.infer<typeof questionSchema>

export const reviewSchema = z.object({
  id: z.string(),
  recordId: z.string(),
  kind: z.enum(['review', 'reply']),
  status: z.enum(['pending', 'approved', 'rejected']),
  feedback: z.string().nullable(),
  createdAt: z.string(),
  decidedAt: z.string().nullable(),
  category: z.string(),
  result: z.string().nullable(),
  artifacts: z.array(z.string()),
  requirementId: z.string(),
  requirementTitle: z.string().nullable(),
  requirementStatus: statusSchema,
})
export type Review = z.infer<typeof reviewSchema>

export const stageModelConfigSchema = z.object({
  provider: z.string().nullable().optional(),
  model: z.string().nullable().optional(),
  maxTokens: z.number().nullable().optional(),
})
export type StageModelConfig = z.infer<typeof stageModelConfigSchema>

export const workerConfigSchema = z.object({
  timeWindowEnabled: z.boolean(),
  // 旧 host（未重启）不返回该字段；null 视为「全部阶段受限」（旧语义）。
  timeWindowStages: z.array(z.string()).nullable().optional(),
  startHour: z.number(),
  endHour: z.number(),
  // 旧 host（未重启）不返回该字段；客户端回退默认 1。
  concurrency: z.number().optional(),
  stages: z.record(z.string(), stageModelConfigSchema),
  defaultModel: z.string().nullable().optional(),
  defaultProvider: z.string().nullable().optional(),
  defaultMaxTokens: z.number().nullable().optional(),
})
export type WorkerConfig = z.infer<typeof workerConfigSchema>

/** config/migrate 的返回：ok + 本次实际应用的迁移列表 + 说明。 */
export const migrationResultSchema = z.object({
  ok: z.boolean(),
  applied: z.array(z.string()),
  message: z.string(),
})
export type MigrationResult = z.infer<typeof migrationResultSchema>

export const llmModelSchema = z.object({
  id: z.string(),
  name: z.string(),
})
export type LlmModelInfo = z.infer<typeof llmModelSchema>

export const llmProviderSchema = z.object({
  id: z.string(),
  name: z.string(),
  models: z.array(llmModelSchema),
})
export type LlmProviderInfo = z.infer<typeof llmProviderSchema>

export interface RemoteResult<T> {
  ok: boolean
  value?: T
  error?: { code: string; message: string }
}

export interface RequirementsRemote {
  list(projectId?: string): Promise<RemoteResult<RequirementWithStages[]>>
  create(title: string, description?: string, projectId?: string): Promise<RemoteResult<RequirementView>>
  transition(id: string, to: Status): Promise<RemoteResult<RequirementView>>
  confirmMerged(id: string): Promise<RemoteResult<RequirementView>>
  update(id: string, title?: string, description?: string | null, projectId?: string | null): Promise<RemoteResult<RequirementView>>
  delete(id: string): Promise<RemoteResult<void>>
}

export interface ProjectsRemote {
  list(): Promise<RemoteResult<Project[]>>
  create(name: string, localPath: string, gitUrl: string, platform: string, prToken?: string): Promise<RemoteResult<Project>>
  update(id: string, name?: string, localPath?: string, gitUrl?: string, platform?: string, prToken?: string | null): Promise<RemoteResult<Project>>
  delete(id: string): Promise<RemoteResult<void>>
}

export interface RecordsRemote {
  list(category?: string, requirementId?: string, status?: RecordStatus): Promise<RemoteResult<RecordListItem[]>>
  create(requirementId: string, category: string, status: RecordStatus, result?: string): Promise<RemoteResult<RecordListItem>>
  update(id: string, status?: RecordStatus, result?: string): Promise<RemoteResult<RecordListItem>>
  delete(id: string): Promise<RemoteResult<void>>
}

export interface QuestionsRemote {
  list(recordId: string): Promise<RemoteResult<Question[]>>
  answer(questionId: string, answer: string): Promise<RemoteResult<Question>>
}

export interface ReviewsRemote {
  list(): Promise<RemoteResult<Review[]>>
  approve(id: string): Promise<RemoteResult<Review>>
  reject(id: string, feedback: string): Promise<RemoteResult<Review>>
}

export interface ConfigRemote {
  get(): Promise<RemoteResult<WorkerConfig>>
  set(config: WorkerConfig): Promise<RemoteResult<WorkerConfig>>
  providers(): Promise<RemoteResult<LlmProviderInfo[]>>
  migrate(connection?: Record<string, unknown>): Promise<RemoteResult<MigrationResult>>
}

/** cm-worker 的 merge Typert Remote：审核大厅「解决冲突」按钮入口。 */
export interface MergeRemote {
  resolveConflicts(requirementId: string): Promise<RemoteResult<RecordListItem>>
}

// ────────────────────────────── contribution ─────────────────────────────

/** Minimal strict codec shape the client gateway consumes (`schema.parse`). */
interface StrictCodec {
  mode: 'strict'
  typeSymbol: string
  schema: { parse(value: unknown): unknown }
}
interface ParameterDescriptor {
  name: string
  wire: string
  source: 'json'
  codec: StrictCodec
  acceptsUndefined?: true
}
interface InvocationDescriptor {
  id: string
  service: string
  namespace: string
  method: string
  invocation: { kind: 'direct' }
  parameters: ParameterDescriptor[]
  result: StrictCodec
}

export interface RemoteContribution {
  package: string
  descriptors: InvocationDescriptor[]
}

const codec = (typeSymbol: string, schema: StrictCodec['schema']): StrictCodec =>
  ({ mode: 'strict', typeSymbol, schema })

const stringParam = (name: string): ParameterDescriptor =>
  ({ name, wire: name, source: 'json', codec: codec('string', z.string()) })
const optionalStringParam = (name: string): ParameterDescriptor =>
  ({ name, wire: name, source: 'json', codec: codec('string', z.string().optional()), acceptsUndefined: true })
/** 可选对象参数（如 migrate 的 connection 草稿值）。 */
const optionalJsonParam = (name: string): ParameterDescriptor =>
  ({ name, wire: name, source: 'json', codec: codec('json', z.record(z.string(), z.unknown())), acceptsUndefined: true })

export const CONTRIBUTION: RemoteContribution = {
  package: '@auto-coding/cm-flow',
  descriptors: [
    {
      id: '@auto-coding/cm-flow#requirements/list',
      service: 'cmFlow',
      namespace: 'requirements',
      method: 'list',
      invocation: { kind: 'direct' },
      parameters: [optionalStringParam('projectId')],
      result: codec('@auto-coding/cm-flow#RequirementWithStages[]', z.array(requirementWithStagesSchema)),
    },
    {
      id: '@auto-coding/cm-flow#requirements/create',
      service: 'cmFlow',
      namespace: 'requirements',
      method: 'create',
      invocation: { kind: 'direct' },
      parameters: [
        stringParam('title'),
        optionalStringParam('description'),
        optionalStringParam('projectId'),
      ],
      result: codec('@auto-coding/cm-flow#RequirementView', requirementViewSchema),
    },
    {
      id: '@auto-coding/cm-flow#requirements/transition',
      service: 'cmFlow',
      namespace: 'requirements',
      method: 'transition',
      invocation: { kind: 'direct' },
      parameters: [
        stringParam('id'),
        { name: 'to', wire: 'to', source: 'json', codec: codec('string', statusSchema) },
      ],
      result: codec('@auto-coding/cm-flow#RequirementView', requirementViewSchema),
    },
    {
      id: '@auto-coding/cm-flow#requirements/confirmMerged',
      service: 'cmFlow',
      namespace: 'requirements',
      method: 'confirmMerged',
      invocation: { kind: 'direct' },
      parameters: [stringParam('id')],
      result: codec('@auto-coding/cm-flow#RequirementView', requirementViewSchema),
    },
    {
      id: '@auto-coding/cm-flow#requirements/update',
      service: 'cmFlow',
      namespace: 'requirements',
      method: 'update',
      invocation: { kind: 'direct' },
      parameters: [
        stringParam('id'),
        optionalStringParam('title'),
        optionalStringParam('description'),
        optionalStringParam('projectId'),
      ],
      result: codec('@auto-coding/cm-flow#RequirementView', requirementViewSchema),
    },
    {
      id: '@auto-coding/cm-flow#requirements/delete',
      service: 'cmFlow',
      namespace: 'requirements',
      method: 'delete',
      invocation: { kind: 'direct' },
      parameters: [stringParam('id')],
      result: codec('@auto-coding/cm-flow#void', z.undefined()),
    },
    {
      id: '@auto-coding/cm-flow#projects/list',
      service: 'cmProjects',
      namespace: 'projects',
      method: 'list',
      invocation: { kind: 'direct' },
      parameters: [],
      result: codec('@auto-coding/cm-flow#Project[]', z.array(projectSchema)),
    },
    {
      id: '@auto-coding/cm-flow#projects/create',
      service: 'cmProjects',
      namespace: 'projects',
      method: 'create',
      invocation: { kind: 'direct' },
      parameters: [
        stringParam('name'),
        stringParam('localPath'),
        stringParam('gitUrl'),
        stringParam('platform'),
        optionalStringParam('prToken'),
      ],
      result: codec('@auto-coding/cm-flow#Project', projectSchema),
    },
    {
      id: '@auto-coding/cm-flow#projects/update',
      service: 'cmProjects',
      namespace: 'projects',
      method: 'update',
      invocation: { kind: 'direct' },
      parameters: [
        stringParam('id'),
        optionalStringParam('name'),
        optionalStringParam('localPath'),
        optionalStringParam('gitUrl'),
        optionalStringParam('platform'),
        optionalStringParam('prToken'),
      ],
      result: codec('@auto-coding/cm-flow#Project', projectSchema),
    },
    {
      id: '@auto-coding/cm-flow#projects/delete',
      service: 'cmProjects',
      namespace: 'projects',
      method: 'delete',
      invocation: { kind: 'direct' },
      parameters: [stringParam('id')],
      result: codec('@auto-coding/cm-flow#void', z.undefined()),
    },
    {
      id: '@auto-coding/cm-flow#records/list',
      service: 'cmRecords',
      namespace: 'records',
      method: 'list',
      invocation: { kind: 'direct' },
      parameters: [
        optionalStringParam('category'),
        optionalStringParam('requirementId'),
        optionalStringParam('status'),
      ],
      result: codec('@auto-coding/cm-flow#RecordListItem[]', z.array(recordListItemSchema)),
    },
    {
      id: '@auto-coding/cm-flow#records/create',
      service: 'cmRecords',
      namespace: 'records',
      method: 'create',
      invocation: { kind: 'direct' },
      parameters: [
        stringParam('requirementId'),
        stringParam('category'),
        stringParam('status'),
        optionalStringParam('result'),
      ],
      result: codec('@auto-coding/cm-flow#RecordListItem', recordListItemSchema),
    },
    {
      id: '@auto-coding/cm-flow#records/update',
      service: 'cmRecords',
      namespace: 'records',
      method: 'update',
      invocation: { kind: 'direct' },
      parameters: [
        stringParam('id'),
        optionalStringParam('status'),
        optionalStringParam('result'),
      ],
      result: codec('@auto-coding/cm-flow#RecordListItem', recordListItemSchema),
    },
    {
      id: '@auto-coding/cm-flow#records/delete',
      service: 'cmRecords',
      namespace: 'records',
      method: 'delete',
      invocation: { kind: 'direct' },
      parameters: [stringParam('id')],
      result: codec('@auto-coding/cm-flow#void', z.undefined()),
    },
    {
      id: '@auto-coding/cm-flow#questions/list',
      service: 'cmQuestions',
      namespace: 'questions',
      method: 'list',
      invocation: { kind: 'direct' },
      parameters: [stringParam('recordId')],
      result: codec('@auto-coding/cm-flow#Question[]', z.array(questionSchema)),
    },
    {
      id: '@auto-coding/cm-flow#questions/answer',
      service: 'cmQuestions',
      namespace: 'questions',
      method: 'answer',
      invocation: { kind: 'direct' },
      parameters: [
        stringParam('questionId'),
        stringParam('answer'),
      ],
      result: codec('@auto-coding/cm-flow#Question', questionSchema),
    },
    {
      id: '@auto-coding/cm-flow#reviews/list',
      service: 'cmReviews',
      namespace: 'reviews',
      method: 'list',
      invocation: { kind: 'direct' },
      parameters: [],
      result: codec('@auto-coding/cm-flow#Review[]', z.array(reviewSchema)),
    },
    {
      id: '@auto-coding/cm-flow#reviews/approve',
      service: 'cmReviews',
      namespace: 'reviews',
      method: 'approve',
      invocation: { kind: 'direct' },
      parameters: [stringParam('id')],
      result: codec('@auto-coding/cm-flow#Review', reviewSchema),
    },
    {
      id: '@auto-coding/cm-flow#reviews/reject',
      service: 'cmReviews',
      namespace: 'reviews',
      method: 'reject',
      invocation: { kind: 'direct' },
      parameters: [
        stringParam('id'),
        stringParam('feedback'),
      ],
      result: codec('@auto-coding/cm-flow#Review', reviewSchema),
    },
    {
      id: '@auto-coding/cm-flow#config/get',
      service: 'cmConfig',
      namespace: 'config',
      method: 'get',
      invocation: { kind: 'direct' },
      parameters: [],
      result: codec('@auto-coding/cm-flow#WorkerConfig', workerConfigSchema),
    },
    {
      id: '@auto-coding/cm-flow#config/set',
      service: 'cmConfig',
      namespace: 'config',
      method: 'set',
      invocation: { kind: 'direct' },
      parameters: [
        { name: 'config', wire: 'config', source: 'json', codec: codec('@auto-coding/cm-flow#WorkerConfig', workerConfigSchema) },
      ],
      result: codec('@auto-coding/cm-flow#WorkerConfig', workerConfigSchema),
    },
    {
      id: '@auto-coding/cm-flow#config/providers',
      service: 'cmConfig',
      namespace: 'config',
      method: 'providers',
      invocation: { kind: 'direct' },
      parameters: [],
      result: codec('@auto-coding/cm-flow#LlmProviderInfo[]', z.array(llmProviderSchema)),
    },
    {
      id: '@auto-coding/cm-flow#config/migrate',
      service: 'cmConfig',
      namespace: 'config',
      method: 'migrate',
      invocation: { kind: 'direct' },
      parameters: [optionalJsonParam('connection')],
      result: codec('@auto-coding/cm-flow#MigrationResult', migrationResultSchema),
    },
    {
      id: '@auto-coding/cm-worker#merge/resolveConflicts',
      service: 'cmMerge',
      namespace: 'merge',
      method: 'resolveConflicts',
      invocation: { kind: 'direct' },
      parameters: [stringParam('requirementId')],
      result: codec('@auto-coding/cm-worker#RecordListItem', recordListItemSchema),
    },
  ] satisfies InvocationDescriptor[],
}

// ────────────────────────── pgconfig / usage remote ─────────────────────

/** The pgconfig snapshot the settings page renders. */
export const pgConfigSnapshotSchema = z.object({
  patchPath: z.string(),
  present: z.boolean(),
  config: z.record(z.string(), z.unknown()),
  defaults: z.record(z.string(), z.unknown()),
})
export type PgConfigSnapshot = z.infer<typeof pgConfigSnapshotSchema>

export const pgConfigSaveResultSchema = z.object({
  ok: z.boolean(),
  error: z.string().optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  patchPath: z.string(),
})
export type PgConfigSaveResult = z.infer<typeof pgConfigSaveResultSchema>

export const pgConfigTestResultSchema = z.object({
  ok: z.boolean(),
  message: z.string(),
  config: z.record(z.string(), z.unknown()).optional(),
})
export type PgConfigTestResult = z.infer<typeof pgConfigTestResultSchema>

export const usageDocSchema = z.object({
  markdown: z.string(),
  source: z.enum(['file', 'placeholder']),
})
export type UsageDoc = z.infer<typeof usageDocSchema>

/** Contribution for the `pgconfig` / `usage` namespaces this package's own
 * host half exports (they are NOT cm-flow namespaces). */
export const SETTINGS_CONTRIBUTION: RemoteContribution = {
  package: '@auto-coding/ui-requirements',
  descriptors: [
    {
      id: '@auto-coding/ui-requirements#pgconfig/get',
      service: 'pgConfig',
      namespace: 'pgconfig',
      method: 'get',
      invocation: { kind: 'direct' },
      parameters: [],
      result: codec('@auto-coding/ui-requirements#PgConfigSnapshot', pgConfigSnapshotSchema),
    },
    {
      id: '@auto-coding/ui-requirements#pgconfig/save',
      service: 'pgConfig',
      namespace: 'pgconfig',
      method: 'save',
      invocation: { kind: 'direct' },
      parameters: [
        { name: 'value', wire: 'value', source: 'json', codec: codec('unknown', z.unknown()) },
      ],
      result: codec('@auto-coding/ui-requirements#PgConfigSaveResult', pgConfigSaveResultSchema),
    },
    {
      id: '@auto-coding/ui-requirements#pgconfig/test',
      service: 'pgConfig',
      namespace: 'pgconfig',
      method: 'test',
      invocation: { kind: 'direct' },
      parameters: [
        { name: 'value', wire: 'value', source: 'json', codec: codec('unknown', z.unknown()) },
      ],
      result: codec('@auto-coding/ui-requirements#PgConfigTestResult', pgConfigTestResultSchema),
    },
    {
      id: '@auto-coding/ui-requirements#usage/get',
      service: 'usage',
      namespace: 'usage',
      method: 'get',
      invocation: { kind: 'direct' },
      parameters: [],
      result: codec('@auto-coding/ui-requirements#UsageDoc', usageDocSchema),
    },
  ] satisfies InvocationDescriptor[],
}

// ────────────────────────────── typed facades ────────────────────────────

export interface SettingsNamespaces {
  pgconfig: {
    get(): Promise<RemoteResult<PgConfigSnapshot>>
    save(value: unknown): Promise<RemoteResult<PgConfigSaveResult>>
    test(value: unknown): Promise<RemoteResult<PgConfigTestResult>>
  }
  usage: {
    get(): Promise<RemoteResult<UsageDoc>>
  }
}

let remote: { requirements: RequirementsRemote; projects: ProjectsRemote; questions: QuestionsRemote; reviews: ReviewsRemote; records: RecordsRemote; config: ConfigRemote; merge: MergeRemote } | undefined
let settingsRemote: SettingsNamespaces | undefined
let ready: Promise<void> | undefined

/** Called by the client plugin once `$mount` resolves and the services exist. */
export function attach(namespaces: { requirements: RequirementsRemote; projects: ProjectsRemote; questions: QuestionsRemote; reviews: ReviewsRemote; records: RecordsRemote; config: ConfigRemote; merge: MergeRemote }): void {
  remote = namespaces
  ready = Promise.resolve()
}

/** Attach the settings namespaces (pgconfig / usage) after their $mount. */
export function attachSettings(namespaces: SettingsNamespaces): void {
  settingsRemote = namespaces
  if (ready === undefined) ready = Promise.resolve()
}

/** Called on mount failure or when the remote host is absent. */
export function detach(reason: unknown): void {
  remote = undefined
  settingsRemote = undefined
  ready = Promise.reject(reason)
  // Swallow the rejection so a detached panel does not emit unhandled errors;
  // awaiters still receive the rejection when the facade awaits `ready`.
  ready.catch(() => {})
}

async function whenReady(): Promise<void> {
  if (ready === undefined) throw new Error('需求面板尚未初始化')
  await ready
}

function unwrap<T>(result: RemoteResult<T> | undefined): T {
  if (result === undefined || result.ok !== true || result.value === undefined) {
    const message = result?.error?.message ?? result?.error?.code ?? '远程调用失败'
    throw new Error(message)
  }
  return result.value
}

export const requirements = {
  async list(projectId?: string): Promise<RequirementWithStages[]> {
    await whenReady()
    return unwrap(await remote!.requirements.list(projectId))
  },
  async create(title: string, description?: string, projectId?: string): Promise<RequirementView> {
    await whenReady()
    return unwrap(await remote!.requirements.create(title, description, projectId))
  },
  async transition(id: string, to: Status): Promise<RequirementView> {
    await whenReady()
    return unwrap(await remote!.requirements.transition(id, to))
  },
  async confirmMerged(id: string): Promise<RequirementView> {
    await whenReady()
    return unwrap(await remote!.requirements.confirmMerged(id))
  },
  async update(id: string, patch: { title?: string; description?: string | null; projectId?: string | null }): Promise<RequirementView> {
    await whenReady()
    return unwrap(await remote!.requirements.update(id, patch.title, patch.description, patch.projectId))
  },
  async delete(id: string): Promise<void> {
    await whenReady()
    unwrap(await remote!.requirements.delete(id))
  },
}

export const projects = {
  async list(): Promise<Project[]> {
    await whenReady()
    return unwrap(await remote!.projects.list())
  },
  async create(input: { name: string; localPath: string; gitUrl: string; platform: string; prToken?: string }): Promise<Project> {
    await whenReady()
    return unwrap(await remote!.projects.create(input.name, input.localPath, input.gitUrl, input.platform, input.prToken))
  },
  async update(id: string, patch: { name?: string; localPath?: string; gitUrl?: string; platform?: string; prToken?: string | null }): Promise<Project> {
    await whenReady()
    return unwrap(await remote!.projects.update(id, patch.name, patch.localPath, patch.gitUrl, patch.platform, patch.prToken))
  },
  async delete(id: string): Promise<void> {
    await whenReady()
    unwrap(await remote!.projects.delete(id))
  },
}

export const questions = {
  async list(recordId: string): Promise<Question[]> {
    await whenReady()
    return unwrap(await remote!.questions.list(recordId))
  },
  async answer(questionId: string, answer: string): Promise<Question> {
    await whenReady()
    return unwrap(await remote!.questions.answer(questionId, answer))
  },
}

export const reviews = {
  async list(): Promise<Review[]> {
    await whenReady()
    return unwrap(await remote!.reviews.list())
  },
  async approve(id: string): Promise<Review> {
    await whenReady()
    return unwrap(await remote!.reviews.approve(id))
  },
  async reject(id: string, feedback: string): Promise<Review> {
    await whenReady()
    return unwrap(await remote!.reviews.reject(id, feedback))
  },
}

export const workerConfig = {
  async get(): Promise<WorkerConfig> {
    await whenReady()
    return unwrap(await remote!.config.get())
  },
  async set(config: WorkerConfig): Promise<WorkerConfig> {
    await whenReady()
    return unwrap(await remote!.config.set(config))
  },
  async providers(): Promise<LlmProviderInfo[]> {
    await whenReady()
    return unwrap(await remote!.config.providers())
  },
  /** 显式跑一遍 schema 迁移（幂等）。connection 传卡片草稿值时直连目标库。 */
  async migrate(connection?: Record<string, unknown>): Promise<{ ok: boolean; applied: string[]; message: string }> {
    await whenReady()
    return unwrap(await remote!.config.migrate(connection))
  },
}

export const records = {
  async list(filters: { category?: string; requirementId?: string; status?: RecordStatus } = {}): Promise<RecordListItem[]> {
    await whenReady()
    return unwrap(await remote!.records.list(filters.category, filters.requirementId, filters.status))
  },
  async create(input: { requirementId: string; category: string; status: RecordStatus; result?: string }): Promise<RecordListItem> {
    await whenReady()
    return unwrap(await remote!.records.create(input.requirementId, input.category, input.status, input.result))
  },
  async update(id: string, patch: { status?: RecordStatus; result?: string }): Promise<RecordListItem> {
    await whenReady()
    return unwrap(await remote!.records.update(id, patch.status, patch.result))
  },
  async delete(id: string): Promise<void> {
    await whenReady()
    unwrap(await remote!.records.delete(id))
  },
}

export const merge = {
  /** 起跑一条冲突解决任务（fetch + merge + 解决冲突 + commit + push）；返回 resolve record。 */
  async resolveConflicts(requirementId: string): Promise<RecordListItem> {
    await whenReady()
    return unwrap(await remote!.merge.resolveConflicts(requirementId))
  },
}
// ──────────────────────── pgconfig / usage facades ──────────────────────

async function whenSettingsReady(): Promise<void> {
  if (settingsRemote === undefined) throw new Error('设置远程尚未初始化')
  return
}

export const pgConfig = {
  async get(): Promise<PgConfigSnapshot> {
    await whenSettingsReady()
    return unwrap(await settingsRemote!.pgconfig.get())
  },
  async save(value: unknown): Promise<PgConfigSaveResult> {
    await whenSettingsReady()
    return unwrap(await settingsRemote!.pgconfig.save(value))
  },
  async test(value: unknown): Promise<PgConfigTestResult> {
    await whenSettingsReady()
    return unwrap(await settingsRemote!.pgconfig.test(value))
  },
}

export const usageDoc = {
  async get(): Promise<UsageDoc> {
    await whenSettingsReady()
    return unwrap(await settingsRemote!.usage.get())
  },
}
