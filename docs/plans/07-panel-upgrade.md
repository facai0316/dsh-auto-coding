# 07 · 面板升级（流水线控制台）

> 前置：02（remote 面）。改 `packages/ui-requirements/src/client/*`。
> 目标：需求面板从「清单」升级为「流水线控制台」——登记/提交、阶段时间线、状态徽标、待决策问答、已合并确认、项目管理。

## 1. remote 契约扩展（`remote.ts`）

现有单一 `requirements` contribution 扩展为三 namespace 的 descriptors（同一 `CONTRIBUTION.descriptors` 数组）：

| namespace | 方法 | 参数 | 返回 |
|---|---|---|---|
| requirements | `list` | `projectId?` | `RequirementWithStages[]` |
| requirements | `create` | `title`, `description?`, `projectId` | `RequirementView` |
| requirements | `transition` | `id`, `to` | `RequirementView` |
| requirements | `confirmMerged` | `id` | `RequirementView` |
| projects | `list` | — | `ProjectView[]` |
| projects | `create` | `name`,`localPath`,`gitUrl`,`platform`,`prToken?` | `ProjectView` |
| questions | `list` | `recordId` | `QuestionView[]` |
| questions | `answer` | `questionId`,`answer` | `QuestionView` |

### 1.1 类型与 zod schema（新增）

```ts
export const requirementWithStagesSchema = requirementViewSchema.extend({
  projectId: z.string().nullable(),
  stages: z.array(z.object({
    category: z.string(), status: z.string(), prUrl: z.string().optional(), updatedAt: z.string(),
  })),
})
export const projectSchema = z.object({
  id: z.string(), name: z.string(), localPath: z.string(), gitUrl: z.string(),
  platform: z.enum(['gitee', 'gitea']), hasToken: z.boolean(),
})
export const questionSchema = z.object({
  id: z.string(), recordId: z.string(), question: z.string(), options: z.array(z.string()),
  status: z.enum(['pending', 'answered']), answer: z.string().nullable(),
  createdAt: z.string(), answeredAt: z.string().nullable(),
})
```

### 1.2 三个 facade

```ts
export const requirements = { list(projectId?), create(title, description, projectId), transition(id, to), confirmMerged(id) }
export const projects     = { list(), create(input) }
export const questions    = { list(recordId), answer(questionId, answer) }
```

> 每个 facade 沿用现有 `whenReady`/`unwrap` 模式（可选参数 codec 用 `.optional()`）。

## 2. 组件拆分（`src/client/`）

| 文件 | 内容 |
|---|---|
| `remote.ts`（改） | 三 namespace descriptors + zod + facade |
| `RequirementsPanel.tsx`（改） | 主视图：项目筛选 + 卡片 grid + 时间线 + 操作 |
| `RequirementCard.tsx`（新） | 单卡片：标题/描述/状态徽标/阶段时间线/操作按钮 |
| `StageTimeline.tsx`（新） | 折叠阶段时间线（category → 状态圆点/文字） |
| `QuestionModal.tsx`（新） | 待决策问答弹层（逐题） |
| `ProjectManager.tsx`（新） | 项目列表 + 新建项目表单（platform/prToken） |
| `RequirementFormModal.tsx`（新） | 登记需求（标题/描述/项目选择） |

## 3. 主视图状态与数据流

```ts
// RequirementsPanel
const [projectId, setProjectId] = useState<string | undefined>()   // 筛选
const [projects, setProjects] = useState<Project[]>([])            // 顶部下拉 + 项目管理
const [items, setItems] = useState<RequirementWithStages[]>([])
// refresh: projects.list() + requirements.list(projectId)
// 提交执行: requirements.transition(id, 'open')
// 已合并:   requirements.confirmMerged(id)
```

## 4. 交互细节

| 交互 | 实现 |
|---|---|
| 项目筛选 | 顶部 `Select`（projects），空=全部 |
| 登记需求 | 右上「添加需求」→ `RequirementFormModal`（标题必填、描述可选、项目下拉必选）→ `requirements.create(...)` 后刷新 |
| 提交执行 | 卡片 `draft`/`open` 显示「开始执行」→ `transition('open')` |
| 阶段时间线 | 卡片内 `StageTimeline`：`stages.map(category + status)`，running 转圈、failed 红、waiting_reply 橙、success 绿 |
| 待决策 | 卡片有 waiting_reply 阶段 → 「待决策」红点 → `QuestionModal(recordId)` |
| 问答弹层 | `QuestionModal`：`questions.list(recordId)` 逐题渲染（options 按钮 / 自由输入框）→ 提交调 `questions.answer` → 刷新 |
| merging | 卡片显示 PR 链接（stages 里 merge 的 prUrl）+ 「已合并」按钮 → `confirmMerged(id)` |

## 5. 卡片状态徽标（颜色映射）

| requirement.status | 徽标 | 说明 |
|---|---|---|
| draft | 灰「草稿」 | 未提交执行 |
| open | 蓝「排队中」 | 已提交，待领取 |
| in_progress | 蓝「执行中」 | 附当前阶段 |
| merging | 橙「待合并」 | 附 PR 链接 + 已合并按钮 |
| done | 绿「已完成」 | |
| cancelled | 灰「已取消」 | |

## 6. CSS（`RequirementsPanel.module.css` 追加）

```
.toolbar / .toolbarInfo / .grid / .card（已有）
.projectSelect / .stageTimeline / .stageRow / .stageDot(.running/.success/.failed/.waiting) / .prLink / .questionList / .questionOptions
```

## 7. 实现步骤

1. `remote.ts`：descriptors 扩展 + zod + 三 facade
2. `ProjectManager` + `RequirementFormModal`（登记/项目/筛选）
3. `RequirementCard` + `StageTimeline`（时间线/徽标/操作）
4. `QuestionModal`（问答）
5. `pnpm --filter @auto-coding/ui-requirements typecheck && build` + 契约回归测试（descriptor 对齐、可选参数 codec）

## 8. 验收

- 项目筛选/登记/新建（含 platform、prToken 输入）可用
- 卡片显示阶段时间线与状态徽标；waiting_reply 卡片可问答；merging 卡片有 PR 链接与「已合并」
- 提交执行/已合并 走 remote 且状态正确刷新；错误走 Banner
