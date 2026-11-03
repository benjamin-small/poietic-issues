import { execFile } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { run } from '@poietic-tech/cli';
import { HOST_EXIT, MODULE_REFERENCE } from '../src/module/errors.ts';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// The published module: dist/poietic-tech.js, built by `pnpm --filter @poietic-tech/issues build:module`.
const cli = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const bundle = join(cli, 'dist', 'poietic-tech.js');
const pkg = JSON.parse(readFileSync(join(cli, 'package.json'), 'utf8')) as Record<string, unknown>;
const temp = mkdtempSync(join(tmpdir(), 'issues-bundle-'));

beforeAll(async () => {
  // Built here too, so the test never reads a stale bundle.
  await promisify(execFile)('pnpm', ['run', 'build:module'], { cwd: cli });
}, 60_000);
afterAll(() => rmSync(temp, { recursive: true, force: true }));

describe('the built module', () => {
  it('contains no commander code and none of the server stack', () => {
    const text = readFileSync(bundle, 'utf8');
    expect(text).not.toMatch(/from\s*"commander"|from\s*'commander'|new CommanderError/);
    for (const banned of ['better-sqlite3', 'kysely', 'hono']) expect(text).not.toContain(banned);
  });

  it('default-exports { api: 1, setup }', async () => {
    const mod = (await import(pathToFileURL(bundle).href)).default;
    expect(mod.api).toBe(1);
    expect(typeof mod.setup).toBe('function');
  });

  it('has the published package.json the host and npm expect', () => {
    expect(pkg).toMatchObject({
      name: '@poietic-tech/issues',
      version: '0.3.0',
      files: ['dist', 'README.md', 'LICENSE'],
      engines: { node: '>=22.12' },
      peerDependencies: { '@poietic-tech/cli': '^0.2.0' },
      'poietic-tech': {
        command: 'issues',
        entry: './dist/poietic-tech.js',
        api: 1,
        summary: 'Issue tracker at issues.poietic.tech',
      },
    });
    expect(pkg).not.toHaveProperty('bin');
    expect(pkg).not.toHaveProperty('private');
    for (const field of ['dependencies', 'peerDependencies'])
      for (const spec of Object.values((pkg[field] ?? {}) as Record<string, string>))
        expect(spec).not.toMatch(/^(workspace|file):/);
  });

  it('claims exit codes that match the real host table', async () => {
    const claimed = MODULE_REFERENCE.exitCodes as Record<string, string>;
    let out = '';
    const code = await run(['help', 'exit-codes'], {
      stdout: (c) => (out += c),
      stderr: () => {},
      env: { HOME: temp, XDG_CONFIG_HOME: join(temp, 'config') },
      cwd: temp,
      stdoutIsTTY: false,
      stderrIsTTY: false,
      now: () => Date.now(),
      sleep: async () => {},
      openBrowser: () => {},
      signal: new AbortController().signal,
      hostname: 'test',
      platform: 'linux',
      hostDir: join(temp, 'node_modules', '@poietic-tech', 'cli'),
      execPath: join(temp, 'bin', 'node'),
    });
    expect(code).toBe(0);
    const rows = new Map<number, string[]>();
    for (const line of out.split('\n')) {
      const m = /^(\d+)\s+.*?(?:\(([^)]*)\))?$/.exec(line.trim());
      if (m)
        rows.set(
          Number(m[1]),
          (m[2] ?? '')
            .split(',')
            .map((c) => c.trim())
            .filter(Boolean),
        );
    }
    // Every exit code the module documents exists in the host, and every code it maps lands where the host puts it.
    for (const exit of Object.keys(claimed)) expect(rows.has(Number(exit))).toBe(true);
    for (const [code, exit] of Object.entries(HOST_EXIT)) expect(rows.get(exit)).toContain(code);
  });

  it('is discovered, loaded and run by the real poietic-tech host', async () => {
    // An install layout the host searches: <root>/node_modules/@poietic-tech/{cli,issues}.
    const modules = join(temp, 'node_modules', '@poietic-tech');
    const installed = join(modules, 'issues');
    mkdirSync(join(installed, 'dist'), { recursive: true });
    mkdirSync(join(modules, 'cli'), { recursive: true });
    cpSync(join(cli, 'package.json'), join(installed, 'package.json'));
    cpSync(bundle, join(installed, 'dist', 'poietic-tech.js'));
    const host = async (argv: string[], env: Record<string, string> = {}) => {
      let stdout = '';
      let stderr = '';
      const write = vi
        .spyOn(process.stdout, 'write')
        .mockImplementation((chunk: string | Uint8Array) => {
          stdout += typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk);
          return true;
        });
      try {
        const code = await run(argv, {
          stdout: (s) => (stdout += s),
          stderr: (s) => (stderr += s),
          env: {
            HOME: temp,
            XDG_CONFIG_HOME: join(temp, 'config'),
            POIETIC_ISSUES_PROJECT: 'CLI',
            ...env,
          },
          cwd: temp,
          stdoutIsTTY: false,
          stderrIsTTY: false,
          now: () => Date.now(),
          sleep: async () => {},
          openBrowser: () => {},
          signal: new AbortController().signal,
          hostname: 'test',
          platform: 'linux',
          hostDir: join(modules, 'cli'),
          execPath: join(temp, 'bin', 'node'),
        });
        return { code, stdout, stderr };
      } finally {
        write.mockRestore();
      }
    };

    const listed = await host(['modules', 'list', '--json']);
    expect(listed.code).toBe(0);
    expect(listed.stdout).toContain('@poietic-tech/issues');
    expect(listed.stdout).toContain('loaded on demand');

    const help = await host(['issues', '--help']);
    expect(help).toMatchObject({ code: 0 });
    expect(help.stdout).toContain('issue');

    const schema = await host(['issues', 'schema', 'issue-create']);
    expect(schema.code).toBe(0);
    expect(JSON.parse(schema.stdout).required).toEqual(['title']);

    // No login: the host's own not_logged_in (exit 3), never wrapped as internal.
    const list = await host(['issues', 'issue', 'list', '--json']);
    expect(list.code).toBe(3);
    expect(JSON.parse(list.stderr)).toMatchObject({ error: 'not_logged_in' });

    // A local server is a usage error (exit 2), refused before the login is read.
    const local = await host(['issues', 'issue', 'list', '--json'], {
      POIETIC_ISSUES_SERVER: 'http://localhost:3000',
    });
    expect(local.code).toBe(2);
    expect(JSON.parse(local.stderr)).toMatchObject({ error: 'bad_usage' });
  }, 30_000);
});
