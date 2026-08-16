/**
 * cm-worker — host-only dsh plugin: the coding-pipeline worker. A timer
 * interval drives a serial poll loop (claim / resume / retry / finalize) that
 * pulls `open` requirements into stage sessions (subagents) running inside
 * per-task git worktrees; every stage is a `records` ledger row.
 *
 * The worker only orchestrates and keeps books — it never writes code. All
 * database writes go through the cm-flow repos over `pgmas.withClient`;
 * `pg_query` stays read-only.
 *
 * @module @auto-coding/cm-worker
 */
import type { Context } from '@deepseek-ai/cordis';
import { Service } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import { type RecordListItem } from '@auto-coding/cm-flow';
import { type PrExecution, type StageAgentOptions, type StageExecution, type StageInput } from './pipeline.ts';
export { buildResolvePrompt, buildPrompt, buildPrPrompt, runLanes, withinWindow, WorkerPipeline, type GapRow } from './pipeline.ts';
export declare const DEFAULT_DATABASE = "cm";
export declare const DEFAULT_POLL_MS = 10000;
export declare const DEFAULT_STAGE_TIMEOUT_MS: number;
export declare const DEFAULT_MAX_RETRIES = 10;
export declare const DEFAULT_SUBAGENT_PROVIDER = "spawn";
/**
 * 时段门控：当前时刻是否落在配置窗口内。小时粒度（含 start、不含 end）；
 * start>end 视为跨天窗口（如 22:00→06:00）。disabled 时恒为 true。
 */
export interface Config {
    database: string;
    pollMs: number;
    stageTimeoutMs: number;
    maxRetries: number;
    subagentProvider: string;
}
/** 阶段会话统一结构化输出契约（ObjectJsonSchema，subagent outputSchema 用）。 */
export declare const STAGE_RESULT_SCHEMA: {
    readonly type: "object";
    readonly additionalProperties: false;
    readonly required: readonly ["isError", "message", "artifacts", "questions"];
    readonly properties: {
        readonly isError: {
            readonly type: "boolean";
        };
        readonly message: {
            readonly type: "string";
        };
        readonly artifacts: {
            readonly type: "array";
            readonly items: {
                readonly type: "string";
            };
        };
        readonly questions: {
            readonly type: "array";
            readonly items: {
                readonly type: "object";
                readonly additionalProperties: false;
                readonly required: readonly ["question", "options"];
                readonly properties: {
                    readonly question: {
                        readonly type: "string";
                    };
                    readonly options: {
                        readonly type: "array";
                        readonly items: {
                            readonly type: "string";
                        };
                    };
                };
            };
        };
    };
};
/** PR 创建任务结构化输出契约（方案 §8）。 */
export declare const PR_RESULT_SCHEMA: {
    readonly type: "object";
    readonly additionalProperties: false;
    readonly required: readonly ["is_ok"];
    readonly properties: {
        readonly is_ok: {
            readonly type: "boolean";
        };
        readonly pr_url: {
            readonly type: "string";
        };
        readonly error: {
            readonly type: "string";
        };
    };
};
declare module '@deepseek-ai/cordis' {
    interface Context {
        timer: {
            interval(callback: () => void, delay: number): () => void;
        };
    }
}
export interface WorkerExecutor {
    run(input: StageInput, agentOptions?: StageAgentOptions): Promise<StageExecution>;
    runPr(input: {
        prompt: string;
        repo: string;
        wtPath: string;
    }, agentOptions?: StageAgentOptions): Promise<PrExecution>;
}
/**
 * Typert Remote service (namespace `merge`): 审核大厅「解决冲突」按钮的入口。
 * 起跑一条冲突解决任务（fetch + merge + 解决冲突 + commit + push，可挂
 * waiting_reply 提问后携答复续跑）；返回 resolve record 列表项，执行在后台。
 */
export declare class MergeService extends TypertRemoteService {
    private readonly startResolve;
    constructor(ctx: Context, startResolve: (requirementId: string) => Promise<RecordListItem>);
    resolveConflicts(requirementId: string): Promise<RecordListItem>;
}
/**
 * Worker 服务：timer 驱动串行 tick。组合可测的 WorkerPipeline 与真实依赖
 * （subagents / agents / fs / worktree）。
 */
export default class CmWorkerService extends Service {
    static inject: string[];
    static Config: z<Config>;
    private readonly pipeline;
    private readonly configRepo;
    private running;
    private config;
    /** 全局并发预算：当前正在跑的流水线任务数（领取 / 审核续跑 / 重试 / 冲突解决）。 */
    private active;
    /** 并发预算满时排队的后台任务（用户触发的冲突解决等）。 */
    private waiters;
    /** 已派发、尚未落定的 record id（防同一审核/重试动作被多轮 tick 重复派发）。 */
    private dispatched;
    /** 启动自愈（僵尸/残留恢复）只执行一次（见 tick 首个分支）。 */
    private startupRecovered;
    constructor(ctx: Context, config?: Config);
    /**
     * 串行 tick：读配置 → 时段门控 → 短派发（领取 / 审核续跑 / 重试，受全局并发
     * 预算约束）→ 收尾。tick 本身只做快查询与派发，不阻塞在长流水线上：每条
     * 领取 / 续跑 / 重试都以后台任务运行，槽位在流水线挂起（进审核门）或完成时
     * 释放——审核放行逐条到来也能按预算并发续跑（10s 一轮，槽位空出即补）。
     * 任一异常静默下轮重试。
     */
    private tick;
    /** 全局并发预算：当前配置的 concurrency（1..MAX_CONCURRENCY 钳制）。 */
    private budget;
    /** 非阻塞获取一个并发槽：空闲则占用并返回 true；已满返回 false（下轮 tick 再试）。 */
    private trySlot;
    /** 释放并发槽：有排队任务则直接移交（计数不变），否则 -1。 */
    private releaseSlot;
    /** 排队获取并发槽（用户触发的冲突解决等：满了就排队，最终会跑）。 */
    private withSlot;
    /** 后台派发一个占槽任务：异常落日志，落定（成功/失败）即释放槽位。 */
    private dispatchTask;
    /** 派发领取：按预算逐个原子领取 open 需求（for update skip locked 互斥），各自后台跑阶段链。 */
    private dispatchClaims;
    /** 派发审核续跑：补 reply 单后，把已放行/驳回的记录按预算逐个后台续跑（多记录可并行）。 */
    private dispatchReviews;
    /** 派发重试：把可重试的 failed record 按预算逐个后台重跑（可并行）。 */
    private dispatchRetries;
    /**
     * 启动自愈（仅第一个 tick）：标记上一进程残留的 running record 为 failed
     * （交给重试路径复用同一 record 续跑），并把停在 success 缺口的需求（如
     * review-code 已 success 但 merge 从未创建的僵尸）按并发预算后台续跑。
     */
    private recoverStartup;
}
