# 03 · worktree 生命周期封装

> 前置：02（需写库）；与 02 可并行。新包 `packages/cm-worktree`（host-only，纯 Node，无 cordis 依赖可选）。
> 目标：把「每任务一分支一 worktree」的 git 操作封装成可复用模块，供 worker（04/06）调用。

## 1. 决策

- 独立包 `@auto-coding/cm-worktree`，导出纯函数/类 `WorktreeManager`，**不依赖 cordis**（便于单测、便于 PR agent 任务复用）。
- 命令全部 `git -C <repo> …` 形式，命令白名单内置，不暴露给模型。
- 分支命名：`req-<requirement 前 8 位>`；worktree 目录：`<local_path>/../worktrees/<project>/req-<短id>/`。

## 2. 目录布局

```
<project.local_path>                      # 主 checkout（主分支 checkout 于此）
<local_path>/../worktrees/<project>/      # worktree 根（默认，可配置）
  └── req-<短id>/                         # 任务 worktree
```

## 3. API

```ts
export interface WorktreeHandle {
  path: string          // 绝对 worktree 路径
  branch: string        // req-<短id>
  base: string          // 派生基线（origin/main）
}

export class WorktreeManager {
  constructor(opts: { repo: string; worktreeRoot?: string })   // repo = project.local_path

  /** 领取任务时：为需求创建分支 + worktree */
  async create(branch: string, base = 'origin/main'): Promise<WorktreeHandle>
    // git -C <repo> fetch origin (仅需 base 分支存在时)
    // git -C <repo> worktree add <root>/<branch> -b <branch> <base>
    // 校验目录已就绪

  /** 建软链共享 target（Rust）：wt/target → repo/target（若存在） */
  async linkSharedTarget(handle: WorktreeHandle, targetDir = 'target'): Promise<void>
    // 若 <repo>/target 存在且 <wt>/target 不存在 → ln -s 相对路径

  /** 提交任务分支当前改动（阶段间，由阶段会话自身 git 提交，此处仅提供收尾提交） */
  async push(handle: WorktreeHandle, remote = 'origin'): Promise<void>
    // git -C <wt> push -u <remote> <branch>

  /** PR 合并后收尾：删本地分支 + 移 worktree */
  async remove(handle: WorktreeHandle): Promise<void>
    // git -C <repo> worktree remove --force <path>
    // git -C <repo> branch -D <branch>

  /** 判断分支是否已合并（收尾校验，可选） */
  async isMerged(handle: WorktreeHandle, target = 'origin/main'): Promise<boolean>
    // git -C <repo> branch --merged <target> | grep <branch>
}
```

## 4. 关键命令与安全

| 动作 | 命令 | 说明 |
|---|---|---|
| 创建 | `git -C <repo> worktree add <wt> -b <branch> <base>` | base 用 `origin/main`（先 `fetch`） |
| 共享 target | `ln -s <repo>/target <wt>/target` | 已存在则跳过；软链避免重复编译 |
| push | `git -C <wt> push -u origin <branch>` | wt 内 HEAD 即分支 |
| 收尾 | `git -C <repo> worktree remove --force <wt>` + `branch -D` | 已合并后安全删除 |

- 命令字符串由 manager 内部构造（`child_process.execFile('git', args)`，不用 shell 拼接，防注入）。
- 失败抛出含 stderr 的错误，worker 捕获转 `failed`/`waiting_reply`。

## 5. 并发隔离要点（写入实现注释）

- 每任务独立 `branch` + `worktree`，HEAD/索引/工作区互不干扰 → 运行期零冲突
- 冲突只发生在远端 PR 合并期，由平台暴露（06 降级）
- `target` 软链共享：cargo 对同一 target 有文件锁，并发编译自动排队（正确性由 cargo 保证）

## 6. 实现步骤

1. `packages/cm-worktree/` 包骨架（package.json/tsconfig/tsdown；纯 Node，无 dsh peer）
2. `src/index.ts`：`WorktreeManager` + `execFile` 封装 + 错误处理
3. 单测（真库 fak-ai-rs 或临时 git 仓库）：create/push/remove/isMerged/linkSharedTarget 往返
4. 验证两分支并行：两 worktree 各自 `git status`/改文件互不影响

## 7. 验收

- create → push → remove 全流程真机跑通；remove 后 worktree 目录与分支清理干净
- target 软链创建幂等；两 worktree 并行改各自文件无串扰
- 命令白名单：无 shell 拼接、无 `rm -rf`、无裸 `git clean`
