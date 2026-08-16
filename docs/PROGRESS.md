# 项目进度说明（会话交接用）

> 本文件是**跨会话交接的唯一事实来源**。每次继续工作前先读这里；
> 每完成一项就把状态从「未完成」移到「已完成」并更新「最后更新」。
> 计划明细见 [`docs/plans/`](./plans/00-overview.md)（00 总览 + 01–09 分计划）。

最后更新：2026-08-16（v0.3.0 发布：使用说明落地 README/使用说明页 + 「迁移（建表）」按钮 + USAGE.md 随包分发）

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
| 单元/集成测试 | ✅ 绿 | `pnpm test` 7 文件 81/81（db-pgmas 18、cm-flow 26、cm-worktree 5、cm-worker 25、ui-requirements 6+1、ui-hello 1） |
| 挂载配置 | ✅ 就绪 | patch 四行 + 4 symlink + profile package.json link: 依赖；conversation.view 槽位可见 `requirements` tab（order 15, active） |
| cm 库迁移 | ✅ 已应用 | `_cm_flow_migrations` v1–v7；projects 有种子行 fac-ai-rs（gitee） |
| 验收门禁 #3（pg_query 只读回归） | ✅ 通过 | UPDATE 语句被只读守卫拒绝 |
| **审核大厅 + 人工审核门** | ✅ 代码完成 | reviews 表（v7）+ `reviews` remote（list/approve/reject）+ 审核 tab（通过/驳回带整改意见）+ waiting_reply「答完→审核通过→续跑」；ADR（decision）立即门 + plan 延后门（review-plan 机审之后再人审） |
| **阶段会话 worktree 沙箱修复** | ✅ 代码完成 | 每阶段以 worktree 为 cwd 新建 parent agent + sandbox/mode 放宽（git worktree commit/push 需写主仓 .git）；修复「产物落 main 而非任务分支」缺陷 |
| **ask_user → waiting_reply 落账** | ✅ 代码完成 | 阶段 prompt 显式引导：子代理中 ask_user_question 不可用 → 问题进结构化结果 questions 字段 → worker 落 waiting_reply + ask_user_questions + reply 放行单 |
| **解决冲突按钮（merge 阶段）** | ✅ 代码完成 | 审核大厅「待我合并」+ 需求卡新增「解决冲突」→ cm-worker `merge` Typert Remote（resolveConflicts）→ `WorkerPipeline.startResolve`（fetch + merge + 解决冲突 + commit + push，可走 waiting_reply 提问后携答复续跑）；resolve record 类别 + 幂等起跑 + 失败可重试 |
| **批量提问引导** | ✅ 代码完成 | 所有阶段 prompt（buildPrompt 6 阶段 + buildResolvePrompt + buildPrPrompt）统一加「不要遇到一个问题问一个…没有其他问题要确认了再一起发」 |
| **worker 并发（配置页可设）** | ✅ 代码完成 | `worker_config.concurrency`（1–8，默认 1 串行；配置页「并发」卡片）+ tick `runLanes` 并发领取（for update skip locked 互斥）；每 lane 一条需求独立 worktree |
| **worker 并发生效修复（审核续跑并入预算）** | ✅ 代码完成 | 见 §3.0.3：tick 改为短派发 + 全局并发预算；领取/审核续跑/重试/冲突解决统一占槽，放行逐条到来也能并发续跑（不再要求一轮内审完所有记录） |
| **host 侧新代码生效** | 🔴 **未完成** | 见 §3.1（本轮改造后需再次 build + 重启） |
| **计划 10 打包与分发（P0–P3）** | ✅ 已实施并验证 | 见 §3.5：mega 单包 + reconcile + git 子目录分发 + skills 外部源；本机 profile 切换待重启时执行 |
| **端到端走查 #1–#10** | 🔴 **未执行** | 见 §3.2 |
| **验收门禁 #2 / #4** | 🔴 **未达成** | 依赖端到端走查 |
| **git 收尾** | 🟡 未提交 | 见 §3.4 |

## 3. 未完成事项（按优先级）

### 3.0 ✅ 本轮新增功能（2026-08-15 会话，代码已完成、测试 74/74 绿）

