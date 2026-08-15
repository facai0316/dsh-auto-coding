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
import { ProjectsRepo, QuestionsRepo, type ProjectView, type QuestionView, type RecordView, type RequirementView, type RequirementWithStages } from './repo.ts';
export type { RequirementStatus, RecordStatus, RequirementView, RequirementWithStages, StageSummary, RecordView, RecordInput, ProjectView, QuestionView, WriteSeam, RepoOptions, } from './repo.ts';
export { REQUIREMENT_STATUSES, RECORD_STATUSES, TRANSITIONS, RequirementsRepo, ProjectsRepo, QuestionsRepo, assertStatus, assertRecordStatus, canTransition, DEFAULT_DATABASE, DEFAULT_USER_ID, } from './repo.ts';
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
}
/** Typert Remote service (namespace `projects`). */
export declare class ProjectsService extends TypertRemoteService {
    private readonly repo;
    constructor(ctx: Context, repo: ProjectsRepo);
    list(): Promise<ProjectView[]>;
    create(name: string, localPath: string, gitUrl: string, platform: string, prToken?: string): Promise<ProjectView>;
}
/** Typert Remote service (namespace `questions`). */
export declare class QuestionsService extends TypertRemoteService {
    private readonly repo;
    constructor(ctx: Context, repo: QuestionsRepo);
    list(recordId: string): Promise<QuestionView[]>;
    answer(questionId: string, answer: string): Promise<QuestionView>;
}
export type { RecordView as CmFlowRecordView };
