/**
 * Hybrid build for @auto-coding/mega — one distributable package, four host
 * entries + one browser bundle:
 *
 *  - Host half is TWO-STAGE (mirrors cm-flow / cm-worker / ui-requirements):
 *    `tsc -p tsconfig.build.json` lowers the TC39 `@Remote` decorators to
 *    `build/` (rolldown/oxc cannot lower them on the direct transform path),
 *    then this config bundles each `build/<entry>.js` into `lib/<entry>.js`.
 *    Deployment-provided packages (`@deepseek-ai/*` peers) and the `pg`
 *    driver (a normal dependency resolved from node_modules at row-mount
 *    time) stay external; everything else — the repo/pipeline/worktree
 *    modules and cross-entry types — inlines into its owning entry.
 *  - Browser half uses the shared client preset (closure-factory
 *    `lib/client.js`), built from `src/client/index.ts`.
 *
 * The package's `exports` map (see package.json) exposes `./db` `./flow`
 * `./worker` `./client` plus the root `.` — the cordis.patch.yml rows name
 * those subpaths, so the whole pipeline mounts from one installed package.
 */
import { defineConfig, type UserConfig } from 'tsdown'
import { clientConfig } from '../../scripts/tsdown.client.ts'

export default defineConfig([
  {
    name: '@auto-coding/mega',
    entry: {
      index: 'build/index.js',
      db: 'build/db.js',
      flow: 'build/flow.js',
      worker: 'build/worker.js',
    },
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
  clientConfig('@auto-coding/mega'),
] satisfies UserConfig[])
