import { apiCreateIssue, choose, expect, openList, row, test } from './fixtures.ts';

test('signs in with the dev user picker', async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await page.goto('/p/OPS');
  // OPS is private: signed out it reads as not found, with a way to sign in (ADR 0021).
  await expect(page.getByTestId('project-not-found')).toBeVisible();
  await page.getByTestId('project-not-found').getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/login\?next=/);
  await page.getByRole('button', { name: /Grace Hopper/ }).click();
  await expect(page).toHaveURL(/\/p\/OPS/);
  await expect(page.getByText('Grace Hopper')).toBeVisible();
});

test('creates an issue from the keyboard and opens it', async ({ page }) => {
  await openList(page);
  await page.keyboard.press('c');
  const dialog = page.getByTestId('create-issue-dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByTestId('create-title').fill('Created in the browser');
  await dialog.getByRole('textbox', { name: '' }).last().fill('Some **markdown** body');
  await dialog.getByTestId('create-submit').click();
  await expect(dialog).toBeHidden();
  const created = page.getByTestId('issue-row').filter({ hasText: 'Created in the browser' });
  await expect(created).toBeVisible();
  await created.getByRole('button', { name: 'Created in the browser' }).click();
  const panel = page.getByTestId('peek-panel');
  await expect(panel.getByTestId('issue-title')).toHaveValue('Created in the browser');
  await expect(panel.getByTestId('description').locator('strong')).toHaveText('markdown');
  // Back closes the peek panel (shallow routing).
  await page.goBack();
  await expect(panel).toBeHidden();
});

test('edits title, description and properties', async ({ page }) => {
  const key = await apiCreateIssue(page.request, { title: 'Edit me' });
  await page.goto(`/i/${key}`);
  const detail = page.getByTestId('issue-detail');

  await detail.getByTestId('issue-title').fill('Edited title');
  await detail.getByTestId('issue-title').press('Enter');
  await detail.getByTestId('description').click();
  await detail.getByTestId('description-input').fill('Now with a description');
  await detail.getByTestId('description-save').click();
  await expect(detail.getByTestId('description')).toContainText('Now with a description');

  await detail.getByTestId('status-picker').click();
  await page.getByRole('option', { name: 'In Progress' }).click();
  await expect(detail.getByTestId('status-picker')).toContainText('In Progress');

  await detail.getByTestId('priority-picker').click();
  await page.getByRole('option', { name: 'Urgent' }).click();
  await detail.getByTestId('assignee-picker').click();
  await page.getByRole('option', { name: /Grace Hopper/ }).click();
  await detail.getByTestId('label-picker').click();
  await page.getByRole('option', { name: 'bug' }).click();
  await page.keyboard.press('Escape');

  // Persisted: reload and check.
  await page.reload();
  await expect(detail.getByTestId('issue-title')).toHaveValue('Edited title');
  await expect(detail.getByTestId('status-picker')).toContainText('In Progress');
  await expect(detail.getByTestId('priority-picker')).toContainText('Urgent');
  await expect(detail.getByTestId('assignee-picker')).toContainText('Grace Hopper');
  await expect(detail.getByTestId('label-picker')).toContainText('bug');
  await expect(detail.getByTestId('activity')).toContainText(
    'changed status from Todo to In Progress',
  );
});

test("names an agent's owner on its comments, activity, assignment and creation", async ({
  page,
}) => {
  // SSO provisions owned agents, which the e2e server lacks; patch one into the issue's responses instead.
  const key = await apiCreateIssue(page.request, {});
  const bot = {
    id: 'usr_01h455vb4pex5vsknk084sn02q',
    handle: 'ada-bot',
    name: 'Ada bot',
    kind: 'agent',
    avatarUrl: null,
    owner: { id: 'usr_01h455vb4pex5vsknk084sn02r', handle: 'ada' },
  };
  await page.route(`**/api/v1/issues/${key}`, async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const issue = await (await route.fetch()).json();
    await route.fulfill({
      json: { ...issue, creatorId: bot.id, creator: bot, assigneeId: bot.id, assignee: bot },
    });
  });
  await page.route(`**/api/v1/issues/${key}/comments**`, async (route) => {
    const now = new Date().toISOString();
    await route.fulfill({
      json: {
        data: [
          {
            id: 'cmt_01h455vb4pex5vsknk084sn02q',
            issueId: 'iss_01h455vb4pex5vsknk084sn02q',
            authorId: bot.id,
            author: bot,
            body: 'On it',
            createdAt: now,
            updatedAt: now,
            editedAt: null,
            deletedAt: null,
          },
        ],
        nextCursor: null,
      },
    });
  });
  await page.route(`**/api/v1/issues/${key}/activity**`, async (route) => {
    const body = await (await route.fetch()).json();
    await route.fulfill({
      json: { ...body, data: body.data.map((e: object) => ({ ...e, actor: bot })) },
    });
  });
  await page.goto(`/i/${key}`);
  const detail = page.getByTestId('issue-detail');
  await expect(page.getByTestId('comment').getByTestId('agent-note')).toHaveText(
    'agent · owned by @ada',
  );
  await expect(page.getByTestId('activity')).toContainText(
    'Ada bot · agent · owned by @ada created the issue',
  );
  await expect(detail.getByTestId('assignee-picker')).toContainText(
    'Ada bot · agent · owned by @ada',
  );
  await expect(detail.getByText('Ada bot · agent · owned by @ada ·')).toBeVisible();
});

