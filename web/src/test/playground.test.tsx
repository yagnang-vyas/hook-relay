import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockFetch, renderApp } from './helpers';

function openPlayground() {
  const m = mockFetch({});
  renderApp(m.fetch, { hash: '#/playground' });
  return m;
}
const tab = (name: string) => userEvent.click(screen.getByRole('tab', { name }));

describe('simulation mode', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('network must not be used'));
  });
  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('is a real, labelled simulation workspace with every section', () => {
    openPlayground();
    for (const name of [
      'Request',
      'Signature lab',
      'Delivery & retries',
      'Duplicates',
      'Event inspector',
      'Dead letter',
    ]) {
      expect(screen.getByRole('tab', { name })).toBeInTheDocument();
    }
    expect(screen.getAllByText('SIMULATED').length).toBeGreaterThan(0);
  });

  describe('request simulator', () => {
    it('validates JSON, blocks invalid payloads and never silently corrects them', async () => {
      openPlayground();
      const editor = screen.getByLabelText('JSON payload');
      const run = screen.getByRole('button', { name: 'Run simulated request' });
      await waitFor(() => {
        expect(run).toBeEnabled();
      });
      fireEvent.change(editor, { target: { value: '{"a": ' } });
      expect(await screen.findByText(/Invalid JSON/)).toBeInTheDocument();
      expect(run).toBeDisabled();
      expect(editor).toHaveValue('{"a": ');
      fireEvent.change(editor, { target: { value: '{"a": 1}' } });
      expect(await screen.findByText('Valid JSON')).toBeInTheDocument();
      expect(run).toBeEnabled();
    });

    it('loading an example updates source, payload and headers consistently', async () => {
      openPlayground();
      await userEvent.selectOptions(screen.getByLabelText('Example'), 'payment_succeeded');
      expect(screen.getByLabelText('Demo source')).toHaveValue('payments');
      expect((screen.getByLabelText('JSON payload') as HTMLTextAreaElement).value).toContain(
        'payment.succeeded',
      );
      expect((screen.getByLabelText(/^Headers/) as HTMLTextAreaElement).value).toContain(
        'X-Event-Id: evt_demo_1001',
      );
      await userEvent.selectOptions(screen.getByLabelText('Example'), 'order_created');
      expect(screen.getByLabelText('Demo source')).toHaveValue('github');
      expect((screen.getByLabelText(/^Headers/) as HTMLTextAreaElement).value).toContain(
        'X-GitHub-Delivery: dlv-demo-2001',
      );
    });

    it('resets all inputs', async () => {
      openPlayground();
      await userEvent.selectOptions(screen.getByLabelText('Example'), 'payment_succeeded');
      fireEvent.change(screen.getByLabelText('JSON payload'), {
        target: { value: '{"edited":true}' },
      });
      await userEvent.click(screen.getByRole('button', { name: 'Reset inputs' }));
      expect(screen.getByLabelText('Example')).toHaveValue('payment_succeeded');
      expect((screen.getByLabelText('JSON payload') as HTMLTextAreaElement).value).toContain(
        'payment.succeeded',
      );
      expect(screen.getByLabelText('Demo source')).toHaveValue('payments');
    });

    it('previews the request and runs a signed request to a simulated 202, then 200 duplicate', async () => {
      openPlayground();
      const run = screen.getByRole('button', { name: 'Run simulated request' });
      await waitFor(() => {
        expect(screen.getByLabelText('Request preview').textContent).toMatch(
          /X-Signature: t=\d+,v1=[0-9a-f]{64}/,
        );
      });
      expect(screen.getByLabelText('Request preview').textContent).toContain(
        'POST /hooks/payments HTTP/1.1',
      );
      await userEvent.click(run);
      const out = await screen.findByLabelText('Simulated response body');
      expect(out.textContent).toContain('"status": "accepted"');
      expect(screen.getByText('HTTP 202')).toBeInTheDocument();
      await userEvent.click(run);
      await waitFor(() => {
        expect(screen.getByText('HTTP 200')).toBeInTheDocument();
      });
      expect(screen.getByLabelText('Simulated response body').textContent).toContain('duplicate');
    });

    it.each([
      ['tampered', 'Valid signature, body altered after signing'],
      ['malformed', 'Malformed signature'],
      ['missing', 'Missing signature header'],
    ])('rejects a %s signature with a generic 401', async (_k, label) => {
      openPlayground();
      await userEvent.selectOptions(screen.getByLabelText(/^Signature \(demo secret\)/), label);
      await userEvent.click(screen.getByRole('button', { name: 'Run simulated request' }));
      expect(await screen.findByText('HTTP 401')).toBeInTheDocument();
      const body = screen.getByLabelText('Simulated response body').textContent!;
      expect(body).toContain('Unauthorized');
      expect(body).not.toMatch(/mismatch|malformed|missing/);
    });

    it('rejects credential headers', async () => {
      openPlayground();
      fireEvent.change(screen.getByLabelText(/^Headers/), {
        target: { value: 'Authorization: Bearer abc' },
      });
      expect(await screen.findByText(/looks like a credential/)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Run simulated request' })).toBeDisabled();
    });
  });

  describe('signature lab', () => {
    it('verifies a valid signature and rejects tampering, wrong secrets and malformed headers', async () => {
      openPlayground();
      await tab('Signature lab');
      const list = await screen.findByRole('list', { name: 'Verification examples' });
      await waitFor(() => {
        expect(within(list).getAllByRole('listitem').length).toBeGreaterThanOrEqual(5);
      });
      const item = (title: string) => within(list).getByText(title).closest('li')!;
      expect(item('Valid signature')).toHaveTextContent('accepted');
      expect(item('Payload tampered after signing')).toHaveTextContent(
        'rejected: signature_mismatch',
      );
      expect(item('Wrong secret')).toHaveTextContent('rejected: signature_mismatch');
      expect(item('Malformed signature')).toHaveTextContent('rejected: malformed_header');
      expect(item('Missing signature header')).toHaveTextContent('rejected: missing_header');
      expect(item('Same JSON, re-serialised')).toHaveTextContent('signature_mismatch');
      expect(screen.getByText(/Why raw bytes matter/)).toBeInTheDocument();
    });

    it('shows the GitHub-style signature format and verifies a pasted header', async () => {
      openPlayground();
      await tab('Signature lab');
      const generated = await waitFor(() => {
        const text = screen.getByLabelText('Generated signature').textContent!;
        expect(text).toMatch(/^sha256=[0-9a-f]{64}$/);
        return text;
      });
      await userEvent.type(screen.getByLabelText(/Signature header value to verify/), generated);
      await userEvent.click(screen.getByRole('button', { name: 'Verify' }));
      expect(await screen.findByRole('status')).toHaveTextContent('accepted');
    });

    it('adds the stale-timestamp example for the timestamped scheme', async () => {
      openPlayground();
      await tab('Signature lab');
      await userEvent.selectOptions(screen.getByLabelText('Scheme'), 'timestamped');
      const list = await screen.findByRole('list', { name: 'Verification examples' });
      await waitFor(() => {
        expect(
          within(list).getByText('Correct signature, stale timestamp').closest('li'),
        ).toHaveTextContent('timestamp_out_of_tolerance');
      });
    });
  });

  describe('delivery simulator', () => {
    const pick = async (label: string) => {
      await tab('Delivery & retries');
      await userEvent.selectOptions(screen.getByLabelText('Scenario'), label);
    };

    it('runs a temporary 503 then success to completion', async () => {
      openPlayground();
      await pick('Temporary 503, then success');
      await userEvent.click(screen.getByRole('button', { name: 'Step' }));
      await userEvent.click(screen.getByRole('button', { name: 'Show all' }));
      const tl = screen.getByLabelText('Delivery lifecycle timeline');
      expect(tl).toHaveTextContent('Event accepted (simulated 202)');
      expect(tl).toHaveTextContent('Event persisted (simulated)');
      expect(tl).toHaveTextContent('Simulated target response: HTTP 503');
      expect(tl).toHaveTextContent('Retry scheduled');
      expect(tl).toHaveTextContent('Delivery succeeded');
      expect(screen.getByText('Resulting delivery record (simulated)')).toBeInTheDocument();
    });

    it('steps one entry at a time and can be reset', async () => {
      openPlayground();
      await pick('Immediate success');
      await userEvent.click(screen.getByRole('button', { name: 'Step' }));
      expect(
        within(screen.getByLabelText('Delivery lifecycle timeline')).getAllByRole('listitem'),
      ).toHaveLength(1);
      await userEvent.click(screen.getByRole('button', { name: 'Step' }));
      expect(
        within(screen.getByLabelText('Delivery lifecycle timeline')).getAllByRole('listitem'),
      ).toHaveLength(2);
      await userEvent.click(screen.getByRole('button', { name: 'Reset run' }));
      expect(screen.getByText(/Choose a scenario/)).toBeInTheDocument();
    });

    it('plays automatically and can be paused', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        openPlayground();
        await pick('Immediate success');
        await userEvent.click(screen.getByRole('button', { name: 'Run simulation' }));
        expect(screen.getByRole('button', { name: 'Pause' })).toBeEnabled();
        for (let i = 0; i < 3; i++)
          await act(async () => {
            await vi.advanceTimersByTimeAsync(500);
          });
        const n = within(screen.getByLabelText('Delivery lifecycle timeline')).getAllByRole(
          'listitem',
        ).length;
        expect(n).toBeGreaterThan(1);
        await userEvent.click(screen.getByRole('button', { name: 'Pause' }));
        await act(async () => {
          await vi.advanceTimersByTimeAsync(3000);
        });
        expect(
          within(screen.getByLabelText('Delivery lifecycle timeline')).getAllByRole('listitem'),
        ).toHaveLength(n);
      } finally {
        vi.useRealTimers();
      }
    });

    it('exhausts the retry budget and dead-letters', async () => {
      openPlayground();
      await pick('Exhausted retry budget');
      fireEvent.change(screen.getByLabelText(/Retry budget/), { target: { value: '3' } });
      await userEvent.click(screen.getByRole('button', { name: 'Step' }));
      await userEvent.click(screen.getByRole('button', { name: 'Show all' }));
      expect(screen.getByLabelText('Delivery lifecycle timeline')).toHaveTextContent(
        'Dead-lettered: retry budget exhausted',
      );
      expect(screen.getByText(/Dead-letter record/)).toBeInTheDocument();
    });

    it('dead-letters a non-retryable client error immediately', async () => {
      openPlayground();
      await pick('Immediate non-retryable client error');
      await userEvent.click(screen.getByRole('button', { name: 'Step' }));
      await userEvent.click(screen.getByRole('button', { name: 'Show all' }));
      const tl = screen.getByLabelText('Delivery lifecycle timeline');
      expect(tl).toHaveTextContent('Dead-lettered: permanent client error');
      expect(tl).not.toHaveTextContent('Retry scheduled');
    });
  });

  describe('dead letter walkthrough', () => {
    it('dead-letters, then a simulated manual retry recovers', async () => {
      openPlayground();
      await tab('Dead letter');
      await userEvent.click(screen.getByRole('button', { name: 'Step' }));
      await userEvent.click(screen.getByRole('button', { name: 'Show all' }));
      expect(screen.getByText('Dead-letter record · manual retry')).toBeInTheDocument();
      expect(screen.getByText(/fresh retry budget/)).toBeInTheDocument();
      expect(screen.getByText(/Nothing is sent to HookRelay/)).toBeInTheDocument();
      await userEvent.click(screen.getByRole('button', { name: 'Trigger simulated manual retry' }));
      await waitFor(() => {
        expect(screen.getByLabelText('Delivery lifecycle timeline')).toHaveTextContent(
          'Operator retry (simulated POST /api/deliveries/:id/retry)',
        );
      });
      await userEvent.click(screen.getByRole('button', { name: 'Show all' }));
      expect(screen.getByLabelText('Delivery lifecycle timeline')).toHaveTextContent(
        'Delivery succeeded',
      );
    });

    it('can fail again after a manual retry', async () => {
      openPlayground();
      await tab('Dead letter');
      await userEvent.click(screen.getByRole('button', { name: 'Step' }));
      await userEvent.click(screen.getByRole('button', { name: 'Show all' }));
      await userEvent.selectOptions(screen.getByLabelText('Next target behaviour'), 'failing');
      await userEvent.click(screen.getByRole('button', { name: 'Trigger simulated manual retry' }));
      await userEvent.click(await screen.findByRole('button', { name: 'Show all' }));
      expect(
        within(screen.getByLabelText('Delivery lifecycle timeline')).getAllByText(
          'Dead-lettered: retry budget exhausted',
        ),
      ).toHaveLength(2);
    });
  });

  describe('duplicate detection', () => {
    it('acknowledges the same ID as a duplicate without storing another event', async () => {
      openPlayground();
      await tab('Duplicates');
      await userEvent.click(screen.getByRole('button', { name: 'Send' }));
      await userEvent.click(screen.getByRole('button', { name: 'Send same ID again' }));
      await userEvent.click(screen.getByRole('button', { name: 'Send with a new ID' }));
      const log = screen.getByRole('list', { name: 'Duplicate detection log' });
      const items = within(log).getAllByRole('listitem');
      expect(items[0]).toHaveTextContent('202 accepted');
      expect(items[1]).toHaveTextContent('200 duplicate');
      expect(items[2]).toHaveTextContent('202 accepted');
      expect(screen.getByText('3 requests · 2 stored')).toBeInTheDocument();
    });

    it('explains generated IDs and clears simulated events', async () => {
      openPlayground();
      await tab('Duplicates');
      await userEvent.click(screen.getByRole('button', { name: 'Send without an ID' }));
      expect(screen.getByRole('list', { name: 'Duplicate detection log' })).toHaveTextContent(
        'cannot be deduplicated',
      );
      await userEvent.click(screen.getByRole('button', { name: 'Clear simulated events' }));
      expect(screen.getByText('0 requests · 0 stored')).toBeInTheDocument();
    });
  });

  describe('event inspector', () => {
    it('shows events created elsewhere, runs deliveries and replays them in simulation', async () => {
      openPlayground();
      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Run simulated request' })).toBeEnabled();
      });
      await userEvent.click(screen.getByRole('button', { name: 'Run simulated request' }));
      await screen.findByText('HTTP 202');
      await tab('Event inspector');
      const list = screen.getByRole('list', { name: 'Simulated events' });
      expect(within(list).getByText('sim-evt-0001')).toBeInTheDocument();
      expect(screen.getAllByText('SIMULATED').length).toBeGreaterThan(0);

      await userEvent.click(screen.getByRole('button', { name: /^Run delivery/ }));
      expect(screen.getByLabelText('Event timeline')).toHaveTextContent('Delivery succeeded');

      await userEvent.click(screen.getByRole('button', { name: 'Replay event (simulated)' }));
      expect(screen.getByLabelText('Event timeline')).toHaveTextContent(
        'Operator replay (simulated POST /api/events/:id/replay)',
      );
      expect(screen.getAllByRole('button', { name: /^Run delivery/ })).toHaveLength(1);

      await userEvent.click(screen.getByRole('button', { name: 'Clear' }));
      expect(screen.getByText('No simulated events yet')).toBeInTheDocument();
    });

    it('can retry a dead simulated delivery', async () => {
      openPlayground();
      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Run simulated request' })).toBeEnabled();
      });
      await userEvent.click(screen.getByRole('button', { name: 'Run simulated request' }));
      await screen.findByText('HTTP 202');
      await tab('Event inspector');
      await userEvent.selectOptions(
        screen.getByLabelText(/Target behaviour/),
        'Immediate non-retryable client error',
      );
      await userEvent.click(screen.getByRole('button', { name: /^Run delivery/ }));
      expect(screen.getByLabelText('Event timeline')).toHaveTextContent(
        'Dead-lettered: permanent client error',
      );
      await userEvent.click(screen.getByRole('button', { name: /^Retry dead delivery/ }));
      expect(screen.getByLabelText('Event timeline')).toHaveTextContent('Operator retry');
      expect(screen.getByLabelText('Event timeline')).toHaveTextContent('Delivery succeeded');
    });
  });

  it('makes no network requests anywhere in the playground', async () => {
    const m = openPlayground();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Run simulated request' })).toBeEnabled();
    });
    await userEvent.click(screen.getByRole('button', { name: 'Run simulated request' }));
    for (const name of [
      'Signature lab',
      'Delivery & retries',
      'Duplicates',
      'Event inspector',
      'Dead letter',
    ])
      await tab(name);
    await userEvent.click(screen.getByRole('button', { name: 'Step' }));
    await userEvent.click(screen.getByRole('button', { name: 'Show all' }));
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(m.fn).not.toHaveBeenCalled();
  });

  it('needs no API key and never shows the dashboard key state as simulated data', () => {
    renderApp(mockFetch({}).fetch, { hash: '#/playground', apiKey: 'real-admin-key' });
    expect(screen.queryByText('real-admin-key')).toBeNull();
    expect(screen.getByText('simulation workspace')).toBeInTheDocument();
  });
});

