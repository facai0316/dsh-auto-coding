# 02 · cm-flow 扩展（repo + 状态机 + Typert remote）

> 前置：01 迁移完成。改 `packages/cm-flow/src/{repo.ts,index.ts}`。
> 目标：宿主业务层支撑流水线——projects / questions / requirements（含阶段折叠与 confirmMerged）三类能力，经 Typert remote 暴露给面板与 worker。

## 1. 结构：三个 TypertRemoteService

一个 `TypertRemoteService` 绑定一个 wire namespace。cm-flow 内提供三个 service（同进程、共享 `pgmas`）：

| 类 | 服务 key | namespace | 方法（@Remote） |
|---|---|---|---|
| `CmFlowService`（现有 default） | `cmFlow` | `requirements` | `list` / `create` / `transition` / `confirmMerged` |
| `ProjectsService`（新） | `cmProjects` | `projects` | `list` / `create` |
| `QuestionsService`（新） | `cmQuestions` | `questions` | `list` / `answer` |

`ProjectsService`/`QuestionsService` 在 `CmFlowService` 构造函数内实例化（各自 `super(ctx, key, {namespace})` 自动 provide）；三者都从 `ctx.get('pgmas')` 拿写缝。

```ts
// index.ts
export default class CmFlowService extends TypertRemoteService {
  static inject = ['pgmas']
  static Config: z<Config> = z.object({ database: z.string().default(DEFAULT_DATABASE), userId: z.string().default(DEFAULT_USER_ID) })
  constructor(ctx: Context, config: Config = {...}) {
    super(ctx, 'cmFlow', { namespace: 'requirements' })
    const pgmas = ctx.get('pgmas') as PgMasService
    if (pgmas === undefined) throw new Error('cm-flow: pgmas service is unavailable')
    this.repo = new RequirementsRepo({ pgmas, database, userId })
    new ProjectsService(ctx, new ProjectsRepo({ pgmas, database }))
    new QuestionsService(ctx, new QuestionsRepo({ pgmas, database }))
  }
  // @Remote list / create / transition / confirmMerged（委托 repo）
}
```

## 2. Repo 层（`repo.ts` 追加）

### 2.1 ProjectsRepo

```ts
export interface ProjectView {
  id: string; name: string; localPath: string; gitUrl: string
  platform: 'gitee' | 'gitea'; hasToken: boolean          // 不回传 token 明文
}
export class ProjectsRepo {
  constructor(opts: { pgmas: WriteSeam; database?: string })
  async list(): Promise<ProjectView[]>                       // order by created_at
  async create(input: { name: string; localPath: string; gitUrl: string; platform: string; prToken?: string }): Promise<ProjectView>
    // 校验：name/localPath/gitUrl 非空；platform ∈ {gitee,gitea}；localPath 唯一（冲突抛错）
    // insert ... returning *; prToken 存明文（面板输入）
  async getToken(id: string): Promise<string | undefined>     // worker/PR 阶段用
}
```

### 2.2 QuestionsRepo

```ts
export interface QuestionView {
  id: string; recordId: string; question: string; options: string[]
  status: 'pending' | 'answered'; answer: string | null; createdAt: string; answeredAt: string | null
}
export class QuestionsRepo {
  constructor(opts: { pgmas: WriteSeam; database?: string })
  async insertMany(recordId: string, questions: { question: string; options: string[] }[]): Promise<void>
  async listByRecord(recordId: string): Promise<QuestionView[]>
  async pendingByRecord(recordId: string): Promise<QuestionView[]>     // status='pending'
  async answer(questionId: string, answer: string): Promise<QuestionView>
    // update set status='answered', answer=$2, answered_at=now() where id=$1 returning *
}
```

### 2.3 RequirementsRepo 扩展

```ts
export type RequirementStatus = 'draft' | 'open' | 'in_progress' | 'merging' | 'done' | 'cancelled'

// 现有 TRANSITIONS 增补 merging 边：
//   in_progress → merging（worker 建 PR 后）
//   merging     → done（用户 confirmMerged）
//   merging     → cancelled
//   （done/cancelled 终态；其余维持现状）

async list(options?: { projectId?: string }): Promise<RequirementWithStages[]>
  // requirements left join 最近 records；返回每条的阶段折叠 stages
async confirmMerged(id: string): Promise<RequirementView>
  // 校验 status==='merging'；置 done；记一条 record(category='merge', status='success', result='user confirmed merged')
async markMerging(id: string, prUrl: string): Promise<RequirementView>
  // worker 建 PR 成功后：in_progress → merging；记 merge record(status='success', artifacts=[prUrl])
async appendRecord(record: {...}): Promise<RecordView>     // 供 worker 记账（04）
```

### 2.4 视图类型

```ts
export interface StageSummary {
  category: string; status: string; prUrl?: string; updatedAt: string
}
export interface RequirementWithStages extends RequirementView {
  projectId: string | null
  stages: StageSummary[]      // 按 records.created_at 升序，最多回传全部（面板折叠）
}
export interface RecordView {
  id: string; category: string; status: string; result: string | null
  artifacts: string[]; skills: string[]; parentId: string | null
  requirementId: string; branchId: string | null; createdAt: string; updatedAt: string
}
```

## 3. Remote 方法（wire 契约，客户端 descriptor 需一一对应）

### requirements namespace

| 方法 | 参数（wire 字段） | 返回 |
|---|---|---|
| `list` | `projectId?` | `RequirementWithStages[]` |
| `create` | `title`, `description?`, `projectId` | `RequirementView`（status=`draft`，挂项目） |
| `transition` | `id`, `to` | `RequirementView`（面板「提交执行」= to `open`） |
| `confirmMerged` | `id` | `RequirementView`（merging→done） |

> `create` 新增 `projectId` 必填（面板登记需求时已选项目）。旧语义「open 直入」改为「draft 创建」，面板显式 `transition('open')` 提交执行。

### projects namespace

| 方法 | 参数 | 返回 |
|---|---|---|
| `list` | — | `ProjectView[]` |
| `create` | `name`,`localPath`,`gitUrl`,`platform`,`prToken?` | `ProjectView` |

### questions namespace

| 方法 | 参数 | 返回 |
|---|---|---|
| `list` | `recordId` | `QuestionView[]` |
| `answer` | `questionId`, `answer` | `QuestionView` |

## 4. 状态机完整表（`TRANSITIONS`）

```
draft     → open | cancelled
open      → in_progress | cancelled
in_progress → merging | cancelled
merging   → done | cancelled
done      → （终态）
cancelled → （终态）
```

> `done→open`（面板勾选重开）在流水线形态下移除——done 由用户确认合并产生，不可逆。

## 5. 实现步骤

1. `repo.ts`：追加 `REQUIREMENT_STATUSES`/`RECORD_STATUSES` 常量、三个 Repo 类、`TRANSITIONS` 增补 merging、视图类型
2. `index.ts`：`ProjectsService`/`QuestionsService` 类 + `CmFlowService` 新方法（list 折叠/confirmMerged/create 带 projectId/transition 更新机器）
3. 类型重导出（`export type { ProjectView, QuestionView, ... }`）
4. `pnpm --filter @auto-coding/cm-flow build`（两步构建）+ 扩展真库集成测试（projects CRUD、questions 挂答、confirmMerged 状态机、list 折叠）

## 6. 验收

- 面板可注册项目（含 platform/prToken）、可对 record 挂/答问题
- `create` 建 draft 并挂项目；`transition('open')` 提交执行；`confirmMerged` 仅 merging→done
- 状态机非法流转（如 done→open、open→merging）报错
- 真库集成测试全绿；`pg_query` 只读不受影响
