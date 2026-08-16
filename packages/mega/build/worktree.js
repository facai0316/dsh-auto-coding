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
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, symlinkSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
function defaultWorktreeRoot(repo) {
    return join(dirname(repo), 'worktrees', basenameOf(repo));
}
function basenameOf(repo) {
    const name = repo.split(/[\\/]/).filter(Boolean).pop() ?? 'repo';
    return name.replace(/\.git$/, '');
}
/**
 * One task branch + worktree lifecycle. All git commands run with `-C <repo>`
 * except where a worktree-local operation needs its own cwd (push).
 */
export class WorktreeManager {
    repo;
    worktreeRoot;
    constructor(options) {
        this.repo = resolve(options.repo);
        this.worktreeRoot = resolve(options.worktreeRoot ?? defaultWorktreeRoot(this.repo));
    }
    /** Absolute worktree path for a branch (regardless of existence). */
    pathFor(branch) {
        return join(this.worktreeRoot, branch);
    }
    /**
     * Create the task branch + worktree. Idempotent: an existing worktree at the
     * same path is returned as-is. `base` defaults to `origin/main`; the local
     * remote-tracking ref must exist (a best-effort `fetch origin` is attempted).
     */
    async create(branch, base = 'origin/main') {
        const path = this.pathFor(branch);
        if (existsSync(path)) {
            return { path, branch, base };
        }
        mkdirSync(this.worktreeRoot, { recursive: true });
        // Best effort: keep origin/main fresh. Failure is tolerable when the ref
        // already exists locally; the worktree add below reports the real error.
        try {
            this.git(['fetch', 'origin', '--quiet']);
        }
        catch { /* best effort */ }
        this.git(['worktree', 'add', path, '-b', branch, base]);
        return { path, branch, base };
    }
    /**
     * Symlink the task worktree's build dir (e.g. `target`) onto the primary
     * checkout's, so dependencies compile once. No-op when either side is absent
     * or the target already exists.
     */
    linkSharedTarget(handle, targetDir = 'target') {
        const wtTarget = join(handle.path, targetDir);
        const repoTarget = join(this.repo, targetDir);
        if (existsSync(wtTarget))
            return;
        if (!existsSync(repoTarget))
            return;
        symlinkSync(relative(dirname(wtTarget), repoTarget), wtTarget, 'dir');
    }
    /**
     * Commit every uncommitted change in the task worktree to its branch.
     * Pipeline stages（facai-coding 等技能默认不 git commit）留下的未提交产物
     * 由流水线在阶段成功后兜底提交——否则 merge 的 push 只推已提交内容，PR 会
     * 漏掉全部代码。无改动时 no-op（返回 false）。target 等已被 .gitignore 排除。
     */
    async commitAll(wtPath, message) {
        this.git(['add', '-A'], wtPath);
        // diff --cached --quiet 退出码 0 = 无暂存改动（no-op）；非 0 = 有改动（提交）。
        try {
            this.git(['diff', '--cached', '--quiet'], wtPath);
            return false;
        }
        catch {
            this.git(['commit', '-m', message], wtPath);
            return true;
        }
    }
    /** Push the task branch to the remote (run inside the worktree). */
    async push(handle, remote = 'origin') {
        this.git(['push', '-u', remote, handle.branch], handle.path);
    }
    /** Whether the task branch is fully merged into `target` (e.g. origin/main). */
    async isMerged(handle, target = 'origin/main') {
        const stdout = this.git(['branch', '--merged', target]);
        // 行首 `*`（当前 HEAD）/`+`（某 worktree 的 HEAD）是展示标记，剥离后比较
        return stdout.split('\n').some(line => line.trim().replace(/^[*+]\s*/, '') === handle.branch);
    }
    /** Post-merge teardown: remove the worktree dir and delete the local branch. */
    async remove(handle) {
        this.git(['worktree', 'remove', '--force', handle.path]);
        this.git(['branch', '-D', handle.branch]);
    }
    /**
     * Post-merge sync: switch the primary checkout onto `main` and pull, so the
     * merged PR lands in the local main branch. `--ff-only` keeps the sync strict
     * — a diverged local main fails loudly instead of fabricating a merge commit.
     */
    async pullMain(branch = 'main') {
        this.git(['checkout', branch]);
        this.git(['pull', '--ff-only']);
    }
    /** Run git synchronously with args; cwd defaults to the primary checkout. */
    git(args, cwd) {
        try {
            return execFileSync('git', ['-C', cwd ?? this.repo, ...args], {
                maxBuffer: 16 * 1024 * 1024,
                encoding: 'utf8',
            });
        }
        catch (error) {
            const err = error;
            const detail = err.stderr ?? err.message;
            throw new Error(`git ${args.join(' ')} 失败: ${String(detail).trim()}`);
        }
    }
}
