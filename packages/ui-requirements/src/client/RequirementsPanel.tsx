import { useCallback, useState, type FormEvent, type ReactElement } from 'react'
// Deep per-component imports, not the barrel: semi marks lib/es/index.js as
// side-effectful (sideEffects list), which defeats tree-shaking through the
// barrel and drags the whole library (tiptap included) into the bundle.
import Button from '@douyinfe/semi-ui/lib/es/button'
import Checkbox from '@douyinfe/semi-ui/lib/es/checkbox'
import Empty from '@douyinfe/semi-ui/lib/es/empty'
import Input from '@douyinfe/semi-ui/lib/es/input'
import Tag from '@douyinfe/semi-ui/lib/es/tag'
import Typography from '@douyinfe/semi-ui/lib/es/typography'
import classes from './RequirementsPanel.module.css'

/** One requirement row. Ids are monotonic counters — panel state is in-memory only. */
interface RequirementItem {
  id: number
  text: string
  done: boolean
}

/**
 * 需求面板 view body: a requirement checklist built on Semi Design
 * components (Button/Input/Checkbox/Tag/Empty/Typography). Items live in
 * component state (no store, no persistence); layout shell stays in the CSS
 * Module, visual skin comes from semi.
 */
export function RequirementsPanel(): ReactElement {
  const [items, setItems] = useState<readonly RequirementItem[]>([])
  const [draft, setDraft] = useState('')
  const [nextId, setNextId] = useState(1)

  const add = useCallback((event: FormEvent) => {
    event.preventDefault()
    const text = draft.trim()
    if (text === '') return
    setItems((prev) => [...prev, { id: nextId, text, done: false }])
    setNextId((n) => n + 1)
    setDraft('')
  }, [draft, nextId])

  const toggle = useCallback((id: number) => {
    setItems((prev) => prev.map((item) => (item.id === id ? { ...item, done: !item.done } : item)))
  }, [])

  const remove = useCallback((id: number) => {
    setItems((prev) => prev.filter((item) => item.id !== id))
  }, [])

  const done = items.filter((item) => item.done).length

  return (
    <div className={classes.panel}>
      <form className={classes.addRow} onSubmit={add}>
        <Input
          className={classes.input}
          value={draft}
          placeholder="输入一条需求，回车添加…"
          onChange={(value) => { setDraft(value) }}
        />
        <Button htmlType="submit" theme="solid" disabled={draft.trim() === ''}>添加</Button>
      </form>
      {items.length === 0
        ? (
          <div className={classes.emptyWrap}>
            <Empty description="暂无需求。添加第一条，作为自动编码的任务输入。" />
          </div>
        )
        : (
          <ul className={classes.list}>
            {items.map((item) => (
              <li key={item.id} className={classes.item}>
                <Checkbox
                  checked={item.done}
                  onChange={() => { toggle(item.id) }}
                />
                <Typography.Text
                  className={classes.text}
                  delete={item.done}
                  type={item.done ? 'tertiary' : 'primary'}
                  ellipsis={{ showTooltip: false }}
                >
                  {item.text}
                </Typography.Text>
                <Button
                  className={classes.del}
                  size="small"
                  theme="borderless"
                  type="danger"
                  onClick={() => { remove(item.id) }}
                >
                  删除
                </Button>
              </li>
            ))}
          </ul>
        )}
      <div className={classes.foot}>
        <Tag size="small" color="white">共 {items.length} 条</Tag>
        <Tag size="small" color="green">已完成 {done} 条</Tag>
        <Typography.Text type="tertiary" size="small">面板状态仅存于内存</Typography.Text>
      </div>
    </div>
  )
}
