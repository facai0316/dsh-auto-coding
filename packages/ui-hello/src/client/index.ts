/**
 * ui-hello browser half: one additive `sidebar.footer.action` list entry —
 * the scaffold's proof of life. `sidebar.footer.action` is a root-scoped list
 * slot (kind `list`, zero replacement risk): entries stack above Settings at
 * the sidebar foot and receive only the column display state (`{ wide }`).
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls ui-sidebar's SlotMap merge ('sidebar.footer.action') into
// this program so the register call below typechecks against the slot contract.
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { HelloAction } from './HelloAction.tsx'

/** Required services: the slots registry. */
export const inject = ['slots']

/**
 * Client plugin body: register one sidebar-foot action.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register(
    { name: 'sidebar.footer.action', id: 'auto-coding-hello', order: 50, label: 'Hello' },
    HelloAction,
  ))
}
