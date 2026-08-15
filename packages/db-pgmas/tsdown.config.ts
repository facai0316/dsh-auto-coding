/**
 * Host-only plugin bundle: plain ESM `lib/index.js` + types. Everything
 * deployment-provided (`@deepseek-ai/*` peers) and the `pg` driver (a normal
 * dependency resolved from node_modules at row-mount time) stays external.
 * Output names are pinned to `.js`/`.d.ts` so package.json `exports` keeps
 * pointing at `lib/index.js` whatever the package `type` implies.
 */
import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts'],
  format: 'esm',
  platform: 'node',
  dts: true,
  outDir: 'lib',
  exports: 'named',
  deps: {
    neverBundle: [/^@deepseek-ai\//, /^pg$/],
  },
  outExtensions: () => ({ js: '.js', dts: '.d.ts' }),
})
