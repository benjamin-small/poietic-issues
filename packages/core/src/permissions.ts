import { isAdminRole } from '@poietic-tech/issues-schema';
import { type Actor, isAnonymous, type ServiceContext } from './context.ts';
import { DomainError, forbidden } from './errors.ts';

/** An actor that is not anonymous: a stored user (human, agent) or the system actor. */
export type KnownActor = Actor & { kind: Exclude<Actor['kind'], 'anonymous'> };

/**
 * Admin-only actions. Anonymous actors get UNAUTHENTICATED (401), so signing in is the answer; signed-in
 * non-admins get FORBIDDEN. Narrows `ctx.actor` to a known (non-anonymous) actor.
 */
export function requireAdmin(
  ctx: ServiceContext,
  action = 'do this',
): asserts ctx is ServiceContext & { actor: KnownActor } {
  if (isAnonymous(ctx)) throw new DomainError('UNAUTHENTICATED', `Sign in to ${action}`);
  if (!isAdminRole(ctx.actor.role)) throw forbidden(`Only admins can ${action}`);
}

/** Admins and the system actor (whose role is admin), by the access policy's admin role. */
export function isAdmin(ctx: Pick<ServiceContext, 'actor'>): boolean {
  return isAdminRole(ctx.actor.role);
}

/** Rejects the anonymous actor before anything is looked up, so the answer reveals nothing (ADR 0021). */
export function requireSignedIn(ctx: ServiceContext, action = 'do this'): void {
  if (isAnonymous(ctx)) throw new DomainError('UNAUTHENTICATED', `Sign in to ${action}`);
}
