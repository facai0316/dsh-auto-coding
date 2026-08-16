/**
 * Hybrid build for @auto-coding/ui-requirements:
 *  - Host half is TWO-STAGE (mirrors cm-flow): `tsc -p tsconfig.build.json`
 *    lowers the TC39 `@Remote` decorators to `build/` (rolldown/oxc cannot
 *    lower them on the direct transform path), then this tsdown config
 *    bundles `build/index.js` into `lib/index.js`. Package deps (`pg`,
 *    `yaml`, `@deepseek-ai/*` peers) stay external.
 *  - Browser half uses the shared client preset (closure-factory
 *    `lib/client.js`), built from `src/client/index.ts`.
 */
import { defineConfig, type UserConfig } from 'tsdown'
import { clientConfig } from '../../scripts/tsdown.client.ts'

export default defineConfig([
  {
    name: '@auto-coding/ui-requirements',
    entry: { index: 'build/index.js' },
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: true,
    deps: {
      neverBundle: [/^@deepseek-ai\//, /^pg$/],
    },
    outExtensions: () => ({ js: '.js' }),
  },
  clientConfig('@auto-coding/ui-requirements'),
] satisfies UserConfig[])
