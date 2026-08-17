/**
 * Stage orchestration — pure, dependency-injected logic for the coding
 * pipeline worker: claim → stage chain → records ledger → decision channel
 * hooks. Cordis-free so it can be tested with fake executors against the real
 * `cm` database.
 * @module @auto-coding/cm-worker/pipeline
 */
import type { ProjectView, ProjectsRepo, QuestionsRepo, RecordListItem, RequirementsRepo, ReviewsRepo, WorkerConfig, WriteSeam } from './flow-repo.ts';
export interface StageDef {
    /** records.category 值。 */
    category: string;
    /** facai skill 目录名（.agents/skills/<skill>/SKILL.md）。 */
    skill: string;
    /** 附加到 prompt 的阶段专属指令。 */
    instruction?: string;
}
/**
 * 需要人工审核的产物阶段（立即门禁）：阶段成功后直接挂起为 `waiting_review`
 * 并生成一张 kind='review' 的审核单，等在审核大厅通过后才继续；
 * 驳回带整改意见 → 复用同一 record 携反馈重跑。
 */
export declare const REVIEW_GATED: readonly string[];
/**
 * 延后人工审核门：某阶段（category）的产物审核放在其「机审」阶段（anchor，
 * 如 plan → review-plan）成功之后——先 agent facai-review 机审，再人审。
 * 通过后从 anchor 的下一阶段继续；驳回则从 category 阶段携反馈重跑，再走机审。
 */
export interface DeferredReviewGate {
    /** 被审核的产物阶段（其 record 挂 waiting_review + 审核单）。 */
    category: string;
    /** 机审阶段：成功后才挂人审门。 */
    anchor: string;
}
export declare const DEFERRED_REVIEW_GATES: readonly DeferredReviewGate[];
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
    /** 审核驳回的整改意见（重跑注入上下文）。 */
    feedback?: string;
    prompt: string;
}
export interface StageExecution {
    stopReason: string;
    structured?: unknown;
}
/** 阶段子会话的模型覆盖（直通 subagents.start 的 agentOptions）。 */
export interface StageAgentOptions {
    provider?: string;
    model?: string;
    maxTokens?: number;
}
/**
 * 时段门控：当前时刻是否落在配置窗口内。小时粒度（含 start、不含 end）；
 * start>end 视为跨天窗口（如 22:00→06:00）；起=止视为不限制。disabled 恒为 true。
 */
export declare function withinWindow(config: Pick<WorkerConfig, 'timeWindowEnabled' | 'startHour' | 'endHour'>, now?: Date): boolean;
/**
 * 每阶段时段门控：某阶段此刻是否允许起跑。
 * - 未启用时段 → 恒 true；
 * - 阶段清单缺省（null/undefined，旧配置）→ 全部阶段受限（等价 withinWindow）；
 * - 清单内阶段按 withinWindow 判定，清单外阶段（未勾选）恒 true（24h 可跑）。
 */
export declare function stageWindowAllowed(config: Pick<WorkerConfig, 'timeWindowEnabled' | 'startHour' | 'endHour' | 'timeWindowStages'>, category: string, now?: Date): boolean;
/**
 * 并发 lanes：同时启动 `count` 个流水线（每个领取并跑一条需求）。
 * 领取用 `for update skip locked`，并发安全；返回实际跑起来的条数。
 * count 已由调用方钳制（1..MAX_CONCURRENCY）。
 */
