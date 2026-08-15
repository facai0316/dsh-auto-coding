# 06 · PR 创建（merge 阶段 agent 任务）

> 前置：03（worktree）、04（阶段会话）。方案 §8 落地。
> 目标：`push` 分支后由 agent 任务建 PR，返回 `{is_ok, pr_url}`；worker 解析后置 `merging`。

## 1. 流程（runMerge，04 已引用）

```
1. WorktreeManager.push(wt)                    # git push -u origin req-<id>
2. 读 project.platform / pr_token
3. 若 pr_token 缺失 → record merge='waiting_reply' + question「请到面板项目管理补填 PR token」→ 返回
4. 起 PR agent 任务（subagents.start + PrResult schema）
5. 解析 result.structured：
   is_ok=true  → requirementsRepo.markMerging(id, pr_url)   # in_progress→merging，记 merge record(artifacts=[pr_url])
   is_ok=false → record merge='waiting_reply' + question(error，附「手动建 PR 后点已合并」)
```

## 2. PR 任务 prompt（指导指令核心）

```
你是 PR 创建任务，只做一件事：把当前分支创建为 Pull Request，返回 JSON。

# 工作根目录
{wt.path}

# 步骤
1. git -C {wt.path} remote get-url origin  → 取 host
2. 判断平台：host 含 "gitee.com" → Gitee；否则 → Gitea
3. 解析 owner/repo：
   git@gitee.com:o/r.git   → owner=o, repo=r
   https://host/o/r.git    → owner=o, repo=r
4. 建 PR（用环境变量 $PR_TOKEN）：
   Gitee: POST https://gitee.com/api/v5/repos/{owner}/{repo}/pulls
   Gitea: POST https://<host>/api/v1/repos/{owner}/{repo}/pulls
   header:  Authorization: token $PR_TOKEN
   body:    { "title": "{需求标题}", "head": "{wt.branch}", "base": "main",
              "body": "{需求描述 + 阶段摘要}" }
5. 返回 JSON（唯一契约）：
   成功：{"is_ok":"true","pr_url":"<PR 链接>"}
   失败：{"is_ok":"false","error":"<原因>"}
```

## 3. PrResult schema

```ts
const PR_RESULT_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    is_ok: { type: 'boolean', required: true },
    pr_url: { type: 'string' },
    error: { type: 'string' },
  },
}
```

> 字段名严格 `is_ok`/`pr_url`/`error`；`is_ok` 为字符串 `"true"` 时按真处理（agent 可能返回字符串，worker 兼容 `String(v)==='true'`）。

## 4. token 注入

- `pr_token` 从 `projects` 表读（02 `getToken`）
- 以 bash 环境变量 `PR_TOKEN` 注入 PR 会话（`subagents.start` 无 env 字段时，通过 prompt 声明「$PR_TOKEN 已存在于你的 shell 环境」；实现时验证环境变量注入通道，退路是让 agent 用 `git -c` 或 curl 时从 shell 读）
- token 不进 prompt 正文、不进 git、不进 records

## 5. merging 收尾（④ finalizeMerged，04 已引用）

```
面板「已合并」→ requirements.confirmMerged(id)（02：merging→done，记 merge record success）
worker 下轮 tick：发现 done 且存在对应 worktree → WorktreeManager.remove(wt)（删分支+目录）
```

## 6. 失败降级

- `pr_token` 缺失 / `is_ok=false` → record merge=`waiting_reply` + question，附错误或提示
- 用户作答（补 token / 手动建 PR 后确认）→ 续跑（05）重试建 PR 或跳过建 PR 直接 `markMerging(手动 pr_url)`

## 7. 实现步骤

1. `runMerge`：push → token 检查 → PR 会话（PrResult schema + 指导指令）
2. `markMerging`（02）+ `confirmMerged`（02）+ `finalizeMerged`（worktree remove）
3. 真机测试：临时分支 → PR 会话建 Gitee PR → 解析 pr_url → merging → confirmMerged → done → worktree 清理

## 8. 验收

- fac-ai-rs 一个任务分支被 push 且成功建 PR，pr_url 记入 merge record，requirement 进入 merging
- Gitee/Gitea 由 host 正确判断；token 缺失降级为 waiting_reply 提示补填
- 面板「已合并」→ done；worktree/分支清理干净
