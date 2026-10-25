import { useCallback, useEffect, useState } from 'react';
import { ApiError } from '../api/client';
import { useConnection } from '../api/connection';
import { DELIVERY_STATUSES, type DeliveryStatus, type EventSummary } from '../api/types';
import { RequireKey } from '../components/RequireKey';
import {
  Button,
  EmptyState,
  ErrorBanner,
  Field,
  Input,
  Mono,
  PageHeader,
  Select,
  Spinner,
  StatusBadge,
} from '../components/ui';
import { formatBytes, formatTime } from '../lib/format';

function EventsList() {
  const { client, version } = useConnection();
  const [source, setSource] = useState('');
  const [status, setStatus] = useState<DeliveryStatus | ''>('');
  const [applied, setApplied] = useState<{ source: string; status: DeliveryStatus | '' }>({
    source: '',
    status: '',
  });
  const [items, setItems] = useState<EventSummary[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ApiError | undefined>();

  const load = useCallback(
    async (after: string | null, signal?: AbortSignal) => {
      setLoading(true);
      setError(undefined);
      try {
        const page = await client.listEvents(
          { source: applied.source, status: applied.status, limit: 25, cursor: after },
          signal,
        );
        if (signal?.aborted === true) return;
        setItems((prev) => (after === null ? page.data : [...prev, ...page.data]));
        setCursor(page.nextCursor);
      } catch (err) {
        if (signal?.aborted === true) return;
        setError(
          err instanceof ApiError
            ? err
            : new ApiError({ status: 0, code: 'unknown', message: String(err), kind: 'unknown' }),
        );
      } finally {
        if (signal?.aborted !== true) setLoading(false);
      }
    },
    [client, applied],
  );

  useEffect(() => {
    const controller = new AbortController();
    setItems([]);
    setCursor(null);
    void load(null, controller.signal);
    return () => {
      controller.abort();
    };
  }, [load, version]);

  return (
    <>
      <form
        className="mb-4 flex flex-wrap items-end gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          setApplied({ source: source.trim(), status });
        }}
      >
        <Field label="Source ID">
          {(id) => (
            <Input
              id={id}
              value={source}
              onChange={(e) => {
                setSource(e.target.value);
              }}
              placeholder="e.g. github"
              maxLength={64}
            />
          )}
        </Field>
        <Field label="Delivery status" hint="Events with at least one delivery in this status">
          {(id) => (
            <Select
              id={id}
              value={status}
              onChange={(e) => {
                setStatus(e.target.value as DeliveryStatus | '');
              }}
            >
              <option value="">Any</option>
              {DELIVERY_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Button type="submit" variant="primary">
          Apply filters
        </Button>
        <Button
          onClick={() => {
            setSource('');
            setStatus('');
            setApplied({ source: '', status: '' });
          }}
        >
          Clear
        </Button>
      </form>

      {error !== undefined && (
        <div className="mb-3">
          <ErrorBanner
            error={error}
            onRetry={() => {
              void load(null);
            }}
          />
        </div>
      )}

      {items.length === 0 && loading ? (
        <Spinner label="Loading events" />
      ) : items.length === 0 && error === undefined ? (
        <EmptyState title="No events match">
          Events appear here after a provider posts a signed webhook to{' '}
          <Mono>/hooks/&lt;sourceId&gt;</Mono>.
        </EmptyState>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-line bg-panel">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-line bg-panel2 text-xs text-muted">
              <tr>
                <th className="px-3 py-2 font-medium">Event ID</th>
                <th className="px-3 py-2 font-medium">Source</th>
                <th className="px-3 py-2 font-medium">Provider delivery ID</th>
                <th className="px-3 py-2 font-medium">Received</th>
                <th className="px-3 py-2 font-medium">Size</th>
                <th className="px-3 py-2 font-medium">Deliveries</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {items.map((e) => (
                <tr key={e.id}>
                  <td className="px-3 py-2">
                    <a
                      className="font-mono text-xs text-accent underline"
                      href={`#/events/${e.id}`}
                    >
                      {e.id}
                    </a>
                  </td>
                  <td className="px-3 py-2">
                    <Mono>{e.sourceId}</Mono>
                  </td>
                  <td className="px-3 py-2">
                    <Mono>{e.deliveryId}</Mono>
                    {e.generatedId && <span className="ml-1 text-xs text-muted">(generated)</span>}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-xs">
                    {formatTime(e.receivedAt)}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-xs">
                    {e.bodyPurged ? 'purged' : formatBytes(e.bodySize)}
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex flex-wrap gap-1.5">
                      {e.deliveries.map((d) => (
                        <span key={d.id} className="flex items-center gap-1">
                          <StatusBadge status={d.status} />
                          <Mono className="text-muted">
                            {d.targetId} ×{d.attempts}
                          </Mono>
                        </span>
                      ))}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {items.length > 0 && (
        <div className="mt-3 flex items-center gap-3">
          {cursor !== null ? (
            <Button
              busy={loading}
              onClick={() => {
                void load(cursor);
              }}
            >
              Load older events
            </Button>
          ) : (
            <span className="text-xs text-muted">End of results · {items.length} loaded</span>
          )}
        </div>
      )}
    </>
  );
}

export function EventsPage() {
  return (
    <>
      <PageHeader
        title="Events"
        description="Newest first, cursor-paginated by the server. Payloads are never included in the list."
      />
      <RequireKey>
        <EventsList />
      </RequireKey>
    </>
  );
}
