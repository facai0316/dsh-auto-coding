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

export const statusSchema = z.enum(['draft', 'open', 'in_progress', 'merging', 'done', 'cancelled'])
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
  prUrl: z.string().optional(),
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
}

export interface ProjectsRemote {
  list(): Promise<RemoteResult<Project[]>>
  create(name: string, localPath: string, gitUrl: string, platform: string, prToken?: string): Promise<RemoteResult<Project>>
}

export interface QuestionsRemote {
  list(recordId: string): Promise<RemoteResult<Question[]>>
  answer(questionId: string, answer: string): Promise<RemoteResult<Question>>
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
  ] satisfies InvocationDescriptor[],
}

// ────────────────────────────── typed facades ────────────────────────────

let remote: { requirements: RequirementsRemote; projects: ProjectsRemote; questions: QuestionsRemote } | undefined
let ready: Promise<void> | undefined

/** Called by the client plugin once `$mount` resolves and the services exist. */
export function attach(namespaces: { requirements: RequirementsRemote; projects: ProjectsRemote; questions: QuestionsRemote }): void {
  remote = namespaces
  ready = Promise.resolve()
}

/** Called on mount failure or when the remote host is absent. */
export function detach(reason: unknown): void {
  remote = undefined
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