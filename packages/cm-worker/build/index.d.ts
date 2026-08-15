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
import { type PrExecution, type StageExecution, type StageInput } from './pipeline.ts';
export declare const DEFAULT_DATABASE = "cm";
export declare const DEFAULT_POLL_MS = 10000;
export declare const DEFAULT_STAGE_TIMEOUT_MS: number;
export declare const DEFAULT_MAX_RETRIES = 1;
export declare const DEFAULT_SUBAGENT_PROVIDER = "spawn";
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
    run(input: StageInput): Promise<StageExecution>;
    runPr(input: {
        prompt: string;
        repo: string;
    }): Promise<PrExecution>;
}
/**
 * Worker 服务：timer 驱动串行 tick。组合可测的 WorkerPipeline 与真实依赖
 * （subagents / agents / fs / worktree）。
 */
export default class CmWorkerService extends Service {
    static inject: string[];
    static Config: z<Config>;
    private readonly pipeline;
    private running;
    constructor(ctx: Context, config?: Config);
    /** 串行 tick：领取 → 续跑 → 重试 → 收尾；任一异常静默下轮重试。 */
    private tick;
}
