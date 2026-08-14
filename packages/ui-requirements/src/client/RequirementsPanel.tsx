import {
  useCallback, useState, type FormEvent, type ReactElement,
} from 'react'
import classes from './RequirementsPanel.module.css'

/** One requirement row. Ids are monotonic counters — panel state is in-memory only. */
interface RequirementItem {
  id: number
  text: string
  done: boolean
}

/**
 * 需求面板 view body: a self-contained requirement checklist. Items live in
 * component state (no store, no persistence) — this is the scaffold's proof
 * of life for a conversation view tab; a later package version can move the
 * list onto a shared store or a host service.
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
        <input
          className={classes.input}
          value={draft}
          placeholder="输入一条需求，回车添加…"
          onChange={(event) => { setDraft(event.target.value) }}
        />
        <button type="submit" className={classes.addBtn} disabled={draft.trim() === ''}>添加</button>
      </form>
      {items.length === 0
        ? <p className={classes.empty}>暂无需求。添加第一条，作为自动编码的任务输入。</p>
        : (
          <ul className={classes.list}>
            {items.map((item) => (
              <li key={item.id} className={classes.item} data-done={item.done}>
                <input
                  type="checkbox"
                  checked={item.done}
                  onChange={() => { toggle(item.id) }}
                />
                <span className={classes.text}>{item.text}</span>
                <button type="button" className={classes.del} onClick={() => { remove(item.id) }}>✕</button>
              </li>
            ))}
          </ul>
        )}
      <footer className={classes.foot}>共 {items.length} 条 · 已完成 {done} 条 · 面板状态仅存于内存</footer>
    </div>
  )
}
