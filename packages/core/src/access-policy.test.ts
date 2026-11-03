import { conformance, sharedRuleCases } from '@poietic-tech/access/testing';
import { describe, expect, it } from 'vitest';
import { issuesPolicy, principalOf } from './access.ts';
import { ANONYMOUS_ACTOR } from './context.ts';

describe('issuesPolicy', () => {
  it('passes the shared access conformance cases', () => {
    expect(conformance(issuesPolicy, sharedRuleCases(issuesPolicy))).toEqual([]);
  });

  it('gives an anonymous actor only the floor', () => {
    expect(issuesPolicy.resolve(principalOf(ANONYMOUS_ACTOR), { floor: 'read', grants: [] })).toBe(
      'read',
    );
  });
});