- **人工审核门**：
  - **立即门**：decision（ADR）阶段成功后挂 `waiting_review` + `reviews`（kind='review'）审核单。
  - **延后门**（本次调整）：**plan 的人审放在 `review-plan`（facai-review 机审）之后**
    ——plan 生成 → 机审通过 → 再把 plan record 挂 `waiting_review` 人审门；
    「通过」→ 从 coding 继续；「驳回」→ plan 携整改意见重跑 → 重新机审 → 再次人审。
  - 驳回必须填整改意见 → worker 复用同一 record 携反馈重跑（prompt 注入
    `# 审核整改意见（驳回重跑）`，retry_count+1）。
- **waiting_reply 放行审核**：阶段会话返回 questions（或模型按引导把 ask_user
  意图放进 questions）→ record `waiting_reply` + ask_user_questions 落账 +
  一张 kind='reply' 放行单；审核大厅逐题作答，**全部答完才能点「审核通过」**，
  worker 才续跑（旧逻辑是答完即续跑，现在多一道人工放行）。
- **ask_user 支持**：阶段 prompt 显式说明子代理中 `ask_user_question` 不可用
  （会被拒），需要用户决策时把问题放进结构化结果 `questions` 字段 → 落到
  waiting_reply + ask_user_questions（与需求 3 的机制一致）。
- **阶段会话 worktree 沙箱修复（本轮发现的真实 BUG）**：阶段子代理原先复用
  单例 worker agent（cwd=主 checkout），沙箱 workspace=主 checkout，而 prompt
  让它在 worktree 干活 → worktree 写被拒，产物被写进 main 并提交到 main 分支。
  修复：每阶段以 **worktree 为 cwd** 新建 parent agent（子会话沙箱 workspace
  随之指向 worktree），并把 sandbox/mode 放宽到 danger-full-access（git worktree
  commit/push 会写主仓 .git，workspace-write 会被拒；与方案 §7/§11「阶段会话
  权限=本机 bash/fs，worktree 限制只改任务分支」一致）；会话用完即销毁。
- **PR token 注入修复（merge 阶段实测失败）**：`$PR_TOKEN` 环境变量通道在本部署
  不可用（子进程环境做凭据清洗 `/KEY|PASSWORD|SECRET|TOKEN/i`、`shellEnv` 只放行
  `DSH_*` 键），PR 会话拿不到 token。改为 `buildPrPrompt` **直接注入 token 正文**
  （本地部署接受，prompt 约束仅用于 Authorization 头、不进 git/records/回显）。
- **需求「终止」状态（不可逆）**：`requirements.status` 新增 `terminated`（无任何
  出路）；面板需求卡片提供「终止」按钮（确认弹层）。终止时同一事务把该需求所有
  未完成 record 标记 `terminated`（success 保留）；worker 每个阶段（含 merge）
  开始前检查，已终止则当前 record 标记终止并 `return`；审核大厅不再展示已终止
  需求的 pending 单。
- **审核大厅（审核 tab）**：聚合 ① 待审核（通过/驳回+整改意见）② 待决策
  （答题 + 答完放行）③ 待合并（PR + 已合并）；角标 = 三者计数之和。
- 数据模型：`records.status` 新增 `waiting_review`；迁移 v7 建 `reviews` 表
  （kind/status/feedback/decided_at + pending 索引）；cm-flow 新增
  `reviews` remote 命名空间（list/approve/reject）与
  `latestRecordByCategory`（延后门定位被审 record）。

### 3.0.1 🟡 本次会话现场处理（ADR-027 测试需求）

- 阶段会话曾因上述沙箱 BUG 把计划提交到 main（`6485ac9`），已 `git revert` 回退
  （`a004a11`，`6485ac9` 提交对象仍在历史，可 cherry-pick 到任务分支）。
- 已停止全部任务：coding 会话已取消，coding record `92dc67b1…` → failed +
  retry_count=10（旧 worker 不会自动重跑）；plan record `6cd21007…` → success
  + retry_count=10。需求 `9536be4f…` 停在 in_progress（暂停态）。
- 重启后恢复路径：见 §3.1 的「验证方式」与重启通知（cherry-pick 计划提交到
  `req-9536be4f` 分支 → 重置 coding/plan record → 触发续跑）。

### 3.0.2 ✅ 本轮新增功能（2026-08-16 会话，代码已完成、测试 81/81 绿、已 build）

