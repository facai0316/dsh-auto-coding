import { _ as canTransition, a as ProjectsRepo, c as REQUIREMENT_STATUSES, d as RequirementsRepo, f as ReviewsRepo, g as assertStatus, h as assertRecordStatus, i as MAX_CONCURRENCY, l as REVIEW_KINDS, m as WorkerConfigRepo, n as DEFAULT_USER_ID, o as QuestionsRepo, p as TRANSITIONS, r as DEFAULT_WORKER_CONFIG, s as RECORD_STATUSES, t as DEFAULT_DATABASE, u as REVIEW_STATUSES, v as normalizeWorkerConfig, y as runMigrations } from "./flow-repo-DTcyZK_k.js";
import { Remote, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import z from "@deepseek-ai/schemastery";
//#region build/flow.js
/**
* cm-flow — host-only dsh plugin: requirements persistence + state machine
* over the pg-mas `cm` database, exposed to the browser as Typert Remote
* namespaces `requirements` / `projects` / `questions`.
*
* The panel is the first consumer. No model tools are registered — writes to
* the business database happen only through these services' typed methods, via
* `pgmas.withClient`. `pg_query` stays read-only.
*
* Schema ownership: the `cm` schema was created by coding-manager's SeaORM
* migrations (now archived); this plugin treats that schema as baseline and
* layers its own forward migrations in `_cm_flow_migrations` (v1 baseline,
* v2 projects, v3 requirements.project_id, v4 ask_user_questions).
*
* The domain + storage live decorator-free in `./repo.ts` so tests (vitest →
* esbuild, no decorator transform) can exercise them against a real `pg`
* pool. This module only adds the Typert Remote service shells.
*
* @module @auto-coding/cm-flow
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
function resolvePgmas(ctx) {
	const pgmas = ctx.get("pgmas");
	if (pgmas === void 0) throw new Error("cm-flow: pgmas service is unavailable (mount @auto-coding/db-pgmas first)");
	return pgmas;
}
let CmFlowService = (() => {
	let _classSuper = TypertRemoteService;
	let _instanceExtraInitializers = [];
	let _list_decorators;
	let _create_decorators;
	let _transition_decorators;
	let _confirmMerged_decorators;
	let _update_decorators;
	let _delete_decorators;
	return class CmFlowService extends _classSuper {
		static {
			const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(_classSuper[Symbol.metadata] ?? null) : void 0;
			_list_decorators = [Remote("list")];
			_create_decorators = [Remote("create")];
			_transition_decorators = [Remote("transition")];
			_confirmMerged_decorators = [Remote("confirmMerged")];
			_update_decorators = [Remote("update")];
			_delete_decorators = [Remote("delete")];
			__esDecorate(this, null, _list_decorators, {
				kind: "method",
				name: "list",
				static: false,
				private: false,
				access: {
					has: (obj) => "list" in obj,
					get: (obj) => obj.list
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _create_decorators, {
				kind: "method",
				name: "create",
				static: false,
				private: false,
				access: {
					has: (obj) => "create" in obj,
					get: (obj) => obj.create
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _transition_decorators, {
				kind: "method",
				name: "transition",
				static: false,
				private: false,
				access: {
					has: (obj) => "transition" in obj,
					get: (obj) => obj.transition
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _confirmMerged_decorators, {
				kind: "method",
				name: "confirmMerged",
				static: false,
				private: false,
				access: {
					has: (obj) => "confirmMerged" in obj,
					get: (obj) => obj.confirmMerged
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _update_decorators, {
				kind: "method",
				name: "update",
				static: false,
				private: false,
				access: {
					has: (obj) => "update" in obj,
					get: (obj) => obj.update
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _delete_decorators, {
				kind: "method",
				name: "delete",
				static: false,
				private: false,
				access: {
					has: (obj) => "delete" in obj,
					get: (obj) => obj.delete
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
		static inject = ["pgmas"];
		static Config = z.object({
			database: z.string().default("cm"),
			userId: z.string().default(DEFAULT_USER_ID)
		});
		repo = __runInitializers(this, _instanceExtraInitializers);
		constructor(ctx, config = {
			database: "cm",
			userId: DEFAULT_USER_ID
		}) {
			super(ctx, "cmFlow", { namespace: "requirements" });
			const pgmas = resolvePgmas(ctx);
			const database = config.database ?? "cm";
			const userId = config.userId ?? "00000000-0000-4000-8000-000000000001";
			this.repo = new RequirementsRepo({
				pgmas,
				database,
				userId
			});
			new ProjectsService(ctx, new ProjectsRepo({
				pgmas,
				database,
				userId
			}));
			new QuestionsService(ctx, new QuestionsRepo({
				pgmas,
				database,
				userId
			}));
			new ReviewsService(ctx, new ReviewsRepo({
				pgmas,
				database,
				userId
			}));
			new RecordsService(ctx, this.repo);
			new ConfigService(ctx, new WorkerConfigRepo({
				pgmas,
				database,
				userId
			}), {
				pgmas,
				database,
				userId
			});
		}
		async list(projectId) {
			return this.repo.list(projectId === void 0 ? {} : { projectId });
		}
		async create(title, description, projectId) {
			return this.repo.create(title, description, projectId);
		}
		async transition(id, to) {
			return this.repo.transition(id, to);
		}
		async confirmMerged(id) {
			return this.repo.confirmMerged(id);
		}
		async update(id, title, description, projectId) {
			return this.repo.updateRequirement(id, {
				title,
				description,
				projectId
			});
		}
		async delete(id) {
			return this.repo.removeRequirement(id);
		}
	};
})();
/** Typert Remote service (namespace `projects`). */
let ProjectsService = (() => {
	let _classSuper = TypertRemoteService;
	let _instanceExtraInitializers = [];
	let _list_decorators;
	let _create_decorators;
	let _update_decorators;
	let _delete_decorators;
	return class ProjectsService extends _classSuper {
		static {
			const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(_classSuper[Symbol.metadata] ?? null) : void 0;
			_list_decorators = [Remote("list")];
			_create_decorators = [Remote("create")];
			_update_decorators = [Remote("update")];
			_delete_decorators = [Remote("delete")];
			__esDecorate(this, null, _list_decorators, {
				kind: "method",
				name: "list",
				static: false,
				private: false,
				access: {
					has: (obj) => "list" in obj,
					get: (obj) => obj.list
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _create_decorators, {
				kind: "method",
				name: "create",
				static: false,
				private: false,
				access: {
					has: (obj) => "create" in obj,
					get: (obj) => obj.create
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _update_decorators, {
				kind: "method",
				name: "update",
				static: false,
				private: false,
				access: {
					has: (obj) => "update" in obj,
					get: (obj) => obj.update
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _delete_decorators, {
				kind: "method",
				name: "delete",
				static: false,
				private: false,
				access: {
					has: (obj) => "delete" in obj,
					get: (obj) => obj.delete
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
		repo = __runInitializers(this, _instanceExtraInitializers);
		constructor(ctx, repo) {
			super(ctx, "cmProjects", { namespace: "projects" });
			this.repo = repo;
		}
		async list() {
			return this.repo.list();
		}
		async create(name, localPath, gitUrl, platform, prToken) {
			return this.repo.create({
				name,
				localPath,
				gitUrl,
				platform,
				prToken
			});
		}
		async update(id, name, localPath, gitUrl, platform, prToken) {
			return this.repo.update(id, {
				name,
				localPath,
				gitUrl,
				platform,
				prToken
			});
		}
		async delete(id) {
			return this.repo.remove(id);
		}
	};
})();
/** Typert Remote service (namespace `questions`). */
let QuestionsService = (() => {
	let _classSuper = TypertRemoteService;
	let _instanceExtraInitializers = [];
	let _list_decorators;
	let _answer_decorators;
	return class QuestionsService extends _classSuper {
		static {
			const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(_classSuper[Symbol.metadata] ?? null) : void 0;
			_list_decorators = [Remote("list")];
			_answer_decorators = [Remote("answer")];
			__esDecorate(this, null, _list_decorators, {
				kind: "method",
				name: "list",
				static: false,
				private: false,
				access: {
					has: (obj) => "list" in obj,
					get: (obj) => obj.list
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _answer_decorators, {
				kind: "method",
				name: "answer",
				static: false,
				private: false,
				access: {
					has: (obj) => "answer" in obj,
					get: (obj) => obj.answer
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
		repo = __runInitializers(this, _instanceExtraInitializers);
		constructor(ctx, repo) {
			super(ctx, "cmQuestions", { namespace: "questions" });
			this.repo = repo;
		}
		async list(recordId) {
			return this.repo.listByRecord(recordId);
		}
		async answer(questionId, answer) {
			return this.repo.answer(questionId, answer);
		}
	};
})();
/** Typert Remote service (namespace `reviews`): 审核大厅的审核单操作。 */
let ReviewsService = (() => {
	let _classSuper = TypertRemoteService;
	let _instanceExtraInitializers = [];
	let _list_decorators;
	let _approve_decorators;
	let _reject_decorators;
	return class ReviewsService extends _classSuper {
		static {
			const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(_classSuper[Symbol.metadata] ?? null) : void 0;
			_list_decorators = [Remote("list")];
			_approve_decorators = [Remote("approve")];
			_reject_decorators = [Remote("reject")];
			__esDecorate(this, null, _list_decorators, {
				kind: "method",
				name: "list",
				static: false,
				private: false,
				access: {
					has: (obj) => "list" in obj,
					get: (obj) => obj.list
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _approve_decorators, {
				kind: "method",
				name: "approve",
				static: false,
				private: false,
				access: {
					has: (obj) => "approve" in obj,
					get: (obj) => obj.approve
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _reject_decorators, {
				kind: "method",
				name: "reject",
				static: false,
				private: false,
				access: {
					has: (obj) => "reject" in obj,
					get: (obj) => obj.reject
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
		repo = __runInitializers(this, _instanceExtraInitializers);
		constructor(ctx, repo) {
			super(ctx, "cmReviews", { namespace: "reviews" });
			this.repo = repo;
		}
		/** 全部 pending 审核单（含关联 record/需求信息），审核大厅数据源。 */
		async list() {
			return this.repo.listPending();
		}
		async approve(id) {
			return this.repo.approve(id);
		}
		async reject(id, feedback) {
			return this.repo.reject(id, feedback);
		}
	};
})();
/** Typert Remote service (namespace `records`): 运行页列表/删除。 */
let RecordsService = (() => {
	let _classSuper = TypertRemoteService;
	let _instanceExtraInitializers = [];
	let _list_decorators;
	let _create_decorators;
	let _update_decorators;
	let _delete_decorators;
	return class RecordsService extends _classSuper {
		static {
			const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(_classSuper[Symbol.metadata] ?? null) : void 0;
			_list_decorators = [Remote("list")];
			_create_decorators = [Remote("create")];
			_update_decorators = [Remote("update")];
			_delete_decorators = [Remote("delete")];
			__esDecorate(this, null, _list_decorators, {
				kind: "method",
				name: "list",
				static: false,
				private: false,
				access: {
					has: (obj) => "list" in obj,
					get: (obj) => obj.list
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _create_decorators, {
				kind: "method",
				name: "create",
				static: false,
				private: false,
				access: {
					has: (obj) => "create" in obj,
					get: (obj) => obj.create
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _update_decorators, {
				kind: "method",
				name: "update",
				static: false,
				private: false,
				access: {
					has: (obj) => "update" in obj,
					get: (obj) => obj.update
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _delete_decorators, {
				kind: "method",
				name: "delete",
				static: false,
				private: false,
				access: {
					has: (obj) => "delete" in obj,
					get: (obj) => obj.delete
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
		repo = __runInitializers(this, _instanceExtraInitializers);
		constructor(ctx, repo) {
			super(ctx, "cmRecords", { namespace: "records" });
			this.repo = repo;
		}
		async list(category, requirementId, status) {
			return this.repo.listRecords({
				category,
				requirementId,
				status: status === void 0 ? void 0 : status
			});
		}
		async create(requirementId, category, status, result) {
			const created = await this.repo.appendRecord({
				requirementId,
				category,
				status,
				result
			});
			return this.repo.getRecordListItem(created.id);
		}
		async update(id, status, result) {
			await this.repo.updateRecord(id, {
				status: status === void 0 ? void 0 : status,
				result: result === void 0 ? void 0 : result
			});
			return this.repo.getRecordListItem(id);
		}
		async delete(id) {
			return this.repo.removeRecord(id);
		}
	};
})();
/** Typert Remote service (namespace `config`): worker 运行配置读写 + LLM 目录。 */
let ConfigService = (() => {
	let _classSuper = TypertRemoteService;
	let _instanceExtraInitializers = [];
	let _get_decorators;
	let _set_decorators;
	let _migrate_decorators;
	let _providers_decorators;
	return class ConfigService extends _classSuper {
		static {
			const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(_classSuper[Symbol.metadata] ?? null) : void 0;
			_get_decorators = [Remote("get")];
			_set_decorators = [Remote("set")];
			_migrate_decorators = [Remote("migrate")];
			_providers_decorators = [Remote("providers")];
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
			__esDecorate(this, null, _set_decorators, {
				kind: "method",
				name: "set",
				static: false,
				private: false,
				access: {
					has: (obj) => "set" in obj,
					get: (obj) => obj.set
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _migrate_decorators, {
				kind: "method",
				name: "migrate",
				static: false,
				private: false,
				access: {
					has: (obj) => "migrate" in obj,
					get: (obj) => obj.migrate
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _providers_decorators, {
				kind: "method",
				name: "providers",
				static: false,
				private: false,
				access: {
					has: (obj) => "providers" in obj,
					get: (obj) => obj.providers
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
		repo = __runInitializers(this, _instanceExtraInitializers);
		pgmas;
		database;
		userId;
		constructor(ctx, repo, migration) {
			super(ctx, "cmConfig", { namespace: "config" });
			this.repo = repo;
			this.pgmas = migration.pgmas;
			this.database = migration.database;
			this.userId = migration.userId;
		}
		async get() {
			return this.repo.get();
		}
		async set(config) {
			return this.repo.set(config);
		}
		/**
		* 显式跑一遍 schema 迁移（幂等）。数据库连接卡片的「迁移」按钮调用。
		*
		* 可选 `connection` 参数（卡片当前草稿值）：提供时用一次性 client 直连
		* 目标库执行迁移——不依赖运行中的 db-pgmas 连接池（池可能在「保存」后
		* 仍是旧配置，导致「测试连接成功、迁移却连旧地址被拒」的错位）。
		* 不提供时回退 pgmas 池（老路径）。
		*/
		async migrate(connection) {
			try {
				if (connection !== void 0 && connection.host !== void 0 && connection.host !== "") {
					const pool = new (await (import("pg"))).Pool({
						host: connection.host,
						port: Number(connection.port) || 5432,
						user: connection.user,
						password: connection.password ?? "",
						database: connection.database,
						max: 1,
						connectionTimeoutMillis: 5e3
					});
					pool.on("error", () => {});
					const seam = { withClient: async (_database, fn) => {
						const client = await pool.connect();
						try {
							return await fn(client);
						} finally {
							client.release();
						}
					} };
					try {
						const applied = await runMigrations(seam, connection.database, this.userId);
						return this.migrateResult(applied);
					} finally {
						await pool.end().catch(() => {});
					}
				}
				const applied = await runMigrations(this.pgmas, this.database, this.userId);
				return this.migrateResult(applied);
			} catch (cause) {
				return {
					ok: false,
					applied: [],
					message: `迁移失败:${cause instanceof Error ? cause.message : String(cause)}`
				};
			}
		}
		migrateResult(applied) {
			return {
				ok: true,
				applied,
				message: applied.length > 0 ? `已应用 ${applied.length} 个迁移：${applied.join("；")}` : "schema 已是最新，无需迁移"
			};
		}
		/** 已注册提供商及其模型目录（面板模型/提供商下拉数据源）。 */
		async providers() {
			const llm = this.ctx.get("llm");
			if (llm === void 0) return [];
			const providers = [];
			for (const provider of llm.listProviders()) {
				let models = [];
				try {
					models = (await llm.listModels(provider.id)).map((model) => ({
						id: model.id,
						name: model.name ?? model.id
					}));
				} catch {
					models = [];
				}
				providers.push({
					id: provider.id,
					name: provider.name ?? provider.id,
					models
				});
			}
			return providers;
		}
	};
})();
//#endregion
export { ConfigService, DEFAULT_DATABASE, DEFAULT_USER_ID, DEFAULT_WORKER_CONFIG, MAX_CONCURRENCY, ProjectsRepo, ProjectsService, QuestionsRepo, QuestionsService, RECORD_STATUSES, REQUIREMENT_STATUSES, REVIEW_KINDS, REVIEW_STATUSES, RecordsService, RequirementsRepo, ReviewsRepo, ReviewsService, TRANSITIONS, WorkerConfigRepo, assertRecordStatus, assertStatus, canTransition, CmFlowService as default, normalizeWorkerConfig, runMigrations as runCmMigrations };
