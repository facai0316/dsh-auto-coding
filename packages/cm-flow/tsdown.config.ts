/**
 * Host-only plugin build, two-stage (mirrors the harness): `tsc` first emits
 * `lib/types/*.js` with standard decorators lowered (`__esDecorate`) and
 * `.ts` import specifiers rewritten to `.js`; tsdown then bundles that JS into
 * a single `lib/index.js`. Deployment-provided packages stay external. This
 * two-stage shape is required because rolldown/oxc does not lower TC39 method
 * decorators on the direct transform path.
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
    neverBundle: [/^@deepseek-ai\//],
  },
  outExtensions: () => ({ js: '.js' }),
})