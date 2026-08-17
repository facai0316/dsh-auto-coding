/**
 * Decorator-free helpers for the ui-requirements host half: reading and
 * validating the db-pgmas row config inside a user-layer `cordis.patch.yml`.
 * Kept out of `index.ts` (which uses TC39 decorators via Typert) so vitest /
 * esbuild can exercise them directly.
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isMap, isPair, isScalar, isSeq, parseDocument } from 'yaml';
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
};
export function dshHome() {
    // DSH_HOME 未设置时 process.env.DSH_HOME 是 undefined：?.trim() 得
    // undefined，而 `undefined !== ''` 为 true——旧写法会在未设置时错误地走
    // 「已设置」分支，undefined.trim() 直接炸掉 pgconfig/get（目标机器
    // dsh web 不给插件进程设 DSH_HOME，必现「配置卡片一直转圈」）。
    const value = process.env.DSH_HOME?.trim();
    return value !== undefined && value !== '' ? value : join(homedir(), '.dsh');
}
export function resolvePatchPath(config) {
    if (config.patchPath)
        return config.patchPath;
    return join(dshHome(), 'profiles', config.profileName ?? 'web', 'cordis.patch.yml');
}
/** Find the db-pgmas row's own `config` inside one patch list (user layer). */
export function findRowConfig(patches, rowId) {
    let insertConfig;
    for (const entry of patches) {
        if (entry === null || typeof entry !== 'object')
            continue;
        const obj = entry;
        if (Array.isArray(obj.insert)) {
            for (const item of obj.insert) {
                if (item === null || typeof item !== 'object')
                    continue;
                const row = item;
                if (row.id === rowId && row.config !== null && typeof row.config === 'object') {
                    insertConfig = row.config;
                }
            }
        }
        else if (obj.id === rowId && obj.config !== null && typeof obj.config === 'object') {
            // Top-level override wins over insert config (last write wins per row).
            return obj.config;
        }
    }
    return insertConfig;
}
export function parsePatchFile(file) {
    if (!existsSync(file))
        return [];
    const text = readFileSync(file, 'utf8');
    const doc = parseDocument(text);
    if (doc.errors.length > 0)
        throw new Error(`patch parse error: ${doc.errors[0].message}`);
    const items = doc.toJS();
    return Array.isArray(items) ? items : [];
}
/**
 * Surgically rewrite a user-layer patch file's text so the row `rowId` carries
 * `config`, preserving every OTHER node verbatim — `!!js` tagged expressions,
 * comments, and key order. Editing the parsed Document AST instead of
 * round-tripping through plain JS objects is what keeps `!!js` alive: yaml's
 * `toJS()` resolves a tagged scalar to its plain string, so a parse→JS→stringify
 * cycle would silently strip the tag and turn
 * `port: !!js ctx.webStartup.port ?? 3080` into a literal string the Loader can
 * no longer evaluate (the webserver then fails to bind → boot failure).
 *
 * Mirrors the previous `{ id, config }` replace-or-append semantics: a top-level
 * row (a map whose `id` matches, excluding `insert` rows) gets its `config`
 * value replaced or added; otherwise a new `{ id, config }` row is appended.
 *
 * @throws if the text is not parseable as a YAML sequence.
 */
export function upsertRowConfigInText(text, rowId, config) {
    const doc = parseDocument(text.length > 0 ? text : '[]');
    if (doc.errors.length > 0)
        throw new Error(`patch parse error: ${doc.errors[0].message}`);
    if (doc.contents === null) {
        // Empty/comments-only file: plant an empty root sequence. `createNode`
        // returns an unparsed node while a parsed document types contents as
        // ParsedNode, so widen the assignment explicitly (runtime accepts any node).
        doc.contents = doc.createNode([]);
    }
    if (!isSeq(doc.contents))
        throw new Error('patch root must be a YAML list');
    const items = doc.contents.items;
    const keyIs = (pair, key) => isPair(pair) && isScalar(pair.key) && pair.key.value === key;
    for (let index = 0; index < items.length; index++) {
        const item = items[index];
        if (!isMap(item) || item.items.some(pair => keyIs(pair, 'insert')))
            continue;
        const idPair = item.items.find(pair => keyIs(pair, 'id'));
        if (!idPair || !isScalar(idPair.value) || idPair.value.value !== rowId)
            continue;
        doc.setIn([index, 'config'], config);
        return doc.toString();
    }
    doc.addIn([], { id: rowId, config });
    return doc.toString();
}
export function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
export function validatePgConfig(value) {
    if (!isRecord(value))
        return '配置必须是对象';
    const { host, port, user, password, database, databases, readOnly, maxRows } = value;
    if (typeof host !== 'string' || host.trim() === '')
        return 'host 必须是字符串';
    if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535)
        return 'port 必须是 1–65535 的整数';
    if (typeof user !== 'string')
        return 'user 必须是字符串';
    if (password !== undefined && typeof password !== 'string')
        return 'password 必须是字符串';
    if (typeof database !== 'string' || database.trim() === '')
        return 'database 必须是字符串';
    if (databases !== undefined && (!Array.isArray(databases) || databases.some(d => typeof d !== 'string'))) {
        return 'databases 必须是字符串数组';
    }
    if (readOnly !== undefined && typeof readOnly !== 'boolean')
        return 'readOnly 必须是布尔值';
    if (maxRows !== undefined && (typeof maxRows !== 'number' || !Number.isInteger(maxRows) || maxRows < 1 || maxRows > 1000)) {
        return 'maxRows 必须是 1–1000 的整数';
    }
    return undefined;
}
export function mergedConfig(raw) {
    return { ...PG_DEFAULTS, ...(raw ?? {}) };
}
