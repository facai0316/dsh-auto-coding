import { afterAll, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { Config, apply, writeKeyword } from '../src/index.ts'

/** Loader-shaped fake: captures registrations; `dispose` runs the effect cleanup. */
function mount(): { tools: ToolDefinition[]; dispose: () => void } {
  const registered: ToolDefinition[] = []
  const cleanups: Array<() => void> = []
  const ctx = {
    tools: { register: (definition: ToolDefinition) => registered.push(definition) },
    systemPrompt: { section: () => () => {} },
    provide: () => () => {},
    effect: (getDisposer: () => () => void) => {
      cleanups.push(getDisposer())
      return () => {}
    },
  } as unknown as Context
  const result = (Config as unknown as { '~standard': { validate: (input: unknown) => { value: unknown } } })
    ['~standard'].validate({})
  apply(ctx, result.value as never)
  return {
    tools: registered,
    dispose: () => { for (const cleanup of cleanups) cleanup() },
  }
}

const disposers: Array<() => void> = []
afterAll(() => { for (const dispose of disposers) dispose() })

const neverAborts = new AbortController().signal

function find(tools: ToolDefinition[], name: string): ToolDefinition {
  const tool = tools.find(candidate => candidate.name === name)
  if (tool === undefined) throw new Error(`tool ${name} not registered`)
  return tool
}

function tool(name: string): ToolDefinition {
  const instance = mount()
  disposers.push(instance.dispose)
  return find(instance.tools, name)
}

async function reachable(): Promise<boolean> {
  const instance = mount()
  try {
    await find(instance.tools, 'pg_query').execute({ sql: 'select 1' }, { signal: neverAborts } as never)
    return true
  } catch {
    return false
  } finally {
    instance.dispose()
  }
}

describe('db-pgmas Config defaults', () => {
  it('resolves full defaults from an empty row config and registers both tools', () => {
    const instance = mount()
    disposers.push(instance.dispose)
    expect(instance.tools.map(entry => entry.name).sort()).toEqual(['pg_query', 'pg_schema'])
  })
})

describe('db-pgmas read-only guard', () => {
  it.each([
    ['select 1', ''],
    ["select 'drop table x' as note", ''],
    ['select 1 -- drop table x', ''],
    ['/* create index */ select 1', ''],
    ['select $$update t set a=1$$ as dollar', ''],
    ['select "create" as col from t', ''],
    ['insert into t values (1)', 'insert'],
    ['UPDATE t SET a = 1', 'update'],
    ['with cte as (select 1) delete from t', 'delete'],
    ['select 1; drop table t', 'drop'],
    ['TRUNCATE t', 'truncate'],
    ['notify channel', 'notify'],
  ])('%j → %j', (sql, expected) => {
    expect(writeKeyword(sql)).toBe(expected)
  })
})

describe.skipIf(!(await reachable()))('db-pgmas against the live pg-mas instance', () => {
  it('pg_query runs a parameterized select', async () => {
    const result = await tool('pg_query').execute(
      { sql: 'select $1::int + 1 as sum', params: [41] },
      { signal: neverAborts } as never,
    ) as { command: string; rowCount: number; rows: { sum: number }[] }
    expect(result.command).toBe('SELECT')
    expect(result.rowCount).toBe(1)
    expect(result.rows[0]?.sum).toBe(42)
  })

  it('pg_query rejects writes under the default readOnly config', async () => {
    await expect(tool('pg_query').execute(
      { sql: 'create table _pgmas_probe(id int)' },
      { signal: neverAborts } as never,
    )).rejects.toThrow(/read-only/)
  })

  it('pg_query rejects databases outside the allowlist', async () => {
    await expect(tool('pg_query').execute(
      { sql: 'select 1', database: 'postgres' },
      { signal: neverAborts } as never,
    )).rejects.toThrow(/not enabled/)
  })

  it('pg_query truncates oversized result sets', async () => {
    const result = await tool('pg_query').execute(
      { sql: 'select generate_series(1, 10) as n', max_rows: 3 },
      { signal: neverAborts } as never,
    ) as { rows: unknown[]; truncated: boolean }
    expect(result.rows).toHaveLength(3)
    expect(result.truncated).toBe(true)
  })

  it('pg_schema lists databases and tables, and describes a table', async () => {
    const databases = await tool('pg_schema').execute(
      { listDatabases: true },
      { signal: neverAborts } as never,
    ) as { scope: string; databases: { name: string; default: boolean }[] }
    expect(databases.scope).toBe('databases')
    expect(databases.databases.map(entry => entry.name)).toContain('mas')

    const tables = await tool('pg_schema').execute({}, { signal: neverAborts } as never) as {
      scope: string
      database: string
      tables: { schema: string; name: string }[]
    }
    expect(tables.scope).toBe('tables')
    expect(tables.database).toBe('mas')
    expect(tables.tables.length).toBeGreaterThan(0)

    const first = tables.tables[0]
    const detail = await tool('pg_schema').execute(
      { table: `${first?.schema}.${first?.name}` },
      { signal: neverAborts } as never,
    ) as { scope: string; table: { columns: { name: string }[] } }
    expect(detail.scope).toBe('table')
    expect(detail.table.columns.length).toBeGreaterThan(0)
  })
})