describe('separation of simulation and real API state', () => {
  it('keeps simulated events out of the dashboard and the dashboard out of the simulation', async () => {
    const m = mockFetch({
      'GET /healthz': () => ({ body: { status: 'ok' } }),
      'GET /readyz': () => ({ body: { status: 'ready' } }),
      'GET /api/events': () => ({ body: { data: [], nextCursor: null } }),
    });
    renderApp(m.fetch, { apiKey: 'k', hash: '#/playground' });
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Run simulated request' })).toBeEnabled();
    });
    await userEvent.click(screen.getByRole('button', { name: 'Run simulated request' }));
    await screen.findByText('HTTP 202');
    expect(m.calls).toHaveLength(0);
    window.location.hash = '#/events';
    expect(await screen.findByText('No events match')).toBeInTheDocument();
    expect(screen.queryByText('sim-evt-0001')).toBeNull();
  });
});

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

describe('architecture and secret hygiene', () => {
  const srcDir = join(__dirname, '..');
  const files = walk(srcDir).filter(
    (f) => /\.(ts|tsx)$/.test(f) && !/\.test\./.test(f) && !f.includes('/test/'),
  );

  it('the playground module does not import the API client or connection state', () => {
    const offenders = files
      .filter((f) => f.includes('/playground/') || f.endsWith('pages/Playground.tsx'))
      .filter((f) =>
        /from '(\.\.\/)+api\/|from '\.\.\/api|api\/(client|connection)/.test(
          readFileSync(f, 'utf8'),
        ),
      );
    expect(offenders).toEqual([]);
  });

  it('the playground never calls fetch, XHR, WebSocket or sendBeacon', () => {
    const offenders = files
      .filter((f) => f.includes('/playground/') || f.endsWith('pages/Playground.tsx'))
      .filter((f) =>
        /\bfetch\(|XMLHttpRequest|WebSocket|sendBeacon|EventSource/.test(readFileSync(f, 'utf8')),
      );
    expect(offenders).toEqual([]);
  });

  it('only a non-secret base URL is read from the build environment', () => {
    const used = new Set<string>();
    for (const f of files) {
      for (const m of readFileSync(f, 'utf8').matchAll(
        /import\.meta\.env(?:\.(\w+)|\[\s*'(\w+)'\s*\])/g,
      ))
        used.add(m[1] ?? m[2] ?? '');
    }
    expect([...used]).toEqual(['VITE_HOOKRELAY_API_BASE_URL']);
  });

  it('does not persist the admin key', () => {
    for (const f of files) {
      const text = readFileSync(f, 'utf8');
      for (const m of text.matchAll(/(localStorage|sessionStorage)\.setItem\(([^,)]+)/g)) {
        expect(m[2]).not.toMatch(/key|token|secret|auth/i);
      }
    }
  });

  it('contains no embedded credential-looking strings', () => {
    for (const f of files) {
      const text = readFileSync(f, 'utf8');
      expect(text).not.toMatch(/ADMIN_API_KEY\s*[:=]\s*['"][^'"]{8,}/);
      expect(text).not.toMatch(/Bearer [A-Za-z0-9_-]{16,}/);
    }
  });
});
