import { describe, expect, it } from 'vitest'
import { parseDocument } from 'yaml'
import { findRowConfig, upsertRowConfigInText, validatePgConfig } from '../src/patch-utils.ts'

function parsePatchText(text: string): unknown[] {
  const doc = parseDocument(text)
  expect(doc.errors).toHaveLength(0)
  const items = doc.toJS() as unknown
  return Array.isArray(items) ? items : []
}

/** A user-layer file that carries a `!!js` expression outside the db-pgmas row. */
const PATCH_WITH_JS_PORT = `- id: webserver
  config:
    host: 127.0.0.1
    port: !!js ctx.webStartup.port ?? 3080
- insert:
    - id: db-pgmas
      name: "@auto-coding/db-pgmas"
      config: {}
- id: db-pgmas
  config:
    host: 127.0.0.1
    port: 25678
    user: mas
    database: mas
`

describe('@auto-coding/ui-requirements Node half', () => {
  it('finds a row config inside an insert list', () => {
    const patches = [
      { insert: [{ id: 'timer', name: 'x' }, { id: 'db-pgmas', name: 'y', config: { host: '1.2.3.4', port: 5432 } }] },
    ]
    expect(findRowConfig(patches, 'db-pgmas')).toEqual({ host: '1.2.3.4', port: 5432 })
  })

  it('lets a top-level override win over the insert config', () => {
    const patches = [
      { insert: [{ id: 'db-pgmas', name: 'y', config: { host: 'insert', port: 1 } }] },
      { id: 'db-pgmas', config: { host: 'override', port: 2 } },
    ]
    expect(findRowConfig(patches, 'db-pgmas')).toEqual({ host: 'override', port: 2 })
  })

  it('returns undefined when the row is absent', () => {
    expect(findRowConfig([{ insert: [{ id: 'timer' }] }], 'db-pgmas')).toBeUndefined()
  })

  it('validates a well-formed pg config', () => {
    expect(validatePgConfig({ host: 'h', port: 5432, user: 'u', database: 'd', databases: ['a'], readOnly: true, maxRows: 50 })).toBeUndefined()
  })

  it('rejects a bad port', () => {
    expect(validatePgConfig({ host: 'h', port: 70000, user: 'u', database: 'd' })).toContain('port')
  })

  it('rejects a non-array databases', () => {
    expect(validatePgConfig({ host: 'h', port: 5432, user: 'u', database: 'd', databases: 'mas' })).toContain('databases')
  })

  it('keeps !!js expressions in other rows when saving the db-pgmas override', () => {
    const next = upsertRowConfigInText(PATCH_WITH_JS_PORT, 'db-pgmas', {
      host: '10.0.0.5', port: 5433, user: 'u', database: 'd',
    })
    // Regression: a parse→JS→stringify round-trip stripped the tag, turning the
    // webserver port into a literal string and breaking the next boot.
    expect(next).toContain('!!js ctx.webStartup.port ?? 3080')
    // Exactly one top-level override row for db-pgmas (the insert row stays).
    expect(next.match(/^- id: db-pgmas/mg)).toHaveLength(1)
    expect(findRowConfig(parsePatchText(next), 'db-pgmas')).toEqual({
      host: '10.0.0.5', port: 5433, user: 'u', database: 'd',
    })
  })

  it('appends a new override row when the row is absent', () => {
    const next = upsertRowConfigInText('- id: timer\n  config: {}\n', 'db-pgmas', {
      host: 'h', port: 5432, user: 'u', database: 'd',
    })
    expect(findRowConfig(parsePatchText(next), 'db-pgmas')).toEqual({ host: 'h', port: 5432, user: 'u', database: 'd' })
  })

  it('starts from an empty list for a missing/empty patch file', () => {
    const next = upsertRowConfigInText('', 'db-pgmas', { host: 'h', port: 5432, user: 'u', database: 'd' })
    expect(next).toContain('id: db-pgmas')
    expect(findRowConfig(parsePatchText(next), 'db-pgmas')).toEqual({ host: 'h', port: 5432, user: 'u', database: 'd' })
  })

  it('reports a parse error instead of clobbering a broken patch file', () => {
    expect(() => upsertRowConfigInText('not: [valid\n', 'db-pgmas', { host: 'h', port: 5432, user: 'u', database: 'd' }))
      .toThrow(/patch parse error/)
  })
})
