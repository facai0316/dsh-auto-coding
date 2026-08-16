import { useEffect, useState, type ReactElement } from 'react'
import Button from '@douyinfe/semi-ui/lib/es/button'
import Input from '@douyinfe/semi-ui/lib/es/input'
import Modal from '@douyinfe/semi-ui/lib/es/modal'
import Select from '@douyinfe/semi-ui/lib/es/select'
import Typography from '@douyinfe/semi-ui/lib/es/typography'
import classes from './RequirementsPanel.module.css'
import type { RecordListItem, RecordStatus, RequirementWithStages } from './remote.ts'
import { CATEGORIES, RECORD_STATUSES, RECORD_STATUS_LABEL, STAGE_LABEL } from './board.ts'

export interface RecordInput {
  requirementId: string
  category: string
  status: RecordStatus
  result?: string
}

interface Props {
  visible: boolean
  /** 传入则进入编辑模式（只改 status/result），否则为新建。 */
  initial?: RecordListItem | null
  requirements: readonly RequirementWithStages[]
  busy: boolean
  onClose: () => void
  onSubmit: (input: RecordInput) => Promise<void>
}

/**
 * 运行记录表单（新建 / 编辑复用）。新建：选需求 + 阶段 + 状态 + 结果；
 * 编辑：只改状态与结果（阶段/需求不可改）。
 */
export function RecordFormModal({ visible, initial = null, requirements, busy, onClose, onSubmit }: Props): ReactElement {
  const [requirementId, setRequirementId] = useState<string | undefined>()
  const [category, setCategory] = useState<string>(CATEGORIES[0] ?? 'decision')
  const [status, setStatus] = useState<RecordStatus>('running')
  const [result, setResult] = useState('')
  const [error, setError] = useState<string | null>(null)

  const editing = initial !== null && initial !== undefined

  useEffect(() => {
    if (!visible) return
    setError(null)
    if (editing && initial !== null && initial !== undefined) {
      setRequirementId(initial.requirementId)
      setCategory(initial.category)
      setStatus(initial.status)
      setResult(initial.result ?? '')
    } else {
      setRequirementId(requirements[0]?.id)
      setCategory(CATEGORIES[0] ?? 'decision')
      setStatus('running')
      setResult('')
    }
  }, [visible, initial, requirements, editing])

  const submit = async (): Promise<void> => {
    setError(null)
    try {
      await onSubmit({
        requirementId: requirementId!,
        category,
        status,
        result: result.trim() === '' ? undefined : result.trim(),
      })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const canSubmit = !editing ? (requirementId !== undefined) : true

  return (
    <Modal
      title={editing ? `编辑运行记录：${STAGE_LABEL[category] ?? category}` : '新增运行记录'}
      visible={visible}
      onCancel={onClose}
      maskClosable={false}
      footer={(
        <>
          <Button theme="borderless" disabled={busy} onClick={onClose}>取消</Button>
          <Button theme="solid" disabled={!canSubmit || busy} onClick={() => { void submit() }}>
            {editing ? '保存' : '创建'}
          </Button>
        </>
      )}
    >
      {error !== null && <Typography.Text type="danger" size="small">{error}</Typography.Text>}
      <div className={classes.form}>
        {!editing && (
          <div className={classes.formField}>
            <label>需求</label>
            <Select
              className={classes.projectSelect}
              value={requirementId}
              onChange={(value) => { setRequirementId(value as string) }}
              optionList={requirements.map(r => ({ value: r.id, label: r.title }))}
              placeholder="选择需求"
            />
          </div>
        )}
        {!editing && (
          <div className={classes.formField}>
            <label>阶段</label>
            <Select
              className={classes.projectSelect}
              value={category}
              onChange={(value) => { setCategory(value as string) }}
              optionList={CATEGORIES.map(c => ({ value: c, label: STAGE_LABEL[c] ?? c }))}
            />
          </div>
        )}
        <div className={classes.formField}>
          <label>状态</label>
          <Select
            className={classes.projectSelect}
            value={status}
            onChange={(value) => { setStatus(value as RecordStatus) }}
            optionList={RECORD_STATUSES.map(s => ({ value: s, label: RECORD_STATUS_LABEL[s] }))}
          />
        </div>
        <div className={classes.formField}>
          <label>结果（可选）</label>
          <Input value={result} onChange={(value) => { setResult(value) }} placeholder="阶段结果摘要" />
        </div>
      </div>
    </Modal>
  )
}
