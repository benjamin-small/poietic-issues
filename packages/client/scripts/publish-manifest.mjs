// The package.json npm publishes. In the monorepo `exports` points at src/ (internal packages have no build step);
// the published package points it at the build and drops what only the monorepo uses. The release workflow writes
// this over package.json after building, just before `npm publish`.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** @param {Record<string, unknown>} pkg */
export function publishManifest(pkg) {
  const { devDependencies: _dev, scripts: _scripts, ...published } = pkg;
  return {
    ...published,
    exports: { '.': { types: './dist/index.d.ts', default: './dist/index.js' } },
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const path = new URL('../package.json', import.meta.url);
  const pkg = JSON.parse(readFileSync(path, 'utf8'));
  writeFileSync(path, `${JSON.stringify(publishManifest(pkg), null, 2)}\n`);
}
