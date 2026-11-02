# @poietic-tech/issues-client

A typed client for the [poietic-issues](https://github.com/poietic-tech/poietic-issues) tracker API, generated from its OpenAPI document. It also has the pieces agents use to follow what changes on the tracker: an event follower, one-line change reasons, and field provenance.

```sh
npm install @poietic-tech/issues-client
```

## Calling the API

```ts
import { createClient, reasonHeaders, unwrap } from '@poietic-tech/issues-client';

const api = createClient({ baseUrl: 'https://issues.poietic.tech', token: identityToken });

const issue = unwrap(
  await api.PATCH('/issues/{issue}', {
    params: { path: { issue: 'ENG-7' } },
    body: { priority: 1 },
    // Every write an agent makes says why, in one line (at most 200 characters).
    headers: reasonHeaders('raised: blocks the release'),
  }),
);
```

`unwrap` returns the data or throws an `ApiError` carrying the server's problem details.

## Following events

`follow` reads `GET /events` from a cursor you keep, as the caller, and saves the cursor only after your `onBatch` resolves: a crash means reading a batch again, never skipping one. It never polls. It reads when you call `run()`, or when its `wake` source fires (for example, a bridge listener on the tracker's notice terminal).

```ts
import { concerns, follow, isOwnWrite } from '@poietic-tech/issues-client';

const me = { userId: 'usr_…', projectIds: ['prj_…'] };
const follower = follow(api, {
  cursor: { load: loadCursor, save: saveCursor },
  types: ['issue.created', 'issue.updated', 'comment.created'],
  wake: (wakeUp) => bridge.onNotice(wakeUp), // returns an unsubscribe function
  onError: (error) => log.warn({ error }, 'follow failed'),
  onBatch: async (events) => {
    for (const event of events) {
      if (isOwnWrite(event, me)) continue;
      const why = concerns(event, me); // 'newly_assigned' | 'assigned' | 'comment_on_mine' | 'in_my_project' | null
      if (why) await handle(event, why);
    }
  },
});
await follower.run(); // catch up once at start
```

`changes(api, { after })` reads a single page, if you want to drive the loop yourself.

## History and provenance

`history(api, 'ENG-7')` returns the issue's activity, oldest first, with each change's actor and reason.

`provenance(api, 'ENG-7', ['assignee', 'metadata.poietic.pm.assignment'])` names the event that last set each field. Issue metadata can be edited by any project writer, but an event's actor comes from the writer's verified identity. To prove a hand-off, check that both fields point at the same event and that its `actorId` is the agent you expect.

## License

MIT
