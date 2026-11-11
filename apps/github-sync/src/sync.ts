import { ApiError, isOwnWrite } from '@poietic-tech/issues-client';
import { type GitHub, GitHubError, type IssueChange } from './github.ts';
import type { Logger } from './log.ts';
import {
  bodyWithMarker,
  changedFields,
  cleanBody,
  commentMarker,
  GITHUB_URL_KEY,
  type GitHubIssue,
  gitHubCommentBody,
  gitHubStateFields,
  isEmpty,
  issueMarker,
  type Snapshot,
  snapshotOfGitHub,
  snapshotOfTracker,
  type SyncState,
  stateOfCategory,
  trackerCommentBody,
} from './mapping.ts';
import type { IssueLink, Store } from './store.ts';
import {
  type Issue,
  type RepoInfo,
  type Tracker,
  type TrackerEvent,
  visibilityOf,
} from './tracker.ts';

export interface SyncOptions {
  store: Store;
  tracker: Tracker;
  github: GitHub;
  /** The tracker user the sync acts as: its own events are echoes and are skipped. */
  selfId: string;
  /** The web app's origin, for links back to tracker issues. */
  trackerUrl: string;
  /** `owner/name` repositories left alone in both directions (another integration owns them). */
  excludeRepos?: Iterable<string>;
  log: Logger;
}

/** The tracker event types the sync follows. */
export const TRACKER_EVENT_TYPES: TrackerEvent['type'][] = [
  'issue.created',
  'issue.updated',
  'issue.deleted',
  'issue.restored',
  'comment.created',
  'comment.updated',
  'comment.deleted',
  'project.updated',
  'project.repo_added',
  'project.repo_removed',
  'label.created',
  'label.updated',
  'label.deleted',
  'status.created',
  'status.updated',
  'status.deleted',
];

/** A failure worth trying again later: the network, a server error or a rate limit, on either side. */
export function isTransient(error: unknown): boolean {
  if (error instanceof GitHubError) return error.transient;
  if (error instanceof ApiError)
    return error.status === 0 || error.status === 429 || error.status >= 500;
  // fetch rejects with a TypeError when the network fails.
  return error instanceof TypeError;
}

const isNotFound = (error: unknown) =>
  (error instanceof ApiError && error.status === 404) ||
  (error instanceof GitHubError && (error.status === 404 || error.status === 410));

interface GitHubUser {
  login: string;
}
interface IssuePayload {
  action: string;
  issue: GitHubIssue;
  repository: RepoInfo;
  sender?: GitHubUser;
}
interface CommentPayload extends IssuePayload {
  comment: { id: number; body?: string | null; html_url: string; user?: GitHubUser };
}

/** `owner/name` and number from a GitHub issue URL. */
function parseIssueUrl(url: unknown): { repo: string; number: number } | undefined {
  if (typeof url !== 'string') return undefined;
  const m = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/issues\/(\d+)$/.exec(url);
  return m ? { repo: m[1]!, number: Number(m[2]) } : undefined;
}

/** `owner/name#12`, the way GitHub writes an issue reference. */
const ref = (repo: string, number: number) => `${repo}#${number}`;

const labelColors = (issue: GitHubIssue): Record<string, string> =>
  Object.fromEntries(
    (issue.labels ?? []).flatMap((l) =>
      typeof l === 'string' || !l.color ? [] : [[l.name.toLowerCase(), l.color]],
    ),
  );

/**
 * Keeps GitHub issues and tracker issues in step, both ways.
 *
 * Each linked pair has a snapshot of the fields both sides agreed on after the last sync. A change on one side
 * is a field that now differs from the snapshot; it is written to the other side and the snapshot moves on, so
 * the echo that comes back (a webhook for the sync's own GitHub write, a tracker event) matches the snapshot and
 * does nothing. GitHub events are handled against the issue as GitHub has it now, not the webhook's copy, so
 * late or out-of-order deliveries never roll anything back. Work is serialised: one change at a time.
 */
