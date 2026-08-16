/**
 * cm-worktree — git worktree lifecycle manager for the coding pipeline.
 * One task = one branch + one worktree; branches are isolated (own HEAD/index/
 * worktree) while the object store is shared. Build artifacts (e.g. Rust
 * `target/`) can be shared through a symlink so dependencies compile once.
 *
 * Commands are constructed as argument arrays and executed with
 * `execFile('git', ...)` — never a shell string — and restricted to the
 * documented whitelist. This module is deliberately dsh-free so it can be
 * unit-tested against a real throwaway git repository and reused by the
 * worker and the PR agent task.
 *
 * @module @auto-coding/cm-worktree
 */
export interface WorktreeHandle {
    /** Absolute path of the task worktree. */
    path: string;
    /** Task branch, e.g. `req-<shortId>`. */
    branch: string;
    /** Base branch the task was cut from (e.g. `origin/main`). */
    base: string;
}
export interface WorktreeManagerOptions {
    /** Absolute path of the primary checkout (`project.local_path`). */
    repo: string;
    /** Root dir for task worktrees; defaults to `<repo>/../worktrees/<repoName>`. */
    worktreeRoot?: string;
}
/**
 * One task branch + worktree lifecycle. All git commands run with `-C <repo>`
 * except where a worktree-local operation needs its own cwd (push).
 */
export declare class WorktreeManager {
    readonly repo: string;
    readonly worktreeRoot: string;
    constructor(options: WorktreeManagerOptions);
    /** Absolute worktree path for a branch (regardless of existence). */
    pathFor(branch: string): string;
    /**
     * Create the task branch + worktree. Idempotent: an existing worktree at the
     * same path is returned as-is. `base` defaults to `origin/main`; the local
     * remote-tracking ref must exist (a best-effort `fetch origin` is attempted).
     */
    create(branch: string, base?: string): Promise<WorktreeHandle>;
    /**
     * Symlink the task worktree's build dir (e.g. `target`) onto the primary
     * checkout's, so dependencies compile once. No-op when either side is absent
     * or the target already exists.
     */
    linkSharedTarget(handle: WorktreeHandle, targetDir?: string): void;
    /**
     * Commit every uncommitted change in the task worktree to its branch.
     * Pipeline stages（facai-coding 等技能默认不 git commit）留下的未提交产物
     * 由流水线在阶段成功后兜底提交——否则 merge 的 push 只推已提交内容，PR 会
     * 漏掉全部代码。无改动时 no-op（返回 false）。target 等已被 .gitignore 排除。
     */
    commitAll(wtPath: string, message: string): Promise<boolean>;
    /** Push the task branch to the remote (run inside the worktree). */
    push(handle: WorktreeHandle, remote?: string): Promise<void>;
    /** Whether the task branch is fully merged into `target` (e.g. origin/main). */
    isMerged(handle: WorktreeHandle, target?: string): Promise<boolean>;
    /** Post-merge teardown: remove the worktree dir and delete the local branch. */
    remove(handle: WorktreeHandle): Promise<void>;
    /**
     * Post-merge sync: switch the primary checkout onto `main` and pull, so the
     * merged PR lands in the local main branch. `--ff-only` keeps the sync strict
     * — a diverged local main fails loudly instead of fabricating a merge commit.
     */
    pullMain(branch?: string): Promise<void>;
    /** Run git synchronously with args; cwd defaults to the primary checkout. */
    private git;
}
