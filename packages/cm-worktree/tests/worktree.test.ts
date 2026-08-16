import { afterAll, describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync, readlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { WorktreeManager } from '../src/index.ts'

const exec = promisify(execFile)

async function git(repo: string, args: string[]): Promise<string> {
  const { stdout } = await exec('git', ['-C', repo, ...args])
  return stdout.toString()
}

interface Fixture {
  root: string
  repo: string
  manager: WorktreeManager
}

async function makeFixture(): Promise<Fixture> {
  const root = mkdtempSync(join(tmpdir(), 'cm-worktree-'))
  const remote = join(root, 'remote.git')
  const repo = join(root, 'main')
  await exec('git', ['init', '--bare', '-q', remote])
  await exec('git', ['clone', '-q', remote, repo])
  await git(repo, ['config', 'user.email', 'test@local'])
  await git(repo, ['config', 'user.name', 'test'])
  // 空仓库 clone 后分支名可能非 main；强制命名避免 push 时 refspec 不匹配
  await git(repo, ['branch', '-M', 'main'])
  writeFileSync(join(repo, 'main.txt'), 'base\n')
  writeFileSync(join(repo, '.gitignore'), '/target\n')
  await git(repo, ['add', '.'])
  await git(repo, ['commit', '-q', '-m', 'base'])
  await git(repo, ['push', '-q', '-u', 'origin', 'main'])
  return { root, repo, manager: new WorktreeManager({ repo }) }
}

const fixtures: Fixture[] = []
afterAll(async () => {
  for (const fixture of fixtures) {
    try {
      await exec('rm', ['-rf', fixture.root])
    } catch { /* best effort */ }
  }
})

describe('WorktreeManager against a real throwaway repository', () => {
  let fixture: Fixture

  it('creates an isolated worktree + branch per task', async () => {
    fixture = await makeFixture()
    fixtures.push(fixture)
    const a = await fixture.manager.create('req-aaa', 'origin/main')
    expect(existsSync(join(a.path, '.git'))).toBe(true)
    // `branch --list` 对当前 worktree HEAD 分支输出带 `+` 前缀
    expect((await git(fixture.repo, ['branch', '--list', 'req-aaa'])).trim().replace(/^\+\s*/, '')).toBe('req-aaa')
  })

  it('two worktrees do not interfere at runtime', async () => {
    const b = await fixture.manager.create('req-bbb', 'origin/main')
    writeFileSync(join(b.path, 'only-b.txt'), 'b\n')
    await git(b.path, ['add', '.'])
    await git(b.path, ['commit', '-q', '-m', 'b change'])
    // worktree A is untouched by worktree B's change
    const statusA = await git(fixture.manager.pathFor('req-aaa'), ['status', '--porcelain'])
    expect(statusA).toBe('')
    // main checkout untouched too
    expect(await git(fixture.repo, ['status', '--porcelain'])).toBe('')
  })

  it('links a shared target dir via symlink (idempotent)', () => {
    mkdirSync(join(fixture.repo, 'target'), { recursive: true })
    writeFileSync(join(fixture.repo, 'target', 'cache'), 'x')
    const a = fixture.manager.pathFor('req-aaa')
    fixture.manager.linkSharedTarget({ path: a, branch: 'req-aaa', base: 'origin/main' })
    expect(existsSync(join(a, 'target', 'cache'))).toBe(true)
    expect(readlinkSync(join(a, 'target'))).toBeTruthy()
    // idempotent: second call no-ops (target exists)
    fixture.manager.linkSharedTarget({ path: a, branch: 'req-aaa', base: 'origin/main' })
    expect(readlinkSync(join(a, 'target'))).toBeTruthy()
  })

  it('pushes the task branch to the remote', async () => {
    const b = { path: fixture.manager.pathFor('req-bbb'), branch: 'req-bbb', base: 'origin/main' }
    await fixture.manager.push(b)
    const remoteBranches = await git(fixture.repo, ['ls-remote', '--heads', 'origin'])
    expect(remoteBranches).toContain('refs/heads/req-bbb')
  })

  it('commitAll commits every uncommitted change and no-ops when clean', async () => {
    const aPath = fixture.manager.pathFor('req-aaa')
    // 干净 → no-op（不产生空提交）
    expect(await fixture.manager.commitAll(aPath, 'chore: noop')).toBe(false)
    // 有改动（含新增 + 修改）→ 一次 commit 全量落盘到任务分支
    writeFileSync(join(aPath, 'new.txt'), 'n\n')
    writeFileSync(join(aPath, 'main.txt'), 'base\n+change\n')
    expect(await fixture.manager.commitAll(aPath, 'chore: pipeline stage artifacts')).toBe(true)
    expect((await git(aPath, ['log', '--oneline', '-1'])).trim()).toContain('chore: pipeline stage artifacts')
    expect(await git(aPath, ['status', '--porcelain'])).toBe('')
    // 提交后再跑 → no-op
    expect(await fixture.manager.commitAll(aPath, 'chore: again')).toBe(false)
  })

  it('reports merged state and removes the worktree + branch after merge', async () => {
    const b = { path: fixture.manager.pathFor('req-bbb'), branch: 'req-bbb', base: 'origin/main' }
    expect(await fixture.manager.isMerged(b)).toBe(false)
    // simulate PR merge: merge the branch into main and push (origin/main moves)
    await git(fixture.repo, ['merge', '-q', '--no-ff', 'req-bbb', '-m', 'merge req-bbb'])
    await git(fixture.repo, ['push', '-q', 'origin', 'main'])
    expect(await fixture.manager.isMerged(b)).toBe(true)

    await fixture.manager.remove(b)
    expect(existsSync(b.path)).toBe(false)
    expect((await git(fixture.repo, ['branch', '--list', 'req-bbb'])).trim()).toBe('')
  })

  it('pullMain fast-forwards the primary checkout main after a remote merge', async () => {
    // Simulate a PR merge landing on the remote from a second clone: the primary
    // checkout's local main is now behind origin/main.
    const second = join(fixture.root, 'second')
    await exec('git', ['clone', '-q', join(fixture.root, 'remote.git'), second])
    await git(second, ['config', 'user.email', 'test@local'])
    await git(second, ['config', 'user.name', 'test'])
    // bare 仓库 HEAD 未指向 main → clone 落在 detached HEAD；显式建 main 分支
    await git(second, ['checkout', '-b', 'main', 'origin/main'])
    writeFileSync(join(second, 'from-remote.txt'), 'r\n')
    await git(second, ['add', '.'])
    await git(second, ['commit', '-q', '-m', 'remote merge commit'])
    await git(second, ['push', '-q', 'origin', 'main'])

    const before = await git(fixture.repo, ['rev-parse', 'HEAD'])
    // 刷新主 checkout 的 origin/main tracking ref，才能与真实远端比较
    await git(fixture.repo, ['fetch', '-q', 'origin', 'main'])
    const remoteHead = await git(fixture.repo, ['rev-parse', 'origin/main'])
    expect(before).not.toBe(remoteHead)

    await fixture.manager.pullMain()
    expect(await git(fixture.repo, ['rev-parse', 'HEAD'])).toBe(remoteHead)
    expect(await git(fixture.repo, ['status', '--porcelain'])).toBe('')
    // worktree 不受影响（仍独立检出）
    expect(existsSync(fixture.manager.pathFor('req-aaa'))).toBe(true)
  })
})