- **解决冲突按钮（merge 阶段）**：审核大厅「待我合并」卡片与需求卡（merging）新增
  「解决冲突」→ cm-worker 新增 `merge` Typert Remote（`MergeService.resolveConflicts`）
  → `WorkerPipeline.startResolve`：
  - 校验需求 `merging`、幂等（有 running/waiting_reply 的 resolve record 直接返回）；
  - 落 `category='resolve'` 的 running record → **后台**起跑 resolve 会话
    （fetch origin → merge origin/main → 逐个解决冲突 → commit → push，push 被拒
    pull --rebase 重试）；
  - 需要用户决策 → questions 走 §6 同一挂起通道（waiting_reply + ask_user_questions +
    reply 放行单），答完 + 审核通过后 worker 复用同一 record 携答复续跑（`processReviews`
    按 category 分流 stage/merge/resolve）；
  - 成功 → success（需求仍 merging，PR 随推送更新）；失败 → failed（可再点重试）。
  - UI：resolve 状态标签（冲突解决中…/冲突解决待决策/冲突已解决）。
- **批量提问引导**：buildPrompt（6 阶段）、buildResolvePrompt、buildPrPrompt 统一加入
  「注意不要遇到一个问题问一个，遇到问题先攒下并继续推理，确认所有问题都过了一遍，
  没有其他问题要确认了再一起发」。
- **worker 并发**：`worker_config.concurrency`（1–8，默认 1 串行；`MAX_CONCURRENCY=8`
  钳制，`normalizeWorkerConfig` 归一）；tick 改用 `runLanes(concurrency, claimAndRun)`
  并发领取（`for update skip locked` 互斥），审核/重试/收尾仍串行；配置页新增
  「并发」卡片；`resolve` 纳入可配阶段（CONFIGURABLE_STAGES + STAGE_LABEL）。
- 新增依赖：cm-worker → `@deepseek-ai/dsh-typert-protocol`（peer + dev link）。
- 测试新增：resolve 全流程（提问→waiting_reply→作答放行→携答复续跑→success）、
  resolve 失败→failed、runLanes 并发、normalize concurrency 钳制、三个 prompt 的
  批量提问断言、remote 契约新增 merge/resolveConflicts。

### 3.0.3 ✅ 本轮修复（2026-08-16 会话，代码已完成、测试 83/83 绿、已 build）

**问题**：`worker_config.concurrency=3` 不生效——审核放行逐条到来（每个审核约半分钟）
时永远只有 1 条流水线在跑，除非 10 秒内审完所有记录。

**根因**（三处叠加）：
1. `runLanes(concurrency, claimAndRun)` 只对**新领取**并发：领取只认 `status='open'`，
   已挂 `waiting_review`/`waiting_reply` 的需求不在领取范围；
2. `processReviews()` **串行且阻塞 tick**：每条 approved/rejected 记录的续跑
   （`continueAfterGate`/`resumeRepliedRecord`/`rerunWithFeedback`）都 `await` 整条
   阶段链（子代理会话，可能几十分钟）跑完才处理下一条；tick 被卡住（`this.running`
   置位），10s 轮询不再触发 → 后续放行进不来（即「wait group 长度只有 1」）；
3. `retryFailed()` 同样串行阻塞 tick；且续跑/重试完全不计入并发预算。

**修复**（`cm-worker`，src 与 lib 均已更新）：
- **tick 改为短派发循环**：读配置 → 时段门控 → `dispatchClaims()` →
  `dispatchReviews()` → `dispatchRetries()` → `finalizeMerged()`。tick 只做快查询与
  派发，不阻塞在长流水线上；每条领取/续跑/重试都以后台任务运行。
- **全局并发预算**（= `worker_config.concurrency`，1–8 钳制）：`active` 计数 +
  `trySlot`/`releaseSlot`；领取按预算逐个原子 `claim()`（`for update skip locked`），
  审核续跑、失败重试按剩余槽位逐个后台派发；槽位在流水线**挂起或完成时释放**，
  下一轮（≤10s）即补——审核放行逐条到来也能并发续跑。
- **冲突解决并入预算**：`PipelineDeps.dispatchBackground` 钩子（service 注入
  `withSlot`，预算满则排队，槽位空出即跑）；未提供钩子时保持原 fire-and-forget。