export declare function runLanes(count: number, run: () => Promise<boolean>): Promise<number>;
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
    run(input: StageInput, agentOptions?: StageAgentOptions): Promise<StageExecution>;
    /** PR 创建任务（merge 阶段）：返回 {is_ok, pr_url, error}。 */
    runPr(input: {
        prompt: string;
        repo: string;
        wtPath: string;
    }, agentOptions?: StageAgentOptions): Promise<PrExecution>;
}
/** PR 任务结构化结果（方案 §8 JSON 契约）。 */
export interface PrExecution {
    isOk: boolean;
    prUrl?: string;
    error?: string;
}
/** 解析 PR 任务结构化输出；`is_ok` 兼容 boolean 与字符串 `"true"`。 */
export declare function parsePrResult(value: unknown): PrExecution | null;
/**
 * 组装 PR 创建任务的指导指令（方案 §8）。
 *
 * token 直接注入指令正文（本地个人部署可接受；子进程环境会做凭据清洗、
 * shellEnv 只放行 DSH_* 键，$PR_TOKEN 环境变量通道在本部署不可用）。
 * 约束：token 只用于 Authorization 头，不得写入 git 提交、records 或输出回显。
 */
export declare function buildPrPrompt(input: {
    wtPath: string;
    repo: string;
    title: string;
    description: string | null;
    branch: string;
    token: string;
}): string;
export interface WorktreeHandleLike {
    path: string;
    branch: string;
}
/**
 * 组装「解决冲突」任务的指导指令（merge 阶段的用户按钮触发）。
 *
 * 任务：把任务分支与远端 main 同步（fetch + merge）、解决合并冲突、commit +
 * push。需要用户决策时不中断——把所有不确定点攒齐，一次性放进结构化结果
 * questions 字段（与阶段通道一致：worker 落 waiting_reply + ask_user_questions，
 * 答完放行后携答复续跑，工作区未提交的冲突解决保留）。
 */
export declare function buildResolvePrompt(input: {
    wtPath: string;
    repo: string;
    branch: string;
    title: string;
    description: string | null;
    userAnswers: {
        question: string;
        answer: string;
    }[];
}): string;
export interface PipelineWorktree {
    create(branch: string, base: string): Promise<WorktreeHandleLike>;
    /** 计算分支对应 worktree 的绝对路径（续跑重建 handle 用）。 */
    pathFor(branch: string): string;
    linkSharedTarget(handle: WorktreeHandleLike): void;
    /** push 任务分支到远程（merge 阶段用）。 */
    push(handle: WorktreeHandleLike): Promise<void>;
    /** 收尾：主 checkout 切到 main 并 pull（PR 已合并后同步本地 main）。 */
    pullMain(branch?: string): Promise<void>;
    remove(handle: WorktreeHandleLike): Promise<void>;
    /** 兜底提交：把 worktree 中未提交改动以一次 commit 落到任务分支（无改动 no-op）。 */
    commitAll(wtPath: string, message: string): Promise<boolean>;
}
export interface PipelineDeps {
    pgmas: WriteSeam;
    database: string;
    requirements: RequirementsRepo;
    projects: ProjectsRepo;
    questions: QuestionsRepo;
    reviews: ReviewsRepo;
    executor: StageExecutor;
    /** 读取项目 skill 的 SKILL.md 全文。 */
    readSkillMd: (repo: string, skill: string) => Promise<string>;
    /**
     * 把外部 skillsSource（dir|git）的技能集补进任务 worktree 的
     * `.agents/skills/`（仅补缺失项）。插件不内置技能；未配置 skillsSource 时
     * 该钩子缺省 no-op，流水线只读项目自身 `.agents/skills/`（决策 4 / P3 修订）。
     */
    provisionSkills?: (wtPath: string) => Promise<void>;
    /** 产物存在性校验：相对 worktree 根的一个相对路径是否真实存在（不存在返回 false）。 */
    artifactExists: (wtPath: string, relPath: string) => Promise<boolean>;
    /** 每项目一个 worktree 管理器（create/link/remove）。 */
    worktreeFor: (project: Pick<ProjectView, 'id' | 'localPath'>) => PipelineWorktree;
    /** 阶段失败最大重试次数（同 category）。 */
    maxRetries: number;
    /** 某阶段（或 merge）的模型覆盖；无配置时返回 undefined（继承父 agent）。 */
    configFor: (category: string) => StageAgentOptions | undefined;
    /**
     * 每阶段时段门控：该阶段此刻是否允许起跑（false → 阶段链返回 'deferred'，
     * 不落任何 record，需求停在上一阶段 success 的可续跑缺口，窗口开后由缺口
     * 续跑接上）。未提供 = 不限时段（测试/串行场景）。
     */
    windowFor?: (category: string) => boolean;
    /**
     * 后台任务派发钩子（service 注入全局并发预算）；未提供则直接 fire-and-forget。
     * 冲突解决等用户触发的长任务经此排队执行（预算满时排队，槽位空出即跑）。
     */
    dispatchBackground?: (task: () => Promise<void>) => void;
    /**
     * 阶段成功后兜底提交 worktree 未提交产物（facai-coding 等技能默认不 git commit，
     * 而 merge push 只推已提交内容——不提交则 PR 漏掉全部代码）。无改动时 no-op。
     */
    commitWorktree?: (project: Pick<ProjectView, 'id' | 'localPath'>, wtPath: string, message: string) => Promise<void>;
}
/** `claim()` 的返回：一条已原子领取（open → in_progress）的需求。 */
export interface ClaimedRequirement {
    id: string;
    projectId: string;
    title: string;
    description: string | null;
}
/** 审核大厅轮询返回的一行「已到期需处理」的审核动作（含最新审核单字段）。 */
export interface ReviewActionRow {
    record_id: string;
    requirement_id: string;
    category: string;
    branch_id: string | null;
    review_kind: string;
    review_status: string;
    review_feedback: string | null;
}
/** 缺口僵尸行：in_progress 需求停在 success 记录、未创建 merge（进程重启/崩溃残留）。 */
export interface GapRow {
    requirement_id: string;
    branch_id: string | null;
    last_category: string | null;
}
/** 重试轮询返回的一行待重试的 failed record。 */
export interface RetryRow {
    record_id: string;
    requirement_id: string;
    category: string;
    branch_id: string | null;
}
/**
 * 判断一条 artifacts 条目是否应作为「相对文件路径」做存在性校验。
 * 产物的既有约定是「相对路径, commit…」——commit 描述（如
 * `edd5302 docs(decision): …` / `commit 05b3898 …`）含空白，跳过；
 * 只校验不含空白的相对路径条目。
 */
