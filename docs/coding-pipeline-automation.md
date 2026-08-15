# 编码流水线自动化方案（cm-flow worker + 阶段智能体）

> 状态：方案定稿 v2（含全部确认决策）
> 适用：本 dsh 插件仓库（实现地）+ cm 库（账本）+ 任意试点项目（首个：`fac-ai-rs`，Gitee 托管）

---

## 0. 决策汇总（本轮确认）

| # | 决策 | 落地 |
|---|---|---|
| D1 | 阶段粒度 | **6 个 facai skill = 6 个阶段**；selfcheck 并入 coding，review 跑两次（计划后、代码后） |
| D2 | 产出终点 | 自动 `push` → 建 PR（**agent 任务**，Gitee/Gitea 动态判断，§8）→ `requirement.status='merging'` → 你手动合并 → 面板点「已合并」→ 收尾置 `done` |
| D3 | 多项目 | **固定 facai 这套 skill**，阶段硬编码；新项目接入靠你手动先跑完 `facai-init`，不做动态发现/高鲁棒性 |
| D4 | 问答续跑 | **新开会话**，靠落盘产物 + 你的答复重建上下文 |
| D5 | 轮询 | 全轮询无监听；子会话结束用 `await` 阻塞等待 |
| D6 | 数据模型 | `projects` 表；`records.status` 加 `waiting_reply`；新增 `ask_user_questions`（含 `answer` 字段） |

---

## 1. 目标与范围

把 fac-ai-rs 手动的「决策 → 计划 → 编码 → 自检 → 契约 → 审核」技能链自动化：

- 用户在面板提交需求 → worker 领取 → 按 6 阶段拉起携带对应 `facai-*` skill 的智能体会话，在 worktree 分支内干活
- 阶段产物落 git 分支、账本落 cm 库
- **只有需要用户判断的点停下来问**；跑完 push + 建 PR，用户手动合并后点「已合并」收尾
- 所有项目用同一套 facai skill + 同一套流水线（projects 注册 + worktree）

非目标：不监听事件；不做动态 skill 发现；不做 CI/webhook。

---

## 2. 数据模型变更

### 2.1 `projects` 表

```sql
create table if not exists projects (
  id            uuid primary key default gen_random_uuid(),
  name          varchar not null,             -- 如 fac-ai-rs
  local_path    text not null unique,         -- 主 checkout，如 /root/workspace/rust/fac-ai-rs
  git_url       text not null,                -- git@gitee.com:wb200327/fac-ai-rs.git
  platform      varchar not null,             -- 'gitee' | 'gitea'（注册时选，也可由 git_url host 推断）
  pr_token      text,                         -- 可选：建 PR 用的 PAT，面板 project 管理处输入
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
```

> `pr_token` 为可空明文（个人部署可接受，已在 §11 标注风险）；PR 创建前若未配置则转 `waiting_reply` 提示补填。

### 2.2 `requirements` 挂项目 + 状态扩展

```sql
alter table requirements add column project_id uuid references projects(id);
create index on requirements(project_id) where status = 'open';
```

`requirements.status`（varchar，无 DDL）枚举扩展：

| status | 语义 |
|---|---|
| `draft` | 新建，未提交执行 |
| `open` | 面板已提交执行，排队中 |
| `in_progress` | worker 执行阶段中 |
| **`merging`**（新增） | PR 已建，等你手动合并 |
| `done` | 你点「已合并」、worker 收尾完成 |
| `cancelled` | 取消 |

### 2.3 `records.status` 扩展

| status | 语义 |
|---|---|
| `running` | 阶段会话执行中 |
| `success` | 阶段完成 |
| `failed` | 阶段失败（可重试） |
| **`waiting_reply`**（新增） | 阶段挂起，等回答 `ask_user_questions` |

### 2.4 `ask_user_questions`（records 子表）

```sql
create table if not exists ask_user_questions (
  id          uuid primary key default gen_random_uuid(),
  record_id   uuid not null references records(id) on delete cascade,
  question    text not null,
  options     text[] not null default '{}',        -- 空数组 = 自由输入
  status      varchar not null default 'pending',  -- pending | answered
  answer      text,                                -- 答复原文（续跑注入上下文，必要补充）
  created_at  timestamptz not null default now(),
  answered_at timestamptz
);
create index on ask_user_questions(record_id) where status = 'pending';
```

