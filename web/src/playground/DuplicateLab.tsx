import { useState } from 'react';
import { Badge, Button, Card, Field, Input, Notice, Select } from '../components/ui';
import { ingestEvent, type Registry } from './registry';
import { DEMO_SOURCES } from './samples';
import { SimBanner } from './ui';

interface LogRow {
  n: number;
  sourceId: string;
  deliveryId: string;
  result: string;
  tone: 'success' | 'warn' | 'danger';
}

export function DuplicateLab({
  registry,
  onRegistry,
  clockMs,
  onAdvance,
}: {
  registry: Registry;
  onRegistry: (r: Registry) => void;
  clockMs: number;
  onAdvance: () => void;
}) {
  const [sourceId, setSourceId] = useState<string>('github');
  const [deliveryId, setDeliveryId] = useState('dlv-demo-0001');
  const [log, setLog] = useState<LogRow[]>([]);

  const send = (id: string | undefined, src = sourceId): void => {
    const source = DEMO_SOURCES.find((s) => s.id === src);
    if (source === undefined) return;
    const out = ingestEvent(
      registry,
      {
        sourceId: src,
        deliveryId: id,
        payload: '{"demo":true}',
        headers: {},
        targets: source.targets,
      },
      clockMs,
    );
    onAdvance();
    if (!out.ok) {
      setLog((l) => [
        ...l,
        {
          n: l.length + 1,
          sourceId: src,
          deliveryId: id ?? '(none)',
          result: `400 ${out.error}`,
          tone: 'danger',
        },
      ]);
      return;
    }
    onRegistry(out.registry);
    const o = out.outcome;
    setLog((l) => [
      ...l,
      o.status === 'duplicate'
        ? {
            n: l.length + 1,
            sourceId: src,
            deliveryId: id ?? '(none)',
            result: `200 duplicate · nothing stored (matches ${o.existingEventId})`,
            tone: 'warn',
          }
        : {
            n: l.length + 1,
            sourceId: src,
            deliveryId: o.deliveryId,
            result: `202 accepted · ${o.eventId}${o.generatedId ? ' · ID was generated, cannot be deduplicated' : ''}`,
            tone: 'success',
          },
    ]);
  };

  const nextId = (): string => {
    const m = /^(.*?)(\d+)$/.exec(deliveryId);
    return m ? `${m[1]}${String(Number(m[2]) + 1).padStart(m[2]!.length, '0')}` : `${deliveryId}-2`;
  };

  return (
    <div className="space-y-4">
      <SimBanner>
        Local simulated event registry. Production deduplication is a unique (source, delivery ID)
        constraint inside the PostgreSQL transaction, not this list.
      </SimBanner>
      <div className="grid gap-4 lg:grid-cols-[22rem_1fr]">
        <Card title="Send a delivery">
          <div className="space-y-3">
            <Field label="Source">
              {(id) => (
                <Select
                  id={id}
                  value={sourceId}
                  onChange={(e) => {
                    setSourceId(e.target.value);
                  }}
                >
                  {DEMO_SOURCES.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.id}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label="Provider delivery ID" hint="Header value such as X-GitHub-Delivery">
              {(id) => (
                <Input
                  id={id}
                  value={deliveryId}
                  onChange={(e) => {
                    setDeliveryId(e.target.value);
                  }}
                  className="font-mono"
                />
              )}
            </Field>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="primary"
                onClick={() => {
                  send(deliveryId);
                }}
              >
                Send
              </Button>
              <Button
                onClick={() => {
                  send(deliveryId);
                }}
              >
                Send same ID again
              </Button>
              <Button
                onClick={() => {
                  const n = nextId();
                  setDeliveryId(n);
                  send(n);
                }}
              >
                Send with a new ID
              </Button>
              <Button
                onClick={() => {
                  send(undefined);
                }}
              >
                Send without an ID
              </Button>
              <Button
                onClick={() => {
                  const other = sourceId === 'github' ? 'payments' : 'github';
                  send(deliveryId, other);
                }}
              >
                Same ID, other source
              </Button>
            </div>
            <Button
              variant="ghost"
              onClick={() => {
                setLog([]);
                onRegistry({ events: [], seq: 0 });
                setDeliveryId('dlv-demo-0001');
              }}
            >
              Clear simulated events
            </Button>
          </div>
        </Card>
        <div className="space-y-4">
          <Card
            title="Request log"
            actions={
              <Badge tone="sim">
                {log.length} requests · {registry.events.length} stored
              </Badge>
            }
          >
            {log.length === 0 ? (
              <p className="text-sm text-muted">Send a delivery, then send the same ID again.</p>
            ) : (
              <ol className="space-y-2" aria-label="Duplicate detection log">
                {log.map((r) => (
                  <li key={r.n} className="flex flex-wrap items-center gap-2 text-sm">
                    <span className="font-mono text-xs text-muted">#{r.n}</span>
                    <span className="font-mono text-xs">
                      {r.sourceId}/{r.deliveryId}
                    </span>
                    <Badge tone={r.tone}>{r.result}</Badge>
                  </li>
                ))}
              </ol>
            )}
          </Card>
          <Notice>
            A repeated (source, delivery ID) pair is acknowledged with{' '}
            <span className="font-mono">200 duplicate</span> and creates nothing, so providers that
            retry do not cause double processing. The same ID under another source is a different
            event. If a source has no delivery ID header configured, or a request omits it,
            HookRelay generates an ID and flags the event{' '}
            <span className="font-mono">generatedId</span>; those events cannot be deduplicated this
            way, so each request is stored separately.
          </Notice>
        </div>
      </div>
    </div>
  );
}
