import { useState } from 'react';
import { ApiError } from '../api/client';
import { useConnection } from '../api/connection';
import type { Delivery } from '../api/types';
import { useResource } from '../api/useResource';
import { AT_LEAST_ONCE_NOTE, ConfirmAction } from '../components/ConfirmAction';
import { RequireKey } from '../components/RequireKey';
import {
  Badge,
  Button,
  Card,
  CodeBlock,
  ErrorBanner,
  Mono,
  Notice,
  PageHeader,
  Spinner,
  StatusBadge,
} from '../components/ui';
import {
  decodeBody,
  formatBytes,
  formatDuration,
  formatTime,
  type DecodedBody,
} from '../lib/format';

function Meta({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="mt-0.5">{children}</dd>
    </div>
  );
}

function EventDetailBody({ id }: { id: string }) {
  const { client, version } = useConnection();
  const detail = useResource((s) => client.getEvent(id, {}, s), [client, id, version]);
  const [body, setBody] = useState<
    | { state: 'idle' }
    | { state: 'loading' }
    | { state: 'purged' }
    | { state: 'error'; error: ApiError }
    | { state: 'ready'; body: DecodedBody }
  >({ state: 'idle' });
  const [replayOpen, setReplayOpen] = useState(false);
  const [replayTargets, setReplayTargets] = useState<string[]>([]);
  const [retrying, setRetrying] = useState<Delivery | undefined>();

  const loadBody = async (): Promise<void> => {
    setBody({ state: 'loading' });
    try {
      const full = await client.getEvent(id, { includeBody: true });
      if (full.bodyBase64 === null || full.bodyBase64 === undefined) setBody({ state: 'purged' });
      else setBody({ state: 'ready', body: decodeBody(full.bodyBase64) });
    } catch (err) {
      setBody({
        state: 'error',
        error:
          err instanceof ApiError
            ? err
            : new ApiError({ status: 0, code: 'unknown', message: String(err), kind: 'unknown' }),
      });
    }
  };

  if (detail.loading && detail.data === undefined) return <Spinner label="Loading event" />;
  if (detail.error !== undefined)
    return <ErrorBanner error={detail.error} onRetry={detail.reload} />;
  const event = detail.data;
  if (event === undefined) return null;
  const knownTargets = [...new Set(event.deliveries.map((d) => d.targetId))];

  return (
    <div className="space-y-4">
      <Card
        title="Event"
        actions={
          <Button
            variant="primary"
            disabled={event.bodyPurged}
            title={event.bodyPurged ? 'The payload was purged by the retention policy' : undefined}
            onClick={() => {
              setReplayTargets([]);
              setReplayOpen(true);
            }}
          >
            Replay event
          </Button>
        }
      >
        <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Meta label="Event ID">
            <Mono>{event.id}</Mono>
          </Meta>
          <Meta label="Source">
            <Mono>{event.sourceId}</Mono>
          </Meta>
          <Meta label="Provider delivery ID">
            <Mono>{event.deliveryId}</Mono>
            {event.generatedId && (
              <span className="ml-2">
                <Badge>generated</Badge>
              </span>
            )}
          </Meta>
          <Meta label="Received">{formatTime(event.receivedAt)}</Meta>
          <Meta label="Content type">
            <Mono>{event.contentType ?? '—'}</Mono>
          </Meta>
          <Meta label="Payload size">
            {formatBytes(event.bodySize)}
            {event.bodyPurged && (
              <span className="ml-2">
                <Badge tone="warn">purged</Badge>
              </span>
            )}
          </Meta>
        </dl>
        {Object.keys(event.headers).length > 0 && (
          <details className="mt-4">
            <summary className="cursor-pointer text-sm text-muted">
              Stored headers (allow-listed)
            </summary>
            <CodeBlock label="Stored headers">
              {Object.entries(event.headers)
                .map(([k, v]) => `${k}: ${v}`)
                .join('\n')}
            </CodeBlock>
          </details>
        )}
        {event.bodyPurged && (
          <div className="mt-3">
            <Notice tone="warn">
              The payload was purged by the retention policy. This event can no longer be replayed
              and its dead deliveries cannot be retried.
            </Notice>
          </div>
        )}
      </Card>

      <Card
        title="Payload"
        actions={
          <Button
            busy={body.state === 'loading'}
            disabled={event.bodyPurged}
            onClick={() => void loadBody()}
          >
            {body.state === 'ready' ? 'Reload payload' : 'Load payload'}
          </Button>
        }
      >
        {body.state === 'idle' && (
          <p className="text-sm text-muted">
            Payloads are fetched only when you ask (<Mono>includeBody=true</Mono>) and are shown as
            plain text, never rendered as HTML.
          </p>
        )}
        {body.state === 'loading' && <Spinner label="Fetching payload" />}
        {body.state === 'purged' && (
          <p className="text-sm text-warn">The payload has been purged.</p>
        )}
        {body.state === 'error' && <ErrorBanner error={body.error} />}
        {body.state === 'ready' && (
          <div className="space-y-2">
            <Badge tone="info">{body.body.kind}</Badge>
            <CodeBlock label="Event payload">{body.body.text}</CodeBlock>
          </div>
        )}
      </Card>

      {event.deliveries.length === 0 && <Notice>This event has no deliveries.</Notice>}
      {event.deliveries.map((d) => (
        <Card
          key={d.id}
          title={
            <span className="flex flex-wrap items-center gap-2">
              Delivery to <Mono>{d.targetId}</Mono> <StatusBadge status={d.status} />
            </span>
          }
          actions={
            d.status === 'dead' ? (
              <Button
                disabled={event.bodyPurged}
                onClick={() => {
                  setRetrying(d);
                }}
              >
                Retry delivery
              </Button>
            ) : undefined
          }
        >
          <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Meta label="Delivery ID">
              <Mono>{d.id}</Mono>
            </Meta>
            <Meta label="Attempts (lifetime / this budget)">
              <Mono>
                {d.attempts} / {d.attempts - d.attemptsBase}
              </Mono>
            </Meta>
            <Meta label="Last HTTP status">
              <Mono>{d.lastStatus ?? '—'}</Mono>
            </Meta>
            <Meta label="Next attempt">{formatTime(d.nextAttemptAt)}</Meta>
            <Meta label="Created">{formatTime(d.createdAt)}</Meta>
            <Meta label="Updated">{formatTime(d.updatedAt)}</Meta>
            <Meta label="Delivered">{formatTime(d.deliveredAt)}</Meta>
            <Meta label="Dead reason">
              <Mono>{d.deadReason ?? '—'}</Mono>
            </Meta>
          </dl>
          {d.lastError !== null && (
            <p className="mt-3 text-sm text-danger">
              Last error: <Mono>{d.lastError}</Mono>
            </p>
          )}
          <h3 className="mb-1 mt-4 text-xs font-medium text-muted">Attempt history</h3>
          {d.attemptHistory.length === 0 ? (
            <p className="text-sm text-muted">No attempts yet.</p>
          ) : (
            <div className="overflow-x-auto rounded-md border border-line">
              <table className="w-full text-left text-sm">
                <thead className="bg-panel2 text-xs text-muted">
                  <tr>
                    <th className="px-3 py-1.5 font-medium">#</th>
                    <th className="px-3 py-1.5 font-medium">Started</th>
                    <th className="px-3 py-1.5 font-medium">Duration</th>
                    <th className="px-3 py-1.5 font-medium">HTTP</th>
                    <th className="px-3 py-1.5 font-medium">Error</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {d.attemptHistory.map((a) => (
                    <tr key={a.id}>
                      <td className="px-3 py-1.5 font-mono text-xs">{a.attemptNumber}</td>
                      <td className="whitespace-nowrap px-3 py-1.5 text-xs">
                        {formatTime(a.startedAt)}
                      </td>
                      <td className="px-3 py-1.5 font-mono text-xs">
                        {formatDuration(a.durationMs)}
                      </td>
                      <td className="px-3 py-1.5 font-mono text-xs">{a.statusCode ?? '—'}</td>
                      <td className="px-3 py-1.5 font-mono text-xs">{a.error ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      ))}

      <ConfirmAction
        title="Replay event"
        open={replayOpen}
        onClose={() => {
          setReplayOpen(false);
        }}
        confirmLabel="Replay event"
        description={
          <>
            <p>
              Creates <strong>new pending deliveries</strong> for this event from its stored
              payload. Existing deliveries are left untouched.
            </p>
            <Notice tone="warn">{AT_LEAST_ONCE_NOTE}</Notice>
            <fieldset>
              <legend className="mb-1 text-xs font-medium text-muted">
                Targets (leave all unchecked to use every configured target of the source)
              </legend>
              {knownTargets.map((t) => (
                <label key={t} className="mr-4 inline-flex items-center gap-1.5">
                  <input
                    type="checkbox"
                    checked={replayTargets.includes(t)}
                    onChange={(e) => {
                      setReplayTargets((prev) =>
                        e.target.checked ? [...prev, t] : prev.filter((x) => x !== t),
                      );
                    }}
                  />
                  <Mono>{t}</Mono>
                </label>
              ))}
            </fieldset>
          </>
        }
        run={() => client.replayEvent(id, replayTargets)}
        renderResult={(r) => (
          <>
            <p>
              The server accepted the replay and created {r.deliveries.length} delivery record
              {r.deliveries.length === 1 ? '' : 's'}. This does not mean they have been delivered;
              the worker will attempt them shortly.
            </p>
            <ul className="space-y-1">
              {r.deliveries.map((d) => (
                <li key={d.id} className="flex items-center gap-2">
                  <Mono>{d.targetId}</Mono> <StatusBadge status={d.status} />{' '}
                  <Mono className="text-muted">{d.id}</Mono>
                </li>
              ))}
            </ul>
          </>
        )}
        onDone={detail.reload}
      />

      <ConfirmAction
        title="Retry dead delivery"
        open={retrying !== undefined}
        onClose={() => {
          setRetrying(undefined);
        }}
        confirmLabel="Retry delivery"
        description={
          <>
            <p>
              Moves delivery <Mono>{retrying?.id ?? ''}</Mono> back to <strong>pending</strong> with
              a fresh retry budget and makes it due immediately. Attempt numbering and history
              continue.
            </p>
            <Notice tone="warn">{AT_LEAST_ONCE_NOTE}</Notice>
          </>
        }
        run={() => client.retryDelivery((retrying as Delivery).id)}
        renderResult={(d) => (
          <p>
            The server re-queued the delivery; its status is now <StatusBadge status={d.status} />.
            It has not been delivered yet.
          </p>
        )}
        onDone={detail.reload}
      />
    </div>
  );
}

export function EventDetailPage({ id }: { id: string }) {
  return (
    <>
      <PageHeader
        title="Event details"
        description={
          <a className="text-accent underline" href="#/events">
            ← Back to events
          </a>
        }
      />
      <RequireKey>
        <EventDetailBody id={id} />
      </RequireKey>
    </>
  );
}
