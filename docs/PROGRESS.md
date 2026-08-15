# 项目进度说明（会话交接用）

> 本文件是**跨会话交接的唯一事实来源**。每次继续工作前先读这里；
> 每完成一项就把状态从「未完成」移到「已完成」并更新「最后更新」。
> 计划明细见 [`docs/plans/`](./plans/00-overview.md)（00 总览 + 01–09 分计划）。

最后更新：2026-08-15（由会话核对全部运行态后写入）

---

## 1. 项目是什么

把 `docs/coding-pipeline-automation.md`（FacAI 编码流水线 v2 方案）落地为 dsh (Cordis) 插件：

- 仓库：`/root/workspace/auto-coding-plugins`（pnpm monorepo，7 workspace 项目）
- 机制：host 插件（db-pgmas / cm-flow / cm-worker / cm-worktree）+ 浏览器插件（ui-requirements）
- 部署挂载：`~/.dsh/profiles/web/cordis.patch.yml` 追加 4 行 insert，包经
  `~/.dsh/profiles/web/node_modules/@auto-coding/*` symlink 指向本仓库 packages
- 数据：本机 pg-mas PostgreSQL 16（docker `pg-mas`，host 端口 25678），业务库 `cm`

## 2. 完成状态总览

| 项 | 状态 | 验证证据（2026-08-15 实测） |
|---|---|---|
| 01–08 代码交付（6 包） | ✅ 完成 | packages/ 下 cm-flow、cm-worker、cm-worktree、db-pgmas、ui-hello、ui-requirements 齐全 |
| 类型检查 | ✅ 绿 | `pnpm typecheck` 6 包 0 错误 |
| 单元/集成测试 | ✅ 绿 | `pnpm test` 7 文件 55/55（db-pgmas 18、cm-flow 14、cm-worktree 5、cm-worker 11、ui-requirements 5+1、ui-hello 1） |
| 挂载配置 | ✅ 就绪 | patch 四行 + 4 symlink + profile package.json link: 依赖；conversation.view 槽位可见 `requirements` tab（order 15, active） |
| cm 库迁移 | ✅ 已应用 | `_cm_flow_migrations` v1–v4；projects 有种子行 fac-ai-rs（gitee） |
| 验收门禁 #3（pg_query 只读回归） | ✅ 通过 | UPDATE 语句被只读守卫拒绝 |
| **host 侧新代码生效** | 🔴 **未完成** | 见 §3.1 |
| **端到端走查 #1–#10** | 🔴 **未执行** | 见 §3.2 |
| **验收门禁 #2 / #4** | 🔴 **未达成** | 依赖端到端走查 |
| **git 收尾** | 🟡 未提交 | 见 §3.4 |

## 3. 未完成事项（按优先级）

### 3.1 🔴 重启 `dsh web` 使 host 插件生效（第一步，必须）

- **为什么**：计划 09 明确记录「本部署禁 host 模块热重载」。当前运行实例
  （pid 2541171，12:28 启动）内存中仍是旧代码：cm-flow lib 14:39 构建、
  cm-worker lib 14:42 构建、patch 行 14:43 才加入，都晚于进程启动。
  实测 `cordis_inspect_query`（host/Service）查 `pgmas`、`cmFlow` 均报
  `no catalogued Service` —— 插件未在运行实例中生效。
- **验证方式（重启后）**：
  1. `cordis_inspect_query` host/Service 查 `pgmas`、`cmFlow` 不再报错；
  2. cm-worker 的 timer tick 开始轮询（观察 records 表出现记账行）；
  3. 需求面板 tab 的 remote 调用成功（而非报错）。
- 重启不影响数据：迁移 v1–v4 幂等，重启无碍。
- 客户端侧 ui-requirements 已热生效（无需重启），但依赖 host 的
  `requirements` / `projects` / `questions` Typert Remote，host 不重启面板功能不完整。

### 3.2 🔴 端到端走查 #1–#10（计划 09 第 4 节）

数据库现状（实测）：requirements 仅 1 条 open 测试需求（**project_id 为空**）、
records 0 条、无任何 worktree / PR 痕迹 → 走查从未执行。

| # | 步骤 | 预期 |
|---|---|---|
| 1 | 面板注册项目 fac-ai-rs（含 pr_token） | projects 落库 |
| 2 | 登记需求并「开始执行」 | open → 被领取 → in_progress，建 worktree |
| 3 | decision 阶段产 ADR 方案问题 | record waiting_reply，面板「待决策」红点 |
| 4 | 面板作答选方案 | 下轮续跑，进入 plan |
| 5 | plan → review-plan → coding(含 selfcheck) → contract → review-code 依次推进 | 每阶段一条 record，产物落 worktree |
| 6 | merge：push + 建 PR | requirement merging，PR 链接显示 |
| 7 | 在 Gitee 手动合并 | — |
| 8 | 面板点「已合并」 | requirement done，worktree/分支清理 |
| 9 | 两需求并行 | 各自 worktree/分支互不干扰 |
| 10 | kill worker 进程后重启 | 从最后 record 续跑，不重复不丢失 |

**前置清理**：删除那条 project_id 为空的测试需求（`e13048f6-…`），避免干扰领取 SQL。

### 3.3 🔴 验收门禁 #2 / #4

- 门禁 #2 = 端到端走查 #1–#10 全通过（§3.2）
- 门禁 #4 = 断点续跑 + 失败现场恢复演练（计划 09 第 6 节：
  coding 阶段 kill worker → 重启续跑；造 coding 失败 → 重试 1 次 → 超限回 open）
- 门禁 #1（typecheck+测试）、#3（只读回归）已绿

### 3.4 🟡 git 收尾

全部新代码未提交（18 个变更条目）：`docs/`（含 plans/ 与本文件）、
`packages/cm-flow/`、`packages/cm-worker/`、`packages/cm-worktree/`、
`packages/db-pgmas/`、ui-requirements 7 个新 client 文件、README 与
ui-requirements 的修改、pnpm-lock.yaml。建议完成 §3.1–3.3 后再提交。

## 4. 环境速查

| 项 | 值 |
|---|---|
| 仓库 | `/root/workspace/auto-coding-plugins` |
| dsh 进程 | pid 2541171，`node /root/workspace/deepseek-harness/apps/cli/lib/bin.js`（12:28 启动，需重启） |
| Web | 127.0.0.1:3080（webServer），0.0.0.0:3081（public gate，admin/admin123） |
| pg-mas | docker `pg-mas`，host 25678，库 mas/cm/facai；模型工具 pg_query/pg_schema 只读 |
| patch | `~/.dsh/profiles/web/cordis.patch.yml` |
| 构建/验证 | `pnpm typecheck`、`pnpm test`、`pnpm build`（host 包改动需 build 后重启） |
| 面板 dev 循环 | `pnpm watch`（client-hmr，改 client 半不需重启） |

## 5. 关键约定（来自计划 00）

- 一条 requirement = 一次完整流水线；record 记账每阶段一条；6 阶段
  decision / plan / review-plan / coding / contract / review-code / merge
- 每任务一个 git worktree + 独立分支；写库一律经 `pgmas.withClient('cm', fn)`；
  worker 不注册模型写工具；`pg_query` 保持只读
- 唯一试点项目 fac-ai-rs；pr_token 经环境变量 PR_TOKEN 注入（不进 prompt/git/records）
- 阶段会话超时默认 30min；PR 平台仅 Gitee/Gitea