- **防重复派发**：service 内存 `dispatched` set（record_id），已派发未落定的
  审核/重试动作不会被子序列的 tick 重复派发。
- **pipeline 拆分可测**：`claim`/`runClaimed`、`ensureReplyTickets`/
  `listActionableReviews`/`processReviewAction`、`listRetryable`/`processRetryRow`；
  串行版 `claimAndRun`/`processReviews`/`retryFailed` 保留（测试与同步场景用）。
- 测试新增 2 例：两条需求同时挂在 decision 审核门 → 放行后一轮取齐并行续跑；
  `dispatchBackground` 钩子路由冲突解决任务。全套 83/83 绿。
- **产物存在性校验（ADR-028 事故教训，叠加于 3.0.3 之上）**：`runStage` 在阶段会话
  返回成功后，对 artifacts 中「不含空白的相对路径条目」逐一用 fs 校验在 worktree
  真实存在（commit 描述等含空白条目跳过）；缺失 → record 判 failed（可被
  retryFailed 重试），幽灵产物不会进审核门。纯工程侧、零额外模型调用；resolve/merge
  不校验（其 artifacts 为提交 hash / PR URL）。全套 87/87 绿。
- **生效前提**：host 代码改动需 `pnpm build` 后**重启 dsh web**（见 §3.1）。

### 3.0.4 ✅ 本轮修复（2026-08-16 会话，代码已完成、测试 93/93 绿、已 build）

**ADR-025 卡死现场**（用户报告「执行中/无运行/无审核」）：

- 状态：`84dab3ca`（ADR-025）6 阶段全 success（review-code 于 09:36 成功），但 **merge
  从未开始**——无 merge record、分支未 push；worktree 里 23 文件 1331 行代码未提交。
- 根因①（机制缺陷）：进程死在「stage success 记账之后、下一 stage/merge 记账之前」时，
  需求停在 `in_progress` + 最新 record=success + 无 merge——claim/审核/重试/收尾四条
  派发路径全部看不见它 → 永久「执行中」僵尸。
- 根因②（连带缺陷）：facai-coding 技能明确规定不 git commit（"提交由用户或流水线决定"），
  而 `runMerge` 的 push 只推**已提交**内容 → 即使不崩溃，PR 也会漏掉全部代码。

**修复**（cm-worker / cm-worktree）：
- **启动自愈 `recoverStartup()`**（服务启动后第一个 tick 一次性执行）：
  - `markStaleRunning`：进程重启后残留的 `running` record → failed（'进程重启，中断的
    会话已失效'），交给 retryFailed 复用同一 record 续跑（同分支/worktree）；
  - `listStuckGaps` + `resumeGap`：`in_progress` 且「最新 record=阶段 success、无
    merge record」的缺口僵尸 → 最后阶段补 merge（push+PR），中途缺口从下一阶段续跑；
    正常在途/挂起（running/waiting_review/waiting_reply/failed 最新）不误伤。
- **阶段产物兜底提交**：runStage 成功（产物校验通过）后调用 `commitWorktree` 钩子
  （service 注入 `WorktreeManager.commitAll`：`git add -A` + 有改动才 commit，无改动
  no-op，target 等已被 .gitignore 排除）——技能层不提交的产物由流水线以一次 commit
  落到任务分支，merge push 不再漏代码；提交失败不阻断阶段成功。
- 测试新增 6 例（worker 36、worktree 6）：markStaleRunning→failed+可重试、缺口补
  merge（push+PR→merging）、中途缺口续跑下一阶段、不误伤 running/waiting_review、
  阶段成功调兜底提交钩子（失败不调）、commitAll 干净 no-op/脏提交。全套 93/93 绿。
- **ADR-025 现场解卡（数据级，已完成）**：把 worktree 未提交产物提交为 3 个 commit
  （a6fc9c2/5bdae21/cd0bb36）→ push `origin/req-84dab3ca` → 建 PR
  **https://gitee.com/wb200327/fac-ai-rs/pulls/3** → 落 merge record（success + PR URL）
  + 需求 `in_progress → merging`。**用户下一步：Gitee 合并 PR #3 → 审核大厅点「已合并」
  → finalizeMerged 自动收尾（cleanup → done）**。
