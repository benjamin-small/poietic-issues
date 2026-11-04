import { createServer } from 'node:http';
import { agentFromEnv } from '@poietic-tech/auth';
import { Bridge } from '@poietic-tech/bridge';
import { createClient } from '@poietic-tech/issues-client';
import { loadConfig } from './config.ts';
import { GitHub } from './github.ts';
import { describeError, jsonLogger } from './log.ts';
import { Runner } from './runner.ts';
import { Store } from './store.ts';
import { Sync } from './sync.ts';
import { Tracker } from './tracker.ts';

const log = jsonLogger();

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const agent = agentFromEnv({ POIETIC_AGENT_TOKEN: config.agentToken });
  if (!agent) throw new Error('POIETIC_AGENT_TOKEN is not set.');

  const tracker = new Tracker(
    createClient({ baseUrl: config.trackerUrl, fetch: (request) => agent.fetch(request) }),
  );
  const me = await tracker.me();
  if (me.role !== 'admin')
    log.warn('tracker.not_admin', {
      handle: me.handle,
      note: 'repositories without a project will fail',
    });
  log.info('started', { tracker: config.trackerUrl, as: me.handle, bridge: config.bridgeUrl });

  const store = new Store(config.stateFile);
  const sync = new Sync({
    store,
    tracker,
    github: new GitHub({ token: config.githubToken, baseUrl: config.githubApiUrl }),
    selfId: me.id,
    trackerUrl: config.trackerUrl,
    excludeRepos: config.excludeRepos,
    log,
  });
  const controller = new AbortController();
  const runner = new Runner({
    bridge: new Bridge({ caller: agent, baseUrl: config.bridgeUrl }),
    tracker,
    store,
    sync,
    log,
    subscription: config.subscription,
    terminals: config.terminals,
    discoveryMs: config.discoveryMs,
    trackerPollMs: config.trackerPollMs,
    trackerIdleMaxMs: config.trackerIdleMaxMs,
    signal: controller.signal,
  });

  // Live while the tracker loop keeps turning; the loop retries its own failures, so only a hang trips this.
  const staleMs = Math.max(config.trackerPollMs * 4, config.trackerIdleMaxMs * 4, 5 * 60_000);
  const health = createServer((req, res) => {
    const fresh = Date.now() - runner.heartbeat.tracker < staleMs;
    const ok =
      req.url === '/readyz'
        ? runner.heartbeat.tracker > 0
        : fresh || runner.heartbeat.tracker === 0;
    res.writeHead(ok ? 200 : 503, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok, terminals: runner.terminals, heartbeat: runner.heartbeat }));
  }).listen(config.healthPort);

  const stop = (signal: string) => {
    log.info('stopping', { signal });
    controller.abort();
  };
  process.once('SIGTERM', () => stop('SIGTERM'));
  process.once('SIGINT', () => stop('SIGINT'));

  await runner.run();
  health.close();
  store.close();
  log.info('stopped');
}

main().catch((error: unknown) => {
  log.error('fatal', { error: describeError(error) });
  process.exit(1);
});
