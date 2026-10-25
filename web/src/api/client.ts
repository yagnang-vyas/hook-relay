import type {
  DeadDelivery,
  DeliveryStatus,
  EventDetail,
  EventSummary,
  MetricCounter,
  Page,
  Delivery,
  ReplayResult,
  Readiness,
} from './types';

export type ApiErrorKind =
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'rate_limited'
  | 'validation'
  | 'server'
  | 'network'
  | 'timeout'
  | 'aborted'
  | 'unknown';

/** An error from the HookRelay API with the server's code, message and request ID preserved. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestId: string | undefined;
  readonly kind: ApiErrorKind;

  constructor(init: {
    status: number;
    code: string;
    message: string;
    requestId?: string | undefined;
    kind: ApiErrorKind;
  }) {
    super(init.message);
    this.name = 'ApiError';
    this.status = init.status;
    this.code = init.code;
    this.requestId = init.requestId;
    this.kind = init.kind;
  }
}

function kindForStatus(status: number): ApiErrorKind {
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 409) return 'conflict';
  if (status === 429) return 'rate_limited';
  if (status === 400 || status === 422) return 'validation';
  if (status >= 500) return 'server';
  return 'unknown';
}

export interface ApiClientOptions {
  /** Base URL without a trailing slash. Empty string means same origin. */
  baseUrl: string;
  /** Returns the operator's admin key from memory, if one has been entered. */
  getApiKey: () => string | undefined;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

interface RequestOptions {
  method?: 'GET' | 'POST';
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  signal?: AbortSignal | undefined;
  auth?: boolean;
}

const DEFAULT_TIMEOUT_MS = 15_000;

export class ApiClient {
  private readonly opts: ApiClientOptions;

  constructor(opts: ApiClientOptions) {
    this.opts = opts;
  }

  get hasApiKey(): boolean {
    return (this.opts.getApiKey() ?? '') !== '';
  }

  private url(path: string, query?: RequestOptions['query']): string {
    const base = this.opts.baseUrl.replace(/\/+$/, '');
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined && value !== '') params.set(key, String(value));
    }
    const qs = params.toString();
    return `${base}${path}${qs === '' ? '' : `?${qs}`}`;
  }

  private async raw(path: string, opts: RequestOptions): Promise<Response> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (opts.auth !== false) {
      const key = this.opts.getApiKey();
      if (key === undefined || key === '') {
        throw new ApiError({
          status: 401,
          code: 'missing_api_key',
          message: 'Enter the admin API key in Settings first.',
          kind: 'unauthorized',
        });
      }
      headers['Authorization'] = `Bearer ${key}`;
    }
    let body: string | undefined;
    if (opts.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(opts.body);
    }

    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const onAbort = (): void => {
      controller.abort();
    };
    opts.signal?.addEventListener('abort', onAbort);
    if (opts.signal?.aborted === true) controller.abort();

    try {
      const doFetch = this.opts.fetchImpl ?? fetch;
      return await doFetch(this.url(path, opts.query), {
        method: opts.method ?? 'GET',
        headers,
        ...(body !== undefined ? { body } : {}),
        signal: controller.signal,
        credentials: 'omit',
        cache: 'no-store',
      });
    } catch (err) {
      if (timedOut) {
        throw new ApiError({
          status: 0,
          code: 'timeout',
          message: 'The request timed out.',
          kind: 'timeout',
        });
      }
      if (err instanceof DOMException && err.name === 'AbortError') {
        throw new ApiError({
          status: 0,
          code: 'aborted',
          message: 'The request was cancelled.',
          kind: 'aborted',
        });
      }
      throw new ApiError({
        status: 0,
        code: 'network_error',
        message:
          'Could not reach HookRelay. Check the API base URL, that the service is running, and CORS or proxy settings.',
        kind: 'network',
      });
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
    }
  }

  private async toError(res: Response): Promise<ApiError> {
    const headerId = res.headers.get('x-request-id') ?? undefined;
    let code = `http_${res.status}`;
    let message = `HookRelay responded with HTTP ${res.status}.`;
    let requestId = headerId;
    try {
      const parsed = (await res.json()) as { error?: Record<string, unknown> };
      const e = parsed.error;
      if (e !== undefined && e !== null) {
        if (typeof e['code'] === 'string') code = e['code'];
        if (typeof e['message'] === 'string') message = e['message'];
        if (typeof e['requestId'] === 'string') requestId = e['requestId'];
      }
    } catch {
      // Non-JSON error bodies (for example from a proxy) fall back to the generic message.
    }
    return new ApiError({
      status: res.status,
      code,
      message,
      requestId,
      kind: kindForStatus(res.status),
    });
  }

  private async json<T>(path: string, opts: RequestOptions = {}): Promise<T> {
    const res = await this.raw(path, opts);
    if (!res.ok) throw await this.toError(res);
    try {
      return (await res.json()) as T;
    } catch {
      throw new ApiError({
        status: res.status,
        code: 'invalid_response',
        message: 'HookRelay returned a response that is not valid JSON.',
        requestId: res.headers.get('x-request-id') ?? undefined,
        kind: 'unknown',
      });
    }
  }

  listEvents(
    params: {
      source?: string;
      status?: DeliveryStatus | '';
      limit?: number;
      cursor?: string | null;
    },
    signal?: AbortSignal,
  ): Promise<Page<EventSummary>> {
    return this.json('/api/events', {
      query: {
        source: params.source,
        status: params.status,
        limit: params.limit,
        cursor: params.cursor ?? undefined,
      },
      signal,
    });
  }

  getEvent(
    id: string,
    opts: { includeBody?: boolean } = {},
    signal?: AbortSignal,
  ): Promise<EventDetail> {
    return this.json(`/api/events/${encodeURIComponent(id)}`, {
      query: opts.includeBody === true ? { includeBody: 'true' } : {},
      signal,
    });
  }

  replayEvent(id: string, targets?: string[]): Promise<ReplayResult> {
    return this.json(`/api/events/${encodeURIComponent(id)}/replay`, {
      method: 'POST',
      body: targets !== undefined && targets.length > 0 ? { targets } : {},
    });
  }

  listDeadDeliveries(
    params: { limit?: number; cursor?: string | null },
    signal?: AbortSignal,
  ): Promise<Page<DeadDelivery>> {
    return this.json('/api/deliveries/dead', {
      query: { limit: params.limit, cursor: params.cursor ?? undefined },
      signal,
    });
  }

  retryDelivery(id: string): Promise<Delivery> {
    return this.json(`/api/deliveries/${encodeURIComponent(id)}/retry`, { method: 'POST' });
  }

  async getMetrics(signal?: AbortSignal): Promise<MetricCounter[]> {
    const res = await this.json<{ counters: MetricCounter[] }>('/api/metrics', { signal });
    return res.counters;
  }

  async liveness(signal?: AbortSignal): Promise<{ ok: boolean; status: string }> {
    const res = await this.raw('/healthz', { auth: false, signal });
    const body = (await res.json().catch(() => ({}))) as { status?: string };
    return { ok: res.ok, status: body.status ?? `HTTP ${res.status}` };
  }

  async readiness(signal?: AbortSignal): Promise<Readiness> {
    const res = await this.raw('/readyz', { auth: false, signal });
    const body = (await res.json().catch(() => ({}))) as { status?: string; reason?: string };
    return {
      ready: res.ok,
      status: body.status ?? `HTTP ${res.status}`,
      ...(body.reason !== undefined ? { reason: body.reason } : {}),
    };
  }
}
