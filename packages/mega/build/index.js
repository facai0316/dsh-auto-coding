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
var __runInitializers = (this && this.__runInitializers) || function (thisArg, initializers, value) {
    var useValue = arguments.length > 2;
    for (var i = 0; i < initializers.length; i++) {
        value = useValue ? initializers[i].call(thisArg, value) : initializers[i].call(thisArg);
    }
    return useValue ? value : void 0;
};
var __esDecorate = (this && this.__esDecorate) || function (ctor, descriptorIn, decorators, contextIn, initializers, extraInitializers) {
    function accept(f) { if (f !== void 0 && typeof f !== "function") throw new TypeError("Function expected"); return f; }
    var kind = contextIn.kind, key = kind === "getter" ? "get" : kind === "setter" ? "set" : "value";
    var target = !descriptorIn && ctor ? contextIn["static"] ? ctor : ctor.prototype : null;
    var descriptor = descriptorIn || (target ? Object.getOwnPropertyDescriptor(target, contextIn.name) : {});
    var _, done = false;
    for (var i = decorators.length - 1; i >= 0; i--) {
        var context = {};
        for (var p in contextIn) context[p] = p === "access" ? {} : contextIn[p];
        for (var p in contextIn.access) context.access[p] = contextIn.access[p];
        context.addInitializer = function (f) { if (done) throw new TypeError("Cannot add initializers after decoration has completed"); extraInitializers.push(accept(f || null)); };
        var result = (0, decorators[i])(kind === "accessor" ? { get: descriptor.get, set: descriptor.set } : descriptor[key], context);
        if (kind === "accessor") {
            if (result === void 0) continue;
            if (result === null || typeof result !== "object") throw new TypeError("Object expected");
            if (_ = accept(result.get)) descriptor.get = _;
            if (_ = accept(result.set)) descriptor.set = _;
            if (_ = accept(result.init)) initializers.unshift(_);
        }
        else if (_ = accept(result)) {
            if (kind === "field") initializers.unshift(_);
            else descriptor[key] = _;
        }
    }
    if (target) Object.defineProperty(target, contextIn.name, descriptor);
    done = true;
};
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import { PG_DEFAULTS, findRowConfig, mergedConfig, parsePatchFile, resolvePatchPath, upsertRowConfigInText, validatePgConfig, } from "./patch-utils.js";
export { findRowConfig, upsertRowConfigInText, validatePgConfig, PG_DEFAULTS } from "./patch-utils.js";
export const name = 'ui-requirements';
/** pgconfig remote: read / save / test the db-pgmas row config. */
let PgConfigRemote = (() => {
    let _classSuper = TypertRemoteService;
    let _instanceExtraInitializers = [];
    let _get_decorators;
    let _save_decorators;
    let _test_decorators;
    return class PgConfigRemote extends _classSuper {
        static {
            const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(_classSuper[Symbol.metadata] ?? null) : void 0;
            _get_decorators = [Remote('get')];
            _save_decorators = [Remote('save')];
            _test_decorators = [Remote('test')];
            __esDecorate(this, null, _get_decorators, { kind: "method", name: "get", static: false, private: false, access: { has: obj => "get" in obj, get: obj => obj.get }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _save_decorators, { kind: "method", name: "save", static: false, private: false, access: { has: obj => "save" in obj, get: obj => obj.save }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _test_decorators, { kind: "method", name: "test", static: false, private: false, access: { has: obj => "test" in obj, get: obj => obj.test }, metadata: _metadata }, null, _instanceExtraInitializers);
            if (_metadata) Object.defineProperty(this, Symbol.metadata, { enumerable: true, configurable: true, writable: true, value: _metadata });
        }
        config = __runInitializers(this, _instanceExtraInitializers);
        constructor(ctx, config) {
            super(ctx, 'pgConfig', { namespace: 'pgconfig' });
            this.config = config;
        }
        patchPath() {
            return resolvePatchPath(this.config);
        }
        /** Current effective config: row override merged over defaults. */
        async get() {
            const file = this.patchPath();
            let raw;
            try {
                raw = findRowConfig(parsePatchFile(file), this.config.dbRowId ?? 'db-pgmas');
            }
            catch {
                // Unreadable patch: report absence; the page surfaces the path.
            }
            return {
                patchPath: file,
                present: raw !== undefined,
                config: mergedConfig(raw),
                defaults: { ...PG_DEFAULTS },
            };
        }
        /** Validate and write a user-layer config override for the db-pgmas row. */
        async save(value) {
            const error = validatePgConfig(value);
            if (error !== undefined)
                return { ok: false, error, patchPath: this.patchPath() };
            const config = value;
            const file = this.patchPath();
            try {
                let text = '';
                try {
                    text = readFileSync(file, 'utf8');
                }
                catch {
                    // Missing patch file: start from an empty list (upsert appends the row).
                }
                // Surgical AST edit, never a parse→JS→stringify round-trip: the latter
                // silently strips `!!js` from every other row in the file (e.g. the
                // webserver port line), breaking the next restart. An unparseable file is
                // reported instead of being clobbered.
                const next = upsertRowConfigInText(text, this.config.dbRowId ?? 'db-pgmas', config);
                writeFileSync(file, next, 'utf8');
            }
            catch (cause) {
                const message = cause instanceof Error ? cause.message : String(cause);
                return { ok: false, error: `写入 ${file} 失败: ${message}`, patchPath: file };
            }
            return { ok: true, config: mergedConfig(config), patchPath: file };
        }
        /** Open a throwaway connection with the proposed values (no pool created). */
        async test(value) {
            const error = validatePgConfig(value);
            if (error !== undefined)
                return { ok: false, message: error };
            const cfg = value;
            // Lazy import keeps `pg` out of the plugin graph until a test runs.
            const pg = await import('pg');
            const client = new pg.Client({
                host: cfg.host,
                port: cfg.port,
                user: cfg.user,
                password: cfg.password ?? '',
                database: cfg.database,
                connectionTimeoutMillis: 5_000,
                statement_timeout: 10_000,
            });
            try {
                const startedAt = Date.now();
                await client.connect();
                const result = await client.query('select version()');
                const version = String(result.rows[0]?.version ?? '');
                const match = /PostgreSQL (\d+)/.exec(version);
                return {
                    ok: true,
                    message: `连接成功: ${cfg.host}:${cfg.port}/${cfg.database} (PostgreSQL ${match?.[1] ?? '?'}, ${Date.now() - startedAt}ms)`,
                    config: mergedConfig(cfg),
                };
            }
            catch (cause) {
                const message = cause instanceof Error ? cause.message : String(cause);
                return { ok: false, message: `连接失败: ${message}` };
            }
            finally {
                await client.end().catch(() => { });
            }
        }
    };
})();
export { PgConfigRemote };
const USAGE_PLACEHOLDER = `# 使用说明

> 文档占位:使用说明内容待补充（包内 assets/USAGE.md 缺失）。
`;
/**
 * 包内自带的使用说明文档（assets/USAGE.md）。经 import.meta.url 定位，
 * 随 dist/mega 分发，因此「使用说明」页开箱即用、无需额外配置。
 */
function packagedUsagePath() {
    try {
        return fileURLToPath(new URL('../assets/USAGE.md', import.meta.url));
    }
    catch {
        return undefined;
    }
}
/** usage remote: return the usage markdown document. */
let UsageRemote = (() => {
    let _classSuper = TypertRemoteService;
    let _instanceExtraInitializers = [];
    let _get_decorators;
    return class UsageRemote extends _classSuper {
        static {
            const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(_classSuper[Symbol.metadata] ?? null) : void 0;
            _get_decorators = [Remote('get')];
            __esDecorate(this, null, _get_decorators, { kind: "method", name: "get", static: false, private: false, access: { has: obj => "get" in obj, get: obj => obj.get }, metadata: _metadata }, null, _instanceExtraInitializers);
            if (_metadata) Object.defineProperty(this, Symbol.metadata, { enumerable: true, configurable: true, writable: true, value: _metadata });
        }
        usagePath = __runInitializers(this, _instanceExtraInitializers);
        constructor(ctx, usagePath) {
            super(ctx, 'usage', { namespace: 'usage' });
            this.usagePath = usagePath;
        }
        async get() {
            // 显式配置的 usagePath 优先；否则用包内自带的 assets/USAGE.md。
            const candidates = [this.usagePath, packagedUsagePath()].filter((path) => path !== undefined);
            for (const candidate of candidates) {
                try {
                    const text = readFileSync(candidate, 'utf8');
                    return { markdown: text, source: 'file' };
                }
                catch {
                    // Try the next candidate.
                }
            }
            return { markdown: USAGE_PLACEHOLDER, source: 'placeholder' };
        }
    };
})();
export { UsageRemote };
export function apply(ctx, config = {}) {
    const resolved = {
        profileName: config.profileName,
        patchPath: config.patchPath,
        dbRowId: config.dbRowId,
        usagePath: config.usagePath,
    };
    new PgConfigRemote(ctx, resolved);
    new UsageRemote(ctx, resolved.usagePath);
}
