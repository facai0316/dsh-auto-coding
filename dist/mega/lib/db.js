import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
import pg from "pg";
//#region build/db.js
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
const name = "db-pgmas";
const inject = ["tools", "systemPrompt"];
const Config = z.object({
	host: z.string().default("127.0.0.1"),
	port: z.number().min(1).max(65535).default(25678),
	user: z.string().default("mas"),
	password: z.string().default("Fa^Cai!0316#Mas."),
	database: z.string().default("mas"),
	databases: z.array(z.string()).default([
		"mas",
		"cm",
		"facai"
	]),
	readOnly: z.boolean().default(true),
	maxRows: z.number().min(1).max(1e3).default(50),
	statementTimeoutMs: z.number().min(100).max(6e5).default(15e3),
	connectTimeoutMs: z.number().min(100).max(12e4).default(5e3),
	poolMax: z.number().min(1).max(32).default(4)
});
const MAX_BINARY_HEX_BYTES = 256;
/** Lossless-JSON projection of one driver value (Date → ISO, bytea → hex…). */
function toJsonSafe(value, depth = 0) {
	if (value === null || value === void 0) return null;
	const type = typeof value;
	if (type === "string" || type === "number" || type === "boolean") return value;
	if (type === "bigint") return value.toString();
	if (value instanceof Date) return value.toISOString();
	if (value instanceof Uint8Array) {
		const bytes = value.subarray(0, MAX_BINARY_HEX_BYTES);
		const suffix = value.length > MAX_BINARY_HEX_BYTES ? `… (${value.length} bytes)` : "";
		return `0x${Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length).toString("hex")}${suffix}`;
	}
	if (Array.isArray(value)) return depth > 16 ? null : value.map((entry) => toJsonSafe(entry, depth + 1));
	if (type === "object") {
		if (depth > 16) return null;
		const out = {};
		for (const [key, entry] of Object.entries(value)) out[key] = toJsonSafe(entry, depth + 1);
		return out;
	}
	return String(value);
}
function safeRow(row) {
	const out = {};
	for (const [key, value] of Object.entries(row)) out[key] = toJsonSafe(value);
	return out;
}
/**
* Reserved write verbs: scanned anywhere (as standalone words) after comments
* and string literals are stripped. All of these are reserved keywords in
* PostgreSQL, so they cannot appear as unquoted identifiers.
*/
const STRICT_WRITE_VERBS = [
	"insert",
	"update",
	"delete",
	"truncate",
	"create",
	"alter",
	"drop",
	"grant",
	"revoke",
	"copy",
	"merge",
	"call",
	"do",
	"reindex",
	"cluster",
	"vacuum",
	"checkpoint",
	"set",
	"reset",
	"begin",
	"commit",
	"rollback"
];
/**
* Non-reserved write verbs: only rejected as the FIRST word of a top-level
* statement (they double as plausible column names mid-statement).
*/
const HEAD_WRITE_VERBS = /* @__PURE__ */ new Set([
	"comment",
	"lock",
	"listen",
	"notify",
	"prepare",
	"execute",
	"deallocate",
	"analyze",
	"analyse",
	"refresh",
	"import",
	"discard",
	"savepoint"
]);
const STRICT_WRITE_PATTERNS = STRICT_WRITE_VERBS.map((verb) => [verb, new RegExp(`(^|[^A-Za-z0-9_$])${verb}([^A-Za-z0-9_$]|$)`, "i")]);
/** Replace comments and string/ dollar-quoted literals with spaces. */
function stripLiteralsAndComments(sql) {
	let out = "";
	let index = 0;
	const length = sql.length;
	while (index < length) {
		const char = sql[index];
		const next = index + 1 < length ? sql[index + 1] : "";
		if (char === "-" && next === "-") {
			while (index < length && sql[index] !== "\n") index += 1;
			out += " ";
			continue;
		}
		if (char === "/" && next === "*") {
			index += 2;
			while (index < length && !(sql[index] === "*" && sql[index + 1] === "/")) index += 1;
			index = Math.min(index + 2, length);
			out += " ";
			continue;
		}
		if (char === "$") {
			const match = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(index));
			if (match !== null) {
				const tag = match[0];
				const end = sql.indexOf(tag, index + tag.length);
				index = end === -1 ? length : end + tag.length;
				out += " ";
				continue;
			}
		}
		if (char === "'") {
			index += 1;
			while (index < length) {
				if (sql[index] === "'") {
					if (sql[index + 1] === "'") {
						index += 2;
						continue;
					}
					index += 1;
					break;
				}
				index += 1;
			}
			out += " ";
			continue;
		}
		if (char === "\"") {
			index += 1;
			while (index < length) {
				if (sql[index] === "\"") {
					if (sql[index + 1] === "\"") {
						index += 2;
						continue;
					}
					index += 1;
					break;
				}
				index += 1;
			}
			out += " ";
			continue;
		}
		out += char;
		index += 1;
	}
	return out;
}
/** Split into top-level statements on `;` (literals already stripped). */
function splitStatements(stripped) {
	return stripped.split(";").map((part) => part.trim()).filter((part) => part.length > 0);
}
/** First keyword of one statement, lowercased; '' for empty. */
function headVerb(statement) {
	const match = /^[a-zA-Z]+/.exec(statement);
	return match === null ? "" : match[0].toLowerCase();
}
/**
* Best-effort read-only check. Returns the offending keyword, or '' when the
* SQL looks read-only. Fails closed: a remaining write keyword anywhere is
* rejected, so anything the scanner cannot understand errs on rejection.
*/
function writeKeyword(sql) {
	const stripped = stripLiteralsAndComments(sql);
	for (const [verb, pattern] of STRICT_WRITE_PATTERNS) if (pattern.test(stripped)) return verb;
	for (const statement of splitStatements(stripped)) {
		const verb = headVerb(statement);
		if (HEAD_WRITE_VERBS.has(verb)) return verb;
	}
	return "";
}
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
`;
const DATABASES_SQL = `
  select d.datname as name,
         pg_size_pretty(pg_database_size(d.datname)) as size,
         (select count(*)::int from pg_stat_activity a where a.datname = d.datname) as active_connections
  from pg_database d
  where d.datallowconn and not d.datistemplate
  order by pg_database_size(d.datname) desc
