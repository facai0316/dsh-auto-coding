/**
 * Decorator-free helpers for the ui-requirements host half: reading and
 * validating the db-pgmas row config inside a user-layer `cordis.patch.yml`.
 * Kept out of `index.ts` (which uses TC39 decorators via Typert) so vitest /
 * esbuild can exercise them directly.
 */

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parseDocument, stringify } from 'yaml'

export interface Config {
  /** dsh profile whose `cordis.patch.yml` holds the db-pgmas row. */
  profileName?: string
  /** Absolute patch file to write; overrides profile resolution. */
  patchPath?: string
  /** Row id of the pg plugin inside that patch file. */
  dbRowId?: string
  /** Optional absolute path to a markdown usage document. */
  usagePath?: string
}

/** Defaults mirroring `@auto-coding/db-pgmas` Config (keep in sync). */
export const PG_DEFAULTS = {
  host: '127.0.0.1',
  port: 25678,
  user: 'mas',
  password: '',
  database: 'mas',
  databases: ['mas', 'cm', 'facai'],
  readOnly: true,
  maxRows: 50,
  statementTimeoutMs: 15_000,
  connectTimeoutMs: 5_000,
  poolMax: 4,
} as const

export function dshHome(): string {
  return process.env.DSH_HOME?.trim() !== '' ? process.env.DSH_HOME!.trim() : join(homedir(), '.dsh')
}

export function resolvePatchPath(config: Config): string {
  if (config.patchPath) return config.patchPath
  return join(dshHome(), 'profiles', config.profileName ?? 'web', 'cordis.patch.yml')
}

/** Find the db-pgmas row's own `config` inside one patch list (user layer). */
export function findRowConfig(patches: unknown[], rowId: string): Record<string, unknown> | undefined {
  let insertConfig: Record<string, unknown> | undefined
  for (const entry of patches) {
    if (entry === null || typeof entry !== 'object') continue
    const obj = entry as Record<string, unknown>
    if (Array.isArray(obj.insert)) {
      for (const item of obj.insert) {
        if (item === null || typeof item !== 'object') continue
        const row = item as Record<string, unknown>
        if (row.id === rowId && row.config !== null && typeof row.config === 'object') {
          insertConfig = row.config as Record<string, unknown>
        }
      }
    } else if (obj.id === rowId && obj.config !== null && typeof obj.config === 'object') {
      // Top-level override wins over insert config (last write wins per row).
      return obj.config as Record<string, unknown>
    }
  }
  return insertConfig
}

export function parsePatchFile(file: string): unknown[] {
  if (!existsSync(file)) return []
  const text = readFileSync(file, 'utf8')
  const doc = parseDocument(text)
  if (doc.errors.length > 0) throw new Error(`patch parse error: ${doc.errors[0].message}`)
  const items = doc.toJS() as unknown
  return Array.isArray(items) ? items : []
}

export function serializePatch(items: unknown[]): string {
  return stringify(items)
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function validatePgConfig(value: unknown): string | undefined {
  if (!isRecord(value)) return '配置必须是对象'
  const { host, port, user, password, database, databases, readOnly, maxRows } = value
  if (typeof host !== 'string' || host.trim() === '') return 'host 必须是字符串'
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) return 'port 必须是 1–65535 的整数'
  if (typeof user !== 'string') return 'user 必须是字符串'
  if (password !== undefined && typeof password !== 'string') return 'password 必须是字符串'
  if (typeof database !== 'string' || database.trim() === '') return 'database 必须是字符串'
  if (databases !== undefined && (!Array.isArray(databases) || databases.some(d => typeof d !== 'string'))) {
    return 'databases 必须是字符串数组'
  }
  if (readOnly !== undefined && typeof readOnly !== 'boolean') return 'readOnly 必须是布尔值'
  if (maxRows !== undefined && (typeof maxRows !== 'number' || !Number.isInteger(maxRows) || maxRows < 1 || maxRows > 1000)) {
    return 'maxRows 必须是 1–1000 的整数'
  }
  return undefined
}

export function mergedConfig(raw: Record<string, unknown> | undefined): Record<string, unknown> {
  return { ...PG_DEFAULTS, ...(raw ?? {}) }
}
