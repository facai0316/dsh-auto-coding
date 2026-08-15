/**
 * db-pgmas — host-only dsh plugin: convenient access to the local `pg-mas`
 * PostgreSQL 16 Docker instance (postgres:16, host port 25678).
 *
 * Mounted as one row in a profile's `cordis.patch.yml`, it contributes, at
 * profile-root (process-global) scope:
 *
 *  - service `pgmas` — pooled query + schema introspection for other plugins
 *    (`ctx.get('pgmas')` / `inject: ['pgmas']`);
 *  - model tools `pg_query` and `pg_schema`, visible to every agent session;
 *  - prompt section `tool:pg-mas` (order 107, right after `tool:jobs`).
 *
 * Connection defaults encode the discovered instance (user/db `mas`, host
 * port 25678); every value is overridable from the row `config:`. Read-only
 * by default: mutating SQL is rejected unless the row sets `readOnly: false`.
 *
 * The read-only guard is a best-effort model guardrail, not a security
 * boundary — it fails closed on write-looking keywords after stripping
 * comments and string literals.
 *
 * @module @auto-coding/db-pgmas
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue, ToolCallView, ToolRunContext } from '@deepseek-ai/dsh-tools'
import pg from 'pg'

export const name = 'db-pgmas'
export const inject = ['tools', 'systemPrompt']

// ───────────────────────────── configuration ─────────────────────────────

/** Row configuration; defaults describe the discovered pg-mas instance. */
export interface Config {
  /** PostgreSQL host (the docker-published host port). */
  host: string
  /** PostgreSQL port on the host. */
  port: number
  /** Login user. */
  user: string
  /** Login password. */
  password: string
  /** Default database (POSTGRES_DB of the container). */
  database: string
  /**
   * Databases the tools may address (the `database:` argument allowlist).
   * `['*']` allows any database the login can reach.
   */
  databases: string[]
  /** Reject mutating SQL in `pg_query` (default true). */
  readOnly: boolean
  /** Default row cap for `pg_query` results. */
  maxRows: number
  /** Per-statement server-side timeout (statement_timeout). */
  statementTimeoutMs: number
  /** Pool connect timeout. */
  connectTimeoutMs: number
  /** Pool size per database. */
  poolMax: number
}

export const Config: z<Config> = z.object({
  host: z.string().default('127.0.0.1'),
  port: z.number().min(1).max(65535).default(25678),
  user: z.string().default('mas'),
  password: z.string().default('Fa^Cai!0316#Mas.'),
  database: z.string().default('mas'),
  databases: z.array(z.string()).default(['mas', 'cm', 'facai']),
  readOnly: z.boolean().default(true),
  maxRows: z.number().min(1).max(1000).default(50),
  statementTimeoutMs: z.number().min(100).max(600_000).default(15_000),
  connectTimeoutMs: z.number().min(100).max(120_000).default(5_000),
  poolMax: z.number().min(1).max(32).default(4),
})

// ─────────────────────────────── service types ───────────────────────────

/** Canonical result of one `query` call; `rows` carries the LAST statement. */
export interface PgMasQueryResult {
  database: string
  /** Command tag of the last statement, e.g. `SELECT` or `UPDATE`. */
  command: string
  /** Per-statement command tags, one entry per statement in the batch. */
  statements: { command: string; rowCount: number }[]
  /** Row count of the last statement; affected rows for DML, `-1` when null. */
  rowCount: number
  /** Rows of the last statement, as returned by the driver. */
  rows: Record<string, unknown>[]
  durationMs: number
}

/** One database row of `listDatabases`. */
export interface PgMasDatabaseSummary {
  name: string
  size: string
  activeConnections: number
  default: boolean
}

/** One table/view row of `listTables`. */
export interface PgMasTableSummary {
  schema: string
  name: string
  kind: string
  rowEstimate: number
  totalSize: string
  comment?: string
}

/** Full column/index detail of one table. */
export interface PgMasTableDetail {
  schema: string
  name: string
  kind: string
  rowEstimate: number
  columns: { name: string; type: string; nullable: boolean; default?: string; comment?: string }[]
  indexes: { name: string; definition: string }[]
  foreignKeys: { name: string; definition: string }[]
}

