import { createServer } from 'node:http';
import { agentFromEnv } from '@poietic-tech/auth';
import { Bridge, defaultConnect } from '@poietic-tech/bridge';
import { createClient } from '@poietic-tech/issues-client';
import { loadConfig } from './config.ts';
import { GitHub } from './github.ts';
import { describeError, jsonLogger } from './log.ts';
import { onReady, Runner } from './runner.ts';
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
  // Its own client, so only the notice listener's `ready` frames count as the notice connection being up.
  const noticeBridge = new Bridge({
    caller: agent,
    baseUrl: config.bridgeUrl,
    connect: onReady(defaultConnect, () => runner.noticesConnected()),
  });
  const runner: Runner = new Runner({
    bridge: new Bridge({ caller: agent, baseUrl: config.bridgeUrl }),
    tracker,
    store,
    sync,
    log,
    subscription: config.subscription,
    terminals: config.terminals,
    discoveryMs: config.discoveryMs,
    notices: {
      bridge: noticeBridge,
      terminal: config.noticeTerminal,
      subscription: config.noticeSubscription,
    },
    signal: controller.signal,
  });

  // Ready: the notice listener is connected (or reconnecting within its backoff) and the last tracker read did not
  // fail. Live: no tracker read has hung. With nothing happening there is nothing to be fresh about, so neither
  // check asks for recent activity.
  const health = createServer((req, res) => {
    const state = runner.health();
    const ok = req.url === '/readyz' ? state.ready : state.live;
    res.writeHead(ok ? 200 : 503, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({ ok, ...state, terminals: runner.terminals, heartbeat: runner.heartbeat }),
    );
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
