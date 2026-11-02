import type { EVENT_TYPES } from '@poietic-tech/issues-schema';
import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  byIssue,
  concerns,
  isOwnWrite,
  REASON_MAX,
  reasonHeaders,
  type TypedEvent,
} from './events.ts';
import type { Schemas } from './index.ts';

type Event = Schemas['Event'];

const ME = 'usr_me';
const user = (id: string) => ({
  id,
  handle: id,
  name: id,
  kind: 'agent' as const,
  avatarUrl: null,
});

function event(over: Partial<Event> & { type: Event['type'] }): Event {
  return {
    seq: 1,
    id: 'evt_1',
    actorId: 'usr_pm',
    actor: null,
    projectId: 'prj_a',
    issueId: 'iss_1',
    data: {},
    createdAt: '2026-11-01T12:00:00.000Z',
    ...over,
  };
}

describe('reasonHeaders', () => {
  it('percent-encodes the reason', () => {
    const reason = 'handed off — see “plan”';
    expect(reasonHeaders(reason)).toEqual({ 'x-change-reason': encodeURIComponent(reason) });
  });

  it('sends nothing without a reason', () => {
    expect(reasonHeaders(undefined)).toEqual({});
    expect(reasonHeaders('  ')).toEqual({});
  });

  it('refuses what the server would refuse', () => {
    expect(REASON_MAX).toBe(200);
    expect(() => reasonHeaders('x'.repeat(201))).toThrow(RangeError);
    expect(() => reasonHeaders('a\nb')).toThrow(RangeError);
    expect(() => reasonHeaders('a\u2028b')).toThrow(RangeError);
    expect(reasonHeaders('🚀'.repeat(200))).toHaveProperty('x-change-reason');
    expect(reasonHeaders('é'.repeat(200))).toHaveProperty('x-change-reason');
  });
});

describe('isOwnWrite', () => {
  it('matches my actor id, or a request id I generated', () => {
    expect(isOwnWrite(event({ type: 'issue.updated', actorId: ME }), { userId: ME })).toBe(true);
    const mine = event({ type: 'issue.updated', data: { requestId: 'req_mine' } });
    expect(isOwnWrite(mine, { userId: ME, ownRequest: (id) => id === 'req_mine' })).toBe(true);
    expect(isOwnWrite(mine, { userId: ME, ownRequest: () => false })).toBe(false);
    expect(isOwnWrite(event({ type: 'issue.updated' }), { userId: ME })).toBe(false);
  });
});

describe('concerns', () => {
  const issue = (assigneeId: string | null) => ({ id: 'iss_1', key: 'A-1', assigneeId });

  it('sees a new assignment to me', () => {
    const e = event({
      type: 'issue.updated',
      data: { issue: issue(ME), changes: { assignee: { from: null, to: user(ME) } } },
    });
    expect(concerns(e, { userId: ME })).toBe('newly_assigned');
  });

  it('sees an issue that is already mine', () => {
    const e = event({
      type: 'issue.updated',
      data: { issue: issue(ME), changes: { priority: { from: 1, to: 2 } } },
    });
    expect(concerns(e, { userId: ME })).toBe('assigned');
  });

  it('sees a comment on one of my issues', () => {
    const e = event({
      type: 'comment.created',
      data: { comment: { id: 'cmt_1' }, issue: { id: 'iss_1', key: 'A-1', title: 'x' } },
    });
    expect(concerns(e, { userId: ME, issueIds: new Set(['iss_1']) })).toBe('comment_on_mine');
    expect(concerns(e, { userId: ME, issueIds: new Set(['iss_2']) })).toBeNull();
  });

  it('sees anything in my projects, and nothing else', () => {
    const e = event({ type: 'issue.created', data: { issue: issue(null) } });
    expect(concerns(e, { userId: ME, projectIds: ['prj_a'] })).toBe('in_my_project');
    expect(concerns(e, { userId: ME, projectIds: ['prj_b'] })).toBeNull();
    expect(concerns(e, { userId: ME })).toBeNull();
  });

  it('does not call an unassignment from me an assignment', () => {
    const e = event({
      type: 'issue.updated',
      data: { issue: issue(null), changes: { assignee: { from: user(ME), to: null } } },
    });
    expect(concerns(e, { userId: ME })).toBeNull();
    expect(concerns(e, { userId: ME, projectIds: ['prj_a'] })).toBe('in_my_project');
  });
});

describe('byIssue', () => {
  it('groups events by issue in seq order, leaving out events with no issue', () => {
    const events = [
      event({ type: 'issue.created', seq: 3, issueId: 'iss_2' }),
      event({ type: 'issue.created', seq: 1, issueId: 'iss_1' }),
      event({ type: 'project.updated', seq: 2, issueId: null }),
      event({ type: 'issue.updated', seq: 4, issueId: 'iss_1' }),
    ];
    const grouped = byIssue(events);
    expect([...grouped.keys()].sort()).toEqual(['iss_1', 'iss_2']);
    expect(grouped.get('iss_1')!.map((e) => e.seq)).toEqual([1, 4]);
  });
});

describe('typed events', () => {
  it('cover exactly the tracker event types', () => {
    expectTypeOf<TypedEvent['type']>().toEqualTypeOf<(typeof EVENT_TYPES)[number]>();
  });
});
