# 01 · 数据模型（迁移 v2-v4）

> 前置：无。改 `packages/cm-flow/src/repo.ts` 的迁移表 `MIGRATIONS`。
> 现状基线：v1 已断言 `requirements` 表存在（SeaORM 遗留）；`_cm_flow_migrations` 已建。

## 1. 目标

在 `cm` 库新增：`projects` 表、`requirements.project_id`、`ask_user_questions` 表；扩展 `requirements.status` 语义（`merging`）。全部走 cm-flow 的顺序迁移，幂等、可回滚。

## 2. 迁移清单

| version | name | 内容 |
|---|---|---|
| v2 | projects 表 | `projects` 建表 + 试点行注册（见 §3） |
| v3 | requirements 挂项目 | `requirements.project_id` + 部分索引 |
| v4 | 问答子表 | `ask_user_questions` 建表 + 索引 |

## 3. SQL（迁移正文）

### v2 — projects

```sql
create table if not exists projects (
  id          uuid primary key default gen_random_uuid(),
  name        varchar not null,
  local_path  text not null unique,
  git_url     text not null,
  platform    varchar not null default 'gitee',   -- 'gitee' | 'gitea'
  pr_token    text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- 试点注册（幂等，name 唯一性由应用层保证；此处仅登记 fac-ai-rs）
insert into projects (id, name, local_path, git_url, platform)
select '00000000-0000-4000-8000-0000000000c1',
       'fac-ai-rs',
       '/root/workspace/rust/fac-ai-rs',
       'git@gitee.com:wb200327/fac-ai-rs.git',
       'gitee'
where not exists (select 1 from projects where local_path = '/root/workspace/rust/fac-ai-rs');
```

> 试点行 id 用固定 UUID，便于后续种子/测试引用；`pr_token` 由面板 project 管理写入（不在迁移里埋）。

### v3 — requirements.project_id

```sql
alter table requirements add column project_id uuid references projects(id);

create index requirements_project_open_idx
  on requirements(project_id)
  where status = 'open';
```

> `requirements.status` 无 CHECK 约束，新增 `merging` 取值无需 DDL（代码层固化）。

### v4 — ask_user_questions

```sql
create table if not exists ask_user_questions (
  id          uuid primary key default gen_random_uuid(),
  record_id   uuid not null references records(id) on delete cascade,
  question    text not null,
  options     text[] not null default '{}',
  status      varchar not null default 'pending',   -- 'pending' | 'answered'
  answer      text,
  created_at  timestamptz not null default now(),
  answered_at timestamptz
);

create index ask_user_questions_pending_idx
  on ask_user_questions(record_id)
  where status = 'pending';
```

## 4. 迁移机制改造（`repo.ts`）

现有 `MIGRATIONS: Migration[]` 数组直接追加三行；`apply(client)` 内已是「`begin` → apply → insert 版本行 → `commit`，失败 rollback」，无需改框架：

```ts
const MIGRATIONS: readonly Migration[] = [
  { version: 1, name: 'baseline: assert SeaORM requirements table exists', apply: async c => { await c.query('select 1 from requirements limit 1') } },
  { version: 2, name: 'projects table + seed fac-ai-rs', apply: async c => { await c.query(V2_SQL) } },
  { version: 3, name: 'requirements.project_id + open index', apply: async c => { await c.query('alter table requirements add column project_id uuid references projects(id)'); await c.query('create index requirements_project_open_idx on requirements(project_id) where status = \'open\'') } },
  { version: 4, name: 'ask_user_questions table + pending index', apply: async c => { await c.query(V4_SQL) } },
]
```

## 5. 状态枚举固化（代码）

`requirements.status` 合法值（`src/repo.ts` 常量）：

```ts
export const REQUIREMENT_STATUSES = ['draft', 'open', 'in_progress', 'merging', 'done', 'cancelled'] as const
export type RequirementStatus = typeof REQUIREMENT_STATUSES[number]
```

`records.status` 合法值（`src/repo.ts` 常量）：

```ts
export const RECORD_STATUSES = ['running', 'success', 'failed', 'waiting_reply'] as const
export type RecordStatus = typeof RECORD_STATUSES[number]
```

## 6. 验证

1. `pnpm --filter @auto-coding/cm-flow build && pnpm test`（迁移经真库跑，幂等）
2. `pg_query` 核对：`\d projects` / `\d ask_user_questions` 存在；`requirements` 有 `project_id` 列与 `requirements_project_open_idx`
3. 幂等：重复挂载/重跑迁移不报错（版本行已跳过）
4. 回滚演练（09）：手动 `drop` 三对象后重跑迁移可重建

## 7. 前置给后续计划

- 02 计划依赖 v2-v4 完成后的表结构
- `MIGRATIONS` 追加后，`cm-flow` 重建（两步构建 `tsc -p tsconfig.build.json && tsdown`）
