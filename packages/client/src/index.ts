import createFetchClient, { type Client, type Middleware } from 'openapi-fetch';
import type { components, paths } from './generated/openapi.d.ts';

export type { components, paths } from './generated/openapi.d.ts';
export type * from './generated/openapi.d.ts';
export * from './events.ts';
export * from './follow.ts';
export * from './history.ts';

export type ApiClient = Client<paths>;
export type Schemas = components['schemas'];

export interface ClientOptions {
  /** Server origin, e.g. `http://127.0.0.1:3000`. The `/api/v1` prefix is added automatically. */
  baseUrl: string;
  /** Bearer credential (an SSO identity token), sent as `Authorization: Bearer`. */
  token?: string | undefined;
  /** Custom fetch — e.g. `app.fetch` for in-process calls, or a browser fetch with credentials. */
  fetch?: (request: Request) => Promise<Response>;
  headers?: Record<string, string>;
  /** Generates a request id per call (sent as `X-Request-Id`); lets clients recognise their own events. */
  requestId?: () => string;
}

/** Drops trailing slashes. A loop, not `/\/+$/`, which backtracks quadratically on long runs of `/`. */
function trimTrailingSlashes(url: string): string {
  let end = url.length;
  while (end > 0 && url[end - 1] === '/') end--;
  return url.slice(0, end);
}

/** Creates a fully typed client for the tracker API (generated from docs/openapi.json). */
export function createClient(options: ClientOptions): ApiClient {
  const client = createFetchClient<paths>({
    baseUrl: `${trimTrailingSlashes(options.baseUrl)}/api/v1`,
    ...(options.fetch && { fetch: options.fetch }),
    headers: options.headers,
  });
  const auth: Middleware = {
    onRequest({ request }) {
      if (options.token && !request.headers.has('authorization'))
        request.headers.set('authorization', `Bearer ${options.token}`);
      if (options.requestId && !request.headers.has('x-request-id'))
        request.headers.set('x-request-id', options.requestId());
      return request;
    },
  };
  client.use(auth);
  return client;
}

export type Problem = Schemas['Problem'];

/** An API error carrying the server's problem details. */
export class ApiError extends Error {
  readonly status: number;
  readonly problem: Problem;
  /** False when the answer was not a problem document (a proxy's HTML page, say): `problem` is made up from
   *  the status, so only the status is the server's word. */
  readonly isProblem: boolean;

  constructor(problem: Problem, opts: { isProblem?: boolean } = {}) {
    super(problem.detail ?? problem.title);
    this.name = 'ApiError';
    this.status = problem.status;
    this.problem = problem;
    this.isProblem = opts.isProblem ?? true;
  }

  get code(): Problem['code'] {
    return this.problem.code;
  }
}

/**
 * Unwraps an openapi-fetch result: returns `data` or throws {@link ApiError}.
 * Non-problem failures (e.g. a proxy returning HTML) become an INTERNAL/UNAVAILABLE problem.
 */
export function unwrap<T>(result: { data?: T; error?: unknown; response: Response }): T {
  if (result.response.ok) return result.data as T;
  throw toApiError(result.error, result.response);
}

export function toApiError(error: unknown, response: Response): ApiError {
  const body = error as Partial<Problem> | undefined;
  if (body && typeof body === 'object' && typeof body.code === 'string')
    return new ApiError(body as Problem);
  const status = response.status;
  return new ApiError(
    {
      type: 'urn:tracker:error:INTERNAL',
      title: response.statusText || 'Request failed',
      status,
      code:
        status >= 500
          ? status === 503 || status === 502
            ? 'UNAVAILABLE'
            : 'INTERNAL'
          : 'VALIDATION_FAILED',
      detail: typeof error === 'string' ? error.slice(0, 500) : `HTTP ${status}`,
    },
    { isProblem: false },
  );
}
