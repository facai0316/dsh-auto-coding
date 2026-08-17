/**
 * cm-flow domain + storage, independent of Cordis so it can be tested against
 * a real `pg` pool without a harness context, and free of TS decorators so the
 * vitest/esbuild transform can parse it.
 * @module @auto-coding/cm-flow/repo
 */
import type { PoolClient } from 'pg';
export declare const REQUIREMENT_STATUSES: readonly ["draft", "open", "in_progress", "merging", "done", "cancelled", "terminated"];
export type RequirementStatus = (typeof REQUIREMENT_STATUSES)[number];
/** records.status 合法值（流水线阶段账本）。 */
export declare const RECORD_STATUSES: readonly ["running", "success", "failed", "waiting_reply", "retrying", "waiting_review", "terminated"];
export type RecordStatus = (typeof RECORD_STATUSES)[number];
/** 审核单 kind：review=人工审核（ADR/计划等产物），reply=待决策问答的放行审核。 */
export declare const REVIEW_KINDS: readonly ["review", "reply"];
export type ReviewKind = (typeof REVIEW_KINDS)[number];
/** 审核单状态。 */
export declare const REVIEW_STATUSES: readonly ["pending", "approved", "rejected"];
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];
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
    /** 该阶段已重试次数（worker 复用原 record 计数，上限 maxRetries）。 */
    retryCount: number;
    createdAt: string;
    updatedAt: string;
}
/** Record plus its requirement title (运行页卡片/筛选需要). */
export interface RecordListItem extends RecordView {
    requirementTitle: string | null;
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
/** Wire/client-facing projection of one reviews row. */
export interface ReviewView {
    id: string;
    recordId: string;
    kind: ReviewKind;
    status: ReviewStatus;
    /** 驳回时的整改意见（通过/待审为 null）。 */
    feedback: string | null;
    createdAt: string;
    decidedAt: string | null;
    /** 关联 record / 需求信息（审核大厅卡片展示）。 */
    category: string;
    result: string | null;
    artifacts: string[];
    requirementId: string;
    requirementTitle: string | null;
    requirementStatus: RequirementStatus;
}
/** 每阶段/默认的子会话模型覆盖（agentOptions 直通 subagents.start）。 */
export interface StageModelConfig {
    /** Provider 路由（缺省继承 worker 根 agent）。 */
    provider?: string | null;
    /** 模型 id（缺省继承 worker 根 agent）。 */
    model?: string | null;
    /** 每次会话请求的最大输出 tokens。 */
    maxTokens?: number | null;
}
/** Worker 运行配置：时段窗口 + 并发 + 每阶段模型/模式。 */
export interface WorkerConfig {
    /** 是否启用「仅指定时段运行」。false = 24h 全时段。 */
    timeWindowEnabled: boolean;
    /**
     * 时段限制作用的阶段清单（records.category；merge/resolve 亦属阶段）。
     * null/缺省 = 全部阶段受限（旧语义，窗口外 worker 整轮不派发）；
     * 数组（可为空）= 仅勾选阶段受限时段，未勾选阶段 24h 可跑。
     */
    timeWindowStages?: string[] | null;
    /** 起始小时（0-23，含）。 */
    startHour: number;
    /** 结束小时（0-23，不含；start>end 视为跨天窗口）。 */
    endHour: number;
    /** 并发领取并运行的流水线数（1-8；1 = 串行）。 */
    concurrency: number;
    /** 每阶段覆盖（category → 配置；merge/resolve 亦属阶段）。 */
    stages: Record<string, StageModelConfig>;
    /** 未配置阶段的默认模型。 */
    defaultModel?: string | null;
    /** 未配置阶段的默认 provider。 */
    defaultProvider?: string | null;
    /** 未配置阶段的默认 maxTokens。 */
    defaultMaxTokens?: number | null;
}
export declare const DEFAULT_WORKER_CONFIG: WorkerConfig;
/** 并发上限：同时运行的流水线条数不超过该值（钳制上限，防资源打爆）。 */
export declare const MAX_CONCURRENCY = 8;
/** 规范化一个 WorkerConfig（补默认值、整型边界钳制）。 */
export declare function normalizeWorkerConfig(input: unknown): WorkerConfig;
/**
 * Legal transitions. Legacy panel-era edges (`open→done`, `done→open`) are
 * retained for the current checklist UI; the pipeline era converges them away
 * (panel 提交执行 + worker 验收，见 docs/plans/02) — they will be removed
 * together with the panel 改造. `in_progress→merging` / `merging→done` are the
 * pipeline edges. `terminated` 为不可逆终态：可从任何非终态进入，无任何出路。
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
/**
 * Ensure schema + fixed dsh user exist. Idempotent; safe to run from any repo
 * construction (version rows skip already-applied migrations). Returns the
 * names of migrations applied on this run (empty when everything was already
 * up to date) — used by the panel's「迁移」button to report progress.
 */
export declare function runMigrations(pgmas: WriteSeam, database: string, userId: string): Promise<string[]>;
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
    /** 该需求某 category 最近一条 record（延后人审门定位被审产物 record 用）。 */
    latestRecordByCategory(requirementId: string, category: string): Promise<RecordView | undefined>;
    /** Worker: open a stage ledger row (status `running`). */
    appendRecord(input: RecordInput): Promise<RecordView>;
    /** Worker: settle one stage ledger row by id. */
    updateRecord(id: string, patch: {
        status?: RecordStatus;
        result?: string;
        artifacts?: string[];
        skills?: string[];
        retryCount?: number;
    }): Promise<RecordView>;
    /** Worker: 标记一次重试——复用原 record（不新开），retry_count 原子 +1。 */
    markRetrying(id: string): Promise<RecordView>;
    /** 运行页：records 列表，支持 category / requirementId / status 筛选。 */
    listRecords(filters?: {
        category?: string;
        requirementId?: string;
        status?: RecordStatus;
    }): Promise<RecordListItem[]>;
    /** 运行页：删除一条 record（其 ask_user_questions 由 ON DELETE CASCADE 清理）。 */
    removeRecord(id: string): Promise<void>;
    /** 单条 record + 需求标题（records/update 后返回完整列表项）。 */
    getRecordListItem(id: string): Promise<RecordListItem>;
    /** 面板：编辑需求字段（标题/描述/项目）。 */
    updateRequirement(id: string, patch: {
        title?: string;
        description?: string | null;
        projectId?: string | null;
    }): Promise<RequirementView>;
    /** 面板：真删一条需求及其全部 records（questions 级联清理）。 */
    removeRequirement(id: string): Promise<void>;
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
    /** 面板：编辑项目字段。prToken 显式传入（含空串）时更新，undefined 保持不变。 */
    update(id: string, patch: {
        name?: string;
        localPath?: string;
        gitUrl?: string;
        platform?: string;
        prToken?: string | null;
    }): Promise<ProjectView>;
    /** 面板：删除项目。若仍有需求引用则拒绝（FK 保护）。 */
    remove(id: string): Promise<void>;
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
/** 审核单账本：人工审核门（review）+ 待决策放行审核（reply）。 */
export declare class ReviewsRepo {
    private readonly database;
    private readonly pgmas;
    private readonly ready;
    constructor(options: RepoOptions);
    /** Worker：为 record 挂一张 pending 审核单。 */
    create(recordId: string, kind: ReviewKind): Promise<ReviewView>;
    /** 幂等补单：record 尚无 pending reply 单时插入一张（旧 waiting_reply 数据兼容；驳回重跑后再提问也会补新单）。 */
    ensureReply(recordId: string): Promise<void>;
    /** 审核大厅：所有 pending 审核单（含关联 record/需求信息）；已终止需求的不再展示。 */
    listPending(): Promise<ReviewView[]>;
    /** 某 record 的最新一张审核单（无则 undefined）。 */
    latestByRecord(recordId: string): Promise<ReviewView | undefined>;
    /** 某 record 的全部审核单（按时间正序，测试/审计用）。 */
    listByRecord(recordId: string): Promise<ReviewView[]>;
    /** 面板：审核通过。reply 放行单必须全部问题作答完毕才能通过（与审核大厅规则一致）。 */
    approve(id: string): Promise<ReviewView>;
    /** 面板：驳回 + 整改意见（意见必填）。 */
    reject(id: string, feedback: string): Promise<ReviewView>;
    private requireById;
}
/** Worker 运行配置存储：worker_config 单例行（id=1）。 */
export declare class WorkerConfigRepo {
    private readonly database;
    private readonly pgmas;
    private readonly ready;
    constructor(options: RepoOptions);
    /** 读取当前配置；无行时返回默认值。 */
    get(): Promise<WorkerConfig>;
    /** 保存配置（upsert 单行），返回规范化后的值。 */
    set(config: WorkerConfig): Promise<WorkerConfig>;
}
