/**
 * cm-flow domain + storage, independent of Cordis so it can be tested against
 * a real `pg` pool without a harness context, and free of TS decorators so the
 * vitest/esbuild transform can parse it.
 * @module @auto-coding/cm-flow/repo
 */
import type { PoolClient } from 'pg';
export declare const REQUIREMENT_STATUSES: readonly ["draft", "open", "in_progress", "merging", "done", "cancelled"];
export type RequirementStatus = (typeof REQUIREMENT_STATUSES)[number];
/** records.status 合法值（流水线阶段账本）。 */
export declare const RECORD_STATUSES: readonly ["running", "success", "failed", "waiting_reply"];
export type RecordStatus = (typeof RECORD_STATUSES)[number];
/** Wire/client-facing projection of one requirements row (lossless JSON). */
export interface RequirementView {
    id: string;
    title: string;
    description: string | null;
    status: RequirementStatus;
    projectId: string | null;
    createdAt: string;
    updatedAt: string;
}
/** One stage ledger row folded into a requirement list view. */
export interface StageSummary {
    category: string;
    status: string;
    /** record id（待决策问答按此查问题）。 */
    recordId: string;
    prUrl?: string;
    updatedAt: string;
}
/** Requirement plus its stage ledger fold (panel pipeline console). */
export interface RequirementWithStages extends RequirementView {
    stages: StageSummary[];
}
/** One records row (lossless JSON projection). */
export interface RecordView {
    id: string;
    category: string;
    status: RecordStatus;
    result: string | null;
    artifacts: string[];
    skills: string[];
    parentId: string | null;
    requirementId: string;
    branchId: string | null;
    createdAt: string;
    updatedAt: string;
}
/** Input for opening a stage ledger row. */
export interface RecordInput {
    requirementId: string;
    category: string;
    status: RecordStatus;
    branchId?: string;
    result?: string;
    artifacts?: string[];
    skills?: string[];
    parentId?: string | null;
}
/** Wire/client-facing projection of one projects row (token never returned). */
export interface ProjectView {
    id: string;
    name: string;
    localPath: string;
    gitUrl: string;
    platform: 'gitee' | 'gitea';
    hasToken: boolean;
}
/** Wire/client-facing projection of one ask_user_questions row. */
export interface QuestionView {
    id: string;
    recordId: string;
    question: string;
    options: string[];
    status: 'pending' | 'answered';
    answer: string | null;
    createdAt: string;
    answeredAt: string | null;
}
/**
 * Legal transitions. Legacy panel-era edges (`open→done`, `done→open`) are
 * retained for the current checklist UI; the pipeline era converges them away
 * (panel 提交执行 + worker 验收，见 docs/plans/02) — they will be removed
 * together with the panel 改造. `in_progress→merging` / `merging→done` are the
 * pipeline edges.
 */
export declare const TRANSITIONS: Readonly<Record<RequirementStatus, readonly RequirementStatus[]>>;
export declare function assertStatus(value: unknown): RequirementStatus;
export declare function assertRecordStatus(value: unknown): RecordStatus;
export declare function canTransition(from: RequirementStatus, to: RequirementStatus): boolean;
/** PgMasService is a ten-method seam; the repo needs only the write seam. */
export interface WriteSeam {
    withClient<T>(database: string, fn: (client: PoolClient) => Promise<T>, signal?: AbortSignal): Promise<T>;
}
export declare const DEFAULT_USER_ID = "00000000-0000-4000-8000-000000000001";
export declare const DEFAULT_DATABASE = "cm";
export interface RepoOptions {
    pgmas: WriteSeam;
    database?: string;
    userId?: string;
}
/** Requirements storage + state machine + stage ledger. */
export declare class RequirementsRepo {
    private readonly database;
    private readonly userId;
    private readonly pgmas;
    private readonly ready;
    constructor(options: RepoOptions);
    list(options?: {
        projectId?: string;
    }): Promise<RequirementWithStages[]>;
    /**
     * Create a requirement. With `projectId` → pipeline form: status `draft`,
     * attached to the project, awaiting panel 「开始执行」(transition to open).
     * Without → legacy panel-compatible: status `open`, no project.
     */
    create(title: string, description?: string, projectId?: string): Promise<RequirementView>;
    transition(id: string, to: string): Promise<RequirementView>;
    /** 单条需求（续跑上下文用，不带 stages 折叠）。 */
    getById(id: string): Promise<RequirementView | undefined>;
    /** 该需求最近一条 success record（供下阶段上下文引用产物）。 */
    listRecentRecord(requirementId: string): Promise<RecordView | undefined>;
    /** Worker: open a stage ledger row (status `running`). */
    appendRecord(input: RecordInput): Promise<RecordView>;
    /** Worker: settle one stage ledger row by id. */
    updateRecord(id: string, patch: {
        status?: RecordStatus;
        result?: string;
        artifacts?: string[];
        skills?: string[];
    }): Promise<RecordView>;
    /**
     * Worker: PR created → requirement in_progress → merging。merge 阶段本身由
     * worker 的 runMerge 记账（merge record 含 pr_url）；此方法只推进状态，
     * 不重复插 record。
     */
    markMerging(id: string, _prUrl: string): Promise<RequirementView>;
    /** Panel: user confirmed merged → requirement merging → done + merge record. */
    confirmMerged(id: string): Promise<RequirementView>;
    /** Shared state-machine transition on an already-acquired client (caller owns the transaction). */
    private transitionOnClient;
}
/** Projects registry (local path + git url + platform + optional PR token). */
export declare class ProjectsRepo {
    private readonly database;
    private readonly pgmas;
    private readonly ready;
    constructor(options: RepoOptions);
    list(): Promise<ProjectView[]>;
    create(input: {
        name: string;
        localPath: string;
        gitUrl: string;
        platform: string;
        prToken?: string;
    }): Promise<ProjectView>;
    /** Worker/PR 阶段读取 token；空串视为未配置。 */
    getToken(id: string): Promise<string | undefined>;
    /** Resolve one project by id (worker 领取后取项目信息)。 */
    getById(id: string): Promise<ProjectView | undefined>;
}
/** ask_user_questions ledger (decision channel). */
export declare class QuestionsRepo {
    private readonly database;
    private readonly pgmas;
    private readonly ready;
    constructor(options: RepoOptions);
    insertMany(recordId: string, questions: {
        question: string;
        options: string[];
    }[]): Promise<void>;
    listByRecord(recordId: string): Promise<QuestionView[]>;
    pendingByRecord(recordId: string): Promise<QuestionView[]>;
    answer(questionId: string, answer: string): Promise<QuestionView>;
}
