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
  SETTINGS_CONTRIBUTION,
  attach,
  attachSettings,
  detach,
  type ConfigRemote,
  type MergeRemote,
  type ProjectsRemote,
  type QuestionsRemote,
  type RecordsRemote,
  type RequirementsRemote,
  type ReviewsRemote,
  type SettingsNamespaces,
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
        const reviews = ctx.get('remote.reviews') as ReviewsRemote | undefined
        const records = ctx.get('remote.records') as RecordsRemote | undefined
        const config = ctx.get('remote.config') as ConfigRemote | undefined
        const merge = ctx.get('remote.merge') as MergeRemote | undefined
        if (requirements === undefined || projects === undefined || questions === undefined || reviews === undefined || records === undefined || config === undefined || merge === undefined) {
          throw new Error('自动化看板: cm-flow / cm-worker remote 命名空间未完全挂载')
        }
        attach({ requirements, projects, questions, reviews, records, config, merge })
      })
      .catch(error => { detach(error) })
    ctx.effect(() => () => {
      disposed = true
      void disposeRemote?.()
    }, 'ui-requirements: unmount requirements remote')
  }

  // Settings namespaces (pgconfig / usage) are served by THIS package's host
  // half, so their contribution mounts independently of cm-flow. A failure
  // here degrades only the settings pages (they surface their own error) and
  // must not tear down the requirements remote.
  if (remote !== undefined) {
    let settingsDisposed = false
    let disposeSettings: (() => Promise<void>) | undefined
    void remote.$mount(SETTINGS_CONTRIBUTION)
      .then(async dispose => {
        if (settingsDisposed) { await dispose(); return }
        disposeSettings = dispose
        const pgconfig = ctx.get('remote.pgconfig') as SettingsNamespaces['pgconfig'] | undefined
        const usage = ctx.get('remote.usage') as SettingsNamespaces['usage'] | undefined
        if (pgconfig === undefined || usage === undefined) {
          console.error('设置页: pgconfig / usage remote 命名空间未挂载(host 半需重启生效)')
          return
        }
        attachSettings({ pgconfig, usage })
      })
      .catch(error => {
        console.error('设置页 remote 挂载失败:', error)
      })
    ctx.effect(() => () => {
      settingsDisposed = true
      void disposeSettings?.()
    }, 'ui-requirements: unmount settings remote')
  }

  ctx.slots.inject('conversation.view', () => ctx.slots.register(
    { name: 'conversation.view', id: 'requirements', order: 15, label: '自动化看板' },
    RequirementsPanel,
  ))
}