import { useEffect, useMemo, useState } from 'react';
import { Badge, Button, Card, Field, Input, Notice, Select } from '../components/ui';
import { backoffCeilingMs, seededRandom } from './backoff';
import {
  DEFAULT_TARGET,
  SCENARIOS,
  manualRetry,
  runToCompletion,
  scenarioById,
  simulateScenario,
  type ScenarioRun,
  type SimDelivery,
  type TimelineStep,
} from './engine';
import { DeliveryTable, SimBanner, Timeline } from './ui';

interface RunState {
  delivery: SimDelivery;
  steps: TimelineStep[];
}

const SECOND_RETRY = {
  success: {
    label: 'Target recovers (200)',
    responseFor: () => ({ kind: 'status', code: 200 }) as const,
  },
  failing: {
    label: 'Target still failing (503)',
    responseFor: () => ({ kind: 'status', code: 503 }) as const,
  },
};

export function DeliveryLab({ mode }: { mode: 'delivery' | 'deadletter' }) {
  const defaultScenario = mode === 'deadletter' ? 'manual_retry' : 'transient_503';
  const [scenarioId, setScenarioId] = useState(defaultScenario);
  const [maxAttempts, setMaxAttempts] = useState(DEFAULT_TARGET.maxAttempts);
  const [seed, setSeed] = useState(42);
  const [run, setRun] = useState<RunState | undefined>();
  const [revealed, setRevealed] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [retryChoice, setRetryChoice] = useState<keyof typeof SECOND_RETRY>('success');
  const [retries, setRetries] = useState(0);

  const scenario = scenarioById(scenarioId);
  const target = useMemo(() => ({ ...DEFAULT_TARGET, maxAttempts }), [maxAttempts]);
  const effectiveBudget = scenario.maxAttempts ?? maxAttempts;
  const total = run?.steps.length ?? 0;
  const done = run !== undefined && revealed >= total;

  useEffect(() => {
    if (!playing) return;
    if (revealed >= total) {
      setPlaying(false);
      return;
    }
    const t = setTimeout(() => {
      setRevealed((n) => n + 1);
    }, 500);
    return () => {
      clearTimeout(t);
    };
  }, [playing, revealed, total]);

  const compute = (): RunState => {
    const result: ScenarioRun = simulateScenario(scenario, target, seededRandom(seed), {
      eventId: 'sim-evt-lab',
      deliveryId: 'sim-dlv-lab',
    });
    return result;
  };

  const start = (autoplay: boolean): void => {
    const r = compute();
    setRun(r);
    setRetries(0);
    setRevealed(autoplay ? 1 : 0);
    setPlaying(autoplay);
  };

  const step = (): void => {
    if (run === undefined) {
      const r = compute();
      setRun(r);
      setRetries(0);
      setRevealed(1);
      return;
    }
    setPlaying(false);
    setRevealed((n) => Math.min(n + 1, total));
  };

  const showAll = (): void => {
    const r = run ?? compute();
    setRun(r);
    setPlaying(false);
    setRevealed(r.steps.length);
  };

  const reset = (): void => {
    setRun(undefined);
    setRevealed(0);
    setPlaying(false);
    setRetries(0);
  };

  const resetAll = (): void => {
    reset();
    setScenarioId(defaultScenario);
    setMaxAttempts(DEFAULT_TARGET.maxAttempts);
    setSeed(42);
  };

  const doManualRetry = (): void => {
    if (run === undefined) return;
    const retried = manualRetry(
      run.delivery,
      run.delivery.attempts > 0 ? (run.steps.at(-1)?.atMs ?? 0) + 60_000 : 0,
    );
    if (retried === undefined) return;
    const choice = SECOND_RETRY[retryChoice];
    const finished = runToCompletion(
      retried.delivery,
      choice.responseFor,
      { ...target, maxAttempts: effectiveBudget },
      seededRandom(seed + retries + 1),
      retried.delivery.nextAttemptAtMs,
    );
    const steps = [...run.steps, ...retried.steps, ...finished.steps];
    setRun({ delivery: finished.delivery, steps });
    setRetries((n) => n + 1);
    setRevealed(run.steps.length + 1);
    setPlaying(true);
  };

  const visible = run?.steps.slice(0, revealed) ?? [];
  const isDead = done && run?.delivery.status === 'dead';

  return (
    <div className="space-y-4">
      <SimBanner>
        {mode === 'deadletter'
          ? 'Dead-letter walkthrough. The simulator never touches the real dead letter queue.'
          : 'Delivery and retry simulator. Decision rules follow the real worker; timings are virtual and illustrative.'}
      </SimBanner>

      <div className="grid gap-4 lg:grid-cols-[22rem_1fr]">
        <Card title="Scenario">
          <div className="space-y-3">
            <Field label="Scenario" hint={scenario.description}>
              {(id) => (
                <Select
                  id={id}
                  value={scenarioId}
                  onChange={(e) => {
                    setScenarioId(e.target.value);
                    reset();
                  }}
                >
                  {SCENARIOS.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.label}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field
              label="Retry budget (max attempts)"
              hint={
                scenario.maxAttempts !== undefined
                  ? `This scenario fixes the budget at ${scenario.maxAttempts}.`
                  : 'Example config uses 8.'
              }
            >
              {(id) => (
                <Input
                  id={id}
                  type="number"
                  min={1}
                  max={12}
                  value={maxAttempts}
                  disabled={scenario.maxAttempts !== undefined}
                  onChange={(e) => {
                    setMaxAttempts(Math.min(12, Math.max(1, Number(e.target.value) || 1)));
                    reset();
                  }}
                />
              )}
            </Field>
            <Field label="Jitter seed" hint="Same seed, same simulated delays.">
              {(id) => (
                <Input
                  id={id}
                  type="number"
                  value={seed}
                  onChange={(e) => {
                    setSeed(Number(e.target.value) || 0);
                    reset();
                  }}
                />
              )}
            </Field>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="primary"
                onClick={() => {
                  start(true);
                }}
              >
                Run simulation
              </Button>
              <Button onClick={step}>Step</Button>
              <Button
                disabled={!playing}
                onClick={() => {
                  setPlaying(false);
                }}
              >
                Pause
              </Button>
              <Button disabled={run === undefined || done} onClick={showAll}>
                Show all
              </Button>
              <Button onClick={reset}>Reset run</Button>
              <Button variant="ghost" onClick={resetAll}>
                Reset all
              </Button>
            </div>
            <div>
              <h3 className="mb-1 text-xs font-medium text-muted">
                Backoff ceilings (real formula)
              </h3>
              <ul className="space-y-0.5 font-mono text-xs">
                {Array.from({ length: Math.min(effectiveBudget - 1, 8) }, (_, i) => (
                  <li key={i}>
                    after attempt {i + 1}: delay ∈ [0,{' '}
                    {(backoffCeilingMs(i + 1, target.backoff) / 1000).toFixed(0)} s]
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </Card>

        <div className="space-y-4">
          <Card
            title="Lifecycle"
            actions={
              <Badge tone="sim">
                illustrative timing · step {revealed}/{total}
              </Badge>
            }
          >
            {run === undefined ? (
              <p className="text-sm text-muted">Choose a scenario, then run or step through it.</p>
            ) : (
              <Timeline steps={visible} label="Delivery lifecycle timeline" />
            )}
          </Card>

          {done && run !== undefined && (
            <Card
              title="Resulting delivery record (simulated)"
              actions={<Badge tone="sim">SIMULATED</Badge>}
            >
              <DeliveryTable deliveries={[run.delivery]} />
            </Card>
          )}

          {isDead && (
            <Card
              title="Dead-letter record · manual retry"
              actions={<Badge tone="danger">dead</Badge>}
            >
              <div className="space-y-3 text-sm">
                <p>
                  Reason: <span className="font-mono">{run?.delivery.deadReason}</span>. In the real
                  service this delivery would now sit in{' '}
                  <span className="font-mono">GET /api/deliveries/dead</span> until an operator
                  calls <span className="font-mono">POST /api/deliveries/:id/retry</span>, which
                  gives it a fresh retry budget and makes it due immediately. Attempt numbering
                  continues from {run?.delivery.attempts}.
                </p>
                <div className="flex flex-wrap items-end gap-3">
                  <Field label="Next target behaviour">
                    {(id) => (
                      <Select
                        id={id}
                        value={retryChoice}
                        onChange={(e) => {
                          setRetryChoice(e.target.value as keyof typeof SECOND_RETRY);
                        }}
                      >
                        {Object.entries(SECOND_RETRY).map(([k, v]) => (
                          <option key={k} value={k}>
                            {v.label}
                          </option>
                        ))}
                      </Select>
                    )}
                  </Field>
                  <Button variant="primary" onClick={doManualRetry}>
                    Trigger simulated manual retry
                  </Button>
                </div>
                <Notice tone="sim">
                  This changes only the simulation above. Nothing is sent to HookRelay.
                </Notice>
              </div>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