### 2.5 迁移清单（cm-flow `_cm_flow_migrations`）

| version | 内容 |
|---|---|
| v1 | 现状：baseline 断言 |
| v2 | 建 `projects` 表 |
| v3 | `requirements.project_id` + 索引 |
| v4 | 建 `ask_user_questions` 表 + 索引 |

（`requirements.status`/`records.status` 枚举扩展为 varchar 取值，无 DDL，由代码文档固化）

---

## 3. 总体架构

```
        ┌────────────────────── cm 库（唯一账本）──────────────────────┐
        │  projects / requirements / records / ask_user_questions / branches │
        └────────────▲─────────────────────────────▲──────────────────┘
                     │ 读写（cm-flow remote）        │ 读写
        ┌────────────┴──────────┐        ┌──────────┴───────────┐
        │  面板（client）          │        │  cm-worker（host）    │
        │  登记/提交需求、展示进度、 │        │  timer 轮询 + 编排     │
        │  回答 waiting_reply、   │        │  + worktree/PR 生命周期 │
        │  点「已合并」            │        └──────────┬───────────┘
        └───────────────────────┘                   │ subagents.start()
                                                    ▼
                                  ┌─────────────────┴─────────────────┐
                                  │ 阶段智能体会话（每阶段一个，cwd=worktree） │
                                  │ facai-{decision,plan,review,coding,   │
                                  │        contract,selfcheck(并入coding)} │
                                  └───────────────────────────────────┘
                                          │ git 读写
                                          ▼
                              git worktree（每任务一分支，互不影响）
```

**关键原则**
1. 全轮询；子会话完成用 `await`
2. records 唯一账本，断点可续
3. worker 只编排与记账，不写代码
4. 决策点唯一通道 = `waiting_reply` + `ask_user_questions`（面板作答）

---

## 4. worker 调度

### 4.1 轮询清单（timer，10s 一档）

| 轮询 | 触发条件 | 动作 |
|---|---|---|
| 领取任务 | `requirements.status='open'` | 乐观锁领取 → `in_progress`，建 worktree + 首条 record |
| 续跑决策 | record `waiting_reply` 且 questions 全 answered | 组装答复 → 新开会话续跑 |
| 重试失败 | record `failed` 且重试 < 上限 | 重置重跑 |
| 收尾确认 | `requirement.status='merging'` 且你点「已合并」 | 校验 PR → 删分支/worktree → `done` |
| 面板同步 | 面板轮询 remote | 返回含阶段/待决策/PR 链接的列表 |

### 4.2 任务领取（乐观锁）

```sql
update requirements r
set status = 'in_progress', updated_at = now()
where r.id = (
  select r2.id from requirements r2
  where r2.status = 'open' and r2.project_id is not null
  order by r2.created_at asc
  limit 1
  for update skip locked
)
returning r.id, r.project_id, r.title, r.description
```

### 4.3 状态机

**requirement**：`draft → open → in_progress → merging → done`（`cancelled` 任意非终态可达）

**record**：`running → success | failed | waiting_reply`

---

## 5. 阶段管线（6 skill，review 两次）

| 顺序 | category | skill | 输入 | 产物（worktree 内） | 决策点 |
|---|---|---|---|---|---|
| 1 | `decision` | facai-decision | 需求 + 现状 | `decisions/{n}-*.md` + 索引 | **ADR 方案 A/B → waiting_reply** |
| 2 | `plan` | facai-plan | 需求 + ADR + 架构 | `docs/plans/{n}-*/` | — |
| 3 | `review-plan` | facai-review（审计划） | 计划 + 架构/规则 | 审核结论 | **计划冲突 → waiting_reply** |
| 4 | `coding` | facai-coding（**含 facai-selfcheck 闭环**） | 计划 + 现有代码 | 代码 + 测试（自检通过） | — |
| 5 | `contract` | facai-contract | 变更 + spec/ | `spec/` 更新 | **契约语义 → waiting_reply** |
| 6 | `review-code` | facai-review（审代码） | 代码 + 规则/spec | 审核修正（冲突直改） | — |
| 7 | `merge` | agent 任务（建 PR 指令，见 §8） | 任务分支 | push + PR | PR 合并冲突/未配 token → waiting_reply |

