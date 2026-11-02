import { describe, expect, it } from 'vitest';
import { history, provenance } from './history.ts';
import { createClient, type Schemas } from './index.ts';

type Event = Schemas['Event'];

const user = (id: string) => ({
  id,
  handle: id,
  name: id,
  kind: 'agent' as const,
  avatarUrl: null,
});

function ev(
  seq: number,
  type: Event['type'],
  actorId: string,
  data: Record<string, unknown>,
): Event {
  return {
    seq,
    id: `evt_${seq}`,
    type,
    actorId,
    actor: user(actorId),
    projectId: 'prj_a',
    issueId: 'iss_1',
    data,
    createdAt: `2026-11-01T12:00:0${seq}.000Z`,
  };
}

const ASSIGNMENT = 'metadata.poietic.pm.assignment';

const created = ev(1, 'issue.created', 'usr_intake', {
  issue: { id: 'iss_1', assignee: null, metadata: { 'poietic.intake.origin': 'gh#1' } },
  requestId: 'req_1',
});
const handOff = ev(2, 'issue.updated', 'usr_pm', {
  issue: { id: 'iss_1' },
  changes: {
    assignee: { from: null, to: user('usr_coder') },
    metadata: {
      from: { 'poietic.intake.origin': 'gh#1' },
      to: { 'poietic.intake.origin': 'gh#1', 'poietic.pm.assignment': 'a1' },
    },
  },
  reason: 'assigned to coding',
});
const otherKey = ev(3, 'issue.updated', 'usr_writer', {
  issue: { id: 'iss_1' },
  changes: {
    metadata: {
      from: { 'poietic.intake.origin': 'gh#1', 'poietic.pm.assignment': 'a1' },
      to: { 'poietic.intake.origin': 'gh#2', 'poietic.pm.assignment': 'a1' },
    },
  },
});
const unassign = ev(4, 'issue.updated', 'usr_writer', {
  issue: { id: 'iss_1' },
  changes: { assignee: { from: user('usr_coder'), to: null } },
});

/** Serves `/issues/{issue}/activity` in two pages. */
function fakeApi(events: Event[]) {
  return createClient({
    baseUrl: 'http://t',
    fetch: async (request) => {
      const url = new URL(request.url);
      expect(url.pathname).toBe('/api/v1/issues/A-1/activity');
      const after = Number(url.searchParams.get('after') ?? 0);
      const rest = events.filter((e) => e.seq > after);
      const page = rest.slice(0, 2);
      return Response.json({
        data: page,
        nextCursor: rest.length > 2 ? String(page.at(-1)!.seq) : null,
      });
    },
  });
}

describe('history', () => {
  it('joins every page in order, with reasons and request ids', async () => {
    const entries = await history(fakeApi([created, handOff, otherKey]), 'A-1');
    expect(entries.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(entries[0]).toMatchObject({ actorId: 'usr_intake', requestId: 'req_1', reason: null });
    expect(entries[1]).toMatchObject({
      type: 'issue.updated',
      reason: 'assigned to coding',
      requestId: null,
      changes: { assignee: { from: null, to: user('usr_coder') } },
    });
    expect(entries[0]!.changes).toEqual({});
  });
});

describe('provenance', () => {
  it('names the event that last set each field', async () => {
    const found = await provenance(fakeApi([created, handOff, otherKey]), 'A-1', [
      'assignee',
      ASSIGNMENT,
      'metadata.poietic.intake.origin',
    ]);
    expect(found.assignee?.seq).toBe(2);
    // A change to a different metadata key does not count for this one.
    expect(found[ASSIGNMENT]?.seq).toBe(2);
    expect(found['metadata.poietic.intake.origin']?.seq).toBe(3);
  });

  it('counts the creating event for fields set at creation', async () => {
    const found = await provenance(fakeApi([created]), 'A-1', [
      'metadata.poietic.intake.origin',
      'assignee',
    ]);
    expect(found['metadata.poietic.intake.origin']).toMatchObject({
      seq: 1,
      actorId: 'usr_intake',
    });
    expect(found.assignee).toBeNull();
  });

  it('a later unassign moves provenance to the unassigning event', async () => {
    const found = await provenance(fakeApi([created, handOff, unassign]), 'A-1', ['assignee']);
    expect(found.assignee).toMatchObject({ seq: 4, actorId: 'usr_writer' });
  });

  it('a field never set is null', async () => {
    const found = await provenance(fakeApi([created, handOff]), 'A-1', ['metadata.nothing']);
    expect(found['metadata.nothing']).toBeNull();
  });
});