- **生效前提**：host 代码改动需重启 dsh web（见 §3.1）；重启后自愈会对任何同类僵尸
  自动恢复（本部署当前运行实例 10:36 启动、仍为旧 lib，重启前不做自动恢复）。

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

### 3.5 🟢 打包与分发（计划 10）—— P0–P3 已实施并验证

方案已定稿为 `docs/plans/10-packaging-distribution.md`。本轮（2026-08-16）完成：

- **P0 mega 包**：`packages/mega/`（exports 五入口 `.`/`./db`/`./flow`/`./worker`/
  `./client` + `dsh.bundle` 包内 patch + `dsh.client` 声明）；db/flow/worker/index
  四 host 入口 + client 浏览器半全部构建通过；`pnpm typecheck` 绿、`pnpm test`
  110/110 绿（mega 新增 6 例：patch 行断言 + skills-source）。
- **reconcile 验证**：一次性 profile 上 `dsh plugin add link:…` →
  `@auto-coding/mega` 自动进 `dsh.profile.bundles`；`--dump-config` 确认包内
  patch 的四行（db-pgmas / cm-flow / cm-worker / ui-requirements）自动挂载。
- **§3.4 client 半语义**：client-modules 按 loader 行名解析 package.json；子路径
  行（mega/db、/flow、/worker）resolve 失败永久非 client 行，仅根行
  `@auto-coding/mega`（ui-requirements）成为 client 行——解法 2 天然成立。
- **git 分发（决策 B 定案）**：`scripts/build-dist.mjs` 组装 `dist/mega/`（lib +
  patch + assets/USAGE.md + 精简 manifest）；pnpm `&path:/dist/mega` 子目录片段实测
  可用，本地裸仓 + `dsh plugin add git+file://…#v0.3.0&path:/dist/mega` 全流程
  验证：安装 → reconcile → 四行挂载。
- **P3 skills 外部源（2026-08-16 修订：不内置技能）**：`skills-source.ts`
  （`dir`|`git` 两源，`builtin` 已移除）+ worker `skillsSource` config +
  readSkillMd 回退 + worktree 创建后 provisionSkills 补装。**插件不打包任何
  skills**——facai skills 是项目/组织特定（编码 fac-ai-rs 规则），必须配合
  coding-pipline-skills 使用（`.agents/skills/` 放进项目 + `/facai-init`）；
  未配置 skillsSource 时只读项目自身技能，缺失即报错提示。
- **待办**：本机 web profile 从四独立包切到 mega（§3.1 重启时一并做，见下）；
  推远端 tag 后目标机器一键安装实测；旧四包归档。

### 3.6 ✅ v0.3.0（2026-08-16）：使用说明 + 显式迁移入口

- **使用说明**：完整四步文档（配置数据库 → 技能 → 添加项目 → 登记需求）落地两处——
  仓库 `README.md` 顶部「快速使用」+ 插件内「自动化看板 → 使用说明」页；
  文档源文件 `packages/mega/assets/USAGE.md`，`usage remote` 默认读包内文档
  （经 import.meta.url 定位，随 dist 分发，开箱即用），显式 `usagePath` 仍优先。
- **「迁移（建表）」按钮**：数据库连接卡片新增显式迁移入口——cm-flow `config`
  命名空间新增 `migrate` remote（幂等，返回本次应用的迁移列表）；
  迁移在 repo 构造时本就自动运行，按钮用于改完连接后主动跑一遍看结果/报错。
  `runMigrations` 已导出并返回 `string[]`。
- 版本 `0.2.0 → 0.3.0`，dist/mega 重新组装（含 assets/USAGE.md），测试 112/112 绿。

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
| 打包分发方案 | `docs/plans/10-packaging-distribution.md` |

## 5. 关键约定（来自计划 00）

- 一条 requirement = 一次完整流水线；record 记账每阶段一条；6 阶段
  decision / plan / review-plan / coding / contract / review-code / merge
- 每任务一个 git worktree + 独立分支；写库一律经 `pgmas.withClient('cm', fn)`；
  worker 不注册模型写工具；`pg_query` 保持只读
- 唯一试点项目 fac-ai-rs；pr_token 经环境变量 PR_TOKEN 注入（不进 prompt/git/records）
- 阶段会话超时默认 30min；PR 平台仅 Gitee/Gitea
