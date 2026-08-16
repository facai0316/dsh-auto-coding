import { useCallback, useEffect, useState, type ReactElement } from 'react'
import Button from '@douyinfe/semi-ui/lib/es/button'
import Input from '@douyinfe/semi-ui/lib/es/input'
import TextArea from '@douyinfe/semi-ui/lib/es/input/textarea'
import Modal from '@douyinfe/semi-ui/lib/es/modal'
import Spin from '@douyinfe/semi-ui/lib/es/spin'
import Tag from '@douyinfe/semi-ui/lib/es/tag'
import Typography from '@douyinfe/semi-ui/lib/es/typography'
import classes from './RequirementsPanel.module.css'
import {
  merge,
  questions,
  requirements,
  reviews,
  type Question,
  type RecordListItem,
  type RequirementWithStages,
  type Review,
} from './remote.ts'
import { STAGE_LABEL } from './board.ts'

function messageOf(cause: unknown): string {
  if (cause instanceof Error) return cause.message
  return String(cause)
}

/** 一条等待决策的运行记录：record + 全部问题 + 对应的 pending reply 审核单。 */
export interface ReplyItem {
  record: RecordListItem
  questions: Question[]
  /** 该 record 的 pending reply 审核单（答完才能通过）。 */
  ticket: Review | undefined
}

interface Props {
  /** kind='review' 的 pending 人工审核单（ADR/计划等产物门禁）。 */
  reviewGates: readonly Review[]
  /** waiting_reply 记录（待决策问答 + 放行审核）。 */
  replyItems: readonly ReplyItem[]
  merging: readonly RequirementWithStages[]
  loading: boolean
  onChanged: () => void
  onError: (message: string | null) => void
}

function prUrlOf(item: RequirementWithStages): string | undefined {
  const url = item.stages.find(stage => stage.category === 'merge')?.prUrl
  return url === undefined || url === null ? undefined : url
}

interface DetailField {
  label: string
  value: string
}

/**
 * 审核详情弹层：width=80%、高度不限（内容区纵向滚动），全文展示不再靠 tooltip。
 */
function HallDetailModal({ title, fields, tags, onClose }: {
  title: string
  fields: readonly DetailField[]
  tags?: readonly string[]
  onClose: () => void
}): ReactElement {
  return (
    <Modal
      title={title}
      visible
      width="80%"
      onCancel={onClose}
      maskClosable={false}
      footer={<Button theme="borderless" onClick={onClose}>关闭</Button>}
    >
      <div className={classes.form} style={{ maxHeight: '75vh', overflowY: 'auto' }}>
        {fields.map(field => (
          <div key={field.label} className={classes.formField}>
            <label>{field.label}</label>
            <Typography.Text style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
              {field.value}
            </Typography.Text>
          </div>
        ))}
        {tags !== undefined && tags.length > 0 && (
          <div className={classes.formField}>
            <label>产物</label>
            <div className={classes.tagList}>{tags.map((tag, index) => <Tag key={index} size="small">{tag}</Tag>)}</div>
          </div>
        )}
      </div>
    </Modal>
  )
}

/**
 * 审核大厅：聚合所有需要人处理的事项——
 * ① 待审核：ADR/计划等产物的人工审核门（通过 / 驳回带整改意见，驳回后 worker 携反馈重跑）；
 * ② 待决策：waiting_reply 记录，逐题作答，全部答完才能「审核通过」放行续跑；
 * ③ 待合并：merging 需求的 PR 链接 + 「已合并」确认。
 */