test('comments on an issue', async ({ page }) => {
  const key = await apiCreateIssue(page.request, {});
  await page.goto(`/i/${key}`);
  await page.getByTestId('comment-input').fill('First comment with `code`');
  await page.getByTestId('comment-submit').click();
  const comment = page.getByTestId('comment');
  await expect(comment).toContainText('First comment with');
  await expect(comment.locator('code')).toHaveText('code');
  await comment.getByRole('button', { name: 'Edit' }).click();
  await comment.locator('textarea').fill('Edited comment');
  await comment.getByRole('button', { name: 'Save' }).click();
  await expect(comment).toContainText('Edited comment');
  await expect(comment).toContainText('edited');
});

test('links issues and shows both perspectives', async ({ page }) => {
  const blocker = await apiCreateIssue(page.request, { title: 'The blocker' });
  const blocked = await apiCreateIssue(page.request, { title: 'The blocked one' });
  await page.goto(`/i/${blocker}`);
  const links = page.getByTestId('links');
  await links.getByTestId('add-link').click();
  await choose(links, 'Relation', 'blocks');
  await links.getByTestId('link-target').fill(blocked);
  await links.getByRole('button', { name: 'Link', exact: true }).click();
  await expect(links).toContainText('blocks');
  await expect(links).toContainText('The blocked one');
  await links.getByRole('button', { name: /The blocked one/ }).click();
  await expect(page).toHaveURL(new RegExp(`/i/${blocked}$`));
  await expect(page.getByTestId('links')).toContainText('is blocked by');
  await expect(page.getByTestId('links')).toContainText('The blocker');
  // The link is stored from the blocker; removing it from the blocked side works too.
  await page.getByTestId('links').getByRole('button', { name: 'Remove link' }).click();
  await expect(page.getByTestId('links')).toContainText('No linked issues.');
});

test('adds sub-issues', async ({ page }) => {
  const parent = await apiCreateIssue(page.request, { title: 'Parent work' });
  await page.goto(`/i/${parent}`);
  await page.getByTestId('add-sub-issue').click();
  const dialog = page.getByTestId('create-issue-dialog');
  await expect(dialog).toContainText(`New sub-issue of ${parent}`);
  await dialog.getByTestId('create-title').fill('Child task');
  await dialog.getByTestId('create-submit').click();
  await expect(page.getByTestId('sub-issues')).toContainText('Child task');
  await expect(page.getByTestId('sub-issues')).toContainText('0/1');
});

test('filters the list and shares the filter in the URL', async ({ page }) => {
  await openList(page);
  await page.getByTestId('search').fill('Kanban');
  await expect(page.getByTestId('issue-row')).toHaveCount(1);
  await expect(page.getByTestId('view-modified')).toBeVisible();
  const shared = page.url();
  expect(shared).toContain('v=');
  const other = await page.context().newPage();
  await other.goto(shared);
  await expect(other.getByTestId('issue-row')).toHaveCount(1);
  await page.getByTestId('view-reset').click();
  await expect(page.getByTestId('issue-row').nth(1)).toBeVisible();
});

test('deletes to the trash and restores', async ({ page }) => {
  const key = await apiCreateIssue(page.request, { title: 'Trash candidate' });
  await openList(page);
  await expect(row(page, key)).toBeVisible();
  await page.goto(`/i/${key}`);
  await page.getByTestId('delete-issue').click();
  await expect(page.getByTestId('deleted-banner')).toBeVisible();
  await openList(page);
  await expect(row(page, key)).toHaveCount(0);
  await page.goto(`/i/${key}`);
  await page.getByTestId('restore-issue').click();
  await expect(page.getByTestId('deleted-banner')).toBeHidden();
  await openList(page);
  await expect(row(page, key)).toBeVisible();
});

test('shows the reason given for a change', async ({ page }) => {
  await openList(page);
  const key = await apiCreateIssue(page.request, { title: 'Needs a reason' });
  const res = await page.request.patch(`/api/v1/issues/${key}`, {
    data: { priority: 1 },
    headers: {
      origin: `http://127.0.0.1:${process.env.E2E_PORT ?? 3100}`,
      'x-change-reason': encodeURIComponent('raised — customer impact'),
    },
  });
  expect(res.ok(), await res.text()).toBe(true);
  await page.goto(`/i/${key}`);
  await expect(page.getByTestId('activity').getByTestId('change-reason')).toHaveText(
    '— raised — customer impact',
  );
});
