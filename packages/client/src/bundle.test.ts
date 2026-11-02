import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { beforeAll, describe, expect, it } from 'vitest';
import { publishManifest } from '../scripts/publish-manifest.mjs';

// The published package: dist/, built by `pnpm --filter @poietic-tech/issues-client build`.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as Record<string, unknown>;

beforeAll(async () => {
  // Built here too, so the test never reads a stale bundle.
  await promisify(execFile)('pnpm', ['run', 'build'], { cwd: root });
}, 60_000);

describe('the published client', () => {
  it('exports the client and the follower API from dist/index.js', async () => {
    const mod = await import(pathToFileURL(join(root, 'dist', 'index.js')).href);
    for (const name of [
      'createClient',
      'unwrap',
      'changes',
      'follow',
      'history',
      'provenance',
      'isOwnWrite',
      'concerns',
      'byIssue',
      'reasonHeaders',
    ])
      expect(typeof mod[name], name).toBe('function');
  });

  it('ships its types, without workspace packages', () => {
    const dts = join(root, 'dist', 'index.d.ts');
    expect(existsSync(dts)).toBe(true);
    const text = readFileSync(dts, 'utf8');
    expect(text).not.toContain('@poietic-tech/issues-schema');
    expect(text).toMatch(/provenance/);
  });

  it('has a publishable package.json', () => {
    expect(pkg).toMatchObject({
      name: '@poietic-tech/issues-client',
      version: '0.1.0',
      license: 'MIT',
      files: ['dist', 'README.md', 'LICENSE'],
      engines: { node: '>=22.12' },
      repository: { directory: 'packages/client' },
    });
    expect(pkg).not.toHaveProperty('private');
    expect(Object.keys(pkg.dependencies as object)).toEqual(['openapi-fetch']);
    for (const field of ['dependencies', 'peerDependencies'])
      for (const spec of Object.values((pkg[field] ?? {}) as Record<string, string>))
        expect(spec).not.toMatch(/^(workspace|file):/);
  });

  it('points exports at the build only in the published manifest', () => {
    // Inside the monorepo, packages import src/ directly (no build step).
    expect(pkg.exports).toEqual({ '.': './src/index.ts' });
    const published = publishManifest(pkg);
    expect(published.exports).toEqual({
      '.': { types: './dist/index.d.ts', default: './dist/index.js' },
    });
    expect(published).not.toHaveProperty('devDependencies');
    expect(published).not.toHaveProperty('scripts');
    expect(pkg.exports).toEqual({ '.': './src/index.ts' }); // not mutated
  });
});