export function ReviewHall({ reviewGates, replyItems, merging, loading, onChanged, onError }: Props): ReactElement {
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [feedbackDrafts, setFeedbackDrafts] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [gateDetail, setGateDetail] = useState<Review | null>(null)

  // 每次打开审核页都拉最新状态（worker 可能刚把某条推进/挂起）。
  useEffect(() => { onChanged() }, [onChanged])

  const answer = useCallback(async (question: Question, value: string) => {
    const trimmed = value.trim()
    if (trimmed === '' || busy) return
    setBusy(true)
    onError(null)
    try {
      await questions.answer(question.id, trimmed)
      onChanged()
    } catch (cause) {
      onError(messageOf(cause))
    } finally {
      setBusy(false)
    }
  }, [busy, onChanged, onError])

  const approve = useCallback(async (ticket: Review) => {
    if (busy) return
    setBusy(true)
    onError(null)
    try {
      await reviews.approve(ticket.id)
      onChanged()
    } catch (cause) {
      onError(messageOf(cause))
    } finally {
      setBusy(false)
    }
  }, [busy, onChanged, onError])

  const reject = useCallback(async (ticket: Review) => {
    const feedback = (feedbackDrafts[ticket.id] ?? '').trim()
    if (feedback === '' || busy) return
    setBusy(true)
    onError(null)
    try {
      await reviews.reject(ticket.id, feedback)
      setFeedbackDrafts(prev => ({ ...prev, [ticket.id]: '' }))
      onChanged()
    } catch (cause) {
      onError(messageOf(cause))
    } finally {
      setBusy(false)
    }
  }, [busy, feedbackDrafts, onChanged, onError])

  const confirmMerged = useCallback(async (id: string) => {
    if (busy) return
    setBusy(true)
    onError(null)
    try {
      await requirements.confirmMerged(id)
      onChanged()
    } catch (cause) {
      onError(messageOf(cause))
    } finally {
      setBusy(false)
    }
  }, [busy, onChanged, onError])

  const resolveConflicts = useCallback(async (id: string) => {
    if (busy) return
    setBusy(true)
    onError(null)
    try {
      await merge.resolveConflicts(id)
      onChanged()
    } catch (cause) {
      onError(messageOf(cause))
    } finally {
      setBusy(false)
    }
  }, [busy, onChanged, onError])

  const idle = reviewGates.length === 0 && replyItems.length === 0 && merging.length === 0

  return (
    <div className={classes.page}>
      {loading
        ? <div className={classes.center}><Spin /></div>
        : idle
          ? <div className={classes.center}><Typography.Text type="tertiary">暂无待审核事项，一切顺利 🎉</Typography.Text></div>
          : (
            <>
              {reviewGates.length > 0 && (
                <section>
                  <div className={classes.sectionTitle}><Typography.Text strong>待我审核（{reviewGates.length}）</Typography.Text></div>
                  <div className={classes.reviewList}>
                    {reviewGates.map(ticket => (
                      <div key={ticket.id} className={classes.card}>
                        <div className={classes.cardHead}>
                          <Typography.Text className={classes.cardTitle} strong>
                            {ticket.requirementTitle ?? ticket.requirementId}
                          </Typography.Text>
                          <div className={classes.cardHeadActions}>
                            <Button size="small" theme="borderless" onClick={() => { setGateDetail(ticket) }}>
                              查看详情
                            </Button>
                            <Tag size="small" color="orange">{STAGE_LABEL[ticket.category] ?? ticket.category} · 待审核</Tag>
                          </div>
                        </div>
                        {ticket.result !== null && ticket.result !== '' && (
                          <Typography.Paragraph className={classes.cardDesc} ellipsis={{ rows: 2 }} type="tertiary">
                            {ticket.result}
                          </Typography.Paragraph>
                        )}
                        {ticket.artifacts.length > 0 && (
                          <div className={classes.tagList}>
                            {ticket.artifacts.map((artifact, index) => <Tag key={index} size="small">{artifact}</Tag>)}
                          </div>
                        )}
                        <TextArea
                          className={classes.reviewFeedback}
                          rows={2}
                          maxCount={500}
                          value={feedbackDrafts[ticket.id] ?? ''}
                          onChange={(value) => { setFeedbackDrafts(prev => ({ ...prev, [ticket.id]: value })) }}
                          placeholder="驳回时填写整改意见（必填）…"
                        />
                        <div className={classes.reviewActions}>
                          <Button size="small" theme="solid" disabled={busy} onClick={() => { void approve(ticket) }}>
                            通过
                          </Button>
                          <Button size="small" theme="solid" type="danger" disabled={busy} onClick={() => { void reject(ticket) }}>
                            驳回
                          </Button>
                        </div>
                      </div>
                    ))}
                  </div>
                </section>
              )}

              {replyItems.length > 0 && (
                <section>
                  <div className={classes.sectionTitle}><Typography.Text strong>待我决策（{replyItems.length}）</Typography.Text></div>
                  <div className={classes.reviewList}>
                    {replyItems.map(item => (
                      <ReplyCard key={item.record.id} item={item} drafts={drafts} busy={busy}
                        onDraft={(questionId, value) => { setDrafts(prev => ({ ...prev, [questionId]: value })) }}
                        onAnswer={answer} onApprove={approve} onError={onError}
                      />
                    ))}
                  </div>
                </section>
              )}

              {merging.length > 0 && (
                <section>
                  <div className={classes.sectionTitle}><Typography.Text strong>待我合并（{merging.length}）</Typography.Text></div>
                  <div className={classes.reviewList}>
                    {merging.map(item => {
                      // stages 按 created_at 升序；取最近一条 resolve 记录。
                      const resolveStages = item.stages.filter(stage => stage.category === 'resolve')
                      const resolveStage = resolveStages[resolveStages.length - 1]
                      const resolving = resolveStage?.status === 'running'
                      return (
                        <div key={item.id} className={classes.card}>
                          <div className={classes.cardHead}>
                            <Typography.Text className={classes.cardTitle} strong>{item.title}</Typography.Text>
                            <div className={classes.cardHeadActions}>
                              {resolveStage?.status === 'success' && <Tag size="small" color="green">冲突已解决</Tag>}
                              {resolveStage?.status === 'waiting_reply' && <Tag size="small" color="orange">冲突解决待决策</Tag>}
                              {resolving && <Tag size="small" color="blue">冲突解决中…</Tag>}
                              <Tag size="small" color="orange">待合并</Tag>
                            </div>
                          </div>
                          {item.description !== null && item.description !== '' && (
                            <Typography.Paragraph className={classes.cardDesc} ellipsis={{ rows: 2 }} type="tertiary">
                              {item.description}
                            </Typography.Paragraph>
                          )}
                          <div className={classes.cardActions}>
                            {prUrlOf(item) !== undefined && (
                              <Button size="small" theme="borderless" onClick={() => { window.open(prUrlOf(item), '_blank', 'noopener') }}>
                                打开 PR
                              </Button>
                            )}
                            <Button
                              size="small"
                              theme="solid"
                              type="warning"
                              disabled={busy || resolving}
                              onClick={() => { void resolveConflicts(item.id) }}
                            >
                              解决冲突
                            </Button>
                            <Button size="small" theme="solid" disabled={busy} onClick={() => { void confirmMerged(item.id) }}>
                              已合并
                            </Button>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                </section>
              )}
            </>
          )}
      {gateDetail !== null && (
        <HallDetailModal
          title={`审核详情：${STAGE_LABEL[gateDetail.category] ?? gateDetail.category} · ${gateDetail.requirementTitle ?? gateDetail.requirementId}`}
          fields={[
            { label: '需求', value: gateDetail.requirementTitle ?? gateDetail.requirementId },
            { label: '阶段', value: `${STAGE_LABEL[gateDetail.category] ?? gateDetail.category} · 待审核` },
            { label: '审核单', value: `${gateDetail.kind === 'reply' ? '放行审核' : '人工审核'} · ${gateDetail.status}` },
            ...(gateDetail.result !== null && gateDetail.result !== '' ? [{ label: '结论 / 摘要', value: gateDetail.result }] : []),
            { label: '创建时间', value: gateDetail.createdAt },
          ]}
          tags={gateDetail.artifacts}
          onClose={() => { setGateDetail(null) }}
        />
      )}
    </div>
  )
}

interface ReplyCardProps {
  item: ReplyItem
  drafts: Record<string, string>
  busy: boolean
  onDraft: (questionId: string, value: string) => void
  onAnswer: (question: Question, value: string) => void
  onApprove: (ticket: Review) => void
  onError: (message: string | null) => void
}

/** 单条 waiting_reply 卡片：逐题作答，全部答完出现「审核通过」放行。 */
function ReplyCard({ item, drafts, busy, onDraft, onAnswer, onApprove, onError }: ReplyCardProps): ReactElement {
  const [localBusy, setLocalBusy] = useState(false)
  const [localError, setLocalError] = useState<string | null>(null)
  const [detailOpen, setDetailOpen] = useState(false)
  const pending = item.questions.filter(question => question.status === 'pending')
  const allAnswered = pending.length === 0

  const run = async (operation: () => Promise<unknown> | void): Promise<void> => {
    if (busy || localBusy) return
    setLocalBusy(true)
    setLocalError(null)
    try {
      await operation()
    } catch (cause) {
      setLocalError(messageOf(cause))
      onError(messageOf(cause))
    } finally {
      setLocalBusy(false)
    }
  }

  return (
    <div className={classes.card}>
      <div className={classes.cardHead}>
        <Typography.Text className={classes.cardTitle} strong>
          {item.record.requirementTitle ?? item.record.requirementId}
        </Typography.Text>
        <div className={classes.cardHeadActions}>
          <Button size="small" theme="borderless" onClick={() => { setDetailOpen(true) }}>
            查看详情
          </Button>
          <Tag size="small" color="orange">{STAGE_LABEL[item.record.category] ?? item.record.category} · 待决策</Tag>
        </div>
      </div>
      {item.record.result !== null && item.record.result !== '' && (
        <Typography.Paragraph className={classes.cardDesc} ellipsis={{ rows: 2 }} type="tertiary">
          {item.record.result}
        </Typography.Paragraph>
      )}
      <div className={classes.questionList}>
        {item.questions.map((question, index) => {
          if (question.status === 'answered') {
            return (
              <div key={question.id} className={classes.questionItem}>
                <Typography.Text className={classes.questionText}>{index + 1}. {question.question}</Typography.Text>
                <Typography.Text type="success" size="small">✓ {question.answer}</Typography.Text>
              </div>
            )
          }
          return (
            <div key={question.id} className={classes.questionItem}>
              <Typography.Text className={classes.questionText}>{index + 1}. {question.question}</Typography.Text>
              {question.options.length > 0 && (
                <div className={classes.questionOptions}>
                  {question.options.map(option => (
                    <Button key={option} size="small" theme="outline" disabled={busy || localBusy} onClick={() => { void run(() => onAnswer(question, option)) }}>
                      {option}
                    </Button>
                  ))}
                </div>
              )}
              <Input
                value={drafts[question.id] ?? ''}
                onChange={(value) => { onDraft(question.id, value) }}
                placeholder="输入回答后回车…"
                onEnterPress={() => { void run(() => onAnswer(question, drafts[question.id] ?? '')) }}
              />
            </div>
          )
        })}
      </div>
      {localError !== null && <Typography.Text type="danger" size="small">{localError}</Typography.Text>}
      {allAnswered && (
        <div className={classes.reviewActions}>
          {item.ticket === undefined
            ? <Typography.Text type="tertiary" size="small">已答完，等待 worker 处理…</Typography.Text>
            : (
              <>
                <Typography.Text type="tertiary" size="small">已答完，审核通过后进入下一轮续跑</Typography.Text>
                <Button size="small" theme="solid" disabled={busy || localBusy} onClick={() => { void run(() => onApprove(item.ticket!)) }}>
                  审核通过
                </Button>
              </>
            )}
        </div>
      )}
      {detailOpen && (
        <HallDetailModal
          title={`详情：${STAGE_LABEL[item.record.category] ?? item.record.category} · ${item.record.requirementTitle ?? item.record.requirementId}`}
          fields={[
            { label: '需求', value: item.record.requirementTitle ?? item.record.requirementId },
            { label: '阶段', value: `${STAGE_LABEL[item.record.category] ?? item.record.category} · 待决策` },
            ...(item.record.result !== null && item.record.result !== '' ? [{ label: '结果', value: item.record.result }] : []),
            ...(item.questions.length > 0
              ? [{
                label: '问题与答复',
                value: item.questions.map(question =>
                  `Q: ${question.question}\n${question.status === 'answered' ? `A: ${question.answer ?? ''}` : '（未作答）'}`,
                ).join('\n\n'),
              }]
              : []),
            { label: '创建时间', value: item.record.createdAt },
            { label: '更新时间', value: item.record.updatedAt },
          ]}
          tags={item.record.artifacts}
          onClose={() => { setDetailOpen(false) }}
        />
      )}
    </div>
  )
}
