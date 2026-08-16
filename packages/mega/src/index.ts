/**
 * ui-requirements plugin, Node half. Previously a pure UI plugin (empty
 * apply); now also hosts two Typert Remote namespaces backing the settings
 * pages shipped in the browser half:
 *
 *  - `pgconfig` — 数据库连接 settings page. Reads the db-pgmas row's
 *    effective config from the user-layer `cordis.patch.yml`, validates and
 *    writes a user-layer **config override** (`- id: db-pgmas  config: …`)
 *    that the patch watcher hot-applies without a restart, and can test a
 *    proposed config with a throwaway connection.
 *  - `usage` — 使用说明 settings page. Returns the usage markdown document
 *    (a placeholder until the real doc lands; optionally read from a file
 *    configured via `usagePath`).
 *
 * The browser half ships via `exports["./client"]`, discovered through the
 * package.json `dsh.client` declaration.
 *
 * Decorator-free helpers (patch reading/validation) live in `./patch-utils.ts`
 * so vitest can exercise them without a decorator transform.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import {
  PG_DEFAULTS,
  findRowConfig,
  mergedConfig,
  parsePatchFile,
  resolvePatchPath,
  serializePatch,
  validatePgConfig,
  type Config,
} from './patch-utils.ts'

export type { Config } from './patch-utils.ts'
export { findRowConfig, validatePgConfig, PG_DEFAULTS } from './patch-utils.ts'

export const name = 'ui-requirements'

/** pgconfig remote: read / save / test the db-pgmas row config. */
export class PgConfigRemote extends TypertRemoteService {
  private readonly config: Config

  constructor(ctx: Context, config: Config) {
    super(ctx, 'pgConfig', { namespace: 'pgconfig' })
    this.config = config
  }

  private patchPath(): string {
    return resolvePatchPath(this.config)
  }

  /** Current effective config: row override merged over defaults. */
  @Remote('get')
  async get(): Promise<{ patchPath: string; present: boolean; config: Record<string, unknown>; defaults: Record<string, unknown> }> {
    const file = this.patchPath()
    let raw: Record<string, unknown> | undefined
    try {
      raw = findRowConfig(parsePatchFile(file), this.config.dbRowId ?? 'db-pgmas')
    } catch {
      // Unreadable patch: report absence; the page surfaces the path.
    }
    return {
      patchPath: file,
      present: raw !== undefined,
      config: mergedConfig(raw),
      defaults: { ...PG_DEFAULTS },
    }
  }

  /** Validate and write a user-layer config override for the db-pgmas row. */
  @Remote('save')
  async save(value: unknown): Promise<{ ok: boolean; error?: string; config?: Record<string, unknown>; patchPath: string }> {
    const error = validatePgConfig(value)
    if (error !== undefined) return { ok: false, error, patchPath: this.patchPath() }
    const config = value as Record<string, unknown>
    const file = this.patchPath()
    try {
      let items: unknown[]
      try {
        items = parsePatchFile(file)
      } catch {
        items = []
      }
      // Replace an existing top-level override for this row id, else append.
      const rowId = this.config.dbRowId ?? 'db-pgmas'
      const overrideIndex = items.findIndex(item =>
        (item as Record<string, unknown> | null)?.id === rowId
        && !Array.isArray((item as Record<string, unknown>).insert))
      const override: Record<string, unknown> = { id: rowId, config }
      if (overrideIndex >= 0) items[overrideIndex] = override
      else items.push(override)
      writeFileSync(file, serializePatch(items), 'utf8')
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      return { ok: false, error: `写入 ${file} 失败: ${message}`, patchPath: file }
    }
    return { ok: true, config: mergedConfig(config), patchPath: file }
  }

  /** Open a throwaway connection with the proposed values (no pool created). */
  @Remote('test')
  async test(value: unknown): Promise<{ ok: boolean; message: string; config?: Record<string, unknown> }> {
    const error = validatePgConfig(value)
    if (error !== undefined) return { ok: false, message: error }
    const cfg = value as Record<string, unknown>
    // Lazy import keeps `pg` out of the plugin graph until a test runs.
    const pg = await import('pg') as typeof import('pg')
    const client = new pg.Client({
      host: cfg.host as string,
      port: cfg.port as number,
      user: cfg.user as string,
      password: (cfg.password as string | undefined) ?? '',
      database: cfg.database as string,
      connectionTimeoutMillis: 5_000,
      statement_timeout: 10_000,
    })
    try {
      const startedAt = Date.now()
      await client.connect()
      const result = await client.query('select version()')
      const version = String((result.rows[0] as Record<string, unknown> | undefined)?.version ?? '')
      const match = /PostgreSQL (\d+)/.exec(version)
      return {
        ok: true,
        message: `连接成功: ${cfg.host}:${cfg.port}/${cfg.database} (PostgreSQL ${match?.[1] ?? '?'}, ${Date.now() - startedAt}ms)`,
        config: mergedConfig(cfg),
      }
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      return { ok: false, message: `连接失败: ${message}` }
    } finally {
      await client.end().catch(() => {})
    }
  }
}

const USAGE_PLACEHOLDER = `# 使用说明

> 文档占位:使用说明内容待补充（包内 assets/USAGE.md 缺失）。
`

/**
 * 包内自带的使用说明文档（assets/USAGE.md）。经 import.meta.url 定位，
 * 随 dist/mega 分发，因此「使用说明」页开箱即用、无需额外配置。
 */
function packagedUsagePath(): string | undefined {
  try {
    return fileURLToPath(new URL('../assets/USAGE.md', import.meta.url))
  } catch {
    return undefined
  }
}

/** usage remote: return the usage markdown document. */
export class UsageRemote extends TypertRemoteService {
  private readonly usagePath: string | undefined

  constructor(ctx: Context, usagePath: string | undefined) {
    super(ctx, 'usage', { namespace: 'usage' })
    this.usagePath = usagePath
  }

  @Remote('get')
  async get(): Promise<{ markdown: string; source: 'file' | 'placeholder' }> {
    // 显式配置的 usagePath 优先；否则用包内自带的 assets/USAGE.md。
    const candidates = [this.usagePath, packagedUsagePath()].filter((path): path is string => path !== undefined)
    for (const candidate of candidates) {
      try {
        const text = readFileSync(candidate, 'utf8')
        return { markdown: text, source: 'file' }
      } catch {
        // Try the next candidate.
      }
    }
    return { markdown: USAGE_PLACEHOLDER, source: 'placeholder' }
  }
}

export function apply(ctx: Context, config: Config = {}): void {
  const resolved: Config = {
    profileName: config.profileName,
    patchPath: config.patchPath,
    dbRowId: config.dbRowId,
    usagePath: config.usagePath,
  }
  new PgConfigRemote(ctx, resolved)
  new UsageRemote(ctx, resolved.usagePath)
}
