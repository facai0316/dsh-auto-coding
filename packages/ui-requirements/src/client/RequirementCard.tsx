import { useState, type ReactElement } from 'react'
import Button from '@douyinfe/semi-ui/lib/es/button'
import Modal from '@douyinfe/semi-ui/lib/es/modal'
import Tag from '@douyinfe/semi-ui/lib/es/tag'
import Typography from '@douyinfe/semi-ui/lib/es/typography'
import classes from './RequirementsPanel.module.css'
import { requirements, type RequirementWithStages, type Status } from './remote.ts'
import { StageTimeline } from './StageTimeline.tsx'

const STATUS_LABEL: Record<Status, string> = {
  draft: '草稿',
  open: '排队中',
  in_progress: '执行中',
  merging: '待合并',
  done: '已完成',
  cancelled: '已取消',
  terminated: '已终止',
}

const STATUS_TAG_COLOR: Record<Status, 'white' | 'blue' | 'green' | 'grey' | 'orange'> = {
  draft: 'grey',
  open: 'blue',
  in_progress: 'blue',
  merging: 'orange',
  done: 'green',
  cancelled: 'grey',
  terminated: 'grey',
}

function messageOf(cause: unknown): string {
  if (cause instanceof Error) return cause.message
  return String(cause)
}

interface Props {
  item: RequirementWithStages
  busy: boolean
  onRefresh: () => void
  onAsk: (recordId: string, title: string) => void
  onResolve: (id: string) => void
  onRemove: () => void
}

/**
 * 单张需求卡片：状态徽标 + 描述 + 最近一条阶段 + 按状态的操作
 * （draft→提交执行；merging→解决冲突/已合并；待决策→打开问答）。
 * 需求创建后不允许更改（无编辑按钮）；操作区为 详情 / 删除。
 */
export function RequirementCard({ item, busy, onRefresh, onAsk, onResolve, onRemove }: Props): ReactElement {
  const [localBusy, setLocalBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [detailVisible, setDetailVisible] = useState(false)

  const run = async (operation: () => Promise<unknown>): Promise<void> => {
    if (busy || localBusy) return
    setLocalBusy(true)
    setError(null)
    try {
      await operation()
      await onRefresh()
    } catch (cause) {
      setError(messageOf(cause))
    } finally {
      setLocalBusy(false)
    }
  }

  const waitingRecord = item.stages.find(stage => stage.status === 'waiting_reply')
  const prUrl = item.stages.find(stage => stage.category === 'merge')?.prUrl
  const isBusy = busy || localBusy

  // 终止（不可逆）：确认后把需求及其未完成阶段一并标记终止。
  const terminate = (): void => {
    Modal.confirm({
      title: '终止需求',
      content: `确定终止「${item.title}」？此操作不可逆：需求状态变为「已终止」，所有未完成阶段记录也会标记为已终止，worker 不再执行。`,
      okText: '终止',
      okType: 'danger',
      onOk: () => run(() => requirements.transition(item.id, 'terminated')),
    })
  }

  return (
    <div className={classes.card}>
      <div className={classes.cardHead}>
        <Typography.Text
          className={classes.cardTitle}
          strong
          delete={item.status === 'done'}
          type={item.status === 'done' ? 'tertiary' : 'primary'}
          ellipsis
        >
          {item.title}
        </Typography.Text>
        <Tag size="small" color={STATUS_TAG_COLOR[item.status]}>{STATUS_LABEL[item.status]}</Tag>
      </div>

      {item.description !== null && item.description !== '' && (
        <Typography.Paragraph
          className={classes.cardDesc}
          ellipsis={{ rows: 2 }}
          type="tertiary"
        >
          {item.description}
        </Typography.Paragraph>
      )}

      {/* 卡片只展示最近一条阶段；完整时间线在「详情」弹层里 */}
      <StageTimeline stages={item.stages.slice(-1)} />

      {error !== null && (
        <Typography.Text type="danger" size="small">{error}</Typography.Text>
      )}

      <div className={classes.cardActions}>
        <Button size="small" theme="borderless" onClick={() => { setDetailVisible(true) }}>详情</Button>
        <Button size="small" theme="borderless" type="danger" disabled={isBusy} onClick={onRemove}>删除</Button>
        {item.status === 'draft' && (
          <Button size="small" theme="solid" disabled={isBusy} onClick={() => { void run(() => requirements.transition(item.id, 'open')) }}>
            提交执行
          </Button>
        )}
        {item.status === 'merging' && (
          <>
            <Button
              size="small"
              theme="solid"
              type="warning"
              disabled={isBusy || item.stages.some(stage => stage.category === 'resolve' && stage.status === 'running')}
              onClick={() => { onResolve(item.id) }}
            >
              解决冲突
            </Button>
            <Button size="small" theme="solid" disabled={isBusy} onClick={() => { void run(() => requirements.confirmMerged(item.id)) }}>
              已合并
            </Button>
          </>
        )}
        {waitingRecord !== undefined && item.status === 'in_progress' && (
          <Button size="small" theme="solid" type="warning" disabled={isBusy} onClick={() => { onAsk(waitingRecord.recordId, item.title) }}>
            待决策
          </Button>
        )}
        {prUrl !== undefined && prUrl !== null && item.status === 'merging' && (
          <Button size="small" theme="borderless" onClick={() => { window.open(prUrl, '_blank', 'noopener') }}>
            PR
          </Button>
        )}
        {item.status !== 'cancelled' && item.status !== 'terminated' && (
          <Button size="small" theme="borderless" type="danger" disabled={isBusy} onClick={terminate}>
            终止
          </Button>
        )}
      </div>

      <Modal
        title={`需求详情：${item.title}`}
        visible={detailVisible}
        width="80%"
        onCancel={() => { setDetailVisible(false) }}
        maskClosable={false}
        footer={<Button theme="borderless" onClick={() => { setDetailVisible(false) }}>关闭</Button>}
      >
        <div className={classes.form}>
          <div className={classes.formField}><label>状态</label><Tag size="small" color={STATUS_TAG_COLOR[item.status]}>{STATUS_LABEL[item.status]}</Tag></div>
          {item.projectId !== null && (
            <div className={classes.formField}><label>项目 ID</label><Typography.Text size="small">{item.projectId}</Typography.Text></div>
          )}
          <div className={classes.formField}><label>描述</label><Typography.Text>{item.description ?? '—'}</Typography.Text></div>
          <div className={classes.formField}>
            <label>阶段进度</label>
            <StageTimeline stages={item.stages} />
          </div>
          <div className={classes.formField}><label>创建时间</label><Typography.Text type="tertiary" size="small">{item.createdAt}</Typography.Text></div>
          <div className={classes.formField}><label>更新时间</label><Typography.Text type="tertiary" size="small">{item.updatedAt}</Typography.Text></div>
        </div>
      </Modal>
    </div>
  )
}
