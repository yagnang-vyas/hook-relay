import { useState } from 'react';
import { Badge, Button, Card, CodeBlock, EmptyState, Field, Mono, Select } from '../components/ui';
import { seededRandom } from './backoff';
import { DEFAULT_TARGET, SCENARIOS, manualRetry, runToCompletion, scenarioById } from './engine';
import { emptyRegistry, replayEvent, updateEvent, type Registry, type SimEvent } from './registry';
import { DeliveryTable, SimBanner, Timeline } from './ui';

export function EventInspector({
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
  const [selectedId, setSelectedId] = useState<string | undefined>();
  const [scenarioId, setScenarioId] = useState('transient_503');
  const selected: SimEvent | undefined =
    registry.events.find((e) => e.id === selectedId) ?? registry.events[0];

  const runDelivery = (event: SimEvent, deliveryId: string): void => {
    const d = event.deliveries.find((x) => x.id === deliveryId);
    if (d === undefined) return;
    const scenario = scenarioById(scenarioId);
    const target = {
      ...DEFAULT_TARGET,
      id: d.targetId,
      maxAttempts: scenario.maxAttempts ?? DEFAULT_TARGET.maxAttempts,
    };
    const start = clockMs;
    const result = runToCompletion(
      d,
      scenario.responseFor,
      target,
      seededRandom(registry.seq * 7 + 1),
      start,
    );
    onRegistry(
      updateEvent(registry, {
        ...event,
        deliveries: event.deliveries.map((x) => (x.id === d.id ? result.delivery : x)),
        timeline: [...event.timeline, ...result.steps],
      }),
    );
    onAdvance();
  };

  const retryDead = (event: SimEvent, deliveryId: string): void => {
    const d = event.deliveries.find((x) => x.id === deliveryId);
    if (d === undefined) return;
    const retried = manualRetry(d, clockMs);
    if (retried === undefined) return;
    const finished = runToCompletion(
      retried.delivery,
      () => ({ kind: 'status', code: 200 }),
      DEFAULT_TARGET,
      seededRandom(3),
      clockMs,
    );
    onRegistry(
      updateEvent(registry, {
        ...event,
        deliveries: event.deliveries.map((x) => (x.id === d.id ? finished.delivery : x)),
        timeline: [...event.timeline, ...retried.steps, ...finished.steps],
      }),
    );
    onAdvance();
  };

  const replay = (event: SimEvent): void => {
    const out = replayEvent(registry, event.id, clockMs);
    if (out !== undefined) onRegistry(out.registry);
    onAdvance();
  };

  return (
    <div className="space-y-4">
      <SimBanner>
        Simulated events created in this playground. They are kept in memory and are not production
        data.
      </SimBanner>
      {registry.events.length === 0 ? (
        <EmptyState title="No simulated events yet">
          Run a request in the Request tab or the Duplicates tab to create one.
        </EmptyState>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[20rem_1fr]">
          <Card
            title="Simulated events"
            actions={
              <Button
                variant="ghost"
                onClick={() => {
                  onRegistry(emptyRegistry());
                  setSelectedId(undefined);
                }}
              >
                Clear
              </Button>
            }
          >
            <ul className="space-y-1" aria-label="Simulated events">
              {registry.events.map((e) => {
                const active = e.id === selected?.id;
                return (
                  <li key={e.id}>
                    <button
                      type="button"
                      aria-pressed={active}
                      onClick={() => {
                        setSelectedId(e.id);
                      }}
                      className={`w-full rounded-md border px-2.5 py-1.5 text-left ${active ? 'border-accent bg-panel2' : 'border-line hover:bg-panel2'}`}
                    >
                      <div className="flex items-center gap-2">
                        <Mono>{e.id}</Mono>
                        <Badge tone="sim">sim</Badge>
                      </div>
                      <div className="text-xs text-muted">
                        {e.sourceId} · {e.deliveryId}
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
          </Card>

          {selected !== undefined && (
            <div className="space-y-4">
              <Card
                title={
                  <span>
                    Event <Mono>{selected.id}</Mono>
                  </span>
                }
                actions={<Badge tone="sim">SIMULATED</Badge>}
              >
                <dl className="grid gap-3 text-sm sm:grid-cols-3">
                  <div>
                    <dt className="text-xs text-muted">Source</dt>
                    <dd>
                      <Mono>{selected.sourceId}</Mono>
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted">Delivery ID</dt>
                    <dd>
                      <Mono>{selected.deliveryId}</Mono>
                      {selected.generatedId && ' (generated)'}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted">Deliveries</dt>
                    <dd>{selected.deliveries.length}</dd>
                  </div>
                </dl>
                <div className="mt-3">
                  <CodeBlock label="Simulated payload">{selected.payload}</CodeBlock>
                </div>
              </Card>

              <Card title="Deliveries">
                <div className="mb-3 flex flex-wrap items-end gap-3">
                  <Field label="Target behaviour for “Run delivery”">
                    {(id) => (
                      <Select
                        id={id}
                        value={scenarioId}
                        onChange={(e) => {
                          setScenarioId(e.target.value);
                        }}
                      >
                        {SCENARIOS.filter((s) => !s.stopsAtDead || s.id === 'manual_retry').map(
                          (s) => (
                            <option key={s.id} value={s.id}>
                              {s.label}
                            </option>
                          ),
                        )}
                      </Select>
                    )}
                  </Field>
                  <Button
                    onClick={() => {
                      replay(selected);
                    }}
                  >
                    Replay event (simulated)
                  </Button>
                </div>
                <DeliveryTable deliveries={selected.deliveries} />
                <ul className="mt-3 space-y-2">
                  {selected.deliveries.map((d) => (
                    <li key={d.id} className="flex flex-wrap items-center gap-2 text-sm">
                      <Mono>{d.id}</Mono>
                      {d.status === 'pending' && (
                        <Button
                          onClick={() => {
                            runDelivery(selected, d.id);
                          }}
                        >
                          Run delivery {d.id}
                        </Button>
                      )}
                      {d.status === 'dead' && (
                        <Button
                          onClick={() => {
                            retryDead(selected, d.id);
                          }}
                        >
                          Retry dead delivery {d.id}
                        </Button>
                      )}
                    </li>
                  ))}
                </ul>
              </Card>

              <Card title="Timeline">
                <Timeline steps={selected.timeline} label="Event timeline" />
              </Card>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
