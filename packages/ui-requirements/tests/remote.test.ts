import { describe, expect, it } from 'vitest'
import {
  CONTRIBUTION,
  projectSchema,
  questionSchema,
  requirementViewSchema,
  requirementWithStagesSchema,
  statusSchema,
} from '../src/client/remote.ts'

describe('ui-requirements requirements remote contract', () => {
  it('declares requirements/projects/questions/records namespaces with the expected methods', () => {
    expect(CONTRIBUTION.package).toBe('@auto-coding/cm-flow')
    const methods = CONTRIBUTION.descriptors.map(d => `${d.namespace}/${d.method}`)
    expect(methods).toEqual([
      'requirements/list',
      'requirements/create',
      'requirements/transition',
      'requirements/confirmMerged',
      'requirements/update',
      'requirements/delete',
      'projects/list',
      'projects/create',
      'projects/update',
      'projects/delete',
      'records/list',
      'records/create',
      'records/update',
      'records/delete',
      'questions/list',
      'questions/answer',
      'reviews/list',
      'reviews/approve',
      'reviews/reject',
      'config/get',
      'config/set',
      'config/providers',
      'merge/resolveConflicts',
    ])
  })

  it('optional parameters use optional codecs (regression: z.string() rejected undefined)', () => {
    const create = CONTRIBUTION.descriptors.find(d => d.method === 'create' && d.namespace === 'requirements')
    expect(create).toBeDefined()
    for (const wire of ['description', 'projectId']) {
      const param = create?.parameters.find(p => p.wire === wire)
      expect(param?.acceptsUndefined).toBe(true)
      expect(param?.codec.schema.parse(undefined)).toBeUndefined()
      expect(param?.codec.schema.parse('x')).toBe('x')
    }
    const list = CONTRIBUTION.descriptors.find(d => d.method === 'list' && d.namespace === 'requirements')
    expect(list?.parameters[0]?.codec.schema.parse(undefined)).toBeUndefined()
  })

  it('status codec accepts exactly the seven states', () => {
    for (const status of ['draft', 'open', 'in_progress', 'merging', 'done', 'cancelled', 'terminated']) {
      expect(statusSchema.parse(status)).toBe(status)
    }
    expect(() => statusSchema.parse('archived')).toThrow()
  })

  it('requirement view schema matches what the host returns', () => {
    const view = requirementViewSchema.parse({
      id: '00000000-0000-4000-8000-000000000001',
      title: '示例需求',
      description: null,
      status: 'open',
      projectId: null,
      createdAt: '2026-08-15T04:00:00.000Z',
      updatedAt: '2026-08-15T04:00:00.000Z',
    })
    expect(view.title).toBe('示例需求')
    expect(() => requirementViewSchema.parse({ ...view, status: 'oops' })).toThrow()
  })

  it('stage fold / project / question schemas match host projections', () => {
    const withStages = requirementWithStagesSchema.parse({
      ...{
        id: 'r', title: 't', description: null, status: 'in_progress', projectId: 'p',
        createdAt: '2026-08-15T04:00:00.000Z', updatedAt: '2026-08-15T04:00:00.000Z',
      },
      stages: [{ category: 'plan', status: 'success', recordId: 'rc-1', updatedAt: '2026-08-15T05:00:00.000Z' }],
    })
    expect(withStages.stages[0]?.category).toBe('plan')

    expect(projectSchema.parse({
      id: 'p', name: 'fac-ai-rs', localPath: '/repo', gitUrl: 'git@gitee.com:o/r.git',
      platform: 'gitee', hasToken: false,
    }).hasToken).toBe(false)

    expect(questionSchema.parse({
      id: 'q', recordId: 'rc', question: '选 A 还是 B？', options: ['A', 'B'],
      status: 'pending', answer: null, createdAt: '2026-08-15T04:00:00.000Z', answeredAt: null,
    }).status).toBe('pending')
  })
})