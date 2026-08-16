/**
 * 自动化看板共享常量：阶段分类 / 运行状态的中文标签与颜色。
 */
import type { RecordStatus } from './remote.ts'

export const STAGE_LABEL: Record<string, string> = {
  decision: '决策',
  plan: '计划',
  'review-plan': '计划审核',
  coding: '编码',
  contract: '契约',
  'review-code': '代码审核',
  merge: '合并',
  resolve: '冲突解决',
  cleanup: '清理',
}

export const CATEGORIES = ['decision', 'plan', 'review-plan', 'coding', 'contract', 'review-code', 'merge', 'resolve', 'cleanup']

export const RECORD_STATUSES: readonly RecordStatus[] = ['running', 'success', 'failed', 'waiting_reply', 'retrying', 'waiting_review', 'terminated']
export const RECORD_STATUS_LABEL: Record<RecordStatus, string> = {
  running: '执行中',
  success: '完成',
  failed: '失败',
  waiting_reply: '待决策',
  retrying: '重试中',
  waiting_review: '待审核',
  terminated: '已终止',
}

export function recordStatusColor(status: RecordStatus): 'blue' | 'green' | 'red' | 'orange' | 'grey' {
  switch (status) {
    case 'running': return 'blue'
    case 'success': return 'green'
    case 'failed': return 'red'
    case 'waiting_reply': return 'orange'
    case 'retrying': return 'orange'
    case 'waiting_review': return 'orange'
    case 'terminated': return 'grey'
  }
}
