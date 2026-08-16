import { useEffect, useState, type ReactElement } from 'react'
import Button from '@douyinfe/semi-ui/lib/es/button'
import Input from '@douyinfe/semi-ui/lib/es/input'
import TextArea from '@douyinfe/semi-ui/lib/es/input/textarea'
import Modal from '@douyinfe/semi-ui/lib/es/modal'
import Select from '@douyinfe/semi-ui/lib/es/select'
import classes from './RequirementsPanel.module.css'
import type { Project } from './remote.ts'

interface Props {
  visible: boolean
  projects: readonly Project[]
  busy: boolean
  onClose: () => void
  /** 需求创建提交：描述必填。 */
  onSubmit: (title: string, description: string, projectId: string) => void
}

/**
 * 需求新增表单（需求创建后不允许更改）：项目 + 标题 + 描述（必填）。
 * 弹层 80% 宽、高度不限（内容区纵向滚动）。
 */
export function RequirementFormModal({ visible, projects, busy, onClose, onSubmit }: Props): ReactElement {
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [projectId, setProjectId] = useState<string | undefined>()

  useEffect(() => {
    if (!visible) return
    setTitle('')
    setDescription('')
    setProjectId(projects[0]?.id)
  }, [visible, projects])

  return (
    <Modal
      title="添加需求"
      visible={visible}
      width="80%"
      onCancel={onClose}
      maskClosable={false}
      footer={(
        <>
          <Button theme="borderless" disabled={busy} onClick={onClose}>取消</Button>
          <Button
            theme="solid"
            disabled={title.trim() === '' || description.trim() === '' || projectId === undefined || busy}
            onClick={() => {
              onSubmit(title.trim(), description.trim(), projectId!)
            }}
          >
            添加
          </Button>
        </>
      )}
    >
      <div className={classes.form} style={{ maxHeight: '75vh', overflowY: 'auto' }}>
        <div className={classes.formField}>
          <label>项目</label>
          <Select
            className={classes.projectSelect}
            value={projectId}
            onChange={(value) => { setProjectId(value as string) }}
            optionList={projects.map(project => ({ value: project.id, label: project.name }))}
            placeholder="选择项目"
          />
        </div>
        <div className={classes.formField}>
          <label>标题</label>
          <Input value={title} onChange={(value) => { setTitle(value) }} placeholder="需求标题，如：实现 XX 功能" autoFocus />
        </div>
        <div className={classes.formField}>
          <label>描述（必填）</label>
          <TextArea
            value={description}
            onChange={(value) => { setDescription(value) }}
            placeholder="补充背景、目标、验收标准等…"
            rows={4}
          />
        </div>
      </div>
    </Modal>
  )
}
