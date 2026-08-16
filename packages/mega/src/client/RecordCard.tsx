import type { ReactElement } from 'react'
import Button from '@douyinfe/semi-ui/lib/es/button'
import Tag from '@douyinfe/semi-ui/lib/es/tag'
import Typography from '@douyinfe/semi-ui/lib/es/typography'
import classes from './RequirementsPanel.module.css'
import type { RecordListItem } from './remote.ts'
import { RECORD_STATUS_LABEL, STAGE_LABEL, recordStatusColor } from './board.ts'

interface Props {
  item: RecordListItem
  busy: boolean
  onDetail: () => void
  onEdit: () => void
  onRemove: () => void
}

/**
 * 运行记录卡片：需求标题 + 阶段 + 状态徽标 + 结果摘要，操作区 详情/编辑/删除。
 */
export function RecordCard({ item, busy, onDetail, onEdit, onRemove }: Props): ReactElement {
  return (
    <div className={classes.card}>
      <div className={classes.cardHead}>
        <Typography.Text className={classes.cardTitle} strong ellipsis type="primary">
          {item.requirementTitle ?? item.requirementId}
        </Typography.Text>
        <Tag size="small" color={recordStatusColor(item.status)}>{RECORD_STATUS_LABEL[item.status]}</Tag>
      </div>

      <Tag size="small">{STAGE_LABEL[item.category] ?? item.category}</Tag>

      {item.result !== null && item.result !== '' && (
        <Typography.Paragraph className={classes.cardDesc} ellipsis={{ rows: 2 }} type="tertiary">
          {item.result}
        </Typography.Paragraph>
      )}

      <Typography.Text size="small" type="tertiary">{item.updatedAt}</Typography.Text>

      <div className={classes.cardActions}>
        <Button size="small" theme="borderless" onClick={onDetail}>详情</Button>
        <Button size="small" theme="borderless" disabled={busy} onClick={onEdit}>编辑</Button>
        <Button size="small" theme="borderless" type="danger" disabled={busy} onClick={onRemove}>删除</Button>
      </div>
    </div>
  )
}