export declare function isPathArtifact(entry: string): boolean;
/**
 * 产物存在性校验：把声明为相对路径的 artifacts 逐一对照 worktree 真实文件系统，
 * 返回不存在的路径列表（空数组 = 全部真实存在）。防「幽灵产物」——会话声称
 * success 但产物根本没落盘（如旧进程曾出现的 `docs/plans/001.md` 幻影路径）。
 */
export declare function missingArtifacts(wtPath: string, artifacts: string[], exists: (wtPath: string, relPath: string) => Promise<boolean>): Promise<string[]>;
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
    feedback?: string;
}): string;
/** 解析阶段会话结构化输出；非法结构视为阶段失败。 */
export declare function parseStageResult(value: unknown): StageResult | null;
/**
 * Claim → stage chain → ledger. One instance per worker service. 领取/派发查询
 * （claim / listActionableReviews / listRetryable）由 tick 串行调用；续跑/重试
 * （runClaimed / processReviewAction / processRetryRow）可并行执行——DB 侧靠
 * 状态机（open 领取原子、waiting 记录一旦续跑即离开挂起态）保证不重复处理。
 */
export declare class WorkerPipeline {
    private readonly deps;
    constructor(deps: PipelineDeps);
    /** ①a 领取一条 open 需求（原子：for update skip locked，open → in_progress）。 */
    claim(): Promise<ClaimedRequirement | undefined>;
    /** ①b 跑一条已领取的需求（建 worktree + 阶段链）。 */
    runClaimed(claim: ClaimedRequirement): Promise<boolean>;
    /** ① 领取一条 open 需求并跑阶段链。返回是否领到并开始处理。 */
    claimAndRun(): Promise<boolean>;
    /**
     * 阶段链：按 STAGES 顺序推进；waiting/failed/terminated 时停止。
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
    }): Promise<'success' | 'waiting' | 'failed' | 'terminated' | 'deferred'>;
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
        retry?: boolean;
        feedback?: string;
    }): Promise<'success' | 'waiting' | 'failed' | 'terminated' | 'deferred'>;
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
    }): Promise<'success' | 'waiting' | 'failed' | 'terminated' | 'deferred'>;
    /**
     * 「解决冲突」任务（merge 阶段的用户按钮触发）：把任务分支与远端 main 同步
     * （fetch + merge）、解决合并冲突、commit + push。需要用户决策时不中断——
     * 一次性把问题放进结构化结果 questions → 挂 waiting_reply + ask_user_questions
     * + reply 放行单；答完 + 审核通过后由 processReviews 携答复续跑（复用同一
     * record，工作区已解决的冲突保留）。
     */
    runResolve(requirement: {
        id: string;
        title: string;
        description: string | null;
        project: ProjectView;
        wt: WorktreeHandleLike;
    }, opts?: {
        recordId?: string;
        userAnswers?: {
            question: string;
            answer: string;
        }[];
    }): Promise<'success' | 'waiting' | 'failed'>;
    /**
     * 「解决冲突」入口（审核大厅按钮 → merge Typert remote）：校验需求处于
     * `merging` → 幂等（已有 running/waiting_reply 的 resolve record 则直接返回，
     * 不重复起跑）→ 落 running record → 后台执行。返回 resolve record 列表项。
     *
     * 幂等检查与插入在同一事务内、以需求行锁（for update）串行化：并发双击/多
     * 标签页不会在同一任务分支上起跑两条 resolve 会话（会互踩 git 状态）。
     */
    startResolve(requirementId: string): Promise<RecordListItem>;
    /** 后台执行 resolve（前台 RPC 只负责起跑，不在调用里阻塞数分钟）。 */
    private runResolveInBackground;
    /** 该需求最早带 branch 的 record 的分支名（合并/续跑同一分支）；无则按约定生成。 */
    private resolveBranch;
    /**
     * ② 审核大厅轮询：处理所有挂起记录的审核单（每 tick 一次）。
     *   a. 补单：waiting_reply 无 pending reply 单 → 补一张（旧数据兼容）。
     *   b. 人工审核门通过（waiting_review + 最新 review 单 approved）→ record 置
     *      success，并从下一阶段继续。
     *   c. 待决策放行（waiting_reply + 最新 reply 单 approved + 全部作答）→ 复用
     *      record 携答复续跑（merge 阶段重跑 runMerge）。
     *   d. 驳回（最新审核单 rejected，waiting_review 或 waiting_reply）→ 复用原
     *      record 携整改意见重跑同阶段。
     *
     * 串行版：逐条处理到完成（测试与纯同步场景用）。服务端并发派发请用
     * ensureReplyTickets + listActionableReviews + processReviewAction 组合，
     * 多个已放行的记录可并行续跑（受服务端全局并发预算约束，见 cm-worker/index.ts）。
     */
    processReviews(): Promise<void>;
    /**
     * a. 补 reply 单：仅为「完全没有 reply 单」的旧 waiting_reply 数据补一张；
     *    已 approved/rejected 的最新单保持现状（重跑后再提问由 runStage 的
     *    ensureReply 补新 pending 单）。
     */
    ensureReplyTickets(): Promise<void>;
    /**
     * b/c/d. 挂起记录 + 各自最新审核单（一次 join 取齐）；仅返回已到期的
     * approved/rejected 行（pending 行本轮不动，等审核大厅决定）。
     */
    listActionableReviews(limit?: number): Promise<ReviewActionRow[]>;
    /** 处理一条已到期的审核动作：驳回重跑 / 审核门通过续跑 / reply 放行续跑。 */
    processReviewAction(row: ReviewActionRow): Promise<void>;
    /** b. 人工审核门通过：record → success，从审核门锚点的下一阶段（或 merge）继续。 */
    private continueAfterGate;
    /** c. 待决策放行：全部作答 + reply 单 approved → 复用 record 续跑。 */
    private resumeRepliedRecord;
    /** d. 驳回（带整改意见）→ 复用原 record 携反馈重跑同阶段。 */
    private rerunWithFeedback;
    /**
     * ③ 重试：复用原 record（不新开），标记「重试中」并 retry_count+1，重跑同阶段。
     * 每阶段重试次数 ≤ maxRetries（默认 10）；超限不再重试——需求停留在
     * in_progress、record 保持 failed，由面板/用户介入（不再回 open 死循环）。
     *
     * 串行版：逐条重试到完成（测试用）。服务端并发派发请用 listRetryable +
     * processRetryRow 组合（受全局并发预算约束）。
     */
    retryFailed(): Promise<void>;
    /** ③a 待重试的 failed record 列表（retry_count < maxRetries，需求仍 in_progress）。 */
    listRetryable(limit?: number): Promise<RetryRow[]>;
    /** ③b 重试一条 failed record（复用原 record）。 */
    processRetryRow(row: RetryRow): Promise<void>;
    private retryRecord;
    /**
     * ④ 收尾：用户点「已合并」→ confirmMerged（02）→ requirement done；
     * 此处对 done 且尚未清理（无 cleanup record）的需求先把主 checkout 的 main
     * 同步到远端（git pull，PR 已合并后本地 main 拿到合并提交），再清理 worktree
     * + 分支，并记一条 cleanup record 保证幂等。pull 失败不记 cleanup → 需求
     * 保持待清理，下轮 tick 重试，直到 main 同步成功（每次点「已合并」都 pull）。
     */
    finalizeMerged(): Promise<void>;
    /**
     * ⑤ 启动自愈（进程重启后一次性执行）：把上一进程遗留的死状态拉回可推进轨道。
     *
     * 背景（2026-08-16 实测）：进程若死在「某阶段 success 记账之后、下一阶段/merge
     * 记账之前」（如 review-code success 后、merge record 创建前），需求会停在
     * in_progress、最新 record 为 success、无任何 running/waiting/failed 记录——
     * 而 claim / 审核续跑 / 重试 / 收尾四条路径都看不见它 → 永久「执行中」僵尸。
     * 另有进程重启后残留的 running record（旧会话必死）同样无人收尸。
     *
     * a. markStaleRunning：把全部 status='running' 的 record 标记 failed
     *    （'进程重启，中断的会话已失效'）——重启后旧会话必死，交给 retryFailed
     *    复用同一 record 续跑（同分支/worktree，不新开 record）。
     * b. listStuckGaps：找出 in_progress 且「最新 record = 阶段 success、无任何
     *    running/waiting/failed 记录、且从未创建 merge record」的需求（缺口僵尸），
     *    配合 resumeGap 从下一阶段（或最后阶段 → 补 merge：push + PR）续跑。
     *
     * 仅在服务启动后的第一个 tick 调用（见 cm-worker/index.ts）：此时进程刚起、
     * 无任何在途会话，恢复任务不会与正常派发抢跑（避免重复 merge/重复建 PR）。
     */
    markStaleRunning(): Promise<number>;
    /**
     * ⑤b 缺口僵尸行：in_progress 需求 + 最新 record = 阶段 success（或领取后
     * 尚未落任何 record——领取与首阶段记账之间崩溃/被时段延后的竞态）+
     * 无挂起/失败 + 无 merge。
     */
    listStuckGaps(limit?: number): Promise<GapRow[]>;
    /**
     * ⑤c 续跑一条缺口僵尸：无 record（领取竞态）→ 从首阶段跑起；最后阶段
     * success → 补 merge；中途缺口 → 从下一阶段继续。
     */
    resumeGap(row: GapRow): Promise<void>;
    /** 该需求最近成功的 record artifacts（供下阶段上下文）。 */
    private priorArtifacts;
}
