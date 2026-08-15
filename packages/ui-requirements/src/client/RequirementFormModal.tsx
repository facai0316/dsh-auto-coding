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
  onSubmit: (title: string, description: string | undefined, projectId: string) => void
}

/** 登记需求：标题（必填）+ 描述（可选）+ 项目（必选，draft 挂项目）。 */
export function RequirementFormModal({ visible, projects, busy, onClose, onSubmit }: Props): ReactElement {
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [projectId, setProjectId] = useState<string | undefined>()

  useEffect(() => {
    if (visible) {
      setTitle('')
      setDescription('')
      setProjectId(projects[0]?.id)
    }
  }, [visible, projects])

  return (
    <Modal
      title="添加需求"
      visible={visible}
      onCancel={onClose}
      maskClosable={false}
      footer={(
        <>
          <Button theme="borderless" disabled={busy} onClick={onClose}>取消</Button>
          <Button
            theme="solid"
            disabled={title.trim() === '' || projectId === undefined || busy}
            onClick={() => {
              onSubmit(title.trim(), description.trim() === '' ? undefined : description.trim(), projectId!)
            }}
          >
            添加
          </Button>
        </>
      )}
    >
      <div className={classes.form}>
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
          <label>描述（可选）</label>
          <TextArea value={description} onChange={(value) => { setDescription(value) }} placeholder="补充背景、验收标准等…" rows={3} />
        </div>
      </div>
    </Modal>
  )
}
