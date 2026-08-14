/**
 * ui-requirements browser half: one `conversation.view` list entry — the
 * view-tab ring the session body renders one-at-a-time (chat, trajectory,
 * waterfall, …). Same shape as ui-trajectory's tab: pure consumer, no
 * service, no store; the registration rides the slot service's effect
 * wrapper, so plugin unload removes the tab.
 */
import type { Context } from '@deepseek-ai/cordis'
// Semi Design's compiled stylesheet, inlined as a <style data-plugin> tag by
// the shared tsdown preset (plain-css handler). Import before the component
// so the tag lands before first render.
import './semi-css.ts'
// Type-only: the 'conversation.view' SlotMap row (declared by the slot's
// owning package) must be in the program for the register call to type.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { RequirementsPanel } from './RequirementsPanel.tsx'

/** Required services: the slots registry (provided by dsh-client-runtime). */
export const inject = ['slots']

/**
 * Client plugin body: register the 需求面板 view tab.
 * @param ctx - client root context.
 */
export function apply(ctx: Context): void {
  ctx.slots.inject('conversation.view', () => ctx.slots.register(
    { name: 'conversation.view', id: 'requirements', order: 15, label: '需求面板' },
    RequirementsPanel,
  ))
}
