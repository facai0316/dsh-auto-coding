import { useCallback, useState, type ReactElement } from 'react'
import Button from '@douyinfe/semi-ui/lib/es/button'
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
}

const STATUS_TAG_COLOR: Record<Status, 'white' | 'blue' | 'green' | 'grey' | 'orange'> = {
  draft: 'grey',
  open: 'blue',
  in_progress: 'blue',
  merging: 'orange',
  done: 'green',
  cancelled: 'grey',
}

function messageOf(cause: unknown): string {
  if (cause instanceof Error) return cause.message
  return String(cause)
}

interface Props {
  item: RequirementWithStages
  onRefresh: () => Promise<void>
  onAsk: (recordId: string, title: string) => void
}

/**
 * 单张需求卡片：状态徽标 + 描述 + 阶段时间线 + 按状态的操作
 * （draft→提交执行；merging→已合并；draft/open→删除；待决策→打开问答）。
 */
export function RequirementCard({ item, onRefresh, onAsk }: Props): ReactElement {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const run = useCallback(async (operation: () => Promise<unknown>) => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await operation()
      await onRefresh()
    } catch (cause) {
      setError(messageOf(cause))
    } finally {
      setBusy(false)
    }
  }, [busy, onRefresh])

  const waitingRecord = item.stages.find(stage => stage.status === 'waiting_reply')
  const prUrl = item.stages.find(stage => stage.category === 'merge')?.prUrl

  return (
    <div className={classes.card}>
      <div className={classes.cardHead}>
        <Typography.Text
          className={classes.cardTitle}
          strong
          delete={item.status === 'done'}
          type={item.status === 'done' ? 'tertiary' : 'primary'}
          ellipsis={{ showTooltip: true }}
        >
          {item.title}
        </Typography.Text>
        <Tag size="small" color={STATUS_TAG_COLOR[item.status]}>{STATUS_LABEL[item.status]}</Tag>
      </div>

      {item.description !== null && item.description !== '' && (
        <Typography.Paragraph
          className={classes.cardDesc}
          ellipsis={{ rows: 2, showTooltip: true }}
          type="tertiary"
        >
          {item.description}
        </Typography.Paragraph>
      )}

      <StageTimeline stages={item.stages} />

      {error !== null && (
        <Typography.Text type="danger" size="small">{error}</Typography.Text>
      )}

      <div className={classes.cardActions}>
        {item.status === 'draft' && (
          <Button size="small" theme="solid" disabled={busy} onClick={() => { void run(() => requirements.transition(item.id, 'open')) }}>
            提交执行
          </Button>
        )}
        {item.status === 'merging' && (
          <Button size="small" theme="solid" disabled={busy} onClick={() => { void run(() => requirements.confirmMerged(item.id)) }}>
            已合并
          </Button>
        )}
        {waitingRecord !== undefined && item.status === 'in_progress' && (
          <Button size="small" theme="solid" type="warning" disabled={busy} onClick={() => { onAsk(waitingRecord.recordId, item.title) }}>
            待决策
          </Button>
        )}
        {(item.status === 'draft' || item.status === 'open') && (
          <Button size="small" theme="borderless" type="danger" disabled={busy} onClick={() => { void run(() => requirements.transition(item.id, 'cancelled')) }}>
            删除
          </Button>
        )}
        {prUrl !== undefined && item.status === 'merging' && (
          <Button size="small" theme="borderless" onClick={() => { window.open(prUrl, '_blank', 'noopener') }}>
            PR
          </Button>
        )}
      </div>
    </div>
  )
}
