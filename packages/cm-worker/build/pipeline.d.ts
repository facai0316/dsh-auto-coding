/**
 * Stage orchestration — pure, dependency-injected logic for the coding
 * pipeline worker: claim → stage chain → records ledger → decision channel
 * hooks. Cordis-free so it can be tested with fake executors against the real
 * `cm` database.
 * @module @auto-coding/cm-worker/pipeline
 */
import type { ProjectView, ProjectsRepo, QuestionsRepo, RequirementsRepo, WriteSeam } from '@auto-coding/cm-flow';
export interface StageDef {
    /** records.category 值。 */
    category: string;
    /** facai skill 目录名（.agents/skills/<skill>/SKILL.md）。 */
    skill: string;
    /** 附加到 prompt 的阶段专属指令。 */
    instruction?: string;
}
export declare const STAGES: readonly StageDef[];
export interface StageInput {
    category: string;
    skill: string;
    wtPath: string;
    repo: string;
    title: string;
    description: string | null;
    priorArtifacts: string[];
    userAnswers: {
        question: string;
        answer: string;
    }[];
    prompt: string;
}
export interface StageExecution {
    stopReason: string;
    structured?: unknown;
}
/** Structured result contract the stage session must return (00 §4.4). */
export interface StageResult {
    isError: boolean;
    message: string;
    artifacts: string[];
    questions: {
        question: string;
        options: string[];
    }[];
}
export interface StageExecutor {
    run(input: StageInput): Promise<StageExecution>;
    /** PR 创建任务（merge 阶段）：返回 {is_ok, pr_url, error}。 */
    runPr(input: {
        prompt: string;
        repo: string;
    }): Promise<PrExecution>;
}
/** PR 任务结构化结果（方案 §8 JSON 契约）。 */
export interface PrExecution {
    isOk: boolean;
    prUrl?: string;
    error?: string;
}
/** 解析 PR 任务结构化输出；`is_ok` 兼容 boolean 与字符串 `"true"`。 */
export declare function parsePrResult(value: unknown): PrExecution | null;
/** 组装 PR 创建任务的指导指令（方案 §8）。 */
export declare function buildPrPrompt(input: {
    wtPath: string;
    repo: string;
    title: string;
    description: string | null;
    branch: string;
}): string;
export interface WorktreeHandleLike {
    path: string;
    branch: string;
}
export interface PipelineWorktree {
    create(branch: string, base: string): Promise<WorktreeHandleLike>;
    /** 计算分支对应 worktree 的绝对路径（续跑重建 handle 用）。 */
    pathFor(branch: string): string;
    linkSharedTarget(handle: WorktreeHandleLike): void;
    /** push 任务分支到远程（merge 阶段用）。 */
    push(handle: WorktreeHandleLike): Promise<void>;
    remove(handle: WorktreeHandleLike): Promise<void>;
}
export interface PipelineDeps {
    pgmas: WriteSeam;
    database: string;
    requirements: RequirementsRepo;
    projects: ProjectsRepo;
    questions: QuestionsRepo;
    executor: StageExecutor;
    /** 读取项目 skill 的 SKILL.md 全文。 */
    readSkillMd: (repo: string, skill: string) => Promise<string>;
    /** 每项目一个 worktree 管理器（create/link/remove）。 */
    worktreeFor: (project: Pick<ProjectView, 'id' | 'localPath'>) => PipelineWorktree;
    /** 阶段失败最大重试次数（同 category）。 */
    maxRetries: number;
}
/** 组装阶段会话 prompt（00 §4.7 模板）。 */
export declare function buildPrompt(input: {
    stage: StageDef;
    wtPath: string;
    repo: string;
    skillMd: string;
    title: string;
    description: string | null;
    priorArtifacts: string[];
    userAnswers: {
        question: string;
        answer: string;
    }[];
}): string;
/** 解析阶段会话结构化输出；非法结构视为阶段失败。 */
export declare function parseStageResult(value: unknown): StageResult | null;
/**
 * Claim → stage chain → ledger. One instance per worker service; methods are
 * the tick's poll actions and must be called serially.
 */
export declare class WorkerPipeline {
    private readonly deps;
    constructor(deps: PipelineDeps);
    /** ① 领取一条 open 需求并跑阶段链。返回是否领到并开始处理。 */
    claimAndRun(): Promise<boolean>;
    /**
     * 阶段链：按 STAGES 顺序推进；waiting/failed 时停止。
     * `resume` 从挂起阶段复用 record 续跑；`from` 从某阶段新 append record 开始（重试后继续）。
     */
    runPipeline(input: {
        id: string;
        title: string;
        description: string | null;
        project: ProjectView;
        wt: WorktreeHandleLike;
    }, opts?: {
        resume?: {
            recordId: string;
            category: string;
            userAnswers: {
                question: string;
                answer: string;
            }[];
        };
        from?: {
            category: string;
        };
    }): Promise<'success' | 'waiting' | 'failed'>;
    /** 单阶段：prompt → 会话 → 结构化结果 → 记账。带 recordId 时为续跑（复用该 record）。 */
    runStage(requirement: {
        id: string;
        title: string;
        description: string | null;
        project: ProjectView;
        wt: WorktreeHandleLike;
    }, stage: StageDef, opts?: {
        recordId?: string;
        userAnswers?: {
            question: string;
            answer: string;
        }[];
    }): Promise<'success' | 'waiting' | 'failed'>;
    /**
     * merge 阶段：push 分支 → PR agent 任务 → `markMerging`（in_progress→merging，
     * 记 merge record artifacts=[pr_url]）。无 token / 建 PR 失败 → 挂起
     * waiting_reply（用户补 token 或手动建 PR 后点「已合并」）。
     */
    runMerge(requirement: {
        id: string;
        title: string;
        description: string | null;
        project: ProjectView;
        wt: WorktreeHandleLike;
    }, opts?: {
        recordId?: string;
    }): Promise<'success' | 'waiting' | 'failed'>;
    /**
     * ② 续跑：waiting_reply 且无 pending 问题的 record → 组装用户答复 → 复用
     * 该 record 新开会话重跑同阶段（merge 阶段重跑 runMerge）。
     */
    resumeWaiting(): Promise<void>;
    private resumeRecord;
    /**
     * ③ 重试：failed 且同 requirement 同 category 的 failed 总数 ≤ maxRetries+1
     * → 复用上下文 append 新 record 重跑同阶段；任一同 category failed 数
     * 超限 → requirement 回 `open` 重新排队（worktree 现场保留）。
     */
    retryFailed(): Promise<void>;
    private retryRecord;
    /**
     * ④ 收尾：用户点「已合并」→ confirmMerged（02）→ requirement done；
     * 此处对 done 且尚未清理（无 cleanup record）的需求清理 worktree + 分支，
     * 并记一条 cleanup record 保证幂等。
     */
    finalizeMerged(): Promise<void>;
    /** 该需求最近成功的 record artifacts（供下阶段上下文）。 */
    private priorArtifacts;
}
