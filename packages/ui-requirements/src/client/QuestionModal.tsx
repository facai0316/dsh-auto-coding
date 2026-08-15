import { useCallback, useEffect, useState, type ReactElement } from 'react'
import Button from '@douyinfe/semi-ui/lib/es/button'
import Input from '@douyinfe/semi-ui/lib/es/input'
import Modal from '@douyinfe/semi-ui/lib/es/modal'
import Spin from '@douyinfe/semi-ui/lib/es/spin'
import Typography from '@douyinfe/semi-ui/lib/es/typography'
import classes from './RequirementsPanel.module.css'
import { questions, type Question } from './remote.ts'

function messageOf(cause: unknown): string {
  if (cause instanceof Error) return cause.message
  return String(cause)
}

interface Props {
  recordId: string
  title: string
  onClose: () => void
  onAnswered: () => void
}

/**
 * 待决策问答弹层：列出某 record 的 pending 问题，逐题作答（选项按钮 /
 * 自由输入），全部答完可关闭。
 */
export function QuestionModal({ recordId, title, onClose, onAnswered }: Props): ReactElement {
  const [items, setItems] = useState<Question[]>([])
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setItems(await questions.list(recordId))
    } catch (cause) {
      setError(messageOf(cause))
    } finally {
      setLoading(false)
    }
  }, [recordId])

  useEffect(() => { void refresh() }, [refresh])

  const answer = useCallback(async (question: Question, value: string) => {
    const trimmed = value.trim()
    if (trimmed === '' || busy) return
    setBusy(true)
    setError(null)
    try {
      await questions.answer(question.id, trimmed)
      await refresh()
      onAnswered()
    } catch (cause) {
      setError(messageOf(cause))
    } finally {
      setBusy(false)
    }
  }, [busy, refresh, onAnswered])

  const pending = items.filter(item => item.status === 'pending')

  return (
    <Modal
      title={`待决策：${title}`}
      visible
      onCancel={onClose}
      maskClosable={false}
      footer={(
        <Button theme="borderless" disabled={busy} onClick={onClose}>关闭</Button>
      )}
    >
      {loading
        ? <div className={classes.center}><Spin /></div>
        : error !== null
          ? <Typography.Text type="danger">{error}</Typography.Text>
          : (
            <div className={classes.questionList}>
              {pending.length === 0 && <Typography.Text type="tertiary">已全部回答。</Typography.Text>}
              {pending.map((question, index) => (
                <div key={question.id} className={classes.questionItem}>
                  <Typography.Text className={classes.questionText}>
                    {index + 1}. {question.question}
                  </Typography.Text>
                  {question.options.length > 0 && (
                    <div className={classes.questionOptions}>
                      {question.options.map(option => (
                        <Button key={option} size="small" theme="outline" disabled={busy} onClick={() => { void answer(question, option) }}>
                          {option}
                        </Button>
                      ))}
                    </div>
                  )}
                  <Input
                    value={drafts[question.id] ?? ''}
                    onChange={(value) => { setDrafts(prev => ({ ...prev, [question.id]: value })) }}
                    placeholder="输入回答后回车…"
                    onEnterPress={() => { void answer(question, drafts[question.id] ?? '') }}
                  />
                </div>
              ))}
            </div>
          )}
    </Modal>
  )
}
