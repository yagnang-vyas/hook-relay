import { RefreshCw } from 'lucide-react';
import { useConnection } from '../api/connection';
import { useResource } from '../api/useResource';
import { Badge, Button, Card, ErrorBanner, Mono, PageHeader, Spinner } from '../components/ui';

export function HealthCards({ compact = false }: { compact?: boolean }) {
  const { client, version } = useConnection();
  const live = useResource((s) => client.liveness(s), [client, version]);
  const ready = useResource((s) => client.readiness(s), [client, version]);

  const refresh = (): void => {
    live.reload();
    ready.reload();
  };

  return (
    <div className="space-y-3">
      <div className={compact ? 'grid gap-3 sm:grid-cols-2' : 'grid gap-4 md:grid-cols-2'}>
        <Card title="Liveness" actions={<Mono>GET /healthz</Mono>}>
          {live.loading && live.data === undefined ? (
            <Spinner />
          ) : live.error !== undefined ? (
            <ErrorBanner error={live.error} onRetry={live.reload} />
          ) : live.data !== undefined ? (
            <div className="space-y-1">
              <Badge tone={live.data.ok ? 'success' : 'danger'}>
                {live.data.ok ? 'alive' : 'not alive'}
              </Badge>
              {!compact && (
                <p className="text-sm text-muted">
                  The API process is up and answering requests (status:{' '}
                  <Mono>{live.data.status}</Mono>).
                </p>
              )}
            </div>
          ) : null}
        </Card>
        <Card title="Readiness" actions={<Mono>GET /readyz</Mono>}>
          {ready.loading && ready.data === undefined ? (
            <Spinner />
          ) : ready.error !== undefined ? (
            <ErrorBanner error={ready.error} onRetry={ready.reload} />
          ) : ready.data !== undefined ? (
            <div className="space-y-1">
              <Badge tone={ready.data.ready ? 'success' : 'danger'}>
                {ready.data.ready ? 'ready' : 'unavailable'}
              </Badge>
              {ready.data.reason !== undefined && (
                <p className="text-sm">
                  Reason: <Mono>{ready.data.reason}</Mono>
                </p>
              )}
              {!compact && (
                <p className="text-sm text-muted">
                  Ready means the database is reachable and every migration shipped with this build
                  has been applied.
                </p>
              )}
            </div>
          ) : null}
        </Card>
      </div>
      {!compact && (
        <Button onClick={refresh}>
          <RefreshCw className="size-3.5" aria-hidden /> Refresh
        </Button>
      )}
    </div>
  );
}

export function HealthPage() {
  return (
    <>
      <PageHeader
        title="System health"
        description="Liveness and readiness are separate signals. Neither requires the admin key, and neither exposes connection details."
      />
      <HealthCards />
    </>
  );
}