/** Service seam other host plugins may consume. */
export interface PgMasService {
  readonly defaults: Readonly<{
    host: string
    port: number
    user: string
    database: string
    databases: readonly string[]
    readOnly: boolean
  }>
  query(sql: string, options?: { params?: unknown[]; database?: string; signal?: AbortSignal }): Promise<PgMasQueryResult>
  listDatabases(signal?: AbortSignal): Promise<PgMasDatabaseSummary[]>
  listTables(database?: string, signal?: AbortSignal): Promise<PgMasTableSummary[]>
  describeTable(table: string, database?: string): Promise<PgMasTableDetail>
  testConnection(database?: string): Promise<{ database: string; serverVersion: number; latencyMs: number }>
  /**
   * Service-level write seam: run `fn` against one pooled client of `database`
   * and always release it. Unlike `query()`, this path does NOT apply the
   * read-only guard — that guard belongs to the `pg_query` model tool, not to
   * consuming services. `database` still resolves through the row `databases`
   * allowlist. Use it for transactions (`BEGIN`/`COMMIT`/`ROLLBACK`) and
   * multi-statement writes; release-cleanup is owned here.
   */
  withClient<T>(database: string, fn: (client: pg.PoolClient) => Promise<T>, signal?: AbortSignal): Promise<T>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    pgmas: PgMasService
  }
}

// ─────────────────────────── JSON-safe conversion ────────────────────────

const MAX_BINARY_HEX_BYTES = 256

/** Lossless-JSON projection of one driver value (Date → ISO, bytea → hex…). */
function toJsonSafe(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return null
  const type = typeof value
  if (type === 'string' || type === 'number' || type === 'boolean') return value
  if (type === 'bigint') return (value as bigint).toString()
  if (value instanceof Date) return value.toISOString()
  if (value instanceof Uint8Array) {
    const bytes = value.subarray(0, MAX_BINARY_HEX_BYTES)
    const suffix = value.length > MAX_BINARY_HEX_BYTES ? `… (${value.length} bytes)` : ''
    return `0x${Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length).toString('hex')}${suffix}`
  }
  if (Array.isArray(value)) return depth > 16 ? null : value.map(entry => toJsonSafe(entry, depth + 1))
  if (type === 'object') {
    if (depth > 16) return null
    const out: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      out[key] = toJsonSafe(entry, depth + 1)
    }
    return out
  }
  return String(value)
}

function safeRow(row: Record<string, unknown>): Record<string, JsonValue> {
  const out: Record<string, JsonValue> = {}
  for (const [key, value] of Object.entries(row)) out[key] = toJsonSafe(value) as JsonValue
  return out
}

// ─────────────────────────── read-only statement guard ───────────────────

/**
 * Reserved write verbs: scanned anywhere (as standalone words) after comments
 * and string literals are stripped. All of these are reserved keywords in
 * PostgreSQL, so they cannot appear as unquoted identifiers.
 */
const STRICT_WRITE_VERBS = [
  'insert', 'update', 'delete', 'truncate', 'create', 'alter', 'drop',
  'grant', 'revoke', 'copy', 'merge', 'call', 'do', 'reindex', 'cluster',
  'vacuum', 'checkpoint', 'set', 'reset', 'begin', 'commit', 'rollback',
]

/**
 * Non-reserved write verbs: only rejected as the FIRST word of a top-level
 * statement (they double as plausible column names mid-statement).
 */
const HEAD_WRITE_VERBS = new Set([
  'comment', 'lock', 'listen', 'notify', 'prepare', 'execute', 'deallocate',
  'analyze', 'analyse', 'refresh', 'import', 'discard', 'savepoint',
])

const STRICT_WRITE_PATTERNS = STRICT_WRITE_VERBS
  .map(verb => [verb, new RegExp(`(^|[^A-Za-z0-9_$])${verb}([^A-Za-z0-9_$]|$)`, 'i')] as const)

