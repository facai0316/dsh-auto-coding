import { useCallback, useEffect, useState, type ReactElement } from 'react'
// Deep per-component imports, not the barrel: semi marks lib/es/index.js as
// side-effectful (sideEffects list), which defeats tree-shaking through the
// barrel and drags the whole library (tiptap included) into the bundle.
import Button from '@douyinfe/semi-ui/lib/es/button'
import Empty from '@douyinfe/semi-ui/lib/es/empty'
import Select from '@douyinfe/semi-ui/lib/es/select'
import Spin from '@douyinfe/semi-ui/lib/es/spin'
import Tag from '@douyinfe/semi-ui/lib/es/tag'
import Typography from '@douyinfe/semi-ui/lib/es/typography'
import classes from './RequirementsPanel.module.css'
import { projects, requirements, type Project, type RequirementWithStages } from './remote.ts'
import { RequirementCard } from './RequirementCard.tsx'
import { RequirementFormModal } from './RequirementFormModal.tsx'
import { QuestionModal } from './QuestionModal.tsx'
import { ProjectManager } from './ProjectManager.tsx'

function messageOf(cause: unknown): string {
  if (cause instanceof Error) return cause.message
  return String(cause)
}

interface AskTarget {
  recordId: string
  title: string
}

/**
 * 需求面板 → 流水线控制台：项目筛选 + 项目管理入口 + 登记需求 + 卡片 grid
 * （状态徽标 / 阶段时间线 / 提交执行 / 已合并 / 待决策问答）。数据经
 * cm-flow 三 namespace remote 落 cm 库。
 */
export function RequirementsPanel(): ReactElement {
  const [projectList, setProjectList] = useState<readonly Project[]>([])
  const [projectId, setProjectId] = useState<string | undefined>()
  const [items, setItems] = useState<readonly RequirementWithStages[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [formVisible, setFormVisible] = useState(false)
  const [managerVisible, setManagerVisible] = useState(false)
  const [askTarget, setAskTarget] = useState<AskTarget | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [projectRows, requirementRows] = await Promise.all([
        projects.list(),
        requirements.list(projectId),
      ])
      setProjectList(projectRows)
      setItems(requirementRows)
    } catch (cause) {
      setError(messageOf(cause))
    } finally {
      setLoading(false)
    }
  }, [projectId])

  useEffect(() => { void refresh() }, [refresh])

  const submitCreate = useCallback(async (title: string, description: string | undefined, targetProjectId: string) => {
    try {
      await requirements.create(title, description, targetProjectId)
      setFormVisible(false)
      await refresh()
    } catch (cause) {
      setError(messageOf(cause))
    }
  }, [refresh])

  const done = items.filter(item => item.status === 'done').length

  return (
    <div className={classes.panel}>
      <div className={classes.toolbar}>
        <div className={classes.projectBar}>
          <Select
            className={classes.projectSelect}
            value={projectId}
            onChange={(value) => { setProjectId(value as string | undefined) }}
            optionList={[
              { value: undefined, label: '全部项目' },
              ...projectList.map(project => ({ value: project.id, label: project.name })),
            ]}
            placeholder="筛选项目"
          />
          <Button theme="borderless" disabled={loading} onClick={() => { setManagerVisible(true) }}>项目管理</Button>
          <Tag size="small" color="white">共 {items.length} 条</Tag>
          <Tag size="small" color="green">已完成 {done} 条</Tag>
        </div>
        <Button theme="solid" disabled={loading} onClick={() => { setFormVisible(true) }}>添加需求</Button>
      </div>

      {error !== null && (
        <div className={classes.error}>
          <Typography.Text type="danger">{error}</Typography.Text>
          <Button size="small" theme="borderless" onClick={() => { void refresh() }}>重试</Button>
        </div>
      )}

      {loading
        ? (
          <div className={classes.center}>
            <Spin />
          </div>
        )
        : items.length === 0
          ? (
            <div className={classes.center}>
              <Empty description="暂无需求。点击右上角「添加需求」开始。" />
            </div>
          )
          : (
            <div className={classes.grid}>
              {items.map(item => (
                <RequirementCard
                  key={item.id}
                  item={item}
                  onRefresh={refresh}
                  onAsk={(recordId, title) => { setAskTarget({ recordId, title }) }}
                />
              ))}
            </div>
          )}

      <div className={classes.foot}>
        <Typography.Text type="tertiary" size="small">流水线状态持久化于 cm 库</Typography.Text>
      </div>

      <RequirementFormModal
        visible={formVisible}
        projects={projectList}
        busy={loading}
        onClose={() => { setFormVisible(false) }}
        onSubmit={(title, description, targetProjectId) => { void submitCreate(title, description, targetProjectId) }}
      />
      <ProjectManager
        visible={managerVisible}
        busy={loading}
        onClose={() => { setManagerVisible(false) }}
        onChanged={() => { void refresh() }}
      />
      {askTarget !== null && (
        <QuestionModal
          recordId={askTarget.recordId}
          title={askTarget.title}
          onClose={() => { setAskTarget(null) }}
          onAnswered={() => { void refresh() }}
        />
      )}
    </div>
  )
}