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
import { Service } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ProjectsRepo, QuestionsRepo, RequirementsRepo } from '@auto-coding/cm-flow';
import { WorktreeManager } from '@auto-coding/cm-worktree';
import { WorkerPipeline, parsePrResult } from "./pipeline.js";
export const DEFAULT_DATABASE = 'cm';
export const DEFAULT_POLL_MS = 10_000;
export const DEFAULT_STAGE_TIMEOUT_MS = 30 * 60_000;
export const DEFAULT_MAX_RETRIES = 1;
export const DEFAULT_SUBAGENT_PROVIDER = 'spawn';
/** 阶段会话统一结构化输出契约（ObjectJsonSchema，subagent outputSchema 用）。 */
export const STAGE_RESULT_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    required: ['isError', 'message', 'artifacts', 'questions'],
    properties: {
        isError: { type: 'boolean' },
        message: { type: 'string' },
        artifacts: { type: 'array', items: { type: 'string' } },
        questions: {
            type: 'array',
            items: {
                type: 'object',
                additionalProperties: false,
                required: ['question', 'options'],
                properties: {
                    question: { type: 'string' },
                    options: { type: 'array', items: { type: 'string' } },
                },
            },
        },
    },
};
/** PR 创建任务结构化输出契约（方案 §8）。 */
export const PR_RESULT_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    required: ['is_ok'],
    properties: {
        is_ok: { type: 'boolean' },
        pr_url: { type: 'string' },
        error: { type: 'string' },
    },
};
/**
 * 真实阶段执行器：subagents.start + STAGE_RESULT_SCHEMA 结构化回传。
 * parent 用 worker 根 agent（懒建，cwd=项目主 checkout）。
 */
class SubagentStageExecutor {
    subagents;
    agents;
    provider;
    stageTimeoutMs;
    workerAgent;
    constructor(subagents, agents, provider, stageTimeoutMs) {
        this.subagents = subagents;
        this.agents = agents;
        this.provider = provider;
        this.stageTimeoutMs = stageTimeoutMs;
    }
    async run(input) {
        const parent = await this.ensureWorkerAgent(input.repo);
        const run = await this.subagents.start(this.provider, {
            label: `${input.category}:${input.wtPath.split('/').pop() ?? ''}`,
            prompt: [{ type: 'text', text: input.prompt }],
            parent,
            signal: AbortSignal.timeout(this.stageTimeoutMs),
            outputSchema: STAGE_RESULT_SCHEMA,
        });
        const result = await run.result;
        await run.dispose().catch(() => { });
        return { stopReason: result.stopReason, structured: result.structured };
    }
    async runPr(input) {
        const parent = await this.ensureWorkerAgent(input.repo);
        const run = await this.subagents.start(this.provider, {
            label: `merge:pr`,
            prompt: [{ type: 'text', text: input.prompt }],
            parent,
            signal: AbortSignal.timeout(this.stageTimeoutMs),
            outputSchema: PR_RESULT_SCHEMA,
        });
        const result = await run.result;
        await run.dispose().catch(() => { });
        if (result.stopReason !== 'completed') {
            return { isOk: false, error: `PR 会话未完成（stopReason=${result.stopReason}）` };
        }
        return parsePrResult(result.structured) ?? { isOk: false, error: 'PR 会话未返回合法 JSON' };
    }
    async ensureWorkerAgent(cwd) {
        if (this.workerAgent !== undefined)
            return this.workerAgent;
        const handle = await this.agents.create({
            sessionId: randomUUID(),
            meta: { cwd, origin: 'subagent' },
        });
        this.workerAgent = handle.agent;
        return handle.agent;
    }
}
/**
 * Worker 服务：timer 驱动串行 tick。组合可测的 WorkerPipeline 与真实依赖
 * （subagents / agents / fs / worktree）。
 */
export default class CmWorkerService extends Service {
    static inject = ['pgmas', 'timer', 'subagents', 'agents'];
    static Config = z.object({
        database: z.string().default(DEFAULT_DATABASE),
        pollMs: z.number().min(1000).default(DEFAULT_POLL_MS),
        stageTimeoutMs: z.number().min(10_000).default(DEFAULT_STAGE_TIMEOUT_MS),
        maxRetries: z.number().min(0).max(5).default(DEFAULT_MAX_RETRIES),
        subagentProvider: z.string().default(DEFAULT_SUBAGENT_PROVIDER),
    });
    pipeline;
    running = false;
    constructor(ctx, config = {
        database: DEFAULT_DATABASE,
        pollMs: DEFAULT_POLL_MS,
        stageTimeoutMs: DEFAULT_STAGE_TIMEOUT_MS,
        maxRetries: DEFAULT_MAX_RETRIES,
        subagentProvider: DEFAULT_SUBAGENT_PROVIDER,
    }) {
        super(ctx, 'cmWorker');
        const pgmas = ctx.get('pgmas');
        if (pgmas === undefined)
            throw new Error('cm-worker: pgmas service is unavailable (mount @auto-coding/db-pgmas first)');
        const database = config.database ?? DEFAULT_DATABASE;
        const requirements = new RequirementsRepo({ pgmas, database });
        const projects = new ProjectsRepo({ pgmas, database });
        const questions = new QuestionsRepo({ pgmas, database });
        const subagents = ctx.get('subagents');
        if (subagents === undefined)
            throw new Error('cm-worker: subagents service is unavailable');
        const agents = ctx.get('agents');
        if (agents === undefined)
            throw new Error('cm-worker: agents service is unavailable');
        const executor = new SubagentStageExecutor(subagents, agents, config.subagentProvider ?? DEFAULT_SUBAGENT_PROVIDER, config.stageTimeoutMs ?? DEFAULT_STAGE_TIMEOUT_MS);
        const worktrees = new Map();
        const worktreeFor = (project) => {
            let manager = worktrees.get(project.id);
            if (manager === undefined) {
                manager = new WorktreeManager({ repo: project.localPath });
                worktrees.set(project.id, manager);
            }
            return manager;
        };
        this.pipeline = new WorkerPipeline({
            pgmas,
            database,
            requirements,
            projects,
            questions,
            executor,
            readSkillMd: async (repo, skill) => readFile(join(repo, `.agents/skills/${skill}/SKILL.md`), 'utf8'),
            worktreeFor,
            maxRetries: config.maxRetries ?? DEFAULT_MAX_RETRIES,
        });
        const pollMs = config.pollMs ?? DEFAULT_POLL_MS;
        ctx.timer.interval(() => {
            if (this.running)
                return;
            void this.tick();
        }, pollMs);
    }
    /** 串行 tick：领取 → 续跑 → 重试 → 收尾；任一异常静默下轮重试。 */
    async tick() {
        this.running = true;
        try {
            await this.pipeline.claimAndRun();
            await this.pipeline.resumeWaiting();
            await this.pipeline.retryFailed();
            await this.pipeline.finalizeMerged();
        }
        catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            console.warn(`[cm-worker] tick 异常（下轮重试）: ${detail}`);
        }
        finally {
            this.running = false;
        }
    }
}