/** Replace comments and string/ dollar-quoted literals with spaces. */
function stripLiteralsAndComments(sql: string): string {
  let out = ''
  let index = 0
  const length = sql.length
  while (index < length) {
    const char = sql[index]
    const next = index + 1 < length ? sql[index + 1] : ''
    // line comment
    if (char === '-' && next === '-') {
      while (index < length && sql[index] !== '\n') index += 1
      out += ' '
      continue
    }
    // block comment
    if (char === '/' && next === '*') {
      index += 2
      while (index < length && !(sql[index] === '*' && sql[index + 1] === '/')) index += 1
      index = Math.min(index + 2, length)
      out += ' '
      continue
    }
    // dollar-quoted string ($$…$$ or $tag$…$tag$)
    if (char === '$') {
      const match = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(index))
      if (match !== null) {
        const tag = match[0]
        const end = sql.indexOf(tag, index + tag.length)
        index = end === -1 ? length : end + tag.length
        out += ' '
        continue
      }
    }
    // standard-conforming string literal ('' escapes a quote)
    if (char === '\'') {
      index += 1
      while (index < length) {
        if (sql[index] === '\'') {
          if (sql[index + 1] === '\'') { index += 2; continue }
          index += 1
          break
        }
        index += 1
      }
      out += ' '
      continue
    }
    // quoted identifier
    if (char === '"') {
      index += 1
      while (index < length) {
        if (sql[index] === '"') {
          if (sql[index + 1] === '"') { index += 2; continue }
          index += 1
          break
        }
        index += 1
      }
      out += ' '
      continue
    }
    out += char
    index += 1
  }
  return out
}

/** Split into top-level statements on `;` (literals already stripped). */
function splitStatements(stripped: string): string[] {
  return stripped
    .split(';')
    .map(part => part.trim())
    .filter(part => part.length > 0)
}

/** First keyword of one statement, lowercased; '' for empty. */
function headVerb(statement: string): string {
  const match = /^[a-zA-Z]+/.exec(statement)
  return match === null ? '' : match[0].toLowerCase()
}

/**
 * Best-effort read-only check. Returns the offending keyword, or '' when the
 * SQL looks read-only. Fails closed: a remaining write keyword anywhere is
 * rejected, so anything the scanner cannot understand errs on rejection.
 */
export function writeKeyword(sql: string): string {
  const stripped = stripLiteralsAndComments(sql)
  for (const [verb, pattern] of STRICT_WRITE_PATTERNS) {
    if (pattern.test(stripped)) return verb
  }
  for (const statement of splitStatements(stripped)) {
    const verb = headVerb(statement)
    if (HEAD_WRITE_VERBS.has(verb)) return verb
  }
  return ''
}

// ───────────────────────────────── catalog SQL ───────────────────────────

const TABLES_SQL = `
  select n.nspname as schema,
         c.relname as name,
         case c.relkind
           when 'r' then 'table'
           when 'p' then 'partitioned table'
           when 'v' then 'view'
           when 'm' then 'materialized view'
           when 'f' then 'foreign table'
           else c.relkind::text
         end as kind,
         greatest(coalesce(s.n_live_tup, 0), greatest(c.reltuples, 0))::bigint as row_estimate,
         pg_size_pretty(pg_total_relation_size(c.oid)) as total_size,
         obj_description(c.oid, 'pg_class') as comment
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  left join pg_stat_user_tables s on s.relid = c.oid
  where n.nspname not in ('pg_catalog', 'information_schema')
    and c.relkind in ('r', 'p', 'v', 'm', 'f')
  order by n.nspname, c.relname
`

const DATABASES_SQL = `
  select d.datname as name,
         pg_size_pretty(pg_database_size(d.datname)) as size,
         (select count(*)::int from pg_stat_activity a where a.datname = d.datname) as active_connections
  from pg_database d
  where d.datallowconn and not d.datistemplate
  order by pg_database_size(d.datname) desc
`

const SCHEMA_LOOKUP_SQL = `
  select table_schema
  from information_schema.tables
  where table_name = $1
    and table_schema not in ('pg_catalog', 'information_schema')
  order by case when table_schema = 'public' then 0 else 1 end, table_schema
`

const COLUMNS_SQL = `
  select a.attname as name,
         format_type(a.atttypid, a.atttypmod) as data_type,
         (not a.attnotnull) as is_nullable,
         pg_get_expr(d.adbin, d.adrelid) as column_default,
         col_description(a.attrelid, a.attnum) as comment
  from pg_attribute a
  left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
  where a.attrelid = $1::regclass and a.attnum > 0 and not a.attisdropped
  order by a.attnum
`

