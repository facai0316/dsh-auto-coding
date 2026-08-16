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
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import pg from 'pg';
export declare const name = "db-pgmas";
export declare const inject: string[];
/** Row configuration; defaults describe the discovered pg-mas instance. */
export interface Config {
    /** PostgreSQL host (the docker-published host port). */
    host: string;
    /** PostgreSQL port on the host. */
    port: number;
    /** Login user. */
    user: string;
    /** Login password. */
    password: string;
    /** Default database (POSTGRES_DB of the container). */
    database: string;
    /**
     * Databases the tools may address (the `database:` argument allowlist).
     * `['*']` allows any database the login can reach.
     */
    databases: string[];
    /** Reject mutating SQL in `pg_query` (default true). */
    readOnly: boolean;
    /** Default row cap for `pg_query` results. */
    maxRows: number;
    /** Per-statement server-side timeout (statement_timeout). */
    statementTimeoutMs: number;
    /** Pool connect timeout. */
    connectTimeoutMs: number;
    /** Pool size per database. */
    poolMax: number;
}
export declare const Config: z<Config>;
/** Canonical result of one `query` call; `rows` carries the LAST statement. */
export interface PgMasQueryResult {
    database: string;
    /** Command tag of the last statement, e.g. `SELECT` or `UPDATE`. */
    command: string;
    /** Per-statement command tags, one entry per statement in the batch. */
    statements: {
        command: string;
        rowCount: number;
    }[];
    /** Row count of the last statement; affected rows for DML, `-1` when null. */
    rowCount: number;
    /** Rows of the last statement, as returned by the driver. */
    rows: Record<string, unknown>[];
    durationMs: number;
}
/** One database row of `listDatabases`. */
export interface PgMasDatabaseSummary {
    name: string;
    size: string;
    activeConnections: number;
    default: boolean;
}
/** One table/view row of `listTables`. */
export interface PgMasTableSummary {
    schema: string;
    name: string;
    kind: string;
    rowEstimate: number;
    totalSize: string;
    comment?: string;
}
/** Full column/index detail of one table. */
export interface PgMasTableDetail {
    schema: string;
    name: string;
    kind: string;
    rowEstimate: number;
    columns: {
        name: string;
        type: string;
        nullable: boolean;
        default?: string;
        comment?: string;
    }[];
    indexes: {
        name: string;
        definition: string;
    }[];
    foreignKeys: {
        name: string;
        definition: string;
    }[];
}
/** Service seam other host plugins may consume. */
export interface PgMasService {
    readonly defaults: Readonly<{
        host: string;
        port: number;
        user: string;
        database: string;
        databases: readonly string[];
        readOnly: boolean;
    }>;
    query(sql: string, options?: {
        params?: unknown[];
        database?: string;
        signal?: AbortSignal;
    }): Promise<PgMasQueryResult>;
    listDatabases(signal?: AbortSignal): Promise<PgMasDatabaseSummary[]>;
    listTables(database?: string, signal?: AbortSignal): Promise<PgMasTableSummary[]>;
    describeTable(table: string, database?: string): Promise<PgMasTableDetail>;
    testConnection(database?: string): Promise<{
        database: string;
        serverVersion: number;
        latencyMs: number;
    }>;
    /**
     * Service-level write seam: run `fn` against one pooled client of `database`
     * and always release it. Unlike `query()`, this path does NOT apply the
     * read-only guard — that guard belongs to the `pg_query` model tool, not to
     * consuming services. `database` still resolves through the row `databases`
     * allowlist. Use it for transactions (`BEGIN`/`COMMIT`/`ROLLBACK`) and
     * multi-statement writes; release-cleanup is owned here.
     */
    withClient<T>(database: string, fn: (client: pg.PoolClient) => Promise<T>, signal?: AbortSignal): Promise<T>;
}
declare module '@deepseek-ai/cordis' {
    interface Context {
        pgmas: PgMasService;
    }
}
/**
 * Best-effort read-only check. Returns the offending keyword, or '' when the
 * SQL looks read-only. Fails closed: a remaining write keyword anywhere is
 * rejected, so anything the scanner cannot understand errs on rejection.
 */
export declare function writeKeyword(sql: string): string;
export declare function apply(ctx: Context, config: Config): void;
