/**
 * Shared tsdown preset for out-of-tree dsh UI plugin packages in this repo.
 *
 * Standalone adaptation of deepseek-harness `packages/client/tsdown.client.ts`
 * (clientBundle): a UI plugin package ships TWO artifacts beside each other in
 * `lib/` —
 *
 *  - `lib/index.js`  the Node half the host Loader imports from a cordis.yml
 *                    row (plain ESM; a pure UI plugin is an empty `apply`);
 *  - `lib/client.js` the browser half, NOT a plain ESM bundle. It is a
 *                    closure-factory artifact: executing the script only calls
 *                    `window.__ModuleLoader__.load({ id, factory })`; module
 *                    bodies (CSS injection included) run at materialization,
 *                    and every non-platform import must inline because the
 *                    frozen module table only answers the platform seed list.
 *
 * The host's client-module scan discovers the browser half through the
 * package.json `dsh.client` declaration (`platform: "web"`) and resolves
 * `exports["./client"]` — so a package using this preset must keep both the
 * declaration and that export subpath.
 */
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { basename, dirname, resolve as resolvePath, sep } from 'node:path'
import type { UserConfig } from 'tsdown'
import { transform } from 'lightningcss'

/**
 * The module specifiers the web shell shares into the frozen module table.
 * Mirror of `@deepseek-ai/dsh-client-web/src/platform.ts` PLATFORM_MODULES —
 * keep in sync when a deployment revises the seed list.
 */
export const PLATFORM_MODULES = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-web-react',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-attachment',
  '@deepseek-ai/dsh-client-schema-form',
] as const

/**
 * Externals resolved from the loader module table: the platform seed entries
 * plus the documented client-runtime exemption (the snapshot-store engine the
 * table answers natively).
 */
const CLIENT_EXTERNALS: readonly string[] = [
  ...PLATFORM_MODULES,
  '@deepseek-ai/dsh-client-runtime/client',
]

/** Wire/type layers a client bundle may inline: browser-safe contracts with no runtime identity to share. */
const INLINE_SAFE = /^@deepseek-ai\/dsh-(host-apiproxy|session|llm|tools|brand)(\/|$)/

/** Vendored framework libraries with no cross-plugin runtime identity to share. */
const VENDORED_LIBRARY = /^@deepseek-ai\/(cosmokit|schemastery)(\/|$)/

/** Generated descriptor/codec contribution with no shared runtime identity. */
const GENERATED_REMOTE = /^@deepseek-ai\/dsh-[a-z0-9]+(?:-[a-z0-9]+)*\/remote$/

/**
 * Virtual-id wrappers keeping CSS away from tsdown's own css pipeline (which
 * requires @tsdown/css). The suffixes matter: tsdown's guard matches ids
 * ending in `.css`, so the virtual ids must not.
 */
const CSS_VIRTUAL_PREFIX = '\0dsh-css:'
const CSS_VIRTUAL_SUFFIX = '.mjs'
const PLAIN_CSS_PREFIX = '\0dsh-plain-css:'
const PLAIN_CSS_SUFFIX = '.mjs'

/**
 * Build both halves of one UI plugin package: the Node library and the
 * browser client bundle. The Node config runs first with `clean` on; the
 * client config MUST keep `clean` off or it would wipe the Node half.
 * @param id - plugin id (the package name), stamped into the
 * `__ModuleLoader__.load` handoff and onto injected style tags.
 * @returns tsdown config array for the package-local tsdown.config.ts.
 */
export function uiPluginBundle(id: string): UserConfig[] {
  return [
    {
      name: id,
      entry: { index: 'src/index.ts' },
      outDir: 'lib',
      format: ['esm'],
      platform: 'node',
      target: 'es2024',
      // Keep .js/.d.ts (not .mjs/.d.mts): the host Loader and the exports map
      // below address lib/index.js exactly.
      fixedExtension: false,
      dts: true,
      clean: true,
    },
    clientConfig(id),
  ]
}

