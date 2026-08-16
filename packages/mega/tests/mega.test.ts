import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { parseDocument } from 'yaml'
import { validatePgConfig } from '../src/patch-utils.ts'

const here = dirname(fileURLToPath(import.meta.url))

function parsePatchText(text: string): unknown[] {
  const doc = parseDocument(text)
  expect(doc.errors).toHaveLength(0)
  const items = doc.toJS() as unknown
  return Array.isArray(items) ? items : []
}

describe('@auto-coding/mega bundle patch', () => {
  it('mounts the four pipeline rows at their mega subpath entries', () => {
    const patch = readFileSync(join(here, '..', 'cordis.patch.yml'), 'utf8')
    const items = parsePatchText(patch) as { insert: { id: string; name: string }[] }[]
    const rows = items.flatMap(item => item.insert ?? [])
    const byId = Object.fromEntries(rows.map(row => [row.id, row.name]))
    expect(byId).toEqual({
      'db-pgmas': '@auto-coding/mega/db',
      'cm-flow': '@auto-coding/mega/flow',
      'cm-worker': '@auto-coding/mega/worker',
      'ui-requirements': '@auto-coding/mega',
    })
  })

  it('keeps row ids stable so a user-layer db-pgmas config override still wins', () => {
    const patch = readFileSync(join(here, '..', 'cordis.patch.yml'), 'utf8')
    expect(patch).toContain("id: db-pgmas")
    // The panel's 数据库连接 card writes `- id: db-pgmas config:`; the id must
    // match the row this patch inserts (patch include applies by id).
    expect(patch).not.toContain('name: "@auto-coding/db-pgmas"')
  })
})

describe('@auto-coding/mega shared host helpers', () => {
  it('validates a well-formed pg config (pgconfig remote contract)', () => {
    expect(validatePgConfig({ host: 'h', port: 5432, user: 'u', database: 'd', databases: ['a'], readOnly: true, maxRows: 50 })).toBeUndefined()
  })

  it('rejects a bad port', () => {
    expect(validatePgConfig({ host: 'h', port: 70000, user: 'u', database: 'd' })).toContain('port')
  })
})

describe('@auto-coding/mega usage documentation', () => {
  const usage = readFileSync(join(here, '..', 'assets', 'USAGE.md'), 'utf8')

  it('ships a packaged USAGE.md served by the usage remote', () => {
    expect(usage).toContain('# 使用说明')
  })

  it('walks the user through the four setup steps', () => {
    expect(usage).toContain('配置数据库')
    expect(usage).toContain('迁移')
    expect(usage).toContain('coding-pipline-skills')
    expect(usage).toContain('添加项目')
    expect(usage).toContain('/facai-init')
    // 插件不内置 skills：文档必须引导用户配合外部技能包使用。
    expect(usage).toContain('必须配合')
    expect(usage).not.toContain('内置一套')
  })
})
