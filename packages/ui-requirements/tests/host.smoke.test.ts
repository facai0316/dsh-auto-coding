import { describe, expect, it } from 'vitest'
import { findRowConfig, validatePgConfig } from '../src/patch-utils.ts'

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
})