/** The shared browser-half config for a UI plugin package. */
export function clientConfig(id: string): UserConfig {
  return {
    name: `${id}/client`,
    entry: { client: 'src/client/index.ts' },
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    dts: false,
    sourcemap: true,
    clean: false,
    external: [...CLIENT_EXTERNALS],
    // Node-idiom deps inlined into the browser bundle probe
    // process.env.NODE_ENV / import.meta.env — substitute both.
    define: {
      'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
    },
    // tsdown auto-externalizes package dependencies; anything NOT in the
    // loader module table must inline instead. A require() the table cannot
    // answer is a guaranteed runtime throw.
    noExternal: (moduleId: string) => (CLIENT_EXTERNALS.includes(moduleId) ? undefined : true),
    plugins: [
      {
        // Bundle purity gate (build-time mirror of the module-edge rules):
        // platform seed entries stay external, inline-safe wire layers inline,
        // and every other @deepseek-ai value import is a build error —
        // cross-plugin collaboration goes through cordis services instead.
        name: 'dsh-client-bundle-purity',
        resolveId(source: string) {
          if (!source.startsWith('@deepseek-ai/')) return null
          if (CLIENT_EXTERNALS.includes(source)) return null
          if (VENDORED_LIBRARY.test(source)) return null
          if (INLINE_SAFE.test(source) || GENERATED_REMOTE.test(source)) return null
          throw new Error(
            `client bundle purity: "${source}" is not a platform module (CLIENT_EXTERNALS), an inline-safe wire layer, or a generated /remote contribution — `
            + 'cross-plugin value imports are forbidden; collaborate through cordis services (type-only imports are erased and never reach this gate)',
          )
        },
      },
      {
        // Barrel resolution fix for component libraries (e.g. Semi): packages
        // without an exports map resolve their bare specifier to the CJS
        // `main` entry under rolldown, and CJS cannot be tree-shaken — every
        // icon of @douyinfe/semi-icons would land in the bundle. Rewrite the
        // resolved id onto the mirrored lib/es/ ESM tree (semi mirrors
        // lib/cjs ↔ lib/es) and clear moduleSideEffects so unused re-exports
        // drop. Scoped to bare @douyinfe/* specifiers (the barrels); deep
        // subpaths carry their own exports entries and are unaffected.
        name: 'dsh-barrel-esm-resolve',
        resolveId(source: string, importer: string | undefined) {
          if (importer === undefined || !source.startsWith('@douyinfe/')) return null
          if (source.includes('/', '@douyinfe/'.length)) return null // subpath, not the barrel
          let resolved: string
          try {
            resolved = createRequire(importer).resolve(source)
          } catch {
            return null
          }
          const esm = resolved.replace(`${sep}lib${sep}cjs${sep}`, `${sep}lib${sep}es${sep}`)
          const id = existsSync(esm) ? esm : resolved
          return { id, moduleSideEffects: false }
        },
      },
      {
        // CSS Modules compiled inline: importing `x.module.css` yields the
        // hashed class map; the css text auto-injects a
        // <style data-plugin="<id>"> tag at factory execution.
        name: 'dsh-css-modules-inline',
        resolveId(source: string, importer: string | undefined) {
          if (!source.endsWith('.module.css')) return null
          const abs = importer !== undefined ? sourceAssetPath(source, importer) : source
          return CSS_VIRTUAL_PREFIX + abs + CSS_VIRTUAL_SUFFIX
        },
        async load(virtualId: string) {
          if (!virtualId.startsWith(CSS_VIRTUAL_PREFIX)) return null
          const fileId = virtualId.slice(CSS_VIRTUAL_PREFIX.length, -CSS_VIRTUAL_SUFFIX.length)
          this.addWatchFile(fileId)
          const source = await readFile(fileId)
          const { code, exports: cssExports } = transform({
            filename: fileId,
            code: source,
            cssModules: { pattern: '[hash]_[local]' },
            minify: true,
          })
          const classMap: Record<string, string> = {}
          for (const [local, exp] of Object.entries(cssExports ?? {})) classMap[local] = exp.name
          const tagId = `${id}/${basename(fileId)}`
          return [
            `const css = ${JSON.stringify(code.toString())};`,
            `const tagId = ${JSON.stringify(tagId)};`,
            'if (typeof document !== \'undefined\' && document.querySelector(\'style[data-plugin-css=\' + JSON.stringify(tagId) + \']\') === null) {',
            '  const tag = document.createElement(\'style\');',
            `  tag.dataset.plugin = ${JSON.stringify(id)};`,
            '  tag.dataset.pluginCss = tagId;',
            '  tag.textContent = css;',
            '  document.head.appendChild(tag);',
            '}',
            `export default ${JSON.stringify(classMap)};`,
          ].join('\n')
        },
      },
      {
        // Plain stylesheet import (e.g. a component library's dist css):
        // resolved from the importing file, inlined as-is, and injected as a
        // <style data-plugin> tag at factory execution — same idempotent
        // tag-per-file scheme as CSS Modules, minus the class map.
        name: 'dsh-plain-css-inline',
        resolveId(source: string, importer: string | undefined) {
          if (!source.endsWith('.css') || source.endsWith('.module.css')) return null
          if (importer === undefined) return null
          let abs: string
          try {
            abs = createRequire(importer).resolve(source)
          } catch {
            return null // let other resolvers (or a loud error) handle it
          }
          return PLAIN_CSS_PREFIX + abs + PLAIN_CSS_SUFFIX
        },
        async load(virtualId: string) {
          if (!virtualId.startsWith(PLAIN_CSS_PREFIX)) return null
          const fileId = virtualId.slice(PLAIN_CSS_PREFIX.length, -PLAIN_CSS_SUFFIX.length)
          this.addWatchFile(fileId)
          const css = await readFile(fileId, 'utf8')
          const tagId = `${id}/css/${basename(fileId)}`
          return [
            `const css = ${JSON.stringify(css)};`,
            `const tagId = ${JSON.stringify(tagId)};`,
            'if (typeof document !== \'undefined\' && document.querySelector(\'style[data-plugin-css=\' + JSON.stringify(tagId) + \']\') === null) {',
            '  const tag = document.createElement(\'style\');',
            `  tag.dataset.plugin = ${JSON.stringify(id)};`,
            '  tag.dataset.pluginCss = tagId;',
            '  tag.textContent = css;',
            '  document.head.appendChild(tag);',
            '}',
            'export default {};',
          ].join('\n')
        },
      },
    ],
    outputOptions: {
      entryFileNames: 'client.js',
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(id)}, factory: (require) => {`,
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  }
}

/** Resolve an emitted JS asset import against its source-tree counterpart. */
function sourceAssetPath(source: string, importer: string): string {
  const emitted = resolvePath(dirname(importer), source)
  if (existsSync(emitted)) return emitted
  const marker = `${sep}lib${sep}types${sep}`
  const boundary = emitted.indexOf(marker)
  if (boundary < 0) return emitted
  return resolvePath(emitted.slice(0, boundary), 'src', emitted.slice(boundary + marker.length))
}
