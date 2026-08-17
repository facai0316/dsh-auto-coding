import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { parseDocument } from 'yaml'
import { upsertRowConfigInText, validatePgConfig, dshHome, resolvePatchPath } from '../src/patch-utils.ts'

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
  it('dshHome: DSH_HOME 未设置时回退 ~/.dsh（不炸 undefined.trim，ADR-031 现场回归）', () => {
    // 目标机器 dsh web 不给插件进程设 DSH_HOME → 旧实现 undefined?.trim() !== ''
    // 判定反了 → undefined.trim() 炸掉 pgconfig/get → 数据库连接卡片永远转圈。
    const saved = process.env.DSH_HOME
    try {
      delete process.env.DSH_HOME
      expect(dshHome()).toContain('.dsh')
      // resolvePatchPath 全链路（pgconfig/get 的第一步）同样不得抛错
      expect(resolvePatchPath({})).toContain(join('.dsh', 'profiles', 'web', 'cordis.patch.yml'))
      process.env.DSH_HOME = ''
      expect(dshHome()).toContain('.dsh')
      process.env.DSH_HOME = '  /custom/dsh  '
      expect(dshHome()).toBe('/custom/dsh')
    } finally {
      if (saved === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = saved
    }
  })

  it('validates a well-formed pg config (pgconfig remote contract)', () => {
    expect(validatePgConfig({ host: 'h', port: 5432, user: 'u', database: 'd', databases: ['a'], readOnly: true, maxRows: 50 })).toBeUndefined()
  })

  it('rejects a bad port', () => {
    expect(validatePgConfig({ host: 'h', port: 70000, user: 'u', database: 'd' })).toContain('port')
  })

  it('saving the db-pgmas override keeps !!js expressions in other rows', () => {
    const next = upsertRowConfigInText(
      `- id: webserver
  config:
    port: !!js ctx.webStartup.port ?? 3080
- id: db-pgmas
  config:
    host: 127.0.0.1
    port: 25678
`,
      'db-pgmas',
      { host: '10.0.0.5', port: 5433, user: 'u', database: 'd' },
    )
    // Regression: a parse→JS→stringify round-trip stripped the `!!js` tag.
    expect(next).toContain('!!js ctx.webStartup.port ?? 3080')
    expect(parsePatchText(next).find(row => (row as { id?: string }).id === 'db-pgmas')).toMatchObject({
      id: 'db-pgmas',
      config: { host: '10.0.0.5', port: 5433, user: 'u', database: 'd' },
    })
  })
})

describe('@auto-coding/mega usage documentation', () => {
  const usage = readFileSync(join(here, '..', 'assets', 'USAGE.md'), 'utf8')

  it('ships a packaged USAGE.md served by the usage remote', () => {
    expect(usage).toContain('# 使用说明')
  })

  it('stays byte-identical to the ui-requirements copy (the panel reads that one)', () => {
    // The live 使用说明 page is served by the ui-requirements package's
    // assets/USAGE.md; a stale copy there is what showed the removed
    // builtin-skills step after v0.3.1. Keep the two copies in lockstep.
    const uiCopy = readFileSync(join(here, '..', '..', 'ui-requirements', 'assets', 'USAGE.md'), 'utf8')
    expect(usage).toBe(uiCopy)
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
