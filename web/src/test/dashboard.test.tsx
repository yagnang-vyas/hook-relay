import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { deliveryRecord, eventSummary, mockFetch, renderApp, uuid } from './helpers';

const health = {
  'GET /healthz': () => ({ body: { status: 'ok' } }),
  'GET /readyz': () => ({ body: { status: 'ready' } }),
};

describe('overview', () => {
  it('asks for a key instead of calling the admin API', async () => {
    const m = mockFetch(health);
    renderApp(m.fetch);
    expect(await screen.findByText('Admin API key required')).toBeInTheDocument();
    expect(m.calls.some((c) => c.url.startsWith('/api'))).toBe(false);
    expect(await screen.findByText('alive')).toBeInTheDocument();
  });

  it('shows counters as process-local and derives distribution from loaded events only', async () => {
    const m = mockFetch({
      ...health,
      'GET /api/metrics': () => ({
        body: {
          counters: [
            { name: 'events_accepted_total', labels: { source: 'github' }, value: 7 },
            {
              name: 'invalid_signatures_total',
              labels: { source: 'github', reason: 'signature_mismatch' },
              value: 2,
            },
          ],
        },
      }),
      'GET /api/events': () => ({ body: { data: [eventSummary(1)], nextCursor: 'more' } }),
      'GET /api/deliveries/dead': () => ({ body: { data: [], nextCursor: null } }),
    });
    renderApp(m.fetch, { apiKey: 'secret' });
    expect(await screen.findByText(/reset when it restarts/)).toBeInTheDocument();
    expect(await screen.findByText('Events accepted')).toBeInTheDocument();
    expect(screen.getByText('7')).toBeInTheDocument();
    expect(await screen.findByText(/1 most recent events/)).toBeInTheDocument();
    expect(screen.getByText(/more events exist/)).toBeInTheDocument();
  });

  it('shows a meaningful error with the request ID when the key is rejected', async () => {
    const unauthorized = () => ({
      status: 401,
      body: {
        error: {
          code: 'unauthorized',
          message: 'A valid admin API key is required',
          requestId: 'req-401',
        },
      },
    });
    const m = mockFetch({
      ...health,
      'GET /api/metrics': unauthorized,
      'GET /api/events': unauthorized,
      'GET /api/deliveries/dead': unauthorized,
    });
    renderApp(m.fetch, { apiKey: 'wrong' });
    const alerts = await screen.findAllByRole('alert');
    expect(alerts[0]).toHaveTextContent('A valid admin API key is required');
    expect(alerts[0]).toHaveTextContent('request ID: req-401');
    expect(alerts[0]).toHaveTextContent('Update it in Settings');
  });
});

describe('events explorer', () => {
  it('shows an empty state', async () => {
    const m = mockFetch({
      ...health,
      'GET /api/events': () => ({ body: { data: [], nextCursor: null } }),
    });
    renderApp(m.fetch, { apiKey: 'k', hash: '#/events' });
    expect(await screen.findByText('No events match')).toBeInTheDocument();
  });

  it('paginates with the server cursor and does not refetch earlier pages', async () => {
    const m = mockFetch({
      ...health,
      'GET /api/events': (c) =>
        c.url.includes('cursor=next-1')
          ? { body: { data: [eventSummary(2)], nextCursor: null } }
          : { body: { data: [eventSummary(1)], nextCursor: 'next-1' } },
    });
    renderApp(m.fetch, { apiKey: 'k', hash: '#/events' });
    await screen.findByText(uuid(1));
    await userEvent.click(screen.getByRole('button', { name: 'Load older events' }));
    await screen.findByText(uuid(2));
    expect(screen.getByText(uuid(1))).toBeInTheDocument();
    expect(screen.getByText(/End of results · 2 loaded/)).toBeInTheDocument();
    const eventCalls = m.calls.filter((c) => c.url.startsWith('/api/events'));
    expect(eventCalls).toHaveLength(2);
    expect(eventCalls[0]!.url).toContain('limit=25');
  });

  it('sends filters to the server instead of filtering client-side', async () => {
    const m = mockFetch({
      ...health,
      'GET /api/events': () => ({ body: { data: [eventSummary(1)], nextCursor: null } }),
    });
    renderApp(m.fetch, { apiKey: 'k', hash: '#/events' });
    await screen.findByText(uuid(1));
    await userEvent.type(screen.getByLabelText('Source ID'), 'payments');
    await userEvent.selectOptions(screen.getByLabelText(/Delivery status/), 'dead');
    await userEvent.click(screen.getByRole('button', { name: 'Apply filters' }));
    await waitFor(() => {
      expect(m.calls.at(-1)!.url).toContain('source=payments');
    });
    expect(m.calls.at(-1)!.url).toContain('status=dead');
  });

  it('shows list errors with a retry', async () => {
    const m = mockFetch({
      ...health,
      'GET /api/events': () => ({
        status: 500,
        body: {
          error: { code: 'internal_error', message: 'Internal error', requestId: 'req-500' },
        },
      }),
    });
    renderApp(m.fetch, { apiKey: 'k', hash: '#/events' });
    expect(await screen.findByRole('alert')).toHaveTextContent('req-500');
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });
});

