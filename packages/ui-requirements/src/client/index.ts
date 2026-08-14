/**
 * ui-requirements browser half: one `conversation.view` list entry — the
 * view-tab ring the session body renders one-at-a-time (chat, trajectory,
 * waterfall, …). Same shape as ui-trajectory's tab: pure consumer, no
 * service, no store; the registration rides the slot service's effect
 * wrapper, so plugin unload removes the tab.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ThemeRuntime, ThemeSnapshot } from '@deepseek-ai/dsh-client-ui-theme/client'
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
 * Keep Semi Design's palette in step with the shell theme. Semi's switch is
 * the `body[theme-mode]` attribute its stylesheet keys on (semi.min.css
 * ships both palettes as `body[theme-mode=dark]` overrides), so mirroring
 * the active color scheme onto document.body is the sanctioned mechanism —
 * additive while this plugin runs, removed on unload. The theme service is
 * consumed optionally: without ui-theme the attribute stays untouched.
 */
function syncSemiThemeMode(ctx: Context): void {
  if (typeof document === 'undefined') return
  const theme = ctx.get('theme') as ThemeRuntime | undefined
  if (theme === undefined) return
  const sync = (snapshot: ThemeSnapshot): void => {
    document.body.setAttribute('theme-mode', snapshot.active.colorScheme)
  }
  // Initial read so no event is lost before the first change (the ui-theme
  // package's own consumer does the same); subsequent flips ride the event.
  sync(theme.getTheme())
  ctx.on('theme/change', sync)
  ctx.effect(() => () => { document.body.removeAttribute('theme-mode') }, 'ui-requirements: semi theme-mode sync')
}

/**
 * Client plugin body: register the 需求面板 view tab.
 * @param ctx - client root context.
 */
export function apply(ctx: Context): void {
  syncSemiThemeMode(ctx)
  ctx.slots.inject('conversation.view', () => ctx.slots.register(
    { name: 'conversation.view', id: 'requirements', order: 15, label: '需求面板' },
    RequirementsPanel,
  ))
}
