import { conformance, sharedRuleCases } from '@poietic-tech/access/testing';
import { describe, expect, it } from 'vitest';
import { issuesPolicy, principalOf, unrestricted } from './access.ts';
import { type Actor, ANONYMOUS_ACTOR, SYSTEM_ACTOR, type ServiceContext } from './context.ts';

describe('issuesPolicy', () => {
  it('passes the shared access conformance cases', () => {
    expect(conformance(issuesPolicy, sharedRuleCases(issuesPolicy))).toEqual([]);
  });

  it('gives an anonymous actor only the floor', () => {
    expect(issuesPolicy.resolve(principalOf(ANONYMOUS_ACTOR), { floor: 'read', grants: [] })).toBe(
      'read',
    );
  });

  it('bypasses membership exactly for the admin role and the system actor', () => {
    const as = (actor: Actor) => ({ actor }) as ServiceContext;
    const agent: Actor = {
      id: 'usr_a',
      handle: 'a',
      name: 'A',
      kind: 'agent',
      role: 'member',
      groups: [],
    };
    expect(unrestricted(as(SYSTEM_ACTOR))).toBe(true);
    expect(unrestricted(as({ ...agent, kind: 'human', role: 'admin' }))).toBe(true);
    expect(unrestricted(as(agent))).toBe(false);
    expect(unrestricted(as({ ...ANONYMOUS_ACTOR, role: 'admin' }))).toBe(false);
  });
});