const RELATION_KIND_SQL = `
  select n.nspname as schema, c.relname as name, c.relkind,
         greatest(c.reltuples, 0)::bigint as row_estimate
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where c.oid = $1::regclass
`

const INDEXES_SQL = `
  select indexname as name, indexdef as definition
  from pg_indexes
  where schemaname = $1 and tablename = $2
  order by indexname
`

const FOREIGN_KEYS_SQL = `
  select conname as name, pg_get_constraintdef(oid) as definition
  from pg_constraint
  where conrelid = $1::regclass and contype = 'f'
  order by conname
`

const VERSION_SQL = 'select version()'

function relationKindLabel(relkind: string): string {
  switch (relkind) {
    case 'r': return 'table'
    case 'p': return 'partitioned table'
    case 'v': return 'view'
    case 'm': return 'materialized view'
    case 'f': return 'foreign table'
    default: return relkind
  }
}

// ──────────────────────────────── plugin ─────────────────────────────────

export function apply(ctx: Context, config: Config): void {
  const anyDatabases = config.databases.includes('*')

  const allowDatabase = (database: string): string => {
    if (anyDatabases || config.databases.includes(database)) return database
    throw new Error(
      `database "${database}" is not enabled for pg-mas; enabled: ${config.databases.join(', ')} `
      + '(widen the db-pgmas row config `databases` list to add it)',
    )
  }

  const pools = new Map<string, pg.Pool>()
  const poolFor = (database: string): pg.Pool => {
    const key = allowDatabase(database)
    let pool = pools.get(key)
    if (pool === undefined) {
      pool = new pg.Pool({
        host: config.host,
        port: config.port,
        user: config.user,
        password: config.password,
        database: key,
        max: config.poolMax,
        connectionTimeoutMillis: config.connectTimeoutMs,
        statement_timeout: config.statementTimeoutMs,
        idleTimeoutMillis: 30_000,
      })
      // A pool-level 'error' listener is mandatory: an idle client error must
      // never crash the host process.
      pool.on('error', () => {})
      pools.set(key, pool)
    }
    return pool
  }

  /**
   * Acquire one client and always release it. An `abortSignal` destroy-releases
   * the client: node-pg exposes no per-query cancel, so tearing the connection
   * down is the cooperative cancellation (the server-side statement_timeout
   * bounds anything the abort might race). Multi-statement simple queries
   * resolve to an array of results.
   */
  async function withClient<T>(
    database: string,
    run: (client: pg.PoolClient) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const client = await poolFor(database).connect()
    let destroyed = false
    let cancel: (() => void) | undefined
    try {
      if (signal !== undefined) {
        cancel = () => {
          if (destroyed) return
          destroyed = true
          client.release(true)
        }
        signal.addEventListener('abort', cancel, { once: true })
      }
      if (signal?.aborted === true) throw new Error('aborted before dispatch')
      try {
        return await run(client)
      } finally {
        if (cancel !== undefined && signal !== undefined) signal.removeEventListener('abort', cancel)
      }
    } finally {
      if (!destroyed) client.release()
    }
  }

  /** One statement batch on one client; multi-statement SQL → array result. */
  const rawQuery = (
    database: string,
    sql: string,
    params: unknown[] | undefined,
    signal?: AbortSignal,
  ): Promise<pg.QueryResult | (pg.QueryResult | unknown)[]> =>
    withClient(database, client =>
      params === undefined
        ? client.query({ text: sql }) as unknown as Promise<pg.QueryResult | (pg.QueryResult | unknown)[]>
        : client.query({ text: sql, values: params as never }) as unknown as Promise<pg.QueryResult>, signal)

  function single(outcome: pg.QueryResult | (pg.QueryResult | unknown)[]): pg.QueryResult {
    return Array.isArray(outcome) ? (outcome[outcome.length - 1] as pg.QueryResult) : outcome
  }

  async function query(
    sql: string,
    options: { params?: unknown[]; database?: string; signal?: AbortSignal } = {},
  ): Promise<PgMasQueryResult> {
    const database = options.database === undefined ? config.database : allowDatabase(options.database)
    if (sql.trim().length === 0) throw new Error('sql must be a non-empty string')
    if (config.readOnly) {
      const verb = writeKeyword(sql)
      if (verb !== '') {
        throw new Error(
          `pg-mas is mounted read-only and the statement contains the write keyword "${verb}" `
          + '(the guard rejects write-looking keywords after stripping comments and literals). '
          + 'A false positive on a quoted identifier can be avoided by quoting it; for real '
          + 'writes, set `readOnly: false` in the db-pgmas row config.',
        )
      }
    }
    const startedAt = Date.now()
    const outcome = await rawQuery(database, sql, options.params, options.signal)
    const durationMs = Date.now() - startedAt
    const results = Array.isArray(outcome) ? outcome : [outcome]
    const last = single(outcome)
    return {
      database,
      command: last.command ?? '',
      statements: results.map(result => ({
        command: (result as pg.QueryResult).command ?? '',
        rowCount: (result as pg.QueryResult).rowCount ?? -1,
      })),
      rowCount: last.rowCount ?? -1,
      rows: (last.rows ?? []) as Record<string, unknown>[],
      durationMs,
    }
  }

  async function listDatabases(signal?: AbortSignal): Promise<PgMasDatabaseSummary[]> {
    const outcome = single(await rawQuery(config.database, DATABASES_SQL, undefined, signal))
    return (outcome.rows as Record<string, unknown>[]).map(row => ({
      name: String(row.name),
      size: String(row.size),
      activeConnections: Number(row.active_connections ?? 0),
      default: row.name === config.database,
    }))
  }

  async function listTables(database?: string, signal?: AbortSignal): Promise<PgMasTableSummary[]> {
    const target = database === undefined ? config.database : allowDatabase(database)
    const outcome = single(await rawQuery(target, TABLES_SQL, undefined, signal))
    return (outcome.rows as Record<string, unknown>[]).map(row => ({
      schema: String(row.schema),
      name: String(row.name),
      kind: String(row.kind),
      rowEstimate: Number(row.row_estimate ?? 0),
      totalSize: String(row.total_size),
      ...(row.comment === null || row.comment === undefined ? {} : { comment: String(row.comment) }),
    }))
  }

  async function describeTable(table: string, database?: string): Promise<PgMasTableDetail> {
    const target = database === undefined ? config.database : allowDatabase(database)
    const trimmed = table.trim()
    const dot = trimmed.indexOf('.')
    let schemaName: string | undefined
    let tableName: string
    if (dot > 0) {
      schemaName = trimmed.slice(0, dot)
      tableName = trimmed.slice(dot + 1)
    } else {
      tableName = trimmed
    }
    if (tableName.length === 0) throw new Error(`invalid table reference "${trimmed}"`)
    if (schemaName === undefined) {
      const lookup = single(await rawQuery(target, SCHEMA_LOOKUP_SQL, [tableName]))
      const first = (lookup.rows as Record<string, unknown>[])[0]
      if (first === undefined) {
        throw new Error(`table "${trimmed}" not found in database "${target}" (call pg_schema without \`table\` for the listing)`)
      }
      schemaName = String(first.table_schema)
    }
    const qualified = `"${schemaName}"."${tableName}"`
    const relation = single(await rawQuery(target, RELATION_KIND_SQL, [qualified]))
    const relationRow = (relation.rows as Record<string, unknown>[])[0]
    if (relationRow === undefined) {
      throw new Error(`relation "${qualified}" not found in database "${target}"`)
    }
    const [columns, indexes, foreignKeys] = await Promise.all([
      rawQuery(target, COLUMNS_SQL, [qualified]),
      rawQuery(target, INDEXES_SQL, [schemaName, tableName]),
      rawQuery(target, FOREIGN_KEYS_SQL, [qualified]),
    ])
    return {
      schema: String(relationRow.schema),
      name: String(relationRow.name),
      kind: relationKindLabel(String(relationRow.relkind)),
      rowEstimate: Number(relationRow.row_estimate ?? 0),
      columns: (single(columns).rows as Record<string, unknown>[]).map(row => ({
        name: String(row.name),
        type: String(row.data_type),
        nullable: Boolean(row.is_nullable),
        ...(row.column_default === null || row.column_default === undefined ? {} : { default: String(row.column_default) }),
        ...(row.comment === null || row.comment === undefined ? {} : { comment: String(row.comment) }),
      })),
      indexes: (single(indexes).rows as Record<string, unknown>[]).map(row => ({
        name: String(row.name),
        definition: String(row.definition),
      })),
      foreignKeys: (single(foreignKeys).rows as Record<string, unknown>[]).map(row => ({
        name: String(row.name),
        definition: String(row.definition),
      })),
    }
  }

  async function testConnection(database?: string): Promise<{ database: string; serverVersion: number; latencyMs: number }> {
    const target = database === undefined ? config.database : allowDatabase(database)
    const startedAt = Date.now()
    const outcome = single(await rawQuery(target, VERSION_SQL, undefined))
    const versionText = String((outcome.rows as Record<string, unknown>[])[0]?.version ?? '')
    const match = /PostgreSQL (\d+)/.exec(versionText)
    return {
      database: target,
      serverVersion: match === null ? 0 : Number(match[1]),
      latencyMs: Date.now() - startedAt,
    }
  }

  // Service seam: fiber-scoped provide, withdrawn automatically on dispose.
  const service: PgMasService = {
    defaults: {
      host: config.host,
      port: config.port,
      user: config.user,
      database: config.database,
      databases: Object.freeze([...config.databases]),
      readOnly: config.readOnly,
    },
    query,
    listDatabases,
    listTables,
    describeTable,
    testConnection,
    withClient,
  }
  const withdrawService = ctx.provide('pgmas', service)

  // Pools close on fiber dispose (row removal, config change, process exit).
  ctx.effect(() => () => {
    withdrawService()
    for (const pool of pools.values()) void pool.end().catch(() => {})
    pools.clear()
  }, 'db-pgmas: close pools and withdraw service')

  // ── model tools ──────────────────────────────────────────────────────────

  const databaseParam = {
    type: 'string' as const,
    description: `Target database (default "${config.database}"; enabled: ${config.databases.join(', ')}).`,
  }
  const enabledDatabases = config.databases.join(', ')

  ctx.tools.register(defineTool({
    name: 'pg_query',
    description: 'Run SQL against the local pg-mas PostgreSQL instance (docker container `pg-mas`, '
      + `PostgreSQL 16; databases ${enabledDatabases}). Supports multi-statement batches when no `
      + '`params` are given; the last statement\'s rows are returned along with every statement\'s '
      + 'command tag. '
      + (config.readOnly
        ? 'The instance is READ-ONLY here: write-looking keywords (INSERT/UPDATE/DELETE/CREATE/…, after stripping comments and literals) are rejected. '
        : 'Writes are enabled: prefer explicit transactions and verify changes with a follow-up SELECT. ')
      + 'Inspect unfamiliar tables with pg_schema first; keep result sets bounded.',
    parameters: {
      sql: {
        type: 'string',
        required: true,
        description: 'SQL to execute; a trailing `;` is fine. Use $1, $2 … together with `params` for value binding.',
      },
      params: {
        type: 'json',
        description: 'Optional JSON array bound to $1, $2 … placeholders. When omitted, multi-statement batches are allowed.',
      },
      database: databaseParam,
      max_rows: {
        type: 'number',
        description: `Row cap for returned rows (1-1000, default ${config.maxRows}); a larger result set is truncated and flagged \`truncated\`.`,
      },
    },
    timeoutMs: 60_000,
    isConcurrencySafe: () => config.readOnly,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          database: { type: 'string' },
          command: { type: 'string' },
          statements: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: { command: { type: 'string' }, rowCount: { type: 'integer' } },
            },
          },
          rowCount: { type: 'integer' },
          rows: { type: 'array', items: { type: 'json' } },
          truncated: { type: 'boolean' },
          durationMs: { type: 'integer' },
        },
      },
      render: (_args, value) => {
        const result = value as { database: string; command: string; rowCount: number; rows: unknown[]; truncated: boolean; durationMs: number }
        const header = `[pg-mas/${result.database}] ${result.command} — ${result.rowCount} row(s) in ${result.durationMs}ms`
        const lines = result.rows.map(row => JSON.stringify(row))
        const truncation = result.truncated ? [`[truncated: showing ${result.rows.length} rows]`] : []
        return [{ type: 'text', text: [header, ...lines, ...truncation].join('\n') }]
      },
    },
    async execute(args, exec: ToolRunContext) {
      const params = Array.isArray(args.params) ? args.params : undefined
      if (params !== undefined && params.length > 100) {
        throw new Error(`too many params (${params.length}); the cap is 100`)
      }
      const cap = Math.min(Math.max(Math.trunc(args.max_rows ?? config.maxRows), 1), 1000)
      const result = await query(args.sql, { params, database: args.database, signal: exec.signal })
      const safeRows = result.rows.map(safeRow)
      const truncated = safeRows.length > cap
      return {
        database: result.database,
        command: result.command,
        statements: result.statements,
        rowCount: result.rowCount,
        rows: truncated ? safeRows.slice(0, cap) : safeRows,
        truncated,
        durationMs: result.durationMs,
      }
    },
    presentCall: (args): ToolCallView => ({
      card: 'generic',
      title: `pg_query${args.database === undefined ? '' : ` (${String(args.database)})`}`,
      kind: 'execute',
      rawInput: typeof args.sql === 'string' ? args.sql : undefined,
    }),
  }))

  ctx.tools.register(defineTool({
    name: 'pg_schema',
    description: 'Inspect the local pg-mas PostgreSQL instance (docker container `pg-mas`). '
      + 'With `table`: columns, indexes, and foreign keys of that table. Without `table`: the '
      + 'target database\'s tables and views with row estimates and sizes. With `listDatabases`: '
      + 'every connectable database with size and connection count. Start here before pg_query '
      + 'on unfamiliar tables.',
    parameters: {
      database: databaseParam,
      table: {
        type: 'string',
        description: 'Table or view to describe, optionally schema-qualified (`public.users`); omit to list tables.',
      },
      listDatabases: {
        type: 'boolean',
        description: 'List every connectable database instead of tables (takes precedence over `table`).',
      },
    },
    timeoutMs: 30_000,
    isConcurrencySafe: () => true,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          database: { type: 'string' },
          scope: { type: 'string', enum: ['databases', 'tables', 'table'] },
          databases: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string' },
                size: { type: 'string' },
                activeConnections: { type: 'integer' },
                default: { type: 'boolean' },
              },
            },
          },
          tables: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                schema: { type: 'string' },
                name: { type: 'string' },
                kind: { type: 'string' },
                rowEstimate: { type: 'integer' },
                totalSize: { type: 'string' },
                comment: { type: 'string' },
              },
            },
          },
          table: {
            type: 'object',
            additionalProperties: false,
            properties: {
              schema: { type: 'string' },
              name: { type: 'string' },
              kind: { type: 'string' },
              rowEstimate: { type: 'integer' },
              columns: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    name: { type: 'string' },
                    type: { type: 'string' },
                    nullable: { type: 'boolean' },
                    default: { type: 'string' },
                    comment: { type: 'string' },
                  },
                },
              },
              indexes: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: { name: { type: 'string' }, definition: { type: 'string' } },
                },
              },
              foreignKeys: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: { name: { type: 'string' }, definition: { type: 'string' } },
                },
              },
            },
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderSchema(value as unknown as RenderableSchema) }],
    },
    async execute(args, exec: ToolRunContext) {
      if (args.listDatabases === true) {
        const databases = await listDatabases(exec.signal)
        return { database: '*', scope: 'databases' as const, databases }
      }
      if (args.table !== undefined) {
        const detail = await describeTable(args.table, args.database)
        return { database: args.database ?? config.database, scope: 'table' as const, table: detail }
      }
      const tables = await listTables(args.database, exec.signal)
      return { database: args.database ?? config.database, scope: 'tables' as const, tables }
    },
    presentCall: (args): ToolCallView => ({
      card: 'generic',
      title: args.listDatabases === true
        ? 'pg_schema (databases)'
        : args.table === undefined
          ? `pg_schema (tables${args.database === undefined ? '' : ` @ ${String(args.database)}`})`
          : `pg_schema ${String(args.table)}`,
      kind: 'read',
    }),
  }))

  // ── prompt guidance ──────────────────────────────────────────────────────

  ctx.systemPrompt.section({
    name: 'tool:pg-mas',
    order: 107,
    text: 'The pg_query and pg_schema tools reach the local pg-mas PostgreSQL instance '
      + `(databases ${enabledDatabases}; default ${config.database}). `
      + 'Inspect with pg_schema before querying unfamiliar tables, keep pg_query result sets '
      + 'bounded with max_rows, and never SELECT * a table whose size you have not checked. '
      + (config.readOnly
        ? 'The instance is read-only for these tools; mutating SQL is rejected by design.'
        : 'Writes are enabled — prefer explicit transactions (BEGIN … COMMIT) and verify with a SELECT afterwards.'),
  })
}

