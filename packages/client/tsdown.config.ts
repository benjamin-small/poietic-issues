import { defineConfig } from 'tsdown';

/**
 * The published package (`pnpm --filter @poietic-tech/issues-client build`): `dist/index.js` and its types.
 * openapi-fetch stays a dependency; nothing else is needed at run time (the generated types are inlined).
 */
export default defineConfig({
  entry: { index: 'src/index.ts' },
  outDir: 'dist',
  format: 'esm',
  platform: 'neutral',
  target: 'es2023',
  clean: true,
  fixedExtension: false,
  dts: true,
  sourcemap: false,
  deps: { neverBundle: ['openapi-fetch'] },
});
