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
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import type { PgMasService } from './db.ts';
import { ProjectsRepo, QuestionsRepo, RequirementsRepo, ReviewsRepo, WorkerConfigRepo, type ProjectView, type QuestionView, type RecordListItem, type RecordView, type RequirementView, type RequirementWithStages, type ReviewView, type WorkerConfig } from './flow-repo.ts';
export type { RequirementStatus, RecordStatus, RequirementView, RequirementWithStages, StageSummary, RecordView, RecordListItem, RecordInput, ProjectView, QuestionView, ReviewKind, ReviewStatus, ReviewView, WriteSeam, RepoOptions, WorkerConfig, StageModelConfig, } from './flow-repo.ts';
/** 一个 LLM 模型的目录条目（面板下拉用）。 */
export interface LlmModelInfo {
    id: string;
    name: string;
}
/** 一个已注册 LLM 提供商及其模型目录（面板下拉用）。 */
export interface LlmProviderInfo {
    id: string;
    name: string;
    models: LlmModelInfo[];
}
export { REQUIREMENT_STATUSES, RECORD_STATUSES, REVIEW_KINDS, REVIEW_STATUSES, TRANSITIONS, RequirementsRepo, ProjectsRepo, QuestionsRepo, ReviewsRepo, WorkerConfigRepo, DEFAULT_WORKER_CONFIG, MAX_CONCURRENCY, normalizeWorkerConfig, assertStatus, assertRecordStatus, canTransition, DEFAULT_DATABASE, DEFAULT_USER_ID, runMigrations as runCmMigrations, } from './flow-repo.ts';
export interface Config {
    database: string;
    userId: string;
}
/**
 * Typert Remote service (namespace `requirements`): methods become
 * `requirements/*` endpoints callable from the browser via
 * `ctx.remote.$mount(...)`. Parameter names are the wire field names (SRC
 * mode reads them from source), so keep them stable and match the client
 * descriptors exactly.
 */
export default class CmFlowService extends TypertRemoteService {
    static inject: string[];
    static Config: z<Config>;
    private readonly repo;
    constructor(ctx: Context, config?: Config);
    list(projectId?: string): Promise<RequirementWithStages[]>;
    create(title: string, description?: string, projectId?: string): Promise<RequirementView>;
    transition(id: string, to: string): Promise<RequirementView>;
    confirmMerged(id: string): Promise<RequirementView>;
    update(id: string, title?: string, description?: string | null, projectId?: string | null): Promise<RequirementView>;
    delete(id: string): Promise<void>;
}
/** Typert Remote service (namespace `projects`). */
export declare class ProjectsService extends TypertRemoteService {
    private readonly repo;
    constructor(ctx: Context, repo: ProjectsRepo);
    list(): Promise<ProjectView[]>;
    create(name: string, localPath: string, gitUrl: string, platform: string, prToken?: string): Promise<ProjectView>;
    update(id: string, name?: string, localPath?: string, gitUrl?: string, platform?: string, prToken?: string | null): Promise<ProjectView>;
    delete(id: string): Promise<void>;
}
/** Typert Remote service (namespace `questions`). */
export declare class QuestionsService extends TypertRemoteService {
    private readonly repo;
    constructor(ctx: Context, repo: QuestionsRepo);
    list(recordId: string): Promise<QuestionView[]>;
    answer(questionId: string, answer: string): Promise<QuestionView>;
}
/** Typert Remote service (namespace `reviews`): 审核大厅的审核单操作。 */
export declare class ReviewsService extends TypertRemoteService {
    private readonly repo;
    constructor(ctx: Context, repo: ReviewsRepo);
    /** 全部 pending 审核单（含关联 record/需求信息），审核大厅数据源。 */
    list(): Promise<ReviewView[]>;
    approve(id: string): Promise<ReviewView>;
    reject(id: string, feedback: string): Promise<ReviewView>;
}
/** Typert Remote service (namespace `records`): 运行页列表/删除。 */
export declare class RecordsService extends TypertRemoteService {
    private readonly repo;
    constructor(ctx: Context, repo: RequirementsRepo);
    list(category?: string, requirementId?: string, status?: string): Promise<RecordListItem[]>;
    create(requirementId: string, category: string, status: string, result?: string): Promise<RecordListItem>;
    update(id: string, status?: string, result?: string): Promise<RecordListItem>;
    delete(id: string): Promise<void>;
}
/** Typert Remote service (namespace `config`): worker 运行配置读写 + LLM 目录。 */
export declare class ConfigService extends TypertRemoteService {
    private readonly repo;
    private readonly pgmas;
    private readonly database;
    private readonly userId;
    constructor(ctx: Context, repo: WorkerConfigRepo, migration: {
        pgmas: PgMasService;
        database: string;
        userId: string;
    });
    get(): Promise<WorkerConfig>;
    set(config: WorkerConfig): Promise<WorkerConfig>;
    /**
     * 显式跑一遍 schema 迁移（幂等）。数据库连接卡片的「迁移」按钮调用。
     *
     * 可选 `connection` 参数（卡片当前草稿值）：提供时用一次性 client 直连
     * 目标库执行迁移——不依赖运行中的 db-pgmas 连接池（池可能在「保存」后
     * 仍是旧配置，导致「测试连接成功、迁移却连旧地址被拒」的错位）。
     * 不提供时回退 pgmas 池（老路径）。
     */
    migrate(connection?: {
        host: string;
        port: number;
        user: string;
        password?: string;
        database: string;
    }): Promise<{
        ok: boolean;
        applied: string[];
        message: string;
    }>;
    private migrateResult;
    /** 已注册提供商及其模型目录（面板模型/提供商下拉数据源）。 */
    providers(): Promise<LlmProviderInfo[]>;
}
export type { RecordView as CmFlowRecordView };
