/**
 * Host-only plugin build, two-stage (mirrors the harness and cm-flow): `tsc`
 * emits `build/*.js` (standard decorators lowered via `__esDecorate`, `.ts`
 * specifiers rewritten to `.js`), then tsdown bundles into `lib/index.js`.
 * Deployment-provided packages stay external.
 */
import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['build/index.js'],
  format: 'esm',
  platform: 'node',
  target: 'es2024',
  dts: false,
  outDir: 'lib',
  exports: 'named',
  deps: {
    neverBundle: [/^@deepseek-ai\//, /^@auto-coding\//],
  },
  outExtensions: () => ({ js: '.js' }),
})