import { useCallback, useState, type ReactElement } from 'react'
import classes from './HelloAction.module.css'

/**
 * Owner share of a `sidebar.footer.action` entry: the sidebar column display
 * state (see ui-sidebar's SidebarFooterActionOwnerProps — kept structural so
 * this scaffold owns no cross-package type import).
 */
interface HelloActionProps {
  /** Whether the sidebar renders wide content (false = 56px rail). */
  wide: boolean
}

/** One additive sidebar-foot action: a self-contained counter button. */
export function HelloAction({ wide }: HelloActionProps): ReactElement {
  const [count, setCount] = useState(0)
  const onClick = useCallback(() => { setCount((n) => n + 1) }, [])
  return (
    <button type="button" className={classes.action} data-wide={wide} onClick={onClick}>
      <span className={classes.label}>Hello{count > 0 ? ` · ${count}` : ''}</span>
    </button>
  )
}
