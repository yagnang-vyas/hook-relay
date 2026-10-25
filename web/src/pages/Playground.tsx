import clsx from 'clsx';
import { useCallback, useState } from 'react';
import { PageHeader } from '../components/ui';
import { DeliveryLab } from '../playground/DeliveryLab';
import { DuplicateLab } from '../playground/DuplicateLab';
import { EventInspector } from '../playground/EventInspector';
import { emptyRegistry, type Registry } from '../playground/registry';
import { RequestSimulator } from '../playground/RequestSimulator';
import { SignatureLab } from '../playground/SignatureLab';

const SIM_EPOCH_MS = Date.UTC(2025, 0, 1);

const TABS = [
  { id: 'request', label: 'Request' },
  { id: 'signature', label: 'Signature lab' },
  { id: 'delivery', label: 'Delivery & retries' },
  { id: 'duplicates', label: 'Duplicates' },
  { id: 'events', label: 'Event inspector' },
  { id: 'dead', label: 'Dead letter' },
] as const;
type TabId = (typeof TABS)[number]['id'];

/**
 * All playground state lives here, in memory. It is deliberately separate from the dashboard's
 * API state: nothing in this tree imports the API client.
 */
export function PlaygroundPage() {
  const [tab, setTab] = useState<TabId>('request');
  const [registry, setRegistry] = useState<Registry>(emptyRegistry);
  const [tick, setTick] = useState(0);
  const clockMs = SIM_EPOCH_MS + tick * 1000;
  const advance = useCallback(() => {
    setTick((t) => t + 1);
  }, []);

  const shared = { registry, onRegistry: setRegistry, clockMs, onAdvance: advance };

  return (
    <>
      <PageHeader
        title="Playground"
        description="Experiment with signatures, retries, duplicates and dead letters in a safe, local simulation. No server, no API key, no real data."
      />
      <div
        role="tablist"
        aria-label="Playground sections"
        className="mb-4 flex flex-wrap gap-1 border-b border-line"
      >
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            id={`tab-${t.id}`}
            aria-selected={tab === t.id}
            aria-controls={`panel-${t.id}`}
            type="button"
            onClick={() => {
              setTab(t.id);
            }}
            className={clsx(
              '-mb-px border-b-2 px-3 py-2 text-sm',
              tab === t.id
                ? 'border-accent font-medium text-fg'
                : 'border-transparent text-muted hover:text-fg',
            )}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
        {tab === 'request' && <RequestSimulator {...shared} />}
        {tab === 'signature' && <SignatureLab />}
        {tab === 'delivery' && <DeliveryLab mode="delivery" />}
        {tab === 'duplicates' && <DuplicateLab {...shared} />}
        {tab === 'events' && <EventInspector {...shared} />}
        {tab === 'dead' && <DeliveryLab mode="deadletter" />}
      </div>
    </>
  );
}