// ────────────────────────────── render helper ────────────────────────────

interface RenderableSchema {
  database: string
  scope: string
  databases?: { name: string; size: string; activeConnections: number; default: boolean }[]
  tables?: { schema: string; name: string; kind: string; rowEstimate: number; totalSize: string; comment?: string }[]
  table?: {
    schema: string
    name: string
    kind: string
    rowEstimate: number
    columns: { name: string; type: string; nullable: boolean; default?: string; comment?: string }[]
    indexes: { name: string; definition: string }[]
    foreignKeys: { name: string; definition: string }[]
  }
}

/** Compact fixed-width text projection of one pg_schema result. */
function renderSchema(value: RenderableSchema): string {
  if (value.scope === 'databases') {
    const rows = value.databases ?? []
    const width = Math.max(...rows.map(row => row.name.length), 'database'.length)
    const lines = [
      `database ${' '.repeat(Math.max(width - 'database'.length, 0))}  size         connections`,
      ...rows.map(row =>
        `${row.name.padEnd(width)}  ${row.size.padEnd(12)} ${String(row.activeConnections).padStart(3)}${row.default ? '  (default)' : ''}`),
    ]
    return lines.join('\n')
  }
  if (value.scope === 'table' && value.table !== undefined) {
    const detail = value.table
    const columnWidth = Math.max(...detail.columns.map(column => column.name.length), 4)
    const typeWidth = Math.max(...detail.columns.map(column => column.type.length), 4)
    const lines = [
      `${detail.schema}.${detail.name} (${detail.kind}, ~${detail.rowEstimate} rows)`,
      ...detail.columns.map(column =>
        `  ${column.name.padEnd(columnWidth)}  ${column.type.padEnd(typeWidth)}  ${column.nullable ? 'null' : 'not null'}`
        + `${column.default === undefined ? '' : `  default ${column.default}`}`
        + `${column.comment === undefined ? '' : `  -- ${column.comment}`}`),
    ]
    if (detail.indexes.length > 0) {
      lines.push('indexes:')
      for (const index of detail.indexes) lines.push(`  ${index.definition}`)
    }
    if (detail.foreignKeys.length > 0) {
      lines.push('foreign keys:')
      for (const foreignKey of detail.foreignKeys) lines.push(`  ${foreignKey.definition}`)
    }
    return lines.join('\n')
  }
  const rows = value.tables ?? []
  if (rows.length === 0) return `[pg-mas/${value.database}] (no tables or views)`
  const schemaWidth = Math.max(...rows.map(row => row.schema.length), 'schema'.length)
  const nameWidth = Math.max(...rows.map(row => row.name.length), 'name'.length)
  const kindWidth = Math.max(...rows.map(row => row.kind.length), 'kind'.length)
  const lines = rows.map(row =>
    `${row.schema.padEnd(schemaWidth)}  ${row.name.padEnd(nameWidth)}  ${row.kind.padEnd(kindWidth)}  `
    + `~${String(row.rowEstimate).padStart(10)}  ${row.totalSize.padStart(9)}${row.comment === undefined ? '' : `  -- ${row.comment}`}`)
  return `[pg-mas/${value.database}] ${rows.length} relation(s)\n${lines.join('\n')}`
}
