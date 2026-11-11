/** The sync's settings, read from the environment. */
export interface Config {
  agentToken: string;
  githubToken: string;
  trackerUrl: string;
  bridgeUrl: string;
  githubApiUrl: string;
  stateFile: string;
  subscription: string;
  /** The bridge terminal tracker notices arrive on, and the sync's subscription there. */
  noticeTerminal: string;
  noticeSubscription: string;
  terminals: string[] | undefined;
  excludeRepos: string[];
  discoveryMs: number;
  healthPort: number;
}

const list = (value: string | undefined) =>
  (value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

function number(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0)
    throw new Error(`${name} must be a whole number, not "${raw}".`);
  return n;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is not set.`);
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const terminals = list(env.SYNC_TERMINALS);
  return {
    agentToken: required(env, 'POIETIC_AGENT_TOKEN'),
    githubToken: required(env, 'GITHUB_TOKEN'),
    trackerUrl: env.POIETIC_ISSUES_SERVER || 'https://issues.poietic.tech',
    bridgeUrl: env.POIETIC_BRIDGE_URL || 'https://bridge.poietic.tech',
    githubApiUrl: env.GITHUB_API_URL || 'https://api.github.com',
    stateFile: env.SYNC_STATE_FILE || '/data/sync.db',
    subscription: env.SYNC_SUBSCRIPTION || 'issues-sync',
    noticeTerminal: env.SYNC_NOTICE_TERMINAL || 'poietic-issues',
    noticeSubscription: env.SYNC_NOTICE_SUBSCRIPTION || 'github-sync',
    terminals: terminals.length > 0 ? terminals : undefined,
    // persistent-agents' own GitHub intake owns that repository.
    excludeRepos:
      env.SYNC_EXCLUDE_REPOS === undefined
        ? ['poietic-tech/persistent-agents']
        : list(env.SYNC_EXCLUDE_REPOS),
    discoveryMs: number(env, 'SYNC_DISCOVERY_MS', 300_000),
    healthPort: number(env, 'SYNC_HEALTH_PORT', 8080),
  };
}