> `review-plan`/`review-code` 是同一 `facai-review` skill 的两次调用，category 用不同值区分记账。

### 5.1 阶段上下文组装（每阶段会话 prompt）

1. 注入对应 skill 的 `SKILL.md` 全文（`<repo>/.agents/skills/facai-*/SKILL.md`）
2. 注入规则路径：`AGENTS.md` / `rules/coding-rule.md` / `rules/test-rule.md`（要求会话自行读）
3. 需求视图（title/description/project）
4. 前序产物引用（`records.artifacts` 存的相对路径/commit）
5. 若续跑：`waiting_reply` 问答（question + options + answer）

会话 `cwd` = 任务 worktree；完成用 `report` 回传结构化结果（成功/失败/产物/待问问题）。

### 5.2 记账（每阶段固定动作）

```
1. insert record(category, requirement_id, branch_id, status='running', parent_id=上一条)
2. subagents.start() → await
3. 产出问题 → insert ask_user_questions ×N; record='waiting_reply'; 结束本步
4. 否则 update record(status, result, artifacts, skills, references)
5. 推进 requirements / 下一阶段
```

---

## 6. 决策通道（waiting_reply + ask_user_questions）

- **挂起**：阶段会话 report 返回 `questions:[{question, options}]` → worker 落库（record=waiting_reply + questions pending）→ 会话结束，worktree/未提交改动保留
- **面板**：卡片「待决策」徽标 → 问答弹层（选项按钮 / 自由输入）→ 逐题 `answer`
- **答复写回**：`questions.answer({questionId, answer})`
- **续跑**：worker 下轮轮询发现全 answered → 组装上下文 → **新开会话**续跑（D4）

---

## 7. worktree 并发 + 收尾

### 7.1 布局与生命周期

```
<project.local_path>                 # 主 checkout
<local_path>/../worktrees/<project>/ # worktree 根（可配）
  └── req-<requirement短id>/          # 每任务一个
```

```
领取：git -C <repo> worktree add <wt> -b req-<id> <base: origin/main>
阶段：会话 cwd = <wt>；产物提交到 req-<id> 分支
收尾（merge 阶段）：
  git -C <repo> push -u origin req-<id>
  调 Gitee API 建 PR（base=main, head=req-<id>）→ 记 PR 链接/号到 records.artifacts
  requirement.status = 'merging'
你手动合并 PR 后 → 面板点「已合并」→ worker：
  校验 PR 已合并 → git branch -D req-<id> → git worktree remove --force <wt>
  requirement.status = 'done'
```

### 7.2 并发隔离

- 每任务独立分支 + 独立 worktree，工作区/HEAD/索引互不干扰，运行期零冲突
- 冲突只发生在 Gitee PR 合并期，由 Gitee 暴露 → 你在网页解决或驳回后走 `waiting_reply`

### 7.3 构建产物（Rust target）

- 推荐：worktree 内 `target` 软链到主 checkout 的 `target`（依赖只编译一次；cargo 文件锁自动串行并发编译）
- 备选：每 worktree 独立 `CARGO_TARGET_DIR`（并发无等待，磁盘翻倍）

---

## 8. PR 创建（agent 任务，平台动态判断）

PR 建立**不硬编码在 worker**，做成一个 merge 阶段的 agent 子任务：worker 只注入指导指令 + 环境，由 agent 判断平台、调用对应 API、返回结构化 JSON；worker 解析 JSON 记账。

**平台判断**（写进指导指令，可靠）：
1. `git -C <wt> remote get-url origin` → 取 host
2. host 含 `gitee.com` → **Gitee**；其余（自建域名）→ **Gitea**（只考虑这两个平台）

**凭证**（PAT，只能手动生成，故面板输入）：
- Gitee：设置 → 私人令牌，`Authorization: token <PAT>`
- Gitea：设置 → 应用 → 生成令牌，`Authorization: token <PAT>`
- token 存 `projects.pr_token`，worker 以环境变量 `PR_TOKEN` 注入会话（bash env），不写进 prompt 正文

