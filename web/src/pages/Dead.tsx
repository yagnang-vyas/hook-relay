import { useCallback, useEffect, useState } from 'react';
import { ApiError } from '../api/client';
import { useConnection } from '../api/connection';
import type { DeadDelivery } from '../api/types';
import { AT_LEAST_ONCE_NOTE, ConfirmAction } from '../components/ConfirmAction';
import { RequireKey } from '../components/RequireKey';
import {
  Button,
  EmptyState,
  ErrorBanner,
  Mono,
  Notice,
  PageHeader,
  Spinner,
  StatusBadge,
} from '../components/ui';
import { formatTime } from '../lib/format';

function DeadList() {
  const { client, version } = useConnection();
  const [items, setItems] = useState<DeadDelivery[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ApiError | undefined>();
  const [target, setTarget] = useState<DeadDelivery | undefined>();

  const load = useCallback(
    async (after: string | null, signal?: AbortSignal) => {
      setLoading(true);
      setError(undefined);
      try {
        const page = await client.listDeadDeliveries({ limit: 50, cursor: after }, signal);
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
    [client],
  );

  useEffect(() => {
    const controller = new AbortController();
    setItems([]);
    void load(null, controller.signal);
    return () => {
      controller.abort();
    };
  }, [load, version]);

  return (
    <>
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
        <Spinner label="Loading dead deliveries" />
      ) : items.length === 0 && error === undefined ? (
        <EmptyState title="The dead letter queue is empty">
          Deliveries land here after a permanent client error or when their retry budget is
          exhausted.
        </EmptyState>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-line bg-panel">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-line bg-panel2 text-xs text-muted">
              <tr>
                <th className="px-3 py-2 font-medium">Delivery</th>
                <th className="px-3 py-2 font-medium">Event</th>
                <th className="px-3 py-2 font-medium">Target</th>
                <th className="px-3 py-2 font-medium">Reason</th>
                <th className="px-3 py-2 font-medium">Attempts</th>
                <th className="px-3 py-2 font-medium">Last result</th>
                <th className="px-3 py-2 font-medium">Died</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {items.map((d) => (
                <tr key={d.id}>
                  <td className="px-3 py-2">
                    <StatusBadge status="dead" />{' '}
                    <Mono className="text-muted">{d.id.slice(0, 8)}…</Mono>
                  </td>
                  <td className="px-3 py-2">
                    <a
                      className="font-mono text-xs text-accent underline"
                      href={`#/events/${d.eventId}`}
                    >
                      {d.event.sourceId}/{d.event.deliveryId}
                    </a>
                  </td>
                  <td className="px-3 py-2">
                    <Mono>{d.targetId}</Mono>
                  </td>
                  <td className="px-3 py-2">
                    <Mono>{d.deadReason ?? '—'}</Mono>
                  </td>
                  <td className="px-3 py-2 font-mono text-xs">{d.attempts}</td>
                  <td className="px-3 py-2 font-mono text-xs">
                    {d.lastStatus ?? '—'} {d.lastError ?? ''}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-xs">{formatTime(d.updatedAt)}</td>
                  <td className="px-3 py-2 text-right">
                    <Button
                      disabled={d.event.bodyPurged}
                      title={d.event.bodyPurged ? 'Payload purged; cannot retry' : undefined}
                      onClick={() => {
                        setTarget(d);
                      }}
                    >
                      Retry
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {cursor !== null && (
        <div className="mt-3">
          <Button
            busy={loading}
            onClick={() => {
              void load(cursor);
            }}
          >
            Load more
          </Button>
        </div>
      )}

      <ConfirmAction
        title="Retry dead delivery"
        open={target !== undefined}
        onClose={() => {
          setTarget(undefined);
        }}
        confirmLabel="Retry delivery"
        description={
          <>
            <p>
              Moves the delivery to <Mono>{target?.targetId ?? ''}</Mono> back to{' '}
              <strong>pending</strong> with a fresh retry budget, due immediately.
            </p>
            <Notice tone="warn">{AT_LEAST_ONCE_NOTE}</Notice>
          </>
        }
        run={() => client.retryDelivery((target as DeadDelivery).id)}
        renderResult={(d) => (
          <p>
            The server re-queued the delivery (status <StatusBadge status={d.status} />
            ). That is not a confirmation that the target received it.
          </p>
        )}
        onDone={() => {
          void load(null);
        }}
      />
    </>
  );
}

export function DeadPage() {
  return (
    <>
      <PageHeader
        title="Dead letter queue"
        description="Deliveries that will not be attempted again unless an operator retries them."
      />
      <RequireKey>
        <DeadList />
      </RequireKey>
    </>
  );
}
