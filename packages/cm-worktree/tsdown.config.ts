/**
 * Host-only bundle: plain ESM `lib/index.js` + types. No external deps beyond
 * Node builtins.
 */
import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts'],
  format: 'esm',
  platform: 'node',
  target: 'es2024',
  dts: true,
  outDir: 'lib',
  exports: 'named',
  outExtensions: () => ({ js: '.js', dts: '.d.ts' }),
})