export class Sync {
  readonly #o: SyncOptions;
  readonly #exclude: Set<string>;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(options: SyncOptions) {
    this.#o = options;
    this.#exclude = new Set([...(options.excludeRepos ?? [])].map((r) => r.toLowerCase()));
  }

  #serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(fn, fn);
    this.#queue = run.catch(() => {});
    return run;
  }

  #excluded(repo: string): boolean {
    return this.#exclude.has(repo.toLowerCase());
  }

  #trackerIssueUrl(key: string): string {
    return `${this.#o.trackerUrl.replace(/\/+$/, '')}/i/${key}`;
  }

  // ------------------------------------------------------------------ GitHub → tracker

  /** Handles one bridge event (`github.<event>.<action>`) with its webhook payload. Others are ignored. */
  onGitHub(type: string, payload: unknown): Promise<void> {
    return this.#serial(async () => {
      const p = payload as IssuePayload;
      if (!p?.repository?.full_name || this.#excluded(p.repository.full_name)) return;
      if (type === 'github.repository.publicized' || type === 'github.repository.privatized') {
        await this.#onVisibility(p.repository);
        return;
      }
      if (!p.issue || p.issue.pull_request) return;
      if (type.startsWith('github.issues.')) await this.#onIssue(p);
      else if (type.startsWith('github.issue_comment.')) await this.#onComment(p as CommentPayload);
    });
  }

  /**
   * A repository made public or private: its project follows, when the project holds that repository alone. A
   * project shared by several repositories keeps the visibility a person chose.
   */
  async #onVisibility(repo: RepoInfo): Promise<void> {
    const { tracker, log } = this.#o;
    const project = await tracker.projectForRepo(repo.full_name);
    if (!project) return;
    const visibility = visibilityOf(repo);
    if (project.repos.length !== 1) {
      log.info('tracker.visibility_kept', { key: project.key, repo: repo.full_name, visibility });
      return;
    }
    if (project.visibility === visibility) return;
    await tracker.setVisibility(
      project.id,
      visibility,
      `GitHub repository ${repo.full_name} was made ${visibility}`,
    );
    log.info('tracker.visibility', { key: project.key, repo: repo.full_name, visibility });
  }

  async #onIssue(p: IssuePayload): Promise<void> {
    const repo = p.repository.full_name;
    const { number } = p.issue;
    if (p.action === 'deleted') {
      const link = this.#o.store.issueByGitHub(repo, number);
      if (link) await this.#trash(link);
      return;
    }
    if (p.action === 'transferred') {
      this.#o.log.info('github.transferred', { repo, number });
      return;
    }
    let current: GitHubIssue;
    try {
      current = await this.#o.github.getIssue(repo, number);
    } catch (error) {
      if (!isNotFound(error)) throw error;
      const link = this.#o.store.issueByGitHub(repo, number);
      if (link) await this.#trash(link);
      return;
    }
    const { link, created } = await this.#linkFromGitHub(p.repository, current);
    if (!created) await this.#applyToTracker(link, current);
  }

  async #trash(link: IssueLink): Promise<void> {
    try {
      await this.#o.tracker.trashIssue(
        link.trackerId,
        `GitHub issue ${ref(link.repo, link.number)} was deleted`,
      );
      this.#o.log.info('tracker.trashed', {
        key: link.trackerKey,
        repo: link.repo,
        number: link.number,
      });
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
    this.#o.store.saveIssue({ ...link, snapshot: { ...link.snapshot, state: 'not_planned' } });
  }

  /** The link for a GitHub issue: stored, adopted from the sync's own marker, or a new tracker issue. */
  async #linkFromGitHub(
    repoInfo: RepoInfo,
    gh: GitHubIssue,
  ): Promise<{ link: IssueLink; created: boolean }> {
    const { store, tracker, log } = this.#o;
    const repo = repoInfo.full_name;
    const stored = store.issueByGitHub(repo, gh.number);
    if (stored) return { link: stored, created: false };

    // The sync wrote this GitHub issue for a tracker issue and stopped before recording the link.
    const marked = issueMarker(gh.body);
    if (marked) {
      try {
        const issue = await tracker.issue(marked);
        const link = this.#newLink(repo, gh, issue, snapshotOfTracker(issue));
        store.saveIssue(link);
        return { link, created: false };
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
    }

    const project = await tracker.ensureProjectForRepo(repoInfo);
    const snapshot = snapshotOfGitHub(gh);
    const status = await this.#statusFor(project.id, snapshot.state);
    const reason = `synced from GitHub issue ${ref(repo, gh.number)}`;
    const labels = await tracker.ensureLabels(project.id, snapshot.labels, labelColors(gh), reason);
    const issue = await tracker.createIssue(
      project.id,
      {
        title: snapshot.title,
        description: snapshot.body,
        status,
        labels,
        repo,
        metadata: { [GITHUB_URL_KEY]: gh.html_url },
      },
      `github-sync:issue:${repo.toLowerCase()}#${gh.number}`,
      reason,
    );
    const link = this.#newLink(repo, gh, issue, snapshot);
    store.saveIssue(link);
    log.info('tracker.created', { key: issue.key, repo, number: gh.number });
    return { link, created: true };
  }

  #newLink(repo: string, gh: GitHubIssue, issue: Issue, snapshot: Snapshot): IssueLink {
    return {
      repo,
      number: gh.number,
      trackerId: issue.id,
      trackerKey: issue.key,
      projectId: issue.projectId,
      url: gh.html_url,
      snapshot,
    };
  }

  /** A status id for `state`; `current` is kept when it already means that state. */
  async #statusFor(projectId: string, state: SyncState, current?: Issue): Promise<string> {
    if (current && stateOfCategory(current.status.category) === state) return current.statusId;
    const categories =
      state === 'open'
        ? (['unstarted', 'backlog', 'started'] as const)
        : state === 'completed'
          ? (['completed'] as const)
          : (['canceled'] as const);
    return (await this.#o.tracker.statusIn(projectId, [...categories])).id;
  }

  /** Writes what changed on GitHub since the last sync to the tracker issue. */
  async #applyToTracker(link: IssueLink, gh: GitHubIssue): Promise<void> {
    const next = snapshotOfGitHub(gh);
    const change = changedFields(link.snapshot, next);
    if (isEmpty(change)) return;
    const { tracker, store, log } = this.#o;
    let issue: Issue;
    try {
      issue = await tracker.issue(link.trackerId);
    } catch (error) {
      if (!isNotFound(error)) throw error;
      log.warn('tracker.missing', { key: link.trackerKey, repo: link.repo, number: link.number });
      return;
    }
    if (issue.deletedAt) {
      // Trashed in the tracker: GitHub's change waits until someone restores it.
      log.info('tracker.trashed_skip', { key: issue.key, fields: Object.keys(change) });
      return;
    }
    const reason = `synced from GitHub issue ${ref(link.repo, link.number)}`;
    const patch: Parameters<Tracker['updateIssue']>[1] = {};
    if (change.title !== undefined) patch.title = change.title;
    if (change.body !== undefined) patch.description = change.body;
    if (change.state !== undefined) {
      const status = await this.#statusFor(issue.projectId, change.state, issue);
      if (status !== issue.statusId) patch.status = status;
    }
    if (change.labels !== undefined)
      patch.labels = await tracker.ensureLabels(
        issue.projectId,
        change.labels,
        labelColors(gh),
        reason,
      );
    if (Object.keys(patch).length > 0) {
      await tracker.updateIssue(issue.id, patch, reason);
      log.info('tracker.updated', { key: issue.key, fields: Object.keys(patch) });
    }
    store.saveIssue({ ...link, url: gh.html_url, snapshot: next });
  }

  async #onComment(p: CommentPayload): Promise<void> {
    const { store, tracker, log } = this.#o;
    const repo = p.repository.full_name;
    const { comment } = p;
    const mirrored = commentMarker(comment.body);
    const existing = store.commentByGitHub(repo, comment.id);

    if (p.action === 'deleted') {
      if (existing?.origin === 'github') {
        try {
          await tracker.deleteComment(
            existing.trackerId,
            `comment deleted on GitHub issue ${ref(repo, p.issue.number)}`,
          );
        } catch (error) {
          if (!isNotFound(error)) throw error;
        }
      }
      store.deleteComment(repo, comment.id);
      return;
    }

    const { link } = await this.#linkFromGitHub(
      p.repository,
      await this.#o.github.getIssue(repo, p.issue.number),
    );

    // The sync's own copy of a tracker comment: only make sure it is recorded.
    if (mirrored) {
      if (!existing)
        store.saveComment({
          repo,
          githubId: comment.id,
          trackerId: mirrored,
          trackerIssueId: link.trackerId,
          origin: 'tracker',
          body: '',
        });
      return;
    }

    const body = cleanBody(comment.body);
    const login = comment.user?.login ?? p.sender?.login ?? 'ghost';
    if (!existing) {
      const created = await tracker.createComment(
        link.trackerId,
        trackerCommentBody(comment, login),
        `github-sync:comment:${repo.toLowerCase()}:${comment.id}`,
        `synced from a comment on GitHub issue ${ref(repo, link.number)}`,
      );
      store.saveComment({
        repo,
        githubId: comment.id,
        trackerId: created.id,
        trackerIssueId: link.trackerId,
        origin: 'github',
        body,
      });
      log.info('tracker.commented', { key: link.trackerKey, comment: comment.id });
      return;
    }
    if (existing.origin === 'github' && existing.body !== body) {
      await tracker.updateComment(
        existing.trackerId,
        trackerCommentBody(comment, login),
        `synced from a comment on GitHub issue ${ref(repo, link.number)}`,
      );
      store.saveComment({ ...existing, body });
    }
  }

  // ------------------------------------------------------------------ tracker → GitHub

  /**
   * Handles one tracker event. The sync's own writes (by actor, which the tracker sets from the verified token, so
   * no one else can claim it) and anything it does not follow are ignored. An echo that slips past that check, such
   * as a write the sync made under another identity, still matches the snapshot and changes nothing.
   */
  onTracker(event: TrackerEvent): Promise<void> {
    return this.#serial(async () => {
      if (isOwnWrite(event, { userId: this.#o.selfId })) return;
      const [kind] = event.type.split('.');
      if (kind === 'project' || kind === 'label' || kind === 'status') {
        this.#o.tracker.invalidate(event.projectId ?? undefined);
        return;
      }
      if (kind === 'issue' && event.issueId) await this.#onTrackerIssue(event);
      else if (kind === 'comment') await this.#onTrackerComment(event);
    });
  }

  async #onTrackerIssue(event: TrackerEvent): Promise<void> {
    let issue: Issue;
    try {
      issue = await this.#o.tracker.issue(event.issueId!);
    } catch (error) {
      if (!isNotFound(error)) throw error;
      // Gone for good (a permanent delete): close what it was linked to.
      const link = this.#o.store.issueByTracker(event.issueId!);
      if (link) await this.#applyToGitHub(link, { ...link.snapshot, state: 'not_planned' });
      return;
    }
    const link = await this.#linkFromTracker(issue);
    if (link) await this.#applyToGitHub(link, snapshotOfTracker(issue), issue);
  }

  /** The repository a tracker issue belongs on: its own `repo`, or its project's only one. */
  async #repoFor(issue: Issue): Promise<string | undefined> {
    if (issue.repo) return issue.repo;
    const project = await this.#o.tracker.project(issue.projectId);
    return project?.repos.length === 1 ? project.repos[0]!.fullName : undefined;
  }

  /**
   * The link for a tracker issue: stored, adopted from a `poietic.github.url` some other integration recorded,
   * or a new GitHub issue when the issue belongs on a synced repository. `undefined` when it stays tracker-only.
   */
  async #linkFromTracker(issue: Issue): Promise<IssueLink | undefined> {
    const { store, github, tracker, log } = this.#o;
    const stored = store.issueByTracker(issue.id);
    if (stored) return stored;

    const recorded = parseIssueUrl(issue.metadata[GITHUB_URL_KEY]);
    if (recorded) {
      if (this.#excluded(recorded.repo)) return undefined;
      const gh = await github.getIssue(recorded.repo, recorded.number);
      const link = this.#newLink(recorded.repo, gh, issue, snapshotOfGitHub(gh));
      store.saveIssue(link);
      return link;
    }

    if (issue.deletedAt) return undefined;
    const repo = await this.#repoFor(issue);
    if (!repo || this.#excluded(repo)) return undefined;
    const snapshot = snapshotOfTracker(issue);
    const gh = await github.createIssue(repo, {
      title: snapshot.title,
      body: bodyWithMarker(snapshot.body, issue.id),
      labels: snapshot.labels,
    });
    const link = this.#newLink(repo, gh, issue, { ...snapshot, state: 'open' });
    store.saveIssue(link);
    log.info('github.created', { key: issue.key, repo, number: gh.number });
    await tracker.updateIssue(
      issue.id,
      { metadata: { ...issue.metadata, [GITHUB_URL_KEY]: gh.html_url } },
      `mirrored to GitHub issue ${ref(repo, gh.number)}`,
    );
    return link;
  }

  /** Writes what changed on the tracker since the last sync to the GitHub issue. */
  async #applyToGitHub(link: IssueLink, next: Snapshot, issue?: Issue): Promise<void> {
    const change = changedFields(link.snapshot, next);
    if (isEmpty(change)) return;
    const patch: IssueChange = {};
    if (change.title !== undefined) patch.title = change.title;
    if (change.body !== undefined) patch.body = bodyWithMarker(change.body, link.trackerId);
    if (change.state !== undefined) Object.assign(patch, gitHubStateFields(change.state));
    if (change.labels !== undefined) patch.labels = change.labels;
    const gh = await this.#o.github.updateIssue(link.repo, link.number, patch);
    this.#o.store.saveIssue({
      ...link,
      trackerKey: issue?.key ?? link.trackerKey,
      url: gh.html_url,
      snapshot: next,
    });
    this.#o.log.info('github.updated', {
      repo: link.repo,
      number: link.number,
      fields: Object.keys(patch),
    });
  }

  async #onTrackerComment(event: TrackerEvent): Promise<void> {
    const { store, github, tracker, log } = this.#o;
    const data = event.data as {
      comment: {
        id: string;
        issueId: string;
        body: string;
        author: { name: string; handle: string };
      };
    };
    const comment = data.comment;
    const existing = store.commentByTracker(comment.id);

    if (event.type === 'comment.deleted') {
      if (existing?.origin === 'tracker')
        await github.deleteComment(existing.repo, existing.githubId);
      if (existing) store.deleteComment(existing.repo, existing.githubId);
      return;
    }
    if (existing) {
      if (existing.origin !== 'tracker' || existing.body === comment.body) return;
      const link = store.issueByTracker(comment.issueId);
      if (!link) return;
      await github.updateComment(
        existing.repo,
        existing.githubId,
        gitHubCommentBody(comment, comment.author, this.#trackerIssueUrl(link.trackerKey)),
      );
      store.saveComment({ ...existing, body: comment.body });
      return;
    }
    if (event.type !== 'comment.created') return;

    let issue: Issue;
    try {
      issue = await tracker.issue(comment.issueId);
    } catch (error) {
      if (isNotFound(error)) return;
      throw error;
    }
    const link = await this.#linkFromTracker(issue);
    if (!link) return;
    const created = await github.createComment(
      link.repo,
      link.number,
      gitHubCommentBody(comment, comment.author, this.#trackerIssueUrl(issue.key)),
    );
    store.saveComment({
      repo: link.repo,
      githubId: created.id,
      trackerId: comment.id,
      trackerIssueId: issue.id,
      origin: 'tracker',
      body: comment.body,
    });
    log.info('github.commented', { repo: link.repo, number: link.number, key: issue.key });
  }

  // ------------------------------------------------------------------ recovery

  /**
   * Rebuilds issue links from `poietic.github.url` on tracker issues, for a store that was lost. Snapshots are
   * taken from the tracker as it is now, so changes made on GitHub meanwhile are seen on its next event.
   */
  async rebuild(): Promise<number> {
    const { store, tracker } = this.#o;
    let found = 0;
    for (const project of await tracker.projects()) {
      if (project.repos.length === 0) continue;
      for await (const issue of tracker.allIssues(project.id)) {
        const recorded = parseIssueUrl(issue.metadata[GITHUB_URL_KEY]);
        if (!recorded || this.#excluded(recorded.repo)) continue;
        if (store.issueByTracker(issue.id)) continue;
        store.saveIssue({
          repo: recorded.repo,
          number: recorded.number,
          trackerId: issue.id,
          trackerKey: issue.key,
          projectId: issue.projectId,
          url: issue.metadata[GITHUB_URL_KEY] as string,
          snapshot: snapshotOfTracker(issue),
        });
        found++;
      }
    }
    return found;
  }
}