**指导指令（merge 阶段 agent prompt 核心）**：
```
1. 解析 remote：owner/repo（git@gitee.com:o/r.git 或 https://host/o/r.git → o/r）
2. 建 PR：
   Gitee: POST https://gitee.com/api/v5/repos/{owner}/{repo}/pulls
   Gitea: POST https://<host>/api/v1/repos/{owner}/{repo}/pulls
   header: Authorization: token $PR_TOKEN
   body:   { title: <需求标题>, head: "req-<id>", base: "main", body: <需求描述+阶段摘要> }
3. 返回 JSON（唯一契约）：{"is_ok":"true","pr_url":"https://…/pulls/<n>"}
   失败：{"is_ok":"false","error":"<原因>"}
```

**worker 侧解析**：
- `is_ok=true` → 记 `pr_url` 到 records.artifacts → `requirement.status='merging'`
- `is_ok=false` 或未配 token → record `waiting_reply`，附问题让你补 token / 手动建 PR 后点「已合并」

---

## 9. 面板升级（流水线控制台）

| 能力 | 实现 |
|---|---|
| 卡片阶段时间线 | `requirements.list` 返回关联 records（category/status/时间）折叠展示 |
| 状态徽标 | running/success/failed/waiting_reply 着色；`merging` 显示 PR 链接 |
| 待决策问答弹层 | 卡片「待决策」→ Modal 逐题问答（§6） |
| 提交执行 | 勾选/「开始执行」→ `transition('open')` |
| 已合并确认 | `merging` 卡片 → 「已合并」按钮 → 触发收尾 |
| 项目筛选 | 顶栏 projects 筛选 |

remote 面扩展（cm-flow）：
```
projects.list / projects.create({name, localPath, gitUrl, platform, prToken?})
requirements.list({projectId?})          # 含阶段折叠
requirements.confirmMerged({requirementId})
questions.list({recordId}) / questions.answer({questionId, answer})
```

---

## 10. 失败与恢复

- 断点续跑：状态全在 records；worker 重启后从最后非终态 record 续跑（先确认 worktree 现场）
- 重试：`failed` 默认重试 1 次（可配）；超限 → requirement 回 `open` 重新排队，保留现场
- 现场保留：失败任务不删 worktree；records.artifacts 记 wt 路径 + commit
- 库不可达：轮询静默跳过下轮重试，面板如实显示错误

---

## 11. 安全边界

- 写库全走 cm-flow（`pgmas.withClient`）；`pg_query` 模型工具保持只读
- worktree/git 操作 worker 内部封装（命令白名单），不暴露给模型；PR 建交 agent 任务但经指导指令 + JSON 契约约束
- `pr_token` 明文存 `projects` 表（个人部署可接受）；仅经环境变量注入 merge 会话，不进 prompt 正文、不进 git、不进 records
- 阶段会话权限 = 本机 bash/fs（与手动跑 skill 等价），worktree 限制只改任务分支
- 决策只经面板通道；任何智能体不得自行替用户回答

---

## 12. 落地步骤

| 步骤 | 内容 | 验收 |
|---|---|---|
| 1 | cm-flow 迁移 v2-v4 + remote 扩展（projects / questions.list / questions.answer / requirements.confirmMerged） | 可注册项目、对 record 挂/答问题 |
| 2 | cm-worker 骨架：timer 轮询 + 领取 + records 记账 + 首条 `plan` 阶段会话（注入 facai-plan，cwd=worktree） | 提交需求 → 自动生成 docs/plans 并记 record |
| 3 | worktree 生命周期（add / 会话 cwd / push / PR / remove）+ target 软链 | 两需求并行，各自分支互不干扰 |
| 4 | 决策通道：waiting_reply 挂起 + 面板问答 + 答复续跑 | 阶段在决策点停下，作答后自动继续 |
| 5 | 全 6 阶段接入（decision/plan/review/coding/contract/review + merge 收尾）+ 重试/超时 | fac-ai-rs 一条需求从登记到「merging 待你合并」全自动 |
| 6 | 多项目：你在新项目跑完 facai-init → 面板注册 project → 零改动复用 | 第二项目跑通 |