`;
const SCHEMA_LOOKUP_SQL = `
  select table_schema
  from information_schema.tables
  where table_name = $1
    and table_schema not in ('pg_catalog', 'information_schema')
  order by case when table_schema = 'public' then 0 else 1 end, table_schema
`;
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
`;
const RELATION_KIND_SQL = `
  select n.nspname as schema, c.relname as name, c.relkind,
         greatest(c.reltuples, 0)::bigint as row_estimate
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where c.oid = $1::regclass
`;
const INDEXES_SQL = `
  select indexname as name, indexdef as definition
  from pg_indexes
  where schemaname = $1 and tablename = $2
  order by indexname
`;
const FOREIGN_KEYS_SQL = `
  select conname as name, pg_get_constraintdef(oid) as definition
  from pg_constraint
  where conrelid = $1::regclass and contype = 'f'
  order by conname
`;
const VERSION_SQL = "select version()";
function relationKindLabel(relkind) {
	switch (relkind) {
		case "r": return "table";
		case "p": return "partitioned table";
		case "v": return "view";
		case "m": return "materialized view";
		case "f": return "foreign table";
		default: return relkind;
	}
}
function apply(ctx, config) {
	const anyDatabases = config.databases.includes("*");
	const allowDatabase = (database) => {
		if (anyDatabases || config.databases.includes(database)) return database;
		throw new Error(`database "${database}" is not enabled for pg-mas; enabled: ${config.databases.join(", ")} (widen the db-pgmas row config \`databases\` list to add it)`);
	};
	const pools = /* @__PURE__ */ new Map();
	const poolFor = (database) => {
		const key = allowDatabase(database);
		let pool = pools.get(key);
		if (pool === void 0) {
			pool = new pg.Pool({
				host: config.host,
				port: config.port,
				user: config.user,
				password: config.password,
				database: key,
				max: config.poolMax,
				connectionTimeoutMillis: config.connectTimeoutMs,
				statement_timeout: config.statementTimeoutMs,
				idleTimeoutMillis: 3e4
			});
			pool.on("error", () => {});
			pools.set(key, pool);
		}
		return pool;
	};
	/**
	* Acquire one client and always release it. An `abortSignal` destroy-releases
	* the client: node-pg exposes no per-query cancel, so tearing the connection
	* down is the cooperative cancellation (the server-side statement_timeout
	* bounds anything the abort might race). Multi-statement simple queries
	* resolve to an array of results.
	*/
	async function withClient(database, run, signal) {
		const client = await poolFor(database).connect();
		let destroyed = false;
		let cancel;
		try {
			if (signal !== void 0) {
				cancel = () => {
					if (destroyed) return;
					destroyed = true;
					client.release(true);
				};
				signal.addEventListener("abort", cancel, { once: true });
			}
			if (signal?.aborted === true) throw new Error("aborted before dispatch");
			try {
				return await run(client);
			} finally {
				if (cancel !== void 0 && signal !== void 0) signal.removeEventListener("abort", cancel);
			}
		} finally {
			if (!destroyed) client.release();
		}
	}
	/** One statement batch on one client; multi-statement SQL → array result. */
	const rawQuery = (database, sql, params, signal) => withClient(database, (client) => params === void 0 ? client.query({ text: sql }) : client.query({
		text: sql,
		values: params
	}), signal);
	function single(outcome) {
		return Array.isArray(outcome) ? outcome[outcome.length - 1] : outcome;
	}
	async function query(sql, options = {}) {
		const database = options.database === void 0 ? config.database : allowDatabase(options.database);
		if (sql.trim().length === 0) throw new Error("sql must be a non-empty string");
		if (config.readOnly) {
			const verb = writeKeyword(sql);
			if (verb !== "") throw new Error(`pg-mas is mounted read-only and the statement contains the write keyword "${verb}" (the guard rejects write-looking keywords after stripping comments and literals). A false positive on a quoted identifier can be avoided by quoting it; for real writes, set \`readOnly: false\` in the db-pgmas row config.`);
		}
		const startedAt = Date.now();
		const outcome = await rawQuery(database, sql, options.params, options.signal);
		const durationMs = Date.now() - startedAt;
		const results = Array.isArray(outcome) ? outcome : [outcome];
		const last = single(outcome);
		return {
			database,
			command: last.command ?? "",
			statements: results.map((result) => ({
				command: result.command ?? "",
				rowCount: result.rowCount ?? -1
			})),
			rowCount: last.rowCount ?? -1,
			rows: last.rows ?? [],
			durationMs
		};
	}
	async function listDatabases(signal) {
		return single(await rawQuery(config.database, DATABASES_SQL, void 0, signal)).rows.map((row) => ({
			name: String(row.name),
			size: String(row.size),
			activeConnections: Number(row.active_connections ?? 0),
			default: row.name === config.database
		}));
	}
	async function listTables(database, signal) {
		const target = database === void 0 ? config.database : allowDatabase(database);
		return single(await rawQuery(target, TABLES_SQL, void 0, signal)).rows.map((row) => ({
			schema: String(row.schema),
			name: String(row.name),
			kind: String(row.kind),
			rowEstimate: Number(row.row_estimate ?? 0),
			totalSize: String(row.total_size),
			...row.comment === null || row.comment === void 0 ? {} : { comment: String(row.comment) }
		}));
	}
	async function describeTable(table, database) {
		const target = database === void 0 ? config.database : allowDatabase(database);
		const trimmed = table.trim();
		const dot = trimmed.indexOf(".");
		let schemaName;
		let tableName;
		if (dot > 0) {
			schemaName = trimmed.slice(0, dot);
			tableName = trimmed.slice(dot + 1);
		} else tableName = trimmed;
		if (tableName.length === 0) throw new Error(`invalid table reference "${trimmed}"`);
		if (schemaName === void 0) {
			const first = single(await rawQuery(target, SCHEMA_LOOKUP_SQL, [tableName])).rows[0];
			if (first === void 0) throw new Error(`table "${trimmed}" not found in database "${target}" (call pg_schema without \`table\` for the listing)`);
			schemaName = String(first.table_schema);
		}
		const qualified = `"${schemaName}"."${tableName}"`;
		const relationRow = single(await rawQuery(target, RELATION_KIND_SQL, [qualified])).rows[0];
		if (relationRow === void 0) throw new Error(`relation "${qualified}" not found in database "${target}"`);
		const [columns, indexes, foreignKeys] = await Promise.all([
			rawQuery(target, COLUMNS_SQL, [qualified]),
			rawQuery(target, INDEXES_SQL, [schemaName, tableName]),
			rawQuery(target, FOREIGN_KEYS_SQL, [qualified])
		]);
		return {
			schema: String(relationRow.schema),
			name: String(relationRow.name),
			kind: relationKindLabel(String(relationRow.relkind)),
			rowEstimate: Number(relationRow.row_estimate ?? 0),
			columns: single(columns).rows.map((row) => ({
				name: String(row.name),
				type: String(row.data_type),
				nullable: Boolean(row.is_nullable),
				...row.column_default === null || row.column_default === void 0 ? {} : { default: String(row.column_default) },
				...row.comment === null || row.comment === void 0 ? {} : { comment: String(row.comment) }
			})),
			indexes: single(indexes).rows.map((row) => ({
				name: String(row.name),
				definition: String(row.definition)
			})),
			foreignKeys: single(foreignKeys).rows.map((row) => ({
				name: String(row.name),
				definition: String(row.definition)
			}))
		};
	}
	async function testConnection(database) {
		const target = database === void 0 ? config.database : allowDatabase(database);
		const startedAt = Date.now();
		const outcome = single(await rawQuery(target, VERSION_SQL, void 0));
		const versionText = String(outcome.rows[0]?.version ?? "");
		const match = /PostgreSQL (\d+)/.exec(versionText);
		return {
			database: target,
			serverVersion: match === null ? 0 : Number(match[1]),
			latencyMs: Date.now() - startedAt
		};
	}
	const service = {
		defaults: {
			host: config.host,
			port: config.port,
			user: config.user,
			database: config.database,
			databases: Object.freeze([...config.databases]),
			readOnly: config.readOnly
		},
		query,
		listDatabases,
		listTables,
		describeTable,
		testConnection,
		withClient
	};
	const withdrawService = ctx.provide("pgmas", service);
	ctx.effect(() => () => {
		withdrawService();
		for (const pool of pools.values()) pool.end().catch(() => {});
		pools.clear();
	}, "db-pgmas: close pools and withdraw service");
	const databaseParam = {
		type: "string",
		description: `Target database (default "${config.database}"; enabled: ${config.databases.join(", ")}).`
	};
	const enabledDatabases = config.databases.join(", ");
	ctx.tools.register(defineTool({
		name: "pg_query",
		description: `Run SQL against the local pg-mas PostgreSQL instance (docker container \`pg-mas\`, PostgreSQL 16; databases ${enabledDatabases}). Supports multi-statement batches when no \`params\` are given; the last statement's rows are returned along with every statement's command tag. ` + (config.readOnly ? "The instance is READ-ONLY here: write-looking keywords (INSERT/UPDATE/DELETE/CREATE/…, after stripping comments and literals) are rejected. " : "Writes are enabled: prefer explicit transactions and verify changes with a follow-up SELECT. ") + "Inspect unfamiliar tables with pg_schema first; keep result sets bounded.",
		parameters: {
			sql: {
				type: "string",
				required: true,
				description: "SQL to execute; a trailing `;` is fine. Use $1, $2 … together with `params` for value binding."
			},
			params: {
				type: "json",
				description: "Optional JSON array bound to $1, $2 … placeholders. When omitted, multi-statement batches are allowed."
			},
			database: databaseParam,
			max_rows: {
				type: "number",
				description: `Row cap for returned rows (1-1000, default ${config.maxRows}); a larger result set is truncated and flagged \`truncated\`.`
			}
		},
		timeoutMs: 6e4,
		isConcurrencySafe: () => config.readOnly,
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					database: { type: "string" },
					command: { type: "string" },
					statements: {
						type: "array",
						items: {
							type: "object",
							additionalProperties: false,
							properties: {
								command: { type: "string" },
								rowCount: { type: "integer" }
							}
						}
					},
					rowCount: { type: "integer" },
					rows: {
						type: "array",
						items: { type: "json" }
					},
					truncated: { type: "boolean" },
					durationMs: { type: "integer" }
				}
			},
			render: (_args, value) => {
				const result = value;
				const header = `[pg-mas/${result.database}] ${result.command} — ${result.rowCount} row(s) in ${result.durationMs}ms`;
				const lines = result.rows.map((row) => JSON.stringify(row));
				const truncation = result.truncated ? [`[truncated: showing ${result.rows.length} rows]`] : [];
				return [{
					type: "text",
					text: [
						header,
						...lines,
						...truncation
					].join("\n")
				}];
			}
		},
		async execute(args, exec) {
			const params = Array.isArray(args.params) ? args.params : void 0;
			if (params !== void 0 && params.length > 100) throw new Error(`too many params (${params.length}); the cap is 100`);
			const cap = Math.min(Math.max(Math.trunc(args.max_rows ?? config.maxRows), 1), 1e3);
			const result = await query(args.sql, {
				params,
				database: args.database,
				signal: exec.signal
			});
			const safeRows = result.rows.map(safeRow);
			const truncated = safeRows.length > cap;
			return {
				database: result.database,
				command: result.command,
				statements: result.statements,
				rowCount: result.rowCount,
				rows: truncated ? safeRows.slice(0, cap) : safeRows,
				truncated,
				durationMs: result.durationMs
			};
		},
		presentCall: (args) => ({
			card: "generic",
			title: `pg_query${args.database === void 0 ? "" : ` (${String(args.database)})`}`,
			kind: "execute",
			rawInput: typeof args.sql === "string" ? args.sql : void 0
		})
	}));
	ctx.tools.register(defineTool({
		name: "pg_schema",
		description: "Inspect the local pg-mas PostgreSQL instance (docker container `pg-mas`). With `table`: columns, indexes, and foreign keys of that table. Without `table`: the target database's tables and views with row estimates and sizes. With `listDatabases`: every connectable database with size and connection count. Start here before pg_query on unfamiliar tables.",
		parameters: {
			database: databaseParam,
			table: {
				type: "string",
				description: "Table or view to describe, optionally schema-qualified (`public.users`); omit to list tables."
			},
			listDatabases: {
				type: "boolean",
				description: "List every connectable database instead of tables (takes precedence over `table`)."
			}
		},
		timeoutMs: 3e4,
		isConcurrencySafe: () => true,
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					database: { type: "string" },
					scope: {
						type: "string",
						enum: [
							"databases",
							"tables",
							"table"
						]
					},
					databases: {
						type: "array",
						items: {
							type: "object",
							additionalProperties: false,
							properties: {
								name: { type: "string" },
								size: { type: "string" },
								activeConnections: { type: "integer" },
								default: { type: "boolean" }
							}
						}
					},
					tables: {
						type: "array",
						items: {
							type: "object",
							additionalProperties: false,
							properties: {
								schema: { type: "string" },
								name: { type: "string" },
								kind: { type: "string" },
								rowEstimate: { type: "integer" },
								totalSize: { type: "string" },
								comment: { type: "string" }
							}
						}
					},
					table: {
						type: "object",
						additionalProperties: false,
						properties: {
							schema: { type: "string" },
							name: { type: "string" },
							kind: { type: "string" },
							rowEstimate: { type: "integer" },
							columns: {
								type: "array",
								items: {
									type: "object",
									additionalProperties: false,
									properties: {
										name: { type: "string" },
										type: { type: "string" },
										nullable: { type: "boolean" },
										default: { type: "string" },
										comment: { type: "string" }
									}
								}
							},
							indexes: {
								type: "array",
								items: {
									type: "object",
									additionalProperties: false,
									properties: {
										name: { type: "string" },
										definition: { type: "string" }
									}
								}
							},
							foreignKeys: {
								type: "array",
								items: {
									type: "object",
									additionalProperties: false,
									properties: {
										name: { type: "string" },
										definition: { type: "string" }
									}
								}
							}
						}
					}
				}
			},
			render: (_args, value) => [{
				type: "text",
				text: renderSchema(value)
			}]
		},
		async execute(args, exec) {
			if (args.listDatabases === true) return {
				database: "*",
				scope: "databases",
				databases: await listDatabases(exec.signal)
			};
			if (args.table !== void 0) {
				const detail = await describeTable(args.table, args.database);
				return {
					database: args.database ?? config.database,
					scope: "table",
					table: detail
				};
			}
			const tables = await listTables(args.database, exec.signal);
			return {
				database: args.database ?? config.database,
				scope: "tables",
				tables
			};
		},
		presentCall: (args) => ({
			card: "generic",
			title: args.listDatabases === true ? "pg_schema (databases)" : args.table === void 0 ? `pg_schema (tables${args.database === void 0 ? "" : ` @ ${String(args.database)}`})` : `pg_schema ${String(args.table)}`,
			kind: "read"
		})
	}));
	ctx.systemPrompt.section({
		name: "tool:pg-mas",
		order: 107,
		text: `The pg_query and pg_schema tools reach the local pg-mas PostgreSQL instance (databases ${enabledDatabases}; default ${config.database}). Inspect with pg_schema before querying unfamiliar tables, keep pg_query result sets bounded with max_rows, and never SELECT * a table whose size you have not checked. ` + (config.readOnly ? "The instance is read-only for these tools; mutating SQL is rejected by design." : "Writes are enabled — prefer explicit transactions (BEGIN … COMMIT) and verify with a SELECT afterwards.")
	});
}
/** Compact fixed-width text projection of one pg_schema result. */
function renderSchema(value) {
	if (value.scope === "databases") {
		const rows = value.databases ?? [];
		const width = Math.max(...rows.map((row) => row.name.length), 8);
		return [`database ${" ".repeat(Math.max(width - 8, 0))}  size         connections`, ...rows.map((row) => `${row.name.padEnd(width)}  ${row.size.padEnd(12)} ${String(row.activeConnections).padStart(3)}${row.default ? "  (default)" : ""}`)].join("\n");
	}
	if (value.scope === "table" && value.table !== void 0) {
		const detail = value.table;
		const columnWidth = Math.max(...detail.columns.map((column) => column.name.length), 4);
		const typeWidth = Math.max(...detail.columns.map((column) => column.type.length), 4);
		const lines = [`${detail.schema}.${detail.name} (${detail.kind}, ~${detail.rowEstimate} rows)`, ...detail.columns.map((column) => `  ${column.name.padEnd(columnWidth)}  ${column.type.padEnd(typeWidth)}  ${column.nullable ? "null" : "not null"}${column.default === void 0 ? "" : `  default ${column.default}`}${column.comment === void 0 ? "" : `  -- ${column.comment}`}`)];
		if (detail.indexes.length > 0) {
			lines.push("indexes:");
			for (const index of detail.indexes) lines.push(`  ${index.definition}`);
		}
		if (detail.foreignKeys.length > 0) {
			lines.push("foreign keys:");
			for (const foreignKey of detail.foreignKeys) lines.push(`  ${foreignKey.definition}`);
		}
		return lines.join("\n");
	}
	const rows = value.tables ?? [];
	if (rows.length === 0) return `[pg-mas/${value.database}] (no tables or views)`;
	const schemaWidth = Math.max(...rows.map((row) => row.schema.length), 6);
	const nameWidth = Math.max(...rows.map((row) => row.name.length), 4);
	const kindWidth = Math.max(...rows.map((row) => row.kind.length), 4);
	const lines = rows.map((row) => `${row.schema.padEnd(schemaWidth)}  ${row.name.padEnd(nameWidth)}  ${row.kind.padEnd(kindWidth)}  ~${String(row.rowEstimate).padStart(10)}  ${row.totalSize.padStart(9)}${row.comment === void 0 ? "" : `  -- ${row.comment}`}`);
	return `[pg-mas/${value.database}] ${rows.length} relation(s)\n${lines.join("\n")}`;
}
//#endregion
export { Config, apply, inject, name, writeKeyword };
