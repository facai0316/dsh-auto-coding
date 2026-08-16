/**
 * 使用说明页（看板 tab）：渲染 host `usage/get` 返回的 markdown 文档。
 * 用 `marked` 渲染（已内联进 client bundle），样式走看板 CSS module。
 */
import { useEffect, useState, type ReactElement } from 'react'
import { marked } from 'marked'
import Spin from '@douyinfe/semi-ui/lib/es/spin'
import classes from './RequirementsPanel.module.css'
import { usageDoc } from './remote.ts'

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

/** 使用说明页：markdown 文档渲染。 */
export function UsageGuidePage(): ReactElement {
  const [html, setHtml] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void usageDoc.get()
      .then(async doc => {
        if (cancelled) return
        const rendered = await marked.parse(doc.markdown, { async: true })
        if (!cancelled) setHtml(rendered)
      })
      .catch((cause: unknown) => {
        if (cancelled) return
        setError(`读取使用说明失败:${messageOf(cause)}`)
      })
    return () => { cancelled = true }
  }, [])

  if (error !== null) {
    return <div className={classes.page}><div className={classes.error}>{error}</div></div>
  }
  if (html === null) {
    return <div className={classes.center}><Spin /></div>
  }

  return (
    <div className={classes.page}>
      <div
        className={classes.markdownBody}
        // marked output is static markdown converted to HTML; no user input
        // is interpolated beyond the document text the host serves.
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  )
}
