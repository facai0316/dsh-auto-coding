/**
 * Decorator-free helpers for the ui-requirements host half: reading and
 * validating the db-pgmas row config inside a user-layer `cordis.patch.yml`.
 * Kept out of `index.ts` (which uses TC39 decorators via Typert) so vitest /
 * esbuild can exercise them directly.
 */
export interface Config {
    /** dsh profile whose `cordis.patch.yml` holds the db-pgmas row. */
    profileName?: string;
    /** Absolute patch file to write; overrides profile resolution. */
    patchPath?: string;
    /** Row id of the pg plugin inside that patch file. */
    dbRowId?: string;
    /** Optional absolute path to a markdown usage document. */
    usagePath?: string;
}
/** Defaults mirroring `@auto-coding/db-pgmas` Config (keep in sync). */
export declare const PG_DEFAULTS: {
    readonly host: "127.0.0.1";
    readonly port: 25678;
    readonly user: "mas";
    readonly password: "";
    readonly database: "mas";
    readonly databases: readonly ["mas", "cm", "facai"];
    readonly readOnly: true;
    readonly maxRows: 50;
    readonly statementTimeoutMs: 15000;
    readonly connectTimeoutMs: 5000;
    readonly poolMax: 4;
};
export declare function dshHome(): string;
export declare function resolvePatchPath(config: Config): string;
/** Find the db-pgmas row's own `config` inside one patch list (user layer). */
export declare function findRowConfig(patches: unknown[], rowId: string): Record<string, unknown> | undefined;
export declare function parsePatchFile(file: string): unknown[];
export declare function serializePatch(items: unknown[]): string;
export declare function isRecord(value: unknown): value is Record<string, unknown>;
export declare function validatePgConfig(value: unknown): string | undefined;
export declare function mergedConfig(raw: Record<string, unknown> | undefined): Record<string, unknown>;
