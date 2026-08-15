/**
 * ui-requirements browser half: one `conversation.view` list entry — the
 * view-tab ring the session body renders one-at-a-time (chat, trajectory,
 * waterfall, …). Same shape as ui-trajectory's tab. The panel is now backed by
 * the `requirements/*` Typert remote exported by `@auto-coding/cm-flow`
 * (mounted here through `ctx.remote.$mount`), so its checklist lives in the
 * `cm` database instead of component memory.
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
import {
  CONTRIBUTION,
  attach,
  detach,
  type ProjectsRemote,
  type QuestionsRemote,
  type RequirementsRemote,
} from './remote.ts'

/** Required services: slots registry + the client `remote` bridge. */
export const inject = ['slots', 'remote']

interface RemoteHost {
  $mount(contribution: unknown): Promise<() => Promise<void>>
}

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
 * Client plugin body: mount the requirements remote, then register the
 * 需求面板 view tab. Mount failures degrade the panel to an error banner (the
 * component surface it) rather than unmounting the tab.
 */
export function apply(ctx: Context): void {
  syncSemiThemeMode(ctx)

  const remote = ctx.get('remote') as RemoteHost | undefined
  if (remote === undefined) {
    detach(new Error('需求面板: 未检测到 remote 服务'))
  } else {
    let disposed = false
    let disposeRemote: (() => Promise<void>) | undefined
    void remote.$mount(CONTRIBUTION)
      .then(async dispose => {
        if (disposed) { await dispose(); return }
        disposeRemote = dispose
        const requirements = ctx.get('remote.requirements') as RequirementsRemote | undefined
        const projects = ctx.get('remote.projects') as ProjectsRemote | undefined
        const questions = ctx.get('remote.questions') as QuestionsRemote | undefined
        if (requirements === undefined || projects === undefined || questions === undefined) {
          throw new Error('需求面板: cm-flow remote 命名空间未完全挂载')
        }
        attach({ requirements, projects, questions })
      })
      .catch(error => { detach(error) })
    ctx.effect(() => () => {
      disposed = true
      void disposeRemote?.()
    }, 'ui-requirements: unmount requirements remote')
  }

  ctx.slots.inject('conversation.view', () => ctx.slots.register(
    { name: 'conversation.view', id: 'requirements', order: 15, label: '需求面板' },
    RequirementsPanel,
  ))
}