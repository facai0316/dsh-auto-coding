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
import z from '@deepseek-ai/schemastery';
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import { DEFAULT_DATABASE, DEFAULT_USER_ID, ProjectsRepo, QuestionsRepo, RequirementsRepo, } from "./repo.js";
export { REQUIREMENT_STATUSES, RECORD_STATUSES, TRANSITIONS, RequirementsRepo, ProjectsRepo, QuestionsRepo, assertStatus, assertRecordStatus, canTransition, DEFAULT_DATABASE, DEFAULT_USER_ID, } from "./repo.js";
function resolvePgmas(ctx) {
    const pgmas = ctx.get('pgmas');
    if (pgmas === undefined)
        throw new Error('cm-flow: pgmas service is unavailable (mount @auto-coding/db-pgmas first)');
    return pgmas;
}
let CmFlowService = (() => {
    let _classSuper = TypertRemoteService;
    let _instanceExtraInitializers = [];
    let _list_decorators;
    let _create_decorators;
    let _transition_decorators;
    let _confirmMerged_decorators;
    return class CmFlowService extends _classSuper {
        static {
            const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(_classSuper[Symbol.metadata] ?? null) : void 0;
            _list_decorators = [Remote('list')];
            _create_decorators = [Remote('create')];
            _transition_decorators = [Remote('transition')];
            _confirmMerged_decorators = [Remote('confirmMerged')];
            __esDecorate(this, null, _list_decorators, { kind: "method", name: "list", static: false, private: false, access: { has: obj => "list" in obj, get: obj => obj.list }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _create_decorators, { kind: "method", name: "create", static: false, private: false, access: { has: obj => "create" in obj, get: obj => obj.create }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _transition_decorators, { kind: "method", name: "transition", static: false, private: false, access: { has: obj => "transition" in obj, get: obj => obj.transition }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _confirmMerged_decorators, { kind: "method", name: "confirmMerged", static: false, private: false, access: { has: obj => "confirmMerged" in obj, get: obj => obj.confirmMerged }, metadata: _metadata }, null, _instanceExtraInitializers);
            if (_metadata) Object.defineProperty(this, Symbol.metadata, { enumerable: true, configurable: true, writable: true, value: _metadata });
        }
        static inject = ['pgmas'];
        static Config = z.object({
            database: z.string().default(DEFAULT_DATABASE),
            userId: z.string().default(DEFAULT_USER_ID),
        });
        repo = __runInitializers(this, _instanceExtraInitializers);
        constructor(ctx, config = { database: DEFAULT_DATABASE, userId: DEFAULT_USER_ID }) {
            super(ctx, 'cmFlow', { namespace: 'requirements' });
            const pgmas = resolvePgmas(ctx);
            const database = config.database ?? DEFAULT_DATABASE;
            const userId = config.userId ?? DEFAULT_USER_ID;
            this.repo = new RequirementsRepo({ pgmas, database, userId });
            // Sibling namespaces share the same write seam and migration gate.
            new ProjectsService(ctx, new ProjectsRepo({ pgmas, database, userId }));
            new QuestionsService(ctx, new QuestionsRepo({ pgmas, database, userId }));
        }
        async list(projectId) {
            return this.repo.list(projectId === undefined ? {} : { projectId });
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
    };
})();
/**
 * Typert Remote service (namespace `requirements`): methods become
 * `requirements/*` endpoints callable from the browser via
 * `ctx.remote.$mount(...)`. Parameter names are the wire field names (SRC
 * mode reads them from source), so keep them stable and match the client
 * descriptors exactly.
 */
export default CmFlowService;
/** Typert Remote service (namespace `projects`). */
let ProjectsService = (() => {
    let _classSuper = TypertRemoteService;
    let _instanceExtraInitializers = [];
    let _list_decorators;
    let _create_decorators;
    return class ProjectsService extends _classSuper {
        static {
            const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(_classSuper[Symbol.metadata] ?? null) : void 0;
            _list_decorators = [Remote('list')];
            _create_decorators = [Remote('create')];
            __esDecorate(this, null, _list_decorators, { kind: "method", name: "list", static: false, private: false, access: { has: obj => "list" in obj, get: obj => obj.list }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _create_decorators, { kind: "method", name: "create", static: false, private: false, access: { has: obj => "create" in obj, get: obj => obj.create }, metadata: _metadata }, null, _instanceExtraInitializers);
            if (_metadata) Object.defineProperty(this, Symbol.metadata, { enumerable: true, configurable: true, writable: true, value: _metadata });
        }
        repo = __runInitializers(this, _instanceExtraInitializers);
        constructor(ctx, repo) {
            super(ctx, 'cmProjects', { namespace: 'projects' });
            this.repo = repo;
        }
        async list() {
            return this.repo.list();
        }
        async create(name, localPath, gitUrl, platform, prToken) {
            return this.repo.create({ name, localPath, gitUrl, platform, prToken });
        }
    };
})();
export { ProjectsService };
/** Typert Remote service (namespace `questions`). */
let QuestionsService = (() => {
    let _classSuper = TypertRemoteService;
    let _instanceExtraInitializers = [];
    let _list_decorators;
    let _answer_decorators;
    return class QuestionsService extends _classSuper {
        static {
            const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(_classSuper[Symbol.metadata] ?? null) : void 0;
            _list_decorators = [Remote('list')];
            _answer_decorators = [Remote('answer')];
            __esDecorate(this, null, _list_decorators, { kind: "method", name: "list", static: false, private: false, access: { has: obj => "list" in obj, get: obj => obj.list }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _answer_decorators, { kind: "method", name: "answer", static: false, private: false, access: { has: obj => "answer" in obj, get: obj => obj.answer }, metadata: _metadata }, null, _instanceExtraInitializers);
            if (_metadata) Object.defineProperty(this, Symbol.metadata, { enumerable: true, configurable: true, writable: true, value: _metadata });
        }
        repo = __runInitializers(this, _instanceExtraInitializers);
        constructor(ctx, repo) {
            super(ctx, 'cmQuestions', { namespace: 'questions' });
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
export { QuestionsService };
