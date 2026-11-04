import { definePolicy } from '@poietic-tech/access';

/**
 * The tracker's access policy (ADR 0021, decided by `@poietic-tech/access`, ADR 0033): ordered levels, the level
 * each project role gives, and the bypass for admins and the system actor. Here, not in core, so the web app checks
 * the same rules the server enforces.
 */
export const issuesPolicy = definePolicy({
  levels: ['none', 'read', 'write', 'manage'],
  roles: { viewer: 'read', editor: 'write', manager: 'manage' },
  adminRole: 'admin',
  unrestrictedKinds: ['system'],
});

/** Access an actor has to one project (ADR 0021). Ordered: each level includes the ones before it. */
export type AccessLevel = (typeof issuesPolicy.levels)[number];

/** Whether a global role is the policy's admin role. */
export const isAdminRole = (role: string | null | undefined): boolean =>
  issuesPolicy.adminRole !== null && role === issuesPolicy.adminRole;
