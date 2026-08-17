import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Remote, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import { homedir } from "node:os";
import { join } from "node:path";
import { isMap, isPair, isScalar, isSeq, parseDocument } from "yaml";
//#region build/patch-utils.js
/**
* Decorator-free helpers for the ui-requirements host half: reading and
* validating the db-pgmas row config inside a user-layer `cordis.patch.yml`.
* Kept out of `index.ts` (which uses TC39 decorators via Typert) so vitest /
* esbuild can exercise them directly.
*/
/** Defaults mirroring `@auto-coding/db-pgmas` Config (keep in sync). */
const PG_DEFAULTS = {
	host: "127.0.0.1",
	port: 25678,
	user: "mas",
	password: "",
	database: "mas",
	databases: [
		"mas",
		"cm",
		"facai"
	],
	readOnly: true,
	maxRows: 50,
	statementTimeoutMs: 15e3,
	connectTimeoutMs: 5e3,
	poolMax: 4
};
function dshHome() {
	const value = process.env.DSH_HOME?.trim();
	return value !== void 0 && value !== "" ? value : join(homedir(), ".dsh");
}
function resolvePatchPath(config) {
	if (config.patchPath) return config.patchPath;
	return join(dshHome(), "profiles", config.profileName ?? "web", "cordis.patch.yml");
}
/** Find the db-pgmas row's own `config` inside one patch list (user layer). */
function findRowConfig(patches, rowId) {
	let insertConfig;
	for (const entry of patches) {
		if (entry === null || typeof entry !== "object") continue;
		const obj = entry;
		if (Array.isArray(obj.insert)) for (const item of obj.insert) {
			if (item === null || typeof item !== "object") continue;
			const row = item;
			if (row.id === rowId && row.config !== null && typeof row.config === "object") insertConfig = row.config;
		}
		else if (obj.id === rowId && obj.config !== null && typeof obj.config === "object") return obj.config;
	}
	return insertConfig;
}
function parsePatchFile(file) {
	if (!existsSync(file)) return [];
	const text = readFileSync(file, "utf8");
	const doc = parseDocument(text);
	if (doc.errors.length > 0) throw new Error(`patch parse error: ${doc.errors[0].message}`);
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
function upsertRowConfigInText(text, rowId, config) {
	const doc = parseDocument(text.length > 0 ? text : "[]");
	if (doc.errors.length > 0) throw new Error(`patch parse error: ${doc.errors[0].message}`);
	if (doc.contents === null) doc.contents = doc.createNode([]);
	if (!isSeq(doc.contents)) throw new Error("patch root must be a YAML list");
	const items = doc.contents.items;
	const keyIs = (pair, key) => isPair(pair) && isScalar(pair.key) && pair.key.value === key;
	for (let index = 0; index < items.length; index++) {
		const item = items[index];
		if (!isMap(item) || item.items.some((pair) => keyIs(pair, "insert"))) continue;
		const idPair = item.items.find((pair) => keyIs(pair, "id"));
		if (!idPair || !isScalar(idPair.value) || idPair.value.value !== rowId) continue;
		doc.setIn([index, "config"], config);
		return doc.toString();
	}
	doc.addIn([], {
		id: rowId,
		config
	});
	return doc.toString();
}
function isRecord(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
function validatePgConfig(value) {
	if (!isRecord(value)) return "配置必须是对象";
	const { host, port, user, password, database, databases, readOnly, maxRows } = value;
	if (typeof host !== "string" || host.trim() === "") return "host 必须是字符串";
	if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) return "port 必须是 1–65535 的整数";
	if (typeof user !== "string") return "user 必须是字符串";
	if (password !== void 0 && typeof password !== "string") return "password 必须是字符串";
	if (typeof database !== "string" || database.trim() === "") return "database 必须是字符串";
	if (databases !== void 0 && (!Array.isArray(databases) || databases.some((d) => typeof d !== "string"))) return "databases 必须是字符串数组";
	if (readOnly !== void 0 && typeof readOnly !== "boolean") return "readOnly 必须是布尔值";
	if (maxRows !== void 0 && (typeof maxRows !== "number" || !Number.isInteger(maxRows) || maxRows < 1 || maxRows > 1e3)) return "maxRows 必须是 1–1000 的整数";
}
function mergedConfig(raw) {
	return {
		...PG_DEFAULTS,
		...raw ?? {}
	};
}
//#endregion
//#region build/index.js
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
var __runInitializers = function(thisArg, initializers, value) {
	var useValue = arguments.length > 2;
	for (var i = 0; i < initializers.length; i++) value = useValue ? initializers[i].call(thisArg, value) : initializers[i].call(thisArg);
	return useValue ? value : void 0;
};
var __esDecorate = function(ctor, descriptorIn, decorators, contextIn, initializers, extraInitializers) {
	function accept(f) {
		if (f !== void 0 && typeof f !== "function") throw new TypeError("Function expected");
		return f;
	}
	var kind = contextIn.kind, key = kind === "getter" ? "get" : kind === "setter" ? "set" : "value";
	var target = !descriptorIn && ctor ? contextIn["static"] ? ctor : ctor.prototype : null;
	var descriptor = descriptorIn || (target ? Object.getOwnPropertyDescriptor(target, contextIn.name) : {});
	var _, done = false;
	for (var i = decorators.length - 1; i >= 0; i--) {
		var context = {};
		for (var p in contextIn) context[p] = p === "access" ? {} : contextIn[p];
		for (var p in contextIn.access) context.access[p] = contextIn.access[p];
		context.addInitializer = function(f) {
			if (done) throw new TypeError("Cannot add initializers after decoration has completed");
			extraInitializers.push(accept(f || null));
		};
		var result = (0, decorators[i])(kind === "accessor" ? {
			get: descriptor.get,
			set: descriptor.set
		} : descriptor[key], context);
		if (kind === "accessor") {
			if (result === void 0) continue;
			if (result === null || typeof result !== "object") throw new TypeError("Object expected");
			if (_ = accept(result.get)) descriptor.get = _;
			if (_ = accept(result.set)) descriptor.set = _;
			if (_ = accept(result.init)) initializers.unshift(_);
		} else if (_ = accept(result)) {
			if (kind === "field") initializers.unshift(_);
			else descriptor[key] = _;
		}
	}
	if (target) Object.defineProperty(target, contextIn.name, descriptor);
	done = true;
};
const name = "ui-requirements";
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
			_get_decorators = [Remote("get")];
			_save_decorators = [Remote("save")];
			_test_decorators = [Remote("test")];
			__esDecorate(this, null, _get_decorators, {
				kind: "method",
				name: "get",
				static: false,
				private: false,
				access: {
					has: (obj) => "get" in obj,
					get: (obj) => obj.get
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _save_decorators, {
				kind: "method",
				name: "save",
				static: false,
				private: false,
				access: {
					has: (obj) => "save" in obj,
					get: (obj) => obj.save
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _test_decorators, {
				kind: "method",
				name: "test",
				static: false,
				private: false,
				access: {
					has: (obj) => "test" in obj,
					get: (obj) => obj.test
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			if (_metadata) Object.defineProperty(this, Symbol.metadata, {
				enumerable: true,
				configurable: true,
				writable: true,
				value: _metadata
			});
		}
		config = __runInitializers(this, _instanceExtraInitializers);
		constructor(ctx, config) {
			super(ctx, "pgConfig", { namespace: "pgconfig" });
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
				raw = findRowConfig(parsePatchFile(file), this.config.dbRowId ?? "db-pgmas");
			} catch {}
			return {
				patchPath: file,
				present: raw !== void 0,
				config: mergedConfig(raw),
				defaults: { ...PG_DEFAULTS }
			};
		}
		/** Validate and write a user-layer config override for the db-pgmas row. */
		async save(value) {
			const error = validatePgConfig(value);
			if (error !== void 0) return {
				ok: false,
				error,
				patchPath: this.patchPath()
			};
			const config = value;
			const file = this.patchPath();
			try {
				let text = "";
				try {
					text = readFileSync(file, "utf8");
				} catch {}
				const next = upsertRowConfigInText(text, this.config.dbRowId ?? "db-pgmas", config);
				writeFileSync(file, next, "utf8");
			} catch (cause) {
				return {
					ok: false,
					error: `写入 ${file} 失败: ${cause instanceof Error ? cause.message : String(cause)}`,
					patchPath: file
				};
			}
			return {
				ok: true,
				config: mergedConfig(config),
				patchPath: file
			};
		}
		/** Open a throwaway connection with the proposed values (no pool created). */
		async test(value) {
			const error = validatePgConfig(value);
			if (error !== void 0) return {
				ok: false,
				message: error
			};
			const cfg = value;
			const client = new (await (import("pg"))).Client({
				host: cfg.host,
				port: cfg.port,
				user: cfg.user,
				password: cfg.password ?? "",
				database: cfg.database,
				connectionTimeoutMillis: 5e3,
				statement_timeout: 1e4
			});
			try {
				const startedAt = Date.now();
				await client.connect();
				const result = await client.query("select version()");
				const version = String(result.rows[0]?.version ?? "");
				const match = /PostgreSQL (\d+)/.exec(version);
				return {
					ok: true,
					message: `连接成功: ${cfg.host}:${cfg.port}/${cfg.database} (PostgreSQL ${match?.[1] ?? "?"}, ${Date.now() - startedAt}ms)`,
					config: mergedConfig(cfg)
				};
			} catch (cause) {
				return {
					ok: false,
					message: `连接失败: ${cause instanceof Error ? cause.message : String(cause)}`
				};
			} finally {
				await client.end().catch(() => {});
			}
		}
	};
})();
const USAGE_PLACEHOLDER = `# 使用说明

> 文档占位:使用说明内容待补充（包内 assets/USAGE.md 缺失）。
`;
/**
* 包内自带的使用说明文档（assets/USAGE.md）。经 import.meta.url 定位，
* 随 dist/mega 分发，因此「使用说明」页开箱即用、无需额外配置。
*/
function packagedUsagePath() {
	try {
		return fileURLToPath(new URL("../assets/USAGE.md", import.meta.url));
	} catch {
		return;
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
			_get_decorators = [Remote("get")];
			__esDecorate(this, null, _get_decorators, {
				kind: "method",
				name: "get",
				static: false,
				private: false,
				access: {
					has: (obj) => "get" in obj,
					get: (obj) => obj.get
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			if (_metadata) Object.defineProperty(this, Symbol.metadata, {
				enumerable: true,
				configurable: true,
				writable: true,
				value: _metadata
			});
		}
		usagePath = __runInitializers(this, _instanceExtraInitializers);
		constructor(ctx, usagePath) {
			super(ctx, "usage", { namespace: "usage" });
			this.usagePath = usagePath;
		}
		async get() {
			const candidates = [this.usagePath, packagedUsagePath()].filter((path) => path !== void 0);
			for (const candidate of candidates) try {
				return {
					markdown: readFileSync(candidate, "utf8"),
					source: "file"
				};
			} catch {}
			return {
				markdown: USAGE_PLACEHOLDER,
				source: "placeholder"
			};
		}
	};
})();
function apply(ctx, config = {}) {
	const resolved = {
		profileName: config.profileName,
		patchPath: config.patchPath,
		dbRowId: config.dbRowId,
		usagePath: config.usagePath
	};
	new PgConfigRemote(ctx, resolved);
	new UsageRemote(ctx, resolved.usagePath);
}
//#endregion
export { PG_DEFAULTS, PgConfigRemote, UsageRemote, apply, findRowConfig, name, upsertRowConfigInText, validatePgConfig };
