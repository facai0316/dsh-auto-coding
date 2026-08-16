import type { ReactElement } from 'react'
import Typography from '@douyinfe/semi-ui/lib/es/typography'
import classes from './RequirementsPanel.module.css'
import type { StageSummary } from './remote.ts'

const STAGE_LABEL: Record<string, string> = {
  decision: '决策',
  plan: '计划',
  'review-plan': '计划审核',
  coding: '编码',
  contract: '契约',
  'review-code': '代码审核',
  merge: '合并',
  cleanup: '清理',
}

const STAGE_STATUS_LABEL: Record<string, string> = {
  running: '执行中',
  success: '完成',
  failed: '失败',
  waiting_reply: '待决策',
  waiting_review: '待审核',
  retrying: '重试中',
}

/**
 * 折叠的阶段时间线：每个阶段一个状态圆点 + 名称 + 状态文字。
 */
export function StageTimeline({ stages }: { stages: readonly StageSummary[] }): ReactElement | null {
  if (stages.length === 0) return null
  return (
    <div className={classes.stageTimeline}>
      {stages.map((stage, index) => (
        <div key={`${stage.category}-${index}`} className={classes.stageRow}>
          <span className={`${classes.stageDot} ${classes[`stageDot.${stage.status}`] ?? ''}`} />
          <Typography.Text size="small">{STAGE_LABEL[stage.category] ?? stage.category}</Typography.Text>
          <Typography.Text size="small" type="tertiary">
            {STAGE_STATUS_LABEL[stage.status] ?? stage.status}
          </Typography.Text>
        </div>
      ))}
    </div>
  )
}
