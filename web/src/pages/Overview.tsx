import { RefreshCw } from 'lucide-react';
import { lazy, Suspense } from 'react';
import { useConnection } from '../api/connection';
import type { EventSummary, MetricCounter } from '../api/types';
import { useResource } from '../api/useResource';
import { RequireKey } from '../components/RequireKey';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorBanner,
  Mono,
  Notice,
  PageHeader,
  Spinner,
  StatusBadge,
} from '../components/ui';
import { formatTime } from '../lib/format';
import { HealthCards } from './Health';

// Recharts is only needed here; load it on demand to keep the initial bundle small.
const AttemptsChart = lazy(() => import('../components/AttemptsChart'));

function sumBy(counters: MetricCounter[], name: string, label?: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const c of counters) {
    if (c.name !== name) continue;
    const key = label === undefined ? name : (c.labels[label] ?? 'unknown');
    out.set(key, (out.get(key) ?? 0) + c.value);
  }
  return out;
}

function total(counters: MetricCounter[], name: string): number {
  return [...sumBy(counters, name).values()].reduce((a, b) => a + b, 0);
}

function Stat({ label, value, note }: { label: string; value: string | number; note?: string }) {
  return (
    <div className="rounded-lg border border-line bg-panel p-3">
      <div className="text-xs text-muted">{label}</div>
      <div className="mt-1 font-mono text-2xl font-semibold">{value}</div>
      {note !== undefined && <div className="mt-0.5 text-xs text-muted">{note}</div>}
    </div>
  );
}

function OverviewData() {
  const { client, version } = useConnection();
  const metrics = useResource((s) => client.getMetrics(s), [client, version]);
  const events = useResource((s) => client.listEvents({ limit: 25 }, s), [client, version]);
  const dead = useResource((s) => client.listDeadDeliveries({ limit: 50 }, s), [client, version]);

  const refresh = (): void => {
    metrics.reload();
    events.reload();
    dead.reload();
  };

  const counters = metrics.data;
  const attempts =
    counters !== undefined ? sumBy(counters, 'delivery_attempts_total', 'result') : undefined;
  const chartData =
    attempts !== undefined
      ? [...attempts.entries()].map(([result, value]) => ({ result, value }))
      : [];

  const dist = new Map<string, number>();
  for (const e of events.data?.data ?? []) {
    for (const d of e.deliveries) dist.set(d.status, (dist.get(d.status) ?? 0) + 1);
  }
  const loadedEvents = events.data?.data.length ?? 0;
  const moreEvents = events.data?.nextCursor != null;

  return (
    <>
      <div className="mb-3 flex justify-end">
        <Button onClick={refresh}>
          <RefreshCw className="size-3.5" aria-hidden /> Refresh
        </Button>
      </div>

      <div className="space-y-4">
        <Card title="Process-local counters">
          <Notice>
            These counters come from <Mono>GET /api/metrics</Mono>. They live in the memory of the
            API process, reset when it restarts, and are not durable history or cluster-wide totals.
            A standalone worker process keeps its own counters, which this endpoint does not
            include.
          </Notice>
          <div className="mt-3">
            {metrics.loading && counters === undefined ? (
              <Spinner label="Loading counters" />
            ) : metrics.error !== undefined ? (
              <ErrorBanner error={metrics.error} onRetry={metrics.reload} />
            ) : counters !== undefined ? (
              <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
                <Stat label="Events accepted" value={total(counters, 'events_accepted_total')} />
                <Stat label="Duplicates" value={total(counters, 'events_duplicate_total')} />
                <Stat
                  label="Invalid signatures"
                  value={total(counters, 'invalid_signatures_total')}
                />
                <Stat
                  label="Delivery attempts"
                  value={total(counters, 'delivery_attempts_total')}
                />
                <Stat label="Replays" value={total(counters, 'replays_total')} />
                <Stat label="Manual retries" value={total(counters, 'manual_retries_total')} />
              </div>
            ) : null}
          </div>
        </Card>

        <div className="grid gap-4 lg:grid-cols-2">
          <Card title="Delivery attempts by result (since API start)">
            {chartData.length === 0 ? (
              <EmptyState title="No attempts recorded by this process yet" />
            ) : (
              <Suspense fallback={<Spinner label="Loading chart" />}>
                <AttemptsChart data={chartData} />
              </Suspense>
            )}
          </Card>

          <Card title={`Delivery status in the ${loadedEvents} most recent events`}>
            <p className="mb-3 text-xs text-muted">
              Counted from the first page of <Mono>GET /api/events</Mono>
              {moreEvents ? ' (more events exist)' : ''}. The API provides no global event total.
            </p>
            {events.loading && events.data === undefined ? (
              <Spinner />
            ) : events.error !== undefined ? (
              <ErrorBanner error={events.error} onRetry={events.reload} />
            ) : dist.size === 0 ? (
              <EmptyState title="No deliveries in the loaded events" />
            ) : (
              <div className="flex flex-wrap gap-2">
                {[...dist.entries()].map(([status, n]) => (
                  <span key={status} className="flex items-center gap-2">
                    <StatusBadge status={status} />
                    <span className="font-mono text-sm">{n}</span>
                  </span>
                ))}
              </div>
            )}
            <div className="mt-4 border-t border-line pt-3 text-sm">
              <a className="text-accent underline" href="#/dead">
                Dead letter queue
              </a>
              :{' '}
              {dead.error !== undefined ? (
                <span className="text-danger">unavailable ({dead.error.code})</span>
              ) : dead.data === undefined ? (
                'loading…'
              ) : (
                <Badge tone={dead.data.data.length > 0 ? 'danger' : 'success'}>
                  {dead.data.data.length}
                  {dead.data.nextCursor !== null ? '+' : ''} dead
                </Badge>
              )}
            </div>
          </Card>
        </div>

        <Card
          title="Recent events"
          actions={
            <a className="text-xs text-accent underline" href="#/events">
              View all
            </a>
          }
        >
          <RecentEvents events={events.data?.data.slice(0, 8)} loading={events.loading} />
        </Card>
      </div>
    </>
  );
}

function RecentEvents({
  events,
  loading,
}: {
  events: EventSummary[] | undefined;
  loading: boolean;
}) {
  if (events === undefined) return loading ? <Spinner /> : null;
  if (events.length === 0) return <EmptyState title="No events stored yet" />;
  return (
    <ul className="divide-y divide-line">
      {events.map((e) => (
        <li key={e.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 py-2">
          <a className="font-mono text-xs text-accent underline" href={`#/events/${e.id}`}>
            {e.id}
          </a>
          <Mono className="text-muted">{e.sourceId}</Mono>
          <span className="text-xs text-muted">{formatTime(e.receivedAt)}</span>
          <span className="ml-auto flex gap-1.5">
            {e.deliveries.map((d) => (
              <StatusBadge key={d.id} status={d.status} />
            ))}
          </span>
        </li>
      ))}
    </ul>
  );
}

export function Overview() {
  return (
    <>
      <PageHeader
        title="Overview"
        description="Live data from your HookRelay instance. Nothing here is simulated; use the Playground for simulations."
      />
      <div className="mb-4">
        <HealthCards compact />
      </div>
      <RequireKey>
        <OverviewData />
      </RequireKey>
    </>
  );
}
