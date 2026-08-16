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
import type { Context } from '@deepseek-ai/cordis';
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import { type Config } from './patch-utils.ts';
export type { Config } from './patch-utils.ts';
export { findRowConfig, validatePgConfig, PG_DEFAULTS } from './patch-utils.ts';
export declare const name = "ui-requirements";
/** pgconfig remote: read / save / test the db-pgmas row config. */
export declare class PgConfigRemote extends TypertRemoteService {
    private readonly config;
    constructor(ctx: Context, config: Config);
    private patchPath;
    /** Current effective config: row override merged over defaults. */
    get(): Promise<{
        patchPath: string;
        present: boolean;
        config: Record<string, unknown>;
        defaults: Record<string, unknown>;
    }>;
    /** Validate and write a user-layer config override for the db-pgmas row. */
    save(value: unknown): Promise<{
        ok: boolean;
        error?: string;
        config?: Record<string, unknown>;
        patchPath: string;
    }>;
    /** Open a throwaway connection with the proposed values (no pool created). */
    test(value: unknown): Promise<{
        ok: boolean;
        message: string;
        config?: Record<string, unknown>;
    }>;
}
/** usage remote: return the usage markdown document. */
export declare class UsageRemote extends TypertRemoteService {
    private readonly usagePath;
    constructor(ctx: Context, usagePath: string | undefined);
    get(): Promise<{
        markdown: string;
        source: 'file' | 'placeholder';
    }>;
}
export declare function apply(ctx: Context, config?: Config): void;
