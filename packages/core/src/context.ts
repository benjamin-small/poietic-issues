import type { Db } from '@poietic-tech/issues-db';
import { type EntityKind, newId } from '@poietic-tech/issues-schema';

/** The authenticated principal performing an operation. Humans and agents are both actors. */
export interface Actor {
  id: string;
  handle: string;
  name: string;
  kind: 'human' | 'agent' | 'system' | 'anonymous';
  role: 'admin' | 'member';
}

export interface Clock {
  now(): Date;
}

export interface IdGenerator {
  (kind: EntityKind): string;
}

/**
 * Everything a service needs, passed explicitly (no globals). Transports build one per request:
 * the HTTP server from the authenticated request, the CLI's local mode from its trusted actor,
 * tests with a fixed clock and deterministic ids.
 */
export interface ServiceContext {
  db: Db;
  actor: Actor;
  clock: Clock;
  ids: IdGenerator;
  /** Correlates events with the request that caused them (echoed in event payloads). */
  requestId?: string;
  /** Why the change was made (one line, from `X-Change-Reason`), stored on the events it causes. */
  reason?: string;
}

export const systemClock: Clock = { now: () => new Date() };

export const SYSTEM_ACTOR: Actor = {
  id: 'usr_system',
  handle: 'system',
  name: 'System',
  kind: 'system',
  role: 'admin',
};

/**
 * The actor for requests without credentials (or with a pending or deactivated user's). It can read
 * public projects and nothing else (ADR 0021). `role: 'member'` keeps every existing admin check closed.
 */
export const ANONYMOUS_ACTOR: Actor = {
  id: 'usr_anonymous',
  handle: 'anonymous',
  name: 'Anonymous',
  kind: 'anonymous',
  role: 'member',
};

export function isAnonymous(ctx: Pick<ServiceContext, 'actor'>): boolean {
  return ctx.actor.kind === 'anonymous';
}

export function createContext(
  db: Db,
  actor: Actor,
  overrides: Partial<Omit<ServiceContext, 'db' | 'actor'>> = {},
): ServiceContext {
  return { db, actor, clock: systemClock, ids: newId, ...overrides };
}

/** Returns a copy of the context acting as a different actor. */
export function withActor(ctx: ServiceContext, actor: Actor): ServiceContext {
  return { ...ctx, actor };
}

export function nowIso(ctx: Pick<ServiceContext, 'clock'>): string {
  return ctx.clock.now().toISOString();
}
