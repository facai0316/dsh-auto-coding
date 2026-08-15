# 09 · 测试策略与端到端验收

> 状态：实施完成（01-08 全绿）。本文档含实施后实际记录与重启后走查清单。

## 0. 实施后实际记录（goal round 9）

- 全仓 7 包 `pnpm typecheck` 0 错误；`pnpm test` 55/55 全绿
- 单测/集成分布：db-pgmas 18（含 withClient）、cm-flow 14（迁移/projects/questions/状态机/阶段折叠/流水线状态链）、cm-worktree 5（真 git 仓库往返/并行隔离）、cm-worker 11（领取/全链/挂起/续跑/重试/超限/merge/收尾/PR 契约）、ui-requirements 5（remote 契约）
- 挂载就绪：`cordis.patch.yml` 已含 db-pgmas / cm-flow / ui-requirements / **cm-worker** 四行；profile `node_modules/@auto-coding/` 四个 symlink；profile package.json 登记 link: 依赖
- **重启前提**：host 侧（db-pgmas/cm-flow/cm-worker）代码在运行实例内存中仍是旧版（本部署禁 host 模块热重载），**需重启 `dsh web` 使全部新代码生效**；迁移 v2-v4 已由测试在真实 cm 库幂等执行，重启无碍



## 1. 测试分层

| 层 | 位置 | 覆盖 |
|---|---|---|
| 单元 | 各包 `tests/*.test.ts` | 状态机、worktree 命令构造、zod codec、prompt 组装 |
| 集成（真库） | cm-flow / cm-worker `tests/` | 迁移、repo 方法、领取/记账/续跑 SQL |
| 端到端 | 手动走查 + 脚本 | 面板 → worker → 会话 → 库 → PR → 收尾 |

## 2. 单元测试清单

### cm-flow（`tests/cm-flow.test.ts` 扩展）
- `assertStatus`/`canTransition` 覆盖 merging 边（in_progress→merging→done/cancelled；done→open 拒绝）
- ProjectsRepo：create 唯一性冲突、platform 校验、hasToken 不回传明文
- QuestionsRepo：insertMany / pendingByRecord / answer 幂等
- confirmMerged：非 merging 状态拒绝

### cm-worktree（`tests/worktree.test.ts`）
- 用临时 git 仓库：create/push/remove/isMerged/linkSharedTarget 往返
- 命令构造无 shell 注入（断言参数数组，不含 `;`/`&&`）

### ui-requirements（`tests/remote.test.ts` 扩展）
- 三 namespace descriptor 对齐（requirements/projects/questions 方法签名与 02 wire 契约一致）
- 可选参数 codec（`projectId?`/`prToken?`/`description?`）用 `.optional()`，`parse(undefined)` 通过

### cm-worker（`tests/worker.test.ts`）
- buildPrompt：含 SKILL.md 全文 + 工作根目录 + 需求 + 续跑答复
- StageResult/PrResult schema 对样例值 parse 通过

## 3. 真库集成测试清单

- 迁移幂等：重跑不报错；`_cm_flow_migrations` 版本 1..4
- 领取 SQL：造 2 条 open，`skip locked` 领取一条且置 in_progress
- 记账：appendRecord/updateRecord 字段映射正确（category/status/artifacts/parent_id）
- 续跑：waiting_reply + 全 answered 的 record 被 resumeWaiting 捞出
- 状态机：draft→open→in_progress→merging→done 全链；非法流转抛错

## 4. 端到端验收脚本（手动走查）

| # | 步骤 | 预期 |
|---|---|---|
| 1 | 面板注册项目 fac-ai-rs（含 pr_token） | projects 落库 |
| 2 | 登记需求并「开始执行」 | open → 被领取 → in_progress，建 worktree |
| 3 | decision 阶段产 ADR 方案问题 | record waiting_reply，面板「待决策」红点 |
| 4 | 面板作答选方案 | 下轮续跑，进入 plan |
| 5 | plan → review-plan → coding(含 selfcheck) → contract → review-code 依次推进 | 每阶段一条 record，产物落 worktree |
| 6 | merge：push + 建 PR | requirement merging，PR 链接显示 |
| 7 | 你在 Gitee 手动合并 | — |
| 8 | 面板点「已合并」 | requirement done，worktree/分支清理 |
| 9 | 两需求并行 | 各自 worktree/分支互不干扰 |
| 10 | kill worker 进程后重启 | 从最后 record 续跑，不重复不丢失 |

## 5. 回归护栏

- `pnpm typecheck`（4 包）+ `pnpm test` 全绿
- `pg_query` 只读守卫仍拒绝写（回归：写 SQL 被拒）
- `pgmas.withClient` 服务级写缝仍可用（cm-flow/cm-worker 依赖）

## 6. 回滚与恢复演练

- 迁移回滚：手动 drop v2-v4 对象 → 重跑迁移重建
- 断点续跑：在 coding 阶段 kill worker → 重启 → 从 coding record 续跑
- 失败现场：造一个 coding 失败 → 重试 1 次 → 超限回 open → worktree 保留且 artifacts 记 wt+commit

## 7. 验收门禁（全部通过才算完成）

1. 四包 typecheck + 全量测试绿
2. 端到端走查 #1–#10 全通过
3. `pg_query` 只读回归通过
4. 断点续跑 + 失败现场恢复演练通过