describe('event details', () => {
  const detail = (over: Record<string, unknown> = {}) => ({
    ...eventSummary(1),
    deliveries: [deliveryRecord(1)],
    ...over,
  });

  it('renders metadata and attempt history, and fetches the payload only on request, as text', async () => {
    const payload = '<script>alert(1)</script>';
    const m = mockFetch({
      ...health,
      [`GET /api/events/${uuid(1)}`]: (c) =>
        c.url.includes('includeBody=true')
          ? { body: { ...detail(), bodyBase64: btoa(payload) } }
          : { body: detail() },
    });
    renderApp(m.fetch, { apiKey: 'k', hash: `#/events/${uuid(1)}` });
    expect(await screen.findByText('dlv-1')).toBeInTheDocument();
    expect(screen.getByText('max_attempts')).toBeInTheDocument();
    expect(screen.getByText('Attempt history')).toBeInTheDocument();
    expect(m.calls.some((c) => c.url.includes('includeBody'))).toBe(false);

    await userEvent.click(screen.getByRole('button', { name: 'Load payload' }));
    const block = await screen.findByLabelText('Event payload');
    expect(block.textContent).toBe(payload);
    expect(document.querySelector('script')).toBeNull();
  });

  it('pretty-prints JSON payloads', async () => {
    const m = mockFetch({
      ...health,
      [`GET /api/events/${uuid(1)}`]: (c) => ({
        body: c.url.includes('includeBody')
          ? { ...detail(), bodyBase64: btoa('{"a":1}') }
          : detail(),
      }),
    });
    renderApp(m.fetch, { apiKey: 'k', hash: `#/events/${uuid(1)}` });
    await userEvent.click(await screen.findByRole('button', { name: 'Load payload' }));
    expect((await screen.findByLabelText('Event payload')).textContent).toBe('{\n  "a": 1\n}');
  });

  it('handles purged payloads clearly', async () => {
    const m = mockFetch({
      ...health,
      [`GET /api/events/${uuid(1)}`]: () => ({ body: detail({ bodyPurged: true }) }),
    });
    renderApp(m.fetch, { apiKey: 'k', hash: `#/events/${uuid(1)}` });
    expect(await screen.findByText(/purged by the retention policy/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Replay event' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Load payload' })).toBeDisabled();
  });

  it('shows a 404 for unknown events', async () => {
    const m = mockFetch({
      ...health,
      [`GET /api/events/${uuid(9)}`]: () => ({
        status: 404,
        body: { error: { code: 'not_found', message: 'Event not found', requestId: 'r' } },
      }),
    });
    renderApp(m.fetch, { apiKey: 'k', hash: `#/events/${uuid(9)}` });
    expect(await screen.findByRole('alert')).toHaveTextContent('Event not found');
  });

  it('requires confirmation, submits replay once, and reports the server result without claiming success', async () => {
    let replays = 0;
    const m = mockFetch({
      ...health,
      [`GET /api/events/${uuid(1)}`]: () => ({ body: detail() }),
      [`POST /api/events/${uuid(1)}/replay`]: async () => {
        replays++;
        await new Promise((r) => setTimeout(r, 30));
        return {
          status: 201,
          body: { deliveries: [{ id: uuid(777), targetId: 'orders-service', status: 'pending' }] },
        };
      },
    });
    renderApp(m.fetch, { apiKey: 'k', hash: `#/events/${uuid(1)}` });
    await userEvent.click(await screen.findByRole('button', { name: 'Replay event' }));
    const dialog = await screen.findByRole('dialog', { name: 'Replay event' });
    expect(replays).toBe(0);
    expect(dialog).toHaveTextContent('at least once');
    const confirm = within(dialog).getByRole('button', { name: 'Replay event' });
    await userEvent.dblClick(confirm);
    await within(dialog).findByText(/does not mean they have been delivered/);
    expect(replays).toBe(1);
    expect(within(dialog).getByText('pending')).toBeInTheDocument();
  });

  it('shows replay conflicts from the server', async () => {
    const m = mockFetch({
      ...health,
      [`GET /api/events/${uuid(1)}`]: () => ({ body: detail() }),
      [`POST /api/events/${uuid(1)}/replay`]: () => ({
        status: 409,
        body: {
          error: {
            code: 'body_purged',
            message: 'The event body has been purged by the retention policy',
            requestId: 'req-409',
          },
        },
      }),
    });
    renderApp(m.fetch, { apiKey: 'k', hash: `#/events/${uuid(1)}` });
    await userEvent.click(await screen.findByRole('button', { name: 'Replay event' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Replay event' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('req-409');
  });

  it('cancels without sending anything', async () => {
    const m = mockFetch({ ...health, [`GET /api/events/${uuid(1)}`]: () => ({ body: detail() }) });
    renderApp(m.fetch, { apiKey: 'k', hash: `#/events/${uuid(1)}` });
    await userEvent.click(await screen.findByRole('button', { name: 'Replay event' }));
    await userEvent.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Cancel' }),
    );
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(m.calls.some((c) => c.method === 'POST')).toBe(false);
  });
});

describe('dead letter queue', () => {
  const deadItem = {
    id: uuid(101),
    eventId: uuid(1),
    targetId: 'orders-service',
    attempts: 8,
    lastStatus: 503,
    lastError: 'target responded with HTTP 503',
    deadReason: 'max_attempts',
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-01T00:01:00.000Z',
    event: { sourceId: 'github', deliveryId: 'dlv-1', bodyPurged: false },
  };

  it('lists dead deliveries and retries one after confirmation', async () => {
    let retries = 0;
    const m = mockFetch({
      ...health,
      'GET /api/deliveries/dead': () => ({
        body: { data: retries === 0 ? [deadItem] : [], nextCursor: null },
      }),
      [`POST /api/deliveries/${uuid(101)}/retry`]: () => {
        retries++;
        return { body: deliveryRecord(1, { status: 'pending' }) };
      },
    });
    renderApp(m.fetch, { apiKey: 'k', hash: '#/dead' });
    expect(await screen.findByText('max_attempts')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    const dialog = await screen.findByRole('dialog');
    expect(retries).toBe(0);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Retry delivery' }));
    await within(dialog).findByText(/That is not a confirmation/);
    expect(retries).toBe(1);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    expect(await screen.findByText('The dead letter queue is empty')).toBeInTheDocument();
  });

  it('shows a conflict when the delivery is no longer dead', async () => {
    const m = mockFetch({
      ...health,
      'GET /api/deliveries/dead': () => ({ body: { data: [deadItem], nextCursor: null } }),
      [`POST /api/deliveries/${uuid(101)}/retry`]: () => ({
        status: 409,
        body: {
          error: {
            code: 'not_dead',
            message: 'Delivery is pending, not dead',
            requestId: 'req-nd',
          },
        },
      }),
    });
    renderApp(m.fetch, { apiKey: 'k', hash: '#/dead' });
    await userEvent.click(await screen.findByRole('button', { name: 'Retry' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Retry delivery' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('not dead');
  });
});

describe('system health', () => {
  it('shows liveness and readiness separately, with the readiness reason', async () => {
    const m = mockFetch({
      'GET /healthz': () => ({ body: { status: 'ok' } }),
      'GET /readyz': () => ({
        status: 503,
        body: { status: 'unavailable', reason: 'database_unreachable' },
      }),
    });
    renderApp(m.fetch, { hash: '#/health' });
    expect(await screen.findByText('alive')).toBeInTheDocument();
    expect(await screen.findByText('unavailable')).toBeInTheDocument();
    expect(screen.getByText('database_unreachable')).toBeInTheDocument();
    expect(m.calls.every((c) => c.headers['Authorization'] === undefined)).toBe(true);
  });
});

describe('settings and navigation', () => {
  it('keeps the key in memory only and uses it as a bearer token', async () => {
    const m = mockFetch({ ...health, 'GET /api/metrics': () => ({ body: { counters: [] } }) });
    renderApp(m.fetch, { hash: '#/settings' });
    await userEvent.type(screen.getByLabelText('ADMIN_API_KEY'), 'super-secret-value');
    await userEvent.click(screen.getByRole('button', { name: 'Use key' }));
    await userEvent.click(screen.getByRole('button', { name: 'Test connection' }));
    expect(await screen.findByText(/Connected/)).toBeInTheDocument();
    expect(m.calls.at(-1)!.headers['Authorization']).toBe('Bearer super-secret-value');
    const stored = JSON.stringify({ ...localStorage, ...sessionStorage });
    expect(stored).not.toContain('super-secret-value');
    expect(window.location.href).not.toContain('super-secret-value');
    expect(screen.getByLabelText('ADMIN_API_KEY')).toHaveValue('');
  });

  it('has a mobile navigation menu', async () => {
    const m = mockFetch(health);
    renderApp(m.fetch);
    await userEvent.click(screen.getByRole('button', { name: 'Open navigation menu' }));
    const navs = screen.getAllByRole('navigation', { name: 'Primary' });
    expect(navs.length).toBeGreaterThan(0);
    await userEvent.click(screen.getByRole('button', { name: 'Close navigation menu' }));
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Close navigation menu' })).toBeNull();
    });
  });

  it('lists every primary destination including a working Playground', () => {
    renderApp(mockFetch(health).fetch);
    const nav = screen.getAllByRole('navigation', { name: 'Primary' })[0]!;
    for (const name of [
      'Overview',
      'Events',
      'Dead Letter Queue',
      'Playground',
      'System Health',
      'Connection',
    ]) {
      expect(within(nav).getByRole('link', { name })).toBeInTheDocument();
    }
  });
});
